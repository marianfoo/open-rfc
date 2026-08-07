import {
  RFC_FUNINT_UNICODE_ROW_LENGTH,
  decodeAbapChar,
  decodeClassicRfcResult,
  decodeRfcFunintRow,
  encodeAbapChar,
  type RfcFunintParameter,
} from "../protocol/classic-rfc.js";
import {
  encodeCpicCutFunctionRequest,
  type CpicField,
} from "../protocol/cpic.js";

const FUNCTION_INTERFACE_OUTPUTS = [
  "REMOTE_BASXML_SUPPORTED",
  "REMOTE_CALL",
  "UPDATE_TASK",
  "PARAMS",
  "RESUMABLE_EXCEPTIONS",
] as const;

export interface RfcFunctionInterface {
  readonly name: string;
  readonly remoteBasxmlSupported: boolean;
  readonly remoteCall: string;
  readonly updateTask: boolean;
  readonly parameters: readonly RfcFunintParameter[];
  readonly exceptions: readonly string[];
  readonly resumableExceptionRowCount: number;
}

/** Build the classic metadata bootstrap call without requiring prior metadata. */
export function buildRfcGetFunctionInterfaceRequest(functionName: string): Buffer {
  return encodeCpicCutFunctionRequest({
    functionName: "RFC_GET_FUNCTION_INTERFACE",
    requestedOutputs: FUNCTION_INTERFACE_OUTPUTS,
    imports: [
      { name: "FUNCNAME", value: encodeAbapChar(functionName, 30) },
      { name: "NONE_UNICODE_LENGTH", value: encodeAbapChar("X", 1) },
    ],
  });
}

function requiredScalar(
  scalars: ReadonlyArray<{ readonly name: string; readonly value: Buffer }>,
  name: string,
): Buffer {
  const result = scalars.find((scalar) => scalar.name === name);
  if (result === undefined) {
    throw new Error(`RFC_GET_FUNCTION_INTERFACE response lacks scalar ${name}`);
  }
  return result.value;
}

function flag(value: Uint8Array, name: string): boolean {
  const decoded = decodeAbapChar(value, 1);
  if (decoded !== "" && decoded !== "X") {
    throw new Error(`${name} contains unsupported flag value ${decoded}`);
  }
  return decoded === "X";
}

/** Normalize a successful RFC_GET_FUNCTION_INTERFACE classic response. */
export function decodeRfcFunctionInterfaceResult(
  functionName: string,
  fields: readonly CpicField[],
): RfcFunctionInterface {
  const result = decodeClassicRfcResult(fields);
  const params = result.tables.find((table) => table.name === "PARAMS");
  if (params === undefined) {
    throw new Error("RFC_GET_FUNCTION_INTERFACE response lacks PARAMS table");
  }
  // `rowByteLength` is the first row's own width, or the declared width when
  // the table is empty. Both grow with the peer's release - a 404-byte
  // declaration is already evidenced - so bound the width below by the stable
  // prefix the row decoder consumes instead of pinning it. Narrower rows are
  // still refused. This replaces an explicit 402/404 exception that only held
  // for an empty table; a populated table on the same release would have
  // failed every metadata lookup.
  if (params.rowByteLength < RFC_FUNINT_UNICODE_ROW_LENGTH) {
    throw new Error(
      `RFC_GET_FUNCTION_INTERFACE PARAMS row width is ${params.rowByteLength}; ` +
        `expected at least ${RFC_FUNINT_UNICODE_ROW_LENGTH}`,
    );
  }
  const resumableExceptions = result.tables.find(
    (table) => table.name === "RESUMABLE_EXCEPTIONS",
  );
  if (resumableExceptions === undefined) {
    throw new Error(
      "RFC_GET_FUNCTION_INTERFACE response lacks RESUMABLE_EXCEPTIONS table",
    );
  }

  const rows = params.rows.map((row) => decodeRfcFunintRow(row));
  const parameters = rows
    .filter((parameter) => parameter.parameterClass !== "X")
    .map((parameter) => Object.freeze(parameter));
  const exceptions = rows
    .filter((parameter) => parameter.parameterClass === "X")
    .map((parameter) => parameter.parameterName);
  return Object.freeze({
    name: functionName,
    remoteBasxmlSupported: flag(
      requiredScalar(result.scalars, "REMOTE_BASXML_SUPPORTED"),
      "REMOTE_BASXML_SUPPORTED",
    ),
    remoteCall: decodeAbapChar(
      requiredScalar(result.scalars, "REMOTE_CALL"),
      1,
    ),
    updateTask: flag(
      requiredScalar(result.scalars, "UPDATE_TASK"),
      "UPDATE_TASK",
    ),
    parameters: Object.freeze(parameters),
    exceptions: Object.freeze(exceptions),
    resumableExceptionRowCount: resumableExceptions.rows.length,
  });
}
