import assert from "node:assert/strict";
import test from "node:test";

import { Client, RFCError } from "../src/index.js";
import {
  CpicTag,
  decodeCpicInitialLogonResponse,
  encodeCpicFieldChain,
} from "../src/protocol/cpic.js";
import { ScriptedRfcPeer } from "./support/scripted-rfc-peer.js";

// Synthetic text and identities only. Both early-error preamble shapes are
// already part of the supported grammar; text encoding must follow that shape.
function rejection(
  value: Buffer,
  unicode = false,
  rich = false,
): Buffer {
  return Buffer.concat([
    Buffer.from("010100080101010101010000", "hex"),
    encodeCpicFieldChain(CpicTag.Start, [
      { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
      { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
      ...(rich ? [{ tag: CpicTag.LogonStatus, value: Buffer.of(1) }] : []),
      { tag: CpicTag.SystemCodePage, value: Buffer.alloc(unicode ? 8 : 4) },
      ...(rich ? [{ tag: 0x0450, value: Buffer.alloc(3) }] : []),
      { tag: CpicTag.ClientAddress, value: Buffer.alloc(15) },
      ...(rich ? [
        { tag: 0x0020, value: Buffer.alloc(46) },
        { tag: 0x0021, value: Buffer.alloc(10) },
      ] : []),
      { tag: CpicTag.PartnerSystem, value: Buffer.alloc(9) },
      { tag: CpicTag.PartnerHost, value: Buffer.alloc(17) },
      { tag: CpicTag.ConnectionType, value: Buffer.alloc(unicode ? 2 : 1) },
      { tag: CpicTag.KernelPatch, value: Buffer.alloc(unicode ? 8 : 4) },
      { tag: CpicTag.KernelRelease, value: Buffer.alloc(unicode ? 8 : 4) },
      { tag: CpicTag.Destination, value: Buffer.alloc(10) },
      { tag: CpicTag.Program, value: Buffer.alloc(8) },
      { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
      { tag: CpicTag.AbapErrorMessage, value },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
}

test("initial logon decodes odd and even single-byte rejection text", () => {
  for (const rich of [false, true]) {
    for (const text of ["Language denied", "Denied"]) {
      const decoded = decodeCpicInitialLogonResponse(
        rejection(Buffer.from(text, "ascii"), false, rich),
      );
      assert.equal(decoded.success, false);
      assert.equal(decoded.rejection?.text, text);
    }
  }
});

test("initial logon keeps Unicode rejection text and does not guess encodings", () => {
  const text = "Synthetic rejection: Grüße 你好";
  assert.equal(
    decodeCpicInitialLogonResponse(rejection(Buffer.from(text, "utf16le"), true)).rejection?.text,
    text,
  );
  assert.throws(
    () => decodeCpicInitialLogonResponse(rejection(Buffer.from("Odd", "ascii"), true)),
    /odd UTF-16LE/u,
  );
  for (const bytes of [Buffer.of(0x41, 0), Buffer.of(0xc1, 0x42)]) {
    assert.throws(() => decodeCpicInitialLogonResponse(rejection(bytes)), /NUL|non-ASCII/u);
  }
});

test("Client reports a single-byte language rejection and never retries it", async (t) => {
  for (const rich of [false, true]) {
    await t.test(rich ? "rich preamble" : "compact preamble", async () => {
      const message = "Synthetic language rejection";
      const peer = await ScriptedRfcPeer.start([{
        logonResponse: rejection(Buffer.from(message, "ascii"), false, rich),
      }]);
      const client = new Client({
        ashost: "application.example.test",
        gwhost: "127.0.0.1",
        port: peer.port,
        client: "001",
        user: "RFCUSR",
        passwd: "synthetic-password",
        lang: "ZH",
      });
      try {
        await assert.rejects(async () => client.open(), (error: unknown) =>
          error instanceof RFCError && error.codeString === "RFC_LOGON_FAILURE" &&
          error.message === message,
        );
        assert.equal(client.alive, false);
        assert.equal(client.connectionHandle, 0);
        await assert.rejects(async () => client.ping(), /closed connection/u);
        assert.equal(peer.connectionCount, 1);
      } finally {
        if (client.alive) await client.close();
        await peer.close();
      }
    });
  }
});
