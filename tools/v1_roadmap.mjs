#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(TOOL_DIRECTORY, "..");
const LEDGER_PATH = "conformance/v1-gates.v1.json";
const OUTPUT_PATH = "docs_page/roadmap.md";
const SCHEMA_PATH = "./schemas/v1-gate-ledger-v1.schema.json";

const GATE_IDS = Object.freeze(
  Array.from({ length: 7 }, (_, index) => `V1-${String(index).padStart(2, "0")}`),
);
const GATE_DEPENDENCIES = Object.freeze(Object.fromEntries(
  GATE_IDS.map((id, index) => [id, index === 0 ? [] : [GATE_IDS[index - 1]]]),
));
const STATUSES = Object.freeze([
  "proposed",
  "accepted",
  "in-progress",
  "blocked",
  "done",
  "deferred",
]);
const IMPORTANCE = Object.freeze(["critical", "high", "medium", "low"]);
const RISK = Object.freeze(["critical", "high", "medium", "low"]);
const EFFORT = Object.freeze(["XS", "S", "M", "L", "XL"]);
const CONFIDENCE = Object.freeze(["high", "medium", "low"]);
const RELEASE_REQUIREMENT = Object.freeze(["required", "conditional", "post-v1"]);
const EXECUTION_KIND = Object.freeze([
  "decision",
  "implementation",
  "evidence",
  "policy",
  "external",
  "release",
]);
const RISK_DOMAINS = Object.freeze([
  "correctness",
  "security",
  "compatibility",
  "operations",
  "schedule",
  "external-dependency",
  "scope",
  "supply-chain",
]);
const OWNER_KINDS = Object.freeze([
  "maintainer",
  "release-owner",
  "independent-reviewer",
  "sap-operator",
  "adopter",
  "repository-admin",
]);
const REQUIRED_OUTCOMES = Object.freeze([
  "consecutive-clean-candidates",
  "stable-api-and-policies",
  "twenty-four-hour-soaks",
  "linux-node-consumers",
  "production-like-adopters",
  "reproducible-assurance",
  "operations-readiness",
]);
const REQUIRED_CONDITIONAL_ROUTES = Object.freeze([
  "roadmap.v1-01.message-server-qualification",
  "roadmap.v1-01.saprouter-qualification",
  "roadmap.v1-01.websocket-promotion",
  "roadmap.v1-01.cloud-connector-promotion",
]);
const ITEM_ID = /^roadmap\.v1-(0[0-6])\.[a-z0-9][a-z0-9.-]+$/u;

export class V1RoadmapError extends Error {
  constructor(message) {
    super(message);
    this.name = "V1RoadmapError";
  }
}

function fail(message) {
  throw new V1RoadmapError(message);
}

function record(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function string(value, path, minimum = 1) {
  if (typeof value !== "string" || value.trim().length < minimum) {
    fail(`${path} must be a string with at least ${minimum} non-whitespace characters`);
  }
  if (value.includes("\r") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail(`${path} contains a control character`);
  }
  return value;
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${path} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function exactKeys(value, keys, path) {
  const object = record(value, path);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) fail(`${path}.${key} is required`);
  }
  return object;
}

function exactArray(value, expected, path) {
  const values = array(value, path);
  if (
    values.length !== expected.length ||
    values.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${path} must equal ${JSON.stringify(expected)}`);
  }
  return values;
}

function unique(values, path, identity = (value) => value) {
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const id = identity(values[index]);
    if (seen.has(id)) fail(`${path}[${index}] duplicates ${String(id)}`);
    seen.add(id);
  }
  return seen;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) fail(`${path} contains unsupported value ${String(value)}`);
  return value;
}

function stringArray(value, path, { minimum = 1, allowed } = {}) {
  const values = array(value, path);
  if (values.length < minimum) fail(`${path} must contain at least ${minimum} entries`);
  unique(values, path);
  values.forEach((entry, index) => {
    string(entry, `${path}[${index}]`);
    if (allowed !== undefined) enumValue(entry, allowed, `${path}[${index}]`);
  });
  return values;
}

function validateAssessment(item, path) {
  const importance = exactKeys(
    item.importance,
    ["level", "rationale"],
    `${path}.importance`,
  );
  enumValue(importance.level, IMPORTANCE, `${path}.importance.level`);
  string(importance.rationale, `${path}.importance.rationale`, 20);

  const risk = exactKeys(
    item.risk,
    ["level", "summary", "domains", "mitigations"],
    `${path}.risk`,
  );
  enumValue(risk.level, RISK, `${path}.risk.level`);
  string(risk.summary, `${path}.risk.summary`, 20);
  stringArray(risk.domains, `${path}.risk.domains`, { allowed: RISK_DOMAINS });
  stringArray(risk.mitigations, `${path}.risk.mitigations`);

  const effort = exactKeys(
    item.effort,
    ["size", "personDays", "confidence", "drivers"],
    `${path}.effort`,
  );
  enumValue(effort.size, EFFORT, `${path}.effort.size`);
  enumValue(effort.confidence, CONFIDENCE, `${path}.effort.confidence`);
  string(effort.drivers, `${path}.effort.drivers`, 20);
  const personDays = exactKeys(
    effort.personDays,
    ["minimum", "maximum"],
    `${path}.effort.personDays`,
  );
  integer(personDays.minimum, `${path}.effort.personDays.minimum`, 1);
  integer(personDays.maximum, `${path}.effort.personDays.maximum`, 1);
  if (personDays.maximum < personDays.minimum) {
    fail(`${path}.effort.personDays maximum must be >= minimum`);
  }
  const bands = {
    XS: personDays.maximum <= 2,
    S: personDays.maximum <= 5,
    M: personDays.minimum >= 3 && personDays.maximum <= 10,
    L: personDays.minimum >= 6 && personDays.maximum <= 25,
    XL: personDays.minimum >= 10,
  };
  if (!bands[effort.size]) {
    fail(`${path}.effort.personDays does not fit size ${effort.size}`);
  }
}

function detectDependencyCycle(itemsById) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain) {
    if (visiting.has(id)) {
      fail(`roadmap dependency cycle: ${[...chain, id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const item = itemsById.get(id);
    for (const dependency of item.dependsOn) visit(dependency, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of itemsById.keys()) visit(id, []);
}

function sumEstimate(items) {
  return Object.freeze({
    itemCount: items.length,
    personDays: Object.freeze({
      minimum: items.reduce((total, item) => total + item.effort.personDays.minimum, 0),
      maximum: items.reduce((total, item) => total + item.effort.personDays.maximum, 0),
    }),
  });
}

export function validateV1Roadmap(document) {
  const root = exactKeys(document, [
    "$schema",
    "schemaVersion",
    "kind",
    "releaseContract",
    "statusVocabulary",
    "assessmentVocabulary",
    "estimateAssumptions",
    "requiredOutcomeCoverage",
    "gates",
  ], "v1Roadmap");
  if (root.$schema !== SCHEMA_PATH) fail(`v1Roadmap.$schema must equal ${SCHEMA_PATH}`);
  if (root.schemaVersion !== 1) fail("v1Roadmap.schemaVersion must equal 1");
  if (root.kind !== "open-rfc-v1-roadmap") {
    fail("v1Roadmap.kind must equal open-rfc-v1-roadmap");
  }

  const release = exactKeys(root.releaseContract, [
    "packageName",
    "targetVersion",
    "startingPoint",
    "baselineResolution",
    "defaultScope",
    "scopeRule",
    "admissionRule",
  ], "v1Roadmap.releaseContract");
  if (
    release.packageName !== "open-rfc" ||
    release.targetVersion !== "1.0.0" ||
    release.startingPoint !== "published-0.x-beta-line"
  ) fail("v1Roadmap.releaseContract fixed identity changed");
  for (const key of ["baselineResolution", "defaultScope", "scopeRule", "admissionRule"]) {
    string(release[key], `v1Roadmap.releaseContract.${key}`, 20);
  }
  exactArray(root.statusVocabulary, STATUSES, "v1Roadmap.statusVocabulary");
  const vocabulary = exactKeys(root.assessmentVocabulary, [
    "importance",
    "risk",
    "effort",
    "confidence",
    "releaseRequirement",
  ], "v1Roadmap.assessmentVocabulary");
  exactArray(vocabulary.importance, IMPORTANCE, "assessmentVocabulary.importance");
  exactArray(vocabulary.risk, RISK, "assessmentVocabulary.risk");
  exactArray(vocabulary.effort, EFFORT, "assessmentVocabulary.effort");
  exactArray(vocabulary.confidence, CONFIDENCE, "assessmentVocabulary.confidence");
  exactArray(
    vocabulary.releaseRequirement,
    RELEASE_REQUIREMENT,
    "assessmentVocabulary.releaseRequirement",
  );
  const assumptions = exactKeys(root.estimateAssumptions, [
    "unit",
    "teamModel",
    "existingAssets",
    "excludes",
    "interpretation",
  ], "v1Roadmap.estimateAssumptions");
  if (assumptions.unit !== "experienced-maintainer-person-days") {
    fail("estimateAssumptions.unit changed");
  }
  for (const key of ["teamModel", "existingAssets", "excludes", "interpretation"]) {
    string(assumptions[key], `estimateAssumptions.${key}`, 20);
  }

  const gates = array(root.gates, "v1Roadmap.gates");
  if (gates.length !== GATE_IDS.length) fail("v1Roadmap.gates must contain exactly 7 gates");
  const itemsById = new Map();
  const gateByItem = new Map();
  for (let gateIndex = 0; gateIndex < gates.length; gateIndex += 1) {
    const path = `v1Roadmap.gates[${gateIndex}]`;
    const gate = exactKeys(gates[gateIndex], [
      "id",
      "title",
      "objective",
      "dependsOn",
      "exitCriteria",
      "workItems",
    ], path);
    if (gate.id !== GATE_IDS[gateIndex]) fail(`${path}.id must preserve V1-00..V1-06 order`);
    string(gate.title, `${path}.title`, 3);
    string(gate.objective, `${path}.objective`, 20);
    exactArray(gate.dependsOn, GATE_DEPENDENCIES[gate.id], `${path}.dependsOn`);
    stringArray(gate.exitCriteria, `${path}.exitCriteria`, { minimum: 2 });
    const workItems = array(gate.workItems, `${path}.workItems`);
    if (workItems.length === 0) fail(`${path}.workItems must not be empty`);
    for (let itemIndex = 0; itemIndex < workItems.length; itemIndex += 1) {
      const itemPath = `${path}.workItems[${itemIndex}]`;
      const item = exactKeys(workItems[itemIndex], [
        "id",
        "title",
        "summary",
        "status",
        "releaseRequirement",
        "condition",
        "executionKind",
        "importance",
        "risk",
        "effort",
        "ownerKinds",
        "dependsOn",
        "deliverables",
        "acceptanceCriteria",
      ], itemPath);
      string(item.id, `${itemPath}.id`);
      const match = ITEM_ID.exec(item.id);
      if (match === null || match[1] !== gate.id.slice("V1-".length)) {
        fail(`${itemPath}.id must belong to ${gate.id}`);
      }
      if (itemsById.has(item.id)) fail(`${itemPath}.id duplicates ${item.id}`);
      string(item.title, `${itemPath}.title`, 3);
      string(item.summary, `${itemPath}.summary`, 20);
      enumValue(item.status, STATUSES, `${itemPath}.status`);
      enumValue(
        item.releaseRequirement,
        RELEASE_REQUIREMENT,
        `${itemPath}.releaseRequirement`,
      );
      if (item.releaseRequirement === "conditional") {
        string(item.condition, `${itemPath}.condition`, 20);
        if (!/scope decision/iu.test(item.condition)) {
          fail(`${itemPath}.condition must name the scope decision`);
        }
      } else if (item.condition !== null) {
        fail(`${itemPath}.condition must be null unless releaseRequirement is conditional`);
      }
      enumValue(item.executionKind, EXECUTION_KIND, `${itemPath}.executionKind`);
      validateAssessment(item, itemPath);
      stringArray(item.ownerKinds, `${itemPath}.ownerKinds`, { allowed: OWNER_KINDS });
      array(item.dependsOn, `${itemPath}.dependsOn`);
      unique(item.dependsOn, `${itemPath}.dependsOn`);
      item.dependsOn.forEach((dependency, dependencyIndex) =>
        string(dependency, `${itemPath}.dependsOn[${dependencyIndex}]`));
      stringArray(item.deliverables, `${itemPath}.deliverables`);
      stringArray(item.acceptanceCriteria, `${itemPath}.acceptanceCriteria`, { minimum: 2 });
      itemsById.set(item.id, item);
      gateByItem.set(item.id, gate.id);
    }
  }

  for (const [itemId, item] of itemsById) {
    const itemGateIndex = GATE_IDS.indexOf(gateByItem.get(itemId));
    for (const dependency of item.dependsOn) {
      const target = itemsById.get(dependency);
      if (target === undefined) fail(`${itemId} depends on unknown item ${dependency}`);
      const dependencyGateIndex = GATE_IDS.indexOf(gateByItem.get(dependency));
      if (dependencyGateIndex > itemGateIndex) {
        fail(`${itemId} depends on later-gate item ${dependency}`);
      }
      if (
        item.releaseRequirement === "required" &&
        target.releaseRequirement !== "required"
      ) {
        fail(`${itemId} is required but depends on non-required item ${dependency}`);
      }
    }
  }
  detectDependencyCycle(itemsById);

  for (const id of REQUIRED_CONDITIONAL_ROUTES) {
    const item = itemsById.get(id);
    if (item?.releaseRequirement !== "conditional") {
      fail(`mandatory route decision ${id} must remain explicit and conditional until review`);
    }
  }

  const coverage = array(root.requiredOutcomeCoverage, "v1Roadmap.requiredOutcomeCoverage");
  if (coverage.length !== REQUIRED_OUTCOMES.length) {
    fail("v1Roadmap.requiredOutcomeCoverage must contain exactly seven outcomes");
  }
  const coveredItems = new Set();
  for (let index = 0; index < coverage.length; index += 1) {
    const path = `v1Roadmap.requiredOutcomeCoverage[${index}]`;
    const outcome = exactKeys(coverage[index], ["id", "requirementIds"], path);
    if (outcome.id !== REQUIRED_OUTCOMES[index]) {
      fail(`${path}.id must preserve the required stable-release outcome order`);
    }
    stringArray(outcome.requirementIds, `${path}.requirementIds`);
    for (const id of outcome.requirementIds) {
      const item = itemsById.get(id);
      if (item === undefined) fail(`${path} references unknown item ${id}`);
      if (item.releaseRequirement !== "required") {
        fail(`${path} outcome item ${id} must be required`);
      }
      if (coveredItems.has(id)) fail(`${path} duplicates outcome item ${id}`);
      coveredItems.add(id);
    }
  }

  const items = [...itemsById.values()];
  const requiredItems = items.filter((item) => item.releaseRequirement === "required");
  const conditionalItems = items.filter((item) => item.releaseRequirement === "conditional");
  const postV1Items = items.filter((item) => item.releaseRequirement === "post-v1");
  const statuses = Object.freeze(Object.fromEntries(
    STATUSES.map((status) => [status, items.filter((item) => item.status === status).length]),
  ));
  return Object.freeze({
    gateCount: gates.length,
    itemCount: items.length,
    unassessedItemCount: 0,
    requiredOutcomes: Object.freeze([...REQUIRED_OUTCOMES]),
    requiredEstimate: sumEstimate(requiredItems),
    conditionalEstimate: sumEstimate(conditionalItems),
    postV1Estimate: sumEstimate(postV1Items),
    conditionalItemCount: conditionalItems.length,
    statuses,
  });
}

function markdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .trim();
}

function roleLabel(value) {
  return value === "required"
    ? "Required for 1.0"
    : value === "conditional"
      ? "Conditional scope candidate"
      : "Post-1.0";
}

function gateItemsByRole(gate, role) {
  return gate.workItems.filter((item) => item.releaseRequirement === role);
}

function estimateText(estimate) {
  if (estimate.itemCount === 0) return "none";
  return `${estimate.personDays.minimum}–${estimate.personDays.maximum} person-days ` +
    `(about ${(estimate.personDays.minimum / 5).toFixed(1)}–` +
    `${(estimate.personDays.maximum / 5).toFixed(1)} person-weeks)`;
}

export function renderPublicV1Roadmap(document) {
  const summary = validateV1Roadmap(document);
  const lines = [
    "<!-- Generated by tools/v1_roadmap.mjs from the reviewed planning ledger. Do not edit by hand. -->",
    "# Road to 1.0",
    "",
    "This roadmap turns the current public 0.x beta into a reviewable path to `open-rfc@1.0.0`. " +
      "It is a planning document, not a support claim or release decision. Current supported behavior " +
      "remains defined by the exact version's [release status](status.md).",
    "",
    "Every item is initially **proposed** so maintainers can change importance, risk, effort, scope, " +
      "dependencies, and acceptance criteria through ordinary review. Only exact verified evidence can " +
      "complete a release requirement; closing an issue or editing this page cannot do so.",
    "",
    "## Scope and estimate",
    "",
    `The default stable scope is: ${markdown(document.releaseContract.defaultScope)}`,
    "",
    `${summary.requiredEstimate.itemCount} currently required items total ` +
      `**${estimateText(summary.requiredEstimate)}**. ` +
      `${summary.conditionalEstimate.itemCount} conditional route items add ` +
      `**${estimateText(summary.conditionalEstimate)}** only if a reviewed scope decision promotes them. ` +
      "These estimates assume one experienced maintainer and reuse of current automation. They exclude " +
      "calendar wait for adopters, SAP operators, reviewers, credentials, and infrastructure.",
    "",
    "Estimate ranges are deliberately broad. Re-estimate after scope decisions, baseline evidence mapping, " +
      "adopter recruitment, or any new external prerequisite.",
    "",
    "## Assessment scale",
    "",
    "- **Importance:** `critical` blocks a safe or honest stable release; `high` is strongly expected; " +
      "`medium` materially helps but can be scoped out; `low` is optional polish.",
    "- **Risk:** combines impact and uncertainty across correctness, security, compatibility, operations, " +
      "schedule, scope, supply chain, and external dependencies.",
    "- **Effort:** `XS`, `S`, `M`, `L`, and `XL`, with an explicit experienced-maintainer person-day range " +
      "and confidence level.",
    "- **Release role:** required items block 1.0; conditional items block only after promotion into the " +
      "approved support scope; post-1.0 items never block 1.0.",
    "",
    "## Gate overview",
    "",
    "| Gate | Objective | Required items | Conditional items | Required effort |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const gate of document.gates) {
    const required = gateItemsByRole(gate, "required");
    const conditional = gateItemsByRole(gate, "conditional");
    const estimate = sumEstimate(required);
    lines.push(
      `| \`${gate.id}\` ${markdown(gate.title)} | ${markdown(gate.objective)} | ` +
        `${required.length} | ${conditional.length} | ${estimateText(estimate)} |`,
    );
  }
  lines.push("");

  for (const gate of document.gates) {
    lines.push(
      `## ${gate.id} — ${markdown(gate.title)}`,
      "",
      markdown(gate.objective),
      "",
      gate.dependsOn.length === 0
        ? "Dependencies: none."
        : `Dependencies: ${gate.dependsOn.map((id) => `\`${id}\``).join(", ")}.`,
      "",
      "Exit criteria:",
      "",
      ...gate.exitCriteria.map((criterion) => `- ${markdown(criterion)}`),
      "",
      "| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...gate.workItems.map((item) =>
        `| \`${item.id}\` ${markdown(item.title)} | ${roleLabel(item.releaseRequirement)} | ` +
          `${item.status} | ${item.importance.level} | ${item.risk.level} | ${item.effort.size} | ` +
          `${item.effort.personDays.minimum}–${item.effort.personDays.maximum} person-days | ` +
          `${item.effort.confidence} |`,
      ),
      "",
    );
    for (const item of gate.workItems) {
      lines.push(
        `### ${markdown(item.title)}`,
        "",
        `- **ID:** \`${item.id}\``,
        `- **Release role:** ${roleLabel(item.releaseRequirement)}`,
        `- **Execution:** ${item.executionKind}`,
        `- **Owners:** ${item.ownerKinds.map(markdown).join(", ")}`,
        "",
        markdown(item.summary),
        "",
        `- **Importance — ${item.importance.level}:** ${markdown(item.importance.rationale)}`,
        `- **Risk — ${item.risk.level}:** ${markdown(item.risk.summary)} ` +
          `Domains: ${item.risk.domains.map((domain) => `\`${domain}\``).join(", ")}.`,
        `- **Effort — ${item.effort.size}, ` +
          `${item.effort.personDays.minimum}–${item.effort.personDays.maximum} person-days, ` +
          `${item.effort.confidence} confidence:** ${markdown(item.effort.drivers)}`,
      );
      if (item.condition !== null) lines.push(`- **Condition:** ${markdown(item.condition)}`);
      if (item.dependsOn.length > 0) {
        lines.push(`- **Depends on:** ${item.dependsOn.map((id) => `\`${id}\``).join(", ")}`);
      }
      lines.push(
        "- **Risk controls:**",
        ...item.risk.mitigations.map((mitigation) => `  - ${markdown(mitigation)}`),
        "- **Deliverables:**",
        ...item.deliverables.map((deliverable) => `  - ${markdown(deliverable)}`),
        "- **Acceptance criteria:**",
        ...item.acceptanceCriteria.map((criterion) => `  - ${markdown(criterion)}`),
        "",
      );
    }
  }
  lines.push(
    "## What 1.0 does not imply",
    "",
    "Version 1.0 will stabilize the reviewed support boundary; it will not imply complete SAP NW RFC SDK " +
      "parity. Server/callback mode, tRFC, qRFC, bgRFC, Throughput, SNC/X.509, non-Unicode/MDMP, basXML, " +
      "WebSocket RFC, Cloud Connector principal propagation, message-server routing, and SAProuter remain " +
      "unsupported unless their conditional roadmap items are explicitly promoted and pass their complete " +
      "acceptance evidence.",
    "",
  );
  return lines.join("\n");
}

async function readLedger(root) {
  try {
    return JSON.parse(await readFile(resolve(root, LEDGER_PATH), "utf8"));
  } catch (error) {
    fail(`${LEDGER_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateV1RoadmapRepository(root = DEFAULT_ROOT) {
  return validateV1Roadmap(await readLedger(root));
}

export async function writeV1RoadmapDocumentation(root = DEFAULT_ROOT) {
  const output = renderPublicV1Roadmap(await readLedger(root));
  const path = resolve(root, OUTPUT_PATH);
  await writeFile(path, output, "utf8");
  return Object.freeze({ path, bytes: Buffer.byteLength(output) });
}

export async function checkV1RoadmapDocumentation(root = DEFAULT_ROOT) {
  const expected = renderPublicV1Roadmap(await readLedger(root));
  let actual;
  try {
    actual = await readFile(resolve(root, OUTPUT_PATH), "utf8");
  } catch (error) {
    fail(`${OUTPUT_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actual !== expected) {
    fail(`${OUTPUT_PATH} is stale; run node tools/v1_roadmap.mjs write`);
  }
  return Object.freeze({ path: resolve(root, OUTPUT_PATH), bytes: Buffer.byteLength(actual) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? "check";
    if (process.argv.length > 3 || !["check", "write"].includes(command)) {
      fail("usage: node tools/v1_roadmap.mjs [check|write]");
    }
    const result = command === "write"
      ? await writeV1RoadmapDocumentation(DEFAULT_ROOT)
      : {
          ...(await validateV1RoadmapRepository(DEFAULT_ROOT)),
          documentation: await checkV1RoadmapDocumentation(DEFAULT_ROOT),
        };
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
