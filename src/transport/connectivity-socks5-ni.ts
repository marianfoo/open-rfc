import { types as nodeUtilTypes } from "node:util";

import type { DirectCpicTransportFactory } from "../client/direct-cpic-session.js";
import { NiSocketTransport, type NiConnectedSocket } from "./ni-socket.js";
import {
  admitConnectivitySocks5Config,
  connectConnectivitySocks5Tunnel,
  type AdmittedConnectivitySocks5Config,
  type ConnectivitySocks5Socket,
  type EstablishedConnectivitySocks5Tunnel,
} from "./connectivity-socks5-tunnel.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_PROXY_PROPERTIES = Object.freeze(new Set([
  "proxyHost",
  "proxyPort",
  "accessToken",
  "locationId",
  "timeoutMs",
  "maxBufferedBytes",
]));

export interface ConnectivitySocks5DirectCpicProxyInput {
  /** Connectivity binding host and `onpremise_socks5_proxy_port`. */
  readonly proxyHost: string;
  readonly proxyPort: number;
  /** Raw Connectivity access token, without `Bearer `. */
  readonly accessToken: string;
  readonly locationId?: string;
  /** Optional fixed per-phase timeout; otherwise the CPIC connect timeout wins. */
  readonly timeoutMs?: number;
  readonly maxBufferedBytes?: number;
}

export type ConnectivitySocks5TunnelConnector = (
  config: AdmittedConnectivitySocks5Config,
  signal?: AbortSignal,
) => Promise<EstablishedConnectivitySocks5Tunnel>;

export interface ConnectivitySocks5NiDependencies {
  readonly connectTunnel?: ConnectivitySocks5TunnelConnector;
}

interface FixedProxySnapshot {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly accessToken: string;
  readonly locationId: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly maxBufferedBytes: number;
}

function ownProxyValues(input: unknown): ReadonlyMap<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Connectivity SOCKS5 proxy options must be a plain object");
  }
  if (nodeUtilTypes.isProxy(input)) {
    throw new TypeError("Connectivity SOCKS5 proxy options must not be a Proxy");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Connectivity SOCKS5 proxy options must be a plain object");
  }
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw new TypeError("Connectivity SOCKS5 proxy options do not accept symbols");
    }
    if (!ALLOWED_PROXY_PROPERTIES.has(key)) {
      throw new TypeError(
        `Connectivity SOCKS5 proxy options have unsupported property ${key}`,
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

function snapshotProxy(input: ConnectivitySocks5DirectCpicProxyInput): FixedProxySnapshot {
  const values = ownProxyValues(input);
  const candidate: Record<string, unknown> = {
    proxyHost: values.get("proxyHost"),
    proxyPort: values.get("proxyPort"),
    targetHost: "validation.invalid",
    targetPort: 1,
    accessToken: values.get("accessToken"),
  };
  for (const optional of [
    "locationId",
    "timeoutMs",
    "maxBufferedBytes",
  ] as const) {
    if (values.has(optional)) candidate[optional] = values.get(optional);
  }
  const admitted = admitConnectivitySocks5Config(candidate);
  return Object.freeze({
    proxyHost: admitted.proxyHost,
    proxyPort: admitted.proxyPort,
    accessToken: admitted.accessToken,
    locationId: admitted.locationId,
    timeoutMs: values.has("timeoutMs") ? admitted.timeoutMs : undefined,
    maxBufferedBytes: admitted.maxBufferedBytes,
  });
}

function connectedSocket(socket: ConnectivitySocks5Socket): NiConnectedSocket {
  return socket as unknown as NiConnectedSocket;
}

/**
 * Route classic CPIC/NI through an explicitly configured Connectivity TCP
 * mapping. This intentionally does not consume the distinct RFC proxy port.
 */
export function createConnectivitySocks5DirectCpicTransportFactory(
  proxyInput: ConnectivitySocks5DirectCpicProxyInput,
  dependencies: ConnectivitySocks5NiDependencies = {},
): DirectCpicTransportFactory {
  const proxy = snapshotProxy(proxyInput);
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new TypeError("Connectivity SOCKS5 NI dependencies must be an object");
  }
  const connectTunnel = dependencies.connectTunnel ?? connectConnectivitySocks5Tunnel;
  if (typeof connectTunnel !== "function") {
    throw new TypeError("Connectivity SOCKS5 tunnel connector must be a function");
  }

  return async (options, signal): Promise<NiSocketTransport> => {
    const config = admitConnectivitySocks5Config({
      proxyHost: proxy.proxyHost,
      proxyPort: proxy.proxyPort,
      targetHost: options.host,
      targetPort: options.port,
      accessToken: proxy.accessToken,
      ...(proxy.locationId === undefined ? {} : { locationId: proxy.locationId }),
      timeoutMs: proxy.timeoutMs ?? options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBufferedBytes: proxy.maxBufferedBytes,
    });
    let socket: ConnectivitySocks5Socket | undefined;
    let initialData: Buffer | undefined;
    try {
      const established = await Reflect.apply(connectTunnel, undefined, [
        config,
        signal,
      ]) as EstablishedConnectivitySocks5Tunnel;
      if (typeof established !== "object" || established === null) {
        throw new TypeError(
          "Connectivity SOCKS5 tunnel connector must return a tunnel",
        );
      }
      socket = established.socket;
      if (!Buffer.isBuffer(established.initialData)) {
        throw new TypeError(
          "Connectivity SOCKS5 tunnel connector must return buffered initialData",
        );
      }
      initialData = established.initialData;
      const transport = NiSocketTransport.adopt({
        socket: connectedSocket(socket),
        initialData,
        maxPayloadLength: options.maxPayloadLength,
        maxQueuedPayloadLength: options.maxQueuedPayloadLength,
        maxQueuedFrameCount: options.maxQueuedFrameCount,
        writeTimeoutMs: options.writeTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
      }, signal);
      initialData.fill(0);
      return transport;
    } catch (error) {
      initialData?.fill(0);
      try { socket?.destroy(); } catch { /* handoff failure wins */ }
      throw error;
    }
  };
}
