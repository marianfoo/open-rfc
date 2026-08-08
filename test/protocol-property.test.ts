import assert from "node:assert/strict";
import test from "node:test";

import {
  AppcFunction,
  decodeAppcDataFragment,
  decodeAppcHeader,
  encodeAppcDataRecord,
} from "../src/protocol/appc.js";
import {
  CpicTag,
  decodeCpicFieldChain,
  encodeCpicFieldChain,
} from "../src/protocol/cpic.js";
import { encodeNiFrame, NiFrameDecoder } from "../src/protocol/ni.js";
import {
  RFC_PRO_COMPACT_LENGTH_MAX,
  RFC_PRO_VALUE_LENGTH_MAX,
  decodeRfcProFieldHeader,
  encodeRfcProFieldHeader,
} from "../src/protocol/rfcpro.js";
import {
  decodeDecimalFloat16,
  decodeDecimalFloat34,
  encodeDecimalFloat16,
  encodeDecimalFloat34,
} from "../src/values/decimal-float.js";
import {
  decodePackedDecimal,
  encodePackedDecimal,
} from "../src/values/packed-decimal.js";

const PROPERTY_BUDGETS = Object.freeze({
  niChunkingRuns: 128,
  niHostileRuns: 512,
  rfcProRuns: 512,
  cpicRoundTripRuns: 256,
  cpicHostileRuns: 512,
  appcRoundTripRuns: 256,
  appcHostileRuns: 256,
  packedDecimalRuns: 512,
  decimalFloatRuns: 256,
});

class DeterministicRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  nextUInt32(): number {
    let value = this.#state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state;
  }

  integer(maximumExclusive: number): number {
    if (!Number.isSafeInteger(maximumExclusive) || maximumExclusive <= 0) {
      throw new RangeError("maximumExclusive must be a positive safe integer");
    }
    return this.nextUInt32() % maximumExclusive;
  }

  bytes(length: number): Buffer {
    const result = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.nextUInt32() & 0xff;
    }
    return result;
  }
}

test("property: NI frames survive deterministic arbitrary stream chunking", () => {
  const random = new DeterministicRandom(0x4f50454e);

  for (let run = 0; run < PROPERTY_BUDGETS.niChunkingRuns; run += 1) {
    const payloads = Array.from({ length: 1 + random.integer(8) }, () =>
      random.bytes(random.integer(2_049)),
    );
    const stream = Buffer.concat(
      payloads.map((payload) => encodeNiFrame(payload)),
    );
    const decoder = new NiFrameDecoder(2_048);
    const decoded: Buffer[] = [];
    let offset = 0;
    while (offset < stream.byteLength) {
      const chunkLength = Math.min(
        stream.byteLength - offset,
        1 + random.integer(97),
      );
      decoded.push(
        ...decoder.push(stream.subarray(offset, offset + chunkLength)),
      );
      offset += chunkLength;
    }
    decoder.finish();
    assert.deepEqual(decoded, payloads, `seeded run ${run}`);
    assert.equal(decoder.bufferedByteLength, 0);
  }
});

test("fuzz: bounded NI decoder rejects or retains arbitrary hostile prefixes", () => {
  const random = new DeterministicRandom(0x52464321);

  for (let run = 0; run < PROPERTY_BUDGETS.niHostileRuns; run += 1) {
    const input = random.bytes(random.integer(65));
    const decoder = new NiFrameDecoder(4_096);
    try {
      const frames = decoder.push(input);
      assert.ok(frames.every((frame) => frame.byteLength <= 4_096));
      assert.ok(decoder.bufferedByteLength <= input.byteLength);
      try {
        decoder.finish();
        assert.equal(decoder.bufferedByteLength, 0);
      } catch (error) {
        assert.match(String(error), /truncated NI stream/);
      }
    } catch (error) {
      assert.match(String(error), /exceeds configured limit/);
    }
  }
});

test("property: RFCPRO headers round-trip canonical boundary and seeded lengths", () => {
  const random = new DeterministicRandom(0x52504650);
  const boundaries = [
    0,
    1,
    RFC_PRO_COMPACT_LENGTH_MAX - 1,
    RFC_PRO_COMPACT_LENGTH_MAX,
    RFC_PRO_COMPACT_LENGTH_MAX + 1,
    65_536,
    RFC_PRO_VALUE_LENGTH_MAX,
  ];

  for (let run = 0; run < PROPERTY_BUDGETS.rfcProRuns; run += 1) {
    const length = boundaries[run] ?? random.integer(1_000_001);
    const tag = random.integer(0x1_0000);
    const encoded = encodeRfcProFieldHeader(tag, length);
    const decoded = decodeRfcProFieldHeader(encoded, { maxValueLength: length });
    assert.deepEqual(decoded, {
      tag,
      length,
      encoding: length <= RFC_PRO_COMPACT_LENGTH_MAX ? "compact" : "extended",
      bytesConsumed: length <= RFC_PRO_COMPACT_LENGTH_MAX ? 4 : 8,
    });
  }
});

test("property: CPIC field chains round-trip seeded bounded records", () => {
  const random = new DeterministicRandom(0x43504943);

  for (let run = 0; run < PROPERTY_BUDGETS.cpicRoundTripRuns; run += 1) {
    const fieldCount = 1 + random.integer(8);
    const fields = Array.from({ length: fieldCount }, (_, index) => ({
      tag: (0x0200 + index + random.integer(32)) & 0xffff,
      value: random.bytes(random.integer(129)),
    }));
    const initialPreviousTag = random.integer(0x1_0000);
    const encoded = encodeCpicFieldChain(initialPreviousTag, fields, {
      maxFieldLength: 128,
      maxChainLength: 2_048,
      maxFieldCount: 8,
    });
    const decoded = decodeCpicFieldChain(encoded, initialPreviousTag, {
      maxFieldLength: 128,
      maxChainLength: 2_048,
      maxFieldCount: 8,
    });
    assert.deepEqual(decoded, fields, `seeded CPIC run ${run}`);
  }
});

test("fuzz: CPIC field-chain decoding remains inside fixed hostile-input limits", () => {
  const random = new DeterministicRandom(0x4350465a);

  for (let run = 0; run < PROPERTY_BUDGETS.cpicHostileRuns; run += 1) {
    const input = random.bytes(random.integer(129));
    try {
      const decoded = decodeCpicFieldChain(input, CpicTag.Start, {
        maxFieldLength: 128,
        maxChainLength: 128,
        maxFieldCount: 16,
      });
      assert.ok(decoded.length <= 16);
      assert.ok(decoded.every((field) => field.value.byteLength <= 128));
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});

test("property: APPC data records preserve seeded header and payload facts", () => {
  const random = new DeterministicRandom(0x41505043);

  for (let run = 0; run < PROPERTY_BUDGETS.appcRoundTripRuns; run += 1) {
    const data = random.bytes(random.integer(2_049));
    const functionCode = random.integer(2) === 0
      ? AppcFunction.SapSend
      : AppcFunction.Receive;
    const isFinal = random.integer(2) === 0;
    const sequenceNumber = random.nextUInt32();
    const conversationId = random.bytes(8);
    const encoded = encodeAppcDataRecord({
      functionCode,
      data,
      communicationIndex: random.integer(0x1_0000),
      connectionIndex: random.integer(0x1_0000),
      conversationId,
      sequenceNumber,
      isFinal,
    });
    const decoded = decodeAppcDataFragment(encoded);
    assert.equal(decoded.header.functionCode, functionCode);
    assert.equal(decoded.header.sequenceNumber, sequenceNumber);
    assert.deepEqual(decoded.header.conversationId, conversationId);
    assert.deepEqual(decoded.data, data);
    assert.equal(decoded.isFinal, isFinal);
  }
});

test("fuzz: APPC common-header decoding rejects or bounds hostile prefixes", () => {
  const random = new DeterministicRandom(0x4150465a);

  for (let run = 0; run < PROPERTY_BUDGETS.appcHostileRuns; run += 1) {
    const input = random.bytes(random.integer(97));
    try {
      const header = decodeAppcHeader(input);
      assert.equal(header.protocolVersion, 6);
      assert.equal(header.conversationId.byteLength, 8);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});

test("property: packed and decimal-float values are canonically stable", () => {
  const packedRandom = new DeterministicRandom(0x5041434b);
  for (let run = 0; run < PROPERTY_BUDGETS.packedDecimalRuns; run += 1) {
    const whole = packedRandom.integer(1_000_000);
    const fraction = packedRandom.integer(100);
    const negative = packedRandom.integer(2) === 1 && (whole !== 0 || fraction !== 0);
    const text = `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
    const encoded = encodePackedDecimal(text, 8, 2);
    assert.equal(decodePackedDecimal(encoded, 2), text);
  }

  const decimalRandom = new DeterministicRandom(0x44504446);
  for (let run = 0; run < PROPERTY_BUDGETS.decimalFloatRuns; run += 1) {
    const value = `${decimalRandom.integer(2) === 0 ? "" : "-"}${decimalRandom.nextUInt32()}`;
    const decimal16 = encodeDecimalFloat16(value);
    const decimal34 = encodeDecimalFloat34(value);
    assert.deepEqual(encodeDecimalFloat16(decodeDecimalFloat16(decimal16)), decimal16);
    assert.deepEqual(encodeDecimalFloat34(decodeDecimalFloat34(decimal34)), decimal34);
  }
});
