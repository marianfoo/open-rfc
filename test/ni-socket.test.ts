import assert from "node:assert/strict";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import test from "node:test";

import { encodeNiFrame, NiFrameDecoder } from "../src/protocol/ni.js";
import {
  NiSocketTransport,
  NiTransportError,
  type NiConnectedSocket,
} from "../src/transport/ni-socket.js";

async function listen(
  handler: (socket: Socket) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function synchronousResumeSocket(
  mode: "abort" | "close" | "error",
  controller?: AbortController,
): NiConnectedSocket {
  const listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();
  let destroyed = false;
  let closed = false;
  const emit = (event: string, ...arguments_: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...arguments_);
  };
  const socket = {
    get destroyed() { return destroyed; },
    get closed() { return closed; },
    readableEnded: false,
    writableEnded: false,
    isPaused: () => true,
    pause() {},
    resume() {
      if (mode === "abort") controller?.abort(new Error("resume aborted"));
      else if (mode === "error") emit("error", new Error("resume failed"));
      else {
        closed = true;
        emit("close");
      }
    },
    destroy() { destroyed = true; },
    end() { closed = true; },
    write(_chunk: Uint8Array, callback: (error?: Error | null) => void) {
      callback();
      return true;
    },
    on(event: string, listener: (...arguments_: unknown[]) => void) {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
      return socket;
    },
    once(event: string, listener: (...arguments_: unknown[]) => void) {
      return socket.on(event, listener);
    },
  };
  return socket as unknown as NiConnectedSocket;
}

function instrumentedPausedSocket(): {
  readonly socket: NiConnectedSocket;
  readonly writes: Buffer[];
  readonly state: {
    destroyed: boolean;
    pauseCalls: number;
    resumeCalls: number;
  };
} {
  const listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();
  const writes: Buffer[] = [];
  const state = { destroyed: false, pauseCalls: 0, resumeCalls: 0 };
  let paused = true;
  const socket = {
    get destroyed() { return state.destroyed; },
    closed: false,
    readableEnded: false,
    writableEnded: false,
    isPaused: () => paused,
    pause() {
      state.pauseCalls += 1;
      paused = true;
    },
    resume() {
      state.resumeCalls += 1;
      paused = false;
    },
    destroy() { state.destroyed = true; },
    end() {},
    write(chunk: Uint8Array, callback: (error?: Error | null) => void) {
      writes.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      callback();
      return true;
    },
    on(event: string, listener: (...arguments_: unknown[]) => void) {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
      return socket;
    },
    once(event: string, listener: (...arguments_: unknown[]) => void) {
      return socket.on(event, listener);
    },
  };
  return { socket: socket as NiConnectedSocket, writes, state };
}

test("sends NI frames and receives fragmented and coalesced responses", async (t) => {
  const received: Buffer[] = [];
  const { server, port } = await listen((socket) => {
    const decoder = new NiFrameDecoder();
    socket.on("data", (chunk) => received.push(...decoder.push(chunk)));
    const first = encodeNiFrame(Buffer.from("first"));
    const secondAndThird = Buffer.concat([
      encodeNiFrame(Buffer.from("second")),
      encodeNiFrame(Buffer.from("third")),
    ]);
    socket.write(first.subarray(0, 2));
    setImmediate(() => {
      socket.write(first.subarray(2));
      socket.write(secondAndThird);
    });
  });
  t.after(() => closeServer(server));

  const transport = await NiSocketTransport.connect({ host: "127.0.0.1", port });
  await transport.send(Buffer.from("request"));
  assert.equal((await transport.receive({ timeoutMs: 1_000 })).toString(), "first");
  assert.equal((await transport.receive()).toString(), "second");
  assert.equal((await transport.receive()).toString(), "third");
  assert.deepEqual(received.map((value) => value.toString()), ["request"]);
  assert.equal(transport.state, "open");
  await transport.close();
  assert.equal(transport.state, "closed");
});

test("adopts a paused routed socket without losing coalesced or buffered frames", async (t) => {
  const peerRequests: Buffer[] = [];
  let resolveRequest!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  const { server, port } = await listen((socket) => {
    const decoder = new NiFrameDecoder();
    socket.on("data", (chunk) => {
      peerRequests.push(...decoder.push(chunk));
      if (peerRequests.length > 0) resolveRequest();
    });
    setImmediate(() => socket.write(encodeNiFrame(Buffer.from("buffered"))));
  });
  t.after(() => closeServer(server));

  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.pause();
  const expectedLocalAddress = socket.localAddress;
  const expectedLocalPort = socket.localPort;
  const expectedRemoteAddress = socket.remoteAddress;
  const expectedRemotePort = socket.remotePort;
  const transport = NiSocketTransport.adopt({
    socket,
    initialData: encodeNiFrame(Buffer.from("coalesced")),
  });

  assert.equal(transport.localAddress, expectedLocalAddress);
  assert.equal(transport.localPort, expectedLocalPort);
  assert.equal(transport.remoteAddress, expectedRemoteAddress);
  assert.equal(transport.remotePort, expectedRemotePort);
  assert.equal((await transport.receive()).toString(), "coalesced");
  assert.equal(
    (await transport.receive({ timeoutMs: 1_000 })).toString(),
    "buffered",
  );
  await transport.send(Buffer.from("request"));
  await requestReceived;
  assert.deepEqual(peerRequests.map((value) => value.toString()), ["request"]);
  await transport.close();
});

test("bounds queued complete frames and applies socket backpressure", async () => {
  const bounded = instrumentedPausedSocket();
  assert.throws(
    () => NiSocketTransport.adopt({
      socket: bounded.socket,
      initialData: Buffer.concat([
        encodeNiFrame(Buffer.from("one")),
        encodeNiFrame(Buffer.from("two")),
      ]),
      maxQueuedFrameCount: 1,
    }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_PROTOCOL_ERROR",
  );
  assert.equal(bounded.state.destroyed, true);

  const paused = instrumentedPausedSocket();
  const transport = NiSocketTransport.adopt({
    socket: paused.socket,
    initialData: encodeNiFrame(Buffer.from("queued")),
  });
  assert.equal(paused.state.pauseCalls, 1);
  assert.equal(paused.state.resumeCalls, 0);
  assert.equal((await transport.receive()).toString(), "queued");
  assert.equal(paused.state.resumeCalls, 1);
});

test("an already-aborted receive retires queued data instead of delivering it", async () => {
  const instrumented = instrumentedPausedSocket();
  const transport = NiSocketTransport.adopt({
    socket: instrumented.socket,
    initialData: encodeNiFrame(Buffer.from("late")),
  });
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));

  await assert.rejects(
    transport.receive({ signal: controller.signal }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(transport.state, "closed");
  assert.equal(instrumented.state.destroyed, true);
});

test("retires a synchronous request boundary with an unread complete frame", () => {
  const instrumented = instrumentedPausedSocket();
  const transport = NiSocketTransport.adopt({
    socket: instrumented.socket,
    initialData: encodeNiFrame(Buffer.from("stale-response")),
  });

  assert.throws(
    () => transport.assertNoQueuedFrames(),
    (error: unknown) =>
      error instanceof NiTransportError &&
      error.code === "NI_PROTOCOL_ERROR" &&
      /request boundary/u.test(error.message),
  );
  assert.equal(transport.state, "closed");
  assert.equal(instrumented.state.destroyed, true);
  assert.deepEqual(instrumented.writes, []);
});

test("rejects a decoded frame batch atomically before resolving a pending receive", async (t) => {
  let sendBatch!: () => void;
  let peerReady!: () => void;
  const ready = new Promise<void>((resolve) => { peerReady = resolve; });
  const { server, port } = await listen((socket) => {
    sendBatch = () => socket.write(Buffer.concat([
      encodeNiFrame(Buffer.from("expected")),
      encodeNiFrame(Buffer.from("queued")),
      encodeNiFrame(Buffer.from("overflow")),
    ]));
    peerReady();
  });
  t.after(() => closeServer(server));
  const transport = await NiSocketTransport.connect({
    host: "127.0.0.1",
    port,
    maxQueuedFrameCount: 1,
  });
  await ready;
  const pending = transport.receive({ timeoutMs: 1_000 });
  sendBatch();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_PROTOCOL_ERROR",
  );
  assert.equal(transport.state, "closed");
});

test("wipes the retained NI frame copy after a completed write", async () => {
  const instrumented = instrumentedPausedSocket();
  const transport = NiSocketTransport.adopt({ socket: instrumented.socket });
  await transport.send(Buffer.from("credential material"));
  assert.equal(instrumented.writes.length, 1);
  assert.equal(instrumented.writes[0]!.every((byte) => byte === 0), true);
});

test("fails closed when an adopted socket is flowing, aborted, or malformed", async (t) => {
  const sockets = new Set<Socket>();
  const { server, port } = await listen((socket) => sockets.add(socket));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });

  async function connectedSocket(): Promise<Socket> {
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  const flowing = await connectedSocket();
  assert.equal(flowing.isPaused(), false);
  assert.throws(
    () => NiSocketTransport.adopt({ socket: flowing }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_PROTOCOL_ERROR",
  );
  assert.equal(flowing.destroyed, true);

  const abortedSocket = await connectedSocket();
  abortedSocket.pause();
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  assert.throws(
    () => NiSocketTransport.adopt({ socket: abortedSocket }, controller.signal),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(abortedSocket.destroyed, true);

  const malformedSocket = await connectedSocket();
  malformedSocket.pause();
  assert.throws(
    () => NiSocketTransport.adopt({
      socket: malformedSocket,
      initialData: Buffer.from("ffffffff", "hex"),
    }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_PROTOCOL_ERROR",
  );
  assert.equal(malformedSocket.destroyed, true);

  const invalidInitialDataSocket = await connectedSocket();
  invalidInitialDataSocket.pause();
  assert.throws(
    () => NiSocketTransport.adopt({
      socket: invalidInitialDataSocket,
      initialData: "not-bytes" as unknown as Uint8Array,
    }),
    /initialData must be a Uint8Array/u,
  );
  assert.equal(invalidInitialDataSocket.destroyed, true);

  const terminalSocket = await connectedSocket();
  terminalSocket.pause();
  const terminalClosed = new Promise<void>((resolve) =>
    terminalSocket.once("close", () => resolve())
  );
  terminalSocket.destroy();
  await terminalClosed;
  assert.throws(
    () => NiSocketTransport.adopt({ socket: terminalSocket }),
    (error: unknown) =>
      error instanceof NiTransportError &&
      error.code === "NI_CONNECTION_CLOSED",
  );
});

test("rejects synchronous close, error, and abort emitted by resume", () => {
  for (const mode of ["close", "error"] as const) {
    const socket = synchronousResumeSocket(mode);
    assert.throws(
      () => NiSocketTransport.adopt({ socket }),
      (error: unknown) =>
        error instanceof NiTransportError &&
        error.code === "NI_CONNECTION_CLOSED",
      mode,
    );
    assert.equal(socket.destroyed, true);
  }

  const controller = new AbortController();
  const socket = synchronousResumeSocket("abort", controller);
  assert.throws(
    () => NiSocketTransport.adopt({ socket }, controller.signal),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(socket.destroyed, true);
});

test("makes receive timeouts fatal so late replies cannot cross calls", async (t) => {
  const { server, port } = await listen(() => undefined);
  t.after(() => closeServer(server));
  const transport = await NiSocketTransport.connect({ host: "127.0.0.1", port });

  await assert.rejects(
    transport.receive({ timeoutMs: 10 }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_RECEIVE_TIMEOUT",
  );
  assert.equal(transport.state, "closed");
  await assert.rejects(
    transport.receive(),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_RECEIVE_TIMEOUT",
  );
});

test("aborts a pending receive and rejects concurrent receives", async (t) => {
  const { server, port } = await listen(() => undefined);
  t.after(() => closeServer(server));
  const transport = await NiSocketTransport.connect({ host: "127.0.0.1", port });
  const controller = new AbortController();
  const pending = transport.receive({ signal: controller.signal });
  await assert.rejects(transport.receive(), /only one NI receive may be pending/);
  controller.abort(new Error("test cancellation"));
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(transport.state, "closed");
});

test("rejects a truncated peer stream as a protocol error", async (t) => {
  const { server, port } = await listen((socket) => {
    socket.end(Buffer.from("000000056162", "hex"));
  });
  t.after(() => closeServer(server));
  const transport = await NiSocketTransport.connect({ host: "127.0.0.1", port });

  await assert.rejects(
    transport.receive({ timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_PROTOCOL_ERROR",
  );
});

test("validates endpoints and honors an already-aborted connection signal", async () => {
  await assert.rejects(
    NiSocketTransport.connect({ host: "", port: 1 }),
    /host must not be empty/,
  );
  await assert.rejects(
    NiSocketTransport.connect({ host: "localhost", port: 65_536 }),
    /port must be an integer in 1\.\.65535/,
  );
  await assert.rejects(
    NiSocketTransport.connect({ host: "localhost", port: 1, family: 5 as 4 }),
    /family must be 4 or 6/,
  );
  await assert.rejects(
    NiSocketTransport.connect({
      host: "localhost",
      port: 1,
      maxPayloadLength: -1,
    }),
    /maxPayloadLength must be a non-negative safe integer/,
  );
  const controller = new AbortController();
  controller.abort("cancelled");
  await assert.rejects(
    NiSocketTransport.connect(
      { host: "127.0.0.1", port: 1 },
      controller.signal,
    ),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
});
