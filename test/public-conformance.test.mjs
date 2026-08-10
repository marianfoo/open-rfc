import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  PublicConformanceError,
  comparePublicApiSnapshotForRelease,
} from "../tools/public_conformance.mjs";

const DIGEST = "a".repeat(64);
const snapshot = Object.freeze({
  schemaVersion: 1,
  module: "open-rfc",
  packageContract: Object.freeze({
    name: "open-rfc",
    version: "0.2.0-beta.1",
    type: "module",
    main: "./dist/cjs/index.js",
    module: "./dist/src/index.js",
    types: "./dist/src/index.d.ts",
    sideEffects: false,
    exports: Object.freeze({ ".": "./dist/src/index.js" }),
    files: Object.freeze(["dist/src"]),
    engines: Object.freeze({ node: "^22.14.0 || ^24.0.0" }),
  }),
  compiler: Object.freeze({ name: "typescript", version: "5.9.3" }),
  rootExportManifest: Object.freeze({ path: "conformance/api/root-exports.v1.json", bytes: 1, sha256: DIGEST }),
  subpathExportManifests: Object.freeze([]),
  declarationCount: 1,
  declarations: Object.freeze([
    Object.freeze({ path: "dist/src/index.d.ts", bytes: 1, sha256: DIGEST }),
  ]),
  aggregateSha256: DIGEST,
});

test("public conformance admits only release-owned version and aggregate drift", () => {
  const stable = structuredClone(snapshot);
  stable.packageContract.version = "0.2.0";
  stable.aggregateSha256 = "b".repeat(64);
  assert.match(comparePublicApiSnapshotForRelease(snapshot, stable), /^[a-f0-9]{64}$/u);

  const declarationDrift = structuredClone(stable);
  declarationDrift.declarations[0].sha256 = "c".repeat(64);
  assert.throws(
    () => comparePublicApiSnapshotForRelease(snapshot, declarationDrift),
    PublicConformanceError,
  );

  const packageDrift = structuredClone(stable);
  packageDrift.packageContract.exports = { ".": "./different.js" };
  assert.throws(
    () => comparePublicApiSnapshotForRelease(snapshot, packageDrift),
    /outside release-owned version metadata/u,
  );
});

test("release-owned runtime version stays widened in emitted declarations", async () => {
  const declaration = await readFile(
    resolve(import.meta.dirname, "../dist/src/compat/node-rfc-client.d.ts"),
    "utf8",
  );
  assert.match(declaration, /\bnoderfc: Readonly<\{[\s\S]*?version: string;/u);
  assert.doesNotMatch(declaration, /version: "0\.2\.0(?:-beta\.1)?";/u);
});
