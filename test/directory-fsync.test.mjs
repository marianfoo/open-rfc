import assert from "node:assert/strict";
import test from "node:test";

import { fsyncDirectoryDescriptor } from "../tools/directory_fsync.mjs";

function codedError(code) {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

test("directory fsync reports a completed synchronization", () => {
  let observed;
  assert.equal(
    fsyncDirectoryDescriptor(17, (descriptor) => {
      observed = descriptor;
    }, "linux"),
    true,
  );
  assert.equal(observed, 17);
});

test("only unsupported Windows directory-fsync errors are tolerated", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]) {
    assert.equal(
      fsyncDirectoryDescriptor(17, () => {
        throw codedError(code);
      }, "win32"),
      false,
      code,
    );
    assert.throws(
      () => fsyncDirectoryDescriptor(17, () => {
        throw codedError(code);
      }, "linux"),
      (error) => error.code === code,
      `${code} remains fatal outside Windows`,
    );
  }
  for (const error of [codedError("EIO"), new Error("uncoded")]) {
    assert.throws(
      () => fsyncDirectoryDescriptor(17, () => {
        throw error;
      }, "win32"),
      (thrown) => thrown === error,
    );
  }
});
