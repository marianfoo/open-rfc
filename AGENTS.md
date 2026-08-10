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
npm run check:docs:public
npm run lint
npm run package:shape -- --publication-mode public-license-preflight
```

Every command above runs on Linux, macOS, and Windows. `npm run docs:site:check`
is the one exception and is covered separately below.

Before opening a pull request, run every applicable command above and any
focused fault, property, resource, or compatibility test named by the changed
component. Report suite results as pass and fail counts, from a run of the tree
you are pushing.

For a documentation-only change, `npm run check:docs:public` is the applicable
command. Do not run the product test, lint, or package-shape suites unless the
change also touches product code, shared tooling, package contents, or their
contracts.

### Run one test

`npm run test:public` builds and then runs every file, which is rarely what you
want while iterating. Run a single test directly instead.

A `.mjs` test needs no build:

```sh
node --test test/tool-bounds.test.mjs
```

A TypeScript test runs from its compiled output in `dist/test/`, so build first.
The build takes a few seconds:

```sh
npm run build && node --test dist/test/xml-entity-reference.test.js
```

Run the smallest relevant test while developing, and the full suite once before
you push.

### `docs:site:check` runs in CI, not locally

`npm run docs:site:check` pins the SHA-256 of the documentation site's
JavaScript bundle, so it passes only against the exact toolchain in
`requirements-docs.txt` — a wheel closure for Linux x64 and CPython 3.13.14.
On macOS or Windows the install fails its own hash check, so the command cannot
pass there and a local failure says nothing about your change. On Linux:

```sh
python -m pip install --require-hashes --only-binary=:all: -r requirements-docs.txt
```

CI runs this check on every pull request regardless of your platform.
`npm run check:docs:public` is the documentation check that runs everywhere and
is the one to run before pushing.

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
