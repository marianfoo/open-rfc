import assert from "node:assert/strict";
import test from "node:test";

import {
  APPC_RECORD_HEADER_LENGTH,
  APPC_PROTOCOL_VERSION,
  AppcConversationDecoder,
  AppcClientSetupStateMachine,
  AppcFunction,
  decodeAppcExtendedInfo,
  decodeAppcExtendedInitializeOptions,
  decodeAppcInitializeParameters,
  decodeAppcPartnerLogicalUnitParameters,
  decodeAppcPartnerLogicalUnitInfo,
  decodeAppcDataFragment,
  decodeAppcHeader,
  encodeAppcControlRecord,
  encodeAppcDataRecord,
  encodeAppcExtendedInfo,
  encodeAppcExtendedInitializeOptions,
  encodeAppcInitializeParameters,
  encodeAppcPartnerLogicalUnitParameters,
  encodeAppcPartnerLogicalUnitInfo,
  inspectAppcPayload,
} from "../src/protocol/appc.js";

const extendedInitializeOptions = {
  optionFlags: 1,
  rootId: "0123456789ABCDEF",
  connectionId: "FEDCBA9876543210",
  connectionIdSuffix: 1,
  timeout: -2,
  keepaliveTimeout: -2,
  exportTrace: 2,
  startType: 0,
  networkProtocol: 0,
  localAddressV6: Buffer.alloc(16),
  longLogicalUnitName: "127.0.0.1",
  operatingSystemUser: "open-rfc",
  localAddressV4: Buffer.alloc(4),
  longTransactionProgramName: "sapdp00",
} as const;

function dataRecord(
  fn: AppcFunction,
  vector: number,
  data: Uint8Array,
  conversationId = "CONV0001",
  sequenceNumber = 7,
): Buffer {
  const record = Buffer.alloc(APPC_RECORD_HEADER_LENGTH + data.byteLength);
  record[0] = APPC_PROTOCOL_VERSION;
  record[1] = fn;
  record.writeUInt32BE(sequenceNumber, 22);
  record[31] = vector;
  Buffer.from(conversationId).copy(record, 40);
  record.writeUInt16BE(34_048, 50);
  record.writeUInt16BE(data.byteLength, 58);
  record.writeUInt16BE(0, 76);
  record.writeUInt16BE(6, 78);
  Buffer.from(data).copy(record, APPC_RECORD_HEADER_LENGTH);
  return record;
}

test("recognizes the APPC functions seen in the controlled oracle capture", () => {
  const info = inspectAppcPayload(
    Buffer.from([APPC_PROTOCOL_VERSION, AppcFunction.SapSend]),
  );
  assert.deepEqual(info, {
    protocolVersion: 0x06,
    functionCode: 0xcb,
    functionName: "F_SAP_SEND",
  });
  assert.equal(
    inspectAppcPayload(Buffer.from([APPC_PROTOCOL_VERSION, AppcFunction.Receive]))
      .functionName,
    "F_RECEIVE",
  );
  assert.equal(
    inspectAppcPayload(
      Buffer.from([APPC_PROTOCOL_VERSION, AppcFunction.SetPartnerLuName]),
    ).functionName,
    "F_SET_PARTNER_LU_NAME",
  );
});

test("encodes and decodes F_SET_PARTNER_LU_NAME operation info", () => {
  const partnerHostAddress = Buffer.from(
    "00000000000000000000ffff7f000001",
    "hex",
  );
  const encoded = encodeAppcPartnerLogicalUnitInfo({
    logicalUnitName: "NWRFC",
    partnerHostAddress,
    communicationIndex: 0xffff,
    connectionIndex: 6,
  });

  assert.equal(encoded.byteLength, 32);
  assert.equal(encoded.subarray(0, 8).toString(), "NWRFC   ");
  assert.equal(encoded.readUInt32BE(8), 5);
  assert.deepEqual(decodeAppcPartnerLogicalUnitInfo(encoded), {
    logicalUnitNamePrefix: "NWRFC",
    logicalUnitNameLength: 5,
    partnerHostAddress,
    communicationIndex: 0xffff,
    connectionIndex: 6,
  });
});

test("encodes and decodes semantic extended initialization options", () => {
  const encoded = encodeAppcExtendedInitializeOptions(extendedInitializeOptions);
  assert.equal(encoded.byteLength, 341);
  assert.equal(encoded[0], 1);
  assert.equal(encoded.subarray(2, 10).toString("hex"), "4350494300000000");
  assert.equal(encoded.readInt32BE(46), -2);
  assert.equal(encoded.readInt32BE(50), -2);
  assert.deepEqual(
    decodeAppcExtendedInitializeOptions(encoded),
    extendedInitializeOptions,
  );
});

test("encodes the proven 373-byte F_INITIALIZE parameter structure", () => {
  const encoded = encodeAppcInitializeParameters({
    clientIdentifier: "NWRFC",
    options: extendedInitializeOptions,
  });
  assert.equal(encoded.byteLength, 373);
  assert.equal(encoded.subarray(0, 32).toString(), `NWRFC${" ".repeat(27)}`);
  assert.deepEqual(decodeAppcInitializeParameters(encoded), {
    clientIdentifier: "NWRFC",
    options: extendedInitializeOptions,
  });
});

test("encodes the proven 144-byte F_SET_PARTNER_LU_NAME parameters", () => {
  const parameters = {
    longLogicalUnitName: "127.0.0.1",
    partnerHostAddress: Buffer.alloc(16),
  };
  const encoded = encodeAppcPartnerLogicalUnitParameters(parameters);
  assert.equal(encoded.byteLength, 144);
  assert.equal(encoded.subarray(0, 9).toString(), "127.0.0.1");
  assert.equal(encoded.subarray(9, 128).every((byte) => byte === 0x20), true);
  assert.deepEqual(decodeAppcPartnerLogicalUnitParameters(encoded), parameters);
});

test("rejects invalid initialization IDs, padding, and address widths", () => {
  assert.throws(
    () =>
      encodeAppcExtendedInitializeOptions({
        ...extendedInitializeOptions,
        rootId: "lowercase1234567",
      }),
    /rootId.*16 uppercase hexadecimal/,
  );
  assert.throws(
    () =>
      encodeAppcExtendedInitializeOptions({
        ...extendedInitializeOptions,
        localAddressV6: Buffer.alloc(15),
      }),
    /localAddressV6.*exactly 16 bytes/,
  );
  const malformedPadding = encodeAppcExtendedInitializeOptions(
    extendedInitializeOptions,
  );
  malformedPadding[10 + 16 + 16 + 4 + 4 + 4 + 1 + 1 + 1 + 16 + 20] = 0;
  malformedPadding[10 + 16 + 16 + 4 + 4 + 4 + 1 + 1 + 1 + 16 + 21] = 0x41;
  assert.throws(
    () => decodeAppcExtendedInitializeOptions(malformedPadding),
    /longLogicalUnitName contains data after its first padding byte/,
  );
});

test("places the semantic partner operation info in the APPC control record", () => {
  const record = encodeAppcControlRecord({
    functionCode: AppcFunction.SetPartnerLuName,
    partnerLogicalUnitInfo: {
      logicalUnitName: "NWRFC",
      partnerHostAddress: Buffer.alloc(16),
      communicationIndex: 0xffff,
      connectionIndex: 6,
    },
    parameters: Buffer.alloc(144),
  });

  assert.equal(record.byteLength, 224);
  assert.equal(record.subarray(48, 56).toString(), "NWRFC   ");
  assert.equal(record.readUInt32BE(56), 5);
  assert.equal(decodeAppcHeader(record).sapParameterLength, 144);
});

test("rejects malformed or misplaced partner operation info", () => {
  assert.throws(
    () =>
      encodeAppcPartnerLogicalUnitInfo({
        logicalUnitName: "NWRFC",
        partnerHostAddress: Buffer.alloc(15),
        communicationIndex: 0,
        connectionIndex: 0,
      }),
    /partnerHostAddress.*exactly 16 bytes/,
  );
  const badLength = Buffer.alloc(32);
  Buffer.from("NWRFC   ").copy(badLength);
  badLength.writeUInt32BE(4, 8);
  assert.throws(
    () => decodeAppcPartnerLogicalUnitInfo(badLength),
    /prefix length 5 does not match declared length 4/,
  );
  assert.throws(
    () => encodeAppcControlRecord({ functionCode: AppcFunction.SetPartnerLuName }),
    /requires partnerLogicalUnitInfo/,
  );
  assert.throws(
    () =>
      encodeAppcControlRecord({
        functionCode: AppcFunction.Allocate,
        partnerLogicalUnitInfo: {
          logicalUnitName: "NWRFC",
          partnerHostAddress: Buffer.alloc(16),
          communicationIndex: 0,
          connectionIndex: 0,
        },
      }),
    /only valid for F_SET_PARTNER_LU_NAME/,
  );
});

test("retains unknown function codes for future protocol expansion", () => {
  assert.equal(inspectAppcPayload(Buffer.from([0x06, 0xaa])).functionName, "UNKNOWN_0xaa");
});

test("rejects unsupported protocol versions", () => {
  assert.throws(() => inspectAppcPayload(Buffer.from([0x05, 0xcb])), /unsupported/);
});

test("decodes the fixed version-6 APPC common header", () => {
  const header = Buffer.alloc(48);
  header[0] = 0x06;
  header[1] = AppcFunction.Allocate;
  header[2] = 0x02;
  header[3] = 0x03;
  header.writeUInt16BE(0x1234, 4);
  header.writeUInt16BE(0x5678, 6);
  header.writeUInt16BE(9, 8);
  header[10] = 0xaa;
  header[11] = 4;
  header.writeUInt32BE(0x1020_3040, 12);
  header[16] = 0xbb;
  header.writeInt32BE(-1, 17);
  header[21] = 0xcc;
  header.writeUInt32BE(17, 22);
  header.writeUInt16BE(23, 26);
  header.writeUInt16BE(0x789a, 28);
  header[30] = 0x7b;
  header[31] = 0x04;
  header.writeUInt32BE(5, 32);
  header.writeUInt32BE(6, 36);
  Buffer.from("CONV1234").copy(header, 40);

  const decoded = decodeAppcHeader(header);
  assert.equal(decoded.functionName, "F_ALLOCATE");
  assert.equal(decoded.uid, 0x1234);
  assert.equal(decoded.gatewayId, 0x5678);
  assert.equal(decoded.timeout, -1);
  assert.equal(decoded.sequenceNumber, 17);
  assert.equal(decoded.padding, 0x789a);
  assert.equal(decoded.info, 0x7b);
  assert.equal(decoded.sapReturnCode, 6);
  assert.equal(decoded.conversationId.toString(), "CONV1234");
});

test("rejects a truncated APPC common header", () => {
  assert.throws(() => decodeAppcHeader(Buffer.alloc(47)), /needs 48 bytes/);
});

test("encodes and decodes the semantic 32-byte extended connection info", () => {
  const encoded = encodeAppcExtendedInfo({
    shortDestinationName: "NWRFC",
    logicalUnitName: "127.0.0.",
    transactionProgramName: "sapdp00",
    connectionType: 0x49,
    clientInfo: 1,
    communicationIndex: 0xffff,
    connectionIndex: 6,
  });

  assert.equal(encoded.byteLength, 32);
  assert.equal(encoded.subarray(0, 8).toString(), "NWRFC   ");
  assert.deepEqual(decodeAppcExtendedInfo(encoded), {
    shortDestinationName: "NWRFC",
    logicalUnitName: "127.0.0.",
    transactionProgramName: "sapdp00",
    connectionType: 0x49,
    clientInfo: 1,
    communicationIndex: 0xffff,
    connectionIndex: 6,
  });
});

test("rejects non-ASCII or oversized extended connection names", () => {
  const base = {
    shortDestinationName: "NWRFC",
    logicalUnitName: "LOCAL",
    transactionProgramName: "sapdp00",
    connectionType: 0x49,
    clientInfo: 1,
    communicationIndex: 0,
    connectionIndex: 0,
  };
  assert.throws(
    () => encodeAppcExtendedInfo({ ...base, logicalUnitName: "123456789" }),
    /logicalUnitName.*at most 8 ASCII bytes/,
  );
  assert.throws(
    () => encodeAppcExtendedInfo({ ...base, logicalUnitName: "ümlaut" }),
    /logicalUnitName.*ASCII/,
  );
});

test("derives control-record lengths from semantic parameter bytes", () => {
  const parameters = Buffer.from([1, 2, 3, 4]);
  const encoded = encodeAppcControlRecord({
    functionCode: AppcFunction.Initialize,
    info2: 1,
    info3: 0xc0,
    info4: 4,
    info: 5,
    extendedInfo: {
      shortDestinationName: "NWRFC",
      logicalUnitName: "LOCAL",
      transactionProgramName: "sapdp00",
      connectionType: 0x49,
      clientInfo: 1,
      communicationIndex: 0xffff,
      connectionIndex: 6,
    },
    parameters,
  });

  assert.equal(encoded.byteLength, APPC_RECORD_HEADER_LENGTH + parameters.byteLength);
  const header = decodeAppcHeader(encoded);
  assert.equal(header.functionCode, AppcFunction.Initialize);
  assert.equal(header.protocol, 2);
  assert.equal(header.uid, 0xffff);
  assert.equal(header.sapParameterLength, parameters.byteLength);
  assert.deepEqual(encoded.subarray(APPC_RECORD_HEADER_LENGTH), parameters);
});

test("encodes the proven client F_SAP_SEND data-record defaults", () => {
  const record = encodeAppcDataRecord({
    conversationId: Buffer.from("CONV0001"),
    communicationIndex: 0xffff,
    connectionIndex: 6,
    data: Buffer.from("payload"),
  });
  const header = decodeAppcHeader(record);
  assert.equal(record.byteLength, 87);
  assert.equal(header.functionCode, AppcFunction.SapSend);
  assert.equal(header.sapParameterLength, 8);
  assert.equal(header.info, 5);
  assert.equal(header.vector, 0x0c);
  assert.equal(header.conversationId.toString(), "CONV0001");
  assert.equal(record.readUInt16BE(76), 0xffff);
  assert.equal(record.readUInt16BE(78), 6);
  assert.equal(record.subarray(80).toString(), "payload");
});

test("marks non-final F_SAP_SEND fragments without changing application bytes", () => {
  const record = encodeAppcDataRecord({
    communicationIndex: 1,
    connectionIndex: 2,
    isFinal: false,
    data: Buffer.from([0, 1, 2]),
  });
  assert.equal(decodeAppcHeader(record).vector, 0x08);
  assert.deepEqual(record.subarray(80), Buffer.from([0, 1, 2]));
});

test("uses the observed NUL-filled extension when control names are absent", () => {
  const encoded = encodeAppcControlRecord({ functionCode: AppcFunction.Allocate });
  assert.deepEqual(encoded.subarray(48, 72), Buffer.alloc(24));
});

test("control encoder rejects data functions, oversized parameters, and bad conversation IDs", () => {
  assert.throws(
    () => encodeAppcControlRecord({ functionCode: AppcFunction.SapSend }),
    /F_SAP_SEND.*not a setup\/control function/,
  );
  assert.throws(
    () =>
      encodeAppcControlRecord({
        functionCode: AppcFunction.Initialize,
        parameters: Buffer.alloc(0x1_0000),
      }),
    /parameter length.*65535/,
  );
  assert.throws(
    () =>
      encodeAppcControlRecord({
        functionCode: AppcFunction.Allocate,
        conversationId: Buffer.alloc(7),
      }),
    /conversationId.*exactly 8 bytes/,
  );
});

test("enforces the proven client setup and teardown sequence", () => {
  const state = new AppcClientSetupStateMachine();
  assert.equal(state.state, "new");
  state.sent(AppcFunction.Initialize);
  assert.equal(state.state, "initialize-pending");
  state.received(
    encodeAppcControlRecord({ functionCode: AppcFunction.Initialize }),
  );
  assert.equal(state.state, "initialized");
  state.sent(AppcFunction.SetPartnerLuName);
  assert.equal(state.state, "partner-set");
  state.sent(AppcFunction.Allocate);
  assert.equal(state.state, "allocate-pending");
  state.received(encodeAppcControlRecord({ functionCode: AppcFunction.Allocate }));
  assert.equal(state.state, "ready");
  state.sent(AppcFunction.SapSend);
  state.received(dataRecord(AppcFunction.SapSend, 0x0c, Buffer.alloc(0)));
  assert.equal(state.state, "response-pending");
  state.responseComplete();
  state.sent(AppcFunction.Deallocate);
  assert.equal(state.state, "closed");
});

test("rejects illegal setup transitions and failed peer replies", () => {
  const outOfOrder = new AppcClientSetupStateMachine();
  assert.throws(
    () => outOfOrder.sent(AppcFunction.Allocate),
    /cannot send F_ALLOCATE while APPC client is new/,
  );

  const failed = new AppcClientSetupStateMachine();
  failed.sent(AppcFunction.Initialize);
  const reply = encodeAppcControlRecord({ functionCode: AppcFunction.Initialize });
  reply.writeUInt32BE(6, 32);
  assert.throws(() => failed.received(reply), /F_INITIALIZE.*APPC return code 6/);
  assert.equal(failed.state, "closed");

  const truncated = new AppcClientSetupStateMachine();
  truncated.sent(AppcFunction.Initialize);
  truncated.received(
    encodeAppcControlRecord({ functionCode: AppcFunction.Initialize }),
  );
  truncated.sent(AppcFunction.SetPartnerLuName);
  truncated.sent(AppcFunction.Allocate);
  assert.throws(
    () => truncated.received(
      encodeAppcControlRecord({ functionCode: AppcFunction.Allocate })
        .subarray(0, 48),
    ),
    /APPC reply needs 80 bytes/u,
  );
  assert.equal(truncated.state, "closed");
});

test("admits only a normal-deallocation data reply for terminal RFC decoding", () => {
  const terminal = new AppcClientSetupStateMachine();
  terminal.sent(AppcFunction.Initialize);
  terminal.received(
    encodeAppcControlRecord({ functionCode: AppcFunction.Initialize }),
  );
  terminal.sent(AppcFunction.SetPartnerLuName);
  terminal.sent(AppcFunction.Allocate);
  terminal.received(
    encodeAppcControlRecord({ functionCode: AppcFunction.Allocate }),
  );
  terminal.sent(AppcFunction.SapSend);
  const normalDeallocation = dataRecord(
    AppcFunction.Receive,
    0x0c,
    Buffer.from("terminal RFC envelope"),
  );
  normalDeallocation.writeUInt32BE(18, 32);
  assert.equal(
    terminal.received(normalDeallocation),
    "normal-deallocation",
  );
  assert.equal(terminal.state, "closed");

  for (const current of [
    { appcReturnCode: 17, sapReturnCode: 0 },
    { appcReturnCode: 18, sapReturnCode: 1 },
  ]) {
    const failed = new AppcClientSetupStateMachine();
    failed.sent(AppcFunction.Initialize);
    assert.throws(
      () => failed.received(encodeAppcControlRecord({
        functionCode: AppcFunction.Initialize,
        ...current,
      })),
      /failed with APPC return code/u,
    );
    assert.equal(failed.state, "closed");
  }
});

test("decodes the application data after the observed 80-byte APPC record header", () => {
  const fragment = decodeAppcDataFragment(
    dataRecord(AppcFunction.SapSend, 0x0c, Buffer.from("complete")),
  );
  assert.equal(fragment.header.functionName, "F_SAP_SEND");
  assert.equal(fragment.isFinal, true);
  assert.equal(fragment.data.toString(), "complete");
});

test("assembles one complete F_SAP_SEND record", () => {
  const decoder = new AppcConversationDecoder();
  const messages = decoder.push(
    dataRecord(AppcFunction.SapSend, 0x0c, Buffer.from("one")),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data.toString(), "one");
  assert.equal(messages[0]?.fragmentCount, 1);
  assert.equal(messages[0]?.conversationId.toString(), "CONV0001");
  assert.equal(decoder.bufferedByteLength, 0);
  decoder.finish();
});

test("uses normal deallocation as the terminal delimiter for its RFC payload", () => {
  const terminal = dataRecord(
    AppcFunction.SapSend,
    0x08,
    Buffer.from("complete terminal envelope"),
  );
  terminal.writeUInt32BE(18, 32);
  const decoder = new AppcConversationDecoder();
  const messages = decoder.pushTerminalDeallocation(terminal);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data.toString(), "complete terminal envelope");
  assert.equal(messages[0]?.fragmentCount, 1);
  assert.equal(decoder.bufferedByteLength, 0);
  decoder.finish();

  assert.throws(
    () => new AppcConversationDecoder().push(terminal),
    /normal deallocation must use the terminal decoder/u,
  );
  const empty = dataRecord(AppcFunction.SapSend, 0x08, Buffer.alloc(0));
  empty.writeUInt32BE(18, 32);
  assert.throws(
    () => new AppcConversationDecoder().pushTerminalDeallocation(empty),
    /connection closed without message \(CM_NO_DATA_RECEIVED\)/u,
  );
  const ordinary = dataRecord(
    AppcFunction.SapSend,
    0x08,
    Buffer.from("not terminal"),
  );
  assert.throws(
    () => new AppcConversationDecoder().pushTerminalDeallocation(ordinary),
    /requires APPC return code 18/u,
  );

  const orphanedReceive = dataRecord(
    AppcFunction.Receive,
    0x08,
    Buffer.from("orphaned terminal receive"),
  );
  orphanedReceive.writeUInt32BE(18, 32);
  assert.throws(
    () => new AppcConversationDecoder().pushTerminalDeallocation(orphanedReceive),
    /terminal F_RECEIVE without a preceding F_SAP_SEND/u,
  );
  assert.equal(
    new AppcConversationDecoder({ allowInitialReceive: true })
      .pushTerminalDeallocation(orphanedReceive)[0]?.data.toString(),
    "orphaned terminal receive",
  );

  const first = dataRecord(
    AppcFunction.SapSend,
    0x08,
    Buffer.from("fragment "),
  );
  const last = dataRecord(
    AppcFunction.Receive,
    0x08,
    Buffer.from("at deallocation"),
  );
  last.writeUInt32BE(18, 32);
  const fragmented = new AppcConversationDecoder();
  assert.deepEqual(fragmented.push(first), []);
  const assembled = fragmented.pushTerminalDeallocation(last);
  assert.equal(assembled[0]?.data.toString(), "fragment at deallocation");
  assert.equal(assembled[0]?.fragmentCount, 2);
  fragmented.finish();
});

test("assembles F_SAP_SEND plus multiple F_RECEIVE continuations", () => {
  const decoder = new AppcConversationDecoder();
  assert.deepEqual(
    decoder.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("first-"))),
    [],
  );
  assert.deepEqual(
    decoder.push(dataRecord(AppcFunction.Receive, 0x00, Buffer.from("middle-"))),
    [],
  );
  const messages = decoder.push(
    dataRecord(AppcFunction.Receive, 0x0c, Buffer.from("last")),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.data.toString(), "first-middle-last");
  assert.equal(messages[0]?.fragmentCount, 3);
  decoder.finish();
});

test("rejects a continuation without a preceding send", () => {
  const decoder = new AppcConversationDecoder();
  assert.throws(
    () => decoder.push(dataRecord(AppcFunction.Receive, 0x0c, Buffer.from("orphan"))),
    /F_RECEIVE.*without.*F_SAP_SEND/,
  );
});

test("rejects conversation and sequence changes within a fragmented message", () => {
  const conversationDecoder = new AppcConversationDecoder();
  conversationDecoder.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("a")));
  assert.throws(
    () =>
      conversationDecoder.push(
        dataRecord(AppcFunction.Receive, 0x0c, Buffer.from("b"), "CONV0002"),
      ),
    /conversation ID changed/,
  );

  const sequenceDecoder = new AppcConversationDecoder();
  sequenceDecoder.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("a")));
  assert.throws(
    () =>
      sequenceDecoder.push(
        dataRecord(AppcFunction.Receive, 0x0c, Buffer.from("b"), "CONV0001", 8),
      ),
    /sequence number changed/,
  );
});

test("enforces message byte and fragment limits before retaining more data", () => {
  const byteLimited = new AppcConversationDecoder({ maxMessageLength: 3 });
  byteLimited.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("abc")));
  let continuationDataObserved = false;
  class ObservedContinuation extends Uint8Array {
    override subarray(begin?: number, end?: number): Uint8Array<ArrayBuffer> {
      if (begin === APPC_RECORD_HEADER_LENGTH) continuationDataObserved = true;
      return super.subarray(begin, end);
    }
  }
  const overLimitContinuation = new ObservedContinuation(
    dataRecord(AppcFunction.Receive, 0x0c, Buffer.from("d")),
  );
  assert.throws(
    () => byteLimited.push(overLimitContinuation),
    /message length 4 exceeds configured limit 3/,
  );
  assert.equal(
    continuationDataObserved,
    false,
    "an over-budget continuation must fail before the application bytes are observed or copied",
  );

  const fragmentLimited = new AppcConversationDecoder({ maxFragments: 2 });
  fragmentLimited.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("a")));
  fragmentLimited.push(dataRecord(AppcFunction.Receive, 0x00, Buffer.from("b")));
  assert.throws(
    () => fragmentLimited.push(dataRecord(AppcFunction.Receive, 0x0c, Buffer.from("c"))),
    /fragment count 3 exceeds configured limit 2/,
  );
});

test("rejects a new send, control record, or end-of-stream during a continuation", () => {
  const sendDecoder = new AppcConversationDecoder();
  sendDecoder.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("a")));
  assert.throws(
    () => sendDecoder.push(dataRecord(AppcFunction.SapSend, 0x0c, Buffer.from("b"))),
    /new F_SAP_SEND.*fragmented message/,
  );

  const controlDecoder = new AppcConversationDecoder();
  controlDecoder.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("a")));
  assert.throws(
    () => controlDecoder.push(dataRecord(AppcFunction.Deallocate, 0, Buffer.alloc(0))),
    /F_DEALLOCATE.*interrupted.*fragmented message/,
  );

  const finishDecoder = new AppcConversationDecoder();
  finishDecoder.push(dataRecord(AppcFunction.SapSend, 0x08, Buffer.from("a")));
  assert.throws(() => finishDecoder.finish(), /truncated APPC message.*1 fragment.*1 bytes/);
});
