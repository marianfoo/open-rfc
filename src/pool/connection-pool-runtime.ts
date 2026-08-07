import { randomUUID } from "node:crypto";

import {
  createDeferredRfcDiagnosticReporter,
  type RfcDiagnosticEmitter,
  type RfcDiagnosticReporter,
} from "../diagnostics/structured-diagnostics.js";

export type ConnectionPoolRuntimeState =
  | "open"
  | "retiring"
  | "closing"
  | "closed";

export type ConnectionPoolRuntimeErrorCode =
  | "POOL_CLOSED"
  | "POOL_OVERLOADED"
  | "ACQUIRE_TIMEOUT"
  | "ACQUIRE_ABORTED"
  | "WRONG_POOL"
  | "STALE_LEASE"
  | "DOUBLE_RELEASE"
  | "POOL_LEASE_BUSY"
  | "ACTIVE_LEASE"
  | "LIFECYCLE_TIMEOUT"
  | "POOL_SHUTDOWN_TIMEOUT";

export class ConnectionPoolRuntimeError extends Error {
  readonly code: ConnectionPoolRuntimeErrorCode;

  constructor(code: ConnectionPoolRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ConnectionPoolRuntimeError";
    this.code = code;
  }
}

export interface ConnectionPoolScheduledTask {
  cancel(): void;
}

/** A monotonic scheduling boundary which deterministic tests can replace. */
export interface ConnectionPoolScheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): ConnectionPoolScheduledTask;
}

export type ConnectionPoolLifecycleOperation =
  | "create"
  | "validate"
  | "reset"
  | "destroy";

export interface ConnectionPoolLifecycleContext {
  readonly signal: AbortSignal;
  readonly operation: ConnectionPoolLifecycleOperation;
  readonly operationId: number;
  readonly timeoutMs: number;
}

export interface ConnectionCreationContext
  extends ConnectionPoolLifecycleContext {
  readonly creationId: number;
}

export interface ConnectionPoolFactory<T extends object> {
  create(context: ConnectionCreationContext): T | PromiseLike<T>;
  /** Must stop touching the resource after `context.signal` aborts. */
  destroy(
    resource: T,
    context: ConnectionPoolLifecycleContext,
  ): void | PromiseLike<void>;
  /** Must stop touching the resource after `context.signal` aborts. */
  validate?(
    resource: T,
    context: ConnectionPoolLifecycleContext,
  ): boolean | PromiseLike<boolean>;
  /** Must stop touching the resource after `context.signal` aborts. */
  reset?(
    resource: T,
    context: ConnectionPoolLifecycleContext,
  ): void | PromiseLike<void>;
}

export interface ConnectionPoolRuntimeOptions<T extends object> {
  readonly factory: ConnectionPoolFactory<T>;
  /** Hard physical-capacity limit. This is deliberately not idleHigh. */
  readonly maxConnections: number;
  /** Maximum number of pending acquire requests, including the FIFO head. */
  readonly maxWaiters: number;
  readonly acquireTimeoutMs: number;
  /** Finite bound for create/validate/reset/destroy callbacks. */
  readonly lifecycleTimeoutMs?: number;
  /** Finite bound for close/retire convergence. */
  readonly shutdownTimeoutMs?: number;
  /** Dedicated monotonic scheduler for lifecycle and shutdown deadlines. */
  readonly lifecycleScheduler?: ConnectionPoolScheduler;
  /** Desired idle floor while the pool is open. */
  readonly lowWater?: number;
  /** Maximum number of recycled idle resources. */
  readonly idleHigh?: number;
  readonly validateOnCheckout?: boolean;
  readonly resetOnRelease?: boolean;
  readonly scheduler?: ConnectionPoolScheduler;
  /** Optional bounded structured diagnostics; never receives resources. */
  readonly diagnostics?: RfcDiagnosticEmitter;
}

export interface ConnectionPoolAcquireOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ConnectionPoolReleaseOptions {
  /** False marks a connection uncertain and evicts it without resetting it. */
  readonly reusable?: boolean;
  /**
   * Optional cap for this recycle handoff. It follows the physical resource
   * through checkout validation so a canceled waiter cannot return it above
   * the caller's retention limit.
   */
  readonly idleHigh?: number;
}

export interface ConnectionPoolShutdownOptions {
  readonly timeoutMs?: number;
}

interface CanonicalAcquireOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly initiallyAborted: boolean;
  readonly registerAbort?: (listener: () => void) => void;
  readonly unregisterAbort?: (listener: () => void) => void;
}

/**
 * An immutable ownership token. Physical resources are deliberately not
 * exposed; all use must pass through `withActiveLease()`.
 */
export interface ConnectionPoolLease<_T extends object> {
  readonly poolId: number;
  readonly generation: number;
}

export interface ConnectionPoolMonitor {
  readonly poolId: number;
  readonly state: ConnectionPoolRuntimeState;
  readonly maxConnections: number;
  readonly maxWaiters: number;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly lowWater: number;
  readonly idleHigh: number;
  /** Capacity slots in exactly one of the six physical states below. */
  readonly connections: number;
  readonly idle: number;
  readonly leased: number;
  readonly creating: number;
  readonly validating: number;
  readonly resetting: number;
  readonly closing: number;
  readonly waiting: number;
  readonly lastLeaseGeneration: number;
  readonly leasesIssued: number;
  readonly creationFailures: number;
  readonly creationAborts: number;
  readonly healthFailures: number;
  readonly resetFailures: number;
  readonly destroyFailures: number;
  readonly lifecycleTimeouts: number;
  readonly shutdownTimeouts: number;
  readonly failed: number;
}

type PhysicalState =
  | "idle"
  | "validating"
  | "leased"
  | "resetting"
  | "closing";

interface PhysicalConnection<T extends object> {
  readonly resource: T;
  state: PhysicalState;
  generation: number;
  recycleIdleHigh?: number;
  destroyPromise?: Promise<void>;
  destroyError?: unknown;
  lifecycle?: LifecycleHandle<unknown>;
}

interface Creation {
  readonly id: number;
  ownerWaiterId?: number;
  readonly controller: AbortController;
  lifecycle?: LifecycleHandle<unknown>;
  terminalError?: unknown;
  abortRequested: boolean;
}

interface RuntimeDeadline {
  readonly deadline: number;
  readonly onExpire: (error: unknown) => void;
  active: boolean;
  generation: number;
  earlyRearms: number;
  task?: ConnectionPoolScheduledTask;
}

interface LifecycleHandle<R> {
  readonly controller: AbortController;
  readonly result: Promise<R>;
  readonly raw: Promise<R>;
  readonly expired: boolean;
}

interface ValidationOutcome<T extends object> {
  readonly physical: PhysicalConnection<T>;
  readonly healthy: boolean;
  readonly error?: unknown;
}

interface Waiter<T extends object> {
  readonly id: number;
  readonly count: number;
  readonly signal?: AbortSignal;
  readonly unregisterAbort?: (listener: () => void) => void;
  readonly abortListener: () => void;
  readonly deadline: number;
  resolve(value: readonly ConnectionPoolLease<T>[]): void;
  reject(error: unknown): void;
  active: boolean;
  timeoutGeneration: number;
  earlyTimeoutRearms: number;
  timeoutTask?: ConnectionPoolScheduledTask;
}

interface LeaseRecord<T extends object> {
  readonly physical: PhysicalConnection<T>;
  readonly generation: number;
  active: boolean;
  activeOperations: number;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_EARLY_TIMEOUT_REARMS = 64;
const safeApply = Reflect.apply;

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

const defaultScheduler: ConnectionPoolScheduler = Object.freeze({
  now: () => performance.now(),
  schedule(delayMs: number, callback: () => void): ConnectionPoolScheduledTask {
    const handle = setTimeout(callback, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  },
});

function integer(
  value: number,
  minimum: number,
  maximum: number,
  path: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${path} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function timeout(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(`${path} must be finite and in 1..${MAX_TIMER_MS}`);
  }
  return value;
}

function booleanOption(
  value: boolean | undefined,
  fallback: boolean,
  path: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean`);
  }
  return value;
}

function canonicalAcquireOptions(
  options: ConnectionPoolAcquireOptions,
  defaultTimeoutMs: number,
): CanonicalAcquireOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("acquire options must be an object");
  }
  const signal = options.signal;
  const configuredTimeoutMs = options.timeoutMs;
  let initiallyAborted = false;
  let registerAbort: ((listener: () => void) => void) | undefined;
  let unregisterAbort: ((listener: () => void) => void) | undefined;
  if (signal !== undefined) {
    if (typeof signal !== "object" || signal === null) {
      throw new TypeError("acquire signal must be an AbortSignal");
    }
    const aborted = signal.aborted;
    const addEventListener = signal.addEventListener;
    const removeEventListener = signal.removeEventListener;
    if (
      typeof aborted !== "boolean" ||
      typeof addEventListener !== "function" ||
      typeof removeEventListener !== "function"
    ) {
      throw new TypeError("acquire signal must be an AbortSignal");
    }
    initiallyAborted = aborted;
    registerAbort = (listener) => {
      safeApply(addEventListener, signal, ["abort", listener, { once: true }]);
    };
    unregisterAbort = (listener) => {
      safeApply(removeEventListener, signal, ["abort", listener]);
    };
  }
  const timeoutMs = timeout(
    configuredTimeoutMs === undefined
      ? defaultTimeoutMs
      : configuredTimeoutMs,
    "acquire timeoutMs",
  );
  return Object.freeze({
    timeoutMs,
    signal,
    initiallyAborted,
    registerAbort,
    unregisterAbort,
  });
}

function bindScheduledTask(
  task: ConnectionPoolScheduledTask,
): ConnectionPoolScheduledTask {
  if (
    (typeof task !== "object" && typeof task !== "function") ||
    task === null
  ) {
    throw new TypeError("scheduler must return a cancelable task");
  }
  const cancelOperation = task.cancel;
  if (typeof cancelOperation !== "function") {
    throw new TypeError("scheduler must return a cancelable task");
  }
  return Object.freeze({
    cancel: () => safeApply(cancelOperation, task, []),
  });
}

function poolError(
  code: ConnectionPoolRuntimeErrorCode,
  message: string,
): ConnectionPoolRuntimeError {
  return new ConnectionPoolRuntimeError(code, message);
}

function creationError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("connection factory failed with a non-Error value", {
        cause: error,
      });
}

let nextPoolId = 1;

/**
 * A bounded generic connection pool state machine. It deliberately has no
 * compatibility-facade behavior; archived idle-high semantics can be adapted
 * without weakening the independent maxConnections limit.
 */
export class ConnectionPoolRuntime<T extends object> {
  readonly #poolId = nextPoolId++;
  readonly #factory: ConnectionPoolFactory<T>;
  readonly #scheduler: ConnectionPoolScheduler;
  readonly #lifecycleScheduler: ConnectionPoolScheduler;
  readonly #maxConnections: number;
  readonly #maxWaiters: number;
  readonly #acquireTimeoutMs: number;
  readonly #lifecycleTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #lowWater: number;
  readonly #idleHigh: number;
  readonly #validateOnCheckout: boolean;
  readonly #resetOnRelease: boolean;
  readonly #report: RfcDiagnosticReporter | undefined;

  readonly #records = new Set<PhysicalConnection<T>>();
  readonly #resourceRecords = new WeakMap<T, PhysicalConnection<T>>();
  readonly #idle: PhysicalConnection<T>[] = [];
  readonly #creating = new Map<number, Creation>();
  readonly #waiters: Waiter<T>[] = [];
  readonly #leased = new Map<ConnectionPoolLease<T>, LeaseRecord<T>>();
  readonly #knownLeases = new WeakMap<
    ConnectionPoolLease<T>,
    LeaseRecord<T>
  >();

  #state: ConnectionPoolRuntimeState = "open";
  #nextCreationId = 1;
  #nextWaiterId = 1;
  #nextOperationId = 1;
  #lastLeaseGeneration = 0;
  #lastClockValue = Number.NEGATIVE_INFINITY;
  #lastLifecycleClockValue = Number.NEGATIVE_INFINITY;
  #pumpScheduled = false;
  #dispatching = false;
  #pumpRequestedWhileDispatching = false;
  #lowWaterBlocked = false;
  #closePromise?: Promise<void>;
  #resolveClose?: () => void;
  #rejectClose?: (error: unknown) => void;
  #closeSettled = false;
  #shutdownDeadline?: RuntimeDeadline;

  #creationFailures = 0;
  #creationAborts = 0;
  #healthFailures = 0;
  #resetFailures = 0;
  #destroyFailures = 0;
  #lifecycleTimeouts = 0;
  #shutdownTimeouts = 0;

  constructor(options: ConnectionPoolRuntimeOptions<T>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("connection pool options must be an object");
    }
    const factory = options.factory;
    const maxConnections = options.maxConnections;
    const maxWaiters = options.maxWaiters;
    const acquireTimeoutMs = options.acquireTimeoutMs;
    const lifecycleTimeoutMs = options.lifecycleTimeoutMs;
    const shutdownTimeoutMs = options.shutdownTimeoutMs;
    const configuredLifecycleScheduler = options.lifecycleScheduler;
    const lowWater = options.lowWater;
    const idleHigh = options.idleHigh;
    const validateOnCheckout = options.validateOnCheckout;
    const resetOnRelease = options.resetOnRelease;
    const configuredScheduler = options.scheduler;
    const diagnostics = options.diagnostics;
    if (typeof factory !== "object" || factory === null) {
      throw new TypeError("connection pool factory must be an object");
    }
    const createOperation = factory.create;
    const destroyOperation = factory.destroy;
    const validateOperation = factory.validate;
    const resetOperation = factory.reset;
    if (
      typeof createOperation !== "function" ||
      typeof destroyOperation !== "function"
    ) {
      throw new TypeError("connection pool factory requires create and destroy");
    }
    if (
      validateOperation !== undefined &&
      typeof validateOperation !== "function"
    ) {
      throw new TypeError("factory.validate must be a function");
    }
    if (resetOperation !== undefined && typeof resetOperation !== "function") {
      throw new TypeError("factory.reset must be a function");
    }
    this.#maxConnections = integer(
      maxConnections,
      1,
      Number.MAX_SAFE_INTEGER,
      "maxConnections",
    );
    this.#maxWaiters = integer(
      maxWaiters,
      1,
      Number.MAX_SAFE_INTEGER,
      "maxWaiters",
    );
    this.#acquireTimeoutMs = timeout(
      acquireTimeoutMs,
      "acquireTimeoutMs",
    );
    this.#lifecycleTimeoutMs = timeout(
      lifecycleTimeoutMs === undefined
        ? this.#acquireTimeoutMs
        : lifecycleTimeoutMs,
      "lifecycleTimeoutMs",
    );
    this.#shutdownTimeoutMs = timeout(
      shutdownTimeoutMs === undefined
        ? this.#lifecycleTimeoutMs
        : shutdownTimeoutMs,
      "shutdownTimeoutMs",
    );
    this.#lowWater = integer(
      lowWater === undefined ? 0 : lowWater,
      0,
      this.#maxConnections,
      "lowWater",
    );
    this.#idleHigh = integer(
      idleHigh === undefined ? this.#maxConnections : idleHigh,
      0,
      this.#maxConnections,
      "idleHigh",
    );
    if (this.#lowWater > this.#idleHigh) {
      throw new RangeError("lowWater must not exceed idleHigh");
    }
    this.#validateOnCheckout = booleanOption(
      validateOnCheckout,
      false,
      "validateOnCheckout",
    );
    this.#resetOnRelease = booleanOption(
      resetOnRelease,
      false,
      "resetOnRelease",
    );
    this.#report = createDeferredRfcDiagnosticReporter(diagnostics);
    if (
      this.#validateOnCheckout &&
      validateOperation === undefined
    ) {
      throw new TypeError("validateOnCheckout requires factory.validate");
    }
    if (this.#resetOnRelease && resetOperation === undefined) {
      throw new TypeError("resetOnRelease requires factory.reset");
    }
    const create: ConnectionPoolFactory<T>["create"] = (context) =>
      safeApply(createOperation, factory, [context]);
    const destroy: ConnectionPoolFactory<T>["destroy"] = (resource, context) =>
      safeApply(destroyOperation, factory, [resource, context]);
    const validate: ConnectionPoolFactory<T>["validate"] =
      validateOperation === undefined
        ? undefined
        : (resource, context) =>
            safeApply(validateOperation, factory, [resource, context]);
    const reset: ConnectionPoolFactory<T>["reset"] =
      resetOperation === undefined
        ? undefined
        : (resource, context) =>
            safeApply(resetOperation, factory, [resource, context]);
    this.#factory = Object.freeze({ create, destroy, validate, reset });
    const scheduler =
      configuredScheduler === undefined
        ? defaultScheduler
        : configuredScheduler;
    if (
      (typeof scheduler !== "object" && typeof scheduler !== "function") ||
      scheduler === null
    ) {
      throw new TypeError("scheduler requires now and schedule");
    }
    const nowOperation = scheduler.now;
    const scheduleOperation = scheduler.schedule;
    if (
      typeof nowOperation !== "function" ||
      typeof scheduleOperation !== "function"
    ) {
      throw new TypeError("scheduler requires now and schedule");
    }
    this.#scheduler = Object.freeze({
      now: () => safeApply(nowOperation, scheduler, []),
      schedule: (delayMs: number, callback: () => void) =>
        safeApply(scheduleOperation, scheduler, [delayMs, callback]),
    });
    const lifecycleScheduler =
      configuredLifecycleScheduler === undefined
        ? defaultScheduler
        : configuredLifecycleScheduler;
    if (
      (typeof lifecycleScheduler !== "object" &&
        typeof lifecycleScheduler !== "function") ||
      lifecycleScheduler === null
    ) {
      throw new TypeError("lifecycleScheduler requires now and schedule");
    }
    const lifecycleNowOperation = lifecycleScheduler.now;
    const lifecycleScheduleOperation = lifecycleScheduler.schedule;
    if (
      typeof lifecycleNowOperation !== "function" ||
      typeof lifecycleScheduleOperation !== "function"
    ) {
      throw new TypeError("lifecycleScheduler requires now and schedule");
    }
    this.#lifecycleScheduler = Object.freeze({
      now: () => safeApply(lifecycleNowOperation, lifecycleScheduler, []),
      schedule: (delayMs: number, callback: () => void) =>
        safeApply(lifecycleScheduleOperation, lifecycleScheduler, [
          delayMs,
          callback,
        ]),
    });
    this.#requestPump();
  }

  get id(): number {
    return this.#poolId;
  }

  acquireOne(
    options: ConnectionPoolAcquireOptions = {},
  ): Promise<ConnectionPoolLease<T>> {
    return this.acquire(1, options).then((leases) => leases[0]!);
  }

  acquire(
    count = 1,
    options: ConnectionPoolAcquireOptions = {},
  ): Promise<readonly ConnectionPoolLease<T>[]> {
    const started = diagnosticNow();
    const correlationId = diagnosticCorrelationId();
    let acquireOptions: CanonicalAcquireOptions;
    try {
      integer(count, 1, this.#maxConnections, "acquire count");
      acquireOptions = canonicalAcquireOptions(
        options,
        this.#acquireTimeoutMs,
      );
      if (this.#state !== "open") {
        throw poolError("POOL_CLOSED", "connection pool is closing or closed");
      }
      if (acquireOptions.initiallyAborted) {
        throw poolError("ACQUIRE_ABORTED", "connection acquire was aborted");
      }
      if (this.#waiters.length >= this.#maxWaiters) {
        throw poolError("POOL_OVERLOADED", "connection pool waiter limit reached");
      }
    } catch (error) {
      return this.#observeAcquire(Promise.reject(
        this.#state === "open"
          ? error
          : poolError("POOL_CLOSED", "connection pool is closing or closed"),
      ), started, count, correlationId);
    }

    let now: number;
    try {
      now = this.#readClock();
      if (!Number.isFinite(now + acquireOptions.timeoutMs)) {
        throw new RangeError("acquire deadline exceeds the finite clock range");
      }
      if (this.#state !== "open") {
        throw poolError("POOL_CLOSED", "connection pool is closing or closed");
      }
      // The scheduler is an external boundary and may reenter acquire(). Do
      // not let the outer request exceed the bounded FIFO after it returns.
      if (this.#waiters.length >= this.#maxWaiters) {
        throw poolError("POOL_OVERLOADED", "connection pool waiter limit reached");
      }
    } catch (error) {
      return this.#observeAcquire(Promise.reject(
        this.#state === "open"
          ? error
          : poolError("POOL_CLOSED", "connection pool is closing or closed"),
      ), started, count, correlationId);
    }

    let resolve!: (value: readonly ConnectionPoolLease<T>[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<readonly ConnectionPoolLease<T>[]>(
      (resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      },
    );
    let waiter!: Waiter<T>;
    const abortListener = (): void => {
      this.#rejectWaiter(
        waiter,
        poolError("ACQUIRE_ABORTED", "connection acquire was aborted"),
      );
    };
    waiter = {
      id: this.#nextWaiterId++,
      count,
      signal: acquireOptions.signal,
      unregisterAbort: acquireOptions.unregisterAbort,
      abortListener,
      deadline: now + acquireOptions.timeoutMs,
      resolve,
      reject,
      active: true,
      timeoutGeneration: 0,
      earlyTimeoutRearms: 0,
    };
    this.#waiters.push(waiter);
    this.#report?.({
      category: "pool",
      level: "debug",
      code: "pool.wait",
      state: "waiting",
      phase: "acquire",
      count,
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    this.#lowWaterBlocked = false;
    try {
      acquireOptions.registerAbort?.(abortListener);
      if (!waiter.active) {
        this.#removeAbortListener(waiter);
      } else if (this.#state !== "open") {
        this.#rejectWaiter(
          waiter,
          poolError("POOL_CLOSED", "connection pool is closing or closed"),
        );
      } else if (acquireOptions.signal?.aborted === true) {
        this.#rejectWaiter(
          waiter,
          poolError("ACQUIRE_ABORTED", "connection acquire was aborted"),
        );
      } else if (waiter.active) {
        this.#armTimeout(waiter);
      }
    } catch (error) {
      if (!waiter.active) this.#removeAbortListener(waiter);
      this.#rejectWaiter(waiter, error);
    }
    this.#requestPump();
    return this.#observeAcquire(promise, started, count, correlationId);
  }

  #observeAcquire(
    promise: Promise<readonly ConnectionPoolLease<T>[]>,
    started: number,
    count: number,
    correlationId: string | undefined,
  ): Promise<readonly ConnectionPoolLease<T>[]> {
    return promise.then(
      (leases) => {
        this.#report?.({
          category: "pool",
          level: "info",
          code: "pool.acquire",
          state: "leased",
          phase: "acquire",
          durationMs: diagnosticDuration(started),
          count: leases.length,
          ...(correlationId === undefined ? {} : { correlationId }),
        });
        return leases;
      },
      (error: unknown) => {
        const timedOut = error instanceof ConnectionPoolRuntimeError &&
          error.code === "ACQUIRE_TIMEOUT";
        this.#report?.({
          category: "pool",
          level: "warn",
          code: timedOut ? "pool.timed-out" : "pool.rejected",
          state: "failed",
          phase: "acquire",
          durationMs: diagnosticDuration(started),
          ...(Number.isSafeInteger(count) && count >= 0 ? { count } : {}),
          ...(correlationId === undefined ? {} : { correlationId }),
        });
        throw error;
      },
    );
  }

  /**
   * The only resource-use boundary. Callers must not retain the callback-scoped
   * resource; ownership and single-flight tracking end when the Promise settles.
   */
  async withActiveLease<R>(
    lease: ConnectionPoolLease<T>,
    operation: (resource: T) => R | PromiseLike<R>,
  ): Promise<R> {
    if (typeof operation !== "function") {
      throw new TypeError("lease operation must be a function");
    }
    const record = this.#activeLeaseRecord(lease);
    if (this.#state === "closing" || this.#state === "closed") {
      throw poolError("POOL_CLOSED", "connection pool is closing or closed");
    }
    if (record.activeOperations !== 0) {
      throw poolError(
        "POOL_LEASE_BUSY",
        "connection lease already has an active operation",
      );
    }
    record.activeOperations += 1;
    try {
      return await operation(record.physical.resource);
    } finally {
      record.activeOperations -= 1;
    }
  }

  /** Run the pool factory reset under the configured finite lifecycle bound. */
  async resetActiveLease(lease: ConnectionPoolLease<T>): Promise<void> {
    const record = this.#activeLeaseRecord(lease);
    if (this.#state !== "open") {
      throw poolError("POOL_CLOSED", "connection pool is closing or closed");
    }
    if (this.#factory.reset === undefined) {
      throw new TypeError("connection pool factory does not provide reset");
    }
    if (record.activeOperations !== 0) {
      throw poolError(
        "POOL_LEASE_BUSY",
        "connection lease already has an active operation",
      );
    }
    const physical = record.physical;
    record.activeOperations += 1;
    physical.state = "resetting";
    const controller = new AbortController();
    const lifecycle = this.#startLifecycle(
      "reset",
      controller,
      (context) => this.#factory.reset!(physical.resource, context),
    );
    physical.lifecycle = lifecycle;
    try {
      await lifecycle.result;
    } catch (error) {
      this.#resetFailures += 1;
      throw error;
    } finally {
      record.activeOperations -= 1;
      if (physical.lifecycle === lifecycle) physical.lifecycle = undefined;
      if (record.active && physical.state === "resetting") {
        physical.state = "leased";
      }
    }
  }

  async release(
    lease: ConnectionPoolLease<T>,
    options: ConnectionPoolReleaseOptions = {},
  ): Promise<void> {
    const started = diagnosticNow();
    const correlationId = diagnosticCorrelationId();
    try {
      if (typeof options !== "object" || options === null) {
        throw new TypeError("release options must be an object");
      }
      const reusable = booleanOption(options.reusable, true, "release reusable");
      const recycleIdleHigh = options.idleHigh === undefined
        ? undefined
        : integer(
            options.idleHigh,
            0,
            this.#maxConnections,
            "release idleHigh",
          );
      const leaseRecord = this.#activeLeaseRecord(lease);
      if (leaseRecord.activeOperations !== 0) {
        throw poolError(
          "ACTIVE_LEASE",
          "connection lease has an active operation",
        );
      }

      leaseRecord.active = false;
      this.#leased.delete(lease);
      const physical = leaseRecord.physical;

      if (!reusable || this.#state !== "open") {
        await this.#destroy(physical);
        this.#requestPump();
        this.#checkClosed();
        this.#reportRelease(started, false, correlationId);
        return;
      }

      physical.recycleIdleHigh = recycleIdleHigh;

      if (this.#resetOnRelease) {
        physical.state = "resetting";
        const controller = new AbortController();
        const lifecycle = this.#startLifecycle(
          "reset",
          controller,
          (context) => this.#factory.reset!(physical.resource, context),
        );
        physical.lifecycle = lifecycle;
        try {
          await lifecycle.result;
        } catch (error) {
          this.#resetFailures += 1;
          let destroyError: unknown;
          try {
            await this.#destroy(physical);
          } catch (cleanupError) {
            destroyError = cleanupError;
          }
          this.#requestPump();
          if (destroyError !== undefined) {
            throw new AggregateError(
              [error, destroyError],
              "connection reset and destruction both failed",
              { cause: error },
            );
          }
          throw error;
        } finally {
          if (physical.lifecycle === lifecycle) physical.lifecycle = undefined;
        }
        if (this.#state !== "open") {
          await this.#destroy(physical);
          this.#checkClosed();
          this.#reportRelease(started, false, correlationId);
          return;
        }
      }

      this.#lowWaterBlocked = false;
      await this.#returnToPool(physical);
      this.#requestPump();
      this.#reportRelease(started, true, correlationId);
    } catch (error) {
      this.#report?.({
        category: "pool",
        level: "error",
        code: "pool.failed",
        state: "failed",
        phase: "release",
        durationMs: diagnosticDuration(started),
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      throw error;
    }
  }

  #reportRelease(
    started: number,
    reusable: boolean,
    correlationId: string | undefined,
  ): void {
    this.#report?.({
      category: "pool",
      level: "info",
      code: "pool.release",
      state: reusable ? "idle" : "retired",
      phase: "release",
      disposition: reusable ? "reusable" : "close",
      durationMs: diagnosticDuration(started),
      count: 1,
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    if (!reusable) {
      this.#report?.({
        category: "pool",
        level: "info",
        code: "pool.retired",
        state: "retired",
        disposition: "close",
        count: 1,
        ...(correlationId === undefined ? {} : { correlationId }),
      });
    }
  }

  close(options: ConnectionPoolShutdownOptions = {}): Promise<void> {
    return this.#beginShutdown("closing", options);
  }

  /**
   * Retire one immutable destination generation. New acquisition stops, idle
   * resources close immediately, and already-leased resources remain usable
   * until their final release.
   */
  retire(options: ConnectionPoolShutdownOptions = {}): Promise<void> {
    return this.#beginShutdown("retiring", options);
  }

  drain(options: ConnectionPoolShutdownOptions = {}): Promise<void> {
    return this.close(options);
  }

  #beginShutdown(
    requestedState: "retiring" | "closing",
    options: ConnectionPoolShutdownOptions,
  ): Promise<void> {
    const started = diagnosticNow();
    const correlationId = diagnosticCorrelationId();
    if (typeof options !== "object" || options === null) {
      throw new TypeError("shutdown options must be an object");
    }
    const configuredTimeoutMs = options.timeoutMs;
    const timeoutMs = timeout(
      configuredTimeoutMs === undefined
        ? this.#shutdownTimeoutMs
        : configuredTimeoutMs,
      "shutdown timeoutMs",
    );
    if (this.#state === "closed") {
      return this.#closePromise ?? Promise.resolve();
    }
    if (this.#state === "closing") return this.#closePromise!;
    if (this.#state === "retiring") {
      if (requestedState === "closing") this.#state = "closing";
      return this.#closePromise!;
    }

    this.#state = requestedState;
    this.#report?.({
      category: "pool",
      level: "info",
      code: "pool.shutdown",
      state: "closing",
      phase: "close",
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });
    try {
      this.#shutdownDeadline = this.#startRuntimeDeadline(
        timeoutMs,
        (schedulingError) => {
          const error =
            schedulingError === undefined
              ? poolError(
                  "POOL_SHUTDOWN_TIMEOUT",
                  `connection pool shutdown exceeded ${timeoutMs}ms`,
                )
              : schedulingError;
          if (
            error instanceof ConnectionPoolRuntimeError &&
            error.code === "POOL_SHUTDOWN_TIMEOUT"
          ) {
            this.#shutdownTimeouts += 1;
          }
          this.#failClose(error);
        },
      );
    } catch (error) {
      this.#failClose(error);
    }
    for (const waiter of [...this.#waiters]) {
      this.#rejectWaiter(
        waiter,
        poolError("POOL_CLOSED", "connection pool stopped while waiting"),
      );
    }
    for (const creation of this.#creating.values()) {
      this.#abortCreation(
        creation,
        poolError("POOL_CLOSED", "connection pool stopped during creation"),
      );
    }
    for (const physical of [...this.#idle]) {
      this.#observeCleanup(this.#destroy(physical));
    }
    for (const physical of this.#records) {
      if (
        physical.state === "validating" ||
        physical.state === "resetting"
      ) {
        physical.lifecycle?.controller.abort(
          poolError("POOL_CLOSED", "connection pool stopped during lifecycle work"),
        );
      }
    }
    this.#checkClosed();
    void this.#closePromise.then(
      () => {
        if (requestedState === "retiring") {
          this.#report?.({
            category: "pool",
            level: "info",
            code: "pool.retired",
            state: "retired",
            phase: "close",
            ...(correlationId === undefined ? {} : { correlationId }),
          });
        }
        this.#report?.({
          category: "pool",
          level: "info",
          code: "pool.closed",
          state: "closed",
          phase: "close",
          durationMs: diagnosticDuration(started),
          ...(correlationId === undefined ? {} : { correlationId }),
        });
      },
      () => {
        this.#report?.({
          category: "pool",
          level: "error",
          code: "pool.failed",
          state: "failed",
          phase: "close",
          durationMs: diagnosticDuration(started),
          ...(correlationId === undefined ? {} : { correlationId }),
        });
      },
    );
    return this.#closePromise;
  }

  monitor(): ConnectionPoolMonitor {
    let idle = 0;
    let leased = 0;
    let validating = 0;
    let resetting = 0;
    let closing = 0;
    for (const physical of this.#records) {
      switch (physical.state) {
        case "idle":
          idle += 1;
          break;
        case "leased":
          leased += 1;
          break;
        case "validating":
          validating += 1;
          break;
        case "resetting":
          resetting += 1;
          break;
        case "closing":
          closing += 1;
          break;
      }
    }
    const creating = this.#creating.size;
    const connections =
      idle + leased + creating + validating + resetting + closing;
    const failed =
      this.#creationFailures +
      this.#creationAborts +
      this.#healthFailures +
      this.#resetFailures +
      this.#destroyFailures +
      this.#lifecycleTimeouts +
      this.#shutdownTimeouts;
    return Object.freeze({
      poolId: this.#poolId,
      state: this.#state,
      maxConnections: this.#maxConnections,
      maxWaiters: this.#maxWaiters,
      lifecycleTimeoutMs: this.#lifecycleTimeoutMs,
      shutdownTimeoutMs: this.#shutdownTimeoutMs,
      lowWater: this.#lowWater,
      idleHigh: this.#idleHigh,
      connections,
      idle,
      leased,
      creating,
      validating,
      resetting,
      closing,
      waiting: this.#waiters.length,
      lastLeaseGeneration: this.#lastLeaseGeneration,
      leasesIssued: this.#lastLeaseGeneration,
      creationFailures: this.#creationFailures,
      creationAborts: this.#creationAborts,
      healthFailures: this.#healthFailures,
      resetFailures: this.#resetFailures,
      destroyFailures: this.#destroyFailures,
      lifecycleTimeouts: this.#lifecycleTimeouts,
      shutdownTimeouts: this.#shutdownTimeouts,
      failed,
    });
  }

  #readClock(): number {
    const value = this.#scheduler.now();
    if (!Number.isFinite(value) || value < this.#lastClockValue) {
      throw new Error("connection pool scheduler clock must be finite and monotonic");
    }
    this.#lastClockValue = value;
    return value;
  }

  #readLifecycleClock(): number {
    const value = this.#lifecycleScheduler.now();
    if (!Number.isFinite(value) || value < this.#lastLifecycleClockValue) {
      throw new Error(
        "connection pool lifecycle scheduler clock must be finite and monotonic",
      );
    }
    this.#lastLifecycleClockValue = value;
    return value;
  }

  #failClose(error: unknown): void {
    if (this.#closeSettled || this.#closePromise === undefined) return;
    this.#closeSettled = true;
    this.#cancelRuntimeDeadline(this.#shutdownDeadline);
    this.#shutdownDeadline = undefined;
    this.#rejectClose?.(error);
    this.#resolveClose = undefined;
    this.#rejectClose = undefined;
  }

  #observeCleanup(cleanup: void | Promise<void>): void {
    if (cleanup === undefined) return;
    void cleanup.catch(() => {
      // The physical record retains the failure and shutdown/release surfaces it.
    });
  }

  #startRuntimeDeadline(
    timeoutMs: number,
    onExpire: (error: unknown) => void,
  ): RuntimeDeadline {
    const now = this.#readLifecycleClock();
    if (!Number.isFinite(now + timeoutMs)) {
      throw new RangeError("runtime deadline exceeds the finite clock range");
    }
    const deadline: RuntimeDeadline = {
      deadline: now + timeoutMs,
      onExpire,
      active: true,
      generation: 0,
      earlyRearms: 0,
    };
    try {
      this.#armRuntimeDeadline(deadline);
    } catch (error) {
      if (deadline.active) {
        deadline.active = false;
        deadline.generation += 1;
        deadline.onExpire(error);
      }
    }
    return deadline;
  }

  #armRuntimeDeadline(deadline: RuntimeDeadline): void {
    if (!deadline.active) return;
    const remaining = Math.max(
      0,
      deadline.deadline - this.#readLifecycleClock(),
    );
    if (!deadline.active) return;
    const generation = deadline.generation + 1;
    deadline.generation = generation;
    const task = bindScheduledTask(
      this.#lifecycleScheduler.schedule(remaining, () => {
        this.#handleRuntimeDeadline(deadline, generation, remaining);
      }),
    );
    if (!deadline.active || deadline.generation !== generation) {
      try {
        task.cancel();
      } catch {
        // A stale task cannot regain ownership through its cancellation hook.
      }
      return;
    }
    deadline.task = task;
  }

  #handleRuntimeDeadline(
    deadline: RuntimeDeadline,
    generation: number,
    scheduledRemaining: number,
  ): void {
    if (!deadline.active || deadline.generation !== generation) return;
    deadline.task = undefined;
    let remaining: number;
    try {
      remaining = deadline.deadline - this.#readLifecycleClock();
    } catch (error) {
      this.#expireRuntimeDeadline(deadline, generation, error);
      return;
    }
    if (!deadline.active || deadline.generation !== generation) return;
    if (remaining <= 0) {
      this.#expireRuntimeDeadline(deadline, generation, undefined);
      return;
    }

    deadline.earlyRearms += 1;
    if (
      remaining >= scheduledRemaining ||
      deadline.earlyRearms > MAX_EARLY_TIMEOUT_REARMS
    ) {
      this.#expireRuntimeDeadline(
        deadline,
        generation,
        new Error(
          "connection pool scheduler fired a lifecycle deadline without bounded progress",
        ),
      );
      return;
    }
    const rearmGeneration = generation + 1;
    deadline.generation = rearmGeneration;
    queueMicrotask(() => {
      if (!deadline.active || deadline.generation !== rearmGeneration) return;
      try {
        this.#armRuntimeDeadline(deadline);
      } catch (error) {
        this.#expireRuntimeDeadline(deadline, deadline.generation, error);
      }
    });
  }

  #expireRuntimeDeadline(
    deadline: RuntimeDeadline,
    generation: number,
    schedulingError: unknown,
  ): void {
    if (!deadline.active || deadline.generation !== generation) return;
    deadline.active = false;
    deadline.task = undefined;
    deadline.generation += 1;
    deadline.onExpire(schedulingError);
  }

  #cancelRuntimeDeadline(deadline: RuntimeDeadline | undefined): void {
    if (deadline === undefined || !deadline.active) return;
    deadline.active = false;
    deadline.generation += 1;
    const task = deadline.task;
    deadline.task = undefined;
    try {
      task?.cancel();
    } catch {
      // Cancellation cannot change a completed lifecycle operation.
    }
  }

  #startLifecycle<R>(
    operation: ConnectionPoolLifecycleOperation,
    controller: AbortController,
    invoke: (context: ConnectionPoolLifecycleContext) => R | PromiseLike<R>,
  ): LifecycleHandle<R> {
    const operationId = this.#nextOperationId++;
    const timeoutMs = this.#lifecycleTimeoutMs;
    const context: ConnectionPoolLifecycleContext = Object.freeze({
      signal: controller.signal,
      operation,
      operationId,
      timeoutMs,
    });
    let resolve!: (value: R) => void;
    let reject!: (error: unknown) => void;
    let settled = false;
    let expired = false;
    const result = new Promise<R>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    let deadline: RuntimeDeadline | undefined;
    const expire = (schedulingError: unknown): void => {
      if (settled) return;
      settled = true;
      expired = true;
      const error =
        schedulingError === undefined
          ? poolError(
              "LIFECYCLE_TIMEOUT",
              `connection ${operation} exceeded ${timeoutMs}ms`,
            )
          : schedulingError;
      if (
        error instanceof ConnectionPoolRuntimeError &&
        error.code === "LIFECYCLE_TIMEOUT"
      ) {
        this.#lifecycleTimeouts += 1;
      }
      controller.abort(error);
      reject(error);
    };
    try {
      deadline = this.#startRuntimeDeadline(timeoutMs, expire);
    } catch (error) {
      expire(error);
    }

    const raw = Promise.resolve().then(() => invoke(context));
    void raw.then(
      (value) => {
        if (settled) return;
        settled = true;
        this.#cancelRuntimeDeadline(deadline);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        this.#cancelRuntimeDeadline(deadline);
        reject(error);
      },
    );
    return Object.freeze({
      controller,
      result,
      raw,
      get expired() {
        return expired;
      },
    });
  }

  #armTimeout(waiter: Waiter<T>): void {
    const remaining = Math.max(0, waiter.deadline - this.#readClock());
    if (!waiter.active) return;
    if (this.#state !== "open") {
      this.#rejectWaiter(
        waiter,
        poolError("POOL_CLOSED", "connection pool is closing or closed"),
      );
      return;
    }
    const generation = waiter.timeoutGeneration + 1;
    waiter.timeoutGeneration = generation;
    const task = bindScheduledTask(
      this.#scheduler.schedule(remaining, () => {
        this.#handleTimeout(waiter, generation, remaining);
      }),
    );
    if (
      !waiter.active ||
      this.#state !== "open" ||
      waiter.timeoutGeneration !== generation
    ) {
      try {
        task.cancel();
      } catch {
        // A reentrant scheduler cannot retain a stale or settled task.
      }
      if (waiter.active && this.#state !== "open") {
        this.#rejectWaiter(
          waiter,
          poolError("POOL_CLOSED", "connection pool is closing or closed"),
        );
      }
      return;
    }
    waiter.timeoutTask = task;
  }

  #handleTimeout(
    waiter: Waiter<T>,
    generation: number,
    scheduledRemaining: number,
  ): void {
    if (!waiter.active || waiter.timeoutGeneration !== generation) return;
    waiter.timeoutTask = undefined;
    let remaining: number;
    try {
      remaining = waiter.deadline - this.#readClock();
      if (!waiter.active || waiter.timeoutGeneration !== generation) return;
      if (this.#state !== "open") {
        this.#rejectWaiter(
          waiter,
          poolError("POOL_CLOSED", "connection pool is closing or closed"),
        );
        return;
      }
      if (remaining > 0) {
        // A scheduler is an external boundary and may invoke its callback
        // synchronously or early. Recursive rearming can overflow the stack,
        // while a callback with no clock progress can strand the waiter after
        // that overflow unwinds. Invalidate this task and rearm from a
        // microtask under a finite broken-scheduler budget.
        waiter.earlyTimeoutRearms += 1;
        if (
          remaining >= scheduledRemaining ||
          waiter.earlyTimeoutRearms > MAX_EARLY_TIMEOUT_REARMS
        ) {
          this.#rejectWaiter(
            waiter,
            new Error(
              "connection pool scheduler fired acquire timeout before its deadline without bounded progress",
            ),
          );
          return;
        }
        const rearmGeneration = generation + 1;
        waiter.timeoutGeneration = rearmGeneration;
        queueMicrotask(() => {
          if (
            !waiter.active ||
            waiter.timeoutGeneration !== rearmGeneration
          ) {
            return;
          }
          if (this.#state !== "open") {
            this.#rejectWaiter(
              waiter,
              poolError("POOL_CLOSED", "connection pool is closing or closed"),
            );
            return;
          }
          try {
            this.#armTimeout(waiter);
          } catch (error) {
            // #armTimeout advances the generation before consulting the
            // scheduler, so a thrown scheduling hook leaves no live task for
            // that newer generation. Any still-active waiter must settle.
            if (waiter.active) this.#rejectWaiter(waiter, error);
          }
        });
        return;
      }
    } catch (error) {
      if (waiter.active && waiter.timeoutGeneration === generation) {
        this.#rejectWaiter(waiter, error);
      }
      return;
    }
    if (waiter.active && waiter.timeoutGeneration === generation) {
      this.#rejectWaiter(
        waiter,
        poolError("ACQUIRE_TIMEOUT", "connection acquire timed out"),
      );
    }
  }

  #cleanupWaiter(waiter: Waiter<T>): boolean {
    if (!waiter.active) return false;
    waiter.active = false;
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
    const timeoutTask = waiter.timeoutTask;
    waiter.timeoutTask = undefined;
    waiter.timeoutGeneration += 1;
    try {
      timeoutTask?.cancel();
    } catch {
      // A broken scheduler must not retain an already-settled waiter.
    }
    this.#removeAbortListener(waiter);
    this.#reconcileCreations();
    return true;
  }

  #waiterCannotDispatch(waiter: Waiter<T>): boolean {
    if (
      this.#state !== "open" ||
      !waiter.active ||
      this.#waiters[0] !== waiter
    ) {
      return true;
    }

    let now: number;
    try {
      now = this.#readClock();
    } catch (error) {
      if (
        this.#state === "open" &&
        waiter.active &&
        this.#waiters[0] === waiter
      ) {
        this.#rejectWaiter(waiter, error);
      }
      return true;
    }

    // Reading the external scheduler may reenter the pool and settle or
    // replace the FIFO head. Only the original active head may be committed.
    if (
      this.#state !== "open" ||
      !waiter.active ||
      this.#waiters[0] !== waiter
    ) {
      return true;
    }
    if (now < waiter.deadline) return false;

    this.#rejectWaiter(
      waiter,
      poolError("ACQUIRE_TIMEOUT", "connection acquire timed out"),
    );
    return true;
  }

  #removeAbortListener(waiter: Waiter<T>): void {
    if (waiter.unregisterAbort === undefined) return;
    try {
      waiter.unregisterAbort(waiter.abortListener);
    } catch {
      // Cleanup remains deterministic for a broken signal implementation.
    }
  }

  #rejectWaiter(waiter: Waiter<T>, error: unknown): void {
    if (!this.#cleanupWaiter(waiter)) return;
    waiter.reject(error);
    this.#requestPump();
  }

  #requestPump(): void {
    if (this.#state !== "open") return;
    if (this.#dispatching) {
      this.#pumpRequestedWhileDispatching = true;
      return;
    }
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      if (this.#state !== "open" || this.#dispatching) return;
      this.#dispatching = true;
      this.#pumpRequestedWhileDispatching = false;
      void this.#dispatch().catch((error: unknown) => {
        const head = this.#waiters[0];
        if (head !== undefined) this.#rejectWaiter(head, error);
      }).finally(() => {
        this.#dispatching = false;
        if (this.#pumpRequestedWhileDispatching) this.#requestPump();
      });
    });
  }

  async #dispatch(): Promise<void> {
    while (this.#state === "open") {
      const waiter = this.#waiters[0];
      if (waiter === undefined) {
        this.#trimIdleHigh();
        this.#ensureLowWater();
        return;
      }
      if (!waiter.active) {
        this.#waiters.shift();
        continue;
      }
      if (this.#waiterCannotDispatch(waiter)) continue;
      if (this.#idle.length < waiter.count) {
        this.#ensureWaiterCapacity(waiter);
        return;
      }

      const candidates = this.#idle.splice(0, waiter.count);
      for (const physical of candidates) physical.state = "validating";
      const health = await Promise.all(
        candidates.map((physical) => this.#validate(physical)),
      );
      const healthy: PhysicalConnection<T>[] = [];
      let validationError: unknown;
      for (const outcome of health) {
        if (outcome.healthy) healthy.push(outcome.physical);
        else this.#observeCleanup(this.#destroy(outcome.physical));
        if (validationError === undefined && outcome.error !== undefined) {
          validationError = outcome.error;
        }
      }
      if (validationError !== undefined) {
        for (const physical of healthy) {
          this.#observeCleanup(this.#returnToPool(physical));
        }
        if (waiter.active) this.#rejectWaiter(waiter, validationError);
        continue;
      }

      if (
        this.#state !== "open" ||
        !waiter.active ||
        this.#waiters[0] !== waiter
      ) {
        for (const physical of healthy) {
          this.#observeCleanup(this.#returnToPool(physical));
        }
        if (this.#state !== "open") this.#checkClosed();
        continue;
      }
      if (this.#waiterCannotDispatch(waiter)) {
        for (const physical of healthy) {
          this.#observeCleanup(this.#returnToPool(physical));
        }
        if (this.#state !== "open") this.#checkClosed();
        continue;
      }
      if (healthy.length !== waiter.count) {
        for (const physical of healthy) {
          this.#observeCleanup(this.#returnToPool(physical));
        }
        continue;
      }

      const cleaned = this.#cleanupWaiter(waiter);
      if (!cleaned || this.#state !== "open") {
        for (const physical of healthy) {
          this.#observeCleanup(this.#returnToPool(physical));
        }
        if (cleaned) {
          waiter.reject(
            poolError("POOL_CLOSED", "connection pool closed during checkout"),
          );
        }
        this.#requestPump();
        this.#checkClosed();
        continue;
      }
      const leases = healthy.map((physical) => this.#lease(physical));
      waiter.resolve(Object.freeze(leases));
    }
  }

  async #validate(
    physical: PhysicalConnection<T>,
  ): Promise<ValidationOutcome<T>> {
    if (!this.#validateOnCheckout) {
      return { physical, healthy: true };
    }
    const controller = new AbortController();
    const lifecycle = this.#startLifecycle(
      "validate",
      controller,
      (context) => this.#factory.validate!(physical.resource, context),
    );
    physical.lifecycle = lifecycle;
    try {
      const healthy = await lifecycle.result;
      if (healthy === true) return { physical, healthy: true };
    } catch (error) {
      // Validation errors are health failures and never expose the resource.
      this.#healthFailures += 1;
      return {
        physical,
        healthy: false,
        ...(lifecycle.expired ? { error } : {}),
      };
    } finally {
      if (physical.lifecycle === lifecycle) physical.lifecycle = undefined;
    }
    this.#healthFailures += 1;
    return { physical, healthy: false };
  }

  #capacity(): number {
    return this.#records.size + this.#creating.size;
  }

  #expectedAvailable(): number {
    let resetting = 0;
    for (const physical of this.#records) {
      if (physical.state === "resetting") resetting += 1;
    }
    let creating = 0;
    for (const creation of this.#creating.values()) {
      if (!creation.controller.signal.aborted) creating += 1;
    }
    return this.#idle.length + creating + resetting;
  }

  #reconcileCreations(): void {
    const head = this.#state === "open" ? this.#waiters[0] : undefined;
    let resetting = 0;
    for (const physical of this.#records) {
      if (physical.state === "resetting") resetting += 1;
    }
    const availableWithoutCreating = this.#idle.length + resetting;
    const desired =
      head !== undefined
        ? head.count
        : this.#state === "open" && !this.#lowWaterBlocked
          ? this.#lowWater
          : 0;
    let needed = Math.max(0, desired - availableWithoutCreating);
    for (const creation of this.#creating.values()) {
      if (creation.controller.signal.aborted) continue;
      if (needed > 0) {
        creation.ownerWaiterId = head?.id;
        needed -= 1;
      } else {
        creation.ownerWaiterId = undefined;
        this.#abortCreation(
          creation,
          poolError("ACQUIRE_ABORTED", "connection creation is no longer needed"),
        );
      }
    }
  }

  #ensureWaiterCapacity(waiter: Waiter<T>): void {
    const missing = Math.max(0, waiter.count - this.#expectedAvailable());
    const slots = Math.max(0, this.#maxConnections - this.#capacity());
    const starts = Math.min(missing, slots);
    for (let index = 0; index < starts; index += 1) {
      this.#startCreation(waiter.id);
    }
  }

  #abortCreation(creation: Creation, reason: unknown): void {
    creation.abortRequested = true;
    creation.controller.abort(reason);
  }

  #ensureLowWater(): void {
    if (this.#lowWaterBlocked || this.#lowWater === 0) return;
    const missing = Math.max(0, this.#lowWater - this.#expectedAvailable());
    const slots = Math.max(0, this.#maxConnections - this.#capacity());
    const starts = Math.min(missing, slots);
    for (let index = 0; index < starts; index += 1) this.#startCreation();
  }

  #trimIdleHigh(): void {
    if (this.#state !== "open" || this.#waiters.length !== 0) return;
    let effectiveHigh = this.#idleHigh;
    for (const physical of this.#idle) {
      effectiveHigh = Math.min(
        effectiveHigh,
        physical.recycleIdleHigh ?? this.#idleHigh,
      );
    }
    while (this.#idle.length > effectiveHigh) {
      this.#observeCleanup(
        this.#destroy(this.#idle[this.#idle.length - 1]!),
      );
    }
    for (const physical of this.#idle) {
      physical.recycleIdleHigh = undefined;
    }
  }

  #startCreation(ownerWaiterId?: number): void {
    if (this.#state !== "open" || this.#capacity() >= this.#maxConnections) {
      return;
    }
    const id = this.#nextCreationId++;
    const creation: Creation = {
      id,
      ownerWaiterId,
      controller: new AbortController(),
      abortRequested: false,
    };
    this.#creating.set(id, creation);
    const lifecycle = this.#startLifecycle(
      "create",
      creation.controller,
      (context) =>
        this.#factory.create(
          Object.freeze({ ...context, creationId: creation.id }),
        ),
    );
    creation.lifecycle = lifecycle;
    void lifecycle.result.then(
      (resource) => this.#creationSucceeded(creation, resource, false),
      (error: unknown) => {
        if (lifecycle.expired) this.#creationExpired(creation, error);
        else this.#creationFailed(creation, error, false);
      },
    );
    void lifecycle.raw.then(
      (resource) => {
        if (lifecycle.expired) {
          this.#creationSucceeded(creation, resource, true);
        }
      },
      (error: unknown) => {
        if (lifecycle.expired) this.#creationFailed(creation, error, true);
      },
    );
  }

  #creationSucceeded(creation: Creation, resource: T, late: boolean): void {
    if (this.#creating.get(creation.id) !== creation) return;
    this.#creating.delete(creation.id);
    if (
      (typeof resource !== "object" && typeof resource !== "function") ||
      resource === null
    ) {
      if (!late) {
        this.#creationFailedAfterRemoval(
          creation,
          new TypeError("connection factory must create a non-null object"),
        );
      } else {
        this.#requestPump();
        this.#checkClosed();
      }
      return;
    }
    if (this.#resourceRecords.has(resource)) {
      if (!late) {
        this.#creationFailedAfterRemoval(
          creation,
          new Error(
            "connection factory returned a resource already owned by the pool",
          ),
        );
      } else {
        this.#requestPump();
        this.#checkClosed();
      }
      return;
    }
    const aborted = creation.controller.signal.aborted;
    if (aborted && !late) this.#creationAborts += 1;

    const physical: PhysicalConnection<T> = {
      resource,
      state: "idle",
      generation: 0,
    };
    this.#records.add(physical);
    this.#resourceRecords.set(resource, physical);
    if (aborted) {
      this.#observeCleanup(this.#destroy(physical));
      this.#requestPump();
      this.#checkClosed();
      return;
    }
    this.#lowWaterBlocked = false;
    if (this.#state !== "open") {
      this.#observeCleanup(this.#destroy(physical));
    } else {
      this.#observeCleanup(this.#returnToPool(physical));
    }
    this.#requestPump();
    this.#checkClosed();
  }

  #creationFailed(creation: Creation, error: unknown, late: boolean): void {
    if (this.#creating.get(creation.id) !== creation) return;
    this.#creating.delete(creation.id);
    if (late) {
      this.#requestPump();
      this.#checkClosed();
      return;
    }
    this.#creationFailedAfterRemoval(creation, error);
  }

  #creationExpired(creation: Creation, error: unknown): void {
    if (
      this.#creating.get(creation.id) !== creation ||
      creation.terminalError !== undefined
    ) {
      return;
    }
    creation.terminalError = error;
    if (creation.abortRequested) this.#creationAborts += 1;
    else this.#creationFailures += 1;
    this.#lowWaterBlocked = true;
    const waiter = this.#waiters.find(
      (candidate) =>
        candidate.id === creation.ownerWaiterId && candidate.active,
    );
    if (waiter !== undefined) this.#rejectWaiter(waiter, creationError(error));
    if (this.#state !== "open") this.#failClose(error);
    this.#requestPump();
    this.#checkClosed();
  }

  #creationFailedAfterRemoval(creation: Creation, error: unknown): void {
    if (creation.controller.signal.aborted) this.#creationAborts += 1;
    else this.#creationFailures += 1;
    this.#lowWaterBlocked = true;
    const waiter = this.#waiters.find(
      (candidate) =>
        candidate.id === creation.ownerWaiterId && candidate.active,
    );
    if (waiter !== undefined) this.#rejectWaiter(waiter, creationError(error));
    this.#requestPump();
    this.#checkClosed();
  }

  #returnToPool(physical: PhysicalConnection<T>): void | Promise<void> {
    if (!this.#records.has(physical)) return;
    if (this.#state !== "open") {
      return this.#destroy(physical);
    }
    const idleHigh = physical.recycleIdleHigh ?? this.#idleHigh;
    if (this.#waiters.length > 0 || this.#idle.length < idleHigh) {
      physical.state = "idle";
      if (!this.#idle.includes(physical)) this.#idle.push(physical);
      // Keep the handoff cap while a waiter owns the validation race. Once
      // the resource reaches stable idle, the one-shot recycle policy is
      // fulfilled and explicit ready(n) may again exceed the public high.
      if (this.#waiters.length === 0) physical.recycleIdleHigh = undefined;
      return;
    }
    physical.recycleIdleHigh = undefined;
    return this.#destroy(physical);
  }

  #lease(physical: PhysicalConnection<T>): ConnectionPoolLease<T> {
    physical.recycleIdleHigh = undefined;
    physical.state = "leased";
    physical.generation = ++this.#lastLeaseGeneration;
    const lease: ConnectionPoolLease<T> = Object.freeze({
      poolId: this.#poolId,
      generation: physical.generation,
    });
    const record: LeaseRecord<T> = {
      physical,
      generation: physical.generation,
      active: true,
      activeOperations: 0,
    };
    this.#leased.set(lease, record);
    this.#knownLeases.set(lease, record);
    return lease;
  }

  #activeLeaseRecord(lease: ConnectionPoolLease<T>): LeaseRecord<T> {
    if (
      typeof lease !== "object" ||
      lease === null ||
      lease.poolId !== this.#poolId
    ) {
      throw poolError("WRONG_POOL", "lease does not belong to this pool");
    }
    const record = this.#knownLeases.get(lease);
    if (record === undefined) {
      throw poolError("STALE_LEASE", "lease token is not recognized");
    }
    if (!record.active) {
      if (record.physical.generation !== record.generation) {
        throw poolError("STALE_LEASE", "lease generation is stale");
      }
      throw poolError("DOUBLE_RELEASE", "lease was already released");
    }
    return record;
  }

  #destroy(physical: PhysicalConnection<T>): Promise<void> {
    if (physical.destroyPromise !== undefined) return physical.destroyPromise;
    const idleIndex = this.#idle.indexOf(physical);
    if (idleIndex >= 0) this.#idle.splice(idleIndex, 1);
    physical.state = "closing";
    const controller = new AbortController();
    const lifecycle = this.#startLifecycle(
      "destroy",
      controller,
      (context) => this.#factory.destroy(physical.resource, context),
    );
    physical.lifecycle = lifecycle;
    const finish = (): void => {
      if (!this.#records.has(physical)) return;
      physical.destroyError = undefined;
      if (physical.lifecycle === lifecycle) physical.lifecycle = undefined;
      this.#records.delete(physical);
      this.#resourceRecords.delete(physical.resource);
      this.#requestPump();
      this.#checkClosed();
    };
    const promise = lifecycle.result.then(
      () => {
        finish();
      },
      (error: unknown) => {
        this.#destroyFailures += 1;
        physical.destroyError = error;
        if (this.#state !== "open") this.#failClose(error);
        this.#requestPump();
        this.#checkClosed();
        if (lifecycle.expired) {
          void lifecycle.raw.then(
            () => finish(),
            () => undefined,
          );
        }
        throw error;
      },
    );
    physical.destroyPromise = promise;
    return promise;
  }

  #checkClosed(): void {
    if (this.#state !== "retiring" && this.#state !== "closing") return;
    for (const creation of this.#creating.values()) {
      if (creation.terminalError !== undefined) {
        this.#failClose(creation.terminalError);
        break;
      }
    }
    for (const physical of this.#records) {
      if (physical.destroyError !== undefined) {
        this.#failClose(physical.destroyError);
        break;
      }
    }
    if (
      this.#creating.size === 0 &&
      this.#records.size === 0
    ) {
      this.#state = "closed";
      this.#cancelRuntimeDeadline(this.#shutdownDeadline);
      this.#shutdownDeadline = undefined;
      if (!this.#closeSettled) {
        this.#closeSettled = true;
        this.#resolveClose?.();
      }
      this.#resolveClose = undefined;
      this.#rejectClose = undefined;
    }
  }
}
