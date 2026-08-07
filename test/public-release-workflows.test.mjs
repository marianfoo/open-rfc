import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseDocument } from "yaml";

const execFileAsync = promisify(execFile);

function workflow(name) {
  const source = readFileSync(
    new URL(`../release/templates/${name}`, import.meta.url),
    "utf8",
  );
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: false,
    uniqueKeys: true,
  });
  assert.deepEqual(document.errors, [], `${name} YAML errors`);
  assert.deepEqual(document.warnings, [], `${name} YAML warnings`);
  return { source, value: document.toJS() };
}

const ci = workflow("ci.yml");
const candidate = workflow("candidate.yml");
const pages = workflow("pages.yml");
const publish = workflow("npm-publish.yml");
const releasePlease = workflow("release-please.yml");

test("public CI is one Linux job with public-safe checks and one Node 24 smoke", () => {
  assert.deepEqual(Object.keys(ci.value.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(Object.keys(ci.value.jobs), ["result"]);
  assert.equal(ci.value.jobs.result["runs-on"], "ubuntu-24.04");
  assert.equal(ci.value.jobs.result.strategy, undefined);
  assert.doesNotMatch(ci.source, /(?:macos|windows)-|\bmatrix\b/iu);
  assert.match(ci.source, /node-version: 22\.14\.0/u);
  assert.match(ci.source, /node-version: 24\b/u);
  assert.match(ci.source, /node tools\/ci_change_scope\.mjs/u);
  const scope = ci.value.jobs.result.steps.find((step) => step.id === "scope");
  assert.equal(scope?.run, "node tools/ci_change_scope.mjs");
  const product = ci.value.jobs.result.steps.find(
    (step) => step.name === "Verify the public product",
  );
  assert.equal(product?.if, "steps.scope.outputs.product == 'true'");
  const documentation = ci.value.jobs.result.steps.find(
    (step) => step.name === "Verify public documentation",
  );
  assert.equal(documentation?.if, undefined);
  const node24 = ci.value.jobs.result.steps.find(
    (step) => step.name === "Smoke-build on Node.js 24",
  );
  assert.equal(node24?.if, "steps.scope.outputs.product == 'true'");
  for (const command of [
    "npm run test:public",
    "npm run lint",
    "npm run package:shape -- --publication-mode public-license-preflight",
    "npm run check:docs:public",
    "npm run docs:site:check",
    "npm audit --omit=dev --audit-level=high",
  ]) assert.match(ci.source, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(
    ci.source,
    /publication:guard|publication:scrub|status:check|live\.yml/iu,
  );
});

test("public candidate binds one exact stable public tarball across Node 22 and 24", () => {
  assert.deepEqual(Object.keys(candidate.value.on), ["workflow_dispatch"]);
  assert.equal(candidate.value.on.workflow_dispatch.inputs.candidate_kind.required, true);
  assert.equal(candidate.value.on.workflow_dispatch.inputs.candidate_kind.type, "choice");
  assert.deepEqual(candidate.value.on.workflow_dispatch.inputs.candidate_kind.options, [
    "initial-bootstrap",
    "release-please",
  ]);
  assert.equal(candidate.value.on.workflow_dispatch.inputs.candidate_sha.required, true);
  assert.equal(
    candidate.value["run-name"],
    "Candidate ${{ inputs.candidate_kind }} ${{ inputs.candidate_sha }}",
  );
  assert.deepEqual(Object.keys(candidate.value.jobs), ["candidate"]);
  assert.equal(candidate.value.jobs.candidate["runs-on"], "ubuntu-24.04");
  assert.doesNotMatch(candidate.source, /event\.repository\.visibility/u);
  assert.match(candidate.source, /github\.repository == 'marianfoo\/open-rfc'/u);
  assert.match(candidate.source, /git ls-remote origin refs\/heads\/main/u);
  assert.match(candidate.source, /git rev-list --count HEAD/u);
  assert.match(candidate.source, /approved author and committer identity/u);
  assert.match(
    candidate.source,
    /Signed-off-by: marianfoo <13335743\+marianfoo@users\.noreply\.github\.com>/u,
  );
  assert.match(candidate.source, /bootstrap import is unsigned because it is pushed before any pull/u);
  assert.match(candidate.source, /Signature verification applies to GitHub-created merge/u);
  assert.doesNotMatch(candidate.source, /git cat-file commit HEAD|commit\.verification|\^gpgsig /u);
  assert.match(candidate.source, /const version = "0\.2\.0"/u);
  assert.match(candidate.source, /releaseManifest\["\."\] !== version/u);
  assert.match(candidate.source, /OPEN_RFC_PACKAGE_VERSION/u);
  assert.match(candidate.source, /changelogHeading\.test\(changelog\)/u);
  assert.match(candidate.source, /git ls-remote --tags origin/u);
  assert.match(candidate.source, /releases\?per_page=1/u);
  assert.match(
    candidate.source,
    /node tools\/release_artifact_gate\.mjs \\\n\s+"\$\{\{ runner\.temp \}\}\/open-rfc-release\/open-rfc-candidate" \\\n\s+--publication-mode public-license-preflight \\\n\s+--commit "\$\{\{ inputs\.candidate_sha \}\}"/u,
  );
  assert.match(
    candidate.source,
    /node tools\/verify_candidate_bundle\.mjs \\\n\s+"\$\{\{ runner\.temp \}\}\/open-rfc-release\/open-rfc-candidate" \\\n\s+--publication-mode public-license-preflight \\\n\s+--commit "\$\{\{ inputs\.candidate_sha \}\}"/u,
  );
  assert.equal(
    (candidate.source.match(/node tools\/release_artifact_gate\.mjs/gu) ?? []).length,
    1,
  );
  assert.equal(
    (candidate.source.match(/node tools\/verify_candidate_bundle\.mjs/gu) ?? []).length,
    1,
  );
  assert.equal(
    (candidate.source.match(/--commit "\$\{\{ inputs\.candidate_sha \}\}"/gu) ?? []).length,
    6,
  );
  assert.equal(
    (candidate.source.match(/public_hosted_platform_evidence\.mjs cell/gu) ?? []).length,
    2,
  );
  assert.match(
    candidate.source,
    /public_hosted_platform_evidence\.mjs cell[\s\S]{0,420}--publication-mode public-license-preflight \\\n\s+--commit "\$\{\{ inputs\.candidate_sha \}\}"[\s\S]{0,120}--requested-node 24/u,
  );
  assert.match(
    candidate.source,
    /hosted_documentation_evidence\.mjs \\\n[\s\S]{0,420}--publication-mode public-license-preflight \\\n\s+--commit "\$\{\{ inputs\.candidate_sha \}\}"[\s\S]{0,120}--runner-label ubuntu-24\.04/u,
  );
  assert.match(
    candidate.source,
    /public_hosted_platform_evidence\.mjs cell[\s\S]{0,420}--publication-mode public-license-preflight \\\n\s+--commit "\$\{\{ inputs\.candidate_sha \}\}"[\s\S]{0,120}--requested-node 22/u,
  );
  assert.match(
    candidate.source,
    /public_hosted_platform_evidence\.mjs aggregate[\s\S]{0,520}--publication-mode public-license-preflight \\\n\s+--commit "\$\{\{ inputs\.candidate_sha \}\}"/u,
  );
  assert.doesNotMatch(candidate.source, /node tools\/hosted_platform_evidence\.mjs/u);
  assert.doesNotMatch(candidate.source, /--release-tier|--roadmap-variant/u);
  assert.equal(
    (candidate.source.match(/--publication-mode public-license-preflight/gu) ?? []).length,
    6,
  );
  const platformStep = candidate.value.jobs.candidate.steps.find(
    (step) => step.name === "Verify the same candidate on Node.js 22 and aggregate evidence",
  );
  assert.equal(typeof platformStep?.run, "string");
  assert.match(
    platformStep.run,
    /--cells-directory "\$\{\{ runner\.temp \}\}\/open-rfc-release\/platform-cells"/u,
  );
  assert.match(
    platformStep.run,
    /--output-directory "\$\{\{ runner\.temp \}\}\/open-rfc-release\/platform-cells"/u,
  );
  const platformUpload = candidate.value.jobs.candidate.steps.find(
    (step) => step.with?.name === "open-rfc-linux-node-evidence",
  );
  assert.equal(
    platformUpload?.with?.path,
    "${{ runner.temp }}/open-rfc-release/platform-cells",
  );
  assert.doesNotMatch(candidate.source, /open-rfc-release\/platform-evidence/u);
  assert.match(candidate.source, /name: open-rfc-candidate/u);
  assert.doesNotMatch(candidate.source, /npm publish|SAP_PASSWD|test:live/iu);
});

test("initial bootstrap candidate accepts only an unreleased one-commit 0.2.0 root", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "open-rfc-bootstrap-workflow-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = join(temporary, "repository");
  const remote = join(temporary, "remote.git");
  const bin = join(temporary, "bin");
  await mkdir(repository);
  await mkdir(bin);
  await mkdir(join(repository, "src", "compat"), { recursive: true });
  await writeFile(join(repository, "package.json"), JSON.stringify({
    name: "open-rfc",
    version: "0.2.0",
    private: false,
    license: "Apache-2.0",
  }));
  await writeFile(join(repository, "package-lock.json"), JSON.stringify({
    name: "open-rfc",
    version: "0.2.0",
    lockfileVersion: 3,
    packages: { "": { name: "open-rfc", version: "0.2.0" } },
  }));
  await writeFile(
    join(repository, ".release-please-manifest.json"),
    JSON.stringify({ ".": "0.2.0" }),
  );
  await writeFile(
    join(repository, "src", "compat", "node-rfc-client.ts"),
    'const OPEN_RFC_PACKAGE_VERSION = "0.2.0"; // x-release-please-version\n',
  );
  await writeFile(
    join(repository, "CHANGELOG.md"),
    "# Changelog\n\n## [0.2.0] - 2026-07-30\n\n- Initial public beta.\n",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "marianfoo"],
    ["config", "user.email", "13335743+marianfoo@users.noreply.github.com"],
    ["add", "."],
    ["commit", "-s", "-m", "chore: publish initial sanitized beta"],
  ]) await execFileAsync("git", args, { cwd: repository });
  const commitObject = await execFileAsync("git", ["cat-file", "commit", "HEAD"], {
    cwd: repository,
  });
  assert.doesNotMatch(commitObject.stdout, /^gpgsig /mu);
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repository });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repository });

  const fakeGh = join(bin, "gh");
  await writeFile(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${GH_RELEASES:-[]}"
`);
  await chmod(fakeGh, 0o700);
  const lineage = candidate.value.jobs.candidate.steps.find(
    (step) => step.name === "Verify the selected candidate lineage",
  );
  assert.equal(typeof lineage?.run, "string");
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CANDIDATE_KIND: "initial-bootstrap",
    GH_RELEASES: "[]",
    GITHUB_REPOSITORY: "marianfoo/open-rfc",
  };
  await execFileAsync("bash", ["-c", lineage.run], {
    cwd: repository,
    env: environment,
    timeout: 30_000,
  });

  await execFileAsync("git", ["tag", "v0.2.0"], { cwd: repository });
  await execFileAsync("git", ["push", "origin", "v0.2.0"], { cwd: repository });
  await assert.rejects(
    execFileAsync("bash", ["-c", lineage.run], {
      cwd: repository,
      env: environment,
      timeout: 30_000,
    }),
    /must not contain any tags/u,
  );
});

test("public Pages deploys only deterministic public documentation", () => {
  assert.deepEqual(Object.keys(pages.value.jobs), ["build", "deploy"]);
  assert.equal(pages.value.jobs.build["runs-on"], "ubuntu-24.04");
  assert.equal(pages.value.jobs.deploy.environment.name, "github-pages");
  assert.match(pages.source, /npm run check:docs:public/u);
  assert.match(pages.source, /node tools\/docs_site\.mjs --check/u);
  assert.doesNotMatch(
    pages.source,
    /publication:guard|publication:scrub|status:check|npm publish/iu,
  );
});

test("trusted publishing builds the tag, publishes it, and re-checks the registry", () => {
  assert.deepEqual(Object.keys(publish.value.on), ["release"]);
  assert.equal(publish.value.jobs.publish.environment, "npm");
  assert.equal(publish.value.jobs.publish["runs-on"], "ubuntu-24.04");
  assert.deepEqual(publish.value.permissions, {
    contents: "read",
    "id-token": "write",
  });
  // The tarball is built from the tag rather than downloaded from the release,
  // so a release created by Release Please carries no assets and still
  // publishes. What the release must still prove is that the tag names one
  // commit, that the checkout is that commit, and that the tag names the
  // version in the manifest.
  assert.match(
    publish.source,
    /\^v0\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/u,
  );
  assert.match(
    publish.source,
    /git fetch --force --no-tags origin "\+\$\{tag_ref\}:\$\{tag_ref\}"/u,
  );
  assert.match(publish.source, /git cat-file -t "\$tag_ref"/u);
  assert.match(
    publish.source,
    /CANDIDATE_SHA="\$\(git rev-parse --verify "\$tag_ref"\)"/u,
  );
  assert.match(
    publish.source,
    /git rev-parse --verify HEAD\)" != "\$CANDIDATE_SHA"/u,
  );
  assert.match(publish.source, /RELEASE_TAG" != "v\$\{version\}"/u);
  assert.match(publish.source, /npm pack --ignore-scripts --pack-destination/u);
  // The release assets are no longer the source of the published bytes, so the
  // download and the bundle verifier must both be gone rather than merely
  // unused. A leftover call would verify a bundle nothing produced.
  assert.doesNotMatch(publish.source, /gh release download/u);
  assert.doesNotMatch(publish.source, /verify_candidate_bundle\.mjs/u);
  assert.match(
    publish.source,
    /npm publish "\$ARTIFACT" --access public --dry-run --ignore-scripts/u,
  );
  assert.match(
    publish.source,
    /npm publish "\$ARTIFACT" --access public --ignore-scripts --provenance/u,
  );
  // Publishing is not the last word: the registry is re-read and the tarball it
  // serves is compared byte for byte against the one that was published.
  assert.match(publish.source, /npm pack "open-rfc@\$\{version\}"/u);
  assert.match(publish.source, /The registry tarball differs from the verified release asset/u);
  assert.doesNotMatch(publish.source, /npm publish --access|npm dist-tag|--tag\b|NPM_TOKEN/iu);
});

test("release creation reverifies the public-mode candidate bundle", () => {
  assert.equal(
    releasePlease.value.on.workflow_dispatch.inputs.candidate_kind.type,
    "choice",
  );
  assert.deepEqual(
    releasePlease.value.on.workflow_dispatch.inputs.candidate_kind.options,
    ["initial-bootstrap", "release-please"],
  );
  assert.match(
    releasePlease.value.jobs["prepare-release-pr"].if,
    /vars\.OPEN_RFC_RELEASE_PLEASE_ENABLED == 'true'/u,
  );
  assert.match(
    releasePlease.source,
    /git fetch --force --no-tags origin[\s\S]{0,100}"\+\$\{tag_ref\}:\$\{tag_ref\}"/u,
  );
  assert.match(
    releasePlease.source,
    /verify_candidate_bundle\.mjs "\$artifact_directory"[\s\S]{0,220}--commit "\$CANDIDATE_SHA"[\s\S]{0,100}--post-release-tag "\$expected_tag"/u,
  );
  assert.match(
    releasePlease.source,
    /git show-ref --verify --quiet "refs\/tags\/\$\{expected_tag\}"[\s\S]{0,320}verify_candidate_bundle\.mjs "\$artifact_directory"[\s\S]{0,220}--commit "\$CANDIDATE_SHA"/u,
  );
  assert.equal(
    releasePlease.value.on.workflow_dispatch.inputs.recover_existing_draft.type,
    "boolean",
  );
  assert.equal(releasePlease.value.concurrency.group, "release-please-main");
  assert.match(releasePlease.source, /unique merged candidate Release Please PR/u);
  assert.match(releasePlease.source, /unique merged pending Release Please PR/u);
  assert.match(releasePlease.source, /initial bootstrap candidate must be the only commit/iu);
  assert.match(releasePlease.source, /manifest\.version !== "0\.2\.0"/u);
  assert.match(releasePlease.source, /OPEN_RFC_PACKAGE_VERSION/u);
  assert.match(releasePlease.source, /changelogHeading\.test\(changelog\)/u);
  assert.match(releasePlease.source, /Initial bootstrap repository already contains a tag/u);
  assert.match(releasePlease.source, /Initial bootstrap repository already contains a GitHub Release/u);
  assert.match(releasePlease.source, /must expose only the exact main branch/u);
  assert.match(releasePlease.source, /Candidate \$\{CANDIDATE_KIND\} \$\{CANDIDATE_SHA\}/u);
  assert.match(releasePlease.source, /\.display_title == \$title/u);
  assert.match(releasePlease.source, /Draft recovery requires the exact candidate tag/u);
  assert.match(releasePlease.source, /Recovery requires the exact candidate tag created by the first attempt/u);
  assert.equal(
    (releasePlease.source.match(/googleapis\/release-please-action@/gu) ?? []).length,
    1,
  );
  assert.doesNotMatch(releasePlease.source, /skip-github-pull-request/u);
  assert.match(
    releasePlease.source,
    /--method POST[\s\S]{0,180}"repos\/\$\{GITHUB_REPOSITORY\}\/git\/refs"/u,
  );
  assert.match(releasePlease.source, /target_commitish: \$sha/u);
  assert.ok(
    releasePlease.source.indexOf('{labels: ["autorelease: tagged"]}')
      < releasePlease.source.indexOf("labels/autorelease%3A%20pending"),
    "tagged must be added before pending is removed so recovery always retains a release label",
  );
  assert.match(releasePlease.source, /--pattern 'release-artifact-gate\.v1\.json'/u);
  assert.match(releasePlease.source, /--pattern 'sbom\.spdx\.json'/u);
  assert.match(releasePlease.source, /Draft release assets differ from the exact verified release set/u);
  assert.match(
    releasePlease.source,
    /verify_candidate_bundle\.mjs "\$download_directory"[\s\S]{0,220}--commit "\$CANDIDATE_SHA"[\s\S]{0,100}--post-release-tag "\$EXPECTED_TAG"/u,
  );
  assert.equal(
    (releasePlease.source.match(/--commit "\$CANDIDATE_SHA"/gu) ?? []).length,
    3,
  );
  assert.equal(
    (releasePlease.source.match(/node tools\/verify_candidate_bundle\.mjs/gu) ?? []).length,
    3,
  );
  assert.doesNotMatch(releasePlease.source, /npm dist-tag|npm publish[^\n]*--tag|prerelease: true/iu);
});

test("an advancing main cannot retarget the release mutation", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "open-rfc-release-workflow-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bin = join(temporary, "bin");
  await mkdir(bin);
  const candidate = "a".repeat(40);
  const advancedMain = "b".repeat(40);
  const mainState = join(temporary, "main-state.txt");
  const releasePayloadPath = join(temporary, "release-payload.json");
  const tagPayloadPath = join(temporary, "tag-payload.json");
  const releaseState = join(temporary, "release-state.json");
  const tagState = join(temporary, "tag-state.json");
  const operationLog = join(temporary, "operations.log");
  await writeFile(
    join(temporary, "CHANGELOG.md"),
    "# Changelog\n\n## [0.2.0](https://example.invalid/v0.2.0) (2026-07-30)\n\n### Features\n\n* verified release\n",
  );
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != "ls-remote origin refs/heads/main" ]]; then exit 2; fi
printf '%s\\trefs/heads/main\\n' "$CANDIDATE_SHA"
printf '%s\\n' "$ADVANCED_MAIN" > "$MAIN_STATE"
`);
  await chmod(fakeGit, 0o700);
  const fakeGh = join(bin, "gh");
  await writeFile(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args.find((value) => value.startsWith("repos/"));
const methodIndex = args.indexOf("--method");
const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
if (args[0] === "release" && args[1] === "view") {
  if (!fs.existsSync(process.env.RELEASE_STATE)) process.exit(1);
  const release = JSON.parse(fs.readFileSync(process.env.RELEASE_STATE, "utf8"));
  process.stdout.write(JSON.stringify({
    body: release.body,
    isDraft: release.draft,
    isPrerelease: release.prerelease,
    name: release.name,
    tagName: release.tag_name,
  }));
} else if (method === "GET" && endpoint.includes("/git/ref/tags/")) {
  if (!fs.existsSync(process.env.TAG_STATE)) process.exit(1);
  process.stdout.write(fs.readFileSync(process.env.TAG_STATE));
} else if (method === "POST" && endpoint.endsWith("/git/refs")) {
  const input = fs.readFileSync(0, "utf8");
  fs.writeFileSync(process.env.TAG_PAYLOAD_PATH, input);
  const payload = JSON.parse(input);
  const state = { ref: payload.ref, object: { type: "commit", sha: payload.sha } };
  fs.writeFileSync(process.env.TAG_STATE, JSON.stringify(state));
  fs.appendFileSync(process.env.OPERATION_LOG, "tag\\n");
  process.stdout.write(JSON.stringify(state));
} else if (method === "POST" && endpoint.endsWith("/releases")) {
  const input = fs.readFileSync(0, "utf8");
  fs.writeFileSync(process.env.RELEASE_PAYLOAD_PATH, input);
  const payload = JSON.parse(input);
  fs.writeFileSync(process.env.RELEASE_STATE, JSON.stringify(payload));
  // GitHub lazily creates tags for draft releases. This mock deliberately does
  // not create one here; the workflow must have created the exact ref first.
  fs.appendFileSync(process.env.OPERATION_LOG, "release\\n");
  process.stdout.write(JSON.stringify({
    draft: payload.draft,
    tag_name: payload.tag_name,
    target_commitish: payload.target_commitish,
  }));
} else {
  process.stderr.write(JSON.stringify({ args, endpoint, method }));
  process.exit(2);
}
`);
  await chmod(fakeGh, 0o700);

  const mutation = releasePlease.value.jobs["create-draft-release"].steps.find(
    (step) => step.name === "Ensure the candidate-bound tag and draft GitHub Release",
  );
  assert.equal(typeof mutation?.run, "string");
  const runMutation = (recoverExistingDraft) => execFileAsync("bash", ["-c", mutation.run], {
    cwd: temporary,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ADVANCED_MAIN: advancedMain,
      CANDIDATE_SHA: candidate,
      EXPECTED_TAG: "v0.2.0",
      GH_TOKEN: "test-only-token",
      GITHUB_REPOSITORY: "marianfoo/open-rfc",
      MAIN_STATE: mainState,
      OPERATION_LOG: operationLog,
      RECOVER_EXISTING_DRAFT: recoverExistingDraft ? "true" : "false",
      RELEASE_PAYLOAD_PATH: releasePayloadPath,
      RELEASE_STATE: releaseState,
      RUNNER_TEMP: temporary,
      TAG_PAYLOAD_PATH: tagPayloadPath,
      TAG_STATE: tagState,
      VERSION: "0.2.0",
    },
    timeout: 30_000,
  });
  await runMutation(false);

  assert.equal((await readFile(mainState, "utf8")).trim(), advancedMain);
  assert.equal(await readFile(operationLog, "utf8"), "tag\nrelease\n");
  const tagPayload = JSON.parse(await readFile(tagPayloadPath, "utf8"));
  assert.equal(tagPayload.ref, "refs/tags/v0.2.0");
  assert.equal(tagPayload.sha, candidate);
  const releasePayload = JSON.parse(await readFile(releasePayloadPath, "utf8"));
  assert.equal(releasePayload.tag_name, "v0.2.0");
  assert.equal(releasePayload.target_commitish, candidate);
  assert.equal(releasePayload.draft, true);
  assert.equal(releasePayload.prerelease, false);
  assert.equal(releasePayload.generate_release_notes, false);
  assert.match(releasePayload.body, /verified release/u);

  await rm(join(temporary, "open-rfc-release-notes.md"), { force: true });
  await rm(releaseState, { force: true });
  await writeFile(operationLog, "");
  await runMutation(true);
  assert.equal(await readFile(operationLog, "utf8"), "release\n");

  await rm(join(temporary, "open-rfc-release-notes.md"), { force: true });
  await rm(tagState, { force: true });
  await writeFile(operationLog, "");
  await assert.rejects(
    runMutation(true),
    /Recovery requires the exact candidate tag created by the first attempt/u,
  );

  await writeFile(tagState, JSON.stringify({
    ref: "refs/tags/v0.2.0",
    object: { type: "commit", sha: candidate },
  }));
  await writeFile(releaseState, JSON.stringify({
    ...releasePayload,
    body: "hostile replacement body\n",
  }));
  await rm(join(temporary, "open-rfc-release-notes.md"), { force: true });
  await assert.rejects(
    runMutation(true),
    /Existing release is not the requested exact draft recovery target/u,
  );

  await rm(join(temporary, "open-rfc-release-notes.md"), { force: true });
  await rm(tagState, { force: true });
  await rm(releaseState, { force: true });
  await assert.rejects(
    runMutation(true),
    /Recovery requires the exact candidate tag created by the first attempt/u,
  );
});
