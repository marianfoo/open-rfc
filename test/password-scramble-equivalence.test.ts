import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { scrambleRfcPassword } from "../src/protocol/password-scramble.js";

/**
 * Frozen output vectors for the logon-password field.
 *
 * The producer feeds a wire field a server either accepts or rejects, so its
 * bytes are a fixed point: any refactor here has to reproduce them exactly.
 * These expectations were captured by running the sweep below against the
 * built producer and pinning what it emitted, so a regression shows up as a
 * byte difference rather than as an assertion someone has to re-reason about.
 */

const PRINTABLE_ASCII: number[] = [];
for (let code = 0x20; code <= 0x7e; code += 1) {
  PRINTABLE_ASCII.push(code);
}

/** Seeds spanning the low and high ends plus a spread of interior values. */
function sweepSeeds(): number[] {
  const seeds: number[] = [];
  for (let seed = 0; seed <= 0xff; seed += 1) {
    seeds.push(seed);
  }
  for (let seed = 0xffff_ff00; seed <= 0xffff_ffff; seed += 1) {
    seeds.push(seed);
  }
  seeds.push(
    0x0000_0100,
    0x0000_8000,
    0x0000_ffff,
    0x0001_0000,
    0x5ae0_b7a3,
    0x7fff_ffff,
    0x8000_0000,
    0xdead_beef,
    0xfedc_ba98,
    0x1234_5678,
  );
  return seeds;
}

/** A password of `length` bytes cycling through the admitted ASCII range. */
function sweepPassword(length: number): string {
  let password = "";
  for (let position = 0; position < length; position += 1) {
    password += String.fromCharCode(
      PRINTABLE_ASCII[(position * 7 + length) % PRINTABLE_ASCII.length]!,
    );
  }
  return password;
}

test("produces the frozen field bytes across the full input sweep", () => {
  const digest = createHash("sha256");
  let vectors = 0;
  const absorb = (password: string, seed: number): void => {
    digest.update(scrambleRfcPassword(password, seed));
    digest.update(Buffer.of(0xff));
    vectors += 1;
  };

  // Every admitted length against every seed class. 512 of the seeds are
  // contiguous, so the table start position covers all 64 slots and a
  // 40-byte password wraps past the end of the table many times over.
  for (const seed of sweepSeeds()) {
    for (let length = 0; length <= 40; length += 1) {
      absorb(sweepPassword(length), seed);
    }
  }
  // Every admitted character at every position, at two seeds.
  for (const code of PRINTABLE_ASCII) {
    absorb(String.fromCharCode(code).repeat(40), 0);
    absorb(String.fromCharCode(code).repeat(40), 0x5ae0_b7a3);
  }

  assert.equal(vectors, 21_592);
  assert.equal(
    digest.digest("hex"),
    "f3e0b74e48219b80e926e4ff2684c045e4fc93015eca9221a5ddb6a50cd8ff82",
  );
});

test("produces the frozen field bytes for the named boundary cases", () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    // Empty password: the seed prefix is the whole field.
    ["", 0, "00000000"],
    // Seed 0 drives the per-position term negative from the second byte on.
    ["AB", 0, "00000000b150"],
    // Seed 0x15 starts the table read on its last slot, so byte 1 wraps.
    ["secret", 0x15, "150000008981dc9b914e"],
    [
      "x".repeat(40),
      0x15,
      "15000000829cc7918c42d277b89294e3e555310d2a1dab67283465f464236b8" +
        "9eee52cab0e1299ba2cca2145",
    ],
    // Maximum length at the maximum seed: the widest per-position term.
    [
      "x".repeat(40),
      0xffff_ffff,
      "ffffffff157c7261c7229cf431269cc2656bab279b1413adb1a62a23123a4d3d" +
        "ef405bbafd707c3f2c82d487",
    ],
    ["~", 0xffff_ffff, "ffffffff13"],
  ];
  for (const [password, seed, expected] of cases) {
    assert.equal(
      scrambleRfcPassword(password, seed).toString("hex"),
      expected,
      `password of ${password.length} bytes at seed 0x${seed.toString(16)}`,
    );
  }
});
