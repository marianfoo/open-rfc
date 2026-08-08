import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import test from "node:test";

import { encodeNiFrame } from "../src/protocol/ni.js";
import {
  createSapRouterDirectCpicTransportFactory,
} from "../src/transport/saprouter-ni.js";
import type {
  EstablishedSapRouterRoute,
  SapRouterRouteSocket,
} from "../src/transport/saprouter-tunnel.js";
import { NiTransportError } from "../src/transport/ni-socket.js";
import type { AdmittedSapRouterRoute } from "../src/transport/saprouter-route.js";

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return { server, port: address.port };
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error))
  );
}

function established(
  socket: Socket,
  initialData: Buffer,
): EstablishedSapRouterRoute {
  return Object.freeze({
    socket: socket as unknown as SapRouterRouteSocket,
    initialData,
    hopCount: 2,
    firstHop: Object.freeze({
      host: "router.fixture.invalid",
      service: "3299",
      usesDefaultService: false,
    }),
  });
}

test("adopts each established SAProuter stream with its coalesced NI bytes", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const routePrefix =
    "/H/router.fixture.invalid/S/3299/W/router-secret/H/";
  const initialData = encodeNiFrame(Buffer.from("target-first-frame"));
  const calls: Array<Readonly<Record<string, unknown>>> = [];
  const factory = createSapRouterDirectCpicTransportFactory(routePrefix, {
    async connectRoute(route, options, signal) {
      calls.push(Object.freeze({ route, options, signal }));
      const socket = await connect(port);
      socket.pause();
      return established(socket, initialData);
    },
  });
  const controller = new AbortController();

  const transport = await factory({
    host: "gateway.fixture.invalid",
    port: 3_342,
    connectTimeoutMs: 1_234,
    maxPayloadLength: 4_096,
    noDelay: false,
    family: 4,
  }, controller.signal);

  assert.equal(calls.length, 1);
  const completedRoute = calls[0]?.route as AdmittedSapRouterRoute;
  assert.deepEqual(completedRoute.hops, [
    {
      host: "router.fixture.invalid",
      service: "3299",
      usesDefaultService: false,
      passwordProtected: true,
    },
    {
      host: "gateway.fixture.invalid",
      service: "3342",
      usesDefaultService: false,
      passwordProtected: false,
    },
  ]);
  assert.doesNotMatch(inspect(completedRoute, { depth: null }), /router-secret/u);
  assert.deepEqual(calls[0]?.options, {
    connectTimeoutMs: 1_234,
    handshakeTimeoutMs: 1_234,
    family: 4,
    noDelay: false,
  });
  assert.equal(calls[0]?.signal, controller.signal);
  assert.equal(Object.isFrozen(calls[0]?.options), true);
  assert.equal(
    (await transport.receive({ timeoutMs: 1_000 })).toString(),
    "target-first-frame",
  );
  assert.equal(initialData.equals(Buffer.alloc(initialData.length)), true);
  assert.equal(transport.remotePort, port);
  await transport.close();
});

test("destroys a flowing route handoff and never retries it", async (t) => {
  const peers = new Set<Socket>();
  const { server, port } = await listen();
  server.on("connection", (socket) => peers.add(socket));
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await closeServer(server);
  });
  let calls = 0;
  let routedSocket: Socket | undefined;
  const initialData = encodeNiFrame(Buffer.from("must-be-wiped"));
  const factory = createSapRouterDirectCpicTransportFactory(
    "/H/router.fixture.invalid/H/",
    {
      async connectRoute() {
        calls += 1;
        routedSocket = await connect(port);
        return established(routedSocket, initialData);
      },
    },
  );

  await assert.rejects(
    Promise.resolve(factory({ host: "ignored", port: 3_300 })),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_PROTOCOL_ERROR",
  );
  assert.equal(calls, 1);
  assert.equal(routedSocket?.destroyed, true);
  assert.equal(initialData.equals(Buffer.alloc(initialData.length)), true);
});

test("validates SAProuter NI dependencies before creating a transport", () => {
  assert.throws(
    () => createSapRouterDirectCpicTransportFactory(""),
    /SAProuter route string/u,
  );
  assert.throws(
    () => createSapRouterDirectCpicTransportFactory(
      "/H/router.fixture.invalid/H/",
      { connectRoute: 1 as never },
    ),
    /route connector must be a function/u,
  );
  assert.throws(
    () => createSapRouterDirectCpicTransportFactory(
      "/H/router.fixture.invalid/H/application.fixture.invalid/S/3300",
    ),
    /SAProuter route string/u,
  );
});
