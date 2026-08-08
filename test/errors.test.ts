import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  ABAPError,
  RFCError,
  rfcFailureToPublicError,
} from "../src/client/rfc-errors.js";
import { createRemoteRfcFailure } from "../src/client/rfc-failure.js";
import {
  RFC_ERROR_ENVELOPE_END_TAG,
  RfcErrorTag,
  decodeRfcErrorEnvelope,
  type RfcErrorEnvelopeField,
} from "../src/protocol/rfc-error-envelope.js";

test("exposes a node-rfc-compatible declared ABAP exception shape", () => {
  const error = new ABAPError(createRemoteRfcFailure(
    decodeRfcErrorEnvelope([
      text(RfcErrorTag.MessageClass, "SR"),
      text(RfcErrorTag.MessageType, "E"),
      text(RfcErrorTag.MessageNumber, "006"),
      text(RfcErrorTag.MessageV1, "Method = 1"),
      text(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
      end(),
    ]),
    { establishedSession: true },
  ));

  assert.equal(error instanceof Error, true);
  assert.equal(error instanceof RFCError, true);
  assert.deepEqual(
    {
      name: error.name,
      group: error.group,
      code: error.code,
      codeString: error.codeString,
      key: error.key,
      abapMsgClass: error.abapMsgClass,
      abapMsgType: error.abapMsgType,
      abapMsgNumber: error.abapMsgNumber,
      abapMsgV1: error.abapMsgV1,
      abapMsgV2: error.abapMsgV2,
      abapMsgV3: error.abapMsgV3,
      abapMsgV4: error.abapMsgV4,
      message: error.message,
    },
    {
      name: "ABAPError",
      group: 1,
      code: 5,
      codeString: "RFC_ABAP_EXCEPTION",
      key: "RAISE_EXCEPTION",
      abapMsgClass: "SR",
      abapMsgType: "E",
      abapMsgNumber: "006",
      abapMsgV1: "Method = 1",
      abapMsgV2: "",
      abapMsgV3: "",
      abapMsgV4: "",
      message: "ID:SR Type:E Number:006 Method = 1",
    },
  );
});

test("preserves the archived empty-message declared-exception display shape", () => {
  const error = new ABAPError(createRemoteRfcFailure(
    decodeRfcErrorEnvelope([
      text(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
      end(),
    ]),
    { establishedSession: true },
  ));

  assert.equal(error.message, " Number:000");
  assert.equal(error.abapMsgNumber, "000");
});

function text(tag: RfcErrorTag, value: string): RfcErrorEnvelopeField {
  return { tag, value: Buffer.from(value, "utf16le") };
}

function end(): RfcErrorEnvelopeField {
  return { tag: RFC_ERROR_ENVELOPE_END_TAG, value: Buffer.alloc(0) };
}

test("projects complete core ABAP failures without exposing remote stack or cause", () => {
  const cases = [
    {
      fields: [
        text(RfcErrorTag.MessageClass, "SR"),
        text(RfcErrorTag.MessageType, "E"),
        text(RfcErrorTag.MessageNumber, "006"),
        text(RfcErrorTag.MessageV1, "one"),
        text(RfcErrorTag.MessageV2, "two"),
        text(RfcErrorTag.MessageV3, "three"),
        text(RfcErrorTag.MessageV4, "four"),
        text(RfcErrorTag.CallStack, "PRIVATE_REMOTE_STACK"),
        text(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
        end(),
      ],
      code: 5,
      group: 1,
      key: "RAISE_EXCEPTION",
      message: "ID:SR Type:E Number:006 one",
    },
    {
      fields: [
        text(RfcErrorTag.ErrorMessage, "Runtime text"),
        text(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
        text(RfcErrorTag.CallStack, "PRIVATE_REMOTE_STACK"),
        end(),
      ],
      code: 3,
      group: 2,
      key: "RUNTIME_ID",
      message: "Runtime text",
    },
    {
      fields: [
        text(RfcErrorTag.ErrorMessage, "Rendered message"),
        text(RfcErrorTag.T100Text, "Message &1"),
        text(RfcErrorTag.MessageClass, "ZZ"),
        text(RfcErrorTag.MessageType, "X"),
        text(RfcErrorTag.MessageNumber, "123"),
        text(RfcErrorTag.MessageV1, "one"),
        text(RfcErrorTag.MessageV2, "two"),
        text(RfcErrorTag.MessageV3, "three"),
        text(RfcErrorTag.MessageV4, "four"),
        text(RfcErrorTag.CallStack, "PRIVATE_REMOTE_STACK"),
        end(),
      ],
      code: 4,
      group: 2,
      key: "Message &1",
      message: "Rendered message",
    },
  ] as const;

  for (const current of cases) {
    const failure = createRemoteRfcFailure(
      decodeRfcErrorEnvelope(current.fields),
      {
        establishedSession: true,
        correlationId: "public.error.case",
        cause: new Error("PRIVATE_LOW_LEVEL_CAUSE"),
      },
    );
    const error = rfcFailureToPublicError(failure);
    assert.equal(error instanceof ABAPError, true);
    assert.equal(error.group, current.group);
    assert.equal(error.code, current.code);
    assert.equal(error.key, current.key);
    assert.equal(error.message, current.message);
    const abap = error as ABAPError;
    assert.equal(abap.abapMsgClass, failure.abap.messageClass);
    assert.equal(abap.abapMsgType, failure.abap.messageType);
    assert.equal(abap.abapMsgNumber, failure.abap.messageNumber || "000");
    assert.equal(abap.abapMsgV1, failure.abap.messageV1);
    assert.equal(abap.abapMsgV2, failure.abap.messageV2);
    assert.equal(abap.abapMsgV3, failure.abap.messageV3);
    assert.equal(abap.abapMsgV4, failure.abap.messageV4);
    assert.equal("failure" in error, false);
    assert.equal(Object.keys(error).includes("cause"), false);
    for (const rendered of [JSON.stringify(error), inspect(error)]) {
      assert.equal(rendered.includes("PRIVATE_REMOTE_STACK"), false);
      assert.equal(rendered.includes("PRIVATE_LOW_LEVEL_CAUSE"), false);
    }
  }
});

test("projects MESSAGE A, E, and X with all public ABAP fields", () => {
  for (const messageType of ["A", "E", "X"] as const) {
    const failure = createRemoteRfcFailure(
      decodeRfcErrorEnvelope([
        text(RfcErrorTag.ErrorMessage, `Rendered ${messageType}`),
        text(RfcErrorTag.T100Text, `Template ${messageType} &1`),
        text(RfcErrorTag.MessageV4, `four-${messageType}`),
        text(RfcErrorTag.MessageClass, "ZM"),
        text(RfcErrorTag.MessageV2, `two-${messageType}`),
        text(RfcErrorTag.MessageType, messageType),
        text(RfcErrorTag.MessageNumber, "123"),
        text(RfcErrorTag.MessageV1, `one-${messageType}`),
        text(RfcErrorTag.MessageV3, `three-${messageType}`),
        text(RfcErrorTag.CallStack, `PRIVATE_${messageType}_STACK`),
        end(),
      ]),
      {
        establishedSession: true,
        correlationId: `public.message.${messageType}`,
      },
    );
    const error = rfcFailureToPublicError(failure);

    assert.equal(error instanceof ABAPError, true);
    assert.deepEqual(
      {
        name: error.name,
        group: error.group,
        code: error.code,
        codeString: error.codeString,
        key: error.key,
        message: error.message,
        abapMsgClass: (error as ABAPError).abapMsgClass,
        abapMsgType: (error as ABAPError).abapMsgType,
        abapMsgNumber: (error as ABAPError).abapMsgNumber,
        abapMsgV1: (error as ABAPError).abapMsgV1,
        abapMsgV2: (error as ABAPError).abapMsgV2,
        abapMsgV3: (error as ABAPError).abapMsgV3,
        abapMsgV4: (error as ABAPError).abapMsgV4,
      },
      {
        name: "ABAPError",
        group: 2,
        code: 4,
        codeString: "RFC_ABAP_MESSAGE",
        key: `Template ${messageType} &1`,
        message: `Rendered ${messageType}`,
        abapMsgClass: "ZM",
        abapMsgType: messageType,
        abapMsgNumber: "123",
        abapMsgV1: `one-${messageType}`,
        abapMsgV2: `two-${messageType}`,
        abapMsgV3: `three-${messageType}`,
        abapMsgV4: `four-${messageType}`,
      },
    );
    assert.equal(inspect(error).includes(`PRIVATE_${messageType}_STACK`), false);
  }
});
