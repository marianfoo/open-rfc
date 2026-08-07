# Research: why v0.2.1 was released but never published

## What happened

Merging the Release Please pull request worked. The action tagged `v0.2.1`,
created the GitHub release, and marked it Latest. Then nothing.

`npm-publish.yml` listens for `release: published`. It has never run — not
once, not even a skipped run that its `if:` filtered out. The registry still
serves 0.2.0 while GitHub shows a 0.2.1 release.

## Why

The release was created by `github-actions[bot]` using `GITHUB_TOKEN`, and
GitHub does not let an event raised by `GITHUB_TOKEN` start another workflow
run. It is the same rule that leaves the release pull request without CI — but
where that costs a check, this breaks the chain outright. No event, no run, no
publish.

Nothing reports this. There is no failed workflow to look at, because no
workflow was ever asked to start.

## How arc-1 does it

`arc-mcp/arc-1` runs release-please and publishing as **two jobs in one
workflow**:

```yaml
jobs:
  release-please:
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
    steps:
      - uses: googleapis/release-please-action@...
        id: release

  publish-npm:
    needs: release-please
    if: ${{ needs.release-please.outputs.release_created || github.event_name == 'workflow_dispatch' }}
    permissions:
      contents: read
      id-token: write
    steps:
      ...
      - run: npm publish --provenance --access public
```

A dependent job runs inside the same workflow run. Nothing has to trigger
anything, so the `GITHUB_TOKEN` rule never applies. No second credential.

That is why arc-1 has never needed a token: it never asks one event to start
another.

### Their manual arm exists for exactly the state we are in

The `workflow_dispatch` arm is not decoration. arc-1 added it after their own
v1.0.1 publish failed, and the comment records why the obvious recovery does
not work:

> Re-running the original run cannot fix it — a re-run replays the triggering
> commit, and the release tag points at that same pre-fix state. main, however,
> still carries the stuck version in package.json plus whatever fixed the
> failure, so publishing main IS publishing that version.

That is v0.2.1 here. Re-running the release that created the tag would replay a
tree in which nothing publishes. Publishing `main` — which carries 0.2.1 in the
manifest plus the fix — is what actually ships it. The dispatch arm is designed
around that, which is why it reads the version from the manifest rather than
replaying a tag.

## What open-rfc needs

The same shape. The differences are incidental:

- arc-1 has no `environment:` on the publish job; open-rfc keeps `npm`
- arc-1 installs a newer npm globally to get OIDC support; open-rfc already
  pins npm 11.19.0 through `ci:install-pinned-npm`, well past the 11.5 that
  trusted publishing needs
- open-rfc verifies the tag names one commit, that the checkout is that commit,
  and that the tag matches the manifest, then re-reads the registry after
  publishing and compares the served tarball byte for byte. arc-1 does none of
  that. Those checks are worth keeping and are unaffected by where the job runs

## Consequence for the npm trusted publisher

npm's trusted publisher names a workflow file. Moving the publish job into
`release-please.yml` means the configured workflow has to change from
`npm-publish.yml` to `release-please.yml`, or OIDC will refuse the publish. That
is an edit on npmjs.com, not in this repository.

## Alternative, rejected

A GitHub App or PAT in `RELEASE_PLEASE_TOKEN` would make the release event fire
normally, leaving `npm-publish.yml` untouched. It works, and it costs a
credential to create, store and rotate for the sole purpose of making one event
chain to another. The dependent job removes the need instead of paying for it.

## How this was checked

A local clone at `~/DEV/arc-1` was read first. Its remote names
`ClementRingot/arc-1`, which 404s — a stale URL from before the repository moved
to the `arc-mcp` organisation — and its `release.yml` is 351 lines against the
canonical 530. The dependent-job conclusion held, but the recovery reasoning
above is only in the current file and would have been missed.

Everything cited here is from `arc-mcp/arc-1` read through the API. A checkout
whose origin no longer resolves is not evidence about the project it came from.

## One difference kept deliberately

arc-1 gates on the raw output: `${{ needs.release-please.outputs.release_created }}`.
That works because the action leaves the output empty when it creates no
release, and an empty string is falsy in a GitHub expression. The version here
compares against `'true'` explicitly, because a non-empty string is truthy — so
if the action ever emitted the literal `false`, the raw form would publish and
the explicit form would not.

## For 1.0

arc-1's config drops `bump-minor-pre-major` and `bump-patch-for-minor-pre-major`
at 1.0, so semver resumes normally: feat bumps minor, breaking bumps major.
open-rfc currently maps both to patch, which is right below 1.0 and wrong above
it.
