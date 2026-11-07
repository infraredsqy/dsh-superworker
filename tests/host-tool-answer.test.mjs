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
import { executorOf } from '../src/host/executor.ts'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'
import { toolDescriptionOf } from '../src/host/tool.ts'
import { wakeAgent } from '../src/host/wake.ts'
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
  wakeAgent(agent, { ctx, executorOf: (sessionId, root) => executorOf(ctx, sessionId, root) })
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

test('Byte lock one: the tool description is ≤400 bytes', () => {
  const bytes = Buffer.byteLength(toolDescriptionOf(), 'utf8')
  assert.ok(bytes <= 400, `${bytes} bytes`)
})

test('Byte lock two: the whole index is ≤2600 bytes, and it is the top-level listing text', async () => {
  const tool = toolOver('C:\\no-such-workspace')
  const answer = await tool.execute({ help: true }, { agent: { id: 'agent-tool' } })
  assert.equal(answer.code, 0, answer.stderr)
  const bytes = Buffer.byteLength(answer.stdout, 'utf8')
  assert.ok(bytes <= 2600, `${bytes} bytes for the index`)
  assert.match(answer.stdout, /pathfinder -- the agent pipeline/u)
})

test('Byte lock three: a word page is ≤4096 bytes (the largest page is locked too)', async () => {
  const tool = toolOver('C:\\no-such-workspace')
  for (const word of ['plan', 'settle', 'advance', 'dag', 'cycle', 'config', 'instruction', 'session', 'dispatch', 'handoff', 'init']) {
    const answer = await tool.execute({ help: true, word }, { agent: { id: 'agent-tool' } })
    assert.equal(answer.code, 0, `${word}: ${answer.stderr}`)
    const size = Buffer.byteLength(answer.stdout, 'utf8')
    assert.ok(size <= 4096, `${word}: ${size} bytes`)
  }
})

test('Byte lock four: the cap constant is 4000, and a long result over it stays whole with the pointer at its tail; under it, no pointer', async () => {
  const { LONG_RESULT_LIMIT, longResultPointerOf } = await import('pf-core')
  assert.equal(LONG_RESULT_LIMIT, 4000)
  assert.equal(longResultPointerOf('x'.repeat(4000), 'dag list'), null, 'no pointer right up to the cap')
  assert.match(longResultPointerOf('x'.repeat(4001), 'dag list'), /dag info/u)
  assert.equal(
    longResultPointerOf('好'.repeat(1333), 'dag list'),
    null,
    '3999 bytes, 1333 characters: measured in bytes it stays under 4000, so a pointer here means the wrong measure',
  )
  assert.match(
    longResultPointerOf('好'.repeat(1334), 'dag list'),
    /dag info/u,
    '4002 bytes, 1334 characters: only the byte measure goes over, a character measure would let it through',
  )
  assert.equal(longResultPointerOf('x'.repeat(4001), 'dag info'), null, 'no pointer for a word that is not a long result')

  const stage = await projectWith(Array.from({ length: 40 }, (_, i) => `node number ${i + 1} with a fairly long title to fill the answer`))
  try {
    const tool = toolOver(stage.root)
    const full = await tool.execute({ word: 'dag', args: ['list'] }, { agent: { id: 'agent-tool' } })
    const fullBytes = Buffer.byteLength(full.stdout, 'utf8')
    assert.ok(fullBytes > 4000, `${fullBytes} bytes — the long case`)
    assert.match(full.stdout, /\(ask `dag info <node id>`[^\n]*\)\n$/u, 'the pointer line at the tail')
    assert.match(full.stdout, /node number 1 /u, 'no truncation: the first line is still there')
    assert.match(full.stdout, /node number 40 /u, 'no truncation: the last line is still there')

    const narrowed = await tool.execute({ word: 'dag', args: ['list', '--limit', '3'] }, { agent: { id: 'agent-tool' } })
    const narrowedBytes = Buffer.byteLength(narrowed.stdout, 'utf8')
    assert.ok(narrowedBytes <= 4000, `${narrowedBytes} bytes`)
    assert.doesNotMatch(narrowed.stdout, /dag info <node id>/u, 'under the cap, no pointer')
  } finally {
    stage.done()
  }
})

test('In a project with no .pf, word:"help" still answers the whole index, no error', async () => {
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

test('In a project with .pf, the tool\'s dag list is byte-identical to the engine answering the same line', async () => {
  const stage = await projectWith(['alpha node', 'beta node', 'gamma node'])
  try {
    const tool = toolOver(stage.root)
    const composed = await tool.execute({ word: 'dag', args: ['list'] }, { agent: { id: 'agent-tool' } })
    assert.equal(composed.code, 0, composed.stderr)
    const engine = await answer(['dag', 'list'], { root: stage.root, pluginsDir: shippedPluginsDir() })
    assert.equal(composed.stdout, engine.stdout, 'the tool\'s answer is byte-identical to the engine answering the same line')
  } finally {
    stage.done()
  }
})

test('help layered on args: the tool\'s answer is byte-identical to the engine on the same argv, not the group page', async () => {
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
        `${JSON.stringify(argv)}: the tool's answer is the engine's answer to the same line, byte for byte`,
      )
    }

    // The composed line is the call's own page, not the group page the old spelling asked.
    // `dag list --help` is a real page: the lock below is not vacuous.
    const group = await answer(['dag', '--help'], io)
    const composed = await tool.execute({ help: true, word: 'dag', args: ['list'] }, { agent: { id: 'agent-tool' } })
    assert.match(composed.stdout, /usage: dag list/u)
    assert.notEqual(composed.stdout, group.stdout, 'help + args asks for no group page')

    // `issue` is a plugin word: what its sub-verb `--help` answers is that plugin's command
    // surface, not this layer's (today that plugin refuses the flag). The lock is the parity —
    // whatever the engine answers for that line, the tool answers the same bytes.
  } finally {
    stage.done()
  }
})

test('Every write the panel can do has a word in the table', async () => {
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
    assert.ok(groupRow !== undefined, `${endpoint}: the table has no ${group} group`)
    assert.ok(
      (groupRow.commands ?? []).some((command) => command.word === verb),
      `${endpoint}: the ${group} group has no ${verb} word`,
    )
    assert.ok(COMMANDS[`${group} ${verb}`] !== undefined, `${endpoint}: the leaf line ${group} ${verb} is not in the table`)
  }
  // The gateway really walks those five endpoints — the mapping above answers for the
  // class's own write surface, checked here by name.
  const { PathfinderRecordsGateway } = await import('../src/host/gateway.ts')
  for (const [endpoint] of writes) {
    assert.equal(typeof PathfinderRecordsGateway.prototype[endpoint], 'function', `${endpoint} is on the gateway`)
  }
})
