import { randomBytes } from "node:crypto";

import {
  intrinsicUint8ArrayView,
} from "./bytes.js";
import { MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH } from "./appc.js";
import {
  RFC_PRO_EXTENDED_LENGTH_SENTINEL,
  RFC_PRO_VALUE_LENGTH_MAX,
  decodeRfcProFieldHeader,
  encodeRfcProFieldHeader,
  rfcProFieldHeaderByteLength,
} from "./rfcpro.js";
import {
  decodeRfcErrorEnvelope,
  type RfcErrorEnvelope,
  type RfcErrorEnvelopeOutcome,
} from "./rfc-error-envelope.js";
import { scrambleRfcPassword } from "./password-scramble.js";
import { encodeRfcLogonTicket } from "./logon-ticket.js";

export const DEFAULT_MAX_CPIC_FIELD_LENGTH = 256 * 1024 * 1024;
export const DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH = 256 * 1024 * 1024;
export const DEFAULT_MAX_CPIC_FIELD_COUNT = 100_000;
/** Admitted request chunk size for classic xRFC XML values. */
export const CLASSIC_XRFC_XML_CHUNK_LENGTH = 16 * 1024;

/** Tags admitted by the bounded direct-CPIC contract. */
export enum CpicTag {
  Destination = 0x0006,
  ClientAddress = 0x0007,
  PartnerHost = 0x0008,
  Kernel = 0x000b,
  ConnectionType = 0x0011,
  KernelRelease = 0x0012,
  KernelPatch = 0x0013,
  PartnerSystem = 0x0018,
  SystemCodePage = 0x0016,
  Start = 0x0101,
  Function = 0x0102,
  ProtocolVersion = 0x0103,
  Capabilities = 0x0106,
  User = 0x0111,
  Client = 0x0114,
  Language = 0x0115,
  Password = 0x0117,
  Program = 0x0130,
  LogonStatus = 0x0161,
  ParameterName = 0x0201,
  ParameterValue = 0x0203,
  RequestedOutput = 0x0205,
  TableName = 0x0301,
  TableHeader = 0x0302,
  TableContent = 0x0303,
  TableCompr = 0x0304,
  AbapExceptionKey = 0x0401,
  AbapErrorMessage = 0x0402,
  AbapRuntimeId = 0x0403,
  AbapT100Text = 0x0404,
  AbapMessageV1 = 0x0411,
  AbapMessageV2 = 0x0412,
  AbapMessageV3 = 0x0413,
  AbapMessageV4 = 0x0414,
  AbapMessageClass = 0x0415,
  AbapMessageType = 0x0416,
  AbapMessageNumber = 0x0417,
  AbapCallStack = 0x0418,
  Unresolved0420 = 0x0420,
  UseClassExceptions = 0x0421,
  ClassExceptionInfo = 0x0422,
  ClassException = 0x0423,
  ClassExceptionEnd = 0x0424,
  LogonMarker = 0x0337,
  UnicodeIndicator = 0x0501,
  ContextEnd = 0x0502,
  ResponseStart = 0x0500,
  ResponseContext = 0x0503,
  CallContext = 0x0512,
  Session = 0x0514,
  /** Successful reply marker for SYSTEM_RESET_RFC_SERVER. */
  RfcServerResetDone = 0x0523,
  /** SAP logon ticket (MYSAPSSO2) used instead of Password. */
  Ticket = 0x0670,
  /** Empty open/close boundary surrounding one classic xRFC XML parameter. */
  XRfcParameter = 0x3c02,
  /** UTF-8 xRFC XML data chunk inside XRfcParameter boundaries. */
  XRfcData = 0x3c05,
  End = 0xffff,
}

/** Unexported six-byte successful-logon control observed on S/4HANA 2023. */
const INITIAL_CPIC_UNRESOLVED_0450 = 0x0450;

export interface CpicField {
  readonly tag: number;
  readonly value: Uint8Array;
}

export interface CpicRequestAppcFraming {
  readonly mode: "compact" | "streamed";
  /** Bytes before the compact eight-byte SAP tail, or all streamed bytes. */
  readonly applicationDataLength: number;
  readonly finalSapParameterLength: 0 | 8;
}

export interface CpicFieldChainLimits {
  readonly maxFieldLength?: number;
  readonly maxChainLength?: number;
  readonly maxFieldCount?: number;
}

export interface DecodedCpicFieldChainPrefix {
  readonly fields: DecodedCpicField[];
  readonly bytesConsumed: number;
}

interface DecodedCpicField {
  readonly tag: number;
  readonly value: Buffer;
}

interface CpicInitialLogonRequestBase {
  readonly client: string;
  readonly user: string;
  readonly language: string;
  readonly clientAddress: string;
  readonly partnerSystem?: string;
  readonly partnerHostName: string;
  readonly destination: string;
  readonly programName: string;
  readonly functionName?: string;
  readonly kernelRelease?: string;
  readonly sessionId?: Uint8Array;
  readonly maximumRfcPacketSize?: number;
}

export type CpicInitialLogonRequestInput = CpicInitialLogonRequestBase & (
  | {
    readonly password: string;
    readonly passwordSeed?: number;
    readonly ticket?: never;
  }
  | {
    readonly ticket: string;
    readonly password?: never;
    readonly passwordSeed?: never;
  }
);

export interface DecodedCpicInitialLogonRequest {
  readonly fields: ReadonlyArray<{
    readonly tag: number;
    readonly byteLength: number;
  }>;
  readonly cpicPacketSize: number;
  readonly maximumRfcPacketSize: number;
}

/**
 * What the backend itself said about a rejected logon.
 *
 * An error-class initial response carries the server's own reason. An earlier
 * revision decoded that envelope purely to confirm the outcome was not
 * `success` and then discarded it, so a rejection reached the caller with no
 * reason at all and every rejection looked alike. The identity fields are an
 * SAP message coordinate (class / type / number), not free text; `text` is the
 * backend's own message and callers that persist evidence must treat it as
 * backend text and omit it.
 */
export interface DecodedCpicInitialLogonRejection {
  readonly outcome: RfcErrorEnvelope["outcome"];
  readonly messageClass: string;
  readonly messageType: string;
  readonly messageNumber: string;
  readonly exceptionKey: string;
  readonly runtimeId: string;
  readonly text: string;
}

export interface DecodedCpicInitialLogonResponse {
  readonly success: boolean;
  /** Numeric 0x0161 status when the backend supplied one. */
  readonly status?: number;
  /** Present only for an error-class response the backend explained. */
  readonly rejection?: DecodedCpicInitialLogonRejection;
  readonly negotiatedProtocolVersion: number;
  readonly fields: ReadonlyArray<{
    readonly tag: number;
    readonly byteLength: number;
  }>;
}

type InitialCpicLogonStructureRule =
  | "unsupported-field"
  | "unsupported-field-zero-logon-status"
  | "invalid-end-field"
  | "invalid-start-field"
  | "malformed-vendor-logon-control"
  | "duplicate-control-field"
  | "malformed-one-byte-status"
  | "malformed-call-status"
  | "missing-logon-status"
  | "nonzero-call-status";

type InitialCpicLogonParseStage =
  | "truncated"
  | "prefix"
  | "field-chain"
  | "trailer"
  | "protocol"
  | "error-preamble"
  | "error-envelope"
  | "structural";

const INITIAL_CPIC_LOGON_STRUCTURE_PROJECTOR_SYMBOL = Symbol.for(
  "open-rfc.internal.initial-cpic-logon-structure-projector/v1",
);
const INITIAL_CPIC_LOGON_PARSE_STAGE_PROJECTOR_SYMBOL = Symbol.for(
  "open-rfc.internal.initial-cpic-logon-parse-stage-projector/v1",
);
const INITIAL_CPIC_LOGON_STRUCTURE_ERROR_INSTANCES = new WeakSet<object>();
const INITIAL_CPIC_LOGON_PARSE_STAGES =
  new WeakMap<object, InitialCpicLogonParseStage>();

/** Internal redaction-safe detail copied into a hidden public assertion. */
class CpicInitialLogonStructureError extends Error {
  declare readonly rule: InitialCpicLogonStructureRule;
  declare readonly fields: ReadonlyArray<{
    readonly tag: number;
    readonly byteLength: number;
    readonly index: number;
  }>;

  constructor(
    rule: InitialCpicLogonStructureRule,
    message: string,
    fields: ReadonlyArray<{ readonly tag: number; readonly byteLength: number }>,
  ) {
    super(message);
    INITIAL_CPIC_LOGON_STRUCTURE_ERROR_INSTANCES.add(this);
    Object.defineProperty(this, "name", {
      value: "CpicInitialLogonStructureError",
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const structuralFields = Object.freeze(fields.map((field, index) =>
      Object.freeze({
        tag: field.tag,
        byteLength: field.byteLength,
        index,
      })
    ));
    Object.defineProperty(this, "rule", {
      value: rule,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(this, "fields", {
      value: structuralFields,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

function projectInitialCpicLogonStructure(cause: unknown): unknown {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !INITIAL_CPIC_LOGON_STRUCTURE_ERROR_INSTANCES.has(cause)
  ) return null;
  const diagnostic = cause as CpicInitialLogonStructureError;
  return Object.freeze({ rule: diagnostic.rule, fields: diagnostic.fields });
}

function projectInitialCpicLogonParseStage(cause: unknown): unknown {
  if (typeof cause !== "object" || cause === null) return null;
  return INITIAL_CPIC_LOGON_PARSE_STAGES.get(cause) ?? null;
}

// Reuse an existing internal-module export as the host for a loader-local,
// declaration-invisible projector. The public error adapter imports this exact
// function object, so the WeakSet provenance remains scoped to the same module
// instance without widening the package's declaration surface.
Object.defineProperty(
  decodeCpicInitialLogonResponse,
  INITIAL_CPIC_LOGON_STRUCTURE_PROJECTOR_SYMBOL,
  {
    value: projectInitialCpicLogonStructure,
    enumerable: false,
    configurable: false,
    writable: false,
  },
);

Object.defineProperty(
  decodeCpicInitialLogonResponse,
  INITIAL_CPIC_LOGON_PARSE_STAGE_PROJECTOR_SYMBOL,
  {
    value: projectInitialCpicLogonParseStage,
    enumerable: false,
    configurable: false,
    writable: false,
  },
);

function registerInitialCpicLogonParseStage(
  stage: InitialCpicLogonParseStage,
  error: unknown,
): never {
  if (typeof error === "object" && error !== null) {
    INITIAL_CPIC_LOGON_PARSE_STAGES.set(error, stage);
  }
  throw error;
}

function failInitialCpicLogonParse(
  stage: InitialCpicLogonParseStage,
  message: string,
  ErrorConstructor: ErrorConstructor = Error,
): never {
  registerInitialCpicLogonParseStage(stage, new ErrorConstructor(message));
}

function failInitialCpicLogonStructure(
  rule: InitialCpicLogonStructureRule,
  message: string,
  fields: ReadonlyArray<{ readonly tag: number; readonly byteLength: number }>,
): never {
  registerInitialCpicLogonParseStage(
    "structural",
    new CpicInitialLogonStructureError(rule, message, fields),
  );
}

export interface CpicFunctionRequestInput {
  readonly functionName: string;
  readonly sessionId: Uint8Array;
  readonly kernelRelease?: string;
  readonly maximumRfcPacketSize?: number;
}

export interface CpicCutFunctionRequestInput {
  readonly functionName: string;
  readonly requestedOutputs?: readonly string[];
  readonly imports?: ReadonlyArray<{
    readonly name: string;
    readonly value: Uint8Array;
  }>;
  readonly tables?: ReadonlyArray<{
    readonly name: string;
    readonly rowByteLength: number;
    readonly rows: readonly Uint8Array[];
  }>;
  readonly xrfcParameters?: ReadonlyArray<{
    /** Used for duplicate/conflict diagnostics; the XML root carries the wire name. */
    readonly name: string;
    readonly value: Uint8Array;
  }>;
  readonly kernelRelease?: string;
  readonly maximumRfcPacketSize?: number;
}

export interface DecodedCpicFunctionResponse {
  readonly success: boolean;
  readonly outcome: RfcErrorEnvelopeOutcome;
  readonly status: number | undefined;
  readonly exceptionKey?: string;
  readonly fields: ReadonlyArray<{
    readonly tag: number;
    readonly byteLength: number;
  }>;
}

export interface DecodedCpicFunctionResultFields {
  readonly success: boolean;
  readonly status: number | undefined;
  readonly envelope: RfcErrorEnvelope;
  readonly fields: ReadonlyArray<{
    readonly tag: number;
    readonly value: Buffer;
  }>;
}

function uint16(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${field} must be an integer in 0..65535`);
  }
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

function tagText(tag: number): string {
  return `0x${tag.toString(16).padStart(4, "0")}`;
}

function ascii(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): Buffer {
  const length = Buffer.byteLength(value, "ascii");
  if (!/^[\x20-\x7e]*$/.test(value) || length < minimum || length > maximum) {
    throw new RangeError(
      `${field} must contain ${minimum}..${maximum} ASCII bytes`,
    );
  }
  return Buffer.from(value, "ascii");
}

function exactBytes(value: Uint8Array, length: number, field: string): Buffer {
  const result = Buffer.from(value);
  if (result.byteLength !== length) {
    throw new RangeError(
      `${field} must contain exactly ${length} bytes; received ${result.byteLength}`,
    );
  }
  return result;
}

/**
 * Encode CPIC's chained field grammar. Each record names both the previous
 * and current tag, allowing a decoder to detect dropped or reordered fields.
 */
export function encodeCpicFieldChain(
  initialPreviousTag: number,
  fields: readonly CpicField[],
  limits: CpicFieldChainLimits = {},
): Buffer {
  const byteLength = cpicFieldChainByteLength(
    initialPreviousTag,
    fields,
    limits,
  );
  const encoded = Buffer.alloc(byteLength);
  let offset = 0;
  let previousTag = initialPreviousTag;
  for (const field of fields) {
    encoded.writeUInt16BE(previousTag, offset);
    offset += 2;
    const header = encodeRfcProFieldHeader(field.tag, field.value.byteLength);
    encoded.set(header, offset);
    offset += header.byteLength;
    encoded.set(field.value, offset);
    offset += field.value.byteLength;
    previousTag = field.tag;
  }
  return encoded;
}

function cpicFieldChainByteLength(
  initialPreviousTag: number,
  fields: readonly CpicField[],
  limits: CpicFieldChainLimits = {},
): number {
  uint16(initialPreviousTag, "initialPreviousTag");
  const resolvedLimits = resolveCpicFieldChainLimits(limits);
  if (fields.length > resolvedLimits.maxFieldCount) {
    throw new RangeError(
      `CPIC field count ${fields.length} exceeds configured limit ${resolvedLimits.maxFieldCount}`,
    );
  }
  let byteLength = 0;
  for (const field of fields) {
    uint16(field.tag, "tag");
    if (field.value.byteLength > resolvedLimits.maxFieldLength) {
      throw new RangeError(
        `CPIC field length ${field.value.byteLength} exceeds configured limit ${resolvedLimits.maxFieldLength}`,
      );
    }
    byteLength +=
      2 +
      rfcProFieldHeaderByteLength(field.value.byteLength) +
      field.value.byteLength;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength > resolvedLimits.maxChainLength
    ) {
      throw new RangeError(
        `CPIC field chain length exceeds configured limit ${resolvedLimits.maxChainLength}`,
      );
    }
  }

  return byteLength;
}

/** Decode and validate a complete chained CPIC field region. */
export function decodeCpicFieldChain(
  data: Uint8Array,
  initialPreviousTag: number,
  limits: CpicFieldChainLimits = {},
): DecodedCpicField[] {
  const decoded = decodeCpicFieldChainRegion(
    data,
    initialPreviousTag,
    undefined,
    limits,
  );
  if (decoded.bytesConsumed !== data.byteLength) {
    throw new Error("CPIC field-chain decoder invariant failed");
  }
  return decoded.fields;
}

/**
 * Decode a chained field prefix through a required terminal tag, leaving any
 * following protocol trailer to its own semantic decoder.
 */
export function decodeCpicFieldChainPrefix(
  data: Uint8Array,
  initialPreviousTag: number,
  terminalTag: number,
  limits: CpicFieldChainLimits = {},
): DecodedCpicFieldChainPrefix {
  uint16(terminalTag, "terminalTag");
  return decodeCpicFieldChainRegion(
    data,
    initialPreviousTag,
    terminalTag,
    limits,
  );
}

function decodeCpicFieldChainRegion(
  data: Uint8Array,
  initialPreviousTag: number,
  terminalTag?: number,
  limits: CpicFieldChainLimits = {},
): DecodedCpicFieldChainPrefix {
  uint16(initialPreviousTag, "initialPreviousTag");
  const resolvedLimits = resolveCpicFieldChainLimits(limits);
  if (
    terminalTag === undefined &&
    data.byteLength > resolvedLimits.maxChainLength
  ) {
    throw new RangeError(
      `CPIC field chain length ${data.byteLength} exceeds configured limit ${resolvedLimits.maxChainLength}`,
    );
  }
  const fields: DecodedCpicField[] = [];
  let expectedPreviousTag = initialPreviousTag;
  let offset = 0;
  while (offset < data.byteLength) {
    if (fields.length >= resolvedLimits.maxFieldCount) {
      throw new RangeError(
        `CPIC field count exceeds configured limit ${resolvedLimits.maxFieldCount}`,
      );
    }

    enforceCpicChainLength(offset + 6, resolvedLimits.maxChainLength);
    requireCpicInput(data, offset, 6, "fieldHeader");
    const minimumHeader = Buffer.from(data.subarray(offset, offset + 6));
    const previousTag = minimumHeader.readUInt16BE(0);
    if (previousTag !== expectedPreviousTag) {
      throw new Error(
        `CPIC field chain expected previous tag ${tagText(expectedPreviousTag)}; ` +
          `received ${tagText(previousTag)}`,
      );
    }

    let headerSnapshot: Buffer = minimumHeader.subarray(2);
    if (
      minimumHeader.readUInt16BE(4) ===
      RFC_PRO_EXTENDED_LENGTH_SENTINEL
    ) {
      enforceCpicChainLength(offset + 10, resolvedLimits.maxChainLength);
      requireCpicInput(data, offset + 6, 4, "extendedLength");
      headerSnapshot = Buffer.alloc(8);
      minimumHeader.copy(headerSnapshot, 0, 2, 6);
      headerSnapshot.set(data.subarray(offset + 6, offset + 10), 4);
    }
    const header = decodeRfcProFieldHeader(headerSnapshot, {
      maxValueLength: resolvedLimits.maxFieldLength,
    });
    const valueOffset = offset + 2 + header.bytesConsumed;
    const nextOffset = valueOffset + header.length;
    enforceCpicChainLength(nextOffset, resolvedLimits.maxChainLength);
    requireCpicInput(data, valueOffset, header.length, "value");
    fields.push({
      tag: header.tag,
      value: Buffer.from(data.subarray(valueOffset, nextOffset)),
    });
    offset = nextOffset;
    expectedPreviousTag = header.tag;
    if (terminalTag !== undefined && header.tag === terminalTag) {
      return { fields, bytesConsumed: offset };
    }
  }
  if (terminalTag !== undefined) {
    throw new Error(
      `CPIC field chain ended before terminal tag ${tagText(terminalTag)}`,
    );
  }
  return { fields, bytesConsumed: offset };
}

function enforceCpicChainLength(
  byteLength: number,
  maximum: number,
): void {
  if (byteLength > maximum) {
    throw new RangeError(
      `CPIC field chain length ${byteLength} exceeds configured limit ${maximum}`,
    );
  }
}

function requireCpicInput(
  data: Uint8Array,
  offset: number,
  byteLength: number,
  field: string,
): void {
  const remaining = Math.max(0, data.byteLength - offset);
  if (byteLength > remaining) {
    throw new RangeError(
      `CPIC field chain.${field}: need ${byteLength} bytes at offset ${offset}; ${remaining} remain`,
    );
  }
}

function resolveCpicFieldChainLimits(
  limits: CpicFieldChainLimits,
): Required<CpicFieldChainLimits> {
  const resolved = {
    maxFieldLength: limits.maxFieldLength ?? DEFAULT_MAX_CPIC_FIELD_LENGTH,
    maxChainLength:
      limits.maxChainLength ?? DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
    maxFieldCount: limits.maxFieldCount ?? DEFAULT_MAX_CPIC_FIELD_COUNT,
  };
  boundedInteger(
    resolved.maxFieldLength,
    0,
    RFC_PRO_VALUE_LENGTH_MAX,
    "maxFieldLength",
  );
  boundedInteger(
    resolved.maxChainLength,
    0,
    RFC_PRO_VALUE_LENGTH_MAX,
    "maxChainLength",
  );
  boundedInteger(
    resolved.maxFieldCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "maxFieldCount",
  );
  return resolved;
}

const INITIAL_CPIC_SIGNATURE = Buffer.from("d9c6c3f0f0f0f0f0f0f0f0f0", "hex");
const INITIAL_CPIC_PREFIX = Buffer.from("010100080301", "hex");
const INITIAL_CPIC_RESPONSE_PREFIX = Buffer.from(
  "010100080101010504010003",
  "hex",
);
const INITIAL_CPIC_ERROR_RESPONSE_PREFIX = Buffer.from(
  "010100080101010101010000",
  "hex",
);
const INITIAL_CPIC_REGULAR_RESPONSE_TAGS = new Set<number>([
  CpicTag.Start,
  CpicTag.ProtocolVersion,
  CpicTag.Capabilities,
  CpicTag.LogonStatus,
  CpicTag.Unresolved0420,
  INITIAL_CPIC_UNRESOLVED_0450,
  CpicTag.SystemCodePage,
  CpicTag.End,
]);
/**
 * One coordinate of an initial logon-response grammar.
 *
 * `byteLength` pins a control coordinate to one exact width; `byteLengths`
 * admits a small per-coordinate release/encoding set. `maxByteLength` bounds a
 * coordinate that carries a name or address and therefore varies with the
 * endpoint rather than with the protocol. A coordinate declares one form.
 */
interface InitialCpicGrammarCoordinate {
  readonly tag: number;
  readonly byteLength?: number;
  readonly byteLengths?: readonly number[];
  readonly maxByteLength?: number;
  readonly optional?: true;
}

/**
 * Upper bound for a text coordinate. SAP pads these to fixed internal widths,
 * so the exact value is a property of the endpoint's own names, not of the
 * wire format. Bounding rather than pinning is the whole point of this grammar:
 * an earlier revision enumerated whole response graphs with every width fixed,
 * which made a two-character difference in a host name indistinguishable from a
 * malformed response, and reported successful logons as RFC_INVALID_PROTOCOL.
 */
const INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH = 255;

/**
 * The terminal logon-error preamble. NetWeaver may include a one-byte status
 * and three additional bounded controls around the same stable identity
 * fields, while older error replies omit them. Text coordinates vary with
 * endpoint configuration; allowed control widths and order remain explicit.
 */
const INITIAL_CPIC_ERROR_PREAMBLE_GRAMMAR:
  readonly InitialCpicGrammarCoordinate[] = Object.freeze([
    { tag: CpicTag.ProtocolVersion, byteLength: 4 },
    { tag: CpicTag.Capabilities, byteLength: 11 },
    { tag: CpicTag.LogonStatus, byteLength: 1, optional: true },
    { tag: CpicTag.SystemCodePage, byteLengths: [4, 8] },
    { tag: INITIAL_CPIC_UNRESOLVED_0450, byteLength: 3, optional: true },
    {
      tag: CpicTag.ClientAddress,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: 0x0020, byteLength: 46, optional: true },
    { tag: 0x0021, byteLength: 10, optional: true },
    {
      tag: CpicTag.PartnerSystem,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    {
      tag: CpicTag.PartnerHost,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: CpicTag.ConnectionType, byteLengths: [1, 2] },
    { tag: CpicTag.KernelPatch, byteLengths: [4, 8] },
    { tag: CpicTag.KernelRelease, byteLengths: [4, 8] },
    {
      tag: CpicTag.Destination,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    {
      tag: CpicTag.Program,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: CpicTag.ResponseStart, byteLength: 0 },
  ]);

/**
 * The logon/session preamble. Order is exact and every tag must be listed;
 * only the marked coordinates may be absent, and only the `maxByteLength`
 * coordinates may vary in width. Unknown tags, reordering, duplication,
 * a missing required coordinate and a control coordinate of the wrong width
 * all still fail closed.
 */
const INITIAL_CPIC_RICH_RFCPING_PREAMBLE_GRAMMAR:
  readonly InitialCpicGrammarCoordinate[] = Object.freeze([
    { tag: CpicTag.ProtocolVersion, byteLength: 4 },
    { tag: CpicTag.Capabilities, byteLength: 11 },
    { tag: CpicTag.LogonStatus, byteLength: 1, optional: true },
    { tag: CpicTag.SystemCodePage, byteLength: 8 },
    { tag: INITIAL_CPIC_UNRESOLVED_0450, byteLength: 6, optional: true },
    { tag: 0x0451, byteLength: 20, optional: true },
    { tag: 0x0452, byteLength: 4, optional: true },
    {
      tag: 0x0453,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
      optional: true,
    },
    {
      tag: CpicTag.ClientAddress,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: 0x0020, byteLength: 92, optional: true },
    { tag: 0x0021, byteLength: 20, optional: true },
    {
      tag: CpicTag.PartnerSystem,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    {
      tag: CpicTag.PartnerHost,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: CpicTag.ConnectionType, byteLength: 2 },
    { tag: CpicTag.KernelPatch, byteLength: 8 },
    { tag: CpicTag.KernelRelease, byteLength: 8 },
    {
      tag: CpicTag.Destination,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
      optional: true,
    },
    {
      tag: CpicTag.Program,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: 0x0150, byteLength: 24 },
    { tag: 0x0151, byteLength: 6 },
    { tag: 0x0152, byteLength: 2 },
  ]);

/**
 * The embedded ordinary RFCPING response, opened by the sole empty
 * `ResponseStart` that partitions the composite. The four-byte call status
 * stays mandatory and exact: it is what decides success.
 */
const INITIAL_CPIC_RICH_RFCPING_RESPONSE_GRAMMAR:
  readonly InitialCpicGrammarCoordinate[] = Object.freeze([
    { tag: CpicTag.ResponseStart, byteLength: 0 },
    { tag: CpicTag.ResponseContext, byteLength: 0 },
    { tag: CpicTag.Session, byteLength: 16 },
    { tag: CpicTag.Unresolved0420, byteLength: 4 },
    { tag: CpicTag.CallContext, byteLength: 0 },
    {
      tag: CpicTag.Program,
      maxByteLength: INITIAL_CPIC_MAX_TEXT_COORDINATE_BYTE_LENGTH,
    },
    { tag: 0x0667, byteLength: 8 },
    { tag: 0x0126, byteLength: 4, optional: true },
    { tag: CpicTag.End, byteLength: 0 },
  ]);

const INITIAL_CPIC_RICH_RFCPING_GRAMMAR:
  readonly InitialCpicGrammarCoordinate[] = Object.freeze([
    ...INITIAL_CPIC_RICH_RFCPING_PREAMBLE_GRAMMAR,
    ...INITIAL_CPIC_RICH_RFCPING_RESPONSE_GRAMMAR,
  ]);

/** Highest count each tag may reach across the whole grammar. */
const INITIAL_CPIC_RICH_RFCPING_TAG_LIMITS: ReadonlyMap<number, number> =
  (() => {
    const limits = new Map<number, number>();
    for (const coordinate of INITIAL_CPIC_RICH_RFCPING_GRAMMAR) {
      limits.set(coordinate.tag, (limits.get(coordinate.tag) ?? 0) + 1);
    }
    return limits;
  })();

interface InitialCpicGrammarMatch {
  /** Coordinates consumed before the embedded response opens. */
  readonly preambleFieldCount: number;
  /** Optional embedded controls this response actually carried. */
  readonly embeddedAllowedTags: readonly number[];
}

interface InitialCpicErrorPreambleMatch {
  readonly fieldCount: number;
  readonly allowedTags: readonly number[];
}

function matchesInitialCpicGrammarCoordinate(
  field: DecodedCpicField,
  coordinate: InitialCpicGrammarCoordinate,
): boolean {
  if (field.tag !== coordinate.tag) return false;
  if (coordinate.byteLength !== undefined) {
    return field.value.byteLength === coordinate.byteLength;
  }
  if (coordinate.byteLengths !== undefined) {
    return coordinate.byteLengths.includes(field.value.byteLength);
  }
  return field.value.byteLength >= 1 &&
    field.value.byteLength <= coordinate.maxByteLength!;
}

function matchInitialCpicErrorPreamble(
  fields: readonly DecodedCpicField[],
): InitialCpicErrorPreambleMatch | null {
  let fieldIndex = 0;
  const allowedTags: number[] = [];
  for (const coordinate of INITIAL_CPIC_ERROR_PREAMBLE_GRAMMAR) {
    const field = fields[fieldIndex];
    if (
      field !== undefined &&
      matchesInitialCpicGrammarCoordinate(field, coordinate)
    ) {
      allowedTags.push(coordinate.tag);
      fieldIndex += 1;
      continue;
    }
    if (coordinate.optional === true) continue;
    return null;
  }
  return Object.freeze({
    fieldCount: fieldIndex,
    allowedTags: Object.freeze(allowedTags),
  });
}

/**
 * Walk the field chain against the grammar in order. Tags disambiguate every
 * choice, so the walk is deterministic and needs no backtracking: at each step
 * the next field either matches the next coordinate or that coordinate must be
 * optional and is skipped. Trailing unmatched fields fail.
 */
function matchInitialCpicRichGrammar(
  fields: readonly DecodedCpicField[],
): InitialCpicGrammarMatch | null {
  let fieldIndex = 0;
  let preambleFieldCount = -1;
  const embeddedAllowedTags: number[] = [];
  for (const coordinate of INITIAL_CPIC_RICH_RFCPING_GRAMMAR) {
    const field = fields[fieldIndex];
    if (field !== undefined && matchesInitialCpicGrammarCoordinate(field, coordinate)) {
      if (coordinate.tag === CpicTag.ResponseStart) {
        preambleFieldCount = fieldIndex;
      }
      if (coordinate.tag === 0x0126) embeddedAllowedTags.push(0x0126);
      fieldIndex += 1;
      continue;
    }
    if (coordinate.optional === true) continue;
    return null;
  }
  if (fieldIndex !== fields.length || preambleFieldCount < 0) return null;
  return Object.freeze({
    preambleFieldCount,
    embeddedAllowedTags: Object.freeze(embeddedAllowedTags),
  });
}

function hasInitialCpicCompositeDuplicate(
  fields: readonly DecodedCpicField[],
): boolean {
  const actualCounts = new Map<number, number>();
  for (const field of fields) {
    actualCounts.set(field.tag, (actualCounts.get(field.tag) ?? 0) + 1);
  }
  for (const [tag, limit] of INITIAL_CPIC_RICH_RFCPING_TAG_LIMITS) {
    if ((actualCounts.get(tag) ?? 0) > limit) return true;
  }
  return false;
}
const CPIC_FUNCTION_REQUEST_PREFIX = Buffer.from(
  "010100080301010504010003",
  "hex",
);
const CPIC_FUNCTION_RESPONSE_PREFIX = Buffer.from("05000000", "hex");
const CPIC_CUT_FUNCTION_REQUEST_PREFIX = Buffer.from("05020000", "hex");
const INITIAL_PROTOCOL_VERSION = Buffer.from("00000e09", "hex");
const INITIAL_CAPABILITIES = Buffer.from("04010003000a0200000023", "hex");
const INITIAL_TAG_ORDER = [
  CpicTag.Start,
  CpicTag.ProtocolVersion,
  CpicTag.Capabilities,
  CpicTag.LogonMarker,
  CpicTag.Session,
  CpicTag.Client,
  CpicTag.User,
  CpicTag.Password,
  CpicTag.Language,
  CpicTag.UnicodeIndicator,
  CpicTag.ClientAddress,
  CpicTag.PartnerSystem,
  CpicTag.ConnectionType,
  CpicTag.KernelRelease,
  CpicTag.KernelPatch,
  CpicTag.PartnerHost,
  CpicTag.Destination,
  CpicTag.Program,
  CpicTag.ContextEnd,
  CpicTag.Kernel,
  CpicTag.Function,
  CpicTag.End,
] as const;


function decodeRichInitialCpicRfcPingResponse(
  fields: readonly DecodedCpicField[],
  structuralFields: ReadonlyArray<{
    readonly tag: number;
    readonly byteLength: number;
  }>,
  protocol: DecodedCpicField,
): DecodedCpicInitialLogonResponse {
  const endFields = fields.filter((field) => field.tag === CpicTag.End);
  if (
    endFields.length !== 1 ||
    fields.at(-1)?.tag !== CpicTag.End ||
    endFields[0]!.value.byteLength !== 0
  ) {
    failInitialCpicLogonStructure(
      "invalid-end-field",
      "initial CPIC RFCPING composite response has an invalid End field",
      structuralFields,
    );
  }
  const oneByteStatuses = fields.filter(
    (field) => field.tag === CpicTag.LogonStatus,
  );
  if (
    oneByteStatuses.length > 1 ||
    (oneByteStatuses.length === 1 &&
      oneByteStatuses[0]!.value.byteLength !== 1)
  ) {
    failInitialCpicLogonStructure(
      "malformed-one-byte-status",
      "initial CPIC RFCPING composite response has malformed logon status",
      structuralFields,
    );
  }
  const callStatuses = fields.filter(
    (field) => field.tag === CpicTag.Unresolved0420,
  );
  if (
    callStatuses.length !== 1 ||
    callStatuses[0]!.value.byteLength !== 4
  ) {
    failInitialCpicLogonStructure(
      "malformed-call-status",
      "initial CPIC RFCPING composite response has malformed call status",
      structuralFields,
    );
  }
  if (hasInitialCpicCompositeDuplicate(fields)) {
    failInitialCpicLogonStructure(
      "duplicate-control-field",
      "initial CPIC RFCPING composite response has a duplicate field",
      structuralFields,
    );
  }
  // Read the status before the shape check so an unenumerated graph does not
  // discard what SAP itself said. A malformed status was already rejected
  // above, so this is either the one status byte or a deliberate absence.
  const status = oneByteStatuses.length === 1
    ? oneByteStatuses[0]!.value[0]!
    : 0;
  const grammarMatch = matchInitialCpicRichGrammar(fields);
  if (grammarMatch === null) {
    // Still fails closed either way; only the rule differs. A zero logon status
    // means the server did not reject the credential, so this is a decoder gap
    // and not an authentication failure. Reading the resulting
    // RFC_INVALID_PROTOCOL as a rejected password is the misdiagnosis this
    // distinction exists to prevent.
    failInitialCpicLogonStructure(
      status === 0
        ? "unsupported-field-zero-logon-status"
        : "unsupported-field",
      "initial CPIC RFCPING composite response does not match the bounded composite shape",
      structuralFields,
    );
  }
  // A nonzero one-byte logon status is a valid SAP rejection, not malformed
  // protocol. Preserve that status and do not interpret an embedded call
  // success control after authentication itself failed.
  if (status !== 0) {
    return {
      success: false,
      status,
      negotiatedProtocolVersion: Buffer.from(protocol.value).readUInt32BE(0),
      fields: structuralFields,
    };
  }
  if (callStatuses[0]!.value.readUInt32BE(0) !== 0) {
    failInitialCpicLogonStructure(
      "nonzero-call-status",
      "initial CPIC RFCPING composite response has nonzero call status",
      structuralFields,
    );
  }

  const embedded = decodeCpicFunctionResponseFields(
    fields.slice(grammarMatch.preambleFieldCount + 1),
    grammarMatch.embeddedAllowedTags,
  );
  if (!embedded.success) {
    failInitialCpicLogonStructure(
      "nonzero-call-status",
      "initial CPIC RFCPING composite response is not successful",
      structuralFields,
    );
  }
  return {
    success: true,
    status,
    negotiatedProtocolVersion: Buffer.from(protocol.value).readUInt32BE(0),
    fields: structuralFields,
  };
}

/**
 * Encode the bounded initial CPIC logon request. The caller
 * supplies semantic identity fields; constants are kept named and validated.
 */
export function encodeCpicInitialLogonRequest(
  input: CpicInitialLogonRequestInput,
): Buffer {
  if (!/^\d{3}$/.test(input.client)) {
    throw new RangeError("client must contain exactly three ASCII digits");
  }
  if (!/^[A-Za-z]$/.test(input.language)) {
    throw new RangeError("language must contain one ASCII letter");
  }
  const kernelRelease = input.kernelRelease ?? "754";
  if (!/^\d{3}$/.test(kernelRelease)) {
    throw new RangeError(
      "kernelRelease must contain exactly three ASCII digits",
    );
  }
  const maximumRfcPacketSize = input.maximumRfcPacketSize ?? 0x8500;
  if (
    !Number.isSafeInteger(maximumRfcPacketSize) ||
    maximumRfcPacketSize < 0 ||
    maximumRfcPacketSize > 0xffff_ffff
  ) {
    throw new RangeError(
      "maximumRfcPacketSize must be an unsigned 32-bit integer",
    );
  }

  const hasPassword = input.password !== undefined;
  const hasTicket = input.ticket !== undefined;
  if (hasPassword === hasTicket) {
    throw new TypeError(
      "initial CPIC logon requires exactly one of password or ticket",
    );
  }
  if (hasTicket && input.passwordSeed !== undefined) {
    throw new TypeError("passwordSeed cannot be combined with ticket");
  }
  const credential = hasTicket
    ? encodeRfcLogonTicket(input.ticket!)
    : scrambleRfcPassword(input.password!, input.passwordSeed);
  const credentialTag = hasTicket ? CpicTag.Ticket : CpicTag.Password;
  let chain: Buffer | undefined;
  try {
    const sessionId = exactBytes(
      input.sessionId ?? randomBytes(16),
      16,
      "sessionId",
    );
    const fields: CpicField[] = [
      { tag: CpicTag.Start, value: Buffer.alloc(0) },
      { tag: CpicTag.ProtocolVersion, value: INITIAL_PROTOCOL_VERSION },
      { tag: CpicTag.Capabilities, value: INITIAL_CAPABILITIES },
      { tag: CpicTag.LogonMarker, value: Buffer.alloc(0) },
      { tag: CpicTag.Session, value: sessionId },
      { tag: CpicTag.Client, value: Buffer.from(input.client, "ascii") },
      { tag: CpicTag.User, value: ascii(input.user, "user", 1, 40) },
      { tag: credentialTag, value: credential },
      {
        tag: CpicTag.Language,
        value: Buffer.from(input.language.toUpperCase(), "ascii"),
      },
      { tag: CpicTag.UnicodeIndicator, value: Buffer.of(1) },
      {
        tag: CpicTag.ClientAddress,
        value: ascii(input.clientAddress, "clientAddress", 1, 64),
      },
      {
        tag: CpicTag.PartnerSystem,
        value: ascii(input.partnerSystem ?? "::1", "partnerSystem", 1, 64),
      },
      { tag: CpicTag.ConnectionType, value: Buffer.from("E", "ascii") },
      {
        tag: CpicTag.KernelRelease,
        value: Buffer.from(kernelRelease, "ascii"),
      },
      { tag: CpicTag.KernelPatch, value: Buffer.from(kernelRelease, "ascii") },
      {
        tag: CpicTag.PartnerHost,
        value: ascii(input.partnerHostName, "partnerHostName", 1, 120),
      },
      {
        tag: CpicTag.Destination,
        value: ascii(input.destination, "destination", 1, 120),
      },
      {
        tag: CpicTag.Program,
        value: ascii(input.programName, "programName", 1, 64),
      },
      { tag: CpicTag.ContextEnd, value: Buffer.alloc(0) },
      { tag: CpicTag.Kernel, value: Buffer.from(kernelRelease, "ascii") },
      {
        tag: CpicTag.Function,
        value: ascii(input.functionName ?? "RFCPING", "functionName", 1, 40),
      },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ];
    const chainByteLength = cpicFieldChainByteLength(CpicTag.Start, fields);
    const cpicPacketSize =
      INITIAL_CPIC_SIGNATURE.byteLength +
      INITIAL_CPIC_PREFIX.byteLength +
      chainByteLength +
      2;
    if (cpicPacketSize > 0xffff) {
      throw new RangeError(
        `initial CPIC packet size ${cpicPacketSize} exceeds 65535`,
      );
    }
    chain = encodeCpicFieldChain(CpicTag.Start, fields);
    const trailer = Buffer.alloc(10);
    trailer.writeUInt16BE(CpicTag.End, 0);
    trailer.writeUInt16BE(0, 2);
    trailer.writeUInt16BE(cpicPacketSize, 4);
    trailer.writeUInt32BE(maximumRfcPacketSize, 6);
    return Buffer.concat([
      INITIAL_CPIC_SIGNATURE,
      INITIAL_CPIC_PREFIX,
      chain,
      trailer,
    ]);
  } finally {
    chain?.fill(0);
    credential.fill(0);
  }
}

/** Decode only structural, non-secret properties of an initial logon request. */
export function decodeCpicInitialLogonRequest(
  data: Uint8Array,
): DecodedCpicInitialLogonRequest {
  const encoded = Buffer.from(data);
  const prefixLength =
    INITIAL_CPIC_SIGNATURE.byteLength + INITIAL_CPIC_PREFIX.byteLength;
  if (encoded.byteLength < prefixLength + 10) {
    throw new RangeError("initial CPIC logon request is truncated");
  }
  if (!encoded.subarray(0, 12).equals(INITIAL_CPIC_SIGNATURE)) {
    throw new Error("initial CPIC logon signature is invalid");
  }
  if (!encoded.subarray(12, prefixLength).equals(INITIAL_CPIC_PREFIX)) {
    throw new Error("initial CPIC logon prefix is invalid");
  }
  const decoded = decodeCpicFieldChainPrefix(
    encoded.subarray(prefixLength),
    CpicTag.Start,
    CpicTag.End,
  );
  if (
    decoded.fields.length !== INITIAL_TAG_ORDER.length ||
    decoded.fields.some(
      (field, index) => index === 7
        ? field.tag !== CpicTag.Password && field.tag !== CpicTag.Ticket
        : field.tag !== INITIAL_TAG_ORDER[index],
    )
  ) {
    throw new Error(
      "initial CPIC logon fields do not match the required tag order",
    );
  }
  if (!Buffer.from(decoded.fields[1]!.value).equals(INITIAL_PROTOCOL_VERSION)) {
    throw new Error("initial CPIC protocol-version field is unsupported");
  }
  if (!Buffer.from(decoded.fields[2]!.value).equals(INITIAL_CAPABILITIES)) {
    throw new Error("initial CPIC capabilities field is unsupported");
  }
  const trailerOffset = prefixLength + decoded.bytesConsumed;
  if (encoded.byteLength - trailerOffset !== 10) {
    throw new Error("initial CPIC logon request has an invalid trailer length");
  }
  const trailer = encoded.subarray(trailerOffset);
  if (
    trailer.readUInt16BE(0) !== CpicTag.End ||
    trailer.readUInt16BE(2) !== 0
  ) {
    throw new Error("initial CPIC logon trailer marker is invalid");
  }
  const cpicPacketSize = trailer.readUInt16BE(4);
  if (cpicPacketSize !== trailerOffset + 2) {
    throw new Error(
      `initial CPIC packet size ${cpicPacketSize} does not match derived size ${trailerOffset + 2}`,
    );
  }
  return {
    fields: decoded.fields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
    cpicPacketSize,
    maximumRfcPacketSize: trailer.readUInt32BE(6),
  };
}

/** Decode the structural outcome of the first server logon/RFCPING response. */
export function decodeCpicInitialLogonResponse(
  data: Uint8Array,
): DecodedCpicInitialLogonResponse {
  const encoded = Buffer.from(data);
  if (encoded.byteLength < INITIAL_CPIC_RESPONSE_PREFIX.byteLength + 8) {
    failInitialCpicLogonParse(
      "truncated",
      "initial CPIC logon response is truncated",
      RangeError,
    );
  }
  const prefix = encoded.subarray(0, INITIAL_CPIC_RESPONSE_PREFIX.byteLength);
  const isRegularResponse = prefix.equals(INITIAL_CPIC_RESPONSE_PREFIX);
  const isErrorResponse = prefix.equals(INITIAL_CPIC_ERROR_RESPONSE_PREFIX);
  if (!isRegularResponse && !isErrorResponse) {
    failInitialCpicLogonParse(
      "prefix",
      "initial CPIC logon response prefix is invalid",
    );
  }
  let decoded: DecodedCpicFieldChainPrefix;
  try {
    decoded = decodeCpicFieldChainPrefix(
      encoded.subarray(INITIAL_CPIC_RESPONSE_PREFIX.byteLength),
      CpicTag.Start,
      CpicTag.End,
    );
  } catch (error) {
    registerInitialCpicLogonParseStage("field-chain", error);
  }
  const trailerOffset =
    INITIAL_CPIC_RESPONSE_PREFIX.byteLength + decoded.bytesConsumed;
  if (
    encoded.byteLength - trailerOffset !== 2 ||
    encoded.readUInt16BE(trailerOffset) !== CpicTag.End
  ) {
    failInitialCpicLogonParse(
      "trailer",
      "initial CPIC logon response trailer is invalid",
    );
  }
  const protocols = decoded.fields.filter(
    (field) => field.tag === CpicTag.ProtocolVersion,
  );
  const protocol = protocols[0];
  if (protocol === undefined || protocol.value.byteLength !== 4) {
    failInitialCpicLogonParse(
      "protocol",
      "initial CPIC logon response lacks its protocol version",
    );
  }
  const structuralFields = decoded.fields.map((field) => ({
    tag: field.tag,
    byteLength: field.value.byteLength,
  }));
  if (isErrorResponse) {
    const preamble = matchInitialCpicErrorPreamble(decoded.fields);
    if (
      preamble === null ||
      decoded.fields.length <= preamble.fieldCount + 1
    ) {
      failInitialCpicLogonParse(
        "error-preamble",
        "initial CPIC logon error response has an invalid preamble",
      );
    }
    for (const tag of preamble.allowedTags) {
      if (decoded.fields.filter((field) => field.tag === tag).length !== 1) {
        failInitialCpicLogonParse(
          "error-preamble",
          "initial CPIC logon error response has duplicate preamble fields",
        );
      }
    }
    let envelope: RfcErrorEnvelope;
    try {
      envelope = decodeRfcErrorEnvelope(decoded.fields, {
        additionalAllowedTags: preamble.allowedTags,
      });
    } catch (error) {
      registerInitialCpicLogonParseStage("error-envelope", error);
    }
    if (envelope.outcome === "success") {
      failInitialCpicLogonParse(
        "error-envelope",
        "initial CPIC logon error response lacks a rejected outcome",
      );
    }
    return {
      success: false,
      // Surface the backend's own reason. Discarding it here is what left
      // every rejection indistinguishable from every other one.
      rejection: Object.freeze({
        outcome: envelope.outcome,
        messageClass: envelope.facts.messageClass,
        messageType: envelope.facts.messageType,
        messageNumber: envelope.facts.messageNumber,
        exceptionKey: envelope.facts.exceptionKey,
        runtimeId: envelope.facts.runtimeId,
        text: envelope.facts.plainText,
      }),
      negotiatedProtocolVersion: Buffer.from(protocol.value).readUInt32BE(0),
      fields: structuralFields,
    };
  }
  if (protocols.length !== 1) {
    failInitialCpicLogonParse(
      "protocol",
      "initial CPIC logon response lacks its protocol version",
    );
  }
  if (decoded.fields.some((field) => field.tag === CpicTag.ResponseStart)) {
    return decodeRichInitialCpicRfcPingResponse(
      decoded.fields,
      structuralFields,
      protocol,
    );
  }
  for (const [index, field] of decoded.fields.entries()) {
    if (!INITIAL_CPIC_REGULAR_RESPONSE_TAGS.has(field.tag)) {
      failInitialCpicLogonStructure(
        "unsupported-field",
        `initial CPIC logon response contains unsupported field ${tagText(field.tag)} (${field.value.byteLength} bytes) at index ${index}`,
        structuralFields,
      );
    }
  }
  const endFields = decoded.fields.filter((field) => field.tag === CpicTag.End);
  if (
    endFields.length !== 1 ||
    decoded.fields.at(-1)?.tag !== CpicTag.End ||
    endFields[0]!.value.byteLength !== 0
  ) {
    failInitialCpicLogonStructure(
      "invalid-end-field",
      "initial CPIC logon response has an invalid End field",
      structuralFields,
    );
  }
  const startFields = decoded.fields.filter(
    (field) => field.tag === CpicTag.Start,
  );
  if (
    startFields.length > 1 ||
    (startFields.length === 1 &&
      (decoded.fields[0]?.tag !== CpicTag.Start ||
        startFields[0]!.value.byteLength !== 0))
  ) {
    failInitialCpicLogonStructure(
      "invalid-start-field",
      "initial CPIC logon response has an invalid Start field",
      structuralFields,
    );
  }
  const observedS4Controls = decoded.fields.filter(
    (field) => field.tag === INITIAL_CPIC_UNRESOLVED_0450,
  );
  // The classic WebSocket envelope may add one leading empty Start wrapper.
  // Validate the S/4 control against the semantic response shape so that
  // transport decoration cannot shift an otherwise identical grammar.
  const semanticFields = startFields.length === 1
    ? decoded.fields.slice(1)
    : decoded.fields;
  if (
    observedS4Controls.length > 1 ||
    (observedS4Controls.length === 1 &&
      (observedS4Controls[0]!.value.byteLength !== 6 ||
        semanticFields.indexOf(observedS4Controls[0]!) !== 4 ||
        semanticFields[3]?.tag !== CpicTag.Unresolved0420))
  ) {
    failInitialCpicLogonStructure(
      "malformed-vendor-logon-control",
      "initial CPIC logon response has malformed 0x0450 control",
      structuralFields,
    );
  }
  for (const singletonTag of [CpicTag.Capabilities, CpicTag.SystemCodePage]) {
    if (decoded.fields.filter((field) => field.tag === singletonTag).length > 1) {
      failInitialCpicLogonStructure(
        "duplicate-control-field",
        "initial CPIC logon response has duplicate control fields",
        structuralFields,
      );
    }
  }
  const oneByteStatuses = decoded.fields.filter(
    (field) => field.tag === CpicTag.LogonStatus,
  );
  if (
    oneByteStatuses.length > 1 ||
    (oneByteStatuses.length === 1 &&
      oneByteStatuses[0]!.value.byteLength !== 1)
  ) {
    failInitialCpicLogonStructure(
      "malformed-one-byte-status",
      "initial CPIC logon response has malformed one-byte status",
      structuralFields,
    );
  }
  const callStatuses = decoded.fields.filter(
    (field) => field.tag === CpicTag.Unresolved0420,
  );
  if (
    callStatuses.length > 1 ||
    (callStatuses.length === 1 && callStatuses[0]!.value.byteLength !== 4)
  ) {
    failInitialCpicLogonStructure(
      "malformed-call-status",
      "initial CPIC logon response has malformed call status",
      structuralFields,
    );
  }
  if (oneByteStatuses.length === 0 && callStatuses.length === 0) {
    failInitialCpicLogonStructure(
      "missing-logon-status",
      "initial CPIC logon response lacks a recognized logon status",
      structuralFields,
    );
  }
  if (
    callStatuses.length === 1 &&
    callStatuses[0]!.value.readUInt32BE(0) !== 0
  ) {
    failInitialCpicLogonStructure(
      "nonzero-call-status",
      "initial CPIC logon response has nonzero call status",
      structuralFields,
    );
  }
  // S/4HANA 2023 emits the authoritative one-byte logon status together
  // with a zero 0x0420 control. NetWeaver 7.50 is also observed emitting
  // only that zero control for successful logon.
  const status = oneByteStatuses.length === 1
    ? oneByteStatuses[0]!.value[0]!
    : 0;
  return {
    success: status === 0,
    status,
    negotiatedProtocolVersion: Buffer.from(protocol.value).readUInt32BE(0),
    fields: structuralFields,
  };
}

function unicode(
  value: string,
  field: string,
  maximumCharacters: number,
): Buffer {
  if (
    value.length < 1 ||
    value.length > maximumCharacters ||
    value.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new RangeError(
      `${field} must contain 1..${maximumCharacters} Unicode scalar characters without NUL`,
    );
  }
  return Buffer.from(value, "utf16le");
}

function packetTrailer(
  packetPrefixAndChainLength: number,
  maximumRfcPacketSize: number,
): Buffer {
  const cpicPacketSize = packetPrefixAndChainLength + 2;
  if (cpicPacketSize > MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH) {
    // The admitted contract switches to streamed F_ASEND_DATA records above the 28,000-byte
    // STSEND application boundary. In that mode the logical CUT message closes
    // with the field chain's existing empty End field followed only by the
    // 0xffff packet sentinel; the compact SAP8 words are omitted.
    return Buffer.from("ffff", "hex");
  }
  const trailer = Buffer.alloc(10);
  trailer.writeUInt16BE(CpicTag.End, 0);
  trailer.writeUInt16BE(0, 2);
  trailer.writeUInt16BE(cpicPacketSize, 4);
  trailer.writeUInt32BE(maximumRfcPacketSize, 6);
  return trailer;
}

/**
 * Inspect the bounded CPIC request trailer before APPC framing. Compact calls
 * carry eight final SAP-parameter bytes; streamed calls end in the admitted
 * `0xffff` packet-size sentinel and carry no separate maximum-size word.
 */
export function inspectCpicRequestAppcFraming(
  data: Uint8Array,
): CpicRequestAppcFraming {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("CPIC request data must be a Uint8Array");
  }
  const view = intrinsicUint8ArrayView(data, "CPIC request data");
  const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  if (
    bytes.byteLength >= 10 &&
    bytes.readUInt16BE(bytes.byteLength - 10) === CpicTag.End &&
    bytes.readUInt16BE(bytes.byteLength - 8) === 0 &&
    bytes.readUInt16BE(bytes.byteLength - 6) === bytes.byteLength - 8 &&
    bytes.byteLength - 8 <= MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
  ) {
    return Object.freeze({
      mode: "compact",
      applicationDataLength: bytes.byteLength - 8,
      finalSapParameterLength: 8,
    });
  }
  if (
    bytes.byteLength > MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH &&
    bytes.byteLength >= 6 &&
    bytes.readUInt16BE(bytes.byteLength - 6) === CpicTag.End &&
    bytes.readUInt16BE(bytes.byteLength - 4) === 0 &&
    bytes.readUInt16BE(bytes.byteLength - 2) === 0xffff
  ) {
    return Object.freeze({
      mode: "streamed",
      applicationDataLength: bytes.byteLength,
      finalSapParameterLength: 0,
    });
  }
  throw new Error("CPIC request has an invalid APPC framing trailer");
}

function checkedMaximumRfcPacketSize(value: number | undefined): number {
  const maximumRfcPacketSize = value ?? 0x8500;
  if (
    !Number.isSafeInteger(maximumRfcPacketSize) ||
    maximumRfcPacketSize < 0 ||
    maximumRfcPacketSize > 0xffff_ffff
  ) {
    throw new RangeError(
      "maximumRfcPacketSize must be an unsigned 32-bit integer",
    );
  }
  return maximumRfcPacketSize;
}

/** Encode the first regular Unicode RFC call after initial logon. */
export function encodeCpicFunctionRequest(
  input: CpicFunctionRequestInput,
): Buffer {
  const kernelRelease = input.kernelRelease ?? "754";
  if (!/^\d{3}$/.test(kernelRelease)) {
    throw new RangeError(
      "kernelRelease must contain exactly three ASCII digits",
    );
  }
  const maximumRfcPacketSize = checkedMaximumRfcPacketSize(
    input.maximumRfcPacketSize,
  );
  const fields: CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: INITIAL_PROTOCOL_VERSION },
    { tag: CpicTag.Capabilities, value: INITIAL_CAPABILITIES },
    { tag: CpicTag.LogonMarker, value: Buffer.alloc(0) },
    {
      tag: CpicTag.Session,
      value: exactBytes(input.sessionId, 16, "sessionId"),
    },
    { tag: CpicTag.ContextEnd, value: Buffer.alloc(0) },
    { tag: CpicTag.Kernel, value: Buffer.from(kernelRelease, "utf16le") },
    {
      tag: CpicTag.Function,
      value: unicode(input.functionName, "functionName", 40),
    },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
  const chainByteLength = cpicFieldChainByteLength(CpicTag.Start, fields);
  const trailer = packetTrailer(
    CPIC_FUNCTION_REQUEST_PREFIX.byteLength + chainByteLength,
    maximumRfcPacketSize,
  );
  const chain = encodeCpicFieldChain(CpicTag.Start, fields);
  return Buffer.concat([CPIC_FUNCTION_REQUEST_PREFIX, chain, trailer]);
}

function rejectDuplicates(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${kind} ${value}`);
    seen.add(value);
  }
}

/**
 * Encode an established-session classic Unicode (CUT) RFC request. Requested
 * outputs and input name/value records stay separate so CHANGING parameters
 * may intentionally occur in both collections.
 */
export function encodeCpicCutFunctionRequest(
  input: CpicCutFunctionRequestInput,
): Buffer {
  const kernelRelease = input.kernelRelease ?? "754";
  if (!/^\d{3}$/.test(kernelRelease)) {
    throw new RangeError(
      "kernelRelease must contain exactly three ASCII digits",
    );
  }
  const maximumRfcPacketSize = checkedMaximumRfcPacketSize(
    input.maximumRfcPacketSize,
  );
  const requestedOutputs = input.requestedOutputs ?? [];
  const imports = input.imports ?? [];
  const tables = input.tables ?? [];
  const xrfcParameters = input.xrfcParameters ?? [];
  rejectDuplicates(requestedOutputs, "requested output");
  rejectDuplicates(
    imports.map((parameter) => parameter.name),
    "import",
  );
  rejectDuplicates(
    tables.map((parameter) => parameter.name),
    "table",
  );
  rejectDuplicates(
    xrfcParameters.map((parameter) => parameter.name),
    "xRFC parameter",
  );
  const inputNames = new Set<string>();
  for (const collection of [imports, tables, xrfcParameters] as const) {
    for (const parameter of collection) {
      if (inputNames.has(parameter.name)) {
        throw new Error(`duplicate input parameter ${parameter.name}`);
      }
      inputNames.add(parameter.name);
    }
  }

  const fields: CpicField[] = [
    { tag: CpicTag.Kernel, value: Buffer.from(kernelRelease, "utf16le") },
    {
      tag: CpicTag.Function,
      value: unicode(input.functionName, "functionName", 40),
    },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
  ];
  for (const name of requestedOutputs) {
    fields.push({
      tag: CpicTag.RequestedOutput,
      value: unicode(name, "requested output name", 30),
    });
  }
  for (const parameter of imports) {
    fields.push(
      {
        tag: CpicTag.ParameterName,
        value: unicode(parameter.name, "import name", 30),
      },
      { tag: CpicTag.ParameterValue, value: parameter.value },
    );
  }
  for (const table of tables) {
    if (
      !Number.isSafeInteger(table.rowByteLength) ||
      table.rowByteLength < 0 ||
      table.rowByteLength > 0xffff_ffff
    ) {
      throw new RangeError(
        `${table.name} rowByteLength must be an unsigned 32-bit integer`,
      );
    }
    if (table.rows.length > 0xffff_ffff) {
      throw new RangeError(
        `${table.name} row count exceeds the unsigned 32-bit range`,
      );
    }
    const header = Buffer.alloc(8);
    header.writeUInt32BE(table.rowByteLength, 0);
    header.writeUInt32BE(table.rows.length, 4);
    fields.push(
      {
        tag: CpicTag.TableName,
        value: unicode(table.name, "table name", 30),
      },
      { tag: CpicTag.TableHeader, value: header },
    );
    for (const [index, row] of table.rows.entries()) {
      if (row.byteLength !== table.rowByteLength) {
        throw new RangeError(
          `${table.name} row ${index} contains ${row.byteLength} bytes; ` +
            `expected ${table.rowByteLength}`,
        );
      }
      // A full-width payload is a valid (non-shortened) simple-compression
      // record. Keep this established compatible encoding until an
      // encoder-side compression policy is introduced deliberately.
      fields.push({ tag: CpicTag.TableCompr, value: row });
    }
  }
  for (const parameter of xrfcParameters) {
    // Validate the diagnostic name with the same admitted RFC-name
    // bounds even though the XML root is the on-wire discriminator.
    unicode(parameter.name, "xRFC parameter name", 30);
    if (!(parameter.value instanceof Uint8Array)) {
      throw new TypeError(`${parameter.name} xRFC XML value must be Uint8Array bytes`);
    }
    const value = intrinsicUint8ArrayView(
      parameter.value,
      `${parameter.name} xRFC XML value`,
    );
    if (value.byteLength === 0) {
      throw new RangeError(`${parameter.name} xRFC XML value must not be empty`);
    }
    fields.push({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) });
    for (
      let offset = 0;
      offset < value.byteLength;
      offset += CLASSIC_XRFC_XML_CHUNK_LENGTH
    ) {
      fields.push({
        tag: CpicTag.XRfcData,
        value: value.subarray(
          offset,
          Math.min(offset + CLASSIC_XRFC_XML_CHUNK_LENGTH, value.byteLength),
        ),
      });
    }
    fields.push({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) });
  }
  fields.push({ tag: CpicTag.End, value: Buffer.alloc(0) });

  const chainByteLength = cpicFieldChainByteLength(
    CpicTag.ContextEnd,
    fields,
  );
  const trailer = packetTrailer(
    CPIC_CUT_FUNCTION_REQUEST_PREFIX.byteLength + chainByteLength,
    maximumRfcPacketSize,
  );
  const chain = encodeCpicFieldChain(CpicTag.ContextEnd, fields);
  return Buffer.concat([CPIC_CUT_FUNCTION_REQUEST_PREFIX, chain, trailer]);
}

function decodeCpicFunctionResponseEnvelope(
  data: Uint8Array,
  additionalAllowedTags: readonly number[] = [],
): DecodedCpicFunctionResultFields {
  if (data.byteLength < CPIC_FUNCTION_RESPONSE_PREFIX.byteLength + 8) {
    throw new RangeError("CPIC function response is truncated");
  }
  const prefix = Buffer.from(
    data.subarray(0, CPIC_FUNCTION_RESPONSE_PREFIX.byteLength),
  );
  if (!prefix.equals(CPIC_FUNCTION_RESPONSE_PREFIX)) {
    throw new Error("CPIC function response prefix is invalid");
  }
  const decoded = decodeCpicFieldChainPrefix(
    data.subarray(CPIC_FUNCTION_RESPONSE_PREFIX.byteLength),
    CpicTag.ResponseStart,
    CpicTag.End,
  );
  const trailerOffset =
    CPIC_FUNCTION_RESPONSE_PREFIX.byteLength + decoded.bytesConsumed;
  if (data.byteLength - trailerOffset !== 2) {
    throw new Error("CPIC function response trailer is invalid");
  }
  const trailer = Buffer.from(data.subarray(trailerOffset, trailerOffset + 2));
  if (trailer.readUInt16BE(0) !== CpicTag.End) {
    throw new Error("CPIC function response trailer is invalid");
  }
  return decodeCpicFunctionResponseFields(
    decoded.fields,
    additionalAllowedTags,
  );
}

function decodeCpicFunctionResponseFields(
  fields: readonly DecodedCpicField[],
  additionalAllowedTags: readonly number[] = [],
): DecodedCpicFunctionResultFields {
  const envelope = decodeRfcErrorEnvelope(fields, {
    // The outer CPIC decoder already enforces this count and the 256 MiB chain
    // bound. Keep large metadata/table responses usable while the error/control
    // subset retains its much tighter independent limits.
    maxFieldCount: DEFAULT_MAX_CPIC_FIELD_COUNT,
    additionalAllowedTags: [
      CpicTag.Program,
      0x0667,
      ...additionalAllowedTags,
    ],
  });
  const control = envelope.facts.unresolved0420.length === 1
    ? envelope.facts.unresolved0420[0]
    : undefined;
  const status = envelope.outcome === "success" && control?.byteLength === 4
    ? Number.parseInt(control.valueHex, 16)
    : undefined;
  return {
    success: envelope.outcome === "success",
    status,
    envelope,
    fields,
  };
}

/**
 * Decode application fields for the value-codec layer. Callers must keep
 * these values out of logs; use decodeCpicFunctionResponse for diagnostics.
 */
export function decodeCpicFunctionResultFields(
  data: Uint8Array,
): DecodedCpicFunctionResultFields {
  return decodeCpicFunctionResponseEnvelope(data, [
    CpicTag.XRfcParameter,
    CpicTag.XRfcData,
  ]);
}

/**
 * Decode the state-specific reply to SYSTEM_RESET_RFC_SERVER.
 *
 * S/4HANA 2023 emits one zero-length RFCID.RfcServerResetDone (0x0523);
 * NetWeaver 7.50 returns the otherwise identical zero-status success envelope
 * without it. Keep the marker optional-but-singleton here and fatal in every
 * other response state. Remote error envelopes need no success marker.
 */
export function decodeCpicResetServerContextResultFields(
  data: Uint8Array,
): DecodedCpicFunctionResultFields {
  const decoded = decodeCpicFunctionResponseEnvelope(data, [
    CpicTag.RfcServerResetDone,
  ]);
  const resetDone = decoded.fields.filter(
    (field) => field.tag === CpicTag.RfcServerResetDone,
  );
  if (
    resetDone.length > 1 ||
    (resetDone.length === 1 && resetDone[0]!.value.byteLength !== 0)
  ) {
    throw new Error(
      "SYSTEM_RESET_RFC_SERVER response reset-done control must be empty and unique",
    );
  }
  return decoded;
}

const SESSION_REFRESH_PREAMBLE_TAGS: ReadonlySet<number> = new Set([
  CpicTag.ProtocolVersion,
  CpicTag.Capabilities,
  CpicTag.LogonStatus,
  CpicTag.SystemCodePage,
  CpicTag.ClientAddress,
  CpicTag.PartnerSystem,
  CpicTag.PartnerHost,
  CpicTag.ConnectionType,
  CpicTag.KernelRelease,
  CpicTag.KernelPatch,
  CpicTag.Destination,
  CpicTag.Program,
  0x0020,
  0x0021,
  INITIAL_CPIC_UNRESOLVED_0450,
  0x0451,
  0x0452,
  0x0453,
]);
const MAX_SESSION_REFRESH_PREAMBLE_FIELDS = 32;
const MAX_SESSION_REFRESH_PREAMBLE_BYTES = 16 * 1024;

/**
 * Decode the first successful call after SYSTEM_RESET_RFC_SERVER.
 *
 * SAP prepends a bounded session-header refresh to an embedded regular
 * response. Only this state accepts that initial prefix; ordinary calls remain
 * strict regular envelopes.
 */
export function decodeCpicSessionRefreshResultFields(
  data: Uint8Array,
): DecodedCpicFunctionResultFields {
  const view = intrinsicUint8ArrayView(
    data,
    "CPIC session-refresh response",
  );
  const encoded = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  if (encoded.byteLength < INITIAL_CPIC_RESPONSE_PREFIX.byteLength + 8) {
    throw new RangeError("CPIC session-refresh response is truncated");
  }
  if (
    !encoded
      .subarray(0, INITIAL_CPIC_RESPONSE_PREFIX.byteLength)
      .equals(INITIAL_CPIC_RESPONSE_PREFIX)
  ) {
    throw new Error("CPIC session-refresh response prefix is invalid");
  }
  const decoded = decodeCpicFieldChainPrefix(
    encoded.subarray(INITIAL_CPIC_RESPONSE_PREFIX.byteLength),
    CpicTag.Start,
    CpicTag.End,
  );
  const trailerOffset =
    INITIAL_CPIC_RESPONSE_PREFIX.byteLength + decoded.bytesConsumed;
  if (
    encoded.byteLength - trailerOffset !== 2 ||
    encoded.readUInt16BE(trailerOffset) !== CpicTag.End
  ) {
    throw new Error("CPIC session-refresh response trailer is invalid");
  }
  const responseStarts = decoded.fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => field.tag === CpicTag.ResponseStart);
  if (
    responseStarts.length !== 1 ||
    responseStarts[0]!.field.value.byteLength !== 0
  ) {
    throw new Error(
      "CPIC session-refresh response must contain one empty embedded response marker",
    );
  }
  const responseStartIndex = responseStarts[0]!.index;
  if (
    responseStartIndex < 2 ||
    responseStartIndex > MAX_SESSION_REFRESH_PREAMBLE_FIELDS
  ) {
    throw new Error("CPIC session-refresh preamble field count is invalid");
  }
  let preambleBytes = 0;
  const seen = new Set<number>();
  for (let index = 0; index < responseStartIndex; index += 1) {
    const field = decoded.fields[index]!;
    if (!SESSION_REFRESH_PREAMBLE_TAGS.has(field.tag) || seen.has(field.tag)) {
      throw new Error(
        "CPIC session-refresh preamble contains an unknown or duplicate field",
      );
    }
    seen.add(field.tag);
    preambleBytes += field.value.byteLength;
    if (preambleBytes > MAX_SESSION_REFRESH_PREAMBLE_BYTES) {
      throw new RangeError("CPIC session-refresh preamble exceeds its byte limit");
    }
  }
  const protocol = decoded.fields[0];
  const capabilities = decoded.fields[1];
  if (
    protocol?.tag !== CpicTag.ProtocolVersion ||
    protocol.value.byteLength !== 4 ||
    capabilities?.tag !== CpicTag.Capabilities ||
    capabilities.value.byteLength !== INITIAL_CAPABILITIES.byteLength
  ) {
    throw new Error(
      "CPIC session-refresh preamble lacks its protocol and Unicode headers",
    );
  }
  const logonStatus = decoded.fields
    .slice(0, responseStartIndex)
    .find((field) => field.tag === CpicTag.LogonStatus);
  if (
    logonStatus !== undefined &&
    (logonStatus.value.byteLength !== 1 || logonStatus.value[0] !== 0)
  ) {
    throw new Error("CPIC session-refresh preamble has a nonzero status");
  }
  const responseFields = decoded.fields.slice(responseStartIndex + 1);
  return decodeCpicFunctionResponseFields(responseFields);
}

/** Decode structural outcome and status from a regular Unicode RFC response. */
export function decodeCpicFunctionResponse(
  data: Uint8Array,
): DecodedCpicFunctionResponse {
  const decoded = decodeCpicFunctionResponseEnvelope(data, [
    CpicTag.XRfcParameter,
    CpicTag.XRfcData,
  ]);
  return {
    success: decoded.success,
    outcome: decoded.envelope.outcome,
    status: decoded.status,
    ...(decoded.envelope.outcome !== "abapException"
      ? {}
      : { exceptionKey: decoded.envelope.facts.exceptionKey }),
    fields: decoded.fields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  };
}
