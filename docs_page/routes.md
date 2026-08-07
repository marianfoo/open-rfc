# Connection routes

<p class="open-rfc-lead">Route selection is explicit. A parameter that changes authentication, transport, serialization, or identity may not disappear during normalization.</p>

| Route | Support in a published 0.x beta |
|---|---|
| Direct application server | Supported for the documented classic RFC/password API and representative one-run paths. Project tests do not yet cover dedicated large-data, disposition, metadata, recovery, principal-isolation, transaction, value, and contention cases on both selected SAP releases. |
| Message server | Unsupported preview. Implemented and tested offline, but unsupported by this release. The classic route is unencrypted and trusts the configured message server to select the application server. |
| SAProuter | Unsupported preview. Implemented and tested offline, but unsupported by this release. Routing alone does not add encryption or peer authentication. |
| Cloud Connector / Connectivity proxy | Unsupported in the first beta. Upgrade, propagated identity, business invocation, and authentication are outside the supported boundary. |
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
