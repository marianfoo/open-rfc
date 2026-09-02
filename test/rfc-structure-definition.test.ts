import assert from "node:assert/strict";
import test from "node:test";

import {
  RFC_FIELDS_UNICODE_ROW_LENGTH,
  decodeRfcStructureDefinitionResult,
} from "../src/metadata/rfc-structure-definition.js";
import { encodeAbapChar } from "../src/protocol/classic-rfc.js";
import { CpicTag, type CpicField } from "../src/protocol/cpic.js";

interface FieldInput {
  readonly name: string;
  readonly position: number;
  readonly offset: number;
  readonly length: number;
}

function fieldRow(input: FieldInput): Buffer {
  const row = Buffer.alloc(RFC_FIELDS_UNICODE_ROW_LENGTH);
  encodeAbapChar("Z_INCLUDED", 30).copy(row, 0);
  encodeAbapChar(input.name, 30).copy(row, 60);
  row.writeInt32LE(input.position, 120);
  row.writeInt32LE(input.offset, 124);
  row.writeInt32LE(input.length, 128);
  row.writeInt32LE(0, 132);
  encodeAbapChar("C", 1).copy(row, 136);
  return row;
}

function resultFields(rows: readonly Buffer[], byteLength = 12): readonly CpicField[] {
  const length = Buffer.alloc(4);
  length.writeInt32LE(byteLength);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(RFC_FIELDS_UNICODE_ROW_LENGTH, 0);
  header.writeUInt32BE(rows.length, 4);
  return [
    { tag: CpicTag.ParameterName, value: encodeAbapChar("TABLENGTH", 9) },
    { tag: CpicTag.ParameterValue, value: length },
    { tag: CpicTag.TableName, value: encodeAbapChar("FIELDS", 6) },
    { tag: CpicTag.TableHeader, value: header },
    ...rows.map((value) => ({ tag: CpicTag.TableContent, value })),
  ];
}

test("normalizes non-dense RFC_FIELDS positions from included structures", () => {
  const definition = decodeRfcStructureDefinitionResult(
    "Z_INCLUDED",
    resultFields([
      fieldRow({ name: "HEAD", position: 4, offset: 0, length: 4 }),
      fieldRow({ name: "INCLUDED_A", position: 1, offset: 4, length: 4 }),
      fieldRow({ name: "INCLUDED_B", position: 1, offset: 8, length: 4 }),
    ]),
  );

  assert.deepEqual(
    definition.fields.map(({ fieldName, position, offset }) => ({
      fieldName,
      position,
      offset,
    })),
    [
      { fieldName: "HEAD", position: 1, offset: 0 },
      { fieldName: "INCLUDED_A", position: 2, offset: 4 },
      { fieldName: "INCLUDED_B", position: 3, offset: 8 },
    ],
  );
});

test("keeps structural geometry authoritative after position normalization", () => {
  assert.throws(
    () => decodeRfcStructureDefinitionResult(
      "Z_INCLUDED",
      resultFields([
        fieldRow({ name: "FIRST", position: 8, offset: 0, length: 8 }),
        fieldRow({ name: "SECOND", position: 8, offset: 4, length: 4 }),
      ]),
    ),
    /overlaps/u,
  );
  assert.throws(
    () => decodeRfcStructureDefinitionResult(
      "Z_INCLUDED",
      resultFields([
        fieldRow({ name: "DUP", position: 9, offset: 0, length: 4 }),
        fieldRow({ name: "DUP", position: 2, offset: 4, length: 4 }),
      ]),
    ),
    /duplicate field/u,
  );
  assert.throws(
    () => decodeRfcStructureDefinitionResult(
      "Z_INCLUDED",
      resultFields([
        fieldRow({ name: "TOO_LONG", position: 3, offset: 8, length: 8 }),
      ]),
    ),
    /beyond structure length/u,
  );
});
