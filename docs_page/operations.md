# Operate open-rfc safely

<p class="open-rfc-lead">A controlled non-production pilot depends on one pinned artifact, one destination policy, and one tested failure model—not merely a successful RFC call.</p>

## Non-production evaluation checklist

- Pin one exact `open-rfc` version and commit the consumer lockfile.
- Evaluate on the supported Ubuntu 24.04 x64 and Node.js combination.
- Inject credentials at runtime and keep them out of build logs and crash
  reports.
- Verify the expected SAP target through a private deployment control before
  the first business call.
- Set finite call, acquisition, lifecycle, and shutdown bounds. Cancellation
  has no separate user-tunable duration; await the original call for its
  terminal outcome.
- Bound connection count and queued waiters.
- Run a read-only canary covering the application's actual metadata and value
  shapes.
- Retain the previous trusted artifact and lockfile as the rollback unit.

The 0.x public beta has no production SLA. Treat this checklist as a bounded
evaluation and pilot baseline. The application must establish its own
production readiness through workload, failure, recovery, and operational
testing.

## Pool sizing and shutdown

`resourceOptions.maxConnections` is the hard application-session capacity;
`poolOptions.high` is only the number of idle application sessions retained.
The compatibility pool owns a separate bounded repository lane for metadata
lookup, so `maxConnections` is not a total physical-session cap. Set
`maxWaiters` and `acquireTimeoutMs` so an unhealthy backend cannot turn into an
unbounded application queue.

On shutdown, stop accepting new application work, wait for owned work within
its business deadline, then call `pool.closeAll()`. Do not reuse a wrapper that
was leased before shutdown. A failed or timed-out shutdown should terminate the
process through the application's ordinary supervisor rather than leave an
unknown session running indefinitely.

## Retry decisions

| Outcome | Automatic replay? | Next action |
|---|---|---|
| Local validation rejection before I/O | No automatic retry needed | Correct the request; the open generation is unchanged. |
| Declared ABAP exception after a complete reply | No | Apply the application's explicit business rule; the session may remain reusable. |
| Transport failure before any request byte is written | Only by explicit application policy | Open a fresh connection and preserve the original error. |
| Timeout, cancellation, or failure after a possible write | Never | Treat the send as uncertain, retire the connection, and reconcile business state. |
| Commit or rollback failure | Never | Treat the LUW as ambiguous, close the connection, and reconcile before further work. |

`alive` describes the wrapper's current usable generation; it does not prove
that an earlier request was not processed. Never infer retry safety from it.

## Structured diagnostics

Use the bounded diagnostics API for lifecycle and capacity signals. Events have
a fixed schema and deliberately contain no connection parameters, function
parameters, returned values, backend text, or raw causes. This wiring fragment
assumes the validated `connectionParameters` object from
[Configuration](configuration.md#minimum-direct-configuration).

```js
import {
  Client,
  RfcDiagnosticDispatcher,
  createBoundedRolloverDiagnosticSink,
} from "open-rfc";

const sink = await createBoundedRolloverDiagnosticSink({
  path: "/var/log/my-app/open-rfc.jsonl",
  maxBytes: 1_048_576,
  maxFiles: 3,
});
const diagnostics = new RfcDiagnosticDispatcher({
  sink,
  level: "info",
  maxQueued: 1_024,
});
const client = new Client(connectionParameters, {
  timeout: 15,
  diagnostics,
});
```

Create the parent directory yourself with restrictive ownership. The file sink
refuses symlinks and writes owner-only files. Check `diagnostics.monitor()` for
drops or sink failures, and call `await diagnostics.close()` during orderly
shutdown after clients and pools have closed.

## Upgrade and rollback

1. Review the release support boundary and compatibility notes.
2. Update the exact dependency and regenerate the lockfile with the selected
   npm version.
3. Run clean package installation, offline application tests, and the bounded
   SAP canary.
4. Roll out to a small instance set while monitoring failures, queue depth, and
   connection retirement.
5. Roll back the package and lockfile together if the new artifact fails.

Do not mix a package, generated type snapshot, compatibility adapter,
documentation, or lockfile from different versions.

## Incident information

Record only the exact package version and artifact digest, Node.js version,
generic route kind, stable public error code/category, safe correlation ID, and
whether the failure was before send, after send, or unknown. Do not attach
credentials, endpoints, SAP identities, request/response values, traces,
captures, or memory dumps to a public issue. Continue with the bounded
[Troubleshooting](troubleshooting.md) flow.
