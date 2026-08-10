import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectCpicPreWireError,
  DirectCpicSession,
  DirectCpicOutgoingWriteError,
  assertDirectCpicResponseIdentity,
  writeOutgoingAppcDataPlan,
  type DirectCpicOutgoingTransport,
} from "../src/client/direct-cpic-session.js";
import {
  RfcConnectionDisposition,
  RfcFailureCategory,
  RfcTransmissionState,
} from "../src/client/rfc-failure.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../src/metadata/rfc-structure-definition.js";
import type { ClassicRfcInvocationOptions } from "../src/client/classic-invocation.js";
import {
  DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS,
  DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH,
  APPC_RECORD_HEADER_LENGTH,
  AppcClientSetupStateMachine,
  AppcFunction,
  decodeAppcAsyncDataInfo,
  decodeAppcDataFragment,
  decodeAppcHeader,
  encodeAppcControlRecord,
  planOutgoingAppcDataFragments,
  type AppcOutgoingDataFragment,
} from "../src/protocol/appc.js";
import {
  CpicTag,
  decodeCpicFieldChainPrefix,
  encodeCpicCutFunctionRequest,
  inspectCpicRequestAppcFraming,
} from "../src/protocol/cpic.js";
import { encodeIncomingAppcDataRecord } from "./support/appc-peer-record.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

interface PendingWrite {
  readonly payload: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface PendingRead {
  readonly timeoutMs: number;
  readonly resolve: (payload: Uint8Array) => void;
  readonly reject: (error: Error) => void;
}

class GatedTransport implements DirectCpicOutgoingTransport {
  readonly writes: PendingWrite[] = [];
  readonly reads: PendingRead[] = [];
  closeCount = 0;
  closeError: Error | undefined;

  send(payload: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writes.push({ payload: Buffer.from(payload), resolve, reject });
    });
  }

  receive(options: { readonly timeoutMs: number }): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.reads.push({ timeoutMs: options.timeoutMs, resolve, reject });
    });
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

function threeFragmentPlan(): readonly AppcOutgoingDataFragment[] {
  const applicationData = Buffer.alloc(28_001, 0x5a);
  return planOutgoingAppcDataFragments(
    {
      conversationId: Buffer.from("CONV0001"),
      sequenceNumber: 17,
      communicationIndex: 0xffff,
      connectionIndex: 6,
      applicationData,
    },
    { cpicStreaming: "enabled" },
  );
}

function barrierPlan(): readonly AppcOutgoingDataFragment[] {
  const applicationData = Buffer.alloc(22 * 28_000, 0x5a);
  return planOutgoingAppcDataFragments(
    {
      conversationId: Buffer.from("CONV0001"),
      sequenceNumber: 17,
      communicationIndex: 0xffff,
      connectionIndex: 6,
      applicationData,
    },
    { cpicStreaming: "enabled" },
  );
}

function twoBarrierPlan(): readonly AppcOutgoingDataFragment[] {
  const applicationData = Buffer.alloc(43 * 28_000, 0x5a);
  return planOutgoingAppcDataFragments(
    {
      conversationId: Buffer.from("CONV0001"),
      sequenceNumber: 17,
      communicationIndex: 0xffff,
      connectionIndex: 6,
      applicationData,
    },
    { cpicStreaming: "enabled" },
  );
}

function requestWithExactApplicationLength(target: number): Buffer {
  let valueLength = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = encodeCpicCutFunctionRequest({
      functionName: "RFC_PING",
      imports: [{ name: "INPUT", value: Buffer.alloc(valueLength) }],
    });
    const actual = inspectCpicRequestAppcFraming(request).applicationDataLength;
    if (actual === target) return request;
    valueLength += target - actual;
    assert.ok(valueLength >= 0);
  }
  assert.fail(`could not construct CPIC request length ${target}`);
}

function barrierAcknowledgement(
  conversationId = Buffer.from("CONV0001"),
): Buffer {
  return encodeIncomingAppcDataRecord({
    functionCode: AppcFunction.SendData,
    conversationId,
    sequenceNumber: 0,
    communicationIndex: 0,
    connectionIndex: 6,
    info4: 2,
    isFinal: false,
    data: Buffer.alloc(0),
  }, { bufferCapacity: 0 });
}

function applicationResponse(): Buffer {
  return encodeIncomingAppcDataRecord({
    functionCode: AppcFunction.Receive,
    conversationId: Buffer.from("CONV0001"),
    sequenceNumber: 0,
    communicationIndex: 0,
    connectionIndex: 6,
    data: Buffer.alloc(0),
  }, { bufferCapacity: 0 });
}

function readySetup(): AppcClientSetupStateMachine {
  const setup = new AppcClientSetupStateMachine();
  setup.sent(AppcFunction.Initialize);
  setup.received(
    encodeAppcControlRecord({ functionCode: AppcFunction.Initialize }),
  );
  setup.sent(AppcFunction.SetPartnerLuName);
  setup.sent(AppcFunction.Allocate);
  setup.received(
    encodeAppcControlRecord({ functionCode: AppcFunction.Allocate }),
  );
  return setup;
}

async function waitForWrite(
  transport: GatedTransport,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.writes.length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for outgoing write ${count}`);
}

async function waitForRead(
  transport: GatedTransport,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.reads.length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for outgoing barrier read ${count}`);
}

test("outgoing writer pre-encodes and applies backpressure between every APPC record", async () => {
  const transport = new GatedTransport();
  const setup = readySetup();
  const write = writeOutgoingAppcDataPlan(
    transport,
    setup,
    threeFragmentPlan(),
  );

  await waitForWrite(transport, 1);
  assert.equal(transport.writes.length, 1);
  assert.equal(
    decodeAppcHeader(transport.writes[0]!.payload).functionCode,
    AppcFunction.AsyncSendData,
  );
  assert.deepEqual(
    decodeAppcAsyncDataInfo(transport.writes[0]!.payload.subarray(48, 80)),
    {
      dataLength: 28_000,
      communicationIndex: 0xffff,
      connectionIndex: 6,
    },
  );
  assert.equal(
    transport.writes[0]!.payload.byteLength,
    APPC_RECORD_HEADER_LENGTH + 28_000,
  );

  transport.writes[0]!.resolve();
  await waitForWrite(transport, 2);
  assert.equal(transport.writes.length, 2);
  const middle = transport.writes[1]!.payload;
  assert.equal(decodeAppcHeader(middle).functionCode, AppcFunction.AsyncSendData);
  assert.deepEqual(decodeAppcAsyncDataInfo(middle.subarray(48, 80)), {
    dataLength: 1,
    communicationIndex: 0xffff,
    connectionIndex: 6,
  });
  assert.equal(middle.byteLength, APPC_RECORD_HEADER_LENGTH + 1);

  transport.writes[1]!.resolve();
  await waitForWrite(transport, 3);
  assert.equal(transport.writes.length, 3);
  const final = decodeAppcDataFragment(transport.writes[2]!.payload);
  assert.equal(final.header.functionCode, AppcFunction.Receive);
  // The terminal meaning comes from the plan/state machine, which emits vector 0.
  assert.equal(final.isFinal, false);
  assert.equal(final.header.info, 1);
  assert.equal(final.header.vector, 0);
  assert.equal(final.header.sapParameterLength, 0);
  assert.equal(final.data.byteLength, 0);

  transport.writes[2]!.resolve();
  await write;
  assert.equal(setup.state, "response-pending");
  assert.equal(transport.closeCount, 0);
});

test("writer waits only at the captured periodic synchronous-send barrier", async () => {
  const transport = new GatedTransport();
  const setup = readySetup();
  const write = writeOutgoingAppcDataPlan(
    transport,
    setup,
    barrierPlan(),
    undefined,
    1_234,
  );

  for (let index = 0; index < 21; index += 1) {
    await waitForWrite(transport, index + 1);
    assert.equal(
      decodeAppcHeader(transport.writes[index]!.payload).functionCode,
      AppcFunction.AsyncSendData,
    );
    assert.equal(transport.reads.length, 0);
    transport.writes[index]!.resolve();
  }
  await waitForWrite(transport, 22);
  assert.equal(
    decodeAppcHeader(transport.writes[21]!.payload).functionCode,
    AppcFunction.SendData,
  );
  transport.writes[21]!.resolve();
  await waitForRead(transport, 1);
  assert.equal(transport.reads[0]!.timeoutMs, 1_234);
  assert.equal(transport.writes.length, 22);
  transport.reads[0]!.resolve(barrierAcknowledgement());

  await waitForWrite(transport, 23);
  assert.equal(
    decodeAppcHeader(transport.writes[22]!.payload).functionCode,
    AppcFunction.Receive,
  );
  transport.writes[22]!.resolve();
  await write;
  assert.equal(setup.state, "response-pending");
  assert.equal(transport.closeCount, 0);
});

test("writer crosses both synchronous barriers inside the beta envelope", async () => {
  const transport = new GatedTransport();
  const setup = readySetup();
  const plan = twoBarrierPlan();
  const write = writeOutgoingAppcDataPlan(transport, setup, plan);
  let reads = 0;

  for (let index = 0; index < plan.length; index += 1) {
    await waitForWrite(transport, index + 1);
    const functionCode = decodeAppcHeader(
      transport.writes[index]!.payload,
    ).functionCode;
    assert.equal(
      functionCode,
      index === 21 || index === 42
        ? AppcFunction.SendData
        : index === plan.length - 1
          ? AppcFunction.Receive
          : AppcFunction.AsyncSendData,
    );
    transport.writes[index]!.resolve();
    if (functionCode === AppcFunction.SendData) {
      reads += 1;
      await waitForRead(transport, reads);
      transport.reads[reads - 1]!.resolve(barrierAcknowledgement());
    }
  }

  await write;
  assert.equal(transport.reads.length, 2);
  assert.equal(setup.state, "response-pending");
  assert.equal(transport.closeCount, 0);
});

test("second synchronous-barrier failure closes without sending the terminator", async () => {
  const transport = new GatedTransport();
  const plan = twoBarrierPlan();
  const write = writeOutgoingAppcDataPlan(transport, readySetup(), plan);
  let reads = 0;

  for (let index = 0; index <= 42; index += 1) {
    await waitForWrite(transport, index + 1);
    const functionCode = decodeAppcHeader(
      transport.writes[index]!.payload,
    ).functionCode;
    transport.writes[index]!.resolve();
    if (functionCode === AppcFunction.SendData) {
      reads += 1;
      await waitForRead(transport, reads);
      transport.reads[reads - 1]!.resolve(
        reads === 1
          ? barrierAcknowledgement()
          : barrierAcknowledgement(Buffer.from("OTHER001")),
      );
    }
  }

  await assert.rejects(write, (error: unknown) => {
    assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
    assert.equal(
      (error as DirectCpicOutgoingWriteError).transmission,
      RfcTransmissionState.Partial,
    );
    assert.match(
      String((error as DirectCpicOutgoingWriteError).cause),
      /acknowledgement identity changed/,
    );
    return true;
  });
  assert.equal(transport.reads.length, 2);
  assert.equal(transport.writes.length, 43);
  assert.equal(transport.closeCount, 1);
});

test("direct session composes two barriers, terminator, initial receive reply, and reuse", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [
      {
        kind: "fields",
        fields: successfulRegularFields(),
        initialReceive: true,
      },
      { kind: "fields", fields: successfulRegularFields() },
    ],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    localAddress: "127.0.0.1",
    operationTimeoutMs: 2_000,
    cpicStreaming: "enabled",
  });

  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: ["not-a-real", "password"].join("-"),
  });
  const request = encodeCpicCutFunctionRequest({
    functionName: "RFC_PING",
    imports: [{ name: "INPUT", value: Buffer.alloc(1_200_001, 0x5a) }],
  });
  const framing = inspectCpicRequestAppcFraming(request);
  assert.equal(framing.mode, "streamed");
  assert.ok(framing.applicationDataLength > 42 * 28_000);

  const response = await session.exchange(request);
  assert.ok(response.byteLength > 0);
  assert.equal(peer.barrierCount(0), 2);
  assert.equal(
    peer.streamedApplicationBytes(0),
    framing.applicationDataLength,
  );
  assert.deepEqual(await session.ping(), { responseFieldCount: 5 });
  await session.close();
});

test("disabled default rejects a streamed request before I/O and remains reusable", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    localAddress: "127.0.0.1",
    operationTimeoutMs: 2_000,
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: ["not-a-real", "password"].join("-"),
  });
  const streamed = encodeCpicCutFunctionRequest({
    functionName: "RFC_PING",
    imports: [{ name: "INPUT", value: Buffer.alloc(27_927) }],
  });
  assert.equal(inspectCpicRequestAppcFraming(streamed).applicationDataLength, 28_001);

  await assert.rejects(session.exchange(streamed), (error: unknown) => {
    const failure = (error as {
      readonly failure?: {
        readonly category?: unknown;
        readonly disposition?: unknown;
      };
    }).failure;
    assert.equal(failure?.category, RfcFailureCategory.Serialization);
    assert.equal(failure?.disposition, RfcConnectionDisposition.Reusable);
    return true;
  });
  assert.equal(peer.regularRequestCount(0), 0);
  assert.equal(peer.streamedApplicationBytes(0), 0);
  assert.deepEqual(await session.ping(), { responseFieldCount: 5 });
  await session.close();
});

test("malformed synchronous-send acknowledgement is terminal partial transmission", async () => {
  const transport = new GatedTransport();
  const write = writeOutgoingAppcDataPlan(
    transport,
    readySetup(),
    barrierPlan(),
  );
  for (let index = 0; index < 22; index += 1) {
    await waitForWrite(transport, index + 1);
    transport.writes[index]!.resolve();
  }
  await waitForRead(transport, 1);
  transport.reads[0]!.resolve(barrierAcknowledgement(Buffer.from("OTHER001")));
  await assert.rejects(write, (error: unknown) => {
    assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
    assert.equal(
      (error as DirectCpicOutgoingWriteError).transmission,
      RfcTransmissionState.Partial,
    );
    assert.match(
      String((error as DirectCpicOutgoingWriteError).cause),
      /acknowledgement identity changed/,
    );
    return true;
  });
  assert.equal(transport.writes.length, 22);
  assert.equal(transport.closeCount, 1);
});

test("unexpected APPC controls at a barrier are terminal and send no terminator", async () => {
  const controls = [AppcFunction.Deallocate, 0xd7, 0xd8];
  for (const functionCode of controls) {
    const transport = new GatedTransport();
    const write = writeOutgoingAppcDataPlan(
      transport,
      readySetup(),
      barrierPlan(),
    );
    for (let index = 0; index < 22; index += 1) {
      await waitForWrite(transport, index + 1);
      transport.writes[index]!.resolve();
    }
    await waitForRead(transport, 1);
    const control = encodeAppcControlRecord({
      functionCode: AppcFunction.Deallocate,
      conversationId: Buffer.from("CONV0001"),
    });
    control[1] = functionCode;
    transport.reads[0]!.resolve(control);

    await assert.rejects(write, (error: unknown) => {
      assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
      assert.equal(
        (error as DirectCpicOutgoingWriteError).transmission,
        RfcTransmissionState.Partial,
      );
      assert.match(
        String((error as DirectCpicOutgoingWriteError).cause),
        /acknowledgement|F_DEALLOCATE|UNKNOWN/,
      );
      return true;
    });
    assert.equal(transport.writes.length, 22);
    assert.equal(transport.closeCount, 1);
  }
});

test("direct session rejects 1400001 application bytes before I/O and stays reusable", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{ kind: "fields", fields: successfulRegularFields() }],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    localAddress: "127.0.0.1",
    operationTimeoutMs: 2_000,
    cpicStreaming: "enabled",
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: ["not-a-real", "password"].join("-"),
  });
  const oversized = requestWithExactApplicationLength(
    DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH + 1,
  );

  await assert.rejects(session.exchange(oversized), (error: unknown) => {
    const failure = (error as {
      readonly failure?: {
        readonly category?: unknown;
        readonly disposition?: unknown;
        readonly cause?: unknown;
      };
    }).failure;
    assert.equal(failure?.category, RfcFailureCategory.Serialization);
    assert.equal(failure?.disposition, RfcConnectionDisposition.Reusable);
    assert.match(String(failure?.cause), /limit 1400000/);
    return true;
  });
  assert.equal(peer.regularRequestCount(0), 0);
  assert.deepEqual(await session.ping(), { responseFieldCount: 5 });
  assert.equal(peer.regularRequestCount(0), 1);
  await session.close();
});

test("response identity correlates conversation and connection but not sequence", () => {
  const message = {
    data: Buffer.from("response"),
    conversationId: Buffer.from("CONV0001"),
    sequenceNumber: 0xfedc_ba98,
    fragmentCount: 1,
    communicationIndex: 0,
    connectionIndex: 6,
  } as const;
  assert.doesNotThrow(() =>
    assertDirectCpicResponseIdentity(message, Buffer.from("CONV0001"), 6),
  );
  for (const invalid of [
    { ...message, conversationId: Buffer.from("OTHER001") },
    { ...message, communicationIndex: 1 },
    { ...message, connectionIndex: 7 },
  ]) {
    assert.throws(
      () =>
        assertDirectCpicResponseIdentity(
          invalid,
          Buffer.from("CONV0001"),
          6,
        ),
      /response identity does not match/,
    );
  }
});

async function assertAppcWriteFailureIsTerminal(
  label: string,
  failAt: number,
  expectedTransmission: RfcTransmissionState,
): Promise<void> {
  const transport = new GatedTransport();
  const original = new Error(`synthetic ${label} write failure`);
  const write = writeOutgoingAppcDataPlan(
    transport,
    readySetup(),
    threeFragmentPlan(),
  );

  for (let index = 0; index < failAt; index += 1) {
    await waitForWrite(transport, index + 1);
    transport.writes[index]!.resolve();
  }
  await waitForWrite(transport, failAt + 1);
  transport.writes[failAt]!.reject(original);

  await assert.rejects(write, (error: unknown) => {
    assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
    const failure = error as DirectCpicOutgoingWriteError;
    assert.equal(failure.transmission, expectedTransmission);
    assert.equal(failure.cause, original);
    return true;
  });
  assert.equal(transport.writes.length, failAt + 1);
  assert.equal(transport.closeCount, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.writes.length, failAt + 1);
}

test("first APPC write failure is terminal and never replayed", async () => {
  await assertAppcWriteFailureIsTerminal("first", 0, RfcTransmissionState.Unknown);
});

test("middle APPC write failure is terminal and never replayed", async () => {
  await assertAppcWriteFailureIsTerminal("middle", 1, RfcTransmissionState.Partial);
});

test("final APPC write failure is terminal and never replayed", async () => {
  await assertAppcWriteFailureIsTerminal("final", 2, RfcTransmissionState.Partial);
});

test("write failure remains primary when terminal transport close also fails", async () => {
  const transport = new GatedTransport();
  transport.closeError = new Error("synthetic close failure");
  const original = new Error("synthetic write failure");
  const write = writeOutgoingAppcDataPlan(
    transport,
    readySetup(),
    threeFragmentPlan(),
  );
  await waitForWrite(transport, 1);
  transport.writes[0]!.reject(original);

  await assert.rejects(write, (error: unknown) => {
    assert.equal((error as DirectCpicOutgoingWriteError).cause, original);
    return true;
  });
  assert.equal(transport.closeCount, 1);
});

test("write failure remains primary when terminal close throws synchronously", async () => {
  const transport = new GatedTransport();
  const original = new Error("synthetic write failure");
  let closeCount = 0;
  Object.defineProperty(transport, "close", {
    value() {
      closeCount += 1;
      throw new Error("synthetic synchronous close failure");
    },
  });
  const write = writeOutgoingAppcDataPlan(
    transport,
    readySetup(),
    threeFragmentPlan(),
  );
  await waitForWrite(transport, 1);
  transport.writes[0]!.reject(original);

  await assert.rejects(write, (error: unknown) => {
    assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
    assert.equal((error as DirectCpicOutgoingWriteError).cause, original);
    return true;
  });
  assert.equal(closeCount, 1);
});

test("setup failure after a completed fragment is terminal partial transmission", async () => {
  const transport = new GatedTransport();
  const setup = readySetup();
  const write = writeOutgoingAppcDataPlan(
    transport,
    setup,
    threeFragmentPlan(),
  );
  await waitForWrite(transport, 1);
  setup.sent(AppcFunction.Receive, true);
  setup.received(applicationResponse());
  setup.responseComplete();
  setup.sent(AppcFunction.Deallocate);
  transport.writes[0]!.resolve();

  await assert.rejects(write, (error: unknown) => {
    assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
    assert.equal(
      (error as DirectCpicOutgoingWriteError).transmission,
      RfcTransmissionState.Partial,
    );
    return true;
  });
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.closeCount, 1);
});

test("whole-plan identity/order preflight rejects before the first write", async () => {
  const transport = new GatedTransport();
  const plan = threeFragmentPlan();
  const forged = [
    plan[0]!,
    { ...plan[1]!, sequenceNumber: plan[1]!.sequenceNumber + 1 },
    plan[2]!,
  ];

  await assert.rejects(
    writeOutgoingAppcDataPlan(transport, readySetup(), forged),
    /identity changed between fragments/,
  );
  assert.equal(transport.writes.length, 0);
  assert.equal(transport.closeCount, 0);
});

test("whole-plan preflight snapshots each caller array element once", async () => {
  const transport = new GatedTransport();
  const plan = threeFragmentPlan();
  const reads = [0, 0, 0];
  const supplied = { length: plan.length } as Record<number | "length", unknown>;
  for (const index of plan.keys()) {
    Object.defineProperty(supplied, index, {
      get() {
        reads[index]! += 1;
        return reads[index] === 1
          ? plan[index]
          : { ...plan[index]!, conversationId: Buffer.from("OTHER001") };
      },
    });
  }
  const write = writeOutgoingAppcDataPlan(
    transport,
    readySetup(),
    supplied as unknown as readonly AppcOutgoingDataFragment[],
  );
  for (const index of plan.keys()) {
    await waitForWrite(transport, index + 1);
    assert.deepEqual(
      decodeAppcHeader(transport.writes[index]!.payload).conversationId,
      Buffer.from("CONV0001"),
    );
    transport.writes[index]!.resolve();
  }
  await write;
  assert.deepEqual(reads, [1, 1, 1]);
});

test("whole-plan preflight bounds caller-forged fragment arrays", async () => {
  const transport = new GatedTransport();
  const [fragment] = threeFragmentPlan();
  assert.ok(fragment);
  const forged = Array.from(
    { length: DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS + 1 },
    () => fragment,
  );

  await assert.rejects(
    writeOutgoingAppcDataPlan(transport, readySetup(), forged),
    /fragment count.*exceeds.*limit/,
  );
  assert.equal(transport.writes.length, 0);
  assert.equal(transport.closeCount, 0);
});

test("invokeClassic honors a caller request bound before transport I/O", async () => {
  const session = Object.create(
    DirectCpicSession.prototype,
  ) as DirectCpicSession;
  let exchanges = 0;
  let metadataLookups = 0;
  Object.defineProperties(session, {
    getFunctionInterface: {
      value: async () => {
        metadataLookups += 1;
        return ({
        name: "Z_LIMIT",
        remoteBasxmlSupported: false,
        remoteCall: "R",
        updateTask: false,
        parameters: [{
          parameterClass: "I",
          parameterName: "INPUT",
          tableName: "",
          fieldName: "",
          exid: "C",
          position: 1,
          offset: 0,
          internalLength: 1,
          decimals: 0,
          defaultValue: "",
          parameterText: "",
          optional: false,
        }],
        exceptions: [],
        resumableExceptionRowCount: 0,
        });
      },
    },
    exchange: {
      value: async () => {
        exchanges += 1;
        return Buffer.alloc(0);
      },
    },
  });

  await assert.rejects(
    session.invokeClassic(
      "Z_LIMIT",
      { INPUT: "A" },
      undefined,
      { maxApplicationDataLength: 1 },
    ),
    /application length exceeds configured limit 1/,
  );
  assert.equal(exchanges, 0);
  assert.equal(metadataLookups, 1);
  await assert.rejects(
    session.invokeClassic(
      "Z_LIMIT",
      { INPUT: "A" },
      undefined,
      { maxApplicationDataLength: -1 },
    ),
    /maxApplicationDataLength/,
  );
  assert.equal(metadataLookups, 1);
});

test("invokeClassicWithMetadata snapshots input and activation state at the session boundary", async () => {
  const metadata: RfcFunctionInterface = Object.freeze({
    name: "Z_ACTIVATION",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([Object.freeze({
      parameterClass: "I",
      parameterName: "OPTIONAL_TEXT",
      tableName: "",
      fieldName: "",
      exid: "C",
      position: 1,
      offset: 0,
      internalLength: 1,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: true,
    })]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const session = Object.create(
    DirectCpicSession.prototype,
  ) as DirectCpicSession;
  const transportReached = new Error("transport reached");
  let exchanges = 0;
  const requests: Buffer[] = [];
  Object.defineProperty(session, "exchange", {
    value: async (request: Uint8Array) => {
      exchanges += 1;
      requests.push(Buffer.from(request));
      throw transportReached;
    },
  });

  await assert.rejects(
    session.invokeClassicWithMetadata(
      metadata,
      {},
      new Map(),
      undefined,
      { activated: new Set(["UNKNOWN"]) },
    ),
    (error: unknown) =>
      error instanceof DirectCpicPreWireError &&
      error.message === "activated contains unknown parameter UNKNOWN" &&
      error.cause instanceof Error &&
      error.cause.message === "activated contains unknown parameter UNKNOWN",
  );
  assert.equal(exchanges, 0);

  let oversizedValueReads = 0;
  const oversizedInput = Object.create(null) as Record<string, unknown>;
  for (const name of ["FIRST", "SECOND"]) {
    Object.defineProperty(oversizedInput, name, {
      enumerable: true,
      get() {
        oversizedValueReads += 1;
        return "must not be read";
      },
    });
  }
  await assert.rejects(
    session.invokeClassicWithMetadata(
      metadata,
      oversizedInput,
      new Map(),
    ),
    (error: unknown) =>
      error instanceof DirectCpicPreWireError &&
      error.cause instanceof Error &&
      error.cause.message ===
        "input parameter count exceeds metadata parameter count 1",
  );
  assert.equal(oversizedValueReads, 0);
  assert.equal(exchanges, 0);

  await assert.rejects(
    session.invokeClassicWithMetadata(
      metadata,
      { OPTIONAL_TEXT: Symbol("ignored") },
      new Map(),
      undefined,
      { deactivated: new Set(["OPTIONAL_TEXT"]) },
    ),
    (error: unknown) => error === transportReached,
  );
  assert.equal(exchanges, 1);

  const changingMetadata: RfcFunctionInterface = Object.freeze({
    ...metadata,
    parameters: Object.freeze([Object.freeze({
      ...metadata.parameters[0]!,
      parameterClass: "C",
      parameterName: "OPTIONAL_CHANGING",
    })]),
  });
  let ownKeysCalls = 0;
  const changingInput = new Proxy(Object.create(null) as Record<string, unknown>, {
    ownKeys() {
      ownKeysCalls += 1;
      return ownKeysCalls === 1 ? [] : ["OPTIONAL_CHANGING"];
    },
    getOwnPropertyDescriptor() {
      return {
        configurable: true,
        enumerable: true,
        value: "",
        writable: true,
      };
    },
    get(_target, property) {
      return property === "OPTIONAL_CHANGING" ? "" : undefined;
    },
  });
  let maximumReads = 0;
  const changingOptions = Object.create(null) as ClassicRfcInvocationOptions;
  Object.defineProperty(changingOptions, "maxApplicationDataLength", {
    enumerable: true,
    get() {
      maximumReads += 1;
      return 1_000;
    },
  });
  await assert.rejects(
    session.invokeClassicWithMetadata(
      changingMetadata,
      changingInput,
      new Map(),
      undefined,
      changingOptions,
    ),
    (error: unknown) => error === transportReached,
  );
  assert.equal(exchanges, 2);
  assert.equal(ownKeysCalls, 1);
  assert.equal(maximumReads, 1);
  const volatileFields = decodeCpicFieldChainPrefix(
    requests[1]!.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.equal(
    volatileFields.some((field) =>
      field.tag === CpicTag.RequestedOutput ||
      field.tag === CpicTag.ParameterName
    ),
    false,
  );
});

test("invokeClassic retains nested input while structure metadata is pending", async () => {
  const metadata: RfcFunctionInterface = Object.freeze({
    name: "Z_STRUCTURE_SNAPSHOT",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([
      Object.freeze({
        parameterClass: "I",
        parameterName: "ROW",
        tableName: "Z_ROW",
        fieldName: "",
        exid: "u",
        position: 1,
        offset: 0,
        internalLength: 2,
        decimals: 0,
        defaultValue: "",
        parameterText: "",
        optional: true,
      }),
      Object.freeze({
        parameterClass: "C",
        parameterName: "OPTIONAL_CHANGING",
        tableName: "",
        fieldName: "",
        exid: "C",
        position: 2,
        offset: 0,
        internalLength: 1,
        decimals: 0,
        defaultValue: "",
        parameterText: "",
        optional: true,
      }),
    ]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
  const definition: RfcStructureDefinition = Object.freeze({
    name: "Z_ROW",
    byteLength: 2,
    fields: Object.freeze([Object.freeze({
      tableName: "Z_ROW",
      fieldName: "TEXT",
      position: 1,
      offset: 0,
      internalLength: 2,
      decimals: 0,
      exid: "C",
    })]),
  });
  let structureStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    structureStarted = resolve;
  });
  let releaseStructure!: (value: RfcStructureDefinition) => void;
  const structure = new Promise<RfcStructureDefinition>((resolve) => {
    releaseStructure = resolve;
  });
  const session = Object.create(
    DirectCpicSession.prototype,
  ) as DirectCpicSession;
  let metadataStarted!: () => void;
  const startedMetadata = new Promise<void>((resolve) => {
    metadataStarted = resolve;
  });
  let releaseMetadata!: (value: RfcFunctionInterface) => void;
  const functionMetadata = new Promise<RfcFunctionInterface>((resolve) => {
    releaseMetadata = resolve;
  });
  Object.defineProperty(session, "getFunctionInterface", {
    value: async () => {
      metadataStarted();
      return functionMetadata;
    },
  });
  Object.defineProperty(session, "getStructureDefinition", {
    value: async (name: string) => {
      assert.equal(name, "Z_ROW");
      structureStarted();
      return structure;
    },
  });
  Object.defineProperty(session, "getOptimizedRecursiveFunctionDescriptor", {
    value: async () => ({ value: undefined }),
  });
  const transportReached = new Error("transport reached");
  let request: Buffer | undefined;
  Object.defineProperty(session, "exchange", {
    value: async (value: Uint8Array) => {
      request = Buffer.from(value);
      throw transportReached;
    },
  });

  const row = { TEXT: "A" };
  const activated = new Set<string>();
  const call = session.invokeClassic(
    "Z_STRUCTURE_SNAPSHOT",
    { ROW: row },
    undefined,
    { activated },
  );
  await startedMetadata;
  row.TEXT = "M";
  activated.add("OPTIONAL_CHANGING");
  releaseMetadata(metadata);
  await started;
  row.TEXT = "Z";
  releaseStructure(definition);
  await assert.rejects(call, (error: unknown) => error === transportReached);

  assert.ok(request !== undefined);
  const fields = decodeCpicFieldChainPrefix(
    request.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  const rowName = fields.findIndex((field) =>
    field.tag === CpicTag.ParameterName &&
    Buffer.from(field.value).toString("utf16le") === "ROW"
  );
  assert.ok(rowName >= 0);
  assert.equal(fields[rowName + 1]!.tag, CpicTag.ParameterValue);
  assert.equal(
    Buffer.from(fields[rowName + 1]!.value).toString("utf16le"),
    "A",
  );
  assert.equal(
    fields.some((field) =>
      (field.tag === CpicTag.RequestedOutput ||
        field.tag === CpicTag.ParameterName) &&
      Buffer.from(field.value).toString("utf16le") === "OPTIONAL_CHANGING"
    ),
    false,
  );
});
