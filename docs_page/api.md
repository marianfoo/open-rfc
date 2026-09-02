# API reference

<p class="open-rfc-lead">The public façades share one SDK-free RFC core, but their lifecycle and value shapes are intentionally different.</p>

Import the APIs below from `open-rfc`. Connection parameters and RFC names are
captured before asynchronous work begins. Use plain objects with own data
properties; unknown, duplicate, accessor-backed, and unsupported semantic
fields are rejected before network I/O.

The only public subpaths are `open-rfc` and `open-rfc/package.json`. Use the
metadata subpath to verify the installed exact version; protocol, transport,
serializer, metadata, and value implementation files are internal and may not
be imported by consumers.

## Classic `Client`

`Client` is the Promise/callback-compatible `node-rfc` replacement surface.
Omitting a callback selects the Promise form; supplying one makes the method
return `void`.

The metadata return types are inferred from the public methods rather than
exported as additional root names in this beta. TypeScript consumers can name
them without importing an internal subpath:

```ts
type FunctionInterface = Awaited<
  ReturnType<Client["getFunctionInterface"]>
>;
type StructureDefinition = Awaited<
  ReturnType<Client["getStructureDefinition"]>
>;
```

```ts
new Client(connectionParameters, clientOptions?)

client.open(callback?): Promise<Client> | void
client.connect(callback?): Promise<Client> | void // alias of open()
client.call(functionName, input, options?): Promise<RfcObject>
client.invoke(functionName, input, callback, options?): void
client.ping(callback?): Promise<boolean> | void
client.cancel(callback?): Promise<void> | void
client.resetServerContext(callback?): Promise<void> | void
client.close(callback?): Promise<void> | void
client.release(callback?): Promise<void> | void
client.getFunctionInterface(functionName): Promise<FunctionInterface>
client.getStructureDefinition(structureName): Promise<StructureDefinition>
```

A standalone client must be opened and closed by its caller. A client returned
by `Pool.acquire()` is already open: return it with `client.release()` or
`pool.release(client)` and do not call `open()` or `close()` on it.

Useful read-only properties include `alive`, `connectionHandle`, `pool_id`,
`config`, and `connectionInfo`. Read-only does not mean redacted: `config`
retains the connection snapshot, which can include credentials, while
`connectionInfo` contains route and user identity when open and is an `Error`
value while closed. Treat both as sensitive. Never log, serialize, attach, or
return them from a diagnostics endpoint.

### Client and call options

| Option | Meaning |
|---|---|
| `clientOptions.timeout` | Default call timeout in **seconds**. Must be finite and greater than zero. If omitted, the classic facade installs no per-call timer; set a finite value for deployed use. |
| `callOptions.timeout` | Per-call timeout in **seconds**; overrides the client default. Its clock includes time waiting behind an earlier serialized client operation. |
| `callOptions.notRequested` | Unique non-empty output parameter names that SAP should not return. This changes backend `IS REQUESTED` behavior; it is not only local filtering. |
| `clientOptions.bcd` | BCD/DECF output projection: `"string"` (default), `"number"`, or a converter function receiving canonical decimal text. |
| `clientOptions.int8Mode` | INT8 output projection: `"number"` (compatibility default), `"bigint"`, or `"string"`. Unsafe number values are rejected. |
| `clientOptions.stateless` | When `true`, reset server context after each call before reusing the session. |
| `clientOptions.logLevel` | Accepted non-negative compatibility log level. |
| `clientOptions.diagnostics` | Optional bounded structured diagnostic emitter. Never emit RFC inputs, outputs, or credentials from application wrappers. |
| `clientOptions.recursiveSerializerPolicy` | Advanced open-rfc extension for recursive (nested table or structure) sends. Shape: `{ profile, observation: { defaultSerializer, basxmlDisabledSerializer } }`, where `profile` is `"abap-7.50"` or `"abap-7.58"`, `defaultSerializer` is `"classic-xrfc"`, `"basxml"` or `"unsupported"`, and `basxmlDisabledSerializer` is `"classic-xrfc"` or `"unsupported"`. General beta consumers must omit it unless the exact artifact's published support record supports the selected partner and value graph; omitted recursive sends fail closed. |
| `clientOptions.callbacks` | Preview handlers for server-initiated `DESTINATION 'BACK'` calls, keyed by exact RFM name. A handler receives owned raw classic-RFC values plus `{ callbackIndex, signal }` and must synchronously return `{ exports?, tables? }` or `{ exception }`. Returned parameter names must be present in `request.requestedOutputs`. Unknown callback RFMs receive `FU_NOT_FOUND`; malformed, unconfigured, asynchronous, or excessive callback activity fails closed. |

`cancel()` signals active calls and resolves after signaling; await the original
call promise or callback for its terminal outcome. A timeout or cancellation is
not permission to replay the RFM; see
[Safety and support limits](safety.md#uncertain-send).

The first beta does not provide a general user procedure for enabling a
recursive serializer policy. Direct observation alone is not enough. Do not
copy a policy from another SAP release, function, or value graph. Unless the
exact release support record explicitly supports your
graph, omit the option and keep the fail-closed result.

Callback handlers execute while the outer call owns its physical session. Do
not call the same client or await work from a handler. Interpret and construct
raw parameter bytes using the callback RFM's exact ABAP metadata; this preview
does not project callback values into normal JavaScript RFC objects. Each xRFC
input includes its canonical `name`, raw XML `value`, and source `chunkCount`.
At most 64 callbacks are serviced during one outer call. Callback request and
response bytes must not be logged.

```ts
const client = new Client(connectionParameters, {
  callbacks: {
    STFC_CONNECTION(request) {
      const input = request.imports.find(({ name }) => name === "REQUTEXT");
      return input === undefined
        ? {}
        : { exports: [{ name: "ECHOTEXT", value: input.value }] };
    },
  },
});
```

## Connection parameters

Use either lowercase keys or their uppercase forms, not both. The supported
first-beta direct route uses password authentication. Its MYSAPSSO2 preview
requires `user` with `mysapsso2` instead of `passwd`; the two credentials cannot
be combined. The message-server fields below document an unsupported
preview and do not make that route supported. Connectivity principal
propagation, SNC, and WebSocket business invocation are not implied by accepting
similarly named configuration elsewhere; unsupported provider capabilities fail
closed.

### Direct application server

| Field | Requirement and behavior |
|---|---|
| `ashost` | Required application-server name. It is also the gateway host unless `gwhost` is supplied. |
| `client` | Required SAP client; one to three digits, normalized to three. |
| `user`, `passwd` | Live-qualified beta credential pair; both are required together when password authentication is selected. |
| `user`, `mysapsso2` | Preview alternative; both are required together and `passwd` must be absent. The bounded ticket text may be percent-escaped or use SAP's cookie `!` substitution for `/`; it is snapshotted and hidden from JSON/inspection. |
| `sysnr` | Optional one- or two-digit system number; defaults to `"00"`. |
| `gwhost` | Optional gateway TCP host while `ashost` remains the CPIC application-server identity. |
| `gwserv` / `port` | Optional gateway service or TCP port. Default is `33NN` from `sysnr`; `gwserv` also accepts `sapgwNN`. |
| `lang` | Optional uppercase SAP one-character code or ISO language code; defaults to SAP language `E`. |
| `cpic_streaming` | Optional `"disabled"` (default) or explicitly enabled `"enabled"`. |
| `saprouter` | Implemented preview. The scoped first beta does not support this route even when the syntax validates and a connection succeeds. |

### BTP Connectivity SOCKS5 (unsupported preview)

| Field | Requirement and behavior |
|---|---|
| `connectivity_socks5_proxy_host` | Required with port and token; use the binding's `onpremise_proxy_host`. |
| `connectivity_socks5_proxy_port` | Required with host and token; use `onpremise_socks5_proxy_port`, not the RFC-proxy port. |
| `connectivity_socks5_access_token` | Required raw Connectivity access token without a `Bearer ` prefix. It is snapshotted and hidden from JSON/inspection. |
| `connectivity_socks5_location_id` | Optional unencoded Cloud Connector location ID. |

These fields select only a direct explicit-user route. The caller owns OAuth token
acquisition and refresh. The low-level SOCKS5 transport is internal and is not
exported from the package root.

`cpic_streaming: "enabled"` is an advanced, target-specific opt-in, not a
workaround for a rejected large request. The default `"disabled"` path is the
public starting point. Use `"enabled"` only when the exact release record and
target documentation explicitly support streaming for the selected partner;
otherwise keep it disabled and use compact requests.

### Message server (unsupported preview)

| Field | Requirement and behavior |
|---|---|
| `mshost` | Required message-server host. |
| `r3name` / `sysid` | One is required and must be a three-character SAP system ID; `r3name` takes precedence. |
| `group` | Required message-server logon group. |
| `client` | Required SAP client. |
| `user`, `passwd` | Required together for password logon to the selected application server. |
| `user`, `mysapsso2` | Preview alternative ticket logon; `passwd` must be absent. |
| `msserv` | Optional TCP service or port. Without it, the resolver uses `sapms<SID>`. |
| `lang` | Optional uppercase SAP one-character code or ISO language code; defaults to SAP language `E`. |

The message-server route is implemented and tested offline, but it is not
supported by this release. It leaves both legs unencrypted and trusts the
configured message server to choose the backend. Read
[Connection routes](routes.md) before deployment and follow the network and
credential rules in [Safety and support limits](safety.md).

## `Pool`

TypeScript consumers can name the inferred monitor shape without importing an
internal destination type:

```ts
type PoolMonitor = ReturnType<Pool["monitor"]>;

new Pool({ connectionParameters, clientOptions?, poolOptions?, resourceOptions? })

pool.ready(count?): Promise<void>
pool.acquire(count?): Promise<Client | Client[]>
pool.release(clientOrClients): Promise<void>
pool.cancel(client): Promise<void>
pool.closeAll(): Promise<void>
pool.monitor(): PoolMonitor
```

Every lifecycle method also supports the archived callback overload. A single
`pool.cancel(client)` signals that client's active calls; await the original
call and then release the client through the pool after it settles.
`acquire()` returns one `Client`; `acquire(n)` returns an array. Acquired clients
must be returned exactly once. Release waits for queued work, resets a reusable
session, and otherwise evicts it.

| Pool option | Default | Meaning |
|---|---|---|
| `poolOptions.low` | `2` | Opportunistic minimum number of idle application sessions. |
| `poolOptions.high` | `4` | Maximum idle sessions retained after release; this is **not** the hard connection cap. |
| `poolOptions.logLevel` | unset | Accepted non-negative compatibility log level. |
| `resourceOptions.maxConnections` | `32` | Hard application-session capacity. `low`, `high`, and explicit `ready(n)` / `acquire(n)` must not exceed it. |
| `resourceOptions.maxWaiters` | `128` | Hard bound on queued acquisition waiters. |
| `resourceOptions.acquireTimeoutMs` | `30000` | Pool acquisition deadline in **milliseconds**. |
| `resourceOptions.lifecycleTimeoutMs` | `45000` | Create, validate, reset, and release-operation bound in **milliseconds**. |
| `resourceOptions.shutdownTimeoutMs` | `60000` | Shutdown convergence bound in **milliseconds**. |
| `resourceOptions.validateOnCheckout` | `false` | Ping a session before handing it to the caller. |

Pool deadlines do not replace `clientOptions.timeout`; configure a finite call
timeout separately. `closeAll()` closes admission, cancels leased work, and
retires physical resources. Do not continue using wrappers acquired before
shutdown.

`Pool.config`, `Pool.connectionParameters`, and `Pool.poolConfiguration` are
also read-only snapshots, not redacted views. They can retain connection or
credential material and must not be logged, serialized, attached to reports,
or exposed through monitoring endpoints. Use `pool.monitor()` for bounded
capacity and lifecycle observations.

## Modern `RFCClient` and `RFCConnection`

This is the `@sap-rfc/node-rfc-library`-compatible surface used by the CAP
connector projection.

```ts
new RFCClient(logger?, configuration?)

rfcClient.open(connectionParameters, signal?): Promise<RFCConnection>

connection.execute(
  functionName,
  { import?, changing?, table? } = {},
  enableValidation = true,
  excludeParamsFromOutput = [],
): Promise<RfcObject>
connection.ping(): Promise<boolean>
connection.getMetadata(functionName): Promise<ModernRfcMetadata>
connection.commit(): Promise<void>
connection.rollback(): Promise<void>
connection.close(): Promise<void>
```

`open()` accepts an optional `AbortSignal`. The modern façade currently uses a
fixed 45,000 ms transaction-operation bound and has no per-`execute()` timeout
argument. A detached `Promise.race()` does not cancel RFC work; `close()` is the
supported way to abort and join active connection operations.

`RFCConnection.alive` is true only while the connection is open.
`connectionInfo` returns an `Error` value after close and otherwise contains
operationally sensitive route and user identity. The optional constructor
logger has a `log(type, ...args)` method; open-rfc sends it only fixed lifecycle
messages. `RFCClient` configuration accepts the same advanced
`recursiveSerializerPolicy` and raw synchronous `callbacks` preview described
for `Client` above.

`execute()` accepts direction-specific `import`, `changing`, and `table`
buckets. A parameter may appear in only one bucket. Validation is enabled by
default. `excludeParamsFromOutput` marks those parameters not requested at SAP
and omits them from the returned object.

`ping()` sends `RFC_PING` over the same pinned conversation. Use it only while
the connection is idle; it rejects while an `execute()` is active, because one
RFC conversation carries only one call at a time.

### Transaction state rules

1. `open()` creates the connection and pins its first transaction cycle.
2. Sequential `execute()` calls share that LUW until `commit()` or `rollback()`.
3. Only one `execute()` may be active. `execute()`, `commit()`, and `rollback()`
   reject incompatible concurrent operations.
4. A successful `commit()` or `rollback()` ends the cycle; the next
   `execute()` starts a new cycle on demand.
5. `close()` is idempotent. It rolls back an unfinished stable cycle, cancels
   active work, and evicts an ambiguous generation rather than replaying it.
6. A rejected or ambiguous terminal transaction makes `connection.alive`
   false. Call `close()` for bounded cleanup and open a new connection only
   after reconciling the business outcome.

See [the standalone modern lifecycle example](standalone.md#modern-lifecycle)
for cleanup that preserves both primary and rollback/close failures.

## Metadata methods

| Method | Result |
|---|---|
| `Client.getFunctionInterface(name)` | Classic function identity, parameter descriptors, declared exceptions, update-task flag, and remote serializer flags. |
| `Client.getStructureDefinition(name)` | Classic structure byte length and ordered field descriptors. This is an explicit legacy metadata method, not a promise that every backend permits that RFM. |
| `RFCConnection.getMetadata(name)` | Modern `{ rfcName, import, export, changing, table }` projection. Recursive metadata is used when available; only unavailable/authorization outcomes may fall back to the flat path. |

Metadata methods require an open client/connection and are subject to the same
cancellation, bounds, isolation, and fatal-generation rules as business calls.
Returned names and casing are authoritative for later input.

## Utilities and compatibility exports

`RFCUtility.convertAbapTypeToJavaScriptType()` implements the modern connector
type projection used by `@sap/cds-rfc`; invalid utility input can produce the
exported `RFCUtilityError`. `languageIsoToSap()` and
`languageSapToIso()` convert between supported ISO and SAP language forms.
`cancelClient(client)` is the compatibility helper for canceling an active
classic client, while `environment` exposes fixed compatibility metadata rather
than native SDK state.

The exported `RFCErrorCode` and `NodeRFCLibraryErrorCode` values provide the
stable classic and modern error-code vocabularies used by their corresponding
error objects. The exported `RFC_RC`, `RFC_UNIT_STATE`, `RfcParameterDirection`,
`RfcLoggingClass`, `RfcLoggingLevel`, `EnumTrace`, and `EnumSncQop` values exist
for source compatibility. An exported enum name does not claim that its native
SDK feature is implemented. In particular, SNC remains unsupported and must
fail before I/O.

## Structured diagnostics

`RfcDiagnosticDispatcher` accepts a sink, a default or per-category level, and
a bounded `maxQueued`. Its `emit()` path snapshots only the fixed event schema;
sink callbacks run later and serially. Use `monitor()` to observe accepted,
filtered, dropped, delivered, and sink-failure counts, `flush()` to join queued
events, and `close()` to flush and close the sink.

`createBoundedRolloverDiagnosticSink()` writes bounded JSON Lines files. The
parent directory must already exist. Files are owner-only, symbolic links are
rejected, the default limit is 1 MiB with three total files, and an individual
event is capped at 2 KiB. Accepted diagnostic inputs can include only category,
level, code, correlation ID, lifecycle state/phase/disposition, duration, and
count. Delivered events add the fixed `schemaVersion`, `sequence`, and
`timestamp` envelope fields. Neither form has a payload, credential, endpoint,
backend-text, or raw-cause field.

The root also exports the frozen diagnostic vocabularies
`RFC_DIAGNOSTIC_CATEGORIES`, `RFC_DIAGNOSTIC_CODES`,
`RFC_DIAGNOSTIC_DISPOSITIONS`, `RFC_DIAGNOSTIC_LEVELS`,
`RFC_DIAGNOSTIC_PHASES`, and `RFC_DIAGNOSTIC_STATES`. Use these values when
validating configuration or routing events; do not infer additional event
fields or provider capabilities from them.

See [Operations](operations.md#structured-diagnostics) for a wiring fragment
and shutdown guidance.

## ABAP values

RFC input and output keys use the exact names and casing declared by metadata.
ABAP parameter names are normally uppercase; pass `REQUTEXT`, not `requtext`,
unless metadata says otherwise.

| ABAP family | JavaScript representation |
|---|---|
| CHAR | `string`; input is width-checked and space-padded, output trailing padding is trimmed. |
| NUMC | Digit-only `string`; input is width-checked and left-zero-padded. |
| DATE, TIME | Canonical digit strings; an initial ABAP value is `""`. |
| STRING | `string`. |
| BYTE, XSTRING | `Uint8Array` / `Buffer`. Inbound xRFC XSTRING accepts canonical Base64 with SAP MIME-style CR/LF wrapping; spaces and other non-canonical text remain invalid. |
| INT1, INT2, INT4 | `number`. |
| INT8 | Modern API: `bigint`. Classic API: safe `number` by default, or explicit bigint/string mode. |
| BCD/PACKED, DECF16/34 | Precision-preserving decimal `string` by default; classic callers may select number or a converter. |
| Structures and tables | Plain data objects and arrays validated against bounded metadata. |

## Errors and connection disposition

`RFCError` exposes `group`, `code`, `codeString`, and `key`; `ABAPError`
extends it with ABAP message fields. Prefer `RFCError.isRFCError(value)` and
`RFCError.isABAPError(value)` when ESM and CommonJS copies may coexist.
`NodeRfcError` represents classic local lifecycle failures.
`NodeRFCLibraryError` represents modern validation and transaction-lifecycle
failures. Cleanup failures may be preserved in an `AggregateError`.

| Outcome | Public error shape | Connection consequence |
|---|---|---|
| Local input, option, or state rejection before send | `TypeError`, `RangeError`, `NodeRfcError`, or invalid-parameter façade error | Existing open generation is unchanged; correct the request. |
| Declared ABAP exception | `ABAPError` with `RFC_ABAP_EXCEPTION` | Same generation is reusable after the complete reply; a stateless client resets its context before surfacing the exception. |
| Caller BCD converter throws after reply decoding | Original converter error | Reply is consumed; same generation remains reusable, after the configured stateless reset when applicable. |
| ABAP runtime/system failure or MESSAGE A/E/X | `ABAPError` | Old physical generation is retired. The classic façade may replace it and remain `alive`, but the failed call is never replayed. |
| Timeout, cancellation, communication, malformed protocol, or uncertain send | Usually `RFCError` | Old generation is retired or quarantined. A replacement does not make replay safe. |
| Logon/open failure | `RFCError` | No authenticated connection is published. |
| Modern commit/rollback rejection or ambiguous transaction failure | `NodeRFCLibraryError`, `RFCError`, or `AggregateError` | Transaction is terminal and the modern connection becomes failed; reconcile, close, and create a new connection. |

Never decide retry safety from `client.alive` alone. See
[Troubleshooting](troubleshooting.md) for recovery guidance and
[Safety and support limits](safety.md#uncertain-send) for the no-replay rule.
If a required stateless reset fails after a complete reply, the call rejects
with an `AggregateError` containing only projected public call/reset failures;
the consumed generation is retired and may be replaced, but the RFM is never
replayed.
