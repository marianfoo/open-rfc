<!--
Read CONTRIBUTING.md before opening this pull request. Open an issue first for a
large protocol, transport, authentication, or public-API change.
-->

## User-visible behavior

<!-- What changes for a user of the package, and does the documented support
boundary in SUPPORT.md change as a result? -->

## Checklist

- [ ] The smallest failing contract or boundary test was added before the fix.
- [ ] Behavior stays in its owning layer; no consumer-specific wire bytes.
- [ ] No fail-closed assertion was weakened and no transport or authentication
      claim was silently expanded.
- [ ] Public documentation is updated for API, configuration, error, or
      compatibility changes.
- [ ] Every external source or behavioral reference used is declared below.
- [ ] Every commit is signed off (`git commit -s`) per `DCO.md`.
- [ ] No credentials, customer data, network traces, vendor binaries, or
      material with unknown redistribution terms are included.

## Checks run

<!-- Which of `npm run test:public`, `npm run lint`, `npm run check:docs`,
`npm run docs:site:check`, `npm run package:shape`, plus any focused fault,
property, resource, or compatibility test named by the changed component. -->

## Declared external inputs

<!-- Source, exact version, and license for anything referenced. Write "none" if
this change is entirely original. -->
