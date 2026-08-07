#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import ts from "typescript";

import releaseArtifactGateSchema from
  "../conformance/schemas/release-artifact-gate-v1.schema.json" with { type: "json" };
import releaseHistorySecretAdmissionsSchema from
  "../conformance/schemas/release-history-secret-admissions-v1.schema.json" with { type: "json" };

import {
  CONNECTOR_ARCHIVE_ENVELOPE,
  computeReleaseSetSha256,
  npmIntegrity,
  parseCanonicalNpmTarball,
} from "./release_set_contract.mjs";
import {
  PINNED_NPM_VERSION,
  pinnedNpmArguments,
  resolvePinnedNpmToolchain,
} from "./pinned_npm.mjs";
import {
  resolveTrustedGitPath,
  trustedGitArguments,
  trustedGitEnvironment,
} from "./trusted_git.mjs";
import { fsyncDirectoryDescriptor } from "./directory_fsync.mjs";
import { validateJsonSchemaSubset } from "./json_schema_subset.mjs";
import {
  assertGitRefObjectInventory,
  assertPublishableGitRefScope,
  readGitRefObjectInventory,
  readPublishableGitRefScope,
} from "./git_ref_inventory.mjs";
import {
  assertPublicationManifestProfile,
  CONVENTIONAL_LEGAL_PATHS,
  hasThirdPartyNoticePath,
  isApprovedApache2LicenseBytes,
  normalizePublicationMode,
  publicationEnvironmentSecrets,
  publicationSecretMatches,
  publicationSecretPatternIndex,
  spdxLicenseFromManifest,
} from "./publication_safety.mjs";
import {
  OPEN_RFC_PACKAGED_README_HTTPS_TARGETS,
  PackagedReadmeLinkError,
  assertPackagedReadmeLinks,
} from "./packaged_readme_links.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(TOOL_DIRECTORY, "..");
const COMMAND_MONITOR_PATH = join(TOOL_DIRECTORY, "bounded_command_monitor.mjs");
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_COUNT = 512;
const MAX_TAR_STREAM_BYTES =
  MAX_UNPACKED_BYTES + (MAX_ENTRY_COUNT * 2 + 4) * 512;
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const SUPERVISOR_HARD_FALLBACK_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_COMMAND_INPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TOKEN_ENVIRONMENT_NAME = "OPEN_RFC_COMMAND_TOKEN";
const MAX_HISTORY_OBJECT_COUNT = 50_000;
const MAX_HISTORY_BLOB_COUNT = 25_000;
const MAX_HISTORY_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_TOTAL_OBJECT_BYTES = 192 * 1024 * 1024;
const MAX_HISTORY_CONTENT_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_PATH_CHANGE_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_SECRET_ADMISSIONS = 512;
const MAX_HISTORY_SECRET_ADMISSION_BYTES = 512 * 1024;
const MAX_RUNTIME_SCAN_FILES = 1024;
const MAX_RUNTIME_SCAN_BYTES = 16 * 1024 * 1024;
const EXPECTED_TYPESCRIPT_SCANNER_VERSION = "5.9.3";
const EXPECTED_BUILD_SCRIPT =
  "node tools/clean_build_output.mjs && tsc -p tsconfig.json && tsc -p tsconfig.cjs.json && node tools/materialize_cjs_manifest.mjs && node tools/normalize_package_modes.mjs";
const PUBLICATION_TRUST_BOUNDARY =
  "POSIX current-UID mode-0700 parent with cooperative same-user writers; non-cooperative same-user mutation is out of scope";
const FORBIDDEN_RUNTIME_LOADER_MODULES = new Set(["node:module", "node:vm"]);
const ALLOWED_EXACT_PATHS = new Set([
  ...CONVENTIONAL_LEGAL_PATHS,
  "README.md",
  "package.json",
  "dist/cjs/package.json",
]);
const REQUIRED_CONNECTOR_FILES = Object.freeze([
  "NOTICE",
  "README.md",
  "package.json",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/cjs/index.d.ts",
  "dist/cjs/index.js",
  "dist/cjs/package.json",
]);
const EXPECTED_CONNECTOR_PACKAGE_FILES = Object.freeze([
  "dist/src",
  "dist/cjs",
  "README.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
]);
const EXPECTED_CONNECTOR_ENGINES = Object.freeze({
  node: "^22.14.0 || ^24.0.0",
});
const FORBIDDEN_PATH_PARTS = /(?:^|[/._-])(?:capture|captures|oracle|nwrfcsdk|sapnwrfc|libsap|sapcrypto|credential|credentials|secret|secrets)(?:$|[/._-])/iu;
const FORBIDDEN_EXTENSION = /\.(?:7z|a|bz2|cap|cer|class|crt|der|dll|dylib|exe|gz|har|jar|key|lib|node|o|obj|p12|pcap|pcapng|pdb|pem|pfx|rar|so(?:\.\d+)*|tar|wasm|xz|zip)$/iu;
const FORBIDDEN_HISTORY_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.captures?)(?:\/|$)/iu;
const HISTORY_SECRET_ADMISSION_PATH =
  "conformance/release-history-secret-admissions.v1.json";
const HISTORY_SECRET_ADMISSION_POLICY = "exact-git-blob-path-pattern-v1";
const HISTORY_SECRET_DRAFT_RATIONALE =
  "Pending independent classification; matched material is intentionally omitted.";
const NATIVE_MAGICS = Object.freeze([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0x00, 0x61, 0x73, 0x6d]),
  Buffer.from([0x4d, 0x5a]),
]);

export class ReleaseArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseArtifactError";
  }
}

function fail(message) {
  throw new ReleaseArtifactError(message);
}

function assertReleasePackagedReadme(entries, options) {
  try {
    return assertPackagedReadmeLinks(entries, options);
  } catch (error) {
    if (error instanceof PackagedReadmeLinkError) fail(error.message);
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const SAFE_NPM_FAILURE_CODES = new Set([
  "E401",
  "E403",
  "E404",
  "EACCES",
  "EAI_AGAIN",
  "EBADENGINE",
  "EBADPLATFORM",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EINTEGRITY",
  "EINVALIDPACKAGENAME",
  "EJSONPARSE",
  "ELOCKVERIFY",
  "ELSPROBLEMS",
  "ENETUNREACH",
  "ENOENT",
  "ENOTCACHED",
  "ENOTFOUND",
  "ENOVERSIONS",
  "EPERM",
  "ERESOLVE",
  "ETARGET",
  "ETIMEDOUT",
  "EUSAGE",
]);
const SAFE_NPM_FAILURE_SYSCALLS = new Set([
  "chmod",
  "connect",
  "getaddrinfo",
  "link",
  "lstat",
  "mkdir",
  "open",
  "read",
  "realpath",
  "rename",
  "rmdir",
  "spawn",
  "stat",
  "symlink",
  "unlink",
  "write",
]);

function npmFailureDiagnostic(encodedStderr) {
  let stderr;
  try {
    stderr = Buffer.from(encodedStderr ?? "", "base64");
  } catch {
    stderr = Buffer.alloc(0);
  }
  const text = stderr.toString("utf8");
  const codeCandidate = /^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,31})\r?$/imu
    .exec(text)?.[1]?.toUpperCase();
  const syscallCandidate =
    /^npm (?:error|ERR!) syscall ([a-z][a-z0-9_]{0,31})\r?$/imu
      .exec(text)?.[1]?.toLowerCase();
  const code = SAFE_NPM_FAILURE_CODES.has(codeCandidate)
    ? codeCandidate
    : "UNCLASSIFIED";
  const syscall = SAFE_NPM_FAILURE_SYSCALLS.has(syscallCandidate)
    ? syscallCandidate
    : "none";
  return `npm-code=${code}, npm-syscall=${syscall}, stderr-sha256=${sha256(stderr)}`;
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value, algorithm, encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function releaseChildEnvironment(source, home) {
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
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    ALL_PROXY: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_ENV: "production",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
}

/** Run a command synchronously behind a bounded, process-tree-aware supervisor. */
export function runBoundedCommand(command, arguments_, options = {}) {
  const timeout = options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const terminationGrace =
    options.terminationGrace ?? DEFAULT_TERMINATION_GRACE_MS;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  const input =
    options.input === undefined || options.input === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(options.input)
        ? options.input
        : typeof options.input === "string"
          ? Buffer.from(options.input)
          : null;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    !Array.isArray(arguments_) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    !Number.isSafeInteger(terminationGrace) ||
    terminationGrace < 1 ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer < 1 ||
    maxBuffer > MAX_COMMAND_OUTPUT_BYTES ||
    ![undefined, "npm"].includes(options.failureMode) ||
    input === null ||
    input.length > MAX_COMMAND_INPUT_BYTES
  ) {
    fail("bounded command options are invalid");
  }
  const commandToken = randomBytes(32).toString("hex");
  const requestedEnvironment = { ...(options.env ?? process.env) };
  const helperEnvironment = { ...requestedEnvironment };
  for (const name of [
    COMMAND_TOKEN_ENVIRONMENT_NAME,
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    delete helperEnvironment[name];
  }
  const request = {
    command,
    arguments: arguments_.map((argument) => String(argument)),
    cwd: options.cwd ?? DEFAULT_ROOT,
    env: {
      ...requestedEnvironment,
      [COMMAND_TOKEN_ENVIRONMENT_NAME]: commandToken,
    },
    timeout,
    terminationGrace,
    hardFallback: SUPERVISOR_HARD_FALLBACK_MS,
    maxBuffer,
    stdin: input.toString("base64"),
  };
  let supervisorOutput;
  try {
    supervisorOutput = execFileSync(
      process.execPath,
      [COMMAND_MONITOR_PATH],
      {
        encoding: "utf8",
        input: JSON.stringify({
          request,
          token: commandToken,
          tokenEnvironmentName: COMMAND_TOKEN_ENVIRONMENT_NAME,
        }),
        maxBuffer: Math.max(1024 * 1024, maxBuffer * 2),
        timeout:
          timeout +
          (terminationGrace * 3) +
          (SUPERVISOR_HARD_FALLBACK_MS * 2) +
          3_000,
        env: helperEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    fail(`${options.label ?? command} command supervisor failed within its bound`);
  }
  let result;
  try {
    result = JSON.parse(supervisorOutput);
  } catch {
    fail(`${options.label ?? command} command supervisor returned invalid output`);
  }
  if (result.timedOut) {
    fail(
      `${options.label ?? command} timed out; bounded termination was attempted ` +
      `for ${result.trackedPidCount ?? 0} tracked process(es) ` +
      `(descendant snapshot complete: ${result.descendantTrackingComplete === true})`,
    );
  }
  if (result.outputExceeded) {
    fail(`${options.label ?? command} exceeded its bounded output limit`);
  }
  if (result.descendantsRemained) {
    fail(`${options.label ?? command} left descendant processes running`);
  }
  if (result.spawnError !== null || result.code !== 0) {
    const diagnostic = options.failureMode === "npm"
      ? ` (${npmFailureDiagnostic(result.stderr)})`
      : "";
    fail(
      `${options.label ?? command} failed with exit code ` +
      `${result.code ?? "unknown"}${diagnostic}`,
    );
  }
  const stdout = Buffer.from(result.stdout, "base64");
  if (options.encoding === null || options.encoding === "buffer") return stdout;
  return stdout.toString(options.encoding ?? "utf8");
}

function run(command, arguments_, options = {}) {
  if (command !== "git") return runBoundedCommand(command, arguments_, options);
  const cwd = options.cwd ?? DEFAULT_ROOT;
  return runBoundedCommand(
    resolveTrustedGitPath(),
    trustedGitArguments(cwd, arguments_),
    {
      ...options,
      cwd,
      env: trustedGitEnvironment(options.env),
    },
  );
}

function safeRelativePath(value, label = "path") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} is not a safe relative path`);
  }
  return value;
}

export function validatePackPath(path) {
  safeRelativePath(path, "package entry path");
  if (path.startsWith("package/")) {
    fail("npm pack metadata paths must not include the package/ prefix");
  }
  if (FORBIDDEN_PATH_PARTS.test(path) || FORBIDDEN_EXTENSION.test(path)) {
    fail("package entry is forbidden by the release allowlist");
  }
  if (ALLOWED_EXACT_PATHS.has(path)) return path;
  if (/^dist\/src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/u.test(path)) {
    return path;
  }
  if (/^dist\/cjs\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/u.test(path)) {
    return path;
  }
  fail("package entry is outside the release allowlist");
}

export function validatePackListing(pack, expectedPackage) {
  if (
    typeof pack !== "object" ||
    pack === null ||
    Array.isArray(pack) ||
    pack.name !== expectedPackage.name ||
    pack.version !== expectedPackage.version ||
    typeof pack.filename !== "string" ||
    !Array.isArray(pack.files)
  ) {
    fail("npm pack result has an unexpected shape");
  }
  if (pack.filename !== `${expectedPackage.name}-${expectedPackage.version}.tgz`) {
    fail("npm pack filename does not match the package identity");
  }
  if (
    !Number.isSafeInteger(pack.size) ||
    pack.size < 1 ||
    pack.size > MAX_TARBALL_BYTES ||
    !Number.isSafeInteger(pack.unpackedSize) ||
    pack.unpackedSize < 1 ||
    pack.unpackedSize > MAX_UNPACKED_BYTES ||
    pack.files.length < 4 ||
    pack.files.length > MAX_ENTRY_COUNT
  ) {
    fail("npm pack result exceeds the release resource envelope");
  }
  const paths = new Set();
  let summedBytes = 0;
  for (const entry of pack.files) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_ENTRY_BYTES
    ) {
      fail("npm pack file has an invalid size or shape");
    }
    const path = validatePackPath(entry.path);
    if (paths.has(path)) fail("npm pack result contains duplicate paths");
    paths.add(path);
    summedBytes += entry.size;
  }
  for (const required of REQUIRED_CONNECTOR_FILES) {
    if (!paths.has(required)) fail(`npm pack result is missing ${required}`);
  }
  if (summedBytes !== pack.unpackedSize) {
    fail("npm pack unpacked byte count is inconsistent");
  }
  return Object.freeze({ paths, summedBytes });
}

function canonicalPackListing(pack) {
  return {
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    shasum: pack.shasum,
    integrity: pack.integrity,
    files: [...pack.files]
      .map((entry) => ({ path: entry.path, size: entry.size }))
      .sort((left, right) => compareCanonicalText(left.path, right.path)),
  };
}

export function assertPackIntegrity(pack, bytes) {
  const expectedShasum = digest(bytes, "sha1");
  const expectedIntegrity = `sha512-${digest(bytes, "sha512", "base64")}`;
  if (!/^[a-f0-9]{40}$/u.test(pack.shasum ?? "") || pack.shasum !== expectedShasum) {
    fail("npm pack SHA-1 does not match the tarball bytes");
  }
  if (
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(pack.integrity ?? "") ||
    pack.integrity !== expectedIntegrity
  ) {
    fail("npm pack integrity does not match the tarball bytes");
  }
  return Object.freeze({ shasum: expectedShasum, integrity: expectedIntegrity });
}

/** Fail unless two independent npm-pack attempts produced the same bytes and listing. */
export function assertDeterministicPackResults(
  firstPack,
  secondPack,
  firstBytes,
  secondBytes,
) {
  const firstDigest = sha256(firstBytes);
  const secondDigest = sha256(secondBytes);
  if (firstDigest !== secondDigest) {
    fail("independent npm pack attempts produced different tarball bytes");
  }
  assertPackIntegrity(firstPack, firstBytes);
  assertPackIntegrity(secondPack, secondBytes);
  if (
    JSON.stringify(canonicalPackListing(firstPack)) !==
    JSON.stringify(canonicalPackListing(secondPack))
  ) {
    fail("independent npm pack attempts produced different package listings");
  }
  return Object.freeze({ sha256: firstDigest });
}

export const secretPatternIndex = publicationSecretPatternIndex;

function historySecretMatches(value, environmentSecrets) {
  // History is fail-closed for every release secret pattern, including generic
  // password/token assignments. Admissions apply to exact immutable blob/path/
  // pattern tuples; environment values and commit/tag/tree metadata can never
  // be admitted.
  return publicationSecretMatches(value, environmentSecrets);
}

function environmentSecretValues(environment) {
  try {
    return publicationEnvironmentSecrets(environment);
  } catch (error) {
    fail(error instanceof Error ? error.message : "release environment is invalid");
  }
}

function publicationMode(value) {
  try {
    return normalizePublicationMode(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : "publication mode is invalid");
  }
}

function manifestSpdxLicense(manifest, options) {
  try {
    return spdxLicenseFromManifest(manifest, options);
  } catch (error) {
    fail(error instanceof Error ? error.message : "package manifest license is invalid");
  }
}

function releaseSetLicenseProfile(manifest, { mode, label }) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${label} source is invalid`);
  }
  const declaration = manifest.license;
  if (declaration === undefined) {
    return Object.freeze({
      license: manifestSpdxLicense(manifest, {
        required: mode === "public-license-preflight",
        label,
      }),
    });
  }
  if (
    typeof declaration !== "string" ||
    declaration.length < 1 || declaration.length > 256 ||
    declaration !== declaration.trim() ||
    /[\u0000-\u001f\u007f]/u.test(declaration)
  ) {
    fail(`${label} is invalid`);
  }
  if (mode === "public-license-preflight") {
    const license = manifestSpdxLicense(manifest, { required: true, label });
    if (license !== "Apache-2.0") {
      fail(`${label} must be exactly Apache-2.0 for public license preflight`);
    }
    return Object.freeze({
      license,
    });
  }
  try {
    return Object.freeze({
      license: spdxLicenseFromManifest(manifest, { label }),
    });
  } catch {
    return Object.freeze({
      license: "NOASSERTION",
      licenseComments: declaration,
    });
  }
}

function requireApprovedApache2LicenseEntry(entries, expectedPath, label) {
  const entry = entries.find(({ path, relativePath }) =>
    (relativePath ?? path) === expectedPath
  );
  if (entry === undefined) {
    fail(
      "public license preflight requires the bundled " +
      `Apache-2.0 LICENSE file in the ${label}`,
    );
  }
  if (!isApprovedApache2LicenseBytes(entry.bytes)) {
    fail(
      "public license preflight requires the exact bundled " +
      `Apache-2.0 LICENSE bytes in the ${label}`,
    );
  }
}

export function assertNoNativeMagic(bytes) {
  for (const magic of NATIVE_MAGICS) {
    if (bytes.subarray(0, magic.length).equals(magic)) {
      fail("package entry contains a forbidden native/binary file signature");
    }
  }
}

function walk(directory, prefix = "") {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) fail("packed artifact contains a symbolic link");
    if (metadata.isDirectory()) entries.push(...walk(absolute, relativePath));
    else if (metadata.isFile()) entries.push({ absolute, relativePath, size: metadata.size });
    else fail("packed artifact contains a non-file entry");
  }
  return entries;
}

export function validatePackagedManifest(
  manifest,
  expectedPackage,
  publicationModeValue = "private",
) {
  const mode = publicationMode(publicationModeValue);
  try {
    assertPublicationManifestProfile(manifest, {
      mode,
      label: "packaged manifest",
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "packaged manifest profile is invalid");
  }
  const expectedEntrypoints = {
    main: "./dist/cjs/index.js",
    module: "./dist/src/index.js",
    types: "./dist/src/index.d.ts",
    exports: {
      ".": {
        import: {
          types: "./dist/src/index.d.ts",
          default: "./dist/src/index.js",
        },
        require: {
          types: "./dist/cjs/index.d.ts",
          default: "./dist/cjs/index.js",
        },
        default: "./dist/src/index.js",
      },
      "./package.json": "./package.json",
    },
  };
  if (
    manifest.name !== expectedPackage.name ||
    manifest.version !== expectedPackage.version ||
    manifest.type !== "module" ||
    manifest.main !== expectedEntrypoints.main ||
    manifest.module !== expectedEntrypoints.module ||
    manifest.types !== expectedEntrypoints.types ||
    manifest.sideEffects !== false ||
    JSON.stringify(manifest.exports) !== JSON.stringify(expectedEntrypoints.exports) ||
    JSON.stringify(manifest.files) !== JSON.stringify(EXPECTED_CONNECTOR_PACKAGE_FILES) ||
    JSON.stringify(manifest.engines) !== JSON.stringify(EXPECTED_CONNECTOR_ENGINES)
  ) {
    fail(
      "packaged manifest identity, entrypoint, exports, files, engines, " +
      "tree-shaking contract, or publication profile changed",
    );
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
    if (value !== undefined) {
      if (
        value === null ||
        (typeof value !== "object" && !Array.isArray(value)) ||
        (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)
      ) {
        fail(`packaged manifest unexpectedly contains ${field}`);
      }
    }
  }
  for (const name of ["install", "postinstall", "preinstall"]) {
    if (manifest.scripts?.[name] !== undefined) {
      fail("packaged manifest contains a native-install lifecycle hook");
    }
  }
  if (manifest.gypfile === true || manifest.binary !== undefined) {
    fail("packaged manifest declares a native binary");
  }
}

function parsePackedJsonEntry(entries, relativePath, label) {
  const entry = entries.find((candidate) => candidate.relativePath === relativePath);
  if (entry === undefined) fail(`${label} is missing`);
  let value;
  try {
    value = JSON.parse(entry.bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  return value;
}

export function validateAuxiliaryPackageManifests(entries) {
  const cjs = parsePackedJsonEntry(
    entries,
    "dist/cjs/package.json",
    "CommonJS package manifest",
  );
  if (JSON.stringify(cjs) !== JSON.stringify({ type: "commonjs" })) {
    fail("CommonJS package manifest changed");
  }
}

export function validateConditionDeclarationParity(entries) {
  const declarations = new Map(
    entries
      .filter(({ relativePath }) =>
        /^dist\/(?:cjs|src)\/.+\.d\.ts$/u.test(relativePath))
      .map((entry) => [entry.relativePath, entry]),
  );
  const sourcePrefix = "dist/src/";
  const commonJsPrefix = "dist/cjs/";
  const sourcePaths = [...declarations.keys()]
    .filter((path) => path.startsWith(sourcePrefix))
    .sort();
  const commonJsPaths = [...declarations.keys()]
    .filter((path) => path.startsWith(commonJsPrefix))
    .sort();
  const expectedCommonJsPaths = sourcePaths.map(
    (path) => `${commonJsPrefix}${path.slice(sourcePrefix.length)}`,
  );
  if (JSON.stringify(commonJsPaths) !== JSON.stringify(expectedCommonJsPaths)) {
    fail("ESM and CommonJS declaration inventories differ");
  }
  for (const sourcePath of sourcePaths) {
    const commonJsPath = `${commonJsPrefix}${sourcePath.slice(sourcePrefix.length)}`;
    const source = declarations.get(sourcePath);
    const commonJs = declarations.get(commonJsPath);
    if (
      source === undefined ||
      commonJs === undefined ||
      !Buffer.from(source.bytes).equals(Buffer.from(commonJs.bytes))
    ) {
      fail(`ESM and CommonJS declaration bytes differ: ${sourcePath}`);
    }
  }
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    mode: stat.mode,
  });
}

function sameFileIdentity(stat, identity) {
  return (
    sameFileObject(stat, identity) &&
    stat.size === identity.size &&
    stat.mtimeNs === identity.mtimeNs &&
    stat.ctimeNs === identity.ctimeNs &&
    stat.mode === identity.mode
  );
}

function sameFileObject(stat, identity) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino
  );
}

function readStableRegularFile(path, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail(`${label} is outside its regular-file byte envelope`);
    }
    const identity = fileIdentity(before);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) fail(`${label} ended during its bounded read`);
      offset += count;
    }
    if (
      !sameFileIdentity(fstatSync(descriptor, { bigint: true }), identity) ||
      !sameFileIdentity(lstatSync(path, { bigint: true }), identity)
    ) {
      fail(`${label} changed during its bounded read`);
    }
    return Object.freeze({ bytes, identity });
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    fail(`${label} must be a stable non-symlink regular file`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The earlier bounded read failure remains authoritative.
      }
    }
  }
}

function decodeTarText(bytes, label) {
  const zero = bytes.indexOf(0);
  const value = (zero < 0 ? bytes : bytes.subarray(0, zero)).toString("utf8");
  if (value.includes("\ufffd") || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} is not canonical UTF-8 text`);
  }
  return value;
}

function decodeTarOctal(bytes, label) {
  if ((bytes[0] & 0x80) !== 0) fail(`${label} uses unsupported base-256 encoding`);
  const value = bytes.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(value)) fail(`${label} is not canonical octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} is outside range`);
  return parsed;
}

function parsePackedTarball(tarballBytes) {
  let archive;
  try {
    archive = gunzipSync(tarballBytes, { maxOutputLength: MAX_TAR_STREAM_BYTES });
  } catch {
    fail("packed tarball is not a bounded canonical gzip archive");
  }
  const entries = [];
  const paths = new Set();
  let totalBytes = 0;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!archive.subarray(offset).every((byte) => byte === 0)) {
        fail("packed tarball has data after its terminal block");
      }
      offset = archive.length;
      break;
    }
    if (entries.length >= MAX_ENTRY_COUNT) fail("packed tarball has too many entries");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== decodeTarOctal(header.subarray(148, 156), "tar checksum")) {
      fail("packed tarball header checksum is invalid");
    }
    if (header[156] !== 0 && header[156] !== 0x30) {
      fail("packed tarball may contain only regular files");
    }
    const name = decodeTarText(header.subarray(0, 100), "tar entry name");
    const prefix = decodeTarText(header.subarray(345, 500), "tar entry prefix");
    const archivePath = prefix.length === 0 ? name : `${prefix}/${name}`;
    if (!archivePath.startsWith("package/")) {
      fail("packed tarball entry is outside the package root");
    }
    const relativePath = archivePath.slice("package/".length);
    validatePackPath(relativePath);
    if (paths.has(relativePath)) fail("packed tarball contains duplicate paths");
    paths.add(relativePath);
    const size = decodeTarOctal(header.subarray(124, 136), `${relativePath} size`);
    if (size > MAX_ENTRY_BYTES) fail("tarball entry exceeds its byte limit");
    totalBytes += size;
    if (totalBytes > MAX_UNPACKED_BYTES) fail("tarball exceeds its aggregate byte limit");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) fail("packed tarball entry is truncated");
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (
      nextOffset > archive.length ||
      !archive.subarray(dataEnd, nextOffset).every((byte) => byte === 0)
    ) {
      fail("packed tarball entry padding is not canonical");
    }
    entries.push(Object.freeze({
      relativePath,
      size,
      bytes: archive.subarray(dataStart, dataEnd),
    }));
    offset = nextOffset;
  }
  if (offset !== archive.length || entries.length === 0) {
    fail("packed tarball is truncated or empty");
  }
  return Object.freeze({ archive, entries, totalBytes });
}

export function inspectPackedArtifact(tarballBytes, pack, expectedPackage, options = {}) {
  if (!Buffer.isBuffer(tarballBytes)) {
    fail("packed tarball inspection requires captured immutable bytes");
  }
  if (tarballBytes.length < 1 || tarballBytes.length > MAX_TARBALL_BYTES) {
    fail("packed tarball is outside its byte envelope");
  }
  if (tarballBytes.length !== pack.size) {
    fail("packed tarball size differs from npm pack metadata");
  }
  const parsed = parsePackedTarball(tarballBytes);
  assertReleasePackagedReadme(parsed.entries, {
    approvedHttpsTargets: OPEN_RFC_PACKAGED_README_HTTPS_TARGETS,
    readmePath: "package/README.md",
  });
  const listing = validatePackListing(pack, expectedPackage);
  const mode = publicationMode(options.publicationMode);
  const expectedSizes = new Map(pack.files.map((entry) => [entry.path, entry.size]));
  const actualPaths = new Set(parsed.entries.map((entry) => entry.relativePath));
  if (
    actualPaths.size !== listing.paths.size ||
    [...actualPaths].some((path) => !listing.paths.has(path))
  ) {
    fail("tarball entries differ from npm pack metadata");
  }
  if (mode === "public-license-preflight") {
    requireApprovedApache2LicenseEntry(
      parsed.entries,
      "LICENSE",
      "connector artifact",
    );
  }
  if (
    mode === "public-license-preflight" &&
    !hasThirdPartyNoticePath(actualPaths)
  ) {
    fail(
      "public license preflight requires a " +
      "THIRD_PARTY_NOTICES.md file in the connector artifact",
    );
  }
  const environmentSecrets = options.environmentSecrets ?? [];
  const archiveSecret = secretPatternIndex(parsed.archive, environmentSecrets);
  if (archiveSecret !== null) {
    fail(`tarball archive failed secret scan (${archiveSecret})`);
  }
  for (const entry of parsed.entries) {
    const pathSecret = secretPatternIndex(entry.relativePath, environmentSecrets);
    if (pathSecret !== null) {
      fail(`tarball entry path failed non-echoing secret scan (${pathSecret})`);
    }
    if (expectedSizes.get(entry.relativePath) !== entry.size) {
      fail("tarball entry size differs from npm pack metadata");
    }
    assertNoNativeMagic(entry.bytes);
    const secret = secretPatternIndex(entry.bytes, environmentSecrets);
    if (secret !== null) fail(`tarball entry failed secret scan (${secret})`);
  }
  if (parsed.totalBytes !== pack.unpackedSize) {
    fail("tarball aggregate size differs from npm pack metadata");
  }
  const packagedManifest = parsed.entries.find(
    ({ relativePath }) => relativePath === "package.json",
  );
  if (packagedManifest === undefined) fail("packed manifest is missing");
  validatePackagedManifest(
    JSON.parse(packagedManifest.bytes.toString("utf8")),
    expectedPackage,
    mode,
  );
  validateAuxiliaryPackageManifests(parsed.entries);
  validateConditionDeclarationParity(parsed.entries);
  return Object.freeze({
    sha256: sha256(tarballBytes),
    bytes: tarballBytes.length,
    unpackedBytes: parsed.totalBytes,
    fileCount: parsed.entries.length,
  });
}

export function validateRuntimeImportSpecifier(specifier, sourcePath) {
  if (FORBIDDEN_RUNTIME_LOADER_MODULES.has(specifier)) {
    fail(`${sourcePath} imports a forbidden runtime loader module`);
  }
  if (specifier.startsWith("node:")) {
    return specifier;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const normalizedSource = sourcePath.replaceAll("\\", "/");
    const runtimeRoot = ["dist/src", "dist/cjs", "src"].find(
      (candidate) =>
        normalizedSource === candidate || normalizedSource.startsWith(`${candidate}/`),
    );
    if (runtimeRoot === undefined) {
      fail(`${sourcePath} is outside a recognized runtime source root`);
    }
    const resolved = posix.normalize(
      posix.join(posix.dirname(normalizedSource), specifier),
    );
    if (resolved === runtimeRoot || resolved.startsWith(`${runtimeRoot}/`)) return specifier;
    fail(`${sourcePath} imports a relative path outside the runtime source root`);
  }
  fail(`${sourcePath} imports a non-runtime-allowlisted package`);
}

function literalRuntimeSpecifier(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function accessName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    return literalRuntimeSpecifier(node.argumentExpression);
  }
  return null;
}

function accessReceiver(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return null;
  }
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function bindingElementName(node) {
  const property = node.propertyName ?? node.name;
  return ts.isIdentifier(property)
    ? property.text
    : literalRuntimeSpecifier(property);
}

function scanRuntimeAst(source, sourcePath, scriptKind) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
    scriptKind,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`${sourcePath} could not be parsed by the pinned runtime-boundary scanner`);
  }
  let importCount = 0;
  let loaderCallCount = 0;

  const admitSpecifier = (node, label) => {
    const specifier = literalRuntimeSpecifier(node);
    if (specifier === null) fail(`${sourcePath} uses a non-literal ${label}`);
    validateRuntimeImportSpecifier(specifier, sourcePath);
    importCount += 1;
    return specifier;
  };

  const admitLoaderCall = (node, label) => {
    if (node.arguments.length !== 1) fail(`${sourcePath} uses a non-canonical ${label}`);
    admitSpecifier(node.arguments[0], label);
    loaderCallCount += 1;
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      admitSpecifier(node.moduleSpecifier, "static module specifier");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      admitSpecifier(node.moduleReference.expression, "import-equals module specifier");
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        admitLoaderCall(node, "dynamic import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        admitLoaderCall(node, "require call");
      } else if (
        ts.isIdentifier(node.expression) &&
        [
          "eval",
          "Function",
          "binding",
          "_linkedBinding",
          "createRequire",
          "createRequireFromPath",
        ].includes(
          node.expression.text,
        )
      ) {
        fail(`${sourcePath} invokes a forbidden runtime code-loader factory`);
      } else {
        const receiver = accessReceiver(node.expression);
        const name = accessName(node.expression);
        if (receiver === "require" && name === "resolve") {
          admitLoaderCall(node, "require.resolve call");
        } else if (receiver === "module" && name === "require") {
          admitLoaderCall(node, "module.require call");
        } else if (receiver === "process" && name === "getBuiltinModule") {
          admitLoaderCall(node, "process.getBuiltinModule call");
        } else if (
          (receiver === "process" && name === "dlopen") ||
          (receiver === "process" && ["binding", "_linkedBinding"].includes(name)) ||
          (receiver === "Module" && ["_load", "_resolveFilename"].includes(name)) ||
          (["global", "globalThis"].includes(receiver) && ["eval", "Function"].includes(name)) ||
          (["System", "SystemJS"].includes(receiver) && name === "import")
        ) {
          fail(`${sourcePath} invokes a forbidden runtime loader mechanism`);
        } else if (
          [
            "require",
            "getBuiltinModule",
            "dlopen",
            "binding",
            "_linkedBinding",
            "createRequire",
            "createRequireFromPath",
            "_load",
            "_resolveFilename",
            "registerHooks",
          ].includes(name)
        ) {
          fail(`${sourcePath} invokes an unrecognized runtime loader mechanism`);
        }
      }
    }

    if (
      ts.isNewExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "Function") ||
        (["global", "globalThis"].includes(accessReceiver(node.expression)) &&
          accessName(node.expression) === "Function"))
    ) {
      fail(`${sourcePath} constructs executable code dynamically`);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = accessReceiver(node);
      const name = accessName(node);
      const isInvokedDirectly = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (
        !isInvokedDirectly &&
        ((receiver === "require" && name === "resolve") ||
          (receiver === "module" && name === "require") ||
          (receiver === "process" && ["dlopen", "getBuiltinModule"].includes(name)) ||
          (receiver === "Module" && ["_load", "_resolveFilename"].includes(name)) ||
          (["global", "globalThis"].includes(receiver) && ["eval", "Function"].includes(name)) ||
          [
            "require",
            "getBuiltinModule",
            "dlopen",
            "binding",
            "_linkedBinding",
            "createRequire",
            "createRequireFromPath",
            "_load",
            "_resolveFilename",
            "registerHooks",
          ].includes(name))
      ) {
        fail(`${sourcePath} aliases or exposes a runtime loader mechanism`);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "process"
    ) {
      fail(`${sourcePath} aliases the process runtime namespace`);
    }
    if (
      ts.isBindingElement(node) &&
      ["binding", "_linkedBinding"].includes(bindingElementName(node))
    ) {
      fail(`${sourcePath} destructures a forbidden runtime loader mechanism`);
    }

    if (ts.isIdentifier(node) && node.text === "require") {
      const parent = node.parent;
      const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
      const isAllowedAccess =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        accessName(parent) === "resolve";
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isDirectCall && !isAllowedAccess && !isPropertyName) {
        fail(`${sourcePath} aliases or exposes the runtime require loader`);
      }
    }
    if (ts.isIdentifier(node) && node.text === "eval") {
      const parent = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isPropertyName) fail(`${sourcePath} aliases or invokes runtime eval`);
    }
    if (ts.isIdentifier(node) && node.text === "Function") {
      const parent = node.parent;
      const isTypeName = ts.isTypeReferenceNode(parent) && parent.typeName === node;
      const isNamedMember =
        ((ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isEnumMember(parent)) &&
          parent.name === node);
      if (!isTypeName && !isNamedMember) {
        fail(`${sourcePath} aliases or invokes the runtime Function constructor`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze({ importCount, loaderCallCount });
}

export function scanRuntimeImports(root = DEFAULT_ROOT, options = {}) {
  if (ts.version !== EXPECTED_TYPESCRIPT_SCANNER_VERSION) {
    fail("runtime import scanner TypeScript version differs from the pinned compiler");
  }
  const runtimeRoots = options.runtimeRoots ?? ["src"];
  if (
    !Array.isArray(runtimeRoots) ||
    runtimeRoots.length < 1 ||
    runtimeRoots.length > 3 ||
    new Set(runtimeRoots).size !== runtimeRoots.length ||
    runtimeRoots.some((runtimeRoot) => !["src", "dist/src", "dist/cjs"].includes(runtimeRoot))
  ) {
    fail("runtime import scan roots are invalid");
  }
  const digestState = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  let importCount = 0;
  let loaderCallCount = 0;
  for (const runtimeRoot of runtimeRoots) {
    const absoluteRoot = join(root, runtimeRoot);
    for (const entry of walk(absoluteRoot)) {
      const isSource = runtimeRoot === "src";
      if (
        (isSource && (!entry.relativePath.endsWith(".ts") || entry.relativePath.endsWith(".d.ts"))) ||
        (!isSource && !entry.relativePath.endsWith(".js"))
      ) {
        continue;
      }
      fileCount += 1;
      byteCount += entry.size;
      if (fileCount > MAX_RUNTIME_SCAN_FILES || byteCount > MAX_RUNTIME_SCAN_BYTES) {
        fail("runtime import scan exceeds its source resource envelope");
      }
      const sourcePath = `${runtimeRoot}/${entry.relativePath}`;
      const bytes = readFileSync(entry.absolute);
      if (bytes.length !== entry.size) fail("runtime source changed during import scanning");
      digestState.update(`${sourcePath}\0${bytes.length}\0`);
      digestState.update(bytes);
      const scanned = scanRuntimeAst(
        bytes.toString("utf8"),
        sourcePath,
        isSource ? ts.ScriptKind.TS : ts.ScriptKind.JS,
      );
      importCount += scanned.importCount;
      loaderCallCount += scanned.loaderCallCount;
    }
  }
  if (fileCount === 0) fail("runtime import scan did not find any runtime files");
  return Object.freeze({
    parser: "typescript-ast",
    compilerVersion: ts.version,
    roots: Object.freeze([...runtimeRoots]),
    fileCount,
    byteCount,
    importCount,
    loaderCallCount,
    sha256: digestState.digest("hex"),
  });
}

export function createSpdxSbom(expectedPackage, artifact, created, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(created)) {
    fail("SBOM creation time must be a canonical UTC timestamp");
  }
  if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
    fail("SBOM artifact SHA-256 is invalid");
  }
  const packageId = `SPDXRef-Package-${expectedPackage.name}-${expectedPackage.version}`
    .replaceAll(/[^A-Za-z0-9.-]/gu, "-");
  const mode = publicationMode(options.publicationMode);
  const licenseProfile = releaseSetLicenseProfile(options.manifest ?? expectedPackage, {
    mode,
    label: "connector package manifest license",
  });
  return Object.freeze({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${expectedPackage.name}@${expectedPackage.version}`,
    documentNamespace:
      `https://github.com/marianfoo/open-rfc/spdx/${expectedPackage.version}/${artifact.sha256}`,
    creationInfo: Object.freeze({
      created,
      creators: Object.freeze(["Tool: open-rfc-release-artifact-gate/1"]),
    }),
    documentDescribes: Object.freeze([packageId]),
    packages: Object.freeze([
      Object.freeze({
        name: expectedPackage.name,
        SPDXID: packageId,
        versionInfo: expectedPackage.version,
        packageFileName: artifact.filename,
        primaryPackagePurpose: "LIBRARY",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: licenseProfile.license,
        licenseDeclared: licenseProfile.license,
        ...(licenseProfile.licenseComments === undefined
          ? {}
          : { licenseComments: licenseProfile.licenseComments }),
        checksums: Object.freeze([
          Object.freeze({ algorithm: "SHA256", checksumValue: artifact.sha256 }),
        ]),
        externalRefs: Object.freeze([
          Object.freeze({
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:npm/${expectedPackage.name}@${expectedPackage.version}`,
          }),
        ]),
      }),
    ]),
    relationships: Object.freeze([
      Object.freeze({
        spdxElementId: "SPDXRef-DOCUMENT",
        relatedSpdxElement: packageId,
        relationshipType: "DESCRIBES",
      }),
    ]),
  });
}

function runPinnedNpm(toolchain, arguments_, options) {
  return run(
    toolchain.command,
    pinnedNpmArguments(toolchain, arguments_),
    options,
  );
}

export function commitTimestamp(root, commit) {
  const value = run("git", ["show", "-s", "--format=%cI", commit], {
    cwd: root,
    label: "commit timestamp",
  }).trim();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail("commit timestamp is invalid");
  return date.toISOString().replace(".000Z", "Z");
}

export function assertCleanReleaseCommit(root = DEFAULT_ROOT) {
  const status = run(
    "git",
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ],
    { cwd: root, label: "release repository status" },
  );
  if (status.length !== 0) {
    fail("repository must be clean before release evidence is bound to a commit");
  }
  const commit = run("git", ["rev-parse", "HEAD"], {
    cwd: root,
    label: "release commit",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("release commit is not a full SHA-1");
  return commit;
}

function releaseCommitTree(root, commit) {
  const tree = run("git", ["rev-parse", `${commit}^{tree}`], {
    cwd: root,
    label: "release source tree",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree)) fail("release source tree is not a full SHA-1");
  return tree;
}

/** Verify that a release worktree still represents the exact selected source. */
export function assertReleaseSnapshotBound(snapshotPath, commit, tree) {
  const snapshot = resolve(snapshotPath);
  const actualCommit = run("git", ["rev-parse", "HEAD"], {
    cwd: snapshot,
    label: "release snapshot commit",
  }).trim();
  const actualTree = releaseCommitTree(snapshot, actualCommit);
  if (actualCommit !== commit || actualTree !== tree) {
    fail("release snapshot is not bound to the selected commit and source tree");
  }
  const status = run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: snapshot, label: "release snapshot status" },
  );
  if (status.length !== 0) {
    fail("release snapshot tracked source changed while building the artifact");
  }
  return Object.freeze({ path: snapshot, commit: actualCommit, tree: actualTree });
}

/** Materialize an independent, ignored-output-free worktree at an exact commit. */
export function createCleanReleaseSnapshot(
  root,
  snapshotPath,
  commit,
  expectedTree = releaseCommitTree(root, commit),
) {
  const sourceRoot = resolve(root);
  const snapshot = resolve(snapshotPath);
  if (existsSync(snapshot)) fail("release snapshot destination must not already exist");
  mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
  let added = false;
  try {
    run("git", ["worktree", "add", "--detach", "--quiet", snapshot, commit], {
      cwd: sourceRoot,
      label: "release snapshot creation",
    });
    added = true;
    run("git", ["clean", "-ffdx"], {
      cwd: snapshot,
      label: "release snapshot ignored-output cleanup",
    });
    const bound = assertReleaseSnapshotBound(snapshot, commit, expectedTree);
    if (existsSync(join(snapshot, "dist"))) {
      fail("release snapshot must begin with an empty dist path");
    }
    return Object.freeze({ ...bound, distEmptyBeforeBuild: true });
  } catch (error) {
    if (added) {
      // The shared cleanup path also prunes stale administrative metadata if
      // Git cannot remove a partially prepared worktree itself.
      removeReleaseSourceSnapshot(sourceRoot, snapshot);
    }
    throw error;
  }
}

function removeReleaseSourceSnapshot(root, snapshotPath) {
  const snapshot = resolve(snapshotPath);
  try {
    run("git", ["worktree", "remove", "--force", snapshot], {
      cwd: root,
      label: "release snapshot cleanup",
      timeout: 30_000,
    });
  } catch {
    rmSync(snapshot, { recursive: true, force: true });
    try {
      run("git", ["worktree", "prune"], {
        cwd: root,
        label: "release snapshot metadata cleanup",
        timeout: 30_000,
      });
    } catch {
      // The temporary directory has still been removed; the next Git prune is safe.
    }
  }
}

function historyScanLimits(overrides = {}) {
  const definitions = [
    ["maxObjectCount", MAX_HISTORY_OBJECT_COUNT],
    ["maxBlobCount", MAX_HISTORY_BLOB_COUNT],
    ["maxObjectBytes", MAX_HISTORY_OBJECT_BYTES],
    ["maxTotalObjectBytes", MAX_HISTORY_TOTAL_OBJECT_BYTES],
  ];
  const limits = {};
  for (const [name, maximum] of definitions) {
    const value = overrides[name] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      fail("reachable history scan limits are invalid");
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function parseReachableObjectIds(output, limits) {
  const ids = [];
  const seen = new Set();
  let objectIdLength;
  for (const line of output.split(/\r?\n/gu)) {
    if (line.length === 0) continue;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(line)) {
      fail("reachable history returned an invalid object identifier");
    }
    objectIdLength ??= line.length;
    if (line.length !== objectIdLength || seen.has(line)) {
      fail("reachable history object enumeration is inconsistent");
    }
    seen.add(line);
    ids.push(line);
    if (ids.length > limits.maxObjectCount) {
      fail("reachable history exceeds its object-count limit");
    }
  }
  if (ids.length === 0) fail("reachable history did not contain any objects");
  return ids;
}

export function parseReachableObjectMetadata(ids, output, options = {}) {
  const limits = historyScanLimits(options);
  const lines = output.split(/\r?\n/gu).filter(Boolean);
  if (lines.length !== ids.length) {
    fail("reachable history metadata response count is inconsistent");
  }
  const objects = [];
  let blobCount = 0;
  let blobBytes = 0;
  let totalObjectBytes = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|commit|tag|tree) (\d+)$/u.exec(
      lines[index],
    );
    if (match === null || match[1] !== ids[index]) {
      fail("reachable history metadata is malformed or out of order");
    }
    const size = Number.parseInt(match[3], 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      fail("reachable history object size is invalid");
    }
    if (size > limits.maxObjectBytes) {
      fail("reachable history object exceeds its per-object byte limit");
    }
    objects.push(Object.freeze({ id: match[1], type: match[2], size }));
    totalObjectBytes += size;
    if (totalObjectBytes > limits.maxTotalObjectBytes) {
      fail("reachable history exceeds its aggregate object-byte limit");
    }
    if (match[2] !== "blob") continue;
    blobCount += 1;
    blobBytes += size;
    if (blobCount > limits.maxBlobCount) {
      fail("reachable history exceeds its blob-count limit");
    }
  }
  return Object.freeze({ objects, totalObjectBytes, blobCount, blobBytes });
}

function inspectReachableObjectMetadata(root, ids, limits) {
  const input = Buffer.from(`${ids.join("\n")}\n`);
  const output = run(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    {
      cwd: root,
      encoding: "utf8",
      input,
      maxBuffer: Math.max(1024 * 1024, ids.length * 160),
      label: "reachable history metadata scan",
    },
  );
  return parseReachableObjectMetadata(ids, output, limits);
}

function validateHistoryAdmissionPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path) > 1024 ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === "." ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.split("/").some((part) => part === ".git")
  ) {
    fail("reachable history secret admission contains an invalid path");
  }
  return path;
}

function assertHistoryPathPolicy(path, environmentSecrets) {
  validateHistoryAdmissionPath(path);
  if (FORBIDDEN_HISTORY_PATH.test(path) || FORBIDDEN_EXTENSION.test(path)) {
    fail("tracked history contains a forbidden SDK/native/capture path");
  }
  const pathSecret = secretPatternIndex(path, environmentSecrets);
  if (pathSecret !== null) {
    fail(`tracked history path failed secret scan (${pathSecret})`);
  }
  return path;
}

function historyAdmissionKey({ objectId, path, patternId }) {
  return `${objectId}\u0000${path}\u0000${patternId}`;
}

function validateHistorySecretAdmissionLedger(ledger, objectFormat) {
  try {
    validateJsonSchemaSubset(
      ledger,
      releaseHistorySecretAdmissionsSchema,
      "reachable history secret admission ledger",
    );
  } catch {
    fail("reachable history secret admission ledger does not match its v1 schema");
  }
  if (ledger.objectFormat !== objectFormat) {
    fail("reachable history secret admission ledger object format does not match Git");
  }
  if (ledger.admissions.length > MAX_HISTORY_SECRET_ADMISSIONS) {
    fail("reachable history secret admission ledger exceeds its entry limit");
  }
  const expectedObjectIdLength = objectFormat === "sha256" ? 64 : 40;
  const keys = [];
  for (const admission of ledger.admissions) {
    if (admission.objectId.length !== expectedObjectIdLength) {
      fail("reachable history secret admission contains an invalid object identifier");
    }
    validateHistoryAdmissionPath(admission.path);
    if (
      admission.rationale.length > 512 ||
      (
        admission.classification === "synthetic-fixture" &&
        admission.rationale === HISTORY_SECRET_DRAFT_RATIONALE
      ) ||
      secretPatternIndex(admission.rationale) !== null
    ) {
      fail("reachable history secret admission contains an invalid rationale");
    }
    keys.push(historyAdmissionKey(admission));
  }
  const sorted = [...keys].sort(compareCanonicalText);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key, index) => key !== sorted[index])
  ) {
    fail("reachable history secret admissions must be unique and canonically sorted");
  }
  const { approval } = ledger;
  if (approval.status === "accepted") {
    for (const value of [approval.reviewedBy, approval.reviewReference]) {
      if (
        value.length > 512 ||
        /^(?:draft|none|pending|self|tbd|unknown)$/iu.test(value.trim()) ||
        secretPatternIndex(value) !== null
      ) {
        fail("reachable history secret admission approval metadata is invalid");
      }
    }
    let normalizedTimestamp;
    try {
      normalizedTimestamp = new Date(approval.reviewedAt).toISOString();
    } catch {
      fail("reachable history secret admission approval timestamp is invalid");
    }
    if (normalizedTimestamp !== approval.reviewedAt.replace(/Z$/u, ".000Z")) {
      fail("reachable history secret admission approval timestamp is invalid");
    }
  }
  return ledger;
}

export function validateHistorySecretAdmissionLedgerDocument(
  root,
  ledger,
  { requireAccepted = false, environmentSecrets = [] } = {},
) {
  const repository = resolve(root);
  const objectFormat = run(
    "git",
    ["rev-parse", "--show-object-format"],
    {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 128,
      label: "reachable history admission document object-format check",
    },
  ).trim();
  if (!new Set(["sha1", "sha256"]).has(objectFormat)) {
    fail("reachable history admission document uses an unsupported Git object format");
  }
  validateHistorySecretAdmissionLedger(ledger, objectFormat);
  for (const admission of ledger.admissions) {
    if (secretPatternIndex(admission.rationale, environmentSecrets) !== null) {
      fail("reachable history secret admission contains an invalid rationale");
    }
  }
  if (ledger.approval.status === "accepted") {
    for (const value of [
      ledger.approval.reviewedBy,
      ledger.approval.reviewReference,
    ]) {
      if (secretPatternIndex(value, environmentSecrets) !== null) {
        fail("reachable history secret admission approval metadata is invalid");
      }
    }
  }
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(ledger, undefined, 2)}\n`);
  if (serializedBytes === 0 || serializedBytes >= MAX_HISTORY_SECRET_ADMISSION_BYTES) {
    fail("reachable history admission document exceeds its byte limit");
  }
  if (
    requireAccepted &&
    (
      ledger.approval.status !== "accepted" ||
      ledger.admissions.some(
        ({ classification }) => classification !== "synthetic-fixture",
      )
    )
  ) {
    fail("reviewed reachable history admission document is not accepted");
  }
  return ledger;
}

export function readHistorySecretAdmissionLedger(root, commit) {
  const objectFormat = run("git", ["rev-parse", "--show-object-format"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128,
    label: "reachable history object-format check",
  }).trim();
  if (!new Set(["sha1", "sha256"]).has(objectFormat)) {
    fail("reachable history uses an unsupported Git object format");
  }
  const listing = run(
    "git",
    ["ls-tree", "-z", commit, "--", HISTORY_SECRET_ADMISSION_PATH],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 4096,
      label: "reachable history secret admission ledger lookup",
    },
  );
  if (listing.length === 0) {
    return Object.freeze({
      path: HISTORY_SECRET_ADMISSION_PATH,
      sha256: null,
      status: "absent",
      approval: null,
      admissions: Object.freeze([]),
    });
  }
  const match = /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\u0000]+)\u0000$/u.exec(
    listing.toString("utf8"),
  );
  if (match === null || match[3] !== HISTORY_SECRET_ADMISSION_PATH) {
    fail("reachable history secret admission ledger must be one regular tracked file");
  }
  const bytes = run("git", ["cat-file", "blob", match[2]], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: MAX_HISTORY_SECRET_ADMISSION_BYTES,
    label: "reachable history secret admission ledger read",
  });
  if (bytes.length === 0 || bytes.length >= MAX_HISTORY_SECRET_ADMISSION_BYTES) {
    fail("reachable history secret admission ledger has an invalid byte length");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) {
    fail("reachable history secret admission ledger is not valid UTF-8");
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch {
    fail("reachable history secret admission ledger is not valid JSON");
  }
  validateHistorySecretAdmissionLedger(ledger, objectFormat);
  return Object.freeze({
    path: HISTORY_SECRET_ADMISSION_PATH,
    sha256: sha256(bytes),
    status: ledger.approval.status,
    approval: Object.freeze({ ...ledger.approval }),
    admissions: Object.freeze(ledger.admissions.map((entry) => Object.freeze({ ...entry }))),
  });
}

function reachableObjectBatchResponseBytes(object) {
  return Buffer.byteLength(
    `${object.id} ${object.type} ${object.size}\n`,
    "ascii",
  ) + object.size + 1;
}

export function planReachableObjectContentBatches(
  objects,
  maximumResponseBytes = MAX_HISTORY_CONTENT_BATCH_BYTES,
) {
  if (
    !Array.isArray(objects) ||
    objects.length === 0 ||
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > MAX_HISTORY_CONTENT_BATCH_BYTES
  ) {
    fail("reachable history object-content batch options are invalid");
  }
  const batches = [];
  let batch = [];
  let batchObjectBytes = 0;
  let batchResponseBytes = 0;
  const finishBatch = () => {
    if (batch.length === 0) return;
    batches.push(Object.freeze({
      objects: Object.freeze(batch),
      objectBytes: batchObjectBytes,
      responseBytes: batchResponseBytes,
    }));
    batch = [];
    batchObjectBytes = 0;
    batchResponseBytes = 0;
  };
  for (const object of objects) {
    if (
      typeof object !== "object" ||
      object === null ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(object.id) ||
      !new Set(["blob", "commit", "tag", "tree"]).has(object.type) ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      object.size > MAX_HISTORY_OBJECT_BYTES
    ) {
      fail("reachable history object-content batch contains invalid metadata");
    }
    const responseBytes = reachableObjectBatchResponseBytes(object);
    if (responseBytes > maximumResponseBytes) {
      fail("reachable history object exceeds its content-batch output limit");
    }
    if (
      batch.length > 0 &&
      batchResponseBytes + responseBytes > maximumResponseBytes
    ) {
      finishBatch();
    }
    batch.push(object);
    batchObjectBytes += object.size;
    batchResponseBytes += responseBytes;
  }
  finishBatch();
  return Object.freeze(batches);
}

function scanReachableObjectBatch(output, objects, environmentSecrets) {
  let cursor = 0;
  const findings = [];
  for (const object of objects) {
    const headerEnd = output.indexOf(0x0a, cursor);
    if (headerEnd < cursor) fail("reachable history object response is truncated");
    const header = output.subarray(cursor, headerEnd).toString("ascii");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|commit|tag|tree) (\d+)$/u.exec(
      header,
    );
    if (
      match === null ||
      match[1] !== object.id ||
      match[2] !== object.type ||
      Number.parseInt(match[3], 10) !== object.size
    ) {
      fail("reachable history object response is malformed or out of order");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + object.size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      fail("reachable history object response is truncated");
    }
    const content = output.subarray(contentStart, contentEnd);
    const matches = historySecretMatches(content, environmentSecrets);
    if (matches.environmentSecret) {
      fail("reachable history object failed secret scan (environment-secret)");
    }
    if (matches.patternIds.length > 0) {
      if (object.type !== "blob") {
        fail(`reachable history object failed secret scan (${matches.patternIds[0]})`);
      }
      findings.push(Object.freeze({
        objectId: object.id,
        objectSha256: sha256(content),
        patternIds: matches.patternIds,
      }));
    }
    cursor = contentEnd + 1;
  }
  if (cursor !== output.length) {
    fail("reachable history object response contains unexpected trailing bytes");
  }
  return Object.freeze(findings);
}

export function scanReachableObjectContentBatches(
  objects,
  totalObjectBytes,
  environmentSecrets,
  readBatch,
  maximumResponseBytes = MAX_HISTORY_CONTENT_BATCH_BYTES,
) {
  if (typeof readBatch !== "function") {
    fail("reachable history object-content batch reader is invalid");
  }
  const findings = [];
  let scannedObjectCount = 0;
  let scannedObjectBytes = 0;
  for (const batch of planReachableObjectContentBatches(
    objects,
    maximumResponseBytes,
  )) {
    for (let index = 0; index < batch.objects.length; index += 1) {
      if (batch.objects[index] !== objects[scannedObjectCount + index]) {
        fail("reachable history object-content batch order is inconsistent");
      }
    }
    const output = readBatch(batch);
    if (!Buffer.isBuffer(output)) {
      fail("reachable history object-content batch response is not bytes");
    }
    if (output.length !== batch.responseBytes) {
      fail("reachable history object-content batch response length is inconsistent");
    }
    findings.push(...scanReachableObjectBatch(
      output,
      batch.objects,
      environmentSecrets,
    ));
    scannedObjectCount += batch.objects.length;
    scannedObjectBytes += batch.objectBytes;
  }
  if (
    scannedObjectCount !== objects.length ||
    scannedObjectBytes !== totalObjectBytes
  ) {
    fail("reachable history object-content batch coverage is inconsistent");
  }
  return Object.freeze(findings);
}

function scanReachableObjectContents(root, objects, totalObjectBytes, environmentSecrets) {
  return scanReachableObjectContentBatches(
    objects,
    totalObjectBytes,
    environmentSecrets,
    (batch) => {
      const input = Buffer.from(`${batch.objects.map(({ id }) => id).join("\n")}\n`);
      return run("git", ["cat-file", "--batch"], {
        cwd: root,
        encoding: "buffer",
        input,
        maxBuffer: batch.responseBytes,
        label: "reachable history object-content batch scan",
      });
    },
  );
}

function splitNulDelimited(buffer) {
  const values = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const end = buffer.indexOf(0x00, cursor);
    if (end < cursor) {
      fail("reachable history raw path response is truncated");
    }
    values.push(buffer.subarray(cursor, end));
    cursor = end + 1;
  }
  return values;
}

function historicalPathsForSecretObjects(
  root,
  objectIds,
  environmentSecrets,
  revisionObjectIds,
) {
  const occurrencesByObject = new Map([...objectIds].map((id) => [id, new Map()]));
  if (occurrencesByObject.size === 0) return occurrencesByObject;
  const output = run(
    "git",
    [
      "log",
      "--format=",
      "--raw",
      "-m",
      "--root",
      "--no-abbrev",
      "--no-renames",
      "-z",
      ...revisionObjectIds,
      "--",
    ],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: MAX_HISTORY_PATH_CHANGE_BYTES,
      label: "reachable history secret object path inventory",
    },
  );
  const tokens = splitNulDelimited(output);
  if (tokens.length % 2 !== 0) {
    fail("reachable history raw path response is malformed");
  }
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index].toString("ascii");
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z][0-9]*)$/u.exec(
      header,
    );
    if (match === null || /^[RC]/u.test(match[5])) {
      fail("reachable history raw path response is malformed");
    }
    const pathBytes = tokens[index + 1];
    const path = pathBytes.toString("utf8");
    if (!Buffer.from(path).equals(pathBytes)) {
      fail("tracked history contains a non-UTF-8 path");
    }
    assertHistoryPathPolicy(path, environmentSecrets);
    for (const [mode, objectId] of [[match[1], match[3]], [match[2], match[4]]]) {
      const paths = occurrencesByObject.get(objectId);
      if (paths === undefined) continue;
      const modes = paths.get(path) ?? new Set();
      modes.add(mode);
      paths.set(path, modes);
    }
  }
  return occurrencesByObject;
}

function assertHistorySecretAdmissions(
  root,
  findings,
  ledger,
  environmentSecrets,
  revisionObjectIds,
) {
  if (ledger.admissions.length > 0 && ledger.status !== "accepted") {
    fail("reachable history secret admission ledger is not accepted");
  }
  if (
    ledger.status === "accepted" &&
    ledger.admissions.some(({ classification }) => classification !== "synthetic-fixture")
  ) {
    fail("accepted reachable history secret admissions must be reviewed synthetic fixtures");
  }
  const findingsByObject = new Map(findings.map((finding) => [finding.objectId, finding]));
  for (const admission of ledger.admissions) {
    const finding = findingsByObject.get(admission.objectId);
    if (
      finding === undefined ||
      finding.objectSha256 !== admission.objectSha256 ||
      !finding.patternIds.includes(admission.patternId)
    ) {
      fail("reachable history secret admission is stale or does not match its exact object");
    }
  }
  if (findings.length === 0) {
    if (ledger.admissions.length > 0) {
      fail("reachable history secret admission ledger contains unused entries");
    }
    return Object.freeze({
      policy: HISTORY_SECRET_ADMISSION_POLICY,
      ledgerPath: ledger.path,
      ledgerSha256: ledger.sha256,
      approvalStatus: ledger.status,
      admittedEntryCount: 0,
      admittedObjectCount: 0,
      reviewedBy: ledger.approval?.reviewedBy ?? null,
      reviewedAt: ledger.approval?.reviewedAt ?? null,
      reviewReference: ledger.approval?.reviewReference ?? null,
    });
  }
  const occurrencesByObject = historicalPathsForSecretObjects(
    root,
    new Set(findings.map(({ objectId }) => objectId)),
    environmentSecrets,
    revisionObjectIds,
  );
  const admissionsByKey = new Map(
    ledger.admissions.map((admission) => [historyAdmissionKey(admission), admission]),
  );
  const requiredKeys = new Set();
  for (const finding of findings) {
    const occurrences = occurrencesByObject.get(finding.objectId) ?? new Map();
    const paths = [...occurrences.keys()].sort(compareCanonicalText);
    if (paths.length === 0) {
      fail(`reachable history object failed secret scan (${finding.patternIds[0]})`);
    }
    for (const path of paths) {
      if ([...(occurrences.get(path) ?? [])].some((mode) => !/^100[0-7]{3}$/u.test(mode))) {
        fail(`reachable history object failed secret scan (${finding.patternIds[0]})`);
      }
      for (const patternId of finding.patternIds) {
        const key = historyAdmissionKey({ objectId: finding.objectId, path, patternId });
        requiredKeys.add(key);
        if (!admissionsByKey.has(key)) {
          fail(`reachable history object failed secret scan (${patternId})`);
        }
      }
    }
  }
  if (
    requiredKeys.size !== admissionsByKey.size ||
    [...admissionsByKey.keys()].some((key) => !requiredKeys.has(key))
  ) {
    fail("reachable history secret admission ledger contains unused entries");
  }
  return Object.freeze({
    policy: HISTORY_SECRET_ADMISSION_POLICY,
    ledgerPath: ledger.path,
    ledgerSha256: ledger.sha256,
    approvalStatus: ledger.status,
    admittedEntryCount: ledger.admissions.length,
    admittedObjectCount: findings.length,
    reviewedBy: ledger.approval.reviewedBy,
    reviewedAt: ledger.approval.reviewedAt,
    reviewReference: ledger.approval.reviewReference,
  });
}

function assertTrackedHistoryPaths(root, environmentSecrets, revisionObjectIds) {
  const names = run(
    "git",
    [
      "log",
      "--format=",
      "--name-only",
      "-m",
      "--root",
      "--no-renames",
      "-z",
      ...revisionObjectIds,
      "--",
    ],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      label: "tracked path history scan",
    },
  );
  for (const rawPath of names.toString("binary").split("\0").filter(Boolean)) {
    const pathBytes = Buffer.from(rawPath, "binary");
    const path = pathBytes.toString("utf8");
    if (!Buffer.from(path).equals(pathBytes)) {
      fail("tracked history contains a non-UTF-8 path");
    }
    assertHistoryPathPolicy(path, environmentSecrets);
  }
}

/**
 * Build a redaction-safe, non-authorizing draft for every admissible secret-
 * shaped blob reachable from the explicit publishable ref scope. The draft contains only
 * immutable object/content coordinates, historical paths, and stable scanner
 * pattern identifiers. It never includes matched material and it deliberately
 * leaves every classification and the ledger approval pending independent
 * review.
 */
export function createHistorySecretAdmissionDraft(
  root,
  environmentSecrets = [],
  options = {},
) {
  const repository = resolve(root);
  const publishableRefScope = readPublishableGitRefScope(repository, options.commit);
  const { refObjectInventory, revisionObjectIds } = publishableRefScope;
  const objectFormat = run(
    "git",
    ["rev-parse", "--show-object-format"],
    {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 128,
      label: "reachable history draft object-format check",
    },
  ).trim();
  if (!new Set(["sha1", "sha256"]).has(objectFormat)) {
    fail("reachable history draft uses an unsupported Git object format");
  }
  const commit = publishableRefScope.headObjectId;
  const expectedObjectIdLength = objectFormat === "sha256" ? 64 : 40;
  if (!new RegExp(`^[0-9a-f]{${expectedObjectIdLength}}$`, "u").test(commit)) {
    fail("reachable history draft commit is invalid");
  }
  const limits = historyScanLimits(options);
  const objectOutput = run(
    "git",
    ["rev-list", "--objects", "--no-object-names", "--stdin"],
    {
      cwd: repository,
      input: `${revisionObjectIds.join("\n")}\n`,
      maxBuffer: Math.max(1024 * 1024, (limits.maxObjectCount + 1) * 66 + 1024),
      label: "reachable history draft object enumeration",
    },
  );
  const ids = parseReachableObjectIds(objectOutput, limits);
  if (!ids.includes(commit)) {
    fail("reachable history draft object inventory does not contain HEAD");
  }
  const { objects, totalObjectBytes } = inspectReachableObjectMetadata(
    repository,
    ids,
    limits,
  );
  const findings = scanReachableObjectContents(
    repository,
    objects,
    totalObjectBytes,
    environmentSecrets,
  );
  assertTrackedHistoryPaths(repository, environmentSecrets, revisionObjectIds);
  const occurrencesByObject = historicalPathsForSecretObjects(
    repository,
    new Set(findings.map(({ objectId }) => objectId)),
    environmentSecrets,
    revisionObjectIds,
  );
  const admissions = [];
  for (const finding of findings) {
    const occurrences = occurrencesByObject.get(finding.objectId) ?? new Map();
    const paths = [...occurrences.keys()].sort(compareCanonicalText);
    if (paths.length === 0) {
      fail(`reachable history object failed secret scan (${finding.patternIds[0]})`);
    }
    for (const path of paths) {
      if ([...(occurrences.get(path) ?? [])].some((mode) => !/^100[0-7]{3}$/u.test(mode))) {
        fail(`reachable history object failed secret scan (${finding.patternIds[0]})`);
      }
      for (const patternId of finding.patternIds) {
        admissions.push(Object.freeze({
          objectId: finding.objectId,
          objectSha256: finding.objectSha256,
          path,
          patternId,
          classification: "unreviewed",
          rationale: HISTORY_SECRET_DRAFT_RATIONALE,
        }));
      }
    }
  }
  admissions.sort((left, right) => compareCanonicalText(
    historyAdmissionKey(left),
    historyAdmissionKey(right),
  ));
  if (admissions.length > MAX_HISTORY_SECRET_ADMISSIONS) {
    fail("reachable history secret admission draft exceeds its entry limit");
  }
  const ledger = {
    $schema: "./schemas/release-history-secret-admissions-v1.schema.json",
    schemaVersion: 1,
    policy: HISTORY_SECRET_ADMISSION_POLICY,
    objectFormat,
    approval: {
      status: "draft",
      reviewedBy: null,
      reviewedAt: null,
      reviewReference: null,
    },
    admissions,
  };
  validateHistorySecretAdmissionLedger(ledger, objectFormat);
  const serializedLedgerBytes = Buffer.byteLength(
    `${JSON.stringify(ledger, undefined, 2)}\n`,
  );
  if (
    serializedLedgerBytes === 0 ||
    serializedLedgerBytes >= MAX_HISTORY_SECRET_ADMISSION_BYTES
  ) {
    fail("reachable history secret admission draft exceeds its byte limit");
  }
  assertPublishableGitRefScope(
    readPublishableGitRefScope(repository, options.commit),
    publishableRefScope,
    "publishable Git ref scope during reachable history admission draft creation",
  );
  return Object.freeze({
    commit,
    refScopePolicy: publishableRefScope.policy,
    refObjectInventory,
    revisionObjectCount: ids.length,
    revisionObjectInventorySha256: sha256(
      Buffer.from(`${[...ids].sort(compareCanonicalText).join("\n")}\n`),
    ),
    findingObjectCount: findings.length,
    admissionCount: admissions.length,
    ledger: Object.freeze({
      ...ledger,
      approval: Object.freeze({ ...ledger.approval }),
      admissions: Object.freeze(admissions),
    }),
  });
}

/** Scan every unique raw Git object reachable from the publishable ref scope. */
export function scanTrackedHistory(root, environmentSecrets = [], options = {}) {
  const repository = resolve(root);
  const publishableRefScope = readPublishableGitRefScope(repository, options.commit);
  const { headObjectId, refObjectInventory, revisionObjectIds } = publishableRefScope;
  const limits = historyScanLimits(options);
  const admissionLedger = readHistorySecretAdmissionLedger(repository, headObjectId);
  const objectOutput = run(
    "git",
    ["rev-list", "--objects", "--no-object-names", "--stdin"],
    {
      cwd: repository,
      input: `${revisionObjectIds.join("\n")}\n`,
      maxBuffer: Math.max(1024 * 1024, (limits.maxObjectCount + 1) * 66 + 1024),
      label: "reachable history object enumeration",
    },
  );
  const ids = parseReachableObjectIds(objectOutput, limits);
  if (!ids.includes(headObjectId)) {
    fail("reachable history object inventory does not contain HEAD");
  }
  const { objects, totalObjectBytes, blobCount, blobBytes } = inspectReachableObjectMetadata(
    repository,
    ids,
    limits,
  );
  const secretFindings = scanReachableObjectContents(
    repository,
    objects,
    totalObjectBytes,
    environmentSecrets,
  );
  const secretAdmissions = assertHistorySecretAdmissions(
    repository,
    secretFindings,
    admissionLedger,
    environmentSecrets,
    revisionObjectIds,
  );
  assertTrackedHistoryPaths(repository, environmentSecrets, revisionObjectIds);
  assertPublishableGitRefScope(
    readPublishableGitRefScope(repository, options.commit),
    publishableRefScope,
    "publishable Git ref scope during tracked-history scan",
  );
  return Object.freeze({
    reachableObjectsScanned: true,
    pathsScanned: true,
    objectCount: ids.length,
    objectBytes: totalObjectBytes,
    blobCount,
    blobBytes,
    limits,
    secretAdmissions,
    refScopePolicy: publishableRefScope.policy,
    headObjectId,
    revisionObjectIds,
    refObjectInventory,
  });
}

function directoryIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  });
}

function sameDirectoryIdentity(stat, identity) {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.mode === identity.mode &&
    stat.uid === identity.uid &&
    stat.gid === identity.gid
  );
}

function pathExistsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("release publication path could not be inspected safely");
  }
}

function preparePublicationParent(requestedPath) {
  const parentPath = dirname(requestedPath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const path = realpathSync(parentPath);
  if (path !== parentPath) {
    fail("release output parent must not traverse symbolic-link components");
  }
  const information = lstatSync(path, { bigint: true });
  if (!information.isDirectory() || information.isSymbolicLink()) {
    fail("release output parent must be a non-symlink directory");
  }
  if (typeof process.getuid !== "function") {
    fail("release artifact publication is POSIX-only because owner checks are unavailable");
  }
  if (
    information.uid !== BigInt(process.getuid()) ||
    (information.mode & 0o777n) !== 0o700n
  ) {
    fail("release output parent must be private and owned by the current user");
  }
  if (pathExistsNoFollow(requestedPath)) {
    fail("release output set already exists");
  }
  return Object.freeze({ path, identity: directoryIdentity(information) });
}

function requireStableOutputDirectory(directory) {
  let information;
  try {
    information = lstatSync(directory.path, { bigint: true });
  } catch {
    fail("release output directory changed during the gate");
  }
  if (!sameDirectoryIdentity(information, directory.identity)) {
    fail("release output directory changed during the gate");
  }
}

function publicationLockPath(parent, outputPath) {
  return join(
    parent.path,
    `.${sha256(`${parent.path}\0${outputPath}`)}.open-rfc-publication.lock`,
  );
}

function publicationCoordinationEvidence(mode) {
  return Object.freeze({
    ...(mode === undefined ? {} : { mode }),
    atomicVisibility: "sibling-directory-rename",
    collisionControl: "cooperative-exclusive-lock",
    releaseHostPolicy: "posix-only",
    parentPolicy: "current-uid-mode-0700",
    trustBoundary: PUBLICATION_TRUST_BOUNDARY,
  });
}

function acquirePublicationLock(parent, outputPath) {
  requireStableOutputDirectory(parent);
  const path = publicationLockPath(parent, outputPath);
  let descriptor;
  let createdIdentity;
  let identity;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    createdIdentity = fileIdentity(fstatSync(descriptor, { bigint: true }));
    const bytes = Buffer.from(
      `${JSON.stringify({ pid: process.pid, output: basename(outputPath) })}\n`,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) fail("release publication lock write made no progress");
      offset += count;
    }
    fsyncSync(descriptor);
    identity = fileIdentity(fstatSync(descriptor, { bigint: true }));
    if (!sameFileIdentity(lstatSync(path, { bigint: true }), identity)) {
      fail("release publication lock changed while being acquired");
    }
    requireStableOutputDirectory(parent);
    fsyncDirectory(parent.path);
    return Object.freeze({ descriptor, identity, parent, path });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The acquisition failure remains authoritative.
      }
    }
    if (createdIdentity !== undefined) {
      try {
        if (sameFileObject(lstatSync(path, { bigint: true }), createdIdentity)) rmSync(path);
      } catch {
        // A changed lock is outside the cooperative same-user trust boundary.
      }
    }
    if (error instanceof ReleaseArtifactError) throw error;
    if (error?.code === "EEXIST") {
      fail("cooperative release publication lock is already held");
    }
    fail("release publication lock could not be acquired safely");
  }
}

function releasePublicationLock(lock) {
  try {
    closeSync(lock.descriptor);
    requireStableOutputDirectory(lock.parent);
    if (!sameFileIdentity(lstatSync(lock.path, { bigint: true }), lock.identity)) {
      fail("release publication lock changed before release");
    }
    rmSync(lock.path);
    fsyncDirectory(lock.parent.path);
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    fail("release publication lock could not be released safely");
  }
}

function writeExclusiveOutput(directory, name, bytes) {
  requireStableOutputDirectory(directory);
  if (
    basename(name) !== name ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    fail("release output name is unsafe");
  }
  const path = join(directory.path, name);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) fail("release output write made no progress");
      offset += count;
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    fail("release output must not already exist and must be written safely");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The preceding write result remains authoritative.
      }
    }
  }
  requireStableOutputDirectory(directory);
  const written = readStableRegularFile(
    path,
    Math.max(bytes.length, 1),
    `release output ${name}`,
  );
  if (!written.bytes.equals(bytes)) fail("release output bytes changed after write");
  return path;
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    fsyncDirectoryDescriptor(descriptor);
  } catch {
    fail("release publication directory could not be durably synchronized");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The preceding synchronization result remains authoritative.
      }
    }
  }
}

/** Publish a complete release set through one atomic directory rename. */
export function publishReleaseSetAtomically(requestedPath, files) {
  const outputPath = resolve(requestedPath);
  const outputName = basename(outputPath);
  if (outputName.length === 0 || !Array.isArray(files) || files.length < 1) {
    fail("release publication set is invalid");
  }
  const parent = preparePublicationParent(outputPath);
  const publicationLock = acquirePublicationLock(parent, outputPath);
  let stagingPath;
  let renamed = false;
  let completed = false;
  try {
    if (pathExistsNoFollow(outputPath)) fail("release output set already exists");
    stagingPath = mkdtempSync(
      join(parent.path, `.${outputName.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}.staging-`),
    );
    const stagingInformation = lstatSync(stagingPath, { bigint: true });
    const staging = Object.freeze({
      path: stagingPath,
      identity: directoryIdentity(stagingInformation),
    });
    const expectedNames = new Set();
    const expectedBytes = new Map();
    for (const file of files) {
      if (
        typeof file !== "object" ||
        file === null ||
        typeof file.name !== "string" ||
        !Buffer.isBuffer(file.bytes) ||
        expectedNames.has(file.name)
      ) {
        fail("release publication file is invalid or duplicated");
      }
      expectedNames.add(file.name);
      expectedBytes.set(file.name, file.bytes);
      writeExclusiveOutput(staging, file.name, file.bytes);
    }
    fsyncDirectory(staging.path);
    requireStableOutputDirectory(parent);
    if (pathExistsNoFollow(outputPath)) fail("release output set already exists");
    try {
      renameSync(staging.path, outputPath);
    } catch {
      fail("release output set could not be atomically published");
    }
    renamed = true;
    fsyncDirectory(parent.path);

    const finalInformation = lstatSync(outputPath, { bigint: true });
    const output = Object.freeze({
      path: outputPath,
      identity: directoryIdentity(finalInformation),
    });
    requireStableOutputDirectory(output);
    const actualNames = readdirSync(output.path).sort();
    const names = [...expectedNames].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(names)) {
      fail("published release set contains unexpected files");
    }
    const paths = Object.create(null);
    for (const name of names) {
      const bytes = expectedBytes.get(name);
      const path = join(output.path, name);
      const written = readStableRegularFile(
        path,
        Math.max(bytes.length, 1),
        `published release output ${name}`,
      );
      if (!written.bytes.equals(bytes)) {
        fail("published release output differs from its staged bytes");
      }
      paths[name] = path;
    }
    const publication = Object.freeze({
      outputDirectory: output.path,
      paths: Object.freeze(paths),
      coordination: publicationCoordinationEvidence(),
    });
    completed = true;
    return publication;
  } finally {
    try {
      if (!completed && stagingPath !== undefined) {
        rmSync(renamed ? outputPath : stagingPath, { recursive: true, force: true });
      }
    } finally {
      releasePublicationLock(publicationLock);
    }
  }
}

export function runReleaseArtifactGate(options = {}) {
  // Release generation is intentionally hosted on POSIX so UID/mode ownership
  // can be verified before publication. This does not narrow the separately
  // qualified Windows consumer/runtime support matrix for the produced package.
  if (typeof process.getuid !== "function") {
    fail("release artifact generation is POSIX-hosted; Windows is consumer-tested only");
  }
  const root = resolve(options.root ?? DEFAULT_ROOT);
  if (typeof options.commit !== "string" || !/^[0-9a-f]{40}$/u.test(options.commit)) {
    fail("release candidate commit binding is required and must be a full SHA-1");
  }
  const requestedOutputDirectory = resolve(
    options.outputDirectory ?? join(root, ".open-rfc-evidence", "release-artifact"),
  );
  const commit = assertCleanReleaseCommit(root);
  if (commit !== options.commit) {
    fail("HEAD must equal the explicitly bound release candidate commit");
  }
  const sourceRepositoryInventory = readGitRefObjectInventory(root);
  const sourceTree = releaseCommitTree(root, commit);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.scripts?.build !== EXPECTED_BUILD_SCRIPT) {
    fail("release build script drifted from the audited clean TypeScript command");
  }
  const expectedPackage = Object.freeze({
    name: packageJson.name,
    version: packageJson.version,
  });
  const sourceEnvironment = options.environment ?? process.env;
  const mode = publicationMode(options.publicationMode);
  const npmToolchain = resolvePinnedNpmToolchain({
    environment: sourceEnvironment,
  });
  if (npmToolchain.npmVersion !== PINNED_NPM_VERSION) {
    fail(`release npm toolchain must be ${PINNED_NPM_VERSION}`);
  }
  const environmentSecrets = environmentSecretValues(sourceEnvironment);
  const history = scanTrackedHistory(root, environmentSecrets, { commit });
  if (assertCleanReleaseCommit(root) !== commit) {
    fail("release source commit changed while scanning release history");
  }
  const sourceRuntimeScan = scanRuntimeImports(root);
  let dependencyRoot;
  try {
    dependencyRoot = realpathSync(join(root, "node_modules"));
    const dependencyInformation = lstatSync(dependencyRoot);
    if (!dependencyInformation.isDirectory() || dependencyInformation.isSymbolicLink()) {
      fail("release build dependencies must resolve to a directory");
    }
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    fail("release build dependencies are unavailable");
  }
  // Never place source snapshots below node_modules. TypeScript classifies
  // source files under that path as external-library code and can preserve ESM
  // syntax during the CommonJS build. Keep the worktrees in a private ignored
  // directory below the repository root (but outside node_modules), where
  // TypeScript can still resolve the reviewed shared dependency tree through
  // normal ancestor lookup. Expose the reviewed binary directory explicitly.
  // This remains non-hermetic; separate release evidence must qualify the
  // shared dependency tree and Node/npm versions.
  const attemptRoot = mkdtempSync(join(root, ".open-rfc-release-pack-"));
  let pack;
  let inspected;
  let tarballBytes;
  let connectorArchive;
  let snapshotEvidence;
  const activeSnapshots = new Set();
  try {
    const attempts = [];
    for (const label of ["first", "second"]) {
      const snapshotPath = join(attemptRoot, `worktree-${label}`);
      const snapshot = createCleanReleaseSnapshot(
        root,
        snapshotPath,
        commit,
        sourceTree,
      );
      activeSnapshots.add(snapshot.path);
      const destination = join(attemptRoot, `artifact-${label}`);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      const childHome = join(attemptRoot, `home-${label}`);
      mkdirSync(childHome, { mode: 0o700 });
      const userConfig = join(childHome, ".npmrc");
      writeFileSync(userConfig, "", { flag: "wx", mode: 0o600 });
      const baseChildEnvironment = releaseChildEnvironment(sourceEnvironment, childHome);
      const childEnvironment = {
        ...baseChildEnvironment,
        PATH: [join(dependencyRoot, ".bin"), baseChildEnvironment.PATH]
          .filter((entry) => typeof entry === "string" && entry.length > 0)
          .join(delimiter),
        NODE_PATH: dependencyRoot,
        npm_config_cache: join(attemptRoot, `npm-cache-${label}`),
        npm_config_userconfig: userConfig,
      };
      runPinnedNpm(npmToolchain, ["run", "build", "--silent"], {
        cwd: snapshot.path,
        label: `${label} isolated build`,
        env: childEnvironment,
      });
      const emittedRuntimeScan = scanRuntimeImports(snapshot.path, {
        runtimeRoots: ["dist/src", "dist/cjs"],
      });
      const packOutput = runPinnedNpm(
        npmToolchain,
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          destination,
        ],
        {
          cwd: snapshot.path,
          label: `${label} npm pack`,
          env: childEnvironment,
        },
      );
      let attemptPack;
      try {
        const parsed = JSON.parse(packOutput);
        if (!Array.isArray(parsed) || parsed.length !== 1) {
          fail(`${label} npm pack returned multiple artifacts`);
        }
        [attemptPack] = parsed;
      } catch (error) {
        if (error instanceof ReleaseArtifactError) throw error;
        fail(`${label} npm pack returned invalid JSON`);
      }
      validatePackListing(attemptPack, expectedPackage);
      const attemptPath = join(destination, attemptPack.filename);
      const attemptBytes = readStableRegularFile(
        attemptPath,
        MAX_TARBALL_BYTES,
        `${label} packed candidate`,
      ).bytes;
      assertPackIntegrity(attemptPack, attemptBytes);
      const attemptInspection = inspectPackedArtifact(
        attemptBytes,
        attemptPack,
        expectedPackage,
        { environmentSecrets, publicationMode: mode },
      );
      const attemptConnectorArchive = parseCanonicalNpmTarball(
        attemptBytes,
        CONNECTOR_ARCHIVE_ENVELOPE,
      );
      if (
        attemptConnectorArchive.sha256 !== attemptInspection.sha256 ||
        attemptConnectorArchive.fileCount !== attemptInspection.fileCount ||
        attemptConnectorArchive.unpackedBytes !== attemptInspection.unpackedBytes
      ) {
        fail("independent connector archive inspections disagree");
      }
      assertReleaseSnapshotBound(snapshot.path, commit, sourceTree);
      attempts.push({
        pack: attemptPack,
        bytes: attemptBytes,
        inspected: attemptInspection,
        connectorArchive: attemptConnectorArchive,
        source: Object.freeze({
          commit: snapshot.commit,
          tree: snapshot.tree,
          distEmptyBeforeBuild: snapshot.distEmptyBeforeBuild,
          emittedRuntimeScan,
        }),
      });
      removeReleaseSourceSnapshot(root, snapshot.path);
      activeSnapshots.delete(snapshot.path);
    }
    assertDeterministicPackResults(
      attempts[0].pack,
      attempts[1].pack,
      attempts[0].bytes,
      attempts[1].bytes,
    );
    if (
      JSON.stringify(attempts[0].source.emittedRuntimeScan) !==
      JSON.stringify(attempts[1].source.emittedRuntimeScan)
    ) {
      fail("independent builds produced different emitted runtime import scans");
    }
    pack = attempts[0].pack;
    inspected = attempts[0].inspected;
    tarballBytes = attempts[0].bytes;
    connectorArchive = attempts[0].connectorArchive;
    snapshotEvidence = Object.freeze(attempts.map(({ source }) => source));
  } finally {
    for (const snapshotPath of activeSnapshots) {
      removeReleaseSourceSnapshot(root, snapshotPath);
    }
    rmSync(attemptRoot, { recursive: true, force: true });
  }
  if (
    pack === undefined ||
    inspected === undefined ||
    tarballBytes === undefined ||
    connectorArchive === undefined ||
    snapshotEvidence?.length !== 2
  ) {
    fail("deterministic npm pack attempts did not produce an artifact");
  }
  if (sha256(tarballBytes) !== inspected.sha256) {
    fail("captured release bytes changed after immutable artifact inspection");
  }
  if (assertCleanReleaseCommit(root) !== commit) {
    fail("release source commit changed while packing the candidate");
  }
  const artifact = Object.freeze({
    filename: pack.filename,
    sha256: inspected.sha256,
    integrity: pack.integrity,
    bytes: inspected.bytes,
    unpackedBytes: inspected.unpackedBytes,
    fileCount: inspected.fileCount,
    archiveInventorySha256: connectorArchive.archiveInventorySha256,
  });
  const created = options.created ?? commitTimestamp(root, commit);
  const connectorReleaseArtifact = Object.freeze({
    package: expectedPackage,
    ...artifact,
  });
  const releaseArtifacts = Object.freeze({ connector: connectorReleaseArtifact });
  const releaseBindings = Object.freeze({ npmPackage: "open-rfc" });
  const releaseSet = Object.freeze({
    schemaVersion: 1,
    identityAlgorithm: "sha256-canonical-record-v1",
    sha256: computeReleaseSetSha256(commit, releaseArtifacts, releaseBindings),
    candidateRole: "connector",
    artifacts: releaseArtifacts,
    bindings: releaseBindings,
  });
  const sbom = createSpdxSbom(expectedPackage, artifact, created, {
    manifest: packageJson,
    publicationMode: mode,
  });
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, undefined, 2)}\n`);
  const result = Object.freeze({
    schemaVersion: 1,
    status: "passed",
    commit,
    source: Object.freeze({
      tree: sourceTree,
      repositoryInventory: sourceRepositoryInventory,
      snapshotCount: snapshotEvidence.length,
      independentWorktrees: true,
      emptyDistBeforeEachBuild: snapshotEvidence.every(
        ({ distEmptyBeforeBuild }) => distEmptyBeforeBuild,
      ),
      buildToolchain: Object.freeze({
        dependencyMode: "shared-root-node-modules",
        hermetic: false,
        independentlyInstalledPerSnapshot: false,
        npmVersion: npmToolchain.npmVersion,
      }),
      runtimeImportBoundary: Object.freeze({
        source: sourceRuntimeScan,
        emitted: snapshotEvidence.map(({ emittedRuntimeScan }) => emittedRuntimeScan),
      }),
      snapshots: snapshotEvidence,
    }),
    publication: publicationCoordinationEvidence(mode),
    history: Object.freeze({
      scanMode: "bound-commit-and-ancestor-version-tags-reachable-unique-raw-objects",
      refScopePolicy: history.refScopePolicy,
      inventoryAlgorithm: history.refObjectInventory.algorithm,
      refTipCount: history.refObjectInventory.refTipCount,
      refTipInventorySha256: history.refObjectInventory.refTipInventorySha256,
      objectInventorySha256: history.refObjectInventory.objectInventorySha256,
      objectCount: history.objectCount,
      objectBytes: history.objectBytes,
      blobCount: history.blobCount,
      blobBytes: history.blobBytes,
      limits: history.limits,
      secretAdmissions: history.secretAdmissions,
    }),
    package: expectedPackage,
    artifact,
    releaseSet,
    checks: Object.freeze({
      allowlist: true,
      cleanSourceSnapshots: true,
      deterministicPack: true,
      packageManifest: true,
      noNativeArtifacts: true,
      noSdkArtifacts: true,
      tarballSecretScan: true,
      trackedHistorySecretScan: history.reachableObjectsScanned,
      trackedHistorySecretAdmissionPolicy: true,
      trackedPathHistoryScan: history.pathsScanned,
      runtimeImportBoundary: true,
      sbom: true,
      atomicPublication: true,
      cooperativePublicationLock: true,
      privatePublicationParent: true,
      singlePackage: true,
      releaseSetInventory: true,
      atomicReleaseSet: true,
    }),
    sbom: Object.freeze({
      filename: "sbom.spdx.json",
      sha256: sha256(sbomBytes),
      artifactSha256: artifact.sha256,
      releaseSetSha256: releaseSet.sha256,
      artifactSha256s: Object.freeze({ connector: artifact.sha256 }),
    }),
  });
  try {
    validateJsonSchemaSubset(
      result,
      releaseArtifactGateSchema,
      "release artifact gate result",
    );
  } catch {
    fail("release artifact gate result does not match its v1 schema");
  }
  assertPublishableGitRefScope(
    readPublishableGitRefScope(root, history.headObjectId),
    Object.freeze({
      policy: history.refScopePolicy,
      headObjectId: history.headObjectId,
      revisionObjectIds: history.revisionObjectIds,
      refObjectInventory: history.refObjectInventory,
    }),
    "publishable Git ref scope before release publication",
  );
  assertGitRefObjectInventory(
    readGitRefObjectInventory(root),
    sourceRepositoryInventory,
    "candidate source Git ref/object inventory",
  );
  const resultBytes = Buffer.from(`${JSON.stringify(result, undefined, 2)}\n`);
  const publication = publishReleaseSetAtomically(requestedOutputDirectory, [
    { name: pack.filename, bytes: tarballBytes },
    { name: "sbom.spdx.json", bytes: sbomBytes },
    { name: "release-artifact-gate.v1.json", bytes: resultBytes },
  ]);
  const outputDirectory = publication.outputDirectory;
  const tarballPath = publication.paths[pack.filename];
  const sbomPath = publication.paths["sbom.spdx.json"];
  const resultPath = publication.paths["release-artifact-gate.v1.json"];
  return Object.freeze({
    ...result,
    outputDirectory,
    resultPath,
    tarballPath,
    sbomPath,
  });
}

/** Return the bounded, non-sensitive receipt consumed by candidate evidence. */
export function releaseArtifactCliSummary(result) {
  return Object.freeze({
    status: result.status,
    commit: result.commit,
    artifact: result.artifact,
    repositoryInventory: Object.freeze({
      ...result.source.repositoryInventory,
    }),
    releaseSet: result.releaseSet,
    checks: result.checks,
    sbom: result.sbom,
    resultPath: result.resultPath,
    sbomPath: result.sbomPath,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let outputDirectory;
    let requestedPublicationMode = "private";
    let commit;
    if (args[0] !== undefined && !args[0].startsWith("--")) {
      outputDirectory = args.shift();
    }
    let publicationModeSeen = false;
    while (args.length > 0) {
      const option = args.shift();
      const value = args.shift();
      if (value === undefined) fail(`missing value for ${option}`);
      if (option === "--publication-mode" && !publicationModeSeen) {
        requestedPublicationMode = value;
        publicationModeSeen = true;
      } else if (option === "--commit" && commit === undefined) {
        commit = value;
      } else {
        fail(`unknown or duplicate option ${option}`);
      }
    }
    if (commit === undefined) {
      fail(
        "usage: node tools/release_artifact_gate.mjs " +
        "[output-directory] --commit <full-SHA-1> " +
        "[--publication-mode private|public-license-preflight]",
      );
    }
    const result = runReleaseArtifactGate({
      commit,
      outputDirectory,
      publicationMode: requestedPublicationMode,
    });
    process.stdout.write(`${JSON.stringify(releaseArtifactCliSummary(result))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
