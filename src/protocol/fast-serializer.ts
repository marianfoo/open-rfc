import { snapshotUint8Array } from "./bytes.js";
import {
  DEFAULT_MAX_LZ4_BLOCK_LENGTH,
  Lz4BlockDecodeError,
  decodeLz4Block,
} from "./lz4-block.js";

// Adapted and made strict/fail-closed for TypeScript from open-rfc-go's
// Apache-2.0 internal/fastser codec at commit
// 92d5d8f6e0a08ff7ac1580f461585cbde2a56939.

export const FAST_SERIALIZER_PARAMETER_ITEM_ID = 0x5001;
export const DEFAULT_MAX_FAST_SERIALIZER_ITEM_LENGTH = 0xffff;
export const DEFAULT_MAX_FAST_SERIALIZER_ITEMS = 1_024;
export const DEFAULT_MAX_FAST_SERIALIZER_RECORDS = 65_536;

export const enum FastSerializerRecordTag {
  Padded = 0x30,
  Character = 0x43,
  End = 0x45,
  Int4 = 0x4e,
  Descriptor = 0x50,
  String = 0x53,
}

export const enum FastSerializerTypeCode {
  Int1 = 0x01,
  Int2 = 0x02,
  Int4 = 0x03,
  Character = 0x06,
  Date = 0x0c,
  Time = 0x0e,
  Float = 0x13,
  Raw = 0x17,
  String = 0x18,
  XString = 0x19,
}

export type FastSerializerProtocolErrorCode =
  | "INVALID_ARGUMENT"
  | "TRUNCATED_INPUT"
  | "ITEM_LIMIT_EXCEEDED"
  | "MALFORMED_ITEM"
  | "COMPRESSION_LIMIT_EXCEEDED"
  | "MALFORMED_COMPRESSION"
  | "RECORD_LIMIT_EXCEEDED"
  | "UNSUPPORTED_RECORD_TAG"
  | "MALFORMED_RECORD"
  | "MALFORMED_PARAMETER"
  | "UNSUPPORTED_TYPE_CODE";

/** A bounded protocol failure that never embeds peer-controlled payload text. */
export class FastSerializerProtocolError extends Error {
  readonly code: FastSerializerProtocolErrorCode;
  readonly offset: number;

  constructor(
    code: FastSerializerProtocolErrorCode,
    message: string,
    offset: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FastSerializerProtocolError";
    this.code = code;
    this.offset = offset;
  }
}

export interface FastSerializerItem {
  readonly id: number;
  readonly data: Buffer;
  readonly offset: number;
  readonly bytesConsumed: number;
}

export interface FastSerializerItemDecodeOptions {
  readonly maxItemLength?: number;
  readonly maxItems?: number;
}

export interface FastSerializerCompressedBlock {
  readonly data: Buffer;
  readonly offset: number;
  readonly compressedLength: number;
  readonly uncompressedLength: number;
  readonly bytesConsumed: number;
}

export interface FastSerializerCompressionOptions {
  readonly maxCompressedLength?: number;
  readonly maxUncompressedLength?: number;
}

export interface FastSerializerRecord {
  readonly tag: FastSerializerRecordTag;
  readonly value: Buffer;
  readonly offset: number;
  readonly bytesConsumed: number;
}

export interface FastSerializerRecordDecodeOptions {
  readonly maxRecords?: number;
}

export interface FastSerializerFieldDescription {
  readonly typeCode: FastSerializerTypeCode;
  readonly width?: number;
  readonly name: string;
}

export interface FastSerializerParameterAnnouncement {
  readonly typeName: string;
  readonly generated: boolean;
  readonly fields: readonly FastSerializerFieldDescription[];
  readonly offset: number;
  readonly bytesConsumed: number;
}

const CHARACTER_FLAG = 0x80;
const STRING_LENGTH_FLAG = 0xc000;
const PARAMETER_HEADER = 0x44;
const COMPRESSION_HEADER_LENGTH = 8;
const TYPE_DESCRIPTOR_PREFIX = Buffer.from("\\TYPE=", "ascii");

function configuredInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 0 ||
    selected > maximum
  ) {
    throw new FastSerializerProtocolError(
      "INVALID_ARGUMENT",
      `${label} must be an integer in 0..${maximum}`,
      0,
    );
  }
  return selected;
}

function inputOffset(value: number, length: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new FastSerializerProtocolError(
      "INVALID_ARGUMENT",
      `offset must be an integer in 0..${length}`,
      0,
    );
  }
  return value;
}

function requireBytes(
  input: Buffer,
  offset: number,
  length: number,
  context: string,
): void {
  if (length > input.byteLength - offset) {
    throw new FastSerializerProtocolError(
      "TRUNCATED_INPUT",
      `${context} is truncated at offset ${offset}`,
      offset,
    );
  }
}

function decodeItemFromSnapshot(
  input: Buffer,
  offset: number,
  maxItemLength: number,
): FastSerializerItem {
  requireBytes(input, offset, 4, "fast-serializer item header");
  const id = input.readUInt16BE(offset);
  const dataLength = input.readUInt16BE(offset + 2);
  if (dataLength > maxItemLength) {
    throw new FastSerializerProtocolError(
      "ITEM_LIMIT_EXCEEDED",
      `fast-serializer item length ${dataLength} exceeds configured limit ${maxItemLength}`,
      offset,
    );
  }

  const dataOffset = offset + 4;
  requireBytes(
    input,
    dataOffset,
    dataLength + 2,
    "fast-serializer item payload",
  );
  const closingIdOffset = dataOffset + dataLength;
  if (input.readUInt16BE(closingIdOffset) !== id) {
    throw new FastSerializerProtocolError(
      "MALFORMED_ITEM",
      "fast-serializer item closing identifier does not match its opening identifier",
      closingIdOffset,
    );
  }
  return Object.freeze({
    id,
    data: Buffer.from(input.subarray(dataOffset, closingIdOffset)),
    offset,
    bytesConsumed: 6 + dataLength,
  });
}

/** Decode one self-closing fast-serializer item at an exact offset. */
export function decodeFastSerializerItem(
  input: Uint8Array,
  offset = 0,
  options: FastSerializerItemDecodeOptions = {},
): FastSerializerItem {
  const snapshot = snapshotUint8Array(input, "fast-serializer item stream");
  try {
    return decodeItemFromSnapshot(
      snapshot,
      inputOffset(offset, snapshot.byteLength),
      configuredInteger(
        options.maxItemLength,
        DEFAULT_MAX_FAST_SERIALIZER_ITEM_LENGTH,
        "maxItemLength",
        0xffff,
      ),
    );
  } finally {
    snapshot.fill(0);
  }
}

/** Decode an exact contiguous item stream; gaps and trailing bytes are errors. */
export function decodeFastSerializerItems(
  input: Uint8Array,
  options: FastSerializerItemDecodeOptions = {},
): readonly FastSerializerItem[] {
  const snapshot = snapshotUint8Array(input, "fast-serializer item stream");
  try {
    const maxItemLength = configuredInteger(
      options.maxItemLength,
      DEFAULT_MAX_FAST_SERIALIZER_ITEM_LENGTH,
      "maxItemLength",
      0xffff,
    );
    const maxItems = configuredInteger(
      options.maxItems,
      DEFAULT_MAX_FAST_SERIALIZER_ITEMS,
      "maxItems",
      DEFAULT_MAX_FAST_SERIALIZER_ITEMS,
    );
    const items: FastSerializerItem[] = [];
    let offset = 0;
    while (offset < snapshot.byteLength) {
      if (items.length === maxItems) {
        throw new FastSerializerProtocolError(
          "ITEM_LIMIT_EXCEEDED",
          `fast-serializer item count exceeds configured limit ${maxItems}`,
          offset,
        );
      }
      const item = decodeItemFromSnapshot(snapshot, offset, maxItemLength);
      items.push(item);
      offset += item.bytesConsumed;
    }
    return Object.freeze(items);
  } finally {
    snapshot.fill(0);
  }
}

/**
 * Decode one SAP fast-serializer LZ4 block with its two little-endian sizes.
 * The returned byte count lets the owning grammar continue without scanning.
 */
export function decodeFastSerializerCompressedBlock(
  input: Uint8Array,
  offset = 0,
  options: FastSerializerCompressionOptions = {},
): FastSerializerCompressedBlock {
  const snapshot = snapshotUint8Array(input, "fast-serializer compressed block");
  try {
    const start = inputOffset(offset, snapshot.byteLength);
    requireBytes(snapshot, start, COMPRESSION_HEADER_LENGTH, "compression header");
    const uncompressedLength = snapshot.readUInt32LE(start);
    const compressedLength = snapshot.readUInt32LE(start + 4);
    const maxCompressedLength = configuredInteger(
      options.maxCompressedLength,
      DEFAULT_MAX_LZ4_BLOCK_LENGTH,
      "maxCompressedLength",
      DEFAULT_MAX_LZ4_BLOCK_LENGTH,
    );
    const maxUncompressedLength = configuredInteger(
      options.maxUncompressedLength,
      DEFAULT_MAX_LZ4_BLOCK_LENGTH,
      "maxUncompressedLength",
      DEFAULT_MAX_LZ4_BLOCK_LENGTH,
    );
    if (
      compressedLength === 0 ||
      uncompressedLength === 0 ||
      compressedLength > uncompressedLength
    ) {
      throw new FastSerializerProtocolError(
        "MALFORMED_COMPRESSION",
        "fast-serializer compression sizes are inconsistent",
        start,
      );
    }
    if (
      compressedLength > maxCompressedLength ||
      uncompressedLength > maxUncompressedLength
    ) {
      throw new FastSerializerProtocolError(
        "COMPRESSION_LIMIT_EXCEEDED",
        "fast-serializer compressed block exceeds configured limits",
        start,
      );
    }
    const blockOffset = start + COMPRESSION_HEADER_LENGTH;
    requireBytes(
      snapshot,
      blockOffset,
      compressedLength,
      "fast-serializer compressed block",
    );
    let data: Buffer;
    try {
      data = decodeLz4Block(
        snapshot.subarray(blockOffset, blockOffset + compressedLength),
        uncompressedLength,
        {
          maxInputLength: maxCompressedLength,
          maxOutputLength: maxUncompressedLength,
        },
      );
    } catch (error) {
      if (!(error instanceof Lz4BlockDecodeError)) throw error;
      throw new FastSerializerProtocolError(
        "MALFORMED_COMPRESSION",
        "fast-serializer LZ4 block is malformed",
        blockOffset,
        { cause: error },
      );
    }
    return Object.freeze({
      data,
      offset: start,
      compressedLength,
      uncompressedLength,
      bytesConsumed: COMPRESSION_HEADER_LENGTH + compressedLength,
    });
  } finally {
    snapshot.fill(0);
  }
}

function decodeRecordFromSnapshot(
  input: Buffer,
  offset: number,
): FastSerializerRecord {
  requireBytes(input, offset, 1, "fast-serializer record tag");
  const tag = input[offset]! as FastSerializerRecordTag;
  let valueOffset = offset + 1;
  let valueLength: number;

  switch (tag) {
    case FastSerializerRecordTag.End:
      return Object.freeze({
        tag,
        value: Buffer.alloc(0),
        offset,
        bytesConsumed: 1,
      });
    case FastSerializerRecordTag.Int4:
      valueLength = 4;
      break;
    case FastSerializerRecordTag.Descriptor:
      requireBytes(input, valueOffset, 1, "descriptor record length");
      valueLength = input[valueOffset]!;
      valueOffset += 1;
      break;
    case FastSerializerRecordTag.Character:
      requireBytes(input, valueOffset, 2, "character record header");
      valueLength = input[valueOffset]!;
      if (input[valueOffset + 1] !== CHARACTER_FLAG) {
        throw new FastSerializerProtocolError(
          "MALFORMED_RECORD",
          "fast-serializer character record has an invalid flag",
          valueOffset + 1,
        );
      }
      valueOffset += 2;
      break;
    case FastSerializerRecordTag.Padded:
      requireBytes(input, valueOffset, 2, "padded record length");
      valueLength = input.readUInt16BE(valueOffset);
      valueOffset += 2;
      break;
    case FastSerializerRecordTag.String: {
      requireBytes(input, valueOffset, 4, "string record lengths");
      const flaggedLength = input.readUInt16LE(valueOffset);
      const plainLength = input.readUInt16LE(valueOffset + 2);
      if (
        (flaggedLength & STRING_LENGTH_FLAG) !== STRING_LENGTH_FLAG ||
        (flaggedLength & 0x3fff) !== plainLength
      ) {
        throw new FastSerializerProtocolError(
          "MALFORMED_RECORD",
          "fast-serializer string record length fields disagree",
          valueOffset,
        );
      }
      valueLength = plainLength;
      valueOffset += 4;
      break;
    }
    default:
      throw new FastSerializerProtocolError(
        "UNSUPPORTED_RECORD_TAG",
        `fast-serializer record tag 0x${input[offset]!.toString(16).padStart(2, "0")} is unsupported`,
        offset,
      );
  }

  if (valueLength === 0) {
    throw new FastSerializerProtocolError(
      "MALFORMED_RECORD",
      "fast-serializer value record must not have an empty value",
      offset,
    );
  }
  requireBytes(input, valueOffset, valueLength, "fast-serializer record value");
  return Object.freeze({
    tag,
    value: Buffer.from(input.subarray(valueOffset, valueOffset + valueLength)),
    offset,
    bytesConsumed: valueOffset + valueLength - offset,
  });
}

/** Decode one known record at an exact offset without scanning for tag bytes. */
export function decodeFastSerializerRecord(
  input: Uint8Array,
  offset = 0,
): FastSerializerRecord {
  const snapshot = snapshotUint8Array(input, "fast-serializer record stream");
  try {
    return decodeRecordFromSnapshot(
      snapshot,
      inputOffset(offset, snapshot.byteLength),
    );
  } finally {
    snapshot.fill(0);
  }
}

/** Decode an exact stream of known records; unknown bytes fail closed. */
export function decodeFastSerializerRecords(
  input: Uint8Array,
  options: FastSerializerRecordDecodeOptions = {},
): readonly FastSerializerRecord[] {
  const snapshot = snapshotUint8Array(input, "fast-serializer record stream");
  try {
    const maxRecords = configuredInteger(
      options.maxRecords,
      DEFAULT_MAX_FAST_SERIALIZER_RECORDS,
      "maxRecords",
      DEFAULT_MAX_FAST_SERIALIZER_RECORDS,
    );
    const records: FastSerializerRecord[] = [];
    let offset = 0;
    while (offset < snapshot.byteLength) {
      if (records.length === maxRecords) {
        throw new FastSerializerProtocolError(
          "RECORD_LIMIT_EXCEEDED",
          `fast-serializer record count exceeds configured limit ${maxRecords}`,
          offset,
        );
      }
      const record = decodeRecordFromSnapshot(snapshot, offset);
      records.push(record);
      offset += record.bytesConsumed;
    }
    return Object.freeze(records);
  } finally {
    snapshot.fill(0);
  }
}

export function fastSerializerTypeName(
  record: FastSerializerRecord,
): string | undefined {
  if (
    record.tag !== FastSerializerRecordTag.Descriptor ||
    record.value.byteLength <= TYPE_DESCRIPTOR_PREFIX.byteLength ||
    !record.value.subarray(0, TYPE_DESCRIPTOR_PREFIX.byteLength)
      .equals(TYPE_DESCRIPTOR_PREFIX)
  ) {
    return undefined;
  }
  const raw = record.value.subarray(TYPE_DESCRIPTOR_PREFIX.byteLength);
  if (!isPlainName(raw, true)) return undefined;
  return raw.toString("ascii");
}

function isPlainName(
  value: Uint8Array,
  allowGeneratedTypeMarker = false,
): boolean {
  if (value.byteLength === 0) return false;
  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = value[index]!;
    const valid =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x5f ||
      byte === 0x2f ||
      (allowGeneratedTypeMarker && index === 0 && byte === 0x25);
    if (!valid) return false;
  }
  return true;
}

function knownTypeCode(value: number): value is FastSerializerTypeCode {
  return value === FastSerializerTypeCode.Int1 ||
    value === FastSerializerTypeCode.Int2 ||
    value === FastSerializerTypeCode.Int4 ||
    value === FastSerializerTypeCode.Character ||
    value === FastSerializerTypeCode.Date ||
    value === FastSerializerTypeCode.Time ||
    value === FastSerializerTypeCode.Float ||
    value === FastSerializerTypeCode.Raw ||
    value === FastSerializerTypeCode.String ||
    value === FastSerializerTypeCode.XString;
}

function decodeParameterFromSnapshot(
  input: Buffer,
  offset: number,
): FastSerializerParameterAnnouncement {
  requireBytes(input, offset, 2, "fast-serializer parameter header");
  if (input[offset] !== PARAMETER_HEADER) {
    throw new FastSerializerProtocolError(
      "MALFORMED_PARAMETER",
      "fast-serializer parameter does not begin with its description header",
      offset,
    );
  }
  const fieldCount = input[offset + 1]!;
  let cursor = offset + 2;
  const descriptor = decodeRecordFromSnapshot(input, cursor);
  const typeName = fastSerializerTypeName(descriptor);
  if (typeName === undefined) {
    throw new FastSerializerProtocolError(
      "MALFORMED_PARAMETER",
      "fast-serializer parameter lacks a valid type descriptor",
      cursor,
    );
  }
  cursor += descriptor.bytesConsumed;

  const fields: FastSerializerFieldDescription[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    requireBytes(input, cursor, 1, "fast-serializer field type code");
    const rawTypeCode = input[cursor]!;
    cursor += 1;
    if (!knownTypeCode(rawTypeCode)) {
      throw new FastSerializerProtocolError(
        "UNSUPPORTED_TYPE_CODE",
        `fast-serializer type code 0x${rawTypeCode.toString(16).padStart(2, "0")} is unsupported`,
        cursor - 1,
      );
    }
    let width: number | undefined;
    if (
      rawTypeCode === FastSerializerTypeCode.Character ||
      rawTypeCode === FastSerializerTypeCode.Raw
    ) {
      requireBytes(input, cursor, 2, "fast-serializer field width");
      width = input.readUInt16LE(cursor);
      cursor += 2;
    }

    requireBytes(input, cursor, 1, "fast-serializer field name length");
    const nameLength = input[cursor]!;
    cursor += 1;
    requireBytes(input, cursor, nameLength, "fast-serializer field name");
    const rawName = input.subarray(cursor, cursor + nameLength);
    if (!isPlainName(rawName)) {
      throw new FastSerializerProtocolError(
        "MALFORMED_PARAMETER",
        "fast-serializer field name is not a plain protocol identifier",
        cursor,
      );
    }
    fields.push(Object.freeze({
      typeCode: rawTypeCode,
      ...(width === undefined ? {} : { width }),
      name: rawName.toString("ascii"),
    }));
    cursor += nameLength;
  }

  return Object.freeze({
    typeName,
    generated: typeName.startsWith("%_T"),
    fields: Object.freeze(fields),
    offset,
    bytesConsumed: cursor - offset,
  });
}

/** Decode one exact field-description announcement without guessing its end. */
export function decodeFastSerializerParameterAnnouncement(
  input: Uint8Array,
  offset = 0,
): FastSerializerParameterAnnouncement {
  const snapshot = snapshotUint8Array(
    input,
    "fast-serializer parameter announcement",
  );
  try {
    return decodeParameterFromSnapshot(
      snapshot,
      inputOffset(offset, snapshot.byteLength),
    );
  } finally {
    snapshot.fill(0);
  }
}
