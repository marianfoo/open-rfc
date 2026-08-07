# Plan: accept zero-padded XML character references

Research: [`docs/research/xml-character-reference-widths.md`](../../research/xml-character-reference-widths.md)

## Goal

`decodeXmlEntityReference` accepts any conforming character reference regardless
of how it is padded, and still refuses a digit run long enough to be a cost.

## Approach

Separate the two jobs the current pattern conflates.

1. **Bound the raw run** — a generous cap that exists only to stop an unbounded
   slice and parse. It should be far above any legitimate spelling, so it never
   decides whether conforming input is accepted.
2. **Decide legality by value** — strip leading zeros, parse, and let the
   existing scalar-range check reject anything out of range. That check already
   rejects surrogates and anything above `U+10FFFF`, so it is the right place
   for the decision and needs no change.

The raw cap is set at 32 characters for both forms. The largest conforming
reference anyone writes deliberately is `&#x10FFFF;` at six hex digits or
`&#1114111;` at seven decimal digits; 32 leaves room for any plausible padding
while keeping the parsed run trivially small.

Stripping leading zeros from a run of all zeros must leave `"0"`, not the empty
string, so `&#0;` and `&#x0;` keep decoding to U+0000 — the readers admit C0
controls in reference position because our own writer emits `&#00;`.

## Changes

Only `src/values/unicode-scalar.ts`. Both call sites in the xRFC readers are
unchanged: they already apply their own code-point policy on top and are
unaffected by how the reference was spelled.

## Tests

Added to the existing xRFC entity coverage.

- **Padding is transparent.** For a representative set of code points, every
  zero-padded spelling from the minimum width up to the raw cap decodes to the
  same scalar as the unpadded spelling. This is the property that was broken.
- **`&#0;` and `&#x0;` still decode to U+0000**, and so do their padded forms.
- **The maximum scalar padded**: `&#x00010FFFF;` decodes to U+10FFFF.
- **Fail-closed regressions, which must not loosen:**
  - a run above the raw cap is refused
  - an out-of-range value is refused however it is padded — `&#x0000110000;`
  - a surrogate is refused however it is padded — `&#x00D800;`
  - an empty reference, an unterminated reference, and an unknown named entity
    are all still refused
- **Control the tests.** Revert the change and confirm the padding tests fail
  and the fail-closed tests still pass. A fail-closed test that passes in both
  states is guarding the bound rather than the fix, which is correct; a padding
  test that passes in both states would mean it never tested anything.

## Verification

- `npm run test:public`, `npm run lint`, `npm run check:docs:public`
- Round-trip unchanged: what our writers emit still parses to the same values.

## Release

A `fix:` commit. Under this repository's release-please configuration
(`bump-patch-for-minor-pre-major`), that is a patch bump: **0.2.0 → 0.2.1**.

## Out of scope

The writers, the code-point policies in either reader, and the structural
grammar limits recorded as open questions elsewhere. This plan changes how a
reference is *spelled*, not which characters are admitted.

---

## Outcome

Implemented in `src/values/unicode-scalar.ts`. The width-bounded patterns became
a shared `characterReferenceValue` helper: it bounds the raw run at 32
characters, strips leading zeros, and parses the significant digits. The existing
scalar-range check was already in the right place and is unchanged.

`test/xml-entity-reference.test.ts` — eight tests, discovered automatically by
the public suite because compiled tests are enumerated from `dist/test`.

### The control test found something the plan predicted wrong

The plan expected the fail-closed tests to pass in both states. Three did. Two
did not, and the reason is worth recording.

Reverting the fix left this:

| Test | Unfixed | Fixed |
|---|---|---|
| padded widths decode identically | fail | pass |
| all-zero reference is U+0000 | fail | pass |
| consumed length covers the reference | fail | pass |
| named entities decode | pass | pass |
| run past the raw bound is refused | pass | pass |
| out-of-range refused however padded | **fail** | pass |
| surrogate refused however padded | **fail** | pass |
| malformed references refused | pass | pass |

The two surprises are the padded out-of-range and padded surrogate cases. The
old decoder *did* refuse them — but for the wrong reason. `&#x0000D800;` was
refused as `unsupported XML entity`, because it had too many digits, not as
`out-of-range XML entity`, because it denotes a surrogate. The tests assert the
message, so they caught the difference.

That is a better result than the plan anticipated. A refusal that happens
incidentally is one you cannot rely on: had anyone later raised the digit bound
for an unrelated reason, the old decoder would have started accepting surrogates
silently. The fix makes the value the thing that decides, so the refusal now
comes from the check that means it.

### Verification

- `npm run test:public` — passed, 3 compiled and 11 source test files
- `npm run lint` — clean
- `npm run check:docs:public` — 24 files, 39 links, 7 executable examples
- `conformance/api/public-types.v1.json` regenerated: `unicode-scalar.d.ts` grew
  by 32 bytes from the revised comment. Exported names are byte-identical, so
  the public API did not move.
