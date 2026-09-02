import {
  CheckedByteReader,
  intrinsicUint8ArrayByteLength,
  intrinsicUint8ArrayView,
  snapshotUint8Array,
} from "./bytes.js";
import {
  CpicTag,
  DEFAULT_MAX_CPIC_FIELD_COUNT,
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
  DEFAULT_MAX_CPIC_FIELD_LENGTH,
  type CpicField,
} from "./cpic.js";
import { assertUnicodeScalarText } from "../values/unicode-scalar.js";

export const RFC_FUNINT_UNICODE_ROW_LENGTH = 402;
export const DEFAULT_MAX_CLASSIC_RFC_TABLE_DECODED_BYTES =
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH;
export const DEFAULT_MAX_CLASSIC_RFC_RESULT_TABLE_DECODED_BYTES =
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH;

export interface RfcTableHeader {
  readonly declaredRowByteLength: number;
  readonly rowCount: number;
}

export interface ClassicRfcScalar {
  readonly name: string;
  readonly value: Buffer;
}

export interface ClassicRfcTable {
  readonly name: string;
  readonly declaredRowByteLength: number;
  readonly rowByteLength: number;
  /**
   * Legacy wire-tag label retained for API compatibility. `flat` means an
   * uncompressed TableContent record; `structured` means TableCompr.
   * Prefer rowCompression when making protocol decisions.
   */
  readonly rowEncoding: "flat" | "structured" | "mixed" | "empty";
  readonly rowCompression: "none" | "simple" | "mixed" | "empty";
  readonly rows: readonly Buffer[];
}

export interface ClassicRfcXrfcParameter {
  /** Concatenated UTF-8 XML bytes between one proven 0x3c02 boundary pair. */
  readonly value: Buffer;
  readonly chunkCount: number;
}

export interface ClassicRfcResult {
  readonly requestedOutputs: readonly string[];
  readonly scalars: readonly ClassicRfcScalar[];
  readonly tables: readonly ClassicRfcTable[];
  readonly xrfcParameters: readonly ClassicRfcXrfcParameter[];
}

export interface RfcFunintParameter {
  readonly parameterClass: string;
  readonly parameterName: string;
  readonly tableName: string;
  readonly fieldName: string;
  readonly exid: string;
  readonly position: number;
  readonly offset: number;
  readonly internalLength: number;
  readonly decimals: number;
  readonly defaultValue: string;
  readonly parameterText: string;
  readonly optional: boolean;
}

function characterCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fff) {
    throw new RangeError(`${field} must be an integer in 0..32767`);
  }
}

/** Encode a fixed-width Unicode classic-RFC CHAR value, padded with spaces. */
export function encodeAbapChar(value: string, characters: number): Buffer {
  characterCount(characters, "ABAP CHAR length");
  assertUnicodeScalarText(value, "ABAP CHAR value");
  if (value.length > characters) {
    throw new RangeError(
      `ABAP CHAR value of ${value.length} characters does not fit CHAR(${characters})`,
    );
  }
  return Buffer.from(value.padEnd(characters, " "), "utf16le");
}

function decodeAbapCharacterBytes(
  value: Uint8Array,
  expectedCharacters: number | undefined,
): string {
  const encoded = Buffer.from(value);
  if ((encoded.byteLength & 1) !== 0) {
    throw new RangeError("Unicode ABAP CHAR must have an even byte length");
  }
  if (expectedCharacters !== undefined) {
    characterCount(expectedCharacters, "expected ABAP CHAR length");
    const expectedBytes = expectedCharacters * 2;
    if (encoded.byteLength !== expectedBytes) {
      throw new RangeError(
        `Unicode ABAP CHAR must contain exactly ${expectedBytes} bytes; ` +
          `received ${encoded.byteLength}`,
      );
    }
  }
  const decoded = encoded.toString("utf16le");
  assertUnicodeScalarText(decoded, "decoded ABAP CHAR value");
  return decoded;
}

/** Decode fixed or variable Unicode classic-RFC CHAR bytes and strip padding. */
export function decodeAbapChar(
  value: Uint8Array,
  expectedCharacters?: number,
): string {
  return decodeAbapCharacterBytes(value, expectedCharacters).replace(/ +$/u, "");
}

/** Decode an exact-width character value whose spaces are semantic data. */
export function decodeAbapFixedChar(
  value: Uint8Array,
  expectedCharacters: number,
): string {
  return decodeAbapCharacterBytes(value, expectedCharacters);
}

function decodeParameterName(value: Uint8Array, field: string): string {
  const name = decodeAbapChar(value);
  if (name.length === 0 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(`${field} is not a valid non-empty RFC parameter name`);
  }
  return name;
}

/**
 * Decode the eight-byte classic table header observed in Unicode CUT calls.
 * The header exposes a declared row width. Uncompressed row bytes are retained
 * exactly for the metadata-aware consumer; simple-compressed records repeat
 * their last byte to the declared width.
 */
export function decodeRfcTableHeader(value: Uint8Array): RfcTableHeader {
  if (value.byteLength !== 8) {
    throw new RangeError(
      `classic RFC table header must contain exactly 8 bytes; received ${value.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(value, "classic RFC table header");
  const declaredRowByteLength = reader.readUInt32BE("declaredRowByteLength");
  const rowCount = reader.readUInt32BE("rowCount");
  reader.finish();
  return { declaredRowByteLength, rowCount };
}

const NON_APPLICATION_TAGS = new Set<number>([
  CpicTag.ResponseContext,
  CpicTag.Session,
  CpicTag.Unresolved0420,
  CpicTag.CallContext,
  CpicTag.Program,
  0x0667,
  CpicTag.End,
]);

function decodeSimpleCompressedTableRow(
  value: Uint8Array,
  declaredRowByteLength: number,
  tableName: string,
  rowIndex: number,
  borrowOwnedValue: boolean,
): Buffer {
  const path =
    `classic RFC table ${tableName} simple-compressed row ${rowIndex}`;
  const encodedByteLength = intrinsicUint8ArrayByteLength(value);
  if (encodedByteLength === 0) {
    throw new Error(
      `classic RFC table ${tableName} simple-compressed row ${rowIndex} is empty`,
    );
  }
  if (encodedByteLength > declaredRowByteLength) {
    throw new Error(
      `classic RFC table ${tableName} simple-compressed row ${rowIndex} has ` +
        `${encodedByteLength} encoded bytes; declared row width is ` +
        `${declaredRowByteLength}`,
    );
  }
  if (encodedByteLength === declaredRowByteLength) {
    return borrowOwnedValue
      ? borrowedWireBuffer(value, path)
      : snapshotUint8Array(value, path, encodedByteLength);
  }
  if (declaredRowByteLength > DEFAULT_MAX_CPIC_FIELD_LENGTH) {
    throw new RangeError(
      `classic RFC table ${tableName} simple-compressed row ${rowIndex} ` +
        `expands to ${declaredRowByteLength} bytes; maximum is ` +
        `${DEFAULT_MAX_CPIC_FIELD_LENGTH}`,
    );
  }
  const decoded = Buffer.alloc(
    declaredRowByteLength,
    borrowedWireBuffer(value, path)[encodedByteLength - 1]!,
  );
  decoded.set(intrinsicUint8ArrayView(value, path), 0);
  return decoded;
}

/**
 * Decode one retained simple-compressed classic-RFC table row.
 *
 * @internal
 */
export function decodeSimpleCompressedRfcTableRow(
  value: Uint8Array,
  declaredRowByteLength: number,
  tableName: string,
  rowIndex: number,
): Buffer {
  return decodeSimpleCompressedTableRow(
    value,
    declaredRowByteLength,
    tableName,
    rowIndex,
    false,
  );
}

function borrowedWireBuffer(value: Uint8Array, path: string): Buffer {
  const view = intrinsicUint8ArrayView(value, path);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function retainedWireBuffer(
  value: Uint8Array,
  path: string,
  borrowOwnedValue: boolean,
): Buffer {
  return borrowOwnedValue
    ? borrowedWireBuffer(value, path)
    : snapshotUint8Array(value, path, intrinsicUint8ArrayByteLength(value));
}

function preflightClassicRfcResultBytes(fields: readonly CpicField[]): void {
  if (fields.length > DEFAULT_MAX_CPIC_FIELD_COUNT) {
    throw new RangeError(
      `classic RFC result field count exceeds ${DEFAULT_MAX_CPIC_FIELD_COUNT}`,
    );
  }
  let valueBytes = 0n;
  const maximum = BigInt(DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH);
  for (const field of fields) {
    valueBytes += BigInt(intrinsicUint8ArrayByteLength(field.value));
    if (valueBytes > maximum) {
      throw new RangeError(
        `classic RFC result field bytes ${valueBytes} exceed ${maximum}`,
      );
    }
  }
}

function preflightClassicRfcTableBytes(fields: readonly CpicField[]): void {
  let resultDecodedBytes = 0n;
  const tableLimit = BigInt(DEFAULT_MAX_CLASSIC_RFC_TABLE_DECODED_BYTES);
  const resultLimit = BigInt(DEFAULT_MAX_CLASSIC_RFC_RESULT_TABLE_DECODED_BYTES);

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.tag !== CpicTag.TableName) continue;
    const headerField = fields[index + 1];
    if (headerField?.tag !== CpicTag.TableHeader) continue;

    const name = decodeParameterName(field.value, "table parameter name");
    const header = decodeRfcTableHeader(headerField.value);
    let tableDecodedBytes = 0n;
    let rowCount = 0;
    let cursor = index + 2;
    while (
      rowCount < header.rowCount &&
      (fields[cursor]?.tag === CpicTag.TableContent ||
        fields[cursor]?.tag === CpicTag.TableCompr)
    ) {
      const row = fields[cursor]!;
      const encodedByteLength = intrinsicUint8ArrayByteLength(row.value);
      if (encodedByteLength === 0) {
        throw new Error(
          `classic RFC table ${name} ${row.tag === CpicTag.TableCompr
            ? "simple-compressed"
            : "uncompressed"} row ${rowCount} is empty`,
        );
      }
      if (
        (row.tag === CpicTag.TableContent || row.tag === CpicTag.TableCompr) &&
        encodedByteLength > header.declaredRowByteLength
      ) {
        const encodedLabel = row.tag === CpicTag.TableCompr ? " encoded" : "";
        throw new Error(
          `classic RFC table ${name} ${row.tag === CpicTag.TableCompr
            ? "simple-compressed"
            : "uncompressed"} row ${rowCount} has ${encodedByteLength}${encodedLabel} ` +
            `bytes; declared row width is ${header.declaredRowByteLength}`,
        );
      }
      if (
        row.tag === CpicTag.TableCompr &&
        encodedByteLength < header.declaredRowByteLength &&
        header.declaredRowByteLength > DEFAULT_MAX_CPIC_FIELD_LENGTH
      ) {
        throw new RangeError(
          `classic RFC table ${name} simple-compressed row ${rowCount} ` +
            `expands to ${header.declaredRowByteLength} bytes; maximum is ` +
            `${DEFAULT_MAX_CPIC_FIELD_LENGTH}`,
        );
      }
      tableDecodedBytes += BigInt(
        row.tag === CpicTag.TableCompr
          ? header.declaredRowByteLength
          : encodedByteLength,
      );
      rowCount += 1;
      cursor += 1;
    }
    if (rowCount !== header.rowCount) {
      throw new Error(
        `classic RFC table ${name} declares ${header.rowCount} rows but found ${rowCount}`,
      );
    }
    if (tableDecodedBytes > tableLimit) {
      throw new RangeError(
        `classic RFC table ${name} decoded bytes ${tableDecodedBytes} ` +
          `exceed table limit ${tableLimit}`,
      );
    }
    resultDecodedBytes += tableDecodedBytes;
    if (resultDecodedBytes > resultLimit) {
      throw new RangeError(
        `classic RFC decoded table bytes ${resultDecodedBytes} ` +
          `exceed result limit ${resultLimit}`,
      );
    }
    index = cursor - 1;
  }
}

/**
 * Group a decoded function response into lossless classic scalar/table wire
 * values. Unknown application records are rejected so a protocol change cannot
 * be mistaken for a successful, partially decoded call. This syntax-layer API
 * deliberately retains a bounded short uncompressed row because the raw field
 * stream has no structure metadata with which to decide whether a named wire
 * owner permits it. `decodeClassicRfcInvocationResult` is the public-call
 * semantic boundary and rejects every short ordinary row except an explicitly
 * evidence-owned metadata case.
 */
export function decodeClassicRfcResult(
  fields: readonly CpicField[],
): ClassicRfcResult {
  return decodeClassicRfcResultWithOwnership(fields, false);
}

/**
 * Decode values already owned by the current CPIC session without retaining a
 * second full reply snapshot. The returned buffers may borrow `fields` and
 * must therefore be consumed synchronously before those fields are released.
 * @internal
 */
export function decodeOwnedClassicRfcResult(
  fields: readonly CpicField[],
): ClassicRfcResult {
  return decodeClassicRfcResultWithOwnership(fields, true);
}

function decodeClassicRfcResultWithOwnership(
  fields: readonly CpicField[],
  borrowOwnedValues: boolean,
): ClassicRfcResult {
  preflightClassicRfcResultBytes(fields);
  preflightClassicRfcTableBytes(fields);
  const requestedOutputs: string[] = [];
  const scalars: ClassicRfcScalar[] = [];
  const tables: ClassicRfcTable[] = [];
  const xrfcParameters: ClassicRfcXrfcParameter[] = [];
  const names = new Set<string>();

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (NON_APPLICATION_TAGS.has(field.tag)) continue;

    if (field.tag === CpicTag.RequestedOutput) {
      requestedOutputs.push(
        decodeParameterName(field.value, "requested output name"),
      );
      continue;
    }

    if (field.tag === CpicTag.XRfcData) {
      throw new Error("classic RFC response contains xRFC XML data without an opening boundary");
    }
    if (field.tag === CpicTag.XRfcParameter) {
      if (field.value.byteLength !== 0) {
        throw new Error("classic RFC xRFC XML opening boundary must be empty");
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      index += 1;
      while (fields[index]?.tag === CpicTag.XRfcData) {
        const chunk = fields[index]!.value;
        if (chunk.byteLength === 0) {
          throw new Error("classic RFC xRFC XML data chunk must not be empty");
        }
        byteLength += chunk.byteLength;
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength > DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH
        ) {
          throw new RangeError(
            `classic RFC xRFC XML parameter exceeds ${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH} bytes`,
          );
        }
        chunks.push(borrowedWireBuffer(chunk, "classic RFC xRFC XML data chunk"));
        index += 1;
      }
      if (chunks.length === 0) {
        throw new Error("classic RFC xRFC XML boundary contains no data chunk");
      }
      const closing = fields[index];
      if (closing?.tag !== CpicTag.XRfcParameter) {
        throw new Error("classic RFC xRFC XML parameter lacks its closing boundary");
      }
      if (closing.value.byteLength !== 0) {
        throw new Error("classic RFC xRFC XML closing boundary must be empty");
      }
      xrfcParameters.push({
        value: borrowOwnedValues && chunks.length === 1
          ? chunks[0]!
          : Buffer.concat(chunks, byteLength),
        chunkCount: chunks.length,
      });
      continue;
    }

    if (field.tag === CpicTag.ParameterValue) {
      throw new Error("classic RFC response contains a value without a parameter name");
    }
    if (
      field.tag === CpicTag.TableHeader ||
      field.tag === CpicTag.TableContent ||
      field.tag === CpicTag.TableCompr
    ) {
      throw new Error("classic RFC response contains a table record without a table name");
    }

    if (field.tag === CpicTag.ParameterName) {
      const name = decodeParameterName(field.value, "scalar parameter name");
      const valueField = fields[index + 1];
      if (valueField?.tag !== CpicTag.ParameterValue) {
        throw new Error(`classic RFC scalar ${name} is not followed by its value`);
      }
      if (names.has(name)) {
        throw new Error(`classic RFC response contains duplicate parameter ${name}`);
      }
      names.add(name);
      scalars.push({
        name,
        value: retainedWireBuffer(
          valueField.value,
          `classic RFC scalar ${name}`,
          borrowOwnedValues,
        ),
      });
      index += 1;
      continue;
    }

    if (field.tag === CpicTag.TableName) {
      const name = decodeParameterName(field.value, "table parameter name");
      const headerField = fields[index + 1];
      if (headerField?.tag !== CpicTag.TableHeader) {
        throw new Error(`classic RFC table ${name} is not followed by its header`);
      }
      if (names.has(name)) {
        throw new Error(`classic RFC response contains duplicate parameter ${name}`);
      }
      const header = decodeRfcTableHeader(headerField.value);
      const rows: Buffer[] = [];
      let rowEncoding: ClassicRfcTable["rowEncoding"] = "empty";
      let rowCompression: ClassicRfcTable["rowCompression"] = "empty";
      let sawUncompressed = false;
      let sawSimpleCompressed = false;
      let rowByteLength = header.declaredRowByteLength;
      index += 2;
      while (
        rows.length < header.rowCount &&
        (fields[index]?.tag === CpicTag.TableContent ||
          fields[index]?.tag === CpicTag.TableCompr)
      ) {
        const rowField = fields[index]!;
        const encoded = rowField.value;
        let row: Buffer;
        if (rowField.tag === CpicTag.TableCompr) {
          sawSimpleCompressed = true;
          row = decodeSimpleCompressedTableRow(
            encoded,
            header.declaredRowByteLength,
            name,
            rows.length,
            borrowOwnedValues,
          );
        } else {
          sawUncompressed = true;
          row = retainedWireBuffer(
            encoded,
            `classic RFC table ${name} uncompressed row ${rows.length}`,
            borrowOwnedValues,
          );
          if (row.byteLength === 0) {
            throw new Error(
              `classic RFC table ${name} uncompressed row ${rows.length} is empty`,
            );
          }
          if (row.byteLength > header.declaredRowByteLength) {
            throw new Error(
              `classic RFC table ${name} uncompressed row ${rows.length} has ` +
                `${row.byteLength} bytes; declared row width is ` +
                `${header.declaredRowByteLength}`,
            );
          }
        }
        if (rows.length === 0) {
          rowByteLength = row.byteLength;
        }
        rows.push(row);
        index += 1;
      }
      if (rows.length !== header.rowCount) {
        throw new Error(
          `classic RFC table ${name} declares ${header.rowCount} rows but found ${rows.length}`,
        );
      }
      if (sawUncompressed && sawSimpleCompressed) {
        rowEncoding = "mixed";
        rowCompression = "mixed";
      } else if (sawUncompressed) {
        rowEncoding = "flat";
        rowCompression = "none";
      } else if (sawSimpleCompressed) {
        rowEncoding = "structured";
        rowCompression = "simple";
      }
      index -= 1;
      names.add(name);
      tables.push({
        name,
        declaredRowByteLength: header.declaredRowByteLength,
        rowByteLength,
        rowEncoding,
        rowCompression,
        rows,
      });
      continue;
    }

    throw new Error(
      `classic RFC response contains unsupported tag 0x${field.tag
        .toString(16)
        .padStart(4, "0")}`,
    );
  }

  return { requestedOutputs, scalars, tables, xrfcParameters };
}

/**
 * Decode one Unicode RFC_FUNINT row returned by metadata bootstrap.
 *
 * The row width is a property of the peer's release, not of the wire format:
 * later releases append fields to RFC_FUNINT, and one profile is already
 * evidenced declaring a 404-byte row. Bound the row below by the stable prefix
 * this decoder consumes and ignore anything appended after it, exactly as
 * `decodeDdIfDfiesRow` does for DFIES. A short row is still refused - completing
 * one with ABAP initial bytes would invent values the peer never sent.
 */
export function decodeRfcFunintRow(value: Uint8Array): RfcFunintParameter {
  if (value.byteLength < RFC_FUNINT_UNICODE_ROW_LENGTH) {
    throw new RangeError(
      `Unicode RFC_FUNINT row must contain at least ${RFC_FUNINT_UNICODE_ROW_LENGTH} ` +
        `bytes; received ${value.byteLength}`,
    );
  }
  const reader = new CheckedByteReader(
    value.subarray(0, RFC_FUNINT_UNICODE_ROW_LENGTH),
    "RFC_FUNINT row",
  );
  const result = {
    parameterClass: decodeAbapChar(reader.readBytes(2, "PARAMCLASS"), 1),
    parameterName: decodeAbapChar(reader.readBytes(60, "PARAMETER"), 30),
    tableName: decodeAbapChar(reader.readBytes(60, "TABNAME"), 30),
    fieldName: decodeAbapChar(reader.readBytes(60, "FIELDNAME"), 30),
    exid: decodeAbapChar(reader.readBytes(2, "EXID"), 1),
    position: reader.readInt32LE("POSITION"),
    offset: reader.readInt32LE("OFFSET"),
    internalLength: reader.readInt32LE("INTLENGTH"),
    decimals: reader.readInt32LE("DECIMALS"),
    defaultValue: decodeAbapChar(reader.readBytes(42, "DEFAULT"), 21),
    parameterText: decodeAbapChar(reader.readBytes(158, "PARAMTEXT"), 79),
    optionalText: decodeAbapChar(reader.readBytes(2, "OPTIONAL"), 1),
  };
  reader.finish();
  if (result.optionalText !== "" && result.optionalText !== "X") {
    throw new Error(`RFC_FUNINT OPTIONAL contains unsupported value ${result.optionalText}`);
  }
  return {
    parameterClass: result.parameterClass,
    parameterName: result.parameterName,
    tableName: result.tableName,
    fieldName: result.fieldName,
    exid: result.exid,
    position: result.position,
    offset: result.offset,
    internalLength: result.internalLength,
    decimals: result.decimals,
    defaultValue: result.defaultValue,
    parameterText: result.parameterText,
    optional: result.optionalText === "X",
  };
}
