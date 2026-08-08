import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  RfcConnectionDisposition,
  RfcCoreError,
  RfcFailureCategory,
  RfcFailureCode,
  RfcFailureGroup,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcRecoveryAction,
  RfcReplayPolicy,
  RfcTransmissionState,
  createRemoteRfcFailure,
  createRfcFailure,
  resolveRfcFailurePolicy,
  rfcFailureDiagnostic,
} from "../src/client/rfc-failure.js";
import {
  RFC_ERROR_ENVELOPE_END_TAG,
  RfcErrorTag,
  decodeRfcErrorEnvelope,
  type RfcErrorEnvelopeField,
} from "../src/protocol/rfc-error-envelope.js";

function textField(tag: number, value: string): RfcErrorEnvelopeField {
  return { tag, value: Buffer.from(value, "utf16le") };
}

function endField(): RfcErrorEnvelopeField {
  return { tag: RFC_ERROR_ENVELOPE_END_TAG, value: Buffer.alloc(0) };
}

const REMOTE_CONTEXT = Object.freeze({
  correlationId: "test.remote.failure",
  establishedSession: true,
});

const LOCAL_FAILURE_CATEGORIES: ReadonlySet<RfcFailureCategory> = new Set([
  RfcFailureCategory.InvalidState,
  RfcFailureCategory.InvalidParameter,
  RfcFailureCategory.Conversion,
  RfcFailureCategory.Serialization,
  RfcFailureCategory.Unsupported,
  RfcFailureCategory.Resource,
]);

const TERMINAL_FAILURE_CATEGORIES: ReadonlySet<RfcFailureCategory> = new Set([
  RfcFailureCategory.Communication,
  RfcFailureCategory.Logon,
  RfcFailureCategory.AbapRuntime,
  RfcFailureCategory.AbapMessage,
  RfcFailureCategory.Canceled,
  RfcFailureCategory.Timeout,
]);

function expectedDisposition(context: {
  readonly category: RfcFailureCategory;
  readonly origin: RfcFailureOrigin;
  readonly phase: RfcOperationPhase;
  readonly transmission: RfcTransmissionState;
  readonly establishedSession: boolean;
}): RfcConnectionDisposition {
  if (context.category === RfcFailureCategory.AbapException) {
    return context.origin === RfcFailureOrigin.Sap &&
      context.phase === RfcOperationPhase.EnvelopeDecode &&
      context.transmission === RfcTransmissionState.Complete &&
      context.establishedSession
      ? RfcConnectionDisposition.Reusable
      : RfcConnectionDisposition.UnknownClose;
  }
  if (context.category === RfcFailureCategory.MalformedProtocol) {
    return RfcConnectionDisposition.UnknownClose;
  }
  if (LOCAL_FAILURE_CATEGORIES.has(context.category)) {
    return context.transmission === RfcTransmissionState.NotStarted &&
      (context.origin === RfcFailureOrigin.Api ||
        context.origin === RfcFailureOrigin.Codec ||
        context.origin === RfcFailureOrigin.Pool ||
        context.phase === RfcOperationPhase.Metadata ||
        context.phase === RfcOperationPhase.Encode)
      ? RfcConnectionDisposition.Reusable
      : RfcConnectionDisposition.UnknownClose;
  }
  assert.equal(TERMINAL_FAILURE_CATEGORIES.has(context.category), true);
  return RfcConnectionDisposition.Close;
}

test("maps every failure category to its language-neutral SAP group and code", () => {
  const expected = new Map<RfcFailureCategory, readonly [
    RfcFailureGroup,
    RfcFailureCode,
  ]>([
    [RfcFailureCategory.InvalidState, [5, 19]],
    [RfcFailureCategory.InvalidParameter, [5, 20]],
    [RfcFailureCategory.Conversion, [5, 22]],
    [RfcFailureCategory.Serialization, [5, 12]],
    [RfcFailureCategory.Unsupported, [5, 18]],
    [RfcFailureCategory.Resource, [5, 9]],
    [RfcFailureCategory.Communication, [4, 1]],
    [RfcFailureCategory.Logon, [3, 2]],
    [RfcFailureCategory.AbapRuntime, [2, 3]],
    [RfcFailureCategory.AbapException, [1, 5]],
    [RfcFailureCategory.AbapMessage, [2, 4]],
    [RfcFailureCategory.Canceled, [4, 7]],
    [RfcFailureCategory.Timeout, [4, 8]],
    [RfcFailureCategory.MalformedProtocol, [5, 11]],
  ]);

  for (const category of Object.values(RfcFailureCategory)) {
    const policy = resolveRfcFailurePolicy({
      category,
      origin: RfcFailureOrigin.Sap,
      phase: RfcOperationPhase.Receive,
      transmission: RfcTransmissionState.Complete,
      establishedSession: true,
    });
    const [group, code] = expected.get(category)!;
    assert.equal(policy.group, group, category);
    assert.equal(policy.code, code, category);
    assert.match(policy.codeString, /^RFC_[A-Z_]+$/u, category);
    assert.equal(policy.replayPolicy, RfcReplayPolicy.Never, category);
  }
});

test("applies the authoritative policy across every category/origin/phase/transmission state", () => {
  for (const category of Object.values(RfcFailureCategory)) {
    for (const origin of Object.values(RfcFailureOrigin)) {
      for (const phase of Object.values(RfcOperationPhase)) {
        for (const transmission of Object.values(RfcTransmissionState)) {
          for (const establishedSession of [false, true]) {
            const context = {
              category,
              origin,
              phase,
              transmission,
              establishedSession,
            } as const;
            const policy = resolveRfcFailurePolicy(context);
            const disposition = expectedDisposition(context);
            const recoveryAction =
              establishedSession &&
              disposition !== RfcConnectionDisposition.Reusable
                ? RfcRecoveryAction.Replace
                : RfcRecoveryAction.None;
            assert.equal(policy.disposition, disposition);
            assert.equal(policy.recoveryAction, recoveryAction);
            assert.equal(policy.replayPolicy, RfcReplayPolicy.Never);
            assert.equal(Object.isFrozen(policy), true);
          }
        }
      }
    }
  }
});

test("keeps category, transmission, old-generation disposition, and recovery independent", () => {
  for (const transmission of Object.values(RfcTransmissionState)) {
    const communication = resolveRfcFailurePolicy({
      category: RfcFailureCategory.Communication,
      origin: RfcFailureOrigin.Ni,
      phase: RfcOperationPhase.Receive,
      transmission,
      establishedSession: true,
    });
    assert.equal(communication.disposition, RfcConnectionDisposition.Close);
    assert.equal(communication.recoveryAction, RfcRecoveryAction.Replace);
    assert.equal(communication.replayPolicy, RfcReplayPolicy.Never);
  }

  const localConversion = resolveRfcFailurePolicy({
    category: RfcFailureCategory.Conversion,
    origin: RfcFailureOrigin.Codec,
    phase: RfcOperationPhase.Encode,
    transmission: RfcTransmissionState.NotStarted,
    establishedSession: true,
  });
  assert.equal(localConversion.disposition, RfcConnectionDisposition.Reusable);
  assert.equal(localConversion.recoveryAction, RfcRecoveryAction.None);

  const remoteDecodeConversion = resolveRfcFailurePolicy({
    category: RfcFailureCategory.Conversion,
    origin: RfcFailureOrigin.Codec,
    phase: RfcOperationPhase.ValueDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
  });
  assert.equal(
    remoteDecodeConversion.disposition,
    RfcConnectionDisposition.UnknownClose,
  );
  assert.equal(remoteDecodeConversion.recoveryAction, RfcRecoveryAction.Replace);

  const openingCommunication = resolveRfcFailurePolicy({
    category: RfcFailureCategory.Communication,
    origin: RfcFailureOrigin.Ni,
    phase: RfcOperationPhase.Connect,
    transmission: RfcTransmissionState.NotStarted,
    establishedSession: false,
  });
  assert.equal(openingCommunication.disposition, RfcConnectionDisposition.Close);
  assert.equal(openingCommunication.recoveryAction, RfcRecoveryAction.None);
});

test("declared exceptions are reusable while fatal remote outcomes replace established sessions", () => {
  const declaredEnvelope = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.MessageClass, "SR"),
    textField(RfcErrorTag.MessageType, "E"),
    textField(RfcErrorTag.MessageNumber, "006"),
    textField(RfcErrorTag.MessageV1, "Method = 1"),
    textField(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
    endField(),
  ]);
  const declared = createRemoteRfcFailure(declaredEnvelope, REMOTE_CONTEXT);
  assert.deepEqual(
    {
      category: declared.category,
      group: declared.group,
      code: declared.code,
      codeString: declared.codeString,
      key: declared.key,
      message: declared.message,
      disposition: declared.disposition,
      recoveryAction: declared.recoveryAction,
      transmission: declared.transmission,
    },
    {
      category: RfcFailureCategory.AbapException,
      group: RfcFailureGroup.AbapApplicationFailure,
      code: RfcFailureCode.AbapException,
      codeString: "RFC_ABAP_EXCEPTION",
      key: "RAISE_EXCEPTION",
      message: "",
      disposition: RfcConnectionDisposition.Reusable,
      recoveryAction: RfcRecoveryAction.None,
      transmission: RfcTransmissionState.Complete,
    },
  );
  assert.equal(declared.abap.messageV1, "Method = 1");
  assert.equal(declared.abap.plainText, "");

  const runtimeEnvelope = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.ErrorMessage, "Runtime text"),
    textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
    textField(RfcErrorTag.CallStack, "stack"),
    endField(),
  ]);
  const runtime = createRemoteRfcFailure(runtimeEnvelope, REMOTE_CONTEXT);
  assert.equal(runtime.category, RfcFailureCategory.AbapRuntime);
  assert.equal(runtime.group, RfcFailureGroup.AbapRuntimeFailure);
  assert.equal(runtime.code, RfcFailureCode.AbapRuntimeFailure);
  assert.equal(runtime.key, "RUNTIME_ID");
  assert.equal(runtime.message, "Runtime text");
  assert.equal(runtime.disposition, RfcConnectionDisposition.Close);
  assert.equal(runtime.recoveryAction, RfcRecoveryAction.Replace);

  const messageEnvelope = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.T100Text, "Message &1"),
    textField(RfcErrorTag.MessageV1, "detail"),
    textField(RfcErrorTag.MessageClass, "ZZ"),
    textField(RfcErrorTag.MessageType, "X"),
    textField(RfcErrorTag.MessageNumber, "123"),
    endField(),
  ]);
  const message = createRemoteRfcFailure(messageEnvelope, REMOTE_CONTEXT);
  assert.equal(message.category, RfcFailureCategory.AbapMessage);
  assert.equal(message.code, RfcFailureCode.AbapMessage);
  assert.equal(message.key, "Message &1");
  assert.equal(message.message, "Message &1");
  assert.equal(message.abap.messageV1, "detail");
  assert.equal(message.disposition, RfcConnectionDisposition.Close);
  assert.equal(message.recoveryAction, RfcRecoveryAction.Replace);
});

test("retains a complete SYSTEM_FAILURE fact graph with terminal receive policy", () => {
  const fields = [
    textField(RfcErrorTag.MessageV3, "three"),
    textField(RfcErrorTag.ErrorMessage, "Rendered runtime failure"),
    textField(RfcErrorTag.MessageClass, "ZM"),
    textField(RfcErrorTag.RuntimeId, "SYSTEM_FAILURE_ID"),
    textField(RfcErrorTag.MessageV1, "one"),
    textField(RfcErrorTag.T100Text, "Runtime template &1"),
    textField(RfcErrorTag.MessageNumber, "042"),
    textField(RfcErrorTag.MessageV4, "four"),
    textField(RfcErrorTag.MessageType, "X"),
    textField(RfcErrorTag.MessageV2, "two"),
    textField(RfcErrorTag.CallStack, "PRIVATE_REMOTE_STACK"),
    endField(),
  ] as const;
  const failure = createRemoteRfcFailure(
    decodeRfcErrorEnvelope(fields),
    {
      establishedSession: true,
      correlationId: "test.system.failure.complete",
    },
  );

  assert.deepEqual(
    {
      reasonCode: failure.reasonCode,
      category: failure.category,
      origin: failure.origin,
      phase: failure.phase,
      transmission: failure.transmission,
      disposition: failure.disposition,
      recoveryAction: failure.recoveryAction,
      replayPolicy: failure.replayPolicy,
      group: failure.group,
      code: failure.code,
      codeString: failure.codeString,
      key: failure.key,
      message: failure.message,
    },
    {
      reasonCode: "RFC_REMOTE_ABAP_RUNTIME",
      category: RfcFailureCategory.AbapRuntime,
      origin: RfcFailureOrigin.Sap,
      phase: RfcOperationPhase.EnvelopeDecode,
      transmission: RfcTransmissionState.Complete,
      disposition: RfcConnectionDisposition.Close,
      recoveryAction: RfcRecoveryAction.Replace,
      replayPolicy: RfcReplayPolicy.Never,
      group: RfcFailureGroup.AbapRuntimeFailure,
      code: RfcFailureCode.AbapRuntimeFailure,
      codeString: "RFC_ABAP_RUNTIME_FAILURE",
      key: "SYSTEM_FAILURE_ID",
      message: "Rendered runtime failure",
    },
  );
  assert.deepEqual(failure.abap, {
    exceptionKey: "",
    plainText: "Rendered runtime failure",
    runtimeId: "SYSTEM_FAILURE_ID",
    t100Text: "Runtime template &1",
    messageClass: "ZM",
    messageType: "X",
    messageNumber: "042",
    messageV1: "one",
    messageV2: "two",
    messageV3: "three",
    messageV4: "four",
    callStack: "PRIVATE_REMOTE_STACK",
    provenance: fields.slice(0, -1).map((field, ordinal) => ({
      tag: field.tag,
      ordinal,
      byteLength: field.value.byteLength,
    })),
  });
  assert.equal(JSON.stringify(failure).includes("PRIVATE_REMOTE_STACK"), false);
});

test("does not create a failure from a successful envelope", () => {
  const success = decodeRfcErrorEnvelope([
    { tag: RfcErrorTag.Unresolved0420, value: Buffer.alloc(4) },
    endField(),
  ]);
  assert.throws(
    () => createRemoteRfcFailure(success, REMOTE_CONTEXT),
    /successful RFC envelope cannot create a failure/,
  );
});

test("creates immutable failures with safe diagnostic-only JSON", () => {
  const cause = new Error("private low-level detail");
  const failure = createRfcFailure({
    category: RfcFailureCategory.MalformedProtocol,
    origin: RfcFailureOrigin.Cpic,
    phase: RfcOperationPhase.EnvelopeDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    correlationId: "case.protocol.1",
    reasonCode: "RFC_PROTOCOL_MALFORMED_ERROR_ENVELOPE",
    key: "SENSITIVE_KEY",
    message: "returned text must not enter diagnostics",
    abap: {
      exceptionKey: "",
      plainText: "returned text must not enter diagnostics",
      runtimeId: "",
      t100Text: "",
      messageClass: "AA",
      messageType: "E",
      messageNumber: "001",
      messageV1: "secret variable",
      messageV2: "",
      messageV3: "",
      messageV4: "",
      callStack: "private stack",
      provenance: [{ tag: 0x0402, ordinal: 1, byteLength: 20 }],
    },
    cause,
  });

  assert.equal(Object.isFrozen(failure), true);
  assert.equal(Object.isFrozen(failure.abap), true);
  assert.equal(Object.isFrozen(failure.abap.provenance), true);
  assert.equal(Object.isFrozen(failure.abap.provenance[0]), true);
  assert.equal(failure.disposition, RfcConnectionDisposition.UnknownClose);
  assert.equal(failure.recoveryAction, RfcRecoveryAction.Replace);
  assert.equal(failure.cause, cause);
  assert.equal(Object.keys(failure).includes("cause"), false);
  assert.equal(Object.keys(failure).includes("toJSON"), false);
  assert.equal(Object.keys(failure).includes("key"), false);
  assert.equal(Object.keys(failure).includes("message"), false);
  assert.equal(Object.keys(failure).includes("abap"), false);

  const diagnostic = rfcFailureDiagnostic(failure);
  assert.deepEqual(JSON.parse(JSON.stringify(failure)), diagnostic);
  const serialized = JSON.stringify(failure);
  for (const forbidden of [
    "SENSITIVE_KEY",
    "returned text",
    "secret variable",
    "private stack",
    "private low-level detail",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.equal(inspect(failure).includes(forbidden), false, forbidden);
  }
  assert.equal(Object.isFrozen(diagnostic), true);
});

test("wraps core failures without making the sensitive record enumerable", () => {
  const cause = new Error("private wire detail");
  const failure = createRfcFailure({
    category: RfcFailureCategory.Communication,
    origin: RfcFailureOrigin.Ni,
    phase: RfcOperationPhase.Receive,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    correlationId: "case.communication.1",
    reasonCode: "RFC_TRANSPORT_EOF",
    message: "private returned remote text",
    cause,
  });
  const error = new RfcCoreError(failure);
  assert.equal(error instanceof Error, true);
  assert.equal(error.failure, failure);
  assert.equal(error.cause, undefined);
  assert.equal(error.failure.cause, cause);
  assert.equal(
    error.message,
    "RFC_COMMUNICATION_FAILURE: RFC_TRANSPORT_EOF [case.communication.1]",
  );
  assert.equal(Object.keys(error).includes("failure"), false);
  assert.equal(JSON.stringify(error), "{}");
  for (const rendered of [error.message, error.stack ?? "", inspect(error)]) {
    assert.equal(rendered.includes("private returned remote text"), false);
    assert.equal(rendered.includes("private wire detail"), false);
  }
});

test("rejects unsafe diagnostic identifiers and ignores attempted policy weakening", () => {
  const base = {
    category: RfcFailureCategory.InvalidParameter,
    origin: RfcFailureOrigin.Api,
    phase: RfcOperationPhase.Encode,
    transmission: RfcTransmissionState.NotStarted,
    establishedSession: true,
    reasonCode: "RFC_INVALID_INPUT",
  } as const;
  assert.throws(
    () => createRfcFailure({ ...base, correlationId: "contains a space" }),
    /correlationId.*safe identifier/,
  );
  assert.throws(
    () => createRfcFailure({ ...base, reasonCode: "unsafe reason" }),
    /reasonCode.*safe identifier/,
  );
  const attemptedOverride = createRfcFailure({
    category: RfcFailureCategory.Communication,
    origin: RfcFailureOrigin.Ni,
    phase: RfcOperationPhase.Receive,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    reasonCode: "RFC_TRANSPORT_EOF",
    correlationId: "case.invalid.policy",
    disposition: RfcConnectionDisposition.Reusable,
    recoveryAction: RfcRecoveryAction.None,
  } as unknown as Parameters<typeof createRfcFailure>[0]);
  assert.equal(attemptedOverride.disposition, RfcConnectionDisposition.Close);
  assert.equal(attemptedOverride.recoveryAction, RfcRecoveryAction.Replace);
});

test("validates every runtime policy context field", () => {
  const valid = {
    category: RfcFailureCategory.Communication,
    origin: RfcFailureOrigin.Ni,
    phase: RfcOperationPhase.Receive,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
  } as const;
  for (const [field, value, expected] of [
    ["category", "futureCategory", /category.*supported/],
    ["origin", "futureOrigin", /origin.*supported/],
    ["phase", "futurePhase", /phase.*supported/],
    ["transmission", "futureTransmission", /transmission.*supported/],
    ["establishedSession", 1, /establishedSession.*boolean/],
  ] as const) {
    assert.throws(
      () => resolveRfcFailurePolicy({
        ...valid,
        [field]: value,
      } as unknown as Parameters<typeof resolveRfcFailurePolicy>[0]),
      expected,
    );
  }
  assert.throws(
    () => resolveRfcFailurePolicy(null as never),
    /context must be an object/,
  );
  assert.throws(
    () => createRfcFailure({
      ...valid,
      establishedSession: "yes",
      reasonCode: "RFC_INVALID_CONTEXT",
    } as unknown as Parameters<typeof createRfcFailure>[0]),
    /establishedSession.*boolean/,
  );
});

test("reuses a declared exception only for a complete authenticated remote envelope", () => {
  const reusable = resolveRfcFailurePolicy({
    category: RfcFailureCategory.AbapException,
    origin: RfcFailureOrigin.Sap,
    phase: RfcOperationPhase.EnvelopeDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
  });
  assert.equal(reusable.disposition, RfcConnectionDisposition.Reusable);
  assert.equal(reusable.recoveryAction, RfcRecoveryAction.None);

  for (const context of [
    { origin: RfcFailureOrigin.Cpic },
    { phase: RfcOperationPhase.Receive },
    { transmission: RfcTransmissionState.Partial },
    { establishedSession: false },
  ] as const) {
    const policy = resolveRfcFailurePolicy({
      category: RfcFailureCategory.AbapException,
      origin: RfcFailureOrigin.Sap,
      phase: RfcOperationPhase.EnvelopeDecode,
      transmission: RfcTransmissionState.Complete,
      establishedSession: true,
      ...context,
    });
    assert.equal(policy.disposition, RfcConnectionDisposition.UnknownClose);
    assert.equal(
      policy.recoveryAction,
      context.establishedSession === false
        ? RfcRecoveryAction.None
        : RfcRecoveryAction.Replace,
    );
  }
});

test("validates and snapshots ABAP provenance supplied by adapters", () => {
  const provenance = [{ tag: 0x0402, ordinal: 1, byteLength: 12 }];
  const abap = {
    exceptionKey: "",
    plainText: "private text",
    runtimeId: "",
    t100Text: "",
    messageClass: "AA",
    messageType: "E",
    messageNumber: "001",
    messageV1: "one",
    messageV2: "",
    messageV3: "",
    messageV4: "",
    callStack: "",
    provenance,
  };
  const input = {
    category: RfcFailureCategory.AbapMessage,
    origin: RfcFailureOrigin.Sap,
    phase: RfcOperationPhase.EnvelopeDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    reasonCode: "RFC_REMOTE_ABAP_MESSAGE",
  } as const;
  const failure = createRfcFailure({ ...input, abap });

  provenance[0]!.tag = 0x7777;
  provenance[0]!.byteLength = 999;
  provenance.push({ tag: 0x0404, ordinal: 2, byteLength: 2 });
  abap.plainText = "changed";

  assert.equal(failure.abap.plainText, "private text");
  assert.deepEqual(failure.abap.provenance, [
    { tag: 0x0402, ordinal: 1, byteLength: 12 },
  ]);

  for (const invalidProvenance of [
    [{ tag: -1, ordinal: 0, byteLength: 0 }],
    [{ tag: 0x0402, ordinal: -1, byteLength: 0 }],
    [{ tag: 0x0402, ordinal: 0, byteLength: -1 }],
    [
      { tag: 0x0402, ordinal: 1, byteLength: 0 },
      { tag: 0x0404, ordinal: 1, byteLength: 0 },
    ],
  ]) {
    assert.throws(
      () => createRfcFailure({
        ...input,
        abap: { ...abap, provenance: invalidProvenance },
      }),
      /ABAP fact provenance entry/,
    );
  }
  assert.throws(
    () => createRfcFailure({
      ...input,
      abap: { ...abap, plainText: 42 },
    } as unknown as Parameters<typeof createRfcFailure>[0]),
    /ABAP fact plainText must be a string/,
  );
});
