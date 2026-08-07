import { isIPv4 } from "node:net";

import { CheckedByteReader, CheckedByteWriter } from "./bytes.js";

export const GATEWAY_NORMAL_CLIENT_LENGTH = 64;
export const GATEWAY_PROTOCOL_VERSION = 2;
export const GATEWAY_NORMAL_CLIENT_REQUEST = 3;

export enum GatewayAcceptInfo {
  ErrorInfo = 0x01,
  Ping = 0x02,
  Snc = 0x04,
  ConnectionExtendedInfo = 0x08,
  CodePage = 0x10,
  NiPing = 0x20,
  ExtendedInitOptions = 0x40,
  DistributedTrace = 0x80,
}

export interface GatewayNormalClientRecord {
  readonly address: string;
  readonly service: string;
  readonly codePage: string;
  /**
   * Last byte of the otherwise zero six-byte gateway option region. Client
   * value 6 and server value 15 are observed. Keep it explicit until a second
   * implementation establishes individual option-bit semantics.
   */
  readonly gatewayOptionLevel: number;
  readonly logicalUnit: string;
  readonly transactionProgram: string;
  readonly conversationId: string;
  readonly appcHeaderVersion: number;
  readonly acceptInfo: number;
  readonly index: number;
  readonly returnCode: number;
  readonly echoData: number;
}

function encodeAscii(
  value: string,
  length: number,
  field: string,
  padding: number,
): Buffer {
  if (
    typeof value !== "string" ||
    value.length > length ||
    !/^[\x20-\x7e]*$/.test(value)
  ) {
    throw new RangeError(`${field} must contain at most ${length} ASCII bytes`);
  }
  const result = Buffer.alloc(length, padding);
  result.write(value, 0, "ascii");
  return result;
}

function decodeAscii(data: Buffer, field: string): string {
  for (const byte of data) {
    if (byte !== 0 && (byte < 0x20 || byte > 0x7e)) {
      throw new Error(`${field} contains a non-ASCII byte`);
    }
  }
  return data.toString("ascii").replace(/[\x00 ]+$/u, "");
}

function encodeIpv4(address: string): Buffer {
  if (!isIPv4(address)) {
    throw new RangeError("address must be an IPv4 address for gateway protocol version 2");
  }
  return Buffer.from(address.split(".").map(Number));
}

function decodeIpv4(data: Buffer): string {
  return [...data].join(".");
}

function validateSigned16(value: number): void {
  if (!Number.isSafeInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new RangeError("index must be a signed 16-bit integer");
  }
}

/** Encode the version-2 GW_NORMAL_CLIENT record used before APPC setup. */
export function encodeGatewayNormalClient(record: GatewayNormalClientRecord): Buffer {
  validateSigned16(record.index);
  if (!/^\d{4}$/.test(record.codePage)) {
    throw new RangeError("codePage must contain exactly four ASCII digits");
  }
  const writer = new CheckedByteWriter(
    GATEWAY_NORMAL_CLIENT_LENGTH,
    "gateway normal-client record",
  );
  writer.writeUInt8(GATEWAY_PROTOCOL_VERSION, "version");
  writer.writeUInt8(GATEWAY_NORMAL_CLIENT_REQUEST, "requestType");
  writer.writeBytes(encodeIpv4(record.address), "address");
  writer.writeUInt32BE(0, "reserved1");
  writer.writeBytes(encodeAscii(record.service, 10, "service", 0), "service");
  writer.writeBytes(Buffer.from(record.codePage, "ascii"), "codePage");
  writer.writeBytes(Buffer.alloc(5), "reserved2");
  writer.writeUInt8(record.gatewayOptionLevel, "gatewayOptionLevel");
  writer.writeBytes(
    encodeAscii(record.logicalUnit, 8, "logicalUnit", 0x20),
    "logicalUnit",
  );
  writer.writeBytes(
    encodeAscii(record.transactionProgram, 8, "transactionProgram", 0x20),
    "transactionProgram",
  );
  writer.writeBytes(
    encodeAscii(record.conversationId, 8, "conversationId", 0x20),
    "conversationId",
  );
  writer.writeUInt8(record.appcHeaderVersion, "appcHeaderVersion");
  writer.writeUInt8(record.acceptInfo, "acceptInfo");
  writer.writeUInt16BE(record.index & 0xffff, "index");
  writer.writeUInt32BE(record.returnCode, "returnCode");
  writer.writeUInt8(record.echoData, "echoData");
  writer.writeUInt8(0, "filler");
  return writer.finish();
}

/** Decode the supported version-2 GW_NORMAL_CLIENT request or response. */
export function decodeGatewayNormalClient(data: Uint8Array): GatewayNormalClientRecord {
  if (data.byteLength < 2) {
    throw new RangeError("gateway normal-client record needs at least 2 bytes");
  }
  const version = data[0];
  if (version === 3) {
    throw new Error("gateway protocol version 3 IPv6 records are not implemented");
  }
  if (version !== GATEWAY_PROTOCOL_VERSION) {
    throw new Error(`unsupported gateway protocol version ${version}`);
  }
  if (data.byteLength !== GATEWAY_NORMAL_CLIENT_LENGTH) {
    throw new RangeError(
      `gateway version-2 normal-client record needs ${GATEWAY_NORMAL_CLIENT_LENGTH} bytes; ` +
        `received ${data.byteLength}`,
    );
  }

  const reader = new CheckedByteReader(data, "gateway normal-client record");
  reader.readUInt8("version");
  const requestType = reader.readUInt8("requestType");
  if (requestType !== GATEWAY_NORMAL_CLIENT_REQUEST) {
    throw new Error(`expected GW_NORMAL_CLIENT request type 3; received ${requestType}`);
  }
  const address = decodeIpv4(reader.readBytes(4, "address"));
  if (reader.readUInt32BE("reserved1") !== 0) {
    throw new Error("gateway normal-client reserved1 field must be zero");
  }
  const service = decodeAscii(reader.readBytes(10, "service"), "service");
  const codePage = decodeAscii(reader.readBytes(4, "codePage"), "codePage");
  if (!reader.readBytes(5, "reserved2").equals(Buffer.alloc(5))) {
    throw new Error("gateway normal-client reserved2 field must be zero");
  }
  const gatewayOptionLevel = reader.readUInt8("gatewayOptionLevel");
  const logicalUnit = decodeAscii(reader.readBytes(8, "logicalUnit"), "logicalUnit");
  const transactionProgram = decodeAscii(
    reader.readBytes(8, "transactionProgram"),
    "transactionProgram",
  );
  const conversationId = decodeAscii(
    reader.readBytes(8, "conversationId"),
    "conversationId",
  );
  const appcHeaderVersion = reader.readUInt8("appcHeaderVersion");
  const acceptInfo = reader.readUInt8("acceptInfo");
  const unsignedIndex = reader.readUInt16BE("index");
  const index = unsignedIndex > 0x7fff ? unsignedIndex - 0x1_0000 : unsignedIndex;
  const returnCode = reader.readUInt32BE("returnCode");
  const echoData = reader.readUInt8("echoData");
  if (reader.readUInt8("filler") !== 0) {
    throw new Error("gateway normal-client filler field must be zero");
  }
  reader.finish();

  return {
    address,
    service,
    codePage,
    gatewayOptionLevel,
    logicalUnit,
    transactionProgram,
    conversationId,
    appcHeaderVersion,
    acceptInfo,
    index,
    returnCode,
    echoData,
  };
}
