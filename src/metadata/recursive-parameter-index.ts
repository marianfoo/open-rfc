import { types as nodeUtilTypes } from "node:util";

import type {
  RecursiveMetadataGraph,
  RecursiveMetadataParameter,
} from "./recursive-metadata.js";
import { isNormalizedRecursiveMetadataGraph } from "./recursive-metadata.js";

/**
 * Opaque, invocation-scoped lookup for one recursive metadata graph.
 *
 * The backing map stays module-private so a caller cannot mutate a resolved
 * dispatch plan between preflight and value serialization.
 */
export interface RecursiveMetadataParameterIndex {
  readonly functionName: string;
  readonly parameterCount: number;
}

interface RecursiveMetadataParameterIndexState {
  readonly graph: RecursiveMetadataGraph;
  readonly parameters: ReadonlyMap<string, RecursiveMetadataParameter>;
  readonly cacheable: boolean;
  readonly caches: Map<string, Map<string, unknown>>;
  readonly work: RecursiveMetadataParameterIndexWork;
}

interface RecursiveMetadataParameterIndexWork {
  broadClassificationNodeVisits: number;
  broadClassificationFieldVisits: number;
  broadValidationNodeVisits: number;
  broadValidationFieldVisits: number;
  strictDescriptorNodeVisits: number;
}

export interface RecursiveMetadataParameterIndexDiagnostics {
  readonly broadClassificationNodeVisits: number;
  readonly broadClassificationFieldVisits: number;
  readonly broadValidationNodeVisits: number;
  readonly broadValidationFieldVisits: number;
  readonly strictDescriptorNodeVisits: number;
}

const ABSOLUTE_MAX_PARAMETER_COUNT = 100_000;
const INDEX_STATE = new WeakMap<
  object,
  RecursiveMetadataParameterIndexState
>();

/**
 * Validate and index every parameter name once before recursive dispatch.
 * Duplicate names are rejected even when only one of them would be active.
 */
export function createRecursiveMetadataParameterIndex(
  graph: RecursiveMetadataGraph,
): RecursiveMetadataParameterIndex {
  if (typeof graph !== "object" || graph === null || graph.version !== 1) {
    throw new TypeError(
      "recursive xRFC graph must be a version-1 metadata graph",
    );
  }
  const identity = graph.functionIdentity;
  if (
    typeof identity !== "object" ||
    identity === null ||
    typeof identity.name !== "string" ||
    identity.name.length === 0
  ) {
    throw new Error("recursive xRFC metadata lacks a function identity");
  }
  const source = graph.parameters;
  if (!Array.isArray(source)) {
    throw new TypeError("recursive xRFC metadata parameters must be an array");
  }
  if (nodeUtilTypes.isProxy(source)) {
    throw new TypeError(
      "recursive xRFC metadata parameters must not be a proxy",
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError(
      "recursive xRFC metadata parameter length must be intrinsic",
    );
  }
  const parameterCount = lengthDescriptor.value as number;
  const declaredMaximum = graph.limits?.maxRows;
  if (
    !Number.isSafeInteger(declaredMaximum) ||
    (declaredMaximum as number) < 0 ||
    (declaredMaximum as number) > ABSOLUTE_MAX_PARAMETER_COUNT
  ) {
    throw new RangeError(
      `recursive xRFC graph maxRows is outside 0..${ABSOLUTE_MAX_PARAMETER_COUNT}`,
    );
  }
  if (parameterCount > (declaredMaximum as number)) {
    throw new RangeError(
      `recursive xRFC graph exceeds its row budget ${declaredMaximum}`,
    );
  }

  const parameters = new Map<string, RecursiveMetadataParameter>();
  for (let position = 0; position < parameterCount; position += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      source,
      String(position),
    );
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `recursive xRFC metadata parameter ${position} must be an own data property`,
      );
    }
    const parameter = descriptor.value as RecursiveMetadataParameter;
    if (typeof parameter !== "object" || parameter === null) {
      throw new TypeError(
        `recursive xRFC metadata parameter ${position} must be an object`,
      );
    }
    // Read the name exactly once. Besides making the indexing bound explicit,
    // this prevents accessor-backed hand graphs from changing lookup identity
    // between duplicate validation and dispatch.
    const name = parameter.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(
        `recursive xRFC metadata parameter ${position} name must be non-empty`,
      );
    }
    if (parameters.has(name)) {
      throw new Error(
        `${identity.name}.${name} has duplicate recursive metadata`,
      );
    }
    parameters.set(name, parameter);
  }

  const index = Object.freeze({
    functionName: identity.name,
    parameterCount,
  });
  INDEX_STATE.set(index, Object.freeze({
    graph,
    parameters,
    cacheable: isNormalizedRecursiveMetadataGraph(graph),
    caches: new Map(),
    work: {
      broadClassificationNodeVisits: 0,
      broadClassificationFieldVisits: 0,
      broadValidationNodeVisits: 0,
      broadValidationFieldVisits: 0,
      strictDescriptorNodeVisits: 0,
    },
  }));
  return index;
}

function requiredIndexState(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
): RecursiveMetadataParameterIndexState {
  const state = INDEX_STATE.get(index as object);
  if (state === undefined || state.graph !== graph) {
    throw new TypeError(
      "recursive xRFC parameter index must be created for the same metadata graph",
    );
  }
  return state;
}

/** Resolve one parameter from a branded index bound to the same graph. */
export function recursiveMetadataParameterFromIndex(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  name: string,
): RecursiveMetadataParameter | undefined {
  return requiredIndexState(graph, index).parameters.get(name);
}

/** Read one cache entry only for a normalizer-produced immutable graph. */
export function recursiveMetadataParameterIndexCacheGet<T>(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  namespace: string,
  key: string,
): T | undefined {
  const state = requiredIndexState(graph, index);
  if (!state.cacheable) return undefined;
  return state.caches.get(namespace)?.get(key) as T | undefined;
}

/** Store one cache entry only for a normalizer-produced immutable graph. */
export function recursiveMetadataParameterIndexCacheSet<T>(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
  namespace: string,
  key: string,
  value: T,
): T {
  const state = requiredIndexState(graph, index);
  if (!state.cacheable) return value;
  let cache = state.caches.get(namespace);
  if (cache === undefined) {
    cache = new Map();
    state.caches.set(namespace, cache);
  }
  cache.set(key, value);
  return value;
}

export function recordRecursiveMetadataParameterIndexWork(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex | undefined,
  kind: keyof RecursiveMetadataParameterIndexWork,
): void {
  if (index === undefined) return;
  const state = requiredIndexState(graph, index);
  state.work[kind] += 1;
}

/** Deterministic internal evidence for traversal-bound regression tests. */
export function recursiveMetadataParameterIndexDiagnostics(
  graph: RecursiveMetadataGraph,
  index: RecursiveMetadataParameterIndex,
): RecursiveMetadataParameterIndexDiagnostics {
  const work = requiredIndexState(graph, index).work;
  return Object.freeze({ ...work });
}
