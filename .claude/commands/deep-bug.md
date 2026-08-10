# Deep Bug — find the real root cause, then fix it with evidence

Take a bug — a message, a GitHub issue, a failing PR, a report from a user — and
find **why** it actually happens before anything is changed. Then fix that, prove
the fix, and ship it as a pull request.

The point is the first half. This project lost three weeks replacing working code
because `RFC_INVALID_PROTOCOL` was read as "SAP rejected the password". It had
not. The password producer was fine — three successful authentications with it
were sitting in the project's own records the whole time — and the real defect
was a response parser that pinned exact byte lengths on a hostname. Nobody had
queried the evidence that already existed.

Works for Claude (`/deep-bug`) and for Codex (point it at this file:
`follow .claude/commands/deep-bug.md`). Nothing here depends on which one runs it.

---

## Which repository

**You are in it.** `marianfoo/open-rfc` is where the shipped code lives, where
CI runs, where review happens, and where release-please turns a merged `fix:`
into a published version. Branch here, fix here, open the pull request here.

Plans and research notes go with the change: `docs/plans/<slug>.md` moving to
`docs/plans/completed/<slug>.md`, and `docs/research/<slug>.md`.

**The research repository is a read-only reference at `~/DEV/open-rfc`.** It
holds what cannot be published: recorded wire evidence, fixtures, the approved
upstream trees, live-system credentials and runbooks, and the internal decision
records. Read it freely. Never fix shipped code there, and never copy a source
file from it into here — this repository is authoritative for everything under
`src/`.

Live SAP work is the one thing that must happen over there, because the
credentials and evidence tooling are there. The fix still lands here.

---

## Input

An issue number or URL, a PR number, a failing test name, or a plain description.
If the description is vague ("metadata is broken"), ask for one concrete failing
case first — a call, an input, an error string. A symptom you cannot reproduce is
not yet a bug report.

---

## The prime directive

**No hypothesis before the evidence.** Recorded wire observations, live
conformance results, decision records and fixtures already exist. Read what is
there before forming a theory.

Concretely, before you write down a cause:

- Search `docs/` here, then `docs/` and `conformance/` in the research
  repository, for the coordinate, the error code, the function module, the
  release.
- Search the git history for when the code was written and why.
- Look for a **sibling implementation** and compare. This project has two xRFC
  codecs, two session providers, two metadata readers. Divergence between
  siblings has found real bugs three times; the narrow one is usually wrong.

If the evidence contradicts the report, say so with the citation. A reporter
saying "the password is rejected" is a lead, not a fact.

---

## Research sources

`~/DEV/*` is a **read-only reference** — never modify it.

### Here

| Source | Where | Use it for |
|--------|-------|------------|
| **Project rules** | `AGENTS.md` | The build, test and contribution rules that apply to this change |
| **Architecture** | `docs/architecture.md` | Layer boundaries, ownership invariants, the evidence hierarchy |
| **The recurring bug class** | `docs/recurring-bug-class.md` | Read this before touching any decoder |
| **Completed plans** | `docs/plans/completed/` | How similar work was researched, built and verified |
| **The code and its tests** | `src/`, `test/` | 60 of 64 modules have a test naming them; the sibling you need is usually here |

### In the research repository (`~/DEV/open-rfc`)

| Source | Where | Use it for |
|--------|-------|------------|
| **Engineering decisions** | `docs/engineering-decisions-and-learnings.md` | Why the code is shaped this way — and check whether the decision's premise still holds |
| **Prior research** | `docs/*.md` — wire observations, live qualification records, `compatibility-matrix.md`, `live-conformance-matrix.md` | Ground truth already established, per release. Do not re-derive it |
| **Recorded evidence** | `conformance/` — upstream cases, evidence corpora | Captured payloads and per-release facts |
| **Fixtures** | `fixtures/`, `test/fixtures/` | Recorded wire data you can replay offline |
| **Approved upstream only** | `upstream/node-rfc` @ `9ccc30b7` and `upstream/PyRFC` @ `5d4a20a5` — **these two and no others** | The node-rfc compatibility surface. Every other tree under `upstream/` is off limits; `pysap` in particular is GPL-2.0 and opening it contaminates a clean-room position |
| **Live SAP systems** | `.env.live-s4hana-2023`, `.env.live-netweaver-750`; `npm run test:e2e` | Ground truth when docs and code disagree. Read-only, one run, never replayed |

**SAP docs & Notes** — the `sap-docs` and `sap-notes` MCP tools, from either
repository. Cite the Note number when behaviour depends on one;
`ddif-fieldinfo.ts` already cites Note 1691982 and that citation settled a real
question.

---

## Phase 1 — reproduce and locate

1. Reproduce offline first, from a fixture or a unit test. A bug you can only see
   against a live system is a bug you cannot iterate on.
2. Find the exact line that produces the observed behaviour. Not the area — the
   line. Read the surrounding function fully; the cause is often three lines
   above the throw.
3. Establish which releases and inputs are affected, and which are not. "It fails
   for me" plus "it works here" is the signature of the bug class below.

### The bug class that keeps recurring here — check for it first

**A decoder that memorises what one system happened to send.** Six instances,
five of them in a single day. The full account with the fixed code is in
[`docs/recurring-bug-class.md`](../../docs/recurring-bug-class.md):

| Coordinate | Pinned | Broke for |
|---|---|---|
| initial logon reply | exact byte lengths of text fields | any host whose name is a different length |
| `RFC_FUNINT` rows | exactly 402 bytes | any release that appends a field |
| `RFC_FIELDS` rows | exactly 138 bytes | same |
| dispatcher port | 3200–3299 | any port-offset landscape |
| `COMPTYPE` | only `"E"` | components declared with a built-in DDIC type |
| XML character refs | digit *count*, not value | conforming zero-padded references |

The tell is a comparison against a literal, or a fixed list of accepted shapes,
sitting on something that varies by peer, release or configuration. If the bug
looks like "works on my system", look here before anywhere else.

---

## Phase 1 exit gate — all must be YES before proposing a cause

- [ ] Reproduced offline, from a fixture or test rather than a live call
- [ ] The exact line identified, and the whole function read
- [ ] Prior evidence searched in both repositories, and either cited or
      confirmed absent — "I did not find one" stated explicitly
- [ ] Sibling implementations compared, where one exists
- [ ] Affected releases and inputs stated, with what is *not* affected
- [ ] Any existing decision record on this coordinate read, and its premise
      checked against what you now know

---

## Phase 2 — decide the fix

State the cause in one sentence. If you cannot, you are still in Phase 1.

Then choose, and say which:

1. **Genuinely correct as written** — leave it, and record why. This is a real
   outcome. Not every refusal is a bug: fixed-width fields, DoS bounds and
   fail-closed guards are all legitimate.
2. **Same bug, fix it** — bound what varies by nature, keep every structural
   check strict. Widening a length bound is not permission to accept malformed
   input.
3. **Unclear** — flag it with the evidence rather than guessing. Say what would
   settle it. `recursive-xrfc.ts` carried a flagged item for a day before a
   captured payload settled it, and that was the right call.

**Never add another memorised case.** Adding a seventh layout because the sixth
did not match is the bug repeating, not a fix.

---

## Phase 3 — implement, with tests that can fail

Write `docs/plans/<slug>.md` first when the change is non-trivial: the cause, the
approach, what is kept, what is given up, and the tests. Move it to
`docs/plans/completed/<slug>.md` with an outcome section when done. Put
supporting measurement in `docs/research/<slug>.md`.

Every fix carries **both**:

- **A property test** over the full legal range of whatever varied. Same
  structure, every legal length or value, must decode identically. This single
  test shape would have caught four of the six bugs above on the day they were
  written.
- **A fail-closed regression** proving malformed input is still refused —
  unknown tag, wrong order, truncation, duplication, out-of-range.

**Then control-test the tests.** Revert the fix and re-run:

- The property test **must fail**. If it passes without the fix, it tests nothing.
- The fail-closed tests will usually pass in both states — that is correct, they
  guard the bound rather than the fix.
- If a fail-closed test *also* fails without the fix, look closely: it usually
  means the old code refused the input **for the wrong reason**. That is worth
  recording, because an incidental refusal is one you cannot rely on.

---

## Phase 4 — verify

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

- Report **pass / fail / skipped as numbers**. Never report "green" without them.
- **One suite at a time.** `npm run build` deletes `dist/` first, so two
  overlapping runs wipe each other and produce phantom failures. Check the
  process count before and after.
- If a test fails, **run it at the parent commit before assuming it is yours.**
  Two failures in one day were a hardcoded expiry date coming due, not a
  regression.
- If the public API surface moved, run `node tools/public_api_snapshot.mjs write`
  and say what was added or removed. Conformance aborts the suite otherwise.
- `npm run lint`, and `npm run check:docs:public` if documentation changed.
  `npm run docs:site:check` is a CI-only check — see `AGENTS.md` for why.
- Live verification only when the fix is on a live path, and only from the
  research repository: `npm run test:e2e`, **once**. Not in a loop, never after
  a timeout, never replaying an uncertain call.

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

## Phase 5 — ship

A pull request with: the failing case, the root cause, why the fix is the fix,
what was deliberately left alone, the control-test result, and the suite numbers.
Link the plan and research documents.

Conventional commit type decides the version. Below 1.0 this repository maps
`fix:` and `feat:` to a patch bump and breaking changes to a minor bump; that is
`bump-minor-pre-major` and `bump-patch-for-minor-pre-major` in
`release-please-config.json`, and both must be dropped at 1.0.

Sign every commit — `git commit -s`. The DCO check is required.

---

## Guardrails

- **Never** print, commit or retain credentials, endpoints, system identities,
  business data or returned rows. Assert on shape and status, never content.
- Read-only SAP calls by default. Ask before installing repository objects,
  mutating fixtures, or running update-task work.
- **Never replay an uncertain or timed-out live call.** Failed authentications
  count toward locking a real account.
- Never open `upstream/` trees other than `node-rfc` and `PyRFC`.
- Publishing, repository visibility, GitHub releases and `npm publish` are the
  owner's alone.

## Method rules this project paid for

- **Parse the emitted artifact in `dist/`, never the TypeScript source.** Source
  regex under-counted five separate times.
- **Control-test every scanner against a known-present case before trusting a
  zero.** Eleven silent under-counts happened here, every one failing toward a
  clean bill of health.
- **A control that cannot fail proves nothing.** Appending a comment to a file is
  not a control for an assertion that matches a string; remove the string.
- **Match on context, not vocabulary.** A scan for private content flagged two
  documents for the word "decompilation" — which appeared in the sentence
  prohibiting it. A keyword hit orders the reading queue; it is not a finding.
- **State the scope of a query, and do not exceed it.** A search restricted to
  one library's records was used to conclude something about *all* notice
  obligations, and missed an entire category.
- **Stage new files before measuring them.** Tooling that reads `git ls-files`
  sees nothing untracked and will confidently report the old number.
- **A checkout whose origin no longer resolves is not evidence** about the
  project it came from. Verify the remote.
- **Do not use `git checkout --` to undo a control test.** It restores the
  committed file and silently discards uncommitted work. Copy the file aside and
  restore from the copy.
- `git grep -E` has no `\b` in POSIX ERE. zsh expands `${VAR}:t` and `$VAR:src`
  as history modifiers — write scanner scripts to a file.
- **Report what you did NOT cover.** A silent cap reads as "covered everything".
