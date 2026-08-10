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
