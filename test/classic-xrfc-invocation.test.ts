import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClassicRfcInvocationRequest,
  decodeClassicRfcInvocationResult,
  type RfcStructureRepository,
} from "../src/client/classic-invocation.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../src/metadata/rfc-structure-definition.js";
import {
  CpicTag,
  decodeCpicFieldChainPrefix,
  type CpicField,
} from "../src/protocol/cpic.js";

const STFC_DEEP_METADATA: RfcFunctionInterface = Object.freeze({
  name: "STFC_DEEP_TABLE",
  remoteBasxmlSupported: true,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([
    Object.freeze({
      parameterClass: "E",
      parameterName: "EXPORT_TAB",
      tableName: "STFCCPLXT_T",
      fieldName: "",
      exid: "h",
      position: 1,
      offset: 0,
      internalLength: 32,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: false,
    }),
    Object.freeze({
      parameterClass: "E",
      parameterName: "RESPTEXT",
      tableName: "SYST",
      fieldName: "LISEL",
      exid: "C",
      position: 2,
      offset: 0,
      internalLength: 255,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: false,
    }),
    Object.freeze({
      parameterClass: "I",
      parameterName: "IMPORT_TAB",
      tableName: "STFCCPLXT_T",
      fieldName: "",
      exid: "h",
      position: 3,
      offset: 0,
      internalLength: 32,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: false,
    }),
  ]),
  exceptions: Object.freeze([]),
  resumableExceptionRowCount: 0,
});

// The function descriptor names the table type STFCCPLXT_T. Its recursive
// metadata wrapper points to the distinct line structure STFCCPLXT.
const STFC_LINE: RfcStructureDefinition = Object.freeze({
  name: "STFCCPLXT",
  byteLength: 40,
  fields: Object.freeze([
    Object.freeze({ tableName: "STFCCPLXT", fieldName: "I", position: 1, offset: 0, internalLength: 4, decimals: 0, exid: "I" }),
    Object.freeze({ tableName: "STFCCPLXT", fieldName: "C", position: 2, offset: 4, internalLength: 20, decimals: 0, exid: "C" }),
    Object.freeze({ tableName: "STFCCPLXT", fieldName: "STR", position: 3, offset: 24, internalLength: 8, decimals: 0, exid: "g" }),
    Object.freeze({ tableName: "STFCCPLXT", fieldName: "XSTR", position: 4, offset: 32, internalLength: 8, decimals: 0, exid: "y" }),
  ]),
});

const STRUCTURES: RfcStructureRepository = new Map([
  ["STFCCPLXT_T", STFC_LINE],
]);

const INPUT_ROWS = Object.freeze([
  Object.freeze({ I: 42, C: "UNICODE", STR: "Grüße 🌍", XSTR: Buffer.from("deadbeef", "hex") }),
  Object.freeze({ I: -7, C: "EMPTY", STR: "", XSTR: Buffer.alloc(0) }),
]);

const RESPONSE_XML = Buffer.from(
  "<EXPORT_TAB><item><I>42</I><C>UNICODE</C><STR>Grüße 🌍</STR>" +
    "<XSTR>3q2+7w==</XSTR></item><item><I>-7</I><C>EMPTY</C>" +
    "<STR></STR><XSTR></XSTR></item><item><I>10</I><C>Appended</C>" +
    "<STR>20260716</STR><XSTR>3q2+7w==</XSTR></item></EXPORT_TAB>",
  "utf8",
);

function requestFields(input = INPUT_ROWS): ReturnType<typeof decodeCpicFieldChainPrefix>["fields"] {
  const request = buildClassicRfcInvocationRequest(
    STFC_DEEP_METADATA,
    { IMPORT_TAB: input },
    STRUCTURES,
  );
  return decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
}

function responseFields(): CpicField[] {
  return [
    { tag: CpicTag.RequestedOutput, value: Buffer.from("EXPORT_TAB", "utf16le") },
    { tag: CpicTag.RequestedOutput, value: Buffer.from("RESPTEXT", "utf16le") },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: RESPONSE_XML.subarray(0, 12) },
    { tag: CpicTag.XRfcData, value: RESPONSE_XML.subarray(12) },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.ParameterName, value: Buffer.from("RESPTEXT", "utf16le") },
    { tag: CpicTag.ParameterValue, value: Buffer.from("ok".padEnd(255), "utf16le") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
}

test("builds the real I/E RFCTYPE_TABLE STFC_DEEP_TABLE request shape", () => {
  const fields = requestFields();
  assert.deepEqual(
    fields
      .filter((field) => field.tag === CpicTag.RequestedOutput)
      .map((field) => Buffer.from(field.value).toString("utf16le")),
    ["EXPORT_TAB", "RESPTEXT"],
  );
  assert.equal(
    fields.some((field) =>
      field.tag === CpicTag.ParameterName &&
      Buffer.from(field.value).toString("utf16le") === "IMPORT_TAB"),
    false,
  );
  const deep = fields.filter((field) =>
    field.tag === CpicTag.XRfcParameter || field.tag === CpicTag.XRfcData);
  assert.deepEqual(deep.map((field) => field.tag), [
    CpicTag.XRfcParameter,
    CpicTag.XRfcData,
    CpicTag.XRfcParameter,
  ]);
  assert.equal(
    Buffer.from(deep[1]!.value).toString("utf8"),
    "<IMPORT_TAB><item><I>42</I><C>UNICODE</C><STR>Grüße 🌍</STR>" +
      "<XSTR>3q2+7w==</XSTR></item><item><I>-7</I><C>EMPTY</C>" +
      "<STR></STR><XSTR></XSTR></item></IMPORT_TAB>",
  );
});

test("resolves table type to its distinct recursive line definition", () => {
  assert.equal(STFC_DEEP_METADATA.parameters[0]!.tableName, "STFCCPLXT_T");
  assert.equal(STFC_LINE.name, "STFCCPLXT");
  assert.doesNotThrow(() => requestFields());
  assert.throws(
    () => buildClassicRfcInvocationRequest(
      STFC_DEEP_METADATA,
      { IMPORT_TAB: INPUT_ROWS },
      new Map([["STFCCPLXT", STFC_LINE]]),
    ),
    /requires unresolved structure STFCCPLXT_T/u,
  );
});

test("decodes the captured two-chunk deep table beside classic output", () => {
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      STFC_DEEP_METADATA,
      responseFields(),
      STRUCTURES,
    ),
    {
      EXPORT_TAB: [
        INPUT_ROWS[0],
        INPUT_ROWS[1],
        { I: 10, C: "Appended", STR: "20260716", XSTR: Buffer.from("deadbeef", "hex") },
      ],
      RESPTEXT: "ok",
    },
  );
});

test("sends an explicit empty xRFC table for mandatory initial input", () => {
  const request = buildClassicRfcInvocationRequest(
    STFC_DEEP_METADATA,
    {},
    STRUCTURES,
  );
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  const data = fields.find((field) => field.tag === CpicTag.XRfcData);
  assert.equal(Buffer.from(data!.value).toString(), "<IMPORT_TAB></IMPORT_TAB>");
});

test("deactivation suppresses deep input and returns initial deep output", () => {
  const request = buildClassicRfcInvocationRequest(
    STFC_DEEP_METADATA,
    { IMPORT_TAB: INPUT_ROWS },
    STRUCTURES,
    { deactivated: new Set(["IMPORT_TAB", "EXPORT_TAB"]) },
  );
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(fields.some((field) => field.tag === CpicTag.XRfcData), false);
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      STFC_DEEP_METADATA,
      [
        { tag: CpicTag.ParameterName, value: Buffer.from("RESPTEXT", "utf16le") },
        { tag: CpicTag.ParameterValue, value: Buffer.from("ok".padEnd(255), "utf16le") },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      STRUCTURES,
      { deactivated: new Set(["EXPORT_TAB"]) },
    ),
    { EXPORT_TAB: [], RESPTEXT: "ok" },
  );
});

test("keeps one preflight XML snapshot and enforces application bounds", () => {
  const bytes = Buffer.from("deadbeef", "hex");
  let rowReads = 0;
  const row: Record<string, unknown> = { I: 1, C: "ONE", STR: "text" };
  Object.defineProperty(row, "XSTR", {
    enumerable: true,
    get() {
      rowReads += 1;
      return bytes;
    },
  });
  const request = buildClassicRfcInvocationRequest(
    STFC_DEEP_METADATA,
    { IMPORT_TAB: [row] },
    STRUCTURES,
  );
  bytes.fill(0);
  assert.equal(rowReads, 1);
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.match(
    Buffer.from(fields.find((field) => field.tag === CpicTag.XRfcData)!.value).toString(),
    /<XSTR>3q2\+7w==<\/XSTR>/u,
  );
  const maximumApplicationDataLength = request.byteLength - 8;
  assert.throws(
    () => buildClassicRfcInvocationRequest(
      STFC_DEEP_METADATA,
      { IMPORT_TAB: [row] },
      STRUCTURES,
      { maxApplicationDataLength: maximumApplicationDataLength - 1 },
    ),
    /application length exceeds configured limit/u,
  );
});

test("keeps multiple deep parameters as independent invocation envelopes", () => {
  const inputParameter = STFC_DEEP_METADATA.parameters[2]!;
  const outputParameter = STFC_DEEP_METADATA.parameters[0]!;
  const metadata: RfcFunctionInterface = {
    ...STFC_DEEP_METADATA,
    name: "Z_MULTI_DEEP",
    parameters: [
      { ...inputParameter, parameterName: "FIRST_IN", position: 1 },
      { ...inputParameter, parameterName: "SECOND_IN", position: 2 },
      { ...outputParameter, parameterName: "FIRST_OUT", position: 3 },
      { ...outputParameter, parameterName: "SECOND_OUT", position: 4 },
    ],
  };
  const request = buildClassicRfcInvocationRequest(
    metadata,
    { FIRST_IN: [], SECOND_IN: INPUT_ROWS },
    STRUCTURES,
  );
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.deepEqual(
    fields
      .filter((field) => field.tag === CpicTag.XRfcData)
      .map((field) => Buffer.from(field.value).toString("utf8").match(/^<([^>]+)>/u)![1]),
    ["FIRST_IN", "SECOND_IN"],
  );

  const envelope = (name: string): CpicField[] => [
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: Buffer.from(`<${name}></${name}>`) },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
  ];
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      metadata,
      [
        ...envelope("FIRST_OUT"),
        ...envelope("SECOND_OUT"),
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      STRUCTURES,
    ),
    { FIRST_OUT: [], SECOND_OUT: [] },
  );
});

test("rejects unknown, duplicate, mismatched, and missing deep outputs", () => {
  const xml = (name: string) => Buffer.from(`<${name}></${name}>`);
  assert.throws(
    () => decodeClassicRfcInvocationResult(
      STFC_DEEP_METADATA,
      [
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.XRfcData, value: xml("UNKNOWN") },
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      STRUCTURES,
    ),
    /unknown xRFC parameter UNKNOWN/u,
  );
  assert.throws(
    () => decodeClassicRfcInvocationResult(
      STFC_DEEP_METADATA,
      [
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.XRfcData, value: xml("EXPORT_TAB") },
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.XRfcData, value: xml("EXPORT_TAB") },
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      STRUCTURES,
    ),
    /duplicate parameter EXPORT_TAB/u,
  );
  assert.throws(
    () => decodeClassicRfcInvocationResult(
      STFC_DEEP_METADATA,
      [
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.XRfcData, value: xml("RESPTEXT") },
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      STRUCTURES,
    ),
    /xRFC XML for non-deep parameter RESPTEXT/u,
  );
  assert.throws(
    () => decodeClassicRfcInvocationResult(
      STFC_DEEP_METADATA,
      [{ tag: CpicTag.End, value: Buffer.alloc(0) }],
      STRUCTURES,
    ),
    /lacks requested output EXPORT_TAB/u,
  );
});
