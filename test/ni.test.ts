import assert from "node:assert/strict";
import test from "node:test";

import { NiFrameDecoder, encodeNiFrame } from "../src/protocol/ni.js";

test("encodes an NI frame with a four-byte big-endian payload length", () => {
  assert.equal(encodeNiFrame(Buffer.from("RFC")).toString("hex"), "00000003524643");
});

test("encodes from intrinsic typed-array geometry without leaking uninitialized bytes", () => {
  class HostileGeometry extends Uint8Array {
    #reads = 0;

    override get byteLength(): number {
      this.#reads += 1;
      return this.#reads === 2 ? 128 : 1;
    }

    get reads(): number {
      return this.#reads;
    }
  }

  const payload = new HostileGeometry([0x52]);
  const frame = encodeNiFrame(payload);

  assert.equal(frame.toString("hex"), "0000000152");
  assert.equal(frame.byteLength, 5);
  assert.equal(payload.reads, 0);
});

test("decodes fragmented and coalesced NI frames", () => {
  const wire = Buffer.concat([
    encodeNiFrame(Buffer.from("first")),
    encodeNiFrame(Buffer.from("second")),
  ]);
  const decoder = new NiFrameDecoder();
  const payloads: Buffer[] = [];

  for (const byte of wire) {
    payloads.push(...decoder.push(Buffer.of(byte)));
  }
  decoder.finish();

  assert.deepEqual(payloads.map((payload) => payload.toString()), ["first", "second"]);
});

test("decodes a large frame delivered one byte at a time without retaining consumed chunks", () => {
  const expected = Buffer.alloc(64 * 1024, 0xa5);
  const wire = encodeNiFrame(expected);
  const decoder = new NiFrameDecoder(expected.byteLength);
  let decoded: Buffer | undefined;
  for (const byte of wire) {
    const payloads = decoder.push(Buffer.of(byte));
    if (payloads.length > 0) decoded = payloads[0];
  }
  decoder.finish();
  assert.deepEqual(decoded, expected);
  assert.equal(decoder.bufferedByteLength, 0);
});

test("rejects an advertised payload above the configured limit", () => {
  const decoder = new NiFrameDecoder(4);
  assert.throws(
    () => decoder.push(Buffer.from([0, 0, 0, 5])),
    /exceeds configured limit/,
  );
});

test("reports a truncated stream", () => {
  const decoder = new NiFrameDecoder();
  decoder.push(Buffer.from([0, 0, 0, 3, 0x52]));
  assert.throws(() => decoder.finish(), /truncated NI stream/);
  decoder.reset();
  assert.equal(decoder.bufferedByteLength, 0);
  assert.doesNotThrow(() => decoder.finish());
});
