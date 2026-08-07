import type { RfcFunctionInterface } from "../metadata/rfc-function-interface.js";
import type { RfcStructureDefinition } from "../metadata/rfc-structure-definition.js";
import type { RecursiveMetadataGraph } from "../metadata/recursive-metadata.js";
import {
  type ConnectionProviderCapability,
  type ConnectionRoutePlan,
} from "./connection-route.js";

export interface RfcSessionCallOptions {
  readonly notRequested?: readonly string[];
}

/** One provider-owned LUW. No transport- or pool-specific token crosses this seam. */
export interface RfcSessionTransaction {
  /** Idempotently resolves after the provider has pinned the LUW resource. */
  ready(): Promise<void>;
  call(
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
    options: RfcSessionCallOptions,
  ): Promise<Readonly<Record<string, unknown>>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Idempotent bounded teardown. It must also join/abort an unfinished ready().
   */
  close(): Promise<void>;
  /** True after an ambiguous, rejected, committed, rolled-back, or closed LUW. */
  isTerminal(): boolean;
}

/**
 * Route-neutral authenticated session used by the modern connector facade.
 * Implementations own physical sessions, pools, metadata lanes, and teardown.
 */
export interface RfcSession {
  readonly connectionInfo: Readonly<Record<string, string>>;
  /** Creates a transaction handle synchronously so close() can abort opening. */
  beginTransaction(): RfcSessionTransaction;
  getFunctionInterface(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RfcFunctionInterface>;
  getStructureDefinition(
    structureName: string,
    signal?: AbortSignal,
  ): Promise<RfcStructureDefinition>;
  /** Optional for providers whose backend has no optimized DEEP metadata. */
  getRecursiveFunctionMetadata?(
    functionName: string,
    signal?: AbortSignal,
  ): Promise<RecursiveMetadataGraph>;
  /** Idempotently retires every transaction and physical provider resource. */
  close(): Promise<void>;
}

/** An internal route backend. Capability admission always precedes open(). */
export interface RfcSessionProvider {
  readonly capabilities: readonly ConnectionProviderCapability[];
  /**
   * Open a route-neutral session. The optional signal is an additive open-rfc
   * extension used by transports which perform discovery before a session is
   * created; providers must never treat cancellation as permission to replay
   * an RFC business call.
   */
  open(plan: ConnectionRoutePlan, signal?: AbortSignal): Promise<RfcSession>;
}
