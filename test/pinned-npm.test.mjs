import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PINNED_NPM_ENGINE_RANGE,
  PINNED_NPM_VERSION,
  pinnedNpmArguments,
  resolvePinnedNpmToolchain,
} from "../tools/pinned_npm.mjs";

function fixture(
  version = PINNED_NPM_VERSION,
  engines = PINNED_NPM_ENGINE_RANGE,
) {
  const root = mkdtempSync(join(tmpdir(), "open-rfc-pinned-npm-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "npm",
    version,
    engines: { node: engines },
  })}\n`);
  const cli = join(bin, "npm-cli.js");
  writeFileSync(cli, `process.stdout.write(${JSON.stringify(`${version}\n`)})\n`);
  chmodSync(cli, 0o700);
  return { root, cli };
}

test("resolves only the explicit reviewed npm CLI and returns an argv prefix", () => {
  const exact = fixture();
  const wrong = fixture("11.6.2");
  const wrongEngines = fixture(PINNED_NPM_VERSION, ">=22");
  try {
    const toolchain = resolvePinnedNpmToolchain({ npmCliPath: exact.cli });
    assert.equal(toolchain.npmVersion, PINNED_NPM_VERSION);
    assert.equal(toolchain.npmCliPath, realpathSync(exact.cli));
    assert.deepEqual(
      pinnedNpmArguments(toolchain, ["pack", "--json"]),
      [realpathSync(exact.cli), "pack", "--json"],
    );
    assert.throws(
      () => resolvePinnedNpmToolchain({ npmCliPath: wrong.cli }),
      /must be npm 11\.19\.0|reviewed npm 11\.19\.0 CLI is unavailable/u,
    );
    assert.throws(
      () => resolvePinnedNpmToolchain({ npmCliPath: wrongEngines.cli }),
      /with Node engines \^20\.17\.0 \|\| >=22\.9\.0/u,
    );
  } finally {
    rmSync(exact.root, { recursive: true, force: true });
    rmSync(wrong.root, { recursive: true, force: true });
    rmSync(wrongEngines.root, { recursive: true, force: true });
  }
});
