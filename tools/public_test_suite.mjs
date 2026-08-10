#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");
const MAX_TEST_FILES = 512;

export class PublicTestSuiteError extends Error {
  constructor(message) {
    super(`public test suite: ${message}`);
    this.name = "PublicTestSuiteError";
  }
}

function fail(message) {
  throw new PublicTestSuiteError(message);
}

async function regularFile(root, relativePath) {
  let metadata;
  try {
    metadata = await lstat(resolve(root, relativePath));
  } catch {
    fail(`required test is missing: ${relativePath}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`required test is not a regular file: ${relativePath}`);
  }
  return relativePath;
}

/** Discover every test file of one kind, as regular files, sorted and bounded. */
async function discover(root, directory, suffix) {
  let entries;
  try {
    entries = await readdir(resolve(root, directory), { withFileTypes: true });
  } catch {
    fail(`${directory} is unavailable; run the public build first`);
  }
  const found = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
  if (found.length === 0 || found.length > MAX_TEST_FILES) {
    fail(`${directory} test inventory is empty or outside its bound`);
  }
  return found;
}

/**
 * Resolve the complete suite: compiled product tests plus source-only tests.
 *
 * Both kinds are discovered rather than listed. A hand-maintained inventory of
 * the `.mjs` tests used to sit here, and it drifted immediately and silently:
 * `ci-change-scope.test.mjs` was absent from it from the first published commit,
 * so a test that passes was never once run by the suite that claims to run
 * everything. Discovery cannot drift, and the compiled half already worked this
 * way -- the asymmetry was the whole defect.
 */
export async function publicTestFiles(rootValue = DEFAULT_ROOT) {
  const root = resolve(rootValue);
  const compiled = await discover(root, "dist/test", ".test.js");
  const source = await discover(root, "test", ".test.mjs");
  for (const relativePath of source) await regularFile(root, relativePath);
  return Object.freeze([...compiled, ...source]);
}

async function runNodeTests(root, paths) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ["--test", ...paths], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new PublicTestSuiteError(`Node test runner terminated by ${signal}`));
      } else if (code !== 0) {
        reject(new PublicTestSuiteError(`Node test runner exited with ${code}`));
      } else {
        accept();
      }
    });
  });
}

export async function runPublicTestSuite(rootValue = DEFAULT_ROOT) {
  const root = resolve(rootValue);
  const paths = await publicTestFiles(root);
  await runNodeTests(root, paths);
  return Object.freeze({
    status: "passed",
    compiledTests: paths.filter((path) => path.startsWith("dist/test/")).length,
    publicSourceTests: paths.filter((path) => path.endsWith(".test.mjs")).length,
  });
}

async function main(arguments_) {
  if (arguments_.length !== 0) fail("usage: node tools/public_test_suite.mjs");
  process.stdout.write(`${JSON.stringify(await runPublicTestSuite())}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "public test suite failed"}\n`);
    process.exitCode = 1;
  }
}
