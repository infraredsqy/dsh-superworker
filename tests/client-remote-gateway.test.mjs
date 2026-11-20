/* The contribution against DSH's own Client gateway — the judge that decides whether the mount is
 * real, not just whether this plugin's own code agrees with itself.
 *
 * `remote-mount.ts` writes descriptors by hand (this package ships no generated artifact), so the
 * one thing worth pinning is that DSH's registry accepts them: `validateContribution` reads the
 * codecs, the ids and the namespaces, and the stream marker is what makes the mounted `watch`
 * answer a stream handle instead of a promise. A drifted descriptor fails here rather than in a
 * browser, where the symptom is a panel that silently stops updating.
 *
 * The gateway client is a dev dependency; the file skips itself with the reason when it is absent.
 *
 * One contribution is mounted per package per process, so this file mounts once, in the first case,
 * and every later case reads the namespace it left behind — which is also the order the plugin runs
 * in: mount, then use.
 *
 *   node --test tests/
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { apply as gatewayApply } from '@deepseek-ai/dsh-api-gateway/client'
import { createPanelPort, NAMESPACE, REMOTE_PARAM_ORDER, REMOTE_STREAMS } from '../src/client/data.ts'
import { mountRemoteNamespace, remoteContribution, REMOTE_PACKAGE } from '../src/client/remote-mount.ts'

/**
 * A Client context with the real Gateway and Registry on it, over a stand-in carrier.
 *
 * `interactions: 'none'` keeps the gateway off its event and stream mux: nothing here opens a
 * socket, so only the mount and the unary road are exercised. `open` on the rpc face makes the mux
 * treat this carrier as the worker-local one, which is the shape a page under a worker has.
 */
function liveClient() {
  const calls = []
  const connection = {
    interactions: 'none',
    isLoopback: true,
    generation: { getSnapshot: () => ({ host: { home: 'C:\\home' } }) },
    rpc: {
      async call(path, endpoint, payload) {
        calls.push({ path, endpoint, payload })
        return { ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null, sources: {} } }
      },
      open: () => undefined,
    },
    openWebSocket: () => { throw new Error('this probe opens no socket') },
    start: () => ({ stop: () => undefined }),
  }

  const ctx = new Context()
  new TypertRegistry(ctx)
  ctx.provide('connection', connection)
  gatewayApply(ctx)
  return { ctx, calls }
}

const rig = liveClient()

/** The namespace the gateway installed, read back off the context's own service table. */
function namespacesOf(ctx) {
  return Object.entries(ctx.reflect.props)
    .filter(([key, def]) => def.type === 'service' && key === `remote.${NAMESPACE}`)
    .map(([key]) => key)
}

test('the real gateway mounts this contribution: the namespace becomes readable, and the port moves onto it', async () => {
  const port = createPanelPort(rig.ctx)
  assert.equal(port.source, 'carrier', 'before the mount the panel has only the carrier road')

  /* The mount's own callback is the event: it runs once the namespace is readable, and it is what
     drives the port's upgrade in `apply` too. */
  await new Promise((resolve) => {
    mountRemoteNamespace(rig.ctx, { namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS }, () => {
      port.refresh()
      resolve()
    })
  })

  assert.deepEqual(namespacesOf(rig.ctx), [`remote.${NAMESPACE}`], 'the gateway did not install the namespace, so every read would stay on the carrier')
  assert.equal(port.source, 'remote', 'the port did not move onto the namespace that is now readable')
})

test('through the mounted namespace a unary endpoint answers over the carrier with the wire arguments it was given', async () => {
  const port = createPanelPort(rig.ctx)
  assert.equal(port.source, 'remote')
  rig.calls.length = 0

  const reading = await port.readSessions('s1', 'C:\\ws')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  /* The gateway builds its args on a null-prototype object on purpose; only the content is judged. */
  assert.deepEqual(
    rig.calls.map((call) => [call.path, call.endpoint, { ...call.payload.args }]),
    [['/api', `${NAMESPACE}/readSessions`, { sessionId: 's1', workspaceRoot: 'C:\\ws' }]],
    'the mounted method must reach the carrier as the endpoint it declares, with named wire arguments',
  )
})

test('watch is mounted as a stream: it hands back a stream handle, where a unary call would hand back a promise', () => {
  const handle = rig.ctx.remote[NAMESPACE].watch('s1', 'C:\\ws')
  try {
    assert.notEqual(typeof handle?.then, 'function', 'a promise here means the stream marker did not land: the panel would read one value and stop')
    assert.equal(typeof handle?.[Symbol.asyncIterator], 'function', 'the handle has to be iterable, which is how the panel subscribes')
    assert.equal(typeof handle.dispose, 'function', 'without a disposer the host stream outlives the panel')
  } finally {
    handle?.dispose?.()
  }
})

test('a second mount of the same contribution is refused: the plugin mounts once and upgrades the port', async () => {
  /* That refusal is the whole argument for `refresh()` instead of "build the port after the mount
   * lands" — and a refused mount must leave the port on the layer it already has. */
  const contribution = remoteContribution({ namespace: NAMESPACE, order: REMOTE_PARAM_ORDER, streams: REMOTE_STREAMS })
  assert.equal(contribution.package, REMOTE_PACKAGE)
  await assert.rejects(() => rig.ctx.remote.$mount(contribution), /already mounted/u)

  const port = createPanelPort(rig.ctx)
  assert.equal(port.source, 'remote', 'the namespace is still the readable one after the refused mount')
})

after(() => {
  /* The gateway's own transport effect closes its mux on stop; this carrier has no socket to close,
     so the stop settles without anything being waited on. */
  void rig.ctx.stop?.()
})
