import {
  RfcFailureCategory,
  type RfcFailure,
} from "./rfc-failure.js";
import { decodeCpicInitialLogonResponse } from "../protocol/cpic.js";

interface LegacyAbapExceptionProperties {
  readonly key: string;
  readonly message: string;
  readonly messageClass: string;
  readonly messageType: string;
  readonly messageNumber: string;
  readonly messageV1?: string;
  readonly messageV2?: string;
  readonly messageV3?: string;
  readonly messageV4?: string;
}

const RFC_ERROR_BRAND = Symbol.for("open-rfc.RFCError");
const ABAP_ERROR_BRAND = Symbol.for("open-rfc.ABAPError");
const INITIAL_CPIC_LOGON_STRUCTURE_ASSERTION_SYMBOL = Symbol.for(
  "open-rfc.initial-cpic-logon-structure/v1",
);
const INITIAL_CPIC_LOGON_STRUCTURE_PROJECTOR_SYMBOL = Symbol.for(
  "open-rfc.internal.initial-cpic-logon-structure-projector/v1",
);
const INITIAL_CPIC_LOGON_PUBLIC_ERROR_PROJECTOR_SYMBOL = Symbol.for(
  "open-rfc.internal.initial-cpic-logon-public-error-projector/v1",
);
const INITIAL_CPIC_LOGON_STRUCTURE_RULES = new Set([
  "unsupported-field",
  "unsupported-field-zero-logon-status",
  "invalid-end-field",
  "invalid-start-field",
  "malformed-vendor-logon-control",
  "duplicate-control-field",
  "malformed-one-byte-status",
  "malformed-call-status",
  "missing-logon-status",
  "nonzero-call-status",
]);
const INITIAL_CPIC_LOGON_EVIDENCE_MAX_FIELDS = 64;
const INITIAL_CPIC_LOGON_EVIDENCE_MAX_BYTE_LENGTH = 0x10000;

interface InitialCpicLogonStructureAssertion {
  readonly rule: string;
  readonly fields: ReadonlyArray<{
    readonly tag: number;
    readonly byteLength: number;
    readonly index: number;
  }>;
}

const INITIAL_CPIC_LOGON_PUBLIC_ERROR_ASSERTIONS =
  new WeakMap<object, InitialCpicLogonStructureAssertion>();

function exactOwnDataKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string") &&
    JSON.stringify([...keys].sort()) === JSON.stringify([...expected].sort());
}

function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

/** Copy only the exact frozen, payload-free assertion installed by CPIC. */
function initialCpicLogonStructureAssertion(
  cause: unknown,
): InitialCpicLogonStructureAssertion | null {
  try {
    if (typeof cause !== "object" || cause === null) return null;
    const projectorDescriptor = Reflect.getOwnPropertyDescriptor(
      decodeCpicInitialLogonResponse,
      INITIAL_CPIC_LOGON_STRUCTURE_PROJECTOR_SYMBOL,
    );
    if (
      projectorDescriptor === undefined ||
      !("value" in projectorDescriptor) ||
      typeof projectorDescriptor.value !== "function" ||
      projectorDescriptor.enumerable ||
      projectorDescriptor.configurable ||
      projectorDescriptor.writable
    ) return null;
    const assertion: unknown = projectorDescriptor.value(cause);
    if (
      typeof assertion !== "object" ||
      assertion === null ||
      !Object.isFrozen(assertion) ||
      !exactOwnDataKeys(assertion, ["fields", "rule"])
    ) return null;
    const rule = ownData(assertion, "rule");
    const sourceFields = ownData(assertion, "fields");
    if (
      typeof rule !== "string" ||
      !INITIAL_CPIC_LOGON_STRUCTURE_RULES.has(rule) ||
      !Array.isArray(sourceFields) ||
      !Object.isFrozen(sourceFields) ||
      sourceFields.length < 1 ||
      sourceFields.length > INITIAL_CPIC_LOGON_EVIDENCE_MAX_FIELDS
    ) return null;
    const fields: Array<{ tag: number; byteLength: number; index: number }> = [];
    for (let index = 0; index < sourceFields.length; index += 1) {
      const field: unknown = sourceFields[index];
      if (
        typeof field !== "object" ||
        field === null ||
        !Object.isFrozen(field) ||
        !exactOwnDataKeys(field, ["byteLength", "index", "tag"])
      ) return null;
      const tag = ownData(field, "tag");
      const byteLength = ownData(field, "byteLength");
      const fieldIndex = ownData(field, "index");
      if (
        !Number.isSafeInteger(tag) ||
        (tag as number) < 0 ||
        (tag as number) > 0xffff ||
        !Number.isSafeInteger(byteLength) ||
        (byteLength as number) < 0 ||
        (byteLength as number) > INITIAL_CPIC_LOGON_EVIDENCE_MAX_BYTE_LENGTH ||
        fieldIndex !== index
      ) return null;
      fields.push(Object.freeze({
        tag: tag as number,
        byteLength: byteLength as number,
        index,
      }));
    }
    return Object.freeze({ rule, fields: Object.freeze(fields) });
  } catch {
    return null;
  }
}

function hasErrorBrand(value: unknown, brand: symbol): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, brand);
  return descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.value === true;
}

function installErrorBrand(value: object, brand: symbol): void {
  Object.defineProperty(value, brand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/*
 * Modified and adapted by open-rfc contributors. Every name and ordinal below
 * is pinned to the RFC_RC enum in the archived Apache-2.0 node-rfc v3.3.1 source
 * at commit
 * 9ccc30b717ff6d841fc52618e80de62c67ba58f0, src/ts/sapnwrfc.ts. See
 * THIRD_PARTY_NOTICES.md.
 * Pinned upstream attribution:
 * SPDX-FileCopyrightText: 2014 SAP SE Srdjan Boskovic <srdjan.boskovic@sap.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** Public RFC return codes shared by node-rfc and the modern SAP Node client. */
export enum RFCErrorCode {
  RFC_OK = 0,
  RFC_COMMUNICATION_FAILURE = 1,
  RFC_LOGON_FAILURE = 2,
  RFC_ABAP_RUNTIME_FAILURE = 3,
  RFC_ABAP_MESSAGE = 4,
  RFC_ABAP_EXCEPTION = 5,
  RFC_CLOSED = 6,
  RFC_CANCELED = 7,
  RFC_TIMEOUT = 8,
  RFC_MEMORY_INSUFFICIENT = 9,
  RFC_VERSION_MISMATCH = 10,
  RFC_INVALID_PROTOCOL = 11,
  RFC_SERIALIZATION_FAILURE = 12,
  RFC_INVALID_HANDLE = 13,
  RFC_RETRY = 14,
  RFC_EXTERNAL_FAILURE = 15,
  RFC_EXECUTED = 16,
  RFC_NOT_FOUND = 17,
  RFC_NOT_SUPPORTED = 18,
  RFC_ILLEGAL_STATE = 19,
  RFC_INVALID_PARAMETER = 20,
  RFC_CODEPAGE_CONVERSION_FAILURE = 21,
  RFC_CONVERSION_FAILURE = 22,
  RFC_BUFFER_TOO_SMALL = 23,
  RFC_TABLE_MOVE_BOF = 24,
  RFC_TABLE_MOVE_EOF = 25,
  RFC_START_SAPGUI_FAILURE = 26,
  RFC_ABAP_CLASS_EXCEPTION = 27,
  RFC_UNKNOWN_ERROR = 28,
  RFC_AUTHORIZATION_FAILURE = 29,
  RFC_AUTHENTICATION_FAILURE = 30,
  RFC_CRYPTOLIB_FAILURE = 31,
  RFC_IO_FAILURE = 32,
  RFC_LOCKING_FAILURE = 33,
}

export interface RFCErrorProperties {
  readonly name?: string;
  readonly group: number;
  readonly code: RFCErrorCode;
  readonly codeString: keyof typeof RFCErrorCode;
  readonly key: string;
}

/** Error base used by the SDK-compatible façades. */
export class RFCError extends Error {
  readonly group: number;
  readonly code: RFCErrorCode;
  readonly codeString: keyof typeof RFCErrorCode;
  readonly key: string;

  constructor(message: string, properties: RFCErrorProperties) {
    super(message);
    installErrorBrand(this, RFC_ERROR_BRAND);
    this.name = properties.name ?? "RFCError";
    this.group = properties.group;
    this.code = properties.code;
    this.codeString = properties.codeString;
    this.key = properties.key;
  }

  /** Loader-independent recognition across the ESM and CommonJS builds. */
  static isRFCError(value: unknown): value is RFCError {
    return hasErrorBrand(value, RFC_ERROR_BRAND);
  }

  /** Loader-independent recognition of an ABAP-originated RFC failure. */
  static isABAPError(value: unknown): value is ABAPError {
    return hasErrorBrand(value, ABAP_ERROR_BRAND);
  }
}

function projectInitialCpicLogonPublicError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return null;
  return INITIAL_CPIC_LOGON_PUBLIC_ERROR_ASSERTIONS.get(error) ?? null;
}

// This verifier is retrieved from the exact package instance that defined it.
// Its WeakMap membership check keeps recognition scoped to one module copy
// without adding a declared static member or root export.
Object.defineProperty(
  RFCError,
  INITIAL_CPIC_LOGON_PUBLIC_ERROR_PROJECTOR_SYMBOL,
  {
    value: projectInitialCpicLogonPublicError,
    enumerable: false,
    configurable: false,
    writable: false,
  },
);

function declaredExceptionDisplay(
  messageClass: string,
  messageType: string,
  messageNumber: string,
  detail: string,
): string {
  const identity = [
    messageClass.length > 0 ? `ID:${messageClass}` : "",
    messageType.length > 0 ? `Type:${messageType}` : "",
  ].filter((part) => part.length > 0).join(" ");
  // Archived node-rfc preserves a single leading separator when a declared
  // exception has neither a message class nor a message type.
  const prefix = identity.length === 0 ? " " : `${identity} `;
  const number = `${prefix}Number:${messageNumber || "000"}`;
  return detail.length === 0 ? number : `${number} ${detail}`;
}

function isCompleteRfcFailure(
  value: LegacyAbapExceptionProperties | RfcFailure,
): value is RfcFailure {
  for (const key of ["schemaVersion", "category", "abap"] as const) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
  }
  return true;
}

/** node-rfc-compatible shape for all remote ABAP failures. */
export class ABAPError extends RFCError {
  readonly abapMsgClass: string;
  readonly abapMsgType: string;
  readonly abapMsgNumber: string;
  readonly abapMsgV1: string;
  readonly abapMsgV2: string;
  readonly abapMsgV3: string;
  readonly abapMsgV4: string;

  /** Accept both the current failure envelope and the archived public shape. */
  constructor(source: LegacyAbapExceptionProperties | RfcFailure) {
    if (isCompleteRfcFailure(source)) {
      const facts = source.abap;
      const message = source.category === RfcFailureCategory.AbapException
        ? declaredExceptionDisplay(
            facts.messageClass,
            facts.messageType,
            facts.messageNumber,
            source.message || facts.messageV1,
          )
        : source.message;
      super(message, {
        name: "ABAPError",
        group: source.group,
        code: source.code as unknown as RFCErrorCode,
        codeString: source.codeString,
        key: source.key,
      });
      installErrorBrand(this, ABAP_ERROR_BRAND);
      this.abapMsgClass = facts.messageClass;
      this.abapMsgType = facts.messageType;
      this.abapMsgNumber = facts.messageNumber || "000";
      this.abapMsgV1 = facts.messageV1;
      this.abapMsgV2 = facts.messageV2;
      this.abapMsgV3 = facts.messageV3;
      this.abapMsgV4 = facts.messageV4;
      return;
    }

    const messageV1 = source.messageV1 ?? source.message;
    super(
      declaredExceptionDisplay(
        source.messageClass,
        source.messageType,
        source.messageNumber,
        source.message,
      ),
      {
        name: "ABAPError",
        group: 1,
        code: RFCErrorCode.RFC_ABAP_EXCEPTION,
        codeString: "RFC_ABAP_EXCEPTION",
        key: source.key,
      },
    );
    installErrorBrand(this, ABAP_ERROR_BRAND);
    this.abapMsgClass = source.messageClass;
    this.abapMsgType = source.messageType;
    this.abapMsgNumber = source.messageNumber || "000";
    this.abapMsgV1 = messageV1;
    this.abapMsgV2 = source.messageV2 ?? "";
    this.abapMsgV3 = source.messageV3 ?? "";
    this.abapMsgV4 = source.messageV4 ?? "";
  }
}

/** Project a core failure to the archived/modern JavaScript error contract. */
export function rfcFailureToPublicError(failure: RfcFailure): RFCError {
  if (
    failure.category === RfcFailureCategory.AbapException ||
    failure.category === RfcFailureCategory.AbapRuntime ||
    failure.category === RfcFailureCategory.AbapMessage
  ) {
    return new ABAPError(failure);
  }
  const error = new RFCError(failure.message, {
    name: "RfcLibError",
    group: failure.group,
    code: failure.code as unknown as RFCErrorCode,
    codeString: failure.codeString,
    key: failure.key,
  });
  if (
    failure.category === RfcFailureCategory.MalformedProtocol &&
    failure.reasonCode === "RFC_CPIC_LOGON_RESPONSE_MALFORMED" &&
    failure.codeString === "RFC_INVALID_PROTOCOL"
  ) {
    const assertion = initialCpicLogonStructureAssertion(failure.cause);
    if (assertion !== null) {
      Object.defineProperty(
        error,
        INITIAL_CPIC_LOGON_STRUCTURE_ASSERTION_SYMBOL,
        {
          value: assertion,
          enumerable: false,
          configurable: false,
          writable: false,
        },
      );
      INITIAL_CPIC_LOGON_PUBLIC_ERROR_ASSERTIONS.set(error, assertion);
    }
  }
  return error;
}

export class NodeRfcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "nodeRfcError";
  }
}
