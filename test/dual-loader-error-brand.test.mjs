import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("RFC errors retain their identity across the ESM and CommonJS builds", async () => {
  const esm = await import("../dist/src/index.js");
  const cjs = require("../dist/cjs/index.js");

  const cjsRfcError = new cjs.RFCError("cross-loader", {
    group: 5,
    code: cjs.RFCErrorCode.RFC_INVALID_PARAMETER,
    codeString: "RFC_INVALID_PARAMETER",
    key: "RFC_INVALID_PARAMETER",
  });
  assert.equal(cjsRfcError instanceof esm.RFCError, false);
  assert.equal(esm.RFCError.isRFCError(cjsRfcError), true);
  assert.equal(esm.RFCError.isABAPError(cjsRfcError), false);

  const cjsAbapError = new cjs.ABAPError({
    key: "NEUTRAL_EXCEPTION",
    message: "neutral failure",
    messageClass: "",
    messageType: "",
    messageNumber: "000",
  });
  assert.equal(cjsAbapError instanceof esm.ABAPError, false);
  assert.equal(esm.RFCError.isRFCError(cjsAbapError), true);
  assert.equal(esm.RFCError.isABAPError(cjsAbapError), true);

  const serialized = JSON.stringify(cjsAbapError);
  assert.equal(serialized.includes("open-rfc.RFCError"), false);
  assert.equal(serialized.includes("open-rfc.ABAPError"), false);
  assert.equal(esm.RFCError.isRFCError({}), false);
  assert.equal(esm.RFCError.isABAPError({}), false);
  for (const unbranded of [null, undefined, false, 0, "", Symbol("unbranded")]) {
    assert.equal(esm.RFCError.isRFCError(unbranded), false);
    assert.equal(esm.RFCError.isABAPError(unbranded), false);
  }
});
