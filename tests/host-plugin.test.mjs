/* The host-half plugin segment: locks in the workspace root resolution order.
 *
 * Three sources settle in order — live session header, stored session header, the sandbox
 * policy's root — none may be shuffled; once a live header exists, the stored one is never
 * consulted. That the root handed to the port is the resolved one is also locked here.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/host/index.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext as standIn } from './helpers/host-context.mjs'

/* Loading this line places the shipped skills into the DSH skill root, and these cases only exercise
 * the record service — so the root they would write into is pinned to a temp home here, never the
 * machine's own. `apply` returns the placement seam; these cases do not wait on it, they only check
 * that loading still installs the service (the placement has its own file, `host-skills`). */
const pinned = pinHome(['DSH_HOME'], 'pf-plugin-home-')
test.after(pinned.restore)

const signal = new AbortController().signal

/**
 * The context the plugin is applied to: the live and stored session headers, the sandbox policy's
 * fallback root, and the workspace-files port in its bare not-found form — every directory and file
 * is absent, which is the reading these cases judge (which root was asked, and for what).
 */
function context({ live = {}, stored = {}, sandboxRoot = 'C:\\fallback-root' } = {}) {
  return standIn({ live, stored, sandboxRoot, files: {}, provide: true })
}

test('插件名与依赖声明就是宿主那四样', () => {
  assert.equal(name, 'pathfinder-records')
  assert.deepEqual(inject, ['workspaceFiles', 'sessions', 'sandboxPolicy', 'tools'])
})

test('出口面收在插件协议要的那五样上：内部件不再从入口过一遍', async () => {
  const entry = await import('../src/host/index.ts')

  assert.equal(entry.name, 'pathfinder-records')
  assert.deepEqual(entry.inject, ['workspaceFiles', 'sessions', 'sandboxPolicy', 'tools'])
  assert.equal(typeof entry.apply, 'function')
  assert.ok('Config' in entry, 'Config 要在出口面上：DSH 拿它建那一节的设置命名空间')

  for (const internal of [
    'rootFor',
    'workspaceRootOf',
    'runPf',
    'readReading',
    'readWholeFile',
    'CONFIG_KEYS',
    'parseConfigList',
  ]) {
    assert.equal(entry[internal], undefined, `${internal} 没有外部消费者，不该再从入口出口`)
  }
  /* The gateway class stays on the export surface: `tests/client-render` builds a fresh gateway from the entry. */
  assert.equal(typeof entry.PathfinderRecordsGateway, 'function')
})

test('活着的会话头说话：它写的 cwd 就是取数的那个根', async () => {
  const { ctx, provided, asked } = context({
    live: { s1: { header: { cwd: 'C:\\from-the-live-session' } } },
    stored: { s1: { header: { cwd: 'C:\\from-the-stored-header' } } },
  })
  apply(ctx)
  const reading = await provided.pathfinder.read('s1', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\from-the-live-session')
  assert.ok(asked.length > 0)
  for (const call of asked) {
    assert.equal(call.scope.workspaceRoot, 'C:\\from-the-live-session')
    assert.equal(call.scope.sessionId, 's1')
  }
})

test('没有活着的会话时，落盘的会话头说话', async () => {
  const { ctx, provided, asked } = context({ stored: { s2: { header: { cwd: 'C:\\from-the-stored-header' } } } })
  apply(ctx)
  const reading = await provided.pathfinder.read('s2', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\from-the-stored-header')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\from-the-stored-header')
})

test('有活着的会话头就不再问落盘的头：它没写 cwd 时落到沙箱策略那个根', async () => {
  const { ctx, provided, asked, statCalls } = context({
    live: { s4: { header: {} } },
    stored: { s4: { header: { cwd: 'C:\\from-the-stored-header' } } },
    sandboxRoot: 'C:\\sandbox-root-for-tests',
  })
  apply(ctx)
  const reading = await provided.pathfinder.read('s4', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.deepEqual(statCalls, [], '活着的会话头在，落盘的头那一路问都不问')
})

test('两个会话头都没写 cwd 时，落到沙箱策略那个根', async () => {
  const { ctx, provided, asked } = context({
    live: { s3: { header: {} } },
    stored: { s3: { header: {} } },
    sandboxRoot: 'C:\\sandbox-root-for-tests',
  })
  apply(ctx)
  const reading = await provided.pathfinder.read('s3', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.equal(asked[0].scope.workspaceRoot, 'C:\\sandbox-root-for-tests')
})

test('整条会话都没人认得时，走的还是沙箱策略那个根，取数不抛', async () => {
  const { ctx, provided } = context({ sandboxRoot: 'C:\\sandbox-root-for-tests' })
  apply(ctx)
  const reading = await provided.pathfinder.read('nobody-knows-me', { signal })

  assert.equal(reading.workspaceRoot, 'C:\\sandbox-root-for-tests')
  assert.deepEqual(reading.sources, { nodes: 'missing', cycles: 'missing', instructions: 'missing', issues: 'missing' })
  assert.deepEqual(reading.nodes, {})
})

test('服务装在 ctx 上，由调用方给的取消信号转手递给口子', async () => {
  const { ctx, provided, asked } = context({ sandboxRoot: 'C:\\sandbox-root-for-tests' })
  apply(ctx)
  assert.equal(typeof provided.pathfinder.read, 'function')

  const controlled = new AbortController()
  await provided.pathfinder.read('s9', '', { signal: controlled.signal })
  assert.ok(asked.length > 0, '这一趟要真走到口子上，才谈得上信号到没到')
  for (const call of asked) {
    assert.equal(call.signal, controlled.signal, '口子收到的信号得是调用方递的那一条，不是端点自己新造的')
  }
})