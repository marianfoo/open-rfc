import assert from "node:assert/strict";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import test from "node:test";

import { encodeNiFrame } from "../src/protocol/ni.js";
import {
  createConnectivitySocks5DirectCpicTransportFactory,
} from "../src/transport/connectivity-socks5-ni.js";
import type {
  AdmittedConnectivitySocks5Config,
  EstablishedConnectivitySocks5Tunnel,
} from "../src/transport/connectivity-socks5-tunnel.js";

const FIXTURE_ACCESS_TOKEN = ["header", "payload", "signature"].join(".");

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
  socket.pause();
  return socket;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("adopts an explicitly configured Connectivity SOCKS5 TCP tunnel for NI", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const initialData = encodeNiFrame(Buffer.from("first-target-frame"));
  const calls: AdmittedConnectivitySocks5Config[] = [];
  const factory = createConnectivitySocks5DirectCpicTransportFactory({
    proxyHost: "connectivity-proxy.fixture.invalid",
    proxyPort: 20_004,
    accessToken: FIXTURE_ACCESS_TOKEN,
    locationId: "berlin-1",
    timeoutMs: 4_321,
    maxBufferedBytes: 8_192,
  }, {
    async connectTunnel(config): Promise<EstablishedConnectivitySocks5Tunnel> {
      calls.push(config);
      return Object.freeze({
        socket: await connect(port),
        initialData,
      });
    },
  });
  const controller = new AbortController();

  const transport = await factory({
    host: "virtual-gateway.fixture.invalid",
    port: 3_342,
    connectTimeoutMs: 1_234,
    maxPayloadLength: 4_096,
    noDelay: false,
    family: 4,
  }, controller.signal);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.proxyHost, "connectivity-proxy.fixture.invalid");
  assert.equal(calls[0]?.proxyPort, 20_004);
  assert.equal(calls[0]?.targetHost, "virtual-gateway.fixture.invalid");
  assert.equal(calls[0]?.targetPort, 3_342);
  assert.equal(calls[0]?.accessToken, FIXTURE_ACCESS_TOKEN);
  assert.equal(calls[0]?.locationId, "berlin-1");
  assert.equal(calls[0]?.timeoutMs, 4_321);
  assert.equal(calls[0]?.maxBufferedBytes, 8_192);
  assert.equal(
    (await transport.receive({ timeoutMs: 1_000 })).toString(),
    "first-target-frame",
  );
  assert.ok(initialData.every((byte) => byte === 0));
  await transport.close();
});

test("uses the direct connection timeout when no proxy override is configured", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  let timeout: number | undefined;
  const factory = createConnectivitySocks5DirectCpicTransportFactory({
    proxyHost: "connectivity-proxy.fixture.invalid",
    proxyPort: 20_004,
    accessToken: FIXTURE_ACCESS_TOKEN,
  }, {
    async connectTunnel(config): Promise<EstablishedConnectivitySocks5Tunnel> {
      timeout = config.timeoutMs;
      return Object.freeze({ socket: await connect(port), initialData: Buffer.alloc(0) });
    },
  });
  const transport = await factory({
    host: "virtual-gateway.fixture.invalid",
    port: 3_300,
    connectTimeoutMs: 2_345,
  });
  assert.equal(timeout, 2_345);
  await transport.close();
});

test("validates fixed proxy options before constructing the NI factory", () => {
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory({
      proxyHost: "bad host",
      proxyPort: 20_004,
      accessToken: FIXTURE_ACCESS_TOKEN,
    }),
    /proxyHost/u,
  );
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory({
      proxyHost: "proxy.fixture.invalid",
      proxyPort: 20_001,
      accessToken: FIXTURE_ACCESS_TOKEN,
    }, { connectTunnel: 1 as never }),
    /tunnel connector must be a function/u,
  );

  for (const invalid of [null, [], new Date()] as readonly unknown[]) {
    assert.throws(
      () => createConnectivitySocks5DirectCpicTransportFactory(invalid as never),
      /plain object/u,
    );
  }
  const proxied = new Proxy({
    proxyHost: "proxy.fixture.invalid",
    proxyPort: 20_004,
    accessToken: FIXTURE_ACCESS_TOKEN,
  }, {});
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory(proxied),
    /Proxy/u,
  );
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory({
      proxyHost: "proxy.fixture.invalid",
      proxyPort: 20_004,
      accessToken: FIXTURE_ACCESS_TOKEN,
      unexpected: true,
    } as never),
    /unsupported property unexpected/u,
  );
  const symbolProperty = {
    proxyHost: "proxy.fixture.invalid",
    proxyPort: 20_004,
    accessToken: FIXTURE_ACCESS_TOKEN,
    [Symbol("secret")]: "value",
  };
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory(symbolProperty),
    /do not accept symbols/u,
  );
  const accessor = {
    proxyHost: "proxy.fixture.invalid",
    proxyPort: 20_004,
    accessToken: FIXTURE_ACCESS_TOKEN,
  };
  Object.defineProperty(accessor, "locationId", {
    enumerable: true,
    get: () => "must-not-run",
  });
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory(accessor),
    /locationId must be an own data property/u,
  );
  assert.throws(
    () => createConnectivitySocks5DirectCpicTransportFactory({
      proxyHost: "proxy.fixture.invalid",
      proxyPort: 20_004,
      accessToken: FIXTURE_ACCESS_TOKEN,
    }, null as never),
    /dependencies must be an object/u,
  );
});

test("destroys invalid or unadoptable tunnel handoffs without retrying", async (t) => {
  const proxy = {
    proxyHost: "connectivity-proxy.fixture.invalid",
    proxyPort: 20_004,
    accessToken: FIXTURE_ACCESS_TOKEN,
  } as const;

  await t.test("non-object result", async () => {
    const factory = createConnectivitySocks5DirectCpicTransportFactory(proxy, {
      async connectTunnel(): Promise<never> {
        return null as never;
      },
    });
    await assert.rejects(
      Promise.resolve(factory({ host: "target.fixture.invalid", port: 3_300 })),
      /must return a tunnel/u,
    );
  });

  await t.test("non-buffer initial data", async () => {
    let destroyCalls = 0;
    const socket = {
      destroy(): void { destroyCalls += 1; },
    };
    const factory = createConnectivitySocks5DirectCpicTransportFactory(proxy, {
      async connectTunnel(): Promise<EstablishedConnectivitySocks5Tunnel> {
        return {
          socket: socket as never,
          initialData: "not bytes" as never,
        };
      },
    });
    await assert.rejects(
      Promise.resolve(factory({ host: "target.fixture.invalid", port: 3_300 })),
      /buffered initialData/u,
    );
    assert.equal(destroyCalls, 1);
  });

  await t.test("flowing socket", async () => {
    const { server, port } = await listen();
    t.after(() => closeServer(server));
    let handedOff: Socket | undefined;
    const initialData = encodeNiFrame(Buffer.from("must-be-wiped"));
    const factory = createConnectivitySocks5DirectCpicTransportFactory(proxy, {
      async connectTunnel(): Promise<EstablishedConnectivitySocks5Tunnel> {
        handedOff = createConnection({ host: "127.0.0.1", port });
        await new Promise<void>((resolve, reject) => {
          handedOff!.once("connect", resolve);
          handedOff!.once("error", reject);
        });
        return { socket: handedOff, initialData };
      },
    });
    await assert.rejects(
      Promise.resolve(factory({ host: "target.fixture.invalid", port: 3_300 })),
      /paused/u,
    );
    assert.equal(handedOff?.destroyed, true);
    assert.ok(initialData.every((byte) => byte === 0));
  });
});
