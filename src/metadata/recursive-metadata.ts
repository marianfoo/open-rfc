import { types as nodeUtilTypes } from "node:util";

import { ImmutableMetadataMap } from "./immutable-map.js";

export interface RecursiveMetadataLimits {
  readonly maxRows: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxDepth: number;
  readonly maxProperties: number;
  readonly maxBytes: number;
}

export interface RecursiveMetadataOptions {
  readonly limits?: Partial<RecursiveMetadataLimits>;
  readonly rootTypeNames?: readonly string[];
}

export type RecursiveMetadataReference =
  | Readonly<{
      kind: "scalar";
      internalType: string;
    }>
  | Readonly<{
      kind: "structure" | "table";
      targetType: string;
      cyclic: boolean;
    }>;

export interface RecursiveMetadataField {
  readonly name: string;
  readonly position: number;
  readonly componentType: string;
  readonly associatedType: string;
  readonly dataType: string;
  readonly internalType: string;
  readonly description: string;
  readonly decimals: number;
  readonly nucOffset: number;
  readonly ucOffset: number;
  readonly nucLength: number;
  readonly ucLength: number;
  readonly reference: RecursiveMetadataReference;
}

export interface RecursiveMetadataTypeNode {
  readonly name: string;
  readonly kind: "structure" | "table" | "scalar";
  readonly nucLength: number;
  readonly ucLength: number;
  readonly timestamp: string;
  readonly fields: readonly RecursiveMetadataField[];
}

export interface RecursiveMetadataFunctionIdentity {
  readonly name: string;
  readonly remoteBasxmlSupported: boolean;
  readonly generationToken: string;
}

export interface RecursiveMetadataParameter {
  readonly functionName: string;
  readonly name: string;
  readonly parameterClass: "I" | "E" | "C" | "T" | "X";
  readonly position: number;
  readonly associatedType: string;
  readonly fieldPath: string;
  readonly internalType: string;
  readonly internalLength: number;
  readonly decimals: number;
  readonly defaultValue: string;
  readonly parameterText: string;
  readonly optional: boolean;
  readonly reference: RecursiveMetadataParameterReference;
}

export type RecursiveMetadataParameterReference =
  | RecursiveMetadataReference
  | Readonly<{
      kind: "table";
      scalarLine: Readonly<{ internalType: string }>;
      cyclic: false;
    }>
  | Readonly<{ kind: "exception" }>;

export interface RecursiveMetadataCycle {
  readonly id: string;
  readonly typeNames: readonly string[];
}

export interface RecursiveMetadataStatistics {
  readonly rowCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly propertyCount: number;
  readonly byteCount: number;
  readonly maximumDepth: number;
}

export interface RecursiveMetadataGraph {
  readonly version: 1;
  readonly functionIdentity: RecursiveMetadataFunctionIdentity | undefined;
  readonly nodes: ReadonlyMap<string, RecursiveMetadataTypeNode>;
  readonly parameters: readonly RecursiveMetadataParameter[];
  readonly rootTypeNames: readonly string[];
  readonly cycles: readonly RecursiveMetadataCycle[];
  readonly limits: RecursiveMetadataLimits;
  readonly statistics: RecursiveMetadataStatistics;
}

const normalizedRecursiveMetadataGraphs = new WeakSet<object>();

/** Internal trust predicate for graphs produced by the bounded normalizer. */
export function isNormalizedRecursiveMetadataGraph(
  value: unknown,
): value is RecursiveMetadataGraph {
  return typeof value === "object" && value !== null &&
    normalizedRecursiveMetadataGraphs.has(value);
}

export class RecursiveMetadataError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string) {
    super(`recursive metadata rejected: ${code} at ${path}`);
    this.name = "RecursiveMetadataError";
    this.code = code;
    this.path = path;
  }
}

const DEFAULT_LIMITS: RecursiveMetadataLimits = Object.freeze({
  maxRows: 20_000,
  maxNodes: 4_096,
  maxEdges: 20_000,
  maxDepth: 64,
  maxProperties: 400_000,
  maxBytes: 8 * 1024 * 1024,
});

const ABSOLUTE_LIMITS: RecursiveMetadataLimits = Object.freeze({
  maxRows: 100_000,
  maxNodes: 20_000,
  maxEdges: 100_000,
  maxDepth: 256,
  maxProperties: 2_000_000,
  maxBytes: 32 * 1024 * 1024,
});

const LIMIT_KEYS = Object.freeze([
  "maxRows",
  "maxNodes",
  "maxEdges",
  "maxDepth",
  "maxProperties",
  "maxBytes",
] as const);

const INPUT_KEYS = Object.freeze([
  "FUNCTIONNAMES",
  "DATATYPESCONT",
  "INDIRECTTYPES",
  "PARAMETERS",
] as const);

const FUNCTION_ROW_KEYS = Object.freeze([
  "FUNCTIONNAME",
  "BASXML_SUPPORTED",
  "UDAT",
  "UTIME",
] as const);

const TYPE_ROW_KEYS = Object.freeze([
  "TYPENAME",
  "FIELDNAME",
  "COMPTYPE",
  "FIELDTYPE",
  "DATATYPE",
  "TABLENGTH",
  "TABLENGTH_UC",
  "DESCRIPTION",
  "DECIMALS",
  "INTTYPE",
  "OFFSET",
  "OFFSET_UC",
  "INTLEN",
  "INTLEN_UC",
  "TIMESTAMP",
] as const);

const INDIRECT_ROW_KEYS = Object.freeze([
  "TABNAME",
  "FIELDNAME",
  "FIELDTYPE",
] as const);

const PARAMETER_ROW_KEYS = Object.freeze([
  "FUNCNAME",
  "PARAMCLASS",
  "PARAMETER",
  "TABNAME",
  "FIELDNAME",
  "EXID",
  "POSITION",
  "OFFSET",
  "INTLENGTH",
  "DECIMALS",
  "DEFAULT",
  "PARAMTEXT",
  "OPTIONAL",
] as const);

interface Budget {
  readonly limits: RecursiveMetadataLimits;
  rows: number;
  properties: number;
  bytes: number;
}

type SafeRecord = Readonly<Record<string, unknown>>;

interface TypeRow {
  readonly typeName: string;
  readonly fieldName: string;
  readonly componentType: string;
  readonly associatedType: string;
  readonly dataType: string;
  readonly nucTotalLength: number;
  readonly ucTotalLength: number;
  readonly description: string;
  readonly decimals: number;
  readonly internalType: string;
  readonly nucOffset: number;
  readonly ucOffset: number;
  readonly nucLength: number;
  readonly ucLength: number;
  readonly timestamp: string;
}

interface IndirectRow {
  readonly tableName: string;
  readonly fieldPath: string;
  readonly targetType: string;
}

interface ParameterRow {
  readonly functionName: string;
  readonly parameterClass: "I" | "E" | "C" | "T" | "X";
  readonly parameterName: string;
  readonly tableName: string;
  readonly fieldPath: string;
  readonly internalType: string;
  readonly position: number;
  readonly internalLength: number;
  readonly decimals: number;
  readonly defaultValue: string;
  readonly parameterText: string;
  readonly optional: boolean;
}

interface ProvisionalReference {
  readonly kind: "scalar" | "structure" | "table";
  readonly internalType: string;
  readonly targetType?: string;
}

type ProvisionalParameterReference =
  | ProvisionalReference
  | Readonly<{ kind: "scalar-table"; internalType: string }>
  | Readonly<{ kind: "exception" }>;

interface ProvisionalField extends Omit<RecursiveMetadataField, "reference"> {
  readonly reference: ProvisionalReference;
}

interface ProvisionalNode {
  readonly name: string;
  readonly kind: "structure" | "table" | "scalar";
  readonly nucLength: number;
  readonly ucLength: number;
  readonly timestamp: string;
  readonly fields: readonly ProvisionalField[];
}

function reject(code: string, path: string): never {
  throw new RecursiveMetadataError(code, path);
}

function isProxy(value: object): boolean {
  return nodeUtilTypes.isProxy(value);
}

function safeOwnKeys(value: object, path: string): readonly string[] {
  if (isProxy(value)) reject("PROXY_INPUT", path);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    reject("HOSTILE_INPUT", path);
  }
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") reject("SYMBOL_PROPERTY", path);
    result.push(key);
  }
  return result;
}

function dataDescriptor(value: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    reject("HOSTILE_INPUT", path);
  }
  if (descriptor === undefined) reject("MISSING_PROPERTY", path);
  if (!("value" in descriptor)) reject("ACCESSOR_PROPERTY", path);
  return descriptor.value;
}

function plainRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  budget?: Budget,
): SafeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("INVALID_RECORD", path);
  }
  if (isProxy(value)) reject("PROXY_INPUT", path);
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    reject("HOSTILE_INPUT", path);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    reject("INVALID_PROTOTYPE", path);
  }
  const allowed = new Set(allowedKeys);
  const keys = safeOwnKeys(value, path);
  if (budget !== undefined) addProperties(budget, keys.length, path);
  for (const key of keys) {
    if (!allowed.has(key)) reject("UNKNOWN_PROPERTY", path);
    dataDescriptor(value, key, `${path}.${key}`);
    if (budget !== undefined) addBytes(budget, Buffer.byteLength(key), path);
  }
  for (const key of requiredKeys) {
    if (!keys.includes(key)) reject("MISSING_PROPERTY", `${path}.${key}`);
  }
  return value as SafeRecord;
}

function safeArray(value: unknown, path: string, budget: Budget): readonly unknown[] {
  if (!Array.isArray(value)) reject("INVALID_ARRAY", path);
  if (isProxy(value)) reject("PROXY_INPUT", path);
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    reject("HOSTILE_INPUT", path);
  }
  if (prototype !== Array.prototype) reject("INVALID_PROTOTYPE", path);
  const remainingRows = budget.limits.maxRows - budget.rows;
  if (value.length > remainingRows) reject("ROW_LIMIT", path);
  const keys = safeOwnKeys(value, path);
  addProperties(budget, keys.length, path);
  for (const key of keys) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      reject("UNKNOWN_PROPERTY", path);
    }
    dataDescriptor(value, key, `${path}[${key}]`);
  }
  for (let index = 0; index < value.length; index += 1) {
    dataDescriptor(value, String(index), `${path}[${index}]`);
  }
  return value;
}

function addRows(budget: Budget, count: number, path: string): void {
  const next = budget.rows + count;
  if (!Number.isSafeInteger(next) || next > budget.limits.maxRows) {
    reject("ROW_LIMIT", path);
  }
  budget.rows = next;
}

function addProperties(budget: Budget, count: number, path: string): void {
  const next = budget.properties + count;
  if (!Number.isSafeInteger(next) || next > budget.limits.maxProperties) {
    reject("PROPERTY_LIMIT", path);
  }
  budget.properties = next;
}

function addBytes(budget: Budget, count: number, path: string): void {
  const next = budget.bytes + count;
  if (!Number.isSafeInteger(next) || next > budget.limits.maxBytes) {
    reject("BYTE_LIMIT", path);
  }
  budget.bytes = next;
}

function ownValue(record: SafeRecord, key: string, path: string): unknown {
  return dataDescriptor(record, key, `${path}.${key}`);
}

function text(
  record: SafeRecord,
  key: string,
  path: string,
  budget: Budget,
  maximum: number,
  allowEmpty: boolean,
  ascii: boolean,
): string {
  const value = ownValue(record, key, path);
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    (ascii && /[^\x20-\x7e]/u.test(value))
  ) {
    reject("INVALID_TEXT", `${path}.${key}`);
  }
  addBytes(budget, Buffer.byteLength(value), `${path}.${key}`);
  return value;
}

function integer(
  record: SafeRecord,
  key: string,
  path: string,
  budget: Budget,
): number {
  const value = ownValue(record, key, path);
  let result: number;
  if (typeof value === "number") {
    result = value;
    addBytes(budget, 8, `${path}.${key}`);
  } else if (typeof value === "string" && /^\d+$/u.test(value)) {
    addBytes(budget, Buffer.byteLength(value), `${path}.${key}`);
    result = Number(value);
  } else {
    reject("INVALID_INTEGER", `${path}.${key}`);
  }
  if (!Number.isSafeInteger(result) || result < 0) {
    reject("INVALID_INTEGER", `${path}.${key}`);
  }
  return result;
}

function flag(
  record: SafeRecord,
  key: string,
  path: string,
  budget: Budget,
): boolean {
  const value = text(record, key, path, budget, 1, true, true);
  if (value !== "" && value !== "X") reject("INVALID_FLAG", `${path}.${key}`);
  return value === "X";
}

function metadataName(
  record: SafeRecord,
  key: string,
  path: string,
  budget: Budget,
  allowEmpty = false,
): string {
  return text(record, key, path, budget, 30, allowEmpty, true);
}

function safeLimitOptions(value: unknown): RecursiveMetadataLimits {
  if (value === undefined) return DEFAULT_LIMITS;
  const record = plainRecord(value, "options.limits", LIMIT_KEYS, []);
  const result: Record<keyof RecursiveMetadataLimits, number> = {
    ...DEFAULT_LIMITS,
  };
  for (const key of LIMIT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) reject("ACCESSOR_PROPERTY", `options.limits.${key}`);
    const candidate = descriptor.value;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      candidate > ABSOLUTE_LIMITS[key]
    ) {
      reject("INVALID_LIMIT", `options.limits.${key}`);
    }
    result[key] = candidate;
  }
  return Object.freeze(result);
}

function safeOptions(value: unknown): {
  readonly limits: RecursiveMetadataLimits;
  readonly rootTypeNames: readonly string[];
} {
  if (value === undefined) {
    return Object.freeze({ limits: DEFAULT_LIMITS, rootTypeNames: Object.freeze([]) });
  }
  const record = plainRecord(
    value,
    "options",
    ["limits", "rootTypeNames"],
    [],
  );
  const limitDescriptor = Object.getOwnPropertyDescriptor(record, "limits");
  const limits = safeLimitOptions(
    limitDescriptor !== undefined && "value" in limitDescriptor
      ? limitDescriptor.value
      : undefined,
  );
  const rootDescriptor = Object.getOwnPropertyDescriptor(record, "rootTypeNames");
  if (rootDescriptor === undefined) {
    return Object.freeze({ limits, rootTypeNames: Object.freeze([]) });
  }
  if (!("value" in rootDescriptor)) {
    reject("ACCESSOR_PROPERTY", "options.rootTypeNames");
  }
  const roots = rootDescriptor.value;
  if (!Array.isArray(roots) || isProxy(roots)) {
    reject("INVALID_ARRAY", "options.rootTypeNames");
  }
  if (Object.getPrototypeOf(roots) !== Array.prototype) {
    reject("INVALID_PROTOTYPE", "options.rootTypeNames");
  }
  if (roots.length > limits.maxNodes) reject("NODE_LIMIT", "options.rootTypeNames");
  const keys = safeOwnKeys(roots, "options.rootTypeNames");
  for (const key of keys) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= roots.length) {
      reject("UNKNOWN_PROPERTY", "options.rootTypeNames");
    }
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < roots.length; index += 1) {
    const item = dataDescriptor(roots, String(index), `options.rootTypeNames[${index}]`);
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 30 ||
      /[^\x20-\x7e]/u.test(item)
    ) {
      reject("INVALID_TEXT", `options.rootTypeNames[${index}]`);
    }
    if (seen.has(item)) reject("DUPLICATE_ROOT", `options.rootTypeNames[${index}]`);
    seen.add(item);
    result.push(item);
  }
  return Object.freeze({ limits, rootTypeNames: Object.freeze(result) });
}

function snapshotTypeRows(value: unknown, budget: Budget): readonly TypeRow[] {
  const values = safeArray(value, "DATATYPESCONT", budget);
  addRows(budget, values.length, "DATATYPESCONT");
  const result: TypeRow[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const path = `DATATYPESCONT[${index}]`;
    const record = plainRecord(
      dataDescriptor(values, String(index), path),
      path,
      TYPE_ROW_KEYS,
      TYPE_ROW_KEYS,
      budget,
    );
    const timestamp = text(record, "TIMESTAMP", path, budget, 14, false, true);
    if (!/^\d{14}$/u.test(timestamp)) reject("INVALID_TIMESTAMP", `${path}.TIMESTAMP`);
    result.push(Object.freeze({
      typeName: metadataName(record, "TYPENAME", path, budget),
      fieldName: metadataName(record, "FIELDNAME", path, budget, true),
      componentType: text(record, "COMPTYPE", path, budget, 1, true, true),
      associatedType: metadataName(record, "FIELDTYPE", path, budget, true),
      dataType: text(record, "DATATYPE", path, budget, 8, false, true),
      nucTotalLength: integer(record, "TABLENGTH", path, budget),
      ucTotalLength: integer(record, "TABLENGTH_UC", path, budget),
      description: text(record, "DESCRIPTION", path, budget, 60, true, false),
      decimals: integer(record, "DECIMALS", path, budget),
      internalType: text(record, "INTTYPE", path, budget, 1, false, true),
      nucOffset: integer(record, "OFFSET", path, budget),
      ucOffset: integer(record, "OFFSET_UC", path, budget),
      nucLength: integer(record, "INTLEN", path, budget),
      ucLength: integer(record, "INTLEN_UC", path, budget),
      timestamp,
    }));
  }
  return Object.freeze(result);
}

function snapshotFunctionIdentity(
  value: unknown,
  budget: Budget,
): RecursiveMetadataFunctionIdentity | undefined {
  if (value === undefined) return undefined;
  const values = safeArray(value, "FUNCTIONNAMES", budget);
  addRows(budget, values.length, "FUNCTIONNAMES");
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    reject("MULTIPLE_FUNCTION_IDENTITIES", "FUNCTIONNAMES");
  }
  const path = "FUNCTIONNAMES[0]";
  const record = plainRecord(
    dataDescriptor(values, "0", path),
    path,
    FUNCTION_ROW_KEYS,
    FUNCTION_ROW_KEYS,
    budget,
  );
  const date = text(record, "UDAT", path, budget, 8, false, true);
  const time = text(record, "UTIME", path, budget, 6, false, true);
  if (!/^\d{8}$/u.test(date)) reject("INVALID_DATE", `${path}.UDAT`);
  if (!/^\d{6}$/u.test(time)) reject("INVALID_TIME", `${path}.UTIME`);
  return Object.freeze({
    name: metadataName(record, "FUNCTIONNAME", path, budget),
    remoteBasxmlSupported: flag(
      record,
      "BASXML_SUPPORTED",
      path,
      budget,
    ),
    generationToken: `function:${date}:${time}`,
  });
}

function validateFunctionIdentity(
  identity: RecursiveMetadataFunctionIdentity | undefined,
  identityWasProvided: boolean,
  parameters: readonly ParameterRow[],
): void {
  const names = new Set(parameters.map((parameter) => parameter.functionName));
  if (names.size > 1) reject("MULTIPLE_FUNCTIONS", "PARAMETERS");
  if (identityWasProvided && identity === undefined && names.size > 0) {
    reject("MISSING_FUNCTION_IDENTITY", "FUNCTIONNAMES");
  }
  if (identity !== undefined && names.size === 1 && !names.has(identity.name)) {
    reject("FOREIGN_FUNCTION_REFERENCE", "PARAMETERS");
  }
}

function snapshotIndirectRows(value: unknown, budget: Budget): readonly IndirectRow[] {
  const values = safeArray(value, "INDIRECTTYPES", budget);
  addRows(budget, values.length, "INDIRECTTYPES");
  const result: IndirectRow[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const path = `INDIRECTTYPES[${index}]`;
    const record = plainRecord(
      dataDescriptor(values, String(index), path),
      path,
      INDIRECT_ROW_KEYS,
      INDIRECT_ROW_KEYS,
      budget,
    );
    result.push(Object.freeze({
      tableName: metadataName(record, "TABNAME", path, budget),
      fieldPath: metadataName(record, "FIELDNAME", path, budget),
      targetType: metadataName(record, "FIELDTYPE", path, budget),
    }));
  }
  return Object.freeze(result);
}

function snapshotParameterRows(value: unknown, budget: Budget): readonly ParameterRow[] {
  if (value === undefined) return Object.freeze([]);
  const values = safeArray(value, "PARAMETERS", budget);
  addRows(budget, values.length, "PARAMETERS");
  const result: ParameterRow[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const path = `PARAMETERS[${index}]`;
    const record = plainRecord(
      dataDescriptor(values, String(index), path),
      path,
      PARAMETER_ROW_KEYS,
      PARAMETER_ROW_KEYS,
      budget,
    );
    const parameterClass = text(
      record,
      "PARAMCLASS",
      path,
      budget,
      1,
      false,
      true,
    );
    if (!/^[IECXT]$/u.test(parameterClass)) {
      reject("INVALID_PARAMETER_CLASS", `${path}.PARAMCLASS`);
    }
    const internalType = text(record, "EXID", path, budget, 1, true, true);
    if (parameterClass !== "X" && internalType.length === 0) {
      reject("INVALID_TEXT", `${path}.EXID`);
    }
    integer(record, "OFFSET", path, budget);
    const defaultValue = text(
      record,
      "DEFAULT",
      path,
      budget,
      21,
      true,
      false,
    );
    const parameterText = text(
      record,
      "PARAMTEXT",
      path,
      budget,
      79,
      true,
      false,
    );
    const position = integer(record, "POSITION", path, budget);
    // RFC_METADATA_GET legitimately emits zero and duplicate positions. Keep
    // the captured row order as the stable tie-break rather than renumbering.
    result.push(Object.freeze({
      functionName: metadataName(record, "FUNCNAME", path, budget),
      parameterClass: parameterClass as ParameterRow["parameterClass"],
      parameterName: metadataName(record, "PARAMETER", path, budget),
      tableName: metadataName(record, "TABNAME", path, budget, true),
      fieldPath: metadataName(record, "FIELDNAME", path, budget, true),
      internalType,
      position,
      internalLength: integer(record, "INTLENGTH", path, budget),
      decimals: integer(record, "DECIMALS", path, budget),
      defaultValue,
      parameterText,
      optional: flag(record, "OPTIONAL", path, budget),
    }));
  }
  return Object.freeze(result);
}

function classifyReference(
  internalType: string,
  associatedType: string,
  path: string,
): ProvisionalReference {
  // RFC_METADATA_GET uses `u` for flat structures and `v` for deep
  // structures. In particular, a structured table type is represented as one
  // anonymous `v` row pointing at its line structure. Both are descriptor
  // edges; whether the enclosing anonymous node is a table is decided below.
  if (internalType === "u" || internalType === "v" || internalType === "h") {
    if (associatedType.length === 0) reject("MISSING_ASSOCIATED_TYPE", path);
    return Object.freeze({
      kind: internalType === "h" ? "table" : "structure",
      internalType,
      targetType: associatedType,
    });
  }
  return Object.freeze({ kind: "scalar", internalType });
}

function safeEnd(offset: number, length: number, path: string): number {
  const end = offset + length;
  if (!Number.isSafeInteger(end)) reject("INVALID_GEOMETRY", path);
  return end;
}

function buildNodes(
  rows: readonly TypeRow[],
  limits: RecursiveMetadataLimits,
): readonly ProvisionalNode[] {
  const grouped: { name: string; rows: TypeRow[] }[] = [];
  const closed = new Set<string>();
  let current: { name: string; rows: TypeRow[] } | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (current === undefined || current.name !== row.typeName) {
      if (current !== undefined) closed.add(current.name);
      if (closed.has(row.typeName)) {
        reject("NONCONTIGUOUS_TYPE", `DATATYPESCONT[${index}].TYPENAME`);
      }
      current = { name: row.typeName, rows: [] };
      grouped.push(current);
    }
    current.rows.push(row);
  }
  if (grouped.length > limits.maxNodes) reject("NODE_LIMIT", "DATATYPESCONT");

  const nodes: ProvisionalNode[] = [];
  let fieldEdges = 0;
  for (let groupIndex = 0; groupIndex < grouped.length; groupIndex += 1) {
    const group = grouped[groupIndex]!;
    const first = group.rows[0]!;
    const blankFields = group.rows.filter((row) => row.fieldName.length === 0);
    const anonymous = blankFields.length > 0;
    if (anonymous && (group.rows.length !== 1 || blankFields.length !== 1)) {
      reject("INVALID_TABLE_SHAPE", `DATATYPESCONT:${groupIndex}`);
    }
    const names = new Set<string>();
    const fields: ProvisionalField[] = [];
    const anonymousReference = anonymous
      ? classifyReference(
          first.internalType,
          first.associatedType,
          `DATATYPESCONT:${groupIndex}:0.INTTYPE`,
        )
      : undefined;
    // RFC_METADATA_GET describes a top-level scalar type with a single
    // anonymous row whose TABLENGTH values are zero while INTLEN carries its
    // real wire width. Structured-table wrapper rows instead carry their
    // aggregate TABLENGTH and a zero INTLEN. Normalize only the former shape;
    // named structure fields remain subject to the strict aggregate bounds.
    const anonymousScalar = anonymousReference?.kind === "scalar";
    const effectiveNucTotal = anonymousScalar && first.nucTotalLength === 0
      ? safeEnd(first.nucOffset, first.nucLength, `DATATYPESCONT:${groupIndex}:0`)
      : first.nucTotalLength;
    const effectiveUcTotal = anonymousScalar && first.ucTotalLength === 0
      ? safeEnd(first.ucOffset, first.ucLength, `DATATYPESCONT:${groupIndex}:0`)
      : first.ucTotalLength;
    let previousNucEnd = 0;
    let previousUcEnd = 0;
    for (let fieldIndex = 0; fieldIndex < group.rows.length; fieldIndex += 1) {
      const row = group.rows[fieldIndex]!;
      const path = `DATATYPESCONT:${groupIndex}:${fieldIndex}`;
      if (
        row.nucTotalLength !== first.nucTotalLength ||
        row.ucTotalLength !== first.ucTotalLength
      ) {
        reject("INCONSISTENT_TOTAL_LENGTH", path);
      }
      if (row.timestamp !== first.timestamp) reject("INCONSISTENT_TIMESTAMP", path);
      if (names.has(row.fieldName)) reject("DUPLICATE_FIELD", path);
      const nucEnd = safeEnd(row.nucOffset, row.nucLength, path);
      const ucEnd = safeEnd(row.ucOffset, row.ucLength, path);
      if (
        row.nucOffset < previousNucEnd ||
        row.ucOffset < previousUcEnd ||
        nucEnd > effectiveNucTotal ||
        ucEnd > effectiveUcTotal
      ) {
        reject("INVALID_GEOMETRY", path);
      }
      names.add(row.fieldName);
      previousNucEnd = nucEnd;
      previousUcEnd = ucEnd;
      const reference = classifyReference(
        row.internalType,
        row.associatedType,
        `${path}.INTTYPE`,
      );
      if (reference.kind !== "scalar") fieldEdges += 1;
      fields.push({
        name: row.fieldName,
        position: fieldIndex + 1,
        componentType: row.componentType,
        associatedType: row.associatedType,
        dataType: row.dataType,
        internalType: row.internalType,
        description: row.description,
        decimals: row.decimals,
        nucOffset: row.nucOffset,
        ucOffset: row.ucOffset,
        nucLength: row.nucLength,
        ucLength: row.ucLength,
        reference,
      });
    }
    if (fieldEdges > limits.maxEdges) reject("EDGE_LIMIT", "DATATYPESCONT");
    const kind = !anonymous
      ? "structure" as const
      : fields[0]!.reference.kind === "scalar"
        ? "scalar" as const
        : "table" as const;
    nodes.push({
      name: group.name,
      kind,
      nucLength: effectiveNucTotal,
      ucLength: effectiveUcTotal,
      timestamp: first.timestamp,
      fields: Object.freeze(fields),
    });
  }
  return Object.freeze(nodes);
}

function refineTableNodeKinds(
  nodes: readonly ProvisionalNode[],
  parameters: readonly ParameterRow[],
  indirectRows: readonly IndirectRow[],
): readonly ProvisionalNode[] {
  const requiredTables = new Set<string>();
  const indirectTargets = new Map<string, string>();
  const ambiguousIndirectTargets = new Set<string>();
  for (const row of indirectRows) {
    const key = `${row.tableName}\u0000${row.fieldPath}`;
    if (indirectTargets.has(key)) {
      ambiguousIndirectTargets.add(key);
    } else {
      indirectTargets.set(key, row.targetType);
    }
  }
  for (const node of nodes) {
    for (const field of node.fields) {
      if (field.reference.kind === "table") {
        requiredTables.add(field.reference.targetType!);
      }
    }
  }
  for (const parameter of parameters) {
    if (parameter.internalType !== "h") continue;
    if (parameter.fieldPath.includes("-")) {
      const key = `${parameter.tableName}\u0000${parameter.fieldPath}`;
      const target = indirectTargets.get(key);
      if (target !== undefined && !ambiguousIndirectTargets.has(key)) {
        requiredTables.add(target);
      }
    } else if (parameter.fieldPath.length === 0 && parameter.tableName.length > 0) {
      requiredTables.add(parameter.tableName);
    }
  }
  return Object.freeze(nodes.map((node) =>
    node.kind === "scalar" && requiredTables.has(node.name)
      ? {
          name: node.name,
          kind: "table" as const,
          nucLength: node.nucLength,
          ucLength: node.ucLength,
          timestamp: node.timestamp,
          fields: node.fields,
        }
      : node));
}

function validateNodeTargets(nodes: readonly ProvisionalNode[]): void {
  const byName = new Map(nodes.map((node) => [node.name, node] as const));
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!;
    for (let fieldIndex = 0; fieldIndex < node.fields.length; fieldIndex += 1) {
      const reference = node.fields[fieldIndex]!.reference;
      if (reference.kind === "scalar") continue;
      const target = byName.get(reference.targetType!);
      if (target === undefined) reject("FOREIGN_TYPE_REFERENCE", `node:${nodeIndex}:${fieldIndex}`);
      if (target.kind !== reference.kind) {
        reject("REFERENCE_KIND_MISMATCH", `node:${nodeIndex}:${fieldIndex}`);
      }
    }
  }
}

function indirectMap(rows: readonly IndirectRow[]): ReadonlyMap<string, IndirectRow> {
  const entries: (readonly [string, IndirectRow])[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!row.fieldPath.includes("-")) {
      reject("INVALID_INDIRECT_PATH", `INDIRECTTYPES[${index}].FIELDNAME`);
    }
    const key = `${row.tableName}\u0000${row.fieldPath}`;
    if (seen.has(key)) reject("DUPLICATE_INDIRECT_TYPE", `INDIRECTTYPES[${index}]`);
    seen.add(key);
    entries.push(Object.freeze([key, row] as const));
  }
  return new ImmutableMetadataMap(entries);
}

function resolveFieldPath(
  node: ProvisionalNode,
  fieldPath: string,
  byName: ReadonlyMap<string, ProvisionalNode>,
  fieldsByNode: ReadonlyMap<ProvisionalNode, ReadonlyMap<string, ProvisionalField>>,
  path: string,
): ProvisionalReference {
  const segments = fieldPath.split("-");
  let current = node;
  let reference: ProvisionalReference | undefined;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.length === 0) reject("INVALID_FIELD_PATH", path);
    const field = fieldsByNode.get(current)?.get(segment);
    if (field === undefined) reject("FOREIGN_FIELD_REFERENCE", path);
    reference = field.reference;
    if (index === segments.length - 1) return reference;
    if (reference.kind !== "structure") reject("INVALID_FIELD_PATH", path);
    const target = byName.get(reference.targetType!);
    if (target === undefined || target.kind !== "structure") {
      reject("FOREIGN_TYPE_REFERENCE", path);
    }
    current = target;
  }
  return reference!;
}

function provisionalParameters(
  rows: readonly ParameterRow[],
  indirectRows: readonly IndirectRow[],
  nodes: readonly ProvisionalNode[],
  limits: RecursiveMetadataLimits,
): {
  readonly values: readonly (Omit<RecursiveMetadataParameter, "reference"> & {
    readonly reference: ProvisionalParameterReference;
  })[];
  readonly rootTypes: readonly string[];
  readonly totalEdges: number;
} {
  const byName = new Map(nodes.map((node) => [node.name, node] as const));
  const fieldsByNode = new Map(
    nodes.map((node) => [
      node,
      new Map(node.fields.map((field) => [field.name, field] as const)),
    ] as const),
  );
  const indirect = indirectMap(indirectRows);
  const consumedIndirect = new Set<string>();
  const result: (Omit<RecursiveMetadataParameter, "reference"> & {
    readonly reference: ProvisionalParameterReference;
  })[] = [];
  const roots: string[] = [];
  const rootSet = new Set<string>();
  const parameters = new Set<string>();
  let edgeCount = nodes.reduce(
    (count, node) => count + node.fields.filter((field) => field.reference.kind !== "scalar").length,
    0,
  );

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const path = `PARAMETERS[${index}]`;
    const parameterKey = `${row.functionName}\u0000${row.parameterName}`;
    if (parameters.has(parameterKey)) reject("DUPLICATE_PARAMETER", path);
    parameters.add(parameterKey);

    let reference: ProvisionalParameterReference;
    if (row.parameterClass === "X") {
      reference = Object.freeze({ kind: "exception" as const });
    } else {
      const addRoot = (name: string): void => {
        if (!rootSet.has(name)) {
          rootSet.add(name);
          roots.push(name);
        }
      };
      const mappedTarget = (): ProvisionalNode | undefined => {
        if (!row.fieldPath.includes("-")) return undefined;
        if (row.tableName.length === 0) {
          reject("MISSING_ASSOCIATED_TYPE", `${path}.TABNAME`);
        }
        const key = `${row.tableName}\u0000${row.fieldPath}`;
        const mapping = indirect.get(key);
        if (mapping === undefined) reject("MISSING_INDIRECT_TYPE", path);
        consumedIndirect.add(key);
        const target = byName.get(mapping.targetType);
        if (target === undefined) reject("FOREIGN_TYPE_REFERENCE", path);
        addRoot(mapping.targetType);
        return target;
      };
      const directFieldReference = (): ProvisionalReference | undefined => {
        if (row.fieldPath.length === 0 || row.fieldPath.includes("-")) return undefined;
        if (row.tableName.length === 0) {
          reject("MISSING_ASSOCIATED_TYPE", `${path}.TABNAME`);
        }
        const owner = byName.get(row.tableName);
        if (owner === undefined) reject("FOREIGN_TYPE_REFERENCE", path);
        addRoot(row.tableName);
        return resolveFieldPath(owner, row.fieldPath, byName, fieldsByNode, path);
      };

      const scalarTable =
        row.parameterClass === "T" &&
        row.internalType !== "u" &&
        row.internalType !== "v" &&
        row.internalType !== "h";
      const isTable = !scalarTable &&
        (row.parameterClass === "T" || row.internalType === "h");
      const isStructure = !isTable && !scalarTable &&
        (row.internalType === "u" || row.internalType === "v");

      if (scalarTable) {
        const mapped = mappedTarget();
        const direct = directFieldReference();
        if (mapped !== undefined) {
          if (
            mapped.fields.length !== 1 ||
            mapped.fields[0]!.name !== "" ||
            mapped.fields[0]!.reference.kind !== "scalar"
          ) {
            reject("REFERENCE_KIND_MISMATCH", path);
          }
        }
        if (direct !== undefined && direct.kind !== "scalar") {
          reject("REFERENCE_KIND_MISMATCH", path);
        }
        if (
          mapped === undefined &&
          direct === undefined &&
          row.fieldPath.length === 0 &&
          row.tableName.length > 0
        ) {
          const named = byName.get(row.tableName);
          if (named !== undefined) {
          if (
            named.fields.length !== 1 ||
            named.fields[0]!.name !== "" ||
            named.fields[0]!.reference.kind !== "scalar"
          ) {
              reject("REFERENCE_KIND_MISMATCH", path);
            }
            addRoot(row.tableName);
          }
        }
        reference = Object.freeze({
          kind: "scalar-table" as const,
          internalType: row.internalType,
        });
        edgeCount += 1;
        if (edgeCount > limits.maxEdges) reject("EDGE_LIMIT", path);
      } else if (!isTable && !isStructure) {
        const mapped = mappedTarget();
        const direct = directFieldReference();
        if (mapped !== undefined) {
          if (
            mapped.fields.length !== 1 ||
            mapped.fields[0]!.name !== "" ||
            mapped.fields[0]!.reference.kind !== "scalar"
          ) {
            reject("REFERENCE_KIND_MISMATCH", path);
          }
          edgeCount += 1;
        }
        if (direct !== undefined) {
          if (direct.kind !== "scalar") reject("REFERENCE_KIND_MISMATCH", path);
          edgeCount += 1;
        }
        if (
          mapped === undefined &&
          direct === undefined &&
          row.fieldPath.length === 0 &&
          row.tableName.length > 0
        ) {
          const named = byName.get(row.tableName);
          if (named !== undefined) {
            if (
              named.fields.length !== 1 ||
              named.fields[0]!.name !== "" ||
              named.fields[0]!.reference.kind !== "scalar"
            ) {
              reject("REFERENCE_KIND_MISMATCH", path);
            }
            addRoot(row.tableName);
            edgeCount += 1;
          }
        }
        if (edgeCount > limits.maxEdges) reject("EDGE_LIMIT", path);
        reference = Object.freeze({ kind: "scalar" as const, internalType: row.internalType });
      } else {
        if (row.tableName.length === 0) reject("MISSING_ASSOCIATED_TYPE", `${path}.TABNAME`);
        let targetType: string | undefined;
        if (row.fieldPath.includes("-")) {
          const key = `${row.tableName}\u0000${row.fieldPath}`;
          const mapping = indirect.get(key);
          if (mapping === undefined) reject("MISSING_INDIRECT_TYPE", path);
          consumedIndirect.add(key);
          targetType = mapping.targetType;
        } else if (row.fieldPath.length > 0) {
          const owner = byName.get(row.tableName);
          if (owner === undefined) reject("FOREIGN_TYPE_REFERENCE", path);
          const resolved = resolveFieldPath(
            owner,
            row.fieldPath,
            byName,
            fieldsByNode,
            path,
          );
          if (resolved.kind === "scalar") reject("REFERENCE_KIND_MISMATCH", path);
          targetType = resolved.targetType;
        } else {
          targetType = row.tableName;
        }
        const resolvedTargetType = targetType!;
        const target = byName.get(resolvedTargetType);
        if (target === undefined) reject("FOREIGN_TYPE_REFERENCE", path);
        if (isStructure && target.kind !== "structure") {
          reject("REFERENCE_KIND_MISMATCH", path);
        }
        if (row.internalType === "h" && target.kind !== "table") {
          reject("REFERENCE_KIND_MISMATCH", path);
        }
        reference = Object.freeze({
          kind: isTable ? "table" as const : "structure" as const,
          internalType: row.internalType,
          targetType: resolvedTargetType,
        });
        edgeCount += 1;
        if (edgeCount > limits.maxEdges) reject("EDGE_LIMIT", path);
        addRoot(resolvedTargetType);
      }
    }
    result.push({
      functionName: row.functionName,
      name: row.parameterName,
      parameterClass: row.parameterClass,
      position: row.position,
      associatedType: row.tableName,
      fieldPath: row.fieldPath,
      internalType: row.internalType,
      internalLength: row.internalLength,
      decimals: row.decimals,
      defaultValue: row.defaultValue,
      parameterText: row.parameterText,
      optional: row.optional,
      reference,
    });
  }

  for (let index = 0; index < indirectRows.length; index += 1) {
    const row = indirectRows[index]!;
    const key = `${row.tableName}\u0000${row.fieldPath}`;
    if (!consumedIndirect.has(key)) reject("FOREIGN_INDIRECT_TYPE", `INDIRECTTYPES[${index}]`);
  }
  return Object.freeze({
    values: Object.freeze(result),
    rootTypes: Object.freeze(roots),
    totalEdges: edgeCount,
  });
}

interface Components {
  readonly componentByNode: readonly number[];
  readonly nodesByComponent: readonly (readonly number[])[];
  readonly cyclicComponents: ReadonlySet<number>;
  readonly maximumDepth: number;
}

function graphComponents(
  nodes: readonly ProvisionalNode[],
  roots: readonly string[],
  maxDepth: number,
): Components {
  const indexByName = new Map(nodes.map((node, index) => [node.name, index] as const));
  const adjacency = nodes.map((node) => Object.freeze(node.fields.flatMap((field) =>
    field.reference.kind === "scalar"
      ? []
      : [indexByName.get(field.reference.targetType!)!])));
  const reverse = nodes.map(() => [] as number[]);
  for (let from = 0; from < adjacency.length; from += 1) {
    for (const to of adjacency[from]!) reverse[to]!.push(from);
  }

  const visited = new Uint8Array(nodes.length);
  const finish: number[] = [];
  for (let start = 0; start < nodes.length; start += 1) {
    if (visited[start]) continue;
    visited[start] = 1;
    const stack: { node: number; next: number }[] = [{ node: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = adjacency[frame.node]!;
      if (frame.next < neighbors.length) {
        const target = neighbors[frame.next++]!;
        if (!visited[target]) {
          visited[target] = 1;
          stack.push({ node: target, next: 0 });
        }
      } else {
        finish.push(frame.node);
        stack.pop();
      }
    }
  }

  const componentByNode = new Array<number>(nodes.length).fill(-1);
  const nodesByComponent: number[][] = [];
  for (let order = finish.length - 1; order >= 0; order -= 1) {
    const start = finish[order]!;
    if (componentByNode[start] !== -1) continue;
    const component = nodesByComponent.length;
    const members: number[] = [];
    const stack = [start];
    componentByNode[start] = component;
    while (stack.length > 0) {
      const node = stack.pop()!;
      members.push(node);
      for (const source of reverse[node]!) {
        if (componentByNode[source] === -1) {
          componentByNode[source] = component;
          stack.push(source);
        }
      }
    }
    members.sort((left, right) => left - right);
    nodesByComponent.push(members);
  }

  const cyclicComponents = new Set<number>();
  for (let component = 0; component < nodesByComponent.length; component += 1) {
    const members = nodesByComponent[component]!;
    if (members.length > 1) cyclicComponents.add(component);
    else if (adjacency[members[0]!]!.includes(members[0]!)) cyclicComponents.add(component);
  }

  const componentAdjacency = nodesByComponent.map(() => new Set<number>());
  for (let from = 0; from < adjacency.length; from += 1) {
    const fromComponent = componentByNode[from]!;
    for (const to of adjacency[from]!) {
      const toComponent = componentByNode[to]!;
      if (fromComponent !== toComponent) {
        componentAdjacency[fromComponent]!.add(toComponent);
      }
    }
  }

  const rootComponents = roots.length === 0
    ? nodesByComponent.map((_, index) => index)
    : roots.map((name) => componentByNode[indexByName.get(name)!]!);
  const reachable = new Set<number>();
  const reachStack = [...rootComponents];
  while (reachStack.length > 0) {
    const component = reachStack.pop()!;
    if (reachable.has(component)) continue;
    reachable.add(component);
    for (const target of componentAdjacency[component]!) reachStack.push(target);
  }

  const indegree = new Array<number>(nodesByComponent.length).fill(0);
  for (const source of reachable) {
    for (const target of componentAdjacency[source]!) {
      if (reachable.has(target)) indegree[target] = indegree[target]! + 1;
    }
  }
  const queue = [...reachable].filter((component) => indegree[component] === 0);
  const depth = new Array<number>(nodesByComponent.length).fill(0);
  for (const root of rootComponents) depth[root] = Math.max(depth[root]!, 1);
  let maximumDepth = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    if (depth[source] === 0) depth[source] = 1;
    maximumDepth = Math.max(maximumDepth, depth[source]!);
    for (const target of componentAdjacency[source]!) {
      if (!reachable.has(target)) continue;
      depth[target] = Math.max(depth[target]!, depth[source]! + 1);
      indegree[target] = indegree[target]! - 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  if (maximumDepth > maxDepth) reject("DEPTH_LIMIT", "metadata-graph");

  return Object.freeze({
    componentByNode: Object.freeze(componentByNode),
    nodesByComponent: Object.freeze(nodesByComponent.map((members) => Object.freeze(members))),
    cyclicComponents,
    maximumDepth,
  });
}

function finalNodes(
  nodes: readonly ProvisionalNode[],
  components: Components,
): ReadonlyMap<string, RecursiveMetadataTypeNode> {
  const indexByName = new Map(nodes.map((node, index) => [node.name, index] as const));
  const entries: (readonly [string, RecursiveMetadataTypeNode])[] = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!;
    const fields = node.fields.map((field) => {
      let reference: RecursiveMetadataReference;
      if (field.reference.kind === "scalar") {
        reference = Object.freeze({
          kind: "scalar",
          internalType: field.reference.internalType,
        });
      } else {
        const targetIndex = indexByName.get(field.reference.targetType!)!;
        const component = components.componentByNode[nodeIndex]!;
        reference = Object.freeze({
          kind: field.reference.kind,
          targetType: field.reference.targetType!,
          cyclic:
            component === components.componentByNode[targetIndex] &&
            components.cyclicComponents.has(component),
        });
      }
      return Object.freeze({
        name: field.name,
        position: field.position,
        componentType: field.componentType,
        associatedType: field.associatedType,
        dataType: field.dataType,
        internalType: field.internalType,
        description: field.description,
        decimals: field.decimals,
        nucOffset: field.nucOffset,
        ucOffset: field.ucOffset,
        nucLength: field.nucLength,
        ucLength: field.ucLength,
        reference,
      });
    });
    const value = Object.freeze({
      name: node.name,
      kind: node.kind,
      nucLength: node.nucLength,
      ucLength: node.ucLength,
      timestamp: node.timestamp,
      fields: Object.freeze(fields),
    });
    entries.push(Object.freeze([node.name, value] as const));
  }
  return new ImmutableMetadataMap(entries);
}

function finalParameters(
  values: readonly (Omit<RecursiveMetadataParameter, "reference"> & {
    readonly reference: ProvisionalParameterReference;
  })[],
  nodes: readonly ProvisionalNode[],
  components: Components,
): readonly RecursiveMetadataParameter[] {
  const indexByName = new Map(nodes.map((node, index) => [node.name, index] as const));
  return Object.freeze(values.map((parameter) => {
    let reference: RecursiveMetadataParameter["reference"];
    if (parameter.reference.kind === "exception") {
      reference = Object.freeze({ kind: "exception" });
    } else if (parameter.reference.kind === "scalar-table") {
      reference = Object.freeze({
        kind: "table",
        scalarLine: Object.freeze({
          internalType: parameter.reference.internalType,
        }),
        cyclic: false,
      });
    } else if (parameter.reference.kind === "scalar") {
      reference = Object.freeze({
        kind: "scalar",
        internalType: parameter.reference.internalType,
      });
    } else {
      const targetIndex = indexByName.get(parameter.reference.targetType!)!;
      const component = components.componentByNode[targetIndex]!;
      reference = Object.freeze({
        kind: parameter.reference.kind,
        targetType: parameter.reference.targetType!,
        cyclic: components.cyclicComponents.has(component),
      });
    }
    return Object.freeze({
      functionName: parameter.functionName,
      name: parameter.name,
      parameterClass: parameter.parameterClass,
      position: parameter.position,
      associatedType: parameter.associatedType,
      fieldPath: parameter.fieldPath,
      internalType: parameter.internalType,
      internalLength: parameter.internalLength,
      decimals: parameter.decimals,
      defaultValue: parameter.defaultValue,
      parameterText: parameter.parameterText,
      optional: parameter.optional,
      reference,
    });
  }));
}

function finalCycles(
  nodes: readonly ProvisionalNode[],
  components: Components,
): readonly RecursiveMetadataCycle[] {
  const result: RecursiveMetadataCycle[] = [];
  for (let component = 0; component < components.nodesByComponent.length; component += 1) {
    if (!components.cyclicComponents.has(component)) continue;
    result.push(Object.freeze({
      id: `cycle:${result.length}`,
      typeNames: Object.freeze(
        components.nodesByComponent[component]!.map((index) => nodes[index]!.name),
      ),
    }));
  }
  return Object.freeze(result);
}

/**
 * Normalize the optimized RFC_METADATA_GET type closure into a bounded,
 * immutable identity graph. The graph deliberately stores references by type
 * name: cycles stay explicit and no recursive object-freezing walk is needed.
 */
export function normalizeRecursiveMetadataGraph(
  value: unknown,
  optionsValue?: RecursiveMetadataOptions,
): RecursiveMetadataGraph {
  const options = safeOptions(optionsValue);
  const budget: Budget = {
    limits: options.limits,
    rows: 0,
    properties: 0,
    bytes: 0,
  };
  const input = plainRecord(
    value,
    "metadata",
    INPUT_KEYS,
    ["DATATYPESCONT", "INDIRECTTYPES"],
    budget,
  );
  const functionDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "FUNCTIONNAMES",
  );
  const functionIdentity = snapshotFunctionIdentity(
    functionDescriptor !== undefined && "value" in functionDescriptor
      ? functionDescriptor.value
      : undefined,
    budget,
  );
  const typeRows = snapshotTypeRows(
    ownValue(input, "DATATYPESCONT", "metadata"),
    budget,
  );
  const indirectRows = snapshotIndirectRows(
    ownValue(input, "INDIRECTTYPES", "metadata"),
    budget,
  );
  const parameterDescriptor = Object.getOwnPropertyDescriptor(input, "PARAMETERS");
  const parameterRows = snapshotParameterRows(
    parameterDescriptor !== undefined && "value" in parameterDescriptor
      ? parameterDescriptor.value
      : undefined,
    budget,
  );
  validateFunctionIdentity(
    functionIdentity,
    functionDescriptor !== undefined,
    parameterRows,
  );
  const provisionalNodes = refineTableNodeKinds(
    buildNodes(typeRows, options.limits),
    parameterRows,
    indirectRows,
  );
  validateNodeTargets(provisionalNodes);
  const parameters = provisionalParameters(
    parameterRows,
    indirectRows,
    provisionalNodes,
    options.limits,
  );
  const nodeNames = new Set(provisionalNodes.map((node) => node.name));
  const roots: string[] = [];
  const rootSet = new Set<string>();
  for (let index = 0; index < options.rootTypeNames.length; index += 1) {
    const name = options.rootTypeNames[index]!;
    if (!nodeNames.has(name)) reject("FOREIGN_ROOT", `options.rootTypeNames[${index}]`);
    rootSet.add(name);
    roots.push(name);
  }
  for (const name of parameters.rootTypes) {
    if (!rootSet.has(name)) {
      rootSet.add(name);
      roots.push(name);
    }
  }
  if (roots.length === 0) {
    for (const node of provisionalNodes) roots.push(node.name);
  }
  const components = graphComponents(provisionalNodes, roots, options.limits.maxDepth);

  const reachable = new Set<string>();
  const provisionalByName = new Map(
    provisionalNodes.map((node) => [node.name, node] as const),
  );
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const field of provisionalByName.get(name)!.fields) {
      if (field.reference.kind !== "scalar") stack.push(field.reference.targetType!);
    }
  }
  if (reachable.size !== provisionalNodes.length) reject("FOREIGN_TYPE_NODE", "DATATYPESCONT");

  const nodes = finalNodes(provisionalNodes, components);
  const finalParameterValues = finalParameters(
    parameters.values,
    provisionalNodes,
    components,
  );
  const cycles = finalCycles(provisionalNodes, components);
  const graph = Object.freeze({
    version: 1 as const,
    functionIdentity,
    nodes,
    parameters: finalParameterValues,
    rootTypeNames: Object.freeze(roots),
    cycles,
    limits: options.limits,
    statistics: Object.freeze({
      rowCount: budget.rows,
      nodeCount: nodes.size,
      edgeCount: parameters.totalEdges,
      propertyCount: budget.properties,
      byteCount: budget.bytes,
      maximumDepth: components.maximumDepth,
    }),
  });
  normalizedRecursiveMetadataGraphs.add(graph);
  return graph;
}
