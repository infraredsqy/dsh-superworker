/* The host-half remote port: locks in "whether DSH's gateway recognizes these endpoints".
 *
 * The judge sits on the gateway side: endpoints are recognized via the class's markers and
 * parameter names are sliced out of method source code. So a few seemingly unrelated details can
 * make an endpoint uncallsable in a real deployment (a parameter with a default value, a trailing
 * comma in the parameter list) — defects that pass locally and only surface on a real gateway.
 * That is why they deserve a test case standing guard.
 *
 * The gateway and registry are optional dev dependencies: skip when absent, call every endpoint
 * one by one when present.
 *
 *   node --test tests/
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SuperworkerRecordsGateway } from '../src/host/gateway.ts'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'
import { pinHome } from './helpers/env.mjs'

/* One machine layer for this file: the settings endpoint reads the global layer, which lives in the
 * home directory — `SUPERWORKER_HOME_DIR` is the engine's own switch for it, so this case never reads (or is
 * steered by) the developer's own home. */
const pinned = pinHome(['SUPERWORKER_HOME_DIR'], 'superworker-gateway-home-')
after(pinned.restore)

/** The nine endpoints, matching the table in `gateway.ts`. */
const ENDPOINTS = [
  'read',
  'addInstruction',
  'archiveInstruction',
  'reviveInstruction',
  'removeInstruction',
  'readConfig',
  'setConfig',
  'readSessions',
  'openNodeSession',
]

const wired = await Promise.all([
  import('@deepseek-ai/cordis').then(() => true, () => false),
  import('@deepseek-ai/dsh-api-gateway').then(() => true, () => false),
  import('@deepseek-ai/dsh-typert-registry').then(() => true, () => false),
]).then((flags) => flags.every(Boolean))

/** Build a minimal record: a little content in each of the four files, enough for a reading to pick up; plus one session note. */
function syntheticWorkspace({ note = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'superworker-gateway-'))
  mkdirSync(join(root, '.superworker', 'issues'), { recursive: true })
  writeFileSync(join(root, '.superworker', 'ideas.json'), JSON.stringify({
    nodes: { 'n-1': { id: 'n-1', title: 'one cell', status: 'todo', created_at: '2026-10-01T00:00:00Z' } },
    edges: [],
  }))
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({
    cycles: [{ id: 'line-1', status: 'active', created_at: '2026-10-01T00:00:00Z', path: [], holding: [] }],
  }))
  writeFileSync(join(root, '.superworker', 'instructions.json'), JSON.stringify({
    instructions: [{ id: 'i-1', text: 'one sentence', scope: 'global', state: 'live', at: '2026-10-01T00:00:00Z' }],
  }))
  writeFileSync(join(root, '.superworker', 'issues', 'issues.json'), JSON.stringify({ issues: {} }))
  if (note) {
    mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true })
    writeFileSync(join(root, '.superworker', 'meta', 'sessions', 'n-1.json'), JSON.stringify({
      node: 'n-1',
      v: 1,
      discussion: [{ session: 'session-talk', at: '2026-10-01T00:00:00Z' }],
      run: [{ session: 'session-run', at: '2026-10-02T00:00:00Z' }],
    }))
  }
  return root
}

/** A live rig with a real cordis context, the real gateway, and the real registry. */
async function liveGateway(root) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
  const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry')

  const ctx = new Context()
  /* The wiring here is its own: this is a live gateway over a real directory on disk, so `list`
   * reads the directory itself. The paging a read answers with, though, is the shared one. */
  ctx.provide('workspaceFiles', {
    async list(scope, path) {
      const { readdirSync, existsSync } = await import('node:fs')
      const target = join(root, path)
      if (!existsSync(target)) throw absentError(target)
      return {
        path,
        entries: readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: false,
      }
    },
    async read(scope, path, range) {
      const { existsSync, readFileSync } = await import('node:fs')
      const target = join(root, path)
      if (!existsSync(target)) throw absentError(target)
      return readPage(readFileSync(target, 'utf8'), range)
    },
  })
  ctx.provide('sessions', { get: (id) => (id === 's1' ? { header: { cwd: root } } : undefined) })
  ctx.provide('sandboxPolicy', { workspaceRoot: root })

  new TypertRegistry(ctx)
  const gateway = new TypertGatewayService(ctx)
  ctx.provide('superworker', new SuperworkerRecordsGateway(ctx))
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  return {
    ctx,
    call: async (method, args) => {
      try {
        return { ok: true, value: await gateway.invoke({ namespace: 'superworker', method, args, peer }) }
      } catch (error) {
        return { ok: false, code: error?.code, message: error?.message ?? String(error) }
      }
    },
  }
}

test('The nine endpoints all answer in source mode: the signature gate first, other errors aside', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    for (const method of ENDPOINTS) {
      const answer = await call(method, {})
      assert.notEqual(answer.code, 'gateway/signature-invalid', `${method}: the gateway judged the signature unreadable: ${String(answer.message)}`)
      assert.notEqual(answer.code, 'gateway/invocation-unavailable', `${method} was not recognized by the gateway: ${String(answer.message)}`)
    }
  } finally {
    await ctx.stop?.()
  }
})

test('The read endpoint: the gateway reads the named workspace into a real reading', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('read', { sessionId: 's1', workspaceRoot: '', options: {} })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, root)
    assert.deepEqual(answer.value.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
    assert.deepEqual(Object.keys(answer.value.nodes), ['n-1'])
    assert.equal(answer.value.cycles.length, 1)
  } finally {
    await ctx.stop?.()
  }
})

test('The read endpoint: the named root wins, wherever this session itself sits', { skip: !wired }, async () => {
  const mine = syntheticWorkspace()
  const other = syntheticWorkspace()
  const { ctx, call } = await liveGateway(mine)
  try {
    const answer = await call('read', { sessionId: 's1', workspaceRoot: other, options: {} })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, other)
    assert.deepEqual(answer.value.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  } finally {
    await ctx.stop?.()
  }
})

test('The session-notes endpoint: the gateway carries the per-node notes under that layer back as they are', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('readSessions', { sessionId: 's1', workspaceRoot: '' })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, root)
    assert.equal(answer.value.state, 'read')
    assert.deepEqual(Object.keys(answer.value.notes), ['n-1.json'])
    assert.deepEqual(JSON.parse(answer.value.notes['n-1.json']), {
      node: 'n-1',
      v: 1,
      discussion: [{ session: 'session-talk', at: '2026-10-01T00:00:00Z' }],
      run: [{ session: 'session-run', at: '2026-10-02T00:00:00Z' }],
    })
  } finally {
    await ctx.stop?.()
  }
})

test('The session-notes endpoint: with that directory absent it answers empty, no throw', { skip: !wired }, async () => {
  const root = syntheticWorkspace({ note: false })
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('readSessions', { sessionId: 's1', workspaceRoot: '' })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.state, 'missing')
    assert.deepEqual(answer.value.notes, {})
  } finally {
    await ctx.stop?.()
  }
})

test('readSessions honors the abort signal on options: the caller\'s own reaches the port unchanged', async () => {
  /* options is a wire-level parameter, so the signal cannot pass the gateway's boundary validation;
   * options.signal, like read's, is reachable only in-process. So this case measures it the in-process
   * way read does: call the method directly and see whose signal reaches the port. */
  const seen = []
  const gateway = new SuperworkerRecordsGateway({
    workspaceFiles: {
      async list(scope, path, signal) {
        seen.push(signal)
        return { path, entries: [], truncated: false }
      },
      async read() {
        throw new Error('nothing to read in this test')
      },
    },
    sessions: { get: () => ({ header: { cwd: 'C:\\ws' } }) },
    sandboxPolicy: { workspaceRoot: 'C:\\ws' },
  })
  const mine = new AbortController()
  await gateway.readSessions('s1', '', { signal: mine.signal })

  assert.ok(seen.length > 0, 'the trip must really reach the port before the signal can arrive')
  for (const one of seen) {
    assert.equal(one, mine.signal, 'the signal the port sees must be the caller\'s, not one the endpoint minted')
  }
})

/* ---- the live-agent roster: `alive` reads each agent's own id ------------- */

/** A bare gateway over an empty record tree, with the agent registry this case names (`undefined` = the host exposes none). */
function rosterGateway(agents) {
  return new SuperworkerRecordsGateway({
    workspaceFiles: {
      async list(scope, path) { return { path, entries: [], truncated: false } },
      async read() { throw new Error('nothing to read in this test') },
    },
    sessions: { get: () => ({ header: { cwd: 'C:\\ws' } }) },
    sandboxPolicy: { workspaceRoot: 'C:\\ws' },
    ...(agents === undefined ? {} : { get: (name) => (name === 'agents' ? agents : undefined) }),
  })
}

test('alive reads the agent\'s own id: two live agents on the registry, the roster deep-equals two session ids', async () => {
  /* The DSH agent contract puts the session identity on `id`; a roster that
   * reads any other field filters every live agent out and answers "no live
   * sessions" while the registry is up — the reading the stranded judgment
   * would take as "gone". */
  const gateway = rosterGateway({ list: () => [{ id: 'session-a' }, { id: 'session-b' }] })
  const reading = await gateway.readSessions('s1', 'C:\\ws')
  assert.deepEqual(reading.alive, ['session-a', 'session-b'])
})

test('No registry: alive answers null (no answer is not "none alive")', async () => {
  const gateway = rosterGateway(undefined)
  const reading = await gateway.readSessions('s1', 'C:\\ws')
  assert.equal(reading.alive, null)
})

test('registry list() throws: alive answers null', async () => {
  const gateway = rosterGateway({ list() { throw new Error('registry blew up') } })
  const reading = await gateway.readSessions('s1', 'C:\\ws')
  assert.equal(reading.alive, null)
})

test('An endpoint missing from the table errors at construction: a method on the class but not in the table is no longer silent', () => {
  /* The same rig measures the base class first: it constructs fine — the later error is about the unlisted method, not construction itself. */
  assert.doesNotThrow(() => new SuperworkerRecordsGateway({}))
  class LeakyGateway extends SuperworkerRecordsGateway {
    sneak() {
      return 'not an endpoint'
    }
  }
  assert.throws(() => new LeakyGateway({}), /missing an entry/u)
})

test('The record-an-instruction endpoint: the words pass the gateway and land as the tool\'s line', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('addInstruction', {
      sessionId: 's1',
      workspaceRoot: '',
      text: 'look at the record before acting & do not guess',
      scope: 'global',
      cycle: '',
      node: '',
    })
    assert.equal(answer.ok, true, String(answer.message))
  } finally {
    await ctx.stop?.()
  }
})

test('The three write endpoints and the two settings ones also answer through the gateway', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const archived = await call('archiveInstruction', { sessionId: 's1', workspaceRoot: '', id: 'i-1' })
    assert.equal(archived.ok, true, String(archived.message))
    const revived = await call('reviveInstruction', { sessionId: 's1', workspaceRoot: '', id: 'i-1' })
    assert.equal(revived.ok, true, String(revived.message))
    const removed = await call('removeInstruction', { sessionId: 's1', workspaceRoot: '', id: 'i-1' })
    assert.equal(removed.ok, true, String(removed.message))
    const listed = await call('readConfig', { sessionId: 's1', workspaceRoot: '' })
    assert.equal(listed.ok, true, String(listed.message))
    assert.equal(listed.value.workspaceRoot, root)
    assert.equal(listed.value.ok, true, 'the words answered, the reading lands on the success branch')
    assert.equal(listed.value.refusal, null, 'the success branch carries no refusal')
    assert.ok(listed.value.text.length > 0, 'a successful reading carries the lines the engine printed')
    assert.ok(Object.keys(listed.value.entries).length > 0, 'those lines parse into settings entries')
    const written = await call('setConfig', { sessionId: 's1', workspaceRoot: '', key: 'test_tier', value: 'minimal' })
    assert.equal(written.ok, true, String(written.message))
  } finally {
    await ctx.stop?.()
  }
})