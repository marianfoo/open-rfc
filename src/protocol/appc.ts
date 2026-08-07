import {
  CheckedByteReader,
  CheckedByteWriter,
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "./bytes.js";

export const APPC_PROTOCOL_VERSION = 0x06;
export const APPC_COMMON_HEADER_LENGTH = 48;
/** All controlled version-6 records contain 32 bytes after the common header. */
export const APPC_RECORD_HEADER_LENGTH = 80;
export const APPC_EXTENDED_INITIALIZE_OPTIONS_LENGTH = 341;
export const APPC_INITIALIZE_PARAMETERS_LENGTH = 373;
export const APPC_PARTNER_PARAMETERS_LENGTH = 144;
export const APPC_VECTOR_END_OF_MESSAGE = 0x04;
/** Fixed SAP parameter tail carried by a compact F_SAP_SEND record. */
export const APPC_FINAL_SAP_PARAMETER_LENGTH = 8;
/** Largest admitted STSEND/F_ASEND_DATA application slice. */
export const MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH = 28_000;
/** The admitted streaming contract inserts a sync after each 21 async chunks. */
export const MAX_APPC_ASYNC_SENDS_BEFORE_SYNC = 21;
/** Backwards-compatible name for the evidenced 28,000-byte application slice. */
export const MAX_APPC_DATA_FRAGMENT_LENGTH =
  MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH;
/** Protocol-wide signed INT4 ceiling; the configured default is much smaller. */
export const MAX_APPC_OUTGOING_MESSAGE_LENGTH = 0x7fff_ffff;
/** Two periodic barriers / 50 data chunks fit the bounded beta envelope. */
export const DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH = 1_400_000;
export const DEFAULT_MAX_APPC_MESSAGE_LENGTH = 256 * 1024 * 1024;
export const DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS = 65_536;
/** SAP Note 63347: the peer ended the CPI-C conversation normally. */
const APPC_RETURN_CODE_DEALLOCATED_NORMAL = 18;

/**
 * CPIC streaming has no proven peer-acceptance bit on the observed wire.
 * `enabled` therefore means the caller has independently approved the target.
 */
export type AppcCpicStreamingPolicy = "disabled" | "enabled";

export enum AppcFunction {
  Initialize = 0x01,
  Allocate = 0x05,
  SendData = 0x07,
  AsyncSendData = 0x08,
  Receive = 0x09,
  AsyncReceive = 0x0a,
  Deallocate = 0x0b,
  SetTpName = 0x0d,
  SetPartnerLuName = 0x0f,
  Flush = 0x1b,
  SapSend = 0xcb,
}

export interface AppcPayloadInfo {
  readonly protocolVersion: number;
  readonly functionCode: number;
  readonly functionName: string;
}

export interface AppcHeader extends AppcPayloadInfo {
  readonly protocol: number;
  readonly mode: number;
  readonly uid: number;
  readonly gatewayId: number;
  readonly errorLength: number;
  readonly info2: number;
  readonly traceLevel: number;
  readonly time: number;
  readonly info3: number;
  readonly timeout: number;
  readonly info4: number;
  readonly sequenceNumber: number;
  readonly sapParameterLength: number;
  readonly padding: number;
  readonly info: number;
  readonly vector: number;
  readonly appcReturnCode: number;
  readonly sapReturnCode: number;
  readonly conversationId: Buffer;
}

export interface AppcDataFragment {
  readonly header: AppcHeader;
  readonly data: Buffer;
  readonly isFinal: boolean;
}

export interface AppcExtendedInfo {
  readonly shortDestinationName: string;
  readonly logicalUnitName: string;
  readonly transactionProgramName: string;
  readonly connectionType: number;
  readonly clientInfo: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

/** Decoded 32-byte operation information carried by F_ASEND_DATA. */
export interface AppcAsyncDataInfo {
  readonly dataLength: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

/** Numeric operation information emitted by client streaming records. */
export interface AppcDataOperationInfo {
  readonly dataLength: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

/** Server data-buffer operation information carried by RFC reply records. */
export interface AppcIncomingDataOperationInfo {
  readonly dataLength: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

export interface AppcSynchronousSendAcknowledgement {
  readonly header: AppcHeader;
  readonly connectionIndex: number;
}

/** Semantic encoder input for F_SET_PARTNER_LU_NAME operation information. */
export interface AppcPartnerLogicalUnitInfoInput {
  readonly logicalUnitName: string;
  readonly partnerHostAddress: Uint8Array;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

/** Decoded 32-byte F_SET_PARTNER_LU_NAME operation information. */
export interface AppcPartnerLogicalUnitInfo {
  readonly logicalUnitNamePrefix: string;
  readonly logicalUnitNameLength: number;
  readonly partnerHostAddress: Uint8Array;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

export interface AppcExtendedInitializeOptions {
  readonly optionFlags: number;
  readonly rootId: string;
  readonly connectionId: string;
  readonly connectionIdSuffix: number;
  readonly timeout: number;
  readonly keepaliveTimeout: number;
  readonly exportTrace: number;
  readonly startType: number;
  readonly networkProtocol: number;
  readonly localAddressV6: Uint8Array;
  readonly longLogicalUnitName: string;
  readonly operatingSystemUser: string;
  readonly localAddressV4: Uint8Array;
  readonly longTransactionProgramName: string;
}

export interface AppcInitializeParameters {
  readonly clientIdentifier: string;
  readonly options: AppcExtendedInitializeOptions;
}

export interface AppcPartnerLogicalUnitParameters {
  readonly longLogicalUnitName: string;
  readonly partnerHostAddress: Uint8Array;
}

export interface AppcRecordHeaderInput {
  readonly protocol?: number;
  readonly mode?: number;
  readonly uid?: number;
  readonly gatewayId?: number;
  readonly errorLength?: number;
  readonly info2?: number;
  readonly traceLevel?: number;
  readonly time?: number;
  readonly info3?: number;
  readonly timeout?: number;
  readonly info4?: number;
  readonly sequenceNumber?: number;
  readonly padding?: number;
  readonly info?: number;
  readonly vector?: number;
  readonly appcReturnCode?: number;
  readonly sapReturnCode?: number;
  readonly conversationId?: Uint8Array;
}

export interface AppcControlRecordInput extends AppcRecordHeaderInput {
  readonly functionCode: AppcFunction;
  readonly extendedInfo?: AppcExtendedInfo;
  readonly partnerLogicalUnitInfo?: AppcPartnerLogicalUnitInfoInput;
  readonly parameters?: Uint8Array;
}

export interface AppcDataRecordInput extends AppcRecordHeaderInput {
  readonly functionCode?:
    | AppcFunction.SapSend
    | AppcFunction.SendData
    | AppcFunction.Receive;
  readonly data: Uint8Array;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
  readonly isFinal?: boolean;
}

export interface AppcOutgoingDataPlanInput extends AppcRecordHeaderInput {
  /** CPIC bytes before the compact SAP tail, or the complete streamed packet. */
  readonly applicationData: Uint8Array;
  /** Present only for compact CPIC packets. */
  readonly finalSapParameters?: Uint8Array;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

export interface AppcOutgoingDataPlannerOptions {
  /** Maximum logical CPIC application bytes, excluding any compact SAP tail. */
  readonly maxApplicationDataLength?: number;
  readonly maxFragments?: number;
  readonly cpicStreaming?: AppcCpicStreamingPolicy;
}

/**
 * One immutable semantic step in an outgoing APPC data-message plan.
 *
 * `applicationData` and `conversationId` are views of planner-owned snapshots.
 * Buffer bytes remain mutable for efficient encoding; callers must treat them
 * as readonly and must not modify or reuse a plan.
 */
export interface AppcOutgoingDataFragment extends AppcRecordHeaderInput {
  readonly functionCode:
    | AppcFunction.SapSend
    | AppcFunction.SendData
    | AppcFunction.AsyncSendData
    | AppcFunction.Receive;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly conversationId: Buffer;
  readonly sequenceNumber: number;
  readonly applicationData: Buffer;
  readonly finalSapParameters: Buffer;
  /** Logical CPIC application bytes, excluding compact SAP parameters. */
  readonly messageApplicationDataLength: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
  readonly isFinal: boolean;
  readonly info: number;
  readonly vector: number;
  readonly sapParameterLength: 0 | 8;
}

export type AppcClientSetupState =
  | "new"
  | "initialize-pending"
  | "initialized"
  | "tp-set"
  | "partner-set"
  | "allocate-pending"
  | "send-continuation"
  | "send-barrier-pending"
  | "response-pending"
  | "ready"
  | "closed";

export type AppcReceiveDisposition =
  | "accepted"
  | "normal-deallocation";

/** A non-success CPI-C/APPC status returned by the peer. */
export class AppcPeerReturnCodeError extends Error {
  readonly appcReturnCode: number;
  readonly sapReturnCode: number;

  constructor(
    functionName: string,
    appcReturnCode: number,
    sapReturnCode: number,
  ) {
    super(
      `${functionName} failed with APPC return code ${appcReturnCode} ` +
        `and SAP return code ${sapReturnCode}`,
    );
    this.name = "AppcPeerReturnCodeError";
    this.appcReturnCode = appcReturnCode;
    this.sapReturnCode = sapReturnCode;
  }
}

/** CM_DEALLOCATED_NORMAL was returned without a decodable data payload. */
export class AppcNormalDeallocationWithoutDataError extends Error {
  constructor() {
    super("connection closed without message (CM_NO_DATA_RECEIVED)");
    this.name = "AppcNormalDeallocationWithoutDataError";
  }
}

export interface AppcMessage {
  readonly data: Buffer;
  readonly conversationId: Buffer;
  readonly sequenceNumber: number;
  readonly fragmentCount: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

export interface AppcConversationDecoderOptions {
  readonly maxMessageLength?: number;
  readonly maxFragments?: number;
  /** Allow a response to start with F_RECEIVE after client F_ASEND_DATA. */
  readonly allowInitialReceive?: boolean;
  /** Validate the server reply buffer-info layout, including its actual length. */
  readonly validateIncomingDataOperationInfo?: boolean;
}

interface PendingMessage {
  readonly chunks: Buffer[];
  readonly conversationId: Buffer;
  readonly sequenceNumber: number;
  byteLength: number;
  fragmentCount: number;
  readonly communicationIndex: number;
  readonly connectionIndex: number;
}

const functionNames = new Map<number, string>([
  [AppcFunction.Initialize, "F_INITIALIZE"],
  [AppcFunction.Allocate, "F_ALLOCATE"],
  [AppcFunction.SendData, "F_SEND_DATA"],
  [AppcFunction.AsyncSendData, "F_ASEND_DATA"],
  [AppcFunction.Receive, "F_RECEIVE"],
  [AppcFunction.AsyncReceive, "F_ARECEIVE"],
  [AppcFunction.Deallocate, "F_DEALLOCATE"],
  [AppcFunction.SetTpName, "F_SET_TP_NAME"],
  [AppcFunction.SetPartnerLuName, "F_SET_PARTNER_LU_NAME"],
  [AppcFunction.Flush, "F_FLUSH"],
  [AppcFunction.SapSend, "F_SAP_SEND"],
]);

const controlFunctions = new Set<AppcFunction>([
  AppcFunction.Initialize,
  AppcFunction.Allocate,
  AppcFunction.Deallocate,
  AppcFunction.SetTpName,
  AppcFunction.SetPartnerLuName,
  AppcFunction.Flush,
]);

function functionName(functionCode: number): string {
  return (
    functionNames.get(functionCode) ??
    `UNKNOWN_0x${functionCode.toString(16).padStart(2, "0")}`
  );
}

export function inspectAppcPayload(payload: Uint8Array): AppcPayloadInfo {
  if (payload.byteLength < 2) {
    throw new RangeError("an APPC payload needs at least a version and function byte");
  }

  const protocolVersion = payload[0];
  const functionCode = payload[1];
  if (protocolVersion === undefined || functionCode === undefined) {
    throw new RangeError("an APPC payload needs at least a version and function byte");
  }
  if (protocolVersion !== APPC_PROTOCOL_VERSION) {
    throw new Error(`unsupported APPC protocol version 0x${protocolVersion.toString(16)}`);
  }

  return {
    protocolVersion,
    functionCode,
    functionName: functionName(functionCode),
  };
}

function encodeFixedAscii(value: string, field: string): Buffer {
  if (!/^[\x20-\x7e]*$/.test(value) || Buffer.byteLength(value, "ascii") > 8) {
    throw new RangeError(`${field} must contain at most 8 ASCII bytes`);
  }
  // Captures distinguish an absent name (all NUL) from a present short name
  // (ASCII plus spaces). Preserve that wire distinction.
  const encoded = Buffer.alloc(8, value.length === 0 ? 0 : 0x20);
  encoded.write(value, 0, "ascii");
  return encoded;
}

function decodeFixedAscii(value: Buffer, field: string): string {
  for (const byte of value) {
    if (byte !== 0 && (byte < 0x20 || byte > 0x7e)) {
      throw new Error(`${field} contains a non-ASCII byte`);
    }
  }
  return value.toString("ascii").replace(/[\x00 ]+$/u, "");
}

function encodePaddedAscii(
  value: string,
  width: number,
  padding: number,
  field: string,
): Buffer {
  if (!/^[\x20-\x7e]*$/.test(value) || Buffer.byteLength(value, "ascii") > width) {
    throw new RangeError(`${field} must contain at most ${width} ASCII bytes`);
  }
  const encoded = Buffer.alloc(width, padding);
  encoded.write(value, 0, "ascii");
  return encoded;
}

function decodePaddedAscii(
  encoded: Buffer,
  padding: number,
  field: string,
): string {
  let end = encoded.indexOf(padding);
  if (end < 0) end = encoded.byteLength;
  for (let index = 0; index < end; index += 1) {
    const byte = encoded[index]!;
    if (byte < 0x20 || byte > 0x7e) {
      throw new Error(`${field} contains a non-ASCII byte`);
    }
  }
  for (let index = end; index < encoded.byteLength; index += 1) {
    if (encoded[index] !== padding) {
      throw new Error(`${field} contains data after its first padding byte`);
    }
  }
  return encoded.subarray(0, end).toString("ascii");
}

function exactBytes(value: Uint8Array, length: number, field: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${field} must be a Uint8Array`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength !== length) {
    throw new RangeError(
      `${field} must contain exactly ${length} bytes; received ${byteLength}`,
    );
  }
  return snapshotUint8Array(value, field, byteLength);
}

function fixedHexId(value: string, field: string): Buffer {
  if (!/^[0-9A-F]{16}$/.test(value)) {
    throw new RangeError(`${field} must contain exactly 16 uppercase hexadecimal characters`);
  }
  return Buffer.from(value, "ascii");
}

/** Encode the observed fixed 32-byte CPIC extended-connection structure. */
export function encodeAppcExtendedInfo(info: AppcExtendedInfo): Buffer {
  const writer = new CheckedByteWriter(32, "APPC extended info");
  writer.writeBytes(
    encodeFixedAscii(info.shortDestinationName, "shortDestinationName"),
    "shortDestinationName",
  );
  writer.writeBytes(
    encodeFixedAscii(info.logicalUnitName, "logicalUnitName"),
    "logicalUnitName",
  );
  writer.writeBytes(
    encodeFixedAscii(info.transactionProgramName, "transactionProgramName"),
    "transactionProgramName",
  );
  writer.writeUInt8(info.connectionType, "connectionType");
  writer.writeUInt8(info.clientInfo, "clientInfo");
  writer.writeUInt16BE(0, "reserved");
  writer.writeUInt16BE(info.communicationIndex, "communicationIndex");
  writer.writeUInt16BE(info.connectionIndex, "connectionIndex");
  return writer.finish();
}

/** Decode the observed fixed 32-byte CPIC extended-connection structure. */
export function decodeAppcExtendedInfo(data: Uint8Array): AppcExtendedInfo {
  if (data.byteLength !== 32) {
    throw new RangeError(`APPC extended info needs exactly 32 bytes; received ${data.byteLength}`);
  }
  const reader = new CheckedByteReader(data, "APPC extended info");
  const decoded = {
    shortDestinationName: decodeFixedAscii(
      reader.readBytes(8, "shortDestinationName"),
      "shortDestinationName",
    ),
    logicalUnitName: decodeFixedAscii(
      reader.readBytes(8, "logicalUnitName"),
      "logicalUnitName",
    ),
    transactionProgramName: decodeFixedAscii(
      reader.readBytes(8, "transactionProgramName"),
      "transactionProgramName",
    ),
    connectionType: reader.readUInt8("connectionType"),
    clientInfo: reader.readUInt8("clientInfo"),
  };
  const reserved = reader.readUInt16BE("reserved");
  if (reserved !== 0) {
    throw new Error(`APPC extended info reserved field must be zero; received ${reserved}`);
  }
  const result: AppcExtendedInfo = {
    ...decoded,
    communicationIndex: reader.readUInt16BE("communicationIndex"),
    connectionIndex: reader.readUInt16BE("connectionIndex"),
  };
  reader.finish();
  return result;
}

/** Encode the 32-byte F_SET_PARTNER_LU_NAME information block. */
export function encodeAppcPartnerLogicalUnitInfo(
  info: AppcPartnerLogicalUnitInfoInput,
): Buffer {
  if (!/^[\x20-\x7e]*$/.test(info.logicalUnitName) || info.logicalUnitName.length > 128) {
    throw new RangeError("logicalUnitName must contain at most 128 ASCII bytes");
  }
  const logicalUnitNamePrefix = encodeFixedAscii(
    info.logicalUnitName.slice(0, 8),
    "logicalUnitNamePrefix",
  );
  const partnerHostAddress = Buffer.from(info.partnerHostAddress);
  if (partnerHostAddress.byteLength !== 16) {
    throw new RangeError(
      `partnerHostAddress must contain exactly 16 bytes; received ${partnerHostAddress.byteLength}`,
    );
  }

  const writer = new CheckedByteWriter(32, "APPC partner logical-unit info");
  writer.writeBytes(logicalUnitNamePrefix, "logicalUnitNamePrefix");
  writer.writeUInt32BE(Buffer.byteLength(info.logicalUnitName, "ascii"), "logicalUnitNameLength");
  writer.writeBytes(partnerHostAddress, "partnerHostAddress");
  writer.writeUInt16BE(info.communicationIndex, "communicationIndex");
  writer.writeUInt16BE(info.connectionIndex, "connectionIndex");
  return writer.finish();
}

/** Decode and validate an F_SET_PARTNER_LU_NAME information block. */
export function decodeAppcPartnerLogicalUnitInfo(
  data: Uint8Array,
): AppcPartnerLogicalUnitInfo {
  if (data.byteLength !== 32) {
    throw new RangeError(
      `APPC partner logical-unit info needs exactly 32 bytes; received ${data.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(data, "APPC partner logical-unit info");
  const encodedName = reader.readBytes(8, "logicalUnitNamePrefix");
  const logicalUnitNameLength = reader.readUInt32BE("logicalUnitNameLength");
  if (logicalUnitNameLength > 128) {
    throw new Error(
      `APPC partner logical-unit name length must be at most 128; received ${logicalUnitNameLength}`,
    );
  }
  const logicalUnitNamePrefix = decodeFixedAscii(encodedName, "logicalUnitNamePrefix");
  if (Buffer.byteLength(logicalUnitNamePrefix, "ascii") !== Math.min(logicalUnitNameLength, 8)) {
    throw new Error(
      `APPC partner logical-unit name prefix length ` +
        `${Buffer.byteLength(logicalUnitNamePrefix, "ascii")} does not match declared length ` +
        `${logicalUnitNameLength}`,
    );
  }
  const result: AppcPartnerLogicalUnitInfo = {
    logicalUnitNamePrefix,
    logicalUnitNameLength,
    partnerHostAddress: reader.readBytes(16, "partnerHostAddress"),
    communicationIndex: reader.readUInt16BE("communicationIndex"),
    connectionIndex: reader.readUInt16BE("connectionIndex"),
  };
  reader.finish();
  return result;
}

/** Encode the fixed 341-byte extended initialization-options contract. */
export function encodeAppcExtendedInitializeOptions(
  options: AppcExtendedInitializeOptions,
): Buffer {
  const writer = new CheckedByteWriter(
    APPC_EXTENDED_INITIALIZE_OPTIONS_LENGTH,
    "APPC extended initialize options",
  );
  writer.writeUInt8(1, "version");
  writer.writeUInt8(options.optionFlags, "optionFlags");
  writer.writeBytes(
    encodePaddedAscii("CPIC", 8, 0, "protocolName"),
    "protocolName",
  );
  writer.writeBytes(fixedHexId(options.rootId, "rootId"), "rootId");
  writer.writeBytes(fixedHexId(options.connectionId, "connectionId"), "connectionId");
  writer.writeUInt32BE(options.connectionIdSuffix, "connectionIdSuffix");
  writer.writeInt32BE(options.timeout, "timeout");
  writer.writeInt32BE(options.keepaliveTimeout, "keepaliveTimeout");
  writer.writeUInt8(options.exportTrace, "exportTrace");
  writer.writeUInt8(options.startType, "startType");
  writer.writeUInt8(options.networkProtocol, "networkProtocol");
  writer.writeBytes(exactBytes(options.localAddressV6, 16, "localAddressV6"), "localAddressV6");
  writer.writeBytes(
    encodePaddedAscii(options.longLogicalUnitName, 128, 0, "longLogicalUnitName"),
    "longLogicalUnitName",
  );
  writer.writeBytes(Buffer.alloc(16), "reserved1");
  writer.writeBytes(
    encodePaddedAscii(options.operatingSystemUser, 12, 0x20, "operatingSystemUser"),
    "operatingSystemUser",
  );
  writer.writeBytes(Buffer.alloc(8), "reserved2");
  writer.writeBytes(Buffer.alloc(4), "reserved3");
  writer.writeBytes(Buffer.alloc(12), "reserved4");
  writer.writeBytes(Buffer.alloc(16), "reserved5");
  writer.writeBytes(exactBytes(options.localAddressV4, 4, "localAddressV4"), "localAddressV4");
  writer.writeBytes(Buffer.alloc(4), "reserved6");
  writer.writeBytes(
    encodePaddedAscii(
      options.longTransactionProgramName,
      64,
      0,
      "longTransactionProgramName",
    ),
    "longTransactionProgramName",
  );
  return writer.finish();
}

/** Decode extended initialization options and reject non-zero reserved bytes. */
export function decodeAppcExtendedInitializeOptions(
  data: Uint8Array,
): AppcExtendedInitializeOptions {
  if (data.byteLength !== APPC_EXTENDED_INITIALIZE_OPTIONS_LENGTH) {
    throw new RangeError(
      `APPC extended initialize options need exactly ${APPC_EXTENDED_INITIALIZE_OPTIONS_LENGTH} bytes; received ${data.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(data, "APPC extended initialize options");
  const version = reader.readUInt8("version");
  if (version !== 1) {
    throw new Error(`unsupported APPC extended initialize options version ${version}`);
  }
  const optionFlags = reader.readUInt8("optionFlags");
  const protocolName = decodePaddedAscii(
    reader.readBytes(8, "protocolName"),
    0,
    "protocolName",
  );
  if (protocolName !== "CPIC") {
    throw new Error(`unsupported APPC extended initialize protocol ${protocolName}`);
  }
  const rootId = reader.readBytes(16, "rootId").toString("ascii");
  fixedHexId(rootId, "rootId");
  const connectionId = reader.readBytes(16, "connectionId").toString("ascii");
  fixedHexId(connectionId, "connectionId");
  const result = {
    optionFlags,
    rootId,
    connectionId,
    connectionIdSuffix: reader.readUInt32BE("connectionIdSuffix"),
    timeout: reader.readInt32BE("timeout"),
    keepaliveTimeout: reader.readInt32BE("keepaliveTimeout"),
    exportTrace: reader.readUInt8("exportTrace"),
    startType: reader.readUInt8("startType"),
    networkProtocol: reader.readUInt8("networkProtocol"),
    localAddressV6: reader.readBytes(16, "localAddressV6"),
    longLogicalUnitName: decodePaddedAscii(
      reader.readBytes(128, "longLogicalUnitName"),
      0,
      "longLogicalUnitName",
    ),
  };
  for (const [field, length] of [
    ["reserved1", 16],
  ] as const) {
    const reserved = reader.readBytes(length, field);
    if (reserved.some((byte) => byte !== 0)) {
      throw new Error(`APPC extended initialize ${field} must be zero`);
    }
  }
  const operatingSystemUser = decodePaddedAscii(
    reader.readBytes(12, "operatingSystemUser"),
    0x20,
    "operatingSystemUser",
  );
  for (const [field, length] of [
    ["reserved2", 8],
    ["reserved3", 4],
    ["reserved4", 12],
    ["reserved5", 16],
  ] as const) {
    const reserved = reader.readBytes(length, field);
    if (reserved.some((byte) => byte !== 0)) {
      throw new Error(`APPC extended initialize ${field} must be zero`);
    }
  }
  const localAddressV4 = reader.readBytes(4, "localAddressV4");
  const reserved6 = reader.readBytes(4, "reserved6");
  if (reserved6.some((byte) => byte !== 0)) {
    throw new Error("APPC extended initialize reserved6 must be zero");
  }
  const decoded: AppcExtendedInitializeOptions = {
    ...result,
    operatingSystemUser,
    localAddressV4,
    longTransactionProgramName: decodePaddedAscii(
      reader.readBytes(64, "longTransactionProgramName"),
      0,
      "longTransactionProgramName",
    ),
  };
  reader.finish();
  return decoded;
}

/** Encode the fixed client identifier plus extended initialization options. */
export function encodeAppcInitializeParameters(
  parameters: AppcInitializeParameters,
): Buffer {
  const writer = new CheckedByteWriter(
    APPC_INITIALIZE_PARAMETERS_LENGTH,
    "APPC initialize parameters",
  );
  writer.writeBytes(
    encodePaddedAscii(parameters.clientIdentifier, 32, 0x20, "clientIdentifier"),
    "clientIdentifier",
  );
  writer.writeBytes(
    encodeAppcExtendedInitializeOptions(parameters.options),
    "extendedOptions",
  );
  return writer.finish();
}

export function decodeAppcInitializeParameters(
  data: Uint8Array,
): AppcInitializeParameters {
  if (data.byteLength !== APPC_INITIALIZE_PARAMETERS_LENGTH) {
    throw new RangeError(
      `APPC initialize parameters need exactly ${APPC_INITIALIZE_PARAMETERS_LENGTH} bytes; received ${data.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(data, "APPC initialize parameters");
  const result: AppcInitializeParameters = {
    clientIdentifier: decodePaddedAscii(
      reader.readBytes(32, "clientIdentifier"),
      0x20,
      "clientIdentifier",
    ),
    options: decodeAppcExtendedInitializeOptions(
      reader.readBytes(APPC_EXTENDED_INITIALIZE_OPTIONS_LENGTH, "extendedOptions"),
    ),
  };
  reader.finish();
  return result;
}

export function encodeAppcPartnerLogicalUnitParameters(
  parameters: AppcPartnerLogicalUnitParameters,
): Buffer {
  const writer = new CheckedByteWriter(
    APPC_PARTNER_PARAMETERS_LENGTH,
    "APPC partner logical-unit parameters",
  );
  writer.writeBytes(
    encodePaddedAscii(parameters.longLogicalUnitName, 128, 0x20, "longLogicalUnitName"),
    "longLogicalUnitName",
  );
  writer.writeBytes(
    exactBytes(parameters.partnerHostAddress, 16, "partnerHostAddress"),
    "partnerHostAddress",
  );
  return writer.finish();
}

export function decodeAppcPartnerLogicalUnitParameters(
  data: Uint8Array,
): AppcPartnerLogicalUnitParameters {
  if (data.byteLength !== APPC_PARTNER_PARAMETERS_LENGTH) {
    throw new RangeError(
      `APPC partner logical-unit parameters need exactly ${APPC_PARTNER_PARAMETERS_LENGTH} bytes; received ${data.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(data, "APPC partner logical-unit parameters");
  const result: AppcPartnerLogicalUnitParameters = {
    longLogicalUnitName: decodePaddedAscii(
      reader.readBytes(128, "longLogicalUnitName"),
      0x20,
      "longLogicalUnitName",
    ),
    partnerHostAddress: reader.readBytes(16, "partnerHostAddress"),
  };
  reader.finish();
  return result;
}

function defaultExtendedInfo(): AppcExtendedInfo {
  return {
    shortDestinationName: "",
    logicalUnitName: "",
    transactionProgramName: "",
    connectionType: 0,
    clientInfo: 0,
    communicationIndex: 0,
    connectionIndex: 0,
  };
}

/** Encode a setup/control APPC record; its parameter length is always derived. */
export function encodeAppcControlRecord(input: AppcControlRecordInput): Buffer {
  if (!controlFunctions.has(input.functionCode)) {
    throw new Error(`${functionName(input.functionCode)} is not a setup/control function`);
  }
  const parameters = Buffer.from(input.parameters ?? Buffer.alloc(0));
  if (parameters.byteLength > 0xffff) {
    throw new RangeError(
      `APPC control parameter length ${parameters.byteLength} exceeds 65535`,
    );
  }
  if (input.extendedInfo !== undefined && input.partnerLogicalUnitInfo !== undefined) {
    throw new Error("an APPC control record cannot contain two operation-info variants");
  }
  if (
    input.partnerLogicalUnitInfo !== undefined &&
    input.functionCode !== AppcFunction.SetPartnerLuName
  ) {
    throw new Error(
      "partnerLogicalUnitInfo is only valid for F_SET_PARTNER_LU_NAME",
    );
  }
  if (
    input.functionCode === AppcFunction.SetPartnerLuName &&
    input.partnerLogicalUnitInfo === undefined
  ) {
    throw new Error("F_SET_PARTNER_LU_NAME requires partnerLogicalUnitInfo");
  }

  const operationInfo =
    input.partnerLogicalUnitInfo === undefined
      ? encodeAppcExtendedInfo(input.extendedInfo ?? defaultExtendedInfo())
      : encodeAppcPartnerLogicalUnitInfo(input.partnerLogicalUnitInfo);

  return encodeAppcRecord(
    input.functionCode,
    input,
    operationInfo,
    parameters.byteLength,
    parameters,
    "APPC control record",
  );
}

function validateFinalSapParameters(
  parameters: Uint8Array,
  applicationDataLength: number,
): void {
  if (parameters.byteLength !== APPC_FINAL_SAP_PARAMETER_LENGTH) {
    throw new RangeError(
      `finalSapParameters must contain exactly ` +
        `${APPC_FINAL_SAP_PARAMETER_LENGTH} bytes; received ${parameters.byteLength}`,
    );
  }
  const bytes = Buffer.from(parameters.buffer, parameters.byteOffset, parameters.byteLength);
  if (bytes.readUInt16BE(0) !== 0) {
    throw new RangeError("finalSapParameters reserved field must be zero");
  }
  const declaredPacketLength = bytes.readUInt16BE(2);
  if (declaredPacketLength !== applicationDataLength) {
    throw new RangeError(
      `finalSapParameters declare ${declaredPacketLength} application bytes; ` +
        `received ${applicationDataLength}`,
    );
  }
}

function outgoingFragmentSemantics(
  fragmentIndex: number,
  fragmentCount: number,
): Pick<
  AppcOutgoingDataFragment,
  "functionCode" | "info" | "isFinal" | "sapParameterLength" | "vector"
> {
  const isSingle = fragmentCount === 1;
  const isFinal = isSingle || fragmentIndex === fragmentCount - 1;
  const isSynchronousStreamingData =
    !isSingle &&
    !isFinal &&
    fragmentIndex >= MAX_APPC_ASYNC_SENDS_BEFORE_SYNC &&
    (fragmentIndex - MAX_APPC_ASYNC_SENDS_BEFORE_SYNC) %
        MAX_APPC_ASYNC_SENDS_BEFORE_SYNC ===
      0;
  return {
    functionCode: isSingle
      ? AppcFunction.SapSend
      : isFinal
        ? AppcFunction.Receive
        : isSynchronousStreamingData
          ? AppcFunction.SendData
          : AppcFunction.AsyncSendData,
    isFinal,
    info: isSingle
      ? 5
      : isFinal || isSynchronousStreamingData
        ? 1
        : 0,
    vector: isSingle ? 0x0c : 0,
    sapParameterLength: isSingle ? 8 : 0,
  };
}

function encodeAppcAsyncDataInfo(
  dataLength: number,
  communicationIndex: number,
  connectionIndex: number,
): Buffer {
  if (
    !Number.isSafeInteger(dataLength) ||
    dataLength < 1 ||
    dataLength > MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
  ) {
    throw new RangeError(
      `async APPC data length must be an integer in ` +
        `1..${MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH}`,
    );
  }
  const writer = new CheckedByteWriter(32, "APPC async-send info");
  writer.writeUInt16BE(0, "reserved");
  writer.writeUInt16BE(dataLength, "dataLength");
  writer.writeBytes(Buffer.alloc(24), "reserved2");
  writer.writeUInt16BE(communicationIndex, "communicationIndex");
  writer.writeUInt16BE(connectionIndex, "connectionIndex");
  return writer.finish();
}

/** Decode and validate fixed F_ASEND_DATA operation information. */
export function decodeAppcDataOperationInfo(
  data: Uint8Array,
): AppcDataOperationInfo {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("APPC data operation info must be a Uint8Array");
  }
  if (data.byteLength !== 32) {
    throw new RangeError(
      `APPC data operation info must contain exactly 32 bytes; received ${data.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    "APPC data operation info",
  );
  if (reader.readUInt16BE("reserved") !== 0) {
    throw new RangeError("APPC data operation reserved word must be zero");
  }
  const dataLength = reader.readUInt16BE("dataLength");
  const reserved = reader.readBytes(24, "reserved2");
  if (reserved.some((byte) => byte !== 0)) {
    throw new RangeError("APPC data operation reserved bytes must be zero");
  }
  const communicationIndex = reader.readUInt16BE("communicationIndex");
  const connectionIndex = reader.readUInt16BE("connectionIndex");
  reader.finish();
  return Object.freeze({ dataLength, communicationIndex, connectionIndex });
}

/**
 * Decode the server-side data-buffer information used by F_SAP_SEND,
 * F_RECEIVE, and empty flow-control acknowledgements.
 *
 * Unlike client F_ASEND_DATA, the reply's actual byte count is stored at
 * offset 10. The word at offset 2 is a receive-buffer capacity and must not
 * be used to frame the application payload.
 */
export function decodeAppcIncomingDataOperationInfo(
  data: Uint8Array,
): AppcIncomingDataOperationInfo {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("incoming APPC data operation info must be a Uint8Array");
  }
  if (data.byteLength !== 32) {
    throw new RangeError(
      `incoming APPC data operation info must contain exactly 32 bytes; received ${data.byteLength}`,
    );
  }
  const snapshot = Buffer.from(data);
  return Object.freeze({
    dataLength: snapshot.readUInt16BE(10),
    communicationIndex: snapshot.readUInt16BE(28),
    connectionIndex: snapshot.readUInt16BE(30),
  });
}

export function decodeAppcAsyncDataInfo(
  data: Uint8Array,
): AppcAsyncDataInfo {
  const decoded = decodeAppcDataOperationInfo(data);
  if (
    decoded.dataLength < 1 ||
    decoded.dataLength > MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
  ) {
    throw new RangeError(
      `APPC async-send data length must be in ` +
        `1..${MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH}`,
    );
  }
  return decoded;
}

function outgoingOperationInfo(
  functionCode:
    | AppcFunction.SapSend
    | AppcFunction.SendData
    | AppcFunction.AsyncSendData
    | AppcFunction.Receive,
  dataLength: number,
  communicationIndex: number,
  connectionIndex: number,
): Buffer {
  if (
    functionCode === AppcFunction.AsyncSendData ||
    functionCode === AppcFunction.SendData
  ) {
    return encodeAppcAsyncDataInfo(
      dataLength,
      communicationIndex,
      connectionIndex,
    );
  }
  return encodeAppcExtendedInfo({
    ...defaultExtendedInfo(),
    communicationIndex,
    connectionIndex,
  });
}

/**
 * Plan one logical outgoing CPIC message. Compact messages use one
 * F_SAP_SEND. Larger messages use bounded F_ASEND_DATA slices followed by an
 * empty F_RECEIVE terminator required by the admitted STSEND path.
 */
export function planOutgoingAppcDataFragments(
  input: AppcOutgoingDataPlanInput,
  options: AppcOutgoingDataPlannerOptions = {},
): readonly AppcOutgoingDataFragment[] {
  // Caller objects can expose accessors or proxies. Read each property exactly
  // once, then perform every validation and emitted-record decision against
  // this plain normalized snapshot.
  const normalized: AppcOutgoingDataPlanInput = {
    protocol: input.protocol,
    mode: input.mode,
    uid: input.uid,
    gatewayId: input.gatewayId,
    errorLength: input.errorLength,
    info2: input.info2,
    traceLevel: input.traceLevel,
    time: input.time,
    info3: input.info3,
    timeout: input.timeout,
    info4: input.info4,
    sequenceNumber: input.sequenceNumber,
    padding: input.padding,
    info: input.info,
    vector: input.vector,
    appcReturnCode: input.appcReturnCode,
    sapReturnCode: input.sapReturnCode,
    conversationId: input.conversationId,
    applicationData: input.applicationData,
    finalSapParameters: input.finalSapParameters,
    communicationIndex: input.communicationIndex,
    connectionIndex: input.connectionIndex,
  };
  if (!(normalized.applicationData instanceof Uint8Array)) {
    throw new TypeError("outgoing APPC applicationData must be a Uint8Array");
  }
  if (
    normalized.finalSapParameters !== undefined &&
    !(normalized.finalSapParameters instanceof Uint8Array)
  ) {
    throw new TypeError(
      "outgoing APPC finalSapParameters must be a Uint8Array when present",
    );
  }
  const maxApplicationDataLength =
    options.maxApplicationDataLength ??
    DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH;
  const maxFragments =
    options.maxFragments ?? DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS;
  const cpicStreaming = options.cpicStreaming ?? "disabled";

  if (
    !Number.isSafeInteger(maxApplicationDataLength) ||
    maxApplicationDataLength < 0 ||
    maxApplicationDataLength > MAX_APPC_OUTGOING_MESSAGE_LENGTH
  ) {
    throw new RangeError(
      `maxApplicationDataLength must be an integer in ` +
        `0..${MAX_APPC_OUTGOING_MESSAGE_LENGTH}`,
    );
  }
  if (!Number.isSafeInteger(maxFragments) || maxFragments < 1) {
    throw new RangeError("maxFragments must be a positive safe integer");
  }
  if (cpicStreaming !== "disabled" && cpicStreaming !== "enabled") {
    throw new RangeError("cpicStreaming must be disabled or enabled");
  }

  const messageApplicationDataLength = intrinsicUint8ArrayByteLength(
    normalized.applicationData,
  );
  if (!Number.isSafeInteger(messageApplicationDataLength)) {
    throw new RangeError("outgoing APPC message length is unsafe");
  }
  if (messageApplicationDataLength > maxApplicationDataLength) {
    throw new RangeError(
      `CPIC application data length ${messageApplicationDataLength} exceeds configured ` +
      `limit ${maxApplicationDataLength}`,
    );
  }
  let finalSapParameters: Buffer = Buffer.alloc(0);
  if (normalized.finalSapParameters !== undefined) {
    const finalSapParameterLength = intrinsicUint8ArrayByteLength(
      normalized.finalSapParameters,
    );
    if (finalSapParameterLength !== APPC_FINAL_SAP_PARAMETER_LENGTH) {
      throw new RangeError(
        `finalSapParameters must contain exactly ` +
          `${APPC_FINAL_SAP_PARAMETER_LENGTH} bytes; received ` +
          `${finalSapParameterLength}`,
      );
    }
    finalSapParameters = snapshotUint8Array(
      normalized.finalSapParameters,
      "finalSapParameters",
      finalSapParameterLength,
    );
    validateFinalSapParameters(
      finalSapParameters,
      messageApplicationDataLength,
    );
    if (
      messageApplicationDataLength >
        MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
    ) {
      throw new RangeError(
        "compact CPIC application data cannot exceed 28000 bytes",
      );
    }
  } else if (
    messageApplicationDataLength <=
      MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
  ) {
    throw new RangeError(
      "a streamed CPIC packet without final SAP parameters must exceed 28000 bytes",
    );
  }
  const useSingleRecord =
    normalized.finalSapParameters !== undefined &&
    messageApplicationDataLength <=
      MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH;
  if (!useSingleRecord && cpicStreaming !== "enabled") {
    throw new Error(
      "CPIC streaming is disabled; enable this destination before sending more than 28000 application bytes",
    );
  }
  const dataFragmentCount = useSingleRecord
    ? 1
    : Math.ceil(
        messageApplicationDataLength /
          MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
      );
  const fragmentCount = useSingleRecord
    ? 1
    : dataFragmentCount + 1;
  if (fragmentCount > maxFragments) {
    throw new RangeError(
      `APPC fragment count ${fragmentCount} exceeds configured limit ${maxFragments}`,
    );
  }

  const conversationSource = normalized.conversationId ?? Buffer.alloc(8);
  if (!(conversationSource instanceof Uint8Array)) {
    throw new TypeError("conversationId must be a Uint8Array");
  }
  const conversationIdLength = intrinsicUint8ArrayByteLength(
    conversationSource,
  );
  if (conversationIdLength !== 8) {
    throw new RangeError(
      `conversationId must contain exactly 8 bytes; received ${conversationIdLength}`,
    );
  }
  const conversationId = snapshotUint8Array(
    conversationSource,
    "conversationId",
    conversationIdLength,
  );
  // Exercise the authoritative record encoder once before returning a plan so
  // every header/index bound fails before the first transport write.
  encodeAppcRecord(
    useSingleRecord ? AppcFunction.SapSend : AppcFunction.AsyncSendData,
    normalized,
    outgoingOperationInfo(
      useSingleRecord ? AppcFunction.SapSend : AppcFunction.AsyncSendData,
      useSingleRecord
        ? messageApplicationDataLength + finalSapParameters.byteLength
        : Math.min(
            messageApplicationDataLength,
            MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
          ),
      normalized.communicationIndex,
      normalized.connectionIndex,
    ),
    useSingleRecord ? APPC_FINAL_SAP_PARAMETER_LENGTH : 0,
    Buffer.alloc(0),
    "outgoing APPC plan",
  );
  const applicationData = snapshotUint8Array(
    normalized.applicationData,
    "applicationData",
    messageApplicationDataLength,
  );

  const fragments: AppcOutgoingDataFragment[] = [];
  for (
    let fragmentIndex = 0;
    fragmentIndex < fragmentCount;
    fragmentIndex += 1
  ) {
    const semantics = outgoingFragmentSemantics(fragmentIndex, fragmentCount);
    const start =
      fragmentIndex * MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH;
    const end = semantics.functionCode === AppcFunction.Receive
      ? start
      : Math.min(
          messageApplicationDataLength,
          start + MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
        );
    fragments.push(
      Object.freeze({
        ...normalized,
        ...semantics,
        fragmentIndex,
        fragmentCount,
        conversationId,
        sequenceNumber: normalized.sequenceNumber ?? 0,
        applicationData: applicationData.subarray(start, end),
        finalSapParameters: useSingleRecord
          ? finalSapParameters
          : Buffer.alloc(0),
        messageApplicationDataLength,
      }),
    );
  }
  return Object.freeze(fragments);
}

function invalidOutgoingFragment(reason: string): never {
  throw new RangeError(`invalid outgoing APPC fragment: ${reason}`);
}

/** Snapshot an externally supplied plan step exactly once before validation. */
export function snapshotOutgoingAppcDataFragment(
  input: AppcOutgoingDataFragment,
): AppcOutgoingDataFragment {
  const conversationId = input.conversationId;
  if (!(conversationId instanceof Uint8Array)) {
    invalidOutgoingFragment("conversationId must be a Uint8Array");
  }
  const conversationLength = intrinsicUint8ArrayByteLength(conversationId);
  if (conversationLength !== 8) {
    invalidOutgoingFragment("conversationId must contain exactly 8 bytes");
  }
  const conversationSnapshot = snapshotUint8Array(
    conversationId,
    "outgoing fragment conversationId",
    conversationLength,
  );
  const applicationData = input.applicationData;
  if (!(applicationData instanceof Uint8Array)) {
    invalidOutgoingFragment("applicationData must be a Uint8Array");
  }
  const applicationLength = intrinsicUint8ArrayByteLength(applicationData);
  if (applicationLength > MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH) {
    invalidOutgoingFragment("applicationData exceeds the 28000-byte slice bound");
  }
  const applicationSnapshot = snapshotUint8Array(
    applicationData,
    "outgoing fragment applicationData",
    applicationLength,
  );
  const finalSapParameters = input.finalSapParameters;
  if (!(finalSapParameters instanceof Uint8Array)) {
    invalidOutgoingFragment("finalSapParameters must be a Uint8Array");
  }
  const finalSapParameterLength = intrinsicUint8ArrayByteLength(
    finalSapParameters,
  );
  if (finalSapParameterLength > APPC_FINAL_SAP_PARAMETER_LENGTH) {
    invalidOutgoingFragment("finalSapParameters exceeds 8 bytes");
  }
  const finalSapParameterSnapshot = snapshotUint8Array(
    finalSapParameters,
    "outgoing fragment finalSapParameters",
    finalSapParameterLength,
  );
  return Object.freeze({
    protocol: input.protocol,
    mode: input.mode,
    uid: input.uid,
    gatewayId: input.gatewayId,
    errorLength: input.errorLength,
    info2: input.info2,
    traceLevel: input.traceLevel,
    time: input.time,
    info3: input.info3,
    timeout: input.timeout,
    info4: input.info4,
    sequenceNumber: input.sequenceNumber,
    padding: input.padding,
    info: input.info,
    vector: input.vector,
    appcReturnCode: input.appcReturnCode,
    sapReturnCode: input.sapReturnCode,
    functionCode: input.functionCode,
    fragmentIndex: input.fragmentIndex,
    fragmentCount: input.fragmentCount,
    conversationId: conversationSnapshot,
    applicationData: applicationSnapshot,
    finalSapParameters: finalSapParameterSnapshot,
    messageApplicationDataLength: input.messageApplicationDataLength,
    communicationIndex: input.communicationIndex,
    connectionIndex: input.connectionIndex,
    isFinal: input.isFinal,
    sapParameterLength: input.sapParameterLength,
  });
}

/** Encode one validated semantic step returned by the outgoing planner. */
export function encodeOutgoingAppcDataFragment(
  input: AppcOutgoingDataFragment,
): Buffer {
  const fragment = snapshotOutgoingAppcDataFragment(input);
  if (
    !Number.isSafeInteger(fragment.fragmentCount) ||
    fragment.fragmentCount < 1
  ) {
    invalidOutgoingFragment("fragmentCount must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(fragment.fragmentIndex) ||
    fragment.fragmentIndex < 0 ||
    fragment.fragmentIndex >= fragment.fragmentCount
  ) {
    invalidOutgoingFragment(
      "fragmentIndex must identify a fragment in the plan",
    );
  }
  if (
    !(fragment.applicationData instanceof Uint8Array)
  ) {
    invalidOutgoingFragment("applicationData must be a Uint8Array");
  }
  if (!(fragment.finalSapParameters instanceof Uint8Array)) {
    invalidOutgoingFragment("finalSapParameters must be a Uint8Array");
  }
  if (
    !Number.isSafeInteger(fragment.messageApplicationDataLength) ||
    fragment.messageApplicationDataLength < 0 ||
    fragment.messageApplicationDataLength >
      MAX_APPC_OUTGOING_MESSAGE_LENGTH
  ) {
    invalidOutgoingFragment("messageApplicationDataLength is outside the proven range");
  }

  const expected = outgoingFragmentSemantics(
    fragment.fragmentIndex,
    fragment.fragmentCount,
  );
  if (
    fragment.functionCode !== expected.functionCode ||
    fragment.isFinal !== expected.isFinal ||
    fragment.info !== expected.info ||
    fragment.vector !== expected.vector ||
    fragment.sapParameterLength !== expected.sapParameterLength
  ) {
    invalidOutgoingFragment(
      "function, final marker, info, vector, or parameter length is inconsistent",
    );
  }
  if (fragment.fragmentCount === 1) {
    if (
      fragment.applicationData.byteLength >
        MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
    ) {
      invalidOutgoingFragment("compact F_SAP_SEND data length is invalid");
    }
    try {
      validateFinalSapParameters(
        fragment.finalSapParameters,
        fragment.messageApplicationDataLength,
      );
    } catch (error) {
      invalidOutgoingFragment(
        error instanceof Error ? error.message : "SAP parameters are invalid",
      );
    }
  } else if (
    fragment.functionCode === AppcFunction.AsyncSendData ||
    fragment.functionCode === AppcFunction.SendData
  ) {
    if (
      fragment.applicationData.byteLength < 1 ||
      fragment.applicationData.byteLength >
        MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH
    ) {
      invalidOutgoingFragment(
        `${functionName(fragment.functionCode)} slice length is invalid`,
      );
    }
    if (fragment.finalSapParameters.byteLength !== 0) {
      invalidOutgoingFragment(
        `${functionName(fragment.functionCode)} cannot carry SAP parameters`,
      );
    }
  } else if (
    fragment.applicationData.byteLength !== 0 ||
    fragment.finalSapParameters.byteLength !== 0
  ) {
    invalidOutgoingFragment("the async F_RECEIVE terminator must be empty");
  }

  const operationInfo =
    fragment.functionCode === AppcFunction.Receive &&
      fragment.fragmentCount > 1
      ? encodeAppcAsyncDataInfo(
          MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH,
          fragment.communicationIndex,
          fragment.connectionIndex,
        )
      : outgoingOperationInfo(
          fragment.functionCode,
          fragment.applicationData.byteLength,
          fragment.communicationIndex,
          fragment.connectionIndex,
        );
  return encodeAppcRecord(
    fragment.functionCode,
    fragment,
    operationInfo,
    fragment.sapParameterLength,
    [fragment.applicationData, fragment.finalSapParameters],
    "outgoing APPC data fragment",
  );
}

/** Encode one F_SAP_SEND/F_RECEIVE data record with proven CPIC defaults. */
export function encodeAppcDataRecord(input: AppcDataRecordInput): Buffer {
  const data = Buffer.from(input.data);
  const isFinal = input.isFinal !== false;
  const functionCode = input.functionCode ?? AppcFunction.SapSend;
  const operationInfo = encodeAppcExtendedInfo({
    ...defaultExtendedInfo(),
    communicationIndex: input.communicationIndex,
    connectionIndex: input.connectionIndex,
  });
  return encodeAppcRecord(
    functionCode,
    {
      ...input,
      info: input.info ?? (isFinal ? 5 : 1),
      vector: input.vector ?? (
        isFinal
          ? 0x0c
          : functionCode === AppcFunction.SapSend
            ? 0x08
            : 0
      ),
    },
    operationInfo,
    isFinal ? 8 : 0,
    data,
    "APPC data record",
  );
}

function encodeAppcRecord(
  functionCode: AppcFunction,
  input: AppcRecordHeaderInput,
  operationInfo: Uint8Array,
  sapParameterLength: number,
  trailingData: Uint8Array | readonly Uint8Array[],
  context: string,
): Buffer {
  const conversationId = Buffer.from(input.conversationId ?? Buffer.alloc(8));
  if (conversationId.byteLength !== 8) {
    throw new RangeError(
      `conversationId must contain exactly 8 bytes; received ${conversationId.byteLength}`,
    );
  }
  const encodedOperationInfo = exactBytes(operationInfo, 32, "operationInfo");
  if (!Number.isSafeInteger(sapParameterLength) || sapParameterLength < 0 || sapParameterLength > 0xffff) {
    throw new RangeError("sapParameterLength must be an integer in 0..65535");
  }
  const dataParts = Array.isArray(trailingData)
    ? trailingData
    : [trailingData as Uint8Array];
  let trailingDataLength = 0;
  for (const [index, part] of dataParts.entries()) {
    if (!(part instanceof Uint8Array)) {
      throw new TypeError(`trailingData[${index}] must be a Uint8Array`);
    }
    trailingDataLength += part.byteLength;
    if (!Number.isSafeInteger(trailingDataLength)) {
      throw new RangeError("trailingData length exceeds the safe integer range");
    }
  }
  const writer = new CheckedByteWriter(
    APPC_RECORD_HEADER_LENGTH + trailingDataLength,
    context,
  );
  writer.writeUInt8(APPC_PROTOCOL_VERSION, "protocolVersion");
  writer.writeUInt8(functionCode, "functionCode");
  writer.writeUInt8(input.protocol ?? 2, "protocol");
  writer.writeUInt8(input.mode ?? 0, "mode");
  writer.writeUInt16BE(input.uid ?? 0xffff, "uid");
  writer.writeUInt16BE(input.gatewayId ?? 0, "gatewayId");
  writer.writeUInt16BE(input.errorLength ?? 0, "errorLength");
  writer.writeUInt8(input.info2 ?? 0, "info2");
  writer.writeUInt8(input.traceLevel ?? 0, "traceLevel");
  writer.writeUInt32BE(input.time ?? 0, "time");
  writer.writeUInt8(input.info3 ?? 0, "info3");
  writer.writeInt32BE(input.timeout ?? 0, "timeout");
  writer.writeUInt8(input.info4 ?? 0, "info4");
  writer.writeUInt32BE(input.sequenceNumber ?? 0, "sequenceNumber");
  writer.writeUInt16BE(sapParameterLength, "sapParameterLength");
  writer.writeUInt16BE(input.padding ?? 0, "padding");
  writer.writeUInt8(input.info ?? 0, "info");
  writer.writeUInt8(input.vector ?? 0, "vector");
  writer.writeUInt32BE(input.appcReturnCode ?? 0, "appcReturnCode");
  writer.writeUInt32BE(input.sapReturnCode ?? 0, "sapReturnCode");
  writer.writeBytes(conversationId, "conversationId");
  writer.writeBytes(encodedOperationInfo, "operationInfo");
  for (const [index, part] of dataParts.entries()) {
    writer.writeBytes(part, `trailingData[${index}]`);
  }
  return writer.finish();
}

/** Validate the admitted client-side direct-CPIC setup sequence. */
export class AppcClientSetupStateMachine {
  #state: AppcClientSetupState = "new";

  get state(): AppcClientSetupState {
    return this.#state;
  }

  responseComplete(): void {
    if (this.#state !== "response-pending") {
      this.#state = "closed";
      throw new Error("cannot complete an APPC response unless one is pending");
    }
    this.#state = "ready";
  }

  sent(functionCode: AppcFunction, isFinalDataRecord = true): void {
    if (functionCode === AppcFunction.SapSend && !isFinalDataRecord) {
      throw new Error("F_SAP_SEND cannot start a streamed outgoing message");
    }
    if (functionCode === AppcFunction.AsyncSendData && isFinalDataRecord) {
      throw new Error("F_ASEND_DATA must be followed by F_RECEIVE");
    }
    if (functionCode === AppcFunction.SendData && isFinalDataRecord) {
      throw new Error("streaming F_SEND_DATA must be followed by its acknowledgement");
    }
    if (
      functionCode === AppcFunction.Receive &&
      this.#state === "send-continuation" &&
      !isFinalDataRecord
    ) {
      throw new Error("the streamed outgoing F_RECEIVE terminator must be final");
    }
    const allowed =
      (this.#state === "new" && functionCode === AppcFunction.Initialize) ||
      (this.#state === "initialized" &&
        (functionCode === AppcFunction.SetTpName ||
          functionCode === AppcFunction.SetPartnerLuName)) ||
      (this.#state === "tp-set" && functionCode === AppcFunction.SetPartnerLuName) ||
      (this.#state === "partner-set" && functionCode === AppcFunction.Allocate) ||
      (this.#state === "ready" &&
        (functionCode === AppcFunction.SapSend ||
          functionCode === AppcFunction.AsyncSendData ||
          functionCode === AppcFunction.Deallocate)) ||
      (this.#state === "send-continuation" &&
        (functionCode === AppcFunction.AsyncSendData ||
          functionCode === AppcFunction.SendData ||
          functionCode === AppcFunction.Receive));
    if (!allowed) {
      throw new Error(
        `cannot send ${functionName(functionCode)} while APPC client is ${this.#state}`,
      );
    }

    if (functionCode === AppcFunction.Initialize) this.#state = "initialize-pending";
    if (functionCode === AppcFunction.SetTpName) this.#state = "tp-set";
    if (functionCode === AppcFunction.SetPartnerLuName) this.#state = "partner-set";
    if (functionCode === AppcFunction.Allocate) this.#state = "allocate-pending";
    if (functionCode === AppcFunction.AsyncSendData) {
      this.#state = "send-continuation";
    }
    if (functionCode === AppcFunction.SapSend) {
      this.#state = "response-pending";
    }
    if (functionCode === AppcFunction.SendData) {
      this.#state = "send-barrier-pending";
    }
    if (
      functionCode === AppcFunction.Receive &&
      isFinalDataRecord
    ) {
      this.#state = "response-pending";
    }
    if (functionCode === AppcFunction.Deallocate) this.#state = "closed";
  }

  received(payload: Uint8Array): AppcReceiveDisposition {
    if (!(payload instanceof Uint8Array)) {
      this.#state = "closed";
      throw new TypeError("APPC reply must be a Uint8Array");
    }
    if (payload.byteLength < APPC_RECORD_HEADER_LENGTH) {
      this.#state = "closed";
      throw new RangeError(
        `an APPC reply needs ${APPC_RECORD_HEADER_LENGTH} bytes; ` +
          `received ${payload.byteLength}`,
      );
    }
    let header: AppcHeader;
    try {
      header = decodeAppcHeader(payload);
    } catch (cause) {
      this.#state = "closed";
      throw cause;
    }
    const normalDeallocation =
      header.appcReturnCode === APPC_RETURN_CODE_DEALLOCATED_NORMAL &&
      header.sapReturnCode === 0 &&
      this.#state === "response-pending" &&
      (header.functionCode === AppcFunction.SapSend ||
        header.functionCode === AppcFunction.Receive);
    if (normalDeallocation) {
      // A remote ABAP MESSAGE/runtime failure can terminate CPI-C while the
      // same final data record still carries the RFC error envelope. Publish
      // terminal state first, then let the CPIC layer decode that payload.
      this.#state = "closed";
      return "normal-deallocation";
    }
    if (header.appcReturnCode !== 0 || header.sapReturnCode !== 0) {
      this.#state = "closed";
      throw new AppcPeerReturnCodeError(
        header.functionName,
        header.appcReturnCode,
        header.sapReturnCode,
      );
    }

    const allowed =
      (this.#state === "initialize-pending" &&
        header.functionCode === AppcFunction.Initialize) ||
      (this.#state === "allocate-pending" &&
        header.functionCode === AppcFunction.Allocate) ||
      (this.#state === "send-barrier-pending" &&
        header.functionCode === AppcFunction.SendData) ||
      (this.#state === "response-pending" &&
        (header.functionCode === AppcFunction.SapSend ||
          header.functionCode === AppcFunction.Receive));
    if (!allowed) {
      this.#state = "closed";
      throw new Error(
        `cannot receive ${header.functionName} while APPC client is ${this.#state}`,
      );
    }

    if (this.#state === "initialize-pending") this.#state = "initialized";
    if (this.#state === "allocate-pending") this.#state = "ready";
    if (this.#state === "send-barrier-pending") {
      this.#state = "send-continuation";
    }
    return "accepted";
  }
}

/** Decode the fixed 48-byte APPC header shared by the observed version-6 records. */
export function decodeAppcHeader(payload: Uint8Array): AppcHeader {
  if (payload.byteLength < APPC_COMMON_HEADER_LENGTH) {
    throw new RangeError(
      `an APPC common header needs ${APPC_COMMON_HEADER_LENGTH} bytes; received ${payload.byteLength}`,
    );
  }

  const data = Buffer.from(payload.subarray(0, APPC_COMMON_HEADER_LENGTH));
  const reader = new CheckedByteReader(data, "APPC common header");
  const protocolVersion = reader.readUInt8("protocolVersion");
  const functionCode = reader.readUInt8("functionCode");
  const info = inspectAppcPayload(Buffer.of(protocolVersion, functionCode));
  const decoded: AppcHeader = {
    ...info,
    protocol: reader.readUInt8("protocol"),
    mode: reader.readUInt8("mode"),
    uid: reader.readUInt16BE("uid"),
    gatewayId: reader.readUInt16BE("gatewayId"),
    errorLength: reader.readUInt16BE("errorLength"),
    info2: reader.readUInt8("info2"),
    traceLevel: reader.readUInt8("traceLevel"),
    time: reader.readUInt32BE("time"),
    info3: reader.readUInt8("info3"),
    timeout: reader.readInt32BE("timeout"),
    info4: reader.readUInt8("info4"),
    sequenceNumber: reader.readUInt32BE("sequenceNumber"),
    sapParameterLength: reader.readUInt16BE("sapParameterLength"),
    padding: reader.readUInt16BE("padding"),
    info: reader.readUInt8("info"),
    vector: reader.readUInt8("vector"),
    appcReturnCode: reader.readUInt32BE("appcReturnCode"),
    sapReturnCode: reader.readUInt32BE("sapReturnCode"),
    conversationId: reader.readBytes(8, "conversationId"),
  };
  reader.finish();
  return decoded;
}

/** Decode the empty F_SEND_DATA flow-control acknowledgement. */
export function decodeAppcSynchronousSendAcknowledgement(
  payload: Uint8Array,
): AppcSynchronousSendAcknowledgement {
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError("APPC synchronous-send acknowledgement must be a Uint8Array");
  }
  if (payload.byteLength !== APPC_RECORD_HEADER_LENGTH) {
    throw new RangeError(
      `APPC synchronous-send acknowledgement must contain exactly ` +
        `${APPC_RECORD_HEADER_LENGTH} bytes; received ${payload.byteLength}`,
    );
  }
  const header = decodeAppcHeader(payload);
  if (
    header.functionCode !== AppcFunction.SendData ||
    header.protocol !== 2 ||
    header.mode !== 0 ||
    header.uid !== 0xffff ||
    header.gatewayId !== 0 ||
    header.errorLength !== 0 ||
    header.info2 !== 0 ||
    header.traceLevel !== 0 ||
    header.time !== 0 ||
    header.info3 !== 0 ||
    header.timeout !== 0 ||
    header.info4 !== 2 ||
    header.sequenceNumber !== 0 ||
    header.info !== 1 ||
    header.vector !== 0 ||
    header.sapParameterLength !== 0 ||
    header.padding !== 0 ||
    header.appcReturnCode !== 0 ||
    header.sapReturnCode !== 0
  ) {
    throw new Error(
      "APPC synchronous-send acknowledgement header is not canonical",
    );
  }
  const encodedOperationInfo = Buffer.from(
    payload.subarray(APPC_COMMON_HEADER_LENGTH, APPC_RECORD_HEADER_LENGTH),
  );
  const operationInfo = decodeAppcIncomingDataOperationInfo(encodedOperationInfo);
  if (
    encodedOperationInfo.subarray(0, 30).some((byte) => byte !== 0) ||
    operationInfo.dataLength !== 0 ||
    operationInfo.communicationIndex !== 0
  ) {
    throw new Error(
      "APPC synchronous-send acknowledgement operation information is not canonical",
    );
  }
  return Object.freeze({
    header,
    connectionIndex: operationInfo.connectionIndex,
  });
}

export function decodeAppcDataFragment(payload: Uint8Array): AppcDataFragment {
  if (payload.byteLength < APPC_RECORD_HEADER_LENGTH) {
    throw new RangeError(
      `an APPC data record needs ${APPC_RECORD_HEADER_LENGTH} bytes; ` +
        `received ${payload.byteLength}`,
    );
  }
  const header = decodeAppcHeader(payload);
  if (header.functionCode !== AppcFunction.SapSend && header.functionCode !== AppcFunction.Receive) {
    throw new Error(`${header.functionName} is not an APPC RFC data fragment`);
  }
  return {
    header,
    data: Buffer.from(payload.subarray(APPC_RECORD_HEADER_LENGTH)),
    isFinal: (header.vector & APPC_VECTOR_END_OF_MESSAGE) !== 0,
  };
}

/** Reassembles RFC application messages across F_SAP_SEND/F_RECEIVE records. */
export class AppcConversationDecoder {
  readonly #maxMessageLength: number;
  readonly #maxFragments: number;
  readonly #allowInitialReceive: boolean;
  readonly #validateIncomingDataOperationInfo: boolean;
  #pending: PendingMessage | undefined;

  constructor(options: AppcConversationDecoderOptions = {}) {
    this.#maxMessageLength =
      options.maxMessageLength ?? DEFAULT_MAX_APPC_MESSAGE_LENGTH;
    this.#maxFragments = options.maxFragments ?? DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS;
    this.#allowInitialReceive = options.allowInitialReceive ?? false;
    this.#validateIncomingDataOperationInfo =
      options.validateIncomingDataOperationInfo ?? false;
    if (!Number.isSafeInteger(this.#maxMessageLength) || this.#maxMessageLength < 0) {
      throw new RangeError("maxMessageLength must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.#maxFragments) || this.#maxFragments < 1) {
      throw new RangeError("maxFragments must be a positive safe integer");
    }
    if (typeof this.#allowInitialReceive !== "boolean") {
      throw new TypeError("allowInitialReceive must be a boolean");
    }
    if (typeof this.#validateIncomingDataOperationInfo !== "boolean") {
      throw new TypeError("validateIncomingDataOperationInfo must be a boolean");
    }
  }

  get bufferedByteLength(): number {
    return this.#pending?.byteLength ?? 0;
  }

  get fragmentCount(): number {
    return this.#pending?.fragmentCount ?? 0;
  }

  push(payload: Uint8Array): AppcMessage[] {
    return this.#push(payload, false);
  }

  /**
   * Decode the data returned with CM_DEALLOCATED_NORMAL. SAP Note 63347
   * establishes return code 18 as a normal terminal conversation outcome;
   * the admitted peer contract uses this status rather than the ordinary APPC
   * vector, terminates the still-valid RFC error envelope.
   */
  pushTerminalDeallocation(payload: Uint8Array): AppcMessage[] {
    return this.#push(payload, true);
  }

  #push(payload: Uint8Array, terminalDeallocation: boolean): AppcMessage[] {
    const header = decodeAppcHeader(payload);
    if (terminalDeallocation) {
      if (
        header.appcReturnCode !== APPC_RETURN_CODE_DEALLOCATED_NORMAL ||
        header.sapReturnCode !== 0
      ) {
        throw new Error(
          "terminal APPC deallocation requires APPC return code 18 and SAP return code 0",
        );
      }
    } else if (
      header.appcReturnCode === APPC_RETURN_CODE_DEALLOCATED_NORMAL &&
      header.sapReturnCode === 0
    ) {
      throw new Error(
        "normal deallocation must use the terminal decoder",
      );
    } else if (header.appcReturnCode !== 0 || header.sapReturnCode !== 0) {
      throw new Error(
        `${header.functionName} cannot be decoded after APPC return code ` +
          `${header.appcReturnCode} and SAP return code ${header.sapReturnCode}`,
      );
    }
    const isData =
      header.functionCode === AppcFunction.SapSend ||
      header.functionCode === AppcFunction.Receive;
    if (!isData) {
      if (this.#pending !== undefined) {
        throw new Error(
          `${header.functionName} interrupted a fragmented message before its final APPC record`,
        );
      }
      if (terminalDeallocation) {
        throw new AppcNormalDeallocationWithoutDataError();
      }
      return [];
    }

    const payloadByteLength = intrinsicUint8ArrayByteLength(payload);
    if (payloadByteLength >= APPC_RECORD_HEADER_LENGTH) {
      const incomingDataLength = payloadByteLength - APPC_RECORD_HEADER_LENGTH;
      const pendingByteLength = this.#pending?.byteLength ?? 0;
      const pendingFragmentCount = this.#pending?.fragmentCount ?? 0;
      // Reject an over-budget continuation before decodeAppcDataFragment owns
      // a copy of the peer-controlled application bytes. NI has already
      // admitted the individual record; the APPC aggregate is the tighter
      // resource boundary for a fragmented message.
      this.#checkLimits(
        pendingByteLength + incomingDataLength,
        pendingFragmentCount + 1,
      );
    }
    const fragment = decodeAppcDataFragment(payload);
    const operationInfo = decodeAppcIncomingDataOperationInfo(
      payload.subarray(APPC_COMMON_HEADER_LENGTH, APPC_RECORD_HEADER_LENGTH),
    );
    if (
      this.#validateIncomingDataOperationInfo &&
      operationInfo.dataLength !== fragment.data.byteLength
    ) {
      throw new Error(
        `incoming APPC data length ${operationInfo.dataLength} does not match ` +
          `record payload length ${fragment.data.byteLength}`,
      );
    }
    if (terminalDeallocation) {
      if (fragment.data.byteLength === 0) {
        throw new AppcNormalDeallocationWithoutDataError();
      }
      const pending = this.#pending;
      if (pending === undefined) {
        if (
          header.functionCode === AppcFunction.Receive &&
          !this.#allowInitialReceive
        ) {
          throw new Error(
            "received terminal F_RECEIVE without a preceding F_SAP_SEND",
          );
        }
        this.#checkLimits(fragment.data.byteLength, 1);
        return [{
          data: fragment.data,
          conversationId: Buffer.from(header.conversationId),
          sequenceNumber: header.sequenceNumber,
          fragmentCount: 1,
          communicationIndex: operationInfo.communicationIndex,
          connectionIndex: operationInfo.connectionIndex,
        }];
      }
      if (header.functionCode !== AppcFunction.Receive) {
        throw new Error(
          "normal deallocation started a new F_SAP_SEND during a fragmented message",
        );
      }
      if (!pending.conversationId.equals(header.conversationId)) {
        throw new Error(
          "APPC conversation ID changed at normal deallocation",
        );
      }
      if (pending.sequenceNumber !== header.sequenceNumber) {
        throw new Error("APPC sequence number changed at normal deallocation");
      }
      if (
        pending.communicationIndex !== operationInfo.communicationIndex ||
        pending.connectionIndex !== operationInfo.connectionIndex
      ) {
        throw new Error(
          "APPC connection indices changed at normal deallocation",
        );
      }
      const byteLength = pending.byteLength + fragment.data.byteLength;
      const fragmentCount = pending.fragmentCount + 1;
      this.#checkLimits(byteLength, fragmentCount);
      const message: AppcMessage = {
        data: Buffer.concat([...pending.chunks, fragment.data], byteLength),
        conversationId: Buffer.from(pending.conversationId),
        sequenceNumber: pending.sequenceNumber,
        fragmentCount,
        communicationIndex: pending.communicationIndex,
        connectionIndex: pending.connectionIndex,
      };
      this.#pending = undefined;
      return [message];
    }
    if (header.functionCode === AppcFunction.SapSend) {
      if (this.#pending !== undefined) {
        throw new Error("received a new F_SAP_SEND during an unfinished fragmented message");
      }
      this.#checkLimits(fragment.data.byteLength, 1);
      if (fragment.isFinal) {
        return [
          {
            data: fragment.data,
            conversationId: Buffer.from(header.conversationId),
            sequenceNumber: header.sequenceNumber,
            fragmentCount: 1,
            communicationIndex: operationInfo.communicationIndex,
            connectionIndex: operationInfo.connectionIndex,
          },
        ];
      }
      this.#pending = {
        chunks: [fragment.data],
        conversationId: Buffer.from(header.conversationId),
        sequenceNumber: header.sequenceNumber,
        byteLength: fragment.data.byteLength,
        fragmentCount: 1,
        communicationIndex: operationInfo.communicationIndex,
        connectionIndex: operationInfo.connectionIndex,
      };
      return [];
    }

    const pending = this.#pending;
    if (pending === undefined) {
      if (!this.#allowInitialReceive) {
        throw new Error("received F_RECEIVE without a preceding fragmented F_SAP_SEND");
      }
      this.#checkLimits(fragment.data.byteLength, 1);
      if (fragment.isFinal) {
        return [
          {
            data: fragment.data,
            conversationId: Buffer.from(header.conversationId),
            sequenceNumber: header.sequenceNumber,
            fragmentCount: 1,
            communicationIndex: operationInfo.communicationIndex,
            connectionIndex: operationInfo.connectionIndex,
          },
        ];
      }
      this.#pending = {
        chunks: [fragment.data],
        conversationId: Buffer.from(header.conversationId),
        sequenceNumber: header.sequenceNumber,
        byteLength: fragment.data.byteLength,
        fragmentCount: 1,
        communicationIndex: operationInfo.communicationIndex,
        connectionIndex: operationInfo.connectionIndex,
      };
      return [];
    }
    if (!pending.conversationId.equals(header.conversationId)) {
      throw new Error("APPC conversation ID changed within a fragmented message");
    }
    if (pending.sequenceNumber !== header.sequenceNumber) {
      throw new Error("APPC sequence number changed within a fragmented message");
    }
    if (
      pending.communicationIndex !== operationInfo.communicationIndex ||
      pending.connectionIndex !== operationInfo.connectionIndex
    ) {
      throw new Error("APPC connection indices changed within a fragmented message");
    }

    const byteLength = pending.byteLength + fragment.data.byteLength;
    const fragmentCount = pending.fragmentCount + 1;
    this.#checkLimits(byteLength, fragmentCount);
    pending.chunks.push(fragment.data);
    pending.byteLength = byteLength;
    pending.fragmentCount = fragmentCount;
    if (!fragment.isFinal) {
      return [];
    }

    const message: AppcMessage = {
      data: Buffer.concat(pending.chunks, pending.byteLength),
      conversationId: Buffer.from(pending.conversationId),
      sequenceNumber: pending.sequenceNumber,
      fragmentCount: pending.fragmentCount,
      communicationIndex: pending.communicationIndex,
      connectionIndex: pending.connectionIndex,
    };
    this.#pending = undefined;
    return [message];
  }

  #checkLimits(byteLength: number, fragmentCount: number): void {
    if (byteLength > this.#maxMessageLength) {
      throw new RangeError(
        `APPC message length ${byteLength} exceeds configured limit ${this.#maxMessageLength}`,
      );
    }
    if (fragmentCount > this.#maxFragments) {
      throw new RangeError(
        `APPC fragment count ${fragmentCount} exceeds configured limit ${this.#maxFragments}`,
      );
    }
  }

  finish(): void {
    if (this.#pending !== undefined) {
      throw new Error(
        `truncated APPC message: ${this.#pending.fragmentCount} fragment(s), ` +
          `${this.#pending.byteLength} bytes buffered`,
      );
    }
  }
}
