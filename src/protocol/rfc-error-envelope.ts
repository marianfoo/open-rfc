/**
 * Error-related RFCPRO identifiers used in classic RFC response envelopes.
 *
 * Identifier 0x0420 deliberately remains unresolved: the only form observed in
 * successful responses is a single four-byte zero.
 */
export enum RfcErrorTag {
  ExceptionKey = 0x0401,
  ErrorMessage = 0x0402,
  RuntimeId = 0x0403,
  T100Text = 0x0404,
  MessageV1 = 0x0411,
  MessageV2 = 0x0412,
  MessageV3 = 0x0413,
  MessageV4 = 0x0414,
  MessageClass = 0x0415,
  MessageType = 0x0416,
  MessageNumber = 0x0417,
  CallStack = 0x0418,
  Unresolved0420 = 0x0420,
  UseClassExceptions = 0x0421,
  ClassExceptionInfo = 0x0422,
  ClassException = 0x0423,
  ClassExceptionEnd = 0x0424,
}

export const RFC_ERROR_ENVELOPE_END_TAG = 0xffff;
export const DEFAULT_MAX_RFC_ERROR_TEXT_BYTE_LENGTH = 1024 * 1024;
export const DEFAULT_MAX_RFC_ERROR_TOTAL_TEXT_BYTE_LENGTH = 4 * 1024 * 1024;
export const DEFAULT_MAX_RFC_ERROR_CONTROL_BYTE_LENGTH = 4 * 1024;
export const DEFAULT_MAX_RFC_ERROR_TOTAL_CONTROL_BYTE_LENGTH = 64 * 1024;
export const DEFAULT_MAX_RFC_ERROR_CONTROL_COUNT = 64;
export const DEFAULT_MAX_RFC_ERROR_ENVELOPE_FIELD_COUNT = 256;

/** Classic response tags which are not part of an error record. */
const CLASSIC_RESPONSE_DATA_TAGS: ReadonlySet<number> = new Set([
  0x0102, // function
  0x0201, // parameter name
  0x0203, // parameter value
  0x0205, // requested output
  0x0301, // table name
  0x0302, // table header
  0x0303, // uncompressed table content
  0x0304, // simple-compressed table content
  0x0502, // context end
  0x0503, // response context
  0x0512, // call context
  0x0514, // session
]);

const TEXT_TAGS: ReadonlySet<number> = new Set([
  RfcErrorTag.ExceptionKey,
  RfcErrorTag.ErrorMessage,
  RfcErrorTag.RuntimeId,
  RfcErrorTag.T100Text,
  RfcErrorTag.MessageV1,
  RfcErrorTag.MessageV2,
  RfcErrorTag.MessageV3,
  RfcErrorTag.MessageV4,
  RfcErrorTag.MessageClass,
  RfcErrorTag.MessageType,
  RfcErrorTag.MessageNumber,
  RfcErrorTag.CallStack,
]);

const CLASS_EXCEPTION_TAGS: ReadonlySet<number> = new Set([
  RfcErrorTag.ClassExceptionInfo,
  RfcErrorTag.ClassException,
  RfcErrorTag.ClassExceptionEnd,
]);

const MESSAGE_TEXT_TAGS: readonly RfcErrorTag[] = Object.freeze([
  RfcErrorTag.ErrorMessage,
  RfcErrorTag.T100Text,
]);

const MESSAGE_IDENTITY_TAGS: readonly RfcErrorTag[] = Object.freeze([
  RfcErrorTag.MessageClass,
  RfcErrorTag.MessageType,
  RfcErrorTag.MessageNumber,
]);

const SECONDARY_ERROR_TAGS: ReadonlySet<number> = new Set([
  RfcErrorTag.MessageV1,
  RfcErrorTag.MessageV2,
  RfcErrorTag.MessageV3,
  RfcErrorTag.MessageV4,
  RfcErrorTag.CallStack,
  ...MESSAGE_TEXT_TAGS,
  ...MESSAGE_IDENTITY_TAGS,
]);

export interface RfcErrorEnvelopeField {
  readonly tag: number;
  readonly value: Uint8Array;
}

export interface RfcErrorFactProvenance {
  readonly tag: number;
  readonly ordinal: number;
  readonly byteLength: number;
}

export interface RfcUnresolvedControlFact {
  readonly tag: RfcErrorTag.Unresolved0420;
  readonly ordinal: number;
  readonly byteLength: number;
  /** Lowercase hexadecimal; retained internally without a mutable byte view. */
  readonly valueHex: string;
}

export interface RfcRemoteErrorFacts {
  readonly exceptionKey: string;
  readonly plainText: string;
  readonly runtimeId: string;
  readonly t100Text: string;
  readonly messageClass: string;
  readonly messageType: string;
  readonly messageNumber: string;
  readonly messageV1: string;
  readonly messageV2: string;
  readonly messageV3: string;
  readonly messageV4: string;
  readonly callStack: string;
  readonly provenance: readonly RfcErrorFactProvenance[];
  readonly unresolved0420: readonly RfcUnresolvedControlFact[];
}

export type RfcErrorEnvelopeOutcome =
  | "success"
  | "abapException"
  | "abapRuntime"
  | "abapMessage";

export interface RfcErrorEnvelope {
  readonly outcome: RfcErrorEnvelopeOutcome;
  readonly successControl:
    | "zeroControl"
    | "notApplicable";
  readonly facts: RfcRemoteErrorFacts;
}

export interface RfcErrorEnvelopeDecodeOptions {
  readonly maxTextByteLength?: number;
  /** Aggregate limit across all decoded UTF-16LE error facts. */
  readonly maxTotalTextByteLength?: number;
  readonly maxControlByteLength?: number;
  /** Aggregate limit across all copied unresolved/control values. */
  readonly maxTotalControlByteLength?: number;
  readonly maxControlCount?: number;
  /** Includes application-data fields and the terminal End field. */
  readonly maxFieldCount?: number;
  /** Additional state-specific data tags accepted but not interpreted here. */
  readonly additionalAllowedTags?: readonly number[];
}

export type RfcErrorEnvelopeReasonCode =
  | "RFC_ERROR_ENVELOPE_INVALID_FIELD"
  | "RFC_ERROR_ENVELOPE_MISSING_END"
  | "RFC_ERROR_ENVELOPE_INVALID_END"
  | "RFC_ERROR_ENVELOPE_DUPLICATE_FACT"
  | "RFC_ERROR_ENVELOPE_TEXT_TOO_LARGE"
  | "RFC_ERROR_ENVELOPE_TOTAL_TEXT_TOO_LARGE"
  | "RFC_ERROR_ENVELOPE_ODD_UTF16_LENGTH"
  | "RFC_ERROR_ENVELOPE_EMBEDDED_NUL"
  | "RFC_ERROR_ENVELOPE_UNPAIRED_SURROGATE"
  | "RFC_ERROR_ENVELOPE_EMPTY_DISCRIMINATOR"
  | "RFC_ERROR_ENVELOPE_CONFLICTING_DISCRIMINATORS"
  | "RFC_ERROR_ENVELOPE_AMBIGUOUS_FACTS"
  | "RFC_ERROR_ENVELOPE_UNKNOWN_TAG"
  | "RFC_ERROR_ENVELOPE_CLASS_EXCEPTION_UNSUPPORTED"
  | "RFC_ERROR_ENVELOPE_CONTROL_TOO_LARGE"
  | "RFC_ERROR_ENVELOPE_TOTAL_CONTROL_TOO_LARGE"
  | "RFC_ERROR_ENVELOPE_TOO_MANY_CONTROLS"
  | "RFC_ERROR_ENVELOPE_TOO_MANY_FIELDS"
  | "RFC_ERROR_ENVELOPE_UNRESOLVED_SUCCESS_CONTROL";

export class RfcErrorEnvelopeProtocolError extends Error {
  readonly reasonCode: RfcErrorEnvelopeReasonCode;
  override readonly cause: unknown;

  constructor(
    reasonCode: RfcErrorEnvelopeReasonCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RfcErrorEnvelopeProtocolError";
    this.reasonCode = reasonCode;
    this.cause = cause;
  }
}

function protocolError(
  reasonCode: RfcErrorEnvelopeReasonCode,
  message: string,
  cause?: unknown,
): never {
  throw new RfcErrorEnvelopeProtocolError(reasonCode, message, cause);
}

function tagText(tag: number): string {
  return `0x${tag.toString(16).padStart(4, "0")}`;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer in ${minimum}..${maximum}`,
    );
  }
}

function decodeStrictUtf16Le(
  value: Uint8Array,
  tag: number,
  maximumByteLength: number,
): string {
  if (value.byteLength > maximumByteLength) {
    protocolError(
      "RFC_ERROR_ENVELOPE_TEXT_TOO_LARGE",
      `RFCPRO error fact ${tagText(tag)} exceeds the configured text limit`,
    );
  }
  if ((value.byteLength & 1) !== 0) {
    protocolError(
      "RFC_ERROR_ENVELOPE_ODD_UTF16_LENGTH",
      `RFCPRO error fact ${tagText(tag)} has an odd UTF-16LE byte length`,
    );
  }

  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const codeUnit = bytes.readUInt16LE(offset);
    if (codeUnit === 0) {
      protocolError(
        "RFC_ERROR_ENVELOPE_EMBEDDED_NUL",
        `RFCPRO error fact ${tagText(tag)} contains NUL`,
      );
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (offset + 2 >= bytes.byteLength) {
        protocolError(
          "RFC_ERROR_ENVELOPE_UNPAIRED_SURROGATE",
          `RFCPRO error fact ${tagText(tag)} ends with an unpaired surrogate`,
        );
      }
      const low = bytes.readUInt16LE(offset + 2);
      if (low < 0xdc00 || low > 0xdfff) {
        protocolError(
          "RFC_ERROR_ENVELOPE_UNPAIRED_SURROGATE",
          `RFCPRO error fact ${tagText(tag)} contains an unpaired surrogate`,
        );
      }
      offset += 2;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      protocolError(
        "RFC_ERROR_ENVELOPE_UNPAIRED_SURROGATE",
        `RFCPRO error fact ${tagText(tag)} contains an unpaired surrogate`,
      );
    }
  }

  return bytes.toString("utf16le").replace(/ +$/u, "");
}

function freezeProvenance(
  provenance: RfcErrorFactProvenance[],
): readonly RfcErrorFactProvenance[] {
  return Object.freeze(
    provenance.map((fact) => Object.freeze({ ...fact })),
  );
}

function freezeControls(
  controls: RfcUnresolvedControlFact[],
): readonly RfcUnresolvedControlFact[] {
  return Object.freeze(
    controls.map((fact) => Object.freeze({ ...fact })),
  );
}

function hasNonEmptyFact(
  tags: readonly RfcErrorTag[],
  present: ReadonlySet<number>,
  values: ReadonlyMap<number, string>,
): boolean {
  return tags.some((tag) => present.has(tag) && (values.get(tag)?.length ?? 0) > 0);
}

function hasCoherentMessageIdentity(
  present: ReadonlySet<number>,
  values: ReadonlyMap<number, string>,
): boolean {
  return MESSAGE_IDENTITY_TAGS.every(
    (tag) => present.has(tag) && (values.get(tag)?.length ?? 0) > 0,
  );
}

function hasAnyTag(
  tags: ReadonlySet<number>,
  present: ReadonlySet<number>,
): boolean {
  for (const tag of tags) {
    if (present.has(tag)) return true;
  }
  return false;
}

/**
 * Normalize and classify the error/control portion of a decoded RFCPRO response.
 * The caller remains responsible for the outer CPIC prefix, chained closing-tag
 * grammar, and final two-byte trailer.
 */
export function decodeRfcErrorEnvelope(
  fields: readonly RfcErrorEnvelopeField[],
  options: RfcErrorEnvelopeDecodeOptions = {},
): RfcErrorEnvelope {
  const maxTextByteLength =
    options.maxTextByteLength ?? DEFAULT_MAX_RFC_ERROR_TEXT_BYTE_LENGTH;
  const maxTotalTextByteLength =
    options.maxTotalTextByteLength ??
    DEFAULT_MAX_RFC_ERROR_TOTAL_TEXT_BYTE_LENGTH;
  const maxControlByteLength =
    options.maxControlByteLength ?? DEFAULT_MAX_RFC_ERROR_CONTROL_BYTE_LENGTH;
  const maxTotalControlByteLength =
    options.maxTotalControlByteLength ??
    DEFAULT_MAX_RFC_ERROR_TOTAL_CONTROL_BYTE_LENGTH;
  const maxControlCount =
    options.maxControlCount ?? DEFAULT_MAX_RFC_ERROR_CONTROL_COUNT;
  const maxFieldCount =
    options.maxFieldCount ?? DEFAULT_MAX_RFC_ERROR_ENVELOPE_FIELD_COUNT;
  boundedInteger(
    maxTextByteLength,
    0,
    0x7fff_ffff,
    "maxTextByteLength",
  );
  boundedInteger(
    maxTotalTextByteLength,
    0,
    0x7fff_ffff,
    "maxTotalTextByteLength",
  );
  boundedInteger(
    maxControlByteLength,
    0,
    0x7fff_ffff,
    "maxControlByteLength",
  );
  boundedInteger(
    maxTotalControlByteLength,
    0,
    0x7fff_ffff,
    "maxTotalControlByteLength",
  );
  boundedInteger(maxControlCount, 0, 0x7fff_ffff, "maxControlCount");
  boundedInteger(maxFieldCount, 1, 0x7fff_ffff, "maxFieldCount");

  const allowedTags = new Set(CLASSIC_RESPONSE_DATA_TAGS);
  for (const tag of options.additionalAllowedTags ?? []) {
    boundedInteger(tag, 0, 0xffff, "additionalAllowedTags entry");
    allowedTags.add(tag);
  }

  if (!Array.isArray(fields)) {
    protocolError(
      "RFC_ERROR_ENVELOPE_INVALID_FIELD",
      "RFCPRO response fields must be an array",
    );
  }
  if (fields.length > maxFieldCount) {
    protocolError(
      "RFC_ERROR_ENVELOPE_TOO_MANY_FIELDS",
      "RFCPRO response exceeds the configured envelope field-count limit",
    );
  }
  const endIndices: number[] = [];
  for (const [ordinal, field] of fields.entries()) {
    if (
      typeof field !== "object" ||
      field === null ||
      !Number.isSafeInteger(field.tag) ||
      field.tag < 0 ||
      field.tag > 0xffff ||
      !(field.value instanceof Uint8Array)
    ) {
      protocolError(
        "RFC_ERROR_ENVELOPE_INVALID_FIELD",
        `RFCPRO response field ${ordinal} is invalid`,
      );
    }
    if (field.tag === RFC_ERROR_ENVELOPE_END_TAG) endIndices.push(ordinal);
  }
  if (endIndices.length === 0) {
    protocolError(
      "RFC_ERROR_ENVELOPE_MISSING_END",
      "RFCPRO response lacks its terminal End field",
    );
  }
  const endIndex = endIndices[0]!;
  if (
    endIndices.length !== 1 ||
    endIndex !== fields.length - 1 ||
    fields[endIndex]!.value.byteLength !== 0
  ) {
    protocolError(
      "RFC_ERROR_ENVELOPE_INVALID_END",
      "RFCPRO response End field must occur once, last, with zero length",
    );
  }

  const values = new Map<number, string>();
  const present = new Set<number>();
  const provenance: RfcErrorFactProvenance[] = [];
  const unresolved0420: RfcUnresolvedControlFact[] = [];
  let totalTextByteLength = 0;
  let totalControlByteLength = 0;
  let controlCount = 0;
  let sawUseClassExceptions = false;
  let sawSupplementalClassExceptionInfo = false;

  for (let ordinal = 0; ordinal < endIndex; ordinal += 1) {
    const field = fields[ordinal]!;
    const { tag, value } = field;
    if (TEXT_TAGS.has(tag)) {
      if (present.has(tag)) {
        protocolError(
          "RFC_ERROR_ENVELOPE_DUPLICATE_FACT",
          `RFCPRO response repeats singleton error fact ${tagText(tag)}`,
        );
      }
      if (value.byteLength > maxTextByteLength) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TEXT_TOO_LARGE",
          `RFCPRO error fact ${tagText(tag)} exceeds the configured text limit`,
        );
      }
      if (totalTextByteLength > maxTotalTextByteLength - value.byteLength) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOTAL_TEXT_TOO_LARGE",
          "RFCPRO error facts exceed the configured aggregate text limit",
        );
      }
      totalTextByteLength += value.byteLength;
      present.add(tag);
      values.set(tag, decodeStrictUtf16Le(value, tag, maxTextByteLength));
      provenance.push(Object.freeze({ tag, ordinal, byteLength: value.byteLength }));
      continue;
    }
    if (tag === RfcErrorTag.Unresolved0420) {
      if (controlCount >= maxControlCount) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOO_MANY_CONTROLS",
          "RFCPRO response exceeds the configured control-count limit",
        );
      }
      if (value.byteLength > maxControlByteLength) {
        protocolError(
          "RFC_ERROR_ENVELOPE_CONTROL_TOO_LARGE",
          "unresolved RFCPRO control 0x0420 exceeds the configured limit",
        );
      }
      if (
        totalControlByteLength >
        maxTotalControlByteLength - value.byteLength
      ) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOTAL_CONTROL_TOO_LARGE",
          "RFCPRO response controls exceed the configured aggregate byte limit",
        );
      }
      controlCount += 1;
      totalControlByteLength += value.byteLength;
      unresolved0420.push({
        tag: RfcErrorTag.Unresolved0420,
        ordinal,
        byteLength: value.byteLength,
        valueHex: Buffer.from(value).toString("hex"),
      });
      provenance.push(Object.freeze({ tag, ordinal, byteLength: value.byteLength }));
      continue;
    }
    if (tag === RfcErrorTag.UseClassExceptions) {
      if (controlCount >= maxControlCount) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOO_MANY_CONTROLS",
          "RFCPRO response exceeds the configured control-count limit",
        );
      }
      if (sawUseClassExceptions) {
        protocolError(
          "RFC_ERROR_ENVELOPE_DUPLICATE_FACT",
          "RFCPRO response repeats singleton class-exception control 0x0421",
        );
      }
      if (value.byteLength > maxControlByteLength) {
        protocolError(
          "RFC_ERROR_ENVELOPE_CONTROL_TOO_LARGE",
          "RFCPRO class-exception control exceeds the configured limit",
        );
      }
      if (
        totalControlByteLength >
        maxTotalControlByteLength - value.byteLength
      ) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOTAL_CONTROL_TOO_LARGE",
          "RFCPRO response controls exceed the configured aggregate byte limit",
        );
      }
      controlCount += 1;
      totalControlByteLength += value.byteLength;
      sawUseClassExceptions = true;
      provenance.push(Object.freeze({ tag, ordinal, byteLength: value.byteLength }));
      continue;
    }
    if (tag === RfcErrorTag.ClassExceptionInfo) {
      if (controlCount >= maxControlCount) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOO_MANY_CONTROLS",
          "RFCPRO response exceeds the configured control-count limit",
        );
      }
      if (sawSupplementalClassExceptionInfo) {
        protocolError(
          "RFC_ERROR_ENVELOPE_DUPLICATE_FACT",
          "RFCPRO response repeats singleton class-exception info 0x0422",
        );
      }
      if (value.byteLength > maxControlByteLength) {
        protocolError(
          "RFC_ERROR_ENVELOPE_CONTROL_TOO_LARGE",
          "RFCPRO class-exception info exceeds the configured limit",
        );
      }
      if (
        totalControlByteLength >
        maxTotalControlByteLength - value.byteLength
      ) {
        protocolError(
          "RFC_ERROR_ENVELOPE_TOTAL_CONTROL_TOO_LARGE",
          "RFCPRO response controls exceed the configured aggregate byte limit",
        );
      }
      controlCount += 1;
      totalControlByteLength += value.byteLength;
      sawSupplementalClassExceptionInfo = true;
      // NetWeaver 7.50 can append this opaque basXML-related record to a
      // complete classic declared-exception envelope. Its classic fields are
      // authoritative; retain only bounded provenance and never the payload.
      provenance.push(Object.freeze({ tag, ordinal, byteLength: value.byteLength }));
      continue;
    }
    if (CLASS_EXCEPTION_TAGS.has(tag)) {
      protocolError(
        "RFC_ERROR_ENVELOPE_CLASS_EXCEPTION_UNSUPPORTED",
        `RFCPRO class-exception fact ${tagText(tag)} is not supported`,
      );
    }
    if (!allowedTags.has(tag)) {
      protocolError(
        "RFC_ERROR_ENVELOPE_UNKNOWN_TAG",
        `RFCPRO response contains unknown tag ${tagText(tag)}`,
      );
    }
  }

  const exceptionKey = values.get(RfcErrorTag.ExceptionKey) ?? "";
  const runtimeId = values.get(RfcErrorTag.RuntimeId) ?? "";
  if (present.has(RfcErrorTag.ExceptionKey) && exceptionKey.length === 0) {
    protocolError(
      "RFC_ERROR_ENVELOPE_EMPTY_DISCRIMINATOR",
      "RFCPRO declared-exception key is empty",
    );
  }
  if (present.has(RfcErrorTag.RuntimeId) && runtimeId.length === 0) {
    protocolError(
      "RFC_ERROR_ENVELOPE_EMPTY_DISCRIMINATOR",
      "RFCPRO runtime identifier is empty",
    );
  }
  if (
    present.has(RfcErrorTag.ExceptionKey) &&
    present.has(RfcErrorTag.RuntimeId)
  ) {
    protocolError(
      "RFC_ERROR_ENVELOPE_CONFLICTING_DISCRIMINATORS",
      "RFCPRO response contains both declared-exception and runtime identifiers",
    );
  }
  if (
    sawSupplementalClassExceptionInfo &&
    (!present.has(RfcErrorTag.ExceptionKey) || sawUseClassExceptions)
  ) {
    protocolError(
      "RFC_ERROR_ENVELOPE_CLASS_EXCEPTION_UNSUPPORTED",
      "RFCPRO class-exception info is only supported as supplemental data for a classic declared exception",
    );
  }

  let outcome: RfcErrorEnvelopeOutcome;
  let successControl: RfcErrorEnvelope["successControl"] = "notApplicable";
  if (present.has(RfcErrorTag.ExceptionKey)) {
    outcome = "abapException";
  } else if (present.has(RfcErrorTag.RuntimeId)) {
    outcome = "abapRuntime";
  } else if (
    hasNonEmptyFact(MESSAGE_TEXT_TAGS, present, values) ||
    hasCoherentMessageIdentity(present, values)
  ) {
    outcome = "abapMessage";
  } else if (hasAnyTag(SECONDARY_ERROR_TAGS, present)) {
    protocolError(
      "RFC_ERROR_ENVELOPE_AMBIGUOUS_FACTS",
      "RFCPRO response contains secondary error facts without a discriminator",
    );
  } else {
    const control = unresolved0420[0];
    if (
      unresolved0420.length !== 1 ||
      control === undefined ||
      control.byteLength !== 4 ||
      control.valueHex !== "00000000"
    ) {
      protocolError(
        "RFC_ERROR_ENVELOPE_UNRESOLVED_SUCCESS_CONTROL",
        "RFCPRO response lacks the zero 0x0420 success control",
      );
    }
    outcome = "success";
    successControl = "zeroControl";
  }

  const facts: RfcRemoteErrorFacts = Object.freeze({
    exceptionKey,
    plainText: values.get(RfcErrorTag.ErrorMessage) ?? "",
    runtimeId,
    t100Text: values.get(RfcErrorTag.T100Text) ?? "",
    messageClass: values.get(RfcErrorTag.MessageClass) ?? "",
    messageType: values.get(RfcErrorTag.MessageType) ?? "",
    messageNumber: values.get(RfcErrorTag.MessageNumber) ?? "",
    messageV1: values.get(RfcErrorTag.MessageV1) ?? "",
    messageV2: values.get(RfcErrorTag.MessageV2) ?? "",
    messageV3: values.get(RfcErrorTag.MessageV3) ?? "",
    messageV4: values.get(RfcErrorTag.MessageV4) ?? "",
    callStack: values.get(RfcErrorTag.CallStack) ?? "",
    provenance: freezeProvenance(provenance),
    unresolved0420: freezeControls(unresolved0420),
  });
  return Object.freeze({ outcome, successControl, facts });
}
