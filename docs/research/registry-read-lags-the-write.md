# Research: the post-publish registry check, and why it is gone

## What happened

`open-rfc@0.2.2` published successfully. The step immediately after it —
"Verify registry metadata and the downloaded tarball" — failed with:

```
Published npm metadata differs from the verified release.
```

The package was on the registry the whole time. The verification was wrong, not
the publish.

## Timing

| | |
|---|---|
| publish step completes | `21:34:08` |
| verification step starts | `21:34:08.94` |
| `npm view` returns and the check fails | `21:34:09.33` |

The registry was queried **0.4 seconds** after the write. npm's read path is
CDN-backed and does not update in step with a write: a successful `npm publish`
means the write was accepted, not that every read replica already serves it.

## The first fix was the wrong fix

The obvious response was to poll — ask repeatedly until the registry catches up.
That removes the false failure and leaves the check in place.

It also keeps a check that was never earning its cost. The better question is
whether the step should exist at all.

## What the step actually verified

- **`dist-tags.latest` equals the version.** The publish command passes no
  `--tag`, so `latest` is true by construction. This asserted the behaviour of
  the command three lines above it.
- **The registry tarball matches the published bytes.** npm computes and
  verifies tarball integrity on receipt; a publish that returned success and
  then served different bytes is not a failure mode this check could
  meaningfully catch, and it has never caught one.

So: one tautology, one duplicate of a guarantee npm already makes. Against that,
a 1-in-1 false-failure rate, and a red run for a release where nothing was wrong
— which is worse than no check, because a check that cries wolf gets ignored
exactly when it matters.

## What replaces it

`--provenance` with npm trusted publishing. It records a signed attestation
binding the package to the exact commit and workflow run that built it, in a
public transparency log. Anyone can verify it:

```
npm audit signatures
```

That is strictly stronger than the step it replaces, for the reason that matters:
a workflow checking its own publish is self-issued, and an attestation a third
party can verify is not.

## What is kept

Everything before the publish, which is where the real verification lives: the
tag must be an exact lightweight `v0.x.y` naming the checked-out commit and the
manifest version, the manifest must be the public Apache-2.0 profile, and the
publish is dry-run first.

## The general lesson

The first instinct was to make a failing check reliable. The right question was
whether the check was worth having. A check that duplicates a guarantee you
already have, and that can fail when nothing is wrong, is a liability with the
shape of diligence.
