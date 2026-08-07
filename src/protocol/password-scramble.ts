import { randomBytes } from "node:crypto";

const PASSWORD_SCRAMBLE_TABLE = Buffer.from([
  0xf0, 0xed, 0x53, 0xb8, 0x32, 0x44, 0xf1, 0xf8, 0x76, 0xc6, 0x79, 0x59, 0xfd,
  0x4f, 0x13, 0xa2, 0xc1, 0x51, 0x95, 0xec, 0x54, 0x83, 0xc2, 0x34, 0x77, 0x49,
  0x43, 0xa2, 0x7d, 0xe2, 0x65, 0x96, 0x5e, 0x53, 0x98, 0x78, 0x9a, 0x17, 0xa3,
  0x3c, 0xd3, 0x83, 0xa8, 0xb8, 0x29, 0xfb, 0xdc, 0xa5, 0x55, 0xd7, 0x02, 0x77,
  0x84, 0x13, 0xac, 0xdd, 0xf9, 0xb8, 0x31, 0x16, 0x61, 0x0e, 0x6d, 0xfa,
]);

/** Internal CPIC/WebSocket logon-password field producer. */
export function scrambleRfcPassword(password: string, seed?: number): Buffer {
  if (typeof password !== "string") {
    throw new TypeError("password must be a string");
  }
  // Every admitted character is one-byte ASCII, so this cheap code-unit check
  // rejects oversized local input before regex scanning or Buffer allocation.
  if (password.length > 40) {
    throw new RangeError("password must contain at most 40 bytes");
  }
  if (!/^[\x20-\x7e]*$/.test(password)) {
    throw new RangeError(
      "password contains characters outside the proven ASCII baseline",
    );
  }
  const clear = Buffer.from(password, "ascii");
  let result: Buffer | undefined;
  try {
    const actualSeed = seed ?? randomBytes(4).readUInt32LE(0);
    if (
      !Number.isSafeInteger(actualSeed) ||
      actualSeed < 0 ||
      actualSeed > 0xffff_ffff
    ) {
      throw new RangeError("password seed must be an unsigned 32-bit integer");
    }

    result = Buffer.alloc(4 + clear.byteLength);
    result.writeUInt32LE(actualSeed, 0);
    const mixedSeed = (actualSeed ^ (actualSeed >>> 5)) >>> 0;
    const startIndex = (mixedSeed ^ ((actualSeed << 1) >>> 0)) >>> 0;
    for (let index = 0; index < clear.byteLength; index += 1) {
      // The 40-byte cap above keeps actualSeed * index * index under 2 ** 53,
      // so number arithmetic stays exact and the mask needs no wider type.
      const tableValue = PASSWORD_SCRAMBLE_TABLE[(startIndex + index) & 0x3f]!;
      const seedTerm = (actualSeed * index * index - index) & 0xff;
      result[4 + index] = clear[index]! ^ tableValue ^ seedTerm;
    }
    return result;
  } catch (cause) {
    result?.fill(0);
    throw cause;
  } finally {
    clear.fill(0);
  }
}
