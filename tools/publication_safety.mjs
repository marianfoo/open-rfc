/**
 * Shared publication-content policy for the release producer and the
 * independent candidate verifier. Keep pattern order stable: immutable history
 * admissions bind the resulting `pattern-N` identifiers.
 */

import { createHash } from "node:crypto";

import SPDX_EXCEPTIONS from "spdx-exceptions" with { type: "json" };
import SPDX_LICENSE_IDS from "spdx-license-ids" with { type: "json" };

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[opsu]_[A-Za-z0-9]{36,255}\b/u,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'<>${}\s]{12,}["']/iu,
  /:\/\/[^/\s:@]{2,64}:[^/\s@]{8,256}@/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/u,
  /\bnpm_[A-Za-z0-9]{36,255}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,255}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/iu,
  /\b(?:client[_-]?secret|clientsecret|access[_-]?token|refresh[_-]?token|authorization)\b\s*[:=]\s*["'][^"'<>${}\s]{12,}["']/iu,
  // Append new classes. Never widen an earlier expression: immutable history
  // admissions bind the exact pattern-N identifier.
  /\bASIA[0-9A-Z]{16}\b/u,
  /\bghr_[A-Za-z0-9]{36,255}\b/u,
]);

export const PUBLICATION_SECRET_PATTERN_IDS = Object.freeze(
  SECRET_PATTERNS.map((_, index) => `pattern-${index + 1}`),
);

export const CONVENTIONAL_LICENSE_PATHS = Object.freeze([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
]);

export const CONVENTIONAL_NOTICE_PATHS = Object.freeze([
  "NOTICE",
  "NOTICE.md",
  "NOTICE.txt",
]);

export const THIRD_PARTY_NOTICE_PATHS = Object.freeze([
  "THIRD_PARTY_NOTICES.md",
]);

export const APPROVED_APACHE_2_LICENSE_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

export const APPROVED_PROJECT_NOTICE_SHA256 =
  "8b273cbd26a76a492d4c0baa3de110c4103a6017e86eea8363a6ecc552d626df";

export const APPROVED_CONTRIBUTION_POLICY_SHA256 =
  "7c6960fa96b530d1faf29597931c8bcfd675e467b09ad7816a8efdb907d0674c";

export const APPROVED_DCO_SHA256 =
  "f7ac75b443f4ca16b503241344b41aeff9503b0c30bedc2b119551d83cb0fa90";

export const APPROVED_PUBLIC_AGENTS_SHA256 =
  "b6b4b80a568ceb81b818f80b355b40bb0209d2d84a3060ba18c6b168805eeb4e";

export const CONVENTIONAL_LEGAL_PATHS = Object.freeze([
  ...CONVENTIONAL_LICENSE_PATHS,
  ...CONVENTIONAL_NOTICE_PATHS,
  ...THIRD_PARTY_NOTICE_PATHS,
]);

const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "SAP_PASSWD",
  "SAP_PASSWORD",
  "SAP_ASHOST",
  "SAP_GWHOST",
  "SAP_ENDPOINT",
  "SAP_PORT",
  "SAP_CLIENT",
  "SAP_USER",
  "RFC_PASSWORD",
  "NPM_TOKEN",
  "GITHUB_TOKEN",
  "OPEN_RFC_EXPECT_ENDPOINT_SHA256",
  "OPEN_RFC_CREDENTIALS",
  "OPEN_RFC_HOST",
  "OPEN_RFC_PORT",
  "OPEN_RFC_SAPROUTER",
  "OPEN_RFC_USER",
  "OPEN_RFC_FULL_USER",
  "OPEN_RFC_RESTRICTED_USER",
  "OPEN_RFC_BTP_PP_APPLICATION_GUID",
]);

export class PublicationSafetyConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicationSafetyConfigurationError";
  }
}

function configurationFailure(message) {
  throw new PublicationSafetyConfigurationError(message);
}

function textValue(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

/** Return only a stable pattern identifier, never the matched material. */
export function publicationSecretPatternIndex(value, environmentSecrets = []) {
  const text = textValue(value);
  const patternIndex = SECRET_PATTERNS.findIndex((pattern) => pattern.test(text));
  if (patternIndex >= 0) return `pattern-${patternIndex + 1}`;
  for (const secret of environmentSecrets) {
    if (typeof secret === "string" && secret.length >= 3 && text.includes(secret)) {
      return "environment-secret";
    }
  }
  return null;
}

/** Return every built-in match plus an environment-value flag for history. */
export function publicationSecretMatches(value, environmentSecrets = []) {
  const text = textValue(value);
  const patternIds = SECRET_PATTERNS.flatMap((pattern, index) =>
    pattern.test(text) ? [`pattern-${index + 1}`] : []
  );
  const environmentSecret = environmentSecrets.some((secret) =>
    typeof secret === "string" && secret.length >= 3 && text.includes(secret)
  );
  return Object.freeze({
    patternIds: Object.freeze(patternIds),
    environmentSecret,
  });
}

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    configurationFailure(`${label} is invalid`);
  }
  return value;
}

/**
 * Snapshot publication-sensitive environment values in one enumeration. The
 * two identifier controls are removed from the generic secret-name pass so
 * each is parsed exactly once. Errors intentionally never echo a value.
 */
export function publicationEnvironmentSecrets(environment) {
  if (typeof environment !== "object" || environment === null) {
    configurationFailure("release environment must be an object");
  }
  let entries;
  try {
    entries = Object.entries(environment);
  } catch {
    configurationFailure("release environment could not be inspected safely");
  }
  const snapshot = new Map(entries);
  const values = new Set();

  if (snapshot.has("OPEN_RFC_EXPECT_SYSTEM_ID")) {
    values.add(boundedIdentifier(
      snapshot.get("OPEN_RFC_EXPECT_SYSTEM_ID"),
      "release expected system identifier",
    ));
  }

  if (snapshot.has("OPEN_RFC_RELEASE_FORBIDDEN_IDENTIFIERS")) {
    const identifiers = snapshot.get("OPEN_RFC_RELEASE_FORBIDDEN_IDENTIFIERS");
    if (typeof identifiers !== "string") {
      configurationFailure("release forbidden identifiers must be a comma-separated string");
    }
    const parts = identifiers.split(",").map((part) => part.trim());
    if (parts.length === 0) {
      configurationFailure("release forbidden identifiers contain an invalid entry");
    }
    for (const identifier of parts) {
      values.add(boundedIdentifier(
        identifier,
        "release forbidden identifier",
      ));
    }
  }

  for (const [name, value] of entries) {
    if (
      name === "OPEN_RFC_EXPECT_SYSTEM_ID" ||
      name === "OPEN_RFC_RELEASE_FORBIDDEN_IDENTIFIERS"
    ) {
      continue;
    }
    if (
      typeof value === "string" &&
      value.length >= 3 &&
      (EXPLICIT_SECRET_ENVIRONMENT_NAMES.has(name) ||
        /(?:_TOKEN|_PASSWORD|_PASSWD|_SECRET|_API_KEY)$/u.test(name))
    ) {
      values.add(value);
    }
  }
  return Object.freeze([...values]);
}

export function normalizePublicationMode(value = "private") {
  if (value === "public") {
    configurationFailure(
      "public publication mode is not implemented; " +
      "use public-license-preflight for the complete reviewed public-package " +
      "manifest, license, notice, and artifact contract",
    );
  }
  if (value !== "private" && value !== "public-license-preflight") {
    configurationFailure(
      "publication mode must be private or public-license-preflight",
    );
  }
  return value;
}

const STABLE_ZERO_MAJOR_VERSION =
  /^0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

/**
 * Bind package publication state to an explicit verification mode. This is
 * intentionally shared by source, tarball, consumer, and candidate gates so a
 * non-public package profile can never stand in for the exact public package.
 */
export function assertPublicationManifestProfile(
  manifest,
  { mode: value = "private", label = "package manifest" } = {},
) {
  const mode = normalizePublicationMode(value);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    configurationFailure(`${label} is invalid`);
  }
  const expectedPrivate = mode === "private";
  if (manifest.private !== expectedPrivate) {
    configurationFailure(
      `${label} private must be exactly ${String(expectedPrivate)} in ${mode} mode`,
    );
  }
  if (mode === "public-license-preflight") {
    if (manifest.name !== "open-rfc") {
      configurationFailure(`${label} name must be exactly open-rfc`);
    }
    if (
      typeof manifest.version !== "string" ||
      !STABLE_ZERO_MAJOR_VERSION.test(manifest.version)
    ) {
      configurationFailure(`${label} version must be stable SemVer 0.x`);
    }
    if (manifest.license !== "Apache-2.0") {
      configurationFailure(`${label} license must be exactly Apache-2.0`);
    }
    if (manifest.scripts?.prepublishOnly !== undefined) {
      configurationFailure(`${label} must not retain a prepublishOnly guard`);
    }
  }
  return mode;
}

export function hasConventionalLicensePath(paths, prefix = "") {
  const pathSet = paths instanceof Set ? paths : new Set(paths);
  return CONVENTIONAL_LICENSE_PATHS.some((path) => pathSet.has(`${prefix}${path}`));
}

export function hasThirdPartyNoticePath(paths, prefix = "") {
  const pathSet = paths instanceof Set ? paths : new Set(paths);
  return THIRD_PARTY_NOTICE_PATHS.some((path) => pathSet.has(`${prefix}${path}`));
}

export function isApprovedApache2LicenseBytes(value) {
  return value instanceof Uint8Array &&
    createHash("sha256").update(value).digest("hex") ===
      APPROVED_APACHE_2_LICENSE_SHA256;
}

export function isApprovedProjectNoticeBytes(value) {
  return value instanceof Uint8Array &&
    createHash("sha256").update(value).digest("hex") ===
      APPROVED_PROJECT_NOTICE_SHA256;
}

export function isApprovedContributionPolicyBytes(value) {
  return value instanceof Uint8Array &&
    createHash("sha256").update(value).digest("hex") ===
      APPROVED_CONTRIBUTION_POLICY_SHA256;
}

export function isApprovedDcoBytes(value) {
  return value instanceof Uint8Array &&
    createHash("sha256").update(value).digest("hex") === APPROVED_DCO_SHA256;
}

export function isApprovedPublicAgentsBytes(value) {
  return value instanceof Uint8Array &&
    createHash("sha256").update(value).digest("hex") ===
      APPROVED_PUBLIC_AGENTS_SHA256;
}

const SPDX_LICENSE_TOKEN =
  /(?:DocumentRef-[A-Za-z0-9.-]+:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*\+?)/uy;
const SPDX_LICENSE_ID_SET = new Set(SPDX_LICENSE_IDS);
const SPDX_EXCEPTION_ID_SET = new Set(SPDX_EXCEPTIONS);

function tokenizeSpdxLicenseExpression(value, label) {
  const tokens = [];
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] === " ") {
      offset += 1;
      continue;
    }
    if (value[offset] === "(" || value[offset] === ")") {
      tokens.push(value[offset]);
      offset += 1;
      continue;
    }
    SPDX_LICENSE_TOKEN.lastIndex = offset;
    const match = SPDX_LICENSE_TOKEN.exec(value);
    if (match === null) configurationFailure(`${label} is not a well-formed SPDX expression`);
    tokens.push(match[0]);
    offset = SPDX_LICENSE_TOKEN.lastIndex;
    if (tokens.length > 64) configurationFailure(`${label} exceeds its SPDX token envelope`);
  }
  return tokens;
}

function validateSpdxLicenseExpression(value, label) {
  const tokens = tokenizeSpdxLicenseExpression(value, label);
  let cursor = 0;
  const token = () => tokens[cursor];
  const consume = (expected) => {
    if (token() !== expected) configurationFailure(`${label} is not a well-formed SPDX expression`);
    cursor += 1;
  };
  const identifier = (kind) => {
    const candidate = token();
    if (
      candidate === undefined ||
      candidate === "(" ||
      candidate === ")" ||
      candidate === "AND" ||
      candidate === "OR" ||
      candidate === "WITH" ||
      candidate === "NONE" ||
      candidate === "NOASSERTION" ||
      candidate === "UNLICENSED"
    ) {
      configurationFailure(`${label} is not a well-formed SPDX expression`);
    }
    const allowed = kind === "license" ? SPDX_LICENSE_ID_SET : SPDX_EXCEPTION_ID_SET;
    const normalized = kind === "license" && candidate.endsWith("+")
      ? candidate.slice(0, -1)
      : candidate;
    if (
      candidate.startsWith("LicenseRef-") ||
      candidate.startsWith("DocumentRef-") ||
      !allowed.has(normalized)
    ) {
      configurationFailure(
        `${label} contains an identifier absent from the pinned SPDX ${kind} list`,
      );
    }
    cursor += 1;
  };
  const primary = () => {
    if (token() === "(") {
      consume("(");
      disjunction();
      consume(")");
      return false;
    }
    identifier("license");
    return true;
  };
  const withException = () => {
    const simple = primary();
    if (token() === "WITH") {
      if (!simple) configurationFailure(`${label} is not a well-formed SPDX expression`);
      consume("WITH");
      identifier("exception");
    }
  };
  const conjunction = () => {
    withException();
    while (token() === "AND") {
      consume("AND");
      withException();
    }
  };
  const disjunction = () => {
    conjunction();
    while (token() === "OR") {
      consume("OR");
      conjunction();
    }
  };
  if (tokens.length === 0) configurationFailure(`${label} is not a well-formed SPDX expression`);
  disjunction();
  if (cursor !== tokens.length) configurationFailure(`${label} is not a well-formed SPDX expression`);
  return value;
}

/**
 * Reflect a package manifest's declared SPDX expression without selecting or
 * approving a project license. Absence remains NOASSERTION unless the caller
 * is performing the separately owner-gated public-license preflight.
 */
export function spdxLicenseFromManifest(
  manifest,
  { required = false, label = "package manifest license" } = {},
) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    configurationFailure(`${label} source is invalid`);
  }
  if (manifest.license === undefined) {
    if (required) configurationFailure(`${label} is required`);
    return "NOASSERTION";
  }
  if (
    typeof manifest.license !== "string" ||
    manifest.license.length < 1 ||
    manifest.license.length > 256 ||
    manifest.license !== manifest.license.trim() ||
    /[\u0000-\u001f\u007f]/u.test(manifest.license)
  ) {
    configurationFailure(`${label} is invalid`);
  }
  return validateSpdxLicenseExpression(manifest.license, label);
}
