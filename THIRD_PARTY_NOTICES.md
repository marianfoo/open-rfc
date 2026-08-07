# Third-party notices

`open-rfc` ships no runtime dependencies: `package.json` declares no
`dependencies`, `peerDependencies`, `optionalDependencies`, or bundled
dependencies, and no module in the published build imports anything outside
Node's own built-in modules. The installed package is JavaScript and TypeScript
declarations compiled from this repository's TypeScript source, with no native
addon.

This file carries the notices required by the licenses of third-party material
that `open-rfc` redistributes, in the npm package and in this repository.

## node-rfc (Apache-2.0)

The following files are modified adaptations by `open-rfc` contributors:

- `src/compat/node-rfc-public-surface.ts`
- `src/client/rfc-errors.ts`

They pin public enum names and values, and compatible recursive type aliases,
to the archived node-rfc v3.3.1 source at commit
`9ccc30b717ff6d841fc52618e80de62c67ba58f0`, file `src/ts/sapnwrfc.ts`, so that
`open-rfc` presents the same numeric domain to code written against that API.
The pinned upstream file carries this exact attribution:

    SPDX-FileCopyrightText: 2014 SAP SE Srdjan Boskovic <srdjan.boskovic@sap.com>
    SPDX-License-Identifier: Apache-2.0

The upstream repository's `.reuse/dep5` metadata additionally records the
following attribution for its broader source set:

    SPDX-FileCopyrightText: 2015-2023 SAP SE Srdjan Boskovic <srdjan.boskovic@sap.com>

    node-rfc
    Licensed under the Apache License, Version 2.0
    https://www.apache.org/licenses/LICENSE-2.0
    https://github.com/SAP/node-rfc

The public repository and npm package include a copy of the Apache License,
Version 2.0 in their root `LICENSE` file. Unless required by applicable law or
agreed to in writing, software distributed under the License is
distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied.

The compatibility interface names that `open-rfc` adds around those values do
not occur in that pinned upstream source. All changes and adaptations in the
two files named above were made by `open-rfc` contributors.

## Developer Certificate of Origin 1.1 (The Linux Foundation)

This repository includes `DCO.md`, an unmodified verbatim copy of the Developer
Certificate of Origin, Version 1.1. The document permits copying and
distributing verbatim copies of itself and prohibits changing it. It carries
this notice, which `DCO.md` reproduces in place:

    Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

    Everyone is permitted to copy and distribute verbatim copies of this
    license document, but changing it is not allowed.

`DCO.md` is part of this repository only; it is not contained in the npm
package.

## Trademarks

SAP, ABAP, SAP S/4HANA, and SAP NetWeaver are trademarks or registered
trademarks of SAP SE or its affiliates. `open-rfc` is an independent project and
is not affiliated with, sponsored by, or endorsed by SAP SE. See `NOTICE`.
