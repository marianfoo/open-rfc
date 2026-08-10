import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClassicRfcInvocationRequest,
  decodeClassicRfcInvocationResult,
} from "../src/client/classic-invocation.js";
import type { RfcFunctionInterface } from
  "../src/metadata/rfc-function-interface.js";
import {
  normalizeRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../src/metadata/recursive-metadata.js";
import {
  CpicTag,
  decodeCpicFieldChainPrefix,
  type CpicField,
} from "../src/protocol/cpic.js";

const FUNCTION_NAME = "Z_NESTED_XRFC";

const METADATA: RfcFunctionInterface = Object.freeze({
  name: FUNCTION_NAME,
  remoteBasxmlSupported: true,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([
    Object.freeze({
      parameterClass: "I",
      parameterName: "INPUT",
      tableName: "Z_ROOT",
      fieldName: "",
      exid: "v",
      position: 1,
      offset: 0,
      internalLength: 16,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: false,
    }),
    Object.freeze({
      parameterClass: "E",
      parameterName: "OUTPUT",
      tableName: "Z_ROOT",
      fieldName: "",
      exid: "v",
      position: 2,
      offset: 0,
      internalLength: 16,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: false,
    }),
  ]),
  exceptions: Object.freeze([]),
  resumableExceptionRowCount: 0,
});

function typeRow(options: {
  readonly typeName: string;
  readonly fieldName: string;
  readonly fieldType: string;
  readonly internalType: string;
  readonly componentType?: string;
  readonly dataType?: string;
  readonly total?: number;
  readonly offset?: number;
  readonly length?: number;
}): Record<string, unknown> {
  return {
    TYPENAME: options.typeName,
    FIELDNAME: options.fieldName,
    COMPTYPE: options.componentType ?? "E",
    FIELDTYPE: options.fieldType,
    DATATYPE: options.dataType ?? "CHAR",
    TABLENGTH: options.total ?? 8,
    TABLENGTH_UC: options.total ?? 8,
    DESCRIPTION: "",
    DECIMALS: 0,
    INTTYPE: options.internalType,
    OFFSET: options.offset ?? 0,
    OFFSET_UC: options.offset ?? 0,
    INTLEN: options.length ?? 8,
    INTLEN_UC: options.length ?? 8,
    TIMESTAMP: "20260716123456",
  };
}

function graph(
  functionName = FUNCTION_NAME,
  includeTablesParameter = false,
): RecursiveMetadataGraph {
  const parameter = (
    name: string,
    parameterClass: "I" | "E" | "T",
    position: number,
    tableName = "Z_ROOT",
    internalType = "v",
  ) => ({
    FUNCNAME: functionName,
    PARAMCLASS: parameterClass,
    PARAMETER: name,
    TABNAME: tableName,
    FIELDNAME: "",
    EXID: internalType,
    POSITION: position,
    OFFSET: 0,
    INTLENGTH: 16,
    DECIMALS: 0,
    DEFAULT: "",
    PARAMTEXT: "",
    OPTIONAL: "",
  });
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: functionName,
      BASXML_SUPPORTED: "X",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [
      typeRow({
        typeName: "Z_ROOT",
        fieldName: "HEAD",
        fieldType: "Z_HEAD",
        internalType: "u",
        componentType: "S",
        dataType: "STRU",
        total: 16,
        length: 8,
      }),
      typeRow({
        typeName: "Z_ROOT",
        fieldName: "ROWS",
        fieldType: "Z_ROWS",
        internalType: "h",
        componentType: "T",
        dataType: "TTYP",
        total: 16,
        offset: 8,
        length: 8,
      }),
      typeRow({
        typeName: "Z_HEAD",
        fieldName: "TEXT",
        fieldType: "STRING",
        internalType: "g",
        dataType: "STRG",
      }),
      typeRow({
        typeName: "Z_ROWS",
        fieldName: "",
        fieldType: "Z_ROW",
        internalType: "v",
        componentType: "S",
        dataType: "STRU",
        total: 12,
        length: 12,
      }),
      typeRow({
        typeName: "Z_ROW",
        fieldName: "NUMBER",
        fieldType: "INT4",
        internalType: "I",
        dataType: "INT4",
        total: 12,
        length: 4,
      }),
      typeRow({
        typeName: "Z_ROW",
        fieldName: "RAW",
        fieldType: "XSTRING",
        internalType: "y",
        dataType: "RSTR",
        total: 12,
        offset: 4,
        length: 8,
      }),
    ],
    INDIRECTTYPES: [],
    PARAMETERS: [
      parameter("INPUT", "I", 1),
      parameter("OUTPUT", "E", 2),
      ...(includeTablesParameter
        ? [parameter("TABLE", "T", 3, "Z_ROWS", "h")]
        : []),
    ],
  });
}

const INPUT = Object.freeze({
  HEAD: Object.freeze({ TEXT: "nested" }),
  ROWS: Object.freeze([
    Object.freeze({ NUMBER: 3, RAW: Buffer.from("cafe", "hex") }),
  ]),
});

function requestXrfcData(recursive: RecursiveMetadataGraph): string {
  const request = buildClassicRfcInvocationRequest(
    METADATA,
    { INPUT },
    new Map(),
    {},
    recursive,
  );
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.deepEqual(
    fields
      .filter(({ tag }) => tag === CpicTag.RequestedOutput)
      .map(({ value }) => Buffer.from(value).toString("utf16le")),
    ["OUTPUT"],
  );
  return Buffer.concat(
    fields
      .filter(({ tag }) => tag === CpicTag.XRfcData)
      .map(({ value }) => Buffer.from(value)),
  ).toString("utf8");
}

test("integrates a recursive structure into the classic invocation xRFC envelope", () => {
  assert.equal(
    requestXrfcData(graph()),
    "<INPUT><HEAD><TEXT>nested</TEXT></HEAD><ROWS><item><NUMBER>3</NUMBER>" +
      "<RAW>yv4=</RAW></item></ROWS></INPUT>",
  );
});

test("indexes recursive parameter names once per invocation dispatch", () => {
  const source = graph();
  let parameterNameReads = 0;
  const countedParameters = source.parameters.map((parameter) => {
    const { name, ...properties } = parameter;
    const counted = { ...properties } as Record<string, unknown>;
    Object.defineProperty(counted, "name", {
      enumerable: true,
      configurable: false,
      get() {
        parameterNameReads += 1;
        return name;
      },
    });
    return Object.freeze(counted);
  });
  const countedGraph = Object.freeze({
    ...source,
    parameters: Object.freeze(countedParameters),
  }) as unknown as RecursiveMetadataGraph;

  assert.equal(
    requestXrfcData(countedGraph),
    "<INPUT><HEAD><TEXT>nested</TEXT></HEAD><ROWS><item><NUMBER>3</NUMBER>" +
      "<RAW>yv4=</RAW></item></ROWS></INPUT>",
  );
  assert.equal(parameterNameReads, source.parameters.length);
});

test("rejects duplicate recursive names before dispatch, including inactive extras", () => {
  const source = graph();
  const unrelated = Object.freeze({
    ...source.parameters[0]!,
    name: "UNRELATED",
  });
  const duplicateGraph = Object.freeze({
    ...source,
    parameters: Object.freeze([
      ...source.parameters,
      unrelated,
      Object.freeze({ ...unrelated }),
    ]),
  }) as RecursiveMetadataGraph;

  assert.throws(
    () => requestXrfcData(duplicateGraph),
    /UNRELATED has duplicate recursive metadata/u,
  );
});

test("rejects proxied, accessor-backed, and sparse parameter inventories", () => {
  const source = graph();
  const proxied = new Proxy([...source.parameters], {});
  assert.throws(
    () => requestXrfcData({ ...source, parameters: proxied }),
    /parameters must not be a proxy/u,
  );

  let accessorReads = 0;
  const accessorBacked = [...source.parameters];
  Object.defineProperty(accessorBacked, "0", {
    enumerable: true,
    configurable: true,
    get() {
      accessorReads += 1;
      return source.parameters[0];
    },
  });
  assert.throws(
    () => requestXrfcData({ ...source, parameters: accessorBacked }),
    /parameter 0 must be an own data property/u,
  );
  assert.equal(accessorReads, 0);

  const sparse = [...source.parameters];
  delete sparse[0];
  assert.throws(
    () => requestXrfcData({ ...source, parameters: sparse }),
    /parameter 0 must be an own data property/u,
  );
});

test("decodes a recursive xRFC output and preserves deactivated initial values", () => {
  const responseXml = Buffer.from(
    "<OUTPUT><HEAD><TEXT>result</TEXT></HEAD><ROWS><item><NUMBER>-4</NUMBER>" +
      "<RAW>AAE=</RAW></item></ROWS></OUTPUT>",
  );
  const response: CpicField[] = [
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: responseXml.subarray(0, 17) },
    { tag: CpicTag.XRfcData, value: responseXml.subarray(17) },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
  assert.deepEqual(
    decodeClassicRfcInvocationResult(METADATA, response, new Map(), {}, graph()),
    {
      OUTPUT: {
        HEAD: { TEXT: "result" },
        ROWS: [{ NUMBER: -4, RAW: Buffer.from([0, 1]) }],
      },
    },
  );
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      METADATA,
      [{ tag: CpicTag.End, value: Buffer.alloc(0) }],
      new Map(),
      { deactivated: new Set(["OUTPUT"]) },
      graph(),
    ),
    { OUTPUT: {} },
  );
});

test("fails closed before wire construction without matching recursive metadata", () => {
  assert.throws(
    () => buildClassicRfcInvocationRequest(METADATA, { INPUT }, new Map()),
    /recursive xRFC metadata/u,
  );
  assert.throws(
    () => requestXrfcData(graph("Z_OTHER")),
    /identity does not match/u,
  );
});

test("deactivated recursive parameters need neither optimized metadata nor a supported nested type", () => {
  assert.doesNotThrow(() => buildClassicRfcInvocationRequest(
    METADATA,
    {},
    new Map(),
    { deactivated: new Set(["INPUT", "OUTPUT"]) },
  ));
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      METADATA,
      [{ tag: CpicTag.End, value: Buffer.alloc(0) }],
      new Map(),
      { deactivated: new Set(["INPUT", "OUTPUT"]) },
    ),
    { OUTPUT: {} },
  );
});

test("uses recursive xRFC for a class-T RFCTYPE_TABLE parameter", () => {
  const tableMetadata: RfcFunctionInterface = Object.freeze({
    ...METADATA,
    parameters: Object.freeze([
      Object.freeze({
        ...METADATA.parameters[0]!,
        parameterClass: "T",
        parameterName: "TABLE",
        tableName: "Z_ROWS",
        exid: "h",
        position: 3,
        internalLength: 12,
      }),
    ]),
  });
  const request = buildClassicRfcInvocationRequest(
    tableMetadata,
    { TABLE: INPUT.ROWS },
    new Map(),
    {},
    graph(FUNCTION_NAME, true),
  );
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(
    Buffer.concat(
      fields
        .filter(({ tag }) => tag === CpicTag.XRfcData)
        .map(({ value }) => Buffer.from(value)),
    ).toString("utf8"),
    "<TABLE><item><NUMBER>3</NUMBER><RAW>yv4=</RAW></item></TABLE>",
  );
});
