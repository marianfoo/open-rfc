import { CheckedByteWriter } from "./bytes.js";

export const RFC_PRO_EXTENDED_LENGTH_SENTINEL = 0xffff;
export const RFC_PRO_COMPACT_LENGTH_MAX = RFC_PRO_EXTENDED_LENGTH_SENTINEL - 1;
export const RFC_PRO_VALUE_LENGTH_MAX = 0x7fff_ffff;

export type RfcProLengthEncoding = "compact" | "extended";

export interface RfcProFieldHeader {
  readonly tag: number;
  readonly length: number;
  readonly encoding: RfcProLengthEncoding;
  readonly bytesConsumed: 4 | 8;
}

export interface RfcProFieldHeaderDecodeOptions {
  readonly maxValueLength?: number;
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

function validateTag(tag: number): void {
  boundedInteger(tag, 0, 0xffff, "RFCPRO tag");
}

function validateValueLength(length: number): void {
  boundedInteger(length, 0, RFC_PRO_VALUE_LENGTH_MAX, "RFCPRO length");
}

export function rfcProFieldHeaderByteLength(length: number): 4 | 8 {
  validateValueLength(length);
  return length <= RFC_PRO_COMPACT_LENGTH_MAX ? 4 : 8;
}

/** Encode the canonical RFCPRO tag/length header without allocating a value. */
export function encodeRfcProFieldHeader(tag: number, length: number): Buffer {
  validateTag(tag);
  const byteLength = rfcProFieldHeaderByteLength(length);
  const writer = new CheckedByteWriter(byteLength, "RFCPRO field header");
  writer.writeUInt16BE(tag, "tag");
  if (byteLength === 4) {
    writer.writeUInt16BE(length, "compactLength");
  } else {
    writer.writeUInt16BE(
      RFC_PRO_EXTENDED_LENGTH_SENTINEL,
      "extendedLengthSentinel",
    );
    writer.writeInt32BE(length, "extendedLength");
  }
  return writer.finish();
}

/**
 * Decode an RFCPRO tag/length header prefix and apply the allocation policy
 * before a caller reads or allocates the advertised value.
 */
export function decodeRfcProFieldHeader(
  data: Uint8Array,
  options: RfcProFieldHeaderDecodeOptions = {},
): RfcProFieldHeader {
  const maxValueLength = options.maxValueLength ?? RFC_PRO_VALUE_LENGTH_MAX;
  boundedInteger(
    maxValueLength,
    0,
    RFC_PRO_VALUE_LENGTH_MAX,
    "maxValueLength",
  );

  // Snapshot at most the fixed-size header. This keeps decoding independent of
  // later caller mutation without copying an advertised value or trailing data.
  const bytes = Buffer.from(data.subarray(0, 8));
  if (bytes.byteLength < 2) {
    throw new RangeError(
      `RFCPRO field header.tag: need 2 bytes at offset 0; ${bytes.byteLength} remain`,
    );
  }
  const tag = bytes.readUInt16BE(0);
  if (bytes.byteLength < 4) {
    throw new RangeError(
      `RFCPRO field header.length: need 2 bytes at offset 2; ${bytes.byteLength - 2} remain`,
    );
  }
  const compactLength = bytes.readUInt16BE(2);
  if (compactLength !== RFC_PRO_EXTENDED_LENGTH_SENTINEL) {
    if (compactLength > maxValueLength) {
      throw new RangeError(
        `RFCPRO length ${compactLength} exceeds configured limit ${maxValueLength}`,
      );
    }
    return Object.freeze({
      tag,
      length: compactLength,
      encoding: "compact" as const,
      bytesConsumed: 4 as const,
    });
  }

  if (bytes.byteLength < 8) {
    throw new RangeError(
      `RFCPRO field header.extendedLength: need 4 bytes at offset 4; ${bytes.byteLength - 4} remain`,
    );
  }
  const extendedLength = bytes.readInt32BE(4);
  if (extendedLength < 0) {
    throw new RangeError(
      `RFCPRO extended length ${extendedLength} is negative`,
    );
  }
  if (extendedLength > maxValueLength) {
    throw new RangeError(
      `RFCPRO length ${extendedLength} exceeds configured limit ${maxValueLength}`,
    );
  }
  return Object.freeze({
    tag,
    length: extendedLength,
    encoding: "extended" as const,
    bytesConsumed: 8 as const,
  });
}
