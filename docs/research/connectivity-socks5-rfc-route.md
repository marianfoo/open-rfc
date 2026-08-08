# Research: classic RFC through BTP Connectivity SOCKS5

## Question

Can an ARC-1 extension deployed to SAP BTP Cloud Foundry use `open-rfc` to
call an on-premise S/4HANA 2023 application server through SAP Cloud
Connector, without the SAP NW RFC SDK?

## Conclusion

Yes, for the password-authenticated direct application-server route, as an
unsupported preview. The viable path is:

```text
ARC-1 extension
  -> BTP Connectivity service SOCKS5 endpoint
  -> Cloud Connector TCP system mapping
  -> SAP gateway (33NN)
  -> classic RFC session
```

This is not SAP's Connectivity RFC-proxy endpoint. The two endpoints use
different ports and protocols. Treating `onpremise_proxy_rfc_port` as a
SOCKS5 endpoint is incorrect, even when both values came from the same service
binding.

## Primary-source protocol contract

SAP documents a dedicated SOCKS5 endpoint for arbitrary TCP applications:

- the service binding supplies `onpremise_proxy_host` and
  `onpremise_socks5_proxy_port`;
- authentication method `0x80` is mandatory;
- its authentication payload contains the raw Connectivity access token and,
  optionally, a base64-encoded Cloud Connector location ID; and
- a standard SOCKS5 `CONNECT` request follows successful authentication.

The token is obtained from the Connectivity service's OAuth token endpoint by
using the binding's client credentials. Current bindings provide the OAuth
service base as `token_service_url`; the client-credentials request is sent to
`<token_service_url>/oauth/token`. A live binding whose base path was `/`
confirmed that using `token_service_url` itself returns the wrong endpoint.

References:

- [Using TCP Protocol for Cloud Applications](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/using-tcp-protocol-for-cloud-applications)
- [Consuming the Connectivity Service](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/313b215066a8400db461b311e01bd99b.html)
- [Configure Access Control (TCP)](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/configure-access-control-tcp)

## Cloud Connector boundary

Cloud Connector needs an explicit TCP system mapping whose virtual host and
port are used in the SOCKS5 `CONNECT` request. For the direct RFC route the
mapping's internal target is the application server's gateway service, normally
`33NN`.

`ashost` still names the SAP application server used by CPIC. `gwhost` and
`gwserv` select the TCP endpoint. A Cloud Connector virtual host can therefore
be supplied as `gwhost` without pretending that it is the SAP application
server identity.

TCP mappings are intentionally coarse. Cloud Connector cannot inspect the
classic RFC payload and cannot enforce the function-level resource allowlist
available to its RFC protocol mapping. The Cloud Foundry application and the
named SAP principal are consequently part of the security boundary. The
principal must have a minimal `S_RFC` role, and the application should be
restricted through Cloud Connector's application allowlist where available.

## Public-package gap

`open-rfc@0.2.2` contains route planning for the separate Connectivity RFC
proxy but deliberately rejects that capability. It does not contain the
SOCKS5 transport described in the changelog, and its classic `Client` snapshot
currently drops Connectivity parameters before planning. That creates two
different failure modes:

- the modern client fails closed for the unsupported RFC-proxy route; and
- the classic client can silently fall back to a direct connection.

The latter is hazardous because a caller can believe a private tunnel was
selected when the route-changing values were discarded.

## Same-project implementation lineage

The project's private development history contains a bounded Connectivity
SOCKS5 tunnel and an NI transport adapter, introduced in commit `a95c253` and
subsequently hardened. The supporting public NI and direct-CPIC interfaces are
byte-compatible with the current public repository. Reusing that same-project
implementation preserves its limits, cancellation behavior, secret redaction,
and wire-level tests while making the provenance explicit.

No vendor binary, network capture, credential, customer data, or third-party
source is copied.

## API boundary

The new route uses distinct parameters so it cannot be confused with the RFC
proxy:

| Parameter | Meaning |
|---|---|
| `connectivity_socks5_proxy_host` | `onpremise_proxy_host` from the Connectivity binding |
| `connectivity_socks5_proxy_port` | `onpremise_socks5_proxy_port` from the binding |
| `connectivity_socks5_access_token` | raw, short-lived Connectivity OAuth access token |
| `connectivity_socks5_location_id` | optional Cloud Connector location ID |

Host, port, and token are an all-or-nothing route selection. A location ID
without that route is invalid. The token is caller-owned because open-rfc does
not own BTP service discovery or OAuth client credentials. A client or pool
must be recreated before the token expires.

The route is limited to direct, named-user classic RFC. It must reject
combinations with:

- Connectivity RFC-proxy parameters;
- principal propagation;
- SAProuter;
- message-server routing; and
- WebSocket RFC.

## Live qualification target

The acceptance test is a deployed ARC-1 extension in Cloud Foundry that:

1. reads exactly one Connectivity service binding;
2. obtains and caches a Connectivity token only until shortly before expiry;
3. passes the SOCKS5 route values to open-rfc without logging them;
4. reaches an S/4HANA 2023 gateway through a Cloud Connector TCP mapping; and
5. invokes one bounded, read-only RFC such as `RFC_SYSTEM_INFO` with a dedicated
   named user.

Principal propagation is a separate protocol and identity project. It is not a
fallback or implicit next step for this route.

## Live result

Qualified on 2026-08-08 with the sample ARC-1 extension deployed as a
disposable Cloud Foundry application and bound to the Connectivity service. A
Cloud Foundry task loaded the extension and completed `RFC_SYSTEM_INFO` against
the S/4HANA 2023 system through the Connectivity SOCKS5 endpoint and the Cloud
Connector TCP mapping in 2.789 seconds. The task exited successfully and only
the extension's allowlisted result fields were returned.

The first qualification attempt also proved the OAuth endpoint distinction:
posting to the service base failed, while appending `/oauth/token` returned a
valid token. The disposable application was deleted after the test so its
environment no longer retains the SAP or service-binding credentials. The TCP
mapping was intentionally retained as deployment configuration.
