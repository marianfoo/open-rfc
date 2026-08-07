#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import cellSchema from
  "../conformance/schemas/public-hosted-platform-cell-v1.schema.json" with { type: "json" };
import evidenceSchema from
  "../conformance/schemas/public-hosted-platform-evidence-v1.schema.json" with { type: "json" };

import { validateJsonSchemaSubset } from "./json_schema_subset.mjs";
import {
  COMPATIBILITY_ALIASES,
  runPackedCompatibility,
} from "./packed_compatibility.mjs";
import { resolvePinnedNpmToolchain } from "./pinned_npm.mjs";
import { normalizePublicationMode } from "./publication_safety.mjs";
import { verifyCandidateBundle } from "./verify_candidate_bundle.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");
const PUBLICATION_MODE = "public-license-preflight";
const REPOSITORY = "marianfoo/open-rfc";
const WORKFLOW_PATH = ".github/workflows/candidate.yml";
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
const CELL_SCHEMA_PATH =
  "../../conformance/schemas/public-hosted-platform-cell-v1.schema.json";
const EVIDENCE_SCHEMA_PATH =
  "../../conformance/schemas/public-hosted-platform-evidence-v1.schema.json";
const EVIDENCE_FILENAME = "public-hosted-platform-evidence.v1.json";
const MAX_CELL_BYTES = 256 * 1024;
const COORDINATES = Object.freeze(["22:linux:x64", "24:linux:x64"]);
const COMMIT = /^[a-f0-9]{40}$/u;

export class PublicHostedPlatformEvidenceError extends Error {
  constructor(message) {
    super(`public hosted platform evidence: ${message}`);
    this.name = "PublicHostedPlatformEvidenceError";
  }
}

function fail(message) {
  throw new PublicHostedPlatformEvidenceError(message);
}

function boundCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    fail("--commit must be an explicit full SHA-1");
  }
  return value;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value), undefined, 2)}\n`);
}

function prettyBytes(value) {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function same(left, right, label) {
  if (!canonicalBytes(left).equals(canonicalBytes(right))) fail(`${label} differs`);
}

function prefixedDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} is not a SHA-256 digest`);
  }
  return `sha256:${value}`;
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
      .test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail(`${label} must be a canonical UTC timestamp`);
  return value;
}

function normalizeMode(value) {
  let mode;
  try {
    mode = normalizePublicationMode(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : "publication mode is invalid");
  }
  if (mode !== PUBLICATION_MODE) fail("only public-license-preflight is supported");
  return mode;
}

function normalizeCandidate(value) {
  const candidate = record(value, "verified candidate");
  if (
    candidate.status !== "passed" ||
    !/^[a-f0-9]{40}$/u.test(candidate.commit ?? "") ||
    candidate.package?.name !== "open-rfc" ||
    typeof candidate.package?.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(candidate.package.version) ||
    candidate.filename !== `open-rfc-${candidate.package.version}.tgz`
  ) fail("candidate is not one verified open-rfc release artifact");
  return Object.freeze({
    commit: candidate.commit,
    releaseSetSha256: prefixedDigest(candidate.releaseSetSha256, "release-set digest"),
    artifact: Object.freeze({
      name: candidate.package.name,
      version: candidate.package.version,
      filename: candidate.filename,
      sha256: prefixedDigest(candidate.sha256, "artifact digest"),
    }),
  });
}

function normalizeWorkflow(value) {
  const workflow = record(value, "workflow");
  const attempt = workflow.runAttempt;
  const expectedUrl = `https://github.com/${REPOSITORY}/actions/runs/` +
    `${workflow.runId}/attempts/${attempt}`;
  if (
    workflow.provider !== "github-actions" ||
    workflow.repository !== REPOSITORY ||
    workflow.workflowPath !== WORKFLOW_PATH ||
    workflow.workflowRef !== WORKFLOW_REF ||
    !/^[a-f0-9]{40}$/u.test(workflow.workflowSha ?? "") ||
    !/^[1-9][0-9]*$/u.test(workflow.runId ?? "") ||
    !Number.isSafeInteger(attempt) || attempt < 1 ||
    workflow.url !== expectedUrl ||
    workflow.trigger !== "workflow_dispatch"
  ) fail("workflow identity is not the protected public candidate workflow");
  return Object.freeze({
    provider: workflow.provider,
    repository: workflow.repository,
    workflowPath: workflow.workflowPath,
    workflowRef: workflow.workflowRef,
    workflowSha: workflow.workflowSha,
    runId: workflow.runId,
    runAttempt: attempt,
    url: workflow.url,
    trigger: workflow.trigger,
  });
}

function normalizeRunner(value) {
  const runner = record(value, "runner");
  if (
    runner.environment !== "github-hosted" ||
    runner.label !== "ubuntu-24.04" ||
    runner.os !== "Linux" || runner.arch !== "X64" ||
    runner.platform !== "linux" || runner.machineArch !== "x64" ||
    runner.resolvedImage !== "ubuntu24" ||
    runner.imageMetadataSource !== "github-runner-image-environment" ||
    !/^20[2-9][0-9][0-1][0-9][0-3][0-9]\.[0-9]{1,4}\.[0-9]{1,3}$/u
      .test(runner.resolvedImageVersion ?? "")
  ) fail("runner is not the reviewed GitHub-hosted Ubuntu 24.04 environment");
  const date = runner.resolvedImageVersion.slice(0, 8);
  const builtAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsedBuildDate = new Date(`${builtAt}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedBuildDate.valueOf()) ||
    parsedBuildDate.toISOString().slice(0, 10) !== builtAt
  ) {
    fail("runner image version contains an invalid build date");
  }
  return Object.freeze({
    environment: runner.environment,
    label: runner.label,
    os: runner.os,
    arch: runner.arch,
    platform: runner.platform,
    machineArch: runner.machineArch,
    resolvedImage: runner.resolvedImage,
    resolvedImageVersion: runner.resolvedImageVersion,
    imageMetadataSource: runner.imageMetadataSource,
  });
}

function normalizeRuntime(requestedNode, nodeVersion) {
  if (!new Set(["22", "24"]).has(requestedNode)) fail("Node major must be 22 or 24");
  const match = /^v(22|24)\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(
    nodeVersion ?? "",
  );
  if (match?.[1] !== requestedNode) fail("resolved Node version differs from the requested major");
  return Object.freeze({
    requestedNode,
    nodeMajor: Number(requestedNode),
    nodeVersion,
  });
}

function normalizeCompatibility(value, candidate) {
  const result = record(value, "packed compatibility result");
  if (
    result.schemaVersion !== 1 ||
    result.publicationMode !== PUBLICATION_MODE ||
    result.package?.name !== candidate.artifact.name ||
    result.package?.version !== candidate.artifact.version ||
    result.artifact?.filename !== candidate.artifact.filename ||
    result.artifact?.sha256 !== candidate.artifact.sha256.slice(7) ||
    !Number.isSafeInteger(result.artifact?.fileCount) || result.artifact.fileCount < 1 ||
    !Number.isSafeInteger(result.artifact?.size) || result.artifact.size < 1 ||
    result.sdkFree !== true || result.externalNetworkRequired !== false ||
    result.networkGuard !== true || result.secretFreeChildEnvironment !== true ||
    result.suppliedArtifact !== true || !Array.isArray(result.consumers) ||
    result.consumers.length !== COMPATIBILITY_ALIASES.length
  ) fail("packed compatibility result is incomplete or bound to another artifact");
  const consumers = [];
  for (const alias of COMPATIBILITY_ALIASES) {
    const matches = result.consumers.filter((entry) => entry?.alias === alias);
    const entry = matches[0];
    if (
      matches.length !== 1 || entry.cjs !== true || entry.esm !== true ||
      entry.typescript !== true || entry.npmCiOmitOptional !== true ||
      entry.dependencyCount !== 1 || entry.packageCopies !== 1
    ) fail(`packed compatibility result is incomplete for ${alias}`);
    consumers.push(Object.freeze({
      alias,
      cjs: true,
      esm: true,
      types: true,
      cleanInstall: true,
      dependencyCount: 1,
      packageCopies: 1,
    }));
  }
  return Object.freeze({
    publicationMode: PUBLICATION_MODE,
    artifactFileCount: result.artifact.fileCount,
    artifactSize: result.artifact.size,
    consumers: Object.freeze(consumers),
    sdkFree: true,
    externalNetworkRequired: false,
    networkGuard: true,
    secretFreeChildEnvironment: true,
    suppliedArtifact: true,
  });
}

function normalizeCommand(value, rawResult) {
  const command = record(value, "command receipt");
  const startedAt = timestamp(command.startedAt, "command startedAt");
  const finishedAt = timestamp(command.finishedAt, "command finishedAt");
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (
    durationMs < 0 || command.exitCode !== 0 ||
    !Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 32 ||
    command.argv.some((item) => typeof item !== "string" || item.length < 1 || item.length > 4096)
  ) fail("packed compatibility command receipt is invalid");
  return Object.freeze({
    id: "packed-compatibility-v1",
    startedAt,
    finishedAt,
    durationMs,
    argvSha256: digest(Buffer.from(JSON.stringify(command.argv))),
    resultSha256: digest(canonicalBytes(rawResult)),
    exitCode: 0,
  });
}

function validate(value, schema, label) {
  try {
    validateJsonSchemaSubset(value, schema, label);
  } catch (error) {
    fail(`${label} failed its strict schema (${error.message})`);
  }
}

export function buildPublicHostedPlatformCell(options) {
  const candidate = normalizeCandidate(options?.verified);
  const workflow = normalizeWorkflow(options?.workflow);
  const runner = normalizeRunner(options?.runner);
  const runtime = normalizeRuntime(options?.requestedNode, options?.nodeVersion);
  const compatibility = normalizeCompatibility(options?.compatibility, candidate);
  const command = normalizeCommand(options?.command, options?.compatibility);
  if (runner.resolvedImageVersion.slice(0, 8) > command.startedAt.slice(0, 10).replaceAll("-", "")) {
    fail("runner image build date is after the observation");
  }
  const cell = Object.freeze({
    $schema: CELL_SCHEMA_PATH,
    schemaVersion: 1,
    kind: "public-hosted-platform-cell",
    status: "passed",
    candidate,
    workflow,
    runner,
    runtime,
    command,
    compatibility,
    checks: Object.freeze({
      sameArtifact: true,
      cleanInstall: true,
      esm: true,
      cjs: true,
      types: true,
      aliases: true,
      sdkFree: true,
      offline: true,
    }),
  });
  validate(cell, cellSchema, "public hosted platform cell");
  return cell;
}

export function publicHostedPlatformCellFilename(nodeMajor, platform, arch) {
  const coordinate = `${nodeMajor}:${platform}:${arch}`;
  if (!COORDINATES.includes(coordinate)) fail("cell coordinates are outside the public matrix");
  return `public-platform-node${nodeMajor}-${platform}-${arch}.v1.json`;
}

function validatePublicCell(cell, label) {
  validate(cell, cellSchema, label);
  const candidate = normalizeCandidate({
    status: "passed",
    commit: cell.candidate.commit,
    releaseSetSha256: cell.candidate.releaseSetSha256.slice(7),
    package: {
      name: cell.candidate.artifact.name,
      version: cell.candidate.artifact.version,
    },
    filename: cell.candidate.artifact.filename,
    sha256: cell.candidate.artifact.sha256.slice(7),
  });
  same(candidate, cell.candidate, `${label} candidate`);
  normalizeWorkflow(cell.workflow);
  normalizeRunner(cell.runner);
  normalizeRuntime(cell.runtime.requestedNode, cell.runtime.nodeVersion);
  const coordinate = `${cell.runtime.nodeMajor}:${cell.runner.platform}:${cell.runner.machineArch}`;
  if (!COORDINATES.includes(coordinate)) fail(`${label} has an unexpected coordinate`);
  return coordinate;
}

export function aggregatePublicHostedPlatformCells(options) {
  if (!Array.isArray(options?.cells) || options.cells.length !== 2) {
    fail("exactly two public hosted platform cells are required");
  }
  const candidate = normalizeCandidate(options.verified);
  const first = options.cells[0];
  validatePublicCell(first, "cells[0]");
  const workflow = normalizeWorkflow(first.workflow);
  const byCoordinate = new Map();
  for (const [index, cell] of options.cells.entries()) {
    const coordinate = validatePublicCell(cell, `cells[${index}]`);
    if (byCoordinate.has(coordinate)) fail(`duplicate matrix coordinate ${coordinate}`);
    same(cell.candidate, candidate, `cells[${index}] candidate`);
    same(cell.workflow, workflow, `cells[${index}] workflow`);
    const filename = publicHostedPlatformCellFilename(
      cell.runtime.nodeMajor,
      cell.runner.platform,
      cell.runner.machineArch,
    );
    byCoordinate.set(coordinate, Object.freeze({ cell, filename }));
  }
  if (COORDINATES.some((coordinate) => !byCoordinate.has(coordinate))) {
    fail("public hosted platform matrix is incomplete");
  }
  const ordered = COORDINATES.map((coordinate) => byCoordinate.get(coordinate));
  const startedAt = ordered.reduce(
    (current, { cell }) => cell.command.startedAt < current ? cell.command.startedAt : current,
    ordered[0].cell.command.startedAt,
  );
  const finishedAt = ordered.reduce(
    (current, { cell }) => cell.command.finishedAt > current ? cell.command.finishedAt : current,
    ordered[0].cell.command.finishedAt,
  );
  const evidence = Object.freeze({
    $schema: EVIDENCE_SCHEMA_PATH,
    schemaVersion: 1,
    kind: "public-hosted-platform-evidence",
    status: "passed",
    candidate,
    workflow: Object.freeze({ ...workflow, startedAt, finishedAt }),
    cells: Object.freeze(ordered.map(({ cell, filename }, index) => Object.freeze({
      coordinate: COORDINATES[index],
      filename,
      sha256: digest(prettyBytes(cell)),
      nodeVersion: cell.runtime.nodeVersion,
      runnerImageVersion: cell.runner.resolvedImageVersion,
      command: Object.freeze({ ...cell.command }),
      compatibility: Object.freeze(structuredClone(cell.compatibility)),
    }))),
    checks: Object.freeze({
      candidateStable: true,
      sameArtifact: true,
      sameWorkflowRun: true,
      completeNodeMatrix: true,
      sdkFree: true,
      offline: true,
      aliases: true,
    }),
  });
  validate(evidence, evidenceSchema, "public hosted platform evidence");
  return evidence;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

export function githubWorkflowFromEnvironment(environment, verified) {
  const candidate = normalizeCandidate(verified);
  if (
    environment.GITHUB_ACTIONS !== "true" || environment.CI !== "true" ||
    requiredEnvironment(environment, "GITHUB_SERVER_URL") !== "https://github.com" ||
    requiredEnvironment(environment, "GITHUB_SHA") !== candidate.commit ||
    requiredEnvironment(environment, "GITHUB_REPOSITORY") !== REPOSITORY
  ) fail("process is not the verified public GitHub Actions candidate");
  const workflowRef = requiredEnvironment(environment, "GITHUB_WORKFLOW_REF");
  if (workflowRef !== WORKFLOW_REF) {
    fail("GITHUB_WORKFLOW_REF is not the public candidate workflow");
  }
  const workflowSha = requiredEnvironment(environment, "GITHUB_WORKFLOW_SHA");
  if (workflowSha !== candidate.commit) {
    fail("GITHUB_WORKFLOW_SHA does not match the verified public candidate commit");
  }
  const runId = requiredEnvironment(environment, "GITHUB_RUN_ID");
  const attemptText = requiredEnvironment(environment, "GITHUB_RUN_ATTEMPT");
  return normalizeWorkflow({
    provider: "github-actions",
    repository: REPOSITORY,
    workflowPath: WORKFLOW_PATH,
    workflowRef,
    workflowSha,
    runId,
    runAttempt: Number(attemptText),
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${attemptText}`,
    trigger: requiredEnvironment(environment, "GITHUB_EVENT_NAME"),
  });
}

export function githubRunnerFromEnvironment(environment, label) {
  return normalizeRunner({
    environment: requiredEnvironment(environment, "OPEN_RFC_RUNNER_ENVIRONMENT"),
    label,
    os: requiredEnvironment(environment, "RUNNER_OS"),
    arch: requiredEnvironment(environment, "RUNNER_ARCH"),
    platform: process.platform,
    machineArch: process.arch,
    resolvedImage: requiredEnvironment(environment, "OPEN_RFC_IMAGE_OS"),
    resolvedImageVersion: requiredEnvironment(environment, "OPEN_RFC_IMAGE_VERSION"),
    imageMetadataSource: "github-runner-image-environment",
  });
}

function parseFlags(arguments_) {
  if (arguments_.length % 2 !== 0) fail("CLI flags must be --name value pairs");
  const flags = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!/^--[a-z-]+$/u.test(name ?? "") || value?.startsWith("--")) {
      fail("CLI flags must be --name value pairs");
    }
    if (flags.has(name)) fail(`duplicate CLI flag ${name}`);
    flags.set(name, value);
  }
  return flags;
}

function exactFlags(flags, expected) {
  if (JSON.stringify([...flags.keys()].sort()) !== JSON.stringify([...expected].sort())) {
    fail(`CLI flags must be exactly ${[...expected].sort().join(", ")}`);
  }
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, prettyBytes(value), { flag: "wx", mode: 0o600 });
}

async function createCell(flags, environment) {
  exactFlags(flags, [
    "--artifact-directory", "--commit", "--output-directory", "--publication-mode",
    "--requested-node", "--runner-label",
  ]);
  const commit = boundCommit(flags.get("--commit"));
  const mode = normalizeMode(flags.get("--publication-mode"));
  const artifactDirectory = resolve(flags.get("--artifact-directory"));
  const outputDirectory = resolve(flags.get("--output-directory"));
  const requestedNode = flags.get("--requested-node");
  const runnerLabel = flags.get("--runner-label");
  const before = await verifyCandidateBundle(artifactDirectory, DEFAULT_ROOT, {
    commit,
    publicationMode: mode,
  });
  const normalizedBefore = normalizeCandidate(before);
  const workflow = githubWorkflowFromEnvironment(environment, before);
  const runner = githubRunnerFromEnvironment(environment, runnerLabel);
  normalizeRuntime(requestedNode, process.version);
  const npm = resolvePinnedNpmToolchain({ environment });
  const argv = [process.execPath, fileURLToPath(import.meta.url), "cell", ...[...flags]
    .flatMap(([name, value]) => [name, value])];
  const startedAt = new Date().toISOString();
  const compatibility = await runPackedCompatibility({
    rootDirectory: DEFAULT_ROOT,
    artifactDirectory,
    skipBuild: true,
    environment,
    npmInvocation: { command: npm.command, argumentsPrefix: npm.argumentsPrefix },
    publicationMode: mode,
  });
  const finishedAt = new Date().toISOString();
  const after = await verifyCandidateBundle(artifactDirectory, DEFAULT_ROOT, {
    commit,
    publicationMode: mode,
  });
  same(normalizeCandidate(after), normalizedBefore, "candidate before and after cell");
  const cell = buildPublicHostedPlatformCell({
    verified: before,
    compatibility,
    workflow,
    runner,
    requestedNode,
    nodeVersion: process.version,
    command: { argv, startedAt, finishedAt, exitCode: 0 },
  });
  const filename = publicHostedPlatformCellFilename(
    cell.runtime.nodeMajor,
    cell.runner.platform,
    cell.runner.machineArch,
  );
  await writeExclusive(join(outputDirectory, filename), cell);
  return Object.freeze({ status: "passed", filename });
}

async function readCells(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("cell directory is unavailable");
  }
  if (
    entries.length !== 2 ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) fail("cell directory must contain exactly two regular files");
  const cells = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    const before = await lstat(path, { bigint: true });
    if (before.size < 1n || before.size > BigInt(MAX_CELL_BYTES)) {
      fail(`${entry.name} exceeds the cell byte bound`);
    }
    const bytes = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (
      BigInt(bytes.length) !== before.size || after.ino !== before.ino ||
      after.dev !== before.dev || after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) fail(`${entry.name} changed during its bounded read`);
    let cell;
    try {
      cell = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${entry.name} is not valid JSON`);
    }
    if (!bytes.equals(prettyBytes(cell))) fail(`${entry.name} is not canonical output JSON`);
    validatePublicCell(cell, entry.name);
    const expected = publicHostedPlatformCellFilename(
      cell.runtime.nodeMajor,
      cell.runner.platform,
      cell.runner.machineArch,
    );
    if (entry.name !== expected) fail(`${entry.name} differs from its cell coordinate`);
    cells.push(cell);
  }
  return Object.freeze(cells);
}

async function aggregate(flags) {
  exactFlags(flags, [
    "--artifact-directory", "--cells-directory", "--commit", "--output-directory",
    "--publication-mode",
  ]);
  const commit = boundCommit(flags.get("--commit"));
  const mode = normalizeMode(flags.get("--publication-mode"));
  const artifactDirectory = resolve(flags.get("--artifact-directory"));
  const cellsDirectory = resolve(flags.get("--cells-directory"));
  const outputDirectory = resolve(flags.get("--output-directory"));
  const before = await verifyCandidateBundle(artifactDirectory, DEFAULT_ROOT, {
    commit,
    publicationMode: mode,
  });
  const cells = await readCells(cellsDirectory);
  const evidence = aggregatePublicHostedPlatformCells({ cells, verified: before });
  const after = await verifyCandidateBundle(artifactDirectory, DEFAULT_ROOT, {
    commit,
    publicationMode: mode,
  });
  same(normalizeCandidate(after), normalizeCandidate(before), "candidate during aggregation");
  await writeExclusive(join(outputDirectory, EVIDENCE_FILENAME), evidence);
  return Object.freeze({
    status: "passed",
    filename: EVIDENCE_FILENAME,
    cells: evidence.cells.length,
    releaseSetSha256: evidence.candidate.releaseSetSha256,
  });
}

async function main(arguments_, environment = process.env) {
  const [command, ...rest] = arguments_;
  const flags = parseFlags(rest);
  if (command === "cell") return await createCell(flags, environment);
  if (command === "aggregate") return await aggregate(flags);
  fail("usage: public_hosted_platform_evidence.mjs <cell|aggregate> --flags");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "public hosted platform evidence failed"}\n`);
    process.exitCode = 1;
  }
}
