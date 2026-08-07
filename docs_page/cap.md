# Use with SAP CAP

<p class="open-rfc-lead">Keep `@sap/cds-rfc` unchanged and replace only its native low-level connector with `open-rfc`.</p>

`open-rfc` does not publish a CAP plugin. SAP's package continues to own model
imports, destination resolution, Cloud SDK integration, multitenancy, and CAP
lifecycle behavior.

## Install with npm 11

Declare `open-rfc` as a direct dependency and use a nested root override:

```json
{
  "dependencies": {
    "@sap/cds": "9.9.2",
    "@sap/cds-rfc": "2.2.1",
    "open-rfc": "{{OPEN_RFC_PACKAGE_VERSION}}"
  },
  "overrides": {
    "@sap/cds-rfc": {
      "@sap-rfc/node-rfc-library": "$open-rfc"
    }
  }
}
```

The `@sap/cds` version shown is the pinned compatibility example; use the exact
version supported by your CAP application. Keep `@sap/cds-rfc` unchanged and
pin `open-rfc` to the exact published release.

To evaluate an exact tarball received through a trusted channel, change only
the direct `open-rfc` specifier:

```json
{
  "dependencies": {
    "open-rfc": "file:../artifacts/open-rfc-{{OPEN_RFC_PACKAGE_VERSION}}.tgz"
  }
}
```

Keep the nested `$open-rfc` override unchanged.

Tarball evaluation checks the connector bytes and override shape, but it does
not prove npmjs registry resolution. Treat installation from npmjs as a
separate verification using the exact published version and a
fresh lockfile.

Commit the generated `package-lock.json`. Verify the installed tree:

```sh
npm explain @sap-rfc/node-rfc-library
npm ls open-rfc @sap/cds-rfc
```

The first command must show that the low-level dependency resolves to
`open-rfc`. Do not override `@sap/cds-rfc` itself, do not add a project-owned
CAP package, and do not change the CAP service implementation path.

Use the exact published `open-rfc` version from the release record, not a
floating range. The `$open-rfc` reference tells npm to use the exact specifier
from the root dependency and avoids duplicating it in the override.

If npm reports `EOVERRIDE`, confirm that `open-rfc` is a root dependency and
that the nested override uses exactly `$open-rfc`. Do not copy a different
version into the override. If an older lockfile still resolves the native
connector, regenerate it in a review branch with npm 11, run the two inspection
commands above, and review the lock diff before committing. A stale
`node_modules` directory does not demonstrate reproducibility; a clean `npm ci`
from the committed lockfile must produce the same tree.

## Importer ownership

The override changes only the low-level runtime connector. It does not add,
test, or change SAP's `cds import --from rfc` command, its flags, or its
generated file layout. Follow the documentation shipped with the exact
installed `@sap/cds-rfc` and `@sap/cds` versions for importer setup, and review
every generated diff before committing it.

Generated metadata can reveal customer-specific object names and
documentation. Treat it as project data and never attach it to a public issue.
A successful importer run does not test the `open-rfc` runtime override or the
application's live value and transaction shapes.

## Configure a direct service

Use CAP's ordinary `kind: "rfc"` configuration. The example host is synthetic;
inject credentials from deployment secrets rather than `package.json`:

```json
{
  "cds": {
    "requires": {
      "SYS": {
        "kind": "rfc",
        "model": "srv/external/SYS",
        "credentials": {
          "ashost": "sap.example.invalid",
          "sysnr": "00",
          "client": "001"
        }
      }
    }
  }
}
```

Application code remains unchanged:

```js
const cds = require("@sap/cds");

async function callSystem() {
  const system = await cds.connect.to("SYS");
  return system.send("STFC_CONNECTION", {
    REQUTEXT: "hello from CAP",
  });
}

module.exports = { callSystem };
```

Keep the route shape in source control and inject its credentials through the
ordinary secret/configuration mechanism supported by the exact CAP version.
The compatibility tests pass a structured `CDS_CONFIG` object to an unchanged
CAP child, but this project does not prescribe an untested `.env`, binding, or
mounted-file convention as a public contract. Verify the resolved service
privately. Any effective CAP configuration output can contain credentials and
must not enter CI logs or bug reports.

## Route boundary

This release supports only direct application-server destinations.
Message server and SAProuter are implemented and tested offline but remain
unsupported previews in this release; their presence in the connector does not
put them in the beta support contract. WebSocket invocation and Cloud Connector
principal propagation are also unsupported and
the beta provider rejects their missing capabilities before business I/O. A
service binding or a successful preview connection does not make a route beta
supported.

The connector never owns CAP tenant selection or destination lookup. It accepts
the final connection properties and authentication material produced by the
unchanged SAP layer, validates the supported subset, and owns the RFC transport
from there.

## Transactions and shutdown

Keep transaction boundaries in the unchanged SAP plugin or application layer.
Calls in one logical unit of work must stay on the same modern
`RFCConnection`; a successful commit or rollback ends that cycle. A timeout,
cancellation, disconnect, or failed terminal operation is never replayed on a
new connection. Reconcile the business outcome, close the failed connection,
and let the application open a new one only for later work.

The modern connector façade used by unchanged `@sap/cds-rfc` has a fixed
45,000 ms operation bound and no per-`execute()` timeout argument. An
application-level `Promise.race()` or HTTP deadline does not cancel RFC work.
Use the connector lifecycle to close and join active operations, and treat a
timeout after a possible send as uncertain. See the
[modern API lifecycle](api.md#modern-rfcclient-and-rfcconnection) and
[uncertain-send rule](safety.md#uncertain-send).

During shutdown, stop accepting new CAP requests before closing connector
resources. Do not log resolved destination objects because they can contain
credentials or propagated identity material.

!!! warning "Test the exact application"
    Test every RFM value shape, route, timeout, cancellation, and transaction
    behavior your application uses. A disconnect after an uncertain send is
    never safe to replay automatically.
