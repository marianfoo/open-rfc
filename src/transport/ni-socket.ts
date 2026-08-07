import { createConnection } from "node:net";

import {
  DEFAULT_MAX_NI_PAYLOAD_LENGTH,
  NiFrameDecoder,
  encodeNiFrame,
} from "../protocol/ni.js";

export type NiTransportErrorCode =
  | "NI_ABORTED"
  | "NI_CONNECT_FAILED"
  | "NI_CONNECT_TIMEOUT"
  | "NI_CONNECTION_CLOSED"
  | "NI_PROTOCOL_ERROR"
  | "NI_RECEIVE_TIMEOUT"
  | "NI_WRITE_TIMEOUT"
  | "NI_WRITE_FAILED";

export const DEFAULT_MAX_NI_QUEUED_PAYLOAD_LENGTH = 64 * 1024 * 1024;
export const DEFAULT_MAX_NI_QUEUED_FRAME_COUNT = 1_024;
export const DEFAULT_NI_WRITE_TIMEOUT_MS = 30_000;
export const DEFAULT_NI_CLOSE_TIMEOUT_MS = 5_000;

export class NiTransportError extends Error {
  readonly code: NiTransportErrorCode;
  override readonly cause: unknown;

  constructor(code: NiTransportErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "NiTransportError";
    this.code = code;
    this.cause = cause;
  }
}

export interface NiSocketConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly connectTimeoutMs?: number;
  readonly maxPayloadLength?: number;
  /** Aggregate complete payload bytes retained before receive() drains them. */
  readonly maxQueuedPayloadLength?: number;
  /** Complete NI frames retained before receive() drains them. */
  readonly maxQueuedFrameCount?: number;
  readonly writeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly noDelay?: boolean;
  readonly family?: 4 | 6;
}

/**
 * Connected, paused byte stream which can transfer exclusive ownership to an
 * NI transport. The structural surface keeps routed sockets testable without
 * exposing Node's much larger Socket API to the protocol layer.
 */
export interface NiConnectedSocket {
  readonly destroyed?: boolean;
  readonly closed?: boolean;
  readonly readableEnded?: boolean;
  readonly writableEnded?: boolean;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly localAddress?: string;
  readonly localPort?: number;
  isPaused(): boolean;
  pause(): unknown;
  resume(): unknown;
  destroy(error?: Error): unknown;
  end(): unknown;
  write(
    chunk: Uint8Array,
    callback: (error?: Error | null) => void,
  ): boolean;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

export interface NiSocketAdoptOptions {
  /** Ownership transfers to NiSocketTransport when adopt() is called. */
  readonly socket: NiConnectedSocket;
  /** Bytes coalesced after a preceding handshake and before socket.pause(). */
  readonly initialData?: Uint8Array;
  readonly maxPayloadLength?: number;
  readonly maxQueuedPayloadLength?: number;
  readonly maxQueuedFrameCount?: number;
  readonly writeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export interface NiReceiveOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type NiTimerHandle = number | object;

/**
 * Experimental timer seam for deterministic timeout/cancellation tests on the
 * remove-before-1.0 low-level transport. Callbacks may run synchronously or
 * later; clearTimeout should release any retained callback state.
 */
export interface NiTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): NiTimerHandle;
  clearTimeout(handle: NiTimerHandle): void;
}

const systemTimerScheduler: NiTimerScheduler = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number): NodeJS.Timeout =>
    setTimeout(callback, delayMs),
  clearTimeout: (handle: NiTimerHandle): void =>
    clearTimeout(handle as NodeJS.Timeout),
});

interface PendingReceive {
  readonly resolve: (payload: Buffer) => void;
  readonly reject: (error: Error) => void;
  timer: NiTimerHandle | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

type NiSocketState = "open" | "closing" | "closed";

function boundedMilliseconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff) {
    throw new RangeError(`${field} must be an integer in 0..2147483647`);
  }
}

function validateConnectOptions(options: NiSocketConnectOptions): void {
  if (typeof options.host !== "string" || options.host.length === 0) {
    throw new RangeError("host must not be empty");
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 0xffff
  ) {
    throw new RangeError("port must be an integer in 1..65535");
  }
  boundedMilliseconds(options.connectTimeoutMs ?? 10_000, "connectTimeoutMs");
  if (
    options.family !== undefined &&
    options.family !== 4 &&
    options.family !== 6
  ) {
    throw new RangeError("family must be 4 or 6");
  }
  const maxPayloadLength =
    options.maxPayloadLength ?? DEFAULT_MAX_NI_PAYLOAD_LENGTH;
  if (!Number.isSafeInteger(maxPayloadLength) || maxPayloadLength < 0) {
    throw new RangeError(
      "maxPayloadLength must be a non-negative safe integer",
    );
  }
  validateQueueLimits(
    options.maxQueuedPayloadLength ??
      Math.min(maxPayloadLength, DEFAULT_MAX_NI_QUEUED_PAYLOAD_LENGTH),
    options.maxQueuedFrameCount ?? DEFAULT_MAX_NI_QUEUED_FRAME_COUNT,
  );
  boundedMilliseconds(
    options.writeTimeoutMs ?? DEFAULT_NI_WRITE_TIMEOUT_MS,
    "writeTimeoutMs",
  );
  boundedMilliseconds(
    options.closeTimeoutMs ?? DEFAULT_NI_CLOSE_TIMEOUT_MS,
    "closeTimeoutMs",
  );
}

function validateMaxPayloadLength(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "maxPayloadLength must be a non-negative safe integer",
    );
  }
}

function validateQueueLimits(
  maxQueuedPayloadLength: number,
  maxQueuedFrameCount: number,
): void {
  if (
    !Number.isSafeInteger(maxQueuedPayloadLength) ||
    maxQueuedPayloadLength < 0
  ) {
    throw new RangeError(
      "maxQueuedPayloadLength must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(maxQueuedFrameCount) || maxQueuedFrameCount < 1) {
    throw new RangeError(
      "maxQueuedFrameCount must be a positive safe integer",
    );
  }
}

function validateConnectedSocket(socket: NiConnectedSocket): void {
  if (typeof socket !== "object" || socket === null) {
    throw new TypeError("socket must be a connected paused byte stream");
  }
  for (const method of [
    "isPaused",
    "pause",
    "resume",
    "destroy",
    "end",
    "write",
    "on",
    "once",
  ] as const) {
    if (typeof socket[method] !== "function") {
      throw new TypeError("socket must be a connected paused byte stream");
    }
  }
}

function aborted(message: string, cause?: unknown): NiTransportError {
  return new NiTransportError("NI_ABORTED", message, cause);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  // Listener installation can run caller-provided stream code; avoid carrying
  // an earlier narrowing across that ownership boundary.
  return signal?.aborted === true;
}

function socketTerminal(socket: NiConnectedSocket): boolean {
  return socket.destroyed === true ||
    socket.closed === true ||
    socket.readableEnded === true ||
    socket.writableEnded === true;
}

/**
 * A single TCP connection carrying bounded NI length-prefixed records.
 * Receive timeout/abort is deliberately fatal: a late RFC response must never
 * be mistaken for the response to a later call on the same connection.
 */
export class NiSocketTransport {
  readonly #socket: NiConnectedSocket;
  readonly #decoder: NiFrameDecoder;
  readonly #scheduler: NiTimerScheduler;
  readonly #maxQueuedPayloadLength: number;
  readonly #maxQueuedFrameCount: number;
  readonly #writeTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #frames: Buffer[] = [];
  #queuedPayloadLength = 0;
  #pausedForQueue = false;
  #state: NiSocketState = "open";
  #pendingReceive: PendingReceive | undefined;
  #terminalError: NiTransportError | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    socket: NiConnectedSocket,
    maxPayloadLength: number,
    scheduler: NiTimerScheduler,
    maxQueuedPayloadLength: number,
    maxQueuedFrameCount: number,
    writeTimeoutMs: number,
    closeTimeoutMs: number,
  ) {
    this.#socket = socket;
    this.#decoder = new NiFrameDecoder(maxPayloadLength);
    this.#scheduler = scheduler;
    this.#maxQueuedPayloadLength = maxQueuedPayloadLength;
    this.#maxQueuedFrameCount = maxQueuedFrameCount;
    this.#writeTimeoutMs = writeTimeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("end", () => this.#onEnd());
    socket.on("error", (error: Error) => {
      this.#fail(
        new NiTransportError("NI_CONNECTION_CLOSED", "NI socket failed", error),
      );
    });
    socket.on("close", () => this.#onClose());
  }

  static async connect(
    options: NiSocketConnectOptions,
    signal?: AbortSignal,
    scheduler: NiTimerScheduler = systemTimerScheduler,
  ): Promise<NiSocketTransport> {
    validateConnectOptions(options);
    if (
      typeof scheduler.setTimeout !== "function" ||
      typeof scheduler.clearTimeout !== "function"
    ) {
      throw new TypeError("scheduler must provide setTimeout and clearTimeout");
    }
    if (signalAborted(signal)) {
      throw aborted(
        "NI connection was aborted before it started",
        signal?.reason,
      );
    }

    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    const socket = createConnection({
      host: options.host,
      port: options.port,
      family: options.family,
    });
    socket.setNoDelay(options.noDelay ?? true);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NiTimerHandle | undefined;
      const clearTimer = (handle: NiTimerHandle): void => {
        try {
          scheduler.clearTimeout(handle);
        } catch {
          // Timer cleanup must never prevent connection settlement.
        }
      };
      const settle = (error?: NiTransportError): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        if (error === undefined) resolve();
        else {
          socket.destroy();
          reject(error);
        }
      };
      const onConnect = (): void => settle();
      const onError = (error: Error): void =>
        settle(
          new NiTransportError(
            "NI_CONNECT_FAILED",
            `failed to connect NI socket to ${options.host}:${options.port}`,
            error,
          ),
        );
      const onAbort = (): void =>
        settle(aborted("NI connection was aborted", signal?.reason));
      socket.once("connect", onConnect);
      socket.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      if (connectTimeoutMs !== 0 && !settled) {
        try {
          const handle = scheduler.setTimeout(
            () =>
              settle(
                new NiTransportError(
                  "NI_CONNECT_TIMEOUT",
                  `NI connection to ${options.host}:${options.port} timed out after ${connectTimeoutMs} ms`,
                ),
              ),
            connectTimeoutMs,
          );
          timer = handle;
          if (settled) {
            clearTimer(handle);
            timer = undefined;
          }
        } catch (cause) {
          settle(
            new NiTransportError(
              "NI_CONNECT_FAILED",
              "NI connect timer scheduler failed",
              cause,
            ),
          );
        }
      }
    });

    return new NiSocketTransport(
      socket,
      options.maxPayloadLength ?? DEFAULT_MAX_NI_PAYLOAD_LENGTH,
      scheduler,
      options.maxQueuedPayloadLength ?? Math.min(
        options.maxPayloadLength ?? DEFAULT_MAX_NI_PAYLOAD_LENGTH,
        DEFAULT_MAX_NI_QUEUED_PAYLOAD_LENGTH,
      ),
      options.maxQueuedFrameCount ?? DEFAULT_MAX_NI_QUEUED_FRAME_COUNT,
      options.writeTimeoutMs ?? DEFAULT_NI_WRITE_TIMEOUT_MS,
      options.closeTimeoutMs ?? DEFAULT_NI_CLOSE_TIMEOUT_MS,
    );
  }

  /**
   * Adopt one already-connected, paused stream after an outer route handshake.
   * Listeners and coalesced bytes are installed before resume(), so target NI
   * frames cannot be lost between protocol owners.
   */
  static adopt(
    options: NiSocketAdoptOptions,
    signal?: AbortSignal,
    scheduler: NiTimerScheduler = systemTimerScheduler,
  ): NiSocketTransport {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("NI socket adoption options must be an object");
    }
    if (
      typeof scheduler.setTimeout !== "function" ||
      typeof scheduler.clearTimeout !== "function"
    ) {
      throw new TypeError("scheduler must provide setTimeout and clearTimeout");
    }
    const socket = options.socket;
    validateConnectedSocket(socket);
    let initialData: Uint8Array | undefined;
    let maxPayloadLength: number;
    let maxQueuedPayloadLength: number;
    let maxQueuedFrameCount: number;
    let writeTimeoutMs: number;
    let closeTimeoutMs: number;
    try {
      initialData = options.initialData;
      if (
        initialData !== undefined &&
        !(initialData instanceof Uint8Array)
      ) {
        throw new TypeError("initialData must be a Uint8Array");
      }
      maxPayloadLength =
        options.maxPayloadLength ?? DEFAULT_MAX_NI_PAYLOAD_LENGTH;
      validateMaxPayloadLength(maxPayloadLength);
      maxQueuedPayloadLength = options.maxQueuedPayloadLength ??
        Math.min(maxPayloadLength, DEFAULT_MAX_NI_QUEUED_PAYLOAD_LENGTH);
      maxQueuedFrameCount =
        options.maxQueuedFrameCount ?? DEFAULT_MAX_NI_QUEUED_FRAME_COUNT;
      validateQueueLimits(maxQueuedPayloadLength, maxQueuedFrameCount);
      writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_NI_WRITE_TIMEOUT_MS;
      closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_NI_CLOSE_TIMEOUT_MS;
      boundedMilliseconds(writeTimeoutMs, "writeTimeoutMs");
      boundedMilliseconds(closeTimeoutMs, "closeTimeoutMs");
    } catch (error) {
      try { socket.destroy(); } catch { /* ownership cleanup is best effort */ }
      throw error;
    }
    if (socketTerminal(socket)) {
      try { socket.destroy(); } catch { /* ownership cleanup is best effort */ }
      throw new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "cannot adopt a terminal NI socket",
      );
    }
    let paused: boolean;
    try {
      paused = socket.isPaused();
    } catch (cause) {
      try { socket.destroy(); } catch { /* ownership cleanup is best effort */ }
      throw new NiTransportError(
        "NI_PROTOCOL_ERROR",
        "adopted NI socket pause state could not be inspected",
        cause,
      );
    }
    if (!paused) {
      socket.destroy();
      throw new NiTransportError(
        "NI_PROTOCOL_ERROR",
        "an adopted NI socket must be paused before listener handoff",
      );
    }
    if (signalAborted(signal)) {
      socket.destroy();
      throw aborted(
        "NI socket adoption was aborted before listener handoff",
        signal?.reason,
      );
    }

    let transport: NiSocketTransport;
    try {
      transport = new NiSocketTransport(
        socket,
        maxPayloadLength,
        scheduler,
        maxQueuedPayloadLength,
        maxQueuedFrameCount,
        writeTimeoutMs,
        closeTimeoutMs,
      );
    } catch (cause) {
      try { socket.destroy(); } catch { /* ownership cleanup is best effort */ }
      throw new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "adopted NI socket rejected lifecycle listeners",
        cause,
      );
    }
    if (socketTerminal(socket)) {
      const error = new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "adopted NI socket became terminal during listener handoff",
      );
      transport.#fail(error);
      throw error;
    }
    if (initialData !== undefined && initialData.byteLength > 0) {
      transport.#onData(Buffer.from(initialData));
    }
    if (transport.#state !== "open") {
      throw (
        transport.#terminalError ??
        new NiTransportError(
          "NI_CONNECTION_CLOSED",
          "adopted NI socket failed during listener handoff",
        )
      );
    }
    if (signalAborted(signal)) {
      const error = aborted(
        "NI socket adoption was aborted during listener handoff",
        signal?.reason,
      );
      transport.#fail(error);
      throw error;
    }
    try {
      if (!transport.#pausedForQueue) socket.resume();
    } catch (cause) {
      const error = new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "adopted NI socket could not be resumed",
        cause,
      );
      transport.#fail(error);
      throw error;
    }
    if (signalAborted(signal)) {
      const error = aborted(
        "NI socket adoption was aborted while resuming the stream",
        signal?.reason,
      );
      transport.#fail(error);
      throw transport.#terminalError ?? error;
    }
    if (transport.#state !== "open" || socketTerminal(socket)) {
      const error = transport.#terminalError ?? new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "adopted NI socket became terminal while resuming the stream",
      );
      transport.#fail(error);
      throw error;
    }
    return transport;
  }

  get state(): NiSocketState {
    return this.#state;
  }

  get remoteAddress(): string | undefined {
    return this.#socket.remoteAddress;
  }

  get localAddress(): string | undefined {
    return this.#socket.localAddress;
  }

  get localPort(): number | undefined {
    return this.#socket.localPort;
  }

  get remotePort(): number | undefined {
    return this.#socket.remotePort;
  }

  /**
   * Fail a synchronous request/response owner closed when a complete inbound
   * frame is still buffered at a request boundary. Sending another request in
   * that state would let the stale frame become the following response.
   */
  assertNoQueuedFrames(): void {
    if (this.#state !== "open") {
      throw (
        this.#terminalError ??
        new NiTransportError(
          "NI_CONNECTION_CLOSED",
          "cannot inspect a closed NI socket",
        )
      );
    }
    if (this.#frames.length === 0) return;
    const error = new NiTransportError(
      "NI_PROTOCOL_ERROR",
      "unexpected queued NI frame at a request boundary",
    );
    this.#fail(error);
    throw error;
  }

  async send(payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.#state !== "open") {
      throw (
        this.#terminalError ??
        new NiTransportError(
          "NI_CONNECTION_CLOSED",
          "cannot write to a closed NI socket",
        )
      );
    }
    if (signal?.aborted === true) {
      const error = aborted(
        "NI write was aborted before it started",
        signal.reason,
      );
      this.#fail(error);
      throw error;
    }
    const frame = encodeNiFrame(payload);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: NiTimerHandle | undefined;
        const settle = (error?: NiTransportError): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) this.#clearTimer(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error === undefined) resolve();
          else {
            this.#fail(error);
            reject(error);
          }
        };
        const onAbort = (): void =>
          settle(aborted("NI write was aborted", signal?.reason));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
        if (this.#writeTimeoutMs !== 0 && !settled) {
          try {
            const handle = this.#scheduler.setTimeout(
              () => settle(new NiTransportError(
                "NI_WRITE_TIMEOUT",
                `NI write timed out after ${this.#writeTimeoutMs} ms`,
              )),
              this.#writeTimeoutMs,
            );
            timer = handle;
            if (settled) {
              this.#clearTimer(handle);
              timer = undefined;
            }
          } catch (cause) {
            settle(
              new NiTransportError(
                "NI_WRITE_FAILED",
                "NI write timer scheduler failed",
                cause,
              ),
            );
          }
        }
        if (!settled) {
          try {
            this.#socket.write(frame, (error?: Error | null) => {
              if (error === undefined || error === null) settle();
              else {
                settle(
                  new NiTransportError(
                    "NI_WRITE_FAILED",
                    "failed to write NI frame",
                    error,
                  ),
                );
              }
            });
          } catch (cause) {
            settle(new NiTransportError(
              "NI_WRITE_FAILED",
              "failed to write NI frame",
              cause,
            ));
          }
        }
      });
    } finally {
      frame.fill(0);
    }
  }

  async receive(options: NiReceiveOptions = {}): Promise<Buffer> {
    const timeoutMs = options.timeoutMs ?? 0;
    boundedMilliseconds(timeoutMs, "timeoutMs");
    if (this.#state !== "open") {
      throw (
        this.#terminalError ??
        new NiTransportError(
          "NI_CONNECTION_CLOSED",
          "cannot read from a closed NI socket",
        )
      );
    }
    if (options.signal?.aborted === true) {
      const error = aborted(
        "NI receive was aborted before it started",
        options.signal.reason,
      );
      this.#fail(error);
      throw error;
    }
    if (this.#frames.length > 0) {
      const frame = this.#frames.shift()!;
      this.#queuedPayloadLength -= frame.byteLength;
      if (this.#frames.length === 0) this.#resumeAfterQueue();
      return frame;
    }
    if (this.#pendingReceive !== undefined) {
      throw new Error("only one NI receive may be pending on a connection");
    }
    return new Promise<Buffer>((resolve, reject) => {
      const onAbort =
        options.signal === undefined
          ? undefined
          : (): void =>
              this.#fail(
                aborted("NI receive was aborted", options.signal?.reason),
              );
      const pending: PendingReceive = {
        resolve,
        reject,
        timer: undefined,
        signal: options.signal,
        onAbort,
      };
      this.#pendingReceive = pending;
      options.signal?.addEventListener("abort", onAbort!, { once: true });
      if (options.signal?.aborted === true) onAbort?.();
      if (timeoutMs !== 0 && this.#pendingReceive === pending) {
        try {
          const handle = this.#scheduler.setTimeout(
            () =>
              this.#fail(
                new NiTransportError(
                  "NI_RECEIVE_TIMEOUT",
                  `NI receive timed out after ${timeoutMs} ms`,
                ),
              ),
            timeoutMs,
          );
          if (this.#pendingReceive === pending) pending.timer = handle;
          else this.#clearTimer(handle);
        } catch (cause) {
          this.#fail(
            new NiTransportError(
              "NI_CONNECTION_CLOSED",
              "NI receive timer scheduler failed",
              cause,
            ),
          );
        }
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.#rejectPending(
      new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "NI socket was closed locally",
      ),
    );
    this.#clearQueuedFrames();
    this.#decoder.reset();
    this.#closePromise = new Promise<void>((resolve) => {
      let settled = false;
      let timer: NiTimerHandle | undefined;
      const settle = (destroy: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#clearTimer(timer);
        if (destroy) {
          try { this.#socket.destroy(); } catch { /* bounded close still settles */ }
        }
        this.#state = "closed";
        resolve();
      };
      this.#socket.once("close", () => settle(false));
      if (this.#closeTimeoutMs !== 0) {
        try {
          const handle = this.#scheduler.setTimeout(
            () => settle(true),
            this.#closeTimeoutMs,
          );
          timer = handle;
          if (settled) {
            this.#clearTimer(handle);
            timer = undefined;
          }
        } catch {
          settle(true);
        }
      }
      if (!settled) {
        try { this.#socket.end(); } catch { settle(true); }
      }
    });
    return this.#closePromise;
  }

  #onData(chunk: Buffer): void {
    if (this.#state !== "open") return;
    try {
      const frames = this.#decoder.push(chunk);
      this.#preflightDecodedFrames(frames);
      const queuedFrameCount = frames.length -
        (this.#pendingReceive === undefined || frames.length === 0 ? 0 : 1);
      if (queuedFrameCount > 0) this.#pauseForQueue();
      for (const frame of frames) {
        if (this.#pendingReceive === undefined) this.#queueFrame(frame);
        else {
          const pending = this.#takePending();
          pending?.resolve(frame);
        }
      }
    } catch (error) {
      this.#fail(
        new NiTransportError("NI_PROTOCOL_ERROR", "invalid NI stream", error),
      );
    }
  }

  #preflightDecodedFrames(frames: readonly Buffer[]): void {
    const consumedByPending =
      this.#pendingReceive === undefined || frames.length === 0 ? 0 : 1;
    const additionalCount = frames.length - consumedByPending;
    let additionalBytes = 0n;
    for (let index = consumedByPending; index < frames.length; index += 1) {
      additionalBytes += BigInt(frames[index]!.byteLength);
    }
    if (
      this.#frames.length + additionalCount > this.#maxQueuedFrameCount ||
      BigInt(this.#queuedPayloadLength) + additionalBytes >
        BigInt(this.#maxQueuedPayloadLength)
    ) {
      for (const frame of frames) frame.fill(0);
      throw new RangeError(
        "NI complete-frame queue exceeds its configured resource limit",
      );
    }
  }

  #onEnd(): void {
    if (this.#state !== "open") return;
    try {
      this.#decoder.finish();
      this.#fail(
        new NiTransportError(
          "NI_CONNECTION_CLOSED",
          "NI peer ended the connection",
        ),
      );
    } catch (error) {
      this.#fail(
        new NiTransportError(
          "NI_PROTOCOL_ERROR",
          "NI peer ended a truncated frame",
          error,
        ),
      );
    }
  }

  #onClose(): void {
    if (this.#state === "closing") {
      this.#state = "closed";
      return;
    }
    if (this.#state === "open") {
      this.#fail(
        new NiTransportError(
          "NI_CONNECTION_CLOSED",
          "NI socket closed unexpectedly",
        ),
      );
    }
  }

  #takePending(): PendingReceive | undefined {
    const pending = this.#pendingReceive;
    this.#pendingReceive = undefined;
    if (pending?.timer !== undefined) this.#clearTimer(pending.timer);
    if (pending?.onAbort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  #queueFrame(frame: Buffer): void {
    const queuedPayloadLength = this.#queuedPayloadLength + frame.byteLength;
    if (
      this.#frames.length >= this.#maxQueuedFrameCount ||
      queuedPayloadLength > this.#maxQueuedPayloadLength
    ) {
      frame.fill(0);
      throw new RangeError(
        "NI complete-frame queue exceeds its configured resource limit",
      );
    }
    this.#frames.push(frame);
    this.#queuedPayloadLength = queuedPayloadLength;
  }

  #pauseForQueue(): void {
    if (this.#pausedForQueue) return;
    this.#socket.pause();
    this.#pausedForQueue = true;
  }

  #resumeAfterQueue(): void {
    if (!this.#pausedForQueue || this.#state !== "open") return;
    this.#pausedForQueue = false;
    try {
      this.#socket.resume();
    } catch (cause) {
      const error = new NiTransportError(
        "NI_CONNECTION_CLOSED",
        "NI socket could not resume after queued frames were drained",
        cause,
      );
      this.#fail(error);
      throw error;
    }
  }

  #clearQueuedFrames(): void {
    for (const frame of this.#frames) frame.fill(0);
    this.#frames.length = 0;
    this.#queuedPayloadLength = 0;
  }

  #clearTimer(handle: NiTimerHandle): void {
    try {
      this.#scheduler.clearTimeout(handle);
    } catch {
      // Timer cleanup must never prevent settlement or socket destruction.
    }
  }

  #rejectPending(error: Error): void {
    this.#takePending()?.reject(error);
  }

  #fail(error: NiTransportError): void {
    if (this.#state === "closed") return;
    this.#terminalError ??= error;
    this.#state = "closed";
    this.#rejectPending(this.#terminalError);
    this.#clearQueuedFrames();
    this.#decoder.reset();
    try { this.#socket.destroy(); } catch { /* terminal state is already fixed */ }
  }
}
