import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

// Every workflow exists twice: the copy GitHub runs, and the reviewed template
// the public export is materialized from. Nothing kept them in step, and they
// drifted twice in one day — once when ci.yml gained a push trigger that the
// template never got, so the published repository ran CI on pull requests only,
// and once when release-please.yml lost its token guard on the live side alone.
//
// Both were invisible: the live copy behaves correctly, the template is what a
// fresh export would ship, and the workflow tests read the template. So an edit
// to one is silently undone by any export of the other.
const PAIRED_WORKFLOWS = Object.freeze([
  "candidate.yml",
  "ci.yml",
  "npm-publish.yml",
  "pages.yml",
  "release-please.yml",
]);

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

test("each workflow is byte-identical to the template it ships from", () => {
  for (const name of PAIRED_WORKFLOWS) {
    const template = read(`release/templates/${name}`);
    const live = read(`.github/workflows/${name}`);
    assert.equal(
      live,
      template,
      `.github/workflows/${name} and release/templates/${name} differ; ` +
        "edit both, because the template is what a public export ships and the " +
        "live copy is what actually runs",
    );
  }
});

// A workflow added to one side and not the other is the same defect wearing a
// different shape, and comparing only the pairs above would not notice it.
test("neither side carries a workflow the other does not", () => {
  const live = readdirSync(resolve(ROOT, ".github/workflows"))
    .filter((name) => name.endsWith(".yml"))
    .sort();
  const templated = readdirSync(resolve(ROOT, "release/templates"))
    .filter((name) => name.endsWith(".yml") && live.includes(name))
    .sort();
  assert.deepEqual(live, [...PAIRED_WORKFLOWS].sort(), "unpaired live workflow");
  assert.deepEqual(templated, live, "a live workflow has no template");
});
