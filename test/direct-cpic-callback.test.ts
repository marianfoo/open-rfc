import assert from "node:assert/strict";
import test from "node:test";

import { DirectCpicSession } from "../src/client/direct-cpic-session.js";
import type { RfcFunctionInterface } from
  "../src/metadata/rfc-function-interface.js";
import {
  decodeCpicFunctionResultFields,
  encodeCpicCutFunctionRequest,
} from "../src/protocol/cpic.js";
import { DEFAULT_MAX_RFC_CALLBACKS_PER_CALL } from
  "../src/protocol/rfc-callback.js";
import { decodeClassicRfcResult } from "../src/protocol/classic-rfc.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

const OUTER_METADATA: RfcFunctionInterface = Object.freeze({
  name: "Z_CALLBACK_OUTER",
  remoteBasxmlSupported: false,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([]),
  exceptions: Object.freeze([]),
  resumableExceptionRowCount: 0,
});

function callbackRequest(functionName: string, text: string): Buffer {
  const framed = encodeCpicCutFunctionRequest({
    functionName,
    requestedOutputs: ["ECHOTEXT"],
    imports: [{
      name: "REQUTEXT",
      value: Buffer.from(text.padEnd(20, " "), "utf16le"),
    }],
  });
  // An incoming APPC data message contains application data; its compact SAP8
  // trailer is carried by the APPC record rather than inside message.data.
  return framed.subarray(0, framed.byteLength - 8);
}

test("services multiple DESTINATION BACK callbacks before the outer response", async (t) => {
  const callbackResponses: ReturnType<typeof decodeCpicFunctionResultFields>[] = [];
  const peer = await ScriptedRfcPeer.start([{
    replies: [{
      kind: "callbacks",
      requests: [
        callbackRequest("STFC_CONNECTION", "one"),
        callbackRequest("Z_DECLARED_CALLBACK", "declared"),
        callbackRequest("Z_UNKNOWN_CALLBACK", "two"),
      ],
      final: { kind: "fields", fields: successfulRegularFields() },
      inspectResponse(response) {
        callbackResponses.push(decodeCpicFunctionResultFields(response));
      },
    }],
  }]);
  t.after(() => peer.close());

  const seen: string[] = [];
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    operationTimeoutMs: 1_000,
    callbacks: {
      STFC_CONNECTION(request, context) {
        assert.equal(context.callbackIndex, 1);
        assert.equal(request.requestedOutputs[0], "ECHOTEXT");
        const imported = request.imports[0]!;
        assert.equal(imported.name, "REQUTEXT");
        seen.push(imported.value.toString("utf16le").trimEnd());
        return {
          exports: [{ name: "ECHOTEXT", value: imported.value }],
        };
      },
      Z_DECLARED_CALLBACK(_request, context) {
        assert.equal(context.callbackIndex, 2);
        return { exception: "NO_AUTHORITY" };
      },
    },
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: "not-a-real-password",
  });

  const output = await session.invokeClassicWithMetadata(
    OUTER_METADATA,
    {},
    new Map(),
  );
  assert.deepEqual(output, {});
  assert.deepEqual(seen, ["one"]);
  assert.equal(callbackResponses.length, 3);
  assert.equal(callbackResponses[0]!.success, true);
  assert.equal(
    decodeClassicRfcResult(callbackResponses[0]!.fields)
      .scalars[0]!.value.toString("utf16le").trimEnd(),
    "one",
  );
  assert.equal(callbackResponses[1]!.success, false);
  assert.equal(
    callbackResponses[1]!.envelope.facts.exceptionKey,
    "NO_AUTHORITY",
  );
  assert.equal(callbackResponses[2]!.success, false);
  assert.equal(
    callbackResponses[2]!.envelope.facts.exceptionKey,
    "FU_NOT_FOUND",
  );
  assert.equal(peer.regularRequestCount(0), 1);
  await session.close();
});

test("fails closed when a business call receives an unconfigured callback", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{
      kind: "callbacks",
      requests: [callbackRequest("STFC_CONNECTION", "blocked")],
      final: { kind: "fields", fields: successfulRegularFields() },
    }],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    operationTimeoutMs: 1_000,
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: "not-a-real-password",
  });
  await assert.rejects(
    session.invokeClassicWithMetadata(OUTER_METADATA, {}, new Map()),
    /RFC_INVALID_PROTOCOL/u,
  );
  assert.equal(session.state, "closed");
});

test("fails closed when a callback handler attempts asynchronous work", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{
      kind: "callbacks",
      requests: [callbackRequest("Z_ASYNC_CALLBACK", "blocked")],
      final: { kind: "fields", fields: successfulRegularFields() },
    }],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    operationTimeoutMs: 1_000,
    callbacks: {
      Z_ASYNC_CALLBACK: (() => Promise.resolve({})) as never,
    },
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: "not-a-real-password",
  });
  await assert.rejects(
    session.invokeClassicWithMetadata(OUTER_METADATA, {}, new Map()),
    /RFC_INVALID_PROTOCOL/u,
  );
  assert.equal(session.state, "closed");
});

test("fails closed when a callback handler returns an unrequested output", async (t) => {
  const peer = await ScriptedRfcPeer.start([{
    replies: [{
      kind: "callbacks",
      requests: [callbackRequest("Z_WRONG_OUTPUT", "blocked")],
      final: { kind: "fields", fields: successfulRegularFields() },
    }],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    operationTimeoutMs: 1_000,
    callbacks: {
      Z_WRONG_OUTPUT: () => ({
        exports: [{ name: "UNREQUESTED", value: Buffer.alloc(0) }],
      }),
    },
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: "not-a-real-password",
  });
  await assert.rejects(
    session.invokeClassicWithMetadata(OUTER_METADATA, {}, new Map()),
    /RFC_INVALID_PROTOCOL/u,
  );
  assert.equal(session.state, "closed");
});

test("bounds callback recursion within one outer call", async (t) => {
  let responses = 0;
  const peer = await ScriptedRfcPeer.start([{
    replies: [{
      kind: "callbacks",
      requests: Array.from(
        { length: DEFAULT_MAX_RFC_CALLBACKS_PER_CALL + 1 },
        (_, index) => callbackRequest("Z_BOUNDED_CALLBACK", `${index}`),
      ),
      final: { kind: "fields", fields: successfulRegularFields() },
      inspectResponse() { responses += 1; },
    }],
  }]);
  t.after(() => peer.close());
  const session = await DirectCpicSession.open({
    host: "127.0.0.1",
    port: peer.port,
    applicationServerService: "sapdp00",
    operationTimeoutMs: 1_000,
    callbacks: { Z_BOUNDED_CALLBACK: () => ({}) },
  });
  await session.logonAndPing({
    client: "001",
    user: "RFCUSR",
    password: "not-a-real-password",
  });
  await assert.rejects(
    session.invokeClassicWithMetadata(OUTER_METADATA, {}, new Map()),
    /RFC_INVALID_PROTOCOL/u,
  );
  assert.equal(responses, DEFAULT_MAX_RFC_CALLBACKS_PER_CALL);
  assert.equal(session.state, "closed");
});
