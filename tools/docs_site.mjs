import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parse as parseHtmlDocument } from "parse5";

import {
  publicationEnvironmentSecrets,
  publicationSecretPatternIndex,
} from "./publication_safety.mjs";
import {
  CONNECTOR_ARCHIVE_ENVELOPE,
  parseCanonicalNpmTarball,
} from "./release_set_contract.mjs";
import { runTrustedGit } from "./trusted_git.mjs";
import { verifyCandidateBundle } from "./verify_candidate_bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = join(ROOT, "docs_page");
const DEFAULT_CONFIG = join(ROOT, "mkdocs.yml");
const DEFAULT_OUTPUT = join(ROOT, ".site");
const DEFAULT_PACKAGE_MANIFEST = join(ROOT, "package.json");
const DEFAULT_PYTHON = process.env.OPEN_RFC_DOCS_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILES = 4096;
const MAX_HTML_ATTRIBUTES = 512;
const DOCS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
].join("; ");
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const URL_ATTRIBUTE_NAMES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const ACTIVE_CONTENT_ATTRIBUTE_NAMES = new Set([
  "archive",
  "attributionsrc",
  "classid",
  "clip-path",
  "codebase",
  "cursor",
  "dynsrc",
  "fill",
  "filter",
  "http-equiv",
  "imagesrcset",
  "longdesc",
  "lowsrc",
  "manifest",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "ping",
  "profile",
  "srcdoc",
  "stroke",
  "style",
  "usemap",
]);

const PUBLIC_FACT_TOKENS = Object.freeze({
  packageVersion: "{{OPEN_RFC_PACKAGE_VERSION}}",
  nodeEngine: "{{OPEN_RFC_NODE_ENGINE}}",
});

const PUBLIC_FACT_TOKEN_COUNTS = Object.freeze({
  "cap.md": Object.freeze({ packageVersion: 2, nodeEngine: 0 }),
  "getting-started.md": Object.freeze({ packageVersion: 3, nodeEngine: 1 }),
  "node-rfc.md": Object.freeze({ packageVersion: 2, nodeEngine: 0 }),
  "status.md": Object.freeze({ packageVersion: 3, nodeEngine: 0 }),
});

export function resolveDocsPythonExecutable(
  pythonExecutable,
  repositoryRoot = ROOT,
) {
  if (
    typeof pythonExecutable !== "string" ||
    pythonExecutable.length === 0 ||
    pythonExecutable.includes("\0")
  ) {
    fail("Python executable must be a non-empty path or command name");
  }
  if (isAbsolute(pythonExecutable)) return pythonExecutable;
  if (pythonExecutable.includes("/") || pythonExecutable.includes("\\")) {
    return resolve(repositoryRoot, pythonExecutable);
  }
  return pythonExecutable;
}

const PAGES = Object.freeze([
  "index",
  "getting-started",
  "standalone",
  "node-rfc",
  "cap",
  "configuration",
  "api",
  "routes",
  "safety",
  "troubleshooting",
  "operations",
  "policies",
  "glossary",
  "roadmap",
  "status",
]);

const EXPECTED_SOURCE_FILES = Object.freeze([
  ...PAGES.map((slug) => `${slug}.md`),
  "overrides/main.html",
  "stylesheets/extra.css",
].sort());

const CANDIDATE_DOCUMENTATION_PATHS = Object.freeze([
  ...EXPECTED_SOURCE_FILES.map((path) => `docs_page/${path}`),
  "mkdocs.yml",
  "requirements-docs.txt",
].sort());

const EXPECTED_HTML_FILES = Object.freeze([
  "index.html",
  ...PAGES.slice(1).map((slug) => `${slug}/index.html`),
]);

const FORBIDDEN_PUBLIC_TEXT = Object.freeze([
  /\/Users\//u,
  /\/home\//u,
  /\b[A-Za-z]:[\\/](?:Documents and Settings|Users)[\\/]/iu,
  new RegExp(["UN", "APPROVED"].join(""), "u"),
  /\bINFRASTRUCTURE\.md\b/iu,
  new RegExp([
    "\\b(?:",
    ["A", "4H"].join(""),
    "|",
    ["N", "PL"].join(""),
    "|",
    ["D", "W4"].join(""),
    ")\\b",
  ].join(""), "u"),
  new RegExp([
    "\\b(?:",
    ["S4", "HANA-20"].join(""),
    "\\d{2}|",
    ["NET", "WEAVER-750"].join(""),
    ")\\b",
  ].join(""), "u"),
  new RegExp([
    "\\b(?:",
    ["OR", "FC_"].join(""),
    "|",
    ["ZO", "RFC_"].join(""),
    ")[A-Z0-9_]*\\b",
  ].join(""), "u"),
  new RegExp([
    "\\b(?:",
    ["release", "-readiness"].join(""),
    "|",
    ["session", "-handoff"].join(""),
    "|",
    ["publication", "-plan"].join(""),
    ")\\.md\\b",
  ].join(""), "iu"),
  new RegExp([
    "\\b",
    ["beta", "-gates"].join(""),
    "\\.v1\\.json\\b",
  ].join(""), "iu"),
  /oracle\//iu,
  new RegExp(["sdk", "oracle"].join("_"), "iu"),
  new RegExp(["decom", "pil"].join(""), "iu"),
  new RegExp(["nwrfc", "750P_"].join(""), "iu"),
]);

// These are the exact inline programs emitted by the hash-pinned MkDocs
// Material 9.7.7 toolchain for this configuration. The two page-relative
// variants are intentional. JSON configuration scripts are included because
// the reviewed bundle consumes their contents at runtime.
const REVIEWED_INLINE_SCRIPT_SHA256 = new Set([
  "0eb10c249dbdb0beef225a10ce5cbe55418cc4a7014cc208f8e7d6ed8f00906e",
  "6a9a103c779f08d5a3c5b0a6f87cd50ce016e024955a163b5729508e0385c9f9",
  "7b390c5aec595371bd86fbecdf31805ad972dd6f9440623b57b41c1ec5887bac",
  "ad9d9beb0b2a488393fd6d47238313bfd19c368ff9ad81531f133df5c0238ab3",
  "e441dbdde5a0501b99527bb443d86875df7b1a02ed15df77ed97b4c8234e4b70",
  "fcaf69d89b44a82c9c2f67d26c4a2731a924b5e5a9007bf9ef1db09dd2ea30da",
  "ffcc0f7735fdab434d257c80e65cec2e88d716991e69757185b7e450e41a5b2f",
]);
const REVIEWED_EXECUTABLE_ASSET_SHA256 = Object.freeze(new Map([
  [
    "assets/javascripts/bundle.d7400e89.min.js",
    "f288ab99e197c406766aea4581ba6e902d7d0e28c013bdd3cd3fab6cc77fb7c8",
  ],
  [
    "assets/javascripts/workers/search.2c215733.min.js",
    "cfb35333fafd6d2eb148eba21452849fb7fbde32fdfbf986836573f963106188",
  ],
]));

function fail(message) {
  throw new Error(`documentation site: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function structuralSourceClosure(entries) {
  const manifest = Object.freeze(entries.map(({ path, bytes }) => Object.freeze({
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
  })));
  return Object.freeze({
    fileCount: manifest.length,
    bytes: manifest.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8")),
    manifest,
  });
}

/**
 * Read the complete reviewed documentation input closure from one exact Git
 * commit. Returned byte buffers come from Git objects, never the worktree.
 */
export function readCandidateDocumentationSources(repositoryRoot, commit) {
  if (
    typeof repositoryRoot !== "string" ||
    repositoryRoot.length === 0 ||
    repositoryRoot.includes("\0")
  ) fail("candidate documentation repository must be a non-empty path");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
    fail("candidate documentation commit must be a canonical SHA-1 object name");
  }

  const root = resolve(repositoryRoot);
  const resolvedCommit = String(runTrustedGit(
    root,
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { maxBuffer: 128 * 1024 },
  )).trim();
  if (resolvedCommit !== commit) fail("candidate documentation commit did not resolve exactly");

  const rawInventory = runTrustedGit(
    root,
    [
      "ls-tree", "-r", "-z", commit, "--",
      "docs_page", "mkdocs.yml", "requirements-docs.txt",
    ],
    { encoding: null, maxBuffer: 128 * 1024 },
  );
  if (rawInventory.length === 0 || rawInventory.at(-1) !== 0) {
    fail("candidate documentation Git inventory is not canonical");
  }
  const rawEntries = rawInventory
    .subarray(0, rawInventory.length - 1)
    .toString("utf8")
    .split("\0");
  if (!Buffer.from(`${rawEntries.join("\0")}\0`, "utf8").equals(rawInventory)) {
    fail("candidate documentation Git inventory is not canonical UTF-8");
  }
  const treeEntries = rawEntries.map((entry) => {
    const match = /^100644 blob ([0-9a-f]{40})\t([^\0]+)$/u.exec(entry);
    if (match === null) {
      fail("candidate documentation Git inventory contains a non-regular source");
    }
    return Object.freeze({ object: match[1], path: match[2] });
  });
  const inventory = treeEntries.map(({ path }) => path);
  if (
    JSON.stringify(inventory) !== JSON.stringify(CANDIDATE_DOCUMENTATION_PATHS)
  ) fail("candidate documentation Git inventory differs from the reviewed allowlist");

  const entries = Object.freeze(treeEntries.map(({ object, path }) => {
    const bytes = runTrustedGit(
      root,
      ["cat-file", "blob", object],
      { encoding: null, maxBuffer: MAX_SOURCE_BYTES + 1 },
    );
    if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) {
      fail(`candidate documentation input is outside its byte envelope: ${path}`);
    }
    return Object.freeze({ path, bytes, sha256: sha256(bytes) });
  }));
  const documentation = Object.freeze(entries
    .filter(({ path }) => path.startsWith("docs_page/"))
    .map(({ path, bytes, sha256: digest }) => Object.freeze({
      path: path.slice("docs_page/".length),
      bytes,
      sha256: digest,
    })));
  const config = entries.find(({ path }) => path === "mkdocs.yml");
  const requirements = entries.find(({ path }) => path === "requirements-docs.txt");
  if (config === undefined || requirements === undefined) {
    fail("candidate documentation Git inventory lacks a required root input");
  }

  const complete = structuralSourceClosure(entries);
  return Object.freeze({
    documentation,
    config: Object.freeze({ bytes: config.bytes, sha256: config.sha256 }),
    requirements: Object.freeze({ bytes: requirements.bytes, sha256: requirements.sha256 }),
    source: Object.freeze({
      commit,
      fileCount: complete.fileCount,
      sha256: complete.sha256,
      configurationSha256: config.sha256,
      requirementsSha256: requirements.sha256,
      requirements: Object.freeze({ bytes: requirements.bytes }),
    }),
  });
}

function assertSeparateTrees(first, second, label) {
  const firstRoot = resolve(first);
  const secondRoot = resolve(second);
  if (
    firstRoot === secondRoot ||
    firstRoot.startsWith(`${secondRoot}${sep}`) ||
    secondRoot.startsWith(`${firstRoot}${sep}`)
  ) {
    fail(`${label} must not overlap the source tree`);
  }
}

function inheritedEnvironmentValue(environment, names) {
  for (const name of names) {
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.includes("\0")) fail(`inherited ${name} contains a null byte`);
    return value;
  }
  return undefined;
}

export function docsBuildEnvironment(
  environment,
  { platform = process.platform, temporaryHome } = {},
) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    fail("build environment must be an object");
  }
  if (
    typeof temporaryHome !== "string" ||
    temporaryHome.length === 0 ||
    temporaryHome.includes("\0")
  ) {
    fail("temporary build home must be a non-empty path");
  }

  const child = {};
  if (platform === "win32") {
    const path = inheritedEnvironmentValue(environment, ["Path", "PATH"]);
    const pathExtensions = inheritedEnvironmentValue(environment, ["PATHEXT"]);
    const systemRoot = inheritedEnvironmentValue(environment, ["SystemRoot", "SYSTEMROOT"]);
    const windowsDirectory = inheritedEnvironmentValue(environment, ["WINDIR"]);
    if (path !== undefined) child.Path = path;
    if (pathExtensions !== undefined) child.PATHEXT = pathExtensions;
    if (systemRoot !== undefined) child.SystemRoot = systemRoot;
    if (windowsDirectory !== undefined) child.WINDIR = windowsDirectory;
    child.USERPROFILE = temporaryHome;
    child.TEMP = temporaryHome;
    child.TMP = temporaryHome;
  } else {
    const path = inheritedEnvironmentValue(environment, ["PATH"]);
    if (path !== undefined) child.PATH = path;
    child.TMPDIR = temporaryHome;
  }

  child.HOME = temporaryHome;
  child.PYTHONUTF8 = "1";
  child.PYTHONDONTWRITEBYTECODE = "1";
  child.PYTHONHASHSEED = "0";
  child.TZ = "UTC";
  child.NO_COLOR = "1";
  return Object.freeze(child);
}

function walkFiles(root, { maximumFiles = MAX_OUTPUT_FILES } = {}) {
  const rootPath = resolve(root);
  let rootInformation;
  try {
    rootInformation = lstatSync(rootPath);
  } catch {
    fail("source or output root is missing");
  }
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    fail("source or output root must be a regular directory");
  }

  const files = [];
  const pending = [{ absolute: rootPath, prefix: "" }];
  while (pending.length > 0) {
    const { absolute: directory, prefix } = pending.pop();
    const entries = readdirSync(directory).sort().reverse();
    for (const name of entries) {
      const absolute = join(directory, name);
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      const information = lstatSync(absolute);
      if (information.isSymbolicLink()) fail(`tree must not contain symlinks: ${path}`);
      if (information.isDirectory()) pending.push({ absolute, prefix: path });
      else if (information.isFile()) {
        files.push(path);
        if (files.length > maximumFiles) fail("tree contains too many files");
      } else fail(`tree contains a non-file entry: ${path}`);
    }
  }
  return files.sort();
}

function regularBytes(path, label, maximumBytes = MAX_SOURCE_BYTES) {
  let information;
  try {
    information = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!information.isFile() || information.isSymbolicLink()) {
    fail(`${label} must be a regular non-symbolic file`);
  }
  if (information.size < 1 || information.size > maximumBytes) {
    fail(`${label} is outside its byte envelope`);
  }
  return readFileSync(path);
}

function assertPublicSafe(path, bytes, environmentSecrets) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail(`source is not UTF-8: ${path}`);
  if (text.includes("\r") || !text.endsWith("\n")) {
    fail(`source must use LF and end with a newline: ${path}`);
  }
  for (const forbidden of FORBIDDEN_PUBLIC_TEXT) {
    if (forbidden.test(text)) fail(`source contains an internal-only reference: ${path}`);
  }
  const secret = publicationSecretPatternIndex(bytes, environmentSecrets);
  if (secret !== null) fail(`source failed the non-echoing secret scan (${secret}): ${path}`);
  return text;
}

function publicPackageFacts(path, environmentSecrets) {
  let manifest;
  try {
    manifest = JSON.parse(regularBytes(resolve(path), "package manifest").toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("documentation site:")) throw error;
    fail("package manifest is not readable JSON");
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(manifest.version) ||
    manifest.engines === null ||
    typeof manifest.engines !== "object" ||
    Array.isArray(manifest.engines) ||
    typeof manifest.engines.node !== "string" ||
    manifest.engines.node.length < 1 ||
    manifest.engines.node.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(manifest.engines.node)
  ) {
    fail("package manifest has invalid public version or Node.js engine facts");
  }
  const facts = Object.freeze({
    packageVersion: manifest.version,
    nodeEngine: manifest.engines.node,
  });
  for (const value of Object.values(facts)) {
    for (const forbidden of FORBIDDEN_PUBLIC_TEXT) {
      if (forbidden.test(value)) fail("package manifest contains an internal-only reference");
    }
    const secret = publicationSecretPatternIndex(value, environmentSecrets);
    if (secret !== null) fail(`package manifest failed the non-echoing secret scan (${secret})`);
  }
  return facts;
}

function renderPublicFacts(path, source, facts) {
  let rendered = source;
  for (const [name, token] of Object.entries(PUBLIC_FACT_TOKENS)) {
    const matches = rendered.split(token).length - 1;
    const expected = PUBLIC_FACT_TOKEN_COUNTS[path]?.[name] ?? 0;
    if (matches !== expected) fail(`source has an invalid ${name} token count: ${path}`);
    if (expected > 0) rendered = rendered.replaceAll(token, facts[name]);
  }
  if (/\{\{OPEN_RFC_[^\n]*$/mu.test(rendered)) {
    fail(`source contains an unknown public fact token: ${path}`);
  }
  return rendered;
}

export function prepareDocsSite({
  source = DEFAULT_SOURCE,
  config = DEFAULT_CONFIG,
  staging,
  packageManifest = DEFAULT_PACKAGE_MANIFEST,
  environment = process.env,
} = {}) {
  if (staging === undefined) fail("a staging directory is required");
  const sourceRoot = resolve(source);
  const stagingRoot = resolve(staging);
  assertSeparateTrees(sourceRoot, stagingRoot, "staging directory");

  const inventory = walkFiles(sourceRoot, { maximumFiles: 64 });
  if (JSON.stringify(inventory) !== JSON.stringify(EXPECTED_SOURCE_FILES)) {
    fail("source inventory differs from the reviewed public allowlist");
  }
  const environmentSecrets = publicationEnvironmentSecrets(environment);
  const facts = publicPackageFacts(packageManifest, environmentSecrets);
  const configText = assertPublicSafe(
    "mkdocs.yml",
    regularBytes(resolve(config), "MkDocs configuration"),
    environmentSecrets,
  );
  const sources = new Map(inventory.map((path) => {
    const bytes = regularBytes(join(sourceRoot, path), `documentation source ${path}`);
    const text = assertPublicSafe(path, bytes, environmentSecrets);
    return [path, renderPublicFacts(path, text, facts)];
  }));

  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(join(stagingRoot, "docs_page"), { recursive: true });
  writeFileSync(join(stagingRoot, "mkdocs.yml"), configText, { flag: "wx" });
  for (const path of inventory) {
    const destination = join(stagingRoot, "docs_page", path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, sources.get(path), { flag: "wx" });
  }

  return Object.freeze({
    pages: PAGES.length,
    sourceFiles: inventory.length,
    packageVersion: facts.packageVersion,
    nodeEngine: facts.nodeEngine,
  });
}

function decodeHtmlAttribute(value, pagePath) {
  const decoded = value.replaceAll(
    /&(?:#(?:x[0-9A-Fa-f]+|[0-9]+)|amp|apos|gt|lt|quot);/gu,
    (entity) => {
      const named = new Map([
        ["&amp;", "&"],
        ["&apos;", "'"],
        ["&gt;", ">"],
        ["&lt;", "<"],
        ["&quot;", "\""],
      ]);
      if (named.has(entity)) return named.get(entity);
      const hexadecimal = entity[2]?.toLowerCase() === "x";
      const digits = entity.slice(hexadecimal ? 3 : 2, -1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint < 1 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        fail(`built page has an invalid HTML entity: ${pagePath}`);
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (/&(?:#|[A-Za-z])/u.test(decoded)) {
    fail(`built page has an unsupported HTML entity: ${pagePath}`);
  }
  return decoded;
}

function builtHtmlTagEnd(html, opening, pagePath) {
  let quote = null;
  for (let cursor = opening + 1; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return cursor;
  }
  fail(`built page has an unterminated HTML tag: ${pagePath}`);
}

function parseBuiltHtmlTag(html, opening, closing, pagePath) {
  const content = html.slice(opening + 1, closing);
  let cursor = 0;
  let closingTag = false;
  if (content[cursor] === "/") {
    closingTag = true;
    cursor += 1;
  }
  const nameStart = cursor;
  while (cursor < content.length && /[A-Za-z0-9:-]/u.test(content[cursor])) {
    cursor += 1;
  }
  const tagName = content.slice(nameStart, cursor).toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/u.test(tagName)) {
    fail(`built page has a malformed HTML tag: ${pagePath}`);
  }
  if (closingTag) {
    if (content.slice(cursor).trim().length > 0) {
      fail(`built page has a malformed closing HTML tag: ${pagePath}`);
    }
    return Object.freeze({ attributes: new Map(), closingTag, tagName });
  }

  const attributes = new Map();
  while (cursor < content.length) {
    while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
    if (cursor >= content.length) break;
    if (content[cursor] === "/" && content.slice(cursor + 1).trim().length === 0) break;
    const attributeStart = cursor;
    while (
      cursor < content.length &&
      !/[\s=/>]/u.test(content[cursor])
    ) cursor += 1;
    const rawName = content.slice(attributeStart, cursor);
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(rawName)) {
      fail(`built page has a malformed HTML attribute: ${pagePath}`);
    }
    const name = rawName.toLowerCase();
    if (
      name.startsWith("on") ||
      (ACTIVE_CONTENT_ATTRIBUTE_NAMES.has(name) &&
        !(tagName === "meta" && name === "http-equiv"))
    ) {
      fail(`built page has an unsupported active-content attribute ${name}: ${pagePath}`);
    }
    if (attributes.size >= MAX_HTML_ATTRIBUTES) {
      fail(`built page has too many HTML attributes: ${pagePath}`);
    }
    if (attributes.has(name)) {
      fail(`built page has a duplicate HTML attribute: ${pagePath}`);
    }
    while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
    let value;
    if (content[cursor] === "=") {
      cursor += 1;
      while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
      const quote = content[cursor];
      if (quote === "\"" || quote === "'") {
        const valueStart = cursor + 1;
        const end = content.indexOf(quote, valueStart);
        if (end < 0) fail(`built page has an unterminated HTML attribute: ${pagePath}`);
        value = content.slice(valueStart, end);
        cursor = end + 1;
      } else {
        const valueStart = cursor;
        while (cursor < content.length && !/\s/u.test(content[cursor])) {
          if (/["'<=`]/u.test(content[cursor])) {
            fail(`built page has a malformed unquoted HTML attribute: ${pagePath}`);
          }
          cursor += 1;
        }
        value = content.slice(valueStart, cursor);
      }
      value = decodeHtmlAttribute(value, pagePath);
    }
    if (URL_ATTRIBUTE_NAMES.has(name) && value === undefined) {
      fail(`built page has a malformed URL attribute: ${pagePath}`);
    }
    attributes.set(name, value);
  }
  return Object.freeze({ attributes, closingTag, tagName });
}

function replaceCssEscapes(value, path) {
  return value.replaceAll(
    /\\(?:([0-9A-Fa-f]{1,6})(?:\r\n|[\t\n\f\r ])?|([^\r\n\f]))/gu,
    (_escape, hexadecimal, character) => {
      if (hexadecimal === undefined) return character;
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint < 1 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) fail(`stylesheet has an invalid escape: ${path}`);
      return String.fromCodePoint(codePoint);
    },
  );
}

function decodeCssEscapes(value, path) {
  const decoded = replaceCssEscapes(value, path);
  if (decoded.includes("\\") || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    fail(`stylesheet has an invalid escape: ${path}`);
  }
  return decoded;
}

function normalizeStylesheetForLoadDetection(source, path) {
  const decoded = replaceCssEscapes(source, path);
  if (
    decoded.includes("\\") ||
    /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(decoded)
  ) fail(`stylesheet has an invalid escape: ${path}`);
  return decoded;
}

function assertNoExternalStylesheetLoads(source, path) {
  const normalized = normalizeStylesheetForLoadDetection(source, path);
  if (/@import\b/iu.test(normalized)) {
    fail(`stylesheet has an unsupported import or external URL: ${path}`);
  }
  const matcher = /\burl\s*\(/giu;
  for (
    let match = matcher.exec(normalized);
    match !== null;
    match = matcher.exec(normalized)
  ) {
    let cursor = matcher.lastIndex;
    while (/\s/u.test(normalized[cursor] ?? "")) cursor += 1;
    const quote = normalized[cursor] === "\"" || normalized[cursor] === "'"
      ? normalized[cursor++]
      : null;
    const start = cursor;
    if (quote === null) {
      while (cursor < normalized.length && normalized[cursor] !== ")") {
        if (/['"\u0000-\u001f\u007f]/u.test(normalized[cursor])) {
          fail(`stylesheet has a malformed URL: ${path}`);
        }
        cursor += 1;
      }
    } else {
      while (cursor < normalized.length) {
        if (normalized[cursor] === quote) break;
        cursor += 1;
      }
    }
    if (cursor >= normalized.length) fail(`stylesheet has a malformed URL: ${path}`);
    const rawTarget = normalized.slice(start, cursor).trim();
    if (quote !== null) {
      cursor += 1;
      while (/\s/u.test(normalized[cursor] ?? "")) cursor += 1;
      if (normalized[cursor] !== ")") fail(`stylesheet has a malformed URL: ${path}`);
    }
    matcher.lastIndex = cursor + 1;
    if (rawTarget.length === 0 || rawTarget.length > 8192) {
      fail(`stylesheet has a malformed URL: ${path}`);
    }
    const target = decodeCssEscapes(rawTarget, path);
    if (
      target.startsWith("//") ||
      (URI_SCHEME.test(target) && !target.toLowerCase().startsWith("data:"))
    ) fail(`stylesheet has an unsupported import or external URL: ${path}`);
  }
}

function assertReviewedInlineScript(tag, pagePath) {
  const type = tag.attributes.get("type") ?? "";
  if (type !== "" && type !== "application/json") {
    fail(`built page has an unreviewed inline script type: ${pagePath}`);
  }
  const digest = sha256(Buffer.from(tag.rawText ?? "", "utf8"));
  if (!REVIEWED_INLINE_SCRIPT_SHA256.has(digest)) {
    fail(`built page has an unreviewed inline script: ${pagePath}`);
  }
}

function scanBuiltHtml(html, pagePath) {
  const tags = [];
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) break;
    if (html.startsWith("<!--", opening)) {
      const commentEnd = html.indexOf("-->", opening + 4);
      if (commentEnd < 0) fail(`built page has an unterminated HTML comment: ${pagePath}`);
      cursor = commentEnd + 3;
      continue;
    }
    const lead = html[opening + 1];
    if (lead === "!" || lead === "?") {
      cursor = builtHtmlTagEnd(html, opening, pagePath) + 1;
      continue;
    }
    if (!/[A-Za-z/]/u.test(lead ?? "")) {
      cursor = opening + 1;
      continue;
    }
    const closing = builtHtmlTagEnd(html, opening, pagePath);
    let tag = parseBuiltHtmlTag(html, opening, closing, pagePath);
    cursor = closing + 1;
    if (!tag.closingTag && (tag.tagName === "script" || tag.tagName === "style")) {
      const rawTextEnd = html.toLowerCase().indexOf(`</${tag.tagName}`, cursor);
      if (rawTextEnd < 0) fail(`built page has an unterminated ${tag.tagName} element: ${pagePath}`);
      tag = Object.freeze({ ...tag, rawText: html.slice(cursor, rawTextEnd) });
      cursor = rawTextEnd;
    }
    tags.push(tag);
  }
  return Object.freeze(tags);
}

function standardsBuiltHtmlTags(html, pagePath) {
  const parseErrors = [];
  const document = parseHtmlDocument(html, {
    onParseError: (error) => parseErrors.push(error),
    sourceCodeLocationInfo: true,
  });
  if (parseErrors.length > 0) {
    fail(`built page is not canonical HTML5: ${pagePath}`);
  }
  const tags = [];
  const text = (node) => {
    if (node?.nodeName === "#text") return node.value ?? "";
    return (node?.childNodes ?? []).map((child) => text(child)).join("");
  };
  const visit = (node) => {
    if (typeof node?.tagName === "string") {
      const attributes = new Map();
      for (const attribute of node.attrs ?? []) {
        const name = attribute.name.toLowerCase();
        if (attributes.has(name)) {
          fail(`built page has a duplicate HTML attribute: ${pagePath}`);
        }
        if (
          name.startsWith("on") ||
          (ACTIVE_CONTENT_ATTRIBUTE_NAMES.has(name) &&
            !(node.tagName === "meta" &&
              name === "http-equiv" &&
              attribute.value.toLowerCase() === "content-security-policy"))
        ) {
          fail(`built page has an unsupported active-content attribute ${name}: ${pagePath}`);
        }
        if (
          !URL_ATTRIBUTE_NAMES.has(name) &&
          !(name === "xmlns" && attribute.value === "http://www.w3.org/2000/svg") &&
          /(?:https?|wss?|ftp):|(?:^|[^:])\/\/|\burl\s*\(/iu.test(attribute.value)
        ) fail(`built page hides an external load in an HTML attribute: ${pagePath}`);
        attributes.set(name, attribute.value);
      }
      tags.push(Object.freeze({
        attributes,
        closingTag: false,
        tagName: node.tagName.toLowerCase(),
        rawText: node.tagName === "script" || node.tagName === "style" ? text(node) : undefined,
        startOffset: node.sourceCodeLocation?.startOffset ?? 0,
      }));
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(document);
  return Object.freeze(tags);
}

function builtAnchorInventory(tags, pagePath) {
  const anchors = new Set();
  for (const tag of tags) {
    if (tag.closingTag) continue;
    const candidates = [];
    if (tag.attributes.has("id")) candidates.push(tag.attributes.get("id"));
    if (
      (tag.tagName === "a" || tag.tagName === "area") &&
      tag.attributes.has("name")
    ) candidates.push(tag.attributes.get("name"));
    for (const anchor of new Set(candidates)) {
      if (
        typeof anchor !== "string" ||
        anchor.length === 0 ||
        anchor.length > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(anchor)
      ) fail(`built page has an invalid anchor: ${pagePath}`);
      if (anchors.has(anchor)) fail(`built page has a duplicate anchor: ${pagePath}`);
      anchors.add(anchor);
    }
  }
  return anchors;
}

function resolvedBuiltLink(outputRoot, pagePath, rawTarget, anchorsByPage) {
  if (
    rawTarget.length === 0 ||
    rawTarget.length > 8192 ||
    /[\u0000-\u0020\u007f]/u.test(rawTarget)
  ) fail(`built page has an empty or ambiguous URL attribute: ${pagePath}`);
  if (URI_SCHEME.test(rawTarget) || rawTarget.startsWith("//")) {
    fail(`built page has an unapproved external URL: ${pagePath}`);
  }
  if (rawTarget.includes("\\")) fail(`built page has an ambiguous local URL: ${pagePath}`);

  const hash = rawTarget.indexOf("#");
  const beforeFragment = hash < 0 ? rawTarget : rawTarget.slice(0, hash);
  const rawFragment = hash < 0 ? null : rawTarget.slice(hash + 1);
  const question = beforeFragment.indexOf("?");
  const encodedPath = question < 0 ? beforeFragment : beforeFragment.slice(0, question);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    fail(`built page has an invalid encoded link: ${pagePath}`);
  }
  if (
    decodedPath.includes("\\") ||
    /[\u0000-\u0020\u007f]/u.test(decodedPath) ||
    isAbsolute(decodedPath) ||
    decodedPath.startsWith("/") ||
    /^[A-Za-z]:/u.test(decodedPath) ||
    URI_SCHEME.test(decodedPath)
  ) fail(`built page has an absolute or ambiguous local link: ${pagePath}`);

  const normalized = encodedPath.length === 0
    ? pagePath
    : posix.normalize(posix.join(posix.dirname(pagePath), decodedPath));
  if (normalized === ".." || normalized.startsWith("../")) {
    fail(`built page link escapes the site: ${pagePath}`);
  }
  let candidate = join(outputRoot, ...normalized.split("/"));
  let information;
  try {
    information = lstatSync(candidate);
  } catch {
    fail(`built page has a broken link: ${pagePath}`);
  }
  if (information.isSymbolicLink()) fail(`built page link resolves through a symlink: ${pagePath}`);
  if (information.isDirectory()) {
    candidate = join(candidate, "index.html");
    try {
      information = lstatSync(candidate);
    } catch {
      fail(`built page has a directory link without an index: ${pagePath}`);
    }
  }
  if (!information.isFile() || information.isSymbolicLink()) {
    fail(`built page link does not resolve to a regular file: ${pagePath}`);
  }
  const targetPath = relative(outputRoot, candidate).split(sep).join("/");

  if (rawFragment !== null) {
    let fragment;
    try {
      fragment = decodeURIComponent(rawFragment);
    } catch {
      fail(`built page has an invalid encoded fragment: ${pagePath}`);
    }
    if (
      fragment.length === 0 ||
      fragment.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(fragment)
    ) fail(`built page has an invalid fragment: ${pagePath}`);
    const targetAnchors = anchorsByPage.get(targetPath);
    if (targetAnchors === undefined || !targetAnchors.has(fragment)) {
      fail(`built page has a fragment without a matching anchor: ${pagePath}`);
    }
  }
  return targetPath;
}

function outputManifest(outputRoot, files) {
  const entries = files.map((path) => {
    const bytes = readFileSync(join(outputRoot, path));
    return Object.freeze({ path, bytes: bytes.length, sha256: sha256(bytes) });
  });
  return Object.freeze({
    files: Object.freeze(entries),
    sha256: sha256(Buffer.from(`${JSON.stringify(entries)}\n`, "utf8")),
  });
}

function assertPageContentSecurityPolicy(tags, pagePath) {
  const policies = [];
  let policyIndex = -1;
  for (const [index, tag] of tags.entries()) {
    if (tag.tagName !== "meta" || !tag.attributes.has("http-equiv")) continue;
    if (tag.attributes.get("http-equiv").toLowerCase() !== "content-security-policy") {
      fail(`built page has an unsupported HTTP-equivalent meta directive: ${pagePath}`);
    }
    policies.push(tag.attributes.get("content"));
    policyIndex = index;
  }
  if (policies.length !== 1 || policies[0] !== DOCS_CONTENT_SECURITY_POLICY) {
    fail(`built page is missing the exact reviewed content security policy: ${pagePath}`);
  }
  const loadBearing = new Set(["embed", "iframe", "img", "link", "object", "script", "style"]);
  if (tags.slice(0, policyIndex).some((tag) => loadBearing.has(tag.tagName))) {
    fail(`built page content security policy appears after a load-bearing element: ${pagePath}`);
  }
}

export function verifyBuiltSite({ output = DEFAULT_OUTPUT, environment = process.env } = {}) {
  const outputRoot = resolve(output);
  const files = walkFiles(outputRoot);
  let totalBytes = 0;
  for (const path of files) {
    const information = lstatSync(join(outputRoot, path));
    if (information.size > MAX_OUTPUT_FILE_BYTES) fail(`built file is too large: ${path}`);
    totalBytes += information.size;
    if (totalBytes > MAX_OUTPUT_BYTES) fail("built site is outside its total byte envelope");
  }

  const htmlFiles = files.filter((path) => extname(path) === ".html");
  const cssFiles = files.filter((path) => extname(path) === ".css");
  const javascriptFiles = files.filter((path) => extname(path) === ".js");
  if (
    javascriptFiles.length > 64 ||
    javascriptFiles.some((path) =>
      !/^assets\/javascripts\/(?:bundle\.[a-f0-9]{8}\.min\.js|workers\/search\.[a-f0-9]{8}\.min\.js|lunr\/(?:min\/lunr\.[a-z.]+\.min\.js|tinyseg\.js|wordcut\.js))$/u.test(path))
  ) fail("built site contains an unreviewed executable asset path");
  if (javascriptFiles.length > 0) {
    for (const [path, expectedDigest] of REVIEWED_EXECUTABLE_ASSET_SHA256) {
      if (!javascriptFiles.includes(path)) {
        fail(`built site is missing a reviewed executable asset: ${path}`);
      }
      const actualDigest = sha256(readFileSync(join(outputRoot, path)));
      if (actualDigest !== expectedDigest) {
        fail(`built site executable asset differs from its reviewed bytes: ${path}`);
      }
    }
  }
  const allowedHtml = new Set(EXPECTED_HTML_FILES);
  for (const expected of EXPECTED_HTML_FILES) {
    if (!htmlFiles.includes(expected)) fail(`built site is missing page output: ${expected}`);
  }
  for (const path of htmlFiles) {
    if (!allowedHtml.has(path)) fail(`built site contains an unexpected HTML page: ${path}`);
  }

  const environmentSecrets = publicationEnvironmentSecrets(environment);
  const searchable = new Set([
    ...htmlFiles,
    ...files.filter((path) => path === "search/search_index.json"),
  ]);
  for (const path of searchable) {
    const bytes = readFileSync(join(outputRoot, path));
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail(`built public text is not UTF-8: ${path}`);
    if (text.includes("{{OPEN_RFC_")) fail(`built public text contains an unresolved fact: ${path}`);
    for (const forbidden of FORBIDDEN_PUBLIC_TEXT) {
      if (forbidden.test(text)) fail(`built public text contains an internal-only reference: ${path}`);
    }
    const secret = publicationSecretPatternIndex(bytes, environmentSecrets);
    if (secret !== null) fail(`built public text failed the non-echoing secret scan (${secret}): ${path}`);
  }

  for (const path of cssFiles) {
    const bytes = readFileSync(join(outputRoot, path));
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      fail(`built stylesheet is not UTF-8: ${path}`);
    }
    assertNoExternalStylesheetLoads(text, path);
  }

  const tagsByPage = new Map();
  const anchorsByPage = new Map();
  for (const pagePath of htmlFiles) {
    const html = readFileSync(join(outputRoot, pagePath), "utf8");
    scanBuiltHtml(html, pagePath);
    const tags = standardsBuiltHtmlTags(html, pagePath);
    assertPageContentSecurityPolicy(tags, pagePath);
    tagsByPage.set(pagePath, tags);
    anchorsByPage.set(pagePath, builtAnchorInventory(tags, pagePath));
  }

  for (const pagePath of htmlFiles) {
    const html = readFileSync(join(outputRoot, pagePath), "utf8");
    if (!/<strong>0\.x beta\.<\/strong>/u.test(html)) {
      fail(`built page is missing the release warning: ${pagePath}`);
    }
    let externalScriptCount = 0;
    for (const tag of tagsByPage.get(pagePath)) {
      if (tag.closingTag) continue;
      if (tag.tagName === "script" && !tag.attributes.has("src")) {
        assertReviewedInlineScript(tag, pagePath);
      }
      if (tag.tagName === "style") {
        assertNoExternalStylesheetLoads(tag.rawText ?? "", pagePath);
      }
      for (const [name, value] of tag.attributes) {
        if (!URL_ATTRIBUTE_NAMES.has(name)) continue;
        if (name !== "href" && name !== "src") {
          fail(`built page has an unsupported ${name} URL attribute: ${pagePath}`);
        }
        const targetPath = resolvedBuiltLink(
          outputRoot,
          pagePath,
          value,
          anchorsByPage,
        );
        if (tag.tagName === "script" && name === "src") {
          externalScriptCount += 1;
          if (!REVIEWED_EXECUTABLE_ASSET_SHA256.has(targetPath)) {
            fail(`built page references an unreviewed executable asset: ${pagePath}`);
          }
        }
      }
    }
    if (javascriptFiles.length > 0 && externalScriptCount !== 1) {
      fail(`built page must reference exactly one reviewed executable asset: ${pagePath}`);
    }
  }

  const manifest = outputManifest(outputRoot, files);
  return Object.freeze({
    files: files.length,
    pages: EXPECTED_HTML_FILES.length,
    bytes: totalBytes,
    sha256: manifest.sha256,
    manifest: manifest.files,
  });
}

export function buildDocsSite({
  source = DEFAULT_SOURCE,
  config = DEFAULT_CONFIG,
  output = DEFAULT_OUTPUT,
  packageManifest = DEFAULT_PACKAGE_MANIFEST,
  environment = process.env,
  pythonExecutable = DEFAULT_PYTHON,
} = {}) {
  const outputRoot = resolve(output);
  assertSeparateTrees(source, outputRoot, "output directory");
  const temporary = mkdtempSync(join(tmpdir(), "open-rfc-mkdocs-"));
  try {
    prepareDocsSite({
      source,
      config,
      staging: temporary,
      packageManifest,
      environment,
    });
    rmSync(outputRoot, { recursive: true, force: true });
    const execution = spawnSync(
      resolveDocsPythonExecutable(pythonExecutable),
      [
        "-m", "mkdocs", "build", "--clean", "--strict",
        "--config-file", join(temporary, "mkdocs.yml"),
        "--site-dir", outputRoot,
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        env: docsBuildEnvironment(environment, {
          platform: process.platform,
          temporaryHome: temporary,
        }),
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (execution.error !== undefined) {
      fail(`MkDocs could not start: ${execution.error.message}`);
    }
    if (execution.status !== 0) {
      const diagnostic = `${execution.stdout ?? ""}${execution.stderr ?? ""}`.trim();
      fail(`MkDocs build failed${diagnostic.length === 0 ? "" : `: ${diagnostic.slice(-4000)}`}`);
    }
    // Material's generic 404 page uses site-root URLs, which are incorrect for
    // a repository-scoped GitHub Pages deployment without a fixed site_url.
    rmSync(join(outputRoot, "404.html"), { force: true });
    return verifyBuiltSite({ output: outputRoot, environment });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function checkDocsSite(options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "open-rfc-mkdocs-check-"));
  try {
    const first = buildDocsSite({ ...options, output: join(temporary, "first") });
    const second = buildDocsSite({ ...options, output: join(temporary, "second") });
    if (
      first.sha256 !== second.sha256 ||
      JSON.stringify(first.manifest) !== JSON.stringify(second.manifest)
    ) {
      fail("two clean MkDocs builds produced different bytes");
    }
    return Object.freeze({
      files: first.files,
      pages: first.pages,
      bytes: first.bytes,
      sha256: first.sha256,
      deterministic: true,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Build the public site from the package manifest inside one already verified
 * candidate tarball. Verification is repeated after both clean builds so a
 * concurrently replaced candidate directory cannot be admitted.
 */
export async function checkCandidateDocsSite({
  candidateDirectory,
  commit,
  publicationMode = "private",
  repositoryRoot = ROOT,
  environment = process.env,
  pythonExecutable = DEFAULT_PYTHON,
} = {}) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
    fail("candidate documentation commit must be an explicit full SHA-1");
  }
  if (
    typeof candidateDirectory !== "string" ||
    candidateDirectory.length === 0 ||
    candidateDirectory.includes("\0")
  ) fail("candidate directory must be a non-empty path");
  const candidateRoot = resolve(candidateDirectory);
  const verifiedBefore = await verifyCandidateBundle(candidateRoot, repositoryRoot, {
    commit,
    publicationMode,
  });
  const candidateSources = readCandidateDocumentationSources(
    repositoryRoot,
    verifiedBefore.commit,
  );
  const tarballPath = join(candidateRoot, verifiedBefore.filename);
  const tarballBytes = regularBytes(
    tarballPath,
    "candidate connector tarball",
    CONNECTOR_ARCHIVE_ENVELOPE.tarballBytes,
  );
  if (sha256(tarballBytes) !== verifiedBefore.sha256) {
    fail("candidate connector tarball changed after verification");
  }
  let archive;
  try {
    archive = parseCanonicalNpmTarball(tarballBytes, CONNECTOR_ARCHIVE_ENVELOPE);
  } catch (error) {
    fail(`candidate connector archive is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifestEntry = archive.entries.find(({ path }) => path === "package/package.json");
  if (manifestEntry === undefined) fail("candidate connector archive lacks package/package.json");

  const temporary = mkdtempSync(join(tmpdir(), "open-rfc-candidate-docs-"));
  try {
    const manifestPath = join(temporary, "package.json");
    const sourcePath = join(temporary, "candidate-inputs", "docs_page");
    const configPath = join(temporary, "candidate-inputs", "mkdocs.yml");
    const requirementsPath = join(temporary, "candidate-inputs", "requirements-docs.txt");
    writeFileSync(manifestPath, manifestEntry.bytes, { flag: "wx", mode: 0o600 });
    mkdirSync(sourcePath, { recursive: true });
    for (const entry of candidateSources.documentation) {
      const destination = join(sourcePath, entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, entry.bytes, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(configPath, candidateSources.config.bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(
      requirementsPath,
      candidateSources.requirements.bytes,
      { flag: "wx", mode: 0o600 },
    );
    if (
      sha256(regularBytes(configPath, "candidate MkDocs configuration")) !==
        candidateSources.source.configurationSha256 ||
      sha256(regularBytes(requirementsPath, "candidate documentation requirements")) !==
        candidateSources.source.requirementsSha256
    ) fail("materialized candidate documentation input changed");
    const site = checkDocsSite({
      source: sourcePath,
      config: configPath,
      packageManifest: manifestPath,
      environment,
      pythonExecutable,
    });
    const facts = publicPackageFacts(manifestPath, publicationEnvironmentSecrets(environment));
    if (facts.packageVersion !== verifiedBefore.package.version) {
      fail("candidate documentation version differs from the verified artifact");
    }
    const verifiedAfter = await verifyCandidateBundle(candidateRoot, repositoryRoot, {
      commit,
      publicationMode,
    });
    for (const key of ["commit", "filename", "sha256", "releaseSetSha256"]) {
      if (verifiedAfter[key] !== verifiedBefore[key]) {
        fail("candidate identity changed while building documentation");
      }
    }
    return Object.freeze({
      ...site,
      packageVersion: facts.packageVersion,
      nodeEngine: facts.nodeEngine,
      candidate: Object.freeze({
        commit: verifiedBefore.commit,
        filename: verifiedBefore.filename,
        sha256: verifiedBefore.sha256,
        releaseSetSha256: verifiedBefore.releaseSetSha256,
      }),
      source: candidateSources.source,
      packageManifestFromArtifact: true,
      candidateVerifiedBeforeAfter: true,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseCli(arguments_) {
  if (arguments_.length === 0) {
    return Object.freeze({ check: false, candidateDirectory: null, commit: null });
  }
  const options = {
    check: false,
    candidateDirectory: null,
    commit: null,
    publicationMode: "private",
  };
  const remaining = [...arguments_];
  while (remaining.length > 0) {
    const option = remaining.shift();
    if (option === "--check" && options.check === false) {
      options.check = true;
      continue;
    }
    if (option === "--candidate-directory" && options.candidateDirectory === null) {
      options.candidateDirectory = remaining.shift();
      if (options.candidateDirectory === undefined) fail("missing candidate directory");
      continue;
    }
    if (option === "--publication-mode" && options.publicationMode === "private") {
      options.publicationMode = remaining.shift();
      if (options.publicationMode === undefined) fail("missing publication mode");
      continue;
    }
    if (option === "--commit" && options.commit === null) {
      options.commit = remaining.shift();
      if (options.commit === undefined) fail("missing candidate commit");
      continue;
    }
    fail(
      "usage: node tools/docs_site.mjs [--check] [--candidate-directory DIR " +
      "--commit FULL_SHA1] [--publication-mode MODE]",
    );
  }
  if (options.candidateDirectory !== null && options.check !== true) {
    fail("candidate documentation requires --check");
  }
  if (options.candidateDirectory !== null && !/^[0-9a-f]{40}$/u.test(options.commit ?? "")) {
    fail("candidate documentation requires --commit with an explicit full SHA-1");
  }
  if (options.candidateDirectory === null && options.commit !== null) {
    fail("--commit requires --candidate-directory");
  }
  return Object.freeze(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { check, candidateDirectory, commit, publicationMode } = parseCli(process.argv.slice(2));
    const result = candidateDirectory === null
      ? (check ? checkDocsSite() : buildDocsSite())
      : await checkCandidateDocsSite({ candidateDirectory, commit, publicationMode });
    const { manifest: _manifest, ...summary } = result;
    if (summary.source?.requirements !== undefined) {
      const { requirements: _requirements, ...source } = summary.source;
      summary.source = source;
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
