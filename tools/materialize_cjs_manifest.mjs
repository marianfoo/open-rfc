#!/usr/bin/env node

import {
  chmod,
  lstat,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class CjsManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "CjsManifestError";
  }
}

function fail(message) {
  throw new CjsManifestError(message);
}

async function metadata(path, label) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail(`${label} metadata is unavailable`);
  }
}

async function materialize() {
  if (process.argv.length !== 2) {
    fail("this command does not accept arguments or path overrides");
  }
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const source = join(root, "cjs-package.json");
  const destination = join(root, "dist", "cjs", "package.json");
  const [sourceMetadata, parentMetadata] = await Promise.all([
    metadata(source, "CommonJS source manifest"),
    metadata(dirname(destination), "CommonJS output directory"),
  ]);
  if (
    sourceMetadata === undefined ||
    !sourceMetadata.isFile() ||
    sourceMetadata.isSymbolicLink()
  ) {
    fail("CommonJS source manifest is not a regular file");
  }
  if (
    parentMetadata === undefined ||
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink()
  ) {
    fail("CommonJS output directory is not a real directory");
  }
  const bytes = await readFile(source);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CommonJS source manifest is not valid JSON");
  }
  if (
    JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["type"]) ||
    manifest.type !== "commonjs"
  ) {
    fail("CommonJS source manifest does not match its exact contract");
  }
  const destinationMetadata = await metadata(destination, "CommonJS output manifest");
  if (destinationMetadata !== undefined) {
    if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink()) {
      fail("CommonJS output manifest is not a regular file");
    }
    await unlink(destination);
  }
  try {
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o644);
  } catch {
    fail("CommonJS output manifest could not be materialized");
  }
  const finalMetadata = await lstat(destination);
  if (
    !finalMetadata.isFile() ||
    finalMetadata.isSymbolicLink() ||
    (finalMetadata.mode & 0o777) !== 0o644
  ) {
    fail("CommonJS output manifest mode is not deterministic");
  }
}

try {
  await materialize();
} catch (error) {
  const message = error instanceof CjsManifestError
    ? error.message
    : "unexpected CommonJS manifest failure";
  process.stderr.write(`open-rfc CJS manifest failed: ${message}\n`);
  process.exitCode = 1;
}
