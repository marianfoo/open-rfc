import assert from "node:assert/strict";
import { EOL } from "node:os";
import test from "node:test";

import {
  PinnedNpmEnvironmentError,
  recordPinnedNpmEnvironment,
} from "../tools/record_pinned_npm_env.mjs";

test("the GitHub environment recorder validates and records the invoking npm CLI", () => {
  const environment = {
    GITHUB_ENV: "/runner/environment",
    npm_execpath: "/reviewed/npm/bin/npm-cli.js",
    npm_config_cache: "/reviewed/npm-cache",
  };
  const writes = [];
  const result = recordPinnedNpmEnvironment({
    environment,
    resolveToolchain(options) {
      assert.equal(options.environment, environment);
      assert.equal(options.npmCliPath, environment.npm_execpath);
      return { npmCliPath: "/canonical/npm/bin/npm-cli.js" };
    },
    appendFile(path, data, options) {
      writes.push({ path, data, options });
    },
  });

  assert.deepEqual(result, {
    npmCliPath: "/canonical/npm/bin/npm-cli.js",
    npmCachePath: "/reviewed/npm-cache",
  });
  assert.deepEqual(writes, [{
    path: environment.GITHUB_ENV,
    data: `OPEN_RFC_NPM_CLI=/canonical/npm/bin/npm-cli.js${EOL}` +
      `npm_config_cache=/reviewed/npm-cache${EOL}`,
    options: { encoding: "utf8" },
  }]);
});

test("the GitHub environment recorder requires the workflow environment file", () => {
  assert.throws(
    () => recordPinnedNpmEnvironment({
      environment: {
        npm_execpath: "/reviewed/npm-cli.js",
        npm_config_cache: "/reviewed/npm-cache",
      },
      resolveToolchain() {
        assert.fail("the resolver must not run without GITHUB_ENV");
      },
    }),
    new PinnedNpmEnvironmentError("GITHUB_ENV is unavailable"),
  );
});

test("the GitHub environment recorder requires npm lifecycle provenance", () => {
  assert.throws(
    () => recordPinnedNpmEnvironment({
      environment: { GITHUB_ENV: "/runner/environment" },
      resolveToolchain() {
        assert.fail("the resolver must not fall back to a global npm layout");
      },
    }),
    new PinnedNpmEnvironmentError("npm_execpath is unavailable"),
  );
});

test("the GitHub environment recorder requires an exact absolute npm cache", () => {
  for (const npm_config_cache of [undefined, "", "relative-cache"]) {
    assert.throws(
      () => recordPinnedNpmEnvironment({
        environment: {
          GITHUB_ENV: "/runner/environment",
          npm_execpath: "/reviewed/npm-cli.js",
          ...(npm_config_cache === undefined ? {} : { npm_config_cache }),
        },
        resolveToolchain() {
          assert.fail("the resolver must not run without an exact npm cache");
        },
      }),
      new PinnedNpmEnvironmentError(
        "npm_config_cache is unavailable or not absolute",
      ),
    );
  }
});

test("the GitHub environment recorder rejects command-file injection", () => {
  assert.throws(
    () => recordPinnedNpmEnvironment({
      environment: {
        GITHUB_ENV: "/runner/environment",
        npm_execpath: "/reviewed/npm-cli.js",
        npm_config_cache: "/reviewed/npm-cache",
      },
      resolveToolchain() {
        return { npmCliPath: "/reviewed/npm-cli.js\nINJECTED=value" };
      },
      appendFile() {
        assert.fail("an unsafe value must not be written");
      },
    }),
    new PinnedNpmEnvironmentError(
      "resolved npm CLI or cache path contains a line break",
    ),
  );
});

test("the GitHub environment recorder rejects npm cache command-file injection", () => {
  assert.throws(
    () => recordPinnedNpmEnvironment({
      environment: {
        GITHUB_ENV: "/runner/environment",
        npm_execpath: "/reviewed/npm-cli.js",
        npm_config_cache: "/reviewed/npm-cache\nINJECTED=value",
      },
      resolveToolchain() {
        assert.fail("the resolver must not run with an unsafe cache path");
      },
      appendFile() {
        assert.fail("an unsafe value must not be written");
      },
    }),
    new PinnedNpmEnvironmentError(
      "resolved npm CLI or cache path contains a line break",
    ),
  );
});
