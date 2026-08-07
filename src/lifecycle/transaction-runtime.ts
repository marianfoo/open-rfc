import { snapshotRfcValue } from "../values/rfc-value-snapshot.js";

export type TransactionRuntimeState =
  | "idle"
  | "opening"
  | "active"
  | "calling"
  | "committing"
  | "rollingBack"
  | "resetting"
  | "releasing"
  | "closing"
  | "failed"
  | "closed";

export type TransactionOutcome =
  | "none"
  | "active"
  | "committed"
  | "rolledBack"
  | "rejected"
  | "ambiguous";

/** Identity for one SAP LUW. Object identity is part of validation. */
export interface TransactionToken {
  readonly runtimeId: number;
  readonly transactionId: number;
}

export type TransactionInvocationKind = "business" | "commit" | "rollback";

export interface TransactionInvocation {
  readonly kind: TransactionInvocationKind;
  readonly functionName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Output parameters deactivated for this business invocation. */
  readonly notRequested?: readonly string[];
}

export interface TransactionCallOptions {
  readonly notRequested?: readonly string[];
}

export interface TransactionAcquireContext {
  readonly token: TransactionToken;
  readonly signal: AbortSignal;
}

export interface TransactionOperationContext {
  readonly token: TransactionToken;
  readonly operation: TransactionInvocationKind | "reset" | "release";
  readonly signal: AbortSignal;
}

export type TransactionReleaseReason =
  | "commit"
  | "rollback"
  | "close-rollback"
  | "begin-rollback"
  | "ambiguous"
  | "control-rejected"
  | "reset-failed";

export interface TransactionReleaseDisposition {
  readonly reusable: boolean;
  readonly reason: TransactionReleaseReason;
  readonly outcome: TransactionOutcome;
}

/**
 * Transport seam for one exclusively pinned physical SAP session. Every
 * method is called at most once for a given state transition and receives a
 * finite-deadline AbortSignal.
 */
export interface TransactionLeaseAdapter<L extends object> {
  acquire(context: TransactionAcquireContext): L | PromiseLike<L>;
  invoke(
    lease: L,
    invocation: TransactionInvocation,
    context: TransactionOperationContext,
  ):
    | Readonly<Record<string, unknown>>
    | PromiseLike<Readonly<Record<string, unknown>>>;
  reset(
    lease: L,
    context: TransactionOperationContext,
  ): void | PromiseLike<void>;
  /**
   * A once-only ownership handoff. The adapter must retain responsibility for
   * eventual pool return/destruction once called, even if its returned Promise
   * rejects, it throws, or its signal expires. The implementation therefore
   * must claim ownership before any failure can escape. In particular, a
   * non-reusable handoff must serialize behind any adapter work whose earlier
   * signal was aborted; it must never blindly call a pool release while that
   * work still owns the physical resource.
   */
  release(
    lease: L,
    disposition: TransactionReleaseDisposition,
    context: TransactionOperationContext,
  ): void | PromiseLike<void>;
}

export interface TransactionScheduledTask {
  cancel(): void;
}

/** Deterministic monotonic boundary used for every adapter deadline. */
export interface TransactionScheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): TransactionScheduledTask;
}

export type TransactionFailureKind = "recoverable" | "ambiguous";

export interface TransactionFailureContext {
  readonly token: TransactionToken;
  readonly invocation: TransactionInvocation;
}

export interface TransactionRuntimeOptions<L extends object> {
  readonly leases: TransactionLeaseAdapter<L>;
  readonly operationTimeoutMs: number;
  readonly scheduler?: TransactionScheduler;
  /**
   * Classifies business-call failures only. Missing, invalid, or throwing
   * classifiers conservatively make the LUW ambiguous and non-reusable.
   * Return `recoverable` only when the adapter has proved that the RFC reply
   * was fully decoded and the physical session remains synchronized. RFC
   * communication/runtime/cancel failures and ABAP A/E/X message termination
   * are ambiguous here; a normal BAPI RETURN structure is not an exception.
   */
  readonly classifyFailure?: (
    failure: unknown,
    context: TransactionFailureContext,
  ) => TransactionFailureKind;
}

export type TransactionRuntimeErrorCode =
  | "INVALID_TRANSACTION_TOKEN"
  | "INVALID_TRANSACTION_STATE"
  | "TRANSACTION_CLOSING"
  | "CONCURRENT_TRANSACTION_OPERATION"
  | "OPERATION_TIMEOUT"
  | "INVALID_CONTROL_RESULT";

export class TransactionRuntimeError extends Error {
  readonly code: TransactionRuntimeErrorCode;

  constructor(code: TransactionRuntimeErrorCode, message: string) {
    super(message);
    this.name = "TransactionRuntimeError";
    this.code = code;
  }
}

export interface TransactionBapiReturn {
  readonly type: string;
  readonly id: string;
  readonly number: string;
  readonly message: string;
}

export class TransactionBapiError extends Error {
  readonly code = "BAPI_REJECTED" as const;
  readonly operation: "commit" | "rollback";
  readonly returns: readonly TransactionBapiReturn[];
  readonly outcome = "rejected" as const;

  constructor(
    operation: "commit" | "rollback",
    returns: readonly TransactionBapiReturn[],
  ) {
    const first = returns[0];
    super(
      first?.message.length
        ? `BAPI transaction ${operation} rejected: ${first.message}`
        : `BAPI transaction ${operation} rejected with message type ${first?.type ?? "?"}`,
    );
    this.name = "TransactionBapiError";
    this.operation = operation;
    this.returns = Object.freeze([...returns]);
  }
}

/** A terminal semantic outcome followed by one or more cleanup failures. */
export class TransactionTerminalError extends AggregateError {
  readonly code = "TRANSACTION_TERMINAL_FAILURE" as const;
  readonly outcome: Exclude<TransactionOutcome, "none" | "active">;

  constructor(
    outcome: Exclude<TransactionOutcome, "none" | "active">,
    errors: readonly unknown[],
    message: string,
  ) {
    super(errors, message, { cause: errors[0] });
    this.name = "TransactionTerminalError";
    this.outcome = outcome;
  }
}

export interface TransactionRuntimeMonitor {
  readonly runtimeId: number;
  readonly state: TransactionRuntimeState;
  readonly outcome: TransactionOutcome;
  readonly hasLease: boolean;
  readonly activeOperation: boolean;
  readonly beginCalls: number;
  readonly beginFailures: number;
  readonly businessCalls: number;
  readonly businessFailures: number;
  readonly commitCalls: number;
  readonly rollbackCalls: number;
  readonly closeCalls: number;
  readonly cancelCalls: number;
  readonly commitInvocations: number;
  readonly rollbackInvocations: number;
  readonly bapiRejections: number;
  readonly ambiguousFailures: number;
  readonly resetCalls: number;
  readonly resetFailures: number;
  /** Calls which transferred lease ownership to the release adapter. */
  readonly releaseAttempts: number;
  readonly releaseCompletions: number;
  readonly reusableReleaseAttempts: number;
  readonly evictionAttempts: number;
  readonly releaseFailures: number;
  /** Raw adapter operations still owning the published physical lease. */
  readonly quarantinedOperations: number;
  /** Timed-out acquires whose eventual lease/rejection is still being owned. */
  readonly quarantinedAcquires: number;
  readonly lateEvictionFailures: number;
  readonly boundaryTimeouts: number;
}

interface BoundLeaseAdapter<L extends object> {
  readonly acquire: (context: TransactionAcquireContext) => Promise<L>;
  readonly invoke: (
    lease: L,
    invocation: TransactionInvocation,
    context: TransactionOperationContext,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly reset: (
    lease: L,
    context: TransactionOperationContext,
  ) => Promise<void>;
  readonly release: (
    lease: L,
    disposition: TransactionReleaseDisposition,
    context: TransactionOperationContext,
  ) => Promise<void>;
}

interface BoundScheduler {
  readonly now: () => number;
  readonly schedule: (
    delayMs: number,
    callback: () => void,
  ) => TransactionScheduledTask;
}

interface MutableMonitor {
  beginCalls: number;
  beginFailures: number;
  businessCalls: number;
  businessFailures: number;
  commitCalls: number;
  rollbackCalls: number;
  closeCalls: number;
  cancelCalls: number;
  commitInvocations: number;
  rollbackInvocations: number;
  bapiRejections: number;
  ambiguousFailures: number;
  resetCalls: number;
  resetFailures: number;
  releaseAttempts: number;
  releaseCompletions: number;
  reusableReleaseAttempts: number;
  evictionAttempts: number;
  releaseFailures: number;
  lateEvictionFailures: number;
  boundaryTimeouts: number;
}

interface Completion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface BoundedOptions<T> {
  readonly abortOnClose: boolean;
  readonly onController?: (controller: AbortController) => void;
  readonly onLateFulfilled?: (value: T) => void | PromiseLike<void>;
  /** Includes settlement and any onLateFulfilled ownership cleanup. */
  readonly onDetached?: (settlement: Promise<void>) => void;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_EARLY_TIMER_REARMS = 64;
const safeApply = Reflect.apply;
const NO_FAILURE = Symbol("no transaction failure");
type NoFailure = typeof NO_FAILURE;

const COMMIT_INVOCATION: TransactionInvocation = Object.freeze({
  kind: "commit",
  functionName: "BAPI_TRANSACTION_COMMIT",
  parameters: Object.freeze({ WAIT: "X" }),
});

const ROLLBACK_INVOCATION: TransactionInvocation = Object.freeze({
  kind: "rollback",
  functionName: "BAPI_TRANSACTION_ROLLBACK",
  parameters: Object.freeze({}),
});

const defaultScheduler: TransactionScheduler = Object.freeze({
  now: () => performance.now(),
  schedule(delayMs: number, callback: () => void): TransactionScheduledTask {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  },
});

function runtimeError(
  code: TransactionRuntimeErrorCode,
  message: string,
): TransactionRuntimeError {
  return new TransactionRuntimeError(code, message);
}

function callable(value: unknown, path: string): Function {
  if (typeof value !== "function") throw new TypeError(`${path} must be a function`);
  return value;
}

function finiteTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(
      `operationTimeoutMs must be finite and in 1..${MAX_TIMER_MS}`,
    );
  }
  return value;
}

function bindAdapter<L extends object>(
  adapter: TransactionLeaseAdapter<L>,
): BoundLeaseAdapter<L> {
  if (
    (typeof adapter !== "object" && typeof adapter !== "function") ||
    adapter === null
  ) {
    throw new TypeError("transaction lease adapter must be an object");
  }
  const acquire = callable(adapter.acquire, "leases.acquire");
  const invoke = callable(adapter.invoke, "leases.invoke");
  const reset = callable(adapter.reset, "leases.reset");
  const release = callable(adapter.release, "leases.release");
  return Object.freeze({
    acquire: (context: TransactionAcquireContext): Promise<L> =>
      Promise.resolve(safeApply(acquire, adapter, [context])),
    invoke: (
      lease: L,
      invocation: TransactionInvocation,
      context: TransactionOperationContext,
    ): Promise<Readonly<Record<string, unknown>>> =>
      Promise.resolve(safeApply(invoke, adapter, [lease, invocation, context])),
    reset: (lease: L, context: TransactionOperationContext): Promise<void> =>
      Promise.resolve(safeApply(reset, adapter, [lease, context])),
    release: (
      lease: L,
      disposition: TransactionReleaseDisposition,
      context: TransactionOperationContext,
    ): Promise<void> =>
      Promise.resolve(
        safeApply(release, adapter, [lease, disposition, context]),
      ),
  });
}

function bindScheduler(scheduler: TransactionScheduler): BoundScheduler {
  if (
    (typeof scheduler !== "object" && typeof scheduler !== "function") ||
    scheduler === null
  ) {
    throw new TypeError("scheduler requires now and schedule");
  }
  const now = callable(scheduler.now, "scheduler.now");
  const schedule = callable(scheduler.schedule, "scheduler.schedule");
  return Object.freeze({
    now: (): number => safeApply(now, scheduler, []),
    schedule: (delayMs: number, callback: () => void) =>
      safeApply(schedule, scheduler, [delayMs, callback]),
  });
}

function bindTask(task: TransactionScheduledTask): TransactionScheduledTask {
  if (
    (typeof task !== "object" && typeof task !== "function") ||
    task === null
  ) {
    throw new TypeError("scheduler must return a cancelable task");
  }
  const cancel = callable(task.cancel, "scheduled task cancel");
  return Object.freeze({ cancel: () => safeApply(cancel, task, []) });
}

function completion(): Completion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyMonitor(): MutableMonitor {
  return {
    beginCalls: 0,
    beginFailures: 0,
    businessCalls: 0,
    businessFailures: 0,
    commitCalls: 0,
    rollbackCalls: 0,
    closeCalls: 0,
    cancelCalls: 0,
    commitInvocations: 0,
    rollbackInvocations: 0,
    bapiRejections: 0,
    ambiguousFailures: 0,
    resetCalls: 0,
    resetFailures: 0,
    releaseAttempts: 0,
    releaseCompletions: 0,
    reusableReleaseAttempts: 0,
    evictionAttempts: 0,
    releaseFailures: 0,
    lateEvictionFailures: 0,
    boundaryTimeouts: 0,
  };
}

function controlledFunctionName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 30 ||
    /[^\x20-\x7e]/u.test(value)
  ) {
    throw new RangeError(
      "functionName must contain 1..30 ASCII bytes",
    );
  }
  return value;
}

function snapshotParameters(
  parameters: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new TypeError("transaction call parameters must be an object");
  }
  return snapshotRfcValue(parameters, "transaction call parameters", {
    accessorPolicy: "readOnce",
  }) as Readonly<Record<string, unknown>>;
}

function snapshotCallOptions(
  options: TransactionCallOptions,
): Readonly<{ readonly notRequested?: readonly string[] }> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("transaction call options must be an object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "notRequested");
  if (descriptor === undefined) return Object.freeze({});
  if (!("value" in descriptor)) {
    throw new TypeError("transaction call options.notRequested must be an own data property");
  }
  const input = descriptor.value;
  if (!Array.isArray(input)) {
    throw new TypeError("transaction call options.notRequested must be an array");
  }
  const names: string[] = [];
  for (const [index, name] of input.entries()) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(
        `transaction call options.notRequested[${index}] must be a non-empty string`,
      );
    }
    names.push(name);
  }
  return Object.freeze({ notRequested: Object.freeze(names) });
}

function resultObject(
  value: Readonly<Record<string, unknown>>,
  operation: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw runtimeError(
      "INVALID_CONTROL_RESULT",
      `${operation} must return an object`,
    );
  }
  return value;
}

function controlledReturnText(value: unknown, path: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw runtimeError("INVALID_CONTROL_RESULT", `${path} must be a string`);
  }
  return value.length <= 1024 ? value : value.slice(0, 1024);
}

function controlledReturnType(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw runtimeError("INVALID_CONTROL_RESULT", `${path} must be a string`);
  }
  const type = value.trim().toUpperCase();
  if (!/^(?:|A|E|I|S|W|X)$/u.test(type)) {
    throw runtimeError(
      "INVALID_CONTROL_RESULT",
      `${path} must be blank or one of A, E, I, S, W, X`,
    );
  }
  return type;
}

function inspectControlReturn(
  operation: "commit" | "rollback",
  result: Readonly<Record<string, unknown>>,
): void {
  const hasReturn = Object.hasOwn(result, "RETURN");
  if (!hasReturn) {
    throw runtimeError(
      "INVALID_CONTROL_RESULT",
      `BAPI_TRANSACTION_${operation === "commit" ? "COMMIT" : "ROLLBACK"} result must contain RETURN`,
    );
  }
  const raw = result.RETURN;
  const rows = Array.isArray(raw) ? raw : [raw];
  if (rows.length < 1) {
    throw runtimeError(
      "INVALID_CONTROL_RESULT",
      `${operation} RETURN must contain at least one structure`,
    );
  }
  const normalized: TransactionBapiReturn[] = [];
  for (const [index, row] of rows.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw runtimeError(
        "INVALID_CONTROL_RESULT",
        `${operation} RETURN[${index}] must be a structure`,
      );
    }
    const value = row as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(value, "TYPE")) {
      throw runtimeError(
        "INVALID_CONTROL_RESULT",
        `${operation} RETURN[${index}].TYPE is required`,
      );
    }
    const item: TransactionBapiReturn = Object.freeze({
      type: controlledReturnType(value.TYPE, `RETURN[${index}].TYPE`),
      id: controlledReturnText(value.ID, `RETURN[${index}].ID`),
      number: controlledReturnText(value.NUMBER, `RETURN[${index}].NUMBER`),
      message: controlledReturnText(value.MESSAGE, `RETURN[${index}].MESSAGE`),
    });
    normalized.push(item);
  }
  const failures = normalized.filter((item) => /^(?:A|E|X)$/u.test(item.type));
  if (failures.length > 0) throw new TransactionBapiError(operation, failures);
}

function raiseTerminalFailure(
  outcome: Exclude<TransactionOutcome, "none" | "active">,
  primary: unknown | NoFailure,
  cleanup: readonly unknown[],
  message: string,
): void {
  if (primary === NO_FAILURE && cleanup.length === 0) return;
  if (primary !== NO_FAILURE && cleanup.length === 0) throw primary;
  throw new TransactionTerminalError(
    outcome,
    primary === NO_FAILURE ? cleanup : [primary, ...cleanup],
    message,
  );
}

let nextRuntimeId = 1;

/**
 * One-shot BAPI LUW coordinator. It never retries an application or control
 * invocation and never transfers its physical lease before terminal cleanup.
 */
export class TransactionRuntime<L extends object> {
  readonly #runtimeId = nextRuntimeId++;
  readonly #leases: BoundLeaseAdapter<L>;
  readonly #operationTimeoutMs: number;
  readonly #scheduler: BoundScheduler;
  readonly #classifyFailure?: (
    failure: unknown,
    context: TransactionFailureContext,
  ) => TransactionFailureKind;
  readonly #classifierReceiver: object;
  readonly #monitor = emptyMonitor();
  readonly #abortOnClose = new Set<AbortController>();
  readonly #acquireQuarantines = new Set<Promise<void>>();
  #state: TransactionRuntimeState = "idle";
  #outcome: TransactionOutcome = "none";
  #nextTransactionId = 1;
  #token?: TransactionToken;
  #lease?: L;
  #openingDone?: Promise<void>;
  #resolveOpening?: () => void;
  #acquireQuarantineFailure: unknown | NoFailure = NO_FAILURE;
  #activeCallDone?: Promise<void>;
  #resolveActiveCall?: () => void;
  #activeCallDisposition?: "stable" | "ambiguous";
  #terminal?: Promise<void>;
  #resolveTerminal?: () => void;
  #rejectTerminal?: (error: unknown) => void;
  #releaseClaimed = false;
  #operationQuarantine?: Promise<void>;
  #lateRelease?: Promise<void>;
  #lastClockValue = 0;

  constructor(options: TransactionRuntimeOptions<L>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("transaction runtime options must be an object");
    }
    this.#leases = bindAdapter(options.leases);
    this.#operationTimeoutMs = finiteTimeout(options.operationTimeoutMs);
    this.#scheduler = bindScheduler(options.scheduler ?? defaultScheduler);
    const classifier = options.classifyFailure;
    if (classifier !== undefined && typeof classifier !== "function") {
      throw new TypeError("classifyFailure must be a function");
    }
    this.#classifyFailure = classifier;
    this.#classifierReceiver = options;
  }

  async begin(): Promise<TransactionToken> {
    this.#monitor.beginCalls += 1;
    if (this.#state !== "idle") {
      this.#monitor.beginFailures += 1;
      throw runtimeError(
        "INVALID_TRANSACTION_STATE",
        `cannot begin transaction while runtime is ${this.#state}`,
      );
    }
    this.#state = "opening";
    this.#acquireQuarantineFailure = NO_FAILURE;
    const token: TransactionToken = Object.freeze({
      runtimeId: this.#runtimeId,
      transactionId: this.#nextTransactionId++,
    });
    const opening = completion();
    this.#openingDone = opening.promise;
    this.#resolveOpening = opening.resolve;
    let acquired: L | undefined;
    try {
      acquired = await this.#bounded(
        "transaction lease acquire",
        (signal) => {
          const context: TransactionAcquireContext = Object.freeze({
            token,
            signal,
          });
          return this.#leases.acquire(context);
        },
        {
          abortOnClose: true,
          onLateFulfilled: (lateLease) =>
            this.#cleanupLateAcquire(lateLease, token),
          onDetached: (settlement) =>
            this.#trackAcquireQuarantine(settlement),
        },
      );
      if (typeof acquired !== "object" || acquired === null) {
        throw new TypeError("leases.acquire must resolve to an object lease");
      }
      if (this.#state !== "opening") {
        throw runtimeError(
          "TRANSACTION_CLOSING",
          "transaction closed while its lease was opening",
        );
      }
      this.#lease = acquired;
      this.#token = token;
      this.#state = "active";
      this.#outcome = "active";
      return token;
    } catch (error) {
      this.#monitor.beginFailures += 1;
      let propagated = error;
      if (acquired !== undefined && typeof acquired === "object" && acquired !== null) {
        try {
          await this.#releaseLease(
            acquired,
            token,
            false,
            "begin-rollback",
            "none",
            false,
          );
        } catch (cleanupError) {
          propagated = new AggregateError(
            [error, cleanupError],
            "transaction begin and lease rollback both failed",
            { cause: error },
          );
          if (this.#stateIs("closing")) {
            this.#acquireQuarantineFailure = propagated;
          }
        }
      }
      if (this.#state === "opening") {
        this.#state = this.#acquireQuarantines.size === 0 ? "idle" : "failed";
      }
      throw propagated;
    } finally {
      this.#resolveOpening?.();
      this.#resolveOpening = undefined;
    }
  }

  async call(
    token: TransactionToken,
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
    options: TransactionCallOptions = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#requireToken(token);
    if (this.#state === "calling") {
      throw runtimeError(
        "CONCURRENT_TRANSACTION_OPERATION",
        "transaction already has an active business call",
      );
    }
    this.#requireState("active", "call a business function");
    const callOptions = snapshotCallOptions(options);
    const invocation: TransactionInvocation = Object.freeze({
      kind: "business",
      functionName: controlledFunctionName(functionName),
      parameters: snapshotParameters(parameters),
      ...(callOptions.notRequested === undefined
        ? {}
        : { notRequested: callOptions.notRequested }),
    });
    // Parameter getters are caller code and may reenter commit/rollback/close.
    // Revalidate before claiming the single-flight operation.
    this.#requireState("active", "call a business function");
    const callDone = completion();
    this.#activeCallDone = callDone.promise;
    this.#resolveActiveCall = callDone.resolve;
    this.#activeCallDisposition = undefined;
    this.#state = "calling";
    this.#monitor.businessCalls += 1;

    try {
      const lease = this.#requireLease();
      const result = resultObject(
        await this.#bounded(
          `business call ${invocation.functionName}`,
          (signal) => {
            const context: TransactionOperationContext = Object.freeze({
              token,
              operation: "business",
              signal,
            });
            return this.#leases.invoke(lease, invocation, context);
          },
          {
            abortOnClose: true,
            onDetached: (settlement) =>
              this.#trackOperationQuarantine(settlement),
          },
        ),
        "business invocation",
      );
      if (this.#stateIs("closing")) {
        this.#activeCallDisposition = "stable";
        throw runtimeError(
          "TRANSACTION_CLOSING",
          "transaction closed while a business call was completing",
        );
      }
      this.#state = "active";
      return result;
    } catch (error) {
      this.#monitor.businessFailures += 1;
      if (this.#stateIs("closing")) {
        if (this.#activeCallDisposition === undefined) {
          this.#activeCallDisposition = "ambiguous";
          this.#monitor.ambiguousFailures += 1;
        }
        throw error;
      }

      let failure = error;
      let kind: TransactionFailureKind = "ambiguous";
      if (
        !(error instanceof TransactionRuntimeError) ||
        error.code !== "OPERATION_TIMEOUT"
      ) {
        try {
          kind = this.#classifyBusinessFailure(error, token, invocation);
        } catch (classificationError) {
          failure = new AggregateError(
            [error, classificationError],
            "business call and transaction failure classification both failed",
            { cause: error },
          );
          kind = "ambiguous";
        }
      }
      // A hostile classifier may have reentered close(). Its stable/ambiguous
      // result still decides whether close can issue a rollback safely.
      if (this.#stateIs("closing")) {
        this.#activeCallDisposition =
          kind === "recoverable" ? "stable" : "ambiguous";
        if (kind === "ambiguous") this.#monitor.ambiguousFailures += 1;
        throw failure;
      }
      if (kind === "recoverable") {
        this.#state = "active";
        throw failure;
      }

      this.#monitor.ambiguousFailures += 1;
      this.#outcome = "ambiguous";
      this.#state = "failed";
      const terminal = this.#claimTerminal(() =>
        this.#finishReleaseOnly(NO_FAILURE, "ambiguous", "ambiguous"),
      );
      try {
        await terminal;
      } catch (cleanupError) {
        const cleanup =
          cleanupError instanceof TransactionTerminalError
            ? cleanupError.errors
            : [cleanupError];
        throw new TransactionTerminalError(
          "ambiguous",
          [failure, ...cleanup],
          "ambiguous business call and lease eviction both failed",
        );
      }
      throw failure;
    } finally {
      this.#resolveActiveCall?.();
      this.#resolveActiveCall = undefined;
    }
  }

  commit(token: TransactionToken): Promise<void> {
    this.#monitor.commitCalls += 1;
    try {
      this.#requireToken(token);
      this.#requireState("active", "commit");
    } catch (error) {
      return Promise.reject(error);
    }
    this.#state = "committing";
    return this.#claimTerminal(() => this.#finishControl("commit", "commit"));
  }

  rollback(token: TransactionToken): Promise<void> {
    this.#monitor.rollbackCalls += 1;
    try {
      this.#requireToken(token);
      this.#requireState("active", "rollback");
    } catch (error) {
      return Promise.reject(error);
    }
    this.#state = "rollingBack";
    return this.#claimTerminal(() =>
      this.#finishControl("rollback", "rollback"),
    );
  }

  /** Explicit abort is a rollback while safe and a cancellation while active. */
  abort(token: TransactionToken): Promise<void> {
    try {
      this.#requireToken(token);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#state === "closing" && this.#terminal !== undefined) {
      return this.#terminal;
    }
    if (this.#state === "calling") return this.cancel(token);
    return this.rollback(token);
  }

  /**
   * Cancels an active call, waits for its bounded disposition, and never sends
   * rollback on an ambiguous session.
   */
  cancel(token: TransactionToken): Promise<void> {
    this.#monitor.cancelCalls += 1;
    try {
      this.#requireToken(token);
      this.#requireState("calling", "cancel");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#closeDuringCall("transaction call was canceled");
  }

  close(): Promise<void> {
    this.#monitor.closeCalls += 1;
    if (this.#terminal !== undefined) return this.#terminal;

    if (this.#state === "idle") {
      this.#state = "closed";
      const terminal = Promise.resolve();
      this.#terminal = terminal;
      return terminal;
    }
    if (this.#state === "opening") {
      this.#state = "closing";
      const terminal = this.#claimTerminal(() =>
        this.#finishCloseDuringOpening(),
      );
      this.#abortClosableWork(
        runtimeError("TRANSACTION_CLOSING", "transaction closed while opening"),
      );
      return terminal;
    }
    if (this.#state === "calling") {
      return this.#closeDuringCall("transaction closed during a business call");
    }
    if (this.#state === "active") {
      this.#state = "closing";
      return this.#claimTerminal(() =>
        this.#finishControl("rollback", "close-rollback"),
      );
    }
    if (this.#state === "closed") {
      const terminal = Promise.resolve();
      this.#terminal = terminal;
      return terminal;
    }
    if (
      this.#state === "failed" &&
      this.#token === undefined &&
      this.#terminal === undefined
    ) {
      this.#state = "closing";
      return this.#claimTerminal(() => this.#finishCloseDuringOpening());
    }
    return Promise.reject(
      runtimeError(
        "INVALID_TRANSACTION_STATE",
        `cannot close transaction while runtime is ${this.#state}`,
      ),
    );
  }

  /** Pool-facing release uses the same safe rollback/eviction policy as close. */
  release(): Promise<void> {
    return this.close();
  }

  monitor(): TransactionRuntimeMonitor {
    return Object.freeze({
      runtimeId: this.#runtimeId,
      state: this.#state,
      outcome: this.#outcome,
      hasLease: this.#lease !== undefined,
      activeOperation: this.#state === "calling",
      quarantinedOperations: this.#operationQuarantine === undefined ? 0 : 1,
      quarantinedAcquires: this.#acquireQuarantines.size,
      ...this.#monitor,
    });
  }

  #requireToken(token: TransactionToken): void {
    if (
      (typeof token !== "object" && typeof token !== "function") ||
      token === null ||
      token !== this.#token
    ) {
      throw runtimeError(
        "INVALID_TRANSACTION_TOKEN",
        "transaction token does not belong to this runtime",
      );
    }
  }

  #requireState(expected: TransactionRuntimeState, operation: string): void {
    if (this.#state !== expected) {
      const code = this.#state === "closing" || this.#state === "closed"
        ? "TRANSACTION_CLOSING"
        : "INVALID_TRANSACTION_STATE";
      throw runtimeError(
        code,
        `cannot ${operation} while transaction runtime is ${this.#state}`,
      );
    }
  }

  #stateIs(expected: TransactionRuntimeState): boolean {
    // External adapter/classifier/scheduler boundaries may synchronously
    // reenter and change state; this method deliberately prevents TypeScript
    // from treating a prior local assignment as an immutable narrowing.
    return this.#state === expected;
  }

  #requireLease(): L {
    if (this.#lease === undefined) {
      throw runtimeError(
        "INVALID_TRANSACTION_STATE",
        "transaction has no pinned lease",
      );
    }
    return this.#lease;
  }

  #classifyBusinessFailure(
    failure: unknown,
    token: TransactionToken,
    invocation: TransactionInvocation,
  ): TransactionFailureKind {
    const classifier = this.#classifyFailure;
    if (classifier === undefined) return "ambiguous";
    const context: TransactionFailureContext = Object.freeze({
      token,
      invocation,
    });
    const result = safeApply(classifier, this.#classifierReceiver, [
      failure,
      context,
    ]);
    if (result !== "recoverable" && result !== "ambiguous") {
      throw new TypeError(
        "classifyFailure must return recoverable or ambiguous",
      );
    }
    return result;
  }

  #claimTerminal(executor: () => Promise<void>): Promise<void> {
    if (this.#terminal !== undefined) return this.#terminal;
    const terminal = completion();
    this.#terminal = terminal.promise;
    this.#resolveTerminal = terminal.resolve;
    this.#rejectTerminal = terminal.reject;
    void executor().then(
      () => this.#settleTerminal(true),
      (error) => this.#settleTerminal(false, error),
    );
    return terminal.promise;
  }

  #settleTerminal(succeeded: boolean, error?: unknown): void {
    const resolve = this.#resolveTerminal;
    const reject = this.#rejectTerminal;
    this.#resolveTerminal = undefined;
    this.#rejectTerminal = undefined;
    if (succeeded) resolve?.();
    else reject?.(error);
  }

  #closeDuringCall(reason: string): Promise<void> {
    this.#state = "closing";
    const terminal = this.#claimTerminal(() => this.#finishCloseDuringCall());
    this.#abortClosableWork(
      runtimeError("TRANSACTION_CLOSING", reason),
    );
    return terminal;
  }

  async #finishCloseDuringOpening(): Promise<void> {
    await this.#openingDone;
    if (this.#acquireQuarantines.size > 0) {
      const pending = Promise.all([...this.#acquireQuarantines]).then(
        () => undefined,
      );
      try {
        await this.#bounded(
          "timed-out transaction acquire convergence",
          () => pending,
          { abortOnClose: false },
        );
      } catch (error) {
        this.#state = "failed";
        throw error;
      }
    }
    if (this.#acquireQuarantineFailure !== NO_FAILURE) {
      this.#state = "failed";
      throw this.#acquireQuarantineFailure;
    }
    this.#state = "closed";
  }

  async #finishCloseDuringCall(): Promise<void> {
    await this.#activeCallDone;
    if (this.#activeCallDisposition === "stable") {
      await this.#finishControl("rollback", "close-rollback");
      return;
    }
    if (this.#outcome !== "ambiguous") {
      this.#outcome = "ambiguous";
    }
    await this.#finishReleaseOnly(NO_FAILURE, "ambiguous", "ambiguous");
  }

  async #finishControl(
    operation: "commit" | "rollback",
    releaseReason: "commit" | "rollback" | "close-rollback",
  ): Promise<void> {
    const token = this.#token;
    const lease = this.#lease;
    if (token === undefined || lease === undefined) {
      throw runtimeError(
        "INVALID_TRANSACTION_STATE",
        `${operation} requires a pinned transaction lease`,
      );
    }
    this.#state = operation === "commit" ? "committing" : "rollingBack";
    const invocation = operation === "commit" ? COMMIT_INVOCATION : ROLLBACK_INVOCATION;
    if (operation === "commit") this.#monitor.commitInvocations += 1;
    else this.#monitor.rollbackInvocations += 1;

    let primary: unknown | NoFailure = NO_FAILURE;
    try {
      const result = resultObject(
        await this.#bounded(
          `BAPI transaction ${operation}`,
          (signal) => {
            const context: TransactionOperationContext = Object.freeze({
              token,
              operation,
              signal,
            });
            return this.#leases.invoke(lease, invocation, context);
          },
          {
            abortOnClose: false,
            onDetached: (settlement) =>
              this.#trackOperationQuarantine(settlement),
          },
        ),
        `BAPI transaction ${operation}`,
      );
      inspectControlReturn(operation, result);
    } catch (error) {
      primary = error;
    }

    if (primary !== NO_FAILURE) {
      if (primary instanceof TransactionBapiError) {
        this.#outcome = "rejected";
        this.#monitor.bapiRejections += 1;
        await this.#finishReleaseOnly(
          primary,
          "control-rejected",
          "rejected",
        );
        return;
      }
      this.#outcome = "ambiguous";
      this.#monitor.ambiguousFailures += 1;
      await this.#finishReleaseOnly(primary, "ambiguous", "ambiguous");
      return;
    }

    this.#outcome = operation === "commit" ? "committed" : "rolledBack";
    const cleanup: unknown[] = [];
    this.#state = "resetting";
    this.#monitor.resetCalls += 1;
    try {
      await this.#bounded(
        `transaction reset after ${operation}`,
        (signal) => {
          const context: TransactionOperationContext = Object.freeze({
            token,
            operation: "reset",
            signal,
          });
          return this.#leases.reset(lease, context);
        },
        {
          abortOnClose: false,
          onDetached: (settlement) =>
            this.#trackOperationQuarantine(settlement),
        },
      );
    } catch (error) {
      cleanup.push(error);
      this.#monitor.resetFailures += 1;
    }

    const convergenceFailure = await this.#prepareReleaseAfterQuarantine(
      cleanup.length === 0 ? releaseReason : "reset-failed",
      this.#outcome,
    );
    if (convergenceFailure !== NO_FAILURE) {
      cleanup.push(convergenceFailure);
      this.#state = "failed";
      raiseTerminalFailure(
        this.#outcome as "committed" | "rolledBack",
        NO_FAILURE,
        cleanup,
        `transaction ${operation} completed but its physical lease remains quarantined`,
      );
      return;
    }

    try {
      await this.#releasePublishedLease(
        cleanup.length === 0,
        cleanup.length === 0 ? releaseReason : "reset-failed",
        this.#outcome,
      );
    } catch (error) {
      cleanup.push(error);
    } finally {
      this.#finishClosed();
    }
    raiseTerminalFailure(
      this.#outcome as "committed" | "rolledBack",
      NO_FAILURE,
      cleanup,
      `transaction ${operation} completed but cleanup failed`,
    );
  }

  async #finishReleaseOnly(
    primary: unknown | NoFailure,
    reason: "ambiguous" | "control-rejected",
    outcome: "ambiguous" | "rejected",
  ): Promise<void> {
    const cleanup: unknown[] = [];
    const convergenceFailure = await this.#prepareReleaseAfterQuarantine(
      reason,
      outcome,
    );
    if (convergenceFailure !== NO_FAILURE) {
      cleanup.push(convergenceFailure);
      this.#state = "failed";
      raiseTerminalFailure(
        outcome,
        primary,
        cleanup,
        `transaction ended ${outcome} while its physical lease remains quarantined`,
      );
      return;
    }
    try {
      await this.#releasePublishedLease(false, reason, outcome);
    } catch (error) {
      cleanup.push(error);
    } finally {
      this.#finishClosed();
    }
    raiseTerminalFailure(
      outcome,
      primary,
      cleanup,
      `transaction ended ${outcome} and lease eviction failed`,
    );
  }

  async #releasePublishedLease(
    reusable: boolean,
    reason: TransactionReleaseReason,
    outcome: TransactionOutcome,
  ): Promise<void> {
    if (this.#releaseClaimed) return;
    this.#releaseClaimed = true;
    const token = this.#token;
    const lease = this.#lease;
    if (token === undefined || lease === undefined) return;
    this.#state = "releasing";
    await this.#releaseLease(
      lease,
      token,
      reusable,
      reason,
      outcome,
      true,
    );
  }

  async #releaseLease(
    lease: L,
    token: TransactionToken,
    reusable: boolean,
    reason: TransactionReleaseReason,
    outcome: TransactionOutcome,
    published: boolean,
  ): Promise<void> {
    const disposition: TransactionReleaseDisposition = Object.freeze({
      reusable,
      reason,
      outcome,
    });
    const releaseController = new AbortController();
    const context: TransactionOperationContext = Object.freeze({
      token,
      operation: "release",
      signal: releaseController.signal,
    });
    this.#monitor.releaseAttempts += 1;
    if (reusable) this.#monitor.reusableReleaseAttempts += 1;
    else this.#monitor.evictionAttempts += 1;
    let releaseWork: Promise<void>;
    let releaseWorkSettled = false;
    try {
      // Calling release is the ownership-transfer point. Do it before any
      // scheduler boundary which could fail or reenter, then bound only the
      // adapter's acknowledgement of that already-completed handoff.
      releaseWork = this.#leases.release(lease, disposition, context);
      // Observe the handed-off work before crossing that scheduler boundary.
      // Otherwise a scheduler setup failure could leave a later adapter
      // rejection unhandled even though ownership has already transferred.
      void safeApply(Promise.prototype.then, releaseWork, [
        () => {
          releaseWorkSettled = true;
        },
        () => {
          releaseWorkSettled = true;
        },
      ]);
    } catch (error) {
      if (!releaseController.signal.aborted) releaseController.abort(error);
      this.#monitor.releaseFailures += 1;
      if (published) this.#lease = undefined;
      throw error;
    }
    try {
      await this.#bounded(
        `transaction lease ${reusable ? "release" : "eviction"}`,
        (signal) => {
          if (signal.aborted) {
            releaseController.abort(signal.reason);
          } else {
            signal.addEventListener(
              "abort",
              () => releaseController.abort(signal.reason),
              { once: true },
            );
          }
          return releaseWork;
        },
        { abortOnClose: false },
      );
      this.#monitor.releaseCompletions += 1;
    } catch (error) {
      if (!releaseWorkSettled && !releaseController.signal.aborted) {
        releaseController.abort(error);
      }
      this.#monitor.releaseFailures += 1;
      throw error;
    } finally {
      if (published) this.#lease = undefined;
    }
  }

  #finishClosed(): void {
    this.#lease = undefined;
    this.#state = "closed";
  }

  async #cleanupLateAcquire(
    value: L,
    token: TransactionToken,
  ): Promise<void> {
    if (typeof value !== "object" || value === null) return;
    await this.#releaseLease(
      value,
      token,
      false,
      "begin-rollback",
      "none",
      false,
    );
  }

  #trackAcquireQuarantine(settlement: Promise<void>): void {
    this.#acquireQuarantines.add(settlement);
    void settlement.then(
      () => {
        this.#acquireQuarantines.delete(settlement);
        this.#settleAcquireQuarantineState();
      },
      (error) => {
        this.#acquireQuarantines.delete(settlement);
        this.#acquireQuarantineFailure = error;
        this.#monitor.lateEvictionFailures += 1;
        this.#settleAcquireQuarantineState();
      },
    );
  }

  #settleAcquireQuarantineState(): void {
    if (
      this.#acquireQuarantines.size !== 0 ||
      this.#token !== undefined ||
      this.#state !== "failed" ||
      this.#acquireQuarantineFailure !== NO_FAILURE
    ) {
      return;
    }
    this.#state = this.#terminal === undefined ? "idle" : "closed";
  }

  #trackOperationQuarantine(settlement: Promise<void>): void {
    const current = this.#operationQuarantine;
    this.#operationQuarantine = current === undefined
      ? settlement
      : Promise.all([current, settlement]).then(() => undefined);
  }

  async #prepareReleaseAfterQuarantine(
    reason: TransactionReleaseReason,
    outcome: TransactionOutcome,
  ): Promise<unknown | NoFailure> {
    const quarantine = this.#operationQuarantine;
    if (quarantine === undefined) return NO_FAILURE;
    try {
      await this.#bounded(
        "uncertain transaction operation convergence",
        () => quarantine,
        { abortOnClose: false },
      );
      if (this.#operationQuarantine === quarantine) {
        this.#operationQuarantine = undefined;
      }
      return NO_FAILURE;
    } catch (error) {
      this.#startLateRelease(quarantine, reason, outcome);
      return error;
    }
  }

  #startLateRelease(
    quarantine: Promise<void>,
    reason: TransactionReleaseReason,
    outcome: TransactionOutcome,
  ): void {
    if (this.#lateRelease !== undefined) return;
    const release = quarantine.then(async () => {
      if (this.#operationQuarantine === quarantine) {
        this.#operationQuarantine = undefined;
      }
      try {
        await this.#releasePublishedLease(false, reason, outcome);
      } catch {
        this.#monitor.lateEvictionFailures += 1;
      } finally {
        this.#finishClosed();
      }
    });
    this.#lateRelease = release;
    void release.catch(() => {
      // A detached settlement rejects only if its late ownership cleanup did.
      this.#monitor.lateEvictionFailures += 1;
      this.#state = "failed";
    });
  }

  #abortClosableWork(reason: unknown): void {
    for (const controller of [...this.#abortOnClose]) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  #readClock(): number {
    const value = this.#scheduler.now();
    if (!Number.isFinite(value) || value < this.#lastClockValue) {
      throw new Error(
        "transaction scheduler clock must be finite and monotonic",
      );
    }
    this.#lastClockValue = value;
    return value;
  }

  #bounded<T>(
    label: string,
    invoke: (signal: AbortSignal) => T | PromiseLike<T>,
    options: BoundedOptions<T>,
  ): Promise<T> {
    const controller = new AbortController();
    options.onController?.(controller);
    if (options.abortOnClose) this.#abortOnClose.add(controller);
    let deadline: number;
    try {
      deadline = this.#readClock() + this.#operationTimeoutMs;
      if (!Number.isFinite(deadline)) {
        throw new Error("transaction operation deadline must be finite");
      }
    } catch (error) {
      this.#abortOnClose.delete(controller);
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      let timer: TransactionScheduledTask | undefined;
      let timerGeneration = 0;
      let earlyRearms = 0;
      let work: Promise<T> | undefined;
      let workSettled = false;
      let detached: Completion | undefined;

      const finish = (
        ok: boolean,
        value: T | unknown,
        fromWork = false,
      ): void => {
        if (!active) return;
        const mustQuarantine =
          !fromWork && work !== undefined && !workSettled;
        active = false;
        if (mustQuarantine) {
          detached = completion();
          try {
            options.onDetached?.(detached.promise);
          } catch (error) {
            detached.reject(error);
            void detached.promise.catch(() => undefined);
          }
          if (!controller.signal.aborted) controller.abort(value);
        }
        timerGeneration += 1;
        const prior = timer;
        timer = undefined;
        try {
          prior?.cancel();
        } catch {
          // Timer cancellation cannot retain transaction ownership.
        }
        this.#abortOnClose.delete(controller);
        if (ok) resolve(value as T);
        else reject(value);
      };

      const expire = (): void => {
        const error = runtimeError(
          "OPERATION_TIMEOUT",
          `${label} exceeded ${this.#operationTimeoutMs}ms`,
        );
        this.#monitor.boundaryTimeouts += 1;
        finish(false, error);
      };

      const arm = (): void => {
        if (!active) return;
        const remaining = Math.max(0, deadline - this.#readClock());
        const generation = timerGeneration + 1;
        timerGeneration = generation;
        const scheduled = bindTask(
          this.#scheduler.schedule(remaining, () => {
            if (!active || timerGeneration !== generation) return;
            timer = undefined;
            let nextRemaining: number;
            try {
              nextRemaining = deadline - this.#readClock();
            } catch (error) {
              finish(false, error);
              return;
            }
            if (nextRemaining <= 0) {
              expire();
              return;
            }
            earlyRearms += 1;
            if (
              nextRemaining >= remaining ||
              earlyRearms > MAX_EARLY_TIMER_REARMS
            ) {
              finish(
                false,
                new Error(
                  "transaction scheduler fired early without bounded progress",
                ),
              );
              return;
            }
            const rearmGeneration = generation + 1;
            timerGeneration = rearmGeneration;
            queueMicrotask(() => {
              if (active && timerGeneration === rearmGeneration) {
                try {
                  arm();
                } catch (error) {
                  finish(false, error);
                }
              }
            });
          }),
        );
        if (!active || timerGeneration !== generation) {
          try {
            scheduled.cancel();
          } catch {
            // A synchronous scheduler callback left a stale task.
          }
          return;
        }
        timer = scheduled;
      };

      try {
        arm();
      } catch (error) {
        finish(false, error);
      }
      if (!active) return;
      // User-supplied clocks/schedulers may reenter close() synchronously.
      // Never cross the adapter boundary once that close has aborted this
      // operation, even if the scheduled deadline itself remains active.
      if (controller.signal.aborted) {
        finish(
          false,
          controller.signal.reason ??
            runtimeError("TRANSACTION_CLOSING", `${label} was aborted`),
        );
        return;
      }

      try {
        work = Promise.resolve(invoke(controller.signal));
      } catch (error) {
        finish(false, error);
        return;
      }
      void work.then(
        (value) => {
          workSettled = true;
          if (active) {
            finish(true, value, true);
          } else if (detached !== undefined) {
            try {
              Promise.resolve(options.onLateFulfilled?.(value)).then(
                detached.resolve,
                detached.reject,
              );
            } catch (error) {
              detached.reject(error);
            }
          }
        },
        (error) => {
          workSettled = true;
          if (active) finish(false, error, true);
          else detached?.resolve();
        },
      );
    });
  }
}
