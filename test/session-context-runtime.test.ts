import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionContextRuntime,
  SessionContextRuntimeError,
  type SessionContextAcquireContext,
  type SessionContextCleanupContext,
  type SessionContextLeaseAdapter,
  type SessionContextReleaseDisposition,
  type SessionContextRuntimeMonitor,
  type SessionContextScheduledTask,
  type SessionContextScheduler,
  type SessionContextToken,
} from "../src/lifecycle/session-context-runtime.js";

interface TestResource {
  readonly id: number;
}

interface TestLease {
  readonly id: number;
  readonly resource: TestResource;
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

function lease(id: number): TestLease {
  return { id, resource: { id } };
}

class ControlledLeaseAdapter
  implements SessionContextLeaseAdapter<TestLease, TestResource>
{
  readonly acquired: SessionContextAcquireContext<TestResource>[] = [];
  readonly resources: TestLease[] = [];
  readonly resets: TestLease[] = [];
  readonly resetContexts: SessionContextCleanupContext[] = [];
  readonly releases: Array<{
    readonly lease: TestLease;
    readonly disposition: SessionContextReleaseDisposition;
    readonly context: SessionContextCleanupContext;
  }> = [];
  nextId = 1;
  acquireImplementation?: (
    context: SessionContextAcquireContext<TestResource>,
  ) => TestLease | PromiseLike<TestLease>;
  resourceImplementation?: (value: TestLease) => TestResource;
  resetImplementation?: (
    value: TestLease,
    resource: TestResource,
    context: SessionContextCleanupContext,
  ) => void | PromiseLike<void>;
  releaseImplementation?: (
    value: TestLease,
    disposition: SessionContextReleaseDisposition,
    context: SessionContextCleanupContext,
  ) => void | PromiseLike<void>;

  acquire(context: SessionContextAcquireContext<TestResource>): TestLease | PromiseLike<TestLease> {
    this.acquired.push(context);
    return this.acquireImplementation?.(context) ?? lease(this.nextId++);
  }

  resource(value: TestLease): TestResource {
    this.resources.push(value);
    return this.resourceImplementation?.(value) ?? value.resource;
  }

  async reset(
    value: TestLease,
    resource: TestResource,
    context: SessionContextCleanupContext,
  ): Promise<void> {
    this.resets.push(value);
    this.resetContexts.push(context);
    await this.resetImplementation?.(value, resource, context);
  }

  async release(
    value: TestLease,
    disposition: SessionContextReleaseDisposition,
    context: SessionContextCleanupContext,
  ): Promise<void> {
    this.releases.push({ lease: value, disposition, context });
    await this.releaseImplementation?.(value, disposition, context);
  }
}

interface FakeTask extends SessionContextScheduledTask {
  readonly deadline: number;
  readonly callback: () => void;
  active: boolean;
}

class FakeScheduler implements SessionContextScheduler {
  nowValue = 0;
  readonly tasks: FakeTask[] = [];
  beforeSchedule?: () => void;

  now(): number {
    return this.nowValue;
  }

  schedule(delayMs: number, callback: () => void): SessionContextScheduledTask {
    this.beforeSchedule?.();
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

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
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

function runtime(
  adapter = new ControlledLeaseAdapter(),
  overrides: Partial<ConstructorParameters<
    typeof SessionContextRuntime<TestLease, TestResource>
  >[0]> = {},
): {
  readonly runtime: SessionContextRuntime<TestLease, TestResource>;
  readonly adapter: ControlledLeaseAdapter;
} {
  const { operationTimeoutMs = 1_000, ...rest } = overrides;
  return {
    runtime: new SessionContextRuntime<TestLease, TestResource>({
      scope: {
        destinationId: "QAS",
        configurationGenerationId: "generation-7",
      },
      leases: adapter,
      operationTimeoutMs,
      ...rest,
    }),
    adapter,
  };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: SessionContextRuntimeError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof SessionContextRuntimeError && error.code === code,
  );
}

function assertReconciled(monitor: SessionContextRuntimeMonitor): void {
  assert.equal(Object.isFrozen(monitor), true);
  assert.equal(
    monitor.contexts,
    monitor.ready + monitor.ending + monitor.retiring,
  );
  assert.equal(
    monitor.pinnedLeases,
    monitor.ready +
      monitor.ending +
      monitor.retiring +
      monitor.fatalCleaning,
  );
  assert.equal(
    monitor.activeOperations <= monitor.ready + monitor.retiring,
    true,
  );
  assert.equal(monitor.references >= monitor.ready, true);
}

test("pins one generation-scoped lease and publishes immutable identities", async () => {
  const { runtime: contexts, adapter } = runtime();
  assert.deepEqual(contexts.scope, {
    destinationId: "QAS",
    configurationGenerationId: "generation-7",
  });
  assert.equal(Object.isFrozen(contexts.scope), true);

  const token = await contexts.begin();
  assert.equal(Object.isFrozen(token), true);
  assert.equal(token.destinationId, "QAS");
  assert.equal(token.configurationGenerationId, "generation-7");
  assert.equal(adapter.acquired.length, 1);
  assert.equal(adapter.acquired[0]?.token, token);
  assert.equal(adapter.acquired[0]?.scope, contexts.scope);
  assert.equal(Object.isFrozen(adapter.acquired[0]), true);
  assert.equal(await contexts.run(token, (resource) => resource.id), 1);

  assert.deepEqual(contexts.monitor(), {
    runtimeId: token.runtimeId,
    state: "open",
    contexts: 1,
    ready: 1,
    ending: 0,
    retiring: 0,
    opening: 0,
    fatalCleaning: 0,
    pinnedLeases: 1,
    references: 1,
    activeOperations: 0,
    beginCalls: 1,
    nestedBeginCalls: 0,
    beginFailures: 0,
    endCalls: 0,
    endFailures: 0,
    operationCalls: 1,
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
  });
  assertReconciled(contexts.monitor());
});

test("nested begin/end reference-counts without acquiring or releasing early", async () => {
  const { runtime: contexts, adapter } = runtime();
  const token = await contexts.begin();
  assert.equal(await contexts.begin(token), token);
  assert.equal(await contexts.begin(token), token);
  assert.equal(adapter.acquired.length, 1);
  assert.equal(contexts.monitor().references, 3);

  await contexts.end(token);
  await contexts.end(token);
  assert.equal(contexts.monitor().references, 1);
  assert.equal(adapter.resets.length, 0);
  assert.equal(adapter.releases.length, 0);

  await contexts.end(token);
  assert.equal(adapter.resets.length, 1);
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: true,
    reason: "context-end",
  });
  assert.equal(Object.isFrozen(adapter.releases[0]?.disposition), true);
  assertReconciled(contexts.monitor());
  assert.equal(contexts.monitor().pinnedLeases, 0);
  await rejectsWithCode(contexts.end(token), "UNMATCHED_CONTEXT_END");
  await rejectsWithCode(contexts.run(token, () => undefined), "CONTEXT_CLOSED");
  await rejectsWithCode(contexts.begin(token), "CONTEXT_CLOSED");
});

test("failed acquire publishes no token or lease and a later begin can retry", async () => {
  const adapter = new ControlledLeaseAdapter();
  const first = new Error("connect failed");
  let attempts = 0;
  adapter.acquireImplementation = () => {
    attempts += 1;
    if (attempts === 1) throw first;
    return lease(9);
  };
  const { runtime: contexts } = runtime(adapter);

  await assert.rejects(contexts.begin(), (error) => error === first);
  assert.equal(adapter.releases.length, 0);
  assert.equal(contexts.monitor().opening, 0);
  assert.equal(contexts.monitor().contexts, 0);
  assert.equal(contexts.monitor().beginFailures, 1);

  const token = await contexts.begin();
  assert.equal(await contexts.run(token, (resource) => resource.id), 9);
  assert.equal(contexts.monitor().pinnedLeases, 1);
});

test("resource setup failure evicts the partial lease exactly once", async () => {
  const adapter = new ControlledLeaseAdapter();
  const setupFailure = new Error("bad resource");
  let resources = 0;
  adapter.resourceImplementation = (value) => {
    resources += 1;
    if (resources === 1) throw setupFailure;
    return value.resource;
  };
  const { runtime: contexts } = runtime(adapter);

  await assert.rejects(contexts.begin(), (error) => error === setupFailure);
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "begin-rollback",
  });
  assert.equal(contexts.monitor().contexts, 0);
  assert.equal(contexts.monitor().evictions, 1);

  const token = await contexts.begin();
  assert.equal(await contexts.run(token, (resource) => resource.id), 2);
});

test("a rollback failure is retained with the begin failure", async () => {
  const adapter = new ControlledLeaseAdapter();
  const setupFailure = new Error("setup");
  const releaseFailure = new Error("release");
  adapter.resourceImplementation = () => {
    throw setupFailure;
  };
  adapter.releaseImplementation = () => {
    throw releaseFailure;
  };
  const { runtime: contexts } = runtime(adapter);

  await assert.rejects(contexts.begin(), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors, [setupFailure, releaseFailure]);
    return true;
  });
  assert.equal(adapter.releases.length, 1);
  assert.equal(contexts.monitor().releaseFailures, 1);
  assert.equal(contexts.monitor().opening, 0);
});

test("rejects a second operation deterministically while preserving the lease", async () => {
  const { runtime: contexts, adapter } = runtime();
  const token = await contexts.begin();
  const pending = deferred<number>();
  let invocations = 0;
  const first = contexts.run(token, () => {
    invocations += 1;
    return pending.promise;
  });
  assert.equal(contexts.monitor().activeOperations, 1);

  await rejectsWithCode(
    contexts.run(token, () => {
      invocations += 1;
      return 2;
    }),
    "CONCURRENT_CONTEXT_OPERATION",
  );
  assert.equal(invocations, 1);
  assert.equal(adapter.releases.length, 0);
  pending.resolve(1);
  assert.equal(await first, 1);
  assert.equal(await contexts.run(token, () => 3), 3);
  assert.equal(contexts.monitor().concurrentOperationRejections, 1);
});

test("end during an operation rejects without decrementing or releasing", async () => {
  const { runtime: contexts, adapter } = runtime();
  const token = await contexts.begin();
  await contexts.begin(token);
  const pending = deferred<void>();
  const active = contexts.run(token, () => pending.promise);

  await rejectsWithCode(contexts.end(token), "ACTIVE_CONTEXT_OPERATION");
  assert.equal(contexts.monitor().references, 2);
  assert.equal(adapter.resets.length, 0);
  assert.equal(adapter.releases.length, 0);
  pending.resolve();
  await active;

  await contexts.end(token);
  assert.equal(contexts.monitor().references, 1);
  await contexts.end(token);
  assert.equal(adapter.releases.length, 1);
  assert.equal(contexts.monitor().activeEndRejections, 1);
});

test("concurrent final ends have one reset and one release", async () => {
  const adapter = new ControlledLeaseAdapter();
  const reset = deferred<void>();
  adapter.resetImplementation = () => reset.promise;
  const { runtime: contexts } = runtime(adapter);
  const token = await contexts.begin();

  const first = contexts.end(token);
  assert.equal(contexts.monitor().ending, 1);
  await rejectsWithCode(contexts.end(token), "CONTEXT_ENDING");
  assert.equal(adapter.resets.length, 1);
  assert.equal(adapter.releases.length, 0);
  reset.resolve();
  await first;
  assert.equal(adapter.resets.length, 1);
  assert.equal(adapter.releases.length, 1);
});

test("reset failure evicts once, never returns reusable, and closes the token", async () => {
  const adapter = new ControlledLeaseAdapter();
  const resetFailure = new Error("reset failed");
  adapter.resetImplementation = () => {
    throw resetFailure;
  };
  const { runtime: contexts } = runtime(adapter);
  const token = await contexts.begin();

  await assert.rejects(contexts.end(token), (error) => error === resetFailure);
  assert.equal(adapter.resets.length, 1);
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "reset-failed",
  });
  assert.equal(contexts.monitor().resetFailures, 1);
  assert.equal(contexts.monitor().reusableReleases, 0);
  assert.equal(contexts.monitor().evictions, 1);
  assert.equal(contexts.monitor().pinnedLeases, 0);
  await rejectsWithCode(contexts.end(token), "UNMATCHED_CONTEXT_END");
});

test("reset and eviction failures are both visible but cleanup is not retried", async () => {
  const adapter = new ControlledLeaseAdapter();
  const resetFailure = new Error("reset failed");
  const evictionFailure = new Error("eviction failed after closure");
  adapter.resetImplementation = () => {
    throw resetFailure;
  };
  adapter.releaseImplementation = () => {
    throw evictionFailure;
  };
  const { runtime: contexts } = runtime(adapter);
  const token = await contexts.begin();

  await assert.rejects(contexts.end(token), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors, [
      resetFailure,
      evictionFailure,
    ]);
    return true;
  });
  assert.equal(adapter.releases.length, 1);
  await rejectsWithCode(contexts.end(token), "UNMATCHED_CONTEXT_END");
  assert.equal(adapter.releases.length, 1);
  assertReconciled(contexts.monitor());
});

test("a nonfatal operation failure leaves the same context reusable", async () => {
  const failure = new Error("ABAP exception");
  const { runtime: contexts, adapter } = runtime(
    new ControlledLeaseAdapter(),
    { isFatal: () => false },
  );
  const token = await contexts.begin();

  await assert.rejects(
    contexts.run(token, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(adapter.releases.length, 0);
  assert.equal(await contexts.run(token, (resource) => resource.id), 1);
  assert.equal(contexts.monitor().operationFailures, 1);
  assert.equal(contexts.monitor().fatalRemovals, 0);
});

test("fatal failure removes ownership, evicts once, then notifies the owner", async () => {
  const adapter = new ControlledLeaseAdapter();
  const physicalRelease = deferred<void>();
  adapter.releaseImplementation = () => physicalRelease.promise;
  const failure = new Error("peer closed");
  let observed: SessionContextRuntimeMonitor | undefined;
  let notifiedToken: SessionContextToken | undefined;
  let contexts!: SessionContextRuntime<TestLease, TestResource>;
  ({ runtime: contexts } = runtime(adapter, {
    isFatal: () => true,
    onFatal(event) {
      notifiedToken = event.token;
      observed = contexts.monitor();
    },
  }));
  const token = await contexts.begin();
  await contexts.begin(token);

  const operation = contexts.run(token, () => {
    throw failure;
  });
  await flushMicrotasks(2);
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "fatal-operation",
  });
  assert.equal(contexts.monitor().contexts, 0);
  assert.equal(contexts.monitor().fatalCleaning, 1);
  assert.equal(contexts.monitor().references, 0);
  assert.equal(notifiedToken, undefined);
  await rejectsWithCode(contexts.end(token), "CONTEXT_FATAL");
  assert.equal(adapter.releases.length, 1);

  physicalRelease.resolve();
  await assert.rejects(operation, (error) => error === failure);
  assert.equal(notifiedToken, token);
  assert.equal(observed?.contexts, 0);
  assert.equal(observed?.fatalCleaning, 0);
  assert.equal(observed?.pinnedLeases, 0);
  assert.equal(contexts.monitor().fatalRemovals, 1);
  assert.equal(contexts.monitor().ownerNotifications, 1);
  await rejectsWithCode(contexts.run(token, () => 1), "CONTEXT_FATAL");
  assert.equal(adapter.releases.length, 1);
});

test("owner notification can reenter after fatal cleanup without deadlock", async () => {
  const adapter = new ControlledLeaseAdapter();
  let replacement: SessionContextToken | undefined;
  let contexts!: SessionContextRuntime<TestLease, TestResource>;
  ({ runtime: contexts } = runtime(adapter, {
    isFatal: () => true,
    async onFatal() {
      replacement = await contexts.begin();
    },
  }));
  const token = await contexts.begin();
  const failure = new Error("fatal");

  await assert.rejects(
    contexts.run(token, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.notEqual(replacement, undefined);
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.acquired.length, 2);
  assert.equal(contexts.monitor().contexts, 1);
});

test("notification failure cannot change the fatal disposition", async () => {
  const adapter = new ControlledLeaseAdapter();
  const operationFailure = new Error("fatal");
  const notificationFailure = new Error("observer");
  const { runtime: contexts } = runtime(adapter, {
    isFatal: () => true,
    onFatal: () => {
      throw notificationFailure;
    },
  });
  const token = await contexts.begin();

  await assert.rejects(
    contexts.run(token, () => {
      throw operationFailure;
    }),
    (error) => error === operationFailure,
  );
  assert.equal(contexts.monitor().ownerNotifications, 1);
  assert.equal(contexts.monitor().ownerNotificationFailures, 1);
  assert.equal(contexts.monitor().pinnedLeases, 0);
});

test("classification failure conservatively evicts an uncertain session", async () => {
  const adapter = new ControlledLeaseAdapter();
  const operationFailure = new Error("operation");
  const classificationFailure = new Error("classifier");
  const { runtime: contexts } = runtime(adapter, {
    isFatal: () => {
      throw classificationFailure;
    },
  });
  const token = await contexts.begin();

  await assert.rejects(contexts.run(token, () => {
    throw operationFailure;
  }), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors, [
      operationFailure,
      classificationFailure,
    ]);
    return true;
  });
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.disposition.reusable, false);
  assert.equal(contexts.monitor().fatalRemovals, 1);
});

test("a reentrant classifier cannot start work before disposition", async () => {
  const adapter = new ControlledLeaseAdapter();
  let reentrant: Promise<unknown> | undefined;
  let contexts!: SessionContextRuntime<TestLease, TestResource>;
  ({ runtime: contexts } = runtime(adapter, {
    isFatal(_failure, failureContext) {
      reentrant = contexts.run(failureContext.token, () => "must not run");
      void reentrant.catch(() => undefined);
      return true;
    },
  }));
  const token = await contexts.begin();
  const failure = new Error("fatal");

  await assert.rejects(
    contexts.run(token, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.notEqual(reentrant, undefined);
  await rejectsWithCode(
    reentrant as Promise<unknown>,
    "CONCURRENT_CONTEXT_OPERATION",
  );
  assert.equal(contexts.monitor().concurrentOperationRejections, 1);
  assert.equal(adapter.releases.length, 1);
});

test("fatal eviction failure is combined and owner notification remains once", async () => {
  const adapter = new ControlledLeaseAdapter();
  const operationFailure = new Error("operation");
  const evictionFailure = new Error("eviction");
  adapter.releaseImplementation = () => {
    throw evictionFailure;
  };
  let notifications = 0;
  const { runtime: contexts } = runtime(adapter, {
    isFatal: () => true,
    onFatal: () => {
      notifications += 1;
    },
  });
  const token = await contexts.begin();

  await assert.rejects(contexts.run(token, () => {
    throw operationFailure;
  }), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual((error as AggregateError).errors, [
      operationFailure,
      evictionFailure,
    ]);
    return true;
  });
  assert.equal(adapter.releases.length, 1);
  assert.equal(notifications, 1);
  assert.equal(contexts.monitor().releaseFailures, 1);
  assert.equal(contexts.monitor().pinnedLeases, 0);
});

test("tokens cannot be forged, copied, or used with another runtime", async () => {
  const { runtime: first } = runtime();
  const { runtime: second } = runtime();
  const token = await first.begin();
  const copy = { ...token };

  await rejectsWithCode(
    first.run(copy, () => undefined),
    "INVALID_CONTEXT_TOKEN",
  );
  await rejectsWithCode(
    second.run(token, () => undefined),
    "INVALID_CONTEXT_TOKEN",
  );
  await rejectsWithCode(
    first.end(null as never),
    "INVALID_CONTEXT_TOKEN",
  );
});

test("snapshots caller methods and ignores poisoned bind properties", async () => {
  const calls: string[] = [];
  const firstLease = lease(41);
  const adapter: SessionContextLeaseAdapter<TestLease, TestResource> = {
    acquire() {
      calls.push(`acquire:${this === adapter}`);
      return firstLease;
    },
    resource(value) {
      calls.push(`resource:${this === adapter}`);
      return value.resource;
    },
    reset() {
      calls.push(`reset:${this === adapter}`);
    },
    release(_value, disposition) {
      calls.push(`release:${this === adapter}:${disposition.reusable}`);
    },
  };
  for (const operation of [
    adapter.acquire,
    adapter.resource,
    adapter.reset,
    adapter.release,
  ]) {
    Object.defineProperty(operation, "bind", {
      value: () => {
        throw new Error("poisoned bind must not run");
      },
    });
  }
  const contexts = new SessionContextRuntime({
    scope: {
      get destinationId() {
        Object.defineProperty(adapter, "acquire", {
          configurable: true,
          value: adapter.acquire,
        });
        return "destination";
      },
      configurationGenerationId: "generation",
    },
    leases: adapter,
    operationTimeoutMs: 1_000,
  });
  // Replacing methods after construction cannot alter captured operations.
  adapter.acquire = () => {
    throw new Error("replacement acquire");
  };
  adapter.resource = () => {
    throw new Error("replacement resource");
  };
  adapter.reset = () => {
    throw new Error("replacement reset");
  };
  adapter.release = () => {
    throw new Error("replacement release");
  };

  const token = await contexts.begin();
  const operation = function (resource: TestResource): number {
    return resource.id;
  };
  Object.defineProperty(operation, "bind", {
    value: () => {
      throw new Error("poisoned operation bind");
    },
  });
  assert.equal(await contexts.run(token, operation), 41);
  await contexts.end(token);
  assert.deepEqual(calls, [
    "acquire:true",
    "resource:true",
    "reset:true",
    "release:true:true",
  ]);
});

test("scope snapshot resists cross-field getter mutation and rejects controls", () => {
  const adapter = new ControlledLeaseAdapter();
  let destination = "before";
  const contexts = new SessionContextRuntime({
    scope: {
      get destinationId() {
        return destination;
      },
      get configurationGenerationId() {
        destination = "after";
        return "generation";
      },
    },
    leases: adapter,
    operationTimeoutMs: 1_000,
  });
  assert.equal(contexts.scope.destinationId, "before");
  assert.equal(contexts.scope.configurationGenerationId, "generation");
  assert.throws(
    () =>
      new SessionContextRuntime({
        scope: {
          destinationId: "bad\nidentity",
          configurationGenerationId: "generation",
        },
        leases: adapter,
        operationTimeoutMs: 1_000,
      }),
    /scope.destinationId/,
  );
});

test("monitor snapshots remain frozen and reconciled through an opening lease", async () => {
  const adapter = new ControlledLeaseAdapter();
  const acquisition = deferred<TestLease>();
  adapter.acquireImplementation = () => acquisition.promise;
  const { runtime: contexts } = runtime(adapter);
  const opening = contexts.begin();

  assert.equal(contexts.monitor().opening, 1);
  assert.equal(contexts.monitor().contexts, 0);
  assertReconciled(contexts.monitor());
  acquisition.resolve(lease(11));
  const token = await opening;
  assertReconciled(contexts.monitor());
  await contexts.end(token);
  assertReconciled(contexts.monitor());
});

test("retire is an idempotent ownership barrier and evicts a lost-token context", async () => {
  const { runtime: contexts, adapter } = runtime();
  const token = await contexts.begin();

  const first = contexts.retire();
  const second = contexts.retire();
  assert.equal(second, first);
  assert.equal(contexts.close(), first);
  assert.equal(contexts.monitor().state, "retiring");
  assert.equal(contexts.monitor().references, 0);
  assert.equal(contexts.monitor().contexts, 1);
  assert.equal(adapter.acquired.length, 1);
  await rejectsWithCode(contexts.begin(), "RUNTIME_RETIRED");
  await rejectsWithCode(contexts.begin(token), "RUNTIME_RETIRED");
  assert.equal(adapter.acquired.length, 1);

  await first;
  assert.equal(contexts.monitor().state, "retired");
  assert.equal(contexts.monitor().contexts, 0);
  assert.equal(contexts.monitor().pinnedLeases, 0);
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "runtime-retire",
  });
  assert.equal(adapter.releases[0]?.context.token, token);
  assert.equal(adapter.releases[0]?.context.signal.aborted, false);
  await rejectsWithCode(contexts.run(token, () => 1), "RUNTIME_RETIRED");
  await rejectsWithCode(contexts.end(token), "RUNTIME_RETIRED");
  assertReconciled(contexts.monitor());
});

test("retire aborts an opening acquire and evicts a late lease exactly once", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledLeaseAdapter();
  const acquisition = deferred<TestLease>();
  adapter.acquireImplementation = () => acquisition.promise;
  const { runtime: contexts } = runtime(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });

  const opening = contexts.begin();
  assert.equal(adapter.acquired.length, 1);
  assert.equal(adapter.acquired[0]?.signal.aborted, false);
  const retirement = contexts.retire();
  assert.equal(adapter.acquired[0]?.signal.aborted, true);
  assert.equal(contexts.monitor().state, "retiring");
  scheduler.advance(10);
  await rejectsWithCode(opening, "OPERATION_TIMEOUT");
  await retirement;
  assert.equal(contexts.monitor().state, "retired");
  assert.equal(contexts.monitor().opening, 0);

  acquisition.resolve(lease(77));
  await flushMicrotasks();
  assert.equal(adapter.releases.length, 1);
  assert.equal(adapter.releases[0]?.lease.id, 77);
  assert.equal(
    adapter.releases[0]?.context.token,
    adapter.acquired[0]?.token,
  );
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "runtime-retire",
  });
  await flushMicrotasks();
  assert.equal(adapter.releases.length, 1);
});

test("retire aborts and bounds an active operation before one eviction", async () => {
  const scheduler = new FakeScheduler();
  const { runtime: contexts, adapter } = runtime(
    new ControlledLeaseAdapter(),
    { operationTimeoutMs: 10, scheduler },
  );
  const token = await contexts.begin();
  const operationResult = deferred<number>();
  let operationSignal: AbortSignal | undefined;
  const operation = contexts.run(token, (_resource, context) => {
    operationSignal = context.signal;
    return operationResult.promise;
  });
  assert.equal(operationSignal?.aborted, false);

  const retirement = contexts.retire();
  assert.equal(operationSignal?.aborted, true);
  assert.equal(contexts.monitor().retiring, 1);
  assert.equal(contexts.monitor().activeOperations, 1);
  scheduler.advance(10);
  await rejectsWithCode(operation, "OPERATION_TIMEOUT");
  await retirement;
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "runtime-retire",
  });
  assert.equal(contexts.monitor().activeOperations, 0);
  assert.equal(contexts.monitor().pinnedLeases, 0);
  assertReconciled(contexts.monitor());
});

test("retire during ending aborts a hung reset and preserves its timeout", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledLeaseAdapter();
  const reset = deferred<void>();
  adapter.resetImplementation = () => reset.promise;
  const { runtime: contexts } = runtime(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  const token = await contexts.begin();

  const ending = contexts.end(token);
  assert.equal(adapter.resetContexts[0]?.signal.aborted, false);
  const retirement = contexts.retire();
  assert.equal(adapter.resetContexts[0]?.signal.aborted, true);
  assert.equal(contexts.monitor().ending, 1);
  scheduler.advance(10);
  await rejectsWithCode(ending, "OPERATION_TIMEOUT");
  await rejectsWithCode(retirement, "OPERATION_TIMEOUT");
  assert.equal(adapter.resets.length, 1);
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "reset-failed",
  });
  assert.equal(contexts.monitor().state, "retired");
  assert.equal(contexts.monitor().pinnedLeases, 0);
  assert.equal(contexts.monitor().retireFailures, 1);
});

test("retire waits for a bounded fatal eviction without invoking release twice", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledLeaseAdapter();
  const physicalEviction = deferred<void>();
  adapter.releaseImplementation = () => physicalEviction.promise;
  const operationFailure = new Error("peer closed");
  const { runtime: contexts } = runtime(adapter, {
    operationTimeoutMs: 10,
    scheduler,
    isFatal: () => true,
  });
  const token = await contexts.begin();

  const operation = contexts.run(token, () => {
    throw operationFailure;
  });
  await flushMicrotasks(2);
  assert.equal(adapter.releases.length, 1);
  assert.equal(contexts.monitor().fatalCleaning, 1);
  const retirement = contexts.retire();
  assert.equal(adapter.releases[0]?.context.signal.aborted, false);
  scheduler.advance(10);

  await assert.rejects(operation, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal((error as AggregateError).errors[0], operationFailure);
    assert.equal(
      (error as AggregateError).errors[1] instanceof SessionContextRuntimeError,
      true,
    );
    return true;
  });
  await rejectsWithCode(retirement, "OPERATION_TIMEOUT");
  assert.equal(adapter.releases.length, 1);
  assert.equal(contexts.monitor().state, "retired");
  assert.equal(contexts.monitor().pinnedLeases, 0);
  physicalEviction.resolve();
  await flushMicrotasks();
  assert.equal(adapter.releases.length, 1);
});

test("a lost-token eviction which hangs still closes logical ownership by deadline", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledLeaseAdapter();
  const physicalEviction = deferred<void>();
  adapter.releaseImplementation = () => physicalEviction.promise;
  const { runtime: contexts } = runtime(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  });
  await contexts.begin();

  const retirement = contexts.retire();
  assert.equal(adapter.releases.length, 1);
  scheduler.advance(10);
  await rejectsWithCode(retirement, "OPERATION_TIMEOUT");
  assert.equal(adapter.releases.length, 1);
  assert.equal(contexts.monitor().state, "retired");
  assert.equal(contexts.monitor().contexts, 0);
  assert.equal(contexts.monitor().pinnedLeases, 0);
  assert.equal(contexts.monitor().releaseFailures, 1);
});

test("fatal owner notification has a signal and cannot exceed its deadline", async () => {
  const scheduler = new FakeScheduler();
  const notification = deferred<void>();
  const operationFailure = new Error("fatal operation");
  let notificationSignal: AbortSignal | undefined;
  const { runtime: contexts } = runtime(new ControlledLeaseAdapter(), {
    operationTimeoutMs: 10,
    scheduler,
    isFatal: () => true,
    onFatal(event) {
      notificationSignal = event.signal;
      return notification.promise;
    },
  });
  const token = await contexts.begin();

  const operation = contexts.run(token, () => {
    throw operationFailure;
  });
  await flushUntil(() => notificationSignal !== undefined);
  assert.equal(notificationSignal?.aborted, false);
  scheduler.advance(10);
  await assert.rejects(operation, (error) => error === operationFailure);
  assert.equal(notificationSignal?.aborted, true);
  assert.equal(contexts.monitor().ownerNotificationFailures, 1);
  assert.equal(contexts.monitor().boundaryTimeouts, 1);
  assert.equal(contexts.monitor().pinnedLeases, 0);
});

test("a nonfatal classifier cannot reentrantly add a context reference", async () => {
  const adapter = new ControlledLeaseAdapter();
  let reentrantBegin: Promise<SessionContextToken> | undefined;
  let contexts!: SessionContextRuntime<TestLease, TestResource>;
  ({ runtime: contexts } = runtime(adapter, {
    isFatal(_failure, context) {
      reentrantBegin = contexts.begin(context.token);
      void reentrantBegin.catch(() => undefined);
      return false;
    },
  }));
  const token = await contexts.begin();
  const failure = new Error("nonfatal");

  await assert.rejects(
    contexts.run(token, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.notEqual(reentrantBegin, undefined);
  await rejectsWithCode(
    reentrantBegin as Promise<SessionContextToken>,
    "ACTIVE_CONTEXT_OPERATION",
  );
  assert.equal(contexts.monitor().references, 1);
  await contexts.end(token);
  assert.equal(adapter.releases.length, 1);
});

test("validates and snapshots the finite scheduler boundary", async () => {
  const adapter = new ControlledLeaseAdapter();
  for (const operationTimeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        new SessionContextRuntime({
          scope: {
            destinationId: "QAS",
            configurationGenerationId: "generation",
          },
          leases: adapter,
          operationTimeoutMs,
        }),
      /operationTimeoutMs/,
    );
  }

  const scheduler = new FakeScheduler();
  const contexts = new SessionContextRuntime({
    scope: {
      destinationId: "QAS",
      configurationGenerationId: "generation",
    },
    leases: adapter,
    operationTimeoutMs: 10,
    scheduler,
  });
  scheduler.now = () => {
    throw new Error("replacement now must not run");
  };
  scheduler.schedule = () => {
    throw new Error("replacement schedule must not run");
  };
  const token = await contexts.begin();
  await contexts.end(token);
  assert.equal(adapter.acquired[0]?.signal instanceof AbortSignal, true);
  assert.equal(adapter.resetContexts[0]?.signal instanceof AbortSignal, true);
  assert.equal(adapter.releases[0]?.context.signal instanceof AbortSignal, true);
});

test("retirement reentered by the scheduler cannot publish a reusable release", async () => {
  const scheduler = new FakeScheduler();
  const adapter = new ControlledLeaseAdapter();
  let armRetirement = false;
  let retirement: Promise<void> | undefined;
  let contexts!: SessionContextRuntime<TestLease, TestResource>;
  scheduler.beforeSchedule = () => {
    if (!armRetirement) return;
    armRetirement = false;
    retirement = contexts.retire();
  };
  adapter.resetImplementation = () => {
    // The next scheduled boundary is the nominally reusable release.
    armRetirement = true;
  };
  ({ runtime: contexts } = runtime(adapter, {
    operationTimeoutMs: 10,
    scheduler,
  }));
  const token = await contexts.begin();

  await contexts.end(token);
  assert.notEqual(retirement, undefined);
  await retirement;
  assert.equal(adapter.releases.length, 1);
  assert.deepEqual(adapter.releases[0]?.disposition, {
    reusable: false,
    reason: "runtime-retire",
  });
  assert.equal(adapter.releases[0]?.context.signal.aborted, true);
  assert.equal(contexts.monitor().reusableReleases, 0);
  assert.equal(contexts.monitor().evictions, 1);
  assert.equal(contexts.monitor().state, "retired");
});
