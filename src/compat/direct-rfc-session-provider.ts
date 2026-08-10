import {
  classifyDirectDestinationTransactionFailure,
  createDirectDestinationTransactionAdapter,
  type DirectDestinationOwner,
} from "../destination/direct-destination-owner.js";
import {
  TransactionRuntime,
  type TransactionToken,
} from "../lifecycle/transaction-runtime.js";
import {
  languageSapToIso,
  type NormalizedDirectConnection,
} from "./connection-parameters.js";
import {
  normalizedDirectConnectionFromPlan,
  type ConnectivitySocks5Plan,
  type ConnectionRoutePlan,
} from "./connection-route.js";
import type { RFCClientDestinationOwnerFactory } from "./rfc-client-owner-registry.js";
import type { DirectCpicTransportFactory } from "../client/direct-cpic-session.js";
import type {
  RfcSession,
  RfcSessionProvider,
  RfcSessionTransaction,
} from "./rfc-session-provider.js";
import { MetadataAccessFailure } from "../metadata/repository-runtime.js";

export interface DirectRfcSessionProviderOptions {
  readonly ownerFactory: RFCClientDestinationOwnerFactory;
  readonly operationTimeoutMs: number;
  /** Present only when a real SAProuter NI_ROUTE transport is composed. */
  readonly sapRouterTransportFactory?: (
    routeString: string,
  ) => DirectCpicTransportFactory;
  /** Present only when a real BTP Connectivity SOCKS5 transport is composed. */
  readonly connectivitySocks5TransportFactory?: (
    plan: ConnectivitySocks5Plan,
  ) => DirectCpicTransportFactory;
}

function directConnection(
  plan: ConnectionRoutePlan,
  sapRouterSupported: boolean,
  connectivitySocks5Supported: boolean,
): NormalizedDirectConnection {
  if (plan.route.kind !== "direct") {
    throw new TypeError("direct RFC session provider requires a direct route");
  }
  if (plan.authentication.kind !== "named-user") {
    throw new TypeError(
      "direct RFC session provider requires named-user authentication",
    );
  }
  if (plan.sapRouter !== undefined && plan.connectivitySocks5 !== undefined) {
    throw new TypeError(
      "direct RFC session provider cannot combine SAProuter and Connectivity SOCKS5",
    );
  }
  if (plan.sapRouter !== undefined && !sapRouterSupported) {
    throw new TypeError(
      "direct RFC session provider does not implement SAProuter",
    );
  }
  if (plan.connectivityProxy !== undefined) {
    throw new TypeError(
      "direct RFC session provider does not implement Connectivity",
    );
  }
  if (plan.connectivitySocks5 !== undefined && !connectivitySocks5Supported) {
    throw new TypeError(
      "direct RFC session provider does not implement Connectivity SOCKS5",
    );
  }
  return normalizedDirectConnectionFromPlan(plan);
}

function safeConnectionInfo(
  connection: NormalizedDirectConnection,
): Readonly<Record<string, string>> {
  return Object.freeze({
    dest: "",
    host: connection.host,
    partnerHost: connection.host,
    sysNumber: connection.sysnr,
    sysId: "",
    client: connection.client,
    user: connection.user,
    language: connection.language,
    trace: "0",
    isoLanguage: languageSapToIso(connection.language),
    codepage: "4103",
    partnerCodepage: "4103",
    rfcRole: "C",
    type: "3",
    partnerType: "3",
    rel: "",
    partnerRel: "",
    kernelRel: "",
    cpicConvId: "",
    progName: "open-rfc",
    partnerBytesPerChar: "2",
    partnerSystemCodepage: "4103",
    partnerIP: connection.host,
    partnerIPv6: "",
  });
}

function directTransaction(
  owner: DirectDestinationOwner,
  operationTimeoutMs: number,
): RfcSessionTransaction {
  const runtime = new TransactionRuntime({
    leases: createDirectDestinationTransactionAdapter(owner),
    operationTimeoutMs,
    classifyFailure: classifyDirectDestinationTransactionFailure,
  });
  let token: TransactionToken | undefined;
  const opening = runtime.begin().then((openedToken) => {
    token = openedToken;
  });
  function openedToken(): TransactionToken {
    if (token === undefined) {
      throw new Error("RFC transaction lease has not finished opening");
    }
    return token;
  }
  const transaction: RfcSessionTransaction = {
    ready() {
      return opening;
    },
    call(functionName, parameters, options) {
      return runtime.call(openedToken(), functionName, parameters, options);
    },
    commit() {
      return runtime.commit(openedToken());
    },
    rollback() {
      return runtime.rollback(openedToken());
    },
    close() {
      return runtime.close();
    },
    isTerminal() {
      const monitor = runtime.monitor();
      return monitor.state === "closed" ||
        monitor.state === "failed" ||
        monitor.outcome === "ambiguous" ||
        monitor.outcome === "rejected";
    },
  };
  return Object.freeze(transaction);
}

function directSession(
  owner: DirectDestinationOwner,
  connection: NormalizedDirectConnection,
  operationTimeoutMs: number,
): RfcSession {
  const recursiveMetadata = owner.getRecursiveFunctionMetadata;
  const session: RfcSession = {
    connectionInfo: safeConnectionInfo(connection),
    beginTransaction() {
      return directTransaction(owner, operationTimeoutMs);
    },
    getFunctionInterface(functionName, signal) {
      return owner.getFunctionInterface(functionName, signal);
    },
    getStructureDefinition(structureName, signal) {
      return owner.getStructureDefinition(structureName, signal);
    },
    getRecursiveFunctionMetadata(functionName, signal) {
      if (typeof recursiveMetadata !== "function") {
        return Promise.reject(new MetadataAccessFailure(
          "unavailable",
          "destination owner does not implement recursive optimized metadata",
        ));
      }
      return Reflect.apply(recursiveMetadata, owner, [functionName, signal]);
    },
    close() {
      return owner.retire();
    },
  };
  return Object.freeze(session);
}

/**
 * Adapt the implemented direct/classic owner into the route-neutral session
 * boundary. SAProuter is advertised only when a concrete transport factory is
 * supplied; advanced authentication and Connectivity remain unavailable.
 */
export function createDirectRfcSessionProvider(
  options: DirectRfcSessionProviderOptions,
): RfcSessionProvider {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("direct RFC session provider options must be an object");
  }
  if (typeof options.ownerFactory !== "function") {
    throw new TypeError(
      "direct RFC session provider ownerFactory must be a function",
    );
  }
  if (
    !Number.isSafeInteger(options.operationTimeoutMs) ||
    options.operationTimeoutMs < 1
  ) {
    throw new RangeError(
      "direct RFC session provider operationTimeoutMs must be a positive integer",
    );
  }
  const ownerFactory = options.ownerFactory;
  const operationTimeoutMs = options.operationTimeoutMs;
  const sapRouterTransportFactory = options.sapRouterTransportFactory;
  const connectivitySocks5TransportFactory =
    options.connectivitySocks5TransportFactory;
  if (
    sapRouterTransportFactory !== undefined &&
    typeof sapRouterTransportFactory !== "function"
  ) {
    throw new TypeError(
      "direct RFC session provider sapRouterTransportFactory must be a function",
    );
  }
  if (
    connectivitySocks5TransportFactory !== undefined &&
    typeof connectivitySocks5TransportFactory !== "function"
  ) {
    throw new TypeError(
      "direct RFC session provider connectivitySocks5TransportFactory must be a function",
    );
  }
  const provider: RfcSessionProvider = {
    capabilities: Object.freeze([
      "direct-rfc-transport",
      "named-user-authentication",
      ...(sapRouterTransportFactory === undefined
        ? []
        : ["saprouter-routing"] as const),
      ...(connectivitySocks5TransportFactory === undefined
        ? []
        : ["connectivity-socks5-tcp"] as const),
    ]),
    async open(plan) {
      const connection = directConnection(
        plan,
        sapRouterTransportFactory !== undefined,
        connectivitySocks5TransportFactory !== undefined,
      );
      let transportFactory: DirectCpicTransportFactory | undefined;
      if (plan.sapRouter !== undefined) {
        transportFactory = Reflect.apply(
          sapRouterTransportFactory!,
          undefined,
          [plan.sapRouter.routeString],
        ) as DirectCpicTransportFactory;
        if (typeof transportFactory !== "function") {
          throw new TypeError(
            "sapRouterTransportFactory must return a transport function",
          );
        }
      }
      if (plan.connectivitySocks5 !== undefined) {
        transportFactory = Reflect.apply(
          connectivitySocks5TransportFactory!,
          undefined,
          [plan.connectivitySocks5],
        ) as DirectCpicTransportFactory;
        if (typeof transportFactory !== "function") {
          throw new TypeError(
            "connectivitySocks5TransportFactory must return a transport function",
          );
        }
      }
      const owner = await Reflect.apply(ownerFactory, undefined, [
        connection,
        transportFactory === undefined
          ? undefined
          : Object.freeze({
              session: Object.freeze({ transportFactory }),
            }),
      ]);
      if (typeof owner !== "object" || owner === null) {
        throw new TypeError("destination owner factory must return an object");
      }
      return directSession(owner, connection, operationTimeoutMs);
    },
  };
  return Object.freeze(provider);
}
