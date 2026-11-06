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

test('工具印的四行：值与它住哪一层都读出来', () => {
  const entries = parseConfigList(LISTED)

  /* The keys are whatever the tool printed: no list is maintained here — what's printed is what's parsed. */
  assert.deepEqual(Object.keys(entries).sort(), ['issue_repair', 'max_agents', 'test_tier', 'worktree_mode'])
  assert.deepEqual(entries['max_agents'], { value: '1', layer: 'project' })
  assert.deepEqual(entries['test_tier'], { value: 'full', layer: 'project' })
  assert.deepEqual(entries['worktree_mode'], { value: 'off', layer: 'project' })
  assert.deepEqual(entries['issue_repair'], { value: 'on', layer: 'default' })
})

test('全局那一层：工具印的是家目录那份，读作 global', () => {
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
test('层签两种写法都认：全角括号中文层名，与半角括号英文层名', () => {
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

  assert.deepEqual(chinese, english, '两种写法读出来得是同一份表')
  assert.deepEqual(english['max_agents'], { value: '1', layer: 'project' })
  assert.deepEqual(english['issue_repair'], { value: 'on', layer: 'default' })
  assert.deepEqual(english['worktree_mode'], { value: 'off', layer: 'global' })
})

test('半角括号下，不认得的层名照样留空——宽度变了不改变判据', () => {
  const entries = parseConfigList('test_tier     = minimal (nobody knows this layer)')

  assert.deepEqual(entries['test_tier'], { value: 'minimal', layer: null })
})

test('不认得的层名：那一行留着，层签留空——不替工具编一个它没说的层', () => {
  const entries = parseConfigList('test_tier     = minimal（这一层谁都不认得）')

  assert.deepEqual(entries['test_tier'], { value: 'minimal', layer: null })
})

test('不是设置行的都不收：工具另印的提醒、空行、没有值的那一行', () => {
  const entries = parseConfigList([
    "Warning: C:\\ws\\.pf\\config.json 里的 'spawner' 不是可配的键，已跳过（可配的：issue_repair, max_agents）",
    '',
    'max_agents    = 2（项目 .pf/config.json）',
    'test_tier     = （项目 .pf/config.json）',
  ].join('\n'))

  assert.deepEqual(Object.keys(entries), ['max_agents'])
})

test('读一趟：答的就是 config list，答在这个工作区的根上，表就是它印的那几行', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readConfig('s1', '')

    assert.equal(reading.ok, true, reading.refusal?.detail)
    assert.equal(reading.workspaceRoot, stage.root, '读的是这条会话自己那个根')
    assert.equal(reading.refusal, null, '成功那一支不带拒绝理由')
    assert.deepEqual(reading.entries, parseConfigList(reading.text), 'entries 就是 text 解析出来的那一份')
    assert.deepEqual(reading.entries['worktree_mode'], { value: 'off', layer: 'default' }, '没写过就是出厂默认')
    assert.equal(reading.entries['max_agents']?.layer, 'default')
  } finally {
    stage.done()
  }
})

test('读那一趟没成：如实说它没成，一行都不编，理由还是引擎自己那一句', async () => {
  const stage = await project()
  try {
    /* A project settings file that is not JSON: the engine refuses, and its sentence is the detail. */
    writeFileSync(join(stage.root, '.pf', 'config.json'), '{ this is not json')
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const reading = await gateway.readConfig('s1', '')

    /* The reason is a code, and the engine's own words ride along as the detail: those words are not
     * this plugin's to translate, and the panel prints them as they came. */
    assert.equal(reading.ok, false)
    assert.equal(reading.text, '', '没成的时候不往 text 里塞话——那句话没有语言')
    assert.equal(reading.refusal?.code, 'tool-refused')
    assert.ok((reading.refusal?.detail ?? '').length > 0, '引擎说了原因，原因在 detail 里')
    assert.deepEqual(reading.entries, {})
  } finally {
    stage.done()
  }
})

test('写一条：config set <键> <值>，落的是项目那一层（不带 --global）', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const outcome = await gateway.setConfig('s1', '', 'worktree_mode', 'fork')

    assert.equal(outcome.ok, true, outcome.detail)
    assert.match(outcome.text, /^CONFIG: worktree_mode = fork \(written to project \.pf\/config\.json\)$/mu)
    assert.equal(configOnDisk(stage.root).worktree_mode, 'fork', '值落在项目那一层')
  } finally {
    stage.done()
  }
})

test('没登记的键照递：这一手不立放行表，拒的是引擎自己', async () => {
  const stage = await project()
  try {
    const gateway = new PathfinderRecordsGateway(fakeContext({ root: stage.root }).ctx)
    const outcome = await gateway.setConfig('s1', '', 'spawner', 'dsh')

    /* The line is still handed over and the engine's refusal surfaces as its own code, with its
     * words in the detail. */
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'tool-refused')
    assert.match(outcome.detail ?? '', /spawner/u)
    assert.equal(configOnDisk(stage.root).spawner, undefined, '不认识的键落不了盘')
  } finally {
    stage.done()
  }
})