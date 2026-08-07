import { AsyncLocalStorage } from "node:async_hooks";

import type { DirectCpicSession } from "../client/direct-cpic-session.js";
import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import {
  MetadataRepositoryMode,
  createMetadataStructuralKey,
  type MetadataLookup,
  type MetadataRepositoryMonitor,
  type MetadataRepositoryRuntime,
  type MetadataStructuralKey,
} from "../metadata/repository-runtime.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import {
  DestinationConfigurationGeneration,
  type DestinationConfiguration,
  type DestinationGenerationMonitor,
} from "./configuration-generation.js";

export interface DestinationFunctionDescriptor {
  readonly kind: "function";
  readonly value: RfcFunctionInterface;
}

export interface DestinationStructureDescriptor {
  readonly kind: "structure";
  readonly value: RfcStructureDefinition;
}

export interface DestinationRecursiveFunctionDescriptor {
  readonly kind: "recursive-function";
  readonly value: RecursiveMetadataGraph;
}

/** The repository value keeps unlike descriptor shapes explicitly tagged. */
export type DestinationMetadataDescriptor =
  | DestinationFunctionDescriptor
  | DestinationStructureDescriptor
  | DestinationRecursiveFunctionDescriptor;

export interface RfcDestinationRuntimeOptions<
  A extends DirectCpicSession,
  R,
> {
  readonly generation: DestinationConfigurationGeneration<A, R>;
  readonly repository: MetadataRepositoryRuntime<DestinationMetadataDescriptor>;
}

export interface RfcDestinationRuntimeMonitor {
  readonly generation: DestinationGenerationMonitor;
  readonly repository: MetadataRepositoryMonitor;
}

/** Generic-erased façade contract implemented by every destination owner. */
export interface RfcClientDestinationRuntime {
  readonly configuration: DestinationConfiguration;
  openApplication(): Promise<DirectCpicSession>;
  getFunctionInterface(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface>;
  getStructureDefinition(
    structureName: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition>;
  getRecursiveFunctionMetadata(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RecursiveMetadataGraph>;
  retire(): Promise<void>;
  monitor(): RfcDestinationRuntimeMonitor;
}

interface BoundDestinationGeneration<A extends DirectCpicSession> {
  readonly openApplication: () => Promise<A>;
  readonly retire: () => Promise<void>;
  readonly monitor: () => DestinationGenerationMonitor;
}

interface BoundDestinationRepository {
  readonly get: (
    lookup: MetadataLookup,
    signal?: AbortSignal,
  ) => Promise<DestinationMetadataDescriptor>;
  readonly invalidate: (structural: MetadataStructuralKey) => boolean;
  readonly retire: () => Promise<void>;
  readonly monitor: () => MetadataRepositoryMonitor;
}

interface DestinationRetirementContext {
  readonly owners: ReadonlySet<object>;
  readonly owner: object;
  readonly retirement: Promise<void>;
}

const destinationRetirementContext =
  new AsyncLocalStorage<DestinationRetirementContext>();
const destinationRetirementDependencies = new WeakMap<object, Set<object>>();
const safeApply = Reflect.apply;

function callable(value: unknown, path: string): Function {
  if (typeof value !== "function") {
    throw new TypeError(`${path} must be a function`);
  }
  return value;
}

function bindGeneration<A extends DirectCpicSession, R>(
  generation: DestinationConfigurationGeneration<A, R>,
): {
  readonly configuration: DestinationConfiguration;
  readonly operations: BoundDestinationGeneration<A>;
} {
  const configuration = generation.configuration;
  const openApplicationOperation = callable(
    generation.openApplication,
    "destination generation openApplication",
  );
  const retireOperation = callable(
    generation.retire,
    "destination generation retire",
  );
  const monitorOperation = callable(
    generation.monitor,
    "destination generation monitor",
  );
  return Object.freeze({
    configuration,
    operations: Object.freeze({
      openApplication: (): Promise<A> =>
        safeApply(openApplicationOperation, generation, []),
      retire: (): Promise<void> =>
        safeApply(retireOperation, generation, []),
      monitor: (): DestinationGenerationMonitor =>
        safeApply(monitorOperation, generation, []),
    }),
  });
}

function bindRepository(
  repository: MetadataRepositoryRuntime<DestinationMetadataDescriptor>,
): BoundDestinationRepository {
  if (typeof repository !== "object" || repository === null) {
    throw new TypeError(
      "destination runtime repository must provide get(), invalidate(), retire(), and monitor()",
    );
  }
  const getOperation = repository.get;
  const invalidateOperation = repository.invalidate;
  const retireOperation = repository.retire;
  const monitorOperation = repository.monitor;
  if (
    typeof getOperation !== "function" ||
    typeof invalidateOperation !== "function" ||
    typeof retireOperation !== "function" ||
    typeof monitorOperation !== "function"
  ) {
    throw new TypeError(
      "destination runtime repository must provide get(), invalidate(), retire(), and monitor()",
    );
  }
  return Object.freeze({
    get: (
      lookup: MetadataLookup,
      signal?: AbortSignal,
    ): Promise<DestinationMetadataDescriptor> =>
      safeApply(getOperation, repository, [lookup, signal]),
    invalidate: (structural: MetadataStructuralKey): boolean =>
      safeApply(invalidateOperation, repository, [structural]),
    retire: (): Promise<void> =>
      safeApply(retireOperation, repository, []),
    monitor: (): MetadataRepositoryMonitor =>
      safeApply(monitorOperation, repository, []),
  });
}

function destinationRetirementJoinWouldCycle(
  owner: object,
  target: object,
): boolean {
  const pending = [target];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === owner) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const dependencies = destinationRetirementDependencies.get(current);
    if (dependencies !== undefined) pending.push(...dependencies);
  }
  return false;
}

function trackDestinationRetirementJoin(
  context: DestinationRetirementContext,
  target: object,
  targetRetirement: Promise<void>,
): boolean {
  if (destinationRetirementJoinWouldCycle(context.owner, target)) return false;

  let dependencies = destinationRetirementDependencies.get(context.owner);
  if (dependencies === undefined) {
    dependencies = new Set<object>();
    destinationRetirementDependencies.set(context.owner, dependencies);
  }
  dependencies.add(target);
  const remove = (): void => {
    const current = destinationRetirementDependencies.get(context.owner);
    current?.delete(target);
    if (current?.size === 0) {
      destinationRetirementDependencies.delete(context.owner);
    }
  };
  void targetRetirement.then(remove, remove);
  void context.retirement.then(remove, remove);
  return true;
}

function descriptorMatches(
  descriptor: DestinationMetadataDescriptor,
  objectKind: DestinationMetadataDescriptor["kind"],
  objectName: string,
): boolean {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    descriptor.kind !== objectKind
  ) {
    return false;
  }
  const value: unknown = descriptor.value;
  if (objectKind === "recursive-function") {
    const identity = typeof value === "object" && value !== null
      ? (value as { readonly functionIdentity?: unknown }).functionIdentity
      : undefined;
    return (
      typeof identity === "object" &&
      identity !== null &&
      "name" in identity &&
      identity.name === objectName
    );
  }
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === objectName
  );
}

/**
 * Destination-owned production seam shared by compatibility façades.
 *
 * The injected repository adapter is responsible for obtaining backend access
 * through this generation's repository lane. Application sessions are opened
 * only through the application lane, so a context-pinned/LUW connection is
 * never lent to metadata work by this owner.
 */
export class RfcDestinationRuntime<
  A extends DirectCpicSession = DirectCpicSession,
  R = unknown,
> implements RfcClientDestinationRuntime {
  readonly #configuration: DestinationConfiguration;
  readonly #generation: BoundDestinationGeneration<A>;
  readonly #repository: BoundDestinationRepository;
  #state: "active" | "retiring" | "retired" = "active";
  #retirement: Promise<void> | undefined;
  readonly #reentrantRetirementAcknowledgement = Promise.resolve();

  constructor(options: RfcDestinationRuntimeOptions<A, R>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("destination runtime options must be an object");
    }
    const generation = options.generation;
    if (!(generation instanceof DestinationConfigurationGeneration)) {
      throw new TypeError(
        "destination runtime generation must be a DestinationConfigurationGeneration",
      );
    }
    const repository = options.repository;
    // The runtime uses behavior rather than an instanceof test for the generic
    // repository so an independently bundled copy remains injectable.
    const boundGeneration = bindGeneration(generation);
    this.#configuration = boundGeneration.configuration;
    this.#generation = boundGeneration.operations;
    this.#repository = bindRepository(repository);
  }

  get configuration(): DestinationConfiguration {
    return this.#configuration;
  }

  openApplication(): Promise<A> {
    if (this.#state !== "active") {
      return Promise.reject(this.#retiredError());
    }
    return this.#generation.openApplication();
  }

  async getFunctionInterface(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface> {
    const descriptor = await this.#get("function", functionName, signal);
    if (descriptor.kind !== "function") {
      throw new Error(
        `metadata repository returned ${descriptor.kind} for function ${functionName}`,
      );
    }
    return descriptor.value;
  }

  async getStructureDefinition(
    structureName: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition> {
    const descriptor = await this.#get("structure", structureName, signal);
    if (descriptor.kind !== "structure") {
      throw new Error(
        `metadata repository returned ${descriptor.kind} for structure ${structureName}`,
      );
    }
    return descriptor.value;
  }

  async getRecursiveFunctionMetadata(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RecursiveMetadataGraph> {
    const descriptor = await this.#get(
      "recursive-function",
      functionName,
      signal,
      MetadataRepositoryMode.OptimizedOnly,
    );
    if (descriptor.kind !== "recursive-function") {
      throw new Error(
        `metadata repository returned ${descriptor.kind} for recursive function ${functionName}`,
      );
    }
    return descriptor.value;
  }

  retire(): Promise<void> {
    const inheritedContext = destinationRetirementContext.getStore();
    if (inheritedContext?.owners.has(this) === true) {
      return this.#reentrantRetirementAcknowledgement;
    }
    if (this.#retirement !== undefined) {
      return this.#joinRetirement(inheritedContext, this.#retirement);
    }
    this.#state = "retiring";
    const owners = new Set(inheritedContext?.owners);
    owners.add(this);
    let retirement!: Promise<void>;
    retirement = Promise.resolve().then(() => {
      const context: DestinationRetirementContext = Object.freeze({
        owners,
        owner: this,
        retirement,
      });
      return destinationRetirementContext.run(context, async () => {
        try {
          const results = await Promise.allSettled([
            this.#repository.retire(),
            this.#generation.retire(),
          ]);
          const failures = results
            .filter(
              (result): result is PromiseRejectedResult =>
                result.status === "rejected",
            )
            .map((result) => result.reason);
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              `destination runtime ${this.configuration.generationId} retirement failed`,
            );
          }
        } finally {
          this.#state = "retired";
        }
      });
    });
    // The retirement body starts in a later microtask, so owning generation
    // hooks can never run before external callers can observe this operation.
    this.#retirement = retirement;
    return this.#joinRetirement(inheritedContext, retirement);
  }

  #joinRetirement(
    context: DestinationRetirementContext | undefined,
    retirement: Promise<void>,
  ): Promise<void> {
    if (context === undefined) return retirement;
    return trackDestinationRetirementJoin(context, this, retirement)
      ? retirement
      : this.#reentrantRetirementAcknowledgement;
  }

  monitor(): RfcDestinationRuntimeMonitor {
    return Object.freeze({
      generation: this.#generation.monitor(),
      repository: this.#repository.monitor(),
    });
  }

  async #get(
    objectKind: DestinationMetadataDescriptor["kind"],
    objectName: string,
    signal?: AbortSignal,
    mode: MetadataRepositoryMode = this.configuration.repositoryMode,
  ): Promise<DestinationMetadataDescriptor> {
    if (this.#state !== "active") throw this.#retiredError();
    const configuration = this.configuration;
    const identity = configuration.identity;
    const structural = createMetadataStructuralKey({
      backendKey: identity.structuralBackendKey,
      metadataGeneration: identity.metadataGeneration,
      language: identity.language,
      objectKind,
      objectName,
    });
    const descriptor = await this.#repository.get(
      Object.freeze({
        structural,
        capability: identity.repositoryCapability,
        mode,
      }),
      signal,
    );
    if (!descriptorMatches(descriptor, objectKind, objectName)) {
      // A malformed adapter result must not become a permanent cache poison.
      this.#repository.invalidate(structural);
      throw new Error(
        `metadata repository returned a mismatched descriptor for ${objectKind} ${objectName}`,
      );
    }
    return descriptor;
  }

  #retiredError(): Error {
    return new Error(
      `destination runtime ${this.configuration.generationId} is retired`,
    );
  }
}
