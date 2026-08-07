import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  isNormalizedRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../metadata/recursive-metadata.js";
import { createRecursiveMetadataParameterIndex } from
  "../metadata/recursive-parameter-index.js";
import type { RfcFunintParameter } from "../protocol/classic-rfc.js";
import {
  resolveRecursiveClassicXrfcParameterFromIndex,
  type RecursiveClassicXrfcParameterIdentity,
} from "./recursive-classic-xrfc.js";
import { validateRecursiveXrfcParameterFromIndex } from
  "./recursive-xrfc.js";

export type RecursiveSerializerProfile =
  | "offline"
  | "abap-7.50"
  | "abap-7.58";

export type LiveRecursiveSerializerProfile = Exclude<
  RecursiveSerializerProfile,
  "offline"
>;

export type ObservedRecursiveSerializer =
  | "classic-xrfc"
  | "basxml"
  | "unsupported";

export interface RecursiveSerializerObservation {
  readonly defaultSerializer: ObservedRecursiveSerializer;
  readonly basxmlDisabledSerializer: "classic-xrfc" | "unsupported";
}

/**
 * Explicit partner observation required before a live recursive request may
 * leave a direct CPIC session. This is deliberately separate from the graph:
 * BASXML_SUPPORTED is a capability bit, not proof of the serializer selected
 * for one concrete function/value graph.
 */
export interface LiveRecursiveSerializerPolicy {
  readonly profile: LiveRecursiveSerializerProfile;
  readonly observation: RecursiveSerializerObservation;
}

export interface RecursiveSerializerClassificationRequest {
  readonly profile: RecursiveSerializerProfile;
  readonly graph: RecursiveMetadataGraph;
  readonly parameters: readonly RecursiveClassicXrfcParameterIdentity[];
  readonly observation?: RecursiveSerializerObservation;
}

export interface RecursiveSerializerClassification {
  readonly schemaVersion: 1;
  readonly profile: RecursiveSerializerProfile;
  readonly graphSha256: `sha256:${string}`;
  readonly parameterCount: number;
  readonly parameterNames: readonly string[];
  readonly remoteBasxmlSupported: boolean | undefined;
  readonly selectedSerializer: "classic-xrfc" | "basxml-required";
  readonly status: "offline" | "live" | "blocked";
  readonly sendAllowed: boolean;
  readonly basxmlNegotiation: "unknown" | "disabled" | "required";
}

export interface RecursiveSerializerDecisionRequest {
  readonly graph: RecursiveMetadataGraph;
  readonly parameters: readonly RecursiveClassicXrfcParameterIdentity[];
}

/** Synchronous evidence resolver called at the live pre-send boundary. */
export type RecursiveSerializerDecisionProvider = (
  request: RecursiveSerializerDecisionRequest,
) => RecursiveSerializerClassification;

export class RecursiveSerializerClassificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`recursive serializer classification rejected: ${code}`);
    this.name = "RecursiveSerializerClassificationError";
    this.code = code;
  }
}

const PROFILES = new Set<RecursiveSerializerProfile>([
  "offline",
  "abap-7.50",
  "abap-7.58",
]);
const OBSERVED = new Set<ObservedRecursiveSerializer>([
  "classic-xrfc",
  "basxml",
  "unsupported",
]);
const trustedClassifications = new WeakSet<object>();

function fail(code: string): never {
  throw new RecursiveSerializerClassificationError(code);
}

function trustedClassification(
  value: RecursiveSerializerClassification,
): RecursiveSerializerClassification {
  const captured = Object.freeze(value);
  trustedClassifications.add(captured);
  return captured;
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor)
    ) {
      return fail(code);
    }
  }
  return value as Record<string, unknown>;
}

function graphProjection(graph: RecursiveMetadataGraph): object {
  if (!isNormalizedRecursiveMetadataGraph(graph)) return fail("untrusted-graph");
  return {
    version: graph.version,
    functionIdentity: graph.functionIdentity,
    nodes: [...graph.nodes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, node]) => ({ name, node })),
    parameters: graph.parameters,
    rootTypeNames: graph.rootTypeNames,
    cycles: graph.cycles,
    limits: graph.limits,
    statistics: graph.statistics,
  };
}

/** Stable content identity for one bounded normalized recursive metadata graph. */
export function recursiveMetadataGraphSha256(
  graph: RecursiveMetadataGraph,
): `sha256:${string}` {
  const bytes = JSON.stringify(graphProjection(graph));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function snapshotParameters(
  graph: RecursiveMetadataGraph,
  input: readonly RecursiveClassicXrfcParameterIdentity[],
): readonly RecursiveClassicXrfcParameterIdentity[] {
  if (
    !Array.isArray(input) ||
    nodeUtilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1
  ) {
    return fail("parameter-inventory");
  }
  const parameterIndex = createRecursiveMetadataParameterIndex(graph);
  if (input.length > parameterIndex.parameterCount) {
    return fail("parameter-inventory");
  }
  const result: RecursiveClassicXrfcParameterIdentity[] = [];
  const names = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);
    if (descriptor === undefined || !("value" in descriptor)) {
      return fail("parameter-inventory");
    }
    const parameter = plainRecord(
      descriptor.value,
      "parameter-identity",
    ) as unknown as RecursiveClassicXrfcParameterIdentity;
    const keys = Reflect.ownKeys(parameter);
    if (
      keys.length !== 5 ||
      !Object.hasOwn(parameter, "functionName") ||
      !Object.hasOwn(parameter, "parameterName") ||
      !Object.hasOwn(parameter, "parameterClass") ||
      !Object.hasOwn(parameter, "associatedType") ||
      !Object.hasOwn(parameter, "internalType") ||
      typeof parameter.functionName !== "string" ||
      parameter.functionName.length === 0 ||
      typeof parameter.parameterName !== "string" ||
      parameter.parameterName.length === 0 ||
      !/^[IECT]$/u.test(parameter.parameterClass) ||
      typeof parameter.associatedType !== "string" ||
      typeof parameter.internalType !== "string" ||
      parameter.internalType.length === 0
    ) {
      return fail("parameter-identity");
    }
    if (parameter.functionName !== graph.functionIdentity?.name) {
      return fail("parameter-identity");
    }
    const name = parameter.parameterName;
    if (typeof name !== "string" || names.has(name)) {
      return fail("parameter-identity");
    }
    names.add(name);
    // Prefer the independently qualified strict codec. When that older subset
    // rejects a supported scalar, require the broader codec to resolve and
    // validate the complete reachable graph before the same graph can obtain
    // a send decision. The adapter supplies no wire geometry: that remains
    // owned by the normalized recursive metadata graph.
    try {
      resolveRecursiveClassicXrfcParameterFromIndex(
        graph,
        parameterIndex,
        parameter,
      );
    } catch (strictError) {
      const broadParameter: RfcFunintParameter = Object.freeze({
        parameterClass: parameter.parameterClass,
        parameterName: parameter.parameterName,
        tableName: parameter.associatedType,
        fieldName: "",
        exid: parameter.internalType,
        position: index + 1,
        offset: 0,
        internalLength: 0,
        decimals: 0,
        defaultValue: "",
        parameterText: "",
        optional: false,
      });
      try {
        validateRecursiveXrfcParameterFromIndex(
          graph,
          parameterIndex,
          broadParameter,
        );
      } catch {
        throw strictError;
      }
    }
    result.push(Object.freeze({ ...parameter }));
  }
  return Object.freeze(result);
}

function snapshotObservation(
  value: RecursiveSerializerObservation | undefined,
): RecursiveSerializerObservation | undefined {
  if (value === undefined) return undefined;
  const record = plainRecord(value, "observation");
  if (
    Reflect.ownKeys(record).length !== 2 ||
    !Object.hasOwn(record, "defaultSerializer") ||
    !Object.hasOwn(record, "basxmlDisabledSerializer") ||
    !OBSERVED.has(record.defaultSerializer as ObservedRecursiveSerializer) ||
    (record.basxmlDisabledSerializer !== "classic-xrfc" &&
      record.basxmlDisabledSerializer !== "unsupported")
  ) {
    return fail("observation");
  }
  return Object.freeze({
    defaultSerializer: record.defaultSerializer as ObservedRecursiveSerializer,
    basxmlDisabledSerializer: record.basxmlDisabledSerializer as
      "classic-xrfc" | "unsupported",
  });
}

/** Capture an immutable live policy before session setup performs any I/O. */
export function snapshotLiveRecursiveSerializerPolicy(
  value: LiveRecursiveSerializerPolicy,
): LiveRecursiveSerializerPolicy {
  const record = plainRecord(value, "live-policy");
  if (
    Reflect.ownKeys(record).length !== 2 ||
    !Object.hasOwn(record, "profile") ||
    !Object.hasOwn(record, "observation") ||
    record.profile === "offline" ||
    !PROFILES.has(record.profile as RecursiveSerializerProfile)
  ) {
    return fail("live-policy");
  }
  const observation = snapshotObservation(
    record.observation as RecursiveSerializerObservation,
  );
  if (observation === undefined) return fail("live-policy");
  return Object.freeze({
    profile: record.profile as LiveRecursiveSerializerProfile,
    observation,
  });
}

/** Create one immutable synchronous provider from a captured observation. */
export function createLiveRecursiveSerializerDecisionProvider(
  policy: LiveRecursiveSerializerPolicy,
): RecursiveSerializerDecisionProvider {
  const captured = snapshotLiveRecursiveSerializerPolicy(policy);
  return Object.freeze((request: RecursiveSerializerDecisionRequest) => {
    const record = plainRecord(request, "decision-request");
    return classifyRecursiveSerializer({
      profile: captured.profile,
      observation: captured.observation,
      graph: record.graph as RecursiveMetadataGraph,
      parameters:
        record.parameters as readonly RecursiveClassicXrfcParameterIdentity[],
    });
  });
}

/**
 * Convert an explicit live policy into the one graph-bound send decision. A
 * basXML-required decision is an error here because the direct session cannot
 * silently substitute that serializer.
 */
export function admitLiveRecursiveSerializer(
  policy: LiveRecursiveSerializerPolicy | undefined,
  graph: RecursiveMetadataGraph,
  parameters: readonly RecursiveClassicXrfcParameterIdentity[],
): RecursiveSerializerClassification {
  if (policy === undefined) return fail("live-policy-required");
  const captured = snapshotLiveRecursiveSerializerPolicy(policy);
  const classification = classifyRecursiveSerializer({
    profile: captured.profile,
    graph,
    parameters,
    observation: captured.observation,
  });
  return assertRecursiveSerializerSendDecision(
    { graph, parameters },
    classification,
  );
}

/**
 * Validate that a classifier-produced decision authorizes this exact graph and
 * active parameter inventory. A JSON lookalike cannot authorize network I/O.
 */
export function assertRecursiveSerializerSendDecision(
  request: RecursiveSerializerDecisionRequest,
  decision: RecursiveSerializerClassification,
): RecursiveSerializerClassification {
  const captured = plainRecord(request, "decision-request");
  const graph = captured.graph as RecursiveMetadataGraph;
  if (!isNormalizedRecursiveMetadataGraph(graph)) return fail("untrusted-graph");
  const parameters = snapshotParameters(
    graph,
    captured.parameters as readonly RecursiveClassicXrfcParameterIdentity[],
  );
  if (
    typeof decision !== "object" ||
    decision === null ||
    !trustedClassifications.has(decision)
  ) {
    return fail("untrusted-decision");
  }
  if (decision.graphSha256 !== recursiveMetadataGraphSha256(graph)) {
    return fail("graph-mismatch");
  }
  const names = parameters
    .map((parameter) => parameter.parameterName)
    .sort();
  if (
    decision.parameterCount !== names.length ||
    decision.parameterNames.length !== names.length ||
    decision.parameterNames.some((name, index) => name !== names[index])
  ) {
    return fail("parameter-inventory-mismatch");
  }
  if (
    decision.remoteBasxmlSupported !==
      graph.functionIdentity?.remoteBasxmlSupported
  ) {
    return fail("graph-capability-mismatch");
  }
  if (decision.profile === "offline") return fail("offline-decision");
  if (
    decision.selectedSerializer === "basxml-required" ||
    decision.basxmlNegotiation === "required"
  ) {
    return fail("basxml-required");
  }
  if (
    decision.status !== "live" ||
    decision.selectedSerializer !== "classic-xrfc" ||
    decision.sendAllowed !== true ||
    decision.basxmlNegotiation !== "disabled"
  ) {
    return fail("live-decision-required");
  }
  return decision;
}

/**
 * Classify one deep-call graph without silently substituting serializers.
 * Offline classification proves only local classic-xRFC capability. A live
 * profile additionally requires the paired default/basXML-disabled observation.
 */
export function classifyRecursiveSerializer(
  request: RecursiveSerializerClassificationRequest,
): RecursiveSerializerClassification {
  const captured = plainRecord(request, "request");
  const profile = captured.profile as RecursiveSerializerProfile;
  if (!PROFILES.has(profile)) return fail("profile");
  const graph = captured.graph as RecursiveMetadataGraph;
  if (!isNormalizedRecursiveMetadataGraph(graph)) return fail("untrusted-graph");
  const parameters = snapshotParameters(
    graph,
    captured.parameters as readonly RecursiveClassicXrfcParameterIdentity[],
  );
  const observation = snapshotObservation(
    captured.observation as RecursiveSerializerObservation | undefined,
  );
  const base = {
    schemaVersion: 1 as const,
    profile,
    graphSha256: recursiveMetadataGraphSha256(graph),
    parameterCount: parameters.length,
    parameterNames: Object.freeze(
      parameters.map((parameter) => parameter.parameterName).sort(),
    ),
    remoteBasxmlSupported: graph.functionIdentity?.remoteBasxmlSupported,
  };

  if (profile === "offline") {
    if (observation !== undefined) return fail("offline-classification");
    return trustedClassification({
      ...base,
      selectedSerializer: "classic-xrfc",
      status: "offline",
      sendAllowed: true,
      basxmlNegotiation: "unknown",
    });
  }
  if (observation === undefined) return fail("live-classification-required");

  if (observation.basxmlDisabledSerializer === "classic-xrfc") {
    if (observation.defaultSerializer === "unsupported") {
      return fail("contradictory-classification");
    }
    return trustedClassification({
      ...base,
      selectedSerializer: "classic-xrfc",
      status: "live",
      sendAllowed: true,
      basxmlNegotiation: "disabled",
    });
  }

  if (observation.defaultSerializer !== "basxml") {
    return fail("contradictory-classification");
  }
  return trustedClassification({
    ...base,
    selectedSerializer: "basxml-required",
    status: "blocked",
    sendAllowed: false,
    basxmlNegotiation: "required",
  });
}
