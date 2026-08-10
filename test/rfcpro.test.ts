import assert from "node:assert/strict";
import test from "node:test";

import {
  RFC_PRO_COMPACT_LENGTH_MAX,
  RFC_PRO_VALUE_LENGTH_MAX,
  decodeRfcProFieldHeader,
  encodeRfcProFieldHeader,
  rfcProFieldHeaderByteLength,
} from "../src/protocol/rfcpro.js";

const PARAMETER_VALUE = 0x0203;

test("encodes canonical compact and extended RFCPRO field headers", () => {
  assert.equal(
    encodeRfcProFieldHeader(PARAMETER_VALUE, 0).toString("hex"),
    "02030000",
  );
  assert.equal(
    encodeRfcProFieldHeader(
      PARAMETER_VALUE,
      RFC_PRO_COMPACT_LENGTH_MAX,
    ).toString("hex"),
    "0203fffe",
  );
  assert.equal(
    encodeRfcProFieldHeader(PARAMETER_VALUE, 65_535).toString("hex"),
    "0203ffff0000ffff",
  );
  assert.equal(
    encodeRfcProFieldHeader(PARAMETER_VALUE, 65_536).toString("hex"),
    "0203ffff00010000",
  );
  assert.equal(
    encodeRfcProFieldHeader(PARAMETER_VALUE, RFC_PRO_VALUE_LENGTH_MAX).toString(
      "hex",
    ),
    "0203ffff7fffffff",
  );
});

test("decodes compact, canonical extended, and tolerated legacy extended lengths", () => {
  assert.deepEqual(decodeRfcProFieldHeader(Buffer.from("0203fffe", "hex")), {
    tag: PARAMETER_VALUE,
    length: RFC_PRO_COMPACT_LENGTH_MAX,
    encoding: "compact",
    bytesConsumed: 4,
  });
  assert.deepEqual(
    decodeRfcProFieldHeader(Buffer.from("0203ffff0000ffff", "hex")),
    {
      tag: PARAMETER_VALUE,
      length: 65_535,
      encoding: "extended",
      bytesConsumed: 8,
    },
  );
  assert.deepEqual(
    decodeRfcProFieldHeader(Buffer.from("0203ffff00010000aabb", "hex")),
    {
      tag: PARAMETER_VALUE,
      length: 65_536,
      encoding: "extended",
      bytesConsumed: 8,
    },
  );
  assert.deepEqual(
    decodeRfcProFieldHeader(Buffer.from("0203ffff0000fffe", "hex")),
    {
      tag: PARAMETER_VALUE,
      length: RFC_PRO_COMPACT_LENGTH_MAX,
      encoding: "extended",
      bytesConsumed: 8,
    },
  );
  assert.deepEqual(
    decodeRfcProFieldHeader(Buffer.from("0203ffff7fffffff", "hex")),
    {
      tag: PARAMETER_VALUE,
      length: RFC_PRO_VALUE_LENGTH_MAX,
      encoding: "extended",
      bytesConsumed: 8,
    },
  );
});

test("reports exact RFCPRO header lengths without allocating payload space", () => {
  assert.equal(rfcProFieldHeaderByteLength(0), 4);
  assert.equal(rfcProFieldHeaderByteLength(RFC_PRO_COMPACT_LENGTH_MAX), 4);
  assert.equal(rfcProFieldHeaderByteLength(65_535), 8);
  assert.equal(rfcProFieldHeaderByteLength(RFC_PRO_VALUE_LENGTH_MAX), 8);
});

test("rejects invalid RFCPRO tags, lengths, and configured maxima", () => {
  assert.throws(() => encodeRfcProFieldHeader(-1, 0), /tag.*0\.\.65535/);
  assert.throws(() => encodeRfcProFieldHeader(65_536, 0), /tag.*0\.\.65535/);
  assert.throws(() => encodeRfcProFieldHeader(1.5, 0), /tag.*0\.\.65535/);
  assert.throws(
    () => encodeRfcProFieldHeader(0, -1),
    /length.*0\.\.2147483647/,
  );
  assert.throws(
    () => encodeRfcProFieldHeader(0, Number.NaN),
    /length.*0\.\.2147483647/,
  );
  assert.throws(
    () => encodeRfcProFieldHeader(0, RFC_PRO_VALUE_LENGTH_MAX + 1),
    /length.*0\.\.2147483647/,
  );
  assert.throws(
    () =>
      decodeRfcProFieldHeader(Buffer.from("0203ffff00010000", "hex"), {
        maxValueLength: 65_535,
      }),
    /length 65536 exceeds configured limit 65535/,
  );
  assert.deepEqual(
    decodeRfcProFieldHeader(Buffer.from("0203ffff00010000", "hex"), {
      maxValueLength: 65_536,
    }),
    {
      tag: PARAMETER_VALUE,
      length: 65_536,
      encoding: "extended",
      bytesConsumed: 8,
    },
  );
  assert.deepEqual(
    decodeRfcProFieldHeader(Buffer.from("02030001", "hex"), {
      maxValueLength: 1,
    }),
    {
      tag: PARAMETER_VALUE,
      length: 1,
      encoding: "compact",
      bytesConsumed: 4,
    },
  );
  assert.throws(
    () =>
      decodeRfcProFieldHeader(Buffer.from("02030001", "hex"), {
        maxValueLength: 0,
      }),
    /length 1 exceeds configured limit 0/,
  );
  assert.throws(
    () =>
      decodeRfcProFieldHeader(Buffer.from("02030000", "hex"), {
        maxValueLength: -1,
      }),
    /maxValueLength.*0\.\.2147483647/,
  );
  assert.throws(
    () =>
      decodeRfcProFieldHeader(Buffer.from("02030000", "hex"), {
        maxValueLength: Number.NaN,
      }),
    /maxValueLength.*0\.\.2147483647/,
  );
  assert.throws(
    () =>
      decodeRfcProFieldHeader(Buffer.from("02030000", "hex"), {
        maxValueLength: RFC_PRO_VALUE_LENGTH_MAX + 1,
      }),
    /maxValueLength.*0\.\.2147483647/,
  );
  assert.throws(
    () =>
      decodeRfcProFieldHeader(Buffer.from("02030000", "hex"), {
        maxValueLength: 1.5,
      }),
    /maxValueLength.*0\.\.2147483647/,
  );
  assert.throws(
    () => decodeRfcProFieldHeader(Buffer.from("0203ffffffffffff", "hex")),
    /extended length -1 is negative/,
  );
  assert.throws(
    () => decodeRfcProFieldHeader(Buffer.from("0203ffff80000000", "hex")),
    /extended length -2147483648 is negative/,
  );
});

test("rejects every truncated RFCPRO extended-length header", () => {
  const header = Buffer.from("0203ffff00010000", "hex");
  for (let length = 0; length < header.byteLength; length += 1) {
    assert.throws(
      () => decodeRfcProFieldHeader(header.subarray(0, length)),
      /need [24] bytes/,
      `truncation at ${length}`,
    );
  }
});
