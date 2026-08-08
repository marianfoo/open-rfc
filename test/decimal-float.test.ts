import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDecimalFloat16,
  decodeDecimalFloat34,
  encodeDecimalFloat16,
  encodeDecimalFloat34,
} from "../src/values/decimal-float.js";

function readLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]!);
  }
  return value;
}

function writeLittleEndian(value: bigint, byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let remainder = value;
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = Number(remainder & 0xffn);
    remainder >>= 8n;
  }
  return bytes;
}

/* Cowlishaw's published Boolean equations, kept independent of the codec's
 * case-table implementation so the exhaustive checks are not tautological. */
function oracleEncodeDeclet(value: number): number {
  const left = Math.floor(value / 100);
  const middle = Math.floor(value / 10) % 10;
  const right = value % 10;
  const a = (left >> 3) & 1;
  const b = (left >> 2) & 1;
  const c = (left >> 1) & 1;
  const d = left & 1;
  const e = (middle >> 3) & 1;
  const f = (middle >> 2) & 1;
  const g = (middle >> 1) & 1;
  const h = middle & 1;
  const i = (right >> 3) & 1;
  const j = (right >> 2) & 1;
  const k = (right >> 1) & 1;
  const m = right & 1;
  const not = (bit: number) => bit ^ 1;
  const p = b | (a & j) | (a & f & i);
  const q = c | (a & k) | (a & g & i);
  const r = d;
  const s = (f & (not(a) | not(i))) | (not(a) & e & j) | (e & i);
  const t = g | (not(a) & e & k) | (a & i);
  const u = h;
  const v = a | e | i;
  const w = a | (e & i) | (not(e) & j);
  const x = e | (a & i) | (not(a) & k);
  const y = m;
  return (p << 9) | (q << 8) | (r << 7) | (s << 6) | (t << 5) |
    (u << 4) | (v << 3) | (w << 2) | (x << 1) | y;
}

function oracleDecodeDeclet(code: number): number {
  const p = (code >> 9) & 1;
  const q = (code >> 8) & 1;
  const r = (code >> 7) & 1;
  const s = (code >> 6) & 1;
  const t = (code >> 5) & 1;
  const u = (code >> 4) & 1;
  const v = (code >> 3) & 1;
  const w = (code >> 2) & 1;
  const x = (code >> 1) & 1;
  const y = code & 1;
  const not = (bit: number) => bit ^ 1;
  const a = (v & w) & (not(s) | t | not(x));
  const b = p & (not(v) | not(w) | (s & not(t) & x));
  const c = q & (not(v) | not(w) | (s & not(t) & x));
  const d = r;
  const e = v & ((not(w) & x) | (not(t) & x) | (s & x));
  const f = (s & (not(v) | not(x))) | (p & not(s) & t & v & w & x);
  const g = (t & (not(v) | not(x))) | (q & not(s) & t & w);
  const h = u;
  const i = v & ((not(w) & not(x)) | (w & x & (s | t)));
  const j = (not(v) & w) | (s & v & not(w) & x) |
    (p & w & (not(x) | (not(s) & not(t))));
  const k = (not(v) & x) | (t & not(w) & x) |
    (q & v & w & (not(x) | (not(s) & not(t))));
  const m = y;
  const left = (a << 3) | (b << 2) | (c << 1) | d;
  const middle = (e << 3) | (f << 2) | (g << 1) | h;
  const right = (i << 3) | (j << 2) | (k << 1) | m;
  return left * 100 + middle * 10 + right;
}

test("matches IEEE 754-2008 decimal64 DPD vectors", () => {
  const vectors = [
    ["0", "0000000000003822", "0"],
    ["-0", "00000000000038a2", "-0"],
    ["1", "0100000000003822", "1"],
    ["-1", "01000000000038a2", "-1"],
    ["123.45", "c549000000003022", "123.45"],
    ["123.45E67", "c549000000003c23", "1.2345E+69"],
    ["9.999999999999999E+384", "fffcf3cf3ffffc77", "9.999999999999999E+384"],
    ["1E-383", "0100000000003c00", "1E-383"],
    ["NaN", "000000000000007c", "NaN"],
    ["Infinity", "0000000000000078", "Infinity"],
    ["-Infinity", "00000000000000f8", "-Infinity"],
  ] as const;

  for (const [input, hex, output] of vectors) {
    assert.equal(encodeDecimalFloat16(input).toString("hex"), hex, input);
    assert.equal(decodeDecimalFloat16(Buffer.from(hex, "hex")), output, input);
  }
});

test("matches IEEE 754-2008 decimal128 DPD vectors", () => {
  const vectors = [
    ["0", "00000000000000000000000000000822", "0"],
    ["-0", "000000000000000000000000000008a2", "-0"],
    ["1", "01000000000000000000000000000822", "1"],
    ["-1", "010000000000000000000000000008a2", "-1"],
    ["123.45", "c5490000000000000000000000800722", "123.45"],
    ["123.45E67", "c5490000000000000000000000401822", "1.2345E+69"],
    [
      "9.999999999999999999999999999999999E+6144",
      "fffcf3cf3ffffcf3cf3ffffcf3cfff77",
      "9.999999999999999999999999999999999E+6144",
    ],
    ["1E-6143", "01000000000000000000000000400800", "1E-6143"],
    ["NaN", "0000000000000000000000000000007c", "NaN"],
    ["Infinity", "00000000000000000000000000000078", "Infinity"],
    ["-Infinity", "000000000000000000000000000000f8", "-Infinity"],
  ] as const;

  for (const [input, hex, output] of vectors) {
    assert.equal(encodeDecimalFloat34(input).toString("hex"), hex, input);
    assert.equal(decodeDecimalFloat34(Buffer.from(hex, "hex")), output, input);
  }
});

test("exhaustively emits every canonical DPD declet", () => {
  for (let value = 0; value <= 999; value += 1) {
    const encoded = encodeDecimalFloat16(String(value));
    assert.equal(
      Number(readLittleEndian(encoded) & 0x3ffn),
      oracleEncodeDeclet(value),
      String(value).padStart(3, "0"),
    );
    assert.equal(decodeDecimalFloat16(encoded), String(value));
  }
});

test("decodes all 1,024 DPD declets, including 24 redundant encodings", () => {
  const zero = readLittleEndian(encodeDecimalFloat16("0"));
  let redundant = 0;
  for (let code = 0; code < 1_024; code += 1) {
    const expected = oracleDecodeDeclet(code);
    const encoded = writeLittleEndian((zero & ~0x3ffn) | BigInt(code), 8);
    assert.equal(decodeDecimalFloat16(encoded), String(expected), code.toString(2));
    if (oracleEncodeDeclet(expected) !== code) redundant += 1;
  }
  assert.equal(redundant, 24);
});

test("preserves exact cohorts, signed zero, subnormals, and range-edge values", () => {
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("1.2300")), "1.2300");
  assert.equal(encodeDecimalFloat16("-0.00").toString("hex"), "00000000000030a2");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("-0.00")), "-0.00");
  assert.equal(encodeDecimalFloat16("1E-398").toString("hex"), "0100000000000000");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("1E-398")), "1E-398");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("10E-399")), "1E-398");
  assert.equal(encodeDecimalFloat16("1E+384").toString("hex"), "000000000000fc47");
  assert.equal(
    decodeDecimalFloat16(encodeDecimalFloat16("1E+384")),
    "1.000000000000000E+384",
  );
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("0E-999")), "0E-398");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("-0E+999")), "-0E+369");

  assert.equal(
    encodeDecimalFloat34("1E-6176").toString("hex"),
    "01000000000000000000000000000000",
  );
  assert.equal(decodeDecimalFloat34(encodeDecimalFloat34("1E-6176")), "1E-6176");
  assert.equal(
    encodeDecimalFloat34("1E+6144").toString("hex"),
    "00000000000000000000000000c0ff47",
  );
  assert.equal(
    decodeDecimalFloat34(encodeDecimalFloat34("1E+6144")),
    `1.${"0".repeat(33)}E+6144`,
  );
  assert.equal(decodeDecimalFloat34(encodeDecimalFloat34("0E-99999")), "0E-6176");
});

test("rescales excess trailing zeros exactly before enforcing precision and qmin", () => {
  assert.equal(
    encodeDecimalFloat16("12345678901234560").toString("hex"),
    "568ee2c1b9343d26",
  );
  assert.equal(
    decodeDecimalFloat16(encodeDecimalFloat16("12345678901234560")),
    "1.234567890123456E+16",
  );
  assert.equal(
    encodeDecimalFloat16("10000000000000000E-414").toString("hex"),
    "0100000000000000",
  );
  assert.equal(
    decodeDecimalFloat16(encodeDecimalFloat16("10000000000000000E-414")),
    "1E-398",
  );

  assert.equal(
    encodeDecimalFloat34("12345678901234567890123456789012340").toString("hex"),
    "3435827771123c6fe5281e9c4b530826",
  );
  assert.equal(
    decodeDecimalFloat34(
      encodeDecimalFloat34("12345678901234567890123456789012340"),
    ),
    "1.234567890123456789012345678901234E+34",
  );
  assert.equal(
    encodeDecimalFloat34(
      "10000000000000000000000000000000000E-6210",
    ).toString("hex"),
    "01000000000000000000000000000000",
  );
  assert.equal(
    decodeDecimalFloat34(
      encodeDecimalFloat34(
        "10000000000000000000000000000000000E-6210",
      ),
    ),
    "1E-6176",
  );

  assert.throws(
    () => encodeDecimalFloat16("12345678901234567"),
    /exceeds 16 significant digits/,
  );
  assert.throws(
    () => encodeDecimalFloat34("12345678901234567890123456789012341"),
    /exceeds 34 significant digits/,
  );
});

test("accepts General Decimal Arithmetic specials and diagnostic NaNs", () => {
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("inf")), "Infinity");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("+INFINITY")), "Infinity");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("sNaN")), "sNaN");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16("-NaN8275")), "-NaN8275");
  assert.equal(decodeDecimalFloat34(encodeDecimalFloat34("sNaN123456789")), "sNaN123456789");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16(Number.NaN)), "NaN");
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16(Number.POSITIVE_INFINITY)), "Infinity");

  const allOnesNaN = Buffer.from("ffffffffffffffff", "hex");
  assert.equal(decodeDecimalFloat16(allOnesNaN), "-sNaN999999999999999");
  const infinityWithPayload = Buffer.from("fffffffffffffffb", "hex");
  assert.equal(decodeDecimalFloat16(infinityWithPayload), "-Infinity");
});

test("rejects rounding, overflow, underflow, malformed syntax, and bad geometry", () => {
  assert.throws(
    () => encodeDecimalFloat16("1.2345678901234567"),
    /exceeds 16 significant digits/,
  );
  assert.throws(
    () => encodeDecimalFloat34(`1.${"2".repeat(34)}`),
    /exceeds 34 significant digits/,
  );
  assert.throws(() => encodeDecimalFloat16("1E+385"), /outside DECF16 range/);
  assert.throws(() => encodeDecimalFloat16("1E-399"), /outside DECF16 range/);
  assert.throws(() => encodeDecimalFloat34("1E+6145"), /outside DECF34 range/);
  assert.throws(() => encodeDecimalFloat34("1E-6177"), /outside DECF34 range/);
  assert.throws(() => encodeDecimalFloat16("NaN1234567890123456"), /15-digit NaN payload/);
  assert.throws(() => encodeDecimalFloat16(""), /valid decimal/);
  assert.throws(() => encodeDecimalFloat16(" 1"), /valid decimal/);
  assert.throws(() => encodeDecimalFloat16("1,2"), /valid decimal/);
  assert.throws(() => encodeDecimalFloat16("."), /valid decimal/);
  assert.throws(() => encodeDecimalFloat16(null as never), /string, number, bigint, or decimal object/);
  assert.throws(() => decodeDecimalFloat16(Buffer.alloc(7)), /exactly 8 bytes/);
  assert.throws(() => decodeDecimalFloat34(Buffer.alloc(17)), /exactly 16 bytes/);
});

test("converts decimal objects exactly once and supports bigint and number inputs", () => {
  let conversions = 0;
  let propertyReads = 0;
  const value = Object.defineProperty({}, "toString", {
    get() {
      propertyReads += 1;
      return () => {
        conversions += 1;
        return "123.45E67";
      };
    },
  });
  assert.equal(
    encodeDecimalFloat16(value).toString("hex"),
    "c549000000003c23",
  );
  assert.equal(propertyReads, 1);
  assert.equal(conversions, 1);
  assert.equal(decodeDecimalFloat16(encodeDecimalFloat16(123.45)), "123.45");
  assert.equal(decodeDecimalFloat34(encodeDecimalFloat34(12345678901234567890n)), "12345678901234567890");
});

test("uses intrinsic byte geometry and snapshots without consulting own accessors", () => {
  let accessorReads = 0;
  const bytes = Buffer.from("c549000000003022", "hex");
  for (const property of ["byteLength", "byteOffset", "buffer"] as const) {
    Object.defineProperty(bytes, property, {
      configurable: true,
      get() {
        accessorReads += 1;
        throw new Error(`unexpected ${property} getter`);
      },
    });
  }
  assert.equal(decodeDecimalFloat16(bytes), "123.45");
  assert.equal(accessorReads, 0);

  const short = Buffer.alloc(7);
  Object.defineProperty(short, "byteLength", {
    configurable: true,
    get() {
      accessorReads += 1;
      return 8;
    },
  });
  assert.throws(() => decodeDecimalFloat16(short), /exactly 8 bytes/);
  assert.equal(accessorReads, 0);
});

test("bounds decimal text before significand, exponent, NaN, or object parsing", () => {
  const overLimit = 4_097;
  assert.throws(
    () => encodeDecimalFloat16("1".repeat(overLimit)),
    /exceeds 4096 characters/,
  );
  assert.throws(
    () => encodeDecimalFloat34(`1E+${"9".repeat(overLimit)}`),
    /exceeds 4096 characters/,
  );
  assert.throws(
    () => encodeDecimalFloat16(`NaN${"0".repeat(overLimit)}`),
    /exceeds 4096 characters/,
  );

  let conversions = 0;
  assert.throws(
    () => encodeDecimalFloat34({
      toString() {
        conversions += 1;
        return "0".repeat(overLimit);
      },
    }),
    /exceeds 4096 characters/,
  );
  assert.equal(conversions, 1);
});

test("invokes a captured decimal toString without consulting its call property", () => {
  let callPropertyReads = 0;
  const conversion = function (): string {
    return "123.45";
  };
  Object.defineProperty(conversion, "call", {
    configurable: true,
    get() {
      callPropertyReads += 1;
      throw new Error("unexpected Function.call access");
    },
  });
  const value = { toString: conversion };

  assert.equal(
    encodeDecimalFloat16(value).toString("hex"),
    "c549000000003022",
  );
  assert.equal(callPropertyReads, 0);
});
