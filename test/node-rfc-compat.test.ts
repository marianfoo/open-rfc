import assert from "node:assert/strict";
import test from "node:test";

import { Client, Pool } from "../src/index.js";
import { bindClientDestinationOwnerFactory } from
  "../src/compat/node-rfc-client.js";
import { bindPoolDestinationOwnerFactory } from
  "../src/compat/node-rfc-pool.js";
import type { DirectCompatibilityOwnerFactoryContext } from
  "../src/compat/direct-owner-factory.js";
import type { DirectDestinationOwner } from
  "../src/destination/direct-destination-owner.js";

const configuration = {
  connectionParameters: {
    ashost: "127.0.0.1",
    sysnr: "00",
    client: "000",
    user: "unused",
    passwd: "unused",
  },
  poolOptions: { low: 0, high: 1 },
} as const;

const callbackHandler = () => ({ exports: [] });

function routedOwnerDouble(): DirectDestinationOwner {
  let idle = 0;
  const leases = new Set<object>();
  const createLease = (): object => {
    if (idle > 0) idle -= 1;
    const lease = Object.freeze({});
    leases.add(lease);
    return lease;
  };
  return {
    async acquireApplication() { return createLease(); },
    async acquireApplications(count: number) {
      return Object.freeze(Array.from({ length: count }, createLease));
    },
    async applicationInfo() {
      return Object.freeze({
        localAddress: "127.0.0.1",
        peerCodePage: "4103",
        peerAcceptInfo: 0,
        generationHandle: 1,
        connectionIndex: 1,
      });
    },
    async releaseApplication(lease: object, options: { reusable?: boolean }) {
      leases.delete(lease);
      if (options.reusable) idle += 1;
    },
    monitor() { return { applicationPool: { idle } }; },
    async retire() { leases.clear(); idle = 0; },
  } as unknown as DirectDestinationOwner;
}

test("archived Client composes message-server physical routing and direct precedence", async () => {
  const contexts: DirectCompatibilityOwnerFactoryContext[] = [];
  const restore = bindClientDestinationOwnerFactory({
    create(context) {
      contexts.push(context);
      return routedOwnerDouble();
    },
  });
  try {
    const message = new Client(
      {
        mshost: "message.example.test",
        msserv: "sapmsQAS",
        r3name: "QAS",
        sysid: "IGN",
        group: "PUBLIC",
        client: "001",
        user: "MESSAGE_USER",
        passwd: ["message", "password"].join("-"),
      },
      { callbacks: { Z_CALLBACK: callbackHandler } },
    );
    await message.open();
    assert.equal(contexts[0]?.connection.host, "message.example.test");
    assert.equal(typeof contexts[0]?.sessionFactory?.open, "function");
    assert.equal(contexts[0]?.session?.callbacks?.Z_CALLBACK, callbackHandler);
    assert.equal(Object.isFrozen(contexts[0]?.session?.callbacks), true);
    assert.equal(JSON.stringify(message.connectionInfo).includes(["message", "password"].join("-")), false);
    await message.close();

    const direct = new Client(
      {
        ashost: "direct.example.test",
        sysnr: "01",
        mshost: "ignored-message.example.test",
        r3name: "IGN",
        group: "PUBLIC",
        client: "001",
        user: "DIRECT_USER",
        passwd: ["direct", "password"].join("-"),
      },
      { callbacks: { Z_CALLBACK: callbackHandler } },
    );
    await direct.open();
    assert.equal(contexts[1]?.connection.host, "direct.example.test");
    assert.equal(contexts[1]?.sessionFactory, undefined);
    assert.equal(contexts[1]?.session?.callbacks?.Z_CALLBACK, callbackHandler);
    await direct.close();
  } finally {
    restore();
  }
});

test("archived Pool keeps group lookup at the per-physical session seam", async () => {
  let context: DirectCompatibilityOwnerFactoryContext | undefined;
  const restore = bindPoolDestinationOwnerFactory({
    create(captured) {
      context = captured;
      return routedOwnerDouble();
    },
  });
  const pool = new Pool({
    connectionParameters: {
      mshost: "message.example.test",
      sysid: "QAS",
      group: "PUBLIC",
      client: "001",
      user: "POOL_USER",
      passwd: ["pool", "password"].join("-"),
    },
    poolOptions: { low: 0, high: 2 },
    resourceOptions: { maxConnections: 2 },
    clientOptions: { callbacks: { Z_CALLBACK: callbackHandler } },
  });
  try {
    await pool.ready(2);
    assert.equal(context?.connection.host, "message.example.test");
    assert.equal(typeof context?.sessionFactory?.open, "function");
    assert.equal(context?.session?.callbacks?.Z_CALLBACK, callbackHandler);
    assert.deepEqual(pool.status, { ready: 2, leased: 0 });
  } finally {
    await pool.closeAll();
    restore();
  }
});

test("accepts the archived Pool callback-first ready overload", async () => {
  const pool = new Pool(configuration);
  await new Promise<void>((resolve, reject) => {
    pool.ready((error) => error === undefined ? resolve() : reject(error), 0);
  });
  assert.deepEqual(pool.status, { ready: 0, leased: 0 });
  await pool.closeAll();
});

test("ready growth holds existing idle leases until the requested floor exists", async () => {
  let idle = 0;
  let created = 0;
  const owner = {
    async acquireApplications(count: number) {
      const leases = [];
      for (let index = 0; index < count; index += 1) {
        if (idle > 0) idle -= 1;
        else created += 1;
        leases.push(Object.freeze({ index }));
      }
      return Object.freeze(leases);
    },
    async releaseApplication(_lease: object, options: { reusable: boolean }) {
      if (options.reusable) idle += 1;
    },
    monitor() {
      return { applicationPool: { idle } };
    },
    async retire() {},
  } as unknown as DirectDestinationOwner;
  const restore = bindPoolDestinationOwnerFactory({
    create: () => owner,
  });
  const pool = new Pool({
    ...configuration,
    poolOptions: { low: 2, high: 5 },
    resourceOptions: { maxConnections: 5 },
  });
  try {
    await pool.ready();
    assert.deepEqual(pool.status, { ready: 2, leased: 0 });
    await pool.ready(5);
    assert.deepEqual(pool.status, { ready: 5, leased: 0 });
    assert.equal(created, 5);
  } finally {
    await pool.closeAll();
    restore();
  }
});

test("validates callback-first Pool acquire arguments before networking", () => {
  const pool = new Pool(configuration);
  assert.throws(
    () => pool.acquire(() => undefined, 0),
    /acquire count must be at least one/,
  );
  assert.throws(
    () => pool.acquire(1, 1 as never),
    /second argument must be a function/,
  );
});

test("prevents application lifecycle calls on managed clients", async () => {
  const managed = new Client(configuration.connectionParameters, undefined, {
    poolId: 42,
    release: async () => undefined,
  });
  await assert.rejects(
    managed.open() as Promise<Client>,
    /managed clients cannot be opened directly/,
  );
  await assert.rejects(
    managed.close() as Promise<void>,
    /managed clients cannot be closed directly/,
  );
});
