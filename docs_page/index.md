# RFC without the SDK install

<p class="open-rfc-lead">open-rfc is a TypeScript and JavaScript client for SAP classic RFC. It implements the wire path in portable Node.js code, with zero runtime dependencies and no native addon.</p>

| Start here | What you will find |
|---|---|
| [Quick start](getting-started.md) | Install one exact artifact, configure a direct destination, and validate it safely. |
| [Standalone client](standalone.md) | Call remote-enabled function modules with the modern or node-rfc-compatible API. |
| [node-rfc replacement](node-rfc.md) | Preserve the module ID with an exact npm alias or trusted tarball and use the fail-closed client and pool surface. |
| [SAP CAP](cap.md) | Keep `@sap/cds-rfc` unchanged and override only its low-level native connector. |
| [Configuration](configuration.md) | Choose the gateway endpoint, technical principal, authorization, bounds, and first validation flow. |
| [Release status](status.md) | Verify that GitHub, npm, artifact digests, and the documented support record agree. |

## Selected beta boundary

- An SDK-free classic RFC client for Ubuntu 24.04 x64 with Node.js `^22.14.0` or
  `^24.0.0`.
- A direct application-server path with classic scalar, structure, table,
  metadata, timeout, cancellation, and pooling support.
- A compatibility surface for common `Client`, `Pool`, and `RFCClient`
  consumers.

The [project verification and uncovered areas](status.md#project-verification)
are part of this boundary. Project testing includes representative values but
not the exhaustive two-release value corpus, pool contention, extra repeats,
or long soaks.

## What it does not claim

The 0.x line has no production SLA. It is not a complete SAP NW RFC SDK
replacement or a claim that every node-rfc or CAP topology works. SNC, SSO,
X.509, server mode, tRFC, qRFC, bgRFC, non-Unicode partners, and several
specialized transports remain unsupported until a later release explicitly
includes them.

A source checkout or locally packed tarball is not automatically a published
release. Use only an exact version whose GitHub Release, npm metadata, artifact
digest, and [release status](status.md) agree.

!!! warning "Start narrow"
    Use a read-only RFM on a non-production system, set a finite timeout, and
    run bounded cleanup without masking the primary failure. A successful
    `RFC_PING` alone is not proof of application authorization; validate a
    permitted non-exempt read-only RFM.
