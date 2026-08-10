# Safety and support limits

<p class="open-rfc-lead">The connector handles credentials and business data. Its safe default is to reject uncertainty, bound every untrusted length, and retain no replayable wire material.</p>

## Security practices

- Direct, message-server-selected, and SAProuter-routed classic RFC do not
  provide transport encryption or peer authentication. A configured message
  server is also trusted to choose the backend. Never send credentials or RFC
  traffic across an untrusted network.
- Load passwords from a secret manager or environment injection, never source
  control.
- Do not log request bodies, returned tables, raw frames, captures, destination
  credentials, or backend identity.
- Use a dedicated least-privilege RFC user and network allowlist.
- For the Connectivity SOCKS5 preview, expose one exact virtual host and
  gateway port and enforce function access in `S_RFC`; an opaque TCP mapping
  cannot apply Cloud Connector RFC-resource allowlists. On CF, restrict access
  to Connectivity service bindings and isolate production subaccounts and
  spaces. The Cloud Connector Trusted Applications allowlist is Neo-only.
- Configure finite call, pool-acquisition, pool-lifecycle, and shutdown
  deadlines. Direct connect has a fixed 10,000 ms connector bound, modern
  connection operations have a fixed 45,000 ms bound, and cancellation has no
  separate duration option; do not describe those fixed bounds as user-tunable.
  Connectivity setup applies its bound separately to the TCP proxy connection
  and the subsequent SOCKS5 handshake, so setup can approach twice that
  per-phase bound before the RFC handshake begins.
- Classify authorization or environment failure separately from protocol
  incompatibility.

## Uncertain send

If cancellation or a transport failure occurs after any application-request
byte may have been written, the result is ambiguous. open-rfc retires the
connection and does not replay the call. The application must reconcile state
before deciding whether another call is safe.

## Bounded decoding

NI frames, APPC fragments, CPIC fields, XML cells, graph depth, node counts,
rows, parameter bytes, captures, package archives, and verification files all have
explicit limits. Malformed or oversized input fails without partial output.

## Release authenticity

Use a version only when its GitHub Release, npm metadata, tarball digest,
receipt, and SBOM agree. A source checkout or local tarball is not automatically
a published release.

Public source releases include Apache-2.0 `LICENSE`, the project `NOTICE`, and a
complete `THIRD_PARTY_NOTICES.md`. If those files or the matching release record
are absent, do not infer a public license or permission
to redistribute from a package name or version string alone.
