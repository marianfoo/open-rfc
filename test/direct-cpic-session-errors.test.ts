import assert from "node:assert/strict";
import test from "node:test";

import { DirectCpicSession } from "../src/client/direct-cpic-session.js";
import {
  RfcConnectionDisposition,
  RfcCoreError,
  RfcFailureCategory,
  RfcRecoveryAction,
} from "../src/client/rfc-failure.js";
import {
  CpicTag,
  decodeCpicFieldChainPrefix,
  encodeCpicFieldChain,
  type CpicField,
} from "../src/protocol/cpic.js";
import { GatewayAcceptInfo } from "../src/protocol/gateway.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

function text(tag: number, value: string): CpicField {
  return { tag, value: Buffer.from(value, "utf16le") };
}

function end(): CpicField {
  return { tag: CpicTag.End, value: Buffer.alloc(0) };
}

function terminalLogonRejection(): Buffer {
  return Buffer.concat([
    Buffer.from("010100080101010101010000", "hex"),
    encodeCpicFieldChain(CpicTag.Start, [
      { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      { tag: CpicTag.LogonStatus, value: Buffer.of(1) },
      { tag: CpicTag.SystemCodePage, value: Buffer.alloc(4) },
      { tag: 0x0450, value: Buffer.alloc(3) },
      { tag: CpicTag.ClientAddress, value: Buffer.alloc(15) },
      { tag: 0x0020, value: Buffer.alloc(46) },
      { tag: 0x0021, value: Buffer.alloc(10) },
      { tag: CpicTag.PartnerSystem, value: Buffer.alloc(10) },
      { tag: CpicTag.PartnerHost, value: Buffer.alloc(17) },
      { tag: CpicTag.ConnectionType, value: Buffer.alloc(1) },
      { tag: CpicTag.KernelPatch, value: Buffer.alloc(4) },
      { tag: CpicTag.KernelRelease, value: Buffer.alloc(4) },
      { tag: CpicTag.Destination, value: Buffer.alloc(17) },
      { tag: CpicTag.Program, value: Buffer.alloc(8) },
      { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
      text(CpicTag.AbapErrorMessage, "Synthetic logon denial"),
      end(),
    ]),
    Buffer.from("ffff", "hex"),
  ]);
}

async function authenticatedSession(
  peer: ScriptedRfcPeer,
  operationTimeoutMs = 1_000,
): Promise<DirectCpicSession> {
  const session = await allocatedSession(peer, operationTimeoutMs);
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: ["not-a-real", "password"].join("-"),
  });
  return session;
}

async function allocatedSession(
  peer: ScriptedRfcPeer,
  operationTimeoutMs = 1_000,
): Promise<DirectCpicSession> {
  return DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerHost: "application.example.test",
    applicationServerService: "sapdp00",
    programName: "open-rfc-error-test",
    operationTimeoutMs,
  });
}

async function coreFailure(promise: Promise<unknown>): Promise<RfcCoreError> {
  try {
    await promise;
  } catch (error) {
    assert.equal(error instanceof RfcCoreError, true);
    return error as RfcCoreError;
  }
  assert.fail("expected an RfcCoreError");
}

test("sends a MYSAPSSO2 ticket through the allocated CPIC socket without a password", async (t) => {
  let captured: readonly CpicField[] | undefined;
  const peer = await ScriptedRfcPeer.start([{
    inspectInitialLogon(request) {
      captured = decodeCpicFieldChainPrefix(
        request.subarray(18),
        CpicTag.Start,
        CpicTag.End,
      ).fields;
    },
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await allocatedSession(peer);

  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    ticket: "AjQxMDM=",
  });

  const fields = captured;
  assert.ok(fields);
  assert.equal(fields.some((field) => field.tag === CpicTag.Password), false);
  assert.equal(
    Buffer.from(
      fields.find((field) => field.tag === CpicTag.Ticket)?.value ?? [],
    ).toString("hex"),
    Buffer.from("AjQxMDM=", "utf16le").toString("hex"),
  );
  await session.close();
});

test("rejects a gateway that does not select little-endian Unicode code page 4103", async (t) => {
  const cases = [
    {
      name: "big-endian Unicode",
      script: { gatewayCodePage: "4102" },
    },
    {
      name: "code-page option not accepted",
      script: {
        gatewayAcceptInfo:
          GatewayAcceptInfo.ErrorInfo |
          GatewayAcceptInfo.Ping |
          GatewayAcceptInfo.ConnectionExtendedInfo |
          GatewayAcceptInfo.ExtendedInitOptions |
          GatewayAcceptInfo.DistributedTrace,
      },
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([current.script]);
    t.after(() => peer.close());
    await assert.rejects(
      allocatedSession(peer),
      /only little-endian Unicode partner code page 4103 \(M12\)/u,
      current.name,
    );
  }
});

test("terminally closes rejected and malformed initial-logon generations", async (t) => {
  const cases = [
    {
      name: "rejected",
      script: { logonStatus: 7 },
      category: RfcFailureCategory.Logon,
      disposition: RfcConnectionDisposition.Close,
      key: "RFC_LOGON_FAILURE",
      reasonCode: "RFC_CPIC_LOGON_STATUS_7",
    },
    {
      name: "terminal error envelope",
      script: { logonResponse: terminalLogonRejection() },
      category: RfcFailureCategory.Logon,
      disposition: RfcConnectionDisposition.Close,
      key: "RFC_LOGON_FAILURE",
      reasonCode: "RFC_CPIC_LOGON_REJECTED",
    },
    {
      name: "malformed",
      script: { logonResponse: Buffer.from("00", "hex") },
      category: RfcFailureCategory.MalformedProtocol,
      disposition: RfcConnectionDisposition.UnknownClose,
      key: "RFC_INVALID_PROTOCOL",
      reasonCode: "RFC_CPIC_LOGON_RESPONSE_MALFORMED",
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([current.script]);
    t.after(() => peer.close());
    const session = await allocatedSession(peer);
    const error = await coreFailure(session.logonAndPing({
      client: "001",
      user: "RFCUSR",
      password: ["not-a-real", "password"].join("-"),
    }));
    assert.equal(error.failure.category, current.category, current.name);
    assert.equal(error.failure.disposition, current.disposition, current.name);
    assert.equal(error.failure.recoveryAction, RfcRecoveryAction.None, current.name);
    assert.equal(error.failure.key, current.key, current.name);
    assert.equal(error.failure.reasonCode, current.reasonCode, current.name);
    assert.equal(session.state, "closed", current.name);
  }
});

test("retains redaction-safe initial-logon structure diagnostics as the failure cause", async (t) => {
  const prefix = Buffer.from("010100080101010504010003", "hex");
  const logonResponse = Buffer.concat([
    prefix,
    encodeCpicFieldChain(CpicTag.Start, [
      { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: 0x0450, value: Buffer.alloc(5) },
      end(),
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  const peer = await ScriptedRfcPeer.start([{ logonResponse }]);
  t.after(() => peer.close());
  const session = await allocatedSession(peer);

  const error = await coreFailure(session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: ["not-a-real", "password"].join("-"),
  }));

  assert.equal(error.failure.reasonCode, "RFC_CPIC_LOGON_RESPONSE_MALFORMED");
  const diagnostic = error.failure.cause as Error & {
    readonly rule?: unknown;
    readonly fields?: unknown;
  };
  assert.equal(diagnostic.name, "CpicInitialLogonStructureError");
  assert.equal(diagnostic.rule, "malformed-vendor-logon-control");
  assert.deepEqual(diagnostic.fields, [
    { tag: CpicTag.ProtocolVersion, byteLength: 4, index: 0 },
    { tag: CpicTag.Capabilities, byteLength: 11, index: 1 },
    { tag: CpicTag.LogonStatus, byteLength: 1, index: 2 },
    { tag: CpicTag.Unresolved0420, byteLength: 4, index: 3 },
    { tag: 0x0450, byteLength: 5, index: 4 },
    { tag: CpicTag.End, byteLength: 0, index: 5 },
  ]);
  assert.equal(JSON.stringify(diagnostic), "{}");
  assert.equal(session.state, "closed");
});

test("keeps a validated declared exception reusable for a same-generation follow-up", async (t) => {
  const declaredFields: readonly CpicField[] = [
    text(CpicTag.AbapMessageClass, "SR"),
    text(CpicTag.AbapMessageType, "E"),
    text(CpicTag.AbapMessageNumber, "006"),
    text(CpicTag.AbapMessageV1, "Method = 1"),
    text(CpicTag.AbapMessageV2, "two"),
    text(CpicTag.AbapExceptionKey, "RAISE_EXCEPTION"),
    end(),
  ];
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      { kind: "fields", fields: declaredFields },
      { kind: "fields", fields: successfulRegularFields() },
    ],
  }]);
  t.after(() => peer.close());
  const session = await authenticatedSession(peer);

  const error = await coreFailure(session.ping());
  assert.equal(error.failure.category, RfcFailureCategory.AbapException);
  assert.equal(error.failure.disposition, RfcConnectionDisposition.Reusable);
  assert.equal(error.failure.recoveryAction, RfcRecoveryAction.None);
  assert.equal(error.failure.abap.messageV1, "Method = 1");
  assert.equal(error.failure.abap.messageV2, "two");
  assert.equal(session.state, "authenticated");

  assert.deepEqual(await session.ping(), { responseFieldCount: 5 });
  assert.equal(peer.connectionCount, 1);
  assert.equal(peer.regularRequestCount(0), 2);
  await session.close();
});

test("closes runtime, MESSAGE, and malformed response generations", async (t) => {
  const cases = [
    {
      name: "runtime",
      fields: [
        text(CpicTag.AbapErrorMessage, "Runtime text"),
        text(CpicTag.AbapRuntimeId, "RUNTIME_ID"),
        text(CpicTag.AbapCallStack, "PRIVATE_REMOTE_STACK"),
        end(),
      ],
      category: RfcFailureCategory.AbapRuntime,
      disposition: RfcConnectionDisposition.Close,
    },
    {
      name: "MESSAGE",
      fields: [
        text(CpicTag.AbapT100Text, "Message &1"),
        text(CpicTag.AbapMessageClass, "ZZ"),
        text(CpicTag.AbapMessageType, "X"),
        text(CpicTag.AbapMessageNumber, "123"),
        text(CpicTag.AbapMessageV1, "one"),
        text(CpicTag.AbapMessageV2, "two"),
        text(CpicTag.AbapMessageV3, "three"),
        text(CpicTag.AbapMessageV4, "four"),
        end(),
      ],
      category: RfcFailureCategory.AbapMessage,
      disposition: RfcConnectionDisposition.Close,
    },
    {
      name: "malformed",
      fields: [
        { tag: 0x7777, value: Buffer.alloc(0) },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        end(),
      ],
      category: RfcFailureCategory.MalformedProtocol,
      disposition: RfcConnectionDisposition.UnknownClose,
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([{
      replies: [{
        kind: "fields",
        fields: current.fields,
        ...(current.name === "malformed"
          ? {}
          : { appcReturnCode: 18, isFinal: false }),
      }],
    }]);
    t.after(() => peer.close());
    const session = await authenticatedSession(peer);
    const error = await coreFailure(session.ping());
    assert.equal(error.failure.category, current.category, current.name);
    assert.equal(error.failure.disposition, current.disposition, current.name);
    assert.equal(error.failure.recoveryAction, RfcRecoveryAction.Replace, current.name);
    assert.equal(session.state, "closed", current.name);
  }
});

test("normal deallocation overrides reusable and successful RFC envelopes", async (t) => {
  const cases = [
    {
      name: "declared exception",
      fields: [
        text(CpicTag.AbapExceptionKey, "RAISE_EXCEPTION"),
        end(),
      ],
      category: RfcFailureCategory.AbapException,
      disposition: RfcConnectionDisposition.UnknownClose,
    },
    {
      name: "success",
      fields: successfulRegularFields(),
      category: RfcFailureCategory.Communication,
      disposition: RfcConnectionDisposition.Close,
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([{
      replies: [{
        kind: "fields",
        fields: current.fields,
        appcReturnCode: 18,
        isFinal: false,
      }],
    }]);
    t.after(() => peer.close());
    const session = await authenticatedSession(peer);
    const error = await coreFailure(session.ping());
    assert.equal(error.failure.category, current.category, current.name);
    assert.equal(error.failure.disposition, current.disposition, current.name);
    assert.equal(error.failure.recoveryAction, RfcRecoveryAction.Replace, current.name);
    assert.equal(session.state, "closed", current.name);
  }
});

test("classifies peer statuses and empty normal deallocation as communication failures", async (t) => {
  const cases = [
    {
      name: "normal deallocation without data",
      appcReturnCode: 18,
      reasonCode: "CM_NO_DATA_RECEIVED",
      message: "connection closed without message (CM_NO_DATA_RECEIVED)",
    },
    {
      name: "peer return code",
      appcReturnCode: 17,
      reasonCode: "RFC_APPC_RETURN_17_SAP_0",
      message: "F_SAP_SEND failed with APPC return code 17 and SAP return code 0",
    },
  ] as const;

  for (const current of cases) {
    const peer = await ScriptedRfcPeer.start([{
      replies: [{
        kind: "raw",
        data: Buffer.alloc(0),
        appcReturnCode: current.appcReturnCode,
        isFinal: false,
      }],
    }]);
    t.after(() => peer.close());
    const session = await authenticatedSession(peer);
    const error = await coreFailure(session.ping());
    assert.equal(error.failure.category, RfcFailureCategory.Communication, current.name);
    assert.equal(error.failure.disposition, RfcConnectionDisposition.Close, current.name);
    assert.equal(error.failure.recoveryAction, RfcRecoveryAction.Replace, current.name);
    assert.equal(error.failure.reasonCode, current.reasonCode, current.name);
    assert.equal(error.failure.key, "RFC_COMMUNICATION_FAILURE", current.name);
    assert.equal(error.failure.message, current.message, current.name);
    assert.equal(session.state, "closed", current.name);
  }
});

test("terminally closes transport, timeout, and abort generations", async (t) => {
  for (const current of [
    { name: "transport", reply: { kind: "close" } as const, category: RfcFailureCategory.Communication },
    { name: "timeout", reply: { kind: "silence" } as const, category: RfcFailureCategory.Timeout },
    { name: "abort", reply: { kind: "silence" } as const, category: RfcFailureCategory.Canceled },
  ]) {
    const peer = await ScriptedRfcPeer.start([{ replies: [current.reply] }]);
    t.after(() => peer.close());
    // Keep setup outside the deliberately silent operation's timing margin.
    // A 30 ms session timeout could expire during the authenticated localhost
    // handshake on a loaded runner, before the failure under test was started.
    const session = await authenticatedSession(peer);
    const controller = new AbortController();
    const pending = session.ping(controller.signal);
    if (current.name === "abort") setTimeout(() => controller.abort(), 5);
    const error = await coreFailure(pending);
    assert.equal(error.failure.category, current.category, current.name);
    assert.equal(error.failure.recoveryAction, RfcRecoveryAction.Replace, current.name);
    assert.equal(session.state, "closed", current.name);
  }
});
