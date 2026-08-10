#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");
const MAX_TEST_FILES = 512;
export const PUBLIC_MJS_TESTS = Object.freeze([
  "test/api-subpath-contract.test.mjs",
  "test/build-output-clean.test.mjs",
  "test/directory-fsync.test.mjs",
  "test/dual-loader-error-brand.test.mjs",
  "test/offline-network-guard.test.mjs",
  "test/packaged-readme-links.test.mjs",
  "test/public-hosted-platform-evidence.test.mjs",
  "test/public-release-workflows.test.mjs",
  "test/public-support-links.test.mjs",
  "test/runnable-examples.test.mjs",
  "test/tool-bounds.test.mjs",
  "test/trusted-git.test.mjs",
]);

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

/** Resolve the complete compiled product suite plus the reviewed public-only source tests. */
export async function publicTestFiles(rootValue = DEFAULT_ROOT) {
  const root = resolve(rootValue);
  let compiled;
  try {
    compiled = (await readdir(resolve(root, "dist/test"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".test.js"))
      .map((entry) => `dist/test/${entry.name}`)
      .sort();
  } catch {
    fail("compiled product tests are unavailable; run the public build first");
  }
  if (compiled.length === 0 || compiled.length > MAX_TEST_FILES) {
    fail("compiled product test inventory is empty or outside its bound");
  }
  const source = [];
  for (const relativePath of PUBLIC_MJS_TESTS) {
    source.push(await regularFile(root, relativePath));
  }
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
    publicSourceTests: PUBLIC_MJS_TESTS.length,
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
