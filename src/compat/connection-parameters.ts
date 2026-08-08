export type RfcConnectionParameters = Readonly<Record<string, unknown>>;

export interface NormalizedDirectConnection {
  /** TCP endpoint used for the SAP gateway connection. */
  readonly host: string;
  /** Application server name carried inside the CPIC logon request. */
  readonly applicationServerHost: string;
  readonly port: number;
  readonly applicationServerService: string;
  readonly client: string;
  readonly user: string;
  readonly password: string;
  readonly language: string;
  readonly sysnr: string;
  readonly cpicStreaming: "disabled" | "enabled";
}

/** Direct route and logon fields which do not select an authentication mode. */
export type NormalizedDirectRouteConnection = Readonly<
  Omit<NormalizedDirectConnection, "user" | "password">
>;

/** Common RFC logon fields shared by every client route. */
export interface NormalizedRfcLogon {
  readonly client: string;
  readonly language: string;
}

export interface CapturedDirectConnectionParameters {
  /** Immutable, caller-facing copy of the recognized connection parameters. */
  readonly connectionParameters: RfcConnectionParameters;
  /** Immutable direct-connection configuration derived from the same copy. */
  readonly normalized: NormalizedDirectConnection;
}

const RECOGNIZED_DIRECT_PARAMETER_NAMES = Object.freeze([
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
  "snc_mode",
] as const);

const HIDDEN_DIRECT_PARAMETER_NAMES = new Set([
  "passwd",
  "business_user_token",
  "connectivity_proxy_authentication",
  "connectivity_socks5_access_token",
]);

const ISO_TO_SAP_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  AF: "a",
  SQ: "뽑",
  AG: "뢇",
  AR: "A",
  AZ: "뢚",
  BD: "룤",
  BB: "룢",
  BN: "룮",
  BK: "룫",
  BS: "룳",
  Z9: "&",
  BG: "W",
  CA: "c",
  ZH: "1",
  ZF: "M",
  KW: "뱗",
  HR: "6",
  Z1: "Z",
  CS: "C",
  DA: "K",
  NL: "N",
  DM: "릭",
  EN: "E",
  "6N": "둮",
  ET: "9",
  FI: "U",
  FR: "F",
  "3F": "덆",
  DE: "D",
  "4G": "뎧",
  EL: "G",
  HE: "B",
  HI: "묩",
  HU: "H",
  IS: "b",
  IN: "뮎",
  ID: "i",
  IR: "뮒",
  IT: "I",
  JA: "J",
  KK: "뱋",
  KO: "3",
  LV: "Y",
  LT: "X",
  MK: "봋",
  MS: "7",
  MV: "봖",
  MO: "봏",
  NI: "뵩",
  NO: "O",
  OM: "뷍",
  P1: "븑",
  PL: "L",
  PT: "P",
  "1P": "느",
  PK: "븫",
  RO: "4",
  RU: "R",
  SA: "뽁",
  SR: "0",
  SH: "d",
  SK: "Q",
  SL: "5",
  ES: "S",
  "1X": "늘",
  SV: "V",
  TA: "뾡",
  TT: "뾴",
  "1Q": "늑",
  "2Q": "닱",
  TH: "2",
  TR: "T",
  TC: "뾣",
  Z8: ";",
  UK: "8",
  VI: "쁩",
});

const SAP_TO_ISO_LANGUAGE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ISO_TO_SAP_LANGUAGE).map(([iso, sap]) => [sap, iso]),
  ),
);

export function languageIsoToSap(language: string): string {
  if (typeof language !== "string" || language.length === 0) {
    throw new TypeError("language must be a non-empty string");
  }
  if (!/^[A-Za-z0-9]{2}(?:[-_][A-Za-z0-9]{2,8})*$/u.test(language)) {
    throw new Error(`Language ISO code not found: ${language}`);
  }
  const iso = language.slice(0, 2).toUpperCase();
  const sap = ISO_TO_SAP_LANGUAGE[iso];
  if (sap === undefined) throw new Error(`Language ISO code not found: ${language}`);
  return sap;
}

export function languageSapToIso(language: string): string {
  if (typeof language !== "string" || language.length === 0) {
    throw new TypeError("SAP language must be a non-empty string");
  }
  if (!Object.hasOwn(SAP_TO_ISO_LANGUAGE, language)) {
    throw new Error(`Language SAP code not found: ${language}`);
  }
  const iso = SAP_TO_ISO_LANGUAGE[language];
  if (iso === undefined) throw new Error(`Language SAP code not found: ${language}`);
  return iso;
}

function normalizeDirectConnectionLanguage(language: string): string {
  // Direct RFC parameters traditionally carry a one-character SAP language.
  // Keep that form accepted without weakening the public ISO conversion API.
  return /^[A-Z0-9]$/u.test(language) ? language : languageIsoToSap(language);
}

function parameter(
  input: RfcConnectionParameters,
  name: string,
): unknown {
  const lower = input[name.toLowerCase()];
  const upper = input[name.toUpperCase()];
  if (lower !== undefined && upper !== undefined && lower !== upper) {
    throw new Error(`conflicting ${name.toLowerCase()} and ${name.toUpperCase()} values`);
  }
  return lower ?? upper;
}

function textParameter(
  input: RfcConnectionParameters,
  name: string,
  required: boolean,
): string | undefined {
  const value = parameter(input, name);
  if (value === undefined && !required) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || `${value}`.length === 0) {
    throw new TypeError(`${name.toLowerCase()} must be a non-empty string or number`);
  }
  return `${value}`;
}

function systemNumber(input: RfcConnectionParameters): string {
  const raw = textParameter(input, "sysnr", false) ?? "00";
  if (!/^\d{1,2}$/u.test(raw)) {
    throw new RangeError("sysnr must contain one or two decimal digits");
  }
  return raw.padStart(2, "0");
}

function clientNumber(input: RfcConnectionParameters): string {
  const raw = textParameter(input, "client", true)!;
  if (!/^\d{1,3}$/u.test(raw)) {
    throw new RangeError("client must contain one to three decimal digits");
  }
  return raw.padStart(3, "0");
}

function gatewayPort(input: RfcConnectionParameters, sysnr: string): number {
  const raw = textParameter(input, "gwserv", false) ??
    textParameter(input, "port", false);
  if (raw === undefined) return 3300 + Number.parseInt(sysnr, 10);
  const serviceMatch = /^sapgw(\d{2})$/u.exec(raw);
  const numeric = serviceMatch === null
    ? Number.parseInt(raw, 10)
    : 3300 + Number.parseInt(serviceMatch[1]!, 10);
  if (!/^\d+$/u.test(raw) && serviceMatch === null) {
    throw new RangeError("gwserv must be a TCP port or sapgwNN service name");
  }
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new RangeError("gateway TCP port must be an integer in 1..65535");
  }
  return numeric;
}

function cpicStreamingPolicy(
  input: RfcConnectionParameters,
): "disabled" | "enabled" {
  const value = parameter(input, "cpic_streaming");
  if (value === undefined || value === "disabled") return "disabled";
  if (value === "enabled") return "enabled";
  throw new RangeError("cpic_streaming must be disabled or enabled");
}

export function snapshotDirectConnectionParameters(
  input: RfcConnectionParameters,
): RfcConnectionParameters {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("RFC connection parameters must be an object");
  }

  const snapshot: Record<string, unknown> = {};
  for (const name of RECOGNIZED_DIRECT_PARAMETER_NAMES) {
    for (const key of [name, name.toUpperCase()]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) {
        throw new TypeError(
          `RFC connection parameter ${key} must be an own data property`,
        );
      }
      const hidden = HIDDEN_DIRECT_PARAMETER_NAMES.has(key.toLowerCase());
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: !hidden,
        value: descriptor.value,
        writable: false,
      });
    }
  }
  return Object.freeze(snapshot);
}

function rejectUnsupportedDirectParameters(
  input: RfcConnectionParameters,
): void {
  for (const unsupported of ["wshost", "saprouter", "snc_mode"]) {
    if (parameter(input, unsupported) !== undefined) {
      throw new Error(
        `${unsupported} connections are not implemented; use direct ashost/sysnr`,
      );
    }
  }
}

function normalizeRfcLogonParameterSnapshot(
  input: RfcConnectionParameters,
): NormalizedRfcLogon {
  const language = textParameter(input, "lang", false) ?? "E";
  return Object.freeze({
    client: clientNumber(input),
    language: normalizeDirectConnectionLanguage(language),
  });
}

function normalizeDirectRouteConnectionParameterSnapshot(
  input: RfcConnectionParameters,
): NormalizedDirectRouteConnection {
  rejectUnsupportedDirectParameters(input);
  const ashost = textParameter(input, "ashost", true)!;
  if (!/^[\x20-\x7e]{1,64}$/u.test(ashost)) {
    throw new RangeError(
      "ashost must contain 1..64 ASCII bytes for the CPIC application-server name",
    );
  }
  const gwhost = textParameter(input, "gwhost", false);
  const sysnr = systemNumber(input);
  const logon = normalizeRfcLogonParameterSnapshot(input);
  return Object.freeze({
    host: gwhost ?? ashost,
    applicationServerHost: ashost,
    port: gatewayPort(input, sysnr),
    applicationServerService: `sapdp${sysnr}`,
    client: logon.client,
    language: logon.language,
    sysnr,
    cpicStreaming: cpicStreamingPolicy(input),
  });
}

function normalizeDirectConnectionParameterSnapshot(
  input: RfcConnectionParameters,
): NormalizedDirectConnection {
  // Keep the legacy direct validation and evaluation order stable. The
  // authentication-neutral route helper above intentionally has a separate
  // construction path because principal propagation has no user/passwd.
  rejectUnsupportedDirectParameters(input);
  const ashost = textParameter(input, "ashost", true)!;
  if (!/^[\x20-\x7e]{1,64}$/u.test(ashost)) {
    throw new RangeError(
      "ashost must contain 1..64 ASCII bytes for the CPIC application-server name",
    );
  }
  const gwhost = textParameter(input, "gwhost", false);
  const sysnr = systemNumber(input);
  const language = textParameter(input, "lang", false) ?? "E";
  return Object.freeze({
    host: gwhost ?? ashost,
    applicationServerHost: ashost,
    port: gatewayPort(input, sysnr),
    applicationServerService: `sapdp${sysnr}`,
    client: clientNumber(input),
    user: textParameter(input, "user", true)!,
    password: textParameter(input, "passwd", true)!,
    language: normalizeDirectConnectionLanguage(language),
    sysnr,
    cpicStreaming: cpicStreamingPolicy(input),
  });
}

/**
 * Capture and normalize the direct-application-server subset implemented by
 * open-rfc. Only recognized own data properties are inspected. Accessors are
 * rejected without execution so normalization cannot combine values from
 * different caller-controlled states.
 */
export function captureDirectConnectionParameters(
  input: RfcConnectionParameters,
): CapturedDirectConnectionParameters {
  const connectionParameters = snapshotDirectConnectionParameters(input);
  const normalized = normalizeDirectConnectionParameterSnapshot(
    connectionParameters,
  );
  return Object.freeze({ connectionParameters, normalized });
}

/** Normalize the direct-application-server subset implemented by open-rfc. */
export function normalizeDirectConnectionParameters(
  input: RfcConnectionParameters,
): NormalizedDirectConnection {
  return captureDirectConnectionParameters(input).normalized;
}

/**
 * Normalize direct endpoint and common logon fields without choosing an
 * authentication provider. Advanced route planners use this for principal
 * propagation while the public direct API continues to require user/passwd.
 */
export function normalizeDirectRouteConnectionParameters(
  input: RfcConnectionParameters,
): NormalizedDirectRouteConnection {
  return normalizeDirectRouteConnectionParameterSnapshot(
    snapshotDirectConnectionParameters(input),
  );
}

/** Normalize the client and language fields shared by non-direct routes. */
export function normalizeRfcLogonParameters(
  input: RfcConnectionParameters,
): NormalizedRfcLogon {
  return normalizeRfcLogonParameterSnapshot(
    snapshotDirectConnectionParameters(input),
  );
}
