import { constants } from "node:fs";
import {
  lstat,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const RFC_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "call",
  "metadata",
  "network",
  "lifecycle",
  "pool",
  "locking",
  "performance",
] as const);
export type RfcDiagnosticCategory = (typeof RFC_DIAGNOSTIC_CATEGORIES)[number];

export const RFC_DIAGNOSTIC_LEVELS = Object.freeze([
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const);
export type RfcDiagnosticLevel = (typeof RFC_DIAGNOSTIC_LEVELS)[number];

export const RFC_DIAGNOSTIC_CODES = Object.freeze([
  "call.started",
  "call.succeeded",
  "call.failed",
  "call.canceled",
  "call.timed-out",
  "metadata.lookup",
  "metadata.cache-hit",
  "metadata.cache-miss",
  "metadata.invalidated",
  "metadata.failed",
  "network.connect",
  "network.opened",
  "network.closed",
  "network.failed",
  "network.timed-out",
  "lifecycle.opened",
  "lifecycle.reset",
  "lifecycle.replaced",
  "lifecycle.closed",
  "lifecycle.failed",
  "pool.acquire",
  "pool.release",
  "pool.wait",
  "pool.timed-out",
  "pool.rejected",
  "pool.retired",
  "pool.shutdown",
  "pool.closed",
  "pool.failed",
  "locking.wait",
  "locking.acquired",
  "locking.released",
  "locking.contention",
  "performance.sample",
  "performance.budget-exceeded",
] as const);
export type RfcDiagnosticCode = (typeof RFC_DIAGNOSTIC_CODES)[number];

export const RFC_DIAGNOSTIC_STATES = Object.freeze([
  "connecting",
  "open",
  "closing",
  "closed",
  "retired",
  "waiting",
  "leased",
  "idle",
  "failed",
] as const);
export type RfcDiagnosticState = (typeof RFC_DIAGNOSTIC_STATES)[number];

export const RFC_DIAGNOSTIC_PHASES = Object.freeze([
  "connect",
  "logon",
  "metadata",
  "encode",
  "send",
  "receive",
  "decode",
  "reset",
  "cancel",
  "close",
  "acquire",
  "release",
] as const);
export type RfcDiagnosticPhase = (typeof RFC_DIAGNOSTIC_PHASES)[number];

export const RFC_DIAGNOSTIC_DISPOSITIONS = Object.freeze([
  "reusable",
  "close",
  "unknownClose",
  "replace",
] as const);
export type RfcDiagnosticDisposition =
  (typeof RFC_DIAGNOSTIC_DISPOSITIONS)[number];

export interface RfcDiagnosticInput {
  readonly category: RfcDiagnosticCategory;
  readonly level: RfcDiagnosticLevel;
  readonly code: RfcDiagnosticCode;
  readonly correlationId?: string;
  readonly state?: RfcDiagnosticState;
  readonly phase?: RfcDiagnosticPhase;
  readonly disposition?: RfcDiagnosticDisposition;
  readonly durationMs?: number;
  readonly count?: number;
}

export interface RfcDiagnosticEvent extends RfcDiagnosticInput {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface RfcDiagnosticSink {
  readonly write: (event: RfcDiagnosticEvent) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
}

/**
 * Runtime-facing boundary implemented by {@link RfcDiagnosticDispatcher}.
 * Connector state machines bind this interface through a fixed-size deferred
 * queue; arbitrary emitter code is never entered inline with their state
 * transitions.
 */
export interface RfcDiagnosticEmitter {
  readonly emit: (input: RfcDiagnosticInput) => boolean;
}

export const RFC_RUNTIME_DIAGNOSTIC_BUFFER_LIMIT = 256;

export type RfcDiagnosticReporter = (input: RfcDiagnosticInput) => boolean;

export function snapshotRfcDiagnosticEmitter(
  emitter: RfcDiagnosticEmitter,
  path = "runtime diagnostics",
): RfcDiagnosticEmitter {
  if (
    (typeof emitter !== "object" && typeof emitter !== "function") ||
    emitter === null
  ) {
    throw new TypeError(`${path} must expose emit()`);
  }
  const emit = emitter.emit;
  if (typeof emit !== "function") {
    throw new TypeError(`${path} must expose emit()`);
  }
  return Object.freeze({
    emit: (input: RfcDiagnosticInput) =>
      Reflect.apply(emit, emitter, [input]) as boolean,
  });
}

export type RfcDiagnosticLevels = Readonly<
  Partial<Record<RfcDiagnosticCategory, RfcDiagnosticLevel>>
>;

export interface RfcDiagnosticDispatcherOptions {
  readonly sink: RfcDiagnosticSink;
  readonly level?: RfcDiagnosticLevel;
  readonly levels?: RfcDiagnosticLevels;
  readonly maxQueued?: number;
}

export interface RfcDiagnosticMonitor {
  readonly closed: boolean;
  readonly maxQueued: number;
  readonly queued: number;
  readonly accepted: number;
  readonly delivered: number;
  readonly filtered: number;
  readonly dropped: number;
  readonly sinkFailures: number;
  readonly droppedByCategory: Readonly<Record<RfcDiagnosticCategory, number>>;
}

const CATEGORY_SET = new Set<string>(RFC_DIAGNOSTIC_CATEGORIES);
const LEVEL_SET = new Set<string>(RFC_DIAGNOSTIC_LEVELS);
const CODE_SET = new Set<string>(RFC_DIAGNOSTIC_CODES);
const STATE_SET = new Set<string>(RFC_DIAGNOSTIC_STATES);
const PHASE_SET = new Set<string>(RFC_DIAGNOSTIC_PHASES);
const DISPOSITION_SET = new Set<string>(RFC_DIAGNOSTIC_DISPOSITIONS);
const LEVEL_INDEX = new Map(
  RFC_DIAGNOSTIC_LEVELS.map((level, index) => [level, index]),
);
const INPUT_KEYS = new Set([
  "category",
  "level",
  "code",
  "correlationId",
  "state",
  "phase",
  "disposition",
  "durationMs",
  "count",
]);
const SAFE_CORRELATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAX_DURATION_MS = 86_400_000;
const MAX_QUEUE = 65_536;
const MAX_EVENT_BYTES = 2_048;

function plainDataRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol keys`);
    }
    if (!INPUT_KEYS.has(key)) throw new TypeError(`${path}.${key} is not allowed`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
  }
  return value as Record<string, unknown>;
}

function member<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  path: string,
): T {
  if (typeof value !== "string" || !values.has(value)) {
    throw new TypeError(`${path} is not a supported value`);
  }
  return value as T;
}

function optionalMember<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  path: string,
): T | undefined {
  return value === undefined ? undefined : member<T>(value, values, path);
}

function optionalBoundedNumber(
  value: unknown,
  path: string,
  maximum: number,
  integer: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new RangeError(`${path} must be a bounded non-negative ${integer ? "integer" : "number"}`);
  }
  return value;
}

function snapshotInput(input: RfcDiagnosticInput): RfcDiagnosticInput {
  const value = plainDataRecord(input, "diagnostic event");
  const category = member<RfcDiagnosticCategory>(
    value.category,
    CATEGORY_SET,
    "diagnostic event.category",
  );
  const level = member<RfcDiagnosticLevel>(
    value.level,
    LEVEL_SET,
    "diagnostic event.level",
  );
  const code = member<RfcDiagnosticCode>(
    value.code,
    CODE_SET,
    "diagnostic event.code",
  );
  if (!code.startsWith(`${category}.`)) {
    throw new TypeError("diagnostic event.code must belong to its category");
  }
  const correlationId = value.correlationId;
  if (
    correlationId !== undefined &&
    (typeof correlationId !== "string" || !SAFE_CORRELATION_ID.test(correlationId))
  ) {
    throw new TypeError("diagnostic event.correlationId is not a safe identifier");
  }
  const result: RfcDiagnosticInput = {
    category,
    level,
    code,
  };
  const state = optionalMember<RfcDiagnosticState>(
    value.state,
    STATE_SET,
    "diagnostic event.state",
  );
  const phase = optionalMember<RfcDiagnosticPhase>(
    value.phase,
    PHASE_SET,
    "diagnostic event.phase",
  );
  const disposition = optionalMember<RfcDiagnosticDisposition>(
    value.disposition,
    DISPOSITION_SET,
    "diagnostic event.disposition",
  );
  const durationMs = optionalBoundedNumber(
    value.durationMs,
    "diagnostic event.durationMs",
    MAX_DURATION_MS,
    false,
  );
  const count = optionalBoundedNumber(
    value.count,
    "diagnostic event.count",
    Number.MAX_SAFE_INTEGER,
    true,
  );
  if (correlationId !== undefined) Object.assign(result, { correlationId });
  if (state !== undefined) Object.assign(result, { state });
  if (phase !== undefined) Object.assign(result, { phase });
  if (disposition !== undefined) Object.assign(result, { disposition });
  if (durationMs !== undefined) Object.assign(result, { durationMs });
  if (count !== undefined) Object.assign(result, { count });
  return Object.freeze(result);
}

/**
 * Bind an optional runtime emitter behind a fixed-size, later-microtask queue.
 * The queue deliberately has no close/flush ownership: the application owns
 * the supplied dispatcher, while each runtime owns only this bounded handoff.
 */
export function createDeferredRfcDiagnosticReporter(
  emitter: RfcDiagnosticEmitter | undefined,
): RfcDiagnosticReporter | undefined {
  if (emitter === undefined) return undefined;
  const bound = snapshotRfcDiagnosticEmitter(emitter);
  const emit = bound.emit;
  const queue: RfcDiagnosticInput[] = [];
  let scheduled = false;
  let draining = false;

  const schedule = (): void => {
    if (scheduled || draining) return;
    scheduled = true;
    try {
      queueMicrotask(() => {
        scheduled = false;
        draining = true;
        const batch = queue.splice(0, queue.length);
        try {
          for (const input of batch) {
            try {
              Reflect.apply(emit, bound, [input]);
            } catch {
              // Diagnostics are evidence only and cannot change runtime state.
            }
          }
        } finally {
          draining = false;
          if (queue.length > 0) schedule();
        }
      });
    } catch {
      scheduled = false;
      queue.length = 0;
    }
  };

  return (input): boolean => {
    if (queue.length >= RFC_RUNTIME_DIAGNOSTIC_BUFFER_LIMIT) return false;
    let snapshot: RfcDiagnosticInput;
    try {
      snapshot = snapshotInput(input);
    } catch {
      // An invalid observer event must not alter the authoritative operation.
      return false;
    }
    queue.push(snapshot);
    schedule();
    return scheduled || draining;
  };
}

function assertLevel(value: unknown, path: string): RfcDiagnosticLevel {
  return member<RfcDiagnosticLevel>(value, LEVEL_SET, path);
}

function exactOptionKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains an unsupported option`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
  }
}

function emptyCategoryCounts(): Record<RfcDiagnosticCategory, number> {
  return {
    call: 0,
    metadata: 0,
    network: 0,
    lifecycle: 0,
    pool: 0,
    locking: 0,
    performance: 0,
  };
}

/**
 * Bounded structured diagnostic dispatcher. Sink callbacks always run from a
 * later microtask and are serialized, so callers never perform observer or
 * file I/O inline with ownership/state transitions.
 */
export class RfcDiagnosticDispatcher {
  readonly #sink: RfcDiagnosticSink;
  readonly #maxQueued: number;
  readonly #levels = new Map<RfcDiagnosticCategory, RfcDiagnosticLevel>();
  readonly #queue: RfcDiagnosticEvent[] = [];
  readonly #flushWaiters = new Set<() => void>();
  readonly #droppedByCategory = emptyCategoryCounts();
  #sequence = 0;
  #scheduled = false;
  #draining = false;
  #closed = false;
  #closing?: Promise<void>;
  #accepted = 0;
  #delivered = 0;
  #filtered = 0;
  #dropped = 0;
  #sinkFailures = 0;

  constructor(options: RfcDiagnosticDispatcherOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("diagnostic dispatcher options must be an object");
    }
    exactOptionKeys(
      options,
      new Set(["sink", "level", "levels", "maxQueued"]),
      "diagnostic dispatcher options",
    );
    if (
      typeof options.sink !== "object" ||
      options.sink === null ||
      typeof options.sink.write !== "function" ||
      (options.sink.close !== undefined && typeof options.sink.close !== "function")
    ) {
      throw new TypeError("diagnostic sink must expose write() and optional close()");
    }
    this.#sink = options.sink;
    const maxQueued = options.maxQueued ?? 1_024;
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > MAX_QUEUE) {
      throw new RangeError(`diagnostic maxQueued must be an integer from 1 to ${MAX_QUEUE}`);
    }
    this.#maxQueued = maxQueued;
    const defaultLevel = assertLevel(options.level ?? "info", "diagnostic level");
    for (const category of RFC_DIAGNOSTIC_CATEGORIES) {
      this.#levels.set(category, defaultLevel);
    }
    if (options.levels !== undefined) this.setLevels(options.levels);
  }

  setLevel(category: RfcDiagnosticCategory, level: RfcDiagnosticLevel): void {
    if (this.#closed) throw new Error("diagnostic dispatcher is closed");
    this.#levels.set(
      member<RfcDiagnosticCategory>(category, CATEGORY_SET, "diagnostic category"),
      assertLevel(level, "diagnostic level"),
    );
  }

  setLevels(levels: RfcDiagnosticLevels): void {
    if (typeof levels !== "object" || levels === null || Array.isArray(levels)) {
      throw new TypeError("diagnostic levels must be an object");
    }
    for (const key of Reflect.ownKeys(levels)) {
      const category = member<RfcDiagnosticCategory>(
        key,
        CATEGORY_SET,
        "diagnostic level category",
      );
      const descriptor = Object.getOwnPropertyDescriptor(levels, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`diagnostic levels.${category} must be an own data property`);
      }
      this.setLevel(category, assertLevel(descriptor.value, `diagnostic levels.${category}`));
    }
  }

  emit(input: RfcDiagnosticInput): boolean {
    if (this.#closed) throw new Error("diagnostic dispatcher is closed");
    const snapshot = snapshotInput(input);
    const configured = this.#levels.get(snapshot.category);
    if (
      configured === undefined ||
      LEVEL_INDEX.get(snapshot.level)! > LEVEL_INDEX.get(configured)!
    ) {
      this.#filtered += 1;
      return false;
    }
    if (this.#queue.length >= this.#maxQueued) {
      this.#dropped += 1;
      this.#droppedByCategory[snapshot.category] += 1;
      return false;
    }
    const event = Object.freeze({
      schemaVersion: 1 as const,
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      ...snapshot,
    });
    this.#queue.push(event);
    this.#accepted += 1;
    this.#scheduleDrain();
    return true;
  }

  monitor(): RfcDiagnosticMonitor {
    return Object.freeze({
      closed: this.#closed,
      maxQueued: this.#maxQueued,
      queued: this.#queue.length,
      accepted: this.#accepted,
      delivered: this.#delivered,
      filtered: this.#filtered,
      dropped: this.#dropped,
      sinkFailures: this.#sinkFailures,
      droppedByCategory: Object.freeze({ ...this.#droppedByCategory }),
    });
  }

  async flush(): Promise<void> {
    if (!this.#scheduled && !this.#draining && this.#queue.length === 0) return;
    await new Promise<void>((resolveFlush) => this.#flushWaiters.add(resolveFlush));
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#closing = this.#finishClose();
    return this.#closing;
  }

  async #finishClose(): Promise<void> {
    await this.flush();
    if (this.#sink.close !== undefined) {
      try {
        await Reflect.apply(this.#sink.close, this.#sink, []);
      } catch {
        this.#sinkFailures += 1;
      }
    }
  }

  #scheduleDrain(): void {
    if (this.#scheduled || this.#draining) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift()!;
        try {
          await Reflect.apply(this.#sink.write, this.#sink, [event]);
          this.#delivered += 1;
        } catch {
          this.#sinkFailures += 1;
        }
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0) this.#scheduleDrain();
      else {
        for (const resolveFlush of this.#flushWaiters) resolveFlush();
        this.#flushWaiters.clear();
      }
    }
  }
}

export interface BoundedRolloverDiagnosticSinkOptions {
  readonly path: string;
  readonly maxBytes?: number;
  /** Total files including the active file. */
  readonly maxFiles?: number;
}

const FILE_OPTION_KEYS = new Set(["path", "maxBytes", "maxFiles"]);

async function openOwnerFile(path: string): Promise<FileHandle> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  const status = await handle.stat();
  if (!status.isFile()) {
    await handle.close();
    throw new Error("diagnostic destination must be a regular file");
  }
  await handle.chmod(0o600);
  return handle;
}

async function missingOrRegular(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error("diagnostic destination must be a regular non-symlink file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Creates an initialized, owner-readable JSON-lines sink. The directory must
 * already exist; connector code never chooses or creates a trace directory.
 */
export async function createBoundedRolloverDiagnosticSink(
  options: BoundedRolloverDiagnosticSinkOptions,
): Promise<RfcDiagnosticSink> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("diagnostic file options must be an object");
  }
  exactOptionKeys(options, FILE_OPTION_KEYS, "diagnostic file options");
  if (
    typeof options.path !== "string" ||
    options.path.length === 0 ||
    options.path.includes("\0")
  ) {
    throw new TypeError("diagnostic file path must be a non-empty path");
  }
  const path = resolve(options.path);
  if (basename(path).length === 0 || dirname(path) === path) {
    throw new TypeError("diagnostic file path must name a file");
  }
  const maxBytes = options.maxBytes ?? 1_048_576;
  const maxFiles = options.maxFiles ?? 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MAX_EVENT_BYTES || maxBytes > 1_073_741_824) {
    throw new RangeError("diagnostic maxBytes must be an integer from 2048 to 1073741824");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10) {
    throw new RangeError("diagnostic maxFiles must be an integer from 1 to 10");
  }
  await missingOrRegular(path);
  let handle = await openOwnerFile(path);
  let currentBytes = (await handle.stat()).size;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;

  async function rotate(): Promise<void> {
    await handle.close();
    if (maxFiles === 1) {
      await rm(path, { force: true });
    } else {
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const source = index === 1 ? path : `${path}.${index - 1}`;
        const target = `${path}.${index}`;
        await rm(target, { force: true });
        try {
          await rename(source, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    handle = await openOwnerFile(path);
    currentBytes = 0;
  }

  const sink: RfcDiagnosticSink = {
    write(event) {
      if (closed) return Promise.reject(new Error("diagnostic file sink is closed"));
      const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
      if (line.byteLength > MAX_EVENT_BYTES) {
        return Promise.reject(new RangeError("diagnostic event exceeds its fixed byte bound"));
      }
      const operation = tail.then(async () => {
        if (currentBytes > 0 && currentBytes + line.byteLength > maxBytes) {
          await rotate();
        }
        await handle.write(line);
        currentBytes += line.byteLength;
      });
      tail = operation.catch(() => {});
      return operation;
    },
    close() {
      if (closing !== undefined) return closing;
      closed = true;
      const operation = tail.then(() => handle.close());
      tail = operation.catch(() => {});
      closing = operation;
      return closing;
    },
  };
  return Object.freeze(sink);
}
