import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectCpicPreWireError,
  type DirectCpicSessionInfo,
} from "../src/client/direct-cpic-session.js";
import { buildClassicRfcInvocationRequest } from "../src/client/classic-invocation.js";
import { ABAPError } from "../src/client/rfc-errors.js";
import {
  RfcCoreError,
  RfcFailureCategory,
  RfcFailureOrigin,
  RfcOperationPhase,
  RfcTransmissionState,
  createRfcFailure,
} from "../src/client/rfc-failure.js";
import type {
  NormalizedDirectConnection,
} from "../src/compat/connection-parameters.js";
import {
  NodeRFCLibraryError,
  NodeRFCLibraryErrorCode,
  RFCClient,
  RFCError,
  type RFCConnection,
  type RFCInputParams,
  type RFCLogger,
} from "../src/compat/node-rfc-library.js";
import {
  bindRFCClientDestinationOwnerFactory,
  type RFCClientDestinationOwnerFactory,
} from "../src/compat/rfc-client-owner-registry.js";
import type {
  DirectDestinationApplicationLease,
  DirectDestinationInvocation,
  DirectDestinationOwner,
  DirectDestinationReleaseOptions,
} from "../src/destination/direct-destination-owner.js";
import {
  TransactionBapiError,
  TransactionRuntimeError,
  TransactionTerminalError,
} from "../src/lifecycle/transaction-runtime.js";
import type { RfcFunctionInterface } from "../src/metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../src/metadata/rfc-structure-definition.js";
import {
  CpicTag,
  decodeCpicFieldChainPrefix,
} from "../src/protocol/cpic.js";

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
  limit = 300,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

function assertNoInternalTransactionErrors(error: unknown): void {
  const pending: unknown[] = [error];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    assert.equal(current instanceof TransactionBapiError, false);
    assert.equal(current instanceof TransactionRuntimeError, false);
    assert.equal(current instanceof TransactionTerminalError, false);
    if (current instanceof AggregateError) pending.push(...current.errors);
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    if (cause !== undefined && "value" in cause) pending.push(cause.value);
  }
}

function scalarFunction(name: string): RfcFunctionInterface {
  const inputParameters: RfcFunctionInterface["parameters"] =
    name === "Z_SECOND"
      ? Object.freeze([
          Object.freeze({
            parameterClass: "C",
            parameterName: "VALUE",
            tableName: "",
            fieldName: "",
            exid: "I",
            position: 1,
            offset: 0,
            internalLength: 4,
            decimals: 0,
            defaultValue: "",
            parameterText: "fixture changing value",
            optional: true,
          }),
        ])
      : name === "Z_SNAPSHOT"
        ? Object.freeze([
            Object.freeze({
              parameterClass: "I",
              parameterName: "STRUCTURE",
              tableName: "",
              fieldName: "",
              exid: "C",
              position: 1,
              offset: 0,
              internalLength: 20,
              decimals: 0,
              defaultValue: "",
              parameterText: "fixture structure-shaped value",
              optional: true,
            }),
            Object.freeze({
              parameterClass: "T",
              parameterName: "ROWS",
              tableName: "",
              fieldName: "",
              exid: "C",
              position: 2,
              offset: 0,
              internalLength: 20,
              decimals: 0,
              defaultValue: "",
              parameterText: "fixture table value",
              optional: true,
            }),
          ])
        : Object.freeze([
            Object.freeze({
              parameterClass: "I",
              parameterName: "VALUE",
              tableName: "",
              fieldName: "",
              exid: "I",
              position: 1,
              offset: 0,
              internalLength: 4,
              decimals: 0,
              defaultValue: "",
              parameterText: "fixture import value",
              optional: true,
            }),
          ]);
  return Object.freeze({
    name,
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: Object.freeze([
      ...inputParameters,
      Object.freeze({
        parameterClass: "E",
        parameterName: "RESULT",
        tableName: "",
        fieldName: "",
        exid: "C",
        position: inputParameters.length + 1,
        offset: 0,
        internalLength: 20,
        decimals: 0,
        defaultValue: "",
        parameterText: "fixture result",
        optional: false,
      }),
    ]),
    exceptions: Object.freeze([]),
    resumableExceptionRowCount: 0,
  });
}

function validationFunction(name: string): RfcFunctionInterface {
  const base = scalarFunction(name);
  const parameter = (
    parameterClass: "I" | "E" | "C" | "T",
    parameterName: string,
    position: number,
    optional: boolean,
  ): RfcFunctionInterface["parameters"][number] => Object.freeze({
    parameterClass,
    parameterName,
    tableName: "",
    fieldName: "",
    exid: parameterClass === "T" ? "C" : "I",
    position,
    offset: 0,
    internalLength: parameterClass === "T" ? 20 : 4,
    decimals: 0,
    defaultValue: "",
    parameterText: `fixture ${parameterName}`,
    optional,
  });
  return Object.freeze({
    ...base,
    parameters: Object.freeze([
      parameter("I", "REQUIRED", 1, false),
      parameter("I", "OPTIONAL", 2, true),
      parameter("C", "CHANGE", 3, false),
      parameter("T", "ROWS", 4, false),
      parameter("E", "RESULT", 5, false),
    ]),
  });
}

function bapiReturn(
  type: "" | "A" | "E" | "I" | "S" | "W" | "X" = "",
  message = "",
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    RETURN: Object.freeze({
      TYPE: type,
      ID: "ZTX",
      NUMBER: "001",
      MESSAGE: message,
    }),
  });
}

type BusinessHandler = (
  leaseId: number,
  invocation: DirectDestinationInvocation,
  signal: AbortSignal | undefined,
) => Promise<Readonly<Record<string, unknown>>>;

interface FakeOwnerOptions {
  readonly acquireGate?: Promise<void>;
  readonly acquireFailure?: unknown;
  readonly beforeAcquire?: (
    attemptId: number,
    signal: AbortSignal | undefined,
  ) => void | PromiseLike<void>;
  /** Test-only late-settlement behavior for adapters which ignored abort. */
  readonly allowAcquireAfterAbort?: boolean;
  readonly business?: BusinessHandler;
  readonly functionInterfaceGate?: Promise<void>;
  readonly metadataFailure?: unknown;
  readonly functionInterface?: (functionName: string) => RfcFunctionInterface;
  readonly reset?: (
    leaseId: number,
    signal: AbortSignal | undefined,
  ) => void | PromiseLike<void>;
  readonly release?: (
    leaseId: number,
    options: DirectDestinationReleaseOptions,
  ) => void | PromiseLike<void>;
  readonly retire?: () => void | PromiseLike<void>;
}

/**
 * Behavior-only owner double. The production transaction adapter deliberately
 * captures this boundary structurally; raw DirectCpicSession objects never
 * cross into the modern compatibility facade.
 */
class FakeDestinationOwner {
  readonly events: string[] = [];
  readonly metadataSignals: AbortSignal[] = [];
  readonly retirementOutstanding: number[] = [];
  readonly invocations: Array<{
    readonly leaseId: number;
    readonly invocation: DirectDestinationInvocation;
    readonly signal: AbortSignal | undefined;
  }> = [];
  readonly #leaseIds = new WeakMap<object, number>();
  readonly #released = new WeakSet<object>();
  readonly #outstanding = new Set<object>();
  readonly #control = new Map<
    string,
    Array<
      Readonly<Record<string, unknown>> |
      PromiseLike<Readonly<Record<string, unknown>>>
    >
  >();
  readonly #options: FakeOwnerOptions;
  #nextLeaseId = 1;
  #retired = false;

  constructor(options: FakeOwnerOptions = {}) {
    this.#options = options;
  }

  get outstandingLeaseCount(): number {
    return this.#outstanding.size;
  }

  enqueueControl(
    functionName: "BAPI_TRANSACTION_COMMIT" | "BAPI_TRANSACTION_ROLLBACK",
    result:
      | Readonly<Record<string, unknown>>
      | PromiseLike<Readonly<Record<string, unknown>>>,
  ): void {
    const queue = this.#control.get(functionName) ?? [];
    queue.push(result);
    this.#control.set(functionName, queue);
  }

  async acquireApplication(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<DirectDestinationApplicationLease> {
    if (this.#retired) throw new Error("fixture owner is retired");
    const id = this.#nextLeaseId++;
    this.events.push(`acquire:${id}`);
    await this.#options.beforeAcquire?.(id, options.signal);
    if (this.#options.acquireGate !== undefined) {
      await this.#options.acquireGate;
    }
    if (
      options.signal?.aborted === true &&
      this.#options.allowAcquireAfterAbort !== true
    ) {
      throw options.signal.reason;
    }
    if (this.#options.acquireFailure !== undefined) {
      throw this.#options.acquireFailure;
    }
    const lease = Object.freeze(Object.create(null)) as object;
    this.#leaseIds.set(lease, id);
    this.#outstanding.add(lease);
    return lease as DirectDestinationApplicationLease;
  }

  async invoke(
    lease: DirectDestinationApplicationLease,
    invocation: DirectDestinationInvocation,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const leaseId = this.#ownedLease(lease);
    const captured = Object.freeze({
      ...invocation,
      parameters: Object.freeze({ ...invocation.parameters }),
    });
    this.invocations.push(Object.freeze({ leaseId, invocation: captured, signal }));
    this.events.push(`invoke:${leaseId}:${captured.functionName}`);
    if (
      captured.functionName === "BAPI_TRANSACTION_COMMIT" ||
      captured.functionName === "BAPI_TRANSACTION_ROLLBACK"
    ) {
      const queued = this.#control.get(captured.functionName)?.shift();
      return queued ?? bapiReturn();
    }
    if (this.#options.business !== undefined) {
      return this.#options.business(leaseId, captured, signal);
    }
    return Object.freeze({
      LEASE_ID: leaseId,
      FUNCTION: captured.functionName,
      PARAMETERS: captured.parameters,
    });
  }

  async pingApplication(
    lease: DirectDestinationApplicationLease,
    _signal?: AbortSignal,
  ): Promise<Readonly<{ responseFieldCount: number }>> {
    const leaseId = this.#ownedLease(lease);
    this.events.push(`ping:${leaseId}`);
    return Object.freeze({ responseFieldCount: 0 });
  }

  async applicationInfo(
    lease: DirectDestinationApplicationLease,
  ): Promise<DirectCpicSessionInfo> {
    const leaseId = this.#ownedLease(lease);
    this.events.push(`info:${leaseId}`);
    return Object.freeze({
      localAddress: "127.0.0.1",
      peerCodePage: "4103",
      peerAcceptInfo: 0,
      generationHandle: leaseId,
      connectionIndex: leaseId,
    });
  }

  async resetApplication(
    lease: DirectDestinationApplicationLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const leaseId = this.#ownedLease(lease);
    this.events.push(`reset:${leaseId}`);
    await this.#options.reset?.(leaseId, signal);
  }

  async releaseApplication(
    lease: DirectDestinationApplicationLease,
    options: DirectDestinationReleaseOptions = {},
  ): Promise<void> {
    const leaseObject = lease as object;
    const leaseId = this.#ownedLease(lease);
    this.#released.add(leaseObject);
    this.#outstanding.delete(leaseObject);
    this.events.push(`release:${leaseId}:${options.reusable === true}`);
    await this.#options.release?.(leaseId, options);
  }

  async getFunctionInterface(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface> {
    this.events.push(`metadata:function:${functionName}`);
    if (signal !== undefined) this.metadataSignals.push(signal);
    if (this.#options.functionInterfaceGate !== undefined) {
      await this.#options.functionInterfaceGate;
    }
    if (this.#options.metadataFailure !== undefined) {
      throw this.#options.metadataFailure;
    }
    return this.#options.functionInterface?.(functionName) ??
      scalarFunction(functionName);
  }

  async getStructureDefinition(
    structureName: string,
    _signal?: AbortSignal,
  ): Promise<RfcStructureDefinition> {
    this.events.push(`metadata:structure:${structureName}`);
    throw new Error(`unexpected fixture structure lookup ${structureName}`);
  }

  async retire(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    const outstanding = this.#outstanding.size;
    this.retirementOutstanding.push(outstanding);
    if (outstanding !== 0) {
      throw new Error(
        `fixture owner retired with ${outstanding} outstanding lease(s)`,
      );
    }
    await this.#options.retire?.();
    this.events.push("retire");
  }

  monitor(): Readonly<Record<string, unknown>> {
    return Object.freeze({ state: this.#retired ? "retired" : "active" });
  }

  #ownedLease(lease: DirectDestinationApplicationLease): number {
    const leaseObject = lease as object;
    const id = this.#leaseIds.get(leaseObject);
    if (id === undefined || this.#released.has(leaseObject)) {
      throw new Error("fixture lease is not owned");
    }
    return id;
  }
}

interface RecordedLogger extends RFCLogger {
  readonly entries: Array<readonly [string, ...unknown[]]>;
}

function recordedLogger(): RecordedLogger {
  const entries: Array<readonly [string, ...unknown[]]> = [];
  return {
    entries,
    log(type: string, ...arguments_: readonly unknown[]) {
      entries.push([type, ...arguments_]);
    },
  };
}

function bindOwnerFactory(
  client: RFCClient,
  factory: RFCClientDestinationOwnerFactory,
): void {
  bindRFCClientDestinationOwnerFactory(client, factory);
}

const DIRECT_PARAMETERS: Record<string, unknown> = {
  ashost: "qas.fixture.invalid",
  sysnr: "0",
  client: "1",
  user: "fixture-user",
  passwd: ["fixture", "secret"].join("-"),
  lang: "en",
};

interface StartedFixture {
  readonly owner: FakeDestinationOwner;
  readonly logger: RecordedLogger;
  readonly parameters: Record<string, unknown>;
  readonly opening: Promise<RFCConnection>;
  readonly capturedConnections: NormalizedDirectConnection[];
}

function startFixture(options: FakeOwnerOptions = {}): StartedFixture {
  const owner = new FakeDestinationOwner(options);
  const logger = recordedLogger();
  const client = new RFCClient(logger);
  const capturedConnections: NormalizedDirectConnection[] = [];
  bindOwnerFactory(client, (connection) => {
    capturedConnections.push(connection);
    return owner as unknown as DirectDestinationOwner;
  });
  const parameters = { ...DIRECT_PARAMETERS };
  const opening = client.open(parameters);
  return { owner, logger, parameters, opening, capturedConnections };
}

async function openFixture(
  options: FakeOwnerOptions = {},
): Promise<StartedFixture & { readonly connection: RFCConnection }> {
  const fixture = startFixture(options);
  const connection = await fixture.opening;
  return { ...fixture, connection };
}

test("RFCClient.open snapshots direct credentials and resolves only after pinning a transaction lease", async () => {
  assert.equal(
    RFCClient.prototype.open.length,
    1,
    "the optional cancellation signal must not change the pinned public arity",
  );
  const acquire = deferred<void>();
  const fixture = startFixture({ acquireGate: acquire.promise });
  fixture.parameters.user = "mutated-user";
  fixture.parameters.passwd = ["mutated", "secret"].join("-");

  let settled = false;
  void fixture.opening.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await until(
    () => fixture.owner.events.includes("acquire:1"),
    "modern open did not begin its pinned transaction",
  );
  assert.equal(settled, false);
  acquire.resolve();

  const connection = await fixture.opening;
  assert.equal(fixture.capturedConnections.length, 1);
  const captured = fixture.capturedConnections[0]!;
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(captured.user, "fixture-user");
  assert.equal(captured.password, ["fixture", "secret"].join("-"));
  assert.equal(captured.sysnr, "00");
  assert.equal(captured.client, "001");
  assert.equal(captured.language, "E");
  assert.equal(connection.alive, true);
  const info = connection.connectionInfo;
  assert.equal(info instanceof Error, false);
  const connectedInfo = info as Readonly<Record<string, string>>;
  assert.equal(Object.isFrozen(connectedInfo), true);
  assert.deepEqual(Object.keys(connectedInfo).sort(), [
    "client",
    "codepage",
    "cpicConvId",
    "dest",
    "host",
    "isoLanguage",
    "kernelRel",
    "language",
    "partnerBytesPerChar",
    "partnerCodepage",
    "partnerHost",
    "partnerIP",
    "partnerIPv6",
    "partnerRel",
    "partnerSystemCodepage",
    "partnerType",
    "progName",
    "rel",
    "rfcRole",
    "sysId",
    "sysNumber",
    "trace",
    "type",
    "user",
  ]);
  assert.equal(connectedInfo.client, "001");
  assert.equal(connectedInfo.user, "fixture-user");
  assert.equal(Object.hasOwn(connectedInfo, "passwd"), false);

  await connection.close();
  assert.deepEqual(
    fixture.owner.events.filter((event) =>
      /^(?:invoke:1:BAPI_TRANSACTION_ROLLBACK|reset:1|release:1:true|retire)$/u.test(event)
    ),
    [
      "invoke:1:BAPI_TRANSACTION_ROLLBACK",
      "reset:1",
      "release:1:true",
      "retire",
    ],
  );
  assert.equal(connection.alive, false);
  const renderedLogs = JSON.stringify(fixture.logger.entries);
  assert.equal(renderedLogs.includes(["fixture", "secret"].join("-")), false);
  assert.equal(renderedLogs.includes(["mutated", "secret"].join("-")), false);
  assert.equal(fixture.logger.entries.some(([level]) => level === "debug"), true);
});

test("RFCClient.open cancellation aborts opening and redacts credentials", async () => {
  const acquire = deferred<void>();
  const owner = new FakeDestinationOwner({
    acquireGate: acquire.promise,
    allowAcquireAfterAbort: true,
  });
  const logger = recordedLogger();
  const client = new RFCClient(logger);
  bindOwnerFactory(client, () => owner as unknown as DirectDestinationOwner);
  const controller = new AbortController();
  const opening = client.open({ ...DIRECT_PARAMETERS }, controller.signal);
  await until(
    () => owner.events.includes("acquire:1"),
    "modern cancellable open did not begin acquisition",
  );
  controller.abort("fixture-stop");
  acquire.resolve();
  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof RFCError && error.codeString === "RFC_CANCELED",
  );
  assert.equal(owner.outstandingLeaseCount, 0);
  assert.equal(JSON.stringify(logger.entries).includes(["fixture", "secret"].join("-")), false);
});

test("RFCClient rejects unadmitted CAP credential properties without invoking accessors and isolates logger failures", async () => {
  const owner = new FakeDestinationOwner();
  let unrelatedPropertyReads = 0;
  let loggerReceiver: unknown;
  const logger: RFCLogger = {
    log() {
      loggerReceiver = this;
      throw new Error("fixture logger failed");
    },
  };
  const client = new RFCClient(logger);
  bindOwnerFactory(
    client,
    () => owner as unknown as DirectDestinationOwner,
  );
  const credentials = { ...DIRECT_PARAMETERS };
  Object.defineProperty(credentials, "capLocalOption", {
    enumerable: true,
    get() {
      unrelatedPropertyReads += 1;
      throw new Error("unrelated CAP option must not be inspected");
    },
  });

  await assert.rejects(
    client.open(credentials),
    (error: unknown) =>
      error instanceof RFCError &&
      error.codeString === "RFC_INVALID_PARAMETER" &&
      error.message ===
        "RFC connection parameter capLocalOption must be an own data property",
  );
  assert.equal(loggerReceiver, logger);
  assert.equal(unrelatedPropertyReads, 0);
  assert.deepEqual(owner.events, []);
});

test("execute and commit share one lease, metadata stays on the repository lane, and the next call opens a new LUW", async () => {
  const { owner, connection } = await openFixture();

  const first = await connection.execute("Z_FIRST", {
    import: { VALUE: 1 },
  });
  assert.equal(first.LEASE_ID, 1);
  await connection.commit();

  assert.equal(connection.alive, true);
  assert.deepEqual(
    owner.events.filter((event) =>
      /^(?:acquire|invoke|reset|release)/u.test(event)
    ),
    [
      "acquire:1",
      "invoke:1:Z_FIRST",
      "invoke:1:BAPI_TRANSACTION_COMMIT",
      "reset:1",
      "release:1:true",
    ],
  );

  const metadata = await connection.getMetadata("Z_AFTER_COMMIT");
  assert.equal(metadata.rfcName, "Z_AFTER_COMMIT");
  assert.equal(metadata.export[0]!.name, "RESULT");
  assert.equal(owner.events.filter((event) => event.startsWith("acquire:")).length, 1);
  assert.equal(owner.events.includes("metadata:function:Z_AFTER_COMMIT"), true);

  const second = await connection.execute("Z_SECOND", {
    changing: { VALUE: 2 },
  });
  assert.equal(second.LEASE_ID, 2);
  assert.equal(owner.events.includes("invoke:2:Z_SECOND"), true);

  await connection.close();
  assert.equal(owner.events.includes("invoke:2:BAPI_TRANSACTION_ROLLBACK"), true);
  assert.equal(owner.events.includes("reset:2"), true);
  assert.equal(owner.events.includes("release:2:true"), true);
  assert.equal(owner.events.at(-1), "retire");
});

test("ping keeps the idle pinned conversation alive and follows LUW rollover", async () => {
  const { owner, connection } = await openFixture();

  assert.equal(await connection.ping(), true);
  assert.equal(owner.events.includes("invoke:1:RFC_PING"), true);

  await connection.commit();
  assert.equal(await connection.ping(), true);
  assert.deepEqual(
    owner.events.filter((event) => event.startsWith("acquire:")),
    ["acquire:1", "acquire:2"],
  );
  assert.equal(owner.events.includes("invoke:2:RFC_PING"), true);

  await connection.close();
});

test("execute preserves grouped inputs, Promise results, and excluded output fields", async () => {
  let capturedInput: Readonly<Record<string, unknown>> | undefined;
  const { owner, connection } = await openFixture({
    async business(_leaseId, invocation) {
      capturedInput = invocation.parameters;
      return Object.freeze({ KEEP: "yes", DROP: "no" });
    },
  });
  const input: RFCInputParams = {
    import: { IMPORT_VALUE: 1 },
    changing: { CHANGING_VALUE: 2 },
    table: { ROWS: [{ VALUE: 3 }] },
  };
  const excluded = ["DROP"];
  const pending = connection.execute("Z_RESULT", input, false, excluded);
  excluded[0] = "MUTATED_AFTER_CALL";
  assert.equal(pending instanceof Promise, true);
  assert.deepEqual(await pending, { KEEP: "yes" });
  assert.deepEqual(capturedInput, {
    IMPORT_VALUE: 1,
    CHANGING_VALUE: 2,
    ROWS: [{ VALUE: 3 }],
  });
  assert.deepEqual(
    [...(owner.invocations[0]!.invocation.notRequested ?? [])],
    ["DROP"],
  );
  await connection.close();
});

test("execute snapshots nested structures, tables, and byte values before lazy acquire", async () => {
  const acquire = deferred<void>();
  let capturedInput: Readonly<Record<string, unknown>> | undefined;
  const { owner, connection } = await openFixture({
    beforeAcquire(attemptId) {
      return attemptId === 2 ? acquire.promise : undefined;
    },
    async business(_leaseId, invocation) {
      capturedInput = invocation.parameters;
      return Object.freeze({ RESULT: "captured" });
    },
  });
  await connection.commit();

  const raw = Buffer.from([1, 2, 3]);
  const structure = { TEXT: "before", RAW: raw };
  const rows = [{ VALUE: 1, NESTED: { FLAG: "X" } }];
  const pending = connection.execute("Z_SNAPSHOT", {
    import: { STRUCTURE: structure },
    table: { ROWS: rows },
  });
  await until(
    () => owner.events.includes("acquire:2"),
    "lazy snapshot fixture did not reach lease acquisition",
  );

  structure.TEXT = "after";
  raw[0] = 9;
  rows[0]!.VALUE = 2;
  rows[0]!.NESTED.FLAG = "";
  rows.push({ VALUE: 3, NESTED: { FLAG: "Y" } });
  acquire.resolve();

  assert.deepEqual(await pending, { RESULT: "captured" });
  assert.deepEqual(capturedInput, {
    STRUCTURE: { TEXT: "before", RAW: Buffer.from([1, 2, 3]) },
    ROWS: [{ VALUE: 1, NESTED: { FLAG: "X" } }],
  });
  assert.equal(Object.isFrozen(capturedInput?.STRUCTURE), true);
  assert.equal(Object.isFrozen(capturedInput?.ROWS), true);
  await connection.close();
});

test("default prevalidation enforces required membership, group direction, and exclusion validity before business I/O", async () => {
  const { owner, connection } = await openFixture({
    functionInterface: validationFunction,
  });
  const invalid = async (
    input: RFCInputParams,
    excluded: readonly string[] = [],
  ): Promise<void> => {
    await assert.rejects(
      connection.execute("Z_VALIDATE", input, true, excluded),
      (error: unknown) =>
        error instanceof NodeRFCLibraryError &&
        error.code === NodeRFCLibraryErrorCode.INVALID_PARAMETER,
    );
    assert.equal(connection.alive, true);
    assert.equal(
      owner.events.some((event) => event === "invoke:1:Z_VALIDATE"),
      false,
    );
  };

  await invalid({});
  await invalid({ import: { UNKNOWN: 1 } });
  await invalid({
    import: { CHANGE: 1 },
    changing: { REQUIRED: 1 },
    table: { ROWS: [] },
  });
  await invalid({
    import: { REQUIRED: 1 },
    changing: { CHANGE: 1 },
    table: { ROWS: [] },
  }, ["REQUIRED"]);

  const metadataEventsBeforeDisabled = owner.events.filter((event) =>
    event === "metadata:function:Z_VALIDATE"
  ).length;
  await connection.execute("Z_VALIDATE", {}, false);
  assert.equal(
    owner.events.filter((event) => event === "metadata:function:Z_VALIDATE").length,
    metadataEventsBeforeDisabled,
  );

  await connection.execute("Z_VALIDATE", {
    import: { REQUIRED: 1 },
    changing: { CHANGE: 2 },
    table: { ROWS: [] },
  });
  assert.equal(
    owner.events.filter((event) => event === "invoke:1:Z_VALIDATE").length,
    2,
  );
  await connection.close();
});

test("execute admission prevents delayed prevalidation from being overtaken by commit or rollback", async (context) => {
  for (const operation of ["commit", "rollback"] as const) {
    await context.test(operation, async () => {
      const metadata = deferred<void>();
      const { owner, connection } = await openFixture({
        functionInterfaceGate: metadata.promise,
      });

      const execution = connection.execute("Z_FIRST", {
        import: { VALUE: 1 },
      });
      await until(
        () => owner.events.includes("metadata:function:Z_FIRST"),
        "execute did not enter delayed metadata prevalidation",
      );

      await assert.rejects(
        connection[operation](),
        (error: unknown) =>
          error instanceof NodeRFCLibraryError &&
          error.code === NodeRFCLibraryErrorCode.INVALID_PARAMETER &&
          /execute operation is active/u.test(error.message),
      );
      assert.equal(
        owner.events.some((event) =>
          event === `invoke:1:BAPI_TRANSACTION_${operation.toUpperCase()}`
        ),
        false,
      );

      metadata.resolve();
      assert.equal((await execution).LEASE_ID, 1);
      await connection[operation]();
      assert.equal(
        owner.events.filter((event) =>
          event === `invoke:1:BAPI_TRANSACTION_${operation.toUpperCase()}`
        ).length,
        1,
      );
      assert.deepEqual(
        owner.events.filter((event) => event.startsWith("acquire:")),
        ["acquire:1"],
      );

      await connection.close();
      assert.equal(owner.outstandingLeaseCount, 0);
      assert.deepEqual(owner.retirementOutstanding, [0]);
    });
  }
});

test("excluded changing and table parameters satisfy prevalidation and deactivate both wire directions", async () => {
  const { owner, connection } = await openFixture({
    functionInterface: validationFunction,
    async business() {
      return Object.freeze({
        CHANGE: 9,
        ROWS: Object.freeze(["backend row"]),
        RESULT: "kept",
      });
    },
  });

  assert.deepEqual(
    await connection.execute(
      "Z_VALIDATE",
      { import: { REQUIRED: 1 } },
      true,
      ["CHANGE", "ROWS"],
    ),
    { RESULT: "kept" },
  );
  assert.deepEqual(owner.invocations[0]!.invocation.parameters, { REQUIRED: 1 });
  assert.deepEqual(
    [...(owner.invocations[0]!.invocation.notRequested ?? [])],
    ["CHANGE", "ROWS"],
  );

  const encoded = buildClassicRfcInvocationRequest(
    validationFunction("Z_VALIDATE"),
    { REQUIRED: 1, CHANGE: 2, ROWS: ["input row"] },
    new Map(),
    { notRequested: new Set(["CHANGE", "ROWS"]) },
  );
  const stateNames = decodeCpicFieldChainPrefix(
    encoded.subarray(4),
    CpicTag.ContextEnd,
    CpicTag.End,
  ).fields
    .filter((field) =>
      field.tag === CpicTag.RequestedOutput ||
      field.tag === CpicTag.ParameterName ||
      field.tag === CpicTag.TableName
    )
    .map((field) => Buffer.from(field.value).toString("utf16le"));
  assert.deepEqual(stateNames, ["RESULT", "REQUIRED"]);

  await connection.close();
});

test("invalid RFC names fail before transaction admission and preserve the pinned lease", async () => {
  const { owner, connection } = await openFixture();

  await assert.rejects(
    connection.execute("Z".repeat(31), {}),
    /1\.\.30 ASCII bytes/u,
  );
  await assert.rejects(
    connection.execute("Z_Ä", {}),
    /1\.\.30 ASCII bytes/u,
  );
  assert.equal(connection.alive, true);
  assert.deepEqual(owner.events, ["acquire:1"]);

  await connection.commit();
  await assert.rejects(
    connection.execute("Z".repeat(31), {}),
    /1\.\.30 ASCII bytes/u,
  );
  assert.deepEqual(
    owner.events.filter((event) => event.startsWith("acquire:")),
    ["acquire:1"],
  );

  assert.equal((await connection.execute("Z_VALID", {})).FUNCTION, "Z_VALID");
  await connection.close();
  assert.equal(owner.events.includes("invoke:2:BAPI_TRANSACTION_ROLLBACK"), true);
});

test("invalid metadata names fail before owner access", async () => {
  const { owner, connection } = await openFixture();
  const eventsBeforeMetadata = [...owner.events];

  await assert.rejects(
    connection.getMetadata("Z".repeat(31)),
    /1\.\.30 ASCII bytes/u,
  );
  await assert.rejects(
    connection.getMetadata("Z_Ä"),
    /1\.\.30 ASCII bytes/u,
  );

  assert.deepEqual(owner.events, eventsBeforeMetadata);
  assert.equal(connection.alive, true);
  await connection.close();
});

test("racing executes after commit share one lazy cycle and never acquire two replacement leases", async () => {
  const firstReply = deferred<Readonly<Record<string, unknown>>>();
  const { owner, connection } = await openFixture({
    business(leaseId, invocation) {
      if (invocation.functionName === "Z_LAZY_FIRST") {
        return firstReply.promise;
      }
      return Promise.resolve(Object.freeze({ LEASE_ID: leaseId }));
    },
  });
  await connection.commit();

  const first = connection.execute("Z_LAZY_FIRST", {});
  await until(
    () => owner.events.includes("invoke:2:Z_LAZY_FIRST"),
    "first lazy-cycle invocation did not start",
  );
  await assert.rejects(
    connection.execute("Z_LAZY_SECOND", {}),
    /concurrent|active|calling|operation/iu,
  );
  assert.deepEqual(
    owner.events.filter((event) => event.startsWith("acquire:")),
    ["acquire:1", "acquire:2"],
  );
  assert.equal(owner.outstandingLeaseCount, 1);

  firstReply.resolve(Object.freeze({ LEASE_ID: 2, RESULT: "first" }));
  assert.deepEqual(await first, { LEASE_ID: 2, RESULT: "first" });
  await connection.close();
  assert.equal(owner.events.includes("invoke:2:BAPI_TRANSACTION_ROLLBACK"), true);
  assert.equal(owner.outstandingLeaseCount, 0);
  assert.deepEqual(owner.retirementOutstanding, [0]);
});

test("close during a post-commit lazy acquire waits for late lease eviction before retirement", async () => {
  const lazyAcquire = deferred<void>();
  let lazySignal: AbortSignal | undefined;
  const { owner, connection } = await openFixture({
    beforeAcquire(attemptId, signal) {
      if (attemptId !== 2) return;
      lazySignal = signal;
      return lazyAcquire.promise;
    },
    allowAcquireAfterAbort: true,
  });
  await connection.commit();

  const execution = connection.execute("Z_AFTER_COMMIT_OPENING", {});
  const executionFailure = assert.rejects(
    execution,
    /closing|closed|abort|transaction/iu,
  );
  await until(
    () => owner.events.includes("acquire:2"),
    "post-commit lazy acquire did not start",
  );

  let closeSettled = false;
  const closing = connection.close().finally(() => {
    closeSettled = true;
  });
  await until(
    () => lazySignal?.aborted === true,
    "close did not abort the post-commit lazy acquire",
  );
  assert.equal(closeSettled, false);
  assert.equal(owner.events.includes("retire"), false);
  assert.equal(owner.outstandingLeaseCount, 0);

  lazyAcquire.resolve();
  await Promise.all([executionFailure, closing]);
  assert.equal(owner.events.includes("release:2:false"), true);
  assert.equal(
    owner.events.some((event) => event === "invoke:2:BAPI_TRANSACTION_ROLLBACK"),
    false,
  );
  assert.equal(owner.outstandingLeaseCount, 0);
  assert.deepEqual(owner.retirementOutstanding, [0]);
  assert.equal(owner.events.at(-1), "retire");
});

test("a proven pre-wire business failure preserves the lease for safe close rollback", async () => {
  const preparationFailure = new TypeError("fixture input conversion failed pre-wire");
  let calls = 0;
  const { owner, connection } = await openFixture({
    async business(leaseId) {
      calls += 1;
      if (calls === 1) throw new DirectCpicPreWireError(preparationFailure);
      return Object.freeze({ LEASE_ID: leaseId, RESULT: "recovered" });
    },
  });

  await assert.rejects(
    connection.execute("Z_PREWIRE_FAILURE", {}),
    (error: unknown) => error === preparationFailure,
  );
  assert.equal(connection.alive, true);
  assert.equal(owner.outstandingLeaseCount, 1);
  assert.equal(owner.events.some((event) => event.startsWith("release:1:")), false);

  assert.deepEqual(await connection.execute("Z_AFTER_PREWIRE", {}), {
    LEASE_ID: 1,
    RESULT: "recovered",
  });
  await connection.close();
  assert.equal(owner.events.includes("invoke:1:BAPI_TRANSACTION_ROLLBACK"), true);
  assert.equal(owner.events.includes("reset:1"), true);
  assert.equal(owner.events.includes("release:1:true"), true);
  assert.deepEqual(owner.retirementOutstanding, [0]);
});

test("reset failure after semantic commit evicts and poisons the logical connection", async () => {
  const resetFailure = new Error("fixture reset failed after committed SAP reply");
  const { owner, connection } = await openFixture({
    reset() {
      throw resetFailure;
    },
  });

  await assert.rejects(connection.commit(), (error: unknown) => {
    assertNoInternalTransactionErrors(error);
    assert.equal(error instanceof NodeRFCLibraryError, true);
    const projected = error as NodeRFCLibraryError & { readonly cause?: unknown };
    assert.equal(projected.code, NodeRFCLibraryErrorCode.UNKNOW_ERROR);
    assert.equal(projected.cause instanceof AggregateError, true);
    const cleanup = projected.cause as AggregateError;
    assert.deepEqual(cleanup.errors, [resetFailure]);
    assert.equal(cleanup.cause, resetFailure);
    assert.match(projected.message, /commit completed/iu);
    return true;
  });
  assert.equal(connection.alive, false);
  assert.equal(owner.events.includes("reset:1"), true);
  assert.equal(owner.events.includes("release:1:false"), true);
  assert.equal(owner.outstandingLeaseCount, 0);
  await assert.rejects(
    connection.execute("Z_MUST_NOT_REOPEN", {}),
    /closed|failed|transaction|connection/iu,
  );
  assert.deepEqual(
    owner.events.filter((event) => event.startsWith("acquire:")),
    ["acquire:1"],
  );
  await connection.close();
  assert.deepEqual(owner.retirementOutstanding, [0]);
});

test("terminal error projection preserves the public primary and every cleanup failure", async () => {
  const releaseFailure = new Error("fixture rejected lease eviction failed");
  const { owner, connection } = await openFixture({
    release() {
      throw releaseFailure;
    },
  });
  owner.enqueueControl(
    "BAPI_TRANSACTION_COMMIT",
    bapiReturn("E", "fixture semantic rejection"),
  );

  await assert.rejects(connection.commit(), (error: unknown) => {
    assertNoInternalTransactionErrors(error);
    assert.equal(error instanceof NodeRFCLibraryError, true);
    const projected = error as NodeRFCLibraryError & { readonly cause?: unknown };
    assert.equal(projected.code, NodeRFCLibraryErrorCode.UNKNOW_ERROR);
    assert.equal(projected.cause instanceof AggregateError, true);
    const terminal = projected.cause as AggregateError;
    assert.equal(terminal.errors.length, 2);
    assert.equal(terminal.errors[0] instanceof NodeRFCLibraryError, true);
    assert.match(
      (terminal.errors[0] as NodeRFCLibraryError).message,
      /fixture semantic rejection/u,
    );
    assert.equal(terminal.errors[1], releaseFailure);
    assert.equal(terminal.cause, terminal.errors[0]);
    return true;
  });

  assert.equal(connection.alive, false);
  assert.equal(owner.events.includes("release:1:false"), true);
  assert.equal(owner.outstandingLeaseCount, 0);
  await connection.close();
});

test("repeated commit and rollback each lazily open one empty LUW", async (t) => {
  for (const operation of ["commit", "rollback"] as const) {
    await t.test(operation, async () => {
      const { owner, connection } = await openFixture();
      await connection[operation]();
      assert.equal(owner.outstandingLeaseCount, 0);

      await connection[operation]();
      const functionName = operation === "commit"
        ? "BAPI_TRANSACTION_COMMIT"
        : "BAPI_TRANSACTION_ROLLBACK";
      assert.deepEqual(
        owner.events.filter((event) => event.startsWith("acquire:")),
        ["acquire:1", "acquire:2"],
      );
      assert.equal(
        owner.events.filter((event) => event.endsWith(`:${functionName}`)).length,
        2,
      );
      assert.deepEqual(
        owner.events.filter((event) => event.startsWith("release:")),
        ["release:1:true", "release:2:true"],
      );
      assert.equal(owner.outstandingLeaseCount, 0);

      await connection.close();
      assert.deepEqual(owner.retirementOutstanding, [0]);
      assert.equal(owner.events.at(-1), "retire");
    });
  }
});

test("commit and rollback accept only blank, S, I, and W BAPI RETURN types", async (t) => {
  for (const operation of ["commit", "rollback"] as const) {
    for (const type of ["", "S", "I", "W"] as const) {
      await t.test(`${operation} accepts ${type || "blank"}`, async () => {
        const { owner, connection } = await openFixture();
        const functionName = operation === "commit"
          ? "BAPI_TRANSACTION_COMMIT"
          : "BAPI_TRANSACTION_ROLLBACK";
        owner.enqueueControl(functionName, bapiReturn(type));

        await connection[operation]();

        assert.equal(connection.alive, true);
        assert.equal(owner.events.includes(`invoke:1:${functionName}`), true);
        assert.equal(owner.events.includes("reset:1"), true);
        assert.equal(owner.events.includes("release:1:true"), true);
        await connection.close();
        assert.equal(
          owner.events.filter((event) => event.includes("BAPI_TRANSACTION_")).length,
          1,
        );
        assert.equal(owner.events.at(-1), "retire");
      });
    }
  }
});

test("A, E, and X control returns reject, evict the lease, and poison the logical connection", async (t) => {
  for (const type of ["A", "E", "X"] as const) {
    await t.test(type, async () => {
      const { owner, connection } = await openFixture();
      owner.enqueueControl(
        "BAPI_TRANSACTION_COMMIT",
        bapiReturn(type, `fixture rejection ${type}`),
      );

      await assert.rejects(connection.commit(), (error: unknown) => {
        assert.equal(error instanceof NodeRFCLibraryError, true);
        const projected = error as NodeRFCLibraryError;
        assert.equal(projected.code, NodeRFCLibraryErrorCode.UNKNOW_ERROR);
        assert.match(projected.message, new RegExp(`fixture rejection ${type}`, "u"));
        return true;
      });
      assert.equal(connection.alive, false);
      assert.equal(owner.events.includes("reset:1"), false);
      assert.equal(owner.events.includes("release:1:false"), true);
      await assert.rejects(
        connection.execute("Z_MUST_NOT_REOPEN", {}),
        /closed|failed|transaction|connection/iu,
      );
      assert.equal(owner.events.filter((event) => event.startsWith("acquire:")).length, 1);
      await connection.close();
      assert.equal(owner.events.at(-1), "retire");
    });
  }
});

test("missing or malformed control RETURN is ambiguous and never reusable", async (t) => {
  const cases: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["missing", Object.freeze({})],
    ["empty table", Object.freeze({ RETURN: Object.freeze([]) })],
    ["invalid type", bapiReturn("Q" as "")],
    ["non-structure", Object.freeze({ RETURN: "not a structure" })],
  ];
  for (const [name, result] of cases) {
    await t.test(name, async () => {
      const { owner, connection } = await openFixture();
      owner.enqueueControl("BAPI_TRANSACTION_ROLLBACK", result);

      await assert.rejects(connection.rollback(), (error: unknown) => {
        assert.equal(error instanceof NodeRFCLibraryError, true);
        assert.equal(
          (error as NodeRFCLibraryError).code,
          NodeRFCLibraryErrorCode.UNKNOW_ERROR,
        );
        return true;
      });
      assert.equal(connection.alive, false);
      assert.equal(owner.events.includes("reset:1"), false);
      assert.equal(owner.events.includes("release:1:false"), true);
      await connection.close();
    });
  }
});

test("close is an idempotent safe rollback of an active CAP transaction", async () => {
  const { owner, connection } = await openFixture();
  await connection.execute("Z_CAP_REQUEST", { import: { VALUE: 4 } });

  const first = connection.close();
  const second = connection.close();
  await Promise.all([first, second]);

  assert.deepEqual(
    owner.events.filter((event) =>
      /^(?:invoke:1:BAPI_TRANSACTION_ROLLBACK|reset:1|release:1:true|retire)$/u.test(event)
    ),
    [
      "invoke:1:BAPI_TRANSACTION_ROLLBACK",
      "reset:1",
      "release:1:true",
      "retire",
    ],
  );
  assert.equal(connection.alive, false);
});

test("a fatal business failure is not replayed and evicts its one physical lease", async () => {
  const failure = new Error("fixture transport ended after request transmission");
  let calls = 0;
  const { owner, connection } = await openFixture({
    async business() {
      calls += 1;
      throw failure;
    },
  });

  await assert.rejects(connection.execute("Z_SIDE_EFFECT", {
    import: { VALUE: 1 },
  }), (error: unknown) => error === failure);
  assert.equal(calls, 1);
  assert.equal(owner.events.includes("release:1:false"), true);
  assert.equal(owner.events.some((event) => event.includes("BAPI_TRANSACTION_")), false);
  assert.equal(owner.events.includes("reset:1"), false);
  assert.equal(connection.alive, false);

  await assert.rejects(connection.execute("Z_SIDE_EFFECT", {
    import: { VALUE: 1 },
  }));
  assert.equal(calls, 1);
  assert.equal(owner.events.filter((event) => event.startsWith("acquire:")).length, 1);
  await connection.close();
  assert.equal(owner.events.at(-1), "retire");
});

test("modern facade projects typed MESSAGE and SYSTEM_FAILURE before eviction", async (t) => {
  for (const current of [
    {
      name: "SYSTEM_FAILURE",
      category: RfcFailureCategory.AbapRuntime,
      reasonCode: "RFC_REMOTE_ABAP_RUNTIME",
      key: "SYSTEM_FAILURE_ID",
      message: "Synthetic system failure",
      messageType: "X",
      code: 3,
      codeString: "RFC_ABAP_RUNTIME_FAILURE",
    },
    {
      name: "MESSAGE A",
      category: RfcFailureCategory.AbapMessage,
      reasonCode: "RFC_REMOTE_ABAP_MESSAGE",
      key: "Synthetic message &1",
      message: "Synthetic rendered message",
      messageType: "A",
      code: 4,
      codeString: "RFC_ABAP_MESSAGE",
    },
  ] as const) {
    await t.test(current.name, async () => {
      const coreError = new RfcCoreError(createRfcFailure({
        category: current.category,
        origin: RfcFailureOrigin.Sap,
        phase: RfcOperationPhase.EnvelopeDecode,
        transmission: RfcTransmissionState.Complete,
        establishedSession: true,
        correlationId: `modern.${current.name === "SYSTEM_FAILURE" ? "system" : "message"}`,
        reasonCode: current.reasonCode,
        key: current.key,
        message: current.message,
        abap: {
          exceptionKey: "",
          plainText: current.message,
          runtimeId: current.category === RfcFailureCategory.AbapRuntime
            ? current.key
            : "",
          t100Text: current.category === RfcFailureCategory.AbapMessage
            ? current.key
            : "Synthetic runtime &1",
          messageClass: "ZM",
          messageType: current.messageType,
          messageNumber: "042",
          messageV1: "one",
          messageV2: "two",
          messageV3: "three",
          messageV4: "four",
          callStack: "PRIVATE_MODERN_REMOTE_STACK",
          provenance: [
            { tag: 0x0402, ordinal: 0, byteLength: 48 },
            { tag: 0x0418, ordinal: 1, byteLength: 54 },
          ],
        },
      }));
      let calls = 0;
      const { owner, connection } = await openFixture({
        async business() {
          calls += 1;
          throw coreError;
        },
      });

      await assert.rejects(
        connection.execute("Z_FATAL_TYPED", {}, false),
        (error: unknown) => {
          assert.equal(error instanceof ABAPError, true);
          const projected = error as ABAPError;
          assert.deepEqual(
            {
              name: projected.name,
              group: projected.group,
              code: projected.code,
              codeString: projected.codeString,
              key: projected.key,
              message: projected.message,
              abapMsgClass: projected.abapMsgClass,
              abapMsgType: projected.abapMsgType,
              abapMsgNumber: projected.abapMsgNumber,
              abapMsgV1: projected.abapMsgV1,
              abapMsgV2: projected.abapMsgV2,
              abapMsgV3: projected.abapMsgV3,
              abapMsgV4: projected.abapMsgV4,
            },
            {
              name: "ABAPError",
              group: 2,
              code: current.code,
              codeString: current.codeString,
              key: current.key,
              message: current.message,
              abapMsgClass: "ZM",
              abapMsgType: current.messageType,
              abapMsgNumber: "042",
              abapMsgV1: "one",
              abapMsgV2: "two",
              abapMsgV3: "three",
              abapMsgV4: "four",
            },
          );
          assert.equal(
            JSON.stringify(projected).includes("PRIVATE_MODERN_REMOTE_STACK"),
            false,
          );
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.equal(owner.events.includes("release:1:false"), true);
      assert.equal(owner.events.includes("reset:1"), false);
      assert.equal(connection.alive, false);
      await assert.rejects(connection.execute("Z_MUST_NOT_REPLAY", {}, false));
      assert.equal(calls, 1);
      await connection.close();
    });
  }
});

test("repository metadata failure does not disturb the pinned application lease", async () => {
  const metadataFailure = new Error("fixture repository authorization denied");
  const { owner, connection } = await openFixture({ metadataFailure });

  await assert.rejects(
    connection.getMetadata("Z_METADATA_DENIED"),
    (error: unknown) => error === metadataFailure,
  );
  assert.equal(connection.alive, true);
  const result = await connection.execute(
    "Z_APPLICATION_STILL_PINNED",
    {},
    false,
  );
  assert.equal(result.LEASE_ID, 1);
  assert.equal(owner.events.includes("release:1:false"), false);
  await connection.close();
});

test("close waits for admitted execute prevalidation before retiring the owner", async () => {
  const metadataGate = deferred<void>();
  const { owner, connection } = await openFixture({
    functionInterfaceGate: metadataGate.promise,
  });

  const execution = connection.execute("Z_VALIDATING", {
    import: { VALUE: 1 },
  });
  await until(
    () => owner.events.includes("metadata:function:Z_VALIDATING"),
    "execute did not enter repository prevalidation",
  );

  let closeSettled = false;
  const closing = connection.close().finally(() => {
    closeSettled = true;
  });
  await until(
    () => owner.events.includes("release:1:true"),
    "close did not finish its safe rollback",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(owner.events.includes("retire"), false);
  assert.equal(owner.metadataSignals.length, 1);
  assert.equal(owner.metadataSignals[0]!.aborted, true);
  assert.equal(connection.alive, false);
  assert.equal(connection.connectionInfo instanceof Error, true);

  metadataGate.resolve();
  await assert.rejects(execution, /closing|closed/u);
  await closing;

  assert.equal(
    owner.events.some((event) => event === "invoke:1:Z_VALIDATING"),
    false,
  );
  assert.equal(owner.events.at(-1), "retire");
  assert.deepEqual(owner.retirementOutstanding, [0]);
});

test("close cancels and joins admitted metadata before retiring its repository owner", async () => {
  const metadataGate = deferred<void>();
  const { owner, connection } = await openFixture({
    functionInterfaceGate: metadataGate.promise,
  });

  const metadata = connection.getMetadata("Z_METADATA_IN_FLIGHT");
  await until(
    () => owner.events.includes("metadata:function:Z_METADATA_IN_FLIGHT"),
    "metadata lookup did not enter the repository lane",
  );

  let closeSettled = false;
  const closing = connection.close().finally(() => {
    closeSettled = true;
  });
  await until(
    () => owner.events.includes("release:1:true"),
    "close did not finish its safe rollback",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(owner.events.includes("retire"), false);
  assert.equal(owner.metadataSignals.length, 1);
  assert.equal(owner.metadataSignals[0]!.aborted, true);

  metadataGate.resolve();
  await assert.rejects(metadata, /closed during an active owner operation/u);
  await closing;

  assert.equal(owner.events.at(-1), "retire");
  assert.deepEqual(owner.retirementOutstanding, [0]);
});

test("close racing a business call aborts once, waits for its tail, and never sends an unsafe rollback", async () => {
  const businessGate = deferred<Readonly<Record<string, unknown>>>();
  let businessSignal: AbortSignal | undefined;
  const { owner, connection } = await openFixture({
    business(_leaseId, _invocation, signal) {
      businessSignal = signal;
      return businessGate.promise;
    },
  });
  const execution = connection.execute("Z_HANGING_SIDE_EFFECT", {});
  await until(
    () => owner.events.includes("invoke:1:Z_HANGING_SIDE_EFFECT"),
    "hanging modern invocation did not start",
  );
  const executionFailure = assert.rejects(
    execution,
    (error: unknown) => {
      assertNoInternalTransactionErrors(error);
      assert.equal(error instanceof Error, true);
      assert.match(
        (error as Error).message,
        /closing|closed|abort|transaction/iu,
      );
      return true;
    },
  );
  await assert.rejects(
    connection.execute("Z_CONCURRENT", {}),
    (error: unknown) => {
      assertNoInternalTransactionErrors(error);
      assert.equal(error instanceof Error, true);
      assert.match(
        (error as Error).message,
        /concurrent|active|calling|operation/iu,
      );
      return true;
    },
  );
  await assert.rejects(
    connection.ping(),
    /concurrent|active|calling|operation/iu,
  );

  let closeSettled = false;
  const closing = connection.close().finally(() => {
    closeSettled = true;
  });
  await until(
    () => businessSignal?.aborted === true,
    "close did not abort the active transaction call",
  );
  assert.equal(closeSettled, false);
  assert.equal(owner.events.includes("retire"), false);
  assert.equal(owner.events.some((event) => event.includes("BAPI_TRANSACTION_")), false);

  businessGate.reject(
    new Error("fixture call remained ambiguous after cancellation"),
  );
  await Promise.all([executionFailure, closing]);
  assert.equal(owner.events.includes("release:1:false"), true);
  assert.equal(owner.events.some((event) => event.includes("BAPI_TRANSACTION_")), false);
  assert.equal(owner.events.at(-1), "retire");
});

test("close racing a successful commit joins that terminal operation without adding rollback", async () => {
  const commitGate = deferred<Readonly<Record<string, unknown>>>();
  const { owner, connection } = await openFixture();
  owner.enqueueControl("BAPI_TRANSACTION_COMMIT", commitGate.promise);

  const committing = connection.commit();
  await until(
    () => owner.events.includes("invoke:1:BAPI_TRANSACTION_COMMIT"),
    "commit did not start",
  );
  const closing = connection.close();
  assert.equal(owner.events.includes("retire"), false);
  commitGate.resolve(bapiReturn("S"));
  await Promise.all([committing, closing]);

  assert.equal(
    owner.events.filter((event) => event === "invoke:1:BAPI_TRANSACTION_COMMIT").length,
    1,
  );
  assert.equal(owner.events.some((event) => event.includes("BAPI_TRANSACTION_ROLLBACK")), false);
  assert.equal(owner.events.includes("reset:1"), true);
  assert.equal(owner.events.includes("release:1:true"), true);
  assert.equal(owner.events.at(-1), "retire");
});

test("back-to-back terminal operation and close claim exactly one control call", async (t) => {
  for (const operation of ["commit", "rollback"] as const) {
    await t.test(operation, async () => {
      const { owner, connection } = await openFixture();
      const terminal = operation === "commit"
        ? connection.commit()
        : connection.rollback();
      const closing = connection.close();
      await Promise.all([terminal, closing]);

      const controls = owner.events.filter((event) =>
        event.includes("BAPI_TRANSACTION_")
      );
      assert.deepEqual(controls, [
        `invoke:1:BAPI_TRANSACTION_${operation.toUpperCase()}`,
      ]);
      assert.equal(owner.outstandingLeaseCount, 0);
      assert.deepEqual(owner.retirementOutstanding, [0]);
    });
  }
});

test("failed open retires its owner, propagates the failure, and redacts logger arguments", async () => {
  const failure = new Error("fixture-secret must never enter connector logs");
  const fixture = startFixture({ acquireFailure: failure });

  await assert.rejects(fixture.opening, (error: unknown) => error === failure);
  assert.equal(fixture.owner.events.includes("retire"), true);
  assert.equal(fixture.owner.events.some((event) => event.startsWith("invoke:")), false);
  assert.equal(fixture.logger.entries.some(([level]) => level === "error"), true);
  assert.equal(JSON.stringify(fixture.logger.entries).includes(["fixture", "secret"].join("-")), false);
});

test("combined open and retirement failures recursively project internal transaction errors", async () => {
  const internalFailure = new TransactionRuntimeError(
    "OPERATION_TIMEOUT",
    "fixture transaction acquire timed out",
  );
  const retirementFailure = new Error("fixture destination retirement failed");
  const fixture = startFixture({
    acquireFailure: internalFailure,
    retire() {
      throw retirementFailure;
    },
  });

  await assert.rejects(fixture.opening, (error: unknown) => {
    assertNoInternalTransactionErrors(error);
    assert.equal(error instanceof AggregateError, true);
    const projected = error as AggregateError;
    assert.equal(projected.errors.length, 2);
    assert.equal(projected.errors[0] instanceof RFCError, true);
    assert.equal(projected.errors[1], retirementFailure);
    assert.equal(projected.cause, projected.errors[0]);
    return true;
  });
});
