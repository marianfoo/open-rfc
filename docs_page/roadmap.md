# Road to 1.0

This roadmap turns the current public 0.x beta into a reviewable path to `open-rfc@1.0.0`. It is a planning document, not a support claim or release decision. Current supported behavior remains defined by the exact version's [release status](status.md).

Every item is initially **proposed** so maintainers can change importance, risk, effort, scope, dependencies, and acceptance criteria through ordinary review. Only exact verified evidence can complete a release requirement; closing an issue or editing this page cannot do so.

This page is the roadmap authority. Update it through an ordinary documentation review and keep the overview totals in sync with the detailed items. The regular documentation checks cover formatting, local links, examples, navigation, and the built site; roadmap estimates and priorities remain review decisions rather than machine-enforced product contracts.

## Scope and estimate

The default stable scope is: Direct application-server classic RFC with password authentication, the stable standalone API, the archived node-rfc compatibility surface, and unchanged @sap/cds-rfc through the documented npm override.

38 currently required items total **222–420 person-days (about 44.4–84.0 person-weeks)**. 4 conditional route items add **69–137 person-days (about 13.8–27.4 person-weeks)** only if a reviewed scope decision promotes them. These estimates assume one experienced maintainer and reuse of current automation. They exclude calendar wait for adopters, SAP operators, reviewers, credentials, and infrastructure.

Estimate ranges are deliberately broad. Re-estimate after scope decisions, baseline evidence mapping, adopter recruitment, or any new external prerequisite.

## Assessment scale

- **Importance:** `critical` blocks a safe or honest stable release; `high` is strongly expected; `medium` materially helps but can be scoped out; `low` is optional polish.
- **Risk:** combines impact and uncertainty across correctness, security, compatibility, operations, schedule, scope, supply chain, and external dependencies.
- **Effort:** `XS`, `S`, `M`, `L`, and `XL`, with an explicit experienced-maintainer person-day range and confidence level.
- **Release role:** required items block 1.0; conditional items block only after promotion into the approved support scope; post-1.0 items never block 1.0.

## Gate overview

| Gate | Objective | Required items | Conditional items | Required effort |
| --- | --- | --- | --- | --- |
| `V1-00` Rebaseline after public beta | Replace pre-publication assumptions with one reviewed starting point for the published 0.x line and one maintained roadmap authority. | 3 | 0 | 7–13 person-days (about 1.4–2.6 person-weeks) |
| `V1-01` Freeze the intended 1.0 scope | Choose a stable support boundary early and prevent optional route research from silently becoming an unbounded release dependency. | 3 | 4 | 6–11 person-days (about 1.2–2.2 person-weeks) |
| `V1-02` Close deferred beta hardening | Convert the public beta's deliberately deferred failure, isolation, value, contention, repeatability, and soak areas into exact-candidate stable-release evidence. | 9 | 0 | 66–115 person-days (about 13.2–23.0 person-weeks) |
| `V1-03` Freeze the stable contract | Turn the reviewed support boundary into stable API, defaults, compatibility, deprecation, support, EOL, and migration promises. | 6 | 0 | 24–43 person-days (about 4.8–8.6 person-weeks) |
| `V1-04` Prove production readiness | Demonstrate sustained operation and real consumer adoption against the frozen stable contract before naming a release candidate stable. | 7 | 0 | 57–109 person-days (about 11.4–21.8 person-weeks) |
| `V1-05` Complete assurance and operations | Close supply-chain, security, correctness, findings, and operational readiness with current independent review of the frozen stable candidate. | 5 | 0 | 41–89 person-days (about 8.2–17.8 person-weeks) |
| `V1-06` Release and verify 1.0.0 | Freeze one exact stable release set, run the final all-gates decision, obtain explicit authorization, publish through the established pipeline, and verify the public result. | 5 | 0 | 21–40 person-days (about 4.2–8.0 person-weeks) |

## V1-00 — Rebaseline after public beta

Replace pre-publication assumptions with one reviewed starting point for the published 0.x line and one maintained roadmap authority.

Dependencies: none.

Exit criteria:

- The exact public baseline and retained pre-publication evidence are reconciled without relabeling evidence onto different bytes.
- The public roadmap and issue workflow have one documented ownership and update rule.
- Every deferred beta requirement is mapped to a v1 item or deliberately excluded by a reviewed scope decision.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-00.publication-rebaseline` Reconcile the published baseline | Required for 1.0 | proposed | critical | medium | S | 2–4 person-days | high |
| `roadmap.v1-00.roadmap-governance` Adopt roadmap governance | Required for 1.0 | proposed | high | low | S | 2–3 person-days | high |
| `roadmap.v1-00.beta-gap-baseline` Map the deferred beta gaps | Required for 1.0 | proposed | critical | high | M | 3–6 person-days | medium |

### Reconcile the published baseline

- **ID:** `roadmap.v1-00.publication-rebaseline`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, release-owner

Record which public 0.x release, source commit, npm artifact, documentation record, and retained evidence form the starting point for v1 planning.

- **Importance — critical:** Every later estimate and acceptance decision is unreliable if it still assumes the pre-publication 0.2.0 candidate rather than the published line.
- **Risk — medium:** Evidence from historical candidates can be mistaken for proof of later public bytes, creating false confidence and redundant reruns. Domains: `correctness`, `supply-chain`, `scope`.
- **Effort — S, 2–4 person-days, high confidence:** The public release records exist; the work is primarily identity reconciliation and deletion of stale publication assumptions.
- **Risk controls:**
  - Bind the baseline to exact source, artifact, release, and documentation identities.
  - Classify retained evidence as reusable, diagnostic-only, or invalidated instead of copying pass labels.
- **Deliverables:**
  - Exact public baseline record
  - Evidence reuse and invalidation map
- **Acceptance criteria:**
  - The baseline resolves one exact public source commit and npm/GitHub artifact identity.
  - No evidence is credited to an artifact or commit other than the one it names.
  - Pre-publication status prose is either corrected or clearly historical.

### Adopt roadmap governance

- **ID:** `roadmap.v1-00.roadmap-governance`
- **Release role:** Required for 1.0
- **Execution:** policy
- **Owners:** maintainer, release-owner

Define how roadmap proposals become accepted work, how estimates change, and how reviewed items are mirrored into GitHub milestones or issues.

- **Importance — high:** A large roadmap without one update rule will immediately split into stale documents, issues, and evidence tracking queues.
- **Risk — low:** The main risk is administrative drift rather than product failure, but drift can hide a release-critical dependency. Domains: `operations`, `schedule`.
- **Effort — S, 2–3 person-days, high confidence:** The required states and identifiers are already defined; the remaining work is review policy and issue synchronization.
- **Depends on:** `roadmap.v1-00.publication-rebaseline`
- **Risk controls:**
  - Keep this roadmap authoritative for assessment metadata.
  - Create public issues only after review and retain stable roadmap IDs in their bodies.
- **Deliverables:**
  - Roadmap review and change policy
  - GitHub issue synchronization convention
- **Acceptance criteria:**
  - Importance, risk, effort, scope, and status changes require an ordinary reviewed pull request.
  - A roadmap item has at most one canonical public tracking issue after issue materialization.
  - Closing an issue cannot by itself mark release evidence passed.

### Map the deferred beta gaps

- **ID:** `roadmap.v1-00.beta-gap-baseline`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer

Compare the public support record, the full beta ledger, and exact retained results so every unproven hardening area has one v1 owner.

- **Importance — critical:** The public beta intentionally deferred several failure, isolation, value, contention, repeat, and soak aggregates that must not disappear before stability.
- **Risk — high:** A deferred beta check can be mistaken for an optional enhancement, leaving a correctness or isolation gap in the stable release. Domains: `correctness`, `security`, `compatibility`, `scope`.
- **Effort — M, 3–6 person-days, medium confidence:** The ledgers are detailed, but exact public-release evidence and historical results must be reconciled carefully.
- **Depends on:** `roadmap.v1-00.publication-rebaseline`
- **Risk controls:**
  - Map every authored beta requirement to one roadmap item and current evidence state.
  - Require a reviewed explicit exclusion for anything not carried into v1.
- **Deliverables:**
  - Beta-to-v1 requirement crosswalk
  - List of reusable and missing exact evidence
- **Acceptance criteria:**
  - Every deferred beta requirement has exactly one v1 disposition.
  - The crosswalk distinguishes implemented behavior from exact-candidate admission evidence.
  - No public support claim is broadened by the planning exercise.

## V1-01 — Freeze the intended 1.0 scope

Choose a stable support boundary early and prevent optional route research from silently becoming an unbounded release dependency.

Dependencies: `V1-00`.

Exit criteria:

- The required 1.0 platforms, SAP release families, consumer shapes, transports, serializers, and authentication modes are explicit.
- Every additional route is either promoted to required work through review or remains conditional or post-v1.
- Unsupported APIs and parity exclusions are documented before the API freeze.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-01.stable-support-boundary` Approve the stable support boundary | Required for 1.0 | proposed | critical | high | M | 3–5 person-days | high |
| `roadmap.v1-01.direct-route-contract` Confirm direct classic RFC as the baseline | Required for 1.0 | proposed | critical | medium | S | 2–4 person-days | high |
| `roadmap.v1-01.message-server-qualification` Qualify message-server routing | Conditional scope candidate | proposed | high | high | L | 8–15 person-days | medium |
| `roadmap.v1-01.saprouter-qualification` Qualify SAProuter routing | Conditional scope candidate | proposed | medium | high | L | 6–12 person-days | medium |
| `roadmap.v1-01.websocket-promotion` Resolve WebSocket RFC promotion | Conditional scope candidate | proposed | medium | critical | XL | 30–60 person-days | low |
| `roadmap.v1-01.cloud-connector-promotion` Resolve Cloud Connector principal propagation | Conditional scope candidate | proposed | medium | critical | XL | 25–50 person-days | low |
| `roadmap.v1-01.explicit-post-v1-exclusions` Freeze explicit post-v1 exclusions | Required for 1.0 | proposed | high | medium | XS | 1–2 person-days | high |

### Approve the stable support boundary

- **ID:** `roadmap.v1-01.stable-support-boundary`
- **Release role:** Required for 1.0
- **Execution:** decision
- **Owners:** maintainer, release-owner

Define the exact operating systems, Node versions, SAP release families, consumer shapes, transport, serializer, authentication, and compatibility claims for 1.0.

- **Importance — critical:** All qualification cost, API stability promises, and support obligations depend on a bounded definition of what 1.0 supports.
- **Risk — high:** Freezing too broadly creates an infeasible matrix, while freezing too narrowly can make the stable release unattractive or surprising. Domains: `scope`, `compatibility`, `schedule`.
- **Effort — M, 3–5 person-days, high confidence:** The current beta boundary is explicit; the work is a reviewed product decision plus a qualification matrix.
- **Depends on:** `roadmap.v1-00.beta-gap-baseline`
- **Risk controls:**
  - Use the published direct-classic beta boundary as the default.
  - Require evidence and maintenance cost estimates before adding a route or platform.
- **Deliverables:**
  - Versioned 1.0 support matrix
  - Qualification matrix size and maintenance estimate
- **Acceptance criteria:**
  - Every supported row has an owner and an evidence class.
  - Unknown capabilities fail closed and are not implied by adjacent support.
  - The scope fits the available release and maintenance capacity.

### Confirm direct classic RFC as the baseline

- **ID:** `roadmap.v1-01.direct-route-contract`
- **Release role:** Required for 1.0
- **Execution:** decision
- **Owners:** maintainer, release-owner

Carry the proven direct application-server, classic serialization, password-authenticated path and all three consumer shapes into the stable contract.

- **Importance — critical:** This is the product's current public value proposition and the only route with a bounded, implemented beta qualification program.
- **Risk — medium:** The route is implemented, but 1.0 would still be unsafe if stable claims outrun the deferred failure and isolation evidence. Domains: `correctness`, `compatibility`.
- **Effort — S, 2–4 person-days, high confidence:** Most contract text and implementation already exist; effort is reconciliation and stable acceptance wording.
- **Depends on:** `roadmap.v1-01.stable-support-boundary`
- **Risk controls:**
  - Keep all V1-02 hardening work required for the baseline route.
  - Bind standalone, node-rfc alias, and unchanged CAP to the same exact candidate.
- **Deliverables:**
  - Stable direct-route contract
  - Three-consumer acceptance matrix
- **Acceptance criteria:**
  - The contract names direct classic RFC and password authentication without implying transport encryption.
  - One exact candidate must pass standalone, alias, and unchanged-CAP use.
  - Deferred V1-02 evidence remains a release dependency.

### Qualify message-server routing

- **ID:** `roadmap.v1-01.message-server-qualification`
- **Release role:** Conditional scope candidate
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Promote message-server load balancing only if the scope review selects it and an exact live matrix proves routing, failover, limits, cleanup, and consumer behavior.

- **Importance — high:** Message-server routing matters to many SAP landscapes, but it is not necessary to stabilize the existing direct-route product.
- **Risk — high:** Offline coverage may miss real load-balancing, failover, release-family, and operational differences that appear only on live infrastructure. Domains: `correctness`, `operations`, `external-dependency`, `schedule`.
- **Effort — L, 8–15 person-days, medium confidence:** Implementation and offline tests exist, but live infrastructure, route failure coverage, and exact-candidate evidence remain.
- **Condition:** Required only if the accepted V1 scope decision promotes message-server routing into 1.0.
- **Depends on:** `roadmap.v1-01.stable-support-boundary`
- **Risk controls:**
  - Require a complete two-release live route matrix before promotion.
  - Keep the route explicitly unsupported if suitable infrastructure or evidence is unavailable.
- **Deliverables:**
  - Message-server support contract
  - Exact live qualification matrix
- **Acceptance criteria:**
  - Both selected SAP release families pass normal, failover, limit, and cleanup cases.
  - Every consumer shape selected for the route uses the same exact artifact.
  - Failure leaves no ambiguous retry or socket-reuse behavior.

### Qualify SAProuter routing

- **ID:** `roadmap.v1-01.saprouter-qualification`
- **Release role:** Conditional scope candidate
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Promote SAProuter only if selected and exact live evidence proves route parsing, chaining, failure disposition, security wording, and supported consumer behavior.

- **Importance — medium:** SAProuter expands deployment reach, but it does not provide transport encryption and is not essential to the existing direct-route contract.
- **Risk — high:** Route-chain edge cases and misleading security assumptions can create connection failures or unsafe deployments despite passing offline parsers. Domains: `security`, `correctness`, `operations`, `external-dependency`.
- **Effort — L, 6–12 person-days, medium confidence:** The parser and direct/message route composition exist, while live route infrastructure and full disposition evidence are missing.
- **Condition:** Required only if the accepted V1 scope decision promotes SAProuter routing into 1.0.
- **Depends on:** `roadmap.v1-01.stable-support-boundary`
- **Risk controls:**
  - Test exact multi-hop and failure cases on approved infrastructure.
  - Keep explicit documentation that SAProuter is not encryption or peer authentication.
- **Deliverables:**
  - SAProuter support contract
  - Exact route and failure qualification
- **Acceptance criteria:**
  - Every admitted route form has live success and bounded failure coverage.
  - Timeout and uncertain-send cases retire the connection without replay.
  - Documentation states the route's exact security boundary.

### Resolve WebSocket RFC promotion

- **ID:** `roadmap.v1-01.websocket-promotion`
- **Release role:** Conditional scope candidate
- **Execution:** implementation
- **Owners:** maintainer, independent-reviewer, sap-operator

Promote WebSocket business calls only after the Apache-licensed public codec basis is completed into an independently reviewable fast-serializer contract and the full provider, wire, and live route can be qualified.

- **Importance — medium:** WebSocket RFC is relevant to cloud routes, but low-level decode and encode primitives are not enough for a stable support claim.
- **Risk — critical:** The bounded codec covers observed containers, records, field descriptions, exact elementary INT4/CHAR/STRING blocks, and LZ4 decoding, but composite/table parameter graphs, responses, exceptions, compression production, item nesting, version negotiation, and integration are not yet complete. Guessing at those gaps could cause protocol corruption and an unmaintainable stable claim. Domains: `correctness`, `security`, `scope`, `external-dependency`, `schedule`.
- **Effort — XL, 30–60 person-days, low confidence:** The public codec basis removes several research unknowns, but the complete bidirectional contract, provider integration, wire implementation, fuzzing, and live qualification remain.
- **Condition:** Required only if the accepted V1 scope decision promotes WebSocket RFC into 1.0 and the codec basis can be completed into an independently implementable serializer contract.
- **Depends on:** `roadmap.v1-01.stable-support-boundary`
- **Risk controls:**
  - Keep the partial decoder internal and fail closed until the complete grammar is reviewable.
  - Fail closed and keep the route unsupported if that prerequisite does not exist.
  - Run hostile framing, limits, cancellation, and two-release live matrices after implementation.
- **Deliverables:**
  - Complete and provenance-reviewed bidirectional serializer contract
  - WebSocket provider and live qualification if feasible
- **Acceptance criteria:**
  - Request, response, exception, versioning, and compression grammar is public, independently implementable, and provenance-reviewed.
  - Unsupported serializer states fail before business I/O.
  - The exact route passes hostile offline and two-release live qualification.

### Resolve Cloud Connector principal propagation

- **ID:** `roadmap.v1-01.cloud-connector-promotion`
- **Release role:** Conditional scope candidate
- **Execution:** implementation
- **Owners:** maintainer, independent-reviewer, sap-operator

Promote principal propagation only if the selected route has a complete token, tunnel, certificate mapping, identity-isolation, and backend security contract.

- **Importance — medium:** Principal propagation is valuable for cloud deployments, but it is a distinct security product rather than a small extension of password-authenticated direct RFC.
- **Risk — critical:** Token confusion, tenant or principal leakage, certificate mapping errors, and unsupported SNC/X.509 assumptions could become authentication vulnerabilities. Domains: `security`, `correctness`, `external-dependency`, `scope`, `schedule`.
- **Effort — XL, 25–50 person-days, low confidence:** The estimate depends on route choice, BTP infrastructure, token exchange, certificate mapping, SNC/X.509 requirements, and cross-tenant qualification.
- **Condition:** Required only if the accepted V1 scope decision promotes Cloud Connector principal propagation into 1.0 and selects its authentication route.
- **Depends on:** `roadmap.v1-01.stable-support-boundary`
- **Risk controls:**
  - Select one explicit propagation route and threat-model it before implementation.
  - Prove tenant and principal isolation in both cache orders.
  - Keep tokens in memory and fail closed before backend business I/O on any missing provider capability.
- **Deliverables:**
  - Principal-propagation threat model
  - Selected route implementation and isolation evidence if feasible
- **Acceptance criteria:**
  - The route proves logged-in user identity rather than a technical-client substitute.
  - Tenant, token, pool, session, and metadata state remain isolated under concurrency.
  - Every token and certificate failure mode is bounded and redacted.

### Freeze explicit post-v1 exclusions

- **ID:** `roadmap.v1-01.explicit-post-v1-exclusions`
- **Release role:** Required for 1.0
- **Execution:** policy
- **Owners:** maintainer, release-owner

Document which server, transactional, security, serializer, legacy-encoding, and SDK-parity capabilities remain unsupported after 1.0.

- **Importance — high:** A 1.0 label can otherwise be misread as full NW RFC SDK parity, creating unsafe adoption and impossible support expectations.
- **Risk — medium:** Ambiguous exclusions can produce accidental support commitments or silently configured capabilities that do not work as users expect. Domains: `scope`, `compatibility`, `operations`.
- **Effort — XS, 1–2 person-days, high confidence:** The current unsupported inventory already exists and mainly needs a reviewed stable-release disposition.
- **Depends on:** `roadmap.v1-01.stable-support-boundary`
- **Risk controls:**
  - List excluded capabilities in the public support contract and API documentation.
  - Retain fail-closed provider and serializer negotiation for every unsupported capability.
- **Deliverables:**
  - Stable unsupported-capability matrix
  - Fail-closed configuration review
- **Acceptance criteria:**
  - Server/callback mode, tRFC/qRFC/bgRFC, Throughput, security modes, serializers, and legacy encodings each have an explicit disposition.
  - Conditional items not selected for 1.0 are documented as unsupported rather than silently omitted.
  - Version 1.0 does not claim unbounded SDK parity.

## V1-02 — Close deferred beta hardening

Convert the public beta's deliberately deferred failure, isolation, value, contention, repeatability, and soak areas into exact-candidate stable-release evidence.

Dependencies: `V1-01`.

Exit criteria:

- Every required deferred beta aggregate passes on each supported SAP release family for one exact candidate artifact.
- Failure, cancellation, isolation, transaction, and contention evidence proves connection disposition and zero replay.
- No required matrix cell is satisfied by a skip, development result, or unrelated artifact.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-02.large-data-segmentation` Complete large-data and segmentation evidence | Required for 1.0 | proposed | critical | high | M | 5–8 person-days | medium |
| `roadmap.v1-02.failure-disposition-recovery` Complete failure disposition and recovery | Required for 1.0 | proposed | critical | critical | L | 8–15 person-days | medium |
| `roadmap.v1-02.metadata-release-isolation` Complete metadata release isolation | Required for 1.0 | proposed | critical | high | L | 6–10 person-days | medium |
| `roadmap.v1-02.principal-isolation` Prove principal and cache isolation | Required for 1.0 | proposed | critical | critical | L | 8–15 person-days | low |
| `roadmap.v1-02.value-applicability` Complete value applicability and round trips | Required for 1.0 | proposed | high | high | L | 8–14 person-days | medium |
| `roadmap.v1-02.semantic-transactions` Complete semantic transaction failures | Required for 1.0 | proposed | critical | critical | XL | 15–25 person-days | low |
| `roadmap.v1-02.pool-contention` Complete pool contention and resource bounds | Required for 1.0 | proposed | critical | high | L | 8–14 person-days | medium |
| `roadmap.v1-02.repeatability` Run the complete repeatability matrix | Required for 1.0 | proposed | high | medium | M | 4–7 person-days | medium |
| `roadmap.v1-02.full-beta-soaks` Complete full-beta release soaks | Required for 1.0 | proposed | high | medium | M | 4–7 person-days | medium |

### Complete large-data and segmentation evidence

- **ID:** `roadmap.v1-02.large-data-segmentation`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Prove request and response segmentation across negotiated boundaries, hostile lengths, cleanup, and post-call reuse on every supported release family.

- **Importance — critical:** Length and segmentation defects can corrupt payloads, allocate unbounded memory, or desynchronize the protocol under ordinary large calls.
- **Risk — high:** Release-specific boundary behavior and partial writes may expose protocol faults not visible in compact offline vectors. Domains: `correctness`, `security`, `operations`.
- **Effort — M, 5–8 person-days, medium confidence:** Offline harnesses exist; exact live vectors, release differences, and final artifact binding drive the remaining work.
- **Depends on:** `roadmap.v1-01.direct-route-contract`
- **Risk controls:**
  - Cover both sides of each boundary with hostile and property tests.
  - Verify post-call reuse only after an unambiguous terminal response and retire uncertain sockets.
- **Deliverables:**
  - Boundary regression corpus
  - Two-release large-data evidence
- **Acceptance criteria:**
  - Both request and response directions cross every selected boundary successfully.
  - Malformed, excessive, and truncated lengths fail within fixed allocation limits.
  - Connection reuse is proved only for terminally safe outcomes.

### Complete failure disposition and recovery

- **ID:** `roadmap.v1-02.failure-disposition-recovery`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Prove error mapping, timeout, cancellation, late replies, reset, replacement, shutdown, and reusable-versus-retired connection decisions.

- **Importance — critical:** Incorrect recovery can replay an uncertain call, return a poisoned socket to a pool, or deliver a late reply to the wrong request.
- **Risk — critical:** Timing-dependent terminal states can cause duplicate business effects, cross-request contamination, hangs, or resource leaks. Domains: `correctness`, `security`, `operations`.
- **Effort — L, 8–15 person-days, medium confidence:** The state machines and fault harnesses exist, but race coverage and exact two-release recovery evidence are substantial.
- **Depends on:** `roadmap.v1-02.large-data-segmentation`
- **Risk controls:**
  - Model every terminal state and consequence explicitly.
  - Use deterministic fault scheduling plus bounded live cancellation and recovery.
  - Retire every timeout, uncertain-send, malformed, or unknown-protocol socket without automatic replay.
- **Deliverables:**
  - Complete disposition matrix
  - Recovery and late-reply evidence
- **Acceptance criteria:**
  - Every error class has one tested connection consequence.
  - No timed-out, cancelled, malformed, fatal, or uncertain session returns to the pool.
  - Late replies cannot satisfy a later invocation.

### Complete metadata release isolation

- **ID:** `roadmap.v1-02.metadata-release-isolation`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Prove classic and fallback metadata, recursive descriptors, invalidation, eviction, generation, and separation across supported release families.

- **Importance — critical:** Incorrect metadata can serialize valid-looking but corrupt requests, and cross-system cache pollution can make failures intermittent.
- **Risk — high:** Release-specific descriptor shapes and fallback paths may poison shared caches or choose the wrong serializer. Domains: `correctness`, `compatibility`, `operations`.
- **Effort — L, 6–10 person-days, medium confidence:** Repository behavior is implemented offline; live release-specific graphs and fallback classifications remain.
- **Depends on:** `roadmap.v1-02.failure-disposition-recovery`
- **Risk controls:**
  - Test cold, concurrent, retry, invalidation, eviction, and recursive graphs.
  - Bind cache identity to release, system, principal, generation, and serializer-relevant metadata.
- **Deliverables:**
  - Metadata state-machine regressions
  - Two-release descriptor evidence
- **Acceptance criteria:**
  - Recursive descriptors and release-specific variants project without lossy fallback.
  - Cold concurrency deduplicates safely and failures do not poison later retries.
  - System and release cache entries never cross identities.

### Prove principal and cache isolation

- **ID:** `roadmap.v1-02.principal-isolation`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator, independent-reviewer

Run positive and restricted principals in both cache orders and under concurrency so metadata, pool, session, token, and error state cannot cross principals.

- **Importance — critical:** Cross-principal cache disclosure is a security boundary violation and cannot be accepted in a stable connector.
- **Risk — critical:** A privileged-first cache order can disclose metadata to a restricted user or let denial state poison a later authorized principal. Domains: `security`, `correctness`, `external-dependency`.
- **Effort — L, 8–15 person-days, low confidence:** Harnesses exist, but valid restricted credentials, operator coordination, and exact live ordering evidence are external prerequisites.
- **Depends on:** `roadmap.v1-02.metadata-release-isolation`
- **Risk controls:**
  - Use least-privilege positive and intentional denial fixtures.
  - Exercise both cache orders and concurrent principal access.
  - Keep credentials and identities out of retained evidence.
- **Deliverables:**
  - Two-order principal-isolation evidence
  - Concurrent isolation regressions
- **Acceptance criteria:**
  - The restricted principal authenticates and receives the intended authorization denial.
  - Both principal orders produce identical authorized and denied outcomes without cache leakage.
  - Concurrent pools and metadata repositories remain principal-scoped.

### Complete value applicability and round trips

- **ID:** `roadmap.v1-02.value-applicability`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Classify and round-trip every supported scalar, temporal, decimal, binary, structure, table, recursive, STRING, and XSTRING form on each release family.

- **Importance — high:** Stable users need precision-preserving values and metadata-derived applicability rather than silent truncation or false parity.
- **Risk — high:** Numeric precision, initial temporal values, Unicode boundaries, nested binary data, and release-specific types can fail silently if not exact. Domains: `correctness`, `compatibility`.
- **Effort — L, 8–14 person-days, medium confidence:** The offline corpus is broad; complete fixture acceptance, live applicability, and edge-value comparison drive the estimate.
- **Depends on:** `roadmap.v1-02.metadata-release-isolation`
- **Risk controls:**
  - Use exact string or bigint projections where number cannot preserve value.
  - Derive not-applicable cases from pinned metadata rather than skipping them.
  - Reject unsupported recursive serializers before send.
- **Deliverables:**
  - Complete value corpus
  - Two-release applicability and round-trip evidence
- **Acceptance criteria:**
  - Every claimed value form has exact boundary and round-trip coverage.
  - Precision, initial values, casing, and binary lengths remain exact.
  - Release-specific absence is metadata-derived and never counted as a pass.

### Complete semantic transaction failures

- **ID:** `roadmap.v1-02.semantic-transactions`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator, independent-reviewer

Prove commit, rollback, close, pool, commit-error, fatal-disconnect, observation, cleanup, ambiguity, and no-replay behavior on each release family.

- **Importance — critical:** Transaction ambiguity can duplicate or lose business effects, so API-shape tests are insufficient for a stable transaction claim.
- **Risk — critical:** Failure between application send, backend update task, commit response, and disconnect can leave uncertain effects or unsafe automatic retry behavior. Domains: `correctness`, `operations`, `external-dependency`.
- **Effort — XL, 15–25 person-days, low confidence:** Runtime harnesses exist, but temporary roles, failure injection, four operator observations, cleanup, and aggregate evidence require careful coordination.
- **Depends on:** `roadmap.v1-02.failure-disposition-recovery`, `roadmap.v1-02.principal-isolation`, `roadmap.v1-02.value-applicability`
- **Risk controls:**
  - Use isolated reversible fixtures and unique run identifiers.
  - Require operator observation of commit-failure and fatal-disconnect disposition.
  - Reconcile uncertain effects and never replay automatically.
- **Deliverables:**
  - Complete semantic transaction aggregate
  - Operator-reviewed failure and cleanup evidence
- **Acceptance criteria:**
  - Commit applies exactly once and rollback leaves no application effect.
  - Commit-error and fatal-disconnect paths preserve ambiguity and no-replay rules.
  - Every temporary authorization is removed and cleanup is rechecked.

### Complete pool contention and resource bounds

- **ID:** `roadmap.v1-02.pool-contention`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Prove fairness, overload, queue timeout, abort, stale release, reset failure, replacement, shutdown, and bounded resources under randomized contention.

- **Importance — critical:** The pool is a production concurrency boundary where starvation, deadlock, stale leases, and leaked sockets can take down an application.
- **Risk — high:** Rare scheduler interleavings can exceed capacity, leak waiters, reuse retired sessions, or deadlock shutdown under load. Domains: `correctness`, `operations`, `security`.
- **Effort — L, 8–14 person-days, medium confidence:** Offline pool tests exist; resource instrumentation, randomized campaigns, and exact live contention complete the work.
- **Depends on:** `roadmap.v1-02.failure-disposition-recovery`, `roadmap.v1-02.principal-isolation`
- **Risk controls:**
  - Use seeded randomized schedulers and deterministic failure injection.
  - Measure sockets, tasks, waiters, heap, external buffers, and RSS against fixed budgets.
  - Repeat exact live contention and cleanup on every release family.
- **Deliverables:**
  - Contention regression campaign
  - Two-release pool and resource evidence
- **Acceptance criteria:**
  - Capacity and fairness invariants hold under overload and cancellation.
  - Retired generations and stale leases cannot return to service.
  - Shutdown terminates every waiter and physical session within fixed bounds.

### Run the complete repeatability matrix

- **ID:** `roadmap.v1-02.repeatability`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Run three consecutive exact-artifact iterations across each supported Node and SAP release-family coordinate after all hardening inputs freeze.

- **Importance — high:** A single green run cannot distinguish a stable protocol implementation from timing luck, stale state, or an intermittent backend path.
- **Risk — medium:** Running too early wastes expensive live evidence, while inadequate repetition can hide intermittent races and cleanup defects. Domains: `correctness`, `schedule`, `external-dependency`.
- **Effort — M, 4–7 person-days, medium confidence:** Automation exists; elapsed time, target availability, triage, and exact evidence review dominate.
- **Depends on:** `roadmap.v1-02.large-data-segmentation`, `roadmap.v1-02.failure-disposition-recovery`, `roadmap.v1-02.metadata-release-isolation`, `roadmap.v1-02.principal-isolation`, `roadmap.v1-02.value-applicability`, `roadmap.v1-02.semantic-transactions`, `roadmap.v1-02.pool-contention`
- **Risk controls:**
  - Freeze product bytes and prerequisites before the matrix.
  - Run independent coordinates concurrently only where target capacity permits.
  - Treat every failed child as terminal and never replay an uncertain call.
- **Deliverables:**
  - Three-repeat Node and SAP matrix
  - Terminal per-coordinate evidence index
- **Acceptance criteria:**
  - Every required Node and SAP coordinate passes three consecutive runs from identical bytes.
  - No mandatory row is skipped, replayed, or substituted with ancestor evidence.
  - Every run finishes with verified cleanup and connection disposition.

### Complete full-beta release soaks

- **ID:** `roadmap.v1-02.full-beta-soaks`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Run at least sixty minutes and ten thousand bounded operations per supported SAP release family with scenario, cancellation, resource, and cleanup floors.

- **Importance — high:** Short functional runs do not expose slow leaks, queue accumulation, late replies, metadata growth, or lifecycle degradation.
- **Risk — medium:** A soak can pass counts while missing representative scenarios or can become invalid if run against bytes that later change. Domains: `operations`, `correctness`, `schedule`.
- **Effort — M, 4–7 person-days, medium confidence:** The soak harness exists; preparation, target windows, monitoring, failure triage, and evidence review account for most effort.
- **Depends on:** `roadmap.v1-02.repeatability`
- **Risk controls:**
  - Pin scenario and resource floors in the soak contract.
  - Run only after the exact hardening candidate is frozen.
  - Verify cleanup and post-soak resource return independently.
- **Deliverables:**
  - Two full-beta soak reports
  - Resource and cleanup comparison
- **Acceptance criteria:**
  - Each release family reaches both the duration and operation floors.
  - Required scenarios and cancellation outcomes meet their fixed minimum counts.
  - Sockets, waiters, heap, buffers, and RSS remain within budgets and clean up.

## V1-03 — Freeze the stable contract

Turn the reviewed support boundary into stable API, defaults, compatibility, deprecation, support, EOL, and migration promises.

Dependencies: `V1-02`.

Exit criteria:

- All stable exports, declarations, defaults, configuration semantics, and error consequences are frozen and tested.
- SemVer, deprecation, support, and EOL policies define the maintenance contract after 1.0.
- Users have an executable migration path from the supported 0.x line.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-03.api-snapshot-freeze` Freeze the public API snapshot | Required for 1.0 | proposed | critical | high | M | 4–7 person-days | high |
| `roadmap.v1-03.experimental-cleanup` Remove or promote experimental surfaces | Required for 1.0 | proposed | critical | high | L | 7–12 person-days | medium |
| `roadmap.v1-03.defaults-freeze` Freeze defaults and configuration semantics | Required for 1.0 | proposed | critical | high | M | 4–7 person-days | medium |
| `roadmap.v1-03.semver-deprecation-policy` Finalize SemVer and deprecation policy | Required for 1.0 | proposed | high | medium | S | 2–4 person-days | high |
| `roadmap.v1-03.support-eol-policy` Finalize support and EOL policy | Required for 1.0 | proposed | high | high | M | 3–6 person-days | medium |
| `roadmap.v1-03.migration-guide` Publish the 0.x-to-1.0 migration guide | Required for 1.0 | proposed | high | medium | M | 4–7 person-days | medium |

### Freeze the public API snapshot

- **ID:** `roadmap.v1-03.api-snapshot-freeze`
- **Release role:** Required for 1.0
- **Execution:** implementation
- **Owners:** maintainer, independent-reviewer

Review every root export, declaration, overload, callback or promise shape, error type, lifecycle method, and package subpath before declaring it stable.

- **Importance — critical:** After 1.0, accidental public API choices become long-lived compatibility obligations that require a major release to break.
- **Risk — high:** Internal protocol details, experimental conveniences, or inconsistent dual-loader types can become permanently supported by accident. Domains: `compatibility`, `scope`, `schedule`.
- **Effort — M, 4–7 person-days, high confidence:** Snapshot tooling exists; the work is API inventory, deliberate classification, focused compatibility tests, and documentation.
- **Depends on:** `roadmap.v1-01.explicit-post-v1-exclusions`, `roadmap.v1-02.full-beta-soaks`
- **Risk controls:**
  - Diff runtime and declaration exports across ESM and CommonJS.
  - Keep protocol, transport, metadata, serializer, and value internals outside public subpaths.
  - Require explicit review for every retained experimental export.
- **Deliverables:**
  - Reviewed stable API snapshot
  - ESM/CommonJS/declaration parity report
- **Acceptance criteria:**
  - Only the package root and package.json remain public subpaths unless review adds another.
  - ESM, CommonJS, and TypeScript expose the same intended contract.
  - Every stable error and lifecycle consequence is documented and tested.

### Remove or promote experimental surfaces

- **ID:** `roadmap.v1-03.experimental-cleanup`
- **Release role:** Required for 1.0
- **Execution:** implementation
- **Owners:** maintainer

Delete, internalize, rename, or explicitly stabilize every preview, remove-before-1.0, deprecated, ambiguous, or unsupported public-facing surface.

- **Importance — critical:** The last pre-1.0 window is the cheapest point to correct misleading names and remove accidental compatibility obligations.
- **Risk — high:** Late cleanup can break adopters and reset evidence, but avoiding it can lock known design debt into the stable API. Domains: `compatibility`, `schedule`, `scope`.
- **Effort — L, 7–12 person-days, medium confidence:** The estimate depends on how many experimental exports and configuration semantics the API inventory identifies.
- **Depends on:** `roadmap.v1-03.api-snapshot-freeze`
- **Risk controls:**
  - Complete cleanup before production-like adopter validation and release candidates.
  - Provide replacements and migration notes for every removed 0.x surface.
  - Rerun all affected package and consumer evidence.
- **Deliverables:**
  - Experimental-surface disposition
  - Compatibility regressions for promoted or replaced APIs
- **Acceptance criteria:**
  - No public export remains accidentally experimental or undocumented.
  - Every breaking 0.x change has a replacement or explicit migration instruction.
  - The post-cleanup API snapshot is regenerated and reviewed.

### Freeze defaults and configuration semantics

- **ID:** `roadmap.v1-03.defaults-freeze`
- **Release role:** Required for 1.0
- **Execution:** implementation
- **Owners:** maintainer, independent-reviewer

Review timeouts, limits, projection modes, pool behavior, locale, retry consequences, option precedence, and fail-closed unknown configuration before freezing defaults.

- **Importance — critical:** Defaults are part of the effective API and can create silent behavior changes even when types remain source-compatible.
- **Risk — high:** Unsafe timeouts, permissive unknown options, lossy projections, or silent retry behavior can become entrenched operational hazards. Domains: `correctness`, `operations`, `compatibility`.
- **Effort — M, 4–7 person-days, medium confidence:** Most defaults are already machine-readable; risk review, compatibility impact, and test coverage account for the remaining work.
- **Depends on:** `roadmap.v1-03.experimental-cleanup`
- **Risk controls:**
  - Snapshot every public default and precedence rule.
  - Keep finite limits and zero automatic replay after uncertain send.
  - Reject unknown providers, serializers, security modes, and unsupported options before business I/O.
- **Deliverables:**
  - Stable defaults manifest
  - Configuration precedence and rejection tests
- **Acceptance criteria:**
  - Every public default and limit is documented and snapshot-tested.
  - No unsupported configuration is silently ignored.
  - Timeout, abort, retry, and projection consequences remain explicit.

### Finalize SemVer and deprecation policy

- **ID:** `roadmap.v1-03.semver-deprecation-policy`
- **Release role:** Required for 1.0
- **Execution:** policy
- **Owners:** maintainer, release-owner

Finalize stable-release compatibility rules, deprecation duration, replacement requirements, security exceptions, and release-note obligations.

- **Importance — high:** Stable users need predictable change rules, and maintainers need an explicit route for security or corruption fixes that cannot preserve behavior.
- **Risk — medium:** An overly rigid policy can block urgent safety fixes, while a weak policy makes 1.0 compatibility meaningless. Domains: `compatibility`, `security`, `operations`.
- **Effort — S, 2–4 person-days, high confidence:** A strong 0.x policy already exists; the task is stable-release review, examples, and alignment with release automation.
- **Depends on:** `roadmap.v1-03.defaults-freeze`
- **Risk controls:**
  - Require a documented replacement and at least one minor release for normal deprecations.
  - Allow bounded exceptions only for active security, corruption, or data-loss risk.
  - Test public snapshots in CI.
- **Deliverables:**
  - Stable SemVer policy
  - Deprecation and emergency-change procedure
- **Acceptance criteria:**
  - Breaking stable changes require a major release except for documented safety exceptions.
  - Every deprecation names a replacement and minimum support window.
  - Release notes identify API, default, support, and deprecation changes.

### Finalize support and EOL policy

- **ID:** `roadmap.v1-03.support-eol-policy`
- **Release role:** Required for 1.0
- **Execution:** policy
- **Owners:** maintainer, release-owner

Define supported Node, operating system, SAP release-family, consumer, maintenance, security-fix, and end-of-life windows for stable versions.

- **Importance — high:** A stable version creates support expectations that must fit the project's actual maintenance and qualification capacity.
- **Risk — high:** Open-ended support commitments can make the matrix unaffordable, while abrupt EOL can strand production adopters. Domains: `operations`, `schedule`, `compatibility`.
- **Effort — M, 3–6 person-days, medium confidence:** Policy writing is small, but capacity modeling and alignment with adopters, Node lifecycles, and SAP test access require review.
- **Depends on:** `roadmap.v1-03.semver-deprecation-policy`
- **Risk controls:**
  - Tie support windows to explicit release families and Node LTS policy.
  - Publish notice periods and security-fix handling.
  - Avoid claiming platforms without recurring CI and live qualification capacity.
- **Deliverables:**
  - Stable support matrix
  - Version maintenance and EOL schedule policy
- **Acceptance criteria:**
  - Every supported platform and release family has a recurring qualification plan.
  - Security-fix and EOL notice expectations are explicit.
  - The policy makes no production SLA promise the project cannot sustain.

### Publish the 0.x-to-1.0 migration guide

- **ID:** `roadmap.v1-03.migration-guide`
- **Release role:** Required for 1.0
- **Execution:** implementation
- **Owners:** maintainer, adopter

Provide executable migration guidance for standalone, node-rfc alias, and unchanged-CAP consumers, including defaults, errors, values, transactions, and unsupported routes.

- **Importance — high:** Existing beta adopters need a deterministic upgrade path and must understand every deliberate break before the stable release.
- **Risk — medium:** Incomplete migration guidance can cause wrong value handling, unsafe retry, stale native dependencies, or broken CAP overrides. Domains: `compatibility`, `operations`.
- **Effort — M, 4–7 person-days, medium confidence:** Documentation is straightforward, while executable three-consumer examples and change inventory require focused validation.
- **Depends on:** `roadmap.v1-03.api-snapshot-freeze`, `roadmap.v1-03.defaults-freeze`, `roadmap.v1-03.support-eol-policy`
- **Risk controls:**
  - Test migration examples in clean disposable projects.
  - Cover all three consumer shapes and the exact package-manager requirements.
  - Call out failure, transaction, and value-semantic changes explicitly.
- **Deliverables:**
  - Versioned migration guide
  - Executable three-consumer migration examples
- **Acceptance criteria:**
  - A clean project can migrate each supported consumer shape using only public instructions.
  - Every intentional breaking change and default change is listed.
  - The guide preserves no native SDK or archived connector dependency accidentally.

## V1-04 — Prove production readiness

Demonstrate sustained operation and real consumer adoption against the frozen stable contract before naming a release candidate stable.

Dependencies: `V1-03`.

Exit criteria:

- Each supported SAP release family passes a 24-hour mixed soak within fixed resource and failure budgets.
- Linux Node 22 and 24 package and consumer matrices pass from the exact candidate artifact.
- Production-like standalone, node-rfc, and unchanged-CAP adopters complete representative canaries.
- Two consecutive release candidates pass without support-boundary drift.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-04.twenty-four-hour-soaks` Run 24-hour mixed soaks | Required for 1.0 | proposed | critical | high | L | 6–10 person-days | medium |
| `roadmap.v1-04.linux-node-consumer-matrix` Run the final Linux Node consumer matrix | Required for 1.0 | proposed | critical | medium | M | 4–7 person-days | high |
| `roadmap.v1-04.standalone-adopter` Qualify a production-like standalone adopter | Required for 1.0 | proposed | critical | high | XL | 10–20 person-days | low |
| `roadmap.v1-04.node-rfc-adopter` Qualify a production-like node-rfc migration | Required for 1.0 | proposed | high | high | XL | 10–20 person-days | low |
| `roadmap.v1-04.cap-adopter` Qualify a production-like unchanged-CAP adopter | Required for 1.0 | proposed | critical | high | XL | 12–25 person-days | low |
| `roadmap.v1-04.performance-budgets` Freeze performance and resource budgets | Required for 1.0 | proposed | high | medium | M | 5–9 person-days | medium |
| `roadmap.v1-04.consecutive-release-candidates` Pass two consecutive clean release candidates | Required for 1.0 | proposed | critical | high | L | 10–18 person-days | low |

### Run 24-hour mixed soaks

- **ID:** `roadmap.v1-04.twenty-four-hour-soaks`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, sap-operator

Run a representative mixed workload for at least 24 hours on every supported SAP release family with cancellation, error, recovery, pool, metadata, transaction, and resource floors.

- **Importance — critical:** Stable deployment requires evidence against slow leaks, intermittent races, session drift, and sustained backend interaction beyond the beta soak.
- **Risk — high:** Long runs can waste scarce infrastructure if started before freeze or can pass while underrepresenting critical failure and transaction scenarios. Domains: `operations`, `correctness`, `schedule`, `external-dependency`.
- **Effort — L, 6–10 person-days, medium confidence:** Elapsed runtime is fixed; preparation, target scheduling, monitoring, failure triage, possible candidate fixes, and evidence review dominate person effort.
- **Depends on:** `roadmap.v1-03.migration-guide`
- **Risk controls:**
  - Freeze exact candidate bytes and scenario floors first.
  - Run release families concurrently only when target capacity permits.
  - Verify cleanup, resource return, and evidence integrity after each terminal run.
- **Deliverables:**
  - One 24-hour soak report per release family
  - Cross-soak resource and failure analysis
- **Acceptance criteria:**
  - Every supported release family reaches 24 continuous hours and its operation floor.
  - Mixed scenarios include required failure, cancellation, metadata, pooling, value, and transaction cases.
  - Resource growth, late replies, cleanup, and backend effects remain within reviewed budgets.

### Run the final Linux Node consumer matrix

- **ID:** `roadmap.v1-04.linux-node-consumer-matrix`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, repository-admin

Verify clean install, ESM, CommonJS, declarations, exports, content, SBOM, standalone, alias, and unchanged-CAP consumers on supported Linux and Node versions.

- **Importance — critical:** The portable JavaScript package and its three consumer shapes are the stable product contract, not merely a source-tree test result.
- **Risk — medium:** Loader, declaration, npm override, package-content, or Linux-specific behavior can differ from local development despite green source tests. Domains: `compatibility`, `supply-chain`, `operations`.
- **Effort — M, 4–7 person-days, high confidence:** The hosted pipeline and public consumer tests exist; stable candidate binding and full matrix review remain.
- **Depends on:** `roadmap.v1-03.migration-guide`
- **Risk controls:**
  - Install only the exact candidate tarball in clean hosted environments.
  - Use the package's pinned npm version and verify the complete dependency tree.
  - Attest ESM, CommonJS, TypeScript, aliases, and CAP independently.
- **Deliverables:**
  - Hosted Linux Node matrix
  - Three-consumer package evidence
- **Acceptance criteria:**
  - All supported Node versions install and execute the same exact tarball on the supported Linux runner.
  - ESM, CommonJS, TypeScript, aliases, and CAP override resolve the intended package bytes.
  - No native addon, SDK, lifecycle download, or runtime dependency enters the artifact.

### Qualify a production-like standalone adopter

- **ID:** `roadmap.v1-04.standalone-adopter`
- **Release role:** Required for 1.0
- **Execution:** external
- **Owners:** maintainer, adopter

Run a real or production-shaped standalone application through representative reads, values, pooling, failures, and operations using a pinned candidate artifact.

- **Importance — critical:** A stable standalone API needs evidence from application behavior and operations that synthetic conformance tests cannot fully model.
- **Risk — high:** A suitable adopter may be unavailable, may expose unmodeled operational requirements, or may require fixes that reset release evidence. Domains: `external-dependency`, `compatibility`, `operations`, `schedule`.
- **Effort — XL, 10–20 person-days, low confidence:** Integration support, adopter availability, representative workload selection, observability, issue fixing, and reruns dominate; calendar time is excluded.
- **Depends on:** `roadmap.v1-04.twenty-four-hour-soaks`, `roadmap.v1-04.linux-node-consumer-matrix`
- **Risk controls:**
  - Define a bounded synthetic-data canary contract before recruiting the adopter.
  - Keep credentials, identities, and business data outside retained evidence.
  - Schedule adoption before final release candidates so fixes remain affordable.
- **Deliverables:**
  - Standalone adopter contract
  - Redacted canary and operational acceptance
- **Acceptance criteria:**
  - The adopter uses only the documented stable root API and exact candidate artifact.
  - Representative success, failure, pooling, shutdown, and upgrade workflows pass.
  - No retained evidence contains credentials, identities, or business values.

### Qualify a production-like node-rfc migration

- **ID:** `roadmap.v1-04.node-rfc-adopter`
- **Release role:** Required for 1.0
- **Execution:** external
- **Owners:** maintainer, adopter

Migrate a representative archived node-rfc application by import change or npm alias and verify its required calls, values, lifecycle, errors, and operations.

- **Importance — high:** Archived node-rfc replacement is a major adoption path and needs application evidence beyond the bounded 105-case compatibility corpus.
- **Risk — high:** Applications may depend on undocumented native SDK behavior, global helpers, value quirks, or unsupported APIs outside the declared compatibility corpus. Domains: `compatibility`, `external-dependency`, `schedule`.
- **Effort — XL, 10–20 person-days, low confidence:** Effort varies with the adopter's native SDK assumptions, application test quality, unsupported surface, and issue-fix cycle; calendar time is excluded.
- **Depends on:** `roadmap.v1-04.twenty-four-hour-soaks`, `roadmap.v1-04.linux-node-consumer-matrix`
- **Risk controls:**
  - Inventory the adopter's actually used API and value surface before migration.
  - Keep unsupported SDK parity explicit and provide targeted migration guidance.
  - Add deterministic regressions for any accepted compatibility gap.
- **Deliverables:**
  - node-rfc adoption inventory
  - Migration canary and compatibility report
- **Acceptance criteria:**
  - The adopter's declared required surface is covered by tests and the stable support boundary.
  - The native addon and SDK are absent after migration.
  - Unsupported behavior is rejected or documented rather than silently emulated.

### Qualify a production-like unchanged-CAP adopter

- **ID:** `roadmap.v1-04.cap-adopter`
- **Release role:** Required for 1.0
- **Execution:** external
- **Owners:** maintainer, adopter, sap-operator

Run an unchanged @sap/cds-rfc application through the documented npm override with representative destination, lifecycle, transaction, isolation, and operational behavior.

- **Importance — critical:** Unchanged CAP compatibility is a selected consumer contract and a real adopter validates the boundary between open-rfc and SAP-owned application behavior.
- **Risk — high:** Destination resolution, CAP lifecycle, transaction use, multitenant context, or npm override behavior can expose integration gaps not present in connector-unit tests. Domains: `compatibility`, `security`, `external-dependency`, `schedule`.
- **Effort — XL, 12–25 person-days, low confidence:** A representative CAP application, destination infrastructure, identity contexts, npm override setup, and cross-layer issue triage drive the range.
- **Depends on:** `roadmap.v1-04.twenty-four-hour-soaks`, `roadmap.v1-04.linux-node-consumer-matrix`
- **Risk controls:**
  - Keep @sap/cds-rfc unchanged and replace only its low-level connector.
  - Exercise destination and principal contexts without reimplementing CAP behavior.
  - Pin the exact SAP package and npm version used for acceptance.
- **Deliverables:**
  - Unchanged-CAP adopter contract
  - Destination and lifecycle canary evidence
- **Acceptance criteria:**
  - The application keeps @sap/cds-rfc unchanged and uses the documented nested override.
  - Representative direct-route, destination, lifecycle, and selected transaction flows pass.
  - CAP-owned importer, Cloud SDK, multitenancy, and application semantics remain outside open-rfc claims.

### Freeze performance and resource budgets

- **ID:** `roadmap.v1-04.performance-budgets`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, adopter

Establish reproducible throughput, latency, allocation, pool, metadata-cache, and shutdown budgets from protocol benchmarks, soaks, and adopter observations.

- **Importance — high:** Stable operational guidance needs regression budgets even when the project does not promise a universal performance SLA.
- **Risk — medium:** Environment-sensitive numbers can create noisy CI or misleading universal claims if the benchmark contract is not carefully bounded. Domains: `operations`, `schedule`, `compatibility`.
- **Effort — M, 5–9 person-days, medium confidence:** Benchmark and resource harnesses exist; stable baselines, variance control, and adopter-informed thresholds remain.
- **Depends on:** `roadmap.v1-04.standalone-adopter`, `roadmap.v1-04.node-rfc-adopter`, `roadmap.v1-04.cap-adopter`
- **Risk controls:**
  - Separate deterministic protocol budgets from environment-sensitive live observations.
  - Use regression ratios and fixed hardware metadata where absolute values matter.
  - Document budgets as project gates rather than customer SLAs.
- **Deliverables:**
  - Stable performance budget manifest
  - Variance and regression policy
- **Acceptance criteria:**
  - Deterministic protocol and resource gates have reproducible thresholds.
  - Live and adopter measurements include environment context and no universal SLA claim.
  - Regressions beyond the budget block the release or receive an explicit reviewed decision.

### Pass two consecutive clean release candidates

- **ID:** `roadmap.v1-04.consecutive-release-candidates`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, release-owner, independent-reviewer

Build and fully qualify two successive candidate snapshots without support-boundary, stable API, default, or evidence-contract drift between them.

- **Importance — critical:** Two clean candidates demonstrate that the release process and stable boundary are repeatable rather than a one-off result.
- **Risk — high:** Late fixes, documentation changes, adopter findings, or dependency drift can reset exact-artifact evidence and extend the schedule significantly. Domains: `schedule`, `supply-chain`, `correctness`, `scope`.
- **Effort — L, 10–18 person-days, low confidence:** The cost depends on failures and change between candidates; the range includes full review and affected evidence reruns but excludes long external waits.
- **Depends on:** `roadmap.v1-04.twenty-four-hour-soaks`, `roadmap.v1-04.linux-node-consumer-matrix`, `roadmap.v1-04.performance-budgets`
- **Risk controls:**
  - Freeze the stable contract and dependencies before candidate one.
  - Allow only release-blocking fixes between candidates and rerun affected gates.
  - Compare complete API, defaults, support, artifact, and evidence inventories.
- **Deliverables:**
  - Two exact clean candidate decisions
  - No-drift comparison report
- **Acceptance criteria:**
  - Both candidates independently satisfy every required gate for their exact bytes.
  - Stable API, defaults, support boundary, and evidence contracts do not drift between candidates.
  - Any intervening fix is reviewed and triggers the complete affected rerun.

## V1-05 — Complete assurance and operations

Close supply-chain, security, correctness, findings, and operational readiness with current independent review of the frozen stable candidate.

Dependencies: `V1-04`.

Exit criteria:

- The candidate has reproducible artifact, SBOM, provenance, and release identities.
- Independent security and correctness reviewers complete their scopes and every release-blocking finding is closed.
- Operations, incident, reconciliation, recovery, upgrade, rollback, and support procedures are exercised and maintained.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-05.reproducible-supply-chain` Prove the reproducible supply chain | Required for 1.0 | proposed | critical | high | M | 4–7 person-days | high |
| `roadmap.v1-05.independent-security-review` Commission independent security review | Required for 1.0 | proposed | critical | critical | L | 10–20 person-days | low |
| `roadmap.v1-05.independent-correctness-review` Commission independent correctness review | Required for 1.0 | proposed | critical | critical | L | 10–20 person-days | low |
| `roadmap.v1-05.findings-closure` Close findings and rerun affected gates | Required for 1.0 | proposed | critical | critical | XL | 10–30 person-days | low |
| `roadmap.v1-05.operations-readiness` Exercise operations and incident readiness | Required for 1.0 | proposed | critical | high | L | 7–12 person-days | medium |

### Prove the reproducible supply chain

- **ID:** `roadmap.v1-05.reproducible-supply-chain`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, repository-admin, independent-reviewer

Bind source, package, tarball, SBOM, provenance, attestations, dependency closure, signatures, release assets, npm bytes, and documentation to the same candidate.

- **Importance — critical:** A stable release must let users verify that npm, GitHub, documentation, and source all describe the same portable SDK-free bytes.
- **Risk — high:** Artifact drift, unpinned toolchains, missing notices, or mismatched registry bytes can invalidate otherwise green product evidence. Domains: `supply-chain`, `security`, `operations`.
- **Effort — M, 4–7 person-days, high confidence:** The public release pipeline already implements most controls; v1 needs exact candidate rebinding and final independent verification.
- **Depends on:** `roadmap.v1-04.consecutive-release-candidates`
- **Risk controls:**
  - Use pinned build and documentation toolchains.
  - Reproduce and compare the exact tarball across release and registry channels.
  - Verify package shape, runtime closure, SBOM, notices, signatures, and attestations independently.
- **Deliverables:**
  - Candidate release-set identity
  - Reproducible SBOM and provenance report
- **Acceptance criteria:**
  - Source, GitHub Release, npm, SBOM, attestations, docs, and verification record name identical bytes.
  - The runtime package contains no native SDK, addon, download hook, secret, capture, or internal evidence artifact.
  - A clean verifier reproduces the artifact and validates notices and dependency closure.

### Commission independent security review

- **ID:** `roadmap.v1-05.independent-security-review`
- **Release role:** Required for 1.0
- **Execution:** external
- **Owners:** independent-reviewer, maintainer

Review authentication, secret handling, parsing, length limits, isolation, cancellation, no-replay, supply chain, diagnostics, and public security guidance against the exact candidate.

- **Importance — critical:** The connector handles credentials, untrusted protocol bytes, principal state, and business-effect ambiguity, so independent adversarial review is mandatory.
- **Risk — critical:** Parser, isolation, credential, denial-of-service, or retry defects could expose secrets, corrupt state, or create duplicate business effects. Domains: `security`, `correctness`, `supply-chain`, `external-dependency`.
- **Effort — L, 10–20 person-days, low confidence:** Reviewer availability, protocol depth, attack-surface breadth, questions, and retest cycles drive both maintainer and external effort; calendar wait is excluded.
- **Depends on:** `roadmap.v1-05.reproducible-supply-chain`
- **Risk controls:**
  - Use a reviewer independent of implementation and repository writes.
  - Provide exact candidate scope, threat boundaries, fuzz/fault corpora, and reproducible evidence.
  - Treat every confirmed high-severity finding as release-blocking.
- **Deliverables:**
  - Independent security report
  - Prioritized security findings
- **Acceptance criteria:**
  - The reviewer is independent of implementation and the exact candidate is in scope.
  - Credential, parser, isolation, resource, replay, and supply-chain boundaries are reviewed.
  - Findings include reproducible evidence without sensitive system data.

### Commission independent correctness review

- **ID:** `roadmap.v1-05.independent-correctness-review`
- **Release role:** Required for 1.0
- **Execution:** external
- **Owners:** independent-reviewer, maintainer

Review wire grammars, value projection, metadata, lifecycle, pool, transactions, compatibility, evidence derivation, API consistency, and documentation against the candidate.

- **Importance — critical:** A wire-compatible client can pass happy paths while remaining wrong on malformed responses, release variants, ambiguity, or compatibility edge cases.
- **Risk — critical:** A subtle grammar, metadata, value, lifecycle, or evidence-validation defect could make stable claims unsound or corrupt application data. Domains: `correctness`, `compatibility`, `external-dependency`.
- **Effort — L, 10–20 person-days, low confidence:** Protocol breadth, compatibility surface, evidence machinery, reviewer availability, and follow-up investigation determine the range.
- **Depends on:** `roadmap.v1-05.reproducible-supply-chain`
- **Risk controls:**
  - Use an independent reviewer with protocol and TypeScript runtime experience.
  - Trace each stable claim to malformed, boundary, property, fault, consumer, and live evidence.
  - Require deterministic regressions for every confirmed defect.
- **Deliverables:**
  - Independent correctness report
  - Prioritized correctness findings
- **Acceptance criteria:**
  - The reviewer is independent and evaluates the exact candidate rather than an ancestor.
  - Protocol, metadata, values, lifecycle, pool, transactions, consumers, API, and evidence claims are covered.
  - Every challenged claim resolves to evidence, a fix, or an explicit unsupported disposition.

### Close findings and rerun affected gates

- **ID:** `roadmap.v1-05.findings-closure`
- **Release role:** Required for 1.0
- **Execution:** implementation
- **Owners:** maintainer, independent-reviewer, sap-operator

Fix every confirmed finding, add deterministic regressions, rebuild the candidate if bytes change, and rerun every affected hardening, production, and assurance gate.

- **Importance — critical:** Review has no release value unless findings are resolved on the exact bytes ultimately published and affected evidence is repeated.
- **Risk — critical:** Late findings can invalidate candidates, adopter results, soaks, or the support contract and create an unpredictable final schedule. Domains: `correctness`, `security`, `schedule`, `supply-chain`.
- **Effort — XL, 10–30 person-days, low confidence:** The lower bound covers ordinary findings; the upper bound reflects protocol fixes, candidate rebuilds, and expensive affected live or soak reruns.
- **Depends on:** `roadmap.v1-05.independent-security-review`, `roadmap.v1-05.independent-correctness-review`
- **Risk controls:**
  - Run focused independent review before the most expensive final evidence where possible.
  - Map every change to affected gates and rerun from rebuilt exact bytes.
  - Block release on unresolved critical or high correctness, security, corruption, deadlock, allocation, disclosure, or replay findings.
- **Deliverables:**
  - Finding-to-regression closure ledger
  - Successor candidate and affected-gate rerun evidence
- **Acceptance criteria:**
  - Every confirmed finding has a disposition and reproducible regression where applicable.
  - No release-blocking finding remains open or risk-accepted implicitly.
  - Every changed input has fresh exact-candidate evidence for all affected gates.

### Exercise operations and incident readiness

- **ID:** `roadmap.v1-05.operations-readiness`
- **Release role:** Required for 1.0
- **Execution:** policy
- **Owners:** maintainer, adopter, independent-reviewer

Finalize and exercise monitoring, diagnostics, redaction, capacity, shutdown, incident, uncertain-effect reconciliation, recovery, upgrade, rollback, and support procedures.

- **Importance — critical:** Stable users need safe procedures for failure and uncertain business effects, not only an API that works during normal calls.
- **Risk — high:** Incomplete incident or reconciliation guidance can cause credential disclosure, unsafe retry, duplicate effects, prolonged outage, or failed rollback. Domains: `operations`, `security`, `correctness`.
- **Effort — L, 7–12 person-days, medium confidence:** Many procedures exist; the remaining work is consolidation, stable support alignment, drills, executable checks, and adopter feedback.
- **Depends on:** `roadmap.v1-05.findings-closure`
- **Risk controls:**
  - Run tabletop and executable drills for timeout, cancellation, fatal disconnect, resource exhaustion, upgrade, and rollback.
  - Use fixed redacted diagnostics and application-owned private handlers.
  - Make uncertain-effect reconciliation a prerequisite to any retry.
- **Deliverables:**
  - Stable operations and incident manual
  - Completed recovery, upgrade, and rollback drills
- **Acceptance criteria:**
  - Operators can distinguish validation, logon, authorization, timeout, cancellation, fatal, and uncertain-send outcomes safely.
  - Incident and recovery drills preserve redaction, cleanup, reconciliation, and zero replay.
  - Upgrade and rollback restore matching package, lockfile, configuration, documentation, and support records.

## V1-06 — Release and verify 1.0.0

Freeze one exact stable release set, run the final all-gates decision, obtain explicit authorization, publish through the established pipeline, and verify the public result.

Dependencies: `V1-05`.

Exit criteria:

- One exact 1.0.0 release set passes every required roadmap item and final independent verification.
- Repository, tag, release, npm, Pages, documentation, SBOM, provenance, and support records agree on the same bytes.
- The release owner authorizes the exact release and the post-release observation window closes without an unresolved blocker.

| Item | Role | Status | Importance | Risk | Effort | Estimate | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roadmap.v1-06.release-input-freeze` Freeze the 1.0.0 release inputs | Required for 1.0 | proposed | critical | high | M | 3–5 person-days | high |
| `roadmap.v1-06.final-qualification` Run final all-gates qualification | Required for 1.0 | proposed | critical | critical | XL | 10–20 person-days | low |
| `roadmap.v1-06.repository-release-controls` Verify repository and release controls | Required for 1.0 | proposed | critical | high | M | 3–5 person-days | high |
| `roadmap.v1-06.go-no-go` Approve the exact go/no-go decision | Required for 1.0 | proposed | critical | high | S | 2–4 person-days | high |
| `roadmap.v1-06.publish-and-observe` Publish, verify, and observe 1.0.0 | Required for 1.0 | proposed | critical | high | M | 3–6 person-days | medium |

### Freeze the 1.0.0 release inputs

- **ID:** `roadmap.v1-06.release-input-freeze`
- **Release role:** Required for 1.0
- **Execution:** release
- **Owners:** maintainer, release-owner

Finalize version, changelog, migration guide, stable API snapshot, defaults, support matrix, notices, documentation, workflow pins, and release notes before the last qualification.

- **Importance — critical:** Any tracked release-input change after qualification creates different bytes and invalidates the evidence that was meant to authorize publication.
- **Risk — high:** Late wording, version, notice, workflow, or documentation changes can trigger a full artifact and affected-evidence rerun. Domains: `schedule`, `supply-chain`, `scope`.
- **Effort — M, 3–5 person-days, high confidence:** The pipeline and templates exist; effort is final stable-content review and exact inventory freeze.
- **Depends on:** `roadmap.v1-05.operations-readiness`
- **Risk controls:**
  - Use a complete release-input checklist and freeze it before final qualification.
  - Render package and documentation facts from exact manifests.
  - Reject unreviewed files or changed toolchain pins.
- **Deliverables:**
  - Frozen 1.0.0 release inventory
  - Final changelog, migration, support, and release notes
- **Acceptance criteria:**
  - Every user-facing version, API, default, support, migration, and artifact fact is final.
  - The complete release input inventory is exact and reviewable.
  - No qualification begins while a known release-input edit remains.

### Run final all-gates qualification

- **ID:** `roadmap.v1-06.final-qualification`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** maintainer, independent-reviewer, sap-operator, repository-admin

Build the frozen 1.0.0 candidate and rerun every required gate, consumer, soak, adopter binding, supply-chain check, documentation check, and independent final review.

- **Importance — critical:** The stable release decision must apply to the exact bytes published, not to a sequence of mostly similar candidates.
- **Risk — critical:** A late failure can require a new candidate and rerun, while accepting mixed artifacts would make the release claim unsound. Domains: `correctness`, `security`, `supply-chain`, `schedule`.
- **Effort — XL, 10–20 person-days, low confidence:** The lower bound assumes a green frozen candidate; failures, long reruns, live windows, and final independent review drive the upper bound.
- **Depends on:** `roadmap.v1-06.release-input-freeze`
- **Risk controls:**
  - Use one exact source commit and artifact across every final gate.
  - Fail closed on missing, skipped, deferred, development, dirty, mismatched, or non-passing evidence.
  - Rebuild and rerun affected gates after any fix.
- **Deliverables:**
  - Exact 1.0.0 candidate decision
  - Complete final evidence index
- **Acceptance criteria:**
  - Every required roadmap item is done and verified for the exact candidate.
  - Conditional items not selected remain explicitly unsupported and do not masquerade as passes.
  - The final independent reviewer approves the exact candidate after the last change.

### Verify repository and release controls

- **ID:** `roadmap.v1-06.repository-release-controls`
- **Release role:** Required for 1.0
- **Execution:** evidence
- **Owners:** repository-admin, independent-reviewer

Verify protected branches and tags, required checks and reviews, pinned Actions, dependency and security features, trusted publishing, Pages, and no-bypass release settings.

- **Importance — critical:** A correct artifact can still be replaced, bypassed, or published inconsistently if repository and registry controls are not enforced.
- **Risk — high:** Misconfigured rulesets, mutable tags, unpinned workflows, or broad publisher credentials can break the verified release chain. Domains: `security`, `supply-chain`, `operations`.
- **Effort — M, 3–5 person-days, high confidence:** The public repository and release pipeline already run; the task is stable-release control review and exact evidence capture.
- **Depends on:** `roadmap.v1-06.final-qualification`
- **Risk controls:**
  - Require no-bypass main and tag rules with reviewed checks.
  - Pin third-party Actions and use trusted publishing with least privilege.
  - Capture repository-control evidence immediately before release.
- **Deliverables:**
  - Repository-control evidence
  - Trusted publishing and Pages verification
- **Acceptance criteria:**
  - Main and release tags reject force-push and unreviewed bypass.
  - Required workflows and third-party Actions are pinned and least-privileged.
  - Trusted publishing and Pages deploy only the approved exact release set.

### Approve the exact go/no-go decision

- **ID:** `roadmap.v1-06.go-no-go`
- **Release role:** Required for 1.0
- **Execution:** decision
- **Owners:** release-owner, maintainer, independent-reviewer

Present the complete gate decision, residual risks, conditional exclusions, support obligations, and exact release identity for explicit owner authorization.

- **Importance — critical:** Publishing 1.0 creates durable compatibility and support commitments that require an explicit decision on exact bytes and residual risk.
- **Risk — high:** A vague approval can hide deferred required work, scope ambiguity, or release identity drift between review and publication. Domains: `scope`, `operations`, `supply-chain`.
- **Effort — S, 2–4 person-days, high confidence:** The work is evidence review and decision preparation; unresolved findings or scope disputes would return to earlier gates rather than enlarge this item.
- **Depends on:** `roadmap.v1-06.final-qualification`, `roadmap.v1-06.repository-release-controls`
- **Risk controls:**
  - Bind authorization to the exact source, artifact, evidence index, support matrix, and residual-risk list.
  - Keep every conditional or post-v1 capability visibly unsupported.
  - Require a new decision after any release-input change.
- **Deliverables:**
  - Exact 1.0.0 go/no-go record
  - Reviewed residual-risk and exclusion list
- **Acceptance criteria:**
  - The decision names one exact source commit, artifact, evidence index, and support contract.
  - Every required gate is green and every conditional exclusion remains explicit.
  - The release owner gives explicit authorization after independent final review.

### Publish, verify, and observe 1.0.0

- **ID:** `roadmap.v1-06.publish-and-observe`
- **Release role:** Required for 1.0
- **Execution:** release
- **Owners:** release-owner, repository-admin, maintainer

Publish through the established GitHub, npm, and Pages pipeline, verify exact byte identity and documentation, then complete a bounded post-release observation and rollback window.

- **Importance — critical:** The release is not complete until every public channel agrees on exact bytes and early adopter failures can be detected and handled safely.
- **Risk — high:** Registry, release asset, tag, documentation, or support-record mismatch can distribute unverifiable bytes; early defects may require rapid rollback or replacement. Domains: `supply-chain`, `operations`, `security`, `schedule`.
- **Effort — M, 3–6 person-days, medium confidence:** Automation exists; final verification, release notes, documentation propagation, observation, and potential incident handling determine the range.
- **Depends on:** `roadmap.v1-06.go-no-go`
- **Risk controls:**
  - Publish only after exact authorization through trusted automation.
  - Immediately compare GitHub and npm bytes, integrity, SBOM, provenance, docs, and tag.
  - Keep a staffed observation window with predefined stop, rollback, and incident criteria.
- **Deliverables:**
  - Published and byte-verified 1.0.0 release
  - Post-release observation record
- **Acceptance criteria:**
  - GitHub Release, npm, tag, SBOM, provenance, documentation, and support record identify the same bytes.
  - Clean standalone, alias, and CAP verification succeeds from the public npm artifact.
  - The observation window closes without an unresolved release blocker or executes the documented rollback plan.

## What 1.0 does not imply

Version 1.0 will stabilize the reviewed support boundary; it will not imply complete SAP NW RFC SDK parity. Server/callback mode, tRFC, qRFC, bgRFC, Throughput, SNC/X.509, non-Unicode/MDMP, basXML, WebSocket RFC, Cloud Connector principal propagation, message-server routing, and SAProuter remain unsupported unless their conditional roadmap items are explicitly promoted and pass their complete acceptance evidence.
