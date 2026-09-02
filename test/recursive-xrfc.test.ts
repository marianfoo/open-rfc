import assert from "node:assert/strict";
import test from "node:test";

import type { RfcFunintParameter } from "../src/protocol/classic-rfc.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import {
  buildClassicRfcInvocationRequest,
  decodeClassicRfcInvocationResult,
} from "../src/client/classic-invocation.js";
import {
  CpicTag,
  decodeCpicFieldChainPrefix,
  type CpicField,
} from "../src/protocol/cpic.js";
import type {
  RecursiveMetadataField,
  RecursiveMetadataGraph,
  RecursiveMetadataParameter,
  RecursiveMetadataTypeNode,
} from "../src/metadata/recursive-metadata.js";
import { normalizeRecursiveMetadataGraph } from "../src/metadata/recursive-metadata.js";
import { ClassicBcdConversionError } from "../src/values/classic-bcd.js";
import {
  decodeRecursiveXrfcParameterName,
  decodeRecursiveXrfcParameter,
  encodeRecursiveXrfcParameter,
  escapeRecursiveXrfcTag,
  resolveRecursiveXrfcParameter,
  validateRecursiveXrfcParameter,
} from "../src/values/recursive-xrfc.js";

function scalarField(
  name: string,
  internalType: string,
  options: Partial<RecursiveMetadataField> = {},
): RecursiveMetadataField {
  return Object.freeze({
    name,
    position: options.position ?? 1,
    componentType: options.componentType ?? "E",
    associatedType: options.associatedType ?? "",
    dataType: options.dataType ?? "",
    internalType,
    description: "",
    decimals: options.decimals ?? 0,
    nucOffset: options.nucOffset ?? 0,
    ucOffset: options.ucOffset ?? 0,
    nucLength: options.nucLength ?? 8,
    ucLength: options.ucLength ?? 8,
    reference: Object.freeze({ kind: "scalar", internalType }),
  });
}

function referenceField(
  name: string,
  kind: "structure" | "table",
  targetType: string,
  position = 1,
): RecursiveMetadataField {
  return Object.freeze({
    name,
    position,
    componentType: kind === "table" ? "T" : "S",
    associatedType: targetType,
    dataType: kind === "table" ? "TTYP" : "STRU",
    internalType: kind === "table" ? "h" : "u",
    description: "",
    decimals: 0,
    nucOffset: 0,
    ucOffset: 0,
    nucLength: 8,
    ucLength: 8,
    reference: Object.freeze({ kind, targetType, cyclic: false }),
  });
}

function node(
  name: string,
  kind: RecursiveMetadataTypeNode["kind"],
  fields: readonly RecursiveMetadataField[],
): RecursiveMetadataTypeNode {
  return Object.freeze({
    name,
    kind,
    nucLength: 64,
    ucLength: 64,
    timestamp: "20260716010203",
    fields: Object.freeze([...fields]),
  });
}

function parameter(
  name: string,
  parameterClass: "I" | "E" | "C" | "T",
  tableName: string,
  internalType: string,
): RecursiveMetadataParameter {
  return Object.freeze({
    functionName: "Z_RECURSIVE",
    name,
    parameterClass,
    position: 1,
    associatedType: tableName,
    fieldPath: "",
    internalType,
    internalLength: 64,
    decimals: 0,
    defaultValue: "",
    parameterText: "",
    optional: false,
    reference: Object.freeze({
      kind: internalType === "h" ? "table" : "structure",
      targetType: tableName,
      cyclic: false,
    }),
  });
}

function graph(
  nodes: readonly RecursiveMetadataTypeNode[],
  parameters: readonly RecursiveMetadataParameter[],
): RecursiveMetadataGraph {
  return Object.freeze({
    version: 1,
    functionIdentity: Object.freeze({
      name: "Z_RECURSIVE",
      remoteBasxmlSupported: false,
      generationToken: "function:20260716:010203",
    }),
    nodes: new Map(nodes.map((entry) => [entry.name, entry])),
    parameters: Object.freeze([...parameters]),
    rootTypeNames: Object.freeze(parameters.map((entry) => entry.associatedType)),
    cycles: Object.freeze([]),
    limits: Object.freeze({
      maxRows: 20_000,
      maxNodes: 4_096,
      maxEdges: 20_000,
      maxDepth: 64,
      maxProperties: 400_000,
      maxBytes: 8 * 1024 * 1024,
    }),
    statistics: Object.freeze({
      rowCount: nodes.length,
      nodeCount: nodes.length,
      edgeCount: 4,
      propertyCount: 1,
      byteCount: 1,
      maximumDepth: 4,
    }),
  });
}

const NORMALIZED_TS = "20260716010203";

function normalizedTypeRow(options: {
  readonly typeName: string;
  readonly fieldName: string;
  readonly fieldType: string;
  readonly internalType: string;
  readonly componentType?: string;
  readonly dataType?: string;
  readonly nucTotal?: number;
  readonly ucTotal?: number;
  readonly nucOffset?: number;
  readonly ucOffset?: number;
  readonly nucLength?: number;
  readonly ucLength?: number;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    TYPENAME: options.typeName,
    FIELDNAME: options.fieldName,
    COMPTYPE: options.componentType ?? "E",
    FIELDTYPE: options.fieldType,
    DATATYPE: options.dataType ?? "CHAR",
    TABLENGTH: String(options.nucTotal ?? 8).padStart(6, "0"),
    TABLENGTH_UC: String(options.ucTotal ?? 8).padStart(6, "0"),
    DESCRIPTION: "",
    DECIMALS: "000000",
    INTTYPE: options.internalType,
    OFFSET: String(options.nucOffset ?? 0).padStart(6, "0"),
    OFFSET_UC: String(options.ucOffset ?? 0).padStart(6, "0"),
    INTLEN: String(options.nucLength ?? 8).padStart(6, "0"),
    INTLEN_UC: String(options.ucLength ?? 8).padStart(6, "0"),
    TIMESTAMP: NORMALIZED_TS,
  });
}

function normalizedParameterRow(options: {
  readonly name: string;
  readonly parameterClass?: "I" | "E" | "C" | "T";
  readonly tableName?: string;
  readonly fieldPath?: string;
  readonly internalType: string;
  readonly position?: number;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    FUNCNAME: "Z_RECURSIVE",
    PARAMCLASS: options.parameterClass ?? "I",
    PARAMETER: options.name,
    TABNAME: options.tableName ?? "",
    FIELDNAME: options.fieldPath ?? "",
    EXID: options.internalType,
    POSITION: options.position ?? 1,
    OFFSET: 0,
    INTLENGTH: 8,
    DECIMALS: 0,
    DEFAULT: "",
    PARAMTEXT: "",
    OPTIONAL: "",
  });
}

function normalizedGraph(
  types: readonly Readonly<Record<string, unknown>>[],
  parameters: readonly Readonly<Record<string, unknown>>[],
  indirect: readonly Readonly<Record<string, unknown>>[] = [],
): RecursiveMetadataGraph {
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_RECURSIVE",
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "010203",
    }],
    DATATYPESCONT: [...types],
    INDIRECTTYPES: [...indirect],
    PARAMETERS: [...parameters],
  });
}

function interfaceParameter(
  name: string,
  parameterClass: "I" | "E" | "C" | "T",
  tableName: string,
  exid: string,
): RfcFunintParameter {
  return Object.freeze({
    parameterClass,
    parameterName: name,
    tableName,
    fieldName: "",
    exid,
    position: 1,
    offset: 0,
    internalLength: 64,
    decimals: 0,
    defaultValue: "",
    parameterText: "",
    optional: false,
  });
}

const row = node("Z_ROW", "structure", [
  scalarField("VALUE", "N", { ucLength: 8, nucLength: 4, position: 1 }),
  scalarField("PAYLOAD", "y", { position: 2 }),
]);
const rows = node("Z_ROWS", "table", [
  referenceField("", "structure", "Z_ROW"),
]);
const child = node("Z_CHILD", "structure", [
  scalarField("COUNT", "I", { ucLength: 4, nucLength: 4 }),
]);
const root = node("Z_ROOT", "structure", [
  scalarField("TEXT", "C", { ucLength: 12, nucLength: 6, position: 1 }),
  Object.freeze({ ...referenceField("CHILD", "structure", "Z_CHILD", 2), ucOffset: 12 }),
  Object.freeze({ ...referenceField("ROWS", "table", "Z_ROWS", 3), ucOffset: 20 }),
  scalarField("BLOB", "y", { ucOffset: 28, position: 4 }),
]);
const ROOT_PARAMETER = interfaceParameter("ROOT", "I", "Z_ROOT", "u");
const ROOT_GRAPH = graph(
  [root, child, rows, row],
  [parameter("ROOT", "I", "Z_ROOT", "u")],
);

test("encodes and decodes nested structures, tables, and XSTRING exactly", () => {
  const value = {
    TEXT: "A<&",
    CHILD: { COUNT: 42 },
    ROWS: [
      { VALUE: "0001", PAYLOAD: Buffer.from("00a5ff", "hex") },
      { VALUE: "0002", PAYLOAD: Buffer.alloc(0) },
    ],
    BLOB: Buffer.from("deadbeef", "hex"),
  };
  const encoded = encodeRecursiveXrfcParameter(
    ROOT_PARAMETER,
    ROOT_GRAPH,
    value,
  );
  assert.equal(
    encoded.toString("utf8"),
    "<ROOT><TEXT>A&#60;&#38;</TEXT><CHILD><COUNT>42</COUNT></CHILD>" +
      "<ROWS><item><VALUE>0001</VALUE><PAYLOAD>AKX/</PAYLOAD></item>" +
      "<item><VALUE>0002</VALUE><PAYLOAD></PAYLOAD></item></ROWS>" +
      "<BLOB>3q2+7w==</BLOB></ROOT>",
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, encoded),
    value,
  );
});

test("decodes MIME-wrapped recursive XSTRING cells", () => {
  const payload = Buffer.alloc(256);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 17) & 0xff;
  }
  const canonical = payload.toString("base64");
  const wrapped = canonical.match(/.{1,76}/gu)!.join("\n");
  const xml = Buffer.from(
    "<ROOT><TEXT></TEXT><CHILD><COUNT>0</COUNT></CHILD>" +
      "<ROWS></ROWS><BLOB>" + wrapped + "</BLOB></ROOT>",
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, xml),
    { TEXT: "", CHILD: { COUNT: 0 }, ROWS: [], BLOB: payload },
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      Buffer.from(xml.toString().replaceAll("\n", " ")),
    ),
    /non-canonical base64/u,
  );
});

test("integrates recursive graph values into the classic invocation envelope", () => {
  const outputParameter = interfaceParameter("OUT", "E", "Z_ROOT", "u");
  const metadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([ROOT_PARAMETER, outputParameter]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const metadataGraph = graph(
    [root, child, rows, row],
    [
      parameter("ROOT", "I", "Z_ROOT", "u"),
      parameter("OUT", "E", "Z_ROOT", "u"),
    ],
  );
  const requestValue = {
    TEXT: "input",
    CHILD: { COUNT: 1 },
    ROWS: [],
    BLOB: Buffer.alloc(0),
  };
  const request = buildClassicRfcInvocationRequest(
    metadata,
    { ROOT: requestValue },
    new Map(),
    {},
    metadataGraph,
  );
  const requestFields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(
    requestFields.find((field) => field.tag === CpicTag.XRfcData)?.value.toString(),
    "<ROOT><TEXT>input</TEXT><CHILD><COUNT>1</COUNT></CHILD>" +
      "<ROWS></ROWS><BLOB></BLOB></ROOT>",
  );

  const responseValue = {
    TEXT: "output",
    CHILD: { COUNT: 2 },
    ROWS: [{ VALUE: "0002", PAYLOAD: Buffer.from("aa", "hex") }],
    BLOB: Buffer.from("bb", "hex"),
  };
  const responseXml = encodeRecursiveXrfcParameter(
    outputParameter,
    metadataGraph,
    responseValue,
  );
  const responseFields: readonly CpicField[] = Object.freeze([
    Object.freeze({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) }),
    Object.freeze({ tag: CpicTag.XRfcData, value: responseXml }),
    Object.freeze({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) }),
    Object.freeze({ tag: CpicTag.End, value: Buffer.alloc(0) }),
  ]);
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      metadata,
      responseFields,
      new Map(),
      {},
      metadataGraph,
    ),
    { OUT: responseValue },
  );
});

test("routes fixed-only nested u structures through recursive xRFC", () => {
  const inputParameter = interfaceParameter(
    "INPUT",
    "I",
    "Z_FIXED_ROOT",
    "u",
  );
  const outputParameter = interfaceParameter(
    "OUTPUT",
    "E",
    "Z_FIXED_ROOT",
    "u",
  );
  const metadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([inputParameter, outputParameter]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const metadataGraph = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_FIXED_ROOT",
      fieldName: "CHILD",
      fieldType: "Z_FIXED_CHILD",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      nucLength: 4,
      ucLength: 4,
    }),
    normalizedTypeRow({
      typeName: "Z_FIXED_CHILD",
      fieldName: "COUNT",
      fieldType: "INT4",
      internalType: "I",
      dataType: "INT4",
      nucLength: 4,
      ucLength: 4,
    }),
  ], [
    normalizedParameterRow({
      name: "INPUT",
      tableName: "Z_FIXED_ROOT",
      internalType: "u",
    }),
    normalizedParameterRow({
      name: "OUTPUT",
      parameterClass: "E",
      tableName: "Z_FIXED_ROOT",
      internalType: "u",
      position: 2,
    }),
  ]);
  const request = buildClassicRfcInvocationRequest(
    metadata,
    { INPUT: { CHILD: { COUNT: 7 } } },
    new Map(),
    {},
    metadataGraph,
  );
  const requestFields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(
    requestFields.find((field) => field.tag === CpicTag.XRfcData)?.value.toString(),
    "<INPUT><CHILD><COUNT>7</COUNT></CHILD></INPUT>",
  );

  const responseFields: readonly CpicField[] = Object.freeze([
    Object.freeze({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) }),
    Object.freeze({
      tag: CpicTag.XRfcData,
      value: Buffer.from(
        "<OUTPUT><CHILD><COUNT>-4</COUNT></CHILD></OUTPUT>",
      ),
    }),
    Object.freeze({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) }),
    Object.freeze({ tag: CpicTag.End, value: Buffer.alloc(0) }),
  ]);
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      metadata,
      responseFields,
      new Map(),
      {},
      metadataGraph,
    ),
    { OUTPUT: { CHILD: { COUNT: -4 } } },
  );
});

test("keeps the strict recursive serializer authoritative for eligible u graphs", () => {
  const inputParameter = interfaceParameter(
    "INPUT",
    "I",
    "Z_STRING_ROOT",
    "u",
  );
  const metadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([inputParameter]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const metadataGraph = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_STRING_ROOT",
      fieldName: "TEXT",
      fieldType: "STRING",
      internalType: "g",
      dataType: "STRG",
    }),
  ], [
    normalizedParameterRow({
      name: "INPUT",
      tableName: "Z_STRING_ROOT",
      internalType: "u",
    }),
  ]);

  assert.throws(
    () => buildClassicRfcInvocationRequest(
      metadata,
      { INPUT: { TEXT: "before\0after" } },
      new Map(),
      {},
      metadataGraph,
    ),
    /INPUT\.TEXT contains NUL/u,
  );
});

test("fills omitted nested values with their ABAP initial forms", () => {
  const encoded = encodeRecursiveXrfcParameter(
    ROOT_PARAMETER,
    ROOT_GRAPH,
    {},
  );
  assert.equal(
    encoded.toString("utf8"),
    "<ROOT><TEXT></TEXT><CHILD><COUNT>0</COUNT></CHILD>" +
      "<ROWS></ROWS><BLOB></BLOB></ROOT>",
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, encoded),
    { TEXT: "", CHILD: { COUNT: 0 }, ROWS: [], BLOB: Buffer.alloc(0) },
  );
});

test("supports anonymous scalar table rows and namespace tag escaping", () => {
  const input = interfaceParameter("/NS/TEXTS", "I", "Z_TEXTS", "h");
  const metadata = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_TEXTS",
      fieldName: "",
      fieldType: "STRING",
      internalType: "g",
      dataType: "STRG",
    }),
  ], [normalizedParameterRow({
    name: "/NS/TEXTS",
    tableName: "Z_TEXTS",
    internalType: "h",
  })]);
  assert.equal(metadata.nodes.get("Z_TEXTS")?.kind, "table");
  const encoded = encodeRecursiveXrfcParameter(input, metadata, ["ONE", "TWO"]);
  assert.equal(escapeRecursiveXrfcTag("/NS/TEXTS"), "_-NS_-TEXTS");
  assert.equal(
    encoded.toString(),
    "<_-NS_-TEXTS><item>ONE</item><item>TWO</item></_-NS_-TEXTS>",
  );
  assert.equal(decodeRecursiveXrfcParameterName(encoded), "/NS/TEXTS");
  assert.deepEqual(
    decodeRecursiveXrfcParameter(input, metadata, encoded),
    ["ONE", "TWO"],
  );
});

test("normalizes deep v, direct field-path, and indirect parameter targets", () => {
  const metadata = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_OWNER",
      fieldName: "DEEP",
      fieldType: "Z_DEEP",
      internalType: "v",
      componentType: "S",
      dataType: "STRU",
    }),
    normalizedTypeRow({
      typeName: "Z_DEEP",
      fieldName: "TEXT",
      fieldType: "STRING",
      internalType: "g",
      dataType: "STRG",
    }),
  ], [
    normalizedParameterRow({
      name: "DEEP",
      tableName: "Z_DEEP",
      internalType: "v",
      position: 1,
    }),
    normalizedParameterRow({
      name: "DIRECT",
      tableName: "Z_OWNER",
      fieldPath: "DEEP",
      internalType: "v",
      position: 2,
    }),
    normalizedParameterRow({
      name: "INDIRECT",
      tableName: "Z_EXTERNAL",
      fieldPath: "WRAPPER-DEEP",
      internalType: "v",
      position: 3,
    }),
    normalizedParameterRow({
      name: "OWNER",
      tableName: "Z_OWNER",
      internalType: "v",
      position: 4,
    }),
  ], [{
    TABNAME: "Z_EXTERNAL",
    FIELDNAME: "WRAPPER-DEEP",
    FIELDTYPE: "Z_DEEP",
  }]);

  for (const [name, tableName] of [
    ["DEEP", "Z_DEEP"],
    ["DIRECT", "Z_OWNER"],
    ["INDIRECT", "Z_EXTERNAL"],
  ] as const) {
    const input = interfaceParameter(name, "I", tableName, "v");
    assert.equal(resolveRecursiveXrfcParameter(metadata, input)?.node.name, "Z_DEEP");
    const encoded = encodeRecursiveXrfcParameter(input, metadata, { TEXT: name });
    assert.equal(
      encoded.toString(),
      `<${name}><TEXT>${name}</TEXT></${name}>`,
    );
    assert.deepEqual(
      decodeRecursiveXrfcParameter(input, metadata, encoded),
      { TEXT: name },
    );
  }
});

test("routes fixed-only deep v scalars through the broad recursive codec", () => {
  const input = interfaceParameter("DEEP_FLOAT", "I", "Z_DEEP_FLOAT", "v");
  const metadata = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_DEEP_FLOAT",
      fieldName: "VALUE",
      fieldType: "FLTP",
      internalType: "F",
      dataType: "FLTP",
      nucLength: 8,
      ucLength: 8,
    }),
  ], [normalizedParameterRow({
    name: "DEEP_FLOAT",
    tableName: "Z_DEEP_FLOAT",
    internalType: "v",
  })]);
  assert.equal(resolveRecursiveXrfcParameter(metadata, input)?.node.name, "Z_DEEP_FLOAT");
  const encoded = encodeRecursiveXrfcParameter(
    input,
    metadata,
    { VALUE: 1.25 },
  );
  assert.equal(
    encoded.toString(),
    "<DEEP_FLOAT><VALUE>1.25</VALUE></DEEP_FLOAT>",
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(input, metadata, encoded),
    { VALUE: 1.25 },
  );

  const functionMetadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([input]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const request = buildClassicRfcInvocationRequest(
    functionMetadata,
    { DEEP_FLOAT: { VALUE: 1.25 } },
    new Map(),
    {},
    metadata,
  );
  const requestFields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(
    requestFields.find((field) => field.tag === CpicTag.XRfcData)?.value.toString(),
    encoded.toString(),
  );
});

test("keeps structured classic TABLES rows binary even when a graph is present", () => {
  const metadata = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_FLAT_ROW",
      fieldName: "COUNT",
      fieldType: "INT4",
      internalType: "I",
      dataType: "INT4",
      nucTotal: 4,
      ucTotal: 4,
      nucLength: 4,
      ucLength: 4,
    }),
    normalizedTypeRow({
      typeName: "Z_DEEP_ROW",
      fieldName: "TEXT",
      fieldType: "STRING",
      internalType: "g",
      dataType: "STRG",
    }),
  ], [
    normalizedParameterRow({
      name: "FLAT_ROWS",
      parameterClass: "T",
      tableName: "Z_FLAT_ROW",
      internalType: "u",
      position: 1,
    }),
    normalizedParameterRow({
      name: "DEEP_ROWS",
      parameterClass: "T",
      tableName: "Z_DEEP_ROW",
      internalType: "u",
      position: 2,
    }),
  ]);
  const flat = interfaceParameter("FLAT_ROWS", "T", "Z_FLAT_ROW", "u");
  const deep = interfaceParameter("DEEP_ROWS", "T", "Z_DEEP_ROW", "u");
  assert.equal(resolveRecursiveXrfcParameter(metadata, flat), undefined);
  assert.equal(resolveRecursiveXrfcParameter(metadata, deep), undefined);
  const flatFunction: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([flat]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const flatRequest = buildClassicRfcInvocationRequest(
    flatFunction,
    { FLAT_ROWS: [{ COUNT: 7 }] },
    new Map([["Z_FLAT_ROW", Object.freeze({
      name: "Z_FLAT_ROW",
      byteLength: 4,
      fields: Object.freeze([Object.freeze({
        tableName: "Z_FLAT_ROW",
        fieldName: "COUNT",
        position: 1,
        offset: 0,
        internalLength: 4,
        decimals: 0,
        exid: "I",
      })]),
    })]]),
    {},
    metadata,
  );
  const flatFields = decodeCpicFieldChainPrefix(
    flatRequest.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(flatFields.some((field) => field.tag === CpicTag.XRfcData), false);
  assert.throws(
    () => encodeRecursiveXrfcParameter(deep, metadata, [{ TEXT: "one" }]),
    /does not require recursive xRFC/u,
  );
});

test("normalizes STRING and XSTRING scalar h-table lines for xRFC", () => {
  const metadata = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_TEXTS",
      fieldName: "",
      fieldType: "STRING",
      internalType: "g",
      dataType: "STRG",
    }),
    normalizedTypeRow({
      typeName: "Z_BYTES",
      fieldName: "",
      fieldType: "XSTRING",
      internalType: "y",
      dataType: "RSTR",
    }),
  ], [
    normalizedParameterRow({
      name: "TEXTS",
      parameterClass: "C",
      tableName: "Z_TEXTS",
      internalType: "h",
      position: 1,
    }),
    normalizedParameterRow({
      name: "BYTES",
      parameterClass: "C",
      tableName: "Z_BYTES",
      internalType: "h",
      position: 2,
    }),
  ]);
  const texts = interfaceParameter("TEXTS", "C", "Z_TEXTS", "h");
  const bytes = interfaceParameter("BYTES", "C", "Z_BYTES", "h");
  const textXml = encodeRecursiveXrfcParameter(texts, metadata, ["one", "two"]);
  const bytesXml = encodeRecursiveXrfcParameter(
    bytes,
    metadata,
    [Buffer.from("00ff", "hex")],
  );
  assert.equal(textXml.toString(), "<TEXTS><item>one</item><item>two</item></TEXTS>");
  assert.equal(bytesXml.toString(), "<BYTES><item>AP8=</item></BYTES>");
  assert.deepEqual(
    decodeRecursiveXrfcParameter(texts, metadata, textXml),
    ["one", "two"],
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(bytes, metadata, bytesXml),
    [Buffer.from("00ff", "hex")],
  );

  const functionMetadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([texts, bytes]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const request = buildClassicRfcInvocationRequest(
    functionMetadata,
    { TEXTS: ["one"], BYTES: [Buffer.from("ff", "hex")] },
    new Map(),
    {},
    metadata,
  );
  const requestFields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.deepEqual(
    requestFields
      .filter((field) => field.tag === CpicTag.XRfcData)
      .map((field) => field.value.toString()),
    ["<TEXTS><item>one</item></TEXTS>", "<BYTES><item>/w==</item></BYTES>"],
  );
  const envelope = (xml: string): readonly CpicField[] => Object.freeze([
    Object.freeze({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) }),
    Object.freeze({ tag: CpicTag.XRfcData, value: Buffer.from(xml) }),
    Object.freeze({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) }),
  ]);
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      functionMetadata,
      [
        ...envelope("<TEXTS><item>out</item></TEXTS>"),
        ...envelope("<BYTES><item>AA==</item></BYTES>"),
        Object.freeze({ tag: CpicTag.End, value: Buffer.alloc(0) }),
      ],
      new Map(),
      {},
      metadata,
    ),
    { TEXTS: ["out"], BYTES: [Buffer.of(0)] },
  );
});

test("projects BCD values through recursive xRFC structures and tables", () => {
  const packed = scalarField("PACKED", "P", {
    decimals: 2,
    nucLength: 4,
    ucLength: 4,
  });
  const d16 = scalarField("D16", "a", {
    nucLength: 8,
    ucLength: 8,
    position: 2,
  });
  const d34 = scalarField("D34", "e", {
    nucLength: 16,
    ucLength: 16,
    position: 3,
  });
  const row = node("Z_DECIMAL_ROW", "table", [packed, d16, d34]);
  const root = node("Z_DECIMAL_ROOT", "structure", [
    packed,
    referenceField("ROWS", "table", row.name, 2),
  ]);
  const recursive = parameter("RESULT", "E", root.name, "v");
  const metadata = graph([root, row], [recursive]);
  const descriptor = interfaceParameter("RESULT", "E", root.name, "v");
  const encoded = encodeRecursiveXrfcParameter(descriptor, metadata, {
    PACKED: "12.34",
    ROWS: [{ PACKED: "56.78", D16: "-9.5", D34: "10.125" }],
  });

  assert.deepEqual(
    decodeRecursiveXrfcParameter(descriptor, metadata, encoded, { bcd: "number" }),
    {
      PACKED: 12.34,
      ROWS: [{ PACKED: 56.78, D16: -9.5, D34: 10.125 }],
    },
  );
  const functionMetadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([descriptor]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  assert.deepEqual(
    decodeClassicRfcInvocationResult(
      functionMetadata,
      [
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.XRfcData, value: encoded },
        { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      new Map(),
      { bcd: "number" },
      metadata,
    ),
    {
      RESULT: {
        PACKED: 12.34,
        ROWS: [{ PACKED: 56.78, D16: -9.5, D34: 10.125 }],
      },
    },
  );

  const calls: string[] = [];
  assert.deepEqual(
    decodeRecursiveXrfcParameter(descriptor, metadata, encoded, {
      bcd(value) {
        calls.push(value);
        return { decimal: value };
      },
    }),
    {
      PACKED: { decimal: "12.34" },
      ROWS: [
        {
          PACKED: { decimal: "56.78" },
          D16: { decimal: "-9.5" },
          D34: { decimal: "10.125" },
        },
      ],
    },
  );
  assert.deepEqual(calls, ["12.34", "56.78", "-9.5", "10.125"]);

  const original = new Error("converter failed");
  assert.throws(
    () => decodeRecursiveXrfcParameter(descriptor, metadata, encoded, {
      bcd() {
        throw original;
      },
    }),
    (error: unknown) =>
      error instanceof ClassicBcdConversionError && error.cause === original,
  );
});

test("preserves negative zero in FLOAT scalar tables and validates wrappers", () => {
  const metadata = normalizedGraph([
    normalizedTypeRow({
      typeName: "Z_FLOATS",
      fieldName: "",
      fieldType: "FLTP",
      internalType: "F",
      dataType: "FLTP",
      nucLength: 8,
      ucLength: 8,
    }),
  ], [
    normalizedParameterRow({
      name: "FLOATS",
      parameterClass: "C",
      tableName: "Z_FLOATS",
      internalType: "h",
    }),
    normalizedParameterRow({
      name: "FLOAT_TABLES",
      parameterClass: "T",
      tableName: "Z_FLOATS",
      internalType: "h",
      position: 2,
    }),
  ]);
  const floats = interfaceParameter("FLOATS", "C", "Z_FLOATS", "h");
  const encoded = encodeRecursiveXrfcParameter(
    floats,
    metadata,
    [-0, { "": 1.5 }],
  );
  assert.equal(
    encoded.toString(),
    "<FLOATS><item>-0</item><item>1.5</item></FLOATS>",
  );
  const decoded = decodeRecursiveXrfcParameter(floats, metadata, encoded) as number[];
  assert.equal(Object.is(decoded[0], -0), true);
  assert.equal(decoded[1], 1.5);

  assert.throws(
    () => encodeRecursiveXrfcParameter(
      floats,
      metadata,
      [{ "": 1, EXTRA: 2 }],
    ),
    /must contain only the empty-name field/u,
  );
  let getterCalled = false;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "", {
    enumerable: true,
    get() {
      getterCalled = true;
      return 1;
    },
  });
  assert.throws(
    () => encodeRecursiveXrfcParameter(floats, metadata, [accessor]),
    /own data property/u,
  );
  assert.equal(getterCalled, false);
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      floats,
      metadata,
      [new Proxy({ "": 1 }, {})],
    ),
    /must not be a proxy/u,
  );

  const tableParameter = interfaceParameter(
    "FLOAT_TABLES",
    "T",
    "Z_FLOATS",
    "h",
  );
  assert.equal(
    resolveRecursiveXrfcParameter(metadata, tableParameter)?.node.name,
    "Z_FLOATS",
  );
  const functionMetadata: RfcFunctionInterface = Object.freeze({
    name: "Z_RECURSIVE",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([tableParameter]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const request = buildClassicRfcInvocationRequest(
    functionMetadata,
    { FLOAT_TABLES: [-0] },
    new Map(),
    {},
    metadata,
  );
  const requestFields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(
    requestFields.find((field) => field.tag === CpicTag.XRfcData)?.value.toString(),
    "<FLOAT_TABLES><item>-0</item></FLOAT_TABLES>",
  );
});

test("round-trips every recursive scalar wire form with xRFC DATE/TIME lexical values", () => {
  const scalarRoot = node("Z_SCALARS", "structure", [
    scalarField("CHAR", "C", { position: 1, ucLength: 8, nucLength: 4 }),
    scalarField("NUM", "N", { position: 2, ucLength: 8, nucLength: 4 }),
    scalarField("DATE", "D", { position: 3, ucLength: 16, nucLength: 8 }),
    scalarField("TIME", "T", { position: 4, ucLength: 12, nucLength: 6 }),
    scalarField("BYTE", "X", { position: 5, ucLength: 2, nucLength: 2 }),
    scalarField("BCD", "P", { position: 6, ucLength: 3, nucLength: 3, decimals: 2 }),
    scalarField("FLOAT", "F", { position: 7, ucLength: 8, nucLength: 8 }),
    scalarField("INT4", "I", { position: 8, ucLength: 4, nucLength: 4 }),
    scalarField("INT1", "b", { position: 9, ucLength: 1, nucLength: 1 }),
    scalarField("INT2", "s", { position: 10, ucLength: 2, nucLength: 2 }),
    scalarField("INT8", "8", { position: 11, ucLength: 8, nucLength: 8 }),
    scalarField("DECF16", "a", { position: 12, ucLength: 8, nucLength: 8 }),
    scalarField("DECF34", "e", { position: 13, ucLength: 16, nucLength: 16 }),
    scalarField("UTCLONG", "p", { position: 14, ucLength: 8, nucLength: 8 }),
    scalarField("UTCSECOND", "n", { position: 15, ucLength: 8, nucLength: 8 }),
    scalarField("UTCMINUTE", "w", { position: 16, ucLength: 8, nucLength: 8 }),
    scalarField("DTDAY", "d", { position: 17, ucLength: 4, nucLength: 4 }),
    scalarField("DTWEEK", "7", { position: 18, ucLength: 4, nucLength: 4 }),
    scalarField("DTMONTH", "x", { position: 19, ucLength: 4, nucLength: 4 }),
    scalarField("TSECOND", "t", { position: 20, ucLength: 4, nucLength: 4 }),
    scalarField("TMINUTE", "i", { position: 21, ucLength: 2, nucLength: 2 }),
    scalarField("CDAY", "c", { position: 22, ucLength: 2, nucLength: 2 }),
    scalarField("STRING", "g", { position: 23, ucLength: 8, nucLength: 8 }),
    scalarField("XSTRING", "y", { position: 24, ucLength: 8, nucLength: 8 }),
  ]);
  const input = interfaceParameter("SCALARS", "I", "Z_SCALARS", "u");
  const metadata = graph(
    [scalarRoot],
    [parameter("SCALARS", "I", "Z_SCALARS", "u")],
  );
  const value = {
    CHAR: "AB",
    NUM: "12",
    DATE: "20260716",
    TIME: "154530",
    BYTE: Buffer.from("aa55", "hex"),
    BCD: "12.34",
    FLOAT: 1.5,
    INT4: -2_000_000_000,
    INT1: 255,
    INT2: -32_000,
    INT8: -9_007_199_254_740_993n,
    DECF16: "1.25",
    DECF34: "-123456789012345678901234567890.1234",
    UTCLONG: "2002-02-04T20:15:01.1234567",
    UTCSECOND: "2002-02-04T20:15:01",
    UTCMINUTE: "2002-02-04T20:15",
    DTDAY: "2002-02-04",
    DTWEEK: "2020-W53",
    DTMONTH: "2002-02",
    TSECOND: "20:15:01",
    TMINUTE: "20:15",
    CDAY: "02-04",
    STRING: "Grüße 🌍",
    XSTRING: Buffer.from("deadbeef", "hex"),
  };
  const encoded = encodeRecursiveXrfcParameter(input, metadata, value);
  const xml = encoded.toString("utf8");
  assert.match(xml, /<NUM>0012<\/NUM>/u);
  assert.match(xml, /<DATE>2026-07-16<\/DATE>/u);
  assert.match(xml, /<TIME>15:45:30<\/TIME>/u);
  assert.deepEqual(
    decodeRecursiveXrfcParameter(input, metadata, encoded),
    { ...value, NUM: "0012" },
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(
      input,
      metadata,
      Buffer.from(xml.replace("<FLOAT>1.5</FLOAT>", "<FLOAT>1.500000E+000</FLOAT>")),
    ),
    { ...value, NUM: "0012" },
  );
});

test("canonicalizes blank xRFC DATE/TIME inputs to empty elements", () => {
  const root = node("Z_BLANK_TEMPORAL", "structure", [
    scalarField("DATE", "D", { position: 1, ucLength: 16, nucLength: 8 }),
    scalarField("TIME", "T", { position: 2, ucLength: 12, nucLength: 6 }),
  ]);
  const descriptor = interfaceParameter(
    "TEMPORAL",
    "I",
    root.name,
    "v",
  );
  const metadata = graph(
    [root],
    [parameter("TEMPORAL", "I", root.name, "v")],
  );
  for (const value of [
    { DATE: "", TIME: "" },
    { DATE: "        ", TIME: "      " },
  ]) {
    const encoded = encodeRecursiveXrfcParameter(
      descriptor,
      metadata,
      value,
    );
    assert.equal(
      encoded.toString(),
      "<TEMPORAL><DATE></DATE><TIME></TIME></TEMPORAL>",
    );
    assert.deepEqual(
      decodeRecursiveXrfcParameter(descriptor, metadata, encoded),
      { DATE: "", TIME: "" },
    );
  }
});

test("pads short fixed BYTE values and rejects only oversized values", () => {
  const bytesRoot = node("Z_BYTES", "structure", [
    scalarField("BYTE", "X", { ucLength: 2, nucLength: 2 }),
    scalarField("MARKER", "g", { position: 2 }),
  ]);
  const input = interfaceParameter("BYTES", "I", "Z_BYTES", "v");
  const metadata = graph(
    [bytesRoot],
    [parameter("BYTES", "I", "Z_BYTES", "v")],
  );
  const encoded = encodeRecursiveXrfcParameter(
    input,
    metadata,
    { BYTE: Buffer.from("aa", "hex") },
  );
  assert.equal(
    encoded.toString(),
    "<BYTES><BYTE>qgA=</BYTE><MARKER></MARKER></BYTES>",
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(
      input,
      metadata,
      Buffer.from("<BYTES><BYTE>qg==</BYTE><MARKER></MARKER></BYTES>"),
    ),
    { BYTE: Buffer.from("aa00", "hex"), MARKER: "" },
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      input,
      metadata,
      { BYTE: Buffer.from("aabbcc", "hex") },
    ),
    /at most 2 bytes/u,
  );
});

test("uses canonical xRFC entities for XML punctuation and control characters", () => {
  const textRoot = node("Z_TEXT", "structure", [
    scalarField("TEXT", "g"),
  ]);
  const input = interfaceParameter("VALUE", "I", "Z_TEXT", "v");
  const metadata = graph(
    [textRoot],
    [parameter("VALUE", "I", "Z_TEXT", "v")],
  );
  const text = "\u0000\u0001\t\n\r<&>";
  const encoded = encodeRecursiveXrfcParameter(input, metadata, { TEXT: text });
  assert.equal(
    encoded.toString(),
    "<VALUE><TEXT>&#00;&#01;\t\n\r&#60;&#38;&#62;</TEXT></VALUE>",
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(input, metadata, encoded),
    { TEXT: text },
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(
      input,
      metadata,
      Buffer.from("<VALUE><TEXT>&#34;quoted&#39;</TEXT></VALUE>"),
    ),
    { TEXT: '"quoted\'' },
  );
  for (const invalid of [
    "<VALUE><TEXT>\u0001</TEXT></VALUE>",
  ]) {
    assert.throws(
      () => decodeRecursiveXrfcParameter(input, metadata, Buffer.from(invalid)),
      /non-canonical|unsupported|expected/u,
    );
  }
});

test("admits the whole XML entity grammar a conforming peer may send", () => {
  const textRoot = node("Z_TEXT", "structure", [
    scalarField("TEXT", "g"),
  ]);
  const input = interfaceParameter("VALUE", "I", "Z_TEXT", "v");
  const metadata = graph(
    [textRoot],
    [parameter("VALUE", "I", "Z_TEXT", "v")],
  );
  const decode = (raw: string): unknown =>
    decodeRecursiveXrfcParameter(
      input,
      metadata,
      Buffer.from(`<VALUE><TEXT>${raw}</TEXT></VALUE>`),
    );

  for (const [entity, expected] of [
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&apos;", "'"],
  ] as const) {
    assert.deepEqual(decode(entity), { TEXT: expected }, entity);
  }

  // Every legal spelling of a reference decodes to the same scalar, across the
  // whole range and at each width boundary. 0xFFFE/0xFFFF are absent because
  // they are non-characters this codec refuses in either position.
  for (const codePoint of [
    0, 1, 0x1f, 0x20, 0x41, 0x7f, 0x80, 0xff, 0x100,
    0xd7ff, 0xe000, 0xfffd, 0x10000, 0x1f600, 0x10ffff,
  ]) {
    const expected = { TEXT: String.fromCodePoint(codePoint) };
    for (const entity of [
      `&#${codePoint};`,
      `&#${String(codePoint).padStart(7, "0")};`,
      `&#x${codePoint.toString(16)};`,
      `&#x${codePoint.toString(16).toUpperCase().padStart(6, "0")};`,
    ]) {
      assert.deepEqual(decode(entity), expected, entity);
    }
  }

  // XML forbids ">" in character data only as the "]]>" sequence.
  assert.deepEqual(decode("a>b"), { TEXT: "a>b" });

  // The writer's canonical output still reads back unchanged.
  const canonical = " \t\n\r<&>ä€\u{1f600}";
  assert.deepEqual(
    decodeRecursiveXrfcParameter(
      input,
      metadata,
      encodeRecursiveXrfcParameter(input, metadata, { TEXT: canonical }),
    ),
    { TEXT: canonical },
  );

  for (const invalid of [
    "&#xD800;", "&#55296;", "&#xDFFF;", "&#57343;",
    "&#x110000;", "&#1114112;",
    "&#xFFFE;", "&#65535;",
    "&#38", "&amp",
    "&nbsp;", "&AMP;",
    "&;", "&#;", "&#x;",
    "&#X41;",
    // A zero-padded reference is a spelling, not a different reference. Only a
    // run past the raw bound is refused.
    `&#${"0".repeat(4096)}38;`,
    "a]]>b",
  ]) {
    assert.throws(() => decode(invalid), /entity|non-canonical/u, invalid);
  }
});

test("counts recursive depth by containers, not scalar leaves or table rows", () => {
  const shallowRoot = node("Z_SHALLOW", "structure", [scalarField("TEXT", "g")]);
  const shallowInput = interfaceParameter("SHALLOW", "I", "Z_SHALLOW", "v");
  const shallowGraph = graph(
    [shallowRoot],
    [parameter("SHALLOW", "I", "Z_SHALLOW", "v")],
  );
  const shallowXml = encodeRecursiveXrfcParameter(
    shallowInput,
    shallowGraph,
    { TEXT: "ok" },
    { maxDepth: 1 },
  );
  assert.deepEqual(
    decodeRecursiveXrfcParameter(
      shallowInput,
      shallowGraph,
      shallowXml,
      { maxDepth: 1 },
    ),
    { TEXT: "ok" },
  );

  const nestedChild = node("Z_NESTED_CHILD", "structure", [scalarField("TEXT", "g")]);
  const nestedRoot = node("Z_NESTED_ROOT", "structure", [
    referenceField("CHILD", "structure", "Z_NESTED_CHILD"),
  ]);
  const nestedInput = interfaceParameter("NESTED", "I", "Z_NESTED_ROOT", "v");
  const nestedGraph = graph(
    [nestedRoot, nestedChild],
    [parameter("NESTED", "I", "Z_NESTED_ROOT", "v")],
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      nestedInput,
      nestedGraph,
      { CHILD: { TEXT: "too deep" } },
      { maxDepth: 1 },
    ),
    /depth 1/u,
  );
  const nestedXml = encodeRecursiveXrfcParameter(
    nestedInput,
    nestedGraph,
    { CHILD: { TEXT: "ok" } },
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      nestedInput,
      nestedGraph,
      nestedXml,
      { maxDepth: 1 },
    ),
    /depth 1/u,
  );
});

test("checks shared DAG nodes at every reachable container depth", () => {
  const leaf = node("Z_DAG_C", "structure", [scalarField("TEXT", "g")]);
  const shared = node("Z_DAG_B", "structure", [
    referenceField("C", "structure", "Z_DAG_C"),
  ]);
  const longer = node("Z_DAG_A", "structure", [
    referenceField("B", "structure", "Z_DAG_B"),
  ]);
  // B is intentionally visited through the shallow edge before the deeper
  // ROOT.A.B edge. A cache keyed only by type name misses the depth violation.
  const dagRoot = node("Z_DAG_ROOT", "structure", [
    referenceField("B", "structure", "Z_DAG_B", 1),
    referenceField("A", "structure", "Z_DAG_A", 2),
  ]);
  const input = interfaceParameter("DAG", "I", "Z_DAG_ROOT", "v");
  const metadata = graph(
    [dagRoot, longer, shared, leaf],
    [parameter("DAG", "I", "Z_DAG_ROOT", "v")],
  );
  assert.throws(
    () => validateRecursiveXrfcParameter(metadata, input, { maxDepth: 3 }),
    /DAG\.A\.B exceeds recursive xRFC depth 3/u,
  );
});

test("rejects graph map aliases before subtree validation can be reused", () => {
  const aliasLeft = node("Z_ALIAS", "structure", [scalarField("TEXT", "g")]);
  const aliasRight = node("Z_ALIAS", "structure", [scalarField("COUNT", "I")]);
  const aliasRoot = node("Z_ALIAS_ROOT", "structure", [
    referenceField("LEFT", "structure", "Z_LEFT", 1),
    referenceField("RIGHT", "structure", "Z_RIGHT", 2),
  ]);
  const input = interfaceParameter("ALIASES", "I", "Z_ALIAS_ROOT", "v");
  const base = graph(
    [aliasRoot],
    [parameter("ALIASES", "I", "Z_ALIAS_ROOT", "v")],
  );
  const metadata: RecursiveMetadataGraph = Object.freeze({
    ...base,
    nodes: new Map([
      [aliasRoot.name, aliasRoot],
      ["Z_LEFT", aliasLeft],
      ["Z_RIGHT", aliasRight],
    ]),
  });
  assert.throws(
    () => validateRecursiveXrfcParameter(metadata, input),
    /node identity Z_ALIAS disagrees with map key Z_LEFT/u,
  );
});

test("rejects aliased h/T root nodes in the table resolver branch", () => {
  const expected = node("Z_EXPECTED", "table", [scalarField("", "F")]);
  const alias = Object.freeze({ ...expected, name: "Z_FOREIGN" });
  const input = interfaceParameter("ALIASED_TABLE", "T", "Z_EXPECTED", "h");
  const base = graph(
    [expected],
    [parameter("ALIASED_TABLE", "T", "Z_EXPECTED", "h")],
  );
  const metadata: RecursiveMetadataGraph = Object.freeze({
    ...base,
    nodes: new Map([["Z_EXPECTED", alias]]),
  });
  assert.throws(
    () => resolveRecursiveXrfcParameter(metadata, input),
    /requires recursive table row node Z_EXPECTED/u,
  );
});

test("rejects inconsistent container reference metadata in hand graphs", () => {
  const line = node("Z_BAD_LINE", "structure", [scalarField("TEXT", "g")]);
  const lines = node("Z_BAD_LINES", "table", [
    referenceField("", "structure", "Z_BAD_LINE"),
  ]);
  const badReference = Object.freeze({
    ...referenceField("LINES", "table", "Z_BAD_LINES"),
    internalType: "I",
  });
  const root = node("Z_BAD_ROOT", "structure", [badReference]);
  const input = interfaceParameter("BAD", "I", "Z_BAD_ROOT", "v");
  const metadata = graph(
    [root, lines, line],
    [parameter("BAD", "I", "Z_BAD_ROOT", "v")],
  );
  assert.throws(
    () => validateRecursiveXrfcParameter(metadata, input),
    /BAD\.LINES contains inconsistent table metadata/u,
  );
});

test("bounds very deep hand graphs before the JavaScript call stack", () => {
  const count = 15_000;
  const nodes: RecursiveMetadataTypeNode[] = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push(node(
      `Z_CHAIN_${index}`,
      "structure",
      index + 1 === count
        ? [scalarField("TEXT", "g")]
        : [referenceField("NEXT", "structure", `Z_CHAIN_${index + 1}`)],
    ));
  }
  const input = interfaceParameter("CHAIN", "I", "Z_CHAIN_0", "u");
  const base = graph(nodes, [parameter("CHAIN", "I", "Z_CHAIN_0", "u")]);
  const metadata: RecursiveMetadataGraph = Object.freeze({
    ...base,
    limits: Object.freeze({
      ...base.limits,
      maxNodes: count,
      maxRows: count,
      maxEdges: count,
    }),
  });
  assert.throws(
    () => validateRecursiveXrfcParameter(metadata, input, { maxDepth: 64 }),
    (error: unknown) =>
      error instanceof RangeError &&
      /exceeds recursive xRFC depth 64/u.test(error.message) &&
      !/Maximum call stack/u.test(error.message),
  );
});

test("keeps fixed flat structures on classic serialization", () => {
  const flat = node("Z_FLAT", "structure", [
    scalarField("COUNT", "I", { ucLength: 4, nucLength: 4 }),
  ]);
  const input = interfaceParameter("FLAT", "I", "Z_FLAT", "u");
  const metadata = graph([flat], [parameter("FLAT", "I", "Z_FLAT", "u")]);
  assert.equal(resolveRecursiveXrfcParameter(metadata, input), undefined);
  assert.throws(
    () => encodeRecursiveXrfcParameter(input, metadata, { COUNT: 1 }),
    /does not require recursive xRFC/u,
  );
});

test("enforces aggregate row, cell, depth, and byte limits", () => {
  const value = {
    TEXT: "ABC",
    CHILD: { COUNT: 1 },
    ROWS: [{ VALUE: "0001", PAYLOAD: Buffer.alloc(0) }],
    BLOB: Buffer.alloc(0),
  };
  assert.throws(
    () => encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, value, { maxRows: 0 }),
    /row count 0/u,
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, value, { maxCells: 2 }),
    /cell count 2/u,
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, value, { maxDepth: 1 }),
    /depth 1/u,
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, value, { maxParameterBytes: 30 }),
    /exceeds 30 bytes/u,
  );

  const encoded = encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, value);
  assert.throws(
    () => decodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, encoded, { maxRows: 0 }),
    /row count 0/u,
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, encoded, { maxCells: 2 }),
    /cell count 2/u,
  );
});

test("bounds aggregate runtime containers independently of rows and cells", () => {
  const nestedChild = node("Z_LIMIT_CHILD", "structure", [scalarField("TEXT", "g")]);
  const nestedRow = node("Z_LIMIT_ROW", "structure", [
    referenceField("CHILD", "structure", "Z_LIMIT_CHILD"),
  ]);
  const nestedRows = node("Z_LIMIT_ROWS", "table", [
    referenceField("", "structure", "Z_LIMIT_ROW"),
  ]);
  const input = interfaceParameter("ROWS", "C", "Z_LIMIT_ROWS", "h");
  const metadata = graph(
    [nestedRows, nestedRow, nestedChild],
    [parameter("ROWS", "C", "Z_LIMIT_ROWS", "h")],
  );
  const value = [
    { CHILD: { TEXT: "one" } },
    { CHILD: { TEXT: "two" } },
    { CHILD: { TEXT: "three" } },
  ];
  assert.throws(
    () => encodeRecursiveXrfcParameter(input, metadata, value, {
      maxNodes: 4,
      maxRows: 3,
      maxCells: 3,
    }),
    /runtime node count 4/u,
  );
  const encoded = encodeRecursiveXrfcParameter(input, metadata, value);
  assert.throws(
    () => decodeRecursiveXrfcParameter(input, metadata, encoded, {
      maxNodes: 4,
      maxRows: 3,
      maxCells: 3,
    }),
    /runtime node count 4/u,
  );
});

test("uses intrinsic recursive XML geometry before decoding caller bytes", () => {
  const encoded = encodeRecursiveXrfcParameter(
    ROOT_PARAMETER,
    ROOT_GRAPH,
    {},
  );
  const callerBytes = new Uint8Array(encoded);
  Object.defineProperty(callerBytes, "byteLength", { value: 1 });
  const maximum = encoded.byteLength - 1;

  assert.throws(
    () => decodeRecursiveXrfcParameterName(callerBytes, {
      maxParameterBytes: maximum,
    }),
    new RegExp(`must contain 1\\.\\.${maximum} bytes`, "u"),
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      callerBytes,
      { maxParameterBytes: maximum },
    ),
    new RegExp(`exceeds ${maximum} bytes`, "u"),
  );
});

test("validates recursive INT8 mode even when the graph has no INT8 field", () => {
  const encoded = encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, {});
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      {},
      { int8Mode: "invalid" as never },
    ),
    /int8Mode must be number, bigint, or string/u,
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      encoded,
      { int8Mode: "invalid" as never },
    ),
    /int8Mode must be number, bigint, or string/u,
  );
});

test("uses one recursive limit snapshot for preflight and value traversal", () => {
  let encodeReads = 0;
  const encodeOptions = Object.create(null) as { readonly maxDepth?: number };
  Object.defineProperty(encodeOptions, "maxDepth", {
    enumerable: true,
    get() {
      encodeReads += 1;
      return encodeReads === 1 ? 4 : 0;
    },
  });
  const encoded = encodeRecursiveXrfcParameter(
    ROOT_PARAMETER,
    ROOT_GRAPH,
    {},
    encodeOptions,
  );
  assert.equal(encodeReads, 1);

  let decodeReads = 0;
  const decodeOptions = Object.create(null) as { readonly maxDepth?: number };
  Object.defineProperty(decodeOptions, "maxDepth", {
    enumerable: true,
    get() {
      decodeReads += 1;
      return decodeReads === 1 ? 4 : 0;
    },
  });
  assert.deepEqual(
    decodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      encoded,
      decodeOptions,
    ),
    { TEXT: "", CHILD: { COUNT: 0 }, ROWS: [], BLOB: Buffer.alloc(0) },
  );
  assert.equal(decodeReads, 1);
});

test("rejects expanded text and XSTRING before copying beyond cell limits", () => {
  const textRoot = node("Z_BOUNDED_TEXT", "structure", [
    scalarField("TEXT", "g"),
    scalarField("BYTES", "y", { position: 2 }),
  ]);
  const input = interfaceParameter("BOUNDED", "I", "Z_BOUNDED_TEXT", "v");
  const metadata = graph(
    [textRoot],
    [parameter("BOUNDED", "I", "Z_BOUNDED_TEXT", "v")],
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      input,
      metadata,
      { TEXT: "&&", BYTES: Buffer.alloc(0) },
      { maxCellBytes: 5 },
    ),
    /XML value exceeds 5 bytes/u,
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      input,
      metadata,
      { TEXT: "", BYTES: new Uint8Array(1024 * 1024) },
      { maxCellBytes: 4 },
    ),
    /XML value exceeds 4 bytes/u,
  );
  const largeText = "a".repeat(128 * 1024);
  const encoded = encodeRecursiveXrfcParameter(
    input,
    metadata,
    { TEXT: largeText, BYTES: Buffer.alloc(0) },
    {
      maxCellBytes: largeText.length,
      maxParameterBytes: largeText.length + 128,
    },
  );
  assert.equal(encoded.includes(Buffer.from(largeText)), true);

  const fixedRoot = node("Z_BOUNDED_FIXED", "structure", [
    scalarField("FIXED", "X", {
      nucLength: 1024 * 1024,
      ucLength: 1024 * 1024,
    }),
    scalarField("MARKER", "g", { position: 2 }),
  ]);
  const fixedInput = interfaceParameter("FIXED_ROOT", "I", "Z_BOUNDED_FIXED", "v");
  const fixedGraph = graph(
    [fixedRoot],
    [parameter("FIXED_ROOT", "I", "Z_BOUNDED_FIXED", "v")],
  );
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      fixedInput,
      fixedGraph,
      { MARKER: "force-xrfc" },
      { maxCellBytes: 4 },
    ),
    /XML value exceeds 4 bytes/u,
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      fixedInput,
      fixedGraph,
      Buffer.from(
        "<FIXED_ROOT><FIXED></FIXED><MARKER></MARKER></FIXED_ROOT>",
      ),
      { maxCellBytes: 4, maxParameterBytes: 1024 },
    ),
    /FIXED_ROOT\.FIXED decoded value exceeds the 4-byte cell limit/u,
  );

  const numericRoot = node("Z_BOUNDED_NUMERIC", "structure", [
    scalarField("NUMBER", "N", {
      nucLength: 1024 * 1024,
      ucLength: 2 * 1024 * 1024,
    }),
  ]);
  const numericInput = interfaceParameter(
    "NUMERIC_ROOT",
    "I",
    "Z_BOUNDED_NUMERIC",
    "v",
  );
  const numericGraph = graph(
    [numericRoot],
    [parameter("NUMERIC_ROOT", "I", "Z_BOUNDED_NUMERIC", "v")],
  );
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      numericInput,
      numericGraph,
      Buffer.from("<NUMERIC_ROOT><NUMBER></NUMBER></NUMERIC_ROOT>"),
      { maxCellBytes: 4, maxParameterBytes: 1024 },
    ),
    /NUMERIC_ROOT\.NUMBER decoded value exceeds the 4-byte cell limit/u,
  );
});

test("bounds aggregate metadata-expanded recursive output", () => {
  const fields = Object.freeze(Array.from({ length: 8 }, (_, index) =>
    scalarField(`FIXED_${index}`, "X", {
      position: index + 1,
      nucLength: 1024,
      ucLength: 1024,
    })));
  const expandedRoot = node("Z_AGGREGATE_FIXED", "structure", fields);
  const input = interfaceParameter(
    "EXPANDED",
    "I",
    "Z_AGGREGATE_FIXED",
    "v",
  );
  const metadata = graph(
    [expandedRoot],
    [parameter("EXPANDED", "I", "Z_AGGREGATE_FIXED", "v")],
  );
  const cells = fields.map(({ name }) => `<${name}></${name}>`).join("");
  const xml = Buffer.from(`<EXPANDED>${cells}</EXPANDED>`);
  assert.ok(xml.byteLength < 4096);
  assert.throws(
    () => decodeRecursiveXrfcParameter(
      input,
      metadata,
      xml,
      {
        maxCellBytes: 1024,
        maxParameterBytes: 4096,
      },
    ),
    /decoded output exceeds the 4096-byte parameter limit/u,
  );
});

test("rejects unknown fields and malformed recursive XML without partial output", () => {
  assert.throws(
    () => encodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      { EXTRA: true },
    ),
    /unknown field EXTRA/u,
  );
  const valid = encodeRecursiveXrfcParameter(ROOT_PARAMETER, ROOT_GRAPH, {});
  for (const malformed of [
    valid.toString().replace("<TEXT>", "<text>"),
    valid.toString().replace("<COUNT>0</COUNT>", "<COUNT>01</COUNT>"),
    valid.toString().replace("<BLOB></BLOB>", "<BLOB>A</BLOB>"),
    `${valid.toString()}tail`,
  ]) {
    assert.throws(() => decodeRecursiveXrfcParameter(
      ROOT_PARAMETER,
      ROOT_GRAPH,
      Buffer.from(malformed),
    ));
  }
});

test("rejects cyclic graph edges before reading recursive values", () => {
  const cyclicField = Object.freeze({
    ...referenceField("SELF", "structure", "Z_CYCLE"),
    reference: Object.freeze({
      kind: "structure" as const,
      targetType: "Z_CYCLE",
      cyclic: true,
    }),
  });
  const cycle = node("Z_CYCLE", "structure", [cyclicField]);
  const input = interfaceParameter("CYCLE", "I", "Z_CYCLE", "u");
  const metadata = graph([cycle], [parameter("CYCLE", "I", "Z_CYCLE", "u")]);
  assert.throws(
    () => resolveRecursiveXrfcParameter(metadata, input),
    /cyclic recursive RFC type/u,
  );
});
