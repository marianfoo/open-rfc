# Research: the npm registry read path lags the write

## What happened

`open-rfc@0.2.2` published successfully. The step immediately after it —
"Verify registry metadata and the downloaded tarball" — failed with:

```
Published npm metadata differs from the verified release.
```

The package was on the registry the whole time. The verification was wrong, not
the publish.

## Timing

From the run log:

| | |
|---|---|
| publish step completes | `21:34:08` |
| verification step starts | `21:34:08.94` |
| `npm view` returns and the check fails | `21:34:09.33` |

The registry was queried **0.4 seconds** after the publish returned.

## Why

npm's read path is CDN-backed and does not update in step with a write. A
successful `npm publish` means the write was accepted, not that every read
replica already serves it. Asking once, immediately, is a race — and it is a
race the workflow loses often enough to matter, because the check ran as the
very next step with nothing in between.

Confirmed by observation: `npm view open-rfc dist-tags.latest` reports `0.2.2`
now. Nothing was ever wrong with the published artifact.

## Second defect in the same step

The failure message named neither the observed value nor the expected one. So
the log could not distinguish

- a registry that has not caught up yet, and
- a genuinely wrong publish

which are the same string on the way out and completely different problems. The
first costs a re-run; the second is a release incident.

## Fix

Poll rather than ask once, for both reads — the dist-tag and the tarball — with
a bounded number of attempts, and print what was actually seen on each retry and
on final failure.

Bounded, not unbounded: a registry that never catches up is a real failure and
must still fail. Twenty attempts at six seconds is two minutes, which is far
beyond observed propagation and still terminates.

## What is deliberately unchanged

The comparison itself. Once the registry serves the version, its tarball is
still re-downloaded and compared **byte for byte** against what was published.
That check found nothing wrong here and remains the point of the step — the
race was in when it asked, not in what it asked.
