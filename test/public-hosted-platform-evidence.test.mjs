import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PublicHostedPlatformEvidenceError,
  aggregatePublicHostedPlatformCells,
  buildPublicHostedPlatformCell,
  githubWorkflowFromEnvironment,
  publicHostedPlatformCellFilename,
} from "../tools/public_hosted_platform_evidence.mjs";

const HEX40 = "a".repeat(40);
const HEX64 = "b".repeat(64);

const verified = Object.freeze({
  status: "passed",
  commit: HEX40,
  package: Object.freeze({ name: "open-rfc", version: "0.2.0-beta.1" }),
  filename: "open-rfc-0.2.0-beta.1.tgz",
  sha256: HEX64,
  releaseSetSha256: "c".repeat(64),
});

const compatibility = Object.freeze({
  schemaVersion: 1,
  publicationMode: "public-license-preflight",
  package: Object.freeze({ name: "open-rfc", version: "0.2.0-beta.1" }),
  artifact: Object.freeze({
    filename: "open-rfc-0.2.0-beta.1.tgz",
    fileCount: 101,
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    sha256: HEX64,
    size: 12345,
  }),
  consumers: Object.freeze([
    Object.freeze({
      alias: "@sap-rfc/node-rfc-library",
      cjs: true,
      esm: true,
      typescript: true,
      npmCiOmitOptional: true,
      dependencyCount: 1,
      packageCopies: 1,
    }),
    Object.freeze({
      alias: "node-rfc",
      cjs: true,
      esm: true,
      typescript: true,
      npmCiOmitOptional: true,
      dependencyCount: 1,
      packageCopies: 1,
    }),
  ]),
  sdkFree: true,
  externalNetworkRequired: false,
  networkGuard: true,
  secretFreeChildEnvironment: true,
  suppliedArtifact: true,
});

const workflow = Object.freeze({
  provider: "github-actions",
  repository: "marianfoo/open-rfc",
  workflowPath: ".github/workflows/candidate.yml",
  workflowRef: `marianfoo/open-rfc/.github/workflows/candidate.yml@refs/heads/main`,
  workflowSha: HEX40,
  runId: "12345",
  runAttempt: 1,
  url: "https://github.com/marianfoo/open-rfc/actions/runs/12345/attempts/1",
  trigger: "workflow_dispatch",
});

const runner = Object.freeze({
  environment: "github-hosted",
  label: "ubuntu-24.04",
  os: "Linux",
  arch: "X64",
  platform: "linux",
  machineArch: "x64",
  resolvedImage: "ubuntu24",
  resolvedImageVersion: "20260720.1.0",
  imageMetadataSource: "github-runner-image-environment",
});

function cell(nodeMajor, overrides = {}) {
  return buildPublicHostedPlatformCell({
    verified,
    compatibility,
    workflow,
    runner,
    requestedNode: String(nodeMajor),
    nodeVersion: `v${nodeMajor}.14.0`,
    command: {
      argv: ["node", "public_hosted_platform_evidence.mjs", "cell"],
      startedAt: "2026-07-21T10:00:00.000Z",
      finishedAt: "2026-07-21T10:00:01.000Z",
      exitCode: 0,
    },
    ...overrides,
  });
}

test("builds and aggregates exactly one Node 22/24 public artifact matrix", () => {
  const node22 = cell(22);
  const node24 = cell(24);
  const result = aggregatePublicHostedPlatformCells({
    cells: [node24, node22],
    verified,
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.cells.map(({ coordinate }) => coordinate), [
    "22:linux:x64",
    "24:linux:x64",
  ]);
  assert.equal(result.candidate.artifact.sha256, `sha256:${HEX64}`);
  assert(result.cells.every(({ compatibility: value }) => value.sdkFree));
});

test("rejects duplicate coordinates, mixed candidates, and incomplete compatibility", () => {
  assert.throws(
    () => aggregatePublicHostedPlatformCells({ cells: [cell(22), cell(22)], verified }),
    /duplicate matrix coordinate/u,
  );
  const other = structuredClone(cell(24));
  other.candidate.commit = "d".repeat(40);
  assert.throws(
    () => aggregatePublicHostedPlatformCells({ cells: [cell(22), other], verified }),
    PublicHostedPlatformEvidenceError,
  );
  assert.throws(
    () => cell(24, {
      compatibility: { ...compatibility, suppliedArtifact: false },
    }),
    /incomplete or bound to another artifact/u,
  );
  assert.throws(
    () => cell(24, {
      runner: { ...runner, resolvedImageVersion: "20260231.1.0" },
    }),
    /invalid build date/u,
  );
});

test("binds the GitHub environment to the exact public candidate workflow", () => {
  const environment = {
    GITHUB_ACTIONS: "true",
    CI: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: HEX40,
    GITHUB_REPOSITORY: "marianfoo/open-rfc",
    GITHUB_WORKFLOW_REF:
      "marianfoo/open-rfc/.github/workflows/candidate.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: HEX40,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  };
  assert.equal(githubWorkflowFromEnvironment(environment, verified).runId, "12345");
  assert.throws(
    () => githubWorkflowFromEnvironment({ ...environment, GITHUB_REPOSITORY: "fork/open-rfc" }, verified),
    /verified public GitHub Actions candidate/u,
  );
  assert.throws(
    () => githubWorkflowFromEnvironment({
      ...environment,
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
    }, verified),
    /GITHUB_WORKFLOW_SHA does not match the verified public candidate commit/u,
  );
  assert.throws(
    () => githubWorkflowFromEnvironment({
      ...environment,
      GITHUB_WORKFLOW_REF:
        "marianfoo/open-rfc/.github/workflows/candidate.yml@refs/tags/v0.2.0-beta.1",
    }, verified),
    /GITHUB_WORKFLOW_REF is not the public candidate workflow/u,
  );
  assert.equal(
    publicHostedPlatformCellFilename(24, "linux", "x64"),
    "public-platform-node24-linux-x64.v1.json",
  );
});

test("requires an explicit full commit at the public hosted-platform CLI boundary", () => {
  const tool = fileURLToPath(new URL("../tools/public_hosted_platform_evidence.mjs", import.meta.url));
  for (const arguments_ of [
    [
      "cell",
      "--artifact-directory", "unused",
      "--output-directory", "unused",
      "--publication-mode", "public-license-preflight",
      "--requested-node", "22",
      "--runner-label", "ubuntu-24.04",
    ],
    [
      "aggregate",
      "--artifact-directory", "unused",
      "--cells-directory", "unused",
      "--output-directory", "unused",
      "--publication-mode", "public-license-preflight",
    ],
  ]) {
    const missing = spawnSync(process.execPath, [tool, ...arguments_], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /CLI flags must be exactly.*--commit/u);

    const abbreviated = spawnSync(
      process.execPath,
      [tool, ...arguments_, "--commit", "abc123"],
      { encoding: "utf8" },
    );
    assert.notEqual(abbreviated.status, 0);
    assert.match(abbreviated.stderr, /--commit must be an explicit full SHA-1/u);
  }
});
