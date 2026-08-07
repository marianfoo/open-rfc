import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createBoundedRolloverDiagnosticSink,
  RfcDiagnosticDispatcher,
  type RfcDiagnosticEvent,
} from "../src/diagnostics/structured-diagnostics.js";

test("structured diagnostics reject payload-like, accessor, mismatched, and unbounded input", () => {
  const dispatcher = new RfcDiagnosticDispatcher({
    sink: { write() {} },
  });
  const base = {
    category: "call",
    level: "info",
    code: "call.started",
  } as const;
  assert.throws(
    () => dispatcher.emit({ ...base, message: "secret" } as never),
    /message is not allowed/u,
  );
  assert.throws(
    () => dispatcher.emit({ ...base, code: "network.connect" } as never),
    /must belong to its category/u,
  );
  assert.throws(
    () => dispatcher.emit({ ...base, correlationId: "contains whitespace" }),
    /safe identifier/u,
  );
  assert.throws(
    () => dispatcher.emit({ ...base, durationMs: Number.POSITIVE_INFINITY }),
    /bounded non-negative/u,
  );
  const accessor = { ...base } as Record<string, unknown>;
  Object.defineProperty(accessor, "state", { enumerable: true, get: () => "open" });
  assert.throws(() => dispatcher.emit(accessor as never), /own data property/u);
});

test("dispatcher filters per category, queues asynchronously, and exposes immutable counters", async () => {
  const events: RfcDiagnosticEvent[] = [];
  const dispatcher = new RfcDiagnosticDispatcher({
    sink: {
      write(event) {
        events.push(event);
      },
    },
    level: "warn",
    levels: { metadata: "debug" },
  });
  assert.equal(
    dispatcher.emit({ category: "call", level: "info", code: "call.started" }),
    false,
  );
  assert.equal(
    dispatcher.emit({
      category: "metadata",
      level: "debug",
      code: "metadata.cache-hit",
      count: 1,
    }),
    true,
  );
  assert.deepEqual(events, [], "sink must not run inline");
  await dispatcher.flush();
  assert.equal(events.length, 1);
  const event = events[0] as RfcDiagnosticEvent | undefined;
  assert.ok(event);
  assert.deepEqual(
    { ...event, timestamp: undefined },
    {
      schemaVersion: 1,
      sequence: 1,
      timestamp: undefined,
      category: "metadata",
      level: "debug",
      code: "metadata.cache-hit",
      count: 1,
    },
  );
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(Object.isFrozen(event), true);
  const monitor = dispatcher.monitor();
  assert.equal(Object.isFrozen(monitor), true);
  assert.equal(Object.isFrozen(monitor.droppedByCategory), true);
  assert.deepEqual(
    { accepted: monitor.accepted, delivered: monitor.delivered, filtered: monitor.filtered },
    { accepted: 1, delivered: 1, filtered: 1 },
  );
});

test("bounded queue drops deterministically and sink failures cannot affect callers", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => {
    release = resolveBlocked;
  });
  let writes = 0;
  const dispatcher = new RfcDiagnosticDispatcher({
    sink: {
      async write() {
        writes += 1;
        if (writes === 1) await blocked;
        else throw new Error("observer failure");
      },
    },
    level: "trace",
    maxQueued: 2,
  });
  assert.equal(dispatcher.emit({ category: "pool", level: "info", code: "pool.wait" }), true);
  await new Promise<void>((resolveTurn) => queueMicrotask(resolveTurn));
  assert.equal(dispatcher.emit({ category: "pool", level: "info", code: "pool.wait" }), true);
  assert.equal(dispatcher.emit({ category: "pool", level: "info", code: "pool.wait" }), true);
  assert.equal(dispatcher.emit({ category: "pool", level: "info", code: "pool.wait" }), false);
  release();
  await dispatcher.flush();
  const monitor = dispatcher.monitor();
  assert.deepEqual(
    {
      accepted: monitor.accepted,
      delivered: monitor.delivered,
      dropped: monitor.dropped,
      poolDropped: monitor.droppedByCategory.pool,
      sinkFailures: monitor.sinkFailures,
    },
    { accepted: 3, delivered: 1, dropped: 1, poolDropped: 1, sinkFailures: 2 },
  );
  await dispatcher.close();
  assert.throws(
    () => dispatcher.emit({ category: "pool", level: "info", code: "pool.wait" }),
    /closed/u,
  );
});

test("rollover sink initializes before use, stays owner-only, and keeps a bounded JSONL set", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "open-rfc-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "connector.jsonl");
  const sink = await createBoundedRolloverDiagnosticSink({
    path,
    maxBytes: 2_048,
    maxFiles: 2,
  });
  const dispatcher = new RfcDiagnosticDispatcher({
    sink,
    level: "trace",
    maxQueued: 64,
  });
  if (process.platform !== "win32") {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  }
  for (let count = 0; count < 40; count += 1) {
    dispatcher.emit({
      category: "performance",
      level: "debug",
      code: "performance.sample",
      durationMs: count,
      count,
    });
  }
  await dispatcher.close();
  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, ["connector.jsonl", "connector.jsonl.1"]);
  for (const file of files) {
    const filePath = resolve(directory, file);
    if (process.platform !== "win32") {
      assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
    }
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length > 0, true);
    for (const line of lines) {
      const event = JSON.parse(line) as RfcDiagnosticEvent;
      assert.equal(event.schemaVersion, 1);
      assert.equal(event.category, "performance");
      assert.equal("message" in event, false);
    }
  }
});

test("dispatcher validates configuration, levels, and the complete event vocabulary", async () => {
  for (const options of [null, [], "bad"]) {
    assert.throws(
      () => new RfcDiagnosticDispatcher(options as never),
      /options must be an object/u,
    );
  }
  const optionAccessor = { sink: { write() {} } } as Record<string, unknown>;
  Object.defineProperty(optionAccessor, "level", { get: () => "info" });
  assert.throws(
    () => new RfcDiagnosticDispatcher(optionAccessor as never),
    /level must be an own data property/u,
  );
  assert.throws(
    () => new RfcDiagnosticDispatcher({
      sink: { write() {} },
      unexpected: true,
    } as never),
    /unsupported option/u,
  );
  for (const sink of [null, {}, { write: 1 }, { write() {}, close: 1 }]) {
    assert.throws(
      () => new RfcDiagnosticDispatcher({ sink: sink as never }),
      /sink must expose write/u,
    );
  }
  for (const maxQueued of [Number.NaN, 0, 65_537]) {
    assert.throws(
      () => new RfcDiagnosticDispatcher({ sink: { write() {} }, maxQueued }),
      /maxQueued must be an integer/u,
    );
  }
  assert.throws(
    () => new RfcDiagnosticDispatcher({
      sink: { write() {} },
      level: "verbose" as never,
    }),
    /diagnostic level is not a supported value/u,
  );

  let closeCalls = 0;
  const events: RfcDiagnosticEvent[] = [];
  const dispatcher = new RfcDiagnosticDispatcher({
    sink: {
      write(event) { events.push(event); },
      async close() {
        closeCalls += 1;
        throw new Error("observer close failed");
      },
    },
    level: "trace",
  });
  await dispatcher.flush();
  for (const levels of [null, [], "bad"]) {
    assert.throws(() => dispatcher.setLevels(levels as never), /levels must be an object/u);
  }
  assert.throws(
    () => dispatcher.setLevels({ unknown: "info" } as never),
    /level category is not a supported value/u,
  );
  const levelAccessor = {};
  Object.defineProperty(levelAccessor, "call", { get: () => "info" });
  assert.throws(
    () => dispatcher.setLevels(levelAccessor as never),
    /must be an own data property/u,
  );
  assert.throws(
    () => dispatcher.setLevel("unknown" as never, "info"),
    /category is not a supported value/u,
  );
  assert.throws(
    () => dispatcher.setLevel("call", "verbose" as never),
    /level is not a supported value/u,
  );

  const base = { category: "call", level: "info", code: "call.started" } as const;
  for (const input of [null, [], new Date()]) {
    assert.throws(() => dispatcher.emit(input as never), /plain object/u);
  }
  const symbolInput = { ...base } as Record<PropertyKey, unknown>;
  symbolInput[Symbol("hidden")] = "secret";
  assert.throws(() => dispatcher.emit(symbolInput as never), /symbol keys/u);
  for (const [patch, pattern] of [
    [{ category: "unknown" }, /category is not a supported value/u],
    [{ level: "verbose" }, /level is not a supported value/u],
    [{ code: "call.unknown" }, /code is not a supported value/u],
    [{ correlationId: 7 }, /safe identifier/u],
    [{ correlationId: "x".repeat(129) }, /safe identifier/u],
    [{ state: "unknown" }, /state is not a supported value/u],
    [{ phase: "unknown" }, /phase is not a supported value/u],
    [{ disposition: "unknown" }, /disposition is not a supported value/u],
    [{ durationMs: -1 }, /bounded non-negative number/u],
    [{ durationMs: 86_400_001 }, /bounded non-negative number/u],
    [{ count: 1.5 }, /bounded non-negative integer/u],
    [{ count: Number.MAX_SAFE_INTEGER + 1 }, /bounded non-negative integer/u],
  ] as const) {
    assert.throws(() => dispatcher.emit({ ...base, ...patch } as never), pattern);
  }
  assert.equal(dispatcher.emit({
    ...base,
    correlationId: "01234567-89ab-4cde-8fab-0123456789ab",
    state: "open",
    phase: "receive",
    disposition: "reusable",
    durationMs: 1.5,
    count: 2,
  }), true);
  await dispatcher.flush();
  assert.deepEqual(
    {
      correlationId: events[0]!.correlationId,
      state: events[0]!.state,
      phase: events[0]!.phase,
      disposition: events[0]!.disposition,
      durationMs: events[0]!.durationMs,
      count: events[0]!.count,
    },
    {
      correlationId: "01234567-89ab-4cde-8fab-0123456789ab",
      state: "open",
      phase: "receive",
      disposition: "reusable",
      durationMs: 1.5,
      count: 2,
    },
  );
  const firstClose = dispatcher.close();
  const secondClose = dispatcher.close();
  assert.equal(secondClose, firstClose);
  await Promise.all([firstClose, secondClose]);
  assert.equal(closeCalls, 1);
  assert.equal(dispatcher.monitor().sinkFailures, 1);
  assert.throws(() => dispatcher.setLevel("call", "info"), /closed/u);
});

test("file sink rejects unsafe destinations and covers single-file rollover", async (t) => {
  for (const options of [null, [], "bad"]) {
    await assert.rejects(
      createBoundedRolloverDiagnosticSink(options as never),
      /file options must be an object/u,
    );
  }
  for (const path of ["", "bad\0path", 7, "/"]) {
    await assert.rejects(
      createBoundedRolloverDiagnosticSink({ path: path as never }),
      /file path/u,
    );
  }
  for (const maxBytes of [Number.NaN, 2_047, 1_073_741_825]) {
    await assert.rejects(
      createBoundedRolloverDiagnosticSink({ path: "unused.jsonl", maxBytes }),
      /maxBytes must be an integer/u,
    );
  }
  for (const maxFiles of [Number.NaN, 0, 11]) {
    await assert.rejects(
      createBoundedRolloverDiagnosticSink({ path: "unused.jsonl", maxFiles }),
      /maxFiles must be an integer/u,
    );
  }

  const directory = await mkdtemp(resolve(tmpdir(), "open-rfc-diagnostics-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const directoryPath = resolve(directory, "not-a-file");
  await mkdir(directoryPath);
  await assert.rejects(
    createBoundedRolloverDiagnosticSink({ path: directoryPath }),
    /regular non-symlink file/u,
  );
  const target = resolve(directory, "target.jsonl");
  const link = resolve(directory, "link.jsonl");
  const targetSink = await createBoundedRolloverDiagnosticSink({ path: target });
  await targetSink.close!();
  await symlink(target, link);
  await assert.rejects(
    createBoundedRolloverDiagnosticSink({ path: link }),
    /regular non-symlink file/u,
  );

  const path = resolve(directory, "single.jsonl");
  const sink = await createBoundedRolloverDiagnosticSink({
    path,
    maxBytes: 2_048,
    maxFiles: 1,
  });
  const event = { schemaVersion: 1, padding: "x".repeat(1_500) } as never;
  await sink.write(event);
  await sink.write(event);
  await assert.rejects(
    async () => sink.write({ padding: "x".repeat(2_048) } as never),
    /fixed byte bound/u,
  );
  await sink.close!();
  await sink.close!();
  await assert.rejects(async () => sink.write(event), /sink is closed/u);
  assert.deepEqual(await readdir(directory).then((files) =>
    files.filter((file) => file.startsWith("single"))), ["single.jsonl"]);

  const threePath = resolve(directory, "three.jsonl");
  const three = await createBoundedRolloverDiagnosticSink({
    path: threePath,
    maxBytes: 2_048,
    maxFiles: 3,
  });
  await three.write(event);
  await three.write(event);
  await three.close!();
  assert.deepEqual(
    (await readdir(directory)).filter((file) => file.startsWith("three")).sort(),
    ["three.jsonl", "three.jsonl.1"],
  );
});
