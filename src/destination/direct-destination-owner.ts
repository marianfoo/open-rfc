import { AsyncLocalStorage } from "node:async_hooks";

import type { RfcDiagnosticEmitter } from
  "../diagnostics/structured-diagnostics.js";
import {
  DirectCpicPreWireError,
  DirectCpicSession,
  type DirectCpicPingResult,
  type DirectCpicSessionInfo,
  type DirectCpicTransportFactory,
} from "../client/direct-cpic-session.js";
import {
  classicInvocationRecursiveMetadataParameters,
  classifyClassicInvocationMetadataNeeds,
} from "../client/classic-invocation.js";
import type {
  ClassicRfcInvocationOptions,
  ClassicRfcOutput,
} from "../client/classic-invocation.js";
import {
  snapshotRfcCallbackHandlers,
  type RfcCallbackHandlers,
} from "../protocol/rfc-callback.js";
import {
  RfcConnectionDisposition,
  RfcCoreError,
  RfcFailureCategory,
} from "../client/rfc-failure.js";
import type { NormalizedDirectConnection } from "../compat/connection-parameters.js";
import type { RecursiveSerializerDecisionProvider } from
  "../values/recursive-serializer-classification.js";
import {
  ConnectionPoolRuntime,
  type ConnectionPoolAcquireOptions,
  type ConnectionPoolLease,
  type ConnectionPoolMonitor,
  type ConnectionPoolScheduler,
} from "../pool/connection-pool-runtime.js";
import {
  DestinationConfigurationGeneration,
  type DestinationConfiguration,
  type DestinationIdentityInput,
} from "./configuration-generation.js";
import {
  RfcDestinationRuntime,
  type DestinationMetadataDescriptor,
  type RfcDestinationRuntimeMonitor,
} from "./runtime.js";
import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import {
  MetadataAccessFailure,
  MetadataLoadStrategy,
  MetadataRepositoryMode,
  MetadataRepositoryRuntime,
  type MetadataAccessContext,
  type MetadataRepositoryMonitor,
  type MetadataSnapshot,
  type MetadataStructuralKey,
} from "../metadata/repository-runtime.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import { snapshotClassicInt8Mode } from "../values/classic-int8.js";
import { snapshotClassicBcdMode } from "../values/classic-bcd.js";
import {
  type RfcMetadataGetFunctionResult,
  type RfcMetadataGetRecursiveFunctionResult,
  type RfcMetadataGetStructureResult,
  type RfcMetadataTimestampBatch,
} from "../metadata/rfc-metadata-get.js";
import { RecursiveMetadataError } from "../metadata/recursive-metadata.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import { createRecursiveMetadataParameterIndex } from
  "../metadata/recursive-parameter-index.js";
import { resolveRecursiveXrfcParameterFromIndex } from
  "../values/recursive-xrfc.js";
import {
  SessionContextRuntime,
  type SessionContextRuntimeMonitor,
  type SessionContextToken,
} from "../lifecycle/session-context-runtime.js";
import type {
  TransactionFailureKind,
  TransactionInvocation,
  TransactionLeaseAdapter,
} from "../lifecycle/transaction-runtime.js";
import { snapshotRfcValue } from "../values/rfc-value-snapshot.js";

export type DirectDestinationLane = "application" | "repository";

export interface DirectDestinationSessionOpenContext {
  readonly lane: DirectDestinationLane;
  /** Pool-owned lifecycle signal; an implementation must stop I/O on abort. */
  readonly signal: AbortSignal;
}

export interface DirectDestinationSelectedSession {
  readonly session: DirectCpicSession;
  readonly selectedConnection: NormalizedDirectConnection;
}

export type DirectDestinationSessionOpenResult =
  | DirectCpicSession
  | DirectDestinationSelectedSession;

/** Injectable authenticated-session boundary used by deterministic tests. */
export interface DirectDestinationSessionFactory {
  open(
    connection: NormalizedDirectConnection,
    context: DirectDestinationSessionOpenContext,
  ): DirectDestinationSessionOpenResult |
    PromiseLike<DirectDestinationSessionOpenResult>;
}

export interface DirectDestinationSessionOptions {
  readonly programName?: string;
  readonly localAddress?: string;
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly transportFactory?: DirectCpicTransportFactory;
  readonly recursiveSerializerDecisionProvider?: RecursiveSerializerDecisionProvider;
  readonly callbacks?: RfcCallbackHandlers;
}

export interface DirectDestinationPoolOptions {
  readonly maxConnections?: number;
  readonly maxWaiters?: number;
  readonly acquireTimeoutMs?: number;
  readonly lifecycleTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly lowWater?: number;
  readonly idleHigh?: number;
  readonly validateOnCheckout?: boolean;
  readonly scheduler?: ConnectionPoolScheduler;
  readonly lifecycleScheduler?: ConnectionPoolScheduler;
  readonly diagnostics?: RfcDiagnosticEmitter;
}

export interface DirectDestinationMetadataOptions {
  readonly maxEntries?: number;
  readonly maxRetainedBytes?: number;
  readonly maxProbeEntries?: number;
  readonly maxAuthorizationEntries?: number;
  readonly maxObjectEpochEntries?: number;
  readonly maxInFlightLoads?: number;
  readonly maxSnapshotNodes?: number;
  readonly maxSnapshotDepth?: number;
  readonly maxSnapshotProperties?: number;
  readonly diagnostics?: RfcDiagnosticEmitter;
}

export interface DirectDestinationOwnerOptions {
  /** Already normalized direct-application-server connection data. */
  readonly connection: NormalizedDirectConnection;
  readonly generationId: string;
  readonly identity: DestinationIdentityInput;
  readonly repositoryMode?: MetadataRepositoryMode;
  readonly sessionFactory?: DirectDestinationSessionFactory;
  readonly session?: DirectDestinationSessionOptions;
  readonly applicationPool?: DirectDestinationPoolOptions;
  readonly repositoryPool?: DirectDestinationPoolOptions;
  readonly metadata?: DirectDestinationMetadataOptions;
}

export interface DirectDestinationInvocation
  extends ClassicRfcInvocationOptions {
  readonly functionName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface DirectDestinationReleaseOptions {
  readonly reusable?: boolean;
  /** Reset the same physical session after the operation tail, before reuse. */
  readonly reset?: boolean;
  /** Optional idle-retention cap for this application recycle handoff. */
  readonly idleHigh?: number;
}

const applicationLeaseBrand: unique symbol = Symbol(
  "open-rfc direct destination application lease",
);

/** Nominal, resource-free token. Its DirectCpicSession remains owner-private. */
export interface DirectDestinationApplicationLease {
  readonly [applicationLeaseBrand]: true;
}

export interface DirectDestinationOwnerMonitor {
  readonly state: "active" | "retiring" | "retired";
  readonly destination: RfcDestinationRuntimeMonitor;
  readonly metadata: MetadataRepositoryMonitor;
  readonly applicationPool: ConnectionPoolMonitor;
  readonly repositoryPool: ConnectionPoolMonitor;
  readonly contexts: SessionContextRuntimeMonitor;
  readonly applicationLeases: number;
  readonly contextPinnedApplicationLeases: number;
  readonly ordinaryApplicationLeases: number;
  readonly activeApplicationOperations: number;
  /** Release handoffs waiting for a previously admitted operation to settle. */
  readonly quarantinedApplicationTails: number;
  /** Same-response generation tokens retained for optimized descriptors. */
  readonly optimizedGenerationTokens: number;
  readonly maxOptimizedGenerationTokens: number;
  /** Explicit timestamp refreshes are bounded to one physical batch. */
  readonly metadataRefreshInFlight: 0 | 1;
}

export interface DirectDestinationMetadataRefreshResult {
  readonly checkedFunctionNames: readonly string[];
  readonly checkedStructureNames: readonly string[];
  readonly invalidatedFunctionNames: readonly string[];
  readonly invalidatedStructureNames: readonly string[];
}

/** A failure proven to have happened before the application lease was entered. */
export class DirectDestinationMetadataPreflightError extends Error {
  readonly functionName: string;

  constructor(functionName: string, cause: unknown) {
    super(`metadata preflight failed for RFC function ${functionName}`, {
      cause,
    });
    this.name = "DirectDestinationMetadataPreflightError";
    this.functionName = functionName;
  }
}

interface CanonicalSessionOptions {
  readonly programName: string;
  readonly localAddress?: string;
  readonly connectTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly transportFactory?: DirectCpicTransportFactory;
  readonly recursiveSerializerDecisionProvider?: RecursiveSerializerDecisionProvider;
  readonly callbacks?: RfcCallbackHandlers;
}

interface CanonicalPoolOptions {
  readonly maxConnections: number;
  readonly maxWaiters: number;
  readonly acquireTimeoutMs: number;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly lowWater: number;
  readonly idleHigh: number;
  readonly validateOnCheckout: boolean;
  readonly scheduler?: ConnectionPoolScheduler;
  readonly lifecycleScheduler?: ConnectionPoolScheduler;
  readonly diagnostics?: RfcDiagnosticEmitter;
}

interface CanonicalMetadataOptions {
  readonly maxEntries: number;
  readonly maxRetainedBytes: number;
  readonly maxProbeEntries?: number;
  readonly maxAuthorizationEntries?: number;
  readonly maxObjectEpochEntries?: number;
  readonly maxInFlightLoads?: number;
  readonly maxSnapshotNodes?: number;
  readonly maxSnapshotDepth?: number;
  readonly maxSnapshotProperties?: number;
  readonly diagnostics?: RfcDiagnosticEmitter;
}

interface PoolOptionDefaults {
  readonly maxConnections: number;
  readonly maxWaiters: number;
  readonly acquireTimeoutMs: number;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly lowWater: number;
  readonly validateOnCheckout: boolean;
}

interface LaneOpenScope {
  readonly lane: DirectDestinationLane;
  readonly signal: AbortSignal;
}

interface BoundDirectSession {
  readonly info: DirectCpicSessionInfo;
  readonly ping: (signal?: AbortSignal) => Promise<DirectCpicPingResult>;
  readonly close: () => Promise<void>;
  readonly reset: (signal?: AbortSignal) => Promise<void>;
  readonly getFunctionInterface: (
    name: string,
    signal?: AbortSignal,
  ) => Promise<RfcFunctionInterface>;
  readonly getStructureDefinition: (
    name: string,
    signal?: AbortSignal,
  ) => Promise<RfcStructureDefinition>;
  readonly getLegacyStructureDefinition: (
    name: string,
    signal?: AbortSignal,
  ) => Promise<RfcStructureDefinition>;
  readonly getOptimizedFunctionInterface: (
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<RfcFunctionInterface>;
  readonly getOptimizedStructureDefinition: (
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<RfcStructureDefinition>;
  readonly getOptimizedFunctionDescriptor: (
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<BoundOptimizedDescriptor<RfcFunctionInterface>>;
  readonly getOptimizedRecursiveFunctionDescriptor: (
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<BoundOptimizedDescriptor<RecursiveMetadataGraph>>;
  readonly getOptimizedStructureDescriptor: (
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<BoundOptimizedDescriptor<RfcStructureDefinition>>;
  readonly getOptimizedMetadataTimestamps: (
    functionNames: readonly string[],
    structureNames: readonly string[],
    signal?: AbortSignal,
  ) => Promise<RfcMetadataTimestampBatch>;
  readonly invoke: (
    metadata: RfcFunctionInterface,
    input: Readonly<Record<string, unknown>>,
    structures: ReadonlyMap<string, RfcStructureDefinition>,
    signal: AbortSignal | undefined,
    options: ClassicRfcInvocationOptions,
    recursiveGraph?: RecursiveMetadataGraph,
  ) => Promise<ClassicRfcOutput>;
}

interface BoundOptimizedDescriptor<T extends object> {
  readonly value: T;
  /** Absent only for a legacy injected test/session boundary. */
  readonly generationToken?: string;
}

interface OptimizedGenerationRecord {
  readonly structural: MetadataStructuralKey;
  readonly token: string;
}

interface MetadataRefreshAdmission {
  readonly functionNames: readonly string[];
  readonly structureNames: readonly string[];
  readonly functionRecords: readonly (
    readonly OptimizedGenerationRecord[]
  )[];
  readonly structureRecords: readonly (OptimizedGenerationRecord | undefined)[];
}

interface MetadataRefreshOperation {
  readonly key: string;
  readonly promise: Promise<DirectDestinationMetadataRefreshResult>;
}

interface ApplicationLeaseRecord {
  readonly poolLease: ConnectionPoolLease<BoundDirectSession>;
  state: "owned" | "releaseClaimed" | "released";
  active: boolean;
  tail?: Promise<void>;
}

interface Completion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const safeApply = Reflect.apply;
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_APPLICATION_POOL = Object.freeze({
  // Covers the archived node-rfc retained-4 plus acquire-5 pool sequence.
  maxConnections: 32,
  maxWaiters: 128,
  acquireTimeoutMs: 30_000,
  lifecycleTimeoutMs: 45_000,
  shutdownTimeoutMs: 60_000,
  lowWater: 0,
  validateOnCheckout: true,
});
const DEFAULT_REPOSITORY_POOL = Object.freeze({
  maxConnections: 2,
  maxWaiters: 64,
  acquireTimeoutMs: 30_000,
  lifecycleTimeoutMs: 45_000,
  shutdownTimeoutMs: 60_000,
  lowWater: 0,
  validateOnCheckout: true,
});
const DEFAULT_METADATA = Object.freeze({
  maxEntries: 512,
  maxRetainedBytes: 64 * 1_024 * 1_024,
  maxProbeEntries: 64,
  maxAuthorizationEntries: 1_024,
  maxObjectEpochEntries: 1_024,
  maxInFlightLoads: 64,
  maxSnapshotNodes: 100_000,
  maxSnapshotDepth: 256,
  maxSnapshotProperties: 1_000_000,
});

function callable(value: unknown, path: string): Function {
  if (typeof value !== "function") throw new TypeError(`${path} must be a function`);
  return value;
}

function nonEmptyText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function classicMetadataObjectName(value: unknown, path: string): string {
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

function finiteTimeout(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > MAX_TIMER_MS
  ) {
    throw new RangeError(`${path} must be finite and in 1..${MAX_TIMER_MS}`);
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function snapshotConnection(
  input: NormalizedDirectConnection,
): NormalizedDirectConnection {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("connection must be normalized direct connection data");
  }
  const host = nonEmptyText(input.host, "connection.host");
  const applicationServerHost = nonEmptyText(
    input.applicationServerHost,
    "connection.applicationServerHost",
  );
  const port = input.port;
  const applicationServerService = nonEmptyText(
    input.applicationServerService,
    "connection.applicationServerService",
  );
  const client = nonEmptyText(input.client, "connection.client");
  const user = nonEmptyText(input.user, "connection.user");
  const rawPassword = input.password;
  const rawTicket = input.ticket;
  if ((rawPassword === undefined) === (rawTicket === undefined)) {
    throw new TypeError(
      "connection requires exactly one of password or ticket",
    );
  }
  const credential = rawTicket === undefined
    ? { password: nonEmptyText(rawPassword, "connection.password") }
    : { ticket: nonEmptyText(rawTicket, "connection.ticket") };
  const language = nonEmptyText(input.language, "connection.language");
  const sysnr = nonEmptyText(input.sysnr, "connection.sysnr");
  const cpicStreaming = input.cpicStreaming;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("connection.port must be an integer in 1..65535");
  }
  if (!/^\d{2}$/u.test(sysnr)) {
    throw new RangeError("connection.sysnr must contain two decimal digits");
  }
  if (applicationServerService !== `sapdp${sysnr}`) {
    throw new RangeError(
      "connection.applicationServerService must match connection.sysnr",
    );
  }
  if (!/^\d{3}$/u.test(client)) {
    throw new RangeError("connection.client must contain three decimal digits");
  }
  if (!/^[A-Z0-9]$/u.test(language)) {
    throw new RangeError("connection.language must be one SAP language code");
  }
  if (cpicStreaming !== "disabled" && cpicStreaming !== "enabled") {
    throw new RangeError("connection.cpicStreaming must be disabled or enabled");
  }
  return Object.freeze({
    host,
    applicationServerHost,
    port,
    applicationServerService,
    client,
    user,
    ...credential,
    language,
    sysnr,
    cpicStreaming,
  });
}

function snapshotIdentity(input: DestinationIdentityInput): DestinationIdentityInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("identity must be an object");
  }
  return Object.freeze({
    destinationId: nonEmptyText(input.destinationId, "identity.destinationId"),
    endpointId: nonEmptyText(input.endpointId, "identity.endpointId"),
    systemId: nonEmptyText(input.systemId, "identity.systemId"),
    client: nonEmptyText(input.client, "identity.client"),
    release: nonEmptyText(input.release, "identity.release"),
    metadataGeneration: nonEmptyText(
      input.metadataGeneration,
      "identity.metadataGeneration",
    ),
    language: nonEmptyText(input.language, "identity.language"),
    applicationPrincipalId: nonEmptyText(
      input.applicationPrincipalId,
      "identity.applicationPrincipalId",
    ),
    repositoryPrincipalId: nonEmptyText(
      input.repositoryPrincipalId,
      "identity.repositoryPrincipalId",
    ),
  });
}

function snapshotSessionOptions(
  input: DirectDestinationSessionOptions | undefined,
): CanonicalSessionOptions {
  if (
    input !== undefined &&
    (typeof input !== "object" || input === null || Array.isArray(input))
  ) {
    throw new TypeError("session options must be an object");
  }
  const programName = input?.programName ?? "open-rfc";
  const localAddress = input?.localAddress;
  const connectTimeoutMs = input?.connectTimeoutMs ?? 10_000;
  const operationTimeoutMs = input?.operationTimeoutMs ?? 30_000;
  const transportFactory = input?.transportFactory;
  const recursiveSerializerDecisionProvider =
    input?.recursiveSerializerDecisionProvider;
  const callbacks = input?.callbacks;
  if (!/^[\x20-\x7e]{1,64}$/u.test(programName)) {
    throw new RangeError("session programName must contain 1..64 ASCII bytes");
  }
  if (
    localAddress !== undefined &&
    (typeof localAddress !== "string" || localAddress.length === 0)
  ) {
    throw new TypeError("session localAddress must be a non-empty string");
  }
  if (transportFactory !== undefined && typeof transportFactory !== "function") {
    throw new TypeError("session transportFactory must be a function");
  }
  if (
    recursiveSerializerDecisionProvider !== undefined &&
    typeof recursiveSerializerDecisionProvider !== "function"
  ) {
    throw new TypeError(
      "session recursiveSerializerDecisionProvider must be a function",
    );
  }
  // Validate and snapshot the table here; DirectCpicSession snapshots it again
  // per generation so no caller-owned object survives an asynchronous open.
  const callbackSnapshot = snapshotRfcCallbackHandlers(
    callbacks,
    "session callbacks",
  );
  const snapshottedCallbacks = callbackSnapshot === undefined
    ? undefined
    : Object.freeze(Object.fromEntries(callbackSnapshot));
  return Object.freeze({
    programName,
    ...(localAddress === undefined ? {} : { localAddress }),
    connectTimeoutMs: finiteTimeout(connectTimeoutMs, "session connectTimeoutMs"),
    operationTimeoutMs: finiteTimeout(
      operationTimeoutMs,
      "session operationTimeoutMs",
    ),
    ...(transportFactory === undefined ? {} : { transportFactory }),
    ...(recursiveSerializerDecisionProvider === undefined
      ? {}
      : {
          recursiveSerializerDecisionProvider,
        }),
    ...(snapshottedCallbacks === undefined
      ? {}
      : { callbacks: snapshottedCallbacks }),
  });
}

function snapshotPoolOptions(
  input: DirectDestinationPoolOptions | undefined,
  defaults: PoolOptionDefaults,
  path: string,
): CanonicalPoolOptions {
  if (
    input !== undefined &&
    (typeof input !== "object" || input === null || Array.isArray(input))
  ) {
    throw new TypeError(`${path} must be an object`);
  }
  const maxConnections = input?.maxConnections ?? defaults.maxConnections;
  const maxWaiters = input?.maxWaiters ?? defaults.maxWaiters;
  const acquireTimeoutMs = input?.acquireTimeoutMs ?? defaults.acquireTimeoutMs;
  const lifecycleTimeoutMs =
    input?.lifecycleTimeoutMs ?? defaults.lifecycleTimeoutMs;
  const shutdownTimeoutMs = input?.shutdownTimeoutMs ?? defaults.shutdownTimeoutMs;
  const lowWater = input?.lowWater ?? defaults.lowWater;
  const idleHigh = input?.idleHigh ?? maxConnections;
  const validateOnCheckout = optionalBoolean(
    input?.validateOnCheckout,
    defaults.validateOnCheckout,
    `${path}.validateOnCheckout`,
  );
  const scheduler = input?.scheduler;
  const lifecycleScheduler = input?.lifecycleScheduler;
  const diagnostics = input?.diagnostics;
  return Object.freeze({
    maxConnections,
    maxWaiters,
    acquireTimeoutMs,
    lifecycleTimeoutMs,
    shutdownTimeoutMs,
    lowWater,
    idleHigh,
    validateOnCheckout,
    ...(scheduler === undefined ? {} : { scheduler }),
    ...(lifecycleScheduler === undefined ? {} : { lifecycleScheduler }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

function snapshotMetadataOptions(
  input: DirectDestinationMetadataOptions | undefined,
): CanonicalMetadataOptions {
  if (
    input !== undefined &&
    (typeof input !== "object" || input === null || Array.isArray(input))
  ) {
    throw new TypeError("metadata options must be an object");
  }
  const diagnostics = input?.diagnostics;
  return Object.freeze({
    maxEntries: input?.maxEntries ?? DEFAULT_METADATA.maxEntries,
    maxRetainedBytes:
      input?.maxRetainedBytes ?? DEFAULT_METADATA.maxRetainedBytes,
    maxProbeEntries: input?.maxProbeEntries ?? DEFAULT_METADATA.maxProbeEntries,
    maxAuthorizationEntries:
      input?.maxAuthorizationEntries ?? DEFAULT_METADATA.maxAuthorizationEntries,
    maxObjectEpochEntries:
      input?.maxObjectEpochEntries ?? DEFAULT_METADATA.maxObjectEpochEntries,
    maxInFlightLoads:
      input?.maxInFlightLoads ?? DEFAULT_METADATA.maxInFlightLoads,
    maxSnapshotNodes:
      input?.maxSnapshotNodes ?? DEFAULT_METADATA.maxSnapshotNodes,
    maxSnapshotDepth:
      input?.maxSnapshotDepth ?? DEFAULT_METADATA.maxSnapshotDepth,
    maxSnapshotProperties:
      input?.maxSnapshotProperties ?? DEFAULT_METADATA.maxSnapshotProperties,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

function createProductionSessionFactory(
  options: CanonicalSessionOptions,
): DirectDestinationSessionFactory {
  const openSession = callable(
    DirectCpicSession.open,
    "DirectCpicSession.open",
  );
  return Object.freeze({
    async open(
      connection: NormalizedDirectConnection,
      context: DirectDestinationSessionOpenContext,
    ): Promise<DirectCpicSession> {
      const session = await safeApply(openSession, DirectCpicSession, [{
        host: connection.host,
        port: connection.port,
        applicationServerHost: connection.applicationServerHost,
        applicationServerService: connection.applicationServerService,
        programName: options.programName,
        localAddress: options.localAddress,
        connectTimeoutMs: options.connectTimeoutMs,
        operationTimeoutMs: options.operationTimeoutMs,
        transportFactory: options.transportFactory,
        signal: context.signal,
        cpicStreaming: connection.cpicStreaming,
        ...(options.recursiveSerializerDecisionProvider === undefined
          ? {}
          : {
              recursiveSerializerDecisionProvider:
                options.recursiveSerializerDecisionProvider,
            }),
        ...(options.callbacks === undefined
          ? {}
          : { callbacks: options.callbacks }),
      }]) as DirectCpicSession;
      const logon = callable(session.logonAndPing, "session.logonAndPing");
      const close = callable(session.close, "session.close");
      try {
        await safeApply(logon, session, [{
          client: connection.client,
          user: connection.user,
          ...(connection.ticket === undefined
            ? { password: connection.password }
            : { ticket: connection.ticket }),
          language: connection.language,
        }, context.signal]);
        return session;
      } catch (error) {
        try {
          await safeApply(close, session, []);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "direct CPIC logon and session cleanup both failed",
            { cause: error },
          );
        }
        throw error;
      }
    },
  });
}

/**
 * Internal composition helper for route adapters which must resolve a direct
 * endpoint immediately before each physical pool connection is created.
 */
export function createProductionDirectDestinationSessionFactory(
  options?: DirectDestinationSessionOptions,
): DirectDestinationSessionFactory {
  return createProductionSessionFactory(snapshotSessionOptions(options));
}

interface CanonicalOpenedSession {
  readonly session: DirectCpicSession;
  readonly selectedConnection?: NormalizedDirectConnection;
}

function bindSessionFactory(
  factory: DirectDestinationSessionFactory,
): (
  connection: NormalizedDirectConnection,
  context: DirectDestinationSessionOpenContext,
) => Promise<CanonicalOpenedSession> {
  if (
    (typeof factory !== "object" && typeof factory !== "function") ||
    factory === null
  ) {
    throw new TypeError("sessionFactory must be an object");
  }
  const open = callable(factory.open, "sessionFactory.open");
  return async (connection, context) => {
    const opened = await Promise.resolve(
      safeApply(open, factory, [connection, context]),
    ) as DirectDestinationSessionOpenResult;
    if (typeof opened !== "object" || opened === null) {
      throw new TypeError("sessionFactory.open must return a session");
    }
    const sessionDescriptor = Object.getOwnPropertyDescriptor(opened, "session");
    if (sessionDescriptor === undefined) {
      return Object.freeze({ session: opened as DirectCpicSession });
    }
    const selectedDescriptor = Object.getOwnPropertyDescriptor(
      opened,
      "selectedConnection",
    );
    if (
      !("value" in sessionDescriptor) ||
      selectedDescriptor === undefined ||
      !("value" in selectedDescriptor)
    ) {
      throw new TypeError(
        "selected session results must use own data properties",
      );
    }
    return Object.freeze({
      session: sessionDescriptor.value as DirectCpicSession,
      selectedConnection: snapshotConnection(
        selectedDescriptor.value as NormalizedDirectConnection,
      ),
    });
  };
}

function snapshotSessionInfo(
  value: DirectCpicSessionInfo,
  selectedConnection?: NormalizedDirectConnection,
): DirectCpicSessionInfo {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("session.info must be an object");
  }
  const localAddress = nonEmptyText(value.localAddress, "session.info.localAddress");
  const peerCodePage = nonEmptyText(value.peerCodePage, "session.info.peerCodePage");
  const peerAcceptInfo = value.peerAcceptInfo;
  const generationHandle = value.generationHandle;
  const connectionIndex = value.connectionIndex;
  if (!Number.isSafeInteger(peerAcceptInfo)) {
    throw new TypeError("session.info.peerAcceptInfo must be an integer");
  }
  if (!Number.isSafeInteger(connectionIndex)) {
    throw new TypeError("session.info.connectionIndex must be an integer");
  }
  if (!Number.isSafeInteger(generationHandle) || generationHandle < 1) {
    throw new TypeError(
      "session.info.generationHandle must be a positive integer",
    );
  }
  return Object.freeze({
    localAddress,
    peerCodePage,
    peerAcceptInfo,
    generationHandle,
    connectionIndex,
    ...(selectedConnection === undefined
      ? {}
      : {
          selectedApplicationServerHost:
            selectedConnection.applicationServerHost,
          selectedGatewayHost: selectedConnection.host,
          selectedSystemNumber: selectedConnection.sysnr,
        }),
  });
}

function canonicalOptimizedGenerationToken(
  value: unknown,
  objectKind: "function" | "recursive-function" | "structure",
): string {
  const pattern = objectKind === "function" || objectKind === "recursive-function"
    ? /^function:\d{8}:\d{6}$/u
    : /^structure:\d{14}$/u;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(
      `optimized ${objectKind} metadata returned an invalid generation token`,
    );
  }
  return value;
}

function ownDataValue(
  value: object,
  name: PropertyKey,
  failureMessage: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
  } catch {
    throw new TypeError(failureMessage);
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(failureMessage);
  }
  return descriptor.value;
}

function snapshotOptimizedDescriptor<T extends object>(
  result:
    | RfcMetadataGetFunctionResult
    | RfcMetadataGetRecursiveFunctionResult
    | RfcMetadataGetStructureResult,
  objectKind: "function" | "recursive-function" | "structure",
): BoundOptimizedDescriptor<T> {
  if (typeof result !== "object" || result === null) {
    throw new TypeError(`optimized ${objectKind} metadata result must be an object`);
  }
  const value = ownDataValue(
    result,
    "value",
    `optimized ${objectKind} metadata result must use own data properties`,
  );
  const token = ownDataValue(
    result,
    "generationToken",
    `optimized ${objectKind} metadata result must use own data properties`,
  );
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `optimized ${objectKind} metadata result must contain a descriptor`,
    );
  }
  return Object.freeze({
    value: value as T,
    generationToken: canonicalOptimizedGenerationToken(
      token,
      objectKind,
    ),
  });
}

function bindDirectSession(
  session: DirectCpicSession,
  selectedConnection?: NormalizedDirectConnection,
): BoundDirectSession {
  if (typeof session !== "object" || session === null) {
    throw new TypeError("sessionFactory.open must return a DirectCpicSession");
  }
  const info = snapshotSessionInfo(session.info, selectedConnection);
  const ping = callable(session.ping, "session.ping");
  const close = callable(session.close, "session.close");
  const reset = callable(session.resetServerContext, "session.resetServerContext");
  const getFunctionInterface = callable(
    session.getFunctionInterface,
    "session.getFunctionInterface",
  );
  const getStructureDefinition = callable(
    session.getStructureDefinition,
    "session.getStructureDefinition",
  );
  const getLegacyStructureDefinition = callable(
    session.getLegacyStructureDefinition,
    "session.getLegacyStructureDefinition",
  );
  const optimizedFunction = session.getOptimizedFunctionInterface;
  const optimizedStructure = session.getOptimizedStructureDefinition;
  const optimizedFunctionDescriptor = session.getOptimizedFunctionDescriptor;
  const optimizedRecursiveFunctionDescriptor =
    session.getOptimizedRecursiveFunctionDescriptor;
  const optimizedStructureDescriptor = session.getOptimizedStructureDescriptor;
  const optimizedTimestamps = session.getOptimizedMetadataTimestamps;
  const invoke = callable(
    session.invokeClassicWithMetadata,
    "session.invokeClassicWithMetadata",
  );
  return Object.freeze({
    info,
    ping: (signal?: AbortSignal): Promise<DirectCpicPingResult> =>
      Promise.resolve(safeApply(ping, session, [signal])),
    close: (): Promise<void> => Promise.resolve(safeApply(close, session, [])),
    reset: (signal?: AbortSignal): Promise<void> =>
      Promise.resolve(safeApply(reset, session, [signal])),
    getFunctionInterface: (name: string, signal?: AbortSignal) =>
      Promise.resolve(safeApply(getFunctionInterface, session, [name, signal])),
    getStructureDefinition: (name: string, signal?: AbortSignal) =>
      Promise.resolve(safeApply(getStructureDefinition, session, [name, signal])),
    getLegacyStructureDefinition: (name: string, signal?: AbortSignal) =>
      Promise.resolve(
        safeApply(getLegacyStructureDefinition, session, [name, signal]),
      ),
    getOptimizedFunctionInterface: (
      name: string,
      language: string,
      signal?: AbortSignal,
    ) => {
      if (typeof optimizedFunction !== "function") {
        return Promise.reject(new MetadataAccessFailure(
          "unavailable",
          "session does not implement optimized RFC metadata",
        ));
      }
      return Promise.resolve(
        safeApply(optimizedFunction, session, [name, language, signal]),
      );
    },
    getOptimizedStructureDefinition: (
      name: string,
      language: string,
      signal?: AbortSignal,
    ) => {
      if (typeof optimizedStructure !== "function") {
        return Promise.reject(new MetadataAccessFailure(
          "unavailable",
          "session does not implement optimized RFC metadata",
        ));
      }
      return Promise.resolve(
        safeApply(optimizedStructure, session, [name, language, signal]),
      );
    },
    async getOptimizedFunctionDescriptor(
      name: string,
      language: string,
      signal?: AbortSignal,
    ) {
      if (typeof optimizedFunctionDescriptor === "function") {
        const result = await safeApply(optimizedFunctionDescriptor, session, [
          name,
          language,
          signal,
        ]) as RfcMetadataGetFunctionResult;
        return snapshotOptimizedDescriptor<RfcFunctionInterface>(
          result,
          "function",
        );
      }
      // Preserve compatibility with deterministic injected sessions written
      // before the detailed same-response API existed. Such descriptors are
      // deliberately not eligible for timestamp tracking.
      if (typeof optimizedFunction !== "function") {
        throw new MetadataAccessFailure(
          "unavailable",
          "session does not implement optimized RFC metadata",
        );
      }
      return Object.freeze({
        value: await safeApply(optimizedFunction, session, [
          name,
          language,
          signal,
        ]) as RfcFunctionInterface,
      });
    },
    async getOptimizedRecursiveFunctionDescriptor(
      name: string,
      language: string,
      signal?: AbortSignal,
    ) {
      if (typeof optimizedRecursiveFunctionDescriptor !== "function") {
        throw new MetadataAccessFailure(
          "unavailable",
          "session does not implement recursive optimized RFC metadata",
        );
      }
      const result = await safeApply(
        optimizedRecursiveFunctionDescriptor,
        session,
        [name, language, signal],
      ) as RfcMetadataGetRecursiveFunctionResult;
      const descriptor = snapshotOptimizedDescriptor<RecursiveMetadataGraph>(
        result,
        "recursive-function",
      );
      if (
        descriptor.value.functionIdentity?.name !== name ||
        descriptor.value.functionIdentity.generationToken !==
          descriptor.generationToken
      ) {
        throw new Error(
          `optimized recursive-function metadata returned a mismatched identity for ${name}`,
        );
      }
      return descriptor;
    },
    async getOptimizedStructureDescriptor(
      name: string,
      language: string,
      signal?: AbortSignal,
    ) {
      if (typeof optimizedStructureDescriptor === "function") {
        const result = await safeApply(optimizedStructureDescriptor, session, [
          name,
          language,
          signal,
        ]) as RfcMetadataGetStructureResult;
        return snapshotOptimizedDescriptor<RfcStructureDefinition>(
          result,
          "structure",
        );
      }
      if (typeof optimizedStructure !== "function") {
        throw new MetadataAccessFailure(
          "unavailable",
          "session does not implement optimized RFC metadata",
        );
      }
      return Object.freeze({
        value: await safeApply(optimizedStructure, session, [
          name,
          language,
          signal,
        ]) as RfcStructureDefinition,
      });
    },
    getOptimizedMetadataTimestamps: (
      functionNames: readonly string[],
      structureNames: readonly string[],
      signal?: AbortSignal,
    ): Promise<RfcMetadataTimestampBatch> => {
      if (typeof optimizedTimestamps !== "function") {
        return Promise.reject(new MetadataAccessFailure(
          "unavailable",
          "session does not implement optimized RFC metadata timestamps",
        ));
      }
      return Promise.resolve(safeApply(optimizedTimestamps, session, [
        functionNames,
        structureNames,
        signal,
      ]));
    },
    invoke: (
      metadata: RfcFunctionInterface,
      input: Readonly<Record<string, unknown>>,
      structures: ReadonlyMap<string, RfcStructureDefinition>,
      signal: AbortSignal | undefined,
      invocationOptions: ClassicRfcInvocationOptions,
      recursiveGraph?: RecursiveMetadataGraph,
    ) => Promise.resolve(safeApply(invoke, session, [
      metadata,
      input,
      structures,
      signal,
      invocationOptions,
      recursiveGraph,
    ])),
  });
}

function completion(): Completion {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface BoundCallerSignal {
  readonly signal?: AbortSignal;
  readonly isAborted: () => boolean;
  readonly reason: () => unknown;
  readonly addAbortListener: (listener: () => void) => void;
  readonly removeAbortListener: (listener: () => void) => void;
}

function bindCallerSignal(signal: AbortSignal | undefined): BoundCallerSignal {
  if (signal === undefined) {
    return Object.freeze({
      signal: undefined,
      isAborted: () => false,
      reason: () => undefined,
      addAbortListener: () => undefined,
      removeAbortListener: () => undefined,
    });
  }
  if (typeof signal !== "object" || signal === null) {
    throw new TypeError("operation signal must be an AbortSignal");
  }
  const initiallyAborted = signal.aborted;
  const addEventListener = signal.addEventListener;
  const removeEventListener = signal.removeEventListener;
  if (
    typeof initiallyAborted !== "boolean" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    throw new TypeError("operation signal must be an AbortSignal");
  }
  return Object.freeze({
    signal,
    isAborted: (): boolean => {
      const aborted = signal.aborted;
      if (typeof aborted !== "boolean") {
        throw new TypeError("operation signal must be an AbortSignal");
      }
      return aborted;
    },
    reason: (): unknown => {
      try {
        return signal.reason;
      } catch {
        // A malformed reason getter cannot prevent cancellation from settling.
        return undefined;
      }
    },
    addAbortListener: (listener: () => void): void => {
      safeApply(addEventListener, signal, ["abort", listener, { once: true }]);
    },
    removeAbortListener: (listener: () => void): void => {
      safeApply(removeEventListener, signal, ["abort", listener]);
    },
  });
}

function mergeOperationSignals(
  runtimeSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): AbortSignal {
  return callerSignal === undefined
    ? runtimeSignal
    : AbortSignal.any([runtimeSignal, callerSignal]);
}

function preApplicationAbortReason(bound: BoundCallerSignal): unknown {
  const reason = bound.reason();
  return reason === undefined
    ? new Error("RFC invocation was aborted before application-session entry")
    : reason;
}

function snapshotParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("invocation parameters must be an object");
  }
  return snapshotRfcValue(input, "invocation parameters", {
    accessorPolicy: "readOnce",
  }) as Readonly<Record<string, unknown>>;
}

function snapshotNameSet(
  input: ReadonlySet<string> | undefined,
  path: string,
): ReadonlySet<string> | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`${path} must be a set`);
  }
  const values: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${path} values must be non-empty strings`);
    }
    values.push(value);
  }
  return Object.freeze(new Set(values));
}

function snapshotInvocation(
  invocation: DirectDestinationInvocation,
): DirectDestinationInvocation {
  if (
    typeof invocation !== "object" ||
    invocation === null ||
    Array.isArray(invocation)
  ) {
    throw new TypeError("invocation must be an object");
  }
  const functionName = nonEmptyText(
    invocation.functionName,
    "invocation.functionName",
  );
  if (functionName.length > 30 || /[^\x20-\x7e]/u.test(functionName)) {
    throw new RangeError(
      "invocation.functionName must contain 1..30 ASCII bytes",
    );
  }
  const parameters = snapshotParameters(invocation.parameters);
  const notRequested = snapshotNameSet(
    invocation.notRequested,
    "invocation.notRequested",
  );
  const activated = snapshotNameSet(invocation.activated, "invocation.activated");
  const deactivated = snapshotNameSet(
    invocation.deactivated,
    "invocation.deactivated",
  );
  const maxApplicationDataLength = invocation.maxApplicationDataLength;
  const int8Mode = snapshotClassicInt8Mode(
    invocation.int8Mode,
    "invocation.int8Mode",
  );
  const bcd = snapshotClassicBcdMode(invocation.bcd, "invocation.bcd");
  return Object.freeze({
    functionName,
    parameters,
    ...(notRequested === undefined ? {} : { notRequested }),
    ...(activated === undefined ? {} : { activated }),
    ...(deactivated === undefined ? {} : { deactivated }),
    ...(maxApplicationDataLength === undefined
      ? {}
      : { maxApplicationDataLength }),
    int8Mode,
    bcd,
  });
}

const MAX_METADATA_REFRESH_NAMES_PER_KIND = 512;

function snapshotMetadataRefreshNames(
  input: readonly string[],
  objectKind: "function" | "structure",
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${objectKind} names must be an array`);
  }
  if (input.length > MAX_METADATA_REFRESH_NAMES_PER_KIND) {
    throw new RangeError(
      `metadata timestamp refresh accepts at most ${MAX_METADATA_REFRESH_NAMES_PER_KIND} ${objectKind} names`,
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const name = classicMetadataObjectName(
      ownDataValue(
        input,
        index,
        `${objectKind} names[${index}] must be an own data property`,
      ),
      `${objectKind} names[${index}]`,
    );
    if (seen.has(name)) {
      throw new Error(`duplicate ${objectKind} name ${name}`);
    }
    seen.add(name);
    result.push(name);
  }
  return Object.freeze(result);
}

function metadataGenerationKey(
  objectKind: "function" | "recursive-function" | "structure",
  objectName: string,
): string {
  return `${objectKind}\n${objectName}`;
}

function metadataRefreshKey(
  functionNames: readonly string[],
  structureNames: readonly string[],
): string {
  return JSON.stringify([functionNames, structureNames]);
}

function metadataRefreshCanceled(): MetadataAccessFailure {
  return new MetadataAccessFailure(
    "canceled",
    "optimized metadata timestamp refresh was canceled",
  );
}

function waitForMetadataRefreshCaller<T>(
  operation: Promise<T>,
  caller: BoundCallerSignal,
): Promise<T> {
  const signal = caller.signal;
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        caller.removeAbortListener(onAbort);
      } catch {
        // A hostile cleanup hook cannot replace an already-selected result.
      }
      continuation();
    };
    const onAbort = (): void => {
      finish(() => reject(metadataRefreshCanceled()));
    };
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    try {
      if (caller.isAborted()) {
        onAbort();
        return;
      }
      caller.addAbortListener(onAbort);
      if (caller.isAborted()) onAbort();
    } catch {
      finish(() => reject(new TypeError("operation signal must be an AbortSignal")));
    }
  });
}

interface ValidatedMetadataRefreshBatch {
  readonly functionTokens: ReadonlyMap<string, string>;
  readonly structureTokens: ReadonlyMap<string, string>;
  readonly functionErrors: ReadonlySet<string>;
  readonly structureErrors: ReadonlySet<string>;
}

function refreshBatchProperty(
  batch: RfcMetadataTimestampBatch,
  name: keyof RfcMetadataTimestampBatch,
): unknown {
  if (typeof batch !== "object" || batch === null) {
    throw new TypeError("optimized metadata timestamp batch must be an object");
  }
  return ownDataValue(
    batch,
    name,
    `optimized metadata timestamp batch ${name} must be an own data property`,
  );
}

function refreshMapEntries(
  value: unknown,
  name: keyof RfcMetadataTimestampBatch,
  maximum: number,
): readonly (readonly [unknown, unknown])[] {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`optimized metadata timestamp batch ${name} must be a map`);
  }
  let iterator: unknown;
  try {
    iterator = (value as { readonly [Symbol.iterator]?: unknown })[
      Symbol.iterator
    ];
  } catch {
    throw new TypeError(
      `optimized metadata timestamp batch ${name} cannot expose its iterator`,
    );
  }
  if (typeof iterator !== "function") {
    throw new TypeError(`optimized metadata timestamp batch ${name} must be a map`);
  }
  let cursor: unknown;
  try {
    cursor = safeApply(iterator, value, []);
  } catch {
    throw new TypeError(
      `optimized metadata timestamp batch ${name} iterator failed`,
    );
  }
  if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null) {
    throw new TypeError(
      `optimized metadata timestamp batch ${name} iterator must return an object`,
    );
  }
  let next: unknown;
  try {
    next = (cursor as { readonly next?: unknown }).next;
  } catch {
    throw new TypeError(
      `optimized metadata timestamp batch ${name} iterator is malformed`,
    );
  }
  if (typeof next !== "function") {
    throw new TypeError(
      `optimized metadata timestamp batch ${name} iterator is malformed`,
    );
  }
  const entries: (readonly [unknown, unknown])[] = [];
  while (true) {
    let step: unknown;
    try {
      step = safeApply(next, cursor, []);
    } catch {
      throw new TypeError(
        `optimized metadata timestamp batch ${name} iterator failed`,
      );
    }
    if (typeof step !== "object" || step === null) {
      throw new TypeError(
        `optimized metadata timestamp batch ${name} iterator result is malformed`,
      );
    }
    const malformedResult =
      `optimized metadata timestamp batch ${name} iterator result is malformed`;
    const done = ownDataValue(step, "done", malformedResult);
    if (typeof done !== "boolean") {
      throw new TypeError(
        malformedResult,
      );
    }
    if (done) break;
    if (entries.length >= maximum) {
      throw new RangeError(
        `optimized metadata timestamp batch ${name} has too many entries`,
      );
    }
    const entry = ownDataValue(step, "value", malformedResult);
    if (!Array.isArray(entry)) {
      throw new TypeError(
        `optimized metadata timestamp batch ${name} entries must be pairs`,
      );
    }
    const malformedPair =
      `optimized metadata timestamp batch ${name} entries must use own data properties`;
    const length = ownDataValue(entry, "length", malformedPair);
    if (length !== 2) {
      throw new TypeError(
        `optimized metadata timestamp batch ${name} entries must be pairs`,
      );
    }
    entries.push(Object.freeze([
      ownDataValue(entry, 0, malformedPair),
      ownDataValue(entry, 1, malformedPair),
    ] as const));
  }
  return Object.freeze(entries);
}

function validateMetadataRefreshBatch(
  batch: RfcMetadataTimestampBatch,
  functionNames: readonly string[],
  structureNames: readonly string[],
): ValidatedMetadataRefreshBatch {
  const requestedFunctions = new Set(functionNames);
  const requestedStructures = new Set(structureNames);
  const functionTokens = new Map<string, string>();
  const structureTokens = new Map<string, string>();
  const functionErrors = new Set<string>();
  const structureErrors = new Set<string>();

  for (const [rawName, rawOutcome] of refreshMapEntries(
    refreshBatchProperty(batch, "functions"),
    "functions",
    functionNames.length + 1,
  )) {
    if (typeof rawName !== "string" || !requestedFunctions.has(rawName)) {
      throw new Error("optimized metadata timestamp batch contains a foreign function");
    }
    if (functionTokens.has(rawName) || functionErrors.has(rawName)) {
      throw new Error(
        `optimized metadata timestamp batch contains duplicate function ${rawName}`,
      );
    }
    if (typeof rawOutcome !== "object" || rawOutcome === null) {
      throw new TypeError(
        `optimized metadata timestamp for function ${rawName} must be an object`,
      );
    }
    functionTokens.set(
      rawName,
      canonicalOptimizedGenerationToken(
        ownDataValue(
          rawOutcome,
          "token",
          `optimized metadata timestamp for function ${rawName} lacks a token`,
        ),
        "function",
      ),
    );
  }
  for (const [rawName, rawError] of refreshMapEntries(
    refreshBatchProperty(batch, "functionErrors"),
    "functionErrors",
    functionNames.length + 1,
  )) {
    if (typeof rawName !== "string" || !requestedFunctions.has(rawName)) {
      throw new Error("optimized metadata timestamp batch contains a foreign function error");
    }
    if (
      typeof rawError !== "string" ||
      !/^[A-Z0-9_]{1,30}$/u.test(rawError) ||
      functionTokens.has(rawName) ||
      functionErrors.has(rawName)
    ) {
      throw new Error(
        `optimized metadata timestamp batch contains an invalid function error for ${rawName}`,
      );
    }
    functionErrors.add(rawName);
  }
  for (const [rawName, rawOutcome] of refreshMapEntries(
    refreshBatchProperty(batch, "structures"),
    "structures",
    structureNames.length + 1,
  )) {
    if (typeof rawName !== "string" || !requestedStructures.has(rawName)) {
      throw new Error("optimized metadata timestamp batch contains a foreign structure");
    }
    if (structureTokens.has(rawName) || structureErrors.has(rawName)) {
      throw new Error(
        `optimized metadata timestamp batch contains duplicate structure ${rawName}`,
      );
    }
    if (typeof rawOutcome !== "object" || rawOutcome === null) {
      throw new TypeError(
        `optimized metadata timestamp for structure ${rawName} must be an object`,
      );
    }
    structureTokens.set(
      rawName,
      canonicalOptimizedGenerationToken(
        ownDataValue(
          rawOutcome,
          "token",
          `optimized metadata timestamp for structure ${rawName} lacks a token`,
        ),
        "structure",
      ),
    );
  }
  for (const [rawName, rawError] of refreshMapEntries(
    refreshBatchProperty(batch, "structureErrors"),
    "structureErrors",
    structureNames.length + 1,
  )) {
    if (typeof rawName !== "string" || !requestedStructures.has(rawName)) {
      throw new Error("optimized metadata timestamp batch contains a foreign structure error");
    }
    if (
      typeof rawError !== "string" ||
      !/^[A-Z0-9_]{1,30}$/u.test(rawError) ||
      structureTokens.has(rawName) ||
      structureErrors.has(rawName)
    ) {
      throw new Error(
        `optimized metadata timestamp batch contains an invalid structure error for ${rawName}`,
      );
    }
    structureErrors.add(rawName);
  }
  for (const name of functionNames) {
    if (!functionTokens.has(name) && !functionErrors.has(name)) {
      throw new Error(
        `optimized metadata timestamp batch has no outcome for function ${name}`,
      );
    }
  }
  for (const name of structureNames) {
    if (!structureTokens.has(name) && !structureErrors.has(name)) {
      throw new Error(
        `optimized metadata timestamp batch has no outcome for structure ${name}`,
      );
    }
  }
  return Object.freeze({
    functionTokens,
    structureTokens,
    functionErrors,
    structureErrors,
  });
}

function retainedText(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function retainedDescriptorBytes(value: DestinationMetadataDescriptor): number {
  if (value.kind === "recursive-function") {
    const graph = value.value;
    const retained = 256 + graph.statistics.byteCount +
      graph.statistics.nodeCount * 96 +
      graph.statistics.edgeCount * 64;
    if (!Number.isSafeInteger(retained)) {
      throw new RangeError("recursive metadata retained-byte estimate is unsafe");
    }
    return retained;
  }
  if (value.kind === "structure") {
    let bytes = 64 + retainedText(value.value.name);
    for (const field of value.value.fields) {
      bytes += 64 + retainedText(field.tableName) + retainedText(field.fieldName) +
        retainedText(field.exid);
    }
    return bytes;
  }
  let bytes = 96 + retainedText(value.value.name) +
    retainedText(value.value.remoteCall);
  for (const parameter of value.value.parameters) {
    bytes += 96 + retainedText(parameter.parameterClass) +
      retainedText(parameter.parameterName) + retainedText(parameter.tableName) +
      retainedText(parameter.fieldName) + retainedText(parameter.exid) +
      retainedText(parameter.defaultValue) + retainedText(parameter.parameterText);
  }
  for (const exception of value.value.exceptions) bytes += retainedText(exception);
  return bytes;
}

function metadataSnapshot(
  value: DestinationMetadataDescriptor,
): MetadataSnapshot<DestinationMetadataDescriptor> {
  return Object.freeze({
    value,
    retainedBytes: retainedDescriptorBytes(value),
  });
}

function failureLeavesSessionReusable(error: unknown): boolean {
  if (
    error instanceof RfcCoreError &&
    error.failure.disposition === RfcConnectionDisposition.Reusable
  ) {
    return true;
  }
  return error instanceof MetadataAccessFailure &&
    error.cause instanceof RfcCoreError &&
    error.cause.failure.disposition === RfcConnectionDisposition.Reusable;
}

function allowsOptionalRecursiveMetadataFallback(error: unknown): boolean {
  // An incomplete DDIC closure is local to this recursive lookup. It may be
  // bypassed only when every active container has an independently validated
  // flat descriptor; it must not demote the optimized repository globally.
  return error instanceof RecursiveMetadataError &&
      error.code === "REMOTE_DDIC_RESOLUTION_ERRORS" ||
    error instanceof MetadataAccessFailure &&
      (error.classification === "unavailable" ||
        error.classification === "authorization");
}

const OPTIMIZED_METADATA_UNAVAILABLE_KEYS = new Set([
  "FU_NOT_FOUND",
  "FUNCTION_NOT_EXIST",
  "RFC_NOT_FOUND",
]);
const OPTIMIZED_METADATA_AUTHORIZATION_KEYS = new Set([
  "CALL_FUNCTION_NO_AUTHORITY",
  "RFC_NO_AUTHORITY",
  "RFC_AUTHORIZATION_FAILURE",
]);

function classifyOptimizedMetadataFailure(error: unknown): never {
  if (error instanceof MetadataAccessFailure) throw error;
  if (error instanceof RfcCoreError) {
    if (
      error.failure.category === RfcFailureCategory.AbapException &&
      OPTIMIZED_METADATA_UNAVAILABLE_KEYS.has(error.failure.key)
    ) {
      throw new MetadataAccessFailure(
        "unavailable",
        "RFC_METADATA_GET is unavailable on this backend",
        { cause: error },
      );
    }
    if (
      OPTIMIZED_METADATA_AUTHORIZATION_KEYS.has(error.failure.key) ||
      OPTIMIZED_METADATA_AUTHORIZATION_KEYS.has(error.failure.abap.runtimeId)
    ) {
      throw new MetadataAccessFailure(
        "authorization",
        "RFC_METADATA_GET is not authorized for this repository principal",
        { cause: error },
      );
    }
  }
  throw error;
}

function aggregatePrimaryAndCleanup(
  primary: unknown,
  cleanup: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primary, cleanup], message, { cause: primary });
}

function snapshotAcquireOptions(
  options: ConnectionPoolAcquireOptions,
): ConnectionPoolAcquireOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("application acquire options must be an object");
  }
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  return Object.freeze({
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotReleaseOptions(
  options: DirectDestinationReleaseOptions,
): {
  readonly reusable: boolean;
  readonly reset: boolean;
  readonly idleHigh?: number;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("application release options must be an object");
  }
  const idleHigh = options.idleHigh;
  if (
    idleHigh !== undefined &&
    (!Number.isSafeInteger(idleHigh) || idleHigh < 0)
  ) {
    throw new RangeError("application release idleHigh must be a non-negative integer");
  }
  return Object.freeze({
    reusable: optionalBoolean(
      options.reusable,
      true,
      "application release reusable",
    ),
    reset: optionalBoolean(
      options.reset,
      false,
      "application release reset",
    ),
    ...(idleHigh === undefined ? {} : { idleHigh }),
  });
}

/**
 * Production composition root for one immutable direct-CPIC destination.
 *
 * Raw sessions exist only inside captured lane resources. Repository metadata
 * completes before application-pool entry, and every application operation is
 * serialized behind a lease-local tail which release must drain.
 */
export class DirectDestinationOwner {
  readonly #connection: NormalizedDirectConnection;
  readonly #repositoryMode: MetadataRepositoryMode;
  readonly #openContext = new AsyncLocalStorage<LaneOpenScope>();
  readonly #openSession: (
    connection: NormalizedDirectConnection,
    context: DirectDestinationSessionOpenContext,
  ) => Promise<CanonicalOpenedSession>;
  readonly #boundSessions = new WeakMap<DirectCpicSession, BoundDirectSession>();
  readonly #admittedSessions = new WeakSet<DirectCpicSession>();
  readonly #applicationPool: ConnectionPoolRuntime<BoundDirectSession>;
  readonly #repositoryPool: ConnectionPoolRuntime<BoundDirectSession>;
  readonly #repository: MetadataRepositoryRuntime<DestinationMetadataDescriptor>;
  readonly #destination: RfcDestinationRuntime<DirectCpicSession, DirectCpicSession>;
  readonly #maxOptimizedGenerationTokens: number;
  readonly #optimizedGenerationTokens = new Map<
    string,
    OptimizedGenerationRecord
  >();
  readonly #optimizedDescriptorTokens = new WeakMap<object, string>();
  readonly #metadataRefreshRetirement = new AbortController();
  #metadataRefreshOperation?: MetadataRefreshOperation;
  readonly #contexts: SessionContextRuntime<
    DirectDestinationApplicationLease,
    DirectDestinationApplicationLease
  >;
  readonly #knownLeases = new WeakMap<
    DirectDestinationApplicationLease,
    ApplicationLeaseRecord
  >();
  readonly #leaseRecords = new Set<ApplicationLeaseRecord>();
  #state: "active" | "retiring" | "retired" = "active";
  #retirement?: Promise<void>;

  constructor(options: DirectDestinationOwnerOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new TypeError("direct destination owner options must be an object");
    }
    const connection = snapshotConnection(options.connection);
    const generationId = nonEmptyText(options.generationId, "generationId");
    const identity = snapshotIdentity(options.identity);
    const repositoryMode = options.repositoryMode ?? MetadataRepositoryMode.Classic;
    const sessionOptions = snapshotSessionOptions(options.session);
    const suppliedSessionFactory = options.sessionFactory;
    const applicationPoolOptions = snapshotPoolOptions(
      options.applicationPool,
      DEFAULT_APPLICATION_POOL,
      "applicationPool",
    );
    const repositoryPoolOptions = snapshotPoolOptions(
      options.repositoryPool,
      DEFAULT_REPOSITORY_POOL,
      "repositoryPool",
    );
    const metadataOptions = snapshotMetadataOptions(options.metadata);
    if (identity.client !== connection.client) {
      throw new Error("identity.client must match the normalized connection client");
    }
    if (identity.language !== connection.language) {
      throw new Error(
        "identity.language must match the normalized connection language",
      );
    }
    this.#connection = connection;
    this.#repositoryMode = repositoryMode;
    this.#maxOptimizedGenerationTokens = metadataOptions.maxEntries;
    this.#openSession = bindSessionFactory(
      suppliedSessionFactory === undefined
        ? createProductionSessionFactory(sessionOptions)
        : suppliedSessionFactory,
    );

    const generation = new DestinationConfigurationGeneration<
      DirectCpicSession,
      DirectCpicSession
    >({
      generationId,
      repositoryMode,
      identity,
      applicationFactory: {
        open: () => this.#openRawSession("application"),
        dispose: (session) => this.#disposeRawSession(session),
      },
      repositoryFactory: {
        open: () => this.#openRawSession("repository"),
        dispose: (session) => this.#disposeRawSession(session),
      },
    });

    this.#applicationPool = new ConnectionPoolRuntime<BoundDirectSession>({
      factory: {
        create: (context) => this.#openBoundFromGeneration(
          generation,
          "application",
          context.signal,
        ),
        destroy: (session) => session.close(),
        validate: async (session, context) => {
          await session.ping(context.signal);
          return true;
        },
        reset: (session, context) => session.reset(context.signal),
      },
      ...applicationPoolOptions,
      // TransactionRuntime performs its explicit same-lease reset exactly once.
      resetOnRelease: false,
    });
    this.#repositoryPool = new ConnectionPoolRuntime<BoundDirectSession>({
      factory: {
        create: (context) => this.#openBoundFromGeneration(
          generation,
          "repository",
          context.signal,
        ),
        destroy: (session) => session.close(),
        validate: async (session, context) => {
          await session.ping(context.signal);
          return true;
        },
        reset: (session, context) => session.reset(context.signal),
      },
      ...repositoryPoolOptions,
      // This lane runs only connector-owned metadata RFMs and cannot carry
      // caller application context. Avoid a two-call SYSTEM_RESET/refresh on
      // every descriptor lookup; failed generations are still non-reusable.
      resetOnRelease: false,
    });

    this.#repository = new MetadataRepositoryRuntime<DestinationMetadataDescriptor>({
      ...metadataOptions,
      adapter: {
        probeOptimized: (context) => this.#probeOptimizedMetadata(context.signal),
        async authorize() {
          // One owner has one immutable repository-principal identity. An
          // optimized load still executes under that principal before its
          // descriptor enters this generation's cache.
        },
        load: (context) => this.#loadMetadata(context),
      },
    });
    this.#destination = new RfcDestinationRuntime({
      generation,
      repository: this.#repository,
    });
    this.#contexts = new SessionContextRuntime({
      scope: Object.freeze({
        destinationId: identity.destinationId,
        configurationGenerationId: generationId,
      }),
      leases: {
        acquire: (context) => this.acquireApplication({ signal: context.signal }),
        resource: (lease) => lease,
        reset: (lease, _resource, context) =>
          this.resetApplication(lease, context.signal),
        release: (lease, disposition) =>
          this.releaseApplication(lease, {
            reusable: disposition.reusable,
            reset: false,
          }),
      },
      operationTimeoutMs: Math.max(
        sessionOptions.operationTimeoutMs,
        applicationPoolOptions.acquireTimeoutMs,
        applicationPoolOptions.lifecycleTimeoutMs,
      ),
      isFatal: (failure) =>
        classifyDirectDestinationTransactionFailure(failure) !== "recoverable",
    });
  }

  get configuration(): DestinationConfiguration {
    return this.#destination.configuration;
  }

  async acquireApplication(
    options: ConnectionPoolAcquireOptions = {},
  ): Promise<DirectDestinationApplicationLease> {
    const canonicalOptions = snapshotAcquireOptions(options);
    const leases = await this.#acquireApplications(1, canonicalOptions);
    return leases[0]!;
  }

  /** Atomic multi-acquire used by node-rfc Pool compatibility. */
  async acquireApplications(
    count: number,
    options: ConnectionPoolAcquireOptions = {},
  ): Promise<readonly DirectDestinationApplicationLease[]> {
    const canonicalOptions = snapshotAcquireOptions(options);
    return this.#acquireApplications(count, canonicalOptions);
  }

  beginContext(): Promise<SessionContextToken>;
  beginContext(token: SessionContextToken): Promise<SessionContextToken>;
  beginContext(token?: SessionContextToken): Promise<SessionContextToken> {
    return token === undefined
      ? this.#contexts.begin()
      : this.#contexts.begin(token);
  }

  invokeContext(
    token: SessionContextToken,
    invocation: DirectDestinationInvocation,
    signal?: AbortSignal,
  ): Promise<ClassicRfcOutput> {
    const canonicalInvocation = snapshotInvocation(invocation);
    const callerSignal = bindCallerSignal(signal).signal;
    return this.#contexts.run(token, (lease, context) =>
      this.invoke(
        lease,
        canonicalInvocation,
        mergeOperationSignals(context.signal, callerSignal),
      ));
  }

  pingContext(
    token: SessionContextToken,
    signal?: AbortSignal,
  ): Promise<DirectCpicPingResult> {
    const callerSignal = bindCallerSignal(signal).signal;
    return this.#contexts.run(token, (lease, context) =>
      this.pingApplication(
        lease,
        mergeOperationSignals(context.signal, callerSignal),
      ));
  }

  endContext(token: SessionContextToken): Promise<void> {
    return this.#contexts.end(token);
  }

  #publishApplicationLease(
    poolLease: ConnectionPoolLease<BoundDirectSession>,
  ): DirectDestinationApplicationLease {
    const token = Object.create(null) as DirectDestinationApplicationLease;
    Object.defineProperty(token, applicationLeaseBrand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.freeze(token);
    const record: ApplicationLeaseRecord = {
      poolLease,
      state: "owned",
      active: false,
    };
    this.#knownLeases.set(token, record);
    this.#leaseRecords.add(record);
    return token;
  }

  invoke(
    lease: DirectDestinationApplicationLease,
    invocation: DirectDestinationInvocation,
    signal?: AbortSignal,
  ): Promise<ClassicRfcOutput> {
    const canonicalInvocation = snapshotInvocation(invocation);
    const callerSignal = bindCallerSignal(signal);
    const record = this.#ownedLeaseRecord(lease);
    return this.#runApplicationOperation(record, async () => {
      let metadata: RfcFunctionInterface;
      let recursiveGraph: RecursiveMetadataGraph | undefined;
      const structures = new Map<string, RfcStructureDefinition>();
      const invocationOptions: ClassicRfcInvocationOptions = Object.freeze({
        int8Mode: canonicalInvocation.int8Mode,
        bcd: canonicalInvocation.bcd,
        ...(canonicalInvocation.notRequested === undefined
          ? {}
          : { notRequested: canonicalInvocation.notRequested }),
        ...(canonicalInvocation.activated === undefined
          ? {}
          : { activated: canonicalInvocation.activated }),
        ...(canonicalInvocation.deactivated === undefined
          ? {}
          : { deactivated: canonicalInvocation.deactivated }),
        ...(canonicalInvocation.maxApplicationDataLength === undefined
          ? {}
          : {
              maxApplicationDataLength:
                canonicalInvocation.maxApplicationDataLength,
            }),
      });
      try {
        metadata = await this.#destination.getFunctionInterface(
          canonicalInvocation.functionName,
          callerSignal.signal,
        );
        const recursiveParameters = classicInvocationRecursiveMetadataParameters(
          metadata,
          canonicalInvocation.parameters,
          invocationOptions,
        );
        const metadataNeeds = classifyClassicInvocationMetadataNeeds(
          metadata,
          canonicalInvocation.parameters,
          invocationOptions,
        );
        const recursiveMetadataRequired = recursiveParameters.length > 0 ||
          metadataNeeds.requiredRecursive;
        const hasContainerMetadata = recursiveMetadataRequired ||
          (
            metadataNeeds.optionalRecursive &&
            this.#repositoryMode !== MetadataRepositoryMode.Classic &&
            this.#repositoryMode !== MetadataRepositoryMode.LegacyV3
          );
        if (hasContainerMetadata) {
          try {
            recursiveGraph =
              await this.#destination.getRecursiveFunctionMetadata(
                canonicalInvocation.functionName,
                callerSignal.signal,
              );
          } catch (error) {
            if (
              recursiveMetadataRequired ||
              !allowsOptionalRecursiveMetadataFallback(error)
            ) {
              throw error;
            }
          }
        }
        if (recursiveGraph !== undefined) {
          const functionToken = this.#optimizedDescriptorTokens.get(metadata);
          const recursiveToken = this.#optimizedDescriptorTokens.get(
            recursiveGraph,
          );
          if (
            functionToken !== undefined &&
            recursiveToken !== undefined &&
            functionToken !== recursiveToken
          ) {
            throw new Error(
              `function and recursive metadata generations disagree for ` +
                canonicalInvocation.functionName,
            );
          }
        }
        const structureNames = new Set<string>();
        const recursiveContainerParameters = metadata.parameters.filter(
          (parameter) =>
            parameter.exid === "u" &&
            metadataNeeds.containerParameters.has(parameter.parameterName),
        );
        const recursiveParameterIndex =
          recursiveGraph !== undefined &&
            recursiveContainerParameters.length > 0
            ? createRecursiveMetadataParameterIndex(recursiveGraph)
            : undefined;
        for (const parameter of recursiveContainerParameters) {
          if (
            recursiveGraph !== undefined &&
            resolveRecursiveXrfcParameterFromIndex(
              recursiveGraph,
              recursiveParameterIndex!,
              parameter,
            ) !== undefined
          ) {
            continue;
          }
          if (parameter.tableName.length === 0) {
            throw new Error(
              `${parameter.parameterName} lacks its structure type name`,
            );
          }
          structureNames.add(parameter.tableName);
        }
        const definitions = await Promise.all(
          [...structureNames].map((name) =>
            this.#destination.getStructureDefinition(name, callerSignal.signal)),
        );
        let index = 0;
        for (const name of structureNames) structures.set(name, definitions[index++]!);
      } catch (cause) {
        throw cause instanceof DirectDestinationMetadataPreflightError
          ? cause
          : new DirectDestinationMetadataPreflightError(
              canonicalInvocation.functionName,
              cause,
            );
      }
      if (callerSignal.isAborted()) {
        throw new DirectDestinationMetadataPreflightError(
          canonicalInvocation.functionName,
          preApplicationAbortReason(callerSignal),
        );
      }
      return this.#applicationPool.withActiveLease(
        record.poolLease,
        (session) => session.invoke(
          metadata,
          canonicalInvocation.parameters,
          structures,
          callerSignal.signal,
          invocationOptions,
          recursiveGraph,
        ),
      );
    });
  }

  pingApplication(
    lease: DirectDestinationApplicationLease,
    signal?: AbortSignal,
  ): Promise<DirectCpicPingResult> {
    const record = this.#ownedLeaseRecord(lease);
    return this.#runApplicationOperation(record, () =>
      this.#applicationPool.withActiveLease(
        record.poolLease,
        (session) => session.ping(signal),
      ));
  }

  applicationInfo(
    lease: DirectDestinationApplicationLease,
  ): Promise<DirectCpicSessionInfo> {
    const record = this.#ownedLeaseRecord(lease);
    return this.#runApplicationOperation(record, () =>
      this.#applicationPool.withActiveLease(
        record.poolLease,
        (session) => session.info,
      ));
  }

  resetApplication(
    lease: DirectDestinationApplicationLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = this.#ownedLeaseRecord(lease);
    return this.#runApplicationOperation(record, () =>
      this.#applicationPool.withActiveLease(
        record.poolLease,
        (session) => session.reset(signal),
      ));
  }

  async releaseApplication(
    lease: DirectDestinationApplicationLease,
    options: DirectDestinationReleaseOptions = {},
  ): Promise<void> {
    const canonicalOptions = snapshotReleaseOptions(options);
    if (
      canonicalOptions.idleHigh !== undefined &&
      canonicalOptions.idleHigh >
        this.#applicationPool.monitor().maxConnections
    ) {
      throw new RangeError(
        "application release idleHigh exceeds application pool capacity",
      );
    }
    const record = this.#leaseRecord(lease);
    if (record.state !== "owned") {
      throw new Error("application lease has already been released");
    }
    // This synchronous transition is the once-only ownership handoff.
    record.state = "releaseClaimed";
    const tail = record.tail;
    try {
      if (tail !== undefined) await tail;
      if (canonicalOptions.reusable && canonicalOptions.reset) {
        try {
          await this.#applicationPool.resetActiveLease(record.poolLease);
        } catch (primary) {
          try {
            await this.#applicationPool.release(record.poolLease, {
              reusable: false,
            });
          } catch (cleanupError) {
            throw aggregatePrimaryAndCleanup(
              primary,
              cleanupError,
              "application reset and destruction both failed",
            );
          }
          throw primary;
        }
      }
      await this.#applicationPool.release(record.poolLease, canonicalOptions);
    } finally {
      record.state = "released";
      record.active = false;
      record.tail = undefined;
      this.#leaseRecords.delete(record);
    }
  }

  async getFunctionInterface(
    name: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface> {
    const admittedName = classicMetadataObjectName(name, "functionName");
    return this.#destination.getFunctionInterface(admittedName, signal);
  }

  async getRecursiveFunctionMetadata(
    name: string,
    signal?: AbortSignal,
  ): Promise<RecursiveMetadataGraph> {
    const admittedName = classicMetadataObjectName(name, "functionName");
    return this.#destination.getRecursiveFunctionMetadata(admittedName, signal);
  }

  async getStructureDefinition(
    name: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition> {
    const admittedName = classicMetadataObjectName(name, "structureName");
    return this.#destination.getStructureDefinition(admittedName, signal);
  }

  /**
   * Compare one explicit, bounded descriptor batch with SAP's current
   * generations. The caller chooses when to pay for this check; there is no
   * timer, guessed TTL, or background I/O.
   */
  refreshOptimizedMetadata(
    functionNames: readonly string[],
    structureNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<DirectDestinationMetadataRefreshResult> {
    if (this.#state !== "active") return Promise.reject(this.#retiredError());
    const functions = snapshotMetadataRefreshNames(functionNames, "function");
    const structures = snapshotMetadataRefreshNames(structureNames, "structure");
    const caller = bindCallerSignal(signal);
    // Caller-controlled array or signal traps cannot retire the owner and then
    // smuggle a refresh past the admission gate.
    if (this.#state !== "active") return Promise.reject(this.#retiredError());
    let callerAborted: boolean;
    try {
      callerAborted = caller.isAborted();
    } catch {
      return Promise.reject(new TypeError("operation signal must be an AbortSignal"));
    }
    if (this.#state !== "active") return Promise.reject(this.#retiredError());
    if (callerAborted) {
      return Promise.reject(metadataRefreshCanceled());
    }
    if (functions.length === 0 && structures.length === 0) {
      return Promise.resolve(Object.freeze({
        checkedFunctionNames: functions,
        checkedStructureNames: structures,
        invalidatedFunctionNames: Object.freeze([]),
        invalidatedStructureNames: Object.freeze([]),
      }));
    }
    const key = metadataRefreshKey(functions, structures);
    const existing = this.#metadataRefreshOperation;
    if (existing !== undefined) {
      if (existing.key !== key) {
        return Promise.reject(
          new Error("another optimized metadata timestamp refresh is in progress"),
        );
      }
      return waitForMetadataRefreshCaller(existing.promise, caller);
    }
    const admission: MetadataRefreshAdmission = Object.freeze({
      functionNames: functions,
      structureNames: structures,
      functionRecords: Object.freeze(functions.map((name) => Object.freeze([
        this.#optimizedGenerationTokens.get(
          metadataGenerationKey("function", name),
        ),
        this.#optimizedGenerationTokens.get(
          metadataGenerationKey("recursive-function", name),
        ),
      ].filter(
        (record): record is OptimizedGenerationRecord => record !== undefined,
      )))),
      structureRecords: Object.freeze(structures.map((name) =>
        this.#optimizedGenerationTokens.get(
          metadataGenerationKey("structure", name),
        ))),
    });
    let pending!: Promise<DirectDestinationMetadataRefreshResult>;
    pending = Promise.resolve()
      .then(() => this.#executeMetadataRefresh(admission))
      .finally(() => {
        if (this.#metadataRefreshOperation?.promise === pending) {
          this.#metadataRefreshOperation = undefined;
        }
      });
    this.#metadataRefreshOperation = Object.freeze({ key, promise: pending });
    return waitForMetadataRefreshCaller(pending, caller);
  }

  retire(): Promise<void> {
    if (this.#retirement !== undefined) return this.#retirement;
    this.#state = "retiring";
    let contextRetirement!: Promise<void>;
    const retirement = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const contexts = await Promise.allSettled([contextRetirement]);
      for (const result of contexts) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      const application = await Promise.allSettled([this.#applicationPool.retire()]);
      for (const result of application) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      const remaining = await Promise.allSettled([
        this.#destination.retire(),
        this.#repositoryPool.retire(),
      ]);
      for (const result of remaining) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      this.#state = "retired";
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `direct destination ${this.configuration.generationId} retirement failed`,
        );
      }
    });
    // Publish the terminal before context eviction can enter a caller-owned
    // session close and re-enter retire(). The context gate then closes in the
    // same turn, before either pool starts rejecting lifecycle handoffs.
    this.#retirement = retirement;
    this.#optimizedGenerationTokens.clear();
    this.#metadataRefreshRetirement.abort(metadataRefreshCanceled());
    contextRetirement = this.#contexts.retire();
    return retirement;
  }

  monitor(): DirectDestinationOwnerMonitor {
    let activeApplicationOperations = 0;
    let quarantinedApplicationTails = 0;
    for (const record of this.#leaseRecords) {
      if (record.active) activeApplicationOperations += 1;
      if (record.state === "releaseClaimed" && record.tail !== undefined) {
        quarantinedApplicationTails += 1;
      }
    }
    const destination = this.#destination.monitor();
    const contexts = this.#contexts.monitor();
    const contextPinnedApplicationLeases = Math.min(
      this.#leaseRecords.size,
      contexts.pinnedLeases,
    );
    return Object.freeze({
      state: this.#state,
      destination,
      metadata: destination.repository,
      applicationPool: this.#applicationPool.monitor(),
      repositoryPool: this.#repositoryPool.monitor(),
      contexts,
      applicationLeases: this.#leaseRecords.size,
      contextPinnedApplicationLeases,
      ordinaryApplicationLeases:
        this.#leaseRecords.size - contextPinnedApplicationLeases,
      activeApplicationOperations,
      quarantinedApplicationTails,
      optimizedGenerationTokens: this.#optimizedGenerationTokens.size,
      maxOptimizedGenerationTokens: this.#maxOptimizedGenerationTokens,
      metadataRefreshInFlight:
        this.#metadataRefreshOperation === undefined ? 0 : 1,
    });
  }

  async #openRawSession(lane: DirectDestinationLane): Promise<DirectCpicSession> {
    const scope = this.#openContext.getStore();
    if (scope === undefined || scope.lane !== lane) {
      throw new Error(`destination ${lane} session opened outside its pool scope`);
    }
    const context: DirectDestinationSessionOpenContext = Object.freeze({
      lane,
      signal: scope.signal,
    });
    const opened = await this.#openSession(this.#connection, context);
    const session = opened.session;
    if (this.#admittedSessions.has(session)) {
      throw new Error("sessionFactory.open returned a session already owned by a pool");
    }
    let bound: BoundDirectSession;
    try {
      bound = bindDirectSession(session, opened.selectedConnection);
    } catch (primary) {
      try {
        const close = callable(session.close, "session.close");
        await safeApply(close, session, []);
      } catch (cleanupError) {
        throw aggregatePrimaryAndCleanup(
          primary,
          cleanupError,
          "session binding and cleanup both failed",
        );
      }
      throw primary;
    }
    this.#admittedSessions.add(session);
    this.#boundSessions.set(session, bound);
    return session;
  }

  async #disposeRawSession(session: DirectCpicSession): Promise<void> {
    const bound = this.#boundSessions.get(session) ?? bindDirectSession(session);
    await bound.close();
  }

  #openBoundFromGeneration(
    generation: DestinationConfigurationGeneration<
      DirectCpicSession,
      DirectCpicSession
    >,
    lane: DirectDestinationLane,
    signal: AbortSignal,
  ): Promise<BoundDirectSession> {
    const scope: LaneOpenScope = Object.freeze({ lane, signal });
    return this.#openContext.run(scope, async () => {
      const session = lane === "application"
        ? await generation.openApplication()
        : await generation.openRepository();
      const bound = this.#boundSessions.get(session);
      if (bound === undefined) {
        throw new Error("destination generation returned an unbound session");
      }
      return bound;
    });
  }

  async #loadMetadata(
    context: MetadataAccessContext,
  ): Promise<MetadataSnapshot<DestinationMetadataDescriptor>> {
    let value: DestinationMetadataDescriptor;
    let generationToken: string | undefined;
    const objectKind = context.structural.objectKind;
    if (
      objectKind !== "function" &&
      objectKind !== "recursive-function" &&
      objectKind !== "structure"
    ) {
      throw new Error(`unsupported metadata object kind ${objectKind}`);
    }
    const generationKey = metadataGenerationKey(
      objectKind,
      context.structural.objectName,
    );
    if (context.strategy !== MetadataLoadStrategy.Optimized) {
      // A classic or legacy fallback must never inherit a token from an older
      // optimized descriptor for the same structural key.
      this.#optimizedGenerationTokens.delete(generationKey);
    }
    try {
      value = await this.#withRepositorySession(
        context.signal,
        async (session) => {
        const objectName = context.structural.objectName;
        if (context.structural.objectKind === "function") {
          let metadata: RfcFunctionInterface;
          if (context.strategy === MetadataLoadStrategy.Optimized) {
            const optimized = await session.getOptimizedFunctionDescriptor(
                objectName,
                this.#connection.language,
                context.signal,
              );
            metadata = optimized.value;
            generationToken = optimized.generationToken;
          } else {
            metadata = await session.getFunctionInterface(
              objectName,
              context.signal,
            );
          }
          return Object.freeze({
            kind: "function" as const,
            value: metadata,
          });
        }
        if (context.structural.objectKind === "recursive-function") {
          if (context.strategy !== MetadataLoadStrategy.Optimized) {
            throw new MetadataAccessFailure(
              "unavailable",
              "recursive RFC metadata requires the optimized repository path",
            );
          }
          const optimized =
            await session.getOptimizedRecursiveFunctionDescriptor(
              objectName,
              this.#connection.language,
              context.signal,
            );
          generationToken = optimized.generationToken;
          return Object.freeze({
            kind: "recursive-function" as const,
            value: optimized.value,
          });
        }
        if (context.structural.objectKind === "structure") {
          let definition: RfcStructureDefinition;
          if (context.strategy === MetadataLoadStrategy.Optimized) {
            const optimized = await session.getOptimizedStructureDescriptor(
                objectName,
                this.#connection.language,
                context.signal,
              );
            definition = optimized.value;
            generationToken = optimized.generationToken;
          } else if (context.strategy === MetadataLoadStrategy.LegacyV3) {
            definition = await session.getLegacyStructureDefinition(
              objectName,
              context.signal,
            );
          } else {
            definition = await session.getStructureDefinition(
              objectName,
              context.signal,
            );
          }
          return Object.freeze({
            kind: "structure" as const,
            value: definition,
          });
        }
        throw new Error(
          `unsupported metadata object kind ${context.structural.objectKind}`,
        );
        },
      );
    } catch (error) {
      if (context.strategy === MetadataLoadStrategy.Optimized) {
        classifyOptimizedMetadataFailure(error);
      }
      throw error;
    }
    const snapshot = metadataSnapshot(value);
    if (context.strategy === MetadataLoadStrategy.Optimized) {
      if (generationToken === undefined) {
        this.#optimizedGenerationTokens.delete(generationKey);
        this.#optimizedDescriptorTokens.delete(value.value);
      } else {
        const canonicalToken = canonicalOptimizedGenerationToken(
          generationToken,
          objectKind,
        );
        this.#optimizedDescriptorTokens.set(value.value, canonicalToken);
        this.#rememberOptimizedGeneration(context.structural, generationToken);
      }
    } else {
      this.#optimizedDescriptorTokens.delete(value.value);
    }
    return snapshot;
  }

  #rememberOptimizedGeneration(
    structural: MetadataStructuralKey,
    rawToken: string,
  ): void {
    if (this.#state !== "active" || this.#maxOptimizedGenerationTokens === 0) {
      return;
    }
    const objectKind = structural.objectKind;
    if (
      objectKind !== "function" &&
      objectKind !== "recursive-function" &&
      objectKind !== "structure"
    ) {
      throw new Error(`unsupported metadata object kind ${objectKind}`);
    }
    const token = canonicalOptimizedGenerationToken(rawToken, objectKind);
    const key = metadataGenerationKey(objectKind, structural.objectName);
    this.#optimizedGenerationTokens.delete(key);
    while (
      this.#optimizedGenerationTokens.size >=
      this.#maxOptimizedGenerationTokens
    ) {
      const oldest = this.#optimizedGenerationTokens.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) {
        throw new Error("optimized metadata generation accounting is inconsistent");
      }
      this.#optimizedGenerationTokens.delete(oldest);
    }
    this.#optimizedGenerationTokens.set(key, Object.freeze({
      structural,
      token,
    }));
  }

  async #executeMetadataRefresh(
    admission: MetadataRefreshAdmission,
  ): Promise<DirectDestinationMetadataRefreshResult> {
    const signal = this.#metadataRefreshRetirement.signal;
    const validated = await this.#withRepositorySession(signal, async (session) => {
      const batch = await session.getOptimizedMetadataTimestamps(
        admission.functionNames,
        admission.structureNames,
        signal,
      );
      // Validate while the lease is still active. A malformed injected/session
      // boundary is therefore disposed with the same conservative policy as a
      // decoder failure, before any cache state is changed.
      return validateMetadataRefreshBatch(
        batch,
        admission.functionNames,
        admission.structureNames,
      );
    });
    if (this.#state !== "active") throw this.#retiredError();

    const invalidateFunctions: boolean[] = [];
    const invalidateStructures: boolean[] = [];
    for (let index = 0; index < admission.functionNames.length; index += 1) {
      const name = admission.functionNames[index]!;
      const records = admission.functionRecords[index]!;
      invalidateFunctions.push(
        records.length > 0 &&
        (
          validated.functionErrors.has(name) ||
          records.some((record) =>
            validated.functionTokens.get(name) !== record.token
          )
        ),
      );
    }
    for (let index = 0; index < admission.structureNames.length; index += 1) {
      const name = admission.structureNames[index]!;
      const record = admission.structureRecords[index];
      invalidateStructures.push(
        record !== undefined &&
        (
          validated.structureErrors.has(name) ||
          validated.structureTokens.get(name) !== record.token
        ),
      );
    }

    const invalidatedFunctionNames: string[] = [];
    const invalidatedStructureNames: string[] = [];
    for (let index = 0; index < invalidateFunctions.length; index += 1) {
      if (!invalidateFunctions[index]) continue;
      const name = admission.functionNames[index]!;
      let invalidated = false;
      for (const record of admission.functionRecords[index]!) {
        if (
          !validated.functionErrors.has(name) &&
          validated.functionTokens.get(name) === record.token
        ) {
          continue;
        }
        const objectKind = record.structural.objectKind;
        if (objectKind !== "function" && objectKind !== "recursive-function") {
          throw new Error(
            `unsupported function metadata object kind ${objectKind}`,
          );
        }
        const key = metadataGenerationKey(objectKind, name);
        // A descriptor reloaded while the timestamp call was in flight owns a
        // newer record and must not be invalidated by this stale comparison.
        if (this.#optimizedGenerationTokens.get(key) !== record) continue;
        this.#repository.invalidate(record.structural);
        this.#optimizedGenerationTokens.delete(key);
        invalidated = true;
      }
      if (invalidated) invalidatedFunctionNames.push(name);
    }
    for (let index = 0; index < invalidateStructures.length; index += 1) {
      if (!invalidateStructures[index]) continue;
      const name = admission.structureNames[index]!;
      const record = admission.structureRecords[index]!;
      const key = metadataGenerationKey("structure", name);
      if (this.#optimizedGenerationTokens.get(key) !== record) continue;
      this.#repository.invalidate(record.structural);
      this.#optimizedGenerationTokens.delete(key);
      invalidatedStructureNames.push(name);
    }
    return Object.freeze({
      checkedFunctionNames: admission.functionNames,
      checkedStructureNames: admission.structureNames,
      invalidatedFunctionNames: Object.freeze(invalidatedFunctionNames),
      invalidatedStructureNames: Object.freeze(invalidatedStructureNames),
    });
  }

  async #probeOptimizedMetadata(signal: AbortSignal): Promise<void> {
    try {
      await this.#withRepositorySession(signal, async (session) => {
        await session.getOptimizedFunctionInterface(
          "RFC_PING",
          this.#connection.language,
          signal,
        );
      });
    } catch (error) {
      classifyOptimizedMetadataFailure(error);
    }
  }

  async #withRepositorySession<T>(
    signal: AbortSignal,
    operation: (session: BoundDirectSession) => Promise<T>,
  ): Promise<T> {
    const lease = await this.#repositoryPool.acquireOne({ signal });
    let primary: unknown;
    let value: T | undefined;
    try {
      value = await this.#repositoryPool.withActiveLease(
        lease,
        operation,
      );
    } catch (error) {
      primary = error;
    }
    try {
      await this.#repositoryPool.release(lease, {
        reusable: primary === undefined || failureLeavesSessionReusable(primary),
      });
    } catch (cleanupError) {
      if (primary !== undefined) {
        throw aggregatePrimaryAndCleanup(
          primary,
          cleanupError,
          "metadata access and repository-session cleanup both failed",
        );
      }
      throw cleanupError;
    }
    if (primary !== undefined) throw primary;
    return value!;
  }

  #runApplicationOperation<T>(
    record: ApplicationLeaseRecord,
    operation: () => T | PromiseLike<T>,
  ): Promise<T> {
    if (record.state !== "owned") {
      return Promise.reject(new Error("application lease has already been released"));
    }
    if (record.active) {
      return Promise.reject(
        new Error("application lease already has an active operation"),
      );
    }
    record.active = true;
    const done = completion();
    record.tail = done.promise;
    // Begin in a microtask so reentrant release always observes the published tail.
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        record.active = false;
        if (record.tail === done.promise && record.state === "owned") {
          record.tail = undefined;
        }
        done.resolve();
      });
  }

  async #acquireApplications(
    count: number,
    options: ConnectionPoolAcquireOptions,
  ): Promise<readonly DirectDestinationApplicationLease[]> {
    if (this.#state !== "active") throw this.#retiredError();
    const poolLeases = await this.#applicationPool.acquire(count, options);
    if (this.#state !== "active") {
      const primary = this.#retiredError();
      const cleanup = await Promise.allSettled(
        poolLeases.map((lease) =>
          this.#applicationPool.release(lease, { reusable: false })),
      );
      const failures = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          [primary, ...failures],
          "destination retired while atomic application acquire was completing",
          { cause: primary },
        );
      }
      throw primary;
    }
    return Object.freeze(
      poolLeases.map((lease) => this.#publishApplicationLease(lease)),
    );
  }

  #leaseRecord(
    lease: DirectDestinationApplicationLease,
  ): ApplicationLeaseRecord {
    if (
      (typeof lease !== "object" && typeof lease !== "function") ||
      lease === null
    ) {
      throw new TypeError("application lease must be an opaque owner token");
    }
    const record = this.#knownLeases.get(lease);
    if (record === undefined) {
      throw new Error("application lease does not belong to this destination");
    }
    return record;
  }

  #ownedLeaseRecord(
    lease: DirectDestinationApplicationLease,
  ): ApplicationLeaseRecord {
    const record = this.#leaseRecord(lease);
    if (record.state !== "owned") {
      throw new Error("application lease has already been released");
    }
    return record;
  }

  #retiredError(): Error {
    return new Error(
      `direct destination ${this.configuration.generationId} is retired`,
    );
  }
}

/** Conservative business-call classifier suitable for TransactionRuntime. */
export function classifyDirectDestinationTransactionFailure(
  failure: unknown,
): TransactionFailureKind {
  if (failure instanceof DirectDestinationMetadataPreflightError) {
    return "recoverable";
  }
  if (failure instanceof DirectCpicPreWireError) return "recoverable";
  if (
    failure instanceof RfcCoreError &&
    failure.failure.disposition === RfcConnectionDisposition.Reusable
  ) {
    return "recoverable";
  }
  return "ambiguous";
}

/** Capture an owner's opaque-lease operations for direct TransactionRuntime use. */
export function createDirectDestinationTransactionAdapter(
  owner: DirectDestinationOwner,
): TransactionLeaseAdapter<DirectDestinationApplicationLease> {
  if (typeof owner !== "object" || owner === null) {
    throw new TypeError("direct destination owner must be an object");
  }
  const acquire = callable(owner.acquireApplication, "owner.acquireApplication");
  const invoke = callable(owner.invoke, "owner.invoke");
  const reset = callable(owner.resetApplication, "owner.resetApplication");
  const release = callable(owner.releaseApplication, "owner.releaseApplication");
  const adapter: TransactionLeaseAdapter<DirectDestinationApplicationLease> = {
    acquire(context) {
      return safeApply(acquire, owner, [{ signal: context.signal }]);
    },
    invoke(lease, invocation: TransactionInvocation, context) {
      const functionName = invocation.functionName;
      const parameters = invocation.parameters;
      const notRequested = invocation.notRequested;
      return safeApply(invoke, owner, [
        lease,
        Object.freeze({
          functionName,
          parameters,
          ...(notRequested === undefined
            ? {}
            : { notRequested: Object.freeze(new Set(notRequested)) }),
        }),
        context.signal,
      ]);
    },
    reset(lease, context) {
      return safeApply(reset, owner, [lease, context.signal]);
    },
    release(lease, disposition) {
      // Ownership is already transferred; release intentionally ignores abort.
      return safeApply(release, owner, [
        lease,
        Object.freeze({ reusable: disposition.reusable }),
      ]);
    },
  };
  return Object.freeze(adapter);
}
