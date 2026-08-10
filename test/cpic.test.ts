import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
  CpicTag,
  decodeCpicFieldChain,
  decodeCpicFieldChainPrefix,
  decodeCpicInitialLogonRequest,
  decodeCpicInitialLogonResponse,
  decodeCpicFunctionResponse,
  decodeCpicFunctionResultFields,
  decodeCpicResetServerContextResultFields,
  decodeCpicSessionRefreshResultFields,
  encodeCpicFieldChain,
  encodeCpicCutFunctionRequest,
  encodeCpicInitialLogonRequest,
  encodeCpicFunctionRequest,
  inspectCpicRequestAppcFraming,
  type CpicField,
} from "../src/protocol/cpic.js";
import { scrambleRfcPassword } from "../src/protocol/password-scramble.js";

test("encodes and decodes the chained CPIC tag grammar", () => {
  const encoded = encodeCpicFieldChain(CpicTag.Session, [
    { tag: CpicTag.Client, value: Buffer.from("001") },
    { tag: CpicTag.User, value: Buffer.from("USER") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);

  assert.equal(
    encoded.toString("hex"),
    "051401140003303031011401110004555345520111ffff0000",
  );
  const decoded = decodeCpicFieldChain(encoded, CpicTag.Session);
  assert.deepEqual(decoded, [
    { tag: CpicTag.Client, value: Buffer.from("001") },
    { tag: CpicTag.User, value: Buffer.from("USER") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  encoded.fill(0);
  assert.equal(Buffer.from(decoded[0]!.value).toString("ascii"), "001");
});

test("decodes a CPIC field prefix without consuming its protocol trailer", () => {
  const fields = encodeCpicFieldChain(CpicTag.Session, [
    { tag: CpicTag.Client, value: Buffer.from("001") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const trailer = Buffer.from("ffff0000012000008500", "hex");
  const message = Buffer.concat([fields, trailer]);

  const decoded = decodeCpicFieldChainPrefix(
    message,
    CpicTag.Session,
    CpicTag.End,
  );
  assert.deepEqual(decoded.fields, [
    { tag: CpicTag.Client, value: Buffer.from("001") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.equal(decoded.bytesConsumed, fields.byteLength);
  assert.deepEqual(message.subarray(decoded.bytesConsumed), trailer);

  const exactlyBounded = decodeCpicFieldChainPrefix(
    message,
    CpicTag.Session,
    CpicTag.End,
    { maxChainLength: fields.byteLength },
  );
  assert.equal(exactlyBounded.bytesConsumed, fields.byteLength);
  assert.throws(
    () =>
      decodeCpicFieldChainPrefix(
        message,
        CpicTag.Session,
        CpicTag.End,
        { maxChainLength: fields.byteLength - 1 },
      ),
    /field (?:chain )?length .*exceeds configured limit/,
  );
});

test("requires the requested CPIC terminal tag", () => {
  const fields = encodeCpicFieldChain(CpicTag.Session, [
    { tag: CpicTag.Client, value: Buffer.from("001") },
  ]);
  assert.throws(
    () => decodeCpicFieldChainPrefix(fields, CpicTag.Session, CpicTag.End),
    /ended before terminal tag 0xffff/,
  );
});

test("rejects a broken CPIC tag chain and truncated values", () => {
  const brokenChain = Buffer.from(
    "05140114000330303100010111000455534552",
    "hex",
  );
  assert.throws(
    () => decodeCpicFieldChain(brokenChain, CpicTag.Session),
    /expected previous tag 0x0114.*received 0x0001/,
  );

  const truncated = Buffer.from("051401140004303031", "hex");
  assert.throws(
    () => decodeCpicFieldChain(truncated, CpicTag.Session),
    /need 4 bytes/,
  );
});

test("encodes compact and extended RFCPRO lengths inside CPIC chains", () => {
  const compact = encodeCpicFieldChain(CpicTag.ParameterName, [
    {
      tag: CpicTag.ParameterValue,
      value: Buffer.alloc(65_534, 0x11),
    },
  ]);
  assert.equal(compact.subarray(0, 6).toString("hex"), "02010203fffe");
  assert.deepEqual(
    decodeCpicFieldChain(compact, CpicTag.ParameterName),
    [{ tag: CpicTag.ParameterValue, value: Buffer.alloc(65_534, 0x11) }],
  );

  const sentinel = encodeCpicFieldChain(CpicTag.ParameterName, [
    {
      tag: CpicTag.ParameterValue,
      value: Buffer.alloc(65_535, 0x22),
    },
  ]);
  assert.equal(
    sentinel.subarray(0, 10).toString("hex"),
    "02010203ffff0000ffff",
  );
  assert.deepEqual(
    decodeCpicFieldChain(sentinel, CpicTag.ParameterName),
    [{ tag: CpicTag.ParameterValue, value: Buffer.alloc(65_535, 0x22) }],
  );

  const extended = encodeCpicFieldChain(CpicTag.ParameterName, [
    {
      tag: CpicTag.ParameterValue,
      value: Buffer.alloc(65_536, 0x33),
    },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.equal(
    extended.subarray(0, 10).toString("hex"),
    "02010203ffff00010000",
  );
  assert.deepEqual(decodeCpicFieldChain(extended, CpicTag.ParameterName), [
    {
      tag: CpicTag.ParameterValue,
      value: Buffer.alloc(65_536, 0x33),
    },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
});

test("rejects CPIC tags and bounded extended field lengths", () => {
  assert.throws(
    () =>
      encodeCpicFieldChain(CpicTag.Session, [
        { tag: -1, value: Buffer.alloc(0) },
      ]),
    /tag.*0\.\.65535/,
  );
  assert.throws(
    () =>
      encodeCpicFieldChain(
        CpicTag.Session,
        [{ tag: CpicTag.User, value: Buffer.alloc(0x1_0000) }],
        { maxFieldLength: 65_535 },
      ),
    /field length 65536 exceeds configured limit 65535/,
  );

  const advertisedOnly = Buffer.from("02010203ffff00010000", "hex");
  assert.throws(
    () =>
      decodeCpicFieldChain(advertisedOnly, CpicTag.ParameterName, {
        maxFieldLength: 65_535,
      }),
    /length 65536 exceeds configured limit 65535/,
  );

  const atLimit = encodeCpicFieldChain(
    CpicTag.ParameterName,
    [{ tag: CpicTag.ParameterValue, value: Buffer.alloc(65_535) }],
    { maxFieldLength: 65_535, maxChainLength: 65_545 },
  );
  assert.equal(
    decodeCpicFieldChain(atLimit, CpicTag.ParameterName, {
      maxFieldLength: 65_535,
      maxChainLength: 65_545,
    })[0]!.value.byteLength,
    65_535,
  );
});

test("enforces CPIC chain byte and field-count limits at exact boundaries", () => {
  const fields = [
    { tag: CpicTag.Client, value: Buffer.from("001") },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ] as const;
  const encoded = encodeCpicFieldChain(CpicTag.Session, fields);

  assert.equal(
    encodeCpicFieldChain(CpicTag.Session, fields, {
      maxChainLength: encoded.byteLength,
      maxFieldCount: fields.length,
    }).byteLength,
    encoded.byteLength,
  );
  assert.throws(
    () =>
      encodeCpicFieldChain(CpicTag.Session, fields, {
        maxChainLength: encoded.byteLength - 1,
      }),
    /field chain length .*exceeds configured limit/,
  );
  assert.throws(
    () =>
      encodeCpicFieldChain(CpicTag.Session, fields, {
        maxFieldCount: fields.length - 1,
      }),
    /field count 2 exceeds configured limit 1/,
  );
  assert.equal(
    decodeCpicFieldChain(encoded, CpicTag.Session, {
      maxChainLength: encoded.byteLength,
      maxFieldCount: fields.length,
    }).length,
    fields.length,
  );
  assert.throws(
    () =>
      decodeCpicFieldChain(encoded, CpicTag.Session, {
        maxChainLength: encoded.byteLength - 1,
      }),
    /field chain length .* exceeds configured limit/,
  );
  assert.throws(
    () =>
      decodeCpicFieldChain(encoded, CpicTag.Session, {
        maxFieldCount: fields.length - 1,
      }),
    /field count exceeds configured limit 1/,
  );
});

test("rejects invalid CPIC chain limit options", () => {
  const empty = Buffer.alloc(0);
  for (const limits of [
    { maxFieldLength: -1 },
    { maxFieldLength: 1.5 },
    { maxChainLength: Number.NaN },
    { maxChainLength: DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH + 0.5 },
    { maxFieldCount: -1 },
    { maxFieldCount: 1.5 },
  ]) {
    assert.throws(
      () => decodeCpicFieldChain(empty, CpicTag.Session, limits),
      /must be an integer/,
    );
  }
});

test("rejects oversized and truncated extended values before copying payload bytes", () => {
  const maximumFittingValueLength =
    DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH - 10;
  const advertisedOnly = Buffer.alloc(10);
  advertisedOnly.writeUInt16BE(CpicTag.ParameterName, 0);
  advertisedOnly.writeUInt16BE(CpicTag.ParameterValue, 2);
  advertisedOnly.writeUInt16BE(0xffff, 4);
  advertisedOnly.writeInt32BE(maximumFittingValueLength, 6);
  assert.throws(
    () => decodeCpicFieldChain(advertisedOnly, CpicTag.ParameterName),
    new RegExp(`need ${maximumFittingValueLength} bytes`),
  );

  advertisedOnly.writeInt32BE(maximumFittingValueLength + 1, 6);
  assert.throws(
    () => decodeCpicFieldChain(advertisedOnly, CpicTag.ParameterName),
    /field chain length .*exceeds configured limit/,
  );
});

test("rejects a closing-tag mismatch after an extended CPIC value", () => {
  const encoded = encodeCpicFieldChain(CpicTag.ParameterName, [
    { tag: CpicTag.ParameterValue, value: Buffer.alloc(65_535) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  encoded.writeUInt16BE(CpicTag.ParameterName, 65_545);
  assert.throws(
    () => decodeCpicFieldChain(encoded, CpicTag.ParameterName),
    /expected previous tag 0x0203.*received 0x0201/,
  );
});

test("preflights the bounded CUT chain before reading an oversized import", () => {
  const target = Buffer.alloc(0);
  let payloadReads = 0;
  const lengthOnly = new Proxy(target, {
    get(value, property) {
      if (property === "byteLength") {
        return DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH + 1;
      }
      payloadReads += 1;
      throw new Error(`payload property ${String(property)} read before preflight`);
    },
  }) as unknown as Uint8Array;

  assert.throws(
    () =>
      encodeCpicCutFunctionRequest({
        functionName: "RFC_PING",
        imports: [{ name: "INPUT", value: lengthOnly }],
      }),
    /field (?:chain )?length .*exceeds configured limit/,
  );
  assert.equal(payloadReads, 0);
});

test("uses the proven streaming CUT trailer above the 28,000-byte boundary", () => {
  const value = Buffer.alloc(65_536, 0x22);
  const encoded = encodeCpicCutFunctionRequest({
    functionName: "RFC_PING",
    imports: [{ name: "INPUT", value }],
  });
  assert.ok(encoded.byteLength > 0xffff);
  assert.equal(encoded.subarray(-6).toString("hex"), "ffff0000ffff");
  assert.deepEqual(inspectCpicRequestAppcFraming(encoded), {
    mode: "streamed",
    applicationDataLength: encoded.byteLength,
    finalSapParameterLength: 0,
  });

  const decoded = decodeCpicFieldChainPrefix(
    encoded.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  );
  assert.equal(
    decoded.fields.find((field) => field.tag === CpicTag.ParameterValue)?.value
      .byteLength,
    value.byteLength,
  );
});

test("switches generated CPIC requests strictly between 28,000 and 28,001 application bytes", () => {
  const compact = encodeCpicCutFunctionRequest({
    functionName: "RFC_PING",
    imports: [{ name: "INPUT", value: Buffer.alloc(27_926) }],
  });
  const streamed = encodeCpicCutFunctionRequest({
    functionName: "RFC_PING",
    imports: [{ name: "INPUT", value: Buffer.alloc(27_927) }],
  });
  assert.deepEqual(inspectCpicRequestAppcFraming(compact), {
    mode: "compact",
    applicationDataLength: 28_000,
    finalSapParameterLength: 8,
  });
  assert.deepEqual(inspectCpicRequestAppcFraming(streamed), {
    mode: "streamed",
    applicationDataLength: 28_001,
    finalSapParameterLength: 0,
  });
  assert.equal(compact.subarray(0, -8).subarray(-6).toString("hex"), "ffff0000ffff");
  assert.equal(streamed.subarray(-6).toString("hex"), "ffff0000ffff");
});

test("distinguishes compact SAP parameters from the streamed packet sentinel", () => {
  const compact = encodeCpicCutFunctionRequest({ functionName: "RFC_PING" });
  assert.deepEqual(inspectCpicRequestAppcFraming(compact), {
    mode: "compact",
    applicationDataLength: compact.byteLength - 8,
    finalSapParameterLength: 8,
  });
  for (const malformed of [Buffer.alloc(0), compact.subarray(0, -1)]) {
    assert.throws(
      () => inspectCpicRequestAppcFraming(malformed),
      /invalid APPC framing trailer/,
    );
  }
});

test("inspects CPIC framing with intrinsic typed-array geometry", () => {
  const request = encodeCpicCutFunctionRequest({ functionName: "RFC_PING" });
  const applicationDataLength = request.byteLength - 8;
  Object.defineProperties(request, {
    buffer: { value: new ArrayBuffer(1) },
    byteOffset: { value: 0 },
    byteLength: { value: 1 },
  });
  assert.deepEqual(inspectCpicRequestAppcFraming(request), {
    mode: "compact",
    applicationDataLength,
    finalSapParameterLength: 8,
  });
});

test("rejects an oversized CPIC response trailer before snapshotting it", () => {
  const chain = encodeCpicFieldChain(CpicTag.ResponseStart, [
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const trailerOffset = 4 + chain.byteLength;
  const malformed = Buffer.concat([
    Buffer.from("05000000", "hex"),
    chain,
    Buffer.alloc(64 * 1024, 0xff),
  ]);
  let trailerSnapshotRequested = false;
  const watched = new Proxy(malformed, {
    get(value, property) {
      if (property === "byteLength") return value.byteLength;
      if (property === "subarray") {
        return (start?: number, end?: number) => {
          if (start === trailerOffset) trailerSnapshotRequested = true;
          return value.subarray(start, end);
        };
      }
      return Reflect.get(value, property, value);
    },
  }) as unknown as Uint8Array;

  assert.throws(
    () => decodeCpicFunctionResultFields(watched),
    /response trailer is invalid/,
  );
  assert.equal(trailerSnapshotRequested, false);
});

test("rejects every truncated CPIC extended length before reading its value", () => {
  const header = Buffer.from("02010203ffff00010000", "hex");
  for (let length = 1; length < header.byteLength; length += 1) {
    assert.throws(
      () =>
        decodeCpicFieldChain(header.subarray(0, length), CpicTag.ParameterName),
      /need [46] bytes/,
      `truncation at ${length}`,
    );
  }
});

test("scrambles RFC passwords with the pinned current fixed vector", () => {
  assert.equal(
    scrambleRfcPassword("secret", 0x5ae0_b7a3).toString("hex"),
    "a3b7e05a048eaa683470",
  );
});

test("uses a fresh seed by default and enforces the proven ASCII baseline", () => {
  const first = scrambleRfcPassword("secret");
  const second = scrambleRfcPassword("secret");
  assert.equal(first.byteLength, 10);
  assert.equal(second.byteLength, 10);
  assert.notDeepEqual(first, second);
  assert.throws(() => scrambleRfcPassword(null as never), /must be a string/u);
  assert.throws(() => scrambleRfcPassword("pässword"), /ASCII baseline/);
  assert.throws(() => scrambleRfcPassword("x".repeat(41)), /at most 40 bytes/);
  assert.throws(
    () => scrambleRfcPassword("x".repeat(1_000_000)),
    /at most 40 bytes/,
  );
});

test("encodes the capture-sized semantic initial CPIC logon request", () => {
  const encoded = encodeCpicInitialLogonRequest({
    client: "001",
    user: "RFCUSR",
    password: "x".repeat(25),
    language: "E",
    clientAddress: "127.0.0.1",
    partnerHostName: "host.example.test",
    destination: "127.0.0.1",
    programName: "open-rfc01",
    sessionId: Buffer.alloc(16, 0x5a),
    passwordSeed: 0x1234_5678,
  });

  assert.equal(encoded.byteLength, 296);
  assert.equal(
    encoded.subarray(0, 18).toString("hex"),
    "d9c6c3f0f0f0f0f0f0f0f0f0010100080301",
  );
  assert.equal(encoded.subarray(-10).toString("hex"), "ffff0000012000008500");
  const decoded = decodeCpicInitialLogonRequest(encoded);
  assert.equal(decoded.cpicPacketSize, 288);
  assert.equal(decoded.maximumRfcPacketSize, 0x8500);
  assert.deepEqual(
    decoded.fields.map(({ tag, byteLength }) => [tag, byteLength]),
    [
      [0x0101, 0],
      [0x0103, 4],
      [0x0106, 11],
      [0x0337, 0],
      [0x0514, 16],
      [0x0114, 3],
      [0x0111, 6],
      [0x0117, 29],
      [0x0115, 1],
      [0x0501, 1],
      [0x0007, 9],
      [0x0018, 3],
      [0x0011, 1],
      [0x0012, 3],
      [0x0013, 3],
      [0x0008, 17],
      [0x0006, 9],
      [0x0130, 10],
      [0x0502, 0],
      [0x000b, 3],
      [0x0102, 7],
      [0xffff, 0],
    ],
  );
  assert.equal("value" in decoded.fields[7]!, false);
});

test("rejects malformed initial logon fields and identity bounds", () => {
  const base = {
    client: "001",
    user: "RFCUSR",
    password: "secret",
    language: "E",
    clientAddress: "127.0.0.1",
    partnerHostName: "host.example.test",
    destination: "127.0.0.1",
    programName: "open-rfc",
    sessionId: Buffer.alloc(16),
    passwordSeed: 1,
  } as const;
  assert.throws(
    () => encodeCpicInitialLogonRequest({ ...base, client: "01" }),
    /client.*three ASCII digits/,
  );
  assert.throws(
    () => encodeCpicInitialLogonRequest({ ...base, user: "ÜSER" }),
    /user.*ASCII/,
  );
  const brokenChain = encodeCpicInitialLogonRequest(base);
  brokenChain.writeUInt16BE(0x0104, 26);
  assert.throws(
    () => decodeCpicInitialLogonRequest(brokenChain),
    /field chain expected previous tag 0x0104.*received 0x0103/,
  );
  const brokenSize = encodeCpicInitialLogonRequest(base);
  brokenSize.writeUInt16BE(1, brokenSize.byteLength - 6);
  assert.throws(
    () => decodeCpicInitialLogonRequest(brokenSize),
    /packet size 1 does not match derived size/,
  );
});

test("decodes a redaction-safe initial CPIC logon response", () => {
  const prefix = Buffer.from("010100080101010504010003", "hex");
  const fields = encodeCpicFieldChain(CpicTag.Start, [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    {
      tag: CpicTag.Capabilities,
      value: Buffer.from("0401000300030200000023", "hex"),
    },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    {
      tag: CpicTag.SystemCodePage,
      value: Buffer.from("1\x001\x000\x000\x00", "latin1"),
    },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const response = Buffer.concat([prefix, fields, Buffer.from("ffff", "hex")]);

  assert.deepEqual(decodeCpicInitialLogonResponse(response), {
    success: true,
    status: 0,
    negotiatedProtocolVersion: 0x0e0b,
    fields: [
      { tag: CpicTag.ProtocolVersion, byteLength: 4 },
      { tag: CpicTag.Capabilities, byteLength: 11 },
      { tag: CpicTag.LogonStatus, byteLength: 1 },
      { tag: CpicTag.SystemCodePage, byteLength: 8 },
      { tag: CpicTag.End, byteLength: 0 },
    ],
  });

  const rejected = Buffer.from(response);
  const statusOffset = prefix.byteLength + 6 + 4 + 6 + 11 + 6;
  rejected[statusOffset] = 7;
  const decoded = decodeCpicInitialLogonResponse(rejected);
  assert.equal(decoded.success, false);
  assert.equal(decoded.status, 7);
  assert.equal("value" in decoded.fields[2]!, false);
});

test("accepts the observed NetWeaver 7.50 and S/4HANA 2023 logon status forms", () => {
  const prefix = Buffer.from("010100080101010504010003", "hex");
  const responseWith = (fields: readonly CpicField[]): Buffer =>
    Buffer.concat([
      prefix,
      encodeCpicFieldChain(CpicTag.Start, fields),
      Buffer.from("ffff", "hex"),
    ]);
  const fields = encodeCpicFieldChain(CpicTag.Start, [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const response = Buffer.concat([prefix, fields, Buffer.from("ffff", "hex")]);

  assert.deepEqual(decodeCpicInitialLogonResponse(response), {
    success: true,
    status: 0,
    negotiatedProtocolVersion: 0x0e0b,
    fields: [
      { tag: CpicTag.ProtocolVersion, byteLength: 4 },
      { tag: CpicTag.Capabilities, byteLength: 11 },
      { tag: CpicTag.Unresolved0420, byteLength: 4 },
      { tag: CpicTag.End, byteLength: 0 },
    ],
  });

  const dual = responseWith([
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.deepEqual(decodeCpicInitialLogonResponse(dual), {
    success: true,
    status: 0,
    negotiatedProtocolVersion: 0x0e0b,
    fields: [
      { tag: CpicTag.ProtocolVersion, byteLength: 4 },
      { tag: CpicTag.Capabilities, byteLength: 11 },
      { tag: CpicTag.LogonStatus, byteLength: 1 },
      { tag: CpicTag.Unresolved0420, byteLength: 4 },
      { tag: CpicTag.End, byteLength: 0 },
    ],
  });

  const rejectedWithCompanion = decodeCpicInitialLogonResponse(responseWith([
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.LogonStatus, value: Buffer.of(7) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]));
  assert.equal(rejectedWithCompanion.success, false);
  assert.equal(rejectedWithCompanion.status, 7);

  const s4LogonControl = 0x0450;
  const s4WithObservedControl = responseWith([
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: s4LogonControl, value: Buffer.alloc(6) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.deepEqual(decodeCpicInitialLogonResponse(s4WithObservedControl), {
    success: true,
    status: 0,
    negotiatedProtocolVersion: 0x0e0b,
    fields: [
      { tag: CpicTag.ProtocolVersion, byteLength: 4 },
      { tag: CpicTag.Capabilities, byteLength: 11 },
      { tag: CpicTag.LogonStatus, byteLength: 1 },
      { tag: CpicTag.Unresolved0420, byteLength: 4 },
      { tag: s4LogonControl, byteLength: 6 },
      { tag: CpicTag.SystemCodePage, byteLength: 8 },
      { tag: CpicTag.End, byteLength: 0 },
    ],
  });

  for (const [name, controlFields] of [
    [
      "wrong length",
      [
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        { tag: s4LogonControl, value: Buffer.alloc(5) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
    ],
    [
      "wrong position",
      [
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: s4LogonControl, value: Buffer.alloc(6) },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
    ],
    [
      "missing companion call status",
      [
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
        { tag: s4LogonControl, value: Buffer.alloc(6) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
    ],
    [
      "duplicate",
      [
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        { tag: s4LogonControl, value: Buffer.alloc(6) },
        { tag: s4LogonControl, value: Buffer.alloc(6) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
    ],
  ] as const) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(responseWith(controlFields)),
      /malformed 0x0450 control/u,
      name,
    );
  }

  for (const [name, response, pattern] of [
    [
      "nonzero call-status-only form",
      responseWith([
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Unresolved0420, value: Buffer.from("00000001", "hex") },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      /nonzero call status/,
    ],
    [
      "conflicting nonzero companion",
      responseWith([
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: CpicTag.Unresolved0420, value: Buffer.from("00000001", "hex") },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      /nonzero call status/,
    ],
    [
      "malformed call status",
      responseWith([
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(3) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      /malformed call status/,
    ],
    [
      "duplicate call status",
      responseWith([
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      /malformed call status/,
    ],
    [
      "missing status",
      responseWith([
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      /lacks a recognized logon status/,
    ],
    [
      "duplicate one-byte status",
      responseWith([
        { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ]),
      /malformed one-byte status/,
    ],
  ] as const) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(response),
      pattern,
      name,
    );
  }
});

test("admits only the bounded rich initial RFCPING composite responses", () => {
  const prefix = Buffer.from("010100080101010504010003", "hex");
  const responseWith = (fields: readonly CpicField[]): Buffer =>
    Buffer.concat([
      prefix,
      encodeCpicFieldChain(CpicTag.Start, fields),
      Buffer.from("ffff", "hex"),
    ]);
  // Neutral values preserve only the independently observed structural graph.
  // The first Program belongs to the logon/session preamble; the second belongs
  // to the embedded regular RFCPING response and is therefore intentional.
  const richFields: readonly CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
    { tag: 0x0450, value: Buffer.alloc(6) },
    { tag: 0x0451, value: Buffer.alloc(20) },
    { tag: 0x0452, value: Buffer.alloc(4) },
    { tag: 0x0453, value: Buffer.alloc(42) },
    { tag: CpicTag.ClientAddress, value: Buffer.alloc(30) },
    { tag: 0x0020, value: Buffer.alloc(92) },
    { tag: 0x0021, value: Buffer.alloc(20) },
    { tag: CpicTag.PartnerSystem, value: Buffer.alloc(20) },
    { tag: CpicTag.PartnerHost, value: Buffer.alloc(30) },
    { tag: CpicTag.ConnectionType, value: Buffer.alloc(2) },
    { tag: CpicTag.KernelPatch, value: Buffer.alloc(8) },
    { tag: CpicTag.KernelRelease, value: Buffer.alloc(8) },
    { tag: CpicTag.Program, value: Buffer.alloc(16) },
    { tag: 0x0150, value: Buffer.alloc(24) },
    { tag: 0x0151, value: Buffer.alloc(6) },
    { tag: 0x0152, value: Buffer.alloc(2) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Session, value: Buffer.alloc(16) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Program, value: Buffer.alloc(80) },
    { tag: 0x0667, value: Buffer.alloc(8) },
    { tag: 0x0126, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];

  const decoded = decodeCpicInitialLogonResponse(responseWith(richFields));
  assert.equal(decoded.success, true);
  assert.equal(decoded.status, 0);
  assert.equal(decoded.negotiatedProtocolVersion, 0x0e0b);
  assert.deepEqual(
    decoded.fields,
    richFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );

  // A second independently observed S/4 response keeps the same semantic
  // split but carries one extra opaque preamble control and omits the optional
  // embedded 0x0126 control. Keep every coordinate exact; no field value is
  // interpreted beyond the already-owned status controls.
  const compactRichFields: readonly CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
    { tag: 0x0450, value: Buffer.alloc(6) },
    { tag: 0x0451, value: Buffer.alloc(20) },
    { tag: 0x0452, value: Buffer.alloc(4) },
    { tag: 0x0453, value: Buffer.alloc(20) },
    { tag: CpicTag.ClientAddress, value: Buffer.alloc(30) },
    { tag: 0x0020, value: Buffer.alloc(92) },
    { tag: 0x0021, value: Buffer.alloc(20) },
    { tag: CpicTag.PartnerSystem, value: Buffer.alloc(20) },
    { tag: CpicTag.PartnerHost, value: Buffer.alloc(34) },
    { tag: CpicTag.ConnectionType, value: Buffer.alloc(2) },
    { tag: CpicTag.KernelPatch, value: Buffer.alloc(8) },
    { tag: CpicTag.KernelRelease, value: Buffer.alloc(8) },
    { tag: CpicTag.Destination, value: Buffer.alloc(22) },
    { tag: CpicTag.Program, value: Buffer.alloc(16) },
    { tag: 0x0150, value: Buffer.alloc(24) },
    { tag: 0x0151, value: Buffer.alloc(6) },
    { tag: 0x0152, value: Buffer.alloc(2) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Session, value: Buffer.alloc(16) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Program, value: Buffer.alloc(80) },
    { tag: 0x0667, value: Buffer.alloc(8) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
  const compactDecoded = decodeCpicInitialLogonResponse(
    responseWith(compactRichFields),
  );
  assert.equal(compactDecoded.success, true);
  assert.equal(compactDecoded.status, 0);
  assert.deepEqual(
    compactDecoded.fields,
    compactRichFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );

  // Another independently observed S/4 graph differs from the compact graph
  // only at the exact Destination width. Keep it as a separate closed graph;
  // widths between or around the two observations remain rejected.
  const compactRichShortDestinationFields = compactRichFields.map(
    (field, index) => index === 16
      ? { tag: CpicTag.Destination, value: Buffer.alloc(20) }
      : field,
  );
  const compactShortDestinationDecoded = decodeCpicInitialLogonResponse(
    responseWith(compactRichShortDestinationFields),
  );
  assert.equal(compactShortDestinationDecoded.success, true);
  assert.equal(compactShortDestinationDecoded.status, 0);
  assert.deepEqual(
    compactShortDestinationDecoded.fields,
    compactRichShortDestinationFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );

  // A third exact graph combines the already-reviewed compact preamble with
  // the already-reviewed embedded 0x0126 control. This is a separate bounded
  // shape, not an optional-field or arbitrary-combination rule.
  const compactRichWithEmbeddedControlFields = compactRichFields.flatMap(
    (field, index) => index === compactRichFields.length - 1
      ? [{ tag: 0x0126, value: Buffer.alloc(4) }, field]
      : [field],
  );
  const compactWithControlDecoded = decodeCpicInitialLogonResponse(
    responseWith(compactRichWithEmbeddedControlFields),
  );
  assert.equal(compactWithControlDecoded.success, true);
  assert.equal(compactWithControlDecoded.status, 0);
  assert.deepEqual(
    compactWithControlDecoded.fields,
    compactRichWithEmbeddedControlFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );

  // A fourth exact graph was observed on the separately approved 2025
  // development route. It is the compact graph without Destination and with
  // the compact embedded response. This is an exact graph, not optionality.
  const compactRichWithoutDestinationFields = compactRichFields.filter(
    (field) => field.tag !== CpicTag.Destination,
  );
  const compactWithoutDestinationDecoded = decodeCpicInitialLogonResponse(
    responseWith(compactRichWithoutDestinationFields),
  );
  assert.equal(compactWithoutDestinationDecoded.success, true);
  assert.equal(compactWithoutDestinationDecoded.status, 0);
  assert.deepEqual(
    compactWithoutDestinationDecoded.fields,
    compactRichWithoutDestinationFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );

  // A fifth exact graph uses the existing compact embedded suffix behind a
  // shorter preamble whose successful logon is represented only by 0x0420.
  // The graph is exact; absence of the one-byte status is not generic.
  const callStatusOnlyRichFields: readonly CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
    { tag: CpicTag.ClientAddress, value: Buffer.alloc(30) },
    { tag: CpicTag.PartnerSystem, value: Buffer.alloc(18) },
    { tag: CpicTag.PartnerHost, value: Buffer.alloc(34) },
    { tag: CpicTag.ConnectionType, value: Buffer.alloc(2) },
    { tag: CpicTag.KernelPatch, value: Buffer.alloc(8) },
    { tag: CpicTag.KernelRelease, value: Buffer.alloc(8) },
    { tag: CpicTag.Destination, value: Buffer.alloc(22) },
    { tag: CpicTag.Program, value: Buffer.alloc(16) },
    { tag: 0x0150, value: Buffer.alloc(24) },
    { tag: 0x0151, value: Buffer.alloc(6) },
    { tag: 0x0152, value: Buffer.alloc(2) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Session, value: Buffer.alloc(16) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Program, value: Buffer.alloc(80) },
    { tag: 0x0667, value: Buffer.alloc(8) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
  const callStatusOnlyDecoded = decodeCpicInitialLogonResponse(
    responseWith(callStatusOnlyRichFields),
  );
  assert.equal(callStatusOnlyDecoded.success, true);
  assert.equal(callStatusOnlyDecoded.status, 0);
  assert.equal(callStatusOnlyDecoded.negotiatedProtocolVersion, 0x0e0b);
  assert.deepEqual(
    callStatusOnlyDecoded.fields,
    callStatusOnlyRichFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );
  const callStatusOnlyShortDestinationFields = callStatusOnlyRichFields.map(
    (field, index) => index === 9
      ? { tag: CpicTag.Destination, value: Buffer.alloc(20) }
      : field,
  );
  const callStatusOnlyShortDestinationDecoded = decodeCpicInitialLogonResponse(
    responseWith(callStatusOnlyShortDestinationFields),
  );
  assert.equal(callStatusOnlyShortDestinationDecoded.success, true);
  assert.equal(callStatusOnlyShortDestinationDecoded.status, 0);
  assert.equal(
    callStatusOnlyShortDestinationDecoded.negotiatedProtocolVersion,
    0x0e0b,
  );
  assert.deepEqual(
    callStatusOnlyShortDestinationDecoded.fields,
    callStatusOnlyShortDestinationFields.map((field) => ({
      tag: field.tag,
      byteLength: field.value.byteLength,
    })),
  );
  for (const [name, fields, pattern] of [
    [
      "call-status-only missing preamble coordinate",
      callStatusOnlyRichFields.filter((_, index) => index !== 5),
      /composite shape/u,
    ],
    [
      "call-status-only malformed call status",
      callStatusOnlyRichFields.map((field) =>
        field.tag === CpicTag.Unresolved0420
          ? { tag: field.tag, value: Buffer.alloc(3) }
          : field),
      /malformed call status/u,
    ],
    [
      "call-status-only nonzero call status",
      callStatusOnlyRichFields.map((field) =>
        field.tag === CpicTag.Unresolved0420
          ? { tag: field.tag, value: Buffer.from("00000001", "hex") }
          : field),
      /nonzero call status/u,
    ],
  ] as const) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(responseWith(fields)),
      pattern,
      name,
    );
  }

  const compactRejected = decodeCpicInitialLogonResponse(responseWith(
    compactRichFields.map((field, index) => index === 2
      ? { tag: CpicTag.LogonStatus, value: Buffer.of(1) }
      : field),
  ));
  assert.equal(compactRejected.success, false);
  assert.equal(compactRejected.status, 1);

  for (const [name, fields, pattern] of [
    [
      "compact missing opaque preamble control",
      compactRichFields.filter((_, index) => index !== 17),
      /composite shape/u,
    ],
    [
      "compact unknown embedded control",
      compactRichFields.map((field, index) => index === 27
        ? { tag: 0x7777, value: Buffer.alloc(8) }
        : field),
      /composite shape/u,
    ],
    [
      "compact embedded program changed to destination",
      compactRichFields.map((field, index) => index === 26
        ? { tag: CpicTag.Destination, value: field.value }
        : field),
      /duplicate/u,
    ],
    [
      "compact duplicate embedded control",
      compactRichWithEmbeddedControlFields.flatMap((field) =>
        field.tag === 0x0126
          ? [field, { tag: 0x0126, value: Buffer.alloc(4) }]
          : [field]
      ),
      /duplicate field/u,
    ],
    [
      "short Destination graph reorders Destination and Program",
      compactRichShortDestinationFields.map((field, index) => {
        if (index === 16) return compactRichShortDestinationFields[17]!;
        if (index === 17) return compactRichShortDestinationFields[16]!;
        return field;
      }),
      /composite shape/u,
    ],
    [
      "short Destination graph duplicates Destination",
      compactRichShortDestinationFields.flatMap((field, index) => index === 16
        ? [field, { tag: field.tag, value: Buffer.from(field.value) }]
        : [field]),
      /duplicate field/u,
    ],
    [
      "compact malformed embedded call status",
      compactRichFields.map((field, index) => index === 24
        ? { tag: CpicTag.Unresolved0420, value: Buffer.alloc(3) }
        : field),
      /malformed call status/u,
    ],
    [
      "compact nonzero embedded call status",
      compactRichFields.map((field, index) => index === 24
        ? { tag: CpicTag.Unresolved0420, value: Buffer.from("00000001", "hex") }
        : field),
      /nonzero call status/u,
    ],
    [
      "destination-free compact missing preamble program",
      compactRichWithoutDestinationFields.filter((_, index) => index !== 16),
      /composite shape/u,
    ],
    [
      "destination-free compact embedded opaque length drift",
      compactRichWithoutDestinationFields.map((field, index) => index === 26
        ? { tag: field.tag, value: Buffer.alloc(7) }
        : field),
      /composite shape/u,
    ],
  ] as const) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(responseWith(fields)),
      pattern,
      name,
    );
  }

  // The coordinates whose widths were removed from the negative table above are
  // asserted POSITIVELY here. They carry names and addresses, so their widths
  // are properties of the endpoint, not of the wire format. Pinning them was
  // the defect: a host name two characters shorter produced RFC_INVALID_PROTOCOL,
  // which is indistinguishable from a rejected credential.
  for (const width of [1, 18, 19, 20, 21, 22, 23, 64, 255]) {
    for (const [name, source, index] of [
      ["call-status-only PartnerHost", callStatusOnlyRichFields, 5],
      ["call-status-only Destination", callStatusOnlyShortDestinationFields, 9],
      ["compact 0x0453", compactRichFields, 7],
      ["compact Destination", compactRichShortDestinationFields, 16],
    ] as const) {
      const widened = source.map((field, currentIndex) =>
        currentIndex === index
          ? { tag: field.tag, value: Buffer.alloc(width) }
          : field
      );
      const decoded = decodeCpicInitialLogonResponse(responseWith(widened));
      assert.equal(decoded.success, true, `${name} at ${width}`);
    }
  }

  // A one-byte logon status is admitted on a call-status-only graph too. The
  // two families were enumerated separately, so carrying a status there used to
  // be fatal; it is an ordinary optional coordinate.
  {
    const withStatus = callStatusOnlyRichFields.flatMap((field, index) =>
      index === 2
        ? [{ tag: CpicTag.LogonStatus, value: Buffer.of(0) }, field]
        : [field]
    );
    const decoded = decodeCpicInitialLogonResponse(responseWith(withStatus));
    assert.equal(decoded.success, true);
    assert.equal(decoded.status, 0);
  }

  // The optional embedded 0x0126 control is admitted wherever the grammar
  // allows it. Refusing it on a graph that had not been enumerated with it is
  // what rejected the 2026-08-05 S/4HANA reply.
  for (const [name, source] of [
    ["short Destination graph", compactRichShortDestinationFields],
    ["destination-free compact graph", compactRichWithoutDestinationFields],
  ] as const) {
    const withControl = source.flatMap((field, index) =>
      index === source.length - 1
        ? [{ tag: 0x0126, value: Buffer.alloc(4) }, field]
        : [field]
    );
    const decoded = decodeCpicInitialLogonResponse(responseWith(withControl));
    assert.equal(decoded.success, true, name);
  }

  const replace = (
    index: number,
    field: CpicField,
  ): readonly CpicField[] => richFields.map((current, currentIndex) =>
    currentIndex === index ? field : current
  );
  const swapped = [...richFields];
  [swapped[5], swapped[6]] = [swapped[6]!, swapped[5]!];
  const duplicated = [...richFields];
  duplicated.splice(6, 0, richFields[5]!);
  const thirdProgram = [...richFields];
  thirdProgram.splice(26, 0, richFields[25]!);
  const missingEmbeddedProgram = richFields.filter((_, index) => index !== 25);

  const rejected = decodeCpicInitialLogonResponse(responseWith(replace(2, {
    tag: CpicTag.LogonStatus,
    value: Buffer.of(1),
  })));
  assert.equal(rejected.success, false);
  assert.equal(rejected.status, 1);

  for (const [name, fields, pattern] of [
    ["preamble order", swapped, /composite shape/u],
    ["duplicate preamble field", duplicated, /duplicate/u],
    ["third Program field", thirdProgram, /duplicate/u],
    [
      "nonzero embedded call status",
      replace(23, {
        tag: CpicTag.Unresolved0420,
        value: Buffer.from("00000001", "hex"),
      }),
      /nonzero call status/u,
    ],
    [
      "malformed embedded call status",
      replace(23, {
        tag: CpicTag.Unresolved0420,
        value: Buffer.alloc(3),
      }),
      /malformed call status/u,
    ],
    [
      "unknown embedded control",
      replace(27, { tag: 0x7777, value: Buffer.alloc(4) }),
      /composite shape/u,
    ],
    ["missing embedded Program", missingEmbeddedProgram, /composite shape/u],
  ] as const) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(responseWith(fields)),
      pattern,
      name,
    );
  }

  const ordinaryResponse = Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, [
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: 0x0126, value: Buffer.alloc(4) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  assert.throws(
    () => decodeCpicFunctionResultFields(ordinaryResponse),
    /unknown tag 0x0126/u,
  );
});

test("malformed initial-logon diagnostics expose only frozen structural facts", () => {
  const prefix = Buffer.from("010100080101010504010003", "hex");
  const fields: readonly CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: 0x0450, value: Buffer.alloc(5) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
  const response = Buffer.concat([
    prefix,
    encodeCpicFieldChain(CpicTag.Start, fields),
    Buffer.from("ffff", "hex"),
  ]);

  let observed: unknown;
  try {
    decodeCpicInitialLogonResponse(response);
  } catch (error) {
    observed = error;
  }

  assert.ok(observed instanceof Error);
  const diagnostic = observed as Error & {
    readonly rule?: unknown;
    readonly fields?: unknown;
  };
  assert.equal(diagnostic.name, "CpicInitialLogonStructureError");
  assert.equal(diagnostic.rule, "malformed-vendor-logon-control");
  assert.deepEqual(diagnostic.fields, [
    { tag: CpicTag.ProtocolVersion, byteLength: 4, index: 0 },
    { tag: CpicTag.Capabilities, byteLength: 11, index: 1 },
    { tag: CpicTag.LogonStatus, byteLength: 1, index: 2 },
    { tag: CpicTag.Unresolved0420, byteLength: 4, index: 3 },
    { tag: 0x0450, byteLength: 5, index: 4 },
    { tag: CpicTag.End, byteLength: 0, index: 5 },
  ]);
  assert.equal(Object.isFrozen(diagnostic.fields), true);
  assert.equal("value" in (diagnostic.fields as readonly object[])[0]!, false);
  assert.equal(JSON.stringify(diagnostic), "{}");
});

test("projects only a fixed parse-stage enum for initial-logon decoder failures", () => {
  const projectorSymbol = Symbol.for(
    "open-rfc.internal.initial-cpic-logon-parse-stage-projector/v1",
  );
  const descriptor = Reflect.getOwnPropertyDescriptor(
    decodeCpicInitialLogonResponse,
    projectorSymbol,
  );
  assert.ok(descriptor !== undefined && "value" in descriptor);
  assert.equal(typeof descriptor.value, "function");
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.writable, false);
  const projector = descriptor.value as (error: unknown) => unknown;

  const regularPrefix = Buffer.from("010100080101010504010003", "hex");
  const errorPrefix = Buffer.from("010100080101010101010000", "hex");
  const protocol = {
    tag: CpicTag.ProtocolVersion,
    value: Buffer.from("00000e0b", "hex"),
  } as const;
  const status = { tag: CpicTag.LogonStatus, value: Buffer.of(0) } as const;
  const end = { tag: CpicTag.End, value: Buffer.alloc(0) } as const;
  const responseWith = (
    prefix: Buffer,
    fields: readonly CpicField[],
    trailer = Buffer.from("ffff", "hex"),
  ) => Buffer.concat([
    prefix,
    encodeCpicFieldChain(CpicTag.Start, fields),
    trailer,
  ]);
  const preamble = [
    protocol,
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(4) },
    { tag: CpicTag.ClientAddress, value: Buffer.alloc(15) },
    { tag: CpicTag.PartnerSystem, value: Buffer.alloc(9) },
    { tag: CpicTag.PartnerHost, value: Buffer.alloc(17) },
    { tag: CpicTag.ConnectionType, value: Buffer.alloc(1) },
    { tag: CpicTag.KernelPatch, value: Buffer.alloc(4) },
    { tag: CpicTag.KernelRelease, value: Buffer.alloc(4) },
    { tag: CpicTag.Destination, value: Buffer.alloc(10) },
    { tag: CpicTag.Program, value: Buffer.alloc(8) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
  ] as const;

  const valid = responseWith(regularPrefix, [protocol, status, end]);
  const brokenChain = Buffer.from(valid);
  brokenChain.writeUInt16BE(0x7777, regularPrefix.byteLength);
  const cases: ReadonlyArray<readonly [string, Buffer]> = [
    ["truncated", Buffer.alloc(0)],
    ["prefix", Buffer.alloc(valid.byteLength)],
    ["field-chain", brokenChain],
    ["trailer", responseWith(regularPrefix, [protocol, status, end], Buffer.alloc(2))],
    ["protocol", responseWith(regularPrefix, [status, end])],
    [
      "error-preamble",
      responseWith(errorPrefix, [
        protocol,
        { tag: CpicTag.AbapErrorMessage, value: Buffer.from("X", "utf16le") },
        end,
      ]),
    ],
    [
      "error-envelope",
      responseWith(errorPrefix, [
        ...preamble,
        { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
        end,
      ]),
    ],
    [
      "structural",
      responseWith(regularPrefix, [
        protocol,
        status,
        { tag: 0x7777, value: Buffer.alloc(0) },
        end,
      ]),
    ],
  ];

  for (const [expected, response] of cases) {
    let observed: unknown;
    try {
      decodeCpicInitialLogonResponse(response);
    } catch (error) {
      observed = error;
    }
    assert.ok(observed instanceof Error, expected);
    assert.equal(projector(observed), expected);
  }

  assert.equal(projector(new Error("initial CPIC prefix is invalid")), null);
  assert.equal(projector({ parseStage: "prefix" }), null);
});

test("rejects contradictory and non-canonical regular initial logon envelopes", () => {
  const prefix = Buffer.from("010100080101010504010003", "hex");
  const responseWith = (fields: readonly CpicField[]): Buffer =>
    Buffer.concat([
      prefix,
      encodeCpicFieldChain(CpicTag.Start, fields),
      Buffer.from("ffff", "hex"),
    ]);
  const protocol = {
    tag: CpicTag.ProtocolVersion,
    value: Buffer.from("00000e0b", "hex"),
  } as const;
  const status = { tag: CpicTag.LogonStatus, value: Buffer.of(0) } as const;

  for (const [name, fields, pattern] of [
    [
      "error discriminator",
      [
        protocol,
        status,
        { tag: CpicTag.AbapRuntimeId, value: Buffer.from("FAIL", "utf16le") },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      /unsupported field 0x0403 \(8 bytes\) at index 2/u,
    ],
    [
      "unknown field",
      [
        protocol,
        status,
        { tag: 0x7777, value: Buffer.alloc(0) },
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      /unsupported field 0x7777 \(0 bytes\) at index 2/u,
    ],
    [
      "duplicate protocol",
      [protocol, protocol, status, { tag: CpicTag.End, value: Buffer.alloc(0) }],
      /protocol version/u,
    ],
    [
      "nonempty End",
      [protocol, status, { tag: CpicTag.End, value: Buffer.of(1) }],
      /invalid End field/u,
    ],
    [
      "misplaced Start",
      [
        protocol,
        { tag: CpicTag.Start, value: Buffer.alloc(0) },
        status,
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      /invalid Start field/u,
    ],
    [
      "nonempty Start",
      [
        { tag: CpicTag.Start, value: Buffer.of(1) },
        protocol,
        status,
        { tag: CpicTag.End, value: Buffer.alloc(0) },
      ],
      /invalid Start field/u,
    ],
  ] as const) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(responseWith(fields)),
      pattern,
      name,
    );
  }
});

test("classifies the NetWeaver 7.50 terminal logon-error envelope without a numeric status", () => {
  // Payload text is synthetic and only the prefix plus structural preamble/tag
  // geometry of a NetWeaver 7.50 rejected logon is reproduced; no credential,
  // backend identity, address, or application value is retained here.
  const prefix = Buffer.from("010100080101010101010000", "hex");
  const fields = encodeCpicFieldChain(CpicTag.Start, [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(4) },
    { tag: CpicTag.ClientAddress, value: Buffer.alloc(15) },
    { tag: CpicTag.PartnerSystem, value: Buffer.alloc(9) },
    { tag: CpicTag.PartnerHost, value: Buffer.alloc(17) },
    { tag: CpicTag.ConnectionType, value: Buffer.alloc(1) },
    { tag: CpicTag.KernelPatch, value: Buffer.alloc(4) },
    { tag: CpicTag.KernelRelease, value: Buffer.alloc(4) },
    { tag: CpicTag.Destination, value: Buffer.alloc(10) },
    { tag: CpicTag.Program, value: Buffer.alloc(8) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
    {
      tag: CpicTag.AbapErrorMessage,
      value: Buffer.from("Synthetic logon rejection", "utf16le"),
    },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const response = Buffer.concat([prefix, fields, Buffer.from("ffff", "hex")]);

  assert.deepEqual(decodeCpicInitialLogonResponse(response), {
    success: false,
    // The backend's own reason now reaches the caller. Decoding this envelope
    // and discarding it is what left every rejection indistinguishable.
    rejection: {
      outcome: "abapMessage",
      messageClass: "",
      messageType: "",
      messageNumber: "",
      exceptionKey: "",
      runtimeId: "",
      text: "Synthetic logon rejection",
    },
    negotiatedProtocolVersion: 0x0e0b,
    fields: [
      { tag: CpicTag.ProtocolVersion, byteLength: 4 },
      { tag: CpicTag.Capabilities, byteLength: 11 },
      { tag: CpicTag.SystemCodePage, byteLength: 4 },
      { tag: CpicTag.ClientAddress, byteLength: 15 },
      { tag: CpicTag.PartnerSystem, byteLength: 9 },
      { tag: CpicTag.PartnerHost, byteLength: 17 },
      { tag: CpicTag.ConnectionType, byteLength: 1 },
      { tag: CpicTag.KernelPatch, byteLength: 4 },
      { tag: CpicTag.KernelRelease, byteLength: 4 },
      { tag: CpicTag.Destination, byteLength: 10 },
      { tag: CpicTag.Program, byteLength: 8 },
      { tag: CpicTag.ResponseStart, byteLength: 0 },
      { tag: CpicTag.AbapErrorMessage, byteLength: 50 },
      { tag: CpicTag.End, byteLength: 0 },
    ],
  });
});

test("rejects malformed terminal initial-logon error envelopes", () => {
  const prefix = Buffer.from("010100080101010101010000", "hex");
  const preamble = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(4) },
    { tag: CpicTag.ClientAddress, value: Buffer.alloc(15) },
    { tag: CpicTag.PartnerSystem, value: Buffer.alloc(9) },
    { tag: CpicTag.PartnerHost, value: Buffer.alloc(17) },
    { tag: CpicTag.ConnectionType, value: Buffer.alloc(1) },
    { tag: CpicTag.KernelPatch, value: Buffer.alloc(4) },
    { tag: CpicTag.KernelRelease, value: Buffer.alloc(4) },
    { tag: CpicTag.Destination, value: Buffer.alloc(10) },
    { tag: CpicTag.Program, value: Buffer.alloc(8) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
  ] as const;
  const responseWith = (fields: readonly CpicField[]) => Buffer.concat([
    prefix,
    encodeCpicFieldChain(CpicTag.Start, fields),
    Buffer.from("ffff", "hex"),
  ]);

  const cases: ReadonlyArray<readonly [
    string,
    readonly CpicField[],
    RegExp,
  ]> = [
    [
      "out-of-order preamble",
      [preamble[1], preamble[0], ...preamble.slice(2), {
        tag: CpicTag.AbapErrorMessage,
        value: Buffer.from("Rejected", "utf16le"),
      }, { tag: CpicTag.End, value: Buffer.alloc(0) }],
      /invalid preamble/,
    ],
    [
      "duplicate preamble tag",
      [...preamble, preamble[0], {
        tag: CpicTag.AbapErrorMessage,
        value: Buffer.from("Rejected", "utf16le"),
      }, { tag: CpicTag.End, value: Buffer.alloc(0) }],
      /duplicate preamble fields/,
    ],
    [
      "no rejected outcome",
      [...preamble, {
        tag: CpicTag.Unresolved0420,
        value: Buffer.alloc(4),
      }, { tag: CpicTag.End, value: Buffer.alloc(0) }],
      /lacks a rejected outcome/,
    ],
  ];

  for (const [name, fields, pattern] of cases) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(responseWith(fields)),
      pattern,
      name,
    );
  }
});

test("encodes the capture-sized first Unicode RFC_PING request", () => {
  const encoded = encodeCpicFunctionRequest({
    functionName: "RFC_PING",
    sessionId: Buffer.alloc(16, 0x5a),
  });
  assert.equal(encoded.byteLength, 129);
  assert.equal(
    encoded.subarray(0, 12).toString("hex"),
    "010100080301010504010003",
  );
  assert.equal(encoded.subarray(-10).toString("hex"), "ffff0000007900008500");
  const fields = decodeCpicFieldChainPrefix(
    encoded.subarray(12),
    CpicTag.Start,
    CpicTag.End,
  ).fields;
  assert.deepEqual(
    fields.map((field) => [field.tag, field.value.byteLength]),
    [
      [CpicTag.ProtocolVersion, 4],
      [CpicTag.Capabilities, 11],
      [CpicTag.LogonMarker, 0],
      [CpicTag.Session, 16],
      [CpicTag.ContextEnd, 0],
      [CpicTag.Kernel, 6],
      [CpicTag.Function, 16],
      [CpicTag.CallContext, 0],
      [CpicTag.End, 0],
    ],
  );
  assert.equal(Buffer.from(fields[6]!.value).toString("utf16le"), "RFC_PING");
});

test("decodes a redaction-safe regular RFC success response", () => {
  const fields = encodeCpicFieldChain(CpicTag.ResponseStart, [
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const response = Buffer.concat([
    Buffer.from("05000000", "hex"),
    fields,
    Buffer.from("ffff", "hex"),
  ]);
  assert.deepEqual(decodeCpicFunctionResponse(response), {
    success: true,
    outcome: "success",
    status: 0,
    fields: [
      { tag: CpicTag.ResponseContext, byteLength: 0 },
      { tag: CpicTag.Session, byteLength: 16 },
      { tag: CpicTag.Unresolved0420, byteLength: 4 },
      { tag: CpicTag.CallContext, byteLength: 0 },
      { tag: CpicTag.End, byteLength: 0 },
    ],
  });
});

test("encodes the capture-verified CUT metadata request semantically", () => {
  const encoded = encodeCpicCutFunctionRequest({
    functionName: "RFC_GET_FUNCTION_INTERFACE",
    requestedOutputs: [
      "REMOTE_BASXML_SUPPORTED",
      "REMOTE_CALL",
      "UPDATE_TASK",
      "PARAMS",
      "RESUMABLE_EXCEPTIONS",
    ],
    imports: [
      {
        name: "FUNCNAME",
        value: Buffer.from("STFC_CONNECTION".padEnd(30), "utf16le"),
      },
      { name: "NONE_UNICODE_LENGTH", value: Buffer.from("X", "utf16le") },
    ],
  });

  assert.equal(encoded.byteLength, 408);
  assert.equal(encoded.subarray(0, 4).toString("hex"), "05020000");
  assert.equal(encoded.subarray(-10).toString("hex"), "ffff0000019000008500");
  const fields = decodeCpicFieldChainPrefix(
    encoded.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  assert.deepEqual(
    fields.map((field) => [field.tag, field.value.byteLength]),
    [
      [CpicTag.Kernel, 6],
      [CpicTag.Function, 52],
      [CpicTag.CallContext, 0],
      [CpicTag.RequestedOutput, 46],
      [CpicTag.RequestedOutput, 22],
      [CpicTag.RequestedOutput, 22],
      [CpicTag.RequestedOutput, 12],
      [CpicTag.RequestedOutput, 40],
      [CpicTag.ParameterName, 16],
      [CpicTag.ParameterValue, 60],
      [CpicTag.ParameterName, 38],
      [CpicTag.ParameterValue, 2],
      [CpicTag.End, 0],
    ],
  );
});

test("rejects ambiguous CUT request records before touching the wire", () => {
  assert.throws(
    () =>
      encodeCpicCutFunctionRequest({
        functionName: "RFC_PING",
        requestedOutputs: ["RESULT", "RESULT"],
      }),
    /duplicate requested output RESULT/,
  );
  assert.throws(
    () =>
      encodeCpicCutFunctionRequest({
        functionName: "RFC_PING",
        imports: [
          { name: "INPUT", value: Buffer.alloc(0) },
          { name: "INPUT", value: Buffer.alloc(0) },
        ],
      }),
    /duplicate import INPUT/,
  );
});

test("encodes CUT table inputs as full-width simple-compression records", () => {
  const encoded = encodeCpicCutFunctionRequest({
    functionName: "Z_TABLE_CALL",
    tables: [
      {
        name: "ROWS",
        rowByteLength: 4,
        rows: [Buffer.from("01020304", "hex"), Buffer.from("05060708", "hex")],
      },
    ],
  });
  const fields = decodeCpicFieldChainPrefix(
    encoded.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields;
  const tableOffset = fields.findIndex(
    (field) => field.tag === CpicTag.TableName,
  );
  assert.equal(
    Buffer.from(fields[tableOffset]!.value).toString("utf16le"),
    "ROWS",
  );
  assert.equal(
    Buffer.from(fields[tableOffset + 1]!.value).toString("hex"),
    "0000000400000002",
  );
  assert.deepEqual(
    fields
      .slice(tableOffset + 2, tableOffset + 4)
      .map((field) => [field.tag, Buffer.from(field.value).toString("hex")]),
    [
      [CpicTag.TableCompr, "01020304"],
      [CpicTag.TableCompr, "05060708"],
    ],
  );
  assert.throws(
    () =>
      encodeCpicCutFunctionRequest({
        functionName: "Z_TABLE_CALL",
        tables: [{ name: "ROWS", rowByteLength: 4, rows: [Buffer.alloc(3)] }],
      }),
    /ROWS row 0 contains 3 bytes; expected 4/,
  );
});

test("returns cloned application fields only through the explicit result decoder", () => {
  const secret = Buffer.from("sensitive", "utf16le");
  const response = Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, [
      { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
      { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
      { tag: CpicTag.ParameterName, value: Buffer.from("RESULT", "utf16le") },
      { tag: CpicTag.ParameterValue, value: secret },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);

  const decoded = decodeCpicFunctionResultFields(response);
  assert.equal(decoded.success, true);
  assert.equal(decoded.fields[5]!.value.equals(secret), true);

  const watchedBytes = Buffer.from(response);
  let forbiddenWholeInputReads = 0;
  const watchedResponse = new Proxy(watchedBytes, {
    get(value, property) {
      if (property === "byteLength") return value.byteLength;
      if (property === "subarray") return value.subarray.bind(value);
      forbiddenWholeInputReads += 1;
      throw new Error(
        `whole response property ${String(property)} read before bounded decode`,
      );
    },
  }) as unknown as Uint8Array;
  assert.equal(
    decodeCpicFunctionResultFields(watchedResponse).fields[5]!.value.equals(
      secret,
    ),
    true,
  );
  assert.equal(forbiddenWholeInputReads, 0);

  response.fill(0);
  assert.equal(decoded.fields[5]!.value.equals(secret), true);
  assert.equal(
    "value" in
      decodeCpicFunctionResponse(
        Buffer.concat([
          Buffer.from("05000000", "hex"),
          encodeCpicFieldChain(CpicTag.ResponseStart, [
            { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
            { tag: CpicTag.End, value: Buffer.alloc(0) },
          ]),
          Buffer.from("ffff", "hex"),
        ]),
      ).fields[0]!,
    false,
  );
});

test("classifies the capture-verified declared ABAP exception envelope", () => {
  const response = Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, [
      { tag: CpicTag.AbapMessageClass, value: Buffer.from("SR", "utf16le") },
      { tag: CpicTag.AbapMessageType, value: Buffer.from("E", "utf16le") },
      { tag: CpicTag.AbapMessageNumber, value: Buffer.from("006", "utf16le") },
      {
        tag: CpicTag.AbapMessageV1,
        value: Buffer.from("Method = 1", "utf16le"),
      },
      {
        tag: CpicTag.AbapExceptionKey,
        value: Buffer.from("RAISE_EXCEPTION", "utf16le"),
      },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  const decoded = decodeCpicFunctionResultFields(response);
  assert.equal(decoded.envelope.outcome, "abapException");
  assert.equal(decoded.envelope.facts.exceptionKey, "RAISE_EXCEPTION");
  assert.equal(decoded.envelope.facts.messageClass, "SR");
  assert.equal(decoded.envelope.facts.messageType, "E");
  assert.equal(decoded.envelope.facts.messageNumber, "006");
  assert.equal(decoded.envelope.facts.messageV1, "Method = 1");
  assert.equal(decoded.success, false);
  assert.equal(decoded.status, undefined);
  assert.equal(
    decodeCpicFunctionResponse(response).exceptionKey,
    "RAISE_EXCEPTION",
  );
});

test("keeps the complete RFC error-tag taxonomy and application fields", () => {
  assert.deepEqual(
    [
      CpicTag.AbapExceptionKey,
      CpicTag.AbapErrorMessage,
      CpicTag.AbapRuntimeId,
      CpicTag.AbapT100Text,
      CpicTag.AbapMessageV1,
      CpicTag.AbapMessageV2,
      CpicTag.AbapMessageV3,
      CpicTag.AbapMessageV4,
      CpicTag.AbapMessageClass,
      CpicTag.AbapMessageType,
      CpicTag.AbapMessageNumber,
      CpicTag.AbapCallStack,
      CpicTag.Unresolved0420,
      CpicTag.UseClassExceptions,
      CpicTag.ClassExceptionInfo,
      CpicTag.ClassException,
      CpicTag.ClassExceptionEnd,
    ],
    [
      0x0401, 0x0402, 0x0403, 0x0404,
      0x0411, 0x0412, 0x0413, 0x0414,
      0x0415, 0x0416, 0x0417, 0x0418,
      0x0420, 0x0421, 0x0422, 0x0423, 0x0424,
    ],
  );
  assert.equal(CpicTag[0x0420], "Unresolved0420");

  const response = Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, [
      { tag: CpicTag.ParameterName, value: Buffer.from("RESULT", "utf16le") },
      { tag: CpicTag.ParameterValue, value: Buffer.from("retained", "utf16le") },
      { tag: CpicTag.AbapErrorMessage, value: Buffer.from("Runtime text", "utf16le") },
      { tag: CpicTag.AbapRuntimeId, value: Buffer.from("RUNTIME_ID", "utf16le") },
      { tag: CpicTag.AbapCallStack, value: Buffer.from("private stack", "utf16le") },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  const decoded = decodeCpicFunctionResultFields(response);
  assert.equal(decoded.success, false);
  assert.equal(decoded.envelope.outcome, "abapRuntime");
  assert.equal(decoded.envelope.facts.runtimeId, "RUNTIME_ID");
  assert.equal(decoded.envelope.facts.callStack, "private stack");
  assert.equal(decoded.fields[1]!.value.toString("utf16le"), "retained");
});

test("retains error-state 0x0420 only as unresolved provenance", () => {
  const response = Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, [
      {
        tag: CpicTag.AbapExceptionKey,
        value: Buffer.from("RAISE_EXCEPTION", "utf16le"),
      },
      {
        tag: CpicTag.Unresolved0420,
        value: Buffer.from("deadbeef", "hex"),
      },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
  const decoded = decodeCpicFunctionResultFields(response);
  assert.equal(decoded.envelope.outcome, "abapException");
  assert.equal(decoded.status, undefined);
  assert.deepEqual(decoded.envelope.facts.unresolved0420, [{
    tag: CpicTag.Unresolved0420,
    ordinal: 1,
    byteLength: 4,
    valueHex: "deadbeef",
  }]);
});

test("accepts reset-done only in the SYSTEM_RESET_RFC_SERVER response state", () => {
  const responseWith = (fields: readonly CpicField[]): Buffer => Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, fields),
    Buffer.from("ffff", "hex"),
  ]);
  const successfulReset = responseWith([
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.RfcServerResetDone, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);

  assert.equal(
    decodeCpicResetServerContextResultFields(successfulReset).success,
    true,
  );
  const netWeaver750Reset = responseWith([
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.equal(
    decodeCpicResetServerContextResultFields(netWeaver750Reset).success,
    true,
  );
  assert.throws(
    () => decodeCpicFunctionResultFields(successfulReset),
    /unknown tag 0x0523/,
  );
  for (const fields of [
    [
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.RfcServerResetDone, value: Buffer.alloc(0) },
      { tag: CpicTag.RfcServerResetDone, value: Buffer.alloc(0) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.RfcServerResetDone, value: Buffer.of(1) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
  ]) {
    assert.throws(
      () => decodeCpicResetServerContextResultFields(responseWith(fields)),
      /reset-done control must be empty and unique/,
    );
  }

  const remoteFailure = responseWith([
    {
      tag: CpicTag.AbapRuntimeId,
      value: Buffer.from("RESET_FAILED", "utf16le"),
    },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  assert.equal(
    decodeCpicResetServerContextResultFields(remoteFailure).envelope.outcome,
    "abapRuntime",
  );
});

test("decodes only the bounded session-refresh wrapper after reset", () => {
  const responseWith = (fields: readonly CpicField[]): Buffer => Buffer.concat([
    Buffer.from("010100080101010504010003", "hex"),
    encodeCpicFieldChain(CpicTag.Start, fields),
    Buffer.from("ffff", "hex"),
  ]);
  const successfulRefresh = responseWith([
    { tag: CpicTag.ProtocolVersion, value: Buffer.alloc(4) },
    { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
    { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
    { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
    { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
  const decoded = decodeCpicSessionRefreshResultFields(successfulRefresh);
  assert.equal(decoded.success, true);
  assert.deepEqual(
    decoded.fields.map((field) => [field.tag, field.value.byteLength]),
    [
      [CpicTag.ResponseContext, 0],
      [CpicTag.Unresolved0420, 4],
      [CpicTag.End, 0],
    ],
  );
  assert.throws(
    () => decodeCpicFunctionResultFields(successfulRefresh),
    /prefix is invalid/,
  );
  for (const fields of [
    [
      { tag: CpicTag.ProtocolVersion, value: Buffer.alloc(4) },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      { tag: CpicTag.ResponseStart, value: Buffer.alloc(1) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.ProtocolVersion, value: Buffer.alloc(4) },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      { tag: 0x7777, value: Buffer.alloc(0) },
      { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.ProtocolVersion, value: Buffer.alloc(4) },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      { tag: CpicTag.LogonStatus, value: Buffer.of(1) },
      { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
  ]) {
    assert.throws(
      () => decodeCpicSessionRefreshResultFields(responseWith(fields)),
      /session-refresh/,
    );
  }
});

test("fails closed on unknown or unsupported regular RFC error envelopes", () => {
  const responseWith = (fields: readonly CpicField[]): Buffer => Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, fields),
    Buffer.from("ffff", "hex"),
  ]);
  for (const fields of [
    [
      { tag: 0x7777, value: Buffer.alloc(0) },
      { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
    [
      { tag: CpicTag.ClassException, value: Buffer.alloc(0) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ],
  ]) {
    assert.throws(() => decodeCpicFunctionResultFields(responseWith(fields)));
  }
});
