import { NodeRfcError } from "../client/rfc-errors.js";
import {
  type DirectDestinationOwner,
  type DirectDestinationOwnerMonitor,
} from "../destination/direct-destination-owner.js";
import type { RfcConnectionParameters } from "./connection-parameters.js";
import {
  snapshotDirectConnectionParameters,
  type NormalizedDirectConnection,
} from "./connection-parameters.js";
import { planCompatibilityOwnerRoute } from "./compatibility-owner-route.js";
import {
  bindDirectCompatibilityOwnerFactory,
  productionDirectCompatibilityOwnerFactory,
  type DirectCompatibilityOwnerFactory,
} from "./direct-owner-factory.js";
import {
  Client,
  environment,
  pooledClientAttach,
  pooledClientClaim,
  projectNodeRfcNormalizationError,
  projectNodeRfcPublicError,
  directSessionOptionsFromRfcClientOptions,
  snapshotRfcClientOptions,
  type PooledClientClaim,
  type RfcClientOptions,
} from "./node-rfc-client.js";
import { validateRFCClientConnectionParameterSurface } from
  "./rfc-client-session-route.js";

export interface RfcPoolOptions {
  readonly low: number;
  readonly high: number;
  readonly logLevel?: number;
}

export interface RfcPoolResourceOptions {
  /** Hard cap for the application lane; repository capacity is separate. */
  readonly maxConnections?: number;
  readonly maxWaiters?: number;
  readonly acquireTimeoutMs?: number;
  readonly lifecycleTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly validateOnCheckout?: boolean;
}

export interface RfcPoolConfiguration {
  readonly connectionParameters: RfcConnectionParameters;
  readonly clientOptions?: RfcClientOptions;
  readonly poolOptions?: RfcPoolOptions;
  readonly resourceOptions?: RfcPoolResourceOptions;
}

export interface RfcPoolStatus {
  readonly ready: number;
  readonly leased: number;
}

interface CanonicalResourceOptions {
  readonly maxConnections: number;
  readonly maxWaiters: number;
  readonly acquireTimeoutMs: number;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly validateOnCheckout: boolean;
}

function count(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative integer`);
  }
}

function positive(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${path} must be a positive integer`);
  }
}

function ownDataValue(input: object, name: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new TypeError(`${path}.${name} must be an own data property`);
  }
  return descriptor.value;
}

function snapshotPoolOptions(input: RfcPoolOptions | undefined): RfcPoolOptions {
  if (input === undefined) return Object.freeze({ low: 2, high: 4 });
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("poolOptions must be an object");
  }
  const low = ownDataValue(input, "low", "poolOptions");
  const high = ownDataValue(input, "high", "poolOptions");
  const logLevel = ownDataValue(input, "logLevel", "poolOptions");
  count(low as number, "poolOptions.low");
  count(high as number, "poolOptions.high");
  if ((high as number) < 1 || (low as number) > (high as number)) {
    throw new RangeError("poolOptions must satisfy 0 <= low <= high and high >= 1");
  }
  if (
    logLevel !== undefined &&
    (!Number.isSafeInteger(logLevel) || (logLevel as number) < 0)
  ) {
    throw new RangeError("poolOptions.logLevel must be a non-negative integer");
  }
  return Object.freeze({
    low: low as number,
    high: high as number,
    ...(logLevel === undefined ? {} : { logLevel: logLevel as number }),
  });
}

function snapshotResourceOptions(
  input: RfcPoolResourceOptions | undefined,
): CanonicalResourceOptions {
  if (input !== undefined &&
      (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw new TypeError("resourceOptions must be an object");
  }
  const maxConnections = input === undefined
    ? 32
    : (ownDataValue(input, "maxConnections", "resourceOptions") as
        number | undefined) ?? 32;
  const maxWaiters = input === undefined
    ? 128
    : (ownDataValue(input, "maxWaiters", "resourceOptions") as
        number | undefined) ?? 128;
  const acquireTimeoutMs = input === undefined
    ? 30_000
    : (ownDataValue(input, "acquireTimeoutMs", "resourceOptions") as
        number | undefined) ?? 30_000;
  const lifecycleTimeoutMs = input === undefined
    ? 45_000
    : (ownDataValue(input, "lifecycleTimeoutMs", "resourceOptions") as
        number | undefined) ?? 45_000;
  const shutdownTimeoutMs = input === undefined
    ? 60_000
    : (ownDataValue(input, "shutdownTimeoutMs", "resourceOptions") as
        number | undefined) ?? 60_000;
  const validateOnCheckout = input === undefined
    ? false
    : (ownDataValue(input, "validateOnCheckout", "resourceOptions") as
        boolean | undefined) ?? false;
  positive(maxConnections, "resourceOptions.maxConnections");
  positive(maxWaiters, "resourceOptions.maxWaiters");
  positive(acquireTimeoutMs, "resourceOptions.acquireTimeoutMs");
  positive(lifecycleTimeoutMs, "resourceOptions.lifecycleTimeoutMs");
  positive(shutdownTimeoutMs, "resourceOptions.shutdownTimeoutMs");
  if (typeof validateOnCheckout !== "boolean") {
    throw new TypeError("resourceOptions.validateOnCheckout must be a boolean");
  }
  return Object.freeze({
    maxConnections,
    maxWaiters,
    acquireTimeoutMs,
    lifecycleTimeoutMs,
    shutdownTimeoutMs,
    validateOnCheckout,
  });
}

function withCallback<T>(
  promise: Promise<T>,
  callback: ((error: unknown, result?: T) => void) | undefined,
): Promise<T> | void {
  if (callback === undefined) return promise;
  void promise.then(
    (result) => callback(undefined, result),
    (error: unknown) => callback(error),
  );
}

function validateOptionalCallback(callback: unknown, method: string): void {
  if (callback !== undefined && typeof callback !== "function") {
    throw new TypeError(
      `Pool ${method}() argument, if provided, must be a function`,
    );
  }
}

function aggregateFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

let nextPoolId = 1;
let createOwner = bindDirectCompatibilityOwnerFactory(
  productionDirectCompatibilityOwnerFactory,
);

/** Bounded destination owner with the archived node-rfc Pool façade. */
export class Pool {
  readonly #id = nextPoolId++;
  readonly #connectionParameters: RfcConnectionParameters;
  readonly #clientOptions: RfcClientOptions | undefined;
  readonly #options: RfcPoolOptions;
  readonly #resources: CanonicalResourceOptions;
  readonly #configuration: RfcPoolConfiguration;
  readonly #leased = new Set<Client>();
  readonly #issued = new WeakSet<Client>();
  #owner: DirectDestinationOwner | undefined;
  #normalized: NormalizedDirectConnection | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #readyTail: Promise<void> = Promise.resolve();
  #recycleTail: Promise<void> = Promise.resolve();

  constructor(configuration: RfcPoolConfiguration) {
    if (
      typeof configuration !== "object" ||
      configuration === null ||
      Array.isArray(configuration)
    ) {
      throw new TypeError("Pool requires a configuration object");
    }
    const connectionSource = ownDataValue(
      configuration,
      "connectionParameters",
      "poolConfiguration",
    );
    validateRFCClientConnectionParameterSurface(
      connectionSource as RfcConnectionParameters,
    );
    const connectionParameters = snapshotDirectConnectionParameters(
      connectionSource as RfcConnectionParameters,
    );
    if (Object.keys(connectionParameters).length === 0) {
      throw new TypeError("Client connection parameters missing");
    }
    const clientOptions = snapshotRfcClientOptions(
      ownDataValue(configuration, "clientOptions", "poolConfiguration") as
        RfcClientOptions | undefined,
    );
    const options = snapshotPoolOptions(
      ownDataValue(configuration, "poolOptions", "poolConfiguration") as
        RfcPoolOptions | undefined,
    );
    const resources = snapshotResourceOptions(
      ownDataValue(configuration, "resourceOptions", "poolConfiguration") as
        RfcPoolResourceOptions | undefined,
    );
    if (
      options.low > resources.maxConnections ||
      options.high > resources.maxConnections
    ) {
      throw new RangeError(
        "poolOptions.low and high must not exceed resourceOptions.maxConnections",
      );
    }
    this.#connectionParameters = connectionParameters;
    this.#clientOptions = clientOptions;
    this.#options = options;
    this.#resources = resources;
    this.#configuration = Object.freeze({
      connectionParameters,
      ...(clientOptions === undefined ? {} : { clientOptions }),
      poolOptions: options,
      resourceOptions: resources,
    });
  }

  static get environment(): typeof environment { return environment; }
  get environment(): typeof environment { return environment; }
  /** Compatibility binding without exposing raw pooled resources. */
  get binding(): Pool { return this; }
  get id(): number { return this.#id; }
  get config(): RfcPoolConfiguration { return this.#configuration; }
  get connectionParameters(): RfcConnectionParameters {
    return this.#connectionParameters;
  }
  get clientOptions(): RfcClientOptions | undefined { return this.#clientOptions; }
  get poolOptions(): RfcPoolOptions { return this.#options; }
  get poolConfiguration(): RfcPoolConfiguration { return this.#configuration; }
  get status(): RfcPoolStatus {
    const ready = this.#owner?.monitor().applicationPool.idle ?? 0;
    return Object.freeze({ ready, leased: this.#leased.size });
  }

  #requiredOpen(): void {
    if (this.#closed) throw new NodeRfcError("RFC pool is closed");
  }

  #ensureOwner(): DirectDestinationOwner {
    if (this.#owner !== undefined) return this.#owner;
    this.#requiredOpen();
    let route;
    const session = directSessionOptionsFromRfcClientOptions(
      this.#clientOptions,
    );
    try {
      route = planCompatibilityOwnerRoute(
        this.#connectionParameters,
        session,
      );
    } catch (error) {
      throw projectNodeRfcNormalizationError(error);
    }
    const resources = this.#resources;
    const owner = createOwner({
      connection: route.connection,
      ...(route.sessionFactory === undefined
        ? {}
        : { sessionFactory: route.sessionFactory }),
      applicationPool: {
        maxConnections: resources.maxConnections,
        maxWaiters: resources.maxWaiters,
        acquireTimeoutMs: resources.acquireTimeoutMs,
        lifecycleTimeoutMs: resources.lifecycleTimeoutMs,
        shutdownTimeoutMs: resources.shutdownTimeoutMs,
        lowWater: 0,
        // Public high is an idle-retention policy. The owner hard bound stays
        // independent so explicit ready(n) can retain n > high.
        idleHigh: resources.maxConnections,
        validateOnCheckout: resources.validateOnCheckout,
        ...(this.#clientOptions?.diagnostics === undefined
          ? {}
          : { diagnostics: this.#clientOptions.diagnostics }),
      },
      repositoryPool: {
        maxConnections: Math.min(2, resources.maxConnections),
        maxWaiters: resources.maxWaiters,
        acquireTimeoutMs: resources.acquireTimeoutMs,
        lifecycleTimeoutMs: resources.lifecycleTimeoutMs,
        shutdownTimeoutMs: resources.shutdownTimeoutMs,
        lowWater: 0,
        idleHigh: Math.min(2, resources.maxConnections),
        validateOnCheckout: resources.validateOnCheckout,
        ...(this.#clientOptions?.diagnostics === undefined
          ? {}
          : { diagnostics: this.#clientOptions.diagnostics }),
      },
      ...(this.#clientOptions?.diagnostics === undefined
        ? {}
        : { metadata: { diagnostics: this.#clientOptions.diagnostics } }),
      ...(session === undefined ? {} : { session }),
    });
    this.#normalized = route.connection;
    this.#owner = owner;
    return owner;
  }

  #queueReady(operation: () => Promise<void>): Promise<void> {
    const pending = this.#readyTail.then(operation, operation);
    this.#readyTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #growReadyTo(requested: number): Promise<void> {
    this.#requiredOpen();
    if (requested === 0) return;
    if (requested > this.#resources.maxConnections) {
      throw new RangeError(
        `ready count must not exceed ${this.#resources.maxConnections}`,
      );
    }
    const owner = this.#ensureOwner();
    const current = owner.monitor().applicationPool.idle;
    const missing = Math.max(0, requested - current);
    if (missing === 0) return;
    // Hold every currently idle lease while creating the missing capacity.
    // Acquiring only `missing` consumes the existing idle leases first, so a
    // 2 -> 5 growth would open one connection and settle at three idle.
    const leases = await owner.acquireApplications(requested);
    if (this.#closed) {
      await Promise.allSettled(
        leases.map((lease) =>
          owner.releaseApplication(lease, { reusable: false })),
      );
      throw new NodeRfcError("RFC pool is closed");
    }
    const released = await Promise.allSettled(
      leases.map((lease) => owner.releaseApplication(lease, { reusable: true })),
    );
    const failures = released
      .filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )
      .map((result) => result.reason);
    aggregateFailures(failures, "RFC pool ready failed");
  }

  async #maintainLow(): Promise<void> {
    if (this.#closed || this.#options.low === 0) return;
    const owner = this.#owner;
    if (owner === undefined) return;
    const monitor = owner.monitor().applicationPool;
    const availableForIdle = Math.max(
      0,
      this.#resources.maxConnections - monitor.leased,
    );
    const target = Math.min(this.#options.low, availableForIdle);
    if (target > monitor.idle) await this.#growReadyTo(target);
  }

  #scheduleLowMaintenance(): void {
    if (this.#closed || this.#options.low === 0) return;
    const maintenance = this.#queueReady(() => this.#maintainLow());
    // The acquired clients remain valid if an opportunistic low-water refill
    // fails. The owner monitor retains the creation failure evidence.
    void maintenance.catch(() => undefined);
  }

  ready(
    arg1?: number | ((error: unknown) => void),
    arg2?: number | ((error: unknown) => void),
  ): Promise<void> | void {
    let requested = this.#options.low;
    let callback: ((error: unknown) => void) | undefined;
    if (typeof arg1 === "number") {
      requested = arg1;
      if (arg2 !== undefined && typeof arg2 !== "function") {
        throw new TypeError("Pool ready() second argument must be a function");
      }
      callback = arg2 as ((error: unknown) => void) | undefined;
    } else if (typeof arg1 === "function") {
      callback = arg1;
      if (arg2 !== undefined && typeof arg2 !== "number") {
        throw new TypeError("Pool ready() second argument must be a number");
      }
      requested = (arg2 as number | undefined) ?? requested;
    } else if (arg1 !== undefined) {
      throw new TypeError("Pool ready() first argument must be a number or function");
    }
    count(requested, "ready count");
    const promise = this.#queueReady(() => this.#growReadyTo(requested)).catch(
      (error: unknown) => { throw projectNodeRfcPublicError(error); },
    );
    return withCallback(promise, callback);
  }

  acquire(
    arg1?: number | ((error: unknown, result?: Client | Client[]) => void),
    arg2?: number | ((error: unknown, result?: Client | Client[]) => void),
  ): Promise<Client | Client[]> | void {
    let requested = 1;
    let callback:
      ((error: unknown, result?: Client | Client[]) => void) | undefined;
    if (typeof arg1 === "number") {
      requested = arg1;
      if (arg2 !== undefined && typeof arg2 !== "function") {
        throw new TypeError("Pool acquire() second argument must be a function");
      }
      callback = arg2 as typeof callback;
    } else if (typeof arg1 === "function") {
      callback = arg1;
      if (arg2 !== undefined && typeof arg2 !== "number") {
        throw new TypeError("Pool acquire() second argument must be a number");
      }
      requested = (arg2 as number | undefined) ?? requested;
    } else if (arg1 !== undefined) {
      throw new TypeError("Pool acquire() first argument must be a number or function");
    }
    count(requested, "acquire count");
    if (requested < 1) throw new RangeError("acquire count must be at least one");
    if (requested > this.#resources.maxConnections) {
      throw new RangeError(
        `acquire count must not exceed ${this.#resources.maxConnections}`,
      );
    }
    const promise = (async (): Promise<Client | Client[]> => {
      this.#requiredOpen();
      const owner = this.#ensureOwner();
      const leases = await owner.acquireApplications(requested);
      const clients: Client[] = [];
      try {
        for (const lease of leases) {
          const info = await owner.applicationInfo(lease);
          const client = new Client(
            this.#connectionParameters,
            this.#clientOptions,
            {
              poolId: this.#id,
              release: (released) => this.release(released) as Promise<void>,
            },
          );
          const connection = this.#normalized;
          if (connection === undefined) {
            throw new Error("RFC pool owner route was not initialized");
          }
          client[pooledClientAttach]({ owner, lease, info, connection });
          this.#issued.add(client);
          clients.push(client);
        }
        if (this.#closed) throw new NodeRfcError("RFC pool is closed");
        for (const client of clients) this.#leased.add(client);
      } catch (primary) {
        const cleanup = await Promise.allSettled(
          leases.map((lease) =>
            owner.releaseApplication(lease, { reusable: false })),
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
            "RFC pool acquire and cleanup failed",
            { cause: primary },
          );
        }
        throw primary;
      }
      this.#scheduleLowMaintenance();
      return requested === 1 ? clients[0]! : clients;
    })().catch((error: unknown) => {
      throw projectNodeRfcPublicError(error);
    });
    return withCallback(promise, callback);
  }

  #validateReleaseBatch(clients: readonly Client[]): void {
    const seen = new Set<Client>();
    for (const client of clients) {
      if (!(client instanceof Client)) {
        throw new TypeError("Pool release expects Client instances");
      }
      if (seen.has(client)) {
        throw new TypeError("Pool release contains the same client more than once");
      }
      seen.add(client);
      if (!this.#leased.has(client)) {
        if (this.#issued.has(client)) {
          throw new NodeRfcError(
            "Client release() invoked for already closed client",
          );
        }
        throw new TypeError("Pool release expects a client leased by this pool");
      }
    }
  }

  #queueRecycle(operation: () => Promise<void>): Promise<void> {
    const pending = this.#recycleTail.then(operation, operation);
    this.#recycleTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #recycleClaim(claim: PooledClientClaim): Promise<void> {
    const lease = claim.lease;
    if (lease === undefined) return;
    await claim.tail;
    if (this.#closed) {
      await claim.owner.releaseApplication(lease, { reusable: false });
      return;
    }
    const monitor = claim.owner.monitor().applicationPool;
    const reusable = claim.reusableAfterTail() &&
      (monitor.waiting > 0 || monitor.idle < this.#options.high);
    await claim.owner.releaseApplication(lease, {
      reusable,
      reset: reusable,
      ...(reusable ? { idleHigh: this.#options.high } : {}),
    });
  }

  release(
    value: Client | readonly Client[],
    callback?: (error: unknown) => void,
  ): Promise<void> | void {
    validateOptionalCallback(callback, "release");
    const clients = Array.isArray(value) ? [...value] : [value];
    try {
      this.#validateReleaseBatch(clients);
    } catch (error) {
      return withCallback(Promise.reject(error), callback);
    }
    const claims: PooledClientClaim[] = [];
    for (const client of clients) {
      claims.push(client[pooledClientClaim](false));
      this.#leased.delete(client);
    }
    const promise = this.#queueRecycle(async () => {
      const failures: unknown[] = [];
      // Reconcile high after each handoff so a batch cannot observe the same
      // stale idle count and retain every returned connection.
      for (const claim of claims) {
        try {
          await this.#recycleClaim(claim);
        } catch (error) {
          failures.push(error);
        }
      }
      // Low-water replenishment is opportunistic. Ownership transfer and
      // reset/eviction above are authoritative; a later create failure must
      // not make callers retry a client that is already invalidated.
      this.#scheduleLowMaintenance();
      aggregateFailures(failures, "RFC pool release failed");
    }).catch((error: unknown) => {
      throw projectNodeRfcPublicError(error);
    });
    return withCallback(promise, callback);
  }

  cancel(client: Client, callback?: (error: unknown) => void): Promise<void> | void {
    validateOptionalCallback(callback, "cancel");
    if (!this.#leased.has(client)) {
      throw new TypeError("Pool cancel expects a currently leased client");
    }
    return client.cancel(callback);
  }

  closeAll(callback?: (error: unknown) => void): Promise<void> | void {
    validateOptionalCallback(callback, "closeAll");
    if (this.#closePromise !== undefined) {
      return withCallback(this.#closePromise, callback);
    }
    this.#closed = true;
    const clients = [...this.#leased];
    this.#leased.clear();
    const claims: PooledClientClaim[] = [];
    for (const client of clients) {
      try {
        claims.push(client[pooledClientClaim](true));
      } catch {
        // A concurrently claimed wrapper no longer owns a physical lease.
      }
    }
    const owner = this.#owner;
    const closing = (async (): Promise<void> => {
      const failures: unknown[] = [];
      // Retirement closes the pool admission gate and aborts a physical
      // create immediately. In particular, a message-server lookup must not
      // keep shutdown waiting for its ordinary lifecycle timeout.
      const retirement = owner?.retire();
      void retirement?.catch(() => undefined);
      const released = await Promise.allSettled(
        claims.map((claim) => claim.lease === undefined
          ? Promise.resolve()
          : claim.tail.then(() =>
              claim.owner.releaseApplication(claim.lease!, { reusable: false }))),
      );
      for (const result of released) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      // A release claimed just before shutdown owns its lease outside
      // #leased. Let that reset/release handoff and any ready growth converge
      // before retiring the shared owner.
      await Promise.all([this.#recycleTail, this.#readyTail]);
      if (retirement !== undefined) {
        try {
          await retirement;
        } catch (error) {
          failures.push(error);
        }
      }
      aggregateFailures(failures, "RFC pool shutdown failed");
    })().catch((error: unknown) => {
      throw projectNodeRfcPublicError(error);
    });
    this.#closePromise = closing;
    return withCallback(closing, callback);
  }

  monitor(): DirectDestinationOwnerMonitor {
    return this.#ensureOwner().monitor();
  }
}

/** Internal deterministic seam used by façade contract tests. */
export function bindPoolDestinationOwnerFactory(
  factory: DirectCompatibilityOwnerFactory,
): () => void {
  const previous = createOwner;
  createOwner = bindDirectCompatibilityOwnerFactory(factory);
  return () => {
    createOwner = previous;
  };
}
