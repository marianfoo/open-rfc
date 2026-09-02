import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  planCompatibilityOwnerRoute,
} from "../src/compat/compatibility-owner-route.js";
import {
  Client,
  bindClientDestinationOwnerFactory,
} from "../src/compat/node-rfc-client.js";
import {
  Pool,
  bindPoolDestinationOwnerFactory,
} from "../src/compat/node-rfc-pool.js";
import type {
  DirectCompatibilityOwnerFactoryContext,
} from "../src/compat/direct-owner-factory.js";

const ROUTE = "/H/router.fixture.invalid/S/3299/H/";
const PARAMETERS = Object.freeze({
  ashost: "application.fixture.invalid",
  sysnr: "00",
  client: "001",
  user: "fixture-user",
  passwd: "fixture-pw",
  lang: "EN",
  saprouter: ROUTE,
});

test("composes a routed physical-session factory only after strict direct admission", () => {
  const planned = planCompatibilityOwnerRoute(PARAMETERS);

  assert.equal(planned.kind, "direct");
  assert.deepEqual(planned.connection, {
    host: "application.fixture.invalid",
    applicationServerHost: "application.fixture.invalid",
    port: 3_300,
    applicationServerService: "sapdp00",
    client: "001",
    user: "fixture-user",
    password: "fixture-pw",
    language: "E",
    sysnr: "00",
    cpicStreaming: "disabled",
  });
  assert.equal(typeof planned.sessionFactory?.open, "function");
  assert.equal(Object.isFrozen(planned.sessionFactory), true);

  assert.throws(
    () => planCompatibilityOwnerRoute({
      ...PARAMETERS,
      saprouter: "/H/router.fixture.invalid/S/3299",
    }),
    /saprouter must be a valid SAProuter route prefix/u,
  );
});

test("composes Connectivity SOCKS5 and refuses legacy RFC proxy before owner I/O", async () => {
  const socks = planCompatibilityOwnerRoute({
    ...PARAMETERS,
    saprouter: undefined,
    gwhost: "virtual-gateway.invalid",
    connectivity_socks5_proxy_host: "proxy.fixture.invalid",
    connectivity_socks5_proxy_port: 20_004,
    connectivity_socks5_access_token: ["connectivity", "token", "fixture"].join("-"),
  });
  assert.equal(socks.kind, "direct");
  assert.equal(socks.connection.host, "virtual-gateway.invalid");
  assert.equal(typeof socks.sessionFactory?.open, "function");

  let ownerCreations = 0;
  const restoreClient = bindClientDestinationOwnerFactory({
    create() {
      ownerCreations += 1;
      throw new Error("owner must not be created");
    },
  });
  try {
    await assert.rejects(
      new Client({
        ...PARAMETERS,
        saprouter: undefined,
        connectivity_proxy_host: "rfc-proxy.fixture.invalid",
        connectivity_proxy_port: 20_001,
      }).open() as Promise<Client>,
      /Connectivity routes are not implemented/u,
    );
  } finally {
    restoreClient();
  }
  assert.equal(ownerCreations, 0);
});

test("Client and Pool transfer the routed session factory to their destination owner", async () => {
  const clientContexts: DirectCompatibilityOwnerFactoryContext[] = [];
  const poolContexts: DirectCompatibilityOwnerFactoryContext[] = [];
  const clientStop = new Error("client owner creation stopped before I/O");
  const poolStop = new Error("pool owner creation stopped before I/O");
  const restoreClient = bindClientDestinationOwnerFactory({
    create(context) {
      clientContexts.push(context);
      throw clientStop;
    },
  });
  try {
    await assert.rejects(
      new Client(PARAMETERS).open() as Promise<Client>,
      (error: unknown) => error === clientStop,
    );
  } finally {
    restoreClient();
  }

  const restorePool = bindPoolDestinationOwnerFactory({
    create(context) {
      poolContexts.push(context);
      throw poolStop;
    },
  });
  try {
    assert.throws(
      () => new Pool({
        connectionParameters: PARAMETERS,
        poolOptions: { low: 0, high: 1 },
      }).monitor(),
      (error) => error === poolStop,
    );
  } finally {
    restorePool();
  }

  for (const [context] of [clientContexts, poolContexts]) {
    assert.equal(context?.connection.host, "application.fixture.invalid");
    assert.equal(context?.connection.applicationServerHost, "application.fixture.invalid");
    assert.equal(typeof context?.sessionFactory?.open, "function");
    assert.equal(Object.isFrozen(context?.sessionFactory), true);
  }
});

test("Client transfers a hidden ticket credential without synthesizing a password", async () => {
  const ticket = ["AjQx", "MDM="].join("");
  const parameters = Object.freeze({
    ashost: "application.fixture.invalid",
    sysnr: "00",
    client: "001",
    user: "fixture-user",
    mysapsso2: ticket,
  });
  const planned = planCompatibilityOwnerRoute(parameters);
  assert.equal(planned.kind, "direct");
  assert.equal(planned.connection.ticket, ticket);
  assert.equal("password" in planned.connection, false);

  const client = new Client(parameters);
  assert.equal(client.config.connectionParameters.mysapsso2, ticket);
  assert.equal(JSON.stringify(client.config).includes(ticket), false);
  assert.equal(inspect(client.config).includes(ticket), false);

  let captured: DirectCompatibilityOwnerFactoryContext | undefined;
  const stopped = new Error("ticket owner creation stopped before I/O");
  const restore = bindClientDestinationOwnerFactory({
    create(context) {
      captured = context;
      throw stopped;
    },
  });
  try {
    await assert.rejects(client.open() as Promise<Client>, (error) => error === stopped);
  } finally {
    restore();
  }
  assert.equal(captured?.connection.ticket, ticket);
  assert.equal("password" in (captured?.connection ?? {}), false);
});
