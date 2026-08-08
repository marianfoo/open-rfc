import assert from "node:assert/strict";
import test from "node:test";

import {
  RFC_METADATA_GET_BOOTSTRAP,
  RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP,
  createRfcMetadataGetFunctionInvocation,
  createRfcMetadataGetStructureInvocation,
  createRfcMetadataGetTimestampInvocation,
  normalizeRfcMetadataGetFunction,
  normalizeRfcMetadataGetFunctionResult,
  normalizeRfcMetadataGetRecursiveFunctionResult,
  normalizeRfcMetadataGetStructure,
  normalizeRfcMetadataGetStructureResult,
  normalizeRfcMetadataGetTimestamps,
} from "../src/metadata/rfc-metadata-get.js";
import { RecursiveMetadataError } from "../src/metadata/recursive-metadata.js";

test("pins the classic RFC_METADATA_GET bootstrap to Note 1456826 geometry", () => {
  assert.equal(RFC_METADATA_GET_BOOTSTRAP.metadata.name, "RFC_METADATA_GET");
  assert.deepEqual(
    RFC_METADATA_GET_BOOTSTRAP.metadata.parameters.map((parameter) =>
      [parameter.parameterName, parameter.parameterClass, parameter.tableName]),
    [
      ["DEEP", "I", ""],
      ["LANGUAGE", "I", ""],
      ["GET_CLIENT_DEP_FIELDS", "I", ""],
      ["GET_TIMESTAMPS", "I", ""],
      ["FUNCTIONNAMES", "T", "RFCFUNCTIONNAME"],
      ["DATATYPES", "T", "RFC_MD_DDIC_NAME"],
      ["KNOWN_DATATYPES", "T", "RFC_MD_DDIC_NAME"],
      ["PARAMETERS", "T", "RFC_METADATA_PARAMS"],
      ["DATATYPESCONT", "T", "RFC_METADATA_DDIC"],
      ["INDIRECTTYPES", "T", "RFC_METADATA_DDIC_INDIRECT"],
      ["FUNC_ERRORS", "T", "RFC_FUNC_ERROR"],
      ["DD_ERRORS", "T", "RFC_DD_ERROR"],
    ],
  );
  assert.deepEqual(
    [...RFC_METADATA_GET_BOOTSTRAP.structures]
      .map(([name, definition]) => [name, definition.byteLength]),
    [
      ["RFCFUNCTIONNAME", 90],
      ["RFC_MD_DDIC_NAME", 120],
      ["RFC_METADATA_PARAMS", 464],
      ["RFC_METADATA_DDIC", 424],
      ["RFC_METADATA_DDIC_INDIRECT", 180],
      ["RFC_FUNC_ERROR", 630],
      ["RFC_DD_ERROR", 690],
    ],
  );
  assert.equal(Object.isFrozen(RFC_METADATA_GET_BOOTSTRAP), true);
});

test("builds bounded function and structure metadata requests", () => {
  assert.deepEqual(createRfcMetadataGetFunctionInvocation("STFC_CONNECTION", "E"), {
    input: {
      DEEP: "X",
      LANGUAGE: "E",
      GET_TIMESTAMPS: "X",
      FUNCTIONNAMES: [{ FUNCTIONNAME: "STFC_CONNECTION" }],
      DATATYPES: [],
      KNOWN_DATATYPES: [],
      PARAMETERS: [],
      DATATYPESCONT: [],
      INDIRECTTYPES: [],
      FUNC_ERRORS: [],
      DD_ERRORS: [],
    },
  });
  assert.deepEqual(createRfcMetadataGetStructureInvocation("RFCSI", "D"), {
    input: {
      DEEP: "X",
      LANGUAGE: "D",
      GET_TIMESTAMPS: "X",
      FUNCTIONNAMES: [],
      DATATYPES: [{ TABNAME: "RFCSI" }],
      KNOWN_DATATYPES: [],
      PARAMETERS: [],
      DATATYPESCONT: [],
      INDIRECTTYPES: [],
      FUNC_ERRORS: [],
      DD_ERRORS: [],
    },
  });
  assert.throws(
    () => createRfcMetadataGetFunctionInvocation("", "E"),
    /functionName/u,
  );
  assert.throws(
    () => createRfcMetadataGetStructureInvocation("RFCSI", "EN"),
    /language/u,
  );
});

test("pins and snapshots the classic RFC_METADATA_GET_TIMESTAMP contract", () => {
  assert.equal(
    RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP.metadata.name,
    "RFC_METADATA_GET_TIMESTAMP",
  );
  assert.deepEqual(
    RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP.metadata.parameters.map((parameter) =>
      [parameter.parameterName, parameter.parameterClass, parameter.tableName,
        parameter.optional]),
    [
      ["FUNCTION_TIMESTAMPS", "T", "RFC_METADATA_FUNC_TIMESTAMP", false],
      ["DDIC_TIMESTAMPS", "T", "RFC_METADATA_DDIC_TIMESTAMP", false],
      ["FUNC_ERRORS", "T", "RFC_FUNC_ERROR", true],
      ["DD_ERRORS", "T", "RFC_DD_ERROR", true],
    ],
  );
  assert.deepEqual(
    [...RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP.structures]
      .map(([name, definition]) => [name, definition.byteLength]),
    [
      ["RFC_METADATA_FUNC_TIMESTAMP", 88],
      ["RFC_METADATA_DDIC_TIMESTAMP", 88],
      ["RFC_FUNC_ERROR", 630],
      ["RFC_DD_ERROR", 690],
    ],
  );

  const functions = ["STFC_CONNECTION"];
  const structures = ["RFCSI"];
  const invocation = createRfcMetadataGetTimestampInvocation(
    functions,
    structures,
  );
  functions[0] = "MUTATED";
  structures[0] = "MUTATED";
  assert.deepEqual(invocation, {
    input: {
      FUNCTION_TIMESTAMPS: [{ FUNCNAME: "STFC_CONNECTION" }],
      DDIC_TIMESTAMPS: [{ TYPENAME: "RFCSI" }],
      FUNC_ERRORS: [],
      DD_ERRORS: [],
    },
    functionNames: ["STFC_CONNECTION"],
    structureNames: ["RFCSI"],
  });
  assert.equal(Object.isFrozen(invocation.input.FUNCTION_TIMESTAMPS), true);
  assert.throws(
    () => createRfcMetadataGetTimestampInvocation(
      ["STFC_CONNECTION", "STFC_CONNECTION"],
      [],
    ),
    /duplicate function name/u,
  );
  assert.throws(
    () => createRfcMetadataGetTimestampInvocation(
      Array.from({ length: 513 }, (_, index) => `Z_F${index}`),
      [],
    ),
    /at most 512 function names/u,
  );
});

test("normalizes complete timestamp batches without retaining backend text", () => {
  const result = normalizeRfcMetadataGetTimestamps(
    ["STFC_CONNECTION", "MISSING_FUNCTION"],
    ["RFCSI", "MISSING_TYPE"],
    {
      FUNCTION_TIMESTAMPS: [{
        FUNCNAME: "STFC_CONNECTION",
        UDAT: "20260716",
        UTIME: "010203",
      }],
      DDIC_TIMESTAMPS: [{
        TYPENAME: "RFCSI",
        TIMESTAMP: "20260716010203",
      }],
      FUNC_ERRORS: [{
        FUNCNAME: "MISSING_FUNCTION",
        EXCEPTION: "FUNCTION_NOT_EXIST",
        EXCEPTION_TEXT: "localized private backend text",
      }],
      DD_ERRORS: [{
        TABNAME: "MISSING_TYPE",
        FIELDNAME: "",
        EXCEPTION: "NOT_FOUND",
        EXCEPTION_TEXT: "localized private backend text",
      }],
    },
  );
  assert.deepEqual([...result.functions], [["STFC_CONNECTION", {
    functionName: "STFC_CONNECTION",
    date: "20260716",
    time: "010203",
    token: ["function", "20260716", "010203"].join(":"),
  }]]);
  assert.deepEqual([...result.structures], [["RFCSI", {
    structureName: "RFCSI",
    timestamp: "20260716010203",
    token: ["structure", "20260716010203"].join(":"),
  }]]);
  assert.deepEqual(
    [...result.functionErrors],
    [["MISSING_FUNCTION", "FUNCTION_NOT_EXIST"]],
  );
  assert.deepEqual(
    [...result.structureErrors],
    [["MISSING_TYPE", "NOT_FOUND"]],
  );
  assert.equal(JSON.stringify(result).includes("private backend"), false);
  assert.throws(
    () => (result.functions as unknown as Map<string, unknown>)
      .set("MUTATE", result.functions.get("STFC_CONNECTION")!),
    /set is not a function/u,
  );
});

test("rejects incomplete, foreign, duplicate, and malformed timestamp batches", () => {
  const valid = {
    FUNCTION_TIMESTAMPS: [{
      FUNCNAME: "STFC_CONNECTION",
      UDAT: "20260716",
      UTIME: "010203",
    }],
    DDIC_TIMESTAMPS: [],
    FUNC_ERRORS: [],
    DD_ERRORS: [],
  };
  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(
      ["STFC_CONNECTION", "RFC_PING"],
      [],
      valid,
    ),
    /no outcome for function RFC_PING/u,
  );
  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(["RFC_PING"], [], valid),
    /unrequested function STFC_CONNECTION/u,
  );
  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(["STFC_CONNECTION"], [], {
      ...valid,
      FUNC_ERRORS: [{
        FUNCNAME: "STFC_CONNECTION",
        EXCEPTION: "FUNCTION_NOT_EXIST",
        EXCEPTION_TEXT: "",
      }],
    }),
    /duplicate outcome for function STFC_CONNECTION/u,
  );
  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(["STFC_CONNECTION"], [], {
      ...valid,
      FUNCTION_TIMESTAMPS: [{
        ...valid.FUNCTION_TIMESTAMPS[0],
        UTIME: "25:00",
      }],
    }),
    /UTIME/u,
  );

  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(["STFC_CONNECTION"], [], {
      ...valid,
      FUNCTION_TIMESTAMPS: [
        valid.FUNCTION_TIMESTAMPS[0],
        valid.FUNCTION_TIMESTAMPS[0],
      ],
    }),
    /at most 1 rows/u,
  );

  const sparseRows = new Array(1) as unknown[];
  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(["STFC_CONNECTION"], [], {
      ...valid,
      FUNCTION_TIMESTAMPS: sparseRows,
    }),
    /own data property/u,
  );

  let hostileRowGetterCalled = false;
  const accessorRows: unknown[] = [];
  Object.defineProperty(accessorRows, 0, {
    configurable: true,
    enumerable: true,
    get() {
      hostileRowGetterCalled = true;
      throw new Error("private row payload");
    },
  });
  assert.throws(
    () => normalizeRfcMetadataGetTimestamps(["STFC_CONNECTION"], [], {
      ...valid,
      FUNCTION_TIMESTAMPS: accessorRows,
    }),
    (error: unknown) =>
      error instanceof TypeError &&
      !error.message.includes("private row payload"),
  );
  assert.equal(hostileRowGetterCalled, false);
});

test("binds optimized descriptors to generations from the same metadata response", () => {
  const functionIdentity = {
    FUNCTIONNAME: "Z_TOKEN",
    BASXML_SUPPORTED: "",
    UDAT: "20260716",
    UTIME: "112233",
  };
  const functionResult = normalizeRfcMetadataGetFunctionResult("Z_TOKEN", {
    FUNCTIONNAMES: [functionIdentity],
    PARAMETERS: [],
    FUNC_ERRORS: [],
  });
  functionIdentity.UDAT = "19990101";
  assert.equal(functionResult.value.name, "Z_TOKEN");
  assert.equal(functionResult.generationToken, "function:20260716:112233");
  assert.equal(Object.isFrozen(functionResult), true);
  assert.equal(Object.isFrozen(functionResult.value), true);

  const structureResult = normalizeRfcMetadataGetStructureResult("Z_TOKEN_LINE", {
    DATATYPESCONT: [{
      TYPENAME: "Z_TOKEN_LINE",
      FIELDNAME: "VALUE",
      COMPTYPE: "E",
      FIELDTYPE: "INT4",
      DATATYPE: "INT4",
      TABLENGTH_UC: "000004",
      DECIMALS: "000000",
      INTTYPE: "I",
      OFFSET_UC: "000000",
      INTLEN_UC: "000004",
      TIMESTAMP: "20260716112233",
    }],
    DD_ERRORS: [],
  });
  assert.equal(structureResult.value.name, "Z_TOKEN_LINE");
  assert.equal(
    structureResult.generationToken,
    "structure:20260716112233",
  );
  assert.equal(Object.isFrozen(structureResult), true);

  assert.throws(
    () => normalizeRfcMetadataGetFunctionResult("Z_TOKEN", {
      FUNCTIONNAMES: [{
        FUNCTIONNAME: "Z_TOKEN",
        BASXML_SUPPORTED: "",
        UDAT: "2026-07-16",
        UTIME: "112233",
      }],
      PARAMETERS: [],
      FUNC_ERRORS: [],
    }),
    /UDAT/u,
  );
  assert.throws(
    () => normalizeRfcMetadataGetStructureResult("Z_TOKEN_LINE", {
      DATATYPESCONT: [
        {
          TYPENAME: "Z_TOKEN_LINE",
          FIELDNAME: "LEFT",
          COMPTYPE: "E",
          FIELDTYPE: "INT4",
          DATATYPE: "INT4",
          TABLENGTH_UC: "000008",
          DECIMALS: "000000",
          INTTYPE: "I",
          OFFSET_UC: "000000",
          INTLEN_UC: "000004",
          TIMESTAMP: "20260716112233",
        },
        {
          TYPENAME: "Z_TOKEN_LINE",
          FIELDNAME: "RIGHT",
          COMPTYPE: "E",
          FIELDTYPE: "INT4",
          DATATYPE: "INT4",
          TABLENGTH_UC: "000008",
          DECIMALS: "000000",
          INTTYPE: "I",
          OFFSET_UC: "000004",
          INTLEN_UC: "000004",
          TIMESTAMP: "20260716112234",
        },
      ],
      DD_ERRORS: [],
    }),
    /inconsistent timestamps/u,
  );
});

test("binds a recursive DEEP graph to its same-response function generation", () => {
  const identity = {
    FUNCTIONNAME: "Z_DEEP_TOKEN",
    BASXML_SUPPORTED: "X",
    UDAT: "20260716",
    UTIME: "112233",
  };
  const typeRow = (
    typeName: string,
    fieldName: string,
    fieldType: string,
    internalType: string,
    offset: number,
    length: number,
    total: number,
    componentType = "E",
    dataType = "CHAR",
  ): Record<string, unknown> => ({
    TYPENAME: typeName,
    FIELDNAME: fieldName,
    COMPTYPE: componentType,
    FIELDTYPE: fieldType,
    DATATYPE: dataType,
    TABLENGTH: String(total).padStart(6, "0"),
    TABLENGTH_UC: String(total).padStart(6, "0"),
    DESCRIPTION: "",
    DECIMALS: "000000",
    INTTYPE: internalType,
    OFFSET: String(offset).padStart(6, "0"),
    OFFSET_UC: String(offset).padStart(6, "0"),
    INTLEN: String(length).padStart(6, "0"),
    INTLEN_UC: String(length).padStart(6, "0"),
    TIMESTAMP: "20260716112233",
  });
  const output = {
    FUNCTIONNAMES: [identity],
    PARAMETERS: [{
      FUNCNAME: "Z_DEEP_TOKEN",
      PARAMCLASS: "E",
      PARAMETER: "RESULT",
      TABNAME: "Z_DEEP_ROOT",
      FIELDNAME: "",
      EXID: "u",
      POSITION: 0,
      OFFSET: 0,
      INTLENGTH: 24,
      DECIMALS: 0,
      DEFAULT: "",
      PARAMTEXT: "",
      OPTIONAL: "",
    }],
    DATATYPESCONT: [
      typeRow("Z_DEEP_ROOT", "CHILD", "Z_DEEP_CHILD", "u", 0, 8, 16, "S", "STRU"),
      typeRow("Z_DEEP_ROOT", "ROWS", "Z_DEEP_TABLE", "h", 8, 8, 16, "T", "TTYP"),
      typeRow("Z_DEEP_CHILD", "PAYLOAD", "RAWSTRING", "y", 0, 8, 8, "E", "RSTR"),
      typeRow("Z_DEEP_TABLE", "", "Z_DEEP_ROW", "u", 0, 8, 8, "S", "STRU"),
      typeRow("Z_DEEP_ROW", "VALUE", "INT4", "I", 0, 4, 8, "E", "INT4"),
      typeRow("Z_DEEP_ROW", "BLOB", "RAWSTRING", "y", 4, 4, 8, "E", "RSTR"),
    ],
    INDIRECTTYPES: [],
    FUNC_ERRORS: [],
    DD_ERRORS: [],
  };

  const result = normalizeRfcMetadataGetRecursiveFunctionResult(
    "Z_DEEP_TOKEN",
    output,
  );
  identity.UDAT = "19990101";

  assert.equal(result.generationToken, "function:20260716:112233");
  assert.equal(result.value.functionIdentity?.generationToken, result.generationToken);
  assert.equal(result.value.nodes.get("Z_DEEP_ROOT")?.fields[0]?.reference.kind,
    "structure");
  assert.equal(result.value.nodes.get("Z_DEEP_ROOT")?.fields[1]?.reference.kind,
    "table");
  assert.equal(result.value.nodes.get("Z_DEEP_CHILD")?.fields[0]?.internalType, "y");
  assert.equal(Object.isFrozen(result.value), true);

  assert.throws(
    () => normalizeRfcMetadataGetRecursiveFunctionResult("Z_DEEP_TOKEN", {
      ...output,
      FUNCTIONNAMES: [{ ...identity, FUNCTIONNAME: "Z_FOREIGN" }],
    }),
    /identities for function Z_DEEP_TOKEN/u,
  );
  assert.throws(
    () => normalizeRfcMetadataGetRecursiveFunctionResult("Z_DEEP_TOKEN", {
      ...output,
      DD_ERRORS: [{
        TABNAME: "Z_MISSING_PRIVATE",
        FIELDNAME: "",
        EXCEPTION: "TYPE_NOT_FOUND",
        EXCEPTION_TEXT: "localized private DDIC text",
      }],
    }),
    (error: unknown) =>
      error instanceof RecursiveMetadataError &&
      error.code === "REMOTE_DDIC_RESOLUTION_ERRORS" &&
      error.path === "DD_ERRORS:1" &&
      !error.message.includes("localized private DDIC text"),
  );
  assert.throws(
    () => normalizeRfcMetadataGetRecursiveFunctionResult("Z_DEEP_TOKEN", {
      ...output,
      FUNC_ERRORS: [{
        FUNCNAME: "Z_FOREIGN",
        EXCEPTION: "FU_NOT_FOUND",
        EXCEPTION_TEXT: "localized private function text",
      }],
    }),
    /foreign function error/u,
  );
  assert.throws(
    () => normalizeRfcMetadataGetRecursiveFunctionResult("Z_DEEP_TOKEN", {
      ...output,
      PARAMETERS: new Array(20_001).fill(output.PARAMETERS[0]),
    }),
    /recursive metadata must contain at most 20000 total rows/u,
  );
});

test("admits only metadata-complete built-in UTCLONG scalar DDIC misses", () => {
  const parameter = {
    FUNCNAME: "Z_UTCLONG_ECHO",
    PARAMCLASS: "C",
    PARAMETER: "VALUE",
    TABNAME: "UTCLONG",
    FIELDNAME: "",
    EXID: "p",
    POSITION: 0,
    OFFSET: 0,
    INTLENGTH: 8,
    DECIMALS: 0,
    DEFAULT: "",
    PARAMTEXT: "",
    OPTIONAL: "",
  };
  const error = {
    TABNAME: "UTCLONG",
    FIELDNAME: "",
    EXCEPTION: "NOT_FOUND",
    EXCEPTION_TEXT: "localized private backend text",
  };
  const output = {
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_UTCLONG_ECHO",
      BASXML_SUPPORTED: "X",
      UDAT: "20260728",
      UTIME: "010203",
    }],
    PARAMETERS: [parameter],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    FUNC_ERRORS: [],
    DD_ERRORS: [error],
  };

  const result = normalizeRfcMetadataGetRecursiveFunctionResult(
    "Z_UTCLONG_ECHO",
    output,
  );
  assert.equal(result.value.parameters.length, 1);
  assert.deepEqual(result.value.parameters[0]?.reference, {
    kind: "scalar",
    internalType: "p",
  });
  assert.equal(JSON.stringify(result).includes("private backend"), false);

  const rejected = (candidate: unknown): void => {
    assert.throws(
      () => normalizeRfcMetadataGetRecursiveFunctionResult(
        "Z_UTCLONG_ECHO",
        candidate,
      ),
      (failure: unknown) =>
        failure instanceof RecursiveMetadataError &&
        failure.code === "REMOTE_DDIC_RESOLUTION_ERRORS" &&
        !failure.message.includes("private backend"),
    );
  };

  rejected({ ...output, DD_ERRORS: [{ ...error, TABNAME: "Z_UNKNOWN" }] });
  rejected({ ...output, DD_ERRORS: [{ ...error, FIELDNAME: "VALUE" }] });
  rejected({ ...output, DD_ERRORS: [{ ...error, EXCEPTION: "TYPE_NOT_FOUND" }] });
  rejected({ ...output, PARAMETERS: [{ ...parameter, PARAMCLASS: "E" }] });
  rejected({ ...output, PARAMETERS: [{ ...parameter, EXID: "Q" }] });
  rejected({ ...output, PARAMETERS: [{ ...parameter, INTLENGTH: 16 }] });
  rejected({ ...output, PARAMETERS: [{ ...parameter, OPTIONAL: "X" }] });
  rejected({ ...output, DATATYPESCONT: [{ TYPENAME: "UTCLONG" }] });
  rejected({
    ...output,
    DATATYPESCONT: [{
      TYPENAME: "Z_ROW",
      FIELDTYPE: "UTCLONG",
      DATATYPE: "CHAR",
    }],
  });
  rejected({
    ...output,
    DATATYPESCONT: [{
      TYPENAME: "Z_ROW",
      FIELDTYPE: "Z_TIMESTAMP",
      DATATYPE: "UTCLONG",
    }],
  });
  rejected({
    ...output,
    INDIRECTTYPES: [{
      TABNAME: "Z_ROW",
      FIELDNAME: "STAMP",
      FIELDTYPE: "UTCLONG",
    }],
  });
  rejected({
    ...output,
    PARAMETERS: [parameter, {
      ...parameter,
      PARAMCLASS: "X",
      PARAMETER: "BAD_EXCEPTION",
      EXID: "",
    }],
  });
  rejected({ ...output, DD_ERRORS: [error, { ...error }] });
});

test("normalizes optimized function rows without merging raw error text", () => {
  const metadata = normalizeRfcMetadataGetFunction("Z_TEST", {
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_TEST",
      BASXML_SUPPORTED: "X",
      UDAT: "20260716",
      UTIME: "010203",
    }],
    PARAMETERS: [
      {
        FUNCNAME: "Z_TEST",
        PARAMCLASS: "I",
        PARAMETER: "INPUT",
        TABNAME: "",
        FIELDNAME: "",
        EXID: "C",
        POSITION: 136,
        OFFSET: 0,
        INTLENGTH: 40,
        DECIMALS: 0,
        DEFAULT: "",
        PARAMTEXT: "Input",
        OPTIONAL: "X",
      },
      {
        FUNCNAME: "Z_TEST",
        PARAMCLASS: "X",
        PARAMETER: "NOT_FOUND",
        TABNAME: "",
        FIELDNAME: "",
        EXID: "",
        POSITION: 136,
        OFFSET: 0,
        INTLENGTH: 0,
        DECIMALS: 0,
        DEFAULT: "",
        PARAMTEXT: "Not found",
        OPTIONAL: "",
      },
    ],
    FUNC_ERRORS: [],
  });
  assert.deepEqual(metadata, {
    name: "Z_TEST",
    remoteBasxmlSupported: true,
    remoteCall: "R",
    updateTask: false,
    parameters: [{
      parameterClass: "I",
      parameterName: "INPUT",
      tableName: "",
      fieldName: "",
      exid: "C",
      position: 136,
      offset: 0,
      internalLength: 20,
      decimals: 0,
      defaultValue: "",
      parameterText: "Input",
      optional: true,
    }],
    exceptions: ["NOT_FOUND"],
    resumableExceptionRowCount: 0,
  });
  assert.equal(Object.isFrozen(metadata.parameters), true);

  assert.throws(
    () => normalizeRfcMetadataGetFunction("Z_ODD", {
      FUNCTIONNAMES: [{
        FUNCTIONNAME: "Z_ODD",
        BASXML_SUPPORTED: "",
      }],
      PARAMETERS: [{
        FUNCNAME: "Z_ODD",
        PARAMCLASS: "I",
        PARAMETER: "INPUT",
        TABNAME: "",
        FIELDNAME: "",
        EXID: "C",
        POSITION: 1,
        OFFSET: 0,
        INTLENGTH: 3,
        DECIMALS: 0,
        DEFAULT: "",
        PARAMTEXT: "",
        OPTIONAL: "",
      }],
      FUNC_ERRORS: [],
    }),
    /odd Unicode byte width/u,
  );

  assert.throws(
    () => normalizeRfcMetadataGetFunction("MISSING", {
      FUNCTIONNAMES: [],
      PARAMETERS: [],
      FUNC_ERRORS: [{
        FUNCNAME: "MISSING",
        EXCEPTION: "FU_NOT_FOUND",
        EXCEPTION_TEXT: "private localized text",
      }],
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "RFC_METADATA_GET could not resolve function MISSING (FU_NOT_FOUND)" &&
      !error.message.includes("private localized text"),
  );
});

test("accepts zero parameter positions and preserves optimized row order for ties", () => {
  const identity = {
    FUNCTIONNAME: "Z_ZERO_POSITION",
    BASXML_SUPPORTED: "",
    UDAT: "20260716",
    UTIME: "010203",
  };
  const parameter = (
    name: string,
    position: unknown,
  ): Record<string, unknown> => ({
    FUNCNAME: "Z_ZERO_POSITION",
    PARAMCLASS: "I",
    PARAMETER: name,
    TABNAME: "",
    FIELDNAME: "",
    EXID: "I",
    POSITION: position,
    OFFSET: 0,
    INTLENGTH: 4,
    DECIMALS: 0,
    DEFAULT: "",
    PARAMTEXT: "",
    OPTIONAL: "",
  });

  const metadata = normalizeRfcMetadataGetFunction("Z_ZERO_POSITION", {
    FUNCTIONNAMES: [identity],
    PARAMETERS: [
      parameter("ZERO_FIRST", 0),
      parameter("ZERO_SECOND", "0"),
      parameter("LATER", 2),
    ],
    FUNC_ERRORS: [],
  });
  assert.deepEqual(metadata.parameters.map(({ parameterName, position }) => ({
    parameterName,
    position,
  })), [
    { parameterName: "ZERO_FIRST", position: 0 },
    { parameterName: "ZERO_SECOND", position: 0 },
    { parameterName: "LATER", position: 2 },
  ]);

  for (const invalidPosition of [-1, "-1", "invalid", 1.5]) {
    assert.throws(
      () => normalizeRfcMetadataGetFunction("Z_ZERO_POSITION", {
        FUNCTIONNAMES: [identity],
        PARAMETERS: [parameter("BAD", invalidPosition)],
        FUNC_ERRORS: [],
      }),
      /POSITION must be a non-negative safe integer/u,
    );
  }
});

test("normalizes flat optimized type rows and rejects recursive classic geometry", () => {
  const structure = normalizeRfcMetadataGetStructure("Z_FLAT", {
    DATATYPESCONT: [
      {
        TYPENAME: "Z_FLAT",
        FIELDNAME: "TEXT",
        COMPTYPE: "E",
        FIELDTYPE: "CHAR10",
        DATATYPE: "CHAR",
        TABLENGTH: "000014",
        TABLENGTH_UC: "000024",
        DESCRIPTION: "",
        DECIMALS: "000000",
        INTTYPE: "C",
        OFFSET: "000000",
        OFFSET_UC: "000000",
        INTLEN: "000010",
        INTLEN_UC: "000020",
        TIMESTAMP: "20260716010203",
      },
      {
        TYPENAME: "Z_FLAT",
        FIELDNAME: "COUNT",
        COMPTYPE: "E",
        FIELDTYPE: "INT4",
        DATATYPE: "INT4",
        TABLENGTH: "000014",
        TABLENGTH_UC: "000024",
        DESCRIPTION: "",
        DECIMALS: "000000",
        INTTYPE: "I",
        OFFSET: "000010",
        OFFSET_UC: "000020",
        INTLEN: "000004",
        INTLEN_UC: "000004",
        TIMESTAMP: "20260716010203",
      },
    ],
    DD_ERRORS: [],
  });
  assert.deepEqual(structure, {
    name: "Z_FLAT",
    byteLength: 24,
    fields: [
      {
        tableName: "Z_FLAT",
        fieldName: "TEXT",
        position: 1,
        offset: 0,
        internalLength: 20,
        decimals: 0,
        exid: "C",
      },
      {
        tableName: "Z_FLAT",
        fieldName: "COUNT",
        position: 2,
        offset: 20,
        internalLength: 4,
        decimals: 0,
        exid: "I",
      },
    ],
  });

  assert.throws(
    () => normalizeRfcMetadataGetStructure("Z_DEEP", {
      DATATYPESCONT: [{
        TYPENAME: "Z_DEEP",
        FIELDNAME: "NESTED",
        COMPTYPE: "S",
        FIELDTYPE: "Z_CHILD",
        DATATYPE: "STRU",
        TABLENGTH_UC: "000020",
        DECIMALS: "000000",
        INTTYPE: "u",
        OFFSET_UC: "000000",
        INTLEN_UC: "000020",
        TIMESTAMP: "20260716010203",
      }],
      DD_ERRORS: [],
    }),
    /requires a negotiated recursive serializer/u,
  );
});

test("admits both elementary COMPTYPE spellings and still refuses composites", () => {
  const flatStructure = (componentType: string, internalType: string) => ({
    DATATYPESCONT: [{
      TYPENAME: "Z_FLAT",
      FIELDNAME: "TEXT",
      COMPTYPE: componentType,
      FIELDTYPE: "CHAR10",
      DATATYPE: "CHAR",
      TABLENGTH_UC: "000020",
      DESCRIPTION: "",
      DECIMALS: "000000",
      INTTYPE: internalType,
      OFFSET_UC: "000000",
      INTLEN_UC: "000020",
      TIMESTAMP: "20260716010203",
    }],
    DD_ERRORS: [],
  });
  const expected = {
    name: "Z_FLAT",
    byteLength: 20,
    fields: [{
      tableName: "Z_FLAT",
      fieldName: "TEXT",
      position: 1,
      offset: 0,
      internalLength: 20,
      decimals: 0,
      exid: "C",
    }],
  };
  // Initial and "E" are the same elementary declaration; DDIF already admits
  // both, so the same structure must decode identically either way.
  for (const componentType of ["", "E"]) {
    assert.deepEqual(
      normalizeRfcMetadataGetStructure("Z_FLAT", flatStructure(componentType, "C")),
      expected,
    );
  }
  for (const [componentType, internalType] of [
    ["S", "C"],
    ["L", "C"],
    ["R", "C"],
    ["", "u"],
    ["", "h"],
    ["", "v"],
    ["E", "u"],
  ] as const) {
    assert.throws(
      () =>
        normalizeRfcMetadataGetStructure(
          "Z_FLAT",
          flatStructure(componentType, internalType),
        ),
      /requires a negotiated recursive serializer/u,
    );
  }
});
