import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import { encodeNiFrame } from "../../src/protocol/ni.js";
import {
  bounded,
  closeServer,
  DEFAULT_CASE_TIMEOUT_MS,
  deferred,
  delay,
  fixedSizeChunks,
  gracefulEof,
  halfClose,
  listenLoopback,
  LOOPBACK_HOST,
  MAX_CASE_STEPS,
  MAX_DUPLICATE_COPIES,
  MAX_SCRIPTED_CHUNKS,
  MAX_SCRIPTED_WIRE_BYTES,
  NiFrameInbox,
  reset,
  selectCase,
  splitExactly,
  uint32Header,
  validateCaseName,
  validateMilliseconds,
  validateTimeoutMilliseconds,
  validateUInt32,
  writeBytes,
  writeChunks,
  type Deferred,
} from "./scripted-ni-peer.js";

export type NiProxySide = "client" | "upstream";

export type NiRelayDelivery =
  | { readonly kind: "whole" }
  | { readonly kind: "coalesce" }
  | { readonly kind: "split"; readonly chunkSizes: readonly number[] }
  | { readonly kind: "short-write"; readonly maximumChunkBytes: number }
  | { readonly kind: "duplicate"; readonly copies: number }
  | { readonly kind: "truncate"; readonly keepBytes: number }
  | { readonly kind: "malformed-length"; readonly declaredLength: number };

export type ScriptedNiProxyStep =
  | {
      readonly kind: "relay";
      readonly from: NiProxySide;
      readonly count?: number;
      readonly delivery?: NiRelayDelivery;
      readonly timeoutMs?: number;
    }
  | { readonly kind: "delay"; readonly milliseconds: number }
  | { readonly kind: "half-close"; readonly side: NiProxySide }
  | { readonly kind: "reset"; readonly side: NiProxySide }
  | { readonly kind: "eof"; readonly side: NiProxySide };

export const niProxyStep = {
  relay(
    from: NiProxySide,
    options: {
      readonly count?: number;
      readonly delivery?: NiRelayDelivery;
      readonly timeoutMs?: number;
    } = {},
  ): ScriptedNiProxyStep {
    return { kind: "relay", from, ...options };
  },

  delay(milliseconds: number): ScriptedNiProxyStep {
    return { kind: "delay", milliseconds };
  },

  halfClose(side: NiProxySide): ScriptedNiProxyStep {
    return { kind: "half-close", side };
  },

  reset(side: NiProxySide): ScriptedNiProxyStep {
    return { kind: "reset", side };
  },

  eof(side: NiProxySide): ScriptedNiProxyStep {
    return { kind: "eof", side };
  },
} as const;

export interface ScriptedNiProxyCase {
  readonly name: string;
  readonly steps: readonly ScriptedNiProxyStep[];
  readonly timeoutMs?: number;
}

export function defineNiProxyCases(
  ...cases: readonly ScriptedNiProxyCase[]
): readonly ScriptedNiProxyCase[] {
  const names = new Set<string>();
  for (const definition of cases) {
    validateCaseName(definition.name);
    if (names.has(definition.name)) {
      throw new Error(`duplicate scripted NI proxy case: ${definition.name}`);
    }
    names.add(definition.name);
    validateProxyCase(definition);
  }
  return Object.freeze([...cases]);
}

function validateProxyCase(definition: ScriptedNiProxyCase): void {
  if (definition.steps.length > MAX_CASE_STEPS) {
    throw new RangeError(
      `scripted NI proxy case cannot exceed ${MAX_CASE_STEPS} steps`,
    );
  }
  validateTimeoutMilliseconds(
    definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
    "proxy case timeoutMs",
  );
  for (const [index, step] of definition.steps.entries()) {
    const field = `steps[${index}]`;
    switch (step.kind) {
      case "relay": {
        const count = step.count ?? 1;
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > MAX_DUPLICATE_COPIES
        ) {
          throw new RangeError(
            `${field}.count must be an integer in 1..${MAX_DUPLICATE_COPIES}`,
          );
        }
        validateTimeoutMilliseconds(
          step.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
          `${field}.timeoutMs`,
        );
        validateRelayDelivery(step.delivery ?? { kind: "whole" }, count, field);
        break;
      }
      case "delay":
        validateMilliseconds(step.milliseconds, `${field}.milliseconds`);
        break;
      case "half-close":
      case "reset":
      case "eof":
        break;
    }
  }
}

function validateRelayDelivery(
  delivery: NiRelayDelivery,
  frameCount: number,
  field: string,
): void {
  switch (delivery.kind) {
    case "whole":
      return;
    case "coalesce":
      if (frameCount < 2) {
        throw new RangeError(
          `${field} coalesce delivery requires at least two frames`,
        );
      }
      return;
    case "split":
      if (frameCount !== 1) {
        throw new RangeError(
          `${field} split delivery requires exactly one frame`,
        );
      }
      for (const [index, size] of delivery.chunkSizes.entries()) {
        if (!Number.isSafeInteger(size) || size <= 0) {
          throw new RangeError(
            `${field}.delivery.chunkSizes[${index}] must be a positive integer`,
          );
        }
      }
      if (delivery.chunkSizes.length > MAX_SCRIPTED_CHUNKS) {
        throw new RangeError(
          `${field}.delivery.chunkSizes cannot exceed ${MAX_SCRIPTED_CHUNKS} entries`,
        );
      }
      return;
    case "short-write":
      if (frameCount !== 1) {
        throw new RangeError(
          `${field} short-write delivery requires exactly one frame`,
        );
      }
      if (
        !Number.isSafeInteger(delivery.maximumChunkBytes) ||
        delivery.maximumChunkBytes <= 0
      ) {
        throw new RangeError(
          `${field}.delivery.maximumChunkBytes must be a positive integer`,
        );
      }
      return;
    case "duplicate":
      if (frameCount !== 1) {
        throw new RangeError(
          `${field} duplicate delivery requires exactly one frame`,
        );
      }
      if (
        !Number.isSafeInteger(delivery.copies) ||
        delivery.copies < 2 ||
        delivery.copies > MAX_DUPLICATE_COPIES
      ) {
        throw new RangeError(
          `${field}.delivery.copies must be in 2..${MAX_DUPLICATE_COPIES}`,
        );
      }
      return;
    case "truncate":
      if (frameCount !== 1) {
        throw new RangeError(
          `${field} truncate delivery requires exactly one frame`,
        );
      }
      if (!Number.isSafeInteger(delivery.keepBytes) || delivery.keepBytes < 0) {
        throw new RangeError(
          `${field}.delivery.keepBytes must be non-negative`,
        );
      }
      return;
    case "malformed-length":
      if (frameCount !== 1) {
        throw new RangeError(
          `${field} malformed-length delivery requires exactly one frame`,
        );
      }
      validateUInt32(
        delivery.declaredLength,
        `${field}.delivery.declaredLength`,
      );
      return;
  }
}

async function connectLoopback(
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 0xffff) {
    throw new RangeError("upstream port must be an integer in 1..65535");
  }
  const socket = createConnection({
    host: LOOPBACK_HOST,
    port,
    allowHalfOpen: true,
  });
  const connection = deferred<void>();
  const onConnect = (): void => connection.resolve();
  const onError = (error: Error): void => connection.reject(error);
  socket.once("connect", onConnect);
  socket.once("error", onError);
  try {
    await bounded(
      connection.promise,
      timeoutMs,
      "scripted NI upstream connection",
    );
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    socket.removeListener("connect", onConnect);
    socket.removeListener("error", onError);
  }
}

function opposite(side: NiProxySide): NiProxySide {
  return side === "client" ? "upstream" : "client";
}

async function deliverRelay(
  socket: Socket,
  payloads: readonly Buffer[],
  delivery: NiRelayDelivery,
): Promise<void> {
  const frames = payloads.map((payload) => encodeNiFrame(payload));
  const wireByteLength = frames.reduce(
    (sum, frame) => sum + frame.byteLength,
    0,
  );
  if (wireByteLength > MAX_SCRIPTED_WIRE_BYTES) {
    throw new RangeError("relayed frames exceed the scripted-wire byte limit");
  }
  switch (delivery.kind) {
    case "whole":
      await writeChunks(socket, frames);
      return;
    case "coalesce":
      await writeBytes(socket, Buffer.concat(frames));
      return;
    case "split":
      await writeChunks(socket, splitExactly(frames[0]!, delivery.chunkSizes));
      return;
    case "short-write":
      await writeChunks(
        socket,
        fixedSizeChunks(frames[0]!, delivery.maximumChunkBytes),
      );
      return;
    case "duplicate":
      if (frames[0]!.byteLength * delivery.copies > MAX_SCRIPTED_WIRE_BYTES) {
        throw new RangeError(
          "duplicated relay exceeds the scripted-wire byte limit",
        );
      }
      await writeChunks(
        socket,
        Array.from({ length: delivery.copies }, () => frames[0]!),
      );
      return;
    case "truncate": {
      const frame = frames[0]!;
      if (delivery.keepBytes >= frame.byteLength) {
        throw new RangeError(
          `truncate delivery must keep fewer than ${frame.byteLength} wire bytes`,
        );
      }
      await writeBytes(socket, frame.subarray(0, delivery.keepBytes));
      return;
    }
    case "malformed-length": {
      const payload = payloads[0]!;
      await writeBytes(
        socket,
        Buffer.concat([uint32Header(delivery.declaredLength), payload]),
      );
      return;
    }
  }
}

async function runProxyCase(
  client: Socket,
  upstream: Socket,
  definition: ScriptedNiProxyCase,
): Promise<void> {
  const sockets: Record<NiProxySide, Socket> = { client, upstream };
  const inboxes: Record<NiProxySide, NiFrameInbox> = {
    client: new NiFrameInbox(client),
    upstream: new NiFrameInbox(upstream),
  };
  try {
    for (const step of definition.steps) {
      switch (step.kind) {
        case "relay": {
          const count = step.count ?? 1;
          const timeoutMs =
            step.timeoutMs ?? definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
          const payloads: Buffer[] = [];
          for (let index = 0; index < count; index += 1) {
            payloads.push(await inboxes[step.from].receive(timeoutMs));
          }
          await deliverRelay(
            sockets[opposite(step.from)],
            payloads,
            step.delivery ?? { kind: "whole" },
          );
          break;
        }
        case "delay":
          await delay(step.milliseconds);
          break;
        case "half-close":
          await halfClose(sockets[step.side]);
          break;
        case "reset":
          reset(sockets[step.side]);
          return;
        case "eof":
          await gracefulEof(
            sockets[step.side],
            definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
          );
          return;
      }
    }
  } finally {
    inboxes.client.dispose();
    inboxes.upstream.dispose();
  }
}

/**
 * Relays decoded NI frames through a selected fault script. Both the listener
 * and upstream are fixed to IPv4 loopback so destructive cases cannot escape
 * the synthetic test boundary.
 */
export class ScriptedNiProxy {
  readonly host = LOOPBACK_HOST;
  readonly port: number;
  readonly selectedCase: string;
  readonly #server: Server;
  readonly #completion: Deferred<void>;
  readonly #sockets: Set<Socket>;

  private constructor(
    server: Server,
    port: number,
    selectedCase: string,
    completion: Deferred<void>,
    sockets: Set<Socket>,
  ) {
    this.#server = server;
    this.port = port;
    this.selectedCase = selectedCase;
    this.#completion = completion;
    this.#sockets = sockets;
  }

  static async start(options: {
    readonly upstreamPort: number;
    readonly cases: readonly ScriptedNiProxyCase[];
    readonly selectedCase: string;
  }): Promise<ScriptedNiProxy> {
    const definition = selectCase(
      defineNiProxyCases(...options.cases),
      options.selectedCase,
    );
    const caseTimeoutMs = definition.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
    const completion = deferred<void>();
    const sockets = new Set<Socket>();
    let accepted = false;
    const server = createServer({ allowHalfOpen: true }, (client) => {
      if (accepted) {
        reset(client);
        return;
      }
      accepted = true;
      sockets.add(client);
      client.on("error", () => undefined);
      client.once("close", () => sockets.delete(client));
      void connectLoopback(options.upstreamPort, caseTimeoutMs)
        .then(async (upstream) => {
          sockets.add(upstream);
          upstream.on("error", () => undefined);
          upstream.once("close", () => sockets.delete(upstream));
          await runProxyCase(client, upstream, definition);
        })
        .then(
          () => completion.resolve(),
          (error) => {
            for (const socket of sockets) reset(socket);
            completion.reject(error);
          },
        );
    });
    server.once("error", (error) => completion.reject(error));
    const port = await listenLoopback(server);
    return new ScriptedNiProxy(
      server,
      port,
      options.selectedCase,
      completion,
      sockets,
    );
  }

  async done(timeoutMs = DEFAULT_CASE_TIMEOUT_MS): Promise<void> {
    try {
      await bounded(
        this.#completion.promise,
        timeoutMs,
        `scripted NI proxy case ${this.selectedCase}`,
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
