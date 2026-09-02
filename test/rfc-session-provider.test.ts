import assert from "node:assert/strict";
import test from "node:test";

import { RFCClient } from "../src/compat/node-rfc-library.js";
import {
  bindRFCClientSessionProvider,
  resolveRFCClientSessionProvider,
} from "../src/compat/rfc-session-provider-registry.js";
import { bindRfcSessionProvider } from
  "../src/compat/rfc-session-provider-binding.js";
import type {
  RfcSession,
  RfcSessionProvider,
  RfcSessionTransaction,
} from "../src/compat/rfc-session-provider.js";
import {
  bindRFCClientDestinationOwnerFactory,
  resolveRFCClientDestinationOwnerFactory,
} from "../src/compat/rfc-client-owner-registry.js";
import {
  planRFCClientSessionRoute,
  UNPLANNED_SEMANTIC_RFC_PARAMETERS,
} from
  "../src/compat/rfc-client-session-route.js";
import {
  assertConnectionRouteCapabilities,
  type ConnectionRoutePlan,
} from "../src/compat/connection-route.js";
import {
  MetadataAccessFailure,
} from "../src/metadata/repository-runtime.js";
import {
  normalizeRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../src/metadata/recursive-metadata.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";

const MESSAGE_SERVER_PARAMETERS = Object.freeze({
  mshost: "message.fixture.invalid",
  msserv: "sapmsQAS",
  sysid: "QAS",
  group: "PUBLIC",
  client: "1",
  user: "fixture-user",
  passwd: ["fixture", "secret"].join("-"),
  lang: "en",
});

function recursiveProviderGraph(
  functionName = "Z_PROVIDER_RECURSIVE",
): RecursiveMetadataGraph {
  const row = (options: {
    readonly typeName: string;
    readonly fieldName: string;
    readonly fieldType: string;
    readonly internalType: string;
    readonly componentType?: string;
    readonly dataType?: string;
    readonly total: number;
    readonly offset: number;
    readonly length: number;
  }): Record<string, unknown> => ({
    TYPENAME: options.typeName,
    FIELDNAME: options.fieldName,
    COMPTYPE: options.componentType ?? "E",
    FIELDTYPE: options.fieldType,
    DATATYPE: options.dataType ?? "CHAR",
    TABLENGTH: String(options.total).padStart(6, "0"),
    TABLENGTH_UC: String(options.total).padStart(6, "0"),
    DESCRIPTION: "",
    DECIMALS: "000000",
    INTTYPE: options.internalType,
    OFFSET: String(options.offset).padStart(6, "0"),
    OFFSET_UC: String(options.offset).padStart(6, "0"),
    INTLEN: String(options.length).padStart(6, "0"),
    INTLEN_UC: String(options.length).padStart(6, "0"),
    TIMESTAMP: "20260716112233",
  });
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: functionName,
      BASXML_SUPPORTED: "X",
      UDAT: "20260716",
      UTIME: "112233",
    }],
    DATATYPESCONT: [
      row({
        typeName: "Z_PROVIDER_ROOT", fieldName: "CHILD",
        fieldType: "Z_PROVIDER_CHILD", internalType: "u",
        componentType: "S", dataType: "STRU", total: 24, offset: 0,
        length: 8,
      }),
      row({
        typeName: "Z_PROVIDER_ROOT", fieldName: "ROWS",
        fieldType: "Z_PROVIDER_TABLE", internalType: "h",
        componentType: "T", dataType: "TTYP", total: 24, offset: 8,
        length: 8,
      }),
      row({
        typeName: "Z_PROVIDER_ROOT", fieldName: "PAYLOAD",
        fieldType: "RAWSTRING", internalType: "y", dataType: "RSTR",
        total: 24, offset: 16, length: 8,
      }),
      row({
        typeName: "Z_PROVIDER_CHILD", fieldName: "COUNT",
        fieldType: "INT4", internalType: "I", dataType: "INT4",
        total: 4, offset: 0, length: 4,
      }),
      row({
        typeName: "Z_PROVIDER_TABLE", fieldName: "",
        fieldType: "Z_PROVIDER_ROW", internalType: "u",
        componentType: "S", dataType: "STRU", total: 8, offset: 0,
        length: 8,
      }),
      row({
        typeName: "Z_PROVIDER_ROW", fieldName: "BLOB",
        fieldType: "RAWSTRING", internalType: "y", dataType: "RSTR",
        total: 8, offset: 0, length: 8,
      }),
    ],
    INDIRECTTYPES: [],
    PARAMETERS: [{
      FUNCNAME: functionName,
      PARAMCLASS: "E",
      PARAMETER: "RESULT",
      TABNAME: "Z_PROVIDER_ROOT",
      FIELDNAME: "",
      EXID: "u",
      POSITION: 0,
      OFFSET: 0,
      INTLENGTH: 24,
      DECIMALS: 0,
      DEFAULT: "",
      PARAMTEXT: "Recursive result",
      OPTIONAL: "",
    }],
  });
}

function flatProviderFunction(name: string): RfcFunctionInterface {
  return Object.freeze({
    name,
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([Object.freeze({
      parameterClass: "I",
      parameterName: "VALUE",
      tableName: "",
      fieldName: "",
      exid: "I",
      position: 1,
      offset: 0,
      internalLength: 4,
      decimals: 0,
      defaultValue: "",
      parameterText: "",
      optional: true,
    })]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
}

function fakeTransaction(
  name: string,
  events: string[],
): RfcSessionTransaction {
  let terminal = false;
  const transaction: RfcSessionTransaction = {
    async ready() {
      assert.equal(this, transaction);
      events.push(`${name}:ready`);
    },
    async call(functionName, parameters, options) {
      assert.equal(this, transaction);
      assert.equal(terminal, false);
      events.push(`${name}:call:${functionName}`);
      return Object.freeze({
        ...parameters,
        NOT_REQUESTED: options.notRequested ?? Object.freeze([]),
      });
    },
    async commit() {
      assert.equal(this, transaction);
      assert.equal(terminal, false);
      terminal = true;
      events.push(`${name}:commit`);
    },
    async rollback() {
      assert.equal(this, transaction);
      assert.equal(terminal, false);
      terminal = true;
      events.push(`${name}:rollback`);
    },
    async close() {
      assert.equal(this, transaction);
      terminal = true;
      events.push(`${name}:close`);
    },
    isTerminal() {
      assert.equal(this, transaction);
      return terminal;
    },
  };
  return Object.freeze(transaction);
}

function fakeSession(
  events: string[],
  options: {
    readonly getFunctionInterface?: (
      functionName: string,
      signal?: AbortSignal,
    ) => Promise<RfcFunctionInterface>;
    readonly getRecursiveFunctionMetadata?: (
      functionName: string,
      signal?: AbortSignal,
    ) => Promise<RecursiveMetadataGraph>;
  } = {},
): RfcSession {
  let transactionNumber = 0;
  let closed = false;
  const session: RfcSession = {
    connectionInfo: Object.freeze({
      host: "selected-application.fixture.invalid",
      sysId: "QAS",
      client: "001",
      user: "fixture-user",
    }),
    beginTransaction() {
      assert.equal(this, session);
      assert.equal(closed, false);
      transactionNumber += 1;
      events.push(`begin:${transactionNumber}`);
      return fakeTransaction(`transaction:${transactionNumber}`, events);
    },
    async getFunctionInterface(functionName, signal) {
      assert.equal(this, session);
      if (options.getFunctionInterface !== undefined) {
        return options.getFunctionInterface(functionName, signal);
      }
      throw new Error("metadata was not expected when validation is disabled");
    },
    async getStructureDefinition() {
      throw new Error("metadata was not expected in this fixture");
    },
    async close() {
      assert.equal(this, session);
      closed = true;
      events.push("session:close");
    },
    ...(options.getRecursiveFunctionMetadata === undefined
      ? {}
      : {
          async getRecursiveFunctionMetadata(
            functionName: string,
            signal?: AbortSignal,
          ): Promise<RecursiveMetadataGraph> {
            assert.equal(this, session);
            return options.getRecursiveFunctionMetadata!(functionName, signal);
          },
        }),
  };
  return Object.freeze(session);
}

test("RFCClient delegates a planned message-server route to an admitted session provider", async () => {
  const events: string[] = [];
  const plans: unknown[] = [];
  const session = fakeSession(events);
  const provider: RfcSessionProvider = Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open(plan: ConnectionRoutePlan) {
      assert.equal(this, provider);
      plans.push(plan);
      events.push("provider:open");
      return session;
    },
  });
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, provider);

  const connection = await client.open(MESSAGE_SERVER_PARAMETERS);
  assert.equal(plans.length, 1);
  const plan = plans[0] as {
    readonly route: Readonly<Record<string, unknown>>;
    readonly authentication: Readonly<Record<string, unknown>>;
  };
  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(plan.route, {
    kind: "message-server",
    messageServerHost: "message.fixture.invalid",
    messageServerService: "sapmsQAS",
    systemId: "QAS",
    group: "PUBLIC",
  });
  assert.equal(plan.authentication.kind, "named-user");

  const first = await connection.execute(
    "Z_PROVIDER_FIRST",
    { import: { VALUE: 1 } },
    false,
    ["IGNORED"],
  );
  assert.deepEqual(first, { VALUE: 1, NOT_REQUESTED: ["IGNORED"] });
  await connection.commit();
  await connection.execute("Z_PROVIDER_SECOND", {}, false);
  await connection.close();

  assert.deepEqual(events, [
    "provider:open",
    "begin:1",
    "transaction:1:ready",
    "transaction:1:call:Z_PROVIDER_FIRST",
    "transaction:1:commit",
    "begin:2",
    "transaction:2:ready",
    "transaction:2:call:Z_PROVIDER_SECOND",
    "transaction:2:close",
    "session:close",
  ]);
  assert.deepEqual(connection.connectionInfo, new Error("RFC connection is closed"));
});

test("public getMetadata projects recursive structures, tables, and XSTRING without flat lookups", async () => {
  const events: string[] = [];
  const graph = recursiveProviderGraph();
  let recursiveCalls = 0;
  let flatCalls = 0;
  const session = fakeSession(events, {
    async getRecursiveFunctionMetadata(functionName: string) {
      recursiveCalls += 1;
      assert.equal(functionName, "Z_PROVIDER_RECURSIVE");
      return graph;
    },
    async getFunctionInterface() {
      flatCalls += 1;
      throw new Error("flat metadata must not run after recursive success");
    },
  });
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open() { return session; },
  }));
  const connection = await client.open(MESSAGE_SERVER_PARAMETERS);

  const metadata = await connection.getMetadata("Z_PROVIDER_RECURSIVE");
  assert.equal(metadata.rfcName, "Z_PROVIDER_RECURSIVE");
  assert.equal(metadata.export.length, 1);
  const result = metadata.export[0]!;
  assert.equal(result.nwrfcType, "RFCTYPE_STRUCTURE");
  assert.equal(result.associatedType, "Z_PROVIDER_ROOT");
  const fields = result.fields as readonly Readonly<Record<string, unknown>>[];
  assert.deepEqual(fields.map((field) => [
    field.name,
    field.nwrfcType,
  ]), [
    ["CHILD", "RFCTYPE_STRUCTURE"],
    ["ROWS", "RFCTYPE_TABLE"],
    ["PAYLOAD", "RFCTYPE_XSTRING"],
  ]);
  const childFields = fields[0]!.fields as readonly Readonly<
    Record<string, unknown>
  >[];
  assert.deepEqual(childFields.map(({ name, nwrfcType }) => ({
    name,
    nwrfcType,
  })), [{ name: "COUNT", nwrfcType: "RFCTYPE_INT" }]);
  const rowFields = fields[1]!.tableFields as readonly Readonly<
    Record<string, unknown>
  >[];
  assert.deepEqual(rowFields.map(({ name, nwrfcType }) => ({
    name,
    nwrfcType,
  })), [{ name: "BLOB", nwrfcType: "RFCTYPE_XSTRING" }]);
  assert.equal(recursiveCalls, 1);
  assert.equal(flatCalls, 0);
  await connection.close();
});

test("public getMetadata falls back only for explicit recursive availability classifications", async () => {
  const cases = [
    [new MetadataAccessFailure("unavailable", "optimized metadata absent"), true],
    [new MetadataAccessFailure("authorization", "optimized metadata denied"), true],
    [new MetadataAccessFailure("malformed", "optimized metadata malformed"), false],
    [new MetadataAccessFailure("communication", "optimized metadata disconnected"), false],
    [new Error("unclassified recursive failure"), false],
  ] as const;

  for (const [failure, shouldFallback] of cases) {
    const events: string[] = [];
    let flatCalls = 0;
    const session = fakeSession(events, {
      async getRecursiveFunctionMetadata() {
        throw failure;
      },
      async getFunctionInterface(functionName: string) {
        flatCalls += 1;
        return flatProviderFunction(functionName);
      },
    });
    const client = new RFCClient();
    bindRFCClientSessionProvider(client, Object.freeze({
      capabilities: Object.freeze([
        "message-server-rfc-transport",
        "named-user-authentication",
      ] as const),
      async open() { return session; },
    }));
    const connection = await client.open(MESSAGE_SERVER_PARAMETERS);

    if (shouldFallback) {
      const metadata = await connection.getMetadata("Z_PROVIDER_FALLBACK");
      assert.equal(metadata.rfcName, "Z_PROVIDER_FALLBACK");
      assert.equal(metadata.import[0]!.name, "VALUE");
      assert.equal(flatCalls, 1);
    } else {
      await assert.rejects(
        connection.getMetadata("Z_PROVIDER_NO_FALLBACK"),
        (error: unknown) => error === failure,
      );
      assert.equal(flatCalls, 0);
    }
    await connection.close();
  }
});

test("public getMetadata preserves an optimized zero-parameter function identity", async () => {
  const events: string[] = [];
  const graph = normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: "Z_PROVIDER_ZERO_PARAMETERS",
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "112233",
    }],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    PARAMETERS: [],
  });
  let flatCalls = 0;
  const session = fakeSession(events, {
    async getRecursiveFunctionMetadata() { return graph; },
    async getFunctionInterface(functionName: string) {
      flatCalls += 1;
      return flatProviderFunction(functionName);
    },
  });
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open() { return session; },
  }));
  const connection = await client.open(MESSAGE_SERVER_PARAMETERS);

  assert.deepEqual(
    await connection.getMetadata("Z_PROVIDER_ZERO_PARAMETERS"),
    {
      rfcName: "Z_PROVIDER_ZERO_PARAMETERS",
      import: [],
      export: [],
      changing: [],
      table: [],
    },
  );
  assert.equal(flatCalls, 0);
  await connection.close();
});

test("a provider without recursive metadata is explicitly unavailable and retains flat compatibility", async () => {
  const events: string[] = [];
  let flatCalls = 0;
  const session = fakeSession(events, {
    async getFunctionInterface(functionName: string) {
      flatCalls += 1;
      return flatProviderFunction(functionName);
    },
  });
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open() { return session; },
  }));
  const connection = await client.open(MESSAGE_SERVER_PARAMETERS);

  const metadata = await connection.getMetadata("Z_PROVIDER_LEGACY_FLAT");
  assert.equal(metadata.rfcName, "Z_PROVIDER_LEGACY_FLAT");
  assert.equal(flatCalls, 1);
  await connection.close();
});

test("projection failures cannot masquerade as optimized authorization fallback", async () => {
  const events: string[] = [];
  const projectionFailure = new MetadataAccessFailure(
    "authorization",
    "hostile graph accessor failure",
  );
  const graph = new Proxy(recursiveProviderGraph("Z_PROVIDER_HOSTILE_GRAPH"), {
    get(target, property, receiver) {
      if (property === "version") throw projectionFailure;
      return Reflect.get(target, property, receiver);
    },
  });
  let flatCalls = 0;
  const session = fakeSession(events, {
    async getRecursiveFunctionMetadata() { return graph; },
    async getFunctionInterface(functionName: string) {
      flatCalls += 1;
      return flatProviderFunction(functionName);
    },
  });
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open() { return session; },
  }));
  const connection = await client.open(MESSAGE_SERVER_PARAMETERS);

  await assert.rejects(
    connection.getMetadata("Z_PROVIDER_HOSTILE_GRAPH"),
    (error: unknown) => error === projectionFailure,
  );
  assert.equal(flatCalls, 0);
  await connection.close();
});

test("production provider rejects WebSocket before the direct owner factory runs", async () => {
  const client = new RFCClient();
  let ownerCreations = 0;
  bindRFCClientDestinationOwnerFactory(client, () => {
    ownerCreations += 1;
    throw new Error("direct owner factory must not run");
  });

  await assert.rejects(
    client.open({
      wshost: "websocket.fixture.invalid",
      client: "001",
      user: "fixture-user",
      passwd: ["fixture", "secret"].join("-"),
      lang: "E",
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(
        (error as Error & { readonly code?: unknown }).code,
        "ERR_OPEN_RFC_CONNECTION_PROVIDER_CAPABILITY",
      );
      assert.deepEqual(
        (error as Error & { readonly missingCapabilities?: unknown })
          .missingCapabilities,
        ["websocket-rfc-transport"],
      );
      return true;
    },
  );
  assert.equal(ownerCreations, 0);
});

test("production provider advertises only its connected route implementations", () => {
  const provider = resolveRFCClientSessionProvider(new RFCClient());
  assert.deepEqual(provider.capabilities, [
    "direct-rfc-transport",
    "named-user-authentication",
    "logon-ticket-authentication",
    "saprouter-routing",
    "connectivity-socks5-tcp",
    "message-server-rfc-transport",
    "message-server-saprouter-routing",
  ]);
});

test("production admits message-server over SAProuter at capability admission", () => {
  const provider = resolveRFCClientSessionProvider(new RFCClient());
  const plan = planRFCClientSessionRoute({
    ...MESSAGE_SERVER_PARAMETERS,
    msserv: "3600",
    saprouter: "/H/router.fixture.invalid/S/3299/H/",
  });
  assert.doesNotThrow(() =>
    assertConnectionRouteCapabilities(plan, new Set(provider.capabilities))
  );
});

test("production provider rejects Connectivity and principal propagation before owner I/O", async () => {
  const client = new RFCClient();
  let ownerCreations = 0;
  bindRFCClientDestinationOwnerFactory(client, () => {
    ownerCreations += 1;
    throw new Error("direct owner factory must not run");
  });

  await assert.rejects(
    client.open({
      ashost: "virtual-application.fixture.invalid",
      client: "001",
      business_user_token: "fixture-business-user-token",
      connectivity_proxy_host: "connectivity.fixture.invalid",
      connectivity_proxy_port: "20001",
      connectivity_proxy_authentication: "Bearer fixture-proxy-token",
    }),
    (error: unknown) => {
      assert.equal(
        (error as Error & { readonly code?: unknown }).code,
        "ERR_OPEN_RFC_CONNECTION_PROVIDER_CAPABILITY",
      );
      assert.deepEqual(
        (error as Error & { readonly missingCapabilities?: unknown })
          .missingCapabilities,
        [
          "principal-propagation",
          "connectivity-rfc-proxy",
          "connectivity-proxy-authorization",
        ],
      );
      return true;
    },
  );
  assert.equal(ownerCreations, 0);
});

test("provider binding snapshots capability admission and never trusts later mutation", async () => {
  const capabilities = ["message-server-rfc-transport"] as Array<
    RfcSessionProvider["capabilities"][number]
  >;
  let opens = 0;
  const provider: RfcSessionProvider = {
    capabilities,
    async open() {
      opens += 1;
      return fakeSession([]);
    },
  };
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, provider);
  capabilities.push("named-user-authentication");

  await assert.rejects(
    client.open(MESSAGE_SERVER_PARAMETERS),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { readonly code?: unknown }).code ===
        "ERR_OPEN_RFC_CONNECTION_PROVIDER_CAPABILITY",
  );
  assert.equal(opens, 0);
});

test("RFCClient closes an admitted session when its initial transaction cannot open", async () => {
  const events: string[] = [];
  const failure = new Error("fixture transaction acquire failed");
  const session: RfcSession = Object.freeze({
    connectionInfo: Object.freeze({}),
    beginTransaction() {
      events.push("begin");
      return Object.freeze({
        async ready() { throw failure; },
        async call() { return Object.freeze({}); },
        async commit() {},
        async rollback() {},
        async close() { events.push("transaction:close"); },
        isTerminal() { return false; },
      });
    },
    async getFunctionInterface() {
      throw new Error("unused");
    },
    async getStructureDefinition() {
      throw new Error("unused");
    },
    async close() {
      events.push("close");
    },
  });
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open() { return session; },
  }));

  await assert.rejects(client.open(MESSAGE_SERVER_PARAMETERS), failure);
  assert.deepEqual(events, ["begin", "transaction:close", "close"]);
});

test("provider binding rejects secret-bearing connection info and retires the raw session", async () => {
  const events: string[] = [];
  const session = {
    connectionInfo: Object.freeze({ password: ["must-never", "escape"].join("-") }),
    beginTransaction() { return fakeTransaction("unused", events); },
    async getFunctionInterface() { throw new Error("unused"); },
    async getStructureDefinition() { throw new Error("unused"); },
    async close() { events.push("raw-session:close"); },
  } satisfies RfcSession;
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([
      "message-server-rfc-transport",
      "named-user-authentication",
    ] as const),
    async open() { return session; },
  }));

  await assert.rejects(
    client.open(MESSAGE_SERVER_PARAMETERS),
    (error: unknown) => {
      assert.equal(error instanceof TypeError, true);
      assert.match((error as Error).message, /must not expose password/u);
      assert.equal((error as Error).message.includes(["must-never", "escape"].join("-")), false);
      return true;
    },
  );
  assert.deepEqual(events, ["raw-session:close"]);
});

test("route and provider registries reject ambiguous identities before selection", () => {
  assert.throws(
    () => new RFCClient(undefined, null as never),
    /RFCClient configuration/u,
  );
  let configurationProxyTraps = 0;
  const configurationProxy = new Proxy({}, {
    ownKeys() { configurationProxyTraps += 1; return []; },
    getPrototypeOf() { configurationProxyTraps += 1; return Object.prototype; },
  });
  assert.throws(
    () => new RFCClient(undefined, configurationProxy),
    /RFCClient configuration/u,
  );
  assert.equal(configurationProxyTraps, 0);
  assert.throws(
    () => new RFCClient(undefined, {
      recursiveSerializerPolicy: {
        profile: "offline",
        observation: {
          defaultSerializer: "classic-xrfc",
          basxmlDisabledSerializer: "classic-xrfc",
        },
      } as never,
    }),
    /live-policy/u,
  );
  assert.throws(
    () => bindRFCClientSessionProvider(null as never, {} as never),
    /binding expects an object identity/u,
  );
  assert.throws(
    () => resolveRFCClientSessionProvider({}),
    /no bound session provider/u,
  );
  assert.throws(
    () => bindRFCClientDestinationOwnerFactory(null as never, () => ({} as never)),
    /binding expects an object identity/u,
  );
  assert.throws(
    () => bindRFCClientDestinationOwnerFactory({}, null as never),
    /owner factory must be a function/u,
  );
  const client = {};
  const fallback = () => ({}) as never;
  assert.equal(
    resolveRFCClientDestinationOwnerFactory(client, fallback),
    fallback,
  );
  let calls = 0;
  bindRFCClientDestinationOwnerFactory(client, () => {
    calls += 1;
    return {} as never;
  });
  resolveRFCClientDestinationOwnerFactory(client, fallback)({} as never);
  assert.equal(calls, 1);

  for (const input of [null, [], "bad"]) {
    assert.throws(
      () => planRFCClientSessionRoute(input as never),
      /connection parameters must be an object/u,
    );
  }
  for (const key of ["snc_mode", "SNC_MODE"] as const) {
    const accessor = {};
    Object.defineProperty(accessor, key, { get: () => "1" });
    assert.throws(
      () => planRFCClientSessionRoute(accessor),
      /must be an own data property/u,
    );
    assert.throws(
      () => planRFCClientSessionRoute({ [key]: "1" }),
      /snc_mode connections are not implemented/u,
    );
  }
  for (const key of ["ashost", "ASHOST"] as const) {
    const accessor = {};
    Object.defineProperty(accessor, key, { get: () => "host.invalid" });
    assert.throws(
      () => planRFCClientSessionRoute(accessor),
      /must be an own data property/u,
    );
  }
  assert.throws(
    () => planRFCClientSessionRoute({
      ashost: "one.invalid",
      ASHOST: "two.invalid",
    }),
    /conflicting ashost and ASHOST values/u,
  );
  const planned = planRFCClientSessionRoute({
    ASHOST: "application.fixture.invalid",
    SYSNR: "00",
    CLIENT: "100",
    USER: "fixture-user",
    PASSWD: ["fixture", "secret"].join("-"),
  });
  assert.equal(planned.route.kind, "direct");

  let proxyTraps = 0;
  const proxy = new Proxy({ ASHOST: "application.fixture.invalid" }, {
    ownKeys() { proxyTraps += 1; return []; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
  });
  assert.throws(
    () => planRFCClientSessionRoute(proxy),
    /must not be a Proxy/u,
  );
  assert.equal(proxyTraps, 0);
});

test("modern RFCClient rejects every unplanned semantic property before provider I/O", async () => {
  let providerOpens = 0;
  const client = new RFCClient();
  bindRFCClientSessionProvider(client, Object.freeze({
    capabilities: Object.freeze([]),
    async open() {
      providerOpens += 1;
      throw new Error("provider must not open");
    },
  }));
  const base = {
    ashost: "application.fixture.invalid",
    sysnr: "00",
    client: "100",
    user: "fixture-user",
    passwd: ["fixture", "secret"].join("-"),
  };
  for (const name of UNPLANNED_SEMANTIC_RFC_PARAMETERS) {
    for (const key of [name, name.toUpperCase()]) {
      await assert.rejects(
        client.open({ ...base, [key]: "fixture-value" }),
        /not implemented/u,
      );
    }
  }
  assert.equal(providerOpens, 0);
});

test("provider binding validates capabilities and retires malformed sessions", async () => {
  for (const provider of [null, []]) {
    assert.throws(
      () => bindRfcSessionProvider(provider as never),
      /session provider/u,
    );
  }
  for (const capabilities of [
    null,
    new Array(1),
    ["unknown-capability"],
    ["direct-rfc-transport", "direct-rfc-transport"],
    Array.from({ length: 10 }, () => "direct-rfc-transport"),
  ]) {
    assert.throws(
      () => bindRfcSessionProvider({
        capabilities: capabilities as never,
        async open() { throw new Error("must not open"); },
      }),
      /capabilit/u,
    );
  }
  assert.throws(
    () => bindRfcSessionProvider({
      capabilities: [],
      open: undefined as never,
    }),
    /provider\.open must be a function/u,
  );

  const route = planRFCClientSessionRoute({
    ashost: "application.fixture.invalid",
    sysnr: "00",
    client: "100",
    user: "fixture-user",
    passwd: ["fixture", "secret"].join("-"),
  });
  const invalidConnectionInfo: unknown[] = [
    null,
    [],
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`K${index}`, "v"])),
    { password: "secret" },
    { "": "empty key" },
    { ["K".repeat(129)]: "long key" },
    { host: 7 },
    { host: "x".repeat(65 * 1_024) },
  ];
  const symbolInfo = { host: "value" } as Record<PropertyKey, unknown>;
  symbolInfo[Symbol("hidden")] = "value";
  invalidConnectionInfo.push(symbolInfo);
  const accessorInfo = {};
  Object.defineProperty(accessorInfo, "host", { get: () => "value" });
  invalidConnectionInfo.push(accessorInfo);

  for (const connectionInfo of invalidConnectionInfo) {
    let closeCount = 0;
    const provider = bindRfcSessionProvider({
      capabilities: ["direct-rfc-transport", "named-user-authentication"],
      async open() {
        return {
          connectionInfo,
          beginTransaction() { throw new Error("unused"); },
          async getFunctionInterface() { throw new Error("unused"); },
          async getStructureDefinition() { throw new Error("unused"); },
          async close() { closeCount += 1; },
        } as never;
      },
    });
    await assert.rejects(provider.open(route), /connectionInfo/u);
    assert.equal(closeCount, 1);
  }

  const bindingFailure = new Error("binding failed");
  const cleanupFailure = new Error("cleanup failed");
  const provider = bindRfcSessionProvider({
    capabilities: ["direct-rfc-transport", "named-user-authentication"],
    async open() {
      return {
        connectionInfo: {},
        beginTransaction: undefined,
        async close() { throw cleanupFailure; },
      } as never;
    },
  });
  await assert.rejects(
    provider.open(route),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.match((aggregate.errors[0] as Error).message, /beginTransaction/u);
      assert.equal(aggregate.errors[1], cleanupFailure);
      assert.notEqual(aggregate.errors[0], bindingFailure);
      return true;
    },
  );
});

test("bound sessions and transactions are receiver-safe and idempotent", async () => {
  const events: string[] = [];
  let transactionCount = 0;
  const rawSession = {
    connectionInfo: { host: "application.fixture.invalid" },
    beginTransaction() {
      transactionCount += 1;
      const current = transactionCount;
      if (current === 3) return null as never;
      return {
        async ready() { events.push(`ready:${current}`); },
        async call() {
          events.push(`call:${current}`);
          return current === 2 ? null as never : { RESULT: current };
        },
        async commit() { events.push(`commit:${current}`); },
        async rollback() { events.push(`rollback:${current}`); },
        async close() { events.push(`transaction-close:${current}`); },
        isTerminal() {
          if (current === 2) throw new Error("monitor failed");
          return "not-a-boolean" as never;
        },
      };
    },
    async getFunctionInterface(name: string) {
      events.push(`function:${name}`);
      return flatProviderFunction(name);
    },
    async getStructureDefinition(name: string) {
      events.push(`structure:${name}`);
      return { name } as never;
    },
    async getRecursiveFunctionMetadata(name: string) {
      events.push(`recursive:${name}`);
      return recursiveProviderGraph(name);
    },
    async close() { events.push("session-close"); },
  };
  const provider = bindRfcSessionProvider({
    capabilities: ["direct-rfc-transport", "named-user-authentication"],
    async open() { return rawSession; },
  });
  assert.equal(Object.isFrozen(provider.capabilities), true);
  const route = planRFCClientSessionRoute({
    ashost: "application.fixture.invalid",
    sysnr: "00",
    client: "100",
    user: "fixture-user",
    passwd: ["fixture", "secret"].join("-"),
  });
  const session = await provider.open(route);
  assert.equal(Object.isFrozen(session.connectionInfo), true);
  assert.equal((await session.getFunctionInterface("Z_BOUND")).name, "Z_BOUND");
  assert.equal((await session.getStructureDefinition("Z_LINE")).name, "Z_LINE");
  assert.equal(
    (await session.getRecursiveFunctionMetadata!("Z_RECURSIVE"))
      .functionIdentity?.name,
    "Z_RECURSIVE",
  );

  const first = session.beginTransaction();
  await first.ready();
  await first.ready();
  assert.deepEqual(await first.call("Z_BOUND", {}, {}), { RESULT: 1 });
  await first.commit();
  await first.rollback();
  assert.equal(first.isTerminal(), true);
  await first.close();
  await first.close();

  const second = session.beginTransaction();
  assert.equal(second.isTerminal(), true);
  await assert.rejects(second.call("Z_BAD_RESULT", {}, {}), /must return an object/u);
  assert.throws(() => session.beginTransaction(), /must return an object/u);
  await session.close();
  await session.close();
  assert.deepEqual(events.filter((event) => event === "session-close"), ["session-close"]);
  assert.deepEqual(events.filter((event) => event === "ready:1"), ["ready:1"]);
  assert.deepEqual(
    events.filter((event) => event === "transaction-close:1"),
    ["transaction-close:1"],
  );
});
