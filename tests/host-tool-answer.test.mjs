/* The tool's answering contracts (L2): the four byte locks, help in a project with no
 * records, `dag list` byte parity with the command line, the composed help page's byte
 * parity with the engine's own answer (help does not drop args), the long-answer pointer,
 * the invariant that every write the panel can do has a word in the table, and a whole
 * dispatch carried by the words layer alone — the call the tool itself makes, with a
 * simulated opener and no command line behind it.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { answer, open } from 'pf-core'
import { apply } from '../src/host/index.ts'
import { shippedPluginsDir } from '../src/host/skills.ts'
import { PATHFINDER_TOOL_NAME, toolDescriptionOf, wakeAgent } from '../src/host/tool.ts'
import { fakeContext } from './helpers/host-context.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const shippedPlugins = join(repo, 'packages', 'pf-core', 'plugins')

/** A stand-in host context whose sessions resolve nowhere, so the tool reads the sandbox root. */
const contextOver = (workspaceRoot) => fakeContext({
  sandboxRoot: workspaceRoot,
  bus: true,
  provide: true,
  effect: true,
}).ctx

/** The tool registered into a fresh agent's scope over the given workspace. */
function toolOver(workspaceRoot) {
  const ctx = contextOver(workspaceRoot)
  const registered = []
  const agent = {
    id: 'agent-tool',
    ctx: {
      tools: { register: (definition) => (registered.push(definition), () => undefined) },
      effect: () => undefined,
    },
  }
  wakeAgent(agent, { ctx })
  assert.equal(registered.length, 1)
  return registered[0]
}

/** A temp pf project with the given node titles on the graph. */
async function projectWith(titles) {
  const root = mkdtempSync(join(tmpdir(), 'pf-tool-answer-'))
  const pf = open(root)
  await pf.ledger.init()
  for (const title of titles) await pf.ledger.dag.add({ title })
  return {
    root,
    done() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('字节锁一：工具描述 ≤400 字节', () => {
  const bytes = Buffer.byteLength(toolDescriptionOf(), 'utf8')
  assert.ok(bytes <= 400, `${bytes} bytes`)
})

test('字节锁二：整张索引 ≤2600 字节，且它就是顶层清单的文本', async () => {
  const tool = toolOver('C:\\no-such-workspace')
  const answer = await tool.execute({ help: true }, { agent: { id: 'agent-tool' } })
  assert.equal(answer.code, 0, answer.stderr)
  const bytes = Buffer.byteLength(answer.stdout, 'utf8')
  assert.ok(bytes <= 2600, `${bytes} bytes for the index`)
  assert.match(answer.stdout, /pathfinder -- the agent pipeline/u)
})

test('字节锁三：单词页 ≤4096 字节（最大的那一页也锁）', async () => {
  const tool = toolOver('C:\\no-such-workspace')
  for (const word of ['plan', 'settle', 'advance', 'dag', 'cycle', 'config', 'instruction', 'session', 'dispatch', 'handoff', 'init']) {
    const answer = await tool.execute({ help: true, word }, { agent: { id: 'agent-tool' } })
    assert.equal(answer.code, 0, `${word}: ${answer.stderr}`)
    const size = Buffer.byteLength(answer.stdout, 'utf8')
    assert.ok(size <= 4096, `${word}: ${size} bytes`)
  }
})

test('字节锁四：上限常量是 4000，且超限的长结果整份在场、尾部带指针；不超限不带', async () => {
  const { LONG_RESULT_LIMIT, longResultPointerOf } = await import('pf-core')
  assert.equal(LONG_RESULT_LIMIT, 4000)
  assert.equal(longResultPointerOf('x'.repeat(4000), 'dag list'), null, '到上限为止都不带指针')
  assert.match(longResultPointerOf('x'.repeat(4001), 'dag list'), /dag info/u)
  assert.equal(
    longResultPointerOf('好'.repeat(1333), 'dag list'),
    null,
    '3999 字节、1333 字符：按字节量也没过 4000，带指针就是量错了',
  )
  assert.match(
    longResultPointerOf('好'.repeat(1334), 'dag list'),
    /dag info/u,
    '4002 字节、1334 字符：按字节超限才带指针，按字符会放过',
  )
  assert.equal(longResultPointerOf('x'.repeat(4001), 'dag info'), null, '不是长结果词就没有指针')

  const stage = await projectWith(Array.from({ length: 40 }, (_, i) => `node number ${i + 1} with a fairly long title to fill the answer`))
  try {
    const tool = toolOver(stage.root)
    const full = await tool.execute({ word: 'dag', args: ['list'] }, { agent: { id: 'agent-tool' } })
    const fullBytes = Buffer.byteLength(full.stdout, 'utf8')
    assert.ok(fullBytes > 4000, `${fullBytes} bytes — the long case`)
    assert.match(full.stdout, /\(ask `dag info <node id>`[^\n]*\)\n$/u, '尾部一行指针')
    assert.match(full.stdout, /node number 1 /u, '没有截断：第一行还在')
    assert.match(full.stdout, /node number 40 /u, '没有截断：最后一行还在')

    const narrowed = await tool.execute({ word: 'dag', args: ['list', '--limit', '3'] }, { agent: { id: 'agent-tool' } })
    const narrowedBytes = Buffer.byteLength(narrowed.stdout, 'utf8')
    assert.ok(narrowedBytes <= 4000, `${narrowedBytes} bytes`)
    assert.doesNotMatch(narrowed.stdout, /dag info <node id>/u, '不超限就不带指针')
  } finally {
    stage.done()
  }
})

test('没有 .pf 的项目里，word:"help" 照样答出整张索引，不报错', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'pf-tool-bare-'))
  try {
    const tool = toolOver(bare)
    const answer = await tool.execute({ word: 'help' }, { agent: { id: 'agent-tool' } })
    assert.equal(answer.code, 0, answer.stderr)
    assert.match(answer.stdout, /pathfinder -- the agent pipeline/u)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('有 .pf 的项目里，工具的 dag list 与引擎按同一行的应答逐字节同形', async () => {
  const stage = await projectWith(['alpha node', 'beta node', 'gamma node'])
  try {
    const tool = toolOver(stage.root)
    const composed = await tool.execute({ word: 'dag', args: ['list'] }, { agent: { id: 'agent-tool' } })
    assert.equal(composed.code, 0, composed.stderr)
    const engine = await answer(['dag', 'list'], { root: stage.root, pluginsDir: shippedPluginsDir() })
    assert.equal(composed.stdout, engine.stdout, '工具的应答与引擎按同一行的应答逐字节一致')
  } finally {
    stage.done()
  }
})

test('help 叠上 args：工具的应答与引擎按同一 argv 的应答逐字节同形，不是组页', async () => {
  const stage = await projectWith(['alpha node', 'beta node', 'gamma node'])
  try {
    const tool = toolOver(stage.root)
    // The engine reads the same plugin folder the tool registers with: one words layer, one answer.
    const io = { root: stage.root, pluginsDir: shippedPluginsDir() }
    for (const [call, argv] of [
      [{ help: true, word: 'dag', args: ['list'] }, ['dag', 'list', '--help']],
      [{ help: true, word: 'issue', args: ['status'] }, ['issue', 'status', '--help']],
    ]) {
      const composed = await tool.execute(call, { agent: { id: 'agent-tool' } })
      const engine = await answer(argv, io)
      assert.deepEqual(
        { code: composed.code, stdout: composed.stdout, stderr: composed.stderr },
        { code: engine.code, stdout: engine.stdout, stderr: engine.stderr },
        `${JSON.stringify(argv)}: 工具的应答就是引擎按同一行的应答，逐字节一致`,
      )
    }

    // The composed line is the call's own page, not the group page the old spelling asked.
    // `dag list --help` is a real page: the lock below is not vacuous.
    const group = await answer(['dag', '--help'], io)
    const composed = await tool.execute({ help: true, word: 'dag', args: ['list'] }, { agent: { id: 'agent-tool' } })
    assert.match(composed.stdout, /usage: dag list/u)
    assert.notEqual(composed.stdout, group.stdout, 'help + args 问的不是组页')

    // `issue` is a plugin word: what its sub-verb `--help` answers is that plugin's command
    // surface, not this layer's (today that plugin refuses the flag). The lock is the parity —
    // whatever the engine answers for that line, the tool answers the same bytes.
  } finally {
    stage.done()
  }
})

test('面板能做的每个写动作，词表里都有对应的词', async () => {
  const { COMMANDS, GROUPS } = await import('pf-core')
  // The panel's write endpoints, and the line each one runs (the gateway spells them).
  const writes = [
    ['addInstruction', ['instruction', 'add']],
    ['archiveInstruction', ['instruction', 'resolve']],
    ['reviveInstruction', ['instruction', 'revive']],
    ['removeInstruction', ['instruction', 'rm']],
    ['setConfig', ['config', 'set']],
  ]
  for (const [endpoint, argv] of writes) {
    const [group, verb] = argv
    const groupRow = GROUPS[group]
    assert.ok(groupRow !== undefined, `${endpoint}: 词表里没有 ${group} 这一组`)
    assert.ok(
      (groupRow.commands ?? []).some((command) => command.word === verb),
      `${endpoint}: ${group} 组里没有 ${verb} 这个词`,
    )
    assert.ok(COMMANDS[`${group} ${verb}`] !== undefined, `${endpoint}: 叶子行 ${group} ${verb} 不在词表上`)
  }
  // The gateway really walks those five endpoints — the mapping above answers for the
  // class's own write surface, checked here by name.
  const { PathfinderRecordsGateway } = await import('../src/host/gateway.ts')
  for (const [endpoint] of writes) {
    assert.equal(typeof PathfinderRecordsGateway.prototype[endpoint], 'function', `${endpoint} 在网关上`)
  }
})

test('工具注册的名字仍是名字锁那一个', () => {
  const tool = toolOver('C:\\no-such-workspace')
  assert.equal(tool.name, PATHFINDER_TOOL_NAME)
})
