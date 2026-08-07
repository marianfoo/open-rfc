# Glossary

<p class="open-rfc-lead">The small set of SAP RFC terms needed to use open-rfc safely.</p>

RFC and RFM
: Remote Function Call is the protocol family. An RFM is a remote-enabled ABAP
  function module that a client invokes.

SDK-free
: The installed runtime does not load the SAP NW RFC SDK or a native addon. It
  does not imply complete SDK feature parity.

Classic sRFC
: One synchronous request and response on an authenticated RFC session. This
  is the primary implemented call mode.

NI, APPC, and CPIC
: The network framing and conversation layers used by the implemented direct
  classic-RFC path.

xRFC
: An XML value representation used by selected deep interfaces. It is not part
  of the supported first-beta serializer boundary.

basXML
: A distinct SAP serializer. It is not supported by the first beta.

Direct route
: A gateway connection for one selected application server.

Message-server route
: A route that selects an application server through the message server before
  opening RFC. It is not supported by the first beta.

SAProuter
: An NI routing hop. Routing alone is not encryption or peer authentication.

Cloud Connector
: SAP BTP connectivity infrastructure. A service binding or reachable mapping
  does not by itself make RFC proxying, WebSocket RFC, or principal propagation
  a supported open-rfc route.

Stateful and stateless sessions
: A stateful session retains authenticated backend context across operations.
  A stateless session resets backend context between reusable calls while the
  physical connection may remain open.

SAP LUW
: A logical unit of work. Business calls and commit or rollback must stay on
  one physical session lease.

Uncertain send
: A failure after request bytes may have reached SAP. The connection is retired
  and the call is not automatically replayed.

Metadata
: Function-parameter and DDIC structure definitions used to encode and decode
  RFC values. Metadata is bounded, validated, detached, and cached by its
  owning destination.

ABAP initial value
: The type-specific empty value, such as an empty character field or a
  zero-valued numeric field. It is not always JavaScript `undefined`.

Declared ABAP exception
: An exception declared by the function module. After a complete reply it can
  be reported as an `ABAPError` while the authenticated session remains usable.

Fatal transport or protocol failure
: An outcome after which session reuse is unsafe. The physical connection is
  retired so late data cannot cross into another call.

Offline check
: A deterministic result without an SAP connection. It cannot prove
  interoperability with a particular release.

Live check
: A redaction-safe result from a selected SAP system and exact release
  artifact.

SAP, SAP BTP, ABAP, SAP S/4HANA, and SAP NetWeaver are trademarks or
registered trademarks of SAP SE or its affiliates. open-rfc is an independent
project and is not affiliated with, sponsored by, or endorsed by SAP SE.
