import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_LZ4_BLOCK_LENGTH,
  Lz4BlockDecodeError,
  Lz4BlockEncodeError,
  decodeLz4Block,
  encodeLz4Block,
} from "../src/protocol/lz4-block.js";

function literalBlock(value: Uint8Array): Buffer {
  const lengthBytes: number[] = [];
  if (value.byteLength >= 15) {
    let remaining = value.byteLength - 15;
    while (remaining >= 0xff) {
      lengthBytes.push(0xff);
      remaining -= 0xff;
    }
    lengthBytes.push(remaining);
  }
  return Buffer.concat([
    Buffer.from([Math.min(value.byteLength, 15) << 4, ...lengthBytes]),
    Buffer.from(value),
  ]);
}

test("decodes literal-only LZ4 blocks across extended-length boundaries", () => {
  for (const length of [0, 1, 14, 15, 16, 269, 270, 271, 525]) {
    const expected = Buffer.alloc(length);
    for (let index = 0; index < expected.byteLength; index += 1) {
      expected[index] = (index * 29 + 7) & 0xff;
    }
    assert.deepEqual(decodeLz4Block(literalBlock(expected), length), expected);
  }
});

test("decodes an overlapping offset-one match", () => {
  // One literal followed by a 19-byte overlapping match, producing 20 x bytes.
  const compressed = Buffer.from([0x1f, 0x78, 0x01, 0x00, 0x00]);
  assert.equal(decodeLz4Block(compressed, 20).toString(), "x".repeat(20));
});

test("decodes multiple sequences and an extended match", () => {
  // abc + a 19-byte match at offset 3, then the required literals-only tail.
  const compressed = Buffer.from([
    0x3f, 0x61, 0x62, 0x63, 0x03, 0x00, 0x00,
    0x50, 0x74, 0x61, 0x69, 0x6c, 0x21,
  ]);
  assert.equal(
    decodeLz4Block(compressed, 27).toString(),
    "abcabcabcabcabcabcabcatail!",
  );
});

test("encodes raw LZ4 blocks across literal and match-length boundaries", () => {
  let state = 0x4c5a_3445;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (const length of [0, 1, 4, 12, 13, 14, 15, 16, 269, 270, 271, 525, 4096]) {
    const expected = Buffer.alloc(length);
    for (let index = 0; index < expected.byteLength; index += 1) {
      expected[index] = random() & 0xff;
    }
    const encoded = encodeLz4Block(expected);
    assert.deepEqual(decodeLz4Block(encoded, expected.byteLength), expected);
    if (length < 13) assert.deepEqual(encoded, literalBlock(expected));
  }

  const repeated = Buffer.from("open-rfc:".repeat(8_192));
  const encoded = encodeLz4Block(repeated);
  assert.ok(encoded.byteLength < repeated.byteLength / 100);
  assert.deepEqual(decodeLz4Block(encoded, repeated.byteLength), repeated);
});

test("LZ4 encoding snapshots caller bytes and enforces allocation limits", () => {
  class HostileGeometry extends Uint8Array {
    override get byteLength(): number {
      throw new Error("caller byteLength getter must not run");
    }
  }

  const original = Buffer.from("bounded-source-".repeat(32));
  const source = new HostileGeometry(original);
  const encoded = encodeLz4Block(source);
  source.fill(0);
  assert.deepEqual(decodeLz4Block(encoded, original.byteLength), original);

  assert.throws(
    () => encodeLz4Block(Buffer.alloc(9), { maxInputLength: 8 }),
    (error: unknown) =>
      error instanceof Lz4BlockEncodeError &&
      error.code === "INPUT_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => encodeLz4Block(Buffer.from("hello"), { maxOutputLength: 5 }),
    (error: unknown) =>
      error instanceof Lz4BlockEncodeError &&
      error.code === "OUTPUT_LIMIT_EXCEEDED",
  );
});

test("random LZ4 encoder inputs round-trip within fixed bounds", () => {
  let state = 0x454e_434f;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let run = 0; run < 1_024; run += 1) {
    const input = Buffer.alloc(random() % 2_049);
    for (let index = 0; index < input.byteLength; index += 1) {
      input[index] = random() & 0xff;
    }
    if (run % 3 === 0) {
      for (let index = 32; index < input.byteLength; index += 1) {
        input[index] = input[index % 32]!;
      }
    }
    const encoded = encodeLz4Block(input);
    assert.deepEqual(decodeLz4Block(encoded, input.byteLength), input);
  }
});

test("rejects corrupt, truncated, oversized, and size-mismatched blocks", () => {
  const cases: readonly [Uint8Array, number, string][] = [
    [Buffer.alloc(0), 0, "missing its first sequence token"],
    [Buffer.from([0xf0, 0xff]), 1, "length extension is truncated"],
    [Buffer.from([0x20, 0x61]), 2, "literal run extends past"],
    [Buffer.from([0x10, 0x61, 0x00]), 5, "match offset is truncated"],
    [Buffer.from([0x10, 0x61, 0x00, 0x00]), 5, "does not reference"],
    [Buffer.from([0x10, 0x61, 0x02, 0x00]), 5, "does not reference"],
    [Buffer.from([0x50, 1, 2, 3, 4, 5]), 4, "literal run exceeds"],
    [Buffer.from([0x10, 0x61, 0x01, 0x00]), 4, "match exceeds"],
    [literalBlock(Buffer.from("short")), 6, "produced 5 bytes"],
  ];

  for (const [input, outputLength, message] of cases) {
    assert.throws(
      () => decodeLz4Block(input, outputLength),
      (error: unknown) =>
        error instanceof Lz4BlockDecodeError &&
        error.message.includes(message),
    );
  }

  assert.throws(
    () => decodeLz4Block(Buffer.of(0), DEFAULT_MAX_LZ4_BLOCK_LENGTH + 1),
    (error: unknown) =>
      error instanceof Lz4BlockDecodeError &&
      error.code === "OUTPUT_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => decodeLz4Block(Buffer.alloc(9), 0, { maxInputLength: 8 }),
    (error: unknown) =>
      error instanceof Lz4BlockDecodeError &&
      error.code === "INPUT_LIMIT_EXCEEDED",
  );
});

test("uses intrinsic input geometry and returns unaliased output", () => {
  class HostileGeometry extends Uint8Array {
    override get byteLength(): number {
      throw new Error("caller byteLength getter must not run");
    }
  }

  const expected = Buffer.from("bounded-copy");
  const compressed = new HostileGeometry(literalBlock(expected));
  const decoded = decodeLz4Block(compressed, expected.byteLength);
  compressed.fill(0);
  assert.deepEqual(decoded, expected);
});

test("arbitrary short inputs either decode within bounds or fail safely", () => {
  let state = 0x4c5a_3421;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let run = 0; run < 2_048; run += 1) {
    const input = Buffer.alloc(random() % 65);
    for (let index = 0; index < input.byteLength; index += 1) {
      input[index] = random() & 0xff;
    }
    const outputLength = random() % 257;
    try {
      const decoded = decodeLz4Block(input, outputLength, {
        maxInputLength: 64,
        maxOutputLength: 256,
      });
      assert.equal(decoded.byteLength, outputLength);
    } catch (error) {
      assert.ok(error instanceof Lz4BlockDecodeError);
    }
  }
});
