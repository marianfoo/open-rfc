import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractDocumentationExamples } from "../tools/documentation_examples.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = Object.freeze([
  "examples/standalone/hello-world.mjs",
  "examples/standalone/hello-world.cjs",
]);
const MISSING_CONFIGURATION =
  "Missing required SAP connection environment variables: " +
  "SAP_ASHOST, SAP_CLIENT, SAP_USER, SAP_PASSWD\n";

function sanitizedEnvironment() {
  return {
    LANG: "C",
    LC_ALL: "C",
    NO_PROXY: "*",
    no_proxy: "*",
  };
}

function runExample(relativePath, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relativePath], {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: options.env ?? sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ signal, status, stderr, stdout });
    });
  });
}

test("the README leads with a simple install and discovers both runnable examples", () => {
  const readme = readFileSync(join(PROJECT_ROOT, "README.md"), "utf8");
  const quickInstall = readme.indexOf("npm install open-rfc");
  const artifactVerification = readme.indexOf("## Verify an artifact");

  assert.notEqual(quickInstall, -1);
  assert.ok(quickInstall < artifactVerification);
  for (const relativePath of EXAMPLES) assert.match(readme, new RegExp(relativePath));
});

test("the complete documentation examples match the runnable source files", () => {
  const sourcePath = "docs_page/standalone.md";
  const documentation = readFileSync(join(PROJECT_ROOT, sourcePath), "utf8");
  const extracted = new Map(
    extractDocumentationExamples(documentation, sourcePath).map((example) => [
      example.id,
      example.source,
    ]),
  );
  const bindings = [
    ["pages-standalone-stfc-connection", EXAMPLES[0]],
    ["pages-standalone-commonjs", EXAMPLES[1]],
  ];

  for (const [id, relativePath] of bindings) {
    const source = readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(
      /\n$/u,
      "",
    );
    assert.equal(extracted.get(id), source);
  }
});

test("the README closes an opened client after the call faults it", async () => {
  const sourcePath = "README.md";
  const documentation = readFileSync(join(PROJECT_ROOT, sourcePath), "utf8");
  const example = extractDocumentationExamples(documentation, sourcePath).find(
    ({ id }) => id === "readme-quick-start",
  );
  assert.ok(example);

  const temporary = mkdtempSync(join(tmpdir(), "open-rfc-readme-cleanup-"));
  const packageRoot = join(temporary, "node_modules", "open-rfc");
  const marker = join(temporary, "closed.txt");
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ exports: "./index.mjs", type: "module" }),
    );
    writeFileSync(
      join(packageRoot, "index.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export class Client {",
        "  alive = false;",
        "  async open() { this.alive = true; }",
        "  async call() { this.alive = false; throw new Error(\"synthetic fault\"); }",
        "  async close() { writeFileSync(process.env.OPEN_RFC_CLOSE_MARKER, \"closed\\n\"); }",
        "}",
        "",
      ].join("\n"),
    );
    const script = join(temporary, "rfc-smoke.mjs");
    writeFileSync(script, `${example.source}\n`);

    const result = await runExample(script, {
      cwd: temporary,
      env: {
        ...sanitizedEnvironment(),
        OPEN_RFC_CLOSE_MARKER: marker,
        SAP_ASHOST: "example.invalid",
        SAP_CLIENT: "001",
        SAP_PASSWD: "synthetic",
        SAP_USER: "synthetic",
      },
    });

    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "RFC call failed; consult private, redacted diagnostics.\n",
    );
    assert.equal(readFileSync(marker, "utf8"), "closed\n");
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});

for (const relativePath of EXAMPLES) {
  test(`${relativePath} is complete and fails safely without configuration`, async () => {
    const source = readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
    assert.match(source, /\bClient\b/u);
    assert.match(source, /client\.open\(\)/u);
    assert.match(source, /client\.call\("STFC_CONNECTION"/u);
    assert.match(source, /client\.close\(\)/u);

    const result = await runExample(relativePath);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, MISSING_CONFIGURATION);
  });
}
