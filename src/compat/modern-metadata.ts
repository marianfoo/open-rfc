import type { RfcFunintParameter } from "../protocol/classic-rfc.js";
import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import type {
  RfcStructureDefinition,
  RfcStructureField,
} from "../metadata/rfc-structure-definition.js";
import type {
  RecursiveMetadataField,
  RecursiveMetadataGraph,
  RecursiveMetadataParameter,
  RecursiveMetadataTypeNode,
} from "../metadata/recursive-metadata.js";

export type ModernMetadataParameter = Readonly<Record<string, unknown>>;

export interface ModernRfcMetadata {
  readonly rfcName: string;
  readonly import: readonly ModernMetadataParameter[];
  readonly export: readonly ModernMetadataParameter[];
  readonly changing: readonly ModernMetadataParameter[];
  readonly table: readonly ModernMetadataParameter[];
}

export interface ModernMetadataProjectionOptions {
  /** Maximum number of parameter and field descriptors emitted after unfolding. */
  readonly maxProjectedDescriptors?: number;
  /** Maximum nested structure/table depth in the emitted JSON tree. */
  readonly maxProjectionDepth?: number;
}

export class ModernMetadataProjectionError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string) {
    super(`modern metadata projection rejected: ${code} at ${path}`);
    this.name = "ModernMetadataProjectionError";
    this.code = code;
    this.path = path;
  }
}

const RFC_TYPE: Readonly<Record<string, string>> = Object.freeze({
  C: "RFCTYPE_CHAR", N: "RFCTYPE_NUM", D: "RFCTYPE_DATE",
  T: "RFCTYPE_TIME", X: "RFCTYPE_BYTE", P: "RFCTYPE_BCD",
  F: "RFCTYPE_FLOAT", I: "RFCTYPE_INT", b: "RFCTYPE_INT1",
  s: "RFCTYPE_INT2", "8": "RFCTYPE_INT8", a: "RFCTYPE_DECF16",
  e: "RFCTYPE_DECF34", p: "RFCTYPE_UTCLONG", g: "RFCTYPE_STRING",
  n: "RFCTYPE_UTCSECOND", w: "RFCTYPE_UTCMINUTE", d: "RFCTYPE_DTDAY",
  "7": "RFCTYPE_DTWEEK", x: "RFCTYPE_DTMONTH", t: "RFCTYPE_TSECOND",
  i: "RFCTYPE_TMINUTE", c: "RFCTYPE_CDAY",
  y: "RFCTYPE_XSTRING",
  u: "RFCTYPE_STRUCTURE",
});

const ABAP_TYPE: Readonly<Record<string, string>> = Object.freeze({
  C: "c", N: "n", D: "d", T: "t", X: "x", P: "p", F: "f",
  I: "i", b: "b", s: "s", "8": "8", a: "a", e: "e", p: "p",
  n: "n", w: "w", d: "d", "7": "7", x: "x", t: "t", i: "i",
  c: "c", g: "g", y: "y", u: "u",
});

function format(exid: string): string {
  if (exid === "D") return "YYYYMMDD";
  if (exid === "T") return "HHMMSS";
  return "";
}

function typeName(exid: string): string {
  const name = RFC_TYPE[exid];
  if (name === undefined) throw new Error(`metadata type ${exid} is not implemented`);
  return name;
}

function abapType(exid: string): string {
  const name = ABAP_TYPE[exid];
  if (name === undefined) throw new Error(`ABAP metadata type ${exid} is not implemented`);
  return name;
}

function fieldLength(field: RfcStructureField): number {
  if (["C", "N", "D", "T"].includes(field.exid)) {
    if (field.internalLength % 2 !== 0) {
      throw new Error(`${field.fieldName} has an odd Unicode character width`);
    }
    return field.internalLength / 2;
  }
  return field.internalLength;
}

function nucAlignment(exid: string): number {
  switch (exid) {
    case "s":
    case "i":
    case "c":
      return 2;
    case "I":
    case "d":
    case "7":
    case "x":
    case "t":
      return 4;
    case "8":
    case "F":
    case "a":
    case "p":
    case "n":
    case "w":
      return 8;
    case "e":
      return 16;
    default:
      return 1;
  }
}

function alignedOffset(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment;
}

function fieldMetadata(
  field: RfcStructureField,
  offset: number,
): ModernMetadataParameter {
  return Object.freeze({
    name: field.fieldName,
    nwrfcType: typeName(field.exid),
    abapType: abapType(field.exid),
    format: format(field.exid),
    length: fieldLength(field),
    decimals: field.decimals,
    offset,
  });
}

function structureFieldsMetadata(
  structure: RfcStructureDefinition,
): readonly ModernMetadataParameter[] {
  const result: ModernMetadataParameter[] = [];
  let end = 0;
  for (const field of structure.fields) {
    const offset = alignedOffset(end, nucAlignment(field.exid));
    const length = fieldLength(field);
    result.push(fieldMetadata(field, offset));
    end = offset + length;
  }
  return Object.freeze(result);
}

function scalarTableFieldMetadata(
  parameter: RfcFunintParameter,
): ModernMetadataParameter {
  if (parameter.exid === "u") {
    throw new Error(
      `${parameter.parameterName} structure TABLES parameter lacks a resolved line type`,
    );
  }
  return Object.freeze({
    name: "",
    nwrfcType: typeName(parameter.exid),
    abapType: abapType(parameter.exid),
    format: format(parameter.exid),
    length: parameter.internalLength,
    decimals: parameter.decimals,
    offset: 0,
  });
}

function parameterMetadata(
  parameter: RfcFunintParameter,
  structure: RfcStructureDefinition | undefined,
): ModernMetadataParameter {
  if (parameter.exid === "u" && structure === undefined) {
    throw new Error(
      `${parameter.parameterName} structure metadata lacks a resolved definition`,
    );
  }
  const table = parameter.parameterClass === "T";
  const metadata: Record<string, unknown> = {
    name: parameter.parameterName,
    nwrfcType: table ? "RFCTYPE_TABLE" : typeName(parameter.exid),
    abapType: table ? "h" : abapType(parameter.exid),
    format: format(parameter.exid),
    length: parameter.internalLength,
    decimals: parameter.decimals,
  };
  // A classic scalar TABLES line can carry a DDIC table name even though the
  // wire rows are elementary values. Advertising that name as associatedType
  // makes the pinned @sap/cds-rfc importer model rows as wrapper structures.
  // Preserve associated types only for actual structures; scalar tables retain
  // their anonymous line descriptor and therefore validate as scalar arrays.
  if (parameter.tableName.length > 0 && parameter.exid === "u") {
    metadata.associatedType = parameter.tableName;
  }
  if (structure !== undefined) {
    metadata[table ? "tableFields" : "fields"] =
      structureFieldsMetadata(structure);
  } else if (table) {
    metadata.tableFields = Object.freeze([
      scalarTableFieldMetadata(parameter),
    ]);
  }
  metadata.defaultValue = parameter.defaultValue;
  metadata.parameterText = parameter.parameterText;
  metadata.optional = parameter.optional;
  return Object.freeze(metadata);
}

/** Convert classic metadata into the JSON shape consumed by @sap/cds-rfc. */
export function toModernRfcMetadata(
  metadata: RfcFunctionInterface,
  structures: ReadonlyMap<string, RfcStructureDefinition>,
  options: Pick<ModernMetadataProjectionOptions, "maxProjectedDescriptors"> = {},
): ModernRfcMetadata {
  const maxProjectedDescriptors = projectionLimit(
    options.maxProjectedDescriptors,
    DEFAULT_MAX_PROJECTED_DESCRIPTORS,
    ABSOLUTE_MAX_PROJECTED_DESCRIPTORS,
    "options.maxProjectedDescriptors",
  );
  let projectedDescriptors = 0;
  for (const [parameterIndex, parameter] of metadata.parameters.entries()) {
    const structure = parameter.tableName.length === 0
      ? undefined
      : structures.get(parameter.tableName);
    projectedDescriptors += 1 + (structure?.fields.length ??
      (parameter.parameterClass === "T" ? 1 : 0));
    if (projectedDescriptors > maxProjectedDescriptors) {
      rejectProjection(
        "PROJECTION_LIMIT",
        `metadata.parameters[${parameterIndex}]`,
      );
    }
  }
  const groups: Record<"import" | "export" | "changing" | "table", ModernMetadataParameter[]> = {
    import: [], export: [], changing: [], table: [],
  };
  for (const parameter of metadata.parameters) {
    const structure = parameter.tableName.length === 0
      ? undefined
      : structures.get(parameter.tableName);
    const converted = parameterMetadata(parameter, structure);
    if (parameter.parameterClass === "I") groups.import.push(converted);
    else if (parameter.parameterClass === "E") groups.export.push(converted);
    else if (parameter.parameterClass === "C") groups.changing.push(converted);
    else if (parameter.parameterClass === "T") groups.table.push(converted);
    else throw new Error(`unsupported metadata parameter class ${parameter.parameterClass}`);
  }
  return Object.freeze({
    rfcName: metadata.name,
    import: Object.freeze(groups.import),
    export: Object.freeze(groups.export),
    changing: Object.freeze(groups.changing),
    table: Object.freeze(groups.table),
  });
}

const DEFAULT_MAX_PROJECTED_DESCRIPTORS = 100_000;
const ABSOLUTE_MAX_PROJECTED_DESCRIPTORS = 1_000_000;
const DEFAULT_MAX_PROJECTION_DEPTH = 64;
const ABSOLUTE_MAX_PROJECTION_DEPTH = 256;

interface ProjectionContext {
  readonly graph: RecursiveMetadataGraph;
  readonly maxProjectedDescriptors: number;
  readonly maxProjectionDepth: number;
  projectedDescriptors: number;
}

interface ProjectedTableLine {
  readonly length: number;
  readonly fields: readonly ModernMetadataParameter[];
}

function rejectProjection(code: string, path: string): never {
  throw new ModernMetadataProjectionError(code, path);
}

function projectionLimit(
  candidate: number | undefined,
  fallback: number,
  maximum: number,
  path: string,
): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    rejectProjection("INVALID_LIMIT", path);
  }
  return value;
}

function consumeDescriptor(context: ProjectionContext, path: string): void {
  context.projectedDescriptors += 1;
  if (context.projectedDescriptors > context.maxProjectedDescriptors) {
    rejectProjection("PROJECTION_LIMIT", path);
  }
}

function assertProjectionDepth(
  context: ProjectionContext,
  depth: number,
  path: string,
): void {
  if (depth > context.maxProjectionDepth) {
    rejectProjection("DEPTH_LIMIT", path);
  }
}

function referencedNode(
  context: ProjectionContext,
  typeNameValue: string,
  path: string,
): RecursiveMetadataTypeNode {
  const node = context.graph.nodes.get(typeNameValue);
  if (node === undefined) rejectProjection("FOREIGN_TYPE", path);
  return node;
}

function orderedFields(
  fields: readonly RecursiveMetadataField[],
): readonly RecursiveMetadataField[] {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((left, right) =>
      left.field.position - right.field.position || left.index - right.index)
    .map(({ field }) => field);
}

function scalarParameterNucLength(
  internalType: string,
  internalLength: number,
  path: string,
): number {
  if (!["C", "N", "D", "T"].includes(internalType)) return internalLength;
  if ((internalLength & 1) !== 0) {
    rejectProjection("INVALID_NUC_LENGTH", path);
  }
  return internalLength / 2;
}

function scalarMetadata(
  name: string,
  internalType: string,
  length: number,
  decimals: number,
  path: string,
): Record<string, unknown> {
  const nwrfcType = RFC_TYPE[internalType];
  const projectedAbapType = ABAP_TYPE[internalType];
  if (nwrfcType === undefined || projectedAbapType === undefined) {
    rejectProjection("UNSUPPORTED_SCALAR_TYPE", path);
  }
  return {
    name,
    nwrfcType,
    abapType: projectedAbapType,
    format: format(internalType),
    length,
    decimals,
  };
}

function projectStructureFields(
  context: ProjectionContext,
  node: RecursiveMetadataTypeNode,
  depth: number,
  path: string,
): readonly ModernMetadataParameter[] {
  if (node.kind !== "structure") {
    rejectProjection("REFERENCE_KIND_MISMATCH", path);
  }
  return Object.freeze(orderedFields(node.fields).map((field, index) =>
    projectField(context, field, depth, `${path}.fields[${index}]`)));
}

function projectTableLine(
  context: ProjectionContext,
  node: RecursiveMetadataTypeNode,
  depth: number,
  path: string,
): ProjectedTableLine {
  assertProjectionDepth(context, depth, path);
  if (node.kind === "structure") {
    return Object.freeze({
      length: node.nucLength,
      fields: projectStructureFields(context, node, depth, path),
    });
  }
  if (node.fields.length !== 1 || node.fields[0]!.name !== "") {
    rejectProjection("INVALID_TABLE_LINE", path);
  }
  const line = node.fields[0]!;
  if (line.reference.kind === "structure") {
    const target = referencedNode(
      context,
      line.reference.targetType,
      `${path}.line`,
    );
    if (target.kind !== "structure") {
      rejectProjection("REFERENCE_KIND_MISMATCH", `${path}.line`);
    }
    return Object.freeze({
      length: target.nucLength,
      fields: projectStructureFields(context, target, depth, `${path}.line`),
    });
  }
  return Object.freeze({
    length: line.nucLength,
    fields: Object.freeze([
      projectField(context, line, depth, `${path}.line`),
    ]),
  });
}

function projectField(
  context: ProjectionContext,
  field: RecursiveMetadataField,
  depth: number,
  path: string,
): ModernMetadataParameter {
  assertProjectionDepth(context, depth, path);
  consumeDescriptor(context, path);
  const metadata = field.reference.kind === "scalar"
    ? scalarMetadata(
        field.name,
        field.internalType,
        field.nucLength,
        field.decimals,
        path,
      )
    : {
        name: field.name,
        nwrfcType: field.reference.kind === "structure"
          ? "RFCTYPE_STRUCTURE"
          : "RFCTYPE_TABLE",
        abapType: field.reference.kind === "structure" ? "u" : "h",
        format: "",
        length: field.nucLength,
        decimals: field.decimals,
      };
  if (field.reference.kind === "structure") {
    const target = referencedNode(context, field.reference.targetType, path);
    metadata.associatedType = field.reference.targetType;
    metadata.fields = projectStructureFields(
      context,
      target,
      depth + 1,
      path,
    );
  } else if (field.reference.kind === "table") {
    const target = referencedNode(context, field.reference.targetType, path);
    if (target.kind !== "table") {
      rejectProjection("REFERENCE_KIND_MISMATCH", path);
    }
    const line = projectTableLine(context, target, depth + 1, path);
    metadata.associatedType = field.reference.targetType;
    metadata.tableFields = line.fields;
  }
  metadata.offset = field.nucOffset;
  return Object.freeze(metadata);
}

function projectSyntheticScalarTableLine(
  context: ProjectionContext,
  parameter: RecursiveMetadataParameter,
  internalType: string,
  path: string,
): ProjectedTableLine {
  assertProjectionDepth(context, 1, `${path}.line`);
  consumeDescriptor(context, `${path}.line`);
  const length = scalarParameterNucLength(
    internalType,
    parameter.internalLength,
    `${path}.length`,
  );
  return Object.freeze({
    length,
    fields: Object.freeze([
      Object.freeze({
        ...scalarMetadata(
          "",
          internalType,
          length,
          parameter.decimals,
          `${path}.line`,
        ),
        offset: 0,
      }),
    ]),
  });
}

function projectParameter(
  context: ProjectionContext,
  parameter: RecursiveMetadataParameter,
  path: string,
): ModernMetadataParameter {
  consumeDescriptor(context, path);
  const reference = parameter.reference;
  let metadata: Record<string, unknown>;
  if (reference.kind === "scalar") {
    metadata = scalarMetadata(
      parameter.name,
      reference.internalType,
      scalarParameterNucLength(
        reference.internalType,
        parameter.internalLength,
        `${path}.length`,
      ),
      parameter.decimals,
      path,
    );
  } else if (reference.kind === "structure") {
    const target = referencedNode(context, reference.targetType, path);
    if (target.kind !== "structure") {
      rejectProjection("REFERENCE_KIND_MISMATCH", path);
    }
    metadata = {
      name: parameter.name,
      nwrfcType: "RFCTYPE_STRUCTURE",
      abapType: "u",
      format: "",
      length: target.nucLength,
      decimals: parameter.decimals,
      associatedType: reference.targetType,
      fields: projectStructureFields(context, target, 1, path),
    };
  } else if (reference.kind === "table") {
    const line = "scalarLine" in reference
      ? projectSyntheticScalarTableLine(
          context,
          parameter,
          reference.scalarLine.internalType,
          path,
        )
      : projectTableLine(
          context,
          referencedNode(context, reference.targetType, path),
          1,
          path,
        );
    metadata = {
      name: parameter.name,
      nwrfcType: "RFCTYPE_TABLE",
      abapType: "h",
      format: "",
      length: line.length,
      decimals: parameter.decimals,
    };
    const associatedType = "targetType" in reference
      ? reference.targetType
      : parameter.associatedType;
    if (associatedType.length > 0) metadata.associatedType = associatedType;
    metadata.tableFields = line.fields;
  } else {
    rejectProjection("REFERENCE_KIND_MISMATCH", path);
  }
  metadata.defaultValue = parameter.defaultValue;
  metadata.parameterText = parameter.parameterText;
  metadata.optional = parameter.optional;
  return Object.freeze(metadata);
}

function validateProjectionGraph(graph: RecursiveMetadataGraph): string {
  if (graph.version !== 1) rejectProjection("INVALID_GRAPH_VERSION", "graph");
  if (graph.cycles.length > 0) rejectProjection("CYCLIC_GRAPH", "graph.cycles");
  for (let index = 0; index < graph.rootTypeNames.length; index += 1) {
    if (!graph.nodes.has(graph.rootTypeNames[index]!)) {
      rejectProjection("FOREIGN_TYPE", `graph.rootTypeNames[${index}]`);
    }
  }
  for (const [key, node] of graph.nodes) {
    if (key !== node.name) rejectProjection("INVALID_NODE_IDENTITY", "graph.nodes");
    for (let index = 0; index < node.fields.length; index += 1) {
      const reference = node.fields[index]!.reference;
      if (reference.kind === "scalar") continue;
      if (reference.cyclic) rejectProjection("CYCLIC_GRAPH", "graph.nodes");
      const target = graph.nodes.get(reference.targetType);
      if (target === undefined) rejectProjection("FOREIGN_TYPE", "graph.nodes");
      if (target.kind !== reference.kind) {
        rejectProjection("REFERENCE_KIND_MISMATCH", "graph.nodes");
      }
    }
  }
  const functionNames = new Set<string>();
  for (let index = 0; index < graph.parameters.length; index += 1) {
    const parameter = graph.parameters[index]!;
    functionNames.add(parameter.functionName);
    if (parameter.parameterClass === "X") {
      if (parameter.reference.kind !== "exception") {
        rejectProjection("REFERENCE_KIND_MISMATCH", `graph.parameters[${index}]`);
      }
      continue;
    }
    if (
      parameter.parameterClass === "T" &&
      parameter.reference.kind !== "table"
    ) {
      rejectProjection("REFERENCE_KIND_MISMATCH", `graph.parameters[${index}]`);
    }
    if (parameter.reference.kind === "exception") {
      rejectProjection("REFERENCE_KIND_MISMATCH", `graph.parameters[${index}]`);
    }
    if (
      parameter.reference.kind === "structure" ||
      (parameter.reference.kind === "table" && "targetType" in parameter.reference)
    ) {
      if (parameter.reference.cyclic) {
        rejectProjection("CYCLIC_GRAPH", `graph.parameters[${index}]`);
      }
      if (!graph.nodes.has(parameter.reference.targetType)) {
        rejectProjection("FOREIGN_TYPE", `graph.parameters[${index}]`);
      }
    }
  }
  if (functionNames.size > 1) {
    rejectProjection("MULTIPLE_FUNCTIONS", "graph.parameters");
  }
  if (graph.functionIdentity !== undefined) {
    if (
      functionNames.size === 1 &&
      !functionNames.has(graph.functionIdentity.name)
    ) {
      rejectProjection("FOREIGN_FUNCTION_REFERENCE", "graph.parameters");
    }
    return graph.functionIdentity.name;
  }
  if (functionNames.size === 0) {
    rejectProjection("MISSING_FUNCTION", "graph.parameters");
  }
  return functionNames.values().next().value!;
}

/**
 * Unfold a normalized recursive metadata identity graph into the JSON tree
 * expected by @sap/cds-rfc. The global descriptor budget deliberately counts
 * repeated projections of shared nodes so a compact DAG cannot amplify into
 * an unbounded consumer document.
 */
export function toModernRfcMetadataFromRecursiveGraph(
  graph: RecursiveMetadataGraph,
  options: ModernMetadataProjectionOptions = {},
): ModernRfcMetadata {
  const rfcName = validateProjectionGraph(graph);
  const context: ProjectionContext = {
    graph,
    maxProjectedDescriptors: projectionLimit(
      options.maxProjectedDescriptors,
      DEFAULT_MAX_PROJECTED_DESCRIPTORS,
      ABSOLUTE_MAX_PROJECTED_DESCRIPTORS,
      "options.maxProjectedDescriptors",
    ),
    maxProjectionDepth: projectionLimit(
      options.maxProjectionDepth,
      DEFAULT_MAX_PROJECTION_DEPTH,
      ABSOLUTE_MAX_PROJECTION_DEPTH,
      "options.maxProjectionDepth",
    ),
    projectedDescriptors: 0,
  };
  const groups: Record<
    "import" | "export" | "changing" | "table",
    ModernMetadataParameter[]
  > = { import: [], export: [], changing: [], table: [] };
  const ordered = graph.parameters
    .map((parameter, index) => ({ parameter, index }))
    .filter(({ parameter }) => parameter.parameterClass !== "X")
    .sort((left, right) =>
      left.parameter.position - right.parameter.position ||
      left.index - right.index);
  for (const { parameter, index } of ordered) {
    const converted = projectParameter(
      context,
      parameter,
      `graph.parameters[${index}]`,
    );
    if (parameter.parameterClass === "I") groups.import.push(converted);
    else if (parameter.parameterClass === "E") groups.export.push(converted);
    else if (parameter.parameterClass === "C") groups.changing.push(converted);
    else if (parameter.parameterClass === "T") groups.table.push(converted);
    else rejectProjection("UNSUPPORTED_PARAMETER_CLASS", `graph.parameters[${index}]`);
  }
  return Object.freeze({
    rfcName,
    import: Object.freeze(groups.import),
    export: Object.freeze(groups.export),
    changing: Object.freeze(groups.changing),
    table: Object.freeze(groups.table),
  });
}
