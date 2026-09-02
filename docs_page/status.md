# Release status

<p class="open-rfc-lead">A public release exists when the same exact version is present in both GitHub Releases and npm.</p>

This page describes `open-rfc@{{OPEN_RFC_PACKAGE_VERSION}}`. The website may
move ahead of an older installed package, so use the README and documentation
from the matching Git tag when versions differ.

## Verify a release

Check the exact version rather than relying on a branch name or a local build:

```sh
OPEN_RFC_VERSION='{{OPEN_RFC_PACKAGE_VERSION}}'

gh release view "v${OPEN_RFC_VERSION}" \
  --repo marianfoo/open-rfc \
  --json isDraft,isPrerelease,tagName,targetCommitish

npm view "open-rfc@${OPEN_RFC_VERSION}" \
  version dist.integrity dist.tarball --json
```

The GitHub release must be published, the npm record must resolve the same
version, and the package must come from the tagged source. If one of those
records is missing or disagrees, do not treat the version as a project release.
For reproducible applications, pin the exact npm version and commit the
resulting lockfile.

## Beta support contract

A published 0.x beta is a stable pre-1.0 version on npm's normal `latest`
channel; beta describes maturity, not a SemVer prerelease. The current package
supports Node.js `{{OPEN_RFC_NODE_ENGINE}}` and has zero runtime dependencies.

The supported beta path is a direct application-server connection using classic
RFC, password authentication, metadata lookup, bounded calls, cancellation,
pooling, and the documented value projections. Applications must test the
function modules, values, authorization, network path, and failure behavior
they actually use.

## Project verification

Every product pull request runs the compiled protocol, transport, serializer,
client, pool, compatibility, malformed-input, cancellation, and regression
tests. Package exports and TypeScript declarations have a separate surface
check. Focused live, resource, fault, property, or compatibility checks are run
when a change touches those boundaries.

This does not prove every SAP release, network topology, data shape, pool load,
long-running workload, or recovery scenario. Treat unsupported combinations as
application qualification work, not as an implied project guarantee.

## Preview and unsupported routes

Message-server, SAProuter, Connectivity SOCKS5/TCP, WebSocket RFC, Cloud
Connector RFC proxy and principal propagation, SNC, and X.509 are not part of
the current beta support contract. Their presence in source or offline tests
does not make them supported.

MYSAPSSO2 ticket authentication is also an implemented preview. The complete
parameter-to-CPIC path is covered by offline and scripted-socket tests, but no
disposable ticket was available for qualification on both documented live SAP
systems. Password authentication therefore remains the current beta claim.

## Public source and license

The source and npm package are distributed under Apache-2.0. The repository
contains `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and the DCO
contribution policy. open-rfc is an independent interoperability project and is
not affiliated with or endorsed by SAP.
