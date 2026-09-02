import assert from "node:assert/strict";
import test from "node:test";

import type { RfcStructureDefinition } from "../src/metadata/rfc-structure-definition.js";
import {
  decodeClassicXrfcBase64,
  decodeClassicXrfcParameter,
  decodeClassicXrfcParameterName,
  encodeClassicXrfcParameter,
} from "../src/values/classic-xrfc.js";

const STFC_ROW: RfcStructureDefinition = Object.freeze({
  name: "STFCCPLXT_T",
  byteLength: 40,
  fields: Object.freeze([
    Object.freeze({
      tableName: "STFCCPLXT_T",
      fieldName: "I",
      position: 1,
      offset: 0,
      internalLength: 4,
      decimals: 0,
      exid: "I",
    }),
    Object.freeze({
      tableName: "STFCCPLXT_T",
      fieldName: "C",
      position: 2,
      offset: 4,
      internalLength: 20,
      decimals: 0,
      exid: "C",
    }),
    Object.freeze({
      tableName: "STFCCPLXT_T",
      fieldName: "STR",
      position: 3,
      offset: 24,
      internalLength: 8,
      decimals: 0,
      exid: "g",
    }),
    Object.freeze({
      tableName: "STFCCPLXT_T",
      fieldName: "XSTR",
      position: 4,
      offset: 32,
      internalLength: 8,
      decimals: 0,
      exid: "y",
    }),
  ]),
});

const CAPTURED_ROWS = Object.freeze([
  Object.freeze({
    I: 42,
    C: "ROW_ONE",
    STR: "A<&\"-nested",
    XSTR: Buffer.from("00a5ff", "hex"),
  }),
  Object.freeze({
    I: -7,
    C: "ROW_TWO",
    STR: "second-row",
    XSTR: Buffer.from("10203040", "hex"),
  }),
]);

const EXTENDED_ROW: RfcStructureDefinition = Object.freeze({
  name: "Z_EXTENDED_XRFC",
  byteLength: 66,
  fields: Object.freeze([
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "NUM", position: 1,
      offset: 0, internalLength: 8, decimals: 0, exid: "N",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "DATE", position: 2,
      offset: 8, internalLength: 16, decimals: 0, exid: "D",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "TIME", position: 3,
      offset: 24, internalLength: 12, decimals: 0, exid: "T",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "BYTE", position: 4,
      offset: 36, internalLength: 2, decimals: 0, exid: "X",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "BCD", position: 5,
      offset: 38, internalLength: 4, decimals: 2, exid: "P",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "FLOAT", position: 6,
      offset: 42, internalLength: 8, decimals: 0, exid: "F",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "INT8", position: 7,
      offset: 50, internalLength: 8, decimals: 0, exid: "8",
    }),
    Object.freeze({
      tableName: "Z_EXTENDED_XRFC", fieldName: "TEXT", position: 8,
      offset: 58, internalLength: 8, decimals: 0, exid: "g",
    }),
  ]),
});

test("encodes the STFC_DEEP_TABLE xRFC XML request exactly", () => {
  const encoded = encodeClassicXrfcParameter(
    "IMPORT_TAB",
    STFC_ROW,
    "table",
    CAPTURED_ROWS,
  );
  assert.equal(
    encoded.toString("utf8"),
    "<IMPORT_TAB><item><I>42</I><C>ROW_ONE</C>" +
      "<STR>A&#60;&#38;\"-nested</STR><XSTR>AKX/</XSTR></item>" +
      "<item><I>-7</I><C>ROW_TWO</C><STR>second-row</STR>" +
      "<XSTR>ECAwQA==</XSTR></item></IMPORT_TAB>",
  );
  assert.equal(decodeClassicXrfcParameterName(encoded), "IMPORT_TAB");
});

test("decodes the STFC_DEEP_TABLE response and numeric entities", () => {
  const response = Buffer.from(
    "<EXPORT_TAB><item><I>42</I><C>ROW_ONE</C>" +
      "<STR>A&#60;&#38;&#34;-nested</STR><XSTR>AKX/</XSTR></item>" +
      "<item><I>-7</I><C>ROW_TWO</C><STR>second-row</STR>" +
      "<XSTR>ECAwQA==</XSTR></item><item><I>10</I><C>Appended</C>" +
      "<STR>20260716</STR><XSTR>3q2+7w==</XSTR></item></EXPORT_TAB>",
    "utf8",
  );
  assert.deepEqual(
    decodeClassicXrfcParameter("EXPORT_TAB", STFC_ROW, "table", response),
    [
      { ...CAPTURED_ROWS[0], STR: "A<&\"-nested" },
      CAPTURED_ROWS[1],
      {
        I: 10,
        C: "Appended",
        STR: "20260716",
        XSTR: Buffer.from("deadbeef", "hex"),
      },
    ],
  );
});

test("constructs flat __proto__ fields as own data without prototype mutation", () => {
  const definition: RfcStructureDefinition = Object.freeze({
    name: "Z_PROTO_ROW",
    byteLength: 8,
    fields: Object.freeze([
      Object.freeze({
        tableName: "Z_PROTO_ROW",
        fieldName: "__proto__",
        position: 1,
        offset: 0,
        internalLength: 8,
        decimals: 0,
        exid: "y",
      }),
    ]),
  });
  const decoded = decodeClassicXrfcParameter(
    "ROW",
    definition,
    "structure",
    Buffer.from("<ROW><__proto__>AQID</__proto__></ROW>"),
  ) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(decoded, "__proto__"), {
    value: Buffer.from([1, 2, 3]),
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

test("matches the Unicode and explicit-empty STFC vector", () => {
  const input = [
    { I: 42, C: "UNICODE", STR: "Grüße 🌍", XSTR: Buffer.from("deadbeef", "hex") },
    { I: -7, C: "EMPTY", STR: "", XSTR: Buffer.alloc(0) },
  ];
  const request = encodeClassicXrfcParameter(
    "IMPORT_TAB",
    STFC_ROW,
    "table",
    input,
  );
  assert.equal(request.byteLength, 163);
  assert.equal(
    request.toString("utf8"),
    "<IMPORT_TAB><item><I>42</I><C>UNICODE</C><STR>Grüße 🌍</STR>" +
      "<XSTR>3q2+7w==</XSTR></item><item><I>-7</I><C>EMPTY</C>" +
      "<STR></STR><XSTR></XSTR></item></IMPORT_TAB>",
  );

  const response = Buffer.from(
    "<EXPORT_TAB><item><I>42</I><C>UNICODE</C><STR>Grüße 🌍</STR>" +
      "<XSTR>3q2+7w==</XSTR></item><item><I>-7</I><C>EMPTY</C>" +
      "<STR></STR><XSTR></XSTR></item><item><I>10</I><C>Appended</C>" +
      "<STR>20260716</STR><XSTR>3q2+7w==</XSTR></item></EXPORT_TAB>",
    "utf8",
  );
  assert.equal(response.byteLength, 240);
  assert.deepEqual(
    decodeClassicXrfcParameter("EXPORT_TAB", STFC_ROW, "table", response),
    [
      input[0],
      input[1],
      { I: 10, C: "Appended", STR: "20260716", XSTR: Buffer.from("deadbeef", "hex") },
    ],
  );
});

test("round-trips initial, Unicode, astral, combining, and arbitrary binary cells", () => {
  const binary = Buffer.from("00ff102080", "hex");
  const encoded = encodeClassicXrfcParameter(
    "IMPORT_TAB",
    STFC_ROW,
    "table",
    [
      {},
      { I: 1, C: "😀", STR: "Grüße 😀 e\u0301", XSTR: binary },
    ],
  );
  binary.fill(0);
  assert.deepEqual(
    decodeClassicXrfcParameter("IMPORT_TAB", STFC_ROW, "table", encoded),
    [
      { I: 0, C: "", STR: "", XSTR: Buffer.alloc(0) },
      {
        I: 1,
        C: "😀",
        STR: "Grüße 😀 e\u0301",
        XSTR: Buffer.from("00ff102080", "hex"),
      },
    ],
  );
  assert.match(encoded.toString("utf8"), /<STR><\/STR><XSTR><\/XSTR>/u);
});

test("round-trips the extended flat xRFC scalar set with compatibility modes", () => {
  const encoded = encodeClassicXrfcParameter(
    "ROW",
    EXTENDED_ROW,
    "structure",
    {
      NUM: "12",
      DATE: "20260717",
      TIME: "154530",
      BYTE: Buffer.of(0xaa),
      BCD: "12.34",
      FLOAT: -0,
      INT8: "-9007199254740993",
      TEXT: "ready",
    },
    { int8Mode: "string" },
  );
  assert.equal(
    encoded.toString(),
    "<ROW><NUM>0012</NUM><DATE>2026-07-17</DATE>" +
      "<TIME>15:45:30</TIME><BYTE>qgA=</BYTE><BCD>12.34</BCD>" +
      "<FLOAT>-0</FLOAT><INT8>-9007199254740993</INT8>" +
      "<TEXT>ready</TEXT></ROW>",
  );
  const decoded = decodeClassicXrfcParameter(
    "ROW",
    EXTENDED_ROW,
    "structure",
    encoded,
    { int8Mode: "string", bcd: "number" },
  ) as Record<string, unknown>;
  assert.deepEqual(decoded, {
    NUM: "0012",
    DATE: "20260717",
    TIME: "154530",
    BYTE: Buffer.from([0xaa, 0]),
    BCD: 12.34,
    FLOAT: -0,
    INT8: "-9007199254740993",
    TEXT: "ready",
  });
  assert.equal(Object.is(decoded.FLOAT, -0), true);

  // A conforming producer may spell a float any way its lexical space allows.
  const withFloat = (lexical: string): unknown =>
    (decodeClassicXrfcParameter(
      "ROW",
      EXTENDED_ROW,
      "structure",
      Buffer.from(
        encoded.toString().replace("<FLOAT>-0</FLOAT>", `<FLOAT>${lexical}</FLOAT>`),
      ),
      { int8Mode: "string", bcd: "number" },
    ) as Record<string, unknown>).FLOAT;
  for (const [lexical, expected] of [
    ["1.5", 1.5], ["+1.5", 1.5], ["01.5", 1.5], ["1.", 1], [".5", 0.5],
    ["-2", -2], ["1e3", 1000], ["+1.5E+02", 150], ["0", 0],
  ] as const) {
    assert.equal(withFloat(lexical), expected, lexical);
  }
  for (const lexical of ["", ".", "+", "1.5.5", "0x10", "1e", "NaN", "Infinity", " 1"]) {
    assert.throws(() => withFloat(lexical), /invalid FLOAT|non-canonical/u, lexical);
  }
});

test("canonicalizes flat xRFC blank DATE/TIME and rejects malformed extended cells", () => {
  for (const temporal of [
    { DATE: "", TIME: "" },
    { DATE: "        ", TIME: "      " },
  ]) {
    const encoded = encodeClassicXrfcParameter(
      "ROW",
      EXTENDED_ROW,
      "structure",
      temporal,
    );
    assert.match(encoded.toString(), /<DATE><\/DATE><TIME><\/TIME>/u);
    const decoded = decodeClassicXrfcParameter(
      "ROW",
      EXTENDED_ROW,
      "structure",
      encoded,
    ) as Record<string, unknown>;
    assert.equal(decoded.DATE, "");
    assert.equal(decoded.TIME, "");
  }
  assert.throws(
    () => decodeClassicXrfcParameter(
      "ROW",
      EXTENDED_ROW,
      "structure",
      Buffer.from(
        "<ROW><NUM>0000</NUM><DATE>20260717</DATE><TIME>15:45:30</TIME>" +
          "<BYTE>qg==</BYTE><BCD>0.00</BCD><FLOAT>0</FLOAT>" +
          "<INT8>0</INT8><TEXT></TEXT></ROW>",
      ),
    ),
    /non-canonical xRFC DATE|fixed byte value/u,
  );
});

test("supports a flat dynamic structure without item wrappers", () => {
  const encoded = encodeClassicXrfcParameter(
    "ROW",
    STFC_ROW,
    "structure",
    CAPTURED_ROWS[0],
  );
  assert.equal(encoded.toString("utf8").startsWith("<ROW><I>42</I>"), true);
  assert.equal(encoded.toString("utf8").includes("<item>"), false);
  assert.deepEqual(
    decodeClassicXrfcParameter("ROW", STFC_ROW, "structure", encoded),
    CAPTURED_ROWS[0],
  );
});

test("decodes SAP MIME-wrapped XSTRING cells without accepting spaces", () => {
  const payload = Buffer.alloc(256);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index & 0xff;
  }
  const canonical = payload.toString("base64");
  const wrapped = canonical.match(/.{1,76}/gu)!.join("\n");
  assert.deepEqual(
    decodeClassicXrfcBase64(wrapped, "ROW.XSTR", 1_024),
    payload,
  );
  assert.deepEqual(
    decodeClassicXrfcBase64(wrapped.replaceAll("\n", "\r\n"), "ROW.XSTR", 1_024),
    payload,
  );
  assert.throws(
    () => decodeClassicXrfcBase64(wrapped.replaceAll("\n", " "), "ROW.XSTR", 1_024),
    /non-canonical base64/u,
  );
});

test("snapshots each row cell once and owns XSTRING bytes", () => {
  const bytes = Buffer.from("aabbcc", "hex");
  let reads = 0;
  const row: Record<string, unknown> = { I: 1, C: "ONE", STR: "text" };
  Object.defineProperty(row, "XSTR", {
    enumerable: true,
    get() {
      reads += 1;
      return bytes;
    },
  });
  const encoded = encodeClassicXrfcParameter(
    "IMPORT_TAB",
    STFC_ROW,
    "table",
    [row],
  );
  bytes.fill(0);
  assert.equal(reads, 1);
  assert.match(encoded.toString("utf8"), /<XSTR>qrvM<\/XSTR>/u);
});

test("rejects malformed geometry and dynamic descriptor slots before row access", () => {
  let rowReads = 0;
  const rows: unknown[] = [];
  Object.defineProperty(rows, 0, {
    enumerable: true,
    get() {
      rowReads += 1;
      return {};
    },
  });
  rows.length = 1;
  const malformed = (changes: Partial<RfcStructureDefinition["fields"][number]>) => ({
    ...STFC_ROW,
    fields: STFC_ROW.fields.map((field, index) =>
      index === 2 ? { ...field, ...changes } : field),
  });
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      malformed({ offset: 20 }),
      "table",
      rows,
    ),
    /invalid geometry|overlap/u,
  );
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      malformed({ internalLength: 4 }),
      "table",
      rows,
    ),
    /STRING descriptor must occupy 8 bytes/u,
  );
  assert.equal(rowReads, 0);
});

test("enforces row-count, cell, row, and aggregate limits before later reads", () => {
  let reads = 0;
  const rows: unknown[] = [{ I: 1, C: "A", STR: "too long", XSTR: Buffer.alloc(0) }];
  Object.defineProperty(rows, 1, {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    },
  });
  rows.length = 2;
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      rows,
      { maxRows: 1 },
    ),
    /row count exceeds 1/u,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      rows,
      { maxCellBytes: 3 },
    ),
    /XML value exceeds 3/u,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      rows,
      { maxRowBytes: 40 },
    ),
    /XML row exceeds 40/u,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      rows,
      { maxParameterBytes: 70 },
    ),
    /xRFC XML exceeds 70/u,
  );
  assert.equal(reads, 0);
});

test("preflights metadata-expanded NUM and fixed bytes before allocation", () => {
  const numericDefinition: RfcStructureDefinition = Object.freeze({
    name: "Z_BOUNDED_NUM",
    byteLength: 2056,
    fields: Object.freeze([
      Object.freeze({
        tableName: "Z_BOUNDED_NUM", fieldName: "NUM", position: 1,
        offset: 0, internalLength: 2048, decimals: 0, exid: "N",
      }),
      Object.freeze({
        tableName: "Z_BOUNDED_NUM", fieldName: "TEXT", position: 2,
        offset: 2048, internalLength: 8, decimals: 0, exid: "g",
      }),
    ]),
  });
  assert.throws(
    () => encodeClassicXrfcParameter(
      "INPUT",
      numericDefinition,
      "structure",
      {},
      { maxCellBytes: 4 },
    ),
    /padded NUM value exceeds the configured encoded-byte limits/u,
  );

  const fixedDefinition: RfcStructureDefinition = Object.freeze({
    name: "Z_BOUNDED_X",
    byteLength: 1032,
    fields: Object.freeze([
      Object.freeze({
        tableName: "Z_BOUNDED_X", fieldName: "BYTES", position: 1,
        offset: 0, internalLength: 1024, decimals: 0, exid: "X",
      }),
      Object.freeze({
        tableName: "Z_BOUNDED_X", fieldName: "TEXT", position: 2,
        offset: 1024, internalLength: 8, decimals: 0, exid: "g",
      }),
    ]),
  });
  assert.throws(
    () => encodeClassicXrfcParameter(
      "INPUT",
      fixedDefinition,
      "structure",
      {},
      { maxCellBytes: 4 },
    ),
    /base64 value exceeds the configured encoded-byte limits/u,
  );
});

test("bounds aggregate materialized NUM output across decoded rows", () => {
  const definition: RfcStructureDefinition = Object.freeze({
    name: "Z_AGGREGATE_NUM",
    byteLength: 2056,
    fields: Object.freeze([
      Object.freeze({
        tableName: "Z_AGGREGATE_NUM", fieldName: "NUM", position: 1,
        offset: 0, internalLength: 2048, decimals: 0, exid: "N",
      }),
      Object.freeze({
        tableName: "Z_AGGREGATE_NUM", fieldName: "TEXT", position: 2,
        offset: 2048, internalLength: 8, decimals: 0, exid: "g",
      }),
    ]),
  });
  const row = "<item><NUM></NUM><TEXT></TEXT></item>";
  const xml = Buffer.from(`<OUTPUT>${row.repeat(8)}</OUTPUT>`);
  assert.ok(xml.byteLength < 4096);
  assert.throws(
    () => decodeClassicXrfcParameter(
      "OUTPUT",
      definition,
      "table",
      xml,
      {
        maxCellBytes: 1024,
        maxParameterBytes: 4096,
      },
    ),
    /decoded output exceeds the 4096-byte parameter limit/u,
  );
});

test("rejects unknown fields, invalid scalars, CHAR overflow, and XML-invalid text", () => {
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      [{ EXTRA: 1 }],
    ),
    /unknown field EXTRA/u,
  );
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      [{ I: 0x8000_0000 }],
    ),
    /signed 32-bit integer/u,
  );
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      [{ C: "12345678901" }],
    ),
    /does not fit CHAR\(10\)/u,
  );
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      [{ STR: "nul\0" }],
    ),
    /contains NUL/u,
  );
  assert.throws(
    () => encodeClassicXrfcParameter(
      "IMPORT_TAB",
      STFC_ROW,
      "table",
      [{ STR: "control\u0001" }],
    ),
    /unsupported by XML 1\.0/u,
  );
});

test("strictly rejects malformed XML grammar, UTF-8, entities, and values", () => {
  const decode = (xml: string | Buffer) =>
    decodeClassicXrfcParameter(
      "EXPORT_TAB",
      STFC_ROW,
      "table",
      typeof xml === "string" ? Buffer.from(xml) : xml,
    );
  const validFields =
    "<I>1</I><C>A</C><STR>x</STR><XSTR>AA==</XSTR>";
  for (const xml of [
    `<?xml version=\"1.0\"?><EXPORT_TAB></EXPORT_TAB>`,
    `<EXPORT_TAB kind=\"x\"></EXPORT_TAB>`,
    `<EXPORT_TAB><item><C>A</C><I>1</I><STR>x</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>]]></STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>&#x0;</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>&#x1;</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>&#xD800;</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>&#x110000;</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>&nbsp;</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>&#X41;</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item>${validFields}</item>`,
    `<EXPORT_TAB><item>${validFields}</item></EXPORT_TAB>tail`,
    `<EXPORT_TAB>${validFields}</EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>01</I><C>A</C><STR>x</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>2147483648</I><C>A</C><STR>x</STR><XSTR>AA==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>x</STR><XSTR>AB==</XSTR></item></EXPORT_TAB>`,
    `<EXPORT_TAB><item><I>1</I><C>A</C><STR>x</STR><XSTR>A</XSTR></item></EXPORT_TAB>`,
  ]) {
    assert.throws(() => decode(xml));
  }
  assert.throws(
    () => decode(Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x45, 0x3e])),
    /must not contain a UTF-8 BOM/u,
  );
  assert.throws(
    () => decode(Buffer.from([0x3c, 0x45, 0x3e, 0xc3, 0x28])),
    /encoded data was not valid/u,
  );
});

test("accepts the whole XML entity grammar a conforming peer may send", () => {
  const decode = (entity: string): unknown =>
    decodeClassicXrfcParameter(
      "EXPORT_TAB",
      STFC_ROW,
      "table",
      Buffer.from(
        `<EXPORT_TAB><item><I>1</I><C>A</C><STR>${entity}</STR>` +
          `<XSTR>AA==</XSTR></item></EXPORT_TAB>`,
      ),
    );
  const row = (STR: string): unknown => [{ I: 1, C: "A", STR, XSTR: Buffer.alloc(1) }];

  for (const [entity, expected] of [
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&apos;", "'"],
  ] as const) {
    assert.deepEqual(decode(entity), row(expected), entity);
  }
  // The classic codec stays XML 1.0 strict on code points, matching its writer;
  // only the reference spelling widens.
  for (const codePoint of [0x09, 0x20, 0x41, 0x7f, 0x80, 0xff, 0x100, 0xfffd, 0x10000, 0x10ffff]) {
    const expected = row(String.fromCodePoint(codePoint));
    for (const entity of [
      `&#${codePoint};`,
      `&#${String(codePoint).padStart(7, "0")};`,
      `&#x${codePoint.toString(16)};`,
      `&#x${codePoint.toString(16).toUpperCase().padStart(6, "0")};`,
    ]) {
      assert.deepEqual(decode(entity), expected, entity);
    }
  }
  for (const invalid of [
    "&#xD800;", "&#57343;", "&#x110000;", "&#1114112;",
    "&#xFFFE;", "&#65535;", "&#0;", "&#x1;",
    "&#38", "&amp", "&nbsp;", "&AMP;", "&;", "&#;", "&#x;", "&#X41;",
    // A zero-padded reference is a spelling, not a different reference: XML 1.0
    // spells both forms with `+`. Only a run past the raw bound is refused.
    `&#${"0".repeat(4096)}38;`,
  ]) {
    assert.throws(() => decode(invalid), /entity|XML 1\.0/u, invalid);
  }
});

test("decoder enforces aggregate, row, cell, and row-count bounds", () => {
  const encoded = encodeClassicXrfcParameter(
    "EXPORT_TAB",
    STFC_ROW,
    "table",
    CAPTURED_ROWS,
  );
  assert.throws(
    () => decodeClassicXrfcParameter(
      "EXPORT_TAB",
      STFC_ROW,
      "table",
      encoded,
      { maxParameterBytes: encoded.byteLength - 1 },
    ),
    /must contain 1/u,
  );
  assert.throws(
    () => decodeClassicXrfcParameter(
      "EXPORT_TAB",
      STFC_ROW,
      "table",
      encoded,
      { maxRows: 1 },
    ),
    /row count exceeds 1/u,
  );
  assert.throws(
    () => decodeClassicXrfcParameter(
      "EXPORT_TAB",
      STFC_ROW,
      "table",
      encoded,
      { maxCellBytes: 3 },
    ),
    /XML value exceeds 3/u,
  );
  assert.throws(
    () => decodeClassicXrfcParameter(
      "EXPORT_TAB",
      STFC_ROW,
      "table",
      encoded,
      { maxRowBytes: 40 },
    ),
    /XML row exceeds 40/u,
  );
});
