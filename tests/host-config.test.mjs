/* The two endpoints of the config section: locks in "what the engine's printed lines parse into"
 * and "what a write lands on disk".
 *
 * Reading parses the lines the words layer prints; writing hands a `config set` line to that same
 * words layer — keys and values pass through unfiltered for it to judge (an unknown key or a value
 * outside the knob's kind is refused, nothing is written, and its own sentence rides back as
 * `detail`), and no path under `.pf` is assembled locally.
 *
 *   node --test tests/
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { parseConfigList } from '../src/host/project-config.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { configOnDisk, project as throwaway } from './helpers/pf-project.mjs'

/* One machine layer for this file: the global settings layer lives in the home directory, and
 * `PF_HOME_DIR` is the engine's own switch for it — a test may not read the developer's own home. */
const pinned = pinHome(['PF_HOME_DIR'], 'pf-host-config-home-')
after(pinned.restore)

/** The four lines printed by a local `config list`, verbatim. */
const LISTED = [
  'max_agents    = 1（项目 .pf/config.json）',
  'test_tier     = full（项目 .pf/config.json）',
  'worktree_mode = off（项目 .pf/config.json）',
  'issue_repair  = on（出厂默认）',
].join('\n')

/** A throwaway project: `.pf` laid down by the engine itself, closed again when the case is done. */
const project = () => throwaway('pf-host-config-')

test('The four lines printed by the tool: value and the layer it lives in both read out', () => {
  const entries = parseConfigList(LISTED)

  /* The keys are whatever the tool printed: no list is maintained here — what's printed is what's parsed. */
  assert.deepEqual(Object.keys(entries).sort(), ['issue_repair', 'max_agents', 'test_tier', 'worktree_mode'])
  assert.deepEqual(entries['max_agents'], { value: '1', layer: 'project' })
  assert.deepEqual(entries['test_tier'], { value: 'full', layer: 'project' })
  assert.deepEqual(entries['worktree_mode'], { value: 'off', layer: 'project' })
  assert.deepEqual(entries['issue_repair'], { value: 'on', layer: 'default' })
})

test('The global layer: the tool prints the home copy, read as global', () => {
  const entries = parseConfigList('issue_repair  = off（全局 ~/.pf/config.json）')

  assert.deepEqual(entries['issue_repair'], { value: 'off', layer: 'global' })
})

/*
 * The tool has printed its layer tag two ways: the Chinese words inside full-width parentheses, and
 * the English words inside half-width ones. Both are inbound tokens matched against the tool's
 * stdout — never rendered — so this reader accepts either rather than pinning the one the tool
 * happened to print when it was written. Getting this wrong is silent: the parse yields no entries,
 * the panel draws no settings rows, and nothing errors.
 */
test('Both layer-tag spellings read: Chinese names in full-width parentheses, English in half-width', () => {
  const chinese = parseConfigList([
    'max_agents    = 1（项目 .pf/config.json）',
    'issue_repair  = on（出厂默认）',
    'worktree_mode = off（全局 ~/.pf/config.json）',
  ].join('\n'))
  const english = parseConfigList([
    'max_agents    = 1 (project .pf/config.json)',
    'issue_repair  = on (factory default)',
    'worktree_mode = off (global ~/.pf/config.json)',
  ].join('\n'))

  assert.deepEqual(chinese, english, 'both spellings must read into the same table')
  assert.deepEqual(english['max_agents'], { value: '1', layer: 'project' })
  assert.deepEqual(english['issue_repair'], { value: 'on', layer: 'default' })
  assert.deepEqual(english['worktree_mode'], { value: 'off', layer: 'global' })
})

test('Under half-width parentheses an unknown layer name still reads empty — width changes no verdict', () => {
  const entries = parseConfigList('test_tier     = minimal (nobody knows this layer)')

  assert.deepEqual(entries['test_tier'], { value: 'minimal', layer: null })
})

test('An unknown layer name: the line stays, the layer tag stays empty — no layer invented for the tool', () => {
  const entries = parseConfigList('test_tier     = minimal（这一层谁都不认得）')

  assert.deepEqual(entries['test_tier'], { value: 'minimal', layer: null })
})

test('Anything but a setting line is dropped: the extra warning, blank lines, the value-less line', () => {
  const entries = parseConfigList([
    "Warning: C:\\ws\\.pf\\config.json 里的 'spawner' 不是可配的键，已跳过（可配的：issue_repair, max_agents）",
    '',
    'max_agents    = 2（项目 .pf/config.json）',
    'test_tier     = （项目 .pf/config.json）',
  ].join('\n'))

  assert.deepEqual(Object.keys(entries), ['max_agents'])
})

test('A read answers `config list` at this workspace root; the table is the lines it printed', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.equal(reading.workspaceRoot, stage.root, 'reads this session\'s own root')
    assert.equal(reading.refusal, null, 'the success branch carries no refusal')
    assert.deepEqual(reading.entries, parseConfigList(reading.text), 'entries is exactly what text parses into')
    assert.deepEqual(reading.entries['worktree_mode'], { value: 'off', layer: 'default' }, 'unset means the factory default')
    assert.equal(reading.entries['max_agents']?.layer, 'default')
  } finally {
    stage.done()
  }
})

test('A failed read: it says so plainly, invents no line, and the reason is still the engine\'s own', async () => {
  const stage = await project()
  try {
    /* A project settings file that is not JSON: the engine refuses, and its sentence is the detail. */
    writeFileSync(join(stage.root, '.pf', 'config.json'), '{ this is not json')
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readConfig('s1', '')

    /* The reason is a code, and the engine's own words ride along as the detail: those words are not
     * this plugin's to translate, and the panel prints them as they came. */
    assert.equal(reading.ok, false)
    assert.equal(reading.text, '', 'on failure nothing goes into text — that sentence has no language')
    assert.equal(reading.refusal?.code, 'tool-refused')
    assert.ok((reading.refusal?.detail ?? '').length > 0, 'the engine said why; the reason is in detail')
    assert.deepEqual(reading.entries, {})
  } finally {
    stage.done()
  }
})

test('A write: `config set <key> <value>` lands on the project layer (no --global)', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const outcome = await gateway.setConfig('s1', '', 'worktree_mode', 'fork')

    assert.equal(outcome.ok, true, outcome.detail)
    assert.match(outcome.text, /^CONFIG: worktree_mode = fork \(written to project \.pf\/config\.json\)$/mu)
    assert.equal(configOnDisk(stage.root).worktree_mode, 'fork', 'the value lands on the project layer')
  } finally {
    stage.done()
  }
})

test('An unregistered key is still handed over: this side keeps no allow-list, the engine refuses', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const outcome = await gateway.setConfig('s1', '', 'spawner', 'dsh')

    /* The line is still handed over and the engine's refusal surfaces as its own code, with its
     * words in the detail. */
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail ?? '', /spawner/u)
    assert.equal(configOnDisk(stage.root).spawner, undefined, 'an unknown key never lands on disk')
  } finally {
    stage.done()
  }
})