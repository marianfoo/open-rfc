import { RFCErrorCode } from "../client/rfc-errors.js";

/*
 * Modified and adapted by open-rfc contributors from the archived Apache-2.0
 * node-rfc v3.3.1 source at commit
 * 9ccc30b717ff6d841fc52618e80de62c67ba58f0, src/ts/sapnwrfc.ts.
 * Pinned upstream attribution:
 * SPDX-FileCopyrightText: 2014 SAP SE Srdjan Boskovic <srdjan.boskovic@sap.com>
 * SPDX-License-Identifier: Apache-2.0
 * The four structural error names below describe open-rfc's compatible error
 * objects; those interface names do not occur in that pinned upstream source.
 */

/**
 * Archived node-rfc's RFC return-code enum. The alias deliberately shares the
 * existing runtime object so `RFCErrorCode` remains stable and public errors
 * use the same numeric domain under either name.
 */
export const RFC_RC = RFCErrorCode;
export type RFC_RC = RFCErrorCode;

/** Status values exposed by archived node-rfc for transactional RFC units. */
export enum RFC_UNIT_STATE {
  RFC_UNIT_NOT_FOUND = 0,
  RFC_UNIT_IN_PROCESS = 1,
  RFC_UNIT_COMMITTED = 2,
  RFC_UNIT_ROLLED_BACK = 3,
  RFC_UNIT_CONFIRMED = 4,
}

/** Archived node-rfc logger component identifiers. */
export enum RfcLoggingClass {
  client = 0,
  pool = 1,
  server = 2,
  throughput = 3,
  nwrfc = 4,
  addon = 5,
}

/** Archived node-rfc logger verbosity values. */
export enum RfcLoggingLevel {
  none = 0,
  fatal = 1,
  error = 2,
  warning = 3,
  info = 4,
  debug = 5,
  all = 6,
}

/** Archived node-rfc metadata direction flags. */
export enum RfcParameterDirection {
  RFC_IMPORT = 0x01,
  RFC_EXPORT = 0x02,
  RFC_CHANGING = RFC_IMPORT | RFC_EXPORT,
  RFC_TABLES = 0x04 | RFC_CHANGING,
}

/** Archived node-rfc SNC quality-of-protection configuration values. */
export enum EnumSncQop {
  DigSig = "1",
  DigSigEnc = "2",
  DigSigEncUserAuth = "3",
  BackendDefault = "8",
  Maximum = "9",
}

/** Archived node-rfc SDK trace configuration values. */
export enum EnumTrace {
  Off = "0",
  Brief = "1",
  Verbose = "2",
  Full = "3",
}

/*
 * The archived declaration names decimal.js directly. A structural branch
 * preserves assignment compatibility for decimal.js values without making it
 * a runtime dependency of the SDK-free package. Metadata-specific encoders
 * remain authoritative about which scalar is admitted for each ABAP field.
 */
interface RfcDecimalLike {
  readonly d: readonly number[] | null;
  readonly e: number;
  readonly s: number;
  toString(): string;
}

/** Scalar value domain named by archived node-rfc's public declarations. */
export type RfcVariable =
  | string
  | number
  | bigint
  | Buffer
  | Date
  | RfcDecimalLike
  | Uint8Array
  | Uint16Array
  | Uint32Array;

export type RfcArray = RfcVariable[];
export type RfcStructure = {
  [key: string]: RfcVariable | RfcStructure | RfcTable;
};
export type RfcTable = Array<RfcVariable | RfcStructure>;
export type RfcTableOfVariables = RfcVariable[];
export type RfcTableOfStructures = RfcStructure[];
export type RfcParameterValue =
  | RfcVariable
  | RfcArray
  | RfcStructure
  | RfcTable;

export interface INodeRfcError extends Error {
  readonly rfmPath?: Readonly<Record<string, string | number>>;
}

export interface IRfcLibError extends Error {
  readonly group: number;
  readonly code: RFC_RC;
  readonly codeString: keyof typeof RFC_RC;
  readonly key: string;
}

export interface IABAPError extends IRfcLibError {
  readonly abapMsgClass: string;
  readonly abapMsgType: string;
  readonly abapMsgNumber: string;
  readonly abapMsgV1: string;
  readonly abapMsgV2: string;
  readonly abapMsgV3: string;
  readonly abapMsgV4: string;
}

/** Structural union for every public error produced by the classic facade. */
export type RfcError = INodeRfcError | IABAPError | IRfcLibError;

/** Runtime identity reported by `environment`, without claiming an SDK. */
export interface NodeRfcEnvironment {
  readonly platform: Readonly<{
    readonly name: string;
    readonly arch: string;
    readonly release: string;
  }>;
  readonly env: Readonly<{
    readonly SAPNWRFC_HOME: string;
    readonly RFC_INI: string;
  }>;
  readonly noderfc: Readonly<{
    readonly version: string;
    readonly implementation: "open-rfc-sdk-free";
    readonly nwrfcsdk: Readonly<{
      readonly major: 0;
      readonly minor: 0;
      readonly patchLevel: 0;
    }>;
  }>;
  readonly versions: Readonly<NodeJS.ProcessVersions>;
}
