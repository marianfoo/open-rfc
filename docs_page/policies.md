# Project policies

<p class="open-rfc-lead">The project uses a narrow support contract, private vulnerability reporting, explicit external-source declarations, and exact release artifacts.</p>

## Support

The selected beta claims Ubuntu 24.04 x64 with Node.js `^22.14.0` or `^24.0.0`
and the direct application-server classic RFC/password route on S/4HANA 2023
and NetWeaver 7.50 only when exact artifact tests pass. macOS, Windows,
other Linux platform cells, advanced routes, native SDK globals, server mode,
and queued RFC families are not current support claims.

The 0.x beta has no production SLA. Pin the exact version and digest,
test the application's real value and failure shapes, and keep a rollback
artifact. The detailed
[project verification and uncovered areas](status.md#project-verification)
are in Release status. Treat every uncovered area as application testing work.

## Security reports

Report a suspected vulnerability privately through the repository security
advisory channel or the maintainer address named in the package metadata. Do
not open a public issue containing credentials, hostnames, system identifiers,
payloads, traces, captures, or raw SAP errors.

A useful report contains the exact package version and digest, Node.js version,
generic route kind, public error code/category, impact, and a minimal synthetic
reproduction.

## Contributions

Contributions require:

1. a clear behavior and support-boundary description;
2. a focused failing test before a behavioral fix;
3. focused and applicable full verification;
4. matching API/configuration/compatibility documentation;
5. declaration of every external source or behavioral reference; and
6. a Developer Certificate of Origin sign-off matching the commit author on
   each commit.

Contributions must not contain SAP credentials, live values, private system data,
SDK material, captures, non-public proprietary inputs, or expression with
incompatible or unknown redistribution terms.

## License and notices

Public source releases use Apache License 2.0 and include the exact project
`NOTICE`, complete `THIRD_PARTY_NOTICES.md`, and contribution/DCO policy. Verify
those files against the matching release tag. A source checkout, locally
packed tarball, or source set without that complete release record is not a
licensed public release, even if its manifest contains a familiar version.

`open-rfc` is an independent project and is not affiliated with, sponsored by,
or endorsed by SAP SE. SAP, ABAP, SAP S/4HANA, and SAP NetWeaver are trademarks
or registered trademarks of SAP SE or its affiliates.
