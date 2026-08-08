import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { encodeNiFrame } from "../src/protocol/ni.js";
import {
  NiSocketTransport,
  NiTransportError,
  type NiConnectedSocket,
  type NiTimerScheduler,
} from "../src/transport/ni-socket.js";

class FakeTimerScheduler implements NiTimerScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #nextId = 1;

  get pendingCount(): number {
    return this.#callbacks.size;
  }

  setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#callbacks.delete(handle);
  }

  runNext(): void {
    const next = this.#callbacks.entries().next();
    if (next.done) throw new Error("fake scheduler has no pending timer");
    const [id, callback] = next.value;
    this.#callbacks.delete(id);
    callback();
  }
}

class SynchronousTimerScheduler implements NiTimerScheduler {
  clearCount = 0;

  setTimeout(callback: () => void, _delayMs: number): object {
    const handle = {};
    callback();
    return handle;
  }

  clearTimeout(_handle: object): void {
    this.clearCount += 1;
  }
}

class ThrowingClearTimerScheduler implements NiTimerScheduler {
  #callback: (() => void) | undefined;

  setTimeout(callback: () => void, _delayMs: number): object {
    this.#callback = callback;
    return {};
  }

  clearTimeout(_handle: number | object): void {
    throw new Error("synthetic clear failure");
  }

  fire(): void {
    const callback = this.#callback;
    this.#callback = undefined;
    if (callback === undefined) throw new Error("no scheduled callback");
    callback();
  }
}

function stalledSocket(): {
  readonly socket: NiConnectedSocket;
  readonly writes: Buffer[];
  readonly state: { destroyed: boolean; endCalls: number };
} {
  const listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();
  const writes: Buffer[] = [];
  const state = { destroyed: false, endCalls: 0 };
  let paused = true;
  const socket = {
    get destroyed() { return state.destroyed; },
    closed: false,
    readableEnded: false,
    writableEnded: false,
    isPaused: () => paused,
    pause() { paused = true; },
    resume() { paused = false; },
    destroy() { state.destroyed = true; },
    end() { state.endCalls += 1; },
    write(chunk: Uint8Array, _callback: (error?: Error | null) => void) {
      writes.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
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

async function listen(
  handler: (socket: Socket) => void = () => undefined,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

test("deterministically resolves receive timeout before a later cancellation", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const scheduler = new FakeTimerScheduler();
  const transport = await NiSocketTransport.connect(
    { host: "127.0.0.1", port, connectTimeoutMs: 0 },
    undefined,
    scheduler,
  );
  const controller = new AbortController();

  const pending = transport.receive({
    timeoutMs: 100,
    signal: controller.signal,
  });
  assert.equal(scheduler.pendingCount, 1);
  scheduler.runNext();
  controller.abort("late cancellation");

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_RECEIVE_TIMEOUT",
  );
  await assert.rejects(
    transport.receive(),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_RECEIVE_TIMEOUT",
  );
});

test("deterministically resolves cancellation before a later receive timeout", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const scheduler = new FakeTimerScheduler();
  const transport = await NiSocketTransport.connect(
    { host: "127.0.0.1", port, connectTimeoutMs: 0 },
    undefined,
    scheduler,
  );
  const controller = new AbortController();

  const pending = transport.receive({
    timeoutMs: 100,
    signal: controller.signal,
  });
  assert.equal(scheduler.pendingCount, 1);
  controller.abort("first cancellation");
  assert.equal(scheduler.pendingCount, 0);

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  await assert.rejects(
    transport.receive(),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
});

test("clears a deterministic receive timer when peer data wins the race", async (t) => {
  const { server, port } = await listen((socket) => {
    socket.write(encodeNiFrame(Buffer.from("ready")));
  });
  t.after(() => closeServer(server));
  const scheduler = new FakeTimerScheduler();
  const transport = await NiSocketTransport.connect(
    { host: "127.0.0.1", port, connectTimeoutMs: 0 },
    undefined,
    scheduler,
  );

  assert.equal(
    (await transport.receive({ timeoutMs: 100 })).toString(),
    "ready",
  );
  assert.equal(scheduler.pendingCount, 0);
  assert.equal(transport.state, "open");
  await transport.close();
});

test("rejects an invalid injected scheduler before opening a socket", async () => {
  await assert.rejects(
    NiSocketTransport.connect(
      { host: "127.0.0.1", port: 1, connectTimeoutMs: 0 },
      undefined,
      {} as NiTimerScheduler,
    ),
    /scheduler must provide setTimeout and clearTimeout/,
  );
});

test("settles and clears a receive timer even when a scheduler fires synchronously", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const scheduler = new SynchronousTimerScheduler();
  const transport = await NiSocketTransport.connect(
    { host: "127.0.0.1", port, connectTimeoutMs: 0 },
    undefined,
    scheduler,
  );

  await assert.rejects(
    transport.receive({ timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_RECEIVE_TIMEOUT",
  );
  assert.equal(transport.state, "closed");
  assert.equal(scheduler.clearCount, 1);
});

test("settles and clears a connect timer even when a scheduler fires synchronously", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const scheduler = new SynchronousTimerScheduler();

  await assert.rejects(
    NiSocketTransport.connect(
      { host: "127.0.0.1", port, connectTimeoutMs: 100 },
      undefined,
      scheduler,
    ),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_CONNECT_TIMEOUT",
  );
  assert.equal(scheduler.clearCount, 1);
});

test("a throwing timer cleanup cannot strand connect settlement", async (t) => {
  const { server, port } = await listen();
  t.after(() => closeServer(server));
  const scheduler = new ThrowingClearTimerScheduler();
  const connection = NiSocketTransport.connect(
    { host: "127.0.0.1", port, connectTimeoutMs: 100 },
    undefined,
    scheduler,
  );
  scheduler.fire();

  await assert.rejects(
    connection,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_CONNECT_TIMEOUT",
  );
});

test("bounds a stalled NI write and wipes its framed request", async () => {
  const scheduler = new FakeTimerScheduler();
  const stalled = stalledSocket();
  const transport = NiSocketTransport.adopt(
    { socket: stalled.socket, writeTimeoutMs: 100 },
    undefined,
    scheduler,
  );
  const write = transport.send(Buffer.from("sensitive request"));
  assert.equal(scheduler.pendingCount, 1);
  scheduler.runNext();
  await assert.rejects(
    write,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_WRITE_TIMEOUT",
  );
  assert.equal(stalled.state.destroyed, true);
  assert.equal(stalled.writes.length, 1);
  assert.equal(stalled.writes[0]!.every((byte) => byte === 0), true);
});

test("bounds graceful close and discards queued business payloads", async () => {
  const scheduler = new FakeTimerScheduler();
  const stalled = stalledSocket();
  const transport = NiSocketTransport.adopt(
    {
      socket: stalled.socket,
      initialData: encodeNiFrame(Buffer.from("queued business payload")),
      closeTimeoutMs: 100,
    },
    undefined,
    scheduler,
  );
  const closing = transport.close();
  assert.equal(stalled.state.endCalls, 1);
  assert.equal(scheduler.pendingCount, 1);
  scheduler.runNext();
  await closing;
  assert.equal(stalled.state.destroyed, true);
  assert.equal(transport.state, "closed");
  await assert.rejects(
    transport.receive(),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_CONNECTION_CLOSED",
  );
});
