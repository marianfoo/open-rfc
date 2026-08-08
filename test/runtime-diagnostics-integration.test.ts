import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import {
  Client,
  RfcDiagnosticDispatcher,
  type RfcDiagnosticEmitter,
  type RfcDiagnosticEvent,
} from "../src/index.js";
import { ConnectionPoolRuntime } from
  "../src/pool/connection-pool-runtime.js";
import {
  MetadataRepositoryMode,
  MetadataRepositoryRuntime,
  createMetadataCapabilityKey,
  createMetadataStructuralKey,
} from "../src/metadata/repository-runtime.js";
import { DirectDestinationMetadataPreflightError } from
  "../src/destination/direct-destination-owner.js";
import { bindClientDestinationOwnerFactory } from
  "../src/compat/node-rfc-client.js";
import type { DirectDestinationOwner } from
  "../src/destination/direct-destination-owner.js";

async function drain(
  dispatcher: RfcDiagnosticDispatcher,
): Promise<void> {
  // Runtime reporters defer the external emitter; the dispatcher then defers
  // its sink. Cross both scheduling boundaries before asserting evidence.
  await nextTurn();
  await dispatcher.flush();
}

function recordingDiagnostics(): {
  readonly dispatcher: RfcDiagnosticDispatcher;
  readonly events: RfcDiagnosticEvent[];
} {
  const events: RfcDiagnosticEvent[] = [];
  const dispatcher = new RfcDiagnosticDispatcher({
    sink: { write: (event) => { events.push(event); } },
    level: "trace",
  });
  return { dispatcher, events };
}

test("low-level pool diagnostics cover wait, acquire, release, retire, and shutdown outside transitions", async () => {
  const { dispatcher, events } = recordingDiagnostics();
  let pool!: ConnectionPoolRuntime<{ readonly id: number }>;
  let observerRanInline = false;
  let observerInputFrozen = false;
  const emitter: RfcDiagnosticEmitter = {
    emit(event) {
      observerRanInline = true;
      observerInputFrozen = Object.isFrozen(event);
      // If this executes synchronously inside a transition it can reenter the
      // state machine. The deferred boundary must instead see reconciled state.
      pool.monitor();
      return dispatcher.emit(event);
    },
  };
  pool = new ConnectionPoolRuntime({
    factory: {
      create: () => Object.freeze({ id: 1 }),
      destroy: () => undefined,
    },
    maxConnections: 1,
    maxWaiters: 2,
    // This case verifies diagnostic ordering, not wall-clock scheduling. Keep
    // enough headroom for a saturated hosted runner so unrelated test-process
    // load cannot turn an uncontended acquire into a timeout.
    acquireTimeoutMs: 5_000,
    diagnostics: emitter,
  });

  const acquiring = pool.acquireOne();
  assert.equal(observerRanInline, false);
  const lease = await acquiring;
  await pool.release(lease, { reusable: false });
  await pool.retire();
  await drain(dispatcher);

  assert.equal(observerRanInline, true);
  assert.equal(observerInputFrozen, true);
  assert.deepEqual(
    events.map(({ code }) => code),
    [
      "pool.wait",
      "pool.acquire",
      "pool.release",
      "pool.retired",
      "pool.shutdown",
      "pool.retired",
      "pool.closed",
    ],
  );
  assert.equal(events.every((event) => Object.isFrozen(event)), true);
  assert.equal(events.some((event) => "message" in event), false);
  assert.equal(events[0]!.correlationId, events[1]!.correlationId);
  assert.equal(events[2]!.correlationId, events[3]!.correlationId);
  assert.equal(events[4]!.correlationId, events[5]!.correlationId);
  assert.equal(events[5]!.correlationId, events[6]!.correlationId);
  await dispatcher.close();
});

test("pool timeout and rejection diagnostics expose classifications without error text", async () => {
  const { dispatcher, events } = recordingDiagnostics();
  let now = 0;
  const scheduled: Array<{ callback: () => void; canceled: boolean }> = [];
  const scheduler = {
    now: () => now,
    schedule(_delayMs: number, callback: () => void) {
      const task = { callback, canceled: false };
      scheduled.push(task);
      return Object.freeze({ cancel: () => { task.canceled = true; } });
    },
  };
  const pool = new ConnectionPoolRuntime({
    factory: {
      create: () => Object.freeze({ id: 1 }),
      destroy: () => undefined,
    },
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 5,
    scheduler,
    diagnostics: dispatcher,
  });
  const held = await pool.acquireOne();
  const timedOut = pool.acquireOne();
  await assert.rejects(pool.acquireOne(), /waiter limit/u);
  now = 5;
  for (const task of scheduled) {
    if (!task.canceled) task.callback();
  }
  await assert.rejects(timedOut, /timed out/u);
  await pool.release(held);
  await pool.close();
  await drain(dispatcher);

  assert.equal(events.some(({ code }) => code === "pool.timed-out"), true);
  assert.equal(events.some(({ code }) => code === "pool.rejected"), true);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /waiter limit|timed out/u);
  await dispatcher.close();
});

test("metadata diagnostics distinguish lookup, miss, hit, failure, and invalidation without identities", async () => {
  const { dispatcher, events } = recordingDiagnostics();
  const structural = createMetadataStructuralKey({
    backendKey: "secret-backend",
    metadataGeneration: "generation",
    language: "E",
    objectKind: "function",
    objectName: "SECRET_FUNCTION",
  });
  const capability = createMetadataCapabilityKey({
    backendKey: "secret-backend",
    principalKey: "secret-principal",
  });
  let fail = false;
  const repository = new MetadataRepositoryRuntime({
    maxEntries: 2,
    maxRetainedBytes: 1_024,
    diagnostics: dispatcher,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        if (fail) throw new Error("private adapter failure");
        return Object.freeze({
          value: Object.freeze({ name: "safe descriptor" }),
          retainedBytes: 32,
        });
      },
    },
  });
  const lookup = Object.freeze({
    structural,
    capability,
    mode: MetadataRepositoryMode.Classic,
  });

  await repository.get(lookup);
  await repository.get(lookup);
  repository.invalidate(structural);
  fail = true;
  await assert.rejects(repository.get(lookup), /private adapter failure/u);
  await drain(dispatcher);

  assert.deepEqual(
    events.map(({ code }) => code),
    [
      "metadata.lookup",
      "metadata.cache-miss",
      "metadata.lookup",
      "metadata.cache-hit",
      "metadata.invalidated",
      "metadata.lookup",
      "metadata.cache-miss",
      "metadata.failed",
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /secret-backend|secret-principal|SECRET_FUNCTION|private adapter failure/u,
  );
  await repository.retire();
  await dispatcher.close();
});

test("compatibility Client diagnostics cover open, invoke, cancel, and close without request data", async (t) => {
  const { dispatcher, events } = recordingDiagnostics();
  const lease = Object.freeze({});
  let pendingAbort: AbortSignal | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  const owner = {
    async acquireApplication() { return lease; },
    async applicationInfo() {
      return Object.freeze({
        localAddress: "127.0.0.1",
        peerCodePage: "4103",
        peerAcceptInfo: 0,
        generationHandle: 7,
        connectionIndex: 7,
      });
    },
    async invoke(
      _lease: object,
      request: { readonly functionName: string },
      signal: AbortSignal,
    ) {
      if (request.functionName === "Z_SECRET_BLOCKED") {
        pendingAbort = signal;
        return new Promise<never>((_resolve, reject) => {
          rejectPending = reject;
          signal.addEventListener("abort", () => reject(
            new DirectDestinationMetadataPreflightError(
              request.functionName,
              new Error("private cancellation detail"),
            ),
          ), { once: true });
        });
      }
      return Object.freeze({ RESULT: "private response" });
    },
    async releaseApplication() {},
    async retire() {},
  } as unknown as DirectDestinationOwner;
  const restore = bindClientDestinationOwnerFactory({ create: () => owner });
  t.after(restore);
  const client = new Client({
    ashost: "secret-host",
    sysnr: "00",
    client: "001",
    user: "secret-user",
    passwd: ["secret", "password"].join("-"),
  }, { diagnostics: dispatcher });

  await client.open() as Client;
  assert.deepEqual(await client.call("Z_SECRET_SUCCESS", { SECRET: "value" }), {
    RESULT: "private response",
  });
  const canceled = client.call("Z_SECRET_BLOCKED", { TOKEN: "private" });
  while (pendingAbort === undefined) await nextTurn();
  await client.cancel() as void;
  await assert.rejects(canceled, /canceled/u);
  rejectPending = undefined;
  await client.close() as void;
  await drain(dispatcher);

  assert.deepEqual(
    events.map(({ code }) => code),
    [
      "network.connect",
      "network.opened",
      "lifecycle.opened",
      "call.started",
      "call.succeeded",
      "call.started",
      "call.canceled",
      "network.closed",
      "lifecycle.closed",
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /secret-host|secret-user|secret-password|Z_SECRET|TOKEN|private response/u,
  );
  await dispatcher.close();
});

test("runtime diagnostic buffering is bounded and observer failures never change metadata state", async () => {
  let delivered = 0;
  const diagnostics: RfcDiagnosticEmitter = {
    emit() {
      delivered += 1;
      throw new Error("hostile observer");
    },
  };
  const repository = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 32,
    diagnostics,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        return Object.freeze({
          value: Object.freeze({ value: 1 }),
          retainedBytes: 8,
        });
      },
    },
  });
  const structural = createMetadataStructuralKey({
    backendKey: "backend",
    metadataGeneration: "generation",
    language: "E",
    objectKind: "function",
    objectName: "RFC_PING",
  });

  for (let index = 0; index < 400; index += 1) {
    repository.invalidate(structural);
  }
  assert.equal(delivered, 0, "observer must not run inline");
  await nextTurn();
  assert.equal(delivered, 256, "one runtime reporter has a fixed buffer bound");
  assert.equal(repository.monitor().invalidations, 400);
  await repository.retire();
});

test("runtime diagnostics configuration rejects missing emitters before any I/O", () => {
  assert.throws(
    () => new Client({
      ashost: "example.invalid",
      sysnr: "00",
      client: "001",
      user: "unused",
      passwd: "unused",
    }, { diagnostics: {} as never }),
    /clientOptions\.diagnostics must expose emit/u,
  );
  assert.throws(
    () => new ConnectionPoolRuntime({
      factory: {
        create: () => Object.freeze({}),
        destroy: () => undefined,
      },
      maxConnections: 1,
      maxWaiters: 1,
      acquireTimeoutMs: 10,
      diagnostics: {} as never,
    }),
    /runtime diagnostics must expose emit/u,
  );
});
