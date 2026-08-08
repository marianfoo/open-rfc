import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionPoolRuntime,
  type ConnectionPoolLease,
} from "../src/pool/connection-pool-runtime.js";
import {
  TransactionBapiError,
  TransactionRuntime,
  TransactionRuntimeError,
  TransactionTerminalError,
  type TransactionAcquireContext,
  type TransactionInvocation,
  type TransactionLeaseAdapter,
  type TransactionOperationContext,
  type TransactionReleaseDisposition,
  type TransactionScheduledTask,
  type TransactionScheduler,
  type TransactionToken,
} from "../src/lifecycle/transaction-runtime.js";

interface TestLease {
  readonly id: number;
}

interface PoolResource {
  readonly id: number;
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

interface FakeTask extends TransactionScheduledTask {
  readonly deadline: number;
  readonly callback: () => void;
  active: boolean;
}

class FakeScheduler implements TransactionScheduler {
  nowValue = 0;
  readonly tasks: FakeTask[] = [];

  now(): number {
    return this.nowValue;
  }

  schedule(delayMs: number, callback: () => void): TransactionScheduledTask {
    const task: FakeTask = {
      deadline: this.nowValue + delayMs,
      callback,
      active: true,
      cancel() {
        task.active = false;
      },
    };
    this.tasks.push(task);
    return task;
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const next = this.tasks
        .filter((task) => task.active && task.deadline <= this.nowValue)
        .sort((left, right) => left.deadline - right.deadline)[0];
      if (next === undefined) return;
      next.active = false;
      next.callback();
    }
    throw new Error("fake scheduler did not converge");
  }
}

class ControlledAdapter implements TransactionLeaseAdapter<TestLease> {
  readonly events: string[] = [];
  readonly acquisitions: TransactionAcquireContext[] = [];
  readonly invocations: Array<{
    readonly lease: TestLease;
    readonly invocation: TransactionInvocation;
    readonly context: TransactionOperationContext;
  }> = [];
  readonly resets: Array<{
    readonly lease: TestLease;
    readonly context: TransactionOperationContext;
  }> = [];
  readonly releases: Array<{
    readonly lease: TestLease;
    readonly disposition: TransactionReleaseDisposition;
    readonly context: TransactionOperationContext;
  }> = [];
  nextLeaseId = 1;
  acquireImplementation?: (
    context: TransactionAcquireContext,
  ) => TestLease | PromiseLike<TestLease>;
  invokeImplementation?: (
    lease: TestLease,
    invocation: TransactionInvocation,
    context: TransactionOperationContext,
  ) =>
    | Readonly<Record<string, unknown>>
    | PromiseLike<Readonly<Record<string, unknown>>>;
  resetImplementation?: (
    lease: TestLease,
    context: TransactionOperationContext,
  ) => void | PromiseLike<void>;
  releaseImplementation?: (
    lease: TestLease,
    disposition: TransactionReleaseDisposition,
    context: TransactionOperationContext,
  ) => void | PromiseLike<void>;

  acquire(context: TransactionAcquireContext): TestLease | PromiseLike<TestLease> {
    this.events.push("acquire");
    this.acquisitions.push(context);
    return this.acquireImplementation?.(context) ?? { id: this.nextLeaseId++ };
  }

  invoke(
    lease: TestLease,
    invocation: TransactionInvocation,
    context: TransactionOperationContext,
  ):
    | Readonly<Record<string, unknown>>
    | PromiseLike<Readonly<Record<string, unknown>>> {
    this.events.push(`invoke:${invocation.kind}:${invocation.functionName}`);
    this.invocations.push({ lease, invocation, context });
    if (this.invokeImplementation !== undefined) {
      return this.invokeImplementation(lease, invocation, context);
    }
    if (invocation.kind === "commit") {
      return { RETURN: { TYPE: "", MESSAGE: "" } };
    }
    if (invocation.kind === "rollback") {
      return { RETURN: { TYPE: "", MESSAGE: "" } };
    }
    return { RESULT: "ok" };
  }

  reset(
    lease: TestLease,
    context: TransactionOperationContext,
  ): void | PromiseLike<void> {
    this.events.push("reset");
    this.resets.push({ lease, context });
    return this.resetImplementation?.(lease, context);
  }

  release(
    lease: TestLease,
    disposition: TransactionReleaseDisposition,
    context: TransactionOperationContext,
  ): void | PromiseLike<void> {
    this.events.push("release");
    this.releases.push({ lease, disposition, context });
    return this.releaseImplementation?.(lease, disposition, context);
  }
}

class PoolBackedAdapter
  implements TransactionLeaseAdapter<ConnectionPoolLease<PoolResource>>
{
  readonly releases: TransactionReleaseDisposition[] = [];

  constructor(
    readonly pool: ConnectionPoolRuntime<PoolResource>,
    readonly businessReply: Promise<Readonly<Record<string, unknown>>>,
  ) {}

  acquire(
    context: TransactionAcquireContext,
  ): Promise<ConnectionPoolLease<PoolResource>> {
    return this.pool.acquireOne({ signal: context.signal, timeoutMs: 1_000 });
  }

  invoke(
    lease: ConnectionPoolLease<PoolResource>,
    invocation: TransactionInvocation,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.pool.withActiveLease(lease, () =>
      invocation.kind === "business"
        ? this.businessReply
        : { RETURN: { TYPE: "", MESSAGE: "" } },
    );
  }

  reset(lease: ConnectionPoolLease<PoolResource>): Promise<void> {
    return this.pool.withActiveLease(lease, () => undefined);
  }

  release(
    lease: ConnectionPoolLease<PoolResource>,
    disposition: TransactionReleaseDisposition,
  ): Promise<void> {
    this.releases.push(disposition);
    return this.pool.release(lease, { reusable: disposition.reusable });
  }
}

function poolBackedFixture(): {
  readonly pool: ConnectionPoolRuntime<PoolResource>;
  readonly adapter: PoolBackedAdapter;
  readonly runtime: TransactionRuntime<ConnectionPoolLease<PoolResource>>;
  readonly scheduler: FakeScheduler;
  readonly businessReply: Deferred<Readonly<Record<string, unknown>>>;
  readonly destroyed: PoolResource[];
} {
  const destroyed: PoolResource[] = [];
  const pool = new ConnectionPoolRuntime<PoolResource>({
    factory: {
      create: () => ({ id: 1 }),
      destroy: (resource) => {
        destroyed.push(resource);
      },
    },
    maxConnections: 1,
    maxWaiters: 2,
    acquireTimeoutMs: 1_000,
    lifecycleTimeoutMs: 1_000,
  });
  const businessReply = deferred<Readonly<Record<string, unknown>>>();
  const adapter = new PoolBackedAdapter(pool, businessReply.promise);
  const scheduler = new FakeScheduler();
  const runtime = new TransactionRuntime({
    leases: adapter,
    operationTimeoutMs: 10,
    scheduler,
  });
  return { pool, adapter, runtime, scheduler, businessReply, destroyed };
}

function fixture(
  adapter = new ControlledAdapter(),
  overrides: Partial<ConstructorParameters<
    typeof TransactionRuntime<TestLease>
  >[0]> = {},
): {
  readonly runtime: TransactionRuntime<TestLease>;
  readonly adapter: ControlledAdapter;
  readonly scheduler: FakeScheduler;
} {
  const scheduler =
    overrides.scheduler instanceof FakeScheduler
      ? overrides.scheduler
      : new FakeScheduler();
  const { operationTimeoutMs = 10, ...rest } = overrides;
  return {
    runtime: new TransactionRuntime({
      leases: adapter,
      operationTimeoutMs,
      scheduler,
      ...rest,
    }),
    adapter,
    scheduler,
  };
}

async function rejectsCode(
  promise: Promise<unknown>,
  code: TransactionRuntimeError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof TransactionRuntimeError && error.code === code,
  );
}

async function flushUntil(
  condition: () => boolean,
  maximumTurns = 64,
): Promise<void> {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail("condition did not become true within the microtask bound");
}

test("pins one lease for business work and WAIT=X commit through reusable cleanup", async () => {
  const { runtime, adapter } = fixture();
  assert.equal(Object.isFrozen(runtime.monitor()), true);
  const token = await runtime.begin();
  assert.equal(Object.isFrozen(token), true);
  const bytes = Buffer.from("010203", "hex");
  const parameters = {
    TEXT: "before",
    DETAIL: { TEXT: "nested-before", BYTES: bytes },
    ROWS: [{ VALUE: 1 }],
  };
  const notRequested = ["DROP"];
  const pendingResult = runtime.call(token, "Z_TX_WRITE", parameters, {
    notRequested,
  });
  parameters.TEXT = "after";
  parameters.DETAIL.TEXT = "nested-after";
  bytes.fill(0xff);
  parameters.ROWS[0]!.VALUE = 2;
  parameters.ROWS.push({ VALUE: 3 });
  notRequested[0] = "MUTATED";
  const result = await pendingResult;
  assert.deepEqual(result, { RESULT: "ok" });
  await runtime.commit(token);

  assert.deepEqual(adapter.events, [
    "acquire",
    "invoke:business:Z_TX_WRITE",
    "invoke:commit:BAPI_TRANSACTION_COMMIT",
    "reset",
    "release",
  ]);
  assert.equal(adapter.invocations.every((item) => item.lease.id === 1), true);
  const business = adapter.invocations[0];
  assert.deepEqual(business?.invocation.parameters, {
    TEXT: "before",
    DETAIL: {
      TEXT: "nested-before",
      BYTES: Buffer.from("010203", "hex"),
    },
    ROWS: [{ VALUE: 1 }],
  });
  assert.deepEqual(business?.invocation.notRequested, ["DROP"]);
  assert.equal(Object.isFrozen(business?.invocation.notRequested), true);
  assert.equal(Object.isFrozen(business?.invocation), true);
  assert.equal(Object.isFrozen(business?.invocation.parameters), true);
  assert.equal(Object.isFrozen(business?.invocation.parameters.DETAIL), true);
  assert.equal(Object.isFrozen(business?.invocation.parameters.ROWS), true);
  const commit = adapter.invocations[1];
  assert.deepEqual(commit?.invocation, {
    kind: "commit",
    functionName: "BAPI_TRANSACTION_COMMIT",
    parameters: { WAIT: "X" },
  });
  assert.equal(Object.isFrozen(commit?.invocation.parameters), true);
  assert.equal(commit?.context.token, token);
  assert.equal(commit?.context.signal instanceof AbortSignal, true);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: true,
    reason: "commit",
    outcome: "committed",
  });
  assert.equal(adapter.resets[0]?.lease, adapter.releases[0]?.lease);
  assert.deepEqual(runtime.monitor(), {
    runtimeId: token.runtimeId,
    state: "closed",
    outcome: "committed",
    hasLease: false,
    activeOperation: false,
    beginCalls: 1,
    beginFailures: 0,
    businessCalls: 1,
    businessFailures: 0,
    commitCalls: 1,
    rollbackCalls: 0,
    closeCalls: 0,
    cancelCalls: 0,
    commitInvocations: 1,
    rollbackInvocations: 0,
    bapiRejections: 0,
    ambiguousFailures: 0,
    resetCalls: 1,
    resetFailures: 0,
    releaseAttempts: 1,
    releaseCompletions: 1,
    reusableReleaseAttempts: 1,
    evictionAttempts: 0,
    releaseFailures: 0,
    quarantinedOperations: 0,
    quarantinedAcquires: 0,
    lateEvictionFailures: 0,
    boundaryTimeouts: 0,
  });
});

test("commit rejects BAPI RETURN A, E, and X and never retries or resets", async () => {
  for (const type of ["A", "E", "X"]) {
    const adapter = new ControlledAdapter();
    adapter.invokeImplementation = (_lease, invocation) =>
      invocation.kind === "commit"
        ? {
            RETURN: {
              TYPE: type,
              ID: "ZTX",
              NUMBER: "001",
              MESSAGE: `commit ${type}`,
            },
          }
        : { RESULT: "ok" };
    const { runtime } = fixture(adapter);
    const token = await runtime.begin();

    await assert.rejects(runtime.commit(token), (error: unknown) => {
      assert.equal(error instanceof TransactionBapiError, true);
      const bapi = error as TransactionBapiError;
      assert.equal(bapi.operation, "commit");
      assert.deepEqual(bapi.returns, [
        { type, id: "ZTX", number: "001", message: `commit ${type}` },
      ]);
      assert.equal(Object.isFrozen(bapi.returns), true);
      return true;
    });
    assert.equal(adapter.invocations.length, 1);
    assert.equal(adapter.resets.length, 0);
    assert.equal(adapter.releases.length, 1);
    assert.deepEqual(adapter.releases[0]?.disposition, {
      reusable: false,
      reason: "control-rejected",
      outcome: "rejected",
    });
    assert.equal(runtime.monitor().outcome, "rejected");
    assert.equal(runtime.monitor().bapiRejections, 1);
  }
});

test("malformed control RETURN.TYPE is ambiguous and can never become success", async () => {
  for (const type of ["Q", "ERROR", null, undefined]) {
    const adapter = new ControlledAdapter();
    adapter.invokeImplementation = () => ({
      RETURN: { TYPE: type, MESSAGE: "malformed control reply" },
    });
    const { runtime } = fixture(adapter);
    const token = await runtime.begin();

    await rejectsCode(runtime.commit(token), "INVALID_CONTROL_RESULT");
    assert.equal(adapter.invocations.length, 1);
    assert.equal(adapter.resets.length, 0);
    assert.deepEqual(adapter.releases[0]?.disposition, {
      reusable: false,
      reason: "ambiguous",
      outcome: "ambiguous",
    });
    assert.equal(runtime.monitor().outcome, "ambiguous");
    assert.equal(runtime.monitor().ambiguousFailures, 1);
  }
});

test("blank, S, I, and W control RETURN.TYPE values remain nonfatal", async () => {
  for (const type of ["", "S", "I", "W", " w "]) {
    const adapter = new ControlledAdapter();
    adapter.invokeImplementation = () => ({ RETURN: { TYPE: type } });
    const { runtime } = fixture(adapter);
    const token = await runtime.begin();

    await runtime.commit(token);
    assert.equal(adapter.invocations.length, 1);
    assert.equal(adapter.resets.length, 1);
    assert.equal(adapter.releases[0]?.disposition.reusable, true);
    assert.equal(runtime.monitor().outcome, "committed");
  }
});

test("missing commit RETURN is an ambiguous invalid result and is not replayed", async () => {
  const adapter = new ControlledAdapter();
  adapter.invokeImplementation = () => ({});
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();

  await rejectsCode(runtime.commit(token), "INVALID_CONTROL_RESULT");
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.resets.length, 0);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "ambiguous",
    outcome: "ambiguous",
  });
  assert.equal(runtime.monitor().ambiguousFailures, 1);
});

test("an undefined control rejection remains a rejection and cannot become success", async () => {
  const adapter = new ControlledAdapter();
  adapter.invokeImplementation = () =>
    Promise.reject<Readonly<Record<string, unknown>>>(undefined);
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();
  let rejected = false;

  try {
    await runtime.commit(token);
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
  assert.equal(runtime.monitor().outcome, "ambiguous");
  assert.equal(adapter.resets.length, 0);
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
});

test("a hung commit stays quarantined until its late settlement can be evicted", async () => {
  const adapter = new ControlledAdapter();
  const pending = deferred<Readonly<Record<string, unknown>>>();
  let commitSignal: AbortSignal | undefined;
  adapter.invokeImplementation = (_lease, invocation, context) => {
    assert.equal(invocation.kind, "commit");
    commitSignal = context.signal;
    return pending.promise;
  };
  const { runtime, scheduler } = fixture(adapter);
  const token = await runtime.begin();
  const committing = runtime.commit(token);
  assert.equal(commitSignal?.aborted, false);

  scheduler.advance(10);
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  assert.equal(commitSignal?.aborted, true);
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.releases.length, 0);
  assert.equal(runtime.monitor().quarantinedOperations, 1);
  assert.equal(runtime.monitor().hasLease, true);
  scheduler.advance(10);
  await assert.rejects(committing, (error: unknown) => {
    assert.equal(error instanceof TransactionTerminalError, true);
    assert.equal((error as TransactionTerminalError).outcome, "ambiguous");
    return true;
  });
  assert.equal(runtime.monitor().state, "failed");
  assert.equal(adapter.releases.length, 0);
  assert.equal(runtime.monitor().outcome, "ambiguous");
  pending.resolve({ RETURN: { TYPE: "" } });
  await flushUntil(() => adapter.releases.length === 1);
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
  await flushUntil(() => runtime.monitor().state === "closed");
  assert.equal(runtime.monitor().hasLease, false);
});

test("a hardened pool lease is evicted only after its late active callback settles", async () => {
  const {
    pool,
    adapter,
    runtime,
    scheduler,
    businessReply,
    destroyed,
  } = poolBackedFixture();
  const token = await runtime.begin();
  const call = runtime.call(token, "Z_TX_WRITE", {});

  scheduler.advance(10);
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  assert.equal(pool.monitor().leased, 1);
  assert.equal(adapter.releases.length, 0);
  assert.equal(runtime.monitor().quarantinedOperations, 1);

  businessReply.resolve({ RESULT: "late but synchronized" });
  await rejectsCode(call, "OPERATION_TIMEOUT");
  await flushUntil(() => pool.monitor().leased === 0);
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.reusable, false);
  assert.equal(destroyed.length, 1);
  assert.equal(pool.monitor().connections, 0);
  assert.equal(runtime.monitor().state, "closed");
});

test("a pool callback beyond every deadline remains explicitly owned until late eviction", async () => {
  const {
    pool,
    adapter,
    runtime,
    scheduler,
    businessReply,
    destroyed,
  } = poolBackedFixture();
  const token = await runtime.begin();
  const call = runtime.call(token, "Z_TX_WRITE", {});

  scheduler.advance(10);
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  scheduler.advance(10);
  await assert.rejects(call, (error: unknown) => {
    assert.equal(error instanceof TransactionTerminalError, true);
    assert.equal((error as TransactionTerminalError).outcome, "ambiguous");
    return true;
  });
  assert.equal(runtime.monitor().state, "failed");
  assert.equal(runtime.monitor().hasLease, true);
  assert.equal(runtime.monitor().quarantinedOperations, 1);
  assert.equal(pool.monitor().leased, 1);
  assert.equal(adapter.releases.length, 0);
  await assert.rejects(runtime.close(), TransactionTerminalError);

  businessReply.resolve({ RESULT: "eventually synchronized" });
  await flushUntil(() => pool.monitor().leased === 0);
  await flushUntil(() => runtime.monitor().state === "closed");
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.reusable, false);
  assert.equal(destroyed.length, 1);
  assert.equal(runtime.monitor().state, "closed");
  assert.equal(runtime.monitor().hasLease, false);
});

test("recoverable business failure keeps the lease for explicit rollback", async () => {
  const adapter = new ControlledAdapter();
  const businessFailure = new Error("BAPI validation error");
  adapter.invokeImplementation = (_lease, invocation) => {
    if (invocation.kind === "business") throw businessFailure;
    return { RETURN: { TYPE: "", MESSAGE: "" } };
  };
  const { runtime } = fixture(adapter, {
    classifyFailure: () => "recoverable",
  });
  const token = await runtime.begin();

  await assert.rejects(
    runtime.call(token, "Z_TX_WRITE", {}),
    (error) => error === businessFailure,
  );
  assert.equal(runtime.monitor().state, "active");
  assert.equal(adapter.releases.length, 0);
  await runtime.rollback(token);
  assert.deepEqual(
    adapter.invocations.map((item) => item.invocation.kind),
    ["business", "rollback"],
  );
  assert.equal(adapter.invocations[0]?.lease, adapter.invocations[1]?.lease);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: true,
    reason: "rollback",
    outcome: "rolledBack",
  });
});

test("unclassified business failure is ambiguous and evicts without rollback", async () => {
  const adapter = new ControlledAdapter();
  const failure = new Error("communication failed after send");
  adapter.invokeImplementation = () => {
    throw failure;
  };
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();

  await assert.rejects(runtime.call(token, "Z_TX_WRITE", {}), (error) => error === failure);
  assert.deepEqual(
    adapter.invocations.map((item) => item.invocation.kind),
    ["business"],
  );
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "ambiguous",
    outcome: "ambiguous",
  });
  assert.equal(runtime.monitor().state, "closed");
  await runtime.close();
  assert.equal(adapter.releases.length, 1);
});

test("close and explicit abort rollback a safe active LUW", async () => {
  for (const action of ["close", "abort"] as const) {
    const { runtime, adapter } = fixture();
    const token = await runtime.begin();
    if (action === "close") await runtime.close();
    else await runtime.abort(token);

    assert.deepEqual(
      adapter.invocations.map((item) => item.invocation),
      [
        {
          kind: "rollback",
          functionName: "BAPI_TRANSACTION_ROLLBACK",
          parameters: {},
        },
      ],
    );
    assert.equal(adapter.resets.length, 1);
    assert.deepEqual(adapter.releases[0]?.disposition, {
      reusable: true,
      reason: action === "close" ? "close-rollback" : "rollback",
      outcome: "rolledBack",
    });
  }
});

test("close during a call never releases early and rolls back after a stable reply", async () => {
  const adapter = new ControlledAdapter();
  const reply = deferred<Readonly<Record<string, unknown>>>();
  let callSignal: AbortSignal | undefined;
  adapter.invokeImplementation = (_lease, invocation, context) => {
    if (invocation.kind === "business") {
      callSignal = context.signal;
      return reply.promise;
    }
    return { RETURN: { TYPE: "", MESSAGE: "" } };
  };
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();
  const call = runtime.call(token, "Z_TX_WRITE", {});
  const closing = runtime.close();
  assert.equal(callSignal?.aborted, true);
  assert.equal(adapter.releases.length, 0);
  assert.equal(adapter.invocations.length, 1);

  reply.resolve({ RESULT: "late but decoded" });
  await rejectsCode(call, "TRANSACTION_CLOSING");
  await closing;
  assert.deepEqual(
    adapter.invocations.map((item) => item.invocation.kind),
    ["business", "rollback"],
  );
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, true);
});

test("close or cancel after an aborted call evicts without sending rollback", async () => {
  for (const action of ["close", "cancel"] as const) {
    const adapter = new ControlledAdapter();
    const reply = deferred<Readonly<Record<string, unknown>>>();
    let runtime!: TransactionRuntime<TestLease>;
    let reentrantClose: Promise<void> | undefined;
    adapter.invokeImplementation = (_lease, invocation, context) => {
    if (invocation.kind !== "business") {
      return { RETURN: { TYPE: "", MESSAGE: "" } };
    }
      context.signal.addEventListener(
        "abort",
        () => {
          reentrantClose = runtime.close();
          reply.reject(new Error("adapter canceled"));
        },
        { once: true },
      );
      return reply.promise;
    };
    ({ runtime } = fixture(adapter));
    const token = await runtime.begin();
    const call = runtime.call(token, "Z_TX_WRITE", {});
    const terminal = action === "close" ? runtime.close() : runtime.cancel(token);

    assert.equal(reentrantClose, terminal);
    await assert.rejects(call, /adapter canceled/);
    await terminal;
    assert.deepEqual(
      adapter.invocations.map((item) => item.invocation.kind),
      ["business"],
    );
    assert.equal(adapter.releases.length, 1);
    assert.deepEqual(adapter.releases[0]?.disposition, {
      reusable: false,
      reason: "ambiguous",
      outcome: "ambiguous",
    });
  }
});

test("cancel bounds an adapter which ignores abort before evicting", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledAdapter();
  const reply = deferred<Readonly<Record<string, unknown>>>();
  let callSignal: AbortSignal | undefined;
  adapter.invokeImplementation = (_lease, invocation, context) => {
    assert.equal(invocation.kind, "business");
    callSignal = context.signal;
    return reply.promise;
  };
  const { runtime } = fixture(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  const token = await runtime.begin();
  const call = runtime.call(token, "Z_TX_WRITE", {});
  const cancellation = runtime.cancel(token);
  assert.equal(callSignal?.aborted, true);
  assert.equal(adapter.releases.length, 0);

  scheduler.advance(10);
  await rejectsCode(call, "OPERATION_TIMEOUT");
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  assert.equal(adapter.releases.length, 0);
  scheduler.advance(10);
  await assert.rejects(cancellation, TransactionTerminalError);
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.releases.length, 0);
  assert.equal(runtime.monitor().quarantinedOperations, 1);
  reply.resolve({ RESULT: "too late" });
  await flushUntil(() => adapter.releases.length === 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
  assert.equal(adapter.releases.length, 1);
});

test("reentrant abort observes the already-published cancellation terminal", async () => {
  const adapter = new ControlledAdapter();
  const reply = deferred<Readonly<Record<string, unknown>>>();
  const abortFailure = new Error("adapter canceled");
  let runtime!: TransactionRuntime<TestLease>;
  let token!: TransactionToken;
  let reentrantAbort: Promise<void> | undefined;
  adapter.invokeImplementation = (_lease, invocation, context) => {
    assert.equal(invocation.kind, "business");
    context.signal.addEventListener(
      "abort",
      () => {
        reentrantAbort = runtime.abort(token);
        reply.reject(abortFailure);
      },
      { once: true },
    );
    return reply.promise;
  };
  ({ runtime } = fixture(adapter));
  token = await runtime.begin();
  const call = runtime.call(token, "Z_TX_WRITE", {});
  const aborting = runtime.abort(token);

  assert.equal(reentrantAbort, aborting);
  await assert.rejects(call, (error) => error === abortFailure);
  await aborting;
  assert.deepEqual(
    adapter.invocations.map((item) => item.invocation.kind),
    ["business"],
  );
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
  assert.equal(runtime.monitor().rollbackCalls, 0);
  assert.equal(runtime.monitor().cancelCalls, 1);
});

test("reset failure after successful commit preserves committed outcome and evicts", async () => {
  const adapter = new ControlledAdapter();
  const resetFailure = new Error("reset failed");
  adapter.resetImplementation = () => {
    throw resetFailure;
  };
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();

  await assert.rejects(runtime.commit(token), (error: unknown) => {
    assert.equal(error instanceof TransactionTerminalError, true);
    const terminal = error as TransactionTerminalError;
    assert.equal(terminal.outcome, "committed");
    assert.deepEqual(terminal.errors, [resetFailure]);
    return true;
  });
  assert.equal(runtime.monitor().outcome, "committed");
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "reset-failed",
    outcome: "committed",
  });
});

test("terminal release failure is visible and cleanup remains exactly once", async () => {
  const adapter = new ControlledAdapter();
  const releaseFailure = new Error("pool destroy failed");
  adapter.releaseImplementation = () => {
    throw releaseFailure;
  };
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();

  const rollback = runtime.rollback(token);
  const close = runtime.close();
  assert.equal(close, rollback);
  await assert.rejects(rollback, (error: unknown) => {
    assert.equal(error instanceof TransactionTerminalError, true);
    assert.equal((error as TransactionTerminalError).outcome, "rolledBack");
    assert.deepEqual((error as TransactionTerminalError).errors, [releaseFailure]);
    return true;
  });
  assert.equal(adapter.releases.length, 1);
  assert.equal(runtime.close(), rollback);
  await assert.rejects(runtime.close(), (error) => error instanceof TransactionTerminalError);
  assert.equal(adapter.releases.length, 1);
});

test("hung release has a finite signal and preserves the rolled-back outcome", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledAdapter();
  const release = deferred<void>();
  adapter.releaseImplementation = () => release.promise;
  const { runtime } = fixture(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  const token = await runtime.begin();
  const rollback = runtime.rollback(token);
  await flushUntil(() => adapter.releases.length === 1);
  assert.equal(adapter.releases[0]?.context.signal.aborted, false);

  scheduler.advance(10);
  await assert.rejects(rollback, (error: unknown) => {
    assert.equal(error instanceof TransactionTerminalError, true);
    assert.equal((error as TransactionTerminalError).outcome, "rolledBack");
    return true;
  });
  assert.equal(adapter.releases[0]?.context.signal.aborted, true);
  assert.equal(runtime.monitor().outcome, "rolledBack");
  assert.equal(runtime.monitor().hasLease, false);
  release.resolve();
  await Promise.resolve();
  assert.equal(adapter.releases.length, 1);
});

test("release handoff stays observed and abortable when scheduler setup fails", async () => {
  for (const failureMode of ["clock", "early-timer"] as const) {
    const adapter = new ControlledAdapter();
    const release = deferred<void>();
    adapter.releaseImplementation = () => release.promise;
    let scheduleCalls = 0;
    const scheduler: TransactionScheduler = {
      now() {
        if (failureMode === "clock" && adapter.releases.length > 0) {
          throw new Error("release clock failed");
        }
        return 0;
      },
      schedule(_delayMs, callback) {
        scheduleCalls += 1;
        if (failureMode === "early-timer" && adapter.releases.length > 0) {
          callback();
        }
        return { cancel() {} };
      },
    };
    const { runtime } = fixture(adapter, {
      operationTimeoutMs: 10,
      scheduler,
    });
    const token = await runtime.begin();

    await assert.rejects(runtime.commit(token), (error: unknown) => {
      assert.equal(error instanceof TransactionTerminalError, true);
      const terminal = error as TransactionTerminalError;
      assert.equal(terminal.outcome, "committed");
      assert.match(
        String((terminal.errors[0] as Error | undefined)?.message),
        failureMode === "clock" ? /release clock failed/ : /scheduler fired early/,
      );
      return true;
    });
    assert.equal(scheduleCalls, failureMode === "clock" ? 3 : 4);
    assert.equal(adapter.releases.length, 1);
    assert.equal(adapter.releases[0]?.context.signal.aborted, true);
    assert.equal(runtime.monitor().releaseAttempts, 1);
    assert.equal(runtime.monitor().releaseCompletions, 0);
    assert.equal(runtime.monitor().releaseFailures, 1);
    assert.equal(runtime.monitor().hasLease, false);

    release.reject(new Error("late release rejection must remain observed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(adapter.releases.length, 1);
  }
});

test("rollback RETURN errors reject and evict without reset or retry", async () => {
  const adapter = new ControlledAdapter();
  adapter.invokeImplementation = () => ({
    RETURN: { TYPE: "E", MESSAGE: "rollback refused" },
  });
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();

  await assert.rejects(runtime.rollback(token), TransactionBapiError);
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.resets.length, 0);
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
  assert.equal(runtime.monitor().outcome, "rejected");
});

test("close during commit shares the terminal promise and does not cancel commit", async () => {
  const adapter = new ControlledAdapter();
  const commitReply = deferred<Readonly<Record<string, unknown>>>();
  let commitSignal: AbortSignal | undefined;
  adapter.invokeImplementation = (_lease, invocation, context) => {
    assert.equal(invocation.kind, "commit");
    commitSignal = context.signal;
    return commitReply.promise;
  };
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();

  const commit = runtime.commit(token);
  const close = runtime.close();
  assert.equal(close, commit);
  assert.equal(commitSignal?.aborted, false);
  commitReply.resolve({ RETURN: { TYPE: "S", MESSAGE: "committed" } });
  await commit;
  assert.equal(commitSignal?.aborted, false);
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.releases.length, 1);
  assert.equal(runtime.monitor().outcome, "committed");
});

test("close during reset shares bounded cleanup and cannot duplicate control calls", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledAdapter();
  const reset = deferred<void>();
  adapter.resetImplementation = () => reset.promise;
  const { runtime } = fixture(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  const token = await runtime.begin();
  const commit = runtime.commit(token);
  await flushUntil(() => adapter.resets.length === 1);
  const close = runtime.close();
  assert.equal(close, commit);
  assert.equal(adapter.resets[0]?.context.signal.aborted, false);

  scheduler.advance(10);
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  assert.equal(adapter.releases.length, 0);
  scheduler.advance(10);
  await assert.rejects(commit, (error: unknown) => {
    assert.equal(error instanceof TransactionTerminalError, true);
    assert.equal((error as TransactionTerminalError).outcome, "committed");
    return true;
  });
  assert.equal(adapter.resets[0]?.context.signal.aborted, true);
  assert.equal(adapter.invocations.length, 1);
  assert.equal(adapter.releases.length, 0);
  assert.equal(runtime.monitor().hasLease, true);
  assert.equal(runtime.monitor().quarantinedOperations, 1);
  reset.resolve();
  await flushUntil(() => adapter.releases.length === 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
});

test("close during opening is bounded and evicts a late lease with its original token", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledAdapter();
  const acquisition = deferred<TestLease>();
  adapter.acquireImplementation = () => acquisition.promise;
  const { runtime } = fixture(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  const opening = runtime.begin();
  const acquireToken = adapter.acquisitions[0]?.token;
  const closing = runtime.close();
  assert.equal(adapter.acquisitions[0]?.signal.aborted, true);
  scheduler.advance(10);

  await rejectsCode(opening, "OPERATION_TIMEOUT");
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  scheduler.advance(10);
  await rejectsCode(closing, "OPERATION_TIMEOUT");
  assert.equal(runtime.monitor().state, "failed");
  assert.equal(runtime.monitor().quarantinedAcquires, 1);
  acquisition.resolve({ id: 91 });
  await flushUntil(() => adapter.releases.length === 1);
  assert.equal(adapter.releases[0]?.context.token, acquireToken);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "begin-rollback",
    outcome: "none",
  });
  assert.equal(adapter.releases.length, 1);
  await flushUntil(() => runtime.monitor().state === "closed");
  assert.equal(runtime.monitor().quarantinedAcquires, 0);
});

test("close surfaces a late-acquire eviction failure during its convergence bound", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledAdapter();
  const acquisition = deferred<TestLease>();
  const releaseFailure = new Error("late lease destroy failed");
  adapter.acquireImplementation = () => acquisition.promise;
  adapter.releaseImplementation = () => {
    throw releaseFailure;
  };
  const { runtime } = fixture(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  const opening = runtime.begin();
  const closing = runtime.close();

  scheduler.advance(10);
  await rejectsCode(opening, "OPERATION_TIMEOUT");
  await flushUntil(() =>
    scheduler.tasks.some((task) => task.active && task.deadline === 20),
  );
  acquisition.resolve({ id: 92 });
  await assert.rejects(closing, (error) => error === releaseFailure);
  assert.equal(adapter.releases.length, 1);
  assert.equal(runtime.monitor().state, "failed");
  assert.equal(runtime.monitor().quarantinedAcquires, 0);
  assert.equal(runtime.monitor().releaseAttempts, 1);
  assert.equal(runtime.monitor().releaseCompletions, 0);
  assert.equal(runtime.monitor().releaseFailures, 1);
  assert.equal(runtime.monitor().lateEvictionFailures, 1);
});

test("failed acquire can retry before close", async () => {
  const adapter = new ControlledAdapter();
  const failure = new Error("connect failed");
  let attempts = 0;
  adapter.acquireImplementation = () => {
    attempts += 1;
    if (attempts === 1) throw failure;
    return { id: 42 };
  };
  const { runtime } = fixture(adapter);

  await assert.rejects(runtime.begin(), (error) => error === failure);
  assert.equal(runtime.monitor().state, "idle");
  const token = await runtime.begin();
  await runtime.rollback(token);
  assert.equal(adapter.acquisitions.length, 2);
  assert.equal(adapter.releases[0]?.lease.id, 42);
});

test("reentrant failure classifier cannot leak work and close safely rolls back", async () => {
  const adapter = new ControlledAdapter();
  const failure = new Error("declared application error");
  adapter.invokeImplementation = (_lease, invocation) => {
    if (invocation.kind === "business") throw failure;
    return { RETURN: { TYPE: "", MESSAGE: "" } };
  };
  let closing: Promise<void> | undefined;
  let runtime!: TransactionRuntime<TestLease>;
  ({ runtime } = fixture(adapter, {
    classifyFailure() {
      closing = runtime.close();
      return "recoverable";
    },
  }));
  const token = await runtime.begin();

  await assert.rejects(runtime.call(token, "Z_TX_WRITE", {}), (error) => error === failure);
  assert.notEqual(closing, undefined);
  await closing;
  assert.deepEqual(
    adapter.invocations.map((item) => item.invocation.kind),
    ["business", "rollback"],
  );
  assert.equal(adapter.releases.length, 1);
});

test("reentrant parameter getters cannot start business work after close", async () => {
  const { runtime, adapter } = fixture();
  const token = await runtime.begin();
  let closing: Promise<void> | undefined;
  const parameters = {
    get VALUE(): string {
      closing = runtime.close();
      return "must not send";
    },
  };

  await rejectsCode(
    runtime.call(token, "Z_TX_WRITE", parameters),
    "INVALID_TRANSACTION_STATE",
  );
  assert.notEqual(closing, undefined);
  await closing;
  assert.deepEqual(
    adapter.invocations.map((item) => item.invocation.kind),
    ["rollback"],
  );
  assert.equal(adapter.releases.length, 1);
});

test("reentrant scheduler close cannot cross the lease acquisition boundary", async () => {
  const adapter = new ControlledAdapter();
  let runtime!: TransactionRuntime<TestLease>;
  let reentered = false;
  const scheduler: TransactionScheduler = {
    now: () => 0,
    schedule(_delayMs, _callback) {
      if (!reentered) {
        reentered = true;
        void runtime.close();
      }
      return { cancel() {} };
    },
  };
  runtime = new TransactionRuntime({
    leases: adapter,
    operationTimeoutMs: 10,
    scheduler,
  });

  await rejectsCode(runtime.begin(), "TRANSACTION_CLOSING");
  await runtime.close();
  assert.equal(adapter.acquisitions.length, 0);
  assert.equal(adapter.invocations.length, 0);
  assert.equal(adapter.releases.length, 0);
  assert.equal(runtime.monitor().state, "closed");
});

test("an acquire abort listener observes the already-published close terminal", async () => {
  const adapter = new ControlledAdapter();
  const acquisition = deferred<TestLease>();
  const abortFailure = new Error("acquire canceled");
  let runtime!: TransactionRuntime<TestLease>;
  let reentrantClose: Promise<void> | undefined;
  adapter.acquireImplementation = (context) => {
    context.signal.addEventListener(
      "abort",
      () => {
        reentrantClose = runtime.close();
        acquisition.reject(abortFailure);
      },
      { once: true },
    );
    return acquisition.promise;
  };
  ({ runtime } = fixture(adapter));
  const opening = runtime.begin();
  const closing = runtime.close();

  assert.equal(reentrantClose, closing);
  await assert.rejects(opening, (error) => error === abortFailure);
  await closing;
  assert.equal(runtime.monitor().state, "closed");
  assert.equal(adapter.releases.length, 0);
});

test("token, concurrency, parameters, and constructor boundaries reject before I/O", async () => {
  const adapter = new ControlledAdapter();
  const { runtime } = fixture(adapter);
  const token = await runtime.begin();
  const copy = { ...token };
  await rejectsCode(runtime.call(copy, "Z", {}), "INVALID_TRANSACTION_TOKEN");
  await rejectsCode(runtime.abort(copy), "INVALID_TRANSACTION_TOKEN");
  await assert.rejects(runtime.call(token, "", {}), /functionName/);
  await assert.rejects(runtime.call(token, "Z", [] as never), /parameters/);
  assert.equal(adapter.invocations.length, 0);

  const pending = deferred<Readonly<Record<string, unknown>>>();
  adapter.invokeImplementation = () => pending.promise;
  const call = runtime.call(token, "Z_TX", {});
  await rejectsCode(runtime.call(token, "Z_TX_2", {}), "CONCURRENT_TRANSACTION_OPERATION");
  await rejectsCode(runtime.commit(token), "INVALID_TRANSACTION_STATE");
  pending.resolve({ RESULT: "ok" });
  await call;
  adapter.invokeImplementation = undefined;
  await runtime.rollback(token);

  for (const operationTimeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new TransactionRuntime({ leases: adapter, operationTimeoutMs }),
      /operationTimeoutMs/,
    );
  }
});

test("snapshots adapter and scheduler methods against later replacement", async () => {
  const calls: string[] = [];
  const lease: TestLease = { id: 8 };
  const adapter: TransactionLeaseAdapter<TestLease> = {
    acquire() {
      calls.push("acquire");
      return lease;
    },
    invoke(_lease, invocation) {
      calls.push(invocation.kind);
      return invocation.kind === "commit"
        ? { RETURN: { TYPE: "" } }
        : { RESULT: "ok" };
    },
    reset() {
      calls.push("reset");
    },
    release() {
      calls.push("release");
    },
  };
  const scheduler = new FakeScheduler();
  const runtime = new TransactionRuntime({
    leases: adapter,
    operationTimeoutMs: 10,
    scheduler,
  });
  adapter.acquire = () => {
    throw new Error("replacement acquire");
  };
  adapter.invoke = () => {
    throw new Error("replacement invoke");
  };
  adapter.reset = () => {
    throw new Error("replacement reset");
  };
  adapter.release = () => {
    throw new Error("replacement release");
  };
  scheduler.now = () => {
    throw new Error("replacement clock");
  };
  scheduler.schedule = () => {
    throw new Error("replacement scheduler");
  };

  const token = await runtime.begin();
  await runtime.call(token, "Z_TX", {});
  await runtime.commit(token);
  assert.deepEqual(calls, ["acquire", "business", "commit", "reset", "release"]);
});
