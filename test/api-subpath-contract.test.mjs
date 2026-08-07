import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootManifest = JSON.parse(
  readFileSync(
    new URL("../conformance/api/root-exports.v1.json", import.meta.url),
  ),
);
const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);

function names(manifest) {
  return manifest.exports.map(({ name }) => name).sort();
}

test("the package exposes one stable root API and package metadata only", async () => {
  assert.equal(rootManifest.expectedExportCount, 31);
  assert.equal(
    rootManifest.exports.every(({ stability }) => stability === "stable"),
    true,
  );
  const root = await import("../dist/src/index.js");
  assert.deepEqual(Object.keys(root).sort(), names(rootManifest));
  assert.deepEqual(Object.keys(packageManifest.exports).sort(), [
    ".",
    "./package.json",
  ]);
});

test("low-level protocol, value, transport, and session APIs are not exported", () => {
  const rootNames = new Set(names(rootManifest));
  for (const name of [
    "DirectCpicSession",
    "WebSocketRfcPreviewConnection",
    "connectWebSocketRfcPreview",
    "connectSapRouterRoute",
    "connectConnectivitySocks5Tunnel",
    "buildWebSocketRfcUpgradeRequest",
    "RecursiveSerializerClassificationError",
  ]) {
    assert.equal(rootNames.has(name), false, name);
  }
  assert.deepEqual(packageManifest.files, [
    "dist/src",
    "dist/cjs",
    "README.md",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
  ]);
});
