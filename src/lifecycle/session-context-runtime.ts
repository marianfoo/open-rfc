export interface SessionContextScope {
  readonly destinationId: string;
  readonly configurationGenerationId: string;
}

/**
 * An explicit, immutable context identity. Token object identity is also
 * checked, so copying these public fields cannot forge ownership.
 */
export interface SessionContextToken extends SessionContextScope {
  readonly runtimeId: number;
  readonly contextId: number;
}

export interface SessionContextAcquireContext<_C extends object> {
  readonly token: SessionContextToken;
  readonly scope: SessionContextScope;
  /** Aborted when the owning destination generation retires or the step times out. */
  readonly signal: AbortSignal;
}

export interface SessionContextCleanupContext {
  readonly token: SessionContextToken;
  /** Aborted on a deadline and, for reusable work, on runtime retirement. */
  readonly signal: AbortSignal;
}

export interface SessionContextOperationContext {
  readonly token: SessionContextToken;
  /** Aborted when the context runtime retires or the operation times out. */
  readonly signal: AbortSignal;
}

export type SessionContextReleaseReason =
  | "context-end"
  | "begin-rollback"
  | "reset-failed"
  | "fatal-operation"
  | "runtime-retire";

export interface SessionContextReleaseDisposition {
  /** False requires the adapter to close or evict the physical connection. */
  readonly reusable: boolean;
  readonly reason: SessionContextReleaseReason;
}

/**
 * Pool-independent ownership seam. A release call is a once-only ownership
 * transfer. When `reusable` is false, it must converge closure/eviction before
 * settling, including when it rejects. Implementations must observe the
 * supplied signals so a generation can retire within its configured bound.
 */
export interface SessionContextLeaseAdapter<
  L extends object,
  C extends object,
> {
  acquire(context: SessionContextAcquireContext<C>): L | PromiseLike<L>;
  resource(lease: L): C;
  reset(
    lease: L,
    resource: C,
    context: SessionContextCleanupContext,
  ): void | PromiseLike<void>;
  release(
    lease: L,
    disposition: SessionContextReleaseDisposition,
    context: SessionContextCleanupContext,
  ): void | PromiseLike<void>;
}

export interface SessionContextFailureContext {
  readonly token: SessionContextToken;
}

export interface SessionContextFatalEvent {
  readonly token: SessionContextToken;
  readonly cause: unknown;
  /** Aborted if notification exceeds its deadline or retirement starts. */
  readonly signal: AbortSignal;
}

export interface SessionContextScheduledTask {
  cancel(): void;
}

/** A monotonic scheduling boundary which deterministic tests can replace. */
export interface SessionContextScheduler {
  now(): number;
  schedule(
    delayMs: number,
    callback: () => void,
  ): SessionContextScheduledTask;
}

export interface SessionContextRuntimeOptions<
  L extends object,
  C extends object,
> {
  readonly scope: SessionContextScope;
  readonly leases: SessionContextLeaseAdapter<L, C>;
  /** Finite deadline shared by operations and every adapter/observer step. */
  readonly operationTimeoutMs: number;
  readonly scheduler?: SessionContextScheduler;
  /** Synchronous because ownership must be decided before another operation. */
  readonly isFatal?: (
    failure: unknown,
    context: SessionContextFailureContext,
  ) => boolean;
  /** Invoked after fatal registry removal and physical lease convergence. */
  readonly onFatal?: (
    event: SessionContextFatalEvent,
  ) => void | PromiseLike<void>;
}

export type SessionContextRuntimeState = "open" | "retiring" | "retired";

export type SessionContextRuntimeErrorCode =
  | "INVALID_CONTEXT_TOKEN"
  | "CONTEXT_CLOSED"
  | "CONTEXT_FATAL"
  | "CONTEXT_ENDING"
  | "UNMATCHED_CONTEXT_END"
  | "CONCURRENT_CONTEXT_OPERATION"
  | "ACTIVE_CONTEXT_OPERATION"
  | "RUNTIME_RETIRED"
  | "OPERATION_TIMEOUT";

export class SessionContextRuntimeError extends Error {
  readonly code: SessionContextRuntimeErrorCode;

  constructor(code: SessionContextRuntimeErrorCode, message: string) {
    super(message);
    this.name = "SessionContextRuntimeError";
    this.code = code;
  }
}

export interface SessionContextRuntimeMonitor {
  readonly runtimeId: number;
  readonly state: SessionContextRuntimeState;
  /** Published contexts. A fatal context is removed before cleanup begins. */
  readonly contexts: number;
  readonly ready: number;
  readonly ending: number;
  readonly retiring: number;
  readonly opening: number;
  readonly fatalCleaning: number;
  readonly pinnedLeases: number;
  readonly references: number;
  readonly activeOperations: number;
  readonly beginCalls: number;
  readonly nestedBeginCalls: number;
  readonly beginFailures: number;
  readonly endCalls: number;
  readonly endFailures: number;
  readonly operationCalls: number;
  readonly operationFailures: number;
  readonly concurrentOperationRejections: number;
  readonly activeEndRejections: number;
  readonly resetCalls: number;
  readonly resetFailures: number;
  readonly reusableReleases: number;
  readonly evictions: number;
  readonly releaseFailures: number;
  readonly fatalRemovals: number;
  readonly ownerNotifications: number;
  readonly ownerNotificationFailures: number;
  readonly boundaryTimeouts: number;
  readonly retireCalls: number;
  readonly retireFailures: number;
}

interface BoundLeaseAdapter<L extends object, C extends object> {
  readonly acquire: (context: SessionContextAcquireContext<C>) => Promise<L>;
  readonly resource: (lease: L) => C;
  readonly reset: (
    lease: L,
    resource: C,
    context: SessionContextCleanupContext,
  ) => Promise<void>;
  readonly release: (
    lease: L,
    disposition: SessionContextReleaseDisposition,
    context: SessionContextCleanupContext,
  ) => Promise<void>;
}

interface BoundScheduler {
  readonly now: () => number;
  readonly schedule: (
    delayMs: number,
    callback: () => void,
  ) => SessionContextScheduledTask;
}

type ContextState = "ready" | "ending" | "retiring" | "fatal" | "closed";

interface ContextEntry<L extends object, C extends object> {
  readonly token: SessionContextToken;
  readonly lease: L;
  readonly resource: C;
  state: ContextState;
  terminalKind?: "normal" | "fatal" | "retired";
  references: number;
  activeOperation: boolean;
  operationDone?: Promise<void>;
  resolveOperationDone?: () => void;
  terminalPromise?: Promise<void>;
  resolveTerminal?: () => void;
  rejectTerminal?: (error: unknown) => void;
  releaseClaimed: boolean;
  physicallyClosed: boolean;
  ownerNotified: boolean;
}

interface OpeningContext {
  readonly done: Promise<void>;
  readonly finish: () => void;
}

interface MutableMonitor {
  ready: number;
  ending: number;
  retiring: number;
  opening: number;
  fatalCleaning: number;
  pinnedLeases: number;
  references: number;
  activeOperations: number;
  beginCalls: number;
  nestedBeginCalls: number;
  beginFailures: number;
  endCalls: number;
  endFailures: number;
  operationCalls: number;
  operationFailures: number;
  concurrentOperationRejections: number;
  activeEndRejections: number;
  resetCalls: number;
  resetFailures: number;
  reusableReleases: number;
  evictions: number;
  releaseFailures: number;
  fatalRemovals: number;
  ownerNotifications: number;
  ownerNotificationFailures: number;
  boundaryTimeouts: number;
  retireCalls: number;
  retireFailures: number;
}

interface BoundedOptions<T> {
  readonly abortOnRetire: boolean;
  readonly onLateFulfilled?: (value: T) => void | PromiseLike<void>;
}

const MAX_TIMER_MS = 2_147_483_647;
const MAX_EARLY_TIMER_REARMS = 64;
const safeApply = Reflect.apply;

const defaultScheduler: SessionContextScheduler = Object.freeze({
  now: () => performance.now(),
  schedule(
    delayMs: number,
    callback: () => void,
  ): SessionContextScheduledTask {
    const handle = setTimeout(callback, delayMs);
    // Context deadlines are safety bounds, not work which should keep Node
    // alive after all application handles have closed.
    handle.unref();
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  },
});

function controlledIdentity(value: string, path: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(
      `${path} must contain 1..512 characters without controls`,
    );
  }
  return value;
}

function snapshotScope(scope: SessionContextScope): SessionContextScope {
  if (typeof scope !== "object" || scope === null) {
    throw new TypeError("session context scope must be an object");
  }
  const destinationId = controlledIdentity(
    scope.destinationId,
    "scope.destinationId",
  );
  const configurationGenerationId = controlledIdentity(
    scope.configurationGenerationId,
    "scope.configurationGenerationId",
  );
  return Object.freeze({ destinationId, configurationGenerationId });
}

function callable(value: unknown, path: string): Function {
  if (typeof value !== "function") {
    throw new TypeError(`${path} must be a function`);
  }
  return value;
}

function bindLeaseAdapter<L extends object, C extends object>(
  adapter: SessionContextLeaseAdapter<L, C>,
): BoundLeaseAdapter<L, C> {
  if (
    (typeof adapter !== "object" && typeof adapter !== "function") ||
    adapter === null
  ) {
    throw new TypeError("session context lease adapter must be an object");
  }
  const acquireOperation = callable(adapter.acquire, "leases.acquire");
  const resourceOperation = callable(adapter.resource, "leases.resource");
  const resetOperation = callable(adapter.reset, "leases.reset");
  const releaseOperation = callable(adapter.release, "leases.release");
  return Object.freeze({
    acquire: (context: SessionContextAcquireContext<C>): Promise<L> =>
      Promise.resolve(safeApply(acquireOperation, adapter, [context])),
    resource: (lease: L): C => safeApply(resourceOperation, adapter, [lease]),
    reset: (
      lease: L,
      resource: C,
      context: SessionContextCleanupContext,
    ): Promise<void> =>
      Promise.resolve(
        safeApply(resetOperation, adapter, [lease, resource, context]),
      ),
    release: (
      lease: L,
      disposition: SessionContextReleaseDisposition,
      context: SessionContextCleanupContext,
    ): Promise<void> =>
      Promise.resolve(
        safeApply(releaseOperation, adapter, [lease, disposition, context]),
      ),
  });
}

function bindScheduler(scheduler: SessionContextScheduler): BoundScheduler {
  if (
    (typeof scheduler !== "object" && typeof scheduler !== "function") ||
    scheduler === null
  ) {
    throw new TypeError("scheduler requires now and schedule");
  }
  const nowOperation = callable(scheduler.now, "scheduler.now");
  const scheduleOperation = callable(scheduler.schedule, "scheduler.schedule");
  return Object.freeze({
    now: (): number => safeApply(nowOperation, scheduler, []),
    schedule: (delayMs: number, callback: () => void) =>
      safeApply(scheduleOperation, scheduler, [delayMs, callback]),
  });
}

function bindScheduledTask(task: SessionContextScheduledTask): SessionContextScheduledTask {
  if (
    (typeof task !== "object" && typeof task !== "function") ||
    task === null
  ) {
    throw new TypeError("scheduler must return a cancelable task");
  }
  const cancelOperation = callable(task.cancel, "scheduled task cancel");
  return Object.freeze({
    cancel: () => safeApply(cancelOperation, task, []),
  });
}

function finiteTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(
      `operationTimeoutMs must be finite and in 1..${MAX_TIMER_MS}`,
    );
  }
  return value;
}

function contextError(
  code: SessionContextRuntimeErrorCode,
  message: string,
): SessionContextRuntimeError {
  return new SessionContextRuntimeError(code, message);
}

function asCleanupFailure(
  primary: unknown,
  cleanup: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primary, cleanup], message, { cause: primary });
}

function completion(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
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
    ready: 0,
    ending: 0,
    retiring: 0,
    opening: 0,
    fatalCleaning: 0,
    pinnedLeases: 0,
    references: 0,
    activeOperations: 0,
    beginCalls: 0,
    nestedBeginCalls: 0,
    beginFailures: 0,
    endCalls: 0,
    endFailures: 0,
    operationCalls: 0,
    operationFailures: 0,
    concurrentOperationRejections: 0,
    activeEndRejections: 0,
    resetCalls: 0,
    resetFailures: 0,
    reusableReleases: 0,
    evictions: 0,
    releaseFailures: 0,
    fatalRemovals: 0,
    ownerNotifications: 0,
    ownerNotificationFailures: 0,
    boundaryTimeouts: 0,
    retireCalls: 0,
    retireFailures: 0,
  };
}

let nextRuntimeId = 1;

/**
 * Destination-generation-owned stateful RFC context registry.
 *
 * Ownership transitions happen synchronously before an external Promise or
 * callback is entered. Every asynchronous boundary has a deadline and signal;
 * retirement first closes ownership, then aborts and converges prior work.
 */
export class SessionContextRuntime<
  L extends object,
  C extends object,
> {
  readonly #runtimeId = nextRuntimeId++;
  readonly #scope: SessionContextScope;
  readonly #leases: BoundLeaseAdapter<L, C>;
  readonly #operationTimeoutMs: number;
  readonly #scheduler: BoundScheduler;
  readonly #isFatal?: (
    failure: unknown,
    context: SessionContextFailureContext,
  ) => boolean;
  readonly #isFatalReceiver: object;
  readonly #onFatal?: (
    event: SessionContextFatalEvent,
  ) => void | PromiseLike<void>;
  readonly #onFatalReceiver: object;
  readonly #entries = new Set<ContextEntry<L, C>>();
  readonly #tokens = new WeakMap<object, ContextEntry<L, C>>();
  readonly #openings = new Set<OpeningContext>();
  readonly #abortOnRetire = new Set<AbortController>();
  readonly #lateCleanups = new Set<Promise<void>>();
  readonly #monitor = emptyMonitor();
  #nextContextId = 1;
  #state: SessionContextRuntimeState = "open";
  #retirement?: Promise<void>;
  #resolveRetirement?: () => void;
  #rejectRetirement?: (error: unknown) => void;
  #lastClockValue = 0;

  constructor(options: SessionContextRuntimeOptions<L, C>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("session context runtime options must be an object");
    }
    this.#scope = snapshotScope(options.scope);
    this.#leases = bindLeaseAdapter(options.leases);
    this.#operationTimeoutMs = finiteTimeout(options.operationTimeoutMs);
    this.#scheduler = bindScheduler(options.scheduler ?? defaultScheduler);
    const isFatal = options.isFatal;
    const onFatal = options.onFatal;
    if (isFatal !== undefined && typeof isFatal !== "function") {
      throw new TypeError("isFatal must be a function");
    }
    if (onFatal !== undefined && typeof onFatal !== "function") {
      throw new TypeError("onFatal must be a function");
    }
    this.#isFatal = isFatal;
    this.#isFatalReceiver = options;
    this.#onFatal = onFatal;
    this.#onFatalReceiver = options;
  }

  get scope(): SessionContextScope {
    return this.#scope;
  }

  begin(): Promise<SessionContextToken>;
  begin(token: SessionContextToken): Promise<SessionContextToken>;
  async begin(token?: SessionContextToken): Promise<SessionContextToken> {
    this.#monitor.beginCalls += 1;
    try {
      this.#requireOpen("begin");
      if (token !== undefined) {
        const entry = this.#entry(token);
        this.#requireReady(entry, "begin");
        if (entry.activeOperation) {
          throw contextError(
            "ACTIVE_CONTEXT_OPERATION",
            "cannot nest begin while a context operation disposition is active",
          );
        }
        entry.references += 1;
        this.#monitor.references += 1;
        this.#monitor.nestedBeginCalls += 1;
        return entry.token;
      }
    } catch (error) {
      this.#monitor.beginFailures += 1;
      throw error;
    }

    const nextToken: SessionContextToken = Object.freeze({
      ...this.#scope,
      runtimeId: this.#runtimeId,
      contextId: this.#nextContextId++,
    });
    const openingCompletion = completion();
    const opening: OpeningContext = Object.freeze({
      done: openingCompletion.promise,
      finish: openingCompletion.resolve,
    });
    this.#openings.add(opening);
    this.#monitor.opening += 1;

    let acquiredLease: L | undefined;
    try {
      acquiredLease = await this.#bounded(
        "session lease acquire",
        (signal) => {
          const acquireContext: SessionContextAcquireContext<C> = Object.freeze({
            token: nextToken,
            scope: this.#scope,
            signal,
          });
          return this.#leases.acquire(acquireContext);
        },
        {
          abortOnRetire: true,
          onLateFulfilled: (lateLease) =>
            this.#cleanupLateAcquire(lateLease, nextToken),
        },
      );
      if (typeof acquiredLease !== "object" || acquiredLease === null) {
        throw new TypeError("leases.acquire must resolve to an object lease");
      }
      this.#requireOpen("publish a new context");
      const resource = this.#leases.resource(acquiredLease);
      if (typeof resource !== "object" || resource === null) {
        throw new TypeError("leases.resource must return an object resource");
      }
      // `resource` is synchronous but caller-owned and may reenter retire().
      this.#requireOpen("publish a new context");
      const entry: ContextEntry<L, C> = {
        token: nextToken,
        lease: acquiredLease,
        resource,
        state: "ready",
        references: 1,
        activeOperation: false,
        releaseClaimed: false,
        physicallyClosed: false,
        ownerNotified: false,
      };
      this.#entries.add(entry);
      this.#tokens.set(nextToken, entry);
      this.#monitor.ready += 1;
      this.#monitor.pinnedLeases += 1;
      this.#monitor.references += 1;
      return nextToken;
    } catch (error) {
      this.#monitor.beginFailures += 1;
      if (
        acquiredLease !== undefined &&
        typeof acquiredLease === "object" &&
        acquiredLease !== null
      ) {
        try {
          await this.#releaseLease(
            acquiredLease,
            false,
            this.#state === "open" ? "begin-rollback" : "runtime-retire",
            nextToken,
          );
        } catch (cleanupError) {
          throw asCleanupFailure(
            error,
            cleanupError,
            "session context begin and lease rollback both failed",
          );
        }
      }
      throw error;
    } finally {
      this.#openings.delete(opening);
      this.#monitor.opening -= 1;
      opening.finish();
    }
  }

  async run<R>(
    token: SessionContextToken,
    operation: (
      resource: C,
      context: SessionContextOperationContext,
    ) => R | PromiseLike<R>,
  ): Promise<R> {
    if (typeof operation !== "function") {
      throw new TypeError("session context operation must be a function");
    }
    this.#requireOpen("run");
    const entry = this.#entry(token);
    this.#requireReady(entry, "run");
    if (entry.activeOperation) {
      this.#monitor.concurrentOperationRejections += 1;
      throw contextError(
        "CONCURRENT_CONTEXT_OPERATION",
        "session context already has an active operation",
      );
    }

    this.#claimOperation(entry);
    this.#monitor.operationCalls += 1;
    try {
      const result = await this.#bounded(
        "session context operation",
        (signal) => {
          const operationContext: SessionContextOperationContext = Object.freeze({
            token: entry.token,
            signal,
          });
          return safeApply(operation, undefined, [entry.resource, operationContext]);
        },
        { abortOnRetire: true },
      );
      if (this.#state !== "open" || entry.state !== "ready") {
        throw this.#retiredError("complete a context operation");
      }
      return result;
    } catch (error) {
      this.#monitor.operationFailures += 1;
      if (this.#state !== "open" || entry.state !== "ready") {
        throw error;
      }

      let fatal =
        error instanceof SessionContextRuntimeError &&
        error.code === "OPERATION_TIMEOUT";
      let propagatedError = error;
      if (!fatal && this.#isFatal !== undefined) {
        const failureContext: SessionContextFailureContext = Object.freeze({
          token: entry.token,
        });
        try {
          const classification = safeApply(
            this.#isFatal,
            this.#isFatalReceiver,
            [error, failureContext],
          );
          if (typeof classification !== "boolean") {
            throw new TypeError("isFatal must return a boolean");
          }
          fatal = classification;
        } catch (classificationError) {
          fatal = true;
          propagatedError = asCleanupFailure(
            error,
            classificationError,
            "session operation and fatal classification both failed",
          );
        }
      }

      if (
        fatal &&
        this.#state === "open" &&
        entry.state === "ready"
      ) {
        this.#releaseOperationClaim(entry);
        const terminal = this.#claimFatal(entry, propagatedError);
        try {
          await terminal;
        } catch (cleanupError) {
          throw asCleanupFailure(
            propagatedError,
            cleanupError,
            "fatal session operation and eviction both failed",
          );
        }
      }
      throw propagatedError;
    } finally {
      this.#releaseOperationClaim(entry);
    }
  }

  async end(token: SessionContextToken): Promise<void> {
    this.#monitor.endCalls += 1;
    let entry: ContextEntry<L, C>;
    try {
      this.#requireOpen("end");
      entry = this.#entry(token);
    } catch (error) {
      this.#monitor.endFailures += 1;
      throw error;
    }
    if (entry.terminalKind === "fatal") {
      this.#monitor.endFailures += 1;
      throw contextError(
        "CONTEXT_FATAL",
        "session context was removed after a fatal operation",
      );
    }
    if (entry.state === "closed") {
      this.#monitor.endFailures += 1;
      throw contextError(
        "UNMATCHED_CONTEXT_END",
        "session context has no unmatched begin",
      );
    }
    if (entry.state === "ending") {
      this.#monitor.endFailures += 1;
      throw contextError(
        "CONTEXT_ENDING",
        "session context end is already in progress",
      );
    }
    if (entry.activeOperation) {
      this.#monitor.endFailures += 1;
      this.#monitor.activeEndRejections += 1;
      throw contextError(
        "ACTIVE_CONTEXT_OPERATION",
        "cannot end a session context during an active operation",
      );
    }
    if (entry.references < 1) {
      this.#monitor.endFailures += 1;
      throw contextError(
        "UNMATCHED_CONTEXT_END",
        "session context has no unmatched begin",
      );
    }

    entry.references -= 1;
    this.#monitor.references -= 1;
    if (entry.references > 0) return;

    const terminal = this.#claimEnding(entry);
    try {
      await terminal;
    } catch (error) {
      this.#monitor.endFailures += 1;
      throw error;
    }
  }

  /**
   * Synchronously closes the ownership gate and idempotently converges every
   * opening or pinned context. Unmatched/lost tokens are therefore harmless.
   */
  retire(): Promise<void> {
    this.#monitor.retireCalls += 1;
    if (this.#retirement !== undefined) return this.#retirement;

    const retirementCompletion = completion();
    this.#retirement = retirementCompletion.promise;
    this.#resolveRetirement = retirementCompletion.resolve;
    this.#rejectRetirement = retirementCompletion.reject;
    this.#state = "retiring";

    const openings = [...this.#openings].map((opening) => opening.done);
    const entries = [...this.#entries];
    const retireStarters: ContextEntry<L, C>[] = [];
    for (const entry of entries) {
      if (entry.state === "ready") {
        this.#claimRetiring(entry);
        retireStarters.push(entry);
      }
    }
    const terminals = entries
      .map((entry) => entry.terminalPromise)
      .filter((value): value is Promise<void> => value !== undefined);

    // State and all ready entries are closed before abort listeners can reenter.
    const retirementCause = this.#retiredError("continue context work");
    for (const controller of [...this.#abortOnRetire]) {
      this.#abortController(controller, retirementCause);
    }
    for (const entry of retireStarters) this.#startRetiring(entry);

    void this.#completeRetirement(openings, terminals);
    return this.#retirement;
  }

  /** Alias for owners whose lifecycle vocabulary uses close rather than retire. */
  close(): Promise<void> {
    return this.retire();
  }

  monitor(): SessionContextRuntimeMonitor {
    return Object.freeze({
      runtimeId: this.#runtimeId,
      state: this.#state,
      contexts:
        this.#monitor.ready +
        this.#monitor.ending +
        this.#monitor.retiring,
      ...this.#monitor,
    });
  }

  #entry(token: SessionContextToken): ContextEntry<L, C> {
    if (
      (typeof token !== "object" && typeof token !== "function") ||
      token === null
    ) {
      throw contextError(
        "INVALID_CONTEXT_TOKEN",
        "session context token does not belong to this runtime",
      );
    }
    const entry = this.#tokens.get(token);
    if (entry === undefined) {
      throw contextError(
        "INVALID_CONTEXT_TOKEN",
        "session context token does not belong to this runtime",
      );
    }
    return entry;
  }

  #requireOpen(operation: string): void {
    if (this.#state !== "open") throw this.#retiredError(operation);
  }

  #retiredError(operation: string): SessionContextRuntimeError {
    return contextError(
      "RUNTIME_RETIRED",
      `cannot ${operation}: session context runtime is retiring or retired`,
    );
  }

  #requireReady(entry: ContextEntry<L, C>, operation: string): void {
    if (entry.terminalKind === "fatal") {
      throw contextError(
        "CONTEXT_FATAL",
        `cannot ${operation}: session context is fatal`,
      );
    }
    if (entry.terminalKind === "retired") {
      throw this.#retiredError(operation);
    }
    if (entry.state === "ending") {
      throw contextError(
        "CONTEXT_ENDING",
        `cannot ${operation}: session context end is in progress`,
      );
    }
    if (entry.state !== "ready" || entry.references < 1) {
      throw contextError(
        "CONTEXT_CLOSED",
        `cannot ${operation}: session context is closed`,
      );
    }
  }

  #claimOperation(entry: ContextEntry<L, C>): void {
    const done = completion();
    entry.activeOperation = true;
    entry.operationDone = done.promise;
    entry.resolveOperationDone = done.resolve;
    this.#monitor.activeOperations += 1;
  }

  #releaseOperationClaim(entry: ContextEntry<L, C>): void {
    if (!entry.activeOperation) return;
    entry.activeOperation = false;
    this.#monitor.activeOperations -= 1;
    entry.resolveOperationDone?.();
    entry.resolveOperationDone = undefined;
  }

  #newTerminal(entry: ContextEntry<L, C>): Promise<void> {
    const terminal = completion();
    entry.terminalPromise = terminal.promise;
    entry.resolveTerminal = terminal.resolve;
    entry.rejectTerminal = terminal.reject;
    return terminal.promise;
  }

  #settleTerminal(entry: ContextEntry<L, C>, error?: unknown): void {
    const resolve = entry.resolveTerminal;
    const reject = entry.rejectTerminal;
    entry.resolveTerminal = undefined;
    entry.rejectTerminal = undefined;
    if (error === undefined) resolve?.();
    else reject?.(error);
  }

  #claimEnding(entry: ContextEntry<L, C>): Promise<void> {
    entry.state = "ending";
    entry.terminalKind = "normal";
    this.#monitor.ready -= 1;
    this.#monitor.ending += 1;
    const terminal = this.#newTerminal(entry);
    void this.#finishEnding(entry);
    return terminal;
  }

  async #finishEnding(entry: ContextEntry<L, C>): Promise<void> {
    let resetError: unknown;
    this.#monitor.resetCalls += 1;
    try {
      await this.#bounded(
        "session context reset",
        (signal) => {
          const context: SessionContextCleanupContext = Object.freeze({
            token: entry.token,
            signal,
          });
          return this.#leases.reset(entry.lease, entry.resource, context);
        },
        { abortOnRetire: true },
      );
    } catch (error) {
      resetError = error;
      this.#monitor.resetFailures += 1;
    }

    let releaseError: unknown;
    const reusable = resetError === undefined && this.#state === "open";
    const reason: SessionContextReleaseReason =
      resetError !== undefined
        ? "reset-failed"
        : reusable
          ? "context-end"
          : "runtime-retire";
    try {
      await this.#releaseEntry(entry, reusable, reason);
    } catch (error) {
      releaseError = error;
    } finally {
      this.#closeEntry(entry, "ending");
    }

    let terminalError: unknown;
    if (resetError !== undefined && releaseError !== undefined) {
      terminalError = asCleanupFailure(
        resetError,
        releaseError,
        "session context reset and eviction both failed",
      );
    } else {
      terminalError = resetError ?? releaseError;
    }
    this.#settleTerminal(entry, terminalError);
  }

  #claimFatal(entry: ContextEntry<L, C>, cause: unknown): Promise<void> {
    entry.state = "fatal";
    entry.terminalKind = "fatal";
    this.#monitor.ready -= 1;
    this.#monitor.references -= entry.references;
    entry.references = 0;
    this.#monitor.fatalCleaning += 1;
    this.#monitor.fatalRemovals += 1;
    const terminal = this.#newTerminal(entry);
    void this.#finishFatal(entry, cause);
    return terminal;
  }

  async #finishFatal(entry: ContextEntry<L, C>, cause: unknown): Promise<void> {
    let releaseError: unknown;
    try {
      await this.#releaseEntry(entry, false, "fatal-operation");
    } catch (error) {
      releaseError = error;
    } finally {
      // Keep the terminal in #entries through notification so a concurrent
      // retire waits for the bounded owner callback too.
      this.#closeEntry(entry, "fatal", true);
    }
    await this.#notifyFatal(entry, cause);
    this.#entries.delete(entry);
    this.#settleTerminal(entry, releaseError);
  }

  #claimRetiring(entry: ContextEntry<L, C>): Promise<void> {
    entry.state = "retiring";
    entry.terminalKind = "retired";
    this.#monitor.ready -= 1;
    this.#monitor.retiring += 1;
    this.#monitor.references -= entry.references;
    entry.references = 0;
    return this.#newTerminal(entry);
  }

  #startRetiring(entry: ContextEntry<L, C>): void {
    void this.#finishRetiring(entry);
  }

  async #finishRetiring(entry: ContextEntry<L, C>): Promise<void> {
    let releaseError: unknown;
    try {
      // Avoid an `await undefined` yield: an idle/lost-token context should
      // enter physical eviction in the same retirement turn. Active contexts
      // still wait for their already-bounded operation to relinquish access.
      if (entry.operationDone !== undefined) await entry.operationDone;
      await this.#releaseEntry(entry, false, "runtime-retire");
    } catch (error) {
      releaseError = error;
    } finally {
      this.#closeEntry(entry, "retiring");
    }
    this.#settleTerminal(entry, releaseError);
  }

  async #notifyFatal(
    entry: ContextEntry<L, C>,
    cause: unknown,
  ): Promise<void> {
    const onFatal = this.#onFatal;
    if (entry.ownerNotified || onFatal === undefined) return;
    entry.ownerNotified = true;
    this.#monitor.ownerNotifications += 1;
    try {
      await this.#bounded(
        "fatal owner notification",
        (signal) => {
          const event: SessionContextFatalEvent = Object.freeze({
            token: entry.token,
            cause,
            signal,
          });
          return Promise.resolve(
            safeApply(onFatal, this.#onFatalReceiver, [event]),
          );
        },
        { abortOnRetire: true },
      );
    } catch {
      // Observer failure cannot resurrect or change the fatal disposition.
      this.#monitor.ownerNotificationFailures += 1;
    }
  }

  async #releaseEntry(
    entry: ContextEntry<L, C>,
    reusable: boolean,
    reason: SessionContextReleaseReason,
  ): Promise<void> {
    if (entry.releaseClaimed) return;
    // Claim before crossing the adapter boundary. No race can invoke release
    // twice, even when the first call times out or reenters retire().
    entry.releaseClaimed = true;
    await this.#releaseLease(
      entry.lease,
      reusable,
      reason,
      entry.token,
    );
  }

  async #releaseLease(
    lease: L,
    reusable: boolean,
    reason: SessionContextReleaseReason,
    token: SessionContextToken,
  ): Promise<void> {
    try {
      await this.#bounded(
        `session lease release (${reason})`,
        (signal) => {
          // The scheduler is an external/reentrant boundary. Re-check the
          // ownership gate at the last possible instant so it cannot turn a
          // retired generation into a reusable hand-off.
          const effectiveReusable =
            reusable && this.#state === "open" && !signal.aborted;
          const disposition: SessionContextReleaseDisposition = Object.freeze({
            reusable: effectiveReusable,
            reason: effectiveReusable
              ? reason
              : reusable
                ? "runtime-retire"
                : reason,
          });
          if (effectiveReusable) this.#monitor.reusableReleases += 1;
          else this.#monitor.evictions += 1;
          const context: SessionContextCleanupContext = Object.freeze({
            token,
            signal,
          });
          return this.#leases.release(lease, disposition, context);
        },
        // Eviction must continue during retirement. A reusable hand-off is
        // instead aborted so the adapter cannot recycle a retired generation.
        { abortOnRetire: reusable },
      );
    } catch (error) {
      this.#monitor.releaseFailures += 1;
      throw error;
    }
  }

  #closeEntry(
    entry: ContextEntry<L, C>,
    prior: "ending" | "retiring" | "fatal",
    retainForNotification = false,
  ): void {
    if (entry.physicallyClosed) return;
    entry.physicallyClosed = true;
    entry.state = "closed";
    if (!retainForNotification) this.#entries.delete(entry);
    if (prior === "ending") this.#monitor.ending -= 1;
    else if (prior === "retiring") this.#monitor.retiring -= 1;
    else this.#monitor.fatalCleaning -= 1;
    this.#monitor.pinnedLeases -= 1;
  }

  async #cleanupLateAcquire(
    value: L,
    token: SessionContextToken,
  ): Promise<void> {
    if (typeof value !== "object" || value === null) return;
    await this.#releaseLease(
      value,
      false,
      this.#state === "open" ? "begin-rollback" : "runtime-retire",
      token,
    );
  }

  #trackLateCleanup(work: void | PromiseLike<void>): void {
    const cleanup = Promise.resolve(work);
    this.#lateCleanups.add(cleanup);
    void cleanup
      .catch(() => undefined)
      .finally(() => this.#lateCleanups.delete(cleanup));
  }

  #readClock(): number {
    const value = this.#scheduler.now();
    if (!Number.isFinite(value) || value < this.#lastClockValue) {
      throw new Error(
        "session context scheduler clock must be finite and monotonic",
      );
    }
    this.#lastClockValue = value;
    return value;
  }

  #abortController(controller: AbortController, reason: unknown): void {
    if (controller.signal.aborted) return;
    try {
      controller.abort(reason);
    } catch {
      // A hostile abort listener cannot reopen ownership or prevent deadlines.
    }
  }

  #bounded<T>(
    label: string,
    invoke: (signal: AbortSignal) => T | PromiseLike<T>,
    options: BoundedOptions<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (options.abortOnRetire) {
      this.#abortOnRetire.add(controller);
      if (this.#state !== "open") {
        this.#abortController(controller, this.#retiredError(label));
      }
    }

    let deadline: number;
    try {
      deadline = this.#readClock() + this.#operationTimeoutMs;
      if (!Number.isFinite(deadline)) {
        throw new Error("session context deadline must be finite");
      }
    } catch (error) {
      this.#abortOnRetire.delete(controller);
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      let timer: SessionContextScheduledTask | undefined;
      let timerGeneration = 0;
      let earlyRearms = 0;

      const finish = (
        outcome: "resolve" | "reject",
        value: T | unknown,
      ): void => {
        if (!active) return;
        active = false;
        timerGeneration += 1;
        const priorTimer = timer;
        timer = undefined;
        try {
          priorTimer?.cancel();
        } catch {
          // A broken cancellation hook cannot keep runtime ownership alive.
        }
        this.#abortOnRetire.delete(controller);
        if (outcome === "resolve") resolve(value as T);
        else reject(value);
      };

      const timeout = (): void => {
        const error = contextError(
          "OPERATION_TIMEOUT",
          `${label} exceeded ${this.#operationTimeoutMs}ms`,
        );
        this.#monitor.boundaryTimeouts += 1;
        this.#abortController(controller, error);
        finish("reject", error);
      };

      const arm = (): void => {
        if (!active) return;
        const remaining = Math.max(0, deadline - this.#readClock());
        const generation = timerGeneration + 1;
        timerGeneration = generation;
        const scheduled = bindScheduledTask(
          this.#scheduler.schedule(remaining, () => {
            if (!active || timerGeneration !== generation) return;
            timer = undefined;
            let nextRemaining: number;
            try {
              nextRemaining = deadline - this.#readClock();
            } catch (error) {
              finish("reject", error);
              return;
            }
            if (nextRemaining <= 0) {
              timeout();
              return;
            }
            earlyRearms += 1;
            if (
              nextRemaining >= remaining ||
              earlyRearms > MAX_EARLY_TIMER_REARMS
            ) {
              finish(
                "reject",
                new Error(
                  "session context scheduler fired before its deadline without bounded progress",
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
                  finish("reject", error);
                }
              }
            });
          }),
        );
        if (!active || timerGeneration !== generation) {
          try {
            scheduled.cancel();
          } catch {
            // Synchronous/reentrant scheduler callbacks leave a stale task.
          }
          return;
        }
        timer = scheduled;
      };

      try {
        arm();
      } catch (error) {
        finish("reject", error);
      }
      if (!active) return;

      let work: Promise<T>;
      try {
        work = Promise.resolve(invoke(controller.signal));
      } catch (error) {
        finish("reject", error);
        return;
      }
      void work.then(
        (value) => {
          if (active) {
            finish("resolve", value);
          } else if (options.onLateFulfilled !== undefined) {
            try {
              this.#trackLateCleanup(options.onLateFulfilled(value));
            } catch {
              // The cleanup method accounts for its own adapter failures. A
              // synchronous policy failure cannot resurrect the late lease.
            }
          }
        },
        (error) => {
          if (active) finish("reject", error);
        },
      );
    });
  }

  async #completeRetirement(
    openings: readonly Promise<void>[],
    terminals: readonly Promise<void>[],
  ): Promise<void> {
    const failures: unknown[] = [];
    const collect = async (work: readonly Promise<void>[]): Promise<void> => {
      const results = await Promise.allSettled(work);
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    };

    await collect([...openings, ...terminals]);
    // Late acquisitions which arrive before logical retirement completes are
    // also converged. A lease arriving after its bounded acquire has timed out
    // is still evicted asynchronously by #bounded's late-fulfillment hook.
    while (this.#lateCleanups.size > 0) {
      await collect([...this.#lateCleanups]);
    }
    this.#state = "retired";

    if (failures.length === 0) {
      this.#resolveRetirement?.();
      return;
    }
    this.#monitor.retireFailures += 1;
    const failure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "session context retirement had multiple cleanup failures",
          );
    this.#rejectRetirement?.(failure);
  }
}
