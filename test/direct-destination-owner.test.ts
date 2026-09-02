import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectCpicPreWireError,
  type DirectCpicSession,
} from "../src/client/direct-cpic-session.js";
import {
  RfcConnectionDisposition,
  RfcCoreError,
  RfcFailureCategory,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcTransmissionState,
  createRfcFailure,
} from "../src/client/rfc-failure.js";
import type { NormalizedDirectConnection } from "../src/compat/connection-parameters.js";
import { productionDirectCompatibilityOwnerFactory } from
  "../src/compat/direct-owner-factory.js";
import {
  DirectDestinationMetadataPreflightError,
  DirectDestinationOwner,
  classifyDirectDestinationTransactionFailure,
  createDirectDestinationTransactionAdapter,
  type DirectDestinationLane,
  type DirectDestinationOwnerOptions,
  type DirectDestinationSessionFactory,
  type DirectDestinationSessionOpenContext,
} from "../src/destination/direct-destination-owner.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import { MetadataRepositoryMode } from "../src/metadata/repository-runtime.js";
import { MetadataAccessFailure } from "../src/metadata/repository-runtime.js";
import type { RfcStructureDefinition } from "../src/metadata/rfc-structure-definition.js";
import {
  type RfcMetadataGetFunctionResult,
  type RfcMetadataGetRecursiveFunctionResult,
  type RfcMetadataGetStructureResult,
  type RfcMetadataTimestampBatch,
} from "../src/metadata/rfc-metadata-get.js";
import {
  RecursiveMetadataError,
  normalizeRecursiveMetadataGraph,
  type RecursiveMetadataGraph,
} from "../src/metadata/recursive-metadata.js";
import {
  SessionContextRuntimeError,
  type SessionContextToken,
} from "../src/lifecycle/session-context-runtime.js";
import { TransactionRuntime } from "../src/lifecycle/transaction-runtime.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(
  predicate: () => boolean,
  message: string,
  limit = 200,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

const STRUCTURE = Object.freeze<RfcStructureDefinition>({
  name: "ZLINE",
  byteLength: 4,
  fields: Object.freeze([
    Object.freeze({
      tableName: "ZLINE",
      fieldName: "VALUE",
      position: 1,
      offset: 0,
      internalLength: 4,
      decimals: 0,
      exid: "I",
    }),
  ]),
});

function functionInterface(
  name: string,
  structured = false,
): RfcFunctionInterface {
  return Object.freeze({
    name,
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: structured
      ? Object.freeze([
          Object.freeze({
            parameterClass: "I",
            parameterName: "INPUT",
            tableName: "ZLINE",
            fieldName: "",
            exid: "u",
            position: 1,
            offset: 0,
            internalLength: 4,
            decimals: 0,
            defaultValue: "",
            parameterText: "",
            optional: false,
          }),
        ])
      : Object.freeze([]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
}

function recursiveFunctionGraph(
  name: string,
  date = "20260716",
  time = "010203",
): RecursiveMetadataGraph {
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: name,
      BASXML_SUPPORTED: "",
      UDAT: date,
      UTIME: time,
    }],
    DATATYPESCONT: [],
    INDIRECTTYPES: [],
    PARAMETERS: [],
  });
}

function deepTableFunctionInterface(name: string): RfcFunctionInterface {
  const parameter = (
    parameterClass: "I" | "E",
    parameterName: string,
    position: number,
  ) => Object.freeze({
    parameterClass,
    parameterName,
    tableName: "Z_DEEP_T",
    fieldName: "",
    exid: "h",
    position,
    offset: 0,
    internalLength: 32,
    decimals: 0,
    defaultValue: "",
    parameterText: "",
    optional: false,
  });
  return Object.freeze({
    name,
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([
      parameter("E", "OUT", 1),
      parameter("I", "IN", 2),
    ]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
}

function deepTableFunctionGraph(
  name: string,
  rowShape: "deep" | "fixed" = "deep",
): RecursiveMetadataGraph {
  const typeRow = (input: {
    readonly typeName: string;
    readonly fieldName: string;
    readonly fieldType: string;
    readonly internalType: string;
    readonly componentType?: string;
    readonly dataType: string;
    readonly offset?: number;
    readonly length?: number;
  }) => ({
    TYPENAME: input.typeName,
    FIELDNAME: input.fieldName,
    COMPTYPE: input.componentType ?? "E",
    FIELDTYPE: input.fieldType,
    DATATYPE: input.dataType,
    TABLENGTH: 16,
    TABLENGTH_UC: 16,
    DESCRIPTION: "",
    DECIMALS: 0,
    INTTYPE: input.internalType,
    OFFSET: input.offset ?? 0,
    OFFSET_UC: input.offset ?? 0,
    INTLEN: input.length ?? 0,
    INTLEN_UC: input.length ?? 0,
    TIMESTAMP: "20260716010203",
  });
  const parameterRow = (
    parameterClass: "I" | "E",
    parameterName: string,
    position: number,
  ) => ({
    FUNCNAME: name,
    PARAMCLASS: parameterClass,
    PARAMETER: parameterName,
    TABNAME: "Z_DEEP_T",
    FIELDNAME: "",
    EXID: "h",
    POSITION: position,
    OFFSET: 0,
    INTLENGTH: 32,
    DECIMALS: 0,
    DEFAULT: "",
    PARAMTEXT: "",
    OPTIONAL: "",
  });
  return normalizeRecursiveMetadataGraph({
    FUNCTIONNAMES: [{
      FUNCTIONNAME: name,
      BASXML_SUPPORTED: "",
      UDAT: "20260716",
      UTIME: "010203",
    }],
    DATATYPESCONT: [
      typeRow({
        typeName: "Z_DEEP_T",
        fieldName: "",
        fieldType: "Z_DEEP",
        internalType: "v",
        componentType: "S",
        dataType: "STRU",
      }),
      ...(rowShape === "deep"
        ? [
            typeRow({
              typeName: "Z_DEEP",
              fieldName: "STR",
              fieldType: "STRING",
              internalType: "g",
              dataType: "STRG",
              length: 8,
            }),
            typeRow({
              typeName: "Z_DEEP",
              fieldName: "XSTR",
              fieldType: "XSTRING",
              internalType: "y",
              dataType: "RSTR",
              offset: 8,
              length: 8,
            }),
          ]
        : [
            typeRow({
              typeName: "Z_DEEP",
              fieldName: "I",
              fieldType: "INT4",
              internalType: "I",
              dataType: "INT4",
              length: 4,
            }),
            typeRow({
              typeName: "Z_DEEP",
              fieldName: "C",
              fieldType: "CHAR",
              internalType: "C",
              dataType: "CHAR",
              offset: 4,
              length: 12,
            }),
          ]),
    ],
    INDIRECTTYPES: [],
    PARAMETERS: [
      parameterRow("E", "OUT", 1),
      parameterRow("I", "IN", 2),
    ],
  });
}

function metadataTimestampBatch(options: {
  readonly functions?: Readonly<Record<string, string>>;
  readonly structures?: Readonly<Record<string, string>>;
  readonly functionErrors?: Readonly<Record<string, string>>;
  readonly structureErrors?: Readonly<Record<string, string>>;
} = {}): RfcMetadataTimestampBatch {
  return Object.freeze({
    functions: new Map(Object.entries(options.functions ?? {}).map(
      ([functionName, token]) => {
        const parts = token.split(":");
        return [functionName, Object.freeze({
          functionName,
          date: parts[1]!,
          time: parts[2]!,
          token,
        })] as const;
      },
    )),
    structures: new Map(Object.entries(options.structures ?? {}).map(
      ([structureName, token]) => [structureName, Object.freeze({
        structureName,
        timestamp: token.slice("structure:".length),
        token,
      })] as const,
    )),
    functionErrors: new Map(Object.entries(options.functionErrors ?? {})),
    structureErrors: new Map(Object.entries(options.structureErrors ?? {})),
  });
}

const CONNECTION = Object.freeze<NormalizedDirectConnection>({
  host: "127.0.0.1",
  applicationServerHost: "qas.example.invalid",
  port: 3300,
  applicationServerService: "sapdp00",
  client: "100",
  user: "fixture-user",
  password: ["fixture", "password"].join("-"),
  language: "E",
  sysnr: "00",
  cpicStreaming: "disabled",
});

const IDENTITY = Object.freeze({
  destinationId: "owner-fixture",
  endpointId: "direct:qas.example.invalid:00",
  systemId: "QAS",
  client: "100",
  release: "2023",
  metadataGeneration: "fixture-1",
  language: "E",
  applicationPrincipalId: "principal:application",
  repositoryPrincipalId: "principal:repository",
});

const NO_IO_SESSION_FACTORY: DirectDestinationSessionFactory = Object.freeze({
  async open(): Promise<DirectCpicSession> {
    throw new Error("validation owner must not open a session");
  },
});

function validationOwnerOptions(): DirectDestinationOwnerOptions {
  return {
    connection: CONNECTION,
    generationId: "validation-owner-1",
    identity: IDENTITY,
    sessionFactory: NO_IO_SESSION_FACTORY,
    applicationPool: {
      maxConnections: 2,
      maxWaiters: 2,
      acquireTimeoutMs: 1_000,
      lifecycleTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      lowWater: 0,
      idleHigh: 2,
      validateOnCheckout: false,
    },
    repositoryPool: {
      maxConnections: 1,
      maxWaiters: 2,
      acquireTimeoutMs: 1_000,
      lifecycleTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      lowWater: 0,
      idleHigh: 1,
      validateOnCheckout: false,
    },
    metadata: {
      maxEntries: 8,
      maxRetainedBytes: 64 * 1_024,
      maxInFlightLoads: 2,
    },
  };
}

interface FakeSession {
  readonly id: number;
  readonly lane: DirectDestinationLane;
  readonly info: {
    readonly localAddress: string;
    readonly peerCodePage: string;
    readonly peerAcceptInfo: number;
    readonly generationHandle: number;
    readonly connectionIndex: number;
  };
  ping(signal?: AbortSignal): Promise<Readonly<Record<string, never>>>;
  close(): Promise<void>;
  resetServerContext(signal?: AbortSignal): Promise<void>;
  getFunctionInterface(
    name: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface>;
  getStructureDefinition(
    name: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition>;
  getLegacyStructureDefinition(
    name: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition>;
  getOptimizedFunctionInterface(
    name: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface>;
  getOptimizedStructureDefinition(
    name: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition>;
  getOptimizedFunctionDescriptor(
    name: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<RfcMetadataGetFunctionResult>;
  getOptimizedRecursiveFunctionDescriptor(
    name: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<RfcMetadataGetRecursiveFunctionResult>;
  getOptimizedStructureDescriptor(
    name: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<RfcMetadataGetStructureResult>;
  getOptimizedMetadataTimestamps(
    functionNames: readonly string[],
    structureNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<RfcMetadataTimestampBatch>;
  invokeClassicWithMetadata(
    metadata: RfcFunctionInterface,
    input: Readonly<Record<string, unknown>>,
    structures: ReadonlyMap<string, RfcStructureDefinition>,
    signal?: AbortSignal,
    options?: unknown,
    recursiveMetadata?: RecursiveMetadataGraph,
  ): Promise<Readonly<Record<string, unknown>>>;
}

interface OwnerFixture {
  readonly owner: DirectDestinationOwner;
  readonly events: string[];
  readonly sessions: FakeSession[];
  readonly factory: DirectDestinationSessionFactory;
}

function ownerFixture(options: {
  readonly repositoryMode?: MetadataRepositoryMode;
  readonly openSession?: (
    lane: DirectDestinationLane,
    id: number,
  ) => DirectCpicSession | PromiseLike<DirectCpicSession>;
  readonly invoke?: (
    session: FakeSession,
    metadata: RfcFunctionInterface,
    input: Readonly<Record<string, unknown>>,
    structures: ReadonlyMap<string, RfcStructureDefinition>,
    signal?: AbortSignal,
    recursiveMetadata?: RecursiveMetadataGraph,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly reset?: (
    session: FakeSession,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly close?: (session: FakeSession) => Promise<void>;
  readonly getFunctionInterface?: (
    session: FakeSession,
    name: string,
    signal?: AbortSignal,
  ) => Promise<RfcFunctionInterface>;
  readonly getStructureDefinition?: (
    session: FakeSession,
    name: string,
    signal?: AbortSignal,
  ) => Promise<RfcStructureDefinition>;
  readonly getOptimizedFunctionInterface?: (
    session: FakeSession,
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<RfcFunctionInterface>;
  readonly getOptimizedStructureDefinition?: (
    session: FakeSession,
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<RfcStructureDefinition>;
  readonly getOptimizedRecursiveFunctionDescriptor?: (
    session: FakeSession,
    name: string,
    language: string,
    signal?: AbortSignal,
  ) => Promise<RfcMetadataGetRecursiveFunctionResult>;
  readonly optimizedFunctionGeneration?: (
    session: FakeSession,
    name: string,
  ) => string;
  readonly optimizedStructureGeneration?: (
    session: FakeSession,
    name: string,
  ) => string;
  readonly getOptimizedMetadataTimestamps?: (
    session: FakeSession,
    functionNames: readonly string[],
    structureNames: readonly string[],
    signal?: AbortSignal,
  ) => Promise<RfcMetadataTimestampBatch>;
  readonly maxMetadataEntries?: number;
  readonly repositoryMaxConnections?: number;
} = {}): OwnerFixture {
  const events: string[] = [];
  const sessions: FakeSession[] = [];
  let nextSessionId = 1;
  const factory: DirectDestinationSessionFactory = {
    async open(
      connection: NormalizedDirectConnection,
      context: DirectDestinationSessionOpenContext,
    ): Promise<DirectCpicSession> {
      assert.equal(Object.isFrozen(connection), true);
      assert.equal(connection.password, ["fixture", "password"].join("-"));
      const id = nextSessionId++;
      const lane = context.lane;
      events.push(`open:${lane}:${id}`);
      if (options.openSession !== undefined) {
        return options.openSession(lane, id);
      }
      const session: FakeSession = {
        id,
        lane,
        info: Object.freeze({
          localAddress: "127.0.0.1",
          peerCodePage: "4103",
          peerAcceptInfo: 1,
          generationHandle: id,
          connectionIndex: id,
        }),
        async ping() {
          events.push(`ping:${lane}:${id}`);
          return Object.freeze({});
        },
        async close() {
          events.push(`close:${lane}:${id}`);
          await options.close?.(session);
        },
        async resetServerContext(signal) {
          events.push(`reset:${lane}:${id}`);
          await options.reset?.(session, signal);
        },
        async getFunctionInterface(name, signal) {
          events.push(`function:${lane}:${id}:${name}`);
          return options.getFunctionInterface?.(session, name, signal) ??
            functionInterface(name, name === "Z_OWNER_TEST");
        },
        async getStructureDefinition(name, signal) {
          events.push(`structure:${lane}:${id}:${name}`);
          return options.getStructureDefinition?.(session, name, signal) ??
            STRUCTURE;
        },
        async getLegacyStructureDefinition(name, signal) {
          events.push(`legacy-structure:${lane}:${id}:${name}`);
          return options.getStructureDefinition?.(session, name, signal) ??
            STRUCTURE;
        },
        async getOptimizedFunctionInterface(name, language, signal) {
          events.push(`optimized-function:${lane}:${id}:${language}:${name}`);
          return options.getOptimizedFunctionInterface?.(
            session,
            name,
            language,
            signal,
          ) ?? functionInterface(name, name === "Z_OWNER_TEST");
        },
        async getOptimizedStructureDefinition(name, language, signal) {
          events.push(`optimized-structure:${lane}:${id}:${language}:${name}`);
          return options.getOptimizedStructureDefinition?.(
            session,
            name,
            language,
            signal,
          ) ?? STRUCTURE;
        },
        async getOptimizedFunctionDescriptor(name, language, signal) {
          return Object.freeze({
            value: await session.getOptimizedFunctionInterface(
              name,
              language,
              signal,
            ),
            generationToken:
              options.optimizedFunctionGeneration?.(session, name) ??
              "function:20260716:010203",
          });
        },
        async getOptimizedRecursiveFunctionDescriptor(name, language, signal) {
          events.push(
            `optimized-recursive-function:${lane}:${id}:${language}:${name}`,
          );
          if (options.getOptimizedRecursiveFunctionDescriptor !== undefined) {
            return options.getOptimizedRecursiveFunctionDescriptor(
              session,
              name,
              language,
              signal,
            );
          }
          const value = recursiveFunctionGraph(name);
          return Object.freeze({
            value,
            generationToken: value.functionIdentity!.generationToken,
          });
        },
        async getOptimizedStructureDescriptor(name, language, signal) {
          return Object.freeze({
            value: await session.getOptimizedStructureDefinition(
              name,
              language,
              signal,
            ),
            generationToken:
              options.optimizedStructureGeneration?.(session, name) ??
              "structure:20260716010203",
          });
        },
        async getOptimizedMetadataTimestamps(
          functionNames,
          structureNames,
          signal,
        ) {
          events.push(
            `optimized-timestamps:${lane}:${id}:${functionNames.join(",")}:${structureNames.join(",")}`,
          );
          if (options.getOptimizedMetadataTimestamps !== undefined) {
            return options.getOptimizedMetadataTimestamps(
              session,
              functionNames,
              structureNames,
              signal,
            );
          }
          return Object.freeze({
            functions: new Map(functionNames.map((functionName) => [
              functionName,
              Object.freeze({
                functionName,
                date: "20260716",
                time: "010203",
                token: ["function", "20260716", "010203"].join(":"),
              }),
            ])),
            structures: new Map(structureNames.map((structureName) => [
              structureName,
              Object.freeze({
                structureName,
                timestamp: "20260716010203",
                token: ["structure", "20260716010203"].join(":"),
              }),
            ])),
            functionErrors: new Map(),
            structureErrors: new Map(),
          });
        },
        async invokeClassicWithMetadata(
          metadata,
          input,
          structures,
          signal,
          _invocationOptions,
          recursiveMetadata,
        ) {
          events.push(`invoke:${lane}:${id}:${metadata.name}`);
          if (options.invoke !== undefined) {
            return options.invoke(
              session,
              metadata,
              input,
              structures,
              signal,
              recursiveMetadata,
            );
          }
          return Object.freeze({
            SESSION_ID: id,
            FUNCTION: metadata.name,
            INPUT: input.INPUT,
            STRUCTURES: structures.size,
            RETURN: Object.freeze({ TYPE: "", MESSAGE: "" }),
          });
        },
      };
      sessions.push(session);
      return session as unknown as DirectCpicSession;
    },
  };
  const owner = new DirectDestinationOwner({
    connection: CONNECTION,
    generationId: "owner-fixture-1",
    repositoryMode: options.repositoryMode ?? MetadataRepositoryMode.Classic,
    identity: {
      destinationId: "owner-fixture",
      endpointId: "direct:qas.example.invalid:00",
      systemId: "QAS",
      client: "100",
      release: "2023",
      metadataGeneration: "fixture-1",
      language: "E",
      applicationPrincipalId: "principal:application",
      repositoryPrincipalId: "principal:repository",
    },
    sessionFactory: factory,
    applicationPool: {
      maxConnections: 2,
      maxWaiters: 4,
      acquireTimeoutMs: 1_000,
      lifecycleTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      idleHigh: 2,
      validateOnCheckout: true,
    },
    repositoryPool: {
      maxConnections: options.repositoryMaxConnections ?? 1,
      maxWaiters: 4,
      acquireTimeoutMs: 1_000,
      lifecycleTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      idleHigh: 1,
      validateOnCheckout: true,
    },
    metadata: {
      maxEntries: options.maxMetadataEntries ?? 8,
      maxRetainedBytes: 64 * 1_024,
      maxInFlightLoads: 4,
    },
  });
  return { owner, events, sessions, factory };
}

test("validates the complete destination composition before any session I/O", async () => {
  for (const options of [null, undefined, []]) {
    assert.throws(
      () => new DirectDestinationOwner(options as never),
      /owner options must be an object/u,
    );
  }

  for (const connection of [null, []]) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        connection: connection as never,
      }),
      /connection must be normalized direct connection data/u,
    );
  }
  for (const [patch, pattern] of [
    [{ host: "" }, /connection\.host must be a non-empty string/u],
    [{ host: 1 }, /connection\.host must be a non-empty string/u],
    [
      { applicationServerHost: "" },
      /connection\.applicationServerHost must be a non-empty string/u,
    ],
    [{ port: 0 }, /connection\.port must be an integer/u],
    [{ port: 65_536 }, /connection\.port must be an integer/u],
    [{ port: Number.NaN }, /connection\.port must be an integer/u],
    [{ sysnr: "0" }, /sysnr must contain two decimal digits/u],
    [
      { applicationServerService: "sapdp01" },
      /applicationServerService must match/u,
    ],
    [{ client: "10" }, /client must contain three decimal digits/u],
    [{ language: "en" }, /language must be one SAP language code/u],
    [{ cpicStreaming: "automatic" }, /cpicStreaming must be disabled or enabled/u],
  ] as const) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        connection: { ...CONNECTION, ...patch } as NormalizedDirectConnection,
      }),
      pattern,
    );
  }
  assert.throws(
    () => new DirectDestinationOwner({
      ...validationOwnerOptions(),
      connection: {
        ...CONNECTION,
        ticket: "ticket",
      } as never,
    }),
    /exactly one of password or ticket/u,
  );
  const noCredential = { ...CONNECTION } as { password?: string };
  delete noCredential.password;
  assert.throws(
    () => new DirectDestinationOwner({
      ...validationOwnerOptions(),
      connection: noCredential as never,
    }),
    /exactly one of password or ticket/u,
  );

  for (const identity of [null, []]) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        identity: identity as never,
      }),
      /identity must be an object/u,
    );
  }
  assert.throws(
    () => new DirectDestinationOwner({
      ...validationOwnerOptions(),
      generationId: "",
    }),
    /generationId must be a non-empty string/u,
  );
  assert.throws(
    () => new DirectDestinationOwner({
      ...validationOwnerOptions(),
      identity: { ...IDENTITY, destinationId: "" },
    }),
    /identity\.destinationId must be a non-empty string/u,
  );
  assert.throws(
    () => new DirectDestinationOwner({
      ...validationOwnerOptions(),
      identity: { ...IDENTITY, client: "200" },
    }),
    /identity\.client must match/u,
  );
  assert.throws(
    () => new DirectDestinationOwner({
      ...validationOwnerOptions(),
      identity: { ...IDENTITY, language: "D" },
    }),
    /identity\.language must match/u,
  );

  for (const session of [null, []]) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        session: session as never,
      }),
      /session options must be an object/u,
    );
  }
  for (const [session, pattern] of [
    [{ programName: "bad\nprogram" }, /programName must contain/u],
    [{ localAddress: "" }, /localAddress must be a non-empty string/u],
    [{ localAddress: 7 }, /localAddress must be a non-empty string/u],
    [{ transportFactory: 7 }, /transportFactory must be a function/u],
    [{ connectTimeoutMs: 0 }, /connectTimeoutMs must be finite/u],
    [{ connectTimeoutMs: Number.NaN }, /connectTimeoutMs must be finite/u],
    [{ operationTimeoutMs: 2_147_483_648 }, /operationTimeoutMs must be finite/u],
  ] as const) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        session: session as never,
      }),
      pattern,
    );
  }

  for (const path of ["applicationPool", "repositoryPool"] as const) {
    for (const value of [null, []]) {
      assert.throws(
        () => new DirectDestinationOwner({
          ...validationOwnerOptions(),
          [path]: value as never,
        }),
        new RegExp(`${path} must be an object`),
      );
    }
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        [path]: {
          ...(validationOwnerOptions()[path] ?? {}),
          validateOnCheckout: "yes" as never,
        },
      }),
      new RegExp(`${path}\\.validateOnCheckout must be a boolean`),
    );
  }
  for (const metadata of [null, []]) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        metadata: metadata as never,
      }),
      /metadata options must be an object/u,
    );
  }
  for (const sessionFactory of [null, [], {}]) {
    assert.throws(
      () => new DirectDestinationOwner({
        ...validationOwnerOptions(),
        sessionFactory: sessionFactory as never,
      }),
      /sessionFactory/u,
    );
  }

  const productionDefaults = validationOwnerOptions();
  delete (productionDefaults as { sessionFactory?: unknown }).sessionFactory;
  delete (productionDefaults as { session?: unknown }).session;
  delete (productionDefaults as { applicationPool?: unknown }).applicationPool;
  delete (productionDefaults as { repositoryPool?: unknown }).repositoryPool;
  delete (productionDefaults as { metadata?: unknown }).metadata;
  const owner = new DirectDestinationOwner(productionDefaults);
  assert.equal(owner.configuration.generationId, "validation-owner-1");
  assert.equal(owner.monitor().state, "active");
  await owner.retire();
  await owner.retire();
  assert.equal(owner.monitor().state, "retired");
});

test("production compatibility owners isolate principals, caches, cancellation, and retirement", async () => {
  const supportA = ownerFixture();
  const supportB = ownerFixture();
  const pool = Object.freeze({
    maxConnections: 1,
    maxWaiters: 4,
    acquireTimeoutMs: 1_000,
    lifecycleTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    lowWater: 0,
    idleHigh: 1,
    validateOnCheckout: false,
  });
  const connectionA = Object.freeze({ ...CONNECTION, user: "TENANT_A" });
  const connectionB = Object.freeze({ ...CONNECTION, user: "TENANT_B" });
  const ownerA = productionDirectCompatibilityOwnerFactory.create({
    connection: connectionA,
    sessionFactory: supportA.factory,
    applicationPool: pool,
    repositoryPool: pool,
    metadata: { maxEntries: 8, maxRetainedBytes: 64 * 1_024 },
  });
  const ownerB = productionDirectCompatibilityOwnerFactory.create({
    connection: connectionB,
    sessionFactory: supportB.factory,
    applicationPool: pool,
    repositoryPool: pool,
    metadata: { maxEntries: 8, maxRetainedBytes: 64 * 1_024 },
  });
  try {
    assert.notEqual(
      ownerA.configuration.generationId,
      ownerB.configuration.generationId,
    );
    assert.notEqual(
      ownerA.configuration.identity.applicationCapability,
      ownerB.configuration.identity.applicationCapability,
    );
    assert.notEqual(
      ownerA.configuration.identity.repositoryCapability,
      ownerB.configuration.identity.repositoryCapability,
    );

    const [metadataA, metadataB] = await Promise.all([
      ownerA.getFunctionInterface("Z_TENANT_ISOLATION"),
      ownerB.getFunctionInterface("Z_TENANT_ISOLATION"),
    ]);
    assert.notEqual(metadataA, metadataB);
    assert.equal(
      supportA.events.filter((event) => event.includes("Z_TENANT_ISOLATION"))
        .length,
      1,
    );
    assert.equal(
      supportB.events.filter((event) => event.includes("Z_TENANT_ISOLATION"))
        .length,
      1,
    );

    const [contextA, contextB] = await Promise.all([
      ownerA.beginContext(),
      ownerB.beginContext(),
    ]);
    const canceled = new AbortController();
    canceled.abort(new Error("tenant A canceled"));
    await assert.rejects(
      ownerA.invokeContext(
        contextA,
        { functionName: "Z_TENANT_ISOLATION", parameters: {} },
        canceled.signal,
      ),
      DirectDestinationMetadataPreflightError,
    );
    await ownerB.pingContext(contextB);
    assert.equal(ownerA.monitor().contexts.pinnedLeases, 1);
    assert.equal(ownerB.monitor().contexts.pinnedLeases, 1);

    await ownerA.endContext(contextA);
    await ownerA.retire();
    assert.equal(ownerA.monitor().state, "retired");
    assert.equal(ownerB.monitor().state, "active");
    assert.equal(ownerB.monitor().contexts.pinnedLeases, 1);
    assert.equal(
      await ownerB.getFunctionInterface("Z_TENANT_ISOLATION"),
      metadataB,
    );
    assert.deepEqual(
      await ownerB.invokeContext(contextB, {
        functionName: "Z_TENANT_ISOLATION",
        parameters: {},
      }),
      {
        SESSION_ID: 2,
        FUNCTION: "Z_TENANT_ISOLATION",
        INPUT: undefined,
        STRUCTURES: 0,
        RETURN: { TYPE: "", MESSAGE: "" },
      },
    );
    await ownerB.endContext(contextB);
  } finally {
    await Promise.allSettled([
      ownerA.retire(),
      ownerB.retire(),
      supportA.owner.retire(),
      supportB.owner.retire(),
    ]);
  }
});

test("domain-separates password and ticket principal identities", async () => {
  const pool = Object.freeze({
    maxConnections: 1,
    maxWaiters: 1,
    acquireTimeoutMs: 1_000,
    lifecycleTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    lowWater: 0,
    idleHigh: 1,
    validateOnCheckout: false,
  });
  const sharedText = "same-credential-text";
  const connectionBase = {
    host: CONNECTION.host,
    applicationServerHost: CONNECTION.applicationServerHost,
    port: CONNECTION.port,
    applicationServerService: CONNECTION.applicationServerService,
    client: CONNECTION.client,
    user: CONNECTION.user,
    language: CONNECTION.language,
    sysnr: CONNECTION.sysnr,
    cpicStreaming: CONNECTION.cpicStreaming,
  } as const;
  const passwordOwner = productionDirectCompatibilityOwnerFactory.create({
    connection: Object.freeze({ ...connectionBase, password: sharedText }),
    applicationPool: pool,
  });
  const ticketOwner = productionDirectCompatibilityOwnerFactory.create({
    connection: Object.freeze({ ...connectionBase, ticket: sharedText }),
    applicationPool: pool,
  });
  try {
    assert.notEqual(
      passwordOwner.configuration.identity.applicationCapability,
      ticketOwner.configuration.identity.applicationCapability,
    );
  } finally {
    await Promise.allSettled([passwordOwner.retire(), ticketOwner.retire()]);
  }
});

test("rejects malformed destination operations before lease or repository I/O", async () => {
  const { owner, events } = ownerFixture();

  for (const options of [null, []]) {
    await assert.rejects(
      owner.acquireApplication(options as never),
      /application acquire options must be an object/u,
    );
    await assert.rejects(
      owner.acquireApplications(1, options as never),
      /application acquire options must be an object/u,
    );
  }
  await assert.rejects(owner.acquireApplications(0), /acquire count must be an integer/u);

  for (const invocation of [null, []]) {
    assert.throws(
      () => owner.invoke({} as never, invocation as never),
      /invocation must be an object/u,
    );
  }
  for (const [invocation, pattern] of [
    [{ functionName: "", parameters: {} }, /functionName must be a non-empty/u],
    [
      { functionName: "Z".repeat(31), parameters: {} },
      /functionName must contain 1\.\.30 ASCII/u,
    ],
    [
      { functionName: "BAD\nNAME", parameters: {} },
      /functionName must contain 1\.\.30 ASCII/u,
    ],
    [{ functionName: "RFC_PING", parameters: null }, /parameters must be an object/u],
    [{ functionName: "RFC_PING", parameters: [] }, /parameters must be an object/u],
    [
      { functionName: "RFC_PING", parameters: {}, notRequested: null },
      /notRequested must be a set/u,
    ],
    [
      { functionName: "RFC_PING", parameters: {}, activated: new Set([""]) },
      /activated values must be non-empty strings/u,
    ],
  ] as const) {
    assert.throws(
      () => owner.invoke({} as never, invocation as never),
      pattern,
    );
  }
  assert.throws(
    () => owner.invoke(
      {} as never,
      { functionName: "RFC_PING", parameters: {} },
      {} as AbortSignal,
    ),
    /operation signal must be an AbortSignal/u,
  );
  assert.throws(
    () => owner.pingApplication(null as never),
    /application lease must be an opaque owner token/u,
  );
  assert.throws(
    () => owner.applicationInfo({} as never),
    /does not belong to this destination/u,
  );

  for (const options of [null, []]) {
    await assert.rejects(
      owner.releaseApplication({} as never, options as never),
      /application release options must be an object/u,
    );
  }
  for (const options of [
    { idleHigh: -1 },
    { idleHigh: 1.5 },
    { reusable: "yes" },
    { reset: "yes" },
  ]) {
    await assert.rejects(
      owner.releaseApplication({} as never, options as never),
      /application release/u,
    );
  }
  await assert.rejects(
    owner.releaseApplication({} as never, { idleHigh: 3 }),
    /idleHigh exceeds application pool capacity/u,
  );

  for (const name of ["", "Z".repeat(31), "BAD\nNAME"]) {
    await assert.rejects(owner.getFunctionInterface(name), /1\.\.30 ASCII/u);
    await assert.rejects(owner.getRecursiveFunctionMetadata(name), /1\.\.30 ASCII/u);
    await assert.rejects(owner.getStructureDefinition(name), /1\.\.30 ASCII/u);
  }
  assert.throws(
    () => owner.refreshOptimizedMetadata(null as never, []),
    /function names must be an array/u,
  );
  assert.throws(
    () => owner.refreshOptimizedMetadata([], null as never),
    /structure names must be an array/u,
  );
  assert.throws(
    () => owner.refreshOptimizedMetadata(
      Array.from({ length: 513 }, () => "RFC_PING"),
      [],
    ),
    /at most 512 function names/u,
  );
  assert.throws(
    () => owner.refreshOptimizedMetadata(["RFC_PING", "RFC_PING"], []),
    /duplicate function name RFC_PING/u,
  );
  assert.throws(
    () => owner.refreshOptimizedMetadata(new Array(1) as string[], []),
    /must be an own data property/u,
  );
  assert.throws(
    () => owner.refreshOptimizedMetadata([], [], {} as AbortSignal),
    /operation signal must be an AbortSignal/u,
  );
  assert.deepEqual(await owner.refreshOptimizedMetadata([], []), {
    checkedFunctionNames: [],
    checkedStructureNames: [],
    invalidatedFunctionNames: [],
    invalidatedStructureNames: [],
  });
  assert.deepEqual(events, []);
  await owner.retire();
});

test("classifies transaction failures and validates adapter dependencies", async () => {
  assert.equal(
    classifyDirectDestinationTransactionFailure(
      new DirectDestinationMetadataPreflightError("RFC_PING", new Error("metadata")),
    ),
    "recoverable",
  );
  assert.equal(
    classifyDirectDestinationTransactionFailure(
      new DirectCpicPreWireError(new Error("serialization")),
    ),
    "recoverable",
  );
  const reusable = new RfcCoreError(createRfcFailure({
    category: RfcFailureCategory.AbapException,
    origin: RfcFailureOrigin.Sap,
    phase: RfcOperationPhase.EnvelopeDecode,
    transmission: RfcTransmissionState.Complete,
    establishedSession: true,
    reasonCode: "DECLARED",
    key: "DECLARED",
    message: "declared",
  }));
  assert.equal(reusable.failure.disposition, RfcConnectionDisposition.Reusable);
  assert.equal(classifyDirectDestinationTransactionFailure(reusable), "recoverable");
  assert.equal(
    classifyDirectDestinationTransactionFailure(new Error("unknown")),
    "ambiguous",
  );

  for (const invalid of [null, undefined]) {
    assert.throws(
      () => createDirectDestinationTransactionAdapter(invalid as never),
      /owner must be an object/u,
    );
  }
  for (const missing of [
    "acquireApplication",
    "invoke",
    "resetApplication",
    "releaseApplication",
  ] as const) {
    const fake = {
      acquireApplication() {},
      invoke() {},
      resetApplication() {},
      releaseApplication() {},
      [missing]: undefined,
    };
    assert.throws(
      () => createDirectDestinationTransactionAdapter(fake as never),
      new RegExp(`owner\\.${missing} must be a function`),
    );
  }
});

test("preflights classic metadata on a bounded repository lane before same-lease application use", async () => {
  const { owner, events, sessions } = ownerFixture();
  const lease = await owner.acquireApplication();

  assert.deepEqual(Object.keys(lease), []);
  assert.equal("session" in lease, false);
  const info = await owner.applicationInfo(lease);
  assert.equal(Object.isFrozen(info), true);
  assert.equal(info.peerCodePage, "4103");
  await owner.pingApplication(lease);

  const first = await owner.invoke(lease, {
    functionName: "Z_OWNER_TEST",
    parameters: { INPUT: { VALUE: 7 } },
  });
  const second = await owner.invoke(lease, {
    functionName: "Z_OWNER_TEST",
    parameters: { INPUT: { VALUE: 8 } },
  });

  assert.equal(first.SESSION_ID, second.SESSION_ID);
  const application = sessions.find((session) => session.lane === "application")!;
  const repository = sessions.find((session) => session.lane === "repository")!;
  assert.notEqual(application.id, repository.id);
  assert.equal(
    events.filter((event) => event.includes(":Z_OWNER_TEST") && event.startsWith("function:"))
      .length,
    1,
  );
  assert.equal(
    events.filter((event) => event.includes(":ZLINE") && event.startsWith("structure:"))
      .length,
    1,
  );
  assert.equal(
    events.indexOf(`structure:repository:${repository.id}:ZLINE`) <
      events.indexOf(`invoke:application:${application.id}:Z_OWNER_TEST`),
    true,
  );

  await owner.resetApplication(lease);
  assert.equal(events.includes(`reset:application:${application.id}`), true);
  await owner.releaseApplication(lease, { reusable: true });
  await assert.rejects(
    owner.releaseApplication(lease, { reusable: false }),
    /already been released/u,
  );

  const monitor = owner.monitor();
  assert.equal(Object.isFrozen(monitor), true);
  assert.equal(monitor.applicationPool.maxConnections, 2);
  assert.equal(monitor.repositoryPool.maxConnections, 1);
  assert.equal(monitor.metadata.entries, 2);
  assert.equal("password" in monitor, false);
  await owner.retire();
});

test("suppressed recursive outputs skip destination metadata work", async () => {
  const name = "Z_OWNER_SUPPRESSED_RECURSIVE";
  const parameter = (
    parameterName: string,
    exid: "v" | "h",
    tableName: string,
    position: number,
  ) => Object.freeze({
    parameterClass: "E" as const,
    parameterName,
    tableName,
    fieldName: "",
    exid,
    position,
    offset: 0,
    internalLength: 32,
    decimals: 0,
    defaultValue: "",
    parameterText: "",
    optional: true,
  });
  const metadata: RfcFunctionInterface = Object.freeze({
    ...functionInterface(name),
    parameters: Object.freeze([
      parameter("OUT_V", "v", "Z_DEEP", 1),
      parameter("OUT_H", "h", "Z_DEEP_T", 2),
    ]),
  });
  const { owner, events } = ownerFixture({
    async getFunctionInterface(_session, functionName) {
      return Object.freeze({ ...metadata, name: functionName });
    },
  });
  const lease = await owner.acquireApplication();
  const output = await owner.invoke(lease, {
    functionName: name,
    parameters: {},
    notRequested: new Set(["OUT_V"]),
    deactivated: new Set(["OUT_H"]),
  });

  assert.equal(output.FUNCTION, name);
  assert.equal(
    events.some((event) => event.includes(`recursive-function`) && event.endsWith(`:${name}`)),
    false,
  );
  assert.equal(
    events.some((event) => event.startsWith("structure:") && event.includes("Z_DEEP")),
    false,
  );
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("auto mode probes and loads optimized metadata on the repository lane", async () => {
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
  });
  const lease = await owner.acquireApplication();
  const output = await owner.invoke(lease, {
    functionName: "Z_OWNER_TEST",
    parameters: { INPUT: { VALUE: 9 } },
  });
  assert.equal(output.FUNCTION, "Z_OWNER_TEST");
  assert.deepEqual(
    events.filter((event) => event.startsWith("optimized-")),
    [
      "optimized-function:repository:2:E:RFC_PING",
      "optimized-function:repository:2:E:Z_OWNER_TEST",
      "optimized-function:repository:2:E:RFC_PING",
      "optimized-recursive-function:repository:2:E:Z_OWNER_TEST",
      "optimized-structure:repository:2:E:ZLINE",
    ],
  );
  assert.equal(events.some((event) => event.startsWith("function:repository")), false);
  assert.equal(events.some((event) => event.startsWith("structure:repository")), false);
  assert.equal(owner.monitor().metadata.optimizedProbeCalls, 2);
  assert.equal(owner.monitor().metadata.optimizedFallbacks, 0);
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("caches and deduplicates tagged recursive functions through optimized-only metadata", async () => {
  const physicalLoad = deferred<RfcMetadataGetRecursiveFunctionResult>();
  let recursiveLoads = 0;
  const { owner, events } = ownerFixture({
    // Flat metadata deliberately stays classic; recursive metadata must still
    // select its own OptimizedOnly lookup identity.
    repositoryMode: MetadataRepositoryMode.Classic,
    async getOptimizedRecursiveFunctionDescriptor() {
      recursiveLoads += 1;
      return physicalLoad.promise;
    },
  });

  const first = owner.getRecursiveFunctionMetadata("Z_RECURSIVE_CACHE");
  const second = owner.getRecursiveFunctionMetadata("Z_RECURSIVE_CACHE");
  await until(() => recursiveLoads === 1, "recursive metadata load did not start");
  const graph = recursiveFunctionGraph("Z_RECURSIVE_CACHE");
  physicalLoad.resolve(Object.freeze({
    value: graph,
    generationToken: graph.functionIdentity!.generationToken,
  }));

  const [firstGraph, secondGraph] = await Promise.all([first, second]);
  assert.equal(firstGraph, graph);
  assert.equal(secondGraph, graph);
  assert.equal(firstGraph.parameters.length, 0);
  assert.equal(recursiveLoads, 1);
  assert.equal(owner.monitor().metadata.inFlightJoins, 1);
  assert.equal(owner.monitor().optimizedGenerationTokens, 1);
  assert.deepEqual(
    events.filter((event) => event.startsWith("optimized-")),
    [
      "optimized-function:repository:1:E:RFC_PING",
      "optimized-recursive-function:repository:1:E:Z_RECURSIVE_CACHE",
    ],
  );

  // The classic flat descriptor uses a distinct tagged structural key.
  const flat = await owner.getFunctionInterface("Z_RECURSIVE_CACHE");
  assert.equal(flat.name, "Z_RECURSIVE_CACHE");
  assert.equal(owner.monitor().metadata.entries, 2);
  assert.equal(
    events.filter((event) =>
      event.startsWith("optimized-recursive-function:")
    ).length,
    1,
  );
  await owner.retire();
});

test("passes one cached recursive graph to application invocation without flat aliases", async () => {
  const functionName = "Z_DEEP_OWNER";
  const metadata = deepTableFunctionInterface(functionName);
  // A fixed-width h row remains graph-owned. Its lack of dynamic fields must
  // not revive the obsolete flat-structure alias materialization path.
  const graph = deepTableFunctionGraph(functionName, "fixed");
  let recursiveLoads = 0;
  let invocations = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Classic,
    async getFunctionInterface(_session, name) {
      assert.equal(name, functionName);
      return metadata;
    },
    async getOptimizedRecursiveFunctionDescriptor(_session, name, language) {
      recursiveLoads += 1;
      assert.equal(name, functionName);
      assert.equal(language, "E");
      return Object.freeze({
        value: graph,
        generationToken: graph.functionIdentity!.generationToken,
      });
    },
    async invoke(
      _session,
      actualMetadata,
      input,
      structures,
      _signal,
      recursiveMetadata,
    ) {
      invocations += 1;
      assert.equal(actualMetadata, metadata);
      assert.equal(structures.size, 0);
      assert.equal(recursiveMetadata, graph);
      return Object.freeze({ OUT: input.IN });
    },
  });
  const input = Object.freeze([
    Object.freeze({ I: 42, C: "FIXED" }),
  ]);
  const lease = await owner.acquireApplication();

  const first = await owner.invoke(lease, {
    functionName,
    parameters: { IN: input },
  });
  const second = await owner.invoke(lease, {
    functionName,
    parameters: { IN: input },
  });

  assert.deepEqual(first.OUT, input);
  assert.deepEqual(second.OUT, input);
  assert.equal(invocations, 2);
  assert.equal(recursiveLoads, 1);
  assert.equal(
    events.filter((event) =>
      event.startsWith("optimized-recursive-function:") &&
      event.endsWith(`:${functionName}`)
    ).length,
    1,
  );
  assert.equal(
    events.some((event) => event.includes(":Z_DEEP_T") &&
      (event.startsWith("structure:") ||
        event.startsWith("optimized-structure:"))),
    false,
  );
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("does not authorize or load recursive metadata for deactivated deep parameters", async () => {
  const functionName = "Z_DEEP_DEACTIVATED";
  const metadata = deepTableFunctionInterface(functionName);
  let recursiveLoads = 0;
  const { owner } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Classic,
    async getFunctionInterface() {
      return metadata;
    },
    async getOptimizedRecursiveFunctionDescriptor() {
      recursiveLoads += 1;
      throw new Error("deactivated recursive metadata must not be fetched");
    },
    async invoke(_session, actualMetadata, input, structures) {
      assert.equal(actualMetadata, metadata);
      assert.deepEqual(input, {});
      assert.equal(structures.size, 0);
      return Object.freeze({ OUT: [] });
    },
  });
  const lease = await owner.acquireApplication();

  assert.deepEqual(
    await owner.invoke(lease, {
      functionName,
      parameters: {},
      deactivated: new Set(["IN", "OUT"]),
    }),
    { OUT: [] },
  );
  assert.equal(recursiveLoads, 0);
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("loads flat metadata needed for a deactivated structure output initial value", async () => {
  const functionName = "Z_FLAT_DEACTIVATED";
  const metadata: RfcFunctionInterface = Object.freeze({
    ...functionInterface(functionName),
    parameters: Object.freeze([
      Object.freeze({
        parameterClass: "E",
        parameterName: "OUT",
        tableName: STRUCTURE.name,
        fieldName: "",
        exid: "u",
        position: 1,
        offset: 0,
        internalLength: STRUCTURE.byteLength,
        decimals: 0,
        defaultValue: "",
        parameterText: "",
        optional: false,
      }),
    ]),
  });
  let recursiveLoads = 0;
  let structureLoads = 0;
  const { owner } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Classic,
    async getFunctionInterface() {
      return metadata;
    },
    async getStructureDefinition(_session, name) {
      structureLoads += 1;
      assert.equal(name, STRUCTURE.name);
      return STRUCTURE;
    },
    async getOptimizedRecursiveFunctionDescriptor() {
      recursiveLoads += 1;
      throw new Error("deactivated flat output must not fetch recursive metadata");
    },
    async invoke(_session, actualMetadata, input, structures) {
      assert.equal(actualMetadata, metadata);
      assert.deepEqual(input, {});
      assert.equal(structures.get(STRUCTURE.name), STRUCTURE);
      return Object.freeze({ OUT: Object.freeze({ VALUE: 0 }) });
    },
  });
  const lease = await owner.acquireApplication();

  assert.deepEqual(
    await owner.invoke(lease, {
      functionName,
      parameters: {},
      deactivated: new Set(["OUT"]),
    }),
    { OUT: { VALUE: 0 } },
  );
  assert.equal(recursiveLoads, 0);
  assert.equal(structureLoads, 1);
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("falls back to an independent flat descriptor for an incomplete optional DDIC closure", async () => {
  const functionName = "Z_OPTIONAL_FLAT_DDIC_FALLBACK";
  const metadata = functionInterface(functionName, true);
  let recursiveLoads = 0;
  let structureLoads = 0;
  let invocations = 0;
  const { owner } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface(_session, name) {
      return name === functionName ? metadata : functionInterface(name);
    },
    async getOptimizedRecursiveFunctionDescriptor() {
      recursiveLoads += 1;
      throw new RecursiveMetadataError(
        "REMOTE_DDIC_RESOLUTION_ERRORS",
        "DD_ERRORS:1",
      );
    },
    async getOptimizedStructureDefinition(_session, name) {
      structureLoads += 1;
      assert.equal(name, STRUCTURE.name);
      return STRUCTURE;
    },
    async invoke(_session, actualMetadata, input, structures, _signal, graph) {
      invocations += 1;
      assert.equal(actualMetadata, metadata);
      assert.deepEqual(input, { INPUT: { VALUE: 42 } });
      assert.equal(structures.get(STRUCTURE.name), STRUCTURE);
      assert.equal(graph, undefined);
      return Object.freeze({});
    },
  });
  const lease = await owner.acquireApplication();

  assert.deepEqual(
    await owner.invoke(lease, {
      functionName,
      parameters: { INPUT: { VALUE: 42 } },
    }),
    {},
  );
  assert.equal(recursiveLoads, 1);
  assert.equal(structureLoads, 1);
  assert.equal(invocations, 1);
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("keeps an incomplete required table closure as a reusable pre-wire failure", async () => {
  const functionName = "Z_REQUIRED_TABLE_DDIC_FAILURE";
  const metadata = deepTableFunctionInterface(functionName);
  const ddicFailure = new RecursiveMetadataError(
    "REMOTE_DDIC_RESOLUTION_ERRORS",
    "DD_ERRORS:1",
  );
  let recursiveLoads = 0;
  let invocations = 0;
  const { owner } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface(_session, name) {
      return name === functionName ? metadata : functionInterface(name);
    },
    async getOptimizedRecursiveFunctionDescriptor() {
      recursiveLoads += 1;
      throw ddicFailure;
    },
    async invoke() {
      invocations += 1;
      return Object.freeze({});
    },
  });
  const lease = await owner.acquireApplication();

  await assert.rejects(
    owner.invoke(lease, {
      functionName,
      parameters: { IN: [] },
    }),
    (error: unknown) =>
      error instanceof DirectDestinationMetadataPreflightError &&
      error.cause === ddicFailure,
  );
  assert.equal(recursiveLoads, 1);
  assert.equal(invocations, 0);
  await owner.pingApplication(lease);
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("passes active graph metadata without inspecting a deactivated h descriptor", async () => {
  const functionName = "Z_DEEP_MIXED_ACTIVE";
  const base = deepTableFunctionInterface(functionName);
  const metadata: RfcFunctionInterface = Object.freeze({
    ...base,
    parameters: Object.freeze([
      ...base.parameters,
      Object.freeze({
        ...base.parameters[1]!,
        parameterClass: "T",
        parameterName: "BROKEN",
        tableName: "Z_MISSING_T",
        position: 3,
      }),
    ]),
  });
  const graph = deepTableFunctionGraph(functionName);
  let recursiveLoads = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Classic,
    async getFunctionInterface() {
      return metadata;
    },
    async getOptimizedRecursiveFunctionDescriptor() {
      recursiveLoads += 1;
      return Object.freeze({
        value: graph,
        generationToken: graph.functionIdentity!.generationToken,
      });
    },
    async invoke(
      _session,
      actualMetadata,
      input,
      structures,
      _signal,
      recursiveMetadata,
    ) {
      assert.equal(actualMetadata, metadata);
      assert.equal(structures.size, 0);
      assert.equal(recursiveMetadata, graph);
      return Object.freeze({ OUT: input.IN, BROKEN: [] });
    },
  });
  const rows = Object.freeze([
    Object.freeze({ STR: "active", XSTR: Buffer.from([1]) }),
  ]);
  const lease = await owner.acquireApplication();

  assert.deepEqual(
    await owner.invoke(lease, {
      functionName,
      parameters: { IN: rows },
      deactivated: new Set(["BROKEN"]),
    }),
    { OUT: rows, BROKEN: [] },
  );
  assert.equal(recursiveLoads, 1);
  assert.equal(
    events.some((event) => event.endsWith(":Z_MISSING_T")),
    false,
  );
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("rejects mixed optimized function generations before application entry", async () => {
  const functionName = "Z_DEEP_GENERATION_RACE";
  const metadata = deepTableFunctionInterface(functionName);
  const baseGraph = deepTableFunctionGraph(functionName);
  const graph = Object.freeze({
    ...baseGraph,
    functionIdentity: Object.freeze({
      ...baseGraph.functionIdentity!,
      generationToken: "function:20260716:010204",
    }),
  });
  let invocations = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface(_session, name) {
      return name === functionName ? metadata : functionInterface(name);
    },
    optimizedFunctionGeneration: () => "function:20260716:010203",
    async getOptimizedRecursiveFunctionDescriptor() {
      return Object.freeze({
        value: graph,
        generationToken: graph.functionIdentity!.generationToken,
      });
    },
    async invoke() {
      invocations += 1;
      return Object.freeze({});
    },
  });
  const lease = await owner.acquireApplication();

  await assert.rejects(
    owner.invoke(lease, {
      functionName,
      parameters: { IN: [] },
    }),
    (error: unknown) =>
      error instanceof DirectDestinationMetadataPreflightError &&
      /function and recursive metadata generations disagree/u.test(
        String(error.cause),
      ),
  );
  assert.equal(invocations, 0);
  assert.equal(
    events.filter((event) =>
      event.startsWith("optimized-recursive-function:") &&
      event.endsWith(`:${functionName}`)
    ).length,
    1,
  );
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("timestamp refresh invalidates a stale tagged recursive descriptor", async () => {
  let loadedTime = "010203";
  let observedToken = "function:20260716:010203";
  let recursiveLoads = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Classic,
    async getOptimizedRecursiveFunctionDescriptor(_session, name) {
      recursiveLoads += 1;
      const value = recursiveFunctionGraph(name, "20260716", loadedTime);
      return Object.freeze({
        value,
        generationToken: value.functionIdentity!.generationToken,
      });
    },
    async getOptimizedMetadataTimestamps(_session, functionNames) {
      return metadataTimestampBatch({
        functions: Object.fromEntries(
          functionNames.map((name) => [name, observedToken]),
        ),
      });
    },
  });

  await owner.getRecursiveFunctionMetadata("Z_RECURSIVE_REFRESH");
  assert.equal(owner.monitor().optimizedGenerationTokens, 1);
  observedToken = "function:20260716:010204";
  const refreshed = await owner.refreshOptimizedMetadata(
    ["Z_RECURSIVE_REFRESH"],
    [],
  );
  assert.deepEqual(refreshed.invalidatedFunctionNames, ["Z_RECURSIVE_REFRESH"]);
  assert.equal(owner.monitor().optimizedGenerationTokens, 0);
  assert.equal(owner.monitor().metadata.entries, 0);

  loadedTime = "010204";
  await owner.getRecursiveFunctionMetadata("Z_RECURSIVE_REFRESH");
  assert.equal(recursiveLoads, 2);
  assert.equal(
    events.filter((event) =>
      event.startsWith("optimized-recursive-function:") &&
      event.endsWith(":Z_RECURSIVE_REFRESH")
    ).length,
    2,
  );
  await owner.retire();
});

test("recursive optimized-only metadata never hides authorization, malformed, or communication failures", async () => {
  const cases = [
    new MetadataAccessFailure("authorization", "recursive metadata denied"),
    new MetadataAccessFailure("unavailable", "recursive metadata unavailable"),
    new MetadataAccessFailure("malformed", "recursive metadata malformed"),
    new MetadataAccessFailure("communication", "recursive metadata disconnected"),
    new Error("unclassified recursive decoder failure"),
  ] as const;

  for (const failure of cases) {
    const fixture = ownerFixture({
      repositoryMode: MetadataRepositoryMode.Auto,
      async getOptimizedRecursiveFunctionDescriptor() {
        throw failure;
      },
    });
    await assert.rejects(
      fixture.owner.getRecursiveFunctionMetadata("Z_RECURSIVE_FAILURE"),
      (error: unknown) => error === failure,
    );
    assert.equal(
      fixture.events.some((event) =>
        event.startsWith("function:repository:") &&
        event.endsWith(":Z_RECURSIVE_FAILURE")
      ),
      false,
    );
    assert.equal(fixture.owner.monitor().metadata.optimizedFallbacks, 0);
    await fixture.owner.retire();
  }
});

test("rejects a recursive descriptor whose same-response generation was detached", async () => {
  const graph = recursiveFunctionGraph("Z_RECURSIVE_IDENTITY");
  const { owner } = ownerFixture({
    async getOptimizedRecursiveFunctionDescriptor() {
      return Object.freeze({
        value: graph,
        generationToken: "function:20260716:010204",
      });
    },
  });

  await assert.rejects(
    owner.getRecursiveFunctionMetadata("Z_RECURSIVE_IDENTITY"),
    /mismatched identity/u,
  );
  assert.equal(owner.monitor().metadata.entries, 0);
  assert.equal(owner.monitor().optimizedGenerationTokens, 0);
  await owner.retire();
});

test("explicit timestamp refresh invalidates only changed or typed-missing optimized descriptors", async () => {
  let loadedFunctionToken = "function:20260716:010203";
  let loadedStructureToken = "structure:20260716010203";
  let observedFunctionToken = loadedFunctionToken;
  let observedStructureToken = loadedStructureToken;
  let structureMissing = false;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    optimizedFunctionGeneration: () => loadedFunctionToken,
    optimizedStructureGeneration: () => loadedStructureToken,
    async getOptimizedMetadataTimestamps(
      _session,
      functionNames,
      structureNames,
    ) {
      assert.equal(Object.isFrozen(functionNames), true);
      assert.equal(Object.isFrozen(structureNames), true);
      return metadataTimestampBatch({
        functions: Object.fromEntries(
          functionNames.map((name) => [name, observedFunctionToken]),
        ),
        ...(structureMissing
          ? {
              structureErrors: Object.fromEntries(
                structureNames.map((name) => [name, "DDIC_TYPE_NOT_FOUND"]),
              ),
            }
          : {
              structures: Object.fromEntries(
                structureNames.map((name) => [name, observedStructureToken]),
              ),
            }),
      });
    },
  });
  await owner.getFunctionInterface("Z_OWNER_TEST");
  await owner.getStructureDefinition("ZLINE");
  assert.equal(owner.monitor().optimizedGenerationTokens, 2);

  const functionNames = ["Z_OWNER_TEST"];
  const structureNames = ["ZLINE"];
  const unchanged = owner.refreshOptimizedMetadata(
    functionNames,
    structureNames,
  );
  functionNames[0] = "MUTATED_AFTER_ADMISSION";
  structureNames[0] = "MUTATED_AFTER_ADMISSION";
  const unchangedResult = await unchanged;
  assert.deepEqual(unchangedResult, {
    checkedFunctionNames: ["Z_OWNER_TEST"],
    checkedStructureNames: ["ZLINE"],
    invalidatedFunctionNames: [],
    invalidatedStructureNames: [],
  });
  assert.equal(Object.isFrozen(unchangedResult.checkedFunctionNames), true);
  assert.equal(owner.monitor().metadata.invalidations, 0);

  observedFunctionToken = "function:20260716:010204";
  loadedFunctionToken = observedFunctionToken;
  structureMissing = true;
  loadedStructureToken = "structure:20260716010204";
  const changed = await owner.refreshOptimizedMetadata(
    ["Z_OWNER_TEST"],
    ["ZLINE"],
  );
  assert.deepEqual(changed.invalidatedFunctionNames, ["Z_OWNER_TEST"]);
  assert.deepEqual(changed.invalidatedStructureNames, ["ZLINE"]);
  assert.equal(JSON.stringify(changed).includes("localized"), false);
  assert.equal(owner.monitor().metadata.invalidations, 2);
  assert.equal(owner.monitor().optimizedGenerationTokens, 0);

  structureMissing = false;
  observedStructureToken = loadedStructureToken;
  await owner.getFunctionInterface("Z_OWNER_TEST");
  await owner.getStructureDefinition("ZLINE");
  assert.equal(owner.monitor().optimizedGenerationTokens, 2);
  assert.equal(
    events.filter((event) =>
      event.includes(":Z_OWNER_TEST") &&
      event.startsWith("optimized-function:"),
    ).length,
    2,
  );
  assert.equal(
    events.filter((event) =>
      event.includes(":ZLINE") &&
      event.startsWith("optimized-structure:"),
    ).length,
    2,
  );
  assert.equal(events.some((event) => event.startsWith("function:repository")), false);
  await owner.retire();
});

test("deduplicates refreshes and rejects malformed or failed batches without partial invalidation or fallback", async () => {
  const firstRefresh = deferred<RfcMetadataTimestampBatch>();
  const protocolFailure = new MetadataAccessFailure(
    "malformed",
    "synthetic localized protocol failure",
  );
  let refreshCalls = 0;
  let loadedFunctionToken = "function:20260716:010203";
  let loadedStructureToken = "structure:20260716010203";
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    optimizedFunctionGeneration: () => loadedFunctionToken,
    optimizedStructureGeneration: () => loadedStructureToken,
    async getOptimizedMetadataTimestamps() {
      refreshCalls += 1;
      if (refreshCalls === 1) return firstRefresh.promise;
      if (refreshCalls === 2) {
        return metadataTimestampBatch({
          functions: {
            Z_OWNER_TEST: "function:20260716:010205",
          },
          // Missing ZLINE is malformed; it is not a typed error outcome.
        });
      }
      throw protocolFailure;
    },
  });
  await owner.getFunctionInterface("Z_OWNER_TEST");
  await owner.getStructureDefinition("ZLINE");

  const left = owner.refreshOptimizedMetadata(["Z_OWNER_TEST"], ["ZLINE"]);
  const right = owner.refreshOptimizedMetadata(["Z_OWNER_TEST"], ["ZLINE"]);
  await until(() => refreshCalls === 1, "timestamp refresh did not start");
  assert.equal(owner.monitor().metadataRefreshInFlight, 1);
  await assert.rejects(
    owner.refreshOptimizedMetadata(["RFC_PING"], []),
    /another optimized metadata timestamp refresh/u,
  );
  loadedFunctionToken = "function:20260716:010204";
  loadedStructureToken = "structure:20260716010204";
  firstRefresh.resolve(metadataTimestampBatch({
    functions: { Z_OWNER_TEST: loadedFunctionToken },
    structures: { ZLINE: loadedStructureToken },
  }));
  const [leftResult, rightResult] = await Promise.all([left, right]);
  assert.equal(leftResult, rightResult);
  assert.equal(refreshCalls, 1);
  assert.equal(owner.monitor().metadataRefreshInFlight, 0);
  assert.equal(owner.monitor().metadata.invalidations, 2);

  await owner.getFunctionInterface("Z_OWNER_TEST");
  await owner.getStructureDefinition("ZLINE");
  assert.equal(owner.monitor().optimizedGenerationTokens, 2);
  const beforeMalformed = owner.monitor().metadata.invalidations;
  await assert.rejects(
    owner.refreshOptimizedMetadata(["Z_OWNER_TEST"], ["ZLINE"]),
    /no outcome for structure ZLINE/u,
  );
  assert.equal(owner.monitor().metadata.invalidations, beforeMalformed);
  assert.equal(owner.monitor().optimizedGenerationTokens, 2);
  assert.equal(
    events.filter((event) => event.startsWith("close:repository:")).length,
    1,
  );

  await assert.rejects(
    owner.refreshOptimizedMetadata(["Z_OWNER_TEST"], ["ZLINE"]),
    (error: unknown) => error === protocolFailure,
  );
  assert.equal(owner.monitor().metadata.invalidations, beforeMalformed);
  assert.equal(owner.monitor().optimizedGenerationTokens, 2);
  assert.equal(
    events.filter((event) => event.startsWith("close:repository:")).length,
    2,
  );
  assert.equal(events.some((event) => event.startsWith("function:repository")), false);
  await owner.retire();
});

test("isolates caller cancellation while one deduplicated timestamp refresh continues", async () => {
  const physicalRefresh = deferred<RfcMetadataTimestampBatch>();
  let refreshCalls = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedMetadataTimestamps() {
      refreshCalls += 1;
      return physicalRefresh.promise;
    },
  });
  await owner.getFunctionInterface("Z_CANCEL_REFRESH");

  const controller = new AbortController();
  const canceled = owner.refreshOptimizedMetadata(
    ["Z_CANCEL_REFRESH"],
    [],
    controller.signal,
  );
  const remaining = owner.refreshOptimizedMetadata(["Z_CANCEL_REFRESH"], []);
  await until(() => refreshCalls === 1, "timestamp refresh did not start");
  controller.abort(new Error("caller-local cancellation detail"));
  await assert.rejects(
    canceled,
    (error: unknown) =>
      error instanceof MetadataAccessFailure &&
      error.classification === "canceled" &&
      error.cause === undefined &&
      !error.message.includes("caller-local cancellation detail"),
  );
  assert.equal(owner.monitor().metadataRefreshInFlight, 1);

  physicalRefresh.resolve(metadataTimestampBatch({
    functions: {
      Z_CANCEL_REFRESH: "function:20260716:010203",
    },
  }));
  const result = await remaining;
  assert.deepEqual(result.invalidatedFunctionNames, []);
  assert.equal(refreshCalls, 1);
  assert.equal(owner.monitor().metadataRefreshInFlight, 0);
  assert.equal(
    events.filter((event) => event.startsWith("close:repository:")).length,
    0,
  );
  await owner.retire();
});

test("does not let an in-flight refresh invalidate a descriptor reloaded on another repository session", async () => {
  const physicalRefresh = deferred<RfcMetadataTimestampBatch>();
  let loadedToken = "function:20260716:010203";
  let refreshCalls = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    maxMetadataEntries: 1,
    repositoryMaxConnections: 2,
    optimizedFunctionGeneration: () => loadedToken,
    async getOptimizedMetadataTimestamps() {
      refreshCalls += 1;
      return physicalRefresh.promise;
    },
  });
  await owner.getFunctionInterface("Z_RACE_REFRESH");
  const refresh = owner.refreshOptimizedMetadata(["Z_RACE_REFRESH"], []);
  await until(() => refreshCalls === 1, "timestamp refresh did not start");

  await owner.getFunctionInterface("Z_EVICT_REFRESH");
  loadedToken = "function:20260716:010204";
  await owner.getFunctionInterface("Z_RACE_REFRESH");
  physicalRefresh.resolve(metadataTimestampBatch({
    functions: {
      Z_RACE_REFRESH: "function:20260716:010205",
    },
  }));

  const result = await refresh;
  assert.deepEqual(result.invalidatedFunctionNames, []);
  assert.equal(owner.monitor().optimizedGenerationTokens, 1);
  assert.equal(owner.monitor().metadata.invalidations, 0);
  assert.equal(
    events.filter((event) =>
      event.startsWith("optimized-function:") &&
      event.endsWith(":Z_RACE_REFRESH"),
    ).length,
    2,
  );
  await owner.retire();
});

test("rejects hostile timestamp iterables without reading pair accessors or leaking their errors", async () => {
  const secret = "private iterator payload";
  let pairGetterCalled = false;
  let refreshCalls = 0;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedMetadataTimestamps() {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return Object.freeze({
          functions: {
            [Symbol.iterator]() {
              return {
                next() {
                  throw new Error(secret);
                },
              };
            },
          },
          structures: new Map(),
          functionErrors: new Map(),
          structureErrors: new Map(),
        }) as unknown as RfcMetadataTimestampBatch;
      }
      const pair: unknown[] = ["Z_HOSTILE_REFRESH"];
      Object.defineProperty(pair, 1, {
        configurable: true,
        enumerable: true,
        get() {
          pairGetterCalled = true;
          throw new Error(secret);
        },
      });
      return Object.freeze({
        functions: {
          *[Symbol.iterator]() {
            yield pair;
          },
        },
        structures: new Map(),
        functionErrors: new Map(),
        structureErrors: new Map(),
      }) as unknown as RfcMetadataTimestampBatch;
    },
  });
  await owner.getFunctionInterface("Z_HOSTILE_REFRESH");
  const invalidationsBefore = owner.monitor().metadata.invalidations;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      owner.refreshOptimizedMetadata(["Z_HOSTILE_REFRESH"], []),
      (error: unknown) =>
        error instanceof TypeError && !error.message.includes(secret),
    );
    assert.equal(owner.monitor().metadata.invalidations, invalidationsBefore);
    assert.equal(owner.monitor().optimizedGenerationTokens, 1);
  }
  assert.equal(pairGetterCalled, false);
  assert.equal(
    events.filter((event) => event.startsWith("close:repository:")).length,
    2,
  );
  await owner.retire();
});

test("rechecks retirement after a caller signal observation before empty refresh success", async () => {
  const { owner } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
  });
  let abortedReads = 0;
  let retirement: Promise<void> | undefined;
  const signal = {
    get aborted() {
      abortedReads += 1;
      if (abortedReads === 2) retirement = owner.retire();
      return false;
    },
    get reason() {
      return undefined;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  await assert.rejects(
    owner.refreshOptimizedMetadata([], [], signal),
    /retired|retiring/u,
  );
  await retirement;
  assert.equal(abortedReads, 2);
  assert.equal(owner.monitor().state, "retired");
});

test("bounds optimized token state and drops it for classic fallback loads", async () => {
  const { owner } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    maxMetadataEntries: 2,
  });
  await owner.getFunctionInterface("Z_ONE");
  await owner.getFunctionInterface("Z_TWO");
  await owner.getFunctionInterface("Z_THREE");
  assert.equal(owner.monitor().maxOptimizedGenerationTokens, 2);
  assert.equal(owner.monitor().optimizedGenerationTokens, 2);
  const untracked = await owner.refreshOptimizedMetadata(["Z_ONE"], []);
  assert.deepEqual(untracked.invalidatedFunctionNames, []);
  await owner.retire();

  const fallback = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface(_session, name) {
      if (name === "RFC_PING") return functionInterface(name);
      throw new MetadataAccessFailure(
        "authorization",
        "optimized object metadata is not authorized",
      );
    },
  });
  await fallback.owner.getFunctionInterface("Z_CLASSIC_FALLBACK");
  assert.equal(fallback.owner.monitor().optimizedGenerationTokens, 0);
  await fallback.owner.retire();
});

test("retirement aborts a timestamp refresh, clears tokens, and drains its repository lease", async () => {
  let refreshStarted = false;
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    getOptimizedMetadataTimestamps(_session, _functions, _structures, signal) {
      refreshStarted = true;
      return new Promise<RfcMetadataTimestampBatch>((_resolve, reject) => {
        const onAbort = (): void => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
      });
    },
  });
  await owner.getFunctionInterface("Z_RETIRE_REFRESH");
  const refresh = owner.refreshOptimizedMetadata(["Z_RETIRE_REFRESH"], []);
  await until(() => refreshStarted, "timestamp refresh did not enter the session");
  const retirement = owner.retire();
  await assert.rejects(refresh, /canceled|retired/u);
  await retirement;
  assert.equal(owner.monitor().optimizedGenerationTokens, 0);
  assert.equal(owner.monitor().metadataRefreshInFlight, 0);
  assert.equal(owner.monitor().repositoryPool.state, "closed");
  assert.equal(
    events.filter((event) => event.startsWith("close:repository:")).length,
    1,
  );
});

test("auto mode falls back only after a classified optimized capability miss", async () => {
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface(_session, name) {
      assert.equal(name, "RFC_PING");
      throw new MetadataAccessFailure("unavailable", "optimized metadata absent");
    },
  });
  const metadata = await owner.getFunctionInterface("Z_OWNER_TEST");
  assert.equal(metadata.name, "Z_OWNER_TEST");
  assert.equal(
    events.filter((event) => event.includes("optimized-function")).length,
    1,
  );
  assert.equal(
    events.filter((event) => event.startsWith("function:repository")).length,
    1,
  );
  assert.equal(owner.monitor().metadata.optimizedFallbacks, 1);
  await owner.retire();
});

test("auto mode falls back after a classified optimized object authorization failure", async () => {
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface(_session, name) {
      if (name === "RFC_PING") return functionInterface(name);
      throw new MetadataAccessFailure(
        "authorization",
        "optimized object metadata is not authorized",
      );
    },
  });
  const metadata = await owner.getFunctionInterface("Z_OWNER_TEST");
  assert.equal(metadata.name, "Z_OWNER_TEST");
  assert.equal(
    events.filter((event) => event.startsWith("optimized-function")).length,
    2,
  );
  assert.equal(
    events.filter((event) => event.startsWith("function:repository")).length,
    1,
  );
  assert.equal(owner.monitor().metadata.optimizedFallbacks, 1);
  await owner.retire();
});

test("auto mode never hides an unclassified optimized probe failure", async () => {
  const failure = new Error("synthetic optimized protocol failure");
  const { owner, events } = ownerFixture({
    repositoryMode: MetadataRepositoryMode.Auto,
    async getOptimizedFunctionInterface() {
      throw failure;
    },
  });
  await assert.rejects(owner.getFunctionInterface("Z_OWNER_TEST"), failure);
  assert.equal(
    events.filter((event) => event.startsWith("function:repository")).length,
    0,
  );
  assert.equal(owner.monitor().metadata.optimizedFallbacks, 0);
  await owner.retire();
});

test("rejects invalid metadata names before repository acquisition", async () => {
  const { owner, events } = ownerFixture();

  for (const name of ["", "Z".repeat(31), "Z_Ä"]) {
    await assert.rejects(
      owner.getFunctionInterface(name),
      /functionName must contain 1\.\.30 ASCII bytes/u,
    );
    await assert.rejects(
      owner.getStructureDefinition(name),
      /structureName must contain 1\.\.30 ASCII bytes/u,
    );
  }

  assert.deepEqual(events, []);
  const monitor = owner.monitor();
  assert.equal(monitor.repositoryPool.connections, 0);
  assert.equal(monitor.repositoryPool.leasesIssued, 0);
  assert.equal(monitor.metadata.lookups, 0);
  await owner.retire();
});

test("deduplicates concurrent descriptor loads without lending application leases to metadata", async () => {
  const functionGate = deferred<RfcFunctionInterface>();
  let calls = 0;
  const { owner, events } = ownerFixture({
    async getFunctionInterface(_session, name) {
      calls += 1;
      assert.equal(name, "Z_OWNER_TEST");
      return functionGate.promise;
    },
  });
  await assert.rejects(owner.acquireApplications(3), /acquire count/u);
  assert.equal(owner.monitor().applicationLeases, 0);
  const acquired = await owner.acquireApplications(2);
  assert.equal(Object.isFrozen(acquired), true);
  const leftLease = acquired[0]!;
  const rightLease = acquired[1]!;
  const left = owner.invoke(leftLease, {
    functionName: "Z_OWNER_TEST",
    parameters: { INPUT: { VALUE: 1 } },
  });
  const right = owner.invoke(rightLease, {
    functionName: "Z_OWNER_TEST",
    parameters: { INPUT: { VALUE: 2 } },
  });
  await until(() => calls === 1, "repository function load did not start");
  assert.equal(
    events.some((event) => event.startsWith("invoke:application:")),
    false,
  );
  functionGate.resolve(functionInterface("Z_OWNER_TEST", true));
  await Promise.all([left, right]);
  assert.equal(calls, 1);
  assert.equal(
    events.filter((event) => event.startsWith("structure:repository:")).length,
    1,
  );
  await Promise.all([
    owner.releaseApplication(leftLease, { reusable: false }),
    owner.releaseApplication(rightLease, { reusable: false }),
  ]);
  await owner.retire();
});

test("captures nested invocation values before asynchronous metadata preflight", async () => {
  const functionGate = deferred<RfcFunctionInterface>();
  const observed: Array<Readonly<Record<string, unknown>>> = [];
  const { owner } = ownerFixture({
    async getFunctionInterface() {
      return functionGate.promise;
    },
    async invoke(_session, _metadata, input) {
      observed.push(input);
      return Object.freeze({ INPUT: input });
    },
  });
  const lease = await owner.acquireApplication();
  const bytes = Buffer.from("010203", "hex");
  const structure = { VALUE: 1, BYTES: bytes };
  const rows = [{ VALUE: 2 }];
  const parameters = { INPUT: structure, ROWS: rows };

  const pending = owner.invoke(lease, {
    functionName: "Z_CAPTURE_VALUES",
    parameters,
  });
  await until(
    () => owner.monitor().metadata.inFlight === 1,
    "metadata preflight did not start",
  );
  structure.VALUE = 91;
  bytes.fill(0xff);
  rows[0]!.VALUE = 92;
  rows.push({ VALUE: 93 });
  parameters.INPUT = { VALUE: 94, BYTES: Buffer.alloc(0) };

  functionGate.resolve(functionInterface("Z_CAPTURE_VALUES"));
  await pending;
  assert.deepEqual(observed, [{
    INPUT: { VALUE: 1, BYTES: Buffer.from("010203", "hex") },
    ROWS: [{ VALUE: 2 }],
  }]);
  assert.equal(Object.isFrozen(observed[0]), true);
  assert.equal(Object.isFrozen(observed[0]!.INPUT), true);
  assert.equal(Object.isFrozen(observed[0]!.ROWS), true);
  await owner.releaseApplication(lease, { reusable: false });
  await owner.retire();
});

test("claims release once and quarantines it behind a hung application tail", async () => {
  const invocation = deferred<Readonly<Record<string, unknown>>>();
  const { owner, events } = ownerFixture({
    invoke: () => invocation.promise,
  });
  const lease = await owner.acquireApplication();
  const pendingInvocation = owner.invoke(lease, {
    functionName: "Z_HUNG",
    parameters: {},
  });
  await until(
    () => events.some((event) => event.includes(":Z_HUNG")),
    "application invocation did not start",
  );

  const release = owner.releaseApplication(lease, { reusable: false });
  await assert.rejects(
    owner.releaseApplication(lease, { reusable: false }),
    /already been released/u,
  );
  await Promise.resolve();
  assert.equal(events.some((event) => event.startsWith("close:application:")), false);
  assert.equal(owner.monitor().quarantinedApplicationTails, 1);

  invocation.resolve(Object.freeze({ RESULT: "late" }));
  assert.deepEqual(await pendingInvocation, { RESULT: "late" });
  await release;
  assert.equal(events.some((event) => event.startsWith("close:application:")), true);
  assert.equal(owner.monitor().quarantinedApplicationTails, 0);
  await owner.retire();
});

test("reset-on-release waits for the admitted tail and reuses the same session", async () => {
  const invocation = deferred<Readonly<Record<string, unknown>>>();
  const { owner, events } = ownerFixture({
    invoke: () => invocation.promise,
  });
  const lease = await owner.acquireApplication();
  const info = await owner.applicationInfo(lease);
  const pending = owner.invoke(lease, {
    functionName: "Z_RESET_TAIL",
    parameters: {},
  });
  await until(
    () => events.some((event) => event.endsWith(":Z_RESET_TAIL")),
    "application invocation did not start",
  );

  const release = owner.releaseApplication(lease, {
    reusable: true,
    reset: true,
  });
  await Promise.resolve();
  assert.equal(
    events.some((event) => event === `reset:application:${info.connectionIndex}`),
    false,
  );

  invocation.resolve(Object.freeze({ RESULT: "done" }));
  await pending;
  await release;
  assert.equal(
    events.indexOf(`invoke:application:${info.connectionIndex}:Z_RESET_TAIL`) <
      events.indexOf(`reset:application:${info.connectionIndex}`),
    true,
  );

  const reused = await owner.acquireApplication();
  assert.equal((await owner.applicationInfo(reused)).connectionIndex, info.connectionIndex);
  await owner.releaseApplication(reused, { reusable: false });
  await owner.retire();
});

test("marks repository preflight failures recoverable without touching the application session", async () => {
  const metadataFailure = new Error("metadata fixture failed");
  const { owner, events } = ownerFixture({
    async getFunctionInterface() {
      throw metadataFailure;
    },
  });
  const lease = await owner.acquireApplication();
  let observed: unknown;
  try {
    await owner.invoke(lease, {
      functionName: "Z_MISSING",
      parameters: {},
    });
  } catch (error) {
    observed = error;
  }
  assert.equal(observed instanceof DirectDestinationMetadataPreflightError, true);
  assert.equal(
    classifyDirectDestinationTransactionFailure(observed),
    "recoverable",
  );
  assert.equal(
    events.some((event) => event.startsWith("invoke:application:")),
    false,
  );
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("keeps an abort observed after cached metadata preflight outside application entry", async () => {
  const { owner, events } = ownerFixture();
  await owner.getFunctionInterface("Z_ABORT_AFTER_PREFLIGHT");
  const lease = await owner.acquireApplication();
  let abortedReads = 0;
  const stagedSignal = {
    get aborted() {
      abortedReads += 1;
      return abortedReads >= 6;
    },
    get reason() {
      return new Error("staged abort");
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  let observed: unknown;
  try {
    await owner.invoke(
      lease,
      { functionName: "Z_ABORT_AFTER_PREFLIGHT", parameters: {} },
      stagedSignal,
    );
  } catch (error) {
    observed = error;
  }
  assert.equal(observed instanceof DirectDestinationMetadataPreflightError, true);
  assert.equal(abortedReads >= 6, true);
  assert.equal(
    events.some((event) => event.includes("invoke:application:")),
    false,
  );
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
});

test("closes a newly opened raw session when method binding rejects", async () => {
  let closes = 0;
  const { owner } = ownerFixture({
    openSession() {
      return {
        async close() {
          closes += 1;
        },
      } as unknown as DirectCpicSession;
    },
  });
  await assert.rejects(owner.acquireApplication(), /session\.info/u);
  assert.equal(closes, 1);
  await owner.retire();
});

test("context begin/end reference-counts one pinned application lease", async () => {
  const { owner, events, sessions } = ownerFixture();
  const token: SessionContextToken = await owner.beginContext();
  assert.equal(await owner.beginContext(token), token);

  const result = await owner.invokeContext(token, {
    functionName: "Z_CONTEXT",
    parameters: {},
  });
  await owner.pingContext(token);
  const application = sessions.find((session) => session.lane === "application")!;
  assert.equal(result.SESSION_ID, application.id);
  assert.equal(
    events.filter((event) => event.startsWith("open:application:")).length,
    1,
  );

  let monitor = owner.monitor();
  assert.equal(monitor.applicationLeases, 1);
  assert.equal(monitor.contextPinnedApplicationLeases, 1);
  assert.equal(monitor.ordinaryApplicationLeases, 0);
  assert.equal(monitor.contexts.pinnedLeases, 1);
  assert.equal(monitor.contexts.references, 2);

  await owner.endContext(token);
  assert.equal(owner.monitor().contexts.references, 1);
  assert.equal(
    events.filter((event) => event.startsWith("reset:application:")).length,
    0,
  );

  await owner.endContext(token);
  monitor = owner.monitor();
  assert.equal(monitor.applicationLeases, 0);
  assert.equal(monitor.contextPinnedApplicationLeases, 0);
  assert.equal(monitor.contexts.pinnedLeases, 0);
  assert.equal(monitor.contexts.resetCalls, 1);
  assert.equal(monitor.contexts.reusableReleases, 1);
  assert.equal(monitor.applicationPool.idle, 1);
  assert.equal(
    events.filter((event) => event === `reset:application:${application.id}`).length,
    1,
  );
  await owner.retire();
});

test("context rejects concurrent work and end until its admitted call settles", async () => {
  const invocation = deferred<Readonly<Record<string, unknown>>>();
  const { owner, events } = ownerFixture({
    invoke: () => invocation.promise,
  });
  const token = await owner.beginContext();
  const active = owner.invokeContext(token, {
    functionName: "Z_CONTEXT_ACTIVE",
    parameters: {},
  });
  await until(
    () => events.some((event) => event.endsWith(":Z_CONTEXT_ACTIVE")),
    "context invocation did not start",
  );

  await assert.rejects(
    owner.pingContext(token),
    (error: unknown) =>
      error instanceof SessionContextRuntimeError &&
      error.code === "CONCURRENT_CONTEXT_OPERATION",
  );
  await assert.rejects(
    owner.endContext(token),
    (error: unknown) =>
      error instanceof SessionContextRuntimeError &&
      error.code === "ACTIVE_CONTEXT_OPERATION",
  );
  assert.equal(owner.monitor().contexts.activeOperations, 1);

  invocation.resolve(Object.freeze({ RESULT: "done" }));
  assert.deepEqual(await active, { RESULT: "done" });
  await owner.endContext(token);
  assert.equal(
    events.filter((event) => event.startsWith("open:application:")).length,
    1,
  );
  await owner.retire();
});

test("context keeps proven preflight failures recoverable on the pinned lease", async () => {
  const metadataFailure = new Error("metadata unavailable");
  const { owner, events } = ownerFixture({
    async getFunctionInterface() {
      throw metadataFailure;
    },
  });
  const token = await owner.beginContext();

  await assert.rejects(
    owner.invokeContext(token, {
      functionName: "Z_CONTEXT_PREFLIGHT",
      parameters: {},
    }),
    (error: unknown) =>
      error instanceof DirectDestinationMetadataPreflightError,
  );
  assert.equal(owner.monitor().contexts.pinnedLeases, 1);
  assert.equal(owner.monitor().contexts.fatalRemovals, 0);
  assert.equal(
    events.some((event) => event.startsWith("close:application:")),
    false,
  );

  await owner.pingContext(token);
  await owner.endContext(token);
  await owner.retire();
});

test("context reset failure evicts the pinned lease exactly once", async () => {
  const resetFailure = new Error("reset failed");
  const { owner, events } = ownerFixture({
    async reset(session) {
      if (session.lane === "application") throw resetFailure;
    },
  });
  const token = await owner.beginContext();

  await assert.rejects(owner.endContext(token), (error) => error === resetFailure);
  const monitor = owner.monitor();
  assert.equal(monitor.contexts.resetFailures, 1);
  assert.equal(monitor.contexts.evictions, 1);
  assert.equal(monitor.contexts.reusableReleases, 0);
  assert.equal(monitor.contexts.pinnedLeases, 0);
  assert.equal(
    events.filter((event) => event.startsWith("close:application:")).length,
    1,
  );
  await owner.retire();
});

test("ambiguous context invocation failure removes and evicts its lease", async () => {
  const invocationFailure = new Error("application outcome is unknown");
  const { owner, events } = ownerFixture({
    async invoke() {
      throw invocationFailure;
    },
  });
  const token = await owner.beginContext();

  await assert.rejects(
    owner.invokeContext(token, {
      functionName: "Z_CONTEXT_FATAL",
      parameters: {},
    }),
    (error) => error === invocationFailure,
  );
  const monitor = owner.monitor();
  assert.equal(monitor.contexts.fatalRemovals, 1);
  assert.equal(monitor.contexts.evictions, 1);
  assert.equal(monitor.contexts.pinnedLeases, 0);
  assert.equal(monitor.applicationLeases, 0);
  assert.equal(
    events.filter((event) => event.startsWith("close:application:")).length,
    1,
  );
  await assert.rejects(
    owner.endContext(token),
    (error: unknown) =>
      error instanceof SessionContextRuntimeError &&
      error.code === "CONTEXT_FATAL",
  );
  await owner.retire();
});

test("owner retirement closes the context gate before draining its application pool", async () => {
  const applicationClose = deferred<void>();
  const { owner, events } = ownerFixture({
    close: (session) =>
      session.lane === "application"
        ? applicationClose.promise
        : Promise.resolve(),
  });
  const token = await owner.beginContext();
  const retirement = owner.retire();

  await assert.rejects(
    owner.beginContext(),
    (error: unknown) =>
      error instanceof SessionContextRuntimeError &&
      error.code === "RUNTIME_RETIRED",
  );
  await until(
    () => events.some((event) => event.startsWith("close:application:")),
    "context retirement did not start physical application eviction",
  );
  assert.equal(owner.monitor().contexts.state, "retiring");
  assert.equal(owner.monitor().applicationPool.state, "open");
  applicationClose.resolve();
  await retirement;
  const monitor = owner.monitor();
  assert.equal(monitor.contexts.state, "retired");
  assert.equal(monitor.contexts.evictions, 1);
  assert.equal(monitor.contexts.pinnedLeases, 0);
  assert.equal(monitor.applicationPool.state, "closed");
  assert.equal(
    events.filter((event) => event.startsWith("close:application:")).length,
    1,
  );
  await assert.rejects(
    owner.pingContext(token),
    (error: unknown) =>
      error instanceof SessionContextRuntimeError &&
      error.code === "RUNTIME_RETIRED",
  );
});

test("owner publishes one retirement before a context close can reenter it", async () => {
  let owner!: DirectDestinationOwner;
  let reentrantRetirement: Promise<void> | undefined;
  const fixture = ownerFixture({
    async close(session) {
      if (
        session.lane === "application" &&
        reentrantRetirement === undefined
      ) {
        reentrantRetirement = owner.retire();
      }
    },
  });
  owner = fixture.owner;
  await owner.beginContext();

  const retirement = owner.retire();
  await retirement;
  assert.equal(reentrantRetirement, retirement);
  assert.equal(owner.retire(), retirement);
  assert.equal(owner.monitor().state, "retired");
  assert.equal(owner.monitor().contexts.retireCalls, 1);
  assert.equal(
    fixture.events.filter((event) => event.startsWith("close:application:"))
      .length,
    1,
  );
});

test("transaction adapter keeps business, commit, reset, and release on one opaque lease", async () => {
  const { owner, events } = ownerFixture();
  const adapter = createDirectDestinationTransactionAdapter(owner);
  const transaction = new TransactionRuntime({
    leases: adapter,
    operationTimeoutMs: 1_000,
    classifyFailure: classifyDirectDestinationTransactionFailure,
  });
  const token = await transaction.begin();
  const result = await transaction.call(token, "Z_TRANSACTION", { VALUE: 4 });
  assert.equal(result.FUNCTION, "Z_TRANSACTION");
  await transaction.commit(token);

  const applicationInvocations = events.filter((event) =>
    event.startsWith("invoke:application:"),
  );
  assert.equal(applicationInvocations.length, 2);
  const ids = new Set(applicationInvocations.map((event) => event.split(":")[2]));
  assert.equal(ids.size, 1);
  const applicationId = applicationInvocations[0]!.split(":")[2];
  assert.equal(events.includes(`reset:application:${applicationId}`), true);
  assert.equal(transaction.monitor().state, "closed");
  assert.equal(owner.monitor().applicationPool.idle, 1);
  await owner.retire();
});

test("captures the injected factory, session methods, connection, and invocation inputs once", async () => {
  const { owner, factory, sessions } = ownerFixture();
  factory.open = async () => {
    throw new Error("mutated factory method must not run");
  };
  const lease = await owner.acquireApplication();
  const application = sessions.find((session) => session.lane === "application")!;
  application.invokeClassicWithMetadata = async () => {
    throw new Error("mutated session method must not run");
  };
  let reads = 0;
  const parameters = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(parameters, "VALUE", {
    enumerable: true,
    get() {
      reads += 1;
      return reads;
    },
  });
  const result = await owner.invoke(lease, {
    functionName: "Z_CAPTURE",
    parameters,
  });
  assert.equal(result.INPUT, undefined);
  assert.equal(reads, 1);
  await owner.releaseApplication(lease, { reusable: false });
  await owner.retire();
});

test("retirement drains both finite pools and the destination generation", async () => {
  const { owner } = ownerFixture();
  const lease = await owner.acquireApplication();
  await owner.invoke(lease, { functionName: "Z_RETIRE", parameters: {} });
  await owner.releaseApplication(lease, { reusable: true });
  await owner.retire();
  const monitor = owner.monitor();
  assert.equal(monitor.state, "retired");
  assert.equal(monitor.applicationPool.state, "closed");
  assert.equal(monitor.repositoryPool.state, "closed");
  assert.equal(monitor.destination.generation.state, "retired");
  assert.equal(monitor.metadata.state, "retired");
  await assert.rejects(owner.acquireApplication(), /retired/u);
});
