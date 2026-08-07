import {
  NiSocketTransport,
  type NiConnectedSocket,
  type NiSocketConnectOptions,
} from "./ni-socket.js";
import {
  assertSapRouterRoutePrefix,
  completeSapRouterRoute,
  type AdmittedSapRouterRoute,
} from "./saprouter-route.js";
import {
  connectSapRouterRoute,
  type EstablishedSapRouterRoute,
  type SapRouterConnectOptions,
} from "./saprouter-tunnel.js";

const DEFAULT_ROUTE_TIMEOUT_MS = 10_000;

export type SapRouterRouteConnector = (
  route: AdmittedSapRouterRoute,
  options: SapRouterConnectOptions,
  signal?: AbortSignal,
) => Promise<EstablishedSapRouterRoute>;

export interface SapRouterNiDependencies {
  readonly connectRoute?: SapRouterRouteConnector;
}

function connectedSocket(value: EstablishedSapRouterRoute["socket"]): NiConnectedSocket {
  // NiSocketTransport.adopt performs the authoritative structural validation
  // and destroys invalid streams after ownership transfer.
  return value as unknown as NiConnectedSocket;
}

/**
 * Create one NI transport factory for an admitted SAProuter route. Every
 * invocation negotiates a fresh route for exactly one target connection; no
 * routed stream is shared or replayed. The compatibility name is retained
 * because direct CPIC was the first consumer, but Message Server NI uses the
 * same framing and ownership boundary.
 */
export function createSapRouterDirectCpicTransportFactory(
  routePrefix: string,
  dependencies: SapRouterNiDependencies = {},
): (
  options: NiSocketConnectOptions,
  signal?: AbortSignal,
) => Promise<NiSocketTransport> {
  assertSapRouterRoutePrefix(routePrefix);
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new TypeError("SAProuter NI dependencies must be an object");
  }
  const connectRoute = dependencies.connectRoute ?? connectSapRouterRoute;
  if (typeof connectRoute !== "function") {
    throw new TypeError("SAProuter route connector must be a function");
  }

  return async (options, signal): Promise<NiSocketTransport> => {
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    const route = completeSapRouterRoute(
      routePrefix,
      options.host,
      options.port,
    );
    let socket: EstablishedSapRouterRoute["socket"] | undefined;
    let initialData: Buffer | undefined;
    try {
      const established = await Reflect.apply(connectRoute, undefined, [
        route,
        Object.freeze({
          connectTimeoutMs: timeoutMs,
          handshakeTimeoutMs: timeoutMs,
          family: options.family,
          noDelay: options.noDelay ?? true,
        } satisfies SapRouterConnectOptions),
        signal,
      ]) as EstablishedSapRouterRoute;
      if (typeof established !== "object" || established === null) {
        throw new TypeError("SAProuter route connector must return a route");
      }
      socket = established.socket;
      if (!Buffer.isBuffer(established.initialData)) {
        throw new TypeError(
          "SAProuter route connector must return buffered initialData",
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
      try {
        socket?.destroy();
      } catch {
        // The handoff failure remains authoritative.
      }
      throw error;
    }
  };
}
