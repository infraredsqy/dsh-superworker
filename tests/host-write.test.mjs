/* The write-plane segment: locks in "which command one op maps to", plus the argument gate.
 *
 * This layer never touches the records themselves — every write rides on the command line handed
 * outward, so that command line is what gets locked: which `pf` command each of the six endpoints
 * spawns, what inputs the argument gate keeps out, and that every one of them runs this package's
 * own command entry (`bin/pf.mjs`, beside the host half in the artifact) under the same node that
 * runs the host, argv handed over directly. No shell sees the argv, so `&` and quotes stay
 * themselves even in the user's verbatim sentence, and PATH is never asked where the command is —
 * which is why these tests pin the entry rather than a resolved executable.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { fakeContext, fakeSubprocess, wordsOf } from './helpers/host-fixtures.mjs'

/** The shipped entry as the artifact has it: `bin/pf.mjs` at the package root, beside `lib/host/`. */
const ENTRY = fileURLToPath(new URL('../bin/pf.mjs', import.meta.url))

test('归档一条：pf instruction resolve <id> --state withdrawn', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', '', 'i-0007')

  assert.equal(outcome.ok, true)
  assert.equal(subprocess.specs.length, 1)
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'resolve', 'i-0007', '--state', 'withdrawn'])
  assert.equal(subprocess.specs[0].cwd, 'C:\\workspace')
})

test('点名一个工作区：命令就跑在那个根上，不看这条会话自己落在哪儿', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', 'C:\\somewhere\\else', 'i-0007')

  assert.equal(subprocess.specs[0].cwd, 'C:\\somewhere\\else')
  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'revive', 'i-0007'])
})

test('复原一条：pf instruction revive <id>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.reviveInstruction('s1', '', 'i-0007')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'revive', 'i-0007'])
})

test('删一条：pf instruction rm <id>', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.removeInstruction('s1', '', 'i-0007')

  assert.deepEqual(wordsOf(subprocess.specs[0]), ['instruction', 'rm', 'i-0007'])
})

test('记下一条：pf instruction add --scope <范围> --text，原话整句作为一个参数', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const said = '先看一眼记录再动手 & 别猜'
  const outcome = await gateway.addInstruction('s1', '', said, 'global', '', '')

  assert.equal(outcome.ok, true)
  assert.deepEqual(
    subprocess.specs[0].argv.slice(-6),
    ['instruction', 'add', '--scope', 'global', '--text', said],
  )
})

test('记下一条：绑哪条线、绑哪一格各自点名，另外那两个范围一个都不带', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  await gateway.addInstruction('s1', '', '跟着这条线走', 'cycle', 'panel-to-plugin', '')
  await gateway.addInstruction('s1', '', '这一格先停下', 'node', '', '3fac279b')

  assert.deepEqual(
    subprocess.specs[0].argv.slice(-8),
    ['instruction', 'add', '--scope', 'cycle', '--cycle', 'panel-to-plugin', '--text', '跟着这条线走'],
  )
  assert.deepEqual(
    subprocess.specs[1].argv.slice(-8),
    ['instruction', 'add', '--scope', 'node', '--node', '3fac279b', '--text', '这一格先停下'],
  )
})

test('记下一条：那一次起的是本包的命令入口，同一个 node 直接跑，不经过 cmd、也不经过解释器', { skip: process.platform !== 'win32' }, async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const said = '有 & 的一句 "带引号" 和 \'单引号\''
  const outcome = await gateway.addInstruction('s1', '', said, 'global', '', '')
  const argv = subprocess.specs[0].argv

  assert.equal(outcome.ok, true)
  assert.equal(argv[0], process.execPath, '起的必须是跑宿主半身的那个 node')
  assert.equal(resolve(argv[1]), resolve(ENTRY), '入口必须是本包 bin/pf.mjs 那一份')
  assert.equal(existsSync(ENTRY), true, `入口不在盘上：${ENTRY}`)
  assert.ok(!argv.some((arg) => arg.toLowerCase().endsWith('.py')), `argv 里还有 .py：${JSON.stringify(argv)}`)
  assert.deepEqual(
    argv.slice(2),
    ['instruction', 'add', '--scope', 'global', '--text', said],
    '原话整句是一个参数：& 与两种引号都原样在里面',
  )
})

test('记下一条：原话那条不问 PATH 要命令，路径解析改变不了它', async () => {
  const subprocess = fakeSubprocess()
  subprocess.resolveExecutable = async () => {
    throw new Error('原话那条不应当向 PATH 问命令')
  }
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.addInstruction('s1', '', '一句话', 'global', '', '')

  assert.equal(outcome.ok, true)
  assert.equal(subprocess.specs[0].argv[0], process.execPath)
  assert.equal(resolve(subprocess.specs[0].argv[1]), resolve(ENTRY))
})

test('记下一条：空话与不认识的范围当场说清，命令一条都不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const blank = await gateway.addInstruction('s1', '', '   ', 'global', '', '')
  const odd = await gateway.addInstruction('s1', '', '一句话', 'everywhere', '', '')

  assert.deepEqual(blank, { ok: false, code: 'empty-text' }, '空话没有可记的东西')
  assert.deepEqual(odd, { ok: false, code: 'scope-unknown', detail: 'everywhere' }, '不认识的范围把它本身放在 detail 里')
  assert.deepEqual(subprocess.specs, [])
})

test('参数闸：命令行元字符进不去，命令也就不递', async () => {
  const subprocess = fakeSubprocess()
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const id = 'i-1 & del /s C:\\'
  const outcome = await gateway.archiveInstruction('s1', '', id)

  assert.deepEqual(outcome, { ok: false, code: 'arg-not-allowed', detail: id }, '被闸住的那个参数原样放进 detail')
  assert.deepEqual(subprocess.specs, [])
})

test('工具非零退出：读数里那个数一个都不改，ok 是假', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, stderr: '没有 i-0007 这一条' })
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.archiveInstruction('s1', '', 'i-0007')

  assert.deepEqual(
    outcome,
    { ok: false, code: 'tool-refused', detail: '没有 i-0007 这一条' },
    '工具自己说了原因：原因原样放进 detail，不替它翻译',
  )
})

test('宿主没有进程通道：如实说这次写入没法落笔', async () => {
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess: undefined }))
  const outcome = await gateway.removeInstruction('s1', '', 'i-0007')

  assert.deepEqual(outcome, { ok: false, code: 'no-subprocess' }, '没有进程通道就没有写入，报的是这个码')
})

test('普通的一次写入：起的也是本包的命令入口，同一个 node 直接跑，不问 PATH', async () => {
  const subprocess = fakeSubprocess()
  subprocess.resolveExecutable = async () => {
    throw new Error('普通写入不应当向 PATH 问命令')
  }
  const gateway = new PathfinderRecordsGateway(fakeContext({ subprocess }))
  const outcome = await gateway.reviveInstruction('s1', '', 'i-0007')
  const argv = subprocess.specs[0].argv

  assert.equal(outcome.ok, true, '问 PATH 的假替身会抛，写入成了就说明没问')
  assert.equal(subprocess.specs.length, 1)
  assert.equal(argv[0], process.execPath, '起的必须是跑宿主半身的那个 node')
  assert.equal(resolve(argv[1]), resolve(ENTRY), '入口必须是本包 bin/pf.mjs 那一份')
  assert.equal(existsSync(ENTRY), true, `入口不在盘上：${ENTRY}`)
  assert.ok(!argv.some((arg) => arg.toLowerCase().endsWith('.py')), `argv 里还有 .py：${JSON.stringify(argv)}`)
  assert.deepEqual(argv.slice(2), ['instruction', 'revive', 'i-0007'], '命令原样接在入口后面')
})
