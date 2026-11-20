/* The mount of this plugin's own Remote namespace: the one thing that turns the panel's channel
 * from "one read then silence" into a live stream.
 *
 * Three things are locked here, one per layer:
 *
 *   1. the contribution's shape — the namespace, one descriptor per endpoint, the wire names in call
 *      order, and `mode: 'stream'` plus the carrier cancellation on `watch` only. The host's gateway
 *      judges an endpoint by exactly this, so a drift makes every call `gateway/signature-invalid`;
 *   2. the mount itself — `remote.$mount` is called once, the namespace is waited for when the
 *      service is not there yet, and a refused mount leaves a trace and changes nothing;
 *   3. the port's upgrade — a port created before the mount lands starts on the carrier and moves to
 *      the mounted namespace, re-opening a channel that is already watching, which is the whole
 *      reason the mount is allowed to be asynchronous.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelPort, NAMESPACE, REMOTE_PARAM_ORDER, REMOTE_STREAMS } from '../src/client/data.ts'
import { remoteContribution, REMOTE_PACKAGE } from '../src/client/remote-mount.ts'

/** Silence one call of `console.warn`, handing back what it said. */
async function quietWarnings(run) {
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  try {
    await run()
  } finally {
    console.warn = realWarn
  }
  return warned
}

/**
 * A stand-in for DSH's Client gateway: `$mount` records the contribution and can be held open, so a
 * case can put the port in the exact window the real one has (mount started, promise not settled).
 */
function fakeRemote({ hold = false, refuse = null } = {}) {
  const mounts = []
  let release
  const remote = {
    $mount(contribution) {
      mounts.push(contribution)
      if (refuse !== null) return Promise.reject(refuse)
      if (!hold) return Promise.resolve(async () => undefined)
      return new Promise((resolve) => { release = () => resolve(async () => undefined) })
    },
  }
  return { remote, mounts, release: () => release?.() }
}

/** What the mounted namespace would look like once the gateway installs one; `read`/`readSessions` answer a reading. */
function fakeNamespace({ streamed = true } = {}) {
  const opened = []
  const namespace = {
    read: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws' } }),
    readSessions: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } }),
  }
  if (streamed) {
    namespace.watch = (...values) => {
      opened.push(values)
      const stream = (async function* () {
        yield { at: 1, workspaceRoot: 'C:\\ws', reading: { workspaceRoot: 'C:\\ws' }, sessions: null }
      })()
      return Object.assign(stream, { dispose: () => undefined })
    }
  }
  return { namespace, opened }
}

test('the contribution: one package, one descriptor per endpoint, all on this plugin\'s namespace', () => {
  const contribution = remoteContribution({ namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS })

  assert.equal(contribution.package, REMOTE_PACKAGE)
  assert.equal(contribution.descriptors.length, Object.keys(REMOTE_PARAM_ORDER).length)
  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.namespace, NAMESPACE, 'every descriptor lands on the one namespace')
    assert.equal(descriptor.service, NAMESPACE, 'the service key is the namespace this host provides')
    assert.equal(descriptor.id, `${REMOTE_PACKAGE}#${NAMESPACE}/${descriptor.method}`, 'ids are unique per endpoint')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  }
  const ids = new Set(contribution.descriptors.map((one) => one.id))
  assert.equal(ids.size, contribution.descriptors.length, 'a repeated id makes the registry refuse the whole batch')
})

test('the contribution: the wire names are the call table\'s, in its order — a reorder misaligns every argument', () => {
  const contribution = remoteContribution({ namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS })
  const byMethod = new Map(contribution.descriptors.map((one) => [one.method, one]))

  for (const [method, wires] of Object.entries(REMOTE_PARAM_ORDER)) {
    assert.deepEqual(
      byMethod.get(method).parameters.map((parameter) => parameter.wire),
      wires,
      `${method}: the descriptor's wire order drifted from REMOTE_PARAM_ORDER`,
    )
    /* The JSON-safe tag is what DSH requires of a generated contribution: a non-strict codec is
       refused at mount time, and then nothing is mounted at all. */
    for (const parameter of byMethod.get(method).parameters) {
      assert.equal(parameter.source, 'json')
      assert.equal(parameter.codec.mode, 'strict')
    }
  }
})

test('the contribution: watch is a stream taking the carrier\'s cancellation, and no other endpoint claims to be one', () => {
  const contribution = remoteContribution({ namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS })
  const byMethod = new Map(contribution.descriptors.map((one) => [one.method, one]))

  const watch = byMethod.get('watch')
  assert.equal(watch.mode, 'stream', 'without this the host opens watch as a plain call and refuses it')
  assert.deepEqual(watch.cancellation, { parameter: 'signal' }, 'the stream ends when the carrier aborts, so the signal is not a business argument')
  assert.deepEqual(watch.parameters.map((one) => one.wire), ['sessionId', 'workspaceRoot'], 'the signal must not enter the wire arguments')

  for (const descriptor of contribution.descriptors) {
    if (descriptor.method === 'watch') continue
    assert.equal(descriptor.mode, undefined, `${descriptor.method} must stay a plain call`)
    assert.equal(descriptor.cancellation, undefined, `${descriptor.method}: a unary call carries no cancellation, or its arity is refused`)
  }
})

test('the mount: $mount is called once with the contribution, before anything subscribes', async () => {
  const { remote, mounts } = fakeRemote()
  const contributions = []
  const ctx = { get: (name) => (name === 'remote' ? remote : undefined), inject: (_names, callback) => callback(ctx) }
  const realMount = remote.$mount
  remote.$mount = (contribution) => { contributions.push(contribution); return realMount(contribution) }

  let mounted = 0
  const { mountRemoteNamespace } = await import('../src/client/remote-mount.ts')
  mountRemoteNamespace(ctx, { namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS }, () => { mounted += 1 })
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(mounts.length, 1, 'one mount, not one per endpoint')
  assert.equal(contributions.length, 1)
  assert.equal(mounted, 1, 'the caller is told once the namespace is readable')
})

test('the mount: a refused mount leaves a trace, does not throw, and reports no success', async () => {
  const { remote } = fakeRemote({ refuse: new Error('namespace already taken') })
  const ctx = { get: (name) => (name === 'remote' ? remote : undefined), inject: (_names, callback) => callback(ctx) }
  const { mountRemoteNamespace } = await import('../src/client/remote-mount.ts')

  let mounted = 0
  const warned = await quietWarnings(async () => {
    assert.doesNotThrow(() => {
      mountRemoteNamespace(ctx, { namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS }, () => { mounted += 1 })
    })
    /* The refusal is answered on the promise `$mount` handed back, so draining the microtask queue
       is what "the mount settled" means here — no timer, nothing to poll. */
    await Promise.resolve()
    await Promise.resolve()
  })

  assert.equal(mounted, 0, 'a refused mount must not be reported as a readable namespace')
  assert.match(warned.join('\n'), /already taken/u, 'a refused mount that says nothing is a panel that stays on the one-frame road for no visible reason')
})

test('the port upgrades: created before the mount lands on the carrier, it moves to the stream when the mount settles', () => {
  /* The real window: `apply` builds the port while `$mount` is still a pending promise, the panel
     subscribes on the carrier road, and only then does the namespace become readable. */
  const rpc = { call: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } }) }
  let namespace
  const ctx = {
    get: (name) => {
      if (name === 'connection') return { rpc }
      if (name === `remote.${NAMESPACE}`) return namespace
      return undefined
    },
  }

  const port = createPanelPort(ctx)
  assert.equal(port.source, 'carrier', 'before the mount lands the namespace is not there, so the carrier road is what the panel has')

  /* A channel is open on the carrier when the mount lands — this is the case the upgrade exists for. */
  const seen = []
  const firstFrame = new Promise((resolve) => {
    port.watch('s1', 'C:\\ws', (frame) => { seen.push(frame); resolve() })
  })
  assert.ok(firstFrame instanceof Promise)

  const { namespace: mounted, opened } = fakeNamespace()
  namespace = mounted
  assert.equal(port.refresh(), true, 'the port reports the layer change so the caller knows it happened')
  assert.equal(port.source, 'remote')
  assert.ok(opened.length >= 1, 'the channel open before the mount must be re-opened on the mounted namespace')
  assert.deepEqual(opened[0], ['s1', 'C:\\ws'], 'the re-opened stream names the same session and workspace')

  return firstFrame
})

test('the port upgrades once: refresh on an already-better layer changes nothing and reports no change', () => {
  const { namespace } = fakeNamespace()
  const ctx = { get: (name) => (name === `remote.${NAMESPACE}` ? namespace : undefined) }
  const port = createPanelPort(ctx)

  assert.equal(port.source, 'remote')
  assert.equal(port.refresh(), false, 'a second refresh must not re-open every channel')
  assert.equal(port.source, 'remote')
})

test('the port does not downgrade: a namespace that goes away leaves the better layer in place', () => {
  const { namespace } = fakeNamespace()
  let present = namespace
  const ctx = { get: (name) => (name === `remote.${NAMESPACE}` ? present : undefined) }
  const port = createPanelPort(ctx)
  assert.equal(port.source, 'remote')

  present = undefined
  assert.equal(port.refresh(), false, 'a layer that disappeared must not pull the panel back onto a weaker road')
  assert.equal(port.source, 'remote')
})

test('a port on the carrier still works after a refresh that found nothing better', async () => {
  /* The no-regression case: a deployment that never mounts the namespace keeps the carrier road, and
     calling refresh on it is a no-op rather than a broken port. */
  const rpc = {
    call: async (path, endpoint, payload) => {
      assert.equal(path, '/api')
      assert.equal(endpoint, 'superworker/read')
      assert.deepEqual(payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\ws', options: {} } })
      return { ok: true, value: { workspaceRoot: 'C:\\ws' } }
    },
  }
  const ctx = { get: (name) => (name === 'connection' ? { rpc } : undefined) }
  const port = createPanelPort(ctx)

  assert.equal(port.source, 'carrier')
  assert.equal(port.refresh(), false)
  const reading = await port.read('s1', 'C:\\ws')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
})

test('with no layer at all: the port says none, and a refresh cannot invent one', async () => {
  const port = createPanelPort({ get: () => undefined })
  assert.equal(port.source, 'none')
  assert.equal(port.refresh(), false)
  assert.equal(port.source, 'none')
  await assert.rejects(() => port.read('s1', ''), (error) => error.failure.code === 'not-connected')
})

test('a mounted namespace whose watch is a plain call: the fallback still works and leaves a trace', async () => {
  /* The step-one case: the name is mounted, so the port tries it as a stream first; a promise comes
     back, and reading a promise as a stream is not a guess this layer is allowed to make. The
     one-frame road is the answer — and the reason has to be on the console, or this state is
     indistinguishable from a deployment with no stream at all. */
  const namespace = {
    watch: async () => ({ ok: true, value: {} }),
    read: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws' } }),
    readSessions: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } }),
  }
  const port = createPanelPort({ get: (name) => (name === `remote.${NAMESPACE}` ? namespace : undefined) })

  const frames = []
  /* The subscription is made inside the capture window: the trace is written synchronously as the
     stream attempt fails, which is the moment being judged. The frame itself is the event — nothing
     here waits for a clock, only for the panel's own callback. */
  const warned = await quietWarnings(() => new Promise((resolve) => {
    port.watch('s1', 'C:\\ws', (frame) => { frames.push(frame); resolve() })
  }))

  assert.equal(frames.length, 1, 'the fallback frame did not arrive: the one-frame road has to keep working')
  assert.equal(frames[0].reading.workspaceRoot, 'C:\\ws')
  const trace = warned.join('\n')
  assert.match(trace, /watch endpoint cannot be opened as a stream/u, `the fallback left no trace: ${JSON.stringify(warned)}`)
  assert.match(trace, /one read/u, 'the trace says which road was taken')
})
