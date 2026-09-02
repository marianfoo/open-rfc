import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeRecursiveClassicXrfcParameter,
  encodeRecursiveClassicXrfcParameter,
  initialRecursiveClassicXrfcValue,
  resolveRecursiveClassicXrfcParameter,
  resolveRecursiveClassicXrfcParameterFromIndex,
} from "../src/values/recursive-classic-xrfc.js";
import {
  createRecursiveMetadataParameterIndex,
  recursiveMetadataParameterIndexDiagnostics,
} from "../src/metadata/recursive-parameter-index.js";
import {
  normalizeRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../src/metadata/recursive-metadata.js";
import { validateRecursiveXrfcParameterFromIndex } from
  "../src/values/recursive-xrfc.js";
import {
  admitLiveRecursiveSerializer,
  assertRecursiveSerializerSendDecision,
  classifyRecursiveSerializer,
  recursiveMetadataGraphSha256,
  snapshotLiveRecursiveSerializerPolicy,
} from "../src/values/recursive-serializer-classification.js";

const FUNCTION_NAME = "Z_RECURSIVE_XRFC";
const TIMESTAMP = "20260716123456";

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
  const total = options.total ?? 8;
  const offset = options.offset ?? 0;
  const length = options.length ?? 8;
  return {
    TYPENAME: options.typeName,
    FIELDNAME: options.fieldName,
    COMPTYPE: options.componentType ?? "E",
    FIELDTYPE: options.fieldType,
    DATATYPE: options.dataType ?? "CHAR",
    TABLENGTH: total,
    TABLENGTH_UC: total,
    DESCRIPTION: "",
    DECIMALS: 0,
    INTTYPE: options.internalType,
    OFFSET: offset,
    OFFSET_UC: offset,
    INTLEN: length,
    INTLEN_UC: length,
    TIMESTAMP,
  };
}

function parameterRow(
  name: string,
  parameterClass: "I" | "E",
): Record<string, unknown> {
  return {
    FUNCNAME: FUNCTION_NAME,
    PARAMCLASS: parameterClass,
    PARAMETER: name,
    TABNAME: "Z_ROOT",
    FIELDNAME: "",
    EXID: "v",
    POSITION: parameterClass === "I" ? 1 : 2,
    OFFSET: 0,
    INTLENGTH: 24,
    DECIMALS: 0,
    DEFAULT: "",
    PARAMTEXT: "",
    OPTIONAL: "",
  };
}

function sharedWideRootGraph(
  parameterCount: number,
  fieldCount: number,
): RecursiveMetadataGraph {
  const functionName = "Z_SHARED_WIDE_ROOT";
  const total = fieldCount * 8;
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: functionName,
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: Array.from({ length: fieldCount }, (_, index) =>
      typeRow({
        typeName: "Z_SHARED_WIDE",
        fieldName: `FIELD_${index}`,
        fieldType: index === fieldCount - 1 ? "STRING" : "CHAR4",
        internalType: index === fieldCount - 1 ? "g" : "C",
        dataType: index === fieldCount - 1 ? "STRG" : "CHAR",
        total,
        offset: index * 8,
        length: 8,
      })),
    INDIRECTTYPES: [],
    PARAMETERS: Array.from({ length: parameterCount }, (_, index) => ({
      ...parameterRow(`VALUE_${index}`, "I"),
      FUNCNAME: functionName,
      TABNAME: "Z_SHARED_WIDE",
      EXID: "u",
      POSITION: index + 1,
      INTLENGTH: total,
    })),
  });
}

function distinctWrapperSharedChildGraph(
  parameterCount: number,
  fieldCount: number,
): RecursiveMetadataGraph {
  const functionName = "Z_DISTINCT_SHARED_CHILD";
  const childTotal = fieldCount * 8;
  const childRows = Array.from({ length: fieldCount }, (_, index) =>
    typeRow({
      typeName: "Z_SHARED_LARGE_CHILD",
      fieldName: `FIELD_${index}`,
      fieldType: index === fieldCount - 1 ? "STRING" : "CHAR4",
      internalType: index === fieldCount - 1 ? "g" : "C",
      dataType: index === fieldCount - 1 ? "STRG" : "CHAR",
      total: childTotal,
      offset: index * 8,
      length: 8,
    }));
  const wrapperRows = Array.from({ length: parameterCount }, (_, index) =>
    typeRow({
      typeName: `Z_WRAPPER_${index}`,
      fieldName: "CHILD",
      fieldType: "Z_SHARED_LARGE_CHILD",
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      total: 8,
      length: 8,
    }));
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: functionName,
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [...childRows, ...wrapperRows],
    INDIRECTTYPES: [],
    PARAMETERS: Array.from({ length: parameterCount }, (_, index) => ({
      ...parameterRow(`VALUE_${index}`, "I"),
      FUNCNAME: functionName,
      TABNAME: `Z_WRAPPER_${index}`,
      EXID: "v",
      POSITION: index + 1,
      INTLENGTH: 8,
    })),
  });
}

function primedSharedDagGraph(): RecursiveMetadataGraph {
  const functionName = "Z_PRIMED_SHARED_DAG";
  const container = (owner: string, field: string, target: string, position = 1) =>
    typeRow({
      typeName: owner,
      fieldName: field,
      fieldType: target,
      internalType: "u",
      componentType: "S",
      dataType: "STRU",
      total: owner === "Z_ROOT" ? 16 : 8,
      offset: (position - 1) * 8,
      length: 8,
    });
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: functionName,
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [
      typeRow({
        typeName: "Z_SHARED",
        fieldName: "TEXT",
        fieldType: "STRING",
        internalType: "g",
        dataType: "STRG",
      }),
      container("Z_A", "SHARED", "Z_SHARED"),
      container("Z_B", "SHARED", "Z_SHARED"),
      container("Z_ROOT", "A", "Z_A"),
      container("Z_ROOT", "B", "Z_B", 2),
    ],
    INDIRECTTYPES: [],
    PARAMETERS: ["Z_A", "Z_B", "Z_ROOT"].map((typeName, index) => ({
      ...parameterRow(["A_VALUE", "B_VALUE", "ROOT_VALUE"][index]!, "I"),
      FUNCNAME: functionName,
      TABNAME: typeName,
      EXID: "v",
      POSITION: index + 1,
      INTLENGTH: typeName === "Z_ROOT" ? 16 : 8,
    })),
  }, {
    limits: { maxRows: 9, maxNodes: 4, maxEdges: 7, maxDepth: 3 },
  });
}

function binarySiblingPlan() {
  const graph = normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_BINARY_SIBLINGS",
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [
      typeRow({
        typeName: "Z_BINARY_ROOT",
        fieldName: "LEFT",
        fieldType: "XSTRING",
        internalType: "y",
        dataType: "RSTR",
        total: 16,
        length: 8,
      }),
      typeRow({
        typeName: "Z_BINARY_ROOT",
        fieldName: "RIGHT",
        fieldType: "XSTRING",
        internalType: "y",
        dataType: "RSTR",
        total: 16,
        offset: 8,
        length: 8,
      }),
    ],
    INDIRECTTYPES: [],
    PARAMETERS: [{
      ...parameterRow("VALUE", "I"),
      FUNCNAME: "Z_BINARY_SIBLINGS",
      TABNAME: "Z_BINARY_ROOT",
    }],
  });
  return resolveRecursiveClassicXrfcParameter(graph, {
    functionName: "Z_BINARY_SIBLINGS",
    parameterName: "VALUE",
    parameterClass: "I",
    associatedType: "Z_BINARY_ROOT",
    internalType: "v",
  });
}

function recursiveGraph(): RecursiveMetadataGraph {
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: FUNCTION_NAME,
      BASXML_SUPPORTED: "X",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [
      typeRow({
        typeName: "Z_ROOT",
        fieldName: "ID",
        fieldType: "INT4",
        internalType: "I",
        dataType: "INT4",
        total: 24,
        length: 4,
      }),
      typeRow({
        typeName: "Z_ROOT",
        fieldName: "CHILD",
        fieldType: "Z_CHILD",
        internalType: "u",
        componentType: "S",
        dataType: "STRU",
        total: 24,
        offset: 4,
        length: 4,
      }),
      typeRow({
        typeName: "Z_ROOT",
        fieldName: "ROWS",
        fieldType: "Z_ROW_T",
        internalType: "h",
        componentType: "T",
        dataType: "TTYP",
        total: 24,
        offset: 8,
        length: 8,
      }),
      typeRow({
        typeName: "Z_ROOT",
        fieldName: "BLOB",
        fieldType: "XSTRING",
        internalType: "y",
        dataType: "RSTR",
        total: 24,
        offset: 16,
        length: 8,
      }),
      typeRow({
        typeName: "Z_CHILD",
        fieldName: "TEXT",
        fieldType: "CHAR4",
        internalType: "C",
        total: 16,
        length: 8,
      }),
      typeRow({
        typeName: "Z_CHILD",
        fieldName: "LABEL",
        fieldType: "STRING",
        internalType: "g",
        dataType: "STRG",
        total: 16,
        offset: 8,
        length: 8,
      }),
      typeRow({
        typeName: "Z_ROW_T",
        fieldName: "",
        fieldType: "Z_ROW",
        internalType: "v",
        componentType: "S",
        dataType: "STRU",
        total: 16,
        length: 16,
      }),
      typeRow({
        typeName: "Z_ROW",
        fieldName: "COUNT",
        fieldType: "INT4",
        internalType: "I",
        dataType: "INT4",
        total: 16,
        length: 4,
      }),
      typeRow({
        typeName: "Z_ROW",
        fieldName: "DETAIL",
        fieldType: "Z_CHILD",
        internalType: "u",
        componentType: "S",
        dataType: "STRU",
        total: 16,
        offset: 4,
        length: 4,
      }),
      typeRow({
        typeName: "Z_ROW",
        fieldName: "CHUNKS",
        fieldType: "Z_CHUNK_T",
        internalType: "h",
        componentType: "T",
        dataType: "TTYP",
        total: 16,
        offset: 8,
        length: 8,
      }),
      typeRow({
        typeName: "Z_CHUNK_T",
        fieldName: "",
        fieldType: "Z_CHUNK",
        internalType: "v",
        componentType: "S",
        dataType: "STRU",
        total: 8,
        length: 8,
      }),
      typeRow({
        typeName: "Z_CHUNK",
        fieldName: "DATA",
        fieldType: "XSTRING",
        internalType: "y",
        dataType: "RSTR",
        total: 8,
        length: 8,
      }),
    ],
    INDIRECTTYPES: [],
    PARAMETERS: [
      parameterRow("INPUT", "I"),
      parameterRow("OUTPUT", "E"),
    ],
  });
}

const VALUE = Object.freeze({
  ID: 7,
  CHILD: Object.freeze({ TEXT: "A&B", LABEL: "Grüße 🌍" }),
  ROWS: Object.freeze([
    Object.freeze({
      COUNT: 1,
      DETAIL: Object.freeze({ TEXT: "ONE", LABEL: "first" }),
      CHUNKS: Object.freeze([
        Object.freeze({ DATA: Buffer.from("deadbeef", "hex") }),
      ]),
    }),
    Object.freeze({
      COUNT: -2,
      DETAIL: Object.freeze({ TEXT: "TWO", LABEL: "" }),
      CHUNKS: Object.freeze([]),
    }),
  ]),
  BLOB: Buffer.from([0, 1, 2]),
});

const EXPECTED_XML =
  "<INPUT><ID>7</ID><CHILD><TEXT>A&#38;B</TEXT><LABEL>Grüße 🌍</LABEL>" +
  "</CHILD><ROWS><item><COUNT>1</COUNT><DETAIL><TEXT>ONE</TEXT>" +
  "<LABEL>first</LABEL></DETAIL><CHUNKS><item><DATA>3q2+7w==</DATA>" +
  "</item></CHUNKS></item><item><COUNT>-2</COUNT><DETAIL><TEXT>TWO</TEXT>" +
  "<LABEL></LABEL></DETAIL><CHUNKS></CHUNKS></item></ROWS>" +
  "<BLOB>AAEC</BLOB></INPUT>";

function plan(name = "INPUT") {
  return resolveRecursiveClassicXrfcParameter(
    recursiveGraph(),
    {
      functionName: FUNCTION_NAME,
      parameterName: name,
      parameterClass: name === "INPUT" ? "I" : "E",
      associatedType: "Z_ROOT",
      internalType: "v",
    },
  );
}

function classifierParameters() {
  return [{
    functionName: FUNCTION_NAME,
    parameterName: "INPUT",
    parameterClass: "I" as const,
    associatedType: "Z_ROOT",
    internalType: "v",
  }];
}

function broadClassifierGraph(): RecursiveMetadataGraph {
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_BROAD_XRFC",
      BASXML_SUPPORTED: "X",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [typeRow({
      typeName: "Z_BROAD_ROOT",
      fieldName: "AMOUNT",
      fieldType: "FLTP",
      internalType: "F",
      dataType: "FLTP",
      total: 8,
      length: 8,
    })],
    INDIRECTTYPES: [],
    PARAMETERS: [{
      ...parameterRow("INPUT", "I"),
      FUNCNAME: "Z_BROAD_XRFC",
      TABNAME: "Z_BROAD_ROOT",
      EXID: "v",
      INTLENGTH: 8,
    }],
  });
}

function broadClassifierParameters() {
  return [{
    functionName: "Z_BROAD_XRFC",
    parameterName: "INPUT",
    parameterClass: "I" as const,
    associatedType: "Z_BROAD_ROOT",
    internalType: "v",
  }];
}

test("visits one shared wide root once per invocation parameter index", () => {
  const parameterCount = 32;
  const fieldCount = 64;
  const graph = sharedWideRootGraph(parameterCount, fieldCount);
  const index = createRecursiveMetadataParameterIndex(graph);

  for (const parameter of graph.parameters) {
    const flat = Object.freeze({
      parameterClass: "I" as const,
      parameterName: parameter.name,
      tableName: parameter.associatedType,
      fieldName: parameter.fieldPath,
      exid: parameter.internalType,
      position: parameter.position,
      offset: 0,
      internalLength: parameter.internalLength,
      decimals: parameter.decimals,
      defaultValue: parameter.defaultValue,
      parameterText: parameter.parameterText,
      optional: parameter.optional,
    });
    resolveRecursiveClassicXrfcParameterFromIndex(graph, index, {
      functionName: graph.functionIdentity!.name,
      parameterName: parameter.name,
      parameterClass: "I",
      associatedType: parameter.associatedType,
      internalType: parameter.internalType,
    });
    validateRecursiveXrfcParameterFromIndex(graph, index, flat);
  }

  assert.deepEqual(recursiveMetadataParameterIndexDiagnostics(graph, index), {
    broadClassificationNodeVisits: 1,
    broadClassificationFieldVisits: fieldCount,
    broadValidationNodeVisits: 1,
    broadValidationFieldVisits: fieldCount,
    strictDescriptorNodeVisits: fieldCount + 1,
  });
});

test("visits a large shared child once across distinct wrapper roots", () => {
  const parameterCount = 32;
  const fieldCount = 64;
  const graph = distinctWrapperSharedChildGraph(parameterCount, fieldCount);
  const index = createRecursiveMetadataParameterIndex(graph);

  for (const parameter of graph.parameters) {
    const flat = Object.freeze({
      parameterClass: "I" as const,
      parameterName: parameter.name,
      tableName: parameter.associatedType,
      fieldName: parameter.fieldPath,
      exid: parameter.internalType,
      position: parameter.position,
      offset: 0,
      internalLength: parameter.internalLength,
      decimals: parameter.decimals,
      defaultValue: parameter.defaultValue,
      parameterText: parameter.parameterText,
      optional: parameter.optional,
    });
    resolveRecursiveClassicXrfcParameterFromIndex(graph, index, {
      functionName: graph.functionIdentity!.name,
      parameterName: parameter.name,
      parameterClass: "I",
      associatedType: parameter.associatedType,
      internalType: parameter.internalType,
    });
    validateRecursiveXrfcParameterFromIndex(graph, index, flat);
  }

  assert.deepEqual(recursiveMetadataParameterIndexDiagnostics(graph, index), {
    broadClassificationNodeVisits: 0,
    broadClassificationFieldVisits: 0,
    broadValidationNodeVisits: parameterCount + 1,
    broadValidationFieldVisits: parameterCount + fieldCount,
    strictDescriptorNodeVisits: parameterCount + fieldCount + 1,
  });
});

test("reuses primed DAG subtrees without double-charging shared descendants", () => {
  const graph = primedSharedDagGraph();
  const index = createRecursiveMetadataParameterIndex(graph);
  for (const parameter of graph.parameters) {
    validateRecursiveXrfcParameterFromIndex(graph, index, Object.freeze({
      parameterClass: "I" as const,
      parameterName: parameter.name,
      tableName: parameter.associatedType,
      fieldName: parameter.fieldPath,
      exid: parameter.internalType,
      position: parameter.position,
      offset: 0,
      internalLength: parameter.internalLength,
      decimals: parameter.decimals,
      defaultValue: parameter.defaultValue,
      parameterText: parameter.parameterText,
      optional: parameter.optional,
    }));
  }
  assert.deepEqual(recursiveMetadataParameterIndexDiagnostics(graph, index), {
    broadClassificationNodeVisits: 0,
    broadClassificationFieldVisits: 0,
    broadValidationNodeVisits: 4,
    broadValidationFieldVisits: 5,
    strictDescriptorNodeVisits: 0,
  });
});

test("encodes and decodes the bounded recursive classic xRFC subset exactly", () => {
  const resolved = plan();
  assert.equal(resolved.serializer, "classic-xrfc");
  assert.equal(resolved.kind, "structure");
  assert.equal(
    encodeRecursiveClassicXrfcParameter(resolved, VALUE).toString("utf8"),
    EXPECTED_XML,
  );
  assert.deepEqual(
    decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.from(EXPECTED_XML, "utf8"),
    ),
    VALUE,
  );
});

test("constructs recursive ABAP initial values without choosing basXML", () => {
  const resolved = plan();
  assert.deepEqual(initialRecursiveClassicXrfcValue(resolved), {
    ID: 0,
    CHILD: { TEXT: "", LABEL: "" },
    ROWS: [],
    BLOB: Buffer.alloc(0),
  });
  assert.equal(recursiveGraph().functionIdentity?.remoteBasxmlSupported, true);
  assert.equal(resolved.serializer, "classic-xrfc");
  assert.equal(
    encodeRecursiveClassicXrfcParameter(resolved, {}).toString(),
    "<INPUT><ID>0</ID><CHILD><TEXT></TEXT><LABEL></LABEL></CHILD>" +
      "<ROWS></ROWS><BLOB></BLOB></INPUT>",
  );
});

test("classifies and hashes the bounded recursive graph as offline classic-xRFC", () => {
  const graph = recursiveGraph();
  const classification = classifyRecursiveSerializer({
    profile: "offline",
    graph,
    parameters: classifierParameters(),
  });
  assert.match(classification.graphSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(classification.graphSha256, recursiveMetadataGraphSha256(graph));
  assert.deepEqual(classification, {
    schemaVersion: 1,
    profile: "offline",
    graphSha256: classification.graphSha256,
    parameterCount: 1,
    parameterNames: ["INPUT"],
    remoteBasxmlSupported: true,
    selectedSerializer: "classic-xrfc",
    status: "offline",
    sendAllowed: true,
    basxmlNegotiation: "unknown",
  });
});

test("admits a broad-only recursive scalar through the exact live graph decision", () => {
  const graph = broadClassifierGraph();
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(graph, broadClassifierParameters()[0]!),
    /type F is not implemented/u,
  );
  assert.equal(
    classifyRecursiveSerializer({
      profile: "offline",
      graph,
      parameters: broadClassifierParameters(),
    }).selectedSerializer,
    "classic-xrfc",
  );
  const live = classifyRecursiveSerializer({
    profile: "abap-7.58",
    graph,
    parameters: broadClassifierParameters(),
    observation: {
      defaultSerializer: "basxml",
      basxmlDisabledSerializer: "classic-xrfc",
    },
  });
  assert.equal(
    assertRecursiveSerializerSendDecision(
      { graph, parameters: broadClassifierParameters() },
      live,
    ),
    live,
  );
});

test("requires paired release observations before admitting live classic-xRFC", () => {
  const graph = recursiveGraph();
  assert.throws(
    () => classifyRecursiveSerializer({
      profile: "abap-7.58",
      graph,
      parameters: classifierParameters(),
    }),
    /live-classification-required/u,
  );
  const classification = classifyRecursiveSerializer({
    profile: "abap-7.58",
    graph,
    parameters: classifierParameters(),
    observation: {
      defaultSerializer: "basxml",
      basxmlDisabledSerializer: "classic-xrfc",
    },
  });
  assert.equal(classification.status, "live");
  assert.equal(classification.selectedSerializer, "classic-xrfc");
  assert.equal(classification.sendAllowed, true);
  assert.equal(classification.basxmlNegotiation, "disabled");
});

test("snapshots one exact live policy and binds admission to the graph", () => {
  const source: {
    profile: "abap-7.58";
    observation: {
      defaultSerializer: "classic-xrfc" | "basxml";
      basxmlDisabledSerializer: "classic-xrfc";
    };
  } = {
    profile: "abap-7.58",
    observation: {
      defaultSerializer: "basxml",
      basxmlDisabledSerializer: "classic-xrfc",
    },
  };
  const policy = snapshotLiveRecursiveSerializerPolicy(source);
  source.observation.defaultSerializer = "classic-xrfc";
  assert.deepEqual(policy, {
    profile: "abap-7.58",
    observation: {
      defaultSerializer: "basxml",
      basxmlDisabledSerializer: "classic-xrfc",
    },
  });
  assert(Object.isFrozen(policy));
  assert(Object.isFrozen(policy.observation));
  assert.equal(
    admitLiveRecursiveSerializer(
      policy,
      recursiveGraph(),
      classifierParameters(),
    ).status,
    "live",
  );
  assert.throws(
    () => admitLiveRecursiveSerializer(
      undefined,
      recursiveGraph(),
      classifierParameters(),
    ),
    /live-policy-required/u,
  );
  assert.throws(
    () => snapshotLiveRecursiveSerializerPolicy({
      profile: "offline",
      observation: policy.observation,
    } as never),
    /live-policy/u,
  );
});

test("accepts only trusted live decisions for the exact active inventory", () => {
  const graph = recursiveGraph();
  const request = { graph, parameters: classifierParameters() };
  const live = classifyRecursiveSerializer({
    profile: "abap-7.58",
    graph,
    parameters: request.parameters,
    observation: {
      defaultSerializer: "classic-xrfc",
      basxmlDisabledSerializer: "classic-xrfc",
    },
  });
  assert.equal(assertRecursiveSerializerSendDecision(request, live), live);

  const offline = classifyRecursiveSerializer({
    profile: "offline",
    graph,
    parameters: request.parameters,
  });
  assert.throws(
    () => assertRecursiveSerializerSendDecision(request, offline),
    /offline-decision/u,
  );
  assert.throws(
    () => assertRecursiveSerializerSendDecision(
      request,
      { ...live } as typeof live,
    ),
    /untrusted-decision/u,
  );
  let proxyTraps = 0;
  const forged = new Proxy({}, {
    get() {
      proxyTraps += 1;
      throw new Error("decision proxy must not be inspected");
    },
  });
  assert.throws(
    () => assertRecursiveSerializerSendDecision(
      request,
      forged as typeof live,
    ),
    /untrusted-decision/u,
  );
  assert.equal(proxyTraps, 0);

  assert.throws(
    () => assertRecursiveSerializerSendDecision(
      {
        graph,
        parameters: [
          ...classifierParameters(),
          {
            functionName: FUNCTION_NAME,
            parameterName: "OUTPUT",
            parameterClass: "E",
            associatedType: "Z_ROOT",
            internalType: "v",
          },
        ],
      },
      live,
    ),
    /parameter-inventory-mismatch/u,
  );
});

test("blocks a graph that requires basXML instead of silently falling back", () => {
  const classification = classifyRecursiveSerializer({
    profile: "abap-7.50",
    graph: recursiveGraph(),
    parameters: classifierParameters(),
    observation: {
      defaultSerializer: "basxml",
      basxmlDisabledSerializer: "unsupported",
    },
  });
  assert.equal(classification.status, "blocked");
  assert.equal(classification.selectedSerializer, "basxml-required");
  assert.equal(classification.sendAllowed, false);
  assert.equal(classification.basxmlNegotiation, "required");
  assert.throws(
    () => admitLiveRecursiveSerializer(
      {
        profile: "abap-7.50",
        observation: {
          defaultSerializer: "basxml",
          basxmlDisabledSerializer: "unsupported",
        },
      },
      recursiveGraph(),
      classifierParameters(),
    ),
    /basxml-required/u,
  );
});

test("rejects contradictory or untrusted serializer observations", () => {
  const graph = recursiveGraph();
  assert.throws(
    () => classifyRecursiveSerializer({
      profile: "abap-7.50",
      graph,
      parameters: classifierParameters(),
      observation: {
        defaultSerializer: "classic-xrfc",
        basxmlDisabledSerializer: "unsupported",
      },
    }),
    /contradictory-classification/u,
  );
  assert.throws(
    () => classifyRecursiveSerializer({
      profile: "offline",
      graph: {} as RecursiveMetadataGraph,
      parameters: classifierParameters(),
    }),
    /untrusted-graph/u,
  );
});

test("rejects inconsistent, cyclic, and unsupported recursive descriptors", () => {
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(recursiveGraph(), {
      functionName: "Z_OTHER",
      parameterName: "INPUT",
      parameterClass: "I",
      associatedType: "Z_ROOT",
      internalType: "v",
    }),
    /identity does not match/u,
  );
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(recursiveGraph(), {
      functionName: FUNCTION_NAME,
      parameterName: "INPUT",
      parameterClass: "I",
      associatedType: "Z_OTHER",
      internalType: "v",
    }),
    /descriptor does not match/u,
  );

  const cyclic = normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_CYCLE",
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [
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
    ],
    INDIRECTTYPES: [],
    PARAMETERS: [{
      ...parameterRow("VALUE", "I"),
      FUNCNAME: "Z_CYCLE",
      TABNAME: "Z_A",
    }],
  });
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(cyclic, {
      functionName: "Z_CYCLE",
      parameterName: "VALUE",
      parameterClass: "I",
      associatedType: "Z_A",
      internalType: "v",
    }),
    /cyclic/u,
  );

  const unsupported = normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: FUNCTION_NAME,
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [typeRow({
      typeName: "Z_UNSUPPORTED",
      fieldName: "VALUE",
      fieldType: "NUMC4",
      internalType: "N",
      dataType: "NUMC",
      total: 8,
      length: 8,
    })],
    INDIRECTTYPES: [],
    PARAMETERS: [{
      ...parameterRow("INPUT", "I"),
      TABNAME: "Z_UNSUPPORTED",
      INTLENGTH: 8,
    }],
  });
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(
      unsupported,
      {
        functionName: FUNCTION_NAME,
        parameterName: "INPUT",
        parameterClass: "I",
        associatedType: "Z_UNSUPPORTED",
        internalType: "v",
      },
    ),
    /type N is not implemented/u,
  );
});

test("bounds descriptor depth/nodes and aggregate value rows/nodes/bytes", () => {
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(
      recursiveGraph(),
      {
        functionName: FUNCTION_NAME,
        parameterName: "INPUT",
        parameterClass: "I",
        associatedType: "Z_ROOT",
        internalType: "v",
      },
      { maxDepth: 2 },
    ),
    /depth exceeds 2/u,
  );
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(
      recursiveGraph(),
      {
        functionName: FUNCTION_NAME,
        parameterName: "INPUT",
        parameterClass: "I",
        associatedType: "Z_ROOT",
        internalType: "v",
      },
      { maxNodes: 4 },
    ),
    /node count exceeds 4/u,
  );
  const resolved = plan();
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, VALUE, { maxRows: 2 }),
    /row count exceeds 2/u,
  );
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, VALUE, { maxNodes: 8 }),
    /value node count exceeds 8/u,
  );
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, VALUE, { maxCellBytes: 4 }),
    /XML value exceeds 4|base64 value exceeds 4/u,
  );
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, VALUE, { maxRowBytes: 80 }),
    /XML row exceeds 80/u,
  );
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, VALUE, { maxParameterBytes: 100 }),
    /xRFC XML exceeds 100/u,
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.from(EXPECTED_XML),
      { maxRows: 2 },
    ),
    /row count exceeds 2/u,
  );

  const initialXml = encodeRecursiveClassicXrfcParameter(resolved, {});
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, {}, { maxRowBytes: 60 }),
    /XML row exceeds 60/u,
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(
      resolved,
      initialXml,
      { maxRowBytes: 60 },
    ),
    /XML row exceeds 60/u,
  );
});

test("reserves aggregate XML bytes before copying later XSTRING values", () => {
  const resolved = binarySiblingPlan();
  const originalFrom = Buffer.from;
  let threeByteSnapshots = 0;
  Object.defineProperty(Buffer, "from", {
    configurable: true,
    writable: true,
    value(value: unknown, ...argumentsValue: unknown[]) {
      if (value instanceof Uint8Array && value.byteLength === 3) {
        threeByteSnapshots += 1;
      }
      return Reflect.apply(originalFrom, Buffer, [value, ...argumentsValue]);
    },
  });
  try {
    assert.throws(
      () => encodeRecursiveClassicXrfcParameter(
        resolved,
        { LEFT: Buffer.of(1, 2, 3), RIGHT: Buffer.of(4, 5, 6) },
        { maxParameterBytes: 33 },
      ),
      /xRFC XML exceeds 33/u,
    );
  } finally {
    Object.defineProperty(Buffer, "from", {
      configurable: true,
      writable: true,
      value: originalFrom,
    });
  }
  assert.equal(threeByteSnapshots, 0);
});

test("rejects non-canonical later base64 before allocating earlier XSTRING values", () => {
  const resolved = binarySiblingPlan();
  const originalFrom = Buffer.from;
  let base64Allocations = 0;
  Object.defineProperty(Buffer, "from", {
    configurable: true,
    writable: true,
    value(value: unknown, ...argumentsValue: unknown[]) {
      if (typeof value === "string" && argumentsValue[0] === "base64") {
        base64Allocations += 1;
      }
      return Reflect.apply(originalFrom, Buffer, [value, ...argumentsValue]);
    },
  });
  try {
    for (const invalid of ["AB==", "AAB="]) {
      assert.throws(
        () => decodeRecursiveClassicXrfcParameter(
          resolved,
          Buffer.from(
            `<VALUE><LEFT>AA==</LEFT><RIGHT>${invalid}</RIGHT></VALUE>`,
          ),
        ),
        /non-canonical base64/u,
      );
    }
  } finally {
    Object.defineProperty(Buffer, "from", {
      configurable: true,
      writable: true,
      value: originalFrom,
    });
  }
  assert.equal(base64Allocations, 0);
});

test("decodes MIME-wrapped recursive classic XSTRING cells", () => {
  const resolved = binarySiblingPlan();
  const payload = Buffer.alloc(256);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 29) & 0xff;
  }
  const wrapped = payload.toString("base64").match(/.{1,76}/gu)!.join("\n");
  assert.deepEqual(
    decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.from(`<VALUE><LEFT>${wrapped}</LEFT><RIGHT>AA==</RIGHT></VALUE>`),
    ),
    { LEFT: payload, RIGHT: Buffer.from([0]) },
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.from(
        `<VALUE><LEFT>${wrapped.replaceAll("\n", " ")}</LEFT>` +
          "<RIGHT>AA==</RIGHT></VALUE>",
      ),
    ),
    /non-canonical base64/u,
  );
});

test("rejects unknown/accessor values and hostile or non-canonical XML", () => {
  const resolved = plan();
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, { ...VALUE, UNKNOWN: 1 }),
    /unknown field UNKNOWN/u,
  );
  const accessor = { ...VALUE } as Record<string, unknown>;
  Object.defineProperty(accessor, "ID", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, accessor),
    /must be an own data property/u,
  );

  for (const xml of [
    `<?xml version="1.0"?>${EXPECTED_XML}`,
    `<!DOCTYPE INPUT>${EXPECTED_XML}`,
    EXPECTED_XML.replace("<INPUT>", '<INPUT attr="x">'),
    EXPECTED_XML.replace("A&#38;B", "]]>"),
    EXPECTED_XML.replace("A&#38;B", "A&#xD800;B"),
    EXPECTED_XML.replace("<ID>7</ID>", "<ID>7</ID><ID>8</ID>"),
    EXPECTED_XML.replace("<ID>7</ID>", ""),
    EXPECTED_XML.replace("<ID>7</ID><CHILD>", "<CHILD><ID>7</ID>"),
    EXPECTED_XML.replace("3q2+7w==", "3q2+7w"),
    `${EXPECTED_XML}trailing`,
  ]) {
    assert.throws(
      () => decodeRecursiveClassicXrfcParameter(resolved, Buffer.from(xml)),
    );
  }
  // A conforming peer may escape "&" the way the XML specification mandates.
  assert.deepEqual(
    decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.from(EXPECTED_XML.replace("A&#38;B", "A&amp;B")),
    ),
    decodeRecursiveClassicXrfcParameter(resolved, Buffer.from(EXPECTED_XML)),
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(EXPECTED_XML)]),
    ),
    /must not contain a UTF-8 BOM/u,
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(resolved, Buffer.from([0xff])),
    /encoded data was not valid/u,
  );
});

test("rejects proxy, symbol, prototype, non-enumerable, and exotic array inputs", () => {
  const resolved = plan();
  const trapped = new Proxy({ ...VALUE }, {
    ownKeys() {
      throw new Error("must not invoke proxy traps");
    },
  });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, trapped),
    /proxy/u,
  );

  let prototypeTraps = 0;
  const hostilePrototype = new Proxy({}, {
    getPrototypeOf() {
      prototypeTraps += 1;
      throw new Error("must not execute");
    },
  });
  const hostileBytes = Object.create(hostilePrototype) as Uint8Array;
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(
      resolved,
      { ...VALUE, BLOB: hostileBytes },
    ),
    /expects Uint8Array bytes/u,
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(resolved, hostileBytes),
    /must be Uint8Array bytes/u,
  );
  assert.equal(prototypeTraps, 0);

  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, {
      ...VALUE,
      [Symbol("hidden")]: true,
    }),
    /symbol/u,
  );

  const foreignPrototype = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    VALUE,
  );
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, foreignPrototype),
    /prototype/u,
  );

  const nonEnumerable = { ...VALUE } as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, "HIDDEN", {
    value: true,
    enumerable: false,
  });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, nonEnumerable),
    /unknown field HIDDEN/u,
  );

  const rows = [...VALUE.ROWS] as unknown[] & Record<string, unknown>;
  rows["01"] = VALUE.ROWS[0];
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, { ...VALUE, ROWS: rows }),
    /unknown array property 01/u,
  );

  const symbolRows = [...VALUE.ROWS];
  Object.defineProperty(symbolRows, Symbol("hidden"), { value: true });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, {
      ...VALUE,
      ROWS: symbolRows,
    }),
    /symbol/u,
  );

  const accessorRows = [...VALUE.ROWS];
  Object.defineProperty(accessorRows, "0", {
    enumerable: true,
    get() {
      throw new Error("must not execute array accessors");
    },
  });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, {
      ...VALUE,
      ROWS: accessorRows,
    }),
    /must be an own data property/u,
  );

  const rowProxy = new Proxy([...VALUE.ROWS], {
    getOwnPropertyDescriptor() {
      throw new Error("must not invoke proxy traps");
    },
  });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(resolved, {
      ...VALUE,
      ROWS: rowProxy,
    }),
    /proxy/u,
  );

  const boundedBeforeInspection: unknown[] = [];
  Object.defineProperty(boundedBeforeInspection, "0", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("must enforce row bounds before inspecting entries");
    },
  });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(
      resolved,
      { ...VALUE, ROWS: boundedBeforeInspection },
      { maxRows: 0 },
    ),
    /row count exceeds 0/u,
  );
});

test("requires trusted normalized metadata and internally resolved plans", () => {
  const graph = recursiveGraph();
  assert.throws(
    () => resolveRecursiveClassicXrfcParameter(
      Object.freeze({ ...graph }) as RecursiveMetadataGraph,
      {
        functionName: FUNCTION_NAME,
        parameterName: "INPUT",
        parameterClass: "I",
        associatedType: "Z_ROOT",
        internalType: "v",
      },
    ),
    /normalized recursive metadata graph/u,
  );

  const resolved = plan();
  const forged = Object.freeze({ ...resolved });
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(forged, VALUE),
    /returned by resolveRecursiveClassicXrfcParameter/u,
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(forged, Buffer.from(EXPECTED_XML)),
    /returned by resolveRecursiveClassicXrfcParameter/u,
  );
  assert.throws(
    () => initialRecursiveClassicXrfcValue(forged),
    /returned by resolveRecursiveClassicXrfcParameter/u,
  );
});

test("constructs __proto__ fields as own data without prototype mutation", () => {
  const graph = normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_PROTO_XRFC",
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "123456",
    }],
    DATATYPESCONT: [typeRow({
      typeName: "Z_PROTO_ROOT",
      fieldName: "__proto__",
      fieldType: "INT4",
      internalType: "I",
      dataType: "INT4",
      total: 4,
      length: 4,
    })],
    INDIRECTTYPES: [],
    PARAMETERS: [{
      ...parameterRow("VALUE", "I"),
      FUNCNAME: "Z_PROTO_XRFC",
      TABNAME: "Z_PROTO_ROOT",
      INTLENGTH: 4,
    }],
  });
  const resolved = resolveRecursiveClassicXrfcParameter(graph, {
    functionName: "Z_PROTO_XRFC",
    parameterName: "VALUE",
    parameterClass: "I",
    associatedType: "Z_PROTO_ROOT",
    internalType: "v",
  });

  const initial = initialRecursiveClassicXrfcValue(resolved);
  const decoded = decodeRecursiveClassicXrfcParameter(
    resolved,
    Buffer.from("<VALUE><__proto__>7</__proto__></VALUE>"),
  );
  for (const [value, expected] of [[initial, 0], [decoded, 7]] as const) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(value, "__proto__"), {
      value: expected,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);
});

test("uses encoded base64 cell limits symmetrically", () => {
  const resolved = plan();
  const threeBytes = {
    ID: 0,
    CHILD: { TEXT: "", LABEL: "" },
    ROWS: [],
    BLOB: Buffer.from([1, 2, 3]),
  };
  const encoded = encodeRecursiveClassicXrfcParameter(
    resolved,
    threeBytes,
    { maxCellBytes: 4 },
  );
  assert.deepEqual(
    decodeRecursiveClassicXrfcParameter(
      resolved,
      encoded,
      { maxCellBytes: 4 },
    ),
    threeBytes,
  );

  const fourBytes = { ...threeBytes, BLOB: Buffer.from([1, 2, 3, 4]) };
  assert.throws(
    () => encodeRecursiveClassicXrfcParameter(
      resolved,
      fourBytes,
      { maxCellBytes: 4 },
    ),
    /base64 value exceeds 4 encoded bytes/u,
  );
  assert.throws(
    () => decodeRecursiveClassicXrfcParameter(
      resolved,
      Buffer.from(
        "<INPUT><ID>0</ID><CHILD><TEXT></TEXT><LABEL></LABEL></CHILD>" +
          "<ROWS></ROWS><BLOB>AQIDBA==</BLOB></INPUT>",
      ),
      { maxCellBytes: 4 },
    ),
    /XML value exceeds 4 encoded bytes|decoded bytes exceed 3/u,
  );
});
