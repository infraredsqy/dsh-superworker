/* The host-half remote port: locks in "whether DSH's gateway recognizes these endpoints".
 *
 * The judge sits on the gateway side: endpoints are recognized via the class's markers and
 * parameter names are sliced out of method source code. So a few seemingly unrelated details can
 * make an endpoint uncallsable in a real deployment (a parameter with a default value, a trailing
 * comma in the parameter list) — defects that pass locally and only surface on a real gateway.
 * That is why they deserve a test case standing guard.
 *
 * The gateway and registry are optional dev dependencies: skip when absent, call every endpoint
 * one by one when present.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathfinderRecordsGateway } from '../src/host/gateway.ts'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'

/** The nine endpoints, matching the table in `gateway.ts`. */
const ENDPOINTS = [
  'read',
  'addInstruction',
  'archiveInstruction',
  'reviveInstruction',
  'removeInstruction',
  'readConfig',
  'setConfig',
  'readSessions',
  'openNodeSession',
]

const wired = await Promise.all([
  import('@deepseek-ai/cordis').then(() => true, () => false),
  import('@deepseek-ai/dsh-api-gateway').then(() => true, () => false),
  import('@deepseek-ai/dsh-typert-registry').then(() => true, () => false),
]).then((flags) => flags.every(Boolean))

/** Build a minimal record: a little content in each of the four files, enough for a reading to pick up; plus one session note. */
function syntheticWorkspace({ note = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pf-gateway-'))
  mkdirSync(join(root, '.pf', 'issues'), { recursive: true })
  writeFileSync(join(root, '.pf', 'ideas.json'), JSON.stringify({
    nodes: { 'n-1': { id: 'n-1', title: '一格', status: 'todo', created_at: '2026-10-01T00:00:00Z' } },
    edges: [],
  }))
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({
    cycles: [{ id: 'line-1', status: 'active', created_at: '2026-10-01T00:00:00Z', path: [], holding: [] }],
  }))
  writeFileSync(join(root, '.pf', 'instructions.json'), JSON.stringify({
    instructions: [{ id: 'i-1', text: '一句话', scope: 'global', state: 'live', at: '2026-10-01T00:00:00Z' }],
  }))
  writeFileSync(join(root, '.pf', 'issues', 'issues.json'), JSON.stringify({ issues: {} }))
  if (note) {
    mkdirSync(join(root, '.pf', 'meta', 'sessions'), { recursive: true })
    writeFileSync(join(root, '.pf', 'meta', 'sessions', 'n-1.json'), JSON.stringify({
      node: 'n-1',
      v: 1,
      discussion: [{ session: 'session-talk', at: '2026-10-01T00:00:00Z' }],
      run: [{ session: 'session-run', at: '2026-10-02T00:00:00Z' }],
    }))
  }
  return root
}

/** A live rig with a real cordis context, the real gateway, and the real registry. */
async function liveGateway(root) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
  const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry')

  const ctx = new Context()
  /* The wiring here is its own: this is a live gateway over a real directory on disk, so `list`
   * reads the directory itself. The paging a read answers with, though, is the shared one. */
  ctx.provide('workspaceFiles', {
    async list(scope, path) {
      const { readdirSync, existsSync } = await import('node:fs')
      const target = join(root, path)
      if (!existsSync(target)) throw absentError(target)
      return {
        path,
        entries: readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: false,
      }
    },
    async read(scope, path, range) {
      const { existsSync, readFileSync } = await import('node:fs')
      const target = join(root, path)
      if (!existsSync(target)) throw absentError(target)
      return readPage(readFileSync(target, 'utf8'), range)
    },
  })
  ctx.provide('sessions', { get: (id) => (id === 's1' ? { header: { cwd: root } } : undefined) })
  ctx.provide('sandboxPolicy', { workspaceRoot: root })
  ctx.provide('subprocess', {
    async resolveExecutable() { return 'pf' },
    spawn() { return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } } },
  })

  new TypertRegistry(ctx)
  const gateway = new TypertGatewayService(ctx)
  ctx.provide('pathfinder', new PathfinderRecordsGateway(ctx))
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  return {
    ctx,
    call: async (method, args) => {
      try {
        return { ok: true, value: await gateway.invoke({ namespace: 'pathfinder', method, args, peer }) }
      } catch (error) {
        return { ok: false, code: error?.code, message: error?.message ?? String(error) }
      }
    },
  }
}

test('九个端点在源码模式下逐个叫得动：签名这一关先过，别的错另算', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    for (const method of ENDPOINTS) {
      const answer = await call(method, {})
      assert.notEqual(answer.code, 'gateway/signature-invalid', `${method} 的签名被网关判成说不清：${String(answer.message)}`)
      assert.notEqual(answer.code, 'gateway/invocation-unavailable', `${method} 没被网关认出来：${String(answer.message)}`)
    }
  } finally {
    await ctx.stop?.()
  }
})

test('取数那一条：网关把点名那个工作区读成一份真读数', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('read', { sessionId: 's1', workspaceRoot: '', options: {} })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, root)
    assert.deepEqual(answer.value.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
    assert.deepEqual(Object.keys(answer.value.nodes), ['n-1'])
    assert.equal(answer.value.cycles.length, 1)
  } finally {
    await ctx.stop?.()
  }
})

test('取数那一条：点名的那个根说了算，与这条会话自己落在哪儿无关', { skip: !wired }, async () => {
  const mine = syntheticWorkspace()
  const other = syntheticWorkspace()
  const { ctx, call } = await liveGateway(mine)
  try {
    const answer = await call('read', { sessionId: 's1', workspaceRoot: other, options: {} })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, other)
    assert.deepEqual(answer.value.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  } finally {
    await ctx.stop?.()
  }
})

test('会话笔记那一条：网关把那一层按节点分的小份笔记原样搬回来', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('readSessions', { sessionId: 's1', workspaceRoot: '' })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.workspaceRoot, root)
    assert.equal(answer.value.state, 'read')
    assert.deepEqual(Object.keys(answer.value.notes), ['n-1.json'])
    assert.deepEqual(JSON.parse(answer.value.notes['n-1.json']), {
      node: 'n-1',
      v: 1,
      discussion: [{ session: 'session-talk', at: '2026-10-01T00:00:00Z' }],
      run: [{ session: 'session-run', at: '2026-10-02T00:00:00Z' }],
    })
  } finally {
    await ctx.stop?.()
  }
})

test('会话笔记那一条：这一层目录不在时交回空的一份，不抛', { skip: !wired }, async () => {
  const root = syntheticWorkspace({ note: false })
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('readSessions', { sessionId: 's1', workspaceRoot: '' })
    assert.equal(answer.ok, true, String(answer.message))
    assert.equal(answer.value.state, 'missing')
    assert.deepEqual(answer.value.notes, {})
  } finally {
    await ctx.stop?.()
  }
})

test('readSessions 认 options 上的取消信号：调用方递的那一条原样到口子', async () => {
  /* options is a wire-level parameter, so the signal cannot pass the gateway's boundary validation;
   * options.signal, like read's, is reachable only in-process. So this case measures it the in-process
   * way read does: call the method directly and see whose signal reaches the port. */
  const seen = []
  const gateway = new PathfinderRecordsGateway({
    workspaceFiles: {
      async list(scope, path, signal) {
        seen.push(signal)
        return { path, entries: [], truncated: false }
      },
      async read() {
        throw new Error('nothing to read in this test')
      },
    },
    sessions: { get: () => ({ header: { cwd: 'C:\\ws' } }) },
    sandboxPolicy: { workspaceRoot: 'C:\\ws' },
  })
  const mine = new AbortController()
  await gateway.readSessions('s1', '', { signal: mine.signal })

  assert.ok(seen.length > 0, '这一趟要真走到口子上，才谈得上信号到没到')
  for (const one of seen) {
    assert.equal(one, mine.signal, '口子收到的信号得是调用方递的那一条，不是端点自己新造的')
  }
})

/* ---- the live-agent roster: `alive` reads each agent's own id ------------- */

/** A bare gateway over an empty record tree, with the agent registry this case names (`undefined` = the host exposes none). */
function rosterGateway(agents) {
  return new PathfinderRecordsGateway({
    workspaceFiles: {
      async list(scope, path) { return { path, entries: [], truncated: false } },
      async read() { throw new Error('nothing to read in this test') },
    },
    sessions: { get: () => ({ header: { cwd: 'C:\\ws' } }) },
    sandboxPolicy: { workspaceRoot: 'C:\\ws' },
    ...(agents === undefined ? {} : { get: (name) => (name === 'agents' ? agents : undefined) }),
  })
}

test('alive 读的是 agent 自己的身份：registry 上两个活 agent，roster 深等两个会话 id', async () => {
  /* The DSH agent contract puts the session identity on `id`; a roster that
   * reads any other field filters every live agent out and answers "no live
   * sessions" while the registry is up — the reading the stranded judgment
   * would take as "gone". */
  const gateway = rosterGateway({ list: () => [{ id: 'session-a' }, { id: 'session-b' }] })
  const reading = await gateway.readSessions('s1', 'C:\\ws')
  assert.deepEqual(reading.alive, ['session-a', 'session-b'])
})

test('registry 缺席：alive 交回 null（答不出不作「都不在」答）', async () => {
  const gateway = rosterGateway(undefined)
  const reading = await gateway.readSessions('s1', 'C:\\ws')
  assert.equal(reading.alive, null)
})

test('registry 的 list() 抛了：alive 交回 null', async () => {
  const gateway = rosterGateway({ list() { throw new Error('registry blew up') } })
  const reading = await gateway.readSessions('s1', 'C:\\ws')
  assert.equal(reading.alive, null)
})

test('端点表漏登记在构造时当场报错：类上有而表里没有的方法不再静默', () => {
  /* The same rig measures the base class first: it constructs fine — the later error is about the unlisted method, not construction itself. */
  assert.doesNotThrow(() => new PathfinderRecordsGateway({}))
  class LeakyGateway extends PathfinderRecordsGateway {
    sneak() {
      return 'not an endpoint'
    }
  }
  assert.throws(() => new LeakyGateway({}), /漏登记/u)
})

test('记下一条那条端点：原话过网关这一关，落成工具那一句', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const answer = await call('addInstruction', {
      sessionId: 's1',
      workspaceRoot: '',
      text: '先看一眼记录再动手 & 别猜',
      scope: 'global',
      cycle: '',
      node: '',
    })
    assert.equal(answer.ok, true, String(answer.message))
  } finally {
    await ctx.stop?.()
  }
})

test('三个写端点与设置那两条：网关也都叫得动', { skip: !wired }, async () => {
  const root = syntheticWorkspace()
  const { ctx, call } = await liveGateway(root)
  try {
    const archived = await call('archiveInstruction', { sessionId: 's1', workspaceRoot: '', id: 'i-1' })
    assert.equal(archived.ok, true, String(archived.message))
    const revived = await call('reviveInstruction', { sessionId: 's1', workspaceRoot: '', id: 'i-1' })
    assert.equal(revived.ok, true, String(revived.message))
    const removed = await call('removeInstruction', { sessionId: 's1', workspaceRoot: '', id: 'i-1' })
    assert.equal(removed.ok, true, String(removed.message))
    const listed = await call('readConfig', { sessionId: 's1', workspaceRoot: '' })
    assert.equal(listed.ok, true, String(listed.message))
    assert.equal(listed.value.workspaceRoot, root)
    assert.equal(listed.value.ok, true, '工具跑成了，读数落在成功那一支')
    assert.equal(listed.value.refusal, null, '成功那一支不带拒绝理由')
    assert.equal(listed.value.text, '', '这个替身命令没有输出，text 原样就是空串')
    assert.deepEqual(listed.value.entries, {}, '空输出解析不出任何一行')
    const written = await call('setConfig', { sessionId: 's1', workspaceRoot: '', key: 'test_tier', value: 'minimal' })
    assert.equal(written.ok, true, String(written.message))
  } finally {
    await ctx.stop?.()
  }
})