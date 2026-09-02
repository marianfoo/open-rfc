# Changelog

All notable changes to `open-rfc` are recorded here. The project follows
[Semantic Versioning](https://semver.org/) for the declared public surface once
that surface is released.

## Unreleased

### Added

- An unsupported direct named-user preview for classic RFC through the BTP
  Connectivity SOCKS5 endpoint and an explicit Cloud Connector TCP mapping.

### Fixed

- The classic compatibility snapshot now retains Connectivity route parameters
  so unsupported RFC-proxy requests fail closed instead of silently selecting a
  direct connection.

## [0.2.4](https://github.com/marianfoo/open-rfc/compare/v0.2.3...v0.2.4) (2026-09-02)


### Features

* add bounded fast serializer decoding ([#18](https://github.com/marianfoo/open-rfc/issues/18)) ([fdfc7f3](https://github.com/marianfoo/open-rfc/commit/fdfc7f33ec46fc3a54200e1f223d8442b4ebc915))
* add compressed fast serializer scalar items ([#23](https://github.com/marianfoo/open-rfc/issues/23)) ([a0f5fe4](https://github.com/marianfoo/open-rfc/commit/a0f5fe4d15a6e5367c81bbca51e192ab2bf01400))
* add fast serializer encoding primitives ([#21](https://github.com/marianfoo/open-rfc/issues/21)) ([5623d2b](https://github.com/marianfoo/open-rfc/commit/5623d2bd378158829d0e955af7f23d9d6ed58c8a))
* add fast serializer scalar parameter codec ([#22](https://github.com/marianfoo/open-rfc/issues/22)) ([553248a](https://github.com/marianfoo/open-rfc/commit/553248a61841ddb79b4b3837aefbea57ded1460b))
* add MYSAPSSO2 ticket authentication ([#24](https://github.com/marianfoo/open-rfc/issues/24)) ([793a71b](https://github.com/marianfoo/open-rfc/commit/793a71bf602caddaf29b4acb53deccd16a692c0d))
* name callback xRFC inputs ([#33](https://github.com/marianfoo/open-rfc/issues/33)) ([0156e58](https://github.com/marianfoo/open-rfc/commit/0156e5854a0d5f7910e4c81745e8421facedb124))
* ping modern pinned connections ([#31](https://github.com/marianfoo/open-rfc/issues/31)) ([2246644](https://github.com/marianfoo/open-rfc/commit/224664494477d5261cd662720b61ba6fd44b61a1))
* return callback xRFC outputs ([#34](https://github.com/marianfoo/open-rfc/issues/34)) ([14660b2](https://github.com/marianfoo/open-rfc/commit/14660b273655ec42352166fc4e631412f44996fb))
* return declared RFC callback exceptions ([#28](https://github.com/marianfoo/open-rfc/issues/28)) ([949dd30](https://github.com/marianfoo/open-rfc/commit/949dd307acce90eff5b091d6307454defdc839eb))
* support bounded RFC callbacks and wrapped XSTRINGs ([#25](https://github.com/marianfoo/open-rfc/issues/25)) ([fe20c1e](https://github.com/marianfoo/open-rfc/commit/fe20c1edae21c6c9e54c19db26de68cec49ea542))


### Bug Fixes

* accept included structure field positions ([#26](https://github.com/marianfoo/open-rfc/issues/26)) ([e91584a](https://github.com/marianfoo/open-rfc/commit/e91584a838990e74020028b56f99af397c3eb79e))
* bound callback response values ([#30](https://github.com/marianfoo/open-rfc/issues/30)) ([674628a](https://github.com/marianfoo/open-rfc/commit/674628a0965b0e50cd55f24865d6e584ac756079))
* classify rich NetWeaver logon errors ([#20](https://github.com/marianfoo/open-rfc/issues/20)) ([0b326de](https://github.com/marianfoo/open-rfc/commit/0b326de980133e355add752cc502a82b18cd3211))
* constrain callback response outputs ([#32](https://github.com/marianfoo/open-rfc/issues/32)) ([8525868](https://github.com/marianfoo/open-rfc/commit/852586807a36e6abc41f11924433083c113085ac))
* expand compressed callback table rows ([#29](https://github.com/marianfoo/open-rfc/issues/29)) ([f3d8c91](https://github.com/marianfoo/open-rfc/commit/f3d8c916c86437976b378408047bef8303abc412))
* harden callback response snapshots ([#35](https://github.com/marianfoo/open-rfc/issues/35)) ([b9996a3](https://github.com/marianfoo/open-rfc/commit/b9996a38481b0cec662d27a196d8681534bf879a))
* resolve legacy table type row structures ([#27](https://github.com/marianfoo/open-rfc/issues/27)) ([68b438b](https://github.com/marianfoo/open-rfc/commit/68b438b04871e88a8b5c393c21ae9616774a2d22))

## [0.2.3](https://github.com/marianfoo/open-rfc/compare/v0.2.2...v0.2.3) (2026-08-10)


### Features

* add BTP Connectivity SOCKS5 RFC route ([#14](https://github.com/marianfoo/open-rfc/issues/14)) ([7300d86](https://github.com/marianfoo/open-rfc/commit/7300d861c2179ddee2414eea85e5c660dc7277fd))


### Bug Fixes

* **ci:** drop the post-publish registry check rather than making it reliable ([#8](https://github.com/marianfoo/open-rfc/issues/8)) ([863284d](https://github.com/marianfoo/open-rfc/commit/863284d61b5897899ca69f47a1824efbd780dda8))

## [0.2.2](https://github.com/marianfoo/open-rfc/compare/v0.2.1...v0.2.2) (2026-08-07)


### Bug Fixes

* **ci:** publish inside the release run instead of a second workflow ([#6](https://github.com/marianfoo/open-rfc/issues/6)) ([b964caa](https://github.com/marianfoo/open-rfc/commit/b964caa89230db377469bd9d38fe33db1d40ba9e))

## [0.2.1](https://github.com/marianfoo/open-rfc/compare/v0.2.0...v0.2.1) (2026-08-07)


### Bug Fixes

* **values:** accept zero-padded XML character references ([#2](https://github.com/marianfoo/open-rfc/issues/2)) ([f88d214](https://github.com/marianfoo/open-rfc/commit/f88d21414676173d7e8612bd6e80ca50ef70e1b3))

## [0.2.0]

Initial public beta release.

### Added

- SDK-free direct classic RFC transport with checked NI, APPC, CPIC, RFCPRO,
  metadata, scalar, structure, table, decimal, temporal, lifecycle, and pool
  layers.
- `node-rfc` Client/Pool compatibility and the modern
  `@sap-rfc/node-rfc-library` façade used by `@sap/cds-rfc`.
- Bounded outgoing CPIC streaming, compact/extended RFCPRO lengths, DDIF and
  optimized metadata paths, error provenance, cancellation generation
  replacement, stateful contexts, and a finite fair connection pool.
- Compatibility conformance for the supported `node-rfc` surface, generated
  support tables, packed-package consumers, and unchanged-`@sap/cds-rfc`
  integration tests.
- Release-artifact inspection, runtime import guards, secret and forbidden-file
  checks, deterministic SPDX SBOM generation, dependency audit, registry
  signature verification, and tracked documentation validation.
- Reproducible npm release tooling and portable validation of the exact packed
  package used by standalone, compatibility, and CAP consumers.

### Changed

- Declared candidate runtime targets are Node.js 22 and 24. Node.js 20 is not in
  the beta contract.
- Package and release commands use a pinned npm CLI instead of host-dependent
  PATH resolution.
- Large outgoing application requests require explicit
  `cpic_streaming: "enabled"`; uncertain sends always retire the connection and
  are never replayed.
- Classic structure lookup defaults to DDIF-backed metadata. The legacy v3
  structure RFM is now an explicit compatibility strategy.
- Caller-owned values are snapshotted before asynchronous work with fixed
  depth, retained-byte, aggregate-node, and per-array row limits.
- Connection, metadata, context, transaction, and pool ownership are bound to
  immutable configuration generations instead of process-global mutable state.

### Experimental and unsupported

- Recursive classic/xRFC metadata and value paths, message-server resolution,
  SAProuter, the SAP Connectivity SOCKS5 transport, and WebSocket RFC are
  implementation previews outside the first beta support contract. Their
  presence in the package is not a support or interoperability claim.

### Security

- Structured diagnostics expose only bounded coordinates and omit causes,
  credentials, and returned values. Public `ABAPError` compatibility fields
  remain enumerable; applications must not serialize or log error objects
  wholesale because those fields can contain backend-provided message values.
- Package and documentation checks reject credentials, connection details,
  captures, native SDK files, and other private development material.
- The direct classic route still provides no transport confidentiality or
  integrity. Use it only on a trusted/private network or inside a separately
  managed protected tunnel. See [SECURITY.md](SECURITY.md).
