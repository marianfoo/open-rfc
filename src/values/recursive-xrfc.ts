import { types as nodeUtilTypes } from "node:util";

import type { RfcFunintParameter } from "../protocol/classic-rfc.js";
import {
  recordRecursiveMetadataParameterIndexWork,
  recursiveMetadataParameterIndexCacheGet,
  recursiveMetadataParameterIndexCacheSet,
  recursiveMetadataParameterFromIndex,
  type RecursiveMetadataParameterIndex,
} from "../metadata/recursive-parameter-index.js";
import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";
import {
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
  DEFAULT_MAX_CPIC_FIELD_COUNT,
  DEFAULT_MAX_CPIC_FIELD_LENGTH,
} from "../protocol/cpic.js";
import type {
  RecursiveMetadataField,
  RecursiveMetadataGraph,
  RecursiveMetadataParameter,
  RecursiveMetadataReference,
  RecursiveMetadataTypeNode,
} from "../metadata/recursive-metadata.js";
import {
  decodeDecimalFloat16,
  decodeDecimalFloat34,
  encodeDecimalFloat16,
  encodeDecimalFloat34,
} from "./decimal-float.js";
import {
  decodePackedDecimal,
  encodePackedDecimal,
} from "./packed-decimal.js";
import {
  assertClassicDate,
  assertClassicTime,
  classicTemporalByteLength,
  classicTemporalInitialValue,
  decodeClassicTemporal,
  encodeClassicTemporal,
  isClassicTemporalExid,
} from "./classic-temporal.js";
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
  assertUnicodeScalarText,
  decodeXmlEntityReference,
} from "./unicode-scalar.js";

export type RecursiveXrfcKind = "structure" | "table";

export interface RecursiveXrfcLimits {
  readonly maxDepth?: number;
  /** Maximum runtime structure/table containers instantiated for one value. */
  readonly maxNodes?: number;
  readonly maxRows?: number;
  readonly maxCells?: number;
  readonly maxCellBytes?: number;
  readonly maxParameterBytes?: number;
}

export interface RecursiveXrfcOptions extends RecursiveXrfcLimits {
  readonly int8Mode?: ClassicInt8Mode;
  readonly bcd?: ClassicBcdMode;
}

interface NormalizedLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRows: number;
  readonly maxCells: number;
  readonly maxCellBytes: number;
  readonly maxParameterBytes: number;
}

export interface ResolvedRecursiveXrfcParameter {
  readonly parameter: RecursiveMetadataParameter;
  readonly kind: RecursiveXrfcKind;
  readonly node: RecursiveMetadataTypeNode;
}

interface ResolvedRecursiveXrfcParameterState {
  readonly graph: RecursiveMetadataGraph;
  readonly parameter: RfcFunintParameter;
  readonly index?: RecursiveMetadataParameterIndex;
}

interface EncodeState {
  readonly graph: RecursiveMetadataGraph;
  readonly limits: NormalizedLimits;
  readonly int8Mode: ClassicInt8Mode;
  readonly chunks: Buffer[];
  bytes: number;
  nodes: number;
  rows: number;
  cells: number;
}

interface GraphTraversalBudget {
  readonly maxNodes: number;
  readonly maxRows: number;
  readonly maxEdges: number;
  nodes: number;
  rows: number;
  edges: number;
}

interface CachedBroadValidationSubtree {
  readonly height: number;
}

const ABSOLUTE_GRAPH_MAX_NODES = 20_000;
const ABSOLUTE_GRAPH_MAX_ROWS = 100_000;
const ABSOLUTE_GRAPH_MAX_EDGES = 100_000;
const DEFAULT_RUNTIME_MAX_NODES = 100_000;
const ABSOLUTE_RUNTIME_MAX_NODES = 1_000_000;
const RESOLVED_PARAMETER_STATE = new WeakMap<
  object,
  ResolvedRecursiveXrfcParameterState
>();
const BROAD_CLASSIFICATION_CACHE = "broad-root-classification-v1";
const BROAD_VALIDATION_CACHE = "broad-root-validation-v1";
const BROAD_VALIDATION_SUBTREE_CACHE = "broad-subtree-validation-v1";

const CANONICAL_INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;
const FINITE_FLOAT_LEXICAL = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/u;
const CANONICAL_ENTITY_CODE_POINTS = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12,
  14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  38, 60, 62,
]);
const SUPPORTED_SCALAR_TYPES = new Set([
  "C", "N", "D", "T", "X", "P", "F", "I", "b", "s", "8",
  "a", "e", "p", "n", "w", "d", "7", "x", "t", "i", "c",
  "g", "y",
]);

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new RangeError(`${label} must be an integer in 0..${maximum}`);
  }
  return result;
}

function normalizeLimits(options: RecursiveXrfcLimits): NormalizedLimits {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("recursive xRFC options must be an object");
  }
  return Object.freeze({
    maxDepth: bounded(options.maxDepth, 64, 256, "maxDepth"),
    maxNodes: bounded(
      options.maxNodes,
      DEFAULT_RUNTIME_MAX_NODES,
      ABSOLUTE_RUNTIME_MAX_NODES,
      "maxNodes",
    ),
    maxRows: bounded(
      options.maxRows,
      DEFAULT_MAX_CPIC_FIELD_COUNT,
      0xffff_ffff,
      "maxRows",
    ),
    maxCells: bounded(
      options.maxCells,
      DEFAULT_MAX_CPIC_FIELD_COUNT,
      0xffff_ffff,
      "maxCells",
    ),
    maxCellBytes: bounded(
      options.maxCellBytes,
      DEFAULT_MAX_CPIC_FIELD_LENGTH,
      DEFAULT_MAX_CPIC_FIELD_LENGTH,
      "maxCellBytes",
    ),
    maxParameterBytes: bounded(
      options.maxParameterBytes,
      DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
      DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
      "maxParameterBytes",
    ),
  });
}

function declaredGraphLimit(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new RangeError(`recursive xRFC graph ${label} is outside 0..${maximum}`);
  }
  return value as number;
}

function graphTraversalBudget(graph: RecursiveMetadataGraph): GraphTraversalBudget {
  if (typeof graph !== "object" || graph === null || graph.version !== 1) {
    throw new TypeError("recursive xRFC graph must be a version-1 metadata graph");
  }
  const limits = graph.limits;
  if (typeof limits !== "object" || limits === null) {
    throw new TypeError("recursive xRFC graph lacks bounded metadata limits");
  }
  const maxNodes = declaredGraphLimit(
    limits.maxNodes,
    ABSOLUTE_GRAPH_MAX_NODES,
    "maxNodes",
  );
  const maxRows = declaredGraphLimit(
    limits.maxRows,
    ABSOLUTE_GRAPH_MAX_ROWS,
    "maxRows",
  );
  const maxEdges = declaredGraphLimit(
    limits.maxEdges,
    ABSOLUTE_GRAPH_MAX_EDGES,
    "maxEdges",
  );
  if (
    typeof graph.nodes !== "object" ||
    graph.nodes === null ||
    typeof graph.nodes.get !== "function" ||
    !Number.isSafeInteger(graph.nodes.size) ||
    graph.nodes.size < 0 ||
    graph.nodes.size > maxNodes
  ) {
    throw new RangeError(`recursive xRFC graph exceeds its node budget ${maxNodes}`);
  }
  if (!Array.isArray(graph.parameters) || graph.parameters.length > maxRows) {
    throw new RangeError(`recursive xRFC graph exceeds its row budget ${maxRows}`);
  }
  return { maxNodes, maxRows, maxEdges, nodes: 0, rows: 0, edges: 0 };
}

function consumeGraphNode(
  node: RecursiveMetadataTypeNode,
  budget: GraphTraversalBudget,
  path: string,
): void {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    throw new RangeError(`${path} exceeds recursive xRFC graph node budget ${budget.maxNodes}`);
  }
  if (!Array.isArray(node.fields)) {
    throw new TypeError(`${path} recursive xRFC node fields must be an array`);
  }
  budget.rows += node.fields.length;
  if (!Number.isSafeInteger(budget.rows) || budget.rows > budget.maxRows) {
    throw new RangeError(`${path} exceeds recursive xRFC graph row budget ${budget.maxRows}`);
  }
}

function consumeGraphEdge(
  budget: GraphTraversalBudget,
  path: string,
): void {
  budget.edges += 1;
  if (budget.edges > budget.maxEdges) {
    throw new RangeError(`${path} exceeds recursive xRFC graph edge budget ${budget.maxEdges}`);
  }
}

function requiredNode(
  graph: RecursiveMetadataGraph,
  name: string,
  kind: RecursiveMetadataTypeNode["kind"],
  path: string,
): RecursiveMetadataTypeNode {
  const node = graph.nodes.get(name);
  if (node === undefined || node.kind !== kind) {
    throw new Error(`${path} requires recursive ${kind} node ${name}`);
  }
  if (node.name !== name) {
    throw new Error(
      `${path} recursive ${kind} node identity ${node.name} disagrees with map key ${name}`,
    );
  }
  return node;
}

function targetNode(
  graph: RecursiveMetadataGraph,
  reference: Exclude<RecursiveMetadataReference, { kind: "scalar" }>,
  path: string,
): RecursiveMetadataTypeNode {
  if (reference.cyclic) {
    throw new Error(`${path} contains a cyclic recursive RFC type`);
  }
  return requiredNode(graph, reference.targetType, reference.kind, path);
}

function matchingParameter(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
): RecursiveMetadataParameter | undefined {
  const identity = graph.functionIdentity;
  if (identity === undefined) {
    throw new Error("recursive xRFC metadata lacks a function identity");
  }
  let match: RecursiveMetadataParameter | undefined;
  for (const candidate of graph.parameters) {
    if (candidate.name !== parameter.parameterName) continue;
    if (match !== undefined) {
      throw new Error(
        `${identity.name}.${parameter.parameterName} has duplicate recursive metadata`,
      );
    }
    match = candidate;
  }
  return validateMatchingParameter(graph, parameter, match);
}

function matchingParameterFromIndex(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  parameter: RfcFunintParameter,
): RecursiveMetadataParameter | undefined {
  return validateMatchingParameter(
    graph,
    parameter,
    recursiveMetadataParameterFromIndex(
      graph,
      index,
      parameter.parameterName,
    ),
  );
}

function validateMatchingParameter(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
  match: RecursiveMetadataParameter | undefined,
): RecursiveMetadataParameter | undefined {
  const identity = graph.functionIdentity;
  if (identity === undefined) {
    throw new Error("recursive xRFC metadata lacks a function identity");
  }
  if (match === undefined) return undefined;
  if (
    match.functionName !== identity.name ||
    match.parameterClass !== parameter.parameterClass ||
    match.internalType !== parameter.exid
  ) {
    throw new Error(
      `${identity.name}.${parameter.parameterName} recursive metadata disagrees with the function interface`,
    );
  }
  if (
    (match.reference.kind === "structure" || match.reference.kind === "table") &&
    parameter.tableName.length > 0 &&
    match.associatedType !== parameter.tableName
  ) {
    throw new Error(
      `${identity.name}.${parameter.parameterName} recursive type identity disagrees with the function interface`,
    );
  }
  return match;
}

function resolvedParameter(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
  recursive: RecursiveMetadataParameter,
  kind: RecursiveXrfcKind,
  node: RecursiveMetadataTypeNode,
  index?: RecursiveMetadataParameterIndex,
): ResolvedRecursiveXrfcParameter {
  const resolved = Object.freeze({ parameter: recursive, kind, node });
  RESOLVED_PARAMETER_STATE.set(
    resolved,
    Object.freeze({ graph, parameter, index }),
  );
  return resolved;
}

function assertResolvedParameterBinding(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
  resolved: ResolvedRecursiveXrfcParameter,
): ResolvedRecursiveXrfcParameterState {
  const state = RESOLVED_PARAMETER_STATE.get(resolved as object);
  if (
    state === undefined ||
    state.graph !== graph ||
    state.parameter !== parameter
  ) {
    throw new TypeError(
      "recursive xRFC plan must be resolved for the same graph and parameter",
    );
  }
  return state;
}

function nodeRequiresXrfc(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  budget: GraphTraversalBudget,
  index?: RecursiveMetadataParameterIndex,
): boolean {
  const cacheKey = `${node.kind}\u0000${node.name}`;
  if (index !== undefined) {
    const cached = recursiveMetadataParameterIndexCacheGet<boolean>(
      graph,
      index,
      BROAD_CLASSIFICATION_CACHE,
      cacheKey,
    );
    if (cached !== undefined) return cached;
  }
  consumeGraphNode(node, budget, node.name);
  recordRecursiveMetadataParameterIndexWork(
    graph,
    index,
    "broadClassificationNodeVisits",
  );
  for (const field of node.fields) {
    recordRecursiveMetadataParameterIndexWork(
      graph,
      index,
      "broadClassificationFieldVisits",
    );
    if (field.reference.kind === "scalar") {
      if (field.internalType === "g" || field.internalType === "y") {
        if (index !== undefined) {
          recursiveMetadataParameterIndexCacheSet(
            graph,
            index,
            BROAD_CLASSIFICATION_CACHE,
            cacheKey,
            true,
          );
        }
        return true;
      }
      continue;
    }
    const fieldPath = `${node.name}.${field.name}`;
    consumeGraphEdge(budget, fieldPath);
    // Any immediate container edge makes a classic `u` value recursive. Check
    // the target identity now, while the complete bounded validator owns the
    // deeper walk. This avoids an unbounded resolver recursion on hostile hand
    // graphs before maxDepth can be enforced.
    targetNode(graph, field.reference, fieldPath);
    if (index !== undefined) {
      recursiveMetadataParameterIndexCacheSet(
        graph,
        index,
        BROAD_CLASSIFICATION_CACHE,
        cacheKey,
        true,
      );
    }
    return true;
  }
  if (index !== undefined) {
    recursiveMetadataParameterIndexCacheSet(
      graph,
      index,
      BROAD_CLASSIFICATION_CACHE,
      cacheKey,
      false,
    );
  }
  return false;
}

/**
 * Resolve a function parameter only when the normalized graph requires xRFC.
 * Flat fixed structures and classic TABLES rows remain on the binary codec.
 */
export function resolveRecursiveXrfcParameter(
  graph: RecursiveMetadataGraph | undefined,
  parameter: RfcFunintParameter,
): ResolvedRecursiveXrfcParameter | undefined {
  if (
    graph === undefined ||
    (parameter.exid !== "u" && parameter.exid !== "v" && parameter.exid !== "h")
  ) {
    return undefined;
  }
  const traversalBudget = graphTraversalBudget(graph);
  // Classic structured TABLES rows (`T` + `u`) stay on the RFC table codec.
  // Explicit xRFC table descriptors (`h`) still require xRFC even when their
  // direction is TABLES; otherwise broader scalar-line tables are unreachable.
  if (parameter.parameterClass === "T" && parameter.exid === "u") {
    return undefined;
  }
  const recursive = matchingParameter(graph, parameter);
  return resolveRecursiveXrfcParameterWithMatch(
    graph,
    parameter,
    recursive,
    traversalBudget,
  );
}

/** Internal O(1)-lookup resolver used by one immutable invocation dispatch. */
export function resolveRecursiveXrfcParameterFromIndex(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  parameter: RfcFunintParameter,
): ResolvedRecursiveXrfcParameter | undefined {
  if (
    parameter.exid !== "u" &&
    parameter.exid !== "v" &&
    parameter.exid !== "h"
  ) {
    return undefined;
  }
  const traversalBudget = graphTraversalBudget(graph);
  if (parameter.parameterClass === "T" && parameter.exid === "u") {
    return undefined;
  }
  const recursive = matchingParameterFromIndex(graph, index, parameter);
  return resolveRecursiveXrfcParameterWithMatch(
    graph,
    parameter,
    recursive,
    traversalBudget,
    index,
  );
}

function resolveRecursiveXrfcParameterWithMatch(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
  recursive: RecursiveMetadataParameter | undefined,
  traversalBudget: GraphTraversalBudget,
  index?: RecursiveMetadataParameterIndex,
): ResolvedRecursiveXrfcParameter | undefined {
  if (
    recursive === undefined ||
    recursive.reference.kind === "scalar" ||
    recursive.reference.kind === "exception" ||
    !("targetType" in recursive.reference)
  ) {
    if (parameter.exid === "h") {
      throw new Error(`${parameter.parameterName} lacks its recursive table descriptor`);
    }
    return undefined;
  }
  const node = recursive.reference.kind === "table" &&
      parameter.parameterClass === "T"
    ? graph.nodes.get(recursive.reference.targetType)
    : targetNode(graph, recursive.reference, parameter.parameterName);
  if (
    node === undefined ||
    node.name !== recursive.reference.targetType ||
    (recursive.reference.kind === "table" &&
      parameter.parameterClass === "T" &&
      node.kind !== "table" &&
      node.kind !== "structure")
  ) {
    throw new Error(
      `${parameter.parameterName} requires recursive table row node ` +
        `${recursive.reference.targetType}`,
    );
  }
  const kind = recursive.reference.kind;
  const required = parameter.exid === "h" || parameter.exid === "v" ||
    nodeRequiresXrfc(
      graph,
      node,
      traversalBudget,
      index,
    );
  return required
    ? resolvedParameter(graph, parameter, recursive, kind, node, index)
    : undefined;
}

function validateNode(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  path: string,
  depth: number,
  maximumDepth: number,
  visiting: Set<string>,
  subtreeHeights: Map<string, number>,
  budget: GraphTraversalBudget,
  index?: RecursiveMetadataParameterIndex,
): number {
  if (depth > maximumDepth) {
    throw new RangeError(`${path} exceeds recursive xRFC depth ${maximumDepth}`);
  }
  const knownHeight = subtreeHeights.get(node.name);
  if (knownHeight !== undefined) {
    if (depth + knownHeight - 1 > maximumDepth) {
      throw new RangeError(`${path} exceeds recursive xRFC depth ${maximumDepth}`);
    }
    return knownHeight;
  }
  if (visiting.has(node.name)) {
    throw new Error(`${path} contains a cyclic recursive RFC type`);
  }
  const subtreeCacheKey = `${node.kind}\u0000${node.name}`;
  if (index !== undefined) {
    const cached = recursiveMetadataParameterIndexCacheGet<
      CachedBroadValidationSubtree
    >(graph, index, BROAD_VALIDATION_SUBTREE_CACHE, subtreeCacheKey);
    if (cached !== undefined) {
      if (depth + cached.height - 1 > maximumDepth) {
        throw new RangeError(
          `${path} exceeds recursive xRFC depth ${maximumDepth}`,
        );
      }
      subtreeHeights.set(node.name, cached.height);
      return cached.height;
    }
  }
  consumeGraphNode(node, budget, path);
  recordRecursiveMetadataParameterIndexWork(
    graph,
    index,
    "broadValidationNodeVisits",
  );
  if (node.kind === "scalar") {
    if (node.fields.length !== 1 || node.fields[0]!.name !== "") {
      throw new Error(`${path} scalar type has an invalid anonymous descriptor`);
    }
  } else if (node.kind === "table") {
    const anonymous = node.fields.length === 1 && node.fields[0]!.name === "";
    const named = node.fields.length > 0 && node.fields.every((field) => field.name !== "");
    if (!anonymous && !named) {
      throw new Error(`${path} table type has an invalid line descriptor`);
    }
  } else if (node.fields.some((field) => field.name === "")) {
    throw new Error(`${path} structure contains an anonymous field`);
  }
  visiting.add(node.name);
  let subtreeHeight = 1;
  try {
    const names = new Set<string>();
    for (const field of node.fields) {
      recordRecursiveMetadataParameterIndexWork(
        graph,
        index,
        "broadValidationFieldVisits",
      );
      if (names.has(field.name)) throw new Error(`${path} contains duplicate field ${field.name}`);
      names.add(field.name);
      if (field.name.length > 0) escapeRecursiveXrfcTag(field.name);
      const fieldPath = field.name.length === 0 ? `${path}.item` : `${path}.${field.name}`;
      if (field.reference.kind === "scalar") {
        if (
          field.reference.internalType !== field.internalType ||
          !SUPPORTED_SCALAR_TYPES.has(field.internalType)
        ) {
          throw new Error(`${fieldPath} xRFC scalar type ${field.internalType} is not implemented`);
        }
        if (["C", "N", "D", "T"].includes(field.internalType) && (field.ucLength & 1) !== 0) {
          throw new Error(`${fieldPath} Unicode character width must be even`);
        }
        continue;
      }
      if (node.kind === "scalar") {
        throw new Error(`${fieldPath} scalar node contains a container reference`);
      }
      if (
        field.reference.kind === "structure" &&
        field.internalType !== "u" &&
        field.internalType !== "v"
      ) {
        throw new Error(`${fieldPath} contains inconsistent structure metadata`);
      }
      if (field.reference.kind === "table" && field.internalType !== "h") {
        throw new Error(`${fieldPath} contains inconsistent table metadata`);
      }
      consumeGraphEdge(budget, fieldPath);
      const target = targetNode(graph, field.reference, fieldPath);
      const childHeight = validateNode(
        graph,
        target,
        fieldPath,
        depth + 1,
        maximumDepth,
        visiting,
        subtreeHeights,
        budget,
        index,
      );
      subtreeHeight = Math.max(subtreeHeight, 1 + childHeight);
    }
  } finally {
    visiting.delete(node.name);
  }
  subtreeHeights.set(node.name, subtreeHeight);
  if (index !== undefined) {
    recursiveMetadataParameterIndexCacheSet(
      graph,
      index,
      BROAD_VALIDATION_SUBTREE_CACHE,
      subtreeCacheKey,
      Object.freeze({ height: subtreeHeight }),
    );
  }
  return subtreeHeight;
}

function validateRecursiveXrfcParameterAtDepth(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
  maximumDepth: number,
  resolvedParameterPlan?: ResolvedRecursiveXrfcParameter,
): ResolvedRecursiveXrfcParameter {
  const resolved = resolvedParameterPlan ??
    resolveRecursiveXrfcParameter(graph, parameter);
  if (resolved === undefined) {
    throw new Error(`${parameter.parameterName} does not require recursive xRFC`);
  }
  const resolvedState = assertResolvedParameterBinding(
    graph,
    parameter,
    resolved,
  );
  escapeRecursiveXrfcTag(parameter.parameterName);
  const validationCacheKey =
    `${resolved.kind}\u0000${resolved.node.name}\u0000${maximumDepth}`;
  if (
    resolvedState.index !== undefined &&
    recursiveMetadataParameterIndexCacheGet<boolean>(
      graph,
      resolvedState.index,
      BROAD_VALIDATION_CACHE,
      validationCacheKey,
    ) === true
  ) {
    return resolved;
  }
  const traversalBudget = graphTraversalBudget(graph);
  validateNode(
    graph,
    resolved.node,
    parameter.parameterName,
    1,
    maximumDepth,
    new Set(),
    new Map(),
    traversalBudget,
    resolvedState.index,
  );
  if (resolvedState.index !== undefined) {
    recursiveMetadataParameterIndexCacheSet(
      graph,
      resolvedState.index,
      BROAD_VALIDATION_CACHE,
      validationCacheKey,
      true,
    );
  }
  return resolved;
}

/** Validate the complete reachable serializer graph without reading a value. */
export function validateRecursiveXrfcParameter(
  graph: RecursiveMetadataGraph,
  parameter: RfcFunintParameter,
  options: Pick<RecursiveXrfcLimits, "maxDepth"> = {},
): ResolvedRecursiveXrfcParameter {
  return validateRecursiveXrfcParameterAtDepth(
    graph,
    parameter,
    bounded(options.maxDepth, 64, 256, "maxDepth"),
  );
}

/** Resolve and fully validate through one invocation-scoped parameter index. */
export function validateRecursiveXrfcParameterFromIndex(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  parameter: RfcFunintParameter,
  options: Pick<RecursiveXrfcLimits, "maxDepth"> = {},
): ResolvedRecursiveXrfcParameter {
  const maximumDepth = bounded(options.maxDepth, 64, 256, "maxDepth");
  const resolved = resolveRecursiveXrfcParameterFromIndex(
    graph,
    index,
    parameter,
  );
  if (resolved === undefined) {
    throw new Error(`${parameter.parameterName} does not require recursive xRFC`);
  }
  return validateRecursiveXrfcParameterAtDepth(
    graph,
    parameter,
    maximumDepth,
    resolved,
  );
}

function assertDepth(depth: number, state: EncodeState, path: string): void {
  if (depth > state.limits.maxDepth) {
    throw new RangeError(`${path} exceeds recursive xRFC depth ${state.limits.maxDepth}`);
  }
}

function visitEncodeContainer(state: EncodeState, path: string): void {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new RangeError(
      `${path} exceeds recursive xRFC runtime node count ${state.limits.maxNodes}`,
    );
  }
}

function emit(state: EncodeState, value: string | Buffer, path: string): void {
  const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const total = state.bytes + chunk.byteLength;
  if (!Number.isSafeInteger(total) || total > state.limits.maxParameterBytes) {
    throw new RangeError(
      `${path} recursive xRFC XML exceeds ${state.limits.maxParameterBytes} bytes`,
    );
  }
  state.bytes = total;
  state.chunks.push(chunk);
}

/** Escape the reversible tag grammar used by xRFC for ABAP namespace names. */
export function escapeRecursiveXrfcTag(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("xRFC tag name must be a non-empty string");
  }
  assertUnicodeScalarText(name, "xRFC tag name");
  let result = "";
  let index = 0;
  for (const character of name) {
    const codePoint = character.codePointAt(0)!;
    const valid = index === 0
      ? /[A-Za-z_]/u.test(character) || codePoint > 0xff
      : /[A-Za-z0-9_]/u.test(character) || codePoint > 0xff;
    if (valid) result += character;
    else if (character === "/") result += "_-";
    else if (codePoint <= 0xff) result += `_--${codePoint.toString(16).toUpperCase().padStart(2, "0")}`;
    else throw new Error("xRFC tag name contains an unsupported character");
    index += 1;
  }
  return result;
}

function unescapeRecursiveXrfcTag(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "_") {
      result += value[index]!;
      index += 1;
      continue;
    }
    if (value[index + 1] !== "-") {
      result += "_";
      index += 1;
      continue;
    }
    if (value[index + 2] !== "-") {
      result += "/";
      index += 2;
      continue;
    }
    const hex = value.slice(index + 3, index + 5);
    if (!/^[0-9A-F]{2}$/u.test(hex)) {
      throw new Error("xRFC XML parameter contains an invalid tag escape");
    }
    result += String.fromCharCode(Number.parseInt(hex, 16));
    index += 5;
  }
  assertUnicodeScalarText(result, "xRFC tag name");
  if (escapeRecursiveXrfcTag(result) !== value) {
    throw new Error("xRFC XML parameter contains a non-canonical tag escape");
  }
  return result;
}

/** Read the canonical root parameter name, including escaped ABAP namespaces. */
export function decodeRecursiveXrfcParameterName(
  value: Uint8Array,
  limits: Pick<RecursiveXrfcLimits, "maxParameterBytes"> = {},
): string {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("recursive xRFC XML must be Uint8Array bytes");
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  const maximum = bounded(
    limits.maxParameterBytes,
    DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
    DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
    "maxParameterBytes",
  );
  if (byteLength === 0 || byteLength > maximum) {
    throw new RangeError(`recursive xRFC XML must contain 1..${maximum} bytes`);
  }
  const encoded = snapshotUint8Array(
    value,
    "recursive xRFC XML",
    byteLength,
  );
  if (
    encoded.byteLength >= 3 &&
    encoded[0] === 0xef &&
    encoded[1] === 0xbb &&
    encoded[2] === 0xbf
  ) {
    throw new Error("recursive xRFC XML must not contain a UTF-8 BOM");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  if (!text.startsWith("<")) {
    throw new Error("recursive xRFC XML lacks its top-level tag");
  }
  const end = text.indexOf(">");
  if (end < 2 || end > 256 || text.slice(1, end).includes("<")) {
    throw new Error("recursive xRFC XML lacks a supported top-level tag");
  }
  return unescapeRecursiveXrfcTag(text.slice(1, end));
}

function openTag(state: EncodeState, name: string, path: string): void {
  emit(state, `<${escapeRecursiveXrfcTag(name)}>`, path);
}

function closeTag(state: EncodeState, name: string, path: string): void {
  emit(state, `</${escapeRecursiveXrfcTag(name)}>`, path);
}

function escapedText(
  value: string,
  path: string,
  maximumBytes: number,
): Buffer {
  assertUnicodeScalarText(value, path);
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0xfffe || codePoint === 0xffff) {
      throw new RangeError(`${path} contains an unsupported non-character`);
    }
    let chunk: string;
    if (CANONICAL_ENTITY_CODE_POINTS.has(codePoint)) {
      chunk = `&#${String(codePoint).padStart(2, "0")};`;
    }
    else chunk = character;
    bytes += Buffer.byteLength(chunk, "utf8");
    if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
      throw new RangeError(`${path} XML value exceeds ${maximumBytes} bytes`);
    }
  }
  const result = Buffer.allocUnsafe(bytes);
  let offset = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const chunk = CANONICAL_ENTITY_CODE_POINTS.has(codePoint)
      ? `&#${String(codePoint).padStart(2, "0")};`
      : character;
    offset += result.write(chunk, offset, "utf8");
  }
  if (offset !== bytes) {
    throw new Error(`${path} xRFC text encoding length changed`);
  }
  return result;
}

function base64EncodedLength(byteLength: number, path: string): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`${path} byte length is unsafe`);
  }
  const groups = Math.ceil(byteLength / 3);
  const encoded = groups * 4;
  if (!Number.isSafeInteger(encoded)) {
    throw new RangeError(`${path} base64 length is unsafe`);
  }
  return encoded;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${path} expects an integer in ${minimum}..${maximum}`);
  }
  return String(value);
}

function characterCapacity(field: RecursiveMetadataField, path: string): number {
  if ((field.ucLength & 1) !== 0) {
    throw new Error(`${path} Unicode character width must be even`);
  }
  return field.ucLength / 2;
}

function fixedBytes(value: unknown, length: number, path: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${path} expects Uint8Array bytes`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength > length) {
    throw new RangeError(`${path} accepts at most ${length} bytes`);
  }
  const result = Buffer.alloc(length);
  snapshotUint8Array(value, path, byteLength).copy(result);
  return result;
}

function temporalRaw(
  field: RecursiveMetadataField,
  value: unknown,
  path: string,
): string {
  if (!isClassicTemporalExid(field.internalType)) {
    throw new Error(`${path} is not a compact temporal value`);
  }
  const encoded = encodeClassicTemporal(field.internalType, value as string, path);
  let raw = 0n;
  for (let index = encoded.byteLength - 1; index >= 0; index -= 1) {
    raw = (raw << 8n) | BigInt(encoded[index]!);
  }
  return raw.toString();
}

function scalarText(
  field: RecursiveMetadataField,
  value: unknown,
  int8Mode: ClassicInt8Mode,
  path: string,
  maximumBytes: number,
): string {
  if (!SUPPORTED_SCALAR_TYPES.has(field.internalType)) {
    throw new Error(`${path} xRFC scalar type ${field.internalType} is not implemented`);
  }
  switch (field.internalType) {
    case "C":
    case "N": {
      if (typeof value !== "string") throw new TypeError(`${path} expects a string`);
      assertUnicodeScalarText(value, path);
      const capacity = characterCapacity(field, path);
      if (value.length > capacity) {
        throw new RangeError(`${path} does not fit ${field.internalType}(${capacity})`);
      }
      if (field.internalType === "N") {
        if (!/^\d*$/u.test(value)) {
          throw new TypeError(`${path} expects at most ${capacity} decimal digits`);
        }
        if (capacity > maximumBytes) {
          throw new RangeError(`${path} XML value exceeds ${maximumBytes} bytes`);
        }
        return value.padStart(capacity, "0");
      }
      return value;
    }
    case "D": {
      assertClassicDate(value as string, path);
      const date = value as string;
      return date === "" || date === "        "
        ? ""
        : date.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");
    }
    case "T": {
      assertClassicTime(value as string, path);
      const time = value as string;
      return time === "" || time === "      "
        ? ""
        : time.replace(/^(\d{2})(\d{2})(\d{2})$/u, "$1:$2:$3");
    }
    case "X": {
      if (base64EncodedLength(field.ucLength, path) > maximumBytes) {
        throw new RangeError(`${path} XML value exceeds ${maximumBytes} bytes`);
      }
      return fixedBytes(value, field.ucLength, path).toString("base64");
    }
    case "P":
      return decodePackedDecimal(
        encodePackedDecimal(value as never, field.ucLength, field.decimals, path),
        field.decimals,
        path,
      );
    case "F":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${path} expects a finite number`);
      }
      return Object.is(value, -0) ? "-0" : String(value);
    case "I": return integer(value, -0x8000_0000, 0x7fff_ffff, path);
    case "s": return integer(value, -0x8000, 0x7fff, path);
    case "b": return integer(value, 0, 0xff, path);
    case "8": return encodeClassicInt8(value, int8Mode, path).toString();
    case "a":
      return decodeDecimalFloat16(encodeDecimalFloat16(value as never, path), path);
    case "e":
      return decodeDecimalFloat34(encodeDecimalFloat34(value as never, path), path);
    case "g":
      if (typeof value !== "string") throw new TypeError(`${path} expects Unicode text`);
      assertUnicodeScalarText(value, path);
      return value;
    case "y": {
      if (!(value instanceof Uint8Array)) throw new TypeError(`${path} expects Uint8Array bytes`);
      const byteLength = intrinsicUint8ArrayByteLength(value);
      if (base64EncodedLength(byteLength, path) > maximumBytes) {
        throw new RangeError(`${path} XML value exceeds ${maximumBytes} bytes`);
      }
      return snapshotUint8Array(value, path, byteLength).toString("base64");
    }
    default:
      return temporalRaw(field, value, path);
  }
}

function initialScalar(
  field: RecursiveMetadataField,
  int8Mode: ClassicInt8Mode,
): unknown {
  if (isClassicTemporalExid(field.internalType)) {
    return classicTemporalInitialValue(field.internalType);
  }
  switch (field.internalType) {
    case "C":
    case "N":
    case "g": return "";
    case "D": return "00000000";
    case "T": return "000000";
    // fixedBytes performs the bounded zero-padding after base64 preflight.
    case "X": return Buffer.alloc(0);
    case "P": return "0";
    case "F":
    case "I":
    case "s":
    case "b": return 0;
    case "8": return classicInt8InitialValue(int8Mode);
    case "a":
    case "e": return "0";
    case "y": return Buffer.alloc(0);
    default:
      throw new Error(`unsupported recursive xRFC scalar type ${field.internalType}`);
  }
}

interface OwnDataRecord {
  readonly value: Readonly<Record<string, unknown>>;
  readonly keys: readonly string[];
}

function ownRecord(value: unknown, path: string): OwnDataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} expects a structure object`);
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError(`${path} structure must not be a proxy`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} structure must use Object.prototype or a null prototype`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} structure must not contain symbol properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
    keys.push(key);
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return Object.freeze({
    value: Object.freeze(snapshot) as Readonly<Record<string, unknown>>,
    keys: Object.freeze(keys),
  });
}

function encodeScalar(
  field: RecursiveMetadataField,
  value: unknown,
  state: EncodeState,
  path: string,
): void {
  state.cells += 1;
  if (state.cells > state.limits.maxCells) {
    throw new RangeError(`${path} exceeds recursive xRFC cell count ${state.limits.maxCells}`);
  }
  const maximumBytes = Math.min(
    state.limits.maxCellBytes,
    Math.max(0, state.limits.maxParameterBytes - state.bytes),
  );
  const lexical = scalarText(
    field,
    value,
    state.int8Mode,
    path,
    maximumBytes,
  );
  emit(state, escapedText(lexical, path, maximumBytes), path);
}

function encodeReference(
  field: RecursiveMetadataField,
  value: unknown,
  state: EncodeState,
  depth: number,
  path: string,
): void {
  if (field.reference.kind === "scalar") {
    encodeScalar(field, value, state, path);
    return;
  }
  assertDepth(depth, state, path);
  const node = targetNode(state.graph, field.reference, path);
  if (node.kind === "structure") encodeStructure(node, value, state, depth, path);
  else encodeTable(node, value, state, depth, path);
}

function encodeStructure(
  node: RecursiveMetadataTypeNode,
  value: unknown,
  state: EncodeState,
  depth: number,
  path: string,
): void {
  assertDepth(depth, state, path);
  visitEncodeContainer(state, path);
  const record = ownRecord(value, path);
  const known = new Set(node.fields.map((field) => field.name));
  for (const key of record.keys) {
    if (!known.has(key)) throw new Error(`${path} contains unknown field ${key}`);
  }
  for (const field of node.fields) {
    if (field.name.length === 0) {
      throw new Error(`${path} structure contains an anonymous field`);
    }
    const fieldPath = `${path}.${field.name}`;
    let fieldValue: unknown;
    if (Object.prototype.hasOwnProperty.call(record.value, field.name)) {
      fieldValue = record.value[field.name];
    } else if (field.reference.kind === "scalar") {
      fieldValue = initialScalar(field, state.int8Mode);
    } else {
      fieldValue = field.reference.kind === "table" ? [] : {};
    }
    openTag(state, field.name, fieldPath);
    encodeReference(field, fieldValue, state, depth + 1, fieldPath);
    closeTag(state, field.name, fieldPath);
  }
}

function encodeTableLine(
  node: RecursiveMetadataTypeNode,
  row: unknown,
  state: EncodeState,
  depth: number,
  path: string,
): void {
  if (node.fields.length === 1 && node.fields[0]!.name.length === 0) {
    const field = node.fields[0]!;
    let value = row;
    if (
      field.reference.kind === "scalar" &&
      typeof row === "object" && row !== null &&
      nodeUtilTypes.isProxy(row)
    ) {
      throw new TypeError(`${path} scalar table row must not be a proxy`);
    }
    if (
      field.reference.kind === "scalar" &&
      typeof row === "object" && row !== null && !Array.isArray(row) &&
      Object.prototype.hasOwnProperty.call(row, "")
    ) {
      const wrapper = ownRecord(row, path);
      if (wrapper.keys.length !== 1 || wrapper.keys[0] !== "") {
        throw new TypeError(`${path} scalar table wrapper must contain only the empty-name field`);
      }
      value = wrapper.value[""];
    }
    encodeReference(field, value, state, depth + 1, path);
    return;
  }
  encodeStructure(node, row, state, depth, path);
}

function encodeTable(
  node: RecursiveMetadataTypeNode,
  value: unknown,
  state: EncodeState,
  depth: number,
  path: string,
): void {
  assertDepth(depth, state, path);
  visitEncodeContainer(state, path);
  if (!Array.isArray(value)) throw new TypeError(`${path} expects an array of rows`);
  for (let index = 0; index < value.length; index += 1) {
    state.rows += 1;
    if (state.rows > state.limits.maxRows) {
      throw new RangeError(`${path} exceeds recursive xRFC row count ${state.limits.maxRows}`);
    }
    const rowPath = `${path}[${index}]`;
    openTag(state, "item", rowPath);
    encodeTableLine(node, value[index], state, depth, rowPath);
    closeTag(state, "item", rowPath);
  }
}

/** Encode one graph-backed recursive xRFC parameter with bounded allocations. */
export function encodeRecursiveXrfcParameter(
  parameter: RfcFunintParameter,
  graph: RecursiveMetadataGraph,
  value: unknown,
  options: RecursiveXrfcOptions = {},
): Buffer {
  const limits = normalizeLimits(options);
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  snapshotClassicBcdMode(options.bcd);
  const resolved = validateRecursiveXrfcParameterAtDepth(
    graph,
    parameter,
    limits.maxDepth,
  );
  return encodeResolvedRecursiveXrfcParameterWithOptions(
    parameter,
    graph,
    resolved,
    value,
    limits,
    int8Mode,
  );
}

/** Encode from an invocation-scoped plan without rescanning graph parameters. */
export function encodeResolvedRecursiveXrfcParameter(
  parameter: RfcFunintParameter,
  graph: RecursiveMetadataGraph,
  resolved: ResolvedRecursiveXrfcParameter,
  value: unknown,
  options: RecursiveXrfcOptions = {},
): Buffer {
  const limits = normalizeLimits(options);
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  snapshotClassicBcdMode(options.bcd);
  validateRecursiveXrfcParameterAtDepth(
    graph,
    parameter,
    limits.maxDepth,
    resolved,
  );
  return encodeResolvedRecursiveXrfcParameterWithOptions(
    parameter,
    graph,
    resolved,
    value,
    limits,
    int8Mode,
  );
}

function encodeResolvedRecursiveXrfcParameterWithOptions(
  parameter: RfcFunintParameter,
  graph: RecursiveMetadataGraph,
  resolved: ResolvedRecursiveXrfcParameter,
  value: unknown,
  limits: NormalizedLimits,
  int8Mode: ClassicInt8Mode,
): Buffer {
  if (graph.functionIdentity?.name === undefined) {
    throw new Error("recursive xRFC graph lacks its function identity");
  }
  const state: EncodeState = {
    graph,
    limits,
    int8Mode,
    chunks: [],
    bytes: 0,
    nodes: 0,
    rows: 0,
    cells: 0,
  };
  openTag(state, parameter.parameterName, parameter.parameterName);
  if (resolved.kind === "structure") {
    encodeStructure(resolved.node, value, state, 1, parameter.parameterName);
  } else {
    encodeTable(resolved.node, value, state, 1, parameter.parameterName);
  }
  closeTag(state, parameter.parameterName, parameter.parameterName);
  return Buffer.concat(state.chunks, state.bytes);
}

function decodeEntities(raw: string, path: string): string {
  // XML forbids ">" in character data only as the "]]>" sequence, so a
  // conforming producer may send it bare. Everything else refused here is a
  // character no conforming producer can put in character data at all.
  if (raw.includes("]]>")) {
    throw new Error(`${path} contains non-canonical raw xRFC text`);
  }
  for (const character of raw) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0xfffe ||
      codePoint === 0xffff ||
      (codePoint < 0x20 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13)
    ) {
      throw new Error(`${path} contains non-canonical raw xRFC text`);
    }
  }
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
    // The recursive canonical form transports C0 controls as references by
    // design, so those stay admissible in reference position even though they
    // are refused raw. The two non-characters our writer refuses outright do
    // not become admissible by being escaped.
    if (codePoint === 0xfffe || codePoint === 0xffff) {
      throw new Error(`${path} contains an out-of-range XML entity`);
    }
    result += String.fromCodePoint(codePoint);
    offset = ampersand + length;
  }
  assertUnicodeScalarText(result, path);
  return result;
}

class Parser {
  readonly #text: string;
  readonly #limits: NormalizedLimits;
  #offset = 0;
  nodes = 0;
  rows = 0;
  cells = 0;
  projectedBytes = 0;

  constructor(text: string, limits: NormalizedLimits) {
    this.#text = text;
    this.#limits = limits;
  }

  starts(name: string, closing = false): boolean {
    const escaped = escapeRecursiveXrfcTag(name);
    return this.#text.startsWith(closing ? `</${escaped}>` : `<${escaped}>`, this.#offset);
  }

  open(name: string, path: string): void {
    const token = `<${escapeRecursiveXrfcTag(name)}>`;
    if (!this.#text.startsWith(token, this.#offset)) {
      throw new Error(`${path} expected ${token} at character ${this.#offset}`);
    }
    this.#offset += token.length;
  }

  close(name: string, path: string): void {
    const token = `</${escapeRecursiveXrfcTag(name)}>`;
    if (!this.#text.startsWith(token, this.#offset)) {
      throw new Error(`${path} expected ${token} at character ${this.#offset}`);
    }
    this.#offset += token.length;
  }

  cell(path: string): string {
    this.cells += 1;
    if (this.cells > this.#limits.maxCells) {
      throw new RangeError(`${path} exceeds recursive xRFC cell count ${this.#limits.maxCells}`);
    }
    const end = this.#text.indexOf("<", this.#offset);
    if (end < 0) throw new Error(`${path} recursive xRFC XML is truncated`);
    const raw = this.#text.slice(this.#offset, end);
    if (Buffer.byteLength(raw, "utf8") > this.#limits.maxCellBytes) {
      throw new RangeError(`${path} XML value exceeds ${this.#limits.maxCellBytes} bytes`);
    }
    this.#offset = end;
    return decodeEntities(raw, path);
  }

  node(path: string): void {
    this.nodes += 1;
    if (this.nodes > this.#limits.maxNodes) {
      throw new RangeError(
        `${path} exceeds recursive xRFC runtime node count ${this.#limits.maxNodes}`,
      );
    }
  }

  row(path: string): void {
    this.rows += 1;
    if (this.rows > this.#limits.maxRows) {
      throw new RangeError(`${path} exceeds recursive xRFC row count ${this.#limits.maxRows}`);
    }
  }

  decodedValue(byteLength: number, path: string): void {
    const projected = this.projectedBytes + byteLength;
    if (!Number.isSafeInteger(projected)) {
      throw new RangeError(`${path} decoded output byte length is unsafe`);
    }
    if (projected > this.#limits.maxParameterBytes) {
      throw new RangeError(
        `${path} decoded output exceeds the ${this.#limits.maxParameterBytes}-byte parameter limit`,
      );
    }
    this.projectedBytes = projected;
  }

  finish(): void {
    if (this.#offset !== this.#text.length) {
      throw new Error(`recursive xRFC XML has trailing content at character ${this.#offset}`);
    }
  }
}

function canonicalBase64(value: string, path: string, maximum: number): Buffer {
  canonicalBase64DecodedByteLength(value, path, maximum);
  if (value.length === 0) return Buffer.alloc(0);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${path} contains non-canonical base64`);
  }
  return decoded;
}

function canonicalBase64DecodedByteLength(
  value: string,
  path: string,
  maximum: number,
): number {
  if (
    value.length > maximum ||
    (value.length & 3) !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error(`${path} contains non-canonical base64`);
  }
  return (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

function parseCanonicalBigInt(value: string, path: string): bigint {
  if (!CANONICAL_INTEGER.test(value) || value.length > 20) {
    throw new Error(`${path} contains a non-canonical integer`);
  }
  return BigInt(value);
}

function rawTemporal(
  field: RecursiveMetadataField,
  text: string,
  path: string,
): string {
  if (!isClassicTemporalExid(field.internalType)) {
    throw new Error(`${path} is not a compact temporal value`);
  }
  const width = classicTemporalByteLength(field.internalType);
  let raw = parseCanonicalBigInt(text, path);
  if (raw < 0n || raw >= (1n << BigInt(width * 8))) {
    throw new RangeError(`${path} compact temporal raw value is out of range`);
  }
  const bytes = Buffer.alloc(width);
  for (let index = 0; index < width; index += 1) {
    bytes[index] = Number(raw & 0xffn);
    raw >>= 8n;
  }
  return decodeClassicTemporal(field.internalType, bytes, path);
}

function assertDecodedValueBytes(
  byteLength: number,
  limits: NormalizedLimits,
  path: string,
): void {
  if (byteLength > limits.maxCellBytes) {
    throw new RangeError(
      `${path} decoded value exceeds the ${limits.maxCellBytes}-byte cell limit`,
    );
  }
  if (byteLength > limits.maxParameterBytes) {
    throw new RangeError(
      `${path} decoded value exceeds the ${limits.maxParameterBytes}-byte parameter limit`,
    );
  }
}

function decodedScalar(
  field: RecursiveMetadataField,
  text: string,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  limits: NormalizedLimits,
  parser: Parser,
  path: string,
): unknown {
  switch (field.internalType) {
    case "C":
    case "N": {
      const capacity = characterCapacity(field, path);
      if (field.internalType === "N") {
        assertDecodedValueBytes(capacity, limits, path);
        parser.decodedValue(capacity, path);
      }
      if (text.length > capacity) throw new RangeError(`${path} exceeds ${capacity} characters`);
      if (field.internalType === "N") {
        if (!/^\d*$/u.test(text)) {
          throw new Error(`${path} contains a non-decimal NUM value`);
        }
        return text.padStart(capacity, "0");
      }
      return text;
    }
    case "D": {
      if (text.length === 0) return "";
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
        throw new Error(`${path} contains a non-canonical xRFC DATE`);
      }
      const value = text.replaceAll("-", "");
      assertClassicDate(value, path);
      return value;
    }
    case "T": {
      if (text.length === 0) return "";
      if (!/^\d{2}:\d{2}:\d{2}$/u.test(text)) {
        throw new Error(`${path} contains a non-canonical xRFC TIME`);
      }
      const value = text.replaceAll(":", "");
      assertClassicTime(value, path);
      return value;
    }
    case "X": {
      assertDecodedValueBytes(field.ucLength, limits, path);
      parser.decodedValue(field.ucLength, path);
      const value = canonicalBase64(text, path, limits.maxCellBytes);
      if (value.byteLength > field.ucLength) {
        throw new RangeError(`${path} accepts at most ${field.ucLength} bytes`);
      }
      const padded = Buffer.alloc(field.ucLength);
      value.copy(padded);
      return padded;
    }
    case "P":
      return projectClassicBcdOutput(
        decodePackedDecimal(
          encodePackedDecimal(text, field.ucLength, field.decimals, path),
          field.decimals,
          path,
        ),
        bcd,
        path,
      );
    case "F": {
      if (!FINITE_FLOAT_LEXICAL.test(text)) {
        throw new Error(`${path} contains an invalid FLOAT`);
      }
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new Error(`${path} contains an invalid FLOAT`);
      }
      return value;
    }
    case "I": {
      const value = parseCanonicalBigInt(text, path);
      if (value < -0x8000_0000n || value > 0x7fff_ffffn) throw new RangeError(`${path} INT4 is out of range`);
      return Number(value);
    }
    case "s": {
      const value = parseCanonicalBigInt(text, path);
      if (value < -0x8000n || value > 0x7fffn) throw new RangeError(`${path} INT2 is out of range`);
      return Number(value);
    }
    case "b": {
      const value = parseCanonicalBigInt(text, path);
      if (value < 0n || value > 0xffn) throw new RangeError(`${path} INT1 is out of range`);
      return Number(value);
    }
    case "8": return decodeClassicInt8(parseCanonicalBigInt(text, path), int8Mode, path);
    case "a":
      return projectClassicBcdOutput(
        decodeDecimalFloat16(encodeDecimalFloat16(text, path), path),
        bcd,
        path,
      );
    case "e":
      return projectClassicBcdOutput(
        decodeDecimalFloat34(encodeDecimalFloat34(text, path), path),
        bcd,
        path,
      );
    case "g": assertUnicodeScalarText(text, path); return text;
    case "y": {
      const byteLength = canonicalBase64DecodedByteLength(
        text,
        path,
        limits.maxCellBytes,
      );
      assertDecodedValueBytes(byteLength, limits, path);
      parser.decodedValue(byteLength, path);
      return canonicalBase64(text, path, limits.maxCellBytes);
    }
    default:
      if (isClassicTemporalExid(field.internalType)) {
        return rawTemporal(field, text, path);
      }
      throw new Error(`${path} xRFC scalar type ${field.internalType} is not implemented`);
  }
}

function parseReference(
  graph: RecursiveMetadataGraph,
  field: RecursiveMetadataField,
  parser: Parser,
  limits: NormalizedLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  depth: number,
  path: string,
): unknown {
  if (field.reference.kind === "scalar") {
    return decodedScalar(
      field,
      parser.cell(path),
      int8Mode,
      bcd,
      limits,
      parser,
      path,
    );
  }
  if (depth > limits.maxDepth) {
    throw new RangeError(`${path} exceeds recursive xRFC depth ${limits.maxDepth}`);
  }
  const node = targetNode(graph, field.reference, path);
  return node.kind === "structure"
    ? parseStructure(graph, node, parser, limits, int8Mode, bcd, depth, path)
    : parseTable(graph, node, parser, limits, int8Mode, bcd, depth, path);
}

function parseStructure(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  parser: Parser,
  limits: NormalizedLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  depth: number,
  path: string,
): Record<string, unknown> {
  if (depth > limits.maxDepth) {
    throw new RangeError(`${path} exceeds recursive xRFC depth ${limits.maxDepth}`);
  }
  parser.node(path);
  const result: Record<string, unknown> = {};
  for (const field of node.fields) {
    if (field.name.length === 0) throw new Error(`${path} structure contains an anonymous field`);
    const fieldPath = `${path}.${field.name}`;
    parser.open(field.name, fieldPath);
    const value = parseReference(
      graph,
      field,
      parser,
      limits,
      int8Mode,
      bcd,
      depth + 1,
      fieldPath,
    );
    Object.defineProperty(result, field.name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    parser.close(field.name, fieldPath);
  }
  return result;
}

function parseTableLine(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  parser: Parser,
  limits: NormalizedLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  depth: number,
  path: string,
): unknown {
  if (node.fields.length === 1 && node.fields[0]!.name.length === 0) {
    return parseReference(
      graph,
      node.fields[0]!,
      parser,
      limits,
      int8Mode,
      bcd,
      depth + 1,
      path,
    );
  }
  return parseStructure(graph, node, parser, limits, int8Mode, bcd, depth, path);
}

function parseTable(
  graph: RecursiveMetadataGraph,
  node: RecursiveMetadataTypeNode,
  parser: Parser,
  limits: NormalizedLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
  depth: number,
  path: string,
): unknown[] {
  if (depth > limits.maxDepth) {
    throw new RangeError(`${path} exceeds recursive xRFC depth ${limits.maxDepth}`);
  }
  parser.node(path);
  const rows: unknown[] = [];
  while (parser.starts("item")) {
    const rowPath = `${path}[${rows.length}]`;
    parser.row(rowPath);
    parser.open("item", rowPath);
    rows.push(parseTableLine(
      graph,
      node,
      parser,
      limits,
      int8Mode,
      bcd,
      depth,
      rowPath,
    ));
    parser.close("item", rowPath);
  }
  return rows;
}

/** Strictly decode one complete graph-backed recursive xRFC parameter. */
export function decodeRecursiveXrfcParameter(
  parameter: RfcFunintParameter,
  graph: RecursiveMetadataGraph,
  value: Uint8Array,
  options: RecursiveXrfcOptions = {},
): unknown {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("recursive xRFC XML must be Uint8Array bytes");
  }
  const limits = normalizeLimits(options);
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  const resolved = validateRecursiveXrfcParameterAtDepth(
    graph,
    parameter,
    limits.maxDepth,
  );
  return decodeResolvedRecursiveXrfcParameterWithOptions(
    parameter,
    graph,
    resolved,
    value,
    limits,
    int8Mode,
    bcd,
  );
}

/** Decode from an invocation-scoped plan without rescanning graph parameters. */
export function decodeResolvedRecursiveXrfcParameter(
  parameter: RfcFunintParameter,
  graph: RecursiveMetadataGraph,
  resolved: ResolvedRecursiveXrfcParameter,
  value: Uint8Array,
  options: RecursiveXrfcOptions = {},
): unknown {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("recursive xRFC XML must be Uint8Array bytes");
  }
  const limits = normalizeLimits(options);
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  validateRecursiveXrfcParameterAtDepth(
    graph,
    parameter,
    limits.maxDepth,
    resolved,
  );
  return decodeResolvedRecursiveXrfcParameterWithOptions(
    parameter,
    graph,
    resolved,
    value,
    limits,
    int8Mode,
    bcd,
  );
}

function decodeResolvedRecursiveXrfcParameterWithOptions(
  parameter: RfcFunintParameter,
  graph: RecursiveMetadataGraph,
  resolved: ResolvedRecursiveXrfcParameter,
  value: Uint8Array,
  limits: NormalizedLimits,
  int8Mode: ClassicInt8Mode,
  bcd: ClassicBcdMode,
): unknown {
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength > limits.maxParameterBytes) {
    throw new RangeError(
      `${parameter.parameterName} recursive xRFC XML exceeds ${limits.maxParameterBytes} bytes`,
    );
  }
  const encoded = snapshotUint8Array(
    value,
    `${parameter.parameterName} recursive xRFC XML`,
    byteLength,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  const parser = new Parser(text, limits);
  parser.open(parameter.parameterName, parameter.parameterName);
  const result = resolved.kind === "structure"
    ? parseStructure(
      graph,
      resolved.node,
      parser,
      limits,
      int8Mode,
      bcd,
      1,
      parameter.parameterName,
    )
    : parseTable(
      graph,
      resolved.node,
      parser,
      limits,
      int8Mode,
      bcd,
      1,
      parameter.parameterName,
    );
  parser.close(parameter.parameterName, parameter.parameterName);
  parser.finish();
  return result;
}
