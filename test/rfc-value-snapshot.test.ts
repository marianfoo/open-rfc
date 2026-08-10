import assert from "node:assert/strict";
import test from "node:test";

import { snapshotRfcValue } from "../src/values/rfc-value-snapshot.js";

test("snapshot rejects proxies without executing their traps", () => {
  let traps = 0;
  const value = new Proxy({ VALUE: 1 }, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("must not execute");
    },
    ownKeys() {
      traps += 1;
      throw new Error("must not execute");
    },
  });
  assert.throws(() => snapshotRfcValue(value), /must not be a proxy/u);
  assert.equal(traps, 0);
});

test("snapshot rejects a proxy prototype without executing its traps", () => {
  let traps = 0;
  const prototype = new Proxy({}, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("must not execute");
    },
  });
  const value = Object.create(prototype) as Record<string, unknown>;
  Object.defineProperty(value, "VALUE", {
    value: 1,
    enumerable: true,
  });
  assert.throws(() => snapshotRfcValue(value), /must not have a proxy prototype/u);
  assert.equal(traps, 0);
});

test("snapshot applies a conservative per-array row limit before reading rows", () => {
  let reads = 0;
  const rows = new Array(3);
  for (let index = 0; index < rows.length; index += 1) {
    Object.defineProperty(rows, index, {
      enumerable: true,
      get() {
        reads += 1;
        return index;
      },
    });
  }
  assert.throws(
    () => snapshotRfcValue(rows, "TABLE", {
      accessorPolicy: "readOnce",
      maxArrayLength: 2,
    }),
    /TABLE exceeds the 2-row array snapshot limit/u,
  );
  assert.equal(reads, 0);
});

test("snapshot applies one aggregate node budget across nested tables", () => {
  assert.deepEqual(
    snapshotRfcValue([[1], [2]], "TABLES", { maxNodes: 5 }),
    [[1], [2]],
  );
  assert.throws(
    () => snapshotRfcValue([[1], [2]], "TABLES", { maxNodes: 4 }),
    /TABLES\[1\]\[0\] exceeds the 4 value-node snapshot limit/u,
  );
});

test("snapshot bounds cannot relax the shipped row and node ceilings", () => {
  for (const options of [
    { maxNodes: 0 },
    { maxNodes: 1_000_001 },
    { maxArrayLength: 0 },
    { maxArrayLength: 100_001 },
    { maxNodes: 1.5 },
  ]) {
    assert.throws(
      () => snapshotRfcValue({}, "RFC value", options),
      /must be an integer in/u,
    );
  }
});

test("snapshot captures decimal-object conversion once and rejects function values", () => {
  let current = "1.25";
  let conversions = 0;
  const decimal = {
    toString() {
      conversions += 1;
      return current;
    },
  };

  const captured = snapshotRfcValue({ AMOUNT: decimal }) as {
    readonly AMOUNT: unknown;
  };
  current = "9.99";
  assert.equal(captured.AMOUNT, "1.25");
  assert.equal(conversions, 1);

  class DecimalValue {
    toString(): string {
      conversions += 1;
      return current;
    }
  }
  const classCaptured = snapshotRfcValue(new DecimalValue());
  current = "7.50";
  assert.equal(classCaptured, "9.99");
  assert.equal(conversions, 2);

  assert.throws(
    () => snapshotRfcValue({ VALUE: () => "1.25" }),
    /RFC value\.VALUE must not be a function/u,
  );
});
