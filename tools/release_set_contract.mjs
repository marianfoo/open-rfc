import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const CONNECTOR_ARCHIVE_ENVELOPE = Object.freeze({
  tarballBytes: 5 * 1024 * 1024,
  unpackedBytes: 10 * 1024 * 1024,
  entryBytes: 2 * 1024 * 1024,
  entries: 512,
});

export const REPLACEMENT_ARCHIVE_ENVELOPE = Object.freeze({
  tarballBytes: 8 * 1024 * 1024,
  unpackedBytes: 24 * 1024 * 1024,
  entryBytes: 4 * 1024 * 1024,
  entries: 4096,
});

export class ReleaseSetContractError extends Error {
  constructor(message) {
    super(`release set: ${message}`);
    this.name = "ReleaseSetContractError";
  }
}

function fail(message) {
  throw new ReleaseSetContractError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be positive`);
  return value;
}

function envelope(value) {
  const admitted = record(value, "archive envelope");
  return Object.freeze({
    tarballBytes: positiveInteger(admitted.tarballBytes, "tarball byte limit"),
    unpackedBytes: positiveInteger(admitted.unpackedBytes, "unpacked byte limit"),
    entryBytes: positiveInteger(admitted.entryBytes, "entry byte limit"),
    entries: positiveInteger(admitted.entries, "entry count limit"),
  });
}

function decodeTarText(bytes, label) {
  const zero = bytes.indexOf(0);
  const text = (zero < 0 ? bytes : bytes.subarray(0, zero)).toString("utf8");
  if (text.includes("\ufffd") || /[\u0000-\u001f\u007f]/u.test(text)) {
    fail(`${label} is not canonical UTF-8 text`);
  }
  return text;
}

function decodeTarOctal(bytes, label) {
  if ((bytes[0] & 0x80) !== 0) fail(`${label} uses base-256 encoding`);
  const text = bytes.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(text)) fail(`${label} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is outside range`);
  return value;
}

function safeArchivePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("package/") ||
    value.includes("\\") ||
    value.length > 512 ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("archive entry path is unsafe");
  }
  return value;
}

export function npmPackageTarballFilename(name, version) {
  if (
    typeof name !== "string" ||
    !/^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/u.test(name) ||
    typeof version !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(version)
  ) {
    fail("npm package identity is invalid");
  }
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

export function npmIntegrity(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("npm integrity input must be bytes");
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Parse a bounded canonical npm tarball without trusting npm's JSON listing. */
export function parseCanonicalNpmTarball(tarballBytes, requestedEnvelope) {
  if (!Buffer.isBuffer(tarballBytes)) fail("tarball must be a Buffer");
  const limits = envelope(requestedEnvelope);
  if (tarballBytes.length < 1 || tarballBytes.length > limits.tarballBytes) {
    fail("tarball exceeds its compressed byte envelope");
  }
  let archive;
  try {
    const tarOverhead = (limits.entries * 2 + 4) * 512;
    archive = gunzipSync(tarballBytes, {
      maxOutputLength: limits.unpackedBytes + tarOverhead,
    });
  } catch {
    fail("tarball is not a bounded gzip archive");
  }
  const entries = [];
  const paths = new Set();
  let totalBytes = 0;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!archive.subarray(offset).every((byte) => byte === 0)) {
        fail("tarball has data after its terminal block");
      }
      offset = archive.length;
      break;
    }
    if (entries.length >= limits.entries) fail("tarball has too many entries");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== decodeTarOctal(header.subarray(148, 156), "tar checksum")) {
      fail("tar header checksum is invalid");
    }
    if (header[156] !== 0 && header[156] !== 0x30) {
      fail("tarball may contain only regular files");
    }
    const name = decodeTarText(header.subarray(0, 100), "tar entry name");
    const prefix = decodeTarText(header.subarray(345, 500), "tar entry prefix");
    const path = safeArchivePath(prefix.length === 0 ? name : `${prefix}/${name}`);
    if (paths.has(path)) fail("tarball contains a duplicate path");
    paths.add(path);
    const size = decodeTarOctal(header.subarray(124, 136), `${path} size`);
    if (size > limits.entryBytes) fail("tarball entry exceeds its byte envelope");
    const mode = decodeTarOctal(header.subarray(100, 108), `${path} mode`);
    if (mode > 0o777 || (mode !== 0o644 && mode !== 0o755)) {
      fail("tarball entry mode is not canonical");
    }
    totalBytes += size;
    if (totalBytes > limits.unpackedBytes) fail("tarball exceeds its unpacked byte envelope");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > archive.length || nextOffset > archive.length) {
      fail("tarball entry is truncated");
    }
    if (!archive.subarray(dataEnd, nextOffset).every((byte) => byte === 0)) {
      fail("tarball entry padding is not canonical");
    }
    const bytes = Buffer.from(archive.subarray(dataStart, dataEnd));
    entries.push(Object.freeze({
      path,
      mode,
      size,
      sha256: sha256(bytes),
      bytes,
    }));
    offset = nextOffset;
  }
  if (offset !== archive.length || entries.length === 0) {
    fail("tarball is truncated or empty");
  }
  const sorted = Object.freeze(
    entries.sort((left, right) => compareCanonicalText(left.path, right.path)),
  );
  return Object.freeze({
    entries: sorted,
    tarballBytes: tarballBytes.length,
    unpackedBytes: totalBytes,
    fileCount: sorted.length,
    sha256: sha256(tarballBytes),
    integrity: npmIntegrity(tarballBytes),
    archiveInventorySha256: archiveInventorySha256(sorted),
  });
}

export function archiveInventorySha256(entries) {
  if (!Array.isArray(entries) || entries.length < 1) {
    fail("archive inventory must contain entries");
  }
  const digest = createHash("sha256");
  const paths = new Set();
  for (const entry of [...entries].sort((left, right) =>
    compareCanonicalText(String(left?.path), String(right?.path)))) {
    const value = record(entry, "archive inventory entry");
    const path = safeArchivePath(value.path);
    if (paths.has(path)) fail("archive inventory contains a duplicate path");
    paths.add(path);
    if (!Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
      fail("archive inventory mode is invalid");
    }
    if (!Number.isSafeInteger(value.size) || value.size < 0) {
      fail("archive inventory size is invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(value.sha256)) {
      fail("archive inventory digest is invalid");
    }
    digest.update(path).update("\0")
      .update(value.mode.toString(8)).update("\0")
      .update(String(value.size)).update("\0")
      .update(value.sha256).update("\n");
  }
  return digest.digest("hex");
}

function canonicalArtifact(value, label) {
  const artifact = record(value, label);
  const packageIdentity = record(artifact.package, `${label}.package`);
  const output = {
    package: {
      name: packageIdentity.name,
      version: packageIdentity.version,
    },
    filename: artifact.filename,
    sha256: artifact.sha256,
    integrity: artifact.integrity,
    bytes: artifact.bytes,
    unpackedBytes: artifact.unpackedBytes,
    fileCount: artifact.fileCount,
    archiveInventorySha256: artifact.archiveInventorySha256,
  };
  if (output.filename !== npmPackageTarballFilename(output.package.name, output.package.version)) {
    fail(`${label} filename does not match its package identity`);
  }
  if (!/^[a-f0-9]{64}$/u.test(output.sha256) ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(output.integrity) ||
      !/^[a-f0-9]{64}$/u.test(output.archiveInventorySha256)) {
    fail(`${label} digests are invalid`);
  }
  positiveInteger(output.bytes, `${label}.bytes`);
  positiveInteger(output.unpackedBytes, `${label}.unpackedBytes`);
  positiveInteger(output.fileCount, `${label}.fileCount`);
  return output;
}

export function computeReleaseSetSha256(commit, artifacts, bindings) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) fail("release commit is invalid");
  const set = record(artifacts, "release artifacts");
  const admittedBindings = record(bindings, "release bindings");
  const canonical = {
    commit,
    artifacts: {
      connector: canonicalArtifact(set.connector, "connector artifact"),
    },
    bindings: {
      npmPackage: admittedBindings.npmPackage,
    },
  };
  if (canonical.bindings.npmPackage !== "open-rfc") {
    fail("release binding does not identify the public npm package");
  }
  return sha256(Buffer.from(JSON.stringify(canonical)));
}

/** Prove that the replacement contains exactly the standalone connector tree. */
export function assertEmbeddedArtifactExact(
  connectorEntries,
  replacementEntries,
  prefix = "package/node_modules/open-rfc/",
) {
  if (!Array.isArray(connectorEntries) || !Array.isArray(replacementEntries)) {
    fail("embedded comparison requires two entry arrays");
  }
  if (!prefix.startsWith("package/") || !prefix.endsWith("/")) {
    fail("embedded package prefix is invalid");
  }
  const embedded = replacementEntries.filter((entry) => entry.path.startsWith(prefix));
  if (embedded.length !== connectorEntries.length) {
    fail("embedded connector entry count differs from the standalone artifact");
  }
  const byPath = new Map(embedded.map((entry) => [entry.path.slice(prefix.length), entry]));
  for (const connector of connectorEntries) {
    const relative = connector.path.slice("package/".length);
    const candidate = byPath.get(relative);
    if (
      candidate === undefined ||
      candidate.mode !== connector.mode ||
      candidate.size !== connector.size ||
      candidate.sha256 !== connector.sha256
    ) {
      fail("embedded connector differs from the standalone artifact");
    }
  }
  return Object.freeze({
    entryCount: connectorEntries.length,
    inventorySha256: archiveInventorySha256(connectorEntries),
  });
}
