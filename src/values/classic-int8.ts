/** Exact JavaScript representation selected for an ABAP signed INT8 value. */
export type ClassicInt8Mode = "number" | "bigint" | "string";

export type ClassicInt8Value = number | bigint | string;

const INT8_MIN = -(1n << 63n);
const INT8_MAX = (1n << 63n) - 1n;
const CANONICAL_SIGNED_DECIMAL = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;

/** Capture an untrusted option once; the core defaults to exact bigint values. */
export function snapshotClassicInt8Mode(
  value: unknown,
  label = "int8Mode",
): ClassicInt8Mode {
  if (value === undefined) return "bigint";
  if (value === "number" || value === "bigint" || value === "string") {
    return value;
  }
  throw new TypeError(`${label} must be number, bigint, or string`);
}

function assertSignedInt8(value: bigint, path: string): bigint {
  if (value < INT8_MIN || value > INT8_MAX) {
    throw new RangeError(`${path} expects a signed 64-bit integer`);
  }
  return value;
}

/** Normalize one mode-specific caller value to the exact wire integer. */
export function encodeClassicInt8(
  value: unknown,
  mode: ClassicInt8Mode,
  path = "INT8",
): bigint {
  switch (mode) {
    case "number":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new RangeError(`${path} expects a safe integer number in number mode`);
      }
      return assertSignedInt8(BigInt(value), path);
    case "bigint": {
      const normalized = typeof value === "bigint"
        ? value
        : typeof value === "number" && Number.isSafeInteger(value)
          ? BigInt(value)
          : undefined;
      if (normalized === undefined) {
        throw new RangeError(`${path} expects a signed 64-bit integer`);
      }
      return assertSignedInt8(normalized, path);
    }
    case "string":
      if (
        typeof value !== "string" ||
        value.length > 20 ||
        !CANONICAL_SIGNED_DECIMAL.test(value)
      ) {
        throw new TypeError(`${path} expects a canonical signed decimal string in string mode`);
      }
      return assertSignedInt8(BigInt(value), path);
  }
}

/** Project one exact wire integer without allowing silent precision loss. */
export function decodeClassicInt8(
  value: bigint,
  mode: ClassicInt8Mode,
  path = "INT8",
): ClassicInt8Value {
  const normalized = assertSignedInt8(value, path);
  switch (mode) {
    case "bigint":
      return normalized;
    case "string":
      return normalized.toString();
    case "number": {
      const projected = Number(normalized);
      if (!Number.isSafeInteger(projected)) {
        throw new RangeError(
          `${path} INT8 result exceeds JavaScript's safe integer range; ` +
            "use bigint or string mode",
        );
      }
      return projected;
    }
  }
}

/** Mode-correct ABAP initial value. */
export function classicInt8InitialValue(mode: ClassicInt8Mode): ClassicInt8Value {
  switch (mode) {
    case "number":
      return 0;
    case "bigint":
      return 0n;
    case "string":
      return "0";
  }
}
