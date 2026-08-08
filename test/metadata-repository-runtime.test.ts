import assert from "node:assert/strict";
import test from "node:test";

import {
  MetadataAccessFailure,
  MetadataLoadStrategy,
  MetadataRepositoryMode,
  MetadataRepositoryRuntime,
  createMetadataCapabilityKey,
  createMetadataStructuralKey,
  type MetadataAdapter,
  type MetadataLookup,
  type MetadataRepositoryRuntimeOptions,
  type MetadataSnapshot,
} from "../src/metadata/repository-runtime.js";
import { ImmutableMetadataMap } from "../src/metadata/immutable-map.js";

interface Descriptor {
  readonly name: string;
  readonly revision: number;
  readonly fields: readonly string[];
}

function descriptor(name: string, revision: number, retainedBytes = 10): MetadataSnapshot<Descriptor> {
  return Object.freeze({
    value: Object.freeze({
      name,
      revision,
      fields: Object.freeze([`${name}-FIELD`]),
    }),
    retainedBytes,
  });
}

const A = createMetadataStructuralKey({
  backendKey: "backend:QAS:001",
  metadataGeneration: "2026-07-15",
  language: "EN",
  objectKind: "function",
  objectName: "STFC_CONNECTION",
});
const B = createMetadataStructuralKey({
  backendKey: "backend:QAS:001",
  metadataGeneration: "2026-07-15",
  language: "EN",
  objectKind: "function",
  objectName: "RFC_PING",
});
const C = createMetadataStructuralKey({
  backendKey: "backend:QAS:001",
  metadataGeneration: "2026-07-15",
  language: "EN",
  objectKind: "type",
  objectName: "RFCTEST",
});
const FULL = createMetadataCapabilityKey({
  backendKey: A.backendKey,
  principalKey: "principal:full",
});
const RESTRICTED = createMetadataCapabilityKey({
  backendKey: A.backendKey,
  principalKey: "principal:restricted",
});

function lookup(
  structural = A,
  capability = FULL,
  mode = MetadataRepositoryMode.Classic,
): MetadataLookup {
  return Object.freeze({ structural, capability, mode });
}

function adapter(overrides: Partial<MetadataAdapter<Descriptor>> = {}): MetadataAdapter<Descriptor> {
  return {
    async probeOptimized() {},
    async authorize() {},
    async load({ structural }) {
      return descriptor(structural.objectName, 1);
    },
    ...overrides,
  };
}

test("keeps structural and principal-scoped capability keys separate", () => {
  assert.equal("principalKey" in A, false);
  assert.equal(FULL.backendKey, A.backendKey);
  assert.notEqual(FULL.id, RESTRICTED.id);
  assert.equal(Object.isFrozen(A), true);
  assert.equal(Object.isFrozen(FULL), true);

  const otherLanguage = createMetadataStructuralKey({
    ...A,
    language: "DE",
  });
  const otherGeneration = createMetadataStructuralKey({
    ...A,
    metadataGeneration: "2026-07-16",
  });
  assert.notEqual(A.id, otherLanguage.id);
  assert.notEqual(A.id, otherGeneration.id);
});

test("rejects forged or cross-backend identities before adapter access", async () => {
  let adapterCalls = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    adapter: adapter({
      async authorize() {
        adapterCalls += 1;
      },
    }),
  });
  const forged = Object.freeze({ ...A, id: B.id });
  await assert.rejects(
    () => runtime.get(lookup(forged)),
    /structural key does not match/,
  );
  const otherBackend = createMetadataCapabilityKey({
    backendKey: "backend:other",
    principalKey: "principal:full",
  });
  await assert.rejects(
    () => runtime.get(lookup(A, otherBackend)),
    /same backend/,
  );
  assert.equal(adapterCalls, 0);
});

test("snapshots caller-owned identity and mode before authorization", async () => {
  const authorizationPrincipals: string[] = [];
  const authorizationContexts: Array<{
    backendKey: string;
    principalKey: string;
    objectName: string;
    language: string;
    mode: MetadataRepositoryMode;
  }> = [];
  let probes = 0;
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 100,
    adapter: adapter({
      async probeOptimized() {
        probes += 1;
      },
      async authorize({ structural, capability, mode }) {
        authorizationPrincipals.push(capability.principalKey);
        authorizationContexts.push({
          backendKey: capability.backendKey,
          principalKey: capability.principalKey,
          objectName: structural.objectName,
          language: structural.language,
          mode,
        });
        assert.equal(Object.isFrozen(structural), true);
        assert.equal(Object.isFrozen(capability), true);
        if (capability.principalKey === RESTRICTED.principalKey) {
          throw new MetadataAccessFailure("authorization", "object denied");
        }
      },
      async load({ structural }) {
        loads += 1;
        return descriptor(structural.objectName, loads);
      },
    }),
  });

  const mutableStructural = { ...A };
  const mutableCapability = { ...RESTRICTED };
  const mutableLookup = {
    structural: mutableStructural,
    capability: mutableCapability,
    mode: MetadataRepositoryMode.Classic,
  } as MetadataLookup;

  const denied = runtime.get(mutableLookup);
  mutableCapability.principalKey = FULL.principalKey;
  mutableCapability.backendKey = "backend:other";
  mutableStructural.backendKey = "backend:other";
  mutableStructural.objectName = B.objectName;
  mutableStructural.language = "DE";
  (mutableLookup as { mode: MetadataRepositoryMode }).mode =
    MetadataRepositoryMode.Auto;

  await assert.rejects(
    () => denied,
    (error: unknown) =>
      error instanceof MetadataAccessFailure &&
      error.classification === "authorization",
  );
  assert.deepEqual(authorizationContexts, [
    {
      backendKey: A.backendKey,
      principalKey: RESTRICTED.principalKey,
      objectName: A.objectName,
      language: A.language,
      mode: MetadataRepositoryMode.Classic,
    },
  ]);
  assert.equal(probes, 0);
  assert.equal(loads, 0);

  const exposed = await runtime.get(lookup(A, FULL));
  assert.equal(exposed.name, A.objectName);
  assert.deepEqual(authorizationPrincipals, [
    RESTRICTED.principalKey,
    FULL.principalKey,
  ]);
  assert.equal(loads, 1);

  await assert.rejects(
    () => runtime.get(lookup(A, RESTRICTED)),
    (error: unknown) =>
      error instanceof MetadataAccessFailure &&
      error.classification === "authorization",
  );
  assert.deepEqual(authorizationPrincipals, [
    RESTRICTED.principalKey,
    FULL.principalKey,
    RESTRICTED.principalKey,
  ]);
});

test("caller mutation cannot redirect a load or poison another structural cache key", async () => {
  const accessed: Array<{
    backendKey: string;
    objectName: string;
    language: string;
    mode: MetadataRepositoryMode;
  }> = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 8,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async load({ structural, capability, mode }) {
        assert.equal(structural.backendKey, capability.backendKey);
        accessed.push({
          backendKey: structural.backendKey,
          objectName: structural.objectName,
          language: structural.language,
          mode,
        });
        return descriptor(structural.objectName, accessed.length);
      },
    }),
  });
  const mutableStructural = { ...A };
  const mutableCapability = { ...FULL };
  const mutableLookup = {
    structural: mutableStructural,
    capability: mutableCapability,
    mode: MetadataRepositoryMode.Classic,
  } as MetadataLookup;

  const first = runtime.get(mutableLookup);
  mutableStructural.backendKey = "backend:other";
  mutableStructural.objectName = B.objectName;
  mutableStructural.language = "DE";
  mutableCapability.backendKey = "backend:other";
  (mutableLookup as { mode: MetadataRepositoryMode }).mode =
    MetadataRepositoryMode.LegacyV3;

  assert.equal((await first).name, A.objectName);
  const changed = createMetadataStructuralKey({
    ...A,
    objectName: B.objectName,
    language: "DE",
  });
  assert.equal((await runtime.get(lookup(changed, FULL))).name, B.objectName);
  assert.deepEqual(accessed, [
    {
      backendKey: A.backendKey,
      objectName: A.objectName,
      language: A.language,
      mode: MetadataRepositoryMode.Classic,
    },
    {
      backendKey: A.backendKey,
      objectName: B.objectName,
      language: "DE",
      mode: MetadataRepositoryMode.Classic,
    },
  ]);
});

test("rechecks retirement after lookup accessors before backend work", async () => {
  let probes = 0;
  let authorizations = 0;
  let loads = 0;
  let runtime!: MetadataRepositoryRuntime<Descriptor>;
  runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    adapter: adapter({
      async probeOptimized() {
        probes += 1;
      },
      async authorize() {
        authorizations += 1;
      },
      async load() {
        loads += 1;
        return descriptor("unexpected", 1);
      },
    }),
  });
  const reentrantLookup = {
    structural: A,
    capability: FULL,
    get mode() {
      runtime.retire();
      return MetadataRepositoryMode.Auto;
    },
  } as MetadataLookup;

  await assert.rejects(
    () => runtime.get(reentrantLookup),
    /metadata repository is retired/,
  );
  assert.deepEqual(
    {
      state: runtime.monitor().state,
      probes,
      authorizations,
      loads,
    },
    {
      state: "retired",
      probes: 0,
      authorizations: 0,
      loads: 0,
    },
  );
});

test("snapshots and binds adapter operations for the lifetime of a repository generation", async () => {
  const calls: string[] = [];
  const mutableAdapter = adapter({
    async probeOptimized() {
      calls.push("original:probe");
    },
    async authorize() {
      calls.push("original:authorize");
    },
    async load() {
      calls.push("original:load");
      return descriptor("original", 1);
    },
  });
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: mutableAdapter,
  });

  mutableAdapter.probeOptimized = async () => {
    throw new Error("mutated probe must not run");
  };
  mutableAdapter.authorize = async () => {
    throw new Error("mutated authorization must not run");
  };
  mutableAdapter.load = async () => {
    throw new Error("mutated load must not run");
  };

  const loaded = await runtime.get(
    lookup(A, FULL, MetadataRepositoryMode.Auto),
  );
  assert.equal(loaded.name, "original");
  assert.deepEqual(calls, [
    "original:probe",
    "original:authorize",
    "original:load",
  ]);
});

test("rejects incomplete adapters during repository construction", () => {
  for (const method of ["probeOptimized", "authorize", "load"] as const) {
    const invalidAdapter = {
      ...adapter(),
      [method]: undefined,
    } as unknown as MetadataAdapter<Descriptor>;
    assert.throws(
      () => new MetadataRepositoryRuntime({
        maxEntries: 1,
        maxRetainedBytes: 10,
        adapter: invalidAdapter,
      }),
      new RegExp(`provide ${method}`),
    );
  }
});

test("snapshots every repository option and adapter operation exactly once", async () => {
  const reads = new Map<string, number>();
  const once = <T>(name: string, first: T, later: T): T => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    return count === 1 ? first : later;
  };
  const firstProbe = async () => {};
  const firstAuthorize = async () => {};
  const firstLoad = async () => descriptor("first", 1);
  const failing = async () => {
    throw new Error("later adapter operation must not be bound");
  };
  const metadataAdapter: MetadataAdapter<Descriptor> = {
    get probeOptimized() {
      return once("adapter.probeOptimized", firstProbe, failing);
    },
    get authorize() {
      return once("adapter.authorize", firstAuthorize, failing);
    },
    get load() {
      return once("adapter.load", firstLoad, failing);
    },
  };
  const options = {
    get maxEntries() {
      return once("options.maxEntries", 2, 0);
    },
    get maxRetainedBytes() {
      return once("options.maxRetainedBytes", 100, 0);
    },
    get maxProbeEntries() {
      return once("options.maxProbeEntries", 3, 1);
    },
    get maxAuthorizationEntries() {
      return once("options.maxAuthorizationEntries", 4, 1);
    },
    get maxObjectEpochEntries() {
      return once("options.maxObjectEpochEntries", 5, 1);
    },
    get maxInFlightLoads() {
      return once("options.maxInFlightLoads", 6, 1);
    },
    get maxSnapshotNodes() {
      return once("options.maxSnapshotNodes", 7, 1);
    },
    get maxSnapshotDepth() {
      return once("options.maxSnapshotDepth", 8, 1);
    },
    get maxSnapshotProperties() {
      return once("options.maxSnapshotProperties", 9, 1);
    },
    get adapter() {
      return once("options.adapter", metadataAdapter, adapter());
    },
  } satisfies MetadataRepositoryRuntimeOptions<Descriptor>;

  const runtime = new MetadataRepositoryRuntime(options);
  assert.equal((await runtime.get(lookup())).name, "first");
  const monitor = runtime.monitor();
  assert.deepEqual(
    {
      probes: monitor.maxProbeEntries,
      authorizations: monitor.maxAuthorizationEntries,
      epochs: monitor.maxObjectEpochEntries,
      loads: monitor.maxInFlightLoads,
      nodes: monitor.maxSnapshotNodes,
      depth: monitor.maxSnapshotDepth,
      properties: monitor.maxSnapshotProperties,
    },
    {
      probes: 3,
      authorizations: 4,
      epochs: 5,
      loads: 6,
      nodes: 7,
      depth: 8,
      properties: 9,
    },
  );
  for (const field of [
    "options.maxEntries",
    "options.maxRetainedBytes",
    "options.maxProbeEntries",
    "options.maxAuthorizationEntries",
    "options.maxObjectEpochEntries",
    "options.maxInFlightLoads",
    "options.maxSnapshotNodes",
    "options.maxSnapshotDepth",
    "options.maxSnapshotProperties",
    "options.adapter",
    "adapter.probeOptimized",
    "adapter.authorize",
    "adapter.load",
  ]) {
    assert.equal(reads.get(field), 1, field);
  }
});

test("deduplicates concurrent cold loads and retries a failed load", async () => {
  let resolveFirst!: (snapshot: MetadataSnapshot<Descriptor>) => void;
  const pending = new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
    resolveFirst = resolve;
  });
  let loads = 0;
  let failNext = false;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 8,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async load() {
        loads += 1;
        if (failNext) {
          failNext = false;
          throw new Error("transient load failure");
        }
        if (loads === 1) return pending;
        return descriptor("STFC_CONNECTION", loads);
      },
    }),
  });

  const first = runtime.get(lookup());
  const joined = runtime.get(lookup());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  resolveFirst(descriptor("STFC_CONNECTION", 1));
  assert.equal(await first, await joined);
  assert.equal(runtime.monitor().inFlightJoins, 1);

  runtime.invalidate(A);
  failNext = true;
  await assert.rejects(() => runtime.get(lookup()), /transient load failure/);
  const retried = await runtime.get(lookup());
  assert.equal(retried.revision, 3);
  assert.equal(loads, 3);
});

test("deduplicates an optimized capability probe for one backend principal", async () => {
  let resolveProbe!: () => void;
  const pendingProbe = new Promise<void>((resolve) => {
    resolveProbe = resolve;
  });
  let probes = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 100,
    adapter: adapter({
      async probeOptimized() {
        probes += 1;
        return pendingProbe;
      },
    }),
  });
  const first = runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto));
  const second = runtime.get(lookup(B, FULL, MetadataRepositoryMode.Auto));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  resolveProbe();
  await Promise.all([first, second]);
  assert.equal(runtime.monitor().optimizedProbeCalls, 1);
  assert.equal(runtime.monitor().optimizedProbeHits, 1);
});

test("separates probe and authorization identities by repository mode", async () => {
  const probeModes: MetadataRepositoryMode[] = [];
  const authorizationModes: MetadataRepositoryMode[] = [];
  const loads: Array<{
    mode: MetadataRepositoryMode;
    strategy: MetadataLoadStrategy;
  }> = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async probeOptimized({ mode }) {
        probeModes.push(mode);
        if (mode === MetadataRepositoryMode.Auto) {
          throw new MetadataAccessFailure("unavailable", "auto probe unavailable");
        }
      },
      async authorize({ mode }) {
        authorizationModes.push(mode);
      },
      async load({ structural, mode, strategy }) {
        loads.push({ mode, strategy });
        return descriptor(structural.objectName, loads.length);
      },
    }),
  });

  await runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto));
  await runtime.get(lookup(B, FULL, MetadataRepositoryMode.OptimizedOnly));
  await runtime.get(lookup(C, FULL, MetadataRepositoryMode.Auto));
  const optimizedCached = await runtime.get(
    lookup(A, FULL, MetadataRepositoryMode.OptimizedOnly),
  );

  assert.equal(optimizedCached.name, A.objectName);
  assert.deepEqual(probeModes, [
    MetadataRepositoryMode.Auto,
    MetadataRepositoryMode.OptimizedOnly,
  ]);
  assert.deepEqual(authorizationModes, [
    MetadataRepositoryMode.Auto,
    MetadataRepositoryMode.OptimizedOnly,
    MetadataRepositoryMode.Auto,
    MetadataRepositoryMode.OptimizedOnly,
  ]);
  assert.deepEqual(loads, [
    {
      mode: MetadataRepositoryMode.Auto,
      strategy: MetadataLoadStrategy.Classic,
    },
    {
      mode: MetadataRepositoryMode.OptimizedOnly,
      strategy: MetadataLoadStrategy.Optimized,
    },
    {
      mode: MetadataRepositoryMode.Auto,
      strategy: MetadataLoadStrategy.Classic,
    },
  ]);
  assert.equal(runtime.monitor().optimizedProbeCalls, 2);
  assert.equal(runtime.monitor().optimizedProbeHits, 2);
  assert.equal(runtime.monitor().authorizationCalls, 4);
});

test("does not share a cold-load promise across different principals", async () => {
  const pending = new Map<
    string,
    (snapshot: MetadataSnapshot<Descriptor>) => void
  >();
  const loads: string[] = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 100,
    adapter: adapter({
      async load({ capability }) {
        loads.push(capability.id);
        return new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
          pending.set(capability.id, resolve);
        });
      },
    }),
  });
  const full = runtime.get(lookup(A, FULL));
  const restricted = runtime.get(lookup(A, RESTRICTED));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(loads), new Set([FULL.id, RESTRICTED.id]));
  assert.equal(runtime.monitor().inFlight, 2);
  pending.get(FULL.id)!(descriptor("STFC_CONNECTION", 1));
  pending.get(RESTRICTED.id)!(descriptor("STFC_CONNECTION", 1));
  await Promise.all([full, restricted]);
  assert.equal(runtime.monitor().inFlight, 0);
});

test("evicts by deterministic LRU order and retained-byte budget", async () => {
  const loadCounts = new Map<string, number>();
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 2,
    maxRetainedBytes: 20,
    adapter: adapter({
      async load({ structural }) {
        const count = (loadCounts.get(structural.id) ?? 0) + 1;
        loadCounts.set(structural.id, count);
        return descriptor(structural.objectName, count, 10);
      },
    }),
  });

  await runtime.get(lookup(A));
  await runtime.get(lookup(B));
  await runtime.get(lookup(A)); // A is most recently used.
  await runtime.get(lookup(C)); // B is evicted.
  assert.deepEqual(runtime.monitor().entries, 2);
  assert.equal(runtime.monitor().retainedBytes, 20);
  assert.equal(runtime.monitor().evictions, 1);

  await runtime.get(lookup(B));
  assert.equal(loadCounts.get(B.id), 2);
  assert.equal(loadCounts.get(A.id), 1);
});

test("enforces the retained-byte budget independently of entry count", async () => {
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 5,
    maxRetainedBytes: 15,
    adapter: adapter({
      async load({ structural }) {
        return descriptor(structural.objectName, 1, structural.id === A.id ? 5 : 10);
      },
    }),
  });
  await runtime.get(lookup(A));
  await runtime.get(lookup(B));
  assert.deepEqual(
    { entries: runtime.monitor().entries, bytes: runtime.monitor().retainedBytes },
    { entries: 2, bytes: 15 },
  );
  await runtime.get(lookup(C));
  assert.deepEqual(
    { entries: runtime.monitor().entries, bytes: runtime.monitor().retainedBytes },
    { entries: 1, bytes: 10 },
  );
  assert.equal(runtime.monitor().evictions, 2);
});

test("does not cache a snapshot larger than the byte budget", async () => {
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 9,
    adapter: adapter({
      async load() {
        loads += 1;
        return descriptor("STFC_CONNECTION", loads, 10);
      },
    }),
  });
  assert.equal((await runtime.get(lookup())).revision, 1);
  assert.equal((await runtime.get(lookup())).revision, 2);
  assert.equal(runtime.monitor().entries, 0);
  assert.equal(runtime.monitor().oversizeSkips, 2);
});

test("per-object and whole invalidation preserve returned immutable snapshots", async () => {
  let revision = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async load({ structural }) {
        revision += 1;
        return descriptor(structural.objectName, revision);
      },
    }),
  });

  const oldA = await runtime.get(lookup(A));
  await runtime.get(lookup(B));
  assert.equal(runtime.invalidate(A), true);
  const newA = await runtime.get(lookup(A));
  assert.notEqual(oldA, newA);
  assert.equal(oldA.revision, 1);
  assert.equal(Object.isFrozen(oldA), true);
  assert.equal(Object.isFrozen(oldA.fields), true);

  assert.equal(runtime.invalidateAll(), 2);
  assert.equal(runtime.monitor().entries, 0);
  assert.equal(oldA.revision, 1);
});

test("an invalidation during a load prevents stale cache resurrection", async () => {
  let resolveLoad!: (snapshot: MetadataSnapshot<Descriptor>) => void;
  const pending = new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
    resolveLoad = resolve;
  });
  let announceLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    announceLoadStarted = resolve;
  });
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async load() {
        loads += 1;
        if (loads === 1) {
          announceLoadStarted();
          return pending;
        }
        return descriptor("STFC_CONNECTION", 2);
      },
    }),
  });

  const stale = runtime.get(lookup());
  await loadStarted;
  runtime.invalidate(A);
  resolveLoad(descriptor("STFC_CONNECTION", 1));
  assert.equal((await stale).revision, 1);
  assert.equal(runtime.monitor().entries, 0);
  assert.equal((await runtime.get(lookup())).revision, 2);
});

test("caches optimized probes per backend and principal without cross-principal poisoning", async () => {
  const probes = new Map<string, number>();
  const authorizations: string[] = [];
  const loads: MetadataLoadStrategy[] = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async probeOptimized({ capability }) {
        probes.set(capability.id, (probes.get(capability.id) ?? 0) + 1);
        if (capability.id === RESTRICTED.id) {
          throw new MetadataAccessFailure("authorization", "optimized probe denied");
        }
      },
      async authorize({ capability, strategy }) {
        authorizations.push(`${capability.id}:${strategy}`);
      },
      async load({ structural, strategy }) {
        loads.push(strategy);
        return descriptor(structural.objectName, loads.length);
      },
    }),
  });

  const fullFirst = await runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto));
  const restrictedSecond = await runtime.get(
    lookup(A, RESTRICTED, MetadataRepositoryMode.Auto),
  );
  assert.equal(fullFirst, restrictedSecond);
  assert.equal(probes.get(FULL.id), 1);
  assert.equal(probes.get(RESTRICTED.id), 1);
  assert.equal(
    authorizations.some((value) => value === `${RESTRICTED.id}:classic`),
    true,
  );
  assert.deepEqual(loads, [MetadataLoadStrategy.Optimized]);

  await runtime.get(lookup(B, RESTRICTED, MetadataRepositoryMode.Auto));
  await runtime.get(lookup(B, FULL, MetadataRepositoryMode.Auto));
  assert.equal(probes.get(FULL.id), 1);
  assert.equal(probes.get(RESTRICTED.id), 1);
});

test("does not share positive object authorization across principals", async () => {
  const authorizationCalls: string[] = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async authorize({ capability }) {
        authorizationCalls.push(capability.id);
        if (capability.id === RESTRICTED.id) {
          throw new MetadataAccessFailure("authorization", "object denied");
        }
      },
    }),
  });

  await runtime.get(lookup(A, FULL));
  await assert.rejects(
    () => runtime.get(lookup(A, RESTRICTED)),
    (error: unknown) =>
      error instanceof MetadataAccessFailure &&
      error.classification === "authorization",
  );
  assert.deepEqual(authorizationCalls, [FULL.id, RESTRICTED.id]);
});

test("auto falls back only for unavailable or authorization failures", async () => {
  for (const classification of ["unavailable", "authorization"] as const) {
    const strategies: MetadataLoadStrategy[] = [];
    const runtime = new MetadataRepositoryRuntime({
      maxEntries: 1,
      maxRetainedBytes: 100,
      adapter: adapter({
        async probeOptimized() {
          throw new MetadataAccessFailure(classification, classification);
        },
        async load({ strategy }) {
          strategies.push(strategy);
          return descriptor("STFC_CONNECTION", 1);
        },
      }),
    });
    await runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto));
    assert.deepEqual(strategies, [MetadataLoadStrategy.Classic]);
  }

  for (const classification of [
    "communication",
    "timeout",
    "canceled",
    "malformed",
  ] as const) {
    let loads = 0;
    const runtime = new MetadataRepositoryRuntime({
      maxEntries: 1,
      maxRetainedBytes: 100,
      adapter: adapter({
        async probeOptimized() {
          throw new MetadataAccessFailure(classification, classification);
        },
        async load() {
          loads += 1;
          return descriptor("unexpected", 1);
        },
      }),
    });
    await assert.rejects(
      () => runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto)),
      (error: unknown) =>
        error instanceof MetadataAccessFailure &&
        error.classification === classification,
    );
    assert.equal(loads, 0, classification);
  }
});

test("auto also classifies optimized authorization/load failures but optimized-only never falls back", async () => {
  for (const failingStep of ["authorize", "load"] as const) {
    const strategies: MetadataLoadStrategy[] = [];
    const runtime = new MetadataRepositoryRuntime({
      maxEntries: 2,
      maxRetainedBytes: 100,
      adapter: adapter({
        async authorize({ strategy }) {
          if (failingStep === "authorize" && strategy === MetadataLoadStrategy.Optimized) {
            throw new MetadataAccessFailure("authorization", "optimized denied");
          }
        },
        async load({ strategy }) {
          strategies.push(strategy);
          if (failingStep === "load" && strategy === MetadataLoadStrategy.Optimized) {
            throw new MetadataAccessFailure("unavailable", "optimized absent");
          }
          return descriptor("STFC_CONNECTION", 1);
        },
      }),
    });
    await runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto));
    assert.equal(strategies.at(-1), MetadataLoadStrategy.Classic);
  }

  let classicLoads = 0;
  const optimizedOnly = new MetadataRepositoryRuntime({
    maxEntries: 2,
    maxRetainedBytes: 100,
    adapter: adapter({
      async probeOptimized() {
        throw new MetadataAccessFailure("unavailable", "optimized absent");
      },
      async load({ strategy }) {
        if (strategy === MetadataLoadStrategy.Classic) classicLoads += 1;
        return descriptor("unexpected", 1);
      },
    }),
  });
  await assert.rejects(
    () => optimizedOnly.get(lookup(A, FULL, MetadataRepositoryMode.OptimizedOnly)),
    (error: unknown) =>
      error instanceof MetadataAccessFailure &&
      error.classification === "unavailable",
  );
  assert.equal(classicLoads, 0);
});

test("terminal optimized-load failures never fall back to classic", async () => {
  for (const classification of [
    "communication",
    "timeout",
    "canceled",
    "malformed",
  ] as const) {
    const strategies: MetadataLoadStrategy[] = [];
    const runtime = new MetadataRepositoryRuntime({
      maxEntries: 1,
      maxRetainedBytes: 100,
      adapter: adapter({
        async load({ strategy }) {
          strategies.push(strategy);
          throw new MetadataAccessFailure(classification, classification);
        },
      }),
    });
    await assert.rejects(
      () => runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto)),
      (error: unknown) =>
        error instanceof MetadataAccessFailure &&
        error.classification === classification,
    );
    assert.deepEqual(strategies, [MetadataLoadStrategy.Optimized]);
  }
});

test("classic and legacy modes select only their explicit loader strategies", async () => {
  const probes: string[] = [];
  const strategies: MetadataLoadStrategy[] = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 1024,
    adapter: adapter({
      async probeOptimized() {
        probes.push("probe");
      },
      async load({ strategy, structural }) {
        strategies.push(strategy);
        return descriptor(structural.objectName, strategies.length);
      },
    }),
  });
  await runtime.get(lookup(A, FULL, MetadataRepositoryMode.Classic));
  await runtime.get(lookup(B, FULL, MetadataRepositoryMode.LegacyV3));
  assert.deepEqual(probes, []);
  assert.deepEqual(strategies, [
    MetadataLoadStrategy.Classic,
    MetadataLoadStrategy.LegacyV3,
  ]);
});

test("rejects mutable loader values and retries after the loader returns an immutable snapshot", async () => {
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 2,
    maxRetainedBytes: 100,
    adapter: adapter({
      async load() {
        loads += 1;
        if (loads === 1) {
          return { value: { name: "mutable", revision: 1, fields: [] }, retainedBytes: 1 };
        }
        return descriptor("immutable", 2, 1);
      },
    }),
  });
  await assert.rejects(() => runtime.get(lookup()), /recursively frozen/);
  assert.equal((await runtime.get(lookup())).revision, 2);
});

test("accepts only the exact immutable metadata map implementation in snapshots", async () => {
  interface MapDescriptor {
    readonly values: ReadonlyMap<string, Readonly<{ readonly value: number }>>;
  }
  class ForgedMetadataMap<K, V> extends ImmutableMetadataMap<K, V> {}
  let forged = true;
  const runtime = new MetadataRepositoryRuntime<MapDescriptor>({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        const entry = Object.freeze({ value: 1 });
        const values = forged
          ? new ForgedMetadataMap([["VALUE", entry] as const])
          : new ImmutableMetadataMap([["VALUE", entry] as const]);
        return Object.freeze({
          value: Object.freeze({ values }),
          retainedBytes: 10,
        });
      },
    },
  });

  await assert.rejects(
    runtime.get(lookup()),
    /recursively frozen/u,
  );
  forged = false;
  const accepted = await runtime.get(lookup());
  assert.equal(accepted.values.get("VALUE")?.value, 1);
  assert.equal(typeof (accepted.values as { readonly set?: unknown }).set,
    "undefined");
});

test("rejects frozen snapshots with mutable symbol-linked state", async () => {
  const hiddenState = Symbol("hidden metadata state");
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime<Descriptor>({
    maxEntries: 2,
    maxRetainedBytes: 100,
    adapter: adapter({
      async load() {
        loads += 1;
        if (loads === 1) {
          const value = {
            name: "symbol-linked",
            revision: 1,
            fields: Object.freeze(["FIELD"]),
            [hiddenState]: { mutable: true },
          };
          return Object.freeze({
            value: Object.freeze(value),
            retainedBytes: 1,
          });
        }
        return descriptor("immutable", 2, 1);
      },
    }),
  });

  await assert.rejects(() => runtime.get(lookup()), /recursively frozen/);
  assert.equal(runtime.monitor().entries, 0);
  assert.equal((await runtime.get(lookup())).revision, 2);
});

test("rejects Proxy values which only appear recursively frozen", async () => {
  let revision = 0;
  const frozenTarget = Object.freeze({});
  const proxy = new Proxy(frozenTarget, {
    get(target, property, receiver) {
      if (property === "revision") return ++revision;
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as Descriptor;
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime<Descriptor>({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: adapter({
      async load() {
        loads += 1;
        if (loads === 1) {
          return Object.freeze({ value: proxy, retainedBytes: 1 });
        }
        return descriptor("trusted", 2, 1);
      },
    }),
  });

  await assert.rejects(() => runtime.get(lookup()), /Proxy/u);
  assert.equal(runtime.monitor().entries, 0);
  assert.equal((await runtime.get(lookup())).revision, 2);
});

test("rejects Proxy snapshot containers before reading their fields", async () => {
  let propertyReads = 0;
  const snapshot = new Proxy(Object.freeze({}), {
    get(_target, property) {
      // Promise resolution is required to inspect a returned value's `then`.
      if (property === "then") return undefined;
      propertyReads += 1;
      throw new Error("Proxy snapshot field must not be read");
    },
  }) as unknown as MetadataSnapshot<Descriptor>;
  const runtime = new MetadataRepositoryRuntime<Descriptor>({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: adapter({
      async load() {
        return snapshot;
      },
    }),
  });

  await assert.rejects(
    () => runtime.get(lookup()),
    /metadata adapter snapshot must not be a Proxy object/u,
  );
  assert.equal(propertyReads, 0);
});

test("bounds inspected snapshot properties including primitive-only values", async () => {
  interface PrimitiveGraph {
    readonly first: number;
    readonly second: number;
    readonly third?: number;
  }
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime<PrimitiveGraph>({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxSnapshotNodes: 1,
    maxSnapshotDepth: 1,
    maxSnapshotProperties: 2,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        loads += 1;
        const value = loads === 1
          ? Object.freeze({ first: 1, second: 2, third: 3 })
          : Object.freeze({ first: 1, second: 2 });
        return Object.freeze({ value, retainedBytes: 1 });
      },
    },
  });

  await assert.rejects(
    () => runtime.get(lookup()),
    /metadata snapshot graph exceeds property limit 2/u,
  );
  const monitor = runtime.monitor();
  assert.equal(monitor.maxSnapshotProperties, 2);
  assert.deepEqual(await runtime.get(lookup()), { first: 1, second: 2 });
});

test("counts sparse array logical slots against the snapshot property bound", async () => {
  interface SparseGraph {
    readonly fields: readonly unknown[];
  }
  const fields = Object.freeze(new Array<unknown>(4_294_967_295));
  const value: SparseGraph = Object.freeze({ fields });
  const runtime = new MetadataRepositoryRuntime<SparseGraph>({
    maxEntries: 1,
    maxRetainedBytes: 1,
    maxSnapshotNodes: 2,
    maxSnapshotDepth: 2,
    maxSnapshotProperties: 2,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        return Object.freeze({ value, retainedBytes: 1 });
      },
    },
  });

  await assert.rejects(
    () => runtime.get(lookup()),
    /metadata snapshot graph exceeds property limit 2/u,
  );
  assert.deepEqual(
    {
      entries: runtime.monitor().entries,
      failed: runtime.monitor().loadsFailed,
      inFlight: runtime.monitor().inFlight,
    },
    { entries: 0, failed: 1, inFlight: 0 },
  );
});

test("bounds immutable snapshot traversal by depth without recursive stack growth", async () => {
  interface GraphNode {
    readonly next?: GraphNode;
  }
  let graph: GraphNode = Object.freeze({});
  for (let index = 1; index < 20_000; index += 1) {
    graph = Object.freeze({ next: graph });
  }
  const runtime = new MetadataRepositoryRuntime<GraphNode>({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxSnapshotNodes: 100,
    maxSnapshotDepth: 16,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        return Object.freeze({ value: graph, retainedBytes: 1 });
      },
    },
  });

  await assert.rejects(
    () => runtime.get(lookup()),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "metadata snapshot graph exceeds depth limit 16",
  );
  assert.deepEqual(
    {
      depth: runtime.monitor().maxSnapshotDepth,
      nodes: runtime.monitor().maxSnapshotNodes,
      failed: runtime.monitor().loadsFailed,
      inFlight: runtime.monitor().inFlight,
    },
    { depth: 16, nodes: 100, failed: 1, inFlight: 0 },
  );
});

test("bounds distinct immutable snapshot nodes and accepts a bounded cycle", async () => {
  interface GraphNode {
    readonly children?: readonly GraphNode[];
    readonly self?: GraphNode;
  }
  const leaves = Object.freeze([
    Object.freeze({}),
    Object.freeze({}),
  ]);
  const wideGraph: GraphNode = Object.freeze({ children: leaves });
  const bounded = new MetadataRepositoryRuntime<GraphNode>({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxSnapshotNodes: 3,
    maxSnapshotDepth: 8,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        return Object.freeze({ value: wideGraph, retainedBytes: 1 });
      },
    },
  });
  await assert.rejects(
    () => bounded.get(lookup()),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "metadata snapshot graph exceeds node limit 3",
  );

  const mutableCycle: { self?: GraphNode } = {};
  mutableCycle.self = mutableCycle;
  const cycle = Object.freeze(mutableCycle);
  const cyclic = new MetadataRepositoryRuntime<GraphNode>({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxSnapshotNodes: 1,
    maxSnapshotDepth: 1,
    adapter: {
      async probeOptimized() {},
      async authorize() {},
      async load() {
        return Object.freeze({ value: cycle, retainedBytes: 1 });
      },
    },
  });
  assert.equal(await cyclic.get(lookup()), cycle);
});

test("retirement clears state, blocks new work, and monitor snapshots never mutate", async () => {
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 2,
    maxRetainedBytes: 100,
    adapter: adapter(),
  });
  await runtime.get(lookup());
  const before = runtime.monitor();
  runtime.retire();
  const after = runtime.monitor();

  assert.equal(Object.isFrozen(before), true);
  assert.equal(before.state, "active");
  assert.equal(before.entries, 1);
  assert.equal(after.state, "retired");
  assert.equal(after.entries, 0);
  await assert.rejects(() => runtime.get(lookup()), /metadata repository is retired/);
  assert.equal(before.entries, 1);
});

test("reauthorizes and rejoins current work after invalidation changes an admission epoch", async () => {
  const authorizationResolvers: Array<() => void> = [];
  const loadResolvers: Array<(snapshot: MetadataSnapshot<Descriptor>) => void> = [];
  let authorizationCalls = 0;
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 100,
    maxAuthorizationEntries: 4,
    maxInFlightLoads: 4,
    adapter: adapter({
      authorize() {
        authorizationCalls += 1;
        return new Promise<void>((resolve) => {
          authorizationResolvers.push(resolve);
        });
      },
      load() {
        loads += 1;
        return new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
          loadResolvers.push(resolve);
        });
      },
    }),
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const oldRead = runtime.get(lookup());
  await tick();
  assert.equal(authorizationCalls, 1);
  runtime.invalidate(A);
  const freshRead = runtime.get(lookup());
  await tick();
  assert.equal(authorizationCalls, 2);

  authorizationResolvers[0]!();
  await tick();
  assert.equal(loads, 0);
  authorizationResolvers[1]!();
  await tick();
  assert.equal(loads, 1);
  assert.equal(runtime.monitor().inFlightJoins, 1);

  loadResolvers[0]!(descriptor(A.objectName, 2));
  assert.equal((await oldRead).revision, 2);
  assert.equal((await freshRead).revision, 2);
  assert.equal(runtime.monitor().entries, 1);
  assert.equal((await runtime.get(lookup())).revision, 2);
  assert.equal(runtime.monitor().authorizationHits, 2);
});

test("caches a lone lookup after it reauthorizes into the current epoch", async () => {
  const authorizationResolvers: Array<() => void> = [];
  let authorizationCalls = 0;
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    adapter: adapter({
      authorize() {
        authorizationCalls += 1;
        return new Promise<void>((resolve) => {
          authorizationResolvers.push(resolve);
        });
      },
      async load({ structural }) {
        loads += 1;
        return descriptor(structural.objectName, loads);
      },
    }),
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const read = runtime.get(lookup());
  await tick();
  assert.equal(authorizationCalls, 1);
  runtime.invalidate(A);
  authorizationResolvers[0]!();
  await tick();
  assert.equal(authorizationCalls, 2);
  authorizationResolvers[1]!();

  assert.equal((await read).revision, 1);
  assert.equal(runtime.monitor().entries, 1);
  assert.equal((await runtime.get(lookup())).revision, 1);
  assert.equal(loads, 1);
});

test("keeps retained-byte accounting safe at Number.MAX_SAFE_INTEGER", async () => {
  const sizes = new Map<string, number>([
    [A.id, Number.MAX_SAFE_INTEGER],
    [B.id, Number.MAX_SAFE_INTEGER - 1],
    [C.id, 2],
  ]);
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 3,
    maxRetainedBytes: Number.MAX_SAFE_INTEGER,
    adapter: adapter({
      async load({ structural }) {
        return descriptor(
          structural.objectName,
          1,
          sizes.get(structural.id)!,
        );
      },
    }),
  });

  await runtime.get(lookup(A));
  await runtime.get(lookup(B));
  await runtime.get(lookup(C));
  assert.deepEqual(
    {
      entries: runtime.monitor().entries,
      retainedBytes: runtime.monitor().retainedBytes,
      evictions: runtime.monitor().evictions,
    },
    { entries: 1, retainedBytes: 2, evictions: 2 },
  );
});

test("bounds probe and authorization decisions with deterministic settled-entry LRU", async () => {
  const capabilities = ["one", "two", "three"].map((principal) =>
    createMetadataCapabilityKey({
      backendKey: A.backendKey,
      principalKey: `principal:${principal}`,
    }));
  const probes: string[] = [];
  const authorizations: string[] = [];
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxProbeEntries: 2,
    maxAuthorizationEntries: 2,
    maxObjectEpochEntries: 2,
    maxInFlightLoads: 2,
    adapter: adapter({
      async probeOptimized({ capability }) {
        probes.push(capability.id);
      },
      async authorize({ capability }) {
        authorizations.push(capability.id);
      },
    }),
  });

  for (const capability of [
    capabilities[0]!,
    capabilities[1]!,
    capabilities[0]!,
    capabilities[2]!,
    capabilities[1]!,
  ]) {
    await runtime.get(lookup(A, capability, MetadataRepositoryMode.Auto));
  }
  assert.deepEqual(probes, [
    capabilities[0]!.id,
    capabilities[1]!.id,
    capabilities[2]!.id,
    capabilities[1]!.id,
  ]);
  assert.deepEqual(authorizations, probes);
  assert.deepEqual(
    {
      probeEntries: runtime.monitor().probeEntries,
      probeEvictions: runtime.monitor().probeEvictions,
      authorizationEntries: runtime.monitor().authorizationEntries,
      authorizationEvictions: runtime.monitor().authorizationEvictions,
      maxProbeEntries: runtime.monitor().maxProbeEntries,
      maxAuthorizationEntries: runtime.monitor().maxAuthorizationEntries,
    },
    {
      probeEntries: 2,
      probeEvictions: 2,
      authorizationEntries: 2,
      authorizationEvictions: 2,
      maxProbeEntries: 2,
      maxAuthorizationEntries: 2,
    },
  );
});

test("bounds object invalidation epochs by deterministic global compaction", () => {
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxObjectEpochEntries: 2,
    adapter: adapter(),
  });
  runtime.invalidate(A);
  runtime.invalidate(B);
  assert.equal(runtime.monitor().objectEpochEntries, 2);
  runtime.invalidate(C);
  assert.deepEqual(
    {
      entries: runtime.monitor().objectEpochEntries,
      compactions: runtime.monitor().objectEpochCompactions,
      maximum: runtime.monitor().maxObjectEpochEntries,
    },
    { entries: 0, compactions: 1, maximum: 2 },
  );
  runtime.invalidate(A);
  assert.equal(runtime.monitor().objectEpochEntries, 1);
});

test("rejects new active work when probe, authorization, or load capacity is occupied", async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  let releaseProbe!: () => void;
  const probeRuntime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxProbeEntries: 1,
    adapter: adapter({
      probeOptimized() {
        return new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
      },
    }),
  });
  const probing = probeRuntime.get(
    lookup(A, FULL, MetadataRepositoryMode.Auto),
  );
  await tick();
  await assert.rejects(
    () => probeRuntime.get(
      lookup(B, RESTRICTED, MetadataRepositoryMode.Auto),
    ),
    /probe capacity 1 is exhausted/,
  );
  releaseProbe();
  await probing;
  assert.equal(probeRuntime.monitor().probeCapacityRejections, 1);

  let releaseAuthorization!: () => void;
  const authorizationRuntime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxAuthorizationEntries: 1,
    adapter: adapter({
      authorize() {
        return new Promise<void>((resolve) => {
          releaseAuthorization = resolve;
        });
      },
    }),
  });
  const authorizing = authorizationRuntime.get(lookup(A));
  await tick();
  await assert.rejects(
    () => authorizationRuntime.get(lookup(B)),
    /authorization capacity 1 is exhausted/,
  );
  releaseAuthorization();
  await authorizing;
  assert.equal(
    authorizationRuntime.monitor().authorizationCapacityRejections,
    1,
  );

  let releaseLoad!: (snapshot: MetadataSnapshot<Descriptor>) => void;
  let loads = 0;
  const loadRuntime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 10,
    maxInFlightLoads: 1,
    adapter: adapter({
      load({ structural }) {
        loads += 1;
        if (loads > 1) return Promise.resolve(descriptor(structural.objectName, loads));
        return new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
          releaseLoad = resolve;
        });
      },
    }),
  });
  const loading = loadRuntime.get(lookup(A));
  await tick();
  loadRuntime.invalidate(A);
  await assert.rejects(
    () => loadRuntime.get(lookup(A)),
    /load capacity 1 is exhausted/,
  );
  assert.equal(loadRuntime.monitor().inFlight, 1);
  assert.equal(loadRuntime.monitor().trackedInFlight, 0);
  releaseLoad(descriptor(A.objectName, 1));
  await loading;
  assert.equal((await loadRuntime.get(lookup(A))).revision, 2);
  assert.equal(loadRuntime.monitor().inFlightCapacityRejections, 1);
});

test("derives finite auxiliary limits and rejects invalid explicit capacities", () => {
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 0,
    maxRetainedBytes: 0,
    adapter: adapter(),
  });
  for (const limit of [
    runtime.monitor().maxProbeEntries,
    runtime.monitor().maxAuthorizationEntries,
    runtime.monitor().maxObjectEpochEntries,
    runtime.monitor().maxInFlightLoads,
    runtime.monitor().maxSnapshotNodes,
    runtime.monitor().maxSnapshotDepth,
    runtime.monitor().maxSnapshotProperties,
  ]) {
    assert.equal(Number.isSafeInteger(limit), true);
    assert.equal(limit > 0, true);
  }

  for (const field of [
    "maxProbeEntries",
    "maxAuthorizationEntries",
    "maxObjectEpochEntries",
    "maxInFlightLoads",
    "maxSnapshotNodes",
    "maxSnapshotDepth",
    "maxSnapshotProperties",
  ] as const) {
    assert.throws(
      () => new MetadataRepositoryRuntime({
        maxEntries: 1,
        maxRetainedBytes: 1,
        adapter: adapter(),
        [field]: Number.POSITIVE_INFINITY,
      }),
      new RegExp(field),
    );
  }
  for (const field of [
    "maxSnapshotNodes",
    "maxSnapshotDepth",
    "maxSnapshotProperties",
  ] as const) {
    assert.throws(
      () => new MetadataRepositoryRuntime({
        maxEntries: 1,
        maxRetainedBytes: 1,
        adapter: adapter(),
        [field]: 0,
      }),
      new RegExp(field),
    );
  }
});

test("does not trust caller-owned Function.bind on adapter operations", async () => {
  const calls: string[] = [];
  const metadataAdapter = {
    label: "adapter",
    async probeOptimized(this: { label: string }) {
      calls.push(`${this.label}:probe`);
    },
    async authorize(this: { label: string }) {
      calls.push(`${this.label}:authorize`);
    },
    async load(this: { label: string }) {
      calls.push(`${this.label}:load`);
      return descriptor("poison-resistant", 1);
    },
  };
  for (const operation of [
    metadataAdapter.probeOptimized,
    metadataAdapter.authorize,
    metadataAdapter.load,
  ]) {
    Object.defineProperty(operation, "bind", {
      configurable: true,
      value() {
        throw new Error("caller-owned bind must not run");
      },
    });
  }

  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: metadataAdapter,
  });
  assert.equal(
    (await runtime.get(lookup(A, FULL, MetadataRepositoryMode.Auto))).name,
    "poison-resistant",
  );
  assert.deepEqual(calls, [
    "adapter:probe",
    "adapter:authorize",
    "adapter:load",
  ]);
});

test("retirement drains an admitted metadata load after invalidating its result", async () => {
  let finishLoad!: (snapshot: MetadataSnapshot<Descriptor>) => void;
  const loading = new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
    finishLoad = resolve;
  });
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: adapter({
      load() {
        return loading;
      },
    }),
  });

  const read = runtime.get(lookup());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.monitor().inFlight, 1);
  const retirement = runtime.retire() as unknown as Promise<void>;
  assert.equal(runtime.monitor().state, "retired");
  assert.equal(runtime.monitor().entries, 0);
  let drained = false;
  void retirement.then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);

  finishLoad(descriptor(A.objectName, 1));
  assert.equal((await read).revision, 1);
  await retirement;
  assert.equal(drained, true);
  assert.equal(runtime.monitor().inFlight, 0);
  assert.equal(runtime.monitor().entries, 0);
});

test("caller cancellation releases only that waiter and preserves a shared physical load", async () => {
  let finishLoad!: (snapshot: MetadataSnapshot<Descriptor>) => void;
  let physicalSignal: AbortSignal | undefined;
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 2,
    maxRetainedBytes: 100,
    adapter: adapter({
      load({ signal }) {
        loads += 1;
        physicalSignal = signal;
        return new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
          finishLoad = resolve;
        });
      },
    }),
  });
  const caller = new AbortController();
  const canceled = runtime.get(lookup(), caller.signal);
  const survivor = runtime.get(lookup());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.notEqual(physicalSignal, caller.signal);

  caller.abort();
  await assert.rejects(
    () => canceled,
    (error: unknown) =>
      error instanceof MetadataAccessFailure &&
      error.classification === "canceled",
  );
  assert.equal(physicalSignal?.aborted, false);
  assert.equal(runtime.monitor().inFlight, 1);

  finishLoad(descriptor(A.objectName, 1));
  assert.equal((await survivor).revision, 1);
  assert.equal(runtime.monitor().loadsStarted, 1);
  assert.equal(runtime.monitor().inFlightJoins, 1);
  await runtime.retire();
});

test("a hostile abort-listener cleanup cannot strand caller settlement", async () => {
  let listener: (() => void) | undefined;
  const signal = {
    aborted: false,
    addEventListener(_type: string, candidate: () => void) {
      listener = candidate;
    },
    removeEventListener() {
      throw new Error("hostile removeEventListener");
    },
  } as unknown as AbortSignal;
  let finishLoad!: (snapshot: MetadataSnapshot<Descriptor>) => void;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: adapter({
      load() {
        return new Promise<MetadataSnapshot<Descriptor>>((resolve) => {
          finishLoad = resolve;
        });
      },
    }),
  });

  const read = runtime.get(lookup(), signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof listener, "function");
  finishLoad(descriptor(A.objectName, 1));
  assert.equal((await read).revision, 1);
});

test("generation retirement aborts cooperative probe, authorization, and load operations", async (t) => {
  for (const stage of ["probe", "authorize", "load"] as const) {
    await t.test(stage, async () => {
      let started!: () => void;
      const stageStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let observedSignal: AbortSignal | undefined;
      const waitForRetirement = (signal: AbortSignal): Promise<never> => {
        observedSignal = signal;
        started();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      };
      const runtime = new MetadataRepositoryRuntime({
        maxEntries: 1,
        maxRetainedBytes: 100,
        adapter: adapter({
          ...(stage === "probe"
            ? { probeOptimized: ({ signal }) => waitForRetirement(signal) }
            : {}),
          ...(stage === "authorize"
            ? { authorize: ({ signal }) => waitForRetirement(signal) }
            : {}),
          ...(stage === "load"
            ? { load: ({ signal }) => waitForRetirement(signal) }
            : {}),
        }),
      });
      const read = runtime.get(lookup(
        A,
        FULL,
        stage === "probe"
          ? MetadataRepositoryMode.Auto
          : MetadataRepositoryMode.Classic,
      ));
      await stageStarted;
      const retirement = runtime.retire();
      assert.equal(observedSignal?.aborted, true);
      await assert.rejects(
        () => read,
        (error: unknown) =>
          error instanceof MetadataAccessFailure &&
          error.classification === "canceled",
      );
      await retirement;
      assert.equal(runtime.monitor().state, "retired");
      assert.equal(runtime.monitor().inFlight, 0);
    });
  }
});

test("auto remembers optimized authorize and load fallback per principal", async (t) => {
  for (const failingStage of ["authorize", "load"] as const) {
    await t.test(failingStage, async () => {
      const probes: string[] = [];
      const optimizedAttempts: string[] = [];
      const runtime = new MetadataRepositoryRuntime({
        maxEntries: 8,
        maxRetainedBytes: 1_024,
        adapter: adapter({
          async probeOptimized({ capability }) {
            probes.push(capability.id);
          },
          async authorize({ structural, capability, strategy }) {
            if (strategy === MetadataLoadStrategy.Optimized) {
              optimizedAttempts.push(
                `authorize:${capability.id}:${structural.objectName}`,
              );
              if (
                failingStage === "authorize" &&
                capability.id === RESTRICTED.id
              ) {
                throw new MetadataAccessFailure(
                  "authorization",
                  "optimized authorization denied",
                );
              }
            }
          },
          async load({ structural, capability, strategy }) {
            if (strategy === MetadataLoadStrategy.Optimized) {
              optimizedAttempts.push(
                `load:${capability.id}:${structural.objectName}`,
              );
              if (
                failingStage === "load" &&
                capability.id === RESTRICTED.id
              ) {
                throw new MetadataAccessFailure(
                  "unavailable",
                  "optimized loader unavailable",
                );
              }
            }
            return descriptor(structural.objectName, 1);
          },
        }),
      });

      await runtime.get(lookup(A, RESTRICTED, MetadataRepositoryMode.Auto));
      await runtime.get(lookup(B, RESTRICTED, MetadataRepositoryMode.Auto));
      await runtime.get(lookup(C, FULL, MetadataRepositoryMode.Auto));

      assert.deepEqual(probes, [RESTRICTED.id, FULL.id]);
      assert.equal(
        optimizedAttempts.some((attempt) =>
          attempt.includes(`${RESTRICTED.id}:${B.objectName}`)),
        false,
      );
      assert.equal(
        optimizedAttempts.some((attempt) => attempt.includes(FULL.id)),
        true,
      );
      assert.equal(runtime.monitor().optimizedFallbacks, 2);
      await runtime.retire();
    });
  }
});

test("a late optimized fallback never exceeds the bounded principal decision cache", async () => {
  let announceRestrictedLoad!: () => void;
  const restrictedLoadStarted = new Promise<void>((resolve) => {
    announceRestrictedLoad = resolve;
  });
  let failRestrictedLoad!: (error: unknown) => void;
  const restrictedLoad = new Promise<MetadataSnapshot<Descriptor>>(
    (_resolve, reject) => {
      failRestrictedLoad = reject;
    },
  );
  let releaseFullProbe!: () => void;
  const fullProbe = new Promise<void>((resolve) => {
    releaseFullProbe = resolve;
  });
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 100,
    maxProbeEntries: 1,
    adapter: adapter({
      async probeOptimized({ capability }) {
        if (capability.id === FULL.id) await fullProbe;
      },
      load({ structural, capability, strategy }) {
        if (
          capability.id === RESTRICTED.id &&
          strategy === MetadataLoadStrategy.Optimized
        ) {
          announceRestrictedLoad();
          return restrictedLoad;
        }
        return Promise.resolve(descriptor(structural.objectName, 1));
      },
    }),
  });

  const restricted = runtime.get(
    lookup(A, RESTRICTED, MetadataRepositoryMode.Auto),
  );
  await restrictedLoadStarted;
  const full = runtime.get(lookup(B, FULL, MetadataRepositoryMode.Auto));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.monitor().probeEntries, 1);

  failRestrictedLoad(new MetadataAccessFailure(
    "unavailable",
    "optimized loader unavailable",
  ));
  assert.equal((await restricted).revision, 1);
  assert.equal(runtime.monitor().probeEntries, 1);
  assert.equal(runtime.monitor().probeEvictions, 1);

  releaseFullProbe();
  assert.equal((await full).revision, 1);
  assert.equal(runtime.monitor().probeEntries, 1);
  await runtime.retire();
});

test("a pre-invalidation lookup reauthorizes before reading a post-invalidation cache hit", async () => {
  const fullAuthorizationResolvers: Array<() => void> = [];
  const authorizations: string[] = [];
  let loads = 0;
  const runtime = new MetadataRepositoryRuntime({
    maxEntries: 4,
    maxRetainedBytes: 100,
    adapter: adapter({
      authorize({ capability }) {
        authorizations.push(capability.id);
        if (capability.id !== FULL.id) return Promise.resolve();
        return new Promise<void>((resolve) => {
          fullAuthorizationResolvers.push(resolve);
        });
      },
      async load({ structural }) {
        loads += 1;
        return descriptor(structural.objectName, 2);
      },
    }),
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const oldRead = runtime.get(lookup(A, FULL));
  await tick();
  assert.deepEqual(authorizations, [FULL.id]);
  runtime.invalidate(A);
  assert.equal((await runtime.get(lookup(A, RESTRICTED))).revision, 2);
  assert.equal(loads, 1);

  let oldSettled = false;
  void oldRead.then(
    () => { oldSettled = true; },
    () => { oldSettled = true; },
  );
  fullAuthorizationResolvers[0]!();
  await tick();
  assert.deepEqual(authorizations, [FULL.id, RESTRICTED.id, FULL.id]);
  assert.equal(oldSettled, false);

  fullAuthorizationResolvers[1]!();
  assert.equal((await oldRead).revision, 2);
  assert.equal(loads, 1);
  await runtime.retire();
});

test("abort cleanup may await owning repository retirement without deadlock", async () => {
  let announceLoad!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    announceLoad = resolve;
  });
  let announceNestedRetirement!: () => void;
  const nestedRetirementStarted = new Promise<void>((resolve) => {
    announceNestedRetirement = resolve;
  });
  let nestedRetirement: Promise<void> | undefined;
  let runtime!: MetadataRepositoryRuntime<Descriptor>;
  runtime = new MetadataRepositoryRuntime({
    maxEntries: 1,
    maxRetainedBytes: 100,
    adapter: adapter({
      load({ signal }) {
        announceLoad();
        return new Promise<MetadataSnapshot<Descriptor>>((_resolve, reject) => {
          signal.addEventListener("abort", async () => {
            // Prove the retirement ownership context survives an asynchronous
            // abort-cleanup continuation, rather than only the abort dispatch.
            await Promise.resolve();
            nestedRetirement = runtime.retire();
            announceNestedRetirement();
            try {
              await nestedRetirement;
              reject(signal.reason);
            } catch (error) {
              reject(error);
            }
          }, { once: true });
        });
      },
    }),
  });

  const read = runtime.get(lookup());
  await loadStarted;
  const retirement = runtime.retire();
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      nestedRetirementStarted,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("abort cleanup did not reenter retirement")),
          500,
        );
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
  assert.notEqual(nestedRetirement, undefined);
  assert.notEqual(nestedRetirement, retirement);
  deadline = undefined;
  try {
    await Promise.race([
      Promise.all([
        assert.rejects(
          read,
          (error: unknown) =>
            error instanceof MetadataAccessFailure &&
            error.classification === "canceled",
        ),
        retirement,
      ]),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("repository retirement deadlocked")),
          500,
        );
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
  assert.equal(runtime.monitor().state, "retired");
  assert.equal(runtime.monitor().inFlight, 0);
});
