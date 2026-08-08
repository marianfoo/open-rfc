import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectCpicOutgoingWriteError,
  writeOutgoingAppcDataPlan,
  type DirectCpicOutgoingTransport,
} from "../src/client/direct-cpic-session.js";
import { RfcTransmissionState } from "../src/client/rfc-failure.js";
import {
  AppcClientSetupStateMachine,
  AppcFunction,
  encodeAppcControlRecord,
  planOutgoingAppcDataFragments,
  type AppcOutgoingDataFragment,
} from "../src/protocol/appc.js";

interface PendingWrite {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

class GatedTransport implements DirectCpicOutgoingTransport {
  readonly writes: PendingWrite[] = [];
  closeCount = 0;

  send(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writes.push({ resolve, reject });
    });
  }

  receive(): Promise<Uint8Array> {
    return Promise.reject(new Error("ambiguous-send fixture never receives"));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function readySetup(): AppcClientSetupStateMachine {
  const setup = new AppcClientSetupStateMachine();
  setup.sent(AppcFunction.Initialize);
  setup.received(encodeAppcControlRecord({ functionCode: AppcFunction.Initialize }));
  setup.sent(AppcFunction.SetPartnerLuName);
  setup.sent(AppcFunction.Allocate);
  setup.received(encodeAppcControlRecord({ functionCode: AppcFunction.Allocate }));
  return setup;
}

function threeFragmentPlan(): readonly AppcOutgoingDataFragment[] {
  return planOutgoingAppcDataFragments({
    conversationId: Buffer.from("CONV0001"),
    sequenceNumber: 17,
    communicationIndex: 0xffff,
    connectionIndex: 6,
    applicationData: Buffer.alloc(28_001, 0x5a),
  }, { cpicStreaming: "enabled" });
}

async function waitForWrite(transport: GatedTransport, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.writes.length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for outgoing write ${count}`);
}

async function assertTerminalNoReplay(
  label: string,
  failAt: number,
  expectedTransmission: RfcTransmissionState,
): Promise<void> {
  const transport = new GatedTransport();
  const original = new Error(`synthetic ${label} write failure`);
  const write = writeOutgoingAppcDataPlan(
    transport,
    readySetup(),
    threeFragmentPlan(),
  );

  for (let index = 0; index < failAt; index += 1) {
    await waitForWrite(transport, index + 1);
    transport.writes[index]!.resolve();
  }
  await waitForWrite(transport, failAt + 1);
  transport.writes[failAt]!.reject(original);

  await assert.rejects(write, (error: unknown) => {
    assert.equal(error instanceof DirectCpicOutgoingWriteError, true);
    const failure = error as DirectCpicOutgoingWriteError;
    assert.equal(failure.transmission, expectedTransmission);
    assert.equal(failure.cause, original);
    return true;
  });
  assert.equal(transport.closeCount, 1);
  assert.equal(transport.writes.length, failAt + 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.writes.length, failAt + 1);
}

test("first APPC write failure is terminal and never replayed", async () => {
  await assertTerminalNoReplay("first", 0, RfcTransmissionState.Unknown);
});

test("middle APPC write failure is terminal and never replayed", async () => {
  await assertTerminalNoReplay("middle", 1, RfcTransmissionState.Partial);
});

test("final APPC write failure is terminal and never replayed", async () => {
  await assertTerminalNoReplay("final", 2, RfcTransmissionState.Partial);
});
