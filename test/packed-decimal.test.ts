import assert from "node:assert/strict";
import test from "node:test";

import { decodePackedDecimal, encodePackedDecimal } from "../src/values/packed-decimal.js";

test("packed decimal: a field of all zero bytes decodes as zero", () => {
  for (let length = 1; length <= 16; length += 1) {
    for (let decimals = 0; decimals <= Math.min(14, 2 * length - 1); decimals += 1) {
      const zero = decodePackedDecimal(Buffer.alloc(length), decimals, "P");
      assert.equal(zero, decimals === 0 ? "0" : `0.${"0".repeat(decimals)}`);
      const canonical = encodePackedDecimal(zero, length, decimals);
      assert.equal(canonical.at(-1), 0x0c, "encoding retains its positive sign");
      assert.equal(decodePackedDecimal(canonical, decimals), zero);
    }
  }
});

test("packed decimal: malformed digits and other invalid signs remain rejected", () => {
  for (const hex of ["00a0", "00f0"]) {
    assert.throws(() => decodePackedDecimal(Buffer.from(hex, "hex"), 0), /non-decimal digit nibble/u);
  }
  for (let sign = 1; sign <= 9; sign += 1) {
    assert.throws(() => decodePackedDecimal(Buffer.of(0, sign), 0), /invalid sign nibble/u);
  }
});

test("packed decimal: a zero sign nibble after a digit is still refused", () => {
  assert.throws(
    () => decodePackedDecimal(Buffer.from("0010", "hex"), 0, "P"),
    /invalid sign nibble 0/u,
  );
});
