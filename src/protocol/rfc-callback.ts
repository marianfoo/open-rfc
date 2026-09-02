import { types as nodeUtilTypes } from "node:util";

import {
  CpicTag,
  DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH,
  decodeCpicFieldChainPrefix,
  encodeCpicFieldChain,
  inspectCpicRequestAppcFraming,
  type CpicField,
  type CpicRequestAppcFraming,
} from "./cpic.js";
import {
  intrinsicUint8ArrayByteLength,
  intrinsicUint8ArrayView,
  snapshotUint8Array,
} from "./bytes.js";
import { MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH } from "./appc.js";
import { assertUnicodeScalarText } from "../values/unicode-scalar.js";
import { decodeSimpleCompressedRfcTableRow } from "./classic-rfc.js";

// Adapted and hardened for TypeScript from open-rfc-go's Apache-2.0
// internal/rfcserver request/response codec and rfc/callback framing at commit
// 92d5d8f6e0a08ff7ac1580f461585cbde2a56939.

export const DEFAULT_MAX_RFC_CALLBACKS_PER_CALL = 64;

export interface RfcCallbackNamedValue {
  readonly name: string;
  readonly value: Buffer;
}

export interface RfcCallbackTable {
  readonly name: string;
  readonly rowByteLength: number;
  readonly rows: readonly Buffer[];
}

export interface RfcCallbackXrfcParameter {
  readonly value: Buffer;
  readonly chunkCount: number;
}

/** Raw classic-RFC values supplied by a server-initiated DESTINATION 'BACK' call. */
export interface RfcCallbackRequest {
  readonly functionName: string;
  readonly kernelRelease: string;
  readonly requestedOutputs: readonly string[];
  readonly imports: readonly RfcCallbackNamedValue[];
  readonly tables: readonly RfcCallbackTable[];
  readonly xrfcParameters: readonly RfcCallbackXrfcParameter[];
}

/** Raw classic-RFC values or one declared exception returned to a callback. */
export interface RfcCallbackResponse {
  readonly exports?: readonly RfcCallbackNamedValue[];
  readonly tables?: readonly RfcCallbackTable[];
  /** Mutually exclusive with exports and tables. */
  readonly exception?: string;
}

export interface RfcCallbackContext {
  readonly callbackIndex: number;
  readonly signal?: AbortSignal;
}

/**
 * A synchronous callback handler. Keeping this boundary synchronous prevents a
 * detached or re-entrant promise from outliving ownership of the RFC session.
 */
export type RfcCallbackHandler = (
  request: RfcCallbackRequest,
  context: RfcCallbackContext,
) => RfcCallbackResponse;

export type RfcCallbackHandlers = Readonly<Record<string, RfcCallbackHandler>>;

const CUT_REQUEST_PREFIX = Buffer.from("05020000", "hex");
const CUT_RESPONSE_PREFIX = Buffer.from("05000000", "hex");
const CUT_PACKET_SENTINEL = Buffer.from("ffff", "hex");
const MAXIMUM_RFC_PACKET_SIZE = 0x8500;

function callbackName(value: string, path: string, maximum: number): string {
  assertUnicodeScalarText(value, path);
  if (
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0") ||
    /[\u0001-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(
      `${path} must contain 1..${maximum} Unicode scalar characters without controls`,
    );
  }
  return value;
}

function decodeCallbackName(
  value: Uint8Array,
  path: string,
  maximum: number,
): string {
  if ((intrinsicUint8ArrayByteLength(value) & 1) !== 0) {
    throw new Error(`${path} must contain an even number of UTF-16LE bytes`);
  }
  const decoded = Buffer.from(
    intrinsicUint8ArrayView(value, path),
  ).toString("utf16le").replace(/[ \0]+$/u, "");
  return callbackName(decoded, path, maximum);
}

function encodeCallbackName(
  value: string,
  path: string,
  maximum: number,
): Buffer {
  return Buffer.from(callbackName(value, path, maximum), "utf16le");
}

function callbackUint32(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${path} must be an unsigned 32-bit integer`);
  }
  return value;
}

function boundedCallbackSnapshot(
  value: Uint8Array,
  path: string,
): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${path} must be a Uint8Array`);
  }
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength > DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH) {
    throw new RangeError(
      `${path} exceeds ${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH} bytes`,
    );
  }
  return snapshotUint8Array(value, path, byteLength);
}

function exactCallbackTrailer(
  payload: Uint8Array,
  prefixLength: number,
  bytesConsumed: number,
): void {
  const trailerOffset = prefixLength + bytesConsumed;
  if (
    payload.byteLength - trailerOffset !== 2 ||
    Buffer.from(payload.subarray(trailerOffset)).readUInt16BE(0) !== CpicTag.End
  ) {
    throw new Error("callback CUT request trailer is invalid");
  }
}

/** True only for the established-session CUT request discriminator. */
export function isCpicRfcCallbackRequest(payload: Uint8Array): boolean {
  if (!(payload instanceof Uint8Array)) return false;
  const view = intrinsicUint8ArrayView(payload, "callback CUT request");
  return view.byteLength >= CUT_REQUEST_PREFIX.byteLength &&
    Buffer.from(
      view.buffer,
      view.byteOffset,
      CUT_REQUEST_PREFIX.byteLength,
    ).equals(CUT_REQUEST_PREFIX);
}

/** Decode one bounded inbound CUT request for callback dispatch. */
export function decodeCpicRfcCallbackRequest(
  payload: Uint8Array,
): RfcCallbackRequest {
  if (!isCpicRfcCallbackRequest(payload)) {
    throw new Error("callback CUT request prefix is invalid");
  }
  const snapshot = boundedCallbackSnapshot(payload, "callback CUT request");
  try {
    const decoded = decodeCpicFieldChainPrefix(
      snapshot.subarray(CUT_REQUEST_PREFIX.byteLength),
      CpicTag.ContextEnd,
      CpicTag.End,
    );
    exactCallbackTrailer(
      snapshot,
      CUT_REQUEST_PREFIX.byteLength,
      decoded.bytesConsumed,
    );

    let functionName: string | undefined;
    let kernelRelease = "";
    const requestedOutputs: string[] = [];
    const imports: RfcCallbackNamedValue[] = [];
    const tables: RfcCallbackTable[] = [];
    const xrfcParameters: RfcCallbackXrfcParameter[] = [];
    const names = new Set<string>();
    let decodedTableBytes = 0n;

    for (let index = 0; index < decoded.fields.length; index += 1) {
      const field = decoded.fields[index]!;
      switch (field.tag) {
        case CpicTag.Kernel:
          if (kernelRelease.length !== 0) {
            throw new Error("callback CUT request repeats its kernel release");
          }
          kernelRelease = decodeCallbackName(field.value, "callback kernel release", 16);
          break;
        case CpicTag.Function:
          if (functionName !== undefined) {
            throw new Error("callback CUT request repeats its function name");
          }
          functionName = decodeCallbackName(field.value, "callback function name", 40);
          break;
        case CpicTag.CallContext:
          if (field.value.byteLength !== 0) {
            throw new Error("callback call-context control must be empty");
          }
          break;
        case CpicTag.RequestedOutput: {
          const name = decodeCallbackName(
            field.value,
            "callback requested output name",
            30,
          );
          if (requestedOutputs.includes(name)) {
            throw new Error(`callback CUT request repeats requested output ${name}`);
          }
          requestedOutputs.push(name);
          break;
        }
        case CpicTag.ParameterName: {
          const valueField = decoded.fields[index + 1];
          if (valueField?.tag !== CpicTag.ParameterValue) {
            throw new Error("callback parameter name is not followed by its value");
          }
          const name = decodeCallbackName(field.value, "callback import name", 30);
          if (names.has(name)) {
            throw new Error(`callback CUT request repeats input parameter ${name}`);
          }
          names.add(name);
          imports.push(Object.freeze({
            name,
            value: Buffer.from(valueField.value),
          }));
          index += 1;
          break;
        }
        case CpicTag.TableName: {
          const headerField = decoded.fields[index + 1];
          if (headerField?.tag !== CpicTag.TableHeader || headerField.value.byteLength !== 8) {
            throw new Error("callback table name is not followed by an eight-byte header");
          }
          const name = decodeCallbackName(field.value, "callback table name", 30);
          if (names.has(name)) {
            throw new Error(`callback CUT request repeats input parameter ${name}`);
          }
          names.add(name);
          const rowByteLength = headerField.value.readUInt32BE(0);
          const rowCount = headerField.value.readUInt32BE(4);
          const rows: Buffer[] = [];
          let tableDecodedBytes = 0n;
          index += 2;
          while (
            rows.length < rowCount &&
            (decoded.fields[index]?.tag === CpicTag.TableContent ||
              decoded.fields[index]?.tag === CpicTag.TableCompr)
          ) {
            const rowField = decoded.fields[index]!;
            const row = rowField.value;
            if (row.byteLength === 0 || row.byteLength > rowByteLength) {
              throw new Error(`callback table ${name} row ${rows.length} has invalid length`);
            }
            const retainedByteLength = rowField.tag === CpicTag.TableCompr
              ? rowByteLength
              : row.byteLength;
            tableDecodedBytes += BigInt(retainedByteLength);
            if (
              tableDecodedBytes > BigInt(DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH)
            ) {
              throw new RangeError(
                `callback table ${name} decoded bytes exceed ` +
                  `${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH}`,
              );
            }
            decodedTableBytes += BigInt(retainedByteLength);
            if (
              decodedTableBytes > BigInt(DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH)
            ) {
              throw new RangeError(
                `callback decoded table bytes exceed ` +
                  `${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH}`,
              );
            }
            rows.push(
              rowField.tag === CpicTag.TableCompr
                ? decodeSimpleCompressedRfcTableRow(
                  row,
                  rowByteLength,
                  name,
                  rows.length,
                )
                : Buffer.from(row),
            );
            index += 1;
          }
          if (rows.length !== rowCount) {
            throw new Error(
              `callback table ${name} declares ${rowCount} rows but found ${rows.length}`,
            );
          }
          tables.push(Object.freeze({
            name,
            rowByteLength,
            rows: Object.freeze(rows),
          }));
          index -= 1;
          break;
        }
        case CpicTag.XRfcParameter: {
          if (field.value.byteLength !== 0) {
            throw new Error("callback xRFC boundary must be empty");
          }
          const chunks: Buffer[] = [];
          let byteLength = 0;
          index += 1;
          while (decoded.fields[index]?.tag === CpicTag.XRfcData) {
            const chunk = decoded.fields[index]!.value;
            if (chunk.byteLength === 0) {
              throw new Error("callback xRFC chunk must not be empty");
            }
            byteLength += chunk.byteLength;
            if (
              !Number.isSafeInteger(byteLength) ||
              byteLength > DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH
            ) {
              throw new RangeError("callback xRFC parameter exceeds its byte limit");
            }
            chunks.push(Buffer.from(chunk));
            index += 1;
          }
          const closing = decoded.fields[index];
          if (
            chunks.length === 0 ||
            closing?.tag !== CpicTag.XRfcParameter ||
            closing.value.byteLength !== 0
          ) {
            throw new Error("callback xRFC parameter lacks its closing boundary");
          }
          xrfcParameters.push(Object.freeze({
            value: Buffer.concat(chunks, byteLength),
            chunkCount: chunks.length,
          }));
          break;
        }
        case CpicTag.End:
          break;
        case CpicTag.ParameterValue:
          throw new Error("callback parameter value has no preceding name");
        case CpicTag.TableHeader:
        case CpicTag.TableContent:
        case CpicTag.TableCompr:
          throw new Error("callback table record has no preceding table name");
        case CpicTag.XRfcData:
          throw new Error("callback xRFC data has no opening boundary");
        default:
          throw new Error(
            `callback CUT request contains unsupported tag 0x${field.tag.toString(16).padStart(4, "0")}`,
          );
      }
    }
    if (functionName === undefined) {
      throw new Error("callback CUT request lacks a function name");
    }
    return Object.freeze({
      functionName,
      kernelRelease,
      requestedOutputs: Object.freeze(requestedOutputs),
      imports: Object.freeze(imports),
      tables: Object.freeze(tables),
      xrfcParameters: Object.freeze(xrfcParameters),
    });
  } finally {
    snapshot.fill(0);
  }
}

function snapshotNamedValues(
  values: readonly RfcCallbackNamedValue[] | undefined,
  path: string,
): readonly RfcCallbackNamedValue[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  const names = new Set<string>();
  return Object.freeze(values.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${path}[${index}] must be an object`);
    }
    const name = callbackName(entry.name, `${path}[${index}].name`, 30);
    if (names.has(name)) throw new Error(`${path} repeats ${name}`);
    names.add(name);
    return Object.freeze({
      name,
      value: boundedCallbackSnapshot(entry.value, `${path}[${index}].value`),
    });
  }));
}

function snapshotTables(
  tables: readonly RfcCallbackTable[] | undefined,
): readonly RfcCallbackTable[] {
  if (tables === undefined) return Object.freeze([]);
  if (!Array.isArray(tables)) {
    throw new TypeError("callback response tables must be an array");
  }
  const names = new Set<string>();
  return Object.freeze(tables.map((table, tableIndex) => {
    if (typeof table !== "object" || table === null || Array.isArray(table)) {
      throw new TypeError(`callback response tables[${tableIndex}] must be an object`);
    }
    const name = callbackName(
      table.name,
      `callback response tables[${tableIndex}].name`,
      30,
    );
    if (names.has(name)) throw new Error(`callback response repeats table ${name}`);
    names.add(name);
    const rowByteLength = callbackUint32(
      table.rowByteLength,
      `callback response table ${name} rowByteLength`,
    );
    if (!Array.isArray(table.rows)) {
      throw new TypeError(`callback response table ${name} rows must be an array`);
    }
    callbackUint32(table.rows.length, `callback response table ${name} row count`);
    const rows = table.rows.map((row: Uint8Array, rowIndex: number) => {
      const snapshot = boundedCallbackSnapshot(
        row,
        `callback response table ${name} row ${rowIndex}`,
      );
      if (snapshot.byteLength !== rowByteLength) {
        throw new RangeError(
          `callback response table ${name} row ${rowIndex} has ${snapshot.byteLength} bytes; expected ${rowByteLength}`,
        );
      }
      return snapshot;
    });
    return Object.freeze({ name, rowByteLength, rows: Object.freeze(rows) });
  }));
}

function encodeCallbackEnvelope(fields: readonly CpicField[]): Buffer {
  return Buffer.concat([
    CUT_RESPONSE_PREFIX,
    encodeCpicFieldChain(CpicTag.ResponseStart, fields),
    CUT_PACKET_SENTINEL,
  ]);
}

/** Encode one raw successful callback response before APPC framing. */
export function encodeCpicRfcCallbackResponse(
  response: RfcCallbackResponse,
): Buffer {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new TypeError("callback response must be an object");
  }
  const exception = Object.getOwnPropertyDescriptor(response, "exception");
  if (exception !== undefined) {
    if (!("value" in exception) || typeof exception.value !== "string") {
      throw new TypeError("callback response exception must be an own string value");
    }
    for (const key of ["exports", "tables"] as const) {
      const conflicting = Object.getOwnPropertyDescriptor(response, key);
      if (
        conflicting !== undefined &&
        (!("value" in conflicting) || conflicting.value !== undefined)
      ) {
        throw new Error(
          `callback exception response must not include ${key}`,
        );
      }
    }
    return encodeCpicRfcCallbackException(exception.value);
  }
  const exports = snapshotNamedValues(response.exports, "callback response exports");
  const tables = snapshotTables(response.tables);
  const names = new Set(exports.map((entry) => entry.name));
  for (const table of tables) {
    if (names.has(table.name)) {
      throw new Error(`callback response repeats parameter ${table.name}`);
    }
    names.add(table.name);
  }
  const fields: CpicField[] = [
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
  ];
  for (const entry of exports) {
    fields.push(
      {
        tag: CpicTag.ParameterName,
        value: encodeCallbackName(entry.name, "callback export name", 30),
      },
      { tag: CpicTag.ParameterValue, value: entry.value },
    );
  }
  for (const table of tables) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(table.rowByteLength, 0);
    header.writeUInt32BE(table.rows.length, 4);
    fields.push(
      {
        tag: CpicTag.TableName,
        value: encodeCallbackName(table.name, "callback table name", 30),
      },
      { tag: CpicTag.TableHeader, value: header },
      ...table.rows.map((row) => ({ tag: CpicTag.TableCompr, value: row })),
    );
  }
  fields.push({ tag: CpicTag.End, value: Buffer.alloc(0) });
  return encodeCallbackEnvelope(fields);
}

/** Encode a declared callback exception such as FU_NOT_FOUND. */
export function encodeCpicRfcCallbackException(exceptionKey: string): Buffer {
  return encodeCallbackEnvelope([
    {
      tag: CpicTag.AbapExceptionKey,
      value: encodeCallbackName(exceptionKey, "callback exception key", 30),
    },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ]);
}

/** Add the compact SAP8 trailer, or retain the streamed sentinel for large replies. */
export function frameCpicRfcCallbackResponse(
  response: Uint8Array,
): Buffer {
  const snapshot = boundedCallbackSnapshot(response, "callback CUT response");
  if (
    snapshot.byteLength < 2 ||
    snapshot.readUInt16BE(snapshot.byteLength - 2) !== CpicTag.End
  ) {
    throw new Error("callback CUT response lacks its packet sentinel");
  }
  let framed = snapshot;
  if (snapshot.byteLength <= MAX_APPC_APPLICATION_DATA_FRAGMENT_LENGTH) {
    const finalSap = Buffer.alloc(8);
    finalSap.writeUInt16BE(0, 0);
    finalSap.writeUInt16BE(snapshot.byteLength, 2);
    finalSap.writeUInt32BE(MAXIMUM_RFC_PACKET_SIZE, 4);
    framed = Buffer.concat([snapshot, finalSap]);
  }
  // Keep the framing function and the session planner aligned by validating
  // the exact envelope here as well as at the eventual send boundary.
  inspectCpicRequestAppcFraming(framed);
  return framed;
}

/** Snapshot a public handler table once before any networking starts. */
export function snapshotRfcCallbackHandlers(
  handlers: RfcCallbackHandlers | undefined,
  path = "callbacks",
): ReadonlyMap<string, RfcCallbackHandler> | undefined {
  if (handlers === undefined) return undefined;
  if (
    typeof handlers !== "object" ||
    handlers === null ||
    Array.isArray(handlers) ||
    nodeUtilTypes.isProxy(handlers)
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(handlers);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const names = Reflect.ownKeys(handlers);
  if (names.length > DEFAULT_MAX_RFC_CALLBACKS_PER_CALL) {
    throw new RangeError(
      `${path} contains more than ${DEFAULT_MAX_RFC_CALLBACKS_PER_CALL} handlers`,
    );
  }
  const snapshot = new Map<string, RfcCallbackHandler>();
  for (const key of names) {
    if (typeof key !== "string") throw new TypeError(`${path} keys must be strings`);
    const name = callbackName(key, `${path} function name`, 40);
    const descriptor = Object.getOwnPropertyDescriptor(handlers, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
    if (typeof descriptor.value !== "function") {
      throw new TypeError(`${path}.${key} must be a function`);
    }
    snapshot.set(name, descriptor.value as RfcCallbackHandler);
  }
  return snapshot;
}

/** @internal Assert callback response framing without exposing protocol helpers at package root. */
export function inspectFramedCpicRfcCallbackResponse(
  response: Uint8Array,
): CpicRequestAppcFraming {
  return inspectCpicRequestAppcFraming(response);
}
