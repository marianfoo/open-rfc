import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspect } from "node:util";

import {
  ABAPError,
  Client,
  EnumSncQop,
  EnumTrace,
  NodeRfcError,
  Pool,
  RFCError,
  RFCErrorCode,
  RFC_RC,
  RFC_UNIT_STATE,
  RfcLoggingClass,
  RfcLoggingLevel,
  RfcParameterDirection,
  environment,
  type IABAPError,
  type INodeRfcError,
  type IRfcLibError,
  type NodeRfcEnvironment,
  type RfcArray,
  type RfcError,
  type RfcParameterValue,
  type RfcStructure,
  type RfcTable,
  type RfcTableOfStructures,
  type RfcTableOfVariables,
  type RfcVariable,
} from "../src/index.js";

test("Client and Pool config snapshots do not serialize Connectivity Location IDs", () => {
  const locationId = "location-fixture";
  const connectionParameters = {
    ashost: "application.example.invalid",
    gwhost: "virtual-gateway.example.invalid",
    gwserv: "sapgw00",
    sysnr: "00",
    client: "100",
    user: "fixture-user",
    passwd: "fixture-pw",
    connectivity_socks5_proxy_host: "connectivity.example.invalid",
    connectivity_socks5_proxy_port: 20_004,
    connectivity_socks5_access_token: "connectivity-token-fixture",
    connectivity_socks5_location_id: locationId,
  };
  const client = new Client(connectionParameters);
  const pool = new Pool({ connectionParameters });

  for (const [config, snapshot] of [
    [client.config, client.config.connectionParameters],
    [pool.config, pool.connectionParameters],
    [pool.poolConfiguration, pool.poolConfiguration.connectionParameters],
  ] as const) {
    assert.equal(snapshot.connectivity_socks5_location_id, locationId);
    assert.equal(
      Object.getOwnPropertyDescriptor(
        snapshot,
        "connectivity_socks5_location_id",
      )?.enumerable,
      false,
    );
    assert.equal(JSON.stringify(config).includes(locationId), false);
    assert.equal(inspect(config).includes(locationId), false);
  }
});

test("exports the archived node-rfc enum surface with exact values", () => {
  assert.equal(RFC_RC, RFCErrorCode);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(RFC_RC).filter(([name]) => !/^\d+$/u.test(name)),
    ),
    Object.fromEntries(
      Object.entries(RFCErrorCode).filter(([name]) => !/^\d+$/u.test(name)),
    ),
  );
  assert.deepEqual(
    {
      RFC_UNIT_NOT_FOUND: RFC_UNIT_STATE.RFC_UNIT_NOT_FOUND,
      RFC_UNIT_IN_PROCESS: RFC_UNIT_STATE.RFC_UNIT_IN_PROCESS,
      RFC_UNIT_COMMITTED: RFC_UNIT_STATE.RFC_UNIT_COMMITTED,
      RFC_UNIT_ROLLED_BACK: RFC_UNIT_STATE.RFC_UNIT_ROLLED_BACK,
      RFC_UNIT_CONFIRMED: RFC_UNIT_STATE.RFC_UNIT_CONFIRMED,
    },
    {
      RFC_UNIT_NOT_FOUND: 0,
      RFC_UNIT_IN_PROCESS: 1,
      RFC_UNIT_COMMITTED: 2,
      RFC_UNIT_ROLLED_BACK: 3,
      RFC_UNIT_CONFIRMED: 4,
    },
  );
  assert.deepEqual(
    {
      client: RfcLoggingClass.client,
      pool: RfcLoggingClass.pool,
      server: RfcLoggingClass.server,
      throughput: RfcLoggingClass.throughput,
      nwrfc: RfcLoggingClass.nwrfc,
      addon: RfcLoggingClass.addon,
    },
    { client: 0, pool: 1, server: 2, throughput: 3, nwrfc: 4, addon: 5 },
  );
  assert.deepEqual(
    {
      none: RfcLoggingLevel.none,
      fatal: RfcLoggingLevel.fatal,
      error: RfcLoggingLevel.error,
      warning: RfcLoggingLevel.warning,
      info: RfcLoggingLevel.info,
      debug: RfcLoggingLevel.debug,
      all: RfcLoggingLevel.all,
    },
    { none: 0, fatal: 1, error: 2, warning: 3, info: 4, debug: 5, all: 6 },
  );
  assert.deepEqual(
    {
      import: RfcParameterDirection.RFC_IMPORT,
      export: RfcParameterDirection.RFC_EXPORT,
      changing: RfcParameterDirection.RFC_CHANGING,
      tables: RfcParameterDirection.RFC_TABLES,
    },
    { import: 1, export: 2, changing: 3, tables: 7 },
  );
  assert.deepEqual(
    { ...EnumSncQop },
    {
      DigSig: "1",
      DigSigEnc: "2",
      DigSigEncUserAuth: "3",
      BackendDefault: "8",
      Maximum: "9",
    },
  );
  assert.deepEqual(
    { ...EnumTrace },
    { Off: "0", Brief: "1", Verbose: "2", Full: "3" },
  );
});

test("reports parseable package identity separately from the absent SDK", () => {
  const packageVersion = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).version as string;
  const typed: NodeRfcEnvironment = environment;
  assert.equal(typed.noderfc.version, packageVersion);
  assert.equal(typed.noderfc.implementation, "open-rfc-sdk-free");
  assert.deepEqual(typed.noderfc.nwrfcsdk, {
    major: 0,
    minor: 0,
    patchLevel: 0,
  });
  assert.match(typed.noderfc.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.equal(Object.isFrozen(typed), true);
  assert.equal(Object.isFrozen(typed.noderfc), true);
  assert.equal(Object.isFrozen(typed.noderfc.nwrfcsdk), true);
});

test("configuration enums do not silently widen unsupported transports", () => {
  const base = {
    ashost: "application.example.invalid",
    sysnr: "00",
    client: "100",
    user: "fixture-user",
    passwd: "fixture-pw",
  };
  assert.throws(
    () => new Client({ ...base, snc_qop: EnumSncQop.Maximum } as never),
    /snc_qop connections are not implemented/u,
  );
  assert.throws(
    () => new Client({ ...base, trace: EnumTrace.Brief } as never),
    /trace connections are not implemented/u,
  );
});

test("the public recursive values and error aliases bind to runtime-compatible shapes", () => {
  const scalar: RfcVariable = "value";
  const variables: RfcTableOfVariables = [
    scalar,
    42,
    9_007_199_254_740_993n,
    Buffer.from([1, 2]),
  ];
  const structure: RfcStructure = {
    TEXT: "value",
    NESTED: { COUNT: 1 },
    ITEMS: [{ ID: 1 }],
  };
  const structures: RfcTableOfStructures = [structure];
  const table: RfcTable = [...variables, ...structures];
  const array: RfcArray = variables;
  const parameter: RfcParameterValue = table;
  assert.deepEqual({ array, parameter, structure }, {
    array: variables,
    parameter: table,
    structure,
  });

  const nodeShape = (value: NodeRfcError): INodeRfcError => value;
  const libraryShape = (value: RFCError): IRfcLibError => value;
  const abapShape = (value: ABAPError): IABAPError => value;
  const errorUnion = (value: INodeRfcError | IRfcLibError): RfcError => value;
  assert.equal(nodeShape(new NodeRfcError("closed")).name, "nodeRfcError");
  const libraryError = new RFCError("invalid", {
    group: 5,
    code: RFCErrorCode.RFC_INVALID_PARAMETER,
    codeString: "RFC_INVALID_PARAMETER",
    key: "RFC_INVALID_PARAMETER",
  });
  assert.equal(libraryShape(libraryError).code, RFC_RC.RFC_INVALID_PARAMETER);
  assert.equal(errorUnion(libraryError), libraryError);
  assert.equal(typeof abapShape, "function");
});
