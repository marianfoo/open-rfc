import { snapshotUint8Array } from "./bytes.js";

/** Default allocation ceiling for one independently compressed LZ4 block. */
export const DEFAULT_MAX_LZ4_BLOCK_LENGTH = 16 * 1024 * 1024;

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

function configuredLimit(value: number | undefined, label: string): number {
  const limit = value ?? DEFAULT_MAX_LZ4_BLOCK_LENGTH;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Lz4BlockDecodeError(
      "INVALID_LENGTH",
      `${label} must be a non-negative safe integer`,
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
    "maxInputLength",
  );
  const maxOutputLength = configuredLimit(
    options.maxOutputLength,
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
