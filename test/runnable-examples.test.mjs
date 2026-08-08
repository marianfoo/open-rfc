import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

function runExample(relativePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relativePath], {
      cwd: PROJECT_ROOT,
      env: sanitizedEnvironment(),
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
