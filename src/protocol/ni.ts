import { snapshotUint8Array } from "./bytes.js";

const NI_LENGTH_BYTES = 4;

export const DEFAULT_MAX_NI_PAYLOAD_LENGTH = 256 * 1024 * 1024;

export function encodeNiFrame(payload: Uint8Array): Buffer {
  const snapshot = snapshotUint8Array(payload, "NI payload");
  try {
    if (snapshot.byteLength > 0xffff_ffff) {
      throw new RangeError("an NI payload cannot exceed the unsigned 32-bit length field");
    }

    const frame = Buffer.allocUnsafe(NI_LENGTH_BYTES + snapshot.byteLength);
    frame.writeUInt32BE(snapshot.byteLength, 0);
    snapshot.copy(frame, NI_LENGTH_BYTES);
    return frame;
  } finally {
    snapshot.fill(0);
  }
}

/**
 * Incrementally separates the four-byte, big-endian length-prefixed records
 * used by SAP's Network Interface layer.
 */
export class NiFrameDecoder {
  readonly #maxPayloadLength: number;
  #chunks: Buffer[] = [];
  #headIndex = 0;
  #headOffset = 0;
  #bufferedByteLength = 0;

  constructor(maxPayloadLength = DEFAULT_MAX_NI_PAYLOAD_LENGTH) {
    if (!Number.isSafeInteger(maxPayloadLength) || maxPayloadLength < 0) {
      throw new RangeError("maxPayloadLength must be a non-negative safe integer");
    }
    this.#maxPayloadLength = maxPayloadLength;
  }

  get bufferedByteLength(): number {
    return this.#bufferedByteLength;
  }

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength > 0) {
      this.#chunks.push(Buffer.from(chunk));
      this.#bufferedByteLength += chunk.byteLength;
    }

    const payloads: Buffer[] = [];
    while (this.#bufferedByteLength >= NI_LENGTH_BYTES) {
      const payloadLength = this.#peekUInt32BE();
      if (payloadLength > this.#maxPayloadLength) {
        throw new RangeError(
          `NI payload length ${payloadLength} exceeds configured limit ${this.#maxPayloadLength}`,
        );
      }

      if (this.#bufferedByteLength < NI_LENGTH_BYTES + payloadLength) break;
      this.#consume(NI_LENGTH_BYTES);
      payloads.push(this.#consume(payloadLength));
    }
    return payloads;
  }

  finish(): void {
    if (this.#bufferedByteLength !== 0) {
      throw new Error(`truncated NI stream: ${this.#bufferedByteLength} bytes remain`);
    }
  }

  /** Release and wipe every retained partial-frame byte after terminal use. */
  reset(): void {
    for (const chunk of this.#chunks) chunk.fill(0);
    this.#chunks = [];
    this.#headIndex = 0;
    this.#headOffset = 0;
    this.#bufferedByteLength = 0;
  }

  #peekUInt32BE(): number {
    let value = 0;
    let remaining = NI_LENGTH_BYTES;
    let chunkIndex = this.#headIndex;
    let chunkOffset = this.#headOffset;
    while (remaining > 0) {
      const current = this.#chunks[chunkIndex];
      if (current === undefined) throw new Error("NI decoder queue is inconsistent");
      const take = Math.min(remaining, current.byteLength - chunkOffset);
      for (let index = 0; index < take; index += 1) {
        value = value * 256 + current[chunkOffset + index]!;
      }
      remaining -= take;
      chunkIndex += 1;
      chunkOffset = 0;
    }
    return value;
  }

  #consume(length: number): Buffer {
    if (length > this.#bufferedByteLength) {
      throw new Error("NI decoder attempted to consume beyond its queue");
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const current = this.#chunks[this.#headIndex];
      if (current === undefined) throw new Error("NI decoder queue is inconsistent");
      const take = Math.min(length - written, current.byteLength - this.#headOffset);
      current.copy(result, written, this.#headOffset, this.#headOffset + take);
      written += take;
      this.#headOffset += take;
      if (this.#headOffset === current.byteLength) {
        this.#headIndex += 1;
        this.#headOffset = 0;
      }
    }
    this.#bufferedByteLength -= length;
    this.#compactQueue();
    return result;
  }

  #compactQueue(): void {
    if (this.#headIndex === this.#chunks.length) {
      for (const chunk of this.#chunks) chunk.fill(0);
      this.#chunks = [];
      this.#headIndex = 0;
      return;
    }
    if (this.#headIndex >= 64 && this.#headIndex * 2 >= this.#chunks.length) {
      for (let index = 0; index < this.#headIndex; index += 1) {
        this.#chunks[index]?.fill(0);
      }
      this.#chunks = this.#chunks.slice(this.#headIndex);
      this.#headIndex = 0;
    }
  }
}
