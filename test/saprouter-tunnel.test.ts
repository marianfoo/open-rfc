import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { encodeNiFrame, NiFrameDecoder } from "../src/protocol/ni.js";
import { admitSapRouterRoute } from "../src/transport/saprouter-route.js";
import {
  SapRouterTransportError,
  connectSapRouterRoute,
  establishSapRouterRoute,
  type SapRouterRouteSocket,
  type SapRouterTimerScheduler,
} from "../src/transport/saprouter-tunnel.js";

type Assert<T extends true> = T;
type _NetSocketCompatibility = Assert<Socket extends SapRouterRouteSocket ? true : false>;

class FakeSocket extends EventEmitter implements SapRouterRouteSocket {
  readonly writes: Buffer[] = [];
  readonly writtenBuffers: Buffer[] = [];
  readonly pendingWriteCallbacks: ((error?: Error | null) => void)[] = [];
  autoCompleteWrites = true;
  destroyed = false;
  destroyCalls = 0;
  pauseCalls = 0;

  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    const view = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writtenBuffers.push(view);
    this.writes.push(Buffer.from(view));
    if (this.autoCompleteWrites) callback();
    else this.pendingWriteCallbacks.push(callback);
    return true;
  }

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }

  destroy(): this {
    this.destroyCalls += 1;
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

function manualScheduler(): {
  readonly scheduler: SapRouterTimerScheduler;
  readonly fire: () => void;
  readonly clearCount: () => number;
} {
  let callback: (() => void) | undefined;
  let clears = 0;
  const handle = Object.freeze({ timer: "manual" });
  const scheduler: SapRouterTimerScheduler = Object.freeze({
    setTimeout(next: () => void): object {
      callback = next;
      return handle;
    },
    clearTimeout(received: unknown): void {
      assert.equal(received, handle);
      callback = undefined;
      clears += 1;
    },
  });
  return Object.freeze({
    scheduler,
    fire(): void {
      const next = callback;
      callback = undefined;
      next?.();
    },
    clearCount: () => clears,
  });
}

function acceptedFrame(initialData: Uint8Array = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    encodeNiFrame(Buffer.from("NI_PONG\0", "ascii")),
    Buffer.from(initialData),
  ]);
}

function rejectedFrame(returnCode: number, detail: string): Buffer {
  const text = Buffer.from(detail, "ascii");
  const payload = Buffer.alloc(24 + text.length);
  payload.write("NI_RTERR\0", 0, "ascii");
  payload[9] = 40;
  payload[10] = 0;
  payload[11] = 0;
  payload.writeInt32BE(returnCode, 12);
  payload.writeUInt32BE(text.length, 16);
  text.copy(payload, 20);
  return encodeNiFrame(payload);
}

function deniedFrame(detail: string): Buffer {
  return rejectedFrame(-94, detail);
}

const ROUTE = "/H/router.example.test/S/3299/W/route-secret/H/target/S/sapgw00";

test("writes NI_ROUTE once and preserves fragmented and coalesced handoff bytes", async () => {
  const socket = new FakeSocket();
  const scheduler = manualScheduler();
  const pending = establishSapRouterRoute(
    socket,
    admitSapRouterRoute(ROUTE),
    { timeoutMs: 5_000 },
    undefined,
    scheduler.scheduler,
  );

  assert.equal(socket.writes.length, 1);
  const decoder = new NiFrameDecoder();
  const request = decoder.push(socket.writes[0]!);
  decoder.finish();
  assert.equal(request.length, 1);
  assert.equal(request[0]!.subarray(0, 9).toString("ascii"), "NI_ROUTE\0");
  assert.match(request[0]!.toString("ascii"), /route-secret/u);
  assert.ok(socket.writtenBuffers[0]!.every((byte) => byte === 0));

  const response = acceptedFrame(Buffer.from([0, 0, 0, 3, 0x52, 0x46, 0x43]));
  socket.data(response.subarray(0, 2));
  socket.data(response.subarray(2, 9));
  socket.data(response.subarray(9));
  const established = await pending;

  assert.equal(established.socket, socket);
  assert.deepEqual(
    established.initialData,
    Buffer.from([0, 0, 0, 3, 0x52, 0x46, 0x43]),
  );
  assert.equal(established.hopCount, 2);
  assert.equal(socket.pauseCalls, 1);
  assert.equal(socket.destroyCalls, 0);
  assert.equal(scheduler.clearCount(), 1);
  assert.doesNotMatch(JSON.stringify(established), /route-secret/u);
});

test("maps a denied route to a redaction-safe typed error", async () => {
  const socket = new FakeSocket();
  const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
  socket.data(deniedFrame("route-secret must never escape in diagnostics"));

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof SapRouterTransportError);
    assert.equal(error.code, "SAPROUTER_ROUTE_DENIED");
    assert.equal(error.routerReturnCode, -94);
    assert.doesNotMatch(error.message, /route-secret/u);
    assert.doesNotMatch(JSON.stringify(error), /route-secret/u);
    return true;
  });
  assert.equal(socket.destroyCalls, 1);
});

test("treats timeout, abort, EOF, write failure, and malformed bounds as fatal", async (t) => {
  await t.test("timeout", async () => {
    const socket = new FakeSocket();
    const timer = manualScheduler();
    const pending = establishSapRouterRoute(
      socket,
      admitSapRouterRoute(ROUTE),
      { timeoutMs: 10 },
      undefined,
      timer.scheduler,
    );
    timer.fire();
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_HANDSHAKE_TIMEOUT");
    assert.equal(socket.destroyCalls, 1);
  });

  await t.test("abort", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const pending = establishSapRouterRoute(
      socket,
      admitSapRouterRoute(ROUTE),
      undefined,
      controller.signal,
    );
    controller.abort(new Error("cancel"));
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_ABORTED");
    assert.equal(socket.destroyCalls, 1);
  });

  await t.test("already aborted sends nothing", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      establishSapRouterRoute(
        socket,
        admitSapRouterRoute(ROUTE),
        undefined,
        controller.signal,
      ),
      (error: unknown) =>
        error instanceof SapRouterTransportError &&
        error.code === "SAPROUTER_ABORTED",
    );
    assert.equal(socket.writes.length, 0);
  });

  await t.test("EOF", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.emit("end");
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_CONNECTION_CLOSED");
  });

  await t.test("write failure", async () => {
    const socket = new FakeSocket();
    socket.autoCompleteWrites = false;
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.pendingWriteCallbacks.shift()!(new Error("write failed"));
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_WRITE_FAILED");
  });

  await t.test("oversized declared response", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(
      socket,
      admitSapRouterRoute(ROUTE),
      { maxResponsePayloadBytes: 32 },
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(33);
    socket.data(header);
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_PROTOCOL_ERROR");
  });

  await t.test("non-buffer input", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.data("encoded text must not be accepted");
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_PROTOCOL_ERROR");
  });
});

test("validates a route fully before invoking the first-hop connector", async () => {
  let calls = 0;
  await assert.rejects(
    connectSapRouterRoute(
      "/H/router.example.test/W/secret",
      undefined,
      undefined,
      {
        connect: async (): Promise<FakeSocket> => {
          calls += 1;
          return new FakeSocket();
        },
      },
    ),
    /SAProuter route string/u,
  );
  assert.equal(calls, 0);

  const socket = new FakeSocket();
  const pending = connectSapRouterRoute(
    ROUTE,
    undefined,
    undefined,
    {
      connect: async (endpoint): Promise<FakeSocket> => {
        calls += 1;
        assert.deepEqual(endpoint, {
          host: "router.example.test",
          service: "3299",
          usesDefaultService: false,
        });
        assert.doesNotMatch(JSON.stringify(endpoint), /route-secret/u);
        return socket;
      },
    },
  );
  await Promise.resolve();
  socket.data(acceptedFrame());
  const result = await pending;
  assert.equal(result.socket, socket);
  assert.equal(calls, 1);
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("connects the numeric first hop and hands the routed socket back paused", async (t) => {
  const server = createServer((socket) => {
    const decoder = new NiFrameDecoder();
    socket.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      assert.equal(frames[0]!.subarray(0, 9).toString("ascii"), "NI_ROUTE\0");
      socket.write(acceptedFrame());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  const result = await connectSapRouterRoute(
    `/H/127.0.0.1/S/${address.port}/H/target.internal/S/sapgw00`,
    { connectTimeoutMs: 1_000, handshakeTimeoutMs: 1_000 },
  );
  assert.equal(result.hopCount, 2);
  assert.equal(result.socket.destroyed, false);
  result.socket.destroy();
});

test("rejects malformed handshake options, schedulers, and socket seams before writing", () => {
  const route = admitSapRouterRoute(ROUTE);
  for (const invalidSocket of [null, {}]) {
    assert.throws(
      () => establishSapRouterRoute(invalidSocket as never, route),
      /byte-stream socket/u,
    );
  }

  const invalidOptions: ReadonlyArray<readonly [unknown, RegExp]> = [
    [null, /handshake options must be an object/u],
    [{ timeoutMs: 0 }, /timeoutMs must be an integer/u],
    [{ timeoutMs: 1.5 }, /timeoutMs must be an integer/u],
    [{ timeoutMs: 300_001 }, /timeoutMs must be an integer/u],
    [{ maxResponsePayloadBytes: 7 }, /maxResponsePayloadBytes must be an integer/u],
    [{ maxResponsePayloadBytes: 1.5 }, /maxResponsePayloadBytes must be an integer/u],
    [{ maxResponsePayloadBytes: 1_048_577 }, /maxResponsePayloadBytes must be an integer/u],
    [{ niVersion: 0 }, /niVersion must be an integer/u],
    [{ niVersion: 1.5 }, /niVersion must be an integer/u],
    [{ niVersion: 256 }, /niVersion must be an integer/u],
  ];
  for (const [input, expected] of invalidOptions) {
    const socket = new FakeSocket();
    assert.throws(
      () => establishSapRouterRoute(socket, route, input as never),
      expected,
    );
    assert.equal(socket.writes.length, 0);
  }

  for (const scheduler of [null, {}, { setTimeout() {} }, { clearTimeout() {} }]) {
    const socket = new FakeSocket();
    assert.throws(
      () => establishSapRouterRoute(
        socket,
        route,
        undefined,
        undefined,
        scheduler as never,
      ),
      /scheduler/u,
    );
    assert.equal(socket.writes.length, 0);
  }
});

test("maps every terminal handshake seam once and keeps route secrets redacted", async (t) => {
  await t.test("stream error", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    const cause = Object.freeze({ reason: "synthetic" });
    socket.emit("error", cause);
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_CONNECTION_CLOSED" &&
      error.cause === cause);
    assert.equal(socket.destroyCalls, 1);
  });

  await t.test("truncated EOF", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.data(Buffer.from([0, 0]));
    socket.emit("end");
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_PROTOCOL_ERROR");
  });

  await t.test("close without destroy replay", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.emit("close");
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_CONNECTION_CLOSED");
    assert.equal(socket.destroyCalls, 0);
  });

  await t.test("undersized response", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(7);
    socket.data(header);
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_PROTOCOL_ERROR");
  });

  await t.test("pause failure", async () => {
    class UnpausableSocket extends FakeSocket {
      override pause(): this { throw new Error("synthetic pause failure"); }
    }
    const socket = new UnpausableSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.data(acceptedFrame());
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_PROTOCOL_ERROR");
  });

  await t.test("non-denial rejection", async () => {
    const socket = new FakeSocket();
    const pending = establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE));
    socket.data(rejectedFrame(-5, "route-secret must remain private"));
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof SapRouterTransportError);
      assert.equal(error.code, "SAPROUTER_ROUTE_REJECTED");
      assert.equal(error.routerReturnCode, -5);
      assert.doesNotMatch(JSON.stringify(error), /route-secret/u);
      return true;
    });
  });

  await t.test("listener registration failure", async () => {
    class ListenerRejectingSocket extends FakeSocket {
      override on(): this { throw new Error("synthetic listener rejection"); }
    }
    const socket = new ListenerRejectingSocket();
    await assert.rejects(
      establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE)),
      (error: unknown) =>
        error instanceof SapRouterTransportError &&
        error.code === "SAPROUTER_CONNECTION_CLOSED",
    );
    assert.equal(socket.writes.length, 0);
  });

  await t.test("timer scheduler failure", async () => {
    const socket = new FakeSocket();
    const scheduler: SapRouterTimerScheduler = {
      setTimeout(): never { throw new Error("synthetic timer rejection"); },
      clearTimeout() { /* fixture */ },
    };
    await assert.rejects(
      establishSapRouterRoute(
        socket,
        admitSapRouterRoute(ROUTE),
        undefined,
        undefined,
        scheduler,
      ),
      (error: unknown) =>
        error instanceof SapRouterTransportError &&
        error.code === "SAPROUTER_HANDSHAKE_TIMEOUT",
    );
    assert.equal(socket.writes.length, 0);
  });

  await t.test("synchronous write failure", async () => {
    class WriteRejectingSocket extends FakeSocket {
      override write(): boolean { throw new Error("synthetic write rejection"); }
    }
    const socket = new WriteRejectingSocket();
    await assert.rejects(
      establishSapRouterRoute(socket, admitSapRouterRoute(ROUTE)),
      (error: unknown) =>
        error instanceof SapRouterTransportError &&
        error.code === "SAPROUTER_WRITE_FAILED",
    );
  });

  await t.test("synchronous timer expiry", async () => {
    const handle = Object.freeze({ timer: "synchronous" });
    let clearCalls = 0;
    const scheduler: SapRouterTimerScheduler = {
      setTimeout(callback) { callback(); return handle; },
      clearTimeout(received) { assert.equal(received, handle); clearCalls += 1; },
    };
    const socket = new FakeSocket();
    await assert.rejects(
      establishSapRouterRoute(
        socket,
        admitSapRouterRoute(ROUTE),
        undefined,
        undefined,
        scheduler,
      ),
      (error: unknown) =>
        error instanceof SapRouterTransportError &&
        error.code === "SAPROUTER_HANDSHAKE_TIMEOUT",
    );
    assert.equal(clearCalls, 1);
    assert.equal(socket.writes.length, 0);
  });
});

test("rejects malformed connect boundaries and post-connect aborts before NI_ROUTE", async () => {
  const invalidOptions: ReadonlyArray<readonly [unknown, RegExp]> = [
    [null, /connect options must be an object/u],
    [{ family: 5 }, /family must be 4 or 6/u],
    [{ connectTimeoutMs: 0 }, /connectTimeoutMs must be an integer/u],
    [{ connectTimeoutMs: 1.5 }, /connectTimeoutMs must be an integer/u],
    [{ connectTimeoutMs: 300_001 }, /connectTimeoutMs must be an integer/u],
  ];
  let connectorCalls = 0;
  for (const [options, expected] of invalidOptions) {
    await assert.rejects(
      connectSapRouterRoute(
        ROUTE,
        options as never,
        undefined,
        { connect: async () => { connectorCalls += 1; return new FakeSocket(); } },
      ),
      expected,
    );
  }
  assert.equal(connectorCalls, 0);

  for (const dependencies of [null, { connect: 1 }, { scheduler: {} }]) {
    await assert.rejects(
      connectSapRouterRoute(ROUTE, undefined, undefined, dependencies as never),
      /dependencies|connector|scheduler/u,
    );
  }

  for (const route of [
    "/H/router.example.test/S/notnumeric/H/target/S/3300",
    "/H/router.example.test/S/00000/H/target/S/3300",
    "/H/[not-v6]/S/3299/H/target/S/3300",
  ]) {
    await assert.rejects(
      connectSapRouterRoute(route),
      (error: unknown) => error instanceof SapRouterTransportError,
    );
  }

  await assert.rejects(
    connectSapRouterRoute(ROUTE, undefined, undefined, {
      connect: async () => null as never,
    }),
    (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_CONNECT_FAILED",
  );

  let invalidDestroyCalls = 0;
  await assert.rejects(
    connectSapRouterRoute(ROUTE, undefined, undefined, {
      connect: async () => ({
        destroy() { invalidDestroyCalls += 1; },
      }) as never,
    }),
    (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_CONNECT_FAILED",
  );
  assert.equal(invalidDestroyCalls, 1);

  const preAborted = new AbortController();
  preAborted.abort("stop");
  await assert.rejects(
    connectSapRouterRoute(
      ROUTE,
      undefined,
      preAborted.signal,
      { connect: async () => { connectorCalls += 1; return new FakeSocket(); } },
    ),
    (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_ABORTED",
  );

  const duringConnect = new AbortController();
  const connected = new FakeSocket();
  await assert.rejects(
    connectSapRouterRoute(ROUTE, undefined, duringConnect.signal, {
      connect: async () => {
        duringConnect.abort("stop");
        return connected;
      },
    }),
    (error: unknown) =>
      error instanceof SapRouterTransportError &&
      error.code === "SAPROUTER_ABORTED",
  );
  assert.equal(connected.destroyCalls, 1);
});
