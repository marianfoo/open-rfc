# Deep Feature — research whether it fits, then build it

Take a feature request — a message, a GitHub issue, a discussion, a PR someone
opened — and work out whether and how it fits **this** architecture before
writing code. Then design it, build it, prove it, and ship it as a pull request.

The first half is the work. This is an SDK-free client for a protocol with no
public specification: nearly every capability question is answerable only from
recorded evidence or a live system, and the wrong shape is expensive to undo once
it is in the published API. A feature that looks small can require a wire
capability nobody has ever observed.

Works for Claude (`/deep-feature`) and for Codex (point it at this file:
`follow .claude/commands/deep-feature.md`). Nothing here depends on which runs it.

---

## Which repository

**You are in it.** `marianfoo/open-rfc` is where the shipped code lives, where
CI runs, where review happens, and where release-please turns a merged `feat:`
into a published version. Branch here, build here, open the pull request here.

Plans and research notes go with the change: `docs/plans/<slug>.md` moving to
`docs/plans/completed/<slug>.md`, and `docs/research/<slug>.md`.

A maintainer may have further evidence sources configured locally. **If
`CLAUDE.local.md` exists in this checkout, read it first** — it names what is
available and the rules for using it. If it does not exist, everything below
works from this repository alone.

---

## Input

An issue number or URL, a PR, or a description. If the request is a solution
rather than a need ("add a connection pool option"), ask what problem it solves.
The architecture question is answerable only against a need.

---

## The prime directive

**Decide whether it fits before deciding how to build it.** Three questions, in
order, and each can end the work:

1. **Does the protocol support it?** Not "is it a good idea" — can the wire do
   it, and is there evidence it can? An unobserved capability is a research
   project, not a feature.
2. **Does it fit the published surface?** This package ships a node-rfc
   compatibility facade plus its own API. A feature that forces a breaking change
   to either is a different, larger decision.
3. **What does it cost to keep correct?** Every accepted coordinate becomes
   something that must stay true across two SAP releases and every future change.

Answering "no" to the first is a complete and useful outcome. Say so with the
evidence and stop.

---

## Research sources

| Source | Where | Use it for |
|--------|-------|------------|
| **Project rules** | `AGENTS.md` | The build, test and contribution rules that apply to this change |
| **Architecture** | `docs/architecture.md` | Layer boundaries, ownership invariants, the implementation ladder, the evidence hierarchy. Read before proposing anything that cuts across it |
| **The recurring bug class** | `docs/recurring-bug-class.md` | The decoder mistake this project has made six times. A new decoder gets reviewed against it |
| **Capability boundary** | `docs_page/status.md`, `docs_page/policies.md`, `conformance/` | What is claimed to work, on which release. A feature claim must land here truthfully |
| **Completed plans** | `docs/plans/completed/` | How similar features were actually researched, built and verified |
| **Prior research** | `docs/research/` | Whether this was already investigated. Several questions have a recorded "not feasible, here is why" |
| **The published surface** | `src/index.ts`, `src/compat/`, `docs_page/api.md` | Exactly what is exported today, and what a change would move |
| **SAP docs & Notes** | `sap-docs` and `sap-notes` MCP tools | Official documentation and SAP Notes. A Note that changes behaviour per release is decisive and must be cited by number |

Anything further is maintainer-local; see `CLAUDE.local.md` if it exists.

---

## Phase 1 — deep research

1. **Has this been asked before?** Search `docs/`, any source named in
   `CLAUDE.local.md`, and the git history. A recorded "we considered this and rejected it" is the fastest
   possible answer — but check whether its premise still holds. One deliberate
   decision here was correct when written and false a month later, and nobody
   re-checked it for three weeks.
2. **What does the wire actually do?** Look for captured payloads in
   `conformance/` and `fixtures/` before assuming. If the capability has never
   been observed, say so plainly — that is the finding.
3. **How do the declared reference implementations expose the same concept?**
   This matters for naming and for the compatibility facade.
4. **What do SAP's own docs and Notes say?** Use the MCP tools. A Note that
   changes behaviour per release is decisive and must be cited.
5. **Where would it live?** Name the modules. If the answer crosses more than two
   or three, the feature is probably two features.

---

## Phase 1 exit gate — all must be YES before designing

- [ ] Prior research searched, and either cited or confirmed absent — say which
- [ ] Wire support established from recorded evidence, or explicitly recorded as
      unobserved
- [ ] Both SAP releases considered, not just the convenient one
- [ ] Effect on the published API surface stated — additive, or breaking
- [ ] Effect on the node-rfc facade stated, or explicitly none
- [ ] The modules it touches named
- [ ] Any existing decision record on this area read, and its premise re-checked

---

## Phase 2 — spike before designing, if the wire is uncertain

If Phase 1 could not establish wire support from recorded evidence, spike it
**before** writing a plan. A design built on an assumed capability is wasted.

- Offline first, against fixtures. Most questions are answerable without a live
  call, and an offline spike can be iterated.
- Live only if offline cannot answer it, and only where a live system is
  configured: **read-only**, one run, both supported releases if the answer might
  differ. Never replay an uncertain or timed-out call.
- Record what you found in `docs/research/<slug>.md` — the question, the method,
  the result, and what it does **not** establish. A spike that answers a narrower
  question than it appears to is worse than none.

---

## Phase 3 — plan

Write `docs/plans/<slug>.md`:

- the need, and what makes it a real need rather than a preference
- the approach, and the alternatives rejected with reasons
- the API surface: exactly what is added, and whether anything changes
- the capability claim: which release, backed by which evidence
- the tests, named
- **what is given up**, stated plainly — every design has a cost, and a plan that
  names none has not been thought through
- what is explicitly out of scope

Design rules this codebase holds to:

- **Bound what varies by nature; keep structure strict.** Never memorise a shape.
  If a new decoder pins a length, a count or a value range, justify it in the
  plan or it is the recurring bug class arriving fresh.
- **Fail closed.** A capability that cannot be verified must refuse, not guess.
- **A reader may accept more than the writer emits.** That asymmetry is correct.
- **Additive beats breaking**, especially in the published surface and the
  node-rfc facade.

---

## Phase 4 — implement

Follow the plan. When you deviate, say so in the plan rather than silently.

Every feature carries:

- **A property test** over the full legal range of anything the peer controls —
  lengths, values, orderings. Not one example.
- **A fail-closed regression** proving malformed or unsupported input is refused,
  with the right error.
- **A round-trip test** where the feature both reads and writes.
- **Control-test the tests**: revert the implementation and confirm they fail. A
  test that has never failed is not yet a test.

---

## Phase 5 — verify

Run one test while iterating:

```bash
node --test test/<name>.test.mjs
```

```bash
npm run build && node --test dist/test/<name>.test.js
```

Then the full suite before pushing:

```bash
npm run test:public
```

- Report **pass / fail / skipped as numbers**.
- **One suite at a time**; `npm run build` deletes `dist/` first and overlapping
  runs produce phantom failures.
- A failing test: **run it at the parent commit before assuming it is yours.**
- API surface moved: `node tools/public_api_snapshot.mjs write`, and say what
  changed. Conformance aborts the suite otherwise.
- `npm run lint`, and `npm run check:docs:public` if documentation changed.
  `npm run docs:site:check` is a CI-only check — see `AGENTS.md` for why.
- Update the published capability record — `docs_page/status.md` and
  `docs_page/policies.md` — so the claim matches what is proven, on the releases
  it is proven on. Maintainers keep a fuller record; see `CLAUDE.local.md`.
- Live verification if the feature is on a live path: once, on both supported
  releases if their behaviour could differ.

### Run only what your change can break

Most changes cannot reach most of the suite, and this repository classifies that:

```bash
node --input-type=module -e 'const {classifyCiChangeRange} = await import("./tools/ci_change_scope.mjs"); console.log(classifyCiChangeRange({base: "<base-sha>", head: "<head-sha>"}))'
```

`product: false` means every changed path is documentation or agent process.
Run the full suite before pushing anything touching `src/`, `tools/`, `test/`,
`conformance/` or a manifest — and always before reporting numbers, because the
numbers must come from a run of the tree you are pushing.

---

## Phase 6 — ship

Move the plan to `docs/plans/completed/<slug>.md` with an outcome section: what
was built, what the control tests showed, what changed from the plan and why.

A pull request with: the need, the research that established feasibility, the
design and its rejected alternatives, what is given up, the capability claim,
the control-test result, and the suite numbers.

`feat:` for a new capability. Below 1.0 this repository maps `fix:` and `feat:`
to a patch bump and breaking changes to a minor bump — `bump-minor-pre-major`
and `bump-patch-for-minor-pre-major` in `release-please-config.json`, both to be
dropped at 1.0.

Sign every commit — `git commit -s`. The DCO check is required.

---

## Guardrails

- **Never** print, commit or retain credentials, endpoints, system identities,
  business data or returned rows. Assert on shape and status, never content.
- Read-only SAP calls by default. Ask before installing repository objects,
  mutating fixtures, or running update-task work — those change a real system.
- **Never replay an uncertain or timed-out live call.**
- Reference implementations are limited to the ones `CONTRIBUTING.md` and
  `THIRD_PARTY_NOTICES.md` already declare. Do not introduce a new one without
  declaring it and its license.
- Publishing, repository visibility, GitHub releases and `npm publish` are the
  owner's alone.

## Method rules this project paid for

- **Parse the emitted artifact in `dist/`, never the TypeScript source.** Source
  regex under-counted five separate times.
- **Control-test every scanner against a known-present case before trusting a
  zero.** Eleven silent under-counts, every one failing toward a clean bill of
  health.
- **A control that cannot fail proves nothing.** Remove something the assertion
  matches; do not append something it ignores.
- **Match on context, not vocabulary.** A content scan once flagged two files
  for a term that appeared in them only inside the sentence forbidding it. A
  keyword hit orders the reading queue; it is not a finding.
- **State the scope of a query and do not exceed it.** A search scoped to one
  library was used to conclude something about every obligation, and missed a
  whole category.
- **Stage new files before measuring them.** Tooling that reads `git ls-files`
  sees nothing untracked and will confidently report the old number.
- **Compare siblings.** Divergence between two implementations of the same idea
  has found real defects repeatedly; the narrow one is usually wrong.
- **A checkout whose origin no longer resolves is not evidence.** Verify remotes.
- **Do not use `git checkout --` to undo a control test** — it discards
  uncommitted work. Copy the file aside and restore from the copy.
- **Report what you did NOT cover.** A silent cap reads as "covered everything".
