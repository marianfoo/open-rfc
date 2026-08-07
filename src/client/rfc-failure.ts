import { randomUUID } from "node:crypto";

import {
  type RfcErrorEnvelope,
  type RfcErrorFactProvenance,
  type RfcRemoteErrorFacts,
} from "../protocol/rfc-error-envelope.js";

export enum RfcFailureCategory {
  InvalidState = "invalidState",
  InvalidParameter = "invalidParameter",
  Conversion = "conversion",
  Serialization = "serialization",
  Unsupported = "unsupported",
  Resource = "resource",
  Communication = "communication",
  Logon = "logon",
  AbapRuntime = "abapRuntime",
  AbapException = "abapException",
  AbapMessage = "abapMessage",
  Canceled = "canceled",
  Timeout = "timeout",
  MalformedProtocol = "malformedProtocol",
}

export enum RfcFailureOrigin {
  Api = "api",
  Codec = "codec",
  Ni = "ni",
  Gateway = "gateway",
  Appc = "appc",
  Cpic = "cpic",
  Sap = "sap",
  Metadata = "metadata",
  Pool = "pool",
}

export enum RfcOperationPhase {
  Connect = "connect",
  GatewaySetup = "gatewaySetup",
  AppcSetup = "appcSetup",
  Logon = "logon",
  Metadata = "metadata",
  Encode = "encode",
  Send = "send",
  Receive = "receive",
  EnvelopeDecode = "envelopeDecode",
  ValueDecode = "valueDecode",
  Close = "close",
  Replacement = "replacement",
}

export enum RfcTransmissionState {
  NotStarted = "notStarted",
  Partial = "partial",
  Complete = "complete",
  Unknown = "unknown",
}

/** Disposition of the physical connection generation which saw the failure. */
export enum RfcConnectionDisposition {
  Reusable = "reusable",
  Close = "close",
  UnknownClose = "unknownClose",
}

/** Client-level action after the old generation's disposition is applied. */
export enum RfcRecoveryAction {
  None = "none",
  Replace = "replace",
}

export enum RfcReplayPolicy {
  Never = "never",
}

/**
 * SAP RFC error groups, kept language-neutral in the core.
 *
 * Only the groups `CODE_POLICY` can produce are declared, and each keeps its
 * own explicit ordinal, so the numbering is stable and independent of the
 * member list.
 */
export enum RfcFailureGroup {
  AbapApplicationFailure = 1,
  AbapRuntimeFailure = 2,
  LogonFailure = 3,
  CommunicationFailure = 4,
  ExternalRuntimeFailure = 5,
}

/** SAP RFC return codes needed by the beta client failure model. */
export enum RfcFailureCode {
  CommunicationFailure = 1,
  LogonFailure = 2,
  AbapRuntimeFailure = 3,
  AbapMessage = 4,
  AbapException = 5,
  Closed = 6,
  Canceled = 7,
  Timeout = 8,
  MemoryInsufficient = 9,
  VersionMismatch = 10,
  InvalidProtocol = 11,
  SerializationFailure = 12,
  NotSupported = 18,
  IllegalState = 19,
  InvalidParameter = 20,
  CodepageConversionFailure = 21,
  ConversionFailure = 22,
  UnknownError = 28,
}

export type RfcFailureCodeString =
  | "RFC_COMMUNICATION_FAILURE"
  | "RFC_LOGON_FAILURE"
  | "RFC_ABAP_RUNTIME_FAILURE"
  | "RFC_ABAP_MESSAGE"
  | "RFC_ABAP_EXCEPTION"
  | "RFC_CLOSED"
  | "RFC_CANCELED"
  | "RFC_TIMEOUT"
  | "RFC_MEMORY_INSUFFICIENT"
  | "RFC_VERSION_MISMATCH"
  | "RFC_INVALID_PROTOCOL"
  | "RFC_SERIALIZATION_FAILURE"
  | "RFC_NOT_SUPPORTED"
  | "RFC_ILLEGAL_STATE"
  | "RFC_INVALID_PARAMETER"
  | "RFC_CODEPAGE_CONVERSION_FAILURE"
  | "RFC_CONVERSION_FAILURE"
  | "RFC_UNKNOWN_ERROR";

export interface RfcFailurePolicyContext {
  readonly category: RfcFailureCategory;
  readonly origin: RfcFailureOrigin;
  readonly phase: RfcOperationPhase;
  readonly transmission: RfcTransmissionState;
  /** True only after a fully authenticated physical generation exists. */
  readonly establishedSession: boolean;
}

export interface RfcFailurePolicy {
  readonly group: RfcFailureGroup;
  readonly code: RfcFailureCode;
  readonly codeString: RfcFailureCodeString;
  readonly disposition: RfcConnectionDisposition;
  readonly recoveryAction: RfcRecoveryAction;
  readonly replayPolicy: RfcReplayPolicy.Never;
}

export interface RfcFailureAbapFacts {
  readonly exceptionKey: string;
  readonly plainText: string;
  readonly runtimeId: string;
  readonly t100Text: string;
  readonly messageClass: string;
  readonly messageType: string;
  readonly messageNumber: string;
  readonly messageV1: string;
  readonly messageV2: string;
  readonly messageV3: string;
  readonly messageV4: string;
  readonly callStack: string;
  readonly provenance: readonly RfcErrorFactProvenance[];
}

export interface RfcFailureDiagnostic {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly category: RfcFailureCategory;
  readonly origin: RfcFailureOrigin;
  readonly phase: RfcOperationPhase;
  readonly transmission: RfcTransmissionState;
  readonly disposition: RfcConnectionDisposition;
  readonly recoveryAction: RfcRecoveryAction;
  readonly replayPolicy: RfcReplayPolicy.Never;
  readonly group: RfcFailureGroup;
  readonly code: RfcFailureCode;
  readonly codeString: RfcFailureCodeString;
}

export interface RfcFailure {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly category: RfcFailureCategory;
  readonly origin: RfcFailureOrigin;
  readonly phase: RfcOperationPhase;
  readonly transmission: RfcTransmissionState;
  readonly disposition: RfcConnectionDisposition;
  readonly recoveryAction: RfcRecoveryAction;
  readonly replayPolicy: RfcReplayPolicy.Never;
  readonly group: RfcFailureGroup;
  readonly code: RfcFailureCode;
  readonly codeString: RfcFailureCodeString;
  readonly key: string;
  readonly message: string;
  readonly abap: RfcFailureAbapFacts;
  readonly cause?: unknown;
  /** JSON serialization is deliberately restricted to the safe diagnostic. */
  readonly toJSON: () => RfcFailureDiagnostic;
}

export interface CreateRfcFailureInput extends RfcFailurePolicyContext {
  readonly correlationId?: string;
  readonly reasonCode: string;
  readonly key?: string;
  readonly message?: string;
  readonly abap?: RfcRemoteErrorFacts | RfcFailureAbapFacts;
  readonly cause?: unknown;
}

export interface CreateRemoteRfcFailureContext {
  readonly correlationId?: string;
  readonly origin?: RfcFailureOrigin;
  readonly phase?: RfcOperationPhase;
  readonly transmission?: RfcTransmissionState;
  readonly establishedSession: boolean;
  readonly cause?: unknown;
}

interface CodePolicy {
  readonly group: RfcFailureGroup;
  readonly code: RfcFailureCode;
  readonly codeString: RfcFailureCodeString;
}

const CODE_POLICY: Readonly<Record<RfcFailureCategory, CodePolicy>> =
  Object.freeze({
    [RfcFailureCategory.InvalidState]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.IllegalState,
      codeString: "RFC_ILLEGAL_STATE",
    }),
    [RfcFailureCategory.InvalidParameter]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.InvalidParameter,
      codeString: "RFC_INVALID_PARAMETER",
    }),
    [RfcFailureCategory.Conversion]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.ConversionFailure,
      codeString: "RFC_CONVERSION_FAILURE",
    }),
    [RfcFailureCategory.Serialization]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.SerializationFailure,
      codeString: "RFC_SERIALIZATION_FAILURE",
    }),
    [RfcFailureCategory.Unsupported]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.NotSupported,
      codeString: "RFC_NOT_SUPPORTED",
    }),
    [RfcFailureCategory.Resource]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.MemoryInsufficient,
      codeString: "RFC_MEMORY_INSUFFICIENT",
    }),
    [RfcFailureCategory.Communication]: Object.freeze({
      group: RfcFailureGroup.CommunicationFailure,
      code: RfcFailureCode.CommunicationFailure,
      codeString: "RFC_COMMUNICATION_FAILURE",
    }),
    [RfcFailureCategory.Logon]: Object.freeze({
      group: RfcFailureGroup.LogonFailure,
      code: RfcFailureCode.LogonFailure,
      codeString: "RFC_LOGON_FAILURE",
    }),
    [RfcFailureCategory.AbapRuntime]: Object.freeze({
      group: RfcFailureGroup.AbapRuntimeFailure,
      code: RfcFailureCode.AbapRuntimeFailure,
      codeString: "RFC_ABAP_RUNTIME_FAILURE",
    }),
    [RfcFailureCategory.AbapException]: Object.freeze({
      group: RfcFailureGroup.AbapApplicationFailure,
      code: RfcFailureCode.AbapException,
      codeString: "RFC_ABAP_EXCEPTION",
    }),
    [RfcFailureCategory.AbapMessage]: Object.freeze({
      group: RfcFailureGroup.AbapRuntimeFailure,
      code: RfcFailureCode.AbapMessage,
      codeString: "RFC_ABAP_MESSAGE",
    }),
    [RfcFailureCategory.Canceled]: Object.freeze({
      group: RfcFailureGroup.CommunicationFailure,
      code: RfcFailureCode.Canceled,
      codeString: "RFC_CANCELED",
    }),
    [RfcFailureCategory.Timeout]: Object.freeze({
      group: RfcFailureGroup.CommunicationFailure,
      code: RfcFailureCode.Timeout,
      codeString: "RFC_TIMEOUT",
    }),
    [RfcFailureCategory.MalformedProtocol]: Object.freeze({
      group: RfcFailureGroup.ExternalRuntimeFailure,
      code: RfcFailureCode.InvalidProtocol,
      codeString: "RFC_INVALID_PROTOCOL",
    }),
  });

const LOCAL_PRE_SEND_PHASES: ReadonlySet<RfcOperationPhase> = new Set([
  RfcOperationPhase.Metadata,
  RfcOperationPhase.Encode,
]);

const FAILURE_CATEGORIES: ReadonlySet<unknown> = new Set(
  Object.values(RfcFailureCategory),
);
const FAILURE_ORIGINS: ReadonlySet<unknown> = new Set(
  Object.values(RfcFailureOrigin),
);
const OPERATION_PHASES: ReadonlySet<unknown> = new Set(
  Object.values(RfcOperationPhase),
);
const TRANSMISSION_STATES: ReadonlySet<unknown> = new Set(
  Object.values(RfcTransmissionState),
);

function validateFailurePolicyContext(
  context: unknown,
): asserts context is RfcFailurePolicyContext {
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new TypeError("RFC failure policy context must be an object");
  }
  const candidate = context as Readonly<Record<string, unknown>>;
  if (!FAILURE_CATEGORIES.has(candidate.category)) {
    throw new TypeError("category must be a supported RfcFailureCategory");
  }
  if (!FAILURE_ORIGINS.has(candidate.origin)) {
    throw new TypeError("origin must be a supported RfcFailureOrigin");
  }
  if (!OPERATION_PHASES.has(candidate.phase)) {
    throw new TypeError("phase must be a supported RfcOperationPhase");
  }
  if (!TRANSMISSION_STATES.has(candidate.transmission)) {
    throw new TypeError("transmission must be a supported RfcTransmissionState");
  }
  if (typeof candidate.establishedSession !== "boolean") {
    throw new TypeError("establishedSession must be a boolean");
  }
}

function replacementFor(
  establishedSession: boolean,
  disposition: RfcConnectionDisposition,
): RfcRecoveryAction {
  return establishedSession && disposition !== RfcConnectionDisposition.Reusable
    ? RfcRecoveryAction.Replace
    : RfcRecoveryAction.None;
}

/**
 * Authoritative beta policy. Call sites cannot weaken connection disposition
 * or grant replay permission.
 */
export function resolveRfcFailurePolicy(
  context: RfcFailurePolicyContext,
): RfcFailurePolicy {
  validateFailurePolicyContext(context);
  const codePolicy = CODE_POLICY[context.category];
  let disposition: RfcConnectionDisposition;
  switch (context.category) {
    case RfcFailureCategory.AbapException:
      disposition =
        context.origin === RfcFailureOrigin.Sap &&
        context.phase === RfcOperationPhase.EnvelopeDecode &&
        context.transmission === RfcTransmissionState.Complete &&
        context.establishedSession
          ? RfcConnectionDisposition.Reusable
          : RfcConnectionDisposition.UnknownClose;
      break;
    case RfcFailureCategory.MalformedProtocol:
      disposition = RfcConnectionDisposition.UnknownClose;
      break;
    case RfcFailureCategory.InvalidState:
    case RfcFailureCategory.InvalidParameter:
    case RfcFailureCategory.Conversion:
    case RfcFailureCategory.Serialization:
    case RfcFailureCategory.Unsupported:
    case RfcFailureCategory.Resource:
      disposition =
        context.transmission === RfcTransmissionState.NotStarted &&
        (context.origin === RfcFailureOrigin.Api ||
          context.origin === RfcFailureOrigin.Codec ||
          context.origin === RfcFailureOrigin.Pool ||
          LOCAL_PRE_SEND_PHASES.has(context.phase))
          ? RfcConnectionDisposition.Reusable
          : RfcConnectionDisposition.UnknownClose;
      break;
    case RfcFailureCategory.Communication:
    case RfcFailureCategory.Logon:
    case RfcFailureCategory.AbapRuntime:
    case RfcFailureCategory.AbapMessage:
    case RfcFailureCategory.Canceled:
    case RfcFailureCategory.Timeout:
      disposition = RfcConnectionDisposition.Close;
      break;
  }

  return Object.freeze({
    ...codePolicy,
    disposition,
    recoveryAction: replacementFor(
      context.establishedSession,
      disposition,
    ),
    replayPolicy: RfcReplayPolicy.Never,
  });
}

function validateSafeIdentifier(
  value: unknown,
  field: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    throw new RangeError(
      `${field} must contain 1..${maximumLength} safe identifier characters`,
    );
  }
}

function copyProvenance(
  provenance: readonly RfcErrorFactProvenance[],
): readonly RfcErrorFactProvenance[] {
  if (!Array.isArray(provenance)) {
    throw new TypeError("ABAP fact provenance must be an array");
  }
  let previousOrdinal = -1;
  return Object.freeze(
    provenance.map((fact, index) => {
      if (typeof fact !== "object" || fact === null) {
        throw new TypeError(`ABAP fact provenance entry ${index} must be an object`);
      }
      if (!Number.isSafeInteger(fact.tag) || fact.tag < 0 || fact.tag > 0xffff) {
        throw new RangeError(`ABAP fact provenance entry ${index} has an invalid tag`);
      }
      if (
        !Number.isSafeInteger(fact.ordinal) ||
        fact.ordinal < 0 ||
        fact.ordinal <= previousOrdinal
      ) {
        throw new RangeError(
          `ABAP fact provenance entry ${index} has a non-increasing ordinal`,
        );
      }
      if (
        !Number.isSafeInteger(fact.byteLength) ||
        fact.byteLength < 0 ||
        fact.byteLength > 0x7fff_ffff
      ) {
        throw new RangeError(
          `ABAP fact provenance entry ${index} has an invalid byteLength`,
        );
      }
      previousOrdinal = fact.ordinal;
      return Object.freeze({
        tag: fact.tag,
        ordinal: fact.ordinal,
        byteLength: fact.byteLength,
      });
    }),
  );
}

function emptyAbapFacts(): RfcFailureAbapFacts {
  return Object.freeze({
    exceptionKey: "",
    plainText: "",
    runtimeId: "",
    t100Text: "",
    messageClass: "",
    messageType: "",
    messageNumber: "",
    messageV1: "",
    messageV2: "",
    messageV3: "",
    messageV4: "",
    callStack: "",
    provenance: Object.freeze([]),
  });
}

function copyAbapFacts(
  facts: RfcRemoteErrorFacts | RfcFailureAbapFacts | undefined,
): RfcFailureAbapFacts {
  if (facts === undefined) return emptyAbapFacts();
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    throw new TypeError("ABAP facts must be an object");
  }
  const source = facts as unknown as Readonly<Record<string, unknown>>;
  for (const field of [
    "exceptionKey",
    "plainText",
    "runtimeId",
    "t100Text",
    "messageClass",
    "messageType",
    "messageNumber",
    "messageV1",
    "messageV2",
    "messageV3",
    "messageV4",
    "callStack",
  ] as const) {
    if (typeof source[field] !== "string") {
      throw new TypeError(`ABAP fact ${field} must be a string`);
    }
  }
  return Object.freeze({
    exceptionKey: source.exceptionKey as string,
    plainText: source.plainText as string,
    runtimeId: source.runtimeId as string,
    t100Text: source.t100Text as string,
    messageClass: source.messageClass as string,
    messageType: source.messageType as string,
    messageNumber: source.messageNumber as string,
    messageV1: source.messageV1 as string,
    messageV2: source.messageV2 as string,
    messageV3: source.messageV3 as string,
    messageV4: source.messageV4 as string,
    callStack: source.callStack as string,
    provenance: copyProvenance(facts.provenance),
  });
}

export function rfcFailureDiagnostic(
  failure: Pick<
    RfcFailure,
    | "schemaVersion"
    | "correlationId"
    | "reasonCode"
    | "category"
    | "origin"
    | "phase"
    | "transmission"
    | "disposition"
    | "recoveryAction"
    | "replayPolicy"
    | "group"
    | "code"
    | "codeString"
  >,
): RfcFailureDiagnostic {
  return Object.freeze({
    schemaVersion: failure.schemaVersion,
    correlationId: failure.correlationId,
    reasonCode: failure.reasonCode,
    category: failure.category,
    origin: failure.origin,
    phase: failure.phase,
    transmission: failure.transmission,
    disposition: failure.disposition,
    recoveryAction: failure.recoveryAction,
    replayPolicy: failure.replayPolicy,
    group: failure.group,
    code: failure.code,
    codeString: failure.codeString,
  });
}

export function createRfcFailure(input: CreateRfcFailureInput): RfcFailure {
  validateFailurePolicyContext(input);
  const policy = resolveRfcFailurePolicy(input);
  const correlationId = input.correlationId ?? randomUUID();
  validateSafeIdentifier(correlationId, "correlationId", 128);
  validateSafeIdentifier(input.reasonCode, "reasonCode", 128);
  if (input.key !== undefined && typeof input.key !== "string") {
    throw new TypeError("key must be a string");
  }
  if (input.message !== undefined && typeof input.message !== "string") {
    throw new TypeError("message must be a string");
  }

  const abap = copyAbapFacts(input.abap);
  const failure: Record<string, unknown> = {
    schemaVersion: 1 as const,
    correlationId,
    reasonCode: input.reasonCode,
    category: input.category,
    origin: input.origin,
    phase: input.phase,
    transmission: input.transmission,
    disposition: policy.disposition,
    recoveryAction: policy.recoveryAction,
    replayPolicy: RfcReplayPolicy.Never,
    group: policy.group,
    code: policy.code,
    codeString: policy.codeString,
  };
  Object.defineProperties(failure, {
    key: {
      value: input.key ?? policy.codeString,
      configurable: false,
      enumerable: false,
      writable: false,
    },
    message: {
      value: input.message ?? policy.codeString,
      configurable: false,
      enumerable: false,
      writable: false,
    },
    abap: {
      value: abap,
      configurable: false,
      enumerable: false,
      writable: false,
    },
  });
  if (input.cause !== undefined) {
    Object.defineProperty(failure, "cause", {
      value: input.cause,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  Object.defineProperty(failure, "toJSON", {
    value: (): RfcFailureDiagnostic =>
      rfcFailureDiagnostic(failure as unknown as RfcFailure),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(failure) as unknown as RfcFailure;
}

function remoteCategory(
  envelope: RfcErrorEnvelope,
): RfcFailureCategory {
  switch (envelope.outcome) {
    case "abapException":
      return RfcFailureCategory.AbapException;
    case "abapRuntime":
      return RfcFailureCategory.AbapRuntime;
    case "abapMessage":
      return RfcFailureCategory.AbapMessage;
    case "success":
      throw new Error("a successful RFC envelope cannot create a failure");
  }
}

function remoteReasonCode(category: RfcFailureCategory): string {
  switch (category) {
    case RfcFailureCategory.AbapException:
      return "RFC_REMOTE_DECLARED_EXCEPTION";
    case RfcFailureCategory.AbapRuntime:
      return "RFC_REMOTE_ABAP_RUNTIME";
    case RfcFailureCategory.AbapMessage:
      return "RFC_REMOTE_ABAP_MESSAGE";
    default:
      throw new Error(`category ${category} is not a remote ABAP failure`);
  }
}

function remoteKey(
  category: RfcFailureCategory,
  facts: RfcRemoteErrorFacts,
): string {
  if (category === RfcFailureCategory.AbapException) return facts.exceptionKey;
  if (category === RfcFailureCategory.AbapRuntime) {
    return facts.runtimeId || facts.t100Text || facts.plainText || "RFC_ABAP_RUNTIME_FAILURE";
  }
  return facts.t100Text || facts.plainText || "RFC_ABAP_MESSAGE";
}

function remoteMessage(
  category: RfcFailureCategory,
  facts: RfcRemoteErrorFacts,
): string {
  if (facts.plainText.length > 0) return facts.plainText;
  if (facts.t100Text.length > 0) return facts.t100Text;
  if (category === RfcFailureCategory.AbapRuntime && facts.runtimeId.length > 0) {
    return facts.runtimeId;
  }
  return "";
}

export function createRemoteRfcFailure(
  envelope: RfcErrorEnvelope,
  context: CreateRemoteRfcFailureContext,
): RfcFailure {
  const category = remoteCategory(envelope);
  return createRfcFailure({
    category,
    origin: context.origin ?? RfcFailureOrigin.Sap,
    phase: context.phase ?? RfcOperationPhase.EnvelopeDecode,
    transmission: context.transmission ?? RfcTransmissionState.Complete,
    establishedSession: context.establishedSession,
    correlationId: context.correlationId,
    reasonCode: remoteReasonCode(category),
    key: remoteKey(category, envelope.facts),
    message: remoteMessage(category, envelope.facts),
    abap: envelope.facts,
    cause: context.cause,
  });
}

/** Internal thrown wrapper; its sensitive failure record is non-enumerable. */
export class RfcCoreError extends Error {
  declare readonly failure: RfcFailure;

  constructor(failure: RfcFailure) {
    super(
      `${failure.codeString}: ${failure.reasonCode} [${failure.correlationId}]`,
    );
    Object.defineProperty(this, "name", {
      value: "RfcCoreError",
      configurable: true,
      enumerable: false,
      writable: true,
    });
    Object.defineProperty(this, "failure", {
      value: failure,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}
