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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchCell, installRelay } from '../src/host/relay.ts'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { PANEL_PREF_FIELDS } from '../src/host/settings-fields.ts'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'

/* The engine reads this machine's layer (`<home>/.pf/config.json`) during
 * dispatch preparation; these cases pin it to a temporary home, never the
 * machine's own. The opener's skill-placement read rides the same pin. */
const testHome = mkdtempSync(join(tmpdir(), 'pf-relay-home-'))
const previousHome = process.env.PF_HOME_DIR
const previousDshHome = process.env.DSH_HOME
process.env.PF_HOME_DIR = testHome
process.env.DSH_HOME = testHome
test.after(() => {
  if (previousHome === undefined) delete process.env.PF_HOME_DIR
  else process.env.PF_HOME_DIR = previousHome
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(testHome, { recursive: true, force: true })
})

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

/** The negative wait behind the `wait` assertions: a judge's plan read is a few small file reads, so half a second of drained loop is the honest bound before asserting "still nothing". */
async function drain() {
  await drainFor(500)
}

/** Wait until the fact holds, yielding to the event loop; the wait is bounded by wall clock, because the trigger is fire-and-forget and its work crosses real file IO. */
async function until(check, what, notes = []) {
  const started = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - started > 2000) {
      throw new Error(`等不到：${what}${notes.length > 0 ? `；relay 的读数：${JSON.stringify(notes)}` : ''}`)
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** The negative wait: nothing should happen, so the loop is drained for a wall-clock stretch before the "still nothing" assert. A fire-and-forget trigger has no completion event to await; this is that wait, stated honestly. */
async function drainFor(ms) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

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
function fsPort(root) {
  return {
    async list(_scope, dir) {
      let entries
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true })
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
    async read(_scope, path, range) {
      let text
      try {
        text = await readFile(join(root, path), 'utf8')
      } catch {
        throw absentError(path)
      }
      /* The real gateway moves lines, not bytes: a Windows CRLF record arrives
       * with its carriers stripped, so the prompt line arrives bare. */
      return readPage(text.split('\r\n').join('\n'), range)
    },
  }
}

/** The host context stand-in: services by name, an event bus, a logger the relay's refusals land on, and the settings surface the switch is read from (the object is shared, so a flip is seen live). */
function fakeContext({ root, agents, config } = {}) {
  const listeners = new Map()
  const warnings = []
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
  return {
    ctx: {
      workspaceFiles: fsPort(root),
      sessions: { get: () => ({ header: { cwd: root } }) },
      sandboxPolicy: { workspaceRoot: root },
      ...(config === undefined ? {} : { config }),
      logger: {
        warn: (line) => warnings.push(line),
      },
      get(name) {
        if (name === 'sessions') return {}
        if (name === 'agents') return agents.registry
        return undefined
      },
      on: bus.on,
    },
    events: bus,
    warnings,
  }
}

test('派发落认领：会话开出来，started 标记在盘上，会话档也落了', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = fakeContext({ root, agents })
  try {
    const outcome = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(agents.created.length, 1, '恰好一个会话')
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-1')), '认领随派发落盘')
    assert.ok(existsSync(join(root, '.pf', 'meta', 'sessions', 'n-1.json')), '会话档由开会话方写')
    const said = agents.created[0].followups[0]
    assert.ok(existsSync(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt')), '提示由派发准备落盘')
    /* 首条指令对的是盘上那份产物，不锁 pf-core 的措辞：opener 发的就是派发准备落在
     * prompt.txt 里的那一行，读出来比对即可——身份（节点 id、[pipeline]）随盘上产物锁住。 */
    const prompt = (await readFile(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt'), 'utf8')).trim()
    assert.equal(said.content[0].text, prompt, '首条指令是盘上那份派发提示')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('并发两次只开一个会话：第二个调用读到认领，不再建第二条', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = fakeContext({ root, agents })
  try {
    const [one, two] = await Promise.all([
      dispatchCell(ctx, 'caller', root, 'c-1', 'n-1'),
      dispatchCell(ctx, 'caller', root, 'c-1', 'n-1'),
    ])
    assert.equal(one.ok, true, JSON.stringify(one))
    assert.equal(two.ok, true, JSON.stringify(two))
    assert.equal(agents.created.length, 1, '同一格并发两次，恰好一个会话')
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-1')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('触发：自己开的会话收尾，计划说 dispatch，下一棒自己开出来', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx, events, warnings } = fakeContext({ root, agents })
  const installOff = installRelay(ctx)
  try {
    /* 第一棒由按钮那条路开出来：会话进入宿主自己的追踪表。 */
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(agents.created.length, 1)

    /* 收尾中途的轮次结束：认领在盘上，计划说 wait，不开下一棒。 */
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await drain()
    assert.equal(agents.created.length, 1, '计划说 wait 时什么都不开')

    /* 收尾落地（关节点、下一格钉进手里）：图与线就是收尾后的样子。 */
    await settleClose(root, 'n-1', 'n-2')

    /* 收尾后的轮次结束：计划说 dispatch，下一棒自己开出来，全程无按钮。 */
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      '下一棒的会话与它的认领',
      warnings,
    )
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-2')), '下一棒的认领随派发落盘')
    const second = agents.created[1]
    const promptNext = (await readFile(join(root, '.pf', 'meta', 'launch', 'c-1', 'n-2', 'prompt.txt'), 'utf8')).trim()
    assert.equal(second.followups[0].content[0].text, promptNext, '下一棒的首条指令是盘上那份派发提示')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('注册先于回合结束：本棒在途时它的 turn/end 就该被接力听到（长首回合形态）', async () => {
  const root = rigRecordRoot(['n-1'])
  let releaseIdle
  const idleGate = new Promise((give) => { releaseIdle = give })
  const agents = fakeAgents({ idleGate })
  const { ctx, events, warnings } = fakeContext({ root, agents })
  const installOff = installRelay(ctx)
  try {
    /* 第一棒在途：首条指令已进，回合被 gate 挂着——dispatch 尚未返回。 */
    const pending = dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    await until(
      () => agents.created.length >= 1 && agents.created[0].followups.length === 1,
      '首条指令进箱',
      warnings,
    )
    const sid = agents.created[0].options.sessionId

    /* 本棒在途时收尾落地，轮次结束来了：此刻 tracked 必须已登记，接力才开得出下一棒。 */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: sid }, { type: 'turn/end' })

    /* 下一棒排在本棒之后（进程级串行链）；松开回合，本棒返回，接力这一棒才落地。 */
    releaseIdle()
    const first = await pending
    assert.equal(first.ok, true, JSON.stringify(first))
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      '下一棒的会话与它的认领',
      warnings,
    )
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-2')), '下一棒的认领随派发落盘')
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('开关关掉：turn/end 来了也不开下一棒；开关打开后同一事件照开，按钮那条路不受开关管', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  /* The line's resolved config rides apply's second argument; the volatile
   * field arrives as a stable reference whose get() answers the snapshot —
   * the shape the real host hands over, pinned here. */
  let snapshot = false
  const config = { [PANEL_PREF_FIELDS.autoRelay]: { get: () => snapshot } }
  const { ctx, events, warnings } = fakeContext({ root, agents })
  const installOff = installRelay(ctx, config)
  try {
    /* 按钮那条路不受开关管：第一棒照常开出来，会话进追踪表。 */
    const first = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(agents.created.length, 1)

    /* 收尾落地：此刻的计划会说 dispatch——但开关关着。 */
    await settleClose(root, 'n-1', 'n-2')
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await drain()
    assert.equal(agents.created.length, 1, '开关关掉，触发不出会话')

    /* 开关的快照翻到开：下一次轮次结束照常接力——读的是当下那份快照，不重载。 */
    snapshot = true
    events.emit('session/event', { id: first.session }, { type: 'turn/end' })
    await until(
      () => agents.created.length >= 2 && existsSync(claimPath(root, 'c-1', 'n-2')),
      '开关打开后开出的下一棒与它的认领',
      warnings,
    )
  } finally {
    installOff()
    rmSync(root, { recursive: true, force: true })
  }
})

test('按钮走同一条路：网关的 openNodeSession 端点一样落认领', async () => {
  const root = rigRecordRoot(['n-1'])
  const agents = fakeAgents()
  const { ctx } = fakeContext({ root, agents })
  try {
    const gateway = new PathfinderRecordsGateway(ctx)
    const outcome = await gateway.openNodeSession('caller', '', 'c-1', 'n-1')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(agents.created.length, 1)
    assert.ok(existsSync(claimPath(root, 'c-1', 'n-1')), '按钮那一次派发同样把认领落在盘上')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('格子派发不成：拒绝带引擎的原话，认领不落盘，一个会话都没建', async () => {
  const root = rigRecordRoot([])
  const agents = fakeAgents()
  const { ctx } = fakeContext({ root, agents })
  try {
    const outcome = await dispatchCell(ctx, 'caller', root, 'c-1', 'n-1')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'dispatch-refused')
    assert.ok((outcome.detail ?? '').length > 0, '拒绝句带着引擎说的原话')
    assert.equal(agents.created.length, 0)
    assert.ok(!existsSync(claimPath(root, 'c-1', 'n-1')), '没有会话就没有认领')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
