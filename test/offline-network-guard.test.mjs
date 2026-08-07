import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'

const localRequire = createRequire(import.meta.url)
const {
  OfflineNetworkGuardError,
  guardMarker,
  installOfflineNetworkGuard,
} = localRequire('../tools/offline_network_guard.cjs')

test('offline network guard blocks direct and prototype network surfaces and restores them', () => {
  const net = localRequire('node:net')
  const dns = localRequire('node:dns')
  const childProcess = localRequire('node:child_process')
  const original = {
    netConnect: net.connect,
    socketConnect: net.Socket.prototype.connect,
    dnsLookup: dns.lookup,
    dnsPromiseLookup: dns.promises.lookup,
    spawn: childProcess.spawn,
    fetch: globalThis.fetch,
    marker: Object.getOwnPropertyDescriptor(globalThis, guardMarker),
  }
  const guard = installOfflineNetworkGuard({
    label: 'test guard',
    blockSubprocesses: true,
  })
  try {
    for (const invoke of [
      () => net.connect(1, '127.0.0.1'),
      () => new net.Socket().connect(1, '127.0.0.1'),
      () => dns.lookup('example.invalid', () => {}),
      () => dns.promises.lookup('example.invalid'),
      () => childProcess.spawn(process.execPath, ['--version']),
      () => globalThis.fetch('https://example.invalid'),
    ]) {
      assert.throws(invoke, error => {
        assert(error instanceof OfflineNetworkGuardError)
        assert.equal(error.code, 'OPEN_RFC_OFFLINE_NETWORK_FORBIDDEN')
        return true
      })
    }
    assert.equal(guard.attempts, 6)
    assert.equal(globalThis[guardMarker], guard)
  } finally {
    guard.restore()
  }
  assert.equal(net.connect, original.netConnect)
  assert.equal(net.Socket.prototype.connect, original.socketConnect)
  assert.equal(dns.lookup, original.dnsLookup)
  assert.equal(dns.promises.lookup, original.dnsPromiseLookup)
  assert.equal(childProcess.spawn, original.spawn)
  assert.equal(globalThis.fetch, original.fetch)
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, guardMarker), original.marker)
})

test('offline network guard restore is idempotent', () => {
  const guard = installOfflineNetworkGuard({ label: 'idempotent guard' })
  guard.restore()
  assert.doesNotThrow(() => guard.restore())
})

test('offline network guard can admit only numeric loopback lookup for local package registries', async () => {
  const dns = localRequire('node:dns')
  const guard = installOfflineNetworkGuard({
    label: 'loopback registry guard',
    allowLoopback: true,
  })
  try {
    const result = await dns.promises.lookup('127.0.0.1')
    assert.equal(result.address, '127.0.0.1')
    assert.throws(
      () => dns.lookup('localhost', () => {}),
      OfflineNetworkGuardError,
    )
    assert.equal(guard.attempts, 1)
  } finally {
    guard.restore()
  }
})

test('preload mode proves installation and fails a child network attempt closed', () => {
  const guardPath = localRequire.resolve('../tools/offline_network_guard.cjs')
  const output = execFileSync(process.execPath, [
    `--require=${guardPath}`,
    '-e',
    [
      "const assert = require('node:assert/strict')",
      "const guard = globalThis[Symbol.for('open-rfc.offline-network-guard.v1')]",
      "assert(guard)",
      "assert.throws(() => require('node:net').connect(1, '127.0.0.1'), /network access is forbidden/u)",
      "assert.equal(guard.attempts, 1)",
      "process.stdout.write('guarded')",
    ].join(';'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPEN_RFC_OFFLINE_NETWORK_GUARD_AUTO: '1',
      OPEN_RFC_OFFLINE_NETWORK_GUARD_LABEL: 'preload test',
    },
  })
  assert.equal(output, 'guarded')
})
