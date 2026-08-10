import assert from "node:assert/strict";
import test from "node:test";

import { CheckedByteReader, CheckedByteWriter } from "../src/protocol/bytes.js";

test("checked byte primitives preserve offsets and endian/sign semantics", () => {
  const writer = new CheckedByteWriter(12, "test record");
  writer.writeUInt8(0xab, "byte");
  writer.writeUInt16BE(0xcdef, "short");
  writer.writeUInt32BE(0x1234_5678, "word");
  writer.writeInt32BE(-2, "signed word");
  writer.writeBytes(Buffer.of(0x99), "tail");
  assert.equal(writer.offset, 12);

  const reader = new CheckedByteReader(writer.finish(), "test record");
  assert.equal(reader.readUInt8("byte"), 0xab);
  assert.equal(reader.readUInt16BE("short"), 0xcdef);
  assert.equal(reader.readUInt32BE("word"), 0x1234_5678);
  assert.equal(reader.readInt32BE("signed word"), -2);
  assert.deepEqual(reader.readBytes(1, "tail"), Buffer.of(0x99));
  assert.equal(reader.remaining, 0);
  reader.finish();
});

test("checked byte readers report field path, offset, and required length", () => {
  const reader = new CheckedByteReader(Buffer.of(1, 2), "APPC header");
  reader.readUInt8("version");
  assert.throws(
    () => reader.readUInt16BE("uid"),
    /APPC header\.uid.*2 bytes.*offset 1.*1 remain/,
  );
});

test("checked byte readers support classic RFC little-endian INT4 values", () => {
  const reader = new CheckedByteReader(
    Buffer.from("88000000feffffff", "hex"),
    "classic row",
  );
  assert.equal(reader.readUInt32LE("position"), 136);
  assert.equal(reader.readInt32LE("signed"), -2);
  reader.finish();
});

test("checked byte writers reject overflow and invalid numeric ranges", () => {
  const writer = new CheckedByteWriter(1, "small record");
  assert.throws(() => writer.writeUInt8(256, "byte"), /small record\.byte.*0.*255/);
  writer.writeUInt8(1, "byte");
  assert.throws(() => writer.writeUInt8(2, "extra"), /small record\.extra.*1 bytes.*0 remain/);
});

test("finish rejects unread and unwritten trailing bytes", () => {
  const reader = new CheckedByteReader(Buffer.alloc(2), "reader");
  reader.readUInt8("first");
  assert.throws(() => reader.finish(), /reader.*1 unread bytes/);

  const writer = new CheckedByteWriter(2, "writer");
  writer.writeUInt8(1, "first");
  assert.throws(() => writer.finish(), /writer.*1 unwritten bytes/);
});
