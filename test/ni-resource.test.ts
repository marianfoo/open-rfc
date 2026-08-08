import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { encodeNiFrame, NiFrameDecoder } from "../src/protocol/ni.js";
import {
  NiSocketTransport,
  NiTransportError,
} from "../src/transport/ni-socket.js";

class TrackingEchoPeer {
  readonly server: Server;
  readonly sockets = new Set<Socket>();
  port = 0;
  accepted = 0;
  closed = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.accepted += 1;
      this.sockets.add(socket);
      socket.once("close", () => {
        this.closed += 1;
        this.sockets.delete(socket);
      });
      const decoder = new NiFrameDecoder(4_096);
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          socket.write(encodeNiFrame(frame));
        }
      });
    });
  }

  static async start(): Promise<TrackingEchoPeer> {
    const peer = new TrackingEchoPeer();
    await new Promise<void>((resolve, reject) => {
      peer.server.once("error", reject);
      peer.server.listen(0, "127.0.0.1", resolve);
    });
    const address = peer.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("resource peer did not bind a TCP address");
    }
    peer.port = address.port;
    return peer;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
}

async function waitForClosed(
  peer: TrackingEchoPeer,
  expected: number,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 100 && peer.closed !== expected;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(
    peer.closed,
    expected,
    "peer sockets did not close within the bound",
  );
}

test("resource harness returns every repeatedly opened NI socket", async (t) => {
  const peer = await TrackingEchoPeer.start();
  t.after(() => peer.close());

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const transport = await NiSocketTransport.connect({
      host: "127.0.0.1",
      port: peer.port,
      maxPayloadLength: 4_096,
    });
    const payload = Buffer.from(`resource-${iteration}`);
    await transport.send(payload);
    assert.deepEqual(await transport.receive({ timeoutMs: 1_000 }), payload);
    await transport.close();
  }

  await waitForClosed(peer, 64);
  assert.equal(peer.accepted, 64);
  assert.equal(peer.sockets.size, 0);
});

test("resource harness destroys every timed-out NI socket", async (t) => {
  const peer = await TrackingEchoPeer.start();
  t.after(() => peer.close());

  for (let iteration = 0; iteration < 16; iteration += 1) {
    const transport = await NiSocketTransport.connect({
      host: "127.0.0.1",
      port: peer.port,
    });
    await assert.rejects(
      transport.receive({ timeoutMs: 1 }),
      (error: unknown) =>
        error instanceof NiTransportError &&
        error.code === "NI_RECEIVE_TIMEOUT",
    );
  }

  await waitForClosed(peer, 16);
  assert.equal(peer.accepted, 16);
  assert.equal(peer.sockets.size, 0);
});
