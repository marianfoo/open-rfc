#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectDocumentationExamples } from "./documentation_examples.mjs";
import { checkV1RoadmapDocumentation } from "./v1_roadmap.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(TOOL_DIRECTORY, "..");
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)]+)\)/gu;

export class DocumentationCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentationCheckError";
  }
}

function fail(message) {
  throw new DocumentationCheckError(message);
}

function trackedMarkdownFiles(root) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z", "--", "*.md", "**/*.md"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail("cannot enumerate tracked Markdown files");
  }
  return [...new Set(output.split("\0").filter(Boolean))]
    .filter((path) => existsSync(resolve(root, path)))
    .sort();
}

function destinationToken(raw) {
  const value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) return value.slice(1, -1);
  const title = /^(\S+)(?:\s+["'][^"']*["'])$/u.exec(value);
  return title?.[1] ?? value;
}

function decodedPath(value, source) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${source} contains an invalid percent-encoded link`);
  }
}

export function checkMarkdownSource(source, sourcePath, root = DEFAULT_ROOT) {
  if (typeof source !== "string") fail(`${sourcePath} is not text`);
  if (source.includes("\r")) fail(`${sourcePath} must use LF line endings`);
  if (/(?:^|\n)[^\n]*[ \t]+(?=\n|$)/u.test(source)) {
    fail(`${sourcePath} contains trailing whitespace`);
  }
  if (/\bfile:\/\//iu.test(source) || /(?:^|[(`])\/Users\//u.test(source)) {
    fail(`${sourcePath} contains a machine-local file link`);
  }
  if (/:\/\/[^/\s:@]+:[^/\s@]+@/u.test(source)) {
    fail(`${sourcePath} contains a credential-bearing URL`);
  }

  const sourceDirectory = dirname(resolve(root, sourcePath));
  let linkCount = 0;
  for (const match of source.matchAll(MARKDOWN_LINK)) {
    const destination = destinationToken(match[1]);
    if (
      destination.length === 0 ||
      destination.startsWith("#") ||
      /^(?:https?:|mailto:)/iu.test(destination)
    ) {
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)) {
      fail(`${sourcePath} contains an unsupported link scheme`);
    }
    const [pathPart] = destination.split("#", 1);
    if (pathPart.length === 0) continue;
    const path = decodedPath(pathPart, sourcePath);
    if (isAbsolute(path)) fail(`${sourcePath} contains an absolute local link`);
    const target = resolve(sourceDirectory, path);
    const fromRoot = relative(root, target);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      fail(`${sourcePath} contains a link outside the repository`);
    }
    if (!existsSync(target)) {
      fail(`${sourcePath} links to a missing local target`);
    }
    linkCount += 1;
  }
  return Object.freeze({ linkCount });
}

export async function checkDocumentation(root = DEFAULT_ROOT, { publicOnly = false } = {}) {
  const files = trackedMarkdownFiles(root);
  let linkCount = 0;
  let bytes = 0;
  const documents = [];
  for (const path of files) {
    const source = readFileSync(resolve(root, path), "utf8");
    const result = checkMarkdownSource(source, path, root);
    linkCount += result.linkCount;
    bytes += Buffer.byteLength(source);
    documents.push({ path, source });
  }
  const examples = collectDocumentationExamples(documents);
  await checkV1RoadmapDocumentation(root);
  if (!publicOnly) {
    const [
      { checkCapabilitySupport },
      { checkBetaGateDocumentation },
      { checkCapabilityClaimConsistency },
    ] = await Promise.all([
      import(["./capability", "_docs.mjs"].join("")),
      import(["./beta", "_gate_ledger.mjs"].join("")),
      import(["./capability", "_claim_consistency.mjs"].join("")),
    ]);
    const capabilityManifest = JSON.parse(
      readFileSync(resolve(root, "conformance/capabilities.v1.json"), "utf8"),
    );
    checkCapabilityClaimConsistency(
      capabilityManifest,
      new Map(documents.map(({ path, source }) => [path, source])),
    );
    await checkCapabilitySupport(root);
    await checkBetaGateDocumentation(root);
  }
  return Object.freeze({
    fileCount: files.length,
    linkCount,
    bytes,
    exampleCount: examples.length,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--public")) {
      fail("usage: node tools/docs_check.mjs [--public]");
    }
    const result = await checkDocumentation(DEFAULT_ROOT, {
      publicOnly:
        arguments_[0] === "--public" ||
        !existsSync(resolve(DEFAULT_ROOT, "docs")),
    });
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
