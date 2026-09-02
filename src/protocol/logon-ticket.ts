// Adapted and hardened for TypeScript from open-rfc-go's Apache-2.0
// internal/cpic/ticket.go at commit
// 92d5d8f6e0a08ff7ac1580f461585cbde2a56939.

/** Bound one canonical MYSAPSSO2 value before UTF-16LE expansion. */
export const DEFAULT_MAX_RFC_LOGON_TICKET_LENGTH = 16 * 1024;

function configuredMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_RFC_LOGON_TICKET_LENGTH;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > DEFAULT_MAX_RFC_LOGON_TICKET_LENGTH
  ) {
    throw new RangeError(
      `maxLength must be an integer in 1..${DEFAULT_MAX_RFC_LOGON_TICKET_LENGTH}`,
    );
  }
  return maximum;
}

/**
 * Convert canonical, cookie-substituted, or percent-escaped MYSAPSSO2 text to
 * canonical base64 without treating a literal `+` as form-encoded whitespace.
 */
export function normalizeRfcLogonTicket(
  input: string,
  options: { readonly maxLength?: number } = {},
): string {
  if (typeof input !== "string") {
    throw new TypeError("mysapsso2 must be a string");
  }
  const maximum = configuredMaximum(options.maxLength);
  if (input.length > maximum * 3 + 2) {
    throw new RangeError(`mysapsso2 exceeds ${maximum} canonical ASCII bytes`);
  }

  let normalized = input.trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    throw new RangeError("mysapsso2 contains invalid percent encoding");
  }
  normalized = normalized.replaceAll("!", "/");

  if (normalized.length < 1 || normalized.length > maximum) {
    throw new RangeError(`mysapsso2 must contain 1..${maximum} canonical ASCII bytes`);
  }
  const paddingLength = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=") ? 1 : 0;
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) ||
    normalized.length % 4 === 1 ||
    (paddingLength > 0 && normalized.length % 4 !== 0)
  ) {
    throw new RangeError("mysapsso2 must contain canonical base64 ticket text");
  }
  return normalized;
}

/** Encode one validated SAP logon ticket as the UTF-16LE CPIC field value. */
export function encodeRfcLogonTicket(
  input: string,
  options: { readonly maxLength?: number } = {},
): Buffer {
  return Buffer.from(normalizeRfcLogonTicket(input, options), "utf16le");
}
