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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNodeSession } from '../src/host/executor.ts'
import { executorOf } from '../src/host/relay.ts'
import { fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'

/* Opening a session also reads the placement record under the DSH home to confirm the skills the
 * plugins placed against this workspace's own catalog view. These cases exercise the opener's flow,
 * not that placement, so the home they read is pinned to a temp one here — never the machine's own. */
const testHome = mkdtempSync(join(tmpdir(), 'pf-executor-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = testHome
test.after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(testHome, { recursive: true, force: true })
})

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

/** Let the queued stretches schedule: one macrotask beats every pending microtask hop. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
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
        const record = { options, followups: [], whenIdle: defer() }
        created.push(record)
        const agent = {
          id: options.sessionId,
          status: 'idle',
          followup(message) { record.followups.push(message) },
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

/** The host context stand-in: services by name, the port as a property, and an event bus with `on`/`emit`. `sessions` is passed as-is: the store is an inject requirement, and a stand-in that omits it still opens. */
function fakeContext({ files, agents, sessions, defaultModel, workspaceRegistry } = {}) {
  const listeners = new Map()
  const bus = {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
  }
  const ctx = {
    workspaceFiles: fakeWorkspaceFiles(files),
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'agents') return agents
      if (name === 'agentDefaultModel') return defaultModel
      if (name === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    on: bus.on,
  }
  return { ctx, events: bus }
}

/** A real workspace root for the note the opener writes, with the plan prompt in the port's dict. `prompt: null` means the cell has none. */
function rig({ files = {}, node = 'n1', cycle = 'c1', prompt = PROMPT, ...rest } = {}) {
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-'))
  const dict = { ...files }
  if (prompt !== null) dict[promptPath(cycle, node)] = prompt
  const agents = fakeAgents(rest)
  const { ctx, events } = fakeContext({ files: dict, agents: agents.registry, sessions: {}, ...rest })
  return { root, cycle, node, agents, ctx, events }
}

/** The note the opener writes for one node, as it is on disk. */
function noteOnDisk(root, node) {
  return JSON.parse(readFileSync(join(root, '.pf', 'meta', 'sessions', `${node}.json`), 'utf8'))
}

test('探测：代理登记不在，点名 agents 拒绝，什么都没建', async () => {
  const agents = fakeAgents()
  const { ctx } = fakeContext({ files: {}, agents })
  const noAgents = { ...ctx, get(name) { return name === 'sessions' ? {} : undefined } }
  const outcome = await openNodeSession(noAgents, 's1', 'C:\\ws', 'c1', 'n1')
  assert.deepEqual(outcome, { ok: false, code: 'no-session-service', detail: 'agents' })
  assert.equal(agents.created.length, 0)
})

test('归组与首条指令：会话建在工作区根下，计划的提示原话先进去', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await flush()
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  const record = rigging.agents.created[0]
  assert.equal(record.options.meta.cwd, rigging.root, 'cwd 得是这个工作区的根：界面按它归组')
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
  await flush()
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.deepEqual(created, [rigging.root], '服务按根要的就是那个工作区')
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
  await flush()
  rigging.agents.created[0].whenIdle.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(lines.length, 1, `一行读数：${lines.join(' / ')}`)
  assert.match(lines[0], /^warn: could not attach/u)
  assert.ok(lines[0].includes(`${rigging.cycle}/${rigging.node}`), '读数点名哪一格')
  assert.ok(lines[0].includes(rigging.root), '读数点名哪个工作区')
  assert.ok(existsSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json')), '会话照常开成、档照常落')
})

test('归组与挂接：会话挂不上时拒绝为 open-failed，说清哪一格开着而没挂上', async () => {
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
  const outcome = await openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'open-failed')
  const detail = outcome.detail ?? ''
  assert.ok(detail.includes(`${rigging.cycle}/${rigging.node}`), '拒绝句点名的是格子')
  assert.ok(detail.includes('not attached'), '拒绝句说清会话没挂上')
  assert.ok(!detail.includes('attach blew up'), '宿主那句原话不原样递给读者')
  assert.ok(!detail.includes(rigging.agents.created[0].options.sessionId), '会话身份留在 outcome 的地址位上')
  assert.equal(lines.length, 1, `原话进日志：${lines.join(' / ')}`)
  assert.ok(lines[0].includes('session-abc'), '日志里留着宿主说的原因')
  assert.ok(
    !existsSync(join(rigging.root, '.pf', 'meta', 'sessions', 'n1.json')),
    '没挂上的会话不落档',
  )
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
  await flush()
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
  await flush()
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
  await flush()
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
  await flush()
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
  await flush()
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
  await flush()
  rigging.events.emit('agent/disposed', { agent: rigging.agents.created[0].agent })
  const outcome = await pending
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
})

test('同一条工作区的线：两个开严格一前一后，都开成', async () => {
  mkdirSync(join(tmpdir(), 'pf-executor-'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'pf-executor-', 'ws-'))
  const files = { [promptPath('c1', 'n1')]: PROMPT, [promptPath('c1', 'n2')]: '/pf-conduct n2 [pipeline]\n' }
  const holds = [defer(), defer()]
  let taken = 0
  const agents = fakeAgents({ gate: () => holds[taken++].promise })
  const { ctx } = fakeContext({ files, agents: agents.registry, sessions: {} })
  const first = openNodeSession(ctx, 's1', root, 'c1', 'n1')
  const second = openNodeSession(ctx, 's1', root, 'c1', 'n2')
  await flush()
  assert.equal(agents.created.length, 1, '第一个在 create 上拿着线，第二个还没进')
  holds[0].resolve()
  agents.created[0].whenIdle.resolve()
  const one = await first
  assert.equal(one.ok, true, JSON.stringify(one))
  await flush()
  assert.equal(agents.created.length, 2, '线松了，第二个这才进 create')
  holds[1].resolve()
  agents.created[1].whenIdle.resolve()
  const two = await second
  assert.equal(two.ok, true, JSON.stringify(two))
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
  const { ctx } = fakeContext({ files, agents: agents.registry, sessions: {} })
  const one = await openNodeSession(ctx, 's1', root, 'c1', 'n1')
  assert.equal(one.ok, false)
  assert.equal(one.code, 'open-failed')
  assert.ok((one.detail ?? '').includes('create blew up'), '拒绝句带着 create 报的原话')
  const two = openNodeSession(ctx, 's1', root, 'c1', 'n2')
  await flush()
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
  const { ctx } = fakeContext({ files, agents: agents.registry, sessions: {} })
  const one = openNodeSession(ctx, 's1', rootA, 'c1', 'n1')
  const two = openNodeSession(ctx, 's1', rootB, 'c1', 'n1')
  await flush()
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
  await flush()
  rigging.agents.created[0].whenIdle.resolve()
  await pending
  assert.deepEqual(rigging.agents.created[0].options.agentOptions, { provider: 'deepseek', model: 'chat' })
})

test('部署里没有默认模型选择：agentOptions 不带，由循环自己的默认接手', async () => {
  const rigging = rig()
  const pending = openNodeSession(rigging.ctx, 's1', rigging.root, rigging.cycle, rigging.node)
  await flush()
  rigging.agents.created[0].whenIdle.resolve()
  await pending
  assert.equal(rigging.agents.created[0].options.agentOptions, undefined)
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
  await flush()
  assert.equal(rigging.agents.created.length, 1, '普通派发照常进 create')
  rigging.agents.created[0].whenIdle.resolve()
  const receipt = await pending
  assert.equal(receipt.host, 'dsh')
  assert.equal(receipt.sessionId, rigging.agents.created[0].options.sessionId)
})

/* ---- the session-side diagnostic of the placed skills (K4) ---- */

/** One placement record plus the two files it names, in the temp home these cases read. */
function placeOneSkill(name) {
  const root = join(testHome, 'skills')
  const ours = join(root, name, 'SKILL.md')
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(ours, `---\nname: ${name}\ndescription: placed by the plugin\n---\n\n# ${name}\n`, 'utf8')
  mkdirSync(join(testHome, 'pathfinder'), { recursive: true })
  writeFileSync(
    join(testHome, 'pathfinder', 'skills.json'),
    JSON.stringify({ version: 1, root, skills: [{ name, dir: name, files: [`${name}/SKILL.md`] }] }),
    'utf8',
  )
  return ours
}

/** Take the record back off the temp home, so the next case starts with this line having placed nothing. */
function clearPlacement() {
  rmSync(join(testHome, 'pathfinder'), { recursive: true, force: true })
  rmSync(join(testHome, 'skills'), { recursive: true, force: true })
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

test('会话侧诊断：project 根同名副本压过插件这份时，开会话只留一行 skill-shadowed 读数并点名两处', async () => {
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
    await flush()
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

test('会话侧诊断：这份在会话视角里赢了自己的名字时，只留一行诊断读数，不报影子', async () => {
  const name = 'pf-issue-repair'
  const ours = placeOneSkill(name)
  const rigging = rig()
  try {
    const { ctx, lines } = rigWithCatalog(rigging, () => [
      { name, provider: 'filesystem', source: 'user-dsh', rank: 400, path: ours },
    ])
    const pending = openNodeSession(ctx, 's1', rigging.root, rigging.cycle, rigging.node)
    await flush()
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
