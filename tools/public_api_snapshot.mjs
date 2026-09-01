#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT_PATH = "conformance/api/public-types.v1.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return value.replaceAll("\r\n", "\n");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function declarationPaths(directory) {
  const result = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".d.ts")) result.push(child);
    }
  }
  await visit(directory);
  return result.sort();
}

function stablePackageContract(packageJson) {
  return {
    name: packageJson.name,
    type: packageJson.type,
    main: packageJson.main,
    module: packageJson.module,
    types: packageJson.types,
    sideEffects: packageJson.sideEffects,
    exports: packageJson.exports,
    files: packageJson.files,
    engines: packageJson.engines,
  };
}

export async function createPublicApiSnapshot(root = DEFAULT_ROOT) {
  const packageJsonPath = resolve(root, "package.json");
  const exportManifestPaths = ["conformance/api/root-exports.v1.json"];
  const declarationRoot = resolve(root, "dist/src");
  const packageJson = await readJson(packageJsonPath);
  const typescriptJson = await readJson(
    resolve(root, "node_modules/typescript/package.json"),
  );
  const exportManifestDigests = [];
  for (const manifestPath of exportManifestPaths) {
    const bytes = Buffer.from(
      normalizeText(await readFile(resolve(root, manifestPath), "utf8")),
      "utf8",
    );
    exportManifestDigests.push({
      path: manifestPath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const declarations = [];
  for (const path of await declarationPaths(declarationRoot)) {
    const bytes = Buffer.from(normalizeText(await readFile(path, "utf8")), "utf8");
    declarations.push({
      path: relative(root, path).split(sep).join("/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  if (declarations.length === 0) {
    throw new Error("public API snapshot needs emitted declarations under dist/src");
  }
  const packageContract = stablePackageContract(packageJson);
  const compiler = {
    name: "typescript",
    version: typescriptJson.version,
  };
  const [rootExportManifest, ...subpathExportManifests] = exportManifestDigests;
  if (rootExportManifest === undefined) {
    throw new Error("public API snapshot needs the root export manifest");
  }
  const aggregateInput = JSON.stringify({
    packageContract,
    compiler,
    rootExportManifest,
    subpathExportManifests,
    declarations,
  });
  return {
    schemaVersion: 1,
    module: packageJson.name,
    packageContract,
    compiler,
    rootExportManifest,
    subpathExportManifests,
    declarationCount: declarations.length,
    declarations,
    aggregateSha256: sha256(aggregateInput),
  };
}

export async function checkPublicApiSnapshot(root = DEFAULT_ROOT) {
  const expected = await readJson(resolve(root, SNAPSHOT_PATH));
  const actual = await createPublicApiSnapshot(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "public API/type snapshot drifted; review the declarations and run " +
        "`node tools/public_api_snapshot.mjs write` intentionally",
    );
  }
  return actual;
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (command === "write") {
    const snapshot = await createPublicApiSnapshot();
    const path = resolve(DEFAULT_ROOT, SNAPSHOT_PATH);
    await stat(dirname(path));
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
    process.stdout.write(
      `${JSON.stringify({ valid: true, written: SNAPSHOT_PATH, aggregateSha256: snapshot.aggregateSha256 })}\n`,
    );
    return;
  }
  if (command !== "check") {
    throw new Error("usage: node tools/public_api_snapshot.mjs [check|write]");
  }
  const snapshot = await checkPublicApiSnapshot();
  process.stdout.write(
    `${JSON.stringify({ valid: true, declarationCount: snapshot.declarationCount, aggregateSha256: snapshot.aggregateSha256 })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
