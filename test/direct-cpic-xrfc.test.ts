import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectCpicPreWireError,
  DirectCpicSession,
} from "../src/client/direct-cpic-session.js";
import {
  RfcCoreError,
  RfcFailureCategory,
} from "../src/client/rfc-failure.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import {
  RecursiveMetadataError,
  normalizeRecursiveMetadataGraph,
} from
  "../src/metadata/recursive-metadata.js";
import type { RfcStructureDefinition } from "../src/metadata/rfc-structure-definition.js";
import { classifyRecursiveSerializer } from
  "../src/values/recursive-serializer-classification.js";
import { CpicTag, type CpicField } from "../src/protocol/cpic.js";
import { encodePackedDecimal } from "../src/values/packed-decimal.js";
import { ClassicBcdConversionError } from "../src/values/classic-bcd.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

const metadata: RfcFunctionInterface = Object.freeze({
  name: "Z_XRFC_DIRECT",
  remoteBasxmlSupported: false,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([
    Object.freeze({
      parameterClass: "E",
      parameterName: "OUT",
      tableName: "Z_DEEP_T",
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
      parameterClass: "I",
      parameterName: "IN",
      tableName: "Z_DEEP_T",
      fieldName: "",
      exid: "h",
      position: 2,
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

const line: RfcStructureDefinition = Object.freeze({
  name: "Z_DEEP",
  byteLength: 16,
  fields: Object.freeze([
    Object.freeze({ tableName: "Z_DEEP", fieldName: "STR", position: 1, offset: 0, internalLength: 8, decimals: 0, exid: "g" }),
    Object.freeze({ tableName: "Z_DEEP", fieldName: "XSTR", position: 2, offset: 8, internalLength: 8, decimals: 0, exid: "y" }),
  ]),
});

const structures = new Map([["Z_DEEP_T", line]]);

const graph = normalizeRecursiveMetadataGraph({
  FUNCTIONNAMES: [{
    FUNCTIONNAME: metadata.name,
    BASXML_SUPPORTED: "",
    UDAT: "20260716",
    UTIME: "010203",
  }],
  DATATYPESCONT: [
    {
      TYPENAME: "Z_DEEP_T", FIELDNAME: "", COMPTYPE: "S",
      FIELDTYPE: "Z_DEEP", DATATYPE: "STRU", TABLENGTH: 16,
      TABLENGTH_UC: 16, DESCRIPTION: "", DECIMALS: 0, INTTYPE: "v",
      OFFSET: 0, OFFSET_UC: 0, INTLEN: 16, INTLEN_UC: 16,
      TIMESTAMP: "20260716010203",
    },
    {
      TYPENAME: "Z_DEEP", FIELDNAME: "STR", COMPTYPE: "E",
      FIELDTYPE: "STRING", DATATYPE: "STRG", TABLENGTH: 16,
      TABLENGTH_UC: 16, DESCRIPTION: "", DECIMALS: 0, INTTYPE: "g",
      OFFSET: 0, OFFSET_UC: 0, INTLEN: 8, INTLEN_UC: 8,
      TIMESTAMP: "20260716010203",
    },
    {
      TYPENAME: "Z_DEEP", FIELDNAME: "XSTR", COMPTYPE: "E",
      FIELDTYPE: "XSTRING", DATATYPE: "RSTR", TABLENGTH: 16,
      TABLENGTH_UC: 16, DESCRIPTION: "", DECIMALS: 0, INTTYPE: "y",
      OFFSET: 8, OFFSET_UC: 8, INTLEN: 8, INTLEN_UC: 8,
      TIMESTAMP: "20260716010203",
    },
  ],
  INDIRECTTYPES: [],
  PARAMETERS: metadata.parameters.map((parameter) => ({
    FUNCNAME: metadata.name,
    PARAMCLASS: parameter.parameterClass,
    PARAMETER: parameter.parameterName,
    TABNAME: parameter.tableName,
    FIELDNAME: "",
    EXID: "h",
    POSITION: parameter.position,
    OFFSET: 0,
    INTLENGTH: parameter.internalLength,
    DECIMALS: parameter.decimals,
    DEFAULT: parameter.defaultValue,
    PARAMTEXT: parameter.parameterText,
    OPTIONAL: "",
  })),
});

const deepStructureMetadata: RfcFunctionInterface = Object.freeze({
  ...metadata,
  name: "Z_XRFC_DEEP_STRUCTURE",
  parameters: Object.freeze([
    Object.freeze({
      ...metadata.parameters[0]!,
      parameterName: "OUT",
      tableName: "Z_DEEP",
      exid: "v",
    }),
    Object.freeze({
      ...metadata.parameters[1]!,
      parameterName: "IN",
      tableName: "Z_DEEP",
      exid: "v",
    }),
  ]),
});

const deepStructureGraph = normalizeRecursiveMetadataGraph({
  FUNCTIONNAMES: [{
    FUNCTIONNAME: deepStructureMetadata.name,
    BASXML_SUPPORTED: "",
    UDAT: "20260716",
    UTIME: "010204",
  }],
  DATATYPESCONT: [
    {
      TYPENAME: "Z_DEEP", FIELDNAME: "STR", COMPTYPE: "E",
      FIELDTYPE: "STRING", DATATYPE: "STRG", TABLENGTH: 16,
      TABLENGTH_UC: 16, DESCRIPTION: "", DECIMALS: 0, INTTYPE: "g",
      OFFSET: 0, OFFSET_UC: 0, INTLEN: 8, INTLEN_UC: 8,
      TIMESTAMP: "20260716010204",
    },
    {
      TYPENAME: "Z_DEEP", FIELDNAME: "XSTR", COMPTYPE: "E",
      FIELDTYPE: "XSTRING", DATATYPE: "RSTR", TABLENGTH: 16,
      TABLENGTH_UC: 16, DESCRIPTION: "", DECIMALS: 0, INTTYPE: "y",
      OFFSET: 8, OFFSET_UC: 8, INTLEN: 8, INTLEN_UC: 8,
      TIMESTAMP: "20260716010204",
    },
  ],
  INDIRECTTYPES: [],
  PARAMETERS: deepStructureMetadata.parameters.map((parameter) => ({
    FUNCNAME: deepStructureMetadata.name,
    PARAMCLASS: parameter.parameterClass,
    PARAMETER: parameter.parameterName,
    TABNAME: parameter.tableName,
    FIELDNAME: "",
    EXID: "v",
    POSITION: parameter.position,
    OFFSET: 0,
    INTLENGTH: parameter.internalLength,
    DECIMALS: parameter.decimals,
    DEFAULT: parameter.defaultValue,
    PARAMTEXT: parameter.parameterText,
    OPTIONAL: "",
  })),
});

function deepFields(xml: string): readonly CpicField[] {
  const controls = successfulRegularFields();
  return [
    ...controls.slice(0, -1),
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    { tag: CpicTag.XRfcData, value: Buffer.from(xml) },
    { tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) },
    controls.at(-1)!,
  ];
}

const decimalMetadata: RfcFunctionInterface = Object.freeze({
  name: "Z_DECIMAL_OUTPUT",
  remoteBasxmlSupported: false,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([Object.freeze({
    parameterClass: "E",
    parameterName: "AMOUNT",
    tableName: "",
    fieldName: "",
    exid: "P",
    position: 1,
    offset: 0,
    internalLength: 4,
    decimals: 2,
    defaultValue: "",
    parameterText: "",
    optional: false,
  })]),
  exceptions: Object.freeze([]),
  resumableExceptionRowCount: 0,
});

function decimalFields(): readonly CpicField[] {
  const controls = successfulRegularFields();
  return [
    ...controls.slice(0, -1),
    { tag: CpicTag.ParameterName, value: Buffer.from("AMOUNT", "utf16le") },
    { tag: CpicTag.ParameterValue, value: encodePackedDecimal("12.34", 4, 2) },
    controls.at(-1)!,
  ];
}

async function authenticated(peer: ScriptedRfcPeer): Promise<DirectCpicSession> {
  return authenticatedWithSerializer(peer, "qualified");
}

async function authenticatedWithSerializer(
  peer: ScriptedRfcPeer,
  policy: "qualified" | "missing" | "basxml-required",
  onDecision?: (parameterNames: readonly string[]) => void,
  language = "E",
): Promise<DirectCpicSession> {
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerHost: "application.example.test",
    applicationServerService: "sapdp00",
    programName: "open-rfc-xrfc-test",
    operationTimeoutMs: 1_000,
    ...(policy === "missing"
      ? {}
      : {
          recursiveSerializerDecisionProvider: ({ graph, parameters }) =>
            {
              onDecision?.(parameters.map(({ parameterName }) => parameterName));
              return classifyRecursiveSerializer({
                profile: "abap-7.58",
                graph,
                parameters,
                observation: policy === "qualified"
                  ? {
                      defaultSerializer: "basxml",
                      basxmlDisabledSerializer: "classic-xrfc",
                    }
                  : {
                      defaultSerializer: "basxml",
                      basxmlDisabledSerializer: "unsupported",
                    },
              });
            },
        }),
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: ["not-a-real", "password"].join("-"),
    language,
  });
  return session;
}

function installRecursiveMetadataDoubles(session: DirectCpicSession): void {
  Object.defineProperties(session, {
    getFunctionInterface: {
      value: async () => metadata,
    },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async () => ({
        value: graph,
        generationToken: graph.functionIdentity!.generationToken,
      }),
    },
  });
}

test("direct session decodes xRFC XML and remains reusable", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      {
        kind: "fields",
        fields: deepFields(
          "<OUT><item><STR>Grüße 🌍</STR><XSTR>AP8=</XSTR></item></OUT>",
        ),
      },
      { kind: "fields", fields: successfulRegularFields() },
    ],
  }]);
  t.after(() => peer.close());
  let decisionCalls = 0;
  const session = await authenticatedWithSerializer(
    peer,
    "qualified",
    (parameterNames) => {
      decisionCalls += 1;
      assert.deepEqual(parameterNames, ["OUT", "IN"]);
    },
    "D",
  );
  t.after(() => session.close());
  let flatLookups = 0;
  let recursiveLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: {
      value: async (functionName: string) => {
        flatLookups += 1;
        assert.equal(functionName, metadata.name);
        return metadata;
      },
    },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async (functionName: string, language: string) => {
        recursiveLookups += 1;
        assert.equal(functionName, metadata.name);
        assert.equal(language, "D");
        return {
          value: graph,
          generationToken: graph.functionIdentity!.generationToken,
        };
      },
    },
  });

  assert.deepEqual(
    await session.invokeClassic(
      metadata.name,
      { IN: [{ STR: "request", XSTR: Buffer.of(0, 0xff) }] },
    ),
    { OUT: [{ STR: "Grüße 🌍", XSTR: Buffer.of(0, 0xff) }] },
  );
  assert.equal(flatLookups, 1);
  assert.equal(recursiveLookups, 1);
  assert.equal(decisionCalls, 1);
  assert.equal(session.state, "authenticated");
  await session.ping();
  assert.equal(peer.regularRequestCount(0), 2);
});

test("direct session blocks an unclassified recursive send before exchange", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await authenticatedWithSerializer(peer, "missing");
  t.after(() => session.close());
  installRecursiveMetadataDoubles(session);

  await assert.rejects(
    session.invokeClassic(metadata.name, { IN: [] }),
    /live-decision-required/u,
  );
  assert.equal(peer.regularRequestCount(0), 0);
  assert.equal(session.state, "authenticated");
  await session.ping();
  assert.equal(peer.regularRequestCount(0), 1);
});

test("direct session blocks basXML-required recursive sends before exchange", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await authenticatedWithSerializer(peer, "basxml-required");
  t.after(() => session.close());
  installRecursiveMetadataDoubles(session);

  await assert.rejects(
    session.invokeClassic(metadata.name, { IN: [] }),
    /basxml-required/u,
  );
  assert.equal(peer.regularRequestCount(0), 0);
  assert.equal(session.state, "authenticated");
  await session.ping();
  assert.equal(peer.regularRequestCount(0), 1);
});

test("direct session skips recursive metadata for deactivated deep parameters", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());
  let recursiveLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: {
      value: async () => metadata,
    },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async () => {
        recursiveLookups += 1;
        throw new Error("deactivated recursive metadata must not be fetched");
      },
    },
  });

  assert.deepEqual(
    await session.invokeClassic(
      metadata.name,
      {},
      undefined,
      { deactivated: new Set(["IN", "OUT"]) },
    ),
    { OUT: [] },
  );
  assert.equal(recursiveLookups, 0);
  assert.equal(peer.regularRequestCount(0), 1);
});

test("deactivated classic structure output retains its metadata-shaped initial value", async (t) => {
  const flatOutput: RfcFunctionInterface = Object.freeze({
    ...metadata,
    name: "Z_DEACTIVATED_FLAT_OUTPUT",
    parameters: Object.freeze([
      Object.freeze({
        ...metadata.parameters[0]!,
        parameterName: "OUT",
        tableName: "Z_FLAT_ROW",
        exid: "u",
        internalLength: 4,
      }),
    ]),
  });
  const flatRow: RfcStructureDefinition = Object.freeze({
    name: "Z_FLAT_ROW",
    byteLength: 4,
    fields: Object.freeze([
      Object.freeze({
        tableName: "Z_FLAT_ROW",
        fieldName: "COUNT",
        position: 1,
        offset: 0,
        internalLength: 4,
        decimals: 0,
        exid: "I",
      }),
    ]),
  });
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());
  let recursiveLookups = 0;
  let structureLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: { value: async () => flatOutput },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async () => {
        recursiveLookups += 1;
        throw new Error("deactivated flat output must not fetch recursive metadata");
      },
    },
    getStructureDefinition: {
      value: async (name: string) => {
        structureLookups += 1;
        assert.equal(name, "Z_FLAT_ROW");
        return flatRow;
      },
    },
  });

  assert.deepEqual(
    await session.invokeClassic(
      flatOutput.name,
      {},
      undefined,
      { deactivated: new Set(["OUT"]) },
    ),
    { OUT: { COUNT: 0 } },
  );
  assert.equal(recursiveLookups, 0);
  assert.equal(structureLookups, 1);
  assert.equal(peer.regularRequestCount(0), 1);
});

test("direct public invocation carries qualified deep-structure v metadata", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{
      kind: "fields",
      fields: deepFields(
        "<OUT><STR>response</STR><XSTR>qg==</XSTR></OUT>",
      ),
    }],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());
  let recursiveLookups = 0;
  let flatStructureLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: {
      value: async () => deepStructureMetadata,
    },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async () => {
        recursiveLookups += 1;
        return {
          value: deepStructureGraph,
          generationToken: deepStructureGraph.functionIdentity!.generationToken,
        };
      },
    },
    getStructureDefinition: {
      value: async () => {
        flatStructureLookups += 1;
        throw new Error("deep v must not use the flat structure repository");
      },
    },
  });

  assert.deepEqual(
    await session.invokeClassic(deepStructureMetadata.name, {
      IN: { STR: "request", XSTR: Buffer.of(0, 0xff) },
    }),
    { OUT: { STR: "response", XSTR: Buffer.of(0xaa) } },
  );
  assert.equal(recursiveLookups, 1);
  assert.equal(flatStructureLookups, 0);
  assert.equal(session.state, "authenticated");
});

test("suppressed recursive outputs perform no recursive metadata I/O", async (t) => {
  const optionalOutputs: RfcFunctionInterface = Object.freeze({
    ...deepStructureMetadata,
    name: "Z_SUPPRESSED_RECURSIVE",
    parameters: Object.freeze([
      Object.freeze({
        ...deepStructureMetadata.parameters[0]!,
        parameterName: "OUT_V",
        optional: true,
      }),
      Object.freeze({
        ...metadata.parameters[0]!,
        parameterName: "OUT_H",
        optional: true,
      }),
    ]),
  });
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());
  let recursiveLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: { value: async () => optionalOutputs },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async () => {
        recursiveLookups += 1;
        throw new Error("suppressed output must not load recursive metadata");
      },
    },
    getStructureDefinition: {
      value: async () => {
        throw new Error("suppressed output must not load flat metadata");
      },
    },
  });

  assert.deepEqual(
    await session.invokeClassic(
      optionalOutputs.name,
      {},
      undefined,
      {
        notRequested: new Set(["OUT_V"]),
        deactivated: new Set(["OUT_H"]),
      },
    ),
    { OUT_V: {}, OUT_H: [] },
  );
  assert.equal(recursiveLookups, 0);
  assert.equal(peer.regularRequestCount(0), 1);
  assert.equal(session.state, "authenticated");
});

test("flat structures fall back when an unrelated optimized DDIC closure is incomplete", async (t) => {
  const flatMetadata: RfcFunctionInterface = Object.freeze({
    ...metadata,
    name: "Z_OPTIONAL_FLAT_FALLBACK",
    parameters: Object.freeze([Object.freeze({
      ...metadata.parameters[1]!,
      parameterName: "IN",
      tableName: "Z_OPTIONAL_FLAT_ROW",
      exid: "u",
      internalLength: 4,
    })]),
  });
  const flatDefinition: RfcStructureDefinition = Object.freeze({
    name: "Z_OPTIONAL_FLAT_ROW",
    byteLength: 4,
    fields: Object.freeze([Object.freeze({
      tableName: "Z_OPTIONAL_FLAT_ROW",
      fieldName: "VALUE",
      position: 1,
      offset: 0,
      internalLength: 4,
      decimals: 0,
      exid: "I",
    })]),
  });
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());
  let optimizedLookups = 0;
  let flatLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: { value: async () => flatMetadata },
    getOptimizedRecursiveFunctionDescriptor: {
      value: async () => {
        optimizedLookups += 1;
        throw new RecursiveMetadataError(
          "REMOTE_DDIC_RESOLUTION_ERRORS",
          "DD_ERRORS:1",
        );
      },
    },
    getStructureDefinition: {
      value: async () => {
        flatLookups += 1;
        return flatDefinition;
      },
    },
  });

  assert.deepEqual(
    await session.invokeClassic(flatMetadata.name, { IN: { VALUE: 42 } }),
    {},
  );
  assert.equal(optimizedLookups, 1);
  assert.equal(flatLookups, 1);
  assert.equal(peer.regularRequestCount(0), 1);
  assert.equal(session.state, "authenticated");
});

test("malformed xRFC response becomes a value failure and closes generation", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      {
        kind: "fields",
        fields: deepFields(
          "<OUT><item><STR>truncated</STR><XSTR>AA==</XSTR></OUT>",
        ),
      },
    ],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);

  await assert.rejects(
    session.invokeClassicWithMetadata(
      metadata,
      { IN: [] },
      structures,
    ),
    (error: unknown) =>
      error instanceof RfcCoreError &&
      error.failure.category === RfcFailureCategory.MalformedProtocol &&
      error.failure.reasonCode === "RFC_RESPONSE_VALUE_MALFORMED",
  );
  assert.equal(session.state, "closed");
  await assert.rejects(session.ping(), /must be authenticated/u);
  assert.equal(peer.regularRequestCount(0), 1);
});

test("caller BCD converter failure leaves the fully consumed session reusable", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      { kind: "fields", fields: decimalFields() },
      { kind: "fields", fields: successfulRegularFields() },
    ],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());
  const original = new Error("caller converter failed");

  await assert.rejects(
    session.invokeClassicWithMetadata(
      decimalMetadata,
      {},
      new Map(),
      undefined,
      {
        bcd() {
          throw original;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ClassicBcdConversionError && error.cause === original,
  );
  assert.equal(session.state, "authenticated");
  await session.ping();
  assert.equal(peer.regularRequestCount(0), 2);
});

test("invalid deep input is rejected before exchange and leaves session reusable", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      { kind: "fields", fields: successfulRegularFields() },
    ],
  }]);
  t.after(() => peer.close());
  const session = await authenticated(peer);
  t.after(() => session.close());

  await assert.rejects(
    session.invokeClassicWithMetadata(
      metadata,
      { IN: [{ STR: "too large", XSTR: Buffer.alloc(0) }] },
      structures,
      undefined,
      { maxApplicationDataLength: 1 },
    ),
    (error: unknown) =>
      error instanceof DirectCpicPreWireError &&
      /application length exceeds configured limit 1/u.test(error.message),
  );
  assert.equal(peer.regularRequestCount(0), 0);
  assert.equal(session.state, "authenticated");
  await session.ping();
  assert.equal(peer.regularRequestCount(0), 1);
});
