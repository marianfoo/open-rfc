import { types as nodeUtilTypes } from "node:util";

import { assertSapRouterRoutePrefix } from "../transport/saprouter-route.js";

import {
  normalizeDirectRouteConnectionParameters,
  normalizeRfcLogonParameters,
  type NormalizedDirectConnection,
  type NormalizedRfcLogon,
  type RfcConnectionParameters,
} from "./connection-parameters.js";

export type ConnectionProviderCapability =
  | "direct-rfc-transport"
  | "message-server-rfc-transport"
  | "message-server-saprouter-routing"
  | "websocket-rfc-transport"
  | "named-user-authentication"
  | "principal-propagation"
  | "saprouter-routing"
  | "connectivity-rfc-proxy"
  | "connectivity-proxy-authorization";

export interface DirectConnectionRoute {
  readonly kind: "direct";
  readonly host: string;
  readonly applicationServerHost: string;
  readonly port: number;
  readonly applicationServerService: string;
  readonly sysnr: string;
  readonly cpicStreaming: "disabled" | "enabled";
}

export interface MessageServerConnectionRoute {
  readonly kind: "message-server";
  readonly messageServerHost: string;
  readonly messageServerService?: string;
  readonly systemId: string;
  readonly group: string;
}

export interface WebSocketConnectionRoute {
  readonly kind: "websocket";
  readonly host: string;
  readonly port?: number;
}

export type ConnectionRoute =
  | DirectConnectionRoute
  | MessageServerConnectionRoute
  | WebSocketConnectionRoute;

export interface NamedUserAuthenticationPlan {
  readonly kind: "named-user";
  readonly user: string;
  readonly password: string;
}

export interface PrincipalPropagationAuthenticationPlan {
  readonly kind: "principal-propagation";
  readonly businessUserToken: string;
}

export type ConnectionAuthenticationPlan =
  | NamedUserAuthenticationPlan
  | PrincipalPropagationAuthenticationPlan;

export interface SapRouterPlan {
  /** Validated route string retained as opaque provider input. */
  readonly routeString: string;
}

export interface ConnectivityProxyPlan {
  readonly host: string;
  readonly port: number;
  /** Connector field connectivity_proxy_authentication, normally Bearer. */
  readonly authorization?: string;
  readonly subaccount?: string;
  readonly locationId?: string;
}

export interface ConnectionRoutePlan {
  readonly route: ConnectionRoute;
  readonly logon: NormalizedRfcLogon;
  readonly authentication: ConnectionAuthenticationPlan;
  readonly sapRouter?: SapRouterPlan;
  readonly connectivityProxy?: ConnectivityProxyPlan;
  /** Capabilities a downstream provider must prove before opening a socket. */
  readonly requiredProviderCapabilities: readonly ConnectionProviderCapability[];
}

/**
 * Project one already-admitted direct/named-user plan into the immutable
 * connection shape owned by the classic session layer. Route adapters use
 * this instead of re-reading or narrowing the caller's parameter object.
 */
export function normalizedDirectConnectionFromPlan(
  plan: ConnectionRoutePlan,
): NormalizedDirectConnection {
  if (plan.route.kind !== "direct") {
    throw new TypeError("normalized direct connection requires a direct route");
  }
  if (plan.authentication.kind !== "named-user") {
    throw new TypeError(
      "normalized direct connection requires named-user authentication",
    );
  }
  return Object.freeze({
    host: plan.route.host,
    applicationServerHost: plan.route.applicationServerHost,
    port: plan.route.port,
    applicationServerService: plan.route.applicationServerService,
    client: plan.logon.client,
    user: plan.authentication.user,
    password: plan.authentication.password,
    language: plan.logon.language,
    sysnr: plan.route.sysnr,
    cpicStreaming: plan.route.cpicStreaming,
  });
}

export class MissingConnectionProviderCapabilitiesError extends Error {
  readonly code = "ERR_OPEN_RFC_CONNECTION_PROVIDER_CAPABILITY" as const;
  readonly missingCapabilities: readonly ConnectionProviderCapability[];

  constructor(missingCapabilities: readonly ConnectionProviderCapability[]) {
    const snapshot = Object.freeze([...missingCapabilities]);
    super(`Missing RFC connection provider capabilities: ${snapshot.join(", ")}`);
    this.name = "MissingConnectionProviderCapabilitiesError";
    this.missingCapabilities = snapshot;
  }
}

const CONNECTION_PARAMETER_NAMES = Object.freeze([
  "ashost",
  "gwhost",
  "gwserv",
  "port",
  "sysnr",
  "client",
  "user",
  "passwd",
  "lang",
  "cpic_streaming",
  "mshost",
  "msserv",
  "r3name",
  "sysid",
  "group",
  "wshost",
  "wsport",
  "saprouter",
  "connectivity_proxy_host",
  "connectivity_proxy_port",
  "connectivity_proxy_authentication",
  "connectivity_subaccount",
  "connectivity_location_id",
  "business_user_token",
] as const);

type ConnectionParameterName = typeof CONNECTION_PARAMETER_NAMES[number];
type ConnectionParameterSnapshot = Readonly<
  Partial<Record<ConnectionParameterName, unknown>>
>;

const CANONICAL_PARAMETER_BY_KEY = new Map<string, ConnectionParameterName>();
for (const name of CONNECTION_PARAMETER_NAMES) {
  CANONICAL_PARAMETER_BY_KEY.set(name, name);
  CANONICAL_PARAMETER_BY_KEY.set(name.toUpperCase(), name);
}

const CUSTOM_INSPECT = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[REDACTED]";

function freezeSecretNode<T extends object>(
  value: T,
  redacted: Readonly<Record<string, unknown>>,
): Readonly<T> {
  const safe = Object.freeze({ ...redacted });
  Object.defineProperty(value, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => safe,
    writable: false,
  });
  Object.defineProperty(value, CUSTOM_INSPECT, {
    configurable: false,
    enumerable: false,
    value: () => safe,
    writable: false,
  });
  return Object.freeze(value);
}

function snapshotConnectionParameters(
  input: RfcConnectionParameters,
): ConnectionParameterSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("RFC connection parameters must be an object");
  }
  if (nodeUtilTypes.isProxy(input)) {
    throw new TypeError("RFC connection parameters must not be a Proxy");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("RFC connection parameters must not have a custom prototype");
  }

  const snapshot: Partial<Record<ConnectionParameterName, unknown>> =
    Object.create(null) as Partial<Record<ConnectionParameterName, unknown>>;
  const seen = new Set<ConnectionParameterName>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw new TypeError("RFC connection parameter keys must be strings");
    }
    const canonical = CANONICAL_PARAMETER_BY_KEY.get(key);
    if (canonical === undefined) {
      throw new TypeError(`unknown RFC connection parameter ${key}`);
    }
    if (seen.has(canonical)) {
      throw new TypeError(`duplicate RFC connection parameter ${canonical}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `RFC connection parameter ${key} must be an own data property`,
      );
    }
    seen.add(canonical);
    snapshot[canonical] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function hasValue(
  input: ConnectionParameterSnapshot,
  name: ConnectionParameterName,
): boolean {
  return input[name] !== undefined;
}

function textParameter(
  input: ConnectionParameterSnapshot,
  name: ConnectionParameterName,
  required: boolean,
): string | undefined {
  const value = input[name];
  if (value === undefined && !required) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || `${value}`.length === 0) {
    throw new TypeError(`${name} must be a non-empty string or number`);
  }
  return `${value}`;
}

function asciiTextParameter(
  input: ConnectionParameterSnapshot,
  name: ConnectionParameterName,
  required: boolean,
  maximumLength: number,
): string | undefined {
  const value = textParameter(input, name, required);
  if (value === undefined) return undefined;
  if (!new RegExp(`^[\\x20-\\x7e]{1,${maximumLength}}$`, "u").test(value)) {
    throw new RangeError(`${name} must contain 1..${maximumLength} printable ASCII bytes`);
  }
  return value;
}

function portParameter(
  input: ConnectionParameterSnapshot,
  name: "wsport" | "connectivity_proxy_port",
): number {
  const value = textParameter(input, name, true)!;
  if (!/^\d+$/u.test(value)) {
    throw new RangeError(`${name} must be an integer in 1..65535`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${name} must be an integer in 1..65535`);
  }
  return port;
}

function selectRoute(
  input: ConnectionParameterSnapshot,
): "direct" | "message-server" | "websocket" {
  // This is the exact selection order in @sap/cds-rfc 2.2.1.
  if (hasValue(input, "ashost")) return "direct";
  if (hasValue(input, "mshost")) return "message-server";
  if (hasValue(input, "wshost")) return "websocket";
  throw new TypeError("one of ashost, mshost, or wshost is required");
}

function rejectOrphanedRouteParameters(input: ConnectionParameterSnapshot): void {
  if (!hasValue(input, "ashost")) {
    for (const name of ["gwhost", "gwserv", "port", "sysnr", "cpic_streaming"] as const) {
      if (hasValue(input, name)) {
        throw new TypeError(`${name} requires a selected ashost route`);
      }
    }
  }
  if (!hasValue(input, "mshost")) {
    for (const name of ["msserv", "r3name", "sysid", "group"] as const) {
      if (hasValue(input, name)) {
        throw new TypeError(`${name} requires a selected mshost route`);
      }
    }
  }
  if (!hasValue(input, "wshost") && hasValue(input, "wsport")) {
    throw new TypeError("wsport requires a selected wshost route");
  }
}

function pick(
  input: ConnectionParameterSnapshot,
  names: readonly ConnectionParameterName[],
): RfcConnectionParameters {
  const result: Record<string, unknown> = {};
  for (const name of names) {
    if (Object.hasOwn(input, name)) result[name] = input[name];
  }
  return Object.freeze(result);
}

function planRoute(input: ConnectionParameterSnapshot): {
  readonly route: ConnectionRoute;
  readonly logon: NormalizedRfcLogon;
  readonly capability: ConnectionProviderCapability;
} {
  rejectOrphanedRouteParameters(input);
  const selected = selectRoute(input);
  if (selected === "direct") {
    const normalized = normalizeDirectRouteConnectionParameters(pick(input, [
      "ashost",
      "gwhost",
      "gwserv",
      "port",
      "sysnr",
      "client",
      "lang",
      "cpic_streaming",
    ]));
    return Object.freeze({
      route: Object.freeze({
        kind: "direct" as const,
        host: normalized.host,
        applicationServerHost: normalized.applicationServerHost,
        port: normalized.port,
        applicationServerService: normalized.applicationServerService,
        sysnr: normalized.sysnr,
        cpicStreaming: normalized.cpicStreaming,
      }),
      logon: Object.freeze({
        client: normalized.client,
        language: normalized.language,
      }),
      capability: "direct-rfc-transport" as const,
    });
  }

  const logon = normalizeRfcLogonParameters(pick(input, ["client", "lang"]));
  if (selected === "message-server") {
    if (!hasValue(input, "r3name") && !hasValue(input, "sysid")) {
      throw new TypeError(
        "r3name or sysid is required for a message-server route",
      );
    }
    if (!hasValue(input, "group")) {
      throw new TypeError("group is required for a message-server route");
    }
    // @sap/cds-rfc/JCo gives R3NAME precedence and treats SYSID as fallback.
    const systemId = hasValue(input, "r3name")
      ? textParameter(input, "r3name", true)!
      : textParameter(input, "sysid", true)!;
    if (!/^[A-Za-z0-9]{3}$/u.test(systemId)) {
      throw new RangeError(
        "r3name/sysid must be a three-character SAP system ID",
      );
    }
    const service = asciiTextParameter(input, "msserv", false, 64);
    const route = {
      kind: "message-server" as const,
      messageServerHost: asciiTextParameter(input, "mshost", true, 255)!,
      ...(service === undefined ? {} : { messageServerService: service }),
      systemId,
      group: asciiTextParameter(input, "group", true, 64)!,
    };
    return Object.freeze({
      route: Object.freeze(route),
      logon,
      capability: "message-server-rfc-transport" as const,
    });
  }

  const port = hasValue(input, "wsport")
    ? portParameter(input, "wsport")
    : undefined;
  const route = {
    kind: "websocket" as const,
    host: asciiTextParameter(input, "wshost", true, 255)!,
    ...(port === undefined ? {} : { port }),
  };
  return Object.freeze({
    route: Object.freeze(route),
    logon,
    capability: "websocket-rfc-transport" as const,
  });
}

function planAuthentication(input: ConnectionParameterSnapshot): {
  readonly authentication: ConnectionAuthenticationPlan;
  readonly capability: ConnectionProviderCapability;
} {
  const token = textParameter(input, "business_user_token", false);
  const hasUser = hasValue(input, "user");
  const hasPassword = hasValue(input, "passwd");
  if (token !== undefined && (hasUser || hasPassword)) {
    throw new TypeError("business_user_token cannot be combined with user or passwd");
  }
  if (token !== undefined) {
    return Object.freeze({
      authentication: freezeSecretNode({
        kind: "principal-propagation" as const,
        businessUserToken: token,
      }, {
        kind: "principal-propagation",
        businessUserToken: REDACTED,
      }),
      capability: "principal-propagation" as const,
    });
  }
  if (hasUser !== hasPassword) {
    throw new TypeError("user and passwd must be supplied together");
  }
  if (!hasUser) {
    throw new TypeError("user and passwd must be supplied together");
  }
  const user = textParameter(input, "user", true)!;
  const password = textParameter(input, "passwd", true)!;
  return Object.freeze({
    authentication: freezeSecretNode({
      kind: "named-user" as const,
      user,
      password,
    }, {
      kind: "named-user",
      user: REDACTED,
      password: REDACTED,
    }),
    capability: "named-user-authentication" as const,
  });
}

function planConnectivityProxy(
  input: ConnectionParameterSnapshot,
): ConnectivityProxyPlan | undefined {
  const hasHost = hasValue(input, "connectivity_proxy_host");
  const hasPort = hasValue(input, "connectivity_proxy_port");
  const hasOption = hasValue(input, "connectivity_proxy_authentication") ||
    hasValue(input, "connectivity_subaccount") ||
    hasValue(input, "connectivity_location_id");
  if (hasHost !== hasPort) {
    throw new TypeError(
      "connectivity_proxy_host and connectivity_proxy_port must be supplied together",
    );
  }
  if (!hasHost) {
    if (hasOption) {
      throw new TypeError(
        "Connectivity proxy options require connectivity_proxy_host and connectivity_proxy_port",
      );
    }
    return undefined;
  }

  const authorization = textParameter(
    input,
    "connectivity_proxy_authentication",
    false,
  );
  const subaccount = asciiTextParameter(
    input,
    "connectivity_subaccount",
    false,
    255,
  );
  const locationId = asciiTextParameter(
    input,
    "connectivity_location_id",
    false,
    255,
  );
  const value = {
    host: asciiTextParameter(input, "connectivity_proxy_host", true, 255)!,
    port: portParameter(input, "connectivity_proxy_port"),
    ...(authorization === undefined ? {} : { authorization }),
    ...(subaccount === undefined ? {} : { subaccount }),
    ...(locationId === undefined ? {} : { locationId }),
  };
  return freezeSecretNode(value, {
    host: value.host,
    port: value.port,
    ...(authorization === undefined ? {} : { authorization: REDACTED }),
    ...(subaccount === undefined ? {} : { subaccount }),
    ...(locationId === undefined ? {} : { locationId }),
  });
}

function sapRouterRouteString(input: ConnectionParameterSnapshot): string | undefined {
  const value = textParameter(input, "saprouter", false);
  if (value === undefined) return undefined;
  try {
    assertSapRouterRoutePrefix(value);
  } catch {
    throw new RangeError("saprouter must be a valid SAProuter route prefix");
  }
  return value;
}

/**
 * Capture and validate a connector parameter object into an immutable plan.
 * This function performs no DNS, token, proxy, socket, or SAP operation.
 */
export function planConnectionRoute(
  parameters: RfcConnectionParameters,
): ConnectionRoutePlan {
  const input = snapshotConnectionParameters(parameters);
  const route = planRoute(input);
  const authentication = planAuthentication(input);
  const connectivityProxy = planConnectivityProxy(input);
  if (
    authentication.authentication.kind === "principal-propagation" &&
    connectivityProxy === undefined
  ) {
    throw new TypeError(
      "business_user_token requires a Connectivity proxy route",
    );
  }

  const routeString = sapRouterRouteString(input);
  if (routeString !== undefined && route.route.kind === "websocket") {
    throw new TypeError("saprouter cannot be combined with WebSocket RFC");
  }
  const sapRouter = routeString === undefined
    ? undefined
    : freezeSecretNode({ routeString }, { routeString: REDACTED });

  const required: ConnectionProviderCapability[] = [
    route.capability,
    authentication.capability,
  ];
  if (sapRouter !== undefined) required.push("saprouter-routing");
  if (sapRouter !== undefined && route.route.kind === "message-server") {
    required.push("message-server-saprouter-routing");
  }
  if (connectivityProxy !== undefined) {
    required.push("connectivity-rfc-proxy");
    if (connectivityProxy.authorization !== undefined) {
      required.push("connectivity-proxy-authorization");
    }
  }

  return Object.freeze({
    route: route.route,
    logon: route.logon,
    authentication: authentication.authentication,
    ...(sapRouter === undefined ? {} : { sapRouter }),
    ...(connectivityProxy === undefined ? {} : { connectivityProxy }),
    requiredProviderCapabilities: Object.freeze(required),
  });
}

/** Fail closed before I/O unless every capability named by a plan is present. */
export function assertConnectionRouteCapabilities(
  plan: ConnectionRoutePlan,
  availableCapabilities: ReadonlySet<ConnectionProviderCapability>,
): void {
  const missing = plan.requiredProviderCapabilities.filter(
    (capability) => !availableCapabilities.has(capability),
  );
  if (missing.length > 0) {
    throw new MissingConnectionProviderCapabilitiesError(missing);
  }
}
