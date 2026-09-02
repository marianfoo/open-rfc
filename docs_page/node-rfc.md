# Replace node-rfc

<p class="open-rfc-lead">Keep the `node-rfc` module ID at install time while moving supported client and pool calls to the SDK-free implementation.</p>

## Install under the existing module ID

For a published release, use npm's alias syntax under the dependency key your
application already imports:

```json
{
  "dependencies": {
    "node-rfc": "npm:open-rfc@{{OPEN_RFC_PACKAGE_VERSION}}"
  }
}
```

`import { Client, Pool } from "node-rfc"` and
`require("node-rfc")` can then remain unchanged. Commit the resulting lockfile
and confirm that it resolves this exact aliased artifact, not the native addon.

Application source remains unchanged:

```js
import { Client, Pool } from "node-rfc";
```

For an exact tarball received through a trusted channel, point the same
dependency key at that tarball instead:

```json
{
  "dependencies": {
    "node-rfc": "file:../artifacts/open-rfc-{{OPEN_RFC_PACKAGE_VERSION}}.tgz"
  }
}
```

Project releases use only the project-controlled `open-rfc` name; this project
cannot publish into SAP-controlled npm scopes. In either installation mode,
use the exact version and integrity from the published release record, or the
trusted digest supplied with the tarball, rather than a range or custom
dist-tag.

Verify the resolved package before testing the application:

```sh
npm explain node-rfc
npm ls node-rfc --all
node -e 'const { environment } = require("node-rfc"); if (environment.noderfc.implementation !== "open-rfc-sdk-free") process.exit(1); console.log("open-rfc-sdk-free")'
```

The dependency tree must contain one `node-rfc` installation resolved from the
exact `open-rfc` version, and the loader check must print
`open-rfc-sdk-free`. The lock entry must bind that version and its matching
integrity and must not contain the native SAP addon or an SDK installation
step. `open-rfc` is not expected as a second top-level dependency in this
alias-only installation.

## Migration checklist

Before replacing an existing installation:

1. Inventory every imported `node-rfc` export and every connection option.
2. Keep `Client` and `Pool` imports, but remove or redesign uses of `Server`,
   `Throughput`, `noderfc_binding`, `reloadIniFile`, SDK-global/INI
   configuration, SNC, SSO modes other than the documented MYSAPSSO2 preview,
   X.509, registered server mode, callbacks from ABAP, tRFC, qRFC, and bgRFC.
   They are not supplied by this beta.
3. Use only the supported direct application-server route; message-server and
   SAProuter code is an unsupported preview, not a migration target.
4. Treat `call()` and the metadata methods as Promise-only, `invoke()` as the
   callback call form, and lifecycle/pool methods as Promise-or-callback.
5. Run the exact value, timeout, cancellation, reset, pool, and error shapes
   used by the application before deployment.

## Promise calls

`Client` accepts the familiar connection object and returns Promises when no
callback is supplied. `Client` and per-call `timeout` values are in **seconds**.
The executable examples use the preserved `node-rfc` module ID and are tested
against the exact packed artifact installed under that alias. If you chose a
source-level migration instead, change only the import to `open-rfc`.

Save the Promise and pool examples as `.mjs`, save the callback example as
`.cjs`, and run the selected file with `node <file>`.
With no connection configuration it exits non-zero and names only the missing
environment variables. Successful Promise, callback, and pool examples print
one fixed completion line and never print returned SAP values or connection
details.

<!-- open-rfc-doc-example id="pages-node-rfc-promise" runtime="esm" outcome="missing-connection" sha256="a312d6bc4f5f8c7d73524dc9ca820c07e997dba28b77540f3adc1f1054145022" -->
```js
import { Client } from "node-rfc";

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const client = new Client(
    {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    { timeout: 15 },
  );

  let opened = false;
  let failure;
  try {
    await client.open();
    opened = true;
    await client.call(
      "STFC_CONNECTION",
      { REQUTEXT: "promise call" },
      { timeout: 10 },
    );
  } catch (error) {
    failure = error;
  }

  if (opened) {
    try {
      await client.close();
    } catch (closeError) {
      failure = failure
        ? new AggregateError(
            [failure, closeError],
            "RFC operation and close both failed",
            { cause: failure },
          )
        : closeError;
    }
  }
  if (failure) {
    console.error("RFC operation failed; consult private, redacted diagnostics.");
    process.exitCode = 1;
  } else {
    console.log("RFC call completed");
  }
}
```

The Promise cleanup preserves both the operation and cleanup failures when
`close()` also rejects, but reports only a fixed public failure line.

## Callback calls

Callbacks follow the node-rfc error-first shape. `call()` is Promise-only;
`invoke()` is its callback counterpart.

<!-- open-rfc-doc-example id="pages-node-rfc-callback" runtime="cjs" outcome="missing-connection" sha256="a02f371e03767ac1381d2c4bd1fb0a69291ebc7263005332e0e11b84b4616073" -->
```js
const { Client } = require("node-rfc");

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const client = new Client(
    {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    { timeout: 15 },
  );

  const finish = (error) => {
    if (error) {
      console.error("RFC operation failed; consult private, redacted diagnostics.");
      process.exitCode = 1;
    }
  };

  client.open((openError) => {
    if (openError) return finish(openError);
    client.invoke(
      "STFC_CONNECTION",
      { REQUTEXT: "callback call" },
      (callError) => {
        client.close((closeError) => {
          const failure =
            callError && closeError
              ? new AggregateError(
                  [callError, closeError],
                  "RFC call and close both failed",
                  { cause: callError },
                )
              : callError ?? closeError;
          if (!failure) console.log("RFC callback completed");
          finish(failure);
        });
      },
      { timeout: 10 },
    );
  });
}
```

## Bounded pool

Set the application-session capacity and waiter limit explicitly.
`poolOptions.high` is the number of idle application sessions the compatibility
pool may retain; it is not the hard application capacity. Metadata lookup uses
a separate bounded repository lane, so `resourceOptions.maxConnections` is not
a total physical-session cap. That lane may add at most
`min(2, maxConnections)` physical sessions, so budget the target for up to
`maxConnections + min(2, maxConnections)` sessions per pool. Explicit
`ready(n)` can retain more application sessions than `poolOptions.high`; the
hard `maxConnections` value still applies. Resource deadlines use milliseconds,
while the client call timeout remains seconds. See the [API reference](api.md#pool)
for defaults and lifecycle details.

<!-- open-rfc-doc-example id="pages-node-rfc-pool" runtime="esm" outcome="missing-connection" sha256="b9f80d5b1ea556c5922001fe1089e60c175648c4dd648110008c8c82e4845f82" -->
```js
import { Pool } from "node-rfc";

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionParameters: {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    clientOptions: { timeout: 15 },
    poolOptions: { low: 0, high: 2 },
    resourceOptions: {
      maxConnections: 4,
      maxWaiters: 16,
      acquireTimeoutMs: 5_000,
      lifecycleTimeoutMs: 20_000,
      shutdownTimeoutMs: 30_000,
      validateOnCheckout: true,
    },
  });

  let client;
  let failure;
  try {
    client = await pool.acquire();
    await client.call("STFC_CONNECTION", { REQUTEXT: "pooled call" });
  } catch (error) {
    failure = error;
  }

  if (client) {
    try {
      await pool.release(client);
    } catch (releaseError) {
      failure = failure
        ? new AggregateError(
            [failure, releaseError],
            "RFC operation and pool release both failed",
            { cause: failure },
          )
        : releaseError;
    }
  }
  try {
    await pool.closeAll();
  } catch (closeError) {
    failure = failure
      ? new AggregateError(
          [failure, closeError],
          "RFC operation and pool shutdown both failed",
          { cause: failure },
        )
      : closeError;
  }
  if (failure) {
    console.error("RFC operation failed; consult private, redacted diagnostics.");
    process.exitCode = 1;
  } else {
    console.log("RFC pool call completed");
  }
}
```

Do not call `open()` or `close()` on a leased client. Return it with
`pool.release(client)`, and call `pool.closeAll()` during application shutdown.
If release fails, still attempt `closeAll()` and preserve both failures.

## Compatibility boundary

| Area | Current behavior |
|---|---|
| `Client` / `Pool` | Promise and callback lifecycle, invoke/call, ping, cancellation, timeout, reset, and bounded pooling are part of the supported direct-route boundary. |
| Values | Classic scalar, flat structure, structured table, STRING/XSTRING, exact decimal strings, and configurable INT8 output are supported within documented limits. Project tests exercise representative values; they do not cover every value on both selected SAP releases. |
| Unsupported options | Must fail before I/O; an option is never intentionally ignored merely to appear compatible. |
| Native SDK globals | `Server`, `Throughput`, `noderfc_binding`, INI reload, and SDK-specific global configuration are not supplied. |

## Differences to test in your application

- INT8 can project as a safe `number`, `bigint`, or `string`; select the mode
  explicitly when values can exceed JavaScript's safe integer range.
- BCD and DECF values default to precision-preserving decimal strings.
- Initial DATE/TIME values remain empty instead of becoming invented dates.
- Metadata parameter keys retain exact casing, normally uppercase.
- A timeout, cancellation, malformed reply, or uncertain send retires the
  physical connection and is never replayed automatically.

Before deploying, exercise every decimal, INT8, binary, initial temporal,
structure, table, error, cancellation, and requested-output shape used by the
application. Start with an approved read-only function on a non-production
target and keep the previous lockfile as the rollback boundary.

!!! warning "Compatibility is a boundary, not SDK parity"
    The supported client and pool surface is intentionally fail-closed. Server
    mode, SNC, SSO modes other than the documented MYSAPSSO2 preview, X.509,
    SDK globals, and other unsupported capabilities do not become available
    merely because the package is installed as `node-rfc`.
