# open-rfc

`open-rfc` is an SDK-free TypeScript and JavaScript client for SAP classic
synchronous RFC on Node.js.

**Zero runtime dependencies.** The installed runtime/code payload is portable
JavaScript and TypeScript declarations: no SAP NW RFC SDK, native addon,
post-install download, or runtime framework dependency. The npm tarball ships
`README.md`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`; the complete guides live in
the exact tagged source and versioned documentation site.

`open-rfc` 0.x is beta software with no production SLA. Treat a version as a
public release only when the exact version exists in both the project's GitHub
Release and npm package metadata, and the downloaded npm bytes match both the
GitHub SHA-256 record and npm `dist.integrity`. An untagged source checkout,
locally packed tarball, or unmatched artifact is not a supported release.

The [documentation site](https://marianfoo.github.io/open-rfc/) covers
standalone use, the `node-rfc` alias, unchanged SAP CAP integration,
configuration, operations, and the current support boundary. Before following
it, confirm that the rendered site names the same exact package version you
installed. If it names another version or is not available, use the
`docs_page/` sources from the exact matching tag instead.

The beta support boundary is deliberately narrow: direct application-server
transport, classic serialization, and password authentication on SAP S/4HANA
2023 and SAP NetWeaver 7.50. Each published artifact must work standalone, as
the archived `node-rfc` npm alias, and below unchanged `@sap/cds-rfc` through
the documented npm 11 override. The preview matrix covers representative
lifecycle and standard transaction paths; project testing does not yet include
the dedicated recovery, isolation, and transaction-failure aggregates.

## Install

Ubuntu 24.04 x64 with Node.js `^22.14.0` or `^24.0.0` is required by the beta
support contract. Reproduce release and lockfile verification with the npm
version in the artifact's `packageManager` field; the first beta uses npm 11,
which is also required for the documented CAP override. For a published
release, copy its exact version from the matching release record and save it
without a range:

The standalone package does not call npm at runtime. npm 11 is the reproducible
installation and release-verification tool and the requirement for the CAP override, not
an additional runtime dependency.

```sh
OPEN_RFC_VERSION=x.y.z
npm install --save-exact "open-rfc@${OPEN_RFC_VERSION}"
```

If you received an exact tarball through a trusted channel before it is
available on npm, install that tarball instead:

```sh
OPEN_RFC_TARBALL=/path/to/open-rfc-x.y.z.tgz
npm install --ignore-scripts "$OPEN_RFC_TARBALL"
```

Commit the resulting lockfile and use `npm ci` for repeatable deployment.
Use the [artifact checks below](#verify-an-artifact) as package-identity and
ESM/CommonJS loader sanity checks. They do not by themselves prove the complete
file inventory or absence of native code; obtain those results from the exact
release record.

## Verify an artifact

Obtain the expected SHA-256 digest from the matching GitHub Release or, for a
directly supplied tarball, from a separate trusted channel. Compare it before
installation and stop if the digest, filename, or version differs:

```sh
OPEN_RFC_TARBALL=/path/to/open-rfc-x.y.z.tgz
shasum -a 256 "$OPEN_RFC_TARBALL"
```

Then install the tarball into an empty project without lifecycle scripts:

```sh
OPEN_RFC_TARBALL=/path/to/open-rfc-x.y.z.tgz
mkdir open-rfc-artifact-check
cd open-rfc-artifact-check
npm init -y
npm install --ignore-scripts "$OPEN_RFC_TARBALL"
npm ls open-rfc --depth=0
node -p 'require("open-rfc/package.json").version'
node --input-type=module -e 'import("open-rfc").then(m => console.log(typeof m.Client))'
node -e 'console.log(typeof require("open-rfc").Client)'
```

The manifest check must print the selected exact version and both loader checks
must print `function`. Only the package root and `open-rfc/package.json` are
public subpaths. Confirm the manifest name, version, exports, and Node engine
match the release record or the trusted details supplied with the tarball.
The package must have no runtime dependency subtree and no native `.node`
addon, shared library, SDK archive, executable, credential, capture, or oracle
material. These checks are a consumer sanity test; the published release record
also identifies the source commit, npm CLI, complete file inventory, SBOM,
declarations, and exact root artifact.

## Quick start

This complete ESM example calls the SAP-supplied `STFC_CONNECTION` echo RFM.
Save the example as `rfc-smoke.mjs`, set the four required environment
variables, and run `node rfc-smoke.mjs`. With no connection values it exits
non-zero and names only the missing variable names; it never prints a value.
On success it prints the fixed line `hello from open-rfc`.

<!-- open-rfc-doc-example id="standalone-stfc-connection" runtime="esm" outcome="missing-connection" sha256="fa58f83cf581165e171c7078f2b313563c24b6587d86cc8681c598f2e2dd16e2" -->
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

If the call and `close()` both fail, the example preserves both errors and
keeps the call failure as the primary cause internally. It emits only a fixed
public failure line instead of letting Node.js print raw backend error text.
Production code may send the retained error to an application-owned private
handler only after applying its redaction policy.

Use a read-only RFM on an approved non-production system for the first test.
Connection property names shown above use the connector's documented spelling.
RFC parameter names are matched to function metadata using their exact casing,
normally uppercase: keep `REQUTEXT`, not `requtext`. Do not log credentials,
parameters, returned tables, raw frames, or backend identity.

> Direct classic RFC does not provide transport encryption or peer
> authentication. Use it only on a trusted private network or inside a
> separately managed protected tunnel; never send credentials or RFC traffic
> across an untrusted network. SAProuter is unsupported and does not by itself add
> transport encryption.

## What works—and what does not

- The direct application-server path implements SDK-free logon, metadata
  lookup, synchronous calls, finite timeouts, cancellation, reset, and clean
  shutdown within the documented 0.x beta boundary.
- Common classic scalars, binary values, exact decimal strings, structures,
  tables, STRING/XSTRING, and configurable INT8/BCD projection are implemented
  for the selected classic beta. xRFC is not a beta serializer claim.
- `Client`, `Pool`, and `RFCClient` cover the declared archived `node-rfc` and
  modern connector surfaces through ESM, CommonJS, and TypeScript declarations.
- Message-server and SAProuter routing are implemented and tested offline, but
  are not supported by this release. Do not rely on those preview
  routes for its beta support contract; consult the status page shipped with a
  later exact version before assuming support changed.
- BTP Connectivity SOCKS5/TCP routing for a direct named-user connection is an
  implemented preview. It requires the Connectivity binding's SOCKS5 endpoint,
  a Cloud Connector TCP mapping to the SAP gateway, and the explicit
  `connectivity_socks5_*` parameters documented on the site. It is not the
  separate Connectivity RFC proxy and cannot enforce Cloud Connector
  function-module resources.
- WebSocket RFC business calls, Cloud Connector principal propagation, SNC,
  and X.509 are not supported and fail closed before business I/O when their
  required provider or authentication capability is absent.
- SNC/SSO/X.509, non-Unicode/MDMP partners, registered server mode, callbacks
  from ABAP, Throughput, tRFC, qRFC, bgRFC, basXML, compression, and complete
  NW RFC SDK parity are not supported.

The package summary is intentionally narrow: unknown or unavailable provider
capabilities fail before business I/O rather than silently disappearing, while
implemented preview routes remain explicitly outside the beta support contract.

## Compatibility and guides

- [Use open-rfc as an archived `node-rfc` replacement](#use-open-rfc-as-a-node-rfc-replacement), including the
  install-time alias and lifecycle differences.
- Review the [CAP compatibility boundary](#cap-compatibility-boundary) before
  overriding the low-level connector beneath unchanged `@sap/cds-rfc`.
- Use the [troubleshooting](#troubleshooting) and
  [failure/security](#failure-and-security-boundary) sections without exposing
  private diagnostics.

The project does not control the `@sap` or `@sap-rfc` npm scopes. Drop-in
compatibility under those module IDs therefore means an exact trusted tarball, npm
alias, or consumer override—not registry-name ownership.

## Use open-rfc as a `node-rfc` replacement

The smallest source-level change replaces the module import while preserving the
Promise/callback `Client` and `Pool` lifecycle:

```js
// Before
import { Client, Pool } from "node-rfc";

// After
import { Client, Pool } from "open-rfc";
```

To preserve the old module ID with a published release, use an npm alias with
the exact version:

```json
{
  "dependencies": {
    "node-rfc": "npm:open-rfc@<exact-version>"
  }
}
```

For an exact tarball received through a trusted channel, use the same dependency
key with a file specifier instead:

```json
{
  "dependencies": {
    "node-rfc": "file:../artifacts/open-rfc-<exact-version>.tgz"
  }
}
```

Regenerate the lockfile in a clean project and confirm there is no prior
`node-rfc` native addon or SAP SDK left in the dependency tree. Test all value
types the application actually uses. INT8 can project as safe `number`,
`bigint`, or `string`; BCD/DECF values default to precision-preserving strings;
initial DATE/TIME values remain empty; parameter names retain metadata casing;
and a timeout or cancellation retires the physical connection without replay.

Compatibility enums do not imply implementation of SNC, registered server,
tRFC, qRFC, bgRFC, or Throughput. Protocol, transport, serializer, and value
modules are package-internal and are not public subpaths.

## CAP compatibility boundary

Keep SAP's `@sap/cds-rfc` package unchanged and use npm 11 to replace only its
low-level connector. Declare this in the application root:

```json
{
  "dependencies": {
    "@sap/cds-rfc": "2.2.1",
    "open-rfc": "<exact-version>"
  },
  "overrides": {
    "@sap/cds-rfc": {
      "@sap-rfc/node-rfc-library": "$open-rfc"
    }
  }
}
```

When evaluating an exact tarball received through a trusted channel instead,
replace only the direct `open-rfc`
specifier with `file:../artifacts/open-rfc-<exact-version>.tgz`; keep the nested
`$open-rfc` override unchanged.

Run `npm explain @sap-rfc/node-rfc-library` after installation and verify that
the resolved package is `open-rfc`. The exact pattern is tested in a clean npm
11 project against the exact published `@sap/cds-rfc@2.2.1` artifact. Separate
checks cover clean override installation/integrity and unchanged
runtime/destination behavior; neither is a live SAP claim. The repository's CAP
integration guide contains the same recipe and release-specific operational
notes.

`open-rfc` does not publish a CAP package and does not reimplement importers,
destination lookup, Cloud SDK behavior, or multitenancy. Direct
application-server destinations using classic serialization and password
authentication define the first-beta CAP route. Semantic transactions are
supported only when a release's support record names live transaction testing
for that exact artifact. Message-server, SAProuter, and Connectivity SOCKS5/TCP
are implemented previews but are not part of this release's beta support.
WebSocket business calls, the Connectivity RFC proxy, Cloud Connector principal
propagation, SNC, and X.509 are unsupported and require capabilities the beta
provider does not advertise.

## Troubleshooting

- Direct RFC normally uses gateway port `33NN`, not SAP GUI dispatcher port
  `32NN`; `sysnr` accepts one or two digits and normalizes to two, while
  `client` is three digits.
- A reachable peer can still reject logon because the user, client, password,
  language, system license, or RFC metadata authorization is wrong. Do not log
  the credential object while diagnosing it.
- Local value validation intentionally rejects silent truncation, out-of-range
  integers/decimals, unknown fields, wrong parameter directions, and unsupported
  recursive serializer choices before application bytes are sent.
- A timeout, cancellation, malformed reply, or uncertain send makes that
  physical connection unusable. Never retry a mutating RFM merely because the
  client disconnected.
- Start with an approved read-only RFM, run application tests against the exact
  tarball, and keep raw frames, traces, identities, bodies, and returned tables
  out of logs and issue reports.

## Release status

A passing local test or version string is not a release claim. Check the
matching GitHub Release, npm metadata, artifact digest, and documentation
release-status page before adopting a version. A published 0.x beta uses a
stable pre-1.0 version on npm's normal `latest` tag, beginning with `0.2.0`;
beta describes non-production maturity rather than a SemVer prerelease channel.
A prerelease-valued build is outside that supported channel. Project testing
does not yet cover every selected SAP release for large payloads, connection
disposition, metadata and recovery, principal isolation, transaction semantics,
value variants, pool contention, repeated runs, long soaks, or hosted
repository controls. Test any of those areas in your own deployment before
depending on them. Offline, packaged-consumer, live SAP, security, and release
verification results establish separate properties; a result in one area does
not establish the others.

## Failure and security boundary

After cancellation, timeout, or transport failure, request delivery may be
uncertain. `open-rfc` retires that connection and never automatically replays
the call; the application must reconcile any possible business effect before
retrying. Always perform bounded cleanup, preserve a cleanup failure alongside
the primary failure, use finite deadlines, and obtain credentials from an
external secret source.

Report suspected vulnerabilities through a private GitHub security advisory or
email `marian@zeis.de`. Public bug reports must not contain credentials,
captures, system identifiers, business values, request bodies, response
tables, or raw exception causes.

## License and affiliation

Public releases are distributed under Apache License 2.0 and include the
matching `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`. If those files are
absent, or the source and artifact do not match a published release, do not
infer a public license or redistribution permission from this README alone.

SAP, ABAP, SAP S/4HANA, and SAP NetWeaver are trademarks or registered
trademarks of SAP SE or its affiliates. `open-rfc` is an independent project
and is not affiliated with, sponsored by, or endorsed by SAP SE.
