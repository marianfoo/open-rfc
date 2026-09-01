# open-rfc contributor guide

open-rfc is an independent, SDK-free TypeScript implementation of SAP classic
RFC. Keep the development loop small without weakening protocol correctness.

## Product boundaries

- Keep one pure TypeScript/JavaScript package with zero runtime dependencies.
- Never load, link, download, or redistribute the SAP NW RFC SDK or native
  addons.
- Keep the public API at the package root plus `./package.json`; internals are
  not public subpaths.
- Unknown protocol, serializer, security, or provider state fails closed.
  Never replay a timed-out, aborted, malformed, or otherwise uncertain call.
- Keep protocol bytes in `src/protocol`, sockets and terminal state in
  `src/transport`, metadata/value projection in their owning modules, client
  behavior in `src/client`, and compatibility adaptation in `src/compat`.

The product license is Apache-2.0. New work may use project-owned knowledge,
official documentation, neutral observations, and compatible permissive
sources. When third-party code is reused, record its exact revision and
required notice once in the change. Copyleft implementations may help explain
behavior but are not copied or translated into this product.

## Fast implementation loop

1. Preserve unrelated work and add the smallest useful regression or feature
   contract.
2. Implement the change at the owning layer.
3. During iteration, build once and run the focused test directly from
   `dist/test`.
4. Before pushing shared or cross-layer code, run:

   ```sh
   npm test
   npm run lint
   ```

5. Run `npm run test:surface` only when exports, declarations, package
   metadata, loaders, or build output changed. Run `npm run docs:build` only
   for documentation or Pages changes.

Focused fault, property, resource, live, or compatibility checks are useful
when that exact boundary changes; they are not routine blockers for unrelated
patches. Code regressions remain mandatory for product behavior.

## Releases

Release Please owns versioning, GitHub releases, and npm publication from
`main`. Do not publish from a development branch. The documentation workflow
deploys Pages separately and does not block code pull requests.
