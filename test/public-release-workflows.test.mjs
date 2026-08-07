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
    new URL(`../.github/workflows/${name}`, import.meta.url),
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

test("release-please only opens the release pull request", () => {
  // The workflow was 542 lines. 475 of them were a manual create-draft-release
  // job that built a tag, a draft release and its assets from four
  // hand-entered inputs. Release Please now creates the release itself, so that
  // job was not merely unused: dispatching it would have failed creating a tag
  // that already exists. It is gone, and this test pins the shape that is left.
  assert.deepEqual(Object.keys(releasePlease.value.on), ["push"]);
  assert.deepEqual(releasePlease.value.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(releasePlease.value.jobs), ["release-please"]);
  assert.equal(releasePlease.value.concurrency.group, "release-please-main");
  assert.equal(releasePlease.value.concurrency["cancel-in-progress"], false);
  assert.deepEqual(releasePlease.value.permissions, {});
  const job = releasePlease.value.jobs["release-please"];
  assert.deepEqual(job.permissions, {
    contents: "write",
    "pull-requests": "write",
  });
  assert.equal(job["runs-on"], "ubuntu-24.04");
  // A fork inherits this workflow and would otherwise release from its own main
  // against this repository's manifest.
  assert.match(job.if, /github\.repository == 'marianfoo\/open-rfc'/u);
  assert.equal(
    (releasePlease.source.match(/googleapis\/release-please-action@/gu) ?? []).length,
    1,
  );
  // skip-github-release would stop the release being created, and the release
  // is what triggers npm-publish.yml. Its absence is the automation.
  assert.doesNotMatch(releasePlease.source, /skip-github-release/u);
  assert.doesNotMatch(releasePlease.source, /skip-github-pull-request/u);
  // The gates that made every run report "skipped" or fail are gone.
  assert.doesNotMatch(releasePlease.source, /OPEN_RFC_RELEASE_PLEASE_ENABLED/u);
  // The comment explains what a token would buy; what must be gone is any use
  // of it, because an unset secret is what made every run fail.
  assert.doesNotMatch(releasePlease.source, /secrets\.RELEASE_PLEASE_TOKEN/u);
  assert.doesNotMatch(releasePlease.source, /workflow_dispatch/u);
  assert.doesNotMatch(releasePlease.source, /create-draft-release/u);
});

