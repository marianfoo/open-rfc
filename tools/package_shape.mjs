#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPackedManifest,
  inspectPackedArchive,
  runBoundedCommand,
} from "./packed_compatibility.mjs";
import {
  pinnedNpmArguments,
  resolvePinnedNpmToolchain,
} from "./pinned_npm.mjs";
import {
  assertPublicationManifestProfile,
  normalizePublicationMode,
} from "./publication_safety.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(TOOL_DIRECTORY, "..");
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const PACKAGE_SHAPE_TOOL_VERSIONS = Object.freeze({
  publint: "0.3.22",
  "@arethetypeswrong/cli": "0.18.5",
});

const TOOL_SPECS = Object.freeze({
  publint: Object.freeze({
    manifestPath: "node_modules/publint/package.json",
    expectedBin: Object.freeze({ publint: "./src/cli.js" }),
  }),
  "@arethetypeswrong/cli": Object.freeze({
    manifestPath: "node_modules/@arethetypeswrong/cli/package.json",
    expectedBin: Object.freeze({ attw: "./dist/index.js" }),
  }),
});

export class PackageShapeError extends Error {
  constructor(message) {
    super(`package shape: ${message}`);
    this.name = "PackageShapeError";
  }
}

function fail(message) {
  throw new PackageShapeError(message);
}

/** Derive the only reviewed package-shape profile and bind any explicit override to it. */
export function resolvePackageShapePublicationMode(manifest, requestedMode) {
  let derivedMode;
  if (manifest?.private === true && manifest.license === "UNLICENSED") {
    derivedMode = "private";
  } else if (manifest?.private === false && manifest.license === "Apache-2.0") {
    derivedMode = "public-license-preflight";
  } else {
    fail("root manifest does not match a reviewed private or public package-shape profile");
  }

  let publicationMode = derivedMode;
  if (requestedMode !== undefined) {
    try {
      publicationMode = normalizePublicationMode(requestedMode);
    } catch (error) {
      fail(error instanceof Error ? error.message : "publication mode is invalid");
    }
    if (publicationMode !== derivedMode) {
      fail(
        `explicit publication mode ${publicationMode} contradicts ` +
          `manifest-derived ${derivedMode}`,
      );
    }
  }

  try {
    assertPublicationManifestProfile(manifest, {
      mode: publicationMode,
      label: "root manifest",
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "root manifest profile is invalid");
  }
  return publicationMode;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableFileIdentity(information) {
  return Object.freeze({
    dev: information.dev,
    ino: information.ino,
    nlink: information.nlink,
    size: information.size,
    mtimeNs: information.mtimeNs,
    ctimeNs: information.ctimeNs,
    mode: information.mode,
  });
}

function sameStableFileIdentity(information, identity) {
  return (
    information.isFile() &&
    !information.isSymbolicLink() &&
    information.dev === identity.dev &&
    information.ino === identity.ino &&
    information.nlink === identity.nlink &&
    information.size === identity.size &&
    information.mtimeNs === identity.mtimeNs &&
    information.ctimeNs === identity.ctimeNs &&
    information.mode === identity.mode
  );
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

async function readStableCandidate(path, label) {
  let descriptor;
  let result;
  let failure;
  try {
    descriptor = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = await descriptor.stat({ bigint: true });
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size < 1n || before.size > BigInt(MAX_ARTIFACT_BYTES)
    ) {
      fail(`${label} must be one bounded regular non-symlink single-link file`);
    }
    const identity = stableFileIdentity(before);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      BigInt(bytes.length) !== before.size ||
      !sameStableFileIdentity(after, identity) ||
      !sameStableFileIdentity(pathAfter, identity)
    ) {
      fail(`${label} changed during its bounded read`);
    }
    result = Object.freeze({ bytes, identity });
  } catch (error) {
    failure = error instanceof PackageShapeError
      ? error
      : new PackageShapeError(
        `${label} must be one bounded regular non-symlink single-link file`,
      );
  }
  if (descriptor !== undefined) {
    try {
      await descriptor.close();
    } catch {
      failure ??= new PackageShapeError(`${label} could not be closed safely`);
    }
  }
  if (failure !== undefined) throw failure;
  return result;
}

function environmentCandidateBinding(environment) {
  const path = environment.OPEN_RFC_CANDIDATE_TARBALL;
  const digest = environment.OPEN_RFC_CANDIDATE_TARBALL_SHA256;
  if (path === undefined && digest === undefined) return undefined;
  if (
    typeof path !== "string" || path.length === 0 ||
    typeof digest !== "string" || digest.length === 0
  ) {
    fail("candidate tarball path and SHA-256 must be provided together");
  }
  if (
    !isAbsolute(path) || resolve(path) !== path ||
    /[\u0000-\u001f\u007f]/u.test(path) || !basename(path).endsWith(".tgz")
  ) {
    fail("candidate tarball path must be an absolute normalized .tgz path");
  }
  if (!PREFIXED_SHA256.test(digest)) {
    fail("candidate tarball SHA-256 must be sha256:<64 lowercase hex>");
  }
  return Object.freeze({ path, sha256: digest.slice("sha256:".length) });
}

async function assertCandidateUnchanged(path, expected, label) {
  const current = await readStableCandidate(path, label);
  if (
    !sameFileIdentity(current.identity, expected.identity) ||
    sha256(current.bytes) !== expected.sha256 ||
    !current.bytes.equals(expected.bytes)
  ) {
    fail(`${label} changed during package-shape validation`);
  }
}

async function cleanupTemporaryDirectory(path) {
  let failed = false;
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    failed = true;
  }
  try {
    await lstat(path);
    failed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") failed = true;
  }
  if (failed) fail("temporary package-shape workspace cleanup failed");
}

function baseEnvironment(source, npmrc) {
  const environment = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return {
    ...environment,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: npmrc,
  };
}

async function readBoundedJson(path, label) {
  let file;
  try {
    file = await lstat(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > MAX_MANIFEST_BYTES) {
    fail(`${label} is not a bounded regular file`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function assertPackageJsonExport(manifest, label) {
  if (manifest?.exports?.["./package.json"] !== "./package.json") {
    fail(`${label} must export ./package.json exactly`);
  }
  return true;
}

export function assertPackageShapeDependencies(manifest) {
  for (const [name, version] of Object.entries(PACKAGE_SHAPE_TOOL_VERSIONS)) {
    if (manifest?.devDependencies?.[name] !== version) {
      fail(`${name} must be an exact devDependency at ${version}`);
    }
    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (manifest?.[group]?.[name] !== undefined) {
        fail(`${name} must not be present in ${group}`);
      }
    }
  }
  return true;
}

async function resolveTool(root, name) {
  const specification = TOOL_SPECS[name];
  const manifestPath = join(root, specification.manifestPath);
  const manifest = await readBoundedJson(manifestPath, `${name} installed manifest`);
  if (
    manifest.name !== name ||
    manifest.version !== PACKAGE_SHAPE_TOOL_VERSIONS[name]
  ) {
    fail(`${name} installation does not match the locked package identity`);
  }
  assert.deepEqual(manifest.bin, specification.expectedBin, `${name} CLI path drifted`);
  const relativeBin = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin[name === "publint" ? "publint" : "attw"];
  if (typeof relativeBin !== "string") {
    fail(`${name} CLI path is missing from its installed manifest`);
  }
  const binPath = await realpath(resolve(dirname(manifestPath), relativeBin));
  const bin = await stat(binPath);
  if (!bin.isFile()) fail(`${name} CLI is not a regular file`);
  return Object.freeze({ binPath, version: manifest.version });
}

function parsePackResult(stdout, expectedName, expectedVersion) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    fail(`${expectedName} npm pack output is not JSON`);
  }
  if (!Array.isArray(result) || result.length !== 1) {
    fail(`${expectedName} npm pack must report exactly one artifact`);
  }
  const item = result[0];
  if (item?.name !== expectedName || item?.version !== expectedVersion) {
    fail(`${expectedName} npm pack identity drifted`);
  }
  if (
    typeof item.filename !== "string" ||
    item.filename.length === 0 ||
    item.filename.includes("/") ||
    !Array.isArray(item.files) ||
    item.files.length === 0
  ) {
    fail(`${expectedName} npm pack report is malformed`);
  }
  return item;
}

async function runTool(nodePath, tool, arguments_, options) {
  try {
    const result = await options.runCommand(nodePath, [tool.binPath, ...arguments_], {
      cwd: options.cwd,
      env: options.environment,
      maxOutputBytes: 4 * 1024 * 1024,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.stderr.trim() !== "") {
      fail(`${options.label} wrote unexpected standard error`);
    }
    return result;
  } catch (error) {
    if (error instanceof PackageShapeError) throw error;
    fail(`${options.label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateArtifactWithTools({
  artifactPath,
  attw,
  entrypoints,
  environment,
  label,
  nodePath,
  publint,
  runCommand,
  verifyArtifact,
}) {
  const publintResult = await runTool(
    nodePath,
    publint,
    [artifactPath, "--strict"],
    {
      cwd: dirname(artifactPath),
      environment,
      label: `${label} publint`,
      runCommand,
    },
  );
  if (!/All good!/u.test(publintResult.stdout)) {
    fail(`${label} publint did not report a clean package`);
  }
  await verifyArtifact?.();
  const attwResult = await runTool(
    nodePath,
    attw,
    [
      artifactPath,
      "--quiet",
      "--profile",
      "strict",
      "--no-definitely-typed",
      "--no-summary",
      "--no-color",
      "--no-emoji",
      "--entrypoints",
      ...entrypoints,
    ],
    {
      cwd: dirname(artifactPath),
      environment,
      label: `${label} attw`,
      runCommand,
    },
  );
  if (attwResult.stdout !== "") {
    fail(`${label} attw quiet mode wrote unexpected output`);
  }
  await verifyArtifact?.();
}

export async function runPackageShape(options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const sourceEnvironment = options.environment ?? process.env;
  const rootManifest = await readBoundedJson(join(root, "package.json"), "root manifest");
  assertPackageJsonExport(rootManifest, "open-rfc");
  assertPackageShapeDependencies(rootManifest);
  if (rootManifest.name !== "open-rfc") {
    fail("qualifier root package identity must be exactly open-rfc");
  }
  const candidateBinding = environmentCandidateBinding(sourceEnvironment);
  const legacyPublicationMode = candidateBinding === undefined
    ? resolvePackageShapePublicationMode(rootManifest, options.publicationMode)
    : undefined;
  const runCommand = options.runCommand ?? runBoundedCommand;
  if (typeof runCommand !== "function") fail("package-shape command runner is invalid");

  const npm = resolvePinnedNpmToolchain({
    environment: sourceEnvironment,
  });
  const [publint, attw] = await Promise.all([
    resolveTool(root, "publint"),
    resolveTool(root, "@arethetypeswrong/cli"),
  ]);
  const temporary = await mkdtemp(join(tmpdir(), "open-rfc-package-shape-"));
  let candidateInvariant;
  try {
    const npmrc = join(temporary, "isolated.npmrc");
    await writeFile(npmrc, "", { flag: "wx", mode: 0o600 });
    const environment = baseEnvironment(sourceEnvironment, npmrc);

    if (candidateBinding !== undefined) {
      const source = await readStableCandidate(
        candidateBinding.path,
        "supplied candidate tarball",
      );
      if (sha256(source.bytes) !== candidateBinding.sha256) {
        fail("candidate tarball SHA-256 differs from its environment binding");
      }
      const inspected = inspectPackedArchive(source.bytes);
      const candidateManifest = inspected.packageManifest;
      if (
        candidateManifest.name !== rootManifest.name ||
        typeof candidateManifest.version !== "string" ||
        !PACKAGE_VERSION.test(candidateManifest.version)
      ) {
        fail("candidate tarball package identity is invalid");
      }
      const publicationMode = resolvePackageShapePublicationMode(
        candidateManifest,
        options.publicationMode,
      );
      assertPackageJsonExport(candidateManifest, "packed open-rfc");
      try {
        assertPackedManifest(
          candidateManifest,
          rootManifest.name,
          candidateManifest.version,
          publicationMode,
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : "candidate package identity is invalid");
      }

      const snapshotPath = join(temporary, "candidate.tgz");
      await writeFile(snapshotPath, source.bytes, { flag: "wx", mode: 0o600 });
      const snapshot = await readStableCandidate(
        snapshotPath,
        "private candidate snapshot",
      );
      if ((snapshot.identity.mode & 0o777n) !== 0o600n) {
        fail("private candidate snapshot must have mode 0600");
      }
      if (
        sha256(snapshot.bytes) !== candidateBinding.sha256 ||
        !snapshot.bytes.equals(source.bytes)
      ) {
        fail("private candidate snapshot differs from its bound source");
      }
      const expectedSource = Object.freeze({
        ...source,
        sha256: candidateBinding.sha256,
      });
      const expectedSnapshot = Object.freeze({
        ...snapshot,
        sha256: candidateBinding.sha256,
      });
      await assertCandidateUnchanged(
        candidateBinding.path,
        expectedSource,
        "supplied candidate tarball",
      );
      await assertCandidateUnchanged(
        snapshotPath,
        expectedSnapshot,
        "private candidate snapshot",
      );
      candidateInvariant = async () => {
        await assertCandidateUnchanged(
          candidateBinding.path,
          expectedSource,
          "supplied candidate tarball",
        );
        await assertCandidateUnchanged(
          snapshotPath,
          expectedSnapshot,
          "private candidate snapshot",
        );
      };

      await validateArtifactWithTools({
        artifactPath: snapshotPath,
        attw,
        entrypoints: [".", "./package.json"],
        environment,
        label: "open-rfc",
        nodePath: npm.nodePath,
        publint,
        runCommand,
        verifyArtifact: candidateInvariant,
      });

      await assertCandidateUnchanged(
        candidateBinding.path,
        expectedSource,
        "supplied candidate tarball",
      );
      await assertCandidateUnchanged(
        snapshotPath,
        expectedSnapshot,
        "private candidate snapshot",
      );

      return Object.freeze({
        schemaVersion: 1,
        publicationMode,
        npmVersion: npm.npmVersion,
        toolVersions: Object.freeze({
          publint: publint.version,
          "@arethetypeswrong/cli": attw.version,
        }),
        packages: Object.freeze([
          Object.freeze({
            name: candidateManifest.name,
            version: candidateManifest.version,
            filename: `${candidateManifest.name}-${candidateManifest.version}.tgz`,
            sha256: candidateBinding.sha256,
            fileCount: inspected.paths.length,
            packageJsonExport: true,
            entrypoints: Object.freeze(["."]),
            publint: "passed",
            attw: "passed",
          }),
        ]),
        publicationAttempted: false,
      });
    }

    const publicationMode = legacyPublicationMode;
    if (options.skipBuild !== true) {
      await runCommand(
        npm.command,
        pinnedNpmArguments(npm, ["run", "build", "--silent"]),
        {
          cwd: root,
          env: environment,
          maxOutputBytes: 4 * 1024 * 1024,
          timeoutMs: COMMAND_TIMEOUT_MS,
        },
      );
    }

    const rootPack = await runCommand(
      npm.command,
      pinnedNpmArguments(npm, [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporary,
      ]),
      {
        cwd: root,
        env: environment,
        maxOutputBytes: 4 * 1024 * 1024,
        timeoutMs: COMMAND_TIMEOUT_MS,
      },
    );
    const rootItem = parsePackResult(rootPack.stdout, rootManifest.name, rootManifest.version);
    const rootArtifactPath = join(temporary, rootItem.filename);
    const rootArtifactBytes = await readFile(rootArtifactPath);
    if (rootArtifactBytes.length < 1 || rootArtifactBytes.length > MAX_ARTIFACT_BYTES) {
      fail("open-rfc artifact is outside the package-shape size envelope");
    }
    const inspectedRoot = inspectPackedArchive(rootArtifactBytes, {
      packFiles: rootItem.files,
    });
    assertPackageJsonExport(inspectedRoot.packageManifest, "packed open-rfc");
    try {
      assertPublicationManifestProfile(inspectedRoot.packageManifest, {
        mode: publicationMode,
        label: "packed open-rfc manifest",
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "packed manifest profile is invalid");
    }
    if (
      inspectedRoot.packageManifest.name !== rootManifest.name ||
      inspectedRoot.packageManifest.version !== rootManifest.version
    ) {
      fail("packed open-rfc manifest identity drifted");
    }

    await validateArtifactWithTools({
      artifactPath: rootArtifactPath,
      attw,
      entrypoints: [".", "./package.json"],
      environment,
      label: "open-rfc",
      nodePath: npm.nodePath,
      publint,
      runCommand,
    });

    return Object.freeze({
      schemaVersion: 1,
      publicationMode,
      npmVersion: npm.npmVersion,
      toolVersions: Object.freeze({
        publint: publint.version,
        "@arethetypeswrong/cli": attw.version,
      }),
      packages: Object.freeze([
        Object.freeze({
          name: rootManifest.name,
          version: rootManifest.version,
          filename: rootItem.filename,
          sha256: sha256(rootArtifactBytes),
          fileCount: inspectedRoot.paths.length,
          packageJsonExport: true,
          entrypoints: Object.freeze(["."]),
          publint: "passed",
          attw: "passed",
        }),
      ]),
      publicationAttempted: false,
    });
  } finally {
    try {
      await candidateInvariant?.();
    } finally {
      await cleanupTemporaryDirectory(temporary);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let publicationMode;
    if (args[0] === "--publication-mode" && args.length === 2) {
      publicationMode = args[1];
      args.splice(0, 2);
    }
    if (args.length !== 0) {
      fail(
        "usage: node tools/package_shape.mjs " +
        "[--publication-mode private|public-license-preflight]",
      );
    }
    const result = await runPackageShape({ publicationMode });
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
