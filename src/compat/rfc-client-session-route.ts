import { types as nodeUtilTypes } from "node:util";

import {
  planConnectionRoute,
  type ConnectionRoutePlan,
} from "./connection-route.js";
import type { RfcConnectionParameters } from "./connection-parameters.js";

const RFC_CLIENT_ROUTE_PARAMETERS = Object.freeze([
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
  "connectivity_socks5_proxy_host",
  "connectivity_socks5_proxy_port",
  "connectivity_socks5_access_token",
  "connectivity_socks5_location_id",
  "business_user_token",
] as const);

/**
 * Public node-rfc comparator properties whose semantics this route facade has
 * not implemented. They are classified explicitly so none can disappear while
 * a different transport/authentication/serializer is silently selected.
 */
export const UNPLANNED_SEMANTIC_RFC_PARAMETERS = Object.freeze([
  "abap_debug",
  "alias_user",
  "asxml",
  "cfit",
  "codepage",
  "compression_type",
  "delta",
  "dest",
  "extiddata",
  "extidtype",
  "getsso2",
  "lcheck",
  "logon_group_check_interval",
  "max_reg_count",
  "mysapsso2",
  "no_compression",
  "on_cce",
  "password_change_enforced",
  "pcs",
  "program_id",
  "proxy_host",
  "proxy_passwd",
  "proxy_port",
  "proxy_user",
  "reg_count",
  "saplogon_id",
  "serialization_format",
  "server_name",
  "snc_lib",
  "snc_mode",
  "snc_myname",
  "snc_partnername",
  "snc_partner_names",
  "snc_qop",
  "snc_sso",
  "sys_ids",
  "tls_client_certificate_logon",
  "tls_client_pse",
  "tls_server_partner_auth",
  "tls_server_pse",
  "tls_trust_all",
  "tpname",
  "trace",
  "use_repository_roundtrip_optimization",
  "use_sapgui",
  "use_symbolic_names",
  "use_tls",
  "x509cert",
] as const);

const ROUTE_PARAMETER_KEYS = new Set<string>();
for (const name of RFC_CLIENT_ROUTE_PARAMETERS) {
  ROUTE_PARAMETER_KEYS.add(name);
  ROUTE_PARAMETER_KEYS.add(name.toUpperCase());
}
const UNPLANNED_SEMANTIC_KEYS = new Set<string>();
for (const name of UNPLANNED_SEMANTIC_RFC_PARAMETERS) {
  UNPLANNED_SEMANTIC_KEYS.add(name);
  UNPLANNED_SEMANTIC_KEYS.add(name.toUpperCase());
}

/**
 * Validate the complete caller-owned RFC parameter surface before a narrower
 * immutable snapshot can discard keys. Compatibility constructors use this
 * boundary independently of route planning so typos and unsupported semantic
 * parameters fail before any owner or transport can be created.
 */
export function validateRFCClientConnectionParameterSurface(
  input: RfcConnectionParameters,
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("RFC connection parameters must be an object");
  }
  if (nodeUtilTypes.isProxy(input)) {
    throw new TypeError("RFC connection parameters must not be a Proxy");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "RFC connection parameters must not have a custom prototype",
    );
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw new TypeError("RFC connection parameter keys must be strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `RFC connection parameter ${key} must be an own data property`,
      );
    }
    if (ROUTE_PARAMETER_KEYS.has(key)) continue;
    if (UNPLANNED_SEMANTIC_KEYS.has(key)) {
      throw new Error(
        `${key.toLowerCase()} connections are not implemented; no session provider can be selected`,
      );
    }
    throw new TypeError(`unknown RFC connection parameter ${key}`);
  }
}

function captureRouteParameters(
  input: RfcConnectionParameters,
): RfcConnectionParameters {
  const captured: Record<string, unknown> = {};
  for (const name of RFC_CLIENT_ROUTE_PARAMETERS) {
    const lower = Object.getOwnPropertyDescriptor(input, name);
    const upper = Object.getOwnPropertyDescriptor(input, name.toUpperCase());
    const lowerValue = lower !== undefined && "value" in lower
      ? lower.value
      : undefined;
    const upperValue = upper !== undefined && "value" in upper
      ? upper.value
      : undefined;
    if (
      lowerValue !== undefined &&
      upperValue !== undefined &&
      lowerValue !== upperValue
    ) {
      throw new Error(`conflicting ${name} and ${name.toUpperCase()} values`);
    }
    if (lowerValue !== undefined || upperValue !== undefined) {
      captured[name] = lowerValue ?? upperValue;
    }
  }
  return Object.freeze(captured);
}

/**
 * Strict modern route admission. Every own property is either represented in
 * ConnectionRoutePlan or rejected before an owner/provider can perform I/O.
 */
export function planRFCClientSessionRoute(
  input: RfcConnectionParameters,
): ConnectionRoutePlan {
  validateRFCClientConnectionParameterSurface(input);
  return planConnectionRoute(captureRouteParameters(input));
}
