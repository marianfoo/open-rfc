import { types as nodeUtilTypes } from "node:util";

import { isImmutableMetadataMap } from "../metadata/immutable-map.js";
import {
  recordRecursiveMetadataParameterIndexWork,
  recursiveMetadataParameterIndexCacheGet,
  recursiveMetadataParameterIndexCacheSet,
  recursiveMetadataParameterFromIndex,
  type RecursiveMetadataParameterIndex,
} from "../metadata/recursive-parameter-index.js";
import type {
  RecursiveMetadataField,
  RecursiveMetadataParameter,
  RecursiveMetadataTypeNode,
} from "../metadata/recursive-metadata.js";
import {
  isNormalizedRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../metadata/recursive-metadata.js";
import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";
import {
  assertClassicXrfcXmlName,
  checkedClassicXrfcLength,
  classicXrfcCloseTagByteLength,
  classicXrfcOpenTagByteLength,
  decodeClassicXrfcBase64,
  escapedClassicXrfcXmlByteLength,
  ExactClassicXrfcParser,
  normalizeClassicXrfcLimits,
  writeClassicXrfcCloseTag,
  writeClassicXrfcOpenTag,
  writeEscapedClassicXrfcText,
  type ClassicXrfcKind,
  type ClassicXrfcLimits,
  type NormalizedClassicXrfcLimits,
} from "./classic-xrfc.js";
import {
  assertNulFreeUnicodeScalarText,
  assertUnicodeScalarText,
} from "./unicode-scalar.js";

export interface RecursiveClassicXrfcLimits extends ClassicXrfcLimits {
  /** Maximum descriptor or runtime value nodes visited for one parameter. */
  readonly maxNodes?: number;
  /** Maximum descriptor or runtime container depth for one parameter. */
  readonly maxDepth?: number;
}

export interface RecursiveClassicXrfcParameterIdentity {
  readonly functionName: string;
  readonly parameterName: string;
  readonly parameterClass: "I" | "E" | "C" | "T";
  readonly associatedType: string;
  readonly internalType: string;
}

export interface RecursiveClassicXrfcScalarDescriptor {
  readonly kind: "scalar";
  readonly name: string;
  readonly internalType: "I" | "C" | "g" | "y";
  readonly internalLength: number;
}

export interface RecursiveClassicXrfcStructureDescriptor {
  readonly kind: "structure";
  readonly name: string;
  readonly typeName: string;
  readonly fields: readonly RecursiveClassicXrfcDescriptor[];
}

export interface RecursiveClassicXrfcTableDescriptor {
  readonly kind: "table";
  readonly name: string;
  readonly typeName: string;
  readonly line: RecursiveClassicXrfcStructureDescriptor;
}

export type RecursiveClassicXrfcDescriptor =
  | RecursiveClassicXrfcScalarDescriptor
  | RecursiveClassicXrfcStructureDescriptor
  | RecursiveClassicXrfcTableDescriptor;

export interface ResolvedRecursiveClassicXrfcParameter {
  readonly serializer: "classic-xrfc";
  readonly functionName: string;
  readonly parameterName: string;
  readonly parameterClass: "I" | "E" | "C" | "T";
  readonly kind: ClassicXrfcKind;
  readonly root: RecursiveClassicXrfcStructureDescriptor |
    RecursiveClassicXrfcTableDescriptor;
  readonly descriptorNodeCount: number;
  readonly descriptorMaximumDepth: number;
}

interface NormalizedRecursiveClassicXrfcLimits
  extends NormalizedClassicXrfcLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
}

interface DescriptorBudget {
  readonly limits: NormalizedRecursiveClassicXrfcLimits;
  readonly graph: RecursiveMetadataGraph;
  readonly index?: RecursiveMetadataParameterIndex;
  nodes: number;
  maximumDepth: number;
}

interface CachedDescriptorTemplateSuccess {
  readonly ok: true;
  readonly root: RecursiveClassicXrfcStructureDescriptor |
    RecursiveClassicXrfcTableDescriptor;
  readonly descriptorNodeCount: number;
  readonly descriptorMaximumDepth: number;
}

interface CachedDescriptorTemplateFailure {
  readonly ok: false;
  readonly errorName: string;
  readonly message: string;
}

type CachedDescriptorTemplate =
  | CachedDescriptorTemplateSuccess
  | CachedDescriptorTemplateFailure;

interface ValueTraversalBudget {
  readonly limits: NormalizedRecursiveClassicXrfcLimits;
  nodes: number;
  rows: number;
}

interface ValueEncodingBudget extends ValueTraversalBudget {
  parameterBytes: number;
}

interface PlannedTextScalar {
  readonly descriptor: RecursiveClassicXrfcScalarDescriptor;
  readonly kind: "text";
  readonly value: string;
  readonly contentByteLength: number;
}

interface PlannedBytesScalar {
  readonly descriptor: RecursiveClassicXrfcScalarDescriptor;
  readonly kind: "bytes";
  readonly value: Uint8Array;
  readonly path: string;
  readonly byteLength: number;
  readonly contentByteLength: number;
}

interface PlannedStructure {
  readonly descriptor: RecursiveClassicXrfcStructureDescriptor;
  readonly kind: "structure";
  readonly fields: readonly PlannedValue[];
  readonly contentByteLength: number;
}

interface PlannedTable {
  readonly descriptor: RecursiveClassicXrfcTableDescriptor;
  readonly kind: "table";
  readonly rows: readonly PlannedStructure[];
  readonly contentByteLength: number;
}

type PlannedValue =
  | PlannedTextScalar
  | PlannedBytesScalar
  | PlannedStructure
  | PlannedTable;

const SUPPORTED_SCALARS: ReadonlySet<string> = new Set(["I", "C", "g", "y"]);
const DEFAULT_MAX_NODES = 100_000;
const ABSOLUTE_MAX_NODES = 1_000_000;
const DEFAULT_MAX_DEPTH = 64;
const ABSOLUTE_MAX_DEPTH = 256;
const ITEM_WRAPPER_BYTE_LENGTH = 13; // <item></item>
const RESOLVED_PARAMETERS = new WeakSet<object>();
const EMPTY_STRUCTURE_VALUE = Object.freeze({});
const EMPTY_TABLE_VALUE = Object.freeze([]);
const LIMIT_KEYS = Object.freeze([
  "maxCellBytes",
  "maxRowBytes",
  "maxParameterBytes",
  "maxRows",
  "maxNodes",
  "maxDepth",
] as const);
const IDENTITY_KEYS = Object.freeze([
  "functionName",
  "parameterName",
  "parameterClass",
  "associatedType",
  "internalType",
] as const);
const DESCRIPTOR_TEMPLATE_CACHE = "strict-descriptor-template-v1";
const DESCRIPTOR_SUBTREE_CACHE = "strict-descriptor-subtree-v1";
const DESCRIPTOR_TEMPLATE_PATH = "<recursive-xrfc-root>";

interface PlainDataRecord {
  readonly value: Readonly<Record<string, unknown>>;
  readonly keys: readonly string[];
}

function isProxy(value: object): boolean {
  return nodeUtilTypes.isProxy(value);
}

function ownStringKeys(value: object, path: string): readonly string[] {
  if (isProxy(value)) throw new TypeError(`${path} must not be a proxy`);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${path} own properties could not be inspected`);
  }
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol properties`);
    }
    result.push(key);
  }
  return result;
}

function objectPrototype(value: object, path: string): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new TypeError(`${path} prototype could not be inspected`);
  }
}

function plainDataRecord(value: unknown, path: string): PlainDataRecord {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${path} must be an object`);
  }
  if (isProxy(value)) throw new TypeError(`${path} must not be a proxy`);
  if (Array.isArray(value)) throw new TypeError(`${path} must not be an array`);
  const prototype = objectPrototype(value, path);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must use Object.prototype or a null prototype`);
  }
  return Object.freeze({
    value: value as Readonly<Record<string, unknown>>,
    keys: Object.freeze([...ownStringKeys(value, path)]),
  });
}

function ownDataValue(value: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError(`${path} property could not be inspected`);
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`${path} must be an own data property`);
  }
  return descriptor.value;
}

function exactDataRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): PlainDataRecord {
  const record = plainDataRecord(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of record.keys) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path} contains unknown property ${key}`);
    }
    ownDataValue(record.value, key, `${path}.${key}`);
  }
  for (const key of requiredKeys) {
    if (!record.keys.includes(key)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
  }
  return record;
}

function optionalDataValue(
  record: PlainDataRecord,
  key: string,
  path: string,
): unknown {
  return record.keys.includes(key)
    ? ownDataValue(record.value, key, `${path}.${key}`)
    : undefined;
}

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

function normalizeLimits(
  limits: RecursiveClassicXrfcLimits,
): NormalizedRecursiveClassicXrfcLimits {
  const record = exactDataRecord(
    limits,
    "recursive xRFC limits",
    LIMIT_KEYS,
    [],
  );
  const maxCellBytes = optionalDataValue(record, "maxCellBytes", "limits");
  const maxRowBytes = optionalDataValue(record, "maxRowBytes", "limits");
  const maxParameterBytes = optionalDataValue(
    record,
    "maxParameterBytes",
    "limits",
  );
  const maxRows = optionalDataValue(record, "maxRows", "limits");
  const maxNodes = optionalDataValue(record, "maxNodes", "limits");
  const maxDepth = optionalDataValue(record, "maxDepth", "limits");
  const classic = normalizeClassicXrfcLimits({
    maxCellBytes: maxCellBytes as number | undefined,
    maxRowBytes: maxRowBytes as number | undefined,
    maxParameterBytes: maxParameterBytes as number | undefined,
    maxRows: maxRows as number | undefined,
  });
  return Object.freeze({
    ...classic,
    maxNodes: boundedLimit(
      maxNodes as number | undefined,
      DEFAULT_MAX_NODES,
      ABSOLUTE_MAX_NODES,
      "maxNodes",
    ),
    maxDepth: boundedLimit(
      maxDepth as number | undefined,
      DEFAULT_MAX_DEPTH,
      ABSOLUTE_MAX_DEPTH,
      "maxDepth",
    ),
  });
}

function snapshotIdentity(
  identity: RecursiveClassicXrfcParameterIdentity,
): RecursiveClassicXrfcParameterIdentity {
  const record = exactDataRecord(
    identity,
    "recursive xRFC parameter identity",
    IDENTITY_KEYS,
    IDENTITY_KEYS,
  );
  const functionName = ownDataValue(
    record.value,
    "functionName",
    "identity.functionName",
  );
  const parameterName = ownDataValue(
    record.value,
    "parameterName",
    "identity.parameterName",
  );
  const parameterClass = ownDataValue(
    record.value,
    "parameterClass",
    "identity.parameterClass",
  );
  const associatedType = ownDataValue(
    record.value,
    "associatedType",
    "identity.associatedType",
  );
  const internalType = ownDataValue(
    record.value,
    "internalType",
    "identity.internalType",
  );
  if (typeof parameterName !== "string") {
    throw new TypeError("recursive xRFC parameter name must be a string");
  }
  assertClassicXrfcXmlName(parameterName, "xRFC parameter name");
  if (typeof functionName !== "string" || functionName.length === 0) {
    throw new TypeError("recursive xRFC function name must be non-empty");
  }
  if (typeof parameterClass !== "string" || !/^[IECT]$/u.test(parameterClass)) {
    throw new TypeError("recursive xRFC parameter class must be I, E, C, or T");
  }
  if (typeof associatedType !== "string") {
    throw new TypeError("recursive xRFC associated type must be a string");
  }
  if (typeof internalType !== "string" || internalType.length !== 1) {
    throw new TypeError("recursive xRFC internal type must contain one character");
  }
  return Object.freeze({
    functionName,
    parameterName,
    parameterClass: parameterClass as RecursiveClassicXrfcParameterIdentity["parameterClass"],
    associatedType,
    internalType,
  });
}

function matchingParameter(
  graph: RecursiveMetadataGraph,
  identity: RecursiveClassicXrfcParameterIdentity,
  index?: RecursiveMetadataParameterIndex,
): RecursiveMetadataParameter {
  if (!isNormalizedRecursiveMetadataGraph(graph)) {
    throw new TypeError(
      "recursive xRFC metadata graph must be a normalized recursive metadata graph",
    );
  }
  if (!isImmutableMetadataMap(graph.nodes as object)) {
    throw new TypeError("recursive xRFC metadata nodes must be immutable");
  }
  if (
    graph.functionIdentity === undefined ||
    graph.functionIdentity.name !== identity.functionName
  ) {
    throw new Error(
      `recursive xRFC metadata identity does not match function ${identity.functionName}`,
    );
  }
  if (!Array.isArray(graph.parameters)) {
    throw new TypeError("recursive xRFC metadata parameters must be an array");
  }
  const parameter = index === undefined
    ? (() => {
        const matches = graph.parameters.filter(
          (candidate) => candidate.name === identity.parameterName,
        );
        if (matches.length !== 1) {
          throw new Error(
            `${identity.functionName}.${identity.parameterName} recursive metadata ` +
              `contains ${matches.length} matching parameters`,
          );
        }
        return matches[0]!;
      })()
    : recursiveMetadataParameterFromIndex(
        graph,
        index,
        identity.parameterName,
      );
  if (parameter === undefined) {
    throw new Error(
      `${identity.functionName}.${identity.parameterName} recursive metadata ` +
        "contains 0 matching parameters",
    );
  }
  if (
    parameter.functionName !== identity.functionName ||
    parameter.parameterClass !== identity.parameterClass ||
    parameter.associatedType !== identity.associatedType ||
    parameter.internalType !== identity.internalType
  ) {
    throw new Error(
      `${identity.functionName}.${identity.parameterName} recursive descriptor does not match flat metadata`,
    );
  }
  return parameter;
}

function visitDescriptor(
  budget: DescriptorBudget,
  depth: number,
  path: string,
): void {
  recordRecursiveMetadataParameterIndexWork(
    budget.graph,
    budget.index,
    "strictDescriptorNodeVisits",
  );
  if (depth > budget.limits.maxDepth) {
    throw new RangeError(`${path} descriptor depth exceeds ${budget.limits.maxDepth}`);
  }
  budget.maximumDepth = Math.max(budget.maximumDepth, depth);
  budget.nodes += 1;
  if (budget.nodes > budget.limits.maxNodes) {
    throw new RangeError(`${path} descriptor node count exceeds ${budget.limits.maxNodes}`);
  }
}

function requiredNode(
  graph: RecursiveMetadataGraph,
  typeName: string,
  expectedKind: "structure" | "table",
  path: string,
): RecursiveMetadataTypeNode {
  const get = graph.nodes?.get;
  if (typeof get !== "function") {
    throw new TypeError("recursive xRFC metadata nodes must be a read-only map");
  }
  const node = Reflect.apply(get, graph.nodes, [typeName]) as
    | RecursiveMetadataTypeNode
    | undefined;
  if (node === undefined || node.kind !== expectedKind || node.name !== typeName) {
    throw new Error(`${path} requires recursive ${expectedKind} node ${typeName}`);
  }
  if (!Array.isArray(node.fields)) {
    throw new TypeError(`${path} recursive ${expectedKind} fields must be an array`);
  }
  return node;
}

function scalarDescriptor(
  field: RecursiveMetadataField,
  path: string,
  budget: DescriptorBudget,
  depth: number,
): RecursiveClassicXrfcScalarDescriptor {
  visitDescriptor(budget, depth, path);
  if (
    field.reference.kind !== "scalar" ||
    field.reference.internalType !== field.internalType
  ) {
    throw new Error(`${path} contains inconsistent scalar metadata`);
  }
  if (!SUPPORTED_SCALARS.has(field.internalType)) {
    throw new Error(
      `${path} type ${field.internalType} is not implemented for the proven recursive xRFC subset`,
    );
  }
  if (!Number.isSafeInteger(field.ucLength) || field.ucLength < 0) {
    throw new Error(`${path} contains invalid Unicode geometry`);
  }
  if (field.internalType === "I" && field.ucLength !== 4) {
    throw new Error(`${path} INT4 must occupy four Unicode bytes`);
  }
  if (field.internalType === "C" && (field.ucLength & 1) !== 0) {
    throw new Error(`${path} Unicode character width must be even`);
  }
  return Object.freeze({
    kind: "scalar",
    name: field.name,
    internalType: field.internalType as RecursiveClassicXrfcScalarDescriptor["internalType"],
    internalLength: field.ucLength,
  });
}

function descriptorForReference(
  graph: RecursiveMetadataGraph,
  field: RecursiveMetadataField,
  path: string,
  budget: DescriptorBudget,
  depth: number,
  activeTypes: Set<string>,
): RecursiveClassicXrfcDescriptor {
  assertClassicXrfcXmlName(field.name, `${path} field name`);
  if (field.reference.kind === "scalar") {
    return scalarDescriptor(field, path, budget, depth);
  }
  if (field.reference.cyclic) {
    throw new Error(`${path} contains a cyclic recursive reference`);
  }
  if (
    field.reference.kind === "structure" &&
    field.internalType !== "u" &&
    field.internalType !== "v"
  ) {
    throw new Error(`${path} contains inconsistent structure metadata`);
  }
  if (field.reference.kind === "table" && field.internalType !== "h") {
    throw new Error(`${path} contains inconsistent table metadata`);
  }
  return buildNodeDescriptor(
    graph,
    field.reference.targetType,
    field.reference.kind,
    field.name,
    path,
    budget,
    depth,
    activeTypes,
  );
}

function buildStructureDescriptor(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  name: string,
  path: string,
  budget: DescriptorBudget,
  depth: number,
  activeTypes: Set<string>,
): RecursiveClassicXrfcStructureDescriptor {
  const names = new Set<string>();
  const fields: RecursiveClassicXrfcDescriptor[] = [];
  for (let index = 0; index < node.fields.length; index += 1) {
    const field = node.fields[index]!;
    const fieldPath = `${path}.${field.name || `<field:${index}>`}`;
    if (field.name.length === 0) {
      throw new Error(`${fieldPath} structure field name must not be empty`);
    }
    if (names.has(field.name)) {
      throw new Error(`${path} contains duplicate field ${field.name}`);
    }
    if (field.position !== index + 1) {
      throw new Error(`${fieldPath} has inconsistent field position`);
    }
    names.add(field.name);
    fields.push(descriptorForReference(
      graph,
      field,
      fieldPath,
      budget,
      depth + 1,
      activeTypes,
    ));
  }
  return Object.freeze({
    kind: "structure",
    name,
    typeName: node.name,
    fields: Object.freeze(fields),
  });
}

function buildTableDescriptor(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  name: string,
  path: string,
  budget: DescriptorBudget,
  depth: number,
  activeTypes: Set<string>,
): RecursiveClassicXrfcTableDescriptor {
  if (node.fields.length !== 1) {
    throw new Error(`${path} table ${node.name} must contain one line descriptor`);
  }
  const line = node.fields[0]!;
  if (
    line.name !== "" ||
    line.reference.kind !== "structure" ||
    line.reference.cyclic
  ) {
    throw new Error(
      `${path} table ${node.name} requires one non-cyclic structured line`,
    );
  }
  const linePath = `${path}[]`;
  const lineDescriptor = buildNodeDescriptor(
    graph,
    line.reference.targetType,
    "structure",
    "",
    linePath,
    budget,
    depth + 1,
    activeTypes,
  );
  return Object.freeze({
    kind: "table",
    name,
    typeName: node.name,
    line: lineDescriptor as RecursiveClassicXrfcStructureDescriptor,
  });
}

function buildNodeDescriptorUncached(
  graph: RecursiveMetadataGraph,
  typeName: string,
  kind: "structure" | "table",
  name: string,
  path: string,
  budget: DescriptorBudget,
  depth: number,
  activeTypes: Set<string>,
): RecursiveClassicXrfcStructureDescriptor | RecursiveClassicXrfcTableDescriptor {
  visitDescriptor(budget, depth, path);
  if (activeTypes.has(typeName)) {
    throw new Error(`${path} contains a cyclic recursive type ${typeName}`);
  }
  const node = requiredNode(graph, typeName, kind, path);
  activeTypes.add(typeName);
  try {
    return kind === "structure"
      ? buildStructureDescriptor(
          graph,
          node,
          name,
          path,
          budget,
          depth,
          activeTypes,
        )
      : buildTableDescriptor(
          graph,
          node,
          name,
          path,
          budget,
          depth,
          activeTypes,
        );
  } finally {
    activeTypes.delete(typeName);
  }
}

function descriptorSubtreeTemplateKey(
  typeName: string,
  kind: "structure" | "table",
  limits: NormalizedRecursiveClassicXrfcLimits,
): string {
  return JSON.stringify([
    kind,
    typeName,
    limits.maxCellBytes,
    limits.maxRowBytes,
    limits.maxParameterBytes,
    limits.maxRows,
    limits.maxNodes,
    limits.maxDepth,
  ]);
}

function applyCachedDescriptorMetrics(
  budget: DescriptorBudget,
  template: CachedDescriptorTemplateSuccess,
  depth: number,
  path: string,
): void {
  const maximumDepth = depth + template.descriptorMaximumDepth - 1;
  if (maximumDepth > budget.limits.maxDepth) {
    throw new RangeError(
      `${path} descriptor depth exceeds ${budget.limits.maxDepth}`,
    );
  }
  const nodes = budget.nodes + template.descriptorNodeCount;
  if (!Number.isSafeInteger(nodes) || nodes > budget.limits.maxNodes) {
    throw new RangeError(
      `${path} descriptor node count exceeds ${budget.limits.maxNodes}`,
    );
  }
  budget.nodes = nodes;
  budget.maximumDepth = Math.max(budget.maximumDepth, maximumDepth);
}

function buildNodeDescriptor(
  graph: RecursiveMetadataGraph,
  typeName: string,
  kind: "structure" | "table",
  name: string,
  path: string,
  budget: DescriptorBudget,
  depth: number,
  activeTypes: Set<string>,
): RecursiveClassicXrfcStructureDescriptor | RecursiveClassicXrfcTableDescriptor {
  const index = budget.index;
  if (index === undefined) {
    return buildNodeDescriptorUncached(
      graph,
      typeName,
      kind,
      name,
      path,
      budget,
      depth,
      activeTypes,
    );
  }
  if (activeTypes.has(typeName)) {
    throw new Error(`${path} contains a cyclic recursive type ${typeName}`);
  }
  const cacheKey = descriptorSubtreeTemplateKey(typeName, kind, budget.limits);
  let template = recursiveMetadataParameterIndexCacheGet<
    CachedDescriptorTemplate
  >(graph, index, DESCRIPTOR_SUBTREE_CACHE, cacheKey);
  if (template === undefined) {
    const templateBudget: DescriptorBudget = {
      limits: budget.limits,
      graph,
      index,
      nodes: 0,
      maximumDepth: 0,
    };
    try {
      const templateRoot = buildNodeDescriptorUncached(
        graph,
        typeName,
        kind,
        "",
        DESCRIPTOR_TEMPLATE_PATH,
        templateBudget,
        1,
        new Set(activeTypes),
      );
      template = Object.freeze({
        ok: true,
        root: templateRoot,
        descriptorNodeCount: templateBudget.nodes,
        descriptorMaximumDepth: templateBudget.maximumDepth,
      });
    } catch (error) {
      template = cachedDescriptorFailure(error);
    }
    recursiveMetadataParameterIndexCacheSet(
      graph,
      index,
      DESCRIPTOR_SUBTREE_CACHE,
      cacheKey,
      template,
    );
  }
  if (!template.ok) throwDescriptorFailure(template, path);
  applyCachedDescriptorMetrics(budget, template, depth, path);
  return bindDescriptorRootName(template.root, name);
}

function descriptorTemplateKey(
  reference: Readonly<{
    kind: "structure" | "table";
    targetType: string;
  }>,
  limits: NormalizedRecursiveClassicXrfcLimits,
): string {
  return JSON.stringify([
    reference.kind,
    reference.targetType,
    limits.maxCellBytes,
    limits.maxRowBytes,
    limits.maxParameterBytes,
    limits.maxRows,
    limits.maxNodes,
    limits.maxDepth,
  ]);
}

function cachedDescriptorFailure(error: unknown): CachedDescriptorTemplateFailure {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return Object.freeze({
    ok: false,
    errorName: normalized.name,
    message: normalized.message,
  });
}

function throwDescriptorFailure(
  failure: CachedDescriptorTemplateFailure,
  path: string,
): never {
  const message = failure.message.replaceAll(DESCRIPTOR_TEMPLATE_PATH, path);
  if (failure.errorName === "RangeError") throw new RangeError(message);
  if (failure.errorName === "TypeError") throw new TypeError(message);
  throw new Error(message);
}

function bindDescriptorRootName(
  root: RecursiveClassicXrfcStructureDescriptor |
    RecursiveClassicXrfcTableDescriptor,
  name: string,
): RecursiveClassicXrfcStructureDescriptor |
  RecursiveClassicXrfcTableDescriptor {
  return Object.freeze({ ...root, name });
}

/**
 * Resolve one independently proven classic/xRFC recursive parameter plan.
 * basXML and fast serialization are deliberately not selected by this API.
 */
export function resolveRecursiveClassicXrfcParameter(
  graph: RecursiveMetadataGraph,
  identity: RecursiveClassicXrfcParameterIdentity,
  limits: RecursiveClassicXrfcLimits = {},
): ResolvedRecursiveClassicXrfcParameter {
  const normalizedIdentity = snapshotIdentity(identity);
  const normalizedLimits = normalizeLimits(limits);
  return resolveRecursiveClassicXrfcParameterWithSnapshot(
    graph,
    normalizedIdentity,
    normalizedLimits,
  );
}

/** Internal indexed resolver used by one captured invocation dispatch. */
export function resolveRecursiveClassicXrfcParameterFromIndex(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  identity: RecursiveClassicXrfcParameterIdentity,
  limits: RecursiveClassicXrfcLimits = {},
): ResolvedRecursiveClassicXrfcParameter {
  const normalizedIdentity = snapshotIdentity(identity);
  const normalizedLimits = normalizeLimits(limits);
  return resolveRecursiveClassicXrfcParameterWithSnapshot(
    graph,
    normalizedIdentity,
    normalizedLimits,
    index,
  );
}

function resolveRecursiveClassicXrfcParameterWithSnapshot(
  graph: RecursiveMetadataGraph,
  normalizedIdentity: RecursiveClassicXrfcParameterIdentity,
  normalizedLimits: NormalizedRecursiveClassicXrfcLimits,
  index?: RecursiveMetadataParameterIndex,
): ResolvedRecursiveClassicXrfcParameter {
  const parameter = matchingParameter(graph, normalizedIdentity, index);
  const reference = parameter.reference;
  if (
    (reference.kind !== "structure" && reference.kind !== "table") ||
    !("targetType" in reference)
  ) {
    throw new Error(
      `${normalizedIdentity.functionName}.${normalizedIdentity.parameterName} ` +
        "is not a recursive structure or structured table",
    );
  }
  if (reference.cyclic) {
    throw new Error(
      `${normalizedIdentity.functionName}.${normalizedIdentity.parameterName} ` +
        "contains a cyclic recursive reference",
    );
  }
  const path = `${normalizedIdentity.functionName}.${normalizedIdentity.parameterName}`;
  let root: RecursiveClassicXrfcStructureDescriptor |
    RecursiveClassicXrfcTableDescriptor;
  let descriptorNodeCount: number;
  let descriptorMaximumDepth: number;
  if (index === undefined) {
    const budget: DescriptorBudget = {
      limits: normalizedLimits,
      graph,
      nodes: 0,
      maximumDepth: 0,
    };
    root = buildNodeDescriptor(
      graph,
      reference.targetType,
      reference.kind,
      normalizedIdentity.parameterName,
      path,
      budget,
      1,
      new Set(),
    );
    descriptorNodeCount = budget.nodes;
    descriptorMaximumDepth = budget.maximumDepth;
  } else {
    const cacheKey = descriptorTemplateKey(reference, normalizedLimits);
    let template = recursiveMetadataParameterIndexCacheGet<
      CachedDescriptorTemplate
    >(graph, index, DESCRIPTOR_TEMPLATE_CACHE, cacheKey);
    if (template === undefined) {
      const budget: DescriptorBudget = {
        limits: normalizedLimits,
        graph,
        index,
        nodes: 0,
        maximumDepth: 0,
      };
      try {
        const templateRoot = buildNodeDescriptor(
          graph,
          reference.targetType,
          reference.kind,
          "",
          DESCRIPTOR_TEMPLATE_PATH,
          budget,
          1,
          new Set(),
        );
        template = Object.freeze({
          ok: true,
          root: templateRoot,
          descriptorNodeCount: budget.nodes,
          descriptorMaximumDepth: budget.maximumDepth,
        });
      } catch (error) {
        template = cachedDescriptorFailure(error);
      }
      recursiveMetadataParameterIndexCacheSet(
        graph,
        index,
        DESCRIPTOR_TEMPLATE_CACHE,
        cacheKey,
        template,
      );
    }
    if (!template.ok) throwDescriptorFailure(template, path);
    root = bindDescriptorRootName(
      template.root,
      normalizedIdentity.parameterName,
    );
    descriptorNodeCount = template.descriptorNodeCount;
    descriptorMaximumDepth = template.descriptorMaximumDepth;
  }
  const resolved = Object.freeze({
    serializer: "classic-xrfc",
    functionName: normalizedIdentity.functionName,
    parameterName: normalizedIdentity.parameterName,
    parameterClass: normalizedIdentity.parameterClass,
    kind: reference.kind,
    root,
    descriptorNodeCount,
    descriptorMaximumDepth,
  });
  RESOLVED_PARAMETERS.add(resolved);
  return resolved;
}

function trustedResolvedParameter(
  value: unknown,
): ResolvedRecursiveClassicXrfcParameter {
  if (
    typeof value !== "object" ||
    value === null ||
    !RESOLVED_PARAMETERS.has(value)
  ) {
    throw new TypeError(
      "recursive xRFC plan must be returned by resolveRecursiveClassicXrfcParameter",
    );
  }
  return value as ResolvedRecursiveClassicXrfcParameter;
}

function visitValue(
  budget: ValueTraversalBudget,
  depth: number,
  path: string,
): void {
  if (depth > budget.limits.maxDepth) {
    throw new RangeError(`${path} value depth exceeds ${budget.limits.maxDepth}`);
  }
  budget.nodes += 1;
  if (budget.nodes > budget.limits.maxNodes) {
    throw new RangeError(
      `${path} value node count exceeds ${budget.limits.maxNodes}`,
    );
  }
}

function assertAggregateBytes(
  byteLength: number,
  path: string,
  limits: NormalizedRecursiveClassicXrfcLimits,
): void {
  if (byteLength > limits.maxParameterBytes) {
    throw new RangeError(
      `${path} xRFC XML exceeds ${limits.maxParameterBytes} bytes`,
    );
  }
}

function reserveParameterBytes(
  budget: ValueEncodingBudget,
  byteLength: number,
  path: string,
): void {
  budget.parameterBytes = checkedClassicXrfcLength(
    budget.parameterBytes,
    byteLength,
    path,
  );
  if (budget.parameterBytes > budget.limits.maxParameterBytes) {
    throw new RangeError(
      `${path} xRFC XML exceeds ${budget.limits.maxParameterBytes} bytes`,
    );
  }
}

function integerText(value: unknown, path: string): string {
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

function initialScalar(
  descriptor: RecursiveClassicXrfcScalarDescriptor,
): unknown {
  switch (descriptor.internalType) {
    case "I":
      return 0;
    case "C":
    case "g":
      return "";
    case "y":
      return Buffer.alloc(0);
  }
}

function planScalar(
  descriptor: RecursiveClassicXrfcScalarDescriptor,
  value: unknown,
  path: string,
  budget: ValueEncodingBudget,
  depth: number,
): PlannedTextScalar | PlannedBytesScalar {
  visitValue(budget, depth, path);
  let text: string;
  switch (descriptor.internalType) {
    case "I":
      text = integerText(value, path);
      break;
    case "C": {
      if (typeof value !== "string") throw new TypeError(`${path} expects a string`);
      assertUnicodeScalarText(value, path);
      const capacity = descriptor.internalLength / 2;
      if (value.length > capacity) {
        throw new RangeError(`${path} does not fit CHAR(${capacity})`);
      }
      text = value;
      break;
    }
    case "g":
      if (typeof value !== "string") {
        throw new TypeError(`${path} expects Unicode text`);
      }
      assertNulFreeUnicodeScalarText(value, path);
      text = value;
      break;
    case "y": {
      if (
        typeof value !== "object" ||
        value === null ||
        isProxy(value) ||
        !nodeUtilTypes.isUint8Array(value)
      ) {
        throw new TypeError(`${path} expects Uint8Array bytes`);
      }
      const byteLength = intrinsicUint8ArrayByteLength(value);
      const contentByteLength = Math.ceil(byteLength / 3) * 4;
      if (
        !Number.isSafeInteger(contentByteLength) ||
        contentByteLength > budget.limits.maxCellBytes
      ) {
        throw new RangeError(
          `${path} base64 value exceeds ${budget.limits.maxCellBytes} encoded bytes`,
        );
      }
      reserveParameterBytes(budget, contentByteLength, path);
      return Object.freeze({
        descriptor,
        kind: "bytes",
        value,
        path,
        byteLength,
        contentByteLength,
      });
    }
  }
  const contentByteLength = escapedClassicXrfcXmlByteLength(text, path);
  if (contentByteLength > budget.limits.maxCellBytes) {
    throw new RangeError(
      `${path} XML value exceeds ${budget.limits.maxCellBytes} encoded bytes`,
    );
  }
  reserveParameterBytes(budget, contentByteLength, path);
  return Object.freeze({
    descriptor,
    kind: "text",
    value: text,
    contentByteLength,
  });
}

function ownStructureValues(
  descriptor: RecursiveClassicXrfcStructureDescriptor,
  value: unknown,
  path: string,
): ReadonlyMap<string, unknown> {
  const record = plainDataRecord(value, path);
  const known = new Set(descriptor.fields.map((field) => field.name));
  const result = new Map<string, unknown>();
  for (const key of record.keys) {
    if (!known.has(key)) throw new Error(`${path} contains unknown field ${key}`);
    result.set(
      key,
      ownDataValue(record.value, key, `${path}.${key}`),
    );
  }
  return result;
}

function defineStructureField(
  target: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function initialDescriptorValue(descriptor: RecursiveClassicXrfcDescriptor): unknown {
  if (descriptor.kind === "scalar") return initialScalar(descriptor);
  if (descriptor.kind === "table") return [];
  const result: Record<string, unknown> = {};
  for (const field of descriptor.fields) {
    defineStructureField(result, field.name, initialDescriptorValue(field));
  }
  return result;
}

function taggedByteLength(
  name: string,
  contentByteLength: number,
  path: string,
): number {
  return checkedClassicXrfcLength(
    checkedClassicXrfcLength(
      classicXrfcOpenTagByteLength(name),
      contentByteLength,
      path,
    ),
    classicXrfcCloseTagByteLength(name),
    path,
  );
}

function planStructure(
  descriptor: RecursiveClassicXrfcStructureDescriptor,
  value: unknown,
  path: string,
  budget: ValueEncodingBudget,
  depth: number,
): PlannedStructure {
  visitValue(budget, depth, path);
  const supplied = ownStructureValues(descriptor, value, path);
  const fields: PlannedValue[] = [];
  let contentByteLength = 0;
  for (const field of descriptor.fields) {
    const fieldPath = `${path}.${field.name}`;
    reserveParameterBytes(
      budget,
      classicXrfcOpenTagByteLength(field.name) +
        classicXrfcCloseTagByteLength(field.name),
      fieldPath,
    );
    const planned = supplied.has(field.name)
      ? planValue(
          field,
          supplied.get(field.name),
          fieldPath,
          budget,
          depth + 1,
        )
      : planInitialValue(field, fieldPath, budget, depth + 1);
    contentByteLength = checkedClassicXrfcLength(
      contentByteLength,
      taggedByteLength(field.name, planned.contentByteLength, fieldPath),
      path,
    );
    assertAggregateBytes(contentByteLength, path, budget.limits);
    fields.push(planned);
  }
  if (contentByteLength > budget.limits.maxRowBytes) {
    throw new RangeError(
      `${path} XML row exceeds ${budget.limits.maxRowBytes} encoded bytes`,
    );
  }
  return Object.freeze({
    descriptor,
    kind: "structure",
    fields: Object.freeze(fields),
    contentByteLength,
  });
}

function planInitialValue(
  descriptor: RecursiveClassicXrfcDescriptor,
  path: string,
  budget: ValueEncodingBudget,
  depth: number,
): PlannedValue {
  switch (descriptor.kind) {
    case "scalar":
      return planScalar(
        descriptor,
        initialScalar(descriptor),
        path,
        budget,
        depth,
      );
    case "structure":
      return planStructure(
        descriptor,
        EMPTY_STRUCTURE_VALUE,
        path,
        budget,
        depth,
      );
    case "table":
      return planTable(
        descriptor,
        EMPTY_TABLE_VALUE,
        path,
        budget,
        depth,
      );
  }
}

function reserveTableRows(
  value: unknown,
  path: string,
  budget: ValueEncodingBudget,
): readonly unknown[] {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${path} expects an array of rows`);
  }
  if (isProxy(value)) throw new TypeError(`${path} must not be a proxy`);
  if (!Array.isArray(value)) throw new TypeError(`${path} expects an array of rows`);
  if (objectPrototype(value, path) !== Array.prototype) {
    throw new TypeError(`${path} must use Array.prototype`);
  }
  const remainingRows = budget.limits.maxRows - budget.rows;
  if (value.length > remainingRows) {
    throw new RangeError(`${path} row count exceeds ${budget.limits.maxRows}`);
  }
  const keys = ownStringKeys(value, path);
  for (const key of keys) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${path} contains unknown array property ${key}`);
    }
    ownDataValue(value, key, `${path}[${key}]`);
  }
  for (let index = 0; index < value.length; index += 1) {
    ownDataValue(value, String(index), `${path}[${index}]`);
  }
  budget.rows += value.length;
  return value;
}

function planTable(
  descriptor: RecursiveClassicXrfcTableDescriptor,
  value: unknown,
  path: string,
  budget: ValueEncodingBudget,
  depth: number,
): PlannedTable {
  visitValue(budget, depth, path);
  const values = reserveTableRows(value, path, budget);
  const rows: PlannedStructure[] = [];
  let contentByteLength = 0;
  for (let index = 0; index < values.length; index += 1) {
    const rowPath = `${path}[${index}]`;
    reserveParameterBytes(budget, ITEM_WRAPPER_BYTE_LENGTH, rowPath);
    const row = planStructure(
      descriptor.line,
      ownDataValue(values, String(index), `${rowPath}`),
      rowPath,
      budget,
      depth + 1,
    );
    const rowByteLength = checkedClassicXrfcLength(
      ITEM_WRAPPER_BYTE_LENGTH,
      row.contentByteLength,
      rowPath,
    );
    if (rowByteLength > budget.limits.maxRowBytes) {
      throw new RangeError(
        `${rowPath} XML row exceeds ${budget.limits.maxRowBytes} encoded bytes`,
      );
    }
    contentByteLength = checkedClassicXrfcLength(
      contentByteLength,
      rowByteLength,
      path,
    );
    assertAggregateBytes(contentByteLength, path, budget.limits);
    rows.push(row);
  }
  return Object.freeze({
    descriptor,
    kind: "table",
    rows: Object.freeze(rows),
    contentByteLength,
  });
}

function planValue(
  descriptor: RecursiveClassicXrfcDescriptor,
  value: unknown,
  path: string,
  budget: ValueEncodingBudget,
  depth: number,
): PlannedValue {
  switch (descriptor.kind) {
    case "scalar":
      return planScalar(descriptor, value, path, budget, depth);
    case "structure":
      return planStructure(descriptor, value, path, budget, depth);
    case "table":
      return planTable(descriptor, value, path, budget, depth);
  }
}

function writeContent(target: Buffer, offset: number, planned: PlannedValue): number {
  switch (planned.kind) {
    case "text":
      return writeEscapedClassicXrfcText(target, offset, planned.value);
    case "bytes":
      return offset + target.write(
        snapshotUint8Array(
          planned.value,
          planned.path,
          planned.byteLength,
        ).toString("base64"),
        offset,
        "ascii",
      );
    case "structure":
      for (const field of planned.fields) {
        offset = writeClassicXrfcOpenTag(target, offset, field.descriptor.name);
        offset = writeContent(target, offset, field);
        offset = writeClassicXrfcCloseTag(target, offset, field.descriptor.name);
      }
      return offset;
    case "table":
      for (const row of planned.rows) {
        offset = writeClassicXrfcOpenTag(target, offset, "item");
        offset = writeContent(target, offset, row);
        offset = writeClassicXrfcCloseTag(target, offset, "item");
      }
      return offset;
  }
}

/** Encode one bounded recursive parameter using only the classic xRFC path. */
export function encodeRecursiveClassicXrfcParameter(
  resolved: ResolvedRecursiveClassicXrfcParameter,
  value: unknown,
  limits: RecursiveClassicXrfcLimits = {},
): Buffer {
  const trusted = trustedResolvedParameter(resolved);
  const normalizedLimits = normalizeLimits(limits);
  const rootTagByteLength = classicXrfcOpenTagByteLength(
    trusted.parameterName,
  ) + classicXrfcCloseTagByteLength(trusted.parameterName);
  const budget: ValueEncodingBudget = {
    limits: normalizedLimits,
    nodes: 0,
    rows: 0,
    parameterBytes: 0,
  };
  reserveParameterBytes(budget, rootTagByteLength, trusted.parameterName);
  const planned = planValue(
    trusted.root,
    value,
    `${trusted.functionName}.${trusted.parameterName}`,
    budget,
    1,
  );
  const byteLength = taggedByteLength(
    trusted.parameterName,
    planned.contentByteLength,
    trusted.parameterName,
  );
  if (byteLength > normalizedLimits.maxParameterBytes) {
    throw new RangeError(
      `${trusted.parameterName} xRFC XML exceeds ${normalizedLimits.maxParameterBytes} bytes`,
    );
  }
  if (budget.parameterBytes !== byteLength) {
    throw new Error(
      `${trusted.parameterName} recursive xRFC preflight length invariant failed`,
    );
  }
  const encoded = Buffer.alloc(byteLength);
  let offset = writeClassicXrfcOpenTag(encoded, 0, trusted.parameterName);
  offset = writeContent(encoded, offset, planned);
  offset = writeClassicXrfcCloseTag(encoded, offset, trusted.parameterName);
  if (offset !== byteLength) {
    throw new Error(`${trusted.parameterName} recursive xRFC encoder length invariant failed`);
  }
  return encoded;
}

function decodeScalar(
  descriptor: RecursiveClassicXrfcScalarDescriptor,
  value: string,
  path: string,
  limits: NormalizedRecursiveClassicXrfcLimits,
): unknown {
  switch (descriptor.internalType) {
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
      const capacity = descriptor.internalLength / 2;
      if (value.length > capacity) {
        throw new RangeError(`${path} does not fit CHAR(${capacity})`);
      }
      return value;
    }
    case "g":
      assertNulFreeUnicodeScalarText(value, path);
      return value;
    case "y":
      return decodeClassicXrfcBase64(
        value,
        path,
        Math.floor(limits.maxCellBytes / 4) * 3,
      );
  }
}

function base64Sextet(characterCode: number): number {
  if (characterCode >= 0x41 && characterCode <= 0x5a) return characterCode - 0x41;
  if (characterCode >= 0x61 && characterCode <= 0x7a) return characterCode - 0x61 + 26;
  if (characterCode >= 0x30 && characterCode <= 0x39) return characterCode - 0x30 + 52;
  return characterCode === 0x2b ? 62 : 63;
}

function preflightScalar(
  descriptor: RecursiveClassicXrfcScalarDescriptor,
  value: string,
  path: string,
  limits: NormalizedRecursiveClassicXrfcLimits,
): void {
  switch (descriptor.internalType) {
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
      return;
    }
    case "C": {
      assertUnicodeScalarText(value, path);
      const capacity = descriptor.internalLength / 2;
      if (value.length > capacity) {
        throw new RangeError(`${path} does not fit CHAR(${capacity})`);
      }
      return;
    }
    case "g":
      assertNulFreeUnicodeScalarText(value, path);
      return;
    case "y": {
      // SAP's xRFC producer MIME-wraps larger XSTRING cells at 76 columns.
      // Remove only MIME line separators before canonical preflight. Adapted
      // from open-rfc-go internal/xrfc at
      // 92d5d8f6e0a08ff7ac1580f461585cbde2a56939.
      value = value.replace(/[\r\n]/gu, "");
      if (
        (value.length & 3) !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
      ) {
        throw new Error(`${path} contains non-canonical base64`);
      }
      if (
        (value.endsWith("==") &&
          (base64Sextet(value.charCodeAt(value.length - 3)) & 0x0f) !== 0) ||
        (value.endsWith("=") && !value.endsWith("==") &&
          (base64Sextet(value.charCodeAt(value.length - 2)) & 0x03) !== 0)
      ) {
        throw new Error(`${path} contains non-canonical base64`);
      }
      const decodedByteLength = (value.length / 4) * 3 -
        (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
      if (decodedByteLength > Math.floor(limits.maxCellBytes / 4) * 3) {
        throw new RangeError(`${path} decoded bytes exceed its configured limit`);
      }
      return;
    }
  }
}

function preflightValueContent(
  parser: ExactClassicXrfcParser,
  descriptor: RecursiveClassicXrfcDescriptor,
  path: string,
  budget: ValueTraversalBudget,
  depth: number,
  closingTag: string,
): void {
  visitValue(budget, depth, path);
  if (descriptor.kind === "scalar") {
    preflightScalar(descriptor, parser.cell(path), path, budget.limits);
    return;
  }
  if (descriptor.kind === "structure") {
    const start = parser.position();
    for (const field of descriptor.fields) {
      const fieldPath = `${path}.${field.name}`;
      parser.open(field.name);
      preflightValueContent(
        parser,
        field,
        fieldPath,
        budget,
        depth + 1,
        field.name,
      );
      parser.close(field.name);
    }
    const rowByteLength = parser.rowByteLength(start);
    if (rowByteLength > budget.limits.maxRowBytes) {
      throw new RangeError(
        `${path} XML row exceeds ${budget.limits.maxRowBytes} encoded bytes`,
      );
    }
    return;
  }
  let rowIndex = 0;
  while (!parser.startsWithTag(closingTag, true)) {
    budget.rows += 1;
    if (budget.rows > budget.limits.maxRows) {
      throw new RangeError(`${path} row count exceeds ${budget.limits.maxRows}`);
    }
    const rowPath = `${path}[${rowIndex}]`;
    const start = parser.position();
    parser.open("item");
    preflightValueContent(
      parser,
      descriptor.line,
      rowPath,
      budget,
      depth + 1,
      "item",
    );
    parser.close("item");
    const rowByteLength = parser.rowByteLength(start);
    if (rowByteLength > budget.limits.maxRowBytes) {
      throw new RangeError(
        `${rowPath} XML row exceeds ${budget.limits.maxRowBytes} encoded bytes`,
      );
    }
    rowIndex += 1;
  }
}

function parseValueContent(
  parser: ExactClassicXrfcParser,
  descriptor: RecursiveClassicXrfcDescriptor,
  path: string,
  budget: ValueTraversalBudget,
  depth: number,
  closingTag: string,
): unknown {
  visitValue(budget, depth, path);
  if (descriptor.kind === "scalar") {
    return decodeScalar(descriptor, parser.cell(path), path, budget.limits);
  }
  if (descriptor.kind === "structure") {
    const start = parser.position();
    const result: Record<string, unknown> = {};
    for (const field of descriptor.fields) {
      const fieldPath = `${path}.${field.name}`;
      parser.open(field.name);
      defineStructureField(
        result,
        field.name,
        parseValueContent(
          parser,
          field,
          fieldPath,
          budget,
          depth + 1,
          field.name,
        ),
      );
      parser.close(field.name);
    }
    const rowByteLength = parser.rowByteLength(start);
    if (rowByteLength > budget.limits.maxRowBytes) {
      throw new RangeError(
        `${path} XML row exceeds ${budget.limits.maxRowBytes} encoded bytes`,
      );
    }
    return result;
  }
  const rows: Record<string, unknown>[] = [];
  while (!parser.startsWithTag(closingTag, true)) {
    budget.rows += 1;
    if (budget.rows > budget.limits.maxRows) {
      throw new RangeError(`${path} row count exceeds ${budget.limits.maxRows}`);
    }
    const index = rows.length;
    const rowPath = `${path}[${index}]`;
    const start = parser.position();
    parser.open("item");
    const row = parseValueContent(
      parser,
      descriptor.line,
      rowPath,
      budget,
      depth + 1,
      "item",
    ) as Record<string, unknown>;
    parser.close("item");
    const rowByteLength = parser.rowByteLength(start);
    if (rowByteLength > budget.limits.maxRowBytes) {
      throw new RangeError(
        `${rowPath} XML row exceeds ${budget.limits.maxRowBytes} encoded bytes`,
      );
    }
    rows.push(row);
  }
  return rows;
}

/** Decode the strict, attribute-free recursive classic xRFC subset. */
export function decodeRecursiveClassicXrfcParameter(
  resolved: ResolvedRecursiveClassicXrfcParameter,
  value: Uint8Array,
  limits: RecursiveClassicXrfcLimits = {},
): Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[] {
  const trusted = trustedResolvedParameter(resolved);
  const normalizedLimits = normalizeLimits(limits);
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    throw new TypeError(`${trusted.parameterName} xRFC XML must be Uint8Array bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength === 0 || byteLength > normalizedLimits.maxParameterBytes) {
    throw new RangeError(
      `${trusted.parameterName} xRFC XML must contain 1..${normalizedLimits.maxParameterBytes} bytes`,
    );
  }
  const encoded = snapshotUint8Array(value, trusted.parameterName, byteLength);
  if (
    encoded.byteLength >= 3 &&
    encoded[0] === 0xef &&
    encoded[1] === 0xbb &&
    encoded[2] === 0xbf
  ) {
    throw new Error(`${trusted.parameterName} xRFC XML must not contain a UTF-8 BOM`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  const preflightParser = new ExactClassicXrfcParser(text, normalizedLimits);
  const preflightBudget: ValueTraversalBudget = {
    limits: normalizedLimits,
    nodes: 0,
    rows: 0,
  };
  preflightParser.open(trusted.parameterName);
  preflightValueContent(
    preflightParser,
    trusted.root,
    `${trusted.functionName}.${trusted.parameterName}`,
    preflightBudget,
    1,
    trusted.parameterName,
  );
  preflightParser.close(trusted.parameterName);
  preflightParser.finish();
  const parser = new ExactClassicXrfcParser(text, normalizedLimits);
  const budget: ValueTraversalBudget = {
    limits: normalizedLimits,
    nodes: 0,
    rows: 0,
  };
  parser.open(trusted.parameterName);
  const result = parseValueContent(
    parser,
    trusted.root,
    `${trusted.functionName}.${trusted.parameterName}`,
    budget,
    1,
    trusted.parameterName,
  ) as Readonly<Record<string, unknown>> |
    readonly Readonly<Record<string, unknown>>[];
  parser.close(trusted.parameterName);
  parser.finish();
  return result;
}

/** Return a fresh ABAP-initial JavaScript value for a resolved deep parameter. */
export function initialRecursiveClassicXrfcValue(
  resolved: ResolvedRecursiveClassicXrfcParameter,
): Readonly<Record<string, unknown>> | readonly unknown[] {
  const trusted = trustedResolvedParameter(resolved);
  return initialDescriptorValue(trusted.root) as
    | Readonly<Record<string, unknown>>
    | readonly unknown[];
}
