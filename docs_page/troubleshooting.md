# Troubleshooting

<p class="open-rfc-lead">Start by separating configuration, authorization, transport, protocol, value, and lifecycle failures. Do not enable payload traces as a first response.</p>

## Fast classification

| Symptom | Likely boundary | Safe next check |
|---|---|---|
| DNS lookup failure | Network configuration | Resolve the configured host from the application runtime; do not print credentials. |
| Connection refused | Wrong gateway port or listener down | Confirm `33NN` or the explicit `gwserv`/`port`, not the SAP GUI `32NN` dispatcher port. |
| Connect timeout | Firewall, route, or unreachable gateway | Check the trusted network path and finite connect/lifecycle bounds. |
| `RFC_LOGON_FAILURE` | Client, password, user state, or logon policy | Test a non-exempt read-only RFM with the intended technical principal. |
| `RFC_NO_AUTHORITY` | Authenticated but missing RFM/metadata authorization | Compare the exact `S_RFC` allowlist; do not grant a wildcard. |
| Unknown RFM or missing metadata | Release/fixture mismatch or metadata denial | Verify the RFM is active and remote-enabled, then test metadata separately. |
| Value/type rejection | Metadata or JavaScript representation | Compare casing, direction, length, decimals, and nested shape. |
| Timeout/cancel after send | Ambiguous business outcome | Retire the connection and reconcile; never replay automatically. |

## Connection fails before logon

- Verify DNS, gateway host and port, system number, and network route.
- Check whether the configuration selects the supported direct route.
- Do not remove intended SNC, SSO, X.509, message-server, SAProuter, WebSocket,
  or Connectivity properties merely to force a connection. Select a supported
  connector and topology instead. SNC, SSO, X.509, WebSocket business calls,
  and Connectivity principal propagation fail when the required capability is
  unavailable. Message-server and SAProuter previews may attempt network I/O,
  but remain outside this release's beta support.

For the Connectivity SOCKS5 preview, confirm that the binding value is
`onpremise_socks5_proxy_port`, the token has no `Bearer ` prefix, and `gwhost` /
`gwserv` name an enabled Cloud Connector TCP virtual mapping. The RFC-proxy port
is not a fallback. An authentication rejection is a Connectivity-token problem;
a target rejection means the virtual mapping, Location ID, subaccount/connector
association, or internal target is unavailable. Cloud Connector's Trusted
Applications allowlist is Neo-only and is not a CF troubleshooting control. An
SAP logon failure occurs only after both tunnel stages succeeded.

For a direct route, the default RFC gateway is `33NN`, derived from `sysnr`.
The SAP GUI dispatcher commonly uses `32NN` and is not interchangeable.

## Logon fails

- Check client, user, password injection, and one- or two-letter language.
- Verify the target identity privately before the first application call.
- Do not print credentials or the full backend response.

The supported first-beta path uses a dedicated, bounded Dialog principal with a
productive password. System and Communication user classes are not part of the
beta support contract. Do not use SAP GUI alone as the RFC password
test: an interactive login does not exercise gateway logon, metadata lookup, or
application-RFM authorization. open-rfc does not implement an interactive
password-change flow.

Do not rely on `RFC_PING` alone either. Backend policy can exempt its function
group from the checks that protect application RFMs, so a ping can succeed
while a non-exempt metadata or business call correctly fails.

Distinguish the failure category before changing credentials:

- `RFC_LOGON_FAILURE` means SAP rejected the client, credential, or logon
  policy; and
- `RFC_INVALID_PROTOCOL` means open-rfc rejected an unsupported or malformed
  response format. It retires the connection and does not replay the exchange.

## Metadata exists but invocation fails

An ABAP function can have an interface without being remote-enabled. Confirm
that the function is active, remote-enabled, and allowed by the principal's
exact `S_RFC` authorizations. Metadata lookup can require different repository
function groups from the business RFM; grant only the minimum groups required
by the selected release and application.

Treat an unknown RFM, metadata authorization denial, and a local value-codec
error as separate failures. Do not bypass missing metadata or invent a
descriptor to make a call proceed.

## A value is rejected

- Inspect metadata type, declared byte or character length, decimals, and
  parameter direction.
- Use decimal strings for BCD/DECF and an explicit INT8 mode where compatibility
  requires it.
- Deep values require a serializer policy supported by the exact release;
  basXML is not implemented.

Fixed CHAR/NUMC/DATE/TIME values are never silently truncated. BCD and DECF
outputs preserve precision as strings by default. If an INT8 can exceed
JavaScript's safe integer range, choose `"bigint"` or `"string"` projection
instead of coercing it to `number`. Parameter names and casing come from the
function metadata, normally uppercase.

## Cancellation or timeout

The original connection is retired. If any request byte may have been sent,
treat the outcome as uncertain and do not automatically retry a mutating RFM.

If the compatibility client replaces a retired physical generation, that does
not make the failed business call safe to replay. Reconcile its outcome first.

## Reset keeps the same public handle

That is expected after a successful `resetServerContext()`: the reset clears
backend function-pool/session state on the synchronized RFC session and then
checks that session. It is not cancellation or reconnect. If reset fails, the
generation follows the fatal/uncertain policy and may be replaced or closed.

## CAP still resolves the native connector

Keep `@sap/cds-rfc` unchanged, declare `open-rfc` directly, and use the nested
npm 11 `$open-rfc` override from the [CAP guide](cap.md). Then run:

```sh
npm explain @sap-rfc/node-rfc-library
npm ls @sap/cds-rfc open-rfc
```

If the old connector remains, remove stale installation state and regenerate
the committed lockfile with npm 11. Do not publish or install a project-owned
CAP package or a package under an SAP-controlled scope.

## Safe diagnostics

Start with the public error group/code, connection disposition, and a synthetic
value shape. Do not enable payload tracing as a first response. Never attach an
`.env` file, infrastructure inventory, CAP environment dump, SDK/RFC trace,
packet capture, returned table, or backend identity to a public report.

## Reporting a bug

Provide the open-rfc version, Node.js version, sanitized error code/category,
route kind, SAP release family, and a minimal synthetic metadata/value shape.
Never attach credentials, traces, business rows, captures, or system
identifiers to a public issue.
