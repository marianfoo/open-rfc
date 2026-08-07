import type { NormalizedDirectConnection } from "./connection-parameters.js";
import type { DirectDestinationOwner } from "../destination/direct-destination-owner.js";
import type { DirectDestinationSessionOptions } from "../destination/direct-destination-owner.js";

export interface RFCClientDestinationOwnerFactoryContext {
  /** Route-specific physical-session options retained inside the owner. */
  readonly session?: DirectDestinationSessionOptions;
}

/** Internal dependency boundary used to keep deterministic owner doubles out of the public API. */
export type RFCClientDestinationOwnerFactory = (
  connection: NormalizedDirectConnection,
  context?: RFCClientDestinationOwnerFactoryContext,
) => DirectDestinationOwner | PromiseLike<DirectDestinationOwner>;

const ownerFactories = new WeakMap<object, RFCClientDestinationOwnerFactory>();

export function bindRFCClientDestinationOwnerFactory(
  client: object,
  factory: RFCClientDestinationOwnerFactory,
): void {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("owner factory binding expects an object identity");
  }
  if (typeof factory !== "function") {
    throw new TypeError("destination owner factory must be a function");
  }
  const captured = factory;
  ownerFactories.set(
    client,
    (connection, context) =>
      Reflect.apply(captured, undefined, [connection, context]),
  );
}

export function resolveRFCClientDestinationOwnerFactory(
  client: object,
  fallback: RFCClientDestinationOwnerFactory,
): RFCClientDestinationOwnerFactory {
  return ownerFactories.get(client) ?? fallback;
}
