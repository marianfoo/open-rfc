import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import { types as nodeUtilTypes } from "node:util";

import {
  CpicCallError,
  CpicLogonError,
  DirectCpicPreWireError,
  type DirectCpicSessionInfo,
} from "../client/direct-cpic-session.js";
import {
  ABAPError,
  NodeRfcError,
  RFCError,
  RFCErrorCode,
  rfcFailureToPublicError,
} from "../client/rfc-errors.js";
import {
  RfcConnectionDisposition,
  RfcCoreError,
  RfcTransmissionState,
} from "../client/rfc-failure.js";
import {
  DirectDestinationMetadataPreflightError,
  type DirectDestinationApplicationLease,
  type DirectDestinationOwner,
  type DirectDestinationSessionFactory,
} from "../destination/direct-destination-owner.js";
import {
  createDeferredRfcDiagnosticReporter,
  snapshotRfcDiagnosticEmitter,
  type RfcDiagnosticEmitter,
  type RfcDiagnosticReporter,
} from "../diagnostics/structured-diagnostics.js";
import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import { NiTransportError } from "../transport/ni-socket.js";
import { SapRouterTransportError } from "../transport/saprouter-tunnel.js";
import {
  snapshotClassicInt8Mode,
  type ClassicInt8Mode,
} from "../values/classic-int8.js";
import {
  ClassicBcdConversionError,
  snapshotClassicBcdMode,
} from "../values/classic-bcd.js";
import {
  createLiveRecursiveSerializerDecisionProvider,
  snapshotLiveRecursiveSerializerPolicy,
  type LiveRecursiveSerializerPolicy,
} from "../values/recursive-serializer-classification.js";
import { snapshotRfcValue } from "../values/rfc-value-snapshot.js";
import {
  languageSapToIso,
  snapshotDirectConnectionParameters,
  type NormalizedDirectConnection,
  type RfcConnectionParameters,
} from "./connection-parameters.js";
import { planCompatibilityOwnerRoute } from "./compatibility-owner-route.js";
import {
  bindDirectCompatibilityOwnerFactory,
  productionDirectCompatibilityOwnerFactory,
  type DirectCompatibilityOwnerFactory,
} from "./direct-owner-factory.js";
import type { NodeRfcEnvironment } from "./node-rfc-public-surface.js";
import { validateRFCClientConnectionParameterSurface } from
  "./rfc-client-session-route.js";

export type RfcObject = Readonly<Record<string, unknown>>;

export interface RfcClientOptions {
  readonly bcd?: string | Function;
  /** JavaScript representation for ABAP INT8; archived compatibility defaults to number. */
  readonly int8Mode?: ClassicInt8Mode;
  readonly stateless?: boolean;
  readonly timeout?: number;
  readonly logLevel?: number;
  /** Optional bounded structured runtime diagnostics. */
  readonly diagnostics?: RfcDiagnosticEmitter;
  /** open-rfc extension: evidence-bound admission for recursive live sends. */
  readonly recursiveSerializerPolicy?: LiveRecursiveSerializerPolicy;
}

export interface RfcCallOptions {
  readonly notRequested?: readonly string[];
  readonly timeout?: number;
}

export interface RfcClientConfig {
  readonly connectionParameters: RfcConnectionParameters;
  readonly clientOptions?: RfcClientOptions;
}

export interface PooledClientInternals {
  readonly poolId: number;
  readonly release: (client: Client) => Promise<void>;
}

export interface PooledClientAttachment {
  readonly owner: DirectDestinationOwner;
  readonly lease: DirectDestinationApplicationLease;
  readonly info: DirectCpicSessionInfo;
  readonly connection?: NormalizedDirectConnection;
}

export interface PooledClientClaim {
  readonly owner: DirectDestinationOwner;
  readonly lease?: DirectDestinationApplicationLease;
  readonly tail: Promise<void>;
  readonly reusableAfterTail: () => boolean;
}

export const pooledClientAttach = Symbol("open-rfc pooled client attach");
export const pooledClientClaim = Symbol("open-rfc pooled client claim");

// The packed ESM/CJS consumer contract binds this value to package.json.
// Release Please updates this extra file in the public release PR.
const OPEN_RFC_PACKAGE_VERSION = "0.2.0"; // x-release-please-version

export const environment = Object.freeze({
  platform: Object.freeze({ name: platform(), arch: arch(), release: release() }),
  env: Object.freeze({ SAPNWRFC_HOME: "", RFC_INI: "" }),
  noderfc: Object.freeze({
    // Keep release-owned version bytes out of the emitted declaration
    // contract. The public type is `string`; inferring the current version
    // literal would make every Release Please version bump look like API drift.
    version: OPEN_RFC_PACKAGE_VERSION as string,
    implementation: "open-rfc-sdk-free",
    nwrfcsdk: Object.freeze({ major: 0, minor: 0, patchLevel: 0 }),
  }),
  versions: process.versions,
}) satisfies NodeRfcEnvironment;

type ClientState = "closed" | "opening" | "open" | "closing" | "faulted";

function closedRequest(operation: string): NodeRfcError {
  return new NodeRfcError(`RFM client request over closed connection: ${operation}`);
}

function canceledRequest(): RFCError {
  return new RFCError("Connection was canceled.", {
    name: "RfcLibError",
    group: 4,
    code: RFCErrorCode.RFC_CANCELED,
    codeString: "RFC_CANCELED",
    key: "RFC_CANCELED",
  });
}

function invalidParameter(message: string): RFCError {
  return new RFCError(message, {
    name: "RfcLibError",
    group: 5,
    code: RFCErrorCode.RFC_INVALID_PARAMETER,
    codeString: "RFC_INVALID_PARAMETER",
    key: "RFC_INVALID_PARAMETER",
  });
}

function metadataCause(error: unknown): unknown {
  if (error instanceof DirectDestinationMetadataPreflightError) {
    return error.cause;
  }
  if (error instanceof DirectCpicPreWireError) return error.cause;
  return error;
}

export function projectNodeRfcPublicError(error: unknown): unknown {
  const cause = metadataCause(error);
  if (cause instanceof ClassicBcdConversionError) return cause.cause;
  if (cause instanceof ABAPError || cause instanceof RFCError) return cause;
  if (cause instanceof RfcCoreError) {
    return rfcFailureToPublicError(cause.failure);
  }
  if (cause instanceof CpicLogonError) {
    return new RFCError(cause.message, {
      name: "RfcLibError",
      group: 3,
      code: RFCErrorCode.RFC_LOGON_FAILURE,
      codeString: "RFC_LOGON_FAILURE",
      key: "RFC_LOGON_FAILURE",
    });
  }
  if (cause instanceof CpicCallError) {
    return new RFCError(cause.message, {
      name: "RfcLibError",
      group: 2,
      code: RFCErrorCode.RFC_ABAP_RUNTIME_FAILURE,
      codeString: "RFC_ABAP_RUNTIME_FAILURE",
      key: `CPIC_STATUS_${cause.status}`,
    });
  }
  if (cause instanceof NiTransportError) {
    if (cause.code === "NI_ABORTED") return canceledRequest();
    const timeout =
      cause.code === "NI_CONNECT_TIMEOUT" || cause.code === "NI_RECEIVE_TIMEOUT";
    return new RFCError(cause.message, {
      name: "RfcLibError",
      group: 4,
      code: timeout
        ? RFCErrorCode.RFC_TIMEOUT
        : RFCErrorCode.RFC_COMMUNICATION_FAILURE,
      codeString: timeout ? "RFC_TIMEOUT" : "RFC_COMMUNICATION_FAILURE",
      key: cause.code,
    });
  }
  if (cause instanceof SapRouterTransportError) {
    const canceled = cause.code === "SAPROUTER_ABORTED";
    const timeout = cause.code === "SAPROUTER_CONNECT_TIMEOUT" ||
      cause.code === "SAPROUTER_HANDSHAKE_TIMEOUT";
    const code = canceled
      ? RFCErrorCode.RFC_CANCELED
      : timeout
        ? RFCErrorCode.RFC_TIMEOUT
        : RFCErrorCode.RFC_COMMUNICATION_FAILURE;
    const codeString = canceled
      ? "RFC_CANCELED"
      : timeout
        ? "RFC_TIMEOUT"
        : "RFC_COMMUNICATION_FAILURE";
    const message = canceled
      ? "SAProuter connection was canceled."
      : timeout
        ? "SAProuter connection timed out."
        : "SAProuter connection failed.";
    return new RFCError(message, {
      name: "RfcLibError",
      group: 4,
      code,
      codeString,
      key: cause.code,
    });
  }
  return cause;
}

export function projectNodeRfcNormalizationError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (
    /^ashost must be a non-empty string or number$/u.test(error.message) ||
    /^one of ashost, mshost, or wshost is required$/u.test(error.message) ||
    /^(?:gwhost|gwserv|port|sysnr|cpic_streaming) requires a selected ashost route$/u
      .test(error.message)
  ) {
    return invalidParameter(
      "Parameter ASHOST, GWHOST, MSHOST or PORT is missing.",
    );
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return invalidParameter(error.message);
  }
  return invalidParameter(error.message);
}

function invocationError(error: unknown): unknown {
  const mapped = projectNodeRfcPublicError(error);
  if (!(mapped instanceof Error)) return mapped;
  const unknownParameter = /^unknown parameter (.+)$/u.exec(mapped.message);
  if (unknownParameter !== null) {
    return invalidParameter(`field '${unknownParameter[1]!}' not found`);
  }
  const unknownField = / contains unknown field (.+)$/u.exec(mapped.message);
  if (unknownField !== null) {
    return invalidParameter(`field '${unknownField[1]!}' not found`);
  }
  return mapped;
}

function failureWithCleanupEvidence(
  authoritative: unknown,
  cleanupFailures: readonly unknown[],
  message: string,
): unknown {
  if (cleanupFailures.length === 0) return authoritative;
  return new AggregateError(
    [authoritative, ...cleanupFailures],
    message,
    { cause: authoritative },
  );
}

function statelessResetFailure(
  primaryFailure: unknown,
  resetFailure: unknown,
  message: string,
): AggregateError {
  const projectedResetFailure = invocationError(resetFailure);
  return new AggregateError(
    [primaryFailure, projectedResetFailure],
    message,
    { cause: primaryFailure },
  );
}

function validateTimeout(seconds: number | undefined, path: string): number | undefined {
  if (seconds === undefined) return undefined;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2_147_483) {
    throw new RangeError(`${path} must be a positive number of seconds`);
  }
  return Math.ceil(seconds * 1_000);
}

function ownDataValue(
  input: object,
  name: string,
  path: string,
): { readonly present: boolean; readonly value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (descriptor === undefined) return Object.freeze({ present: false });
  if (!("value" in descriptor)) {
    throw new TypeError(`${path}.${name} must be an own data property`);
  }
  return Object.freeze({ present: true, value: descriptor.value });
}

const RFC_CLIENT_OPTION_NAMES = Object.freeze([
  "bcd",
  "int8Mode",
  "stateless",
  "timeout",
  "logLevel",
  "diagnostics",
  "recursiveSerializerPolicy",
] as const);
const RFC_CLIENT_OPTION_KEYS = new Set<string>(RFC_CLIENT_OPTION_NAMES);

function validateRfcClientOptionSurface(input: object): void {
  if (nodeUtilTypes.isProxy(input)) {
    throw new TypeError("clientOptions must not be a Proxy");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("clientOptions must not have a custom prototype");
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw new TypeError("client option keys must be strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`clientOptions.${key} must be an own data property`);
    }
    if (!RFC_CLIENT_OPTION_KEYS.has(key)) {
      throw new TypeError(`unknown client option ${key}`);
    }
  }
}

export function snapshotRfcClientOptions(
  input: RfcClientOptions | undefined,
): RfcClientOptions | undefined {
  if (input === undefined) {
    return Object.freeze({ bcd: "string", int8Mode: "number" });
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("clientOptions must be an object");
  }
  validateRfcClientOptionSurface(input);
  const snapshot: {
    bcd?: string | Function;
    int8Mode?: ClassicInt8Mode;
    stateless?: boolean;
    timeout?: number;
    logLevel?: number;
    diagnostics?: RfcDiagnosticEmitter;
    recursiveSerializerPolicy?: LiveRecursiveSerializerPolicy;
  } = {};
  for (const name of RFC_CLIENT_OPTION_NAMES) {
    const captured = ownDataValue(input, name, "clientOptions");
    if (!captured.present) continue;
    // An explicitly undefined BCD converter has the same archived API meaning
    // as an omitted converter: install the default below. Do not first create
    // a non-configurable undefined property which cannot then be replaced.
    if (
      (
        name === "bcd" ||
        name === "int8Mode" ||
        name === "diagnostics" ||
        name === "recursiveSerializerPolicy"
      ) &&
      captured.value === undefined
    ) continue;
    Object.defineProperty(snapshot, name, {
      value: name === "diagnostics"
        ? snapshotRfcDiagnosticEmitter(
            captured.value as RfcDiagnosticEmitter,
            "clientOptions.diagnostics",
          )
        : name === "recursiveSerializerPolicy"
          ? snapshotLiveRecursiveSerializerPolicy(
              captured.value as LiveRecursiveSerializerPolicy,
            )
          : name === "int8Mode"
            ? snapshotClassicInt8Mode(captured.value, "clientOptions.int8Mode")
            : captured.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  if (snapshot.bcd !== undefined) {
    snapshotClassicBcdMode(snapshot.bcd, 'Client option "bcd"');
  }
  if (snapshot.bcd === undefined) {
    Object.defineProperty(snapshot, "bcd", {
      value: "string",
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  if (snapshot.int8Mode === undefined) {
    Object.defineProperty(snapshot, "int8Mode", {
      value: "number",
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  if (
    snapshot.stateless !== undefined &&
    typeof snapshot.stateless !== "boolean"
  ) {
    throw new TypeError("clientOptions.stateless must be a boolean");
  }
  validateTimeout(snapshot.timeout, "clientOptions.timeout");
  if (
    snapshot.logLevel !== undefined &&
    (!Number.isSafeInteger(snapshot.logLevel) || snapshot.logLevel < 0)
  ) {
    throw new RangeError("clientOptions.logLevel must be a non-negative integer");
  }
  return Object.freeze(snapshot);
}

function notRequestedSet(options: RfcCallOptions): ReadonlySet<string> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Call options argument must be an object");
  }
  const source = options.notRequested;
  if (source !== undefined && !Array.isArray(source)) {
    throw new TypeError("notRequested must be an array of parameter names");
  }
  const result = new Set<string>();
  for (const name of source ?? []) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("notRequested entries must be non-empty strings");
    }
    if (result.has(name)) throw new Error(`notRequested contains duplicate ${name}`);
    result.add(name);
  }
  return Object.freeze(result);
}

function validateParameterNames(
  functionName: string,
  input: RfcObject,
): void {
  for (const name of Object.keys(input)) {
    if (name.length === 0) {
      throw new TypeError(
        `Empty RFM parameter name when calling "${functionName}"`,
      );
    }
    if (!/^[A-Za-z0-9_]+$/u.test(name)) {
      throw new TypeError(
        `RFM parameter name invalid: "${name}" when calling "${functionName}"`,
      );
    }
  }
}

function snapshotRfcObject(input: RfcObject): RfcObject {
  return snapshotRfcValue(input, "RFM parameters") as RfcObject;
}

function validateOptionalCallback(
  callback: unknown,
  method: string,
): void {
  if (callback !== undefined && typeof callback !== "function") {
    throw new TypeError(
      `Client ${method}() argument, if provided, must be a Function`,
    );
  }
}

function callbackResult<T>(
  promise: Promise<T>,
  callback: ((error: unknown, result?: T) => void) | undefined,
): Promise<T> | void {
  if (callback === undefined) return promise;
  void promise.then(
    (result) => callback(undefined, result),
    (error: unknown) => callback(error),
  );
}

function applicationConnectionInfo(
  normalized: NormalizedDirectConnection,
  info: DirectCpicSessionInfo,
): Readonly<Record<string, string>> {
  const applicationServerHost =
    info.selectedApplicationServerHost ?? normalized.applicationServerHost;
  const gatewayHost = info.selectedGatewayHost ?? normalized.host;
  const systemNumber = info.selectedSystemNumber ?? normalized.sysnr;
  return Object.freeze({
    dest: "",
    host: applicationServerHost,
    partnerHost: applicationServerHost,
    sysNumber: systemNumber,
    sysId: "",
    client: normalized.client,
    user: normalized.user,
    language: normalized.language,
    trace: "0",
    isoLanguage: languageSapToIso(normalized.language),
    codepage: "4103",
    partnerCodepage: info.peerCodePage,
    rfcRole: "C",
    type: "3",
    partnerType: "3",
    rel: "",
    partnerRel: "",
    kernelRel: "",
    cpicConvId: "",
    progName: "open-rfc",
    partnerBytesPerChar: "2",
    partnerSystemCodepage: info.peerCodePage,
    partnerIP: gatewayHost,
    partnerIPv6: "",
  });
}

function recoverableApplicationFailure(error: unknown): boolean {
  if (error instanceof ClassicBcdConversionError) return true;
  if (error instanceof DirectDestinationMetadataPreflightError) return true;
  if (error instanceof DirectCpicPreWireError) return true;
  if (error instanceof RfcCoreError) {
    return error.failure.disposition === RfcConnectionDisposition.Reusable;
  }
  // Unknown errors fail closed. Only the explicit pre-wire wrapper above and
  // typed reusable core failures prove that no uncertain application state
  // can survive recycling.
  return false;
}

function statelessContextResetRequired(error: unknown): boolean {
  return error instanceof ClassicBcdConversionError ||
    error instanceof RfcCoreError &&
      error.failure.disposition === RfcConnectionDisposition.Reusable &&
      error.failure.transmission === RfcTransmissionState.Complete;
}

function diagnosticDuration(started: number): number {
  let elapsed = 0;
  try {
    elapsed = performance.now() - started;
  } catch {
    // Timing evidence must never affect connector behavior.
  }
  return Number.isFinite(elapsed)
    ? Math.min(86_400_000, Math.max(0, elapsed))
    : 0;
}

function diagnosticNow(): number {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function diagnosticCorrelationId(): string | undefined {
  try {
    return randomUUID();
  } catch {
    return undefined;
  }
}

let nextClientId = 1;
let createOwner = bindDirectCompatibilityOwnerFactory(
  productionDirectCompatibilityOwnerFactory,
);

/** SDK-free compatibility client for the archived `node-rfc` API. */
export class Client {
  readonly #id = nextClientId++;
  readonly #connectionParameters: RfcConnectionParameters;
  readonly #clientOptions: RfcClientOptions | undefined;
  readonly #config: RfcClientConfig;
  readonly #poolId: number;
  readonly #releaseToPool: ((client: Client) => Promise<void>) | undefined;
  readonly #report: RfcDiagnosticReporter | undefined;
  #normalized: NormalizedDirectConnection | undefined;
  #owner: DirectDestinationOwner | undefined;
  #lease: DirectDestinationApplicationLease | undefined;
  #state: ClientState = "closed";
  #connectionHandle = 0;
  #connectionInfoValue: Readonly<Record<string, string>> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #activeCalls = new Set<AbortController>();
  #closePromise: Promise<void> | undefined;
  #releaseClaimed = false;
  #leaseReusable = true;
  #openingAbort: AbortController | undefined;

  constructor(
    connectionParameters: RfcConnectionParameters,
    clientOptions?: RfcClientOptions,
    pooled?: PooledClientInternals,
  ) {
    if (connectionParameters === undefined) {
      throw new TypeError("Client constructor requires an argument");
    }
    validateRFCClientConnectionParameterSurface(connectionParameters);
    const snapshot = snapshotDirectConnectionParameters(connectionParameters);
    if (Object.keys(snapshot).length === 0) {
      throw new TypeError("Client connection parameters missing");
    }
    const options = snapshotRfcClientOptions(clientOptions);
    this.#connectionParameters = snapshot;
    this.#clientOptions = options;
    this.#config = Object.freeze({
      connectionParameters: snapshot,
      ...(options === undefined ? {} : { clientOptions: options }),
    });
    this.#poolId = pooled?.poolId ?? 0;
    this.#releaseToPool = pooled?.release;
    this.#report = createDeferredRfcDiagnosticReporter(options?.diagnostics);
  }

  static get environment(): typeof environment { return environment; }
  get environment(): typeof environment { return environment; }
  /** Compatibility binding without exposing a raw socket or session object. */
  get binding(): Client { return this; }
  get id(): number { return this.#id; }
  get alive(): boolean {
    return this.#state === "open" && this.#lease !== undefined;
  }
  get connectionHandle(): number { return this.#connectionHandle; }
  get pool_id(): number { return this.#poolId; }
  get config(): RfcClientConfig { return this.#config; }
  get _id(): string {
    return `${this.#id} handle: ${this.#connectionHandle} ` +
      (this.#poolId === 0 ? "[d]" : `[m] pool: ${this.#poolId}`);
  }

  get connectionInfo(): Readonly<Record<string, string>> | NodeRfcError {
    return this.alive && this.#connectionInfoValue !== undefined
      ? this.#connectionInfoValue
      : closedRequest("connectionInfo");
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#operationTail.then(operation, operation);
    this.#operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  #requiredBinding(operation: string): {
    readonly owner: DirectDestinationOwner;
    readonly lease: DirectDestinationApplicationLease;
  } {
    if (!this.alive || this.#owner === undefined || this.#lease === undefined) {
      throw closedRequest(operation);
    }
    return Object.freeze({ owner: this.#owner, lease: this.#lease });
  }

  #installLease(
    owner: DirectDestinationOwner,
    lease: DirectDestinationApplicationLease,
    info: DirectCpicSessionInfo,
  ): void {
    const normalized = this.#normalized;
    if (normalized === undefined) {
      throw new Error("RFC client owner route was not initialized");
    }
    this.#owner = owner;
    this.#lease = lease;
    // A gateway is allowed to recycle its connection-table index after a
    // terminal generation. node-rfc's public handle identifies the physical
    // client generation instead, and therefore remains stable when the same
    // pooled lease is reattached or reset.
    this.#connectionHandle = info.generationHandle;
    this.#connectionInfoValue = applicationConnectionInfo(normalized, info);
    this.#leaseReusable = true;
    this.#state = "open";
  }

  async #openCore(): Promise<Client> {
    if (this.#state !== "opening") {
      if (this.#state === "closing") throw canceledRequest();
      throw new NodeRfcError("RFM client is already open");
    }
    let normalized: NormalizedDirectConnection;
    let sessionFactory: DirectDestinationSessionFactory | undefined;
    try {
      const route = planCompatibilityOwnerRoute(this.#connectionParameters);
      normalized = route.connection;
      sessionFactory = route.sessionFactory;
    } catch (error) {
      this.#state = "closed";
      throw projectNodeRfcNormalizationError(error);
    }
    const recursiveSerializerPolicy =
      this.#clientOptions?.recursiveSerializerPolicy;
    let owner: DirectDestinationOwner;
    try {
      owner = createOwner({
        connection: normalized,
        ...(sessionFactory === undefined ? {} : { sessionFactory }),
        applicationPool: {
          maxConnections: 1,
          maxWaiters: 1,
          acquireTimeoutMs: 30_000,
          lifecycleTimeoutMs: 45_000,
          shutdownTimeoutMs: 60_000,
          lowWater: 0,
          idleHigh: 1,
          validateOnCheckout: false,
          ...(this.#clientOptions?.diagnostics === undefined
            ? {}
            : { diagnostics: this.#clientOptions.diagnostics }),
        },
        repositoryPool: {
          maxConnections: 1,
          maxWaiters: 32,
          acquireTimeoutMs: 30_000,
          lifecycleTimeoutMs: 45_000,
          shutdownTimeoutMs: 60_000,
          lowWater: 0,
          idleHigh: 1,
          validateOnCheckout: false,
          ...(this.#clientOptions?.diagnostics === undefined
            ? {}
            : { diagnostics: this.#clientOptions.diagnostics }),
        },
        ...(this.#clientOptions?.diagnostics === undefined
          ? {}
          : { metadata: { diagnostics: this.#clientOptions.diagnostics } }),
        ...(recursiveSerializerPolicy === undefined
          ? {}
          : {
              session: {
                recursiveSerializerDecisionProvider:
                  createLiveRecursiveSerializerDecisionProvider(
                    recursiveSerializerPolicy,
                  ),
              },
            }),
      });
    } catch (error) {
      if (this.#state === "opening") this.#state = "closed";
      throw projectNodeRfcPublicError(error);
    }
    this.#normalized = normalized;
    this.#owner = owner;
    let lease: DirectDestinationApplicationLease | undefined;
    const openingAbort = new AbortController();
    this.#openingAbort = openingAbort;
    try {
      lease = await owner.acquireApplication({ signal: openingAbort.signal });
      const info = await owner.applicationInfo(lease);
      if (this.#state !== "opening") {
        throw canceledRequest();
      }
      this.#installLease(owner, lease, info);
      return this;
    } catch (error) {
      const authoritative = openingAbort.signal.aborted
        ? canceledRequest()
        : projectNodeRfcPublicError(error);
      const cleanupFailures: unknown[] = [];
      if (lease !== undefined && this.#lease !== lease) {
        try {
          await owner.releaseApplication(lease, { reusable: false });
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await owner.retire();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      this.#owner = undefined;
      this.#lease = undefined;
      this.#normalized = undefined;
      this.#connectionInfoValue = undefined;
      this.#connectionHandle = 0;
      this.#state = "closed";
      throw failureWithCleanupEvidence(
        authoritative,
        cleanupFailures,
        "RFC client open and cleanup failed",
      );
    } finally {
      if (this.#openingAbort === openingAbort) this.#openingAbort = undefined;
    }
  }

  async #retireDirectOwner(): Promise<void> {
    const owner = this.#owner;
    const lease = this.#lease;
    this.#lease = undefined;
    this.#connectionHandle = 0;
    this.#connectionInfoValue = undefined;
    const failures: unknown[] = [];
    if (owner !== undefined && lease !== undefined) {
      try {
        await owner.releaseApplication(lease, { reusable: false });
      } catch (error) {
        failures.push(error);
      }
    }
    if (owner !== undefined) {
      try {
        await owner.retire();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#owner = undefined;
    this.#normalized = undefined;
    this.#state = "closed";
    if (failures.length === 1) throw projectNodeRfcPublicError(failures[0]);
    if (failures.length > 1) {
      throw new AggregateError(failures, "RFC client close failed");
    }
  }

  async #replaceFatalLease(
    owner: DirectDestinationOwner,
    failedLease: DirectDestinationApplicationLease,
    failure: unknown,
  ): Promise<never> {
    const replacementStarted = diagnosticNow();
    const coreFailure = failure instanceof RfcCoreError
      ? failure.failure
      : undefined;
    const authoritative = invocationError(failure);
    const cleanupFailures: unknown[] = [];
    // Pool release transfers the token synchronously and then waits for this
    // operation tail. The pool is the sole disposer after that handoff.
    if (this.#lease !== failedLease) {
      // A managed-client release may already have transferred this exact
      // operation's token to its pool. Mark that claim non-reusable, but never
      // poison a different replacement generation installed on the client.
      if (this.#releaseClaimed && this.#lease === undefined) {
        this.#leaseReusable = false;
      }
      throw authoritative;
    }
    this.#leaseReusable = false;
    if (this.#lease === failedLease) {
      this.#lease = undefined;
      this.#connectionHandle = 0;
      this.#connectionInfoValue = undefined;
    }
    try {
      await owner.releaseApplication(failedLease, { reusable: false });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      this.#state = "faulted";
      if (this.#poolId === 0) {
        try {
          await owner.retire();
          this.#owner = undefined;
          this.#normalized = undefined;
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      throw failureWithCleanupEvidence(
        authoritative,
        cleanupFailures,
        "RFC invocation failed and connection cleanup did not converge",
      );
    }
    if (this.#state !== "open") throw authoritative;
    try {
      const replacement = await owner.acquireApplication();
      try {
        const info = await owner.applicationInfo(replacement);
        if (this.#state !== "open") {
          await owner.releaseApplication(replacement, { reusable: false });
        } else {
          this.#installLease(owner, replacement, info);
          this.#report?.({
            category: "lifecycle",
            level: "info",
            code: "lifecycle.replaced",
            ...(coreFailure === undefined
              ? { disposition: "replace" }
              : {
                  correlationId: coreFailure.correlationId,
                  disposition: coreFailure.disposition,
                }),
            state: "open",
            durationMs: diagnosticDuration(replacementStarted),
          });
        }
      } catch (error) {
        try {
          await owner.releaseApplication(replacement, { reusable: false });
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        throw error;
      }
    } catch {
      this.#state = "faulted";
      if (this.#poolId === 0) {
        try {
          await owner.retire();
          this.#owner = undefined;
          this.#normalized = undefined;
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
    }
    throw failureWithCleanupEvidence(
      authoritative,
      cleanupFailures,
      "RFC invocation failed and replacement cleanup did not converge",
    );
  }

  open(callback?: (error: unknown) => void): Promise<Client> | void {
    validateOptionalCallback(callback, "open");
    if (this.#poolId !== 0) {
      return callbackResult(
        Promise.reject(new NodeRfcError("managed clients cannot be opened directly")),
        callback,
      );
    }
    if (this.#state !== "closed") {
      return callbackResult(
        Promise.reject(new NodeRfcError("RFM client is already open")),
        callback,
      );
    }
    this.#state = "opening";
    const correlationId = diagnosticCorrelationId();
    const started = diagnosticNow();
    this.#report?.({
      category: "network",
      level: "info",
      code: "network.connect",
      ...(correlationId === undefined ? {} : { correlationId }),
      state: "connecting",
      phase: "connect",
    });
    const pending = this.#enqueue(() => this.#openCore()).catch(
      (error: unknown) => { throw projectNodeRfcPublicError(error); },
    );
    const promise = pending.then(
      (client) => {
        this.#report?.({
          category: "network",
          level: "info",
          code: "network.opened",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "open",
          phase: "connect",
          durationMs: diagnosticDuration(started),
        });
        this.#report?.({
          category: "lifecycle",
          level: "info",
          code: "lifecycle.opened",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "open",
          phase: "connect",
          durationMs: diagnosticDuration(started),
        });
        return client;
      },
      (error: unknown) => {
        this.#report?.({
          category: "network",
          level: "error",
          code: "network.failed",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "failed",
          phase: "connect",
          durationMs: diagnosticDuration(started),
        });
        this.#report?.({
          category: "lifecycle",
          level: "error",
          code: "lifecycle.failed",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "failed",
          phase: "connect",
          durationMs: diagnosticDuration(started),
        });
        throw error;
      },
    );
    return callbackResult(promise, callback);
  }

  connect(callback?: (error: unknown) => void): Promise<Client> | void {
    return this.open(callback);
  }

  ping(callback?: (error: unknown, result?: boolean) => void): Promise<boolean> | void {
    validateOptionalCallback(callback, "ping");
    let admittedBinding: {
      readonly owner: DirectDestinationOwner;
      readonly lease: DirectDestinationApplicationLease;
    };
    try {
      admittedBinding = this.#requiredBinding("ping()");
    } catch (error) {
      const rejected = Promise.reject(error);
      if (callback === undefined) return rejected;
      void rejected.catch((failure: unknown) => callback(failure, false));
      return;
    }
    const promise = this.#enqueue(async () => {
      // A later close marks the client closing synchronously but remains queued
      // behind this admitted ping. An earlier fatal call, by contrast, may have
      // installed a different lease. Follow that replacement instead of using
      // the released admission token.
      const binding =
        this.#owner === admittedBinding.owner &&
          this.#lease === admittedBinding.lease
          ? admittedBinding
          : this.#owner !== undefined && this.#lease !== undefined
            ? Object.freeze({ owner: this.#owner, lease: this.#lease })
            : this.#requiredBinding("ping()");
      const { owner, lease } = binding;
      try {
        await owner.pingApplication(lease);
        return true;
      } catch (error) {
        if (recoverableApplicationFailure(error)) {
          throw projectNodeRfcPublicError(error);
        }
        return this.#replaceFatalLease(owner, lease, error);
      }
    });
    if (callback === undefined) return promise;
    void promise.then(
      (result) => callback(undefined, result),
      (error: unknown) => callback(error, false),
    );
  }

  close(callback?: (error: unknown) => void): Promise<void> | void {
    validateOptionalCallback(callback, "close");
    if (this.#poolId !== 0) {
      return callbackResult(
        Promise.reject(new NodeRfcError("managed clients cannot be closed directly")),
        callback,
      );
    }
    if (this.#closePromise !== undefined) {
      return callbackResult(this.#closePromise, callback);
    }
    if (
      this.#state !== "open" &&
      this.#state !== "faulted" &&
      this.#state !== "opening"
    ) {
      return callbackResult(Promise.reject(closedRequest("close()")), callback);
    }
    this.#state = "closing";
    const correlationId = diagnosticCorrelationId();
    const started = diagnosticNow();
    this.#openingAbort?.abort(canceledRequest());
    for (const controller of this.#activeCalls) controller.abort();
    const closing = this.#enqueue(() => this.#retireDirectOwner());
    const observed = closing.then(
      () => {
        this.#report?.({
          category: "network",
          level: "info",
          code: "network.closed",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "closed",
          phase: "close",
          durationMs: diagnosticDuration(started),
        });
        this.#report?.({
          category: "lifecycle",
          level: "info",
          code: "lifecycle.closed",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "closed",
          phase: "close",
          durationMs: diagnosticDuration(started),
        });
      },
      (error: unknown) => {
        this.#report?.({
          category: "network",
          level: "error",
          code: "network.failed",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "failed",
          phase: "close",
          durationMs: diagnosticDuration(started),
        });
        this.#report?.({
          category: "lifecycle",
          level: "error",
          code: "lifecycle.failed",
          ...(correlationId === undefined ? {} : { correlationId }),
          state: "failed",
          phase: "close",
          durationMs: diagnosticDuration(started),
        });
        throw error;
      },
    );
    const tracked = observed.finally(() => {
      if (this.#closePromise === tracked) this.#closePromise = undefined;
    });
    this.#closePromise = tracked;
    return callbackResult(tracked, callback);
  }

  call(
    functionName: string,
    input: RfcObject,
    options: RfcCallOptions = {},
  ): Promise<RfcObject> {
    try {
      if (typeof functionName !== "string" || functionName.length === 0) {
        throw new TypeError("First argument must be an RFC function name");
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new TypeError("Second argument must be an RFC parameter object");
      }
      const captured = snapshotRfcObject(input);
      validateParameterNames(functionName, captured);
      input = captured;
    } catch (error) {
      return Promise.reject(error);
    }
    let notRequested: ReadonlySet<string>;
    let timeoutMs: number | undefined;
    try {
      notRequested = notRequestedSet(options);
      timeoutMs = validateTimeout(
        options.timeout ?? this.#clientOptions?.timeout,
        "call timeout",
      );
    } catch (error) {
      return Promise.reject(error);
    }
    const correlationId = diagnosticCorrelationId();
    const started = diagnosticNow();
    this.#report?.({
      category: "call",
      level: "info",
      code: "call.started",
      ...(correlationId === undefined ? {} : { correlationId }),
      phase: "send",
    });
    const controller = new AbortController();
    this.#activeCalls.add(controller);
    let timedOut = false;
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
    const pending = this.#enqueue(async () => {
      const { owner, lease } = this.#requiredBinding(`invoke() ${functionName}`);
      try {
        const result = await owner.invoke(
          lease,
          Object.freeze({
            functionName,
            parameters: input,
            notRequested,
            int8Mode: this.#clientOptions?.int8Mode ?? "number",
            bcd: snapshotClassicBcdMode(this.#clientOptions?.bcd),
          }),
          controller.signal,
        );
        if (this.#clientOptions?.stateless === true) {
          try {
            await owner.resetApplication(lease, controller.signal);
          } catch (error) {
            return this.#replaceFatalLease(owner, lease, error);
          }
        }
        return result;
      } catch (error) {
        if (error instanceof ClassicBcdConversionError) {
          const conversionFailure = invocationError(error);
          if (this.#clientOptions?.stateless === true) {
            try {
              await owner.resetApplication(lease, controller.signal);
            } catch (resetFailure) {
              return this.#replaceFatalLease(
                owner,
                lease,
                statelessResetFailure(
                  conversionFailure,
                  resetFailure,
                  "BCD conversion failed and stateless context reset failed",
                ),
              );
            }
          }
          throw conversionFailure;
        }
        if (
          error instanceof DirectDestinationMetadataPreflightError &&
          controller.signal.aborted
        ) {
          throw canceledRequest();
        }
        if (recoverableApplicationFailure(error)) {
          const applicationFailure = invocationError(error);
          if (this.#clientOptions?.stateless === true &&
              statelessContextResetRequired(error)) {
            try {
              await owner.resetApplication(lease, controller.signal);
            } catch (resetFailure) {
              return this.#replaceFatalLease(
                owner,
                lease,
                statelessResetFailure(
                  applicationFailure,
                  resetFailure,
                  "RFC call failed and stateless context reset failed",
                ),
              );
            }
          }
          throw applicationFailure;
        }
        return this.#replaceFatalLease(owner, lease, error);
      }
    });
    const observed = pending.then(
      (result) => {
        this.#report?.({
          category: "call",
          level: "info",
          code: "call.succeeded",
          ...(correlationId === undefined ? {} : { correlationId }),
          phase: "receive",
          durationMs: diagnosticDuration(started),
        });
        return result;
      },
      (error: unknown) => {
        const canceled = controller.signal.aborted;
        this.#report?.({
          category: "call",
          level: timedOut || canceled ? "warn" : "error",
          code: timedOut
            ? "call.timed-out"
            : canceled
              ? "call.canceled"
              : "call.failed",
          ...(correlationId === undefined ? {} : { correlationId }),
          phase: timedOut || canceled ? "cancel" : "receive",
          durationMs: diagnosticDuration(started),
        });
        throw error;
      },
    );
    return observed.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      this.#activeCalls.delete(controller);
    });
  }

  invoke(
    functionName: string,
    input: RfcObject,
    callback: (error: unknown, result?: RfcObject) => void,
    options: RfcCallOptions = {},
  ): void {
    if (typeof callback !== "function") {
      throw new TypeError("Callback function must be supplied");
    }
    void this.call(functionName, input, options).then(
      (result) => callback(undefined, result),
      (error: unknown) => callback(error),
    );
  }

  cancel(callback?: (error: unknown) => void): Promise<void> | void {
    validateOptionalCallback(callback, "cancel");
    const promise = Promise.resolve().then(() => {
      for (const controller of this.#activeCalls) controller.abort();
    });
    return callbackResult(promise, callback);
  }

  resetServerContext(callback?: (error: unknown) => void): Promise<void> | void {
    validateOptionalCallback(callback, "resetServerContext");
    const promise = this.#enqueue(async () => {
      const { owner, lease } = this.#requiredBinding("resetServerContext()");
      try {
        await owner.resetApplication(lease);
      } catch (error) {
        return this.#replaceFatalLease(owner, lease, error);
      }
    });
    return callbackResult(promise, callback);
  }

  release(callback?: (error: unknown) => void): Promise<void> | void {
    validateOptionalCallback(callback, "release");
    const promise = this.#releaseToPool === undefined
      ? Promise.reject(new NodeRfcError("direct clients cannot be released to a pool"))
      : this.#releaseClaimed
        ? Promise.reject(
            new NodeRfcError("Client release() invoked for already closed client"),
          )
        : this.#releaseToPool(this);
    return callbackResult(promise, callback);
  }

  async getFunctionInterface(functionName: string): Promise<RfcFunctionInterface> {
    const controller = new AbortController();
    this.#activeCalls.add(controller);
    try {
      return await this.#enqueue(async () => {
        const { owner } = this.#requiredBinding("getMetadata()");
        try {
          return await owner.getFunctionInterface(functionName, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw canceledRequest();
          throw projectNodeRfcPublicError(error);
        }
      });
    } finally {
      this.#activeCalls.delete(controller);
    }
  }

  async getStructureDefinition(
    structureName: string,
  ): Promise<RfcStructureDefinition> {
    const controller = new AbortController();
    this.#activeCalls.add(controller);
    try {
      return await this.#enqueue(async () => {
        const { owner } = this.#requiredBinding("getMetadata()");
        try {
          return await owner.getStructureDefinition(structureName, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw canceledRequest();
          throw projectNodeRfcPublicError(error);
        }
      });
    } finally {
      this.#activeCalls.delete(controller);
    }
  }

  [pooledClientAttach](attachment: PooledClientAttachment): void {
    if (this.#poolId === 0 || this.#state !== "closed" || this.#releaseClaimed) {
      throw new NodeRfcError("managed client cannot accept an application lease");
    }
    this.#normalized = attachment.connection ??
      planCompatibilityOwnerRoute(this.#connectionParameters).connection;
    this.#installLease(attachment.owner, attachment.lease, attachment.info);
  }

  [pooledClientClaim](abortActive = false): PooledClientClaim {
    if (this.#poolId === 0) {
      throw new NodeRfcError("direct clients have no pool lease");
    }
    if (this.#releaseClaimed || (this.#state !== "open" && this.#state !== "faulted")) {
      throw new NodeRfcError("Client release() invoked for already closed client");
    }
    const owner = this.#owner;
    if (owner === undefined) {
      throw new NodeRfcError("managed client has no destination owner");
    }
    const lease = this.#lease;
    const tail = this.#operationTail;
    this.#releaseClaimed = true;
    this.#state = "closed";
    this.#lease = undefined;
    this.#owner = undefined;
    this.#connectionHandle = 0;
    this.#connectionInfoValue = undefined;
    if (abortActive) {
      for (const controller of this.#activeCalls) controller.abort();
    }
    return Object.freeze({
      owner,
      ...(lease === undefined ? {} : { lease }),
      tail,
      reusableAfterTail: () => this.#leaseReusable,
    });
  }
}

/** Internal deterministic seam used by façade and transaction contract tests. */
export function bindClientDestinationOwnerFactory(
  factory: DirectCompatibilityOwnerFactory,
): () => void {
  const previous = createOwner;
  createOwner = bindDirectCompatibilityOwnerFactory(factory);
  return () => {
    createOwner = previous;
  };
}

export function cancelClient(
  client: Client,
  callback?: (error: unknown) => void,
): Promise<void> | void {
  if (!(client instanceof Client)) throw new TypeError("cancelClient expects a Client");
  return client.cancel(callback);
}
