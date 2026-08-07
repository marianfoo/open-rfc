import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import { createRecursiveMetadataParameterIndex } from
  "../metadata/recursive-parameter-index.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import {
  decodeAbapChar,
  decodeAbapFixedChar,
  decodeClassicRfcResult,
  decodeOwnedClassicRfcResult,
  encodeAbapChar,
  type RfcFunintParameter,
} from "../protocol/classic-rfc.js";
import {
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
  DEFAULT_MAX_CPIC_FIELD_COUNT,
  DEFAULT_MAX_CPIC_FIELD_LENGTH,
  CLASSIC_XRFC_XML_CHUNK_LENGTH,
  encodeCpicCutFunctionRequest,
  type CpicField,
} from "../protocol/cpic.js";
import { rfcProFieldHeaderByteLength } from "../protocol/rfcpro.js";
import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";
import {
  decodeClassicStructure,
  encodeClassicStructure,
  classicStructureHasDynamicFields,
  validateClassicStructureCodec,
  type ClassicStructureInput,
} from "../values/classic-structure.js";
import {
  decodeClassicXrfcParameter,
  encodeClassicXrfcParameter,
  validateClassicXrfcDefinition,
  type ClassicXrfcKind,
} from "../values/classic-xrfc.js";
import {
  decodeRecursiveClassicXrfcParameter,
  encodeRecursiveClassicXrfcParameter,
  resolveRecursiveClassicXrfcParameterFromIndex,
  type ResolvedRecursiveClassicXrfcParameter,
} from "../values/recursive-classic-xrfc.js";
import {
  decodeResolvedRecursiveXrfcParameter,
  decodeRecursiveXrfcParameterName,
  encodeResolvedRecursiveXrfcParameter,
  resolveRecursiveXrfcParameterFromIndex,
  validateRecursiveXrfcParameterFromIndex,
  type ResolvedRecursiveXrfcParameter,
} from "../values/recursive-xrfc.js";
import {
  decodePackedDecimal,
  encodePackedDecimal,
  type PackedDecimalInput,
} from "../values/packed-decimal.js";
import {
  assertNulFreeUnicodeScalarText,
  assertUnicodeScalarText,
} from "../values/unicode-scalar.js";
import { snapshotRfcValue } from "../values/rfc-value-snapshot.js";
import {
  assertClassicDate,
  assertClassicTime,
  classicDatePublicText,
  classicDateWireText,
  classicTimePublicText,
  classicTimeWireText,
  classicTemporalByteLength,
  classicTemporalInitialValue,
  decodeClassicTemporal,
  encodeClassicTemporal,
  isClassicTemporalExid,
} from "../values/classic-temporal.js";
import {
  decodeDecimalFloat16,
  decodeDecimalFloat34,
  encodeDecimalFloat16,
  encodeDecimalFloat34,
  type DecimalFloatInput,
} from "../values/decimal-float.js";
import {
  projectClassicBcdOutput,
  snapshotClassicBcdMode,
  type ClassicBcdMode,
} from "../values/classic-bcd.js";
import {
  classicInt8InitialValue,
  decodeClassicInt8,
  encodeClassicInt8,
  snapshotClassicInt8Mode,
  type ClassicInt8Mode,
} from "../values/classic-int8.js";

export type ClassicRfcInput = Readonly<Record<string, unknown>>;
export type ClassicRfcOutput = Readonly<Record<string, unknown>>;
export type RfcStructureRepository = ReadonlyMap<string, RfcStructureDefinition>;

interface GenericRecursiveXrfcPlan {
  readonly serializer: "recursive-xrfc";
  readonly kind: ClassicXrfcKind;
  readonly parameter: ResolvedRecursiveXrfcParameter;
}

interface ClassicRecursiveXrfcPlan {
  readonly serializer: "recursive-classic-xrfc";
  readonly kind: ClassicXrfcKind;
  readonly parameter: ResolvedRecursiveClassicXrfcParameter;
}

type InvocationRecursiveXrfcPlan =
  | GenericRecursiveXrfcPlan
  | ClassicRecursiveXrfcPlan;
type InvocationRecursiveXrfcRepository = ReadonlyMap<
  string,
  InvocationRecursiveXrfcPlan
>;

export interface ClassicRfcInvocationOptions {
  readonly notRequested?: ReadonlySet<string>;
  /** Explicitly activate an optional parameter at its initial value. */
  readonly activated?: ReadonlySet<string>;
  /** Explicitly deactivate a parameter; deactivation wins over all other state. */
  readonly deactivated?: ReadonlySet<string>;
  /** Maximum encoded CPIC application bytes before any value buffers are built. */
  readonly maxApplicationDataLength?: number;
  /** Exact JavaScript representation for ABAP signed INT8 values. */
  readonly int8Mode?: ClassicInt8Mode;
  /** JavaScript projection for ABAP BCD and DECF16/DECF34 outputs. */
  readonly bcd?: ClassicBcdMode;
}

export interface CapturedClassicRfcInvocation {
  readonly input: ClassicRfcInput;
  readonly options: ClassicRfcInvocationOptions;
}

/** Internal metadata work required by one already-captured invocation. */
export interface ClassicInvocationMetadataNeeds {
  /** Active u/v/h parameters whose value shape must be resolved. */
  readonly containerParameters: ReadonlySet<string>;
  /** Active non-T `u` parameters which may benefit from optimized metadata. */
  readonly optionalRecursive: boolean;
  /** Active non-T `v`/`h` parameters which cannot proceed without it. */
  readonly requiredRecursive: boolean;
}

const CPIC_CUT_FIXED_APPLICATION_BYTES = 6;
const EMPTY_CLASSIC_RFC_INPUT: ReadonlyMap<string, unknown> = new Map();

interface ClassicInvocationMetadata {
  readonly name: string;
  readonly parameters: readonly RfcFunintParameter[];
}

interface ClassicInvocationPreflight {
  readonly scalarByteLengths: ReadonlyMap<string, number>;
  readonly scalarEncodings: ReadonlyMap<string, Buffer>;
  readonly tableRowCounts: ReadonlyMap<string, number>;
  readonly tableRowByteLengths: ReadonlyMap<string, number>;
  readonly xrfcEncodings: ReadonlyMap<string, Buffer>;
}

interface ActiveInputValue {
  readonly present: boolean;
  readonly value?: unknown;
}

function defineClassicRfcOutput(
  output: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  Object.defineProperty(output, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function initialScalarValue(
  parameter: RfcFunintParameter,
  int8Mode: ClassicInt8Mode = "bigint",
): unknown {
  if (isClassicTemporalExid(parameter.exid)) {
    return classicTemporalInitialValue(parameter.exid);
  }
  switch (parameter.exid) {
    case "C":
    case "N":
    case "g":
      return "";
    case "D":
      return "00000000";
    case "T":
      return "000000";
    case "X":
    case "y":
      return Buffer.alloc(0);
    case "F":
    case "I":
    case "s":
    case "b":
      return 0;
    case "8":
      return classicInt8InitialValue(int8Mode);
    case "P":
      return "";
    case "a":
    case "e":
      return "0";
    case "u":
    case "v":
      return Object.freeze({});
    case "h":
      return Object.freeze([]);
    default:
      throw new Error(
        `${parameter.parameterName} classic RFC type ${parameter.exid} is not implemented`,
      );
  }
}

function activeInputValue(
  parameter: RfcFunintParameter,
  input: ReadonlyMap<string, unknown>,
  activated: ReadonlySet<string>,
  deactivated: ReadonlySet<string>,
  int8Mode: ClassicInt8Mode = "bigint",
): ActiveInputValue {
  if (deactivated.has(parameter.parameterName)) {
    return Object.freeze({ present: false });
  }
  if (input.has(parameter.parameterName)) {
    return Object.freeze({
      present: true,
      value: input.get(parameter.parameterName),
    });
  }
  // NW RFC function containers start mandatory input directions active at
  // their ABAP initial value. Optional inputs remain inactive until a value is
  // supplied or the caller explicitly activates them.
  if (parameter.optional && !activated.has(parameter.parameterName)) {
    return Object.freeze({ present: false });
  }
  return Object.freeze({
    present: true,
    value: parameter.parameterClass === "T"
      ? Object.freeze([])
      : initialScalarValue(parameter, int8Mode),
  });
}

function requestsOutput(
  parameter: RfcFunintParameter,
  input: ReadonlyMap<string, unknown>,
  activated: ReadonlySet<string>,
  deactivated: ReadonlySet<string>,
): boolean {
  if (deactivated.has(parameter.parameterName)) return false;
  if (parameter.parameterClass === "E") return true;
  if (
    parameter.parameterClass === "C" ||
    parameter.parameterClass === "T"
  ) {
    return activeInputValue(
      parameter,
      input,
      activated,
      deactivated,
    ).present;
  }
  return false;
}

function snapshotParameter(
  value: RfcFunintParameter,
  index: number,
): RfcFunintParameter {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`metadata parameter ${index} must be an object`);
  }
  return Object.freeze({
    parameterClass: value.parameterClass,
    parameterName: value.parameterName,
    tableName: value.tableName,
    fieldName: value.fieldName,
    exid: value.exid,
    position: value.position,
    offset: value.offset,
    internalLength: value.internalLength,
    decimals: value.decimals,
    defaultValue: value.defaultValue,
    parameterText: value.parameterText,
    optional: value.optional,
  });
}

function snapshotInvocationMetadata(
  metadata: RfcFunctionInterface,
): ClassicInvocationMetadata {
  const name = metadata.name;
  const source = metadata.parameters;
  if (!Array.isArray(source)) {
    throw new TypeError("metadata parameters must be an array");
  }
  const count = source.length;
  if (!Number.isSafeInteger(count) || count > DEFAULT_MAX_CPIC_FIELD_COUNT) {
    throw new RangeError(
      `metadata parameter count exceeds ${DEFAULT_MAX_CPIC_FIELD_COUNT}`,
    );
  }
  const parameters: RfcFunintParameter[] = [];
  for (let index = 0; index < count; index += 1) {
    parameters.push(snapshotParameter(source[index]!, index));
  }
  return Object.freeze({ name, parameters: Object.freeze(parameters) });
}

function snapshotStructureRepository(
  parameters: readonly RfcFunintParameter[],
  structures: RfcStructureRepository,
): RfcStructureRepository {
  const get = structures.get;
  if (typeof get !== "function") {
    throw new TypeError("structure repository get must be a function");
  }
  const result = new Map<string, RfcStructureDefinition>();
  for (const parameter of parameters) {
    if (
      parameter.exid !== "u" &&
      parameter.exid !== "v" &&
      parameter.exid !== "h"
    ) continue;
    if (result.has(parameter.tableName)) continue;
    const definition = Reflect.apply(get, structures, [parameter.tableName]) as
      | RfcStructureDefinition
      | undefined;
    if (definition !== undefined) {
      result.set(
        parameter.tableName,
        validateClassicStructureCodec(
          definition,
          parameter.exid === "u" ? parameter.tableName : undefined,
        ),
      );
    }
  }
  return result;
}

function snapshotInvocationRecursiveXrfcRepository(
  metadata: ClassicInvocationMetadata,
  graph: RecursiveMetadataGraph | undefined,
  selectedParameters: readonly RfcFunintParameter[],
): InvocationRecursiveXrfcRepository {
  if (graph === undefined) {
    const required = selectedParameters.find((parameter) =>
      parameter.exid === "v"
    );
    if (required !== undefined) {
      throw new Error(
        `${required.parameterName} requires recursive xRFC metadata`,
      );
    }
    return new Map();
  }
  if (selectedParameters.length === 0) return new Map();
  const parameterIndex = createRecursiveMetadataParameterIndex(graph);
  const result = new Map<string, InvocationRecursiveXrfcPlan>();
  for (const parameter of selectedParameters) {
    // Preserve the independently qualified strict codec as the authoritative
    // path for every graph shape it supports. The broader graph codec is used
    // only after it explicitly resolves and validates a shape outside that
    // strict subset.
    if (parameter.exid === "v" || parameter.exid === "h") {
      if (!/^[IECT]$/u.test(parameter.parameterClass)) {
        throw new Error(
          `${parameter.parameterName} has unsupported recursive parameter class ${parameter.parameterClass}`,
        );
      }
      try {
        const resolved = resolveRecursiveClassicXrfcParameterFromIndex(
          graph,
          parameterIndex,
          {
            functionName: metadata.name,
            parameterName: parameter.parameterName,
            parameterClass: parameter.parameterClass as "I" | "E" | "C" | "T",
            associatedType: parameter.tableName,
            internalType: parameter.exid,
          },
        );
        result.set(parameter.parameterName, Object.freeze({
          serializer: "recursive-classic-xrfc",
          kind: resolved.kind,
          parameter: resolved,
        }));
      } catch (strictError) {
        // The broader codec may extend the strict subset, but it never gets to
        // reinterpret an invalid graph: fallback is admitted only after its
        // own resolver and complete validator both succeed.
        try {
          const generic = validateRecursiveXrfcParameterFromIndex(
            graph,
            parameterIndex,
            parameter,
          );
          result.set(parameter.parameterName, Object.freeze({
            serializer: "recursive-xrfc",
            kind: generic.kind,
            parameter: generic,
          }));
        } catch {
          throw strictError;
        }
      }
      continue;
    }
    const generic = resolveRecursiveXrfcParameterFromIndex(
      graph,
      parameterIndex,
      parameter,
    );
    if (generic === undefined) continue;
    if (!/^[IECT]$/u.test(parameter.parameterClass)) {
      throw new Error(
        `${parameter.parameterName} has unsupported recursive parameter class ${parameter.parameterClass}`,
      );
    }
    try {
      const resolved = resolveRecursiveClassicXrfcParameterFromIndex(
        graph,
        parameterIndex,
        {
          functionName: metadata.name,
          parameterName: parameter.parameterName,
          parameterClass: parameter.parameterClass as "I" | "E" | "C" | "T",
          associatedType: parameter.tableName,
          internalType: parameter.exid,
        },
      );
      result.set(parameter.parameterName, Object.freeze({
        serializer: "recursive-classic-xrfc",
        kind: resolved.kind,
        parameter: resolved,
      }));
    } catch {
      const validated = validateRecursiveXrfcParameterFromIndex(
        graph,
        parameterIndex,
        parameter,
      );
      result.set(parameter.parameterName, Object.freeze({
        serializer: "recursive-xrfc",
        kind: validated.kind,
        parameter: validated,
      }));
    }
  }
  return result;
}

function isActiveInvocationParameter(
  parameter: RfcFunintParameter,
  input: ReadonlyMap<string, unknown>,
  activated: ReadonlySet<string>,
  deactivated: ReadonlySet<string>,
  int8Mode: ClassicInt8Mode,
): boolean {
  return requestsOutput(parameter, input, activated, deactivated) ||
    (
      parameter.parameterClass !== "E" &&
      activeInputValue(
        parameter,
        input,
        activated,
        deactivated,
        int8Mode,
      ).present
    );
}

function selectedRecursiveMetadataParameters(
  metadata: ClassicInvocationMetadata,
  input: ReadonlyMap<string, unknown>,
  activated: ReadonlySet<string>,
  deactivated: ReadonlySet<string>,
  int8Mode: ClassicInt8Mode,
): readonly RfcFunintParameter[] {
  return metadata.parameters.filter((parameter) =>
    (parameter.exid === "h" || parameter.exid === "v") &&
    isActiveInvocationParameter(
      parameter,
      input,
      activated,
      deactivated,
      int8Mode,
    )
  );
}

function selectedInvocationRecursiveParameters(
  metadata: ClassicInvocationMetadata,
  input: ReadonlyMap<string, unknown>,
  activated: ReadonlySet<string>,
  deactivated: ReadonlySet<string>,
  int8Mode: ClassicInt8Mode,
): readonly RfcFunintParameter[] {
  return metadata.parameters.filter((parameter) =>
    (parameter.exid === "u" ||
      parameter.exid === "v" ||
      parameter.exid === "h") &&
    // Classic TABLES parameters with u rows remain on the binary table path.
    !(parameter.parameterClass === "T" && parameter.exid === "u") &&
    isActiveInvocationParameter(
      parameter,
      input,
      activated,
      deactivated,
      int8Mode,
    )
  );
}

/**
 * Select active deep parameters that need optimized recursive metadata.
 * Excluded parameters must not create an authorization dependency.
 */
export function classicInvocationRecursiveMetadataParameters(
  metadata: RfcFunctionInterface,
  input: ClassicRfcInput,
  options: ClassicRfcInvocationOptions = {},
): readonly RfcFunintParameter[] {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("classic invocation options must be an object");
  }
  const invocationMetadata = snapshotInvocationMetadata(metadata);
  const parameterCount = invocationMetadata.parameters.length;
  const notRequested = snapshotParameterStateSet(
    options.notRequested,
    "notRequested",
    parameterCount,
  );
  const activated = snapshotParameterStateSet(
    options.activated,
    "activated",
    parameterCount,
  );
  const explicitlyDeactivated = snapshotParameterStateSet(
    options.deactivated,
    "deactivated",
    parameterCount,
  );
  validateNotRequested(invocationMetadata, notRequested);
  validateParameterStateSet(invocationMetadata, activated, "activated");
  validateParameterStateSet(
    invocationMetadata,
    explicitlyDeactivated,
    "deactivated",
  );
  const deactivated = unionParameterStateSets(
    notRequested,
    explicitlyDeactivated,
  );
  const normalizedInput = new Map<string, unknown>();
  for (const name of Object.keys(input)) {
    normalizedInput.set(name, input[name]);
  }
  return Object.freeze(selectedRecursiveMetadataParameters(
    invocationMetadata,
    normalizedInput,
    activated,
    deactivated,
    snapshotClassicInt8Mode(options.int8Mode),
  ));
}

function scalarEncodedByteLength(
  parameter: RfcFunintParameter,
  value: unknown,
  structures: RfcStructureRepository,
  int8Mode: ClassicInt8Mode,
): number {
  if (isClassicTemporalExid(parameter.exid)) {
    const byteLength = classicTemporalByteLength(parameter.exid);
    if (parameter.internalLength !== byteLength) {
      throw new Error(
        `${parameter.parameterName} compact temporal type ${parameter.exid} must occupy ${byteLength} bytes`,
      );
    }
    encodeClassicTemporal(parameter.exid, value as string, parameter.parameterName);
    return byteLength;
  }
  switch (parameter.exid) {
    case "C":
      if (typeof value !== "string") {
        throw new TypeError(`${parameter.parameterName} expects a string`);
      }
      assertUnicodeScalarText(value, parameter.parameterName);
      if (value.length > parameter.internalLength) {
        throw new RangeError(
          `${parameter.parameterName} does not fit its classic CHAR width`,
        );
      }
      return parameter.internalLength * 2;
    case "N":
      if (
        typeof value !== "string" ||
        !/^\d*$/u.test(value) ||
        value.length > parameter.internalLength
      ) {
        throw new TypeError(
          `${parameter.parameterName} expects at most ${parameter.internalLength} decimal digits`,
        );
      }
      return parameter.internalLength * 2;
    case "D":
      if (typeof value !== "string") throw new TypeError(`${parameter.parameterName} expects YYYYMMDD`);
      assertClassicDate(value, parameter.parameterName);
      return 16;
    case "T":
      if (typeof value !== "string") throw new TypeError(`${parameter.parameterName} expects HHMMSS`);
      assertClassicTime(value, parameter.parameterName);
      return 12;
    case "X":
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${parameter.parameterName} expects Uint8Array bytes`);
      }
      if (intrinsicUint8ArrayByteLength(value) > parameter.internalLength) {
        throw new RangeError(
          `${parameter.parameterName} accepts at most ${parameter.internalLength} bytes`,
        );
      }
      return parameter.internalLength;
    case "F":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${parameter.parameterName} expects a finite float`);
      }
      return 8;
    case "I":
      scalarInteger(parameter, value, -0x8000_0000, 0x7fff_ffff);
      return 4;
    case "s":
      scalarInteger(parameter, value, -0x8000, 0x7fff);
      return 2;
    case "b":
      scalarInteger(parameter, value, 0, 0xff);
      return 1;
    case "8": {
      encodeClassicInt8(value, int8Mode, parameter.parameterName);
      return 8;
    }
    case "P":
      return encodePackedDecimal(
        "0",
        parameter.internalLength,
        parameter.decimals,
        parameter.parameterName,
      ).byteLength;
    case "a":
      if (parameter.internalLength !== 8) {
        throw new Error(`${parameter.parameterName} DECF16 must occupy 8 bytes`);
      }
      encodeDecimalFloat16(value as DecimalFloatInput, parameter.parameterName);
      return 8;
    case "e":
      if (parameter.internalLength !== 16) {
        throw new Error(`${parameter.parameterName} DECF34 must occupy 16 bytes`);
      }
      encodeDecimalFloat34(value as DecimalFloatInput, parameter.parameterName);
      return 16;
    case "g":
      if (typeof value !== "string") {
        throw new TypeError(`${parameter.parameterName} expects Unicode text`);
      }
      assertNulFreeUnicodeScalarText(value, parameter.parameterName);
      return Buffer.byteLength(value, "utf8") + 1;
    case "y":
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${parameter.parameterName} expects Uint8Array bytes`);
      }
      return intrinsicUint8ArrayByteLength(value);
    case "u":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${parameter.parameterName} expects a structure object`);
      }
      return structureFor(parameter, structures).byteLength;
    default:
      throw new Error(
        `${parameter.parameterName} classic RFC type ${parameter.exid} is not implemented`,
      );
  }
}

function tableRowByteLength(
  parameter: RfcFunintParameter,
  structures: RfcStructureRepository,
  int8Mode: ClassicInt8Mode,
): number {
  if (parameter.exid === "u") {
    const definition = structureFor(parameter, structures);
    if (classicStructureHasDynamicFields(definition)) {
      throw new Error(
        `${parameter.parameterName} classic TABLES rows cannot contain ` +
          "STRING/XSTRING fields",
      );
    }
    return definition.byteLength;
  }
  if (parameter.exid === "g" || parameter.exid === "y") {
    throw new Error(
      `${parameter.parameterName} has a deep scalar table line which requires ` +
        "an unsupported negotiated serializer",
    );
  }
  return scalarEncodedByteLength(
    parameter,
    initialScalarValue(parameter, int8Mode),
    structures,
    int8Mode,
  );
}

/**
 * Some SAP kernels omit unused trailing alignment bytes from binary TABLES
 * reply rows even though DDIC reports the complete in-memory structure size.
 * Admit only the exact end of the final validated field; this cannot hide a
 * truncated field or an interior geometry mismatch.
 */
function structuredExactFieldByteLength(
  definition: RfcStructureDefinition | undefined,
  metadataByteLength: number,
): number | undefined {
  if (definition === undefined) return undefined;
  const finalField = definition.fields.at(-1);
  if (finalField === undefined) return undefined;
  const fieldByteLength = finalField.offset + finalField.internalLength;
  return fieldByteLength > 0 && fieldByteLength < metadataByteLength
    ? fieldByteLength
    : undefined;
}

function structuredResponseDefinition(
  definition: RfcStructureDefinition,
  responseByteLength: number,
): RfcStructureDefinition {
  const normalized = validateClassicStructureCodec(definition);
  const exactFieldByteLength = structuredExactFieldByteLength(
    normalized,
    normalized.byteLength,
  );
  return responseByteLength === exactFieldByteLength
    ? validateClassicStructureCodec(Object.freeze({
        name: normalized.name,
        byteLength: responseByteLength,
        fields: normalized.fields,
      }))
    : normalized;
}

function scalarTableRowValue(
  parameter: RfcFunintParameter,
  row: unknown,
  index: number,
): unknown {
  if (
    typeof row === "object" &&
    row !== null &&
    !(row instanceof Uint8Array) &&
    !Array.isArray(row) &&
    Object.prototype.hasOwnProperty.call(row, "")
  ) {
    const keys = Object.keys(row);
    if (keys.length !== 1 || keys[0] !== "") {
      throw new TypeError(
        `${parameter.parameterName}[${index}] scalar row wrapper must contain only the empty field name`,
      );
    }
    return (row as Readonly<Record<string, unknown>>)[""];
  }
  return row;
}

function unicodeValueByteLength(value: string, field: string, maximum: number): number {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new RangeError(`${field} must contain 1..${maximum} BMP characters`);
  }
  return value.length * 2;
}

function preflightClassicRfcInvocationRequest(
  metadata: ClassicInvocationMetadata,
  input: ReadonlyMap<string, unknown>,
  structures: RfcStructureRepository,
  recursiveXrfc: InvocationRecursiveXrfcRepository,
  recursiveMetadata: RecursiveMetadataGraph | undefined,
  activated: ReadonlySet<string>,
  deactivated: ReadonlySet<string>,
  maximum: number | undefined,
  int8Mode: ClassicInt8Mode,
): ClassicInvocationPreflight {
  if (
    maximum !== undefined &&
    (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 0x7fff_ffff)
  ) {
    throw new RangeError(
      "maxApplicationDataLength must be an integer in 0..2147483647",
    );
  }
  let chainByteLength = 0;
  let fieldCount = 0;
  const checkBounds = (): void => {
    if (fieldCount > DEFAULT_MAX_CPIC_FIELD_COUNT) {
      throw new RangeError(
        `classic RFC request field count exceeds ${DEFAULT_MAX_CPIC_FIELD_COUNT}`,
      );
    }
    if (chainByteLength > DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH) {
      throw new RangeError(
        `classic RFC request field chain exceeds ${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH} bytes`,
      );
    }
    if (
      maximum !== undefined &&
      CPIC_CUT_FIXED_APPLICATION_BYTES + chainByteLength > maximum
    ) {
      throw new RangeError(
        `classic RFC request application length exceeds configured limit ${maximum}`,
      );
    }
  };
  const addFields = (valueByteLength: number, count = 1): void => {
    if (
      !Number.isSafeInteger(valueByteLength) ||
      valueByteLength < 0 ||
      valueByteLength > DEFAULT_MAX_CPIC_FIELD_LENGTH
    ) {
      throw new RangeError(
        `classic RFC field length exceeds ${DEFAULT_MAX_CPIC_FIELD_LENGTH} bytes`,
      );
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("classic RFC field count is unsafe");
    }
    const recordByteLength =
      2 + rfcProFieldHeaderByteLength(valueByteLength) + valueByteLength;
    const additionalByteLength = recordByteLength * count;
    if (
      !Number.isSafeInteger(additionalByteLength) ||
      !Number.isSafeInteger(chainByteLength + additionalByteLength) ||
      !Number.isSafeInteger(fieldCount + count)
    ) {
      throw new RangeError("classic RFC request length is unsafe");
    }
    chainByteLength += additionalByteLength;
    fieldCount += count;
    checkBounds();
  };

  addFields(6);
  addFields(unicodeValueByteLength(metadata.name, "functionName", 40));
  addFields(0);
  const tableRowCounts = new Map<string, number>();
  const tableRowByteLengths = new Map<string, number>();
  const scalarByteLengths = new Map<string, number>();
  const scalarEncodings = new Map<string, Buffer>();
  const xrfcEncodings = new Map<string, Buffer>();
  const addXrfcEncoding = (
    parameter: RfcFunintParameter,
    value: unknown,
  ): void => {
    const maxParameterBytes = maximum === undefined
      ? DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH
      : Math.min(
          DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
          Math.max(
            0,
            maximum - CPIC_CUT_FIXED_APPLICATION_BYTES - chainByteLength,
          ),
        );
    const recursive = recursiveXrfc.get(parameter.parameterName);
    let encoding: Buffer;
    if (recursive === undefined) {
      const kind = classicXrfcKind(parameter, structures);
      if (kind === undefined) {
        throw new Error(
          `${parameter.parameterName} lacks its xRFC preflight descriptor`,
        );
      }
      encoding = encodeClassicXrfcParameter(
        parameter.parameterName,
        structureFor(parameter, structures),
        kind,
        value,
        { maxParameterBytes, int8Mode },
      );
    } else if (recursive.serializer === "recursive-classic-xrfc") {
      encoding = encodeRecursiveClassicXrfcParameter(
        recursive.parameter,
        value,
        { maxParameterBytes },
      );
    } else {
      encoding = encodeResolvedRecursiveXrfcParameter(
        parameter,
        recursiveMetadata!,
        recursive.parameter,
        value,
        { maxParameterBytes, int8Mode },
      );
    }
    if (xrfcEncodings.has(parameter.parameterName)) {
      throw new Error(`duplicate xRFC input parameter ${parameter.parameterName}`);
    }
    xrfcEncodings.set(parameter.parameterName, encoding);
    addFields(0);
    for (
      let offset = 0;
      offset < encoding.byteLength;
      offset += CLASSIC_XRFC_XML_CHUNK_LENGTH
    ) {
      addFields(Math.min(
        CLASSIC_XRFC_XML_CHUNK_LENGTH,
        encoding.byteLength - offset,
      ));
    }
    addFields(0);
  };
  for (const parameter of metadata.parameters) {
    if (requestsOutput(parameter, input, activated, deactivated)) {
      const recursive = recursiveXrfc.get(parameter.parameterName);
      if (recursive === undefined) {
        const xrfcKind = classicXrfcKind(parameter, structures);
        if (xrfcKind !== undefined) {
          // Resolving the shape here rejects unsupported deep output metadata
          // before a request can be sent.
          validateClassicXrfcDefinition(structureFor(parameter, structures));
        } else if (parameter.parameterClass === "T") {
          tableRowByteLength(parameter, structures, int8Mode);
        } else {
          scalarEncodedByteLength(
            parameter,
            initialScalarValue(parameter, int8Mode),
            structures,
            int8Mode,
          );
        }
      }
      addFields(
        unicodeValueByteLength(
          parameter.parameterName,
          "requested output name",
          30,
        ),
      );
    }
    if (parameter.parameterClass === "I" || parameter.parameterClass === "C") {
      const active = activeInputValue(
        parameter,
        input,
        activated,
        deactivated,
        int8Mode,
      );
      if (active.present) {
        if (
          recursiveXrfc.has(parameter.parameterName) ||
          classicXrfcKind(parameter, structures) !== undefined
        ) {
          addXrfcEncoding(parameter, active.value);
          continue;
        }
        addFields(
          unicodeValueByteLength(parameter.parameterName, "import name", 30),
        );
        let scalarByteLength: number;
        if (parameter.exid === "a" || parameter.exid === "e") {
          const encoded = encodeScalar(
            parameter,
            active.value,
            structures,
            int8Mode,
          );
          scalarEncodings.set(parameter.parameterName, encoded);
          scalarByteLength = encoded.byteLength;
        } else {
          scalarByteLength = scalarEncodedByteLength(
            parameter,
            active.value,
            structures,
            int8Mode,
          );
        }
        scalarByteLengths.set(parameter.parameterName, scalarByteLength);
        addFields(scalarByteLength);
      }
      continue;
    }
    if (parameter.parameterClass === "T") {
      const active = activeInputValue(
        parameter,
        input,
        activated,
        deactivated,
        int8Mode,
      );
      if (!active.present) continue;
      const value = active.value;
      if (!Array.isArray(value)) {
        throw new TypeError(`${parameter.parameterName} expects an array of rows`);
      }
      if (
        recursiveXrfc.has(parameter.parameterName) ||
        classicXrfcKind(parameter, structures) !== undefined
      ) {
        addXrfcEncoding(parameter, value);
        continue;
      }
      const rowCount = value.length;
      tableRowCounts.set(parameter.parameterName, rowCount);
      if (rowCount > 0xffff_ffff) {
        throw new RangeError(`${parameter.parameterName} row count exceeds the unsigned 32-bit range`);
      }
      const rowByteLength = tableRowByteLength(
        parameter,
        structures,
        int8Mode,
      );
      tableRowByteLengths.set(parameter.parameterName, rowByteLength);
      addFields(
        unicodeValueByteLength(parameter.parameterName, "table name", 30),
      );
      addFields(8);
      if (rowCount > 0) addFields(rowByteLength, rowCount);
      continue;
    }
    if (parameter.parameterClass !== "E") {
      throw new Error(
        `${parameter.parameterName} has unsupported parameter class ` +
          `${parameter.parameterClass}`,
      );
    }
  }
  addFields(0);
  return Object.freeze({
    scalarByteLengths,
    scalarEncodings,
    tableRowCounts,
    tableRowByteLengths,
    xrfcEncodings,
  });
}

function validateNotRequested(
  metadata: ClassicInvocationMetadata,
  notRequested: ReadonlySet<string>,
): void {
  const parameters = new Set(
    metadata.parameters.map((parameter) => parameter.parameterName),
  );
  for (const name of notRequested) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("notRequested entries must be non-empty strings");
    }
    if (!parameters.has(name)) {
      throw new Error(`notRequested contains unknown parameter ${name}`);
    }
  }
}

function validateParameterStateSet(
  metadata: ClassicInvocationMetadata,
  values: ReadonlySet<string>,
  label: "activated" | "deactivated",
): void {
  const parameters = new Set(
    metadata.parameters.map((parameter) => parameter.parameterName),
  );
  for (const name of values) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
    if (!parameters.has(name)) {
      throw new Error(`${label} contains unknown parameter ${name}`);
    }
  }
}

function snapshotParameterStateSet(
  value: ReadonlySet<string> | undefined,
  label: "notRequested" | "activated" | "deactivated",
  metadataParameterCount: number,
): ReadonlySet<string> {
  if (value === undefined) return new Set<string>();
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`${label} must be an iterable set of parameter names`);
  }
  const iterator = value[Symbol.iterator];
  if (typeof iterator !== "function") {
    throw new TypeError(`${label} must be an iterable set of parameter names`);
  }
  const source = value;
  const boundedSource = {
    [Symbol.iterator]() {
      return Reflect.apply(iterator, source, []) as SetIterator<string>;
    },
  };
  const result = new Set<string>();
  let entryCount = 0;
  for (const name of boundedSource) {
    if (entryCount >= metadataParameterCount) {
      throw new RangeError(
        `${label} entry count exceeds metadata parameter count ${metadataParameterCount}`,
      );
    }
    entryCount += 1;
    result.add(name);
  }
  return result;
}

function unionParameterStateSets(
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...first, ...second]);
}

/**
 * Capture caller-owned input and activation options before an exchange. Direct
 * sessions use this one snapshot for request encoding and response validation,
 * so an accessor or Proxy cannot change activation between those phases.
 * Kept module-internal at the package boundary.
 */
export function captureClassicRfcInvocation(
  metadata: RfcFunctionInterface,
  input: ClassicRfcInput,
  options: ClassicRfcInvocationOptions = {},
): CapturedClassicRfcInvocation {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("classic invocation options must be an object");
  }
  const notRequestedSource = options.notRequested;
  const activatedSource = options.activated;
  const deactivatedSource = options.deactivated;
  const maxApplicationDataLength = options.maxApplicationDataLength;
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  const invocationMetadata = snapshotInvocationMetadata(metadata);
  const parameterCount = invocationMetadata.parameters.length;
  const notRequested = snapshotParameterStateSet(
    notRequestedSource,
    "notRequested",
    parameterCount,
  );
  const activated = new Set(snapshotParameterStateSet(
    activatedSource,
    "activated",
    parameterCount,
  ));
  const deactivated = snapshotParameterStateSet(
    deactivatedSource,
    "deactivated",
    parameterCount,
  );
  validateNotRequested(invocationMetadata, notRequested);
  validateParameterStateSet(invocationMetadata, activated, "activated");
  validateParameterStateSet(invocationMetadata, deactivated, "deactivated");
  const parameters = new Map(
    invocationMetadata.parameters.map((parameter) => [
      parameter.parameterName,
      parameter,
    ]),
  );
  const inputNames = Object.keys(input);
  if (inputNames.length > parameterCount) {
    throw new RangeError(
      `input parameter count exceeds metadata parameter count ${parameterCount}`,
    );
  }
  for (const name of inputNames) {
    const parameter = parameters.get(name);
    if (parameter === undefined) throw new Error(`unknown parameter ${name}`);
    if (parameter.parameterClass === "E") {
      throw new Error(`export parameter ${name} cannot be supplied as input`);
    }
  }
  const capturedInput = Object.create(null) as Record<string, unknown>;
  for (const name of inputNames) {
    Object.defineProperty(capturedInput, name, {
      value: input[name],
      enumerable: true,
      configurable: false,
      writable: false,
    });
    activated.add(name);
  }
  const inputSnapshot = snapshotRfcValue(
    capturedInput,
    "RFC input",
  ) as ClassicRfcInput;
  return Object.freeze({
    input: inputSnapshot,
    options: Object.freeze({
      notRequested,
      activated,
      deactivated,
      ...(maxApplicationDataLength === undefined
        ? {}
        : { maxApplicationDataLength }),
      int8Mode,
      bcd,
    }),
  });
}

/**
 * Classify repository work only after caller activation state has been
 * captured. Inactive optional inputs and suppressed deep outputs must not
 * trigger RFC_METADATA_GET. A suppressed classic `u` output still needs its
 * flat structure descriptor to preserve the established metadata-shaped ABAP
 * initial value.
 */
export function classifyClassicInvocationMetadataNeeds(
  metadata: RfcFunctionInterface,
  inputValue: ClassicRfcInput,
  options: ClassicRfcInvocationOptions,
): ClassicInvocationMetadataNeeds {
  const invocationMetadata = snapshotInvocationMetadata(metadata);
  const input = new Map<string, unknown>();
  for (const name of Object.keys(inputValue)) {
    input.set(name, inputValue[name]);
  }
  const activated = options.activated ?? new Set<string>();
  const deactivated = unionParameterStateSets(
    options.notRequested ?? new Set<string>(),
    options.deactivated ?? new Set<string>(),
  );
  const containerParameters = new Set<string>();
  let optionalRecursive = false;
  let requiredRecursive = false;
  for (const parameter of invocationMetadata.parameters) {
    if (
      parameter.exid !== "u" &&
      parameter.exid !== "v" &&
      parameter.exid !== "h"
    ) {
      continue;
    }
    const active = requestsOutput(
      parameter,
      input,
      activated,
      deactivated,
    ) || activeInputValue(
      parameter,
      input,
      activated,
      deactivated,
      options.int8Mode,
    ).present;
    if (!active) {
      if (
        parameter.exid === "u" &&
        deactivated.has(parameter.parameterName) &&
        (parameter.parameterClass === "E" || parameter.parameterClass === "C")
      ) {
        containerParameters.add(parameter.parameterName);
      }
      continue;
    }
    containerParameters.add(parameter.parameterName);
    // Mature SDKs always keep classic TABLES parameters on the binary table
    // path, even when optimized metadata is available.
    if (parameter.parameterClass === "T") continue;
    if (parameter.exid === "u") optionalRecursive = true;
    else requiredRecursive = true;
  }
  return Object.freeze({
    containerParameters,
    optionalRecursive,
    requiredRecursive,
  });
}

function structureFor(
  parameter: RfcFunintParameter,
  structures: RfcStructureRepository,
): RfcStructureDefinition {
  const structure = structures.get(parameter.tableName);
  if (structure === undefined) {
    throw new Error(
      `${parameter.parameterName} requires unresolved structure ${parameter.tableName}`,
    );
  }
  return structure;
}

function classicXrfcKind(
  parameter: RfcFunintParameter,
  structures: RfcStructureRepository,
): ClassicXrfcKind | undefined {
  if (parameter.exid === "h") {
    // RFCTYPE_TABLE parameters use an indirect row descriptor even though
    // RFC_GET_FUNCTION_INTERFACE exposes them in I/E/C directions.
    return "table";
  }
  if (parameter.exid === "v") {
    throw new Error(
      `${parameter.parameterName} requires recursive metadata for its deep structure`,
    );
  }
  if (parameter.exid !== "u") return undefined;
  const definition = structureFor(parameter, structures);
  if (!classicStructureHasDynamicFields(definition)) return undefined;
  if (parameter.parameterClass === "T") {
    throw new Error(
      `${parameter.parameterName} classic TABLES rows cannot contain ` +
        "STRING/XSTRING fields",
    );
  }
  return "structure";
}

function validateRecursiveGraphIdentity(
  metadata: ClassicInvocationMetadata,
  graph: RecursiveMetadataGraph | undefined,
): void {
  if (
    graph !== undefined &&
    (graph.functionIdentity === undefined ||
      graph.functionIdentity.name !== metadata.name)
  ) {
    throw new Error(
      `recursive metadata identity does not match function ${metadata.name}`,
    );
  }
}

function scalarInteger(
  parameter: RfcFunintParameter,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${parameter.parameterName} expects an integer in ${minimum}..${maximum}`,
    );
  }
  return value;
}

function encodeScalar(
  parameter: RfcFunintParameter,
  value: unknown,
  structures: RfcStructureRepository,
  int8Mode: ClassicInt8Mode,
  expectedByteLength?: number,
): Buffer {
  if (isClassicTemporalExid(parameter.exid)) {
    const byteLength = classicTemporalByteLength(parameter.exid);
    if (parameter.internalLength !== byteLength) {
      throw new Error(
        `${parameter.parameterName} compact temporal type ${parameter.exid} must occupy ${byteLength} bytes`,
      );
    }
    return encodeClassicTemporal(
      parameter.exid,
      value as string,
      parameter.parameterName,
    );
  }
  switch (parameter.exid) {
    case "C":
      if (typeof value !== "string") {
        throw new TypeError(`${parameter.parameterName} expects a string`);
      }
      return encodeAbapChar(value, parameter.internalLength);
    case "N": {
      if (
        typeof value !== "string" ||
        !/^\d*$/u.test(value) ||
        value.length > parameter.internalLength
      ) {
        throw new TypeError(
          `${parameter.parameterName} expects at most ${parameter.internalLength} decimal digits`,
        );
      }
      return encodeAbapChar(
        value.padStart(parameter.internalLength, "0"),
        parameter.internalLength,
      );
    }
    case "D":
      if (typeof value !== "string") throw new TypeError(`${parameter.parameterName} expects YYYYMMDD`);
      return encodeAbapChar(
        classicDateWireText(value, parameter.parameterName),
        8,
      );
    case "T":
      if (typeof value !== "string") throw new TypeError(`${parameter.parameterName} expects HHMMSS`);
      return encodeAbapChar(
        classicTimeWireText(value, parameter.parameterName),
        6,
      );
    case "X": {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${parameter.parameterName} expects Uint8Array bytes`);
      }
      const byteLength = intrinsicUint8ArrayByteLength(value);
      if (byteLength > parameter.internalLength) {
        throw new RangeError(
          `${parameter.parameterName} accepts at most ${parameter.internalLength} bytes`,
        );
      }
      const snapshot = snapshotUint8Array(
        value,
        parameter.parameterName,
        byteLength,
      );
      const result = Buffer.alloc(parameter.internalLength);
      snapshot.copy(result);
      return result;
    }
    case "F": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${parameter.parameterName} expects a finite float`);
      }
      const result = Buffer.alloc(8);
      result.writeDoubleLE(value);
      return result;
    }
    case "I": {
      const result = Buffer.alloc(4);
      result.writeInt32LE(
        scalarInteger(parameter, value, -0x8000_0000, 0x7fff_ffff),
      );
      return result;
    }
    case "s": {
      const result = Buffer.alloc(2);
      result.writeInt16LE(scalarInteger(parameter, value, -0x8000, 0x7fff));
      return result;
    }
    case "b":
      return Buffer.of(scalarInteger(parameter, value, 0, 0xff));
    case "8": {
      const result = Buffer.alloc(8);
      result.writeBigInt64LE(
        encodeClassicInt8(value, int8Mode, parameter.parameterName),
      );
      return result;
    }
    case "P":
      return encodePackedDecimal(
        value as PackedDecimalInput,
        parameter.internalLength,
        parameter.decimals,
        parameter.parameterName,
      );
    case "a":
      if (parameter.internalLength !== 8) {
        throw new Error(`${parameter.parameterName} DECF16 must occupy 8 bytes`);
      }
      return encodeDecimalFloat16(
        value as DecimalFloatInput,
        parameter.parameterName,
      );
    case "e":
      if (parameter.internalLength !== 16) {
        throw new Error(`${parameter.parameterName} DECF34 must occupy 16 bytes`);
      }
      return encodeDecimalFloat34(
        value as DecimalFloatInput,
        parameter.parameterName,
      );
    case "g": { // ABAP STRING: UTF-8 with one trailing NUL in classic CUT
      if (typeof value !== "string") {
        throw new TypeError(`${parameter.parameterName} expects Unicode text`);
      }
      assertNulFreeUnicodeScalarText(value, parameter.parameterName);
      return Buffer.concat([Buffer.from(value, "utf8"), Buffer.of(0)]);
    }
    case "y":
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${parameter.parameterName} expects Uint8Array bytes`);
      }
      return snapshotUint8Array(
        value,
        parameter.parameterName,
        expectedByteLength,
      );
    case "u": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${parameter.parameterName} expects a structure object`);
      }
      return encodeClassicStructure(
        structureFor(parameter, structures),
        value as ClassicStructureInput,
        { int8Mode },
      );
    }
    default:
      throw new Error(
        `${parameter.parameterName} classic RFC type ${parameter.exid} is not implemented`,
      );
  }
}

function decodeScalar(
  parameter: RfcFunintParameter,
  value: Buffer,
  structures: RfcStructureRepository,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
): unknown {
  // Grouping either detached this value for a public call or transferred a
  // session-owned CPIC buffer into the internal result. Returning RAW bytes can
  // therefore transfer that buffer without another full-size copy.
  const encoded = value;
  if (isClassicTemporalExid(parameter.exid)) {
    const byteLength = classicTemporalByteLength(parameter.exid);
    if (parameter.internalLength !== byteLength) {
      throw new Error(
        `${parameter.parameterName} compact temporal type ${parameter.exid} must occupy ${byteLength} bytes`,
      );
    }
    return decodeClassicTemporal(
      parameter.exid,
      encoded,
      parameter.parameterName,
    );
  }
  switch (parameter.exid) {
    case "C":
      return decodeAbapChar(encoded, parameter.internalLength);
    case "N":
      return decodeAbapChar(encoded, parameter.internalLength);
    case "D": {
      const decoded = decodeAbapFixedChar(encoded, 8);
      return classicDatePublicText(decoded, parameter.parameterName);
    }
    case "T": {
      const decoded = decodeAbapFixedChar(encoded, 6);
      return classicTimePublicText(decoded, parameter.parameterName);
    }
    case "X":
      if (encoded.byteLength !== parameter.internalLength) {
        throw new Error(`${parameter.parameterName} has an invalid RAW width`);
      }
      return encoded;
    case "F":
      if (encoded.byteLength !== 8) throw new Error(`${parameter.parameterName} has an invalid FLOAT width`);
      return encoded.readDoubleLE(0);
    case "I":
      if (encoded.byteLength !== 4) throw new Error(`${parameter.parameterName} has an invalid INT4 width`);
      return encoded.readInt32LE(0);
    case "s":
      if (encoded.byteLength !== 2) throw new Error(`${parameter.parameterName} has an invalid INT2 width`);
      return encoded.readInt16LE(0);
    case "b":
      if (encoded.byteLength !== 1) throw new Error(`${parameter.parameterName} has an invalid INT1 width`);
      return encoded.readUInt8(0);
    case "8":
      if (encoded.byteLength !== 8) throw new Error(`${parameter.parameterName} has an invalid INT8 width`);
      return decodeClassicInt8(
        encoded.readBigInt64LE(0),
        int8Mode,
        parameter.parameterName,
      );
    case "P":
      if (encoded.byteLength !== parameter.internalLength) {
        throw new Error(`${parameter.parameterName} has an invalid BCD width`);
      }
      return projectClassicBcdOutput(
        decodePackedDecimal(encoded, parameter.decimals, parameter.parameterName),
        bcd,
        parameter.parameterName,
      );
    case "a":
      if (parameter.internalLength !== 8) {
        throw new Error(`${parameter.parameterName} DECF16 must occupy 8 bytes`);
      }
      return projectClassicBcdOutput(
        decodeDecimalFloat16(encoded, parameter.parameterName),
        bcd,
        parameter.parameterName,
      );
    case "e":
      if (parameter.internalLength !== 16) {
        throw new Error(`${parameter.parameterName} DECF34 must occupy 16 bytes`);
      }
      return projectClassicBcdOutput(
        decodeDecimalFloat34(encoded, parameter.parameterName),
        bcd,
        parameter.parameterName,
      );
    case "g": {
      if (
        encoded.byteLength === 0 ||
        encoded[encoded.byteLength - 1] !== 0 ||
        encoded.subarray(0, -1).includes(0)
      ) {
        throw new Error(
          `${parameter.parameterName} STRING lacks one trailing NUL terminator`,
        );
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(
        encoded.subarray(0, -1),
      );
    }
    case "y":
      return encoded;
    case "u":
      return decodeClassicStructure(
        structuredResponseDefinition(
          structureFor(parameter, structures),
          encoded.byteLength,
        ),
        encoded,
        { int8Mode, bcd },
      );
    default:
      throw new Error(
        `${parameter.parameterName} classic RFC type ${parameter.exid} is not implemented`,
      );
  }
}

function initialDecodedOutput(
  parameter: RfcFunintParameter,
  structures: RfcStructureRepository,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
): unknown {
  // RFCTYPE_TABLE (EXID h) is the modern table-container descriptor used for
  // parameters declared with TABLE OF rather than classic TABLES. The classic
  // CUT serializer cannot activate it, but an explicitly inactive output has
  // the same observable initial value as every other table: no rows. Keeping
  // that case independent of the unsupported active serializer lets callers
  // deactivate a newer optional output on otherwise classic-compatible RFMs.
  if (parameter.parameterClass === "T" || parameter.exid === "h") {
    return Object.freeze([]);
  }
  if (parameter.exid === "v") {
    return Object.freeze({});
  }
  const initial = initialScalarValue(parameter, int8Mode);
  const expectedByteLength = scalarEncodedByteLength(
    parameter,
    initial,
    structures,
    int8Mode,
  );
  return decodeScalar(
    parameter,
    encodeScalar(
      parameter,
      initial,
      structures,
      int8Mode,
      expectedByteLength,
    ),
    structures,
    int8Mode,
    bcd,
  );
}

/** Build a classic RFC call from its normalized metadata descriptor. */
export function buildClassicRfcInvocationRequest(
  metadata: RfcFunctionInterface,
  input: ClassicRfcInput,
  structures: RfcStructureRepository = new Map(),
  options: ClassicRfcInvocationOptions = {},
  recursiveMetadata?: RecursiveMetadataGraph,
): Buffer {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("classic invocation options must be an object");
  }
  const notRequestedSource = options.notRequested;
  const activatedSource = options.activated;
  const deactivatedSource = options.deactivated;
  const maxApplicationDataLength = options.maxApplicationDataLength;
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  snapshotClassicBcdMode(options.bcd);
  const invocationMetadata = snapshotInvocationMetadata(metadata);
  validateRecursiveGraphIdentity(invocationMetadata, recursiveMetadata);
  const notRequested = snapshotParameterStateSet(
    notRequestedSource,
    "notRequested",
    invocationMetadata.parameters.length,
  );
  const activated = snapshotParameterStateSet(
    activatedSource,
    "activated",
    invocationMetadata.parameters.length,
  );
  const explicitlyDeactivated = snapshotParameterStateSet(
    deactivatedSource,
    "deactivated",
    invocationMetadata.parameters.length,
  );
  validateNotRequested(invocationMetadata, notRequested);
  validateParameterStateSet(invocationMetadata, activated, "activated");
  validateParameterStateSet(
    invocationMetadata,
    explicitlyDeactivated,
    "deactivated",
  );
  const deactivated = unionParameterStateSets(
    notRequested,
    explicitlyDeactivated,
  );
  const parameters = new Map(
    invocationMetadata.parameters.map((parameter) => [
      parameter.parameterName,
      parameter,
    ]),
  );
  const normalizedInput = new Map<string, unknown>();
  for (const name of Object.keys(input)) {
    const parameter = parameters.get(name);
    if (parameter === undefined) throw new Error(`unknown parameter ${name}`);
    if (parameter.parameterClass === "E") {
      throw new Error(`export parameter ${name} cannot be supplied as input`);
    }
    normalizedInput.set(name, input[name]);
  }
  const recursiveXrfc = snapshotInvocationRecursiveXrfcRepository(
    invocationMetadata,
    recursiveMetadata,
    selectedInvocationRecursiveParameters(
      invocationMetadata,
      normalizedInput,
      activated,
      deactivated,
      int8Mode,
    ),
  );
  const structureParameters = invocationMetadata.parameters.filter(
    (parameter) =>
      (parameter.exid === "u" || parameter.exid === "v" || parameter.exid === "h") &&
      !recursiveXrfc.has(parameter.parameterName) &&
      !deactivated.has(parameter.parameterName) &&
      (
        requestsOutput(
          parameter,
          normalizedInput,
          activated,
          deactivated,
        ) ||
        activeInputValue(
          parameter,
          normalizedInput,
          activated,
          deactivated,
        ).present
      ),
  );
  const invocationStructures = snapshotStructureRepository(
    structureParameters,
    structures,
  );
  const preflight = preflightClassicRfcInvocationRequest(
    invocationMetadata,
    normalizedInput,
    invocationStructures,
    recursiveXrfc,
    recursiveMetadata,
    activated,
    deactivated,
    maxApplicationDataLength,
    int8Mode,
  );

  const requestedOutputs: string[] = [];
  const imports: Array<{ readonly name: string; readonly value: Buffer }> = [];
  const tables: Array<{
    readonly name: string;
    readonly rowByteLength: number;
    readonly rows: readonly Buffer[];
  }> = [];
  const xrfcParameters: Array<{
    readonly name: string;
    readonly value: Buffer;
  }> = [];
  for (const parameter of invocationMetadata.parameters) {
    switch (parameter.parameterClass) {
      case "E":
        if (
          !notRequested.has(parameter.parameterName) &&
          !deactivated.has(parameter.parameterName)
        ) {
          requestedOutputs.push(parameter.parameterName);
        }
        break;
      case "I":
      case "C": {
        const active = activeInputValue(
          parameter,
          normalizedInput,
          activated,
          deactivated,
          int8Mode,
        );
        if (
          parameter.parameterClass === "C" &&
          requestsOutput(
            parameter,
            normalizedInput,
            activated,
            deactivated,
          )
        ) {
          requestedOutputs.push(parameter.parameterName);
        }
        if (!active.present) break;
        const xrfcEncoding = preflight.xrfcEncodings.get(
          parameter.parameterName,
        );
        if (xrfcEncoding !== undefined) {
          xrfcParameters.push({
            name: parameter.parameterName,
            value: xrfcEncoding,
          });
          break;
        }
        const value = active.value;
        const expectedByteLength = preflight.scalarByteLengths.get(
          parameter.parameterName,
        );
        if (expectedByteLength === undefined) {
          throw new Error(
            `${parameter.parameterName} lacks its preflight scalar length`,
          );
        }
        const encodedValue = parameter.exid === "a" || parameter.exid === "e"
          ? preflight.scalarEncodings.get(parameter.parameterName)
          : encodeScalar(
            parameter,
            value,
            invocationStructures,
            int8Mode,
            expectedByteLength,
          );
        if (encodedValue === undefined) {
          throw new Error(
            `${parameter.parameterName} lacks its preflight scalar encoding`,
          );
        }
        if (encodedValue.byteLength !== expectedByteLength) {
          throw new RangeError(
            `${parameter.parameterName} encoded length changed after request preflight`,
          );
        }
        imports.push({
          name: parameter.parameterName,
          value: encodedValue,
        });
        break;
      }
      case "T": {
        const active = activeInputValue(
          parameter,
          normalizedInput,
          activated,
          deactivated,
          int8Mode,
        );
        if (
          requestsOutput(
            parameter,
            normalizedInput,
            activated,
            deactivated,
          )
        ) {
          requestedOutputs.push(parameter.parameterName);
        }
        if (!active.present) break;
        const xrfcEncoding = preflight.xrfcEncodings.get(
          parameter.parameterName,
        );
        if (xrfcEncoding !== undefined) {
          xrfcParameters.push({
            name: parameter.parameterName,
            value: xrfcEncoding,
          });
          break;
        }
        const value = active.value;
        if (!Array.isArray(value)) {
          throw new TypeError(`${parameter.parameterName} expects an array of rows`);
        }
        const rowCount = preflight.tableRowCounts.get(parameter.parameterName)!;
        const expectedRowByteLength = preflight.tableRowByteLengths.get(
          parameter.parameterName,
        );
        if (expectedRowByteLength === undefined) {
          throw new Error(
            `${parameter.parameterName} lacks its preflight table row length`,
          );
        }
        const rows: Buffer[] = [];
        for (let index = 0; index < rowCount; index += 1) {
          const row = value[index];
          let encodedRow: Buffer;
          if (parameter.exid === "u") {
            if (typeof row !== "object" || row === null || Array.isArray(row)) {
              throw new TypeError(
                `${parameter.parameterName}[${index}] expects a structure object`,
              );
            }
            encodedRow = encodeClassicStructure(
              structureFor(parameter, invocationStructures),
              row as ClassicStructureInput,
              { int8Mode },
            );
          } else {
            encodedRow = encodeScalar(
              parameter,
              scalarTableRowValue(parameter, row, index),
              invocationStructures,
              int8Mode,
              expectedRowByteLength,
            );
          }
          if (encodedRow.byteLength !== expectedRowByteLength) {
            throw new RangeError(
              `${parameter.parameterName}[${index}] encoded row length changed after request preflight`,
            );
          }
          rows.push(encodedRow);
        }
        tables.push({
          name: parameter.parameterName,
          rowByteLength: expectedRowByteLength,
          rows,
        });
        break;
      }
      default:
        throw new Error(
          `${parameter.parameterName} has unsupported parameter class ` +
            `${parameter.parameterClass}`,
        );
    }
  }

  return encodeCpicCutFunctionRequest({
    functionName: invocationMetadata.name,
    requestedOutputs,
    imports,
    tables,
    xrfcParameters,
  });
}

/** Decode classic scalar results using the same metadata used for the call. */
export function decodeClassicRfcInvocationResult(
  metadata: RfcFunctionInterface,
  fields: readonly CpicField[],
  structures: RfcStructureRepository = new Map(),
  options: ClassicRfcInvocationOptions = {},
  recursiveMetadata?: RecursiveMetadataGraph,
): ClassicRfcOutput {
  return decodeClassicRfcInvocationResultWithOwnership(
    metadata,
    fields,
    structures,
    options,
    recursiveMetadata,
    false,
  );
}

/** Consume CPIC-session-owned reply fields without a second full wire copy. @internal */
export function decodeOwnedClassicRfcInvocationResult(
  metadata: RfcFunctionInterface,
  fields: readonly CpicField[],
  structures: RfcStructureRepository = new Map(),
  options: ClassicRfcInvocationOptions = {},
  recursiveMetadata?: RecursiveMetadataGraph,
): ClassicRfcOutput {
  return decodeClassicRfcInvocationResultWithOwnership(
    metadata,
    fields,
    structures,
    options,
    recursiveMetadata,
    true,
  );
}

function decodeClassicRfcInvocationResultWithOwnership(
  metadata: RfcFunctionInterface,
  fields: readonly CpicField[],
  structures: RfcStructureRepository,
  options: ClassicRfcInvocationOptions,
  recursiveMetadata: RecursiveMetadataGraph | undefined,
  borrowOwnedValues: boolean,
): ClassicRfcOutput {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("classic invocation options must be an object");
  }
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  const invocationMetadata = snapshotInvocationMetadata(metadata);
  validateRecursiveGraphIdentity(invocationMetadata, recursiveMetadata);
  const notRequested = snapshotParameterStateSet(
    options.notRequested,
    "notRequested",
    invocationMetadata.parameters.length,
  );
  const explicitlyDeactivated = snapshotParameterStateSet(
    options.deactivated,
    "deactivated",
    invocationMetadata.parameters.length,
  );
  const activated = snapshotParameterStateSet(
    options.activated,
    "activated",
    invocationMetadata.parameters.length,
  );
  validateNotRequested(invocationMetadata, notRequested);
  validateParameterStateSet(invocationMetadata, activated, "activated");
  validateParameterStateSet(
    invocationMetadata,
    explicitlyDeactivated,
    "deactivated",
  );
  const deactivated = unionParameterStateSets(
    notRequested,
    explicitlyDeactivated,
  );
  const recursiveXrfc = snapshotInvocationRecursiveXrfcRepository(
    invocationMetadata,
    recursiveMetadata,
    selectedInvocationRecursiveParameters(
      invocationMetadata,
      EMPTY_CLASSIC_RFC_INPUT,
      activated,
      deactivated,
      int8Mode,
    ),
  );
  const invocationStructures = snapshotStructureRepository(
    invocationMetadata.parameters.filter(
      (parameter) =>
        (parameter.exid === "u" || parameter.exid === "v" || parameter.exid === "h") &&
        !recursiveXrfc.has(parameter.parameterName) &&
        (
          requestsOutput(
            parameter,
            EMPTY_CLASSIC_RFC_INPUT,
            activated,
            deactivated,
          ) ||
          (
            parameter.exid === "u" &&
            deactivated.has(parameter.parameterName) &&
            (
              parameter.parameterClass === "E" ||
              parameter.parameterClass === "C" ||
              parameter.parameterClass === "T"
            )
          )
        ),
    ),
    structures,
  );
  const grouped = borrowOwnedValues
    ? decodeOwnedClassicRfcResult(fields)
    : decodeClassicRfcResult(fields);
  const parameters = new Map(
    invocationMetadata.parameters.map((parameter) => [
      parameter.parameterName,
      parameter,
    ]),
  );
  const requestedOutputs = new Set(
    invocationMetadata.parameters
      .filter((parameter) => requestsOutput(
        parameter,
        EMPTY_CLASSIC_RFC_INPUT,
        activated,
        deactivated,
      ))
      .map((parameter) => parameter.parameterName),
  );
  const output: Record<string, unknown> = {};
  const returnedNames = new Set<string>();
  for (const parameter of invocationMetadata.parameters) {
    if (
      deactivated.has(parameter.parameterName) &&
      (
        parameter.parameterClass === "E" ||
        parameter.parameterClass === "C" ||
        parameter.parameterClass === "T"
      )
    ) {
      defineClassicRfcOutput(
        output,
        parameter.parameterName,
        initialDecodedOutput(
          parameter,
          invocationStructures,
          int8Mode,
          bcd,
        ),
      );
    }
  }
  for (const scalar of grouped.scalars) {
    if (returnedNames.has(scalar.name)) {
      throw new Error(`classic RFC response contains duplicate parameter ${scalar.name}`);
    }
    returnedNames.add(scalar.name);
    if (notRequested.has(scalar.name) || deactivated.has(scalar.name)) continue;
    const parameter = parameters.get(scalar.name);
    if (parameter === undefined) {
      throw new Error(`classic RFC response returned unknown parameter ${scalar.name}`);
    }
    if (parameter.parameterClass !== "E" && parameter.parameterClass !== "C") {
      throw new Error(
        `classic RFC response returned non-output parameter ${scalar.name}`,
      );
    }
    if (!requestedOutputs.has(scalar.name)) continue;
    defineClassicRfcOutput(output, scalar.name, decodeScalar(
      parameter,
      scalar.value,
      invocationStructures,
      int8Mode,
      bcd,
    ));
  }
  for (const table of grouped.tables) {
    if (returnedNames.has(table.name)) {
      throw new Error(`classic RFC response contains duplicate parameter ${table.name}`);
    }
    returnedNames.add(table.name);
    if (notRequested.has(table.name) || deactivated.has(table.name)) continue;
    const parameter = parameters.get(table.name);
    if (parameter === undefined) {
      throw new Error(`classic RFC response returned unknown table ${table.name}`);
    }
    if (parameter.parameterClass !== "T") {
      throw new Error(`classic RFC response returned non-table parameter ${table.name}`);
    }
    if (!requestedOutputs.has(table.name)) continue;
    if (recursiveXrfc.has(table.name)) {
      throw new Error(
        `classic RFC response returned a binary table for recursive parameter ${table.name}`,
      );
    }
    const expectedRowByteLength = tableRowByteLength(
      parameter,
      invocationStructures,
      int8Mode,
    );
    const structuredDefinition = parameter.exid === "u"
      ? validateClassicStructureCodec(
          structureFor(parameter, invocationStructures),
        )
      : undefined;
    const exactFieldByteLength = structuredExactFieldByteLength(
      structuredDefinition,
      expectedRowByteLength,
    );
    const declaredRowByteLength = table.declaredRowByteLength;
    if (
      declaredRowByteLength !== expectedRowByteLength &&
      declaredRowByteLength !== exactFieldByteLength
    ) {
      throw new Error(
        `${table.name} declared row width ${table.declaredRowByteLength} does not ` +
          `match metadata width ${expectedRowByteLength}` +
          (exactFieldByteLength === undefined
            ? ""
            : ` or exact field width ${exactFieldByteLength}`),
      );
    }
    const responseRowByteLength =
      table.rows[0]?.byteLength ?? declaredRowByteLength;
    if (
      responseRowByteLength !== expectedRowByteLength &&
      responseRowByteLength !== exactFieldByteLength
    ) {
      throw new Error(
        `${table.name} row 0 width ${responseRowByteLength} does not ` +
          `match metadata width ${expectedRowByteLength}` +
          (exactFieldByteLength === undefined
            ? ""
            : ` or exact field width ${exactFieldByteLength}`),
      );
    }
    for (let index = 0; index < table.rows.length; index += 1) {
      const row = table.rows[index]!;
      if (row.byteLength !== responseRowByteLength) {
        throw new Error(
          `${table.name} row ${index} width ${row.byteLength} does not ` +
            `match first row width ${responseRowByteLength}`,
        );
      }
    }
    const responseStructureDefinition = structuredDefinition === undefined
      ? undefined
      : structuredResponseDefinition(
          structuredDefinition,
          responseRowByteLength,
        );
    defineClassicRfcOutput(output, table.name, parameter.exid === "u"
      ? table.rows.map((row) =>
          decodeClassicStructure(
            responseStructureDefinition!,
            row,
            { int8Mode, bcd },
          )
        )
      : table.rows.map((row) =>
          decodeScalar(parameter, row, invocationStructures, int8Mode, bcd)
        ));
  }
  for (const xrfc of grouped.xrfcParameters) {
    const name = decodeRecursiveXrfcParameterName(xrfc.value);
    if (returnedNames.has(name)) {
      throw new Error(`classic RFC response contains duplicate parameter ${name}`);
    }
    returnedNames.add(name);
    if (notRequested.has(name) || deactivated.has(name)) continue;
    const parameter = parameters.get(name);
    if (parameter === undefined) {
      throw new Error(`classic RFC response returned unknown xRFC parameter ${name}`);
    }
    if (
      parameter.parameterClass !== "E" &&
      parameter.parameterClass !== "C" &&
      parameter.parameterClass !== "T"
    ) {
      throw new Error(`classic RFC response returned non-output xRFC parameter ${name}`);
    }
    if (!requestedOutputs.has(name)) continue;
    const recursive = recursiveXrfc.get(name);
    const kind = recursive === undefined
      ? classicXrfcKind(parameter, invocationStructures)
      : recursive.kind;
    if (kind === undefined) {
      throw new Error(
        `classic RFC response returned xRFC XML for non-deep parameter ${name}`,
      );
    }
    defineClassicRfcOutput(
      output,
      name,
      recursive === undefined
        ? decodeClassicXrfcParameter(
            name,
            structureFor(parameter, invocationStructures),
            kind,
            xrfc.value,
            { int8Mode, bcd },
          )
        : recursive.serializer === "recursive-classic-xrfc"
          ? decodeRecursiveClassicXrfcParameter(
              recursive.parameter,
              xrfc.value,
            )
          : decodeResolvedRecursiveXrfcParameter(
              parameter,
              recursiveMetadata!,
              recursive.parameter,
              xrfc.value,
              { int8Mode, bcd },
            ),
    );
  }
  for (const parameter of invocationMetadata.parameters) {
    if (
      requestedOutputs.has(parameter.parameterName) &&
      !Object.hasOwn(output, parameter.parameterName)
    ) {
      throw new Error(
        `classic RFC response lacks requested output ${parameter.parameterName}`,
      );
    }
  }
  return output;
}
