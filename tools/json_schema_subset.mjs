/**
 * Dependency-free, fail-closed JSON Schema Draft 2020-12 subset shared by
 * release verification and the repository's larger program-contract runner.
 */

export class JsonSchemaSubsetError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsonSchemaSubsetError";
  }
}

function fail(message) {
  throw new JsonSchemaSubsetError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "additionalProperties",
  "required",
  "properties",
  "const",
  "enum",
  "pattern",
  "minLength",
  "minimum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "contains",
  "minContains",
  "maxContains",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

export function verifySupportedSchemaSubset(schema, path = "#") {
  assert(schema && typeof schema === "object" && !Array.isArray(schema), `${path} schema`);
  for (const key of Object.keys(schema)) {
    assert(
      SUPPORTED_SCHEMA_KEYWORDS.has(key),
      `${path} uses unsupported schema keyword ${key}`,
    );
  }
  for (const key of ["title", "description"]) {
    if (Object.hasOwn(schema, key)) {
      assert(typeof schema[key] === "string", `${path} ${key} must be a string`);
    }
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    verifySupportedSchemaSubset(child, `${path}/properties/${key}`);
  }
  for (const [key, child] of Object.entries(schema.$defs ?? {})) {
    verifySupportedSchemaSubset(child, `${path}/$defs/${key}`);
  }
  if (schema.items && typeof schema.items === "object") {
    verifySupportedSchemaSubset(schema.items, `${path}/items`);
  }
  if (schema.contains && typeof schema.contains === "object") {
    verifySupportedSchemaSubset(schema.contains, `${path}/contains`);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const [index, child] of (schema[key] ?? []).entries()) {
      verifySupportedSchemaSubset(child, `${path}/${key}/${index}`);
    }
  }
  for (const key of ["not", "if", "then", "else"]) {
    if (schema[key]) verifySupportedSchemaSubset(schema[key], `${path}/${key}`);
  }
}

function resolveLocalRef(rootSchema, ref) {
  assert(ref.startsWith("#/"), `only local JSON Schema references are supported: ${ref}`);
  let value = rootSchema;
  for (const token of ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    assert(value && Object.hasOwn(value, token), `unresolved JSON Schema reference ${ref}`);
    value = value[token];
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function validateSchemaNode(value, schema, rootSchema, path) {
  if (schema.$ref) {
    validateSchemaNode(value, resolveLocalRef(rootSchema, schema.$ref), rootSchema, path);
  }
  for (const child of schema.allOf ?? []) {
    validateSchemaNode(value, child, rootSchema, path);
  }
  if (schema.anyOf) {
    assert(
      schema.anyOf.some((child) => schemaMatches(value, child, rootSchema, path)),
      `${path} must match at least one anyOf branch`,
    );
  }
  if (schema.oneOf) {
    assert(
      schema.oneOf.filter((child) => schemaMatches(value, child, rootSchema, path)).length === 1,
      `${path} must match exactly one oneOf branch`,
    );
  }
  if (schema.not) {
    assert(!schemaMatches(value, schema.not, rootSchema, path), `${path} must not match schema`);
  }
  if (schema.if) {
    const branch = schemaMatches(value, schema.if, rootSchema, path) ? schema.then : schema.else;
    if (branch) validateSchemaNode(value, branch, rootSchema, path);
  }
  if (Object.hasOwn(schema, "const")) {
    assert(jsonEqual(value, schema.const), `${path} must equal the schema const`);
  }
  if (schema.enum) {
    assert(
      schema.enum.some((entry) => jsonEqual(value, entry)),
      `${path} is not in the schema enum`,
    );
  }
  const types = schema.type
    ? Array.isArray(schema.type) ? schema.type : [schema.type]
    : [];
  if (types.length > 0) {
    assert(
      types.some((type) => matchesType(value, type)),
      `${path} must have type ${types.join("|")}`,
    );
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) {
      assert(value.length >= schema.minLength, `${path} is shorter than minLength`);
    }
    if (schema.pattern !== undefined) {
      assert(new RegExp(schema.pattern, "u").test(value), `${path} does not match pattern`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined) {
    assert(value >= schema.minimum, `${path} is below minimum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) {
      assert(value.length >= schema.minItems, `${path} has fewer than minItems`);
    }
    if (schema.maxItems !== undefined) {
      assert(value.length <= schema.maxItems, `${path} has more than maxItems`);
    }
    if (schema.uniqueItems) {
      const members = value.map((entry) => JSON.stringify(entry));
      assert(new Set(members).size === members.length, `${path} must have uniqueItems`);
    }
    if (schema.items) {
      value.forEach((entry, index) =>
        validateSchemaNode(entry, schema.items, rootSchema, `${path}/${index}`));
    }
    if (schema.contains) {
      const matches = value.filter((entry, index) =>
        schemaMatches(entry, schema.contains, rootSchema, `${path}/${index}`)).length;
      const minimum = schema.minContains ?? 1;
      const maximum = schema.maxContains ?? Number.POSITIVE_INFINITY;
      assert(
        matches >= minimum && matches <= maximum,
        `${path} must contain between ${minimum} and ${maximum} matching items`,
      );
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      assert(Object.hasOwn(value, key), `${path} is missing required property ${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchemaNode(value[key], child, rootSchema, `${path}/${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        assert(allowed.has(key), `${path} has unexpected property ${key}`);
      }
    }
  }
}

function schemaMatches(value, schema, rootSchema, path) {
  try {
    validateSchemaNode(value, schema, rootSchema, path);
    return true;
  } catch (error) {
    if (error instanceof JsonSchemaSubsetError) return false;
    throw error;
  }
}

export function validateJsonSchemaSubset(value, schema, label = "document") {
  verifySupportedSchemaSubset(schema);
  validateSchemaNode(value, schema, schema, label);
}
