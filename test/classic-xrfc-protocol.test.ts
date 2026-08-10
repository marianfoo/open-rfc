import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASSIC_XRFC_XML_CHUNK_LENGTH,
  CpicTag,
  decodeCpicFieldChainPrefix,
  decodeCpicFunctionResponse,
  decodeCpicFunctionResultFields,
  encodeCpicCutFunctionRequest,
  encodeCpicFieldChain,
  type CpicField,
} from "../src/protocol/cpic.js";
import { decodeClassicRfcResult } from "../src/protocol/classic-rfc.js";

function responseWith(fields: readonly CpicField[]): Buffer {
  return Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, fields),
    Buffer.from("ffff", "hex"),
  ]);
}

function cutFields(value: Uint8Array): ReturnType<typeof decodeCpicFieldChainPrefix>["fields"] {
  const encoded = encodeCpicCutFunctionRequest({
    functionName: "STFC_DEEP_TABLE",
    requestedOutputs: ["EXPORT_TAB", "RESPTEXT"],
    xrfcParameters: [{ name: "IMPORT_TAB", value }],
  });
  return decodeCpicFieldChainPrefix(
    encoded.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
}

test("uses the supported xRFC tags and one 16 KiB request chunk", () => {
  assert.equal(CpicTag.XRfcParameter, 0x3c02);
  assert.equal(CpicTag.XRfcData, 0x3c05);
  const xml = Buffer.from("<IMPORT_TAB></IMPORT_TAB>");
  const fields = cutFields(xml);
  assert.deepEqual(
    fields.map((field) => [field.tag, field.value.byteLength]),
    [
      [CpicTag.Kernel, 6],
      [CpicTag.Function, 30],
      [CpicTag.CallContext, 0],
      [CpicTag.RequestedOutput, 20],
      [CpicTag.RequestedOutput, 16],
      [CpicTag.XRfcParameter, 0],
      [CpicTag.XRfcData, xml.byteLength],
      [CpicTag.XRfcParameter, 0],
      [CpicTag.End, 0],
    ],
  );
  assert.deepEqual(Buffer.from(fields[6]!.value), xml);
});

test("chunks xRFC XML at the 16,384-byte boundary", () => {
  for (const byteLength of [
    CLASSIC_XRFC_XML_CHUNK_LENGTH,
    CLASSIC_XRFC_XML_CHUNK_LENGTH + 1,
  ]) {
    const data = Buffer.alloc(byteLength, 0x61);
    const chunks = cutFields(data).filter(
      (field) => field.tag === CpicTag.XRfcData,
    );
    assert.deepEqual(
      chunks.map((field) => field.value.byteLength),
      byteLength === CLASSIC_XRFC_XML_CHUNK_LENGTH
        ? [CLASSIC_XRFC_XML_CHUNK_LENGTH]
        : [CLASSIC_XRFC_XML_CHUNK_LENGTH, 1],
    );
    assert.deepEqual(Buffer.concat(chunks.map((field) => field.value)), data);
  }
});

test("keeps multiple xRFC parameters in independent ordered boundary pairs", () => {
  const encoded = encodeCpicCutFunctionRequest({
    functionName: "Z_DEEP",
    xrfcParameters: [
      { name: "FIRST", value: Buffer.from("<FIRST></FIRST>") },
      { name: "SECOND", value: Buffer.from("<SECOND></SECOND>") },
    ],
  });
  const deep = decodeCpicFieldChainPrefix(
    encoded.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields.filter((field) =>
    field.tag === CpicTag.XRfcParameter || field.tag === CpicTag.XRfcData);
  assert.deepEqual(
    deep.map((field) => [field.tag, Buffer.from(field.value).toString("utf8")]),
    [
      [CpicTag.XRfcParameter, ""],
      [CpicTag.XRfcData, "<FIRST></FIRST>"],
      [CpicTag.XRfcParameter, ""],
      [CpicTag.XRfcParameter, ""],
      [CpicTag.XRfcData, "<SECOND></SECOND>"],
      [CpicTag.XRfcParameter, ""],
    ],
  );
});

test("rejects duplicate, conflicting, empty, and non-byte xRFC inputs", () => {
  assert.throws(
    () => encodeCpicCutFunctionRequest({
      functionName: "Z_DEEP",
      xrfcParameters: [
        { name: "ROWS", value: Buffer.of(1) },
        { name: "ROWS", value: Buffer.of(2) },
      ],
    }),
    /duplicate xRFC parameter ROWS/u,
  );
  assert.throws(
    () => encodeCpicCutFunctionRequest({
      functionName: "Z_DEEP",
      imports: [{ name: "ROWS", value: Buffer.alloc(0) }],
      xrfcParameters: [{ name: "ROWS", value: Buffer.of(1) }],
    }),
    /duplicate input parameter ROWS/u,
  );
  assert.throws(
    () => encodeCpicCutFunctionRequest({
      functionName: "Z_DEEP",
      xrfcParameters: [{ name: "ROWS", value: Buffer.alloc(0) }],
    }),
    /must not be empty/u,
  );
  assert.throws(
    () => encodeCpicCutFunctionRequest({
      functionName: "Z_DEEP",
      xrfcParameters: [{ name: "ROWS", value: "xml" as unknown as Uint8Array }],
    }),
    /must be Uint8Array bytes/u,
  );
});

test("regular result and diagnostic decoders allow only the proven xRFC tags", () => {
  const response = responseWith([
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: Buffer.from("<ROWS></ROWS>") },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.equal(decodeCpicFunctionResultFields(response).success, true);
  assert.equal(decodeCpicFunctionResponse(response).success, true);
  const unknown = responseWith([
    { tag: 0x3c06, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.throws(
    () => decodeCpicFunctionResultFields(unknown),
    /unknown tag 0x3c06/u,
  );
});

test("groups captured response chunks and clones their XML bytes", () => {
  const first = Buffer.from("<EXPORT_TAB>");
  const second = Buffer.from("<item></item></EXPORT_TAB>");
  const fields: CpicField[] = [
    { tag: CpicTag.ParameterName, value: Buffer.from("RESPTEXT", "utf16le") },
    { tag: CpicTag.ParameterValue, value: Buffer.from("ok", "utf16le") },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: first },
    { tag: CpicTag.XRfcData, value: second },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
  const result = decodeClassicRfcResult(fields);
  assert.equal(result.xrfcParameters.length, 1);
  assert.equal(result.xrfcParameters[0]!.chunkCount, 2);
  assert.equal(
    result.xrfcParameters[0]!.value.toString("utf8"),
    "<EXPORT_TAB><item></item></EXPORT_TAB>",
  );
  first.fill(0);
  second.fill(0);
  assert.equal(
    result.xrfcParameters[0]!.value.toString("utf8"),
    "<EXPORT_TAB><item></item></EXPORT_TAB>",
  );
});

test("preserves multiple xRFC envelopes and rejects malformed boundary grammar", () => {
  const result = decodeClassicRfcResult([
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: Buffer.from("<A></A>") },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: Buffer.from("<B></B>") },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.deepEqual(
    result.xrfcParameters.map((parameter) => parameter.value.toString()),
    ["<A></A>", "<B></B>"],
  );

  const malformed: readonly (readonly CpicField[])[] = [
    [
      { tag: CpicTag.XRfcData, value: Buffer.of(1) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.XRfcParameter, value: Buffer.of(1) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
      { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
      { tag: CpicTag.XRfcData, value: Buffer.alloc(0) },
      { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
      { tag: CpicTag.XRfcData, value: Buffer.of(1) },
      { tag: CpicTag.ParameterName, value: Buffer.from("X", "utf16le") },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
      { tag: CpicTag.XRfcData, value: Buffer.of(1) },
      { tag: CpicTag.XRfcParameter, value: Buffer.of(1) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
  ];
  for (const fields of malformed) {
    assert.throws(() => decodeClassicRfcResult(fields));
  }
});
