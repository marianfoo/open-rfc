import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeRfcLogonTicket,
  normalizeRfcLogonTicket,
} from "../src/protocol/logon-ticket.js";

test("normalizes canonical, cookie-substituted, and percent-escaped tickets", () => {
  assert.equal(normalizeRfcLogonTicket("  AjQxMDM=  "), "AjQxMDM=");
  assert.equal(normalizeRfcLogonTicket("AB!C"), "AB/C");
  assert.equal(normalizeRfcLogonTicket("AB%2F"), "AB/");
  assert.equal(normalizeRfcLogonTicket("AB%21"), "AB/");
  assert.equal(normalizeRfcLogonTicket("AB+C"), "AB+C");
  assert.equal(normalizeRfcLogonTicket("AB%2BC"), "AB+C");
});

test("encodes the canonical ticket as exact UTF-16LE CPIC bytes", () => {
  const encoded = encodeRfcLogonTicket("AjQxMDM=");
  assert.equal(encoded.toString("hex"), "41006a00510078004d0044004d003d00");
  assert.equal(encoded.toString("utf16le"), "AjQxMDM=");
});

test("rejects malformed or over-budget ticket text without echoing it", () => {
  for (const [value, expected] of [
    ["", /1\.\.16384/u],
    ["A", /canonical base64/u],
    ["AB-C", /canonical base64/u],
    ["AB%2", /invalid percent encoding/u],
    ["AB=C", /canonical base64/u],
    ["A==", /canonical base64/u],
    ["AB=", /canonical base64/u],
  ] as const) {
    assert.throws(() => normalizeRfcLogonTicket(value), expected);
  }
  const oversized = "A".repeat(17);
  assert.throws(
    () => normalizeRfcLogonTicket(oversized, { maxLength: 16 }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes(oversized),
  );
  assert.throws(
    () => normalizeRfcLogonTicket("AAAA", { maxLength: 0 }),
    /maxLength/u,
  );
});
