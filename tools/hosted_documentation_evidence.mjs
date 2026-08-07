#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  checkCandidateDocsSite,
  docsBuildEnvironment,
  resolveDocsPythonExecutable,
} from "./docs_site.mjs";
import {
  githubRunnerFromEnvironment,
  githubWorkflowFromEnvironment,
} from "./public_hosted_platform_evidence.mjs";
import publicEvidenceSchema from
  "../conformance/schemas/public-hosted-documentation-evidence-v1.schema.json" with { type: "json" };

import { validateJsonSchemaSubset } from "./json_schema_subset.mjs";
import { verifyCandidateBundle } from "./verify_candidate_bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = "public-hosted-documentation-evidence.v1.json";
const REQUIREMENTS_PATH = "requirements-docs.txt";
const PUBLICATION_MODES = new Set(["private", "public-license-preflight"]);
const PUBLICATION_MODE = "public-license-preflight";
const PRIVATE_MODE = "private";
const PYTHON_BOOTSTRAP_DISTRIBUTION = "pip";
const SAFE_LOGICAL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/-]+$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(`hosted documentation evidence: ${message}`);
}

function boundCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    fail("commit must be an explicit full SHA-1");
  }
  return value;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`);
}

export function invocationSha256(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length < 2 ||
    arguments_.length > 64 ||
    arguments_.some((value) =>
      typeof value !== "string" || value.length > 16_384 || value.includes("\0"))
  ) fail("command arguments are outside the bounded invocation contract");
  return sha256(Buffer.from(JSON.stringify(arguments_)));
}

export function exactDocumentationClosure(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || text.includes("\r") || !text.endsWith("\n")) {
    fail("requirements-docs.txt must be canonical UTF-8 with LF endings");
  }
  const requirements = text.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  if (
    requirements.length !== 29 ||
    requirements.some((line) =>
      !/^[a-z0-9-]+==[0-9A-Za-z.]+ --hash=sha256:[a-f0-9]{64}$/u.test(line)) ||
    new Set(requirements.map((line) => line.slice(0, line.indexOf("==")))).size !== 29
  ) fail("requirements-docs.txt differs from the exact 29-wheel hash-pinned closure");
  return Object.freeze({
    requirements: Object.freeze(requirements),
    sha256: sha256(bytes),
  });
}

function successfulPython(pythonExecutable, arguments_, label, environment) {
  const temporaryHome = mkdtempSync(join(tmpdir(), "open-rfc-hosted-docs-"));
  try {
    const result = spawnSync(pythonExecutable, arguments_, {
      cwd: ROOT,
      encoding: "utf8",
      env: docsBuildEnvironment(environment, { temporaryHome }),
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined || result.status !== 0) fail(`${label} failed`);
    return (result.stdout ?? "").trim();
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
}

function isWithinRoot(root, path) {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function exactInstalledDocumentationClosure(installed, closure, pipVersion) {
  if (
    installed === null || typeof installed !== "object" || Array.isArray(installed) ||
    typeof pipVersion !== "string" || pipVersion.length === 0
  ) fail("the installed documentation dependency inventory is invalid");
  const expected = new Map();
  for (const requirement of closure.requirements) {
    const [name, remainder] = requirement.split("==");
    expected.set(name, remainder.slice(0, remainder.indexOf(" ")));
  }
  const installedNames = Object.keys(installed).sort();
  const expectedNames = [...expected.keys(), PYTHON_BOOTSTRAP_DISTRIBUTION].sort();
  if (JSON.stringify(installedNames) !== JSON.stringify(expectedNames)) {
    fail("the Python environment contains distributions outside the exact documentation closure");
  }
  if (installed[PYTHON_BOOTSTRAP_DISTRIBUTION] !== pipVersion) {
    fail("the bootstrap pip distribution differs from the selected runtime");
  }
  const installedClosure = [];
  for (const [name, version] of expected) {
    if (installed[name] !== version) {
      fail("the installed documentation closure differs from requirements-docs.txt");
    }
    installedClosure.push(`${name}==${version}`);
  }
  return Object.freeze({
    installedCount: installedClosure.length,
    installedSha256: sha256(Buffer.from(`${installedClosure.join("\n")}\n`)),
  });
}

function verifyPythonClosure(pythonExecutable, closure, environment) {
  const runtime = JSON.parse(successfulPython(
    pythonExecutable,
    [
      "-c",
      "import importlib.metadata as m,json,os,pip,platform,sys; " +
        "print(json.dumps({'implementation':platform.python_implementation()," +
        "'version':platform.python_version(),'executable':os.path.realpath(sys.executable)," +
        "'prefix':os.path.realpath(sys.prefix),'pipModule':os.path.realpath(pip.__file__)," +
        "'pipVersion':m.version('pip')},sort_keys=True))",
    ],
    "Python runtime check",
    environment,
  ));
  if (runtime.implementation !== "CPython" || runtime.version !== "3.13.14") {
    fail("the hosted documentation runtime must be CPython 3.13.14");
  }
  if (
    typeof runtime.executable !== "string" || typeof runtime.prefix !== "string" ||
    typeof runtime.pipModule !== "string" || typeof runtime.pipVersion !== "string" ||
    !isWithinRoot(runtime.prefix, runtime.executable) ||
    !isWithinRoot(runtime.prefix, runtime.pipModule)
  ) fail("python -m pip is not bound to the selected CPython runtime");
  successfulPython(
    pythonExecutable,
    ["-m", "pip", "--disable-pip-version-check", "check"],
    "pip dependency check",
    environment,
  );
  const installed = JSON.parse(successfulPython(
    pythonExecutable,
    [
      "-c",
      "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()},sort_keys=True))",
    ],
    "installed documentation dependency inventory",
    environment,
  ));
  const installedClosure = exactInstalledDocumentationClosure(
    installed,
    closure,
    runtime.pipVersion,
  );
  return Object.freeze({
    implementation: runtime.implementation,
    version: runtime.version,
    pipVersion: runtime.pipVersion,
    pipBoundToRuntime: true,
    installedCount: installedClosure.installedCount,
    installedSha256: installedClosure.installedSha256,
  });
}

function flags(arguments_) {
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!/^--[a-z-]+$/u.test(name ?? "") || value === undefined || parsed.has(name)) {
      fail("CLI flags must be unique --name value pairs");
    }
    parsed.set(name, value);
  }
  const required = [
    "--artifact-directory", "--commit", "--output-directory", "--publication-mode",
    "--runner-label",
  ];
  if (parsed.size !== required.length || required.some((name) => !parsed.has(name))) {
    fail(`CLI flags must be exactly ${required.join(", ")}`);
  }
  if (parsed.get("--publication-mode") !== PUBLICATION_MODE) {
    fail("the public hosted-documentation CLI accepts public-license-preflight only");
  }
  return parsed;
}

async function writeExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

function safeOutputPath(outputRoot, logicalPath) {
  if (!SAFE_LOGICAL_PATH.test(logicalPath)) fail("output path is unsafe");
  const path = resolve(outputRoot, logicalPath);
  if (path !== outputRoot && !path.startsWith(`${outputRoot}${sep}`)) fail("output path escapes its root");
  return path;
}

export function assertSameCandidateIdentity(before, after) {
  if (
    before === null || typeof before !== "object" || Array.isArray(before) ||
    after === null || typeof after !== "object" || Array.isArray(after)
  ) fail("candidate identity comparison requires two records");
  for (const key of ["commit", "filename", "sha256", "releaseSetSha256"]) {
    if (before[key] !== after[key]) {
      fail("candidate identity changed between admission and documentation build");
    }
  }
}

export async function runHostedDocumentationEvidence({
  artifactDirectory,
  commit,
  outputDirectory,
  runnerLabel,
  publicationMode = "private",
  environment = process.env,
  pythonExecutable = environment.OPEN_RFC_DOCS_PYTHON ?? "python",
  commandArguments = process.argv,
  writeOutput = true,
} = {}) {
  const boundCandidateCommit = boundCommit(commit);
  if (!PUBLICATION_MODES.has(publicationMode)) fail("publication mode is unsupported");
  if (publicationMode === PRIVATE_MODE && writeOutput) {
    fail("private observations cannot be written as public hosted-documentation receipts");
  }
  const startedAt = new Date().toISOString();
  const before = await verifyCandidateBundle(artifactDirectory, ROOT, {
    commit: boundCandidateCommit,
    publicationMode,
  });
  const workflowIdentity = githubWorkflowFromEnvironment(environment, before);
  const runner = githubRunnerFromEnvironment(environment, runnerLabel);
  const python = resolveDocsPythonExecutable(pythonExecutable, ROOT);
  const site = await checkCandidateDocsSite({
    candidateDirectory: artifactDirectory,
    commit: boundCandidateCommit,
    repositoryRoot: ROOT,
    environment,
    pythonExecutable: python,
    publicationMode,
  });
  assertSameCandidateIdentity(before, site.candidate);
  const closure = exactDocumentationClosure(site.source.requirements.bytes);
  const runtime = verifyPythonClosure(python, closure, environment);
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const candidate = Object.freeze({
    version: before.package.version,
    commit: before.commit,
    tarballSha256: `sha256:${before.sha256}`,
  });
  const observation = Object.freeze({
    releaseSet: Object.freeze({
      commit: before.commit,
      releaseSetSha256: `sha256:${before.releaseSetSha256}`,
      connector: Object.freeze({
        name: before.releaseSet.connector.package.name,
        version: before.releaseSet.connector.package.version,
        filename: before.releaseSet.connector.filename,
        sha256: `sha256:${before.releaseSet.connector.sha256}`,
        integrity: before.releaseSet.connector.integrity,
        bytes: before.releaseSet.connector.bytes,
        unpackedBytes: before.releaseSet.connector.unpackedBytes,
        fileCount: before.releaseSet.connector.fileCount,
        archiveInventorySha256:
          `sha256:${before.releaseSet.connector.archiveInventorySha256}`,
      }),
    }),
    workflow: Object.freeze({
      ...workflowIdentity,
      startedAt,
      finishedAt,
      conclusion: "success",
    }),
    runner,
    runtime: Object.freeze({
      nodeVersion: process.version,
      pythonImplementation: runtime.implementation,
      pythonVersion: runtime.version,
    }),
    dependencyClosure: Object.freeze({
      path: REQUIREMENTS_PATH,
      sha256: closure.sha256,
      count: closure.requirements.length,
      requireHashes: true,
      onlyBinary: true,
      pipCheck: true,
      pipVersion: runtime.pipVersion,
      pipBoundToRuntime: runtime.pipBoundToRuntime,
      installedCount: runtime.installedCount,
      installedSha256: runtime.installedSha256,
    }),
    source: Object.freeze({
      algorithm: "candidate-documentation-source-sha256-v1",
      commit: site.source.commit,
      fileCount: site.source.fileCount,
      sha256: `sha256:${site.source.sha256}`,
      configurationSha256: `sha256:${site.source.configurationSha256}`,
      requirementsSha256: `sha256:${site.source.requirementsSha256}`,
    }),
    site: Object.freeze({
      files: site.files,
      pages: site.pages,
      bytes: site.bytes,
      sha256: `sha256:${site.sha256}`,
      deterministic: site.deterministic,
      packageVersion: site.packageVersion,
      nodeEngine: site.nodeEngine,
    }),
    checks: Object.freeze({
      candidateVerifiedBeforeAfter: site.candidateVerifiedBeforeAfter,
      packageManifestFromArtifact: site.packageManifestFromArtifact,
      sourceInventory: true,
      privateReferencesAbsent: true,
      contentSecurityPolicy: true,
      links: true,
      deterministic: site.deterministic,
    }),
    command: Object.freeze({
      id: "hosted-documentation-site-v1",
      startedAt,
      finishedAt,
      durationMs,
      argvSha256: invocationSha256(commandArguments),
      exitCode: 0,
    }),
    conclusion: "success",
  });
  let source;
  if (publicationMode === PUBLICATION_MODE) {
    source = Object.freeze({
      $schema: "../../conformance/schemas/public-hosted-documentation-evidence-v1.schema.json",
      schemaVersion: 1,
      kind: "public-hosted-documentation-evidence",
      candidate,
      ...observation,
    });
    validateJsonSchemaSubset(source, publicEvidenceSchema, "hosted documentation receipt");
    if (writeOutput) {
      const outputRoot = resolve(outputDirectory);
      await mkdir(outputRoot, { mode: 0o700 });
      await writeExclusive(safeOutputPath(outputRoot, SOURCE_PATH), jsonBytes(source));
    }
  }
  return Object.freeze({
    status: "passed",
    sourcePath: SOURCE_PATH,
    releaseSetSha256: before.releaseSetSha256,
    siteSha256: site.sha256,
    candidate,
    observation,
    ...(source === undefined ? {} : { source }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = flags(process.argv.slice(2));
    const result = await runHostedDocumentationEvidence({
      artifactDirectory: resolve(parsed.get("--artifact-directory")),
      commit: parsed.get("--commit"),
      outputDirectory: resolve(parsed.get("--output-directory")),
      runnerLabel: parsed.get("--runner-label"),
      publicationMode: parsed.get("--publication-mode"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "hosted documentation evidence failed"}\n`);
    process.exitCode = 1;
  }
}
