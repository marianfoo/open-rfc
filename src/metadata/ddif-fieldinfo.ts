import {
  intrinsicUint8ArrayByteLength,
  intrinsicUint8ArrayView,
} from "../protocol/bytes.js";
import {
  decodeAbapChar,
  decodeClassicRfcResult,
  encodeAbapChar,
} from "../protocol/classic-rfc.js";
import {
  encodeCpicCutFunctionRequest,
  type CpicField,
} from "../protocol/cpic.js";
import type {
  RfcStructureDefinition,
  RfcStructureField,
} from "./rfc-structure-definition.js";
import { validateClassicStructureCodec } from "../values/classic-structure.js";

const DFIES_MINIMUM_UNICODE_ROW_LENGTH = 1_074;
const X030L_MINIMUM_UNICODE_LENGTH = 249;
const MAX_DDIC_STRUCTURE_FIELDS = 9_999;

function metadataName(value: string, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 30 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(
      `${path} must contain 1..30 characters without controls`,
    );
  }
  return value;
}

function sapLanguage(value: string): string {
  if (typeof value !== "string" || !/^[\x20-\x7e]$/u.test(value)) {
    throw new RangeError("DDIF language must be one printable ASCII character");
  }
  return value;
}

/** Build the Note 460089 classic DDIC lookup without prior dynamic metadata. */
export function buildDdIfFieldInfoGetRequest(
  structureName: string,
  language = "E",
): Buffer {
  const name = metadataName(structureName, "structureName");
  const langu = sapLanguage(language);
  return encodeCpicCutFunctionRequest({
    functionName: "DDIF_FIELDINFO_GET",
    requestedOutputs: ["DDOBJTYPE", "X030L_WA", "DFIES_TAB"],
    imports: [
      { name: "TABNAME", value: encodeAbapChar(name, 30) },
      { name: "LANGU", value: encodeAbapChar(langu, 1) },
      { name: "ALL_TYPES", value: encodeAbapChar("X", 1) },
      // DDIF's default follows backend/runtime context. This resolver is
      // explicitly Unicode and therefore always requests two-byte geometry.
      { name: "UCLEN", value: Buffer.of(2) },
    ],
  });
}

function requiredScalar(
  result: ReturnType<typeof decodeClassicRfcResult>,
  name: string,
): Buffer {
  const scalar = result.scalars.find((candidate) => candidate.name === name);
  if (scalar === undefined) {
    throw new Error(`DDIF_FIELDINFO_GET response lacks scalar ${name}`);
  }
  return scalar.value;
}

function fieldText(
  row: Buffer,
  offset: number,
  byteLength: number,
  characterLength: number,
): string {
  return decodeAbapChar(
    row.subarray(offset, offset + byteLength),
    characterLength,
  );
}

function numc(
  row: Buffer,
  offset: number,
  byteLength: number,
  path: string,
): number {
  const value = fieldText(row, offset, byteLength, byteLength / 2);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${path} must contain NUMC digits`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${path} exceeds the safe integer range`);
  }
  return parsed;
}

interface DecodedDfiesField extends RfcStructureField {
  readonly componentType: string;
}

/** Decode the stable DFIES prefix used by both 7.50 and 7.58. */
export function decodeDdIfDfiesRow(value: Uint8Array): DecodedDfiesField {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("DFIES row expects Uint8Array bytes");
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (
    byteLength < DFIES_MINIMUM_UNICODE_ROW_LENGTH ||
    (byteLength & 1) !== 0
  ) {
    throw new RangeError(
      `Unicode DFIES row must contain at least ` +
        `${DFIES_MINIMUM_UNICODE_ROW_LENGTH} even bytes; received ${byteLength}`,
    );
  }
  // Later releases append fields to DFIES. Only retain the stable prefix that
  // this decoder consumes, so a maximum-size CPIC row cannot trigger a second
  // maximum-size copy.
  const row = Buffer.from(
    intrinsicUint8ArrayView(value, "DFIES row").subarray(
      0,
      DFIES_MINIMUM_UNICODE_ROW_LENGTH,
    ),
  );
  const tableName = fieldText(row, 0, 60, 30);
  const fieldName = fieldText(row, 60, 60, 30);
  const position = numc(row, 122, 8, "DFIES.POSITION");
  const offset = numc(row, 130, 12, "DFIES.OFFSET");
  const internalLength = numc(row, 334, 12, "DFIES.INTLEN");
  const decimals = numc(row, 358, 12, "DFIES.DECIMALS");
  const exid = fieldText(row, 378, 2, 1);
  const componentType = fieldText(row, 1_072, 2, 1);
  if (tableName.length === 0 || fieldName.length === 0 || exid.length !== 1) {
    throw new Error("DFIES row contains an empty table, field, or INTTYPE");
  }
  if (position < 1) {
    throw new Error("DFIES row contains an invalid position");
  }
  return Object.freeze({
    tableName,
    fieldName,
    position,
    offset,
    internalLength,
    decimals,
    exid,
    componentType,
  });
}

function x030lGeometry(
  value: Buffer,
  structureName: string,
): Readonly<{ byteLength: number; fieldCount: number }> {
  if (value.byteLength < X030L_MINIMUM_UNICODE_LENGTH) {
    throw new RangeError(
      `DDIF_FIELDINFO_GET X030L_WA must contain at least ` +
        `${X030L_MINIMUM_UNICODE_LENGTH} bytes`,
    );
  }
  const returnedName = fieldText(value, 0, 60, 30);
  if (returnedName !== structureName) {
    throw new Error(
      `DDIF_FIELDINFO_GET X030L_WA belongs to ${returnedName}; ` +
        `expected ${structureName}`,
    );
  }
  const fieldCount = value.readUInt16BE(162);
  const byteLength = value.readUInt32BE(164);
  const tableType = fieldText(value, 172, 2, 1);
  const unicodeCharacterBytes = value.readUInt8(248);
  if (unicodeCharacterBytes !== 2) {
    throw new Error(
      `DDIF_FIELDINFO_GET selected unsupported Unicode width ` +
        `${unicodeCharacterBytes}`,
    );
  }
  if (fieldCount > MAX_DDIC_STRUCTURE_FIELDS) {
    throw new RangeError(
      `DDIF_FIELDINFO_GET field count exceeds ${MAX_DDIC_STRUCTURE_FIELDS}`,
    );
  }
  if (tableType === "L") {
    throw new Error(
      "DDIF_FIELDINFO_GET returned a table/vector type; a flat structure was required",
    );
  }
  return Object.freeze({ byteLength, fieldCount });
}

/** Normalize the classic DDIF response into the invocation codec descriptor. */
export function decodeDdIfFieldInfoGetResult(
  structureName: string,
  fields: readonly CpicField[],
): RfcStructureDefinition {
  const name = metadataName(structureName, "structureName");
  const result = decodeClassicRfcResult(fields);
  const objectKind = decodeAbapChar(requiredScalar(result, "DDOBJTYPE"));
  if (objectKind.length === 0) {
    throw new Error("DDIF_FIELDINFO_GET returned an initial DDOBJTYPE");
  }
  if (objectKind === "DTEL" || objectKind === "TTYP") {
    throw new Error(
      `DDIF_FIELDINFO_GET returned unsupported DDIC object kind ${objectKind}`,
    );
  }
  const x030l = requiredScalar(result, "X030L_WA");
  const geometry = x030lGeometry(x030l, name);
  const byteLength = geometry.byteLength;
  const table = result.tables.find((candidate) => candidate.name === "DFIES_TAB");
  if (table === undefined) {
    throw new Error("DDIF_FIELDINFO_GET response lacks DFIES_TAB");
  }
  if (table.rows.length > MAX_DDIC_STRUCTURE_FIELDS) {
    throw new RangeError(
      `DDIF_FIELDINFO_GET field count exceeds ${MAX_DDIC_STRUCTURE_FIELDS}`,
    );
  }
  if (geometry.fieldCount !== table.rows.length) {
    throw new Error(
      `DDIF_FIELDINFO_GET X030L_WA advertises ${geometry.fieldCount} fields; ` +
        `DFIES_TAB contains ${table.rows.length}`,
    );
  }
  const decoded = table.rows.map((row) => decodeDdIfDfiesRow(row));
  const names = new Set<string>();
  let previousEnd = 0;
  const normalized: RfcStructureField[] = [];
  for (let index = 0; index < decoded.length; index += 1) {
    const field = decoded[index]!;
    if (field.tableName !== name) {
      throw new Error(
        `DFIES ${field.fieldName} belongs to ${field.tableName}; expected ${name}`,
      );
    }
    if (field.position !== index + 1) {
      throw new Error(
        `DFIES ${field.fieldName} has position ${field.position}; expected ${index + 1}`,
      );
    }
    // SAP Note 1691982's DDIF consumer treats both "E" and the initial value
    // as elementary. The initial form is emitted for structure components
    // declared directly with a built-in DDIC type. Composite markers remain
    // fail-closed, and validateClassicStructureCodec below still validates
    // each elementary field's type, length, decimals, offsets, and geometry.
    if (field.componentType !== "" && field.componentType !== "E") {
      throw new Error(
        `DFIES ${name}.${field.fieldName} has unsupported component type ` +
          `${field.componentType || "<initial>"}`,
      );
    }
    if (names.has(field.fieldName)) {
      throw new Error(`DFIES contains duplicate field ${field.fieldName}`);
    }
    if (field.offset < previousEnd) {
      throw new Error(`DFIES ${field.fieldName} overlaps its preceding field`);
    }
    const end = field.offset + field.internalLength;
    if (!Number.isSafeInteger(end) || end > byteLength) {
      throw new Error(
        `DFIES ${field.fieldName} ends at ${end} beyond structure length ${byteLength}`,
      );
    }
    names.add(field.fieldName);
    previousEnd = end;
    normalized.push(Object.freeze({
      tableName: field.tableName,
      fieldName: field.fieldName,
      position: field.position,
      offset: field.offset,
      internalLength: field.internalLength,
      decimals: field.decimals,
      exid: field.exid,
    }));
  }
  return validateClassicStructureCodec(Object.freeze({
    name,
    byteLength,
    fields: Object.freeze(normalized),
  }), name);
}
