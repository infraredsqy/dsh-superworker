/* The two endpoints of the config section: locks in "what the engine's printed lines parse into",
 * "what a write lands on disk", and "where the reading's candidate words come from".
 *
 * Reading parses the lines the words layer prints; writing hands a `config set` line to that same
 * words layer — keys and values pass through unfiltered for it to judge (an unknown key or a value
 * outside the knob's kind is refused, nothing is written, and its own sentence rides back as
 * `detail`), and no path under `.superworker` is assembled locally. The candidates a dropdown row
 * offers are read off the engine's own declaration, not spelled here: the table this half hands is
 * the declaration read key by key.
 *
 *   node --test tests/
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptedLayers, knobSpecs } from 'superworker-core'
import { SuperworkerRecordsGateway } from '../src/host/gateway.ts'
import { declaredKnobs, parseConfigList, withDeclaredKnobs } from '../src/host/project-config.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { project as throwaway } from './helpers/superworker-project.mjs'

/* One machine layer for this file: the global settings layer lives in the home directory, and
 * `SUPERWORKER_HOME_DIR` is the engine's own switch for it — a test may not read the developer's own home. */
const pinned = pinHome(['SUPERWORKER_HOME_DIR'], 'superworker-host-config-home-')
after(pinned.restore)

/** The four lines printed by a local `config list`, verbatim. */
const LISTED = [
  'max_agents    = 1（项目 .superworker/config.json）',
  'test_tier     = full（项目 .superworker/config.json）',
  'worktree_mode = off（项目 .superworker/config.json）',
  'issue_repair  = on（出厂默认）',
].join('\n')

/** A throwaway project: `.superworker` laid down by the engine itself, closed again when the case is done. */
const project = () => throwaway('superworker-host-config-')

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
  const entries = parseConfigList('issue_repair  = off（全局 ~/.superworker/config.json）')

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
    'max_agents    = 1（项目 .superworker/config.json）',
    'issue_repair  = on（出厂默认）',
    'worktree_mode = off（全局 ~/.superworker/config.json）',
  ].join('\n'))
  const english = parseConfigList([
    'max_agents    = 1 (project .superworker/config.json)',
    'issue_repair  = on (factory default)',
    'worktree_mode = off (global ~/.superworker/config.json)',
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
    "Warning: C:\\ws\\.superworker\\config.json 里的 'spawner' 不是可配的键，已跳过（可配的：issue_repair, max_agents）",
    '',
    'max_agents    = 2（项目 .superworker/config.json）',
    'test_tier     = （项目 .superworker/config.json）',
  ].join('\n'))

  assert.deepEqual(Object.keys(entries), ['max_agents'])
})

test('The cells this half hands are the engine\'s own declaration, read key by key — not a second list', async () => {
  const knobs = await declaredKnobs()
  assert.ok(Object.keys(knobs).length > 0, 'the engine declares at least one knob; an empty table would hand the panel nothing')
  for (const [key, spec] of Object.entries(knobSpecs())) {
    const declared = spec.values === undefined || spec.values.length === 0 ? undefined : [...spec.values]
    assert.deepEqual(knobs[key]?.options, declared, `${key}: the candidates are the declaration's, whatever the declaration says`)
    assert.deepEqual(knobs[key]?.layers, [...acceptedLayers(spec)], `${key}: the layers are the declaration's own`)
  }
})

test('A plugin-declared word knob\'s vocabulary rides the same read: the pipeline plugin\'s answer declares exactly technical / plain', async () => {
  const knobs = await declaredKnobs()

  /* The plugin half reaches this table only through the engine's own declaration read
   * (`declaredKnobSpecs` folded into `knobSpecs`): the values are the shipped declaration's, in its
   * order — a second spelling here would drift from the plugin the engine answers from. */
  assert.deepEqual(knobs['answer']?.options, ['technical', 'plain'], 'the plugin\'s word knob is read off the shipped declaration, not dropped')
})

test('Cells are laid onto the parsed entries: only keys the declaration knows, nothing fabricated for the rest', async () => {
  const knobs = await declaredKnobs()
  const entries = withDeclaredKnobs(parseConfigList(LISTED), knobs)
  assert.deepEqual(entries['worktree_mode'], {
    value: 'off', layer: 'project', options: knobs['worktree_mode'].options, layers: knobs['worktree_mode'].layers,
  })
  assert.deepEqual(entries['test_tier'], {
    value: 'full', layer: 'project', options: knobs['test_tier'].options, layers: knobs['test_tier'].layers,
  })
  assert.deepEqual(entries['max_agents'], {
    value: '1', layer: 'project', layers: knobs['max_agents'].layers,
  }, 'a key with no declared vocabulary carries no candidates, and its layers still ride')
  assert.deepEqual(entries['issue_repair'], { value: 'on', layer: 'default' }, 'a key the tool printed but the declaration does not know is untouched')
  /* A key the declaration knows but the tool never printed gets no entry: cells ride on readings, never stand alone. */
  assert.deepEqual(withDeclaredKnobs({}, knobs), {})
})

test('A read answers `config list` at this workspace root; the table is the lines it printed', async () => {
  const stage = await project()
  try {
    const gateway = new SuperworkerRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.equal(reading.workspaceRoot, stage.root, 'reads this session\'s own root')
    assert.equal(reading.refusal, null, 'the success branch carries no refusal')
    assert.deepEqual(
      reading.entries['worktree_mode'],
      {
        value: 'off', layer: 'default', options: (await declaredKnobs())['worktree_mode'].options, layers: (await declaredKnobs())['worktree_mode'].layers,
      },
      'unset means the factory default, and the declaration\'s cells ride along',
    )
    assert.equal(reading.entries['max_agents']?.layer, 'default')
    assert.equal(reading.entries['max_agents']?.options, undefined, 'a key with no declared vocabulary carries no candidates')
  } finally {
    stage.done()
  }
})

test('A failed read: it says so plainly, invents no line, and the reason is still the engine\'s own', async () => {
  const stage = await project()
  try {
    /* A project settings file that is not JSON: the engine refuses, and its sentence is the detail. */
    writeFileSync(join(stage.root, '.superworker', 'config.json'), '{ this is not json')
    const gateway = new SuperworkerRecordsGateway(fakeContext({ root: stage.root }).ctx)
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

/** A line laid down in state.json, the target of the line door's reads and writes. */
function seedLine(root, cycleId) {
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({
    cycles: [{
      id: cycleId, title: `cycle ${cycleId}`, status: 'active', holding: [], path: [],
      created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z',
    }],
  }, null, 2), 'utf8')
}

test('The line door reads what one line sees, and the write lands in that line\'s own slot', async () => {
  const stage = await project()
  try {
    seedLine(stage.root, 'c1')
    const gateway = new SuperworkerRecordsGateway(fakeContext({ root: stage.root }).ctx)

    const write = await gateway.setLineConfig('s1', '', 'c1', 'parallel', '2')
    assert.equal(write.ok, true, write.detail)
    const reading = await gateway.readLineConfig('s1', '', 'c1')
    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.deepEqual(reading.entries['parallel'], {
      value: '2', layer: 'cycle', layers: (await declaredKnobs())['parallel'].layers,
    }, 'the line layer speaks, and the knob\'s own cells ride')

    // The record slot is the landing spot: the same one the planner folds.
    const state = JSON.parse(readFileSync(join(stage.root, '.superworker', 'state.json'), 'utf8'))
    assert.deepEqual(state.cycles[0].policies, { parallel: 2 })

    const clear = await gateway.unsetLineConfig('s1', '', 'c1', 'parallel')
    assert.equal(clear.ok, true, clear.detail)
    const cleared = JSON.parse(readFileSync(join(stage.root, '.superworker', 'state.json'), 'utf8'))
    assert.deepEqual(cleared.cycles[0].policies, {})
  } finally {
    stage.done()
  }
})

test('A line the record does not have is the engine\'s refusal, on the same reading shape', async () => {
  const stage = await project()
  try {
    const gateway = new SuperworkerRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readLineConfig('s1', '', 'nope')
    assert.equal(reading.ok, false)
    assert.ok((reading.refusal?.detail ?? '').length > 0, 'the engine said why')
    assert.deepEqual(reading.entries, {})
  } finally {
    stage.done()
  }
})

test('The global door reads the machine layer alone, and the write lands in the home copy', async () => {
  const stage = await project()
  try {
    const gateway = new SuperworkerRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readGlobalConfig('s1', '')
    assert.equal(reading.ok, true, reading.refusal?.detail)
    // A knob only the line layer takes is not in a machine-layer reading.
    assert.equal(reading.entries['parallel'], undefined)
    assert.equal(reading.entries['answer']?.layer, 'default')

    const write = await gateway.setGlobalConfig('s1', '', 'answer', 'technical')
    assert.equal(write.ok, true, write.detail)
    const knobs = await declaredKnobs()
    const after = await gateway.readGlobalConfig('s1', '')
    assert.deepEqual(after.entries['answer'], {
      value: 'technical', layer: 'global', options: knobs['answer'].options, layers: knobs['answer'].layers,
    })
    // The project file the workspace keeps stays out of it: the machine layer is the layer this door reads.
    assert.equal((await gateway.readConfig('s1', '')).entries['answer']?.layer, 'global', 'the machine value shows through the wide reading too')
  } finally {
    stage.done()
  }
})

test('The global door works without a session or a .superworker project directory', async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'superworker-non-project-'))
  try {
    const gateway = new SuperworkerRecordsGateway(fakeContext({ root: emptyDir }).ctx)
    const reading = await gateway.readGlobalConfig('', '')
    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.ok(reading.entries['answer'] !== undefined, 'answer knob is present without a project record')

    const write = await gateway.setGlobalConfig('', '', 'answer', 'plain')
    assert.equal(write.ok, true, write.detail)
    const after = await gateway.readGlobalConfig('', '')
    assert.equal(after.ok, true, after.refusal?.detail)
    assert.equal(after.entries['answer']?.value, 'plain')
    assert.equal(after.entries['answer']?.layer, 'global')
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }
})