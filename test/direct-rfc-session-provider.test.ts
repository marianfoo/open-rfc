import assert from "node:assert/strict";
import test from "node:test";

import type { DirectCpicTransportFactory } from "../src/client/direct-cpic-session.js";
import type { DirectDestinationOwner } from "../src/destination/direct-destination-owner.js";
import { createDirectRfcSessionProvider } from "../src/compat/direct-rfc-session-provider.js";
import {
  planConnectionRoute,
  type ConnectivitySocks5Plan,
} from "../src/compat/connection-route.js";
import type {
  RFCClientDestinationOwnerFactoryContext,
} from "../src/compat/rfc-client-owner-registry.js";
import {
  bindRFCClientDestinationOwnerFactory,
  resolveRFCClientDestinationOwnerFactory,
} from "../src/compat/rfc-client-owner-registry.js";

const ROUTE =
  "/H/router.fixture.invalid/S/3299/H/";

function fakeOwner(events: string[]): DirectDestinationOwner {
  return {
    async retire() {
      events.push("owner:retire");
    },
    async getFunctionInterface() {
      throw new Error("metadata was not expected");
    },
    async getStructureDefinition() {
      throw new Error("metadata was not expected");
    },
  } as unknown as DirectDestinationOwner;
}

function directPlan(extra: Readonly<Record<string, unknown>> = {}) {
  return planConnectionRoute({
    ashost: "application.fixture.invalid",
    sysnr: "00",
    client: "001",
    user: "fixture-user",
    passwd: ["fixture", "secret"].join("-"),
    lang: "E",
    ...extra,
  });
}

test("advertises and injects SAProuter only with a concrete transport", async () => {
  const events: string[] = [];
  const contexts: Array<RFCClientDestinationOwnerFactoryContext | undefined> = [];
  const routeStrings: string[] = [];
  const markerTransport = (async () => {
    throw new Error("marker transport must stay lazy");
  }) as DirectCpicTransportFactory;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory(connection, context) {
      assert.deepEqual(connection, {
        host: "application.fixture.invalid",
        applicationServerHost: "application.fixture.invalid",
        port: 3_300,
        applicationServerService: "sapdp00",
        client: "001",
        user: "fixture-user",
        password: ["fixture", "secret"].join("-"),
        language: "E",
        sysnr: "00",
        cpicStreaming: "disabled",
      });
      contexts.push(context);
      return fakeOwner(events);
    },
    sapRouterTransportFactory(routeString) {
      routeStrings.push(routeString);
      return markerTransport;
    },
  });

  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
  ]);
  const session = await provider.open(directPlan({ saprouter: ROUTE }));
  assert.deepEqual(routeStrings, [ROUTE]);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.session?.transportFactory, markerTransport);
  assert.equal(Object.isFrozen(contexts[0]), true);
  assert.equal(Object.isFrozen(contexts[0]?.session), true);
  assert.equal(session.connectionInfo.host, "application.fixture.invalid");
  assert.equal(session.connectionInfo.language, "E");
  assert.equal(session.connectionInfo.isoLanguage, "EN");
  assert.equal(session.connectionInfo.sysId, "");
  assert.equal(session.connectionInfo.rel, "");
  assert.equal(session.connectionInfo.partnerRel, "");
  assert.equal(session.connectionInfo.kernelRel, "");
  assert.equal(session.connectionInfo.cpicConvId, "");
  await session.close();
  assert.deepEqual(events, ["owner:retire"]);
});

test("rejects SAProuter before owner creation when no transport is composed", async () => {
  let ownerCreations = 0;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory() {
      ownerCreations += 1;
      return fakeOwner([]);
    },
  });
  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
  ]);
  await assert.rejects(
    provider.open(directPlan({ saprouter: ROUTE })),
    /does not implement SAProuter/u,
  );
  assert.equal(ownerCreations, 0);
});

test("advertises and injects Connectivity SOCKS5 only with a concrete transport", async () => {
  const contexts: Array<RFCClientDestinationOwnerFactoryContext | undefined> = [];
  const proxyPlans: ConnectivitySocks5Plan[] = [];
  const markerTransport = (async () => {
    throw new Error("marker transport must stay lazy");
  }) as DirectCpicTransportFactory;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory(_connection, context) {
      contexts.push(context);
      return fakeOwner([]);
    },
    connectivitySocks5TransportFactory(plan) {
      proxyPlans.push(plan);
      return markerTransport;
    },
  });
  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "connectivity-socks5-tcp",
  ]);

  const session = await provider.open(directPlan({
    gwhost: "virtual-gateway.invalid",
    connectivity_socks5_proxy_host: "proxy.fixture.invalid",
    connectivity_socks5_proxy_port: 20_004,
    connectivity_socks5_access_token: ["connectivity", "token", "fixture"].join("-"),
    connectivity_socks5_location_id: "location-a",
  }));
  assert.equal(proxyPlans.length, 1);
  assert.equal(proxyPlans[0]?.host, "proxy.fixture.invalid");
  assert.equal(proxyPlans[0]?.port, 20_004);
  assert.equal(proxyPlans[0]?.locationId, "location-a");
  assert.equal(contexts[0]?.session?.transportFactory, markerTransport);
  await session.close();
});

test("rejects Connectivity SOCKS5 before owner creation when no transport is composed", async () => {
  let ownerCreations = 0;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory() {
      ownerCreations += 1;
      return fakeOwner([]);
    },
  });
  await assert.rejects(
    provider.open(directPlan({
      connectivity_socks5_proxy_host: "proxy.fixture.invalid",
      connectivity_socks5_proxy_port: 20_004,
      connectivity_socks5_access_token: "fixture-token",
    })),
    /does not implement Connectivity SOCKS5/u,
  );
  assert.equal(ownerCreations, 0);
});

test("rejects invalid route transport composition before owner creation", async () => {
  let ownerCreations = 0;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory() {
      ownerCreations += 1;
      return fakeOwner([]);
    },
    sapRouterTransportFactory: () => 1 as never,
  });
  await assert.rejects(
    provider.open(directPlan({ saprouter: ROUTE })),
    /must return a transport function/u,
  );
  assert.equal(ownerCreations, 0);
});

test("rejects a forged SAProuter plus Connectivity plan before transport I/O", async () => {
  let transportCreations = 0;
  let ownerCreations = 0;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory() {
      ownerCreations += 1;
      return fakeOwner([]);
    },
    sapRouterTransportFactory() {
      transportCreations += 1;
      return (async () => undefined) as never;
    },
    connectivitySocks5TransportFactory() {
      transportCreations += 1;
      return (async () => undefined) as never;
    },
  });
  const sapRouterPlan = directPlan({ saprouter: ROUTE });
  const socksPlan = directPlan({
    connectivity_socks5_proxy_host: "proxy.fixture.invalid",
    connectivity_socks5_proxy_port: 20_004,
    connectivity_socks5_access_token: "fixture-token",
  });
  const forged = Object.freeze({
    ...sapRouterPlan,
    connectivitySocks5: socksPlan.connectivitySocks5,
  });

  await assert.rejects(
    provider.open(forged),
    /cannot combine SAProuter and Connectivity SOCKS5/u,
  );
  assert.equal(transportCreations, 0);
  assert.equal(ownerCreations, 0);
});

test("rejects unsupported Connectivity before route or owner I/O", async () => {
  let routeCreations = 0;
  let ownerCreations = 0;
  const provider = createDirectRfcSessionProvider({
    operationTimeoutMs: 1_000,
    ownerFactory() {
      ownerCreations += 1;
      return fakeOwner([]);
    },
    sapRouterTransportFactory() {
      routeCreations += 1;
      return (async () => {
        throw new Error("transport must not run");
      }) as DirectCpicTransportFactory;
    },
  });
  await assert.rejects(
    provider.open(directPlan({
      saprouter: ROUTE,
      connectivity_proxy_host: "proxy.fixture.invalid",
      connectivity_proxy_port: "20001",
    })),
    /does not implement Connectivity/u,
  );
  assert.equal(routeCreations, 0);
  assert.equal(ownerCreations, 0);
});

test("owner-factory bindings preserve the route-specific session context", async () => {
  const client = {};
  const contexts: Array<RFCClientDestinationOwnerFactoryContext | undefined> = [];
  bindRFCClientDestinationOwnerFactory(client, (_connection, context) => {
    contexts.push(context);
    return fakeOwner([]);
  });
  const fallback = () => {
    throw new Error("bound owner factory was not resolved");
  };
  const factory = resolveRFCClientDestinationOwnerFactory(client, fallback);
  const plan = directPlan();
  assert.equal(plan.route.kind, "direct");
  const markerTransport = (async () => {
    throw new Error("marker transport must stay lazy");
  }) as DirectCpicTransportFactory;
  const context = Object.freeze({
    session: Object.freeze({ transportFactory: markerTransport }),
  });
  await factory({
    host: plan.route.host,
    applicationServerHost: plan.route.applicationServerHost,
    port: plan.route.port,
    applicationServerService: plan.route.applicationServerService,
    client: plan.logon.client,
    user: "fixture-user",
    password: ["fixture", "secret"].join("-"),
    language: plan.logon.language,
    sysnr: plan.route.sysnr,
    cpicStreaming: plan.route.cpicStreaming,
  }, context);
  assert.deepEqual(contexts, [context]);
});
