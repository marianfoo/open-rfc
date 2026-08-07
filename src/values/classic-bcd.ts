/** Callable node-rfc projection for ABAP BCD and decimal-float outputs. */
export type ClassicBcdConverter = (value: string) => unknown;

/** JavaScript representation selected for ABAP BCD and DECF16/DECF34 values. */
export type ClassicBcdMode = "string" | "number" | ClassicBcdConverter;

/**
 * Marks an exception thrown by caller-owned conversion code after the complete
 * RFC reply has already been consumed. Transport layers use this distinction
 * to keep the otherwise healthy connection reusable.
 */
export class ClassicBcdConversionError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`BCD output conversion failed at ${path}`, { cause });
    this.name = "ClassicBcdConversionError";
    this.path = path;
  }
}

/** Capture the archived node-rfc BCD option without invoking caller code. */
export function snapshotClassicBcdMode(
  value: unknown,
  label = "bcd",
): ClassicBcdMode {
  if (value === undefined) return "string";
  if (value === "string" || value === "number" || typeof value === "function") {
    return value as ClassicBcdMode;
  }
  throw new TypeError(`${label} must be "string", "number", or a function`);
}

/**
 * Project one already-validated canonical decimal string. Custom converters
 * are ordinary function calls, matching the archived binding; constructor-only
 * ES classes therefore fail in the same way as any other non-callable hook.
 */
export function projectClassicBcdOutput(
  value: string,
  mode: ClassicBcdMode,
  path = "BCD",
): unknown {
  if (mode === "string") return value;
  if (mode === "number") return Number(value);
  try {
    return Reflect.apply(mode, undefined, [value]);
  } catch (cause) {
    throw new ClassicBcdConversionError(path, cause);
  }
}
