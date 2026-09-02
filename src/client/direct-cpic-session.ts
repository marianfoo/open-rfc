import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { isIPv4 } from "node:net";

import {
  APPC_FINAL_SAP_PARAMETER_LENGTH,
  AppcNormalDeallocationWithoutDataError,
  AppcPeerReturnCodeError,
  AppcClientSetupStateMachine,
  AppcConversationDecoder,
  AppcFunction,
  DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH,
  DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS,
  decodeAppcExtendedInfo,
  decodeAppcHeader,
  decodeAppcAsyncDataInfo,
  decodeAppcSynchronousSendAcknowledgement,
  encodeAppcControlRecord,
  encodeAppcInitializeParameters,
  encodeOutgoingAppcDataFragment,
  encodeAppcPartnerLogicalUnitParameters,
  planOutgoingAppcDataFragments,
  snapshotOutgoingAppcDataFragment,
  type AppcOutgoingDataFragment,
  type AppcMessage,
} from "../protocol/appc.js";
import {
  GatewayAcceptInfo,
  decodeGatewayNormalClient,
  encodeGatewayNormalClient,
  type GatewayNormalClientRecord,
} from "../protocol/gateway.js";
import {
  DEFAULT_MAX_CPIC_FIELD_COUNT,
  decodeCpicFunctionResultFields,
  decodeCpicInitialLogonResponse,
  decodeCpicResetServerContextResultFields,
  decodeCpicSessionRefreshResultFields,
  encodeCpicCutFunctionRequest,
  encodeCpicFunctionRequest,
  encodeCpicInitialLogonRequest,
  inspectCpicRequestAppcFraming,
  type DecodedCpicFunctionResultFields,
} from "../protocol/cpic.js";
import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";
import {
  DEFAULT_MAX_RFC_CALLBACKS_PER_CALL,
  decodeCpicRfcCallbackRequest,
  encodeCpicRfcCallbackException,
  encodeCpicRfcCallbackResponse,
  frameCpicRfcCallbackResponse,
  isCpicRfcCallbackRequest,
  snapshotRfcCallbackHandlers,
  type RfcCallbackHandler,
  type RfcCallbackHandlers,
} from "../protocol/rfc-callback.js";
import {
  RfcConnectionDisposition,
  RfcCoreError,
  RfcFailureCategory,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcTransmissionState,
  createRemoteRfcFailure,
  createRfcFailure,
} from "./rfc-failure.js";
import {
  buildRfcGetFunctionInterfaceRequest,
  decodeRfcFunctionInterfaceResult,
  type RfcFunctionInterface,
} from "../metadata/rfc-function-interface.js";
import {
  buildDdIfFieldInfoGetRequest,
  decodeDdIfFieldInfoGetResult,
} from "../metadata/ddif-fieldinfo.js";
import { RecursiveMetadataError } from "../metadata/recursive-metadata.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import { createRecursiveMetadataParameterIndex } from
  "../metadata/recursive-parameter-index.js";
import {
  buildRfcGetStructureDefinitionRequest,
  detectRfcStructureDefinitionRowName,
  decodeRfcStructureDefinitionResult,
  type RfcStructureDefinition,
} from "../metadata/rfc-structure-definition.js";
import {
  RFC_METADATA_GET_BOOTSTRAP,
  RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP,
  createRfcMetadataGetFunctionInvocation,
  createRfcMetadataGetStructureInvocation,
  createRfcMetadataGetTimestampInvocation,
  normalizeRfcMetadataGetFunctionResult,
  normalizeRfcMetadataGetRecursiveFunctionResult,
  normalizeRfcMetadataGetStructureResult,
  normalizeRfcMetadataGetTimestamps,
  type RfcMetadataGetFunctionResult,
  type RfcMetadataGetRecursiveFunctionResult,
  type RfcMetadataGetStructureResult,
  type RfcMetadataTimestampBatch,
} from "../metadata/rfc-metadata-get.js";
import {
  buildClassicRfcInvocationRequest,
  captureClassicRfcInvocation,
  classicInvocationRecursiveMetadataParameters,
  classifyClassicInvocationMetadataNeeds,
  decodeOwnedClassicRfcInvocationResult,
  type CapturedClassicRfcInvocation,
  type ClassicRfcInvocationOptions,
  type ClassicRfcInput,
  type ClassicRfcOutput,
  type RfcStructureRepository,
} from "./classic-invocation.js";
import { snapshotRfcValue } from "../values/rfc-value-snapshot.js";
import { snapshotClassicInt8Mode } from "../values/classic-int8.js";
import {
  ClassicBcdConversionError,
  snapshotClassicBcdMode,
} from "../values/classic-bcd.js";
import { resolveRecursiveXrfcParameterFromIndex } from
  "../values/recursive-xrfc.js";
import {
  RecursiveSerializerClassificationError,
  assertRecursiveSerializerSendDecision,
  type RecursiveSerializerDecisionProvider,
} from "../values/recursive-serializer-classification.js";
import {
  NiSocketTransport,
  NiTransportError,
  type NiSocketConnectOptions,
} from "../transport/ni-socket.js";

/** Internal connection seam used by direct TCP and already-routed streams. */
export type DirectCpicTransportFactory = (
  options: NiSocketConnectOptions,
  signal?: AbortSignal,
) => NiSocketTransport | PromiseLike<NiSocketTransport>;

export interface DirectCpicSessionOptions {
  /** TCP host of the SAP gateway (normally the application server itself). */
  readonly host: string;
  readonly port: number;
  /** Application server name carried in CPIC when the gateway host differs. */
  readonly applicationServerHost?: string;
  readonly applicationServerService: string;
  readonly programName?: string;
  /**
   * IPv4 address advertised inside CPIC setup. Loopback is the interoperable
   * default for an outbound client behind NAT; routed callback deployments may
   * override it with an address reachable from the SAP gateway.
   */
  readonly localAddress?: string;
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Connect one fresh physical NI stream. Pool owners use this to route each
   * application and repository session independently through SAProuter.
   */
  readonly transportFactory?: DirectCpicTransportFactory;
  /** Explicit opt-in for targets whose CPIC streaming path was approved. */
  readonly cpicStreaming?: "disabled" | "enabled";
  /**
   * Paired, release-specific observation required for a recursive live send.
   * Flat/classic calls do not require this policy.
   */
  readonly recursiveSerializerDecisionProvider?: RecursiveSerializerDecisionProvider;
  /** Raw synchronous handlers for server-initiated DESTINATION 'BACK' calls. */
  readonly callbacks?: RfcCallbackHandlers;
}

/**
 * Proven local invocation-preparation failure. No application request byte was
 * handed to the CPIC exchange, so the authenticated generation remains safe.
 */
export class DirectCpicPreWireError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "classic RFC invocation preparation failed",
      { cause },
    );
    this.name = "DirectCpicPreWireError";
    this.cause = cause;
  }
}

export interface DirectCpicSessionInfo {
  readonly localAddress: string;
  readonly peerCodePage: string;
  readonly peerAcceptInfo: number;
  /** Process-local identity of this physical session generation. */
  readonly generationHandle: number;
  /** SAP gateway connection-table index; the peer may recycle this value. */
  readonly connectionIndex: number;
  /** Present for a logical route which selected a physical target at open. */
  readonly selectedApplicationServerHost?: string;
  /** Present for a logical route whose physical gateway differs per session. */
  readonly selectedGatewayHost?: string;
  /** Present for a logical route whose SAP instance is selected dynamically. */
  readonly selectedSystemNumber?: string;
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

function allowsOptionalRecursiveMetadataFallback(error: unknown): boolean {
  return error instanceof RecursiveMetadataError &&
      error.code === "REMOTE_DDIC_RESOLUTION_ERRORS" ||
    error instanceof RfcCoreError &&
    error.failure.disposition === RfcConnectionDisposition.Reusable &&
    (
      (
        error.failure.category === RfcFailureCategory.AbapException &&
        OPTIMIZED_METADATA_UNAVAILABLE_KEYS.has(error.failure.key)
      ) ||
      OPTIMIZED_METADATA_AUTHORIZATION_KEYS.has(error.failure.key) ||
      OPTIMIZED_METADATA_AUTHORIZATION_KEYS.has(error.failure.abap.runtimeId)
    );
}

let nextSessionGenerationHandle = 1;
const directCpicSessionLanguages = new WeakMap<object, string>();

function allocateSessionGenerationHandle(): number {
  if (nextSessionGenerationHandle > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("direct CPIC session generation space is exhausted");
  }
  return nextSessionGenerationHandle++;
}

interface DirectCpicLogonOptionsBase {
  readonly client: string;
  readonly user: string;
  readonly language?: string;
  readonly partnerHostName?: string;
  readonly kernelRelease?: string;
}

export type DirectCpicLogonOptions = DirectCpicLogonOptionsBase & (
  | {
    readonly password: string;
    readonly ticket?: never;
  }
  | {
    readonly ticket: string;
    readonly password?: never;
  }
);

export interface DirectCpicLogonResult {
  readonly negotiatedProtocolVersion: number;
  readonly responseFieldCount: number;
}

export interface DirectCpicPingResult {
  readonly responseFieldCount: number;
}

export class CpicLogonError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`SAP rejected the initial CPIC logon with status ${status}`);
    this.name = "CpicLogonError";
    this.status = status;
  }
}

export class CpicCallError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`SAP rejected the CPIC RFC call with status ${status}`);
    this.name = "CpicCallError";
    this.status = status;
  }
}

function classicMaximumApplicationDataLength(
  options: ClassicRfcInvocationOptions,
): number {
  const requestedMaximum =
    options.maxApplicationDataLength ??
    DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH;
  if (
    typeof requestedMaximum !== "number" ||
    !Number.isSafeInteger(requestedMaximum) ||
    requestedMaximum < 0 ||
    requestedMaximum > 0x7fff_ffff
  ) {
    throw new RangeError(
      "maxApplicationDataLength must be an integer in 0..2147483647",
    );
  }
  return Math.min(
    requestedMaximum,
    DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH,
  );
}

interface DirectClassicCallerSnapshot {
  readonly input: ClassicRfcInput;
  readonly options: ClassicRfcInvocationOptions;
}

function snapshotDirectClassicNameSet(
  value: ReadonlySet<string> | undefined,
  label: "notRequested" | "activated" | "deactivated",
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`${label} must be an iterable set of parameter names`);
  }
  const iterator = value[Symbol.iterator];
  if (typeof iterator !== "function") {
    throw new TypeError(`${label} must be an iterable set of parameter names`);
  }
  const source = value;
  const result = new Set<string>();
  let entryCount = 0;
  for (const name of {
    [Symbol.iterator]() {
      return Reflect.apply(iterator, source, []) as SetIterator<string>;
    },
  }) {
    if (entryCount >= DEFAULT_MAX_CPIC_FIELD_COUNT) {
      throw new RangeError(
        `${label} entry count exceeds ${DEFAULT_MAX_CPIC_FIELD_COUNT}`,
      );
    }
    entryCount += 1;
    result.add(name);
  }
  return result;
}

function snapshotDirectClassicInput(input: ClassicRfcInput): ClassicRfcInput {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("classic RFC input must be an object");
  }
  const names = Object.keys(input);
  if (names.length > DEFAULT_MAX_CPIC_FIELD_COUNT) {
    throw new RangeError(
      `input parameter count exceeds ${DEFAULT_MAX_CPIC_FIELD_COUNT}`,
    );
  }
  const values = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    Object.defineProperty(values, name, {
      value: input[name],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return snapshotRfcValue(values, "RFC input") as ClassicRfcInput;
}

function snapshotDirectClassicCaller(
  input: ClassicRfcInput,
  options: ClassicRfcInvocationOptions,
): DirectClassicCallerSnapshot {
  const maximumApplicationDataLength =
    classicMaximumApplicationDataLength(options);
  const notRequested = snapshotDirectClassicNameSet(
    options.notRequested,
    "notRequested",
  );
  const activated = snapshotDirectClassicNameSet(
    options.activated,
    "activated",
  );
  const deactivated = snapshotDirectClassicNameSet(
    options.deactivated,
    "deactivated",
  );
  const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
  const bcd = snapshotClassicBcdMode(options.bcd);
  return Object.freeze({
    input: snapshotDirectClassicInput(input),
    options: Object.freeze({
      ...(notRequested === undefined ? {} : { notRequested }),
      ...(activated === undefined ? {} : { activated }),
      ...(deactivated === undefined ? {} : { deactivated }),
      maxApplicationDataLength: maximumApplicationDataLength,
      int8Mode,
      bcd,
    }),
  });
}

/** Minimal write/close seam used by the bounded outgoing APPC writer. */
export interface DirectCpicOutgoingTransport {
  send(payload: Uint8Array, signal?: AbortSignal): Promise<void>;
  receive?(options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Identifies a send failure after the caller-controlled message was fully
 * preflighted. The original transport error remains available as `cause`.
 */
export class DirectCpicOutgoingWriteError extends Error {
  readonly transmission: RfcTransmissionState.Partial | RfcTransmissionState.Unknown;
  override readonly cause: unknown;

  constructor(
    transmission: RfcTransmissionState.Partial | RfcTransmissionState.Unknown,
    cause: unknown,
  ) {
    super("outgoing APPC message write failed", { cause });
    this.name = "DirectCpicOutgoingWriteError";
    this.transmission = transmission;
    this.cause = cause;
  }
}

/** Enforce response identity without correlating the independently sequenced reply. */
export function assertDirectCpicResponseIdentity(
  message: AppcMessage,
  conversationId: Uint8Array,
  connectionIndex: number,
): void {
  const expectedConversationId = Buffer.from(conversationId);
  if (
    expectedConversationId.byteLength !== 8 ||
    !message.conversationId.equals(expectedConversationId) ||
    message.communicationIndex !== 0 ||
    message.connectionIndex !== connectionIndex
  ) {
    throw new Error("APPC response identity does not match the active conversation");
  }
}

function validateOutgoingPlanOrder(
  fragments: readonly AppcOutgoingDataFragment[],
): void {
  if (fragments.length < 1) {
    throw new RangeError("outgoing APPC plan must contain at least one fragment");
  }
  if (fragments.length > DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS) {
    throw new RangeError(
      `outgoing APPC plan fragment count ${fragments.length} exceeds ` +
        `limit ${DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS}`,
    );
  }
  const first = fragments[0]!;
  let applicationDataLength = 0;
  for (const [index, fragment] of fragments.entries()) {
    if (
      fragment.fragmentIndex !== index ||
      fragment.fragmentCount !== fragments.length
    ) {
      throw new RangeError("outgoing APPC plan fragment order is inconsistent");
    }
    if (
      fragment.sequenceNumber !== first.sequenceNumber ||
      fragment.communicationIndex !== first.communicationIndex ||
      fragment.connectionIndex !== first.connectionIndex ||
      fragment.messageApplicationDataLength !==
        first.messageApplicationDataLength ||
      !fragment.conversationId.equals(first.conversationId)
    ) {
      throw new RangeError("outgoing APPC plan identity changed between fragments");
    }
    applicationDataLength += fragment.applicationData.byteLength;
    if (!Number.isSafeInteger(applicationDataLength)) {
      throw new RangeError("outgoing APPC plan application length is unsafe");
    }
  }
  if (applicationDataLength !== first.messageApplicationDataLength) {
    throw new RangeError(
      "outgoing APPC plan application length is inconsistent",
    );
  }
}

/**
 * Pre-encodes the complete bounded plan, then writes one NI payload at a time.
 * A transport failure is terminal and is never retried or replayed.
 *
 * This low-level helper is exported from its module for deterministic fault
 * tests but is intentionally not part of the package root API.
 */
export async function writeOutgoingAppcDataPlan(
  transport: DirectCpicOutgoingTransport,
  setup: AppcClientSetupStateMachine,
  fragments: readonly AppcOutgoingDataFragment[],
  signal?: AbortSignal,
  barrierTimeoutMs = 30_000,
): Promise<void> {
  const fragmentCount = fragments.length;
  if (!Number.isSafeInteger(fragmentCount)) {
    throw new RangeError("outgoing APPC plan fragment count is unsafe");
  }
  if (fragmentCount < 1) {
    throw new RangeError("outgoing APPC plan must contain at least one fragment");
  }
  if (fragmentCount > DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS) {
    throw new RangeError(
      `outgoing APPC plan fragment count ${fragmentCount} exceeds ` +
        `limit ${DEFAULT_MAX_APPC_MESSAGE_FRAGMENTS}`,
    );
  }
  const snapshot: AppcOutgoingDataFragment[] = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    snapshot.push(snapshotOutgoingAppcDataFragment(fragments[index]!));
  }
  validateOutgoingPlanOrder(snapshot);
  if (
    !Number.isSafeInteger(barrierTimeoutMs) ||
    barrierTimeoutMs < 0 ||
    barrierTimeoutMs > 0x7fff_ffff
  ) {
    throw new RangeError("barrierTimeoutMs must be an integer in 0..2147483647");
  }
  const sendMethod = transport.send;
  const receiveMethod = transport.receive;
  const closeMethod = transport.close;
  if (typeof sendMethod !== "function" || typeof closeMethod !== "function") {
    throw new TypeError("outgoing APPC transport needs send and close methods");
  }
  const prepared = snapshot.map((fragment) => {
    const record = encodeOutgoingAppcDataFragment(fragment);
    const header = decodeAppcHeader(record);
    const barrier = header.functionCode === AppcFunction.SendData
      ? decodeAppcAsyncDataInfo(record.subarray(48, 80))
      : undefined;
    return Object.freeze({
      record,
      functionCode: header.functionCode as AppcFunction,
      isFinal:
        header.functionCode === AppcFunction.SapSend ||
        header.functionCode === AppcFunction.Receive,
      conversationId: Buffer.from(header.conversationId),
      barrierConnectionIndex: barrier?.connectionIndex,
    });
  });
  if (
    prepared.some(({ functionCode }) => functionCode === AppcFunction.SendData) &&
    typeof receiveMethod !== "function"
  ) {
    throw new TypeError(
      "outgoing APPC transport needs receive for synchronous streaming barriers",
    );
  }
  if (setup.state !== "ready") {
    throw new Error(`cannot start an outgoing APPC message while client is ${setup.state}`);
  }

  for (const [index, step] of prepared.entries()) {
    try {
      setup.sent(step.functionCode, step.isFinal);
      await Reflect.apply(sendMethod, transport, [step.record, signal]);
      if (step.functionCode === AppcFunction.SendData) {
        const acknowledgement = await Reflect.apply(receiveMethod!, transport, [
          { timeoutMs: barrierTimeoutMs, signal },
        ]);
        const decoded = decodeAppcSynchronousSendAcknowledgement(
          acknowledgement,
        );
        if (
          !decoded.header.conversationId.equals(step.conversationId) ||
          decoded.connectionIndex !== step.barrierConnectionIndex
        ) {
          throw new Error(
            "APPC synchronous-send acknowledgement identity changed",
          );
        }
        setup.received(acknowledgement);
      }
    } catch (cause) {
      try {
        await Reflect.apply(closeMethod, transport, []);
      } catch {
        // The original transmission failure remains authoritative.
      }
      throw new DirectCpicOutgoingWriteError(
        index === 0
          ? RfcTransmissionState.Unknown
          : RfcTransmissionState.Partial,
        cause,
      );
    }
  }
}

function sessionId(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

function short(value: string, length: number): string {
  return value.slice(0, length);
}

function gatewayIpv4(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  if (isIPv4(address)) return address;
  const mappedPrefix = "::ffff:";
  if (address.toLowerCase().startsWith(mappedPrefix)) {
    const mapped = address.slice(mappedPrefix.length);
    if (isIPv4(mapped)) return mapped;
  }
  return undefined;
}

function validateSessionOptions(options: DirectCpicSessionOptions): void {
  if (!/^sapdp\d{2}$/.test(options.applicationServerService)) {
    throw new RangeError(
      "applicationServerService must use the direct application-server form sapdpNN",
    );
  }
  if (options.operationTimeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(options.operationTimeoutMs) ||
      options.operationTimeoutMs < 0 ||
      options.operationTimeoutMs > 0x7fff_ffff
    ) {
      throw new RangeError("operationTimeoutMs must be an integer in 0..2147483647");
    }
  }
  if (
    options.recursiveSerializerDecisionProvider !== undefined &&
    typeof options.recursiveSerializerDecisionProvider !== "function"
  ) {
    throw new TypeError(
      "recursiveSerializerDecisionProvider must be a function",
    );
  }
  const applicationServerHost = options.applicationServerHost ?? options.host;
  if (!/^[\x20-\x7e]{1,64}$/u.test(applicationServerHost)) {
    throw new RangeError(
      "applicationServerHost must contain 1..64 ASCII bytes",
    );
  }
}

function snapshotSessionOptions(
  options: DirectCpicSessionOptions,
): DirectCpicSessionOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("direct CPIC session options must be an object");
  }
  // Capture every caller-owned property before validation or I/O. Setup spans
  // several awaits; rereading a mutable/accessor-backed option later could mix
  // endpoint, timeout, signal, and CPIC identity from different generations.
  const snapshot = Object.freeze({
    host: options.host,
    port: options.port,
    applicationServerHost: options.applicationServerHost,
    applicationServerService: options.applicationServerService,
    programName: options.programName,
    localAddress: options.localAddress,
    connectTimeoutMs: options.connectTimeoutMs,
    operationTimeoutMs: options.operationTimeoutMs,
    signal: options.signal,
    transportFactory: options.transportFactory,
    cpicStreaming: options.cpicStreaming,
    recursiveSerializerDecisionProvider:
      options.recursiveSerializerDecisionProvider,
    callbacks: options.callbacks,
  });
  validateSessionOptions(snapshot);
  return snapshot;
}

/** A single allocated, direct-CPIC conversation over an NI TCP transport. */
export class DirectCpicSession {
  readonly #transport: NiSocketTransport;
  readonly #setup = new AppcClientSetupStateMachine();
  readonly #operationTimeoutMs: number;
  readonly #localAddress: string;
  readonly #destination: string;
  readonly #programName: string;
  readonly #cpicStreaming: "disabled" | "enabled";
  readonly #recursiveSerializerDecisionProvider:
    RecursiveSerializerDecisionProvider | undefined;
  readonly #callbacks: ReadonlyMap<string, RfcCallbackHandler> | undefined;
  #conversationId: Buffer;
  #connectionIndex: number;
  #busy = false;
  #compoundOperationOwner: symbol | undefined;
  #closed = false;
  #authenticated = false;
  #cpicSessionId: Buffer | undefined;
  readonly #metadata = new Map<string, RfcFunctionInterface>();
  readonly #structures = new Map<string, RfcStructureDefinition>();
  readonly info: DirectCpicSessionInfo;

  private constructor(
    transport: NiSocketTransport,
    gateway: GatewayNormalClientRecord,
    localAddress: string,
    operationTimeoutMs: number,
    conversationId: Buffer,
    connectionIndex: number,
    setup: AppcClientSetupStateMachine,
    destination: string,
    programName: string,
    cpicStreaming: "disabled" | "enabled",
    recursiveSerializerDecisionProvider:
      RecursiveSerializerDecisionProvider | undefined,
    callbacks: ReadonlyMap<string, RfcCallbackHandler> | undefined,
  ) {
    this.#transport = transport;
    this.#localAddress = localAddress;
    this.#operationTimeoutMs = operationTimeoutMs;
    this.#conversationId = Buffer.from(conversationId);
    this.#connectionIndex = connectionIndex;
    this.#setup = setup;
    this.#destination = destination;
    this.#programName = programName;
    this.#cpicStreaming = cpicStreaming;
    this.#recursiveSerializerDecisionProvider =
      recursiveSerializerDecisionProvider;
    this.#callbacks = callbacks;
    this.info = Object.freeze({
      localAddress,
      peerCodePage: gateway.codePage,
      peerAcceptInfo: gateway.acceptInfo,
      generationHandle: allocateSessionGenerationHandle(),
      connectionIndex,
    });
  }

  static async open(options: DirectCpicSessionOptions): Promise<DirectCpicSession> {
    const sessionOptions = snapshotSessionOptions(options);
    const callbacks = snapshotRfcCallbackHandlers(
      sessionOptions.callbacks,
      "direct CPIC session callbacks",
    );
    const cpicStreaming = sessionOptions.cpicStreaming ?? "disabled";
    if (cpicStreaming !== "disabled" && cpicStreaming !== "enabled") {
      throw new RangeError("cpicStreaming must be disabled or enabled");
    }
    const programName = sessionOptions.programName ?? "open-rfc";
    if (!/^[\x20-\x7e]{1,64}$/.test(programName)) {
      throw new RangeError("programName must contain 1..64 ASCII bytes");
    }
    const transportOptions: NiSocketConnectOptions = {
      host: sessionOptions.host,
      port: sessionOptions.port,
      connectTimeoutMs: sessionOptions.connectTimeoutMs,
      writeTimeoutMs: sessionOptions.operationTimeoutMs,
      family: 4,
    };
    const transportFactory = sessionOptions.transportFactory === undefined
      ? (connectOptions: NiSocketConnectOptions, signal?: AbortSignal) =>
          NiSocketTransport.connect(connectOptions, signal)
      : sessionOptions.transportFactory;
    if (typeof transportFactory !== "function") {
      throw new TypeError("transportFactory must be a function");
    }
    const transport = await Reflect.apply(transportFactory, undefined, [
      transportOptions,
      sessionOptions.signal,
    ]) as NiSocketTransport;
    if (!(transport instanceof NiSocketTransport)) {
      throw new TypeError(
        "transportFactory must return a NiSocketTransport",
      );
    }
    try {
      const localAddress = gatewayIpv4(
        sessionOptions.localAddress ?? "127.0.0.1",
      );
      if (localAddress === undefined) {
        throw new Error(
          "direct CPIC gateway version 2 needs an IPv4 localAddress override",
        );
      }
      const operationTimeoutMs = sessionOptions.operationTimeoutMs ?? 30_000;
      const destination =
        sessionOptions.applicationServerHost ?? sessionOptions.host;
      const receive = () =>
        transport.receive({
          timeoutMs: operationTimeoutMs,
          signal: sessionOptions.signal,
        });

      await transport.send(
        encodeGatewayNormalClient({
          address: localAddress,
          service: short(programName, 9),
          codePage: "1100",
          gatewayOptionLevel: 6,
          logicalUnit: short(hostname(), 8),
          transactionProgram: short(programName, 8),
          conversationId: "",
          appcHeaderVersion: 6,
          acceptInfo:
            GatewayAcceptInfo.ErrorInfo |
            GatewayAcceptInfo.Ping |
            GatewayAcceptInfo.ConnectionExtendedInfo |
            GatewayAcceptInfo.CodePage |
            GatewayAcceptInfo.ExtendedInitOptions |
            GatewayAcceptInfo.DistributedTrace,
          index: -1,
          returnCode: 0,
          echoData: 0,
        }),
        sessionOptions.signal,
      );
      const gateway = decodeGatewayNormalClient(await receive());
      if (gateway.returnCode !== 0) {
        throw new Error(`gateway rejected GW_NORMAL_CLIENT with return code ${gateway.returnCode}`);
      }
      if (gateway.appcHeaderVersion !== 6) {
        throw new Error(
          `gateway selected unsupported APPC header version ${gateway.appcHeaderVersion}`,
        );
      }
      if ((gateway.acceptInfo & GatewayAcceptInfo.ExtendedInitOptions) === 0) {
        throw new Error("gateway did not accept extended initialization options");
      }
      if (
        (gateway.acceptInfo & GatewayAcceptInfo.CodePage) === 0 ||
        gateway.codePage !== "4103"
      ) {
        throw new Error(
          "direct classic RFC supports only little-endian Unicode partner code page 4103 (M12)",
        );
      }

      const setup = new AppcClientSetupStateMachine();
      const initialConversationId = Buffer.alloc(8, 0x20);
      const initialize = encodeAppcControlRecord({
        functionCode: AppcFunction.Initialize,
        conversationId: initialConversationId,
        info2: 1,
        info3: 0xc0,
        info4: 4,
        info: 5,
        extendedInfo: {
          shortDestinationName: "NWRFC",
          logicalUnitName: short(localAddress, 8),
          transactionProgramName: sessionOptions.applicationServerService,
          connectionType: 0x49,
          clientInfo: 1,
          communicationIndex: 0,
          connectionIndex: 0xffff,
        },
        parameters: encodeAppcInitializeParameters({
          clientIdentifier: "NWRFC",
          options: {
            // The APPC setup contract always carries this initialization flag.
            // Streaming stays a caller-supplied local policy because no
            // peer-negotiation bit for it is known.
            optionFlags: 1,
            rootId: sessionId(),
            connectionId: sessionId(),
            connectionIdSuffix: 1,
            timeout: -2,
            keepaliveTimeout: -2,
            exportTrace: 2,
            startType: 0,
            networkProtocol: 0,
            localAddressV6: Buffer.alloc(16),
            longLogicalUnitName: localAddress,
            operatingSystemUser: short(userInfo().username, 12),
            localAddressV4: Buffer.alloc(4),
            longTransactionProgramName: sessionOptions.applicationServerService,
          },
        }),
      });
      setup.sent(AppcFunction.Initialize);
      await transport.send(initialize, sessionOptions.signal);
      const initializeReply = await receive();
      setup.received(initializeReply);
      const initializeHeader = decodeAppcHeader(initializeReply);
      const initializeInfo = decodeAppcExtendedInfo(
        initializeReply.subarray(48, 80),
      );
      const conversationId = initializeHeader.conversationId;
      const connectionIndex = initializeInfo.connectionIndex;

      setup.sent(AppcFunction.SetPartnerLuName);
      await transport.send(
        encodeAppcControlRecord({
          functionCode: AppcFunction.SetPartnerLuName,
          conversationId,
          info2: 1,
          info: 4,
          partnerLogicalUnitInfo: {
            logicalUnitName: localAddress,
            partnerHostAddress: Buffer.alloc(16),
            communicationIndex: 0xffff,
            connectionIndex,
          },
          parameters: encodeAppcPartnerLogicalUnitParameters({
            longLogicalUnitName: localAddress,
            partnerHostAddress: Buffer.alloc(16),
          }),
        }),
        sessionOptions.signal,
      );

      setup.sent(AppcFunction.Allocate);
      await transport.send(
        encodeAppcControlRecord({
          functionCode: AppcFunction.Allocate,
          conversationId,
          info: 1,
          extendedInfo: {
            shortDestinationName: "",
            logicalUnitName: "",
            transactionProgramName: "",
            connectionType: 0,
            clientInfo: 0,
            communicationIndex: 0xffff,
            connectionIndex,
          },
        }),
        sessionOptions.signal,
      );
      setup.received(await receive());

      return new DirectCpicSession(
        transport,
        gateway,
        localAddress,
        operationTimeoutMs,
        conversationId,
        connectionIndex,
        setup,
        destination,
        programName,
        cpicStreaming,
        sessionOptions.recursiveSerializerDecisionProvider,
        callbacks,
      );
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  #admitRecursiveSerializerSend(
    metadata: RfcFunctionInterface,
    graph: RecursiveMetadataGraph,
    parameters: ReturnType<
      typeof classicInvocationRecursiveMetadataParameters
    >,
  ): void {
    if (parameters.length === 0) return;
    const provider = this.#recursiveSerializerDecisionProvider;
    if (provider === undefined) {
      throw new RecursiveSerializerClassificationError(
        "live-decision-required",
      );
    }
    const identities = Object.freeze(parameters.map((parameter) => {
        if (!/^[IECT]$/u.test(parameter.parameterClass)) {
          throw new Error(
            `${parameter.parameterName} has unsupported recursive parameter class ${parameter.parameterClass}`,
          );
        }
        return Object.freeze({
          functionName: metadata.name,
          parameterName: parameter.parameterName,
          parameterClass: parameter.parameterClass as "I" | "E" | "C" | "T",
          associatedType: parameter.tableName,
          internalType: parameter.exid,
        });
      }));
    const request = Object.freeze({ graph, parameters: identities });
    const decision = Reflect.apply(provider, undefined, [request]);
    assertRecursiveSerializerSendDecision(
      request,
      decision,
    );
  }

  get state(): "allocated" | "authenticated" | "closed" {
    if (this.#closed || this.#setup.state === "closed") return "closed";
    return this.#authenticated ? "authenticated" : "allocated";
  }

  async logonAndPing(
    options: DirectCpicLogonOptions,
    signal?: AbortSignal,
  ): Promise<DirectCpicLogonResult> {
    if (this.#authenticated) {
      throw new Error("direct CPIC session is already authenticated");
    }
    const cpicSessionId = randomBytes(16);
    const language = options.language ?? "E";
    try {
      const response = await this.exchange(
        encodeCpicInitialLogonRequest({
          client: options.client,
          user: options.user,
          ...(options.ticket === undefined
            ? { password: options.password }
            : { ticket: options.ticket }),
          language,
          clientAddress: this.#localAddress,
          partnerHostName: options.partnerHostName ?? hostname(),
          destination: this.#destination,
          programName: this.#programName,
          kernelRelease: options.kernelRelease,
          functionName: "RFCPING",
          sessionId: cpicSessionId,
        }),
        signal,
      );
      let decoded: ReturnType<typeof decodeCpicInitialLogonResponse>;
      try {
        decoded = decodeCpicInitialLogonResponse(response);
      } catch (cause) {
        const failure = createRfcFailure({
          category: RfcFailureCategory.MalformedProtocol,
          origin: RfcFailureOrigin.Cpic,
          phase: RfcOperationPhase.Logon,
          transmission: RfcTransmissionState.Complete,
          establishedSession: false,
          reasonCode: "RFC_CPIC_LOGON_RESPONSE_MALFORMED",
          key: "RFC_INVALID_PROTOCOL",
          message: "CPIC RFC logon response is malformed",
          cause,
        });
        await this.#terminateGeneration();
        throw new RfcCoreError(failure);
      }
      if (!decoded.success) {
        const reasonCode = decoded.status === undefined
          ? "RFC_CPIC_LOGON_REJECTED"
          : `RFC_CPIC_LOGON_STATUS_${decoded.status}`;
        // The backend explains itself; decoding that and then dropping it is
        // what made every rejection look alike to a caller.
        const message = decoded.rejection !== undefined &&
            decoded.rejection.text.length > 0
          ? decoded.rejection.text
          : decoded.status === undefined
          ? "SAP rejected the initial CPIC logon"
          : `SAP rejected the initial CPIC logon with status ${decoded.status}`;
        const failure = createRfcFailure({
          category: RfcFailureCategory.Logon,
          origin: RfcFailureOrigin.Sap,
          phase: RfcOperationPhase.Logon,
          transmission: RfcTransmissionState.Complete,
          establishedSession: false,
          reasonCode,
          key: "RFC_LOGON_FAILURE",
          message,
        });
        await this.#terminateGeneration();
        throw new RfcCoreError(failure);
      }
      this.#cpicSessionId = Buffer.from(cpicSessionId);
      this.#authenticated = true;
      directCpicSessionLanguages.set(this, language);
      return Object.freeze({
        negotiatedProtocolVersion: decoded.negotiatedProtocolVersion,
        responseFieldCount: decoded.fields.length,
      });
    } finally {
      cpicSessionId.fill(0);
    }
  }

  async ping(signal?: AbortSignal): Promise<DirectCpicPingResult> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error("direct CPIC session must be authenticated before ping");
    }
    const response = await this.exchange(
      encodeCpicFunctionRequest({
        functionName: "RFC_PING",
        sessionId: this.#cpicSessionId,
      }),
      signal,
    );
    const decoded = await this.#decodeRegularResponse(response);
    return Object.freeze({ responseFieldCount: decoded.fields.length });
  }

  /** Reset backend function-pool state while preserving the synchronized session. */
  async resetServerContext(signal?: AbortSignal): Promise<void> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before server-context reset",
      );
    }
    this.#assertExchangeAvailable();
    const owner = Symbol("reset-server-context");
    this.#compoundOperationOwner = owner;
    try {
      const response = await this.#exchange(
        encodeCpicCutFunctionRequest({
          functionName: "SYSTEM_RESET_RFC_SERVER",
        }),
        signal,
        owner,
      );
      await this.#decodeRegularResponse(response, "reset");
      // Reset clears SAP's RFC session-header state. Re-establish it immediately
      // with the independently observed full RFC_PING form so callers and pools
      // only regain a connection after the refreshed envelope is validated.
      const refresh = await this.#exchange(
        encodeCpicFunctionRequest({
          functionName: "RFC_PING",
          sessionId: this.#cpicSessionId,
        }),
        signal,
        owner,
      );
      await this.#decodeRegularResponse(refresh, "sessionRefresh");
    } finally {
      if (this.#compoundOperationOwner === owner) {
        this.#compoundOperationOwner = undefined;
      }
    }
  }

  async getFunctionInterface(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before metadata lookup",
      );
    }
    const cached = this.#metadata.get(functionName);
    if (cached !== undefined) return cached;
    const response = await this.exchange(
      buildRfcGetFunctionInterfaceRequest(functionName),
      signal,
    );
    const decoded = await this.#decodeRegularResponse(response);
    const metadata = await this.#decodeApplicationResult(() =>
      decodeRfcFunctionInterfaceResult(functionName, decoded.fields));
    this.#metadata.set(functionName, metadata);
    return metadata;
  }

  /**
   * Load one function descriptor through SAP Note 1456826's bounded classic
   * RFC_METADATA_GET form. The destination repository owns cross-session
   * caching and capability fallback; this session method performs one call.
   */
  async getOptimizedFunctionInterface(
    functionName: string,
    language = "E",
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface> {
    return (await this.getOptimizedFunctionDescriptor(
      functionName,
      language,
      signal,
    )).value;
  }

  /**
   * Load a function descriptor and its generation from one RFC_METADATA_GET
   * response. Destination-owned caches use this detailed form; the existing
   * descriptor-only API above remains source compatible.
   */
  async getOptimizedFunctionDescriptor(
    functionName: string,
    language = "E",
    signal?: AbortSignal,
  ): Promise<RfcMetadataGetFunctionResult> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before optimized metadata lookup",
      );
    }
    const invocation = createRfcMetadataGetFunctionInvocation(
      functionName,
      language,
    );
    const output = await this.invokeClassicWithMetadata(
      RFC_METADATA_GET_BOOTSTRAP.metadata,
      invocation.input,
      RFC_METADATA_GET_BOOTSTRAP.structures,
      signal,
    );
    return normalizeRfcMetadataGetFunctionResult(functionName, output);
  }

  /**
   * Load a function's complete DEEP type closure and generation through one
   * RFC_METADATA_GET exchange. Cross-session caching remains destination-owned.
   */
  async getOptimizedRecursiveFunctionDescriptor(
    functionName: string,
    language = "E",
    signal?: AbortSignal,
  ): Promise<RfcMetadataGetRecursiveFunctionResult> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before recursive metadata lookup",
      );
    }
    const invocation = createRfcMetadataGetFunctionInvocation(
      functionName,
      language,
    );
    const output = await this.invokeClassicWithMetadata(
      RFC_METADATA_GET_BOOTSTRAP.metadata,
      invocation.input,
      RFC_METADATA_GET_BOOTSTRAP.structures,
      signal,
    );
    return normalizeRfcMetadataGetRecursiveFunctionResult(functionName, output);
  }

  async invokeClassic(
    functionName: string,
    input: ClassicRfcInput,
    signal?: AbortSignal,
    options: ClassicRfcInvocationOptions = {},
  ): Promise<ClassicRfcOutput> {
    const caller = snapshotDirectClassicCaller(input, options);
    const metadata = await this.getFunctionInterface(functionName, signal);
    const invocation = captureClassicRfcInvocation(
      metadata,
      caller.input,
      caller.options,
    );
    const structures = new Map<string, RfcStructureDefinition>();
    const recursiveParameters = classicInvocationRecursiveMetadataParameters(
      metadata,
      invocation.input,
      invocation.options,
    );
    const metadataNeeds = classifyClassicInvocationMetadataNeeds(
      metadata,
      invocation.input,
      invocation.options,
    );
    const recursiveContainerParameters = metadata.parameters.filter(
      (parameter) =>
        parameter.exid === "u" &&
        metadataNeeds.containerParameters.has(parameter.parameterName),
    );
    let recursiveMetadata: RecursiveMetadataGraph | undefined;
    if (
      recursiveParameters.length > 0 ||
      metadataNeeds.requiredRecursive ||
      metadataNeeds.optionalRecursive
    ) {
      try {
        recursiveMetadata = (
          await this.getOptimizedRecursiveFunctionDescriptor(
            functionName,
            directCpicSessionLanguages.get(this) ?? "E",
            signal,
          )
        ).value;
      } catch (error) {
        if (
          recursiveParameters.length > 0 ||
          metadataNeeds.requiredRecursive ||
          !allowsOptionalRecursiveMetadataFallback(error)
        ) {
          throw error;
        }
      }
    }
    const recursiveParameterIndex =
      recursiveMetadata !== undefined &&
        recursiveContainerParameters.length > 0
        ? createRecursiveMetadataParameterIndex(recursiveMetadata)
        : undefined;
    if (recursiveMetadata !== undefined) {
      const admitted = [...recursiveParameters];
      const admittedNames = new Set(
        admitted.map((parameter) => parameter.parameterName),
      );
      for (const parameter of recursiveContainerParameters) {
        if (
          admittedNames.has(parameter.parameterName) ||
          resolveRecursiveXrfcParameterFromIndex(
            recursiveMetadata,
            recursiveParameterIndex!,
            parameter,
          ) === undefined
        ) {
          continue;
        }
        admitted.push(parameter);
        admittedNames.add(parameter.parameterName);
      }
      try {
        this.#admitRecursiveSerializerSend(
          metadata,
          recursiveMetadata,
          Object.freeze(admitted),
        );
      } catch (cause) {
        throw new DirectCpicPreWireError(cause);
      }
    }
    for (const parameter of recursiveContainerParameters) {
      if (
        recursiveMetadata !== undefined &&
        resolveRecursiveXrfcParameterFromIndex(
          recursiveMetadata,
          recursiveParameterIndex!,
          parameter,
        ) !== undefined
      ) {
        continue;
      }
      if (parameter.tableName.length === 0) {
        throw new Error(`${parameter.parameterName} lacks its structure type name`);
      }
      structures.set(
        parameter.tableName,
        await this.getStructureDefinition(parameter.tableName, signal),
      );
    }
    const response = await this.exchange(
      buildClassicRfcInvocationRequest(
        metadata,
        invocation.input,
        structures,
        invocation.options,
        recursiveMetadata,
      ),
      signal,
      true,
    );
    const decoded = await this.#decodeRegularResponse(response);
    return this.#decodeApplicationResult(() =>
      decodeOwnedClassicRfcInvocationResult(
        metadata,
        decoded.fields,
        structures,
        invocation.options,
        recursiveMetadata,
      ));
  }

  /**
   * Execute with a destination-owned immutable metadata snapshot. This keeps
   * repository-lane failures outside the application-session disposition path.
   */
  async invokeClassicWithMetadata(
    metadata: RfcFunctionInterface,
    input: ClassicRfcInput,
    structures: RfcStructureRepository,
    signal?: AbortSignal,
    options: ClassicRfcInvocationOptions = {},
    recursiveMetadata?: RecursiveMetadataGraph,
  ): Promise<ClassicRfcOutput> {
    let request: Uint8Array;
    let invocation: CapturedClassicRfcInvocation;
    try {
      const maximumApplicationDataLength =
        classicMaximumApplicationDataLength(options);
      const int8Mode = snapshotClassicInt8Mode(options.int8Mode);
      const bcd = snapshotClassicBcdMode(options.bcd);
      invocation = captureClassicRfcInvocation(
        metadata,
        input,
        {
          notRequested: options.notRequested,
          activated: options.activated,
          deactivated: options.deactivated,
          maxApplicationDataLength: maximumApplicationDataLength,
          int8Mode,
          bcd,
        },
      );
      if (recursiveMetadata !== undefined) {
        const admitted = [
          ...classicInvocationRecursiveMetadataParameters(
            metadata,
            invocation.input,
            invocation.options,
          ),
        ];
        const admittedNames = new Set(
          admitted.map((parameter) => parameter.parameterName),
        );
        const metadataNeeds = classifyClassicInvocationMetadataNeeds(
          metadata,
          invocation.input,
          invocation.options,
        );
        const recursiveContainerParameters = metadata.parameters.filter(
          (parameter) =>
            parameter.exid === "u" &&
            metadataNeeds.containerParameters.has(parameter.parameterName),
        );
        const recursiveParameterIndex = recursiveContainerParameters.length > 0
          ? createRecursiveMetadataParameterIndex(recursiveMetadata)
          : undefined;
        for (const parameter of recursiveContainerParameters) {
          if (
            admittedNames.has(parameter.parameterName) ||
            resolveRecursiveXrfcParameterFromIndex(
              recursiveMetadata,
              recursiveParameterIndex!,
              parameter,
            ) === undefined
          ) {
            continue;
          }
          admitted.push(parameter);
          admittedNames.add(parameter.parameterName);
        }
        this.#admitRecursiveSerializerSend(
          metadata,
          recursiveMetadata,
          Object.freeze(admitted),
        );
      }
      request = buildClassicRfcInvocationRequest(
        metadata,
        invocation.input,
        structures,
        invocation.options,
        recursiveMetadata,
      );
    } catch (cause) {
      throw new DirectCpicPreWireError(cause);
    }
    const response = await this.exchange(request, signal, true);
    const decoded = await this.#decodeRegularResponse(response);
    return this.#decodeApplicationResult(() =>
      decodeOwnedClassicRfcInvocationResult(
        metadata,
        decoded.fields,
        structures,
        invocation.options,
        recursiveMetadata,
      ));
  }

  async getStructureDefinition(
    structureName: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before structure metadata lookup",
      );
    }
    const cached = this.#structures.get(structureName);
    if (cached !== undefined) return cached;
    const response = await this.exchange(
      buildDdIfFieldInfoGetRequest(structureName),
      signal,
    );
    const decoded = await this.#decodeRegularResponse(response);
    const definition = await this.#decodeApplicationResult(() =>
      decodeDdIfFieldInfoGetResult(
        structureName,
        decoded.fields,
      ));
    this.#structures.set(structureName, definition);
    return definition;
  }

  /** Optimized, one-roundtrip flat classic structure metadata lookup. */
  async getOptimizedStructureDefinition(
    structureName: string,
    language = "E",
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition> {
    return (await this.getOptimizedStructureDescriptor(
      structureName,
      language,
      signal,
    )).value;
  }

  /** Detailed same-response form used by destination-owned cache tracking. */
  async getOptimizedStructureDescriptor(
    structureName: string,
    language = "E",
    signal?: AbortSignal,
  ): Promise<RfcMetadataGetStructureResult> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before optimized structure metadata lookup",
      );
    }
    const invocation = createRfcMetadataGetStructureInvocation(
      structureName,
      language,
    );
    const output = await this.invokeClassicWithMetadata(
      RFC_METADATA_GET_BOOTSTRAP.metadata,
      invocation.input,
      RFC_METADATA_GET_BOOTSTRAP.structures,
      signal,
    );
    return normalizeRfcMetadataGetStructureResult(structureName, output);
  }

  /**
   * Read bounded function/DDIC generation tokens without reloading complete
   * descriptors. The destination repository decides when to compare tokens.
   */
  async getOptimizedMetadataTimestamps(
    functionNames: readonly string[],
    structureNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<RfcMetadataTimestampBatch> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before optimized metadata timestamp lookup",
      );
    }
    const invocation = createRfcMetadataGetTimestampInvocation(
      functionNames,
      structureNames,
    );
    const output = await this.invokeClassicWithMetadata(
      RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP.metadata,
      invocation.input,
      RFC_METADATA_GET_TIMESTAMP_BOOTSTRAP.structures,
      signal,
    );
    return normalizeRfcMetadataGetTimestamps(
      invocation.functionNames,
      invocation.structureNames,
      output,
    );
  }

  /** Explicit compatibility path for pre-DDIF legacy-v3 repositories only. */
  async getLegacyStructureDefinition(
    structureName: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition> {
    if (!this.#authenticated || this.#cpicSessionId === undefined) {
      throw new Error(
        "direct CPIC session must be authenticated before metadata lookup",
      );
    }
    const cached = this.#structures.get(structureName);
    if (cached !== undefined) return cached;
    const response = await this.exchange(
      buildRfcGetStructureDefinitionRequest(structureName),
      signal,
    );
    const decoded = await this.#decodeRegularResponse(response);
    const rowName = await this.#decodeApplicationResult(() =>
      detectRfcStructureDefinitionRowName(structureName, decoded.fields));
    if (rowName !== undefined) {
      const cachedRow = this.#structures.get(rowName);
      if (cachedRow !== undefined) {
        this.#structures.set(structureName, cachedRow);
        return cachedRow;
      }
      // RFC_GET_STRUCTURE_DEFINITION answers a table-type query with fields
      // owned by its line structure. Resolve that concrete structure once;
      // do not recursively follow peer-controlled aliases without a bound.
      const rowResponse = await this.exchange(
        buildRfcGetStructureDefinitionRequest(rowName),
        signal,
      );
      const decodedRow = await this.#decodeRegularResponse(rowResponse);
      const rowDefinition = await this.#decodeApplicationResult(() =>
        decodeRfcStructureDefinitionResult(rowName, decodedRow.fields));
      this.#structures.set(rowName, rowDefinition);
      this.#structures.set(structureName, rowDefinition);
      return rowDefinition;
    }
    const definition = await this.#decodeApplicationResult(() =>
      decodeRfcStructureDefinitionResult(structureName, decoded.fields));
    this.#structures.set(structureName, definition);
    return definition;
  }

  async exchange(
    data: Uint8Array,
    signal?: AbortSignal,
    allowCallbacks = false,
  ): Promise<Buffer> {
    return this.#exchange(data, signal, undefined, allowCallbacks);
  }

  #planOutgoingRequest(data: Uint8Array): readonly AppcOutgoingDataFragment[] {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("RFC request data must be a Uint8Array");
    }
    const requestByteLength = intrinsicUint8ArrayByteLength(data);
    if (
      requestByteLength >
        DEFAULT_MAX_APPC_OUTGOING_MESSAGE_LENGTH +
          APPC_FINAL_SAP_PARAMETER_LENGTH
    ) {
      throw new RangeError(
        "RFC request exceeds the direct CPIC request envelope",
      );
    }
    const request = snapshotUint8Array(
      data,
      "RFC request data",
      requestByteLength,
    );
    const framing = inspectCpicRequestAppcFraming(request);
    return planOutgoingAppcDataFragments(
      {
        conversationId: this.#conversationId,
        communicationIndex: 0xffff,
        connectionIndex: this.#connectionIndex,
        applicationData: request.subarray(0, framing.applicationDataLength),
        finalSapParameters: framing.finalSapParameterLength === 0
          ? undefined
          : request.subarray(framing.applicationDataLength),
      },
      { cpicStreaming: this.#cpicStreaming },
    );
  }

  #assertExchangeAvailable(owner?: symbol): void {
    if (
      this.#busy ||
      (this.#compoundOperationOwner !== undefined &&
        this.#compoundOperationOwner !== owner)
    ) {
      throw new RfcCoreError(createRfcFailure({
        category: RfcFailureCategory.InvalidState,
        origin: RfcFailureOrigin.Api,
        phase: RfcOperationPhase.Send,
        transmission: RfcTransmissionState.NotStarted,
        establishedSession: this.#authenticated,
        reasonCode: "RFC_CONCURRENT_CALL",
        key: "RFC_ILLEGAL_STATE",
        message: "direct CPIC session already has an in-flight operation",
      }));
    }
  }

  async #exchange(
    data: Uint8Array,
    signal?: AbortSignal,
    owner?: symbol,
    allowCallbacks = false,
  ): Promise<Buffer> {
    if (this.#closed) throw new Error("direct CPIC session is closed");
    this.#assertExchangeAvailable(owner);
    let outgoingPlan: readonly AppcOutgoingDataFragment[];
    try {
      outgoingPlan = this.#planOutgoingRequest(data);
    } catch (cause) {
      throw new RfcCoreError(createRfcFailure({
        category: RfcFailureCategory.Serialization,
        origin: RfcFailureOrigin.Codec,
        phase: RfcOperationPhase.Encode,
        transmission: RfcTransmissionState.NotStarted,
        establishedSession: this.#authenticated,
        reasonCode: "RFC_APPC_REQUEST_ENCODING_FAILED",
        key: "RFC_SERIALIZATION_FAILURE",
        message: "RFC request could not be encoded for APPC",
        cause,
      }));
    }
    this.#busy = true;
    let phase = RfcOperationPhase.Send;
    let transmission = RfcTransmissionState.NotStarted;
    try {
      // A complete frame left by the previous invocation must never be
      // attributed to this request. This check also retires the transport.
      this.#transport.assertNoQueuedFrames();
      await writeOutgoingAppcDataPlan(
        this.#transport,
        this.#setup,
        outgoingPlan,
        signal,
        this.#operationTimeoutMs,
      );
      transmission = RfcTransmissionState.Complete;
      phase = RfcOperationPhase.Receive;
      let decoder: AppcConversationDecoder | undefined;
      let callbackCount = 0;
      for (;;) {
        const payload = await this.#transport.receive({
          timeoutMs: this.#operationTimeoutMs,
          signal,
        });
        const disposition = this.#setup.received(payload);
        decoder ??= new AppcConversationDecoder({
          allowInitialReceive:
            outgoingPlan[0]?.functionCode === AppcFunction.AsyncSendData,
          validateIncomingDataOperationInfo: true,
        });
        const messages = disposition === "normal-deallocation"
          ? decoder.pushTerminalDeallocation(payload)
          : decoder.push(payload);
        if (messages.length > 0) {
          if (messages.length !== 1) {
            throw new Error("APPC reply contained more than one RFC message");
          }
          decoder.finish();
          const message = messages[0]!;
          assertDirectCpicResponseIdentity(
            message,
            this.#conversationId,
            this.#connectionIndex,
          );
          if (disposition === "normal-deallocation") {
            // CPI-C is already in Reset and its conversation ID is invalid.
            // The buffered RFC envelope may be decoded once, but this physical
            // generation must never be lent or reused again.
            await this.#terminateGeneration();
          } else {
            // Reject a coalesced second complete NI frame before returning the
            // first response to the caller. A later frame is caught by the
            // pre-send boundary above.
            this.#transport.assertNoQueuedFrames();
            this.#setup.responseComplete();
          }
          if (isCpicRfcCallbackRequest(message.data)) {
            if (!allowCallbacks || this.#callbacks === undefined) {
              throw new Error(
                "server sent an RFC callback but no callback handlers are configured",
              );
            }
            callbackCount += 1;
            if (callbackCount > DEFAULT_MAX_RFC_CALLBACKS_PER_CALL) {
              throw new Error(
                `server exceeded ${DEFAULT_MAX_RFC_CALLBACKS_PER_CALL} RFC callbacks in one call`,
              );
            }
            const callbackRequest = decodeCpicRfcCallbackRequest(message.data);
            const handler = this.#callbacks.get(callbackRequest.functionName);
            let callbackResponse: Buffer;
            if (handler === undefined) {
              callbackResponse = encodeCpicRfcCallbackException("FU_NOT_FOUND");
            } else {
              const response = Reflect.apply(handler, undefined, [
                callbackRequest,
                Object.freeze({ callbackIndex: callbackCount, signal }),
              ]) as ReturnType<typeof handler>;
              if (
                typeof response === "object" &&
                response !== null &&
                "then" in response &&
                typeof (response as { readonly then?: unknown }).then === "function"
              ) {
                throw new TypeError("RFC callback handlers must return synchronously");
              }
              callbackResponse = encodeCpicRfcCallbackResponse(response);
            }
            outgoingPlan = this.#planOutgoingRequest(
              frameCpicRfcCallbackResponse(callbackResponse),
            );
            phase = RfcOperationPhase.Send;
            await writeOutgoingAppcDataPlan(
              this.#transport,
              this.#setup,
              outgoingPlan,
              signal,
              this.#operationTimeoutMs,
            );
            phase = RfcOperationPhase.Receive;
            decoder = undefined;
            continue;
          }
          return message.data;
        }
      }
    } catch (cause) {
      const transportCause =
        cause instanceof DirectCpicOutgoingWriteError ? cause.cause : cause;
      if (cause instanceof DirectCpicOutgoingWriteError) {
        transmission = cause.transmission;
      }
      const niError =
        transportCause instanceof NiTransportError ? transportCause : undefined;
      const appcCommunicationError =
        transportCause instanceof AppcPeerReturnCodeError ||
        transportCause instanceof AppcNormalDeallocationWithoutDataError;
      const category = niError?.code === "NI_ABORTED"
        ? RfcFailureCategory.Canceled
        : niError?.code === "NI_RECEIVE_TIMEOUT" ||
            niError?.code === "NI_CONNECT_TIMEOUT" ||
            niError?.code === "NI_WRITE_TIMEOUT"
          ? RfcFailureCategory.Timeout
          : appcCommunicationError
            ? RfcFailureCategory.Communication
            : niError?.code === "NI_PROTOCOL_ERROR" || niError === undefined
              ? RfcFailureCategory.MalformedProtocol
              : RfcFailureCategory.Communication;
      const reasonCode = transportCause instanceof
          AppcNormalDeallocationWithoutDataError
        ? "CM_NO_DATA_RECEIVED"
        : transportCause instanceof AppcPeerReturnCodeError
          ? `RFC_APPC_RETURN_${transportCause.appcReturnCode}_SAP_${transportCause.sapReturnCode}`
          : niError?.code ?? "RFC_APPC_RESPONSE_MALFORMED";
      const failure = createRfcFailure({
        category,
        origin: niError === undefined ? RfcFailureOrigin.Appc : RfcFailureOrigin.Ni,
        phase,
        transmission,
        establishedSession: this.#authenticated,
        reasonCode,
        key: appcCommunicationError
          ? "RFC_COMMUNICATION_FAILURE"
          : niError?.code ?? "RFC_APPC_RESPONSE_MALFORMED",
        message:
          transportCause instanceof Error
            ? transportCause.message
            : "RFC transport failed",
        cause: transportCause,
      });
      await this.#terminateGeneration();
      throw new RfcCoreError(failure);
    } finally {
      this.#busy = false;
    }
  }

  async #decodeRegularResponse(
    response: Uint8Array,
    kind: "regular" | "reset" | "sessionRefresh" = "regular",
  ): Promise<DecodedCpicFunctionResultFields> {
    // exchange() can return bytes after CM_DEALLOCATED_NORMAL, but it closes
    // the generation before doing so. That terminal transport fact must
    // override otherwise-reusable RFC envelope outcomes.
    const terminalTransport = this.#setup.state === "closed";
    let decoded: DecodedCpicFunctionResultFields;
    try {
      decoded = kind === "reset"
        ? decodeCpicResetServerContextResultFields(response)
        : kind === "sessionRefresh"
          ? decodeCpicSessionRefreshResultFields(response)
          : decodeCpicFunctionResultFields(response);
    } catch (cause) {
      const failure = createRfcFailure({
        category: RfcFailureCategory.MalformedProtocol,
        origin: RfcFailureOrigin.Cpic,
        phase: RfcOperationPhase.EnvelopeDecode,
        transmission: RfcTransmissionState.Complete,
        establishedSession: this.#authenticated,
        reasonCode: "RFC_CPIC_RESPONSE_MALFORMED",
        key: "RFC_INVALID_PROTOCOL",
        message: "CPIC RFC response is malformed",
        cause,
      });
      await this.#terminateGeneration();
      throw new RfcCoreError(failure);
    }
    if (decoded.envelope.outcome !== "success") {
      const failure = createRemoteRfcFailure(decoded.envelope, {
        establishedSession: this.#authenticated,
        ...(terminalTransport ? { origin: RfcFailureOrigin.Appc } : {}),
      });
      if (failure.disposition !== RfcConnectionDisposition.Reusable) {
        await this.#terminateGeneration();
      }
      throw new RfcCoreError(failure);
    }
    if (terminalTransport) {
      throw new RfcCoreError(createRfcFailure({
        category: RfcFailureCategory.Communication,
        origin: RfcFailureOrigin.Appc,
        phase: RfcOperationPhase.EnvelopeDecode,
        transmission: RfcTransmissionState.Complete,
        establishedSession: this.#authenticated,
        reasonCode: "CM_DEALLOCATED_NORMAL",
        key: "RFC_COMMUNICATION_FAILURE",
        message: "the peer normally deallocated the conversation after its response",
      }));
    }
    return decoded;
  }

  async #decodeApplicationResult<T>(decode: () => T): Promise<T> {
    try {
      return decode();
    } catch (cause) {
      if (cause instanceof ClassicBcdConversionError) throw cause;
      const failure = createRfcFailure({
        category: RfcFailureCategory.MalformedProtocol,
        origin: RfcFailureOrigin.Codec,
        phase: RfcOperationPhase.ValueDecode,
        transmission: RfcTransmissionState.Complete,
        establishedSession: this.#authenticated,
        reasonCode: "RFC_RESPONSE_VALUE_MALFORMED",
        key: "RFC_INVALID_PROTOCOL",
        message: "RFC response values are malformed",
        cause,
      });
      await this.#terminateGeneration();
      throw new RfcCoreError(failure);
    }
  }

  async #terminateGeneration(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cpicSessionId?.fill(0);
    this.#cpicSessionId = undefined;
    this.#metadata.clear();
    this.#structures.clear();
    await this.#transport.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#busy || this.#compoundOperationOwner !== undefined) {
      throw new Error("cannot close a direct CPIC session during an exchange");
    }
    this.#closed = true;
    this.#cpicSessionId?.fill(0);
    this.#cpicSessionId = undefined;
    this.#metadata.clear();
    this.#structures.clear();
    try {
      if (this.#setup.state === "ready") {
        this.#setup.sent(AppcFunction.Deallocate);
        await this.#transport.send(
          encodeAppcControlRecord({
            functionCode: AppcFunction.Deallocate,
            conversationId: this.#conversationId,
            extendedInfo: {
              shortDestinationName: "",
              logicalUnitName: "",
              transactionProgramName: "",
              connectionType: 0,
              clientInfo: 0,
              communicationIndex: 0xffff,
              connectionIndex: this.#connectionIndex,
            },
          }),
        ).catch(() => undefined);
      }
    } finally {
      await this.#transport.close();
    }
  }
}
