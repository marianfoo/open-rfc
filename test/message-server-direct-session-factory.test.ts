import assert from "node:assert/strict";
import test from "node:test";

import type { DirectCpicSession } from "../src/client/direct-cpic-session.js";
import { planConnectionRoute } from "../src/compat/connection-route.js";
import {
  createMessageServerDirectSessionFactory,
  messageServerOwnerConnection,
} from "../src/compat/message-server-direct-session-factory.js";
import type {
  DirectDestinationSessionFactory,
  DirectDestinationSessionOpenContext,
  DirectDestinationSessionOpenResult,
} from "../src/destination/direct-destination-owner.js";
import type { MessageServerRfcGroupTarget } from
  "../src/protocol/message-server.js";
import { NiTransportError } from "../src/transport/ni-socket.js";

const TARGET_00: MessageServerRfcGroupTarget = Object.freeze({
  applicationServerHost: "app-00.example.test",
  dispatcherPort: 3200,
  gatewayPort: 3300,
  gatewayService: "sapgw00",
  systemNumber: "00",
});

const TARGET_01: MessageServerRfcGroupTarget = Object.freeze({
  applicationServerHost: "app-01.example.test",
  dispatcherPort: 3201,
  gatewayPort: 3301,
  gatewayService: "sapgw01",
  systemNumber: "01",
});

function plan() {
  return planConnectionRoute({
    mshost: "message.example.test",
    msserv: "sapmsQAS",
    r3name: "QAS",
    sysid: "IGN",
    group: "PUBLIC",
    client: "001",
    user: "MESSAGE_USER",
    passwd: ["message", "password"].join("-"),
    lang: "EN",
  });
}

function selectedSession(
  result: DirectDestinationSessionOpenResult,
): { readonly session: DirectCpicSession; readonly selectedConnection: object } {
  assert.equal(typeof result, "object");
  assert.ok(Object.hasOwn(result, "session"));
  return result as { readonly session: DirectCpicSession; readonly selectedConnection: object };
}

test("resolves every physical creation independently with bounded pre-call failover", async () => {
  const selectedTargets = [TARGET_00, TARGET_01, TARGET_00];
  const resolverSignals: AbortSignal[] = [];
  const directConnections: object[] = [];
  let directCalls = 0;
  const physical = Object.freeze({}) as DirectCpicSession;
  const directFactory: DirectDestinationSessionFactory = {
    async open(connection) {
      directCalls += 1;
      directConnections.push(connection);
      if (directCalls === 1) {
        throw new NiTransportError(
          "NI_CONNECT_FAILED",
          "synthetic selected target refusal",
        );
      }
      return physical;
    },
  };
  const factory = createMessageServerDirectSessionFactory({
    plan: plan(),
    maxAttempts: 2,
    directSessionFactory: directFactory,
    async resolveGroup(options) {
      assert.equal(options.systemId, "QAS");
      assert.equal(options.group, "PUBLIC");
      assert.equal(options.messageServerService, "sapmsQAS");
      assert.ok(options.signal);
      resolverSignals.push(options.signal);
      return selectedTargets.shift()!;
    },
  });
  const controller = new AbortController();
  const context: DirectDestinationSessionOpenContext = Object.freeze({
    lane: "application",
    signal: controller.signal,
  });

  const first = selectedSession(await factory.open(
    messageServerOwnerConnection(plan()),
    context,
  ));
  assert.equal(first.session, physical);
  assert.deepEqual(first.selectedConnection, {
    host: "app-01.example.test",
    applicationServerHost: "app-01.example.test",
    port: 3301,
    applicationServerService: "sapdp01",
    client: "001",
    user: "MESSAGE_USER",
    password: ["message", "password"].join("-"),
    language: "E",
    sysnr: "01",
    cpicStreaming: "disabled",
  });

  const second = selectedSession(await factory.open(
    messageServerOwnerConnection(plan()),
    context,
  ));
  assert.equal(second.session, physical);
  assert.equal(
    (second.selectedConnection as { readonly sysnr: string }).sysnr,
    "00",
  );
  assert.equal(resolverSignals.length, 3);
  assert.equal(resolverSignals.every((signal) => signal === controller.signal), true);
  assert.equal(selectedTargets.length, 0);
  assert.equal(directConnections.length, 3);
});

test("does not retry malformed lookup results or authentication-like failures", async () => {
  for (const failure of [
    new NiTransportError("NI_PROTOCOL_ERROR", "synthetic malformed lookup"),
    new Error("synthetic logon rejection"),
  ]) {
    let attempts = 0;
    const directFactory: DirectDestinationSessionFactory = {
      async open() {
        attempts += 1;
        throw failure;
      },
    };
    const factory = createMessageServerDirectSessionFactory({
      plan: plan(),
      maxAttempts: 2,
      directSessionFactory: directFactory,
      async resolveGroup() { return TARGET_00; },
    });
    await assert.rejects(
      Promise.resolve(factory.open(messageServerOwnerConnection(plan()), {
        lane: "repository",
        signal: new AbortController().signal,
      })),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  }
});

test("rejects a pre-aborted physical open before lookup", async () => {
  const controller = new AbortController();
  controller.abort("stop");
  let resolverCalls = 0;
  const factory = createMessageServerDirectSessionFactory({
    plan: plan(),
    async resolveGroup() {
      resolverCalls += 1;
      return TARGET_00;
    },
  });
  await assert.rejects(
    Promise.resolve(factory.open(messageServerOwnerConnection(plan()), {
      lane: "application",
      signal: controller.signal,
    })),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(resolverCalls, 0);
});

test("rejects invalid factory plans and dependencies before lookup or direct open", () => {
  const directPlan = planConnectionRoute({
    ashost: "app.example.test",
    sysnr: "00",
    client: "001",
    user: "DIRECT_USER",
    passwd: ["direct", "password"].join("-"),
  });
  const propagated = Object.freeze({
    ...plan(),
    authentication: Object.freeze({
      kind: "principal-propagation" as const,
      businessUserToken: "business-user-token",
    }),
  });

  assert.throws(
    () => createMessageServerDirectSessionFactory(null as never),
    /options must be an object/u,
  );
  assert.throws(
    () => createMessageServerDirectSessionFactory({ plan: directPlan }),
    /requires a message-server route/u,
  );
  assert.throws(
    () => createMessageServerDirectSessionFactory({ plan: propagated }),
    /requires named-user authentication/u,
  );
  assert.throws(
    () => createMessageServerDirectSessionFactory({
      plan: Object.freeze({
        ...plan(),
        sapRouter: Object.freeze({ routeString: "/H/router.example.test/H/" }),
      }),
    }),
    /does not implement SAProuter or Connectivity/u,
  );
  assert.throws(
    () => createMessageServerDirectSessionFactory({
      plan: plan(),
      resolveGroup: 1 as never,
      directSessionFactory: { async open() { return Object.freeze({}) as DirectCpicSession; } },
    }),
    /resolveGroup must be a function/u,
  );
  for (const invalid of [{}, { open: 1 }]) {
    assert.throws(
      () => createMessageServerDirectSessionFactory({
        plan: plan(),
        resolveGroup: async () => TARGET_00,
        directSessionFactory: invalid as never,
      }),
      /directSessionFactory must provide open/u,
    );
  }
  assert.throws(
    () => messageServerOwnerConnection(directPlan),
    /owner connection requires a message-server route/u,
  );
  assert.throws(
    () => messageServerOwnerConnection(propagated),
    /owner connection requires named-user authentication/u,
  );
});

test("forwards optional lookup limits and unwraps an already-selected direct session", async () => {
  const withoutService = planConnectionRoute({
    mshost: "message.example.test",
    r3name: "QAS",
    group: "PUBLIC",
    client: "001",
    user: "MESSAGE_USER",
    passwd: ["message", "password"].join("-"),
  });
  const physical = Object.freeze({}) as DirectCpicSession;
  const preselected = Object.freeze({
    session: physical,
    selectedConnection: messageServerOwnerConnection(withoutService),
  });
  let directThis: unknown;
  const directFactory: DirectDestinationSessionFactory = {
    async open() {
      directThis = this;
      return preselected;
    },
  };
  const factory = createMessageServerDirectSessionFactory({
    plan: withoutService,
    connectTimeoutMs: 123,
    operationTimeoutMs: 456,
    directSessionFactory: directFactory,
    async resolveGroup(options) {
      assert.equal(options.messageServerService, undefined);
      assert.equal(options.connectTimeoutMs, 123);
      assert.equal(options.operationTimeoutMs, 456);
      return TARGET_00;
    },
  });
  const result = selectedSession(await factory.open(
    messageServerOwnerConnection(withoutService),
    {
      lane: "application",
      signal: new AbortController().signal,
    },
  ));

  assert.equal(result.session, physical);
  assert.equal(directThis, directFactory);
  assert.equal(
    (result.selectedConnection as { readonly host: string }).host,
    "app-00.example.test",
  );
});

test("aggregates bounded retry history and stops after cancellation", async () => {
  const controller = new AbortController();
  const failures = [
    new NiTransportError("NI_CONNECT_FAILED", "first selected target failed"),
    new NiTransportError("NI_CONNECT_TIMEOUT", "second selected target timed out"),
  ];
  let attempts = 0;
  const factory = createMessageServerDirectSessionFactory({
    plan: plan(),
    maxAttempts: 2,
    directSessionFactory: {
      async open() {
        const failure = failures[attempts++]!;
        if (attempts === 2) controller.abort("stop");
        throw failure;
      },
    },
    async resolveGroup() { return TARGET_00; },
  });

  await assert.rejects(
    Promise.resolve(factory.open(messageServerOwnerConnection(plan()), {
      lane: "application",
      signal: controller.signal,
    })),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures);
      assert.equal(error.cause, failures[1]);
      return true;
    },
  );
  assert.equal(attempts, 2);
});
