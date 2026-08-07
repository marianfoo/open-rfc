import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLEANER_PATH = join(PROJECT_ROOT, "tools", "clean_build_output.mjs");
const CJS_MANIFEST_PATH = join(PROJECT_ROOT, "tools", "materialize_cjs_manifest.mjs");
const PACKAGE_MODE_NORMALIZER_PATH = join(
  PROJECT_ROOT,
  "tools",
  "normalize_package_modes.mjs",
);

function writeFixtureFile(path, content = "fixture\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFixture(t, manifest = { name: "open-rfc", type: "module" }) {
  const sandbox = mkdtempSync(join(tmpdir(), "open-rfc-build-clean-"));
  const root = join(sandbox, "repo");
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
  copyFileSync(CLEANER_PATH, join(root, "tools", "clean_build_output.mjs"));
  copyFileSync(CJS_MANIFEST_PATH, join(root, "tools", "materialize_cjs_manifest.mjs"));
  if (existsSync(PACKAGE_MODE_NORMALIZER_PATH)) {
    copyFileSync(
      PACKAGE_MODE_NORMALIZER_PATH,
      join(root, "tools", "normalize_package_modes.mjs"),
    );
  }
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return { root, sandbox };
}

function runCjsManifest(root, args = []) {
  return spawnSync(
    process.execPath,
    [join(root, "tools", "materialize_cjs_manifest.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function runPackageModeNormalizer(root, args = []) {
  return spawnSync(
    process.execPath,
    [join(root, "tools", "normalize_package_modes.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function runCleaner(root, { arguments: args = [], cwd = root } = {}) {
  return spawnSync(
    process.execPath,
    [join(root, "tools", "clean_build_output.mjs"), ...args],
    { cwd, encoding: "utf8" },
  );
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (value) => {
      stdout += String(value);
    });
    child.stderr?.on("data", (value) => {
      stderr += String(value);
    });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function runCleanerAsync(root) {
  return runProcess(
    process.execPath,
    [join(root, "tools", "clean_build_output.mjs")],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("normal build and prepack prune orphan output before either compiler", () => {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  const esmConfig = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "tsconfig.json"), "utf8"),
  );
  const cjsConfig = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "tsconfig.cjs.json"), "utf8"),
  );
  const build = manifest.scripts?.build;
  const cleaner = "node tools/clean_build_output.mjs";

  assert.equal(typeof build, "string");
  assert.equal(build.startsWith(`${cleaner} && `), true);
  assert.ok(build.indexOf(cleaner) < build.indexOf("tsc -p tsconfig.json"));
  assert.ok(build.indexOf(cleaner) < build.indexOf("tsc -p tsconfig.cjs.json"));
  assert.match(
    build,
    /node tools\/materialize_cjs_manifest\.mjs && node tools\/normalize_package_modes\.mjs$/u,
  );
  assert.equal(manifest.scripts?.prepack, "npm run build");
  assert.equal(esmConfig.compilerOptions?.declaration, true);
  assert.notEqual(esmConfig.compilerOptions?.sourceMap, true);
  assert.notEqual(esmConfig.compilerOptions?.declarationMap, true);
  assert.equal(cjsConfig.compilerOptions?.declaration, true);
  assert.notEqual(cjsConfig.compilerOptions?.sourceMap, true);
  assert.notEqual(cjsConfig.compilerOptions?.declarationMap, true);
});

test("package mode normalization covers the complete npm surface", (t) => {
  const { root } = createFixture(t);
  const files = [
    "README.md",
    "package.json",
    "LICENSE",
    "NOTICE.txt",
    "THIRD_PARTY_NOTICES.md",
    "dist/src/index.js",
    "dist/src/nested/index.d.ts",
    "dist/cjs/index.js",
    "dist/cjs/package.json",
  ];
  for (const path of files) {
    writeFixtureFile(join(root, path));
    chmodSync(join(root, path), 0o600);
  }
  for (const path of ["dist", "dist/src", "dist/src/nested", "dist/cjs"]) {
    chmodSync(join(root, path), 0o700);
  }

  const result = runPackageModeNormalizer(root);

  assert.equal(result.status, 0, result.stderr);
  for (const path of files) {
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o644, path);
  }
  for (const path of ["dist/src", "dist/src/nested", "dist/cjs"]) {
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o755, path);
  }
});

test("package mode normalization rejects arguments and symlinks", (t) => {
  const argumentFixture = createFixture(t);
  for (const path of ["README.md", "dist/src/index.js", "dist/cjs/index.js"]) {
    writeFixtureFile(join(argumentFixture.root, path));
  }
  const argumentResult = runPackageModeNormalizer(argumentFixture.root, ["--root", "/tmp"]);
  assert.notEqual(argumentResult.status, 0);
  assert.match(argumentResult.stderr, /does not accept arguments/u);

  const symlinkFixture = createFixture(t);
  const target = join(symlinkFixture.sandbox, "user-owned.js");
  writeFixtureFile(join(symlinkFixture.root, "README.md"));
  writeFixtureFile(join(symlinkFixture.root, "dist", "cjs", "index.js"));
  writeFixtureFile(target, "keep\n");
  mkdirSync(join(symlinkFixture.root, "dist", "src"), { recursive: true });
  symlinkSync(target, join(symlinkFixture.root, "dist", "src", "index.js"));

  const symlinkResult = runPackageModeNormalizer(symlinkFixture.root);

  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /symbolic link/u);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
});

test("CommonJS manifest materialization replaces stale modes deterministically", (t) => {
  const { root } = createFixture(t);
  const source = join(root, "cjs-package.json");
  const destination = join(root, "dist", "cjs", "package.json");
  writeFixtureFile(source, '{"type":"commonjs"}\n');
  writeFixtureFile(destination, '{"type":"stale"}\n');
  chmodSync(destination, 0o600);

  const result = runCjsManifest(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(destination, "utf8"), '{"type":"commonjs"}\n');
  assert.equal(lstatSync(destination).mode & 0o777, 0o644);
});

test("CommonJS manifest materialization rejects arguments and symlink output", (t) => {
  const argumentFixture = createFixture(t);
  writeFixtureFile(join(argumentFixture.root, "cjs-package.json"), '{"type":"commonjs"}\n');
  mkdirSync(join(argumentFixture.root, "dist", "cjs"), { recursive: true });
  const argumentResult = runCjsManifest(argumentFixture.root, ["--root", "/tmp"]);
  assert.notEqual(argumentResult.status, 0);
  assert.match(argumentResult.stderr, /does not accept arguments/u);

  const symlinkFixture = createFixture(t);
  const target = join(symlinkFixture.sandbox, "user-owned.json");
  writeFixtureFile(join(symlinkFixture.root, "cjs-package.json"), '{"type":"commonjs"}\n');
  writeFixtureFile(target, "keep\n");
  mkdirSync(join(symlinkFixture.root, "dist", "cjs"), { recursive: true });
  symlinkSync(target, join(symlinkFixture.root, "dist", "cjs", "package.json"));

  const symlinkResult = runCjsManifest(symlinkFixture.root);

  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /not a regular file/u);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
});

test("pruner removes only source-less generated files and preserves current modules", (t) => {
  const { root, sandbox } = createFixture(t);
  const nestedCwd = join(root, "work", "nested");
  const current = [
    ["src/index.ts", "export const current = true;\n"],
    ["test/sample.test.ts", "export {};\n"],
    ["dist/src/index.js", "export const current = true;\n"],
    ["dist/src/index.d.ts", "export declare const current = true;\n"],
    ["dist/test/sample.test.js", "export {};\n"],
    ["dist/test/sample.test.d.ts", "export {};\n"],
    ["dist/cjs/index.js", "exports.current = true;\n"],
    ["dist/cjs/index.d.ts", "export declare const current = true;\n"],
    ["dist/cjs/package.json", '{"type":"commonjs"}\n'],
  ];
  const stale = [
    "dist/src/uint8-array.js",
    "dist/src/uint8-array.d.ts",
    "dist/test/removed.test.js",
    "dist/cjs/removed.js",
  ];
  const protectedPaths = [
    join(root, "nwrfcsdk", "native.bin"),
    join(root, "sdk-reference", "oracle.bin"),
    join(root, "captures", "raw.bin"),
    join(root, ".captures", "raw.bin"),
    join(root, ".open-rfc-evidence", "run.json"),
    join(root, "upstream", "private.txt"),
    join(nestedCwd, "dist", "keep.txt"),
    join(sandbox, "user-owned", "dist", "keep.txt"),
  ];
  for (const [path, bytes] of current) writeFixtureFile(join(root, path), bytes);
  for (const path of stale) writeFixtureFile(join(root, path));
  for (const path of protectedPaths) writeFixtureFile(path);

  const result = runCleaner(root, { cwd: nestedCwd });

  assert.equal(result.status, 0, result.stderr);
  for (const [path, bytes] of current) {
    assert.equal(readFileSync(join(root, path), "utf8"), bytes);
  }
  for (const path of stale) assert.equal(existsSync(join(root, path)), false);
  for (const path of protectedPaths) assert.equal(existsSync(path), true);
});

test("pruner removes config-stale generated variants while their sources still exist", (t) => {
  const { root } = createFixture(t);
  const current = [
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/test/sample.test.js",
    "dist/test/sample.test.d.ts",
    "dist/cjs/index.js",
    "dist/cjs/index.d.ts",
    "dist/cjs/package.json",
  ];
  const configStale = [
    "dist/src/index.js.map",
    "dist/src/index.d.ts.map",
    "dist/test/sample.test.js.map",
    "dist/test/sample.test.d.ts.map",
    "dist/cjs/index.js.map",
    "dist/cjs/index.d.ts.map",
  ];
  writeFixtureFile(join(root, "src", "index.ts"), "export const current = true;\n");
  writeFixtureFile(join(root, "test", "sample.test.ts"), "export {};\n");
  for (const path of current) writeFixtureFile(join(root, path));
  for (const path of configStale) writeFixtureFile(join(root, path));

  const result = runCleaner(root);

  assert.equal(result.status, 0, result.stderr);
  for (const path of current) assert.equal(existsSync(join(root, path)), true);
  for (const path of configStale) assert.equal(existsSync(join(root, path)), false);
});

test("pruner rejects arguments and invalid repository identity without mutation", (t) => {
  const valid = createFixture(t);
  const source = join(valid.root, "src", "index.ts");
  const output = join(valid.root, "dist", "src", "index.js");
  writeFixtureFile(source, "export {};\n");
  writeFixtureFile(output, "export {};\n");
  const argumentResult = runCleaner(valid.root, {
    arguments: ["--root", join(valid.sandbox, "user-owned")],
  });
  assert.notEqual(argumentResult.status, 0);
  assert.match(argumentResult.stderr, /does not accept arguments/u);
  assert.equal(existsSync(output), true);

  const invalid = createFixture(t, { name: "not-open-rfc", type: "module" });
  const invalidOutput = join(invalid.root, "dist", "src", "removed.js");
  writeFixtureFile(invalidOutput);
  const identityResult = runCleaner(invalid.root);
  assert.notEqual(identityResult.status, 0);
  assert.match(identityResult.stderr, /repository identity/u);
  assert.equal(existsSync(invalidOutput), true);
});

test("pruner preserves and rejects a root dist symlink or regular file", async (t) => {
  await t.test("symlink", () => {
    const { root, sandbox } = createFixture(t);
    const targetSentinel = join(sandbox, "user-owned", "dist", "keep.txt");
    writeFixtureFile(targetSentinel);
    symlinkSync(dirname(targetSentinel), join(root, "dist"), "dir");
    const result = runCleaner(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a real directory/u);
    assert.equal(lstatSync(join(root, "dist")).isSymbolicLink(), true);
    assert.equal(existsSync(targetSentinel), true);
  });
  await t.test("regular file", () => {
    const { root } = createFixture(t);
    const output = join(root, "dist");
    writeFixtureFile(output, "user-owned collision\n");
    const result = runCleaner(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a real directory/u);
    assert.equal(readFileSync(output, "utf8"), "user-owned collision\n");
  });
});

test("pruner fails closed on nested symlinks and unknown output files", async (t) => {
  await t.test("nested symlink", () => {
    const { root, sandbox } = createFixture(t);
    const target = join(sandbox, "user-owned", "keep.js");
    writeFixtureFile(target, "keep\n");
    mkdirSync(join(root, "dist", "src"), { recursive: true });
    symlinkSync(target, join(root, "dist", "src", "linked.js"));
    const result = runCleaner(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/u);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
  });
  await t.test("unknown file", () => {
    const { root } = createFixture(t);
    const unknown = join(root, "dist", "src", "notes.txt");
    writeFixtureFile(unknown, "user-owned\n");
    const result = runCleaner(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /non-generated/u);
    assert.equal(readFileSync(unknown, "utf8"), "user-owned\n");
  });
});

test("parallel prebuild pruning never removes a currently importable module", async (t) => {
  const { root } = createFixture(t);
  writeFixtureFile(join(root, "src", "index.ts"), "export const current = true;\n");
  writeFixtureFile(join(root, "dist", "src", "index.js"), "export const current = true;\n");
  writeFixtureFile(join(root, "dist", "src", "removed.js"), "export {};\n");
  const modulePath = join(root, "dist", "src", "index.js");
  const watcher = runProcess(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { pathToFileURL } from 'node:url'; " +
        "for (let i = 0; i < 80; i += 1) { " +
        "const m = await import(pathToFileURL(process.argv[1]).href + '?run=' + i); " +
        "if (m.current !== true) process.exit(2); " +
        "await new Promise((r) => setTimeout(r, 1)); }",
      modulePath,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const cleaners = Promise.all(Array.from({ length: 8 }, () => runCleanerAsync(root)));
  const [watcherResult, cleanerResults] = await Promise.all([watcher, cleaners]);
  assert.equal(watcherResult.status, 0, watcherResult.stderr);
  for (const result of cleanerResults) assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(modulePath, "utf8"), "export const current = true;\n");
  assert.equal(existsSync(join(root, "dist", "src", "removed.js")), false);
});
