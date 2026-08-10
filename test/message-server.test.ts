import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeMessageServerLoginResponse,
  decodeMessageServerRfcGroupResponse,
  encodeMessageServerLoginRequest,
  encodeMessageServerLogoutRequest,
  encodeMessageServerRfcGroupRequest,
  MessageServerProtocolError,
} from "../src/protocol/message-server.js";

const GROUP = "RFC_GROUP";

const LOGIN_REQUEST = Buffer.from(
  "2a2a4d4553534147452a2a0004002d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002082d2020202020202020202020202020202020202020202020202020202020202020202020202020200000",
  "hex",
);

const LOGIN_RESPONSE = Buffer.from(
  "2a2a4d4553534147452a2a0004002d20202020202020202020202020202020202020202020202020202020202020202020202020202000000001000000000000000002084d53475f5345525645522020202020202020202020202020202020202020202020202020202020200000",
  "hex",
);

const LOGOUT_REQUEST = Buffer.from(
  "2a2a4d4553534147452a2a0004002d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042d2020202020202020202020202020202020202020202020202020202020202020202020202020200000",
  "hex",
);

const GROUP_REQUEST = Buffer.from(
  "2a2a4d4553534147452a2a0004004d53475f53455256455200000000000000000000000000000000000000000000000000000000000000000000000000000000000002012d20202020202020202020202020202020202020202020202020202020202020202020202020202000002c000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d5246435f47524f5550000000000000000000000000000000000000000000000000000000000000000100000000340000",
  "hex",
);

const GROUP_RESPONSE = Buffer.from(
  "2a2a4d4553534147452a2a0004002d20202020202020202020202020202020202020202020202020202020202020202020202020202000000000000000000000000003014d53475f53455256455200000000000000000000000000000000000000000000000000000000000000002c000103000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d5246435f47524f555000000000000000000000000000000000000000000000000000000000000000010000000c8000106170702e6578616d706c652e7465737420",
  "hex",
);

/** uint16 dispatcher port: 2 bytes before hostLength, host and the trailer. */
const DISPATCHER_PORT_OFFSET = GROUP_RESPONSE.byteLength -
  ("app.example.test".length + 5);

function mutated(source: Buffer, offset: number, value: number): Buffer {
  const copy = Buffer.from(source);
  copy[offset] = value;
  return copy;
}

function isProtocolError(
  error: unknown,
  code: MessageServerProtocolError["code"],
): boolean {
  return error instanceof MessageServerProtocolError && error.code === code;
}

test("encodes the captured version-4 login and version-1 RFC-group request shape", () => {
  assert.deepEqual(encodeMessageServerLoginRequest(), LOGIN_REQUEST);
  assert.deepEqual(encodeMessageServerRfcGroupRequest(GROUP), GROUP_REQUEST);
  assert.deepEqual(encodeMessageServerLogoutRequest(), LOGOUT_REQUEST);
  assert.doesNotThrow(() => decodeMessageServerLoginResponse(LOGIN_RESPONSE));
});

test("decodes the echoed group and derives the direct gateway route", () => {
  assert.deepEqual(
    decodeMessageServerRfcGroupResponse(GROUP_RESPONSE, GROUP),
    {
      applicationServerHost: "app.example.test",
      dispatcherPort: 3200,
      gatewayPort: 3300,
      gatewayService: "sapgw00",
      systemNumber: "00",
    },
  );
});

test("derives the same route shape at every legal dispatcher port", () => {
  // The dispatcher port is a landscape property, not a wire constant: the same
  // structure must decode identically wherever SAP put the sapdpNN block.
  const payload = Buffer.from(GROUP_RESPONSE);
  for (let dispatcherPort = 1; dispatcherPort + 100 <= 0xffff; dispatcherPort += 1) {
    payload.writeUInt16BE(dispatcherPort, DISPATCHER_PORT_OFFSET);
    const systemNumber = (dispatcherPort % 100).toString(10).padStart(2, "0");
    const expected = {
      applicationServerHost: "app.example.test",
      dispatcherPort,
      gatewayPort: dispatcherPort + 100,
      gatewayService: `sapgw${systemNumber}`,
      systemNumber,
    };
    const actual = decodeMessageServerRfcGroupResponse(payload, GROUP);
    // deepEqual only on mismatch: 65k structural diffs would dominate the suite.
    if (
      actual.applicationServerHost !== expected.applicationServerHost ||
      actual.dispatcherPort !== expected.dispatcherPort ||
      actual.gatewayPort !== expected.gatewayPort ||
      actual.gatewayService !== expected.gatewayService ||
      actual.systemNumber !== expected.systemNumber
    ) {
      assert.deepEqual(actual, expected);
    }
  }
});

test("rejects invalid group inputs before allocating a request", () => {
  for (const value of ["", "A".repeat(41), "bad\u0000group", "gr\u00fcppe"]) {
    assert.throws(
      () => encodeMessageServerRfcGroupRequest(value),
      /group must contain 1\.\.40 printable ASCII bytes/u,
    );
  }
});

test("rejects truncated, extended, and structurally inconsistent login replies", () => {
  for (const payload of [
    LOGIN_RESPONSE.subarray(0, LOGIN_RESPONSE.byteLength - 1),
    Buffer.concat([LOGIN_RESPONSE, Buffer.from([0])]),
    mutated(LOGIN_RESPONSE, 0, 0),
    mutated(LOGIN_RESPONSE, 12, 5),
    mutated(LOGIN_RESPONSE, 13, 1),
    mutated(LOGIN_RESPONSE, 57, 0),
    mutated(LOGIN_RESPONSE, 66, 3),
    mutated(LOGIN_RESPONSE, 67, 1),
  ]) {
    assert.throws(
      () => decodeMessageServerLoginResponse(payload),
      (error: unknown) =>
        isProtocolError(error, "MS_PROTOCOL_ERROR") ||
        isProtocolError(error, "MS_SERVER_REJECTED") ||
        isProtocolError(error, "MS_UNSUPPORTED_VERSION"),
    );
  }
});

test("distinguishes message-server and opcode rejection from malformed replies", () => {
  const shortServerRejection = mutated(GROUP_RESPONSE.subarray(0, 110), 13, 84);
  assert.throws(
    () => decodeMessageServerRfcGroupResponse(shortServerRejection, GROUP),
    (error: unknown) =>
      error instanceof MessageServerProtocolError &&
      error.code === "MS_SERVER_REJECTED" &&
      error.serverError === 84,
  );
  const shortOpcodeRejection = mutated(GROUP_RESPONSE.subarray(0, 114), 111, 5);
  assert.throws(
    () => decodeMessageServerRfcGroupResponse(shortOpcodeRejection, GROUP),
    (error: unknown) =>
      error instanceof MessageServerProtocolError &&
      error.code === "MS_OPCODE_REJECTED" &&
      error.opcodeError === 5,
  );
});

test("rejects every pinned type, opcode, version, charset, and echo mismatch", () => {
  for (const [offset, value] of [
    [66, 2],
    [67, 2],
    [110, 0x2d],
    [112, 2],
    [113, 0],
    [114 + 84, 2],
    [114 + 85, 1],
    [114 + 86, 1],
    [114 + 43, 0x0e],
    [114 + 44, 0x58],
  ] as const) {
    assert.throws(
      () => decodeMessageServerRfcGroupResponse(mutated(GROUP_RESPONSE, offset, value), GROUP),
      (error: unknown) =>
        isProtocolError(error, "MS_PROTOCOL_ERROR") ||
        isProtocolError(error, "MS_UNSUPPORTED_VERSION"),
    );
  }
});

test("enforces dispatcher-port, hostname, trailer, and total-length bounds", () => {
  const invalidPort = Buffer.from(GROUP_RESPONSE);
  invalidPort.writeUInt16BE(0, DISPATCHER_PORT_OFFSET);
  const unreachableGatewayBlock = Buffer.from(GROUP_RESPONSE);
  unreachableGatewayBlock.writeUInt16BE(0xffff, DISPATCHER_PORT_OFFSET);
  const longHost = Buffer.from(GROUP_RESPONSE);
  longHost.writeUInt16BE(0xffff, 114 + 90);
  const invalidHost = mutated(GROUP_RESPONSE, 114 + 92, 0);
  const invalidTrailer = mutated(
    GROUP_RESPONSE,
    GROUP_RESPONSE.byteLength - 1,
    0,
  );
  for (const payload of [
    invalidPort,
    unreachableGatewayBlock,
    longHost,
    invalidHost,
    invalidTrailer,
    GROUP_RESPONSE.subarray(0, GROUP_RESPONSE.byteLength - 1),
    Buffer.concat([GROUP_RESPONSE, Buffer.from([0])]),
  ]) {
    assert.throws(
      () => decodeMessageServerRfcGroupResponse(payload, GROUP),
      (error: unknown) => isProtocolError(error, "MS_PROTOCOL_ERROR"),
    );
  }
});

test("does not accept a response for a different requested group", () => {
  assert.throws(
    () => decodeMessageServerRfcGroupResponse(GROUP_RESPONSE, "OTHER"),
    (error: unknown) => isProtocolError(error, "MS_PROTOCOL_ERROR"),
  );
});
