import { createHash } from "node:crypto";

import {
  assertNoGitHistoryOverrides,
  runTrustedGit,
} from "./trusted_git.mjs";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PUBLIC_VERSION_TAG_REF =
  /^refs\/tags\/v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
export const PUBLISHABLE_REF_SCOPE_POLICY =
  "bound-commit-and-lightweight-stable-v0-tags-v1";
const MAX_REFS = 10_000;
const MAX_OBJECTS = 50_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class GitRefInventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitRefInventoryError";
  }
}

function fail(message) {
  throw new GitRefInventoryError(message);
}

function digest(lines) {
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}

function git(root, arguments_, options = {}) {
  try {
    return runTrustedGit(root, arguments_, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      ...options,
    });
  } catch {
    fail(`git ${arguments_[0]} failed while reading the ref/object inventory`);
  }
}

function uniqueSorted(lines, maximum, label) {
  const values = lines.filter(Boolean).sort();
  if (values.length < 1 || values.length > maximum || new Set(values).size !== values.length) {
    fail(`${label} is empty, duplicated, or outside its bounded inventory`);
  }
  return values;
}

function readRepositoryRefLines(root) {
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow !== "false") {
    fail(shallow === "true"
      ? "shallow repository cannot prove complete reachable history or ref/object inventory"
      : "repository returned an invalid shallow-state result");
  }
  const refLines = uniqueSorted(
    git(root, [
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname) %(objectname)",
      "refs",
    ]).split(/\r?\n/u),
    MAX_REFS,
    "Git ref-tip inventory",
  );
  for (const line of refLines) {
    const separator = line.lastIndexOf(" ");
    const ref = line.slice(0, separator);
    const objectId = line.slice(separator + 1);
    if (
      separator < 5 ||
      !ref.startsWith("refs/") ||
      /[\u0000-\u0020\u007f]/u.test(ref) ||
      !OBJECT_ID.test(objectId)
    ) fail("Git ref-tip inventory contains an invalid coordinate");
  }
  return refLines;
}

function inventoryFromRefLines(root, refLines) {
  const refTips = refLines.map((line) => line.slice(line.lastIndexOf(" ") + 1));
  const objects = uniqueSorted(
    git(
      root,
      ["rev-list", "--objects", "--no-object-names", "--stdin"],
      { input: `${refTips.join("\n")}\n` },
    )
      .split(/\r?\n/u),
    MAX_OBJECTS,
    "Git reachable-object inventory",
  );
  if (objects.some((objectId) => !OBJECT_ID.test(objectId))) {
    fail("Git reachable-object inventory contains an invalid object ID");
  }
  return Object.freeze({
    algorithm: "git-ref-tips-and-reachable-objects-sha256-v1",
    refTipCount: refLines.length,
    refTipInventorySha256: digest(refLines),
    objectCount: objects.length,
    objectInventorySha256: digest(objects),
  });
}

function readPublishableRefLines(root, expectedCommit) {
  if (!OBJECT_ID.test(expectedCommit)) {
    fail("publishable history commit binding is required");
  }
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow !== "false") {
    fail(shallow === "true"
      ? "shallow repository cannot prove complete publishable history"
      : "repository returned an invalid shallow-state result");
  }
  if (git(root, ["cat-file", "-t", expectedCommit]).trim() !== "commit") {
    fail("publishable history commit binding is not a commit");
  }
  if (git(root, ["rev-parse", "HEAD"]).trim() !== expectedCommit) {
    fail("HEAD must equal the explicitly bound publishable history commit");
  }
  const lines = git(root, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%09%(objecttype)%09%(objectname)",
    "refs/tags",
  ]).split(/\r?\n/u).filter(Boolean);
  if (lines.length > MAX_REFS - 1) {
    fail("publishable Git ref scope is outside its bounded inventory");
  }
  const refLines = [`HEAD ${expectedCommit}`];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3) {
      fail("publishable Git ref scope contains an invalid coordinate");
    }
    const [ref, objectType, objectId] = fields;
    if (!OBJECT_ID.test(objectId) || objectType !== "commit") {
      fail("publishable Git refs must point directly to commits");
    }
    if (!PUBLIC_VERSION_TAG_REF.test(ref)) {
      fail("public tag namespace contains a non-release or unsupported version tag");
    }
    refLines.push(`${ref} ${objectId}`);
  }
  for (const line of refLines) {
    const separator = line.lastIndexOf(" ");
    const ref = line.slice(0, separator);
    const objectId = line.slice(separator + 1);
    if (ref === "HEAD") continue;
    try {
      git(root, ["merge-base", "--is-ancestor", objectId, expectedCommit]);
    } catch {
      fail("public version tags must be ancestors of the bound publishable commit");
    }
  }
  return Object.freeze({
    refLines: Object.freeze(uniqueSorted(
      refLines,
      MAX_REFS,
      "publishable Git ref-tip inventory",
    )),
  });
}

/**
 * Read the release-history universe: one explicitly supplied immutable commit
 * plus direct lightweight stable v0.x.y tags already contained in that commit.
 * Development, fixture, beta,
 * agent, review, remote-tracking, and stash refs are deliberately out of scope.
 */
export function readPublishableGitRefScope(root, expectedCommit) {
  assertNoGitHistoryOverrides(root);
  const { refLines } = readPublishableRefLines(root, expectedCommit);
  const scope = Object.freeze({
    policy: PUBLISHABLE_REF_SCOPE_POLICY,
    headObjectId: expectedCommit,
    revisionObjectIds: Object.freeze(
      refLines.map((line) => line.slice(line.lastIndexOf(" ") + 1)),
    ),
    refObjectInventory: inventoryFromRefLines(root, refLines),
  });
  assertNoGitHistoryOverrides(root);
  return scope;
}

export function assertPublishableGitRefScope(
  actual,
  expected,
  label = "publishable Git ref scope",
) {
  if (
    actual?.policy !== PUBLISHABLE_REF_SCOPE_POLICY ||
    expected?.policy !== PUBLISHABLE_REF_SCOPE_POLICY ||
    actual.headObjectId !== expected.headObjectId ||
    JSON.stringify(actual.revisionObjectIds) !== JSON.stringify(expected.revisionObjectIds)
  ) {
    fail(`${label} changed during verification`);
  }
  assertGitRefObjectInventory(
    actual.refObjectInventory,
    expected.refObjectInventory,
    label,
  );
}

/**
 * Read the publishable scope after one exact stable version tag was added.
 * Removing that tag must recreate the pre-release scope inventory exactly;
 * the tag itself may not make any new object reachable.
 */
export function readPublishableGitRefScopeAfterVersionTag(
  root,
  expectedRef,
  expectedCommit,
) {
  if (!PUBLIC_VERSION_TAG_REF.test(expectedRef) || !OBJECT_ID.test(expectedCommit)) {
    fail("post-release publishable version-tag binding is invalid");
  }
  assertNoGitHistoryOverrides(root);
  const { refLines } = readPublishableRefLines(root, expectedCommit);
  const expectedLine = `${expectedRef} ${expectedCommit}`;
  if (refLines.filter((line) => line === expectedLine).length !== 1) {
    fail("post-release publishable version tag is missing or not bound to the candidate commit");
  }
  const withoutExpectedRef = refLines.filter((line) => line !== expectedLine);
  const result = Object.freeze({
    mode: "post-release-publishable-version-tag-v1",
    policy: PUBLISHABLE_REF_SCOPE_POLICY,
    headObjectId: expectedCommit,
    expectedRef,
    expectedObjectId: expectedCommit,
    current: inventoryFromRefLines(root, refLines),
    withoutExpectedRef: inventoryFromRefLines(root, withoutExpectedRef),
  });
  assertNoGitHistoryOverrides(root);
  return result;
}

export function assertPublishableGitRefScopeAfterVersionTag(
  actual,
  expectedInventory,
  expectedRef,
  expectedCommit,
  label = "publishable Git ref scope",
) {
  if (
    actual?.mode !== "post-release-publishable-version-tag-v1" ||
    actual.policy !== PUBLISHABLE_REF_SCOPE_POLICY ||
    actual.headObjectId !== expectedCommit ||
    actual.expectedRef !== expectedRef ||
    actual.expectedObjectId !== expectedCommit
  ) {
    fail(`${label} does not bind the exact post-release publishable version tag`);
  }
  assertGitRefObjectInventory(
    actual.withoutExpectedRef,
    expectedInventory,
    `${label} excluding the expected version tag`,
  );
  if (
    actual.current?.algorithm !== expectedInventory?.algorithm ||
    actual.current?.refTipCount !== expectedInventory?.refTipCount + 1 ||
    actual.current?.objectCount !== expectedInventory?.objectCount ||
    actual.current?.objectInventorySha256 !== expectedInventory?.objectInventorySha256
  ) {
    fail(`${label} changed beyond the exact lightweight version tag`);
  }
}

/** Read a deterministic digest of every ref tip and every object reachable from any ref. */
export function readGitRefObjectInventory(root) {
  assertNoGitHistoryOverrides(root);
  const inventory = inventoryFromRefLines(root, readRepositoryRefLines(root));
  assertNoGitHistoryOverrides(root);
  return inventory;
}

/**
 * Read the post-release inventory while isolating one exact lightweight 0.x
 * version tag. The full and tag-excluded object inventories are retained so a
 * caller can prove that the tag introduced no new reachable object.
 */
export function readGitRefObjectInventoryAfterVersionTag(
  root,
  expectedRef,
  expectedCommit,
) {
  if (!PUBLIC_VERSION_TAG_REF.test(expectedRef) || !OBJECT_ID.test(expectedCommit)) {
    fail("post-release version-tag binding is invalid");
  }
  assertNoGitHistoryOverrides(root);
  const refLines = readRepositoryRefLines(root);
  const prefix = `${expectedRef} `;
  const matching = refLines.filter((line) => line.startsWith(prefix));
  if (matching.length !== 1 || matching[0] !== `${expectedRef} ${expectedCommit}`) {
    fail("post-release version tag is missing, annotated, or not bound to the candidate commit");
  }
  const withoutExpectedRef = refLines.filter((line) => !line.startsWith(prefix));
  const inventory = Object.freeze({
    mode: "post-release-version-tag-v1",
    expectedRef,
    expectedObjectId: expectedCommit,
    current: inventoryFromRefLines(root, refLines),
    withoutExpectedRef: inventoryFromRefLines(root, withoutExpectedRef),
  });
  assertNoGitHistoryOverrides(root);
  return inventory;
}

export function assertGitRefObjectInventory(actual, expected, label = "Git ref/object inventory") {
  for (const key of [
    "algorithm",
    "refTipCount",
    "refTipInventorySha256",
    "objectCount",
    "objectInventorySha256",
  ]) {
    if (actual?.[key] !== expected?.[key]) {
      fail(`${label} changed after candidate bundle creation`);
    }
  }
}

/**
 * Admit only one exact lightweight version tag added after candidate creation.
 * Removing that ref must reproduce the complete bound inventory, while the
 * full current repository must retain the identical reachable-object set.
 */
export function assertGitRefObjectInventoryAfterVersionTag(
  actual,
  expected,
  expectedRef,
  expectedCommit,
  label = "Git ref/object inventory",
) {
  if (
    actual?.mode !== "post-release-version-tag-v1" ||
    actual.expectedRef !== expectedRef ||
    actual.expectedObjectId !== expectedCommit
  ) {
    fail(`${label} does not bind the exact post-release version tag`);
  }
  assertGitRefObjectInventory(
    actual.withoutExpectedRef,
    expected,
    `${label} excluding the expected version tag`,
  );
  if (
    actual.current?.algorithm !== expected?.algorithm ||
    actual.current?.refTipCount !== expected?.refTipCount + 1 ||
    actual.current?.objectCount !== expected?.objectCount ||
    actual.current?.objectInventorySha256 !== expected?.objectInventorySha256
  ) {
    fail(`${label} changed beyond the exact lightweight version tag`);
  }
}
