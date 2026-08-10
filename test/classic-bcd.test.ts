import assert from "node:assert/strict";
import test from "node:test";

import {
  ClassicBcdConversionError,
  projectClassicBcdOutput,
  snapshotClassicBcdMode,
} from "../src/values/classic-bcd.js";

test("snapshots the archived node-rfc BCD output modes exactly", () => {
  const converter = (value: string) => ({ decimal: value });

  assert.equal(snapshotClassicBcdMode(undefined), "string");
  assert.equal(snapshotClassicBcdMode("string"), "string");
  assert.equal(snapshotClassicBcdMode("number"), "number");
  assert.equal(snapshotClassicBcdMode(converter), converter);

  for (const invalid of [null, true, "decimal", 1, {}]) {
    assert.throws(
      () => snapshotClassicBcdMode(invalid, "clientOptions.bcd"),
      /clientOptions\.bcd must be "string", "number", or a function/u,
    );
  }
});

test("projects exact BCD text as string, number, or one ordinary function call", () => {
  assert.equal(projectClassicBcdOutput("123.4500", "string", "AMOUNT"), "123.4500");
  assert.equal(projectClassicBcdOutput("123.4500", "number", "AMOUNT"), 123.45);
  assert.equal(
    projectClassicBcdOutput("1E+6144", "number", "AMOUNT"),
    Number.POSITIVE_INFINITY,
  );

  const calls: Array<{ readonly receiver: unknown; readonly value: string }> = [];
  function Decimal(this: unknown, value: string): Readonly<Record<string, string>> {
    calls.push({ receiver: this, value });
    return Object.freeze({ decimal: value });
  }
  assert.deepEqual(
    projectClassicBcdOutput("-0.001", Decimal, "AMOUNT"),
    { decimal: "-0.001" },
  );
  assert.deepEqual(calls, [{ receiver: undefined, value: "-0.001" }]);
});

test("wraps converter exceptions without copying the decimal value into diagnostics", () => {
  const original = new Error("converter rejected input");
  const secretValue = "9876543210.123456789";
  let caught: unknown;
  try {
    projectClassicBcdOutput(
      secretValue,
      () => {
        throw original;
      },
      "RESULT.NESTED_AMOUNT",
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught instanceof ClassicBcdConversionError, true);
  assert.equal((caught as ClassicBcdConversionError).cause, original);
  assert.equal((caught as ClassicBcdConversionError).path, "RESULT.NESTED_AMOUNT");
  assert.equal((caught as Error).message.includes(secretValue), false);
});
