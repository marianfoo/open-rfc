#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import releaseArtifactGateSchema from
  "../conformance/schemas/release-artifact-gate-v1.schema.json" with { type: "json" };

import {
  CONNECTOR_ARCHIVE_ENVELOPE,
  computeReleaseSetSha256,
  npmPackageTarballFilename,
  parseCanonicalNpmTarball,
} from "./release_set_contract.mjs";
import {
  validateJsonSchemaSubset,
} from "./json_schema_subset.mjs";
import {
  PUBLISHABLE_REF_SCOPE_POLICY,
  assertGitRefObjectInventory,
  assertGitRefObjectInventoryAfterVersionTag,
  assertPublishableGitRefScopeAfterVersionTag,
  readGitRefObjectInventory,
  readGitRefObjectInventoryAfterVersionTag,
  readPublishableGitRefScope,
  readPublishableGitRefScopeAfterVersionTag,
} from "./git_ref_inventory.mjs";
import {
  assertPublicationManifestProfile,
  CONVENTIONAL_LEGAL_PATHS,
  hasThirdPartyNoticePath,
  isApprovedApache2LicenseBytes,
  normalizePublicationMode,
  publicationEnvironmentSecrets,
  publicationSecretPatternIndex,
  spdxLicenseFromManifest,
} from "./publication_safety.mjs";
import {
  OPEN_RFC_PACKAGED_README_HTTPS_TARGETS,
  PackagedReadmeLinkError,
  assertPackagedReadmeLinks,
} from "./packaged_readme_links.mjs";
import {
  runBoundedCommand,
} from "./release_artifact_gate.mjs";
import {
  pinnedNpmArguments,
  resolvePinnedNpmToolchain,
} from "./pinned_npm.mjs";
import {
  resolveTrustedGitPath,
  runTrustedGit,
  trustedGitArguments,
  trustedGitEnvironment,
} from "./trusted_git.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(TOOL_DIRECTORY, "..");
const RESULT_NAME = "release-artifact-gate.v1.json";
const SBOM_NAME = "sbom.spdx.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SOURCE_BINDING_TIMEOUT_MS = 180_000;
const SOURCE_BINDING_COMMAND_BYTES = 16 * 1024 * 1024;
const SOURCE_BINDING_TYPESCRIPT_VERSION = "5.9.3";
const CONNECTOR_REQUIRED_FILES = Object.freeze([
  "NOTICE",
  "README.md",
  "package.json",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/cjs/index.d.ts",
  "dist/cjs/index.js",
  "dist/cjs/package.json",
]);
const EXPECTED_CONNECTOR_PACKAGE_FILES = Object.freeze([
  "dist/src",
  "dist/cjs",
  "README.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
]);
const EXPECTED_CONNECTOR_ENGINES = Object.freeze({
  node: "^22.14.0 || ^24.0.0",
});
const FORBIDDEN_CONNECTOR_PATH = /(?:^|[/._-])(?:capture|captures|oracle|nwrfcsdk|sapnwrfc|libsap|sapcrypto|credential|credentials|secret|secrets)(?:$|[/._-])/iu;
const FORBIDDEN_ARCHIVE_EXTENSION = /\.(?:7z|a|bz2|cap|cer|class|crt|der|dll|dylib|exe|gz|har|jar|key|lib|node|o|obj|p12|pcap|pcapng|pdb|pem|pfx|rar|so(?:\.\d+)*|tar|wasm|xz|zip)$/iu;
const NATIVE_MAGICS = Object.freeze([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0x00, 0x61, 0x73, 0x6d]),
  Buffer.from([0x4d, 0x5a]),
]);
const REQUIRED_RELEASE_CHECKS = Object.freeze([
  "allowlist",
  "cleanSourceSnapshots",
  "deterministicPack",
  "packageManifest",
  "noNativeArtifacts",
  "noSdkArtifacts",
  "tarballSecretScan",
  "trackedHistorySecretScan",
  "trackedHistorySecretAdmissionPolicy",
  "trackedPathHistoryScan",
  "runtimeImportBoundary",
  "sbom",
  "atomicPublication",
  "cooperativePublicationLock",
  "privatePublicationParent",
  "singlePackage",
  "releaseSetInventory",
  "atomicReleaseSet",
]);

export class CandidateBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "CandidateBundleError";
  }
}

function fail(message) {
  throw new CandidateBundleError(message);
}

function assertCandidatePackagedReadme(entries, options = {}) {
  try {
    return assertPackagedReadmeLinks(entries, options);
  } catch (error) {
    if (error instanceof PackagedReadmeLinkError) fail(error.message);
    fail("packaged README validation failed");
  }
}

function candidateEnvironmentSecrets(environment) {
  try {
    return publicationEnvironmentSecrets(environment);
  } catch (error) {
    fail(error instanceof Error ? error.message : "candidate environment is invalid");
  }
}

function candidatePublicationMode(value) {
  try {
    return normalizePublicationMode(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : "candidate publication mode is invalid");
  }
}

function candidatePostReleaseTag(value, expectedVersion, publicationMode) {
  if (value === undefined) return undefined;
  const expected = `v${expectedVersion}`;
  if (
    publicationMode !== "public-license-preflight" ||
    !/^v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value) ||
    value !== expected
  ) {
    fail("post-release verification requires the exact stable public package version tag");
  }
  return value;
}

function candidateManifestSpdxLicense(manifest, options) {
  try {
    return spdxLicenseFromManifest(manifest, options);
  } catch (error) {
    fail(error instanceof Error ? error.message : "candidate package manifest license is invalid");
  }
}

function candidateReleaseSetLicenseProfile(manifest, { mode, label }) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${label} source is invalid`);
  }
  const declaration = manifest.license;
  if (declaration === undefined) {
    return Object.freeze({
      license: candidateManifestSpdxLicense(manifest, {
        required: mode === "public-license-preflight",
        label,
      }),
    });
  }
  if (
    typeof declaration !== "string" ||
    declaration.length < 1 || declaration.length > 256 ||
    declaration !== declaration.trim() ||
    /[\u0000-\u001f\u007f]/u.test(declaration)
  ) {
    fail(`${label} is invalid`);
  }
  if (mode === "public-license-preflight") {
    const license = candidateManifestSpdxLicense(manifest, { required: true, label });
    if (license !== "Apache-2.0") {
      fail(`${label} must be exactly Apache-2.0 for public license preflight`);
    }
    return Object.freeze({
      license,
    });
  }
  try {
    return Object.freeze({
      license: spdxLicenseFromManifest(manifest, { label }),
    });
  } catch {
    return Object.freeze({
      license: "NOASSERTION",
      licenseComments: declaration,
    });
  }
}

function requireApprovedApache2LicenseEntry(entries, label) {
  const entry = entries.find(({ path }) => path === "package/LICENSE");
  if (entry === undefined) {
    fail(
      "public license preflight requires the bundled " +
      `Apache-2.0 LICENSE file in the ${label}`,
    );
  }
  if (!isApprovedApache2LicenseBytes(entry.bytes)) {
    fail(
      "public license preflight requires the exact bundled " +
      `Apache-2.0 LICENSE bytes in the ${label}`,
    );
  }
}

function releaseContract(operation, label) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CandidateBundleError) throw error;
    fail(`${label} failed release-set validation`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runSourceBindingCommand(command, arguments_, options) {
  try {
    const trustedGit = command === "git";
    return runBoundedCommand(
      trustedGit ? resolveTrustedGitPath() : command,
      trustedGit ? trustedGitArguments(options.cwd, arguments_) : arguments_,
      {
      timeout: SOURCE_BINDING_TIMEOUT_MS,
      maxBuffer: SOURCE_BINDING_COMMAND_BYTES,
      ...options,
      ...(trustedGit ? { env: trustedGitEnvironment(options.env) } : {}),
      },
    );
  } catch {
    fail(`${options.label} failed during independent source-artifact derivation`);
  }
}

function checkedSourceFile(path, maximumBytes, label) {
  let before;
  let bytes;
  let after;
  try {
    before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() || before.isSymbolicLink() || before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      fail(`${label} is outside its regular-file byte envelope`);
    }
    bytes = readFileSync(path);
    after = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof CandidateBundleError) throw error;
    fail(`${label} is unavailable for independent source-artifact derivation`);
  }
  if (!sameFileIdentity(after, fileIdentity(before)) || bytes.length !== Number(before.size)) {
    fail(`${label} changed during independent source-artifact derivation`);
  }
  return bytes;
}

function sourceBindingNpmCache(environment) {
  const requested = environment.npm_config_cache ??
    (process.platform === "win32"
      ? environment.LOCALAPPDATA === undefined
        ? undefined
        : join(environment.LOCALAPPDATA, "npm-cache")
      : environment.HOME === undefined
        ? undefined
        : join(environment.HOME, ".npm"));
  if (typeof requested !== "string" || requested.length === 0) {
    fail("npm cache is unavailable for independent source-artifact derivation");
  }
  try {
    const canonical = realpathSync(resolve(requested));
    const metadata = lstatSync(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid");
    return canonical;
  } catch {
    fail("npm cache is unavailable for independent source-artifact derivation");
  }
}

function sourceBindingEnvironment(environment, home, cache, dependencyRoot) {
  const child = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    if (environment[name] !== undefined) child[name] = environment[name];
  }
  const userConfig = join(home, ".npmrc");
  const globalConfig = join(home, "global.npmrc");
  writeFileSync(userConfig, "", { flag: "wx", mode: 0o600 });
  writeFileSync(globalConfig, "", { flag: "wx", mode: 0o600 });
  return {
    ...child,
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: "production",
    NODE_PATH: dependencyRoot,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_audit: "false",
    npm_config_cache: cache,
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfig,
    npm_config_ignore_scripts: "true",
    npm_config_prefer_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
  };
}

function npmPackArchive({
  cwd,
  destination,
  environment,
  envelope,
  label,
  npmToolchain,
}) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const output = runSourceBindingCommand(
    npmToolchain.command,
    pinnedNpmArguments(npmToolchain, [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ]),
    {
      cwd,
      env: environment,
      failureMode: "npm",
      label: `${label} npm pack`,
    },
  );
  let records;
  try {
    records = JSON.parse(output);
  } catch {
    fail(`${label} npm pack returned invalid JSON`);
  }
  if (!Array.isArray(records) || records.length !== 1) {
    fail(`${label} npm pack returned an invalid artifact count`);
  }
  const filename = safeFilename(records[0]?.filename, `${label} filename`);
  const bytes = checkedSourceFile(
    join(destination, filename),
    envelope.tarballBytes,
    `${label} independently packed archive`,
  );
  return releaseContract(
    () => parseCanonicalNpmTarball(bytes, envelope),
    `${label} independently packed archive`,
  );
}

/** Independently rebuild and repack the exact checked-out candidate commit. */
export function deriveCandidateSourceArchives(root, headCommit, environment = process.env) {
  if (!COMMIT.test(headCommit)) fail("source binding commit must be a full SHA-1");
  const repository = resolve(root);
  let dependencyRoot;
  try {
    dependencyRoot = realpathSync(join(repository, "node_modules"));
    const metadata = lstatSync(dependencyRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid");
  } catch {
    fail("build dependencies are unavailable for independent source-artifact derivation");
  }
  let npmToolchain;
  try {
    npmToolchain = resolvePinnedNpmToolchain({ environment });
  } catch {
    fail("pinned npm is unavailable for independent source-artifact derivation");
  }
  const npmCache = sourceBindingNpmCache(environment);
  let attemptRoot;
  try {
    const temporaryRoot = realpathSync(tmpdir());
    if (temporaryRoot === dependencyRoot ||
        temporaryRoot.startsWith(`${dependencyRoot}${sep}`)) {
      fail("temporary root must be outside build dependencies");
    }
    attemptRoot = mkdtempSync(join(temporaryRoot, "open-rfc-source-binding-"));
  } catch {
    fail("temporary root is unavailable for independent source-artifact derivation");
  }
  const worktree = join(attemptRoot, "worktree");
  let worktreeAdded = false;
  try {
    runSourceBindingCommand("git", [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      worktree,
      headCommit,
    ], {
      cwd: repository,
      label: "source binding worktree creation",
    });
    worktreeAdded = true;
    runSourceBindingCommand("git", ["clean", "-ffdx"], {
      cwd: worktree,
      label: "source binding worktree cleanup",
    });
    try {
      symlinkSync(
        dependencyRoot,
        join(worktree, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      fail("build dependencies could not be attached to the independent source worktree");
    }
    const actualCommit = runSourceBindingCommand("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      label: "source binding commit inspection",
    }).trim();
    const tree = runSourceBindingCommand("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: worktree,
      label: "source binding tree inspection",
    }).trim();
    if (actualCommit !== headCommit || !COMMIT.test(tree)) {
      fail("independent source worktree differs from the selected candidate");
    }
    const home = join(attemptRoot, "home");
    mkdirSync(home, { mode: 0o700 });
    const childEnvironment = sourceBindingEnvironment(
      environment,
      home,
      npmCache,
      dependencyRoot,
    );
    const typescriptRoot = realpathSync(join(dependencyRoot, "typescript"));
    const typescriptManifest = parseJson(
      checkedSourceFile(
        join(typescriptRoot, "package.json"),
        1024 * 1024,
        "TypeScript package manifest",
      ),
      "TypeScript package manifest",
    );
    if (
      typescriptManifest.name !== "typescript" ||
      typescriptManifest.version !== SOURCE_BINDING_TYPESCRIPT_VERSION
    ) {
      fail("TypeScript compiler version differs from the release contract");
    }
    const typescript = realpathSync(join(typescriptRoot, "bin", "tsc"));
    if (!lstatSync(typescript).isFile()) {
      fail("TypeScript compiler is unavailable for independent source-artifact derivation");
    }
    for (const [label, script, arguments_] of [
      ["clean build output", join(worktree, "tools", "clean_build_output.mjs"), []],
      ["ES module build", typescript, ["-p", "tsconfig.json"]],
      ["CommonJS build", typescript, ["-p", "tsconfig.cjs.json"]],
    ]) {
      runSourceBindingCommand(process.execPath, [script, ...arguments_], {
        cwd: worktree,
        env: childEnvironment,
        label,
      });
    }
    mkdirSync(join(worktree, "dist", "cjs"), { recursive: true, mode: 0o700 });
    copyFileSync(
      join(worktree, "cjs-package.json"),
      join(worktree, "dist", "cjs", "package.json"),
    );
    runSourceBindingCommand(
      process.execPath,
      [join(worktree, "tools", "normalize_package_modes.mjs")],
      {
        cwd: worktree,
        env: childEnvironment,
        label: "package mode normalization",
      },
    );
    const connector = npmPackArchive({
      cwd: worktree,
      destination: join(attemptRoot, "connector-pack"),
      environment: childEnvironment,
      envelope: CONNECTOR_ARCHIVE_ENVELOPE,
      label: "connector",
      npmToolchain,
    });
    return Object.freeze({ tree, connector });
  } catch (error) {
    if (error instanceof CandidateBundleError) throw error;
    fail("independent source-artifact derivation failed");
  } finally {
    if (worktreeAdded) {
      try {
        runTrustedGit(
          repository,
          ["worktree", "remove", "--force", worktree],
          { timeout: 30_000 },
        );
      } catch {
        rmSync(worktree, { recursive: true, force: true });
        try {
          runTrustedGit(repository, ["worktree", "prune"], { timeout: 30_000 });
        } catch {
          // The bounded temporary source tree has still been removed below.
        }
      }
    }
    rmSync(attemptRoot, { recursive: true, force: true });
  }
}

function assertArchiveDerivedFromSource(candidate, expected, label) {
  if (
    typeof expected !== "object" || expected === null ||
    !Array.isArray(expected.entries)
  ) {
    fail(`${label} independent source archive is unavailable`);
  }
  const candidateEntries = candidate.entries;
  const expectedEntries = expected.entries;
  if (candidateEntries.length !== expectedEntries.length) {
    fail(`${label} is not derived from the checked-out candidate source`);
  }
  for (let index = 0; index < candidateEntries.length; index += 1) {
    const actual = candidateEntries[index];
    const source = expectedEntries[index];
    if (
      actual.path !== source?.path || actual.size !== source?.size ||
      !Buffer.isBuffer(source?.bytes) || !actual.bytes.equals(source.bytes)
    ) {
      fail(`${label} is not derived from the checked-out candidate source`);
    }
  }
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function safeFilename(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    basename(value) !== value ||
    value.includes("\\")
  ) {
    fail(`${label} must be a plain filename`);
  }
  return value;
}

function verifyGateEvidence(
  result,
  currentGitInventory,
  { currentHistoryScope, postReleaseTag, headCommit } = {},
) {
  if (result.history.refScopePolicy !== PUBLISHABLE_REF_SCOPE_POLICY) {
    fail("candidate history evidence uses an unsupported publishable ref scope");
  }
  const source = result.source;
  if (
    !sameJson(source.runtimeImportBoundary.source.roots, ["src"]) ||
    source.runtimeImportBoundary.emitted.some((scan) =>
      !sameJson(scan.roots, ["dist/src", "dist/cjs"])) ||
    !sameJson(
      source.runtimeImportBoundary.emitted[0],
      source.runtimeImportBoundary.emitted[1],
    ) ||
    source.snapshots.some((snapshot, index) =>
      snapshot.commit !== result.commit ||
      snapshot.tree !== source.tree ||
      !sameJson(
        snapshot.emittedRuntimeScan,
        source.runtimeImportBoundary.emitted[index],
      ))
  ) {
    fail("candidate source evidence does not bind two identical clean builds");
  }
  if (
    result.history.objectCount < result.history.blobCount ||
    result.history.objectBytes < result.history.blobBytes ||
    result.history.objectCount > result.history.limits.maxObjectCount ||
    result.history.blobCount > result.history.limits.maxBlobCount ||
    result.history.objectBytes > result.history.limits.maxTotalObjectBytes ||
    result.history.blobBytes > result.history.limits.maxTotalObjectBytes
  ) {
    fail("candidate history evidence counters are inconsistent");
  }
  const secretAdmissions = result.history.secretAdmissions;
  if (
    secretAdmissions.policy !== "exact-git-blob-path-pattern-v1" ||
    secretAdmissions.ledgerPath !==
      "conformance/release-history-secret-admissions.v1.json" ||
    secretAdmissions.admittedObjectCount > secretAdmissions.admittedEntryCount ||
    (secretAdmissions.approvalStatus === "absent") !==
      (secretAdmissions.ledgerSha256 === null) ||
    (secretAdmissions.approvalStatus !== "accepted" &&
      (secretAdmissions.admittedEntryCount !== 0 ||
        secretAdmissions.admittedObjectCount !== 0 ||
        secretAdmissions.reviewedBy !== null ||
        secretAdmissions.reviewedAt !== null ||
        secretAdmissions.reviewReference !== null)) ||
    (secretAdmissions.approvalStatus === "accepted" &&
      (secretAdmissions.ledgerSha256 === null ||
        secretAdmissions.reviewedBy === null ||
        secretAdmissions.reviewedAt === null ||
        secretAdmissions.reviewReference === null))
  ) {
    fail("candidate history secret admission evidence is inconsistent");
  }
  const boundSourceInventory = result.source.repositoryInventory;
  const boundHistoryInventory = Object.freeze({
    algorithm: result.history.inventoryAlgorithm,
    refTipCount: result.history.refTipCount,
    refTipInventorySha256: result.history.refTipInventorySha256,
    objectCount: result.history.objectCount,
    objectInventorySha256: result.history.objectInventorySha256,
  });
  if (currentGitInventory !== undefined) {
    if (postReleaseTag === undefined) {
      assertGitRefObjectInventory(
        currentGitInventory,
        boundSourceInventory,
        "candidate source Git ref/object inventory",
      );
    } else {
      assertGitRefObjectInventoryAfterVersionTag(
        currentGitInventory,
        boundSourceInventory,
        `refs/tags/${postReleaseTag}`,
        headCommit,
        "candidate source Git ref/object inventory",
      );
    }
  } else if (postReleaseTag !== undefined) {
    fail("post-release verification requires the current source Git ref/object inventory");
  }
  if (currentHistoryScope === undefined) {
    fail("candidate verification requires the current publishable history scope");
  }
  if (postReleaseTag === undefined) {
    if (
      currentHistoryScope.policy !== result.history.refScopePolicy ||
      currentHistoryScope.headObjectId !== headCommit
    ) {
      fail("candidate publishable history scope does not bind the candidate commit");
    }
    assertGitRefObjectInventory(
      currentHistoryScope.refObjectInventory,
      boundHistoryInventory,
      "candidate publishable history inventory",
    );
  } else {
    assertPublishableGitRefScopeAfterVersionTag(
      currentHistoryScope,
      boundHistoryInventory,
      `refs/tags/${postReleaseTag}`,
      headCommit,
      "candidate publishable history inventory",
    );
  }
}

function fileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameFileIdentity(metadata, identity) {
  return metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.dev === identity.dev && metadata.ino === identity.ino &&
    metadata.size === identity.size && metadata.mode === identity.mode &&
    metadata.mtimeNs === identity.mtimeNs && metadata.ctimeNs === identity.ctimeNs;
}

function directoryIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameDirectoryIdentity(metadata, identity) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() &&
    metadata.dev === identity.dev && metadata.ino === identity.ino &&
    metadata.mode === identity.mode && metadata.mtimeNs === identity.mtimeNs &&
    metadata.ctimeNs === identity.ctimeNs;
}

async function stableDirectoryInventory(path) {
  let before;
  let entries;
  let after;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail("candidate bundle root must be a non-symlink directory");
    }
    entries = await readdir(path, { withFileTypes: true });
    after = await lstat(path, { bigint: true });
  } catch (error) {
    if (error instanceof CandidateBundleError) throw error;
    fail("candidate bundle root could not be read safely");
  }
  const identity = directoryIdentity(before);
  if (!sameDirectoryIdentity(after, identity)) {
    fail("candidate bundle root changed during inventory");
  }
  return Object.freeze({
    identity,
    entries,
    names: Object.freeze(entries.map((entry) => entry.name).sort(compareCanonicalText)),
  });
}

async function boundedRegularFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail(`${label} exceeds its regular-file byte envelope`);
    }
    const identity = fileIdentity(before);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead < 1) fail(`${label} ended during its bounded read`);
      offset += bytesRead;
    }
    const [after, pathMetadata] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      !sameFileIdentity(after, identity) ||
      !sameFileIdentity(pathMetadata, identity)
    ) {
      fail(`${label} changed during its bounded read`);
    }
    return Object.freeze({ bytes, identity, path });
  } catch (error) {
    if (error instanceof CandidateBundleError) throw error;
    fail(`${label} must be a stable non-symlink regular file`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertCandidateSnapshotStable(root, inventory, files) {
  const current = await stableDirectoryInventory(root);
  if (
    !sameDirectoryIdentity(
      await lstat(root, { bigint: true }),
      inventory.identity,
    ) ||
    !sameJson(current.names, inventory.names)
  ) {
    fail("candidate bundle root changed during verification");
  }
  for (const file of files) {
    let metadata;
    try {
      metadata = await lstat(file.path, { bigint: true });
    } catch {
      fail("candidate bundle file changed during verification");
    }
    if (!sameFileIdentity(metadata, file.identity)) {
      fail("candidate bundle file changed during verification");
    }
  }
}

function packageIdentity(value, label) {
  const identity = record(value, label);
  if (typeof identity.name !== "string" || typeof identity.version !== "string") {
    fail(`${label} must contain name and version strings`);
  }
  return Object.freeze({ name: identity.name, version: identity.version });
}

function verifyArtifactRecord(value, expectedPackage, parsed, label) {
  const artifact = record(value, label);
  const identity = packageIdentity(artifact.package, `${label}.package`);
  if (
    identity.name !== expectedPackage.name ||
    identity.version !== expectedPackage.version ||
    safeFilename(artifact.filename, `${label}.filename`) !==
      npmPackageTarballFilename(expectedPackage.name, expectedPackage.version) ||
    artifact.sha256 !== parsed.sha256 ||
    artifact.integrity !== parsed.integrity ||
    artifact.bytes !== parsed.tarballBytes ||
    artifact.unpackedBytes !== parsed.unpackedBytes ||
    artifact.fileCount !== parsed.fileCount ||
    artifact.archiveInventorySha256 !== parsed.archiveInventorySha256
  ) {
    fail(`${label} does not bind the exact archive`);
  }
  return artifact;
}

function parsePackageManifest(entries, path, label) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) fail(`${label} is missing`);
  const manifest = parseJson(entry.bytes, label);
  return record(manifest, label);
}

function validateNoInstallOrNativeDeclaration(manifest, label) {
  for (const name of ["install", "postinstall", "preinstall"]) {
    if (manifest.scripts?.[name] !== undefined) {
      fail(`${label} contains an install lifecycle hook`);
    }
  }
  if (manifest.gypfile === true || manifest.binary !== undefined) {
    fail(`${label} declares a native binary`);
  }
}

function hasNonemptyDependencyClass(manifest, field) {
  const value = manifest[field];
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || value === null || Object.keys(value).length > 0;
}

function validateConnectorPath(path) {
  const relative = path.slice("package/".length);
  if (
    [
      "README.md",
      "package.json",
      "dist/cjs/package.json",
    ].includes(relative) ||
    CONVENTIONAL_LEGAL_PATHS.includes(relative)
  ) {
    return;
  }
  if (/^dist\/src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/u.test(relative)) {
    return;
  }
  if (/^dist\/cjs\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/u.test(relative)) {
    return;
  }
  fail(`connector archive path is outside the release allowlist: ${path}`);
}

function validateArchiveEntrySafety(
  entries,
  label,
  forbiddenPath,
  environmentSecrets,
) {
  for (const entry of entries) {
    const pathSecret = publicationSecretPatternIndex(entry.path, environmentSecrets);
    if (pathSecret !== null) {
      fail(`${label} path failed non-echoing secret scan (${pathSecret})`);
    }
    if (forbiddenPath.test(entry.path) ||
        FORBIDDEN_ARCHIVE_EXTENSION.test(entry.path)) {
      fail(`${label} contains a forbidden SDK, native, or secret path: ${entry.path}`);
    }
    if (NATIVE_MAGICS.some((magic) => entry.bytes.subarray(0, magic.length).equals(magic))) {
      fail(`${label} contains a native binary signature: ${entry.path}`);
    }
    const secret = publicationSecretPatternIndex(entry.bytes, environmentSecrets);
    if (secret !== null) {
      fail(`${label} contains an embedded secret (${secret}): ${entry.path}`);
    }
  }
}

function verifyConnectorArchive(
  entries,
  expectedPackage,
  environmentSecrets,
  publicationMode,
) {
  const paths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) validateConnectorPath(entry.path);
  for (const required of CONNECTOR_REQUIRED_FILES) {
    if (!paths.has(`package/${required}`)) {
      fail(`connector archive is missing required runtime file ${required}`);
    }
  }
  if (publicationMode === "public-license-preflight") {
    requireApprovedApache2LicenseEntry(entries, "connector artifact");
  }
  if (
    publicationMode === "public-license-preflight" &&
    !hasThirdPartyNoticePath(paths, "package/")
  ) {
    fail(
      "public license preflight requires a " +
      "THIRD_PARTY_NOTICES.md file in the connector artifact",
    );
  }
  validateArchiveEntrySafety(
    entries,
    "connector archive",
    FORBIDDEN_CONNECTOR_PATH,
    environmentSecrets,
  );
  const declarations = new Map(
    entries
      .filter(({ path }) =>
        /^package\/dist\/(?:cjs|src)\/.+\.d\.ts$/u.test(path))
      .map((entry) => [entry.path, entry]),
  );
  const sourcePrefix = "package/dist/src/";
  const commonJsPrefix = "package/dist/cjs/";
  const sourcePaths = [...declarations.keys()]
    .filter((path) => path.startsWith(sourcePrefix))
    .sort();
  const commonJsPaths = [...declarations.keys()]
    .filter((path) => path.startsWith(commonJsPrefix))
    .sort();
  const expectedCommonJsPaths = sourcePaths.map(
    (path) => `${commonJsPrefix}${path.slice(sourcePrefix.length)}`,
  );
  if (!sameJson(commonJsPaths, expectedCommonJsPaths)) {
    fail("connector ESM and CommonJS declaration inventories differ");
  }
  for (const sourcePath of sourcePaths) {
    const commonJsPath = `${commonJsPrefix}${sourcePath.slice(sourcePrefix.length)}`;
    const source = declarations.get(sourcePath);
    const commonJs = declarations.get(commonJsPath);
    if (
      source === undefined ||
      commonJs === undefined ||
      source.size !== commonJs.size ||
      source.sha256 !== commonJs.sha256
    ) {
      fail(`connector ESM and CommonJS declaration bytes differ: ${sourcePath}`);
    }
  }
  const manifest = parsePackageManifest(
    entries,
    "package/package.json",
    "connector manifest",
  );
  const expectedEntrypoints = {
    main: "./dist/cjs/index.js",
    module: "./dist/src/index.js",
    types: "./dist/src/index.d.ts",
    exports: {
      ".": {
        import: {
          types: "./dist/src/index.d.ts",
          default: "./dist/src/index.js",
        },
        require: {
          types: "./dist/cjs/index.d.ts",
          default: "./dist/cjs/index.js",
        },
        default: "./dist/src/index.js",
      },
      "./package.json": "./package.json",
    },
  };
  try {
    assertPublicationManifestProfile(manifest, {
      mode: publicationMode,
      label: "connector manifest",
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "connector manifest profile is invalid");
  }
  if (
    manifest.name !== expectedPackage.name ||
    manifest.version !== expectedPackage.version ||
    manifest.type !== "module" ||
    manifest.main !== expectedEntrypoints.main ||
    manifest.module !== expectedEntrypoints.module ||
    manifest.types !== expectedEntrypoints.types ||
    manifest.sideEffects !== false ||
    JSON.stringify(manifest.exports) !== JSON.stringify(expectedEntrypoints.exports) ||
    JSON.stringify(manifest.files) !== JSON.stringify(EXPECTED_CONNECTOR_PACKAGE_FILES) ||
    JSON.stringify(manifest.engines) !== JSON.stringify(EXPECTED_CONNECTOR_ENGINES)
  ) {
    fail(
      "connector manifest identity, entrypoint, exports, files, engines, " +
      "tree-shaking contract, or publication profile changed",
    );
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    if (hasNonemptyDependencyClass(manifest, field)) {
      fail(`connector manifest unexpectedly contains ${field}`);
    }
  }
  validateNoInstallOrNativeDeclaration(manifest, "connector manifest");
  candidateReleaseSetLicenseProfile(manifest, {
    mode: publicationMode,
    label: "connector package manifest license",
  });
  const cjsManifest = exactObjectKeys(
    parsePackageManifest(entries, "package/dist/cjs/package.json", "CommonJS package manifest"),
    ["type"],
    "CommonJS package manifest",
  );
  if (cjsManifest.type !== "commonjs") fail("CommonJS package manifest changed");
  return manifest;
}

function exactObjectKeys(value, expected, label) {
  const admitted = record(value, label);
  const actual = Object.keys(admitted).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  if (!sameJson(actual, wanted)) fail(`${label} fields do not match the release profile`);
  return admitted;
}

function verifySinglePackageSpdx({
  document,
  expectedPackage,
  connectorFilename,
  connectorArtifact,
  connectorManifest,
  publicationMode,
}) {
  exactObjectKeys(
    document,
    [
      "SPDXID",
      "creationInfo",
      "dataLicense",
      "documentDescribes",
      "documentNamespace",
      "name",
      "packages",
      "relationships",
      "spdxVersion",
    ],
    "candidate SBOM document",
  );
  const creation = exactObjectKeys(
    document.creationInfo,
    ["created", "creators"],
    "candidate SBOM creation information",
  );
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(creation.created) ||
    Number.isNaN(Date.parse(creation.created)) ||
    !sameJson(creation.creators, ["Tool: open-rfc-release-artifact-gate/1"])
  ) {
    fail("candidate SBOM creation information is invalid");
  }

  const packageId = `SPDXRef-Package-${expectedPackage.name}-${expectedPackage.version}`
    .replaceAll(/[^A-Za-z0-9.-]/gu, "-");
  const licenseProfile = candidateReleaseSetLicenseProfile(connectorManifest, {
    mode: publicationMode,
    label: "connector package manifest license",
  });
  const expectedNamespace =
    `https://github.com/marianfoo/open-rfc/spdx/${expectedPackage.version}/${connectorArtifact.sha256}`;
  if (
    document.spdxVersion !== "SPDX-2.3" ||
    document.dataLicense !== "CC0-1.0" ||
    document.SPDXID !== "SPDXRef-DOCUMENT" ||
    document.name !== `${expectedPackage.name}@${expectedPackage.version}` ||
    document.documentNamespace !== expectedNamespace ||
    !sameJson(document.documentDescribes, [packageId]) ||
    !Array.isArray(document.packages) ||
    document.packages.length !== 1 ||
    !Array.isArray(document.relationships) ||
    document.relationships.length !== 1
  ) {
    fail("candidate SPDX document is not the exact single-package release SBOM");
  }

  const releasedPackage = exactObjectKeys(
    document.packages[0],
    [
      "SPDXID",
      "checksums",
      "downloadLocation",
      "externalRefs",
      "filesAnalyzed",
      ...(licenseProfile.licenseComments === undefined ? [] : ["licenseComments"]),
      "licenseConcluded",
      "licenseDeclared",
      "name",
      "packageFileName",
      "primaryPackagePurpose",
      "versionInfo",
    ],
    "candidate SBOM package",
  );
  if (
    releasedPackage.SPDXID !== packageId ||
    releasedPackage.name !== expectedPackage.name ||
    releasedPackage.versionInfo !== expectedPackage.version ||
    releasedPackage.packageFileName !== connectorFilename ||
    releasedPackage.primaryPackagePurpose !== "LIBRARY" ||
    releasedPackage.downloadLocation !== "NOASSERTION" ||
    releasedPackage.filesAnalyzed !== false ||
    releasedPackage.licenseDeclared !== licenseProfile.license ||
    releasedPackage.licenseConcluded !== licenseProfile.license ||
    releasedPackage.licenseComments !== licenseProfile.licenseComments ||
    !Array.isArray(releasedPackage.checksums) ||
    releasedPackage.checksums.length !== 1 ||
    !Array.isArray(releasedPackage.externalRefs) ||
    releasedPackage.externalRefs.length !== 1
  ) {
    fail("candidate SPDX package is not the exact connector release profile");
  }
  const checksum = exactObjectKeys(
    releasedPackage.checksums[0],
    ["algorithm", "checksumValue"],
    "candidate SBOM package checksum",
  );
  if (
    checksum.algorithm !== "SHA256" ||
    checksum.checksumValue !== connectorArtifact.sha256
  ) {
    fail("candidate SPDX package checksum does not bind the connector artifact");
  }
  const externalReference = exactObjectKeys(
    releasedPackage.externalRefs[0],
    ["referenceCategory", "referenceLocator", "referenceType"],
    "candidate SBOM package external reference",
  );
  if (
    externalReference.referenceCategory !== "PACKAGE-MANAGER" ||
    externalReference.referenceType !== "purl" ||
    externalReference.referenceLocator !==
      `pkg:npm/${expectedPackage.name}@${expectedPackage.version}`
  ) {
    fail("candidate SPDX package purl is invalid");
  }
  const relationship = exactObjectKeys(
    document.relationships[0],
    ["relatedSpdxElement", "relationshipType", "spdxElementId"],
    "candidate SBOM relationship",
  );
  if (
    relationship.spdxElementId !== "SPDXRef-DOCUMENT" ||
    relationship.relatedSpdxElement !== packageId ||
    relationship.relationshipType !== "DESCRIBES"
  ) {
    fail("candidate SPDX relationship does not describe the connector package");
  }
}

export async function verifyCandidateBundleWith({
  directory,
  headCommit,
  expectedPackage,
  expectedSourceArchives,
  expectedSourceTree,
  currentGitInventory,
  currentHistoryScope,
  environment = {},
  publicationMode = "private",
  postReleaseTag,
}) {
  if (!COMMIT.test(headCommit)) fail("headCommit must be a full SHA-1");
  if (!COMMIT.test(expectedSourceTree)) {
    fail("independently derived candidate source tree must be a full SHA-1");
  }
  const environmentSecrets = candidateEnvironmentSecrets(environment);
  const mode = candidatePublicationMode(publicationMode);
  const expectedConnector = packageIdentity(expectedPackage, "expectedPackage");
  const releaseTag = candidatePostReleaseTag(
    postReleaseTag,
    expectedConnector.version,
    mode,
  );
  const root = resolve(directory);
  const directoryInventory = await stableDirectoryInventory(root);
  const connectorFilename = releaseContract(
    () => npmPackageTarballFilename(expectedConnector.name, expectedConnector.version),
    "connector filename",
  );
  const expectedNames = [connectorFilename, RESULT_NAME, SBOM_NAME].sort();
  if (
    directoryInventory.entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    !sameJson(directoryInventory.names, expectedNames)
  ) {
    fail("candidate bundle must contain exactly the connector, gate result, and SBOM");
  }

  const resultFile = await boundedRegularFile(
    join(root, RESULT_NAME),
    256 * 1024,
    "candidate gate result",
  );
  const result = record(parseJson(resultFile.bytes, RESULT_NAME), RESULT_NAME);
  releaseContract(
    () => validateJsonSchemaSubset(
      result,
      releaseArtifactGateSchema,
      "candidate gate result",
    ),
    "candidate gate-result schema",
  );
  verifyGateEvidence(result, currentGitInventory, {
    currentHistoryScope,
    postReleaseTag: releaseTag,
    headCommit,
  });
  if (
    result.schemaVersion !== 1 || result.status !== "passed" ||
    result.commit !== headCommit || result.source?.tree !== expectedSourceTree ||
    result.publication?.mode !== mode ||
    result.package?.name !== expectedConnector.name ||
    result.package?.version !== expectedConnector.version
  ) {
    fail("candidate gate result does not match the checked-out release source");
  }

  const connectorFile = await boundedRegularFile(
    join(root, connectorFilename),
    CONNECTOR_ARCHIVE_ENVELOPE.tarballBytes,
    "candidate connector tarball",
  );
  const connectorParsed = releaseContract(
    () => parseCanonicalNpmTarball(connectorFile.bytes, CONNECTOR_ARCHIVE_ENVELOPE),
    "connector archive",
  );
  assertArchiveDerivedFromSource(
    connectorParsed,
    expectedSourceArchives?.connector,
    "candidate connector artifact",
  );
  const connectorManifest = verifyConnectorArchive(
    connectorParsed.entries,
    expectedConnector,
    environmentSecrets,
    mode,
  );
  assertCandidatePackagedReadme(connectorParsed.entries, {
    approvedHttpsTargets: OPEN_RFC_PACKAGED_README_HTTPS_TARGETS,
  });

  const releaseSet = record(result.releaseSet, "candidate release set");
  if (
    releaseSet.schemaVersion !== 1 ||
    releaseSet.identityAlgorithm !== "sha256-canonical-record-v1" ||
    releaseSet.candidateRole !== "connector" ||
    !SHA256.test(releaseSet.sha256) ||
    !sameJson(Object.keys(record(releaseSet.artifacts, "candidate release artifacts")), ["connector"]) ||
    !sameJson(record(releaseSet.bindings, "candidate release bindings"), { npmPackage: "open-rfc" })
  ) {
    fail("candidate single-package release-set identity is invalid");
  }
  const connectorArtifact = verifyArtifactRecord(
    releaseSet.artifacts.connector,
    expectedConnector,
    connectorParsed,
    "candidate connector artifact",
  );
  const topArtifact = record(result.artifact, "candidate artifact");
  for (const key of [
    "filename", "sha256", "integrity", "bytes", "unpackedBytes", "fileCount",
    "archiveInventorySha256",
  ]) {
    if (topArtifact[key] !== connectorArtifact[key]) {
      fail("top-level candidate artifact differs from the release-set connector");
    }
  }
  if (
    releaseContract(
      () => computeReleaseSetSha256(headCommit, releaseSet.artifacts, releaseSet.bindings),
      "release-set digest",
    ) !== releaseSet.sha256
  ) {
    fail("candidate release-set digest is invalid");
  }
  for (const check of REQUIRED_RELEASE_CHECKS) {
    if (result.checks?.[check] !== true) fail(`candidate gate lacks passed check ${check}`);
  }

  const sbomBinding = record(result.sbom, "candidate SBOM binding");
  if (
    safeFilename(sbomBinding.filename, "candidate SBOM filename") !== SBOM_NAME ||
    !SHA256.test(sbomBinding.sha256) ||
    sbomBinding.artifactSha256 !== connectorArtifact.sha256 ||
    sbomBinding.releaseSetSha256 !== releaseSet.sha256 ||
    !sameJson(sbomBinding.artifactSha256s, { connector: connectorArtifact.sha256 })
  ) {
    fail("candidate gate SBOM binding differs from the connector artifact");
  }
  const sbomFile = await boundedRegularFile(
    join(root, SBOM_NAME),
    1024 * 1024,
    "candidate SBOM",
  );
  if (sha256(sbomFile.bytes) !== sbomBinding.sha256) {
    fail("candidate SBOM digest does not match the gate result");
  }
  const sbom = record(parseJson(sbomFile.bytes, SBOM_NAME), SBOM_NAME);
  verifySinglePackageSpdx({
    document: sbom,
    expectedPackage: expectedConnector,
    connectorFilename,
    connectorArtifact,
    connectorManifest,
    publicationMode: mode,
  });

  await assertCandidateSnapshotStable(root, directoryInventory, [
    resultFile,
    connectorFile,
    sbomFile,
  ]);
  return Object.freeze({
    status: "passed",
    commit: headCommit,
    package: Object.freeze({ ...expectedConnector }),
    filename: connectorFilename,
    sha256: connectorArtifact.sha256,
    releaseSetSha256: releaseSet.sha256,
    releaseSet: Object.freeze({
      sha256: releaseSet.sha256,
      connector: Object.freeze({
        package: Object.freeze({ ...connectorArtifact.package }),
        filename: connectorArtifact.filename,
        sha256: connectorArtifact.sha256,
        integrity: connectorArtifact.integrity,
        bytes: connectorArtifact.bytes,
        unpackedBytes: connectorArtifact.unpackedBytes,
        fileCount: connectorArtifact.fileCount,
        archiveInventorySha256: connectorArtifact.archiveInventorySha256,
      }),
    }),
  });
}

export async function verifyCandidateBundle(
  directory,
  root = DEFAULT_ROOT,
  options = {},
) {
  const headCommit = options.commit;
  if (!COMMIT.test(headCommit ?? "")) {
    fail("candidate commit binding is required and must be a full SHA-1");
  }
  const checkedOutCommit = runTrustedGit(root, ["rev-parse", "HEAD"]).trim();
  if (checkedOutCommit !== headCommit) {
    fail("HEAD must equal the explicitly bound candidate commit");
  }
  const committedFile = (path, maximumBytes, label) => {
    let bytes;
    try {
      bytes = runTrustedGit(root, ["show", `${headCommit}:${path}`], {
        encoding: null,
        maxBuffer: maximumBytes + 1,
      });
    } catch {
      fail(`${label} is unavailable from the candidate commit`);
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes) {
      fail(`${label} exceeds its committed byte envelope`);
    }
    return bytes;
  };
  const packageBytes = committedFile("package.json", 64 * 1024, "package manifest");
  const expectedPackage = parseJson(packageBytes, "committed package manifest");
  const publicationMode = candidatePublicationMode(options.publicationMode);
  const expectedIdentity = packageIdentity(expectedPackage, "committed package manifest");
  const postReleaseTag = candidatePostReleaseTag(
    options.postReleaseTag,
    expectedIdentity.version,
    publicationMode,
  );
  const expectedSourceArchives = deriveCandidateSourceArchives(
    root,
    headCommit,
    process.env,
  );
  return await verifyCandidateBundleWith({
    directory,
    headCommit,
    expectedPackage,
    expectedSourceArchives,
    expectedSourceTree: expectedSourceArchives.tree,
    environment: process.env,
    publicationMode,
    postReleaseTag,
    currentGitInventory: postReleaseTag === undefined
      ? readGitRefObjectInventory(root)
      : readGitRefObjectInventoryAfterVersionTag(
          root,
          `refs/tags/${postReleaseTag}`,
          headCommit,
        ),
    currentHistoryScope: postReleaseTag === undefined
      ? readPublishableGitRefScope(root, headCommit)
      : readPublishableGitRefScopeAfterVersionTag(
          root,
          `refs/tags/${postReleaseTag}`,
          headCommit,
        ),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const directory = args.shift();
    let requestedPublicationMode = "private";
    let postReleaseTag;
    let commit;
    let publicationModeSeen = false;
    while (args.length > 0) {
      const option = args.shift();
      const value = args.shift();
      if (value === undefined) fail(`missing value for ${option}`);
      if (option === "--publication-mode" && !publicationModeSeen) {
        requestedPublicationMode = value;
        publicationModeSeen = true;
      } else if (option === "--post-release-tag" && postReleaseTag === undefined) {
        postReleaseTag = value;
      } else if (option === "--commit" && commit === undefined) {
        commit = value;
      } else {
        fail(`unknown or duplicate option ${option}`);
      }
    }
    if (directory === undefined) {
      fail(
        "usage: node tools/verify_candidate_bundle.mjs <bundle-directory> " +
        "--commit <full-SHA-1> " +
        "[--publication-mode private|public-license-preflight] " +
        "[--post-release-tag v0.x.y]",
      );
    }
    process.stdout.write(`${JSON.stringify(await verifyCandidateBundle(
      directory,
      DEFAULT_ROOT,
      { commit, publicationMode: requestedPublicationMode, postReleaseTag },
    ))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
