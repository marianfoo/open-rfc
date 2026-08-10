# Plan: enable classic RFC through BTP Connectivity SOCKS5

Research: [`docs/research/connectivity-socks5-rfc-route.md`](../research/connectivity-socks5-rfc-route.md)

## Goal

An ARC-1 extension deployed to BTP Cloud Foundry can make a named-user classic
RFC call to an on-premise S/4HANA 2023 system through the bound Connectivity
service and Cloud Connector.

The change remains an unsupported preview. It does not claim RFC-proxy or
principal-propagation support.

## Reviewed design

1. Add a separate `ConnectivitySocks5Plan` to route normalization. Require the
   proxy host, SOCKS5 port, and raw access token together; allow an optional
   location ID.
2. Add a `connectivity-socks5-tcp` provider capability. Do not reuse or imply
   the existing `connectivity-rfc-proxy` capability.
3. Install the same-project bounded SOCKS5 tunnel beneath the direct CPIC
   transport. Its target comes from normalized `gwhost`/`gwserv`, while its
   proxy address and authentication material come from the new plan.
4. Wire the route into the modern and classic direct providers. Reject it for
   message-server, SAProuter, WebSocket, RFC-proxy, and propagated-identity
   combinations before opening a socket.
5. Add both new and existing Connectivity parameters to the classic immutable
   connection snapshot. Existing RFC-proxy values must reach planning and fail
   closed instead of disappearing into a direct route.
6. Keep BTP binding selection and OAuth client-credentials token acquisition in
   the ARC-1 extension. Open-rfc accepts a token but never owns, refreshes, or
   logs the binding credentials.

## Alternatives rejected during review

### Point RFC-proxy parameters at the SOCKS5 port

Rejected. SAP publishes different wire protocols and binding properties for
the RFC and SOCKS5 endpoints. Port substitution is not protocol support.

### Add OAuth and `VCAP_SERVICES` parsing to open-rfc

Rejected. It would couple the transport core to Cloud Foundry service discovery,
retain a long-lived client secret, complicate pool-generation ownership, and
make the same route harder to use outside Cloud Foundry.

### Preserve the classic client's ignored Connectivity parameters

Rejected. Silent direct fallback violates the repository rule that a value
which changes routing or identity may not disappear during normalization.

### Advertise the route as supported

Rejected. One system-level spike proves the intended topology but not the
release matrix, long-running token rotation, fault variance, or operational
soak required for a support claim.

## Test plan

### Protocol and resource tests

- authenticate with SOCKS method `0x80` and the exact bounded token/location
  frame;
- encode IPv4 and domain-name `CONNECT` targets without local DNS resolution;
- reject unsupported address types, malformed replies, oversized fields, and
  invalid ports;
- redact tokens from inspection and every diagnostic;
- bound connect/authentication/handshake buffers and timeouts;
- propagate abort and close every socket on failure or cancellation; and
- adopt only a successfully connected, paused NI socket.

### Route and compatibility contracts

- accept the complete SOCKS5 tuple on a direct named-user route;
- reject every partial tuple and a standalone location ID;
- reject combinations with RFC proxy, principal propagation, message server,
  SAProuter, and WebSocket;
- prove the modern client advertises the capability only when a transport
  factory is installed;
- prove the classic client routes through that factory;
- prove existing `connectivity_proxy_*` parameters now fail before network I/O
  rather than falling back to direct; and
- keep low-level tunnel modules out of the package root export.

### Regression and package checks

- run focused route, provider, compatibility, tunnel, and NI tests;
- build and run the full public suite;
- validate documentation and generated API snapshots;
- lint the repository;
- validate the exact public-license-preflight package shape; and
- inspect the packed archive for credentials, private material, and accidental
  new exports.

### Live CF qualification

- create a dedicated Cloud Connector TCP mapping to the 2023 gateway;
- deploy a disposable ARC-1 extension build with a Connectivity service
  binding;
- retrieve the token inside the application and make `RFC_SYSTEM_INFO` through
  the SOCKS5 route;
- record only redacted success evidence; and
- remove the disposable CF application after the check, retaining a mapping
  only if it is intentionally part of the deployment configuration.

## Test-plan review

The protocol tests alone cannot prove Cloud Connector interoperability, while a
green live call alone cannot prove malformed-input, cancellation, or redaction
behavior. Both layers are therefore required. The live RFM is deliberately
read-only and non-mutating. A successful `RFC_PING` is insufficient because it
does not qualify metadata lookup or ordinary application authorization.

The most important negative regression is the classic-client direct fallback:
it must be observed to fail before any socket is opened. The most important
secret regression is not only that errors omit the token, but that object
inspection does as well.

## Documentation and release

Update the route, configuration, security, support, README, and changelog text.
Use a signed `feat:` commit. The pull request must explicitly identify this as
an unsupported preview and distinguish it from SAP Connectivity RFC proxy and
principal propagation.

## Out of scope

- SAP Connectivity RFC-proxy wire support;
- principal propagation, X.509, SNC, SSO, or token exchange with the ABAP
  system;
- message-server load balancing through the SOCKS5 route;
- automatic OAuth token refresh inside open-rfc; and
- a general-purpose SOCKS proxy API.

## Outcome

Implemented as designed. The protocol, route, classic-compatibility, modern
client, documentation, API-snapshot, and package-shape checks pass. The live CF
qualification completed the intended ARC-1 -> Connectivity SOCKS5 -> Cloud
Connector TCP -> S/4HANA 2023 RFC path. It also corrected one planning detail:
the extension must request a token from `<token_service_url>/oauth/token`, not
from the binding's service base URL itself.

The disposable qualification app was removed. The dedicated TCP mapping was
retained intentionally for the target deployment, and the support status
remains an unsupported preview pending broader interoperability and soak
testing.
