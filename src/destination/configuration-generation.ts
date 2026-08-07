import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import {
  MetadataRepositoryMode,
  createMetadataCapabilityKey,
  type MetadataCapabilityKey,
} from "../metadata/repository-runtime.js";

export interface DestinationLaneFactory<T> {
  open(): Promise<T>;
  /** Disposes a connection which finishes opening after generation retirement. */
  dispose(connection: T): void | Promise<void>;
  retire?(): void | Promise<void>;
}

export interface DestinationIdentityInput {
  readonly destinationId: string;
  readonly endpointId: string;
  readonly systemId: string;
  readonly client: string;
  readonly release: string;
  readonly metadataGeneration: string;
  readonly language: string;
  /** Opaque non-secret identity, such as a vault/principal fingerprint. */
  readonly applicationPrincipalId: string;
  /** Opaque non-secret identity for the independent repository lane. */
  readonly repositoryPrincipalId: string;
}

export interface DestinationSafeIdentity {
  readonly destinationId: string;
  readonly systemId: string;
  readonly client: string;
  readonly release: string;
  readonly metadataGeneration: string;
  readonly language: string;
  readonly structuralBackendKey: string;
  readonly applicationCapability: MetadataCapabilityKey;
  readonly repositoryCapability: MetadataCapabilityKey;
}

export interface DestinationConfiguration {
  readonly generationId: string;
  readonly repositoryMode: MetadataRepositoryMode;
  readonly identity: DestinationSafeIdentity;
}

export interface DestinationConfigurationGenerationOptions<A, R> {
  readonly generationId: string;
  readonly repositoryMode: MetadataRepositoryMode;
  readonly identity: DestinationIdentityInput;
  readonly applicationFactory: DestinationLaneFactory<A>;
  readonly repositoryFactory: DestinationLaneFactory<R>;
}

export interface DestinationLaneMonitor {
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly inFlight: number;
}

export interface DestinationGenerationMonitor {
  readonly generationId: string;
  readonly state: "active" | "retiring" | "retired";
  readonly application: DestinationLaneMonitor;
  readonly repository: DestinationLaneMonitor;
}

interface MutableLaneMonitor {
  attempts: number;
  succeeded: number;
  failed: number;
  inFlight: number;
}

interface BoundLaneFactory<T> {
  readonly open: () => Promise<T>;
  readonly dispose: (connection: T) => void | Promise<void>;
  readonly retire?: () => void | Promise<void>;
}

class DestinationLateOpenDisposalError extends Error {
  constructor(generationId: string, cause: unknown) {
    super(
      `destination generation ${generationId} could not dispose a late-opened connection`,
      { cause },
    );
    this.name = "DestinationLateOpenDisposalError";
  }
}

type CanonicalDestinationIdentity = DestinationIdentityInput;

/*
 * A retirement hook which delegates back to its owning generation must not
 * wait for the operation which is waiting for that hook. AsyncLocalStorage
 * keeps the complete nested owner chain across `await` without making
 * unrelated callers observe an early-completing retirement promise. A weak
 * wait-for graph additionally detects cycles formed by parallel hook branches.
 */
interface RetirementHookContext {
  readonly owners: ReadonlySet<object>;
  readonly owner: object;
  readonly retirement: Promise<void>;
}

const retirementHookContext = new AsyncLocalStorage<RetirementHookContext>();
const retirementDependencies = new WeakMap<object, Set<object>>();

function retirementJoinWouldCycle(owner: object, target: object): boolean {
  const pending = [target];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === owner) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const dependencies = retirementDependencies.get(current);
    if (dependencies !== undefined) pending.push(...dependencies);
  }
  return false;
}

function trackRetirementJoin(
  context: RetirementHookContext,
  target: object,
  targetRetirement: Promise<void>,
): boolean {
  if (retirementJoinWouldCycle(context.owner, target)) return false;

  let dependencies = retirementDependencies.get(context.owner);
  if (dependencies === undefined) {
    dependencies = new Set<object>();
    retirementDependencies.set(context.owner, dependencies);
  }
  dependencies.add(target);
  const remove = (): void => {
    const current = retirementDependencies.get(context.owner);
    current?.delete(target);
    if (current?.size === 0) retirementDependencies.delete(context.owner);
  };
  void targetRetirement.then(remove, remove);
  // A fire-and-forget hook call must not retain a dependency after its owner
  // has settled, even when the target remains active indefinitely.
  void context.retirement.then(remove, remove);
  return true;
}

function safeIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(
      `${field} must contain 1..512 characters without controls`,
    );
  }
  return value;
}

function snapshotIdentity(
  identity: DestinationIdentityInput,
): CanonicalDestinationIdentity {
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError("destination identity must be an object");
  }
  return Object.freeze({
    destinationId: safeIdentity(identity.destinationId, "destinationId"),
    endpointId: safeIdentity(identity.endpointId, "endpointId"),
    systemId: safeIdentity(identity.systemId, "systemId"),
    client: safeIdentity(identity.client, "client"),
    release: safeIdentity(identity.release, "release"),
    metadataGeneration: safeIdentity(
      identity.metadataGeneration,
      "metadataGeneration",
    ),
    language: safeIdentity(identity.language, "language"),
    applicationPrincipalId: safeIdentity(
      identity.applicationPrincipalId,
      "applicationPrincipalId",
    ),
    repositoryPrincipalId: safeIdentity(
      identity.repositoryPrincipalId,
      "repositoryPrincipalId",
    ),
  });
}

function backendKey(identity: CanonicalDestinationIdentity): string {
  const canonicalIdentity = JSON.stringify([
    identity.endpointId,
    identity.systemId,
    identity.client,
    identity.release,
    identity.metadataGeneration,
    identity.language,
  ]);
  return `sha256:${createHash("sha256")
    .update("open-rfc:metadata-backend:v1\u0000", "utf8")
    .update(canonicalIdentity, "utf8")
    .digest("hex")}`;
}

function bindFactory<T>(factory: DestinationLaneFactory<T>): BoundLaneFactory<T> {
  if (
    (typeof factory !== "object" && typeof factory !== "function") ||
    factory === null
  ) {
    throw new TypeError("destination lane factory must be an object");
  }
  const openOperation = factory.open;
  const disposeOperation = factory.dispose;
  const retireOperation = factory.retire;
  if (typeof openOperation !== "function") {
    throw new TypeError("destination lane factory must provide open()");
  }
  if (typeof disposeOperation !== "function") {
    throw new TypeError("destination lane factory must provide dispose()");
  }
  if (retireOperation !== undefined && typeof retireOperation !== "function") {
    throw new TypeError("destination lane factory retire must be a function");
  }
  const open = (): Promise<T> => Reflect.apply(openOperation, factory, []);
  const dispose = (connection: T): void | Promise<void> =>
    Reflect.apply(disposeOperation, factory, [connection]);
  const retire =
    typeof retireOperation === "function"
      ? (): void | Promise<void> => Reflect.apply(retireOperation, factory, [])
      : undefined;
  return Object.freeze({
    open,
    dispose,
    ...(retire === undefined ? {} : { retire }),
  });
}

function emptyLaneMonitor(): MutableLaneMonitor {
  return { attempts: 0, succeeded: 0, failed: 0, inFlight: 0 };
}

function monitorSnapshot(monitor: MutableLaneMonitor): DestinationLaneMonitor {
  return Object.freeze({ ...monitor });
}

/**
 * One immutable destination configuration generation. Credential ownership is
 * kept behind the two factories; only opaque, non-secret identities are stored
 * or exposed by this runtime.
 */
export class DestinationConfigurationGeneration<A, R> {
  readonly configuration: DestinationConfiguration;
  readonly #applicationFactory: BoundLaneFactory<A>;
  readonly #repositoryFactory: BoundLaneFactory<R>;
  readonly #applicationMonitor = emptyLaneMonitor();
  readonly #repositoryMonitor = emptyLaneMonitor();
  readonly #inFlightOpens = new Set<Promise<unknown>>();
  #state: "active" | "retiring" | "retired" = "active";
  #retirement: Promise<void> | undefined;
  readonly #reentrantRetirementAcknowledgement = Promise.resolve();

  constructor(options: DestinationConfigurationGenerationOptions<A, R>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("destination generation options must be an object");
    }
    // Snapshot nested caller-owned values as soon as their containing option is
    // read. A later accessor must not mutate an already-selected identity or
    // lane operation before it is captured.
    const generationId = safeIdentity(options.generationId, "generationId");
    const repositoryMode = options.repositoryMode;
    if (!Object.values(MetadataRepositoryMode).includes(repositoryMode)) {
      throw new RangeError(
        `unsupported metadata repository mode ${String(repositoryMode)}`,
      );
    }
    const canonicalIdentity = snapshotIdentity(options.identity);
    const applicationFactory = bindFactory(options.applicationFactory);
    const repositoryFactory = bindFactory(options.repositoryFactory);
    const structuralBackendKey = backendKey(canonicalIdentity);
    const identity: DestinationSafeIdentity = Object.freeze({
      destinationId: canonicalIdentity.destinationId,
      systemId: canonicalIdentity.systemId,
      client: canonicalIdentity.client,
      release: canonicalIdentity.release,
      metadataGeneration: canonicalIdentity.metadataGeneration,
      language: canonicalIdentity.language,
      structuralBackendKey,
      applicationCapability: createMetadataCapabilityKey({
        backendKey: structuralBackendKey,
        principalKey: canonicalIdentity.applicationPrincipalId,
      }),
      repositoryCapability: createMetadataCapabilityKey({
        backendKey: structuralBackendKey,
        principalKey: canonicalIdentity.repositoryPrincipalId,
      }),
    });
    this.configuration = Object.freeze({
      generationId,
      repositoryMode,
      identity,
    });
    Object.defineProperty(this, "configuration", {
      value: this.configuration,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    this.#applicationFactory = applicationFactory;
    this.#repositoryFactory = repositoryFactory;
  }

  openApplication(): Promise<A> {
    return this.#openLane(this.#applicationFactory, this.#applicationMonitor);
  }

  openRepository(): Promise<R> {
    return this.#openLane(this.#repositoryFactory, this.#repositoryMonitor);
  }

  retire(): Promise<void> {
    if (this.#state === "retired" && this.#retirement !== undefined) {
      return this.#retirement;
    }
    const inheritedHookContext = retirementHookContext.getStore();
    if (inheritedHookContext?.owners.has(this) === true) {
      return this.#reentrantRetirementAcknowledgement;
    }
    if (this.#retirement !== undefined) {
      return this.#joinRetirement(
        inheritedHookContext,
        this.#retirement,
      );
    }
    this.#state = "retiring";
    // Observe every operation admitted before the synchronous state transition
    // immediately. A completed late-disposal failure must remain retirement-owned
    // even when a slower factory hook outlives the opening promise.
    const admittedOpenDrain = Promise.allSettled([...this.#inFlightOpens]);
    const hooks = [
      this.#applicationFactory.retire,
      this.#repositoryFactory.retire,
    ].filter((hook): hook is () => void | Promise<void> => hook !== undefined);
    const hookOwners = new Set(inheritedHookContext?.owners);
    hookOwners.add(this);
    let retirement!: Promise<void>;
    retirement = Promise.resolve().then(async () => {
      const hookContext: RetirementHookContext = Object.freeze({
        owners: hookOwners,
        owner: this,
        retirement,
      });
      const results = await Promise.allSettled(
        hooks.map((hook) =>
          retirementHookContext.run(hookContext, async () => {
            await hook();
          })),
      );
      // Opens admitted before the synchronous state transition may finish
      // after factory retirement. Drain their success/failure and late-resource
      // disposal without turning the open caller's result into a hook failure.
      const drainResults = await admittedOpenDrain;
      this.#state = "retired";
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      failures.push(
        ...drainResults
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected" &&
              result.reason instanceof DestinationLateOpenDisposalError,
          )
          .map((result) => result.reason),
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `destination generation ${this.configuration.generationId} retirement failed`,
        );
      }
    });
    // Publish before the microtask above invokes any hook. External callers
    // observe the authoritative operation; hook-owned reentrant calls receive
    // the acknowledgement which breaks the otherwise unavoidable wait cycle.
    this.#retirement = retirement;
    return this.#joinRetirement(inheritedHookContext, retirement);
  }

  #joinRetirement(
    context: RetirementHookContext | undefined,
    retirement: Promise<void>,
  ): Promise<void> {
    if (context === undefined) return retirement;
    return trackRetirementJoin(context, this, retirement)
      ? retirement
      : this.#reentrantRetirementAcknowledgement;
  }

  monitor(): DestinationGenerationMonitor {
    return Object.freeze({
      generationId: this.configuration.generationId,
      state: this.#state,
      application: monitorSnapshot(this.#applicationMonitor),
      repository: monitorSnapshot(this.#repositoryMonitor),
    });
  }

  #openLane<T>(
    factory: BoundLaneFactory<T>,
    monitor: MutableLaneMonitor,
  ): Promise<T> {
    if (this.#state !== "active") {
      return Promise.reject(new Error(
        `destination generation ${this.configuration.generationId} is retired`,
      ));
    }
    monitor.attempts += 1;
    monitor.inFlight += 1;
    let opening!: Promise<T>;
    opening = Promise.resolve().then(async () => {
      try {
        const connection = await factory.open();
        if (this.#state !== "active") {
          try {
            await this.#disposeLateConnection(factory, connection);
          } catch (cause) {
            throw new DestinationLateOpenDisposalError(
              this.configuration.generationId,
              cause,
            );
          }
          throw new Error(
            `destination generation ${this.configuration.generationId} retired while opening`,
          );
        }
        monitor.succeeded += 1;
        return connection;
      } catch (error) {
        monitor.failed += 1;
        throw error;
      } finally {
        monitor.inFlight -= 1;
        this.#inFlightOpens.delete(opening);
      }
    });
    this.#inFlightOpens.add(opening);
    return opening;
  }

  async #disposeLateConnection<T>(
    factory: BoundLaneFactory<T>,
    connection: T,
  ): Promise<void> {
    const retirement = this.#retirement;
    if (retirement === undefined) {
      await factory.dispose(connection);
      return;
    }
    const inherited = retirementHookContext.getStore();
    const owners = new Set(inherited?.owners);
    owners.add(this);
    const context: RetirementHookContext = Object.freeze({
      owners,
      owner: this,
      retirement,
    });
    await retirementHookContext.run(context, async () => {
      await factory.dispose(connection);
    });
  }
}
