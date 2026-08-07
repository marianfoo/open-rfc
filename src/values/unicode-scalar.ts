/** Reject isolated UTF-16 surrogates without normalizing valid scalar text. */
export function assertUnicodeScalarText(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new RangeError(`${path} contains an isolated surrogate code unit`);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new RangeError(`${path} contains an isolated surrogate code unit`);
    }
  }
}

/** Reject NUL where the classic wire uses NUL as a value terminator. */
export function assertNulFreeUnicodeScalarText(
  value: string,
  path: string,
): void {
  assertUnicodeScalarText(value, path);
  if (value.includes("\0")) {
    throw new RangeError(`${path} contains NUL`);
  }
}

/** The five entities XML predefines; `&amp;` and `&lt;` are mandatory escapes. */
const NAMED_XML_ENTITY_CODE_POINTS = new Map([
  ["amp", 0x26],
  ["lt", 0x3c],
  ["gt", 0x3e],
  ["quot", 0x22],
  ["apos", 0x27],
]);

/**
 * A character reference may carry any number of digits: XML 1.0 spells both
 * forms with `+`, so zero padding is a spelling choice and not a different
 * reference. These patterns therefore bound the raw run only, far above any
 * deliberate spelling, so that a very long run cannot become a parse cost. What
 * the reference actually denotes is decided by its value, below.
 */
const MAXIMUM_CHARACTER_REFERENCE_RUN = 32;
const DECIMAL_RUN = /^[0-9]+$/u;
const HEXADECIMAL_RUN = /^[0-9A-Fa-f]+$/u;

/** Value of one character reference digit run, ignoring how it is padded. */
function characterReferenceValue(
  digits: string,
  radix: number,
  run: RegExp,
  path: string,
): number {
  if (digits.length > MAXIMUM_CHARACTER_REFERENCE_RUN || !run.test(digits)) {
    throw new Error(`${path} contains an unsupported XML entity`);
  }
  // An all-zero run denotes U+0000 rather than nothing, so keep one digit. Our
  // own writers emit `&#00;`, and the readers admit C0 controls in reference
  // position, so this path is exercised by ordinary round-trips.
  const significant = digits.replace(/^0+/u, "") || "0";
  return Number.parseInt(significant, radix);
}

/**
 * Decode the XML reference starting at `raw[start]`, which must be `&`, and
 * report the code point together with the consumed reference length.
 *
 * The admitted grammar is the whole XML 1.0 reference grammar: the five
 * predefined named entities plus decimal `&#N;` and hexadecimal `&#xH;`
 * character references of any legal width. Our writers emit a narrow canonical
 * subset of that grammar, but a producer following the specification may send
 * any of it, so the readers accept all of it. Digit runs are bounded so a long
 * reference cannot become a decode cost, zero padding is transparent, and the
 * result is guaranteed to be a Unicode scalar. Callers apply their own
 * code-point policy on top.
 */
export function decodeXmlEntityReference(
  raw: string,
  start: number,
  path: string,
): { codePoint: number; length: number } {
  const semicolon = raw.indexOf(";", start + 1);
  if (semicolon < 0) throw new Error(`${path} contains a truncated XML entity`);
  const body = raw.slice(start + 1, semicolon);
  let codePoint: number;
  if (body.length === 0) {
    throw new Error(`${path} contains an empty XML entity`);
  } else if (body[0] !== "#") {
    const named = NAMED_XML_ENTITY_CODE_POINTS.get(body);
    if (named === undefined) {
      throw new Error(`${path} contains an unsupported XML entity`);
    }
    codePoint = named;
  } else if (body[1] === "x") {
    codePoint = characterReferenceValue(body.slice(2), 16, HEXADECIMAL_RUN, path);
  } else {
    codePoint = characterReferenceValue(body.slice(1), 10, DECIMAL_RUN, path);
  }
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw new Error(`${path} contains an out-of-range XML entity`);
  }
  return { codePoint, length: semicolon + 1 - start };
}
