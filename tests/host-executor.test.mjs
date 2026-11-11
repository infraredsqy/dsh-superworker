/* The host half's native executor: locks in the facts an open must not miss.
 *
 * The open runs against stand-ins for the host's own services (the session side, the workspace
 * registry, the workspace files port, the event bus), so the cases here judge the flow, not a
 * deployment: the session is created under the workspace root and attached to that workspace when
 * the host carries one, the plan's launch prompt is the first instruction verbatim, the note is
 * written by the engine's writer, the open answers as soon as the session is out and never waits
 * for its round, a missing agent registry is refused with the piece named, and two opens aimed at
 * one workspace create their sessions one after another.
 *
 * The dispatch seam is judged here too: a request carrying `dryRun` answers a drill receipt and
 * opens nothing at all, while the same request without it still opens one session.
 *
 * The note lands on real disk (a temporary directory per case), because the write is the engine's
 * own fs action; the prompt is read through the port stand-in the other host tests share.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalWorkspaceRoot, executorOf, openNodeSession } from '../src/host/executor.ts'
import { TOOL_NAME } from '../src/host/tool.ts'
import { pinHome } from './helpers/env.mjs'
import { clearPlacement, placeOneSkill } from './helpers/skill-placement.mjs'
import { until, flush } from './helpers/wait.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'

/* Opening a session also reads the placement record under the DSH home to confirm the skills the
 * plugins placed against this workspace's own catalog view. These cases exercise the opener's flow,
 * not that placement, so the home they read is pinned to a temp one here — never the machine's own. */
const pinned = pinHome(['DSH_HOME'], 'superworker-executor-home-')
test.after(pinned.restore)

/** One cell's plan line, the way the dispatch preparation writes it: one line, nothing after it. */
const PROMPT_LINE = '/sw-conduct n1 [pipeline]'
/* In the dict it wears its trailing newline, the way the file sits on disk; the port moves lines, not bytes, so the line arrives without that terminator. */
const PROMPT = `${PROMPT_LINE}\n`

/** The dict key the port reads the prompt from. */
const promptPath = (cycle, node) => `.superworker/meta/launch/${cycle}/${node}/prompt.txt`

/** A promise whose release the test holds. */
function defer() {
  let resolve
  const promise = new Promise((give) => { resolve = give })
  return { promise, resolve }
}

/**
 * Wait until the queued opens reach `count` creations, then turn the loop over once. The opener
 * resolves the workspace root off the loop (`realpath`) before it creates, so a fixed number of
 * turns no longer reaches `create`; the wait is bounded by wall clock because that is real IO.
 */
async function opened(created, count = 1) {
  await until(() => created.length >= count, `create number ${count}`)
  await flush()
}

/**
 * Wait one promise out with a ceiling, naming what it waited for: a case whose answer never
 * arrives goes red with that sentence instead of holding the whole command. The ceiling is one
 * timer, cleared as soon as the wait answers — no spin.
 */
async function bounded(promise, what, ms = 5000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not arrive: ${what} (limit ${ms} ms)`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The queue cases' doors: every `create` stops on its own door, and the moment it is called the
 * door reports itself. A case waits for that report — the event says which seat on the line was
 * taken, so a case need not presume which of two opens reaches the line first: the line is
 * served in arrival order, and which open arrives first belongs to the scheduler.
 */
function createDoors(count = 2) {
  const doors = []
  const arrivals = []
  for (let at = 0; at < count; at += 1) arrivals.push(defer())
  return {
    /** The gate handed to `fakeAgents`. */
    gate() {
      const at = doors.length
      const door = defer()
      doors.push(door)
      arrivals[at]?.resolve()
      return door.promise
    },
    /** Wait until the create on this seat has really been called. */
    arrived(at) { return arrivals[at].promise },
    /** Let the create on this seat through. */
    release(at) { doors[at].resolve() },
  }
}

/**
 * The session-side stand-in: every create is recorded (options, the messages handed over), and each
 * create may be held on a gate so a test controls when it lands. An agent that carries a wait
 * interface records that it was asked: the open must never consult it, so a case can read the
 * absence rather than trust it.
 */
function fakeAgents({ gate, asksWait } = {}) {
  const created = []
  return {
    created,
    registry: {
      create(options) {
        const record = { options, followups: [], registered: [], sequence: [], waitAsked: 0 }
        created.push(record)
        const agent = {
          id: options.sessionId,
          status: 'idle',
          ctx: {
            tools: {
              register(definition) {
                record.registered.push(definition)
                record.sequence.push('register')
                return () => {}
              },
              /* The gating half of the registry: without it a scope carries no registry this line
               * registers into (see `toolsOf`), and the open's registration would not land. */
              resolve: async () => ({}),
            },
          },
          followup(message) {
            record.sequence.push('followup')
            record.followups.push(message)
          },
          ...(asksWait === true
            ? {
                whenIdle: () => {
                  record.waitAsked += 1
                  /* A round that never ends: a wait consulted here would hold the case's answer forever. */
                  return new Promise(() => {})
                },
              }
            : {}),
        }
        record.agent = agent
        const held = gate?.(record, created.length - 1) ?? Promise.resolve()
        return held.then(() => ({ agent, dispose: async () => {} }))
      },
    },
  }
}

/** The host context stand-in: the port as a property, an event bus with `on`/`emit`, and the store the opener reaches through `get('sessions')` — the inject requirement a stand-in that omits the live-session service still opens without. */
function context({ files, agents, sessions, defaultModel, workspaceRegistry, agentPresets } = {}) {
  return fakeContext({
    files,
    sessions: false,
    bus: true,
    services: { sessions, agents, agentDefaultModel: defaultModel, workspaceRegistry, agentPresets },
  })
}

/** A real workspace root for the note the opener writes, with the plan prompt in the port's dict. `prompt: null` means the cell has none. */
function rig({ files = {}, node = 'n1', cycle = 'c1', prompt = PROMPT, ...rest } = {}) {
  mkdirSync(join(tmpdir(), 'superworker-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'superworker-executor-', 'ws-'))
  const dict = { ...files }
  if (prompt !== null) dict[promptPath(cycle, node)] = prompt
  const agents = fakeAgents(rest)
  const { ctx, events } = context({ files: dict, agents: agents.registry, sessions: {}, ...rest })
  return { root, cycle, node, agents, ctx, events }
}

/** The note the opener writes for one node, as it is on disk. */
function noteOnDisk(root, node) {
  return JSON.parse(readFileSync(join(root, '.superworker', 'meta', 'sessions', `${node}.json`), 'utf8'))
}

/**
 * One root under a second spelling: a directory junction over it, which an ordinary user may mint
 * on Windows and which resolves to the target through `realpath` — the shape a symlinked home or a
 * short (8.3) name puts in front of the opener. Taken back with `rmSync`, which removes the link and
 * never what it points at.
 */
function aliasOf(root) {
  const alias = join(tmpdir(), `superworker-executor-alias-${randomUUID()}`)
  symlinkSync(root, alias, 'junction')
  return alias
}

test('Probe: no agent registry, it refuses naming agents, and builds nothing', async () => {
  const agents = fakeAgents()
  const { ctx } = context({ files: {}, agents })
  const noAgents = { ...ctx, get(name) { return name === 'sessions' ? {} : undefined } }
  const outcome = await openNodeSession(noAgents, 's1', 'C:\\ws', 'c1', 'n1')
  assert.deepEqual(outcome, { ok: false, code: 'no-session-service', detail: 'agents' })
  assert.equal(agents.created.length, 0)
})

test('Grouping and the first instruction: the session is created under the workspace root, the plan prompt goes in verbatim', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.meta.cwd, realpathSync(rigging.root), 'cwd must be this workspace root: the panel groups by it')
  assert.equal(typeof record.options.sessionId, 'string')
  assert.ok(record.options.sessionId.length > 0, 'the session id is minted at open time')
  assert.equal(record.followups.length, 1, 'exactly one first instruction')
  const said = record.followups[0]
  assert.equal(said.role, 'user')
  assert.equal(said.source.kind, 'user')
  assert.equal(said.content[0].type, 'text')
  assert.equal(said.content[0].text, PROMPT_LINE, 'the first instruction is the plan line, not one character changed')
})

test('Grouping and attach: with a workspace service, the opened session attaches to the workspace the root lives in', async () => {
  const created = []
  const attached = []
  const workspaceRegistry = {
    async create(path) {
      created.push(path)
      return {
        async attachSession(session) {
          attached.push(session)
        },
      }
    },
  }
  const rigging = rig({ workspaceRegistry })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.deepEqual(created, [realpathSync(rigging.root)], 'the service is asked for that workspace by root')
  assert.deepEqual(attached, [rigging.agents.created[0].options.sessionId], 'the opened session is attached')
})

test('Grouping and attach: with no workspace service it still opens, leaving one line saying the session could not attach', async () => {
  const lines = []
  const rigging = rig()
  const ctx = {
    ...rigging.ctx,
    logger: {
      info: (line) => lines.push(`info: ${line}`),
      warn: (line) => lines.push(`warn: ${line}`),
    },
  }
  const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(lines.length, 1, `one line: ${lines.join(' / ')}`)
  assert.match(lines[0], /^warn: could not attach/u)
  assert.ok(lines[0].includes(`${rigging.cycle}/${rigging.node}`), 'the line names the cell')
  assert.ok(lines[0].includes(realpathSync(rigging.root)), 'the line names the workspace')
  assert.ok(existsSync(join(rigging.root, '.superworker', 'meta', 'sessions', 'n1.json')), 'the session opens and the note lands as usual')
})

test('Grouping and attach: the session is already open when the host refuses the attach, so it degrades to cwd-only and leaves one line', async () => {
  const lines = []
  const workspaceRegistry = {
    async create() {
      return {
        async attachSession() {
          /* The real host's refusal carries the session id; this stand-in carries it the same way: the refusal itself must not hand the id to the reader. */
          throw new Error('cannot attach session \'session-abc\' to workspace \'ws-1\'')
        },
      }
    },
  }
  const rigging = rig({ workspaceRegistry })
  const ctx = {
    ...rigging.ctx,
    logger: {
      info: (line) => lines.push(`info: ${line}`),
      warn: (line) => lines.push(`warn: ${line}`),
    },
  }
  const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending

  assert.equal(outcome.ok, true, 'the session is already inside: a failed attach is no reason to fail this leg')
  assert.equal(outcome.session, rigging.agents.created[0].options.sessionId)
  assert.equal(lines.length, 1, `one line: ${lines.join(' / ')}`)
  assert.match(lines[0], /^warn: could not attach/u, 'the line names the failed attach')
  assert.ok(lines[0].includes(`${rigging.cycle}/${rigging.node}`), 'the line names the cell')
  assert.ok(lines[0].includes(realpathSync(rigging.root)), 'the line names the workspace')
  assert.ok(lines[0].includes('session-abc'), 'the line keeps the reason the host gave')
  assert.ok(lines[0].includes('cwd-only'), 'the line says the session degraded to cwd-only')
  assert.equal(rigging.agents.created[0].followups.length, 1, 'the first instruction still arrives: an ungrouped session does not idle')
  assert.ok(
    existsSync(join(rigging.root, '.superworker', 'meta', 'sessions', 'n1.json')),
    'the note lands after the degrade too: no orphan without paper',
  )
})

test('Canonical spelling: a session opened through another spelling gets the real path for cwd and attach', async () => {
  const created = []
  const workspaceRegistry = {
    async create(path) {
      created.push(path)
      return { async attachSession() {} }
    },
  }
  const rigging = rig({ workspaceRegistry })
  const alias = aliasOf(rigging.root)
  try {
    const real = realpathSync(rigging.root)
    assert.notEqual(alias, real, 'this case needs two different spellings')
    const pending = openNodeSession(rigging.ctx, 's1', alias, rigging.cycle, rigging.node)
    await opened(rigging.agents.created)
    const outcome = await pending
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(
      rigging.agents.created[0].options.meta.cwd,
      real,
      'the session header cwd is the real path: after the workspace layer realpaths, it must match the record',
    )
    assert.deepEqual(created, [real], 'the workspace service is asked for the workspace by real path, not by the caller spelling')
    assert.ok(existsSync(join(real, '.superworker', 'meta', 'sessions', `${rigging.node}.json`)), 'the note lands under the same root')
  } finally {
    rmSync(alias, { recursive: true, force: true })
    assert.ok(existsSync(rigging.root), 'removing the alias does not take the root it points at')
  }
})

test('Canonical spelling: two spellings of one root queue on one line, and the second only enters create when the first is done', async () => {
  /* Both opens start together: which seat reaches create first belongs to arrival order, so the case waits for "create was called". */
  const doors = createDoors()
  const rigging = rig({
    files: { [promptPath('c1', 'n2')]: '/sw-conduct n2 [pipeline]\n' },
    gate: doors.gate,
  })
  const alias = aliasOf(rigging.root)
  try {
    const first = openNodeSession(rigging.ctx, 's1', rigging.root, 'c1', 'n1')
    const second = openNodeSession(rigging.ctx, 's1', alias, 'c1', 'n2')
    await bounded(doors.arrived(0), 'the first seat enters create')
    /* Two spellings are one root: only one seat on the line, the other still queued. */
    await flush()
    assert.equal(rigging.agents.created.length, 1, 'two spellings are one root: the second is still queued, not in create')
    doors.release(0)
    await bounded(doors.arrived(1), 'the first seat is done, so the second enters create')
    assert.equal(rigging.agents.created.length, 2, 'the line frees up, so the second enters create')
    doors.release(1)
    const outcomes = await bounded(Promise.all([first, second]), 'both opens settle')
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome))
  } finally {
    rmSync(alias, { recursive: true, force: true })
    assert.ok(existsSync(rigging.root), 'removing the alias does not take the root it points at')
  }
})

/* The name says what this case asserts: the fallback spelling. The other half of the old name —
 * "never refuse to open a session for one spelling" — is pinned by the two cases above, where an open through a junction
 * spelling comes back `ok` with the real path in hand. */
test('Canonical spelling: a root with no real path comes back as it went in', async () => {
  const missing = join(tmpdir(), `superworker-executor-missing-${randomUUID()}`)
  assert.equal(await canonicalWorkspaceRoot(missing), missing)
})

test('The note is written by the opener: one more run entry, the other entries left as they were', async () => {
  const before = {
    v: 1,
    discussion: [{ session: 'session-talk', host: 'zcode', at: '2026-10-01T00:00:00Z' }],
    run: [{ session: 'session-old', host: 'dsh', at: '2026-10-02T00:00:00Z' }],
  }
  const rigging = rig({ files: {}, node: 'n1' })
  mkdirSync(join(rigging.root, '.superworker', 'meta', 'sessions'), { recursive: true })
  writeFileSync(join(rigging.root, '.superworker', 'meta', 'sessions', 'n1.json'), JSON.stringify(before))
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const note = noteOnDisk(rigging.root, 'n1')
  assert.equal(note.v, 1)
  assert.deepEqual(note.discussion, before.discussion, 'discussion stays as it was (zcode\'s host line is not rewritten)')
  assert.equal(note.run.length, 2)
  assert.deepEqual(note.run[0], before.run[0], 'the old run entry stays as it was')
  const added = note.run[1]
  assert.equal(added.session, rigging.agents.created[0].options.sessionId)
  assert.equal(added.host, 'dsh')
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(added.at), 'the timestamp is the second-resolution spelling')
})

test('An unreadable note is no roadblock: the bad page is replaced with one that writes', async () => {
  const rigging = rig({ node: 'n1' })
  mkdirSync(join(rigging.root, '.superworker', 'meta', 'sessions'), { recursive: true })
  writeFileSync(join(rigging.root, '.superworker', 'meta', 'sessions', 'n1.json'), '{broken')
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const note = noteOnDisk(rigging.root, 'n1')
  assert.deepEqual(note.discussion, [])
  assert.equal(note.run.length, 1)
  assert.equal(note.run[0].session, rigging.agents.created[0].options.sessionId)
})

test('The open ends where the session begins: the answer arrives with the first instruction in, and no wait is consulted', async () => {
  /* The stand-in's wait interface never answers: an open that consulted it would hold this case forever. */
  const rigging = rig({ asksWait: true })
  const outcome = await bounded(
    openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node),
    'the open answers without its round',
  )
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(outcome.session, rigging.agents.created[0].options.sessionId)
  assert.equal(rigging.agents.created[0].waitAsked, 0, 'the round is the session\'s business: no wait interface is consulted')
  assert.equal(rigging.agents.created[0].followups.length, 1, 'the first instruction went in before the answer')
  assert.ok(
    existsSync(join(rigging.root, '.superworker', 'meta', 'sessions', 'n1.json')),
    'the note is on disk before the answer',
  )
})

test('The answer is the session and nothing about the work: no field reports how the round went', async () => {
  const rigging = rig()
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.deepEqual(
    Object.keys(outcome).sort(),
    ['ok', 'session'],
    'an open that grew a round reading would be answering the line\'s own question',
  )
  /* The session's own events arrive after that answer: they are the relay's business, not this call's. */
  const agent = rigging.agents.created[0].agent
  rigging.events.emit('agent/status', { agent, status: 'idle' })
  rigging.events.emit(
    'session/event',
    { id: rigging.agents.created[0].options.sessionId },
    { type: 'turn/end', turn: 1, reason: { kind: 'completed' } },
  )
  rigging.events.emit('agent/disposed', { agent })
  await flush()
  assert.equal(outcome.session, rigging.agents.created[0].options.sessionId)
})

test('One line per workspace: two opens go strictly one after another, and both open', async () => {
  mkdirSync(join(tmpdir(), 'superworker-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'superworker-executor-', 'ws-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT, [promptPath('c1', 'n2')]: '/sw-conduct n2 [pipeline]\n' }
/* Order on one line belongs to arrival order: the case waits for "create was called" and does not order the two opens. */
  const doors = createDoors()
  const agents = fakeAgents({ gate: doors.gate })
  const { ctx } = context({ files, agents: agents.registry, sessions: {} })
  const first = openNodeSession(ctx, 's1', root, 'c1', 'n1')
  const second = openNodeSession(ctx, 's1', root, 'c1', 'n2')
  await bounded(doors.arrived(0), 'the first seat enters create')
  await flush()
  assert.equal(agents.created.length, 1, 'only one seat on the line is in create: the other is still queued')
  doors.release(0)
  await bounded(doors.arrived(1), 'the first seat is done, so the second enters create')
  assert.equal(agents.created.length, 2, 'the line frees up, so the second enters create')
  doors.release(1)
  const outcomes = await bounded(Promise.all([first, second]), 'both opens settle')
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.notEqual(agents.created[0].options.sessionId, agents.created[1].options.sessionId, 'each session has its own id')
  assert.ok(existsSync(join(root, '.superworker', 'meta', 'sessions', 'n1.json')))
  assert.ok(existsSync(join(root, '.superworker', 'meta', 'sessions', 'n2.json')))
})

test('One line per workspace: one rejection does not poison the next, and the second still opens', async () => {
  mkdirSync(join(tmpdir(), 'superworker-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'superworker-executor-', 'ws-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT, [promptPath('c1', 'n2')]: '/sw-conduct n2 [pipeline]\n' }
  const agents = fakeAgents({
    gate: (_record, index) => (index === 0 ? Promise.reject(new Error('create blew up')) : Promise.resolve()),
  })
  const { ctx } = context({ files, agents: agents.registry, sessions: {} })
  const one = await openNodeSession(ctx, 's1', root, 'c1', 'n1')
  assert.equal(one.ok, false)
  assert.equal(one.code, 'open-failed')
  assert.ok((one.detail ?? '').includes('create blew up'), 'the refusal carries the words create threw')
  const two = openNodeSession(ctx, 's1', root, 'c1', 'n2')
  await opened(agents.created, 2)
  assert.equal(agents.created.length, 2, 'the line is still alive: the second enters create as usual')
  const outcome = await two
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.ok(existsSync(join(root, '.superworker', 'meta', 'sessions', 'n2.json')), 'the second note lands as usual')
})

test('Different workspaces do not queue: each line runs on its own', async () => {
  mkdirSync(join(tmpdir(), 'superworker-executor-'), { recursive: true })
  const rootA = mkdtempSync(join(tmpdir(), 'superworker-executor-', 'ws-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'superworker-executor-', 'ws-b-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT }
  const holds = [defer(), defer()]
  let taken = 0
  const agents = fakeAgents({ gate: () => holds[taken++].promise })
  const { ctx } = context({ files, agents: agents.registry, sessions: {} })
  const one = openNodeSession(ctx, 's1', rootA, 'c1', 'n1')
  const two = openNodeSession(ctx, 's1', rootB, 'c1', 'n1')
  await opened(agents.created, 2)
  assert.equal(agents.created.length, 2, 'each line runs on its own: both sides are in create')
  holds[0].resolve()
  holds[1].resolve()
  assert.equal((await one).ok, true)
  assert.equal((await two).ok, true)
})

test('No dispatch prompt: it refuses by name and builds and writes nothing', async () => {
  const rigging = rig({ prompt: null })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'prompt-missing')
  assert.equal(rigging.agents.created.length, 0)
  assert.ok(!existsSync(join(rigging.root, '.superworker', 'meta', 'sessions', `${rigging.node}.json`)), 'no session, no note')
})

test('A dispatch prompt that is all blank: that counts as none too, refused rather than opening an empty session', async () => {
  const rigging = rig({ prompt: '   \n' })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'prompt-missing')
  assert.equal(rigging.agents.created.length, 0)
})

test('A cell name cannot be a path: separators or self-reference in either level stop at the argument gate', async () => {
  for (const [cycle, node] of [['c1', '..'], ['c1/x', 'n1'], ['', 'n1'], ['c1', '.']]) {
    const rigging = rig()
    const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, cycle, node)
    assert.equal(outcome.ok, false, `${cycle}/${node} must be stopped`)
    assert.equal(outcome.code, 'arg-not-allowed', `${cycle}/${node}: the stop reason is the argument gate`)
    assert.equal(rigging.agents.created.length, 0)
  }
})

test('The deployment carries a default model selection: the new session opens with it', async () => {
  const rigging = rig({ defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  await pending
  assert.deepEqual(rigging.agents.created[0].options.agentOptions, { provider: 'deepseek', model: 'chat' })
})

test('No default model selection in the deployment: no agentOptions, the loop\'s own default takes over', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  await pending
  assert.equal(rigging.agents.created[0].options.agentOptions, undefined)
})

/* ---- the standing preset the open composes through ---- */

test('Composition: with a preset roster on the host, the session composes against the roster\'s default preset, and the mount rides setup into create', async () => {
  const mounted = []
  const agentPresets = {
    async resolve() { return { id: 'standard-persona' } },
    async mount(_agentCtx, id) { mounted.push(id) },
  }
  const rigging = rig({ agentPresets })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.meta.agentPreset, 'standard-persona', 'the roster preset id lands in the session metadata')
  assert.equal(typeof record.options.setup, 'function', 'create carries the composition setup')
  await record.options.setup({}, record.agent)
  assert.deepEqual(mounted, ['standard-persona'], 'setup mounts the id resolve answered')
})

test('Composition: with no preset roster it still opens, carrying no setup and writing no agentPreset', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.setup, undefined, 'no roster, no setup')
  assert.equal(record.options.meta.agentPreset, undefined, 'no roster, no preset id written')
})

test('Composition: the preset resolve refuses, the open lands as open-failed with the reason, nothing built', async () => {
  const agentPresets = {
    async resolve() { throw new Error('roster blew up') },
    async mount() { throw new Error('mount must not be reached') },
  }
  const rigging = rig({ agentPresets })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'open-failed')
  assert.ok((outcome.detail ?? '').includes('roster blew up'), 'the refusal carries the words the roster threw')
  assert.equal(rigging.agents.created.length, 0, 'an open whose resolve failed builds no agent')
  assert.ok(
    !existsSync(join(rigging.root, '.superworker', 'meta', 'sessions', `${rigging.node}.json`)),
    'no session, no note',
  )
})

/* ---- the session's own tool, armed by the opener ---- */

test('Wake: the opened session gets the superworker tool before the first instruction lands, exactly once', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.registered.length, 1, 'registered exactly once')
  assert.equal(record.registered[0].name, TOOL_NAME, 'the registered one is the superworker tool')
  assert.deepEqual(record.sequence, ['register', 'followup'], 'the tool enters the scope first, the first instruction after')
})

test('Wake: a session with no tools surface still opens as usual (the wake stays silent by contract)', async () => {
  // bespoke: an agent whose ctx has no tools service
  mkdirSync(join(tmpdir(), 'superworker-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'superworker-executor-', 'ws-'))
  let made
  const bareAgents = {
    create(options) {
      const record = { options, followups: [] }
      made = record
      const agent = {
        id: options.sessionId,
        status: 'idle',
        ctx: {},
        followup(message) { record.followups.push(message) },
      }
      record.agent = agent
      return Promise.resolve({ agent, dispose: async () => {} })
    },
  }
  const { ctx } = context({ files: { [promptPath('c1', 'n1')]: PROMPT }, agents: bareAgents, sessions: {} })
  const outcome = await openNodeSession(ctx, 's1', root, 'c1', 'n1')
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(made.followups.length, 1, 'the bare agent still gets its first instruction')
})

/* ---- the dispatch seam's drill switch ---- */

test('The dispatch seam\'s drill switch: a request with dryRun answers a drill receipt only, no agent built in the registry', async () => {
  const rigging = rig()
  const executor = executorOf(rigging.ctx, 's1', rigging.root)
  const receipt = await executor.dispatch({
    cycle: rigging.cycle,
    node: rigging.node,
    prompt: PROMPT,
    dryRun: true,
  })
  assert.deepEqual(receipt, { host: 'drill' }, 'the drill receipt says only that this is a drill, carrying no session id')
  assert.equal(rigging.agents.created.length, 0, 'the drill finds no session-opening call at all')
  assert.ok(
    !existsSync(join(rigging.root, '.superworker', 'meta', 'sessions', `${rigging.node}.json`)),
    'the drill writes no note either',
  )
})

test('The dispatch seam\'s drill switch: without dryRun it opens a session as usual, and the receipt carries the session id', async () => {
  const rigging = rig()
  const executor = executorOf(rigging.ctx, 's1', rigging.root)
  const pending = executor.dispatch({ cycle: rigging.cycle, node: rigging.node, prompt: PROMPT })
  await opened(rigging.agents.created)
  assert.equal(rigging.agents.created.length, 1, 'an ordinary dispatch enters create as usual')
  const receipt = await pending
  assert.equal(receipt.host, 'dsh')
  assert.equal(receipt.sessionId, rigging.agents.created[0].options.sessionId)
})

/* ---- the session-side diagnostic of the placed skills (K4) ---- */

/* The three diagnostic cases below (the two session-side diagnostic ones, and the catalog-diagnostic one that holds the
 * catalog open) require process isolation. They place a skill into the temp home this file pinned
 * (`placeOneSkill`) and then rely on the opener reading `DSH_HOME` back out of the process
 * environment (`skill-paths.ts` reads it at call time). Under `--test-isolation=none` every test
 * file shares one process, and a later file's own home pin overwrites that environment before these
 * cases run — the premise is gone, through no fault of the opener. So each of the three checks the
 * premise first and skips itself with that reason when it does not hold; the default tier (one
 * child process per file) never sees it trip. */

/** The host context with a skill catalog that answers one fixed view, and a logger that keeps its lines. The workspace layer is present and quiet, so the only line these cases read is the diagnostic's own. */
function rigWithCatalog(rigging, view) {
  const lines = []
  const ctx = {
    ...rigging.ctx,
    logger: {
      info: (line) => lines.push(`info: ${line}`),
      warn: (line) => lines.push(`warn: ${line}`),
      error: (line) => lines.push(`error: ${line}`),
    },
    get(name) {
      if (name === 'skills') return { async list(options) { return view(options) } }
      if (name === 'workspaceRegistry') {
        return {
          async create() {
            return { async attachSession() {} }
          },
        }
      }
      return rigging.ctx.get(name)
    },
  }
  return { ctx, lines }
}

test('Session-side diagnostic: when a same-named copy under the project root outranks the plugin\'s, the open leaves one skill-shadowed line naming both places', async (t) => {
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`needs process isolation: DSH_HOME was overwritten in the shared process by another test file's pin (now points at ${process.env.DSH_HOME}, not this file's ${pinned.home})`)
    return
  }
  const name = 'sw-issue-repair'
  const ours = placeOneSkill(pinned.home, name)
  const rigging = rig()
  const projectCopy = join(rigging.root, '.dsh', 'skills', name, 'SKILL.md')
  try {
    const { ctx, lines } = rigWithCatalog(rigging, (options) => {
      /* The view a session reads: cwd named, the session's own scope passed through. */
      assert.equal(options.cwd, rigging.root, 'the session-view readback lost the workspace')
      assert.ok(options.scope !== undefined, 'the session-view readback lost the scope')
      return [{ name, provider: 'filesystem', source: 'project-dsh', rank: 100, path: projectCopy }]
    })
    const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
    await opened(rigging.agents.created)
    const outcome = await pending

    assert.equal(outcome.ok, true, 'the shadow line must not fail the open')
    assert.equal(lines.length, 1, `the open should leave one line: ${lines.join(' / ')}`)
    assert.match(lines[0], /^warn: plugin skills shadowed/u)
    assert.match(lines[0], /\(diagnostic only\)/u, 'the line does not say it is diagnostic only, so a reader takes it for a refusal')
    assert.match(lines[0], /skill-shadowed/u)
    assert.ok(lines[0].includes(ours), 'the line does not name where this plugin placed it')
    assert.ok(lines[0].includes(projectCopy), 'the line does not name the shadowing copy')
  } finally {
    clearPlacement(pinned.home)
  }
})

test('Session-side diagnostic: when this copy wins its own name in the session view, one diagnostic line and no shadow report', async (t) => {
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`needs process isolation: DSH_HOME was overwritten in the shared process by another test file's pin (now points at ${process.env.DSH_HOME}, not this file's ${pinned.home})`)
    return
  }
  const name = 'sw-issue-repair'
  const ours = placeOneSkill(pinned.home, name)
  const rigging = rig()
  try {
    const { ctx, lines } = rigWithCatalog(rigging, () => [
      { name, provider: 'filesystem', source: 'user-dsh', rank: 400, path: ours },
    ])
    const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
    await opened(rigging.agents.created)
    const outcome = await pending

    assert.equal(outcome.ok, true)
    assert.equal(lines.length, 1, `the open should leave one diagnostic line: ${lines.join(' / ')}`)
    assert.match(lines[0], /^info: plugin skills checked/u)
    assert.match(lines[0], /\(diagnostic only\)$/u, 'the line does not say (diagnostic only), so a reader takes it for a verdict')
  } finally {
    clearPlacement(pinned.home)
  }
})


/* ---- the queue holds the workspace-touching stretch only (K: the diagnostic left it) ---- */

test('The catalog diagnostic is off the queue: with the catalog never answering, the next open of the same root still enters create', async (t) => {
  /* Same premise as the two session-side diagnostics above: this case places a skill into the home
   * this file pinned and relies on the opener reading DSH_HOME back from the process environment —
   * once another file's pin overwrites that home, the catalog read never happens and the premise is gone. */
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`needs process isolation: DSH_HOME was overwritten in the shared process by another test file's pin (now points at ${process.env.DSH_HOME}, not this file's ${pinned.home})`)
    return
  }
  const name = 'sw-issue-repair'
  placeOneSkill(pinned.home, name)
  try {
    const rigging = rig({ files: { [promptPath('c1', 'n2')]: '/sw-conduct n2 [pipeline]\n' } })
    let releaseCatalog
    const catalogGate = new Promise((resolve) => { releaseCatalog = resolve })
    let firstSettled = false
    const ctx = {
      ...rigging.ctx,
      get(service) {
        if (service === 'skills') {
          /* The read the session-side diagnostic makes, held open: a catalog that takes its time (or
           * never answers) is exactly the shape the queue must not wait behind. */
          return {
            async list() {
              await catalogGate
              return []
            },
          }
        }
        return rigging.ctx.get(service)
      },
    }
    const first = openNodeSession(ctx, 's1', rigging.root, 'c1', 'n1').then((outcome) => {
      firstSettled = true
      return outcome
    })
    await opened(rigging.agents.created)
    /* The first open is waiting on that one catalog read, outside the queue: the second open of the same root must enter create while it waits. */
    const second = openNodeSession(ctx, 's1', rigging.root, 'c1', 'n2')
    await opened(rigging.agents.created, 2)
    assert.equal(rigging.agents.created.length, 2, 'the catalog diagnostic is off the queue: the next open of the same root still enters create')
    assert.equal(firstSettled, false, 'the first open still waits on the catalog read — the stretch the queue must not hold')
    releaseCatalog()
    const one = await first
    const two = await second
    assert.equal(one.ok, true, JSON.stringify(one))
    assert.equal(two.ok, true, JSON.stringify(two))
  } finally {
    clearPlacement(pinned.home)
  }
})
