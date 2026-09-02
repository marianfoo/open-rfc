import { createServer, type Server, type Socket } from "node:net";

import {
  APPC_RECORD_HEADER_LENGTH,
  AppcFunction,
  decodeAppcAsyncDataInfo,
  decodeAppcDataFragment,
  decodeAppcHeader,
  encodeAppcControlRecord,
} from "../../src/protocol/appc.js";
import { encodeIncomingAppcDataRecord } from "./appc-peer-record.js";
import {
  GatewayAcceptInfo,
  decodeGatewayNormalClient,
  encodeGatewayNormalClient,
} from "../../src/protocol/gateway.js";
import { NiFrameDecoder, encodeNiFrame } from "../../src/protocol/ni.js";
import {
  CpicTag,
  encodeCpicFieldChain,
  type CpicField,
} from "../../src/protocol/cpic.js";

export type ScriptedRfcDataReply =
  | {
      readonly kind: "fields";
      readonly fields: readonly CpicField[];
      /** Emit the reply as an initial F_RECEIVE terminal/streaming record. */
      readonly initialReceive?: boolean;
      /** Terminal CPI-C status carried with a still-decodable RFC envelope. */
      readonly appcReturnCode?: number;
      readonly sapReturnCode?: number;
      readonly isFinal?: boolean;
    }
  | {
      /** Exact CPIC response bytes inside the APPC data record. */
      readonly kind: "raw";
      readonly data: Uint8Array;
      readonly initialReceive?: boolean;
      readonly appcReturnCode?: number;
      readonly sapReturnCode?: number;
      readonly isFinal?: boolean;
    };

export type ScriptedRegularRfcReply =
  | ScriptedRfcDataReply
  | {
      /** Re-entrant server→client requests sent before the outer response. */
      readonly kind: "callbacks";
      readonly requests: readonly Uint8Array[];
      readonly final: ScriptedRfcDataReply;
      readonly inspectResponse?: (response: Buffer, index: number) => void;
    }
  | { readonly kind: "close" }
  | { readonly kind: "silence" };

export interface ScriptedRfcGeneration {
  /** Gateway indices may be reused after a physical generation closes. */
  readonly connectionIndex?: number;
  /** Override the normal little-endian Unicode gateway response. */
  readonly gatewayCodePage?: string;
  /** Override accepted gateway option flags for fail-closed negotiation tests. */
  readonly gatewayAcceptInfo?: number;
  readonly logonStatus?: number;
  /** Raw initial CPIC response override for malformed-envelope tests. */
  readonly logonResponse?: Uint8Array;
  /** Inspect the exact initial CPIC request carried by the APPC data record. */
  readonly inspectInitialLogon?: (request: Buffer) => void;
  readonly replies?: readonly ScriptedRegularRfcReply[];
}

interface GenerationState {
  readonly script: ScriptedRfcGeneration;
  readonly replies: ScriptedRegularRfcReply[];
  readonly conversationId: Buffer;
  readonly connectionIndex: number;
  phase: number;
  regularRequestCount: number;
  barrierCount: number;
  streamedApplicationBytes: number;
  streamedDataOrdinal: number | undefined;
  pendingCallbacks?: {
    readonly requests: readonly Uint8Array[];
    readonly final: ScriptedRfcDataReply;
    readonly inspectResponse?: (response: Buffer, index: number) => void;
    index: number;
  };
}

function initialLogonResponse(status: number): Buffer {
  return Buffer.concat([
    Buffer.from("010100080101010504010003", "hex"),
    encodeCpicFieldChain(CpicTag.Start, [
      { tag: CpicTag.ProtocolVersion, value: Buffer.from("00000e0b", "hex") },
      {
        tag: CpicTag.Capabilities,
        value: Buffer.from("0401000300030200000023", "hex"),
      },
      { tag: CpicTag.LogonStatus, value: Buffer.of(status) },
      { tag: CpicTag.End, value: Buffer.alloc(0) },
    ]),
    Buffer.from("ffff", "hex"),
  ]);
}

function regularResponse(fields: readonly CpicField[]): Buffer {
  return Buffer.concat([
    Buffer.from("05000000", "hex"),
    encodeCpicFieldChain(CpicTag.ResponseStart, fields),
    Buffer.from("ffff", "hex"),
  ]);
}

/** A semantic direct-CPIC peer for deterministic session/error tests. */
export class ScriptedRfcPeer {
  readonly #server: Server;
  readonly #scripts: readonly ScriptedRfcGeneration[];
  readonly #sockets = new Set<Socket>();
  readonly #states: GenerationState[] = [];
  #failure: unknown;
  #connectionCount = 0;
  readonly port: number;

  private constructor(
    server: Server,
    scripts: readonly ScriptedRfcGeneration[],
    port: number,
  ) {
    this.#server = server;
    this.#scripts = scripts;
    this.port = port;
  }

  static async start(
    scripts: readonly ScriptedRfcGeneration[],
  ): Promise<ScriptedRfcPeer> {
    if (scripts.length === 0) {
      throw new RangeError("scripted RFC peer needs at least one generation");
    }
    let peer: ScriptedRfcPeer | undefined;
    const server = createServer((socket) => {
      if (peer === undefined) socket.destroy();
      else peer.#accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("scripted RFC peer did not bind a TCP address");
    }
    peer = new ScriptedRfcPeer(server, scripts, address.port);
    return peer;
  }

  get connectionCount(): number {
    return this.#connectionCount;
  }

  regularRequestCount(generation: number): number {
    return this.#states[generation]?.regularRequestCount ?? 0;
  }

  barrierCount(generation: number): number {
    return this.#states[generation]?.barrierCount ?? 0;
  }

  streamedApplicationBytes(generation: number): number {
    return this.#states[generation]?.streamedApplicationBytes ?? 0;
  }

  #accept(socket: Socket): void {
    const index = this.#connectionCount;
    this.#connectionCount += 1;
    const script = this.#scripts[index];
    if (script === undefined) {
      this.#failure = new Error(`unexpected RFC connection generation ${index}`);
      socket.destroy();
      return;
    }
    const state: GenerationState = {
      script,
      replies: [...(script.replies ?? [])],
      conversationId: Buffer.from(`${index + 1}`.padStart(8, "0"), "ascii"),
      connectionIndex: script.connectionIndex ?? index + 1,
      phase: 0,
      regularRequestCount: 0,
      barrierCount: 0,
      streamedApplicationBytes: 0,
      streamedDataOrdinal: undefined,
    };
    this.#states[index] = state;
    this.#sockets.add(socket);
    const decoder = new NiFrameDecoder();
    socket.on("data", (chunk) => {
      try {
        for (const payload of decoder.push(chunk)) {
          this.#handle(socket, state, payload);
        }
      } catch (error) {
        this.#failure = error;
        socket.destroy();
      }
    });
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", (error) => {
      if (this.#failure === undefined) this.#failure = error;
    });
  }

  #write(socket: Socket, payload: Uint8Array): void {
    socket.write(encodeNiFrame(payload));
  }

  #reply(socket: Socket, state: GenerationState): void {
    state.regularRequestCount += 1;
    const reply = state.replies.shift();
    if (reply === undefined) {
      throw new Error("scripted RFC peer has no reply for the regular request");
    }
    if (reply.kind === "close") {
      socket.end();
      return;
    }
    if (reply.kind === "silence") return;
    if (reply.kind === "callbacks") {
      if (reply.requests.length === 0) {
        throw new Error("scripted callback reply needs at least one request");
      }
      state.pendingCallbacks = {
        requests: reply.requests.map((request) => Buffer.from(request)),
        final: reply.final,
        inspectResponse: reply.inspectResponse,
        index: 0,
      };
      this.#write(socket, encodeIncomingAppcDataRecord({
        conversationId: state.conversationId,
        communicationIndex: 0,
        connectionIndex: state.connectionIndex,
        data: reply.requests[0]!,
      }));
      return;
    }
    this.#sendDataReply(socket, state, reply);
  }

  #sendDataReply(
    socket: Socket,
    state: GenerationState,
    reply: ScriptedRfcDataReply,
  ): void {
    this.#write(socket, encodeIncomingAppcDataRecord({
      ...(reply.initialReceive ? { functionCode: AppcFunction.Receive } : {}),
      appcReturnCode: reply.appcReturnCode,
      sapReturnCode: reply.sapReturnCode,
      isFinal: reply.isFinal,
      conversationId: state.conversationId,
      communicationIndex: 0,
      connectionIndex: state.connectionIndex,
      data: reply.kind === "fields" ? regularResponse(reply.fields) : reply.data,
    }));
  }

  #handle(socket: Socket, state: GenerationState, payload: Buffer): void {
    if (state.phase === 0) {
      const request = decodeGatewayNormalClient(payload);
      this.#write(socket, encodeGatewayNormalClient({
        ...request,
        codePage: state.script.gatewayCodePage ?? "4103",
        gatewayOptionLevel: 15,
        acceptInfo: state.script.gatewayAcceptInfo ?? (
          request.acceptInfo |
          GatewayAcceptInfo.CodePage |
          GatewayAcceptInfo.NiPing
        ),
      }));
      state.phase = 1;
      return;
    }

    const header = decodeAppcHeader(payload);
    if (state.phase === 1) {
      if (header.functionCode !== AppcFunction.Initialize) {
        throw new Error("scripted RFC peer expected APPC Initialize");
      }
      this.#write(socket, encodeAppcControlRecord({
        functionCode: AppcFunction.Initialize,
        conversationId: state.conversationId,
        info2: 1,
        info3: 0xc0,
        info4: 6,
        info: 5,
        extendedInfo: {
          shortDestinationName: "NWRFC",
          logicalUnitName: "127.0.0.",
          transactionProgramName: "sapdp00",
          connectionType: 0x49,
          clientInfo: 1,
          communicationIndex: 0,
          connectionIndex: state.connectionIndex,
        },
      }));
      state.phase = 2;
      return;
    }
    if (state.phase === 2) {
      if (header.functionCode !== AppcFunction.SetPartnerLuName) {
        throw new Error("scripted RFC peer expected APPC SetPartnerLuName");
      }
      state.phase = 3;
      return;
    }
    if (state.phase === 3) {
      if (header.functionCode !== AppcFunction.Allocate) {
        throw new Error("scripted RFC peer expected APPC Allocate");
      }
      this.#write(socket, encodeAppcControlRecord({
        functionCode: AppcFunction.Allocate,
        conversationId: state.conversationId,
      }));
      state.phase = 4;
      return;
    }
    if (state.phase === 4) {
      if (header.functionCode !== AppcFunction.SapSend) {
        throw new Error("scripted RFC peer expected initial CPIC logon send");
      }
      state.script.inspectInitialLogon?.(decodeAppcDataFragment(payload).data);
      this.#write(socket, encodeIncomingAppcDataRecord({
        conversationId: state.conversationId,
        communicationIndex: 0,
        connectionIndex: state.connectionIndex,
        data: state.script.logonResponse === undefined
          ? initialLogonResponse(state.script.logonStatus ?? 0)
          : Buffer.from(state.script.logonResponse),
      }));
      state.phase = 5;
      return;
    }
    if (header.functionCode === AppcFunction.Deallocate) {
      socket.end();
      return;
    }
    if (state.pendingCallbacks !== undefined) {
      if (header.functionCode !== AppcFunction.SapSend) {
        throw new Error("scripted RFC peer expected a compact callback response");
      }
      const pending = state.pendingCallbacks;
      const fragment = decodeAppcDataFragment(payload);
      const response = fragment.data.subarray(
        0,
        fragment.data.byteLength - fragment.header.sapParameterLength,
      );
      pending.inspectResponse?.(response, pending.index);
      pending.index += 1;
      const next = pending.requests[pending.index];
      if (next !== undefined) {
        this.#write(socket, encodeIncomingAppcDataRecord({
          conversationId: state.conversationId,
          communicationIndex: 0,
          connectionIndex: state.connectionIndex,
          data: next,
        }));
      } else {
        state.pendingCallbacks = undefined;
        this.#sendDataReply(socket, state, pending.final);
      }
      return;
    }
    if (
      header.functionCode === AppcFunction.AsyncSendData ||
      header.functionCode === AppcFunction.SendData
    ) {
      const operation = decodeAppcAsyncDataInfo(
        payload.subarray(48, APPC_RECORD_HEADER_LENGTH),
      );
      if (
        operation.dataLength !== payload.byteLength - APPC_RECORD_HEADER_LENGTH ||
        operation.communicationIndex !== 0xffff ||
        operation.connectionIndex !== state.connectionIndex
      ) {
        throw new Error("scripted RFC peer received invalid streamed data info");
      }
      const dataOrdinal = state.streamedDataOrdinal ?? 0;
      const expectsBarrier = dataOrdinal > 0 && dataOrdinal % 21 === 0;
      if (
        expectsBarrier !==
        (header.functionCode === AppcFunction.SendData)
      ) {
        throw new Error("scripted RFC peer received a barrier at the wrong ordinal");
      }
      state.streamedDataOrdinal = dataOrdinal + 1;
      state.streamedApplicationBytes += operation.dataLength;
      if (header.functionCode === AppcFunction.SendData) {
        state.barrierCount += 1;
        this.#write(socket, encodeIncomingAppcDataRecord({
          functionCode: AppcFunction.SendData,
          conversationId: state.conversationId,
          sequenceNumber: 0,
          communicationIndex: 0,
          connectionIndex: state.connectionIndex,
          info4: 2,
          isFinal: false,
          data: Buffer.alloc(0),
        }, { bufferCapacity: 0 }));
      }
      return;
    }
    if (header.functionCode === AppcFunction.Receive) {
      if (state.streamedDataOrdinal === undefined) {
        throw new Error("scripted RFC peer received an orphaned stream terminator");
      }
      const operation = decodeAppcAsyncDataInfo(
        payload.subarray(48, APPC_RECORD_HEADER_LENGTH),
      );
      if (
        payload.byteLength !== APPC_RECORD_HEADER_LENGTH ||
        operation.dataLength !== 28_000 ||
        operation.communicationIndex !== 0xffff ||
        operation.connectionIndex !== state.connectionIndex
      ) {
        throw new Error("scripted RFC peer received an invalid stream terminator");
      }
      state.streamedDataOrdinal = undefined;
      this.#reply(socket, state);
      return;
    }
    if (header.functionCode !== AppcFunction.SapSend) {
      throw new Error("scripted RFC peer expected a regular CPIC send");
    }
    this.#reply(socket, state);
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    if (this.#failure !== undefined) throw this.#failure;
  }
}

export function successfulRegularFields(): readonly CpicField[] {
  return [
    { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
    { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
    { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
    { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
    { tag: CpicTag.End, value: Buffer.alloc(0) },
  ];
}
