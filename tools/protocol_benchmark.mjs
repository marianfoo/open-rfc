#!/usr/bin/env node

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { encodeNiFrame, NiFrameDecoder } from "../dist/src/protocol/ni.js";

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer in ${minimum}..${maximum}`,
    );
  }
  return value;
}

const iterations = boundedInteger(
  "OPEN_RFC_BENCH_ITERATIONS",
  25_000,
  100,
  1_000_000,
);
const payloadBytes = boundedInteger(
  "OPEN_RFC_BENCH_PAYLOAD_BYTES",
  4_096,
  0,
  1_048_576,
);
const maximumTotalPayloadBytes = 1024 * 1024 * 1024;
const totalPayloadBytes = iterations * payloadBytes;
if (totalPayloadBytes > maximumTotalPayloadBytes) {
  throw new RangeError(
    `benchmark work budget ${totalPayloadBytes} exceeds ${maximumTotalPayloadBytes} total payload bytes`,
  );
}
const payload = Buffer.alloc(payloadBytes, 0xa5);

const encodeStarted = performance.now();
let encoded;
for (let iteration = 0; iteration < iterations; iteration += 1) {
  encoded = encodeNiFrame(payload);
}
const encodeDurationMs = performance.now() - encodeStarted;
assert.ok(encoded !== undefined);

const decoder = new NiFrameDecoder(payloadBytes);
const decodeStarted = performance.now();
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const frames = decoder.push(encoded);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.byteLength, payloadBytes);
}
decoder.finish();
const decodeDurationMs = performance.now() - decodeStarted;

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    harness: "ni-frame-baseline",
    iterations,
    payloadBytes,
    totalPayloadBytes,
    maximumTotalPayloadBytes,
    encodeOperationsPerSecond: Math.round(
      iterations / (encodeDurationMs / 1_000),
    ),
    decodeOperationsPerSecond: Math.round(
      iterations / (decodeDurationMs / 1_000),
    ),
  })}\n`,
);
