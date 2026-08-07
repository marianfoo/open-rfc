import { execFileSync } from "node:child_process";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PINNED_NPM_VERSION = "11.19.0";
export const PINNED_NPM_ENGINE_RANGE = "^20.17.0 || >=22.9.0";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const VERSION_TIMEOUT_MS = 30_000;

export class PinnedNpmError extends Error {
  constructor(message) {
    super(`pinned npm: ${message}`);
    this.name = "PinnedNpmError";
  }
}

function candidatePaths(environment, nodePath, explicitPath) {
  if (explicitPath !== undefined) return [explicitPath];
  if (environment.OPEN_RFC_NPM_CLI !== undefined) {
    return [environment.OPEN_RFC_NPM_CLI];
  }
  return [
    environment.npm_execpath,
    resolve(dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js"),
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    process.platform === "win32"
      ? join(dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js")
      : undefined,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function inspectCandidate(candidate) {
  const npmCliPath = realpathSync(resolve(candidate));
  const cli = statSync(npmCliPath);
  if (!cli.isFile()) throw new PinnedNpmError("CLI is not a regular file");
  const manifestPath = resolve(dirname(npmCliPath), "../package.json");
  const manifestStat = statSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size < 1 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new PinnedNpmError("package manifest is outside its byte bound");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.name !== "npm" ||
    manifest.version !== PINNED_NPM_VERSION ||
    manifest.engines?.node !== PINNED_NPM_ENGINE_RANGE
  ) {
    throw new PinnedNpmError(
      `CLI package must be npm ${PINNED_NPM_VERSION} with Node engines ${PINNED_NPM_ENGINE_RANGE}`,
    );
  }
  return npmCliPath;
}

/**
 * Resolve the reviewed npm package as data, never through PATH command lookup.
 * An explicit path is fail-closed; implicit candidates may be skipped until the
 * exact package installed by CI or the caller is found.
 */
export function resolvePinnedNpmToolchain(options = {}) {
  const environment = options.environment ?? process.env;
  const requestedNodePath = options.nodePath ?? process.execPath;
  const nodePath = realpathSync(resolve(requestedNodePath));
  if (!statSync(nodePath).isFile()) {
    throw new PinnedNpmError("Node executable is not a regular file");
  }
  const explicit = options.npmCliPath !== undefined ||
    environment.OPEN_RFC_NPM_CLI !== undefined;
  let lastError;
  for (const candidate of candidatePaths(
    environment,
    nodePath,
    options.npmCliPath,
  )) {
    try {
      const npmCliPath = inspectCandidate(candidate);
      const npmVersion = execFileSync(nodePath, [npmCliPath, "--version"], {
        cwd: dirname(npmCliPath),
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_VERSION_OUTPUT_BYTES,
        timeout: VERSION_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (npmVersion !== PINNED_NPM_VERSION) {
        throw new PinnedNpmError(`CLI reported ${JSON.stringify(npmVersion)}`);
      }
      return Object.freeze({
        command: nodePath,
        argumentsPrefix: Object.freeze([npmCliPath]),
        nodePath,
        npmCliPath,
        npmVersion,
      });
    } catch (error) {
      lastError = error;
      if (explicit) break;
    }
  }
  const detail = lastError instanceof Error
    ? ` (${lastError.message.replaceAll(/\s+/gu, " ").slice(0, 200)})`
    : "";
  throw new PinnedNpmError(
    `the reviewed npm ${PINNED_NPM_VERSION} CLI is unavailable${detail}`,
  );
}

export function pinnedNpmArguments(toolchain, arguments_) {
  if (!Array.isArray(arguments_) || !arguments_.every(value => typeof value === "string")) {
    throw new PinnedNpmError("arguments must be an array of strings");
  }
  return [...toolchain.argumentsPrefix, ...arguments_];
}
