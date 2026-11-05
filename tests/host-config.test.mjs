/* The two endpoints of the config section: locks in "what the tool's printed lines parse into"
 * and "what the write command looks like".
 *
 * Reading parses the lines printed by `pf config list`; writing hands a `config set` command
 * outward — keys and values pass through unfiltered for the tool to judge (it errors on unknown
 * keys, exits non-zero, writes nothing), and no path under `.pf` is assembled locally.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { parseConfigList } from '../src/host/project-config.ts'
import { fakeContext, fakeSubprocess, wordsOf } from './helpers/host-fixtures.mjs'

/** The four lines printed by a local `pf config list`, verbatim. */
const LISTED = [
  'max_agents    = 1（项目 .pf/config.json）',
  'test_tier     = full（项目 .pf/config.json）',
  'worktree_mode = off（项目 .pf/config.json）',
  'issue_repair  = on（出厂默认）',
].join('\n')

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

test('读一趟：跑的就是 config list，跑在这个工作区的根上', async () => {
  const subprocess = fakeSubprocess({ stdout: LISTED })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const reading = await gateway.readConfig('s1', '')

  assert.equal(reading.ok, true)
  assert.equal(reading.workspaceRoot, 'C:\\workspace')
  assert.equal(reading.entries['max_agents']?.value, '1')
  assert.equal(reading.entries['issue_repair']?.layer, 'default')
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'list'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('readConfig 认 options 上的取消信号：递进来的那条原样到进程口子', async () => {
  const subprocess = fakeSubprocess({ stdout: LISTED })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const mine = new AbortController()
  await gateway.readConfig('s1', '', { signal: mine.signal })

  assert.equal(subprocess.specs[0].signal, mine.signal, '进程口子收到的得是调用方那条信号，不是端点自己新造的')
})

test('读那一趟没成：如实说它没成，一行都不编', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: 'pf: this folder has no .pf record' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const reading = await gateway.readConfig('s1', '')

  /* The reason is a code, and the tool's own words ride along as the detail: those words are not
   * this plugin's to translate, and the panel prints them as they came. */
  assert.equal(reading.ok, false)
  assert.equal(reading.text, '', '没成的时候不往 text 里塞话——那句话没有语言')
  assert.equal(reading.refusal?.code, 'tool-refused')
  assert.match(reading.refusal?.detail ?? '', /no \.pf record/u)
  assert.deepEqual(reading.entries, {})
})

test('写一条：pf config set <键> <值>，落的是项目那一层（不带 --global）', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setConfig('s1', '', 'worktree_mode', 'reuse')

  assert.equal(outcome.ok, true)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'set', 'worktree_mode', 'reuse'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('没登记的键照递：这一手不立放行表，键与值一并交工具判', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: "Error: 'spawner' 不是可配的键" })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setConfig('s1', '', 'spawner', 'dsh')

  /* The command is still forwarded and the tool's refusal surfaces as its own code, with the
   * tool's words in the detail. */
  assert.equal(outcome.ok, false)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'set', 'spawner', 'dsh'])
  assert.equal(outcome.code, 'tool-refused')
  assert.match(outcome.detail ?? '', /spawner/u)
})

test('值合不合法由工具判：面板这一手照递，回来的是它那一句话', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: "Error: max_agents 要一个正整数，读到的是 '0'" })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.setConfig('s1', '', 'max_agents', '0')

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'tool-refused')
  assert.match(outcome.detail ?? '', /要一个正整数/u)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['config', 'set', 'max_agents', '0'])
})