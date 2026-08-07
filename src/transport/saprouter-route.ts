import { inspect } from "node:util";

/** SAProuter's documented default listener service. */
export const SAPROUTER_DEFAULT_SERVICE = "3299";
/** Route-information structure version used by current SAProuter. */
export const SAPROUTER_ROUTE_INFORMATION_VERSION = 2;
/** NI protocol version used by current SAProuter route requests. */
export const SAPROUTER_DEFAULT_NI_VERSION = 40;
/** Fixed bytes preceding the NUL-separated internal route string. */
export const SAPROUTER_ROUTE_HEADER_LENGTH = 0x18;
export const SAPROUTER_MAX_ROUTE_BYTES = 2_048;
export const SAPROUTER_MAX_ROUTE_HOPS = 255;
export const SAPROUTER_MAX_RESPONSE_PAYLOAD_BYTES = 1_048_576;

const SAPROUTER_ROUTE_EYECATCHER = Buffer.from("NI_ROUTE\0", "ascii");
const SAPROUTER_PONG = Buffer.from("NI_PONG\0", "ascii");
const SAPROUTER_ERROR_EYECATCHER = Buffer.from("NI_RTERR\0", "ascii");
const CUSTOM_INSPECT = inspect.custom;
const REDACTED = "[REDACTED]";
const ROUTE_PREFIX_SENTINEL_HOST = "open-rfc-target.invalid";
const ROUTE_PREFIX_SENTINEL_PORT = 65_535;

interface InternalSapRouterHop {
  readonly host: string;
  /** Undefined is serialized as an empty field and means service 3299. */
  readonly service: string | undefined;
  readonly password: string | undefined;
}

interface InternalSapRouterRoute {
  readonly hops: readonly InternalSapRouterHop[];
  readonly byteLength: number;
}

const ROUTE_INTERNALS = new WeakMap<object, InternalSapRouterRoute>();

export interface SapRouterRouteHop {
  readonly host: string;
  readonly service: string;
  readonly usesDefaultService: boolean;
  readonly passwordProtected: boolean;
}

export interface SapRouterFirstHop {
  readonly host: string;
  readonly service: string;
  readonly usesDefaultService: boolean;
}

/**
 * Immutable, redaction-safe route admitted at the network trust boundary.
 * Password values are kept in an opaque side table and never exposed through
 * object inspection or JSON serialization.
 */
export interface AdmittedSapRouterRoute {
  readonly hopCount: number;
  readonly byteLength: number;
  readonly firstHop: SapRouterFirstHop;
  readonly hops: readonly SapRouterRouteHop[];
  readonly redactedRouteString: string;
}

export interface SapRouterRouteRequestOptions {
  readonly niVersion?: number;
}

/**
 * Validate the RFC `SAPROUTER` parameter form. It is a route prefix whose
 * terminal `/H/` placeholder is completed from ASHOST/GWHOST by the transport.
 */
export function assertSapRouterRoutePrefix(input: unknown): asserts input is string {
  if (
    typeof input !== "string" ||
    !input.endsWith("/H/") ||
    input.length > SAPROUTER_MAX_ROUTE_BYTES ||
    !/^[\x20-\x7e]+$/u.test(input)
  ) {
    invalidRoute();
  }
  // Reuse the authoritative complete-route parser with a fixed harmless
  // endpoint. This admits passwords only on router hops and rejects /P/.
  admitSapRouterRoute(
    `${input}${ROUTE_PREFIX_SENTINEL_HOST}/S/${ROUTE_PREFIX_SENTINEL_PORT}`,
  );
}

/** Bind a validated route prefix to exactly one normalized gateway endpoint. */
export function completeSapRouterRoute(
  prefix: unknown,
  gatewayHost: unknown,
  gatewayPort: unknown,
): AdmittedSapRouterRoute {
  assertSapRouterRoutePrefix(prefix);
  const host = routeField(
    typeof gatewayHost === "string" ? gatewayHost : undefined,
    "host",
  );
  if (
    !Number.isSafeInteger(gatewayPort) ||
    (gatewayPort as number) < 1 ||
    (gatewayPort as number) > 0xffff
  ) {
    invalidRoute();
  }
  return admitSapRouterRoute(`${prefix}${host}/S/${gatewayPort as number}`);
}

export type SapRouterRouteResponse =
  | Readonly<{ readonly kind: "accepted" }>
  | Readonly<{
      readonly kind: "rejected";
      readonly niVersion: number;
      readonly returnCode: number;
      readonly errorTextByteLength: number;
    }>;

function invalidRoute(): never {
  throw new RangeError("SAProuter route string is invalid");
}

function routeField(
  value: string | undefined,
  kind: "host" | "service" | "password",
): string {
  if (value === undefined || value.length === 0) invalidRoute();
  if (kind === "host") {
    if (
      value.length < 2 ||
      value.length > 255 ||
      !/^[A-Za-z0-9_.:%\[\]-]+$/u.test(value)
    ) {
      invalidRoute();
    }
    return value;
  }
  if (kind === "service") {
    if (value.length > 63 || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
      invalidRoute();
    }
    return value;
  }
  if (
    value.length > 255 ||
    !/^[\x20-\x2e\x30-\x7e]+$/u.test(value)
  ) {
    // The omitted 0x2f byte is '/': it is the route-field delimiter.
    invalidRoute();
  }
  return value;
}

function internalHopByteLength(hop: InternalSapRouterHop): number {
  return (
    Buffer.byteLength(hop.host, "ascii") + 1 +
    Buffer.byteLength(hop.service ?? "", "ascii") + 1 +
    Buffer.byteLength(hop.password ?? "", "ascii") + 1
  );
}

function redactedRoute(hops: readonly InternalSapRouterHop[]): string {
  return hops.map((hop) =>
    `/H/${hop.host}` +
    (hop.service === undefined ? "" : `/S/${hop.service}`) +
    (hop.password === undefined ? "" : `/W/${REDACTED}`)
  ).join("");
}

function safeRouteView(route: AdmittedSapRouterRoute): Readonly<Record<string, unknown>> {
  return Object.freeze({
    hopCount: route.hopCount,
    byteLength: route.byteLength,
    firstHop: route.firstHop,
    hops: route.hops,
    redactedRouteString: route.redactedRouteString,
  });
}

/**
 * Parse the canonical `/H/host[/S/service][/W/password]...` syntax.
 *
 * The canonical uppercase form is intentional. Legacy `/P/` placement is
 * ambiguous and must be normalized by a caller before crossing this boundary.
 * At least one router and one final target are required; a password on the
 * final target has no successor to protect and is therefore rejected.
 */
export function admitSapRouterRoute(input: unknown): AdmittedSapRouterRoute {
  if (
    typeof input !== "string" ||
    input.length > SAPROUTER_MAX_ROUTE_BYTES ||
    !/^[\x20-\x7e]+$/u.test(input)
  ) {
    invalidRoute();
  }

  const parts = input.split("/");
  if (parts[0] !== "" || parts.length < 5) invalidRoute();
  const hops: InternalSapRouterHop[] = [];
  let cursor = 1;
  while (cursor < parts.length) {
    if (parts[cursor] !== "H") invalidRoute();
    const host = routeField(parts[cursor + 1], "host");
    cursor += 2;
    let service: string | undefined;
    let password: string | undefined;
    let passwordSeen = false;

    while (cursor < parts.length && parts[cursor] !== "H") {
      const token = parts[cursor];
      const rawValue = parts[cursor + 1];
      if (token === "S") {
        if (service !== undefined || passwordSeen) invalidRoute();
        service = routeField(rawValue, "service");
      } else if (token === "W") {
        if (passwordSeen) invalidRoute();
        password = routeField(rawValue, "password");
        passwordSeen = true;
      } else {
        invalidRoute();
      }
      cursor += 2;
    }

    hops.push(Object.freeze({ host, service, password }));
    if (hops.length > SAPROUTER_MAX_ROUTE_HOPS) invalidRoute();
  }

  if (hops.length < 2 || hops[hops.length - 1]?.password !== undefined) {
    invalidRoute();
  }
  const byteLength = hops.reduce(
    (length, hop) => length + internalHopByteLength(hop),
    0,
  );
  if (byteLength > SAPROUTER_MAX_ROUTE_BYTES) invalidRoute();

  const publicHops = Object.freeze(hops.map((hop): SapRouterRouteHop =>
    Object.freeze({
      host: hop.host,
      service: hop.service ?? SAPROUTER_DEFAULT_SERVICE,
      usesDefaultService: hop.service === undefined,
      passwordProtected: hop.password !== undefined,
    })
  ));
  const first = hops[0]!;
  const firstHop: SapRouterFirstHop = Object.freeze({
    host: first.host,
    service: first.service ?? SAPROUTER_DEFAULT_SERVICE,
    usesDefaultService: first.service === undefined,
  });
  const admitted = {
    hopCount: hops.length,
    byteLength,
    firstHop,
    hops: publicHops,
    redactedRouteString: redactedRoute(hops),
  } as AdmittedSapRouterRoute;
  Object.defineProperty(admitted, "toJSON", {
    configurable: false,
    enumerable: false,
    value: (): Readonly<Record<string, unknown>> => safeRouteView(admitted),
    writable: false,
  });
  Object.defineProperty(admitted, CUSTOM_INSPECT, {
    configurable: false,
    enumerable: false,
    value: (): Readonly<Record<string, unknown>> => safeRouteView(admitted),
    writable: false,
  });
  Object.freeze(admitted);
  ROUTE_INTERNALS.set(admitted, Object.freeze({
    hops: Object.freeze(hops),
    byteLength,
  }));
  return admitted;
}

function requireAdmittedRoute(route: AdmittedSapRouterRoute): InternalSapRouterRoute {
  if ((typeof route !== "object" && typeof route !== "function") || route === null) {
    throw new TypeError("route must be created by admitSapRouterRoute");
  }
  const internal = ROUTE_INTERNALS.get(route);
  if (internal === undefined) {
    throw new TypeError("route must be created by admitSapRouterRoute");
  }
  return internal;
}

export function assertAdmittedSapRouterRoute(
  route: AdmittedSapRouterRoute,
): void {
  requireAdmittedRoute(route);
}

function normalizedNiVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 255) {
    throw new RangeError("niVersion must be an integer in 1..255");
  }
  return value as number;
}

/** Encode one NI_ROUTE payload (without the outer four-byte NI length). */
export function encodeSapRouterRouteRequestPayload(
  route: AdmittedSapRouterRoute,
  options: SapRouterRouteRequestOptions = {},
): Buffer {
  const internal = requireAdmittedRoute(route);
  const niVersion = normalizedNiVersion(
    options.niVersion ?? SAPROUTER_DEFAULT_NI_VERSION,
  );
  const payload = Buffer.alloc(SAPROUTER_ROUTE_HEADER_LENGTH + internal.byteLength);
  SAPROUTER_ROUTE_EYECATCHER.copy(payload, 0);
  payload[9] = SAPROUTER_ROUTE_INFORMATION_VERSION;
  payload[10] = niVersion;
  payload[11] = internal.hops.length;
  payload[12] = 0; // NI_MSG_IO: the routed CPIC stream remains NI-framed.
  payload.writeUInt16BE(0, 13);
  payload[15] = internal.hops.length - 1;
  payload.writeUInt32BE(internal.byteLength, 16);
  payload.writeUInt32BE(internalHopByteLength(internal.hops[0]!), 20);

  let offset = SAPROUTER_ROUTE_HEADER_LENGTH;
  for (const hop of internal.hops) {
    for (const field of [hop.host, hop.service ?? "", hop.password ?? ""]) {
      offset += payload.write(field, offset, "ascii");
      payload[offset] = 0;
      offset += 1;
    }
  }
  if (offset !== payload.length) {
    payload.fill(0);
    throw new Error("internal SAProuter route length mismatch");
  }
  return payload;
}

function responseError(message: string): never {
  throw new RangeError(`SAProuter route response is invalid: ${message}`);
}

function equalsAt(value: Buffer, expected: Buffer): boolean {
  return value.length >= expected.length &&
    value.subarray(0, expected.length).equals(expected);
}

/** Decode only the route-completion acknowledgement or bounded error status. */
export function decodeSapRouterRouteResponse(
  input: Uint8Array,
): SapRouterRouteResponse {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > SAPROUTER_MAX_RESPONSE_PAYLOAD_BYTES
  ) {
    responseError("payload bounds");
  }
  const payload = Buffer.from(input);
  if (payload.equals(SAPROUTER_PONG)) {
    return Object.freeze({ kind: "accepted" });
  }
  if (!equalsAt(payload, SAPROUTER_ERROR_EYECATCHER)) {
    responseError("unexpected acknowledgement");
  }
  if (payload.length < 20) responseError("truncated error header");
  const niVersion = payload[9]!;
  const opcode = payload[10]!;
  const padding = payload[11]!;
  const returnCode = payload.readInt32BE(12);
  const errorTextByteLength = payload.readUInt32BE(16);
  if (niVersion === 0 || opcode !== 0 || padding !== 0 || returnCode >= 0) {
    responseError("invalid error status");
  }
  const documentedLength = 20 + errorTextByteLength;
  const modernLength = documentedLength + 4;
  if (payload.length !== documentedLength && payload.length !== modernLength) {
    responseError("inconsistent error text length");
  }
  if (
    payload.length === modernLength &&
    payload.readUInt32BE(documentedLength) !== 0
  ) {
    responseError("invalid error trailer");
  }
  return Object.freeze({
    kind: "rejected",
    niVersion,
    returnCode,
    errorTextByteLength,
  });
}
