import { snapshotUint8Array } from "./bytes.js";

// Decoder adapted and hardened for TypeScript from open-rfc-go's Apache-2.0
// internal/fastser/lz4.go at 92d5d8f6e0a08ff7ac1580f461585cbde2a56939.
// Encoder independently authored from the published LZ4 block-format grammar
// at lz4/lz4 v1.10.0 (ebb370ca83af193212df4dcbadcc5d87bc0de2f0).

/** Absolute allocation ceiling for one independently compressed LZ4 block. */
export const MAX_LZ4_BLOCK_LENGTH = 16 * 1024 * 1024;
export const DEFAULT_MAX_LZ4_BLOCK_LENGTH = MAX_LZ4_BLOCK_LENGTH;
export const MAX_LZ4_ENCODED_BLOCK_LENGTH =
  MAX_LZ4_BLOCK_LENGTH + Math.floor(MAX_LZ4_BLOCK_LENGTH / 255) + 16;
export const DEFAULT_MAX_LZ4_ENCODED_BLOCK_LENGTH =
  MAX_LZ4_ENCODED_BLOCK_LENGTH;

export type Lz4BlockDecodeErrorCode =
  | "INVALID_LENGTH"
  | "INPUT_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TRUNCATED_INPUT"
  | "INVALID_OFFSET"
  | "OUTPUT_LENGTH_MISMATCH"
  | "OUTPUT_OVERRUN";

/** A bounded, non-payload-bearing failure from the LZ4 block decoder. */
export class Lz4BlockDecodeError extends Error {
  readonly code: Lz4BlockDecodeErrorCode;

  constructor(code: Lz4BlockDecodeErrorCode, message: string) {
    super(message);
    this.name = "Lz4BlockDecodeError";
    this.code = code;
  }
}

export interface Lz4BlockDecodeOptions {
  readonly maxInputLength?: number;
  readonly maxOutputLength?: number;
}

export type Lz4BlockEncodeErrorCode =
  | "INVALID_LENGTH"
  | "INPUT_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED";

/** A bounded failure from the deterministic raw LZ4 block encoder. */
export class Lz4BlockEncodeError extends Error {
  readonly code: Lz4BlockEncodeErrorCode;

  constructor(code: Lz4BlockEncodeErrorCode, message: string) {
    super(message);
    this.name = "Lz4BlockEncodeError";
    this.code = code;
  }
}

export interface Lz4BlockEncodeOptions {
  readonly maxInputLength?: number;
  readonly maxOutputLength?: number;
}

function boundedLength(
  value: number,
  label: string,
  maximum: number,
  maximumCode: Lz4BlockDecodeErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Lz4BlockDecodeError(
      "INVALID_LENGTH",
      `${label} must be a non-negative safe integer`,
    );
  }
  if (value > maximum) {
    throw new Lz4BlockDecodeError(
      maximumCode,
      `${label} ${value} exceeds configured limit ${maximum}`,
    );
  }
  return value;
}

function configuredLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new Lz4BlockDecodeError(
      "INVALID_LENGTH",
      `${label} must be an integer in 0..${maximum}`,
    );
  }
  return limit;
}

/**
 * Decode one raw LZ4 block into exactly `outputLength` bytes.
 *
 * LZ4 blocks carry neither framing nor their decoded size. Both the complete
 * compressed block and its independently bounded output length must therefore
 * come from the owning protocol layer. This implements the published LZ4 block
 * grammar, not the separate LZ4 frame format.
 */
export function decodeLz4Block(
  input: Uint8Array,
  outputLength: number,
  options: Lz4BlockDecodeOptions = {},
): Buffer {
  const maxInputLength = configuredLimit(
    options.maxInputLength,
    DEFAULT_MAX_LZ4_ENCODED_BLOCK_LENGTH,
    MAX_LZ4_ENCODED_BLOCK_LENGTH,
    "maxInputLength",
  );
  const maxOutputLength = configuredLimit(
    options.maxOutputLength,
    DEFAULT_MAX_LZ4_BLOCK_LENGTH,
    MAX_LZ4_BLOCK_LENGTH,
    "maxOutputLength",
  );
  const source = snapshotUint8Array(input, "LZ4 block");
  let output: Buffer | undefined;

  try {
    boundedLength(
      source.byteLength,
      "LZ4 input length",
      maxInputLength,
      "INPUT_LIMIT_EXCEEDED",
    );
    boundedLength(
      outputLength,
      "LZ4 output length",
      maxOutputLength,
      "OUTPUT_LIMIT_EXCEEDED",
    );
    if (source.byteLength === 0) {
      throw new Lz4BlockDecodeError(
        "TRUNCATED_INPUT",
        "LZ4 block is missing its first sequence token",
      );
    }

    output = Buffer.allocUnsafe(outputLength);
    let sourceOffset = 0;
    let outputOffset = 0;

    const readExtendedLength = (base: number, kind: "literal" | "match"): number => {
      let length = base;
      if (base !== 15) return length;
      while (true) {
        const extension = source[sourceOffset];
        if (extension === undefined) {
          throw new Lz4BlockDecodeError(
            "TRUNCATED_INPUT",
            `LZ4 ${kind} length extension is truncated`,
          );
        }
        sourceOffset += 1;
        length += extension;
        if (!Number.isSafeInteger(length) || length > maxOutputLength) {
          throw new Lz4BlockDecodeError(
            "OUTPUT_OVERRUN",
            `LZ4 ${kind} length exceeds the configured output bound`,
          );
        }
        if (extension !== 0xff) return length;
      }
    };

    while (sourceOffset < source.byteLength) {
      const token = source[sourceOffset]!;
      sourceOffset += 1;

      const literalLength = readExtendedLength(token >>> 4, "literal");
      if (literalLength > source.byteLength - sourceOffset) {
        throw new Lz4BlockDecodeError(
          "TRUNCATED_INPUT",
          "LZ4 literal run extends past the compressed block",
        );
      }
      if (literalLength > outputLength - outputOffset) {
        throw new Lz4BlockDecodeError(
          "OUTPUT_OVERRUN",
          "LZ4 literal run exceeds the declared output length",
        );
      }
      source.copy(
        output,
        outputOffset,
        sourceOffset,
        sourceOffset + literalLength,
      );
      sourceOffset += literalLength;
      outputOffset += literalLength;

      // The final sequence contains literals only and ends with the block.
      if (sourceOffset === source.byteLength) break;
      if (source.byteLength - sourceOffset < 2) {
        throw new Lz4BlockDecodeError(
          "TRUNCATED_INPUT",
          "LZ4 match offset is truncated",
        );
      }

      const matchOffset = source.readUInt16LE(sourceOffset);
      sourceOffset += 2;
      if (matchOffset === 0 || matchOffset > outputOffset) {
        throw new Lz4BlockDecodeError(
          "INVALID_OFFSET",
          "LZ4 match offset does not reference decoded output",
        );
      }

      const matchLength = readExtendedLength(token & 0x0f, "match") + 4;
      if (matchLength > outputLength - outputOffset) {
        throw new Lz4BlockDecodeError(
          "OUTPUT_OVERRUN",
          "LZ4 match exceeds the declared output length",
        );
      }

      // LZ4 explicitly permits overlapping copies, including offset-one runs.
      for (let index = 0; index < matchLength; index += 1) {
        output[outputOffset] = output[outputOffset - matchOffset]!;
        outputOffset += 1;
      }
    }

    if (outputOffset !== outputLength) {
      throw new Lz4BlockDecodeError(
        "OUTPUT_LENGTH_MISMATCH",
        `LZ4 block produced ${outputOffset} bytes; expected ${outputLength}`,
      );
    }
    return output;
  } catch (error) {
    output?.fill(0);
    throw error;
  } finally {
    source.fill(0);
  }
}

function configuredEncodeLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) {
    throw new Lz4BlockEncodeError(
      "INVALID_LENGTH",
      `${label} must be an integer in 0..${maximum}`,
    );
  }
  return limit;
}

function encodedLengthBound(inputLength: number): number {
  if (inputLength === 0) return 1;
  return inputLength + Math.floor(inputLength / 255) + 16;
}

/**
 * Encode one deterministic independent LZ4 block.
 *
 * The encoder uses a bounded 64 KiB-window greedy match search and preserves
 * the published independent-block ending conditions: the last five source
 * bytes remain literals and the last match starts at least twelve bytes before
 * the end. The raw block carries no size or checksum metadata.
 */
export function encodeLz4Block(
  input: Uint8Array,
  options: Lz4BlockEncodeOptions = {},
): Buffer {
  const maxInputLength = configuredEncodeLimit(
    options.maxInputLength,
    DEFAULT_MAX_LZ4_BLOCK_LENGTH,
    MAX_LZ4_BLOCK_LENGTH,
    "maxInputLength",
  );
  const maxOutputLength = configuredEncodeLimit(
    options.maxOutputLength,
    DEFAULT_MAX_LZ4_ENCODED_BLOCK_LENGTH,
    MAX_LZ4_ENCODED_BLOCK_LENGTH,
    "maxOutputLength",
  );
  const source = snapshotUint8Array(input, "LZ4 encoder input");
  let output: Buffer | undefined;
  try {
    if (source.byteLength > maxInputLength) {
      throw new Lz4BlockEncodeError(
        "INPUT_LIMIT_EXCEEDED",
        `LZ4 input length ${source.byteLength} exceeds configured limit ${maxInputLength}`,
      );
    }

    const outputCapacity = Math.min(
      encodedLengthBound(source.byteLength),
      maxOutputLength,
    );
    output = Buffer.allocUnsafe(outputCapacity);
    let outputOffset = 0;

    const requireOutput = (length: number): void => {
      if (length > output!.byteLength - outputOffset) {
        throw new Lz4BlockEncodeError(
          "OUTPUT_LIMIT_EXCEEDED",
          `LZ4 encoded block exceeds configured limit ${maxOutputLength}`,
        );
      }
    };
    const writeByte = (value: number): void => {
      requireOutput(1);
      output![outputOffset] = value;
      outputOffset += 1;
    };
    const writeExtendedLength = (length: number): void => {
      if (length < 15) return;
      let remainder = length - 15;
      while (remainder >= 0xff) {
        writeByte(0xff);
        remainder -= 0xff;
      }
      writeByte(remainder);
    };
    const writeSource = (start: number, length: number): void => {
      requireOutput(length);
      source.copy(output!, outputOffset, start, start + length);
      outputOffset += length;
    };

    if (source.byteLength === 0) {
      writeByte(0);
      return Buffer.from(output.subarray(0, outputOffset));
    }

    const hashTable = new Int32Array(1 << 16);
    hashTable.fill(-1);
    const hashAt = (offset: number): number =>
      Math.imul(source.readUInt32LE(offset), 0x9e37_79b1) >>> 16;

    let anchor = 0;
    let position = 0;
    const lastMatchStart = source.byteLength - 12;
    const matchEndLimit = source.byteLength - 5;

    while (position <= lastMatchStart) {
      const hash = hashAt(position);
      const candidate = hashTable[hash]!;
      hashTable[hash] = position;
      const distance = position - candidate;
      if (
        candidate < 0 ||
        distance > 0xffff ||
        source.readUInt32LE(candidate) !== source.readUInt32LE(position)
      ) {
        position += 1;
        continue;
      }

      let matchLength = 4;
      while (
        position + matchLength < matchEndLimit &&
        source[candidate + matchLength] === source[position + matchLength]
      ) {
        matchLength += 1;
      }

      const literalLength = position - anchor;
      const encodedMatchLength = matchLength - 4;
      writeByte(
        (Math.min(literalLength, 15) << 4) |
          Math.min(encodedMatchLength, 15),
      );
      writeExtendedLength(literalLength);
      writeSource(anchor, literalLength);
      requireOutput(2);
      output.writeUInt16LE(distance, outputOffset);
      outputOffset += 2;
      writeExtendedLength(encodedMatchLength);

      const matchStart = position;
      position += matchLength;
      anchor = position;
      for (
        let update = matchStart + 1;
        update < position && update + 4 <= source.byteLength;
        update += 1
      ) {
        hashTable[hashAt(update)] = update;
      }
    }

    const finalLiteralLength = source.byteLength - anchor;
    writeByte(Math.min(finalLiteralLength, 15) << 4);
    writeExtendedLength(finalLiteralLength);
    writeSource(anchor, finalLiteralLength);
    return Buffer.from(output.subarray(0, outputOffset));
  } finally {
    source.fill(0);
    output?.fill(0);
  }
}
