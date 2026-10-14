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
5. Reject recursive TABLES input during preflight. SAP documents TABLES as
   binary, while the existing encoder sent xRFC input. Supplying empty input
   reproduced `PARAMETER_CONVERSION_ERROR` / `CALL_FUNCTION_ILLEGAL_P_TYPE`.

## Outcome

The existing table loop now returns `[]` for a valid empty binary TABLES
response. The input preflight rejects the unsupported encoding before sending.
Neither path infers a row layout or retries a call.

The new positive regression fails without the six-line change. The malformed
envelope and nonempty-row controls pass both before and after the fix.
This synthetic regression does not extend the supported SAP release matrix.

With PRs #40 and #42, a read-only `DDIF_FIELDINFO_GET` call returned its field
catalog and empty fixed-values table. Explicitly supplied or activated recursive
TABLES inputs now fail before sending, including `[]`; a serializer decision
does not make their unsupported input encoding valid. Recursive IMPORT and
CHANGING inputs keep their existing xRFC encoding. Supporting binary input or
nonempty binary output for these metadata shapes needs a separate row codec.

Reference: [SAP synchronous RFC parameter directions](https://help.sap.com/saphelp_snc700_ehp01/helpdata/en/b8/8e1b228add6c4d8509adff5eab2167/content.htm).

Validation: 998 standalone code tests and lint pass. Removing the input guard
makes two of its three focused regressions fail. The documentation builds in
strict mode with the pinned, hash-verified Linux wheels and Python 3.13.14.
