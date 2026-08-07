import {
  decodeAbapChar,
  decodeClassicRfcResult,
  decodeRfcTableHeader,
  encodeAbapChar,
} from "../protocol/classic-rfc.js";
import { CheckedByteReader } from "../protocol/bytes.js";
import {
  CpicTag,
  encodeCpicCutFunctionRequest,
  type CpicField,
} from "../protocol/cpic.js";

export const RFC_FIELDS_UNICODE_ROW_LENGTH = 138;
const MAX_RFC_STRUCTURE_FIELDS = 20_000;

export interface RfcStructureField {
  readonly tableName: string;
  readonly fieldName: string;
  readonly position: number;
  readonly offset: number;
  readonly internalLength: number;
  readonly decimals: number;
  readonly exid: string;
}

export interface RfcStructureDefinition {
  readonly name: string;
  readonly byteLength: number;
  readonly fields: readonly RfcStructureField[];
}

/** Build the classic structure-metadata bootstrap call. */
export function buildRfcGetStructureDefinitionRequest(
  structureName: string,
): Buffer {
  return encodeCpicCutFunctionRequest({
    functionName: "RFC_GET_STRUCTURE_DEFINITION",
    requestedOutputs: ["TABLENGTH", "FIELDS"],
    imports: [{ name: "TABNAME", value: encodeAbapChar(structureName, 30) }],
  });
}

/**
 * Decode one Unicode RFC_FIELDS bootstrap row.
 *
 * As with RFC_FUNINT, the row width belongs to the peer's release rather than
 * to the wire format, so bound it below by the stable prefix this decoder
 * consumes and ignore appended fields. A short row is still refused.
 */
export function decodeRfcFieldsRow(value: Uint8Array): RfcStructureField {
  if (value.byteLength < RFC_FIELDS_UNICODE_ROW_LENGTH) {
    throw new RangeError(
      `Unicode RFC_FIELDS row must contain at least ${RFC_FIELDS_UNICODE_ROW_LENGTH} ` +
        `bytes; received ${value.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(
    value.subarray(0, RFC_FIELDS_UNICODE_ROW_LENGTH),
    "RFC_FIELDS row",
  );
  const field = {
    tableName: decodeAbapChar(reader.readBytes(60, "TABNAME"), 30),
    fieldName: decodeAbapChar(reader.readBytes(60, "FIELDNAME"), 30),
    position: reader.readInt32LE("POSITION"),
    offset: reader.readInt32LE("OFFSET"),
    internalLength: reader.readInt32LE("INTLENGTH"),
    decimals: reader.readInt32LE("DECIMALS"),
    exid: decodeAbapChar(reader.readBytes(2, "EXID"), 1),
  };
  reader.finish();
  if (field.tableName.length === 0 || field.fieldName.length === 0) {
    throw new Error("RFC_FIELDS row contains an empty table or field name");
  }
  if (
    field.position < 1 ||
    field.offset < 0 ||
    field.internalLength < 0 ||
    field.decimals < 0
  ) {
    throw new Error("RFC_FIELDS row contains a negative or invalid numeric property");
  }
  return field;
}

function requiredScalar(
  result: ReturnType<typeof decodeClassicRfcResult>,
  name: string,
): Buffer {
  const scalar = result.scalars.find((value) => value.name === name);
  if (scalar === undefined) {
    throw new Error(`RFC_GET_STRUCTURE_DEFINITION response lacks scalar ${name}`);
  }
  return scalar.value;
}

/** Normalize and validate RFC_GET_STRUCTURE_DEFINITION output. */
export function decodeRfcStructureDefinitionResult(
  structureName: string,
  fields: readonly CpicField[],
): RfcStructureDefinition {
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.tag !== CpicTag.TableName) continue;
    if (decodeAbapChar(field.value) !== "FIELDS") continue;
    const header = fields[index + 1];
    if (header?.tag !== CpicTag.TableHeader) continue;
    const { rowCount } = decodeRfcTableHeader(header.value);
    if (rowCount > MAX_RFC_STRUCTURE_FIELDS) {
      throw new RangeError(
        `RFC_GET_STRUCTURE_DEFINITION FIELDS must contain at most ` +
          `${MAX_RFC_STRUCTURE_FIELDS} rows`,
      );
    }
  }
  const result = decodeClassicRfcResult(fields);
  const lengthValue = requiredScalar(result, "TABLENGTH");
  if (lengthValue.byteLength !== 4) {
    throw new Error("RFC_GET_STRUCTURE_DEFINITION TABLENGTH must be INT4");
  }
  const byteLength = lengthValue.readInt32LE(0);
  if (byteLength < 0) {
    throw new Error("RFC_GET_STRUCTURE_DEFINITION returned negative TABLENGTH");
  }
  const fieldTable = result.tables.find((table) => table.name === "FIELDS");
  if (fieldTable === undefined) {
    throw new Error("RFC_GET_STRUCTURE_DEFINITION response lacks FIELDS table");
  }
  if (fieldTable.rowByteLength < RFC_FIELDS_UNICODE_ROW_LENGTH) {
    throw new Error(
      `RFC_GET_STRUCTURE_DEFINITION FIELDS row width is ` +
        `${fieldTable.rowByteLength}; expected at least ${RFC_FIELDS_UNICODE_ROW_LENGTH}`,
    );
  }
  const decodedFields = fieldTable.rows.map((row) => decodeRfcFieldsRow(row));
  const names = new Set<string>();
  let previousEnd = 0;
  for (let index = 0; index < decodedFields.length; index += 1) {
    const field = decodedFields[index]!;
    const expectedPosition = index + 1;
    if (field.position !== expectedPosition) {
      throw new Error(
        `RFC_FIELDS ${field.fieldName} has position ${field.position}; ` +
          `expected ${expectedPosition}`,
      );
    }
    if (field.tableName !== structureName) {
      throw new Error(
        `RFC_FIELDS ${field.fieldName} belongs to ${field.tableName}; ` +
          `expected ${structureName}`,
      );
    }
    if (names.has(field.fieldName)) {
      throw new Error(`RFC_FIELDS contains duplicate field ${field.fieldName}`);
    }
    if (field.offset < previousEnd) {
      throw new Error(`RFC_FIELDS ${field.fieldName} overlaps its preceding field`);
    }
    const end = field.offset + field.internalLength;
    if (!Number.isSafeInteger(end) || end > byteLength) {
      throw new Error(
        `RFC_FIELDS ${field.fieldName} ends at ${end} beyond structure length ${byteLength}`,
      );
    }
    names.add(field.fieldName);
    previousEnd = end;
  }
  return Object.freeze({
    name: structureName,
    byteLength,
    fields: Object.freeze(
      decodedFields.map((field) => Object.freeze(field)),
    ),
  });
}
