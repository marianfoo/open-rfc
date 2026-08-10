import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeMessageServerLoginRequest,
  encodeMessageServerLogoutRequest,
  encodeMessageServerRfcGroupRequest,
} from "../src/protocol/message-server.js";
import {
  MessageServerResolutionError,
  parseTcpServicePort,
  resolveMessageServerRfcGroup,
  type MessageServerTransport,
} from "../src/transport/message-server-resolver.js";
import {
  NiTransportError,
  type NiReceiveOptions,
} from "../src/transport/ni-socket.js";
import {
  defineNiPeerCases,
  niPeerStep,
  niWire,
  ScriptedNiPeer,
} from "./support/scripted-ni-network.js";

const GROUP = "RFC_GROUP";

const LOGIN_RESPONSE = Buffer.from(
  "2a2a4d4553534147452a2a0004002d20202020202020202020202020202020202020202020202020202020202020202020202020202000000001000000000000000002084d53475f5345525645522020202020202020202020202020202020202020202020202020202020200000",
  "hex",
);

const GROUP_RESPONSE = Buffer.from(
  "2a2a4d4553534147452a2a0004002d20202020202020202020202020202020202020202020202020202020202020202020202020202000000000000000000000000003014d53475f53455256455200000000000000000000000000000000000000000000000000000000000000002c000103000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d5246435f47524f555000000000000000000000000000000000000000000000000000000000000000010000000c8000106170702e6578616d706c652e7465737420",
  "hex",
);

class FakeTransport implements MessageServerTransport {
  readonly sent: Buffer[] = [];
  readonly #receives: Array<(options: NiReceiveOptions) => Promise<Buffer>>;
  closeCount = 0;

  constructor(
    receives: Array<(options: NiReceiveOptions) => Promise<Buffer>>,
  ) {
    this.#receives = receives;
  }

  async send(payload: Uint8Array): Promise<void> {
    this.sent.push(Buffer.from(payload));
  }

  async receive(options: NiReceiveOptions = {}): Promise<Buffer> {
    const next = this.#receives.shift();
    if (next === undefined) throw new Error("unexpected fake receive");
    return next(options);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("resolves through one fragmented scripted NI exchange and then closes", async (t) => {
  const cases = defineNiPeerCases({
    name: "message-server-success",
    timeoutMs: 1_000,
    steps: [
      niPeerStep.expectFrame(encodeMessageServerLoginRequest()),
      niPeerStep.split(niWire.frame(LOGIN_RESPONSE), [1, 2, 3, 108]),
      niPeerStep.expectFrame(encodeMessageServerRfcGroupRequest(GROUP)),
      niPeerStep.shortWrite(niWire.frame(GROUP_RESPONSE), 7),
      niPeerStep.expectFrame(encodeMessageServerLogoutRequest()),
      niPeerStep.eof(),
    ],
  });
  const peer = await ScriptedNiPeer.start(cases, "message-server-success");
  t.after(() => peer.close());

  const target = await resolveMessageServerRfcGroup({
    messageServerHost: peer.host,
    messageServerService: peer.port,
    systemId: "TST",
    group: GROUP,
    connectTimeoutMs: 1_000,
    operationTimeoutMs: 1_000,
  });

  await peer.done();
  assert.deepEqual(target, {
    applicationServerHost: "app.example.test",
    dispatcherPort: 3200,
    gatewayPort: 3300,
    gatewayService: "sapgw00",
    systemNumber: "00",
  });
  assert.deepEqual(peer.observedFrames, [
    encodeMessageServerLoginRequest(),
    encodeMessageServerRfcGroupRequest(GROUP),
    encodeMessageServerLogoutRequest(),
  ]);
});

test("treats EOF and an oversized NI declaration as terminal without replay", async (t) => {
  const cases = defineNiPeerCases(
    {
      name: "message-server-eof",
      timeoutMs: 1_000,
      steps: [
        niPeerStep.expectFrame(encodeMessageServerLoginRequest()),
        niPeerStep.eof(),
      ],
    },
    {
      name: "message-server-malformed-ni",
      timeoutMs: 1_000,
      steps: [
        niPeerStep.expectFrame(encodeMessageServerLoginRequest()),
        niPeerStep.write(niWire.malformedLength(513)),
      ],
    },
  );

  for (const [name, code] of [
    ["message-server-eof", "NI_CONNECTION_CLOSED"],
    ["message-server-malformed-ni", "NI_PROTOCOL_ERROR"],
  ] as const) {
    const peer = await ScriptedNiPeer.start(cases, name);
    t.after(() => peer.close());
    await assert.rejects(
      resolveMessageServerRfcGroup({
        messageServerHost: peer.host,
        messageServerService: peer.port,
        systemId: "TST",
        group: GROUP,
        operationTimeoutMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof NiTransportError && error.code === code,
    );
    await peer.done();
    assert.deepEqual(peer.observedFrames, [encodeMessageServerLoginRequest()]);
    await peer.close();
  }
});

test("propagates receive timeout once, closes once, and does not reconnect", async () => {
  const timeout = new NiTransportError(
    "NI_RECEIVE_TIMEOUT",
    "synthetic message-server timeout",
  );
  const transport = new FakeTransport([async () => Promise.reject(timeout)]);
  let factoryCalls = 0;

  await assert.rejects(
    resolveMessageServerRfcGroup({
      messageServerHost: "message.example.test",
      messageServerService: 3600,
      systemId: "TST",
      group: GROUP,
      transportFactory: async () => {
        factoryCalls += 1;
        return transport;
      },
    }),
    (error: unknown) => error === timeout,
  );

  assert.equal(factoryCalls, 1);
  assert.equal(transport.closeCount, 1);
  assert.deepEqual(transport.sent, [encodeMessageServerLoginRequest()]);
});

test("aborts a pending second receive, closes, and never sends or opens again", async () => {
  const controller = new AbortController();
  const transport = new FakeTransport([
    async () => LOGIN_RESPONSE,
    (options) => new Promise<Buffer>((_resolve, reject) => {
      const onAbort = (): void => reject(new NiTransportError(
        "NI_ABORTED",
        "synthetic abort",
        options.signal?.reason,
      ));
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  let factoryCalls = 0;
  const pending = resolveMessageServerRfcGroup({
    messageServerHost: "message.example.test",
    messageServerService: 3600,
    systemId: "TST",
    group: GROUP,
    signal: controller.signal,
    transportFactory: async () => {
      factoryCalls += 1;
      return transport;
    },
  });
  for (let attempt = 0; attempt < 20 && transport.sent.length < 2; attempt += 1) {
    await nextTurn();
  }
  assert.equal(transport.sent.length, 2);
  controller.abort("stop lookup");

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(factoryCalls, 1);
  assert.equal(transport.closeCount, 1);
});

test("validates every route field before service lookup or transport creation", async () => {
  const invalid = [
    { messageServerHost: "", systemId: "TST", group: GROUP },
    { messageServerHost: "message.example.test", systemId: "AB", group: GROUP },
    { messageServerHost: "message.example.test", systemId: "TST", group: "" },
    { messageServerHost: "message.example.test", systemId: "TST", group: "A".repeat(41) },
    { messageServerHost: "message.example.test", messageServerService: 0, systemId: "TST", group: GROUP },
    { messageServerHost: "message.example.test", messageServerService: "bad/name", systemId: "TST", group: GROUP },
    { messageServerHost: "message.example.test", systemId: "TST", group: GROUP, operationTimeoutMs: 0 },
  ] as const;
  let serviceCalls = 0;
  let factoryCalls = 0;
  for (const value of invalid) {
    await assert.rejects(resolveMessageServerRfcGroup({
      ...value,
      servicePortResolver: async () => {
        serviceCalls += 1;
        return 3600;
      },
      transportFactory: async () => {
        factoryCalls += 1;
        throw new Error("must not open");
      },
    }));
  }
  assert.equal(serviceCalls, 0);
  assert.equal(factoryCalls, 0);
});

test("uses r3name/sysid for the default service and accepts an explicit msserv", async () => {
  for (const [messageServerService, expected] of [
    [undefined, "sapmsTST"],
    ["custom-ms", "custom-ms"],
  ] as const) {
    const services: string[] = [];
    const transport = new FakeTransport([
      async () => LOGIN_RESPONSE,
      async () => GROUP_RESPONSE,
    ]);
    await resolveMessageServerRfcGroup({
      messageServerHost: "message.example.test",
      ...(messageServerService === undefined ? {} : { messageServerService }),
      systemId: "TST",
      group: GROUP,
      servicePortResolver: async (service) => {
        services.push(service);
        return 3600;
      },
      transportFactory: async (options) => {
        assert.equal(options.port, 3600);
        assert.equal(options.maxPayloadLength, 512);
        return transport;
      },
    });
    assert.deepEqual(services, [expected]);
  }
});

test("rejects a pre-aborted lookup before resolving a service or opening a socket", async () => {
  const controller = new AbortController();
  controller.abort("already canceled");
  let serviceCalls = 0;
  let factoryCalls = 0;
  await assert.rejects(
    resolveMessageServerRfcGroup({
      messageServerHost: "message.example.test",
      systemId: "TST",
      group: GROUP,
      signal: controller.signal,
      servicePortResolver: async () => {
        serviceCalls += 1;
        return 3600;
      },
      transportFactory: async () => {
        factoryCalls += 1;
        throw new Error("must not open");
      },
    }),
    (error: unknown) =>
      error instanceof NiTransportError && error.code === "NI_ABORTED",
  );
  assert.equal(serviceCalls, 0);
  assert.equal(factoryCalls, 0);
});

test("parses bounded /etc/services TCP records, aliases, and comments", () => {
  const services = [
    "# comment",
    "sapmsTST 3600/tcp message-tst # SAP message server",
    "udp-only 3601/udp sapmsUDP",
    "other 3602/tcp alias",
  ].join("\n");
  assert.equal(parseTcpServicePort(services, "sapmsTST"), 3600);
  assert.equal(parseTcpServicePort(services, "message-tst"), 3600);
  assert.equal(parseTcpServicePort(services, "sapmsUDP"), undefined);
  assert.equal(parseTcpServicePort(services, "missing"), undefined);
});

test("rejects conflicting and unbounded service-table data", () => {
  assert.throws(
    () => parseTcpServicePort(
      "sapmsTST 3600/tcp\nsapmsTST 3601/tcp",
      "sapmsTST",
    ),
    (error: unknown) =>
      error instanceof MessageServerResolutionError &&
      error.code === "MS_SERVICE_AMBIGUOUS",
  );
  assert.throws(
    () => parseTcpServicePort(`service 3600/tcp ${"A".repeat(4_100)}`, "service"),
    (error: unknown) =>
      error instanceof MessageServerResolutionError &&
      error.code === "MS_SERVICE_TABLE_INVALID",
  );
  assert.throws(
    () => parseTcpServicePort("service 3600/tcp\0hidden", "service"),
    (error: unknown) =>
      error instanceof MessageServerResolutionError &&
      error.code === "MS_SERVICE_TABLE_INVALID",
  );
});
