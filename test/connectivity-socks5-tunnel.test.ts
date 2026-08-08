import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { inspect } from "node:util";

import {
  ConnectivitySocks5Error,
  admitConnectivitySocks5Config,
  assertAdmittedConnectivitySocks5Config,
  connectConnectivitySocks5Tunnel,
  establishConnectivitySocks5Tunnel,
  type ConnectivitySocks5Socket,
  type ConnectivitySocks5TimerScheduler,
} from "../src/transport/connectivity-socks5-tunnel.js";

const FIXTURE_ACCESS_TOKEN = ["header", "payload", "signature"].join(".");

type Assert<T extends true> = T;
type _NetSocketCompatibility = Assert<
  Socket extends ConnectivitySocks5Socket ? true : false
>;

class FakeSocket extends EventEmitter implements ConnectivitySocks5Socket {
  readonly writes: Buffer[] = [];
  readonly writtenBuffers: Buffer[] = [];
  readonly pendingWriteCallbacks: ((error?: Error | null) => void)[] = [];
  destroyed = false;
  destroyCalls = 0;
  pauseCalls = 0;
  autoCompleteWrites = true;
  throwOnWrite = false;
  throwOnPause = false;
  throwOnDestroy = false;

  write(
    chunk: Uint8Array,
    callback: (error?: Error | null) => void,
  ): boolean {
    if (this.throwOnWrite) throw new Error("fixture write failure");
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writtenBuffers.push(buffer);
    this.writes.push(Buffer.from(buffer));
    if (this.autoCompleteWrites) callback();
    else this.pendingWriteCallbacks.push(callback);
    return true;
  }

  completeWrite(error?: Error): void {
    const callback = this.pendingWriteCallbacks.shift();
    if (callback === undefined) throw new Error("no pending fake write");
    callback(error);
  }

  pause(): this {
    if (this.throwOnPause) throw new Error("fixture pause failure");
    this.pauseCalls += 1;
    return this;
  }

  destroy(): this {
    this.destroyCalls += 1;
    if (this.throwOnDestroy) throw new Error("fixture destroy failure");
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }

  data(chunk: Buffer | string): void {
    this.emit("data", chunk);
  }
}

function baseConfig(): Record<string, unknown> {
  return {
    proxyHost: "connectivity-proxy.example.test",
    proxyPort: 20_004,
    targetHost: "sap-virtual.example.test",
    targetPort: 3_300,
    accessToken: FIXTURE_ACCESS_TOKEN,
  };
}

function manualScheduler(): {
  readonly scheduler: ConnectivitySocks5TimerScheduler;
  readonly fire: () => void;
  readonly clearCount: () => number;
} {
  let callback: (() => void) | undefined;
  let clears = 0;
  const handle = Object.freeze({ timer: "manual" });
  return Object.freeze({
    scheduler: Object.freeze({
      setTimeout(next: () => void): object {
        callback = next;
        return handle;
      },
      clearTimeout(received: unknown): void {
        assert.equal(received, handle);
        callback = undefined;
        clears += 1;
      },
    }),
    fire(): void {
      const next = callback;
      callback = undefined;
      next?.();
    },
    clearCount: () => clears,
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("admits an immutable, redaction-safe SOCKS5 configuration snapshot", () => {
  const source: Record<string, unknown> = {
    ...baseConfig(),
    locationId: "berlin-一",
    timeoutMs: 2_000,
    maxBufferedBytes: 4_096,
  };
  const admitted = admitConnectivitySocks5Config(source);
  source.accessToken = ["mutated", "token", "value"].join(".");
  source.locationId = "mutated";

  assert.equal(admitted.accessToken, FIXTURE_ACCESS_TOKEN);
  assert.equal(admitted.locationId, "berlin-一");
  assert.equal(admitted.timeoutMs, 2_000);
  assert.equal(admitted.maxBufferedBytes, 4_096);
  assert.ok(Object.isFrozen(admitted));
  assert.doesNotMatch(JSON.stringify(admitted), /header|payload|signature|berlin/u);
  assert.doesNotMatch(inspect(admitted), /header|payload|signature|berlin/u);
});

test("rejects ambiguous input, unsupported addresses, and unbounded secrets before I/O", () => {
  const cases: readonly [Record<string, unknown>, RegExp][] = [
    [{} as Record<string, unknown>, /proxyHost must be an own data property/u],
    [{ ...baseConfig(), proxyPort: 0 }, /proxyPort/u],
    [{ ...baseConfig(), targetPort: 65_536 }, /targetPort/u],
    [{ ...baseConfig(), proxyHost: "bad host" }, /proxyHost/u],
    [{ ...baseConfig(), proxyHost: "[2001:db8::1" }, /invalid IP literal/u],
    [{ ...baseConfig(), proxyHost: 42 }, /proxyHost/u],
    [{ ...baseConfig(), targetHost: "2001:db8::1" }, /IPv6/u],
    [{ ...baseConfig(), targetHost: "[127.0.0.1]" }, /IPv6 literal/u],
    [{ ...baseConfig(), proxyHost: "[proxy.example.test]" }, /IPv6 literal/u],
    [{ ...baseConfig(), targetHost: "999.1.1.1" }, /targetHost/u],
    [{ ...baseConfig(), targetHost: "user@sap.example.test" }, /targetHost/u],
    [{ ...baseConfig(), targetHost: `${"x".repeat(64)}.test` }, /targetHost/u],
    [{ ...baseConfig(), accessToken: "contains whitespace" }, /accessToken/u],
    [{ ...baseConfig(), accessToken: "" }, /accessToken/u],
    [{ ...baseConfig(), accessToken: "x".repeat(65_537) }, /accessToken/u],
    [{ ...baseConfig(), locationId: "" }, /locationId/u],
    [{ ...baseConfig(), locationId: "bad\nlocation" }, /locationId/u],
    [{ ...baseConfig(), locationId: "x".repeat(190) }, /locationId/u],
    [{ ...baseConfig(), locationId: "一".repeat(64) }, /locationId/u],
    [{ ...baseConfig(), timeoutMs: 0 }, /timeoutMs/u],
    [{ ...baseConfig(), maxBufferedBytes: 7 }, /maxBufferedBytes/u],
    [{ ...baseConfig(), extra: true }, /unsupported property extra/u],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => admitConnectivitySocks5Config(input), expected);
  }
  for (const input of [null, [], new Date()] as const) {
    assert.throws(
      () => admitConnectivitySocks5Config(input as never),
      /plain object/u,
    );
  }

  const withSymbol = baseConfig();
  Object.defineProperty(withSymbol, Symbol("private"), { value: true });
  assert.throws(
    () => admitConnectivitySocks5Config(withSymbol),
    /symbol properties/u,
  );

  const normalized = admitConnectivitySocks5Config({
    ...baseConfig(),
    proxyHost: "[2001:db8::1]",
    targetHost: "sap-virtual.example.test.",
  });
  assert.equal(normalized.proxyHost, "2001:db8::1");
  assert.equal(normalized.targetHost, "sap-virtual.example.test");
  assert.throws(
    () => assertAdmittedConnectivitySocks5Config({ ...normalized }),
    /must come from admitConnectivitySocks5Config/u,
  );

  let getterCalls = 0;
  const accessor = baseConfig();
  Object.defineProperty(accessor, "locationId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  assert.throws(
    () => admitConnectivitySocks5Config(accessor),
    /locationId must be an own data property/u,
  );
  assert.equal(getterCalls, 0);

  const proxied = new Proxy(baseConfig(), {
    ownKeys(): never {
      throw new Error("Proxy trap must not execute");
    },
  });
  assert.throws(() => admitConnectivitySocks5Config(proxied), /Proxy/u);
});

test("performs SAP JWT method 0x80 and preserves fragmented target bytes", async () => {
  const socket = new FakeSocket();
  const timers = manualScheduler();
  const pending = establishConnectivitySocks5Tunnel(
    socket,
    admitConnectivitySocks5Config({
      ...baseConfig(),
      locationId: "berlin-1",
    }),
    undefined,
    timers.scheduler,
  );

  assert.deepEqual(socket.writes, [Buffer.from([0x05, 0x01, 0x80])]);
  socket.data(Buffer.from([0x05]));
  assert.equal(socket.writes.length, 1);
  socket.data(Buffer.from([0x80]));

  const token = Buffer.from(FIXTURE_ACCESS_TOKEN, "ascii");
  const encodedLocation = Buffer.from("berlin-1", "utf8").toString("base64");
  const expectedAuth = Buffer.alloc(1 + 4 + token.length + 1 + encodedLocation.length);
  expectedAuth[0] = 0x01;
  expectedAuth.writeUInt32BE(token.length, 1);
  token.copy(expectedAuth, 5);
  expectedAuth[5 + token.length] = encodedLocation.length;
  expectedAuth.write(encodedLocation, 6 + token.length, "ascii");
  assert.deepEqual(socket.writes[1], expectedAuth);
  assert.ok(socket.writtenBuffers[1]!.every((byte) => byte === 0));

  socket.data(Buffer.from([0x01, 0x00]));
  const host = Buffer.from("sap-virtual.example.test", "ascii");
  assert.deepEqual(socket.writes[2], Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x0c, 0xe4]),
  ]));

  socket.data(Buffer.from([0x05, 0x00, 0x00]));
  socket.data(Buffer.from([0x03, 0x05, 0x70]));
  socket.data(Buffer.concat([
    Buffer.from("roxy", "ascii"),
    Buffer.from([0x4e, 0x24]),
    Buffer.from([0x00, 0x00, 0x00, 0x03, 0x52, 0x46, 0x43]),
  ]));
  const established = await pending;

  assert.equal(established.socket, socket);
  assert.deepEqual(
    established.initialData,
    Buffer.from([0x00, 0x00, 0x00, 0x03, 0x52, 0x46, 0x43]),
  );
  assert.equal(socket.pauseCalls, 1);
  assert.equal(socket.destroyCalls, 0);
  assert.equal(timers.clearCount(), 1);
  assert.doesNotMatch(JSON.stringify(established), /header|payload|signature/u);
});

test("encodes an IPv4 target without resolving it and omits location ID", async () => {
  const socket = new FakeSocket();
  const pending = establishConnectivitySocks5Tunnel(
    socket,
    admitConnectivitySocks5Config({
      ...baseConfig(),
      targetHost: "192.0.2.25",
      targetPort: 443,
    }),
  );
  socket.data(Buffer.from([0x05, 0x80]));
  const auth = socket.writes[1]!;
  assert.equal(auth.at(-1), 0);
  socket.data(Buffer.from([0x01, 0x00]));
  assert.deepEqual(
    socket.writes[2],
    Buffer.from([0x05, 0x01, 0x00, 0x01, 192, 0, 2, 25, 0x01, 0xbb]),
  );
  socket.data(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x4e, 0x24]));
  const established = await pending;
  assert.equal(established.initialData.length, 0);
});

test("connects a real TCP stream and completes the documented handshake", async (t) => {
  const server = createServer((peer) => {
    let phase = 0;
    let buffered = Buffer.alloc(0);
    peer.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        if (phase === 0) {
          if (buffered.length < 3) return;
          assert.deepEqual(buffered.subarray(0, 3), Buffer.from([0x05, 0x01, 0x80]));
          buffered = buffered.subarray(3);
          phase = 1;
          peer.write(Buffer.from([0x05]));
          peer.write(Buffer.from([0x80]));
          continue;
        }
        if (phase === 1) {
          if (buffered.length < 6) return;
          const tokenLength = buffered.readUInt32BE(1);
          if (buffered.length < 6 + tokenLength) return;
          const locationLength = buffered[5 + tokenLength]!;
          const total = 6 + tokenLength + locationLength;
          if (buffered.length < total) return;
          assert.equal(buffered[0], 0x01);
          assert.equal(
            buffered.subarray(5, 5 + tokenLength).toString("ascii"),
            FIXTURE_ACCESS_TOKEN,
          );
          assert.equal(
            buffered.subarray(6 + tokenLength, total).toString("ascii"),
            Buffer.from("berlin-1").toString("base64"),
          );
          buffered = buffered.subarray(total);
          phase = 2;
          peer.write(Buffer.from([0x01, 0x00]));
          continue;
        }
        if (phase === 2) {
          if (buffered.length < 5) return;
          const domainLength = buffered[4]!;
          const total = 7 + domainLength;
          if (buffered.length < total) return;
          assert.equal(buffered.subarray(0, 5).toString("hex"), "05010003" + domainLength.toString(16).padStart(2, "0"));
          assert.equal(
            buffered.subarray(5, 5 + domainLength).toString("ascii"),
            "sap-virtual.example.test",
          );
          assert.equal(buffered.readUInt16BE(5 + domainLength), 3_300);
          buffered = buffered.subarray(total);
          phase = 3;
          peer.write(Buffer.concat([
            Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x4e, 0x24]),
            Buffer.from([0x00, 0x00, 0x00, 0x02, 0x4e, 0x49]),
          ]));
          continue;
        }
        return;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  const established = await connectConnectivitySocks5Tunnel({
    proxyHost: "127.0.0.1",
    proxyPort: address.port,
    targetHost: "sap-virtual.example.test",
    targetPort: 3_300,
    accessToken: FIXTURE_ACCESS_TOKEN,
    locationId: "berlin-1",
    timeoutMs: 1_000,
  });
  assert.deepEqual(
    established.initialData,
    Buffer.from([0x00, 0x00, 0x00, 0x02, 0x4e, 0x49]),
  );
  established.socket.destroy();
});

test("validates connector seams and destroys an invalid returned stream", async () => {
  const config = {
    proxyHost: "proxy.fixture.invalid",
    proxyPort: 20_004,
    targetHost: "target.fixture.invalid",
    targetPort: 3_300,
    accessToken: FIXTURE_ACCESS_TOKEN,
  } as const;
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, undefined, null as never),
    /dependencies must be an object/u,
  );
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, undefined, [] as never),
    /dependencies must be an object/u,
  );
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, undefined, { connect: 1 as never }),
    /connector must be a function/u,
  );
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, undefined, {
      async connect() { return undefined as never; },
    }),
    (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
  );

  let destroyCalls = 0;
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, undefined, {
      async connect() {
        return {
          destroy(): void { destroyCalls += 1; },
        } as never;
      },
    }),
    (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
  );
  assert.equal(destroyCalls, 1);

  const bounded = new ConnectivitySocks5Error(
    "CONNECTIVITY_SOCKS5_CONNECT_TIMEOUT",
    "bounded fixture failure",
  );
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, undefined, {
      async connect(): Promise<never> { throw bounded; },
    }),
    (error: unknown) => error === bounded,
  );

  const duringConnect = new AbortController();
  await assert.rejects(
    connectConnectivitySocks5Tunnel(config, duringConnect.signal, {
      async connect(): Promise<never> {
        duringConnect.abort(new Error("fixture abort"));
        throw new Error("private connector failure");
      },
    }),
    (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_ABORTED",
  );

  const afterConnect = new AbortController();
  const socket = new FakeSocket();
  socket.throwOnDestroy = true;
  await assert.rejects(
    connectConnectivitySocks5Tunnel(
      admitConnectivitySocks5Config(config),
      afterConnect.signal,
      {
        async connect(options) {
          assert.ok(Object.isFrozen(options));
          afterConnect.abort(new Error("fixture abort"));
          return socket;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_ABORTED",
  );
});

test("maps proxy rejections and malformed responses to redaction-safe errors", async (t) => {
  async function rejectAfter(
    chunks: readonly Buffer[],
    expectedCode: string,
    replyCode?: number,
  ): Promise<void> {
    const socket = new FakeSocket();
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      admitConnectivitySocks5Config(baseConfig()),
    );
    for (const chunk of chunks) socket.data(chunk);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ConnectivitySocks5Error);
      assert.equal(error.code, expectedCode);
      assert.equal(error.replyCode, replyCode);
      assert.doesNotMatch(error.message, /header|payload|signature|sap-virtual/u);
      assert.doesNotMatch(JSON.stringify(error), /header|payload|signature|sap-virtual/u);
      assert.doesNotMatch(inspect(error), /header|payload|signature|sap-virtual/u);
      return true;
    });
    assert.equal(socket.destroyCalls, 1);
  }

  await t.test("method rejected", () => rejectAfter(
    [Buffer.from([0x05, 0xff])],
    "CONNECTIVITY_SOCKS5_AUTHENTICATION_REJECTED",
  ));
  await t.test("authentication rejected", () => rejectAfter(
    [Buffer.from([0x05, 0x80]), Buffer.from([0x01, 0x01])],
    "CONNECTIVITY_SOCKS5_AUTHENTICATION_REJECTED",
  ));
  await t.test("target forbidden", () => rejectAfter(
    [
      Buffer.from([0x05, 0x80]),
      Buffer.from([0x01, 0x00]),
      Buffer.from([0x05, 0x02, 0x00, 0x01]),
    ],
    "CONNECTIVITY_SOCKS5_CONNECT_REJECTED",
    2,
  ));
  await t.test("malformed reserved byte", () => rejectAfter(
    [
      Buffer.from([0x05, 0x80]),
      Buffer.from([0x01, 0x00]),
      Buffer.from([0x05, 0x00, 0x01, 0x01]),
    ],
    "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
  ));
  await t.test("unsupported IPv6 reply", () => rejectAfter(
    [
      Buffer.from([0x05, 0x80]),
      Buffer.from([0x01, 0x00]),
      Buffer.from([0x05, 0x00, 0x00, 0x04]),
    ],
    "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
  ));
  await t.test("wrong method protocol", () => rejectAfter(
    [Buffer.from([0x04, 0x80])],
    "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
  ));
  await t.test("wrong authentication protocol", () => rejectAfter(
    [Buffer.from([0x05, 0x80]), Buffer.from([0x02, 0x00])],
    "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
  ));
  await t.test("empty bound domain", () => rejectAfter(
    [
      Buffer.from([0x05, 0x80]),
      Buffer.from([0x01, 0x00]),
      Buffer.from([0x05, 0x00, 0x00, 0x03, 0x00]),
    ],
    "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
  ));
});

test("validates socket and scheduler state and fails closed on synchronous hooks", async (t) => {
  const config = admitConnectivitySocks5Config(baseConfig());
  assert.throws(
    () => establishConnectivitySocks5Tunnel(null as never, config),
    /connected byte stream/u,
  );
  assert.throws(
    () => establishConnectivitySocks5Tunnel({ destroy() {} } as never, config),
    /connected byte stream/u,
  );
  assert.throws(
    () => establishConnectivitySocks5Tunnel(new FakeSocket(), config, undefined, null as never),
    /scheduler must be an object/u,
  );
  assert.throws(
    () => establishConnectivitySocks5Tunnel(
      new FakeSocket(),
      config,
      undefined,
      { setTimeout: 1 as never, clearTimeout() {} },
    ),
    /must provide setTimeout and clearTimeout/u,
  );

  await t.test("timer scheduler throws", async () => {
    const socket = new FakeSocket();
    await assert.rejects(
      establishConnectivitySocks5Tunnel(socket, config, undefined, {
        setTimeout(): never { throw new Error("fixture timer failure"); },
        clearTimeout() {},
      }),
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
    );
  });

  await t.test("synchronous abort during timer installation", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    let clears = 0;
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      config,
      controller.signal,
      {
        setTimeout() {
          controller.abort();
          return "fixture-handle";
        },
        clearTimeout(handle) {
          assert.equal(handle, "fixture-handle");
          clears += 1;
        },
      },
    );
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_ABORTED",
    );
    assert.equal(clears, 1);
  });

  await t.test("socket write throws", async () => {
    const socket = new FakeSocket();
    socket.throwOnWrite = true;
    await assert.rejects(
      establishConnectivitySocks5Tunnel(socket, config),
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_WRITE_FAILED",
    );
  });

  await t.test("socket pause throws", async () => {
    const socket = new FakeSocket();
    socket.throwOnPause = true;
    const pending = establishConnectivitySocks5Tunnel(socket, config);
    socket.data(Buffer.from([0x05, 0x80]));
    socket.data(Buffer.from([0x01, 0x00]));
    const host = Buffer.from("bound", "ascii");
    socket.data(Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x03, host.length]),
      host,
      Buffer.from([0x00, 0x50]),
    ]));
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
    );
  });

  await t.test("partial listener installation throws", async () => {
    const socket = new FakeSocket();
    const originalOn = socket.on.bind(socket);
    let registrations = 0;
    socket.on = ((event: string, listener: (...args: unknown[]) => void) => {
      registrations += 1;
      if (registrations === 2) throw new Error("fixture listener failure");
      return originalOn(event, listener);
    }) as typeof socket.on;
    await assert.rejects(
      establishConnectivitySocks5Tunnel(socket, config),
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
    );
    assert.equal(socket.destroyCalls, 1);
    assert.equal(socket.listenerCount("data"), 0);
  });

  await t.test("throwing listener cleanup still settles and destroys", async () => {
    const socket = new FakeSocket();
    const originalRemove = socket.removeListener.bind(socket);
    let threw = false;
    socket.removeListener = ((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      const result = originalRemove(event, listener);
      if (!threw) {
        threw = true;
        throw new Error("fixture cleanup failure");
      }
      return result;
    }) as typeof socket.removeListener;
    const controller = new AbortController();
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      config,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_ABORTED",
    );
    assert.equal(socket.destroyCalls, 1);
  });
});

test("treats abort, timeout, EOF, invalid chunks, bounds, and write errors as fatal", async (t) => {
  await t.test("already aborted writes nothing", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    await assert.rejects(
      establishConnectivitySocks5Tunnel(
        socket,
        admitConnectivitySocks5Config(baseConfig()),
        controller.signal,
      ),
      (error: unknown) =>
        error instanceof ConnectivitySocks5Error &&
        error.code === "CONNECTIVITY_SOCKS5_ABORTED",
    );
    assert.equal(socket.writes.length, 0);
    assert.equal(socket.destroyCalls, 1);
  });

  await t.test("abort", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      admitConnectivitySocks5Config(baseConfig()),
      controller.signal,
    );
    controller.abort();
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_ABORTED");
    assert.equal(socket.destroyCalls, 1);
  });

  await t.test("timeout", async () => {
    const socket = new FakeSocket();
    const timers = manualScheduler();
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      admitConnectivitySocks5Config(baseConfig()),
      undefined,
      timers.scheduler,
    );
    timers.fire();
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_TIMEOUT");
  });

  for (const [name, event, code] of [
    ["EOF", "end", "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED"],
    ["close", "close", "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED"],
    ["socket error", "error", "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED"],
  ] as const) {
    await t.test(name, async () => {
      const socket = new FakeSocket();
      const pending = establishConnectivitySocks5Tunnel(
        socket,
        admitConnectivitySocks5Config(baseConfig()),
      );
      if (event === "error") socket.emit(event, new Error("socket failed"));
      else socket.emit(event);
      await assert.rejects(pending, (error: unknown) =>
        error instanceof ConnectivitySocks5Error && error.code === code);
    });
  }

  await t.test("non-buffer chunk", async () => {
    const socket = new FakeSocket();
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      admitConnectivitySocks5Config(baseConfig()),
    );
    socket.data("must not be decoded text");
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR");
  });

  await t.test("buffer bound", async () => {
    const socket = new FakeSocket();
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      admitConnectivitySocks5Config({
        ...baseConfig(),
        maxBufferedBytes: 8,
      }),
    );
    socket.data(Buffer.alloc(9));
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR");
  });

  await t.test("write failure releases token frame", async () => {
    const socket = new FakeSocket();
    socket.autoCompleteWrites = false;
    const pending = establishConnectivitySocks5Tunnel(
      socket,
      admitConnectivitySocks5Config(baseConfig()),
    );
    socket.completeWrite();
    socket.data(Buffer.from([0x05, 0x80]));
    assert.match(socket.writtenBuffers[1]!.toString("ascii"), /header\.payload\.signature/u);
    socket.completeWrite(new Error("failed"));
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ConnectivitySocks5Error &&
      error.code === "CONNECTIVITY_SOCKS5_WRITE_FAILED");
    assert.ok(socket.writtenBuffers[1]!.every((byte) => byte === 0));
  });
});
