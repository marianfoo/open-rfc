import { CheckedByteReader, CheckedByteWriter } from "./bytes.js";

export const MESSAGE_SERVER_HEADER_LENGTH = 110;
export const MESSAGE_SERVER_RFC_GROUP_REQUEST_LENGTH = 206;
export const MAX_MESSAGE_SERVER_PAYLOAD_LENGTH = 512;

const MESSAGE_EYECATCHER = Buffer.from("**MESSAGE**\0", "ascii");
const MESSAGE_VERSION = 4;
const NAME_FIELD_LENGTH = 40;
const MESSAGE_SERVER_NAME = "MSG_SERVER";
const RFC_GROUP_OPCODE = 0x2c;
const RFC_GROUP_OPCODE_VERSION = 1;
const RFC_GROUP_REPLY_CHARSET = 3;
const RFC_GROUP_MAX_BYTES = 40;
const RFC_GROUP_MAX_HOST_BYTES = 255;
/** Distance between the sapdpNN and sapgwNN service blocks, and their width. */
const PORT_BLOCK_STRIDE = 100;
const MAX_TCP_PORT = 0xffff;
// Logon-group selector opcode used by the lgtst RFC-group exchange.
const RFC_LOGON_SELECTOR = 0x34;

export type MessageServerProtocolErrorCode =
  | "MS_OPCODE_REJECTED"
  | "MS_PROTOCOL_ERROR"
  | "MS_SERVER_REJECTED"
  | "MS_UNSUPPORTED_VERSION";

export class MessageServerProtocolError extends Error {
  readonly code: MessageServerProtocolErrorCode;
  readonly serverError: number | undefined;
  readonly opcodeError: number | undefined;
  override readonly cause: unknown;

  constructor(
    code: MessageServerProtocolErrorCode,
    message: string,
    properties: {
      readonly cause?: unknown;
      readonly serverError?: number;
      readonly opcodeError?: number;
    } = {},
  ) {
    super(message);
    this.name = "MessageServerProtocolError";
    this.code = code;
    this.serverError = properties.serverError;
    this.opcodeError = properties.opcodeError;
    this.cause = properties.cause;
  }
}

export interface MessageServerRfcGroupTarget {
  readonly applicationServerHost: string;
  /** Dispatcher port as returned by the message server (32NN by default). */
  readonly dispatcherPort: number;
  /** Gateway port in the block one hundred ports above the dispatcher block. */
  readonly gatewayPort: number;
  readonly gatewayService: string;
  readonly systemNumber: string;
}

interface MessageHeaderExpectation {
  readonly toName: string;
  readonly toNamePadding: number;
  readonly reserved2: number;
  readonly flag: number;
  readonly interfaceFlag: number;
  readonly fromName: string;
  readonly fromNamePadding: number;
}

function fixedAsciiField(
  value: string,
  padding: number,
  field: string,
): Buffer {
  const bytes = Buffer.from(value, "ascii");
  if (
    bytes.byteLength > NAME_FIELD_LENGTH ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw new RangeError(`${field} must fit a 40-byte printable ASCII field`);
  }
  const result = Buffer.alloc(NAME_FIELD_LENGTH, padding);
  bytes.copy(result);
  return result;
}

function allZero(length: number): Buffer {
  return Buffer.alloc(length);
}

function equalBytes(actual: Buffer, expected: Buffer, field: string): void {
  if (!actual.equals(expected)) {
    throw new MessageServerProtocolError(
      "MS_PROTOCOL_ERROR",
      `invalid message-server ${field}`,
    );
  }
}

function exactByte(actual: number, expected: number, field: string): void {
  if (actual !== expected) {
    throw new MessageServerProtocolError(
      "MS_PROTOCOL_ERROR",
      `invalid message-server ${field}: expected ${expected}, received ${actual}`,
    );
  }
}

function writeHeader(
  writer: CheckedByteWriter,
  expectation: MessageHeaderExpectation,
): void {
  writer.writeBytes(MESSAGE_EYECATCHER, "eyecatcher");
  writer.writeUInt8(MESSAGE_VERSION, "version");
  writer.writeUInt8(0, "error");
  writer.writeBytes(
    fixedAsciiField(
      expectation.toName,
      expectation.toNamePadding,
      "toName",
    ),
    "toName",
  );
  writer.writeUInt8(0, "messageType");
  writer.writeUInt8(0, "reserved");
  writer.writeUInt8(0, "domain");
  writer.writeUInt8(expectation.reserved2, "reserved2");
  writer.writeBytes(allZero(8), "key");
  writer.writeUInt8(expectation.flag, "flag");
  writer.writeUInt8(expectation.interfaceFlag, "interfaceFlag");
  writer.writeBytes(
    fixedAsciiField(
      expectation.fromName,
      expectation.fromNamePadding,
      "fromName",
    ),
    "fromName",
  );
  writer.writeUInt16BE(0, "portOrPadding");
}

function readHeader(
  reader: CheckedByteReader,
  expectation: MessageHeaderExpectation,
): void {
  equalBytes(
    reader.readBytes(MESSAGE_EYECATCHER.byteLength, "eyecatcher"),
    MESSAGE_EYECATCHER,
    "eyecatcher",
  );
  const version = reader.readUInt8("version");
  if (version !== MESSAGE_VERSION) {
    throw new MessageServerProtocolError(
      "MS_UNSUPPORTED_VERSION",
      `unsupported message-server version ${version}`,
    );
  }
  const serverError = reader.readUInt8("error");
  equalBytes(
    reader.readBytes(NAME_FIELD_LENGTH, "toName"),
    fixedAsciiField(
      expectation.toName,
      expectation.toNamePadding,
      "toName",
    ),
    "toName",
  );
  exactByte(reader.readUInt8("messageType"), 0, "message type");
  exactByte(reader.readUInt8("reserved"), 0, "reserved byte");
  exactByte(reader.readUInt8("domain"), 0, "domain");
  exactByte(
    reader.readUInt8("reserved2"),
    expectation.reserved2,
    "second reserved byte",
  );
  equalBytes(reader.readBytes(8, "key"), allZero(8), "key");
  exactByte(reader.readUInt8("flag"), expectation.flag, "message flag");
  exactByte(
    reader.readUInt8("interfaceFlag"),
    expectation.interfaceFlag,
    "interface flag",
  );
  equalBytes(
    reader.readBytes(NAME_FIELD_LENGTH, "fromName"),
    fixedAsciiField(
      expectation.fromName,
      expectation.fromNamePadding,
      "fromName",
    ),
    "fromName",
  );
  exactByte(reader.readUInt16BE("portOrPadding"), 0, "port/padding field");
  if (serverError !== 0) {
    throw new MessageServerProtocolError(
      "MS_SERVER_REJECTED",
      `message server rejected the request with error ${serverError}`,
      { serverError },
    );
  }
}

function guardedDecode<T>(description: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MessageServerProtocolError) throw error;
    throw new MessageServerProtocolError(
      "MS_PROTOCOL_ERROR",
      `malformed message-server ${description}`,
      { cause: error },
    );
  }
}

function groupBytes(group: string): Buffer {
  if (
    typeof group !== "string" ||
    !/^[\x20-\x7e]{1,40}$/u.test(group)
  ) {
    throw new RangeError(
      "group must contain 1..40 printable ASCII bytes",
    );
  }
  return Buffer.from(group, "ascii");
}

export function encodeMessageServerLoginRequest(): Buffer {
  const writer = new CheckedByteWriter(
    MESSAGE_SERVER_HEADER_LENGTH,
    "message-server login request",
  );
  writeHeader(writer, {
    toName: "-",
    toNamePadding: 0,
    reserved2: 0,
    flag: 2,
    interfaceFlag: 8,
    fromName: "-",
    fromNamePadding: 0x20,
  });
  return writer.finish();
}

/** One-way MS_LOGOUT control record observed after a completed lookup. */
export function encodeMessageServerLogoutRequest(): Buffer {
  const writer = new CheckedByteWriter(
    MESSAGE_SERVER_HEADER_LENGTH,
    "message-server logout request",
  );
  writeHeader(writer, {
    toName: "-",
    toNamePadding: 0,
    reserved2: 0,
    flag: 0,
    interfaceFlag: 4,
    fromName: "-",
    fromNamePadding: 0x20,
  });
  return writer.finish();
}

export function decodeMessageServerLoginResponse(payload: Uint8Array): void {
  guardedDecode("login response", () => {
    if (payload.byteLength !== MESSAGE_SERVER_HEADER_LENGTH) {
      throw new MessageServerProtocolError(
        "MS_PROTOCOL_ERROR",
        `message-server login response must be ${MESSAGE_SERVER_HEADER_LENGTH} bytes`,
      );
    }
    const reader = new CheckedByteReader(payload, "message-server login response");
    readHeader(reader, {
      toName: "-",
      toNamePadding: 0x20,
      reserved2: 1,
      flag: 2,
      interfaceFlag: 8,
      fromName: MESSAGE_SERVER_NAME,
      fromNamePadding: 0x20,
    });
    reader.finish();
  });
}

export function encodeMessageServerRfcGroupRequest(group: string): Buffer {
  const encodedGroup = groupBytes(group);
  const writer = new CheckedByteWriter(
    MESSAGE_SERVER_RFC_GROUP_REQUEST_LENGTH,
    "message-server RFC-group request",
  );
  writeHeader(writer, {
    toName: MESSAGE_SERVER_NAME,
    toNamePadding: 0,
    reserved2: 0,
    flag: 2,
    interfaceFlag: 1,
    fromName: "-",
    fromNamePadding: 0x20,
  });
  writer.writeUInt8(RFC_GROUP_OPCODE, "opcode");
  writer.writeUInt8(0, "opcodeError");
  writer.writeUInt8(RFC_GROUP_OPCODE_VERSION, "opcodeVersion");
  writer.writeUInt8(0, "opcodeCharset");
  writer.writeBytes(allZero(40), "requestPrefix");
  writer.writeUInt32BE(encodedGroup.byteLength + 4, "groupBlockLength");
  writer.writeBytes(encodedGroup, "group");
  writer.writeBytes(
    allZero(RFC_GROUP_MAX_BYTES - encodedGroup.byteLength),
    "groupPadding",
  );
  writer.writeUInt8(1, "resultVersion");
  writer.writeUInt8(0, "resultReserved");
  writer.writeUInt16BE(0, "resultStatus");
  writer.writeUInt16BE(RFC_LOGON_SELECTOR, "logonSelector");
  writer.writeUInt16BE(0, "hostLength");
  return writer.finish();
}

function decodeGroupEcho(
  reader: CheckedByteReader,
  expectedGroup: Buffer,
): void {
  equalBytes(
    reader.readBytes(40, "responsePrefix"),
    allZero(40),
    "RFC-group response prefix",
  );
  const blockLength = reader.readUInt32BE("groupBlockLength");
  if (blockLength !== expectedGroup.byteLength + 4) {
    throw new MessageServerProtocolError(
      "MS_PROTOCOL_ERROR",
      "message-server RFC-group block length does not match the request",
    );
  }
  equalBytes(
    reader.readBytes(expectedGroup.byteLength, "group"),
    expectedGroup,
    "RFC-group echo",
  );
  equalBytes(
    reader.readBytes(RFC_GROUP_MAX_BYTES - expectedGroup.byteLength, "groupPadding"),
    allZero(RFC_GROUP_MAX_BYTES - expectedGroup.byteLength),
    "RFC-group padding",
  );
}

export function decodeMessageServerRfcGroupResponse(
  payload: Uint8Array,
  expectedGroup: string,
): MessageServerRfcGroupTarget {
  const encodedGroup = groupBytes(expectedGroup);
  return guardedDecode("RFC-group response", () => {
    if (
      payload.byteLength < MESSAGE_SERVER_HEADER_LENGTH ||
      payload.byteLength > MAX_MESSAGE_SERVER_PAYLOAD_LENGTH
    ) {
      throw new MessageServerProtocolError(
        "MS_PROTOCOL_ERROR",
        "message-server RFC-group response length is outside its bounded shape",
      );
    }
    const reader = new CheckedByteReader(
      payload,
      "message-server RFC-group response",
    );
    readHeader(reader, {
      toName: "-",
      toNamePadding: 0x20,
      reserved2: 0,
      flag: 3,
      interfaceFlag: 1,
      fromName: MESSAGE_SERVER_NAME,
      fromNamePadding: 0,
    });
    exactByte(reader.readUInt8("opcode"), RFC_GROUP_OPCODE, "RFC-group opcode");
    const opcodeError = reader.readUInt8("opcodeError");
    const opcodeVersion = reader.readUInt8("opcodeVersion");
    if (opcodeVersion !== RFC_GROUP_OPCODE_VERSION) {
      throw new MessageServerProtocolError(
        "MS_UNSUPPORTED_VERSION",
        `unsupported message-server RFC-group opcode version ${opcodeVersion}`,
      );
    }
    exactByte(
      reader.readUInt8("opcodeCharset"),
      RFC_GROUP_REPLY_CHARSET,
      "RFC-group response charset",
    );
    if (opcodeError !== 0) {
      throw new MessageServerProtocolError(
        "MS_OPCODE_REJECTED",
        `message-server RFC-group lookup failed with opcode error ${opcodeError}`,
        { opcodeError },
      );
    }
    // Every read below is bounded by CheckedByteReader and guardedDecode maps a
    // short read to MS_PROTOCOL_ERROR, so the body needs no length pre-check.
    decodeGroupEcho(reader, encodedGroup);
    exactByte(reader.readUInt8("resultVersion"), 1, "RFC-group result version");
    exactByte(reader.readUInt8("resultReserved"), 0, "RFC-group result reserved byte");
    exactByte(reader.readUInt16BE("resultStatus"), 0, "RFC-group result status");
    const dispatcherPort = reader.readUInt16BE("dispatcherPort");
    // SAP allocates sapdpNN and sapgwNN as contiguous per-instance blocks one
    // hundred ports apart; 3200/3300 is the default block offset, not a
    // protocol constant. Bound the selected and derived endpoints structurally
    // instead of pinning one landscape's offset, so an offset or non-standard
    // instance profile is not refused for a structurally valid reply.
    const gatewayPort = dispatcherPort + PORT_BLOCK_STRIDE;
    if (dispatcherPort < 1 || gatewayPort > MAX_TCP_PORT) {
      throw new MessageServerProtocolError(
        "MS_PROTOCOL_ERROR",
        `message-server returned an unusable dispatcher port ${dispatcherPort}`,
      );
    }
    const hostLength = reader.readUInt16BE("hostLength");
    if (
      hostLength < 1 ||
      hostLength > RFC_GROUP_MAX_HOST_BYTES ||
      reader.remaining !== hostLength + 1
    ) {
      throw new MessageServerProtocolError(
        "MS_PROTOCOL_ERROR",
        "message-server returned an invalid RFC-group hostname length",
      );
    }
    const host = reader.readBytes(hostLength, "host").toString("ascii");
    if (!/^[\x21-\x7e]{1,255}$/u.test(host)) {
      throw new MessageServerProtocolError(
        "MS_PROTOCOL_ERROR",
        "message-server returned a non-ASCII or empty RFC-group hostname",
      );
    }
    exactByte(reader.readUInt8("trailer"), 0x20, "RFC-group response trailer");
    reader.finish();

    const systemNumber = (dispatcherPort % PORT_BLOCK_STRIDE)
      .toString(10)
      .padStart(2, "0");
    return Object.freeze({
      applicationServerHost: host,
      dispatcherPort,
      gatewayPort,
      gatewayService: `sapgw${systemNumber}`,
      systemNumber,
    });
  });
}
