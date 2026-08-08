import assert from "node:assert/strict";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import test from "node:test";

import {
  CpicCallError,
  CpicLogonError,
  DirectCpicPreWireError,
  DirectCpicSession,
} from "../src/client/direct-cpic-session.js";
import {
  AppcFunction,
  decodeAppcDataFragment,
  decodeAppcHeader,
  decodeAppcInitializeParameters,
  decodeAppcPartnerLogicalUnitInfo,
  decodeAppcPartnerLogicalUnitParameters,
  encodeAppcControlRecord,
} from "../src/protocol/appc.js";
import {
  GatewayAcceptInfo,
  decodeGatewayNormalClient,
  encodeGatewayNormalClient,
} from "../src/protocol/gateway.js";
import { NiFrameDecoder, encodeNiFrame } from "../src/protocol/ni.js";
import {
  CpicTag,
  decodeCpicInitialLogonRequest,
  decodeCpicFieldChainPrefix,
  encodeCpicFieldChain,
} from "../src/protocol/cpic.js";
import { encodeIncomingAppcDataRecord } from "./support/appc-peer-record.js";
import { NiSocketTransport } from "../src/transport/ni-socket.js";

async function listen(
  handler: (socket: Socket) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

test("opens, exchanges, and deallocates a semantic direct-CPIC session", async (t) => {
  const functions: number[] = [];
  let finishPeer!: () => void;
  let failPeer!: (error: unknown) => void;
  const peerDone = new Promise<void>((resolve, reject) => {
    finishPeer = resolve;
    failPeer = reject;
  });
  const assignedConversation = Buffer.from("12345678");

  const { server, port } = await listen((socket) => {
    const decoder = new NiFrameDecoder();
    let phase = 0;
    socket.on("data", (chunk) => {
      try {
        for (const payload of decoder.push(chunk)) {
          if (phase === 0) {
            const request = decodeGatewayNormalClient(payload);
            assert.equal(request.returnCode, 0);
            assert.notEqual(
              request.acceptInfo & GatewayAcceptInfo.CodePage,
              0,
            );
            socket.write(
              encodeNiFrame(
                encodeGatewayNormalClient({
                  ...request,
                  codePage: "4103",
                  gatewayOptionLevel: 15,
                  acceptInfo:
                    request.acceptInfo |
                    GatewayAcceptInfo.CodePage |
                    GatewayAcceptInfo.NiPing,
                }),
              ),
            );
            phase += 1;
            continue;
          }

          const header = decodeAppcHeader(payload);
          functions.push(header.functionCode);
          if (phase === 1) {
            assert.equal(header.functionCode, AppcFunction.Initialize);
            assert.equal(header.conversationId.equals(Buffer.alloc(8, 0x20)), true);
            const parameters = decodeAppcInitializeParameters(payload.subarray(80));
            assert.equal(parameters.clientIdentifier, "NWRFC");
            assert.equal(parameters.options.optionFlags, 1);
            assert.equal(parameters.options.longLogicalUnitName, "127.0.0.1");
            socket.write(
              encodeNiFrame(
                encodeAppcControlRecord({
                  functionCode: AppcFunction.Initialize,
                  conversationId: assignedConversation,
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
                    connectionIndex: 6,
                  },
                }),
              ),
            );
          } else if (phase === 2) {
            assert.equal(header.functionCode, AppcFunction.SetPartnerLuName);
            assert.deepEqual(decodeAppcPartnerLogicalUnitInfo(payload.subarray(48, 80)), {
              logicalUnitNamePrefix: "127.0.0.",
              logicalUnitNameLength: 9,
              partnerHostAddress: Buffer.alloc(16),
              communicationIndex: 0xffff,
              connectionIndex: 6,
            });
            assert.equal(
              decodeAppcPartnerLogicalUnitParameters(payload.subarray(80))
                .longLogicalUnitName,
              "127.0.0.1",
            );
          } else if (phase === 3) {
            assert.equal(header.functionCode, AppcFunction.Allocate);
            socket.write(
              encodeNiFrame(
                encodeAppcControlRecord({
                  functionCode: AppcFunction.Allocate,
                  conversationId: assignedConversation,
                }),
              ),
            );
          } else if (phase === 4) {
            assert.equal(header.functionCode, AppcFunction.SapSend);
            const request = decodeAppcDataFragment(payload);
            const logon = decodeCpicInitialLogonRequest(request.data);
            assert.equal(logon.fields.some((field) => field.tag === CpicTag.Password), true);
            const logonFields = decodeCpicFieldChainPrefix(
              request.data.subarray(18),
              CpicTag.Start,
              CpicTag.End,
            ).fields;
            assert.equal(
              logonFields
                .find((field) => field.tag === CpicTag.Destination)!
                .value.toString("ascii"),
              "application.example.test",
            );
            const responsePrefix = Buffer.from(
              "010100080101010504010003",
              "hex",
            );
            const responseFields = encodeCpicFieldChain(CpicTag.Start, [
              {
                tag: CpicTag.ProtocolVersion,
                value: Buffer.from("00000e0b", "hex"),
              },
              {
                tag: CpicTag.Capabilities,
                value: Buffer.from("0401000300030200000023", "hex"),
              },
              { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
              { tag: CpicTag.End, value: Buffer.alloc(0) },
            ]);
            socket.write(
              encodeNiFrame(
                encodeIncomingAppcDataRecord({
                  conversationId: assignedConversation,
                  communicationIndex: 0,
                  connectionIndex: 6,
                  data: Buffer.concat([
                    responsePrefix,
                    responseFields,
                    Buffer.from("ffff", "hex"),
                  ]),
                }),
              ),
            );
          } else if (phase === 5) {
            assert.equal(header.functionCode, AppcFunction.SapSend);
            const request = decodeAppcDataFragment(payload);
            const requestFields = decodeCpicFieldChainPrefix(
              request.data.subarray(12),
              CpicTag.Start,
              CpicTag.End,
            ).fields;
            assert.equal(
              Buffer.from(
                requestFields.find((field) => field.tag === CpicTag.Function)!
                  .value,
              ).toString("utf16le"),
              "RFC_PING",
            );
            const responseFields = encodeCpicFieldChain(CpicTag.ResponseStart, [
              { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
              { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
              { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
              { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
              { tag: CpicTag.End, value: Buffer.alloc(0) },
            ]);
            socket.write(
              encodeNiFrame(
                encodeIncomingAppcDataRecord({
                  conversationId: assignedConversation,
                  communicationIndex: 0,
                  connectionIndex: 6,
                  data: Buffer.concat([
                    Buffer.from("05000000", "hex"),
                    responseFields,
                    Buffer.from("ffff", "hex"),
                  ]),
                }),
              ),
            );
          } else if (phase === 6) {
            assert.equal(header.functionCode, AppcFunction.SapSend);
            const request = decodeAppcDataFragment(payload);
            const requestFields = decodeCpicFieldChainPrefix(
              request.data.subarray(4),
              CpicTag.ContextEnd,
              CpicTag.End,
            ).fields;
            assert.equal(
              Buffer.from(
                requestFields.find((field) => field.tag === CpicTag.Function)!
                  .value,
              ).toString("utf16le"),
              "RFC_GET_FUNCTION_INTERFACE",
            );
            const responseFields = encodeCpicFieldChain(CpicTag.ResponseStart, [
              { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
              { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
              { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
              { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
              { tag: CpicTag.ParameterName, value: Buffer.from("REMOTE_BASXML_SUPPORTED", "utf16le") },
              { tag: CpicTag.ParameterValue, value: Buffer.from(" ", "utf16le") },
              { tag: CpicTag.ParameterName, value: Buffer.from("REMOTE_CALL", "utf16le") },
              { tag: CpicTag.ParameterValue, value: Buffer.from("R", "utf16le") },
              { tag: CpicTag.ParameterName, value: Buffer.from("UPDATE_TASK", "utf16le") },
              { tag: CpicTag.ParameterValue, value: Buffer.from(" ", "utf16le") },
              { tag: CpicTag.TableName, value: Buffer.from("PARAMS", "utf16le") },
              { tag: CpicTag.TableHeader, value: Buffer.from("0000019400000000", "hex") },
              { tag: CpicTag.TableName, value: Buffer.from("RESUMABLE_EXCEPTIONS", "utf16le") },
              { tag: CpicTag.TableHeader, value: Buffer.from("0000003e00000000", "hex") },
              { tag: CpicTag.End, value: Buffer.alloc(0) },
            ]);
            socket.write(
              encodeNiFrame(
                encodeIncomingAppcDataRecord({
                  conversationId: assignedConversation,
                  communicationIndex: 0,
                  connectionIndex: 6,
                  data: Buffer.concat([
                    Buffer.from("05000000", "hex"),
                    responseFields,
                    Buffer.from("ffff", "hex"),
                  ]),
                }),
              ),
            );
          } else if (phase === 7) {
            assert.equal(header.functionCode, AppcFunction.SapSend);
            const request = decodeAppcDataFragment(payload);
            const requestFields = decodeCpicFieldChainPrefix(
              request.data.subarray(4),
              CpicTag.ContextEnd,
              CpicTag.End,
            ).fields;
            assert.equal(
              Buffer.from(
                requestFields.find((field) => field.tag === CpicTag.Function)!
                  .value,
              ).toString("utf16le"),
              "SYSTEM_RESET_RFC_SERVER",
            );
            const responseFields = encodeCpicFieldChain(CpicTag.ResponseStart, [
              { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
              { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
              { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
              { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
              { tag: CpicTag.RfcServerResetDone, value: Buffer.alloc(0) },
              { tag: CpicTag.End, value: Buffer.alloc(0) },
            ]);
            socket.write(
              encodeNiFrame(
                encodeIncomingAppcDataRecord({
                  conversationId: assignedConversation,
                  communicationIndex: 0,
                  connectionIndex: 6,
                  data: Buffer.concat([
                    Buffer.from("05000000", "hex"),
                    responseFields,
                    Buffer.from("ffff", "hex"),
                  ]),
                }),
              ),
            );
          } else if (phase === 8) {
            assert.equal(header.functionCode, AppcFunction.SapSend);
            const request = decodeAppcDataFragment(payload);
            const requestFields = decodeCpicFieldChainPrefix(
              request.data.subarray(12),
              CpicTag.Start,
              CpicTag.End,
            ).fields;
            assert.equal(
              Buffer.from(
                requestFields.find((field) => field.tag === CpicTag.Function)!
                  .value,
              ).toString("utf16le"),
              "RFC_PING",
            );
            const responseFields = encodeCpicFieldChain(CpicTag.Start, [
              { tag: CpicTag.ProtocolVersion, value: Buffer.alloc(4) },
              { tag: CpicTag.Capabilities, value: Buffer.alloc(11) },
              { tag: CpicTag.LogonStatus, value: Buffer.of(0) },
              { tag: CpicTag.SystemCodePage, value: Buffer.alloc(8) },
              { tag: CpicTag.ResponseStart, value: Buffer.alloc(0) },
              { tag: CpicTag.ResponseContext, value: Buffer.alloc(0) },
              { tag: CpicTag.Session, value: Buffer.alloc(16, 1) },
              { tag: CpicTag.Unresolved0420, value: Buffer.alloc(4) },
              { tag: CpicTag.CallContext, value: Buffer.alloc(0) },
              { tag: CpicTag.End, value: Buffer.alloc(0) },
            ]);
            socket.write(
              encodeNiFrame(
                encodeIncomingAppcDataRecord({
                  conversationId: assignedConversation,
                  communicationIndex: 0,
                  connectionIndex: 6,
                  data: Buffer.concat([
                    Buffer.from("010100080101010504010003", "hex"),
                    responseFields,
                    Buffer.from("ffff", "hex"),
                  ]),
                }),
              ),
            );
          } else if (phase === 9) {
            assert.equal(header.functionCode, AppcFunction.Deallocate);
            decoder.finish();
            socket.end();
            finishPeer();
          }
          phase += 1;
        }
      } catch (error) {
        failPeer(error);
        socket.destroy();
      }
    });
  });
  t.after(() => closeServer(server));

  const transportEndpoints: Readonly<Record<string, unknown>>[] = [];
  const suppliedOpenOptions = {
    host: "127.0.0.1",
    port,
    applicationServerHost: "application.example.test",
    applicationServerService: "sapdp00",
    programName: "open-rfc-test",
    localAddress: "::ffff:127.0.0.1",
    operationTimeoutMs: 1_000,
    async transportFactory(
      options: Readonly<{
        host: string;
        port: number;
        family?: 4 | 6;
      }>,
      signal?: AbortSignal,
    ): Promise<NiSocketTransport> {
      transportEndpoints.push(Object.freeze({ ...options }));
      const socket = createConnection({
        host: options.host,
        port: options.port,
        family: options.family,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.pause();
      return NiSocketTransport.adopt({ socket }, signal);
    },
  };
  const openOptionReads = new Map<string, number>();
  const openOptions = new Proxy(suppliedOpenOptions, {
    get(target, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(target, key)) {
        openOptionReads.set(key, (openOptionReads.get(key) ?? 0) + 1);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const session = await DirectCpicSession.open(openOptions);
  assert.equal(session.state, "allocated");
  assert.deepEqual(
    {
      localAddress: session.info.localAddress,
      peerCodePage: session.info.peerCodePage,
      peerAcceptInfo: session.info.peerAcceptInfo,
      connectionIndex: session.info.connectionIndex,
    },
    {
      localAddress: "127.0.0.1",
      peerCodePage: "4103",
      peerAcceptInfo: 0xfb,
      connectionIndex: 6,
    },
  );
  assert.equal(Number.isSafeInteger(session.info.generationHandle), true);
  assert.equal(session.info.generationHandle > 0, true);
  await assert.rejects(session.ping(), /must be authenticated before ping/u);
  await assert.rejects(
    session.resetServerContext(),
    /must be authenticated before server-context reset/u,
  );
  await assert.rejects(
    session.getFunctionInterface("RFC_PING"),
    /must be authenticated before metadata lookup/u,
  );
  await assert.rejects(
    session.getOptimizedFunctionInterface("RFC_PING"),
    /must be authenticated before optimized metadata lookup/u,
  );
  await assert.rejects(
    session.getOptimizedRecursiveFunctionDescriptor("RFC_PING"),
    /must be authenticated before recursive metadata lookup/u,
  );
  await assert.rejects(
    session.getStructureDefinition("RFCSI"),
    /must be authenticated before structure metadata lookup/u,
  );
  await assert.rejects(
    session.getOptimizedStructureDefinition("RFCSI"),
    /must be authenticated before optimized structure metadata lookup/u,
  );
  await assert.rejects(
    session.getOptimizedMetadataTimestamps(["RFC_PING"], ["RFCSI"]),
    /must be authenticated before optimized metadata timestamp lookup/u,
  );
  await assert.rejects(
    session.getLegacyStructureDefinition("RFCSI"),
    /must be authenticated before metadata lookup/u,
  );
  assert.deepEqual(
    await session.logonAndPing({
      client: "001",
      user: "RFCUSR",
      password: ["not-a-real", "password"].join("-"),
    }),
    { negotiatedProtocolVersion: 0x0e0b, responseFieldCount: 4 },
  );
  assert.equal(session.state, "authenticated");
  await assert.rejects(
    session.logonAndPing({
      client: "001",
      user: "RFCUSR",
      password: ["not-a-real", "password"].join("-"),
    }),
    /already authenticated/u,
  );
  assert.deepEqual(await session.ping(), { responseFieldCount: 5 });
  assert.deepEqual(await session.getFunctionInterface("STFC_CONNECTION"), {
    name: "STFC_CONNECTION",
    remoteBasxmlSupported: false,
    remoteCall: "R",
    updateTask: false,
    parameters: [],
    exceptions: [],
    resumableExceptionRowCount: 0,
  });
  const reset = session.resetServerContext();
  await assert.rejects(
    session.ping(),
    /RFC_CONCURRENT_CALL/u,
  );
  await assert.rejects(
    session.close(),
    /cannot close a direct CPIC session during an exchange/u,
  );
  await reset;
  await session.close();
  await session.close();
  await peerDone;
  assert.deepEqual(
    Object.fromEntries(openOptionReads),
    Object.fromEntries(Object.keys(suppliedOpenOptions).map((key) => [key, 1])),
  );
  assert.deepEqual(transportEndpoints, [{
      host: "127.0.0.1",
      port,
      connectTimeoutMs: undefined,
      writeTimeoutMs: 1_000,
      family: 4,
  }]);
  assert.equal(session.state, "closed");
  await assert.rejects(
    session.exchange(Buffer.alloc(0)),
    /direct CPIC session is closed/u,
  );
  assert.deepEqual(functions, [
    AppcFunction.Initialize,
    AppcFunction.SetPartnerLuName,
    AppcFunction.Allocate,
    AppcFunction.SapSend,
    AppcFunction.SapSend,
    AppcFunction.SapSend,
    AppcFunction.SapSend,
    AppcFunction.SapSend,
    AppcFunction.Deallocate,
  ]);
});

test("rejects unsupported direct application-server service names", async () => {
  const wrapped = new Error("pre-wire");
  assert.equal(new DirectCpicPreWireError(wrapped).message, "pre-wire");
  assert.equal(
    new DirectCpicPreWireError("opaque").message,
    "classic RFC invocation preparation failed",
  );
  assert.equal(new CpicLogonError(7).status, 7);
  assert.equal(new CpicCallError(8).status, 8);

  await assert.rejects(
    DirectCpicSession.open(null as unknown as Parameters<typeof DirectCpicSession.open>[0]),
    /options must be an object/u,
  );
  for (const operationTimeoutMs of [Number.NaN, -1, 0x8000_0000]) {
    await assert.rejects(
      DirectCpicSession.open({
        host: "127.0.0.1",
        port: 1,
        applicationServerService: "sapdp00",
        operationTimeoutMs,
      }),
      /operationTimeoutMs must be an integer/u,
    );
  }
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapdp00",
      cpicStreaming: "automatic" as "enabled",
    }),
    /cpicStreaming must be disabled or enabled/,
  );
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapgw00",
    }),
    /applicationServerService.*sapdpNN/,
  );
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerHost: "bad\nhost",
      applicationServerService: "sapdp00",
    }),
    /applicationServerHost must contain 1\.\.64 ASCII bytes/,
  );
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapdp00",
      programName: "bad\nprogram",
    }),
    /programName must contain 1\.\.64 ASCII bytes/u,
  );
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapdp00",
      transportFactory: null as unknown as NonNullable<
        Parameters<typeof DirectCpicSession.open>[0]["transportFactory"]
      >,
    }),
    /transportFactory must be a function/u,
  );
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapdp00",
      recursiveSerializerDecisionProvider: null as never,
    }),
    /recursiveSerializerDecisionProvider must be a function/u,
  );
  let providerReads = 0;
  const volatileOptions = {
    host: "127.0.0.1",
    port: 1,
    applicationServerService: "sapgw00",
  } as Parameters<typeof DirectCpicSession.open>[0];
  Object.defineProperty(volatileOptions, "recursiveSerializerDecisionProvider", {
    enumerable: true,
    get() {
      providerReads += 1;
      return () => { throw new Error("not called"); };
    },
  });
  await assert.rejects(
    DirectCpicSession.open(volatileOptions),
    /applicationServerService.*sapdpNN/u,
  );
  assert.equal(providerReads, 1);
  await assert.rejects(
    DirectCpicSession.open({
      host: "127.0.0.1",
      port: 1,
      applicationServerService: "sapdp00",
      transportFactory: async () => ({}) as NiSocketTransport,
    }),
    /transportFactory must return a NiSocketTransport/u,
  );
});
