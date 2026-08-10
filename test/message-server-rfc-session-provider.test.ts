import assert from "node:assert/strict";
import test from "node:test";

import type { MessageServerRfcGroupTarget } from "../src/protocol/message-server.js";
import {
  createRfcFailure,
  RfcCoreError,
  RfcFailureCategory,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcTransmissionState,
} from "../src/client/rfc-failure.js";
import {
  planConnectionRoute,
  type ConnectionRoutePlan,
} from "../src/compat/connection-route.js";
import {
  createMessageServerRfcSessionProvider,
  isRetryableMessageServerOpenFailure,
  messageServerTargetDirectRoute,
} from "../src/compat/message-server-rfc-session-provider.js";
import type {
  RfcSession,
  RfcSessionProvider,
  RfcSessionTransaction,
} from "../src/compat/rfc-session-provider.js";
import { TransactionRuntimeError } from "../src/lifecycle/transaction-runtime.js";
import { NiTransportError } from "../src/transport/ni-socket.js";
import { SapRouterTransportError } from "../src/transport/saprouter-tunnel.js";

const TARGET: MessageServerRfcGroupTarget = Object.freeze({
  applicationServerHost: "app.example.test",
  dispatcherPort: 3207,
  gatewayPort: 3307,
  gatewayService: "sapgw07",
  systemNumber: "07",
});

const SESSION = Object.freeze({}) as RfcSession;

function transaction(
  ready: () => Promise<void> = async () => undefined,
): RfcSessionTransaction {
  return Object.freeze({
    ready,
    async call() { return Object.freeze({}); },
    async commit() { /* fixture */ },
    async rollback() { /* fixture */ },
    async close() { /* fixture */ },
    isTerminal() { return false; },
  });
}

function session(
  ready: () => Promise<void> = async () => undefined,
  onClose: () => void = () => undefined,
  host = "fixture",
): RfcSession {
  return Object.freeze({
    connectionInfo: Object.freeze({ host }),
    beginTransaction() { return transaction(ready); },
    async getFunctionInterface() { throw new Error("not used"); },
    async getStructureDefinition() { throw new Error("not used"); },
    async close() { onClose(); },
  });
}

function messageServerPlan(): ConnectionRoutePlan {
  return planConnectionRoute({
    mshost: "message.example.test",
    msserv: "sapmsTST",
    sysid: "TST",
    group: "RFC_GROUP",
    client: "100",
    user: "TEST_USER",
    passwd: ["test", "password"].join("-"),
    lang: "EN",
  });
}

function routedMessageServerPlan(): ConnectionRoutePlan {
  return planConnectionRoute({
    mshost: "message.example.test",
    msserv: "3600",
    sysid: "TST",
    group: "RFC_GROUP",
    client: "100",
    user: "TEST_USER",
    passwd: ["test", "password"].join("-"),
    lang: "EN",
    saprouter: "/H/router.example.test/S/3299/H/",
  });
}

test("resolves before opening a direct owner and delegates the exact selected route", async () => {
  const events: string[] = [];
  const delegated: ConnectionRoutePlan[] = [];
  const opened = session();
  const directProvider: RfcSessionProvider = {
    capabilities: Object.freeze([
      "direct-rfc-transport",
      "named-user-authentication",
    ]),
    async open(plan) {
      events.push("direct-open");
      delegated.push(plan);
      return opened;
    },
  };
  const provider = createMessageServerRfcSessionProvider({
    directProvider,
    connectTimeoutMs: 123,
    operationTimeoutMs: 456,
    async resolveGroup(options) {
      events.push("resolve");
      assert.deepEqual(options, {
        messageServerHost: "message.example.test",
        messageServerService: "sapmsTST",
        systemId: "TST",
        group: "RFC_GROUP",
        connectTimeoutMs: 123,
        operationTimeoutMs: 456,
        signal: undefined,
      });
      return TARGET;
    },
  });

  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "message-server-rfc-transport",
  ]);
  const sourcePlan = messageServerPlan();
  const resolved = await provider.open(sourcePlan);
  assert.notEqual(resolved, opened);
  assert.deepEqual(events, ["resolve", "direct-open"]);
  assert.equal(delegated.length, 1);
  assert.deepEqual(delegated[0]!.route, {
    kind: "direct",
    host: "app.example.test",
    applicationServerHost: "app.example.test",
    port: 3307,
    applicationServerService: "sapdp07",
    sysnr: "07",
    cpicStreaming: "disabled",
  });
  assert.equal(delegated[0]!.logon, sourcePlan.logon);
  assert.equal(delegated[0]!.authentication, sourcePlan.authentication);
  assert.deepEqual(delegated[0]!.requiredProviderCapabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
  ]);
});

test("plain message-server routing does not create a configured SAProuter transport", async () => {
  let routeCreations = 0;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: [
        "direct-rfc-transport",
        "named-user-authentication",
        "saprouter-routing",
      ],
      async open() { return SESSION; },
    },
    sapRouterTransportFactory() {
      routeCreations += 1;
      return async () => {
        throw new Error("plain message-server routing must use direct NI");
      };
    },
    async resolveGroup(options) {
      assert.equal(options.transportFactory, undefined);
      return TARGET;
    },
  });

  await provider.open(messageServerPlan());
  assert.equal(routeCreations, 0);
});

test("bounds lookup retries and delegates a fresh redirect without replaying a call", async () => {
  const targets = [
    new NiTransportError("NI_CONNECT_FAILED", "synthetic lookup refusal"),
    TARGET,
  ];
  const delegated: ConnectionRoutePlan[] = [];
  const opened = session();
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open(plan) {
        delegated.push(plan);
        return opened;
      },
    },
    maxAttempts: 2,
    async resolveGroup() {
      const outcome = targets.shift()!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });

  const resolved = await provider.open(messageServerPlan());
  assert.equal(resolved === opened, false);
  assert.equal(targets.length, 0);
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0]!.route.kind, "direct");
});

test("fails over once when the redirected session cannot open before any business call", async () => {
  const events: string[] = [];
  let resolverCalls = 0;
  let directOpenCalls = 0;
  let firstCloseCalls = 0;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() {
        directOpenCalls += 1;
        if (directOpenCalls === 1) {
          return session(
            async () => {
              events.push("first-ready");
              throw new NiTransportError(
                "NI_CONNECT_FAILED",
                "synthetic application-server refusal",
              );
            },
            () => { firstCloseCalls += 1; },
            "first.example.test",
          );
        }
        return session(
          async () => { events.push("second-ready"); },
          undefined,
          "second.example.test",
        );
      },
    },
    maxAttempts: 2,
    async resolveGroup() {
      resolverCalls += 1;
      events.push(`resolve-${resolverCalls}`);
      return TARGET;
    },
  });

  const resolved = await provider.open(messageServerPlan());
  assert.equal(resolved.connectionInfo.host, "first.example.test");
  const active = resolved.beginTransaction();
  await active.ready();
  assert.equal(resolved.connectionInfo.host, "second.example.test");
  assert.deepEqual(events, [
    "resolve-1",
    "first-ready",
    "resolve-2",
    "second-ready",
  ]);
  assert.equal(resolverCalls, 2);
  assert.equal(directOpenCalls, 2);
  assert.equal(firstCloseCalls, 1);
  assert.deepEqual(await active.call("Z_NEVER_REPLAYED", {}, {}), {});
});

test("does not retry protocol, authentication-like, or exhausted failures", async () => {
  for (const failure of [
    new NiTransportError("NI_PROTOCOL_ERROR", "synthetic malformed reply"),
    new Error("synthetic authentication rejection"),
  ]) {
    let resolveCalls = 0;
    const provider = createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["direct-rfc-transport", "named-user-authentication"],
        async open() { return session(); },
      },
      maxAttempts: 2,
      async resolveGroup() {
        resolveCalls += 1;
        throw failure;
      },
    });
    await assert.rejects(provider.open(messageServerPlan()), (error) => error === failure);
    assert.equal(resolveCalls, 1);
  }

  let exhaustedCalls = 0;
  const exhausted = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() { return session(); },
    },
    maxAttempts: 2,
    async resolveGroup() {
      exhaustedCalls += 1;
      throw new NiTransportError("NI_CONNECT_TIMEOUT", "synthetic timeout");
    },
  });
  await assert.rejects(
    exhausted.open(messageServerPlan()),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.message === "message-server RFC open failed after 2 bounded attempts",
  );
  assert.equal(exhaustedCalls, 2);
});

test("forwards cancellation into lookup and never opens a redirected session", async () => {
  const controller = new AbortController();
  let directOpenCalls = 0;
  let capturedSignal: AbortSignal | undefined;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() {
        directOpenCalls += 1;
        return session();
      },
    },
    async resolveGroup(options) {
      capturedSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(
          new NiTransportError("NI_ABORTED", "synthetic lookup cancellation"),
        ), { once: true });
      });
    },
  });
  const pending = provider.open(messageServerPlan(), controller.signal);
  controller.abort("stop");
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(capturedSignal, controller.signal);
  assert.equal(directOpenCalls, 0);
});

test("never creates the direct owner when resolution fails", async () => {
  const failure = new Error("synthetic message-server failure");
  let directOpenCalls = 0;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() {
        directOpenCalls += 1;
        return SESSION;
      },
    },
    async resolveGroup() {
      throw failure;
    },
  });

  await assert.rejects(provider.open(messageServerPlan()), (error) => error === failure);
  assert.equal(directOpenCalls, 0);
});

test("accepts a consistent target at every legal dispatcher port", () => {
  // A port offset is a landscape property; the block rule is what must hold.
  for (let dispatcherPort = 1; dispatcherPort + 100 <= 0xffff; dispatcherPort += 1) {
    const systemNumber = (dispatcherPort % 100).toString(10).padStart(2, "0");
    const route = messageServerTargetDirectRoute({
      applicationServerHost: "app.example.test",
      dispatcherPort,
      gatewayPort: dispatcherPort + 100,
      gatewayService: `sapgw${systemNumber}`,
      systemNumber,
    });
    if (
      route.port !== dispatcherPort + 100 ||
      route.applicationServerService !== `sapdp${systemNumber}` ||
      route.sysnr !== systemNumber
    ) {
      assert.deepEqual(route, { dispatcherPort, systemNumber });
    }
  }
  assert.deepEqual(
    messageServerTargetDirectRoute({
      applicationServerHost: "app.example.test",
      dispatcherPort: 3607,
      gatewayPort: 3707,
      gatewayService: "sapgw07",
      systemNumber: "07",
    }),
    {
      kind: "direct",
      host: "app.example.test",
      applicationServerHost: "app.example.test",
      port: 3707,
      applicationServerService: "sapdp07",
      sysnr: "07",
      cpicStreaming: "disabled",
    },
  );
});

test("rejects inconsistent resolver output before direct owner creation", async () => {
  let directOpenCalls = 0;
  for (const target of [
    { ...TARGET, applicationServerHost: "A".repeat(65) },
    { ...TARGET, systemNumber: "7" },
    { ...TARGET, dispatcherPort: 3208 },
    { ...TARGET, gatewayPort: 3308 },
    { ...TARGET, gatewayService: "sapgw08" },
    { ...TARGET, dispatcherPort: 3607 },
    { dispatcherPort: 0, gatewayPort: 100, gatewayService: "sapgw00", systemNumber: "00", applicationServerHost: "app.example.test" },
    { dispatcherPort: 65500, gatewayPort: 65600, gatewayService: "sapgw00", systemNumber: "00", applicationServerHost: "app.example.test" },
    { ...TARGET, dispatcherPort: 3207.5, gatewayPort: 3307.5 },
  ]) {
    const provider = createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["direct-rfc-transport", "named-user-authentication"],
        async open() {
          directOpenCalls += 1;
          return SESSION;
        },
      },
      async resolveGroup() {
        return target;
      },
    });
    await assert.rejects(
      provider.open(messageServerPlan()),
      /message-server resolver returned/u,
    );
  }
  assert.equal(directOpenCalls, 0);
});

test("delegates direct routes unchanged and never resolves them", async () => {
  const directPlan = planConnectionRoute({
    ashost: "app.example.test",
    sysnr: "07",
    client: "100",
    user: "TEST_USER",
    passwd: ["test", "password"].join("-"),
  });
  let resolveCalls = 0;
  let delegated: ConnectionRoutePlan | undefined;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open(plan) {
        delegated = plan;
        return SESSION;
      },
    },
    async resolveGroup() {
      resolveCalls += 1;
      return TARGET;
    },
  });

  assert.equal(await provider.open(directPlan), SESSION);
  assert.equal(delegated, directPlan);
  assert.equal(resolveCalls, 0);
});

test("routes both message-server lookup and selected gateway through SAProuter", async () => {
  const events: string[] = [];
  const delegated: ConnectionRoutePlan[] = [];
  const routeStrings: string[] = [];
  const lookupTransportFactory = async () => {
    throw new Error("lookup transport stays lazy in the provider composition test");
  };
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: [
        "direct-rfc-transport",
        "named-user-authentication",
        "saprouter-routing",
      ],
      async open(plan) {
        events.push("direct-open");
        delegated.push(plan);
        return SESSION;
      },
    },
    sapRouterTransportFactory(routeString) {
      events.push("route-lookup");
      routeStrings.push(routeString);
      return lookupTransportFactory;
    },
    async resolveGroup(options) {
      events.push("resolve");
      assert.equal(options.transportFactory, lookupTransportFactory);
      return TARGET;
    },
  });

  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
    "message-server-rfc-transport",
    "message-server-saprouter-routing",
  ]);
  const sourcePlan = routedMessageServerPlan();
  await provider.open(sourcePlan);
  assert.deepEqual(events, ["route-lookup", "resolve", "direct-open"]);
  assert.deepEqual(routeStrings, [
    "/H/router.example.test/S/3299/H/",
  ]);
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0]!.sapRouter, sourcePlan.sapRouter);
  assert.deepEqual(delegated[0]!.route, {
    kind: "direct",
    host: "app.example.test",
    applicationServerHost: "app.example.test",
    port: 3307,
    applicationServerService: "sapdp07",
    sysnr: "07",
    cpicStreaming: "disabled",
  });
  assert.deepEqual(delegated[0]!.requiredProviderCapabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
  ]);
});

test("requires both SAProuter legs before advertising routed message-server support", async () => {
  let resolveCalls = 0;
  let directOpenCalls = 0;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: [
        "direct-rfc-transport",
        "named-user-authentication",
        "saprouter-routing",
      ],
      async open() {
        directOpenCalls += 1;
        return SESSION;
      },
    },
    async resolveGroup() {
      resolveCalls += 1;
      return TARGET;
    },
  });
  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
    "message-server-rfc-transport",
  ]);

  await assert.rejects(
    provider.open(routedMessageServerPlan()),
    /does not implement message-server SAProuter routing/u,
  );
  assert.equal(resolveCalls, 0);
  assert.equal(directOpenCalls, 0);
});

test("does not inherit unrelated wrapped-provider capabilities", () => {
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: [
        "direct-rfc-transport",
        "named-user-authentication",
        "saprouter-routing",
        "message-server-saprouter-routing",
        "connectivity-rfc-proxy",
        "connectivity-proxy-authorization",
        "websocket-rfc-transport",
      ],
      async open() { return SESSION; },
    },
  });

  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
    "message-server-rfc-transport",
  ]);
});

test("rejects an invalid routed lookup factory before resolver or direct I/O", async () => {
  let resolveCalls = 0;
  let directOpenCalls = 0;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: [
        "direct-rfc-transport",
        "named-user-authentication",
        "saprouter-routing",
      ],
      async open() {
        directOpenCalls += 1;
        return SESSION;
      },
    },
    sapRouterTransportFactory: () => 1 as never,
    async resolveGroup() {
      resolveCalls += 1;
      return TARGET;
    },
  });

  await assert.rejects(
    provider.open(routedMessageServerPlan()),
    /must return a transport function/u,
  );
  assert.equal(resolveCalls, 0);
  assert.equal(directOpenCalls, 0);
});

test("rejects Connectivity before invoking either routed transport leg", async () => {
  let resolveCalls = 0;
  let routeCreations = 0;
  let directOpenCalls = 0;
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: [
        "direct-rfc-transport",
        "named-user-authentication",
        "saprouter-routing",
      ],
      async open() {
        directOpenCalls += 1;
        return SESSION;
      },
    },
    sapRouterTransportFactory() {
      routeCreations += 1;
      return async () => {
        throw new Error("transport must stay lazy");
      };
    },
    async resolveGroup() {
      resolveCalls += 1;
      return TARGET;
    },
  });
  const plan = messageServerPlan();
  await assert.rejects(
    provider.open(Object.freeze({
      ...plan,
      connectivityProxy: Object.freeze({
        host: "connectivity.example.test",
        port: 20_001,
      }),
    })),
    /does not implement Connectivity/u,
  );
  assert.equal(routeCreations, 0);
  assert.equal(resolveCalls, 0);
  assert.equal(directOpenCalls, 0);
});

test("requires a structurally valid underlying direct provider", () => {
  assert.throws(
    () => createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["named-user-authentication"],
        async open() {
          return SESSION;
        },
      },
    }),
    /requires a direct-rfc-transport provider/u,
  );
  assert.throws(
    () => createMessageServerRfcSessionProvider({
      directProvider: null as unknown as RfcSessionProvider,
    }),
    /directProvider must be an RFC session provider/u,
  );
  assert.throws(
    () => createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["direct-rfc-transport"],
        async open() {
          return SESSION;
        },
      },
      operationTimeoutMs: 0,
    }),
    /operationTimeoutMs must be an integer/u,
  );
  assert.throws(
    () => createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["direct-rfc-transport"],
        async open() { return SESSION; },
      },
      maxAttempts: 5,
    }),
    /maxAttempts must be an integer in 1\.\.4/u,
  );
  assert.throws(
    () => createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["direct-rfc-transport", "saprouter-routing"],
        async open() { return SESSION; },
      },
      sapRouterTransportFactory: 1 as never,
    }),
    /sapRouterTransportFactory must be a function/u,
  );
  assert.throws(
    () => createMessageServerRfcSessionProvider({
      directProvider: {
        capabilities: ["direct-rfc-transport"],
        async open() { return SESSION; },
      },
      sapRouterTransportFactory: () => async () => {
        throw new Error("transport must stay lazy");
      },
    }),
    /requires a routed direct provider/u,
  );
});

test("classifies only bounded pre-call communication failures as retryable", () => {
  const communication = new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.Communication,
    origin: RfcFailureOrigin.Ni,
    phase: RfcOperationPhase.Connect,
    transmission: RfcTransmissionState.NotStarted,
    establishedSession: false,
    correlationId: "message-server-retry",
    reasonCode: "MESSAGE_SERVER_RETRY",
  }));
  const invalid = new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.InvalidParameter,
    origin: RfcFailureOrigin.Api,
    phase: RfcOperationPhase.Encode,
    transmission: RfcTransmissionState.NotStarted,
    establishedSession: false,
    correlationId: "message-server-invalid",
    reasonCode: "MESSAGE_SERVER_INVALID",
  }));

  assert.equal(isRetryableMessageServerOpenFailure(communication), true);
  assert.equal(isRetryableMessageServerOpenFailure(invalid), false);
  assert.equal(
    isRetryableMessageServerOpenFailure(
      new TransactionRuntimeError("OPERATION_TIMEOUT", "synthetic timeout"),
    ),
    true,
  );
  assert.equal(
    isRetryableMessageServerOpenFailure(
      new TransactionRuntimeError("INVALID_TRANSACTION_STATE", "synthetic state"),
    ),
    false,
  );
  assert.equal(
    isRetryableMessageServerOpenFailure(
      new AggregateError([], "wrapped", { cause: communication }),
    ),
    true,
  );
  assert.equal(
    isRetryableMessageServerOpenFailure(
      new SapRouterTransportError(
        "SAPROUTER_CONNECT_TIMEOUT",
        "synthetic routed lookup timeout",
      ),
    ),
    true,
  );
  assert.equal(
    isRetryableMessageServerOpenFailure(
      new SapRouterTransportError(
        "SAPROUTER_ROUTE_DENIED",
        "synthetic route policy rejection",
      ),
    ),
    false,
  );

  const cyclic = new AggregateError([], "cyclic");
  Object.defineProperty(cyclic, "cause", { value: cyclic });
  assert.equal(isRetryableMessageServerOpenFailure(cyclic), false);
});

test("preserves redirected metadata and transaction lifecycle boundaries", async () => {
  const events: string[] = [];
  const metadataSignal = new AbortController().signal;
  const delegate: RfcSession = Object.freeze({
    connectionInfo: Object.freeze({ host: "selected.example.test" }),
    beginTransaction() {
      events.push("begin");
      return Object.freeze({
        async ready() { events.push("ready"); },
        async call(
          functionName: string,
          parameters: Readonly<Record<string, unknown>>,
          options: Readonly<{ notRequested?: readonly string[] }>,
        ) {
          events.push(`call:${functionName}:${Object.keys(parameters).length}:${options.notRequested?.length ?? 0}`);
          return Object.freeze({ RESULT: "ok" });
        },
        async commit() { events.push("commit"); },
        async rollback() { events.push("rollback"); },
        async close() { events.push("transaction-close"); },
        isTerminal() { events.push("terminal"); return true; },
      });
    },
    async getFunctionInterface(functionName: string, signal?: AbortSignal) {
      assert.equal(functionName, "RFC_PING");
      assert.equal(signal, metadataSignal);
      events.push("function-interface");
      return Object.freeze({}) as never;
    },
    async getStructureDefinition(structureName: string, signal?: AbortSignal) {
      assert.equal(structureName, "RFCSI");
      assert.equal(signal, metadataSignal);
      events.push("structure-definition");
      return Object.freeze({}) as never;
    },
    async getRecursiveFunctionMetadata(functionName: string, signal?: AbortSignal) {
      assert.equal(functionName, "STFC_DEEP_TABLE");
      assert.equal(signal, metadataSignal);
      events.push("recursive-metadata");
      return Object.freeze({}) as never;
    },
    async close() { events.push("session-close"); },
  });
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() { return delegate; },
    },
    async resolveGroup() { return TARGET; },
  });
  const selected = await provider.open(messageServerPlan());

  assert.deepEqual(selected.connectionInfo, { host: "selected.example.test" });
  await selected.getFunctionInterface("RFC_PING", metadataSignal);
  await selected.getStructureDefinition("RFCSI", metadataSignal);
  await selected.getRecursiveFunctionMetadata?.("STFC_DEEP_TABLE", metadataSignal);
  const active = selected.beginTransaction();
  assert.equal(await active.ready(), undefined);
  assert.equal(await active.ready(), undefined);
  assert.deepEqual(
    await active.call("STFC_CONNECTION", { REQUTEXT: "safe" }, { notRequested: ["ECHOTEXT"] }),
    { RESULT: "ok" },
  );
  await active.commit();
  await active.rollback();
  assert.equal(active.isTerminal(), true);
  await Promise.all([active.close(), active.close()]);
  await Promise.all([selected.close(), selected.close()]);
  assert.throws(() => selected.beginTransaction(), /session is closed/u);

  assert.deepEqual(events, [
    "function-interface",
    "structure-definition",
    "recursive-metadata",
    "begin",
    "ready",
    "call:STFC_CONNECTION:1:1",
    "commit",
    "rollback",
    "terminal",
    "transaction-close",
    "session-close",
  ]);
});

test("surfaces cleanup convergence failures instead of opening another redirect", async () => {
  const primary = new NiTransportError(
    "NI_CONNECT_FAILED",
    "synthetic selected target failure",
  );
  const transactionCleanup = new Error("synthetic transaction cleanup failure");
  const sessionCleanup = new Error("synthetic session cleanup failure");
  let resolveCalls = 0;
  const broken: RfcSession = Object.freeze({
    connectionInfo: Object.freeze({ host: "broken.example.test" }),
    beginTransaction() {
      return Object.freeze({
        async ready() { throw primary; },
        async call() { return Object.freeze({}); },
        async commit() { /* fixture */ },
        async rollback() { /* fixture */ },
        async close() { throw transactionCleanup; },
        isTerminal() { return false; },
      });
    },
    async getFunctionInterface() { return Object.freeze({}) as never; },
    async getStructureDefinition() { return Object.freeze({}) as never; },
    async close() { throw sessionCleanup; },
  });
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() { return broken; },
    },
    maxAttempts: 2,
    async resolveGroup() {
      resolveCalls += 1;
      return TARGET;
    },
  });
  const selected = await provider.open(messageServerPlan());

  await assert.rejects(selected.beginTransaction().ready(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, transactionCleanup, sessionCleanup]);
    return true;
  });
  assert.equal(resolveCalls, 1);
});

test("cancels a pending redirected ready without failover or business replay", async () => {
  const controller = new AbortController();
  let directOpenCalls = 0;
  let transactionCloseCalls = 0;
  const pending: RfcSession = Object.freeze({
    connectionInfo: Object.freeze({ host: "pending.example.test" }),
    beginTransaction() {
      return Object.freeze({
        async ready() { return await new Promise<void>(() => undefined); },
        async call() { assert.fail("business call must not run"); },
        async commit() { assert.fail("commit must not run"); },
        async rollback() { assert.fail("rollback must not run"); },
        async close() { transactionCloseCalls += 1; },
        isTerminal() { return false; },
      });
    },
    async getFunctionInterface() { return Object.freeze({}) as never; },
    async getStructureDefinition() { return Object.freeze({}) as never; },
    async close() { /* fixture */ },
  });
  const provider = createMessageServerRfcSessionProvider({
    directProvider: {
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() { directOpenCalls += 1; return pending; },
    },
    maxAttempts: 2,
    async resolveGroup() { return TARGET; },
  });
  const selected = await provider.open(messageServerPlan(), controller.signal);
  const active = selected.beginTransaction();
  const ready = active.ready();
  controller.abort("stop");

  await assert.rejects(
    ready,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(directOpenCalls, 1);
  await active.close();
  assert.equal(transactionCloseCalls, 1);
});
