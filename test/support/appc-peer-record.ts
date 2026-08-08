import {
  APPC_RECORD_HEADER_LENGTH,
  encodeAppcDataRecord,
  type AppcDataRecordInput,
} from "../../src/protocol/appc.js";

/** Encode the server data-buffer layout used by deterministic peer fixtures. */
export function encodeIncomingAppcDataRecord(
  input: AppcDataRecordInput,
  options: { readonly bufferCapacity?: number } = {},
): Buffer {
  const record = encodeAppcDataRecord(input);
  const dataLength = record.byteLength - APPC_RECORD_HEADER_LENGTH;
  record.writeUInt16BE(options.bufferCapacity ?? 34_048, 50);
  record.writeUInt16BE(dataLength, 58);
  return record;
}
