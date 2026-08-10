import assert from "node:assert/strict";
import test from "node:test";

import {
  CpicTag,
  decodeCpicInitialLogonResponse,
  encodeCpicFieldChain,
  type CpicField,
} from "../src/protocol/cpic.js";

/**
 * The initial-logon response grammar.
 *
 * This replaced seven enumerated whole-response graphs whose every byte length
 * was pinned — including coordinates that carry host and destination names.
 * Four of those seven existed only to cover two widths of the same name, and a
 * reply that differed by two characters was reported as RFC_INVALID_PROTOCOL,
 * indistinguishable from a rejected credential. Three live runs on the two
 * formal profiles had in fact authenticated.
 *
 * The rule this file pins: unknown TAGS fail closed, control coordinates keep
 * their exact widths, order is exact — and TEXT coordinates may be any legal
 * length.
 */

const REGULAR_PREFIX = Buffer.from("010100080101010504010003", "hex");
const ERROR_PREFIX = Buffer.from("010100080101010101010000", "hex");
const TRAILER = Buffer.from("ffff", "hex");

function response(fields: readonly CpicField[], prefix = REGULAR_PREFIX): Buffer {
  return Buffer.concat([
    prefix,
    encodeCpicFieldChain(CpicTag.Start, fields),
    TRAILER,
  ]);
}

const field = (tag: number, byteLength: number): CpicField => ({
  tag,
  value: Buffer.alloc(byteLength),
});

interface PreambleOptions {
  readonly logonStatus?: number | null;
  readonly vendorControl?: number | null;
  readonly clientAddress?: number;
  readonly extraControls?: boolean;
  readonly partnerSystem?: number;
  readonly partnerHost?: number;
  readonly destination?: number | null;
  readonly program?: number;
}

function preamble({
  logonStatus = 0,
  vendorControl = 20,
  clientAddress = 30,
  extraControls = true,
  partnerSystem = 20,
  partnerHost = 34,
  destination = 22,
  program = 16,
}: PreambleOptions = {}): CpicField[] {
  return [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    field(CpicTag.Capabilities, 11),
    ...(logonStatus === null
      ? []
      : [{ tag: CpicTag.LogonStatus, value: Buffer.of(logonStatus) }]),
    field(CpicTag.SystemCodePage, 8),
    ...(vendorControl === null ? [] : [
      field(0x0450, 6),
      field(0x0451, 20),
      field(0x0452, 4),
      field(0x0453, vendorControl),
    ]),
    field(CpicTag.ClientAddress, clientAddress),
    ...(extraControls ? [field(0x0020, 92), field(0x0021, 20)] : []),
    field(CpicTag.PartnerSystem, partnerSystem),
    field(CpicTag.PartnerHost, partnerHost),
    field(CpicTag.ConnectionType, 2),
    field(CpicTag.KernelPatch, 8),
    field(CpicTag.KernelRelease, 8),
    ...(destination === null ? [] : [field(CpicTag.Destination, destination)]),
    field(CpicTag.Program, program),
    field(0x0150, 24),
    field(0x0151, 6),
    field(0x0152, 2),
  ];
}

function embeddedResponse(
  { control = false, program = 80 }: { control?: boolean; program?: number } = {},
): CpicField[] {
  return [
    field(CpicTag.ResponseStart, 0),
    field(CpicTag.ResponseContext, 0),
    field(CpicTag.Session, 16),
    field(CpicTag.Unresolved0420, 4),
    field(CpicTag.CallContext, 0),
    field(CpicTag.Program, program),
    field(0x0667, 8),
    ...(control ? [field(0x0126, 4)] : []),
    field(CpicTag.End, 0),
  ];
}

const composite = (
  preambleOptions?: PreambleOptions,
  responseOptions?: { control?: boolean; program?: number },
): CpicField[] => [...preamble(preambleOptions), ...embeddedResponse(responseOptions)];

/**
 * Every graph the retired allowlist enumerated, retyped from its recorded
 * anatomy so this test does not depend on the deleted constants. If the
 * grammar ever stops admitting one of these, it has regressed.
 */
const RETIRED_ALLOWLIST: ReadonlyArray<readonly [string, CpicField[]]> = [
  ["#0 rich: 0x0453 wide, host 30, no Destination, embedded 0x0126",
    composite({ vendorControl: 42, partnerHost: 30, destination: null }, { control: true })],
  ["#1 compact rich, Destination 22", composite()],
  ["#2 compact rich, Destination 22, embedded 0x0126", composite({}, { control: true })],
  ["#3 compact rich, Destination 20", composite({ destination: 20 })],
  ["#4 compact rich, no Destination", composite({ destination: null })],
  ["#5 call-status only, Destination 22",
    composite({ logonStatus: null, vendorControl: null, extraControls: false, partnerSystem: 18 })],
  ["#6 call-status only, Destination 20",
    composite({
      logonStatus: null, vendorControl: null, extraControls: false,
      partnerSystem: 18, destination: 20,
    })],
];

test("the grammar admits every graph the retired allowlist enumerated", () => {
  for (const [name, fields] of RETIRED_ALLOWLIST) {
    const decoded = decodeCpicInitialLogonResponse(response(fields));
    assert.equal(decoded.success, true, name);
    assert.equal(decoded.negotiatedProtocolVersion, 0x0e0b, name);
    assert.equal(decoded.fields.length, fields.length, name);
  }
});

/**
 * The graph the S/4HANA 2023 boundary probe received on 2026-08-05. It is an
 * admitted graph plus one four-byte 0x0126 before End, and it was refused with
 * `unsupported-field` before the logon status byte was ever read.
 */
test("the grammar admits the 2026-08-05 S/4HANA reply that was refused", () => {
  const fields = composite(
    { vendorControl: 20, destination: 20 },
    { control: true },
  );
  assert.equal(fields.length, 30);
  const decoded = decodeCpicInitialLogonResponse(response(fields));
  assert.equal(decoded.success, true);
  assert.equal(decoded.status, 0);
});

/**
 * The graph the NetWeaver 7.50 probe received on 2026-08-04: a call-status-only
 * composite whose Destination is 20 bytes rather than the 22 then enumerated.
 * It carries a fully executed embedded RFCPING response, so the server had
 * authenticated; the client reported a logon failure over two bytes.
 */
test("the grammar admits the 2026-08-04 NetWeaver reply that was refused", () => {
  const fields = composite({
    logonStatus: null, vendorControl: null, extraControls: false,
    partnerSystem: 18, destination: 20,
  });
  assert.equal(fields.length, 22);
  const decoded = decodeCpicInitialLogonResponse(response(fields));
  assert.equal(decoded.success, true);
});

test("a text coordinate parses identically at every legal length", () => {
  const reference = decodeCpicInitialLogonResponse(response(composite()));
  for (const width of [1, 2, 7, 16, 19, 20, 21, 22, 23, 40, 64, 120, 200, 255]) {
    for (const tag of ["destination", "partnerHost", "partnerSystem", "program"] as const) {
      const decoded = decodeCpicInitialLogonResponse(
        response(composite({ [tag]: width })),
      );
      assert.equal(decoded.success, reference.success, `${tag}=${width}`);
      assert.equal(decoded.status, reference.status, `${tag}=${width}`);
      assert.equal(
        decoded.negotiatedProtocolVersion,
        reference.negotiatedProtocolVersion,
        `${tag}=${width}`,
      );
      assert.equal(decoded.fields.length, reference.fields.length, `${tag}=${width}`);
    }
  }
});

test("a text coordinate outside its bound still fails closed", () => {
  for (const width of [0, 256, 300]) {
    assert.throws(
      () => decodeCpicInitialLogonResponse(response(composite({ destination: width }))),
      (error: unknown) =>
        error instanceof Error &&
        (error as { rule?: unknown }).rule === "unsupported-field-zero-logon-status",
      `Destination ${width}`,
    );
  }
});

test("an unknown tag still fails closed", () => {
  const fields = composite();
  const withUnknown = [...fields.slice(0, 6), field(0x0999, 4), ...fields.slice(6)];
  assert.throws(
    () => decodeCpicInitialLogonResponse(response(withUnknown)),
    (error: unknown) =>
      error instanceof Error && (error as { rule?: unknown }).rule !== undefined,
  );
});

test("control coordinates keep their exact widths", () => {
  const cases: ReadonlyArray<readonly [string, number, number]> = [
    ["Capabilities", CpicTag.Capabilities, 12],
    ["SystemCodePage", CpicTag.SystemCodePage, 9],
    ["ConnectionType", CpicTag.ConnectionType, 3],
    ["KernelRelease", CpicTag.KernelRelease, 7],
    ["Session", CpicTag.Session, 15],
    ["0x0450", 0x0450, 7],
  ];
  for (const [name, tag, byteLength] of cases) {
    const fields = composite().map((current) =>
      current.tag === tag ? field(tag, byteLength) : current
    );
    assert.throws(
      () => decodeCpicInitialLogonResponse(response(fields)),
      Error,
      name,
    );
  }
});

test("reordering, duplication and truncation still fail closed", () => {
  const fields = composite();
  const swapped = [fields[1]!, fields[0]!, ...fields.slice(2)];
  assert.throws(() => decodeCpicInitialLogonResponse(response(swapped)), Error);

  const duplicated = [...fields.slice(0, 2), field(CpicTag.Capabilities, 11), ...fields.slice(2)];
  assert.throws(() => decodeCpicInitialLogonResponse(response(duplicated)), Error);

  const withoutCallStatus = fields.filter((current) => current.tag !== CpicTag.Unresolved0420);
  assert.throws(() => decodeCpicInitialLogonResponse(response(withoutCallStatus)), Error);

  const trailing = [...fields, field(0x0667, 8)];
  assert.throws(() => decodeCpicInitialLogonResponse(response(trailing)), Error);
});

test("a nonzero logon status is preserved as a rejection, not a protocol error", () => {
  const decoded = decodeCpicInitialLogonResponse(
    response(composite({ logonStatus: 3 })),
  );
  assert.equal(decoded.success, false);
  assert.equal(decoded.status, 3);
});

test("a nonzero embedded call status still fails closed", () => {
  const fields = composite().map((current) =>
    current.tag === CpicTag.Unresolved0420
      ? { tag: CpicTag.Unresolved0420, value: Buffer.from("00000001", "hex") }
      : current
  );
  assert.throws(
    () => decodeCpicInitialLogonResponse(response(fields)),
    (error: unknown) =>
      error instanceof Error &&
      (error as { rule?: unknown }).rule === "nonzero-call-status",
  );
});

/**
 * The NetWeaver 7.50 boundary probe on 2026-08-05 received an error-class
 * response carrying one AbapErrorMessage. The envelope was decoded purely to
 * confirm the outcome was not `success` and then discarded, so the recorded
 * result had `reasonCode: null` and the server's own explanation was lost.
 */
test("an error-class rejection reaches the caller with the backend's reason", () => {
  const utf16 = (value: string) => Buffer.from(value, "utf16le");
  const errorFields: CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    field(CpicTag.Capabilities, 11),
    field(CpicTag.SystemCodePage, 8),
    field(CpicTag.ClientAddress, 30),
    field(CpicTag.PartnerSystem, 18),
    field(CpicTag.PartnerHost, 34),
    field(CpicTag.ConnectionType, 2),
    field(CpicTag.KernelPatch, 8),
    field(CpicTag.KernelRelease, 8),
    field(CpicTag.Destination, 20),
    field(CpicTag.Program, 16),
    field(CpicTag.ResponseStart, 0),
    { tag: CpicTag.AbapErrorMessage, value: utf16("Name or password is incorrect") },
    field(CpicTag.End, 0),
  ];
  assert.equal(errorFields.length, 14);

  const decoded = decodeCpicInitialLogonResponse(response(errorFields, ERROR_PREFIX));
  assert.equal(decoded.success, false);
  assert.ok(decoded.rejection !== undefined, "the backend's reason must reach the caller");
  assert.equal(decoded.rejection.outcome, "abapMessage");
  assert.equal(decoded.rejection.text, "Name or password is incorrect");
  assert.equal(decoded.rejection.exceptionKey, "");
  assert.equal(decoded.rejection.runtimeId, "");
});

test("an error-class rejection carrying an SAP message identity keeps it", () => {
  const utf16 = (value: string) => Buffer.from(value, "utf16le");
  const errorFields: CpicField[] = [
    { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
    field(CpicTag.Capabilities, 11),
    field(CpicTag.SystemCodePage, 8),
    field(CpicTag.ClientAddress, 30),
    field(CpicTag.PartnerSystem, 18),
    field(CpicTag.PartnerHost, 34),
    field(CpicTag.ConnectionType, 2),
    field(CpicTag.KernelPatch, 8),
    field(CpicTag.KernelRelease, 8),
    field(CpicTag.Destination, 20),
    field(CpicTag.Program, 16),
    field(CpicTag.ResponseStart, 0),
    { tag: CpicTag.AbapMessageClass, value: utf16("00") },
    { tag: CpicTag.AbapMessageType, value: utf16("E") },
    { tag: CpicTag.AbapMessageNumber, value: utf16("054") },
    field(CpicTag.End, 0),
  ];
  const decoded = decodeCpicInitialLogonResponse(response(errorFields, ERROR_PREFIX));
  assert.equal(decoded.success, false);
  assert.ok(decoded.rejection !== undefined);
  assert.equal(decoded.rejection.messageClass, "00");
  assert.equal(decoded.rejection.messageType, "E");
  assert.equal(decoded.rejection.messageNumber, "054");
});
