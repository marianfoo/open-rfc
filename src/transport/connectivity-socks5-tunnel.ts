import {
  createConnection,
  isIP,
  type Socket,
} from "node:net";
import { inspect, types as nodeUtilTypes } from "node:util";

const SOCKS_VERSION = 0x05;
const JWT_AUTHENTICATION_METHOD = 0x80;
const JWT_AUTHENTICATION_VERSION = 0x01;
const CONNECT_COMMAND = 0x01;
const DOMAIN_ADDRESS = 0x03;
const IPV4_ADDRESS = 0x01;
const IPV6_ADDRESS = 0x04;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFERED_BYTES = 16_384;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFERED_BYTES = 1_048_576;
const MAX_ACCESS_TOKEN_BYTES = 65_536;
const NO_TIMER = Symbol("no Connectivity SOCKS5 timer");
const CUSTOM_INSPECT = inspect.custom;

const ALLOWED_CONFIG_PROPERTIES = Object.freeze(new Set([
  "proxyHost",
  "proxyPort",
  "targetHost",
  "targetPort",
  "accessToken",
  "locationId",
  "timeoutMs",
  "maxBufferedBytes",
]));
const ADMITTED_CONFIGS = new WeakSet<object>();

export type ConnectivitySocks5ErrorCode =
  | "CONNECTIVITY_SOCKS5_ABORTED"
  | "CONNECTIVITY_SOCKS5_AUTHENTICATION_REJECTED"
  | "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED"
  | "CONNECTIVITY_SOCKS5_CONNECT_FAILED"
  | "CONNECTIVITY_SOCKS5_CONNECT_REJECTED"
  | "CONNECTIVITY_SOCKS5_CONNECT_TIMEOUT"
  | "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR"
  | "CONNECTIVITY_SOCKS5_TIMEOUT"
  | "CONNECTIVITY_SOCKS5_WRITE_FAILED";

/** A bounded failure that never includes tokens, locations, or endpoint names. */
export class ConnectivitySocks5Error extends Error {
  readonly code: ConnectivitySocks5ErrorCode;
  readonly replyCode: number | undefined;

  constructor(
    code: ConnectivitySocks5ErrorCode,
    message: string,
    replyCode?: number,
  ) {
    super(message);
    this.name = "ConnectivitySocks5Error";
    this.code = code;
    this.replyCode = replyCode;
    const safe = (): Readonly<Record<string, unknown>> => Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.replyCode === undefined ? {} : { replyCode: this.replyCode }),
    });
    Object.defineProperty(this, "toJSON", {
      configurable: false,
      enumerable: false,
      value: safe,
      writable: false,
    });
    Object.defineProperty(this, CUSTOM_INSPECT, {
      configurable: false,
      enumerable: false,
      value: safe,
      writable: false,
    });
  }
}

export interface ConnectivitySocks5ConfigInput {
  /** Host and SOCKS5 port from the Connectivity binding (normally 20004). */
  readonly proxyHost: string;
  readonly proxyPort: number;
  /** Cloud Connector TCP virtual host and virtual port; never resolved locally. */
  readonly targetHost: string;
  readonly targetPort: number;
  /** Raw Connectivity service JWT. Do not include a `Bearer ` prefix. */
  readonly accessToken: string;
  /** Unencoded Cloud Connector location ID. */
  readonly locationId?: string;
  readonly timeoutMs?: number;
  readonly maxBufferedBytes?: number;
}

export interface AdmittedConnectivitySocks5Config {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly accessToken: string;
  readonly locationId: string | undefined;
  readonly timeoutMs: number;
  readonly maxBufferedBytes: number;
}

/** Minimal connected byte stream shared by net.Socket and compatible streams. */
export interface ConnectivitySocks5Socket {
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

export type ConnectivitySocks5TimerHandle = unknown;

export interface ConnectivitySocks5TimerScheduler {
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ConnectivitySocks5TimerHandle;
  clearTimeout(handle: ConnectivitySocks5TimerHandle): void;
}

const SYSTEM_TIMER_SCHEDULER: ConnectivitySocks5TimerScheduler = Object.freeze({
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle: ConnectivitySocks5TimerHandle): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

export interface EstablishedConnectivitySocks5Tunnel {
  /** Paused stream. Attach the target protocol consumer before resuming it. */
  readonly socket: ConnectivitySocks5Socket;
  /** Bytes received after the CONNECT response in the same data event. */
  readonly initialData: Buffer;
}

export interface ConnectivitySocks5ProxyConnectOptions {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly scheduler: ConnectivitySocks5TimerScheduler;
}

export type ConnectivitySocks5ProxyConnector = (
  options: ConnectivitySocks5ProxyConnectOptions,
) => Promise<ConnectivitySocks5Socket>;

export interface ConnectivitySocks5ConnectionDependencies {
  readonly connect?: ConnectivitySocks5ProxyConnector;
  readonly scheduler?: ConnectivitySocks5TimerScheduler;
}

function plainRecord(input: unknown): Readonly<Record<PropertyKey, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Connectivity SOCKS5 configuration must be a plain object");
  }
  if (nodeUtilTypes.isProxy(input)) {
    throw new TypeError("Connectivity SOCKS5 configuration must not be a Proxy");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Connectivity SOCKS5 configuration must be a plain object");
  }
  return input as Readonly<Record<PropertyKey, unknown>>;
}

function ownDataProperties(
  input: Readonly<Record<PropertyKey, unknown>>,
): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw new TypeError("Connectivity SOCKS5 configuration does not accept symbol properties");
    }
    if (!ALLOWED_CONFIG_PROPERTIES.has(key)) {
      throw new TypeError(
        `Connectivity SOCKS5 configuration has unsupported property ${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${key} must be an own data property`);
    }
    values.set(key, descriptor.value);
  }
  return values;
}

function required(
  values: ReadonlyMap<string, unknown>,
  field: string,
): unknown {
  if (!values.has(field)) {
    throw new TypeError(`${field} must be an own data property`);
  }
  return values.get(field);
}

function host(
  value: unknown,
  field: "proxyHost" | "targetHost",
  ipv6Allowed: boolean,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty host name or IP address`);
  }
  let candidate = value;
  let bracketed = false;
  if (candidate.startsWith("[") || candidate.endsWith("]")) {
    if (!(candidate.startsWith("[") && candidate.endsWith("]"))) {
      throw new RangeError(`${field} contains an invalid IP literal`);
    }
    bracketed = true;
    candidate = candidate.slice(1, -1);
  }
  const version = isIP(candidate);
  if (bracketed && version !== 6) {
    throw new RangeError(`${field} contains an invalid bracketed IPv6 literal`);
  }
  if (version === 6) {
    if (!ipv6Allowed) {
      throw new RangeError(
        "targetHost cannot be IPv6 because the SAP Connectivity SOCKS5 endpoint documents only IPv4 and DOMAIN targets",
      );
    }
    return candidate;
  }
  if (version === 4) return candidate;
  if (/^\d+(?:\.\d+){3}$/u.test(candidate)) {
    throw new RangeError(`${field} contains an invalid IPv4 address`);
  }
  const normalized = candidate.endsWith(".")
    ? candidate.slice(0, -1)
    : candidate;
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    !/^[A-Za-z0-9.-]+$/u.test(normalized) ||
    normalized.includes("..")
  ) {
    throw new RangeError(`${field} contains an invalid host name`);
  }
  for (const label of normalized.split(".")) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
    ) {
      throw new RangeError(`${field} contains an invalid host name`);
    }
  }
  return normalized;
}

function port(value: unknown, field: "proxyPort" | "targetPort"): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65_535
  ) {
    throw new RangeError(`${field} must be an integer in 1..65535`);
  }
  return value as number;
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

function accessToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    Buffer.byteLength(value, "ascii") > MAX_ACCESS_TOKEN_BYTES
  ) {
    throw new RangeError(
      `accessToken must be 1..${MAX_ACCESS_TOKEN_BYTES} visible ASCII bytes without a Bearer prefix`,
    );
  }
  return value;
}

function locationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 189 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError("locationId must be non-empty text without control characters");
  }
  const rawLength = Buffer.byteLength(value, "utf8");
  if (rawLength > 189) {
    throw new RangeError(
      "locationId is too long after the required base64 encoding",
    );
  }
  return value;
}

function safeConfigView(
  config: AdmittedConnectivitySocks5Config,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    proxyHost: "<redacted>",
    proxyPort: config.proxyPort,
    targetHost: "<redacted>",
    targetPort: config.targetPort,
    accessToken: "<redacted>",
    locationId: config.locationId === undefined ? undefined : "<redacted>",
    timeoutMs: config.timeoutMs,
    maxBufferedBytes: config.maxBufferedBytes,
  });
}

/** Validate and snapshot every byte-affecting field before network I/O. */
export function admitConnectivitySocks5Config(
  input: ConnectivitySocks5ConfigInput | Readonly<Record<string, unknown>>,
): AdmittedConnectivitySocks5Config {
  const values = ownDataProperties(plainRecord(input));
  const normalized = {
    proxyHost: host(required(values, "proxyHost"), "proxyHost", true),
    proxyPort: port(required(values, "proxyPort"), "proxyPort"),
    targetHost: host(required(values, "targetHost"), "targetHost", false),
    targetPort: port(required(values, "targetPort"), "targetPort"),
    accessToken: accessToken(required(values, "accessToken")),
    locationId: locationId(values.get("locationId")),
    timeoutMs: boundedInteger(
      values.get("timeoutMs") ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      1,
      MAX_TIMEOUT_MS,
    ),
    maxBufferedBytes: boundedInteger(
      values.get("maxBufferedBytes") ?? DEFAULT_MAX_BUFFERED_BYTES,
      "maxBufferedBytes",
      8,
      MAX_BUFFERED_BYTES,
    ),
  } satisfies AdmittedConnectivitySocks5Config;
  Object.defineProperty(normalized, "toJSON", {
    configurable: false,
    enumerable: false,
    value: (): Readonly<Record<string, unknown>> => safeConfigView(normalized),
    writable: false,
  });
  Object.defineProperty(normalized, CUSTOM_INSPECT, {
    configurable: false,
    enumerable: false,
    value: (): Readonly<Record<string, unknown>> => safeConfigView(normalized),
    writable: false,
  });
  Object.freeze(normalized);
  ADMITTED_CONFIGS.add(normalized);
  return normalized;
}

export function assertAdmittedConnectivitySocks5Config(
  input: unknown,
): asserts input is AdmittedConnectivitySocks5Config {
  if (typeof input !== "object" || input === null || !ADMITTED_CONFIGS.has(input)) {
    throw new TypeError(
      "Connectivity SOCKS5 configuration must come from admitConnectivitySocks5Config",
    );
  }
}

function validateSocket(socket: unknown): asserts socket is ConnectivitySocks5Socket {
  if (typeof socket !== "object" || socket === null) {
    throw new TypeError("Connectivity SOCKS5 socket must be a connected byte stream");
  }
  for (const method of [
    "write",
    "pause",
    "destroy",
    "on",
    "removeListener",
  ] as const) {
    if (typeof (socket as Record<string, unknown>)[method] !== "function") {
      throw new TypeError("Connectivity SOCKS5 socket must be a connected byte stream");
    }
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  // AbortSignal is mutable across async and caller-controlled boundaries.
  return signal?.aborted === true;
}

function schedulerFunctions(
  scheduler: ConnectivitySocks5TimerScheduler,
): {
  readonly set: (
    callback: () => void,
    delayMs: number,
  ) => ConnectivitySocks5TimerHandle;
  readonly clear: (handle: ConnectivitySocks5TimerHandle) => void;
} {
  if (typeof scheduler !== "object" || scheduler === null) {
    throw new TypeError("Connectivity SOCKS5 scheduler must be an object");
  }
  const set = scheduler.setTimeout;
  const clear = scheduler.clearTimeout;
  if (typeof set !== "function" || typeof clear !== "function") {
    throw new TypeError(
      "Connectivity SOCKS5 scheduler must provide setTimeout and clearTimeout",
    );
  }
  return Object.freeze({
    set: (callback: () => void, delayMs: number): ConnectivitySocks5TimerHandle =>
      Reflect.apply(set, scheduler, [callback, delayMs]) as ConnectivitySocks5TimerHandle,
    clear: (handle: ConnectivitySocks5TimerHandle): void => {
      Reflect.apply(clear, scheduler, [handle]);
    },
  });
}

function authenticationRequest(
  config: AdmittedConnectivitySocks5Config,
): Buffer {
  const token = Buffer.from(config.accessToken, "ascii");
  const location = config.locationId === undefined
    ? Buffer.alloc(0)
    : Buffer.from(Buffer.from(config.locationId, "utf8").toString("base64"), "ascii");
  const request = Buffer.alloc(1 + 4 + token.length + 1 + location.length);
  request[0] = JWT_AUTHENTICATION_VERSION;
  request.writeUInt32BE(token.length, 1);
  token.copy(request, 5);
  request[5 + token.length] = location.length;
  location.copy(request, 6 + token.length);
  token.fill(0);
  location.fill(0);
  return request;
}

function ipv4Bytes(hostName: string): Buffer | undefined {
  if (isIP(hostName) !== 4) return undefined;
  return Buffer.from(hostName.split(".").map((octet) => Number(octet)));
}

function connectRequest(
  config: AdmittedConnectivitySocks5Config,
): Buffer {
  const ipv4 = ipv4Bytes(config.targetHost);
  let request: Buffer;
  if (ipv4 !== undefined) {
    request = Buffer.alloc(4 + 4 + 2);
    request.set([SOCKS_VERSION, CONNECT_COMMAND, 0x00, IPV4_ADDRESS], 0);
    ipv4.copy(request, 4);
    request.writeUInt16BE(config.targetPort, 8);
    ipv4.fill(0);
    return request;
  }
  const domain = Buffer.from(config.targetHost, "ascii");
  // Admission already constrains a normalized domain to 1..253 ASCII bytes.
  request = Buffer.alloc(5 + domain.length + 2);
  request.set([SOCKS_VERSION, CONNECT_COMMAND, 0x00, DOMAIN_ADDRESS, domain.length], 0);
  domain.copy(request, 5);
  request.writeUInt16BE(config.targetPort, 5 + domain.length);
  domain.fill(0);
  return request;
}

type HandshakePhase =
  | "method-response"
  | "authentication-response"
  | "connect-response";

/**
 * Negotiate SAP's documented method 0x80 JWT SOCKS5 extension on an already
 * connected stream. This function is for the binding's SOCKS5/TCP endpoint,
 * not the distinct RFC/LDAP proxy endpoint.
 */
export function establishConnectivitySocks5Tunnel(
  socket: ConnectivitySocks5Socket,
  config: AdmittedConnectivitySocks5Config,
  signal?: AbortSignal,
  scheduler: ConnectivitySocks5TimerScheduler = SYSTEM_TIMER_SCHEDULER,
): Promise<EstablishedConnectivitySocks5Tunnel> {
  validateSocket(socket);
  assertAdmittedConnectivitySocks5Config(config);
  const timers = schedulerFunctions(scheduler);
  if (signalAborted(signal)) {
    try { socket.destroy(); } catch { /* rejection remains authoritative */ }
    return Promise.reject(new ConnectivitySocks5Error(
      "CONNECTIVITY_SOCKS5_ABORTED",
      "Connectivity SOCKS5 setup was aborted",
    ));
  }

  return new Promise<EstablishedConnectivitySocks5Tunnel>((resolve, reject) => {
    let settled = false;
    let phase: HandshakePhase = "method-response";
    let buffered = Buffer.alloc(0);
    let timer: ConnectivitySocks5TimerHandle | typeof NO_TIMER = NO_TIMER;
    const pendingWrites = new Set<Buffer>();

    const clearSensitiveWrites = (): void => {
      for (const frame of pendingWrites) frame.fill(0);
      pendingWrites.clear();
    };
    const cleanup = (): void => {
      try { socket.removeListener("data", onData); } catch { /* best effort */ }
      try { socket.removeListener("error", onError); } catch { /* best effort */ }
      try { socket.removeListener("end", onEnd); } catch { /* best effort */ }
      try { socket.removeListener("close", onClose); } catch { /* best effort */ }
      try { signal?.removeEventListener("abort", onAbort); } catch { /* best effort */ }
      if (timer !== NO_TIMER) {
        const handle = timer;
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* best effort */ }
      }
    };
    const fail = (error: ConnectivitySocks5Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearSensitiveWrites();
      buffered.fill(0);
      buffered = Buffer.alloc(0);
      try { socket.destroy(); } catch { /* failure remains authoritative */ }
      reject(error);
    };
    const succeed = (responseLength: number): void => {
      if (settled) return;
      const initialData = Buffer.from(buffered.subarray(responseLength));
      buffered.fill(0);
      buffered = Buffer.alloc(0);
      try {
        socket.pause();
      } catch {
        initialData.fill(0);
        fail(new ConnectivitySocks5Error(
          "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
          "Connectivity SOCKS5 socket could not be paused for handoff",
        ));
        return;
      }
      settled = true;
      cleanup();
      clearSensitiveWrites();
      resolve(Object.freeze({ socket, initialData }));
    };
    const send = (frame: Buffer): void => {
      if (settled) {
        frame.fill(0);
        return;
      }
      pendingWrites.add(frame);
      try {
        socket.write(frame, (error?: Error | null) => {
          pendingWrites.delete(frame);
          frame.fill(0);
          if (error !== undefined && error !== null) {
            fail(new ConnectivitySocks5Error(
              "CONNECTIVITY_SOCKS5_WRITE_FAILED",
              "Connectivity SOCKS5 request write failed",
            ));
          }
        });
      } catch {
        pendingWrites.delete(frame);
        frame.fill(0);
        fail(new ConnectivitySocks5Error(
          "CONNECTIVITY_SOCKS5_WRITE_FAILED",
          "Connectivity SOCKS5 request write failed",
        ));
      }
    };
    const consume = (length: number): void => {
      const remainder = Buffer.from(buffered.subarray(length));
      buffered.fill(0);
      buffered = remainder;
    };
    const process = (): void => {
      while (!settled) {
        if (phase === "method-response") {
          if (buffered.length < 2) return;
          if (buffered[0] !== SOCKS_VERSION) {
            fail(new ConnectivitySocks5Error(
              "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
              "Connectivity SOCKS5 proxy returned an unsupported protocol version",
            ));
            return;
          }
          if (buffered[1] !== JWT_AUTHENTICATION_METHOD) {
            fail(new ConnectivitySocks5Error(
              "CONNECTIVITY_SOCKS5_AUTHENTICATION_REJECTED",
              "Connectivity SOCKS5 proxy did not accept JWT authentication",
            ));
            return;
          }
          consume(2);
          phase = "authentication-response";
          send(authenticationRequest(config));
          continue;
        }

        if (phase === "authentication-response") {
          if (buffered.length < 2) return;
          if (buffered[0] !== JWT_AUTHENTICATION_VERSION) {
            fail(new ConnectivitySocks5Error(
              "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
              "Connectivity SOCKS5 proxy returned an unsupported authentication version",
            ));
            return;
          }
          if (buffered[1] !== 0x00) {
            fail(new ConnectivitySocks5Error(
              "CONNECTIVITY_SOCKS5_AUTHENTICATION_REJECTED",
              "Connectivity SOCKS5 proxy rejected authentication",
            ));
            return;
          }
          consume(2);
          phase = "connect-response";
          send(connectRequest(config));
          continue;
        }

        if (buffered.length < 4) return;
        if (buffered[0] !== SOCKS_VERSION || buffered[2] !== 0x00) {
          fail(new ConnectivitySocks5Error(
            "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
            "Connectivity SOCKS5 proxy returned a malformed CONNECT response",
          ));
          return;
        }
        const replyCode = buffered[1]!;
        if (replyCode !== 0x00) {
          fail(new ConnectivitySocks5Error(
            "CONNECTIVITY_SOCKS5_CONNECT_REJECTED",
            "Connectivity SOCKS5 proxy rejected the target connection",
            replyCode,
          ));
          return;
        }
        const addressType = buffered[3]!;
        if (addressType === IPV4_ADDRESS) {
          if (buffered.length < 10) return;
          succeed(10);
          return;
        }
        if (addressType === DOMAIN_ADDRESS) {
          if (buffered.length < 5) return;
          const domainLength = buffered[4]!;
          if (domainLength === 0) {
            fail(new ConnectivitySocks5Error(
              "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
              "Connectivity SOCKS5 proxy returned an empty bound domain",
            ));
            return;
          }
          const responseLength = 7 + domainLength;
          if (buffered.length < responseLength) return;
          succeed(responseLength);
          return;
        }
        if (addressType === IPV6_ADDRESS) {
          if (buffered.length < 22) return;
          succeed(22);
          return;
        }
        fail(new ConnectivitySocks5Error(
          "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
          "Connectivity SOCKS5 proxy returned an unsupported address type",
        ));
        return;
      }
    };
    function onData(chunk: unknown): void {
      if (settled) return;
      if (!Buffer.isBuffer(chunk)) {
        fail(new ConnectivitySocks5Error(
          "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
          "Connectivity SOCKS5 proxy returned a non-binary response",
        ));
        return;
      }
      if (chunk.length > config.maxBufferedBytes - buffered.length) {
        fail(new ConnectivitySocks5Error(
          "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
          "Connectivity SOCKS5 response exceeded the configured byte bound",
        ));
        return;
      }
      const next = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
      buffered.fill(0);
      buffered = next;
      process();
    }
    function onError(): void {
      fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED",
        "Connectivity SOCKS5 connection failed during setup",
      ));
    }
    function onEnd(): void {
      fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED",
        "Connectivity SOCKS5 connection ended during setup",
      ));
    }
    function onClose(): void {
      fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECTION_CLOSED",
        "Connectivity SOCKS5 connection closed during setup",
      ));
    }
    function onAbort(): void {
      fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_ABORTED",
        "Connectivity SOCKS5 setup was aborted",
      ));
    }

    try {
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("end", onEnd);
      socket.on("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    } catch {
      fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
        "Connectivity SOCKS5 lifecycle listeners could not be installed",
      ));
      return;
    }
    if (signalAborted(signal)) {
      onAbort();
      return;
    }
    try {
      const handle = timers.set(() => fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_TIMEOUT",
        "Connectivity SOCKS5 handshake timed out",
      )), config.timeoutMs);
      timer = handle;
      if (settled) {
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* best effort */ }
        return;
      }
    } catch {
      fail(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_PROTOCOL_ERROR",
        "Connectivity SOCKS5 timer scheduler failed",
      ));
      return;
    }
    send(Buffer.from([SOCKS_VERSION, 0x01, JWT_AUTHENTICATION_METHOD]));
  });
}

function systemConnectProxy(
  options: ConnectivitySocks5ProxyConnectOptions,
): Promise<ConnectivitySocks5Socket> {
  if (options.signal?.aborted === true) {
    return Promise.reject(new ConnectivitySocks5Error(
      "CONNECTIVITY_SOCKS5_ABORTED",
      "Connectivity SOCKS5 setup was aborted",
    ));
  }
  let socket: Socket;
  try {
    socket = createConnection({
      host: options.proxyHost,
      port: options.proxyPort,
    });
    socket.setNoDelay(true);
  } catch {
    return Promise.reject(new ConnectivitySocks5Error(
      "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
      "Connectivity SOCKS5 proxy connection could not be started",
    ));
  }
  const timers = schedulerFunctions(options.scheduler);
  return new Promise<ConnectivitySocks5Socket>((resolve, reject) => {
    let settled = false;
    let timer: ConnectivitySocks5TimerHandle | typeof NO_TIMER = NO_TIMER;
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
    const settle = (error?: ConnectivitySocks5Error): void => {
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
    function onError(): void {
      settle(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
        "Connectivity SOCKS5 proxy connection failed",
      ));
    }
    function onClose(): void {
      settle(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
        "Connectivity SOCKS5 proxy connection closed before negotiation",
      ));
    }
    function onAbort(): void {
      settle(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_ABORTED",
        "Connectivity SOCKS5 setup was aborted",
      ));
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    try {
      const handle = timers.set(() => settle(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECT_TIMEOUT",
        "Connectivity SOCKS5 proxy connection timed out",
      )), options.timeoutMs);
      timer = handle;
      if (settled) {
        timer = NO_TIMER;
        try { timers.clear(handle); } catch { /* best effort */ }
      }
    } catch {
      settle(new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
        "Connectivity SOCKS5 connect timer scheduler failed",
      ));
    }
  });
}

/** Validate, connect to the explicit SOCKS5 endpoint, and negotiate the tunnel. */
export async function connectConnectivitySocks5Tunnel(
  input: ConnectivitySocks5ConfigInput | AdmittedConnectivitySocks5Config,
  signal?: AbortSignal,
  dependencies: ConnectivitySocks5ConnectionDependencies = {},
): Promise<EstablishedConnectivitySocks5Tunnel> {
  const config = ADMITTED_CONFIGS.has(input as object)
    ? input as AdmittedConnectivitySocks5Config
    : admitConnectivitySocks5Config(input as ConnectivitySocks5ConfigInput);
  assertAdmittedConnectivitySocks5Config(config);
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    throw new TypeError("Connectivity SOCKS5 connection dependencies must be an object");
  }
  const scheduler = dependencies.scheduler ?? SYSTEM_TIMER_SCHEDULER;
  schedulerFunctions(scheduler);
  const connector = dependencies.connect ?? systemConnectProxy;
  if (typeof connector !== "function") {
    throw new TypeError("Connectivity SOCKS5 proxy connector must be a function");
  }
  if (signalAborted(signal)) {
    throw new ConnectivitySocks5Error(
      "CONNECTIVITY_SOCKS5_ABORTED",
      "Connectivity SOCKS5 setup was aborted",
    );
  }
  let socket: ConnectivitySocks5Socket | undefined;
  try {
    socket = await Reflect.apply(connector, undefined, [Object.freeze({
      proxyHost: config.proxyHost,
      proxyPort: config.proxyPort,
      timeoutMs: config.timeoutMs,
      signal,
      scheduler,
    } satisfies ConnectivitySocks5ProxyConnectOptions)]) as ConnectivitySocks5Socket;
    validateSocket(socket);
  } catch (error) {
    try { socket?.destroy(); } catch { /* connector failure remains authoritative */ }
    if (error instanceof ConnectivitySocks5Error) throw error;
    if (signal?.aborted === true) {
      throw new ConnectivitySocks5Error(
        "CONNECTIVITY_SOCKS5_ABORTED",
        "Connectivity SOCKS5 setup was aborted",
      );
    }
    throw new ConnectivitySocks5Error(
      "CONNECTIVITY_SOCKS5_CONNECT_FAILED",
      "Connectivity SOCKS5 proxy connector failed",
    );
  }
  if (signal?.aborted === true) {
    try { socket.destroy(); } catch { /* best effort */ }
    throw new ConnectivitySocks5Error(
      "CONNECTIVITY_SOCKS5_ABORTED",
      "Connectivity SOCKS5 setup was aborted",
    );
  }
  return establishConnectivitySocks5Tunnel(
    socket,
    config,
    signal,
    scheduler,
  );
}
