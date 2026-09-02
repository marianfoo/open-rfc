import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  CpicCallError,
  CpicLogonError,
  DirectCpicPreWireError,
} from "../src/client/direct-cpic-session.js";
import {
  RFCError,
  RFCErrorCode,
} from "../src/client/rfc-errors.js";
import {
  RfcConnectionDisposition,
  RfcFailureCategory,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcTransmissionState,
  RfcCoreError,
  createRfcFailure,
} from "../src/client/rfc-failure.js";
import {
  Client,
  bindClientDestinationOwnerFactory,
  cancelClient,
  environment,
  pooledClientAttach,
  pooledClientClaim,
  projectNodeRfcNormalizationError,
  projectNodeRfcPublicError,
  snapshotRfcClientOptions,
  type RfcClientOptions,
} from "../src/compat/node-rfc-client.js";
import { Pool } from "../src/compat/node-rfc-pool.js";
import {
  DirectDestinationMetadataPreflightError,
  type DirectDestinationApplicationLease,
  type DirectDestinationOwner,
} from "../src/destination/direct-destination-owner.js";
import { NiTransportError } from "../src/transport/ni-socket.js";
import {
  SapRouterTransportError,
  type SapRouterTransportErrorCode,
} from "../src/transport/saprouter-tunnel.js";
import { ClassicBcdConversionError } from "../src/values/classic-bcd.js";
import {
  CpicTag,
  decodeCpicInitialLogonResponse,
  encodeCpicFieldChain,
} from "../src/protocol/cpic.js";

const parameters = Object.freeze({
  ashost: "application.example.invalid",
  sysnr: "00",
  client: "100",
  user: "fixture-user",
  passwd: ["fixture", "password"].join("-"),
});

const INITIAL_CPIC_LOGON_STRUCTURE_ASSERTION = Symbol.for(
  "open-rfc.initial-cpic-logon-structure/v1",
);
const INITIAL_CPIC_LOGON_PUBLIC_ERROR_PROJECTOR = Symbol.for(
  "open-rfc.internal.initial-cpic-logon-public-error-projector/v1",
);

function malformedInitialLogonDiagnostic(): object {
  const response = Buffer.concat([
    Buffer.from("010100080101010504010003", "hex"),
    encodeCpicFieldChain(CpicTag.Start, [
      { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: 0x0450, value: Buffer.alloc(5) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  try {
    decodeCpicInitialLogonResponse(response);
  } catch (error) {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return error as object;
  }
  throw new Error("expected malformed initial-logon response");
}

test("redacts compatibility credentials from JSON and diagnostic inspection", () => {
  const client = new Client(parameters);
  const pool = new Pool({
    connectionParameters: parameters,
    poolOptions: { low: 0, high: 1 },
  });

  for (const value of [
    client.config,
    pool.config,
    pool.connectionParameters,
    pool.poolConfiguration,
  ]) {
    assert.equal(JSON.stringify(value).includes(["fixture", "password"].join("-")), false);
    assert.equal(inspect(value).includes(["fixture", "password"].join("-")), false);
  }
  assert.equal(client.config.connectionParameters.passwd, ["fixture", "password"].join("-"));
  assert.equal(pool.connectionParameters.passwd, ["fixture", "password"].join("-"));
});

test("projects low-level client failures into the stable node-rfc error surface", () => {
  const publicError = new RFCError("public", {
    group: 5,
    code: RFCErrorCode.RFC_INVALID_PARAMETER,
    codeString: "RFC_INVALID_PARAMETER",
    key: "PUBLIC",
  });
  assert.equal(projectNodeRfcPublicError(publicError), publicError);
  assert.equal(projectNodeRfcPublicError("opaque"), "opaque");

  const logon = projectNodeRfcPublicError(new CpicLogonError(7));
  assert.equal(logon instanceof RFCError, true);
  assert.deepEqual(
    {
      code: (logon as RFCError).code,
      codeString: (logon as RFCError).codeString,
      key: (logon as RFCError).key,
    },
    {
      code: RFCErrorCode.RFC_LOGON_FAILURE,
      codeString: "RFC_LOGON_FAILURE",
      key: "RFC_LOGON_FAILURE",
    },
  );

  const call = projectNodeRfcPublicError(
    new DirectDestinationMetadataPreflightError(
      "Z_FAILURE",
      new CpicCallError(8),
    ),
  );
  assert.equal(call instanceof RFCError, true);
  assert.deepEqual(
    {
      code: (call as RFCError).code,
      codeString: (call as RFCError).codeString,
      key: (call as RFCError).key,
    },
    {
      code: RFCErrorCode.RFC_ABAP_RUNTIME_FAILURE,
      codeString: "RFC_ABAP_RUNTIME_FAILURE",
      key: "CPIC_STATUS_8",
    },
  );

  const preWire = new RFCError("already projected", {
    group: 5,
    code: RFCErrorCode.RFC_SERIALIZATION_FAILURE,
    codeString: "RFC_SERIALIZATION_FAILURE",
    key: "RFC_SERIALIZATION_FAILURE",
  });
  assert.equal(
    projectNodeRfcPublicError(new DirectCpicPreWireError(preWire)),
    preWire,
  );

  for (const [code, expected, expectedKey] of [
    ["NI_ABORTED", RFCErrorCode.RFC_CANCELED, "RFC_CANCELED"],
    ["NI_CONNECT_TIMEOUT", RFCErrorCode.RFC_TIMEOUT, "NI_CONNECT_TIMEOUT"],
    ["NI_RECEIVE_TIMEOUT", RFCErrorCode.RFC_TIMEOUT, "NI_RECEIVE_TIMEOUT"],
    [
      "NI_WRITE_FAILED",
      RFCErrorCode.RFC_COMMUNICATION_FAILURE,
      "NI_WRITE_FAILED",
    ],
  ] as const) {
    const projected = projectNodeRfcPublicError(
      new NiTransportError(code, `transport ${code}`),
    );
    assert.equal(projected instanceof RFCError, true);
    assert.equal((projected as RFCError).code, expected);
    assert.equal((projected as RFCError).key, expectedKey);
  }
});

test("projects every SAProuter failure without copying private transport detail", () => {
  const expected: Record<SapRouterTransportErrorCode, RFCErrorCode> = {
    SAPROUTER_ABORTED: RFCErrorCode.RFC_CANCELED,
    SAPROUTER_CONNECT_FAILED: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
    SAPROUTER_CONNECT_TIMEOUT: RFCErrorCode.RFC_TIMEOUT,
    SAPROUTER_CONNECTION_CLOSED: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
    SAPROUTER_HANDSHAKE_TIMEOUT: RFCErrorCode.RFC_TIMEOUT,
    SAPROUTER_PROTOCOL_ERROR: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
    SAPROUTER_ROUTE_DENIED: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
    SAPROUTER_ROUTE_REJECTED: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
    SAPROUTER_UNSUPPORTED_SERVICE: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
    SAPROUTER_WRITE_FAILED: RFCErrorCode.RFC_COMMUNICATION_FAILURE,
  };
  const privateMarker = "PRIVATE_ROUTER_DETAIL";
  for (const [code, expectedCode] of Object.entries(expected) as
    Array<[SapRouterTransportErrorCode, RFCErrorCode]>) {
    const projected = projectNodeRfcPublicError(new SapRouterTransportError(
      code,
      `${privateMarker}:${code}`,
      { routerReturnCode: 99, cause: new Error(privateMarker) },
    ));
    assert.equal(projected instanceof RFCError, true, code);
    const error = projected as RFCError;
    assert.equal(error.code, expectedCode, code);
    assert.equal(error.codeString, RFCErrorCode[expectedCode], code);
    assert.equal(error.key, code, code);
    assert.equal(error.message.includes(privateMarker), false, code);
    assert.equal("cause" in error, false, code);
    assert.equal("routerReturnCode" in error, false, code);
    assert.equal(JSON.stringify(error).includes(privateMarker), false, code);
    assert.equal(inspect(error).includes(privateMarker), false, code);
  }
});

test("projects only payload-free initial-logon structure under the private stable symbol", () => {
  const diagnostic = malformedInitialLogonDiagnostic();
  Object.defineProperty(diagnostic, "privateRawValue", {
    value: "PRIVATE_INITIAL_LOGON_VALUE",
    enumerable: false,
  });
  const projected = projectNodeRfcPublicError(new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.MalformedProtocol,
    origin: RfcFailureOrigin.Cpic,
    phase: RfcOperationPhase.Logon,
    transmission: RfcTransmissionState.Complete,
    establishedSession: false,
    correlationId: "public.initial.logon.structure",
    reasonCode: "RFC_CPIC_LOGON_RESPONSE_MALFORMED",
    key: "RFC_INVALID_PROTOCOL",
    message: "CPIC RFC logon response is malformed",
    cause: diagnostic,
  })));

  assert.equal(projected instanceof RFCError, true);
  const error = projected as RFCError;
  assert.equal(error.codeString, "RFC_INVALID_PROTOCOL");
  assert.equal("failure" in error, false);
  assert.equal("cause" in error, false);
  const descriptor = Object.getOwnPropertyDescriptor(
    error,
    INITIAL_CPIC_LOGON_STRUCTURE_ASSERTION,
  );
  assert.deepEqual(
    descriptor === undefined
      ? undefined
      : {
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          writable: "writable" in descriptor ? descriptor.writable : undefined,
        },
    { enumerable: false, configurable: false, writable: false },
  );
  const assertion = descriptor?.value;
  assert.deepEqual(assertion, {
    rule: "malformed-vendor-logon-control",
    fields: [
      { tag: CpicTag.ProtocolVersion, byteLength: 4, index: 0 },
      { tag: CpicTag.Capabilities, byteLength: 11, index: 1 },
      { tag: CpicTag.LogonStatus, byteLength: 1, index: 2 },
      { tag: CpicTag.Unresolved0420, byteLength: 4, index: 3 },
      { tag: 0x0450, byteLength: 5, index: 4 },
      { tag: CpicTag.End, byteLength: 0, index: 5 },
    ],
  });
  assert.equal(Object.isFrozen(assertion), true);
  assert.equal(Object.isFrozen(assertion.fields), true);
  assert.equal(assertion.fields.every(Object.isFrozen), true);
  const projectorDescriptor = Object.getOwnPropertyDescriptor(
    RFCError,
    INITIAL_CPIC_LOGON_PUBLIC_ERROR_PROJECTOR,
  );
  assert.deepEqual(
    projectorDescriptor === undefined
      ? undefined
      : {
          enumerable: projectorDescriptor.enumerable,
          configurable: projectorDescriptor.configurable,
          writable: "writable" in projectorDescriptor
            ? projectorDescriptor.writable
            : undefined,
        },
    { enumerable: false, configurable: false, writable: false },
  );
  assert.equal(typeof projectorDescriptor?.value, "function");
  assert.equal(projectorDescriptor?.value(error), assertion);
  for (const rendered of [JSON.stringify(error), inspect(error)]) {
    assert.equal(rendered.includes("PRIVATE_INITIAL_LOGON_VALUE"), false);
    assert.equal(rendered.includes("privateRawValue"), false);
  }

  const impostor = Object.freeze({
    name: "CpicInitialLogonStructureError",
    rule: "unsupported-field",
    fields: Object.freeze([
      Object.freeze({ tag: 0x0450, byteLength: 5, index: 0 }),
    ]),
  });
  const impostorProjection = projectNodeRfcPublicError(
    new RfcCoreError(createRfcFailure({
      category: RfcFailureCategory.MalformedProtocol,
      origin: RfcFailureOrigin.Cpic,
      phase: RfcOperationPhase.Logon,
      transmission: RfcTransmissionState.Complete,
      establishedSession: false,
      correlationId: "public.initial.logon.impostor",
      reasonCode: "RFC_CPIC_LOGON_RESPONSE_MALFORMED",
      cause: impostor,
    })),
  ) as RFCError;
  assert.equal(
    Object.hasOwn(impostorProjection, INITIAL_CPIC_LOGON_STRUCTURE_ASSERTION),
    false,
  );
  assert.equal(projectorDescriptor?.value(impostorProjection), null);

  const wrongReasonProjection = projectNodeRfcPublicError(
    new RfcCoreError(createRfcFailure({
      category: RfcFailureCategory.MalformedProtocol,
      origin: RfcFailureOrigin.Cpic,
      phase: RfcOperationPhase.Logon,
      transmission: RfcTransmissionState.Complete,
      establishedSession: false,
      correlationId: "public.initial.logon.wrong.reason",
      reasonCode: "RFC_OTHER_MALFORMED_RESPONSE",
      cause: diagnostic,
    })),
  ) as RFCError;
  assert.equal(
    Object.hasOwn(wrongReasonProjection, INITIAL_CPIC_LOGON_STRUCTURE_ASSERTION),
    false,
  );
});

test("normalizes configuration failures without leaking implementation errors", () => {
  const opaque = Symbol("opaque");
  assert.equal(projectNodeRfcNormalizationError(opaque), opaque);

  for (const [error, message] of [
    [
      new TypeError("ashost must be a non-empty string or number"),
      "Parameter ASHOST, GWHOST, MSHOST or PORT is missing.",
    ],
    [
      new TypeError("sysnr requires a selected ashost route"),
      "Parameter ASHOST, GWHOST, MSHOST or PORT is missing.",
    ],
    [
      new TypeError("one of ashost, mshost, or wshost is required"),
      "Parameter ASHOST, GWHOST, MSHOST or PORT is missing.",
    ],
    [new TypeError("typed failure"), "typed failure"],
    [new RangeError("bounded failure"), "bounded failure"],
    [new Error("generic failure"), "generic failure"],
  ] as const) {
    const projected = projectNodeRfcNormalizationError(error);
    assert.equal(projected instanceof RFCError, true);
    assert.equal((projected as RFCError).code, RFCErrorCode.RFC_INVALID_PARAMETER);
    assert.equal((projected as Error).message, message);
  }
});

test("snapshots and validates every compatibility client option before I/O", () => {
  assert.deepEqual(snapshotRfcClientOptions(undefined), {
    bcd: "string",
    int8Mode: "number",
  });
  assert.deepEqual(snapshotRfcClientOptions({}), {
    bcd: "string",
    int8Mode: "number",
  });

  const conversion = (value: string) => ({ decimal: value });
  const callback = () => ({ exports: [] });
  const recursiveSerializerPolicy = {
    profile: "abap-7.58" as const,
    observation: {
      defaultSerializer: "basxml" as "basxml" | "classic-xrfc",
      basxmlDisabledSerializer: "classic-xrfc" as const,
    },
  };
  const valid = snapshotRfcClientOptions({
    bcd: conversion,
    int8Mode: "bigint",
    stateless: true,
    timeout: 0.001,
    logLevel: 0,
    recursiveSerializerPolicy,
    callbacks: { Z_CALLBACK: callback },
  });
  recursiveSerializerPolicy.observation.defaultSerializer = "classic-xrfc";
  assert.deepEqual(valid, {
    bcd: conversion,
    int8Mode: "bigint",
    stateless: true,
    timeout: 0.001,
    logLevel: 0,
    recursiveSerializerPolicy: {
      profile: "abap-7.58",
      observation: {
        defaultSerializer: "basxml",
        basxmlDisabledSerializer: "classic-xrfc",
      },
    },
    callbacks: { Z_CALLBACK: callback },
  });
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid?.callbacks), true);
  assert.equal(valid?.callbacks?.Z_CALLBACK, callback);
  assert.equal(Object.isFrozen(valid?.recursiveSerializerPolicy), true);
  assert.equal(
    Object.isFrozen(valid?.recursiveSerializerPolicy?.observation),
    true,
  );
  assert.equal(snapshotRfcClientOptions({ bcd: undefined })?.bcd, "string");
  assert.equal(snapshotRfcClientOptions({ bcd: "number" })?.bcd, "number");
  assert.equal(snapshotRfcClientOptions({ bcd: conversion })?.bcd, conversion);
  assert.equal(snapshotRfcClientOptions({ int8Mode: "string" })?.int8Mode, "string");
  assert.equal(snapshotRfcClientOptions({ int8Mode: undefined })?.int8Mode, "number");
  assert.equal(snapshotRfcClientOptions({ callbacks: undefined })?.callbacks, undefined);
  assert.throws(
    () => snapshotRfcClientOptions({ callbacks: { Z_CALLBACK: 1 as never } }),
    /must be a function/u,
  );

  for (const invalid of [null, [], "bad"]) {
    assert.throws(
      () => snapshotRfcClientOptions(invalid as never),
      /clientOptions must be an object/u,
    );
  }
  const accessor = {} as { timeout?: number };
  Object.defineProperty(accessor, "timeout", { get: () => 1 });
  assert.throws(
    () => snapshotRfcClientOptions(accessor),
    /clientOptions\.timeout must be an own data property/u,
  );
  assert.throws(
    () => snapshotRfcClientOptions({ bcd: true as never }),
    /Client option "bcd"/u,
  );
  assert.throws(
    () => snapshotRfcClientOptions({ unknownOption: true } as never),
    /unknown client option unknownOption/u,
  );
  assert.throws(
    () => new Client(parameters, { unknownOption: true } as never),
    /unknown client option unknownOption/u,
  );
  assert.throws(
    () => new Pool({
      connectionParameters: parameters,
      clientOptions: { unknownOption: true } as never,
      poolOptions: { low: 0, high: 1 },
    }),
    /unknown client option unknownOption/u,
  );

  const symbolOption = { [Symbol("option")]: true };
  assert.throws(
    () => snapshotRfcClientOptions(symbolOption as never),
    /client option keys must be strings/u,
  );

  const inheritedOptions = Object.create({ timeout: 1 }) as RfcClientOptions;
  assert.throws(
    () => snapshotRfcClientOptions(inheritedOptions),
    /clientOptions must not have a custom prototype/u,
  );

  let optionProxyTrapCalls = 0;
  const proxiedOptions = new Proxy({ timeout: 1 }, {
    ownKeys(target) {
      optionProxyTrapCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () => snapshotRfcClientOptions(proxiedOptions),
    /clientOptions must not be a Proxy/u,
  );
  assert.equal(optionProxyTrapCalls, 0);
  assert.throws(
    () => snapshotRfcClientOptions({ stateless: "yes" as never }),
    /stateless must be a boolean/u,
  );
  assert.throws(
    () => snapshotRfcClientOptions({ int8Mode: "lossy" as never }),
    /clientOptions\.int8Mode must be number, bigint, or string/u,
  );
  for (const timeout of [Number.NaN, 0, 2_147_484]) {
    assert.throws(
      () => snapshotRfcClientOptions({ timeout }),
      /timeout must be a positive number/u,
    );
  }
  for (const logLevel of [-1, 1.5]) {
    assert.throws(
      () => snapshotRfcClientOptions({ logLevel }),
      /logLevel must be a non-negative integer/u,
    );
  }
});

test("clients and pools validate raw connection surfaces before snapshotting", () => {
  const construct = [
    (connectionParameters: Record<PropertyKey, unknown>) =>
      new Client(connectionParameters),
    (connectionParameters: Record<PropertyKey, unknown>) =>
      new Pool({
        connectionParameters,
        poolOptions: { low: 0, high: 1 },
      }),
  ] as const;

  for (const create of construct) {
    assert.throws(
      () => create({ ...parameters, ashot: "typo.example.invalid" }),
      /unknown RFC connection parameter ashot/u,
    );
    assert.throws(
      () => create({ ...parameters, trace: 1 }),
      /trace connections are not implemented/u,
    );
    assert.throws(
      () => create({ ...parameters, [Symbol("parameter")]: true }),
      /RFC connection parameter keys must be strings/u,
    );

    const inherited = Object.assign(Object.create({ trace: 1 }), parameters) as
      Record<PropertyKey, unknown>;
    assert.throws(
      () => create(inherited),
      /RFC connection parameters must not have a custom prototype/u,
    );

    let proxyTrapCalls = 0;
    const proxied = new Proxy({ ...parameters }, {
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    assert.throws(
      () => create(proxied),
      /RFC connection parameters must not be a Proxy/u,
    );
    assert.equal(proxyTrapCalls, 0);
  }
});

test("archived clients forward their number default and exact INT8 opt-ins", async () => {
  for (const int8Mode of [undefined, "number", "bigint", "string"] as const) {
    const lease = Object.freeze({}) as DirectDestinationApplicationLease;
    let capturedMode: unknown;
    const owner = {
      async acquireApplication() { return lease; },
      async applicationInfo() {
        return Object.freeze({
          localAddress: "127.0.0.1",
          peerCodePage: "4103",
          peerAcceptInfo: 0,
          generationHandle: 1,
          connectionIndex: 1,
        });
      },
      async invoke(
        _lease: DirectDestinationApplicationLease,
        invocation: { readonly int8Mode?: unknown },
      ) {
        capturedMode = invocation.int8Mode;
        return Object.freeze({});
      },
      async releaseApplication() {},
      async retire() {},
    } as unknown as DirectDestinationOwner;
    const restore = bindClientDestinationOwnerFactory({ create: () => owner });
    const client = new Client(
      parameters,
      int8Mode === undefined ? undefined : { int8Mode },
    );
    try {
      await client.open() as Client;
      await client.call("RFC_PING", {});
      assert.equal(capturedMode, int8Mode ?? "number");
      await client.close() as void;
    } finally {
      restore();
    }
  }
});

test("archived clients forward BCD modes and preserve a consumed connection on converter failure", async () => {
  const converter = (value: string) => ({ decimal: value });
  for (const bcd of [undefined, "string", "number", converter] as const) {
    const lease = Object.freeze({}) as DirectDestinationApplicationLease;
    let capturedMode: unknown;
    const owner = {
      async acquireApplication() { return lease; },
      async applicationInfo() {
        return Object.freeze({
          localAddress: "127.0.0.1",
          peerCodePage: "4103",
          peerAcceptInfo: 0,
          generationHandle: 1,
          connectionIndex: 1,
        });
      },
      async invoke(
        _lease: DirectDestinationApplicationLease,
        invocation: { readonly bcd?: unknown },
      ) {
        capturedMode = invocation.bcd;
        return Object.freeze({});
      },
      async releaseApplication() {},
      async retire() {},
    } as unknown as DirectDestinationOwner;
    const restore = bindClientDestinationOwnerFactory({ create: () => owner });
    const client = new Client(parameters, bcd === undefined ? undefined : { bcd });
    try {
      await client.open() as Client;
      await client.call("RFC_PING", {});
      assert.equal(capturedMode, bcd ?? "string");
      await client.close() as void;
    } finally {
      restore();
    }
  }

  for (const stateless of [false, true]) {
    const lease = Object.freeze({}) as DirectDestinationApplicationLease;
    const original = new Error(`converter failed (${stateless})`);
    let acquisitions = 0;
    let invocations = 0;
    let resets = 0;
    let releases = 0;
    const owner = {
      async acquireApplication() {
        acquisitions += 1;
        return lease;
      },
      async applicationInfo() {
        return Object.freeze({
          localAddress: "127.0.0.1",
          peerCodePage: "4103",
          peerAcceptInfo: 0,
          generationHandle: 1,
          connectionIndex: 1,
        });
      },
      async invoke() {
        invocations += 1;
        if (invocations === 1) {
          throw new ClassicBcdConversionError("RESULT.AMOUNT", original);
        }
        return Object.freeze({ OK: true });
      },
      async resetApplication() { resets += 1; },
      async releaseApplication() { releases += 1; },
      async retire() {},
    } as unknown as DirectDestinationOwner;
    const restore = bindClientDestinationOwnerFactory({ create: () => owner });
    const client = new Client(parameters, { bcd: converter, stateless });
    try {
      await client.open() as Client;
      await assert.rejects(client.call("Z_DECIMAL", {}), (error) => error === original);
      assert.equal(client.alive, true);
      assert.equal(acquisitions, 1);
      assert.equal(releases, 0);
      assert.equal(resets, stateless ? 1 : 0);
      assert.deepEqual(await client.call("RFC_PING", {}), { OK: true });
      assert.equal(acquisitions, 1);
      assert.equal(resets, stateless ? 2 : 0);
      await client.close() as void;
    } finally {
      restore();
    }
  }
});

test("stateless clients reset reusable ABAP exceptions before reuse", async () => {
  const lease = Object.freeze({}) as DirectDestinationApplicationLease;
  let invocations = 0;
  let resets = 0;
  const applicationFailure = new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.AbapException,
    origin: RfcFailureOrigin.Sap,
    phase: RfcOperationPhase.EnvelopeDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    correlationId: "stateless.abap.exception",
    reasonCode: "RFC_ABAP_EXCEPTION",
    key: "DECLARED_EXCEPTION",
  }));
  assert.equal(
    applicationFailure.failure.disposition,
    RfcConnectionDisposition.Reusable,
  );
  const owner = {
    async acquireApplication() { return lease; },
    async applicationInfo() {
      return Object.freeze({
        localAddress: "127.0.0.1",
        peerCodePage: "4103",
        peerAcceptInfo: 0,
        generationHandle: 1,
        connectionIndex: 1,
      });
    },
    async invoke() {
      invocations += 1;
      if (invocations === 1) throw applicationFailure;
      return Object.freeze({ OK: true });
    },
    async resetApplication() { resets += 1; },
    async releaseApplication() {},
    async retire() {},
  } as unknown as DirectDestinationOwner;
  const restore = bindClientDestinationOwnerFactory({ create: () => owner });
  const client = new Client(parameters, { stateless: true });
  try {
    await client.open() as Client;
    await assert.rejects(
      client.call("Z_DECLARED_EXCEPTION", {}),
      (error) => error instanceof RFCError &&
        error.codeString === "RFC_ABAP_EXCEPTION",
    );
    assert.equal(client.alive, true);
    assert.equal(resets, 1);
    assert.deepEqual(await client.call("RFC_PING", {}), { OK: true });
    assert.equal(resets, 2);
    await client.close() as void;
  } finally {
    restore();
  }
});

test("stateless reset failure retires the consumed ABAP-exception lease", async () => {
  const firstLease = Object.freeze({ id: 1 }) as unknown as
    DirectDestinationApplicationLease;
  const replacementLease = Object.freeze({ id: 2 }) as unknown as
    DirectDestinationApplicationLease;
  const released: Array<{ lease: DirectDestinationApplicationLease; reusable: boolean }> = [];
  let acquisitions = 0;
  let invocations = 0;
  let resets = 0;
  const privateResetMarker = "private reset backend detail";
  const applicationFailure = new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.AbapException,
    origin: RfcFailureOrigin.Sap,
    phase: RfcOperationPhase.EnvelopeDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    correlationId: "stateless.abap.exception.reset-failure",
    reasonCode: "RFC_ABAP_EXCEPTION",
    key: "DECLARED_EXCEPTION",
  }));
  assert.equal(
    applicationFailure.failure.disposition,
    RfcConnectionDisposition.Reusable,
  );
  const resetFailure = new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.Communication,
    origin: RfcFailureOrigin.Ni,
    phase: RfcOperationPhase.Receive,
    transmission: RfcTransmissionState.Unknown,
    establishedSession: true,
    correlationId: "stateless.abap.exception.reset-transport",
    reasonCode: "NI_RECEIVE_FAILED",
    cause: new Error(privateResetMarker),
  }));
  const owner = {
    async acquireApplication() {
      acquisitions += 1;
      return acquisitions === 1 ? firstLease : replacementLease;
    },
    async applicationInfo(lease: DirectDestinationApplicationLease) {
      return Object.freeze({
        localAddress: "127.0.0.1",
        peerCodePage: "4103",
        peerAcceptInfo: 0,
        generationHandle: lease === firstLease ? 1 : 2,
        connectionIndex: lease === firstLease ? 1 : 2,
      });
    },
    async invoke() {
      invocations += 1;
      throw applicationFailure;
    },
    async resetApplication() {
      resets += 1;
      throw resetFailure;
    },
    async releaseApplication(
      lease: DirectDestinationApplicationLease,
      options: { readonly reusable: boolean },
    ) { released.push({ lease, reusable: options.reusable }); },
    async retire() {},
  } as unknown as DirectDestinationOwner;
  const restore = bindClientDestinationOwnerFactory({ create: () => owner });
  const client = new Client(parameters, { stateless: true });
  try {
    await client.open() as Client;
    let observed;
    try {
      await client.call("Z_DECLARED_EXCEPTION", {});
    } catch (error) {
      observed = error;
    }
    assert.equal(observed instanceof AggregateError, true);
    const aggregate = observed as AggregateError;
    assert.equal(aggregate.errors.length, 2);
    assert.equal(aggregate.cause, aggregate.errors[0]);
    assert.equal(aggregate.errors[0] instanceof RFCError, true);
    assert.equal(aggregate.errors[0].codeString, "RFC_ABAP_EXCEPTION");
    assert.equal(aggregate.errors[1] instanceof RFCError, true);
    assert.equal(aggregate.errors[1].codeString, "RFC_COMMUNICATION_FAILURE");
    assert.equal(aggregate.errors.some((error) => error instanceof RfcCoreError), false);
    assert.equal(inspect(aggregate).includes(privateResetMarker), false);
    assert.equal(JSON.stringify(aggregate).includes(privateResetMarker), false);
    assert.equal(client.alive, true);
    assert.equal(acquisitions, 2);
    assert.equal(invocations, 1);
    assert.equal(resets, 1);
    assert.deepEqual(released, [{ lease: firstLease, reusable: false }]);
    await client.close() as void;
  } finally {
    restore();
  }
});

test("cancel and timeout during stateless exception reset retire without replay", async (t) => {
  for (const mode of ["cancel", "timeout"] as const) {
    await t.test(mode, async () => {
      const firstLease = Object.freeze({ id: 1 }) as unknown as
        DirectDestinationApplicationLease;
      const replacementLease = Object.freeze({ id: 2 }) as unknown as
        DirectDestinationApplicationLease;
      let acquisitions = 0;
      let invocations = 0;
      let resets = 0;
      const released: Array<{
        lease: DirectDestinationApplicationLease;
        reusable: boolean;
      }> = [];
      let signalResetStarted!: () => void;
      const resetStarted = new Promise<void>((resolve) => {
        signalResetStarted = resolve;
      });
      const applicationFailure = new RfcCoreError(createRfcFailure({
        category: RfcFailureCategory.AbapException,
        origin: RfcFailureOrigin.Sap,
        phase: RfcOperationPhase.EnvelopeDecode,
        transmission: RfcTransmissionState.Complete,
        establishedSession: true,
        correlationId: `stateless.abap.exception.${mode}`,
        reasonCode: "RFC_ABAP_EXCEPTION",
        key: "DECLARED_EXCEPTION",
      }));
      const owner = {
        async acquireApplication() {
          acquisitions += 1;
          return acquisitions === 1 ? firstLease : replacementLease;
        },
        async applicationInfo(lease: DirectDestinationApplicationLease) {
          return Object.freeze({
            localAddress: "127.0.0.1",
            peerCodePage: "4103",
            peerAcceptInfo: 0,
            generationHandle: lease === firstLease ? 1 : 2,
            connectionIndex: lease === firstLease ? 1 : 2,
          });
        },
        async invoke() {
          invocations += 1;
          throw applicationFailure;
        },
        async resetApplication(
          _lease: DirectDestinationApplicationLease,
          signal?: AbortSignal,
        ) {
          resets += 1;
          signalResetStarted();
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new NiTransportError(
            "NI_ABORTED",
            "private reset cancellation detail",
          );
        },
        async releaseApplication(
          lease: DirectDestinationApplicationLease,
          options: { readonly reusable: boolean },
        ) { released.push({ lease, reusable: options.reusable }); },
        async retire() {},
      } as unknown as DirectDestinationOwner;
      const restore = bindClientDestinationOwnerFactory({ create: () => owner });
      const client = new Client(parameters, {
        stateless: true,
        ...(mode === "timeout" ? { timeout: 0.01 } : {}),
      });
      try {
        await client.open() as Client;
        const call = client.call("Z_DECLARED_EXCEPTION", {});
        await resetStarted;
        if (mode === "cancel") await client.cancel() as void;
        await assert.rejects(call, (error) => error instanceof AggregateError);
        assert.equal(client.alive, true);
        assert.equal(acquisitions, 2);
        assert.equal(invocations, 1);
        assert.equal(resets, 1);
        assert.deepEqual(released, [{ lease: firstLease, reusable: false }]);
        await client.close() as void;
      } finally {
        restore();
      }
    });
  }
});

test("validates closed-client calls and callback contracts before networking", async () => {
  const client = new Client(parameters);
  assert.equal(Client.environment, environment);
  assert.equal(client.environment, environment);
  assert.equal(client.binding, client);
  assert.equal(client.alive, false);
  assert.equal(client.connectionHandle, 0);
  assert.equal(client.pool_id, 0);
  assert.match(client._id, /handle: 0 \[d\]$/u);
  assert.equal(client.connectionInfo instanceof Error, true);

  for (const [method, invoke] of [
    ["open", () => client.open(1 as never)],
    ["ping", () => client.ping(1 as never)],
    ["close", () => client.close(1 as never)],
    ["cancel", () => client.cancel(1 as never)],
    ["resetServerContext", () => client.resetServerContext(1 as never)],
    ["release", () => client.release(1 as never)],
  ] as const) {
    assert.throws(invoke, new RegExp(`Client ${method}\\(\\) argument`));
  }

  await assert.rejects(client.close() as Promise<void>, /closed connection/u);
  await assert.rejects(client.ping() as Promise<boolean>, /closed connection/u);
  await assert.rejects(
    client.resetServerContext() as Promise<void>,
    /closed connection/u,
  );
  await assert.rejects(
    client.release() as Promise<void>,
    /direct clients cannot be released/u,
  );
  await assert.rejects(client.getFunctionInterface("RFC_PING"), /closed connection/u);
  await assert.rejects(client.getStructureDefinition("RFCSI"), /closed connection/u);

  await new Promise<void>((resolve) => {
    client.ping((error, result) => {
      assert.equal(error instanceof Error, true);
      assert.equal(result, false);
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    client.cancel((error) => error === undefined ? resolve() : reject(error));
  });
  await new Promise<void>((resolve, reject) => {
    cancelClient(client, (error) => error === undefined ? resolve() : reject(error));
  });
  assert.throws(() => cancelClient({} as Client), /expects a Client/u);
});

test("rejects malformed call inputs before queue or transport admission", async () => {
  const client = new Client(parameters);
  for (const [functionName, input, options, pattern] of [
    ["", {}, {}, /RFC function name/u],
    [42, {}, {}, /RFC function name/u],
    ["RFC_PING", null, {}, /RFC parameter object/u],
    ["RFC_PING", [], {}, /RFC parameter object/u],
    ["RFC_PING", { "": "bad" }, {}, /Empty RFM parameter name/u],
    ["RFC_PING", { "BAD-NAME": "bad" }, {}, /parameter name invalid/u],
    ["RFC_PING", {}, null, /Call options argument/u],
    ["RFC_PING", {}, [], /Call options argument/u],
    ["RFC_PING", {}, { notRequested: "BAD" }, /notRequested must be an array/u],
    ["RFC_PING", {}, { notRequested: [""] }, /non-empty strings/u],
    ["RFC_PING", {}, { notRequested: ["A", "A"] }, /duplicate A/u],
    ["RFC_PING", {}, { timeout: 0 }, /positive number of seconds/u],
  ] as const) {
    await assert.rejects(
      client.call(functionName as string, input as never, options as never),
      pattern,
    );
  }
  assert.throws(
    () => client.invoke("RFC_PING", {}, undefined as never),
    /Callback function must be supplied/u,
  );
});

test("managed-client attachment and claim transfer one opaque lease exactly once", async () => {
  const owner = {} as DirectDestinationOwner;
  const lease = Object.freeze({}) as DirectDestinationApplicationLease;
  const info = Object.freeze({
    localAddress: "127.0.0.1",
    peerCodePage: "4103",
    peerAcceptInfo: 0,
    generationHandle: 73,
    connectionIndex: 9,
  });
  let released = 0;
  const managed = new Client(parameters, undefined, {
    poolId: 17,
    release: async (client) => {
      released += 1;
      const claim = client[pooledClientClaim]();
      assert.equal(claim.owner, owner);
      assert.equal(claim.lease, lease);
      assert.equal(claim.reusableAfterTail(), true);
      await claim.tail;
    },
  });

  managed[pooledClientAttach]({ owner, lease, info });
  assert.equal(managed.alive, true);
  assert.equal(managed.connectionHandle, 73);
  assert.equal(managed.pool_id, 17);
  assert.match(managed._id, /\[m\] pool: 17$/u);
  assert.deepEqual(
    {
      host: (managed.connectionInfo as Record<string, string>).host,
      client: (managed.connectionInfo as Record<string, string>).client,
      partnerCodepage:
        (managed.connectionInfo as Record<string, string>).partnerCodepage,
      isoLanguage:
        (managed.connectionInfo as Record<string, string>).isoLanguage,
      sysId: (managed.connectionInfo as Record<string, string>).sysId,
      rel: (managed.connectionInfo as Record<string, string>).rel,
      partnerRel:
        (managed.connectionInfo as Record<string, string>).partnerRel,
      kernelRel:
        (managed.connectionInfo as Record<string, string>).kernelRel,
      cpicConvId:
        (managed.connectionInfo as Record<string, string>).cpicConvId,
    },
    {
      host: parameters.ashost,
      client: parameters.client,
      partnerCodepage: "4103",
      isoLanguage: "EN",
      sysId: "",
      rel: "",
      partnerRel: "",
      kernelRel: "",
      cpicConvId: "",
    },
  );
  assert.throws(
    () => managed[pooledClientAttach]({ owner, lease, info }),
    /cannot accept an application lease/u,
  );
  await managed.release() as void;
  assert.equal(released, 1);
  assert.equal(managed.alive, false);
  await assert.rejects(
    managed.release() as Promise<void>,
    /already closed client/u,
  );
  assert.throws(
    () => managed[pooledClientClaim](),
    /already closed client/u,
  );

  const direct = new Client(parameters);
  assert.throws(
    () => direct[pooledClientClaim](),
    /direct clients have no pool lease/u,
  );
  assert.throws(
    () => direct[pooledClientAttach]({ owner, lease, info }),
    /cannot accept an application lease/u,
  );
});

test("pool configuration and overload validation is complete before owner creation", async () => {
  for (const configuration of [null, undefined, []]) {
    assert.throws(
      () => new Pool(configuration as never),
      /Pool requires a configuration object/u,
    );
  }
  const accessorConfiguration = {} as Record<string, unknown>;
  Object.defineProperty(accessorConfiguration, "connectionParameters", {
    get: () => parameters,
  });
  assert.throws(
    () => new Pool(accessorConfiguration as never),
    /must be an own data property/u,
  );

  for (const poolOptions of [null, [], "bad"]) {
    assert.throws(
      () => new Pool({
        connectionParameters: parameters,
        poolOptions: poolOptions as never,
      }),
      /poolOptions must be an object/u,
    );
  }
  for (const poolOptions of [
    { low: -1, high: 1 },
    { low: 0, high: Number.NaN },
    { low: 0, high: 0 },
    { low: 2, high: 1 },
    { low: 0, high: 1, logLevel: -1 },
    { low: 0, high: 1, logLevel: 1.5 },
  ]) {
    assert.throws(
      () => new Pool({ connectionParameters: parameters, poolOptions }),
      /poolOptions/u,
    );
  }

  for (const resourceOptions of [null, [], "bad"]) {
    assert.throws(
      () => new Pool({
        connectionParameters: parameters,
        poolOptions: { low: 0, high: 1 },
        resourceOptions: resourceOptions as never,
      }),
      /resourceOptions must be an object/u,
    );
  }
  for (const name of [
    "maxConnections",
    "maxWaiters",
    "acquireTimeoutMs",
    "lifecycleTimeoutMs",
    "shutdownTimeoutMs",
  ] as const) {
    assert.throws(
      () => new Pool({
        connectionParameters: parameters,
        poolOptions: { low: 0, high: 1 },
        resourceOptions: { [name]: 0 },
      }),
      new RegExp(`resourceOptions\\.${name} must be a positive integer`),
    );
  }
  assert.throws(
    () => new Pool({
      connectionParameters: parameters,
      poolOptions: { low: 0, high: 1 },
      resourceOptions: { validateOnCheckout: "yes" as never },
    }),
    /validateOnCheckout must be a boolean/u,
  );
  assert.throws(
    () => new Pool({
      connectionParameters: parameters,
      poolOptions: { low: 0, high: 2 },
      resourceOptions: { maxConnections: 1 },
    }),
    /low and high must not exceed/u,
  );

  const pool = new Pool({
    connectionParameters: parameters,
    clientOptions: { stateless: true },
    poolOptions: { low: 0, high: 1, logLevel: 0 },
    resourceOptions: {
      maxConnections: 2,
      maxWaiters: 3,
      acquireTimeoutMs: 4,
      lifecycleTimeoutMs: 5,
      shutdownTimeoutMs: 6,
      validateOnCheckout: true,
    },
  });
  assert.equal(Pool.environment, environment);
  assert.equal(pool.environment, environment);
  assert.equal(pool.binding, pool);
  assert.equal(Number.isSafeInteger(pool.id), true);
  assert.equal(pool.connectionParameters.ashost, parameters.ashost);
  assert.deepEqual(pool.clientOptions, {
    bcd: "string",
    int8Mode: "number",
    stateless: true,
  });
  assert.deepEqual(pool.poolOptions, { low: 0, high: 1, logLevel: 0 });
  assert.equal(pool.config, pool.poolConfiguration);
  assert.deepEqual(pool.status, { ready: 0, leased: 0 });

  assert.throws(() => pool.ready("bad" as never), /first argument/u);
  assert.throws(() => pool.ready(1, 1 as never), /second argument/u);
  assert.throws(
    () => pool.ready(() => undefined, (() => undefined) as never),
    /second argument must be a number/u,
  );
  assert.throws(() => pool.ready(-1), /non-negative integer/u);
  await assert.rejects(pool.ready(3) as Promise<void>, /must not exceed 2/u);

  assert.throws(() => pool.acquire("bad" as never), /first argument/u);
  assert.throws(() => pool.acquire(1, 1 as never), /second argument/u);
  assert.throws(
    () => pool.acquire(() => undefined, (() => undefined) as never),
    /second argument must be a number/u,
  );
  assert.throws(() => pool.acquire(-1), /non-negative integer/u);
  assert.throws(() => pool.acquire(0), /at least one/u);
  assert.throws(() => pool.acquire(3), /must not exceed 2/u);
  assert.throws(() => pool.release({} as Client, 1 as never), /Pool release/u);
  assert.throws(() => pool.cancel({} as Client, 1 as never), /Pool cancel/u);
  assert.throws(() => pool.closeAll(1 as never), /Pool closeAll/u);
  await assert.rejects(
    pool.release({} as Client) as Promise<void>,
    /expects Client instances/u,
  );
  assert.throws(
    () => pool.cancel(new Client(parameters)),
    /currently leased client/u,
  );

  await new Promise<void>((resolve, reject) => {
    pool.closeAll((error) => error === undefined ? resolve() : reject(error));
  });
  await pool.closeAll() as void;
  await new Promise<void>((resolve) => {
    pool.ready(0, (error) => {
      assert.match((error as Error).message, /RFC pool is closed/u);
      resolve();
    });
  });
  assert.throws(() => pool.monitor(), /RFC pool is closed/u);
});
