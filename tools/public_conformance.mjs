#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import exportManifestSchema from
  "../conformance/schemas/api-export-manifest-v1.schema.json" with { type: "json" };
import publicApiSnapshotSchema from
  "../conformance/schemas/public-api-snapshot-v1.schema.json" with { type: "json" };
import v1RoadmapSchema from
  "../conformance/schemas/v1-gate-ledger-v1.schema.json" with { type: "json" };

import { validateJsonSchemaSubset } from "./json_schema_subset.mjs";
import { createPublicApiSnapshot } from "./public_api_snapshot.mjs";
import { validateV1Roadmap } from "./v1_roadmap.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");

export class PublicConformanceError extends Error {
  constructor(message) {
    super(`public conformance: ${message}`);
    this.name = "PublicConformanceError";
  }
}

function fail(message) {
  throw new PublicConformanceError(message);
}

async function readJson(root, relativePath) {
  let value;
  try {
    value = JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
  } catch {
    fail(`${relativePath} is missing or invalid JSON`);
  }
  return value;
}

function validate(value, schema, label) {
  try {
    validateJsonSchemaSubset(value, schema, label);
  } catch (error) {
    fail(`${label} failed its strict schema (${error.message})`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/**
 * Release Please owns the stable version. Public conformance therefore ignores
 * only packageContract.version and its version-bearing aggregate digest. Every
 * API, declaration, export, compiler, package-shape, and engine byte remains
 * strict.
 */
export function comparePublicApiSnapshotForRelease(expectedValue, actualValue) {
  const expected = structuredClone(expectedValue);
  const actual = structuredClone(actualValue);
  validate(expected, publicApiSnapshotSchema, "expected public API snapshot");
  validate(actual, publicApiSnapshotSchema, "actual public API snapshot");
  for (const value of [expected, actual]) {
    value.packageContract.version = "<release-version>";
    delete value.aggregateSha256;
  }
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(actual))) {
    fail("public API/type snapshot drifted outside release-owned version metadata");
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(actual)))
    .digest("hex");
}

/** Validate the public API, type, and roadmap contracts. */
export async function validatePublicConformance(rootValue = DEFAULT_ROOT) {
  const root = resolve(rootValue);
  const [manifest, snapshot, packageManifest, v1RoadmapDocument] = await Promise.all([
    readJson(root, "conformance/api/root-exports.v1.json"),
    readJson(root, "conformance/api/public-types.v1.json"),
    readJson(root, "package.json"),
    readJson(root, "conformance/v1-gates.v1.json"),
  ]);
  validate(manifest, exportManifestSchema, "root export manifest");
  validate(snapshot, publicApiSnapshotSchema, "public API snapshot");
  validate(v1RoadmapDocument, v1RoadmapSchema, "v1 roadmap");
  let v1Roadmap;
  try {
    v1Roadmap = validateV1Roadmap(v1RoadmapDocument);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`v1 roadmap failed its semantic contract (${detail})`);
  }
  if (
    manifest.module !== packageManifest.name ||
    snapshot.module !== packageManifest.name ||
    Object.keys(snapshot.packageContract.exports).length === 0 ||
    Object.keys(snapshot.packageContract.engines).length === 0 ||
    manifest.exports.length !== manifest.expectedExportCount ||
    new Set(manifest.exports.map(({ name }) => name)).size !== manifest.exports.length
  ) {
    fail("public API manifests do not identify one canonical package surface");
  }
  const runtime = await import(pathToFileURL(resolve(root, "dist/src/index.js")).href);
  const requireFromRoot = createRequire(pathToFileURL(resolve(root, "package.json")));
  const commonJsRuntime = requireFromRoot("./dist/cjs/index.js");
  if (
    runtime.environment?.noderfc?.version !== packageManifest.version ||
    commonJsRuntime.environment?.noderfc?.version !== packageManifest.version
  ) {
    fail("ESM or CommonJS runtime package version differs from package.json");
  }
  const expectedExports = manifest.exports.map(({ name }) => name).sort();
  if (JSON.stringify(Object.keys(runtime).sort()) !== JSON.stringify(expectedExports)) {
    fail("emitted root exports differ from the public export manifest");
  }
  const actualSnapshot = await createPublicApiSnapshot(root);
  const releaseNeutralSha256 = comparePublicApiSnapshotForRelease(snapshot, actualSnapshot);
  return Object.freeze({
    status: "passed",
    module: packageManifest.name,
    exportCount: expectedExports.length,
    declarationCount: actualSnapshot.declarationCount,
    releaseNeutralSha256,
    v1Roadmap,
  });
}

async function main(arguments_) {
  if (arguments_.length !== 0) {
    fail("usage: node tools/public_conformance.mjs");
  }
  process.stdout.write(`${JSON.stringify(await validatePublicConformance())}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "public conformance failed"}\n`);
    process.exitCode = 1;
  }
}
