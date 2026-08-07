#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePinnedNpmToolchain } from "./pinned_npm.mjs";
import {
  parseCanonicalNpmTarball,
  REPLACEMENT_ARCHIVE_ENVELOPE,
} from "./release_set_contract.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(TOOL_DIRECTORY, "..");
const EXAMPLE_MARKER = /<!-- open-rfc-doc-example\b/gu;
const COMPLETE_EXAMPLE =
  /<!-- open-rfc-doc-example id="([a-z][a-z0-9-]{0,63})" runtime="(esm|cjs|typescript)" outcome="(success|missing-connection|typecheck)" sha256="([a-f0-9]{64})" -->\n```(?:js|javascript|ts|typescript)\n([\s\S]*?)\n```/gu;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_EXAMPLE_BYTES = 16 * 1024;
const MAX_TOTAL_EXAMPLE_BYTES = 64 * 1024;
const MAX_EXAMPLES = 32;
const MAX_DOCUMENTS = 512;
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const EXAMPLE_TIMEOUT_MS = 5_000;
const TOOLCHAIN_TREE_ALGORITHM = "relative-path-type-mode-content-sha256-v1";
const MAX_TOOLCHAIN_TREE_ENTRIES = 1_024;
const MAX_TOOLCHAIN_TREE_BYTES = 64 * 1024 * 1024;
const TOOLCHAIN_DIRECTORY_MODES = new Set([0o755]);
const TOOLCHAIN_FILE_MODES = new Set([0o644, 0o755]);
const TOOLCHAIN_SYMLINK_MODES = new Set([0o755, 0o777]);
const MISSING_CONNECTION_ENVIRONMENT_MESSAGE =
  "Missing required SAP connection environment variables: SAP_ASHOST, SAP_CLIENT, SAP_USER, SAP_PASSWD\n";
const NETWORK_GUARD_SOURCE = `
"use strict";
const { syncBuiltinESMExports } = require("node:module");
const deny = () => {
  throw new Error("documentation examples cannot access the network");
};
for (const [moduleName, methods] of [
  ["node:net", ["connect", "createConnection"]],
  ["node:tls", ["connect"]],
  ["node:http", ["get", "request"]],
  ["node:https", ["get", "request"]],
  ["node:http2", ["connect"]],
  ["node:dgram", ["createSocket"]],
  ["node:dns", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]],
  ["node:dns/promises", ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]],
]) {
  const module = require(moduleName);
  for (const method of methods) module[method] = deny;
}
Object.defineProperty(globalThis, "fetch", { configurable: true, value: deny });
if ("WebSocket" in globalThis) {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: deny });
}
syncBuiltinESMExports();
`;

export class DocumentationExampleError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentationExampleError";
  }
}

function fail(message) {
  throw new DocumentationExampleError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function documentationToolchainTreeInventory(directory, label) {
  const information = await lstat(directory);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    fail(`${label} root must be a real directory`);
  }
  const rootMode = information.mode & 0o777;
  if (!TOOLCHAIN_DIRECTORY_MODES.has(rootMode)) {
    fail(`${label} root uses an unexpected directory mode`);
  }
  const root = await realpath(directory);
  const hash = createHash("sha256");
  hash.update(`root\0directory\0${rootMode.toString(8)}\0`);
  let entryCount = 0;
  let regularFileCount = 0;
  let regularFileBytes = 0;
  const include = (record) => {
    entryCount += 1;
    if (entryCount > MAX_TOOLCHAIN_TREE_ENTRIES) {
      fail(`${label} exceeds the installed-tree entry envelope`);
    }
    hash.update(record);
    hash.update("\0");
  };
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const entry of entries) {
      if (entry.name.includes("\0") || entry.name.includes("/")) {
        fail(`${label} contains an invalid installed-tree path`);
      }
      const path = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const before = await lstat(path);
      const mode = before.mode & 0o777;
      if (before.isDirectory() && !before.isSymbolicLink()) {
        if (!TOOLCHAIN_DIRECTORY_MODES.has(mode)) {
          fail(`${label} contains an unexpected directory mode`);
        }
        include(`directory\0${relativePath}\0${mode.toString(8)}`);
        await walk(path, relativePath);
        const after = await lstat(path);
        if (
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          after.nlink !== before.nlink ||
          (after.mode & 0o777) !== mode
        ) {
          fail(`${label} changed while its directory entries were inventoried`);
        }
      } else if (before.isFile() && !before.isSymbolicLink()) {
        if (before.nlink !== 1) {
          fail(`${label} contains a hardlinked regular file`);
        }
        if (!TOOLCHAIN_FILE_MODES.has(mode)) {
          fail(`${label} contains an unexpected regular-file mode`);
        }
        const bytes = await readFile(path);
        const after = await lstat(path);
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          after.nlink !== 1 ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          (after.mode & 0o777) !== mode
        ) {
          fail(`${label} changed while a regular file was inventoried`);
        }
        regularFileCount += 1;
        regularFileBytes += bytes.length;
        if (regularFileBytes > MAX_TOOLCHAIN_TREE_BYTES) {
          fail(`${label} exceeds the installed-tree byte envelope`);
        }
        include(
          `file\0${relativePath}\0${mode.toString(8)}\0${bytes.length}\0${sha256(bytes)}`,
        );
      } else if (before.isSymbolicLink()) {
        if (before.nlink !== 1 || !TOOLCHAIN_SYMLINK_MODES.has(mode)) {
          fail(`${label} contains an unsafe symbolic link`);
        }
        const target = await readlink(path);
        const resolvedTarget = await realpath(path);
        const resolvedRelativePath = relative(root, resolvedTarget);
        if (
          resolvedRelativePath === "" ||
          resolvedRelativePath.startsWith("..") ||
          isAbsolute(resolvedRelativePath)
        ) {
          fail(`${label} contains a path-escaping symbolic link`);
        }
        const targetBefore = await lstat(resolvedTarget);
        const targetMode = targetBefore.mode & 0o777;
        if (
          !targetBefore.isFile() ||
          targetBefore.isSymbolicLink() ||
          targetBefore.nlink !== 1 ||
          !TOOLCHAIN_FILE_MODES.has(targetMode)
        ) {
          fail(`${label} symbolic link resolves to an unsafe target`);
        }
        const targetBytes = await readFile(resolvedTarget);
        const targetAfter = await lstat(resolvedTarget);
        const after = await lstat(path);
        if (
          !targetAfter.isFile() ||
          targetAfter.isSymbolicLink() ||
          targetAfter.nlink !== 1 ||
          targetAfter.dev !== targetBefore.dev ||
          targetAfter.ino !== targetBefore.ino ||
          targetAfter.size !== targetBefore.size ||
          targetAfter.mtimeMs !== targetBefore.mtimeMs ||
          targetAfter.ctimeMs !== targetBefore.ctimeMs ||
          (targetAfter.mode & 0o777) !== targetMode ||
          !after.isSymbolicLink() ||
          after.nlink !== 1 ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          (after.mode & 0o777) !== mode ||
          (await readlink(path)) !== target
        ) {
          fail(`${label} symbolic link changed while it was inventoried`);
        }
        include(
          `symlink\0${relativePath}\0${mode.toString(8)}\0${target}\0` +
            `${resolvedRelativePath}\0file\0${targetMode.toString(8)}\0` +
            `${targetBytes.length}\0${sha256(targetBytes)}`,
        );
      } else {
        fail(`${label} contains an unsupported installed-tree entry`);
      }
    }
  };
  await walk(root, "");
  return Object.freeze({
    algorithm: TOOLCHAIN_TREE_ALGORITHM,
    entryCount,
    regularFileCount,
    regularFileBytes,
    inventorySha256: `sha256:${hash.digest("hex")}`,
  });
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function stableCandidate(path, label) {
  let descriptor;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) fail(`${label} must be a regular file`);
    if (before.nlink !== 1n) fail(`${label} must not be hard-linked`);
    if (before.size < 1n || before.size > BigInt(MAX_TARBALL_BYTES)) {
      fail(`${label} is outside its byte bound`);
    }
    descriptor = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await descriptor.stat({ bigint: true });
    if (!opened.isFile()) fail(`${label} must be a regular file`);
    if (opened.nlink !== 1n) fail(`${label} must not be hard-linked`);
    if (!sameFileIdentity(before, opened)) {
      fail(`${label} changed while it was opened`);
    }
    const bytes = await descriptor.readFile();
    const afterRead = await descriptor.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !sameFileIdentity(opened, afterRead) ||
      !sameFileIdentity(opened, afterPath)
    ) {
      fail(`${label} changed while it was read`);
    }
    return Object.freeze({
      bytes,
      identity: Object.freeze({
        dev: opened.dev,
        ino: opened.ino,
        mode: opened.mode,
        nlink: opened.nlink,
        size: opened.size,
        mtimeNs: opened.mtimeNs,
        ctimeNs: opened.ctimeNs,
      }),
    });
  } catch (error) {
    if (error instanceof DocumentationExampleError) throw error;
    fail(`${label} could not be read securely`);
  } finally {
    await descriptor?.close();
  }
}

async function suppliedCandidate(environment, explicitArtifactPath) {
  // An explicit programmatic artifact remains an independent legacy mode.
  // The environment-supplied artifact is used only when the caller did not make
  // that existing choice explicitly.
  if (explicitArtifactPath !== undefined) return null;
  const pathValue = environment.OPEN_RFC_CANDIDATE_TARBALL;
  const expectedSha256 = environment.OPEN_RFC_CANDIDATE_TARBALL_SHA256;
  if (pathValue === undefined && expectedSha256 === undefined) return null;
  if (
    typeof pathValue !== "string" ||
    pathValue.length === 0 ||
    typeof expectedSha256 !== "string" ||
    !PREFIXED_SHA256.test(expectedSha256)
  ) {
    fail("candidate tarball path and prefixed SHA-256 must be set together");
  }
  const path = resolve(pathValue);
  const source = await stableCandidate(path, "supplied candidate tarball");
  if (`sha256:${sha256(source.bytes)}` !== expectedSha256) {
    fail("supplied candidate tarball SHA-256 drifted");
  }
  let manifest;
  try {
    const archive = parseCanonicalNpmTarball(
      source.bytes,
      REPLACEMENT_ARCHIVE_ENVELOPE,
    );
    const manifestEntry = archive.entries.find(
      (entry) => entry.path === "package/package.json",
    );
    if (manifestEntry === undefined) {
      fail("supplied candidate tarball is missing its package manifest");
    }
    manifest = JSON.parse(manifestEntry.bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof DocumentationExampleError) throw error;
    fail("supplied candidate tarball package identity is invalid");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.name !== "open-rfc" ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    fail("supplied candidate tarball package identity is invalid");
  }
  return {
    path,
    expectedSha256,
    packageName: manifest.name,
    packageVersion: manifest.version,
    bytes: Buffer.from(source.bytes),
    sourceIdentity: source.identity,
    materialized: undefined,
  };
}

async function verifyCandidate(candidate) {
  if (candidate === null) return;
  const source = await stableCandidate(
    candidate.path,
    "supplied candidate tarball",
  );
  if (
    !sameFileIdentity(source.identity, candidate.sourceIdentity) ||
    `sha256:${sha256(source.bytes)}` !== candidate.expectedSha256 ||
    !source.bytes.equals(candidate.bytes)
  ) {
    fail("supplied candidate tarball SHA-256 drifted");
  }
  if (candidate.materialized === undefined) return;
  const snapshot = await stableCandidate(
    candidate.materialized.path,
    "materialized candidate tarball",
  );
  if (
    !sameFileIdentity(snapshot.identity, candidate.materialized.identity) ||
    (snapshot.identity.mode & 0o777n) !== 0o600n ||
    `sha256:${sha256(snapshot.bytes)}` !== candidate.expectedSha256 ||
    !snapshot.bytes.equals(candidate.bytes)
  ) {
    fail("materialized candidate tarball SHA-256 drifted");
  }
}

async function materializeCandidate(candidate, workDirectory) {
  const directory = join(workDirectory, "candidate");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "open-rfc-candidate.tgz");
  await writeFile(path, candidate.bytes, { flag: "wx", mode: 0o600 });
  const metadata = await lstat(path, { bigint: true });
  if ((metadata.mode & 0o777n) !== 0o600n) {
    fail("materialized candidate tarball must have private file permissions");
  }
  const snapshot = await stableCandidate(path, "materialized candidate tarball");
  candidate.materialized = Object.freeze({
    identity: snapshot.identity,
    path,
  });
  await verifyCandidate(candidate);
  return path;
}

async function cleanupDocumentationWorkspace(path) {
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
  if (failed) fail("documentation example workspace cleanup failed");
}

function safeRelativePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a safe repository-relative path`);
  }
  return path;
}

function assertOpenRfcPackageImport(source, runtime, sourcePath, id) {
  const importsSpecifier = (specifier) =>
    runtime === "esm" || runtime === "typescript"
      ? new RegExp(
          `(?:\\bfrom\\s+|\\bimport\\s*\\(\\s*|\\bimport\\s+)["']${specifier}["']`,
          "u",
        ).test(source)
      : new RegExp(
          `\\brequire\\s*\\(\\s*["']${specifier}["']\\s*\\)`,
          "u",
        ).test(source);
  if (!["open-rfc", "node-rfc"].some(importsSpecifier)) {
    fail(
      `${sourcePath} example ${id} must import open-rfc or its node-rfc alias using its declared runtime`,
    );
  }
}

/** Parse digest-bound examples from one Markdown document. */
export function extractDocumentationExamples(source, sourcePath) {
  safeRelativePath(sourcePath, "documentation source path");
  if (typeof source !== "string") fail(`${sourcePath} must be text`);
  if (Buffer.byteLength(source) > MAX_DOCUMENT_BYTES) {
    fail(`${sourcePath} exceeds the documentation example input bound`);
  }

  const markerCount = [...source.matchAll(EXAMPLE_MARKER)].length;
  const examples = [];
  for (const match of source.matchAll(COMPLETE_EXAMPLE)) {
    const [, id, runtime, outcome, expectedSha256, exampleSource] = match;
    if ((runtime === "typescript") !== (outcome === "typecheck")) {
      fail(`${sourcePath} example ${id} has an invalid runtime/outcome pair`);
    }
    const byteLength = Buffer.byteLength(exampleSource);
    if (byteLength === 0 || byteLength > MAX_EXAMPLE_BYTES) {
      fail(`${sourcePath} example ${id} exceeds the executable source bound`);
    }
    const actualSha256 = sha256(exampleSource);
    if (actualSha256 !== expectedSha256) {
      fail(`${sourcePath} example ${id} does not match its declared SHA-256`);
    }
    assertOpenRfcPackageImport(exampleSource, runtime, sourcePath, id);
    examples.push(
      Object.freeze({
        id,
        outcome,
        runtime,
        sha256: actualSha256,
        source: exampleSource,
        sourcePath,
      }),
    );
  }
  if (examples.length !== markerCount) {
    fail(`${sourcePath} contains a malformed documentation example marker`);
  }
  return Object.freeze(examples);
}

/** Validate the repository-wide example inventory without executing source. */
export function collectDocumentationExamples(documents) {
  if (!Array.isArray(documents)) fail("documentation sources must be an array");
  if (documents.length === 0 || documents.length > MAX_DOCUMENTS) {
    fail(`documentation sources must contain 1 to ${MAX_DOCUMENTS} entries`);
  }
  const examples = [];
  const identifiers = new Set();
  let totalBytes = 0;
  for (const document of documents) {
    if (
      typeof document !== "object" ||
      document === null ||
      Array.isArray(document)
    ) {
      fail("documentation source entry must be an object");
    }
    const parsed = extractDocumentationExamples(document.source, document.path);
    for (const example of parsed) {
      if (identifiers.has(example.id)) {
        fail(`duplicate documentation example ID: ${example.id}`);
      }
      identifiers.add(example.id);
      totalBytes += Buffer.byteLength(example.source);
      examples.push(example);
    }
  }
  if (examples.length < 2 || examples.length > MAX_EXAMPLES) {
    fail(`documentation examples must contain 2 to ${MAX_EXAMPLES} entries`);
  }
  if (totalBytes > MAX_TOTAL_EXAMPLE_BYTES) {
    fail("documentation examples exceed the aggregate source bound");
  }
  const runtimes = new Set(examples.map((example) => example.runtime));
  if (!runtimes.has("esm") || !runtimes.has("cjs")) {
    fail("documentation examples must cover both ESM and CommonJS");
  }
  return Object.freeze(examples);
}

function normalizedNpmInvocation(value, environment) {
  if (value === undefined) {
    const toolchain = resolvePinnedNpmToolchain({ environment });
    return Object.freeze({
      command: toolchain.command,
      argumentsPrefix: Object.freeze([...toolchain.argumentsPrefix]),
    });
  }
  if (
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    !Array.isArray(value.argumentsPrefix) ||
    !value.argumentsPrefix.every((argument) => typeof argument === "string")
  ) {
    fail("npm invocation is invalid");
  }
  return Object.freeze({
    command: value.command,
    argumentsPrefix: Object.freeze([...value.argumentsPrefix]),
  });
}

function npmArguments(invocation, arguments_) {
  return [...invocation.argumentsPrefix, ...arguments_];
}

function sanitizedEnvironment(workDirectory, source = process.env) {
  const environment = {
    HOME: workDirectory,
    LANG: "C",
    LC_ALL: "C",
    NO_PROXY: "*",
    no_proxy: "*",
    npm_config_audit: "false",
    npm_config_cache: join(workDirectory, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: join(workDirectory, ".npmrc"),
    TEMP: workDirectory,
    TMP: workDirectory,
    TMPDIR: workDirectory,
  };
  for (const name of ["COMSPEC", "PATH", "PATHEXT", "SystemRoot", "WINDIR"]) {
    if (typeof source[name] === "string") environment[name] = source[name];
  }
  return environment;
}

async function runCommand(command, arguments_, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let oversized = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        oversized = true;
        child.kill("SIGKILL");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        oversized = true;
        child.kill("SIGKILL");
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (oversized) {
        rejectPromise(
          new DocumentationExampleError(
            `${options.label} exceeded its output bound`,
          ),
        );
      } else if (
        code === 1 &&
        signal === null &&
        stdout.length === 0 &&
        options.acceptMissingConnectionEnvironment === true &&
        stderr.toString("utf8") === MISSING_CONNECTION_ENVIRONMENT_MESSAGE
      ) {
        resolvePromise("");
      } else if (code !== 0) {
        rejectPromise(
          new DocumentationExampleError(
            `${options.label} failed (${signal ?? `exit ${String(code)}`})`,
          ),
        );
      } else if (options.requireEmptyStderr === true && stderr.length !== 0) {
        rejectPromise(
          new DocumentationExampleError(
            `${options.label} produced unexpected standard error`,
          ),
        );
      } else {
        resolvePromise(stdout.toString("utf8"));
      }
    });
  });
}

async function trackedMarkdownSources(root, environment) {
  const output = await runCommand(
    "git",
    ["ls-files", "-z", "--", "*.md", "**/*.md"],
    {
      cwd: root,
      env: environment,
      label: "tracked Markdown enumeration",
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  const paths = [...new Set(output.split("\0").filter(Boolean))].sort();
  const documents = await Promise.all(
    paths.map(async (path) => {
      const safePath = safeRelativePath(path, "tracked Markdown path");
      try {
        return {
          path: safePath,
          source: await readFile(resolve(root, safePath), "utf8"),
        };
      } catch (error) {
        // `git ls-files` includes an index entry deleted in the current
        // worktree. That path has no executable example source and must not
        // make documentation verification impossible during a reviewed delete.
        if (error && typeof error === "object" && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }),
  );
  return documents.filter((document) => document !== undefined);
}

async function resolveArtifact(
  root,
  artifactPath,
  workDirectory,
  environment,
  npmInvocation,
  suppliedIdentity,
) {
  const rootManifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    typeof rootManifest.name !== "string" ||
    typeof rootManifest.version !== "string" ||
    rootManifest.name.length === 0 ||
    rootManifest.version.length === 0
  ) {
    fail("root package manifest has no package identity");
  }

  let resolvedArtifact;
  if (artifactPath === undefined) {
    const packDirectory = join(workDirectory, "pack");
    await mkdir(packDirectory, { recursive: true });
    const output = await runCommand(
      npmInvocation.command,
      npmArguments(npmInvocation, [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ]),
      {
        cwd: root,
        env: environment,
        label: "documentation example npm pack",
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    let report;
    try {
      report = JSON.parse(output);
    } catch {
      fail("documentation example npm pack returned invalid JSON");
    }
    if (
      !Array.isArray(report) ||
      report.length !== 1 ||
      report[0]?.name !== rootManifest.name ||
      report[0]?.version !== rootManifest.version ||
      typeof report[0]?.filename !== "string"
    ) {
      fail(
        "documentation example npm pack returned the wrong package identity",
      );
    }
    resolvedArtifact = join(packDirectory, report[0].filename);
  } else {
    resolvedArtifact = resolve(artifactPath);
  }

  const artifactMetadata = await lstat(resolvedArtifact);
  if (
    !artifactMetadata.isFile() ||
    artifactMetadata.isSymbolicLink() ||
    artifactMetadata.size < 1 ||
    artifactMetadata.size > MAX_TARBALL_BYTES
  ) {
    fail("documentation example artifact must be a bounded regular tarball");
  }
  const artifactBytes = await readFile(resolvedArtifact);
  return Object.freeze({
    artifactPath: resolvedArtifact,
    artifactSha256: sha256(artifactBytes),
    packageName: suppliedIdentity?.name ?? rootManifest.name,
    packageVersion: suppliedIdentity?.version ?? rootManifest.version,
  });
}

async function installArtifact(
  artifact,
  consumerDirectory,
  environment,
  npmInvocation,
) {
  await mkdir(consumerDirectory, { recursive: true });
  const localArtifact = relative(
    consumerDirectory,
    artifact.artifactPath,
  ).replaceAll("\\", "/");
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "open-rfc-documentation-examples",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          [artifact.packageName]: `file:${localArtifact}`,
          "node-rfc": `file:${localArtifact}`,
        },
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await runCommand(
    npmInvocation.command,
    npmArguments(npmInvocation, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
    ]),
    {
      cwd: consumerDirectory,
      env: environment,
      label: "documentation example artifact install",
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  const treeOutput = await runCommand(
    npmInvocation.command,
    npmArguments(npmInvocation, ["ls", "open-rfc", "node-rfc", "--all", "--json"]),
    {
      cwd: consumerDirectory,
      env: environment,
      label: "documentation example installed dependency tree",
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  let tree;
  try {
    tree = JSON.parse(treeOutput);
  } catch {
    fail("documentation example dependency tree returned invalid JSON");
  }
  for (const installedName of [artifact.packageName, "node-rfc"]) {
    if (tree.dependencies?.[installedName]?.version !== artifact.packageVersion) {
      fail("documentation examples resolved a different package tree");
    }
  }
  for (const installedName of [artifact.packageName, "node-rfc"]) {
    const installedPath = join(
      consumerDirectory,
      "node_modules",
      ...installedName.split("/"),
    );
    const installedMetadata = await lstat(installedPath);
    if (!installedMetadata.isDirectory() || installedMetadata.isSymbolicLink()) {
      fail(
        "documentation example dependency was not installed as a package directory",
      );
    }
    const installedManifest = JSON.parse(
      await readFile(join(installedPath, "package.json"), "utf8"),
    );
    if (
      installedManifest.name !== artifact.packageName ||
      installedManifest.version !== artifact.packageVersion
    ) {
      fail("documentation examples resolved a different package identity");
    }
  }
}

export async function resolveDocumentationTypecheckToolchain(
  root,
  documents,
  examples,
) {
  if (!examples.some(({ runtime }) => runtime === "typescript")) {
    return undefined;
  }
  let manifest;
  let lockfile;
  let pins;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    lockfile = JSON.parse(
      await readFile(join(root, "package-lock.json"), "utf8"),
    );
    pins = JSON.parse(
      await readFile(
        join(root, "conformance", "toolchain-pins.v1.json"),
        "utf8",
      ),
    );
  } catch {
    fail("TypeScript documentation requires readable root toolchain contracts");
  }
  const typescript = manifest.devDependencies?.typescript;
  const nodeTypes = manifest.devDependencies?.["@types/node"];
  if (
    typeof typescript !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(typescript) ||
    typeof nodeTypes !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(nodeTypes)
  ) {
    fail("TypeScript documentation requires exact root toolchain versions");
  }
  const gettingStarted = documents.find(
    ({ path }) => path === "docs_page/getting-started.md",
  );
  if (
    gettingStarted === undefined ||
    !gettingStarted.source.includes(`TypeScript ${typescript}`) ||
    !gettingStarted.source.includes(`\`@types/node\` ${nodeTypes}`)
  ) {
    fail("TypeScript documentation toolchain versions drifted from package.json");
  }
  const packageNames = ["@types/node", "typescript", "undici-types"];
  const pinNames = Object.keys(pins.documentationTypecheck ?? {}).sort();
  if (
    pinNames.length !== packageNames.length ||
    pinNames.some((name, index) => name !== packageNames[index])
  ) {
    fail("TypeScript documentation toolchain inventory is incomplete");
  }
  const packages = [];
  for (const name of packageNames) {
    const expected = pins.documentationTypecheck[name];
    const locked = lockfile.packages?.[`node_modules/${name}`];
    const installedPath = join(root, "node_modules", ...name.split("/"));
    let installedManifest;
    try {
      installedManifest = JSON.parse(
        await readFile(join(installedPath, "package.json"), "utf8"),
      );
    } catch {
      fail("TypeScript documentation requires its installed root toolchain");
    }
    if (
      expected === null ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      Object.keys(expected).sort().join("\0") !==
        ["installedTree", "integrity", "version"].join("\0") ||
      typeof expected.version !== "string" ||
      typeof expected.integrity !== "string" ||
      expected.installedTree === null ||
      typeof expected.installedTree !== "object" ||
      Array.isArray(expected.installedTree) ||
      locked?.version !== expected.version ||
      locked?.integrity !== expected.integrity ||
      installedManifest.version !== expected.version
    ) {
      fail("TypeScript documentation toolchain pin drifted");
    }
    if (
      (name === "typescript" || name === "@types/node") &&
      (pins.developmentDependencies?.[name]?.version !== expected.version ||
        pins.developmentDependencies?.[name]?.integrity !== expected.integrity)
    ) {
      fail("TypeScript documentation development dependency pin drifted");
    }
    packages.push(
      Object.freeze({
        expectedTree: Object.freeze({ ...expected.installedTree }),
        name,
        path: installedPath,
      }),
    );
  }
  const revalidate = async () => {
    for (const package_ of packages) {
      let actual;
      try {
        actual = await documentationToolchainTreeInventory(
          package_.path,
          `documentation ${package_.name} toolchain`,
        );
      } catch {
        fail("TypeScript documentation toolchain inventory is unsafe");
      }
      if (JSON.stringify(actual) !== JSON.stringify(package_.expectedTree)) {
        fail("TypeScript documentation toolchain bytes drifted");
      }
    }
  };
  await revalidate();
  return Object.freeze({
    compilerPath: join(root, "node_modules", "typescript", "bin", "tsc"),
    revalidate,
    typeRoots: join(root, "node_modules", "@types"),
  });
}

/** Pack/install once, then run every digest-bound example with no inherited secrets. */
export async function runDocumentationExamples(options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const sourceEnvironment = options.environment ?? process.env;
  const candidate = await suppliedCandidate(
    sourceEnvironment,
    options.artifactPath,
  );
  const npmInvocation = normalizedNpmInvocation(
    options.npmInvocation,
    sourceEnvironment,
  );
  const workDirectory = await mkdtemp(join(tmpdir(), "open-rfc-doc-examples-"));
  let result;
  let primaryFailure;
  try {
    const environment = sanitizedEnvironment(workDirectory, sourceEnvironment);
    await writeFile(join(workDirectory, ".npmrc"), "", { mode: 0o600 });
    const documents =
      options.documents ?? (await trackedMarkdownSources(root, environment));
    const examples = collectDocumentationExamples(documents);
    const typecheckToolchain = await resolveDocumentationTypecheckToolchain(
      root,
      documents,
      examples,
    );
    const artifactPath =
      candidate === null
        ? options.artifactPath
        : await materializeCandidate(candidate, workDirectory);
    const artifact = await resolveArtifact(
      root,
      artifactPath,
      workDirectory,
      environment,
      npmInvocation,
      candidate === null
        ? undefined
        : { name: candidate.packageName, version: candidate.packageVersion },
    );
    if (
      candidate !== null &&
      `sha256:${artifact.artifactSha256}` !== candidate.expectedSha256
    ) {
      fail("materialized candidate tarball SHA-256 drifted");
    }
    if (artifact.packageName !== "open-rfc") {
      fail("documentation examples require the open-rfc package identity");
    }
    if (candidate !== null) {
      await verifyCandidate(candidate);
    }
    const consumerDirectory = join(workDirectory, "consumer");
    await installArtifact(
      artifact,
      consumerDirectory,
      environment,
      npmInvocation,
    );
    await verifyCandidate(candidate);
    const networkGuardPath = join(workDirectory, "deny-network.cjs");
    await writeFile(networkGuardPath, NETWORK_GUARD_SOURCE, { mode: 0o600 });

    const results = [];
    for (const example of examples) {
      const extension =
        example.runtime === "typescript"
          ? "ts"
          : example.runtime === "esm"
            ? "mjs"
            : "cjs";
      const path = join(consumerDirectory, `${example.id}.${extension}`);
      await writeFile(path, `${example.source}\n`, { mode: 0o600 });
      let stdout;
      if (example.runtime === "typescript") {
        const projectPath = join(consumerDirectory, "tsconfig.json");
        await writeFile(
          projectPath,
          `${JSON.stringify(
            {
              compilerOptions: {
                module: "NodeNext",
                moduleResolution: "NodeNext",
                noEmit: true,
                strict: true,
                target: "ES2022",
                typeRoots: [typecheckToolchain.typeRoots],
                types: ["node"],
              },
              files: [path],
            },
            undefined,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        stdout = await runCommand(
          process.execPath,
          [
            typecheckToolchain.compilerPath,
            "--project",
            projectPath,
          ],
          {
            cwd: consumerDirectory,
            env: environment,
            label: `documentation example ${example.id}`,
            timeoutMs: COMMAND_TIMEOUT_MS,
            requireEmptyStderr: true,
          },
        );
        await typecheckToolchain.revalidate();
      } else {
        stdout = await runCommand(
          process.execPath,
          ["--require", networkGuardPath, path],
          {
            cwd: consumerDirectory,
            env: environment,
            label: `documentation example ${example.id}`,
            timeoutMs: EXAMPLE_TIMEOUT_MS,
            acceptMissingConnectionEnvironment:
              example.outcome === "missing-connection",
            requireEmptyStderr: example.outcome === "success",
          },
        );
      }
      await verifyCandidate(candidate);
      if (stdout.length !== 0) {
        fail(`documentation example ${example.id} produced unexpected output`);
      }
      results.push(
        Object.freeze({
          id: example.id,
          outcome: example.outcome,
          runtime: example.runtime,
          sourcePath: example.sourcePath,
          status: "passed",
        }),
      );
    }

    await verifyCandidate(candidate);

    result = Object.freeze({
      status: "passed",
      packageName: artifact.packageName,
      packageVersion: artifact.packageVersion,
      artifactSha256: artifact.artifactSha256,
      exampleCount: results.length,
      runtimes: Object.freeze(
        [...new Set(results.map(({ runtime }) => runtime))].sort(),
      ),
      examples: Object.freeze(results),
    });
  } catch (error) {
    primaryFailure = error;
  }

  const restorationFailures = [];
  try {
    await verifyCandidate(candidate);
  } catch (error) {
    restorationFailures.push(error);
  }
  try {
    await cleanupDocumentationWorkspace(workDirectory);
  } catch (error) {
    restorationFailures.push(error);
  }
  if (primaryFailure !== undefined && restorationFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...restorationFailures],
      "documentation examples and restoration both failed",
      { cause: primaryFailure },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (restorationFailures.length > 0) {
    throw new AggregateError(
      restorationFailures,
      "documentation example restoration failed",
    );
  }
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runDocumentationExamples();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error?.name ?? "Error"}: ${error?.message ?? String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
