import assert from "node:assert/strict";
import { inspect, types as nodeUtilTypes } from "node:util";
import test from "node:test";

import { normalizeDirectConnectionParameters } from "../src/compat/connection-parameters.js";
import {
  assertConnectionRouteCapabilities,
  MissingConnectionProviderCapabilitiesError,
  planConnectionRoute,
  type ConnectionProviderCapability,
} from "../src/compat/connection-route.js";

const namedUser = Object.freeze({
  client: "001",
  user: "RFCUSER",
  passwd: ["named-user", "secret"].join("-"),
});

test("plans direct RFC with the existing normalization contract", () => {
  const input = {
    ASHOST: "application.example.test",
    GWHOST: "gateway.example.test",
    GWSERV: "sapgw01",
    SYSNR: 1,
    CLIENT: 7,
    USER: "RFCUSER",
    PASSWD: ["named-user", "secret"].join("-"),
    LANG: "en-US",
    CPIC_STREAMING: "enabled",
  };
  const legacy = normalizeDirectConnectionParameters(input);
  const plan = planConnectionRoute(input);

  assert.deepEqual(plan.route, {
    kind: "direct",
    host: legacy.host,
    applicationServerHost: legacy.applicationServerHost,
    port: legacy.port,
    applicationServerService: legacy.applicationServerService,
    sysnr: legacy.sysnr,
    cpicStreaming: legacy.cpicStreaming,
  });
  assert.deepEqual(plan.logon, {
    client: legacy.client,
    language: legacy.language,
  });
  assert.equal(plan.authentication.kind, "named-user");
  assert.equal(plan.authentication.user, legacy.user);
  assert.equal(plan.authentication.password, legacy.password);
  assert.deepEqual(plan.requiredProviderCapabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
  ]);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.route));
  assert.ok(Object.isFrozen(plan.logon));
  assert.ok(Object.isFrozen(plan.authentication));
  assert.ok(Object.isFrozen(plan.requiredProviderCapabilities));
});

test("uses the pinned direct then message-server then WebSocket precedence", () => {
  const direct = planConnectionRoute({
    ...namedUser,
    ashost: "direct.example.test",
    mshost: "message.example.test",
    msserv: "sapmsQAS",
    sysid: "QAS",
    group: "PUBLIC",
    wshost: "websocket.example.test",
    wsport: 443,
  });
  assert.equal(direct.route.kind, "direct");

  const messageServer = planConnectionRoute({
    ...namedUser,
    mshost: "message.example.test",
    sysid: "QAS",
    group: "PUBLIC",
    wshost: "websocket.example.test",
    wsport: 443,
  });
  assert.deepEqual(messageServer.route, {
    kind: "message-server",
    messageServerHost: "message.example.test",
    systemId: "QAS",
    group: "PUBLIC",
  });
});

test("plans all unchanged message-server fields without claiming a provider", () => {
  const plan = planConnectionRoute({
    ...namedUser,
    mshost: "message.example.test",
    msserv: "sapmsQAS",
    sysid: "QAS",
    group: "RFC_GROUP",
    lang: "de",
  });

  assert.deepEqual(plan.route, {
    kind: "message-server",
    messageServerHost: "message.example.test",
    messageServerService: "sapmsQAS",
    systemId: "QAS",
    group: "RFC_GROUP",
  });
  assert.deepEqual(plan.logon, { client: "001", language: "D" });
  assert.deepEqual(plan.requiredProviderCapabilities, [
    "message-server-rfc-transport",
    "named-user-authentication",
  ]);
  assert.throws(
    () => assertConnectionRouteCapabilities(plan, new Set()),
    (error: unknown) => {
      assert.ok(error instanceof MissingConnectionProviderCapabilitiesError);
      assert.equal(error.code, "ERR_OPEN_RFC_CONNECTION_PROVIDER_CAPABILITY");
      assert.deepEqual(error.missingCapabilities, [
        "message-server-rfc-transport",
        "named-user-authentication",
      ]);
      return true;
    },
  );
});

test("accepts r3name directly and gives it precedence over sysid", () => {
  const preferred = planConnectionRoute({
    ...namedUser,
    mshost: "message.example.test",
    r3name: "QAS",
    sysid: "IGN",
    group: "PUBLIC",
  });
  assert.equal(preferred.route.kind, "message-server");
  if (preferred.route.kind !== "message-server") assert.fail("message route");
  assert.equal(preferred.route.systemId, "QAS");

  const fallback = planConnectionRoute({
    ...namedUser,
    mshost: "message.example.test",
    sysid: "QAS",
    group: "PUBLIC",
  });
  assert.equal(fallback.route.kind, "message-server");
  if (fallback.route.kind !== "message-server") assert.fail("message route");
  assert.equal(fallback.route.systemId, "QAS");
});

test("plans WebSocket host and optional numeric port as a distinct transport", () => {
  const withPort = planConnectionRoute({
    ...namedUser,
    wshost: "websocket.example.test",
    wsport: "443",
  });
  assert.deepEqual(withPort.route, {
    kind: "websocket",
    host: "websocket.example.test",
    port: 443,
  });
  assert.deepEqual(withPort.requiredProviderCapabilities, [
    "websocket-rfc-transport",
    "named-user-authentication",
  ]);

  const withoutPort = planConnectionRoute({
    ...namedUser,
    wshost: "websocket.example.test",
  });
  assert.deepEqual(withoutPort.route, {
    kind: "websocket",
    host: "websocket.example.test",
  });
});

test("keeps a validated SAProuter route string opaque and provider-gated", () => {
  const routeString = "/H/router.example.test/S/3299/W/router-secret/H/";
  const plan = planConnectionRoute({
    ...namedUser,
    ashost: "application.example.test",
    gwhost: "gateway.example.test",
    gwserv: "sapgw01",
    sysnr: "01",
    saprouter: routeString,
  });

  assert.equal(plan.sapRouter?.routeString, routeString);
  assert.equal(plan.route.kind, "direct");
  if (plan.route.kind !== "direct") assert.fail("expected direct route");
  assert.equal(plan.route.host, "gateway.example.test");
  assert.equal(plan.route.port, 3_301);
  assert.equal(plan.route.applicationServerHost, "application.example.test");
  assert.deepEqual(plan.requiredProviderCapabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
  ]);
  assert.doesNotMatch(inspect(plan, { depth: null }), /router-secret/u);
  assert.doesNotMatch(JSON.stringify(plan), /router-secret/u);

  for (const invalid of [
    "router.example.test",
    "/h/router.example.test/H/application.example.test",
    "/H/x/H/application.example.test",
    "/H/router.example.test/S/",
    "/H/router.example.test/W/secret",
    "/H/router.example.test/X/value/H/application.example.test",
    "/H/router.example.test/P/legacy-secret/H/",
    "/H/router.example.test",
    "/H/router.example.test/H/application.example.test/S/sapgw01",
  ]) {
    assert.throws(
      () => planConnectionRoute({
        ...namedUser,
        ashost: "application.example.test",
        saprouter: invalid,
      }),
      /saprouter must be a valid SAProuter route prefix/u,
    );
  }
});

test("rejects SAProuter with a selected WebSocket route", () => {
  assert.throws(
    () => planConnectionRoute({
      ...namedUser,
      wshost: "websocket.example.test",
      saprouter: "/H/router.example.test/H/",
    }),
    /saprouter cannot be combined with WebSocket RFC/u,
  );
});

test("requires a distinct capability for message-server over SAProuter", () => {
  const plan = planConnectionRoute({
    ...namedUser,
    mshost: "message.example.test",
    msserv: "3600",
    sysid: "QAS",
    group: "PUBLIC",
    saprouter: "/H/router.example.test/S/3299/H/",
  });
  assert.deepEqual(plan.requiredProviderCapabilities, [
    "message-server-rfc-transport",
    "named-user-authentication",
    "saprouter-routing",
    "message-server-saprouter-routing",
  ]);
  assert.throws(
    () => assertConnectionRouteCapabilities(plan, new Set([
      "message-server-rfc-transport",
      "named-user-authentication",
      "saprouter-routing",
    ])),
    (error: unknown) =>
      error instanceof MissingConnectionProviderCapabilitiesError &&
      error.missingCapabilities.length === 1 &&
      error.missingCapabilities[0] === "message-server-saprouter-routing",
  );
});

test("plans Connectivity proxy authorization, tenant, and location fields immutably", () => {
  const source: Record<string, unknown> = {
    ...namedUser,
    ashost: "virtual-application.test",
    connectivity_proxy_host: "connectivity-proxy.internal",
    connectivity_proxy_port: "20001",
    connectivity_proxy_authentication: "Bearer proxy-secret",
    connectivity_subaccount: "tenant-a",
    connectivity_location_id: "location-a",
  };
  const plan = planConnectionRoute(source);
  source.connectivity_proxy_authentication = "Bearer changed";
  source.connectivity_subaccount = "tenant-b";

  assert.equal(plan.connectivityProxy?.host, "connectivity-proxy.internal");
  assert.equal(plan.connectivityProxy?.port, 20001);
  assert.equal(plan.connectivityProxy?.authorization, "Bearer proxy-secret");
  assert.equal(plan.connectivityProxy?.subaccount, "tenant-a");
  assert.equal(plan.connectivityProxy?.locationId, "location-a");
  assert.ok(Object.isFrozen(plan.connectivityProxy));
  assert.deepEqual(plan.requiredProviderCapabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "connectivity-rfc-proxy",
    "connectivity-proxy-authorization",
  ]);
  assert.doesNotMatch(inspect(plan, { depth: null }), /proxy-secret/u);
  assert.doesNotMatch(JSON.stringify(plan), /proxy-secret/u);
});

test("plans business-user principal propagation without named-user credentials", () => {
  const token = ["business-user-token", "secret"].join("-");
  const plan = planConnectionRoute({
    ashost: "virtual-application.test",
    client: "001",
    business_user_token: token,
    connectivity_proxy_host: "connectivity-proxy.internal",
    connectivity_proxy_port: 20001,
    connectivity_proxy_authentication: "Bearer proxy-secret",
    connectivity_subaccount: "tenant-a",
  });

  assert.equal(plan.authentication.kind, "principal-propagation");
  assert.equal(plan.authentication.businessUserToken, token);
  assert.deepEqual(plan.requiredProviderCapabilities, [
    "direct-rfc-transport",
    "principal-propagation",
    "connectivity-rfc-proxy",
    "connectivity-proxy-authorization",
  ]);
  assert.doesNotMatch(inspect(plan, { depth: null }), /business-user-token-secret|proxy-secret/u);
  assert.doesNotMatch(JSON.stringify(plan), /business-user-token-secret|proxy-secret/u);
});

test("fails closed for conflicting, incomplete, or unsupported authentication and proxy inputs", () => {
  const base = { ashost: "application.example.test", client: "001" };
  const cases: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
    [{ ...base, user: "RFCUSER" }, /user and passwd must be supplied together/u],
    [{ ...base, passwd: "secret" }, /user and passwd must be supplied together/u],
    [{ ...base, ...namedUser, business_user_token: "business-secret" }, /business_user_token cannot be combined with user or passwd/u],
    [{ ...base, business_user_token: "business-secret" }, /business_user_token requires a Connectivity proxy route/u],
    [{ ...base, ...namedUser, connectivity_proxy_host: "proxy.internal" }, /connectivity_proxy_host and connectivity_proxy_port must be supplied together/u],
    [{ ...base, ...namedUser, connectivity_proxy_port: 20001 }, /connectivity_proxy_host and connectivity_proxy_port must be supplied together/u],
    [{ ...base, ...namedUser, connectivity_subaccount: "tenant-a" }, /Connectivity proxy options require connectivity_proxy_host and connectivity_proxy_port/u],
    [{ ...base, ...namedUser, connectivity_location_id: "location-a" }, /Connectivity proxy options require connectivity_proxy_host and connectivity_proxy_port/u],
    [{ ...base, ...namedUser, connectivity_proxy_authentication: "Bearer proxy-secret" }, /Connectivity proxy options require connectivity_proxy_host and connectivity_proxy_port/u],
  ];

  for (const [input, expected] of cases) {
    let error: unknown;
    try {
      planConnectionRoute(input);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /named-user-secret|business-secret|proxy-secret/u);
  }
});

test("rejects unknown, inherited, accessor, proxy, symbol, and duplicate inputs before planning", () => {
  assert.throws(
    () => planConnectionRoute({ ...namedUser, ashost: "application.example.test", timeout: 10 }),
    /unknown RFC connection parameter timeout/u,
  );
  assert.throws(
    () => planConnectionRoute({
      ...namedUser,
      ashost: "application.example.test",
      r3name: "QAS",
    }),
    /r3name requires a selected mshost route/u,
  );
  assert.throws(
    () => planConnectionRoute({
      ...namedUser,
      ashost: "application.example.test",
      connectivity_proxy_authorization: "Bearer secret",
    }),
    /unknown RFC connection parameter connectivity_proxy_authorization/u,
  );

  const inherited = Object.assign(
    Object.create({ ashost: "inherited.example.test" }) as Record<string, unknown>,
    namedUser,
  );
  assert.throws(
    () => planConnectionRoute(inherited),
    /RFC connection parameters must not have a custom prototype/u,
  );

  let getterCalls = 0;
  const accessor: Record<string, unknown> = { ...namedUser };
  Object.defineProperty(accessor, "ashost", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "application.example.test";
    },
  });
  assert.throws(
    () => planConnectionRoute(accessor),
    /ashost must be an own data property/u,
  );
  assert.equal(getterCalls, 0);

  let trapCalls = 0;
  const proxied = new Proxy({
    ...namedUser,
    ashost: "application.example.test",
  }, {
    getPrototypeOf(target) {
      trapCalls += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCalls += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.equal(nodeUtilTypes.isProxy(proxied), true);
  assert.throws(
    () => planConnectionRoute(proxied),
    /RFC connection parameters must not be a Proxy/u,
  );
  assert.equal(trapCalls, 0);

  const withSymbol = {
    ...namedUser,
    ashost: "application.example.test",
    [Symbol("hidden")]: "value",
  };
  assert.throws(
    () => planConnectionRoute(withSymbol),
    /RFC connection parameter keys must be strings/u,
  );

  assert.throws(
    () => planConnectionRoute({
      ...namedUser,
      ashost: "application.example.test",
      ASHOST: "application.example.test",
    }),
    /duplicate RFC connection parameter ashost/u,
  );
  assert.throws(
    () => planConnectionRoute({
      ...namedUser,
      ashost: "one.example.test",
      ASHOST: "two.example.test",
    }),
    /duplicate RFC connection parameter ashost/u,
  );
});

test("rejects missing or malformed route-specific fields before provider selection", () => {
  const cases: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
    [{ ...namedUser }, /one of ashost, mshost, or wshost is required/u],
    [{ ...namedUser, msserv: "sapmsQAS", sysid: "QAS", group: "PUBLIC" }, /msserv requires a selected mshost route/u],
    [{ ...namedUser, mshost: "message.example.test", group: "PUBLIC" }, /sysid is required for a message-server route/u],
    [{ ...namedUser, mshost: "message.example.test", sysid: "QAS" }, /group is required for a message-server route/u],
    [{ ...namedUser, mshost: "message.example.test", sysid: "TOOLONG", group: "PUBLIC" }, /sysid must be a three-character SAP system ID/u],
    [{ ...namedUser, wshost: "websocket.example.test", wsport: 0 }, /wsport must be an integer in 1\.\.65535/u],
    [{ ...namedUser, wsport: 443 }, /wsport requires a selected wshost route/u],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => planConnectionRoute(input), expected);
  }
});

test("capability admission returns no transport and reveals no connection secrets", () => {
  const plan = planConnectionRoute({
    ...namedUser,
    ashost: "application.example.test",
  });
  const all = new Set<ConnectionProviderCapability>(plan.requiredProviderCapabilities);
  assert.doesNotThrow(() => assertConnectionRouteCapabilities(plan, all));
  assert.equal("connect" in plan, false);
  assert.equal("open" in plan, false);

  const missingNamedUser = new Set<ConnectionProviderCapability>([
    "direct-rfc-transport",
  ]);
  let error: unknown;
  try {
    assertConnectionRouteCapabilities(plan, missingNamedUser);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.doesNotMatch(inspect(error, { depth: null }), /named-user-secret/u);
});
