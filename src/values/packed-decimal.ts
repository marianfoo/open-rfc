import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";

export type PackedDecimalInput = string | number | bigint | { toString(): string };

const MAX_PACKED_DECIMAL_TEXT_LENGTH = 4_096;
const reflectApply = Reflect.apply;

function decimalText(value: PackedDecimalInput, path: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} expects a finite decimal`);
    return value.toString();
  }
  if (typeof value === "string" || typeof value === "bigint") {
    const text = value.toString();
    return text.length === 0 ? "0" : text;
  }
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new TypeError(`${path} expects a decimal string, number, bigint, or decimal object`);
  }
  const toString: unknown = value.toString;
  if (typeof toString !== "function") {
    throw new TypeError(`${path} decimal object must provide toString()`);
  }
  const text: unknown = reflectApply(toString, value, []);
  if (typeof text !== "string") {
    throw new TypeError(`${path} decimal object's toString() must return a string`);
  }
  return text.length === 0 ? "0" : text;
}

function scaledDigits(
  text: string,
  decimals: number,
  capacity: number,
  path: string,
): Readonly<{ digits: string; negative: boolean }> {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (match === null) throw new TypeError(`${path} is not a decimal value`);
  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const coefficient = `${integer}${fraction}`;
  const nonzero = /[1-9]/u.test(coefficient);
  const exponent = match[5] === undefined ? 0 : Number(match[5]);
  if (!Number.isSafeInteger(exponent)) {
    if (!nonzero) return { digits: "0", negative: false };
    if (exponent > 0) {
      throw new RangeError(`${path} exceeds its ${capacity}-digit packed capacity`);
    }
    throw new RangeError(`${path} has more than ${decimals} fractional digits`);
  }

  const shift = exponent + decimals - fraction.length;
  if (!Number.isSafeInteger(shift)) {
    if (!nonzero) return { digits: "0", negative: false };
    if (shift > 0) {
      throw new RangeError(`${path} exceeds its ${capacity}-digit packed capacity`);
    }
    throw new RangeError(`${path} has more than ${decimals} fractional digits`);
  }

  let scaled: string;
  if (shift >= 0) {
    const significantLength = coefficient.replace(/^0+/u, "").length;
    if (significantLength + shift > capacity) {
      throw new RangeError(`${path} exceeds its ${capacity}-digit packed capacity`);
    }
    scaled = `${coefficient}${"0".repeat(shift)}`;
  } else {
    const removedLength = -shift;
    const split = Math.max(0, coefficient.length - removedLength);
    if (/[1-9]/u.test(coefficient.slice(split))) {
      throw new RangeError(`${path} has more than ${decimals} fractional digits`);
    }
    scaled = coefficient.slice(0, split) || "0";
  }

  const significant = scaled.replace(/^0+(?=\d)/u, "");
  if (significant.length > capacity) {
    throw new RangeError(`${path} exceeds its ${capacity}-digit packed capacity`);
  }
  return {
    digits: significant,
    negative: match[1] === "-" && /[1-9]/u.test(significant),
  };
}

function geometry(byteLength: number, decimals: number, path: string): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 16) {
    throw new RangeError(`${path} packed length must be an integer in 1..16`);
  }
  const digits = byteLength * 2 - 1;
  const maximumDecimals = Math.min(14, digits);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > maximumDecimals) {
    throw new RangeError(
      `${path} decimals must be an integer in 0..${maximumDecimals}`,
    );
  }
  return digits;
}

/** Encode ABAP TYPE P packed BCD with a trailing C/D sign nibble. */
export function encodePackedDecimal(
  value: PackedDecimalInput,
  byteLength: number,
  decimals: number,
  path = "packed decimal",
): Buffer {
  const capacity = geometry(byteLength, decimals, path);
  const text = decimalText(value, path);
  if (text.length > MAX_PACKED_DECIMAL_TEXT_LENGTH) {
    throw new RangeError(
      `${path} decimal text exceeds ${MAX_PACKED_DECIMAL_TEXT_LENGTH} characters`,
    );
  }
  const scaled = scaledDigits(text, decimals, capacity, path);
  const digits = scaled.digits.padStart(capacity, "0");
  const negative = scaled.negative;
  const nibbles = `${digits}${negative ? "D" : "C"}`;
  return Buffer.from(
    Array.from({ length: byteLength }, (_, index) =>
      Number.parseInt(nibbles.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

/** Decode ABAP TYPE P to node-rfc's precision-preserving default string. */
export function decodePackedDecimal(
  value: Uint8Array,
  decimals: number,
  path = "packed decimal",
): string {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${path} expects Uint8Array bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  const capacity = geometry(byteLength, decimals, path);
  const bytes = snapshotUint8Array(value, path, byteLength);
  const hex = bytes.toString("hex").toUpperCase();
  const digits = hex.slice(0, capacity);
  if (!/^\d+$/u.test(digits)) throw new Error(`${path} contains a non-decimal digit nibble`);
  const sign = hex.at(-1)!;
  const positive = sign === "A" || sign === "C" || sign === "E" || sign === "F";
  const negative = sign === "B" || sign === "D";
  if (!positive && !negative) throw new Error(`${path} contains invalid sign nibble ${sign}`);

  const integerDigits = decimals === 0 ? digits : digits.slice(0, -decimals) || "0";
  const integer = integerDigits.replace(/^0+(?=\d)/u, "");
  const fraction = decimals === 0 ? "" : digits.slice(-decimals);
  const nonzero = /[1-9]/u.test(digits);
  return `${negative && nonzero ? "-" : ""}${integer}` +
    (decimals === 0 ? "" : `.${fraction}`);
}
