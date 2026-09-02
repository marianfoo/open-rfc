import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import type { ConnectionProviderCapability } from "./connection-route.js";
import type {
  RfcSession,
  RfcSessionProvider,
  RfcSessionTransaction,
} from "./rfc-session-provider.js";

const PROVIDER_CAPABILITIES: ReadonlySet<ConnectionProviderCapability> =
  new Set<ConnectionProviderCapability>([
    "direct-rfc-transport",
    "message-server-rfc-transport",
    "message-server-saprouter-routing",
    "websocket-rfc-transport",
    "named-user-authentication",
    "logon-ticket-authentication",
    "principal-propagation",
    "saprouter-routing",
    "connectivity-socks5-tcp",
    "connectivity-rfc-proxy",
    "connectivity-proxy-authorization",
  ]);

function callable(value: unknown, path: string): (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(`${path} must be a function`);
  }
  return value as (...args: never[]) => unknown;
}

function providerCapabilities(
  input: readonly ConnectionProviderCapability[],
): readonly ConnectionProviderCapability[] {
  if (!Array.isArray(input)) {
    throw new TypeError("RFC session provider capabilities must be an array");
  }
  if (input.length > PROVIDER_CAPABILITIES.size) {
    throw new RangeError(
      "RFC session provider capabilities exceed the supported set",
    );
  }
  const result: ConnectionProviderCapability[] = [];
  const seen = new Set<ConnectionProviderCapability>();
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `RFC session provider capabilities[${index}] must be an own data property`,
      );
    }
    const capability = descriptor.value as ConnectionProviderCapability;
    if (!PROVIDER_CAPABILITIES.has(capability)) {
      const rendered = typeof capability === "string"
        ? capability
        : typeof capability;
      throw new TypeError(`unknown RFC session provider capability ${rendered}`);
    }
    if (seen.has(capability)) {
      throw new TypeError(`duplicate RFC session provider capability ${capability}`);
    }
    seen.add(capability);
    result.push(capability);
  }
  return Object.freeze(result);
}

function connectionInfoSnapshot(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("RFC session connectionInfo must be an object");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > 64) {
    throw new RangeError("RFC session connectionInfo exceeds 64 fields");
  }
  const result: Record<string, string> = {};
  let retainedBytes = 0;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError("RFC session connectionInfo keys must be strings");
    }
    if (
      /^(?:passwd|password|mysapsso2|ticket|business_user_token|authorization)$/iu
        .test(key)
    ) {
      throw new TypeError(`RFC session connectionInfo must not expose ${key}`);
    }
    if (key.length === 0 || Buffer.byteLength(key, "utf8") > 128) {
      throw new RangeError("RFC session connectionInfo keys must use 1..128 bytes");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `RFC session connectionInfo.${key} must be an own data property`,
      );
    }
    if (typeof descriptor.value !== "string") {
      throw new TypeError(`RFC session connectionInfo.${key} must be a string`);
    }
    retainedBytes += Buffer.byteLength(key, "utf8") +
      Buffer.byteLength(descriptor.value, "utf8");
    if (retainedBytes > 64 * 1024) {
      throw new RangeError("RFC session connectionInfo exceeds 65536 bytes");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function bindTransaction(input: RfcSessionTransaction): RfcSessionTransaction {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("RFC session beginTransaction() must return an object");
  }
  const call = callable(input.call, "RFC session transaction.call");
  const ready = callable(input.ready, "RFC session transaction.ready");
  const commit = callable(input.commit, "RFC session transaction.commit");
  const rollback = callable(input.rollback, "RFC session transaction.rollback");
  const close = callable(input.close, "RFC session transaction.close");
  const isTerminal = callable(
    input.isTerminal,
    "RFC session transaction.isTerminal",
  );
  let closePromise: Promise<void> | undefined;
  let readyPromise: Promise<void> | undefined;
  const bound: RfcSessionTransaction = {
    ready() {
      if (readyPromise === undefined) {
        readyPromise = Promise.resolve().then(async () => {
          await Reflect.apply(ready, input, []);
        });
      }
      return readyPromise;
    },
    async call(functionName, parameters, options) {
      const result = await Reflect.apply(call, input, [
        functionName,
        parameters,
        options,
      ]) as unknown;
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
      ) {
        throw new TypeError(
          "RFC session transaction.call() must return an object",
        );
      }
      return result as Readonly<Record<string, unknown>>;
    },
    async commit() {
      await Reflect.apply(commit, input, []);
    },
    async rollback() {
      await Reflect.apply(rollback, input, []);
    },
    close() {
      if (closePromise === undefined) {
        closePromise = Promise.resolve().then(async () => {
          await Reflect.apply(close, input, []);
        });
      }
      return closePromise;
    },
    isTerminal() {
      try {
        const terminal = Reflect.apply(isTerminal, input, []);
        // A broken provider monitor can never justify reusing the LUW.
        return typeof terminal === "boolean" ? terminal : true;
      } catch {
        return true;
      }
    },
  };
  return Object.freeze(bound);
}

function bindSession(input: RfcSession): RfcSession {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("RFC session provider open() must return an object");
  }
  const connectionInfo = connectionInfoSnapshot(input.connectionInfo);
  const beginTransaction = callable(
    input.beginTransaction,
    "RFC session.beginTransaction",
  );
  const getFunctionInterface = callable(
    input.getFunctionInterface,
    "RFC session.getFunctionInterface",
  );
  const getStructureDefinition = callable(
    input.getStructureDefinition,
    "RFC session.getStructureDefinition",
  );
  const recursiveMetadataCandidate = input.getRecursiveFunctionMetadata;
  const getRecursiveFunctionMetadata = recursiveMetadataCandidate === undefined
    ? undefined
    : callable(
        recursiveMetadataCandidate,
        "RFC session.getRecursiveFunctionMetadata",
      );
  const close = callable(input.close, "RFC session.close");
  let closePromise: Promise<void> | undefined;
  const bound: RfcSession = {
    connectionInfo,
    beginTransaction() {
      const transaction = Reflect.apply(beginTransaction, input, []);
      return bindTransaction(transaction as RfcSessionTransaction);
    },
    async getFunctionInterface(functionName, signal) {
      return await Reflect.apply(getFunctionInterface, input, [
        functionName,
        signal,
      ]) as RfcFunctionInterface;
    },
    async getStructureDefinition(structureName, signal) {
      return await Reflect.apply(getStructureDefinition, input, [
        structureName,
        signal,
      ]) as RfcStructureDefinition;
    },
    ...(getRecursiveFunctionMetadata === undefined
      ? {}
      : {
          async getRecursiveFunctionMetadata(
            functionName: string,
            signal?: AbortSignal,
          ): Promise<RecursiveMetadataGraph> {
            return await Reflect.apply(getRecursiveFunctionMetadata, input, [
              functionName,
              signal,
            ]) as RecursiveMetadataGraph;
          },
        }),
    close() {
      if (closePromise === undefined) {
        closePromise = Promise.resolve().then(async () => {
          await Reflect.apply(close, input, []);
        });
      }
      return closePromise;
    },
  };
  return Object.freeze(bound);
}

/** Capture a provider and every receiver-sensitive method exactly once. */
export function bindRfcSessionProvider(
  input: RfcSessionProvider,
): RfcSessionProvider {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("RFC session provider must be an object");
  }
  const capabilities = providerCapabilities(input.capabilities);
  const open = callable(input.open, "RFC session provider.open");
  const bound: RfcSessionProvider = {
    capabilities,
    async open(plan, signal) {
      const session = await Reflect.apply(open, input, [plan, signal]);
      try {
        return bindSession(session as RfcSession);
      } catch (error) {
        if (typeof session !== "object" || session === null) throw error;
        const candidateClose = (session as { readonly close?: unknown }).close;
        if (typeof candidateClose !== "function") throw error;
        try {
          await Reflect.apply(candidateClose, session, []);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "RFC session binding and retirement both failed",
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
  return Object.freeze(bound);
}
