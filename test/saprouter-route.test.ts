import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  SAPROUTER_DEFAULT_NI_VERSION,
  SAPROUTER_DEFAULT_SERVICE,
  SAPROUTER_ROUTE_HEADER_LENGTH,
  admitSapRouterRoute,
  assertSapRouterRoutePrefix,
  completeSapRouterRoute,
  decodeSapRouterRouteResponse,
  encodeSapRouterRouteRequestPayload,
} from "../src/transport/saprouter-route.js";

test("completes a canonical SAPROUTER prefix with the normalized gateway", () => {
  const prefix = "/H/router.example.test/S/3299/W/router-secret/H/";
  assert.doesNotThrow(() => assertSapRouterRoutePrefix(prefix));
  const route = completeSapRouterRoute(prefix, "gateway.internal", 3_342);

  assert.deepEqual(route.hops, [
    {
      host: "router.example.test",
      service: "3299",
      usesDefaultService: false,
      passwordProtected: true,
    },
    {
      host: "gateway.internal",
      service: "3342",
      usesDefaultService: false,
      passwordProtected: false,
    },
  ]);
  assert.doesNotMatch(inspect(route, { depth: null }), /router-secret/u);
  assert.match(route.redactedRouteString, /\/W\/\[REDACTED\]/u);

  for (const ambiguous of [
    "/H/router.example.test/S/3299",
    "/H/router.example.test/H/gateway.internal/S/3342",
    "/H/router.example.test/P/legacy-secret/H/",
  ]) {
    assert.throws(
      () => assertSapRouterRoutePrefix(ambiguous),
      /SAProuter route string/u,
    );
  }
  assert.throws(
    () => completeSapRouterRoute(prefix, "different gateway", 3_342),
    /SAProuter route string/u,
  );
  assert.throws(
    () => completeSapRouterRoute(prefix, "gateway.internal", 65_536),
    /SAProuter route string/u,
  );
});

test("admits a canonical multi-hop route without exposing passwords", () => {
  const route = admitSapRouterRoute(
    "/H/router.example.test/W/first-secret" +
      "/H/second_router/S/saprouter/W/second-secret" +
      "/H/application.internal/S/sapgw01",
  );

  assert.equal(route.hopCount, 3);
  assert.deepEqual(route.firstHop, {
    host: "router.example.test",
    service: SAPROUTER_DEFAULT_SERVICE,
    usesDefaultService: true,
  });
  assert.deepEqual(route.hops, [
    {
      host: "router.example.test",
      service: SAPROUTER_DEFAULT_SERVICE,
      usesDefaultService: true,
      passwordProtected: true,
    },
    {
      host: "second_router",
      service: "saprouter",
      usesDefaultService: false,
      passwordProtected: true,
    },
    {
      host: "application.internal",
      service: "sapgw01",
      usesDefaultService: false,
      passwordProtected: false,
    },
  ]);
  assert.match(route.redactedRouteString, /\/W\/\[REDACTED\]/u);
  for (const rendered of [
    inspect(route, { depth: null }),
    JSON.stringify(route),
    route.redactedRouteString,
  ]) {
    assert.doesNotMatch(rendered, /first-secret|second-secret/u);
  }
  assert.ok(Object.isFrozen(route));
  assert.ok(Object.isFrozen(route.hops));
  assert.ok(route.hops.every(Object.isFrozen));
});

test("rejects malformed, ambiguous, legacy, and oversized route strings", () => {
  const invalid = [
    "router.example.test",
    "/h/router.example.test/H/target.example.test",
    "/H/x/H/target.example.test",
    "/H/router.example.test",
    "/H/router.example.test/S//H/target.example.test",
    "/H/router.example.test/S/3299/S/3300/H/target.example.test",
    "/H/router.example.test/W/one/W/two/H/target.example.test",
    "/H/router.example.test/W/secret/S/3299/H/target.example.test",
    "/H/router.example.test/P/legacy/H/target.example.test",
    "/H/router.example.test/X/value/H/target.example.test",
    "/H/router.example.test/H/target.example.test/W/must-not-be-on-target",
    "/H/router example/H/target.example.test",
    "/H/router.example.test/H/target.example.test\n",
    `/H/${"a".repeat(256)}/H/target.example.test`,
    `/H/router.example.test/H/${"b".repeat(2030)}`,
    Array.from({ length: 256 }, (_, index) => `/H/h${index}`).join(""),
  ];

  for (const candidate of invalid) {
    assert.throws(
      () => admitSapRouterRoute(candidate),
      (error: unknown) =>
        error instanceof Error &&
        /SAProuter route string/u.test(error.message) &&
        !error.message.includes(candidate),
      candidate.slice(0, 80),
    );
  }
  assert.throws(
    () => admitSapRouterRoute(new String("/H/router/H/target")),
    /SAProuter route string/u,
  );
});

test("encodes the documented NI_ROUTE header and NUL-separated route fields", () => {
  const route = admitSapRouterRoute(
    "/H/router/S/3299/W/secret/H/target/S/sapgw01",
  );
  const payload = encodeSapRouterRouteRequestPayload(route);
  const internalRoute = Buffer.from(
    "router\0" +
      "3299\0" +
      "secret\0" +
      "target\0" +
      "sapgw01\0" +
      "\0",
    "ascii",
  );

  assert.equal(payload.length, SAPROUTER_ROUTE_HEADER_LENGTH + internalRoute.length);
  assert.equal(payload.subarray(0, 9).toString("ascii"), "NI_ROUTE\0");
  assert.equal(payload[9], 2);
  assert.equal(payload[10], SAPROUTER_DEFAULT_NI_VERSION);
  assert.equal(payload[11], 2);
  assert.equal(payload[12], 0);
  assert.equal(payload.readUInt16BE(13), 0);
  assert.equal(payload[15], 1);
  assert.equal(payload.readUInt32BE(16), internalRoute.length);
  assert.equal(
    payload.readUInt32BE(20),
    Buffer.byteLength("router\0" + "3299\0" + "secret\0", "ascii"),
  );
  assert.deepEqual(payload.subarray(SAPROUTER_ROUTE_HEADER_LENGTH), internalRoute);

  const olderNi = encodeSapRouterRouteRequestPayload(route, { niVersion: 36 });
  assert.equal(olderNi[10], 36);
  assert.throws(
    () => encodeSapRouterRouteRequestPayload(route, { niVersion: 0 }),
    /niVersion/u,
  );
  assert.throws(
    () => encodeSapRouterRouteRequestPayload({ ...route }),
    /admitSapRouterRoute/u,
  );
});

test("decodes exact NI_PONG and bounded NI_RTERR route responses", () => {
  assert.deepEqual(
    decodeSapRouterRouteResponse(Buffer.from("NI_PONG\0", "ascii")),
    { kind: "accepted" },
  );

  const text = Buffer.from("route permission denied", "ascii");
  const modernError = Buffer.alloc(24 + text.length);
  modernError.write("NI_RTERR\0", 0, "ascii");
  modernError[9] = 40;
  modernError[10] = 0;
  modernError[11] = 0;
  modernError.writeInt32BE(-94, 12);
  modernError.writeUInt32BE(text.length, 16);
  text.copy(modernError, 20);
  modernError.writeUInt32BE(0, 20 + text.length);
  assert.deepEqual(decodeSapRouterRouteResponse(modernError), {
    kind: "rejected",
    niVersion: 40,
    returnCode: -94,
    errorTextByteLength: text.length,
  });

  const documentedError = modernError.subarray(0, modernError.length - 4);
  assert.deepEqual(decodeSapRouterRouteResponse(documentedError), {
    kind: "rejected",
    niVersion: 40,
    returnCode: -94,
    errorTextByteLength: text.length,
  });
});

test("rejects malformed route acknowledgements and error bounds", () => {
  const malformed: Buffer[] = [
    Buffer.from("NI_PONG", "ascii"),
    Buffer.from("NI_PONG\0extra", "ascii"),
    Buffer.from("UNKNOWN\0", "ascii"),
    Buffer.from("NI_RTERR\0", "ascii"),
  ];

  const badOpcode = Buffer.alloc(24);
  badOpcode.write("NI_RTERR\0", 0, "ascii");
  badOpcode[9] = 40;
  badOpcode[10] = 1;
  badOpcode.writeInt32BE(-94, 12);
  malformed.push(badOpcode);

  const badTextLength = Buffer.alloc(24);
  badTextLength.write("NI_RTERR\0", 0, "ascii");
  badTextLength[9] = 40;
  badTextLength.writeInt32BE(-94, 12);
  badTextLength.writeUInt32BE(500, 16);
  malformed.push(badTextLength);

  const badTrailer = Buffer.alloc(24);
  badTrailer.write("NI_RTERR\0", 0, "ascii");
  badTrailer[9] = 40;
  badTrailer.writeInt32BE(-94, 12);
  badTrailer.writeUInt32BE(1, 20);
  malformed.push(badTrailer);

  const nonErrorCode = Buffer.alloc(24);
  nonErrorCode.write("NI_RTERR\0", 0, "ascii");
  nonErrorCode[9] = 40;
  malformed.push(nonErrorCode);

  for (const payload of malformed) {
    assert.throws(
      () => decodeSapRouterRouteResponse(payload),
      /SAProuter route response/u,
    );
  }
});
