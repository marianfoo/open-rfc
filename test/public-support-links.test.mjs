import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const support = readFileSync(new URL("../SUPPORT.md", import.meta.url), "utf8");

function localMarkdownTargets(source) {
  return [...source.matchAll(/\]\((?!https?:\/\/|mailto:|#)([^)#?]+)(?:#[^)]*)?\)/gu)]
    .map((match) => match[1]);
}

test("keeps public support links inside the public export documentation surface", () => {
  assert.deepEqual(
    [...new Set(localMarkdownTargets(support))].sort(),
    ["SECURITY.md", "docs_page/operations.md", "docs_page/status.md"],
  );
  assert.doesNotMatch(support, /(?:^|\()docs\//mu);
  assert.doesNotMatch(support, /(?:^|\()conformance\//mu);
});
