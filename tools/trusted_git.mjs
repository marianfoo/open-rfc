import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export class TrustedGitError extends Error {
  constructor(message) {
    super(`trusted Git: ${message}`);
    this.name = "TrustedGitError";
  }
}

function fail(message) {
  throw new TrustedGitError(message);
}

let trustedGitPath;

/** Resolve Git only from reviewed fixed system locations, never inherited PATH. */
export function resolveTrustedGitPath() {
  if (trustedGitPath !== undefined) return trustedGitPath;
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
      ]
    : ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  for (const candidate of candidates) {
    try {
      const information = lstatSync(candidate);
      if (
        !information.isSymbolicLink() &&
        information.isFile() &&
        (process.platform === "win32" || (information.mode & 0o111) !== 0)
      ) {
        trustedGitPath = realpathSync(candidate);
        return trustedGitPath;
      }
    } catch {
      // Continue through the fixed reviewed locations.
    }
  }
  fail("no executable is available at a fixed system path");
}

/** A minimal environment that cannot redirect Git to another repository or helper. */
export function trustedGitEnvironment(source = process.env) {
  const environment = {
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: process.platform === "win32" ? "C:\\" : "/",
    LANG: "C",
    LC_ALL: "C",
    PAGER: "cat",
    TZ: "UTC",
  };
  for (const name of ["COMSPEC", "PATHEXT", "SystemRoot", "WINDIR"]) {
    if (typeof source[name] === "string") environment[name] = source[name];
  }
  // Node's coverage runtime appends NODE_V8_COVERAGE to child environments.
  // Keep this fresh, minimal object extensible until execFileSync snapshots it.
  return environment;
}

/** Override local executable integrations before the selected read-only command. */
export function trustedGitArguments(root, arguments_) {
  const directory = resolve(root);
  return Object.freeze([
    "-C",
    directory,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${NULL_DEVICE}`,
    "-c",
    "core.pager=cat",
    "-c",
    "credential.helper=",
    "-c",
    "diff.external=",
    "-c",
    "protocol.file.allow=never",
    ...arguments_,
  ]);
}

/** Execute a bounded read-only Git command with a fixed binary and scrubbed environment. */
export function runTrustedGit(root, arguments_, options = {}) {
  if (!Array.isArray(arguments_) || !arguments_.every((value) => typeof value === "string")) {
    fail("arguments must be an array of strings");
  }
  const maximum = options.maxBuffer ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_OUTPUT_BYTES) {
    fail("output bound is invalid");
  }
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10 * 60_000) {
    fail("timeout is invalid");
  }
  const input = options.input;
  if (
    input !== undefined &&
    typeof input !== "string" &&
    !Buffer.isBuffer(input)
  ) {
    fail("input must be a string or Buffer");
  }
  if (input !== undefined && Buffer.byteLength(input) > MAX_OUTPUT_BYTES) {
    fail("input exceeds the bounded envelope");
  }
  const directory = resolve(root);
  try {
    return execFileSync(
      resolveTrustedGitPath(),
      trustedGitArguments(directory, arguments_),
      {
        cwd: directory,
        encoding: options.encoding === null ? null : (options.encoding ?? "utf8"),
        env: trustedGitEnvironment(options.environment),
        input,
        maxBuffer: maximum,
        timeout,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
  } catch {
    fail(`${arguments_[0] ?? "command"} failed`);
  }
}

/** Refuse legacy graft metadata that can rewrite the apparent commit graph. */
export function assertNoGitHistoryOverrides(root) {
  let response;
  try {
    response = runTrustedGit(
      root,
      ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"],
      { maxBuffer: 16 * 1024 },
    );
  } catch {
    fail("history override state could not be inspected");
  }
  if (
    !response.endsWith("\n") ||
    response.slice(0, -1).includes("\n") ||
    !isAbsolute(response.slice(0, -1))
  ) {
    fail("history override state is invalid");
  }
  const graftsPath = response.slice(0, -1);
  let metadata;
  try {
    metadata = lstatSync(graftsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("history override state could not be inspected");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 0) {
    fail("legacy Git grafts are not permitted");
  }
}
