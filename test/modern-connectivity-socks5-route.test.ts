import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import { RFCClient } from "../src/compat/node-rfc-library.js";
import {
  bindRFCClientDestinationOwnerFactory,
  type RFCClientDestinationOwnerFactoryContext,
} from "../src/compat/rfc-client-owner-registry.js";
import { resolveRFCClientSessionProvider } from
  "../src/compat/rfc-session-provider-registry.js";

test("modern RFCClient carries Connectivity SOCKS5 into the direct session", async () => {
  const client = new RFCClient();
  const provider = resolveRFCClientSessionProvider(client);
  assert.equal(provider.capabilities.includes("connectivity-socks5-tcp"), true);

  let context: RFCClientDestinationOwnerFactoryContext | undefined;
  const stop = new Error("owner creation stopped before transport I/O");
  bindRFCClientDestinationOwnerFactory(client, (_connection, ownerContext) => {
    context = ownerContext;
    throw stop;
  });

  const accessToken = ["connectivity", "token", "fixture"].join("-");
  let failure: unknown;
  try {
    await client.open({
      ashost: "application.fixture.invalid",
      gwhost: "virtual-gateway.invalid",
      gwserv: 3_300,
      client: "001",
      user: "fixture-user",
      passwd: "fixture-password",
      connectivity_socks5_proxy_host: "proxy.fixture.invalid",
      connectivity_socks5_proxy_port: 20_004,
      connectivity_socks5_access_token: accessToken,
      connectivity_socks5_location_id: "location-a",
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(typeof context?.session?.transportFactory, "function");
  assert.doesNotMatch(inspect(failure, { depth: null }), /connectivity-token-fixture|location-a/u);
});
