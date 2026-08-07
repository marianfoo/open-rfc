import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("protocol benchmark rejects an excessive aggregate work budget", () => {
  const result = spawnSync(process.execPath, ["tools/protocol_benchmark.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPEN_RFC_BENCH_ITERATIONS: "1000000",
      OPEN_RFC_BENCH_PAYLOAD_BYTES: "1048576",
    },
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /benchmark work budget .* exceeds/);
});
