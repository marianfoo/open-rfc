import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  checkPublicApiSnapshot,
  createPublicApiSnapshot,
} from "../tools/public_api_snapshot.mjs";

const root = resolve(import.meta.dirname, "..");

async function fixture() {
  const path = await mkdtemp(resolve(tmpdir(), "open-rfc-api-"));
  for (const directory of [
    "conformance/api",
    "dist/src",
    "node_modules/typescript",
  ]) {
    await mkdir(resolve(path, directory), { recursive: true });
  }
  await copyFile(resolve(root, "package.json"), resolve(path, "package.json"));
  await copyFile(
    resolve(root, "conformance/api/root-exports.v1.json"),
    resolve(path, "conformance/api/root-exports.v1.json"),
  );
  await copyFile(
    resolve(root, "node_modules/typescript/package.json"),
    resolve(path, "node_modules/typescript/package.json"),
  );
  await cp(resolve(root, "dist/src"), resolve(path, "dist/src"), {
    recursive: true,
    force: true,
  });
  return path;
}

test("tracked public declaration snapshot matches the emitted package API", async () => {
  const snapshot = await checkPublicApiSnapshot(root);
  assert.equal(snapshot.declarationCount > 0, true);
  assert.match(snapshot.aggregateSha256, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.declarations.some(({ path }) => path === "dist/src/index.d.ts"), true);
  assert.deepEqual(snapshot.subpathExportManifests, []);
});

test("snapshot is deterministic and detects declaration drift", async (t) => {
  const path = await fixture();
  t.after(() => rm(path, { recursive: true, force: true }));
  const first = await createPublicApiSnapshot(path);
  const second = await createPublicApiSnapshot(path);
  assert.deepEqual(second, first);
  await writeFile(
    resolve(path, "conformance/api/public-types.v1.json"),
    `${JSON.stringify(first, null, 2)}\n`,
  );
  await checkPublicApiSnapshot(path);
  const declaration = resolve(path, "dist/src/index.d.ts");
  await writeFile(declaration, `${await readFile(declaration, "utf8")}\nexport {};\n`);
  await assert.rejects(
    checkPublicApiSnapshot(path),
    /public API\/type snapshot drifted/u,
  );
});
