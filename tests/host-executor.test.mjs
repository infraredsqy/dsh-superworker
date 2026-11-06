/* The host half's native executor: locks in the facts an open must not miss.
 *
 * The open runs against stand-ins for the host's own services (the session side, the workspace
 * registry, the workspace files port, the event bus), so the cases here judge the flow, not a
 * deployment: the session is created under the workspace root and attached to that workspace when
 * the host carries one, the plan's launch prompt is the first instruction verbatim, the note is
 * written by the engine's writer, the two host versions settle differently and both settle, a
 * missing agent registry is refused with the piece named, and two opens aimed at one workspace
 * create their sessions one after another.
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
import { PATHFINDER_TOOL_NAME } from '../src/host/tool.ts'
import { pinHome } from './helpers/env.mjs'
import { until, flush } from './helpers/wait.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'

/* Opening a session also reads the placement record under the DSH home to confirm the skills the
 * plugins placed against this workspace's own catalog view. These cases exercise the opener's flow,
 * not that placement, so the home they read is pinned to a temp one here — never the machine's own. */
const pinned = pinHome(['DSH_HOME'], 'pf-executor-home-')
test.after(pinned.restore)

/** One cell's plan line, the way the dispatch preparation writes it: one line, nothing after it. */
const PROMPT_LINE = '/pf-conduct n1 [pipeline]'
/* In the dict it wears its trailing newline, the way the file sits on disk; the port moves lines, not bytes, so the line arrives without that terminator. */
const PROMPT = `${PROMPT_LINE}\n`

/** The dict key the port reads the prompt from. */
const promptPath = (cycle, node) => `.pf/meta/launch/${cycle}/${node}/prompt.txt`

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
  await until(() => created.length >= count, `第 ${count} 个 create`)
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
        timer = setTimeout(() => reject(new Error(`等不到：${what}（上限 ${ms} ms）`)), ms)
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
 * The session-side stand-in: every create is recorded (options, the messages handed over, its
 * `whenIdle` release), and each create may be held on a gate so a test controls when it lands.
 * `idleRefusal` makes the wait interface's own answer a rejection whenever consulted — the
 * rejection is handled from the moment it is minted, so the case carries no timing.
 */
function fakeAgents({ withWhenIdle = true, gate, idleRefusal } = {}) {
  const created = []
  return {
    created,
    registry: {
      create(options) {
        const record = { options, followups: [], registered: [], sequence: [], whenIdle: defer() }
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
            },
          },
          followup(message) {
            record.sequence.push('followup')
            record.followups.push(message)
          },
          ...(idleRefusal !== undefined
            ? { whenIdle: () => Promise.reject(idleRefusal) }
            : withWhenIdle
              ? { whenIdle: () => record.whenIdle.promise }
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
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-'))
  const dict = { ...files }
  if (prompt !== null) dict[promptPath(cycle, node)] = prompt
  const agents = fakeAgents(rest)
  const { ctx, events } = context({ files: dict, agents: agents.registry, sessions: {}, ...rest })
  return { root, cycle, node, agents, ctx, events }
}

/** The note the opener writes for one node, as it is on disk. */
function noteOnDisk(root, node) {
  return JSON.parse(readFileSync(join(root, '.pf', 'meta', 'sessions', `${node}.json`), 'utf8'))
}

/**
 * One root under a second spelling: a directory junction over it, which an ordinary user may mint
 * on Windows and which resolves to the target through `realpath` — the shape a symlinked home or a
 * short (8.3) name puts in front of the opener. Taken back with `rmSync`, which removes the link and
 * never what it points at.
 */
function aliasOf(root) {
  const alias = join(tmpdir(), `pf-executor-alias-${randomUUID()}`)
  symlinkSync(root, alias, 'junction')
  return alias
}

test('探测：代理登记不在，点名 agents 拒绝，什么都没建', async () => {
  const agents = fakeAgents()
  const { ctx } = context({ files: {}, agents })
  const noAgents = { ...ctx, get(name) { return name === 'sessions' ? {} : undefined } }
  const outcome = await openNodeSession(noAgents, 's1', 'C:\\ws', 'c1', 'n1')
  assert.deepEqual(outcome, { ok: false, code: 'no-session-service', detail: 'agents' })
  assert.equal(agents.created.length, 0)
})

test('归组与首条指令：会话建在工作区根下，计划的提示原话先进去', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.meta.cwd, realpathSync(rigging.root), 'cwd 得是这个工作区的根：界面按它归组')
  assert.equal(typeof record.options.sessionId, 'string')
  assert.ok(record.options.sessionId.length > 0, '会话身份是开的时候新铸的')
  assert.equal(record.followups.length, 1, '首条指令恰好一条')
  const said = record.followups[0]
  assert.equal(said.role, 'user')
  assert.equal(said.source.kind, 'user')
  assert.equal(said.content[0].type, 'text')
  assert.equal(said.content[0].text, PROMPT_LINE, '首条指令就是计划那一句，一字不改')
})

test('归组与挂接：宿主带工作区服务时，开出的会话挂到根所在的那个工作区上', async () => {
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
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.deepEqual(created, [realpathSync(rigging.root)], '服务按根要的就是那个工作区')
  assert.deepEqual(attached, [rigging.agents.created[0].options.sessionId], '开出来的会话挂上去')
})

test('归组与挂接：宿主没有工作区服务时照旧开成，只留一行说会话没能挂上', async () => {
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
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(lines.length, 1, `一行读数：${lines.join(' / ')}`)
  assert.match(lines[0], /^warn: could not attach/u)
  assert.ok(lines[0].includes(`${rigging.cycle}/${rigging.node}`), '读数点名哪一格')
  assert.ok(lines[0].includes(realpathSync(rigging.root)), '读数点名哪个工作区')
  assert.ok(existsSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json')), '会话照常开成、档照常落')
})

test('归组与挂接：会话已经开出来、宿主才拒了挂接，降级成只带工作目录并留一行读数', async () => {
  const lines = []
  const workspaceRegistry = {
    async create() {
      return {
        async attachSession() {
          /* 真实宿主的拒绝句里带着会话身份，这个替身照它那样带：拒绝句本身不许把身份递给读者。 */
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
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending

  assert.equal(outcome.ok, true, '会话已经在里头了：挂不上不是把这一棒判失败的理由')
  assert.equal(outcome.session, rigging.agents.created[0].options.sessionId)
  assert.equal(lines.length, 1, `一条读数：${lines.join(' / ')}`)
  assert.match(lines[0], /^warn: could not attach/u, '读数点名挂不上')
  assert.ok(lines[0].includes(`${rigging.cycle}/${rigging.node}`), '读数点名哪一格')
  assert.ok(lines[0].includes(realpathSync(rigging.root)), '读数点名哪个工作区')
  assert.ok(lines[0].includes('session-abc'), '读数里留着宿主说的原因')
  assert.ok(lines[0].includes('cwd-only'), '读数说清会话降级成只带工作目录')
  assert.equal(rigging.agents.created[0].followups.length, 1, '首条指令照常进箱：会话不因为没分组就空转')
  assert.ok(
    existsSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json')),
    '降级之后会话档照常落：不会是没纸的孤儿',
  )
})

test('规范拼写：从另一种写法开进来的会话，cwd 与挂接用的都是实路径', async () => {
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
    assert.notEqual(alias, real, '这个场景得有两种不同的写法')
    const pending = openNodeSession(rigging.ctx, 's1', alias, rigging.cycle, rigging.node)
    await opened(rigging.agents.created)
    rigging.agents.created[0].whenIdle.resolve()
    const outcome = await pending
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(
      rigging.agents.created[0].options.meta.cwd,
      real,
      '会话头里的 cwd 是实路径：工作区层 realpath 之后要跟记录对得上',
    )
    assert.deepEqual(created, [real], '工作区服务按实路径要那个工作区，不是调用方这一种写法')
    assert.ok(existsSync(join(real, '.pf', 'meta', 'sessions', `${rigging.node}.json`)), '会话档落在同一个根下')
  } finally {
    rmSync(alias, { recursive: true, force: true })
    assert.ok(existsSync(rigging.root), '收走别名不带走它指的根')
  }
})

test('规范拼写：一个根两种写法排同一条线，第二个开等第一个开完才进 create', async () => {
  /* 两个 open 同时起：哪一格先进 create 由到达顺序决定，用例等的是「create 被调到了」这件事。 */
  const doors = createDoors()
  const rigging = rig({
    files: { [promptPath('c1', 'n2')]: '/pf-conduct n2 [pipeline]\n' },
    gate: doors.gate,
  })
  const alias = aliasOf(rigging.root)
  try {
    const first = openNodeSession(rigging.ctx, 's1', rigging.root, 'c1', 'n1')
    const second = openNodeSession(rigging.ctx, 's1', alias, 'c1', 'n2')
    await bounded(doors.arrived(0), '第一格进 create')
    /* 两种写法是同一个根：线上只该有一格，另一格还排着。 */
    await flush()
    assert.equal(rigging.agents.created.length, 1, '两种写法是同一个根：第二个还排在线上，没进 create')
    doors.release(0)
    rigging.agents.created[0].whenIdle.resolve()
    await bounded(doors.arrived(1), '第一格排完，第二格这才进 create')
    assert.equal(rigging.agents.created.length, 2, '线松了第二个这才进 create')
    doors.release(1)
    rigging.agents.created[1].whenIdle.resolve()
    const outcomes = await bounded(Promise.all([first, second]), '两次开都结算')
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome))
  } finally {
    rmSync(alias, { recursive: true, force: true })
    assert.ok(existsSync(rigging.root), '收走别名不带走它指的根')
  }
})

/* The name says what this case asserts: the fallback spelling. The other half of the old name —
 * 「不为一种写法拒绝开会话」— is pinned by the two cases above, where an open through a junction
 * spelling comes back `ok` with the real path in hand. */
test('规范拼写：取不到实路径的根照原样交回', async () => {
  const missing = join(tmpdir(), `pf-executor-missing-${randomUUID()}`)
  assert.equal(await canonicalWorkspaceRoot(missing), missing)
})

test('会话档由开会话方写：run 里多了这一条，别的条目原样留着', async () => {
  const before = {
    v: 1,
    discussion: [{ session: 'session-talk', host: 'zcode', at: '2026-10-01T00:00:00Z' }],
    run: [{ session: 'session-old', host: 'dsh', at: '2026-10-02T00:00:00Z' }],
  }
  const rigging = rig({ files: {}, node: 'n1' })
  mkdirSync(join(rigging.root, '.pf', 'meta', 'sessions'), { recursive: true })
  writeFileSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json'), JSON.stringify(before))
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const note = noteOnDisk(rigging.root, 'n1')
  assert.equal(note.v, 1)
  assert.deepEqual(note.discussion, before.discussion, 'discussion 原样留着（zcode 的 host 字不改写）')
  assert.equal(note.run.length, 2)
  assert.deepEqual(note.run[0], before.run[0], '旧 run 条目原样留着')
  const added = note.run[1]
  assert.equal(added.session, rigging.agents.created[0].options.sessionId)
  assert.equal(added.host, 'dsh')
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(added.at), '时刻是秒级那一种拼写')
})

test('会话档那页读不得时不算拦路：坏页换成一页写得成的', async () => {
  const rigging = rig({ node: 'n1' })
  mkdirSync(join(rigging.root, '.pf', 'meta', 'sessions'), { recursive: true })
  writeFileSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json'), '{broken')
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const note = noteOnDisk(rigging.root, 'n1')
  assert.deepEqual(note.discussion, [])
  assert.equal(note.run.length, 1)
  assert.equal(note.run[0].session, rigging.agents.created[0].options.sessionId)
})

test('结算那一条，等接口这版：whenIdle 应了才算开成', async () => {
  const rigging = rig({ withWhenIdle: true })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  assert.equal(rigging.agents.created.length, 1, '队列里这一步先落到 create')
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(outcome.session, rigging.agents.created[0].options.sessionId)
})

test('结算那一条，等接口这版：等的人喊停，会话在外头，拒绝点名格子、不带会话身份', async () => {
  const rigging = rig({ withWhenIdle: true })
  const stop = new AbortController()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node, { signal: stop.signal })
  await opened(rigging.agents.created)
  stop.abort(new Error('caller gave up'))
  const outcome = await pending
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'open-failed')
  const detail = outcome.detail ?? ''
  assert.ok(detail.includes(`${rigging.cycle}/${rigging.node}`), '拒绝句点名的是格子：线／节点')
  assert.ok(
    !detail.includes(rigging.agents.created[0].options.sessionId),
    '会话身份留在 outcome 的地址位上，拒绝句交给格子来点名',
  )
  assert.ok(detail.includes('caller gave up'))
  assert.ok(existsSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json')), '会话档已经落了：会话在外头，纸上得有它')
  rigging.agents.created[0].whenIdle.resolve()
})

test('结算那一条，等接口这版：等接口自己报错，拒绝带原因，会话档已在盘', async () => {
  const rigging = rig({ idleRefusal: new Error('wait interface blew up') })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'open-failed')
  assert.ok((outcome.detail ?? '').includes('wait interface blew up'), '拒绝句带着等接口报的原话')
  assert.ok(
    !(outcome.detail ?? '').includes(rigging.agents.created[0].options.sessionId),
    '会话身份留在 outcome 的地址位上，拒绝句交给格子来点名',
  )
  assert.ok(existsSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json')), '会话在外头：档已落盘')
})

test('结算那一条，老宿主这版：轮次结束加空闲通知，两样都见了才应', async () => {
  const rigging = rig({ withWhenIdle: false })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  const agent = rigging.agents.created[0].agent
  const session = { id: rigging.agents.created[0].options.sessionId }
  /* 空闲通知先来：轮次还没完，不应。 */
  rigging.events.emit('agent/status', { agent, status: 'idle' })
  await flush()
  assert.ok(pending instanceof Promise)
  /* 别的会话的轮次结束：不应。 */
  rigging.events.emit('session/event', { id: 'session-other' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  await flush()
  /* 这一条会话自己的轮次结束：两样都齐了，应。 */
  rigging.events.emit('session/event', session, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
})

test('结算那一条，老宿主这版：会话没等到轮次就被拆了，也放行', async () => {
  const rigging = rig({ withWhenIdle: false })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.events.emit('agent/disposed', { agent: rigging.agents.created[0].agent })
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
})

test('同一条工作区的线：两个开严格一前一后，都开成', async () => {
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT, [promptPath('c1', 'n2')]: '/pf-conduct n2 [pipeline]\n' }
/* 同一条线的先后由到达顺序决定：用例等「create 被调到了」，不替两个 open 排先后。 */
  const doors = createDoors()
  const agents = fakeAgents({ gate: doors.gate })
  const { ctx } = context({ files, agents: agents.registry, sessions: {} })
  const first = openNodeSession(ctx, 's1', root, 'c1', 'n1')
  const second = openNodeSession(ctx, 's1', root, 'c1', 'n2')
  await bounded(doors.arrived(0), '第一格进 create')
  await flush()
  assert.equal(agents.created.length, 1, '线上只有一格在 create：另一格还排着')
  doors.release(0)
  agents.created[0].whenIdle.resolve()
  await bounded(doors.arrived(1), '第一格排完，第二格这才进 create')
  assert.equal(agents.created.length, 2, '线松了，第二个这才进 create')
  doors.release(1)
  agents.created[1].whenIdle.resolve()
  const outcomes = await bounded(Promise.all([first, second]), '两次开都结算')
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.notEqual(agents.created[0].options.sessionId, agents.created[1].options.sessionId, '两个会话各是各的身份')
  assert.ok(existsSync(join(root, '.pf', 'meta', 'sessions', 'n1.json')))
  assert.ok(existsSync(join(root, '.pf', 'meta', 'sessions', 'n2.json')))
})

test('同一条工作区的线：一个拒绝毒不死下一条，第二个照常开成', async () => {
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT, [promptPath('c1', 'n2')]: '/pf-conduct n2 [pipeline]\n' }
  const agents = fakeAgents({
    gate: (_record, index) => (index === 0 ? Promise.reject(new Error('create blew up')) : Promise.resolve()),
  })
  const { ctx } = context({ files, agents: agents.registry, sessions: {} })
  const one = await openNodeSession(ctx, 's1', root, 'c1', 'n1')
  assert.equal(one.ok, false)
  assert.equal(one.code, 'open-failed')
  assert.ok((one.detail ?? '').includes('create blew up'), '拒绝句带着 create 报的原话')
  const two = openNodeSession(ctx, 's1', root, 'c1', 'n2')
  await opened(agents.created, 2)
  assert.equal(agents.created.length, 2, '线还活着：第二个照常进了 create')
  agents.created[1].whenIdle.resolve()
  const outcome = await two
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.ok(existsSync(join(root, '.pf', 'meta', 'sessions', 'n2.json')), '第二个的会话档照常落盘')
})

test('不同工作区不排队：两边的 create 都进了才谈结算', async () => {
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const rootA = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-b-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT }
  const holds = [defer(), defer()]
  let taken = 0
  const agents = fakeAgents({ gate: () => holds[taken++].promise })
  const { ctx } = context({ files, agents: agents.registry, sessions: {} })
  const one = openNodeSession(ctx, 's1', rootA, 'c1', 'n1')
  const two = openNodeSession(ctx, 's1', rootB, 'c1', 'n1')
  await opened(agents.created, 2)
  assert.equal(agents.created.length, 2, '两条线各走各的：两边都进了 create')
  holds[0].resolve()
  holds[1].resolve()
  for (const record of agents.created) record.whenIdle.resolve()
  assert.equal((await one).ok, true)
  assert.equal((await two).ok, true)
})

test('派发提示不在：点名拒绝，什么都没建也没写', async () => {
  const rigging = rig({ prompt: null })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'prompt-missing')
  assert.equal(rigging.agents.created.length, 0)
  assert.ok(!existsSync(join(rigging.root, '.pf', 'meta', 'sessions', `${rigging.node}.json`)), '没有会话就没有会话档')
})

test('派发提示整页是空白：也算没有，拒绝而不开一个空会话', async () => {
  const rigging = rig({ prompt: '   \n' })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'prompt-missing')
  assert.equal(rigging.agents.created.length, 0)
})

test('格子名当不了路：带分隔符或自指的那两级，参数门先拦下', async () => {
  for (const [cycle, node] of [['c1', '..'], ['c1/x', 'n1'], ['', 'n1'], ['c1', '.']]) {
    const rigging = rig()
    const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, cycle, node)
    assert.equal(outcome.ok, false, `${cycle}/${node} 得拦下`)
    assert.equal(outcome.code, 'arg-not-allowed', `${cycle}/${node} 拦的理由是参数这一道`)
    assert.equal(rigging.agents.created.length, 0)
  }
})

test('部署里带着默认模型选择：新会话照它开', async () => {
  const rigging = rig({ defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  await pending
  assert.deepEqual(rigging.agents.created[0].options.agentOptions, { provider: 'deepseek', model: 'chat' })
})

test('部署里没有默认模型选择：agentOptions 不带，由循环自己的默认接手', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  await pending
  assert.equal(rigging.agents.created[0].options.agentOptions, undefined)
})

/* ---- the standing preset the open composes through ---- */

test('构图：宿主带着 preset 名册时，会话按在册默认 preset 合成，挂载随 setup 进 create', async () => {
  const mounted = []
  const agentPresets = {
    async resolve() { return { id: 'standard-persona' } },
    async mount(_agentCtx, id) { mounted.push(id) },
  }
  const rigging = rig({ agentPresets })
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.meta.agentPreset, 'standard-persona', '在册 preset 的身份落进会话元数据')
  assert.equal(typeof record.options.setup, 'function', 'create 带着 composition setup')
  await record.options.setup({}, record.agent)
  assert.deepEqual(mounted, ['standard-persona'], 'setup 挂的是 resolve 出来的那一个 id')
})

test('构图：宿主没有 preset 名册时照旧开成，不带 setup 也不写 agentPreset', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.setup, undefined, '没有名册就没有 setup')
  assert.equal(record.options.meta.agentPreset, undefined, '没有名册就不写 preset 身份')
})

test('构图：preset 解析拒了，open 按 open-failed 落地带原因，什么都没建', async () => {
  const agentPresets = {
    async resolve() { throw new Error('roster blew up') },
    async mount() { throw new Error('mount must not be reached') },
  }
  const rigging = rig({ agentPresets })
  const outcome = await openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'open-failed')
  assert.ok((outcome.detail ?? '').includes('roster blew up'), '拒绝句带着名册报的原话')
  assert.equal(rigging.agents.created.length, 0, '解析失败的 open 一个代理都不建')
  assert.ok(
    !existsSync(join(rigging.root, '.pf', 'meta', 'sessions', `${rigging.node}.json`)),
    '没有会话就没有会话档',
  )
})

/* ---- the session's own tool, armed by the opener ---- */

test('唤醒：open 出的会话在首条指令进箱前就被装上 pathfinder 工具，恰好一次', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await opened(rigging.agents.created)
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.registered.length, 1, '注册恰好一次')
  assert.equal(record.registered[0].name, PATHFINDER_TOOL_NAME, '注册的就是 pathfinder 这一个工具')
  assert.deepEqual(record.sequence, ['register', 'followup'], '工具先进 scope，首条指令后进')
})

test('唤醒：会话没有可注册的工具面时，open 照常开成（wake 按契约沉默）', async () => {
  // bespoke: an agent whose ctx has no tools service
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-'))
  let made
  const bareAgents = {
    create(options) {
      const record = { options, followups: [], whenIdle: defer() }
      made = record
      const agent = {
        id: options.sessionId,
        status: 'idle',
        ctx: {},
        followup(message) { record.followups.push(message) },
        whenIdle: () => record.whenIdle.promise,
      }
      record.agent = agent
      return Promise.resolve({ agent, dispose: async () => {} })
    },
  }
  const { ctx } = context({ files: { [promptPath('c1', 'n1')]: PROMPT }, agents: bareAgents, sessions: {} })
  const pending = openNodeSession(ctx, 's1', root, 'c1', 'n1')
  await until(() => made !== undefined, 'bare agent 进 create')
  made.whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
})

/* ---- the dispatch seam's drill switch ---- */

test('派发接缝的演练档：请求带 dryRun 时只回演练回执，登记里一个代理都没建', async () => {
  const rigging = rig()
  const executor = executorOf(rigging.ctx, 's1', rigging.root)
  const receipt = await executor.dispatch({
    cycle: rigging.cycle,
    node: rigging.node,
    prompt: PROMPT,
    dryRun: true,
  })
  assert.deepEqual(receipt, { host: 'drill' }, '演练回执只说这是一次演练，不带会话身份')
  assert.equal(rigging.agents.created.length, 0, '演练扫不到任何开会话的调用')
  assert.ok(
    !existsSync(join(rigging.root, '.pf', 'meta', 'sessions', `${rigging.node}.json`)),
    '演练也不写会话档',
  )
})

test('派发接缝的演练档：请求不带 dryRun 时照常开会话，回执带着会话身份', async () => {
  const rigging = rig()
  const executor = executorOf(rigging.ctx, 's1', rigging.root)
  const pending = executor.dispatch({ cycle: rigging.cycle, node: rigging.node, prompt: PROMPT })
  await opened(rigging.agents.created)
  assert.equal(rigging.agents.created.length, 1, '普通派发照常进 create')
  rigging.agents.created[0].whenIdle.resolve()
  const receipt = await pending
  assert.equal(receipt.host, 'dsh')
  assert.equal(receipt.sessionId, rigging.agents.created[0].options.sessionId)
})

/* ---- the session-side diagnostic of the placed skills (K4) ---- */

/* The three diagnostic cases below (the two 会话侧诊断 ones, and the 目录诊断 one that holds the
 * catalog open) require process isolation. They place a skill into the temp home this file pinned
 * (`placeOneSkill`) and then rely on the opener reading `DSH_HOME` back out of the process
 * environment (`skill-paths.ts` reads it at call time). Under `--test-isolation=none` every test
 * file shares one process, and a later file's own home pin overwrites that environment before these
 * cases run — the premise is gone, through no fault of the opener. So each of the three checks the
 * premise first and skips itself with that reason when it does not hold; the default tier (one
 * child process per file) never sees it trip. */

/** One placement record plus the two files it names, in the temp home these cases read. */
function placeOneSkill(name) {
  const root = join(pinned.home, 'skills')
  const ours = join(root, name, 'SKILL.md')
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(ours, `---\nname: ${name}\ndescription: placed by the plugin\n---\n\n# ${name}\n`, 'utf8')
  mkdirSync(join(pinned.home, 'pathfinder'), { recursive: true })
  writeFileSync(
    join(pinned.home, 'pathfinder', 'skills.json'),
    JSON.stringify({ version: 1, root, skills: [{ name, dir: name, files: [`${name}/SKILL.md`] }] }),
    'utf8',
  )
  return ours
}

/** Take the record back off the temp home, so the next case starts with this line having placed nothing. */
function clearPlacement() {
  rmSync(join(pinned.home, 'pathfinder'), { recursive: true, force: true })
  rmSync(join(pinned.home, 'skills'), { recursive: true, force: true })
}

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

test('会话侧诊断：project 根同名副本压过插件这份时，开会话只留一行 skill-shadowed 读数并点名两处', async (t) => {
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`要求进程隔离：DSH_HOME 在共享进程里被别的测试文件的 pin 盖掉了（现在指向 ${process.env.DSH_HOME}，不是本文件的 ${pinned.home}）`)
    return
  }
  const name = 'pf-issue-repair'
  const ours = placeOneSkill(name)
  const rigging = rig()
  const projectCopy = join(rigging.root, '.dsh', 'skills', name, 'SKILL.md')
  try {
    const { ctx, lines } = rigWithCatalog(rigging, (options) => {
      /* The view a session reads: cwd named, the session's own scope passed through. */
      assert.equal(options.cwd, rigging.root, '会话视角的读回丢了 workspace')
      assert.ok(options.scope !== undefined, '会话视角的读回丢了 scope')
      return [{ name, provider: 'filesystem', source: 'project-dsh', rank: 100, path: projectCopy }]
    })
    const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
    await opened(rigging.agents.created)
    rigging.agents.created[0].whenIdle.resolve()
    const outcome = await pending

    assert.equal(outcome.ok, true, '遮蔽读数不许把开会话弄失败')
    assert.equal(lines.length, 1, `开会话该留一行读数：${lines.join(' / ')}`)
    assert.match(lines[0], /^warn: plugin skills shadowed/u)
    assert.match(lines[0], /\(diagnostic only\)/u, '读数没写明它只是诊断，读者会误把它当拒绝面')
    assert.match(lines[0], /skill-shadowed/u)
    assert.ok(lines[0].includes(ours), '读数没写出插件自己放的那一处')
    assert.ok(lines[0].includes(projectCopy), '读数没写出遮蔽方的那一处')
  } finally {
    clearPlacement()
  }
})

test('会话侧诊断：这份在会话视角里赢了自己的名字时，只留一行诊断读数，不报影子', async (t) => {
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`要求进程隔离：DSH_HOME 在共享进程里被别的测试文件的 pin 盖掉了（现在指向 ${process.env.DSH_HOME}，不是本文件的 ${pinned.home}）`)
    return
  }
  const name = 'pf-issue-repair'
  const ours = placeOneSkill(name)
  const rigging = rig()
  try {
    const { ctx, lines } = rigWithCatalog(rigging, () => [
      { name, provider: 'filesystem', source: 'user-dsh', rank: 400, path: ours },
    ])
    const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
    await opened(rigging.agents.created)
    rigging.agents.created[0].whenIdle.resolve()
    const outcome = await pending

    assert.equal(outcome.ok, true)
    assert.equal(lines.length, 1, `开会话该留一行诊断读数：${lines.join(' / ')}`)
    assert.match(lines[0], /^info: plugin skills checked/u)
    assert.match(lines[0], /\(diagnostic only\)$/u, '读数没写明 (diagnostic only)，读者会误把它当验收结论')
  } finally {
    clearPlacement()
  }
})


/* ---- the queue holds the workspace-touching stretch only (K: the diagnostic left it) ---- */

test('目录诊断不在队列里：catalog 读不回来时，同一个根的下一次开照常进 create', async (t) => {
  /* 与上面两条会话侧诊断同一个前提：这一格把技能放进本文件 pin 的 home，再靠开仓那一侧把
   * DSH_HOME 从进程环境读回来——home 被同进程别的文件的 pin 盖掉时，开仓压根不会走到目录读，
   * 断言的前提（第一开卡在目录读上）就不在了。要求进程隔离，见本段开头的说明。 */
  if (process.env.DSH_HOME !== pinned.home) {
    t.skip(`要求进程隔离：DSH_HOME 在共享进程里被别的测试文件的 pin 盖掉了（现在指向 ${process.env.DSH_HOME}，不是本文件的 ${pinned.home}）`)
    return
  }
  const name = 'pf-issue-repair'
  placeOneSkill(name)
  try {
    const rigging = rig({ files: { [promptPath('c1', 'n2')]: '/pf-conduct n2 [pipeline]\n' } })
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
    rigging.agents.created[0].whenIdle.resolve()
    /* 第一开已经交回队列、正在等那一次目录读：第二次开同一个根，必须在它等着的这段时间里进 create。 */
    const second = openNodeSession(ctx, 's1', rigging.root, 'c1', 'n2')
    await opened(rigging.agents.created, 2)
    assert.equal(rigging.agents.created.length, 2, '目录诊断在队列外：同一个根的下一次开照常进 create')
    assert.equal(firstSettled, false, '第一开仍在等目录读——这条线正是旧写法把队列堵住的那一段')
    rigging.agents.created[1].whenIdle.resolve()
    releaseCatalog()
    const one = await first
    const two = await second
    assert.equal(one.ok, true, JSON.stringify(one))
    assert.equal(two.ok, true, JSON.stringify(two))
  } finally {
    clearPlacement()
  }
})
