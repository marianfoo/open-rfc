#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".site");
const python = process.env.OPEN_RFC_DOCS_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const temporary = await mkdtemp(join(tmpdir(), "open-rfc-docs-"));
  const docs = join(temporary, "docs_page");
  const config = join(temporary, "mkdocs.yml");

  try {
    await cp(resolve(root, "docs_page"), docs, { recursive: true });
    await copyFile(resolve(root, "mkdocs.yml"), config);
    for (const path of await markdownFiles(docs)) {
      const source = await readFile(path, "utf8");
      const rendered = source
        .replaceAll("{{OPEN_RFC_PACKAGE_VERSION}}", manifest.version)
        .replaceAll("{{OPEN_RFC_NODE_ENGINE}}", manifest.engines.node);
      await writeFile(path, rendered);
    }

    await rm(output, { recursive: true, force: true });
    const result = spawnSync(
      python,
      [
        "-m",
        "mkdocs",
        "build",
        "--strict",
        "--config-file",
        config,
        "--site-dir",
        output,
      ],
      { cwd: temporary, stdio: "inherit" },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`mkdocs exited with status ${result.status ?? "unknown"}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
