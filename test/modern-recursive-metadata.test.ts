import assert from "node:assert/strict";
import test from "node:test";

import {
  ModernMetadataProjectionError,
  toModernRfcMetadataFromRecursiveGraph,
} from "../src/compat/modern-metadata.js";
import {
  normalizeRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../src/metadata/recursive-metadata.js";

const TIMESTAMP = "20260716010203";

function typeRow(options: {
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
  readonly decimals?: number;
  readonly description?: string;
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
    TIMESTAMP,
  };
}

function parameterRow(options: {
  readonly name: string;
  readonly parameterClass?: "I" | "E" | "C" | "T" | "X";
  readonly tableName?: string;
  readonly fieldPath?: string;
  readonly internalType?: string;
  readonly internalLength?: number;
  readonly decimals?: number;
  readonly position?: number;
  readonly defaultValue?: string;
  readonly parameterText?: string;
  readonly optional?: boolean;
  readonly functionName?: string;
}): Record<string, unknown> {
  return {
    FUNCNAME: options.functionName ?? "Z_RECURSIVE_META",
    PARAMCLASS: options.parameterClass ?? "I",
    PARAMETER: options.name,
    TABNAME: options.tableName ?? "",
    FIELDNAME: options.fieldPath ?? "",
    EXID: options.internalType ?? "C",
    POSITION: options.position ?? 1,
    OFFSET: 0,
    INTLENGTH: options.internalLength ?? 8,
    DECIMALS: options.decimals ?? 0,
    DEFAULT: options.defaultValue ?? "",
    PARAMTEXT: options.parameterText ?? "",
    OPTIONAL: options.optional === true ? "X" : "",
  };
}

function graph(
  typeRows: readonly Record<string, unknown>[],
  parameters: readonly Record<string, unknown>[],
): RecursiveMetadataGraph {
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_RECURSIVE_META",
      BASXML_SUPPORTED: "X",
      UDAT: "20260716",
      UTIME: "010203",
    }],
    DATATYPESCONT: [...typeRows],
    INDIRECTTYPES: [],
    PARAMETERS: [...parameters],
  });
}

function projectionError(
  action: () => unknown,
  code: string,
): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ModernMetadataProjectionError && error.code === code);
}

function recursiveFixture(): RecursiveMetadataGraph {
  return graph([
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "TEXT",
      fieldType: "CHAR4",
      internalType: "C",
      nucTotal: 24,
      ucTotal: 28,
      nucLength: 4,
      ucLength: 8,
    }),
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "CHILD",
      fieldType: "Z_CHILD",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      nucTotal: 24,
      ucTotal: 28,
      nucOffset: 4,
      ucOffset: 8,
      nucLength: 4,
      ucLength: 4,
    }),
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "ROWS",
      fieldType: "Z_TT_ROW",
      internalType: "h",
      componentType: "T",
      dataType: "TTYP",
      nucTotal: 24,
      ucTotal: 28,
      nucOffset: 8,
      ucOffset: 12,
      nucLength: 8,
      ucLength: 8,
    }),
    typeRow({
      typeName: "Z_ROOT",
      fieldName: "BLOB",
      fieldType: "RAWSTRING",
      internalType: "y",
      dataType: "RSTR",
      nucTotal: 24,
      ucTotal: 28,
      nucOffset: 16,
      ucOffset: 20,
      nucLength: 8,
      ucLength: 8,
    }),
    typeRow({
      typeName: "Z_CHILD",
      fieldName: "COUNT",
      fieldType: "INT4",
      internalType: "I",
      dataType: "INT4",
      nucTotal: 4,
      ucTotal: 4,
      nucLength: 4,
      ucLength: 4,
    }),
    typeRow({
      typeName: "Z_TT_ROW",
      fieldName: "",
      fieldType: "Z_ROW",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      nucTotal: 12,
      ucTotal: 16,
      nucLength: 12,
      ucLength: 16,
    }),
    typeRow({
      typeName: "Z_ROW",
      fieldName: "VALUE",
      fieldType: "NUMC4",
      internalType: "N",
      dataType: "NUMC",
      nucTotal: 12,
      ucTotal: 16,
      nucLength: 4,
      ucLength: 8,
    }),
    typeRow({
      typeName: "Z_ROW",
      fieldName: "PAYLOAD",
      fieldType: "RAWSTRING",
      internalType: "y",
      dataType: "RSTR",
      nucTotal: 12,
      ucTotal: 16,
      nucOffset: 4,
      ucOffset: 8,
      nucLength: 8,
      ucLength: 8,
    }),
  ], [
    parameterRow({
      name: "IGNORED_EXCEPTION",
      parameterClass: "X",
      internalType: "",
      position: 5,
    }),
    parameterRow({
      name: "OUT",
      parameterClass: "E",
      tableName: "Z_ROOT",
      internalType: "u",
      internalLength: 999,
      position: 4,
      defaultValue: "'OUT'",
      parameterText: "Recursive output",
    }),
    parameterRow({
      name: "ITEMS",
      tableName: "Z_TT_ROW",
      internalType: "h",
      internalLength: 999,
      position: 1,
      defaultValue: "'ITEMS'",
      parameterText: "Rows input",
      optional: true,
    }),
    parameterRow({
      name: "SECOND",
      internalType: "C",
      internalLength: 2,
      position: 2,
    }),
    parameterRow({
      name: "RAW",
      parameterClass: "C",
      internalType: "y",
      internalLength: 8,
      position: 3,
      decimals: 2,
      defaultValue: "'00'",
      parameterText: "Binary changing value",
      optional: true,
    }),
  ]);
}

test("projects nested structures, tables, and XSTRING with authoritative NUC geometry", () => {
  const converted = toModernRfcMetadataFromRecursiveGraph(recursiveFixture());

  assert.equal(converted.rfcName, "Z_RECURSIVE_META");
  assert.deepEqual(converted.import.map(({ name }) => name), ["ITEMS", "SECOND"]);
  assert.deepEqual(converted.changing, [{
    name: "RAW",
    nwrfcType: "RFCTYPE_XSTRING",
    abapType: "y",
    format: "",
    length: 8,
    decimals: 2,
    defaultValue: "'00'",
    parameterText: "Binary changing value",
    optional: true,
  }]);
  assert.deepEqual(converted.table, []);

  const items = converted.import[0]!;
  assert.equal(items.nwrfcType, "RFCTYPE_TABLE");
  assert.equal(items.abapType, "h");
  assert.equal(items.associatedType, "Z_TT_ROW");
  assert.equal(items.length, 12);
  assert.deepEqual(items.tableFields, [
    {
      name: "VALUE",
      nwrfcType: "RFCTYPE_NUM",
      abapType: "n",
      format: "",
      length: 4,
      decimals: 0,
      offset: 0,
    },
    {
      name: "PAYLOAD",
      nwrfcType: "RFCTYPE_XSTRING",
      abapType: "y",
      format: "",
      length: 8,
      decimals: 0,
      offset: 4,
    },
  ]);
  assert.equal(items.defaultValue, "'ITEMS'");
  assert.equal(items.parameterText, "Rows input");
  assert.equal(items.optional, true);

  const output = converted.export[0]!;
  assert.equal(output.nwrfcType, "RFCTYPE_STRUCTURE");
  assert.equal(output.associatedType, "Z_ROOT");
  assert.equal(output.length, 24);
  const fields = output.fields as readonly Record<string, unknown>[];
  assert.deepEqual(fields.map(({ name, length, offset }) => ({ name, length, offset })), [
    { name: "TEXT", length: 4, offset: 0 },
    { name: "CHILD", length: 4, offset: 4 },
    { name: "ROWS", length: 8, offset: 8 },
    { name: "BLOB", length: 8, offset: 16 },
  ]);
  assert.deepEqual(fields[1]!.fields, [{
    name: "COUNT",
    nwrfcType: "RFCTYPE_INT",
    abapType: "i",
    format: "",
    length: 4,
    decimals: 0,
    offset: 0,
  }]);
  assert.deepEqual(fields[2]!.tableFields, items.tableFields);
  assert.equal(fields[2]!.associatedType, "Z_TT_ROW");
  assert.equal(fields[3]!.nwrfcType, "RFCTYPE_XSTRING");
  assert.equal(output.defaultValue, "'OUT'");
  assert.equal(output.parameterText, "Recursive output");
  assert.equal(output.optional, false);

  assert(Object.isFrozen(converted));
  assert(Object.isFrozen(converted.import));
  assert(Object.isFrozen(items));
  assert(Object.isFrozen(items.tableFields));
  assert(Object.isFrozen(fields));
  assert(Object.isFrozen(fields[1]!.fields));
});

test("projects a zero-parameter function identity as an empty envelope", () => {
  const converted = toModernRfcMetadataFromRecursiveGraph(graph([], []));

  assert.deepEqual(converted, {
    rfcName: "Z_RECURSIVE_META",
    import: [],
    export: [],
    changing: [],
    table: [],
  });
  assert(Object.isFrozen(converted));
  assert(Object.isFrozen(converted.import));
});

test("keeps zero-position parameter ties in captured source order", () => {
  const converted = toModernRfcMetadataFromRecursiveGraph(graph([], [
    parameterRow({ name: "ZERO_FIRST", internalType: "I", position: 0 }),
    parameterRow({ name: "ZERO_SECOND", internalType: "I", position: 0 }),
    parameterRow({ name: "LATER", internalType: "I", position: 2 }),
  ]));

  assert.deepEqual(converted.import.map(({ name }) => name), [
    "ZERO_FIRST",
    "ZERO_SECOND",
    "LATER",
  ]);
});

test("unwraps a named scalar table line into one anonymous field", () => {
  const converted = toModernRfcMetadataFromRecursiveGraph(graph([
    typeRow({
      typeName: "Z_TT_TEXT",
      fieldName: "",
      fieldType: "CHAR6",
      internalType: "C",
      nucTotal: 6,
      ucTotal: 12,
      nucLength: 6,
      ucLength: 12,
    }),
  ], [parameterRow({
    name: "TEXTS",
    parameterClass: "T",
    tableName: "Z_TT_TEXT",
    internalType: "h",
    internalLength: 999,
  })]));

  assert.deepEqual(converted.table[0], {
    name: "TEXTS",
    nwrfcType: "RFCTYPE_TABLE",
    abapType: "h",
    format: "",
    length: 6,
    decimals: 0,
    associatedType: "Z_TT_TEXT",
    tableFields: [{
      name: "",
      nwrfcType: "RFCTYPE_CHAR",
      abapType: "c",
      format: "",
      length: 6,
      decimals: 0,
      offset: 0,
    }],
    defaultValue: "",
    parameterText: "",
    optional: false,
  });

  const classicScalarTable = toModernRfcMetadataFromRecursiveGraph(graph([], [
    parameterRow({
      name: "LINES",
      parameterClass: "T",
      internalType: "C",
      internalLength: 12,
    }),
  ]));
  assert.deepEqual(classicScalarTable.table[0], {
    name: "LINES",
    nwrfcType: "RFCTYPE_TABLE",
    abapType: "h",
    format: "",
    length: 6,
    decimals: 0,
    tableFields: [{
      name: "",
      nwrfcType: "RFCTYPE_CHAR",
      abapType: "c",
      format: "",
      length: 6,
      decimals: 0,
      offset: 0,
    }],
    defaultValue: "",
    parameterText: "",
    optional: false,
  });
});

test("retains every established scalar mapping and sorts by metadata position", () => {
  const cases = [
    ["C", "RFCTYPE_CHAR", "c", 8, 4],
    ["N", "RFCTYPE_NUM", "n", 8, 4],
    ["D", "RFCTYPE_DATE", "d", 16, 8],
    ["T", "RFCTYPE_TIME", "t", 12, 6],
    ["X", "RFCTYPE_BYTE", "x", 3, 3],
    ["P", "RFCTYPE_BCD", "p", 8, 8],
    ["F", "RFCTYPE_FLOAT", "f", 8, 8],
    ["I", "RFCTYPE_INT", "i", 4, 4],
    ["b", "RFCTYPE_INT1", "b", 1, 1],
    ["s", "RFCTYPE_INT2", "s", 2, 2],
    ["8", "RFCTYPE_INT8", "8", 8, 8],
    ["a", "RFCTYPE_DECF16", "a", 8, 8],
    ["e", "RFCTYPE_DECF34", "e", 16, 16],
    ["p", "RFCTYPE_UTCLONG", "p", 8, 8],
    ["g", "RFCTYPE_STRING", "g", 8, 8],
    ["n", "RFCTYPE_UTCSECOND", "n", 8, 8],
    ["w", "RFCTYPE_UTCMINUTE", "w", 8, 8],
    ["d", "RFCTYPE_DTDAY", "d", 4, 4],
    ["7", "RFCTYPE_DTWEEK", "7", 4, 4],
    ["x", "RFCTYPE_DTMONTH", "x", 4, 4],
    ["t", "RFCTYPE_TSECOND", "t", 4, 4],
    ["i", "RFCTYPE_TMINUTE", "i", 2, 2],
    ["c", "RFCTYPE_CDAY", "c", 2, 2],
    ["y", "RFCTYPE_XSTRING", "y", 8, 8],
  ] as const;
  const parameters = cases.map(([internalType, , , internalLength], index) =>
    parameterRow({
      name: `P${String(index).padStart(2, "0")}`,
      internalType,
      internalLength,
      position: index + 1,
    })).reverse();

  const converted = toModernRfcMetadataFromRecursiveGraph(graph([], parameters));
  assert.deepEqual(converted.import.map((parameter) => [
    parameter.name,
    parameter.nwrfcType,
    parameter.abapType,
    parameter.length,
  ]), cases.map(([, nwrfcType, abapType, , length], index) => [
    `P${String(index).padStart(2, "0")}`,
    nwrfcType,
    abapType,
    length,
  ]));
});

test("rejects cycles, foreign references, and mixed function identities", () => {
  const cyclic = graph([
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
  ], [parameterRow({ name: "VALUE", tableName: "Z_A", internalType: "u" })]);
  projectionError(
    () => toModernRfcMetadataFromRecursiveGraph(cyclic),
    "CYCLIC_GRAPH",
  );

  const valid = recursiveFixture();
  const withoutRow = Object.freeze({
    ...valid,
    nodes: new Map([...valid.nodes].filter(([name]) => name !== "Z_ROW")),
  }) as RecursiveMetadataGraph;
  projectionError(
    () => toModernRfcMetadataFromRecursiveGraph(withoutRow),
    "FOREIGN_TYPE",
  );

  const mixed = Object.freeze({
    ...valid,
    parameters: Object.freeze([
      ...valid.parameters,
      Object.freeze({
        ...valid.parameters.find(({ parameterClass }) => parameterClass !== "X")!,
        functionName: "Z_OTHER_FUNCTION",
        name: "OTHER",
      }),
    ]),
  }) as RecursiveMetadataGraph;
  projectionError(
    () => toModernRfcMetadataFromRecursiveGraph(mixed),
    "MULTIPLE_FUNCTIONS",
  );

  const foreignIdentity = Object.freeze({
    ...valid,
    functionIdentity: Object.freeze({
      ...valid.functionIdentity!,
      name: "Z_OTHER_FUNCTION",
    }),
  }) as RecursiveMetadataGraph;
  projectionError(
    () => toModernRfcMetadataFromRecursiveGraph(foreignIdentity),
    "FOREIGN_FUNCTION_REFERENCE",
  );
});

test("bounds unfolded shared graph projections by descriptor count", () => {
  const shared = graph([
    typeRow({
      typeName: "Z_PARENT",
      fieldName: "LEFT",
      fieldType: "Z_SHARED",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      nucTotal: 8,
      ucTotal: 8,
      nucLength: 4,
      ucLength: 4,
    }),
    typeRow({
      typeName: "Z_PARENT",
      fieldName: "RIGHT",
      fieldType: "Z_SHARED",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      nucTotal: 8,
      ucTotal: 8,
      nucOffset: 4,
      ucOffset: 4,
      nucLength: 4,
      ucLength: 4,
    }),
    typeRow({
      typeName: "Z_SHARED",
      fieldName: "VALUE",
      fieldType: "INT4",
      internalType: "I",
      dataType: "INT4",
      nucTotal: 4,
      ucTotal: 4,
      nucLength: 4,
      ucLength: 4,
    }),
  ], [parameterRow({
    name: "PARENT",
    tableName: "Z_PARENT",
    internalType: "u",
  })]);

  projectionError(
    () => toModernRfcMetadataFromRecursiveGraph(shared, {
      maxProjectedDescriptors: 4,
    }),
    "PROJECTION_LIMIT",
  );
  projectionError(
    () => toModernRfcMetadataFromRecursiveGraph(shared, {
      maxProjectionDepth: 0,
    }),
    "DEPTH_LIMIT",
  );
  assert.doesNotThrow(() => toModernRfcMetadataFromRecursiveGraph(shared, {
    maxProjectedDescriptors: 5,
  }));
});
