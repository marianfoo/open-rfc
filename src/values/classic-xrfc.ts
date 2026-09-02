import type {
  RfcStructureDefinition,
  RfcStructureField,
} from "../metadata/rfc-structure-definition.js";
import {
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
  DEFAULT_MAX_CPIC_FIELD_COUNT,
  DEFAULT_MAX_CPIC_FIELD_LENGTH,
} from "../protocol/cpic.js";
import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";
import {
  classicStructureHasDynamicFields,
  validateClassicStructureCodec,
} from "./classic-structure.js";
import {
  projectClassicBcdOutput,
  snapshotClassicBcdMode,
  type ClassicBcdMode,
} from "./classic-bcd.js";
import {
  classicInt8InitialValue,
  decodeClassicInt8,
  encodeClassicInt8,
  snapshotClassicInt8Mode,
  type ClassicInt8Mode,
} from "./classic-int8.js";
import {
  assertClassicDate,
  assertClassicTime,
} from "./classic-temporal.js";
import {
  decodePackedDecimal,
  encodePackedDecimal,
} from "./packed-decimal.js";
import {
  assertNulFreeUnicodeScalarText,
  assertUnicodeScalarText,
  decodeXmlEntityReference,
} from "./unicode-scalar.js";


export type ClassicXrfcKind = "structure" | "table";

export interface ClassicXrfcLimits {
  /** Maximum UTF-8/base64 bytes in one XML field value. */
  readonly maxCellBytes?: number;
  /** Maximum encoded bytes in one structure or table row. */
  readonly maxRowBytes?: number;
  /** Maximum encoded bytes in one complete xRFC XML parameter. */
  readonly maxParameterBytes?: number;
  readonly maxRows?: number;
}

export interface ClassicXrfcOptions extends ClassicXrfcLimits {
  readonly int8Mode?: ClassicInt8Mode;
  readonly bcd?: ClassicBcdMode;
}

export interface NormalizedClassicXrfcLimits {
  readonly maxCellBytes: number;
  readonly maxRowBytes: number;
  readonly maxParameterBytes: number;
  readonly maxRows: number;
}

interface PlannedTextCell {
  readonly kind: "text";
  readonly field: RfcStructureField;
  readonly value: string;
  readonly encodedByteLength: number;
}

interface PlannedBytesCell {
  readonly kind: "bytes";
  readonly field: RfcStructureField;
  readonly value: Buffer;
  readonly encodedByteLength: number;
}

type PlannedCell = PlannedTextCell | PlannedBytesCell;

interface PlannedRow {
  readonly cells: readonly PlannedCell[];
  readonly encodedByteLength: number;
}

interface ClassicXrfcDecodeBudget {
  readonly limits: NormalizedClassicXrfcLimits;
  projectedBytes: number;
}

const SIMPLE_XML_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SUPPORTED_XRFC_FIELD_TYPES: ReadonlySet<string> = new Set([
  "I",
  "C",
  "N",
  "D",
  "T",
  "X",
  "P",
  "F",
  "8",
  "g",
  "y",
]);
const CANONICAL_INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;
// The full lexical space a conforming producer may write for a float: a
// leading "+", leading zeros, "1." and ".5" are all legal spellings of an
// unambiguous value, so the reader takes them. Matches the recursive sibling.
const FINITE_FLOAT_LEXICAL =
  /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/u;

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > maximum
  ) {
    throw new RangeError(`${label} must be an integer in 0..${maximum}`);
  }
  return normalized;
}

export function normalizeClassicXrfcLimits(
  limits: ClassicXrfcLimits,
): NormalizedClassicXrfcLimits {
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError("xRFC limits must be an object");
  }
  return Object.freeze({
    maxCellBytes: boundedLimit(
      limits.maxCellBytes,
      DEFAULT_MAX_CPIC_FIELD_LENGTH,
      DEFAULT_MAX_CPIC_FIELD_LENGTH,
      "maxCellBytes",
    ),
    maxRowBytes: boundedLimit(
      limits.maxRowBytes,
      DEFAULT_MAX_CPIC_FIELD_LENGTH,
      DEFAULT_MAX_CPIC_FIELD_LENGTH,
      "maxRowBytes",
    ),
    maxParameterBytes: boundedLimit(
      limits.maxParameterBytes,
      DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
      DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
      "maxParameterBytes",
    ),
    maxRows: boundedLimit(
      limits.maxRows,
      DEFAULT_MAX_CPIC_FIELD_COUNT,
      0xffff_ffff,
      "maxRows",
    ),
  });
}

export function assertClassicXrfcXmlName(value: string, label: string): void {
  if (!SIMPLE_XML_NAME.test(value)) {
    throw new Error(
      `${label} must be a simple XML name supported by the proven xRFC subset`,
    );
  }
}

export function classicXrfcOpenTagByteLength(name: string): number {
  return name.length + 2;
}

export function classicXrfcCloseTagByteLength(name: string): number {
  return name.length + 3;
}

export function checkedClassicXrfcLength(
  current: number,
  additional: number,
  label: string,
): number {
  const result = current + additional;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} encoded length is unsafe`);
  }
  return result;
}

function assertXmlCodePoint(codePoint: number, path: string): void {
  if (
    codePoint === 0 ||
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
    codePoint === 0xfffe ||
    codePoint === 0xffff
  ) {
    throw new RangeError(`${path} contains a character unsupported by XML 1.0`);
  }
}

export function escapedClassicXrfcXmlByteLength(
  value: string,
  path: string,
): number {
  assertUnicodeScalarText(value, path);
  let byteLength = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    assertXmlCodePoint(codePoint, path);
    switch (character) {
      case "&":
        byteLength = checkedClassicXrfcLength(byteLength, 5, path); // &#38;
        break;
      case "<":
      case ">":
        byteLength = checkedClassicXrfcLength(byteLength, 5, path); // &#60; / &#62;
        break;
      default:
        byteLength = checkedClassicXrfcLength(
          byteLength,
          Buffer.byteLength(character, "utf8"),
          path,
        );
    }
  }
  return byteLength;
}

function characterCapacity(field: RfcStructureField, path: string): number {
  if ((field.internalLength & 1) !== 0) {
    throw new Error(`${path} Unicode character width must be even`);
  }
  return field.internalLength / 2;
}

function normalizeDefinition(
  definition: RfcStructureDefinition,
): RfcStructureDefinition {
  const normalized = validateClassicStructureCodec(definition);
  if (!classicStructureHasDynamicFields(normalized)) {
    throw new Error(
      `${normalized.name} has no STRING/XSTRING field requiring xRFC XML`,
    );
  }
  for (const field of normalized.fields) {
    assertClassicXrfcXmlName(field.fieldName, `${normalized.name} field name`);
    if (!SUPPORTED_XRFC_FIELD_TYPES.has(field.exid)) {
      throw new Error(
        `${normalized.name}.${field.fieldName} type ${field.exid} is not ` +
          "implemented for the proven xRFC XML subset",
      );
    }
  }
  return normalized;
}

/** Validate the supported flat xRFC row subset without touching values. */
export function validateClassicXrfcDefinition(
  definition: RfcStructureDefinition,
): RfcStructureDefinition {
  return normalizeDefinition(definition);
}

function integerCell(value: unknown, path: string): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < -0x8000_0000 ||
    value > 0x7fff_ffff
  ) {
    throw new RangeError(`${path} expects a signed 32-bit integer`);
  }
  return String(value);
}

function initialCell(
  field: RfcStructureField,
  int8Mode: ClassicInt8Mode,
): unknown {
  switch (field.exid) {
    case "I":
      return 0;
    case "C":
    case "g":
      return "";
    case "N":
      // The normal planner validates the declared width before padding. Do not
      // materialize metadata-controlled output in this default-value helper.
      return "";
    case "D":
      return "00000000";
    case "T":
      return "000000";
    case "X":
    case "y":
      return Buffer.alloc(0);
    case "P":
      return "0";
    case "F":
      return 0;
    case "8":
      return classicInt8InitialValue(int8Mode);
    default:
      throw new Error(`unsupported xRFC field type ${field.exid}`);
  }
}

function canonicalDateText(value: unknown, path: string): string {
  assertClassicDate(value as string, path);
  const date = value as string;
  return date === "" || date === "        "
    ? ""
    : date.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");
}

function canonicalTimeText(value: unknown, path: string): string {
  assertClassicTime(value as string, path);
  const time = value as string;
  return time === "" || time === "      "
    ? ""
    : time.replace(/^(\d{2})(\d{2})(\d{2})$/u, "$1:$2:$3");
}

function plannedBytesCell(
  field: RfcStructureField,
  value: Uint8Array,
  path: string,
  limits: NormalizedClassicXrfcLimits,
  exactLength?: number,
): PlannedBytesCell {
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (exactLength !== undefined && byteLength > exactLength) {
    throw new RangeError(`${path} accepts at most ${exactLength} bytes`);
  }
  const plannedByteLength = exactLength ?? byteLength;
  const encodedByteLength = Math.ceil(plannedByteLength / 3) * 4;
  if (
    !Number.isSafeInteger(encodedByteLength) ||
    encodedByteLength > limits.maxCellBytes ||
    encodedByteLength > limits.maxRowBytes ||
    encodedByteLength > limits.maxParameterBytes
  ) {
    throw new RangeError(
      `${path} base64 value exceeds the configured encoded-byte limits`,
    );
  }
  const snapshot = snapshotUint8Array(value, path, byteLength);
  let bytes = snapshot;
  if (exactLength !== undefined && exactLength !== byteLength) {
    bytes = Buffer.alloc(exactLength);
    snapshot.copy(bytes);
  }
  return Object.freeze({
    kind: "bytes",
    field,
    value: bytes,
    encodedByteLength,
  });
}

function planCell(
  definition: RfcStructureDefinition,
  field: RfcStructureField,
  value: unknown,
  limits: NormalizedClassicXrfcLimits,
  int8Mode: ClassicInt8Mode,
): PlannedCell {
  const path = `${definition.name}.${field.fieldName}`;
  let text: string;
  switch (field.exid) {
    case "I":
      text = integerCell(value, path);
      break;
    case "C": {
      if (typeof value !== "string") {
        throw new TypeError(`${path} expects a string`);
      }
      assertUnicodeScalarText(value, path);
      const capacity = characterCapacity(field, path);
      if (value.length > capacity) {
        throw new RangeError(`${path} does not fit CHAR(${capacity})`);
      }
      text = value;
      break;
    }
    case "N": {
      const capacity = characterCapacity(field, path);
      const maximumPlannedBytes = Math.min(
        limits.maxCellBytes,
        limits.maxRowBytes,
        limits.maxParameterBytes,
      );
      if (capacity > maximumPlannedBytes) {
        throw new RangeError(
          `${path} padded NUM value exceeds the configured encoded-byte limits`,
        );
      }
      if (
        typeof value !== "string" ||
        !/^\d*$/u.test(value) ||
        value.length > capacity
      ) {
        throw new TypeError(
          `${path} expects at most ${capacity} decimal digits`,
        );
      }
      text = value.padStart(capacity, "0");
      break;
    }
    case "D":
      text = canonicalDateText(value, path);
      break;
    case "T":
      text = canonicalTimeText(value, path);
      break;
    case "X":
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${path} expects Uint8Array bytes`);
      }
      return plannedBytesCell(
        field,
        value,
        path,
        limits,
        field.internalLength,
      );
    case "P":
      text = decodePackedDecimal(
        encodePackedDecimal(
          value as never,
          field.internalLength,
          field.decimals,
          path,
        ),
        field.decimals,
        path,
      );
      break;
    case "F":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${path} expects a finite number`);
      }
      text = Object.is(value, -0) ? "-0" : String(value);
      break;
    case "8":
      text = encodeClassicInt8(value, int8Mode, path).toString();
      break;
    case "g":
      if (typeof value !== "string") {
        throw new TypeError(`${path} expects Unicode text`);
      }
      assertNulFreeUnicodeScalarText(value, path);
      text = value;
      break;
    case "y": {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${path} expects Uint8Array bytes`);
      }
      return plannedBytesCell(field, value, path, limits);
    }
    default:
      throw new Error(`${path} has an unsupported xRFC field type`);
  }
  const encodedByteLength = escapedClassicXrfcXmlByteLength(text, path);
  if (encodedByteLength > limits.maxCellBytes) {
    throw new RangeError(
      `${path} XML value exceeds ${limits.maxCellBytes} encoded bytes`,
    );
  }
  return Object.freeze({
    kind: "text",
    field,
    value: text,
    encodedByteLength,
  });
}

function planRow(
  definition: RfcStructureDefinition,
  input: unknown,
  limits: NormalizedClassicXrfcLimits,
  int8Mode: ClassicInt8Mode,
  itemWrapper: boolean,
  rowIndex?: number,
): PlannedRow {
  const rowPath = rowIndex === undefined
    ? definition.name
    : `${definition.name}[${rowIndex}]`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${rowPath} expects a structure object`);
  }
  const record = input as Readonly<Record<string, unknown>>;
  const known = new Set(definition.fields.map((field) => field.fieldName));
  for (const name of Object.keys(record)) {
    if (!known.has(name)) {
      throw new Error(`${rowPath} contains unknown field ${name}`);
    }
  }
  const cells: PlannedCell[] = [];
  let encodedByteLength = itemWrapper ? 13 : 0; // <item></item>
  for (const field of definition.fields) {
    const supplied = Object.prototype.hasOwnProperty.call(record, field.fieldName);
    const value = supplied
      ? record[field.fieldName]
      : initialCell(field, int8Mode);
    const cell = planCell(definition, field, value, limits, int8Mode);
    const cellByteLength =
      classicXrfcOpenTagByteLength(field.fieldName) +
      cell.encodedByteLength +
      classicXrfcCloseTagByteLength(field.fieldName);
    encodedByteLength = checkedClassicXrfcLength(
      encodedByteLength,
      cellByteLength,
      rowPath,
    );
    if (encodedByteLength > limits.maxRowBytes) {
      throw new RangeError(
        `${rowPath} XML row exceeds ${limits.maxRowBytes} encoded bytes`,
      );
    }
    cells.push(cell);
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    encodedByteLength,
  });
}

function writeAscii(target: Buffer, offset: number, value: string): number {
  return offset + target.write(value, offset, "ascii");
}

export function writeClassicXrfcOpenTag(
  target: Buffer,
  offset: number,
  name: string,
): number {
  return writeAscii(target, offset, `<${name}>`);
}

export function writeClassicXrfcCloseTag(
  target: Buffer,
  offset: number,
  name: string,
): number {
  return writeAscii(target, offset, `</${name}>`);
}

export function writeEscapedClassicXrfcText(
  target: Buffer,
  offset: number,
  value: string,
): number {
  for (const character of value) {
    switch (character) {
      case "&":
        offset = writeAscii(target, offset, "&#38;");
        break;
      case "<":
        offset = writeAscii(target, offset, "&#60;");
        break;
      case ">":
        offset = writeAscii(target, offset, "&#62;");
        break;
      default:
        offset += target.write(character, offset, "utf8");
    }
  }
  return offset;
}

function writePlannedRow(
  target: Buffer,
  offset: number,
  row: PlannedRow,
  itemWrapper: boolean,
): number {
  if (itemWrapper) offset = writeClassicXrfcOpenTag(target, offset, "item");
  for (const cell of row.cells) {
    offset = writeClassicXrfcOpenTag(target, offset, cell.field.fieldName);
    if (cell.kind === "text") {
      offset = writeEscapedClassicXrfcText(target, offset, cell.value);
    } else {
      offset += target.write(cell.value.toString("base64"), offset, "ascii");
    }
    offset = writeClassicXrfcCloseTag(target, offset, cell.field.fieldName);
  }
  if (itemWrapper) offset = writeClassicXrfcCloseTag(target, offset, "item");
  return offset;
}

/**
 * Encode the supported xRFC XML subset for one flat structure or table.
 * The returned buffer owns snapshots of every caller-supplied binary value.
 */
export function encodeClassicXrfcParameter(
  parameterName: string,
  definition: RfcStructureDefinition,
  kind: ClassicXrfcKind,
  value: unknown,
  options: ClassicXrfcOptions = {},
): Buffer {
  assertClassicXrfcXmlName(parameterName, "xRFC parameter name");
  if (kind !== "structure" && kind !== "table") {
    throw new TypeError("xRFC parameter kind must be structure or table");
  }
  const normalized = normalizeDefinition(definition);
  const normalizedLimits = normalizeClassicXrfcLimits(options);
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const rows: PlannedRow[] = [];
  let byteLength = classicXrfcOpenTagByteLength(parameterName) + classicXrfcCloseTagByteLength(parameterName);
  if (byteLength > normalizedLimits.maxParameterBytes) {
    throw new RangeError(
      `${parameterName} xRFC XML exceeds ${normalizedLimits.maxParameterBytes} bytes`,
    );
  }
  const appendRow = (row: PlannedRow): void => {
    byteLength = checkedClassicXrfcLength(byteLength, row.encodedByteLength, parameterName);
    if (byteLength > normalizedLimits.maxParameterBytes) {
      throw new RangeError(
        `${parameterName} xRFC XML exceeds ${normalizedLimits.maxParameterBytes} bytes`,
      );
    }
    rows.push(row);
  };
  if (kind === "table") {
    if (!Array.isArray(value)) {
      throw new TypeError(`${parameterName} expects an array of rows`);
    }
    const rowCount = value.length;
    if (rowCount > normalizedLimits.maxRows) {
      throw new RangeError(
        `${parameterName} row count exceeds ${normalizedLimits.maxRows}`,
      );
    }
    for (let index = 0; index < rowCount; index += 1) {
      appendRow(planRow(
        normalized,
        value[index],
        normalizedLimits,
        int8Mode,
        true,
        index,
      ));
    }
  } else {
    appendRow(planRow(
      normalized,
      value,
      normalizedLimits,
      int8Mode,
      false,
    ));
  }

  const encoded = Buffer.alloc(byteLength);
  let offset = writeClassicXrfcOpenTag(encoded, 0, parameterName);
  for (const row of rows) {
    offset = writePlannedRow(encoded, offset, row, kind === "table");
  }
  offset = writeClassicXrfcCloseTag(encoded, offset, parameterName);
  if (offset !== encoded.byteLength) {
    throw new Error(`${parameterName} xRFC XML encoder length invariant failed`);
  }
  return encoded;
}

export class ExactClassicXrfcParser {
  readonly #text: string;
  readonly #limits: NormalizedClassicXrfcLimits;
  #offset = 0;
  #byteOffset = 0;

  constructor(text: string, limits: NormalizedClassicXrfcLimits) {
    this.#text = text;
    this.#limits = limits;
  }

  startsWithTag(name: string, closing = false): boolean {
    return this.#text.startsWith(closing ? `</${name}>` : `<${name}>`, this.#offset);
  }

  open(name: string): void {
    const token = `<${name}>`;
    if (!this.#text.startsWith(token, this.#offset)) {
      throw new Error(`xRFC XML expected ${token} at character ${this.#offset}`);
    }
    this.#offset += token.length;
    this.#byteOffset += token.length;
  }

  close(name: string): void {
    const token = `</${name}>`;
    if (!this.#text.startsWith(token, this.#offset)) {
      throw new Error(`xRFC XML expected ${token} at character ${this.#offset}`);
    }
    this.#offset += token.length;
    this.#byteOffset += token.length;
  }

  cell(path: string): string {
    const end = this.#text.indexOf("<", this.#offset);
    if (end < 0) throw new Error(`xRFC XML ${path} is truncated`);
    const raw = this.#text.slice(this.#offset, end);
    this.#offset = end;
    if (raw.includes("]]>")) {
      throw new Error(`${path} contains invalid XML character data`);
    }
    const byteLength = Buffer.byteLength(raw, "utf8");
    this.#byteOffset += byteLength;
    if (byteLength > this.#limits.maxCellBytes) {
      throw new RangeError(
        `${path} XML value exceeds ${this.#limits.maxCellBytes} encoded bytes`,
      );
    }
    return decodeEntities(raw, path);
  }

  rowByteLength(start: number): number {
    return this.#byteOffset - start;
  }

  position(): number {
    return this.#byteOffset;
  }

  finish(): void {
    if (this.#offset !== this.#text.length) {
      throw new Error(`xRFC XML has trailing content at character ${this.#offset}`);
    }
  }
}

function decodeEntities(raw: string, path: string): string {
  let result = "";
  let offset = 0;
  while (offset < raw.length) {
    const ampersand = raw.indexOf("&", offset);
    if (ampersand < 0) {
      result += raw.slice(offset);
      break;
    }
    result += raw.slice(offset, ampersand);
    const { codePoint, length } = decodeXmlEntityReference(raw, ampersand, path);
    assertXmlCodePoint(codePoint, path);
    result += String.fromCodePoint(codePoint);
    offset = ampersand + length;
  }
  assertUnicodeScalarText(result, path);
  for (const character of result) {
    assertXmlCodePoint(character.codePointAt(0)!, path);
  }
  return result;
}

export function decodeClassicXrfcBase64(
  value: string,
  path: string,
  maximum: number,
): Buffer {
  // SAP's xRFC producer MIME-wraps larger XSTRING cells at 76 columns. Remove
  // only the two MIME line separators before the existing canonical checks;
  // spaces and every other non-base64 character remain invalid. Adapted from
  // open-rfc-go internal/xrfc at 92d5d8f6e0a08ff7ac1580f461585cbde2a56939.
  value = value.replace(/[\r\n]/gu, "");
  if (value.length === 0) return Buffer.alloc(0);
  if (
    (value.length & 3) !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error(`${path} contains non-canonical base64`);
  }
  const decodedByteLength = (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (decodedByteLength > maximum) {
    throw new RangeError(`${path} decoded bytes exceed ${maximum}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${path} contains non-canonical base64`);
  }
  return decoded;
}

function decodeCell(
  definition: RfcStructureDefinition,
  field: RfcStructureField,
  value: string,
  limits: NormalizedClassicXrfcLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  budget: ClassicXrfcDecodeBudget,
): unknown {
  const path = `${definition.name}.${field.fieldName}`;
  switch (field.exid) {
    case "I": {
      if (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u.test(value)) {
        throw new Error(`${path} contains a non-canonical INT4 value`);
      }
      const decoded = Number(value);
      if (
        !Number.isSafeInteger(decoded) ||
        decoded < -0x8000_0000 ||
        decoded > 0x7fff_ffff
      ) {
        throw new RangeError(`${path} INT4 value is out of range`);
      }
      return decoded;
    }
    case "C": {
      assertUnicodeScalarText(value, path);
      const capacity = characterCapacity(field, path);
      if (value.length > capacity) {
        throw new RangeError(`${path} does not fit CHAR(${capacity})`);
      }
      return value;
    }
    case "N": {
      const capacity = characterCapacity(field, path);
      if (!/^\d*$/u.test(value) || value.length > capacity) {
        throw new Error(`${path} contains a non-canonical NUM value`);
      }
      consumeClassicXrfcDecodedBytes(budget, capacity, path);
      return value.padStart(capacity, "0");
    }
    case "D": {
      if (value.length === 0) return "";
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new Error(`${path} contains a non-canonical xRFC DATE`);
      }
      const date = value.replaceAll("-", "");
      assertClassicDate(date, path);
      return date;
    }
    case "T": {
      if (value.length === 0) return "";
      if (!/^\d{2}:\d{2}:\d{2}$/u.test(value)) {
        throw new Error(`${path} contains a non-canonical xRFC TIME`);
      }
      const time = value.replaceAll(":", "");
      assertClassicTime(time, path);
      return time;
    }
    case "X": {
      consumeClassicXrfcDecodedBytes(
        budget,
        field.internalLength,
        path,
      );
      const decoded = decodeClassicXrfcBase64(
        value,
        path,
        limits.maxCellBytes,
      );
      if (decoded.byteLength !== field.internalLength) {
        throw new RangeError(
          `${path} fixed byte value must contain ${field.internalLength} bytes`,
        );
      }
      return decoded;
    }
    case "P":
      return projectClassicBcdOutput(
        decodePackedDecimal(
          encodePackedDecimal(
            value,
            field.internalLength,
            field.decimals,
            path,
          ),
          field.decimals,
          path,
        ),
        bcd,
        path,
      );
    case "F": {
      if (!FINITE_FLOAT_LEXICAL.test(value)) {
        throw new Error(`${path} contains an invalid FLOAT`);
      }
      const decoded = Number(value);
      if (!Number.isFinite(decoded)) {
        throw new Error(`${path} contains an invalid FLOAT`);
      }
      return decoded;
    }
    case "8": {
      if (!CANONICAL_INTEGER.test(value) || value.length > 20) {
        throw new Error(`${path} contains a non-canonical INT8 value`);
      }
      return decodeClassicInt8(BigInt(value), int8Mode, path);
    }
    case "g":
      assertNulFreeUnicodeScalarText(value, path);
      return value;
    case "y":
      {
        const decoded = decodeClassicXrfcBase64(
          value,
          path,
          limits.maxCellBytes,
        );
        consumeClassicXrfcDecodedBytes(budget, decoded.byteLength, path);
        return decoded;
      }
    default:
      throw new Error(`${path} has an unsupported xRFC field type`);
  }
}

function consumeClassicXrfcDecodedBytes(
  budget: ClassicXrfcDecodeBudget,
  byteLength: number,
  path: string,
): void {
  if (byteLength > budget.limits.maxCellBytes) {
    throw new RangeError(
      `${path} decoded value exceeds the ${budget.limits.maxCellBytes}-byte cell limit`,
    );
  }
  const projected = checkedClassicXrfcLength(
    budget.projectedBytes,
    byteLength,
    `${path} decoded output`,
  );
  if (projected > budget.limits.maxParameterBytes) {
    throw new RangeError(
      `${path} decoded output exceeds the ${budget.limits.maxParameterBytes}-byte parameter limit`,
    );
  }
  budget.projectedBytes = projected;
}

function parseRow(
  parser: ExactClassicXrfcParser,
  definition: RfcStructureDefinition,
  limits: NormalizedClassicXrfcLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  itemWrapper: boolean,
  budget: ClassicXrfcDecodeBudget,
): Readonly<Record<string, unknown>> {
  const start = parser.position();
  if (itemWrapper) parser.open("item");
  const result: Record<string, unknown> = {};
  for (const field of definition.fields) {
    parser.open(field.fieldName);
    const text = parser.cell(`${definition.name}.${field.fieldName}`);
    parser.close(field.fieldName);
    Object.defineProperty(result, field.fieldName, {
      value: decodeCell(
        definition,
        field,
        text,
        limits,
        int8Mode,
        bcd,
        budget,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (itemWrapper) parser.close("item");
  const byteLength = parser.rowByteLength(start);
  if (byteLength > limits.maxRowBytes) {
    throw new RangeError(
      `${definition.name} XML row exceeds ${limits.maxRowBytes} encoded bytes`,
    );
  }
  return result;
}

/** Return the strict top-level parameter name without accepting XML prologs. */
export function decodeClassicXrfcParameterName(
  value: Uint8Array,
  limits: ClassicXrfcLimits = {},
): string {
  const normalizedLimits = normalizeClassicXrfcLimits(limits);
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("xRFC XML parameter must be Uint8Array bytes");
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength === 0 || byteLength > normalizedLimits.maxParameterBytes) {
    throw new RangeError(
      `xRFC XML parameter must contain 1..${normalizedLimits.maxParameterBytes} bytes`,
    );
  }
  const encoded = snapshotUint8Array(value, "xRFC XML parameter", byteLength);
  if (
    encoded.byteLength >= 3 &&
    encoded[0] === 0xef &&
    encoded[1] === 0xbb &&
    encoded[2] === 0xbf
  ) {
    throw new Error("xRFC XML parameter must not contain a UTF-8 BOM");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  const match = /^<([A-Za-z_][A-Za-z0-9_]*)>/u.exec(text);
  if (match === null) {
    throw new Error("xRFC XML parameter lacks a supported top-level tag");
  }
  return match[1]!;
}

/** Decode the exact, attribute-free flat xRFC XML subset. */
export function decodeClassicXrfcParameter(
  parameterName: string,
  definition: RfcStructureDefinition,
  kind: ClassicXrfcKind,
  value: Uint8Array,
  options: ClassicXrfcOptions = {},
): Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[] {
  assertClassicXrfcXmlName(parameterName, "xRFC parameter name");
  if (kind !== "structure" && kind !== "table") {
    throw new TypeError("xRFC parameter kind must be structure or table");
  }
  const normalized = normalizeDefinition(definition);
  const normalizedLimits = normalizeClassicXrfcLimits(options);
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${parameterName} xRFC XML must be Uint8Array bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength === 0 || byteLength > normalizedLimits.maxParameterBytes) {
    throw new RangeError(
      `${parameterName} xRFC XML must contain 1..${normalizedLimits.maxParameterBytes} bytes`,
    );
  }
  const encoded = snapshotUint8Array(value, parameterName, byteLength);
  if (
    encoded.byteLength >= 3 &&
    encoded[0] === 0xef &&
    encoded[1] === 0xbb &&
    encoded[2] === 0xbf
  ) {
    throw new Error(`${parameterName} xRFC XML must not contain a UTF-8 BOM`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  const parser = new ExactClassicXrfcParser(text, normalizedLimits);
  const decodeBudget: ClassicXrfcDecodeBudget = {
    limits: normalizedLimits,
    projectedBytes: 0,
  };
  parser.open(parameterName);
  if (kind === "structure") {
    const result = parseRow(
      parser,
      normalized,
      normalizedLimits,
      int8Mode,
      bcd,
      false,
      decodeBudget,
    );
    parser.close(parameterName);
    parser.finish();
    return result;
  }
  const rows: Readonly<Record<string, unknown>>[] = [];
  while (!parser.startsWithTag(parameterName, true)) {
    if (rows.length >= normalizedLimits.maxRows) {
      throw new RangeError(
        `${parameterName} row count exceeds ${normalizedLimits.maxRows}`,
      );
    }
    rows.push(parseRow(
      parser,
      normalized,
      normalizedLimits,
      int8Mode,
      bcd,
      true,
      decodeBudget,
    ));
  }
  parser.close(parameterName);
  parser.finish();
  return rows;
}
