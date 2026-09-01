# Contributing

Thank you for helping improve open-rfc. Participation is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).

Keep changes focused, preserve the layer boundaries in [AGENTS.md](AGENTS.md),
and add a regression for product behavior. Public API, configuration, error,
and compatibility changes should update the relevant user documentation.

Do not contribute SAP SDK files, binaries, headers, credentials, private system
data, captures, or material whose terms are incompatible with Apache-2.0
distribution. Third-party code included in a change needs its exact source
revision, license, and any required notice. Protocol behavior may be learned
from official documentation and neutral observation; do not copy or translate
copyleft implementation code into this repository.

Before opening a code pull request, run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run lint
```

Run `npm run test:surface` when the package API or build output changes, and
`npm run docs:build` when the documentation site changes. While iterating,
build once and run the smallest compiled test under `dist/test`.

Every commit must carry a Developer Certificate of Origin sign-off:

```sh
git commit -s
```

The `Signed-off-by` line certifies the DCO in [DCO.md](DCO.md).
