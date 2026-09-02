import { types as nodeUtilTypes } from "node:util";

import {
  CpicTag,
  CLASSIC_XRFC_XML_CHUNK_LENGTH,
  DEFAULT_MAX_CPIC_FIELD_COUNT,
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
import { decodeRecursiveXrfcParameterName } from "../values/recursive-xrfc.js";

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

export interface RfcCallbackXrfcValue {
  /** Canonical ABAP parameter name decoded from the xRFC XML root. */
  readonly name: string;
  readonly value: Buffer;
}

export interface RfcCallbackXrfcParameter extends RfcCallbackXrfcValue {
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
  readonly xrfcParameters?: readonly RfcCallbackXrfcValue[];
  /** Mutually exclusive with exports, tables, and xRFC parameters. */
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
  budget?: { retainedBytes: bigint },
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
  if (budget !== undefined) {
    budget.retainedBytes += BigInt(byteLength);
    if (
      budget.retainedBytes > BigInt(DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH)
    ) {
      throw new RangeError(
        `callback response value bytes exceed ` +
          `${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH}`,
      );
    }
  }
  return snapshotUint8Array(value, path, byteLength);
}

function reserveCallbackResponseBytes(
  budget: { retainedBytes: bigint },
  byteLength: bigint,
): void {
  budget.retainedBytes += byteLength;
  if (budget.retainedBytes > BigInt(DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH)) {
    throw new RangeError(
      `callback response value bytes exceed ` +
        `${DEFAULT_MAX_CPIC_FIELD_CHAIN_LENGTH}`,
    );
  }
}

interface CallbackResponseBudget {
  retainedBytes: bigint;
  fieldCount: number;
}

function reserveCallbackResponseFields(
  budget: CallbackResponseBudget,
  count: number,
): void {
  budget.fieldCount += count;
  if (
    !Number.isSafeInteger(budget.fieldCount) ||
    budget.fieldCount > DEFAULT_MAX_CPIC_FIELD_COUNT
  ) {
    throw new RangeError(
      `callback response fields exceed ${DEFAULT_MAX_CPIC_FIELD_COUNT}`,
    );
  }
}

function callbackRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol properties`);
    }
    if (!allowedKeys.includes(key)) {
      throw new Error(`${path} contains unknown field ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return Object.freeze(snapshot) as Readonly<Record<string, unknown>>;
}

function callbackDataProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new TypeError(`${path}.${key} must be an own data property`);
  }
  return record[key];
}

function callbackArrayLength(value: unknown, path: string): number {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    throw new TypeError(`${path}.length must be an own data property`);
  }
  if (descriptor.value > DEFAULT_MAX_CPIC_FIELD_COUNT) {
    throw new RangeError(
      `${path} exceeds ${DEFAULT_MAX_CPIC_FIELD_COUNT} entries`,
    );
  }
  return descriptor.value as number;
}

function snapshotCallbackArray(
  value: unknown,
  path: string,
  knownLength?: number,
): readonly unknown[] {
  const length = knownLength ?? callbackArrayLength(value, path);
  const source = value as readonly unknown[];
  const keys = Reflect.ownKeys(source);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError(`${path} must be a dense array without extra keys`);
  }
  const keySet = new Set<PropertyKey>(keys);
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) {
      throw new TypeError(`${path} must be a dense array without extra keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}[${index}] must be an own data property`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
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
          const value = Buffer.concat(chunks, byteLength);
          const name = decodeRecursiveXrfcParameterName(value);
          if (names.has(name)) {
            throw new Error(`callback CUT request repeats input parameter ${name}`);
          }
          names.add(name);
          xrfcParameters.push(Object.freeze({
            name,
            value,
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
  values: unknown,
  path: string,
  budget: CallbackResponseBudget,
): readonly RfcCallbackNamedValue[] {
  if (values === undefined) return Object.freeze([]);
  const entryCount = callbackArrayLength(values, path);
  reserveCallbackResponseFields(budget, entryCount * 2);
  const entries = snapshotCallbackArray(values, path, entryCount);
  const names = new Set<string>();
  return Object.freeze(Array.from(entries, (entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = callbackRecord(entry, entryPath, ["name", "value"]);
    const name = callbackName(
      callbackDataProperty(record, "name", entryPath) as string,
      `${entryPath}.name`,
      30,
    );
    if (names.has(name)) throw new Error(`${path} repeats ${name}`);
    names.add(name);
    return Object.freeze({
      name,
      value: boundedCallbackSnapshot(
        callbackDataProperty(record, "value", entryPath) as Uint8Array,
        `${entryPath}.value`,
        budget,
      ),
    });
  }));
}

function snapshotTables(
  tables: unknown,
  budget: CallbackResponseBudget,
): readonly RfcCallbackTable[] {
  if (tables === undefined) return Object.freeze([]);
  const tableCount = callbackArrayLength(tables, "callback response tables");
  reserveCallbackResponseFields(budget, tableCount * 2);
  const tableEntries = snapshotCallbackArray(
    tables,
    "callback response tables",
    tableCount,
  );
  const names = new Set<string>();
  return Object.freeze(Array.from(tableEntries, (table, tableIndex) => {
    const tablePath = `callback response tables[${tableIndex}]`;
    const record = callbackRecord(
      table,
      tablePath,
      ["name", "rowByteLength", "rows"],
    );
    const name = callbackName(
      callbackDataProperty(record, "name", tablePath) as string,
      `${tablePath}.name`,
      30,
    );
    if (names.has(name)) throw new Error(`callback response repeats table ${name}`);
    names.add(name);
    const rowByteLength = callbackUint32(
      callbackDataProperty(record, "rowByteLength", tablePath) as number,
      `callback response table ${name} rowByteLength`,
    );
    const rowsPath = `callback response table ${name} rows`;
    const sourceRows = callbackDataProperty(record, "rows", tablePath);
    const rowCount = callbackArrayLength(sourceRows, rowsPath);
    callbackUint32(rowCount, `callback response table ${name} row count`);
    reserveCallbackResponseFields(budget, rowCount);
    if (rowCount !== 0 && rowByteLength === 0) {
      throw new RangeError(
        `callback response table ${name} cannot contain zero-width rows`,
      );
    }
    reserveCallbackResponseBytes(
      budget,
      BigInt(rowByteLength) * BigInt(rowCount),
    );
    const sourceRowSnapshot = snapshotCallbackArray(
      sourceRows,
      rowsPath,
      rowCount,
    );
    const rows = Array.from(sourceRowSnapshot, (row, rowIndex) => {
      const snapshot = boundedCallbackSnapshot(
        row as Uint8Array,
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

function snapshotXrfcValues(
  values: unknown,
  budget: CallbackResponseBudget,
): readonly RfcCallbackXrfcValue[] {
  if (values === undefined) return Object.freeze([]);
  const entryCount = callbackArrayLength(
    values,
    "callback response xRFC parameters",
  );
  reserveCallbackResponseFields(budget, entryCount * 2);
  const entries = snapshotCallbackArray(
    values,
    "callback response xRFC parameters",
    entryCount,
  );
  const names = new Set<string>();
  return Object.freeze(Array.from(entries, (entry, index) => {
    const entryPath = `callback response xRFC parameters[${index}]`;
    const record = callbackRecord(entry, entryPath, ["name", "value"]);
    const name = callbackName(
      callbackDataProperty(record, "name", entryPath) as string,
      `${entryPath}.name`,
      30,
    );
    if (names.has(name)) {
      throw new Error(`callback response repeats xRFC parameter ${name}`);
    }
    names.add(name);
    const value = boundedCallbackSnapshot(
      callbackDataProperty(record, "value", entryPath) as Uint8Array,
      `callback response xRFC parameter ${name} value`,
      budget,
    );
    reserveCallbackResponseFields(
      budget,
      Math.ceil(value.byteLength / CLASSIC_XRFC_XML_CHUNK_LENGTH),
    );
    const rootName = decodeRecursiveXrfcParameterName(value);
    if (rootName !== name) {
      throw new Error(
        `callback response xRFC parameter ${name} has root ${rootName}`,
      );
    }
    return Object.freeze({ name, value });
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
  requestedOutputs?: readonly string[],
): Buffer {
  const responseSnapshot = callbackRecord(
    response,
    "callback response",
    ["exports", "tables", "xrfcParameters", "exception"],
  );
  if (Object.hasOwn(responseSnapshot, "exception")) {
    const exception = responseSnapshot.exception;
    if (typeof exception !== "string") {
      throw new TypeError("callback response exception must be an own string value");
    }
    for (const key of ["exports", "tables", "xrfcParameters"] as const) {
      if (Object.hasOwn(responseSnapshot, key) && responseSnapshot[key] !== undefined) {
        throw new Error(
          `callback exception response must not include ${key}`,
        );
      }
    }
    return encodeCpicRfcCallbackException(exception);
  }
  const budget: CallbackResponseBudget = {
    retainedBytes: 0n,
    fieldCount: 2,
  };
  const exports = snapshotNamedValues(
    responseSnapshot.exports,
    "callback response exports",
    budget,
  );
  const tables = snapshotTables(responseSnapshot.tables, budget);
  const xrfcParameters = snapshotXrfcValues(
    responseSnapshot.xrfcParameters,
    budget,
  );
  const names = new Set(exports.map((entry) => entry.name));
  for (const table of tables) {
    if (names.has(table.name)) {
      throw new Error(`callback response repeats parameter ${table.name}`);
    }
    names.add(table.name);
  }
  for (const parameter of xrfcParameters) {
    if (names.has(parameter.name)) {
      throw new Error(`callback response repeats parameter ${parameter.name}`);
    }
    names.add(parameter.name);
  }
  if (requestedOutputs !== undefined) {
    const requested = new Set<string>();
    for (
      const [index, value] of snapshotCallbackArray(
        requestedOutputs,
        "callback requested outputs",
      ).entries()
    ) {
      const name = callbackName(
        value as string,
        `callback requested outputs[${index}]`,
        30,
      );
      if (requested.has(name)) {
        throw new Error(`callback requested outputs repeats ${name}`);
      }
      requested.add(name);
    }
    for (const name of names) {
      if (!requested.has(name)) {
        throw new Error(
          `callback response parameter ${name} was not requested by the caller`,
        );
      }
    }
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
  for (const parameter of xrfcParameters) {
    fields.push({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) });
    for (
      let offset = 0;
      offset < parameter.value.byteLength;
      offset += CLASSIC_XRFC_XML_CHUNK_LENGTH
    ) {
      fields.push({
        tag: CpicTag.XRfcData,
        value: parameter.value.subarray(
          offset,
          Math.min(
            offset + CLASSIC_XRFC_XML_CHUNK_LENGTH,
            parameter.value.byteLength,
          ),
        ),
      });
    }
    fields.push({ tag: CpicTag.XRfcParameter, value: Buffer.alloc(0) });
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
