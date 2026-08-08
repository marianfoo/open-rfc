# Connection routes

<p class="open-rfc-lead">Route selection is explicit. A parameter that changes authentication, transport, serialization, or identity may not disappear during normalization.</p>

| Route | Support in a published 0.x beta |
|---|---|
| Direct application server | Supported for the documented classic RFC/password API and representative one-run paths. Project tests do not yet cover dedicated large-data, disposition, metadata, recovery, principal-isolation, transaction, value, and contention cases on both selected SAP releases. |
| Message server | Unsupported preview. Implemented and tested offline, but unsupported by this release. The classic route is unencrypted and trusts the configured message server to select the application server. |
| SAProuter | Unsupported preview. Implemented and tested offline, but unsupported by this release. Routing alone does not add encryption or peer authentication. |
| Cloud Connector TCP/SOCKS5 | Unsupported preview for direct named-user classic RFC. Implemented with an explicit TCP mapping; Cloud Connector cannot enforce RFC function-module resources on this opaque route. |
| Cloud Connector RFC proxy / principal propagation | Unsupported. The RFC-proxy endpoint is a different protocol; upgrade, propagated identity, and RFC-proxy business invocation remain outside the boundary. |
| WebSocket RFC | Unsupported preview. The first beta fails closed before business I/O; WebSocket business invocation is outside the supported boundary. |
| SNC, SSO, X.509 | Unsupported; parameters must be rejected before network I/O. |

## Direct parameters

```js
{
  ashost: "app.example.invalid",
  sysnr: "00",
  client: "001",
  user: process.env.SAP_USER,
  passwd: process.env.SAP_PASSWD,
  lang: "EN"
}
```

Non-Unicode and MDMP partners are outside the current boundary. The Unicode
little-endian path uses SAP code page 4103; a different negotiated partner code
page must be rejected until a matching codec exists.

## Message-server parameters (unsupported preview)

```js
{
  mshost: "message.example.invalid",
  msserv: "3600",
  r3name: "SYS",
  group: "PUBLIC",
  client: "001",
  user: process.env.SAP_USER,
  passwd: process.env.SAP_PASSWD,
  lang: "EN"
}
```

These parameters select the implemented preview route. The connector chooses a
backend from the requested logon group and then opens ordinary classic RFC to
that server. Neither leg supplies transport encryption or peer authentication.
The route is outside this release's beta support. Do not use a successful
preview connection as proof that a deployment is supported; consult the
status page shipped with a later exact version before assuming this changed.

## Cloud Connector TCP/SOCKS5 (unsupported preview)

This route tunnels the existing direct CPIC/NI transport through the BTP
Connectivity service's documented SOCKS5 endpoint. It requires a Cloud
Connector TCP system mapping whose virtual host and port target the on-premise
SAP gateway (`33NN`). It does not use `onpremise_proxy_rfc_port`.

```js
{
  ashost: process.env.SAP_ASHOST,
  gwhost: process.env.CC_VIRTUAL_HOST,
  gwserv: process.env.CC_VIRTUAL_PORT,
  client: process.env.SAP_CLIENT,
  user: process.env.SAP_USER,
  passwd: process.env.SAP_PASSWD,
  connectivity_socks5_proxy_host: process.env.CONNECTIVITY_PROXY_HOST,
  connectivity_socks5_proxy_port: process.env.CONNECTIVITY_SOCKS5_PROXY_PORT,
  connectivity_socks5_access_token: process.env.CONNECTIVITY_ACCESS_TOKEN,
  connectivity_socks5_location_id: process.env.CONNECTIVITY_LOCATION_ID,
}
```

The caller obtains the raw, short-lived access token from the Connectivity
service binding and must recreate the client or pool before it expires. Do not
prefix the token with `Bearer `. Host, SOCKS5 port, and token are required
together; the location ID is optional.

The route rejects RFC-proxy parameters, principal propagation, SAProuter,
message-server, and WebSocket combinations before socket I/O. Because a TCP
mapping is opaque, enforce the exact RFM allowlist with the named user's
`S_RFC` role and restrict which Cloud Foundry applications may use the mapping.
