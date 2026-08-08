import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  V1RoadmapError,
  checkV1RoadmapDocumentation,
  renderPublicV1Roadmap,
  validateV1Roadmap,
} from "../tools/v1_roadmap.mjs";
import { validateJsonSchemaSubset } from "../tools/json_schema_subset.mjs";

const ledger = JSON.parse(await readFile("conformance/v1-gates.v1.json", "utf8"));
const schema = JSON.parse(
  await readFile("conformance/schemas/v1-gate-ledger-v1.schema.json", "utf8"),
);

test("the v1 roadmap is schema-valid, complete, and fully assessed", () => {
  validateJsonSchemaSubset(ledger, schema, "v1 roadmap");
  const summary = validateV1Roadmap(ledger);

  assert.equal(summary.gateCount, 7);
  assert.ok(summary.itemCount >= 35);
  assert.equal(summary.unassessedItemCount, 0);
  assert.equal(summary.statuses.proposed, summary.itemCount);
  assert.ok(summary.requiredEstimate.personDays.minimum > 0);
  assert.ok(
    summary.requiredEstimate.personDays.maximum >=
      summary.requiredEstimate.personDays.minimum,
  );
  assert.ok(summary.conditionalItemCount >= 4);
});

test("the seven stable-release outcomes are covered by required work", () => {
  const summary = validateV1Roadmap(ledger);
  assert.deepEqual(summary.requiredOutcomes, [
    "consecutive-clean-candidates",
    "stable-api-and-policies",
    "twenty-four-hour-soaks",
    "linux-node-consumers",
    "production-like-adopters",
    "reproducible-assurance",
    "operations-readiness",
  ]);
});

test("every work item exposes reviewable importance, risk, and effort", () => {
  for (const gate of ledger.gates) {
    assert.ok(gate.exitCriteria.length >= 2, gate.id);
    for (const item of gate.workItems) {
      assert.match(item.importance.rationale, /\S/u, item.id);
      assert.match(item.risk.summary, /\S/u, item.id);
      assert.ok(item.risk.mitigations.length >= 1, item.id);
      assert.ok(item.effort.personDays.minimum >= 1, item.id);
      assert.ok(
        item.effort.personDays.maximum >= item.effort.personDays.minimum,
        item.id,
      );
      assert.match(item.effort.drivers, /\S/u, item.id);
      assert.ok(item.deliverables.length >= 1, item.id);
      assert.ok(item.acceptanceCriteria.length >= 2, item.id);
    }
  }
});

test("the public roadmap is generated from the machine ledger", async () => {
  const expected = renderPublicV1Roadmap(ledger);
  const actual = await readFile("docs_page/roadmap.md", "utf8");
  assert.equal(actual, expected);
  await assert.doesNotReject(() => checkV1RoadmapDocumentation());
});

test("the validator rejects incomplete assessments and dependency cycles", () => {
  const missingRisk = structuredClone(ledger);
  missingRisk.gates[0].workItems[0].risk.mitigations = [];
  assert.throws(() => validateV1Roadmap(missingRisk), V1RoadmapError);

  const cycle = structuredClone(ledger);
  const first = cycle.gates[0].workItems[0];
  const second = cycle.gates[0].workItems[1];
  first.dependsOn = [second.id];
  second.dependsOn = [first.id];
  assert.throws(() => validateV1Roadmap(cycle), /dependency cycle/u);
});

test("conditional route work cannot silently become a required v1 gate", () => {
  const conditional = ledger.gates
    .flatMap((gate) => gate.workItems)
    .filter((item) => item.releaseRequirement === "conditional");

  assert.ok(conditional.length >= 4);
  for (const item of conditional) {
    assert.match(item.condition, /scope decision/iu, item.id);
  }
});
