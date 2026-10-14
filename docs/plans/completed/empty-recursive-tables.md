# Empty classic responses for recursive TABLES parameters

## Problem

Issue #38 reports two independent failures in `DDIF_FIELDINFO_GET`: omitted
optional TABLES outputs are not requested, and an empty binary `FIXED_VALUES`
table is rejected because metadata selected recursive xRFC. PR #42 fixes
the first failure. This change fixes the second.

## Plan

1. Reproduce the empty binary response with synthetic protocol fields.
2. Accept an empty TABLES result after the existing protocol decoder has
   validated its envelope and row count.
3. Keep rejecting nonempty binary rows for recursive parameters: decoding
   those would need a proven binary row layout.
4. Test missing rows, extra rows, duplicate names, unknown names, nonempty
   recursive rows, and explicit output suppression.

## Outcome

The existing table loop now returns `[]` for a valid empty binary TABLES
response. It does not add a second row decoder, retry a call, change request
serialization, or infer layouts from payload bytes.

The new positive regression fails without the six-line change. The malformed
envelope and nonempty-row controls pass both before and after the fix.
This synthetic regression does not extend the supported SAP release matrix.
