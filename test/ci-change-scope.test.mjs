import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyCiChangedPaths,
  classifyCiChangeRange,
  isDocumentationOnlyPath,
  writeCiChangeScope,
} from "../tools/ci_change_scope.mjs";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

test("routes only the bounded documentation inventory away from product CI", () => {
  for (const path of [
    "docs/operations.md",
    "docs/generated/beta-gates.md",
    "docs_page/index.md",
    ".github/workflows/pages.yml",
    "mkdocs.yml",
    "requirements-docs.txt",
  ]) {
    assert.equal(isDocumentationOnlyPath(path), true, path);
  }
  for (const path of [
    "README.md",
    "package.json",
    "src/index.ts",
    "tools/docs_site.mjs",
    "test/docs-site.test.mjs",
    ".github/workflows/development.yml",
    "docs/../src/index.ts",
    "/docs/index.md",
    "docs\\index.md",
  ]) {
    assert.equal(isDocumentationOnlyPath(path), false, path);
  }
});

test("fails safe for empty, mixed, malformed, or unavailable changes", () => {
  assert.equal(classifyCiChangedPaths([]).product, true);
  assert.equal(classifyCiChangedPaths(["docs/index.md"]).product, false);
  assert.equal(
    classifyCiChangedPaths(["docs/index.md", "src/index.ts"]).product,
    true,
  );
  assert.equal(classifyCiChangedPaths(["docs/../src/index.ts"]).product, true);
  assert.equal(classifyCiChangeRange({ base: "0".repeat(40), head: HEAD }).product, true);
  assert.equal(classifyCiChangeRange({ base: BASE, head: "invalid" }).product, true);
  assert.equal(
    classifyCiChangeRange({
      base: BASE,
      head: HEAD,
      runGit() {
        throw new Error("unavailable");
      },
    }).product,
    true,
  );
});

test("uses a no-renames bounded Git diff and classifies its complete path set", () => {
  let invocation;
  const result = classifyCiChangeRange({
    base: BASE,
    head: HEAD,
    root: ".",
    runGit(command, arguments_, options) {
      invocation = { command, arguments_, options };
      return "docs/index.md\ndocs_page/status.md\n";
    },
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    product: false,
    changedFileCount: 2,
  });
  assert.equal(invocation.command, "git");
  assert.deepEqual(invocation.arguments_, [
    "diff",
    "--name-only",
    "--no-renames",
    `${BASE}..${HEAD}`,
  ]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.equal(invocation.options.stdio[2], "ignore");
});

test("writes only bounded non-sensitive routing facts to GITHUB_OUTPUT", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-rfc-ci-scope-"));
  t.after(() => import("node:fs/promises").then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));
  const output = join(directory, "github-output");

  writeCiChangeScope({ product: false, changedFileCount: 3 }, output);
  assert.equal(await readFile(output, "utf8"), "product=false\nchanged_count=3\n");
  assert.throws(() => writeCiChangeScope({ product: "false", changedFileCount: 3 }, output));
  assert.equal(readFileSync(output, "utf8"), "product=false\nchanged_count=3\n");
});
