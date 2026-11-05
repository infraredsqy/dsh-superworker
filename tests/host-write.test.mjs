/* The write plane: what each panel write lands in the record, and what comes back with it.
 *
 * This layer assembles no JSON of its own: every write is answered in this process by the engine's
 * words layer — the same `answer()` the agent-facing tool calls — so this file pins effects, not
 * command lines. Against a throwaway project, each of the six endpoints lands or changes its record
 * on disk and answers with the engine's own sentence; a refusal comes back as `tool-refused` with
 * that sentence in `detail`, and the two inputs this layer refuses by itself (an empty sentence, a
 * scope outside the three) never reach the records at all.
 *
 * The user's verbatim sentence is one argument, quotes and `&` included: there is no command line
 * between the panel and the engine for anything to be read off.
 *
 *   node --test tests/
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, open } from 'pf-core'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { shippedPluginsDir } from '../src/host/skills.ts'

/* One machine layer for this file. The global settings layer lives in the home directory, and
 * `PF_HOME_DIR` is the engine's own switch for it: a test may not read the developer's own home. */
const home = mkdtempSync(join(tmpdir(), 'pf-host-write-home-'))
process.env.PF_HOME_DIR = home
after(() => rmSync(home, { recursive: true, force: true }))

/** A throwaway project: `.pf` laid down by the engine itself, closed again when the case is done. */
async function project() {
  const root = mkdtempSync(join(tmpdir(), 'pf-host-write-'))
  await open(root).ledger.init()
  return {
    root,
    done() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The words layer's own seams for a project: the root it answers at, and the plugins this package ships. */
function ioOf(root) {
  return { root, pluginsDir: shippedPluginsDir() }
}

/**
 * The instruction record as it sits on disk. A project with no such file has no entries, which is a
 * reading rather than an error: "nothing was written" is exactly what the refusal cases assert.
 */
function instructionsOnDisk(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.pf', 'instructions.json'), 'utf8')).instructions ?? []
  } catch {
    return []
  }
}

/** The entry carrying exactly this sentence, or `undefined` when the write did not land. */
function instructionSaying(root, text) {
  return instructionsOnDisk(root).find((entry) => entry.text === text)
}

/** The project settings file as it sits on disk; `init` lays an empty object and writes add to it. */
function configOnDisk(root) {
  return JSON.parse(readFileSync(join(root, '.pf', 'config.json'), 'utf8'))
}

/**
 * A minimal host context: the session stands in the named project, and no process gateway exists at
 * all. Asking for one throws — a write that reached for a command would fail right here.
 */
function fakeContext(workspaceRoot) {
  return {
    workspaceFiles: {},
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    get(service) {
      if (service === 'subprocess') throw new Error('this host exposes no process gateway, and the write path must not ask for one')
      return undefined
    },
  }
}

test('记下一条：原话整句落进记录，回来的就是引擎那一句', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const said = '先看一眼记录再动手 & 别猜 "引号" 也在'
    const outcome = await gateway.addInstruction('s1', '', said, 'global', '', '')

    assert.equal(outcome.ok, true, '记一条这次要成')
    assert.match(outcome.text, /^INSTRUCTION \S+: \[global\/stage\] 先看一眼记录再动手 & 别猜 "引号" 也在$/u, '回来的是引擎自己那一行')
    const landed = instructionSaying(stage.root, said)
    assert.ok(landed !== undefined, '原话整句必须原样落在记录里')
    assert.equal(landed.scope, 'global')
    assert.equal(landed.state, 'live', '新记下的是在用的那一条')
  } finally {
    stage.done()
  }
})

test('点名一个工作区：这一笔落在那个根上，不看这条会话自己落在哪儿', async () => {
  const mine = await project()
  const other = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(mine.root))
    const outcome = await gateway.addInstruction('s1', other.root, '这一句写给别人', 'global', '', '')

    assert.equal(outcome.ok, true, outcome.detail)
    assert.ok(instructionSaying(other.root, '这一句写给别人') !== undefined, '点名的那个根上要有这一条')
    assert.deepEqual(instructionsOnDisk(mine.root), [], '这条会话自己那个根上一个字都不该多')
  } finally {
    mine.done()
    other.done()
  }
})

test('绑一格：点名的那个节点落进记录，句子里的位置也指着它', async () => {
  const stage = await project()
  try {
    const io = ioOf(stage.root)
    const added = await answer(['dag', 'add', '这一格先停下'], io)
    assert.equal(added.code, 0, added.stderr)
    const nodes = JSON.parse(readFileSync(join(stage.root, '.pf', 'ideas.json'), 'utf8')).nodes
    const node = Object.keys(nodes).find((id) => nodes[id].title === '这一格先停下')
    assert.ok(node !== undefined, '种子节点没落进图里')

    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const outcome = await gateway.addInstruction('s1', '', '这一格先停下', 'node', '', node)

    assert.equal(outcome.ok, true, outcome.detail)
    const landed = instructionSaying(stage.root, '这一格先停下')
    assert.equal(landed.scope, 'node')
    assert.equal(landed.node, node, '绑的是点名那一格')
    assert.equal(
      outcome.text,
      `INSTRUCTION ${landed.id}: [node/stage] 这一格先停下   @ ${node.slice(0, 8)}`,
      '回来的那一行是引擎自己那一句，绑的那一格在句尾',
    )
  } finally {
    stage.done()
  }
})

test('归档一条：记录留在盘上，状态换成 withdrawn', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    await gateway.addInstruction('s1', '', '归档我', 'global', '', '')
    const id = instructionSaying(stage.root, '归档我').id

    const outcome = await gateway.archiveInstruction('s1', '', id)

    assert.equal(outcome.ok, true, outcome.detail)
    assert.equal(outcome.text, `INSTRUCTION ${id} → withdrawn`)
    const archived = instructionSaying(stage.root, '归档我')
    assert.equal(archived.state, 'withdrawn', '归档只改状态：记录与句子都还在')
    assert.equal(archived.id, id)
  } finally {
    stage.done()
  }
})

test('复原一条：归档那条回到在用', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    await gateway.addInstruction('s1', '', '放回去', 'global', '', '')
    const id = instructionSaying(stage.root, '放回去').id
    await gateway.archiveInstruction('s1', '', id)

    const outcome = await gateway.reviveInstruction('s1', '', id)

    assert.equal(outcome.ok, true, outcome.detail)
    assert.equal(outcome.text, `INSTRUCTION ${id} → live`)
    assert.equal(instructionSaying(stage.root, '放回去').state, 'live')
  } finally {
    stage.done()
  }
})

test('删一条：句子与记录一起走，回来的尾巴是 REMOVED', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    await gateway.addInstruction('s1', '', '这条我要删', 'global', '', '')
    const id = instructionSaying(stage.root, '这条我要删').id

    const outcome = await gateway.removeInstruction('s1', '', id)

    assert.equal(outcome.ok, true, outcome.detail)
    assert.match(outcome.text, new RegExp(`REMOVED ${id}$`, 'u'))
    assert.equal(instructionSaying(stage.root, '这条我要删'), undefined, '删一条不留句子')
    assert.deepEqual(instructionsOnDisk(stage.root), [], '记录里一条都不剩')
  } finally {
    stage.done()
  }
})

test('写一个设置：项目那一层落盘，回来的是引擎印的那两行', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const outcome = await gateway.setConfig('s1', '', 'worktree_mode', 'reuse')

    assert.equal(outcome.ok, true, outcome.detail)
    assert.match(outcome.text, /^CONFIG: worktree_mode = reuse \(written to project \.pf\/config\.json\)$/mu, '写进去的那一行')
    assert.match(outcome.text, /^CONFIG: effective worktree_mode = reuse \(from project \.pf\/config\.json\)$/mu, '第二行是生效值')
    assert.equal(configOnDisk(stage.root).worktree_mode, 'reuse', '落的是项目那一层')
  } finally {
    stage.done()
  }
})

test('读设置：引擎印的每一行解析成表，成功那一支不塞拒绝理由', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    await gateway.setConfig('s1', '', 'worktree_mode', 'fork')

    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.equal(reading.workspaceRoot, stage.root, '读的是这个工作区的根')
    assert.equal(reading.refusal, null)
    assert.ok(reading.text.length > 0, '成功那一支带着引擎印的那几行')
    assert.deepEqual(reading.entries['worktree_mode'], { value: 'fork', layer: 'project' }, '项目那一层写的值在这儿')
    assert.equal(reading.entries['max_agents']?.layer, 'default', '没写过的键读作出厂默认')
  } finally {
    stage.done()
  }
})

test('全局那一层：家目录那份写下的值读成 global，这一手不认错层', async () => {
  const stage = await project()
  try {
    /* The machine layer, written the way a person would: the engine reads `<PF_HOME_DIR>/.pf/config.json`,
     * and only the words layer's own `config list` can say this value came from there. */
    mkdirSync(join(home, '.pf'), { recursive: true })
    writeFileSync(join(home, '.pf', 'config.json'), `${JSON.stringify({ max_agents: 3 })}\n`)
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))

    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.deepEqual(reading.entries['max_agents'], { value: '3', layer: 'global' }, '家目录那份压过出厂默认，层签读作 global')
  } finally {
    rmSync(join(home, '.pf'), { recursive: true, force: true })
    stage.done()
  }
})

test('空话与不认识的范围当场说清，记录一个字都不动', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const blank = await gateway.addInstruction('s1', '', '   ', 'global', '', '')
    const odd = await gateway.addInstruction('s1', '', '一句话', 'everywhere', '', '')

    assert.deepEqual(blank, { ok: false, code: 'empty-text' }, '空话没有可记的东西')
    assert.deepEqual(odd, { ok: false, code: 'scope-unknown', detail: 'everywhere' }, '不认识的范围把它本身放进 detail')
    assert.deepEqual(instructionsOnDisk(stage.root), [], '两条都没落到盘上')
  } finally {
    stage.done()
  }
})

test('引擎非零作答：ok 是假，detail 是它自己那一句，记录不改', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const outcome = await gateway.archiveInstruction('s1', '', 'i-nope')

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail, /i-nope/u, '引擎自己说了是哪个 id：那句原样回来，不替它翻译')
  } finally {
    stage.done()
  }
})

test('值合不合法由引擎判：它拒绝的那一句原样回来，盘上什么都不留', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const outcome = await gateway.setConfig('s1', '', 'max_agents', '0')

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail, /max_agents/u)
    assert.match(outcome.detail, /positive integer/u, '引擎自己的判据原样在 detail 里')
    assert.equal(configOnDisk(stage.root).max_agents, undefined, '被拒的那一笔一个字都没写下去')
  } finally {
    stage.done()
  }
})

test('没登记的键照递：这一手不立放行表，拒的是引擎', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext(stage.root))
    const outcome = await gateway.setConfig('s1', '', 'spawner', 'dsh')

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail, /spawner/u, '键名在这句话里')
    assert.equal(configOnDisk(stage.root).spawner, undefined, '不认识的键落不了盘')
  } finally {
    stage.done()
  }
})