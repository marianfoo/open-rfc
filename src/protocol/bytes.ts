const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get;

/** Read typed-array geometry without consulting caller-defined own accessors. */
export function intrinsicUint8ArrayByteLength(value: Uint8Array): number {
  if (typedArrayByteLengthGetter === undefined) {
    throw new Error("Uint8Array byteLength intrinsic is unavailable");
  }
  return Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
}

/** Create a plain view from intrinsic geometry without copying its bytes. */
export function intrinsicUint8ArrayView(
  value: Uint8Array,
  path: string,
): Uint8Array {
  if (
    typedArrayByteOffsetGetter === undefined ||
    typedArrayBufferGetter === undefined
  ) {
    throw new Error("Uint8Array geometry intrinsics are unavailable");
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  const byteOffset = Reflect.apply(
    typedArrayByteOffsetGetter,
    value,
    [],
  ) as number;
  const buffer = Reflect.apply(
    typedArrayBufferGetter,
    value,
    [],
  ) as ArrayBufferLike;
  const view = new Uint8Array(buffer, byteOffset, byteLength);
  if (intrinsicUint8ArrayByteLength(view) !== byteLength) {
    throw new RangeError(`${path} byte length changed while creating its view`);
  }
  return view;
}

/** Copy exactly the intrinsic typed-array view selected by validated geometry. */
export function snapshotUint8Array(
  value: Uint8Array,
  path: string,
  expectedByteLength?: number,
): Buffer {
  if (
    typedArrayByteOffsetGetter === undefined ||
    typedArrayBufferGetter === undefined
  ) {
    throw new Error("Uint8Array geometry intrinsics are unavailable");
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (expectedByteLength !== undefined && byteLength !== expectedByteLength) {
    throw new RangeError(`${path} byte length changed after validation`);
  }
  const byteOffset = Reflect.apply(
    typedArrayByteOffsetGetter,
    value,
    [],
  ) as number;
  const buffer = Reflect.apply(
    typedArrayBufferGetter,
    value,
    [],
  ) as ArrayBufferLike;
  const snapshot = Buffer.from(
    new Uint8Array(buffer, byteOffset, byteLength),
  );
  if (snapshot.byteLength !== byteLength) {
    throw new RangeError(`${path} byte length changed while being copied`);
  }
  return snapshot;
}

function validateLength(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/** Bounds-checked, path-aware reads for untrusted protocol records. */
export class CheckedByteReader {
  readonly #data: Buffer;
  readonly #context: string;
  #offset = 0;

  constructor(data: Uint8Array, context = "byte record") {
    this.#data = Buffer.from(data);
    this.#context = context;
  }

  get length(): number {
    return this.#data.byteLength;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#data.byteLength - this.#offset;
  }

  #ensure(length: number, field: string): void {
    validateLength(length, `${this.#context}.${field} length`);
    if (length > this.remaining) {
      throw new RangeError(
        `${this.#context}.${field}: need ${length} bytes at offset ${this.#offset}; ` +
          `${this.remaining} remain`,
      );
    }
  }

  readUInt8(field: string): number {
    this.#ensure(1, field);
    const value = this.#data.readUInt8(this.#offset);
    this.#offset += 1;
    return value;
  }

  readUInt16BE(field: string): number {
    this.#ensure(2, field);
    const value = this.#data.readUInt16BE(this.#offset);
    this.#offset += 2;
    return value;
  }

  readUInt32BE(field: string): number {
    this.#ensure(4, field);
    const value = this.#data.readUInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }

  readUInt32LE(field: string): number {
    this.#ensure(4, field);
    const value = this.#data.readUInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  readInt32BE(field: string): number {
    this.#ensure(4, field);
    const value = this.#data.readInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }

  readInt32LE(field: string): number {
    this.#ensure(4, field);
    const value = this.#data.readInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  readBytes(length: number, field: string): Buffer {
    this.#ensure(length, field);
    const value = Buffer.from(this.#data.subarray(this.#offset, this.#offset + length));
    this.#offset += length;
    return value;
  }

  skip(length: number, field: string): void {
    this.#ensure(length, field);
    this.#offset += length;
  }

  finish(): void {
    if (this.remaining !== 0) {
      throw new RangeError(`${this.#context}: ${this.remaining} unread bytes remain`);
    }
  }
}

/** Fixed-size, bounds-checked writes used by semantic protocol encoders. */
export class CheckedByteWriter {
  readonly #data: Buffer;
  readonly #context: string;
  #offset = 0;

  constructor(length: number, context = "byte record") {
    validateLength(length, `${context} length`);
    this.#data = Buffer.alloc(length);
    this.#context = context;
  }

  get length(): number {
    return this.#data.byteLength;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#data.byteLength - this.#offset;
  }

  #ensure(length: number, field: string): void {
    validateLength(length, `${this.#context}.${field} length`);
    if (length > this.remaining) {
      throw new RangeError(
        `${this.#context}.${field}: need ${length} bytes at offset ${this.#offset}; ` +
          `${this.remaining} remain`,
      );
    }
  }

  #integer(value: number, minimum: number, maximum: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(
        `${this.#context}.${field}: value ${value} must be an integer in ` +
          `${minimum}..${maximum}`,
      );
    }
  }

  writeUInt8(value: number, field: string): void {
    this.#integer(value, 0, 0xff, field);
    this.#ensure(1, field);
    this.#data.writeUInt8(value, this.#offset);
    this.#offset += 1;
  }

  writeUInt16BE(value: number, field: string): void {
    this.#integer(value, 0, 0xffff, field);
    this.#ensure(2, field);
    this.#data.writeUInt16BE(value, this.#offset);
    this.#offset += 2;
  }

  writeUInt32BE(value: number, field: string): void {
    this.#integer(value, 0, 0xffff_ffff, field);
    this.#ensure(4, field);
    this.#data.writeUInt32BE(value, this.#offset);
    this.#offset += 4;
  }

  writeInt32BE(value: number, field: string): void {
    this.#integer(value, -0x8000_0000, 0x7fff_ffff, field);
    this.#ensure(4, field);
    this.#data.writeInt32BE(value, this.#offset);
    this.#offset += 4;
  }

  writeBytes(value: Uint8Array, field: string): void {
    this.#ensure(value.byteLength, field);
    Buffer.from(value).copy(this.#data, this.#offset);
    this.#offset += value.byteLength;
  }

  finish(): Buffer {
    if (this.remaining !== 0) {
      throw new RangeError(`${this.#context}: ${this.remaining} unwritten bytes remain`);
    }
    return Buffer.from(this.#data);
  }
}
