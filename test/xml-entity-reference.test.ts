import assert from "node:assert/strict";
import test from "node:test";

import { decodeXmlEntityReference } from "../src/values/unicode-scalar.js";

const PATH = "VALUE.TEXT";

function decode(reference: string): number {
  return decodeXmlEntityReference(reference, 0, PATH).codePoint;
}

function padded(codePoint: number, radix: 10 | 16, width: number): string {
  const digits = codePoint.toString(radix).toUpperCase().padStart(width, "0");
  return radix === 16 ? `&#x${digits};` : `&#${digits};`;
}

// XML 1.0 spells both character-reference forms with `+`, so a reference may
// carry any number of digits and zero padding is a spelling rather than a
// different reference. This is the property the readers previously broke: they
// bounded the digit COUNT, so a conforming producer that zero-pads was refused.
test("a character reference decodes the same at every padded width", () => {
  const scalars = [0x00, 0x09, 0x26, 0x41, 0x7f, 0xa0, 0x20ac, 0xffff, 0x10000, 0x10ffff];
  for (const codePoint of scalars) {
    for (const [radix, minimum] of [[10, 1], [16, 1]] as const) {
      const shortest = codePoint.toString(radix).length;
      assert.ok(shortest >= minimum);
      for (let width = shortest; width <= 32; width += 1) {
        const reference = padded(codePoint, radix, width);
        assert.equal(
          decode(reference),
          codePoint,
          `${reference} should decode to U+${codePoint.toString(16).toUpperCase()}`,
        );
      }
    }
  }
});

// An all-zero run denotes U+0000, not an empty reference. Our own writers emit
// `&#00;` for C0 controls, so this is an ordinary round-trip and not an edge.
test("an all-zero reference decodes to U+0000 at every width", () => {
  for (let width = 1; width <= 32; width += 1) {
    assert.equal(decode(`&#${"0".repeat(width)};`), 0x00);
    assert.equal(decode(`&#x${"0".repeat(width)};`), 0x00);
  }
});

test("the consumed length covers the whole reference however it is padded", () => {
  const reference = "&#x00000041;";
  const decoded = decodeXmlEntityReference(`${reference}rest`, 0, PATH);
  assert.equal(decoded.codePoint, 0x41);
  assert.equal(decoded.length, reference.length);
});

test("the five predefined named entities still decode", () => {
  assert.equal(decode("&amp;"), 0x26);
  assert.equal(decode("&lt;"), 0x3c);
  assert.equal(decode("&gt;"), 0x3e);
  assert.equal(decode("&quot;"), 0x22);
  assert.equal(decode("&apos;"), 0x27);
});

// Everything below must fail closed. These pass before and after the widening,
// which is correct: they guard the bound rather than the fix. A padding test
// that passed in both states would mean it never tested anything.
test("a digit run past the raw bound is refused", () => {
  assert.throws(() => decode(`&#${"0".repeat(33)};`), /unsupported XML entity/u);
  assert.throws(() => decode(`&#x${"0".repeat(33)};`), /unsupported XML entity/u);
});

test("an out-of-range value is refused however it is padded", () => {
  for (const reference of ["&#x110000;", "&#x0000110000;", "&#1114112;", "&#0001114112;"]) {
    assert.throws(() => decode(reference), /out-of-range XML entity/u, reference);
  }
});

test("a surrogate is refused however it is padded", () => {
  for (const reference of ["&#xD800;", "&#x0000D800;", "&#xDFFF;", "&#55296;", "&#0055296;"]) {
    assert.throws(() => decode(reference), /out-of-range XML entity/u, reference);
  }
});

test("malformed references are still refused", () => {
  assert.throws(() => decode("&;"), /empty XML entity/u);
  assert.throws(() => decode("&#;"), /unsupported XML entity/u);
  assert.throws(() => decode("&#x;"), /unsupported XML entity/u);
  assert.throws(() => decode("&amp"), /truncated XML entity/u);
  assert.throws(() => decode("&nbsp;"), /unsupported XML entity/u);
  assert.throws(() => decode("&#12z4;"), /unsupported XML entity/u);
  // `&#X41;` is not the XML grammar: the specification spells the marker in
  // lowercase, so this is a decimal run beginning with a letter.
  assert.throws(() => decode("&#X41;"), /unsupported XML entity/u);
});
