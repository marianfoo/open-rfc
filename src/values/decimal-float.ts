import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";

export type DecimalFloatInput =
  | string
  | number
  | bigint
  | { toString(): string };

/* IEEE 754 decimal interchange using Cowlishaw's Densely Packed Decimal
 * mapping (https://speleotrove.com/decimal/dbspec.html). SAP stores these
 * fields in host-little-endian byte order on supported RFC platforms. */

interface DecimalFloatFormat {
  readonly label: "DECF16" | "DECF34";
  readonly byteLength: 8 | 16;
  readonly precision: 16 | 34;
  readonly exponentContinuationBits: 8 | 12;
  readonly coefficientContinuationBits: 50 | 110;
  readonly exponentBias: 398 | 6176;
}

const DECF16: DecimalFloatFormat = {
  label: "DECF16",
  byteLength: 8,
  precision: 16,
  exponentContinuationBits: 8,
  coefficientContinuationBits: 50,
  exponentBias: 398,
};

const DECF34: DecimalFloatFormat = {
  label: "DECF34",
  byteLength: 16,
  precision: 34,
  exponentContinuationBits: 12,
  coefficientContinuationBits: 110,
  exponentBias: 6176,
};

interface FiniteDecimal {
  readonly negative: boolean;
  readonly coefficient: string;
  readonly exponent: number;
}

interface SpecialDecimal {
  readonly negative: boolean;
  readonly kind: "infinity" | "nan" | "snan";
  readonly diagnostic: string;
}

const MAX_DECIMAL_FLOAT_TEXT_LENGTH = 4_096;
const reflectApply = Reflect.apply;

function encodeDpdDeclet(value: number): number {
  const left = Math.floor(value / 100);
  const middle = Math.floor(value / 10) % 10;
  const right = value % 10;
  const largePattern = (left >= 8 ? 4 : 0) |
    (middle >= 8 ? 2 : 0) |
    (right >= 8 ? 1 : 0);

  // The pattern is the a/e/i high bit from each input BCD digit.
  switch (largePattern) {
    case 0:
      return (left << 7) | (middle << 4) | right;
    case 1:
      return (left << 7) | (middle << 4) | 0b1000 | (right & 1);
    case 2:
      return (left << 7) | ((right & 0b110) | (middle & 1)) << 4 |
        0b1010 | (right & 1);
    case 4:
      return ((right & 0b110) | (left & 1)) << 7 | (middle << 4) |
        0b1100 | (right & 1);
    case 6:
      return ((right & 0b110) | (left & 1)) << 7 | ((middle & 1) << 4) |
        0b1110 | (right & 1);
    case 5:
      return ((middle & 0b110) | (left & 1)) << 7 |
        ((0b010 | (middle & 1)) << 4) | 0b1110 | (right & 1);
    case 3:
      return (left << 7) | ((0b100 | (middle & 1)) << 4) |
        0b1110 | (right & 1);
    case 7:
      return ((left & 1) << 7) | ((0b110 | (middle & 1)) << 4) |
        0b1110 | (right & 1);
    default:
      throw new Error("unreachable DPD digit classification");
  }
}

function decodeDpdDeclet(code: number): number {
  const pqr = (code >> 7) & 0b111;
  const stu = (code >> 4) & 0b111;
  const v = (code >> 3) & 1;
  const w = (code >> 2) & 1;
  const x = (code >> 1) & 1;
  const y = code & 1;
  let left: number;
  let middle: number;
  let right: number;

  // The published expansion table classifies operands by v/w/x then s/t.
  // Its final branch deliberately accepts the 24 redundant DPD encodings.
  if (v === 0) {
    left = pqr;
    middle = stu;
    right = code & 0b111;
  } else if (w === 0 && x === 0) {
    left = pqr;
    middle = stu;
    right = 8 + y;
  } else if (w === 0 && x === 1) {
    left = pqr;
    middle = 8 + ((code >> 4) & 1);
    right = (((code >> 6) & 1) << 2) | (((code >> 5) & 1) << 1) | y;
  } else if (w === 1 && x === 0) {
    left = 8 + ((code >> 7) & 1);
    middle = stu;
    right = (((code >> 9) & 1) << 2) | (((code >> 8) & 1) << 1) | y;
  } else {
    const st = (code >> 5) & 0b11;
    if (st === 0) {
      left = 8 + ((code >> 7) & 1);
      middle = 8 + ((code >> 4) & 1);
      right = (((code >> 9) & 1) << 2) | (((code >> 8) & 1) << 1) | y;
    } else if (st === 1) {
      left = 8 + ((code >> 7) & 1);
      middle = (((code >> 9) & 1) << 2) | (((code >> 8) & 1) << 1) |
        ((code >> 4) & 1);
      right = 8 + y;
    } else if (st === 2) {
      left = pqr;
      middle = 8 + ((code >> 4) & 1);
      right = 8 + y;
    } else {
      left = 8 + ((code >> 7) & 1);
      middle = 8 + ((code >> 4) & 1);
      right = 8 + y;
    }
  }

  return left * 100 + middle * 10 + right;
}

function encodeCoefficientContinuation(digits: string): bigint {
  let encoded = 0n;
  for (let index = 0; index < digits.length; index += 3) {
    const declet = Number.parseInt(digits.slice(index, index + 3), 10);
    encoded = (encoded << 10n) | BigInt(encodeDpdDeclet(declet));
  }
  return encoded;
}

function decodeCoefficientContinuation(bits: bigint, digitCount: number): string {
  const decletCount = digitCount / 3;
  const groups = Array<string>(decletCount);
  let remainder = bits;
  for (let index = decletCount - 1; index >= 0; index -= 1) {
    groups[index] = String(decodeDpdDeclet(Number(remainder & 0x3ffn))).padStart(3, "0");
    remainder >>= 10n;
  }
  return groups.join("");
}

function decimalText(value: DecimalFloatInput, path: string): string {
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return value.toString();
  }
  if (typeof value === "string" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `${path} expects a string, number, bigint, or decimal object`,
    );
  }
  const toString: unknown = value.toString;
  if (typeof toString !== "function") {
    throw new TypeError(
      `${path} expects a string, number, bigint, or decimal object`,
    );
  }
  const text: unknown = reflectApply(toString, value, []);
  if (typeof text !== "string") {
    throw new TypeError(`${path} decimal object's toString() must return a string`);
  }
  return text;
}

function trailingZeroCount(digits: string): number {
  let index = digits.length;
  while (index > 0 && digits[index - 1] === "0") index -= 1;
  return digits.length - index;
}

function parseSpecial(
  text: string,
  format: DecimalFloatFormat,
  path: string,
): SpecialDecimal | undefined {
  const infinity = /^([+-]?)(?:inf|infinity)$/iu.exec(text);
  if (infinity !== null) {
    return {
      negative: infinity[1] === "-",
      kind: "infinity",
      diagnostic: "",
    };
  }

  const nan = /^([+-]?)(s?nan)(\d*)$/iu.exec(text);
  if (nan === null) return undefined;
  const diagnostic = (nan[3] ?? "").replace(/^0+/u, "");
  const capacity = format.precision - 1;
  if (diagnostic.length > capacity) {
    throw new RangeError(`${path} exceeds its ${capacity}-digit NaN payload`);
  }
  return {
    negative: nan[1] === "-",
    kind: nan[2]!.toLowerCase() === "snan" ? "snan" : "nan",
    diagnostic,
  };
}

function parseFinite(
  text: string,
  format: DecimalFloatFormat,
  path: string,
): FiniteDecimal {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u
    .exec(text);
  if (match === null) throw new TypeError(`${path} expects a valid decimal`);

  const integer = match[2] ?? "";
  const fraction = match[2] === undefined ? match[4]! : (match[3] ?? "");
  const unpadded = `${integer}${fraction}`.replace(/^0+/u, "");
  let coefficient = unpadded.length === 0 ? "0" : unpadded;

  let explicitExponent: bigint;
  try {
    explicitExponent = BigInt(match[5] ?? "0");
  } catch {
    throw new RangeError(`${path} has an exponent too large to represent`);
  }
  let exponent = explicitExponent - BigInt(fraction.length);

  if (coefficient !== "0" && coefficient.length > format.precision) {
    const excessDigits = coefficient.length - format.precision;
    if (trailingZeroCount(coefficient) < excessDigits) {
      throw new RangeError(
        `${path} exceeds ${format.precision} significant digits without rounding`,
      );
    }
    coefficient = coefficient.slice(0, coefficient.length - excessDigits);
    exponent += BigInt(excessDigits);
  }

  const minimumExponent = BigInt(-format.exponentBias);
  const maximumEncodedExponent = 3n * (1n << BigInt(format.exponentContinuationBits)) - 1n;
  const maximumExponent = maximumEncodedExponent - BigInt(format.exponentBias);

  if (coefficient === "0") {
    if (exponent < minimumExponent) exponent = minimumExponent;
    if (exponent > maximumExponent) exponent = maximumExponent;
  } else if (exponent > maximumExponent) {
    const requiredZeros = exponent - maximumExponent;
    const availableDigits = BigInt(format.precision - coefficient.length);
    if (requiredZeros > availableDigits) {
      throw new RangeError(`${path} is outside ${format.label} range without rounding`);
    }
    coefficient += "0".repeat(Number(requiredZeros));
    exponent = maximumExponent;
  } else if (exponent < minimumExponent) {
    const requiredZeros = minimumExponent - exponent;
    const trailingZeros = trailingZeroCount(coefficient);
    if (requiredZeros > BigInt(trailingZeros)) {
      throw new RangeError(`${path} is outside ${format.label} range without rounding`);
    }
    coefficient = coefficient.slice(0, coefficient.length - Number(requiredZeros));
    exponent = minimumExponent;
  }

  return {
    negative: match[1] === "-",
    coefficient,
    exponent: Number(exponent),
  };
}

function writeLittleEndian(value: bigint, byteLength: number): Buffer {
  const result = Buffer.alloc(byteLength);
  let remainder = value;
  for (let index = 0; index < byteLength; index += 1) {
    result[index] = Number(remainder & 0xffn);
    remainder >>= 8n;
  }
  return result;
}

function readLittleEndian(value: Uint8Array): bigint {
  let result = 0n;
  for (let index = value.byteLength - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(value[index]!);
  }
  return result;
}

function encodeSpecial(value: SpecialDecimal, format: DecimalFloatFormat): Buffer {
  const totalBits = format.byteLength * 8;
  const sign = value.negative ? 1n << BigInt(totalBits - 1) : 0n;
  const combinationShift = BigInt(totalBits - 6);
  if (value.kind === "infinity") {
    return writeLittleEndian(sign | (0b11110n << combinationShift), format.byteLength);
  }

  const diagnosticDigits = value.diagnostic.padStart(format.precision - 1, "0");
  const diagnostic = encodeCoefficientContinuation(diagnosticDigits);
  const signaling = value.kind === "snan"
    ? 1n << BigInt(
      format.coefficientContinuationBits + format.exponentContinuationBits - 1,
    )
    : 0n;
  return writeLittleEndian(
    sign | (0b11111n << combinationShift) | signaling | diagnostic,
    format.byteLength,
  );
}

function encodeDecimalFloat(
  value: DecimalFloatInput,
  format: DecimalFloatFormat,
  path: string,
): Buffer {
  const text = decimalText(value, path);
  if (text.length > MAX_DECIMAL_FLOAT_TEXT_LENGTH) {
    throw new RangeError(
      `${path} decimal text exceeds ${MAX_DECIMAL_FLOAT_TEXT_LENGTH} characters`,
    );
  }
  const special = parseSpecial(text, format, path);
  if (special !== undefined) return encodeSpecial(special, format);
  const finite = parseFinite(text, format, path);
  const digits = finite.coefficient.padStart(format.precision, "0");
  const mostSignificantDigit = Number(digits[0]!);
  const coefficientContinuation = encodeCoefficientContinuation(digits.slice(1));
  const encodedExponent = finite.exponent + format.exponentBias;
  const exponentMostSignificant = encodedExponent >> format.exponentContinuationBits;
  const exponentContinuationMask = (1 << format.exponentContinuationBits) - 1;
  const exponentContinuation = encodedExponent & exponentContinuationMask;
  const combination = mostSignificantDigit <= 7
    ? (exponentMostSignificant << 3) | mostSignificantDigit
    : 0b11000 | (exponentMostSignificant << 1) | (mostSignificantDigit - 8);
  const totalBits = format.byteLength * 8;
  const sign = finite.negative ? 1n << BigInt(totalBits - 1) : 0n;
  const encoded = sign |
    (BigInt(combination) << BigInt(totalBits - 6)) |
    (BigInt(exponentContinuation) << BigInt(format.coefficientContinuationBits)) |
    coefficientContinuation;
  return writeLittleEndian(encoded, format.byteLength);
}

function formatFinite(negative: boolean, coefficient: string, exponent: number): string {
  const digits = coefficient.replace(/^0+/u, "") || "0";
  const adjustedExponent = exponent + digits.length - 1;
  let body: string;
  if (exponent <= 0 && adjustedExponent >= -6) {
    if (exponent === 0) {
      body = digits;
    } else {
      const point = digits.length + exponent;
      body = point > 0
        ? `${digits.slice(0, point)}.${digits.slice(point)}`
        : `0.${"0".repeat(-point)}${digits}`;
    }
  } else {
    const significand = digits.length === 1
      ? digits
      : `${digits[0]}.${digits.slice(1)}`;
    body = `${significand}E${adjustedExponent >= 0 ? "+" : ""}${adjustedExponent}`;
  }
  return `${negative ? "-" : ""}${body}`;
}

function decodeDecimalFloat(
  value: Uint8Array,
  format: DecimalFloatFormat,
  path: string,
): string {
  if (!(value instanceof Uint8Array)) {
    throw new RangeError(`${path} expects exactly ${format.byteLength} bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength !== format.byteLength) {
    throw new RangeError(`${path} expects exactly ${format.byteLength} bytes`);
  }
  const snapshot = snapshotUint8Array(value, path, byteLength);
  const encoded = readLittleEndian(snapshot);
  const totalBits = format.byteLength * 8;
  const negative = ((encoded >> BigInt(totalBits - 1)) & 1n) === 1n;
  const combination = Number((encoded >> BigInt(totalBits - 6)) & 0b11111n);
  const coefficientMask = (1n << BigInt(format.coefficientContinuationBits)) - 1n;
  const coefficientContinuation = encoded & coefficientMask;

  if (combination === 0b11110) {
    return `${negative ? "-" : ""}Infinity`;
  }
  if (combination === 0b11111) {
    const signalingBit = BigInt(
      format.coefficientContinuationBits + format.exponentContinuationBits - 1,
    );
    const signaling = ((encoded >> signalingBit) & 1n) === 1n;
    const diagnostic = decodeCoefficientContinuation(
      coefficientContinuation,
      format.precision - 1,
    ).replace(/^0+/u, "");
    return `${negative ? "-" : ""}${signaling ? "sNaN" : "NaN"}${diagnostic}`;
  }

  let exponentMostSignificant: number;
  let mostSignificantDigit: number;
  if (combination < 0b11000) {
    exponentMostSignificant = combination >> 3;
    mostSignificantDigit = combination & 0b111;
  } else {
    exponentMostSignificant = (combination >> 1) & 0b11;
    mostSignificantDigit = 8 + (combination & 1);
  }
  const exponentContinuationMask = (1n << BigInt(format.exponentContinuationBits)) - 1n;
  const exponentContinuation = Number(
    (encoded >> BigInt(format.coefficientContinuationBits)) & exponentContinuationMask,
  );
  const exponent = (exponentMostSignificant << format.exponentContinuationBits) |
    exponentContinuation;
  const coefficient = `${mostSignificantDigit}${decodeCoefficientContinuation(
    coefficientContinuation,
    format.precision - 1,
  )}`;
  return formatFinite(negative, coefficient, exponent - format.exponentBias);
}

/** Encode an exact IEEE 754 decimal64 DPD value in SAP's little-endian DECF16 form. */
export function encodeDecimalFloat16(
  value: DecimalFloatInput,
  path = "DECF16",
): Buffer {
  return encodeDecimalFloat(value, DECF16, path);
}

/** Decode SAP DECF16 to node-rfc's precision-preserving string representation. */
export function decodeDecimalFloat16(
  value: Uint8Array,
  path = "DECF16",
): string {
  return decodeDecimalFloat(value, DECF16, path);
}

/** Encode an exact IEEE 754 decimal128 DPD value in SAP's little-endian DECF34 form. */
export function encodeDecimalFloat34(
  value: DecimalFloatInput,
  path = "DECF34",
): Buffer {
  return encodeDecimalFloat(value, DECF34, path);
}

/** Decode SAP DECF34 to node-rfc's precision-preserving string representation. */
export function decodeDecimalFloat34(
  value: Uint8Array,
  path = "DECF34",
): string {
  return decodeDecimalFloat(value, DECF34, path);
}
