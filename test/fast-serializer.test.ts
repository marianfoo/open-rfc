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
  decodeFastSerializerScalarParameter,
  decodeFastSerializerScalarParameterItem,
  encodeFastSerializerCompressedBlock,
  encodeFastSerializerItem,
  encodeFastSerializerParameterAnnouncement,
  encodeFastSerializerRecord,
  encodeFastSerializerRecords,
  encodeFastSerializerScalarParameter,
  encodeFastSerializerScalarParameterItem,
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

test("encodes exact self-closing items and snapshots caller bytes", () => {
  const value = Buffer.from("payload");
  const encoded = encodeFastSerializerItem(
    FAST_SERIALIZER_PARAMETER_ITEM_ID,
    value,
  );
  value.fill(0);

  assert.deepEqual(
    encoded,
    item(FAST_SERIALIZER_PARAMETER_ITEM_ID, Buffer.from("payload")),
  );
  assert.equal(decodeFastSerializerItem(encoded).data.toString(), "payload");
});

test("rejects item identifiers and values outside the wire grammar", () => {
  assert.throws(
    () => encodeFastSerializerItem(-1, Buffer.alloc(0)),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => encodeFastSerializerItem(0x1_0000, Buffer.alloc(0)),
    /identifier/u,
  );
  assert.throws(
    () => encodeFastSerializerItem(1, Buffer.alloc(0x1_0000)),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "ITEM_LIMIT_EXCEEDED",
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

test("encodes a bounded fast-serializer LZ4 block without retaining input", () => {
  const value = Buffer.from("compressible-fast-serializer-value:".repeat(64));
  const expected = Buffer.from(value);
  const encoded = encodeFastSerializerCompressedBlock(value);
  value.fill(0);

  assert.equal(encoded.readUInt32LE(0), expected.byteLength);
  assert.equal(encoded.readUInt32LE(4), encoded.byteLength - 8);
  assert.ok(encoded.byteLength < expected.byteLength);
  assert.deepEqual(decodeFastSerializerCompressedBlock(encoded).data, expected);
});

test("refuses empty, incompressible, and over-budget compressed blocks", () => {
  assert.throws(
    () => encodeFastSerializerCompressedBlock(Buffer.alloc(0)),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "MALFORMED_COMPRESSION",
  );

  let state = 0x434f_4d50;
  const random = Buffer.alloc(513);
  for (let index = 0; index < random.byteLength; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    random[index] = state & 0xff;
  }
  assert.throws(
    () => encodeFastSerializerCompressedBlock(random),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "COMPRESSION_NOT_BENEFICIAL",
  );
  assert.throws(
    () => encodeFastSerializerCompressedBlock(Buffer.alloc(64, 0x41), {
      maxUncompressedLength: 63,
    }),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "COMPRESSION_LIMIT_EXCEEDED",
  );
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

test("encodes every established record framing rule as one strict stream", () => {
  const inputs = [
    {
      tag: FastSerializerRecordTag.Descriptor,
      value: Buffer.from("\\TYPE=Z_NEUTRAL", "ascii"),
    },
    {
      tag: FastSerializerRecordTag.Character,
      value: Buffer.from("ABC", "ascii"),
    },
    {
      tag: FastSerializerRecordTag.Int4,
      value: Buffer.from([0x00, 0x01, 0x00, 0x00]),
    },
    {
      tag: FastSerializerRecordTag.Padded,
      value: Buffer.from("AB", "utf16le"),
    },
    {
      tag: FastSerializerRecordTag.String,
      value: Buffer.from("open-rfc", "utf8"),
    },
    { tag: FastSerializerRecordTag.End, value: Buffer.alloc(0) },
  ] as const;
  const encoded = encodeFastSerializerRecords(inputs);

  assert.deepEqual(
    encoded,
    Buffer.concat([
      descriptor("Z_NEUTRAL"),
      Buffer.from([FastSerializerRecordTag.Character, 3, 0x80, 0x41, 0x42, 0x43]),
      Buffer.from([FastSerializerRecordTag.Int4, 0x00, 0x01, 0x00, 0x00]),
      Buffer.from([FastSerializerRecordTag.Padded, 0x00, 0x04, 0x41, 0x00, 0x42, 0x00]),
      Buffer.from([
        FastSerializerRecordTag.String,
        0x08, 0xc0, 0x08, 0x00,
        ...Buffer.from("open-rfc"),
      ]),
      Buffer.from([FastSerializerRecordTag.End]),
    ]),
  );
  assert.deepEqual(
    decodeFastSerializerRecords(encoded).map(({ tag, value }) => ({ tag, value })),
    inputs,
  );
});

test("rejects unrepresentable record values rather than truncating them", () => {
  const rejected: ReadonlyArray<readonly [FastSerializerRecordTag, Buffer]> = [
    [FastSerializerRecordTag.Character, Buffer.alloc(0)],
    [FastSerializerRecordTag.Character, Buffer.alloc(256)],
    [FastSerializerRecordTag.Descriptor, Buffer.alloc(256)],
    [FastSerializerRecordTag.Int4, Buffer.alloc(3)],
    [FastSerializerRecordTag.Padded, Buffer.alloc(0x1_0000)],
    [FastSerializerRecordTag.String, Buffer.alloc(0x4000)],
    [FastSerializerRecordTag.End, Buffer.of(1)],
  ];
  for (const [tag, value] of rejected) {
    assert.throws(
      () => encodeFastSerializerRecord(tag, value),
      (error: unknown) =>
        error instanceof FastSerializerProtocolError &&
        error.code === "MALFORMED_RECORD",
    );
  }
  assert.throws(
    () => encodeFastSerializerRecord(0x99 as FastSerializerRecordTag, Buffer.of(1)),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "UNSUPPORTED_RECORD_TAG",
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

test("encodes and decodes exact parameter announcements", () => {
  const fields = [
    { typeCode: FastSerializerTypeCode.Int4, name: "NUM" },
    {
      typeCode: FastSerializerTypeCode.Character,
      width: 20,
      name: "TEXT",
    },
    { typeCode: FastSerializerTypeCode.Raw, width: 3, name: "RAW" },
    { typeCode: FastSerializerTypeCode.String, name: "DYNTXT" },
  ] as const;
  const encoded = encodeFastSerializerParameterAnnouncement({
    typeName: "Z_NEUTRAL",
    fields,
  });

  assert.deepEqual(
    decodeFastSerializerParameterAnnouncement(encoded),
    {
      typeName: "Z_NEUTRAL",
      generated: false,
      fields,
      offset: 0,
      bytesConsumed: encoded.byteLength,
    },
  );
});

test("rejects ambiguous or unrepresentable parameter announcements", () => {
  assert.throws(
    () => encodeFastSerializerParameterAnnouncement({
      typeName: "bad-name",
      fields: [],
    }),
    /type name/u,
  );
  assert.throws(
    () => encodeFastSerializerParameterAnnouncement({
      typeName: "Z_TYPE",
      fields: [{ typeCode: FastSerializerTypeCode.Character, name: "TEXT" }],
    }),
    /width/u,
  );
  assert.throws(
    () => encodeFastSerializerParameterAnnouncement({
      typeName: "Z_TYPE",
      fields: [{ typeCode: FastSerializerTypeCode.Int4, width: 4, name: "NUM" }],
    }),
    /must not declare a width/u,
  );
  assert.throws(
    () => encodeFastSerializerParameterAnnouncement({
      typeName: "Z_TYPE",
      fields: [{ typeCode: 0xff as FastSerializerTypeCode, name: "FIELD" }],
    }),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "UNSUPPORTED_TYPE_CODE",
  );
  assert.throws(
    () => encodeFastSerializerParameterAnnouncement({
      typeName: "Z_TYPE",
      fields: Array.from({ length: 256 }, (_, index) => ({
        typeCode: FastSerializerTypeCode.Int4,
        name: `F${index}`,
      })),
    }),
    /field count/u,
  );
});

test("encodes and decodes the three established scalar parameter blocks", () => {
  const tableLine = Buffer.from("TABLE_LINE", "ascii");
  const cases = [
    {
      input: {
        typeName: "I",
        typeCode: FastSerializerTypeCode.Int4,
        value: Buffer.from([0x2a, 0x00, 0x00, 0x00]),
      },
      encoded: Buffer.concat([
        descriptor("I"),
        Buffer.from([FastSerializerTypeCode.Int4, tableLine.byteLength]),
        tableLine,
        Buffer.from([
          FastSerializerRecordTag.Int4,
          0x2a, 0x00, 0x00, 0x00,
          FastSerializerRecordTag.End,
        ]),
      ]),
    },
    {
      input: {
        typeName: "CHAR30",
        typeCode: FastSerializerTypeCode.Character,
        width: 60,
        value: Buffer.from("ABCD", "ascii"),
      },
      encoded: Buffer.concat([
        descriptor("CHAR30"),
        Buffer.from([
          FastSerializerTypeCode.Character,
          60, 0,
          tableLine.byteLength,
        ]),
        tableLine,
        Buffer.from([
          FastSerializerRecordTag.Character,
          4, 0x80,
          ...Buffer.from("ABCD", "ascii"),
          FastSerializerRecordTag.End,
        ]),
      ]),
    },
    {
      input: {
        typeName: "STRING",
        typeCode: FastSerializerTypeCode.String,
        value: Buffer.from("question", "ascii"),
      },
      encoded: Buffer.concat([
        descriptor("STRING"),
        Buffer.from([FastSerializerTypeCode.String, tableLine.byteLength]),
        tableLine,
        Buffer.from([
          FastSerializerRecordTag.String,
          8, 0xc0, 8, 0,
          ...Buffer.from("question", "ascii"),
        ]),
      ]),
    },
  ] as const;

  for (const { input, encoded } of cases) {
    const actual = encodeFastSerializerScalarParameter(input);
    assert.deepEqual(actual, encoded);
    assert.deepEqual(decodeFastSerializerScalarParameter(actual), {
      typeName: input.typeName,
      generated: false,
      compressed: false,
      typeCode: input.typeCode,
      ...(input.typeCode === FastSerializerTypeCode.Character
        ? { width: input.width }
        : {}),
      value: input.value,
      bytesConsumed: actual.byteLength,
    });
  }
});

test("recognizes generated scalar types and snapshots their value bytes", () => {
  const value = Buffer.from("VALUE", "ascii");
  const encoded = encodeFastSerializerScalarParameter({
    typeName: "%_T00001",
    typeCode: FastSerializerTypeCode.Character,
    width: 10,
    value,
  });
  value.fill(0);

  const decoded = decodeFastSerializerScalarParameter(encoded);
  assert.equal(decoded.generated, true);
  assert.equal(decoded.value.toString("ascii"), "VALUE");
});

test("rejects scalar blocks whose metadata, value, or terminator is ambiguous", () => {
  const tableLine = Buffer.from("TABLE_LINE", "ascii");
  const intPrefix = Buffer.concat([
    descriptor("I"),
    Buffer.from([FastSerializerTypeCode.Int4, tableLine.byteLength]),
    tableLine,
  ]);
  const intValue = Buffer.from([
    FastSerializerRecordTag.Int4,
    0x2a, 0x00, 0x00, 0x00,
  ]);
  const malformed = [
    Buffer.concat([Buffer.from([0x44, 1]), intPrefix, intValue]),
    Buffer.concat([
      descriptor("I"),
      Buffer.from([FastSerializerTypeCode.Int4, 5]),
      Buffer.from("VALUE"),
      intValue,
      Buffer.of(FastSerializerRecordTag.End),
    ]),
    Buffer.concat([
      intPrefix,
      encodeFastSerializerRecord(
        FastSerializerRecordTag.Character,
        Buffer.from("42"),
      ),
      Buffer.of(FastSerializerRecordTag.End),
    ]),
    Buffer.concat([intPrefix, intValue]),
    Buffer.concat([
      descriptor("STRING"),
      Buffer.from([FastSerializerTypeCode.String, tableLine.byteLength]),
      tableLine,
      encodeFastSerializerRecord(
        FastSerializerRecordTag.String,
        Buffer.from("question"),
      ),
      Buffer.of(FastSerializerRecordTag.End),
    ]),
  ];
  for (const encoded of malformed) {
    assert.throws(
      () => decodeFastSerializerScalarParameter(encoded),
      (error: unknown) => error instanceof FastSerializerProtocolError,
    );
  }

  assert.throws(
    () => encodeFastSerializerScalarParameter({
      typeName: "RAW",
      typeCode: FastSerializerTypeCode.Raw,
      width: 4,
      value: Buffer.alloc(4),
    }),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "UNSUPPORTED_TYPE_CODE",
  );
  assert.throws(
    () => encodeFastSerializerScalarParameter({
      typeName: "I",
      typeCode: FastSerializerTypeCode.Int4,
      width: 4,
      value: Buffer.alloc(4),
    }),
    /must not declare a width/u,
  );
  for (const width of [0, 3]) {
    assert.throws(
      () => encodeFastSerializerScalarParameter({
        typeName: "CHAR2",
        typeCode: FastSerializerTypeCode.Character,
        width,
        value: Buffer.from("A"),
      }),
      /positive even byte count/u,
    );
  }
  const compressedScalar = encodeFastSerializerScalarParameter({
    typeName: "STRING",
    typeCode: FastSerializerTypeCode.String,
    value: Buffer.alloc(513, 0x41),
  });
  const decodedCompressed = decodeFastSerializerScalarParameter(compressedScalar);
  assert.equal(decodedCompressed.compressed, true);
  assert.equal(decodedCompressed.value.byteLength, 513);
  assert.equal(decodedCompressed.value[512], 0x41);
  const descriptorCollision = encodeFastSerializerScalarParameter({
    typeName: "STRING",
    typeCode: FastSerializerTypeCode.String,
    value: Buffer.alloc(561, 0x42),
  });
  assert.equal(descriptorCollision[0], FastSerializerRecordTag.Descriptor);
  assert.equal(
    decodeFastSerializerScalarParameter(descriptorCollision).value.byteLength,
    561,
  );
  const literalBoundary = encodeFastSerializerScalarParameter({
    typeName: "STRING",
    typeCode: FastSerializerTypeCode.String,
    value: Buffer.alloc(512, 0x41),
  });
  assert.equal(
    decodeFastSerializerScalarParameter(literalBoundary).value.byteLength,
    512,
  );
});

test("encodes and decodes exact literal and compressed 0x5001 scalar items", () => {
  const literal = encodeFastSerializerScalarParameterItem({
    typeName: "I",
    typeCode: FastSerializerTypeCode.Int4,
    value: Buffer.from([42, 0, 0, 0]),
  });
  const literalItem = decodeFastSerializerItem(literal);
  assert.equal(literalItem.id, FAST_SERIALIZER_PARAMETER_ITEM_ID);
  assert.equal(literal.readUInt16BE(literal.byteLength - 2), literalItem.id);
  assert.deepEqual(decodeFastSerializerScalarParameterItem(literal), {
    parameter: {
      typeName: "I",
      generated: false,
      compressed: false,
      typeCode: FastSerializerTypeCode.Int4,
      value: Buffer.from([42, 0, 0, 0]),
      bytesConsumed: literalItem.data.byteLength,
    },
    offset: 0,
    bytesConsumed: literal.byteLength,
  });

  const compressedItem = encodeFastSerializerScalarParameterItem({
    typeName: "STRING",
    typeCode: FastSerializerTypeCode.String,
    value: Buffer.alloc(4_096, 0x5a),
  });
  const decoded = decodeFastSerializerScalarParameterItem(compressedItem);
  assert.equal(decoded.parameter.compressed, true);
  assert.equal(decoded.parameter.value.byteLength, 4_096);
  assert.ok(compressedItem.byteLength < 256);

  assert.throws(
    () => decodeFastSerializerScalarParameterItem(
      item(0x0130, encodeFastSerializerScalarParameter({
        typeName: "I",
        typeCode: FastSerializerTypeCode.Int4,
        value: Buffer.alloc(4),
      })),
    ),
    (error: unknown) =>
      error instanceof FastSerializerProtocolError &&
      error.code === "MALFORMED_ITEM",
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
      () => decodeFastSerializerScalarParameter(input),
      () => decodeFastSerializerScalarParameterItem(input),
    ]) {
      try {
        decode();
      } catch (error) {
        assert.ok(error instanceof FastSerializerProtocolError);
      }
    }
  }
});
