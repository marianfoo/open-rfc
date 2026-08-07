import type {
  RfcStructureDefinition,
  RfcStructureField,
} from "../metadata/rfc-structure-definition.js";
import {
  decodeAbapChar,
  decodeAbapFixedChar,
  encodeAbapChar,
} from "../protocol/classic-rfc.js";
import { DEFAULT_MAX_CPIC_FIELD_LENGTH } from "../protocol/cpic.js";
import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";
import {
  decodePackedDecimal,
  encodePackedDecimal,
  type PackedDecimalInput,
} from "./packed-decimal.js";
import {
  classicDatePublicText,
  classicDateWireText,
  classicTimePublicText,
  classicTimeWireText,
  classicTemporalByteLength,
  classicTemporalInitialValue,
  decodeClassicTemporal,
  encodeClassicTemporal,
  isClassicTemporalExid,
} from "./classic-temporal.js";
import {
  decodeDecimalFloat16,
  decodeDecimalFloat34,
  encodeDecimalFloat16,
  encodeDecimalFloat34,
  type DecimalFloatInput,
} from "./decimal-float.js";
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

export type ClassicStructureInput = Readonly<Record<string, unknown>>;
export type ClassicStructureOutput = Readonly<Record<string, unknown>>;

export interface ClassicStructureCodecOptions {
  /** Exact JavaScript representation for ABAP signed INT8 values. */
  readonly int8Mode?: ClassicInt8Mode;
  /** JavaScript projection for ABAP BCD and DECF16/DECF34 outputs. */
  readonly bcd?: ClassicBcdMode;
}

const MAX_CLASSIC_STRUCTURE_FIELDS = 100_000;
// A fixed structure travels in one CPIC field, so it must not exceed the
// transport's per-field allocation policy.
const MAX_CLASSIC_STRUCTURE_BYTE_LENGTH = DEFAULT_MAX_CPIC_FIELD_LENGTH;
const validatedStructureDefinitions = new WeakSet<object>();

/** Snapshot and validate fixed structure geometry before value allocation. */
export function snapshotClassicStructureDefinition(
  definition: RfcStructureDefinition,
  requestedName?: string,
): RfcStructureDefinition {
  if (typeof definition !== "object" || definition === null) {
    throw new TypeError("classic structure definition must be an object");
  }
  if (validatedStructureDefinitions.has(definition)) return definition;

  const name = definition.name;
  const byteLength = definition.byteLength;
  const source = definition.fields;
  const expectedName = requestedName ?? name;
  if (typeof name !== "string" || name.length === 0 || name !== expectedName) {
    throw new Error(`${expectedName} structure definition has an invalid name`);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`${name} structure byteLength must be a non-negative safe integer`);
  }
  if (byteLength > MAX_CLASSIC_STRUCTURE_BYTE_LENGTH) {
    throw new RangeError(
      `${name} structure byteLength exceeds ${MAX_CLASSIC_STRUCTURE_BYTE_LENGTH}`,
    );
  }
  if (!Array.isArray(source)) {
    throw new TypeError(`${name} structure fields must be an array`);
  }
  const count = source.length;
  if (!Number.isSafeInteger(count) || count > MAX_CLASSIC_STRUCTURE_FIELDS) {
    throw new RangeError(
      `${name} structure field count exceeds ${MAX_CLASSIC_STRUCTURE_FIELDS}`,
    );
  }

  const fields: RfcStructureField[] = [];
  const names = new Set<string>();
  let previousEnd = 0;
  for (let index = 0; index < count; index += 1) {
    const sourceField = source[index];
    if (typeof sourceField !== "object" || sourceField === null) {
      throw new TypeError(`${name} structure field ${index} must be an object`);
    }
    const field = Object.freeze({
      tableName: sourceField.tableName,
      fieldName: sourceField.fieldName,
      position: sourceField.position,
      offset: sourceField.offset,
      internalLength: sourceField.internalLength,
      decimals: sourceField.decimals,
      exid: sourceField.exid,
    });
    if (
      field.tableName !== name ||
      typeof field.fieldName !== "string" ||
      field.fieldName.length === 0 ||
      names.has(field.fieldName) ||
      field.position !== index + 1 ||
      !Number.isSafeInteger(field.offset) ||
      field.offset < previousEnd ||
      !Number.isSafeInteger(field.internalLength) ||
      field.internalLength < 0 ||
      !Number.isSafeInteger(field.decimals) ||
      field.decimals < 0
    ) {
      throw new Error(`${name} structure field ${index} has invalid geometry`);
    }
    const end = field.offset + field.internalLength;
    if (!Number.isSafeInteger(end) || end > byteLength) {
      throw new Error(`${name}.${field.fieldName} exceeds the structure byteLength`);
    }
    names.add(field.fieldName);
    previousEnd = end;
    fields.push(field);
  }

  const snapshot = Object.freeze({
    name,
    byteLength,
    fields: Object.freeze(fields),
  });
  validatedStructureDefinitions.add(snapshot);
  return snapshot;
}

function path(definition: RfcStructureDefinition, field: RfcStructureField): string {
  return `${definition.name}.${field.fieldName}`;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  fieldPath: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${fieldPath} must be an integer in ${minimum}..${maximum}`,
    );
  }
  return value;
}

function characterLength(field: RfcStructureField, fieldPath: string): number {
  if ((field.internalLength & 1) !== 0) {
    throw new Error(`${fieldPath} Unicode character width must be even`);
  }
  return field.internalLength / 2;
}

function initialValue(
  field: RfcStructureField,
  fieldPath: string,
  int8Mode: ClassicInt8Mode,
): unknown {
  if (isClassicTemporalExid(field.exid)) {
    return classicTemporalInitialValue(field.exid);
  }
  switch (field.exid) {
    case "C":
      return "";
    case "N":
      return "0".repeat(characterLength(field, fieldPath));
    case "D":
      return "00000000";
    case "T":
      return "000000";
    case "X":
      return Buffer.alloc(0);
    case "F":
    case "I":
    case "s":
    case "b":
      return 0;
    case "8":
      return classicInt8InitialValue(int8Mode);
    case "P":
      return "0";
    case "a":
    case "e":
      return "0";
    default:
      throw new Error(`${fieldPath} classic RFC type ${field.exid} is not implemented`);
  }
}

function assertFieldCodec(field: RfcStructureField, fieldPath: string): void {
  if (isClassicTemporalExid(field.exid)) {
    const byteLength = classicTemporalByteLength(field.exid);
    if (field.internalLength !== byteLength) {
      throw new Error(
        `${fieldPath} compact temporal type ${field.exid} must occupy ${byteLength} bytes`,
      );
    }
    return;
  }
  switch (field.exid) {
    case "C":
    case "N":
      characterLength(field, fieldPath);
      return;
    case "D":
      if (field.internalLength !== 16) {
        throw new Error(`${fieldPath} DATE must occupy 16 Unicode bytes`);
      }
      return;
    case "T":
      if (field.internalLength !== 12) {
        throw new Error(`${fieldPath} TIME must occupy 12 Unicode bytes`);
      }
      return;
    case "X":
      return;
    case "F":
      if (field.internalLength !== 8) {
        throw new Error(`${fieldPath} FLOAT must occupy 8 bytes`);
      }
      return;
    case "I":
      if (field.internalLength !== 4) {
        throw new Error(`${fieldPath} INT4 must occupy 4 bytes`);
      }
      return;
    case "s":
      if (field.internalLength !== 2) {
        throw new Error(`${fieldPath} INT2 must occupy 2 bytes`);
      }
      return;
    case "b":
      if (field.internalLength !== 1) {
        throw new Error(`${fieldPath} INT1 must occupy 1 byte`);
      }
      return;
    case "8":
      if (field.internalLength !== 8) {
        throw new Error(`${fieldPath} INT8 must occupy 8 bytes`);
      }
      return;
    case "P":
      // The encoder owns the exact 1..16 byte and decimal-scale rules.
      encodePackedDecimal("0", field.internalLength, field.decimals, fieldPath);
      return;
    case "a":
      if (field.internalLength !== 8) {
        throw new Error(`${fieldPath} DECF16 must occupy 8 bytes`);
      }
      return;
    case "e":
      if (field.internalLength !== 16) {
        throw new Error(`${fieldPath} DECF34 must occupy 16 bytes`);
      }
      return;
    case "g":
      if (field.internalLength !== 8) {
        throw new Error(`${fieldPath} STRING descriptor must occupy 8 bytes`);
      }
      return;
    case "y":
      if (field.internalLength !== 8) {
        throw new Error(`${fieldPath} XSTRING descriptor must occupy 8 bytes`);
      }
      return;
    default:
      throw new Error(`${fieldPath} classic RFC type ${field.exid} is not implemented`);
  }
}

/** Validate every field and the captured Unicode classic-row geometry. */
export function validateClassicStructureCodec(
  definition: RfcStructureDefinition,
  requestedName?: string,
): RfcStructureDefinition {
  const normalized = snapshotClassicStructureDefinition(definition, requestedName);
  for (const field of normalized.fields) {
    assertFieldCodec(field, path(normalized, field));
  }
  return normalized;
}

/** True when the structure requires the xRFC XML deep-value serializer. */
export function classicStructureHasDynamicFields(
  definition: RfcStructureDefinition,
): boolean {
  const normalized = validateClassicStructureCodec(definition);
  return normalized.fields.some(
    (field) => field.exid === "g" || field.exid === "y",
  );
}

function assertFixedStructure(
  definition: RfcStructureDefinition,
): void {
  if (classicStructureHasDynamicFields(definition)) {
    throw new Error(
      `${definition.name} contains STRING/XSTRING fields and requires xRFC XML serialization`,
    );
  }
}

function writeValue(
  target: Buffer,
  definition: RfcStructureDefinition,
  field: RfcStructureField,
  value: unknown,
  int8Mode: ClassicInt8Mode,
): void {
  const fieldPath = path(definition, field);
  const offset = field.offset;
  if (isClassicTemporalExid(field.exid)) {
    const byteLength = classicTemporalByteLength(field.exid);
    if (field.internalLength !== byteLength) {
      throw new Error(
        `${fieldPath} compact temporal type ${field.exid} must occupy ${byteLength} bytes`,
      );
    }
    encodeClassicTemporal(field.exid, value as string, fieldPath).copy(
      target,
      offset,
    );
    return;
  }
  switch (field.exid) {
    case "C": { // fixed CHAR
      if (typeof value !== "string") throw new TypeError(`${fieldPath} expects a string`);
      encodeAbapChar(value, characterLength(field, fieldPath)).copy(target, offset);
      return;
    }
    case "N": { // NUMC
      const characters = characterLength(field, fieldPath);
      if (typeof value !== "string" || !/^\d*$/u.test(value) || value.length > characters) {
        throw new TypeError(
          `${fieldPath} expects at most ${characters} decimal digits`,
        );
      }
      encodeAbapChar(value.padStart(characters, "0"), characters).copy(target, offset);
      return;
    }
    case "D": { // YYYYMMDD
      if (field.internalLength !== 16) {
        throw new Error(`${fieldPath} DATE must occupy 16 Unicode bytes`);
      }
      if (typeof value !== "string") throw new TypeError(`${fieldPath} expects YYYYMMDD`);
      Buffer.from(classicDateWireText(value, fieldPath), "utf16le").copy(
        target,
        offset,
      );
      return;
    }
    case "T": { // HHMMSS
      if (field.internalLength !== 12) {
        throw new Error(`${fieldPath} TIME must occupy 12 Unicode bytes`);
      }
      if (typeof value !== "string") throw new TypeError(`${fieldPath} expects HHMMSS`);
      Buffer.from(classicTimeWireText(value, fieldPath), "utf16le").copy(
        target,
        offset,
      );
      return;
    }
    case "X": { // fixed RAW/BYTE
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${fieldPath} expects Uint8Array bytes`);
      }
      const byteLength = intrinsicUint8ArrayByteLength(value);
      if (byteLength > field.internalLength) {
        throw new RangeError(
          `${fieldPath} accepts at most ${field.internalLength} bytes`,
        );
      }
      snapshotUint8Array(value, fieldPath, byteLength).copy(target, offset);
      return;
    }
    case "F": { // IEEE-754 binary64 for the admitted Unicode-4103 profile
      if (field.internalLength !== 8 || typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${fieldPath} expects a finite 8-byte float`);
      }
      target.writeDoubleLE(value, offset);
      return;
    }
    case "I":
      if (field.internalLength !== 4) throw new Error(`${fieldPath} INT4 must occupy 4 bytes`);
      target.writeInt32LE(integer(value, -0x8000_0000, 0x7fff_ffff, fieldPath), offset);
      return;
    case "s":
      if (field.internalLength !== 2) throw new Error(`${fieldPath} INT2 must occupy 2 bytes`);
      target.writeInt16LE(integer(value, -0x8000, 0x7fff, fieldPath), offset);
      return;
    case "b":
      if (field.internalLength !== 1) throw new Error(`${fieldPath} INT1 must occupy 1 byte`);
      target.writeUInt8(integer(value, 0, 0xff, fieldPath), offset);
      return;
    case "8": { // signed INT8
      if (field.internalLength !== 8) throw new Error(`${fieldPath} INT8 must occupy 8 bytes`);
      target.writeBigInt64LE(
        encodeClassicInt8(value, int8Mode, fieldPath),
        offset,
      );
      return;
    }
    case "P":
      encodePackedDecimal(
        value as PackedDecimalInput,
        field.internalLength,
        field.decimals,
        fieldPath,
      ).copy(target, offset);
      return;
    case "a":
      if (field.internalLength !== 8) {
        throw new Error(`${fieldPath} DECF16 must occupy 8 bytes`);
      }
      encodeDecimalFloat16(value as DecimalFloatInput, fieldPath).copy(
        target,
        offset,
      );
      return;
    case "e":
      if (field.internalLength !== 16) {
        throw new Error(`${fieldPath} DECF34 must occupy 16 bytes`);
      }
      encodeDecimalFloat34(value as DecimalFloatInput, fieldPath).copy(
        target,
        offset,
      );
      return;
    default:
      throw new Error(`${fieldPath} classic RFC type ${field.exid} is not implemented`);
  }
}

function readValue(
  source: Buffer,
  definition: RfcStructureDefinition,
  field: RfcStructureField,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
): unknown {
  const fieldPath = path(definition, field);
  const value = source.subarray(field.offset, field.offset + field.internalLength);
  if (isClassicTemporalExid(field.exid)) {
    return decodeClassicTemporal(field.exid, value, fieldPath);
  }
  switch (field.exid) {
    case "C":
      return decodeAbapChar(value, characterLength(field, fieldPath));
    case "N":
      return decodeAbapChar(value, characterLength(field, fieldPath));
    case "D": {
      const decoded = decodeAbapFixedChar(
        value,
        characterLength(field, fieldPath),
      );
      return classicDatePublicText(decoded, fieldPath);
    }
    case "T": {
      const decoded = decodeAbapFixedChar(
        value,
        characterLength(field, fieldPath),
      );
      return classicTimePublicText(decoded, fieldPath);
    }
    case "X":
      return Buffer.from(value);
    case "F": {
      if (field.internalLength !== 8) throw new Error(`${fieldPath} FLOAT must occupy 8 bytes`);
      const decoded = source.readDoubleLE(field.offset);
      if (!Number.isFinite(decoded)) {
        throw new TypeError(`${fieldPath} received a non-finite 8-byte float`);
      }
      return decoded;
    }
    case "I":
      if (field.internalLength !== 4) throw new Error(`${fieldPath} INT4 must occupy 4 bytes`);
      return source.readInt32LE(field.offset);
    case "s":
      if (field.internalLength !== 2) throw new Error(`${fieldPath} INT2 must occupy 2 bytes`);
      return source.readInt16LE(field.offset);
    case "b":
      if (field.internalLength !== 1) throw new Error(`${fieldPath} INT1 must occupy 1 byte`);
      return source.readUInt8(field.offset);
    case "8":
      if (field.internalLength !== 8) throw new Error(`${fieldPath} INT8 must occupy 8 bytes`);
      return decodeClassicInt8(
        source.readBigInt64LE(field.offset),
        int8Mode,
        fieldPath,
      );
    case "P":
      return projectClassicBcdOutput(
        decodePackedDecimal(value, field.decimals, fieldPath),
        bcd,
        fieldPath,
      );
    case "a":
      return projectClassicBcdOutput(
        decodeDecimalFloat16(value, fieldPath),
        bcd,
        fieldPath,
      );
    case "e":
      return projectClassicBcdOutput(
        decodeDecimalFloat34(value, fieldPath),
        bcd,
        fieldPath,
      );
    default:
      throw new Error(`${fieldPath} classic RFC type ${field.exid} is not implemented`);
  }
}

/** Encode one fixed-layout classic Unicode structure. */
export function encodeClassicStructure(
  definition: RfcStructureDefinition,
  input: ClassicStructureInput,
  options: ClassicStructureCodecOptions = {},
): Buffer {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("classic structure codec options must be an object");
  }
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  snapshotClassicBcdMode(options.bcd);
  const normalized = validateClassicStructureCodec(definition);
  assertFixedStructure(normalized);
  const fields = new Map(
    normalized.fields.map((field) => [field.fieldName, field]),
  );
  for (const name of Object.keys(input)) {
    if (!fields.has(name)) {
      throw new Error(`${normalized.name} contains unknown field ${name}`);
    }
  }
  const result = Buffer.alloc(normalized.byteLength);
  for (let index = 0; index < normalized.fields.length; index += 1) {
    const field = normalized.fields[index]!;
    const supplied = Object.prototype.hasOwnProperty.call(input, field.fieldName);
    writeValue(
      result,
      normalized,
      field,
      supplied
        ? input[field.fieldName]
        : initialValue(field, path(normalized, field), int8Mode),
      int8Mode,
    );
    if (field.exid === "C" || field.exid === "N") {
      const fieldEnd = field.offset + field.internalLength;
      const nextOffset = normalized.fields[index + 1]?.offset ?? normalized.byteLength;
      const paddingLength = nextOffset - fieldEnd;
      if ((paddingLength & 1) !== 0) {
        throw new Error(
          `${path(normalized, field)} has an odd Unicode alignment tail`,
        );
      }
      if (paddingLength > 0) {
        const fill = field.exid === "C" ? " " : "0";
        Buffer.from(fill.repeat(paddingLength / 2), "utf16le").copy(
          result,
          fieldEnd,
        );
      }
    }
  }
  return result;
}

/** Decode one fixed-layout classic Unicode structure into plain values. */
export function decodeClassicStructure(
  definition: RfcStructureDefinition,
  value: Uint8Array,
  options: ClassicStructureCodecOptions = {},
): ClassicStructureOutput {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("classic structure codec options must be an object");
  }
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  const normalized = validateClassicStructureCodec(definition);
  assertFixedStructure(normalized);
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${normalized.name} structure expects Uint8Array bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength !== normalized.byteLength) {
    throw new RangeError(
      `${normalized.name} structure must contain exactly ${normalized.byteLength} ` +
        `bytes; received ${byteLength}`,
    );
  }
  const source = snapshotUint8Array(value, normalized.name, byteLength);
  const result: Record<string, unknown> = {};
  for (const field of normalized.fields) {
    Object.defineProperty(result, field.fieldName, {
      value: readValue(
        source,
        normalized,
        field,
        int8Mode,
        bcd,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
