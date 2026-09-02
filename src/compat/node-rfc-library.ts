import { types as nodeUtilTypes } from "node:util";

import { RFCError, RFCErrorCode } from "../client/rfc-errors.js";
import {
  projectNodeRfcNormalizationError,
  projectNodeRfcPublicError,
  type RfcObject,
} from "./node-rfc-client.js";
import {
  TransactionBapiError,
  TransactionRuntimeError,
  TransactionTerminalError,
} from "../lifecycle/transaction-runtime.js";
import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import {
  languageIsoToSap,
  languageSapToIso,
  type RfcConnectionParameters,
} from "./connection-parameters.js";
import {
  bindDirectCompatibilityOwnerFactory,
  productionDirectCompatibilityOwnerFactory,
} from "./direct-owner-factory.js";
import {
  bindRFCClientDestinationOwnerFactory,
  resolveRFCClientDestinationOwnerFactory,
  type RFCClientDestinationOwnerFactory,
} from "./rfc-client-owner-registry.js";
import { createDirectRfcSessionProvider } from "./direct-rfc-session-provider.js";
import { createMessageServerRfcSessionProvider } from "./message-server-rfc-session-provider.js";
import {
  assertConnectionRouteCapabilities,
  type ConnectionRoutePlan,
} from "./connection-route.js";
import {
  type RfcSession,
  type RfcSessionTransaction,
} from "./rfc-session-provider.js";
import { planRFCClientSessionRoute } from "./rfc-client-session-route.js";
import {
  bindRFCClientSessionProvider,
  resolveRFCClientSessionProvider,
} from "./rfc-session-provider-registry.js";
import {
  toModernRfcMetadata,
  toModernRfcMetadataFromRecursiveGraph,
  type ModernRfcMetadata,
} from "./modern-metadata.js";
import { MetadataAccessFailure } from "../metadata/repository-runtime.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import { snapshotRfcValue } from "../values/rfc-value-snapshot.js";
import {
  createLiveRecursiveSerializerDecisionProvider,
  snapshotLiveRecursiveSerializerPolicy,
  type LiveRecursiveSerializerPolicy,
} from "../values/recursive-serializer-classification.js";
import {
  createSapRouterDirectCpicTransportFactory,
} from "../transport/saprouter-ni.js";
import {
  createConnectivitySocks5DirectCpicTransportFactory,
} from "../transport/connectivity-socks5-ni.js";
import { NiTransportError } from "../transport/ni-socket.js";
import {
  snapshotRfcCallbackHandlers,
  type RfcCallbackHandlers,
} from "../protocol/rfc-callback.js";

export interface RFCInputParams {
  readonly import?: RfcObject;
  readonly changing?: RfcObject;
  readonly table?: RfcObject;
}

export interface RFCLogger {
  readonly log: (type: string, ...arguments_: readonly unknown[]) => void;
}

export interface RFCClientConfiguration {
  /** open-rfc extension: evidence-bound admission for recursive live sends. */
  readonly recursiveSerializerPolicy?: LiveRecursiveSerializerPolicy;
  /** open-rfc preview: raw synchronous DESTINATION 'BACK' handlers by FM name. */
  readonly callbacks?: RfcCallbackHandlers;
}

function snapshotRFCClientConfiguration(
  input: RFCClientConfiguration | undefined,
): RFCClientConfiguration | undefined {
  if (input === undefined) return undefined;
  plainRecord(input, "RFCClient configuration");
  for (const key of Reflect.ownKeys(input)) {
    if (key !== "recursiveSerializerPolicy" && key !== "callbacks") {
      throw new TypeError("unknown RFCClient configuration property");
    }
  }
  const recursiveDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "recursiveSerializerPolicy",
  );
  const callbacksDescriptor = Object.getOwnPropertyDescriptor(input, "callbacks");
  if (
    recursiveDescriptor !== undefined &&
    !("value" in recursiveDescriptor)
  ) {
    throw new TypeError(
      "RFCClient configuration recursiveSerializerPolicy must be an own data property",
    );
  }
  if (
    callbacksDescriptor !== undefined &&
    !("value" in callbacksDescriptor)
  ) {
    throw new TypeError(
      "RFCClient configuration callbacks must be an own data property",
    );
  }
  const recursiveSerializerPolicy = recursiveDescriptor?.value === undefined
    ? undefined
    : snapshotLiveRecursiveSerializerPolicy(
        recursiveDescriptor.value as LiveRecursiveSerializerPolicy,
      );
  const callbacks = callbacksDescriptor?.value === undefined
    ? undefined
    : Object.freeze(Object.fromEntries(
        snapshotRfcCallbackHandlers(
          callbacksDescriptor.value as RfcCallbackHandlers,
          "RFCClient configuration callbacks",
        )!,
      ));
  return Object.freeze({
    ...(recursiveSerializerPolicy === undefined
      ? {}
      : { recursiveSerializerPolicy }),
    ...(callbacks === undefined ? {} : { callbacks }),
  });
}

function plainRecord(value: unknown, path: string): object {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable === true) {
        throw new TypeError(`${path} must not contain enumerable symbol keys`);
      }
    }
  }
  return value;
}

function parameterGroup(
  input: RFCInputParams,
  name: keyof RFCInputParams,
): object {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (descriptor === undefined) return Object.freeze({});
  if (!("value" in descriptor)) {
    throw new TypeError(`RFC input ${name} must be an own data property`);
  }
  return plainRecord(descriptor.value ?? {}, `RFC input ${name}`);
}

type RFCInputGroupName = keyof RFCInputParams;

interface CapturedRFCInput {
  readonly parameters: RfcObject;
  readonly groups: Readonly<Record<RFCInputGroupName, readonly string[]>>;
}

function captureRFCInput(input: RFCInputParams): CapturedRFCInput {
  plainRecord(input, "RFC execute input");
  for (const key of Object.keys(input)) {
    if (key !== "import" && key !== "changing" && key !== "table") {
      throw new Error(`unknown RFC input group ${key}`);
    }
  }
  const result: Record<string, unknown> = {};
  const groups: Record<RFCInputGroupName, string[]> = {
    import: [],
    changing: [],
    table: [],
  };
  for (const groupName of ["import", "changing", "table"] as const) {
    const group = parameterGroup(input, groupName);
    for (const name of Object.keys(group)) {
      const descriptor = Object.getOwnPropertyDescriptor(group, name);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(
          `RFC input ${groupName}.${name} must be an own data property`,
        );
      }
      if (Object.hasOwn(result, name)) {
        throw new Error(`RFC parameter ${name} occurs in multiple groups`);
      }
      groups[groupName].push(name);
      Object.defineProperty(result, name, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return Object.freeze({
    parameters: snapshotRfcValue(result, "RFC input") as RfcObject,
    groups: Object.freeze({
      import: Object.freeze(groups.import),
      changing: Object.freeze(groups.changing),
      table: Object.freeze(groups.table),
    }),
  });
}

/** Flatten the direction-aware modern input without allowing ambiguous keys. */
export function flattenRFCInput(input: RFCInputParams): RfcObject {
  return captureRFCInput(input).parameters;
}

type BoundLogger = (type: string, message: string) => void;
const MODERN_OPERATION_TIMEOUT_MS = 45_000;
const MODERN_APPLICATION_POOL = Object.freeze({
  maxConnections: 1,
  maxWaiters: 1,
  lowWater: 0,
  idleHigh: 1,
});
const createProductionOwner = bindDirectCompatibilityOwnerFactory(
  productionDirectCompatibilityOwnerFactory,
);
const productionOwnerFactory: RFCClientDestinationOwnerFactory = (
  connection,
  context,
) =>
  createProductionOwner({
    connection,
    applicationPool: MODERN_APPLICATION_POOL,
    session: context?.session,
  });
interface TransactionCycle {
  readonly transaction: RfcSessionTransaction;
  readonly ready: Promise<TransactionCycle>;
  opened: boolean;
}

interface RFCConnectionBootstrap {
  readonly token: typeof RFC_CONNECTION_BOOTSTRAP;
  readonly session: RfcSession;
  readonly cycle: TransactionCycle;
}

interface ActiveSessionOperation {
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  abort(reason: unknown): void;
  finish(): void;
}

type RFCConnectionState = "open" | "closing" | "failed" | "closed";
const RFC_CONNECTION_BOOTSTRAP = Symbol("open-rfc RFCConnection bootstrap");
const RECURSIVE_METADATA_NOT_LOADED = Symbol(
  "open-rfc recursive metadata not loaded",
);

function bindLogger(logger: RFCLogger | undefined): BoundLogger | undefined {
  if (logger === undefined) return undefined;
  if (typeof logger !== "object" || logger === null) {
    throw new TypeError("RFCClient logger must expose log(type, ...args)");
  }
  const log = logger.log;
  if (typeof log !== "function") {
    throw new TypeError("RFCClient logger must expose log(type, ...args)");
  }
  return (type, message) => {
    try {
      Reflect.apply(log, logger, [type, message]);
    } catch {
      // Diagnostics must not change RFC lifecycle ownership or outcomes.
    }
  };
}

function startTransactionCycle(session: RfcSession): TransactionCycle {
  const transaction = session.beginTransaction();
  const cycle = {
    transaction,
    ready: undefined as unknown as Promise<TransactionCycle>,
    opened: false,
  } as TransactionCycle;
  Object.defineProperty(cycle, "ready", {
    value: transaction.ready().then(() => {
      cycle.opened = true;
      return cycle;
    }),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return cycle;
}

function validateOpenSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("RFCClient.open signal must be an AbortSignal");
  }
}

function openCanceled(signal: AbortSignal): NiTransportError {
  return new NiTransportError(
    "NI_ABORTED",
    "RFC connection open was canceled",
    signal.reason,
  );
}

async function waitForTransactionCycle(
  cycle: TransactionCycle,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await cycle.ready;
    return;
  }
  if (signal.aborted) throw openCanceled(signal);
  let rejectAbort!: (error: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(openCanceled(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([cycle.ready, cancellation]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cycleTransaction(cycle: TransactionCycle): RfcSessionTransaction {
  if (!cycle.opened) {
    throw new Error("RFC transaction lease has not finished opening");
  }
  return cycle.transaction;
}

function snapshotExcludedOutput(
  input: readonly string[],
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError("excludeParamsFromOutput must be an array");
  }
  const names: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `excludeParamsFromOutput[${index}] must be an own data property`,
      );
    }
    if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      throw new TypeError(
        `excludeParamsFromOutput[${index}] must be a non-empty string`,
      );
    }
    names.push(descriptor.value);
  }
  return Object.freeze(names);
}

function modernFunctionName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 30 ||
    /[^\x20-\x7e]/u.test(value)
  ) {
    throw new RangeError("functionName must contain 1..30 ASCII bytes");
  }
  return value;
}

function validationError(message: string): NodeRFCLibraryError {
  return new NodeRFCLibraryError(
    message,
    NodeRFCLibraryErrorCode.INVALID_PARAMETER,
  );
}

function validateModernInput(
  metadata: RfcFunctionInterface,
  input: CapturedRFCInput,
  excluded: readonly string[],
): void {
  const parameters = new Map(
    metadata.parameters.map((parameter) => [
      parameter.parameterName,
      parameter,
    ]),
  );
  const expectedClasses: Readonly<Record<RFCInputGroupName, string>> = {
    import: "I",
    changing: "C",
    table: "T",
  };

  for (const groupName of ["import", "changing", "table"] as const) {
    for (const name of input.groups[groupName]) {
      const parameter = parameters.get(name);
      if (parameter === undefined) {
        throw validationError(`RFC parameter '${name}' was not found`);
      }
      if (parameter.parameterClass !== expectedClasses[groupName]) {
        throw validationError(
          `RFC parameter '${name}' does not belong to the ${groupName} group`,
        );
      }
    }
  }

  const deactivated = new Set<string>();
  for (const name of excluded) {
    const parameter = parameters.get(name);
    if (parameter === undefined) {
      throw validationError(`excluded RFC parameter '${name}' was not found`);
    }
    if (parameter.parameterClass === "I") {
      throw validationError(
        `import RFC parameter '${name}' cannot be excluded from output`,
      );
    }
    deactivated.add(name);
  }

  for (const parameter of metadata.parameters) {
    const groupName = parameter.parameterClass === "I"
      ? "import"
      : parameter.parameterClass === "C"
        ? "changing"
        : parameter.parameterClass === "T"
          ? "table"
          : undefined;
    if (
      groupName !== undefined &&
      parameter.optional === false &&
      !deactivated.has(parameter.parameterName) &&
      !input.groups[groupName].includes(parameter.parameterName)
    ) {
      throw validationError(
        `mandatory RFC parameter '${parameter.parameterName}' is missing`,
      );
    }
  }
}

function defineErrorCause(error: Error, cause: unknown): void {
  Object.defineProperty(error, "cause", {
    value: cause,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function projectModernPublicErrorGraph(
  error: unknown,
  projectedObjects: WeakMap<object, unknown>,
): unknown {
  if (typeof error === "object" && error !== null) {
    const projected = projectedObjects.get(error);
    if (projected !== undefined) return projected;
  }
  if (error instanceof TransactionBapiError) {
    const projected = new NodeRFCLibraryError(
      error.message,
      NodeRFCLibraryErrorCode.UNKNOW_ERROR,
    );
    projectedObjects.set(error, projected);
    return projected;
  }
  if (error instanceof TransactionTerminalError) {
    const projected = new NodeRFCLibraryError(
      error.message,
      NodeRFCLibraryErrorCode.UNKNOW_ERROR,
    );
    projectedObjects.set(error, projected);
    const failures = Object.freeze(error.errors.map((failure) =>
      projectModernPublicErrorGraph(failure, projectedObjects)
    ));
    const aggregate = failures.length === 0
      ? new AggregateError(failures, error.message)
      : new AggregateError(failures, error.message, { cause: failures[0] });
    defineErrorCause(projected, aggregate);
    return projected;
  }
  if (error instanceof TransactionRuntimeError) {
    if (error.code === "OPERATION_TIMEOUT") {
      const projected = new RFCError(error.message, {
        name: "RfcLibError",
        group: 4,
        code: RFCErrorCode.RFC_TIMEOUT,
        codeString: "RFC_TIMEOUT",
        key: "RFC_TIMEOUT",
      });
      projectedObjects.set(error, projected);
      return projected;
    }
    const invalidRequest =
      error.code === "INVALID_TRANSACTION_TOKEN" ||
      error.code === "INVALID_TRANSACTION_STATE" ||
      error.code === "TRANSACTION_CLOSING" ||
      error.code === "CONCURRENT_TRANSACTION_OPERATION";
    const projected = new NodeRFCLibraryError(
      error.message,
      invalidRequest
        ? NodeRFCLibraryErrorCode.INVALID_PARAMETER
        : NodeRFCLibraryErrorCode.UNKNOW_ERROR,
    );
    projectedObjects.set(error, projected);
    return projected;
  }
  if (error instanceof AggregateError) {
    const projected = new AggregateError([], error.message);
    projectedObjects.set(error, projected);
    const failures = Object.freeze(error.errors.map((failure) =>
      projectModernPublicErrorGraph(failure, projectedObjects)
    ));
    Object.defineProperty(projected, "errors", {
      value: failures,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const cause = Object.getOwnPropertyDescriptor(error, "cause");
    if (cause !== undefined && "value" in cause) {
      defineErrorCause(
        projected,
        projectModernPublicErrorGraph(cause.value, projectedObjects),
      );
    }
    return projected;
  }
  const projected = projectNodeRfcPublicError(error);
  if (typeof error === "object" && error !== null) {
    projectedObjects.set(error, projected);
  }
  return projected;
}

function projectModernPublicError(error: unknown): unknown {
  return projectModernPublicErrorGraph(error, new WeakMap());
}

function allowsRecursiveMetadataFlatFallback(error: unknown): boolean {
  return error instanceof MetadataAccessFailure &&
    (error.classification === "unavailable" ||
      error.classification === "authorization");
}

function omitOutput(
  result: Readonly<Record<string, unknown>>,
  excluded: readonly string[],
): RfcObject {
  if (excluded.length === 0) return result;
  const omitted = new Set(excluded);
  const output: Record<string, unknown> = {};
  for (const name of Object.keys(result)) {
    if (!omitted.has(name)) {
      Object.defineProperty(output, name, {
        value: result[name],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return output;
}

function activeSessionOperation(): ActiveSessionOperation {
  const controller = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return Object.freeze({
    signal: controller.signal,
    done,
    abort: (reason: unknown) => controller.abort(reason),
    finish,
  });
}

export class RFCConnection {
  readonly #session: RfcSession;
  readonly #connectionInfoValue: Readonly<Record<string, string>>;
  readonly #activeSessionOperations = new Set<ActiveSessionOperation>();
  #cycle: TransactionCycle | undefined;
  #activeExecute: ActiveSessionOperation | undefined;
  #state: RFCConnectionState = "open";
  #closePromise: Promise<void> | undefined;

  /** Connections are created by RFCClient.open(); direct construction is invalid. */
  constructor(_notConstructible: never);
  constructor(bootstrap?: RFCConnectionBootstrap) {
    if (bootstrap?.token !== RFC_CONNECTION_BOOTSTRAP) {
      throw new NodeRFCLibraryError(
        "RFCConnection instances must be created with RFCClient.open()",
        NodeRFCLibraryErrorCode.INVALID_PARAMETER,
      );
    }
    this.#session = bootstrap.session;
    this.#connectionInfoValue = bootstrap.session.connectionInfo;
    this.#cycle = bootstrap.cycle;
  }

  get alive(): boolean { return this.#state === "open"; }
  get connectionInfo(): Readonly<Record<string, string>> | Error {
    return this.alive
      ? this.#connectionInfoValue
      : new Error("RFC connection is closed");
  }

  async execute(
    functionName: string,
    input: RFCInputParams = {},
    _enableValidation = true,
    excludeParamsFromOutput: readonly string[] = [],
  ): Promise<RfcObject> {
    this.#requireOpen("execute");
    const admission = this.#claimExecute();
    try {
      if (typeof _enableValidation !== "boolean") {
        throw new TypeError("enableValidation must be a boolean");
      }
      const admittedFunctionName = modernFunctionName(functionName);
      const excluded = snapshotExcludedOutput(excludeParamsFromOutput);
      const capturedInput = captureRFCInput(input);
      if (_enableValidation) {
        try {
          const metadata = await this.#session.getFunctionInterface(
            admittedFunctionName,
            admission.signal,
          );
          validateModernInput(metadata, capturedInput, excluded);
        } catch (error) {
          throw projectModernPublicError(error);
        }
      }
      const parameters = capturedInput.parameters;
      const ready = this.#readyCycle("execute");
      if (ready !== undefined) {
        return await this.#executeCycle(
          ready,
          admittedFunctionName,
          parameters,
          excluded,
        );
      }
      const cycle = await this.#ensureCycle("execute");
      return await this.#executeCycle(
        cycle,
        admittedFunctionName,
        parameters,
        excluded,
      );
    } finally {
      if (this.#activeExecute === admission) this.#activeExecute = undefined;
      this.#finishSessionOperation(admission);
    }
  }

  async #executeCycle(
    cycle: TransactionCycle,
    functionName: string,
    parameters: RfcObject,
    excluded: readonly string[],
  ): Promise<RfcObject> {
    try {
      const result = await cycleTransaction(cycle).call(
        functionName,
        parameters,
        { notRequested: excluded },
      );
      return omitOutput(result, excluded);
    } catch (error) {
      this.#observeCycleFailure(cycle);
      if (this.#state === "closing" || this.#state === "closed") {
        throw new Error(
          "RFC transaction is closing after its active call was canceled",
          { cause: projectModernPublicError(error) },
        );
      }
      throw projectModernPublicError(error);
    }
  }

  async getMetadata(functionName: string): Promise<ModernRfcMetadata> {
    this.#requireOpen("get metadata");
    const admittedFunctionName = modernFunctionName(functionName);
    const operation = this.#claimSessionOperation();
    try {
      const recursiveMetadata = this.#session.getRecursiveFunctionMetadata;
      if (recursiveMetadata !== undefined) {
        let recursiveGraph:
          | RecursiveMetadataGraph
          | typeof RECURSIVE_METADATA_NOT_LOADED =
          RECURSIVE_METADATA_NOT_LOADED;
        try {
          recursiveGraph = await Reflect.apply(recursiveMetadata, this.#session, [
            admittedFunctionName,
            operation.signal,
          ]);
        } catch (error) {
          if (!allowsRecursiveMetadataFlatFallback(error)) throw error;
        }
        if (recursiveGraph !== RECURSIVE_METADATA_NOT_LOADED) {
          operation.signal.throwIfAborted();
          return toModernRfcMetadataFromRecursiveGraph(recursiveGraph);
        }
      }
      const metadata = await this.#session.getFunctionInterface(
        admittedFunctionName,
        operation.signal,
      );
      operation.signal.throwIfAborted();
      const structures = new Map<string, RfcStructureDefinition>();
      for (const parameter of metadata.parameters) {
        if (parameter.exid !== "u") continue;
        if (parameter.tableName.length === 0) {
          throw new Error(`${parameter.parameterName} lacks its structure type name`);
        }
        if (!structures.has(parameter.tableName)) {
          structures.set(
            parameter.tableName,
            await this.#session.getStructureDefinition(
              parameter.tableName,
              operation.signal,
            ),
          );
          operation.signal.throwIfAborted();
        }
      }
      operation.signal.throwIfAborted();
      return toModernRfcMetadata(metadata, structures);
    } catch (error) {
      throw projectModernPublicError(error);
    } finally {
      this.#finishSessionOperation(operation);
    }
  }

  async commit(): Promise<void> {
    this.#requireOpen("commit");
    this.#requireExecuteIdle("commit");
    const ready = this.#readyCycle("commit");
    if (ready !== undefined) return this.#commitCycle(ready);
    const cycle = await this.#ensureCycle("commit");
    return this.#commitCycle(cycle);
  }

  async #commitCycle(cycle: TransactionCycle): Promise<void> {
    try {
      await cycleTransaction(cycle).commit();
      if (this.#cycle === cycle) this.#cycle = undefined;
    } catch (error) {
      this.#observeCycleFailure(cycle);
      throw projectModernPublicError(error);
    }
  }

  async rollback(): Promise<void> {
    this.#requireOpen("rollback");
    this.#requireExecuteIdle("rollback");
    const ready = this.#readyCycle("rollback");
    if (ready !== undefined) return this.#rollbackCycle(ready);
    const cycle = await this.#ensureCycle("rollback");
    return this.#rollbackCycle(cycle);
  }

  async #rollbackCycle(cycle: TransactionCycle): Promise<void> {
    try {
      await cycleTransaction(cycle).rollback();
      if (this.#cycle === cycle) this.#cycle = undefined;
    } catch (error) {
      this.#observeCycleFailure(cycle);
      throw projectModernPublicError(error);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    const cycle = this.#cycle;
    const activeSessionOperations = Object.freeze([
      ...this.#activeSessionOperations,
    ]);
    const cancellation = new Error(
      "RFC connection closed during an active owner operation",
    );
    for (const operation of activeSessionOperations) {
      operation.abort(cancellation);
    }
    const closing = this.#finishClose(
      cycle,
      activeSessionOperations.map((operation) => operation.done),
    );
    this.#closePromise = closing;
    return closing;
  }

  async #ensureCycle(operation: string): Promise<TransactionCycle> {
    this.#requireOpen(operation);
    const current = this.#cycle;
    if (current !== undefined) return current.ready;

    const cycle = startTransactionCycle(this.#session);
    this.#cycle = cycle;
    try {
      return await cycle.ready;
    } catch (error) {
      if (this.#cycle === cycle) this.#cycle = undefined;
      if (this.#state === "open") this.#state = "failed";
      throw projectModernPublicError(error);
    }
  }

  #readyCycle(operation: string): TransactionCycle | undefined {
    this.#requireOpen(operation);
    const current = this.#cycle;
    return current?.opened === true ? current : undefined;
  }

  #requireOpen(operation: string): void {
    if (this.#state !== "open") {
      throw new Error(
        `cannot ${operation} while RFC connection is ${this.#state}`,
      );
    }
  }

  #claimExecute(): ActiveSessionOperation {
    this.#requireExecuteIdle("execute");
    const admission = this.#claimSessionOperation();
    this.#activeExecute = admission;
    return admission;
  }

  #claimSessionOperation(): ActiveSessionOperation {
    const operation = activeSessionOperation();
    this.#activeSessionOperations.add(operation);
    return operation;
  }

  #finishSessionOperation(operation: ActiveSessionOperation): void {
    if (!this.#activeSessionOperations.delete(operation)) return;
    operation.finish();
  }

  #requireExecuteIdle(operation: string): void {
    if (this.#activeExecute !== undefined) {
      throw new NodeRFCLibraryError(
        `cannot ${operation} while an RFC execute operation is active`,
        NodeRFCLibraryErrorCode.INVALID_PARAMETER,
      );
    }
  }

  #observeCycleFailure(cycle: TransactionCycle): void {
    if (!cycleTransaction(cycle).isTerminal()) return;
    if (this.#cycle === cycle) this.#cycle = undefined;
    if (this.#state === "open") this.#state = "failed";
  }

  async #finishClose(
    cycle: TransactionCycle | undefined,
    activeSessionOperations: readonly Promise<void>[],
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (cycle !== undefined) await cycle.transaction.close();
    } catch (error) {
      failures.push(projectModernPublicError(error));
    }
    if (this.#cycle === cycle) this.#cycle = undefined;
    await Promise.all(activeSessionOperations);
    try {
      await this.#session.close();
    } catch (error) {
      failures.push(projectModernPublicError(error));
    }
    this.#state = failures.length === 0 ? "closed" : "failed";
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "RFC transaction close and destination retirement both failed",
        { cause: failures[0] },
      );
    }
  }
}

function createRFCConnection(bootstrap: RFCConnectionBootstrap): RFCConnection {
  return Reflect.construct(RFCConnection, [bootstrap]) as RFCConnection;
}

/** SDK-free compatibility entry point for @sap-rfc/node-rfc-library. */
export class RFCClient {
  readonly #logger: BoundLogger | undefined;

  constructor(
    logger?: RFCLogger,
    ...configurationArguments: [] | [RFCClientConfiguration]
  ) {
    this.#logger = bindLogger(logger);
    if (configurationArguments.length > 1) {
      throw new TypeError("RFCClient accepts at most one configuration argument");
    }
    const [configuration] = configurationArguments;
    const capturedConfiguration = snapshotRFCClientConfiguration(configuration);
    const recursiveSerializerPolicy =
      capturedConfiguration?.recursiveSerializerPolicy;
    const callbacks = capturedConfiguration?.callbacks;
    const ownerFactory: RFCClientDestinationOwnerFactory =
      recursiveSerializerPolicy === undefined && callbacks === undefined
        ? productionOwnerFactory
        : (connection, context) => createProductionOwner({
            connection,
            applicationPool: MODERN_APPLICATION_POOL,
            session: Object.freeze({
              ...(context?.session ?? {}),
              ...(callbacks === undefined ? {} : { callbacks }),
              ...(recursiveSerializerPolicy === undefined
                ? {}
                : {
                    recursiveSerializerDecisionProvider:
                      createLiveRecursiveSerializerDecisionProvider(
                        recursiveSerializerPolicy,
                      ),
                  }),
            }),
          });
    bindRFCClientDestinationOwnerFactory(this, ownerFactory);
    const directProvider = createDirectRfcSessionProvider({
      ownerFactory: (connection, context) => {
        const factory = resolveRFCClientDestinationOwnerFactory(
          this,
          ownerFactory,
        );
        return Reflect.apply(factory, undefined, [
          connection,
          context,
        ]);
      },
      operationTimeoutMs: MODERN_OPERATION_TIMEOUT_MS,
      sapRouterTransportFactory: createSapRouterDirectCpicTransportFactory,
      connectivitySocks5TransportFactory: (plan) =>
        createConnectivitySocks5DirectCpicTransportFactory({
          proxyHost: plan.host,
          proxyPort: plan.port,
          accessToken: plan.accessToken,
          ...(plan.locationId === undefined
            ? {}
            : { locationId: plan.locationId }),
        }),
    });
    bindRFCClientSessionProvider(
      this,
      createMessageServerRfcSessionProvider({
        directProvider,
        sapRouterTransportFactory: createSapRouterDirectCpicTransportFactory,
      }),
    );
  }

  async open(
    connectionParameters: RfcConnectionParameters,
    signal: AbortSignal | undefined = undefined,
  ): Promise<RFCConnection> {
    validateOpenSignal(signal);
    if (signal?.aborted === true) {
      throw projectModernPublicError(openCanceled(signal));
    }
    let plan: ConnectionRoutePlan;
    try {
      plan = planRFCClientSessionRoute(connectionParameters);
    } catch (error) {
      this.#logger?.("error", "open-rfc direct connection failed");
      throw projectNodeRfcNormalizationError(error);
    }

    const provider = resolveRFCClientSessionProvider(this);
    let session: RfcSession | undefined;
    let cycle: TransactionCycle | undefined;
    try {
      assertConnectionRouteCapabilities(plan, new Set(provider.capabilities));
      session = await provider.open(plan, signal);
      cycle = startTransactionCycle(session);
      await waitForTransactionCycle(cycle, signal);
      this.#logger?.(
        "debug",
        plan.route.kind === "direct"
          ? "open-rfc direct connection opened"
          : `open-rfc ${plan.route.kind} connection opened`,
      );
      return createRFCConnection({
        token: RFC_CONNECTION_BOOTSTRAP,
        session,
        cycle,
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (cycle !== undefined) {
        try {
          await cycle.transaction.close();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (session !== undefined) {
        try {
          await session.close();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      const propagated = cleanupFailures.length === 0
        ? error
        : new AggregateError(
          [error, ...cleanupFailures],
          "RFC connection open and session cleanup both failed",
          { cause: error },
        );
      this.#logger?.(
        "error",
        plan.route.kind === "direct"
          ? "open-rfc direct connection failed"
          : `open-rfc ${plan.route.kind} connection failed`,
      );
      throw projectModernPublicError(propagated);
    }
  }
}

export enum NodeRFCLibraryErrorCode {
  UNKNOW_ERROR = 0,
  INVALID_PARAMETER = 1,
}

export class NodeRFCLibraryError extends Error {
  readonly code: NodeRFCLibraryErrorCode;
  constructor(message: string, code = NodeRFCLibraryErrorCode.UNKNOW_ERROR) {
    super(message);
    this.name = "NodeRFCLibraryError";
    this.code = code;
  }
}

export class RFCUtilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RFCUtilityError";
  }
}

export class RFCUtility {
  static convertAbapTypeToJavaScriptType(abapType: string): string {
    if (typeof abapType !== "string" || abapType.length !== 1) {
      throw new RFCUtilityError("ABAP type must be one character");
    }
    if ("cndtgpae".includes(abapType)) return "string";
    if ("fibs8".includes(abapType)) return "number";
    if ("xy".includes(abapType)) return "Buffer";
    if ("uh".includes(abapType)) return "object";
    throw new RFCUtilityError(`Unsupported ABAP type ${abapType}`);
  }
}

export {
  RFCError,
  RFCErrorCode,
  languageIsoToSap,
  languageSapToIso,
};
