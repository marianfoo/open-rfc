import type { RfcFunctionInterface } from "./rfc-function-interface.js";
import type {
  RfcStructureDefinition,
  RfcStructureField,
} from "./rfc-structure-definition.js";
import type { RfcFunintParameter } from "../protocol/classic-rfc.js";
import { validateClassicStructureCodec } from "../values/classic-structure.js";
import {
  RecursiveMetadataError,
  normalizeRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "./recursive-metadata.js";

const MAX_METADATA_ROWS = 100_000;
// Keep the recursive wrapper aligned with recursive-metadata's default total
// row budget so the broader flat normalizer cannot allocate first.
const MAX_RECURSIVE_METADATA_ROWS = 20_000;
const MAX_STRUCTURE_FIELDS = 9_999;
const MAX_TIMESTAMP_NAMES_PER_KIND = 512;

const REMOTE_DDIC_RESOLUTION_ERRORS = "REMOTE_DDIC_RESOLUTION_ERRORS";

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      Reflect.apply(callbackfn, thisArg, [value, key, this]);
    }
  }
}

function metadataName(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 30 ||
    /[^\x20-\x7e]/u.test(value)
  ) {
    throw new RangeError(`${path} must contain 1..30 ASCII bytes`);
  }
  return value;
}

function sapLanguage(value: unknown): string {
  if (typeof value !== "string" || !/^[\x20-\x7e]$/u.test(value)) {
    throw new RangeError("language must contain one printable SAP language code");
  }
  return value;
}

function parameter(
  parameterName: string,
  parameterClass: string,
  options: {
    readonly tableName?: string;
    readonly exid?: string;
    readonly internalLength?: number;
    readonly optional?: boolean;
  } = {},
): RfcFunintParameter {
  return Object.freeze({
    parameterClass,
    parameterName,
    tableName: options.tableName ?? "",
    fieldName: "",
    exid: options.exid ?? (parameterClass === "T" ? "u" : "C"),
    position: 0,
    offset: 0,
    internalLength: options.internalLength ?? 0,
    decimals: 0,
    defaultValue: "",
    parameterText: "",
    optional: options.optional ?? false,
  });
}

function field(
  tableName: string,
  fieldName: string,
  position: number,
  offset: number,
  internalLength: number,
  exid: string,
  decimals = 0,
): RfcStructureField {
  return Object.freeze({
    tableName,
    fieldName,
    position,
    offset,
    internalLength,
    decimals,
    exid,
  });
}

function structure(
  name: string,
  byteLength: number,
  fields: readonly RfcStructureField[],
): RfcStructureDefinition {
  return validateClassicStructureCodec(Object.freeze({
    name,
    byteLength,
    fields: Object.freeze([...fields]),
  }), name);
}

const BOOTSTRAP_STRUCTURES = Object.freeze([
  structure("RFCFUNCTIONNAME", 90, [
    field("RFCFUNCTIONNAME", "FUNCTIONNAME", 1, 0, 60, "C"),
    field("RFCFUNCTIONNAME", "BASXML_SUPPORTED", 2, 60, 2, "C"),
    field("RFCFUNCTIONNAME", "UDAT", 3, 62, 16, "D"),
    field("RFCFUNCTIONNAME", "UTIME", 4, 78, 12, "T"),
  ]),
  structure("RFC_MD_DDIC_NAME", 120, [
    field("RFC_MD_DDIC_NAME", "TABNAME", 1, 0, 60, "C"),
    field("RFC_MD_DDIC_NAME", "FIELDNAME", 2, 60, 60, "C"),
  ]),
  structure("RFC_METADATA_PARAMS", 464, [
    field("RFC_METADATA_PARAMS", "FUNCNAME", 1, 0, 60, "C"),
    field("RFC_METADATA_PARAMS", "PARAMCLASS", 2, 60, 2, "C"),
    field("RFC_METADATA_PARAMS", "PARAMETER", 3, 62, 60, "C"),
    field("RFC_METADATA_PARAMS", "TABNAME", 4, 122, 60, "C"),
    field("RFC_METADATA_PARAMS", "FIELDNAME", 5, 182, 60, "C"),
    field("RFC_METADATA_PARAMS", "EXID", 6, 242, 2, "C"),
    field("RFC_METADATA_PARAMS", "POSITION", 7, 244, 4, "I"),
    field("RFC_METADATA_PARAMS", "OFFSET", 8, 248, 4, "I"),
    field("RFC_METADATA_PARAMS", "INTLENGTH", 9, 252, 4, "I"),
    field("RFC_METADATA_PARAMS", "DECIMALS", 10, 256, 4, "I"),
    field("RFC_METADATA_PARAMS", "DEFAULT", 11, 260, 42, "C"),
    field("RFC_METADATA_PARAMS", "PARAMTEXT", 12, 302, 158, "C"),
    field("RFC_METADATA_PARAMS", "OPTIONAL", 13, 460, 2, "C"),
  ]),
  structure("RFC_METADATA_DDIC", 424, [
    field("RFC_METADATA_DDIC", "TYPENAME", 1, 0, 60, "C"),
    field("RFC_METADATA_DDIC", "FIELDNAME", 2, 60, 60, "C"),
    field("RFC_METADATA_DDIC", "COMPTYPE", 3, 120, 2, "C"),
    field("RFC_METADATA_DDIC", "FIELDTYPE", 4, 122, 60, "C"),
    field("RFC_METADATA_DDIC", "DATATYPE", 5, 182, 8, "C"),
    field("RFC_METADATA_DDIC", "TABLENGTH", 6, 190, 12, "N"),
    field("RFC_METADATA_DDIC", "TABLENGTH_UC", 7, 202, 12, "N"),
    field("RFC_METADATA_DDIC", "DESCRIPTION", 8, 214, 120, "C"),
    field("RFC_METADATA_DDIC", "DECIMALS", 9, 334, 12, "N"),
    field("RFC_METADATA_DDIC", "INTTYPE", 10, 346, 2, "C"),
    field("RFC_METADATA_DDIC", "OFFSET", 11, 348, 12, "N"),
    field("RFC_METADATA_DDIC", "OFFSET_UC", 12, 360, 12, "N"),
    field("RFC_METADATA_DDIC", "INTLEN", 13, 372, 12, "N"),
    field("RFC_METADATA_DDIC", "INTLEN_UC", 14, 384, 12, "N"),
    field("RFC_METADATA_DDIC", "TIMESTAMP", 15, 396, 28, "C"),
  ]),
  structure("RFC_METADATA_DDIC_INDIRECT", 180, [
    field("RFC_METADATA_DDIC_INDIRECT", "TABNAME", 1, 0, 60, "C"),
    field("RFC_METADATA_DDIC_INDIRECT", "FIELDNAME", 2, 60, 60, "C"),
    field("RFC_METADATA_DDIC_INDIRECT", "FIELDTYPE", 3, 120, 60, "C"),
  ]),
  structure("RFC_FUNC_ERROR", 630, [
    field("RFC_FUNC_ERROR", "FUNCNAME", 1, 0, 60, "C"),
    field("RFC_FUNC_ERROR", "EXCEPTION", 2, 60, 60, "C"),
    field("RFC_FUNC_ERROR", "EXCEPTION_TEXT", 3, 120, 510, "C"),
  ]),
  structure("RFC_DD_ERROR", 690, [
    field("RFC_DD_ERROR", "TABNAME", 1, 0, 60, "C"),
    field("RFC_DD_ERROR", "FIELDNAME", 2, 60, 60, "C"),
    field("RFC_DD_ERROR", "EXCEPTION", 3, 120, 60, "C"),
    field("RFC_DD_ERROR", "EXCEPTION_TEXT", 4, 180, 510, "C"),
  ]),
]);

const BOOTSTRAP_METADATA: RfcFunctionInterface = Object.freeze({
  name: "RFC_METADATA_GET",
  remoteBasxmlSupported: false,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([
    parameter("DEEP", "I", { internalLength: 1, optional: true }),
    parameter("LANGUAGE", "I", { internalLength: 1, optional: true }),
    parameter("GET_CLIENT_DEP_FIELDS", "I", { internalLength: 1, optional: true }),
    parameter("GET_TIMESTAMPS", "I", { internalLength: 1, optional: true }),
    parameter("FUNCTIONNAMES", "T", { tableName: "RFCFUNCTIONNAME" }),
    parameter("DATATYPES", "T", { tableName: "RFC_MD_DDIC_NAME" }),
    parameter("KNOWN_DATATYPES", "T", { tableName: "RFC_MD_DDIC_NAME" }),
    parameter("PARAMETERS", "T", { tableName: "RFC_METADATA_PARAMS" }),
    parameter("DATATYPESCONT", "T", { tableName: "RFC_METADATA_DDIC" }),
    parameter("INDIRECTTYPES", "T", { tableName: "RFC_METADATA_DDIC_INDIRECT" }),
    parameter("FUNC_ERRORS", "T", { tableName: "RFC_FUNC_ERROR", optional: true }),
    parameter("DD_ERRORS", "T", { tableName: "RFC_DD_ERROR", optional: true }),
  ]),
  exceptions: Object.freeze(["INVALID_MODE", "INTERNAL_ERROR"]),
  resumableExceptionRowCount: 0,
});

export interface RfcMetadataGetBootstrap {
  readonly metadata: RfcFunctionInterface;
  readonly structures: ReadonlyMap<string, RfcStructureDefinition>;
}

export const RFC_METADATA_GET_BOOTSTRAP: RfcMetadataGetBootstrap =
  Object.freeze({
    metadata: BOOTSTRAP_METADATA,
    structures: new ImmutableMap(
      BOOTSTRAP_STRUCTURES.map((definition) =>
        [definition.name, definition] as const),
    ),
  });

const TIMESTAMP_BOOTSTRAP_STRUCTURES = Object.freeze([
  structure("RFC_METADATA_FUNC_TIMESTAMP", 88, [
    field("RFC_METADATA_FUNC_TIMESTAMP", "FUNCNAME", 1, 0, 60, "C"),
    field("RFC_METADATA_FUNC_TIMESTAMP", "UDAT", 2, 60, 16, "D"),
    field("RFC_METADATA_FUNC_TIMESTAMP", "UTIME", 3, 76, 12, "T"),
  ]),
  structure("RFC_METADATA_DDIC_TIMESTAMP", 88, [
    field("RFC_METADATA_DDIC_TIMESTAMP", "TYPENAME", 1, 0, 60, "C"),
    field("RFC_METADATA_DDIC_TIMESTAMP", "TIMESTAMP", 2, 60, 28, "C"),
  ]),
  ...BOOTSTRAP_STRUCTURES.filter((definition) =>
    definition.name === "RFC_FUNC_ERROR" || definition.name === "RFC_DD_ERROR"),
]);

const TIMESTAMP_BOOTSTRAP_METADATA: RfcFunctionInterface = Object.freeze({
  name: "RFC_METADATA_GET_TIMESTAMP",
  remoteBasxmlSupported: false,
  remoteCall: "R",
  updateTask: false,
  parameters: Object.freeze([
    parameter("FUNCTION_TIMESTAMPS", "T", {
      tableName: "RFC_METADATA_FUNC_TIMESTAMP",
    }),
    parameter("DDIC_TIMESTAMPS", "T", {
      tableName: "RFC_METADATA_DDIC_TIMESTAMP",
    }),
    parameter("FUNC_ERRORS", "T", {
      tableName: "RFC_FUNC_ERROR",
      optional: true,
    }),
    parameter("DD_ERRORS", "T", {
      tableName: "RFC_DD_ERROR",
      optional: true,
    }),
  ]),
  exceptions: Object.freeze([]),
  resumableExceptionRowCount: 0,
});

/**
 * Classic bootstrap for SAP's bounded metadata-generation lookup. Its exact
 * four TABLES parameters are available on the beta's 7.50 and 7.58 lines and
 * avoid loading a descriptor merely to decide whether a cached one is stale.
 */
export const RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP: RfcMetadataGetBootstrap =
  Object.freeze({
    metadata: TIMESTAMP_BOOTSTRAP_METADATA,
    structures: new ImmutableMap(
      TIMESTAMP_BOOTSTRAP_STRUCTURES.map((definition) =>
        [definition.name, definition] as const),
    ),
  });

export interface RfcMetadataGetInvocation {
  readonly input: Readonly<Record<string, unknown>>;
}

export interface RfcMetadataGetTimestampInvocation
  extends RfcMetadataGetInvocation {
  /** Captured request identities used to validate the asynchronous response. */
  readonly functionNames: readonly string[];
  readonly structureNames: readonly string[];
}

function baseInput(language: string): Record<string, unknown> {
  return {
    DEEP: "X",
    LANGUAGE: language,
    GET_TIMESTAMPS: "X",
    FUNCTIONNAMES: [],
    DATATYPES: [],
    KNOWN_DATATYPES: [],
    PARAMETERS: [],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    FUNC_ERRORS: [],
    DD_ERRORS: [],
  };
}

function freezeInput(input: Record<string, unknown>): RfcMetadataGetInvocation {
  for (const value of Object.values(input)) {
    if (Array.isArray(value)) {
      for (const row of value) {
        if (typeof row === "object" && row !== null) Object.freeze(row);
      }
      Object.freeze(value);
    }
  }
  return Object.freeze({ input: Object.freeze(input) });
}

export function createRfcMetadataGetFunctionInvocation(
  functionName: string,
  language = "E",
): RfcMetadataGetInvocation {
  const name = metadataName(functionName, "functionName");
  const input = baseInput(sapLanguage(language));
  input.FUNCTIONNAMES = [{ FUNCTIONNAME: name }];
  return freezeInput(input);
}

export function createRfcMetadataGetStructureInvocation(
  structureName: string,
  language = "E",
): RfcMetadataGetInvocation {
  const name = metadataName(structureName, "structureName");
  const input = baseInput(sapLanguage(language));
  input.DATATYPES = [{ TABNAME: name }];
  return freezeInput(input);
}

function requestedMetadataNames(
  value: readonly string[],
  kind: "function" | "structure",
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${kind} names must be an array`);
  }
  if (value.length > MAX_TIMESTAMP_NAMES_PER_KIND) {
    throw new RangeError(
      `RFC_METADATA_GET_TIMESTAMP accepts at most ${MAX_TIMESTAMP_NAMES_PER_KIND} ${kind} names`,
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const name = metadataName(
      dataProperty(
        value as unknown as Readonly<Record<string, unknown>>,
        String(index),
        `${kind} names`,
      ),
      `${kind} names[${index}]`,
    );
    if (seen.has(name)) {
      throw new Error(`duplicate ${kind} name ${name}`);
    }
    seen.add(name);
    names.push(name);
  }
  return Object.freeze(names);
}

/** Snapshot one bounded timestamp batch before asynchronous metadata I/O. */
export function createRfcMetadataGetTimestampInvocation(
  functionNames: readonly string[],
  structureNames: readonly string[],
): RfcMetadataGetTimestampInvocation {
  const functions = requestedMetadataNames(functionNames, "function");
  const structures = requestedMetadataNames(structureNames, "structure");
  const invocation = freezeInput({
    FUNCTION_TIMESTAMPS: functions.map((FUNCNAME) => ({ FUNCNAME })),
    DDIC_TIMESTAMPS: structures.map((TYPENAME) => ({ TYPENAME })),
    FUNC_ERRORS: [],
    DD_ERRORS: [],
  });
  return Object.freeze({
    input: invocation.input,
    functionNames: functions,
    structureNames: structures,
  });
}

function plainRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function dataProperty(
  value: Readonly<Record<string, unknown>>,
  name: string,
  path: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
  } catch {
    throw new TypeError(`${path}.${name} must be an own data property`);
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`${path}.${name} must be an own data property`);
  }
  return descriptor.value;
}

function rows(
  output: Readonly<Record<string, unknown>>,
  name: string,
  maximum = MAX_METADATA_ROWS,
): readonly Readonly<Record<string, unknown>>[] {
  const source = dataProperty(output, name, "RFC_METADATA_GET output");
  if (!Array.isArray(source) || source.length > maximum) {
    throw new RangeError(
      `RFC_METADATA_GET output ${name} must contain at most ${maximum} rows`,
    );
  }
  const result: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    result.push(
      plainRecord(
        dataProperty(
          source as unknown as Readonly<Record<string, unknown>>,
          String(index),
          `RFC_METADATA_GET output ${name}`,
        ),
        `RFC_METADATA_GET output ${name}[${index}]`,
      ),
    );
  }
  return Object.freeze(result);
}

function assertRecursiveMetadataRowBudget(
  output: Readonly<Record<string, unknown>>,
): void {
  let total = 0;
  for (const name of [
    "FUNCTIONNAMES",
    "DATATYPESCONT",
    "INDIRECTTYPES",
    "PARAMETERS",
  ]) {
    const source = dataProperty(output, name, "RFC_METADATA_GET output");
    if (!Array.isArray(source)) {
      throw new TypeError(`RFC_METADATA_GET output ${name} must be an array`);
    }
    total += source.length;
    if (total > MAX_RECURSIVE_METADATA_ROWS) {
      throw new RangeError(
        `RFC_METADATA_GET recursive metadata must contain at most ` +
          `${MAX_RECURSIVE_METADATA_ROWS} total rows`,
      );
    }
  }
}

function text(
  row: Readonly<Record<string, unknown>>,
  name: string,
  path: string,
  maximum = 255,
): string {
  const value = dataProperty(row, name, path);
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${path}.${name} contains invalid text`);
  }
  return value;
}

function integer(
  row: Readonly<Record<string, unknown>>,
  name: string,
  path: string,
): number {
  const value = dataProperty(row, name, path);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${path}.${name} must be a non-negative safe integer`);
}

function flag(value: string, path: string): boolean {
  if (value !== "" && value !== "X") {
    throw new Error(`${path} must be initial or X`);
  }
  return value === "X";
}

function fixedDigits(
  row: Readonly<Record<string, unknown>>,
  name: string,
  path: string,
  length: number,
): string {
  const value = text(row, name, path, length);
  if (value.length !== length || !/^\d+$/u.test(value)) {
    throw new Error(`${path}.${name} must contain exactly ${length} digits`);
  }
  return value;
}

export interface RfcFunctionMetadataTimestamp {
  readonly functionName: string;
  readonly date: string;
  readonly time: string;
  readonly token: string;
}

export interface RfcStructureMetadataTimestamp {
  readonly structureName: string;
  readonly timestamp: string;
  readonly token: string;
}

export interface RfcMetadataTimestampBatch {
  readonly functions: ReadonlyMap<string, RfcFunctionMetadataTimestamp>;
  readonly structures: ReadonlyMap<string, RfcStructureMetadataTimestamp>;
  readonly functionErrors: ReadonlyMap<string, string>;
  readonly structureErrors: ReadonlyMap<string, string>;
}

/**
 * One optimized function descriptor and the generation observed in the same
 * RFC_METADATA_GET response. Keeping these values inseparable prevents a
 * descriptor/timestamp race between two backend calls.
 */
export interface RfcMetadataGetFunctionResult {
  readonly value: RfcFunctionInterface;
  readonly generationToken: string;
}

/** Same-response optimized DDIC descriptor and generation identity. */
export interface RfcMetadataGetStructureResult {
  readonly value: RfcStructureDefinition;
  readonly generationToken: string;
}

/**
 * A complete function type closure and the function generation captured by
 * the same RFC_METADATA_GET response.
 */
export interface RfcMetadataGetRecursiveFunctionResult {
  readonly value: RecursiveMetadataGraph;
  readonly generationToken: string;
}

function timestampErrorRows(
  output: Readonly<Record<string, unknown>>,
  tableName: "FUNC_ERRORS" | "DD_ERRORS",
  keyName: "FUNCNAME" | "TABNAME",
  requested: ReadonlySet<string>,
  outcomes: Set<string>,
  kind: "function" | "structure",
): readonly (readonly [string, string])[] {
  const errors: (readonly [string, string])[] = [];
  const errorRows = rows(output, tableName, requested.size);
  for (let index = 0; index < errorRows.length; index += 1) {
    const row = errorRows[index]!;
    const path = `RFC_METADATA_GET_TIMESTAMP output ${tableName}[${index}]`;
    const objectName = metadataName(
      text(row, keyName, path, 30),
      `${path}.${keyName}`,
    );
    if (!requested.has(objectName)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned unrequested ${kind} ${objectName}`,
      );
    }
    if (outcomes.has(objectName)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned duplicate outcome for ${kind} ${objectName}`,
      );
    }
    const exception = text(row, "EXCEPTION", path, 30);
    if (!/^[A-Z0-9_]{1,30}$/u.test(exception)) {
      throw new Error(`${path}.EXCEPTION is invalid`);
    }
    outcomes.add(objectName);
    errors.push(Object.freeze([objectName, exception] as const));
  }
  return Object.freeze(errors);
}

/**
 * Normalize a complete timestamp batch. Every requested object must have
 * exactly one success or typed error outcome; foreign rows cannot poison a
 * structural cache and localized backend text is deliberately discarded.
 */
export function normalizeRfcMetadataGetTimestamps(
  functionNames: readonly string[],
  structureNames: readonly string[],
  value: unknown,
): RfcMetadataTimestampBatch {
  const requestedFunctions = requestedMetadataNames(functionNames, "function");
  const requestedStructures = requestedMetadataNames(structureNames, "structure");
  const functionSet = new Set(requestedFunctions);
  const structureSet = new Set(requestedStructures);
  const output = plainRecord(value, "RFC_METADATA_GET_TIMESTAMP output");
  const functionOutcomes = new Set<string>();
  const structureOutcomes = new Set<string>();
  const functions: (readonly [string, RfcFunctionMetadataTimestamp])[] = [];
  const structures: (readonly [string, RfcStructureMetadataTimestamp])[] = [];

  const functionRows = rows(
    output,
    "FUNCTION_TIMESTAMPS",
    requestedFunctions.length,
  );
  for (let index = 0; index < functionRows.length; index += 1) {
    const row = functionRows[index]!;
    const path =
      `RFC_METADATA_GET_TIMESTAMP output FUNCTION_TIMESTAMPS[${index}]`;
    const functionName = metadataName(
      text(row, "FUNCNAME", path, 30),
      `${path}.FUNCNAME`,
    );
    if (!functionSet.has(functionName)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned unrequested function ${functionName}`,
      );
    }
    if (functionOutcomes.has(functionName)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned duplicate outcome for function ${functionName}`,
      );
    }
    const date = fixedDigits(row, "UDAT", path, 8);
    const time = fixedDigits(row, "UTIME", path, 6);
    functionOutcomes.add(functionName);
    functions.push(Object.freeze([functionName, Object.freeze({
      functionName,
      date,
      time,
      token: `function:${date}:${time}`,
    })] as const));
  }

  const structureRows = rows(
    output,
    "DDIC_TIMESTAMPS",
    requestedStructures.length,
  );
  for (let index = 0; index < structureRows.length; index += 1) {
    const row = structureRows[index]!;
    const path = `RFC_METADATA_GET_TIMESTAMP output DDIC_TIMESTAMPS[${index}]`;
    const structureName = metadataName(
      text(row, "TYPENAME", path, 30),
      `${path}.TYPENAME`,
    );
    if (!structureSet.has(structureName)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned unrequested structure ${structureName}`,
      );
    }
    if (structureOutcomes.has(structureName)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned duplicate outcome for structure ${structureName}`,
      );
    }
    const timestamp = fixedDigits(row, "TIMESTAMP", path, 14);
    structureOutcomes.add(structureName);
    structures.push(Object.freeze([structureName, Object.freeze({
      structureName,
      timestamp,
      token: `structure:${timestamp}`,
    })] as const));
  }

  const functionErrors = timestampErrorRows(
    output,
    "FUNC_ERRORS",
    "FUNCNAME",
    functionSet,
    functionOutcomes,
    "function",
  );
  const structureErrors = timestampErrorRows(
    output,
    "DD_ERRORS",
    "TABNAME",
    structureSet,
    structureOutcomes,
    "structure",
  );
  for (const name of requestedFunctions) {
    if (!functionOutcomes.has(name)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned no outcome for function ${name}`,
      );
    }
  }
  for (const name of requestedStructures) {
    if (!structureOutcomes.has(name)) {
      throw new Error(
        `RFC_METADATA_GET_TIMESTAMP returned no outcome for structure ${name}`,
      );
    }
  }
  return Object.freeze({
    functions: new ImmutableMap(functions),
    structures: new ImmutableMap(structures),
    functionErrors: new ImmutableMap(functionErrors),
    structureErrors: new ImmutableMap(structureErrors),
  });
}

function normalizedFunctionInternalLength(
  exid: string,
  value: number,
  path: string,
): number {
  // RFC_METADATA_GET reports the Unicode byte width for fixed character-like
  // scalar parameters. RfcFunintParameter, like RFC_GET_FUNCTION_INTERFACE,
  // stores their logical character width; the invocation codec applies the
  // Unicode factor when it writes them. Other scalar and structure lengths
  // are already byte widths and must remain unchanged.
  if (!["C", "N", "D", "T"].includes(exid)) return value;
  if ((value & 1) !== 0) {
    throw new Error(`${path}.INTLENGTH has an odd Unicode byte width`);
  }
  return value / 2;
}

function matchingError(
  output: Readonly<Record<string, unknown>>,
  tableName: "FUNC_ERRORS" | "DD_ERRORS",
  keyName: "FUNCNAME" | "TABNAME",
  objectName: string,
): string | undefined {
  const errors = rows(output, tableName);
  for (let index = 0; index < errors.length; index += 1) {
    const row = errors[index]!;
    const path = `RFC_METADATA_GET output ${tableName}[${index}]`;
    if (text(row, keyName, path, 30) !== objectName) continue;
    const exception = text(row, "EXCEPTION", path, 30);
    if (!/^[A-Z0-9_]{1,30}$/u.test(exception)) {
      throw new Error(`${path}.EXCEPTION is invalid`);
    }
    return exception;
  }
  return undefined;
}

export function normalizeRfcMetadataGetFunctionResult(
  functionName: string,
  value: unknown,
): RfcMetadataGetFunctionResult {
  const name = metadataName(functionName, "functionName");
  const output = plainRecord(value, "RFC_METADATA_GET output");
  const failure = matchingError(output, "FUNC_ERRORS", "FUNCNAME", name);
  if (failure !== undefined) {
    throw new Error(`RFC_METADATA_GET could not resolve function ${name} (${failure})`);
  }
  const functionRows = rows(output, "FUNCTIONNAMES");
  const matches = functionRows.filter((row, index) =>
    text(row, "FUNCTIONNAME", `RFC_METADATA_GET output FUNCTIONNAMES[${index}]`, 30) === name);
  if (matches.length !== 1) {
    throw new Error(`RFC_METADATA_GET returned ${matches.length} identities for function ${name}`);
  }
  const identity = matches[0]!;
  const identityPath = "RFC_METADATA_GET function identity";
  const basxml = flag(
    text(identity, "BASXML_SUPPORTED", identityPath, 1),
    "RFC_METADATA_GET BASXML_SUPPORTED",
  );
  const parameterRows = rows(output, "PARAMETERS");
  const parameters: RfcFunintParameter[] = [];
  const exceptions: string[] = [];
  const names = new Set<string>();
  for (let index = 0; index < parameterRows.length; index += 1) {
    const row = parameterRows[index]!;
    const path = `RFC_METADATA_GET output PARAMETERS[${index}]`;
    if (text(row, "FUNCNAME", path, 30) !== name) continue;
    const parameterClass = text(row, "PARAMCLASS", path, 1);
    if (!/^[IECXT]$/u.test(parameterClass)) {
      throw new Error(`${path}.PARAMCLASS is unsupported`);
    }
    const parameterName = metadataName(text(row, "PARAMETER", path, 30),
      `${path}.PARAMETER`);
    if (names.has(parameterName)) {
      throw new Error(`RFC_METADATA_GET returned duplicate parameter ${parameterName}`);
    }
    const position = integer(row, "POSITION", path);
    // RFC_METADATA_GET legitimately emits zero and duplicate positions. The
    // response row order remains authoritative for ties.
    names.add(parameterName);
    if (parameterClass === "X") {
      exceptions.push(parameterName);
      continue;
    }
    const exid = text(row, "EXID", path, 1);
    const normalized = Object.freeze({
      parameterClass,
      parameterName,
      tableName: text(row, "TABNAME", path, 30),
      fieldName: text(row, "FIELDNAME", path, 30),
      exid,
      position,
      offset: integer(row, "OFFSET", path),
      internalLength: normalizedFunctionInternalLength(
        exid,
        integer(row, "INTLENGTH", path),
        path,
      ),
      decimals: integer(row, "DECIMALS", path),
      defaultValue: text(row, "DEFAULT", path, 21),
      parameterText: text(row, "PARAMTEXT", path, 79),
      optional: flag(text(row, "OPTIONAL", path, 1), `${path}.OPTIONAL`),
    });
    parameters.push(normalized);
  }
  const descriptor = Object.freeze({
    name,
    remoteBasxmlSupported: basxml,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze(parameters),
    exceptions: Object.freeze(exceptions),
    resumableExceptionRowCount: 0,
  });
  const date = fixedDigits(identity, "UDAT", identityPath, 8);
  const time = fixedDigits(identity, "UTIME", identityPath, 6);
  return Object.freeze({
    value: descriptor,
    generationToken: `function:${date}:${time}`,
  });
}

export function normalizeRfcMetadataGetFunction(
  functionName: string,
  value: unknown,
): RfcFunctionInterface {
  return normalizeRfcMetadataGetFunctionResult(functionName, value).value;
}

function isCompleteUtclongScalarFallback(
  output: Readonly<Record<string, unknown>>,
  descriptor: RfcFunctionInterface,
  ddicErrors: readonly Readonly<Record<string, unknown>>[],
): boolean {
  // Some S/4 releases report the built-in UTCLONG scalar as an unresolved
  // DDIC object even though PARAMETERS already carries its complete classic
  // scalar codec. Admit only that one observed, self-contained shape. This is
  // deliberately not a general "ignore DD_ERRORS" escape hatch: any field
  // lookup, different exception, incomplete parameter, or contradictory DDIC
  // row remains a hard failure.
  if (ddicErrors.length !== 1) return false;
  const error = ddicErrors[0]!;
  const errorPath = "RFC_METADATA_GET output DD_ERRORS[0]";
  if (
    text(error, "TABNAME", errorPath, 30) !== "UTCLONG" ||
    text(error, "FIELDNAME", errorPath, 30) !== "" ||
    text(error, "EXCEPTION", errorPath, 30) !== "NOT_FOUND"
  ) {
    return false;
  }

  let matches = 0;
  for (const parameter of descriptor.parameters) {
    if (parameter.tableName !== "UTCLONG") continue;
    matches += 1;
    if (
      parameter.parameterClass !== "C" ||
      parameter.fieldName !== "" ||
      parameter.exid !== "p" ||
      parameter.internalLength !== 8 ||
      parameter.decimals !== 0 ||
      parameter.optional
    ) {
      return false;
    }
  }
  if (matches === 0) return false;

  let rawMatches = 0;
  const parameterRows = rows(output, "PARAMETERS");
  for (let index = 0; index < parameterRows.length; index += 1) {
    const parameter = parameterRows[index]!;
    const path = `RFC_METADATA_GET output PARAMETERS[${index}]`;
    if (text(parameter, "TABNAME", path, 30) !== "UTCLONG") continue;
    rawMatches += 1;
    if (
      text(parameter, "FUNCNAME", path, 30) !== descriptor.name ||
      text(parameter, "PARAMCLASS", path, 1) !== "C" ||
      text(parameter, "FIELDNAME", path, 30) !== "" ||
      text(parameter, "EXID", path, 1) !== "p" ||
      integer(parameter, "INTLENGTH", path) !== 8 ||
      integer(parameter, "DECIMALS", path) !== 0 ||
      text(parameter, "OPTIONAL", path, 1) !== ""
    ) {
      return false;
    }
  }
  if (rawMatches === 0) return false;

  const typeRows = rows(output, "DATATYPESCONT");
  for (let index = 0; index < typeRows.length; index += 1) {
    const row = typeRows[index]!;
    const path = `RFC_METADATA_GET output DATATYPESCONT[${index}]`;
    for (const name of ["TYPENAME", "FIELDTYPE", "DATATYPE"]) {
      if (text(row, name, path, 30) === "UTCLONG") return false;
    }
  }

  const indirectRows = rows(output, "INDIRECTTYPES");
  for (let index = 0; index < indirectRows.length; index += 1) {
    const row = indirectRows[index]!;
    const path = `RFC_METADATA_GET output INDIRECTTYPES[${index}]`;
    if (
      text(row, "TABNAME", path, 30) === "UTCLONG" ||
      text(row, "FIELDTYPE", path, 30) === "UTCLONG"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Normalize a DEEP function response without splitting descriptor and
 * generation reads. The flat normalizer first validates SAP's function-error
 * table and exact identity; the recursive normalizer then validates the full
 * bounded type graph from those same captured rows.
 */
export function normalizeRfcMetadataGetRecursiveFunctionResult(
  functionName: string,
  value: unknown,
): RfcMetadataGetRecursiveFunctionResult {
  const name = metadataName(functionName, "functionName");
  const output = plainRecord(value, "RFC_METADATA_GET output");
  assertRecursiveMetadataRowBudget(output);
  const flat = normalizeRfcMetadataGetFunctionResult(name, output);
  const functionErrors = rows(output, "FUNC_ERRORS");
  if (functionErrors.length !== 0) {
    // A matching error was already projected by the flat normalizer. Any
    // remaining row therefore belongs to an unrequested function identity.
    throw new Error(
      "RFC_METADATA_GET recursive metadata returned a foreign function error",
    );
  }
  const ddicErrors = rows(output, "DD_ERRORS");
  if (
    ddicErrors.length !== 0 &&
    !isCompleteUtclongScalarFallback(output, flat.value, ddicErrors)
  ) {
    // A partial type closure is never safe to cache or flatten. Do not retain
    // localized backend text from the error rows in the public failure.
    throw new RecursiveMetadataError(
      REMOTE_DDIC_RESOLUTION_ERRORS,
      `DD_ERRORS:${ddicErrors.length}`,
    );
  }
  const recursiveInput = Object.freeze({
    FUNCTIONNAMES: dataProperty(
      output,
      "FUNCTIONNAMES",
      "RFC_METADATA_GET output",
    ),
    DATATYPESCONT: dataProperty(
      output,
      "DATATYPESCONT",
      "RFC_METADATA_GET output",
    ),
    INDIRECTTYPES: dataProperty(
      output,
      "INDIRECTTYPES",
      "RFC_METADATA_GET output",
    ),
    PARAMETERS: dataProperty(
      output,
      "PARAMETERS",
      "RFC_METADATA_GET output",
    ),
  });
  const graph = normalizeRecursiveMetadataGraph(recursiveInput);
  const identity = graph.functionIdentity;
  if (identity === undefined || identity.name !== name) {
    throw new Error(
      `RFC_METADATA_GET recursive metadata identity does not match function ${name}`,
    );
  }
  if (identity.generationToken !== flat.generationToken) {
    throw new Error(
      `RFC_METADATA_GET recursive metadata generation does not match function ${name}`,
    );
  }
  return Object.freeze({
    value: graph,
    generationToken: flat.generationToken,
  });
}

export function normalizeRfcMetadataGetStructureResult(
  structureName: string,
  value: unknown,
): RfcMetadataGetStructureResult {
  const name = metadataName(structureName, "structureName");
  const output = plainRecord(value, "RFC_METADATA_GET output");
  const failure = matchingError(output, "DD_ERRORS", "TABNAME", name);
  if (failure !== undefined) {
    throw new Error(`RFC_METADATA_GET could not resolve structure ${name} (${failure})`);
  }
  const typeRows = rows(output, "DATATYPESCONT");
  const matches: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < typeRows.length; index += 1) {
    const row = typeRows[index]!;
    if (text(row, "TYPENAME", `RFC_METADATA_GET output DATATYPESCONT[${index}]`, 30) === name) {
      matches.push(row);
    }
  }
  if (matches.length === 0) {
    throw new Error(`RFC_METADATA_GET returned no type rows for structure ${name}`);
  }
  if (matches.length > MAX_STRUCTURE_FIELDS) {
    throw new RangeError(
      `RFC_METADATA_GET structure ${name} exceeds ${MAX_STRUCTURE_FIELDS} fields`,
    );
  }
  const fields: RfcStructureField[] = [];
  const fieldNames = new Set<string>();
  let byteLength: number | undefined;
  let generationTimestamp: string | undefined;
  let previousEnd = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const row = matches[index]!;
    const path = `RFC_METADATA_GET structure ${name}[${index}]`;
    const candidateByteLength = integer(row, "TABLENGTH_UC", path);
    if (byteLength === undefined) byteLength = candidateByteLength;
    if (candidateByteLength !== byteLength) {
      throw new Error(`RFC_METADATA_GET structure ${name} has inconsistent lengths`);
    }
    const candidateTimestamp = fixedDigits(row, "TIMESTAMP", path, 14);
    if (generationTimestamp === undefined) {
      generationTimestamp = candidateTimestamp;
    } else if (candidateTimestamp !== generationTimestamp) {
      throw new Error(
        `RFC_METADATA_GET structure ${name} has inconsistent timestamps`,
      );
    }
    const fieldName = metadataName(text(row, "FIELDNAME", path, 30),
      `${path}.FIELDNAME`);
    if (fieldNames.has(fieldName)) {
      throw new Error(`RFC_METADATA_GET structure ${name} has duplicate field ${fieldName}`);
    }
    const componentType = text(row, "COMPTYPE", path, 1);
    const exid = text(row, "INTTYPE", path, 1);
    // COMPTYPE is DDIC's declaration classification, not the wire type: per SAP
    // Note 1691982 the initial value and "E" are both elementary, the initial
    // form being emitted for components declared with a built-in DDIC type.
    // decodeDdIfFieldInfoGetResult already admits both. INTTYPE below still
    // routes every composite (u/h/v) to the recursive serializer, and the
    // geometry and codec validation further down stay unchanged.
    if (
      (componentType !== "" && componentType !== "E") ||
      exid === "u" || exid === "h" || exid === "v"
    ) {
      throw new Error(
        `RFC_METADATA_GET structure ${name}.${fieldName} requires a negotiated recursive serializer`,
      );
    }
    const offset = integer(row, "OFFSET_UC", path);
    const internalLength = integer(row, "INTLEN_UC", path);
    const end = offset + internalLength;
    if (
      !Number.isSafeInteger(end) ||
      offset < previousEnd ||
      end > candidateByteLength
    ) {
      throw new Error(`RFC_METADATA_GET structure ${name}.${fieldName} has invalid geometry`);
    }
    fieldNames.add(fieldName);
    previousEnd = end;
    fields.push(field(
      name,
      fieldName,
      index + 1,
      offset,
      internalLength,
      exid,
      integer(row, "DECIMALS", path),
    ));
  }
  const descriptor = validateClassicStructureCodec(Object.freeze({
    name,
    byteLength: byteLength!,
    fields: Object.freeze(fields),
  }), name);
  return Object.freeze({
    value: descriptor,
    generationToken: `structure:${generationTimestamp!}`,
  });
}

export function normalizeRfcMetadataGetStructure(
  structureName: string,
  value: unknown,
): RfcStructureDefinition {
  return normalizeRfcMetadataGetStructureResult(structureName, value).value;
}
