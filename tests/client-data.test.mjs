/* Data plane of the browser-half pathway: locks in which layer is connected to and which endpoint each call reaches.
 *
 * The panel does not fetch data itself: it hands "which session, which workspace" to this layer,
 * which calls the same endpoint either through the installed remote namespace or through the
 * carrier layer. What is locked is the naming and argument shape of both routes: a renamed
 * namespace, a renamed endpoint, or a reordered argument turns these red.
 *
 * The root picked by the workspace selector at the top of the panel is the second argument, right
 * after the session identity: arguments are passed positionally, so shifting one slot would hand
 * the path to the tool as an id — that is why every call pins it explicitly.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelPort } from '../src/client/data.ts'

function fakeNamespace(answer = { ok: true, value: { workspaceRoot: 'C:\\ws' } }) {
  const calls = []
  const namespace = {}
  for (const method of ['read', 'readSessions', 'addInstruction', 'archiveInstruction', 'reviveInstruction', 'removeInstruction', 'readConfig', 'setConfig', 'openNodeSession']) {
    namespace[method] = async (...values) => {
      calls.push({ method, values })
      return answer
    }
  }
  return { calls, namespace }
}

function fakeCarrier(answer = { ok: true, value: { workspaceRoot: 'C:\\ws' } }) {
  const calls = []
  return {
    calls,
    carrier: {
      rpc: {
        call: async (path, endpoint, payload, signal) => {
          calls.push({ path, endpoint, payload, signal })
          return answer
        },
      },
    },
  }
}

/** The refusal a read rejected with: a code (plus the detail that rides with it), not a sentence. */
function refusedWith(failure) {
  return (error) => {
    assert.deepEqual(error.failure, failure)
    return true
  }
}

test('装好了远程命名空间：走它，取数是 read(sessionId, 工作区根, {})', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  assert.equal(port.source, 'remote')
  const reading = await port.read('s1', 'C:\\picked')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', 'C:\\picked', {}] })
})

test('没挑工作区：那个位置递一个空字符串，由宿主按会话身份定根', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  await port.read('s1', '')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', '', {}] })
})

test('命名空间挂在 remote 下面一层也认', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote' ? { pathfinder: namespace } : undefined) })

  assert.equal(port.source, 'remote')
  await port.read('s1', '')
  assert.equal(calls.length, 1)
})

test('远程那条路上，三个写动作各叫哪一个端点', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: '' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  await port.write('archive', 's1', 'C:\\picked', 'i-1')
  await port.write('revive', 's1', 'C:\\picked', 'i-1')
  await port.write('remove', 's1', 'C:\\picked', 'i-1')

  assert.deepEqual(calls.map((call) => call.method), [
    'archiveInstruction',
    'reviveInstruction',
    'removeInstruction',
  ])
  assert.deepEqual(calls[0].values, ['s1', 'C:\\picked', 'i-1'])
})

test('远程那条路上，设置那两条各叫哪一个端点', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { workspaceRoot: 'C:\\ws', ok: true, text: '', entries: {} } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  const reading = await port.readConfig('s1', 'C:\\picked')
  await port.setConfig('s1', 'C:\\picked', 'test_tier', 'minimal')

  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(calls.map((call) => call.method), ['readConfig', 'setConfig'])
  assert.deepEqual(calls[0].values, ['s1', 'C:\\picked'])
  assert.deepEqual(calls[1].values, ['s1', 'C:\\picked', 'test_tier', 'minimal'])
})

test('记下一条那一条口子：端点叫 addInstruction，原话与范围按位置递出去', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: 'INSTRUCTION i-0003' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  const outcome = await port.say('s1', 'C:\\picked', '先看一眼记录再动手', 'cycle', 'panel-to-plugin', '')

  assert.equal(outcome.text, 'INSTRUCTION i-0003')
  assert.deepEqual(calls, [{
    method: 'addInstruction',
    values: ['s1', 'C:\\picked', '先看一眼记录再动手', 'cycle', 'panel-to-plugin', ''],
  }])
})

test('远程那一层说没成：写面把它的话带回来，不假装成了', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { code: 'gateway/internal', message: '工具拒了' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })
  const outcome = await port.write('archive', 's1', '', 'i-1')

  assert.deepEqual(
    outcome,
    { ok: false, code: 'transport-failed', detail: '工具拒了' },
    '这一半不认识的码归到传输失败，宿主说的原话留在 detail 上',
  )

  /* 这一半认识的码原样穿过边界：工具拒了就是工具拒了，不必再把它当成别人的一句话去猜。 */
  const known = fakeNamespace({ ok: false, error: { code: 'tool-refused', message: '没有 i-0007 这一条' } })
  const carried = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? known.namespace : undefined) })
  assert.deepEqual(
    await carried.write('archive', 's1', '', 'i-1'),
    { ok: false, code: 'tool-refused', detail: '没有 i-0007 这一条' },
    '认识的码与它带的话都原样留下来',
  )
})

test('远程那一层取数失败：读数照抛，不编一份空的', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { message: '读不动' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  await assert.rejects(() => port.read('s1', ''), refusedWith({ code: 'transport-failed', detail: '读不动' }))
})

test('会话笔记那一条：端点叫 readSessions(sessionId, 工作区根)，搬回来的原样带回来', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { workspaceRoot: 'C:\\ws', recordPath: '.pf/meta/sessions', state: 'read', notes: { 'n-1.json': '{"run":[]}' } } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  const reading = await port.readSessions('s1', 'C:\\picked')
  assert.deepEqual(reading.notes, { 'n-1.json': '{"run":[]}' })
  assert.deepEqual(calls, [{ method: 'readSessions', values: ['s1', 'C:\\picked'] }])
})

test('开会话那一条口子：端点叫 openNodeSession，线与格子按位置递出去；回执不往字面上摆', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, session: 'session-minted' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  const outcome = await port.openNodeSession('s1', 'C:\\picked', 'panel-to-plugin', 'n1')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.text, '', '回执里的会话身份是导航用的地址，不进阅读流')
  assert.deepEqual(calls, [{
    method: 'openNodeSession',
    values: ['s1', 'C:\\picked', 'panel-to-plugin', 'n1'],
  }])

  const refused = fakeNamespace({ ok: false, error: { code: 'prompt-missing', message: '' } })
  const other = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? refused.namespace : undefined) })
  assert.deepEqual(
    await other.openNodeSession('s1', '', 'c1', 'n1'),
    { ok: false, code: 'prompt-missing' },
    '宿主那半的拒绝码原样穿过来，由 panel 拼成话',
  )
})

test('命名空间没装上：退到载体那一层，端点与参数都指名道姓', async () => {
  const { calls, carrier } = fakeCarrier()
  const port = createPanelPort({ get: (name) => (name === 'connection' ? carrier : undefined) })

  assert.equal(port.source, 'carrier')
  const reading = await port.read('s1', 'C:\\picked')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.equal(calls[0].path, '/api')
  assert.equal(calls[0].endpoint, 'pathfinder/read')
  assert.deepEqual(calls[0].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', options: {} } })

  await port.write('remove', 's1', 'C:\\picked', 'i-1')
  assert.equal(calls[1].endpoint, 'pathfinder/removeInstruction')
  assert.deepEqual(calls[1].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', id: 'i-1' } })

  await port.readConfig('s1', '')
  assert.equal(calls[2].endpoint, 'pathfinder/readConfig')
  assert.deepEqual(calls[2].payload, { args: { sessionId: 's1', workspaceRoot: '' } })

  await port.setConfig('s1', '', 'issue_repair', 'off')
  assert.equal(calls[3].endpoint, 'pathfinder/setConfig')
  assert.deepEqual(calls[3].payload, { args: { sessionId: 's1', workspaceRoot: '', key: 'issue_repair', value: 'off' } })

  await port.readSessions('s1', '')
  assert.equal(calls[4].endpoint, 'pathfinder/readSessions')
  assert.deepEqual(calls[4].payload, { args: { sessionId: 's1', workspaceRoot: '' } })

  await port.say('s1', 'C:\\picked', '先看一眼记录再动手', 'node', '', '3fac279b')
  assert.equal(calls[5].endpoint, 'pathfinder/addInstruction')
  assert.deepEqual(calls[5].payload, {
    args: { sessionId: 's1', workspaceRoot: 'C:\\picked', text: '先看一眼记录再动手', scope: 'node', cycle: '', node: '3fac279b' },
  })
})

test('两条都没接上：口子说实话，读不出来就是读不出来', async () => {
  const port = createPanelPort({ get: () => undefined })

  assert.equal(port.source, 'none')
  await assert.rejects(() => port.read('s1', ''), refusedWith({ code: 'not-connected' }), '一条都没有可读的路')
  await assert.rejects(() => port.readConfig('s1', ''), refusedWith({ code: 'not-connected' }))
  await assert.rejects(() => port.readSessions('s1', ''), refusedWith({ code: 'not-connected' }))
  const outcome = await port.write('archive', 's1', '', 'i-1')
  assert.deepEqual(outcome, { ok: false, code: 'no-write-channel' }, '写面没有通道，报的是它自己的码')
  const said = await port.say('s1', '', '一句话', 'global', '', '')
  assert.deepEqual(said, { ok: false, code: 'no-write-channel' })
  const refused = await port.setConfig('s1', '', 'test_tier', 'minimal')
  assert.deepEqual(refused, { ok: false, code: 'no-write-channel' })
})

test('通道上没有这个端点：读写都报 no-operation，端点名放进 detail', async () => {
  const partial = { read: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws' } }) }
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? partial : undefined) })

  assert.deepEqual(
    await port.write('archive', 's1', '', 'i-1'),
    { ok: false, code: 'no-operation', detail: 'archiveInstruction' },
    '写面缺的是哪个端点就报哪个名字',
  )
  await assert.rejects(
    () => port.readConfig('s1', ''),
    refusedWith({ code: 'no-operation', detail: 'readConfig' }),
    '读面缺端点时抛的也是这个码',
  )
})

test('答案不是一份能读的东西：报 unparsable-answer，不编读数', async () => {
  const { namespace } = fakeNamespace('不是对象')
  const port = createPanelPort({ get: (name) => (name === 'remote.pathfinder' ? namespace : undefined) })

  await assert.rejects(() => port.read('s1', ''), refusedWith({ code: 'unparsable-answer' }))
  assert.deepEqual(await port.write('archive', 's1', '', 'i-1'), { ok: false, code: 'unparsable-answer' })
})
