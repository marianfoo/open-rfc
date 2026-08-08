# Configure a destination

<p class="open-rfc-lead">Start with one direct application server, one dedicated RFC principal, and one read-only function. Validate the route and authorization separately before introducing a pool or business mutation.</p>

## Minimum direct configuration

| Property | Example | Purpose |
|---|---|---|
| `ashost` | `app.example.invalid` | Application-server identity. This is also the gateway host unless `gwhost` is set. |
| `sysnr` | `00` | One- or two-digit system number. It derives gateway service `33NN` when no explicit port is set. |
| `client` | `001` | One- to three-digit SAP client, normalized to three digits. |
| `user` | injected secret | Named RFC principal. |
| `passwd` | injected secret | Productive password for that principal. |
| `lang` | `EN` | Optional SAP or ISO language code. |

```js
const connectionParameters = {
  ashost: process.env.SAP_ASHOST,
  sysnr: process.env.SAP_SYSNR ?? "00",
  client: process.env.SAP_CLIENT,
  user: process.env.SAP_USER,
  passwd: process.env.SAP_PASSWD,
  lang: process.env.SAP_LANG ?? "EN",
};
```

Use `gwserv` or `port` only when the SAP gateway is not reachable at the
derived `33NN` service. `gwhost` changes the TCP gateway endpoint while
`ashost` remains the application-server identity used by CPIC. Do not confuse
the SAP GUI dispatcher port (`32NN`) with the RFC gateway port (`33NN`).

The first beta supports this direct application-server route. Message-server,
SAProuter, Connectivity SOCKS5/TCP, WebSocket RFC, Cloud Connector RFC proxy
and principal propagation, SNC, and X.509 remain outside the supported
contract. See [Connection routes](routes.md).

!!! danger "Classic RFC is not encrypted"
    Password-authenticated classic RFC does not provide transport encryption
    or peer authentication. Use it only on a trusted private network or inside
    a separately managed protected tunnel.

## BTP Connectivity SOCKS5 preview

The direct route can be placed inside a Cloud Connector TCP tunnel with these
additional fields:

| Property | Source and behavior |
|---|---|
| `connectivity_socks5_proxy_host` | Connectivity binding `onpremise_proxy_host`; required with port and token. |
| `connectivity_socks5_proxy_port` | Binding `onpremise_socks5_proxy_port`; do not substitute `onpremise_proxy_rfc_port`. |
| `connectivity_socks5_access_token` | Raw Connectivity OAuth access token without `Bearer `; caller-owned and short-lived. |
| `connectivity_socks5_location_id` | Optional unencoded Cloud Connector location ID. |

Set `gwhost` and `gwserv` to the TCP mapping's virtual host and port. Keep
`ashost` as the actual SAP application-server identity carried by CPIC. Select
exactly one Connectivity service binding, obtain its OAuth token with the
binding client credentials at `<token_service_url>/oauth/token`, cache it only
until shortly before expiry, and
create a new client or pool for the replacement token. Never log the binding,
client secret, token, complete connection object, or inspected route plan.

This preview supports named-user authentication only. It rejects the separate
`connectivity_proxy_*` RFC-proxy route, principal propagation, SAProuter,
message-server, and WebSocket. Cloud Connector cannot inspect a TCP mapping to
apply an RFC resource allowlist, so the dedicated user's exact `S_RFC` role is
the function-level enforcement point.

## Principal and authorization

For the documented first-beta path, use a dedicated, bounded Dialog user with a
productive password and the smallest `S_RFC` allowlist needed by the
application. System and Communication user classes are not part of the
beta support contract. An SAP GUI login does not test RFC compatibility;
validate the gateway, metadata, and application-RFM path through the connector.

Separate these capabilities when the deployment permits it:

- the implicit direct-open `RFCPING` exchange required before a session is
  published;
- the optimized metadata branch through `RFC_METADATA_GET` and
  `RFC_METADATA_GET_TIMESTAMP` when recursive repository lookup is selected;
- the classic flat-metadata branch through `RFC_GET_FUNCTION_INTERFACE` and
  `DDIF_FIELDINFO_GET` for each supported application RFM;
- execution of each exact read-only or business RFM, such as the
  `STFC_CONNECTION` smoke example;
- `RFC_PING` when the application calls `ping()`, enables pooled checkout
  validation, or reuses a reset session, plus `SYSTEM_RESET_RFC_SERVER` when
  it uses stateless calls, explicit context reset, or the corresponding pool
  reuse path;
- `BAPI_TRANSACTION_COMMIT` and `BAPI_TRANSACTION_ROLLBACK` only for an
  application that uses the modern transaction lifecycle; and
- administrative or diagnostic functions, which ordinary application users
  should not receive.

Do not grant `S_RFC` wildcards merely to make initial testing pass. If metadata
lookup is denied, report the authorization failure separately from a protocol
or value-codec failure.

### Build and verify the SAP role

SAP releases and authorization-check settings can check either an exact
function (`RFC_TYPE=FUNC`) or its function group (`RFC_TYPE=FUGR`). Do not guess
the group name from a function name and do not use `*` as a shortcut. On each
target system:

1. In `PFCG`, create a role for this one integration and add authorization
   object `S_RFC` with activity `16` (Execute). Start with the exact function
   names for the selected metadata branch and the exact application RFMs that
   the service calls. Include the transaction functions only if that
   application uses them.
2. In `STAUTHTRACE`, start a trace restricted to the dedicated RFC principal.
   Make one bounded connector attempt that performs metadata lookup and the
   approved application call, then stop the trace.
3. Evaluate the trace and inspect every `S_RFC` check. If the system checks
   `RFC_TYPE=FUGR`, add only the exact `RFC_NAME` group values shown by that
   trace. If it checks `RFC_TYPE=FUNC`, retain only the exact function values.
   Add any separate business authorization object only when the same bounded
   use case demonstrates that it is required.
4. Generate the role profile, assign it to the principal, and run user
   comparison. Repeat the identical bounded attempt under `STAUTHTRACE` and
   confirm that only the intended checks succeed.
5. Repeat this review whenever the application adds an RFM or begins using
   commit/rollback. Keep metadata, application, and transaction entries
   distinguishable in the role documentation.

`SU53` in an administrator's SAP GUI session does not describe a remote RFC
principal's failed request. Use the principal-restricted `STAUTHTRACE` result
from the actual connector attempt, and retain that result only in the system's
protected security workflow.

The repository may fall back from the optimized branch to the classic branch
only when optimized metadata is unavailable or unauthorized. It does not fall
back after a timeout, cancellation, communication failure, or malformed reply.
Authorizing `RFC_METADATA_GET` does not enable a recursive wire serializer:
metadata for a deep graph can be read while invocation still fails closed when
that graph requires a serializer outside the current release boundary.

## Secrets and configuration ownership

- Inject passwords from a platform secret or process environment; never put
  them in `package.json`, source, a destination committed to Git, or logs.
- Keep separate configuration for development, test, and production.
- Validate own data properties only. Avoid getters, merged untrusted objects,
  or both lowercase and uppercase aliases for the same field.
- In CAP, let unchanged `@sap/cds-rfc` and the SAP destination layer resolve
  the final credentials. `open-rfc` owns only validation and RFC transport
  after that handoff.

## Timeouts and capacity

`Client` and call timeouts are in **seconds**. Pool acquisition, lifecycle, and
shutdown deadlines are in **milliseconds**. Configure both layers; a pool
deadline does not bound an RFM already running on a leased client.

Start with a small hard pool capacity and waiter limit. Increase them only
after measuring SAP work-process capacity, application concurrency, call
latency, and shutdown behavior. See [Operations](operations.md) for a rollout
checklist.

## First validation flow

Run these checks in order on a non-production system:

1. Confirm DNS and TCP reachability to the intended gateway without logging
   the endpoint.
2. Open and close one client within the connector's fixed 10,000 ms direct
   connect bound, then configure a finite timeout for calls.
3. Call one authorized, read-only, non-exempt RFM and verify only the expected
   shape.
4. Retrieve metadata for one real application RFM.
5. Round-trip the exact scalar, decimal, binary, structure, and table shapes
   the application will use.
6. Exercise timeout, cancellation, and shutdown, then confirm the old physical
   connection is retired.
7. Only then qualify a bounded pool and the application consumer.

`RFC_PING` is useful for basic liveness, but some SAP configurations exempt its
function group from normal logon or authorization checks. A green ping alone
is therefore not proof that credentials and application authorization are
correct. Use a permitted non-exempt read-only RFM for that proof.
