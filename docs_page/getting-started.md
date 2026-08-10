# Getting started

<p class="open-rfc-lead">Install one exact release, start with a direct application server and a read-only RFM, and keep credentials and returned values out of logs.</p>

This page was built for exact package version
`open-rfc@{{OPEN_RFC_PACKAGE_VERSION}}`. If the version shown in a GitHub
Release, npm metadata, or your lockfile differs, start with the `README.md`
inside that installed package and the `docs_page/` sources at its exact Git
tag. The website can describe a newer release.

## Requirements

- Ubuntu 24.04 x64 on a Node.js release supported by the selected artifact; see
  [Release status](status.md) for the exact matrix.
- Node.js matching `{{OPEN_RFC_NODE_ENGINE}}`.
- The npm version recorded in the selected artifact's `packageManager` field
  when reproducing installation or release verification. The beta uses npm 11,
  and npm 11 is required for the CAP nested-override recipe. The standalone
  connector does not call npm at runtime.
- A remote-enabled ABAP function module and an RFC user authorized to call it.
- Network access to the SAP gateway for the selected application server.

## Install

For a first local evaluation, install the package with npm's ordinary package
command:

```sh
npm install open-rfc
```

For a repeatable deployment, pin the exact version named by this page:

```sh
npm install --save-exact open-rfc@{{OPEN_RFC_PACKAGE_VERSION}}
```

Confirm that the same exact version exists in the matching GitHub Release and
npm package metadata, then verify the downloaded bytes against both the GitHub
SHA-256 record and npm `dist.integrity` by following the copy-paste checks in
[Release status](status.md). If you received an exact tarball through a trusted
channel and it is not on npm, install that tarball instead:

```sh
npm install --ignore-scripts ./open-rfc-{{OPEN_RFC_PACKAGE_VERSION}}.tgz
```

Confirm the installed manifest through the package's only public metadata
subpath. It must print the same exact version named at the top of this page:

```sh
node -p 'require("open-rfc/package.json").version'
```

Do not replace the exact version with `latest`, a caret range, or a custom beta
tag when reproducing an artifact check.

Do not install a working directory into an application. Use a packaged artifact
whose source commit, tarball hash, file inventory, and package metadata agree.
A source checkout or version string by itself is not a release.

Commit the resulting `package-lock.json` in the consuming application and use
`npm ci` for repeatable deployment. Add `--ignore-scripts` only if the complete
consumer dependency graph has been reviewed and does not need lifecycle
scripts. Do not rely on a developer workstation's existing npm cache as proof
that a clean build can install the artifact.

## TypeScript setup

The package includes declarations for both ESM and CommonJS. A TypeScript
consumer must also provide Node.js declarations as a development dependency;
they are not a runtime dependency of `open-rfc`. The first beta declaration
checks use TypeScript 5.9.3 and `@types/node` 22.20.1, while a Node.js 24
application may use its matching Node declaration major. Pin the selected
versions in the consumer lockfile.

For an ESM application, use `"type": "module"` in `package.json` and a strict
Node-aware compiler configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": ["node"]
  }
}
```

Import runtime values and public types from the package root only:

<!-- open-rfc-doc-example id="pages-typescript-client" runtime="typescript" outcome="typecheck" sha256="d4c6a5e5b74763fb9be217b9d00e27154735afb94f0b62b88f24a0f83c1dd8af" -->
```ts
import { Client, type RfcConnectionParameters } from "open-rfc";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const destination: RfcConnectionParameters = {
  ashost: requiredEnvironment("SAP_ASHOST"),
  sysnr: process.env.SAP_SYSNR ?? "00",
  client: requiredEnvironment("SAP_CLIENT"),
  user: requiredEnvironment("SAP_USER"),
  passwd: requiredEnvironment("SAP_PASSWD"),
};

const client = new Client(destination, { timeout: 15 });
```

The shortened fragment type-checks the root import and secret-loader return.
For archived compatibility, `RfcConnectionParameters` accepts a broad record;
runtime validation—not TypeScript—rejects misspelled, duplicate, accessor-backed,
or unsupported connection fields. The linked standalone example adds lifecycle
cleanup and safe failure reporting.

## Run the first call

Copy the complete classic `Client` example from
[A standalone RFC call](standalone.md) into `rfc-smoke.mjs` in your application.
The npm package does not install a project-level `examples/` directory, so run
the file you copied rather than a path from the source repository.

Provide the connection values only when running that file:

```bash
(
  set -e
  trap 'unset SAP_PASSWD' EXIT
  export SAP_ASHOST=app.example.invalid
  export SAP_SYSNR=00
  export SAP_CLIENT=001
  export SAP_USER='your-rfc-user'
  read -rsp 'SAP password: ' SAP_PASSWD
  printf '\n'
  export SAP_PASSWD
  node rfc-smoke.mjs
)
```

The subshell and `EXIT` trap prevent the password from remaining exported after
success, failure, or interruption. The prompt requires Bash. Replace the
synthetic host with the approved private route. In CI or a deployed application,
inject `SAP_PASSWD` from the platform's secret manager instead. Never commit a
password or `sapnwrfc.ini`. Keep the target profile and expected system identity
guard outside application logs.

## Choose an API

Use `Client` for a standalone call and `Pool` when several callers share a
bounded destination. Use `RFCClient`/`RFCConnection` only when implementing the
modern `@sap-rfc/node-rfc-library` contract or when its grouped inputs and
explicit transaction lifecycle are the desired API. All surfaces use the same
SDK-free protocol core.

Continue with the complete [standalone example](standalone.md), then review the
[destination configuration](configuration.md), [operations](operations.md),
and [safety boundaries](safety.md) before using the selected direct
application-server route. To preserve an existing import, use the
[node-rfc alias](node-rfc.md). For CAP, keep the SAP plugin and apply the
[nested low-level override](cap.md). Other classic route examples are
unsupported previews, not beta support claims.

!!! danger "Classic routes are not encrypted"
    Direct, message-server-selected, and SAProuter-routed classic RFC provide
    neither transport encryption nor peer authentication. A configured message
    server is trusted to choose the backend. Use these routes only on a trusted
    private network or inside a separately managed protected tunnel.
