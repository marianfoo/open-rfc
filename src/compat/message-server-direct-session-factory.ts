import type { DirectCpicSession } from "../client/direct-cpic-session.js";
import {
  createProductionDirectDestinationSessionFactory,
  type DirectDestinationSessionFactory,
  type DirectDestinationSessionOpenResult,
  type DirectDestinationSessionOpenContext,
  type DirectDestinationSessionOptions,
} from "../destination/direct-destination-owner.js";
import {
  resolveMessageServerRfcGroup,
  type MessageServerRfcGroupResolverOptions,
} from "../transport/message-server-resolver.js";
import { NiTransportError } from "../transport/ni-socket.js";
import type { NormalizedDirectConnection } from "./connection-parameters.js";
import type { ConnectionRoutePlan } from "./connection-route.js";
import {
  isRetryableMessageServerOpenFailure,
  messageServerTargetDirectRoute,
  snapshotMessageServerMaxAttempts,
  type MessageServerGroupResolver,
} from "./message-server-rfc-session-provider.js";

export interface MessageServerDirectSessionFactoryOptions {
  readonly plan: ConnectionRoutePlan;
  readonly resolveGroup?: MessageServerGroupResolver;
  readonly directSessionFactory?: DirectDestinationSessionFactory;
  readonly directSession?: DirectDestinationSessionOptions;
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly maxAttempts?: number;
}

function messagePlan(options: MessageServerDirectSessionFactoryOptions): void {
  if (options.plan.route.kind !== "message-server") {
    throw new TypeError("message-server session factory requires a message-server route");
  }
  if (options.plan.authentication.kind === "principal-propagation") {
    throw new TypeError("message-server session factory requires user authentication");
  }
  if (
    options.plan.sapRouter !== undefined ||
    options.plan.connectivityProxy !== undefined ||
    options.plan.connectivitySocks5 !== undefined
  ) {
    throw new TypeError(
      "message-server session factory does not implement SAProuter or Connectivity",
    );
  }
}

function canceled(signal: AbortSignal): NiTransportError {
  return new NiTransportError(
    "NI_ABORTED",
    "message-server physical session open was aborted",
    signal.reason,
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw canceled(signal);
}

function resolverOptions(
  options: MessageServerDirectSessionFactoryOptions,
  context: DirectDestinationSessionOpenContext,
): MessageServerRfcGroupResolverOptions {
  const route = options.plan.route;
  if (route.kind !== "message-server") {
    throw new TypeError("message-server route changed after validation");
  }
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
    signal: context.signal,
  });
}

function targetConnection(
  plan: ConnectionRoutePlan,
  target: ReturnType<typeof messageServerTargetDirectRoute>,
): NormalizedDirectConnection {
  if (plan.authentication.kind === "principal-propagation") {
    throw new TypeError("message-server target requires user authentication");
  }
  return Object.freeze({
    host: target.host,
    applicationServerHost: target.applicationServerHost,
    port: target.port,
    applicationServerService: target.applicationServerService,
    client: plan.logon.client,
    user: plan.authentication.user,
    ...(plan.authentication.kind === "logon-ticket"
      ? { ticket: plan.authentication.ticket }
      : { password: plan.authentication.password }),
    language: plan.logon.language,
    sysnr: target.sysnr,
    cpicStreaming: target.cpicStreaming,
  });
}

/**
 * Stable owner identity used before a Message Server has selected a target.
 * The endpoint fields are never used for transport I/O; the session factory
 * below resolves a fresh direct target for every physical pool connection.
 */
export function messageServerOwnerConnection(
  plan: ConnectionRoutePlan,
): NormalizedDirectConnection {
  if (plan.route.kind !== "message-server") {
    throw new TypeError("message-server owner connection requires a message-server route");
  }
  if (plan.authentication.kind === "principal-propagation") {
    throw new TypeError("message-server owner connection requires user authentication");
  }
  return Object.freeze({
    host: plan.route.messageServerHost,
    applicationServerHost: plan.route.messageServerHost,
    port: 1,
    applicationServerService: "sapdp00",
    client: plan.logon.client,
    user: plan.authentication.user,
    ...(plan.authentication.kind === "logon-ticket"
      ? { ticket: plan.authentication.ticket }
      : { password: plan.authentication.password }),
    language: plan.logon.language,
    sysnr: "00",
    cpicStreaming: "disabled",
  });
}

/** Resolve and authenticate each physical destination session independently. */
export function createMessageServerDirectSessionFactory(
  options: MessageServerDirectSessionFactoryOptions,
): DirectDestinationSessionFactory {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("message-server session factory options must be an object");
  }
  messagePlan(options);
  const maxAttempts = snapshotMessageServerMaxAttempts(options.maxAttempts);
  const resolveGroup = options.resolveGroup ?? resolveMessageServerRfcGroup;
  const directFactory = options.directSessionFactory ??
    createProductionDirectDestinationSessionFactory(options.directSession);
  if (typeof resolveGroup !== "function") {
    throw new TypeError("resolveGroup must be a function");
  }
  if (
    typeof directFactory !== "object" ||
    directFactory === null ||
    typeof directFactory.open !== "function"
  ) {
    throw new TypeError("directSessionFactory must provide open()");
  }
  const directOpen = directFactory.open;

  const factory: DirectDestinationSessionFactory = {
    async open(_connection, context): Promise<DirectDestinationSessionOpenResult> {
      const failures: unknown[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          throwIfAborted(context.signal);
          const target = await Reflect.apply(resolveGroup, undefined, [
            resolverOptions(options, context),
          ]);
          throwIfAborted(context.signal);
          const connection = targetConnection(
            options.plan,
            messageServerTargetDirectRoute(target),
          );
          const opened = await Reflect.apply(directOpen, directFactory, [
            connection,
            context,
          ]) as DirectDestinationSessionOpenResult;
          // The nested production factory returns a raw session. Custom test
          // factories may already provide a selected result; normalize both.
          const sessionDescriptor = typeof opened === "object" && opened !== null
            ? Object.getOwnPropertyDescriptor(opened, "session")
            : undefined;
          const session = sessionDescriptor !== undefined &&
              "value" in sessionDescriptor
            ? sessionDescriptor.value as DirectCpicSession
            : opened as DirectCpicSession;
          return Object.freeze({ session, selectedConnection: connection });
        } catch (error) {
          failures.push(error);
          if (
            !isRetryableMessageServerOpenFailure(error) ||
            attempt >= maxAttempts ||
            context.signal.aborted
          ) {
            if (failures.length === 1) throw error;
            throw new AggregateError(
              failures,
              `message-server physical session failed after ${attempt} bounded attempts`,
              { cause: error },
            );
          }
        }
      }
      throw new Error("message-server physical session exhausted its attempt bound");
    },
  };
  return Object.freeze(factory);
}
