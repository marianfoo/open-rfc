import { types as nodeUtilTypes } from "node:util";

import {
  intrinsicUint8ArrayByteLength,
  snapshotUint8Array,
} from "../protocol/bytes.js";

const MAX_RFC_VALUE_DEPTH = 64;
const MAX_RFC_VALUE_NODES = 1_000_000;
const MAX_RFC_ARRAY_LENGTH = 100_000;
// A value snapshot also accounts for JavaScript containers and property names,
// so it needs bounded headroom above the 1.4 MB encoded CPIC envelope. The
// encoder still enforces the smaller wire limit before allocating value buffers.
const MAX_RFC_VALUE_RETAINED_BYTES = 2 * 1_400_000;
const utf8ByteLength = Buffer.byteLength.bind(Buffer);

interface SnapshotState {
  remainingNodes: number;
  readonly nodeLimit: number;
  remainingBytes: number;
  readonly maxArrayLength: number;
  readonly accessorPolicy: "reject" | "readOnce";
  readonly visiting: WeakSet<object>;
  readonly completed: WeakMap<object, unknown>;
}

export interface RfcValueSnapshotOptions {
  /** Existing low-level seams may retain their historical single getter read. */
  readonly accessorPolicy?: "reject" | "readOnce";
  /** A caller may tighten, but never raise, the aggregate value-node budget. */
  readonly maxNodes?: number;
  /** A caller may tighten, but never raise, the per-array/table row budget. */
  readonly maxArrayLength?: number;
}

function boundedOption(
  value: number | undefined,
  maximum: number,
  path: string,
): number {
  const candidate = value ?? maximum;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > maximum
  ) {
    throw new RangeError(`${path} must be an integer in 1..${maximum}`);
  }
  return candidate;
}

function propertyValue(
  owner: object,
  descriptor: PropertyDescriptor,
  path: string,
  state: SnapshotState,
): unknown {
  if ("value" in descriptor) return descriptor.value;
  if (
    state.accessorPolicy !== "readOnce" ||
    typeof descriptor.get !== "function"
  ) {
    throw new TypeError(`${path} must be an own data property`);
  }
  return Reflect.apply(descriptor.get, owner, []);
}

function claimBytes(state: SnapshotState, bytes: number, path: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > state.remainingBytes) {
    throw new RangeError(
      `${path} exceeds the ${MAX_RFC_VALUE_RETAINED_BYTES}-byte snapshot limit`,
    );
  }
  state.remainingBytes -= bytes;
}

function claimNode(state: SnapshotState, path: string): void {
  state.remainingNodes -= 1;
  if (state.remainingNodes < 0) {
    throw new RangeError(
      `${path} exceeds the ${state.nodeLimit} value-node snapshot limit`,
    );
  }
}

function snapshotStringConvertible(
  value: object,
  path: string,
  state: SnapshotState,
): string | undefined {
  let owner: object | null = value;
  for (let depth = 0; owner !== null && depth <= MAX_RFC_VALUE_DEPTH; depth += 1) {
    if (nodeUtilTypes.isProxy(owner)) {
      throw new TypeError(`${path} must not have a proxy prototype`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toString");
    if (descriptor !== undefined) {
      if (owner === Object.prototype) return undefined;
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        // A plain RFC structure may legitimately contain a field named
        // `toString`. Only a data-method descriptor opts an object into decimal
        // conversion; every other descriptor continues through ordinary plain
        // object validation without being read here.
        return undefined;
      }
      const text = Reflect.apply(descriptor.value, value, []);
      if (typeof text !== "string") {
        throw new TypeError(`${path} decimal object's toString() must return a string`);
      }
      claimBytes(state, utf8ByteLength(text, "utf8"), path);
      state.completed.set(value, text);
      return text;
    }
    owner = Object.getPrototypeOf(owner);
  }
  if (owner !== null) {
    throw new RangeError(
      `${path} exceeds the ${MAX_RFC_VALUE_DEPTH}-level prototype depth`,
    );
  }
  return undefined;
}

function snapshotComposite(
  value: object,
  path: string,
  depth: number,
  state: SnapshotState,
): unknown {
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError(`${path} must not be a proxy`);
  }
  if (depth > MAX_RFC_VALUE_DEPTH) {
    throw new RangeError(
      `${path} exceeds the ${MAX_RFC_VALUE_DEPTH}-level snapshot depth`,
    );
  }
  if (state.visiting.has(value)) {
    throw new TypeError(`${path} contains a cyclic RFC value`);
  }
  const completed = state.completed.get(value);
  if (completed !== undefined) return completed;

  if (nodeUtilTypes.isUint8Array(value)) {
    const byteLength = intrinsicUint8ArrayByteLength(value);
    claimBytes(state, 16 + byteLength, path);
    const snapshot = snapshotUint8Array(value, path, byteLength);
    state.completed.set(value, snapshot);
    return snapshot;
  }

  if (!Array.isArray(value)) {
    const scalar = snapshotStringConvertible(value, path, state);
    if (scalar !== undefined) return scalar;
  }

  state.visiting.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > state.maxArrayLength) {
        throw new RangeError(
          `${path} exceeds the ${state.maxArrayLength}-row array snapshot limit`,
        );
      }
      claimBytes(state, 16 + value.length * 8, path);
      const keys = Object.keys(value);
      if (keys.length !== value.length) {
        throw new TypeError(`${path} must be a dense array without extra keys`);
      }
      const snapshot: unknown[] = [];
      state.completed.set(value, snapshot);
      for (let index = 0; index < value.length; index += 1) {
        if (keys[index] !== `${index}`) {
          throw new TypeError(`${path} must be a dense array without extra keys`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (descriptor === undefined) {
          throw new TypeError(`${path}[${index}] must be an own data property`);
        }
        snapshot.push(
          snapshotValue(
            propertyValue(value, descriptor, `${path}[${index}]`, state),
            `${path}[${index}]`,
            depth + 1,
            state,
          ),
        );
      }
      return Object.freeze(snapshot);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain RFC value objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable === true) {
          throw new TypeError(`${path} must not contain enumerable symbol keys`);
        }
      }
    }
    const snapshot: Record<string, unknown> = {};
    claimBytes(state, 16, path);
    state.completed.set(value, snapshot);
    for (const key of Object.keys(value)) {
      claimBytes(state, 8 + utf8ByteLength(key, "utf8"), `${path}.${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        throw new TypeError(`${path}.${key} must be an own data property`);
      }
      Object.defineProperty(snapshot, key, {
        value: snapshotValue(
          propertyValue(value, descriptor, `${path}.${key}`, state),
          `${path}.${key}`,
          depth + 1,
          state,
        ),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } finally {
    state.visiting.delete(value);
  }
}

function snapshotValue(
  value: unknown,
  path: string,
  depth: number,
  state: SnapshotState,
): unknown {
  claimNode(state, path);
  if (typeof value === "function") {
    throw new TypeError(`${path} must not be a function`);
  }
  if (typeof value === "string") {
    claimBytes(state, utf8ByteLength(value, "utf8"), path);
  } else if (
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    claimBytes(state, 8, path);
  } else if (
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    claimBytes(state, 1, path);
  }
  return typeof value === "object" && value !== null
    ? snapshotComposite(value, path, depth, state)
    : value;
}

/** Capture caller-owned nested RFC values before any asynchronous boundary. */
export function snapshotRfcValue(
  value: unknown,
  path = "RFC value",
  options: RfcValueSnapshotOptions = {},
): unknown {
  const accessorPolicy = options.accessorPolicy ?? "reject";
  if (accessorPolicy !== "reject" && accessorPolicy !== "readOnce") {
    throw new TypeError("RFC value snapshot accessorPolicy is invalid");
  }
  const nodeLimit = boundedOption(
    options.maxNodes,
    MAX_RFC_VALUE_NODES,
    "RFC value snapshot maxNodes",
  );
  const maxArrayLength = boundedOption(
    options.maxArrayLength,
    MAX_RFC_ARRAY_LENGTH,
    "RFC value snapshot maxArrayLength",
  );
  return snapshotValue(value, path, 0, {
    remainingNodes: nodeLimit,
    nodeLimit,
    remainingBytes: MAX_RFC_VALUE_RETAINED_BYTES,
    maxArrayLength,
    accessorPolicy,
    visiting: new WeakSet(),
    completed: new WeakMap(),
  });
}
