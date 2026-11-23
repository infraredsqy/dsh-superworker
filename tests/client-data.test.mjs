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
  for (const method of ['watch', 'read', 'readSessions', 'addInstruction', 'archiveInstruction', 'reviveInstruction', 'removeInstruction', 'readConfig', 'setConfig', 'openNodeSession', 'consultMigration', 'consultRoute', 'consultConduct']) {
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

test('remote namespace installed: it is used, reads call read(sessionId, workspaceRoot, {})', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  assert.equal(port.source, 'remote')
  const reading = await port.read('s1', 'C:\\picked')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', 'C:\\picked', {}] })
})

test('no workspace picked: an empty string goes in that slot, the host roots it by session identity', async () => {
  const { calls, namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  await port.read('s1', '')
  assert.deepEqual(calls[0], { method: 'read', values: ['s1', '', {}] })
})

test('a namespace one level under remote is recognized too', async () => {
  const { namespace } = fakeNamespace()
  const port = createPanelPort({ get: (name) => (name === 'remote' ? { superworker: namespace } : undefined) })

  assert.equal(port.source, 'remote')
  await port.read('s1', '')
})

test('over the remote road, which endpoint each of the three writes calls', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: '' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

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

test('over the remote road, which endpoint each of the two settings calls calls', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { workspaceRoot: 'C:\\ws', ok: true, text: '', entries: {} } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  const reading = await port.readConfig('s1', 'C:\\picked')
  await port.setConfig('s1', 'C:\\picked', 'test_tier', 'minimal')

  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(calls.map((call) => call.method), ['readConfig', 'setConfig'])
  assert.deepEqual(calls[0].values, ['s1', 'C:\\picked'])
  assert.deepEqual(calls[1].values, ['s1', 'C:\\picked', 'test_tier', 'minimal'])
})

test('the add-instruction seam: the endpoint is addInstruction, text and scope passed positionally', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, text: 'INSTRUCTION i-0003' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  const outcome = await port.say('s1', 'C:\\picked', 'read the record first, then act', 'cycle', 'panel-to-plugin')

  assert.equal(outcome.text, 'INSTRUCTION i-0003')
  assert.deepEqual(calls, [{
    method: 'addInstruction',
    values: ['s1', 'C:\\picked', 'read the record first, then act', 'cycle', 'panel-to-plugin'],
  }])
})

test('the remote layer says no: the write face brings its words back, no pretending it worked', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { code: 'gateway/internal', message: 'the tool refused' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })
  const outcome = await port.write('archive', 's1', '', 'i-1')

  assert.deepEqual(
    outcome,
    { ok: false, code: 'transport-failed', detail: 'the tool refused' },
    "a code this half does not know maps to transport-failed, the host's own words stay on detail",
  )

  /* Codes this half knows cross the boundary as they are: a tool refusal is a tool refusal, no guessing it is somebody else's sentence. */
  const known = fakeNamespace({ ok: false, error: { code: 'tool-refused', message: 'there is no i-0007 entry' } })
  const carried = createPanelPort({ get: (name) => (name === 'remote.superworker' ? known.namespace : undefined) })
  assert.deepEqual(
    await carried.write('archive', 's1', '', 'i-1'),
    { ok: false, code: 'tool-refused', detail: 'there is no i-0007 entry' },
    'known codes and the words they carry are kept as they are',
  )
})

test('the remote layer fails to read: the reading is rethrown, no empty one made up', async () => {
  const { namespace } = fakeNamespace({ ok: false, error: { message: 'cannot read' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  await assert.rejects(() => port.read('s1', ''), refusedWith({ code: 'transport-failed', detail: 'cannot read' }))
})

test('the session-note seam: the endpoint is readSessions(sessionId, workspaceRoot); what it brings back comes back as it is', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { workspaceRoot: 'C:\\ws', recordPath: '.superworker/meta/sessions', state: 'read', notes: { 'n-1.json': '{"run":[]}' } } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  const reading = await port.readSessions('s1', 'C:\\picked')
  assert.deepEqual(reading.notes, { 'n-1.json': '{"run":[]}' })
  assert.deepEqual(calls, [{ method: 'readSessions', values: ['s1', 'C:\\picked'] }])
})

test('the open-session seam: the endpoint is openNodeSession, cycle and node passed positionally; the receipt is never shown as text', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, session: 'session-minted' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  const outcome = await port.openNodeSession('s1', 'C:\\picked', 'panel-to-plugin', 'n1')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.text, '', 'the receipt\'s session identity is a navigation address, it does not enter the reading flow')
  assert.deepEqual(calls, [{
    method: 'openNodeSession',
    values: ['s1', 'C:\\picked', 'panel-to-plugin', 'n1'],
  }])

  const refused = fakeNamespace({ ok: false, error: { code: 'prompt-missing', message: '' } })
  const other = createPanelPort({ get: (name) => (name === 'remote.superworker' ? refused.namespace : undefined) })
  assert.deepEqual(
    await other.openNodeSession('s1', '', 'c1', 'n1'),
    { ok: false, code: 'prompt-missing' },
    'the host half\'s refusal code crosses as it is, the panel spells the words',
  )
})

test('the standing corner seam: the endpoints are consultRoute/consultConduct(sessionId, workspaceRoot), and a landed call hands back where it opened and nothing to print', async () => {
  const { calls, namespace } = fakeNamespace({ ok: true, value: { ok: true, session: 'session-minted' } })
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  const route = await port.consultRoute('s1', 'C:\\picked')
  const conduct = await port.consultConduct('s1', 'C:\\picked')

  /* Two things at once, and they are not the same thing: nothing to print (`text` is empty — the
   * session it opens is the whole effect), and where it opened, which the panel navigates by. The
   * id is an address, never a word shown to a reader. */
  assert.deepEqual(route, { ok: true, text: '', session: 'session-minted' }, 'a landed consult must print nothing and still say where it opened')
  assert.deepEqual(conduct, { ok: true, text: '', session: 'session-minted' })
  assert.deepEqual(calls, [
    { method: 'consultRoute', values: ['s1', 'C:\\picked'] },
    { method: 'consultConduct', values: ['s1', 'C:\\picked'] },
  ])

  const refused = fakeNamespace({ ok: true, value: { ok: false, code: 'no-session-service', detail: 'agents' } })
  const other = createPanelPort({ get: (name) => (name === 'remote.superworker' ? refused.namespace : undefined) })
  assert.deepEqual(
    await other.consultConduct('s1', ''),
    { ok: false, code: 'no-session-service', detail: 'agents' },
    'the host half\'s refusal code crosses as it is, the panel spells the words',
  )
})

test('namespace not installed: falls back to the carrier layer, endpoints and arguments named outright', async () => {
  const { calls, carrier } = fakeCarrier()
  const port = createPanelPort({ get: (name) => (name === 'connection' ? carrier : undefined) })

  assert.equal(port.source, 'carrier')
  const reading = await port.read('s1', 'C:\\picked')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.equal(calls[0].path, '/api')
  assert.equal(calls[0].endpoint, 'superworker/read')
  assert.deepEqual(calls[0].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', options: {} } })

  await port.write('remove', 's1', 'C:\\picked', 'i-1')
  assert.equal(calls[1].endpoint, 'superworker/removeInstruction')
  assert.deepEqual(calls[1].payload, { args: { sessionId: 's1', workspaceRoot: 'C:\\picked', id: 'i-1' } })

  await port.readConfig('s1', '')
  assert.equal(calls[2].endpoint, 'superworker/readConfig')
  assert.deepEqual(calls[2].payload, { args: { sessionId: 's1', workspaceRoot: '' } })

  await port.setConfig('s1', '', 'issue_repair', 'off')
  assert.equal(calls[3].endpoint, 'superworker/setConfig')
  assert.deepEqual(calls[3].payload, { args: { sessionId: 's1', workspaceRoot: '', key: 'issue_repair', value: 'off' } })

  await port.readSessions('s1', '')
  assert.equal(calls[4].endpoint, 'superworker/readSessions')
  assert.deepEqual(calls[4].payload, { args: { sessionId: 's1', workspaceRoot: '' } })

  await port.say('s1', 'C:\\picked', 'read the record first, then act', 'cycle', 'panel-to-plugin')
  assert.equal(calls[5].endpoint, 'superworker/addInstruction')
  assert.deepEqual(calls[5].payload, {
    args: { sessionId: 's1', workspaceRoot: 'C:\\picked', text: 'read the record first, then act', scope: 'cycle', cycle: 'panel-to-plugin' },
  })
})

test('neither road connected: the seam tells the truth, a read that cannot read says so', async () => {
  const port = createPanelPort({ get: () => undefined })

  assert.equal(port.source, 'none')
  await assert.rejects(() => port.read('s1', ''), refusedWith({ code: 'not-connected' }), 'no readable road at all')
  await assert.rejects(() => port.readConfig('s1', ''), refusedWith({ code: 'not-connected' }))
  await assert.rejects(() => port.readSessions('s1', ''), refusedWith({ code: 'not-connected' }))
  const outcome = await port.write('archive', 's1', '', 'i-1')
  assert.deepEqual(outcome, { ok: false, code: 'no-write-channel' }, 'the write face has no channel, it reports its own code')
  const said = await port.say('s1', '', 'one sentence', 'global', '')
  assert.deepEqual(said, { ok: false, code: 'no-write-channel' })
  const refused = await port.setConfig('s1', '', 'test_tier', 'minimal')
  assert.deepEqual(refused, { ok: false, code: 'no-write-channel' })
})

test('the channel has no such endpoint: both read and write report no-operation, the endpoint name goes in detail', async () => {
  const partial = { read: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws' } }) }
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? partial : undefined) })

  assert.deepEqual(
    await port.write('archive', 's1', '', 'i-1'),
    { ok: false, code: 'no-operation', detail: 'archiveInstruction' },
    'the write face reports whichever endpoint is missing',
  )
  await assert.rejects(
    () => port.readConfig('s1', ''),
    refusedWith({ code: 'no-operation', detail: 'readConfig' }),
    'a missing endpoint on the read face throws the same code',
  )
})

test('the channel: watch opens the namespace stream with the two arguments, delivers frames in order, and dispose closes it', async () => {
  const calls = []
  let closed = false
  const frames = [{ at: 1, reading: null, sessions: null }, { at: 2, reading: null, sessions: null }]
  const namespace = {
    watch: (...values) => {
      calls.push(values)
      const stream = (async function* () {
        try {
          for (const item of frames) yield item
        } finally {
          closed = true
        }
      })()
      return Object.assign(stream, { dispose: () => { closed = true } })
    },
  }
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })
  const seen = []
  let landed
  const both = new Promise((resolve) => { landed = resolve })
  const off = port.watch('s1', 'C:\\picked', (frame) => {
    seen.push(frame)
    if (seen.length === frames.length) landed()
  })
  await both
  assert.deepEqual(calls[0], ['s1', 'C:\\picked'], 'the stream endpoint takes exactly the two positions the call table names')
  assert.deepEqual(seen.map((frame) => frame.at), [1, 2], 'the frames arrive in the order the host sent them')
  off()
  assert.equal(closed, true, 'disposing the port closes the stream')
})

test('a deployment with no stream: the channel answers one frame off the two reads, then silence', async () => {
  const calls = []
  const namespace = {
    read: async (...values) => { calls.push(['read', ...values]); return { ok: true, value: { workspaceRoot: 'C:\\ws' } } },
    readSessions: async (...values) => { calls.push(['readSessions', ...values]); return { ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } } },
  }
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })
  let landed
  const one = new Promise((resolve) => { landed = resolve })
  const frames = []
  const off = port.watch('s1', 'C:\\picked', (frame) => {
    frames.push(frame)
    landed()
  })
  await one
  assert.equal(frames.length, 1, 'one frame, and no polling after it')
  assert.equal(frames[0].reading.workspaceRoot, 'C:\\ws')
  assert.equal(frames[0].sessions.notes !== undefined, true, 'the frame carries the session half too')
  assert.deepEqual(calls.map((call) => call[0]), ['read', 'readSessions'])
  off()
})

test('a namespace whose watch is a plain call, not a stream: the channel still answers one frame off the two reads', async () => {
  /* The name is mounted, so the port tries it as a stream first: a promise comes back, and reading a
   * promise as a stream is not a guess this layer is allowed to make. The one-frame road is the answer,
   * rather than an empty stage that looks like a workspace with nothing in it. */
  const namespace = {
    watch: async () => ({ ok: true, value: {} }),
    read: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws' } }),
    readSessions: async () => ({ ok: true, value: { workspaceRoot: 'C:\\ws', notes: {}, claims: {}, alive: null } }),
  }
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })
  let landed
  const one = new Promise((resolve) => { landed = resolve })
  const frames = []
  const off = port.watch('s1', 'C:\\picked', (frame) => {
    frames.push(frame)
    landed()
  })
  await one
  assert.equal(frames.length, 1, 'the fallback frame did not arrive')
  assert.equal(frames[0].reading.workspaceRoot, 'C:\\ws')
  off()
})

test('the answer is not something readable: report unparsable-answer, no made-up reading', async () => {
  const { namespace } = fakeNamespace('not an object')
  const port = createPanelPort({ get: (name) => (name === 'remote.superworker' ? namespace : undefined) })

  await assert.rejects(() => port.read('s1', ''), refusedWith({ code: 'unparsable-answer' }))
  assert.deepEqual(await port.write('archive', 's1', '', 'i-1'), { ok: false, code: 'unparsable-answer' })
})

test('the port climbs with refresh(): a read after the climb is answered by the layer now in force, the one source and watch already stand on', async () => {
  /* The namespace mounts asynchronously in production (the mount callback drives refresh), so a port
   * assembled on the carrier meets it mid-life. A forwarding closure that reads the layer once at
   * creation keeps calling the carrier after the climb while `source` and `watch` have moved on —
   * so each road answers with its own marker, and the read after the climb has to carry the
   * mounted namespace's marker, not the road the port was born on. */
  const calls = []
  const carrier = {
    rpc: {
      call: async (_path, endpoint, { args }) => {
        calls.push({ road: 'carrier', endpoint, sessionId: args.sessionId })
        return { ok: true, value: { workspaceRoot: 'C:\\ws', served: 'carrier' } }
      },
    },
  }
  const namespace = {
    read: async (sessionId, workspaceRoot) => {
      calls.push({ road: 'remote', endpoint: 'read', sessionId })
      return { ok: true, value: { workspaceRoot, served: 'remote' } }
    },
    watch: () => {
      calls.push({ road: 'remote', endpoint: 'watch' })
      const stream = (async function* () {
        yield { at: 1, workspaceRoot: 'C:\\ws', reading: { served: 'remote' }, sessions: null }
      })()
      return Object.assign(stream, { dispose: () => undefined })
    },
  }
  const holder = { connection: carrier }
  const port = createPanelPort({ get: (name) => holder[name] })

  assert.equal(port.source, 'carrier')
  assert.equal((await port.read('s1', 'C:\\picked')).served, 'carrier', 'before the mount lands, the carrier road is what answers')

  holder['remote.superworker'] = namespace
  assert.equal(port.refresh(), true, 'the namespace becoming readable is the climb')
  assert.equal(port.source, 'remote')
  assert.equal(
    (await port.read('s1', 'C:\\picked')).served,
    'remote',
    'a read after the climb is answered by the layer in force at call time, not the one the port was born on',
  )

  let landed
  const frame = new Promise((resolve) => { landed = resolve })
  const off = port.watch('s1', 'C:\\ws', landed)
  const opened = await frame
  off()
  assert.equal(opened.reading.served, 'remote', 'a channel opened after the climb stands on the same layer source names')
  assert.deepEqual(calls.map((call) => call.road), ['carrier', 'remote', 'remote'], 'each road answered once, in that order')
})
