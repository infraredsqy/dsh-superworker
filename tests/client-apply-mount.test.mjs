/* The built browser half's entry, over a stand-in for DSH's Client gateway: locks in that applying
 * the plugin mounts this plugin's namespace and that the panel's channel ends up on it.
 *
 * The gap this file guards was invisible from every other test: `apply` builds the port while
 * `$mount` is still a pending promise, so a port created there starts on the carrier road. If the
 * mount's callback did not upgrade it, the panel would read once and then never again — while every
 * unit below it stayed green, because each one was handed a namespace that already existed.
 *
 * It runs against `lib/client.js` because `apply` reaches the panel's components; the bundle is the
 * only form of this layer Node can load. `npm test` builds it first, and the file skips itself with
 * the reason when it is missing.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { BUNDLE, bundleSkip } from './helpers/client-shell.mjs'

/**
 * Load the bundle through the shell's own module loader, with a DOM in place.
 *
 * React touches `window`/`document` once at load time, so the document is installed before the
 * import — the same order the real shell produces.
 */
async function loadBundle() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', { url: 'http://127.0.0.1/' })
  const { window } = dom
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'SVGElement']) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
  }
  window.__ModuleLoader__ = { load: (spec) => { window.__spec__ = spec } }
  await import(pathToFileURL(BUNDLE).href)
  const spec = window.__spec__
  if (!spec) throw new Error('the bundle loaded without handing the shell a spec')
  return spec.factory((name) => {
    if (name === 'react') return globalThis.__react__
    throw new Error(`this module table has no ${name}`)
  })
}

/**
 * A stand-in context carrying `connection` and a `remote` whose `$mount` resolves on demand.
 *
 * `land()` is the mount finishing — the case decides when, instead of waiting for a clock — and it
 * is what makes the namespace readable to `get`, the same sequence the real gateway produces.
 */
function harness() {
  const opened = []
  const namespace = {
    read: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws' } }),
    readSessions: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } }),
    watch: () => {
      opened.push('watch')
      const stream = (async function* () {
        yield { at: 1, workspaceRoot: 'C:\\ws', reading: { workspaceRoot: 'C:\\ws' }, sessions: null }
      })()
      return Object.assign(stream, { dispose: () => undefined })
    },
  }
  let present
  let land
  const rpc = { call: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } }) }
  const remote = {
    $mount: () => new Promise((resolve) => {
      land = () => { present = namespace; resolve(async () => undefined) }
    }),
  }
  const provided = {}
  const ctx = {
    get: (name) => {
      if (name === 'connection') return { rpc }
      if (name === 'remote') return remote
      if (name === 'remote.superworker') return present
      return undefined
    },
    inject: (_names, callback) => callback(ctx),
    provide: (key, value) => { provided[key] = value },
    effect: (run) => {
      const off = run()
      return () => { if (typeof off === 'function') off() }
    },
  }
  return { ctx, provided, land: () => land?.(), opened }
}

/* One bundle per process: a second load re-runs the plugin's module scope, and the panel's
 * stylesheet markers are page-wide. */
const client = bundleSkip === false ? await (async () => {
  globalThis.__react__ = await import('react')
  return loadBundle()
})() : null

test('applying the plugin provides the panel and mounts the namespace once', { skip: bundleSkip }, () => {
  const { ctx, provided } = harness()
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  try {
    client.apply(ctx)
  } finally {
    console.warn = realWarn
  }

  assert.equal(provided[client.SERVICE_KEY]?.id, client.PANEL_ID)
  assert.deepEqual(warned, [], `applying over a stand-in gateway must not warn: ${JSON.stringify(warned)}`)
})

test('the panel\'s port starts on the carrier and moves to the mounted namespace when the mount lands', { skip: bundleSkip }, async () => {
  /* The real window: `apply` returns, the panel opens its channel on whatever is there, and only
     then does the gateway finish installing the namespace. */
  const { ctx, provided, land } = harness()
  client.apply(ctx)
  const port = provided[client.SERVICE_KEY].port

  assert.equal(port.source, 'carrier', 'the mount has not landed yet, so the carrier road is what the panel has')

  const frames = []
  const firstFrame = new Promise((resolve) => {
    port.watch('s1', 'C:\\ws', (frame) => { frames.push(frame); resolve() })
  })

  /* `land()` settles `$mount`; the callback `apply` handed it drives the upgrade. The port is read
     back on the microtask the mount's promise resolves on, which is the earliest it can be. */
  land()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(port.source, 'remote', 'the panel is still on the one-frame road after the namespace became readable')

  await firstFrame
  assert.ok(frames.length >= 1, 'the panel must get a frame on the road it ended up on')
})

test('a gateway whose mount never lands keeps the carrier road, and its reads keep working', { skip: bundleSkip }, async () => {
  const { ctx, provided } = harness()
  client.apply(ctx)
  const port = provided[client.SERVICE_KEY].port

  assert.equal(port.source, 'carrier')
  const reading = await port.read('s1', 'C:\\ws')
  assert.equal(reading.workspaceRoot, 'C:\\ws', 'the fallback must keep answering while the mount is pending')
})
