/* The host-half plugin segment: locks in the workspace root resolution order.
 *
 * Three sources settle in order — live session header, stored session header, the sandbox
 * policy's root — none may be shuffled; once a live header exists, the stored one is never
 * consulted. That the root handed to the port is the resolved one is also locked here.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/host/index.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext as standIn } from './helpers/host-context.mjs'

/* Loading this line places the shipped skills into the DSH skill root, and these cases only exercise
 * the record service — so the root they would write into is pinned to a temp home here, never the
 * machine's own. `apply` returns the placement seam; these cases do not wait on it, they only check
 * that loading still installs the service (the placement has its own file, `host-skills`). */
const pinned = pinHome(['DSH_HOME'], 'superworker-plugin-home-')
test.after(pinned.restore)

const signal = new AbortController().signal

/**
 * The context the plugin is applied to: the live and stored session headers, the sandbox policy's
 * fallback root, and the workspace-files port in its bare not-found form — every directory and file
 * is absent, which is the reading these cases judge (which root was asked, and for what).
 */
function context({ live = {}, stored = {}, sandboxRoot = 'C:\\fallback-root' } = {}) {
  return standIn({ live, stored, sandboxRoot, files: {}, provide: true })
}

test('The plugin name and dependency declaration are the host\'s four', () => {
  assert.equal(name, 'superworker-records')
  assert.deepEqual(inject, ['workspaceFiles', 'sessions', 'sandboxPolicy', 'tools'])
})

test('The export surface is the five things the plugin contract wants: internals no longer pass through the entry', async () => {
  const entry = await import('../src/host/index.ts')

  assert.equal(typeof entry.apply, 'function')
  assert.ok('Config' in entry, 'Config must be on the export surface: DSH builds that section\'s settings namespace from it')

  for (const internal of [
    'rootFor',
    'workspaceRootOf',
    'runPf',
    'readReading',
    'readWholeFile',
    'CONFIG_KEYS',
    'parseConfigList',
  ]) {
    assert.equal(entry[internal], undefined, `${internal} has no outside consumer and must not come through the entry again`)
  }
  /* The gateway class stays on the export surface: `tests/client-render` builds a fresh gateway from the entry. */
  assert.equal(typeof entry.SuperworkerRecordsGateway, 'function')
})

test('The live session header speaks: the cwd it wrote is the root readings are taken at', async () => {
  const { ctx, provided, asked } = context({
    live: { s1: { header: { cwd: 'C:\\from-the-live-session' } } },
    stored: { s1: { header: { cwd: 'C:\\from-the-stored-header' } } },
  })
  apply(ctx)
  const reading = await provided.superworker.read('s1', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\from-the-live-session')
  assert.ok(asked.length > 0)
  for (const call of asked) {
    assert.equal(call.scope.workspaceRoot, 'C:\\from-the-live-session')
    assert.equal(call.scope.sessionId, 's1')
  }
})

test('With no live session, the stored session header speaks', async () => {
  const { ctx, provided, asked } = context({ stored: { s2: { header: { cwd: 'C:\\from-the-stored-header' } } } })
  apply(ctx)
  const reading = await provided.superworker.read('s2', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\from-the-stored-header')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\from-the-stored-header')
})

test('A live header ends the stored one\'s say: with no cwd in it, the sandbox policy root takes over', async () => {
  const { ctx, provided, asked, statCalls } = context({
    live: { s4: { header: {} } },
    stored: { s4: { header: { cwd: 'C:\\from-the-stored-header' } } },
    sandboxRoot: 'C:\\sandbox-root-for-tests',
  })
  apply(ctx)
  const reading = await provided.superworker.read('s4', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.deepEqual(statCalls, [], 'the live header is there, so the stored one is never even asked')
})

test('With cwd in neither session header, it falls to the sandbox policy root', async () => {
  const { ctx, provided, asked } = context({
    live: { s3: { header: {} } },
    stored: { s3: { header: {} } },
    sandboxRoot: 'C:\\sandbox-root-for-tests',
  })
  apply(ctx)
  const reading = await provided.superworker.read('s3', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\sandbox-root-for-tests')
})

test('A session nobody knows still goes to the sandbox policy root, and the read does not throw', async () => {
  const { ctx, provided } = context({ sandboxRoot: 'C:\\sandbox-root-for-tests' })
  apply(ctx)
  const reading = await provided.superworker.read('nobody-knows-me', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.deepEqual(reading.sources, { nodes: 'missing', cycles: 'missing', instructions: 'missing', issues: 'missing' })
  assert.deepEqual(reading.nodes, {})
})

test('The service is installed on ctx, and the caller\'s abort signal is handed on to the port', async () => {
  const { ctx, provided, asked } = context({ sandboxRoot: 'C:\\sandbox-root-for-tests' })
  apply(ctx)
  assert.equal(typeof provided.superworker.read, 'function')

  const controlled = new AbortController()
  await provided.superworker.read('s9', '', { signal: controlled.signal })
  assert.ok(asked.length > 0, 'the trip must really reach the port before the signal can arrive')
  for (const call of asked) {
    assert.equal(call.signal, controlled.signal, 'the signal the port sees must be the caller\'s, not one the endpoint minted')
  }
})