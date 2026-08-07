import { createConnection, isIP, type Socket } from "node:net";
import { inspect } from "node:util";

import { encodeNiFrame } from "../protocol/ni.js";
import {
  SAPROUTER_DEFAULT_NI_VERSION,
  SAPROUTER_MAX_RESPONSE_PAYLOAD_BYTES,
  admitSapRouterRoute,
  assertAdmittedSapRouterRoute,
  decodeSapRouterRouteResponse,
  encodeSapRouterRouteRequestPayload,
  type AdmittedSapRouterRoute,
  type SapRouterFirstHop,
} from "./saprouter-route.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 300_000;
const NO_TIMER = Symbol("no SAProuter timer");
const CUSTOM_INSPECT = inspect.custom;

export type SapRouterTransportErrorCode =
  | "SAPROUTER_ABORTED"
  | "SAPROUTER_CONNECT_FAILED"
  | "SAPROUTER_CONNECT_TIMEOUT"
  | "SAPROUTER_CONNECTION_CLOSED"
  | "SAPROUTER_HANDSHAKE_TIMEOUT"
  | "SAPROUTER_PROTOCOL_ERROR"
  | "SAPROUTER_ROUTE_DENIED"
  | "SAPROUTER_ROUTE_REJECTED"
  | "SAPROUTER_UNSUPPORTED_SERVICE"
  | "SAPROUTER_WRITE_FAILED";

/** Redaction-safe failure from first-hop connection or NI_ROUTE negotiation. */
export class SapRouterTransportError extends Error {
  readonly code: SapRouterTransportErrorCode;
  readonly routerReturnCode: number | undefined;
  override readonly cause: unknown;

  constructor(
    code: SapRouterTransportErrorCode,
    message: string,
    options: {
      readonly routerReturnCode?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "SapRouterTransportError";
    this.code = code;
    this.routerReturnCode = options.routerReturnCode;
    this.cause = options.cause;
    Object.defineProperty(this, "toJSON", {
      configurable: false,
      enumerable: false,
      value: (): Readonly<Record<string, unknown>> => Object.freeze({
        name: this.name,
        code: this.code,
        message: this.message,
        ...(this.routerReturnCode === undefined
          ? {}
          : { routerReturnCode: this.routerReturnCode }),
      }),
      writable: false,
    });
    Object.defineProperty(this, CUSTOM_INSPECT, {
      configurable: false,
      enumerable: false,
      value: (): Readonly<Record<string, unknown>> => Object.freeze({
        name: this.name,
        code: this.code,
        message: this.message,
        ...(this.routerReturnCode === undefined
          ? {}
          : { routerReturnCode: this.routerReturnCode }),
      }),
      writable: false,
    });
  }
}

/** Minimal unencoded stream surface shared by net.Socket and compatible TLS streams. */
export interface SapRouterRouteSocket {
  readonly destroyed?: boolean;
  write(
    chunk: Uint8Array,
    callback: (error?: Error | null) => void,
  ): boolean;
  pause(): unknown;
  destroy(): unknown;
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: unknown) => void): unknown;
  removeListener(event: "error", listener: (error: unknown) => void): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
}

export type SapRouterTimerHandle = unknown;

export interface SapRouterTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): SapRouterTimerHandle;
  clearTimeout(handle: SapRouterTimerHandle): void;
}

const SYSTEM_TIMER_SCHEDULER: SapRouterTimerScheduler = Object.freeze({
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle: SapRouterTimerHandle): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

export interface SapRouterHandshakeOptions {
  readonly timeoutMs?: number;
  readonly maxResponsePayloadBytes?: number;
  readonly niVersion?: number;
}

export interface SapRouterConnectOptions {
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maxResponsePayloadBytes?: number;
  readonly niVersion?: number;
  readonly family?: 4 | 6;
  readonly noDelay?: boolean;
}

interface NormalizedHandshakeOptions {
  readonly timeoutMs: number;
  readonly maxResponsePayloadBytes: number;
  readonly niVersion: number;
}

interface NormalizedConnectOptions extends NormalizedHandshakeOptions {
  readonly connectTimeoutMs: number;
  readonly family: 4 | 6 | undefined;
  readonly noDelay: boolean;
}

export interface SapRouterFirstHopConnectOptions {
  readonly timeoutMs: number;
  readonly family: 4 | 6 | undefined;
  readonly noDelay: boolean;
  readonly signal: AbortSignal | undefined;
  readonly scheduler: SapRouterTimerScheduler;
}

export type SapRouterFirstHopConnector = (
  endpoint: SapRouterFirstHop,
  options: SapRouterFirstHopConnectOptions,
) => Promise<SapRouterRouteSocket>;

export interface SapRouterConnectionDependencies {
  readonly connect?: SapRouterFirstHopConnector;
  readonly scheduler?: SapRouterTimerScheduler;
}

export interface EstablishedSapRouterRoute {
  /** Paused routed stream. Attach the NI/CPIC owner before resuming it. */
  readonly socket: SapRouterRouteSocket;
  /** Raw bytes received after the NI_PONG frame in the same data event. */
  readonly initialData: Buffer;
  readonly hopCount: number;
  readonly firstHop: SapRouterFirstHop;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RangeError(`${field} must be an integer in ${minimum}..${maximum}`);
  }
  return value as number;
}

function normalizeHandshakeOptions(
  options: SapRouterHandshakeOptions | undefined,
): NormalizedHandshakeOptions {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("SAProuter handshake options must be an object");
  }
  return Object.freeze({
    timeoutMs: boundedInteger(
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      1,
      MAX_TIMEOUT_MS,
    ),
    maxResponsePayloadBytes: boundedInteger(
      options?.maxResponsePayloadBytes ?? SAPROUTER_MAX_RESPONSE_PAYLOAD_BYTES,
      "maxResponsePayloadBytes",
      8,
      SAPROUTER_MAX_RESPONSE_PAYLOAD_BYTES,
    ),
    niVersion: boundedInteger(
      options?.niVersion ?? SAPROUTER_DEFAULT_NI_VERSION,
      "niVersion",
      1,
      255,
    ),
  });
}

function normalizeConnectOptions(
  options: SapRouterConnectOptions | undefined,
): NormalizedConnectOptions {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("SAProuter connect options must be an object");
  }
  const family = options?.family;
  if (family !== undefined && family !== 4 && family !== 6) {
    throw new RangeError("family must be 4 or 6");
  }
  const handshake = normalizeHandshakeOptions({
    timeoutMs: options?.handshakeTimeoutMs,
    maxResponsePayloadBytes: options?.maxResponsePayloadBytes,
    niVersion: options?.niVersion,
  });
  return Object.freeze({
    ...handshake,
    connectTimeoutMs: boundedInteger(
      options?.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "connectTimeoutMs",
      1,
      MAX_TIMEOUT_MS,
    ),
    family,
    noDelay: options?.noDelay ?? true,
  });
}

function schedulerFunctions(scheduler: SapRouterTimerScheduler): {
  readonly set: (callback: () => void, delayMs: number) => SapRouterTimerHandle;
  readonly clear: (handle: SapRouterTimerHandle) => void;
} {
  if (typeof scheduler !== "object" || scheduler === null) {
    throw new TypeError("SAProuter scheduler must be an object");
  }
  const set = scheduler.setTimeout;
  const clear = scheduler.clearTimeout;
  if (typeof set !== "function" || typeof clear !== "function") {
    throw new TypeError(
      "SAProuter scheduler must provide setTimeout and clearTimeout",
    );
  }
  return Object.freeze({
    set: (callback: () => void, delayMs: number): SapRouterTimerHandle =>
      Reflect.apply(set, scheduler, [callback, delayMs]) as SapRouterTimerHandle,
    clear: (handle: SapRouterTimerHandle): void => {
      Reflect.apply(clear, scheduler, [handle]);
    },
  });
}

function aborted(): SapRouterTransportError {
  return new SapRouterTransportError(
    "SAPROUTER_ABORTED",
    "SAProuter route setup was aborted",
  );
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  // AbortSignal changes asynchronously even though its property is readonly;
  // keeping the read behind a function prevents stale control-flow narrowing.
  return signal?.aborted === true;
}

function protocolError(message: string): SapRouterTransportError {
  return new SapRouterTransportError("SAPROUTER_PROTOCOL_ERROR", message);
}

function validateSocket(socket: SapRouterRouteSocket): void {
  if (typeof socket !== "object" || socket === null) {
    throw new TypeError("SAProuter connector must return a byte-stream socket");
  }
  for (const method of ["write", "pause", "destroy", "on", "removeListener"] as const) {
    if (typeof socket[method] !== "function") {
      throw new TypeError("SAProuter connector must return a byte-stream socket");
    }
  }
}

/**
 * Send exactly one NI_ROUTE request on an already-connected first-hop stream.
 * The returned stream is paused so an NI/CPIC owner can attach without losing
 * coalesced target bytes. Every failure is terminal and destroys the stream.
 */
export function establishSapRouterRoute(
  socket: SapRouterRouteSocket,
  route: AdmittedSapRouterRoute,
  options?: SapRouterHandshakeOptions,
  signal?: AbortSignal,
  scheduler: SapRouterTimerScheduler = SYSTEM_TIMER_SCHEDULER,
): Promise<EstablishedSapRouterRoute> {
  assertAdmittedSapRouterRoute(route);
  validateSocket(socket);
  const normalized = normalizeHandshakeOptions(options);
  const timers = schedulerFunctions(scheduler);
  if (signal?.aborted === true) {
    try { socket.destroy(); } catch { /* best effort */ }
    return Promise.reject(aborted());
  }

  const responseHeader = Buffer.alloc(4);
  let responseHeaderLength = 0;
  let responsePayload: Buffer | undefined;
  let responsePayloadLength = 0;
  let request: Buffer | undefined;
  let timer: SapRouterTimerHandle | typeof NO_TIMER = NO_TIMER;
  let settled = false;
  let destroyInvoked = false;

  return new Promise<EstablishedSapRouterRoute>((resolve, reject) => {
    const removeListeners = (): void => {
      try { socket.removeListener("data", onData); } catch { /* best effort */ }
      try { socket.removeListener("error", onError); } catch { /* best effort */ }
      try { socket.removeListener("end", onEnd); } catch { /* best effort */ }
      try { socket.removeListener("close", onClose); } catch { /* best effort */ }
      try { signal?.removeEventListener("abort", onAbort); } catch { /* best effort */ }
      if (timer !== NO_TIMER) {
        const handle = timer;
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* cleanup is best effort */ }
      }
    };

    const wipeTransientBuffers = (): void => {
      request?.fill(0);
      request = undefined;
      responseHeader.fill(0);
      responsePayload?.fill(0);
      responsePayload = undefined;
    };

    const destroySocket = (): void => {
      if (destroyInvoked) return;
      destroyInvoked = true;
      try { socket.destroy(); } catch { /* the rejection remains authoritative */ }
    };

    const fail = (
      error: SapRouterTransportError,
      shouldDestroy = true,
    ): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      if (shouldDestroy) destroySocket();
      wipeTransientBuffers();
      reject(error);
    };

    const succeed = (initialData: Buffer): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      wipeTransientBuffers();
      resolve(Object.freeze({
        socket,
        initialData,
        hopCount: route.hopCount,
        firstHop: route.firstHop,
      }));
    };

    function onAbort(): void {
      fail(aborted());
    }

    function onError(error: unknown): void {
      fail(new SapRouterTransportError(
        "SAPROUTER_CONNECTION_CLOSED",
        "SAProuter first-hop stream failed before route handoff",
        { cause: error },
      ));
    }

    function onEnd(): void {
      const partial = responseHeaderLength !== 0 || responsePayloadLength !== 0;
      fail(partial
        ? protocolError("SAProuter ended a truncated route response")
        : new SapRouterTransportError(
          "SAPROUTER_CONNECTION_CLOSED",
          "SAProuter first-hop stream ended before route handoff",
        ));
    }

    function onClose(): void {
      fail(new SapRouterTransportError(
        "SAPROUTER_CONNECTION_CLOSED",
        "SAProuter first-hop stream closed before route handoff",
      ), false);
    }

    function onData(chunk: unknown): void {
      if (settled) return;
      if (!Buffer.isBuffer(chunk)) {
        fail(protocolError("SAProuter stream must provide unencoded byte buffers"));
        return;
      }

      let cursor = 0;
      if (responseHeaderLength < 4) {
        const take = Math.min(4 - responseHeaderLength, chunk.length);
        chunk.copy(responseHeader, responseHeaderLength, 0, take);
        responseHeaderLength += take;
        cursor += take;
        if (responseHeaderLength < 4) return;
        const declaredLength = responseHeader.readUInt32BE(0);
        if (
          declaredLength < 8 ||
          declaredLength > normalized.maxResponsePayloadBytes
        ) {
          fail(protocolError(
            "SAProuter route response exceeds the configured payload bounds",
          ));
          return;
        }
        responsePayload = Buffer.alloc(declaredLength);
      }

      const payload = responsePayload;
      if (payload === undefined) {
        fail(protocolError("SAProuter route response decoder is inconsistent"));
        return;
      }
      const take = Math.min(payload.length - responsePayloadLength, chunk.length - cursor);
      if (take > 0) {
        chunk.copy(payload, responsePayloadLength, cursor, cursor + take);
        responsePayloadLength += take;
        cursor += take;
      }
      if (responsePayloadLength < payload.length) return;

      try {
        socket.pause();
      } catch {
        fail(protocolError("SAProuter stream could not be paused for handoff"));
        return;
      }

      let response: ReturnType<typeof decodeSapRouterRouteResponse>;
      try {
        response = decodeSapRouterRouteResponse(payload);
      } catch (cause) {
        fail(protocolError(
          cause instanceof Error
            ? cause.message
            : "SAProuter returned an invalid route response",
        ));
        return;
      }
      if (response.kind === "rejected") {
        const denied = response.returnCode === -94;
        fail(new SapRouterTransportError(
          denied ? "SAPROUTER_ROUTE_DENIED" : "SAPROUTER_ROUTE_REJECTED",
          denied
            ? "SAProuter denied the requested route"
            : `SAProuter rejected route setup with return code ${response.returnCode}`,
          { routerReturnCode: response.returnCode },
        ));
        return;
      }
      succeed(Buffer.from(chunk.subarray(cursor)));
    }

    try {
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("end", onEnd);
      socket.on("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    } catch (cause) {
      fail(new SapRouterTransportError(
        "SAPROUTER_CONNECTION_CLOSED",
        "SAProuter stream rejected lifecycle listeners",
        { cause },
      ));
      return;
    }
    if (signal?.aborted === true) {
      onAbort();
      return;
    }

    try {
      const handle = timers.set(
        () => fail(new SapRouterTransportError(
          "SAPROUTER_HANDSHAKE_TIMEOUT",
          `SAProuter route negotiation timed out after ${normalized.timeoutMs} ms`,
        )),
        normalized.timeoutMs,
      );
      timer = handle;
      if (settled) {
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* best effort */ }
        return;
      }
    } catch (cause) {
      fail(new SapRouterTransportError(
        "SAPROUTER_HANDSHAKE_TIMEOUT",
        "SAProuter route timer scheduler failed",
        { cause },
      ));
      return;
    }

    try {
      const payload = encodeSapRouterRouteRequestPayload(route, {
        niVersion: normalized.niVersion,
      });
      request = encodeNiFrame(payload);
      payload.fill(0);
      socket.write(request, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          fail(new SapRouterTransportError(
            "SAPROUTER_WRITE_FAILED",
            "SAProuter NI_ROUTE request write failed",
            { cause: error },
          ));
          return;
        }
        request?.fill(0);
        request = undefined;
      });
    } catch (cause) {
      fail(new SapRouterTransportError(
        "SAPROUTER_WRITE_FAILED",
        "SAProuter NI_ROUTE request write failed",
        { cause },
      ));
    }
  });
}

function numericFirstHopPort(service: string): number {
  if (service === "saprouter") return 3_299;
  if (!/^[0-9]{1,5}$/u.test(service)) {
    throw new SapRouterTransportError(
      "SAPROUTER_UNSUPPORTED_SERVICE",
      "the system connector requires a numeric first-hop service or saprouter",
    );
  }
  const port = Number(service);
  if (port < 1 || port > 65_535) {
    throw new SapRouterTransportError(
      "SAPROUTER_UNSUPPORTED_SERVICE",
      "the SAProuter first-hop service is outside TCP port bounds",
    );
  }
  return port;
}

function systemConnectFirstHop(
  endpoint: SapRouterFirstHop,
  options: SapRouterFirstHopConnectOptions,
): Promise<SapRouterRouteSocket> {
  const port = numericFirstHopPort(endpoint.service);
  const host = endpoint.host.startsWith("[") && endpoint.host.endsWith("]")
    ? endpoint.host.slice(1, -1)
    : endpoint.host;
  if (endpoint.host.startsWith("[") && isIP(host) !== 6) {
    throw new SapRouterTransportError(
      "SAPROUTER_CONNECT_FAILED",
      "the SAProuter first-hop IP literal is invalid",
    );
  }
  if (options.signal?.aborted === true) return Promise.reject(aborted());

  let socket: Socket;
  try {
    socket = createConnection({ host, port, family: options.family });
    socket.setNoDelay(options.noDelay);
  } catch (cause) {
    return Promise.reject(new SapRouterTransportError(
      "SAPROUTER_CONNECT_FAILED",
      "SAProuter first-hop connection could not be started",
      { cause },
    ));
  }
  const timers = schedulerFunctions(options.scheduler);

  return new Promise<SapRouterRouteSocket>((resolve, reject) => {
    let settled = false;
    let timer: SapRouterTimerHandle | typeof NO_TIMER = NO_TIMER;
    const cleanup = (): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      options.signal?.removeEventListener("abort", onAbort);
      if (timer !== NO_TIMER) {
        const handle = timer;
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* best effort */ }
      }
    };
    const settle = (error?: SapRouterTransportError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(socket);
      else {
        socket.destroy();
        reject(error);
      }
    };
    function onConnect(): void { settle(); }
    function onError(cause: unknown): void {
      settle(new SapRouterTransportError(
        "SAPROUTER_CONNECT_FAILED",
        "SAProuter first-hop connection failed",
        { cause },
      ));
    }
    function onClose(): void {
      settle(new SapRouterTransportError(
        "SAPROUTER_CONNECT_FAILED",
        "SAProuter first-hop connection closed before negotiation",
      ));
    }
    function onAbort(): void { settle(aborted()); }

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    try {
      const handle = timers.set(
        () => settle(new SapRouterTransportError(
          "SAPROUTER_CONNECT_TIMEOUT",
          `SAProuter first-hop connection timed out after ${options.timeoutMs} ms`,
        )),
        options.timeoutMs,
      );
      timer = handle;
      if (settled) {
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* best effort */ }
      }
    } catch (cause) {
      settle(new SapRouterTransportError(
        "SAPROUTER_CONNECT_FAILED",
        "SAProuter connect timer scheduler failed",
        { cause },
      ));
    }
  });
}

function admittedRoute(
  route: string | AdmittedSapRouterRoute,
): AdmittedSapRouterRoute {
  if (typeof route === "string") return admitSapRouterRoute(route);
  assertAdmittedSapRouterRoute(route);
  return route;
}

/** Validate, connect the first hop, negotiate NI_ROUTE, and return the stream. */
export async function connectSapRouterRoute(
  routeInput: string | AdmittedSapRouterRoute,
  options?: SapRouterConnectOptions,
  signal?: AbortSignal,
  dependencies: SapRouterConnectionDependencies = {},
): Promise<EstablishedSapRouterRoute> {
  // Admission and all bounded scalar validation happen before a connector is
  // selected or invoked. Invalid caller input therefore performs no I/O.
  const route = admittedRoute(routeInput);
  const normalized = normalizeConnectOptions(options);
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new TypeError("SAProuter connection dependencies must be an object");
  }
  const scheduler = dependencies.scheduler ?? SYSTEM_TIMER_SCHEDULER;
  schedulerFunctions(scheduler);
  const connector = dependencies.connect ?? systemConnectFirstHop;
  if (typeof connector !== "function") {
    throw new TypeError("SAProuter connector must be a function");
  }
  if (signalAborted(signal)) throw aborted();

  let socket: SapRouterRouteSocket | undefined;
  try {
    socket = await Reflect.apply(connector, undefined, [
      route.firstHop,
      Object.freeze({
        timeoutMs: normalized.connectTimeoutMs,
        family: normalized.family,
        noDelay: normalized.noDelay,
        signal,
        scheduler,
      } satisfies SapRouterFirstHopConnectOptions),
    ]) as SapRouterRouteSocket;
    validateSocket(socket);
  } catch (cause) {
    try { socket?.destroy(); } catch { /* connector failure remains authoritative */ }
    if (cause instanceof SapRouterTransportError) throw cause;
    if (signalAborted(signal)) throw aborted();
    throw new SapRouterTransportError(
      "SAPROUTER_CONNECT_FAILED",
      "SAProuter first-hop connector failed",
      { cause },
    );
  }
  if (signalAborted(signal)) {
    try { socket.destroy(); } catch { /* best effort */ }
    throw aborted();
  }
  return establishSapRouterRoute(
    socket,
    route,
    {
      timeoutMs: normalized.timeoutMs,
      maxResponsePayloadBytes: normalized.maxResponsePayloadBytes,
      niVersion: normalized.niVersion,
    },
    signal,
    scheduler,
  );
}
