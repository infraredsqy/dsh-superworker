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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, open } from 'pf-core'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { configOnDisk, project as throwaway } from './helpers/pf-project.mjs'

/* One machine layer for this file. The global settings layer lives in the home directory, and
 * `PF_HOME_DIR` is the engine's own switch for it: a test may not read the developer's own home. */
const pinned = pinHome(['PF_HOME_DIR'], 'pf-host-write-home-')
after(pinned.restore)

/** A throwaway project: `.pf` laid down by the engine itself, closed again when the case is done. */
const project = () => throwaway('pf-host-write-')

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

/**
 * A minimal host context: the session stands in the named project, and no process gateway exists at
 * all. Asking for one throws — a write that reached for a command would fail right here.
 */
const context = (workspaceRoot) => fakeContext({
  root: workspaceRoot,
  absent: { subprocess: 'this host exposes no process gateway, and the write path must not ask for one' },
}).ctx

test('Recording one: the whole sentence lands in the record, and the engine\'s own line comes back', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const said = 'look at the record before acting & do not guess "quotes" in here'
    const outcome = await gateway.addInstruction('s1', '', said, 'global', '', '')

    assert.equal(outcome.ok, true, 'this one must succeed')
    assert.match(outcome.text, /^INSTRUCTION \S+: \[global\/stage\] look at the record before acting & do not guess "quotes" in here$/u, 'the engine\'s own line comes back')
    const landed = instructionSaying(stage.root, said)
    assert.ok(landed !== undefined, 'the whole sentence must land in the record as it was')
    assert.equal(landed.scope, 'global')
    assert.equal(landed.state, 'live', 'the newly recorded one is the live one')
  } finally {
    stage.done()
  }
})

test('Naming a workspace: the write lands on that root, wherever this session itself sits', async () => {
  const mine = await project()
  const other = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(mine.root))
    const outcome = await gateway.addInstruction('s1', other.root, 'this one is for somebody else', 'global', '', '')

    assert.equal(outcome.ok, true, outcome.detail)
    assert.ok(instructionSaying(other.root, 'this one is for somebody else') !== undefined, 'the named root must hold this entry')
    assert.deepEqual(instructionsOnDisk(mine.root), [], 'not one character more under this session\'s own root')
  } finally {
    mine.done()
    other.done()
  }
})

test('Binding a cell: the named node lands in the record, and the sentence\'s target points at it', async () => {
  const stage = await project()
  try {
    const io = ioOf(stage.root)
    const added = await answer(['dag', 'add', 'this cell stops here'], io)
    assert.equal(added.code, 0, added.stderr)
    const nodes = JSON.parse(readFileSync(join(stage.root, '.pf', 'ideas.json'), 'utf8')).nodes
    const node = Object.keys(nodes).find((id) => nodes[id].title === 'this cell stops here')
    assert.ok(node !== undefined, 'the seed node did not land in the graph')

    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const outcome = await gateway.addInstruction('s1', '', 'this cell stops here', 'node', '', node)

    assert.equal(outcome.ok, true, outcome.detail)
    const landed = instructionSaying(stage.root, 'this cell stops here')
    assert.equal(landed.scope, 'node')
    assert.equal(landed.node, node, 'it binds the named cell')
    assert.equal(
      outcome.text,
      `INSTRUCTION ${landed.id}: [node/stage] this cell stops here   @ ${node.slice(0, 8)}`,
      'the line back is the engine\'s own, with the bound cell at its tail',
    )
  } finally {
    stage.done()
  }
})

test('Archiving one: the record stays on disk, the state becomes withdrawn', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    await gateway.addInstruction('s1', '', 'archive me', 'global', '', '')
    const id = instructionSaying(stage.root, 'archive me').id

    const outcome = await gateway.archiveInstruction('s1', '', id)

    assert.equal(outcome.ok, true, outcome.detail)
    assert.equal(outcome.text, `INSTRUCTION ${id} → withdrawn`)
    const archived = instructionSaying(stage.root, 'archive me')
    assert.equal(archived.state, 'withdrawn', 'archiving changes state only: record and sentence both stay')
    assert.equal(archived.id, id)
  } finally {
    stage.done()
  }
})

test('Reviving one: the archived entry goes back to live', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    await gateway.addInstruction('s1', '', 'put it back', 'global', '', '')
    const id = instructionSaying(stage.root, 'put it back').id
    await gateway.archiveInstruction('s1', '', id)

    const outcome = await gateway.reviveInstruction('s1', '', id)

    assert.equal(outcome.ok, true, outcome.detail)
    assert.equal(outcome.text, `INSTRUCTION ${id} → live`)
    assert.equal(instructionSaying(stage.root, 'put it back').state, 'live')
  } finally {
    stage.done()
  }
})

test('Removing one: the sentence goes with the record, and the tail back is REMOVED', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    await gateway.addInstruction('s1', '', 'delete this one', 'global', '', '')
    const id = instructionSaying(stage.root, 'delete this one').id

    const outcome = await gateway.removeInstruction('s1', '', id)

    assert.equal(outcome.ok, true, outcome.detail)
    assert.match(outcome.text, new RegExp(`REMOVED ${id}$`, 'u'))
    assert.equal(instructionSaying(stage.root, 'delete this one'), undefined, 'removing leaves no sentence')
    assert.deepEqual(instructionsOnDisk(stage.root), [], 'not one entry is left in the record')
  } finally {
    stage.done()
  }
})

test('Writing a setting: it lands on the project layer, and the engine\'s two printed lines come back', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const outcome = await gateway.setConfig('s1', '', 'worktree_mode', 'reuse')

    assert.equal(outcome.ok, true, outcome.detail)
    assert.match(outcome.text, /^CONFIG: worktree_mode = reuse \(written to project \.pf\/config\.json\)$/mu, 'the line that was written')
    assert.match(outcome.text, /^CONFIG: effective worktree_mode = reuse \(from project \.pf\/config\.json\)$/mu, 'the second line is the effective value')
    assert.equal(configOnDisk(stage.root).worktree_mode, 'reuse', 'it lands on the project layer')
  } finally {
    stage.done()
  }
})

test('Reading settings: every line the engine printed parses into the table, and the success branch carries no refusal', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    await gateway.setConfig('s1', '', 'worktree_mode', 'fork')

    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.equal(reading.workspaceRoot, stage.root, 'reads this workspace root')
    assert.equal(reading.refusal, null)
    assert.ok(reading.text.length > 0, 'the success branch carries the lines the engine printed')
    assert.deepEqual(reading.entries['worktree_mode'], { value: 'fork', layer: 'project' }, 'the value written to the project layer is here')
    assert.equal(reading.entries['max_agents']?.layer, 'default', 'an unwritten key reads as the factory default')
  } finally {
    stage.done()
  }
})

test('The global layer: a value written into the home copy reads as global, and this hand misreads no layer', async () => {
  const stage = await project()
  try {
    /* The machine layer, written the way a person would: the engine reads `<PF_HOME_DIR>/.pf/config.json`,
     * and only the words layer's own `config list` can say this value came from there. */
    mkdirSync(join(pinned.home, '.pf'), { recursive: true })
    writeFileSync(join(pinned.home, '.pf', 'config.json'), `${JSON.stringify({ max_agents: 3 })}\n`)
    const gateway = new PathfinderRecordsGateway(context(stage.root))

    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.deepEqual(reading.entries['max_agents'], { value: '3', layer: 'global' }, 'the home copy outranks the factory default, the layer tag reads global')
  } finally {
    rmSync(join(pinned.home, '.pf'), { recursive: true, force: true })
    stage.done()
  }
})

test('An empty sentence and an unknown scope are settled on the spot, and the record moves not one character', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const blank = await gateway.addInstruction('s1', '', '   ', 'global', '', '')
    const odd = await gateway.addInstruction('s1', '', 'one sentence', 'everywhere', '', '')

    assert.deepEqual(blank, { ok: false, code: 'empty-text' }, 'an empty sentence has nothing to record')
    assert.deepEqual(odd, { ok: false, code: 'scope-unknown', detail: 'everywhere' }, 'an unknown scope puts itself into detail')
    assert.deepEqual(instructionsOnDisk(stage.root), [], 'neither landed on disk')
  } finally {
    stage.done()
  }
})

test('A non-zero engine answer: ok is false, detail is its own sentence, the record unchanged', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const outcome = await gateway.archiveInstruction('s1', '', 'i-nope')

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail, /i-nope/u, 'the engine itself said which id: that sentence comes back as it was, no translation on its behalf')
  } finally {
    stage.done()
  }
})

test('Whether a value is legal is the engine\'s call: the sentence it refuses comes back as it was, nothing stays on disk', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const outcome = await gateway.setConfig('s1', '', 'max_agents', '0')

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail, /max_agents/u)
    assert.match(outcome.detail, /positive integer/u, 'the engine\'s own verdict stays in detail as it was')
    assert.equal(configOnDisk(stage.root).max_agents, undefined, 'not one character of the refused write went down')
  } finally {
    stage.done()
  }
})

test('An unregistered key is still handed over: this side keeps no allow-list, the engine refuses', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(context(stage.root))
    const outcome = await gateway.setConfig('s1', '', 'spawner', 'dsh')

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail, /spawner/u, 'the key name is in that sentence')
    assert.equal(configOnDisk(stage.root).spawner, undefined, 'an unknown key never lands on disk')
  } finally {
    stage.done()
  }
})
