import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionPoolRuntime,
  ConnectionPoolRuntimeError,
  type ConnectionCreationContext,
  type ConnectionPoolLifecycleContext,
  type ConnectionPoolAcquireOptions,
  type ConnectionPoolFactory,
  type ConnectionPoolLease,
  type ConnectionPoolMonitor,
  type ConnectionPoolRuntimeOptions,
  type ConnectionPoolScheduledTask,
  type ConnectionPoolScheduler,
} from "../src/pool/connection-pool-runtime.js";

interface TestConnection {
  readonly id: number;
  healthy: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeScheduler implements ConnectionPoolScheduler {
  #now = 0;
  #sequence = 0;
  readonly #tasks: Array<{
    readonly due: number;
    readonly sequence: number;
    readonly callback: () => void;
    canceled: boolean;
  }> = [];

  now(): number {
    return this.#now;
  }

  schedule(
    delayMs: number,
    callback: () => void,
  ): ConnectionPoolScheduledTask {
    const task = {
      due: this.#now + delayMs,
      sequence: this.#sequence++,
      callback,
      canceled: false,
    };
    this.#tasks.push(task);
    return Object.freeze({
      cancel: () => {
        task.canceled = true;
      },
    });
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      const next = this.#tasks
        .filter((task) => !task.canceled && task.due <= target)
        .sort((left, right) =>
          left.due === right.due
            ? left.sequence - right.sequence
            : left.due - right.due,
        )[0];
      if (next === undefined) break;
      next.canceled = true;
      this.#now = next.due;
      next.callback();
    }
    this.#now = target;
  }
}

class ControlledFactory implements ConnectionPoolFactory<TestConnection> {
  readonly creates: Array<{
    readonly context: ConnectionCreationContext;
    readonly result: Deferred<TestConnection>;
  }> = [];
  readonly destroyed: TestConnection[] = [];
  readonly validated: TestConnection[] = [];
  readonly resetCalls: TestConnection[] = [];
  validateImplementation?: (
    connection: TestConnection,
  ) => boolean | PromiseLike<boolean>;
  resetImplementation?: (
    connection: TestConnection,
  ) => void | PromiseLike<void>;
  destroyImplementation?: (
    connection: TestConnection,
  ) => void | PromiseLike<void>;

  create(context: ConnectionCreationContext): Promise<TestConnection> {
    const result = deferred<TestConnection>();
    this.creates.push({ context, result });
    return result.promise;
  }

  async destroy(connection: TestConnection): Promise<void> {
    this.destroyed.push(connection);
    await this.destroyImplementation?.(connection);
  }

  async validate(connection: TestConnection): Promise<boolean> {
    this.validated.push(connection);
    return (await this.validateImplementation?.(connection)) ?? connection.healthy;
  }

  async reset(connection: TestConnection): Promise<void> {
    this.resetCalls.push(connection);
    await this.resetImplementation?.(connection);
  }
}

function connection(id: number, healthy = true): TestConnection {
  return { id, healthy };
}

async function turns(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function until(
  predicate: () => boolean,
  message: string,
  limit = 100,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: ConnectionPoolRuntimeError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof ConnectionPoolRuntimeError && error.code === code,
  );
}

function withLease<R>(
  pool: ConnectionPoolRuntime<TestConnection>,
  lease: ConnectionPoolLease<TestConnection>,
  operation: (resource: TestConnection) => R | PromiseLike<R>,
): Promise<R> {
  return pool.withActiveLease(lease, operation);
}

function assertReconciled(monitor: ConnectionPoolMonitor): void {
  assert.equal(Object.isFrozen(monitor), true);
  assert.equal(
    monitor.connections,
    monitor.idle +
      monitor.leased +
      monitor.creating +
      monitor.validating +
      monitor.resetting +
      monitor.closing,
  );
  assert.equal(monitor.connections <= monitor.maxConnections, true);
  assert.equal(monitor.waiting <= monitor.maxWaiters, true);
}

function immediatePool(
  overrides: Partial<{
    maxConnections: number;
    maxWaiters: number;
    lowWater: number;
    idleHigh: number;
    acquireTimeoutMs: number;
  }> = {},
): {
  readonly pool: ConnectionPoolRuntime<TestConnection>;
  readonly scheduler: FakeScheduler;
  readonly destroyed: TestConnection[];
} {
  const scheduler = new FakeScheduler();
  const destroyed: TestConnection[] = [];
  let next = 1;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy: (resource) => {
        destroyed.push(resource);
      },
    },
    maxConnections: overrides.maxConnections ?? 3,
    maxWaiters: overrides.maxWaiters ?? 8,
    acquireTimeoutMs: overrides.acquireTimeoutMs ?? 1_000,
    lowWater: overrides.lowWater ?? 0,
    idleHigh: overrides.idleHigh ?? overrides.maxConnections ?? 3,
    scheduler,
  });
  return { pool, scheduler, destroyed };
}

test("validates finite independent resource-policy boundaries", async () => {
  const factory: ConnectionPoolFactory<TestConnection> = {
    create: () => connection(1),
    destroy() {},
  };
  const scheduler = new FakeScheduler();
  assert.throws(
    () =>
      new ConnectionPoolRuntime({
        factory,
        maxConnections: 0,
        maxWaiters: 1,
        acquireTimeoutMs: 1,
        scheduler,
      }),
    /maxConnections/,
  );
  assert.throws(
    () =>
      new ConnectionPoolRuntime({
        factory,
        maxConnections: 1,
        maxWaiters: 0,
        acquireTimeoutMs: 1,
        scheduler,
    }),
    /maxWaiters/,
  );
  assert.throws(
    () =>
      new ConnectionPoolRuntime({
        factory,
        maxConnections: 1,
        maxWaiters: 1,
        acquireTimeoutMs: 0,
        scheduler,
    }),
    /acquireTimeoutMs/,
  );
  for (const [field, value] of [
    ["lifecycleTimeoutMs", { lifecycleTimeoutMs: 0 }],
    ["shutdownTimeoutMs", { shutdownTimeoutMs: Number.POSITIVE_INFINITY }],
  ] as const) {
    assert.throws(
      () =>
        new ConnectionPoolRuntime({
          factory,
          maxConnections: 1,
          maxWaiters: 1,
          acquireTimeoutMs: 1,
          ...value,
          scheduler,
        }),
      new RegExp(field),
    );
  }
  for (const [field, value] of [
    ["lowWater", { lowWater: null }],
    ["idleHigh", { idleHigh: null }],
    ["scheduler", { scheduler: null }],
    ["lifecycleScheduler", { lifecycleScheduler: null }],
  ] as const) {
    assert.throws(
      () =>
        new ConnectionPoolRuntime({
          factory,
          maxConnections: 1,
          maxWaiters: 1,
          acquireTimeoutMs: 1,
          ...value,
        } as never),
      new RegExp(field),
    );
  }
  assert.throws(
    () =>
      new ConnectionPoolRuntime({
        factory,
        maxConnections: 2,
        maxWaiters: 1,
        acquireTimeoutMs: 1,
        lowWater: 2,
        idleHigh: 1,
        scheduler,
      }),
    /lowWater must not exceed idleHigh/,
  );
  assert.throws(
    () =>
      new ConnectionPoolRuntime({
        factory,
        maxConnections: 1,
        maxWaiters: 1,
        acquireTimeoutMs: 1,
        validateOnCheckout: true,
        scheduler,
      }),
    /factory\.validate/,
  );
  assert.throws(
    () =>
      new ConnectionPoolRuntime({
        factory,
        maxConnections: 1,
        maxWaiters: 1,
        acquireTimeoutMs: 1,
        resetOnRelease: true,
        scheduler,
      }),
    /factory\.reset/,
  );

  let creates = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => {
        creates += 1;
        return connection(creates);
      },
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 1,
    scheduler,
  });
  const aborted = new AbortController();
  aborted.abort();
  await rejectsWithCode(
    pool.acquireOne({ signal: aborted.signal }),
    "ACQUIRE_ABORTED",
  );
  assert.equal(creates, 0);
  assert.equal(pool.monitor().waiting, 0);

  await assert.rejects(
    pool.acquireOne({ timeoutMs: 0 }),
    /acquire timeoutMs/,
  );
  await assert.rejects(
    pool.acquireOne({ timeoutMs: null } as never),
    /acquire timeoutMs/,
  );
  assert.equal(creates, 0);
  assert.equal(pool.monitor().waiting, 0);
  await pool.close();
});

test("snapshots every constructor option and external method exactly once", async () => {
  const reads = new Map<string, number>();
  const calls: string[] = [];
  const bindReads: string[] = [];
  const monitorBind = (name: string, operation: object): void => {
    Object.defineProperty(operation, "bind", {
      configurable: true,
      get() {
        bindReads.push(name);
        return Function.prototype.bind;
      },
    });
  };
  const once = <T>(name: string, first: T, later: T): T => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    return count === 1 ? first : later;
  };
  const firstCreate = (): TestConnection => {
    calls.push("first:create");
    return connection(1);
  };
  const laterCreate = (): TestConnection => {
    calls.push("later:create");
    return connection(91);
  };
  const firstDestroy = (): void => {
    calls.push("first:destroy");
  };
  const laterDestroy = (): void => {
    calls.push("later:destroy");
  };
  const firstValidate = (): boolean => {
    calls.push("first:validate");
    return true;
  };
  const laterValidate = (): boolean => {
    calls.push("later:validate");
    return true;
  };
  const firstReset = (): void => {
    calls.push("first:reset");
  };
  const laterReset = (): void => {
    calls.push("later:reset");
  };
  monitorBind("factory.create", firstCreate);
  monitorBind("factory.destroy", firstDestroy);
  monitorBind("factory.validate", firstValidate);
  monitorBind("factory.reset", firstReset);
  const firstFactory: ConnectionPoolFactory<TestConnection> = {
    get create() {
      return once("factory.create", firstCreate, laterCreate);
    },
    get destroy() {
      return once("factory.destroy", firstDestroy, laterDestroy);
    },
    get validate() {
      return once("factory.validate", firstValidate, laterValidate);
    },
    get reset() {
      return once("factory.reset", firstReset, laterReset);
    },
  };
  const replacementFactory: ConnectionPoolFactory<TestConnection> = {
    create() {
      calls.push("replacement:create");
      return connection(92);
    },
    destroy() {
      calls.push("replacement:destroy");
    },
    validate() {
      calls.push("replacement:validate");
      return true;
    },
    reset() {
      calls.push("replacement:reset");
    },
  };
  const firstNow = (): number => {
    calls.push("first:now");
    return 0;
  };
  const laterNow = (): number => {
    calls.push("later:now");
    return 0;
  };
  const firstSchedule = (
    _delayMs: number,
    _callback: () => void,
  ): ConnectionPoolScheduledTask => {
    calls.push("first:schedule");
    return Object.freeze({ cancel() {} });
  };
  const laterSchedule = (
    _delayMs: number,
    _callback: () => void,
  ): ConnectionPoolScheduledTask => {
    calls.push("later:schedule");
    return Object.freeze({ cancel() {} });
  };
  monitorBind("scheduler.now", firstNow);
  monitorBind("scheduler.schedule", firstSchedule);
  const firstScheduler: ConnectionPoolScheduler = {
    get now() {
      return once("scheduler.now", firstNow, laterNow);
    },
    get schedule() {
      return once("scheduler.schedule", firstSchedule, laterSchedule);
    },
  };
  const replacementScheduler: ConnectionPoolScheduler = {
    now() {
      calls.push("replacement:now");
      return 0;
    },
    schedule() {
      calls.push("replacement:schedule");
      return Object.freeze({ cancel() {} });
    },
  };
  const options: ConnectionPoolRuntimeOptions<TestConnection> = {
    get factory() {
      return once("options.factory", firstFactory, replacementFactory);
    },
    get maxConnections() {
      return once("options.maxConnections", 1, 2);
    },
    get maxWaiters() {
      return once("options.maxWaiters", 1, 2);
    },
    get acquireTimeoutMs() {
      return once("options.acquireTimeoutMs", 100, 200);
    },
    get lifecycleTimeoutMs() {
      return once("options.lifecycleTimeoutMs", 80, 180);
    },
    get shutdownTimeoutMs() {
      return once("options.shutdownTimeoutMs", 90, 190);
    },
    get lifecycleScheduler() {
      return once<ConnectionPoolScheduler | undefined>(
        "options.lifecycleScheduler",
        undefined,
        replacementScheduler,
      );
    },
    get lowWater() {
      return once("options.lowWater", 0, 1);
    },
    get idleHigh() {
      return once("options.idleHigh", 1, 2);
    },
    get validateOnCheckout() {
      return once("options.validateOnCheckout", true, false);
    },
    get resetOnRelease() {
      return once("options.resetOnRelease", true, false);
    },
    get scheduler() {
      return once(
        "options.scheduler",
        firstScheduler,
        replacementScheduler,
      );
    },
  };

  const pool = new ConnectionPoolRuntime(options);
  const lease = await pool.acquireOne();
  assert.deepEqual(Object.keys(lease).sort(), ["generation", "poolId"]);
  assert.equal(await withLease(pool, lease, (resource) => resource.id), 1);
  await pool.release(lease);
  await pool.close();

  assert.deepEqual(
    {
      maxConnections: pool.monitor().maxConnections,
      maxWaiters: pool.monitor().maxWaiters,
      lifecycleTimeoutMs: pool.monitor().lifecycleTimeoutMs,
      shutdownTimeoutMs: pool.monitor().shutdownTimeoutMs,
      lowWater: pool.monitor().lowWater,
      idleHigh: pool.monitor().idleHigh,
    },
    {
      maxConnections: 1,
      maxWaiters: 1,
      lifecycleTimeoutMs: 80,
      shutdownTimeoutMs: 90,
      lowWater: 0,
      idleHigh: 1,
    },
  );
  assert.deepEqual(
    calls.filter(
      (call) =>
        call.endsWith(":create") ||
        call.endsWith(":validate") ||
        call.endsWith(":reset") ||
        call.endsWith(":destroy"),
    ),
    ["first:create", "first:validate", "first:reset", "first:destroy"],
  );
  assert.equal(calls.some((call) => call.startsWith("later:")), false);
  assert.equal(calls.some((call) => call.startsWith("replacement:")), false);
  assert.deepEqual(bindReads, []);
  for (const field of [
    "options.factory",
    "options.maxConnections",
    "options.maxWaiters",
    "options.acquireTimeoutMs",
    "options.lifecycleTimeoutMs",
    "options.shutdownTimeoutMs",
    "options.lifecycleScheduler",
    "options.lowWater",
    "options.idleHigh",
    "options.validateOnCheckout",
    "options.resetOnRelease",
    "options.scheduler",
    "factory.create",
    "factory.destroy",
    "factory.validate",
    "factory.reset",
    "scheduler.now",
    "scheduler.schedule",
  ]) {
    assert.equal(reads.get(field), 1, field);
  }
});

test("separates hard capacity from archived idle-high recycling semantics", async () => {
  const { pool, destroyed } = immediatePool({
    maxConnections: 3,
    idleHigh: 1,
  });
  const leases = await pool.acquire(3);
  assert.equal(leases.length, 3);
  assert.equal(Object.isFrozen(leases), true);
  assert.equal(leases.every((lease) => Object.isFrozen(lease)), true);
  assert.deepEqual(
    leases.map((lease) => lease.generation),
    [1, 2, 3],
  );
  assert.equal(
    new Set(
      await Promise.all(
        leases.map((lease) => withLease(pool, lease, (resource) => resource)),
      ),
    ).size,
    3,
  );
  assertReconciled(pool.monitor());
  assert.deepEqual(
    {
      connections: pool.monitor().connections,
      idle: pool.monitor().idle,
      leased: pool.monitor().leased,
    },
    { connections: 3, idle: 0, leased: 3 },
  );

  await Promise.all(leases.map((lease) => pool.release(lease)));
  await until(() => pool.monitor().closing === 0, "idle-high evictions finish");
  assert.equal(pool.monitor().idle, 1);
  assert.equal(pool.monitor().connections, 1);
  assert.equal(destroyed.length, 2);
  assertReconciled(pool.monitor());
  await pool.close();
});

test("restores idle-high after concurrent waiter-directed returns", async () => {
  const { pool, destroyed } = immediatePool({
    maxConnections: 3,
    maxWaiters: 2,
    idleHigh: 1,
  });
  const initial = await pool.acquire(3);
  const waiting = pool.acquireOne();
  await until(() => pool.monitor().waiting === 1, "waiter is queued");

  await Promise.all(initial.map((lease) => pool.release(lease)));
  const handedOff = await waiting;
  await until(
    () => pool.monitor().closing === 0,
    "surplus waiter-directed idle resources are evicted",
  );
  assert.deepEqual(
    {
      idle: pool.monitor().idle,
      leased: pool.monitor().leased,
      connections: pool.monitor().connections,
    },
    { idle: 1, leased: 1, connections: 2 },
  );

  await pool.release(handedOff);
  await until(() => pool.monitor().closing === 0, "final return is reconciled");
  assert.equal(pool.monitor().idle, 1);
  assert.equal(pool.monitor().connections, 1);
  assert.equal(destroyed.length, 2);
  assertReconciled(pool.monitor());
  await pool.close();
});

test("preserves a per-release idle-high cap when an aborting waiter is validating another resource", async () => {
  const scheduler = new FakeScheduler();
  const validation = deferred<boolean>();
  const destroyed: number[] = [];
  let next = 1;
  let validationCalls = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy: (resource) => {
        destroyed.push(resource.id);
      },
      validate: () => {
        validationCalls += 1;
        return validationCalls <= 2 ? true : validation.promise;
      },
    },
    maxConnections: 2,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    idleHigh: 2,
    validateOnCheckout: true,
    scheduler,
  });

  try {
    const [idleLease, heldLease] = await pool.acquire(2);
    await pool.release(idleLease!);
    assert.deepEqual(
      {
        idle: pool.monitor().idle,
        leased: pool.monitor().leased,
        connections: pool.monitor().connections,
      },
      { idle: 1, leased: 1, connections: 2 },
    );

    const controller = new AbortController();
    const waiting = pool.acquireOne({ signal: controller.signal });
    await until(
      () => pool.monitor().validating === 1,
      "waiter validates the existing idle resource",
    );

    await pool.release(heldLease!, { reusable: true, idleHigh: 1 });
    assert.deepEqual(
      {
        idle: pool.monitor().idle,
        validating: pool.monitor().validating,
        connections: pool.monitor().connections,
      },
      { idle: 1, validating: 1, connections: 2 },
    );

    controller.abort();
    await rejectsWithCode(waiting, "ACQUIRE_ABORTED");
    validation.resolve(true);
    await until(
      () =>
        pool.monitor().validating === 0 && pool.monitor().closing === 0,
      "aborted validation return is reconciled under the release cap",
    );

    assert.deepEqual(
      {
        idle: pool.monitor().idle,
        leased: pool.monitor().leased,
        connections: pool.monitor().connections,
      },
      { idle: 1, leased: 0, connections: 1 },
    );
    assert.equal(destroyed.length, 1);
    assertReconciled(pool.monitor());
  } finally {
    validation.resolve(true);
    await pool.close();
  }
});

test("reconciles a sticky per-release idle-high cap when checkout validation rejects the waiter", async () => {
  const scheduler = new FakeScheduler();
  const validation = deferred<boolean>();
  const destroyed: number[] = [];
  let next = 1;
  let validationCalls = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy: (resource) => {
        destroyed.push(resource.id);
      },
      validate: () => {
        validationCalls += 1;
        return validationCalls <= 3 ? true : validation.promise;
      },
    },
    maxConnections: 3,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 5,
    idleHigh: 3,
    validateOnCheckout: true,
    scheduler,
    lifecycleScheduler: scheduler,
  });

  try {
    const [firstIdle, secondIdle, heldLease] = await pool.acquire(3);
    await pool.release(firstIdle!);
    await pool.release(secondIdle!);

    const waiting = pool.acquireOne();
    await until(
      () => pool.monitor().validating === 1,
      "waiter enters gated checkout validation",
    );
    await pool.release(heldLease!, { reusable: true, idleHigh: 1 });
    assert.deepEqual(
      {
        idle: pool.monitor().idle,
        validating: pool.monitor().validating,
        connections: pool.monitor().connections,
      },
      { idle: 2, validating: 1, connections: 3 },
    );

    scheduler.advance(5);
    await rejectsWithCode(waiting, "LIFECYCLE_TIMEOUT");
    validation.resolve(true);
    await until(
      () =>
        pool.monitor().validating === 0 && pool.monitor().closing === 0,
      "validation failure and sticky cap finish reconciling",
    );

    assert.deepEqual(
      {
        idle: pool.monitor().idle,
        leased: pool.monitor().leased,
        connections: pool.monitor().connections,
        healthFailures: pool.monitor().healthFailures,
        lifecycleTimeouts: pool.monitor().lifecycleTimeouts,
      },
      {
        idle: 1,
        leased: 0,
        connections: 1,
        healthFailures: 1,
        lifecycleTimeouts: 1,
      },
    );
    assert.equal(destroyed.length, 2);
    assertReconciled(pool.monitor());
  } finally {
    validation.resolve(true);
    await pool.close();
  }
});

test("serves waiters FIFO and rejects overload without exceeding capacity", async () => {
  const { pool } = immediatePool({ maxConnections: 1, maxWaiters: 2 });
  const held = await pool.acquireOne();
  const order: string[] = [];
  const first = pool.acquireOne().then((lease) => {
    order.push("first");
    return lease;
  });
  const second = pool.acquireOne().then((lease) => {
    order.push("second");
    return lease;
  });
  await rejectsWithCode(pool.acquireOne(), "POOL_OVERLOADED");
  assert.equal(pool.monitor().waiting, 2);
  assert.equal(pool.monitor().connections, 1);

  await pool.release(held);
  const firstLease = await first;
  assert.deepEqual(order, ["first"]);
  assert.equal(pool.monitor().waiting, 1);
  await pool.release(firstLease);
  const secondLease = await second;
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(secondLease.generation > firstLease.generation, true);
  await pool.release(secondLease);
  assertReconciled(pool.monitor());
  await pool.close();
});

test("removes aborted and timed-out waiters in deterministic FIFO order", async () => {
  const { pool, scheduler } = immediatePool({
    maxConnections: 1,
    maxWaiters: 4,
    acquireTimeoutMs: 100,
  });
  const held = await pool.acquireOne();
  const abortedController = new AbortController();
  const aborted = pool.acquireOne({
    signal: abortedController.signal,
    timeoutMs: 20,
  });
  const timedOut = pool.acquireOne({ timeoutMs: 5 });
  const survivor = pool.acquireOne({ timeoutMs: 30 });

  abortedController.abort();
  scheduler.advance(5);
  await rejectsWithCode(aborted, "ACQUIRE_ABORTED");
  await rejectsWithCode(timedOut, "ACQUIRE_TIMEOUT");
  assert.equal(pool.monitor().waiting, 1);

  await pool.release(held);
  const survivorLease = await survivor;
  assert.equal(survivorLease.generation, 2);
  scheduler.advance(100);
  await pool.release(survivorLease);
  assert.equal(pool.monitor().waiting, 0);
  await pool.close();
});

test("rejects an overdue waiter before dispatch when timer delivery is delayed", async () => {
  let now = 0;
  const scheduled: Array<{
    readonly callback: () => void;
    canceled: boolean;
  }> = [];
  const scheduler: ConnectionPoolScheduler = {
    now: () => now,
    schedule(_delayMs, callback) {
      const task = { callback, canceled: false };
      scheduled.push(task);
      return Object.freeze({
        cancel() {
          task.canceled = true;
        },
      });
    },
  };
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    scheduler,
  });

  const held = await pool.acquireOne();
  const overdue = pool.acquireOne({ timeoutMs: 5 });
  await until(() => pool.monitor().waiting === 1, "overdue waiter is queued");
  now = 10;
  await pool.release(held);

  await rejectsWithCode(overdue, "ACQUIRE_TIMEOUT");
  assert.equal(pool.monitor().leased, 0);
  assert.equal(pool.monitor().idle, 1);
  assert.equal(pool.monitor().waiting, 0);
  assert.equal(scheduled.every(({ canceled }) => canceled), true);
  await pool.close();
});

test("rechecks the deadline after asynchronous checkout validation", async () => {
  let now = 0;
  const scheduled: Array<{ canceled: boolean }> = [];
  const scheduler: ConnectionPoolScheduler = {
    now: () => now,
    schedule() {
      const task = { canceled: false };
      scheduled.push(task);
      return Object.freeze({
        cancel() {
          task.canceled = true;
        },
      });
    },
  };
  const validation = deferred<boolean>();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
      validate: () => validation.promise,
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    validateOnCheckout: true,
    scheduler,
  });

  const overdue = pool.acquireOne({ timeoutMs: 5 });
  await until(
    () => pool.monitor().validating === 1,
    "checkout enters asynchronous validation",
  );
  now = 10;
  validation.resolve(true);

  await rejectsWithCode(overdue, "ACQUIRE_TIMEOUT");
  await until(() => pool.monitor().idle === 1, "candidate returns after timeout");
  assert.equal(pool.monitor().leased, 0);
  assert.equal(pool.monitor().waiting, 0);
  assert.equal(scheduled.every(({ canceled }) => canceled), true);
  await pool.close();
});

test("snapshots mutable acquire options once and closes the registration abort race", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const controller = new AbortController();
  let signalReads = 0;
  let timeoutReads = 0;
  const mutableOptions = Object.defineProperties({}, {
    signal: {
      enumerable: true,
      get() {
        signalReads += 1;
        return controller.signal;
      },
    },
    timeoutMs: {
      enumerable: true,
      get() {
        timeoutReads += 1;
        controller.abort();
        return 10;
      },
    },
  }) as ConnectionPoolAcquireOptions;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    scheduler,
  });

  const acquisition = pool.acquireOne(mutableOptions);
  scheduler.advance(10);
  await rejectsWithCode(acquisition, "ACQUIRE_ABORTED");
  assert.deepEqual({ signalReads, timeoutReads }, { signalReads: 1, timeoutReads: 1 });
  assert.equal(pool.monitor().waiting, 0);
  assert.equal(pool.monitor().creating, 0);
  assert.equal(factory.creates.length, 0);
  await pool.close();
});

test("rechecks abort after listener registration and removes the listener once", async () => {
  const controller = new AbortController();
  let additions = 0;
  let removals = 0;
  const signal = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) {
      additions += 1;
      controller.abort();
      controller.signal.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions | boolean,
    ) {
      removals += 1;
      controller.signal.removeEventListener(type, listener, options);
    },
  } as AbortSignal;
  const { pool, scheduler } = immediatePool({
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
  });

  const acquisition = pool.acquireOne({ signal, timeoutMs: 10 });
  scheduler.advance(10);
  await rejectsWithCode(acquisition, "ACQUIRE_ABORTED");
  assert.deepEqual({ additions, removals }, { additions: 1, removals: 1 });
  assert.equal(pool.monitor().waiting, 0);
  await pool.close();
});

test("snapshots abort-signal methods once without consulting bind", async () => {
  const controller = new AbortController();
  const reads = new Map<string, number>();
  const bindReads: string[] = [];
  let firstAddCalls = 0;
  let firstRemoveCalls = 0;
  let laterAddCalls = 0;
  let laterRemoveCalls = 0;
  const firstAdd = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void => {
    firstAddCalls += 1;
    controller.signal.addEventListener(type, listener, options);
  };
  const firstRemove = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void => {
    firstRemoveCalls += 1;
    controller.signal.removeEventListener(type, listener, options);
  };
  const laterAdd = (): void => {
    laterAddCalls += 1;
  };
  const laterRemove = (): void => {
    laterRemoveCalls += 1;
  };
  for (const [name, operation] of [
    ["addEventListener", firstAdd],
    ["removeEventListener", firstRemove],
  ] as const) {
    Object.defineProperty(operation, "bind", {
      configurable: true,
      get() {
        bindReads.push(name);
        return Function.prototype.bind;
      },
    });
  }
  const signal = {
    get aborted() {
      reads.set("aborted", (reads.get("aborted") ?? 0) + 1);
      return controller.signal.aborted;
    },
    get addEventListener() {
      const count = (reads.get("addEventListener") ?? 0) + 1;
      reads.set("addEventListener", count);
      return count === 1 ? firstAdd : laterAdd;
    },
    get removeEventListener() {
      const count = (reads.get("removeEventListener") ?? 0) + 1;
      reads.set("removeEventListener", count);
      return count === 1 ? firstRemove : laterRemove;
    },
  } as unknown as AbortSignal;
  const { pool } = immediatePool({ maxConnections: 1, maxWaiters: 1 });
  const held = await pool.acquireOne();
  const waiting = pool.acquireOne({ signal });
  await until(() => pool.monitor().waiting === 1, "abort listener is registered");

  controller.abort();
  await rejectsWithCode(waiting, "ACQUIRE_ABORTED");
  assert.deepEqual(
    {
      addReads: reads.get("addEventListener"),
      removeReads: reads.get("removeEventListener"),
      firstAddCalls,
      firstRemoveCalls,
      laterAddCalls,
      laterRemoveCalls,
      bindReads,
    },
    {
      addReads: 1,
      removeReads: 1,
      firstAddCalls: 1,
      firstRemoveCalls: 1,
      laterAddCalls: 0,
      laterRemoveCalls: 0,
      bindReads: [],
    },
  );
  assert.equal(reads.get("aborted"), 2);
  await pool.release(held);
  await pool.close();
});

test("rejects without queueing when monotonic clock access closes the pool", async () => {
  let pool!: ConnectionPoolRuntime<TestConnection>;
  const scheduler: ConnectionPoolScheduler = {
    now() {
      void pool.close();
      throw new Error("clock failed after closing the pool");
    },
    schedule() {
      return Object.freeze({ cancel() {} });
    },
  };
  pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
    scheduler,
  });

  await rejectsWithCode(pool.acquireOne(), "POOL_CLOSED");
  assert.equal(pool.monitor().state, "closed");
  assert.equal(pool.monitor().waiting, 0);
  assert.equal(pool.monitor().creating, 0);
});

test("rechecks waiter capacity after a reentrant scheduler clock", async () => {
  const factory = new ControlledFactory();
  let pool!: ConnectionPoolRuntime<TestConnection>;
  let nested: Promise<ConnectionPoolLease<TestConnection>> | undefined;
  let reentered = false;
  const scheduler: ConnectionPoolScheduler = {
    now() {
      if (!reentered) {
        reentered = true;
        nested = pool.acquireOne();
      }
      return 0;
    },
    schedule() {
      return Object.freeze({ cancel() {} });
    },
  };
  pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
    scheduler,
  });

  await rejectsWithCode(pool.acquireOne(), "POOL_OVERLOADED");
  assert.ok(nested);
  assert.equal(pool.monitor().waiting, 1);
  assertReconciled(pool.monitor());

  await until(() => factory.creates.length === 1, "nested acquire starts creation");
  factory.creates[0]!.result.resolve(connection(1));
  const lease = await nested;
  await pool.release(lease);
  await pool.close();
});

test("removes a settled waiter before a reentrant timeout cancellation hook", async () => {
  let pool!: ConnectionPoolRuntime<TestConnection>;
  let nested: Promise<ConnectionPoolLease<TestConnection>> | undefined;
  let reenterOnCancel = false;
  const scheduler: ConnectionPoolScheduler = {
    now: () => 0,
    schedule() {
      return Object.freeze({
        cancel() {
          if (reenterOnCancel) {
            reenterOnCancel = false;
            nested = pool.acquireOne();
          }
        },
      });
    },
  };
  let next = 1;
  pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
    scheduler,
  });

  const held = await pool.acquireOne();
  const controller = new AbortController();
  const canceled = pool.acquireOne({ signal: controller.signal });
  await until(() => pool.monitor().waiting === 1, "abortable acquire is queued");
  reenterOnCancel = true;
  controller.abort();

  await rejectsWithCode(canceled, "ACQUIRE_ABORTED");
  assert.ok(nested);
  assert.equal(pool.monitor().waiting, 1);
  assertReconciled(pool.monitor());

  await pool.release(held);
  const replacement = await nested;
  await pool.release(replacement);
  await pool.close();
});

test("keeps a synchronously rearmed timeout task reachable for cleanup", async () => {
  let now = 0;
  let scheduleCount = 0;
  const scheduled: Array<{
    readonly id: number;
    readonly delayMs: number;
    canceled: boolean;
  }> = [];
  const scheduler: ConnectionPoolScheduler = {
    now: () => now,
    schedule(delayMs, callback) {
      const task = {
        id: ++scheduleCount,
        delayMs,
        canceled: false,
      };
      scheduled.push(task);
      if (task.id === 2) {
        now = 5;
        callback();
      }
      return Object.freeze({
        cancel() {
          task.canceled = true;
        },
      });
    },
  };
  let next = 1;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 10,
    scheduler,
  });

  const held = await pool.acquireOne();
  const waiting = pool.acquireOne();
  await until(() => scheduled.length === 3, "early callback rearms its timeout");
  assert.deepEqual(
    scheduled.map(({ id, delayMs }) => ({ id, delayMs })),
    [
      { id: 1, delayMs: 10 },
      { id: 2, delayMs: 10 },
      { id: 3, delayMs: 5 },
    ],
  );

  await pool.release(held);
  const lease = await waiting;
  assert.equal(scheduled.every(({ canceled }) => canceled), true);
  await pool.release(lease);
  await pool.close();
});

test("rejects a synchronous early timer without clock progress in bounded work", async () => {
  let schedules = 0;
  let cancellations = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
    scheduler: {
      now: () => 0,
      schedule(_delayMs, callback) {
        schedules += 1;
        callback();
        return Object.freeze({
          cancel() {
            cancellations += 1;
          },
        });
      },
    },
  });

  await assert.rejects(
    pool.acquireOne(),
    /scheduler fired acquire timeout before its deadline/,
  );
  assert.deepEqual(
    {
      schedules,
      cancellations,
      waiting: pool.monitor().waiting,
      creating: pool.monitor().creating,
      connections: pool.monitor().connections,
    },
    {
      schedules: 1,
      cancellations: 1,
      waiting: 0,
      creating: 0,
      connections: 0,
    },
  );
  await pool.close();
});

test("settles when scheduling a queued early-timeout rearm throws", async () => {
  let now = 0;
  let schedules = 0;
  const scheduler: ConnectionPoolScheduler = {
    now: () => now,
    schedule(_delayMs, callback) {
      schedules += 1;
      if (schedules === 2) {
        now = 5;
        callback();
      } else if (schedules === 3) {
        throw new Error("timeout rearm scheduling failed");
      }
      return Object.freeze({ cancel() {} });
    },
  };
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
    scheduler,
  });
  const held = await pool.acquireOne();
  const waiting = pool.acquireOne();

  await assert.rejects(waiting, /timeout rearm scheduling failed/);
  assert.deepEqual(
    {
      schedules,
      waiting: pool.monitor().waiting,
      leased: pool.monitor().leased,
      connections: pool.monitor().connections,
    },
    { schedules: 3, waiting: 0, leased: 1, connections: 1 },
  );
  await pool.release(held);
  await pool.close();
});

test("snapshots scheduled cancellation without reading caller-owned bind", async () => {
  let cancelReads = 0;
  let cancelBindReads = 0;
  let firstCancelCalls = 0;
  let laterCancelCalls = 0;
  const firstCancel = (): void => {
    firstCancelCalls += 1;
  };
  const laterCancel = (): void => {
    laterCancelCalls += 1;
  };
  Object.defineProperty(firstCancel, "bind", {
    configurable: true,
    get() {
      cancelBindReads += 1;
      return Function.prototype.bind;
    },
  });
  const scheduler: ConnectionPoolScheduler = {
    now: () => 0,
    schedule() {
      return {
        get cancel() {
          cancelReads += 1;
          return cancelReads === 1 ? firstCancel : laterCancel;
        },
      };
    },
  };
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    scheduler,
  });

  const lease = await pool.acquireOne();
  assert.deepEqual(
    { cancelReads, cancelBindReads, firstCancelCalls, laterCancelCalls },
    {
      cancelReads: 1,
      cancelBindReads: 0,
      firstCancelCalls: 1,
      laterCancelCalls: 0,
    },
  );
  await pool.release(lease);
  await pool.close();
});

test("never leases after waiter cleanup reentrantly closes the pool", async () => {
  let pool!: ConnectionPoolRuntime<TestConnection>;
  let closeOnCancel = false;
  let closing: Promise<void> | undefined;
  const destroyed: TestConnection[] = [];
  const scheduler: ConnectionPoolScheduler = {
    now: () => 0,
    schedule() {
      return Object.freeze({
        cancel() {
          if (!closeOnCancel) return;
          closeOnCancel = false;
          closing = pool.close();
        },
      });
    },
  };
  pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy(resource) {
        destroyed.push(resource);
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    scheduler,
  });

  const acquisition = pool.acquireOne();
  closeOnCancel = true;
  let unexpectedLease: ConnectionPoolLease<TestConnection> | undefined;
  let acquisitionError: unknown;
  try {
    unexpectedLease = await acquisition;
  } catch (error) {
    acquisitionError = error;
  }
  // Ensure a future regression still tears down its unexpected lease.
  if (unexpectedLease !== undefined) await pool.release(unexpectedLease);
  if (closing === undefined) assert.fail("cleanup did not close the pool");
  await closing;

  assert.equal(
    acquisitionError instanceof ConnectionPoolRuntimeError &&
      acquisitionError.code === "POOL_CLOSED",
    true,
  );
  assert.deepEqual(
    {
      state: pool.monitor().state,
      waiting: pool.monitor().waiting,
      leased: pool.monitor().leased,
      connections: pool.monitor().connections,
      leaseGeneration: pool.monitor().lastLeaseGeneration,
      destroyed: destroyed.map(({ id }) => id),
    },
    {
      state: "closed",
      waiting: 0,
      leased: 0,
      connections: 0,
      leaseGeneration: 0,
      destroyed: [1],
    },
  );
});

test("removes a listener stored after reentrant close during registration", async () => {
  const scheduler = new FakeScheduler();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let pool!: ConnectionPoolRuntime<TestConnection>;
  const signal = {
    aborted: false,
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ): void {
      assert.equal(type, "abort");
      void pool.close();
      listeners.add(listener);
      throw new Error("listener registration failed after closing the pool");
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      assert.equal(type, "abort");
      listeners.delete(listener);
    },
  } as AbortSignal;
  pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 10,
    scheduler,
  });

  await rejectsWithCode(pool.acquireOne({ signal }), "POOL_CLOSED");
  assert.equal(listeners.size, 0);
  assert.equal(pool.monitor().waiting, 0);
  assert.equal(pool.monitor().state, "closed");
});

test("frees creation capacity after synchronous throws and async failures", async () => {
  const scheduler = new FakeScheduler();
  let calls = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create() {
        calls += 1;
        if (calls === 1) throw new Error("synchronous create failure");
        if (calls === 2) return Promise.reject("async create failure");
        return connection(calls);
      },
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    scheduler,
  });

  await assert.rejects(pool.acquireOne(), /synchronous create failure/);
  assert.deepEqual(
    {
      connections: pool.monitor().connections,
      creating: pool.monitor().creating,
      failures: pool.monitor().creationFailures,
    },
    { connections: 0, creating: 0, failures: 1 },
  );
  await assert.rejects(pool.acquireOne(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "connection factory failed with a non-Error value");
    assert.equal(error.cause, "async create failure");
    return true;
  });
  assert.equal(pool.monitor().connections, 0);
  assert.equal(pool.monitor().creationFailures, 2);

  const lease = await pool.acquireOne();
  assert.equal(await withLease(pool, lease, (resource) => resource.id), 3);
  assert.equal(pool.monitor().connections, 1);
  await pool.release(lease);
  await pool.close();
});

test("bounds failed low-water creation and retries only on new demand", async () => {
  const scheduler = new FakeScheduler();
  let calls = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create() {
        calls += 1;
        if (calls === 1) throw new Error("background warm-up failed");
        return connection(calls);
      },
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    lowWater: 1,
    idleHigh: 1,
    scheduler,
  });
  await until(
    () => pool.monitor().creationFailures === 1,
    "warm-up failure settles",
  );
  await turns(30);
  assert.equal(calls, 1);
  assert.equal(pool.monitor().connections, 0);

  const lease = await pool.acquireOne();
  assert.equal(await withLease(pool, lease, (resource) => resource.id), 2);
  assert.equal(calls, 2);
  await pool.release(lease);
  await pool.close();
});

test("acquire(N) is atomic, aborts surplus creation, and recovers capacity", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 3,
    maxWaiters: 3,
    acquireTimeoutMs: 100,
    scheduler,
  });
  const first = pool.acquire(3);
  await until(() => factory.creates.length === 3, "three bounded creates start");
  assert.deepEqual(
    {
      connections: pool.monitor().connections,
      creating: pool.monitor().creating,
      leased: pool.monitor().leased,
    },
    { connections: 3, creating: 3, leased: 0 },
  );

  factory.creates[0]!.result.resolve(connection(1));
  factory.creates[1]!.result.reject(new Error("middle create failed"));
  factory.creates[2]!.result.resolve(connection(3));
  await assert.rejects(first, /middle create failed/);
  await until(
    () => pool.monitor().creating === 0 && pool.monitor().connections === 1,
    "all first creates and late destruction settle",
  );
  assert.equal(factory.creates[2]!.context.signal.aborted, true);
  assert.deepEqual(factory.destroyed.map(({ id }) => id), [3]);
  assert.equal(pool.monitor().leased, 0);
  assert.equal(pool.monitor().idle, 1);
  assert.equal(pool.monitor().connections, 1);
  assertReconciled(pool.monitor());

  const retried = pool.acquire(3);
  await until(() => factory.creates.length === 5, "only missing capacity starts");
  assert.equal(pool.monitor().creating, 2);
  factory.creates[3]!.result.resolve(connection(4));
  factory.creates[4]!.result.resolve(connection(5));
  const leases = await retried;
  assert.equal(leases.length, 3);
  assert.equal(pool.monitor().leased, 3);
  assert.equal(pool.monitor().connections, 3);
  await Promise.all(leases.map((lease) => pool.release(lease)));
  await pool.close();
});

test("replaces unhealthy checkout candidates without exposing a partial lease", async () => {
  const scheduler = new FakeScheduler();
  const destroyed: number[] = [];
  let next = 1;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next, next++ !== 1),
      destroy: (resource) => {
        destroyed.push(resource.id);
      },
      validate: (resource) => resource.healthy,
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    validateOnCheckout: true,
    scheduler,
  });

  const lease = await pool.acquireOne();
  assert.equal(await withLease(pool, lease, (resource) => resource.id), 2);
  assert.deepEqual(destroyed, [1]);
  assert.equal(pool.monitor().healthFailures, 1);
  assert.equal(pool.monitor().leased, 1);
  assertReconciled(pool.monitor());
  await pool.release(lease);
  await pool.close();
});

test("evicts reset failures and explicitly unhealthy releases, then replenishes low-water", async () => {
  const scheduler = new FakeScheduler();
  const destroyed: number[] = [];
  const reset: number[] = [];
  let next = 1;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy: (resource) => {
        destroyed.push(resource.id);
      },
      reset: (resource) => {
        reset.push(resource.id);
        if (resource.id === 1) throw new Error("reset failed");
      },
    },
    maxConnections: 2,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    lowWater: 1,
    idleHigh: 1,
    resetOnRelease: true,
    scheduler,
  });
  await until(() => pool.monitor().idle === 1, "low-water prewarms");
  const first = await pool.acquireOne();
  await assert.rejects(pool.release(first), /reset failed/);
  await until(
    () => pool.monitor().idle === 1 && pool.monitor().connections === 1,
    "reset failure replacement reaches low-water",
  );
  assert.deepEqual(destroyed, [1]);
  assert.equal(pool.monitor().resetFailures, 1);

  const second = await pool.acquireOne();
  assert.equal(await withLease(pool, second, (resource) => resource.id), 2);
  await pool.release(second, { reusable: false });
  await until(
    () => pool.monitor().idle === 1 && pool.monitor().connections === 1,
    "explicit unhealthy release is replaced",
  );
  assert.deepEqual(destroyed, [1, 2]);
  assert.deepEqual(reset, [1]);
  const third = await pool.acquireOne();
  assert.equal(await withLease(pool, third, (resource) => resource.id), 3);
  await pool.release(third);
  assert.deepEqual(reset, [1, 3]);
  await pool.close();
});

test("resets an active lease in place and permits safe eviction after reset failure", async () => {
  const scheduler = new FakeScheduler();
  const reset: number[] = [];
  const destroyed: number[] = [];
  let next = 1;
  let failReset = false;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy: (resource) => {
        destroyed.push(resource.id);
      },
      reset: (resource) => {
        reset.push(resource.id);
        if (failReset) throw new Error("active reset failed");
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    scheduler,
  });

  const lease = await pool.acquireOne();
  const resourceBeforeReset = await withLease(
    pool,
    lease,
    (resource) => resource,
  );
  await pool.resetActiveLease(lease);
  const resourceAfterReset = await withLease(
    pool,
    lease,
    (resource) => resource,
  );
  assert.equal(resourceAfterReset, resourceBeforeReset);
  assert.deepEqual(reset, [resourceBeforeReset.id]);
  assert.deepEqual(
    {
      leased: pool.monitor().leased,
      resetting: pool.monitor().resetting,
      connections: pool.monitor().connections,
    },
    { leased: 1, resetting: 0, connections: 1 },
  );

  failReset = true;
  await assert.rejects(pool.resetActiveLease(lease), /active reset failed/);
  assert.equal(pool.monitor().resetFailures, 1);
  assert.equal(pool.monitor().leased, 1);
  await pool.release(lease, { reusable: false });
  await until(
    () => pool.monitor().closing === 0 && pool.monitor().connections === 0,
    "failed-reset resource is evicted",
  );
  assert.deepEqual(destroyed, [resourceBeforeReset.id]);

  const replacement = await pool.acquireOne();
  assert.equal(
    await withLease(pool, replacement, (resource) => resource.id),
    resourceBeforeReset.id + 1,
  );
  await pool.release(replacement);
  assertReconciled(pool.monitor());
  await pool.close();
});

test("rejects wrong-pool, double, and stale lease tokens by generation", async () => {
  const firstPool = immediatePool({ maxConnections: 1 }).pool;
  const secondPool = immediatePool({ maxConnections: 1 }).pool;
  const first = await firstPool.acquireOne();
  const firstResource = await withLease(
    firstPool,
    first,
    (resource) => resource,
  );
  await rejectsWithCode(secondPool.release(first), "WRONG_POOL");
  await firstPool.release(first);
  await rejectsWithCode(firstPool.release(first), "DOUBLE_RELEASE");

  const secondGeneration = await firstPool.acquireOne();
  assert.equal(
    await withLease(firstPool, secondGeneration, (resource) => resource),
    firstResource,
  );
  assert.equal(secondGeneration.generation > first.generation, true);
  await rejectsWithCode(firstPool.release(first), "STALE_LEASE");
  await firstPool.release(secondGeneration);
  await Promise.all([firstPool.close(), secondPool.close()]);
});

test("validates release disposition before consuming lease ownership", async () => {
  const { pool } = immediatePool({ maxConnections: 1 });
  const lease = await pool.acquireOne();
  await assert.rejects(
    pool.release(lease, { reusable: "invalid" as never }),
    /release reusable must be a boolean/,
  );
  assert.deepEqual(
    {
      leased: pool.monitor().leased,
      connections: pool.monitor().connections,
    },
    { leased: 1, connections: 1 },
  );

  await pool.release(lease);
  assert.equal(pool.monitor().leased, 0);
  assert.equal(pool.monitor().idle, 1);
  await pool.close();
});

test("never releases a resource while a lease operation is active", async () => {
  const { pool } = immediatePool({ maxConnections: 1 });
  const lease = await pool.acquireOne();
  const operation = deferred<void>();
  let activeResource: TestConnection | undefined;
  const active = pool.withActiveLease(lease, async (resource) => {
    activeResource = resource;
    await operation.promise;
  });
  await turns();
  await rejectsWithCode(pool.release(lease), "ACTIVE_LEASE");
  assert.equal(pool.monitor().leased, 1);
  operation.resolve();
  await active;
  assert.notEqual(activeResource, undefined);
  await pool.release(lease);
  assert.equal(pool.monitor().leased, 0);
  await pool.close();
});

test("rejects an overlapping operation before invoking it", async () => {
  const { pool } = immediatePool({ maxConnections: 1 });
  const lease = await pool.acquireOne();
  const first = deferred<void>();
  const firstUse = pool.withActiveLease(lease, () => first.promise);
  await turns();
  let secondInvoked = false;
  await rejectsWithCode(
    pool.withActiveLease(lease, () => {
      secondInvoked = true;
    }),
    "POOL_LEASE_BUSY",
  );
  assert.equal(secondInvoked, false);
  await rejectsWithCode(pool.release(lease), "ACTIVE_LEASE");

  first.resolve();
  await firstUse;
  await pool.release(lease);
  await pool.close();
});

test("reassigns an in-flight creation when the FIFO owner aborts", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    scheduler,
  });
  const controller = new AbortController();
  const first = pool.acquireOne({ signal: controller.signal });
  const second = pool.acquireOne();
  await until(() => factory.creates.length === 1, "shared creation starts");
  controller.abort();
  await rejectsWithCode(first, "ACQUIRE_ABORTED");
  assert.equal(factory.creates[0]!.context.signal.aborted, false);
  factory.creates[0]!.result.reject(new Error("reassigned create failed"));
  await assert.rejects(second, /reassigned create failed/);
  assert.equal(pool.monitor().creating, 0);
  assert.equal(pool.monitor().waiting, 0);
  await pool.close();
});

test("aborts an unneeded creation and destroys its late result before recovery", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    scheduler,
  });
  const controller = new AbortController();
  const acquisition = pool.acquireOne({ signal: controller.signal });
  await until(() => factory.creates.length === 1, "owned creation starts");
  controller.abort();
  await rejectsWithCode(acquisition, "ACQUIRE_ABORTED");
  assert.equal(pool.monitor().creating, 1);
  assert.equal(factory.creates[0]!.context.signal.aborted, true);

  factory.creates[0]!.result.resolve(connection(91));
  await until(
    () => pool.monitor().connections === 0,
    "late aborted result is destroyed",
  );
  assert.deepEqual(factory.destroyed.map((resource) => resource.id), [91]);

  const recovered = pool.acquireOne();
  await until(() => factory.creates.length === 2, "new acquisition creates anew");
  factory.creates[1]!.result.resolve(connection(92));
  const lease = await recovered;
  assert.equal(await withLease(pool, lease, (resource) => resource.id), 92);
  await pool.release(lease);
  await pool.close();
});

test("close rejects waiters, aborts creation, and waits for its settlement", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    scheduler,
  });
  const first = pool.acquireOne();
  const waiting = pool.acquireOne();
  await until(() => factory.creates.length === 1, "create begins");
  let closed = false;
  const close = pool.close().then(() => {
    closed = true;
  });
  assert.equal(factory.creates[0]!.context.signal.aborted, true);
  await rejectsWithCode(first, "POOL_CLOSED");
  await rejectsWithCode(waiting, "POOL_CLOSED");
  assert.equal(closed, false);
  assert.deepEqual(
    {
      state: pool.monitor().state,
      creating: pool.monitor().creating,
      waiting: pool.monitor().waiting,
    },
    { state: "closing", creating: 1, waiting: 0 },
  );

  factory.creates[0]!.result.reject(new Error("creation observed abort"));
  await close;
  assert.equal(pool.monitor().state, "closed");
  assert.equal(pool.monitor().connections, 0);
  assert.equal(pool.monitor().creationAborts, 1);
  await rejectsWithCode(pool.acquireOne(), "POOL_CLOSED");
});

test("destroys a resource returned after its close-time creation abort", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    scheduler,
  });
  const acquisition = pool.acquireOne();
  await until(() => factory.creates.length === 1, "create begins");
  const close = pool.close();
  assert.equal(pool.close(), close);
  assert.equal(pool.drain(), close);
  await rejectsWithCode(acquisition, "POOL_CLOSED");
  factory.creates[0]!.result.resolve(connection(77));
  await close;
  assert.deepEqual(
    factory.destroyed.map((resource) => resource.id),
    [77],
  );
  assert.equal(pool.monitor().creationAborts, 1);
  assert.equal(pool.monitor().connections, 0);
  assertReconciled(pool.monitor());
});

test("close waits for an active leased operation and destroys only after release", async () => {
  const { pool, destroyed } = immediatePool({ maxConnections: 1 });
  const lease = await pool.acquireOne();
  const operation = deferred<void>();
  const active = pool.withActiveLease(lease, () => operation.promise);
  await turns();
  let closed = false;
  const close = pool.drain().then(() => {
    closed = true;
  });
  assert.equal(pool.monitor().state, "closing");
  assert.equal(pool.monitor().leased, 1);
  await rejectsWithCode(pool.release(lease), "ACTIVE_LEASE");
  assert.equal(destroyed.length, 0);
  assert.equal(closed, false);

  operation.resolve();
  await active;
  await pool.release(lease);
  await close;
  assert.equal(closed, true);
  assert.deepEqual(destroyed.map((resource) => resource.id), [1]);
  assert.equal(pool.monitor().state, "closed");
  assertReconciled(pool.monitor());
});

test("timeout during checkout validation rolls the candidate back atomically", async () => {
  const scheduler = new FakeScheduler();
  const validation = deferred<boolean>();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
      validate: () => validation.promise,
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 10,
    validateOnCheckout: true,
    scheduler,
  });
  const acquisition = pool.acquireOne();
  await until(
    () => pool.monitor().validating === 1,
    "checkout enters validation",
  );
  scheduler.advance(10);
  await rejectsWithCode(acquisition, "ACQUIRE_TIMEOUT");
  assert.equal(pool.monitor().validating, 1);
  validation.resolve(true);
  await until(() => pool.monitor().idle === 1, "validated candidate rolls back");
  assert.equal(pool.monitor().leased, 0);
  assert.equal(pool.monitor().connections, 1);
  assertReconciled(pool.monitor());
  await pool.close();
});

test("close waits for checkout validation and destroys without issuing a lease", async () => {
  const scheduler = new FakeScheduler();
  const validation = deferred<boolean>();
  const destruction = deferred<void>();
  const destroyed: TestConnection[] = [];
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      validate: () => validation.promise,
      destroy(resource) {
        destroyed.push(resource);
        return destruction.promise;
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    validateOnCheckout: true,
    scheduler,
  });
  const acquisition = pool.acquireOne();
  await until(
    () => pool.monitor().validating === 1,
    "checkout enters validation before close",
  );
  let closed = false;
  const close = pool.close().then(() => {
    closed = true;
  });
  await rejectsWithCode(acquisition, "POOL_CLOSED");
  assert.equal(closed, false);
  assert.equal(pool.monitor().validating, 1);

  validation.resolve(true);
  await until(() => pool.monitor().closing === 1, "validated resource is closing");
  assert.equal(closed, false);
  assert.equal(pool.monitor().lastLeaseGeneration, 0);
  assert.deepEqual(destroyed.map(({ id }) => id), [1]);
  destruction.resolve();
  await close;
  assert.equal(closed, true);
  assert.equal(pool.monitor().state, "closed");
  assert.equal(pool.monitor().connections, 0);
  assertReconciled(pool.monitor());
});

test("monitor snapshots reconcile creating, validating, resetting, and closing states", async () => {
  const scheduler = new FakeScheduler();
  const factory = new ControlledFactory();
  const validation = deferred<boolean>();
  const reset = deferred<void>();
  const destroy = deferred<void>();
  factory.validateImplementation = () => validation.promise;
  factory.resetImplementation = () => reset.promise;
  factory.destroyImplementation = () => destroy.promise;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory,
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    validateOnCheckout: true,
    resetOnRelease: true,
    scheduler,
  });

  const acquisition = pool.acquireOne();
  await until(() => pool.monitor().creating === 1, "creation state observed");
  assertReconciled(pool.monitor());
  factory.creates[0]!.result.resolve(connection(1));
  await until(() => pool.monitor().validating === 1, "validation state observed");
  assertReconciled(pool.monitor());
  validation.resolve(true);
  const lease = await acquisition;
  assert.equal(pool.monitor().leased, 1);
  assertReconciled(pool.monitor());

  const releasing = pool.release(lease);
  await until(() => pool.monitor().resetting === 1, "reset state observed");
  assertReconciled(pool.monitor());
  const closing = pool.close();
  reset.resolve();
  await until(() => pool.monitor().closing === 1, "closing state observed");
  assertReconciled(pool.monitor());
  destroy.resolve();
  await Promise.all([releasing, closing]);
  const final = pool.monitor();
  assert.equal(final.state, "closed");
  assert.equal(final.connections, 0);
  assertReconciled(final);
});

test("survives 520 create-use-evict cycles with bounded capacity and monotonic leases", async () => {
  const scheduler = new FakeScheduler();
  let creates = 0;
  let destroys = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(++creates),
      destroy: () => {
        destroys += 1;
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    idleHigh: 0,
    scheduler,
  });

  for (let index = 1; index <= 520; index += 1) {
    const lease = await pool.acquireOne();
    assert.equal(lease.generation, index);
    await pool.withActiveLease(lease, (resource) => {
      assert.equal(resource.id, index);
    });
    await pool.release(lease);
    const monitor = pool.monitor();
    assert.equal(monitor.connections, 0);
    assertReconciled(monitor);
  }
  assert.deepEqual(
    {
      creates,
      destroys,
      leases: pool.monitor().leasesIssued,
      generation: pool.monitor().lastLeaseGeneration,
    },
    { creates: 520, destroys: 520, leases: 520, generation: 520 },
  );
  await pool.close();
});

test("preserves pool invariants across 640 seeded mixed state transitions", async () => {
  const scheduler = new FakeScheduler();
  let seed = 0x6d_2b_79_f5;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  let creates = 0;
  let destroys = 0;
  let resets = 0;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(++creates),
      destroy: () => {
        destroys += 1;
      },
      validate: (resource) => resource.healthy,
      reset: () => {
        resets += 1;
      },
    },
    maxConnections: 3,
    maxWaiters: 8,
    acquireTimeoutMs: 100,
    idleHigh: 2,
    validateOnCheckout: true,
    resetOnRelease: true,
    scheduler,
  });
  const active: ConnectionPoolLease<TestConnection>[] = [];
  let lastGeneration = 0;

  for (let step = 0; step < 640; step += 1) {
    const choice = random() % 100;
    if (active.length === 0 || (choice < 52 && active.length < 3)) {
      const count = 1 + (random() % (3 - active.length));
      const leases = await pool.acquire(count);
      for (const lease of leases) {
        assert.equal(lease.generation > lastGeneration, true);
        lastGeneration = lease.generation;
        active.push(lease);
      }
    } else if (choice < 82) {
      const index = random() % active.length;
      const [lease] = active.splice(index, 1);
      assert.ok(lease);
      if (random() % 11 === 0) {
        await withLease(pool, lease, (resource) => {
          resource.healthy = false;
        });
      }
      await pool.release(lease, { reusable: random() % 5 !== 0 });
    } else {
      const lease = active[random() % active.length]!;
      await pool.withActiveLease(lease, async (resource) => {
        assert.equal(typeof resource.id, "number");
        await Promise.resolve();
      });
    }
    assertReconciled(pool.monitor());
    assert.equal(pool.monitor().leased, active.length);
  }

  await Promise.all(
    active.splice(0).map((lease) => pool.release(lease)),
  );
  await pool.close();
  assert.deepEqual(
    {
      state: pool.monitor().state,
      connections: pool.monitor().connections,
      waiting: pool.monitor().waiting,
      leases: pool.monitor().leasesIssued,
      generation: pool.monitor().lastLeaseGeneration,
      creates,
      destroys,
      resetObserved: resets > 0,
    },
    {
      state: "closed",
      connections: 0,
      waiting: 0,
      leases: lastGeneration,
      generation: lastGeneration,
      creates,
      destroys: creates,
      resetObserved: true,
    },
  );
});

test("times out a non-cooperative create without freeing uncertain capacity", async () => {
  const scheduler = new FakeScheduler();
  const pending = deferred<TestConnection>();
  let creationContext: ConnectionCreationContext | undefined;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create(context) {
        creationContext = context;
        return pending.promise;
      },
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    shutdownTimeoutMs: 20,
    lifecycleScheduler: scheduler,
    scheduler,
  });

  const acquisition = pool.acquireOne();
  await until(() => creationContext !== undefined, "create starts");
  scheduler.advance(10);
  await rejectsWithCode(acquisition, "LIFECYCLE_TIMEOUT");
  assert.equal(creationContext?.signal.aborted, true);
  assert.deepEqual(
    {
      creating: pool.monitor().creating,
      connections: pool.monitor().connections,
      lifecycleTimeouts: pool.monitor().lifecycleTimeouts,
    },
    { creating: 1, connections: 1, lifecycleTimeouts: 1 },
  );

  await assert.rejects(pool.close(), /create|lifecycle/i);
  assert.equal(pool.monitor().state, "closing");
  assert.equal(pool.monitor().connections, 1);
});

test("times out never-settling validate and reset callbacks with abort signals", async () => {
  const scheduler = new FakeScheduler();
  const validation = deferred<boolean>();
  const reset = deferred<void>();
  let validateContext: ConnectionPoolLifecycleContext | undefined;
  let resetContext: ConnectionPoolLifecycleContext | undefined;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
      validate(_resource, context) {
        validateContext = context;
        return validation.promise;
      },
      reset(_resource, context) {
        resetContext = context;
        return reset.promise;
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    shutdownTimeoutMs: 20,
    lifecycleScheduler: scheduler,
    validateOnCheckout: true,
    resetOnRelease: true,
    scheduler,
  });

  const validationAcquire = pool.acquireOne();
  await until(() => validateContext !== undefined, "validation starts");
  scheduler.advance(10);
  await rejectsWithCode(validationAcquire, "LIFECYCLE_TIMEOUT");
  assert.equal(validateContext?.signal.aborted, true);
  await until(() => pool.monitor().connections === 0, "timed-out candidate evicts");

  const acquired = pool.acquireOne();
  await until(() => validateContext?.operationId !== 1, "replacement validates");
  validation.resolve(true);
  const lease = await acquired;
  const releasing = pool.release(lease);
  await until(() => resetContext !== undefined, "reset starts");
  scheduler.advance(10);
  await rejectsWithCode(releasing, "LIFECYCLE_TIMEOUT");
  assert.equal(resetContext?.signal.aborted, true);
  assert.equal(pool.monitor().connections, 0);
  await pool.close();
});

test("surfaces destroy rejection and retains quarantined physical capacity", async () => {
  const scheduler = new FakeScheduler();
  const destroyFailure = new Error("physical close was not proven");
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy: () => {
        throw destroyFailure;
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    shutdownTimeoutMs: 20,
    lifecycleScheduler: scheduler,
    scheduler,
  });
  const lease = await pool.acquireOne();

  await assert.rejects(
    pool.release(lease, { reusable: false }),
    (error) => error === destroyFailure,
  );
  assert.deepEqual(
    {
      connections: pool.monitor().connections,
      closing: pool.monitor().closing,
      destroyFailures: pool.monitor().destroyFailures,
    },
    { connections: 1, closing: 1, destroyFailures: 1 },
  );
  await assert.rejects(pool.close(), /physical close was not proven/);
  assert.equal(pool.monitor().state, "closing");
  assert.equal(pool.monitor().connections, 1);
});

test("times out destroy and pool shutdown without claiming physical closure", async () => {
  const scheduler = new FakeScheduler();
  const destruction = deferred<void>();
  let destroyContext: ConnectionPoolLifecycleContext | undefined;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy(_resource, context) {
        destroyContext = context;
        return destruction.promise;
      },
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    shutdownTimeoutMs: 20,
    lifecycleScheduler: scheduler,
    scheduler,
  });
  const lease = await pool.acquireOne();
  const releasing = pool.release(lease, { reusable: false });
  await until(() => destroyContext !== undefined, "destroy starts");
  scheduler.advance(10);
  await rejectsWithCode(releasing, "LIFECYCLE_TIMEOUT");
  assert.equal(destroyContext?.signal.aborted, true);
  assert.equal(pool.monitor().closing, 1);

  await assert.rejects(pool.close(), /destroy|lifecycle/i);
  assert.equal(pool.monitor().state, "closing");
  assert.equal(pool.monitor().connections, 1);
});

test("close has a finite deadline while a caller retains a lease", async () => {
  const scheduler = new FakeScheduler();
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy() {},
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    shutdownTimeoutMs: 15,
    lifecycleScheduler: scheduler,
    scheduler,
  });
  const lease = await pool.acquireOne();
  const closing = pool.close();
  scheduler.advance(15);
  await rejectsWithCode(closing, "POOL_SHUTDOWN_TIMEOUT");
  assert.equal(pool.monitor().state, "closing");
  assert.equal(pool.monitor().leased, 1);
  await rejectsWithCode(withLease(pool, lease, () => 1), "POOL_CLOSED");

  await pool.release(lease);
  assert.equal(pool.monitor().state, "closed");
  assert.equal(pool.monitor().connections, 0);
});

test("retirement rejects new work but permits pinned leases through final release", async () => {
  const scheduler = new FakeScheduler();
  const destroyed: number[] = [];
  let next = 1;
  const pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(next++),
      destroy: (resource) => {
        destroyed.push(resource.id);
      },
    },
    maxConnections: 2,
    maxWaiters: 2,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 50,
    shutdownTimeoutMs: 100,
    lifecycleScheduler: scheduler,
    lowWater: 2,
    idleHigh: 2,
    scheduler,
  });
  await until(() => pool.monitor().idle === 2, "low-water fills");
  const pinned = await pool.acquireOne();
  const retiring = pool.retire();
  assert.equal(pool.monitor().state, "retiring");
  await rejectsWithCode(pool.acquireOne(), "POOL_CLOSED");
  await until(() => pool.monitor().idle === 0, "retirement destroys idle");
  assert.equal(await withLease(pool, pinned, (resource) => resource.id), 1);
  assert.equal(await withLease(pool, pinned, (resource) => resource.id + 1), 2);

  await pool.release(pinned);
  await retiring;
  assert.equal(pool.monitor().state, "closed");
  assert.equal(pool.monitor().connections, 0);
  assert.deepEqual(destroyed.sort((left, right) => left - right), [1, 2]);
});

test("reentrant destroy awaiting close converges through finite failure", async () => {
  const scheduler = new FakeScheduler();
  let pool!: ConnectionPoolRuntime<TestConnection>;
  pool = new ConnectionPoolRuntime<TestConnection>({
    factory: {
      create: () => connection(1),
      destroy: () => pool.close(),
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    shutdownTimeoutMs: 20,
    lifecycleScheduler: scheduler,
    scheduler,
  });
  const lease = await pool.acquireOne();
  const release = pool.release(lease, { reusable: false });
  await until(() => pool.monitor().state === "closing", "destroy reenters close");
  scheduler.advance(10);
  await rejectsWithCode(release, "LIFECYCLE_TIMEOUT");
  await assert.rejects(pool.close());
  assert.equal(pool.monitor().connections, 1);
});
