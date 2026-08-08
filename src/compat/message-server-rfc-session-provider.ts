import type { MessageServerRfcGroupTarget } from "../protocol/message-server.js";
import {
  RfcCoreError,
  RfcFailureCategory,
} from "../client/rfc-failure.js";
import { TransactionRuntimeError } from "../lifecycle/transaction-runtime.js";
import {
  resolveMessageServerRfcGroup,
  type MessageServerRfcGroupResolverOptions,
  type MessageServerTransportFactory,
} from "../transport/message-server-resolver.js";
import { NiTransportError } from "../transport/ni-socket.js";
import {
  SapRouterTransportError,
  type SapRouterTransportErrorCode,
} from "../transport/saprouter-tunnel.js";
import type {
  ConnectionProviderCapability,
  ConnectionRoutePlan,
  DirectConnectionRoute,
  MessageServerConnectionRoute,
} from "./connection-route.js";
import type {
  RfcSession,
  RfcSessionCallOptions,
  RfcSessionProvider,
  RfcSessionTransaction,
} from "./rfc-session-provider.js";

export type MessageServerGroupResolver = (
  options: MessageServerRfcGroupResolverOptions,
) => Promise<MessageServerRfcGroupTarget>;

export interface MessageServerRfcSessionProviderOptions {
  readonly directProvider: RfcSessionProvider;
  readonly resolveGroup?: MessageServerGroupResolver;
  /**
   * Complete the validated SAProuter prefix with the message-server endpoint.
   * The direct provider remains responsible for routing the selected gateway.
   */
  readonly sapRouterTransportFactory?: (
    routeString: string,
  ) => MessageServerTransportFactory;
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  /** Total lookup/redirect attempts. Kept deliberately small and finite. */
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_MAX_ATTEMPTS = 4;

const UNSUPPORTED_WRAPPED_CAPABILITIES = new Set<ConnectionProviderCapability>([
  "connectivity-proxy-authorization",
  "connectivity-rfc-proxy",
  "message-server-saprouter-routing",
  "principal-propagation",
  "websocket-rfc-transport",
]);

const RETRYABLE_SAPROUTER_FAILURES: ReadonlySet<SapRouterTransportErrorCode> =
  new Set([
    "SAPROUTER_CONNECT_FAILED",
    "SAPROUTER_CONNECT_TIMEOUT",
    "SAPROUTER_CONNECTION_CLOSED",
    "SAPROUTER_HANDSHAKE_TIMEOUT",
    "SAPROUTER_WRITE_FAILED",
  ]);

function validateOptionalTimeout(value: number | undefined, field: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff)
  ) {
    throw new RangeError(`${field} must be an integer in 1..2147483647`);
  }
}

export function snapshotMessageServerMaxAttempts(
  value: number | undefined,
): number {
  const selected = value ?? DEFAULT_MAX_ATTEMPTS;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MAX_MAX_ATTEMPTS
  ) {
    throw new RangeError(
      `maxAttempts must be an integer in 1..${MAX_MAX_ATTEMPTS}`,
    );
  }
  return selected;
}

function validateSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("message-server open signal must be an AbortSignal");
  }
}

function aborted(signal: AbortSignal): NiTransportError {
  return new NiTransportError(
    "NI_ABORTED",
    "message-server RFC open was aborted",
    signal.reason,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw aborted(signal);
}

export function isRetryableMessageServerOpenFailure(input: unknown): boolean {
  let failure = input;
  const visited = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (failure instanceof NiTransportError) {
      return failure.code === "NI_CONNECT_FAILED" ||
        failure.code === "NI_CONNECT_TIMEOUT" ||
        failure.code === "NI_CONNECTION_CLOSED" ||
        failure.code === "NI_RECEIVE_TIMEOUT" ||
        failure.code === "NI_WRITE_FAILED";
    }
    if (failure instanceof SapRouterTransportError) {
      return RETRYABLE_SAPROUTER_FAILURES.has(failure.code);
    }
    if (failure instanceof RfcCoreError) {
      return failure.failure.category === RfcFailureCategory.Communication ||
        failure.failure.category === RfcFailureCategory.Timeout;
    }
    if (failure instanceof TransactionRuntimeError) {
      return failure.code === "OPERATION_TIMEOUT";
    }
    if (
      !(failure instanceof AggregateError) ||
      visited.has(failure)
    ) {
      return false;
    }
    visited.add(failure);
    const cause = Object.getOwnPropertyDescriptor(failure, "cause");
    if (cause === undefined || !("value" in cause) || cause.value === failure) {
      return false;
    }
    failure = cause.value;
  }
  return false;
}

async function readyWithSignal(
  transaction: RfcSessionTransaction,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await transaction.ready();
    return;
  }
  throwIfAborted(signal);
  let rejectAbort!: (error: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(aborted(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([
      Promise.resolve().then(() => transaction.ready()),
      abortPromise,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function closeBeforeFailover(
  transaction: RfcSessionTransaction,
  session: RfcSession,
  primary: unknown,
): Promise<void> {
  const failures: unknown[] = [primary];
  try {
    await transaction.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await session.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "message-server redirect failed and session cleanup did not converge",
      { cause: primary },
    );
  }
}

function providerCapabilities(
  directProvider: RfcSessionProvider,
  supportsRoutedMessageServer: boolean,
): readonly ConnectionProviderCapability[] {
  const capabilities = new Set<ConnectionProviderCapability>();
  for (const capability of directProvider.capabilities) {
    if (!UNSUPPORTED_WRAPPED_CAPABILITIES.has(capability)) {
      capabilities.add(capability);
    }
  }
  if (!capabilities.has("direct-rfc-transport")) {
    throw new TypeError(
      "message-server provider requires a direct-rfc-transport provider",
    );
  }
  capabilities.add("message-server-rfc-transport");
  if (supportsRoutedMessageServer) {
    capabilities.add("message-server-saprouter-routing");
  }
  return Object.freeze([...capabilities]);
}

export function messageServerTargetDirectRoute(
  target: MessageServerRfcGroupTarget,
): DirectConnectionRoute {
  if (
    typeof target !== "object" ||
    target === null ||
    typeof target.applicationServerHost !== "string" ||
    !/^[\x21-\x7e]{1,64}$/u.test(target.applicationServerHost)
  ) {
    throw new TypeError(
      "message-server resolver returned an invalid application-server host",
    );
  }
  if (!/^\d{2}$/u.test(target.systemNumber)) {
    throw new TypeError(
      "message-server resolver returned an invalid system number",
    );
  }
  const instance = Number.parseInt(target.systemNumber, 10);
  // The resolver is caller-injectable, so this stays a strict trust boundary.
  // It asserts the sapdpNN/sapgwNN block rule rather than the default 3200/3300
  // offset, which an offset landscape does not follow.
  if (
    !Number.isSafeInteger(target.dispatcherPort) ||
    target.dispatcherPort < 1 ||
    target.dispatcherPort % 100 !== instance ||
    target.gatewayPort !== target.dispatcherPort + 100 ||
    target.gatewayPort > 0xffff ||
    target.gatewayService !== `sapgw${target.systemNumber}`
  ) {
    throw new TypeError(
      "message-server resolver returned an inconsistent application-server route",
    );
  }
  return Object.freeze({
    kind: "direct",
    host: target.applicationServerHost,
    applicationServerHost: target.applicationServerHost,
    port: target.gatewayPort,
    applicationServerService: `sapdp${target.systemNumber}`,
    sysnr: target.systemNumber,
    cpicStreaming: "disabled",
  });
}

function delegatedPlan(
  source: ConnectionRoutePlan,
  route: DirectConnectionRoute,
): ConnectionRoutePlan {
  const required = new Set<ConnectionProviderCapability>();
  for (const capability of source.requiredProviderCapabilities) {
    if (capability === "message-server-saprouter-routing") continue;
    required.add(
      capability === "message-server-rfc-transport"
        ? "direct-rfc-transport"
        : capability,
    );
  }
  return Object.freeze({
    route,
    logon: source.logon,
    authentication: source.authentication,
    ...(source.sapRouter === undefined ? {} : { sapRouter: source.sapRouter }),
    requiredProviderCapabilities: Object.freeze([...required]),
  });
}

function resolverOptions(
  route: MessageServerConnectionRoute,
  options: MessageServerRfcSessionProviderOptions,
  signal: AbortSignal | undefined,
  transportFactory: MessageServerTransportFactory | undefined,
): MessageServerRfcGroupResolverOptions {
  return Object.freeze({
    messageServerHost: route.messageServerHost,
    ...(route.messageServerService === undefined
      ? {}
      : { messageServerService: route.messageServerService }),
    systemId: route.systemId,
    group: route.group,
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(transportFactory === undefined ? {} : { transportFactory }),
    signal,
  });
}

interface OpenAttemptState {
  attempts: number;
}

function loadBalancedSession(
  initialSession: RfcSession,
  state: OpenAttemptState,
  maxAttempts: number,
  signal: AbortSignal | undefined,
  openNext: (priorFailures?: readonly unknown[]) => Promise<RfcSession>,
): RfcSession {
  let current = initialSession;
  let initialReadySucceeded = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const wrapped: RfcSession = {
    // The selected redirect can change only during the bounded pre-call ready
    // failover. Expose the immutable identity of the session that actually
    // owns subsequent metadata and application calls.
    get connectionInfo() { return current.connectionInfo; },
    beginTransaction(): RfcSessionTransaction {
      if (closed) {
        throw new Error("message-server RFC session is closed");
      }
      let owningSession = current;
      let delegate = owningSession.beginTransaction();
      let readyPromise: Promise<void> | undefined;
      let transactionClose: Promise<void> | undefined;
      const eligibleForFailover = !initialReadySucceeded;
      const transaction: RfcSessionTransaction = {
        ready() {
          if (readyPromise === undefined) {
            readyPromise = (async () => {
              try {
                await readyWithSignal(
                  delegate,
                  eligibleForFailover ? signal : undefined,
                );
                initialReadySucceeded = true;
              } catch (primary) {
                if (
                  !eligibleForFailover ||
                  !isRetryableMessageServerOpenFailure(primary) ||
                  state.attempts >= maxAttempts ||
                  signal?.aborted === true
                ) {
                  throw primary;
                }
                await closeBeforeFailover(delegate, owningSession, primary);
                owningSession = await openNext([primary]);
                current = owningSession;
                delegate = owningSession.beginTransaction();
                await readyWithSignal(delegate, signal);
                initialReadySucceeded = true;
              }
            })();
          }
          return readyPromise;
        },
        call(
          functionName: string,
          parameters: Readonly<Record<string, unknown>>,
          callOptions: RfcSessionCallOptions,
        ) {
          return delegate.call(functionName, parameters, callOptions);
        },
        commit() { return delegate.commit(); },
        rollback() { return delegate.rollback(); },
        close() {
          transactionClose ??= Promise.resolve().then(() => delegate.close());
          return transactionClose;
        },
        isTerminal() { return delegate.isTerminal(); },
      };
      return Object.freeze(transaction);
    },
    getFunctionInterface(functionName, operationSignal) {
      return current.getFunctionInterface(functionName, operationSignal);
    },
    getStructureDefinition(structureName, operationSignal) {
      return current.getStructureDefinition(structureName, operationSignal);
    },
    ...(initialSession.getRecursiveFunctionMetadata === undefined
      ? {}
      : {
          getRecursiveFunctionMetadata(functionName, operationSignal) {
            const recursive = current.getRecursiveFunctionMetadata;
            if (recursive === undefined) {
              throw new Error(
                "redirected RFC session does not implement recursive metadata",
              );
            }
            return Reflect.apply(recursive, current, [
              functionName,
              operationSignal,
            ]);
          },
        }),
    close() {
      closed = true;
      closePromise ??= Promise.resolve().then(() => current.close());
      return closePromise;
    },
  };
  return Object.freeze(wrapped);
}

/**
 * Add RFC logon-group routing in front of an existing direct provider.
 * Resolution completes before `directProvider.open`, so no direct owner or
 * business-call session exists while Message Server input is still untrusted.
 */
export function createMessageServerRfcSessionProvider(
  options: MessageServerRfcSessionProviderOptions,
): RfcSessionProvider {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("message-server provider options must be an object");
  }
  if (
    typeof options.directProvider !== "object" ||
    options.directProvider === null ||
    typeof options.directProvider.open !== "function" ||
    !Array.isArray(options.directProvider.capabilities)
  ) {
    throw new TypeError("directProvider must be an RFC session provider");
  }
  const directProvider = options.directProvider;
  const resolveGroup = options.resolveGroup ?? resolveMessageServerRfcGroup;
  if (typeof resolveGroup !== "function") {
    throw new TypeError("resolveGroup must be a function");
  }
  const sapRouterTransportFactory = options.sapRouterTransportFactory;
  if (
    sapRouterTransportFactory !== undefined &&
    typeof sapRouterTransportFactory !== "function"
  ) {
    throw new TypeError("sapRouterTransportFactory must be a function");
  }
  if (
    sapRouterTransportFactory !== undefined &&
    !directProvider.capabilities.includes("saprouter-routing")
  ) {
    throw new TypeError(
      "message-server SAProuter routing requires a routed direct provider",
    );
  }
  validateOptionalTimeout(options.connectTimeoutMs, "connectTimeoutMs");
  validateOptionalTimeout(options.operationTimeoutMs, "operationTimeoutMs");
  const maxAttempts = snapshotMessageServerMaxAttempts(options.maxAttempts);
  const capabilities = providerCapabilities(
    directProvider,
    sapRouterTransportFactory !== undefined,
  );

  const provider: RfcSessionProvider = {
    capabilities,
    async open(plan, signal): Promise<RfcSession> {
      validateSignal(signal);
      throwIfAborted(signal);
      if (plan.route.kind === "direct") {
        return Reflect.apply(directProvider.open, directProvider, [plan, signal]);
      }
      if (plan.route.kind !== "message-server") {
        throw new TypeError(
          "message-server provider supports only direct and message-server routes",
        );
      }
      if (
        plan.connectivityProxy !== undefined ||
        plan.connectivitySocks5 !== undefined
      ) {
        throw new TypeError(
          "message-server resolution does not implement Connectivity",
        );
      }
      const messageRoute = plan.route;
      let lookupTransportFactory: MessageServerTransportFactory | undefined;
      if (plan.sapRouter !== undefined) {
        if (sapRouterTransportFactory === undefined) {
          throw new TypeError(
            "message-server provider does not implement message-server SAProuter routing",
          );
        }
        lookupTransportFactory = Reflect.apply(
          sapRouterTransportFactory,
          undefined,
          [plan.sapRouter.routeString],
        ) as MessageServerTransportFactory;
        if (typeof lookupTransportFactory !== "function") {
          throw new TypeError(
            "sapRouterTransportFactory must return a transport function",
          );
        }
      }
      const state: OpenAttemptState = { attempts: 0 };
      const openNext = async (
        priorFailures: readonly unknown[] = [],
      ): Promise<RfcSession> => {
        const failures = [...priorFailures];
        while (state.attempts < maxAttempts) {
          state.attempts += 1;
          try {
            throwIfAborted(signal);
            const target = await Reflect.apply(resolveGroup, undefined, [
              resolverOptions(
                messageRoute,
                options,
                signal,
                lookupTransportFactory,
              ),
            ]);
            throwIfAborted(signal);
            const route = messageServerTargetDirectRoute(target);
            return await Reflect.apply(directProvider.open, directProvider, [
              delegatedPlan(plan, route),
              signal,
            ]);
          } catch (error) {
            failures.push(error);
            if (
              !isRetryableMessageServerOpenFailure(error) ||
              state.attempts >= maxAttempts ||
              signal?.aborted === true
            ) {
              if (failures.length === 1) throw error;
              throw new AggregateError(
                failures,
                `message-server RFC open failed after ${state.attempts} bounded attempts`,
                { cause: error },
              );
            }
          }
        }
        throw new Error("message-server RFC open exhausted its attempt bound");
      };
      const initial = await openNext();
      return loadBalancedSession(
        initial,
        state,
        maxAttempts,
        signal,
        openNext,
      );
    },
  };
  return Object.freeze(provider);
}
