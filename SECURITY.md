# Security policy

`open-rfc` 0.x is beta software with no production SLA. Direct,
message-server-selected, and SAProuter-routed classic RFC do not provide SNC or
transport encryption; SAProuter is routing, not confidentiality or peer
authentication, and the message-server preview trusts the configured message
server to select a backend. Those two preview routes, WebSocket RFC invocation,
and Cloud Connector principal propagation are not supported by the beta
contract. Do not send credentials or classic RFC traffic across an untrusted
network.

The implemented BTP Connectivity SOCKS5/TCP preview is also outside the beta
support contract. It uses a Cloud Connector TCP mapping, not the separate RFC
proxy. TCP mappings are opaque to Cloud Connector and therefore cannot apply
its RFC function-module resource allowlist. Restrict the mapping to trusted
applications and enforce exact function access with a dedicated named user's
least-privilege `S_RFC` role. Treat the Connectivity access token, location ID,
service-binding client secret, and complete connection object as credentials.

## Supported versions

Only an exact version published in both a matching GitHub Release and npm
package record is a public release. Development checkouts, locally packed
tarballs, and unmatched artifacts are unsupported. Security fixes target the
current published 0.x line on a best-effort basis; pre-1.0 fixes may require
upgrading to a newer exact version.

| Version | Security fixes |
|---|---|
| current published 0.x release | best effort |
| superseded 0.x release | only when explicitly named in a security advisory |
| development checkout, local tarball, or unlisted build | no |

## Reporting a vulnerability

Use a private GitHub security advisory for the repository or email
`marian@zeis.de`. Do not open a public issue containing credentials,
hostnames, traces, packet captures, business data, or details that identify a
live SAP system.

We aim to acknowledge a complete report within three business days. We will
coordinate a disclosure date after validation and remediation, normally within
90 days. A shorter or longer embargo may be necessary when SAP, an affected
downstream project, or infrastructure owner must participate. No CVE assignment
is promised; the maintainer will request or coordinate one when the validated
issue and publication state make a CVE appropriate.

Include the affected commit or artifact digest, a minimal synthetic
reproduction, impact, and whether any live SAP system was involved. Never send
credentials, raw RFC captures, session material, business payloads, or private
system identities in the initial report.

## Test-data policy

- Use an isolated, explicitly approved test system and read-only calls by
  default.
- Provide connection parameters through environment variables or an external
  secret store.
- Never commit `.env` files, `sapnwrfc.ini`, infrastructure inventories, SDK
  archives, SDK binaries, RFC traces, packet captures, or generated logs.
- Treat raw RFC logon traffic as credential material even when the password is
  not visible as plain text.
- Synthetic protocol fixtures are acceptable; captures must be structurally
  scrubbed and reviewed before becoming fixtures.

The ignore rules provide a safety net, not a substitute for reviewing the
exact staged diff before every push.
