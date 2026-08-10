# Contributing

Thank you for helping improve open-rfc. Before changing code, read the public
support boundary in `README.md`, the end-user documentation in `docs_page/`,
and the architecture and test guidance in `AGENTS.md`.

Open an issue before starting a large protocol, transport, authentication, or
public-API change. For a focused bug fix, add the smallest failing contract or
boundary test first, keep behavior in its owning layer, and avoid widening the
documented support boundary as a side effect.

Do not contribute SAP SDK files, binaries, headers, restricted-derived material,
captures, credentials, private system data, or code derived from a source whose
terms are incompatible with Apache-2.0 distribution. Declare every external
input and preserve its exact version and license.

Every commit, including an automated dependency or release commit, must carry a
Developer Certificate of Origin sign-off from the person accepting
responsibility for that change:

```sh
git commit -s
```

The `Signed-off-by` line certifies the DCO in [`DCO.md`](DCO.md). It is not a
substitute for recording third-party provenance or license obligations.
The initial repository import uses
`marianfoo <13335743+marianfoo@users.noreply.github.com>` as its author,
committer, and sign-off identity. Release Please uses that same identity for
its generated sign-off. Other contributors sign off with the identity used to
author their commit. A generated pull request must contain no unreviewed source
changes. Any other unsigned bot change must be recreated or amended and signed
off by a maintainer before merge. The repository requires a DCO check through
branch protection.

Before opening a pull request:

1. describe the user-visible behavior and support boundary;
2. add the smallest failing contract or boundary test before the fix;
3. run checks in proportion to the change: documentation-only edits need
   `npm run check:docs:public`; product or shared tooling changes need the
   focused test plus their applicable public, lint, and package checks. See
   "Build and test" in [`AGENTS.md`](AGENTS.md) for running a single test, and
   for why `npm run docs:site:check` is a CI-only check;
4. update public documentation for API, configuration, error, or compatibility
   changes;
5. declare every source or behavioral reference used; and
6. sign off every commit with the identity used to author it.

Do not weaken a fail-closed assertion, silently expand a transport or
authentication claim, or include live SAP data in order to make a check pass.
