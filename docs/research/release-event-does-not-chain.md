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

`ClementRingot/arc-1` runs release-please and publishing as **two jobs in one
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
    if: ${{ needs.release-please.outputs.release_created }}
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
