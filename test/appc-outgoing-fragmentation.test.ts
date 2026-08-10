import assert from "node:assert/strict";
import test from "node:test";

import {
  APPC_FINAL_SAP_PARAMETER_LENGTH,
  APPC_RECORD_HEADER_LENGTH,
  DEFAULT_MAX_APPC_MESSAGE_LENGTH,
  MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
  MAX_APPC_ASYNC_SENDS_BEFORE_SYNC,
  MAX_APPC_OUTGOING_MESSAGE_LENGTH,
  AppcClientSetupStateMachine,
  AppcConversationDecoder,
  AppcFunction,
  decodeAppcAsyncDataInfo,
  decodeAppcSynchronousSendAcknowledgement,
  decodeAppcDataFragment,
  decodeAppcExtendedInfo,
  decodeAppcHeader,
  decodeAppcIncomingDataOperationInfo,
  encodeAppcControlRecord,
  encodeAppcDataRecord,
  encodeOutgoingAppcDataFragment,
  planOutgoingAppcDataFragments,
  type AppcOutgoingDataFragment,
} from "../src/protocol/appc.js";

const conversationId = Buffer.from("CONV0001");
const sequenceNumber = 0x0102_0304;
const communicationIndex = 0xabcd;
const connectionIndex = 0x1234;

function patternedBytes(length: number): Buffer {
  const data = Buffer.allocUnsafe(length);
  for (let index = 0; index < data.byteLength; index += 1) {
    data[index] = index % 251;
  }
  return data;
}

function finalSapParameters(applicationDataLength: number): Buffer {
  const parameters = Buffer.alloc(APPC_FINAL_SAP_PARAMETER_LENGTH);
  parameters.writeUInt16BE(applicationDataLength, 2);
  parameters.writeUInt32BE(0x8500, 4);
  return parameters;
}

function compactPlan(
  applicationData: Uint8Array,
): readonly AppcOutgoingDataFragment[] {
  return planOutgoingAppcDataFragments(
    {
      conversationId,
      sequenceNumber,
      communicationIndex,
      connectionIndex,
      applicationData,
      finalSapParameters: finalSapParameters(applicationData.byteLength),
    },
    { cpicStreaming: "enabled" },
  );
}

function streamedPlan(
  applicationData: Uint8Array,
): readonly AppcOutgoingDataFragment[] {
  return planOutgoingAppcDataFragments(
    {
      conversationId,
      sequenceNumber,
      communicationIndex,
      connectionIndex,
      applicationData,
    },
    { cpicStreaming: "enabled" },
  );
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
  assert.equal(setup.state, "ready");
  return setup;
}

test("keeps compact CPIC application data through 28,000 bytes in one F_SAP_SEND", () => {
  const boundary = MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH;
  for (const length of [0, 1, boundary - 1, boundary]) {
    const applicationData = patternedBytes(length);
    const [fragment, ...unexpected] = compactPlan(applicationData);
    assert.ok(fragment);
    assert.deepEqual(unexpected, []);
    assert.equal(Object.isFrozen(fragment), true);
    assert.equal(fragment.functionCode, AppcFunction.SapSend);
    assert.equal(fragment.fragmentIndex, 0);
    assert.equal(fragment.fragmentCount, 1);
    assert.equal(fragment.isFinal, true);
    assert.equal(fragment.info, 5);
    assert.equal(fragment.vector, 0x0c);
    assert.equal(fragment.sapParameterLength, 8);

    const record = encodeOutgoingAppcDataFragment(fragment);
    const header = decodeAppcHeader(record);
    const operationInfo = decodeAppcExtendedInfo(record.subarray(48, 80));
    const decoded = decodeAppcDataFragment(record);
    assert.equal(header.functionCode, AppcFunction.SapSend);
    assert.equal(header.sapParameterLength, 8);
    assert.equal(header.sequenceNumber, sequenceNumber);
    assert.deepEqual(header.conversationId, conversationId);
    assert.equal(operationInfo.communicationIndex, communicationIndex);
    assert.equal(operationInfo.connectionIndex, connectionIndex);
    assert.deepEqual(decoded.data.subarray(0, length), applicationData);
    assert.deepEqual(decoded.data.subarray(length), finalSapParameters(length));
  }
});

test("switches strictly above 28,000 bytes to F_ASEND_DATA plus empty F_RECEIVE", () => {
  const boundary = MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH;
  for (const length of [boundary + 1, 2 * boundary, 2 * boundary + 1]) {
    const applicationData = patternedBytes(length);
    const fragments = streamedPlan(applicationData);
    const dataFragmentCount = Math.ceil(length / boundary);
    assert.equal(fragments.length, dataFragmentCount + 1);
    assert.equal(Object.isFrozen(fragments), true);

    const reconstructed: Buffer[] = [];
    for (let index = 0; index < dataFragmentCount; index += 1) {
      const fragment = fragments[index]!;
      const expectedLength = Math.min(boundary, length - index * boundary);
      assert.equal(fragment.functionCode, AppcFunction.AsyncSendData);
      assert.equal(fragment.fragmentIndex, index);
      assert.equal(fragment.fragmentCount, dataFragmentCount + 1);
      assert.equal(fragment.isFinal, false);
      assert.equal(fragment.info, 0);
      assert.equal(fragment.vector, 0);
      assert.equal(fragment.sapParameterLength, 0);
      assert.equal(fragment.finalSapParameters.byteLength, 0);

      const record = encodeOutgoingAppcDataFragment(fragment);
      const header = decodeAppcHeader(record);
      assert.equal(header.functionCode, AppcFunction.AsyncSendData);
      assert.equal(header.info, 0);
      assert.equal(header.vector, 0);
      assert.equal(header.sapParameterLength, 0);
      assert.deepEqual(
        decodeAppcAsyncDataInfo(record.subarray(48, 80)),
        { dataLength: expectedLength, communicationIndex, connectionIndex },
      );
      const body = record.subarray(APPC_RECORD_HEADER_LENGTH);
      assert.equal(body.byteLength, expectedLength);
      assert.deepEqual(body, fragment.applicationData);
      reconstructed.push(body);
    }

    const terminator = fragments.at(-1)!;
    assert.equal(terminator.functionCode, AppcFunction.Receive);
    assert.equal(terminator.isFinal, true);
    assert.equal(terminator.info, 1);
    assert.equal(terminator.vector, 0);
    assert.equal(terminator.sapParameterLength, 0);
    assert.equal(terminator.applicationData.byteLength, 0);
    assert.equal(terminator.finalSapParameters.byteLength, 0);
    const terminatorRecord = encodeOutgoingAppcDataFragment(terminator);
    assert.equal(terminatorRecord.byteLength, APPC_RECORD_HEADER_LENGTH);
    const terminatorHeader = decodeAppcHeader(terminatorRecord);
    assert.equal(terminatorHeader.functionCode, AppcFunction.Receive);
    assert.equal(terminatorHeader.info, 1);
    assert.equal(terminatorHeader.vector, 0);
    assert.equal(terminatorHeader.sapParameterLength, 0);
    assert.deepEqual(
      decodeAppcAsyncDataInfo(terminatorRecord.subarray(48, 80)),
      {
        dataLength: MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
        communicationIndex,
        connectionIndex,
      },
    );

    assert.deepEqual(Buffer.concat(reconstructed), applicationData);
  }
});

test("streams CPIC packets above the UINT2 range without compact SAP parameters", () => {
  const applicationData = patternedBytes(65_536);
  const fragments = streamedPlan(applicationData);
  assert.equal(fragments.length, 4);
  assert.deepEqual(
    fragments.map((fragment) => fragment.functionCode),
    [
      AppcFunction.AsyncSendData,
      AppcFunction.AsyncSendData,
      AppcFunction.AsyncSendData,
      AppcFunction.Receive,
    ],
  );
  assert.deepEqual(
    fragments.map((fragment) => fragment.applicationData.byteLength),
    [28_000, 28_000, 9_536, 0],
  );
  assert.equal(
    fragments.every((fragment) => fragment.finalSapParameters.byteLength === 0),
    true,
  );
  assert.deepEqual(
    Buffer.concat(
      fragments
        .filter(({ functionCode }) => functionCode === AppcFunction.AsyncSendData)
        .map(({ applicationData: part }) => part),
    ),
    applicationData,
  );
});

test("inserts the captured periodic synchronous-send barriers", () => {
  const applicationData = patternedBytes(
    50 * MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
  );
  const fragments = streamedPlan(applicationData);
  assert.equal(MAX_APPC_ASYNC_SENDS_BEFORE_SYNC, 21);
  assert.deepEqual(
    fragments.map(({ functionCode }) => functionCode),
    [
      ...Array(21).fill(AppcFunction.AsyncSendData),
      AppcFunction.SendData,
      ...Array(20).fill(AppcFunction.AsyncSendData),
      AppcFunction.SendData,
      ...Array(7).fill(AppcFunction.AsyncSendData),
      AppcFunction.Receive,
    ],
  );
  for (const fragment of fragments.filter(
    ({ functionCode }) => functionCode === AppcFunction.SendData,
  )) {
    assert.equal(fragment.info, 1);
    assert.equal(fragment.vector, 0);
    assert.equal(fragment.sapParameterLength, 0);
    assert.equal(fragment.isFinal, false);
    const record = encodeOutgoingAppcDataFragment(fragment);
    assert.deepEqual(decodeAppcAsyncDataInfo(record.subarray(48, 80)), {
      dataLength: MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
      communicationIndex,
      connectionIndex,
    });
    assert.equal(
      record.subarray(APPC_RECORD_HEADER_LENGTH).byteLength,
      MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
    );
  }
});

test("planner snapshots caller-owned byte buffers before exposing its plan", () => {
  const source = patternedBytes(73);
  const expected = Buffer.from(source);
  const callerConversationId = Buffer.from(conversationId);
  const callerSapParameters = finalSapParameters(source.byteLength);
  const expectedSapParameters = Buffer.from(callerSapParameters);
  const [fragment] = planOutgoingAppcDataFragments({
    conversationId: callerConversationId,
    sequenceNumber,
    communicationIndex,
    connectionIndex,
    applicationData: source,
    finalSapParameters: callerSapParameters,
  });
  assert.ok(fragment);

  source.fill(0xff);
  callerConversationId.fill(0x20);
  callerSapParameters.fill(0xff);

  assert.deepEqual(fragment.applicationData, expected);
  assert.deepEqual(fragment.conversationId, conversationId);
  assert.deepEqual(fragment.finalSapParameters, expectedSapParameters);
});

test("planner uses intrinsic typed-array geometry for bounds and snapshots", () => {
  const oversized = new Uint8Array(50_000);
  Object.defineProperty(oversized, "byteLength", { value: 28_001 });
  assert.throws(
    () => planOutgoingAppcDataFragments({
      conversationId,
      sequenceNumber,
      communicationIndex,
      connectionIndex,
      applicationData: oversized,
    }, {
      cpicStreaming: "enabled",
      maxApplicationDataLength: 28_001,
    }),
    /application data length 50000 exceeds configured limit 28001/,
  );

  const streamed = patternedBytes(28_001);
  Object.defineProperty(streamed, "length", { value: 1_500_000 });
  const fragments = planOutgoingAppcDataFragments({
    conversationId,
    sequenceNumber,
    communicationIndex,
    connectionIndex,
    applicationData: streamed,
  }, {
    cpicStreaming: "enabled",
    maxApplicationDataLength: 28_001,
  });
  assert.equal(
    fragments.reduce(
      (total, fragment) => total + fragment.applicationData.byteLength,
      0,
    ),
    28_001,
  );
});

test("planner reads each caller accessor once and emits only that snapshot", () => {
  const source = patternedBytes(MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH + 3);
  const expectedSource = Buffer.from(source);
  const reads = new Map<string, number>();
  const input = Object.create(null) as Record<string, unknown>;
  const defineAccessor = <T>(name: string, first: T, later: T): void => {
    Object.defineProperty(input, name, {
      enumerable: true,
      get(): T {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return count === 1 ? first : later;
      },
    });
  };

  for (const [name, value] of Object.entries({
    protocol: 2,
    mode: 0,
    uid: 0xffff,
    gatewayId: 0,
    errorLength: 0,
    info2: 0,
    traceLevel: 0,
    time: 0,
    info3: 0,
    timeout: 0,
    info4: 0,
    sequenceNumber,
    padding: 0,
    info: 0,
    vector: 0,
    appcReturnCode: 0,
    sapReturnCode: 0,
    communicationIndex,
    connectionIndex,
  })) {
    defineAccessor(name, value, value === 0 ? 1 : 0);
  }
  defineAccessor("conversationId", conversationId, Buffer.from("LATER001"));
  defineAccessor("applicationData", source, Buffer.alloc(1));
  defineAccessor("finalSapParameters", undefined, Buffer.alloc(7));

  const fragments = planOutgoingAppcDataFragments(
    input as unknown as Parameters<typeof planOutgoingAppcDataFragments>[0],
    { cpicStreaming: "enabled" },
  );
  assert.deepEqual(
    Buffer.concat(
      fragments
        .filter(({ functionCode }) => functionCode === AppcFunction.AsyncSendData)
        .map(({ applicationData }) => applicationData),
    ),
    expectedSource,
  );
  assert.deepEqual(fragments[0]!.conversationId, conversationId);
  assert.equal(fragments[0]!.sequenceNumber, sequenceNumber);
  assert.equal(fragments[0]!.communicationIndex, communicationIndex);
  assert.equal(fragments[0]!.connectionIndex, connectionIndex);
  assert.equal(
    fragments.every((fragment) => fragment.finalSapParameters.byteLength === 0),
    true,
  );
  for (const [name, count] of reads) {
    assert.equal(count, 1, `${name} must be read exactly once`);
  }
  assert.equal(reads.size, 22);
});

test("planner fails closed on invalid limits, modes, SAP parameters, and indices", () => {
  const input = {
    conversationId,
    sequenceNumber,
    communicationIndex,
    connectionIndex,
    applicationData: Buffer.alloc(2),
    finalSapParameters: finalSapParameters(2),
  } as const;

  for (const maxApplicationDataLength of [
    -1,
    1.5,
    MAX_APPC_OUTGOING_MESSAGE_LENGTH + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => planOutgoingAppcDataFragments(input, { maxApplicationDataLength }),
      /maxApplicationDataLength/,
    );
  }
  assert.doesNotThrow(() =>
    planOutgoingAppcDataFragments(input, {
      maxApplicationDataLength: DEFAULT_MAX_APPC_MESSAGE_LENGTH,
    }),
  );
  assert.throws(
    () => planOutgoingAppcDataFragments(input, { maxApplicationDataLength: 1 }),
    /application data length 2 exceeds configured limit 1/,
  );

  for (const maxFragments of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => planOutgoingAppcDataFragments(input, { maxFragments }),
      /maxFragments/,
    );
  }
  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        applicationData: Buffer.alloc(28_001),
        finalSapParameters: undefined,
      }, {
        maxFragments: 2,
        cpicStreaming: "enabled",
      }),
    /fragment count 3 exceeds configured limit 2/,
  );

  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        finalSapParameters: Buffer.alloc(7),
      }),
    /finalSapParameters.*exactly 8 bytes/,
  );
  const reserved = finalSapParameters(2);
  reserved.writeUInt16BE(1, 0);
  assert.throws(
    () => planOutgoingAppcDataFragments({ ...input, finalSapParameters: reserved }),
    /reserved field must be zero/,
  );
  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        finalSapParameters: finalSapParameters(1),
      }),
    /declare 1 application bytes.*received 2/,
  );
  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        applicationData: Buffer.alloc(28_000),
        finalSapParameters: undefined,
      }),
    /streamed CPIC packet.*must exceed 28000 bytes/,
  );
  assert.doesNotThrow(() => streamedPlan(Buffer.alloc(28_001)));
  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        applicationData: Buffer.alloc(28_001),
        finalSapParameters: undefined,
      }),
    /CPIC streaming is disabled.*enable this destination/,
  );
  assert.throws(
    () =>
      planOutgoingAppcDataFragments(input, {
        cpicStreaming: "automatic" as "enabled",
      }),
    /cpicStreaming must be disabled or enabled/,
  );
  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        conversationId: Buffer.alloc(7),
      }),
    /conversationId.*exactly 8 bytes/,
  );
  assert.throws(
    () => planOutgoingAppcDataFragments({ ...input, sequenceNumber: -1 }),
    /sequenceNumber.*0\.\.4294967295/,
  );
  assert.throws(
    () =>
      planOutgoingAppcDataFragments({
        ...input,
        communicationIndex: 0x1_0000,
      }),
    /communicationIndex.*0\.\.65535/,
  );
});

test("planned-record encoder rejects forged positional and payload semantics", () => {
  const [only] = compactPlan(Buffer.from("one"));
  assert.ok(only);
  for (const invalid of [
    { ...only, functionCode: AppcFunction.Receive },
    { ...only, vector: 0x08 },
    { ...only, info: 1 },
    { ...only, sapParameterLength: 0 },
    { ...only, fragmentIndex: 1 },
    { ...only, fragmentCount: 2 },
    {
      ...only,
      applicationData: Buffer.alloc(
        MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH + 1,
      ),
    },
    { ...only, finalSapParameters: Buffer.alloc(0) },
    { ...only, finalSapParameters: undefined },
    { ...only, messageApplicationDataLength: 2 },
  ] as unknown as AppcOutgoingDataFragment[]) {
    assert.throws(
      () => encodeOutgoingAppcDataFragment(invalid),
      /invalid outgoing APPC fragment/,
    );
  }

  const async = streamedPlan(Buffer.alloc(28_001));
  assert.throws(
    () =>
      encodeOutgoingAppcDataFragment({
        ...async[0]!,
        finalSapParameters: Buffer.alloc(8),
      }),
    /F_ASEND_DATA cannot carry SAP parameters/,
  );
  assert.throws(
    () =>
      encodeOutgoingAppcDataFragment({
        ...async.at(-1)!,
        applicationData: Buffer.of(1),
      }),
    /F_RECEIVE terminator must be empty/,
  );
});

test("decodes and rejects malformed F_ASEND_DATA operation information", () => {
  const [fragment] = streamedPlan(Buffer.alloc(28_001));
  assert.ok(fragment);
  const record = encodeOutgoingAppcDataFragment(fragment);
  assert.deepEqual(decodeAppcAsyncDataInfo(record.subarray(48, 80)), {
    dataLength: 28_000,
    communicationIndex,
    connectionIndex,
  });
  for (const malformed of [
    record.subarray(48, 79),
    Buffer.concat([record.subarray(48, 80), Buffer.of(0)]),
  ]) {
    assert.throws(() => decodeAppcAsyncDataInfo(malformed), /exactly 32 bytes/);
  }
  const reserved = Buffer.from(record.subarray(48, 80));
  reserved[4] = 1;
  assert.throws(
    () => decodeAppcAsyncDataInfo(reserved),
    /reserved bytes must be zero/,
  );
});

test("decodes only the canonical empty synchronous-send acknowledgement", () => {
  const acknowledgement = encodeAppcDataRecord({
    functionCode: AppcFunction.SendData,
    conversationId,
    sequenceNumber: 0,
    communicationIndex: 0,
    connectionIndex,
    info4: 2,
    isFinal: false,
    data: Buffer.alloc(0),
  });
  const decoded = decodeAppcSynchronousSendAcknowledgement(acknowledgement);
  assert.deepEqual(decoded.header.conversationId, conversationId);
  assert.equal(decoded.connectionIndex, connectionIndex);

  const trailing = Buffer.concat([acknowledgement, Buffer.of(0)]);
  assert.throws(
    () => decodeAppcSynchronousSendAcknowledgement(trailing),
    /exactly 80 bytes/,
  );
  const wrongHeader = Buffer.from(acknowledgement);
  wrongHeader[30] = 0;
  assert.throws(
    () => decodeAppcSynchronousSendAcknowledgement(wrongHeader),
    /header is not canonical/,
  );
  for (const offset of [2, 3, 4, 6, 8, 10, 11, 12, 16, 17, 22, 26, 28, 31, 32, 36]) {
    const malformed = Buffer.from(acknowledgement);
    malformed[offset] = malformed[offset]! ^ 1;
    assert.throws(
      () => decodeAppcSynchronousSendAcknowledgement(malformed),
      /header is not canonical/,
      `header offset ${offset}`,
    );
  }
  for (let offset = 48; offset < 78; offset += 1) {
    const malformed = Buffer.from(acknowledgement);
    malformed[offset] = 1;
    assert.throws(
      () => decodeAppcSynchronousSendAcknowledgement(malformed),
      /operation information is not canonical/,
      `operation-info offset ${offset - 48}`,
    );
  }
});

test("client setup state machine allows only the captured async-send sequence", () => {
  const setup = readySetup();
  assert.throws(
    () => setup.sent(AppcFunction.SapSend, false),
    /F_SAP_SEND cannot start a streamed outgoing message/,
  );
  setup.sent(AppcFunction.AsyncSendData, false);
  assert.equal(setup.state, "send-continuation");
  setup.sent(AppcFunction.AsyncSendData, false);
  assert.equal(setup.state, "send-continuation");
  assert.throws(
    () => setup.sent(AppcFunction.Deallocate),
    /cannot send F_DEALLOCATE.*send-continuation/,
  );
  assert.throws(
    () => setup.sent(AppcFunction.Receive, false),
    /F_RECEIVE terminator must be final/,
  );
  setup.sent(AppcFunction.Receive, true);
  assert.equal(setup.state, "response-pending");
  assert.throws(
    () => setup.sent(AppcFunction.Receive),
    /cannot send F_RECEIVE.*response-pending/,
  );
});

test("client setup waits for the synchronous-send barrier acknowledgement", () => {
  const setup = readySetup();
  setup.sent(AppcFunction.AsyncSendData, false);
  setup.sent(AppcFunction.SendData, false);
  assert.equal(setup.state, "send-barrier-pending");
  assert.throws(
    () => setup.sent(AppcFunction.AsyncSendData, false),
    /cannot send F_ASEND_DATA.*send-barrier-pending/,
  );
  const acknowledgement = encodeAppcDataRecord({
    functionCode: AppcFunction.SendData,
    conversationId,
    communicationIndex: 0,
    connectionIndex,
    info4: 2,
    isFinal: false,
    data: Buffer.alloc(0),
  });
  setup.received(acknowledgement);
  assert.equal(setup.state, "send-continuation");
  setup.sent(AppcFunction.Receive, true);
  assert.equal(setup.state, "response-pending");
});

test("initial F_RECEIVE responses require explicit async-outgoing context", () => {
  const response = encodeAppcDataRecord({
    functionCode: AppcFunction.Receive,
    conversationId,
    sequenceNumber: sequenceNumber + 1,
    communicationIndex,
    connectionIndex,
    data: Buffer.from("response"),
  });
  response.writeUInt16BE(34_048, 50);
  response.writeUInt16BE(response.byteLength - 80, 58);
  assert.throws(
    () => new AppcConversationDecoder().push(response),
    /F_RECEIVE.*without.*F_SAP_SEND/,
  );
  const decoder = new AppcConversationDecoder({ allowInitialReceive: true });
  const [message] = decoder.push(response);
  assert.ok(message);
  assert.equal(message.data.toString(), "response");
  assert.equal(message.sequenceNumber, sequenceNumber + 1);
  decoder.finish();
  assert.throws(
    () =>
      new AppcConversationDecoder({
        allowInitialReceive: 1 as unknown as boolean,
      }),
    /allowInitialReceive must be a boolean/,
  );
});

test("incoming records use actual length at buffer-info offset 10", () => {
  const response = encodeAppcDataRecord({
    functionCode: AppcFunction.SapSend,
    conversationId,
    communicationIndex: 0,
    connectionIndex,
    data: Buffer.from("reply"),
  });
  response.writeUInt16BE(34_048, 50);
  response.writeUInt16BE(response.byteLength - 80, 58);
  assert.deepEqual(
    decodeAppcIncomingDataOperationInfo(response.subarray(48, 80)),
    {
      dataLength: 5,
      communicationIndex: 0,
      connectionIndex,
    },
  );
  const [message] = new AppcConversationDecoder({
    validateIncomingDataOperationInfo: true,
  }).push(response);
  assert.equal(message?.data.toString(), "reply");

  const inconsistent = Buffer.from(response);
  inconsistent.writeUInt16BE(4, 58);
  assert.throws(
    () =>
      new AppcConversationDecoder({
        validateIncomingDataOperationInfo: true,
      }).push(inconsistent),
    /data length 4 does not match record payload length 5/,
  );
});

test("generic conversation decoding remains valid for client compact records", () => {
  const request = encodeAppcDataRecord({
    conversationId,
    communicationIndex: 0xffff,
    connectionIndex,
    data: Buffer.from("request"),
  });
  const [message] = new AppcConversationDecoder().push(request);
  assert.equal(message?.data.toString(), "request");
  assert.equal(message?.communicationIndex, 0xffff);
  assert.equal(message?.connectionIndex, connectionIndex);
  assert.throws(
    () =>
      new AppcConversationDecoder({
        validateIncomingDataOperationInfo: 1 as unknown as boolean,
      }),
    /validateIncomingDataOperationInfo must be a boolean/,
  );
});
