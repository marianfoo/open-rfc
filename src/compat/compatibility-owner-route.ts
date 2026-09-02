import type {
  DirectDestinationSessionFactory,
  DirectDestinationSessionOptions,
} from
  "../destination/direct-destination-owner.js";
import { createProductionDirectDestinationSessionFactory } from
  "../destination/direct-destination-owner.js";
import { createSapRouterDirectCpicTransportFactory } from
  "../transport/saprouter-ni.js";
import { createConnectivitySocks5DirectCpicTransportFactory } from
  "../transport/connectivity-socks5-ni.js";
import {
  normalizeDirectConnectionParameters,
  type NormalizedDirectConnection,
  type RfcConnectionParameters,
} from "./connection-parameters.js";
import {
  normalizedDirectConnectionFromPlan,
  planConnectionRoute,
} from "./connection-route.js";
import {
  createMessageServerDirectSessionFactory,
  messageServerOwnerConnection,
} from "./message-server-direct-session-factory.js";

export interface CompatibilityOwnerRoute {
  readonly connection: NormalizedDirectConnection;
  readonly sessionFactory?: DirectDestinationSessionFactory;
  readonly kind: "direct" | "message-server";
}

/**
 * Compose an archived Client/Pool owner without starting I/O. Message-server
 * discovery remains inside the returned physical session factory so every
 * pool creation receives a fresh lookup and the pool lifecycle signal.
 */
export function planCompatibilityOwnerRoute(
  parameters: RfcConnectionParameters,
  session?: DirectDestinationSessionOptions,
): CompatibilityOwnerRoute {
  const plan = planConnectionRoute(parameters);
  if (plan.route.kind === "direct") {
    if (plan.connectivityProxy !== undefined) {
      throw new Error(
        "Connectivity routes are not implemented by the archived Client/Pool facade",
      );
    }
    if (plan.connectivitySocks5 !== undefined) {
      const transportFactory =
        createConnectivitySocks5DirectCpicTransportFactory({
          proxyHost: plan.connectivitySocks5.host,
          proxyPort: plan.connectivitySocks5.port,
          accessToken: plan.connectivitySocks5.accessToken,
          ...(plan.connectivitySocks5.locationId === undefined
            ? {}
            : { locationId: plan.connectivitySocks5.locationId }),
        });
      return Object.freeze({
        kind: "direct" as const,
        connection: normalizedDirectConnectionFromPlan(plan),
        sessionFactory: createProductionDirectDestinationSessionFactory({
          ...session,
          transportFactory,
        }),
      });
    }
    if (plan.sapRouter !== undefined) {
      const transportFactory = createSapRouterDirectCpicTransportFactory(
        plan.sapRouter.routeString,
      );
      return Object.freeze({
        kind: "direct" as const,
        connection: normalizedDirectConnectionFromPlan(plan),
        sessionFactory: createProductionDirectDestinationSessionFactory({
          ...session,
          transportFactory,
        }),
      });
    }
    return Object.freeze({
      kind: "direct" as const,
      connection: normalizeDirectConnectionParameters(parameters),
    });
  }
  if (plan.route.kind !== "message-server") {
    throw new Error(
      "wshost connections are not implemented by the archived Client/Pool facade",
    );
  }
  if (
    plan.sapRouter !== undefined ||
    plan.connectivityProxy !== undefined ||
    plan.connectivitySocks5 !== undefined
  ) {
    throw new Error(
      "message-server SAProuter and Connectivity routes are not implemented by the archived Client/Pool facade",
    );
  }
  return Object.freeze({
    kind: "message-server" as const,
    connection: messageServerOwnerConnection(plan),
    sessionFactory: createMessageServerDirectSessionFactory({
      plan,
      ...(session === undefined ? {} : { directSession: session }),
    }),
  });
}
