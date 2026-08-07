import { appendFileSync } from "node:fs";
import { EOL } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePinnedNpmToolchain } from "./pinned_npm.mjs";

export class PinnedNpmEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinnedNpmEnvironmentError";
  }
}

/**
 * Persist the exact npm CLI and cache that invoked this lifecycle script for
 * later GitHub Actions steps. Requiring lifecycle-provided values prevents
 * fallback to a global CLI layout or a platform-guessed cache, while the
 * shared resolver verifies that the package is npm 11.19.0.
 */
export function recordPinnedNpmEnvironment(options = {}) {
  const environment = options.environment ?? process.env;
  const appendFile = options.appendFile ?? appendFileSync;
  const resolveToolchain = options.resolveToolchain ?? resolvePinnedNpmToolchain;
  const githubEnvironmentPath = environment.GITHUB_ENV;
  if (
    typeof githubEnvironmentPath !== "string" ||
    githubEnvironmentPath.length === 0
  ) {
    throw new PinnedNpmEnvironmentError("GITHUB_ENV is unavailable");
  }
  const invokedNpmCliPath = environment.npm_execpath;
  if (typeof invokedNpmCliPath !== "string" || invokedNpmCliPath.length === 0) {
    throw new PinnedNpmEnvironmentError("npm_execpath is unavailable");
  }
  const npmCachePath = environment.npm_config_cache;
  if (
    typeof npmCachePath !== "string" ||
    npmCachePath.length === 0 ||
    !isAbsolute(npmCachePath)
  ) {
    throw new PinnedNpmEnvironmentError(
      "npm_config_cache is unavailable or not absolute",
    );
  }
  if (/\r|\n/u.test(npmCachePath)) {
    throw new PinnedNpmEnvironmentError(
      "resolved npm CLI or cache path contains a line break",
    );
  }
  const { npmCliPath } = resolveToolchain({
    environment,
    npmCliPath: invokedNpmCliPath,
  });
  if (/\r|\n/u.test(npmCliPath)) {
    throw new PinnedNpmEnvironmentError(
      "resolved npm CLI or cache path contains a line break",
    );
  }
  appendFile(
    githubEnvironmentPath,
    `OPEN_RFC_NPM_CLI=${npmCliPath}${EOL}` +
      `npm_config_cache=${npmCachePath}${EOL}`,
    { encoding: "utf8" },
  );
  return Object.freeze({ npmCliPath, npmCachePath });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 2) {
    throw new PinnedNpmEnvironmentError(
      "this command does not accept arguments or path overrides",
    );
  }
  recordPinnedNpmEnvironment();
}
