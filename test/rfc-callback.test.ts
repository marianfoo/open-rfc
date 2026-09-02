import assert from "node:assert/strict";
import test from "node:test";

import {
  CpicTag,
  decodeCpicFunctionResultFields,
  encodeCpicCutFunctionRequest,
  encodeCpicFieldChain,
} from "../src/protocol/cpic.js";
import { decodeClassicRfcResult } from "../src/protocol/classic-rfc.js";
import {
  decodeCpicRfcCallbackRequest,
  encodeCpicRfcCallbackException,
  encodeCpicRfcCallbackResponse,
  frameCpicRfcCallbackResponse,
  inspectFramedCpicRfcCallbackResponse,
  isCpicRfcCallbackRequest,
  snapshotRfcCallbackHandlers,
} from "../src/protocol/rfc-callback.js";

test("decodes a bounded CUT callback request with raw values", () => {
  const request = encodeCpicCutFunctionRequest({
    functionName: "STFC_CONNECTION",
    requestedOutputs: ["ECHOTEXT"],
    imports: [{
      name: "REQUTEXT",
      value: Buffer.from("callback".padEnd(20, " "), "utf16le"),
    }],
    tables: [{
      name: "ITEMS",
      rowByteLength: 4,
      rows: [Buffer.from("01020304", "hex")],
    }],
    xrfcParameters: [{
      name: "DEEP",
      value: Buffer.from("<DEEP><TEXT>one</TEXT></DEEP>"),
    }],
  });
  assert.equal(isCpicRfcCallbackRequest(request), true);
  const decoded = decodeCpicRfcCallbackRequest(
    request.subarray(0, request.byteLength - 8),
  );
  assert.equal(decoded.functionName, "STFC_CONNECTION");
  assert.equal(decoded.kernelRelease, "754");
  assert.deepEqual(decoded.requestedOutputs, ["ECHOTEXT"]);
  assert.equal(decoded.imports[0]!.name, "REQUTEXT");
  assert.equal(decoded.imports[0]!.value.toString("utf16le").trimEnd(), "callback");
  assert.deepEqual(decoded.tables, [{
    name: "ITEMS",
    rowByteLength: 4,
    rows: [Buffer.from("01020304", "hex")],
  }]);
  assert.deepEqual(decoded.xrfcParameters, [{
    name: "DEEP",
    value: Buffer.from("<DEEP><TEXT>one</TEXT></DEEP>"),
    chunkCount: 1,
  }]);
});

test("rejects malformed and colliding callback xRFC parameter roots", () => {
  const request = (xml: string, importName?: string): Buffer =>
    encodeCpicCutFunctionRequest({
      functionName: "Z_CALLBACK",
      imports: importName === undefined
        ? []
        : [{ name: importName, value: Buffer.alloc(2) }],
      xrfcParameters: [{ name: "DIAGNOSTIC", value: Buffer.from(xml) }],
    }).subarray(0, -8);

  assert.throws(
    () => decodeCpicRfcCallbackRequest(request("not XML")),
    /top-level tag/u,
  );
  assert.throws(
    () => decodeCpicRfcCallbackRequest(request("<DEEP></DEEP>", "DEEP")),
    /repeats input parameter DEEP/u,
  );
});

test("expands bounded simple-compressed callback table rows", () => {
  const request = (rowByteLength: number): Buffer => {
    const tableHeader = Buffer.alloc(8);
    tableHeader.writeUInt32BE(rowByteLength, 0);
    tableHeader.writeUInt32BE(1, 4);
    return Buffer.concat([
      Buffer.from("05020000", "hex"),
      encodeCpicFieldChain(CpicTag.ContextEnd, [
        { tag: CpicTag.Function, value: Buffer.from("Z_CALLBACK", "utf16le") },
        { tag: CpicTag.TableName, value: Buffer.from("ITEMS", "utf16le") },
        { tag: CpicTag.TableHeader, value: tableHeader },
        { tag: CpicTag.TableCompr, value: Buffer.from("4120", "hex") },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      Buffer.from("ffff", "hex"),
    ]);
  };

  assert.deepEqual(decodeCpicRfcCallbackRequest(request(4)).tables, [{
    name: "ITEMS",
    rowByteLength: 4,
    rows: [Buffer.from("41202020", "hex")],
  }]);

  assert.throws(
    () => decodeCpicRfcCallbackRequest(request(0xffff_ffff)),
    /decoded bytes exceed/u,
  );
});

test("encodes callback success and declared-exception responses", () => {
  const echo = Buffer.from("callback".padEnd(20, " "), "utf16le");
  const response = encodeCpicRfcCallbackResponse({
    exports: [{ name: "ECHOTEXT", value: echo }],
    tables: [{
      name: "ITEMS",
      rowByteLength: 4,
      rows: [Buffer.from("01020304", "hex")],
    }],
  });
  const decoded = decodeCpicFunctionResultFields(response);
  assert.equal(decoded.success, true);
  const classic = decodeClassicRfcResult(decoded.fields);
  assert.deepEqual(classic.scalars, [{ name: "ECHOTEXT", value: echo }]);
  assert.deepEqual(classic.tables[0]?.rows, [Buffer.from("01020304", "hex")]);

  const exception = decodeCpicFunctionResultFields(
    encodeCpicRfcCallbackException("FU_NOT_FOUND"),
  );
  assert.equal(exception.success, false);
  assert.equal(exception.envelope.outcome, "abapException");
  assert.equal(exception.envelope.facts.exceptionKey, "FU_NOT_FOUND");

  const handlerException = decodeCpicFunctionResultFields(
    encodeCpicRfcCallbackResponse({ exception: "NO_AUTHORITY" }),
  );
  assert.equal(handlerException.success, false);
  assert.equal(
    handlerException.envelope.facts.exceptionKey,
    "NO_AUTHORITY",
  );
  assert.throws(
    () => encodeCpicRfcCallbackResponse({
      exception: "NO_AUTHORITY",
      exports: [],
    } as never),
    /must not include exports/u,
  );
  assert.throws(
    () => encodeCpicRfcCallbackResponse({
      exports: [{ name: "UNREQUESTED", value: Buffer.alloc(0) }],
    }, ["EXPECTED"]),
    /UNREQUESTED was not requested/u,
  );
  assert.doesNotThrow(
    () => encodeCpicRfcCallbackResponse({
      exports: [{ name: "EXPECTED", value: Buffer.alloc(0) }],
    }, ["EXPECTED", "OPTIONAL"]),
  );
});

test("frames compact and streamed callback replies for the APPC sender", () => {
  const compact = frameCpicRfcCallbackResponse(
    encodeCpicRfcCallbackResponse({ exports: [] }),
  );
  assert.deepEqual(inspectFramedCpicRfcCallbackResponse(compact), {
    mode: "compact",
    applicationDataLength: compact.byteLength - 8,
    finalSapParameterLength: 8,
  });

  const streamed = frameCpicRfcCallbackResponse(
    encodeCpicRfcCallbackResponse({
      exports: [{ name: "VALUE", value: Buffer.alloc(30_000, 0x41) }],
    }),
  );
  assert.deepEqual(inspectFramedCpicRfcCallbackResponse(streamed), {
    mode: "streamed",
    applicationDataLength: streamed.byteLength,
    finalSapParameterLength: 0,
  });
});

test("rejects malformed callback grammar and unsafe handler tables", () => {
  const badPrefix = Buffer.from("00000000ffff", "hex");
  assert.equal(isCpicRfcCallbackRequest(badPrefix), false);
  assert.throws(
    () => decodeCpicRfcCallbackRequest(badPrefix),
    /prefix is invalid/u,
  );

  const orphanValue = Buffer.concat([
    Buffer.from("05020000", "hex"),
    encodeCpicFieldChain(CpicTag.ContextEnd, [
      { tag: CpicTag.Function, value: Buffer.from("Z_CALLBACK", "utf16le") },
      { tag: CpicTag.ParameterValue, value: Buffer.of(1) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  assert.throws(
    () => decodeCpicRfcCallbackRequest(orphanValue),
    /value has no preceding name/u,
  );

  assert.throws(
    () => snapshotRfcCallbackHandlers(new Proxy({}, {}) as never),
    /plain object/u,
  );
  assert.throws(
    () => snapshotRfcCallbackHandlers({ Z_CALLBACK: 1 as never }),
    /must be a function/u,
  );
  const handler = () => ({ exports: [] });
  const snapshotted = snapshotRfcCallbackHandlers({ Z_CALLBACK: handler });
  assert.equal(snapshotted?.get("Z_CALLBACK"), handler);

  assert.throws(
    () => encodeCpicRfcCallbackResponse({
      tables: [{ name: "ITEMS", rowByteLength: 0, rows: [Buffer.alloc(0)] }],
    }),
    /zero-width rows/u,
  );

  let oversizedRowRead = false;
  const oversizedRows = [Buffer.alloc(1)];
  Object.defineProperty(oversizedRows, 0, {
    get() {
      oversizedRowRead = true;
      return Buffer.alloc(1);
    },
  });
  assert.throws(
    () => encodeCpicRfcCallbackResponse({
      tables: [{
        name: "ITEMS",
        rowByteLength: 0xffff_ffff,
        rows: oversizedRows,
      }],
    }),
    /response value bytes exceed/u,
  );
  assert.equal(oversizedRowRead, false);

  assert.throws(
    () => encodeCpicRfcCallbackResponse({ exports: Array(1) }),
    /must be an object/u,
  );
});
