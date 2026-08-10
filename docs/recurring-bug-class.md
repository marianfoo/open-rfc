# The recurring bug class

**A decoder that memorises what one system happened to send.**

This is the mistake this codebase keeps making. Six instances are recorded
below, five of them found in a single day. Every one looked like reasonable,
careful code — several were written *because* the author was being careful.

If you are fixing a bug here, check for this before anything else. If you are
adding a decoder, this is the review you will get.

## Why it happens here

Classic RFC has no public specification. You learn a structure by looking at
what a system sends you, and the most natural way to write that down is to
encode exactly what you saw:

```ts
// The row is 402 bytes.
if (row.byteLength !== 402) throw new Error("bad row");
```

That is a faithful record of one observation and a false claim about the
protocol. The row is 402 bytes *on the release you tested*. A later release
appends a field, and now the client refuses a structurally valid reply.

The tell is **a comparison against a literal, or a fixed list of accepted
shapes, sitting on something that varies by peer, release, or configuration.**

The symptom is **"works on my system."** If a report has that shape, look here
first.

## The six

| Coordinate | What was pinned | What it broke for |
|---|---|---|
| Initial logon reply | exact byte lengths of text fields | any host whose name is a different length |
| `RFC_FUNINT` rows | exactly 402 bytes | any release that appends a field |
| `RFC_FIELDS` rows | exactly 138 bytes | same |
| Dispatcher port | the range 3200–3299 | any port-offset landscape |
| `COMPTYPE` | only the value `"E"` | components declared with a built-in DDIC type |
| XML character references | the digit *count*, not the value | conforming zero-padded references |

The logon one cost three weeks. The failure surfaced as `RFC_INVALID_PROTOCOL`,
which was read as "SAP rejected the password", so working authentication code
was replaced repeatedly. The password handling was fine the whole time. The
defect was a response parser pinning byte lengths on a hostname.

## What the fix looks like

**Bound what varies by nature. Keep every structural check strict.**

Widening a length bound is not permission to accept malformed input. Look at
what the fixed versions actually do:

Read the length from the wire, then bound it — [`message-server.ts:416`](../src/protocol/message-server.ts):

```ts
const hostLength = reader.readUInt16BE("hostLength");
if (hostLength < 1 || hostLength > RFC_GROUP_MAX_HOST_BYTES ||
    reader.remaining !== hostLength + 1) {
  throw new MessageServerProtocolError(/* ... */);
}
```

Bound *below* by the stable prefix you consume, ignore what a newer release
appends, and still refuse a short row — [`classic-rfc.ts:564`](../src/protocol/classic-rfc.ts):

```ts
if (value.byteLength < RFC_FUNINT_UNICODE_ROW_LENGTH) throw new RangeError(/* ... */);
const reader = new CheckedByteReader(
  value.subarray(0, RFC_FUNINT_UNICODE_ROW_LENGTH), "RFC_FUNINT row");
```

A short row is still refused, deliberately: completing one with ABAP initial
bytes would invent values the peer never sent.

Constrain the derived value structurally instead of pinning one landscape's
convention — [`message-server.ts:405`](../src/protocol/message-server.ts):

```ts
// 3200/3300 is the default block offset, not a protocol constant.
const gatewayPort = dispatcherPort + PORT_BLOCK_STRIDE;
if (dispatcherPort < 1 || gatewayPort > MAX_TCP_PORT) throw /* ... */;
```

### Never add another memorised case

Adding a seventh accepted layout because the sixth did not match is the bug
repeating, not a fix.

## The test that catches it

**A property test over the full legal range of whatever the peer controls** —
every length, every value, every ordering. Not one example.

This single test shape would have caught four of the six on the day they were
written. From
[`test/xml-entity-reference.test.ts`](../test/xml-entity-reference.test.ts):

```ts
// A character reference decodes the same at every padded width.
for (const codePoint of scalars) {
  for (let width = shortest; width <= 32; width += 1) {
    assert.equal(decode(padded(codePoint, radix, width)), codePoint);
  }
}
```

Pair it with a **fail-closed regression** proving malformed input is still
refused — unknown tag, wrong order, truncation, duplication, out of range.

Then **control-test both**: revert the fix and re-run.

- The property test **must fail**. If it passes without the fix, it tests
  nothing.
- The fail-closed tests will usually pass in both states. That is correct — they
  guard the bound, not the fix.
- If a fail-closed test *also* fails without the fix, the old code was refusing
  that input **for the wrong reason**. Worth recording: an incidental refusal is
  one you cannot rely on.

## When a bound is genuinely correct

Not every refusal is this bug. Fixed-width fields, denial-of-service bounds and
fail-closed guards are all legitimate, and removing one to make a test pass is a
worse bug than the one you started with.

The question is not "is there a literal here" but **"does the thing this literal
describes vary by peer, release, or configuration?"** If it does not, pin it and
say why in a comment. If you cannot tell, say so and state what would settle it
— that is a real outcome, and flagging it has been the right call here before.
