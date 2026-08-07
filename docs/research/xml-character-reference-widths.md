# Research: XML character reference widths in xRFC text

## Question

`decodeXmlEntityReference` bounds a character reference by how many digits it
contains. Does that bound refuse input the XML specification permits?

## What the specification says

XML 1.0, section 4.1:

```
CharRef ::= '&#' [0-9]+ ';'  |  '&#x' [0-9a-fA-F]+ ';'
```

Both productions use `+`, so a reference may carry **any number of digits**. The
constraint the specification places on a character reference is on its *value* —
it must denote a legal character — not on its width. `&#65;`, `&#065;` and
`&#00000065;` are three spellings of the same character, and all three conform.

## What the code does

`src/values/unicode-scalar.ts` validates the digit run with a width-bounded
pattern: `/^[0-9]{1,7}$/u` for decimal and `/^[0-9A-Fa-f]{1,6}$/u` for
hexadecimal. Those widths were chosen so the parsed value cannot exceed the
Unicode range by much, and so a long run cannot become a decode cost. Both are
sound intentions.

But a digit *count* is not a value bound. Zero padding adds digits without
changing the value, so a conforming reference is refused for its spelling.

## Measurement

Probing the built decoder directly:

| Reference | Result | Note |
|---|---|---|
| `&#65;` | U+0041 | |
| `&#065;` | U+0041 | one leading zero is accepted |
| `&#0000065;` | U+0041 | seven digits is the limit |
| `&#00000065;` | **refused** | eight digits — conforming XML |
| `&#x41;` | U+0041 | |
| `&#x0041;` | U+0041 | |
| `&#x000041;` | U+0041 | six digits is the limit |
| `&#x0000041;` | **refused** | seven digits — conforming XML |
| `&#x10FFFF;` | U+10FFFF | |
| `&#x00010FFFF;` | **refused** | the maximum scalar, zero-padded |

The refusal message is `contains an unsupported XML entity`, which describes a
reference this reader does not implement. A zero-padded reference is not
unsupported; it is ordinary.

## Why it matters

This is the same shape as the defect that motivated widening these readers in
the first place: our writer emits one narrow spelling, the reader was built to
accept what our writer emits, and a conforming peer that spells it differently
is refused. Fixed-width zero padding is a common habit in generated XML, so
this is reachable rather than theoretical.

The blast radius is a refused decode of an otherwise valid payload — the reader
fails closed, so there is no risk of misreading a value. The cost is a
connection that works against one producer and not another.

## Constraint the fix must preserve

The digit bound is doing real work: without any bound, a reference containing a
very long digit run turns into an unbounded `parseInt` and an unbounded slice.
The fix must keep a bound on the raw run while making the *value* the thing that
decides legality, so zero padding is free but a genuinely huge run is still
refused.

## Not changed

The writers. They emit a deliberately narrow canonical subset — C0 controls plus
`&`, `<` and `>` as two-digit decimal references — and that subset is conforming.
A reader accepting more than its writer emits is the correct asymmetry.
