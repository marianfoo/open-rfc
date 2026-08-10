import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayAcceptInfo,
  decodeGatewayNormalClient,
  encodeGatewayNormalClient,
} from "../src/protocol/gateway.js";

const clientRecord = {
  address: "127.0.0.1",
  service: "sapgw00",
  codePage: "1100",
  gatewayOptionLevel: 6,
  logicalUnit: "LOCAL",
  transactionProgram: "NWRFC",
  conversationId: "",
  appcHeaderVersion: 6,
  acceptInfo:
    GatewayAcceptInfo.ErrorInfo |
    GatewayAcceptInfo.Ping |
    GatewayAcceptInfo.ConnectionExtendedInfo |
    GatewayAcceptInfo.ExtendedInitOptions |
    GatewayAcceptInfo.DistributedTrace,
  index: -1,
  returnCode: 0,
  echoData: 0,
} as const;

test("round-trips the proven 64-byte gateway normal-client record", () => {
  const encoded = encodeGatewayNormalClient(clientRecord);
  assert.equal(encoded.byteLength, 64);
  assert.equal(encoded[0], 2);
  assert.equal(encoded[1], 3);
  assert.equal(encoded.subarray(10, 20).toString("ascii"), "sapgw00\x00\x00\x00");
  assert.deepEqual(decodeGatewayNormalClient(encoded), clientRecord);
});

test("keeps gateway padding and option level explicit", () => {
  const encoded = encodeGatewayNormalClient(clientRecord);
  assert.deepEqual(encoded.subarray(24, 29), Buffer.alloc(5));
  assert.equal(encoded[29], 6);
  assert.equal(encoded.subarray(46, 54).toString("ascii"), "        ");
});

test("rejects unsupported gateway variants and malformed fixed fields", () => {
  assert.throws(
    () => encodeGatewayNormalClient({ ...clientRecord, address: "::1" }),
    /IPv4 address/,
  );
  assert.throws(
    () => encodeGatewayNormalClient({ ...clientRecord, logicalUnit: "123456789" }),
    /logicalUnit.*at most 8 ASCII bytes/,
  );
  assert.throws(
    () => encodeGatewayNormalClient({
      ...clientRecord,
      logicalUnit: "x".repeat(1_000_000),
    }),
    /logicalUnit.*at most 8 ASCII bytes/,
  );
  const version3 = encodeGatewayNormalClient(clientRecord);
  version3[0] = 3;
  assert.throws(() => decodeGatewayNormalClient(version3), /version 3.*not implemented/);
});
