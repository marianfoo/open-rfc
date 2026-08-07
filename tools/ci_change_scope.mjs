#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCUMENTATION_ONLY_PREFIXES = Object.freeze([
  "docs/",
  "docs_page/",
]);

const DOCUMENTATION_ONLY_FILES = new Set([
  ".github/workflows/pages.yml",
  "mkdocs.yml",
  "requirements-docs.txt",
]);

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const MAX_CHANGED_PATH_BYTES = 4 * 1024 * 1024;

function isSafeRepositoryPath(path) {
  return typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..") &&
    !/[\u0000-\u001f\u007f]/u.test(path);
}

export function isDocumentationOnlyPath(path) {
  if (!isSafeRepositoryPath(path)) return false;
  return DOCUMENTATION_ONLY_FILES.has(path) ||
    DOCUMENTATION_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function classifyCiChangedPaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError("changed paths must be an array");
  const normalized = [...new Set(paths)].sort();
  const product = normalized.length === 0 ||
    normalized.some((path) => !isDocumentationOnlyPath(path));
  return Object.freeze({
    schemaVersion: 1,
    product,
    changedFileCount: normalized.length,
  });
}

function validCommit(value) {
  return typeof value === "string" &&
    COMMIT_SHA.test(value) &&
    !/^0{40}$/u.test(value);
}

export function classifyCiChangeRange({
  base,
  head,
  root = process.cwd(),
  runGit = execFileSync,
} = {}) {
  if (!validCommit(base) || !validCommit(head)) {
    return Object.freeze({
      schemaVersion: 1,
      product: true,
      changedFileCount: 0,
      reason: "commit-range-unavailable",
    });
  }

  let output;
  try {
    output = runGit(
      "git",
      ["diff", "--name-only", "--no-renames", `${base}..${head}`],
      {
        cwd: resolve(root),
        encoding: "utf8",
        maxBuffer: MAX_CHANGED_PATH_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return Object.freeze({
      schemaVersion: 1,
      product: true,
      changedFileCount: 0,
      reason: "git-diff-unavailable",
    });
  }

  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_CHANGED_PATH_BYTES) {
    return Object.freeze({
      schemaVersion: 1,
      product: true,
      changedFileCount: 0,
      reason: "git-diff-invalid",
    });
  }
  const paths = output.split(/\r?\n/u).filter((path) => path.length > 0);
  return classifyCiChangedPaths(paths);
}

export function writeCiChangeScope(result, outputPath) {
  if (!result || typeof result.product !== "boolean" ||
      !Number.isSafeInteger(result.changedFileCount) || result.changedFileCount < 0) {
    throw new TypeError("CI change-scope result is invalid");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("GITHUB_OUTPUT is unavailable");
  }
  appendFileSync(
    outputPath,
    `product=${result.product}\nchanged_count=${result.changedFileCount}\n`,
    { encoding: "utf8" },
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = classifyCiChangeRange({
    base: process.env.OPEN_RFC_CI_BASE_SHA,
    head: process.env.OPEN_RFC_CI_HEAD_SHA,
  });
  writeCiChangeScope(result, process.env.GITHUB_OUTPUT);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
