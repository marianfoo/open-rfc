import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  captureDirectConnectionParameters,
  languageIsoToSap,
  languageSapToIso,
  normalizeDirectConnectionParameters,
  snapshotDirectConnectionParameters,
} from "../src/compat/connection-parameters.js";

const recognizedDirectParameterKeys = [
  "ashost", "ASHOST",
  "gwhost", "GWHOST",
  "gwserv", "GWSERV",
  "port", "PORT",
  "sysnr", "SYSNR",
  "client", "CLIENT",
  "user", "USER",
  "passwd", "PASSWD",
  "mysapsso2", "MYSAPSSO2",
  "lang", "LANG",
  "cpic_streaming", "CPIC_STREAMING",
  "mshost", "MSHOST",
  "wshost", "WSHOST",
  "wsport", "WSPORT",
  "saprouter", "SAPROUTER",
  "connectivity_proxy_host", "CONNECTIVITY_PROXY_HOST",
  "connectivity_proxy_port", "CONNECTIVITY_PROXY_PORT",
  "connectivity_proxy_authentication", "CONNECTIVITY_PROXY_AUTHENTICATION",
  "connectivity_subaccount", "CONNECTIVITY_SUBACCOUNT",
  "connectivity_location_id", "CONNECTIVITY_LOCATION_ID",
  "connectivity_socks5_proxy_host", "CONNECTIVITY_SOCKS5_PROXY_HOST",
  "connectivity_socks5_proxy_port", "CONNECTIVITY_SOCKS5_PROXY_PORT",
  "connectivity_socks5_access_token", "CONNECTIVITY_SOCKS5_ACCESS_TOKEN",
  "connectivity_socks5_location_id", "CONNECTIVITY_SOCKS5_LOCATION_ID",
  "business_user_token", "BUSINESS_USER_TOKEN",
  "snc_mode", "SNC_MODE",
] as const;

test("keeps every captured route credential non-enumerable", () => {
  const values = {
    ashost: "sap.example.test",
    client: "001",
    user: "RFCUSER",
    passwd: "password-fixture",
    mysapsso2: "ticket-fixture",
    connectivity_proxy_authentication: "proxy-authorization-fixture",
    connectivity_location_id: "proxy-location-fixture",
    connectivity_socks5_access_token: "connectivity-token-fixture",
    connectivity_socks5_location_id: "socks-location-fixture",
    business_user_token: "business-token-fixture",
  };
  const snapshot = snapshotDirectConnectionParameters(values);
  for (const [key, secret] of [
    ["passwd", values.passwd],
    ["mysapsso2", values.mysapsso2],
    ["connectivity_proxy_authentication", values.connectivity_proxy_authentication],
    ["connectivity_location_id", values.connectivity_location_id],
    ["connectivity_socks5_access_token", values.connectivity_socks5_access_token],
    ["connectivity_socks5_location_id", values.connectivity_socks5_location_id],
    ["business_user_token", values.business_user_token],
  ] as const) {
    assertHiddenCredential(snapshot, key, secret);
  }

  const uppercaseSnapshot = snapshotDirectConnectionParameters({
    CONNECTIVITY_LOCATION_ID: "uppercase-proxy-location-fixture",
    CONNECTIVITY_SOCKS5_LOCATION_ID: "uppercase-socks-location-fixture",
  });
  assertHiddenCredential(
    uppercaseSnapshot,
    "CONNECTIVITY_LOCATION_ID",
    "uppercase-proxy-location-fixture",
  );
  assertHiddenCredential(
    uppercaseSnapshot,
    "CONNECTIVITY_SOCKS5_LOCATION_ID",
    "uppercase-socks-location-fixture",
  );
});

function assertHiddenCredential(
  value: Readonly<Record<string, unknown>>,
  key: string,
  credential: string,
): void {
  assert.equal(value[key], credential);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, key), {
    configurable: false,
    enumerable: false,
    value: credential,
    writable: false,
  });
  assert.equal(JSON.stringify(value).includes(credential), false);
  assert.equal(inspect(value).includes(credential), false);
}

test("captures recognized parameters once without inspecting arbitrary keys", () => {
  const source = {
    ASHOST: "sap.example.test",
    SYSNR: 1,
    CLIENT: 7,
    USER: "RFCUSER",
    PASSWD: "secret",
    LANG: "en-US",
  };
  Object.defineProperty(source, "unrelated", {
    enumerable: true,
    get(): never {
      throw new Error("unrelated getter must not run");
    },
  });

  const descriptorReads = new Map<PropertyKey, number>();
  const input = new Proxy(source, {
    get(): never {
      throw new Error("capture must not execute proxy property access");
    },
    getOwnPropertyDescriptor(target, key) {
      descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(): never {
      throw new Error("capture must not enumerate caller-owned keys");
    },
  });

  const captured = captureDirectConnectionParameters(input);
  for (const key of recognizedDirectParameterKeys) {
    assert.equal(
      descriptorReads.get(key),
      1,
      `${key} must be inspected exactly once`,
    );
  }
  assert.equal(descriptorReads.has("unrelated"), false);
  assert.deepEqual(captured.connectionParameters, {
    ASHOST: "sap.example.test",
    SYSNR: 1,
    CLIENT: 7,
    USER: "RFCUSER",
    LANG: "en-US",
  });
  assertHiddenCredential(captured.connectionParameters, "PASSWD", "secret");
  assert.equal(captured.normalized.password, "secret");
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.connectionParameters));
  assert.ok(Object.isFrozen(captured.normalized));
});

test("rejects accessor-backed parameters without executing mutation side effects", () => {
  const source: Record<string, unknown> = {
    client: "001",
    user: "RFCUSER",
    passwd: "secret",
  };
  let getterCalls = 0;
  Object.defineProperty(source, "ashost", {
    enumerable: true,
    get() {
      getterCalls += 1;
      source.user = "MUTATED";
      return "sap.example.test";
    },
  });

  assert.throws(
    () => captureDirectConnectionParameters(source),
    /ashost must be an own data property/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(source.user, "RFCUSER");
});

test("freezes a construction-time snapshot independently of later caller mutation", () => {
  const source: Record<string, unknown> = {
    ashost: "sap.example.test",
    client: "001",
    user: "RFCUSER",
    passwd: "secret",
  };
  const captured = captureDirectConnectionParameters(source);

  source.ashost = "changed.example.test";
  source.user = "CHANGED";
  source.passwd = ["changed", "secret"].join("-");

  assert.deepEqual(captured.connectionParameters, {
    ashost: "sap.example.test",
    client: "001",
    user: "RFCUSER",
  });
  assertHiddenCredential(captured.connectionParameters, "passwd", "secret");
  assert.equal(captured.normalized.host, "sap.example.test");
  assert.equal(captured.normalized.user, "RFCUSER");
  assert.equal(captured.normalized.password, "secret");
  assert.throws(
    () => {
      (captured.connectionParameters as Record<string, unknown>).user = "MUTATED";
    },
    TypeError,
  );
});

test("normalizes lowercase and uppercase direct RFC parameters", () => {
  assert.deepEqual(normalizeDirectConnectionParameters({
    ASHOST: "sap.example.test",
    SYSNR: 1,
    CLIENT: 7,
    USER: "RFCUSER",
    PASSWD: "secret",
    LANG: "en-US",
  }), {
    host: "sap.example.test",
    applicationServerHost: "sap.example.test",
    port: 3301,
    applicationServerService: "sapdp01",
    client: "007",
    user: "RFCUSER",
    password: "secret",
    language: "E",
    sysnr: "01",
    cpicStreaming: "disabled",
  });
  assert.equal(languageIsoToSap("de"), "D");
  assert.equal(languageSapToIso("D"), "DE");
});

test("normalizes and hides MYSAPSSO2 instead of requiring a password", () => {
  const captured = captureDirectConnectionParameters({
    ASHOST: "sap.example.test",
    CLIENT: "001",
    USER: "RFCUSER",
    MYSAPSSO2: "AB%21",
  });
  assertHiddenCredential(captured.connectionParameters, "MYSAPSSO2", "AB%21");
  assert.deepEqual(captured.normalized, {
    host: "sap.example.test",
    applicationServerHost: "sap.example.test",
    port: 3300,
    applicationServerService: "sapdp00",
    client: "001",
    user: "RFCUSER",
    ticket: "AB/",
    language: "E",
    sysnr: "00",
    cpicStreaming: "disabled",
  });
  assert.throws(
    () => normalizeDirectConnectionParameters({
      ashost: "sap.example.test",
      client: "001",
      user: "RFCUSER",
      passwd: "secret",
      mysapsso2: "AjQxMDM=",
    }),
    /exactly one of passwd or mysapsso2/u,
  );
  assert.throws(
    () => normalizeDirectConnectionParameters({
      ashost: "sap.example.test",
      client: "001",
      user: "RFCUSER",
      mysapsso2: 1234,
    }),
    /mysapsso2 must be a string/u,
  );
});

test("converts archived SAP and ISO language identifiers bidirectionally", () => {
  assert.equal(languageIsoToSap("AF"), "a");
  assert.equal(languageSapToIso("a"), "AF");
  assert.equal(languageIsoToSap("6N"), "둮");
  assert.equal(languageSapToIso("둮"), "6N");
  assert.equal(languageIsoToSap("Z9"), "&");
  assert.equal(languageSapToIso("&"), "Z9");
  assert.equal(languageIsoToSap("en-US"), "E");
  assert.throws(
    () => languageIsoToSap("ŠĐ"),
    { message: "Language ISO code not found: ŠĐ" },
  );
  assert.throws(
    () => languageSapToIso("Š"),
    { message: "Language SAP code not found: Š" },
  );
  assert.throws(
    () => languageSapToIso("__proto__"),
    { message: "Language SAP code not found: __proto__" },
  );
});

test("keeps the application server distinct from an explicit gateway endpoint", () => {
  const normalized = normalizeDirectConnectionParameters({
    ashost: "application.example.test",
    gwhost: "gateway.example.test",
    sysnr: "00",
    gwserv: "43300",
    client: "001",
    user: "RFCUSER",
    passwd: "secret",
  });
  assert.equal(normalized.host, "gateway.example.test");
  assert.equal(normalized.applicationServerHost, "application.example.test");
  assert.equal(normalized.port, 43300);
  assert.equal(normalized.cpicStreaming, "disabled");
  assert.deepEqual(
    normalizeDirectConnectionParameters({
      ASHOST: "application.example.test",
      GWHOST: "gateway.example.test",
      GWSERV: "sapgw00",
      CLIENT: "001",
      USER: "RFCUSER",
      PASSWD: "secret",
    }),
    { ...normalized, port: 3300 },
  );
  assert.throws(
    () =>
      normalizeDirectConnectionParameters({
        ashost: "application.example.test",
        gwhost: "one.example.test",
        GWHOST: "two.example.test",
        client: "001",
        user: "RFCUSER",
        passwd: "secret",
      }),
    /conflicting gwhost and GWHOST values/,
  );
  for (const ashost of ["bad\nhost", "x".repeat(65)]) {
    assert.throws(
      () =>
        normalizeDirectConnectionParameters({
          ashost,
          client: "001",
          user: "RFCUSER",
          passwd: "secret",
        }),
      /ashost must contain 1\.\.64 ASCII bytes/,
    );
  }
  // The compatibility route selector gives ASHOST precedence over MSHOST.
  // The direct normalizer therefore retains the selected direct route and
  // ignores the lower-priority message-server fields.
  const directWithLowerPriorityMessageRoute = normalizeDirectConnectionParameters({
    mshost: "message.example.test",
    ashost: "sap.example.test",
    client: "001",
    user: "RFCUSER",
    passwd: "secret",
  });
  assert.equal(directWithLowerPriorityMessageRoute.host, "sap.example.test");
  assert.equal(
    directWithLowerPriorityMessageRoute.applicationServerHost,
    "sap.example.test",
  );
  assert.throws(
    () => normalizeDirectConnectionParameters({
      ashost: "sap.example.test",
      client: "001",
      user: "RFCUSER",
      passwd: "secret",
      lang: "not-a-language",
    }),
    /Language ISO code not found/,
  );
  assert.equal(
    normalizeDirectConnectionParameters({
      ashost: "sap.example.test",
      client: "001",
      user: "RFCUSER",
      passwd: "secret",
      cpic_streaming: "enabled",
    }).cpicStreaming,
    "enabled",
  );
  assert.throws(
    () => normalizeDirectConnectionParameters({
      ashost: "sap.example.test",
      client: "001",
      user: "RFCUSER",
      passwd: "secret",
      cpic_streaming: true,
    }),
    /cpic_streaming must be disabled or enabled/,
  );
});

test("preserves direct validation order while exposing route-only normalization", () => {
  assert.throws(
    () => normalizeDirectConnectionParameters({
      ashost: "application.example.test",
      gwserv: "invalid-service",
      client: "invalid-client",
      lang: "invalid-language",
    }),
    /gwserv must be a TCP port or sapgwNN service name/u,
  );
  assert.throws(
    () => normalizeDirectConnectionParameters({
      ashost: "application.example.test",
      client: "001",
      lang: "invalid-language",
    }),
    /user must be a non-empty string or number/u,
  );
});
