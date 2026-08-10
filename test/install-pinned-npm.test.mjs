import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installPinnedNpm,
  PinnedNpmInstallError,
  verifyPinnedNpmTarball,
} from "../tools/install_pinned_npm.mjs";

function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "open-rfc-install-npm-test-"));
  const bootstrap = join(root, "npm-cli.js");
  writeFileSync(bootstrap, "// synthetic bootstrap\n");
  return { root, bootstrap };
}

test("the CI bootstrap verifies one exact archive before installing it", (t) => {
  const { root, bootstrap } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from("synthetic reviewed npm archive");
  const calls = [];
  const result = installPinnedNpm({
    environment: {
      npm_execpath: bootstrap,
      RUNNER_TEMP: root,
      OPEN_RFC_NPM_CLI_VERSION: "11.19.0",
    },
    expectedIntegrity: integrity(archive),
    runner(call) {
      calls.push(call);
      if (call.arguments_[0] === "pack") {
        const output = call.arguments_[call.arguments_.indexOf("--pack-destination") + 1];
        writeFileSync(join(output, "npm-11.19.0.tgz"), archive);
      } else {
        const path = call.arguments_.at(-1);
        assert.deepEqual(readFileSync(path), archive);
      }
    },
  });

  assert.equal(result.npmVersion, "11.19.0");
  assert.equal(result.integrity, integrity(archive));
  assert.deepEqual(calls.map((call) => call.arguments_[0]), ["pack", "install"]);
  assert.deepEqual(readdirSync(root), ["npm-cli.js"]);
  assert.ok(calls[1].arguments_.includes("--ignore-scripts"));
});

test("a different registry tarball is never installed", (t) => {
  const { root, bootstrap } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  assert.throws(
    () => installPinnedNpm({
      environment: { npm_execpath: bootstrap, RUNNER_TEMP: root },
      expectedIntegrity: integrity(Buffer.from("expected")),
      runner(call) {
        calls.push(call.arguments_[0]);
        if (call.arguments_[0] === "pack") {
          const output = call.arguments_[call.arguments_.indexOf("--pack-destination") + 1];
          writeFileSync(join(output, "npm-11.19.0.tgz"), "different");
        }
      },
    }),
    new PinnedNpmInstallError(
      "downloaded archive differs from the reviewed SHA-512",
    ),
  );
  assert.deepEqual(calls, ["pack"]);
  assert.deepEqual(readdirSync(root), ["npm-cli.js"]);
});

test("archive verification is bounded and exact", () => {
  const bytes = Buffer.from("reviewed");
  assert.equal(
    verifyPinnedNpmTarball(bytes, integrity(bytes)).integrity,
    integrity(bytes),
  );
  assert.throws(
    () => verifyPinnedNpmTarball(Buffer.alloc(0), integrity(Buffer.alloc(0))),
    /outside its byte envelope/u,
  );
});

test("the maintained workflow version cannot drift from the installer", (t) => {
  const { root, bootstrap } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => installPinnedNpm({
      environment: {
        npm_execpath: bootstrap,
        RUNNER_TEMP: root,
        OPEN_RFC_NPM_CLI_VERSION: "12.0.1",
      },
      runner() {
        assert.fail("version drift must fail before registry access");
      },
    }),
    /workflow npm version differs/u,
  );
});
