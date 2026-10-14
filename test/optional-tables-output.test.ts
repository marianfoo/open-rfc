import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClassicRfcInvocationRequest,
  decodeClassicRfcInvocationResult,
} from "../src/client/classic-invocation.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import { CpicTag, decodeCpicFieldChainPrefix, type CpicField } from "../src/protocol/cpic.js";

const metadata: RfcFunctionInterface = {
  name: "Z_OPTIONAL_TABLE_OUTPUT",
  remoteBasxmlSupported: false,
  remoteCall: "R",
  updateTask: false,
  parameters: [
    { parameterClass: "T", parameterName: "ROWS" },
    { parameterClass: "I", parameterName: "OPTIONAL_INPUT" },
    { parameterClass: "C", parameterName: "OPTIONAL_CHANGING" },
  ].map((parameter, index) => ({
    ...parameter,
    tableName: "",
    fieldName: "",
    exid: "I",
    position: index + 1,
    offset: 0,
    internalLength: 4,
    decimals: 0,
    defaultValue: "",
    parameterText: "",
    optional: true,
  })),
  exceptions: [],
  resumableExceptionRowCount: 0,
};

function requestFields(input: Record<string, unknown> = {}, options = {}) {
  const request = buildClassicRfcInvocationRequest(metadata, input, new Map(), options);
  return decodeCpicFieldChainPrefix(request.subarray(4), CpicTag.ContextEnd, CpicTag.End).fields;
}

function named(fields: readonly CpicField[], tag: CpicTag) {
  return fields.filter(field => field.tag === tag)
    .map(field => Buffer.from(field.value).toString("utf16le"));
}

function response(rows: readonly number[]): CpicField[] {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(rows.length, 4);
  return [
    { tag: CpicTag.TableName, value: Buffer.from("ROWS", "utf16le") },
    { tag: CpicTag.TableHeader, value: header },
    ...rows.map(value => {
      const row = Buffer.alloc(4);
      row.writeInt32LE(value);
      return { tag: CpicTag.TableCompr, value: row };
    }),
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
}

test("omitted optional TABLES requests output without synthesizing input", () => {
  const fields = requestFields();
  assert.deepEqual(named(fields, CpicTag.RequestedOutput), ["ROWS"]);
  assert.deepEqual(named(fields, CpicTag.TableName), []);
  assert.deepEqual(named(fields, CpicTag.ParameterName), []);
  const supplied = requestFields({ ROWS: [42] });
  assert.deepEqual(named(supplied, CpicTag.RequestedOutput), ["ROWS"]);
  assert.deepEqual(named(supplied, CpicTag.TableName), ["ROWS"]);
  const header = supplied.find(field => field.tag === CpicTag.TableHeader)!;
  assert.equal(Buffer.from(header.value).readUInt32BE(4), 1);
});

for (const rows of [[], [42]]) {
  test(`omitted optional TABLES decodes ${rows.length} returned rows`, () => {
    assert.deepEqual(
      decodeClassicRfcInvocationResult(metadata, response(rows), new Map()),
      { ROWS: rows },
    );
  });
}

for (const option of ["notRequested", "deactivated"] as const) {
  test(`explicit ${option} preserves TABLES suppression`, () => {
    const options = { [option]: new Set(["ROWS"]) };
    const fields = requestFields({}, options);
    assert.deepEqual(named(fields, CpicTag.RequestedOutput), []);
    assert.deepEqual(named(fields, CpicTag.TableName), []);
    assert.deepEqual(
      decodeClassicRfcInvocationResult(metadata, [{ tag: CpicTag.End, value: Buffer.alloc(0) }], new Map(), options),
      { ROWS: [] },
    );
  });
}

test("missing active TABLES output remains a malformed response", () => {
  assert.throws(
    () => decodeClassicRfcInvocationResult(metadata, [{ tag: CpicTag.End, value: Buffer.alloc(0) }], new Map()),
    /lacks requested output ROWS/u,
  );
});
