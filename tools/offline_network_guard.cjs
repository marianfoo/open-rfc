'use strict'

const { createRequire } = require('node:module')

const guardMarker = Symbol.for('open-rfc.offline-network-guard.v1')

class OfflineNetworkGuardError extends Error {
  constructor(label, surface) {
    super(`${label}: network access is forbidden (${surface})`)
    this.name = 'OfflineNetworkGuardError'
    this.code = 'OPEN_RFC_OFFLINE_NETWORK_FORBIDDEN'
  }
}

function installOfflineNetworkGuard(options = {}) {
  const label = typeof options.label === 'string' && options.label.length > 0
    ? options.label
    : 'offline evidence'
  const blockSubprocesses = options.blockSubprocesses === true
  const allowLoopback = options.allowLoopback === true
  const restorers = []
  const guarded = []
  let attempts = 0
  let restored = false

  const deny = surface => {
    function deniedNetworkSurface() {
      attempts += 1
      throw new OfflineNetworkGuardError(label, surface)
    }
    return deniedNetworkSurface
  }
  const replace = (target, property, surface, replacement) => {
    if (target === undefined || target === null) return
    const descriptor = Object.getOwnPropertyDescriptor(target, property)
    if (descriptor === undefined || typeof descriptor.value !== 'function') return
    if (descriptor.configurable !== true && descriptor.writable !== true) return
    Object.defineProperty(target, property, {
      ...descriptor,
      value: replacement(descriptor.value),
    })
    guarded.push(surface)
    restorers.push(() => Object.defineProperty(target, property, descriptor))
  }
  const patch = (target, property, surface) => {
    replace(target, property, surface, () => deny(surface))
  }
  const patchLookup = (target, property, surface) => {
    replace(target, property, surface, original => {
      const denied = deny(surface)
      return function guardedLookup(host, ...arguments_) {
        if (
          allowLoopback &&
          (host === '127.0.0.1' || host === '::1')
        ) {
          return Reflect.apply(original, this, [host, ...arguments_])
        }
        return denied()
      }
    })
  }

  const localRequire = createRequire(__filename)
  const net = localRequire('node:net')
  const tls = localRequire('node:tls')
  const http = localRequire('node:http')
  const https = localRequire('node:https')
  const http2 = localRequire('node:http2')
  const dns = localRequire('node:dns')
  const dgram = localRequire('node:dgram')

  const state = {
    get attempts() { return attempts },
    get guarded() { return Object.freeze([...guarded].sort()) },
    restore() {
      if (restored) return
      restored = true
      for (const restore of restorers.splice(0).reverse()) restore()
    },
  }

  try {
    patch(net, 'connect', 'net.connect')
    patch(net, 'createConnection', 'net.createConnection')
    patch(net.Socket?.prototype, 'connect', 'net.Socket.connect')
    patch(tls, 'connect', 'tls.connect')
    patch(tls.TLSSocket?.prototype, 'connect', 'tls.TLSSocket.connect')
    patch(http, 'request', 'http.request')
    patch(http, 'get', 'http.get')
    patch(https, 'request', 'https.request')
    patch(https, 'get', 'https.get')
    patch(http2, 'connect', 'http2.connect')
    patchLookup(dns, 'lookup', 'dns.lookup')
    patchLookup(dns.promises, 'lookup', 'dns.promises.lookup')
    for (const property of [
      'lookupService', 'resolve', 'resolve4', 'resolve6',
      'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr',
      'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt',
      'reverse',
    ]) {
      patch(dns, property, `dns.${property}`)
      patch(dns.promises, property, `dns.promises.${property}`)
    }
    for (const property of [
      'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa',
      'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr',
      'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
    ]) patch(dns.Resolver?.prototype, property, `dns.Resolver.${property}`)
    patch(dgram, 'createSocket', 'dgram.createSocket')
    patch(dgram.Socket?.prototype, 'connect', 'dgram.Socket.connect')
    patch(dgram.Socket?.prototype, 'send', 'dgram.Socket.send')
    patch(globalThis, 'fetch', 'global.fetch')
    patch(globalThis, 'WebSocket', 'global.WebSocket')
    patch(globalThis, 'EventSource', 'global.EventSource')

    if (blockSubprocesses) {
      const childProcess = localRequire('node:child_process')
      for (const property of [
        'exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync',
      ]) patch(childProcess, property, `child_process.${property}`)
      const workerThreads = localRequire('node:worker_threads')
      patch(workerThreads, 'Worker', 'worker_threads.Worker')
    }

    const markerDescriptor = Object.getOwnPropertyDescriptor(globalThis, guardMarker)
    Object.defineProperty(globalThis, guardMarker, {
      configurable: true,
      enumerable: false,
      value: state,
      writable: false,
    })
    restorers.push(() => {
      if (markerDescriptor === undefined) delete globalThis[guardMarker]
      else Object.defineProperty(globalThis, guardMarker, markerDescriptor)
    })
    return state
  } catch (error) {
    try {
      state.restore()
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `${label}: network guard installation and rollback failed`,
        { cause: error },
      )
    }
    throw error
  }
}

module.exports = {
  OfflineNetworkGuardError,
  guardMarker,
  installOfflineNetworkGuard,
}

if (process.env.OPEN_RFC_OFFLINE_NETWORK_GUARD_AUTO === '1') {
  installOfflineNetworkGuard({
    label: process.env.OPEN_RFC_OFFLINE_NETWORK_GUARD_LABEL,
    blockSubprocesses: false,
    allowLoopback:
      process.env.OPEN_RFC_OFFLINE_NETWORK_GUARD_ALLOW_LOOPBACK === '1',
  })
}
