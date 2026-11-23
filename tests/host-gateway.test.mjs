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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SuperworkerRecordsGateway } from '../src/host/gateway.ts'
import { RecordsPump } from '../src/host/pump.ts'
import { declaredOptions } from '../src/host/project-config.ts'
import { fakeAgents } from './helpers/agents-registry.mjs'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'
import { pinHome } from './helpers/env.mjs'

/* One machine layer for this file: the settings endpoint reads the global layer, which lives in the
 * home directory — `SUPERWORKER_HOME_DIR` is the engine's own switch for it, so this case never reads (or is
 * steered by) the developer's own home. */
const pinned = pinHome(['SUPERWORKER_HOME_DIR'], 'superworker-gateway-home-')
after(pinned.restore)

/** Every endpoint, matching the table in `gateway.ts`. */
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
  'consultMigration',
  'consultRoute',
  'consultConduct',
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

/* ---- three record trees, and which one a write reached ---------------------- */

/**
 * A record tree with everything the five write verbs and the node open read, hand-written rather than
 * laid down by `ledger.init()`: these cases build three of them per cell, and a cell is a reading of
 * **where** a write landed, so the trees only have to be real, not produced by the engine. `marker`
 * goes into every file, so a snapshot printed in a failure says which tree answered.
 *
 * The two instruction entries are one live and one withdrawn, because `archive` acts on a live one and
 * `revive` on a withdrawn one: one entry cannot serve both, and a cell that had to reuse one would
 * only be judging one of the two verbs.
 */
function recordTree(marker) {
  const root = mkdtempSync(join(tmpdir(), 'superworker-gateway-tree-'))
  mkdirSync(join(root, '.superworker', 'issues'), { recursive: true })
  writeFileSync(join(root, '.superworker', '.gitignore'), '*\n')
  writeFileSync(join(root, '.superworker', '.gitattributes'), '* text=auto\n')
  writeFileSync(join(root, '.superworker', 'AGENTS.md'), '# records\n')
  writeFileSync(join(root, '.superworker', 'config.json'), '{}\n')
  writeFileSync(join(root, '.superworker', 'ideas.json'), JSON.stringify({
    nodes: { 'n-1': { status: 'todo', title: `the cell of ${marker}`, mode: 'auto', dependencies: [] } },
  }))
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({
    cycles: [{ id: 'c-1', status: 'active', tags: [], holding: [{ id: 'n-1', since: '2026-10-18T00:00:00Z' }], path: [] }],
  }))
  writeFileSync(join(root, '.superworker', 'instructions.json'), JSON.stringify({
    instructions: [
      { id: 'i-1', text: `the live one of ${marker}`, scope: 'global', state: 'live', at: '2026-10-01T00:00:00Z' },
      { id: 'i-2', text: `the withdrawn one of ${marker}`, scope: 'global', state: 'withdrawn', at: '2026-10-01T00:00:00Z', resolved_at: '2026-10-02T00:00:00Z' },
    ],
  }))
  writeFileSync(join(root, '.superworker', 'issues', 'issues.json'), JSON.stringify({ issues: {} }))
  /* The launch cell's prompt: a real open has something to hand the session, so `openNodeSession`
   * answers `ok` on whichever tree it reaches — the branch that matters is the tree, not a refusal. */
  mkdirSync(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-1'), { recursive: true })
  writeFileSync(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt'), `/sw-conduct n-1 [${marker}]\n`)
  return root
}

/**
 * A workspace-files port that reads the root **the scope names**, not one fixed directory: the write
 * verbs and the opener resolve paths by the scope's `workspaceRoot`, so a port that ignored it would
 * make every tree answer with one tree's files and the whole rig would be one tree again — the very
 * compression this round is undoing.
 */
function scopedPort() {
  return {
    async list(scope, dir) {
      const base = scope?.workspaceRoot ?? ''
      try {
        const { readdirSync } = await import('node:fs')
        return {
          path: dir,
          entries: readdirSync(join(base, dir), { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          })),
          truncated: false,
        }
      } catch {
        throw absentError(dir)
      }
    },
    async read(scope, path, range) {
      const base = scope?.workspaceRoot ?? ''
      try {
        const { readFileSync } = await import('node:fs')
        return readPage(readFileSync(join(base, path), 'utf8').split('\r\n').join('\n'), range)
      } catch {
        throw absentError(path)
      }
    },
  }
}

/**
 * What the records of one tree hold right now, as the three readings the write cases judge:
 *
 * - `instructions` — every entry's `id:state`, and the tombstones' own ids (a removal leaves one);
 * - `config` — the project settings file, or `null` when the tree has none;
 * - `claim` — whether this tree holds the launch cell's `started` marker.
 *
 * Read straight off the disk rather than out of a door's answer, deliberately: the question these
 * cases ask is *where did the write land*, and only the files can answer it. What the door answered is
 * asserted beside it, so a cell is never a file read standing in for the endpoint's own report.
 */
function recordsOf(root) {
  let instructions = null
  let removed = []
  try {
    const data = JSON.parse(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8'))
    instructions = (data.instructions ?? []).map((entry) => `${entry.id}:${entry.state ?? 'live'}`)
    removed = (data.removed ?? []).map((trace) => trace.id)
  } catch {
    instructions = '<no instructions.json>'
  }
  let config = null
  try {
    config = JSON.parse(readFileSync(join(root, '.superworker', 'config.json'), 'utf8'))
  } catch {
    config = '<no config.json>'
  }
  const claim = existsSync(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-1', 'started'))
  return { instructions, removed, config, claim }
}

/** The three trees one cell is built on, with the live session sitting in the first and the sandbox in the second. */
function threeTrees() {
  const own = recordTree('this session')
  const sandbox = recordTree('the sandbox policy')
  const named = recordTree('the caller')
  return { own, sandbox, named }
}

/**
 * The rig one write cell runs in: three distinct real record trees, the live session header naming
 * `own`, the sandbox policy naming `sandbox`, and a port that answers at whichever root the scope
 * names. **Nothing here is one string twice**, which is the whole point of the fixture: a door that
 * uses the root it was handed lands on `named`, a door that fell back to this session's own root lands
 * on `own`, and a door that reached for the sandbox policy lands on `sandbox` — three different
 * readings, three different trees, and each of them a real record a verb really writes into.
 */
async function writeRig() {
  const trees = threeTrees()
  const agents = fakeAgents()
  const rig = await liveGateway(trees.own, {
    sandbox: trees.sandbox,
    port: scopedPort(),
    agents: agents.registry,
  })
  return { ...rig, ...trees, agents }
}

/**
 * A live rig with a real cordis context, the real gateway, and the real registry.
 *
 * Three roots, and they are three different things:
 *
 * - `workspace` is the cwd the live session header carries — where **this session** sits;
 * - `sandbox` is the sandbox policy's root, the seam's last fallback step;
 * - `records` is the directory the workspace-files port reads through (the alias's own tree, so reads
 *   still succeed).
 *
 * Until this round all three were one string, and that compression is what left the panel's write
 * doors unjudged: "the endpoint used the root the caller named" and "the endpoint fell back to this
 * session's own root" answered the **same** string, so no assertion could tell the two branches apart
 * (review-5's C1 and m1). A case that judges a root now hands the three in separately, and a case that
 * does not care may still pass one root and get the old single-string rig.
 *
 * `agents` hands the opener its registry.
 */
async function liveGateway(workspace, { records = workspace, sandbox = workspace, agents, port } = {}) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
  const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry')

  const ctx = new Context()
  /* The wiring here is its own: this is a live gateway over a real directory on disk, so `list`
   * reads the directory itself. The paging a read answers with, though, is the shared one.
   *
   * `port` replaces that wiring wholesale for a case whose reading is "which root did the door read
   * through": the fixed port below answers at `records` whatever root the scope names, which is
   * exactly what a fixture compressing the roots has to do and exactly what a case judging the root
   * cannot use. A case that seeds nothing gets the single-tree port of before. */
  ctx.provide('workspaceFiles', port ?? {
    async list(scope, path) {
      const { readdirSync, existsSync } = await import('node:fs')
      const target = join(records, path)
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
      const target = join(records, path)
      if (!existsSync(target)) throw absentError(target)
      return readPage(readFileSync(target, 'utf8'), range)
    },
  })
  ctx.provide('sessions', { get: (id) => (id === 's1' ? { header: { cwd: workspace } } : undefined) })
  ctx.provide('sandboxPolicy', { workspaceRoot: sandbox })
  if (agents !== undefined) ctx.provide('agents', agents)

  new TypertRegistry(ctx)
  const gateway = new TypertGatewayService(ctx)
  ctx.provide('superworker', new SuperworkerRecordsGateway(ctx))
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  return {
    ctx,
    gateway,
    call: async (method, args) => {
      try {
        return { ok: true, value: await gateway.invoke({ namespace: 'superworker', method, args, peer }) }
      } catch (error) {
        return { ok: false, code: error?.code, message: error?.message ?? String(error) }
      }
    },
  }
}

test('Every endpoint answers in source mode: the signature gate first, other errors aside', { skip: !wired }, async () => {
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

test('The channel endpoint is a real stream: the gateway opens it as one and its first frame carries both halves', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, gateway } = await liveGateway(root)
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  try {
    /* Through the gateway's own stream opener, which is the only road a stream endpoint has: calling it
     * as a plain call is refused by design, and that refusal is what proves the marker landed. */
    const stream = await gateway.stream({ namespace: 'superworker', method: 'watch', args: { sessionId: 's1', workspaceRoot: '' }, peer })
    const frames = []
    for await (const frame of stream) {
      frames.push(frame)
      break
    }
    assert.equal(frames.length, 1, 'the channel sent no first frame')
    assert.equal(frames[0].workspaceRoot, root)
    assert.deepEqual(frames[0].reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
    assert.equal(frames[0].sessions.state, 'read', 'the frame carried no session half')
    assert.equal(typeof frames[0].at, 'number')
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

test('The workspace endpoints keep the spelling the caller used, one cell each: an alias comes back as the alias', async () => {
  /* The intention's hard line for this half, taken once per endpoint instead of once for all of them:
   * `read` used to be the only one with a reading, so a `.canonicalRoot()` slipped into any other
   * stayed green. The alias is a directory junction over the same tree, so every read succeeds either
   * way — the string each endpoint answers with is what tells the two halves apart.
   *
   * Five cells, one per endpoint that hands its root back out. The sixth (`openNodeSession`) is
   * covered by the note at its cell below: it hands its root straight to the relay, which canonicalises
   * on the very next line by design, so the two halves write the same answer there and no assertion
   * could tell them apart. That line is pinned where it lives (`host-relay`), not here. */
  const real = syntheticWorkspace()
  const alias = join(tmpdir(), `superworker-gateway-alias-${process.pid}-${Math.random().toString(16).slice(2)}`)
  symlinkSync(real, alias, 'junction')
  const agents = fakeAgents()
  const { ctx, call, gateway } = await liveGateway(alias, { records: real, agents: agents.registry })
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  try {
    const read = await call('read', { sessionId: 's1', workspaceRoot: alias })
    assert.equal(read.ok, true, String(read.message))
    assert.equal(read.value.workspaceRoot, alias, 'read did not answer the caller\'s spelling')

    const stream = await gateway.stream({ namespace: 'superworker', method: 'watch', args: { sessionId: 's1', workspaceRoot: alias }, peer })
    let first
    for await (const frame of stream) { first = frame; break }
    assert.ok(first !== undefined, 'the channel sent no first frame')
    assert.equal(first.workspaceRoot, alias, 'watch did not answer the caller\'s spelling')

    const config = await call('readConfig', { sessionId: 's1', workspaceRoot: alias })
    assert.equal(config.ok, true, String(config.message))
    assert.equal(config.value.workspaceRoot, alias, 'readConfig did not answer the caller\'s spelling')

    const sessions = await call('readSessions', { sessionId: 's1', workspaceRoot: alias })
    assert.equal(sessions.ok, true, String(sessions.message))
    assert.equal(sessions.value.workspaceRoot, alias, 'readSessions did not answer the caller\'s spelling')

    /* The write path, judged on the words' own refusal: a record that was never init-ed makes the
     * engine name the root it acted on, and that string is whatever the gateway handed over. */
    const refused = await call('setConfig', { sessionId: 's1', workspaceRoot: alias, key: 'test_tier', value: 'minimal' })
    assert.equal(refused.ok, true, String(refused.message))
    assert.equal(refused.value.ok, false, 'a record with no layout files must be refused')
    assert.ok(
      String(refused.value.detail ?? '').includes(alias),
      `the write path did not act on the caller's spelling: ${String(refused.value.detail)}`,
    )

    /* The opener: its root goes straight into the relay, which canonicalises on the very next line by
     * design — so the session, the claim and the `create()` cwd are the same whichever half this
     * endpoint passed. The one thing the endpoint itself does with the string is stir the pump after
     * the dispatch, and the pump is keyed by the root a follower subscribed at (`watch` answers the
     * caller's spelling too). So the stir is where this cell reads: a follower at the alias is only
     * woken by a stir at the alias. */
    const stirred = []
    const realStir = RecordsPump.prototype.stir
    RecordsPump.prototype.stir = function patchedStir(root) {
      stirred.push(root)
      return realStir.call(this, root)
    }
    try {
      const opened = await call('openNodeSession', { sessionId: 's1', workspaceRoot: alias, cycle: 'line-1', node: 'n-1' })
      assert.equal(opened.ok, true, String(opened.message))
    } finally {
      RecordsPump.prototype.stir = realStir
    }
    assert.deepEqual(stirred, [alias], 'the opener stirred the pump at a spelling other than the caller\'s')
  } finally {
    await ctx.stop?.()
    rmSync(alias, { recursive: true, force: true })
    rmSync(real, { recursive: true, force: true })
  }
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

/* ---- the write doors: the root the caller named, told apart from its neighbours ---- */

/**
 * The panel's write doors, and the root each one acts on.
 *
 * Three endpoints on this half turn a browser's root into a **write**: `addInstruction`, the single
 * private write path `#superworker` (which `setConfig` and the four instruction verbs all walk), and
 * `openNodeSession`. Until this round no case proved any of them used the root it was handed: the
 * gateway's own rig compressed the session root, the sandbox root and the caller's root into one
 * string (`liveGateway(alias, …)`), so "used the caller's root" and "fell back to this session's own
 * root" **answered the same string** and a `named` dropped from any of the three stayed green across
 * the whole suite (review-5's C1, measured there as three mutations, 108/108 green).
 *
 * Each case below builds three distinct real record trees and asks the verb to act on the third. The
 * reading is which tree's **files changed** — the only thing that can answer "where did this write
 * land" — and the door's own answer is asserted beside it, so no cell is a file read standing in for
 * an endpoint that never ran.
 *
 * The three branches a compressed fixture could not separate, and what each reads here:
 *
 * - the root the caller named → `named`'s record moves;
 * - this session's own root → `own`'s record moves, and `named`'s does not;
 * - the sandbox policy's root → `sandbox`'s record moves, which is the last step of the seam's order
 *   and the branch a widened fallback would take without any wrapper spelling `named` at all.
 */
test('The record-an-instruction door writes on the root the caller named, not on this session\'s own', { skip: !wired }, async () => {
  const rig = await writeRig()
  const { ctx, call, own, sandbox, named } = rig
  try {
    const answer = await call('addInstruction', {
      sessionId: 's1',
      workspaceRoot: named,
      text: 'look at the record before acting & do not guess',
      scope: 'global',
      cycle: '',
    })
    assert.equal(answer.ok, true, String(answer.message))
    /* The door's own answer names the entry it minted — not a literal, and not a file read. */
    assert.equal(answer.value.ok, true, `the words refused the sentence: ${String(answer.value.detail)}`)
    const minted = /^INSTRUCTION (i-\d+):/u.exec(String(answer.value.text))
    assert.ok(minted !== null, `the door did not report the entry it minted: ${String(answer.value.text)}`)

    const id = minted[1]
    assert.deepEqual(
      recordsOf(named).instructions,
      ['i-1:live', 'i-2:withdrawn', `${id}:live`],
      'the sentence did not land on the root the caller named',
    )
    assert.deepEqual(
      recordsOf(own).instructions,
      ['i-1:live', 'i-2:withdrawn'],
      'the sentence also landed on this session\'s own tree — the branch a dropped `named` takes',
    )
    assert.deepEqual(
      recordsOf(sandbox).instructions,
      ['i-1:live', 'i-2:withdrawn'],
      'the sentence landed on the sandbox policy\'s tree, which is the seam\'s last fallback step',
    )

    /* The control that makes the cell a reading of the root and not of the tree it happened to reach:
     * the same door, handed this session's own root, writes there. So both trees are writable, and the
     * cell above is about which one the door picked. */
    const second = await call('addInstruction', {
      sessionId: 's1',
      workspaceRoot: own,
      text: 'a sentence bound for this session\'s own tree',
      scope: 'global',
      cycle: '',
    })
    assert.equal(second.ok, true, String(second.message))
    assert.equal(second.value.ok, true, `the words refused the control sentence: ${String(second.value.detail)}`)
    assert.equal(recordsOf(own).instructions.length, 3, 'the control did not write on the root it was handed, so the cell above proves nothing')
  } finally {
    await ctx.stop?.()
    for (const root of [own, sandbox, named]) rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The shared write path, one cell per verb: `setConfig` and the four instruction verbs all enter
 * `#superworker`, so a `named` dropped there breaks all five at once — and the four instruction verbs
 * used to be asked only with `''`, which is "not a name" at this door and therefore exercises the
 * fallback rather than the branch under judgement.
 *
 * One rig, five cells, five different writes: each asserts the verb's **own** answer (the entry or the
 * setting it named, never a literal), and the landing spot on the three trees. `archive` acts on the
 * live `i-1` and `revive` on the withdrawn `i-2`, which is why the fixture carries both.
 */
test('The shared write path acts on the root each instruction verb was handed: five verbs, five cells, one rig', { skip: !wired }, async () => {
  const rig = await writeRig()
  const { ctx, call, own, sandbox, named, agents } = rig
  const untouched = () => ['i-1:live', 'i-2:withdrawn']
  try {
    /* 1. `setConfig`: the project settings file is the verb's landing spot, and the answer names it. */
    const written = await call('setConfig', { sessionId: 's1', workspaceRoot: named, key: 'test_tier', value: 'minimal' })
    assert.equal(written.ok, true, String(written.message))
    assert.equal(written.value.ok, true, `the words refused the setting: ${String(written.value.detail)}`)
    assert.match(String(written.value.text), /test_tier = minimal/u, `the door did not report the setting it wrote: ${String(written.value.text)}`)
    assert.deepEqual(recordsOf(named).config, { test_tier: 'minimal' }, 'the setting did not land on the root the caller named')
    assert.deepEqual(recordsOf(own).config, {}, 'the setting also landed on this session\'s own tree')
    assert.deepEqual(recordsOf(sandbox).config, {}, 'the setting landed on the sandbox policy\'s tree')

    /* 2. `archiveInstruction`: the live entry moves to `withdrawn`, and the answer is the move. */
    const archived = await call('archiveInstruction', { sessionId: 's1', workspaceRoot: named, id: 'i-1' })
    assert.equal(archived.ok, true, String(archived.message))
    assert.equal(archived.value.ok, true, `the words refused the archive: ${String(archived.value.detail)}`)
    assert.match(String(archived.value.text), /INSTRUCTION i-1 → withdrawn/u, `the door did not report the move it made: ${String(archived.value.text)}`)
    assert.deepEqual(recordsOf(named).instructions, ['i-1:withdrawn', 'i-2:withdrawn'], 'the archive did not land on the root the caller named')
    assert.deepEqual(recordsOf(own).instructions, untouched(), 'the archive also landed on this session\'s own tree')

    /* 3. `reviveInstruction`: the withdrawn entry comes back, and the answer is the coming back. */
    const revived = await call('reviveInstruction', { sessionId: 's1', workspaceRoot: named, id: 'i-2' })
    assert.equal(revived.ok, true, String(revived.message))
    assert.equal(revived.value.ok, true, `the words refused the revive: ${String(revived.value.detail)}`)
    assert.match(String(revived.value.text), /INSTRUCTION i-2 → live/u, `the door did not report the move it made: ${String(revived.value.text)}`)
    assert.deepEqual(recordsOf(named).instructions, ['i-1:withdrawn', 'i-2:live'], 'the revive did not land on the root the caller named')
    assert.deepEqual(recordsOf(own).instructions, untouched(), 'the revive also landed on this session\'s own tree')

    /* 4. `removeInstruction`: the entry goes and the tombstone keeps its id — both readings, on the
     *    same tree, because a removal is the one verb with two facts to land. */
    const removed = await call('removeInstruction', { sessionId: 's1', workspaceRoot: named, id: 'i-1' })
    assert.equal(removed.ok, true, String(removed.message))
    assert.equal(removed.value.ok, true, `the words refused the removal: ${String(removed.value.detail)}`)
    assert.match(String(removed.value.text), /REMOVED i-1/u, `the door did not report the removal it made: ${String(removed.value.text)}`)
    assert.deepEqual(recordsOf(named).instructions, ['i-2:live'], 'the removal did not land on the root the caller named')
    assert.deepEqual(recordsOf(named).removed, ['i-1'], 'the removal left no tombstone on the root the caller named')
    assert.deepEqual(recordsOf(own).instructions, untouched(), 'the removal also landed on this session\'s own tree')

    /* 5. `addInstruction`: the fifth verb on the same path. Its own answer names the entry it minted,
     *    and that entry lands on `named` — the byte-identical sentence shape as the door's own case
     *    above, taken here so all five verbs sharing `#superworker` are in one table. */
    const added = await call('addInstruction', { sessionId: 's1', workspaceRoot: named, text: 'the fifth verb of the shared path', scope: 'global', cycle: '' })
    assert.equal(added.ok, true, String(added.message))
    assert.equal(added.value.ok, true, `the words refused the sentence: ${String(added.value.detail)}`)
    const minted = /^INSTRUCTION (i-\d+):/u.exec(String(added.value.text))
    assert.ok(minted !== null, `the door did not report the entry it minted: ${String(added.value.text)}`)
    assert.deepEqual(
      recordsOf(named).instructions,
      ['i-2:live', `${minted[1]}:live`],
      'the added sentence did not land on the root the caller named',
    )
    assert.deepEqual(recordsOf(own).instructions, untouched(), 'the added sentence also landed on this session\'s own tree')

    /* The refusal gate: a sentence the endpoint composes into nothing is refused before any write, and
     * the refusal code is the endpoint's own answer — never a `tool-refused` from the words layer,
     * because nothing was handed over. None of the three trees may move meanwhile. */
    const before = [recordsOf(own).instructions, recordsOf(sandbox).instructions, recordsOf(named).instructions]
    const refused = await call('addInstruction', { sessionId: 's1', workspaceRoot: named, text: '   ', scope: 'global', cycle: '' })
    assert.equal(refused.ok, true, String(refused.message))
    assert.equal(refused.value.ok, false, 'an empty sentence must be refused before any write')
    assert.equal(refused.value.code, 'empty-text', `the refusal code is the endpoint's own answer: ${JSON.stringify(refused.value)}`)
    assert.deepEqual(
      [recordsOf(own).instructions, recordsOf(sandbox).instructions, recordsOf(named).instructions],
      before,
      'a refused sentence wrote to a record anyway',
    )

    /* The writable control: the opener's own door has already marked three sessions, so this rig's
     * registry is live; the four verbs above each answered `ok` on `named`, so the trees are all
     * writable. What remains to check is that `named` was not reached by accident — the sandbox tree
     * never moved at all. */
    assert.deepEqual(recordsOf(sandbox), { instructions: untouched(), removed: [], config: {}, claim: false }, 'the sandbox policy\'s tree was written to by a door that was handed a root')
    assert.equal(agents.created.length, 0, 'none of the five write verbs may mint a session')
  } finally {
    await ctx.stop?.()
    for (const root of [own, sandbox, named]) rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The opener's own door: `openNodeSession` hands its root to the relay, which canonicalises on the
 * next line, so the two branches cannot be told apart by the **spelling** it hands out — they are told
 * apart by the tree the session is created in and by the tree the `started` claim lands on.
 *
 * Both halves are read on three distinct trees: a door that used the root it was handed mints in
 * `named` and lands the claim there; a door that fell back to this session's own root mints in `own`
 * and lands the claim there. Each cell also asserts the door's own answer (`ok` and a session id),
 * so the reading is the opener's, not the files'.
 */
test('The opener door opens on the root the caller named: whose tree gets the session and whose tree gets the claim', { skip: !wired }, async () => {
  const rig = await writeRig()
  const { ctx, call, own, sandbox, named, agents } = rig
  try {
    const answer = await call('openNodeSession', { sessionId: 's1', workspaceRoot: named, cycle: 'c-1', node: 'n-1' })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.ok, true, `the opener refused a cell it should open: ${JSON.stringify(answer.value)}`)
    assert.equal(typeof answer.value.session, 'string', 'the door did not report the session it minted')

    /* The session itself: created in the tree the caller named, in the one canonical spelling. */
    assert.equal(agents.created.length, 1, 'the door minted no session, so there is nothing to judge')
    assert.equal(agents.created[0].options.meta.cwd, realpathSync(named), 'the session was created somewhere other than the root the caller named, or in more than one spelling of it')

    /* The marks that outlive the call: the claim on `named`, nothing on the other two. */
    assert.equal(recordsOf(named).claim, true, 'the claim did not land on the root the caller named')
    assert.equal(recordsOf(own).claim, false, 'the claim landed on this session\'s own tree — the branch a dropped `named` takes')
    assert.equal(recordsOf(sandbox).claim, false, 'the claim landed on the sandbox policy\'s tree, the seam\'s last fallback step')

    /* The control: the same door handed this session's own root mints there and lands the claim
     * there, so both cells are readings of which root the door picked and not of which tree can be
     * opened at all. */
    const control = await call('openNodeSession', { sessionId: 's1', workspaceRoot: own, cycle: 'c-1', node: 'n-1' })
    assert.equal(control.ok, true, String(control.message))
    assert.equal(control.value.ok, true, `the control open was refused: ${JSON.stringify(control.value)}`)
    assert.equal(agents.created.length, 2, 'the control opened no session, so the cell above proves nothing')
    assert.equal(agents.created[1].options.meta.cwd, realpathSync(own), 'the control did not open at the root it was handed')
    assert.equal(recordsOf(own).claim, true, 'the control did not land its claim on the root it was handed')
  } finally {
    await ctx.stop?.()
    for (const root of [own, sandbox, named]) rmSync(root, { recursive: true, force: true })
  }
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
    assert.deepEqual(
      listed.value.entries['test_tier']?.options,
      declaredOptions()['test_tier'],
      'the declaration\'s candidates survive the wire: the panel reads them off this reading',
    )
    const written = await call('setConfig', { sessionId: 's1', workspaceRoot: '', key: 'test_tier', value: 'minimal' })
    assert.equal(written.ok, true, String(written.message))
  } finally {
    await ctx.stop?.()
  }
})