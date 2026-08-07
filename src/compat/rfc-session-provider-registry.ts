import { bindRfcSessionProvider } from "./rfc-session-provider-binding.js";
import type { RfcSessionProvider } from "./rfc-session-provider.js";

/** Internal dependency registry; providers never become connector parameters. */
const providers = new WeakMap<object, RfcSessionProvider>();

export function bindRFCClientSessionProvider(
  client: object,
  provider: RfcSessionProvider,
): void {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("RFC session provider binding expects an object identity");
  }
  providers.set(client, bindRfcSessionProvider(provider));
}

export function resolveRFCClientSessionProvider(
  client: object,
): RfcSessionProvider {
  const provider = providers.get(client);
  if (provider === undefined) {
    throw new Error("RFC client has no bound session provider");
  }
  return provider;
}
