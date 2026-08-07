import { TextDecoder } from "node:util";

import { marked } from "marked";
import { parseFragment } from "parse5";

const README_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_README_BYTES = 512 * 1024;
const MAX_APPROVED_HTTPS_TARGETS = 64;
const MAX_HTML_ATTRIBUTES = 256;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const EMAIL_AUTOLINK = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/u;
const HTML_URL_ATTRIBUTE_NAMES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const ACTIVE_HTML_ATTRIBUTE_NAMES = new Set([
  "archive",
  "attributionsrc",
  "classid",
  "clip-path",
  "codebase",
  "cursor",
  "dynsrc",
  "fill",
  "filter",
  "http-equiv",
  "imagesrcset",
  "longdesc",
  "lowsrc",
  "manifest",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "ping",
  "profile",
  "srcdoc",
  "stroke",
  "style",
  "usemap",
]);

// Public package documentation is intentionally restricted to the exact,
// project-owned Pages root. Keep this list byte-exact: admitting a host or path
// prefix would make the packed README policy broader than the reviewed link.
export const OPEN_RFC_PACKAGED_README_HTTPS_TARGETS = Object.freeze([
  "https://marianfoo.github.io/open-rfc/",
]);

export class PackagedReadmeLinkError extends Error {
  constructor(message) {
    super(`packaged README: ${message}`);
    this.name = "PackagedReadmeLinkError";
  }
}

function fail(message) {
  throw new PackagedReadmeLinkError(message);
}

function lineNumber(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function syntaxFailure(source, index, kind) {
  fail(`line ${lineNumber(source, index)} contains ${kind}`);
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function decodeHtmlEntities(value, source, index) {
  return value.replaceAll(/&(?:#(?:x[0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]+);/gu, (entity) => {
    const named = new Map([
      ["&amp;", "&"],
      ["&apos;", "'"],
      ["&colon;", ":"],
      ["&gt;", ">"],
      ["&lt;", "<"],
      ["&quot;", "\""],
      ["&sol;", "/"],
    ]);
    if (named.has(entity)) return named.get(entity);
    if (!entity.startsWith("&#")) {
      syntaxFailure(source, index, "an unsupported HTML entity in a link target");
    }
    const hexadecimal = entity[2]?.toLowerCase() === "x";
    const digits = entity.slice(hexadecimal ? 3 : 2, -1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (
      !Number.isSafeInteger(codePoint) ||
      codePoint < 1 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      syntaxFailure(source, index, "an invalid HTML entity in a link target");
    }
    return String.fromCodePoint(codePoint);
  });
}

function repeatedlyDecodePercent(value, source, index) {
  let decoded = value;
  for (let pass = 0; pass < 8; pass += 1) {
    if (!decoded.includes("%")) return decoded;
    if (/%(?![0-9A-Fa-f]{2})/u.test(decoded)) {
      syntaxFailure(source, index, "a malformed percent escape in a link target");
    }
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      syntaxFailure(source, index, "a non-UTF-8 percent escape in a link target");
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  if (decoded.includes("%")) {
    syntaxFailure(source, index, "an excessively encoded link target");
  }
  return decoded;
}

function assertNoTargetAmbiguity(target, source, index) {
  if (
    target.length === 0 ||
    target.length > 4096 ||
    /[\u0000-\u0020\u007f]/u.test(target) ||
    target.includes("\\")
  ) {
    syntaxFailure(source, index, "an empty or ambiguous link target");
  }
  const decoded = repeatedlyDecodePercent(target, source, index);
  if (/[\u0000-\u0020\u007f]/u.test(decoded) || decoded.includes("\\")) {
    syntaxFailure(source, index, "an encoded control or backslash in a link target");
  }
  const withoutAuthority = decoded.replace(
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/u,
    "",
  );
  const lexicalPath = withoutAuthority.split(/[?#]/u, 1)[0];
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(lexicalPath)) {
    syntaxFailure(source, index, "a literal or encoded traversal link target");
  }
  return decoded;
}

function approvedHttpsSet(values) {
  if (!Array.isArray(values) || values.length > MAX_APPROVED_HTTPS_TARGETS) {
    fail("approvedHttpsTargets must be a bounded array");
  }
  const approved = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || approved.has(value)) {
      fail("approvedHttpsTargets must contain unique non-empty strings");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      fail("approvedHttpsTargets contains an invalid URL");
    }
    if (
      !value.startsWith("https://") ||
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      fail("approvedHttpsTargets may contain only credential-free HTTPS URLs");
    }
    assertNoTargetAmbiguity(value, value, 0);
    approved.add(value);
  }
  return approved;
}

function validateTarget(
  rawTarget,
  source,
  index,
  approved,
  referencedFragments = undefined,
  targetRanges = undefined,
) {
  if (typeof rawTarget !== "string") {
    syntaxFailure(source, index, "a non-text link target");
  }
  const target = decodeHtmlEntities(rawTarget, source, index);
  targetRanges?.push(Object.freeze({ start: index, end: index + rawTarget.length }));
  const decoded = assertNoTargetAmbiguity(target, source, index);
  if (decoded.startsWith("#")) {
    if (decoded.length === 1 || decoded.includes("#", 1)) {
      syntaxFailure(source, index, "a malformed same-document fragment");
    }
    referencedFragments?.push(Object.freeze({
      id: decoded.slice(1),
      index,
    }));
    return "fragment";
  }
  if (target.toLowerCase().startsWith("https:")) {
    let url;
    try {
      url = new URL(target);
    } catch {
      syntaxFailure(source, index, "an invalid HTTPS link target");
    }
    if (
      !target.startsWith("https://") ||
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      syntaxFailure(source, index, "an ambiguous HTTPS link target");
    }
    if (!approved.has(target)) {
      syntaxFailure(source, index, "an HTTPS target absent from the explicit allowlist");
    }
    return "https";
  }
  if (URI_SCHEME.test(target)) {
    syntaxFailure(source, index, "a link target using an unsupported URI scheme");
  }
  syntaxFailure(source, index, "a local, relative, or absolute-path link target");
}

function maskIgnoredMarkdown(source, { inlineCode = true } = {}) {
  const characters = source.split("");
  let fence = null;
  let offset = 0;
  for (const line of source.split(/(?<=\n)/u)) {
    const content = line.endsWith("\n") ? line.slice(0, -1) : line;
    const match = content.match(/^[ \t]{0,3}(`{3,}|~{3,})/u);
    let marker = match?.[1];
    if (
      fence === null &&
      marker?.[0] === "`" &&
      content.slice(match[0].length).includes("`")
    ) marker = undefined;
    const closes =
      fence !== null &&
      marker !== undefined &&
      marker[0] === fence.character &&
      marker.length >= fence.length &&
      content.slice(match[0].length).trim().length === 0;
    if (fence !== null || marker !== undefined) {
      for (let cursor = offset; cursor < offset + content.length; cursor += 1) {
        characters[cursor] = " ";
      }
    }
    if (fence === null && marker !== undefined) {
      fence = { character: marker[0], length: marker.length };
    } else if (closes) {
      fence = null;
    }
    offset += line.length;
  }

  if (inlineCode) {
    const masked = characters.join("");
    for (let cursor = 0; cursor < masked.length;) {
      if (masked[cursor] !== "`" || isEscaped(masked, cursor)) {
        cursor += 1;
        continue;
      }
      let length = 1;
      while (masked[cursor + length] === "`") length += 1;
      let end = -1;
      for (let search = cursor + length; search < masked.length;) {
        const candidate = masked.indexOf("`", search);
        if (candidate < 0) break;
        let candidateLength = 1;
        while (masked[candidate + candidateLength] === "`") candidateLength += 1;
        if (candidateLength === length) {
          end = candidate;
          break;
        }
        search = candidate + candidateLength;
      }
      if (end < 0) {
        cursor += length;
        continue;
      }
      for (let index = cursor; index < end + length; index += 1) {
        if (characters[index] !== "\n") characters[index] = " ";
      }
      cursor = end + length;
    }
  }

  const commentSource = characters.join("");
  let commentStart = commentSource.indexOf("<!--");
  while (commentStart >= 0) {
    const closing = commentSource.indexOf("-->", commentStart + 4);
    const end = closing < 0 ? commentSource.length : closing + 3;
    for (let index = commentStart; index < end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
    commentStart = commentSource.indexOf("<!--", end);
  }
  return characters.join("");
}

function closingDelimiter(source, start, delimiter) {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === delimiter && !isEscaped(source, cursor)) return cursor;
    if (source[cursor] === "\n") return -1;
  }
  return -1;
}

function parseOptionalTitleAndClose(source, cursor, index) {
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] === ")") return cursor + 1;
  const opener = source[cursor];
  const closer = opener === "(" ? ")" : opener;
  if (opener !== "\"" && opener !== "'" && opener !== "(") {
    syntaxFailure(source, index, "a malformed inline Markdown link");
  }
  const titleEnd = closingDelimiter(source, cursor + 1, closer);
  if (titleEnd < 0) syntaxFailure(source, index, "an unterminated Markdown link title");
  cursor = titleEnd + 1;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] !== ")") {
    syntaxFailure(source, index, "a malformed inline Markdown link closure");
  }
  return cursor + 1;
}

function parseInlineDestination(
  source,
  opening,
  approved,
  referencedFragments,
  targetRanges,
) {
  let cursor = opening + 1;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  const targetStart = cursor;
  let target;
  if (source[cursor] === "<") {
    const end = closingDelimiter(source, cursor + 1, ">");
    if (end < 0) syntaxFailure(source, opening, "an unterminated angle link target");
    target = source.slice(cursor + 1, end);
    cursor = end + 1;
  } else {
    let depth = 0;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "\\") {
        syntaxFailure(source, cursor, "a backslash in a link target");
      }
      if (character === "(" && !isEscaped(source, cursor)) {
        depth += 1;
        if (depth > 32) syntaxFailure(source, opening, "an excessively nested link target");
      } else if (character === ")" && !isEscaped(source, cursor)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/u.test(character) && depth === 0) {
        break;
      }
    }
    target = source.slice(targetStart, cursor);
  }
  validateTarget(
    target,
    source,
    targetStart,
    approved,
    referencedFragments,
    targetRanges,
  );
  return parseOptionalTitleAndClose(source, cursor, opening);
}

function normalizeReferenceLabel(value) {
  return value.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function parseReferenceDefinitions(
  source,
  approved,
  referencedFragments,
  targetRanges,
) {
  const references = new Map();
  const characters = source.split("");
  let offset = 0;
  for (const lineWithEnding of source.split(/(?<=\n)/u)) {
    const line = lineWithEnding.endsWith("\n")
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding;
    const definition = line.match(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(.*)$/u);
    if (definition === null) {
      offset += lineWithEnding.length;
      continue;
    }
    const label = normalizeReferenceLabel(definition[1]);
    if (label.length === 0 || references.has(label)) {
      syntaxFailure(source, offset, "an empty or duplicate reference definition");
    }
    const remainder = definition[2];
    const remainderOffset = offset + line.indexOf(remainder);
    let cursor = 0;
    let target;
    if (remainder[cursor] === "<") {
      const end = closingDelimiter(remainder, cursor + 1, ">");
      if (end < 0) syntaxFailure(source, remainderOffset, "an unterminated reference target");
      target = remainder.slice(1, end);
      cursor = end + 1;
    } else {
      while (cursor < remainder.length && !/\s/u.test(remainder[cursor])) cursor += 1;
      target = remainder.slice(0, cursor);
    }
    validateTarget(
      target,
      source,
      remainderOffset,
      approved,
      referencedFragments,
      targetRanges,
    );
    while (/\s/u.test(remainder[cursor] ?? "")) cursor += 1;
    if (cursor < remainder.length) {
      const opener = remainder[cursor];
      const closer = opener === "(" ? ")" : opener;
      if (opener !== "\"" && opener !== "'" && opener !== "(") {
        syntaxFailure(source, remainderOffset + cursor, "a malformed reference title");
      }
      const end = closingDelimiter(remainder, cursor + 1, closer);
      if (end < 0 || remainder.slice(end + 1).trim().length > 0) {
        syntaxFailure(source, remainderOffset + cursor, "a malformed reference title");
      }
    }
    references.set(label, target);
    for (let index = offset; index < offset + line.length; index += 1) {
      characters[index] = " ";
    }
    offset += lineWithEnding.length;
  }
  return { source: characters.join(""), references };
}

function labelBefore(source, closing) {
  let depth = 0;
  for (let cursor = closing - 1; cursor >= 0; cursor -= 1) {
    if (source[cursor] === "]" && !isEscaped(source, cursor)) depth += 1;
    if (source[cursor] === "[" && !isEscaped(source, cursor)) {
      if (depth === 0) return source.slice(cursor + 1, closing);
      depth -= 1;
    }
    if (source[cursor] === "\n" && depth === 0) return null;
  }
  return null;
}

function scanMarkdownLinks(
  source,
  references,
  approved,
  referencedFragments,
  targetRanges,
) {
  let targetCount = references.size;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== "]" || isEscaped(source, cursor)) continue;
    if (source[cursor + 1] === "(") {
      cursor = parseInlineDestination(
        source,
        cursor + 1,
        approved,
        referencedFragments,
        targetRanges,
      ) - 1;
      targetCount += 1;
      continue;
    }
    if (source[cursor + 1] !== "[") continue;
    const referenceEnd = closingDelimiter(source, cursor + 2, "]");
    if (referenceEnd < 0) {
      syntaxFailure(source, cursor, "an unterminated Markdown reference usage");
    }
    const explicit = source.slice(cursor + 2, referenceEnd);
    const label = explicit.length > 0 ? explicit : labelBefore(source, cursor);
    if (label === null || !references.has(normalizeReferenceLabel(label))) {
      syntaxFailure(source, cursor, "an undefined Markdown reference usage");
    }
    targetCount += 1;
    cursor = referenceEnd;
  }
  return targetCount;
}

function htmlTagEnd(source, opening) {
  let quote = null;
  for (let cursor = opening + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return cursor;
  }
  syntaxFailure(source, opening, "an unterminated raw HTML tag or autolink");
}

function explicitAnchorId(rawValue, source, index) {
  const value = decodeHtmlEntities(rawValue, source, index);
  if (
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    syntaxFailure(source, index, "an empty or ambiguous explicit anchor ID");
  }
  return value;
}

function parseRawHtmlTag(
  source,
  opening,
  closing,
  approved,
  referencedFragments,
  targetRanges,
) {
  const content = source.slice(opening + 1, closing);
  let cursor = 0;
  let closingTag = false;
  if (content[cursor] === "/") {
    closingTag = true;
    cursor += 1;
  }
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/u.test(content[cursor] ?? "")) cursor += 1;
  const tagName = content.slice(nameStart, cursor).toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/u.test(tagName)) {
    return Object.freeze({ anchors: Object.freeze([]), targetCount: 0 });
  }
  if (closingTag) {
    if (content.slice(cursor).trim().length > 0) {
      syntaxFailure(source, opening, "a malformed closing HTML tag");
    }
    return Object.freeze({ anchors: Object.freeze([]), targetCount: 0 });
  }

  const attributes = new Set();
  const anchors = [];
  let attributeCount = 0;
  let targetCount = 0;
  while (cursor < content.length) {
    while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
    if (cursor >= content.length) break;
    if (content[cursor] === "/" && content.slice(cursor + 1).trim().length === 0) {
      break;
    }
    const attributeStart = cursor;
    while (
      cursor < content.length &&
      !/[\s=/>]/u.test(content[cursor])
    ) cursor += 1;
    const rawName = content.slice(attributeStart, cursor);
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(rawName)) {
      syntaxFailure(source, opening + 1 + attributeStart, "a malformed HTML attribute name");
    }
    const name = rawName.toLowerCase();
    if (name.startsWith("on") || ACTIVE_HTML_ATTRIBUTE_NAMES.has(name)) {
      syntaxFailure(source, opening + 1 + attributeStart, "an active HTML attribute");
    }
    attributeCount += 1;
    if (attributeCount > MAX_HTML_ATTRIBUTES) {
      syntaxFailure(source, opening, "too many HTML attributes");
    }
    if (attributes.has(name)) {
      syntaxFailure(source, opening + 1 + attributeStart, "a duplicate HTML attribute");
    }
    attributes.add(name);
    while (/\s/u.test(content[cursor] ?? "")) cursor += 1;

    let value;
    let valueOffset = cursor;
    if (content[cursor] === "=") {
      cursor += 1;
      while (/\s/u.test(content[cursor] ?? "")) cursor += 1;
      valueOffset = cursor;
      const quote = content[cursor];
      if (quote === "\"" || quote === "'") {
        const valueStart = cursor + 1;
        const end = content.indexOf(quote, valueStart);
        if (end < 0) {
          syntaxFailure(source, opening + 1 + valueOffset, "an unterminated HTML attribute value");
        }
        value = content.slice(valueStart, end);
        valueOffset = valueStart;
        cursor = end + 1;
      } else {
        const valueStart = cursor;
        while (cursor < content.length && !/\s/u.test(content[cursor])) {
          if (/["'<=`]/u.test(content[cursor] ?? "")) {
            syntaxFailure(source, opening + 1 + cursor, "a malformed unquoted HTML attribute value");
          }
          cursor += 1;
        }
        value = content.slice(valueStart, cursor);
        valueOffset = valueStart;
      }
      if (value.length === 0) {
        syntaxFailure(source, opening + 1 + valueOffset, "an empty HTML attribute value");
      }
    }

    const absoluteValueOffset = opening + 1 + valueOffset;
    if (HTML_URL_ATTRIBUTE_NAMES.has(name)) {
      if (value === undefined) {
        syntaxFailure(source, opening + 1 + attributeStart, "a malformed HTML URL attribute");
      }
      if (name === "srcset") {
        syntaxFailure(source, opening + 1 + attributeStart, "an unsupported HTML srcset attribute");
      }
      if (name !== "href" && name !== "src") {
        syntaxFailure(source, opening + 1 + attributeStart, `an unsupported HTML ${name} attribute`);
      }
      validateTarget(
        value,
        source,
        absoluteValueOffset,
        approved,
        referencedFragments,
        targetRanges,
      );
      targetCount += 1;
    }
    if ((name === "id" || name === "name") && value !== undefined) {
      anchors.push(Object.freeze({
        id: explicitAnchorId(value, source, absoluteValueOffset),
        index: absoluteValueOffset,
      }));
    }
  }
  return Object.freeze({ anchors: Object.freeze(anchors), targetCount });
}

function scanHtmlAndAutolinks(
  source,
  approved,
  referencedFragments,
  targetRanges,
) {
  const anchors = [];
  const tagRanges = [];
  let targetCount = 0;
  for (let opening = source.indexOf("<"); opening >= 0;) {
    const closing = htmlTagEnd(source, opening);
    tagRanges.push(Object.freeze({ start: opening, end: closing + 1 }));
    const content = source.slice(opening + 1, closing);
    if (URI_SCHEME.test(content) || EMAIL_AUTOLINK.test(content)) {
      validateTarget(
        EMAIL_AUTOLINK.test(content) ? `mailto:${content}` : content,
        source,
        opening + 1,
        approved,
        referencedFragments,
        targetRanges,
      );
      targetCount += 1;
    } else {
      const parsed = parseRawHtmlTag(
        source,
        opening,
        closing,
        approved,
        referencedFragments,
        targetRanges,
      );
      targetCount += parsed.targetCount;
      anchors.push(...parsed.anchors);
    }
    opening = source.indexOf("<", closing + 1);
  }
  return Object.freeze({
    anchors: Object.freeze(anchors),
    tagRanges: Object.freeze(tagRanges),
    targetCount,
  });
}

function scanGfmBareUrls(
  source,
  excludedRanges,
  approved,
  referencedFragments,
) {
  const characters = source.split("");
  for (const range of excludedRanges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  const visible = characters.join("");
  let targetCount = 0;
  for (const match of visible.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    validateTarget(
      match[0],
      source,
      match.index,
      approved,
      referencedFragments,
    );
    targetCount += 1;
  }
  return targetCount;
}

function markdownHeadingId(rawText, source, index) {
  let text = decodeHtmlEntities(rawText, source, index)
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .trim();
  if (/[<>]/u.test(text)) {
    syntaxFailure(source, index, "unsupported raw HTML inside a Markdown heading");
  }
  text = text
    .replaceAll(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/gu, "$1")
    .replaceAll(/[`*_~]/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, "")
    .trim()
    .replaceAll(/\s+/gu, "-");
  if (text.length === 0 || text.length > 512) {
    syntaxFailure(source, index, "a Markdown heading without a bounded anchor ID");
  }
  return text;
}

function markdownHeadingAnchors(source) {
  const anchors = [];
  const occupiedLines = new Set();
  const lines = source.split(/(?<=\n)/u);
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineWithEnding = lines[lineIndex];
    const line = lineWithEnding.endsWith("\n")
      ? lineWithEnding.slice(0, -1)
      : lineWithEnding;
    const atx = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)(.*)$/u.exec(line);
    if (atx !== null) {
      const textOffset = offset + line.indexOf(atx[1]);
      anchors.push(Object.freeze({
        id: markdownHeadingId(atx[1], source, textOffset),
        index: textOffset,
      }));
      occupiedLines.add(lineIndex);
    }
    offset += lineWithEnding.length;
  }

  offset = 0;
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const previousWithEnding = lines[lineIndex - 1];
    const previous = previousWithEnding.endsWith("\n")
      ? previousWithEnding.slice(0, -1)
      : previousWithEnding;
    const underlineWithEnding = lines[lineIndex];
    const underline = underlineWithEnding.endsWith("\n")
      ? underlineWithEnding.slice(0, -1)
      : underlineWithEnding;
    if (
      !occupiedLines.has(lineIndex - 1) &&
      /^[ \t]{0,3}(?:=+|-+)[ \t]*$/u.test(underline) &&
      /^[ \t]{0,3}\S.*$/u.test(previous)
    ) {
      const leading = /^[ \t]*/u.exec(previous)?.[0].length ?? 0;
      anchors.push(Object.freeze({
        id: markdownHeadingId(previous.slice(leading), source, offset + leading),
        index: offset + leading,
      }));
    }
    offset += previousWithEnding.length;
  }
  return Object.freeze(anchors);
}

function renderedText(node) {
  if (node?.nodeName === "#text") return node.value ?? "";
  return (node?.childNodes ?? []).map((child) => renderedText(child)).join("");
}

function renderedReadmePolicy(source, approved) {
  let tokens;
  let html;
  try {
    tokens = marked.lexer(source, { gfm: true, pedantic: false });
    html = marked.parser(tokens, { gfm: true, pedantic: false });
  } catch {
    fail("cannot be parsed as bounded GFM");
  }
  if (
    typeof html !== "string" ||
    Buffer.byteLength(html, "utf8") > MAX_README_BYTES * 8
  ) fail("rendered GFM is outside its byte envelope");

  const parseErrors = [];
  const fragment = parseFragment(html, {
    onParseError: (error) => parseErrors.push(error),
    sourceCodeLocationInfo: true,
  });
  if (parseErrors.length > 0) fail("rendered GFM contains malformed HTML");

  const referencedFragments = [];
  const anchors = [];
  let targetCount = 0;
  const visit = (node) => {
    if (typeof node?.tagName === "string") {
      const tagName = node.tagName.toLowerCase();
      const attributes = new Set();
      for (const attribute of node.attrs ?? []) {
        const name = attribute.name.toLowerCase();
        if (attributes.has(name)) fail("rendered GFM contains a duplicate HTML attribute");
        attributes.add(name);
        if (name.startsWith("on") || ACTIVE_HTML_ATTRIBUTE_NAMES.has(name)) {
          fail("rendered GFM contains an active HTML attribute");
        }
        if (
          !HTML_URL_ATTRIBUTE_NAMES.has(name) &&
          !(name === "xmlns" && attribute.value === "http://www.w3.org/2000/svg") &&
          /(?:https?|wss?|ftp):|(?:^|[^:])\/\/|\burl\s*\(/iu.test(attribute.value)
        ) fail("rendered GFM hides an external load in an HTML attribute");
        if (HTML_URL_ATTRIBUTE_NAMES.has(name)) {
          if (name !== "href" && name !== "src") {
            fail(`rendered GFM contains an unsupported HTML ${name} attribute`);
          }
          validateTarget(
            attribute.value,
            html,
            node.sourceCodeLocation?.startOffset ?? 0,
            approved,
            referencedFragments,
          );
          targetCount += 1;
        }
        if (name === "id" || name === "name") {
          anchors.push(Object.freeze({
            id: explicitAnchorId(
              attribute.value,
              html,
              node.sourceCodeLocation?.startOffset ?? 0,
            ),
            index: node.sourceCodeLocation?.startOffset ?? 0,
          }));
        }
      }
      if (/^h[1-6]$/u.test(tagName)) {
        anchors.push(Object.freeze({
          id: markdownHeadingId(
            renderedText(node),
            html,
            node.sourceCodeLocation?.startOffset ?? 0,
          ),
          index: node.sourceCodeLocation?.startOffset ?? 0,
        }));
      }
    }
    for (const child of node?.childNodes ?? []) visit(child);
  };
  visit(fragment);

  const referenceLinks = Object.values(tokens.links ?? {});
  if (referenceLinks.length > 256) fail("GFM reference inventory is outside its envelope");
  for (const reference of referenceLinks) {
    validateTarget(reference.href, source, 0, approved, referencedFragments);
  }
  const anchorCount = validateFragmentClosure(html, [], anchors, referencedFragments);
  return Object.freeze({
    anchorCount,
    referenceDefinitionCount: referenceLinks.length,
    targetCount: targetCount + referenceLinks.length,
  });
}

function validateFragmentClosure(source, headings, explicitAnchors, references) {
  const anchors = new Set();
  for (const anchor of [...headings, ...explicitAnchors]) {
    if (anchors.has(anchor.id)) {
      syntaxFailure(source, anchor.index, "a duplicate Markdown or explicit anchor ID");
    }
    anchors.add(anchor.id);
  }
  for (const reference of references) {
    if (!anchors.has(reference.id)) {
      syntaxFailure(source, reference.index, "a same-document fragment without a matching anchor");
    }
  }
  return anchors.size;
}

function entryPath(entry) {
  if (typeof entry?.path === "string") return entry.path;
  if (typeof entry?.relativePath === "string") return `package/${entry.relativePath}`;
  return null;
}

/**
 * Validate a first-party README from exact, already-validated archive entries.
 * Same-document fragments are admitted. HTTPS targets require an exact,
 * caller-owned allowlist entry; all local paths and other schemes fail closed.
 */
export function assertPackagedReadmeLinks(entries, options = {}) {
  if (!Array.isArray(entries)) fail("archive entries must be an array");
  const readmePath = options.readmePath ?? "package/README.md";
  if (
    typeof readmePath !== "string" ||
    readmePath.length === 0 ||
    readmePath.includes("\\") ||
    readmePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("readmePath is unsafe");
  }
  const matches = entries.filter((entry) => entryPath(entry) === readmePath);
  if (matches.length !== 1) fail(`${readmePath} must occur exactly once`);
  const bytes = matches[0].bytes;
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_README_BYTES
  ) {
    fail(`${readmePath} is outside the README byte envelope`);
  }
  let decoded;
  try {
    decoded = README_DECODER.decode(bytes);
  } catch {
    fail(`${readmePath} is not canonical UTF-8 text`);
  }
  if (/\u0000|\r(?!\n)|\uFFFD/u.test(decoded)) {
    fail(`${readmePath} contains non-canonical text controls`);
  }
  const approved = approvedHttpsSet(options.approvedHttpsTargets ?? []);
  const rendered = renderedReadmePolicy(decoded, approved);
  const visible = maskIgnoredMarkdown(decoded);
  const referencedFragments = [];
  const targetRanges = [];
  const definitions = parseReferenceDefinitions(
    visible,
    approved,
    referencedFragments,
    targetRanges,
  );
  scanMarkdownLinks(
    definitions.source,
    definitions.references,
    approved,
    referencedFragments,
    targetRanges,
  );
  const html = scanHtmlAndAutolinks(
    definitions.source,
    approved,
    referencedFragments,
    targetRanges,
  );
  scanGfmBareUrls(
    definitions.source,
    [...targetRanges, ...html.tagRanges],
    approved,
    referencedFragments,
  );
  validateFragmentClosure(
    decoded,
    markdownHeadingAnchors(maskIgnoredMarkdown(decoded, { inlineCode: false })),
    html.anchors,
    referencedFragments,
  );
  return Object.freeze({
    readmePath,
    approvedHttpsTargetCount: approved.size,
    anchorCount: rendered.anchorCount,
    referenceDefinitionCount: rendered.referenceDefinitionCount,
    targetCount: rendered.targetCount,
  });
}
