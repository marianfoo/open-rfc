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
 * Decode the XML reference starting at `raw[start]`, which must be `&`, and
 * report the code point together with the consumed reference length.
 *
 * The admitted grammar is the whole XML 1.0 reference grammar: the five
 * predefined named entities plus decimal `&#N;` and hexadecimal `&#xH;`
 * character references of any legal width. Our writers emit a narrow canonical
 * subset of that grammar, but a producer following the specification may send
 * any of it, so the readers accept all of it. Digit runs are bounded so a long
 * reference cannot become a decode cost, and the result is guaranteed to be a
 * Unicode scalar. Callers apply their own code-point policy on top.
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
    const digits = body.slice(2);
    if (!/^[0-9A-Fa-f]{1,6}$/u.test(digits)) {
      throw new Error(`${path} contains an unsupported XML entity`);
    }
    codePoint = Number.parseInt(digits, 16);
  } else {
    const digits = body.slice(1);
    if (!/^[0-9]{1,7}$/u.test(digits)) {
      throw new Error(`${path} contains an unsupported XML entity`);
    }
    codePoint = Number.parseInt(digits, 10);
  }
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw new Error(`${path} contains an out-of-range XML entity`);
  }
  return { codePoint, length: semicolon + 1 - start };
}
