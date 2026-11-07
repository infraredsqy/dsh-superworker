/* The host half's dispatch relay: the one path the panel's button and the
 * automatic trigger both walk, and the three facts it guarantees.
 *
 * The dispatch runs against the real engine (`pf-core`, in process) over a
 * real record directory in a temporary root: the engine lands the prompt and
 * the run doc, the opener creates the session over stand-ins for the host's
 * session side, and the `started` claim must be on disk before the answer
 * comes back. The cases here judge the guarantees, not the engine: the claim
 * lands with the dispatch, two concurrent dispatches for one cell open one
 * session, a tracked session's turn end fires the relay only when the plan
 * says `dispatch`, the switch turns the trigger off and is read live, and the
 * gateway's button endpoint leaves the same marks as the relay.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchCell, installRelay } from '../src/host/relay.ts'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { PANEL_PREF_FIELDS } from '../src/host/settings-fields.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { drainFor, until } from './helpers/wait.mjs'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'

/* The engine reads this machine's layer (`<home>/.pf/config.json`) during
 * dispatch preparation; these cases pin it to a temporary home, never the
 * machine's own. The opener's skill-placement read rides the same pin. */
const pinned = pinHome(['PF_HOME_DIR', 'DSH_HOME'], 'pf-relay-home-')
test.after(pinned.restore)

/** A real workspace root with a real `.pf` in it: the four layout files, the graph, and one active line holding `holding`. */
function rigRecordRoot(holding) {
  const root = mkdtempSync(join(tmpdir(), 'pf-relay-ws-'))
  mkdirSync(join(root, '.pf'), { recursive: true })
  writeFileSync(join(root, '.pf', '.gitignore'), '*\n')
  writeFileSync(join(root, '.pf', '.gitattributes'), '* text=auto\n')
  writeFileSync(join(root, '.pf', 'AGENTS.md'), '# records\n')
  writeFileSync(join(root, '.pf', 'config.json'), '{}\n')
  const nodes = {
    'n-1': { status: 'todo', title: 'first', mode: 'auto', dependencies: [] },
    'n-2': { status: 'todo', title: 'second', mode: 'auto', dependencies: [] },
  }
  writeFileSync(join(root, '.pf', 'ideas.json'), JSON.stringify({ nodes }))
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({
    cycles: [{ id: 'c-1', status: 'active', tags: [], holding: holding.map((id) => ({ id, since: '2026-10-18T00:00:00Z' })), path: [] }],
  }))
  return root
}

/** The claim a dispatch leaves, as it is on disk. */
const claimPath = (root, cycle, node) => join(root, '.pf', 'meta', 'launch', cycle, node, 'started')

/** Settle the records the way a close leaves them: the closed node delivered, the next one pinned in hand. */
async function settleClose(root, closed, next) {
  const ideas = JSON.parse(await readFile(join(root, '.pf', 'ideas.json'), 'utf8'))
  ideas.nodes[closed].status = 'completed'
  await writeFile(join(root, '.pf', 'ideas.json'), JSON.stringify(ideas))
  const state = JSON.parse(await readFile(join(root, '.pf', 'state.json'), 'utf8'))
  state.cycles[0].holding = [{ id: next, since: '2026-10-18T00:01:00Z' }]
  await writeFile(join(root, '.pf', 'state.json'), JSON.stringify(state))
}

/** The negative wait behind the `wait` assertions: the shared drain (see `helpers/wait.mjs`) — it only ever disproves. */
const drain = () => drainFor()

/** The session-side stand-in: every create is recorded; each agent settles its opening round on the spot. With `idleGate`, the opening round's settlement waits for the gate — the in-flight shape a long first round produces. */
function fakeAgents({ idleGate } = {}) {
  const created = []
  return {
    created,
    registry: {
      create(options) {
        const record = { options, followups: [] }
        created.push(record)
        const agent = {
          sessionId: options.sessionId,
          status: 'idle',
          followup(message) { record.followups.push(message) },
          whenIdle: idleGate ? () => idleGate : () => Promise.resolve(),
        }
        record.agent = agent
        return Promise.resolve({ agent, dispose: async () => {} })
      },
    },
  }
}

/** A workspace-files port that reads the real record directory, the way the real gateway does. */
function fsPort(root, seen) {
  return {
    async list(scope, dir) {
      /* The scope the engine read through is the reading this port keeps: the opener resolves the
       * record off `scope.workspaceRoot`, so a call that skips canonicalising shows up here. */
      const base = scope?.workspaceRoot ?? root
      if (seen !== undefined) seen.push(base)
      let entries
      try {
        entries = readdirSync(join(base, dir), { withFileTypes: true })
      } catch {
        throw absentError(dir)
      }
      return {
        path: dir,
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        })),
        truncated: false,
      }
    },
    async read(scope, path, range) {
      const base = scope?.workspaceRoot ?? root
      if (seen !== undefined) seen.push(base)
      let text
      try {
        text = await readFile(join(base, path), 'utf8')
      } catch {
        throw absentError(path)
      }
      /* The real gateway moves lines, not bytes: a Windows CRLF record arrives
       * with its carriers stripped, so the prompt line arrives bare. */
      return readPage(text.split('\r\n').join('\n'), range)
    },
  }
}

/** The host context stand-in: the real record directory behind the port, the live session header naming it, an event bus, a logger the relay's refusals land on, and the settings surface the switch is read from (the object is shared, so a flip is seen live). `seen` collects every workspace root the port was read through. */
function context({ root, agents, config, seen } = {}) {
  return fakeContext({
    port: fsPort(root, seen),
    sessionCwd: root,
    sandboxRoot: root,
    config,
    bus: true,
    logger: true,
    services: { sessions: {}, agents: agents.registry },
  })
}

test('Dispatch lands the claim: the session opens, the started marker is on disk, and the note lands too', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = context({ root, agents })
  try {
    const outcome = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(agents.created.length, 1, 'exactly one session')
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-1')), 'the claim lands with the dispatch')
    assert.ok(existsSync(join(root, '.pf', 'meta', 'sessions', 'n-1.json')), 'the note is written by the opener')
    const said = agents.created[0].followups[0]
    assert.ok(existsSync(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt')), 'the prompt is landed by dispatch preparation')
    /* The first instruction is judged against the artifact on disk, not against pf-core wording: the opener
     * sends the very line dispatch preparation landed in prompt.txt, so reading that back is comparison
     * enough — the identity (node id, [pipeline]) is locked by the artifact. */
    const prompt = (await readFile(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt'), 'utf8')).trim()
    assert.equal(said.content[0].text, prompt, 'the first instruction is the dispatch prompt on disk')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Two dispatches at once open one session: the second call reads the claim and builds no second one', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = context({ root, agents })
  try {
    const [one, two] = await Promise.all([
      dispatchCell(ctx, 'caller', root, 'c-1', 'n-1'),
      dispatchCell(ctx, 'caller', root, 'c-1', 'n-1'),
    ])
    assert.equal(one.ok, true, JSON.stringify(one))
    assert.equal(two.ok, true, JSON.stringify(two))
    assert.equal(agents.created.length, 1, 'one cell dispatched twice at once, exactly one session')
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-1')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Trigger: the session it opened closes, the plan says dispatch, and the next leg opens itself', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    /* The first leg is opened through the button path: the session enters the host's own tracking table. */
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(agents.created.length, 1)

    /* A turn end mid-close: the claim is on disk, the plan says wait, no next leg opens. */
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await drain()
    assert.equal(agents.created.length, 1, 'nothing opens while the plan says wait')

    /* The close lands (the node closed, the next cell pinned in hand): graph and line are in their post-close shape. */
    await settleClose(root, 'n-1', 'n-2')

    /* A turn end after the close: the plan says dispatch, the next leg opens itself, no button anywhere. */
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      'the next leg\'s session and its claim',
      warnings,
    )
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-2')), 'the next leg\'s claim lands with the dispatch')
    const second = agents.created[1]
    const promptNext = (await readFile(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-2', 'prompt.txt'), 'utf8')).trim()
    assert.equal(second.followups[0].content[0].text, promptNext, 'the next leg\'s first instruction is the dispatch prompt on disk')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Dispose trigger: with the plan saying wait, a disposed session still opens nothing (the verdict is unchanged)', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(agents.created.length, 1)

    /* The claim is on disk and the cell has not closed: the plan says wait. A session disposed now must not decide for it. */
    events.emit('session/disposed', { id: first.session })
    await drain()
    assert.equal(agents.created.length, 1, 'a dispose opens no next leg while the plan says wait')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Dispose trigger: the session is disposed before its turn ends, and the next leg still opens when the plan says dispatch', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(agents.created.length, 1)

    /* The close lands, but this leg was stopped or crashed: no turn/end to hear, only the host saying the session is gone. */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/disposed', { id: first.session })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      'the next leg opened after the dispose and its claim',
      warnings,
    )
    const second = agents.created[1]
    const promptNext = (await readFile(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-2', 'prompt.txt'), 'utf8')).trim()
    assert.equal(second.followups[0].content[0].text, promptNext, 'the next leg\'s first instruction is the dispatch prompt on disk')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Dispose trigger: a session this host did not open is disposed, and nothing opens', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    await settleClose(root, 'n-1', 'n-2')
    /* The plan would say dispatch now, but this id is not in this host's tracking table: not its business. */
    events.emit('session/disposed', { id: 'session-someone-else' })
    await drain()
    assert.equal(agents.created.length, 1, 'someone else\'s session is gone, this host does not open along with it')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Both notices arrive: the turn end already opened the next leg, and the same session\'s dispose opens no third', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    await settleClose(root, 'n-1', 'n-2')

    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      'the next leg opened by the turn end and its claim',
      warnings,
    )

    /* The same session is disposed afterwards: the plan is re-read, the claim is already on disk, and the duplicate start stops itself. */
    events.emit('session/disposed', { id: first.session })
    await drain()
    assert.equal(agents.created.length, 2, 'two notices push one leg only')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Registered before the turn ends: while this leg is in flight its turn/end must already reach the relay (long first round)', async () => {
  const root = rigRecordRoot(['n-1'])
  let releaseIdle
  const idleGate = new Promise((give) => { releaseIdle = give })
  const agents = fakeAgents({ idleGate })
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    /* The first leg is in flight: the first instruction is in, the turn is held on the gate — dispatch has not returned yet. */
    const pending = dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    await until(
      () => agents.created.length >= 1 && agents.created[0].followups.length === 1,
      'the first instruction is in',
      warnings,
    )
    const sid = agents.created[0].options.sessionId

    /* The close lands while this leg is in flight and the turn end arrives: tracked must be registered by now, or the relay cannot open the next leg. */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: sid }, { type: 'turn/end' })

    /* The next leg queues behind this one (a process-level serial chain); release the turn, this leg returns, and the relay leg lands only then. */
    releaseIdle()
    const first = await pending
    assert.equal(first.ok, true, JSON.stringify(first))
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      'the next leg\'s session and its claim',
      warnings,
    )
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-2')), 'the next leg\'s claim lands with the dispatch')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Switch off: a turn/end opens no next leg; switched on, the same event opens it, and the button path is not under the switch', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  /* The line's resolved config rides apply's second argument; the volatile
   * field arrives as a stable reference whose get() answers the snapshot —
   * the shape the real host hands over, pinned here. */
  let snapshot = false
  const config = { [PANEL_PREF_FIELDS.autoRelay]: { get: () => snapshot } }
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx, config)
  try {
    /* The button path is not under the switch: the first leg opens as usual and the session enters the tracking table. */
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(agents.created.length, 1)

    /* The close lands: the plan would say dispatch now — but the switch is off. */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await drain()
    assert.equal(agents.created.length, 1, 'switch off, the trigger opens no session')

    /* The switch snapshot flips on: the next turn end relays as usual — it reads the snapshot of the moment, no reload. */
    snapshot = true
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      'the next leg opened once the switch is on and its claim',
      warnings,
    )
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('The button walks the same path: the gateway\'s openNodeSession endpoint lands the claim too', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = context({ root, agents })
  try {
    const gateway = new PathfinderRecordsGateway(ctx)
    const outcome = await gateway.openNodeSession('caller', '', 'c-1', 'n-1')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(agents.created.length, 1)
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-1')), 'a dispatch through the button lands the claim on disk too')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A cell dispatch that fails: the refusal carries the engine\'s words, no claim lands, no session built', async () => {
  const root = rigRecordRoot([])
  const agents = fakeAgents()
  const { ctx } = context({ root, agents })
  try {
    const outcome = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'dispatch-refused')
    assert.ok((outcome.detail ?? '').length > 0, 'the refusal carries the engine\'s own words')
    assert.equal(agents.created.length, 0)
    assert.ok(!existsSync(claimPath(root, 'c-1', 'n-1')), 'no session, no claim')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* This reading is held up by two canonicalisations together: the relay entry, and the opener (which takes
 * the real path again inside `openNodeSession`). Pull only the relay one and the case stays green — it has
 * no independent reading of that relay line (known untested); pull both and it goes red. The case name says
 * only what is read off disk: the engine reads the record by real path, not that the relay line is pinned on its own. */
test('A dispatch through the alias opens as usual, and the engine reads the record by real path (held by both canonicalisations, no independent reading of the relay one)', async () => {
  const root = rigRecordRoot(['n-1'])
  const alias = join(tmpdir(), `pf-relay-alias-${randomUUID()}`)
  symlinkSync(root, alias, 'junction')
  const seen = []
  const agents = fakeAgents()
  const { ctx } = context({ root, agents, seen })
  const real = realpathSync(root)
  try {
    const outcome = await dispatchCell(ctx, 'caller', alias, 'c-1', 'n-1')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.ok(seen.length > 0, 'the dispatch read the prompt in: these reads are where this reading comes from')
    assert.deepEqual(
      [...new Set(seen)],
      [real],
      'the root the entry chain hands the engine is the real path: both reads land on it, not one of them by the caller spelling',
    )
    assert.ok(existsSync(claimPath(real, 'c-1', 'n-1')), 'the claim lands on the real-path tree')
  } finally {
    rmSync(alias, { recursive: true, force: true })
    assert.ok(existsSync(root), 'removing the alias does not take the root it points at')
  }
})
