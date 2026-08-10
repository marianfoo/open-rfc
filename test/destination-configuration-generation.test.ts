import assert from "node:assert/strict";
import test from "node:test";

import {
  DestinationConfigurationGeneration,
  type DestinationConfigurationGenerationOptions,
  type DestinationIdentityInput,
  type DestinationLaneFactory,
} from "../src/destination/configuration-generation.js";
import { MetadataRepositoryMode } from "../src/metadata/repository-runtime.js";

interface TestConnection {
  readonly lane: "application" | "repository";
  readonly ordinal: number;
}

function factory(
  lane: TestConnection["lane"],
  events: string[],
): DestinationLaneFactory<TestConnection> {
  let ordinal = 0;
  return {
    async open() {
      ordinal += 1;
      events.push(`open:${lane}:${ordinal}`);
      return Object.freeze({ lane, ordinal });
    },
    async dispose(connection) {
      events.push(`dispose:${connection.lane}:${connection.ordinal}`);
    },
    async retire() {
      events.push(`retire:${lane}`);
    },
  };
}

function generation(events: string[]): DestinationConfigurationGeneration<TestConnection, TestConnection> {
  return new DestinationConfigurationGeneration({
    generationId: "generation-7",
    repositoryMode: MetadataRepositoryMode.Auto,
    identity: {
      destinationId: "QAS",
      endpointId: "direct:qas.example.invalid:00",
      systemId: "QAS",
      client: "001",
      release: "758",
      metadataGeneration: "2026-07-15",
      language: "EN",
      applicationPrincipalId: "principal:application:full",
      repositoryPrincipalId: "principal:repository:restricted",
    },
    applicationFactory: factory("application", events),
    repositoryFactory: factory("repository", events),
  });
}

test("keeps immutable credential-free configuration and principal identities", () => {
  const runtime = generation([]);
  const equivalentRuntime = generation([]);
  const configuration = runtime.configuration;

  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.identity), true);
  assert.equal(configuration.repositoryMode, MetadataRepositoryMode.Auto);
  assert.notEqual(
    configuration.identity.applicationCapability.id,
    configuration.identity.repositoryCapability.id,
  );
  assert.equal(
    configuration.identity.applicationCapability.backendKey,
    configuration.identity.repositoryCapability.backendKey,
  );
  assert.equal(
    configuration.identity.structuralBackendKey,
    configuration.identity.applicationCapability.backendKey,
  );
  assert.match(
    configuration.identity.structuralBackendKey,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.equal(
    configuration.identity.structuralBackendKey,
    equivalentRuntime.configuration.identity.structuralBackendKey,
  );

  const serialized = JSON.stringify(configuration);
  assert.equal(serialized.includes("qas.example.invalid"), false);
  for (const forbidden of [
    "password",
    "passwd",
    "secret",
    "credential",
    "applicationFactory",
    "repositoryFactory",
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false);
  }

  const replacement = Object.freeze({
    ...configuration,
    generationId: "forged-generation",
  });
  assert.equal(
    Reflect.set(runtime, "configuration", replacement),
    false,
  );
  assert.equal(runtime.configuration, configuration);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(runtime, "configuration"),
    {
      value: configuration,
      writable: false,
      enumerable: true,
      configurable: false,
    },
  );
  assert.throws(
    () => Object.defineProperty(runtime, "configuration", {
      value: replacement,
    }),
    TypeError,
  );
  assert.equal(runtime.configuration, configuration);
});

test("accepts maximum-length identity components behind a bounded opaque backend key", () => {
  const maximumIdentity = "x".repeat(512);
  const applicationPrincipalId = `${"a".repeat(511)}1`;
  const repositoryPrincipalId = `${"a".repeat(511)}2`;
  const laneFactory: DestinationLaneFactory<object> = {
    async open() {
      return Object.freeze({});
    },
    dispose() {},
  };
  const create = (endpointId: string) =>
    new DestinationConfigurationGeneration({
      generationId: maximumIdentity,
      repositoryMode: MetadataRepositoryMode.Classic,
      identity: {
        destinationId: maximumIdentity,
        endpointId,
        systemId: maximumIdentity,
        client: maximumIdentity,
        release: maximumIdentity,
        metadataGeneration: maximumIdentity,
        language: maximumIdentity,
        applicationPrincipalId,
        repositoryPrincipalId,
      },
      applicationFactory: laneFactory,
      repositoryFactory: laneFactory,
    });

  const first = create(maximumIdentity);
  const equivalent = create(maximumIdentity);
  const differentEndpoint = create(`${"x".repeat(511)}y`);
  const backendKey = first.configuration.identity.structuralBackendKey;

  assert.equal(backendKey.length, 71);
  assert.equal(
    equivalent.configuration.identity.structuralBackendKey,
    backendKey,
  );
  assert.notEqual(
    differentEndpoint.configuration.identity.structuralBackendKey,
    backendKey,
  );
  assert.equal(
    first.configuration.identity.applicationCapability.principalKey,
    applicationPrincipalId,
  );
  assert.equal(
    first.configuration.identity.repositoryCapability.principalKey,
    repositoryPrincipalId,
  );
});

test("reports an invalid Symbol repository mode as a controlled validation error", () => {
  const laneFactory: DestinationLaneFactory<TestConnection> = {
    async open() {
      return Object.freeze({ lane: "application", ordinal: 1 });
    },
    dispose() {},
  };

  assert.throws(
    () => new DestinationConfigurationGeneration({
      generationId: "generation-invalid-mode",
      repositoryMode: Symbol("invalid-mode") as unknown as MetadataRepositoryMode,
      identity: {
        destinationId: "N75",
        endpointId: "direct:n75.example.invalid:00",
        systemId: "N75",
        client: "001",
        release: "750",
        metadataGeneration: "base",
        language: "EN",
        applicationPrincipalId: "principal:application",
        repositoryPrincipalId: "principal:repository",
      },
      applicationFactory: laneFactory,
      repositoryFactory: laneFactory,
    }),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "unsupported metadata repository mode Symbol(invalid-mode)",
  );
});

test("opens application and repository lanes only through their own factories", async () => {
  const events: string[] = [];
  const runtime = generation(events);

  const [application, repository] = await Promise.all([
    runtime.openApplication(),
    runtime.openRepository(),
  ]);
  assert.deepEqual(application, { lane: "application", ordinal: 1 });
  assert.deepEqual(repository, { lane: "repository", ordinal: 1 });
  assert.deepEqual(events, ["open:application:1", "open:repository:1"]);

  const monitor = runtime.monitor();
  assert.equal(Object.isFrozen(monitor), true);
  assert.equal(Object.isFrozen(monitor.application), true);
  assert.deepEqual(monitor.application, {
    attempts: 1,
    succeeded: 1,
    failed: 0,
    inFlight: 0,
  });
  assert.deepEqual(monitor.repository, {
    attempts: 1,
    succeeded: 1,
    failed: 0,
    inFlight: 0,
  });
});

test("retires both lanes once, blocks new opens, and leaves prior monitor snapshots immutable", async () => {
  const events: string[] = [];
  const runtime = generation(events);
  await runtime.openApplication();
  const before = runtime.monitor();

  const firstRetirement = runtime.retire();
  const secondRetirement = runtime.retire();
  assert.equal(firstRetirement, secondRetirement);
  await firstRetirement;

  assert.deepEqual(events, [
    "open:application:1",
    "retire:application",
    "retire:repository",
  ]);
  assert.equal(before.state, "active");
  assert.equal(runtime.monitor().state, "retired");
  await assert.rejects(() => runtime.openApplication(), /generation-7.*retired/);
  await assert.rejects(() => runtime.openRepository(), /generation-7.*retired/);
});

test("records failed opens without crossing lane counters", async () => {
  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-failure",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: {
      async open() {
        throw new Error("application open failed");
      },
      dispose() {},
    },
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
    },
  });

  await assert.rejects(() => runtime.openApplication(), /application open failed/);
  assert.deepEqual(runtime.monitor().application, {
    attempts: 1,
    succeeded: 0,
    failed: 1,
    inFlight: 0,
  });
  assert.deepEqual(runtime.monitor().repository, {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
  });
});

test("disposes a connection which finishes opening after retirement", async () => {
  let resolveOpen!: (connection: TestConnection) => void;
  const opening = new Promise<TestConnection>((resolve) => {
    resolveOpen = resolve;
  });
  const events: string[] = [];
  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-race",
    repositoryMode: MetadataRepositoryMode.Auto,
    identity: {
      destinationId: "QAS",
      endpointId: "direct:qas.example.invalid:00",
      systemId: "QAS",
      client: "001",
      release: "758",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: {
      async open() {
        return opening;
      },
      async dispose(connection) {
        events.push(`dispose:${connection.lane}:${connection.ordinal}`);
      },
    },
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
    },
  });

  const lateOpen = runtime.openApplication();
  const retirement = runtime.retire();
  assert.equal(runtime.monitor().state, "retiring");
  resolveOpen(Object.freeze({ lane: "application", ordinal: 1 }));
  await retirement;
  await assert.rejects(() => lateOpen, /retired while opening/);
  assert.deepEqual(events, ["dispose:application:1"]);
  assert.deepEqual(runtime.monitor().application, {
    attempts: 1,
    succeeded: 0,
    failed: 1,
    inFlight: 0,
  });
});

test("runs both retirement hooks and remains retired when one hook fails", async () => {
  const events: string[] = [];
  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-retire-failure",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: {
      async open() {
        return Object.freeze({ lane: "application" as const, ordinal: 1 });
      },
      dispose() {},
      retire() {
        events.push("retire:application");
        throw new Error("application retirement failed");
      },
    },
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
      retire() {
        events.push("retire:repository");
      },
    },
  });

  await assert.rejects(() => runtime.retire(), AggregateError);
  assert.deepEqual(events, ["retire:application", "retire:repository"]);
  assert.equal(runtime.monitor().state, "retired");
  await assert.rejects(() => runtime.openRepository(), /retired/);
});

test("acknowledges direct hook reentry and runs every hook exactly once", async () => {
  const events: string[] = [];
  let nestedRetirement: Promise<void> | undefined;
  let runtime!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  runtime = new DestinationConfigurationGeneration<TestConnection, TestConnection>({
    generationId: "generation-reentrant-retirement",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: {
      async open() {
        return Object.freeze({ lane: "application" as const, ordinal: 1 });
      },
      dispose() {},
      retire() {
        events.push("retire:application");
        nestedRetirement = runtime.retire();
        return nestedRetirement;
      },
    },
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
      retire() {
        events.push("retire:repository");
      },
    },
  });

  const retirement = runtime.retire();
  assert.equal(runtime.retire(), retirement);
  await retirement;
  assert.notEqual(nestedRetirement, retirement);
  await nestedRetirement;
  assert.deepEqual(events, ["retire:application", "retire:repository"]);
  assert.equal(runtime.monitor().state, "retired");
  assert.equal(runtime.retire(), retirement);
});

test("async retirement hooks can await reentrant retirement without deadlock", async () => {
  const events: string[] = [];
  const nestedRetirements: Promise<void>[] = [];
  let runtime!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  const reentrantFactory = (
    lane: TestConnection["lane"],
  ): DestinationLaneFactory<TestConnection> => ({
    async open() {
      return Object.freeze({ lane, ordinal: 1 });
    },
    dispose() {},
    async retire() {
      events.push(`retire:${lane}:start`);
      await Promise.resolve();
      const nested = runtime.retire();
      nestedRetirements.push(nested);
      await nested;
      events.push(`retire:${lane}:done`);
    },
  });
  runtime = new DestinationConfigurationGeneration({
    generationId: "generation-async-reentrant-retirement",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: reentrantFactory("application"),
    repositoryFactory: reentrantFactory("repository"),
  });

  const retirement = runtime.retire();
  assert.equal(runtime.retire(), retirement);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      retirement,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("reentrant retirement timed out")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  assert.equal(nestedRetirements.length, 2);
  assert.equal(nestedRetirements[0], nestedRetirements[1]);
  assert.notEqual(nestedRetirements[0], retirement);
  assert.deepEqual(events.sort(), [
    "retire:application:done",
    "retire:application:start",
    "retire:repository:done",
    "retire:repository:start",
  ]);
  assert.equal(runtime.monitor().state, "retired");
  assert.equal(runtime.retire(), retirement);
});

test("breaks cross-generation ancestor retirement cycles exactly once", async () => {
  const events: string[] = [];
  let first!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  let second!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  let secondRetirement: Promise<void> | undefined;
  const identity: DestinationIdentityInput = {
    destinationId: "N75",
    endpointId: "direct:n75.example.invalid:00",
    systemId: "N75",
    client: "001",
    release: "750",
    metadataGeneration: "base",
    language: "EN",
    applicationPrincipalId: "principal:application",
    repositoryPrincipalId: "principal:repository",
  };
  const inertFactory = (
    lane: TestConnection["lane"],
  ): DestinationLaneFactory<TestConnection> => ({
    async open(): Promise<TestConnection> {
      return Object.freeze({ lane, ordinal: 1 });
    },
    dispose() {},
  });
  const firstFactory: DestinationLaneFactory<TestConnection> = {
    ...inertFactory("application"),
    async retire() {
      events.push("first:start");
      secondRetirement = second.retire();
      await secondRetirement;
      events.push("first:done");
    },
  };
  const secondFactory: DestinationLaneFactory<TestConnection> = {
    ...inertFactory("application"),
    async retire() {
      events.push("second:start");
      await first.retire();
      events.push("second:done");
    },
  };
  first = new DestinationConfigurationGeneration({
    generationId: "generation-first",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity,
    applicationFactory: firstFactory,
    repositoryFactory: inertFactory("repository"),
  });
  second = new DestinationConfigurationGeneration({
    generationId: "generation-second",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity,
    applicationFactory: secondFactory,
    repositoryFactory: inertFactory("repository"),
  });

  const firstRetirement = first.retire();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      firstRetirement,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("cross-generation retirement timed out")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  assert.ok(secondRetirement);
  await secondRetirement;
  assert.deepEqual(events, [
    "first:start",
    "second:start",
    "second:done",
    "first:done",
  ]);
  assert.equal(first.monitor().state, "retired");
  assert.equal(second.monitor().state, "retired");
  assert.equal(first.retire(), firstRetirement);
  assert.equal(second.retire(), secondRetirement);
});

test("breaks parallel cross-generation retirement joins without losing authority", async () => {
  const events: string[] = [];
  let root!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  let left!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  let right!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  let leftRetirement: Promise<void> | undefined;
  let rightRetirement: Promise<void> | undefined;
  let cycleAcknowledgement: Promise<void> | undefined;
  const identity: DestinationIdentityInput = {
    destinationId: "N75",
    endpointId: "direct:n75.example.invalid:00",
    systemId: "N75",
    client: "001",
    release: "750",
    metadataGeneration: "base",
    language: "EN",
    applicationPrincipalId: "principal:application",
    repositoryPrincipalId: "principal:repository",
  };
  const inertFactory = (
    lane: TestConnection["lane"],
  ): DestinationLaneFactory<TestConnection> => ({
    async open(): Promise<TestConnection> {
      return Object.freeze({ lane, ordinal: 1 });
    },
    dispose() {},
  });
  const leftFactory: DestinationLaneFactory<TestConnection> = {
    ...inertFactory("application"),
    async retire() {
      events.push("left->right:start");
      await right.retire();
      events.push("left->right:done");
    },
  };
  const rightFactory: DestinationLaneFactory<TestConnection> = {
    ...inertFactory("application"),
    async retire() {
      events.push("right->left:start");
      cycleAcknowledgement = left.retire();
      await cycleAcknowledgement;
      events.push("right->left:done");
    },
  };
  left = new DestinationConfigurationGeneration({
    generationId: "generation-left",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity,
    applicationFactory: leftFactory,
    repositoryFactory: inertFactory("repository"),
  });
  right = new DestinationConfigurationGeneration({
    generationId: "generation-right",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity,
    applicationFactory: rightFactory,
    repositoryFactory: inertFactory("repository"),
  });
  root = new DestinationConfigurationGeneration({
    generationId: "generation-root",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity,
    applicationFactory: {
      ...inertFactory("application"),
      async retire() {
        events.push("root->left:start");
        leftRetirement = left.retire();
        await leftRetirement;
        events.push("root->left:done");
      },
    },
    repositoryFactory: {
      ...inertFactory("repository"),
      async retire() {
        events.push("root->right:start");
        rightRetirement = right.retire();
        await rightRetirement;
        events.push("root->right:done");
      },
    },
  });

  const rootRetirement = root.retire();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      rootRetirement,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("parallel retirement join timed out")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  assert.ok(leftRetirement);
  assert.ok(rightRetirement);
  assert.ok(cycleAcknowledgement);
  await Promise.all([leftRetirement, rightRetirement]);
  assert.notEqual(cycleAcknowledgement, leftRetirement);
  assert.deepEqual(events.sort(), [
    "left->right:done",
    "left->right:start",
    "right->left:done",
    "right->left:start",
    "root->left:done",
    "root->left:start",
    "root->right:done",
    "root->right:start",
  ]);
  assert.equal(root.monitor().state, "retired");
  assert.equal(left.monitor().state, "retired");
  assert.equal(right.monitor().state, "retired");
  assert.equal(root.retire(), rootRetirement);
  assert.equal(left.retire(), leftRetirement);
  assert.equal(right.retire(), rightRetirement);
});

test("snapshots every constructor field and lane operation exactly once", async () => {
  const reads = new Map<string, number>();
  const events: string[] = [];
  const once = <T>(name: string, first: T, later: T): T => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    return count === 1 ? first : later;
  };
  const firstIdentity: DestinationIdentityInput = {
    get destinationId() {
      return once("identity.destinationId", "destination:first", "destination:later");
    },
    get endpointId() {
      return once("identity.endpointId", "endpoint:first", "endpoint:later");
    },
    get systemId() {
      return once("identity.systemId", "SYS1", "SYS2");
    },
    get client() {
      return once("identity.client", "001", "002");
    },
    get release() {
      return once("identity.release", "750", "999");
    },
    get metadataGeneration() {
      return once("identity.metadataGeneration", "metadata:first", "metadata:later");
    },
    get language() {
      return once("identity.language", "EN", "DE");
    },
    get applicationPrincipalId() {
      return once(
        "identity.applicationPrincipalId",
        "principal:application:first",
        "principal:application:later",
      );
    },
    get repositoryPrincipalId() {
      return once(
        "identity.repositoryPrincipalId",
        "principal:repository:first",
        "principal:repository:later",
      );
    },
  };
  const laterIdentity: DestinationIdentityInput = {
    destinationId: "destination:replacement",
    endpointId: "endpoint:replacement",
    systemId: "REPLACED",
    client: "999",
    release: "999",
    metadataGeneration: "metadata:replacement",
    language: "ZZ",
    applicationPrincipalId: "principal:application:replacement",
    repositoryPrincipalId: "principal:repository:replacement",
  };
  const accessorFactory = (
    lane: TestConnection["lane"],
  ): DestinationLaneFactory<TestConnection> => {
    const firstOpen = async (): Promise<TestConnection> =>
      Object.freeze({ lane, ordinal: 1 });
    const laterOpen = async (): Promise<TestConnection> =>
      Object.freeze({ lane, ordinal: 2 });
    const firstDispose = (connection: TestConnection) => {
      events.push(`dispose:first:${connection.lane}:${connection.ordinal}`);
    };
    const laterDispose = (connection: TestConnection) => {
      events.push(`dispose:later:${connection.lane}:${connection.ordinal}`);
    };
    const firstRetire = () => {
      events.push(`retire:first:${lane}`);
    };
    const laterRetire = () => {
      events.push(`retire:later:${lane}`);
    };
    return {
      get open() {
        return once(`${lane}.open`, firstOpen, laterOpen);
      },
      get dispose() {
        return once(`${lane}.dispose`, firstDispose, laterDispose);
      },
      get retire() {
        return once(`${lane}.retire`, firstRetire, laterRetire);
      },
    };
  };
  const applicationFactory = accessorFactory("application");
  const repositoryFactory = accessorFactory("repository");
  const replacementFactory = factory("repository", events);
  const options: DestinationConfigurationGenerationOptions<
    TestConnection,
    TestConnection
  > = {
    get generationId() {
      return once("options.generationId", "generation:first", "generation:later");
    },
    get repositoryMode() {
      return once(
        "options.repositoryMode",
        MetadataRepositoryMode.Classic,
        MetadataRepositoryMode.Auto,
      );
    },
    get identity() {
      return once("options.identity", firstIdentity, laterIdentity);
    },
    get applicationFactory() {
      return once(
        "options.applicationFactory",
        applicationFactory,
        replacementFactory,
      );
    },
    get repositoryFactory() {
      return once(
        "options.repositoryFactory",
        repositoryFactory,
        replacementFactory,
      );
    },
  };

  const runtime = new DestinationConfigurationGeneration(options);
  const application = await runtime.openApplication();
  await runtime.retire();

  assert.equal(runtime.configuration.generationId, "generation:first");
  assert.equal(runtime.configuration.repositoryMode, MetadataRepositoryMode.Classic);
  assert.equal(runtime.configuration.identity.destinationId, "destination:first");
  assert.equal(runtime.configuration.identity.systemId, "SYS1");
  assert.equal(application.ordinal, 1);
  assert.deepEqual(events, [
    "retire:first:application",
    "retire:first:repository",
  ]);
  for (const field of [
    "options.generationId",
    "options.repositoryMode",
    "options.identity",
    "options.applicationFactory",
    "options.repositoryFactory",
    "identity.destinationId",
    "identity.endpointId",
    "identity.systemId",
    "identity.client",
    "identity.release",
    "identity.metadataGeneration",
    "identity.language",
    "identity.applicationPrincipalId",
    "identity.repositoryPrincipalId",
    "application.open",
    "application.dispose",
    "application.retire",
    "repository.open",
    "repository.dispose",
    "repository.retire",
  ]) {
    assert.equal(reads.get(field), 1, field);
  }
});

test("does not trust caller-owned Function.bind on lane operations", async () => {
  const events: string[] = [];
  const laneFactory = {
    lane: "application" as const,
    async open(this: { lane: TestConnection["lane"] }) {
      events.push(`open:${this.lane}`);
      return Object.freeze({ lane: this.lane, ordinal: 1 });
    },
    dispose(this: { lane: TestConnection["lane"] }, connection: TestConnection) {
      events.push(`dispose:${this.lane}:${connection.ordinal}`);
    },
    retire(this: { lane: TestConnection["lane"] }) {
      events.push(`retire:${this.lane}`);
    },
  };
  for (const operation of [
    laneFactory.open,
    laneFactory.dispose,
    laneFactory.retire,
  ]) {
    Object.defineProperty(operation, "bind", {
      configurable: true,
      value() {
        throw new Error("caller-owned bind must not run");
      },
    });
  }

  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-poisoned-bind",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: laneFactory,
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
    },
  });

  assert.deepEqual(await runtime.openApplication(), {
    lane: "application",
    ordinal: 1,
  });
  await runtime.retire();
  assert.deepEqual(events, ["open:application", "retire:application"]);
});

test("snapshots nested destination fields before later option accessors can mutate them", async () => {
  const identity = {
    destinationId: "N75",
    endpointId: "direct:n75.example.invalid:00",
    systemId: "N75",
    client: "001",
    release: "750",
    metadataGeneration: "base",
    language: "EN",
    applicationPrincipalId: "principal:application",
    repositoryPrincipalId: "principal:repository",
  };
  const applicationEvents: string[] = [];
  const applicationFactory: DestinationLaneFactory<TestConnection> = {
    async open() {
      applicationEvents.push("open:first");
      return Object.freeze({ lane: "application", ordinal: 1 });
    },
    dispose() {},
  };
  const laterOpen = async (): Promise<TestConnection> => {
    applicationEvents.push("open:mutated");
    return Object.freeze({ lane: "application", ordinal: 2 });
  };
  const repositoryFactory: DestinationLaneFactory<TestConnection> = {
    async open() {
      return Object.freeze({ lane: "repository", ordinal: 1 });
    },
    dispose() {},
  };
  const options: DestinationConfigurationGenerationOptions<
    TestConnection,
    TestConnection
  > = {
    generationId: "generation-coherent-snapshot",
    repositoryMode: MetadataRepositoryMode.Classic,
    get identity() {
      return identity;
    },
    get applicationFactory() {
      return applicationFactory;
    },
    get repositoryFactory() {
      identity.systemId = "MUTATED";
      applicationFactory.open = laterOpen;
      return repositoryFactory;
    },
  };

  const runtime = new DestinationConfigurationGeneration(options);
  assert.equal(runtime.configuration.identity.systemId, "N75");
  assert.equal((await runtime.openApplication()).ordinal, 1);
  assert.deepEqual(applicationEvents, ["open:first"]);
});

test("retirement drains an admitted open and its late-connection disposal", async () => {
  let finishOpen!: (connection: TestConnection) => void;
  let finishDispose!: () => void;
  const opening = new Promise<TestConnection>((resolve) => {
    finishOpen = resolve;
  });
  const disposing = new Promise<void>((resolve) => {
    finishDispose = resolve;
  });
  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-draining-open",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: {
      open() {
        return opening;
      },
      dispose() {
        return disposing;
      },
    },
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
    },
  });

  const lateOpen = runtime.openApplication();
  const retirement = runtime.retire();
  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retired, false);
  assert.equal(runtime.monitor().state, "retiring");

  finishOpen(Object.freeze({ lane: "application", ordinal: 1 }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retired, false);
  assert.equal(runtime.monitor().application.inFlight, 1);

  finishDispose();
  await assert.rejects(() => lateOpen, /retired while opening/);
  await retirement;
  assert.equal(retired, true);
  assert.equal(runtime.monitor().state, "retired");
  assert.equal(runtime.monitor().application.inFlight, 0);
});

test("retirement reports a failed late-connection disposal after draining", async () => {
  let finishOpen!: (connection: TestConnection) => void;
  const opening = new Promise<TestConnection>((resolve) => {
    finishOpen = resolve;
  });
  const laneFactory: DestinationLaneFactory<TestConnection> = {
    open() {
      return opening;
    },
    dispose() {
      throw new Error("synthetic disposal failure");
    },
  };
  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-disposal-failure",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: laneFactory,
    repositoryFactory: laneFactory,
  });

  const lateOpen = runtime.openApplication();
  const retirement = runtime.retire();
  finishOpen(Object.freeze({ lane: "application", ordinal: 1 }));
  await assert.rejects(() => lateOpen, /could not dispose a late-opened connection/);
  await assert.rejects(
    () => retirement,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] instanceof Error &&
      error.errors[0].message.includes("could not dispose"),
  );
  assert.equal(runtime.monitor().state, "retired");
  assert.equal(runtime.monitor().application.inFlight, 0);
});

test("late disposal may await owning retirement without deadlocking the drain", async () => {
  let finishOpen!: (connection: TestConnection) => void;
  const opening = new Promise<TestConnection>((resolve) => {
    finishOpen = resolve;
  });
  const events: string[] = [];
  let runtime!: DestinationConfigurationGeneration<TestConnection, TestConnection>;
  const laneFactory: DestinationLaneFactory<TestConnection> = {
    open() {
      return opening;
    },
    async dispose() {
      events.push("dispose:start");
      await runtime.retire();
      events.push("dispose:done");
    },
  };
  runtime = new DestinationConfigurationGeneration({
    generationId: "generation-reentrant-disposal",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: laneFactory,
    repositoryFactory: laneFactory,
  });

  const lateOpen = runtime.openApplication();
  const retirement = runtime.retire();
  finishOpen(Object.freeze({ lane: "application", ordinal: 1 }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      retirement,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("late-disposal retirement timed out")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  await assert.rejects(() => lateOpen, /retired while opening/);
  assert.deepEqual(events, ["dispose:start", "dispose:done"]);
  assert.equal(runtime.monitor().state, "retired");
});

test("retirement retains a late-disposal failure which settles during a slow hook", async () => {
  let finishOpen!: (connection: TestConnection) => void;
  const opening = new Promise<TestConnection>((resolve) => {
    finishOpen = resolve;
  });
  let finishHook!: () => void;
  const hook = new Promise<void>((resolve) => {
    finishHook = resolve;
  });
  const runtime = new DestinationConfigurationGeneration({
    generationId: "generation-slow-hook-disposal-failure",
    repositoryMode: MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "N75",
      endpointId: "direct:n75.example.invalid:00",
      systemId: "N75",
      client: "001",
      release: "750",
      metadataGeneration: "base",
      language: "EN",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    applicationFactory: {
      open() {
        return opening;
      },
      dispose() {
        throw new Error("synthetic late disposal failure");
      },
      retire() {
        return hook;
      },
    },
    repositoryFactory: {
      async open() {
        return Object.freeze({ lane: "repository" as const, ordinal: 1 });
      },
      dispose() {},
    },
  });

  const lateOpen = runtime.openApplication();
  const retirement = runtime.retire();
  const openFailure = assert.rejects(
    lateOpen,
    /could not dispose a late-opened connection/,
  );
  const retirementFailure = assert.rejects(
    retirement,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (failure) =>
          failure instanceof Error &&
          failure.message.includes("could not dispose"),
      ),
  );

  finishOpen(Object.freeze({ lane: "application", ordinal: 1 }));
  await openFailure;
  assert.equal(runtime.monitor().application.inFlight, 0);
  assert.equal(runtime.monitor().state, "retiring");

  finishHook();
  await retirementFailure;
  assert.equal(runtime.monitor().state, "retired");
});
