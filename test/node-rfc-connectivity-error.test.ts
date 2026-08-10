import assert from "node:assert/strict";
import test from "node:test";

import {
  RFCError,
  RFCErrorCode,
} from "../src/client/rfc-errors.js";
import { projectNodeRfcPublicError } from
  "../src/compat/node-rfc-client.js";
import {
  ConnectivitySocks5Error,
  type ConnectivitySocks5ErrorCode,
} from "../src/transport/connectivity-socks5-tunnel.js";

test("projects Connectivity SOCKS5 failures into the public RFC error contract", () => {
  const cases: ReadonlyArray<readonly [
    ConnectivitySocks5ErrorCode,
    RFCErrorCode,
    string,
  ]> = [
    ["CONNECTIVITY_SOCKS5_ABORTED", RFCErrorCode.RFC_CANCELED, "RFC_CANCELED"],
    ["CONNECTIVITY_SOCKS5_CONNECT_TIMEOUT", RFCErrorCode.RFC_TIMEOUT, "RFC_TIMEOUT"],
    ["CONNECTIVITY_SOCKS5_TIMEOUT", RFCErrorCode.RFC_TIMEOUT, "RFC_TIMEOUT"],
    [
      "CONNECTIVITY_SOCKS5_AUTHENTICATION_REJECTED",
      RFCErrorCode.RFC_COMMUNICATION_FAILURE,
      "RFC_COMMUNICATION_FAILURE",
    ],
    [
      "CONNECTIVITY_SOCKS5_CONNECT_REJECTED",
      RFCErrorCode.RFC_COMMUNICATION_FAILURE,
      "RFC_COMMUNICATION_FAILURE",
    ],
  ];

  for (const [sourceCode, expectedCode, expectedCodeString] of cases) {
    const source = new ConnectivitySocks5Error(
      sourceCode,
      "private route detail must not reach the public facade",
    );
    const projected = projectNodeRfcPublicError(source);
    assert.ok(projected instanceof RFCError);
    assert.equal(projected.code, expectedCode);
    assert.equal(projected.codeString, expectedCodeString);
    assert.equal(projected.key, sourceCode);
    assert.doesNotMatch(projected.message, /private route detail/u);
  }
});
