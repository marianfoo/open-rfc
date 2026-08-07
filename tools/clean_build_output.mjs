#!/usr/bin/env node

import {
  lstat,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_OUTPUT_ENTRIES = 10_000;
const EXPECTED_PACKAGE_NAME = "open-rfc";
// tsconfig.json emits declarations and JavaScript without external maps;
// tsconfig.cjs.json emits CommonJS declarations and JavaScript. Keep these
// roots explicit so a
// recognized compiler artifact cannot survive merely because its source does.
const OUTPUT_ROOTS = Object.freeze(new Map([
  [
    "src",
    Object.freeze({
      sourceRootName: "src",
      permittedSuffixes: Object.freeze([".d.ts", ".js"]),
    }),
  ],
  [
    "test",
    Object.freeze({
      sourceRootName: "test",
      permittedSuffixes: Object.freeze([".d.ts", ".js"]),
    }),
  ],
  [
    "cjs",
    Object.freeze({
      sourceRootName: "src",
      permittedSuffixes: Object.freeze([".d.ts", ".js"]),
    }),
  ],
]));
const GENERATED_OUTPUT_SUFFIXES = Object.freeze([
  ".d.ts.map",
  ".d.ts",
  ".js.map",
  ".js",
]);

class BuildOutputCleanError extends Error {
  constructor(message) {
    super(message);
    this.name = "BuildOutputCleanError";
  }
}

function fail(message) {
  throw new BuildOutputCleanError(message);
}

async function metadata(path, unavailableMessage) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail(unavailableMessage);
  }
}

async function repositoryRoot() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const root = await realpath(resolve(scriptDirectory, ".."));
  const manifestPath = join(root, "package.json");
  const manifestMetadata = await metadata(
    manifestPath,
    "repository identity manifest is unavailable",
  );
  if (
    manifestMetadata === undefined ||
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    manifestMetadata.size > MAX_MANIFEST_BYTES
  ) {
    fail("repository identity manifest is not a bounded regular file");
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("repository identity manifest is not valid JSON");
  }
  if (manifest?.name !== EXPECTED_PACKAGE_NAME || manifest?.type !== "module") {
    fail("repository identity does not match the open-rfc module workspace");
  }
  return root;
}

function classifyGeneratedOutput(root, outputRoot, outputPath) {
  const outputContract = OUTPUT_ROOTS.get(outputRoot);
  if (outputContract === undefined) fail("build output contains an unknown root");
  const outputBase = join(root, "dist", outputRoot);
  const pathWithinOutput = relative(outputBase, outputPath);
  if (
    pathWithinOutput.length === 0 ||
    pathWithinOutput === ".." ||
    pathWithinOutput.startsWith(`..${sep}`) ||
    pathWithinOutput.includes(`${sep}..${sep}`)
  ) {
    fail("build output path escaped its bounded root");
  }
  const suffix = GENERATED_OUTPUT_SUFFIXES.find((candidate) =>
    pathWithinOutput.endsWith(candidate)
  );
  if (suffix === undefined) {
    if (outputRoot === "cjs" && pathWithinOutput === "package.json") {
      return undefined;
    }
    fail("build output contains a non-generated file");
  }
  const stem = pathWithinOutput.slice(0, -suffix.length);
  if (stem.length === 0) fail("build output contains an invalid generated path");
  return Object.freeze({
    permitted: outputContract.permittedSuffixes.includes(suffix),
    sourcePath: join(root, outputContract.sourceRootName, `${stem}.ts`),
  });
}

async function removeOrphan(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("orphan build output could not be removed");
  }
}

async function pruneOutputTree(root, outputRoot, directory, budget) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("build output directory could not be read safely");
  }
  for (const entry of entries) {
    budget.count += 1;
    if (budget.count > MAX_OUTPUT_ENTRIES) {
      fail("build output entry count exceeds the safe bound");
    }
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail("build output contains a symlink; refusing to traverse it");
    }
    if (entry.isDirectory()) {
      await pruneOutputTree(root, outputRoot, path, budget);
      continue;
    }
    if (!entry.isFile()) fail("build output contains a non-regular entry");
    const generatedOutput = classifyGeneratedOutput(root, outputRoot, path);
    if (generatedOutput === undefined) continue;
    if (!generatedOutput.permitted) {
      await removeOrphan(path);
      continue;
    }
    const sourceMetadata = await metadata(
      generatedOutput.sourcePath,
      "generated output source metadata could not be read safely",
    );
    if (sourceMetadata === undefined) {
      await removeOrphan(path);
      continue;
    }
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      fail("generated output source is not a regular source file");
    }
  }
}

async function cleanBuildOutput() {
  if (process.argv.length !== 2) {
    fail("this command does not accept arguments or path overrides");
  }

  const root = await repositoryRoot();
  const output = join(root, "dist");
  if (dirname(output) !== root || basename(output) !== "dist") {
    fail("build output is not the exact repository-root dist directory");
  }
  const outputMetadata = await metadata(
    output,
    "build output metadata could not be read safely",
  );
  if (outputMetadata === undefined) return;
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
    fail("build output exists but is not a real directory; refusing to modify it");
  }

  const budget = { count: 0 };
  let roots;
  try {
    roots = await readdir(output, { withFileTypes: true });
  } catch {
    fail("build output directory could not be read safely");
  }
  for (const entry of roots) {
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !OUTPUT_ROOTS.has(entry.name)
    ) {
      fail("build output contains an unknown or unsafe root entry");
    }
    await pruneOutputTree(root, entry.name, join(output, entry.name), budget);
  }
}

try {
  await cleanBuildOutput();
} catch (error) {
  const message =
    error instanceof BuildOutputCleanError
      ? error.message
      : "unexpected bounded cleanup failure";
  process.stderr.write(`open-rfc build cleanup failed: ${message}\n`);
  process.exitCode = 1;
}
