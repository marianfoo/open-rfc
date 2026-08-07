import { readFile } from "node:fs/promises";

import {
  decodeMessageServerLoginResponse,
  decodeMessageServerRfcGroupResponse,
  encodeMessageServerLoginRequest,
  encodeMessageServerLogoutRequest,
  encodeMessageServerRfcGroupRequest,
  MAX_MESSAGE_SERVER_PAYLOAD_LENGTH,
  type MessageServerRfcGroupTarget,
} from "../protocol/message-server.js";
import {
  NiSocketTransport,
  NiTransportError,
  type NiReceiveOptions,
  type NiSocketConnectOptions,
} from "./ni-socket.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 0x7fff_ffff;
const MAX_SERVICES_FILE_BYTES = 1024 * 1024;
const MAX_SERVICES_FILE_LINES = 100_000;
const MAX_SERVICES_LINE_BYTES = 4_096;

export type MessageServerResolutionErrorCode =
  | "MS_SERVICE_AMBIGUOUS"
  | "MS_SERVICE_NOT_FOUND"
  | "MS_SERVICE_TABLE_INVALID";

export class MessageServerResolutionError extends Error {
  readonly code: MessageServerResolutionErrorCode;
  override readonly cause: unknown;

  constructor(
    code: MessageServerResolutionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "MessageServerResolutionError";
    this.code = code;
    this.cause = cause;
  }
}

export interface MessageServerTransport {
  send(payload: Uint8Array, signal?: AbortSignal): Promise<void>;
  receive(options?: NiReceiveOptions): Promise<Buffer>;
  close(): Promise<void>;
}

export type MessageServerTransportFactory = (
  options: NiSocketConnectOptions,
  signal?: AbortSignal,
) => Promise<MessageServerTransport>;

export type MessageServerServicePortResolver = (
  service: string,
  signal?: AbortSignal,
) => Promise<number>;

export interface MessageServerRfcGroupResolverOptions {
  readonly messageServerHost: string;
  /** Decimal port or an /etc/services TCP name such as sapmsTST. */
  readonly messageServerService?: string | number;
  /** R3NAME/SYSID; used to derive sapms<SID> when MSSERV is omitted. */
  readonly systemId: string;
  readonly group: string;
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly servicePortResolver?: MessageServerServicePortResolver;
  readonly transportFactory?: MessageServerTransportFactory;
}

function validateTimeout(value: number, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(`${field} must be an integer in 1..${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function validateHost(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]{1,255}$/u.test(value)
  ) {
    throw new RangeError(
      "messageServerHost must contain 1..255 non-space printable ASCII bytes",
    );
  }
  return value;
}

function validateSystemId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{3}$/u.test(value)) {
    throw new RangeError(
      "systemId must be a three-character alphanumeric SAP system ID",
    );
  }
  return value;
}

function validateServiceName(value: string): string {
  if (!/^[\x21-\x7e]{1,64}$/u.test(value) || value.includes("/")) {
    throw new RangeError(
      "messageServerService must be a TCP port or 1..64-byte service name",
    );
  }
  return value;
}

function validatePort(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff) {
    throw new RangeError(`${field} must be an integer in 1..65535`);
  }
  return value;
}

function abortError(signal: AbortSignal): NiTransportError {
  return new NiTransportError(
    "NI_ABORTED",
    "message-server RFC-group resolution was aborted",
    signal.reason,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

/**
 * Parse one bounded services table without consulting DNS or opening sockets.
 * Conflicting declarations are rejected rather than depending on file order.
 */
export function parseTcpServicePort(
  servicesText: string,
  service: string,
): number | undefined {
  if (typeof servicesText !== "string") {
    throw new TypeError("servicesText must be a string");
  }
  const byteLength = Buffer.byteLength(servicesText, "utf8");
  if (byteLength > MAX_SERVICES_FILE_BYTES) {
    throw new MessageServerResolutionError(
      "MS_SERVICE_TABLE_INVALID",
      `services table exceeds ${MAX_SERVICES_FILE_BYTES} bytes`,
    );
  }
  if (servicesText.includes("\0")) {
    throw new MessageServerResolutionError(
      "MS_SERVICE_TABLE_INVALID",
      "services table contains a NUL byte",
    );
  }
  const name = validateServiceName(service);
  const lines = servicesText.split(/\r?\n/u);
  if (lines.length > MAX_SERVICES_FILE_LINES) {
    throw new MessageServerResolutionError(
      "MS_SERVICE_TABLE_INVALID",
      `services table exceeds ${MAX_SERVICES_FILE_LINES} lines`,
    );
  }

  let selected: number | undefined;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_SERVICES_LINE_BYTES) {
      throw new MessageServerResolutionError(
        "MS_SERVICE_TABLE_INVALID",
        `services table line exceeds ${MAX_SERVICES_LINE_BYTES} bytes`,
      );
    }
    const record = line.slice(0, line.indexOf("#") < 0 ? undefined : line.indexOf("#")).trim();
    if (record.length === 0) continue;
    const fields = record.split(/\s+/u);
    if (fields.length < 2) continue;
    const endpoint = /^(\d{1,5})\/([A-Za-z0-9]+)$/u.exec(fields[1]!);
    if (endpoint === null || endpoint[2]!.toLowerCase() !== "tcp") continue;
    if (![fields[0]!, ...fields.slice(2)].includes(name)) continue;
    const port = validatePort(Number.parseInt(endpoint[1]!, 10), "services TCP port");
    if (selected !== undefined && selected !== port) {
      throw new MessageServerResolutionError(
        "MS_SERVICE_AMBIGUOUS",
        `TCP service ${name} maps to conflicting ports ${selected} and ${port}`,
      );
    }
    selected = port;
  }
  return selected;
}

export async function defaultMessageServerServicePortResolver(
  service: string,
  signal?: AbortSignal,
): Promise<number> {
  const name = validateServiceName(service);
  throwIfAborted(signal);
  let bytes: Buffer;
  try {
    bytes = await readFile("/etc/services", { signal });
  } catch (error) {
    if (signal?.aborted === true) throw abortError(signal);
    throw new MessageServerResolutionError(
      "MS_SERVICE_TABLE_INVALID",
      "failed to read /etc/services for the message-server service",
      error,
    );
  }
  const port = parseTcpServicePort(bytes.toString("utf8"), name);
  if (port === undefined) {
    throw new MessageServerResolutionError(
      "MS_SERVICE_NOT_FOUND",
      `TCP service ${name} is not defined in /etc/services; provide a numeric msserv`,
    );
  }
  return port;
}

async function messageServerPort(
  service: string | number | undefined,
  systemId: string,
  resolver: MessageServerServicePortResolver,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (typeof service === "number") {
    return validatePort(service, "messageServerService");
  }
  const selected = service ?? `sapms${systemId}`;
  if (/^\d+$/u.test(selected)) {
    return validatePort(Number.parseInt(selected, 10), "messageServerService");
  }
  const name = validateServiceName(selected);
  try {
    const port = await Reflect.apply(resolver, undefined, [name, signal]);
    throwIfAborted(signal);
    return validatePort(port, `TCP service ${name}`);
  } catch (error) {
    if (signal?.aborted === true) throw abortError(signal);
    throw error;
  }
}

const defaultTransportFactory: MessageServerTransportFactory = (
  options,
  signal,
) => NiSocketTransport.connect(options, signal);

/**
 * Resolve one RFC logon group on one fresh Message Server connection.
 *
 * The exchange is intentionally one-shot: it never retries, fails over, or
 * replays after a write. The returned target is resolved before any direct
 * RFC owner or business-call session is created by a provider.
 */
export async function resolveMessageServerRfcGroup(
  options: MessageServerRfcGroupResolverOptions,
): Promise<MessageServerRfcGroupTarget> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("message-server resolver options must be an object");
  }
  const host = validateHost(options.messageServerHost);
  const systemId = validateSystemId(options.systemId);
  // Validate the wire-bound field before service lookup or network I/O.
  const groupRequest = encodeMessageServerRfcGroupRequest(options.group);
  const connectTimeoutMs = validateTimeout(
    options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    "connectTimeoutMs",
  );
  const operationTimeoutMs = validateTimeout(
    options.operationTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    "operationTimeoutMs",
  );
  const serviceResolver =
    options.servicePortResolver ?? defaultMessageServerServicePortResolver;
  const transportFactory = options.transportFactory ?? defaultTransportFactory;
  if (typeof serviceResolver !== "function") {
    throw new TypeError("servicePortResolver must be a function");
  }
  if (typeof transportFactory !== "function") {
    throw new TypeError("transportFactory must be a function");
  }
  throwIfAborted(options.signal);
  const port = await messageServerPort(
    options.messageServerService,
    systemId,
    serviceResolver,
    options.signal,
  );
  throwIfAborted(options.signal);

  let transport: MessageServerTransport | undefined;
  let loggedIn = false;
  let cleanupFailure: unknown;
  let resolved: MessageServerRfcGroupTarget | undefined;
  try {
    transport = await Reflect.apply(transportFactory, undefined, [{
      host,
      port,
      connectTimeoutMs,
      maxPayloadLength: MAX_MESSAGE_SERVER_PAYLOAD_LENGTH,
      writeTimeoutMs: operationTimeoutMs,
      noDelay: true,
    }, options.signal]);
    if (typeof transport !== "object" || transport === null) {
      throw new TypeError("transportFactory must return a transport object");
    }
    await transport.send(encodeMessageServerLoginRequest(), options.signal);
    const loginResponse = await transport.receive({
      timeoutMs: operationTimeoutMs,
      signal: options.signal,
    });
    decodeMessageServerLoginResponse(loginResponse);
    loggedIn = true;

    await transport.send(groupRequest, options.signal);
    const groupResponse = await transport.receive({
      timeoutMs: operationTimeoutMs,
      signal: options.signal,
    });
    resolved = decodeMessageServerRfcGroupResponse(groupResponse, options.group);
  } finally {
    if (transport !== undefined) {
      if (loggedIn) {
        try {
          await transport.send(encodeMessageServerLogoutRequest());
        } catch (logoutError) {
          cleanupFailure = logoutError;
        }
      }
      try {
        await transport.close();
      } catch (closeError) {
        cleanupFailure ??= closeError;
      }
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (resolved === undefined) {
    throw new Error("message-server resolver completed without a selected server");
  }
  return resolved;
}
