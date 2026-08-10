import { createServer, type Server, type Socket } from "node:net";

import { encodeNiFrame, NiFrameDecoder } from "../../src/protocol/ni.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_CASE_TIMEOUT_MS = 2_000;
export const MAX_CASE_STEPS = 256;
const MAX_DELAY_MS = 5_000;
export const MAX_DUPLICATE_COPIES = 16;
export const MAX_SCRIPTED_WIRE_BYTES = 8 * 1024 * 1024;
export const MAX_SCRIPTED_CHUNKS = 128 * 1024;

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

export function validateMilliseconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new RangeError(`${field} must be an integer in 0..${MAX_DELAY_MS}`);
  }
}

export function validateTimeoutMilliseconds(
  value: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DELAY_MS) {
    throw new RangeError(`${field} must be an integer in 1..${MAX_DELAY_MS}`);
  }
}

export function validateUInt32(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${field} must be an integer in 0..4294967295`);
  }
}

function copyBoundedBytes(value: Uint8Array, field: string): Buffer {
  if (value.byteLength > MAX_SCRIPTED_WIRE_BYTES) {
    throw new RangeError(
      `${field} exceeds the ${MAX_SCRIPTED_WIRE_BYTES}-byte scripted-wire limit`,
    );
  }
  return Buffer.from(value);
}

export async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  validateTimeoutMilliseconds(timeoutMs, "timeoutMs");

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${description} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function delay(milliseconds: number): Promise<void> {
  validateMilliseconds(milliseconds, "delay milliseconds");
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function writeBytes(
  socket: Socket,
  bytes: Uint8Array,
): Promise<void> {
  if (!socket.writable || socket.destroyed) {
    throw new Error("script attempted to write to a non-writable socket");
  }
  const copy = copyBoundedBytes(bytes, "write bytes");
  await new Promise<void>((resolve, reject) => {
    socket.write(copy, (error?: Error | null) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

export async function writeChunks(
  socket: Socket,
  chunks: readonly Buffer[],
): Promise<void> {
  for (const chunk of chunks) {
    await writeBytes(socket, chunk);
    await nextTurn();
  }
}

export async function halfClose(socket: Socket): Promise<void> {
  if (socket.destroyed || !socket.writable) return;
  await new Promise<void>((resolve, reject) => {
    socket.end((error?: Error | null) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

export async function gracefulEof(
  socket: Socket,
  timeoutMs: number,
): Promise<void> {
  if (socket.destroyed) return;
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  await halfClose(socket);
  if (!socket.destroyed) socket.destroy();
  await bounded(closed, timeoutMs, "graceful EOF");
}

export function reset(socket: Socket): void {
  if (socket.destroyed) return;
  socket.resetAndDestroy();
}

export function uint32Header(value: number): Buffer {
  validateUInt32(value, "declared length");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(value, 0);
  return header;
}

export type NiWireUnit =
  | { readonly kind: "frame"; readonly payload: Buffer }
  | { readonly kind: "raw"; readonly bytes: Buffer };

export const niWire = {
  frame(payload: Uint8Array): NiWireUnit {
    return {
      kind: "frame",
      payload: copyBoundedBytes(payload, "frame payload"),
    };
  },

  raw(bytes: Uint8Array): NiWireUnit {
    return { kind: "raw", bytes: copyBoundedBytes(bytes, "raw bytes") };
  },

  malformedLength(
    declaredLength: number,
    trailingBytes: Uint8Array = new Uint8Array(0),
  ): NiWireUnit {
    return {
      kind: "raw",
      bytes: Buffer.concat([
        uint32Header(declaredLength),
        copyBoundedBytes(trailingBytes, "malformed-length trailing bytes"),
      ]),
    };
  },

  truncatedFrame(
    declaredLength: number,
    payloadPrefix: Uint8Array,
  ): NiWireUnit {
    validateUInt32(declaredLength, "declared length");
    const prefix = copyBoundedBytes(payloadPrefix, "truncated payload prefix");
    if (prefix.byteLength >= declaredLength) {
      throw new RangeError(
        "a truncated NI frame prefix must be shorter than its declared length",
      );
    }
    return {
      kind: "raw",
      bytes: Buffer.concat([uint32Header(declaredLength), prefix]),
    };
  },
} as const;

function wireBytes(unit: NiWireUnit): Buffer {
  const bytes =
    unit.kind === "frame"
      ? encodeNiFrame(unit.payload)
      : Buffer.from(unit.bytes);
  if (bytes.byteLength > MAX_SCRIPTED_WIRE_BYTES) {
    throw new RangeError("wire unit exceeds the scripted-wire byte limit");
  }
  return bytes;
}

export function splitExactly(
  bytes: Buffer,
  chunkSizes: readonly number[],
): Buffer[] {
  if (chunkSizes.length === 0) {
    throw new RangeError("split chunkSizes must not be empty");
  }
  if (chunkSizes.length > MAX_SCRIPTED_CHUNKS) {
    throw new RangeError(
      `split chunkSizes cannot exceed ${MAX_SCRIPTED_CHUNKS} entries`,
    );
  }
  let offset = 0;
  const chunks = chunkSizes.map((size, index) => {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new RangeError(
        `split chunkSizes[${index}] must be a positive integer`,
      );
    }
    const end = offset + size;
    if (end > bytes.byteLength) {
      throw new RangeError("split chunkSizes exceed the wire unit length");
    }
    const chunk = bytes.subarray(offset, end);
    offset = end;
    return chunk;
  });
  if (offset !== bytes.byteLength) {
    throw new RangeError(
      `split chunkSizes cover ${offset} of ${bytes.byteLength} wire bytes`,
    );
  }
  return chunks;
}

export function fixedSizeChunks(
  bytes: Buffer,
  maximumChunkBytes: number,
): Buffer[] {
  if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes <= 0) {
    throw new RangeError("maximumChunkBytes must be a positive integer");
  }
  const chunkCount = Math.ceil(bytes.byteLength / maximumChunkBytes);
  if (chunkCount > MAX_SCRIPTED_CHUNKS) {
    throw new RangeError(
      `short-write delivery cannot exceed ${MAX_SCRIPTED_CHUNKS} chunks`,
    );
  }
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximumChunkBytes) {
    chunks.push(bytes.subarray(offset, offset + maximumChunkBytes));
  }
  return chunks;
}

export type ScriptedNiPeerStep =
  | {
      readonly kind: "expect-frame";
      readonly payload?: Buffer;
      readonly timeoutMs?: number;
    }
  | { readonly kind: "write"; readonly unit: NiWireUnit }
  | {
      readonly kind: "split";
      readonly unit: NiWireUnit;
      readonly chunkSizes: readonly number[];
    }
  | {
      readonly kind: "short-write";
      readonly unit: NiWireUnit;
      readonly maximumChunkBytes: number;
    }
  | { readonly kind: "coalesce"; readonly units: readonly NiWireUnit[] }
  | {
      readonly kind: "duplicate";
      readonly unit: NiWireUnit;
      readonly copies: number;
    }
  | { readonly kind: "delay"; readonly milliseconds: number }
  | { readonly kind: "half-close" }
  | { readonly kind: "reset" }
  | { readonly kind: "eof" };

export const niPeerStep = {
  expectFrame(payload?: Uint8Array, timeoutMs?: number): ScriptedNiPeerStep {
    return {
      kind: "expect-frame",
      payload: payload === undefined ? undefined : Buffer.from(payload),
      timeoutMs,
    };
  },

  write(unit: NiWireUnit): ScriptedNiPeerStep {
    return { kind: "write", unit };
  },

  split(unit: NiWireUnit, chunkSizes: readonly number[]): ScriptedNiPeerStep {
    return { kind: "split", unit, chunkSizes: [...chunkSizes] };
  },

  shortWrite(unit: NiWireUnit, maximumChunkBytes: number): ScriptedNiPeerStep {
    return { kind: "short-write", unit, maximumChunkBytes };
  },

  coalesce(...units: readonly NiWireUnit[]): ScriptedNiPeerStep {
    return { kind: "coalesce", units: [...units] };
  },

  duplicate(unit: NiWireUnit, copies = 2): ScriptedNiPeerStep {
    return { kind: "duplicate", unit, copies };
  },

  delay(milliseconds: number): ScriptedNiPeerStep {
    return { kind: "delay", milliseconds };
  },

  halfClose(): ScriptedNiPeerStep {
    return { kind: "half-close" };
  },

  reset(): ScriptedNiPeerStep {
    return { kind: "reset" };
  },

  eof(): ScriptedNiPeerStep {
    return { kind: "eof" };
  },
} as const;

export interface ScriptedNiPeerCase {
  readonly name: string;
  readonly steps: readonly ScriptedNiPeerStep[];
  readonly timeoutMs?: number;
}

export function defineNiPeerCases(
  ...cases: readonly ScriptedNiPeerCase[]
): readonly ScriptedNiPeerCase[] {
  const names = new Set<string>();
  for (const definition of cases) {
    validateCaseName(definition.name);
    if (names.has(definition.name)) {
      throw new Error(`duplicate scripted NI case: ${definition.name}`);
    }
    names.add(definition.name);
    validatePeerCase(definition);
  }
  return Object.freeze([...cases]);
}

export function validateCaseName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new RangeError(
      "scripted NI case name must match ^[a-z][a-z0-9-]{0,63}$",
    );
  }
}

function validatePeerCase(definition: ScriptedNiPeerCase): void {
  if (definition.steps.length > MAX_CASE_STEPS) {
    throw new RangeError(
      `scripted NI case cannot exceed ${MAX_CASE_STEPS} steps`,
    );
  }
  validateTimeoutMilliseconds(
    definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
    "case timeoutMs",
  );
  for (const [index, step] of definition.steps.entries()) {
    validatePeerStep(step, `steps[${index}]`);
  }
}

function validatePeerStep(step: ScriptedNiPeerStep, field: string): void {
  switch (step.kind) {
    case "expect-frame":
      if (step.payload !== undefined)
        copyBoundedBytes(step.payload, `${field}.payload`);
      validateTimeoutMilliseconds(
        step.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
        `${field}.timeoutMs`,
      );
      return;
    case "write":
      wireBytes(step.unit);
      return;
    case "split":
      splitExactly(wireBytes(step.unit), step.chunkSizes);
      return;
    case "short-write":
      fixedSizeChunks(wireBytes(step.unit), step.maximumChunkBytes);
      return;
    case "coalesce": {
      if (step.units.length === 0) {
        throw new RangeError(`${field}.units must not be empty`);
      }
      if (step.units.length > MAX_CASE_STEPS) {
        throw new RangeError(
          `${field}.units cannot exceed ${MAX_CASE_STEPS} entries`,
        );
      }
      const byteLength = step.units.reduce(
        (sum, unit) => sum + wireBytes(unit).byteLength,
        0,
      );
      if (byteLength > MAX_SCRIPTED_WIRE_BYTES) {
        throw new RangeError(`${field} exceeds the scripted-wire byte limit`);
      }
      return;
    }
    case "duplicate":
      if (
        !Number.isSafeInteger(step.copies) ||
        step.copies < 2 ||
        step.copies > MAX_DUPLICATE_COPIES
      ) {
        throw new RangeError(
          `${field}.copies must be an integer in 2..${MAX_DUPLICATE_COPIES}`,
        );
      }
      if (
        wireBytes(step.unit).byteLength * step.copies >
        MAX_SCRIPTED_WIRE_BYTES
      ) {
        throw new RangeError(`${field} exceeds the scripted-wire byte limit`);
      }
      return;
    case "delay":
      validateMilliseconds(step.milliseconds, `${field}.milliseconds`);
      return;
    case "half-close":
    case "reset":
    case "eof":
      return;
  }
}

export function selectCase<T extends { readonly name: string }>(
  cases: readonly T[],
  name: string,
): T {
  const selected = cases.find((definition) => definition.name === name);
  if (selected === undefined) {
    throw new Error(`unknown scripted NI case: ${name}`);
  }
  return selected;
}

export class NiFrameInbox {
  readonly #socket: Socket;
  readonly #decoder = new NiFrameDecoder(MAX_SCRIPTED_WIRE_BYTES);
  readonly #frames: Buffer[] = [];
  #pending: Deferred<Buffer> | undefined;
  #terminalError: Error | undefined;

  readonly #onData = (chunk: Buffer): void => {
    if (this.#terminalError !== undefined) return;
    try {
      for (const frame of this.#decoder.push(chunk)) {
        if (this.#pending === undefined) this.#frames.push(frame);
        else {
          const pending = this.#pending;
          this.#pending = undefined;
          pending.resolve(frame);
        }
      }
    } catch (error) {
      this.#terminate(
        new Error("scripted NI inbox rejected invalid input", { cause: error }),
      );
    }
  };

  readonly #onEnd = (): void => {
    try {
      this.#decoder.finish();
      this.#terminate(
        new Error("socket reached EOF before the scripted frame arrived"),
      );
    } catch (error) {
      this.#terminate(
        new Error("socket reached EOF with a truncated NI frame", {
          cause: error,
        }),
      );
    }
  };

  readonly #onError = (error: Error): void => {
    this.#terminate(
      new Error("socket failed before the scripted frame arrived", {
        cause: error,
      }),
    );
  };

  readonly #onClose = (): void => {
    this.#terminate(
      new Error("socket closed before the scripted frame arrived"),
    );
  };

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", this.#onData);
    socket.on("end", this.#onEnd);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
  }

  async receive(timeoutMs: number): Promise<Buffer> {
    if (this.#frames.length > 0) return this.#frames.shift()!;
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#pending !== undefined) {
      throw new Error("only one scripted NI inbox receive may be pending");
    }
    const pending = deferred<Buffer>();
    this.#pending = pending;
    try {
      return await bounded(
        pending.promise,
        timeoutMs,
        "scripted NI frame receive",
      );
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }

  dispose(): void {
    this.#socket.removeListener("data", this.#onData);
    this.#socket.removeListener("end", this.#onEnd);
    this.#socket.removeListener("error", this.#onError);
    this.#socket.removeListener("close", this.#onClose);
    this.#terminate(new Error("scripted NI inbox was disposed"));
  }

  #terminate(error: Error): void {
    this.#terminalError ??= error;
    if (this.#pending !== undefined) {
      const pending = this.#pending;
      this.#pending = undefined;
      pending.reject(this.#terminalError);
    }
  }
}

async function runPeerCase(
  socket: Socket,
  definition: ScriptedNiPeerCase,
  observedFrames: Buffer[],
): Promise<void> {
  const inbox = new NiFrameInbox(socket);
  try {
    for (const step of definition.steps) {
      switch (step.kind) {
        case "expect-frame": {
          const frame = await inbox.receive(
            step.timeoutMs ?? definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
          );
          observedFrames.push(Buffer.from(frame));
          if (step.payload !== undefined && !frame.equals(step.payload)) {
            throw new Error(
              `scripted NI frame mismatch: expected ${step.payload.byteLength} bytes, received ${frame.byteLength}`,
            );
          }
          break;
        }
        case "write":
          await writeBytes(socket, wireBytes(step.unit));
          break;
        case "split":
          await writeChunks(
            socket,
            splitExactly(wireBytes(step.unit), step.chunkSizes),
          );
          break;
        case "short-write":
          await writeChunks(
            socket,
            fixedSizeChunks(wireBytes(step.unit), step.maximumChunkBytes),
          );
          break;
        case "coalesce":
          await writeBytes(socket, Buffer.concat(step.units.map(wireBytes)));
          break;
        case "duplicate": {
          const bytes = wireBytes(step.unit);
          await writeChunks(
            socket,
            Array.from({ length: step.copies }, () => bytes),
          );
          break;
        }
        case "delay":
          await delay(step.milliseconds);
          break;
        case "half-close":
          await halfClose(socket);
          break;
        case "reset":
          reset(socket);
          return;
        case "eof":
          await gracefulEof(
            socket,
            definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
          );
          return;
      }
    }
  } finally {
    inbox.dispose();
  }
}

export async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_HOST);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("scripted NI server did not bind a TCP address");
  }
  return address.port;
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Runs one named, bounded byte-stream script against one loopback connection.
 * `half-close` keeps the peer's readable side available; `eof` also waits for
 * the connection to finish; `reset` sends an abortive close.
 */
export class ScriptedNiPeer {
  readonly host = LOOPBACK_HOST;
  readonly port: number;
  readonly selectedCase: string;
  readonly #server: Server;
  readonly #completion: Deferred<void>;
  readonly #sockets: Set<Socket>;
  readonly #observedFrames: Buffer[];

  private constructor(
    server: Server,
    port: number,
    selectedCase: string,
    completion: Deferred<void>,
    sockets: Set<Socket>,
    observedFrames: Buffer[],
  ) {
    this.#server = server;
    this.port = port;
    this.selectedCase = selectedCase;
    this.#completion = completion;
    this.#sockets = sockets;
    this.#observedFrames = observedFrames;
  }

  static async start(
    cases: readonly ScriptedNiPeerCase[],
    selectedCase: string,
  ): Promise<ScriptedNiPeer> {
    const definition = selectCase(defineNiPeerCases(...cases), selectedCase);
    const completion = deferred<void>();
    const sockets = new Set<Socket>();
    const observedFrames: Buffer[] = [];
    let accepted = false;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      if (accepted) {
        reset(socket);
        return;
      }
      accepted = true;
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
      void runPeerCase(socket, definition, observedFrames).then(
        () => completion.resolve(),
        (error) => {
          reset(socket);
          completion.reject(error);
        },
      );
    });
    server.once("error", (error) => completion.reject(error));
    const port = await listenLoopback(server);
    return new ScriptedNiPeer(
      server,
      port,
      selectedCase,
      completion,
      sockets,
      observedFrames,
    );
  }

  get observedFrames(): readonly Buffer[] {
    return this.#observedFrames.map((frame) => Buffer.from(frame));
  }

  async done(timeoutMs = DEFAULT_CASE_TIMEOUT_MS): Promise<void> {
    try {
      await bounded(
        this.#completion.promise,
        timeoutMs,
        `scripted NI case ${this.selectedCase}`,
      );
    } catch (error) {
      for (const socket of this.#sockets) reset(socket);
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await closeServer(this.#server);
  }
}
