<!--
Read CONTRIBUTING.md and AGENTS.md before opening this pull request. Open an
issue first for a large protocol, transport, authentication, or public-API
change, so the design is agreed before you spend time on it.
-->

## User-visible behavior

<!-- What changes for a user of the package, and does the documented support
boundary in SUPPORT.md change as a result? -->

## Before you open this

From a clean checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:public
npm run lint
npm run check:docs:public
npm run package:shape -- --publication-mode public-license-preflight
```

While iterating, run one test rather than the whole suite — `node --test
test/<name>.test.mjs`, or `npm run build && node --test
dist/test/<name>.test.js` for a TypeScript test.

For a documentation-only change, `npm run check:docs:public` is the only
applicable command.

`npm run docs:site:check` is **not** in that list on purpose: it pins the
documentation toolchain to a Linux x64 wheel closure, so it cannot pass on macOS
or Windows and a local failure means nothing. CI runs it for you.

## Checks run

<!-- Paste the pass/fail counts from `npm run test:public`, plus which of the
commands above you ran and any focused fault, property, resource, or
compatibility test named by the changed component. Numbers must come from a run
of the tree you are pushing. -->

## Checklist

- [ ] The smallest failing contract or boundary test was added **before** the
      fix, and was **seen to fail without it** — a test that has never failed is
      not yet a test.
- [ ] No decoder pins a length, count, or value range that varies by peer,
      release, or configuration. See `docs/recurring-bug-class.md`.
- [ ] Behavior stays in its owning layer; no consumer-specific wire bytes.
- [ ] No fail-closed assertion was weakened and no transport or authentication
      claim was silently expanded.
- [ ] Public documentation is updated for API, configuration, error, or
      compatibility changes.
- [ ] Every external source or behavioral reference used is declared below.
- [ ] Every commit is signed off (`git commit -s`) per `DCO.md`.
- [ ] No credentials, customer data, network traces, vendor binaries, or
      material with unknown redistribution terms are included.

## Declared external inputs

<!-- Source, exact version, and license for anything referenced. Write "none" if
this change is entirely original. -->
