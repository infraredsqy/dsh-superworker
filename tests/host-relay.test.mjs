/* The host half's dispatch relay: the one path the panel's button and the
 * automatic trigger both walk, and the three facts it guarantees.
 *
 * The dispatch runs against the real engine (`superworker-core`, in process) over a
 * real record directory in a temporary root: the engine lands the prompt and
 * the run doc, the opener creates the session over stand-ins for the host's
 * session side, and the `started` claim must be on disk before the answer
 * comes back. The cases here judge the guarantees, not the engine: the claim
 * lands with the dispatch, two concurrent dispatches for one cell open one
 * session, a session is remembered at its mint — before any turn of its can
 * end — a tracked session's turn end fires the relay only when the plan
 * says `dispatch`, the switch turns the trigger off and is read live, and the
 * gateway's button endpoint leaves the same marks as the relay.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, promises as fsp, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from 'superworker-core'
import { dispatchCell, installRelay, trackedExecutorOf } from '../src/host/relay.ts'
import { SuperworkerRecordsGateway } from '../src/host/gateway.ts'
import { PANEL_PREF_FIELDS } from '../src/host/settings-fields.ts'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'
import { fakeAgents } from './helpers/agents-registry.mjs'
import { pinHome } from './helpers/env.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { clearPlacement, placeOneSkill } from './helpers/skill-placement.mjs'
import { drainFor, until } from './helpers/wait.mjs'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'

/* The engine reads this machine's layer (`<home>/.superworker/config.json`) during
 * dispatch preparation; these cases pin it to a temporary home, never the
 * machine's own. The opener's skill-placement read rides the same pin. */
const pinned = pinHome(['SUPERWORKER_HOME_DIR', 'DSH_HOME'], 'superworker-relay-home-')
test.after(pinned.restore)

/** A real workspace root with a real `.superworker` in it: the four layout files, the graph, and one active line holding `holding`. Every id in `holding` is a node on the graph, so a case may hold as many cells as it means to run through. */
function rigRecordRoot(holding) {
  const root = mkdtempSync(join(tmpdir(), 'superworker-relay-ws-'))
  mkdirSync(join(root, '.superworker'), { recursive: true })
  writeFileSync(join(root, '.superworker', '.gitignore'), '*\n')
  writeFileSync(join(root, '.superworker', '.gitattributes'), '* text=auto\n')
  writeFileSync(join(root, '.superworker', 'AGENTS.md'), '# records\n')
  writeFileSync(join(root, '.superworker', 'config.json'), '{}\n')
  const nodes = {}
  for (const id of [...new Set(['n-1', 'n-2', ...holding])]) {
    nodes[id] = { status: 'todo', title: `cell ${id}`, mode: 'auto', dependencies: [] }
  }
  writeFileSync(join(root, '.superworker', 'ideas.json'), JSON.stringify({ nodes }))
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({
    cycles: [{ id: 'c-1', tags: [], holding: holding.map((id) => ({ id, since: '2026-10-18T00:00:00Z' })), path: [] }],
  }))
  return root
}

/** The claim a dispatch leaves, as it is on disk. */
const claimPath = (root, cycle, node) => join(root, '.superworker', 'meta', 'launch', cycle, node, 'started')

/** Settle the records the way a close leaves them: the closed node delivered, the next one pinned in hand. */
async function settleClose(root, closed, next) {
  const ideas = JSON.parse(await readFile(join(root, '.superworker', 'ideas.json'), 'utf8'))
  ideas.nodes[closed].status = 'completed'
  await writeFile(join(root, '.superworker', 'ideas.json'), JSON.stringify(ideas))
  const state = JSON.parse(await readFile(join(root, '.superworker', 'state.json'), 'utf8'))
  state.cycles[0].holding = [{ id: next, since: '2026-10-18T00:01:00Z' }]
  await writeFile(join(root, '.superworker', 'state.json'), JSON.stringify(state))
}

/** The negative wait behind the `wait` assertions: the shared drain (see `helpers/wait.mjs`) — it only ever disproves. */
const drain = () => drainFor()

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

/** The host context stand-in: the real record directory behind the port, the live session header naming it, an event bus, a logger the relay's refusals land on, and the settings surface the switch is read from (the object is shared, so a flip is seen live). `seen` collects every workspace root the port was read through. `skills` is the catalog the opener reads back, when a case needs to hold an open past its mint. `cwd` is the spelling the live session header carries, when a case needs it to differ from the record's own path. */
function context({ root, agents, config, seen, skills, cwd = root } = {}) {
  return fakeContext({
    port: fsPort(root, seen),
    sessionCwd: cwd,
    sandboxRoot: cwd,
    config,
    bus: true,
    logger: true,
    services: { sessions: {}, agents: agents.registry, ...(skills === undefined ? {} : { skills }) },
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
    assert.ok(existsSync(join(root, '.superworker', 'meta', 'sessions', 'n-1.json')), 'the note is written by the opener')
    const said = agents.created[0].followups[0]
    assert.ok(existsSync(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt')), 'the prompt is landed by dispatch preparation')
    /* The first instruction is judged against the artifact on disk, not against superworker-core wording: the opener
     * sends the very line dispatch preparation landed in prompt.txt, so reading that back is comparison
     * enough — the identity (node id, [pipeline]) is locked by the artifact. */
    const prompt = (await readFile(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt'), 'utf8')).trim()
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
    const promptNext = (await readFile(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-2', 'prompt.txt'), 'utf8')).trim()
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
    const promptNext = (await readFile(join(root, '.superworker', 'meta', 'launch', 'c-1', 'n-2', 'prompt.txt'), 'utf8')).trim()
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

test('Registered at the mint: a turn/end that arrives before this leg has answered still reaches the relay', async (t) => {
  /* The open answers as soon as the session is out, so the stretch a case can hold it in is the one
   * between the mint and that answer — here the placement catalog the opener reads back, which is
   * the shape any real IO in that stretch has. */
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`needs process isolation: DSH_HOME was overwritten in the shared process by another test file's pin (now points at ${process.env.DSH_HOME}, not this file's ${pinned.home})`)
    return
  }
  const name = 'sw-issue-repair'
  placeOneSkill(pinned.home, name)
  const root = rigRecordRoot(['n-1'])
  let releaseCatalog
  const catalogGate = new Promise((give) => { releaseCatalog = give })
  let readStarted
  const readReached = new Promise((give) => { readStarted = give })
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({
    root,
    agents,
    skills: {
      async list() {
        readStarted()
        await catalogGate
        return []
      },
    },
  })
  const installOff = installRelay(ctx)
  try {
    const pending = dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    /* The session is minted and its first instruction is in: this leg has not answered yet, and it
     * will not until the catalog read below is let through. */
    await until(
      () => agents.created.length >= 1 && agents.created[0].followups.length === 1,
      'the first instruction is in',
      warnings,
    )
    await readReached
    const sid = agents.created[0].options.sessionId

    /* The close lands while this leg is in flight and the turn end arrives: the session must be in
     * the tracking table by now, or the relay cannot open the next leg. */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: sid }, { type: 'turn/end' })

    /* The next leg queues behind this one (a process-level serial chain); release the read, this leg
     * answers, and the relay leg lands only then. */
    releaseCatalog()
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
    clearPlacement(pinned.home)
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

/* The relay's trigger settles the root it was handed before it hands it to the engine, and this is the
 * one reading that pins that line on its own.
 *
 * The table can hold a non-canonical spelling: a session the agent-facing tool opened is remembered
 * under the spelling its caller used (`trackedExecutorOf` is handed that one), while a dispatch
 * writes the canonical one in. `judge` is where that spelling is settled, and its answer is what the
 * next leg of the line is remembered under.
 *
 * The alias junction is **removed between the two rounds** on purpose. After round one the only thing
 * that says which spelling the trigger carried the line at is the table: `real` if it canonicalised,
 * the alias if it did not. Deleting the alias makes those two cases tell apart — the canonical entry
 * still resolves, the caller's spelling is a path that no longer exists, so a trigger that did not
 * canonicalise has nowhere to carry the line and opens nothing. That is what makes this red on a
 * missing third leg rather than on a string this test cannot see. */
test('The trigger settles the root it was handed: the leg it carries is remembered at the real path', async () => {
  const root = rigRecordRoot(['n-1', 'n-2', 'n-3'])
  const alias = join(tmpdir(), `superworker-relay-judge-${randomUUID()}`)
  symlinkSync(root, alias, 'junction')
  const real = realpathSync(root)
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    /* Round one, opened the way the agent-facing tool opens one: through `trackedExecutorOf`, at the
     * caller's spelling. That is the only road that puts a non-canonical spelling in the table. */
    const executor = trackedExecutorOf(ctx, 'caller', alias)
    const first = await open(alias, { executor, pluginsDir: shippedPluginsDir() }).conductor.dispatch({ cycle: 'c-1', node: 'n-1' })
    assert.equal(first.action, 'opened', JSON.stringify(first))
    const sid = first.session.sessionId
    assert.equal(agents.created.length, 1)

    /* The trigger carries the line, and the leg it opens is remembered under whatever root it
     * resolved. Its own `turn/end` is the second round's entry. */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: sid }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(real, 'c-1', 'n-2')),
      'the second leg\'s session and its claim',
      warnings,
    )
    const second = agents.created[1].options.sessionId

    /* The alias goes away: from here on, the caller's spelling names nothing. */
    rmSync(alias, { recursive: true, force: true })

    await settleClose(root, 'n-2', 'n-3')
    events.emit('session/event', { id: second }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 3 && existsSync(claimPath(real, 'c-1', 'n-3')),
      'the third leg\'s session and its claim, carried at the root\'s real path',
      warnings,
    )
  } finally {
    installOff()
    rmSync(alias, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The same trigger, with the alias **still there**: the normal working state, and the reading the case
 * above cannot take.
 *
 * The case above pins `judge`'s canonicalisation through a side door — it deletes the junction after
 * the second round, so a trigger that did not canonicalise has nowhere to carry the line. That works,
 * but all of its pinning force comes from an abnormal setup: if the case were ever simplified (the
 * deletion dropped because it looks like cleanup), it would stay green while pinning nothing. Hauling
 * the reading onto the normal path is this case's whole point.
 *
 * The reading is the run doc the trigger's own open lands. `conductor.advance` writes
 * `nodes/<node>/run.md` with an absolute `spec:` path built from the root it was handed, so the third
 * leg's run doc spells whatever spelling `judge` passed down: the alias if it did not canonicalise,
 * the real path if it did. Nothing else about the trigger — no cwd, no claim, no port read — differs
 * between those two runs, which is why the earlier cases could not tell them apart while the alias
 * lived. The `spec:` line is asserted rather than a whole document, because the rest of the file
 * carries times and titles this case has no business pinning.
 */
test('The trigger settles the root while the alias is still there: the third leg\'s run doc spells the real path', async () => {
  const root = rigRecordRoot(['n-1', 'n-2', 'n-3'])
  const alias = join(tmpdir(), `superworker-relay-judge-live-${randomUUID()}`)
  symlinkSync(root, alias, 'junction')
  const real = realpathSync(root)
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    /* Round one at the caller's spelling, which is the only road that puts a non-canonical root in the
     * relay's table: the agent-facing tool opens through `trackedExecutorOf` at the spelling it was
     * handed. */
    const executor = trackedExecutorOf(ctx, 'caller', alias)
    const first = await open(alias, { executor, pluginsDir: shippedPluginsDir() }).conductor.dispatch({ cycle: 'c-1', node: 'n-1' })
    assert.equal(first.action, 'opened', JSON.stringify(first))

    /* The trigger carries the line. The alias is **not** touched anywhere in this case. */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: first.session.sessionId }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(real, 'c-1', 'n-2')),
      'the second leg\'s session and its claim',
      warnings,
    )
    assert.ok(existsSync(alias), 'this case requires the alias to be alive for the whole run')

    /* The run doc the trigger's advance landed for the cell it opened, read off the real tree. The
     * engine spells the path with forward slashes whatever the platform, so both sides are compared
     * that way — the question is which directory the line names, not how this platform punctuates it. */
    const asSlashes = (path) => path.replace(/\\/gu, '/')
    const specLine = (await readFile(join(root, '.superworker', 'nodes', 'n-2', 'run.md'), 'utf8'))
      .split(/\r?\n/u)
      .find((line) => line.startsWith('- spec:'))
    assert.ok(specLine !== undefined, 'the trigger landed no run doc for the leg it opened')
    assert.ok(
      !asSlashes(specLine).includes(asSlashes(alias)),
      `the trigger carried the line at the caller's spelling: ${specLine}`,
    )
    assert.ok(
      asSlashes(specLine).includes(asSlashes(real)),
      `the trigger's run doc does not spell the root's real path: ${specLine}`,
    )
  } finally {
    installOff()
    assert.ok(existsSync(alias), 'the alias is torn down by this case, not by the code under test')
    assert.ok(existsSync(root), 'removing the alias does not take the root it points at')
    rmSync(alias, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The (d) reading, as a case: one turn-end trigger canonicalises the root **twice**, and each of the
 * two is a different door's — the trigger's own entry, then the opener's — with the relay's `judge`
 * taking the second spelling once for the plan read instead of re-spelling it a second time.
 *
 * That count is what the seam's (d) half is: `dispatchCell` and `advanceLine` each take the canonical
 * spelling once on the way in, and `judge` re-enters below that step rather than re-deriving it. It has
 * no behavioural reading of its own — with an alias present, `.root` and `.canonicalRoot()` hand out
 * the same string in that one place, so no assertion about a path can tell the two apart. What can is
 * the number of times the one spelling function runs, so that is what this case counts.
 *
 * The counter is a spy on `fs/promises.realpath`, which is the only call `canonicalRootOf` makes, and
 * it is installed by patching the CJS surface and calling `syncBuiltinESMExports`: a module's named
 * import of `realpath` is a live binding, so the seam's own import reviews the patched function without
 * the source being edited. Only frames inside this checkout's `src/host` are counted, so nothing the
 * test runner does is mistaken for a seam call.
 *
 * The count is taken over the stretch that starts at the notice and ends at the second leg's own mint:
 * both canonicalisations happen before the opener reaches `create`, so the mint is the end of the
 * window, and a mint is an event rather than a wait.
 */
test('One turn-end trigger canonicalises the root twice: the trigger\'s entry and the opener\'s, and judge re-spells nothing', async () => {
  const root = rigRecordRoot(['n-1', 'n-2'])
  const alias = join(tmpdir(), `superworker-relay-canon-${randomUUID()}`)
  symlinkSync(root, alias, 'junction')
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  const original = fsp.realpath
  let frames = []
  try {
    /* Round one at the caller's spelling: the only road that puts a non-canonical root in the relay's
     * table, so the trigger below really has a spelling to settle. */
    const executor = trackedExecutorOf(ctx, 'caller', alias)
    const first = await open(alias, { executor, pluginsDir: shippedPluginsDir() }).conductor.dispatch({ cycle: 'c-1', node: 'n-1' })
    assert.equal(first.action, 'opened', JSON.stringify(first))
    await settleClose(root, 'n-1', 'n-2')

    /* The window closes at the second leg's own mint: hooked onto the registry before the notice goes
     * out, so nothing has to be waited for. */
    let minted
    const carried = new Promise((resolve) => { minted = resolve })
    const registry = agents.registry
    const realCreate = registry.create.bind(registry)
    registry.create = (options) => {
      const held = realCreate(options)
      if (agents.created.length >= 2) minted()
      return held
    }

    fsp.realpath = async (...args) => {
      frames.push(new Error().stack ?? '')
      return original(...args)
    }
    syncBuiltinESMExports()
    events.emit('session/event', { id: first.session.sessionId }, { type: 'turn/end' })
    await carried
    /* The window closes at the mint: the spy comes off before anything after the open runs, so the
     * count is the open's own two spellings and nothing the case does beside it. */
    fsp.realpath = original
    syncBuiltinESMExports()
    await until(() => existsSync(claimPath(root, 'c-1', 'n-2')), 'the second leg\'s claim', warnings)

    const hostFrames = frames.filter((stack) => /src[\\/]host[\\/]/u.test(stack))
    /* The caller of the spelling function: the first `src/host` frame below `canonicalRootOf` and the
     * seam's own `canonicalRoot` closure, which is a fixed pair of frames in this file's seam. Named
     * rather than assumed, so a third place taking a spelling would show up here as its own frame. */
    const callers = hostFrames.map((stack) => {
      const lines = String(stack)
        .split('\n')
        .filter((line) => /src[\\/]host[\\/].*\.ts:\d+/u.test(line))
        .map((line) => line.trim())
      return lines.find((line) => !line.includes('canonicalRootOf') && !line.includes('canonicalRoot')) ?? '?'
    })
    assert.equal(
      hostFrames.length,
      2,
      `one trigger must canonicalise the root twice (the trigger's entry and the opener), not ${hostFrames.length}: ${JSON.stringify(callers)}`,
    )
    /* The two are the two doors, named: no third place re-derives the spelling, and neither is taken
     * twice at one door — that pair is the whole count. */
    assert.ok(callers.some((line) => line.includes('judge')), `the trigger's own entry did not canonicalise: ${JSON.stringify(callers)}`)
    assert.ok(
      callers.some((line) => line.includes('openNodeSession')),
      `the opener did not canonicalise off the seam's answer: ${JSON.stringify(callers)}`,
    )
  } finally {
    fsp.realpath = original
    syncBuiltinESMExports()
    installOff()
    rmSync(alias, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('The button walks the same path: the gateway\'s openNodeSession endpoint lands the claim too', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = context({ root, agents })
  try {
    const gateway = new SuperworkerRecordsGateway(ctx)
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
  const alias = join(tmpdir(), `superworker-relay-alias-${randomUUID()}`)
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

test('Parallel cycles: two cycles running side by side relay independently by the cycle that opened the session', async () => {
  const root = rigRecordRoot(['n-1', 'n-2', 'n-3'])
  const statePath = join(root, '.superworker', 'state.json')
  writeFileSync(statePath, JSON.stringify({
    cycles: [
      { id: 'c-1', tags: [], holding: [{ id: 'n-1', since: '2026-10-18T00:00:00Z' }], path: [] },
      { id: 'c-2', tags: [], holding: [{ id: 'n-3', since: '2026-10-18T00:00:00Z' }], path: [] },
    ],
  }))
  const agents = fakeAgents()
  const { ctx, events, warnings } = context({ root, agents })
  const installOff = installRelay(ctx)
  try {
    const leg1 = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    const leg2 = await dispatchCell(ctx, 'caller', root, 'c-2', 'n-3')
    assert.equal(leg1.ok, true)
    assert.equal(leg2.ok, true)
    assert.equal(agents.created.length, 2)

    /* c-1 finishes n-1 (holding now empty on c-1 while c-2 is still running n-3). */
    const ideas = JSON.parse(await readFile(join(root, '.superworker', 'ideas.json'), 'utf8'))
    ideas.nodes['n-1'].status = 'completed'
    await writeFile(join(root, '.superworker', 'ideas.json'), JSON.stringify(ideas))
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.cycles[0].holding = []
    state.cycles[0].path = [{ node: 'n-1', started_at: '2026-10-18T00:00:00Z', ended_at: '2026-10-18T00:01:00Z', result: 'completed' }]
    await writeFile(statePath, JSON.stringify(state))

    /* turn/end on c-1's session relays c-1 onto n-2 directly without touching c-2 or failing on ambiguity. */
    events.emit('session/event', { id: leg1.session }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 3 && existsSync(claimPath(root, 'c-1', 'n-2')),
      'c-1 relays its next leg while c-2 runs alongside it',
      warnings,
    )
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-2')))
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})
