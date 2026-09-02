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

## open-rfc-go (Apache-2.0)

The following files contain modified TypeScript adaptations by `open-rfc`
contributors:

- `src/protocol/lz4-block.ts`
- `src/protocol/fast-serializer.ts`
- `src/protocol/logon-ticket.ts`
- `src/protocol/cpic.ts`
- `src/protocol/rfc-callback.ts`
- `src/metadata/rfc-structure-definition.ts`
- `src/values/classic-xrfc.ts`
- `src/values/recursive-xrfc.ts`
- `src/values/recursive-classic-xrfc.ts`

They use Apache-licensed interoperability work in `open-rfc-go` at commit
`92d5d8f6e0a08ff7ac1580f461585cbde2a56939` as an implementation basis,
specifically these upstream files:

- `internal/fastser/lz4.go`
- `internal/fastser/container.go`
- `internal/fastser/record.go`
- `internal/fastser/fields.go`
- `internal/cpic/ticket.go`
- `internal/cpic/logon.go`
- `internal/rfcserver/request.go`
- `internal/rfcserver/response.go`
- `internal/metadata/structure_definition.go`
- `internal/client/session.go`
- `rfc/callback.go`
- `internal/xrfc/classic_xrfc.go`
- `internal/xrfc/recursive_xrfc_codec.go`

The pinned upstream project carries this notice:

    open-rfc-go
    Copyright 2026 oisee (https://github.com/oisee)

    Licensed under the Apache License, Version 2.0
    https://www.apache.org/licenses/LICENSE-2.0
    https://github.com/oisee/open-rfc-go

The adaptations change the language and API, impose absolute allocation and
record-count limits, require exact framing instead of attempting stream
resynchronization, reject unknown tags and field types, copy exposed byte
values, and clear temporary buffers on failure. Record encoding adapts the
upstream `EncodeRecord` framing while rejecting rather than truncating values;
the strict item, STRING, record-stream, and field-announcement encoders are
TypeScript additions built from the same decoded grammar. The exact elementary
parameter-block codec adapts the upstream `DecodeTypedFields` grammar for the
three established INT4, CHAR, and STRING forms, replacing its bounded scan with
a contiguous fail-closed parser and adding the corresponding encoder and exact
`0x5001` item composition. The raw LZ4 encoder is independently authored from
the published LZ4 Block Format Description at lz4/lz4 v1.10.0, commit
`ebb370ca83af193212df4dcbadcc5d87bc0de2f0`; no LZ4 implementation source,
binary, or runtime dependency is redistributed. The accompanying tests were
authored for this project from neutral synthetic values; no upstream packet-
capture fixture is redistributed.

The MYSAPSSO2 adaptation uses the upstream ticket normalization and CPIC
credential-selection behavior: SAP cookie escaping is normalized, ticket text
is encoded as UTF-16LE in field `0x0670`, and the password field is omitted.
The TypeScript adaptation additionally preserves literal `+`, rejects malformed
percent escapes and non-Base64 text, imposes a fixed input bound, makes password
and ticket credentials mutually exclusive in its types and runtime validation,
clears temporary credential bytes, and keeps tickets out of inspected and JSON
route plans. No upstream capture or ticket value is redistributed.

The callback adaptation covers the upstream established-session CUT
request/response grammar and same-conversation callback loop. The TypeScript
API exposes raw owned values to synchronous handlers, bounds handlers and
callbacks to 64 per outer call, returns `FU_NOT_FOUND` for unknown functions,
strictly validates field order and framing, and retires the connection on
malformed or uncertain state. The scripted callback fixtures were authored for
this project from synthetic values; no upstream capture is redistributed.

The xRFC adaptation accepts SAP's MIME-style Base64 line wrapping for XSTRING
cells. The TypeScript decoders remove only CR and LF before canonical Base64
validation, retain the existing decoded and aggregate byte limits, and continue
to reject spaces and all other non-canonical text.

The structure-definition adaptation normalizes `RFC_FIELDS` rows into their
authoritative returned order because included and appended DDIC components can
repeat or skip informational `POSITION` values. It retains unique-name,
non-overlap, non-negative, and total-structure bounds before exposing the
normalized definition. For legacy table-type metadata, it also detects the
distinct row-structure owner and performs one bounded dereference instead of
rejecting the valid owner mismatch or following an unbounded alias chain.

The public repository and npm package include a copy of the Apache License,
Version 2.0 in their root `LICENSE` file. Unless required by applicable law or
agreed to in writing, software distributed under the License is distributed
on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
express or implied.

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
