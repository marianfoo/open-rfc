import assert from "node:assert/strict";
import test from "node:test";
import {
  RecursiveMetadataError,
  normalizeRecursiveMetadataGraph,
} from "../src/metadata/recursive-metadata.js";

const TS = "20260716010203";

function typeRow(options: {
  typeName: string;
  fieldName: string;
  fieldType: string;
  internalType: string;
  componentType?: string;
  dataType?: string;
  nucTotal?: number;
  ucTotal?: number;
  nucOffset?: number;
  ucOffset?: number;
  nucLength?: number;
  ucLength?: number;
  decimals?: number;
  timestamp?: string;
  description?: string;
}): Record<string, unknown> {
  return {
    TYPENAME: options.typeName,
    FIELDNAME: options.fieldName,
    COMPTYPE: options.componentType ?? "E",
    FIELDTYPE: options.fieldType,
    DATATYPE: options.dataType ?? "CHAR",
    TABLENGTH: String(options.nucTotal ?? 8).padStart(6, "0"),
    TABLENGTH_UC: String(options.ucTotal ?? 8).padStart(6, "0"),
    DESCRIPTION: options.description ?? "",
    DECIMALS: String(options.decimals ?? 0).padStart(6, "0"),
    INTTYPE: options.internalType,
    OFFSET: String(options.nucOffset ?? 0).padStart(6, "0"),
    OFFSET_UC: String(options.ucOffset ?? 0).padStart(6, "0"),
    INTLEN: String(options.nucLength ?? 8).padStart(6, "0"),
    INTLEN_UC: String(options.ucLength ?? 8).padStart(6, "0"),
    TIMESTAMP: options.timestamp ?? TS,
  };
}

function parameterRow(options: {
  name: string;
  parameterClass?: "I" | "E" | "C" | "T" | "X";
  tableName?: string;
  fieldPath?: string;
  internalType?: string;
  position?: unknown;
  defaultValue?: string;
  parameterText?: string;
  optional?: boolean;
  functionName?: string;
}): Record<string, unknown> {
  return {
    FUNCNAME: options.functionName ?? "Z_GRAPH_TEST",
    PARAMCLASS: options.parameterClass ?? "I",
    PARAMETER: options.name,
    TABNAME: options.tableName ?? "",
    FIELDNAME: options.fieldPath ?? "",
    EXID: options.internalType ?? "C",
    POSITION: options.position ?? 1,
    OFFSET: 0,
    INTLENGTH: 8,
    DECIMALS: 0,
    DEFAULT: options.defaultValue ?? "",
    PARAMTEXT: options.parameterText ?? "",
    OPTIONAL: options.optional === true ? "X" : "",
  };
}

function functionRow(options: {
  name?: string;
  basxmlSupported?: boolean;
  date?: string;
  time?: string;
} = {}): Record<string, unknown> {
  return {
    FUNCTIONNAME: options.name ?? "Z_GRAPH_TEST",
    BASXML_SUPPORTED: options.basxmlSupported === true ? "X" : "",
    UDAT: options.date ?? "20260716",
    UTIME: options.time ?? "010203",
  };
}

function metadata(
  typeRows: readonly Record<string, unknown>[],
  parameters: readonly Record<string, unknown>[] = [],
  indirect: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    FUNCTIONNAMES: [functionRow()],
    DATATYPESCONT: [...typeRows],
    INDIRECTTYPES: [...indirect],
    PARAMETERS: [...parameters],
  };
}

function errorCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) =>
    error instanceof RecursiveMetadataError && error.code === code);
}

test("normalizes an immutable nested structure graph with dual geometry", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_PARENT",
      fieldName: "CHILD",
      fieldType: "Z_CHILD",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
    }),
    typeRow({
      typeName: "Z_CHILD",
      fieldName: "TEXT",
      fieldType: "CHAR4",
      internalType: "C",
      nucTotal: 4,
      ucTotal: 8,
      nucLength: 4,
      ucLength: 8,
    }),
  ], [parameterRow({
    name: "VALUE",
    tableName: "Z_PARENT",
    internalType: "u",
    defaultValue: "'DEFAULT'",
    parameterText: "Nested value",
    optional: true,
  })]));

  assert.equal(graph.nodes.get("Z_PARENT")?.kind, "structure");
  assert.deepEqual(graph.nodes.get("Z_PARENT")?.fields[0], {
    name: "CHILD",
    position: 1,
    componentType: "S",
    associatedType: "Z_CHILD",
    dataType: "STRU",
    internalType: "u",
    description: "",
    decimals: 0,
    nucOffset: 0,
    ucOffset: 0,
    nucLength: 8,
    ucLength: 8,
    reference: { kind: "structure", targetType: "Z_CHILD", cyclic: false },
  });
  assert.equal(graph.statistics.maximumDepth, 2);
  assert.equal(graph.parameters[0]?.reference.kind, "structure");
  assert.equal(graph.parameters[0]?.defaultValue, "'DEFAULT'");
  assert.equal(graph.parameters[0]?.parameterText, "Nested value");
  assert.equal(graph.parameters[0]?.optional, true);
  assert.deepEqual(graph.functionIdentity, {
    name: "Z_GRAPH_TEST",
    remoteBasxmlSupported: false,
    generationToken: "function:20260716:010203",
  });
  assert(Object.isFrozen(graph.functionIdentity));
  assert(Object.isFrozen(graph));
  assert(Object.isFrozen(graph.nodes.get("Z_PARENT")));
  assert(Object.isFrozen(graph.nodes.get("Z_PARENT")?.fields));
  assert(Object.isFrozen(graph.nodes.get("Z_PARENT")?.fields[0]?.reference));
  assert.equal("set" in graph.nodes, false);
});

test("retains a bounded function identity for a zero-parameter RFM", () => {
  const graph = normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [functionRow({
      name: "Z_EMPTY_RFM",
      basxmlSupported: true,
      date: "20260715",
      time: "235959",
    })],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    PARAMETERS: [],
  });

  assert.deepEqual(graph.functionIdentity, {
    name: "Z_EMPTY_RFM",
    remoteBasxmlSupported: true,
    generationToken: "function:20260715:235959",
  });
  assert.deepEqual(graph.parameters, []);
  assert.equal(graph.statistics.rowCount, 1);
  assert(Object.isFrozen(graph));
  assert(Object.isFrozen(graph.functionIdentity));
});

test("accepts zero parameter positions and preserves source order for ties", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([], [
    parameterRow({ name: "ZERO_FIRST", position: 0 }),
    parameterRow({ name: "ZERO_SECOND", position: 0 }),
    parameterRow({ name: "LATER", position: 2 }),
  ]));

  assert.deepEqual(graph.parameters.map(({ name, position }) => ({
    name,
    position,
  })), [
    { name: "ZERO_FIRST", position: 0 },
    { name: "ZERO_SECOND", position: 0 },
    { name: "LATER", position: 2 },
  ]);

  for (const position of [-1, "-1", "invalid", 1.5]) {
    errorCode(() => normalizeRecursiveMetadataGraph(metadata([], [
      parameterRow({ name: "BAD", position }),
    ])), "INVALID_INTEGER");
  }
});

test("rejects multiple identities and foreign or mixed parameter functions", () => {
  errorCode(() => normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [functionRow(), functionRow({ name: "Z_OTHER" })],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    PARAMETERS: [],
  }), "MULTIPLE_FUNCTION_IDENTITIES");

  errorCode(() => normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [functionRow({ name: "Z_OTHER" })],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    PARAMETERS: [parameterRow({ name: "VALUE" })],
  }), "FOREIGN_FUNCTION_REFERENCE");

  errorCode(() => normalizeRecursiveMetadataGraph({
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    PARAMETERS: [
      parameterRow({ name: "LEFT" }),
      parameterRow({ name: "RIGHT", functionName: "Z_OTHER" }),
    ],
  }), "MULTIPLE_FUNCTIONS");
});

test("preserves table-in-structure, structure-in-table, nested XSTRING, and shared identity", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "ROWS",
      fieldType: "Z_TT_ROW",
      internalType: "h",
      componentType: "T",
      dataType: "TTYP",
      nucTotal: 16,
      ucTotal: 16,
      nucLength: 8,
      ucLength: 8,
    }),
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "SHARED",
      fieldType: "Z_ROW",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      nucTotal: 16,
      ucTotal: 16,
      nucOffset: 8,
      ucOffset: 8,
    }),
    typeRow({
      typeName: "Z_TT_ROW",
      fieldName: "",
      fieldType: "Z_ROW",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
    }),
    typeRow({
      typeName: "Z_ROW",
      fieldName: "PAYLOAD",
      fieldType: "RAWSTRING",
      internalType: "y",
      dataType: "RSTR",
    }),
  ], [parameterRow({
    name: "ROOT",
    tableName: "Z_ROOT",
    internalType: "u",
  })]));

  const root = graph.nodes.get("Z_ROOT")!;
  const table = graph.nodes.get("Z_TT_ROW")!;
  assert.equal(root.fields[0]?.reference.kind, "table");
  assert.deepEqual(root.fields[0]?.reference, {
    kind: "table",
    targetType: "Z_TT_ROW",
    cyclic: false,
  });
  assert.equal(table.kind, "table");
  assert.equal(table.fields[0]?.name, "");
  assert.deepEqual(table.fields[0]?.reference, {
    kind: "structure",
    targetType: "Z_ROW",
    cyclic: false,
  });
  assert.deepEqual(graph.nodes.get("Z_ROW")?.fields[0]?.reference, {
    kind: "scalar",
    internalType: "y",
  });
  assert.equal(
    (root.fields[1]?.reference as { targetType: string }).targetType,
    (table.fields[0]?.reference as { targetType: string }).targetType,
  );
});

test("accepts RFC_METADATA_GET deep-structure v rows used by structured tables", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_TT_DEEP_ROW",
      fieldName: "",
      fieldType: "Z_DEEP_ROW",
      internalType: "v",
      componentType: "S",
      dataType: "STRU",
      nucTotal: 8,
      ucTotal: 8,
      nucLength: 0,
      ucLength: 0,
    }),
    typeRow({
      typeName: "Z_DEEP_ROW",
      fieldName: "TEXT",
      fieldType: "STRING",
      internalType: "g",
      dataType: "STRG",
      nucTotal: 16,
      ucTotal: 16,
    }),
    typeRow({
      typeName: "Z_DEEP_ROW",
      fieldName: "BYTES",
      fieldType: "XSTRING",
      internalType: "y",
      dataType: "RSTR",
      nucOffset: 8,
      ucOffset: 8,
      nucTotal: 16,
      ucTotal: 16,
    }),
  ], [parameterRow({
    name: "ROWS",
    parameterClass: "I",
    tableName: "Z_TT_DEEP_ROW",
    internalType: "h",
    position: 0,
  })]));

  assert.equal(graph.nodes.get("Z_TT_DEEP_ROW")?.kind, "table");
  assert.deepEqual(graph.nodes.get("Z_TT_DEEP_ROW")?.fields[0]?.reference, {
    kind: "structure",
    targetType: "Z_DEEP_ROW",
    cyclic: false,
  });
  assert.deepEqual(graph.parameters[0]?.reference, {
    kind: "table",
    targetType: "Z_TT_DEEP_ROW",
    cyclic: false,
  });
  assert.deepEqual(
    graph.nodes.get("Z_DEEP_ROW")?.fields.map(({ reference }) => reference),
    [
      { kind: "scalar", internalType: "g" },
      { kind: "scalar", internalType: "y" },
    ],
  );
});

test("uses INTLEN geometry for anonymous top-level scalar descriptors", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "CHAR255",
      fieldName: "",
      fieldType: "CHAR255",
      internalType: "C",
      nucTotal: 0,
      ucTotal: 0,
      nucLength: 255,
      ucLength: 510,
    }),
  ], [parameterRow({
    name: "TEXT",
    tableName: "CHAR255",
    internalType: "C",
  })]));

  const node = graph.nodes.get("CHAR255");
  assert.equal(node?.kind, "scalar");
  assert.equal(node?.nucLength, 255);
  assert.equal(node?.ucLength, 510);
  assert.deepEqual(node?.fields[0]?.reference, {
    kind: "scalar",
    internalType: "C",
  });
});

test("resolves bounded indirect function field paths without losing associated types", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_WRAPPER",
      fieldName: "VALUE",
      fieldType: "Z_VALUE",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
    }),
    typeRow({
      typeName: "Z_VALUE",
      fieldName: "TEXT",
      fieldType: "CHAR8",
      internalType: "C",
    }),
  ], [parameterRow({
    name: "NESTED",
    tableName: "Z_OUTER",
    fieldPath: "INNER-VALUE",
    internalType: "u",
  })], [{
    TABNAME: "Z_OUTER",
    FIELDNAME: "INNER-VALUE",
    FIELDTYPE: "Z_WRAPPER",
  }]));

  assert.equal(graph.parameters[0]?.associatedType, "Z_OUTER");
  assert.equal(graph.parameters[0]?.fieldPath, "INNER-VALUE");
  assert.deepEqual(graph.parameters[0]?.reference, {
    kind: "structure",
    targetType: "Z_WRAPPER",
    cyclic: false,
  });
});

test("represents classic scalar TABLES parameters as table edges to scalar leaves", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "SYST",
      fieldName: "LISEL",
      fieldType: "CHAR255",
      internalType: "C",
      nucTotal: 255,
      ucTotal: 510,
      nucLength: 255,
      ucLength: 510,
    }),
  ], [parameterRow({
    name: "LINES",
    parameterClass: "T",
    tableName: "SYST",
    fieldPath: "LISEL",
    internalType: "C",
  })]));

  assert.deepEqual(graph.parameters[0]?.reference, {
    kind: "table",
    scalarLine: { internalType: "C" },
    cyclic: false,
  });
  assert.deepEqual(graph.rootTypeNames, ["SYST"]);
  assert.equal(graph.statistics.edgeCount, 1);
  assert(Object.isFrozen(
    (graph.parameters[0]?.reference as { scalarLine: object }).scalarLine,
  ));
});

test("keeps indirectly associated elementary descriptors as scalar identity nodes", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_ELEMENT",
      fieldName: "",
      fieldType: "CHAR8",
      internalType: "C",
    }),
  ], [
    parameterRow({
      name: "VALUE",
      tableName: "Z_OUTER",
      fieldPath: "INNER-VALUE",
      internalType: "C",
    }),
    parameterRow({
      name: "DIRECT",
      tableName: "Z_ELEMENT",
      internalType: "C",
      position: 2,
    }),
  ], [{
    TABNAME: "Z_OUTER",
    FIELDNAME: "INNER-VALUE",
    FIELDTYPE: "Z_ELEMENT",
  }]));

  assert.equal(graph.nodes.get("Z_ELEMENT")?.kind, "scalar");
  assert.deepEqual(graph.nodes.get("Z_ELEMENT")?.fields[0]?.reference, {
    kind: "scalar",
    internalType: "C",
  });
  assert.deepEqual(graph.parameters[0]?.reference, {
    kind: "scalar",
    internalType: "C",
  });
  assert.deepEqual(graph.parameters[1]?.reference, {
    kind: "scalar",
    internalType: "C",
  });
  assert.deepEqual(graph.rootTypeNames, ["Z_ELEMENT"]);
});

test("promotes an elementary descriptor to a named scalar table by incoming table edge", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "VALUES",
      fieldType: "Z_TT_TEXT",
      internalType: "h",
      componentType: "T",
      dataType: "TTYP",
    }),
    typeRow({
      typeName: "Z_TT_TEXT",
      fieldName: "",
      fieldType: "CHAR8",
      internalType: "C",
    }),
  ]), { rootTypeNames: ["Z_ROOT"] });

  assert.equal(graph.nodes.get("Z_TT_TEXT")?.kind, "table");
  assert.deepEqual(graph.nodes.get("Z_TT_TEXT")?.fields[0]?.reference, {
    kind: "scalar",
    internalType: "C",
  });
});

test("represents descriptor cycles explicitly and keeps shared nodes finite", () => {
  const graph = normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_A",
      fieldName: "B",
      fieldType: "Z_B",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
    }),
    typeRow({
      typeName: "Z_B",
      fieldName: "A",
      fieldType: "Z_A",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
    }),
  ]), { rootTypeNames: ["Z_A"] });

  assert.deepEqual(graph.cycles, [{ id: "cycle:0", typeNames: ["Z_A", "Z_B"] }]);
  assert.equal(
    (graph.nodes.get("Z_A")?.fields[0]?.reference as { cyclic: boolean }).cyclic,
    true,
  );
  assert.equal(
    (graph.nodes.get("Z_B")?.fields[0]?.reference as { cyclic: boolean }).cyclic,
    true,
  );
  assert.equal(graph.statistics.maximumDepth, 1);
});

test("accepts an empty initial graph and freezes every empty collection", () => {
  const graph = normalizeRecursiveMetadataGraph({
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
  });
  assert.equal(graph.nodes.size, 0);
  assert.deepEqual(graph.parameters, []);
  assert.deepEqual(graph.rootTypeNames, []);
  assert.deepEqual(graph.cycles, []);
  assert.equal(graph.statistics.maximumDepth, 0);
  assert(Object.isFrozen(graph.parameters));
  assert(Object.isFrozen(graph.rootTypeNames));
  assert(Object.isFrozen(graph.cycles));
});

test("rejects corrupt geometry, duplicates, foreign nodes, and bad targets", () => {
  errorCode(() => normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_BAD",
      fieldName: "A",
      fieldType: "CHAR8",
      internalType: "C",
      nucTotal: 12,
      ucTotal: 12,
      nucLength: 8,
      ucLength: 8,
    }),
    typeRow({
      typeName: "Z_BAD",
      fieldName: "B",
      fieldType: "CHAR8",
      internalType: "C",
      nucTotal: 12,
      ucTotal: 12,
      nucOffset: 4,
      ucOffset: 4,
      nucLength: 8,
      ucLength: 8,
    }),
  ])), "INVALID_GEOMETRY");

  errorCode(() => normalizeRecursiveMetadataGraph(metadata([
    typeRow({ typeName: "Z_DUP", fieldName: "A", fieldType: "CHAR", internalType: "C" }),
    typeRow({ typeName: "Z_DUP", fieldName: "A", fieldType: "CHAR", internalType: "C" }),
  ])), "DUPLICATE_FIELD");

  errorCode(() => normalizeRecursiveMetadataGraph(metadata([
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "CHILD",
      fieldType: "Z_MISSING",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
    }),
  ])), "FOREIGN_TYPE_REFERENCE");

  errorCode(() => normalizeRecursiveMetadataGraph(metadata([
    typeRow({ typeName: "Z_ROOT", fieldName: "A", fieldType: "CHAR", internalType: "C" }),
    typeRow({ typeName: "Z_FOREIGN", fieldName: "B", fieldType: "CHAR", internalType: "C" }),
  ]), { rootTypeNames: ["Z_ROOT"] }), "FOREIGN_TYPE_NODE");
});

test("rejects foreign and duplicate indirect declarations", () => {
  const rows = [
    typeRow({ typeName: "Z_TARGET", fieldName: "A", fieldType: "CHAR", internalType: "C" }),
  ];
  const indirect = [{
    TABNAME: "Z_OUTER",
    FIELDNAME: "A-B",
    FIELDTYPE: "Z_TARGET",
  }];
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata(rows, [], indirect)),
    "FOREIGN_INDIRECT_TYPE",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata(rows, [parameterRow({
      name: "VALUE",
      tableName: "Z_OUTER",
      fieldPath: "A-B",
      internalType: "u",
    })], [...indirect, ...indirect])),
    "DUPLICATE_INDIRECT_TYPE",
  );
});

test("enforces every configurable resource limit", () => {
  const scalar = typeRow({
    typeName: "Z_ONE",
    fieldName: "A",
    fieldType: "CHAR",
    internalType: "C",
  });
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([scalar]), { limits: { maxRows: 0 } }),
    "ROW_LIMIT",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([scalar]), { limits: { maxNodes: 0 } }),
    "NODE_LIMIT",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([
      typeRow({
        typeName: "Z_A",
        fieldName: "B",
        fieldType: "Z_B",
        internalType: "u",
        componentType: "S",
        dataType: "STRU",
      }),
      typeRow({ typeName: "Z_B", fieldName: "A", fieldType: "CHAR", internalType: "C" }),
    ]), { limits: { maxEdges: 0 } }),
    "EDGE_LIMIT",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([
      typeRow({
        typeName: "Z_A",
        fieldName: "B",
        fieldType: "Z_B",
        internalType: "u",
        componentType: "S",
        dataType: "STRU",
      }),
      typeRow({
        typeName: "Z_B",
        fieldName: "C",
        fieldType: "Z_C",
        internalType: "u",
        componentType: "S",
        dataType: "STRU",
      }),
      typeRow({ typeName: "Z_C", fieldName: "A", fieldType: "CHAR", internalType: "C" }),
    ]), { rootTypeNames: ["Z_A"], limits: { maxDepth: 2 } }),
    "DEPTH_LIMIT",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([scalar]), { limits: { maxProperties: 1 } }),
    "PROPERTY_LIMIT",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([scalar]), { limits: { maxBytes: 1 } }),
    "BYTE_LIMIT",
  );
  errorCode(
    () => normalizeRecursiveMetadataGraph(metadata([]), { limits: { maxRows: 100_001 } }),
    "INVALID_LIMIT",
  );
});

test("rejects getters, proxies, sparse arrays, and hostile text without leaking it", () => {
  let getterCalled = false;
  const accessor = metadata([]);
  Object.defineProperty(accessor, "DATATYPESCONT", {
    get() {
      getterCalled = true;
      return [];
    },
    enumerable: true,
  });
  errorCode(() => normalizeRecursiveMetadataGraph(accessor), "ACCESSOR_PROPERTY");
  assert.equal(getterCalled, false);

  errorCode(
    () => normalizeRecursiveMetadataGraph(new Proxy(metadata([]), {})),
    "PROXY_INPUT",
  );

  const sparse = new Array(1);
  errorCode(
    () => normalizeRecursiveMetadataGraph({ DATATYPESCONT: sparse, INDIRECTTYPES: [] }),
    "MISSING_PROPERTY",
  );

  const secret = ["backend-secret", "value"].join("-");
  const hostile = typeRow({
    typeName: "Z_SAFE",
    fieldName: `${secret}\u0000`,
    fieldType: "CHAR",
    internalType: "C",
  });
  assert.throws(
    () => normalizeRecursiveMetadataGraph(metadata([hostile])),
    (error: unknown) =>
      error instanceof RecursiveMetadataError &&
      error.code === "INVALID_TEXT" &&
      !error.message.includes(secret),
  );

  const extra = metadata([]);
  Object.defineProperty(extra, secret, { value: "ignored", enumerable: true });
  assert.throws(
    () => normalizeRecursiveMetadataGraph(extra),
    (error: unknown) =>
      error instanceof RecursiveMetadataError &&
      error.code === "UNKNOWN_PROPERTY" &&
      !error.message.includes(secret),
  );
});
