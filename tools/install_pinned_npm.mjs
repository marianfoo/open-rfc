import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PINNED_NPM_VERSION } from "./pinned_npm.mjs";

export const PINNED_NPM_TARBALL_INTEGRITY =
  "sha512-SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export class PinnedNpmInstallError extends Error {
  constructor(message) {
    super(`pinned npm install: ${message}`);
    this.name = "PinnedNpmInstallError";
  }
}

function fail(message) {
  throw new PinnedNpmInstallError(message);
}

function identity(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].map(String).join(":");
}

function stableRegularFile(path, label, maximumBytes) {
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    fail(`${label} is missing`);
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail(`${label} must be a bounded regular non-symbolic file`);
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (identity(opened) !== identity(before)) {
      fail(`${label} changed before its descriptor was bound`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      identity(after) !== identity(opened) ||
      identity(pathAfter) !== identity(after) ||
      BigInt(bytes.length) !== after.size
    ) {
      fail(`${label} changed during its bounded read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof PinnedNpmInstallError) throw error;
    fail(`${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function npmIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function verifyPinnedNpmTarball(
  bytes,
  expectedIntegrity = PINNED_NPM_TARBALL_INTEGRITY,
) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ARCHIVE_BYTES) {
    fail("downloaded archive is outside its byte envelope");
  }
  const actualIntegrity = npmIntegrity(bytes);
  if (actualIntegrity !== expectedIntegrity) {
    fail("downloaded archive differs from the reviewed SHA-512");
  }
  return Object.freeze({
    npmVersion: PINNED_NPM_VERSION,
    integrity: actualIntegrity,
    bytes: bytes.length,
  });
}

function runNpm({ nodePath, npmCliPath, arguments_, cwd, environment }) {
  const result = spawnSync(nodePath, [npmCliPath, ...arguments_], {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail("bootstrap npm command failed");
  }
}

/**
 * Download npm as an inert registry tarball, verify its reviewed bytes, and
 * only then install that exact archive globally with lifecycle scripts off.
 */
export function installPinnedNpm(options = {}) {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? runNpm;
  const expectedIntegrity = options.expectedIntegrity ??
    PINNED_NPM_TARBALL_INTEGRITY;
  if (
    environment.OPEN_RFC_NPM_CLI_VERSION !== undefined &&
    environment.OPEN_RFC_NPM_CLI_VERSION !== PINNED_NPM_VERSION
  ) {
    fail("workflow npm version differs from the maintained pin");
  }
  const bootstrapValue = environment.npm_execpath;
  if (
    typeof bootstrapValue !== "string" ||
    bootstrapValue.length < 1 ||
    /\r|\n/u.test(bootstrapValue)
  ) {
    fail("bootstrap npm lifecycle provenance is unavailable");
  }
  let npmCliPath;
  try {
    npmCliPath = realpathSync(resolve(bootstrapValue));
  } catch {
    fail("bootstrap npm CLI is unavailable");
  }
  stableRegularFile(npmCliPath, "bootstrap npm CLI", 4 * 1024 * 1024);
  const parent = resolve(environment.RUNNER_TEMP ?? tmpdir());
  let directory;
  try {
    directory = mkdtempSync(join(parent, "open-rfc-pinned-npm-"));
  } catch {
    fail("temporary archive directory could not be created");
  }
  try {
    runner({
      nodePath: process.execPath,
      npmCliPath,
      arguments_: [
        "pack",
        `npm@${PINNED_NPM_VERSION}`,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        directory,
      ],
      cwd: directory,
      environment,
    });
    const entries = readdirSync(directory);
    if (entries.length !== 1 || !entries[0].endsWith(".tgz")) {
      fail("bootstrap npm did not produce exactly one registry tarball");
    }
    const archivePath = join(directory, entries[0]);
    const archiveBytes = stableRegularFile(
      archivePath,
      "downloaded npm archive",
      MAX_ARCHIVE_BYTES,
    );
    const verified = verifyPinnedNpmTarball(archiveBytes, expectedIntegrity);
    runner({
      nodePath: process.execPath,
      npmCliPath,
      arguments_: [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archivePath,
      ],
      cwd: directory,
      environment,
    });
    return verified;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 2) {
    fail("this command does not accept arguments or path overrides");
  }
  installPinnedNpm();
}
