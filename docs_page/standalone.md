# A standalone RFC call

<p class="open-rfc-lead">This complete example calls `STFC_CONNECTION`, prints one fixed success line, and always closes the session.</p>

Save the first example as `rfc-smoke.mjs` and run it with
`node rfc-smoke.mjs`. Missing connection configuration produces one sanitized,
non-zero failure that names only the absent environment variables. A successful
run prints exactly the fixed line `hello from open-rfc`; it does
not print connection details or an arbitrary backend result.

<!-- open-rfc-doc-example id="pages-standalone-stfc-connection" runtime="esm" outcome="missing-connection" sha256="fa58f83cf581165e171c7078f2b313563c24b6587d86cc8681c598f2e2dd16e2" -->
```js
import { Client } from "open-rfc";

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  const requestText = "hello from open-rfc";
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
    const result = await client.call("STFC_CONNECTION", {
      REQUTEXT: requestText,
    });
    if (result.ECHOTEXT !== requestText) {
      throw new Error("STFC_CONNECTION returned an unexpected echo");
    }
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
    console.log("hello from open-rfc");
  }
}
```

If the call and `close()` both fail, the example preserves both errors and keeps
the call failure as the primary cause internally. It emits only a fixed failure
line; production code may route the retained object only to an
application-owned private handler with an explicit redaction policy.

## Operational rules

- Use a finite call timeout.
- Treat cancellation after a write as an uncertain send; do not replay
  automatically.
- A declared ABAP exception can leave the session reusable; transport or
  protocol failures retire it.
- Redact parameters and results from logs unless an application-specific policy
  explicitly permits them.

## Modern lifecycle

The modern `RFCClient.open()` method returns an `RFCConnection`. Inputs are
grouped by RFC direction. Every connection starts a pinned transaction cycle,
so explicitly commit successful work or roll it back, then close the
connection. Use mutation-capable functions only with explicit authorization.

The example below intentionally exercises a transaction terminal operation.
Its principal therefore needs exact authorization for
`BAPI_TRANSACTION_COMMIT` and, on the failure path,
`BAPI_TRANSACTION_ROLLBACK`, even though `STFC_CONNECTION` itself is read-only.
Use the classic `Client` example above for the smallest read-only smoke test.

<!-- open-rfc-doc-example id="pages-modern-transaction" runtime="esm" outcome="missing-connection" sha256="1d49a30b8da6496f99b93daeb75cd51e402fe046fc66766439df326a3bc235b0" -->
```js
import { RFCClient } from "open-rfc";

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing required SAP connection environment variables: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  let connection;
  let failure;
  try {
    connection = await new RFCClient().open({
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    });
    await connection.execute("STFC_CONNECTION", {
      import: { REQUTEXT: "modern call" },
    });
    await connection.commit();
  } catch (error) {
    failure = error;
    if (connection?.alive) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          "RFC call and rollback both failed",
          { cause: error },
        );
      }
    }
  }

  if (connection) {
    try {
      await connection.close();
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
    console.error("RFC transaction failed; consult private, redacted diagnostics.");
    process.exitCode = 1;
  }
}
```

`execute()` accepts `import`, `changing`, and `table` buckets. A successful
`commit()` or `rollback()` ends the current cycle; the next `execute()` starts
a new one on demand. `close()` rolls back an unfinished cycle and retires the
connection. The guarded `open()` path and explicit cleanup preserve a primary
open, call, or transaction error together with a cleanup error internally,
then report only a fixed public failure line.

These examples ship with the matching source release and can be exercised
without credentials to verify their safe missing-configuration branches. A
local example run does not prove SAP interoperability.
