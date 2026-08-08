# Release status

<p class="open-rfc-lead">A version is a public release only when its GitHub Release, npm metadata, artifact digest, and documented support record all identify the same bytes.</p>

This page describes exact package version
`open-rfc@{{OPEN_RFC_PACKAGE_VERSION}}`. It does not silently follow `latest`.
Use it to verify the package and understand the support boundary for these
exact bytes.

## Determine whether a version is published

These are the canonical human-readable routes for the version rendered into
this page:

```sh
OPEN_RFC_VERSION='{{OPEN_RFC_PACKAGE_VERSION}}'
printf '%s\n' \
  "https://github.com/marianfoo/open-rfc/releases/tag/v${OPEN_RFC_VERSION}" \
  "https://www.npmjs.com/package/open-rfc/v/${OPEN_RFC_VERSION}"
```

If either route is missing, the version is not a public release. With GitHub
CLI, npm 11, and Node.js available, inspect the exact records and compare the
downloaded bytes as follows:

```sh
OPEN_RFC_VERSION='{{OPEN_RFC_PACKAGE_VERSION}}'
verify_directory="$(mktemp -d)"
mkdir -p "${verify_directory}/release" "${verify_directory}/registry"

gh release view "v${OPEN_RFC_VERSION}" \
  --repo marianfoo/open-rfc \
  --json isDraft,isPrerelease,tagName,targetCommitish,assets
npm view "open-rfc@${OPEN_RFC_VERSION}" \
  version dist.integrity dist.tarball --json

gh release download "v${OPEN_RFC_VERSION}" \
  --repo marianfoo/open-rfc \
  --pattern "open-rfc-${OPEN_RFC_VERSION}.tgz" \
  --pattern release-artifact-gate.v1.json \
  --pattern sbom.spdx.json \
  --dir "${verify_directory}/release"
npm pack "open-rfc@${OPEN_RFC_VERSION}" \
  --ignore-scripts \
  --pack-destination "${verify_directory}/registry" >/dev/null

npm_integrity="$(npm view "open-rfc@${OPEN_RFC_VERSION}" dist.integrity)"
node --input-type=module - \
  "${verify_directory}" "${OPEN_RFC_VERSION}" "${npm_integrity}" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const [directory, version, npmIntegrity] = process.argv.slice(2);
const releaseDirectory = join(directory, "release");
const filename = `open-rfc-${version}.tgz`;
const releaseTarball = join(releaseDirectory, filename);
const registryTarball = join(directory, "registry", filename);
const gate = JSON.parse(readFileSync(
  join(releaseDirectory, "release-artifact-gate.v1.json"),
  "utf8",
));
const digest = (path) => createHash("sha256")
  .update(readFileSync(path))
  .digest("hex");
const releaseSha256 = digest(releaseTarball);
const registrySha256 = digest(registryTarball);

if (
  gate.artifact?.filename !== basename(releaseTarball) ||
  gate.artifact?.sha256 !== releaseSha256 ||
  gate.artifact?.integrity !== npmIntegrity ||
  registrySha256 !== releaseSha256
) process.exit(1);

console.log(`verified sha256:${releaseSha256}`);
NODE
```

The two record commands require manual inspection of release state, tag,
assets, npm version, and integrity. The final Node.js command automates the
tarball byte/integrity comparison only; it does not validate the SBOM contents,
release notes, or support record. Review those separately against the checklist
below.

The expected SHA-256 comes from the downloaded release verification record. The
command computes both tarball digests and prints the value only after the
GitHub asset, npm registry bytes, npm integrity, and verification record agree; this
page never invents a pre-release digest.

Before installing a version, verify all of the following:

1. a non-draft, non-prerelease GitHub Release names the exact version and
   supplies the tarball, release verification record, and SBOM;
2. npm resolves that exact version under the project-controlled `open-rfc`
   package name;
3. the npm registry integrity and downloaded tarball SHA-256 match the release
   record; and
4. the release notes state which SAP release families and capabilities were
   tested, and list the areas not covered by project testing.

If any item is missing or disagrees, treat the version as an unsupported
development build. A version string, local green test, old live run, or source
checkout cannot make itself a published release.

## Beta support contract

A published 0.x beta is a non-production maturity label for a stable
pre-1.0 version, beginning with `0.2.0`; it is not a SemVer prerelease or an npm
`beta`/`next` channel. A prerelease-valued build is outside this supported channel.
npm's normal `latest` pointer may identify the exact published stable version
named at the top of this page. The support boundary is one `open-rfc` package
on Ubuntu 24.04 x64 with Node.js `^22.14.0` or `^24.0.0`. The exact npm version
in the artifact's `packageManager` field owns lockfile, pack, and release
verification; npm 11
also owns the CAP override contract. npm is not loaded by the standalone
runtime. Project testing covers direct application-server transport, classic
serialization, password authentication, one run for each selected Node/SAP
combination, and unchanged CAP on both selected SAP release families. It does
not cover dedicated two-release testing for large data, connection disposition,
metadata, recovery, principal isolation, transaction semantics, value variants,
or pool contention.

The same artifact is tested in three consumer shapes:

- direct standalone `open-rfc` use;
- an exact npm alias preserving the archived `node-rfc` module ID; and
- the npm 11 low-level override beneath unchanged `@sap/cds-rfc`.

There is no project-owned CAP package and no package under an SAP-controlled
npm scope. macOS and Windows are not beta support claims.

## Project verification

- offline build, declarations, public API, hostile-input, fault, coverage,
  mutation, resource, package-content, and packed-consumer checks;
- one repeat for each Node.js 22/24 and S/4HANA 2023/NetWeaver 7.50 coordinate;
- serializer classification, unchanged CAP, and the four-cell repeat-one
  packed live matrix across both SAP release families;
- one bounded read-only unchanged-`@sap/cds-rfc` consumer on both SAP release
  families;
- the same source snapshot and tarball across every check listed above.

Project verification does not yet include dedicated two-release coverage for
large data, error disposition, metadata, recovery, principal isolation,
transaction semantics, value variants, and pool contention. It also does not
include second and third repeats, long soaks on both selected SAP releases, or
the complete hosted platform and repository-control checks. Applications must
test every value and failure shape they use.

Verify a published beta against its public source commit, exact release tarball,
release verification record, SBOM, and repository controls. These supply-chain
checks do not expand the capability or platform support described above.

Message-server, SAProuter, Connectivity SOCKS5/TCP, WebSocket RFC, Cloud
Connector RFC proxy and principal propagation, SNC, and X.509 are unsupported.
Their presence in code, offline tests, or a single-system spike does not add
them to a release support contract.

## Public source contract

A public source release includes Apache-2.0 `LICENSE`, the project `NOTICE`, a
complete `THIRD_PARTY_NOTICES.md`, and the contribution/DCO policy. It is
identified by a published source commit and exact release artifacts. Verify a
release against that commit, tarball, SBOM, and release receipt.

Offline, packaged, live, soak, security, and release checks establish separate
properties even when they appear in one release record.

!!! warning
    Missing authentication or provider capabilities fail closed. Implemented
    message-server and SAProuter previews are still unsupported by the beta
    contract even if they connect. Never put credentials, principal tokens,
    SAP identities, returned data, or raw protocol material in an issue.
