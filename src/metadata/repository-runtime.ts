import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeUtilTypes } from "node:util";

import {
  createDeferredRfcDiagnosticReporter,
  type RfcDiagnosticEmitter,
  type RfcDiagnosticReporter,
} from "../diagnostics/structured-diagnostics.js";
import {
  immutableMetadataMapEntries,
  isImmutableMetadataMap,
} from "./immutable-map.js";

export enum MetadataRepositoryMode {
  Auto = "auto",
  Classic = "classic",
  OptimizedOnly = "optimizedOnly",
  LegacyV3 = "legacyV3",
}

export enum MetadataLoadStrategy {
  Classic = "classic",
  Optimized = "optimized",
  LegacyV3 = "legacyV3",
}

export type MetadataAccessFailureClassification =
  | "unavailable"
  | "authorization"
  | "communication"
  | "timeout"
  | "canceled"
  | "malformed"
  | "other";

/**
 * A safe classification boundary for repository access failures. The runtime
 * never examines message text when deciding whether fallback is permitted.
 */
export class MetadataAccessFailure extends Error {
  readonly classification: MetadataAccessFailureClassification;

  constructor(
    classification: MetadataAccessFailureClassification,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MetadataAccessFailure";
    this.classification = classification;
  }
}

export interface MetadataStructuralKeyInput {
  readonly backendKey: string;
  readonly metadataGeneration: string;
  readonly language: string;
  readonly objectKind: string;
  readonly objectName: string;
}

/** A descriptor identity which deliberately contains no authenticated principal. */
export interface MetadataStructuralKey extends MetadataStructuralKeyInput {
  readonly id: string;
}

export interface MetadataCapabilityKeyInput {
  readonly backendKey: string;
  readonly principalKey: string;
}

/** A backend capability/authorization identity scoped to one opaque principal. */
export interface MetadataCapabilityKey extends MetadataCapabilityKeyInput {
  readonly id: string;
}

export interface MetadataLookup {
  readonly structural: MetadataStructuralKey;
  readonly capability: MetadataCapabilityKey;
  readonly mode: MetadataRepositoryMode;
}

/**
 * Private, canonical lookup state. The mode-scoped capability identity keeps
 * authorization and probe decisions separate without adding a principal to the
 * structurally shared descriptor key.
 */
interface CanonicalMetadataLookup extends MetadataLookup {
  readonly capabilityIdentity: string;
}

export interface MetadataSnapshot<T extends object> {
  /** Must be recursively frozen before it crosses the adapter boundary. */
  readonly value: T;
  readonly retainedBytes: number;
}

export interface MetadataProbeContext {
  readonly capability: MetadataCapabilityKey;
  readonly mode: MetadataRepositoryMode;
  /** Aborted only when the owning repository generation is retired. */
  readonly signal: AbortSignal;
}

export interface MetadataAccessContext {
  readonly structural: MetadataStructuralKey;
  readonly capability: MetadataCapabilityKey;
  readonly mode: MetadataRepositoryMode;
  readonly strategy: MetadataLoadStrategy;
  /** Aborted only when the owning repository generation is retired. */
  readonly signal: AbortSignal;
}

/** Transport-independent adapter implemented later by a destination/session lane. */
export interface MetadataAdapter<T extends object> {
  probeOptimized(context: MetadataProbeContext): Promise<void>;
  authorize(context: MetadataAccessContext): Promise<void>;
  load(context: MetadataAccessContext): Promise<MetadataSnapshot<T>>;
}

export interface MetadataRepositoryRuntimeOptions<T extends object> {
  readonly maxEntries: number;
  readonly maxRetainedBytes: number;
  /** Bounded principal/mode probe decisions, including pending probes. */
  readonly maxProbeEntries?: number;
  /** Bounded principal/mode/object authorization decisions. */
  readonly maxAuthorizationEntries?: number;
  /** Bounded per-object invalidation epochs before a safe global compaction. */
  readonly maxObjectEpochEntries?: number;
  /** Maximum physically active descriptor loads, including invalidated loads. */
  readonly maxInFlightLoads?: number;
  /** Maximum distinct object/array nodes inspected in one adapter snapshot. */
  readonly maxSnapshotNodes?: number;
  /** Maximum distinct-object path depth inspected in one adapter snapshot. */
  readonly maxSnapshotDepth?: number;
  /** Maximum own property descriptors inspected across one adapter snapshot. */
  readonly maxSnapshotProperties?: number;
  readonly adapter: MetadataAdapter<T>;
  /** Optional bounded structured diagnostics; never receives metadata values. */
  readonly diagnostics?: RfcDiagnosticEmitter;
}

export interface MetadataRepositoryMonitor {
  readonly state: "active" | "retired";
  readonly entries: number;
  readonly retainedBytes: number;
  readonly lookups: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly loadsStarted: number;
  readonly loadsSucceeded: number;
  readonly loadsFailed: number;
  readonly inFlight: number;
  readonly inFlightJoins: number;
  readonly evictions: number;
  readonly oversizeSkips: number;
  readonly invalidations: number;
  readonly optimizedProbeCalls: number;
  readonly optimizedProbeHits: number;
  readonly optimizedFallbacks: number;
  readonly authorizationCalls: number;
  readonly authorizationHits: number;
  readonly authorizationFailures: number;
  readonly maxProbeEntries: number;
  readonly probeEntries: number;
  readonly probeInFlight: number;
  readonly probeEvictions: number;
  readonly probeCapacityRejections: number;
  readonly maxAuthorizationEntries: number;
  readonly authorizationEntries: number;
  readonly authorizationInFlight: number;
  readonly authorizationEvictions: number;
  readonly authorizationCapacityRejections: number;
  readonly maxObjectEpochEntries: number;
  readonly objectEpochEntries: number;
  readonly objectEpochCompactions: number;
  readonly maxInFlightLoads: number;
  readonly trackedInFlight: number;
  readonly inFlightCapacityRejections: number;
  readonly maxSnapshotNodes: number;
  readonly maxSnapshotDepth: number;
  readonly maxSnapshotProperties: number;
}

interface CacheEntry<T extends object> {
  readonly structural: MetadataStructuralKey;
  readonly value: T;
  readonly retainedBytes: number;
}

interface AuthorizationEntry {
  readonly structuralId: string;
  readonly promise?: Promise<void>;
}

interface ProbeEntry {
  readonly result?: ProbeResult;
  readonly promise?: Promise<ProbeResult>;
}

interface ProbeResult {
  readonly available: boolean;
  readonly fallbackClassification?: "unavailable" | "authorization";
}

interface BoundMetadataAdapter<T extends object> {
  readonly probeOptimized: (context: MetadataProbeContext) => Promise<void>;
  readonly authorize: (context: MetadataAccessContext) => Promise<void>;
  readonly load: (
    context: MetadataAccessContext,
  ) => Promise<MetadataSnapshot<T>>;
}

interface OperationEpoch {
  readonly global: bigint;
  readonly object: bigint;
}

interface BoundCallerSignal {
  readonly isAborted: () => boolean;
  readonly register: (listener: () => void) => void;
  readonly unregister: (listener: () => void) => void;
}

interface MetadataRetirementContext {
  readonly owners: ReadonlySet<object>;
}

const AVAILABLE_PROBE: ProbeResult = Object.freeze({ available: true });
const MAX_AUXILIARY_ENTRIES = 1_000_000;
const DEFAULT_MAX_SNAPSHOT_NODES = 100_000;
const DEFAULT_MAX_SNAPSHOT_DEPTH = 256;
const DEFAULT_MAX_SNAPSHOT_PROPERTIES = 1_000_000;
const MAX_SNAPSHOT_DEPTH = 4_096;
const safeApply = Reflect.apply;
const metadataRetirementContext =
  new AsyncLocalStorage<MetadataRetirementContext>();

function canceledWait(): MetadataAccessFailure {
  return new MetadataAccessFailure(
    "canceled",
    "metadata repository lookup was canceled",
  );
}

function bindCallerSignal(
  signal: AbortSignal | undefined,
): BoundCallerSignal | undefined {
  if (signal === undefined) return undefined;
  if (typeof signal !== "object" || signal === null) {
    throw new TypeError("metadata lookup signal must be an AbortSignal");
  }
  const initiallyAborted = signal.aborted;
  const addEventListener = signal.addEventListener;
  const removeEventListener = signal.removeEventListener;
  if (
    typeof initiallyAborted !== "boolean" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    throw new TypeError("metadata lookup signal must be an AbortSignal");
  }
  return Object.freeze({
    isAborted: (): boolean => {
      const aborted = signal.aborted;
      if (typeof aborted !== "boolean") {
        throw new TypeError("metadata lookup signal must be an AbortSignal");
      }
      return aborted;
    },
    register: (listener: () => void): void => {
      safeApply(addEventListener, signal, ["abort", listener, { once: true }]);
    },
    unregister: (listener: () => void): void => {
      safeApply(removeEventListener, signal, ["abort", listener]);
    },
  });
}

function waitForCaller<T>(
  operation: Promise<T>,
  callerSignal: BoundCallerSignal | undefined,
): Promise<T> {
  if (callerSignal === undefined) return operation;
  if (callerSignal.isAborted()) return Promise.reject(canceledWait());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        callerSignal.unregister(onAbort);
      } catch {
        // A hostile signal cleanup hook must not strand or replace the
        // metadata operation's already-determined result.
      }
      continuation();
    };
    const onAbort = (): void => {
      finish(() => reject(canceledWait()));
    };

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    try {
      callerSignal.register(onAbort);
      // An abort can occur between the initial read and listener registration.
      if (callerSignal.isAborted()) onAbort();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer in ${minimum}..${maximum}`,
    );
  }
}

function derivedAuxiliaryLimit(
  configured: number | undefined,
  maxEntries: number,
  multiplier: number,
  minimum: number,
  field: string,
): number {
  if (configured !== undefined) {
    boundedInteger(configured, 1, MAX_AUXILIARY_ENTRIES, field);
    return configured;
  }
  const scaled = maxEntries > Math.floor(MAX_AUXILIARY_ENTRIES / multiplier)
    ? MAX_AUXILIARY_ENTRIES
    : maxEntries * multiplier;
  return Math.min(
    MAX_AUXILIARY_ENTRIES,
    Math.max(minimum, scaled),
  );
}

function epochIdentity(epoch: OperationEpoch): string {
  return `${epoch.global.toString(36)}:${epoch.object.toString(36)}`;
}

function capacityError(kind: string, maximum: number): Error {
  return new Error(
    `metadata repository ${kind} capacity ${maximum} is exhausted`,
  );
}

function opaqueIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(
      `${field} must contain 1..512 characters without controls`,
    );
  }
  return value;
}

function tupleId(values: readonly string[]): string {
  return JSON.stringify(values);
}

function bindMetadataAdapter<T extends object>(
  adapter: MetadataAdapter<T>,
): BoundMetadataAdapter<T> {
  const probeOptimized = adapter?.probeOptimized;
  const authorize = adapter?.authorize;
  const load = adapter?.load;
  if (typeof probeOptimized !== "function") {
    throw new TypeError("metadata adapter must provide probeOptimized()");
  }
  if (typeof authorize !== "function") {
    throw new TypeError("metadata adapter must provide authorize()");
  }
  if (typeof load !== "function") {
    throw new TypeError("metadata adapter must provide load()");
  }
  return Object.freeze({
    probeOptimized: (context: MetadataProbeContext): Promise<void> =>
      Reflect.apply(probeOptimized, adapter, [context]),
    authorize: (context: MetadataAccessContext): Promise<void> =>
      Reflect.apply(authorize, adapter, [context]),
    load: (context: MetadataAccessContext): Promise<MetadataSnapshot<T>> =>
      Reflect.apply(load, adapter, [context]),
  });
}

export function createMetadataStructuralKey(
  input: MetadataStructuralKeyInput,
): MetadataStructuralKey {
  const backendKey = opaqueIdentity(input.backendKey, "backendKey");
  const metadataGeneration = opaqueIdentity(
    input.metadataGeneration,
    "metadataGeneration",
  );
  const language = opaqueIdentity(input.language, "language");
  const objectKind = opaqueIdentity(input.objectKind, "objectKind");
  const objectName = opaqueIdentity(input.objectName, "objectName");
  return Object.freeze({
    backendKey,
    metadataGeneration,
    language,
    objectKind,
    objectName,
    id: tupleId([
      backendKey,
      metadataGeneration,
      language,
      objectKind,
      objectName,
    ]),
  });
}

export function createMetadataCapabilityKey(
  input: MetadataCapabilityKeyInput,
): MetadataCapabilityKey {
  const backendKey = opaqueIdentity(input.backendKey, "backendKey");
  const principalKey = opaqueIdentity(input.principalKey, "principalKey");
  return Object.freeze({
    backendKey,
    principalKey,
    id: tupleId([backendKey, principalKey]),
  });
}

function accessClassification(
  error: unknown,
): MetadataAccessFailureClassification | undefined {
  return error instanceof MetadataAccessFailure
    ? error.classification
    : undefined;
}

function allowsAutomaticFallback(error: unknown): boolean {
  const classification = accessClassification(error);
  return classification === "unavailable" || classification === "authorization";
}

function arrayIndexPropertyCount(keys: readonly PropertyKey[]): number {
  let count = 0;
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const index = Number(key);
    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < 4_294_967_295 &&
      String(index) === key
    ) {
      count += 1;
    }
  }
  return count;
}

function assertBoundedRecursivelyFrozen(
  root: object,
  maxNodes: number,
  maxDepth: number,
  maxProperties: number,
): void {
  const scheduled = new Set<object>([root]);
  const pending: Array<{ readonly value: object; readonly depth: number }> = [
    { value: root, depth: 1 },
  ];
  let inspectedProperties = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (nodeUtilTypes.isProxy(current.value)) {
      throw new TypeError(
        "metadata snapshot graph must not contain Proxy objects",
      );
    }
    if (typeof current.value === "function") {
      throw new TypeError("metadata snapshot value must be recursively frozen");
    }
    if (isImmutableMetadataMap(current.value)) {
      if (!Object.isFrozen(current.value)) {
        throw new TypeError("metadata snapshot value must be recursively frozen");
      }
      const entries = immutableMetadataMapEntries(current.value);
      if (entries.length > Math.floor((maxProperties - inspectedProperties) / 2)) {
        throw new RangeError(
          `metadata snapshot graph exceeds property limit ${maxProperties}`,
        );
      }
      inspectedProperties += entries.length * 2;
      for (const [key, value] of entries) {
        for (const child of [key, value]) {
          if (
            child === null ||
            (typeof child !== "object" && typeof child !== "function")
          ) {
            continue;
          }
          const childObject = child as object;
          if (scheduled.has(childObject)) continue;
          const childDepth = current.depth + 1;
          if (childDepth > maxDepth) {
            throw new RangeError(
              `metadata snapshot graph exceeds depth limit ${maxDepth}`,
            );
          }
          if (scheduled.size >= maxNodes) {
            throw new RangeError(
              `metadata snapshot graph exceeds node limit ${maxNodes}`,
            );
          }
          scheduled.add(childObject);
          pending.push({ value: childObject, depth: childDepth });
        }
      }
      continue;
    }
    if (
      current.value instanceof Map ||
      current.value instanceof Set ||
      current.value instanceof Date ||
      current.value instanceof ArrayBuffer ||
      ArrayBuffer.isView(current.value)
    ) {
      throw new TypeError("metadata snapshot value must be recursively frozen");
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype) {
      throw new TypeError("metadata snapshot value must be recursively frozen");
    }
    if (Object.isExtensible(current.value)) {
      throw new TypeError("metadata snapshot value must be recursively frozen");
    }
    const keys = Reflect.ownKeys(current.value);
    const logicalProperties = Array.isArray(current.value)
      ? keys.length +
        current.value.length -
        arrayIndexPropertyCount(keys)
      : keys.length;
    if (logicalProperties > maxProperties - inspectedProperties) {
      throw new RangeError(
        `metadata snapshot graph exceeds property limit ${maxProperties}`,
      );
    }
    inspectedProperties += logicalProperties;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)!;
      if (
        descriptor.configurable ||
        ("writable" in descriptor && descriptor.writable) ||
        "get" in descriptor ||
        "set" in descriptor
      ) {
        throw new TypeError("metadata snapshot value must be recursively frozen");
      }
      if (
        "value" in descriptor &&
        descriptor.value !== null &&
        (typeof descriptor.value === "object" ||
          typeof descriptor.value === "function")
      ) {
        const child = descriptor.value as object;
        if (scheduled.has(child)) continue;
        const childDepth = current.depth + 1;
        if (childDepth > maxDepth) {
          throw new RangeError(
            `metadata snapshot graph exceeds depth limit ${maxDepth}`,
          );
        }
        if (scheduled.size >= maxNodes) {
          throw new RangeError(
            `metadata snapshot graph exceeds node limit ${maxNodes}`,
          );
        }
        scheduled.add(child);
        pending.push({
          value: child,
          depth: childDepth,
        });
      }
    }
  }
}

function normalizeSnapshot<T extends object>(
  snapshot: MetadataSnapshot<T>,
  maxNodes: number,
  maxDepth: number,
  maxProperties: number,
): MetadataSnapshot<T> {
  if (
    typeof snapshot !== "object" ||
    snapshot === null
  ) {
    throw new TypeError("metadata adapter must return an object snapshot");
  }
  if (nodeUtilTypes.isProxy(snapshot)) {
    throw new TypeError("metadata adapter snapshot must not be a Proxy object");
  }
  const value = snapshot.value;
  const retainedBytes = snapshot.retainedBytes;
  if (typeof value !== "object" || value === null) {
    throw new TypeError("metadata adapter must return an object snapshot");
  }
  boundedInteger(
    retainedBytes,
    0,
    Number.MAX_SAFE_INTEGER,
    "metadata retainedBytes",
  );
  assertBoundedRecursivelyFrozen(value, maxNodes, maxDepth, maxProperties);
  return Object.freeze({
    value,
    retainedBytes,
  });
}

function canonicalRepositoryMode(value: unknown): MetadataRepositoryMode {
  if (
    !Object.values(MetadataRepositoryMode).includes(
      value as MetadataRepositoryMode,
    )
  ) {
    throw new RangeError(`unsupported metadata repository mode ${String(value)}`);
  }
  return value as MetadataRepositoryMode;
}

function canonicalizeLookup(lookup: MetadataLookup): CanonicalMetadataLookup {
  if (typeof lookup !== "object" || lookup === null) {
    throw new TypeError("metadata lookup must be an object");
  }
  const structural = canonicalizeStructuralKey(lookup.structural);
  const capability = canonicalizeCapabilityKey(lookup.capability);
  const mode = canonicalRepositoryMode(lookup.mode);
  if (structural.backendKey !== capability.backendKey) {
    throw new Error(
      "metadata structural and capability keys must identify the same backend",
    );
  }
  return Object.freeze({
    structural,
    capability,
    mode,
    capabilityIdentity: tupleId([capability.id, mode]),
  });
}

function canonicalizeStructuralKey(
  key: MetadataStructuralKey,
): MetadataStructuralKey {
  if (typeof key !== "object" || key === null) {
    throw new TypeError("metadata structural key must be an object");
  }
  const suppliedId = key.id;
  const expected = createMetadataStructuralKey(key);
  if (suppliedId !== expected.id) {
    throw new Error("metadata structural key does not match its canonical fields");
  }
  return expected;
}

function canonicalizeCapabilityKey(
  key: MetadataCapabilityKey,
): MetadataCapabilityKey {
  if (typeof key !== "object" || key === null) {
    throw new TypeError("metadata capability key must be an object");
  }
  const suppliedId = key.id;
  const expected = createMetadataCapabilityKey(key);
  if (suppliedId !== expected.id) {
    throw new Error("metadata capability key does not match its canonical fields");
  }
  return expected;
}

/**
 * Bounded, generation-local metadata state. Structural values may be shared,
 * while every read is gated by a separately cached principal authorization.
 */
export class MetadataRepositoryRuntime<T extends object> {
  readonly #maxEntries: number;
  readonly #maxRetainedBytes: number;
  readonly #maxProbeEntries: number;
  readonly #maxAuthorizationEntries: number;
  readonly #maxObjectEpochEntries: number;
  readonly #maxInFlightLoads: number;
  readonly #maxSnapshotNodes: number;
  readonly #maxSnapshotDepth: number;
  readonly #maxSnapshotProperties: number;
  readonly #adapter: BoundMetadataAdapter<T>;
  readonly #report: RfcDiagnosticReporter | undefined;
  readonly #cache = new Map<string, CacheEntry<T>>();
  readonly #inFlight = new Map<string, Promise<T>>();
  readonly #authorizations = new Map<string, AuthorizationEntry>();
  readonly #probes = new Map<string, ProbeEntry>();
  readonly #objectEpochs = new Map<string, bigint>();
  readonly #activeOperations = new Set<Promise<unknown>>();
  readonly #retirementController = new AbortController();

  #state: "active" | "retired" = "active";
  #retirement: Promise<void> | undefined;
  readonly #reentrantRetirementAcknowledgement = Promise.resolve();
  #retainedBytes = 0;
  #globalEpoch = 0n;
  #lookups = 0;
  #cacheHits = 0;
  #cacheMisses = 0;
  #loadsStarted = 0;
  #loadsSucceeded = 0;
  #loadsFailed = 0;
  #activeLoads = 0;
  #inFlightJoins = 0;
  #evictions = 0;
  #oversizeSkips = 0;
  #invalidations = 0;
  #optimizedProbeCalls = 0;
  #optimizedProbeHits = 0;
  #optimizedFallbacks = 0;
  #authorizationCalls = 0;
  #authorizationHits = 0;
  #authorizationFailures = 0;
  #activeProbes = 0;
  #probeEvictions = 0;
  #probeCapacityRejections = 0;
  #activeAuthorizations = 0;
  #authorizationEvictions = 0;
  #authorizationCapacityRejections = 0;
  #objectEpochCompactions = 0;
  #inFlightCapacityRejections = 0;

  constructor(options: MetadataRepositoryRuntimeOptions<T>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("metadata repository options must be an object");
    }
    const maxEntries = options.maxEntries;
    const maxRetainedBytes = options.maxRetainedBytes;
    const maxProbeEntries = options.maxProbeEntries;
    const maxAuthorizationEntries = options.maxAuthorizationEntries;
    const maxObjectEpochEntries = options.maxObjectEpochEntries;
    const maxInFlightLoads = options.maxInFlightLoads;
    const maxSnapshotNodes = options.maxSnapshotNodes;
    const maxSnapshotDepth = options.maxSnapshotDepth;
    const maxSnapshotProperties = options.maxSnapshotProperties;
    const adapter = options.adapter;
    const diagnostics = options.diagnostics;
    boundedInteger(
      maxEntries,
      0,
      Number.MAX_SAFE_INTEGER,
      "maxEntries",
    );
    boundedInteger(
      maxRetainedBytes,
      0,
      Number.MAX_SAFE_INTEGER,
      "maxRetainedBytes",
    );
    this.#maxEntries = maxEntries;
    this.#maxRetainedBytes = maxRetainedBytes;
    this.#maxProbeEntries = derivedAuxiliaryLimit(
      maxProbeEntries,
      maxEntries,
      2,
      16,
      "maxProbeEntries",
    );
    this.#maxAuthorizationEntries = derivedAuxiliaryLimit(
      maxAuthorizationEntries,
      maxEntries,
      4,
      32,
      "maxAuthorizationEntries",
    );
    this.#maxObjectEpochEntries = derivedAuxiliaryLimit(
      maxObjectEpochEntries,
      maxEntries,
      2,
      32,
      "maxObjectEpochEntries",
    );
    this.#maxInFlightLoads = derivedAuxiliaryLimit(
      maxInFlightLoads,
      maxEntries,
      2,
      8,
      "maxInFlightLoads",
    );
    this.#maxSnapshotNodes = maxSnapshotNodes ?? DEFAULT_MAX_SNAPSHOT_NODES;
    boundedInteger(
      this.#maxSnapshotNodes,
      1,
      MAX_AUXILIARY_ENTRIES,
      "maxSnapshotNodes",
    );
    this.#maxSnapshotDepth = maxSnapshotDepth ?? DEFAULT_MAX_SNAPSHOT_DEPTH;
    boundedInteger(
      this.#maxSnapshotDepth,
      1,
      MAX_SNAPSHOT_DEPTH,
      "maxSnapshotDepth",
    );
    this.#maxSnapshotProperties = maxSnapshotProperties ??
      DEFAULT_MAX_SNAPSHOT_PROPERTIES;
    boundedInteger(
      this.#maxSnapshotProperties,
      1,
      MAX_AUXILIARY_ENTRIES,
      "maxSnapshotProperties",
    );
    this.#adapter = bindMetadataAdapter(adapter);
    this.#report = createDeferredRfcDiagnosticReporter(diagnostics);
  }

  async get(lookup: MetadataLookup, signal?: AbortSignal): Promise<T> {
    this.#assertActive();
    const callerSignal = bindCallerSignal(signal);
    if (callerSignal?.isAborted() === true) throw canceledWait();
    const canonicalLookup = canonicalizeLookup(lookup);
    // Lookup normalization reads caller-owned accessors. They may reenter and
    // retire this generation, so gate again before any repository work starts.
    this.#assertActive();
    if (callerSignal?.isAborted() === true) throw canceledWait();
    this.#lookups += 1;
    this.#report?.({
      category: "metadata",
      level: "debug",
      code: "metadata.lookup",
      phase: "metadata",
      count: 1,
    });
    const epoch = this.#epochFor(canonicalLookup.structural.id);
    return waitForCaller(
      this.#getCanonical(canonicalLookup, epoch),
      callerSignal,
    ).catch((error: unknown) => {
      this.#report?.({
        category: "metadata",
        level: "warn",
        code: "metadata.failed",
        state: "failed",
        phase: "metadata",
        count: 1,
      });
      throw error;
    });
  }

  async #getCanonical(
    canonicalLookup: CanonicalMetadataLookup,
    epoch: OperationEpoch,
  ): Promise<T> {
    const strategy = await this.#selectStrategy(canonicalLookup);
    try {
      return await this.#getWithStrategy(canonicalLookup, strategy, epoch);
    } catch (error) {
      this.#forgetAuthorization(canonicalLookup, strategy, epoch);
      if (
        strategy !== MetadataLoadStrategy.Optimized ||
        canonicalLookup.mode !== MetadataRepositoryMode.Auto ||
        !allowsAutomaticFallback(error)
      ) {
        throw error;
      }
      this.#optimizedFallbacks += 1;
      this.#rememberOptimizedFallback(canonicalLookup, error, epoch);
      this.#forgetAuthorization(
        canonicalLookup,
        MetadataLoadStrategy.Optimized,
        epoch,
      );
      return this.#getWithStrategy(
        canonicalLookup,
        MetadataLoadStrategy.Classic,
        epoch,
      );
    }
  }

  invalidate(structural: MetadataStructuralKey): boolean {
    const canonicalStructural = canonicalizeStructuralKey(structural);
    const removed = this.#deleteCacheEntry(canonicalStructural.id);
    this.#advanceObjectEpoch(canonicalStructural.id);
    this.#forgetAuthorizationsForStructural(canonicalStructural.id);
    for (const [key] of this.#inFlight) {
      if (key.startsWith(`${canonicalStructural.id}\n`)) {
        this.#inFlight.delete(key);
      }
    }
    this.#invalidations += 1;
    this.#report?.({
      category: "metadata",
      level: "info",
      code: "metadata.invalidated",
      phase: "metadata",
      count: removed ? 1 : 0,
    });
    return removed;
  }

  invalidateAll(): number {
    const removed = this.#cache.size;
    this.#cache.clear();
    this.#retainedBytes = 0;
    this.#inFlight.clear();
    this.#authorizations.clear();
    this.#probes.clear();
    this.#objectEpochs.clear();
    this.#globalEpoch += 1n;
    this.#invalidations += 1;
    this.#report?.({
      category: "metadata",
      level: "info",
      code: "metadata.invalidated",
      phase: "metadata",
      count: removed,
    });
    return removed;
  }

  retire(): Promise<void> {
    const inheritedContext = metadataRetirementContext.getStore();
    if (inheritedContext?.owners.has(this) === true) {
      return this.#reentrantRetirementAcknowledgement;
    }
    if (this.#retirement !== undefined) return this.#retirement;
    const owners = new Set(inheritedContext?.owners);
    owners.add(this);
    const context: MetadataRetirementContext = Object.freeze({ owners });
    const retirement = Promise.resolve().then(async () => {
      // No operation can be admitted after the state transition. Loop so this
      // also remains correct if a tracked chain is replaced before it observes
      // that retirement has begun.
      while (this.#activeOperations.size > 0) {
        await Promise.allSettled([...this.#activeOperations]);
      }
    });
    // Publish before abort listeners run: a cooperative adapter may reenter
    // retire() synchronously from its generation-retirement signal.
    this.#retirement = retirement;
    this.#state = "retired";
    metadataRetirementContext.run(context, () => {
      this.#retirementController.abort(canceledWait());
    });
    this.invalidateAll();
    return retirement;
  }

  monitor(): MetadataRepositoryMonitor {
    return Object.freeze({
      state: this.#state,
      entries: this.#cache.size,
      retainedBytes: this.#retainedBytes,
      lookups: this.#lookups,
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
      loadsStarted: this.#loadsStarted,
      loadsSucceeded: this.#loadsSucceeded,
      loadsFailed: this.#loadsFailed,
      inFlight: this.#activeLoads,
      inFlightJoins: this.#inFlightJoins,
      evictions: this.#evictions,
      oversizeSkips: this.#oversizeSkips,
      invalidations: this.#invalidations,
      optimizedProbeCalls: this.#optimizedProbeCalls,
      optimizedProbeHits: this.#optimizedProbeHits,
      optimizedFallbacks: this.#optimizedFallbacks,
      authorizationCalls: this.#authorizationCalls,
      authorizationHits: this.#authorizationHits,
      authorizationFailures: this.#authorizationFailures,
      maxProbeEntries: this.#maxProbeEntries,
      probeEntries: this.#probes.size,
      probeInFlight: this.#activeProbes,
      probeEvictions: this.#probeEvictions,
      probeCapacityRejections: this.#probeCapacityRejections,
      maxAuthorizationEntries: this.#maxAuthorizationEntries,
      authorizationEntries: this.#authorizations.size,
      authorizationInFlight: this.#activeAuthorizations,
      authorizationEvictions: this.#authorizationEvictions,
      authorizationCapacityRejections:
        this.#authorizationCapacityRejections,
      maxObjectEpochEntries: this.#maxObjectEpochEntries,
      objectEpochEntries: this.#objectEpochs.size,
      objectEpochCompactions: this.#objectEpochCompactions,
      maxInFlightLoads: this.#maxInFlightLoads,
      trackedInFlight: this.#inFlight.size,
      inFlightCapacityRejections: this.#inFlightCapacityRejections,
      maxSnapshotNodes: this.#maxSnapshotNodes,
      maxSnapshotDepth: this.#maxSnapshotDepth,
      maxSnapshotProperties: this.#maxSnapshotProperties,
    });
  }

  #assertActive(): void {
    if (this.#state !== "active") {
      throw new Error("metadata repository is retired");
    }
  }

  #epochFor(structuralId: string): OperationEpoch {
    return Object.freeze({
      global: this.#globalEpoch,
      object: this.#objectEpochs.get(structuralId) ?? 0n,
    });
  }

  #epochMatches(structuralId: string, epoch: OperationEpoch): boolean {
    return (
      this.#globalEpoch === epoch.global &&
      (this.#objectEpochs.get(structuralId) ?? 0n) === epoch.object
    );
  }

  #advanceObjectEpoch(structuralId: string): void {
    const existing = this.#objectEpochs.get(structuralId);
    if (existing !== undefined) {
      this.#objectEpochs.delete(structuralId);
      this.#objectEpochs.set(structuralId, existing + 1n);
      return;
    }
    if (this.#objectEpochs.size < this.#maxObjectEpochEntries) {
      this.#objectEpochs.set(structuralId, 1n);
      return;
    }

    // Dropping an object epoch in isolation could make a pre-invalidation
    // operation match the default epoch again. Advance the global identity and
    // clear every epoch-qualified admission instead.
    this.#globalEpoch += 1n;
    this.#objectEpochs.clear();
    this.#authorizations.clear();
    this.#inFlight.clear();
    this.#objectEpochCompactions += 1;
  }

  async #selectStrategy(
    lookup: CanonicalMetadataLookup,
  ): Promise<MetadataLoadStrategy> {
    switch (lookup.mode) {
      case MetadataRepositoryMode.Classic:
        return MetadataLoadStrategy.Classic;
      case MetadataRepositoryMode.LegacyV3:
        return MetadataLoadStrategy.LegacyV3;
      case MetadataRepositoryMode.Auto:
      case MetadataRepositoryMode.OptimizedOnly: {
        const probe = await this.#probeOptimized(lookup);
        if (probe.available) return MetadataLoadStrategy.Optimized;
        if (lookup.mode === MetadataRepositoryMode.Auto) {
          this.#optimizedFallbacks += 1;
          return MetadataLoadStrategy.Classic;
        }
        throw new MetadataAccessFailure(
          probe.fallbackClassification!,
          `optimized metadata is ${probe.fallbackClassification}`,
        );
      }
    }
  }

  async #probeOptimized(
    lookup: CanonicalMetadataLookup,
  ): Promise<ProbeResult> {
    const key = lookup.capabilityIdentity;
    const existing = this.#probes.get(key);
    if (existing !== undefined) {
      this.#optimizedProbeHits += 1;
      if (existing.promise !== undefined) return existing.promise;
      this.#probes.delete(key);
      this.#probes.set(key, existing);
      return existing.result!;
    }
    if (this.#activeProbes >= this.#maxProbeEntries) {
      this.#probeCapacityRejections += 1;
      throw capacityError("probe", this.#maxProbeEntries);
    }
    if (this.#probes.size >= this.#maxProbeEntries) {
      let evicted = false;
      for (const [candidateKey, candidate] of this.#probes) {
        if (candidate.promise === undefined) {
          this.#probes.delete(candidateKey);
          this.#probeEvictions += 1;
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        this.#probeCapacityRejections += 1;
        throw capacityError("probe", this.#maxProbeEntries);
      }
    }

    this.#optimizedProbeCalls += 1;
    this.#activeProbes += 1;
    const context: MetadataProbeContext = Object.freeze({
      capability: lookup.capability,
      mode: lookup.mode,
      signal: this.#retirementController.signal,
    });
    let pending!: Promise<ProbeResult>;
    pending = Promise.resolve().then(
      () => this.#adapter.probeOptimized(context),
    ).then(
      () => AVAILABLE_PROBE,
      (error: unknown) => {
        const classification = accessClassification(error);
        if (
          classification !== "unavailable" &&
          classification !== "authorization"
        ) {
          throw error;
        }
        return Object.freeze({
          available: false,
          fallbackClassification: classification,
        });
      },
    ).then(
      (result) => {
        if (this.#probes.get(key)?.promise === pending) {
          this.#probes.set(key, { result });
        }
        return result;
      },
      (error: unknown) => {
        if (this.#probes.get(key)?.promise === pending) {
          this.#probes.delete(key);
        }
        throw error;
      },
    ).finally(() => {
      this.#activeProbes -= 1;
    });
    this.#trackOperation(pending);
    this.#probes.set(key, { promise: pending });
    return pending;
  }

  async #getWithStrategy(
    lookup: CanonicalMetadataLookup,
    strategy: MetadataLoadStrategy,
    epoch: OperationEpoch,
  ): Promise<T> {
    this.#assertActive();
    let admissionEpoch = epoch;
    while (true) {
      await this.#authorize(lookup, strategy, admissionEpoch);
      this.#assertActive();
      if (this.#epochMatches(lookup.structural.id, admissionEpoch)) break;
      this.#forgetAuthorization(lookup, strategy, admissionEpoch);
      admissionEpoch = this.#epochFor(lookup.structural.id);
    }

    const cached = this.#cache.get(lookup.structural.id);
    if (cached !== undefined) {
      this.#cacheHits += 1;
      this.#report?.({
        category: "metadata",
        level: "debug",
        code: "metadata.cache-hit",
        phase: "metadata",
        count: 1,
      });
      this.#cache.delete(lookup.structural.id);
      this.#cache.set(lookup.structural.id, cached);
      return cached.value;
    }
    this.#cacheMisses += 1;
    this.#report?.({
      category: "metadata",
      level: "debug",
      code: "metadata.cache-miss",
      phase: "metadata",
      count: 1,
    });

    const inFlightKey =
      `${lookup.structural.id}\n${lookup.capabilityIdentity}\n${strategy}\n` +
      epochIdentity(admissionEpoch);
    const existing = this.#inFlight.get(inFlightKey);
    if (existing !== undefined) {
      this.#inFlightJoins += 1;
      try {
        return await existing;
      } catch (error) {
        this.#forgetAuthorization(lookup, strategy, admissionEpoch);
        throw error;
      }
    }
    if (this.#activeLoads >= this.#maxInFlightLoads) {
      this.#inFlightCapacityRejections += 1;
      throw capacityError("load", this.#maxInFlightLoads);
    }

    const context: MetadataAccessContext = Object.freeze({
      structural: lookup.structural,
      capability: lookup.capability,
      mode: lookup.mode,
      strategy,
      signal: this.#retirementController.signal,
    });
    this.#loadsStarted += 1;
    this.#activeLoads += 1;
    let pending!: Promise<T>;
    pending = Promise.resolve()
      .then(() => this.#adapter.load(context))
      .then((rawSnapshot) => {
        const snapshot = normalizeSnapshot(
          rawSnapshot,
          this.#maxSnapshotNodes,
          this.#maxSnapshotDepth,
          this.#maxSnapshotProperties,
        );
        this.#loadsSucceeded += 1;
        if (
          this.#state === "active" &&
          this.#epochMatches(lookup.structural.id, admissionEpoch)
        ) {
          return this.#cacheSnapshot(lookup.structural, snapshot);
        }
        return snapshot.value;
      })
      .catch((error: unknown) => {
        this.#loadsFailed += 1;
        throw error;
      })
      .finally(() => {
        this.#activeLoads -= 1;
        if (this.#inFlight.get(inFlightKey) === pending) {
          this.#inFlight.delete(inFlightKey);
        }
      });
    this.#trackOperation(pending);
    this.#inFlight.set(inFlightKey, pending);
    try {
      return await pending;
    } catch (error) {
      this.#forgetAuthorization(lookup, strategy, admissionEpoch);
      throw error;
    }
  }

  async #authorize(
    lookup: CanonicalMetadataLookup,
    strategy: MetadataLoadStrategy,
    epoch: OperationEpoch,
  ): Promise<void> {
    const key = this.#authorizationKey(lookup, strategy, epoch);
    const existing = this.#authorizations.get(key);
    if (existing !== undefined) {
      this.#authorizationHits += 1;
      if (existing.promise !== undefined) {
        await existing.promise;
      } else {
        this.#authorizations.delete(key);
        this.#authorizations.set(key, existing);
      }
      return;
    }

    if (this.#activeAuthorizations >= this.#maxAuthorizationEntries) {
      this.#authorizationCapacityRejections += 1;
      throw capacityError("authorization", this.#maxAuthorizationEntries);
    }
    if (this.#authorizations.size >= this.#maxAuthorizationEntries) {
      let evicted = false;
      for (const [candidateKey, candidate] of this.#authorizations) {
        if (candidate.promise === undefined) {
          this.#authorizations.delete(candidateKey);
          this.#authorizationEvictions += 1;
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        this.#authorizationCapacityRejections += 1;
        throw capacityError(
          "authorization",
          this.#maxAuthorizationEntries,
        );
      }
    }

    this.#authorizationCalls += 1;
    this.#activeAuthorizations += 1;
    const context: MetadataAccessContext = Object.freeze({
      structural: lookup.structural,
      capability: lookup.capability,
      mode: lookup.mode,
      strategy,
      signal: this.#retirementController.signal,
    });
    let pending!: Promise<void>;
    pending = Promise.resolve().then(
      () => this.#adapter.authorize(context),
    ).then(
      () => {
        const current = this.#authorizations.get(key);
        if (
          current?.promise === pending &&
          this.#state === "active" &&
          this.#epochMatches(lookup.structural.id, epoch)
        ) {
          this.#authorizations.set(key, {
            structuralId: lookup.structural.id,
          });
        } else if (current?.promise === pending) {
          this.#authorizations.delete(key);
        }
      },
      (error: unknown) => {
        this.#authorizationFailures += 1;
        if (this.#authorizations.get(key)?.promise === pending) {
          this.#authorizations.delete(key);
        }
        throw error;
      },
    ).finally(() => {
      this.#activeAuthorizations -= 1;
    });
    this.#trackOperation(pending);
    this.#authorizations.set(key, {
      structuralId: lookup.structural.id,
      promise: pending,
    });
    await pending;
  }

  #trackOperation(operation: Promise<unknown>): void {
    this.#activeOperations.add(operation);
    const remove = (): void => {
      this.#activeOperations.delete(operation);
    };
    void operation.then(remove, remove);
  }

  #authorizationKey(
    lookup: CanonicalMetadataLookup,
    strategy: MetadataLoadStrategy,
    epoch: OperationEpoch,
  ): string {
    return tupleId([
      lookup.capabilityIdentity,
      strategy,
      lookup.structural.id,
      epochIdentity(epoch),
    ]);
  }

  #forgetAuthorization(
    lookup: CanonicalMetadataLookup,
    strategy: MetadataLoadStrategy,
    epoch: OperationEpoch,
  ): void {
    this.#authorizations.delete(
      this.#authorizationKey(lookup, strategy, epoch),
    );
  }

  #rememberOptimizedFallback(
    lookup: CanonicalMetadataLookup,
    error: unknown,
    epoch: OperationEpoch,
  ): void {
    const classification = accessClassification(error);
    if (
      this.#state !== "active" ||
      !this.#epochMatches(lookup.structural.id, epoch) ||
      (classification !== "unavailable" &&
        classification !== "authorization")
    ) {
      return;
    }
    const key = lookup.capabilityIdentity;
    const existing = this.#probes.get(key);
    if (existing?.promise !== undefined) return;
    if (existing === undefined && this.#probes.size >= this.#maxProbeEntries) {
      let evicted = false;
      for (const [candidateKey, candidate] of this.#probes) {
        if (candidate.promise === undefined) {
          this.#probes.delete(candidateKey);
          this.#probeEvictions += 1;
          evicted = true;
          break;
        }
      }
      // A fallback remains correct for this call even when every bounded
      // capability slot is physically active; only its reuse is skipped.
      if (!evicted) return;
    }
    this.#probes.delete(key);
    this.#probes.set(key, {
      result: Object.freeze({
        available: false,
        fallbackClassification: classification,
      }),
    });
  }

  #cacheSnapshot(
    structural: MetadataStructuralKey,
    snapshot: MetadataSnapshot<T>,
  ): T {
    const existing = this.#cache.get(structural.id);
    if (existing !== undefined) {
      this.#cache.delete(structural.id);
      this.#cache.set(structural.id, existing);
      return existing.value;
    }
    if (
      this.#maxEntries === 0 ||
      snapshot.retainedBytes > this.#maxRetainedBytes
    ) {
      this.#oversizeSkips += 1;
      this.#forgetAuthorizationsForStructural(structural.id);
      return snapshot.value;
    }

    while (
      this.#cache.size >= this.#maxEntries ||
      this.#retainedBytes >
        this.#maxRetainedBytes - snapshot.retainedBytes
    ) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        throw new Error("metadata cache accounting invariant was violated");
      }
      this.#deleteCacheEntry(oldest);
      this.#evictions += 1;
    }
    const retainedBytes = this.#retainedBytes + snapshot.retainedBytes;
    if (!Number.isSafeInteger(retainedBytes)) {
      throw new Error("metadata cache retained-byte sum is unsafe");
    }
    this.#cache.set(structural.id, {
      structural,
      value: snapshot.value,
      retainedBytes: snapshot.retainedBytes,
    });
    this.#retainedBytes = retainedBytes;
    return snapshot.value;
  }

  #deleteCacheEntry(structuralId: string): boolean {
    const entry = this.#cache.get(structuralId);
    if (entry === undefined) return false;
    this.#cache.delete(structuralId);
    const retainedBytes = this.#retainedBytes - entry.retainedBytes;
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) {
      throw new Error("metadata cache retained-byte subtraction is unsafe");
    }
    this.#retainedBytes = retainedBytes;
    this.#forgetAuthorizationsForStructural(structuralId);
    return true;
  }

  #forgetAuthorizationsForStructural(structuralId: string): void {
    for (const [key, value] of this.#authorizations) {
      if (value.structuralId === structuralId) this.#authorizations.delete(key);
    }
  }
}
