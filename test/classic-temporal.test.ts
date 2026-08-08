import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClassicDate,
  assertClassicTime,
  classicTemporalByteLength,
  decodeClassicTemporal,
  encodeClassicTemporal,
  isClassicTemporalExid,
  type ClassicTemporalExid,
} from "../src/values/classic-temporal.js";

function hex(exid: ClassicTemporalExid, value: string): string {
  return encodeClassicTemporal(exid, value).toString("hex");
}

test("keeps classic DATS and TIMS as fixed raw character forms", () => {
  for (const value of ["", "00000000", "19000229", "20260229", "99991231", "        "]) {
    assert.doesNotThrow(() => assertClassicDate(value, "DATE"));
  }
  for (const value of ["", "000000", "235959", "240000", "999999", "      "]) {
    assert.doesNotThrow(() => assertClassicTime(value, "TIME"));
  }

  assert.throws(() => assertClassicDate("2026-07-15", "DATE"), /DATE expects YYYYMMDD/u);
  assert.throws(() => assertClassicDate("１２３４５６７８", "DATE"), /DATE expects YYYYMMDD/u);
  assert.throws(
    () => assertClassicDate(20260715 as unknown as string, "DATE"),
    /DATE expects YYYYMMDD/u,
  );
  assert.throws(() => assertClassicTime("12:00:00", "TIME"), /TIME expects HHMMSS/u);
  assert.throws(() => assertClassicDate("202607  ", "DATE"), /eight spaces/u);
  assert.throws(() => assertClassicTime("1200  ", "TIME"), /six spaces/u);
  assert.throws(() => assertClassicTime("１２３４５６", "TIME"), /TIME expects HHMMSS/u);
  assert.throws(
    () => assertClassicTime(120000 as unknown as string, "TIME"),
    /TIME expects HHMMSS/u,
  );
});

test("matches the compact-temporal little-endian reference vectors", () => {
  const vectors: ReadonlyArray<readonly [ClassicTemporalExid, string, string]> = [
    ["p", "2002-02-04T20:15:01.1234567", "08272f17627dc308"],
    ["n", "2002-02-04T20:15:01", "c685f3b30e000000"],
    ["w", "2002-02-04T20:15", "8086bb3e00000000"],
    ["d", "2002-02-04", "07270b00"],
    ["7", "2020-W53", "b99b0100"],
    ["x", "2002-02", "ce5d0000"],
    ["t", "20:15:01", "c61c0100"],
    ["i", "20:15", "c004"],
    ["c", "02-04", "2300"],
  ];

  for (const [exid, value, expected] of vectors) {
    assert.equal(hex(exid, value), expected, `${exid} ${value}`);
    assert.equal(
      decodeClassicTemporal(exid, Buffer.from(expected, "hex")),
      value,
      `${exid} ${expected}`,
    );
  }
});

test("uses raw zero only for initial values and preserves node-rfc UTCLONG initial", () => {
  const initialUtclong = "0000-00-00T00:00:00.0000000";
  assert.equal(hex("p", initialUtclong), "0000000000000000");
  assert.equal(hex("p", ""), "0000000000000000");
  assert.equal(
    decodeClassicTemporal("p", Buffer.alloc(8)),
    initialUtclong,
  );

  for (const exid of ["n", "w", "d", "7", "x", "t", "i", "c"] as const) {
    const width = classicTemporalByteLength(exid);
    assert.equal(hex(exid, ""), "00".repeat(width), exid);
    assert.equal(decodeClassicTemporal(exid, Buffer.alloc(width)), "", exid);
  }
});

test("covers every compact temporal minimum and maximum", () => {
  const boundaries: ReadonlyArray<
    readonly [ClassicTemporalExid, string, string, string, string]
  > = [
    [
      "p",
      "0001-01-01T00:00:00.0000000",
      "0100000000000000",
      "9999-12-31T23:59:59.9999999",
      "00c00a49082aca2b",
    ],
    [
      "n",
      "0001-01-01T00:00:00",
      "0100000000000000",
      "9999-12-31T23:59:59",
      "80db887749000000",
    ],
    [
      "w",
      "0001-01-01T00:00",
      "0100000000000000",
      "9999-12-31T23:59",
      "207b753901000000",
    ],
    ["d", "0001-01-01", "01000000", "9999-12-31", "ddb93700"],
    ["7", "0000-W53", "01000000", "9999-W52", "fdf50700"],
    ["x", "0001-01", "01000000", "9999-12", "b4d40100"],
    ["t", "00:00:00", "01000000", "24:00:00", "81510100"],
    ["i", "00:00", "0100", "24:00", "a105"],
    ["c", "01-01", "0100", "12-31", "6e01"],
  ];

  for (const [exid, minimum, minimumRaw, maximum, maximumRaw] of boundaries) {
    assert.equal(hex(exid, minimum), minimumRaw, `${exid} minimum`);
    assert.equal(decodeClassicTemporal(exid, Buffer.from(minimumRaw, "hex")), minimum);
    assert.equal(hex(exid, maximum), maximumRaw, `${exid} maximum`);
    assert.equal(decodeClassicTemporal(exid, Buffer.from(maximumRaw, "hex")), maximum);
  }
});

test("uses consecutive ordinals across the historical Julian-to-Gregorian gap", () => {
  assert.equal(hex("d", "1582-10-04"), "c9d00800");
  assert.equal(hex("d", "1582-10-15"), "cad00800");
  assert.equal(
    decodeClassicTemporal("d", Buffer.from("c9d00800", "hex")),
    "1582-10-04",
  );
  assert.equal(
    decodeClassicTemporal("d", Buffer.from("cad00800", "hex")),
    "1582-10-15",
  );

  assert.doesNotThrow(() => encodeClassicTemporal("d", "1500-02-29"));
  assert.doesNotThrow(() => encodeClassicTemporal("d", "1600-02-29"));
  assert.doesNotThrow(() => encodeClassicTemporal("d", "2000-02-29"));
  assert.throws(() => encodeClassicTemporal("d", "1582-10-05"), /calendar gap/u);
  assert.throws(() => encodeClassicTemporal("d", "1582-10-14"), /calendar gap/u);
  assert.throws(() => encodeClassicTemporal("d", "1700-02-29"), /invalid day/u);
  assert.throws(() => encodeClassicTemporal("d", "1900-02-29"), /invalid day/u);
});

test("validates UTC and local time ranges without timezone normalization", () => {
  assert.throws(
    () => encodeClassicTemporal("p", "2026-07-15T24:00:00.0000000"),
    /hours must be in 00\.\.23/u,
  );
  assert.throws(
    () => encodeClassicTemporal("n", "2026-07-15T23:60:00"),
    /minutes must be in 00\.\.59/u,
  );
  assert.throws(
    () => encodeClassicTemporal("w", "2026-07-15T24:00"),
    /hours must be in 00\.\.23/u,
  );
  assert.throws(() => encodeClassicTemporal("t", "24:00:01"), /24:00:00/u);
  assert.throws(() => encodeClassicTemporal("i", "24:01"), /24:00/u);
  assert.throws(() => encodeClassicTemporal("t", "23:59:60"), /seconds/u);
});

test("validates hybrid-calendar week 53 and its reserved year-zero value", () => {
  assert.equal(hex("7", "0000-W53"), "01000000");
  assert.equal(hex("7", "0001-W01"), "02000000");
  assert.equal(hex("7", "0005-W53"), "06010000");
  assert.equal(hex("7", "2020-W53"), "b99b0100");
  assert.throws(() => encodeClassicTemporal("7", "0000-W52"), /only 0000-W53/u);
  assert.throws(() => encodeClassicTemporal("7", "0004-W53"), /does not have week 53/u);
  assert.throws(() => encodeClassicTemporal("7", "2021-W53"), /does not have week 53/u);
});

test("rejects malformed compact temporal forms and invalid raw values", () => {
  for (const [exid, value] of [
    ["p", "2002-02-04T20:15:01,1234567"],
    ["n", "2002-02-04 20:15:01"],
    ["w", "2002-02-04T20:15Z"],
    ["d", "20020204"],
    ["7", "2020-w53"],
    ["x", "2002-2"],
    ["t", "20:15"],
    ["i", "20:15:00"],
    ["c", "--02-04"],
  ] as const) {
    assert.throws(() => encodeClassicTemporal(exid, value), /expects/u, `${exid} ${value}`);
  }

  assert.throws(
    () => encodeClassicTemporal("p", " 0001-01-01T00:00:00.0000000"),
    /expects/u,
  );
  assert.throws(
    () => encodeClassicTemporal("d", 20260715 as unknown as string),
    /expects a string/u,
  );
  assert.throws(
    () => decodeClassicTemporal("d", Buffer.alloc(3)),
    /expects 4 raw bytes/u,
  );
  assert.throws(
    () => decodeClassicTemporal("d", Buffer.from("deb93700", "hex")),
    /outside its valid raw range/u,
  );
  assert.throws(
    () => decodeClassicTemporal("i", Buffer.from("ffff", "hex")),
    /outside its valid raw range/u,
  );
  assert.throws(
    () => classicTemporalByteLength("?" as ClassicTemporalExid),
    /unsupported classic temporal EXID/u,
  );
});

test("does not coerce temporal inputs or consult caller-defined byte geometry", () => {
  let conversions = 0;
  const coercible = {
    toString() {
      conversions += 1;
      return "2002-02-04";
    },
  };
  assert.throws(
    () => encodeClassicTemporal("d", coercible as unknown as string),
    /expects a string/u,
  );
  assert.equal(conversions, 0);

  const raw = Buffer.from("07270b00", "hex");
  let geometryReads = 0;
  Object.defineProperty(raw, "byteLength", {
    configurable: true,
    get() {
      geometryReads += 1;
      return 99;
    },
  });
  assert.equal(decodeClassicTemporal("d", raw), "2002-02-04");
  assert.equal(geometryReads, 0);
});

test("exposes only the nine compact temporal EXIDs and their fixed widths", () => {
  const expected = new Map<ClassicTemporalExid, number>([
    ["p", 8],
    ["n", 8],
    ["w", 8],
    ["d", 4],
    ["7", 4],
    ["x", 4],
    ["t", 4],
    ["i", 2],
    ["c", 2],
  ]);
  for (const [exid, width] of expected) {
    assert.equal(isClassicTemporalExid(exid), true);
    assert.equal(classicTemporalByteLength(exid), width);
  }
  for (const exid of ["D", "T", "P", "?", "", "pp"]) {
    assert.equal(isClassicTemporalExid(exid), false);
  }
});
