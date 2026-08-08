import assert from "node:assert/strict";
import test from "node:test";

import {
  RFC_ERROR_ENVELOPE_END_TAG,
  RfcErrorEnvelopeProtocolError,
  RfcErrorTag,
  decodeRfcErrorEnvelope,
  type RfcErrorEnvelopeField,
  type RfcErrorEnvelopeReasonCode,
} from "../src/protocol/rfc-error-envelope.js";

function textField(
  tag: number,
  value: string,
  rightPadding = 0,
): RfcErrorEnvelopeField {
  return {
    tag,
    value: Buffer.from(value + " ".repeat(rightPadding), "utf16le"),
  };
}

function rawField(tag: number, value: Uint8Array): RfcErrorEnvelopeField {
  return { tag, value: Buffer.from(value) };
}

function endField(value: Uint8Array = Buffer.alloc(0)): RfcErrorEnvelopeField {
  return rawField(RFC_ERROR_ENVELOPE_END_TAG, value);
}

function expectProtocolError(
  operation: () => unknown,
  reasonCode: RfcErrorEnvelopeReasonCode,
): void {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof RfcErrorEnvelopeProtocolError &&
      error.reasonCode === reasonCode,
  );
}

function semanticFacts(
  fields: readonly RfcErrorEnvelopeField[],
): Omit<ReturnType<typeof decodeRfcErrorEnvelope>["facts"], "provenance"> {
  const { provenance: _provenance, ...facts } =
    decodeRfcErrorEnvelope(fields).facts;
  return facts;
}

test("normalizes every classic declared-exception fact without aliasing V1 to text", () => {
  const fields = [
    textField(RfcErrorTag.MessageClass, "SR"),
    textField(RfcErrorTag.MessageType, "E"),
    textField(RfcErrorTag.MessageNumber, "006"),
    textField(RfcErrorTag.MessageV1, "Method = 1", 5),
    textField(RfcErrorTag.MessageV2, "second"),
    textField(RfcErrorTag.MessageV3, "third"),
    textField(RfcErrorTag.MessageV4, "fourth \u{1f642}"),
    textField(RfcErrorTag.T100Text, "Template &1"),
    textField(RfcErrorTag.ErrorMessage, "Rendered message"),
    textField(RfcErrorTag.CallStack, "stack line"),
    textField(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
    endField(),
  ] as const;

  const decoded = decodeRfcErrorEnvelope(fields);
  assert.equal(decoded.outcome, "abapException");
  assert.equal(decoded.successControl, "notApplicable");
  assert.deepEqual(decoded.facts, {
    exceptionKey: "RAISE_EXCEPTION",
    plainText: "Rendered message",
    runtimeId: "",
    t100Text: "Template &1",
    messageClass: "SR",
    messageType: "E",
    messageNumber: "006",
    messageV1: "Method = 1",
    messageV2: "second",
    messageV3: "third",
    messageV4: "fourth \u{1f642}",
    callStack: "stack line",
    provenance: fields.slice(0, -1).map((field, ordinal) => ({
      tag: field.tag,
      ordinal,
      byteLength: field.value.byteLength,
    })),
    unresolved0420: [],
  });
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.facts), true);
  assert.equal(Object.isFrozen(decoded.facts.provenance), true);
  assert.equal(Object.isFrozen(decoded.facts.provenance[0]), true);
  assert.throws(
    () => {
      (decoded.facts as { messageV1: string }).messageV1 = "changed";
    },
    TypeError,
  );
});

test("classifies runtime and MESSAGE facts independently of field order", () => {
  const runtime = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.MessageV2, "detail 2"),
    textField(RfcErrorTag.ErrorMessage, "Runtime text"),
    textField(RfcErrorTag.CallStack, "call stack"),
    textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
    textField(RfcErrorTag.MessageClass, "00"),
    endField(),
  ]);
  assert.equal(runtime.outcome, "abapRuntime");
  assert.equal(runtime.facts.runtimeId, "RUNTIME_ID");
  assert.equal(runtime.facts.plainText, "Runtime text");
  assert.equal(runtime.facts.messageV2, "detail 2");

  const message = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.MessageV4, "detail 4"),
    textField(RfcErrorTag.MessageNumber, "123"),
    textField(RfcErrorTag.MessageType, "A"),
    textField(RfcErrorTag.MessageClass, "ZZ"),
    textField(RfcErrorTag.MessageV1, "detail 1"),
    textField(RfcErrorTag.T100Text, "Message &1"),
    endField(),
  ]);
  assert.equal(message.outcome, "abapMessage");
  assert.equal(message.facts.messageV1, "detail 1");
  assert.equal(message.facts.messageV4, "detail 4");
});

test("requires plain/T100 text or a coherent class/type/number MESSAGE identity", () => {
  for (const tag of [RfcErrorTag.ErrorMessage, RfcErrorTag.T100Text]) {
    const decoded = decodeRfcErrorEnvelope([textField(tag, "message"), endField()]);
    assert.equal(decoded.outcome, "abapMessage");
  }

  const identity = [
    textField(RfcErrorTag.MessageClass, "ZZ"),
    textField(RfcErrorTag.MessageType, "E"),
    textField(RfcErrorTag.MessageNumber, "123"),
  ] as const;
  assert.equal(
    decodeRfcErrorEnvelope([...identity, endField()]).outcome,
    "abapMessage",
  );

  for (let mask = 1; mask < 0b111; mask += 1) {
    const partial = identity.filter((_field, index) => (mask & (1 << index)) !== 0);
    expectProtocolError(
      () => decodeRfcErrorEnvelope([...partial, endField()]),
      "RFC_ERROR_ENVELOPE_AMBIGUOUS_FACTS",
    );
  }
  for (let emptyIndex = 0; emptyIndex < identity.length; emptyIndex += 1) {
    const incomplete = identity.map((field, index) =>
      index === emptyIndex ? textField(field.tag, "", 2) : field,
    );
    expectProtocolError(
      () => decodeRfcErrorEnvelope([...incomplete, endField()]),
      "RFC_ERROR_ENVELOPE_AMBIGUOUS_FACTS",
    );
  }
  for (const tag of [RfcErrorTag.ErrorMessage, RfcErrorTag.T100Text]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope([textField(tag, "", 2), endField()]),
      "RFC_ERROR_ENVELOPE_AMBIGUOUS_FACTS",
    );
  }
});

test("produces identical semantic facts for deterministic permutations", () => {
  const source = [
    textField(RfcErrorTag.ExceptionKey, "DECLARED"),
    textField(RfcErrorTag.ErrorMessage, "plain"),
    textField(RfcErrorTag.T100Text, "template"),
    textField(RfcErrorTag.MessageClass, "AA"),
    textField(RfcErrorTag.MessageType, "E"),
    textField(RfcErrorTag.MessageNumber, "001"),
    textField(RfcErrorTag.MessageV1, "one"),
    textField(RfcErrorTag.MessageV2, "two"),
    textField(RfcErrorTag.MessageV3, "three"),
    textField(RfcErrorTag.MessageV4, "four"),
  ];
  const expected = semanticFacts([...source, endField()]);
  for (let shift = 0; shift < source.length; shift += 1) {
    const rotated = [...source.slice(shift), ...source.slice(0, shift)];
    assert.deepEqual(semanticFacts([...rotated, endField()]), expected);
  }

  const forward = decodeRfcErrorEnvelope([...source, endField()]);
  const reverse = decodeRfcErrorEnvelope([...source].reverse().concat(endField()));
  assert.notDeepEqual(forward.facts.provenance, reverse.facts.provenance);
});

test("recognizes only the observed four-byte zero 0x0420 success control", () => {
  const success = decodeRfcErrorEnvelope([
    rawField(0x0503, Buffer.alloc(0)),
    rawField(0x0201, Buffer.from("RESULT", "utf16le")),
    rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(4)),
    endField(),
  ]);
  assert.equal(success.outcome, "success");
  assert.equal(success.successControl, "zeroControl");
  assert.deepEqual(success.facts.unresolved0420, [{
    tag: RfcErrorTag.Unresolved0420,
    ordinal: 2,
    byteLength: 4,
    valueHex: "00000000",
  }]);
  assert.equal(Object.isFrozen(success.facts.unresolved0420), true);
  assert.equal(Object.isFrozen(success.facts.unresolved0420[0]), true);

  for (const controls of [
    [] as RfcErrorEnvelopeField[],
    [rawField(RfcErrorTag.Unresolved0420, Buffer.of(0, 0, 0, 1))],
    [rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(3))],
    [
      rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(4)),
      rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(4)),
    ],
  ]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope([...controls, endField()]),
      "RFC_ERROR_ENVELOPE_UNRESOLVED_SUCCESS_CONTROL",
    );
  }
});

test("does not let unresolved 0x0420 override an independently classified error", () => {
  const decoded = decodeRfcErrorEnvelope([
    rawField(RfcErrorTag.Unresolved0420, Buffer.of(0xde, 0xad)),
    textField(RfcErrorTag.ExceptionKey, "DECLARED"),
    rawField(RfcErrorTag.Unresolved0420, Buffer.of(0xbe, 0xef)),
    endField(),
  ]);
  assert.equal(decoded.outcome, "abapException");
  assert.deepEqual(
    decoded.facts.unresolved0420.map((fact) => fact.valueHex),
    ["dead", "beef"],
  );
});

test("rejects duplicate, conflicting, ambiguous, class-exception, and unknown facts", () => {
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.ExceptionKey, "ONE"),
      textField(RfcErrorTag.ExceptionKey, "TWO"),
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_DUPLICATE_FACT",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.ExceptionKey, "DECLARED"),
      textField(RfcErrorTag.RuntimeId, "RUNTIME"),
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_CONFLICTING_DISCRIMINATORS",
  );
  for (const tag of [
    RfcErrorTag.MessageV1,
    RfcErrorTag.MessageV2,
    RfcErrorTag.MessageV3,
    RfcErrorTag.MessageV4,
    RfcErrorTag.CallStack,
  ]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope([textField(tag, "secondary"), endField()]),
      "RFC_ERROR_ENVELOPE_AMBIGUOUS_FACTS",
    );
  }
  for (const tag of [
    RfcErrorTag.ClassException,
    RfcErrorTag.ClassExceptionEnd,
  ]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope([rawField(tag, Buffer.alloc(0)), endField()]),
      "RFC_ERROR_ENVELOPE_CLASS_EXCEPTION_UNSUPPORTED",
    );
  }
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      rawField(0x7777, Buffer.alloc(0)),
      rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(4)),
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_UNKNOWN_TAG",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      rawField(RfcErrorTag.UseClassExceptions, Buffer.of(1)),
      rawField(RfcErrorTag.UseClassExceptions, Buffer.of(0)),
      textField(RfcErrorTag.ExceptionKey, "DECLARED"),
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_DUPLICATE_FACT",
  );

  const supplementalClassInfo = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.MessageClass, "SR"),
    textField(RfcErrorTag.MessageType, "E"),
    textField(RfcErrorTag.MessageNumber, "006"),
    textField(RfcErrorTag.MessageV1, "Method = 1"),
    textField(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
    rawField(RfcErrorTag.ClassExceptionInfo, Buffer.alloc(96, 0xa5)),
    endField(),
  ]);
  assert.equal(supplementalClassInfo.outcome, "abapException");
  assert.deepEqual(
    supplementalClassInfo.facts.provenance.at(-1),
    { tag: RfcErrorTag.ClassExceptionInfo, ordinal: 5, byteLength: 96 },
  );
  assert.equal(
    Object.hasOwn(supplementalClassInfo.facts, "classExceptionInfo"),
    false,
  );
  for (const fields of [
    [rawField(RfcErrorTag.ClassExceptionInfo, Buffer.alloc(96)), endField()],
    [
      rawField(RfcErrorTag.UseClassExceptions, Buffer.of(1)),
      textField(RfcErrorTag.ExceptionKey, "RAISE_EXCEPTION"),
      rawField(RfcErrorTag.ClassExceptionInfo, Buffer.alloc(96)),
      endField(),
    ],
  ]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope(fields),
      "RFC_ERROR_ENVELOPE_CLASS_EXCEPTION_UNSUPPORTED",
    );
  }

  const explicitlyAllowed = decodeRfcErrorEnvelope(
    [
      rawField(0x7777, Buffer.alloc(0)),
      rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(4)),
      endField(),
    ],
    { additionalAllowedTags: [0x7777] },
  );
  assert.equal(explicitlyAllowed.outcome, "success");
});

test("requires non-empty exception/runtime discriminators", () => {
  for (const tag of [RfcErrorTag.ExceptionKey, RfcErrorTag.RuntimeId]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope([textField(tag, "", 3), endField()]),
      "RFC_ERROR_ENVELOPE_EMPTY_DISCRIMINATOR",
    );
  }
});

test("strict UTF-16LE accepts scalar pairs and rejects malformed code units", () => {
  const valid = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.MessageV1, "leading \u{1f642} combining e\u0301", 4),
    textField(RfcErrorTag.ExceptionKey, "DECLARED"),
    endField(),
  ]);
  assert.equal(
    valid.facts.messageV1,
    "leading \u{1f642} combining e\u0301",
  );

  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      rawField(RfcErrorTag.ExceptionKey, Buffer.of(0x41)),
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_ODD_UTF16_LENGTH",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      rawField(RfcErrorTag.ExceptionKey, Buffer.from("A\0B", "utf16le")),
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_EMBEDDED_NUL",
  );
  for (const bytes of [
    Buffer.from([0x00, 0xd8]),
    Buffer.from([0x00, 0xdc]),
    Buffer.from([0x00, 0xd8, 0x41, 0x00]),
  ]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope([
        rawField(RfcErrorTag.ExceptionKey, bytes),
        endField(),
      ]),
      "RFC_ERROR_ENVELOPE_UNPAIRED_SURROGATE",
    );
  }
});

test("preserves leading spaces, trims only right padding, and enforces limits", () => {
  const decoded = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.ExceptionKey, "  DECLARED", 3),
    endField(),
  ]);
  assert.equal(decoded.facts.exceptionKey, "  DECLARED");

  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.ExceptionKey, "TOO-LONG"),
      endField(),
    ], { maxTextByteLength: 2 }),
    "RFC_ERROR_ENVELOPE_TEXT_TOO_LARGE",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(5)),
      endField(),
    ], { maxControlByteLength: 4 }),
    "RFC_ERROR_ENVELOPE_CONTROL_TOO_LARGE",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.ExceptionKey, "AA"),
      textField(RfcErrorTag.MessageV1, "BB"),
      endField(),
    ], { maxTotalTextByteLength: 6 }),
    "RFC_ERROR_ENVELOPE_TOTAL_TEXT_TOO_LARGE",
  );
});

test("bounds envelope fields and aggregate unresolved controls before copying", () => {
  const control = Buffer.alloc(4, 0x5a);
  const exactControls = Array.from({ length: 3 }, () =>
    rawField(RfcErrorTag.Unresolved0420, control));
  const exact = decodeRfcErrorEnvelope([
    textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
    ...exactControls,
    endField(),
  ], {
    maxFieldCount: 5,
    maxControlCount: 3,
    maxControlByteLength: 4,
    maxTotalControlByteLength: 12,
  });
  assert.equal(exact.outcome, "abapRuntime");
  assert.equal(exact.facts.unresolved0420.length, 3);

  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
      ...exactControls,
      rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(0)),
      endField(),
    ], {
      maxFieldCount: 6,
      maxControlCount: 3,
      maxControlByteLength: 4,
      maxTotalControlByteLength: 12,
    }),
    "RFC_ERROR_ENVELOPE_TOO_MANY_CONTROLS",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
      ...exactControls,
      rawField(RfcErrorTag.Unresolved0420, Buffer.of(1)),
      endField(),
    ], {
      maxFieldCount: 6,
      maxControlCount: 4,
      maxControlByteLength: 4,
      maxTotalControlByteLength: 12,
    }),
    "RFC_ERROR_ENVELOPE_TOTAL_CONTROL_TOO_LARGE",
  );
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
      ...exactControls,
      endField(),
    ], {
      maxFieldCount: 4,
      maxControlCount: 3,
      maxControlByteLength: 4,
      maxTotalControlByteLength: 12,
    }),
    "RFC_ERROR_ENVELOPE_TOO_MANY_FIELDS",
  );

  const manyTinyControls = Array.from({ length: 65 }, () =>
    rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(0)));
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      textField(RfcErrorTag.RuntimeId, "RUNTIME_ID"),
      ...manyTinyControls,
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_TOO_MANY_CONTROLS",
  );
});

test("snapshots text, controls, and provenance independently of caller buffers", () => {
  const exceptionBytes = Buffer.from("DECLARED", "utf16le");
  const controlBytes = Buffer.of(0xde, 0xad, 0xbe, 0xef);
  const fields: RfcErrorEnvelopeField[] = [
    { tag: RfcErrorTag.ExceptionKey, value: exceptionBytes },
    { tag: RfcErrorTag.Unresolved0420, value: controlBytes },
    endField(),
  ];
  const decoded = decodeRfcErrorEnvelope(fields);

  exceptionBytes.fill(0x20);
  controlBytes.fill(0);
  fields.splice(0, fields.length);

  assert.equal(decoded.facts.exceptionKey, "DECLARED");
  assert.equal(decoded.facts.unresolved0420[0]?.valueHex, "deadbeef");
  assert.deepEqual(decoded.facts.provenance, [
    { tag: RfcErrorTag.ExceptionKey, ordinal: 0, byteLength: 16 },
    { tag: RfcErrorTag.Unresolved0420, ordinal: 1, byteLength: 4 },
  ]);
  assert.equal(Object.isFrozen(decoded.facts.unresolved0420), true);
  assert.equal(Object.isFrozen(decoded.facts.unresolved0420[0]), true);
});

test("validates terminal End placement and field structure", () => {
  expectProtocolError(
    () => decodeRfcErrorEnvelope([]),
    "RFC_ERROR_ENVELOPE_MISSING_END",
  );
  for (const fields of [
    [endField(Buffer.of(0))],
    [endField(), endField()],
    [endField(), rawField(RfcErrorTag.Unresolved0420, Buffer.alloc(4))],
  ]) {
    expectProtocolError(
      () => decodeRfcErrorEnvelope(fields),
      "RFC_ERROR_ENVELOPE_INVALID_END",
    );
  }
  expectProtocolError(
    () => decodeRfcErrorEnvelope([
      { tag: -1, value: Buffer.alloc(0) },
      endField(),
    ]),
    "RFC_ERROR_ENVELOPE_INVALID_FIELD",
  );
});
