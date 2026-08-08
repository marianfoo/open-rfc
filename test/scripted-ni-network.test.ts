import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { encodeNiFrame } from "../src/protocol/ni.js";
import {
  NiSocketTransport,
  NiTransportError,
  type NiTransportErrorCode,
} from "../src/transport/ni-socket.js";
import {
  defineNiPeerCases,
  defineNiProxyCases,
  niPeerStep,
  niProxyStep,
  niWire,
  ScriptedNiPeer,
  ScriptedNiProxy,
} from "./support/scripted-ni-network.js";

async function rejectsWithTransportCode(
  operation: Promise<unknown>,
  code: NiTransportErrorCode,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === code,
  );
}

test("script catalogs are bounded, uniquely named, and explicitly selected", async () => {
  const cases = defineNiPeerCases({
    name: "selected-case",
    steps: [niPeerStep.eof()],
  });

  assert.throws(
    () =>
      defineNiPeerCases(
        { name: "duplicate", steps: [] },
        { name: "duplicate", steps: [] },
      ),
    /duplicate scripted NI case/,
  );
  assert.throws(
    () => defineNiPeerCases({ name: "NOT_VALID", steps: [] }),
    /case name must match/,
  );
  assert.throws(
    () =>
      defineNiPeerCases({
        name: "unbounded-delay",
        steps: [niPeerStep.delay(5_001)],
      }),
    /milliseconds must be an integer in 0\.\.5000/,
  );
  assert.throws(
    () => defineNiPeerCases({ name: "zero-timeout", timeoutMs: 0, steps: [] }),
    /timeoutMs must be an integer in 1\.\.5000/,
  );
  assert.throws(
    () => defineNiProxyCases({ name: "zero-timeout", timeoutMs: 0, steps: [] }),
    /timeoutMs must be an integer in 1\.\.5000/,
  );
  assert.throws(
    () =>
      defineNiPeerCases({
        name: "zero-step-timeout",
        steps: [niPeerStep.expectFrame(undefined, 0)],
      }),
    /timeoutMs must be an integer in 1\.\.5000/,
  );
  assert.throws(
    () =>
      defineNiPeerCases({
        name: "unbounded-duplicate",
        steps: [niPeerStep.duplicate(niWire.raw(Buffer.from([0])), 17)],
      }),
    /copies must be an integer in 2\.\.16/,
  );
  await assert.rejects(
    ScriptedNiPeer.start(cases, "missing-case"),
    /unknown scripted NI case/,
  );
});

test("a scripted peer timeout aborts the active synthetic connection", async (t) => {
  const cases = defineNiPeerCases({
    name: "bounded-timeout",
    steps: [niPeerStep.expectFrame(Buffer.from("never-sent"))],
  });
  const peer = await ScriptedNiPeer.start(cases, "bounded-timeout");
  t.after(() => peer.close());
  const transport = await NiSocketTransport.connect({
    host: peer.host,
    port: peer.port,
  });
  t.after(() => transport.close());

  await assert.rejects(peer.done(5), /timed out after 5 ms/);
  await rejectsWithTransportCode(
    transport.receive({ timeoutMs: 1_000 }),
    "NI_CONNECTION_CLOSED",
  );
  assert.equal(transport.state, "closed");
});

test("scripted peer observes requests and delivers delayed split, short-written, and coalesced frames", async (t) => {
  const request = Buffer.from("request");
  const splitPayload = Buffer.from("split");
  const shortPayload = Buffer.from("short-write");
  const coalescedOne = Buffer.from("coalesced-one");
  const coalescedTwo = Buffer.from("coalesced-two");
  const splitWireLength = encodeNiFrame(splitPayload).byteLength;
  const cases = defineNiPeerCases({
    name: "stream-shapes",
    timeoutMs: 1_000,
    steps: [
      niPeerStep.expectFrame(request),
      niPeerStep.delay(20),
      niPeerStep.split(
        niWire.frame(splitPayload),
        Array.from({ length: splitWireLength }, () => 1),
      ),
      niPeerStep.shortWrite(niWire.frame(shortPayload), 2),
      niPeerStep.coalesce(
        niWire.frame(coalescedOne),
        niWire.frame(coalescedTwo),
      ),
    ],
  });
  const peer = await ScriptedNiPeer.start(cases, "stream-shapes");
  t.after(() => peer.close());
  assert.equal(peer.host, "127.0.0.1");

  const transport = await NiSocketTransport.connect({
    host: peer.host,
    port: peer.port,
  });
  t.after(() => transport.close());
  const startedAt = performance.now();
  await transport.send(request);

  assert.deepEqual(await transport.receive({ timeoutMs: 1_000 }), splitPayload);
  assert.ok(
    performance.now() - startedAt >= 10,
    "the scripted delay must run before output",
  );
  assert.deepEqual(await transport.receive(), shortPayload);
  assert.deepEqual(await transport.receive(), coalescedOne);
  assert.deepEqual(await transport.receive(), coalescedTwo);
  await peer.done();
  assert.deepEqual(peer.observedFrames, [request]);
  assert.equal(transport.state, "open");
});

test("scripted peer can duplicate exact raw control bytes", async (t) => {
  const control = Buffer.from("control");
  const cases = defineNiPeerCases({
    name: "duplicate-control",
    steps: [
      niPeerStep.delay(10),
      niPeerStep.duplicate(niWire.raw(encodeNiFrame(control)), 2),
    ],
  });
  const peer = await ScriptedNiPeer.start(cases, "duplicate-control");
  t.after(() => peer.close());
  const transport = await NiSocketTransport.connect({
    host: peer.host,
    port: peer.port,
  });
  t.after(() => transport.close());

  assert.deepEqual(await transport.receive({ timeoutMs: 1_000 }), control);
  assert.deepEqual(await transport.receive(), control);
  await peer.done();
  assert.equal(transport.state, "open");
});

for (const fault of [
  {
    name: "half-close",
    steps: [niPeerStep.delay(10), niPeerStep.halfClose()],
    code: "NI_CONNECTION_CLOSED" as const,
  },
  {
    name: "reset",
    steps: [niPeerStep.delay(10), niPeerStep.reset()],
    code: "NI_CONNECTION_CLOSED" as const,
  },
  {
    name: "graceful-eof",
    steps: [niPeerStep.delay(10), niPeerStep.eof()],
    code: "NI_CONNECTION_CLOSED" as const,
  },
  {
    name: "truncated-frame",
    steps: [
      niPeerStep.delay(10),
      niPeerStep.write(niWire.truncatedFrame(5, Buffer.from("ab"))),
      niPeerStep.eof(),
    ],
    code: "NI_PROTOCOL_ERROR" as const,
  },
  {
    name: "malformed-length",
    steps: [
      niPeerStep.delay(10),
      niPeerStep.write(niWire.malformedLength(1_024)),
    ],
    code: "NI_PROTOCOL_ERROR" as const,
    maxPayloadLength: 32,
  },
] as const) {
  test(`scripted peer deterministically injects ${fault.name}`, async (t) => {
    const cases = defineNiPeerCases({
      name: fault.name,
      timeoutMs: 1_000,
      steps: fault.steps,
    });
    const peer = await ScriptedNiPeer.start(cases, fault.name);
    t.after(() => peer.close());
    const transport = await NiSocketTransport.connect({
      host: peer.host,
      port: peer.port,
      maxPayloadLength:
        "maxPayloadLength" in fault ? fault.maxPayloadLength : undefined,
    });
    t.after(() => transport.close());

    await rejectsWithTransportCode(
      transport.receive({ timeoutMs: 1_000 }),
      fault.code,
    );
    assert.equal(transport.state, "closed");
    await peer.done();
  });
}

test("scripted proxy relays requests and coalesces selected upstream frames", async (t) => {
  const request = Buffer.from("proxy-request");
  const first = Buffer.from("first");
  const second = Buffer.from("second");
  const upstreamCases = defineNiPeerCases({
    name: "two-replies",
    steps: [
      niPeerStep.expectFrame(request),
      niPeerStep.write(niWire.frame(first)),
      niPeerStep.write(niWire.frame(second)),
    ],
  });
  const upstream = await ScriptedNiPeer.start(upstreamCases, "two-replies");
  t.after(() => upstream.close());
  const proxyCases = defineNiProxyCases({
    name: "coalesced-relay",
    steps: [
      niProxyStep.relay("client"),
      niProxyStep.relay("upstream", {
        count: 2,
        delivery: { kind: "coalesce" },
      }),
    ],
  });
  const proxy = await ScriptedNiProxy.start({
    upstreamPort: upstream.port,
    cases: proxyCases,
    selectedCase: "coalesced-relay",
  });
  t.after(() => proxy.close());
  assert.equal(proxy.host, "127.0.0.1");
  const transport = await NiSocketTransport.connect({
    host: proxy.host,
    port: proxy.port,
  });
  t.after(() => transport.close());

  await transport.send(request);
  assert.deepEqual(await transport.receive({ timeoutMs: 1_000 }), first);
  assert.deepEqual(await transport.receive(), second);
  await proxy.done();
  await upstream.done();
  assert.deepEqual(upstream.observedFrames, [request]);
  assert.equal(transport.state, "open");
});

test("scripted proxy composes delay, split, duplicate, truncation, and half-close", async (t) => {
  const splitPayload = Buffer.from("split-via-proxy");
  const duplicatePayload = Buffer.from("duplicate-via-proxy");
  const truncatedPayload = Buffer.from("truncate-via-proxy");
  const splitWireLength = encodeNiFrame(splitPayload).byteLength;
  const upstreamCases = defineNiPeerCases({
    name: "fault-inputs",
    steps: [
      niPeerStep.write(niWire.frame(splitPayload)),
      niPeerStep.write(niWire.frame(duplicatePayload)),
      niPeerStep.write(niWire.frame(truncatedPayload)),
    ],
  });
  const upstream = await ScriptedNiPeer.start(upstreamCases, "fault-inputs");
  t.after(() => upstream.close());
  const proxyCases = defineNiProxyCases({
    name: "composed-faults",
    steps: [
      niProxyStep.delay(20),
      niProxyStep.relay("upstream", {
        delivery: {
          kind: "split",
          chunkSizes: Array.from({ length: splitWireLength }, () => 1),
        },
      }),
      niProxyStep.relay("upstream", {
        delivery: { kind: "duplicate", copies: 2 },
      }),
      niProxyStep.relay("upstream", {
        delivery: { kind: "truncate", keepBytes: 6 },
      }),
      niProxyStep.halfClose("client"),
    ],
  });
  const proxy = await ScriptedNiProxy.start({
    upstreamPort: upstream.port,
    cases: proxyCases,
    selectedCase: "composed-faults",
  });
  t.after(() => proxy.close());
  const transport = await NiSocketTransport.connect({
    host: proxy.host,
    port: proxy.port,
  });
  t.after(() => transport.close());

  assert.deepEqual(await transport.receive({ timeoutMs: 1_000 }), splitPayload);
  assert.deepEqual(await transport.receive(), duplicatePayload);
  assert.deepEqual(await transport.receive(), duplicatePayload);
  await rejectsWithTransportCode(transport.receive(), "NI_PROTOCOL_ERROR");
  assert.equal(transport.state, "closed");
  await proxy.done();
  await upstream.done();
});

test("scripted proxy can rewrite an NI length before resetting the selected side", async (t) => {
  const upstreamCases = defineNiPeerCases({
    name: "one-reply",
    steps: [niPeerStep.write(niWire.frame(Buffer.from("body")))],
  });
  const upstream = await ScriptedNiPeer.start(upstreamCases, "one-reply");
  t.after(() => upstream.close());
  const proxyCases = defineNiProxyCases({
    name: "malformed-and-reset",
    steps: [
      niProxyStep.relay("upstream", {
        delivery: { kind: "malformed-length", declaredLength: 1_024 },
      }),
      niProxyStep.delay(50),
      niProxyStep.reset("client"),
    ],
  });
  const proxy = await ScriptedNiProxy.start({
    upstreamPort: upstream.port,
    cases: proxyCases,
    selectedCase: "malformed-and-reset",
  });
  t.after(() => proxy.close());
  const transport = await NiSocketTransport.connect({
    host: proxy.host,
    port: proxy.port,
    maxPayloadLength: 32,
  });
  t.after(() => transport.close());

  await rejectsWithTransportCode(
    transport.receive({ timeoutMs: 1_000 }),
    "NI_PROTOCOL_ERROR",
  );
  assert.equal(transport.state, "closed");
  await proxy.done();
  await upstream.done();
});
