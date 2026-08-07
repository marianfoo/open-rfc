# open-rfc contributor guide

This guide applies to maintainers, contributors, and automated coding agents in
the open-rfc repository. Keep changes within the documented product boundary
and preserve compatibility unless a pull request explicitly changes that
contract.

## Architecture

- `src/protocol/` owns byte framing, handshakes, and classic RFC protocol
  behavior.
- `src/transport/` owns network routes and bounded socket or tunnel behavior.
- `src/metadata/` and `src/values/` own metadata interpretation and value
  serialization.
- `src/client/`, `src/pool/`, and `src/lifecycle/` own calls, pooling,
  cancellation, and transaction state.
- `src/compat/` adapts the shared core to the documented compatibility APIs.
- Public exports belong in `src/index.ts`; avoid exposing implementation-only
  modules accidentally.

Keep wire behavior in its owning layer. Prefer a small explicit module over a
cross-layer shortcut, bound all input-controlled allocation and recursion, and
fail closed for unsupported routes or options.

## Build and test

Use the package-manager version declared by `packageManager` in `package.json`.
From a clean checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:public
npm run check:docs
npm run docs:site:check
npm run lint
npm run package:shape -- --publication-mode public-license-preflight
```

During development, run the smallest relevant test first. Before opening a pull
request, run every applicable command above and any focused fault, property,
resource, or compatibility test named by the changed component.

## Contribution rules

- Read `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `SUPPORT.md` before
  changing behavior.
- Add the smallest failing contract, malformed-input, boundary, cancellation,
  or regression test before the implementation change.
- Preserve public API and error semantics unless the pull request documents and
  tests an intentional compatibility change.
- Update end-user documentation and examples whenever setup, behavior, limits,
  or supported integrations change.
- Never commit credentials, customer data, network traces, vendor binaries, or
  material whose redistribution terms are unknown.
- Sign every commit as required by `CONTRIBUTING.md` and `DCO.md`.
