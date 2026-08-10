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

The `create-draft-release` job was initially left in place as a recovery path.
That was wrong and is corrected below: with Release Please creating the tag, a
dispatch of that job would fail creating a tag that already exists, so it is a
trap rather than a fallback. It is removed.

## Second defect, found while doing this — and its real fix

The workflows existed twice: `.github/workflows/` runs, `release/templates/` was
a second copy. Nothing kept them in step, and they had already drifted twice in
one day — `ci.yml` gained a `push` trigger on the live side only, so the
published repository ran CI on pull requests alone, and `release-please.yml`
lost its token guard on the live side only.

The first response was a parity test asserting the two copies stay byte-identical.
It worked: it caught a third drift within a minute of being written, when a
`git checkout --` during its own control test silently restored the committed
copy and discarded a reduction.

But a test that two copies agree is a guard on a duplication that should not
exist. `release/templates/` was a build-time artefact of how this repository was
first assembled: a second copy of the workflows, kept so a generator could copy
them into place. There is nothing to generate here — `.github/workflows/` **is**
the version that runs, and nothing in this repository read the templates except
the tests themselves.

So `release/templates/` is deleted, the parity test with it, and
`public-release-workflows.test.mjs` now reads `.github/workflows/` — the files
that actually run, which is what it should have asserted on from the start.
Drift is now impossible rather than caught.

This repository is maintained by pull request, so the directory cannot come
back the way it arrived.

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

---

## Follow-on: the workflow was 542 lines and is now 51

Once Release Please creates the release itself, `create-draft-release` is not
merely unused — dispatching it would fail creating a tag that already exists. It
was 475 of the file's 542 lines: input validation for four hand-entered values,
candidate lineage checks, tag and draft creation, asset attachment and
reverification.

What is left is the whole job: on a push to main, offer the commits to Release
Please. It opens or updates a release pull request, or does nothing because
nothing releasable has landed. Doing nothing is the normal case and reports as a
successful run rather than a skip.

Also removed, because each of them made a run report something other than what
was happening:

- `vars.OPEN_RFC_RELEASE_PLEASE_ENABLED`, which made every run report `skipped`
  when the variable was simply never set
- `workflow_dispatch` and its four inputs, which existed only for the job that
  is gone

The `github.repository ==` guard stays. A fork inherits this workflow and would
otherwise try to release from its own main against this repository's manifest.

`test/public-release-workflows.test.mjs` lost 248 lines with it, including a
150-line simulation that stubbed `git` and `gh` to prove the removed tag-creation
logic could not be retargeted by an advancing main. It was a good test of code
that no longer exists.

### The parity test caught me inside a minute

While control-testing it, I appended drift to the template, then ran
`git checkout --` to undo it — which restored the *committed* 542-line file and
silently discarded the reduction. The live copy still had it, so the two had
diverged again. The parity test failed on the next run and named the file.

That is the third instance of this drift in a day, and the first one caught
automatically.
