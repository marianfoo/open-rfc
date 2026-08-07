#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  assertPublicationManifestProfile,
  CONVENTIONAL_LEGAL_PATHS,
} from "./publication_safety.mjs";
import {
  OPEN_RFC_PACKAGED_README_HTTPS_TARGETS,
  PackagedReadmeLinkError,
  assertPackagedReadmeLinks,
} from "./packaged_readme_links.mjs";
import { resolvePinnedNpmToolchain } from "./pinned_npm.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIRECTORY = resolve(TOOL_DIRECTORY, "..");
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const DEFAULT_TERMINATION_FALLBACK_MS = 2_000;
const TAR_BLOCK_BYTES = 512;
const TAR_DECODER = new TextDecoder("utf-8", { fatal: true });

export const COMPATIBILITY_ALIASES = Object.freeze([
  "@sap-rfc/node-rfc-library",
  "node-rfc",
]);

export const REQUIRED_COMPATIBILITY_EXPORTS = Object.freeze([
  "Client",
  "Pool",
  "RFCClient",
  "RFCConnection",
  "RFCUtility",
  "RFCError",
  "NodeRFCLibraryError",
  "RFCUtilityError",
  "NodeRFCLibraryErrorCode",
  "RFCErrorCode",
]);

const REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
  "package/NOTICE",
  "package/README.md",
  "package/package.json",
  "package/dist/cjs/index.d.ts",
  "package/dist/cjs/index.js",
  "package/dist/cjs/package.json",
  "package/dist/src/index.d.ts",
  "package/dist/src/index.js",
]);
const EXPECTED_PACKAGE_FILES = Object.freeze([
  "dist/src",
  "dist/cjs",
  "README.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
]);
const EXPECTED_PACKAGE_ENGINES = Object.freeze({
  node: "^22.14.0 || ^24.0.0",
});
const EXPECTED_PACKAGE_EXPORTS = Object.freeze({
  ".": Object.freeze({
    import: Object.freeze({
      types: "./dist/src/index.d.ts",
      default: "./dist/src/index.js",
    }),
    require: Object.freeze({
      types: "./dist/cjs/index.d.ts",
      default: "./dist/cjs/index.js",
    }),
    default: "./dist/src/index.js",
  }),
  "./package.json": "./package.json",
});
const EXPECTED_AUXILIARY_MANIFESTS = Object.freeze({
  "package/dist/cjs/package.json": Object.freeze({ type: "commonjs" }),
});

const FORBIDDEN_FILE_EXTENSION =
  /\.(?:a|dll|dylib|exe|gz|key|lib|node|p12|pdb|pem|pfx|rar|so(?:\.\d+)*|tar|tgz|zip|7z)$/iu;
const FORBIDDEN_PATH_SEGMENT =
  /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.npmrc|captures?|credentials?|evidence|node_modules|private|sapnwrfc(?:sdk)?|secrets?|tests?)(?:\/|$)/iu;

function fail(message) {
  throw new Error(`packed compatibility: ${message}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function childBaseEnvironment(source = process.env) {
  const environment = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

function normalizedNpmInvocation(value, environment) {
  if (value === undefined) {
    const toolchain = resolvePinnedNpmToolchain({ environment });
    return Object.freeze({
      command: toolchain.command,
      argumentsPrefix: Object.freeze([...toolchain.argumentsPrefix]),
    });
  }
  assert.equal(typeof value.command, "string", "npm invocation command must be a string");
  assert(value.command.length > 0, "npm invocation command must not be empty");
  assert(
    Array.isArray(value.argumentsPrefix) &&
      value.argumentsPrefix.every(argument => typeof argument === "string"),
    "npm invocation prefix must contain only strings",
  );
  return Object.freeze({
    command: value.command,
    argumentsPrefix: Object.freeze([...value.argumentsPrefix]),
  });
}

function assertConditionDeclarationParity(descriptors) {
  const declarations = new Map(
    descriptors
      .filter(({ path }) => /^package\/dist\/(?:cjs|src)\/.+\.d\.ts$/u.test(path))
      .map((descriptor) => [descriptor.path, descriptor]),
  );
  const sourcePrefix = "package/dist/src/";
  const commonJsPrefix = "package/dist/cjs/";
  const sourcePaths = [...declarations.keys()]
    .filter((path) => path.startsWith(sourcePrefix))
    .sort();
  const commonJsPaths = [...declarations.keys()]
    .filter((path) => path.startsWith(commonJsPrefix))
    .sort();

  const expectedCommonJsPaths = sourcePaths.map(
    (path) => `${commonJsPrefix}${path.slice(sourcePrefix.length)}`,
  );
  if (!sameJson(commonJsPaths, expectedCommonJsPaths)) {
    fail("ESM and CommonJS declaration inventories differ");
  }
  for (const sourcePath of sourcePaths) {
    const commonJsPath = `${commonJsPrefix}${sourcePath.slice(sourcePrefix.length)}`;
    const source = declarations.get(sourcePath);
    const commonJs = declarations.get(commonJsPath);
    if (
      source === undefined ||
      commonJs === undefined ||
      source.size !== commonJs.size ||
      source.sha256 !== commonJs.sha256
    ) {
      fail(`ESM and CommonJS declaration bytes differ: ${sourcePath}`);
    }
  }
}

function npmArguments(invocation, arguments_) {
  return [...invocation.argumentsPrefix, ...arguments_];
}

function stableIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    mode: stat.mode,
  };
}

function sameIdentity(stat, identity) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.nlink === identity.nlink &&
    stat.size === identity.size &&
    stat.mtimeNs === identity.mtimeNs &&
    stat.ctimeNs === identity.ctimeNs &&
    stat.mode === identity.mode
  );
}

function sameStableIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

async function readStableArtifact(
  path,
  label = "candidate artifact",
  { rejectHardlinks = false } = {},
) {
  const expectedKind = rejectHardlinks
    ? "stable regular non-symlink non-hardlink file"
    : "stable regular non-symlink file";
  let descriptor;
  try {
    descriptor = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = await descriptor.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (rejectHardlinks && before.nlink !== 1n)
    ) {
      fail(`${label} must be a ${expectedKind}`);
    }
    if (before.size < 1n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
      fail(`${label} exceeds the packed compatibility size envelope`);
    }
    const identity = stableIdentity(before);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      BigInt(bytes.length) !== before.size ||
      !sameIdentity(after, identity) ||
      !sameIdentity(pathAfter, identity)
    ) {
      fail(`${label} changed during its bounded read`);
    }
    return { bytes, identity };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("packed compatibility:")) {
      throw error;
    }
    fail(`${label} must be a ${expectedKind}`);
  } finally {
    if (descriptor !== undefined) {
      try {
        await descriptor.close();
      } catch {
        // The bounded read or identity failure remains authoritative.
      }
    }
  }
}

function hashBytes(bytes, algorithm) {
  return createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
}

function isAllowedArchiveEntry(entry) {
  if (
    entry === "package/README.md" ||
    entry === "package/package.json" ||
    CONVENTIONAL_LEGAL_PATHS.some((path) => entry === `package/${path}`)
  ) {
    return true;
  }
  if (entry === "package/dist/cjs/package.json") return true;
  if (entry.startsWith("package/dist/cjs/")) {
    return entry.endsWith(".js") || entry.endsWith(".d.ts");
  }
  if (entry.startsWith("package/dist/src/")) {
    return entry.endsWith(".js") || entry.endsWith(".d.ts");
  }
  return false;
}

/**
 * Enforce the complete publish allowlist before the artifact reaches a
 * consumer. The policy intentionally checks archive paths, not the source
 * worktree, so ignored captures and local SDK archives cannot be overlooked.
 */
export function assertPackedFilePolicy(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("archive contains no files");
  }

  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0) {
      fail("archive contains an invalid path");
    }
    const pathParts = entry.split("/");
    if (
      entry.includes("\\") ||
      entry.includes("\0") ||
      /[\u0001-\u001f\u007f]/u.test(entry) ||
      entry.startsWith("/") ||
      pathParts.some((part) => part === "" || part === "." || part === "..")
    ) {
      fail(`archive path is unsafe: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry)) fail(`archive path is duplicated: ${entry}`);
    seen.add(entry);

    if (!isAllowedArchiveEntry(entry)) {
      fail(`archive path is outside the publish allowlist: ${entry}`);
    }
    if (FORBIDDEN_PATH_SEGMENT.test(entry) || FORBIDDEN_FILE_EXTENSION.test(entry)) {
      fail(`archive contains an SDK, native, test, evidence, or private path: ${entry}`);
    }
  }

  for (const required of REQUIRED_ARCHIVE_ENTRIES) {
    if (!seen.has(required)) fail(`archive is missing required path: ${required}`);
  }
}

/** Validate npm's logical dependency tree for the expected compatibility aliases. */
export function assertCleanDependencyTree(
  tree,
  version,
  expectedAliases = COMPATIBILITY_ALIASES,
) {
  if (tree?.problems?.length) {
    fail(`npm dependency tree has problems: ${tree.problems.join("; ")}`);
  }
  const dependencies = tree?.dependencies;
  if (!dependencies || typeof dependencies !== "object") {
    fail("npm dependency tree has no dependencies object");
  }
  assert.deepEqual(Object.keys(dependencies).sort(), [...expectedAliases].sort());

  for (const alias of expectedAliases) {
    const dependency = dependencies[alias];
    if (dependency?.version !== version) {
      fail(`${alias} resolved version ${String(dependency?.version)} instead of ${version}`);
    }
    if (dependency.invalid || dependency.missing || dependency.extraneous) {
      fail(`${alias} is not a clean npm dependency`);
    }
    if (dependency.dependencies && Object.keys(dependency.dependencies).length > 0) {
      fail(`${alias} unexpectedly installed transitive dependencies`);
    }
  }
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.on("error", () => {});
      killer.unref();
    }
    try {
      child.kill(signal);
    } catch {
      // The bounded fallback below remains authoritative.
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The bounded fallback below remains authoritative.
      }
    }
  }
}

export async function runBoundedCommand(command, arguments_, options = {}) {
  const {
    cwd = DEFAULT_ROOT_DIRECTORY,
    env = childBaseEnvironment(),
    maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    terminationFallbackMs = DEFAULT_TERMINATION_FALLBACK_MS,
  } = options;
  for (const [name, value] of Object.entries({
    maxOutputBytes,
    timeoutMs,
    terminationGraceMs,
    terminationFallbackMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(`${name} must be a positive safe integer`);
    }
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let terminalError;
    let settled = false;
    let forceTimer;
    let fallbackTimer;

    const processGroupAlive = () => {
      if (process.platform === "win32" || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };
    const waitForProcessGroupExit = async () => {
      const deadline = Date.now() + terminationFallbackMs;
      while (processGroupAlive() && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      return !processGroupAlive();
    };

    const clearTimers = () => {
      clearTimeout(deadlineTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      callback(value);
    };
    const terminate = (error) => {
      if (terminalError !== undefined) return;
      terminalError = error;
      signalProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
      }, terminationGraceMs);
      fallbackTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(rejectPromise, terminalError);
      }, terminationGraceMs + terminationFallbackMs);
    };
    const retain = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes && terminalError === undefined) {
        terminate(
          new Error(`${command} exceeded the bounded child-output envelope`),
        );
        return;
      }
      if (terminalError === undefined) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => retain(stdout, chunk));
    child.stderr.on("data", (chunk) => retain(stderr, chunk));
    const deadlineTimer = setTimeout(() => {
      terminate(new Error(`${command} exceeded its execution deadline`));
    }, timeoutMs);
    child.once("error", (error) => {
      if (terminalError === undefined) terminalError = error;
      settle(rejectPromise, terminalError);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadlineTimer);
      const descendantsRemained = processGroupAlive();
      if (descendantsRemained && terminalError === undefined) {
        terminalError = new Error(`${command} left descendant processes running`);
        signalProcessTree(child, "SIGKILL");
      }
      void (async () => {
        if (descendantsRemained && !(await waitForProcessGroupExit())) {
          terminalError = new Error(`${command} process tree did not terminate`);
        }
        if (terminalError !== undefined) {
          settle(rejectPromise, terminalError);
          return;
        }
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (code === 0) {
          settle(resolvePromise, result);
          return;
        }
        const detail = result.stderr.trim() || result.stdout.trim() || "no output";
        settle(
          rejectPromise,
          new Error(
            `${command} ${arguments_.join(" ")} failed (${signal ?? code}):\n${detail}`,
          ),
        );
      })();
    });
  });
}

async function listFiles(rootDirectory, relativeDirectory = "") {
  const directory = join(rootDirectory, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDirectory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      fail(`installed package contains a non-file entry: ${relativePath}`);
    }
  }
  return files;
}

function boundedArchiveLimit(value, maximum, label) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function isAllZero(bytes, start = 0, end = bytes.length) {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function decodeTarText(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const terminator = field.indexOf(0);
  const contentEnd = terminator === -1 ? field.length : terminator;
  if (terminator !== -1 && !isAllZero(field, terminator)) {
    fail(`archive ${label} has data after its NUL terminator`);
  }
  try {
    return TAR_DECODER.decode(field.subarray(0, contentEnd));
  } catch {
    fail(`archive ${label} is not valid UTF-8`);
  }
}

function parseTarOctal(header, start, length, label) {
  const field = header.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    fail(`archive ${label} uses an unsupported base-256 number`);
  }
  let firstDigit = -1;
  let lastDigit = -1;
  for (let index = 0; index < field.length; index += 1) {
    const byte = field[index];
    if (byte >= 0x30 && byte <= 0x37) {
      if (firstDigit === -1) firstDigit = index;
      lastDigit = index;
    } else if (byte !== 0 && byte !== 0x20) {
      fail(`archive ${label} is not a strict octal number`);
    }
  }
  if (firstDigit === -1) return 0;
  for (let index = firstDigit; index <= lastDigit; index += 1) {
    if (field[index] < 0x30 || field[index] > 0x37) {
      fail(`archive ${label} has embedded octal padding`);
    }
  }
  const value = Number.parseInt(
    Buffer.from(field.subarray(firstDigit, lastDigit + 1)).toString("ascii"),
    8,
  );
  if (!Number.isSafeInteger(value)) {
    fail(`archive ${label} exceeds the safe integer envelope`);
  }
  return value;
}

function assertTarHeaderChecksum(header) {
  const declared = parseTarOctal(header, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (declared !== actual) {
    fail(`archive header checksum mismatch: declared ${declared}, actual ${actual}`);
  }
}

function assertUstarHeader(header) {
  const magic = header.subarray(257, 263);
  const version = header.subarray(263, 265);
  if (!magic.equals(Buffer.from("ustar\0", "ascii")) ||
      !version.equals(Buffer.from("00", "ascii"))) {
    fail("archive entry is not a strict POSIX ustar header");
  }
}

/**
 * Parse and validate the exact immutable gzip/tar bytes before npm sees them.
 * Only strict POSIX ustar regular files are accepted; archive extensions,
 * links, directories, devices, sparse files, and metadata records are denied.
 */
export function inspectPackedArchive(artifactBytes, options = {}) {
  if (!Buffer.isBuffer(artifactBytes) && !(artifactBytes instanceof Uint8Array)) {
    fail("candidate artifact bytes must be a byte array");
  }
  if (artifactBytes.byteLength < 1 || artifactBytes.byteLength > MAX_ARTIFACT_BYTES) {
    fail("candidate artifact exceeds the packed compatibility size envelope");
  }
  const maxUnpackedBytes = boundedArchiveLimit(
    options.maxUnpackedBytes,
    MAX_UNPACKED_ARCHIVE_BYTES,
    "maxUnpackedBytes",
  );
  const maxEntryBytes = boundedArchiveLimit(
    options.maxEntryBytes,
    Math.min(MAX_ARCHIVE_ENTRY_BYTES, maxUnpackedBytes),
    "maxEntryBytes",
  );
  const maxEntries = boundedArchiveLimit(
    options.maxEntries,
    MAX_ARCHIVE_ENTRIES,
    "maxEntries",
  );

  const compressedSnapshot = Buffer.from(artifactBytes);
  let unpacked;
  try {
    unpacked = gunzipSync(compressedSnapshot, {
      maxOutputLength: maxUnpackedBytes,
    });
  } catch {
    fail("candidate is not one bounded, valid gzip-compressed tar archive");
  }
  if (
    unpacked.length < TAR_BLOCK_BYTES * 2 ||
    unpacked.length % TAR_BLOCK_BYTES !== 0
  ) {
    fail("archive length or end padding is malformed");
  }

  const descriptors = [];
  const seenPaths = new Set();
  const manifestBytes = new Map();
  let readmeBytes;
  let offset = 0;
  let terminated = false;
  let totalFileBytes = 0;
  while (offset < unpacked.length) {
    const header = unpacked.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isAllZero(header)) {
      const secondEnd = offset + TAR_BLOCK_BYTES;
      if (
        secondEnd + TAR_BLOCK_BYTES > unpacked.length ||
        !isAllZero(unpacked, secondEnd, secondEnd + TAR_BLOCK_BYTES) ||
        !isAllZero(unpacked, secondEnd + TAR_BLOCK_BYTES)
      ) {
        fail("archive has a malformed or non-zero end marker");
      }
      terminated = true;
      break;
    }

    if (descriptors.length >= maxEntries) {
      fail("archive exceeds the bounded file-count envelope");
    }
    assertTarHeaderChecksum(header);
    assertUstarHeader(header);
    const name = decodeTarText(header, 0, 100, "name");
    const prefix = decodeTarText(header, 345, 155, "prefix");
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    if (path.length === 0) fail("archive contains an empty path");
    if (seenPaths.has(path)) fail(`archive path is duplicated: ${path}`);
    seenPaths.add(path);

    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      fail(`archive contains non-regular entry type ${JSON.stringify(String.fromCharCode(type))}: ${path}`);
    }
    if (decodeTarText(header, 157, 100, "link name") !== "") {
      fail(`archive regular entry unexpectedly has a link target: ${path}`);
    }
    const mode = parseTarOctal(header, 100, 8, "mode");
    parseTarOctal(header, 108, 8, "uid");
    parseTarOctal(header, 116, 8, "gid");
    const size = parseTarOctal(header, 124, 12, "size");
    parseTarOctal(header, 136, 12, "mtime");
    parseTarOctal(header, 329, 8, "device major");
    parseTarOctal(header, 337, 8, "device minor");
    decodeTarText(header, 265, 32, "owner name");
    decodeTarText(header, 297, 32, "group name");

    if (size > maxEntryBytes) {
      fail(`archive entry exceeds the bounded size envelope: ${path}`);
    }
    totalFileBytes += size;
    if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > maxUnpackedBytes) {
      fail("archive file data exceeds the aggregate size envelope");
    }
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (dataEnd > unpacked.length || nextOffset > unpacked.length) {
      fail(`archive entry is truncated: ${path}`);
    }
    if (!isAllZero(unpacked, dataEnd, nextOffset)) {
      fail(`archive entry has non-zero padding: ${path}`);
    }
    const data = unpacked.subarray(dataStart, dataEnd);
    if (path === "package/README.md") readmeBytes = Buffer.from(data);
    if (
      path === "package/package.json" ||
      Object.hasOwn(EXPECTED_AUXILIARY_MANIFESTS, path)
    ) {
      manifestBytes.set(path, Buffer.from(data));
    }
    descriptors.push(Object.freeze({
      mode,
      path,
      sha256: hashBytes(data, "sha256"),
      size,
      type: "file",
    }));
    offset = nextOffset;
  }
  if (!terminated) fail("archive is missing its two-block end marker");

  const paths = descriptors.map(({ path }) => path).sort();
  assertPackedFilePolicy(paths);
  assertConditionDeclarationParity(descriptors);
  if (options.packFiles !== undefined) {
    if (!Array.isArray(options.packFiles)) {
      fail("npm pack file report must be an array");
    }
    const reported = options.packFiles.map((entry) => {
      if (
        typeof entry?.path !== "string" ||
        !Number.isSafeInteger(entry?.size) ||
        entry.size < 0 ||
        !Number.isSafeInteger(entry?.mode) ||
        entry.mode < 0
      ) {
        fail("npm pack file report contains an invalid descriptor");
      }
      return { mode: entry.mode, path: `package/${entry.path}`, size: entry.size };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const actual = descriptors.map(({ mode, path, size }) => ({ mode, path, size }))
      .sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(
      actual,
      reported,
      "archive path/type/size/mode must exactly match npm pack's file report",
    );
  }
  if (!manifestBytes.has("package/package.json")) {
    fail("archive is missing its package manifest bytes");
  }
  try {
    assertPackagedReadmeLinks([
      { path: "package/README.md", bytes: readmeBytes },
    ], {
      approvedHttpsTargets: OPEN_RFC_PACKAGED_README_HTTPS_TARGETS,
    });
  } catch (error) {
    if (error instanceof PackagedReadmeLinkError) fail(error.message);
    throw error;
  }
  const parseManifest = (path, label) => {
    const bytes = manifestBytes.get(path);
    if (bytes === undefined) fail(`archive is missing its ${label}`);
    let manifest;
    try {
      manifest = JSON.parse(TAR_DECODER.decode(bytes));
    } catch {
      fail(`candidate contains an invalid UTF-8 JSON ${label}`);
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      fail(`${label} must be an object`);
    }
    return manifest;
  };
  const packageManifest = parseManifest("package/package.json", "package manifest");
  for (const [path, expected] of Object.entries(EXPECTED_AUXILIARY_MANIFESTS)) {
    const label = path.slice("package/".length);
    if (!sameJson(parseManifest(path, label), expected)) {
      fail(`${label} changed`);
    }
  }
  return Object.freeze({
    descriptors: Object.freeze(descriptors),
    packageManifest: Object.freeze(packageManifest),
    paths: Object.freeze(paths),
    unpackedBytes: unpacked.length,
  });
}

async function resolveSuppliedArtifact(options, workDirectory) {
  if (options.artifactPath !== undefined && options.artifactDirectory !== undefined) {
    fail("artifactPath and artifactDirectory are mutually exclusive");
  }
  let path;
  if (options.artifactPath !== undefined) {
    path = resolve(options.artifactPath);
  } else if (options.artifactDirectory !== undefined) {
    const directory = resolve(options.artifactDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      fail("artifact directory may contain only regular non-symlink files");
    }
    const resultPath = join(directory, "release-artifact-gate.v1.json");
    if (entries.some((entry) => entry.name === "release-artifact-gate.v1.json")) {
      const resultSnapshot = await readStableArtifact(
        resultPath,
        "candidate gate result",
      );
      let result;
      try {
        result = JSON.parse(resultSnapshot.bytes.toString("utf8"));
      } catch {
        fail("candidate gate result is not valid JSON");
      }
      const filename = result?.artifact?.filename;
      if (
        result?.schemaVersion !== 1 ||
        result?.status !== "passed" ||
        typeof filename !== "string" ||
        basename(filename) !== filename ||
        !filename.endsWith(".tgz") ||
        !/^[a-f0-9]{64}$/u.test(result?.artifact?.sha256 ?? "")
      ) {
        fail("candidate gate result does not select a bounded connector artifact");
      }
      path = join(directory, filename);
      const selected = await readStableArtifact(path, "selected candidate connector");
      if (hashBytes(selected.bytes, "sha256") !== result.artifact.sha256) {
        fail("selected candidate connector differs from the gate result");
      }
    } else {
      const candidates = entries.filter((entry) => entry.name.endsWith(".tgz"));
      if (candidates.length !== 1) {
        fail("multi-artifact directories require a candidate gate result selector");
      }
      path = join(directory, candidates[0].name);
    }
  } else {
    return undefined;
  }
  const source = await readStableArtifact(path, "supplied candidate");
  const snapshotDirectory = join(workDirectory, "supplied-artifact");
  await mkdir(snapshotDirectory, { mode: 0o700 });
  const snapshotPath = join(snapshotDirectory, basename(path));
  await writeFile(snapshotPath, source.bytes, { flag: "wx", mode: 0o600 });
  const snapshot = await readStableArtifact(snapshotPath, "supplied candidate snapshot");
  if (!snapshot.bytes.equals(source.bytes)) {
    fail("supplied candidate snapshot differs from its bounded source read");
  }
  return snapshotPath;
}

function environmentCandidateBinding(environment, options) {
  const path = environment.OPEN_RFC_CANDIDATE_TARBALL;
  const digest = environment.OPEN_RFC_CANDIDATE_TARBALL_SHA256;
  if (path === undefined && digest === undefined) return undefined;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof digest !== "string" ||
    digest.length === 0
  ) {
    fail("candidate tarball path and SHA-256 must be provided together");
  }
  if (options.artifactPath !== undefined || options.artifactDirectory !== undefined) {
    fail("environment candidate and artifact options are mutually exclusive");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    fail("candidate tarball SHA-256 must be sha256:<64 lowercase hex>");
  }
  return Object.freeze({
    path: resolve(path),
    sha256: digest.slice("sha256:".length),
  });
}

async function resolveEnvironmentCandidate(binding, workDirectory) {
  if (binding === undefined) return undefined;
  const source = await readStableArtifact(
    binding.path,
    "environment candidate tarball",
    { rejectHardlinks: true },
  );
  if (hashBytes(source.bytes, "sha256") !== binding.sha256) {
    fail("candidate tarball SHA-256 differs from its environment binding");
  }
  const snapshotDirectory = join(workDirectory, "environment-candidate");
  await mkdir(snapshotDirectory, { mode: 0o700 });
  const snapshotPath = join(snapshotDirectory, basename(binding.path));
  await writeFile(snapshotPath, source.bytes, { flag: "wx", mode: 0o600 });
  const snapshot = await readStableArtifact(
    snapshotPath,
    "environment candidate snapshot",
    { rejectHardlinks: true },
  );
  if (
    (snapshot.identity.mode & 0o777n) !== 0o600n ||
    hashBytes(snapshot.bytes, "sha256") !== binding.sha256 ||
    !snapshot.bytes.equals(source.bytes)
  ) {
    fail("environment candidate snapshot differs from its bound source");
  }
  return Object.freeze({
    expectedBytes: Buffer.from(source.bytes),
    expectedSha256: binding.sha256,
    snapshotIdentity: snapshot.identity,
    snapshotPath,
    sourceIdentity: source.identity,
    sourcePath: binding.path,
  });
}

async function assertEnvironmentCandidateUnchanged(candidate) {
  if (candidate === undefined) return;
  const [source, snapshot] = await Promise.all([
    readStableArtifact(
      candidate.sourcePath,
      "environment candidate tarball",
      { rejectHardlinks: true },
    ),
    readStableArtifact(
      candidate.snapshotPath,
      "environment candidate snapshot",
      { rejectHardlinks: true },
    ),
  ]);
  if (
    !sameStableIdentity(source.identity, candidate.sourceIdentity) ||
    !sameStableIdentity(snapshot.identity, candidate.snapshotIdentity) ||
    (snapshot.identity.mode & 0o777n) !== 0o600n ||
    hashBytes(source.bytes, "sha256") !== candidate.expectedSha256 ||
    hashBytes(snapshot.bytes, "sha256") !== candidate.expectedSha256 ||
    !source.bytes.equals(candidate.expectedBytes) ||
    !snapshot.bytes.equals(candidate.expectedBytes)
  ) {
    fail("environment candidate source or private snapshot changed during verification");
  }
}

async function cleanupPackedCompatibilityDirectory(path) {
  let failed = false;
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    failed = true;
  }
  try {
    await lstat(path);
    failed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") failed = true;
  }
  if (failed) fail("packed compatibility workspace cleanup failed");
}

export function assertPackedManifest(
  manifest,
  expectedName,
  expectedVersion,
  publicationMode = "private",
) {
  try {
    assertPublicationManifestProfile(manifest, {
      mode: publicationMode,
      label: "packed package manifest",
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "packed manifest profile is invalid");
  }
  if (
    manifest.name !== expectedName ||
    manifest.version !== expectedVersion ||
    manifest.type !== "module" ||
    manifest.main !== "./dist/cjs/index.js" ||
    manifest.module !== "./dist/src/index.js" ||
    manifest.types !== "./dist/src/index.d.ts" ||
    manifest.sideEffects !== false ||
    !sameJson(manifest.exports, EXPECTED_PACKAGE_EXPORTS) ||
    !sameJson(manifest.files, EXPECTED_PACKAGE_FILES) ||
    !sameJson(manifest.engines, EXPECTED_PACKAGE_ENGINES)
  ) {
    fail("packed package manifest contract changed");
  }

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const value = manifest[field];
    if (
      value !== undefined &&
      (
        value === null ||
        (Array.isArray(value)
          ? value.length > 0
          : typeof value !== "object" || Object.keys(value).length > 0)
      )
    ) {
      fail(`packed package unexpectedly has runtime field ${field}`);
    }
  }
  for (const name of ["install", "postinstall", "preinstall"]) {
    if (manifest.scripts?.[name] !== undefined) {
      fail("packed package contains an install lifecycle hook");
    }
  }
  if (manifest.gypfile === true || manifest.binary !== undefined) {
    fail("packed package declares a native binary");
  }
}

async function startLocalRegistry({
  tarballFilename,
  tarballBytes,
  packageManifest,
  integrity,
  shasum,
}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "GET", pathname: url.pathname });
    const base = `http://127.0.0.1:${server.address().port}`;
    const tarballPathname = `/open-rfc/-/${tarballFilename}`;

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/open-rfc") {
      const versionManifest = {
        ...packageManifest,
        dist: {
          integrity,
          shasum,
          tarball: `${base}${tarballPathname}`,
        },
      };
      const body = Buffer.from(
        JSON.stringify({
          _id: packageManifest.name,
          name: packageManifest.name,
          "dist-tags": { latest: packageManifest.version },
          versions: { [packageManifest.version]: versionManifest },
        }),
      );
      response.writeHead(200, {
        "content-length": body.length,
        "content-type": "application/json",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === tarballPathname
    ) {
      response.writeHead(200, {
        "content-length": tarballBytes.length,
        "content-type": "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : tarballBytes);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    requests,
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };
}

async function writeRuntimeNetworkGuard(path) {
  const source = `
'use strict'
const disabled = () => { throw new Error('NETWORK_OR_CHILD_PROCESS_DISABLED_BY_PACKED_COMPATIBILITY') }
globalThis.fetch = async () => disabled()
globalThis.WebSocket = class { constructor () { disabled() } }
globalThis.EventSource = class { constructor () { disabled() } }
const net = require('node:net')
net.connect = disabled
net.createConnection = disabled
net.Socket.prototype.connect = disabled
const tls = require('node:tls')
tls.connect = disabled
for (const name of ['node:http', 'node:https']) {
  const module = require(name)
  module.request = disabled
  module.get = disabled
}
require('node:http2').connect = disabled
const dns = require('node:dns')
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[name] = disabled
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns.promises[name] = disabled
require('node:dgram').createSocket = disabled
const child = require('node:child_process')
for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  child[name] = disabled
}
require('node:cluster').fork = disabled
require('node:worker_threads').Worker = disabled
`;
  await writeFile(path, source, { flag: "wx", mode: 0o600 });
}

function runtimeCheckSource(kind, alias, expectedExports) {
  const load =
    kind === "esm"
      ? `const loaded = await import(${JSON.stringify(alias)});`
      : `const loaded = require(${JSON.stringify(alias)});`;
  return `
${kind === "esm" ? 'import assert from "node:assert/strict";' : 'const assert = require("node:assert/strict");'}
${load}
const expected = ${JSON.stringify(expectedExports)};
const alias = ${JSON.stringify(alias)};
assert.deepEqual(Object.keys(loaded).sort(), expected, alias + " public export list");
for (const name of ${JSON.stringify(REQUIRED_COMPATIBILITY_EXPORTS)}) {
  assert.notEqual(loaded[name], undefined, alias + " missing " + name);
}
for (const name of ["Client", "Pool", "RFCClient", "RFCConnection", "RFCUtility", "RFCError", "NodeRFCLibraryError", "RFCUtilityError"]) {
  assert.equal(typeof loaded[name], "function", alias + " export " + name);
}
for (const name of ["NodeRFCLibraryErrorCode", "RFCErrorCode"]) {
  assert.equal(typeof loaded[name], "object", alias + " export " + name);
}
process.stdout.write(JSON.stringify({
  alias,
  kind: ${JSON.stringify(kind)},
  exportCount: expected.length,
}));
`;
}

function typeConsumerSource(alias) {
  return `
import {
  Client,
  Pool,
  RFCClient,
  RFCConnection,
  RFCUtility,
  NodeRFCLibraryErrorCode,
  type ModernRfcMetadata,
  type RFCInputParams,
  type RFCLogger,
  type RfcConnectionParameters,
  type RfcObject,
  type RfcPoolConfiguration,
  type RfcPoolResourceOptions,
  type RfcPoolStatus,
} from ${JSON.stringify(alias)};
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

const parameters = {
  ashost: "127.0.0.1",
  sysnr: "00",
  client: "000",
  user: "TYPE_ONLY",
  passwd: "TYPE_ONLY",
} satisfies RfcConnectionParameters;
const logger = ({ log(_type: string, ..._arguments: readonly unknown[]): void {} }) satisfies RFCLogger;
const client: Client = new Client(parameters);
const resourceOptions = {
  maxConnections: 4,
  maxWaiters: 8,
  acquireTimeoutMs: 30_000,
  lifecycleTimeoutMs: 45_000,
  shutdownTimeoutMs: 60_000,
  validateOnCheckout: true,
} satisfies RfcPoolResourceOptions;
const poolConfiguration = {
  connectionParameters: parameters,
  poolOptions: { low: 0, high: 4 },
  resourceOptions,
} satisfies RfcPoolConfiguration;
const pool: Pool = new Pool(poolConfiguration);
const modern: RFCClient = new RFCClient(logger);
const open: Promise<RFCConnection> = modern.open(parameters);
const input: RFCInputParams = { import: { REQUTEXT: "TYPE_ONLY" } };
const object: RfcObject = input.import ?? {};
const convertedType: string = RFCUtility.convertAbapTypeToJavaScriptType("p");
const code: NodeRFCLibraryErrorCode = NodeRFCLibraryErrorCode.INVALID_PARAMETER;

declare const connection: RFCConnection;
const modernExecute: Promise<RfcObject> = connection.execute(
  "STFC_CONNECTION",
  input,
  true,
  ["RESPTEXT"],
);
const modernMetadata: Promise<ModernRfcMetadata> = connection.getMetadata(
  "STFC_CONNECTION",
);
const modernCommit: Promise<void> = connection.commit();
const modernRollback: Promise<void> = connection.rollback();
const modernClose: Promise<void> = connection.close();
const modernAlive: boolean = connection.alive;
const modernConnectionInfo: Readonly<Record<string, string>> | Error =
  connection.connectionInfo;

declare const leasedClient: Client;
declare const leasedClients: readonly Client[];
const poolReady: Promise<void> | void = pool.ready(1);
const poolAcquireOne: Promise<Client | Client[]> | void = pool.acquire();
const poolAcquireMany: Promise<Client | Client[]> | void = pool.acquire(2);
const poolReleaseOne: Promise<void> | void = pool.release(leasedClient);
const poolReleaseMany: Promise<void> | void = pool.release(leasedClients);
const poolCancel: Promise<void> | void = pool.cancel(leasedClient);
const poolCloseAll: Promise<void> | void = pool.closeAll();
const poolStatus: RfcPoolStatus = pool.status;
const poolMonitor: ReturnType<Pool["monitor"]> = pool.monitor();
pool.ready((_error: unknown): void => {}, 1);
pool.acquire(
  (_error: unknown, result?: Client | Client[]): void => {
    const returned: Client | Client[] | undefined = result;
    void returned;
  },
  2,
);
pool.release(leasedClient, (_error: unknown): void => {});
pool.cancel(leasedClient, (_error: unknown): void => {});
pool.closeAll((_error: unknown): void => {});

type PoolAcquirePromise = Expect<Equal<
  Exclude<ReturnType<Pool["acquire"]>, void>,
  Promise<Client | Client[]>
>>;
type PoolAcquireValue = Expect<Equal<
  Awaited<Exclude<ReturnType<Pool["acquire"]>, void>>,
  Client | Client[]
>>;

void [
  client,
  pool,
  open,
  object,
  convertedType,
  code,
  modernExecute,
  modernMetadata,
  modernCommit,
  modernRollback,
  modernClose,
  modernAlive,
  modernConnectionInfo,
  poolReady,
  poolAcquireOne,
  poolAcquireMany,
  poolReleaseOne,
  poolReleaseMany,
  poolCancel,
  poolCloseAll,
  poolStatus,
  poolMonitor,
];
void (undefined as unknown as PoolAcquirePromise);
void (undefined as unknown as PoolAcquireValue);
`;
}

function assertTypeScriptDeclarationResolution(result, expectedPath, label) {
  const trace = `${result.stdout}\n${result.stderr}`.replaceAll("\\", "/");
  const normalizedExpectedPath = expectedPath.replaceAll("\\", "/");
  assert(
    trace.includes(normalizedExpectedPath),
    `${label} did not resolve the condition-specific declaration ${normalizedExpectedPath}`,
  );
}

async function assertInstalledPackage(
  packageDirectory,
  expectedArchiveEntries,
  expectedManifest,
  publicationMode,
) {
  const packageStat = await lstat(packageDirectory);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    fail(`alias did not install as a real package directory: ${packageDirectory}`);
  }
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assertPackedManifest(
    manifest,
    expectedManifest.name,
    expectedManifest.version,
    publicationMode,
  );

  const installedFiles = (await listFiles(packageDirectory)).sort();
  const expectedFiles = expectedArchiveEntries
    .map((entry) => entry.slice("package/".length))
    .sort();
  assert.deepEqual(
    installedFiles,
    expectedFiles,
    "installed alias contents must exactly match the packed archive",
  );
}

async function assertSingleInstalledPackageCopy(nodeModulesDirectory, alias, packageName) {
  const manifestPaths = (await listFiles(nodeModulesDirectory)).filter((path) =>
    path.endsWith("/package.json"),
  );
  const packageManifests = [];
  for (const path of manifestPaths) {
    const manifest = JSON.parse(await readFile(join(nodeModulesDirectory, path), "utf8"));
    if (manifest.name === packageName) packageManifests.push(path);
  }
  assert.deepEqual(
    packageManifests,
    [`${alias}/package.json`],
    `${alias} consumer must contain exactly one installed package copy`,
  );
  const installedManifest = JSON.parse(
    await readFile(join(nodeModulesDirectory, ...alias.split("/"), "package.json"), "utf8"),
  );
  assert.equal(installedManifest.name, packageName);
}

async function createAndVerifyConsumer({
  alias,
  workDirectory,
  registry,
  packageManifest,
  archiveEntries,
  integrity,
  expectedExports,
  rootDirectory,
  environment,
  guard,
  home,
  npmInvocation,
  publicationMode,
}) {
  const consumerId = alias.replaceAll(/[^a-z0-9]+/giu, "-").replaceAll(/^-|-$/gu, "");
  const consumerDirectory = join(workDirectory, `consumer-${consumerId}`);
  const cacheDirectory = join(workDirectory, `npm-cache-${consumerId}`);
  await mkdir(consumerDirectory, { recursive: true });
  await mkdir(cacheDirectory, { recursive: true });
  const emptyNpmrc = join(consumerDirectory, ".isolated.npmrc");
  await writeFile(emptyNpmrc, "", { mode: 0o600 });

  const aliasSpecification = `npm:${packageManifest.name}@${packageManifest.version}`;
  const consumerManifest = {
    name: `open-rfc-packed-compatibility-${consumerId}`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { [alias]: aliasSpecification },
  };
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(consumerManifest, undefined, 2)}\n`,
  );

  const npmEnvironment = {
    ...childBaseEnvironment(environment),
    HOME: home,
    USERPROFILE: home,
    ALL_PROXY: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    NO_PROXY: "127.0.0.1,localhost",
    npm_config_audit: "false",
    npm_config_cache: cacheDirectory,
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_registry: registry.url,
    npm_config_update_notifier: "false",
    npm_config_userconfig: emptyNpmrc,
  };
  await runBoundedCommand(
    npmInvocation.command,
    npmArguments(npmInvocation, [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
    ]),
    { cwd: consumerDirectory, env: npmEnvironment },
  );

  const packageLock = JSON.parse(
    await readFile(join(consumerDirectory, "package-lock.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(packageLock.packages ?? {}).sort(),
    ["", `node_modules/${alias}`].sort(),
    `${alias} lockfile must describe exactly one installed package`,
  );
  const lockEntry = packageLock.packages?.[`node_modules/${alias}`];
  assert.equal(lockEntry?.integrity, integrity, `${alias} lockfile integrity`);
  assert.equal(lockEntry?.version, packageManifest.version, `${alias} lockfile version`);
  assert.match(lockEntry?.resolved ?? "", /\/open-rfc\/-\/open-rfc-[^/]+\.tgz$/u);

  // Exercise the release installation path from the generated immutable lock.
  await rm(join(consumerDirectory, "node_modules"), { recursive: true, force: true });
  await runBoundedCommand(
    npmInvocation.command,
    npmArguments(npmInvocation, [
      "ci", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund",
    ]),
    { cwd: consumerDirectory, env: npmEnvironment },
  );

  const { stdout: treeJson } = await runBoundedCommand(
    npmInvocation.command,
    npmArguments(npmInvocation, ["ls", "--all", "--json"]),
    {
      cwd: consumerDirectory,
      env: npmEnvironment,
    },
  );
  const tree = JSON.parse(treeJson);
  assertCleanDependencyTree(tree, packageManifest.version, [alias]);

  const nodeModulesDirectory = join(consumerDirectory, "node_modules");
  const packageDirectory = join(nodeModulesDirectory, ...alias.split("/"));
  await assertInstalledPackage(
    packageDirectory,
    archiveEntries,
    packageManifest,
    publicationMode,
  );
  await assertSingleInstalledPackageCopy(
    nodeModulesDirectory,
    alias,
    packageManifest.name,
  );

  await writeFile(
    join(consumerDirectory, "esm-check.mjs"),
    runtimeCheckSource("esm", alias, expectedExports),
  );
  await writeFile(
    join(consumerDirectory, "cjs-check.cjs"),
    runtimeCheckSource("cjs", alias, expectedExports),
  );
  const runtimeEnvironment = {
    ...childBaseEnvironment(environment),
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: "test",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    NODE_OPTIONS: `--require=${guard}`,
  };
  const typeRoots = join(rootDirectory, "node_modules", "@types");
  const typeScriptCli = join(rootDirectory, "node_modules", "typescript", "bin", "tsc");
  await stat(typeScriptCli);
  await stat(join(typeRoots, "node"));
  const typeCompilerOptions = {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: "ES2022",
    typeRoots: [typeRoots],
    types: ["node"],
  };
  const typeEnvironment = {
    ...childBaseEnvironment(environment),
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: "test",
  };
  for (const typeMode of [
    {
      config: "tsconfig.esm.json",
      declarations: [
        join(packageDirectory, "dist", "src", "index.d.ts"),
      ],
      label: `${alias} ESM TypeScript consumer`,
      source: "type-consumer.ts",
    },
    {
      config: "tsconfig.cjs.json",
      declarations: [
        join(packageDirectory, "dist", "cjs", "index.d.ts"),
      ],
      label: `${alias} CommonJS TypeScript consumer`,
      source: "type-consumer.cts",
    },
  ]) {
    await writeFile(
      join(consumerDirectory, typeMode.source),
      typeConsumerSource(alias),
    );
    await writeFile(
      join(consumerDirectory, typeMode.config),
      `${JSON.stringify({
        compilerOptions: typeCompilerOptions,
        files: [typeMode.source],
      }, undefined, 2)}\n`,
    );
    const resolution = await runBoundedCommand(
      process.execPath,
      [typeScriptCli, "-p", typeMode.config, "--traceResolution"],
      { cwd: consumerDirectory, env: typeEnvironment },
    );
    for (const declaration of typeMode.declarations) {
      assertTypeScriptDeclarationResolution(resolution, declaration, typeMode.label);
    }
  }

  const esmResult = JSON.parse(
    (await runBoundedCommand(process.execPath, ["esm-check.mjs"], {
      cwd: consumerDirectory,
      env: runtimeEnvironment,
    })).stdout,
  );
  const cjsResult = JSON.parse(
    (await runBoundedCommand(process.execPath, ["cjs-check.cjs"], {
      cwd: consumerDirectory,
      env: runtimeEnvironment,
    })).stdout,
  );
  assert.equal(esmResult.exportCount, expectedExports.length);
  assert.equal(cjsResult.exportCount, expectedExports.length);
  return {
    alias,
    cjs: true,
    dependencyCount: 1,
    esm: true,
    npmCiOmitOptional: true,
    packageCopies: 1,
    subpaths: false,
    typescript: true,
  };
}

/**
 * Qualify one exact artifact through both compatibility aliases. By default the
 * artifact is built and packed locally; release CI supplies the one candidate
 * produced by its upstream artifact job instead. No external registry or SAP
 * system is contacted.
 */
export async function runPackedCompatibility(options = {}) {
  const rootDirectory = resolve(options.rootDirectory ?? DEFAULT_ROOT_DIRECTORY);
  const baseDirectory = resolve(options.baseDirectory ?? tmpdir());
  const keep = options.keep === true;
  const skipBuild = options.skipBuild === true;
  const environment = options.environment ?? process.env;
  const requestedPublicationMode = options.publicationMode ?? "private";
  const environmentBinding = environmentCandidateBinding(environment, options);
  const sourcePublicationMode = environmentBinding === undefined
    ? requestedPublicationMode
    : "private";
  const artifactPublicationMode = environmentBinding === undefined
    ? requestedPublicationMode
    : "public-license-preflight";
  const npmInvocation = normalizedNpmInvocation(
    options.npmInvocation,
    environment,
  );
  await mkdir(baseDirectory, { recursive: true });
  const workDirectory = await mkdtemp(
    join(baseDirectory, "open-rfc-packed-compat-"),
  );
  let environmentCandidate;
  let registry;
  let succeeded = false;

  try {
    const childHome = join(workDirectory, "home");
    await mkdir(childHome, { mode: 0o700 });
    const guard = join(workDirectory, "runtime-network-guard.cjs");
    await writeRuntimeNetworkGuard(guard);
    const childEnvironment = {
      ...childBaseEnvironment(environment),
      HOME: childHome,
      USERPROFILE: childHome,
      ALL_PROXY: "",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    };
    const packageManifest = JSON.parse(
      await readFile(join(rootDirectory, "package.json"), "utf8"),
    );
    try {
      assertPublicationManifestProfile(packageManifest, {
        mode: sourcePublicationMode,
        label: "source package manifest",
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "source manifest profile is invalid");
    }
    const exportManifest = JSON.parse(
      await readFile(
        join(rootDirectory, "conformance", "api", "root-exports.v1.json"),
        "utf8",
      ),
    );
    const expectedExports = exportManifest.exports
      .map(({ name }) => name)
      .sort();
    assert.equal(expectedExports.length, exportManifest.expectedExportCount);

    environmentCandidate = await resolveEnvironmentCandidate(
      environmentBinding,
      workDirectory,
    );
    const suppliedArtifact = environmentCandidate?.snapshotPath ??
      await resolveSuppliedArtifact(options, workDirectory);
    if (!skipBuild && suppliedArtifact === undefined) {
      await runBoundedCommand(
        npmInvocation.command,
        npmArguments(npmInvocation, ["run", "build", "--silent"]),
        {
        cwd: rootDirectory,
        env: childEnvironment,
        },
      );
    }

    let packReport;
    let tarballPath = suppliedArtifact;
    if (tarballPath === undefined) {
      const artifactDirectory = join(workDirectory, "artifact");
      await mkdir(artifactDirectory);
      const { stdout: packOutput } = await runBoundedCommand(
        npmInvocation.command,
        npmArguments(npmInvocation, [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          artifactDirectory,
        ]),
        { cwd: rootDirectory, env: childEnvironment },
      );
      const packReports = JSON.parse(packOutput);
      assert.equal(packReports.length, 1, "npm pack must produce exactly one artifact");
      [packReport] = packReports;
      tarballPath = join(artifactDirectory, packReport.filename);
    }
    const artifactSnapshot = await readStableArtifact(tarballPath);
    const artifactBytes = Buffer.from(artifactSnapshot.bytes);
    const inspectedArchive = inspectPackedArchive(artifactBytes, {
      packFiles: packReport?.files,
    });
    const archiveEntries = inspectedArchive.paths;
    const sha256 = hashBytes(artifactBytes, "sha256");
    const sha512 = hashBytes(artifactBytes, "sha512");
    const integrity = `sha512-${sha512}`;
    const shasum = hashBytes(artifactBytes, "sha1");
    if (packReport !== undefined) {
      assert.equal(packReport.integrity, integrity);
      assert.equal(packReport.shasum, shasum);
    }

    const packedPackageManifest = inspectedArchive.packageManifest;
    assertPackedManifest(
      packedPackageManifest,
      packageManifest.name,
      environmentCandidate === undefined
        ? packageManifest.version
        : packedPackageManifest.version,
      artifactPublicationMode,
    );
    const filename = `${packedPackageManifest.name}-${packedPackageManifest.version}.tgz`;
    if (packReport !== undefined) {
      assert.equal(
        basename(tarballPath),
        filename,
        "npm-packed candidate filename must match its package identity",
      );
    }

    registry = await startLocalRegistry({
      tarballFilename: filename,
      tarballBytes: artifactBytes,
      packageManifest: packedPackageManifest,
      integrity,
      shasum,
    });
    const consumers = [];
    for (const alias of COMPATIBILITY_ALIASES) {
      consumers.push(
        await createAndVerifyConsumer({
          alias,
          workDirectory,
          registry,
          packageManifest: packedPackageManifest,
          archiveEntries,
          integrity,
          expectedExports,
          rootDirectory,
          environment,
          guard,
          home: childHome,
          npmInvocation,
          publicationMode: artifactPublicationMode,
        }),
      );
      await assertEnvironmentCandidateUnchanged(environmentCandidate);
    }

    const allowedRequests = new Set([
      "/open-rfc",
      `/open-rfc/-/${filename}`,
    ]);
    const unexpectedRequests = registry.requests.filter(
      ({ method, pathname }) =>
        !["GET", "HEAD"].includes(method) || !allowedRequests.has(pathname),
    );
    assert.deepEqual(unexpectedRequests, [], "npm must only contact the loopback package endpoints");
    assert(registry.requests.some(({ pathname }) => pathname === "/open-rfc"));
    assert(
      registry.requests.some(
        ({ pathname }) => pathname === `/open-rfc/-/${filename}`,
      ),
    );

    const artifactAfter = await readStableArtifact(tarballPath);
    assert.equal(
      hashBytes(artifactAfter.bytes, "sha256"),
      sha256,
      "qualified artifact must remain byte-identical through every consumer",
    );
    succeeded = true;
    return {
      schemaVersion: 1,
      publicationMode: artifactPublicationMode,
      ...(environmentCandidate === undefined
        ? {}
        : { sourcePublicationMode }),
      package: {
        name: packedPackageManifest.name,
        version: packedPackageManifest.version,
      },
      artifact: {
        filename,
        fileCount: archiveEntries.length,
        integrity,
        sha256,
        size: artifactBytes.length,
      },
      consumers,
      sdkFree: true,
      externalNetworkRequired: false,
      networkGuard: true,
      secretFreeChildEnvironment: true,
      suppliedArtifact: suppliedArtifact !== undefined,
      ...(keep ? { workDirectory } : {}),
    };
  } finally {
    try {
      await assertEnvironmentCandidateUnchanged(environmentCandidate);
    } finally {
      try {
        if (registry) await registry.close();
      } finally {
        if (!keep) await cleanupPackedCompatibilityDirectory(workDirectory);
      }
    }
    if (!succeeded && keep) {
      process.stderr.write(`packed compatibility work directory retained: ${workDirectory}\n`);
    }
  }
}

function parseCliArguments(arguments_) {
  const options = { keep: false, skipBuild: false, publicationMode: "private" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--keep") options.keep = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--publication-mode") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("--publication-mode requires a value");
      }
      options.publicationMode = value;
      index += 1;
    }
    else if (argument === "--artifact" || argument === "--artifact-directory") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${argument} requires a path`);
      }
      index += 1;
      if (argument === "--artifact") options.artifactPath = value;
      else options.artifactDirectory = value;
    }
    else fail(`unknown argument ${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPackedCompatibility(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
