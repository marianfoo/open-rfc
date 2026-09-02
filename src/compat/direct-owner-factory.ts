import { createHash } from "node:crypto";

import type { NormalizedDirectConnection } from "./connection-parameters.js";
import {
  DirectDestinationOwner,
  type DirectDestinationMetadataOptions,
  type DirectDestinationPoolOptions,
  type DirectDestinationSessionFactory,
  type DirectDestinationSessionOptions,
} from "../destination/direct-destination-owner.js";
import { MetadataRepositoryMode } from "../metadata/repository-runtime.js";

export interface DirectCompatibilityOwnerFactoryContext {
  readonly connection: NormalizedDirectConnection;
  readonly applicationPool: DirectDestinationPoolOptions;
  readonly repositoryPool?: DirectDestinationPoolOptions;
  readonly metadata?: DirectDestinationMetadataOptions;
  readonly sessionFactory?: DirectDestinationSessionFactory;
  readonly session?: DirectDestinationSessionOptions;
}

/** Internal composition seam captured by Client, Pool, and the modern façade. */
export interface DirectCompatibilityOwnerFactory {
  create(
    context: DirectCompatibilityOwnerFactoryContext,
  ): DirectDestinationOwner;
}

let nextGeneration = 1;

function fingerprint(domain: string, values: readonly unknown[]): string {
  return `sha256:${createHash("sha256")
    .update(`open-rfc:${domain}:v1\u0000`, "utf8")
    .update(JSON.stringify(values), "utf8")
    .digest("hex")}`;
}

/**
 * Build one non-sharing immutable destination generation. The safe identity
 * contains only domain-separated digests; clear credentials stay owner-private.
 */
export const productionDirectCompatibilityOwnerFactory:
DirectCompatibilityOwnerFactory = Object.freeze({
  create(context: DirectCompatibilityOwnerFactoryContext): DirectDestinationOwner {
    if (typeof context !== "object" || context === null) {
      throw new TypeError("direct owner factory context must be an object");
    }
    const connection = context.connection;
    const ordinal = nextGeneration++;
    const generationId = `direct-compatibility-${ordinal}`;
    const endpointId = fingerprint("endpoint", [
      connection.host,
      connection.port,
      connection.applicationServerHost,
      connection.applicationServerService,
    ]);
    const principalId = fingerprint("principal", [
      connection.client,
      connection.user,
      connection.ticket === undefined
        ? ["password", connection.password]
        : ["ticket", connection.ticket],
    ]);
    return new DirectDestinationOwner({
      connection,
      generationId,
      repositoryMode: MetadataRepositoryMode.Classic,
      ...(context.sessionFactory === undefined
        ? {}
        : { sessionFactory: context.sessionFactory }),
      identity: {
        destinationId: generationId,
        endpointId,
        // The system identity stays unverified until RFC_SYSTEM_INFO succeeds.
        // A generation never shares metadata with another owner before that.
        systemId: "unverified-direct",
        client: connection.client,
        release: "unverified",
        metadataGeneration: "classic-ddif-v1",
        language: connection.language,
        applicationPrincipalId: principalId,
        repositoryPrincipalId: principalId,
      },
      applicationPool: context.applicationPool,
      repositoryPool: context.repositoryPool,
      metadata: context.metadata,
      session: context.session,
    });
  },
});

export function bindDirectCompatibilityOwnerFactory(
  factory: DirectCompatibilityOwnerFactory,
): (context: DirectCompatibilityOwnerFactoryContext) => DirectDestinationOwner {
  if (
    (typeof factory !== "object" && typeof factory !== "function") ||
    factory === null ||
    typeof factory.create !== "function"
  ) {
    throw new TypeError("direct owner factory must provide create()");
  }
  const create = factory.create;
  return (context) => Reflect.apply(create, factory, [context]);
}
