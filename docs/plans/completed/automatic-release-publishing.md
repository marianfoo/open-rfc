# Plan: publish to npm automatically when a release lands

## Problem

Merging the Release Please pull request bumped the version and stopped. No tag,
no release, nothing published — `main` sat at 0.2.1 while the registry still
served 0.2.0.

Three separate things caused that, and each had to be found by running it:

1. `prepare-release-pr` was gated on a repository variable,
   `OPEN_RFC_RELEASE_PLEASE_ENABLED`, that had never been set. The run reported
   `skipped`, which reads like nothing to do rather than a missing switch.
2. The action was gated on a `RELEASE_PLEASE_TOKEN` secret that did not exist.
   Removed in a previous change: the token buys CI on the release pull request
   and nothing else, which is not worth a second credential here.
3. `skip-github-release: "true"` meant Release Please never created the release,
   and `create-draft-release` only ran on `workflow_dispatch` with four
   hand-entered inputs — including the SHA-256 of a tarball the operator had
   built and checked themselves.

Item 3 was a deliberate design: the workflow compared its own build against a
digest a human asserted, so two independent parties had to arrive at the same
bytes. That is real, and it is also not what the owner wants. A release should
happen because a release pull request merged.

## Approach

Let Release Please create the release, and let the publish workflow build what
it publishes.

- `release-please-config.json`: `draft: false`, so the release is published
  rather than left as a draft. `npm-publish.yml` fires on `release: published`,
  so a draft never triggers anything.
- `release-please.yml`: drop `skip-github-release`, so the action creates the tag
  and release when the version pull request merges.
- `npm-publish.yml`: build the tarball from the checked-out tag instead of
  downloading assets from the release. A Release Please release carries no
  assets, so the previous download step could never have succeeded on one.

## What is kept

The parts that were doing real work stay:

- the tag must be an exact `v0.x.y`, lightweight, and point at a commit
- the checkout must be that commit
- the tag must name the version in `package.json`, and the manifest must be the
  public Apache-2.0 profile
- publish is dry-run first, then published with `--provenance`
- **after publishing**, the registry is re-read and the tarball it serves is
  re-downloaded and compared byte for byte against what was published

## What is given up, stated plainly

The two-party digest attestation. Before, a human built the tarball, checked it,
and typed its digest in; the runner then had to reproduce it exactly. Now the
runner builds and publishes its own artifact.

That is a real reduction, and it is worth being honest that the replacement is
not nothing: `--provenance` with npm trusted publishing records a signed,
publicly verifiable attestation binding the package to the exact commit and
workflow that produced it. Anyone can check it with `npm audit signatures`. The
attestation moves from a person to a machine-checkable one; it does not vanish.

The `create-draft-release` job is left in place. It is `workflow_dispatch`-only
so it cannot fire by accident, and it remains a recovery path.

## Second defect, found while doing this

The workflows exist twice — `.github/workflows/` runs, `release/templates/` is
what a public export ships — and nothing kept them in step. They had already
drifted twice in one day:

- `ci.yml` gained a `push` trigger on the live side only, so the published
  repository ran CI on pull requests alone
- `release-please.yml` lost its token guard on the live side only

Both were invisible, because the live copy behaves correctly and the workflow
tests read the template. `test/workflow-template-parity.test.mjs` now asserts
the pairs are byte-identical and that neither side carries a workflow the other
does not. Control-tested by planting drift and confirming it fails.

## Verification

- `npm run test:public` — passed, 3 compiled and 12 source test files
- `npm run lint` — clean
- the rewritten publish assertions were control-tested: changing the workflow
  makes them fail, so they bind to the new shape rather than passing vacuously
- the parity test was control-tested against planted drift

## One-off left over

0.2.1's version bump merged before this automation existed, so no release exists
for it. It needs one manual release; from the next version on, merging the
release pull request is the whole flow.
