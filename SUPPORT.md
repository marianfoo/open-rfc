# Support policy

`open-rfc` 0.x is beta software with no production SLA. Support applies only to
an exact version published in both a matching GitHub Release and npm package
record, and only within that release's documented capability boundary. A
development checkout, locally packed tarball, or unmatched artifact is not a
supported release.

## Supported 0.x beta boundary

These rows describe the support boundary of an exact published 0.x release.

- Ubuntu 24.04 x64 with Node.js `^22.14.0` or `^24.0.0`, with the pinned npm 11
  release named by the package manifest for deterministic package
  verification and the CAP override. npm is not a standalone runtime
  dependency.
  macOS, Windows, and other Linux platform cells are not current release
  claims.
- S/4HANA 2023 and NetWeaver 7.50 for the guarded live classic RFC matrix.
- Direct application-server classic RFC with explicit parameters and password
  authentication is the selected beta subset. Additional route rows are
  supported only when the public
  [release status](docs_page/status.md) includes them in the published artifact's
  documented boundary and names the checks performed.

The public [release status](docs_page/status.md) is the authoritative support
boundary for a published version. Code that is not named there is not a
supported route merely because an implementation exists. The first preview
also leaves the dedicated large-data, disposition, metadata, recovery,
principal-isolation, semantic-transaction, value, and contention aggregates
outside project testing; applications must test the exact calls and failure
modes they use.

## Getting help

Open a GitHub issue for ordinary defects. Use a private GitHub security
advisory for a suspected vulnerability. Include only:

- the exact package version and tarball SHA-256;
- Node.js version, operating system, architecture, generic backend profile, and
  the stable failing case/capability identifier;
- whether the failure occurred before sending, after a complete send, or in an
  unknown/partial-send state when known;
- the public RFC error code/category and a safe correlation identifier;
- a synthetic reproducer or redaction-validated diagnostic artifact.

Do not include credentials, hostnames, SAP system/client/user identifiers,
destination or bearer tokens, business parameters/results, raw exception
fields, RFC/SDK traces, packet captures, memory dumps, `.env` files, or
infrastructure inventories. Maintainers will not ask for those in a public
issue.

## Severity and fixes

Critical/high security, credential/payload disclosure, data-corruption,
deadlock, unbounded-allocation, or automatic-replay findings block a beta or
stable release. A confirmed release blocker receives a deterministic regression
and reruns every affected check before a replacement artifact is issued.

Published 0.x versions follow SemVer's pre-1.0 rules: a breaking public-API
change requires a new minor version, while compatible fixes use a patch.
Exports explicitly documented as experimental or remove-before-1.0 may change
only on that same minor-version boundary. After 1.0, breaking changes require a
new major version. A deprecation must name its replacement and remain documented
for at least one minor release unless retaining it would create an active
security or corruption risk.

## Upgrade and rollback

Pin every 0.x artifact by version and SHA-256. Upgrade one version at a time,
run clean package and representative SAP smoke tests, and use a bounded canary
before broad deployment. Roll back by restoring the prior trusted tarball and
its matching lockfile and compatibility settings; never mix an application,
package record, or SBOM from different artifact digests.

Operational response and safe diagnostic procedures are in
the public [operations guide](docs_page/operations.md). Vulnerability reporting
and network boundaries are in [SECURITY.md](SECURITY.md).
