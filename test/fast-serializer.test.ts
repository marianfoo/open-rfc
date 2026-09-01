import assert from "node:assert/strict";
import test from "node:test";

import {
  FAST_SERIALIZER_PARAMETER_ITEM_ID,
  FastSerializerProtocolError,
  FastSerializerRecordTag,
  FastSerializerTypeCode,
  decodeFastSerializerCompressedBlock,
  decodeFastSerializerItem,
  decodeFastSerializerItems,
  decodeFastSerializerParameterAnnouncement,
  decodeFastSerializerRecord,
  decodeFastSerializerRecords,
  fastSerializerTypeName,
} from "../src/protocol/fast-serializer.js";

function item(id: number, data: Uint8Array): Buffer {
  const encoded = Buffer.alloc(6 + data.byteLength);
  encoded.writeUInt16BE(id, 0);
  encoded.writeUInt16BE(data.byteLength, 2);
  Buffer.from(data).copy(encoded, 4);
  encoded.writeUInt16BE(id, 4 + data.byteLength);
  return encoded;
}

function compressed(block: Uint8Array, uncompressedLength: number): Buffer {
  const encoded = Buffer.alloc(8 + block.byteLength);
  encoded.writeUInt32LE(uncompressedLength, 0);
  encoded.writeUInt32LE(block.byteLength, 4);
  Buffer.from(block).copy(encoded, 8);
  return encoded;
}

const COMPRESSED_RUN = Buffer.from([
  0x1f, 0x78, 0x01, 0x00, 0x00,
  0x50, 0x74, 0x61, 0x69, 0x6c, 0x21,
]);
const UNCOMPRESSED_RUN = Buffer.from(`${"x".repeat(20)}tail!`);

function descriptor(typeName: string): Buffer {
  const value = Buffer.from(`\\TYPE=${typeName}`, "ascii");
  return Buffer.concat([
    Buffer.from([FastSerializerRecordTag.Descriptor, value.byteLength]),
    value,
  ]);
}

test("decodes exact self-closing items without mistaking a closing id for an opener", () => {
  const first = item(FAST_SERIALIZER_PARAMETER_ITEM_ID, Buffer.from("payload"));
  const second = item(0x0130, Buffer.from("program"));
  const stream = Buffer.concat([first, second]);
  const decoded = decodeFastSerializerItems(stream);

  assert.deepEqual(decoded.map(({ id, data }) => [id, data.toString()]), [
    [FAST_SERIALIZER_PARAMETER_ITEM_ID, "payload"],
    [0x0130, "program"],
  ]);
  assert.equal(decodeFastSerializerItem(stream, first.byteLength).id, 0x0130);
  assert.throws(
    () => decodeFastSerializerItem(stream, first.byteLength - 2),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError,
  );
});

test("rejects malformed, truncated, and over-budget items", () => {
  const valid = item(0x5001, Buffer.from("abc"));
  const wrongClose = Buffer.from(valid);
  wrongClose.writeUInt16BE(0x5002, wrongClose.byteLength - 2);

  assert.throws(() => decodeFastSerializerItems(valid.subarray(0, 3)), /truncated/u);
  assert.throws(() => decodeFastSerializerItems(wrongClose), /does not match/u);
  assert.throws(
    () => decodeFastSerializerItems(valid, { maxItemLength: 2 }),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "ITEM_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => decodeFastSerializerItems(Buffer.concat([valid, valid]), { maxItems: 1 }),
    /item count exceeds/u,
  );
});

test("decodes a header-bounded LZ4 block and reports its exact extent", () => {
  const expected = UNCOMPRESSED_RUN;
  const prefix = Buffer.from([0xde, 0xad]);
  const suffix = Buffer.from([0xbe, 0xef]);
  const encoded = compressed(COMPRESSED_RUN, expected.byteLength);
  const decoded = decodeFastSerializerCompressedBlock(
    Buffer.concat([prefix, encoded, suffix]),
    prefix.byteLength,
  );

  assert.deepEqual(decoded.data, expected);
  assert.equal(decoded.offset, prefix.byteLength);
  assert.equal(decoded.uncompressedLength, expected.byteLength);
  assert.equal(decoded.bytesConsumed, encoded.byteLength);
});

test("rejects inconsistent, truncated, corrupt, and oversized compression headers", () => {
  const expected = UNCOMPRESSED_RUN;
  const valid = compressed(COMPRESSED_RUN, expected.byteLength);

  const zero = Buffer.from(valid);
  zero.writeUInt32LE(0, 4);
  assert.throws(() => decodeFastSerializerCompressedBlock(zero), /inconsistent/u);

  const inverted = Buffer.from(valid);
  inverted.writeUInt32LE(1, 0);
  assert.throws(() => decodeFastSerializerCompressedBlock(inverted), /inconsistent/u);

  assert.throws(
    () => decodeFastSerializerCompressedBlock(valid.subarray(0, -1)),
    /truncated/u,
  );

  const corrupt = Buffer.from(valid);
  corrupt.fill(0, 8);
  assert.throws(
    () => decodeFastSerializerCompressedBlock(corrupt),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "MALFORMED_COMPRESSION",
  );

  assert.throws(
    () => decodeFastSerializerCompressedBlock(valid, 0, {
      maxUncompressedLength: expected.byteLength - 1,
    }),
    /exceeds configured limits/u,
  );
});

test("decodes every established record framing rule as one strict stream", () => {
  const desc = descriptor("SYNTHETIC_TYPE");
  const character = Buffer.from([
    FastSerializerRecordTag.Character, 3, 0x80, 0x41, 0x42, 0x43,
  ]);
  const int4 = Buffer.from([
    FastSerializerRecordTag.Int4, 0x00, 0x01, 0x00, 0x00,
  ]);
  const padded = Buffer.from([
    FastSerializerRecordTag.Padded, 0x00, 0x04, 0x41, 0x00, 0x42, 0x00,
  ]);
  const string = Buffer.from([
    FastSerializerRecordTag.String,
    0x08, 0xc0, 0x08, 0x00,
    ...Buffer.from("open-rfc"),
  ]);
  const end = Buffer.from([FastSerializerRecordTag.End]);
  const records = decodeFastSerializerRecords(
    Buffer.concat([desc, character, int4, padded, string, end]),
  );

  assert.equal(fastSerializerTypeName(records[0]!), "SYNTHETIC_TYPE");
  assert.equal(records[1]!.value.toString(), "ABC");
  assert.equal(records[2]!.value.readUInt32LE(), 256);
  assert.equal(records[3]!.value.toString("utf16le"), "AB");
  assert.equal(records[4]!.value.toString(), "open-rfc");
  assert.equal(records[5]!.value.byteLength, 0);
});

test("fails closed on unsupported, malformed, empty, and truncated records", () => {
  const cases: readonly [Buffer, string][] = [
    [Buffer.of(0x99), "unsupported"],
    [Buffer.from([FastSerializerRecordTag.Character, 1, 0, 0x41]), "invalid flag"],
    [Buffer.from([FastSerializerRecordTag.Character, 0, 0x80]), "empty value"],
    [Buffer.from([FastSerializerRecordTag.Int4, 1, 2, 3]), "truncated"],
    [Buffer.from([FastSerializerRecordTag.String, 1, 0xc0, 2, 0, 0x41]), "disagree"],
  ];
  for (const [encoded, message] of cases) {
    assert.throws(() => decodeFastSerializerRecord(encoded), new RegExp(message, "u"));
  }
  assert.throws(
    () => decodeFastSerializerRecords(Buffer.from([
      FastSerializerRecordTag.End,
      FastSerializerRecordTag.End,
    ]), { maxRecords: 1 }),
    /record count exceeds/u,
  );
});

test("decodes a synthetic field-description list with both width conventions", () => {
  const encoded = Buffer.concat([
    Buffer.from([0x44, 4]),
    descriptor("Z_NEUTRAL"),
    Buffer.from([
      FastSerializerTypeCode.Int4, 3, 0x4e, 0x55, 0x4d,
      FastSerializerTypeCode.Character, 20, 0, 4, 0x54, 0x45, 0x58, 0x54,
      FastSerializerTypeCode.Raw, 3, 0, 3, 0x52, 0x41, 0x57,
      FastSerializerTypeCode.String, 6, 0x44, 0x59, 0x4e, 0x54, 0x58, 0x54,
    ]),
  ]);
  const announcement = decodeFastSerializerParameterAnnouncement(encoded);

  assert.equal(announcement.typeName, "Z_NEUTRAL");
  assert.equal(announcement.generated, false);
  assert.equal(announcement.bytesConsumed, encoded.byteLength);
  assert.deepEqual(announcement.fields, [
    { typeCode: FastSerializerTypeCode.Int4, name: "NUM" },
    { typeCode: FastSerializerTypeCode.Character, width: 20, name: "TEXT" },
    { typeCode: FastSerializerTypeCode.Raw, width: 3, name: "RAW" },
    { typeCode: FastSerializerTypeCode.String, name: "DYNTXT" },
  ]);
});

test("recognizes generated descriptors and rejects unknown field grammars", () => {
  const generated = Buffer.concat([
    Buffer.from([0x44, 0]),
    descriptor("%_T00001"),
  ]);
  assert.equal(
    decodeFastSerializerParameterAnnouncement(generated).generated,
    true,
  );

  const unknownType = Buffer.concat([
    Buffer.from([0x44, 1]),
    descriptor("Z_UNKNOWN"),
    Buffer.from([0xff, 1, 0x41]),
  ]);
  assert.throws(
    () => decodeFastSerializerParameterAnnouncement(unknownType),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "UNSUPPORTED_TYPE_CODE",
  );

  const malformedName = Buffer.concat([
    Buffer.from([0x44, 1]),
    descriptor("Z_NAME"),
    Buffer.from([FastSerializerTypeCode.Int4, 3, 0x41, 0x2d, 0x42]),
  ]);
  assert.throws(
    () => decodeFastSerializerParameterAnnouncement(malformedName),
    /plain protocol identifier/u,
  );
});

test("arbitrary short protocol inputs terminate inside fixed limits", () => {
  let state = 0x4653_4552;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let run = 0; run < 2_048; run += 1) {
    const input = Buffer.alloc(random() % 97);
    for (let index = 0; index < input.byteLength; index += 1) {
      input[index] = random() & 0xff;
    }
    for (const decode of [
      () => decodeFastSerializerItems(input, { maxItems: 8, maxItemLength: 96 }),
      () => decodeFastSerializerRecords(input, { maxRecords: 32 }),
      () => decodeFastSerializerParameterAnnouncement(input),
    ]) {
      try {
        decode();
      } catch (error) {
        assert.ok(error instanceof FastSerializerProtocolError);
      }
    }
  }
});
