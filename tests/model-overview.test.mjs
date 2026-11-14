/* The overview's reading: which windows the overview draws, and which rows each one draws.
 *
 * What comes in is the session-list snapshot the browser already holds plus each session's own
 * events; what comes out is only the reading. The cases below pin the invariants the spec names:
 * which windows survive the alive bit and the cap, that the five are taken anew when one ends or
 * one arrives, and that a failed tool call folds into a fail row.
 *
 *   node --test tests/model-overview.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readOverview } from '../src/model/index.ts'

/* ---- the inputs' smallest honest shapes ---------------------------------- */

/** The session-list snapshot: ids in arrival order, rows keyed by id. */
function snapshot(ids, byId) {
  return { ids, byId }
}

/** The main view's row: the one whose mainView count is over zero. */
function mainRow(id, extra = {}) {
  return { id, running: false, displayTitle: `session ${id}`, retainedBy: { mainView: 1 }, ...extra }
}

/** A child row, running unless said otherwise. */
function childRow(id, parentId, running = true, extra = {}) {
  return { id, running, parentId, displayTitle: `child ${id}`, retainedBy: {}, ...extra }
}

/** An assistant message's event: its reasoning first, then what it said. */
function said(time, reasoning, spoken) {
  return {
    type: 'assistant/message',
    time,
    data: {
      message: {
        content: [
          ...(reasoning === undefined ? [] : [{ type: 'reasoning', text: reasoning }]),
          ...(spoken === undefined ? [] : [{ type: 'text', text: spoken }]),
        ],
      },
    },
  }
}

/** A tool call's event, arguments spelled the way the model spells them. */
function call(time, callId, name, args) {
  return { type: 'tool/call', time, data: { callId, name, arguments: JSON.stringify(args) } }
}

/** A tool result's event: the text it answers with, and the failure identity when it failed. */
function result(time, callId, text, error) {
  return {
    type: 'tool/result',
    time,
    data: {
      message: { toolCallId: callId, content: [{ type: 'text', text }] },
      ...(error === undefined ? {} : { error }),
    },
  }
}

const MAIN = 'session-main'

/** The plain scene: one main session, no children. */
function mainAlone() {
  return readOverview({ sessions: snapshot([MAIN], { [MAIN]: mainRow(MAIN) }) })
}

/* ---- which windows ------------------------------------------------------- */

test('only the main session, no children: one window, and no nameplate facts without a node', () => {
  const reading = mainAlone()
  assert.equal(reading.main.id, MAIN)
  assert.deepEqual(reading.children, [])
  assert.equal(reading.main.title, `session ${MAIN}`)
  assert.equal(reading.main.weight, null)
  assert.equal(reading.main.mode, null)
  assert.deepEqual(reading.main.rows, [])
  assert.equal(reading.main.startedAt, null)
})

test('one alive child: two windows, and the child reads running or not off the list alone', () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
  })
  assert.equal(reading.main.id, MAIN)
  assert.deepEqual(reading.children.map((w) => w.id), ['c-1'])
})

test('a child that is no longer running is no window; running again it is one again', () => {
  const ended = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN, false) }),
  })
  assert.deepEqual(ended.children, [])

  const back = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN, true) }),
  })
  assert.deepEqual(back.children.map((w) => w.id), ['c-1'])
})

test('six alive children: the latter five, the first not pinned', () => {
  const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6']
  const byId = { [MAIN]: mainRow(MAIN), ...Object.fromEntries(ids.map((id) => [id, childRow(id, MAIN)])) }
  const reading = readOverview({ sessions: snapshot([MAIN, ...ids], byId) })
  assert.deepEqual(reading.children.map((w) => w.id), ['c-2', 'c-3', 'c-4', 'c-5', 'c-6'])
})

test('one child ends: the five are taken anew from those still alive, in arrival order', () => {
  const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6']
  const byId = {
    [MAIN]: mainRow(MAIN),
    ...Object.fromEntries(ids.map((id) => [id, childRow(id, MAIN, id !== 'c-3')])),
  }
  const reading = readOverview({ sessions: snapshot([MAIN, ...ids], byId) })
  assert.deepEqual(reading.children.map((w) => w.id), ['c-1', 'c-2', 'c-4', 'c-5', 'c-6'])
})

test("the nameplate reads the node's own words: title, weight, mode, each the engine's way", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    nodeOf: { [MAIN]: 'n-merge', 'c-1': 'n-review' },
    nodes: {
      'n-merge': { title: '合并驱动按条目通用合并', mode: 'auto' },
      'n-review': { title: '复核改动的写入范围', weight: 'light', mode: 'checkpoint' },
    },
  })
  assert.equal(reading.main.title, '合并驱动按条目通用合并')
  assert.equal(reading.main.weight, 'standard')
  assert.equal(reading.main.mode, 'auto')
  assert.equal(reading.children[0].title, '复核改动的写入范围')
  assert.equal(reading.children[0].weight, 'light')
  assert.equal(reading.children[0].mode, 'checkpoint')
})

test('no main view in the list: no overview at all, and nothing throws', () => {
  const reading = readOverview({
    sessions: snapshot(['c-1'], { 'c-1': childRow('c-1', 'session-gone') }),
    events: { 'c-1': [said(1, undefined, 'hello')] },
  })
  assert.deepEqual(reading, { main: null, children: [] })
})

test('a snapshot nothing can be read off: an empty reading, and no throw', () => {
  assert.deepEqual(readOverview({ sessions: {} }), { main: null, children: [] })
  assert.deepEqual(readOverview({ sessions: { ids: 'nonsense', byId: 5 } }), { main: null, children: [] })
  assert.deepEqual(
    readOverview({ sessions: snapshot(['x'], { x: { retainedBy: 'nonsense' } }) }),
    { main: null, children: [] },
  )
})

/* ---- which rows ---------------------------------------------------------- */

test('a failed tool call folds into a fail row, the reason whole', () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [
        call(1, 'call-1', 'bash', { command: 'npx vitest run superworker-core' }),
        result(2, 'call-1', '', { name: 'ToolFailure', code: 'tests-failed', reason: '2 个用例：覆盖后默认值丢了' }),
      ],
    },
  })
  const kinds = reading.children[0].rows.map((r) => r.kind)
  assert.deepEqual(kinds, ['run', 'fail'])
  const failed = reading.children[0].rows[1]
  assert.equal(failed.text, '2 个用例：覆盖后默认值丢了')
  assert.equal(failed.full, '2 个用例：覆盖后默认值丢了')
})

test('each row carries what it is, the one body, and the whole content', () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [
        said(1, '先看先例', '条目级合并要认出插件自己声明的域。覆盖和缺省分开存。'),
        call(2, 'call-1', 'read', { file_path: 'src/model/contract.ts' }),
        call(3, 'call-2', 'str_replace_editor', { file_path: 'packages/superworker-core/merge.ts' }),
        call(4, 'call-3', 'subagent', { description: '同步 merge 一节', prompt: '…' }),
      ],
    },
  })
  const rows = reading.children[0].rows
  assert.deepEqual(rows.map((r) => r.kind), ['think', 'output', 'read', 'write', 'dispatch'])
  assert.equal(rows[0].text, '先看先例')
  assert.equal(rows[1].text, '条目级合并要认出插件自己声明的域。')
  assert.equal(rows[1].full, '条目级合并要认出插件自己声明的域。覆盖和缺省分开存。')
  assert.equal(rows[2].text, 'src/model/contract.ts')
  assert.equal(rows[3].text, 'packages/superworker-core/merge.ts')
  assert.equal(rows[4].text, '同步 merge 一节')
})

test('the other dispatch verbs of this harness fold as dispatch too, their body read off description', () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [
        call(1, 'call-1', 'subagent_fork', { description: '派出核一遍字段拼写', prompt: '…' }),
        call(2, 'call-2', 'subagent_continue', { description: '续问上一轮的总览', sessionId: 's-9' }),
        call(3, 'call-3', 'ralph', { objective: '把快档跑绿' }),
      ],
    },
  })
  const rows = reading.children[0].rows
  assert.deepEqual(rows.map((r) => r.kind), ['dispatch', 'dispatch', 'dispatch'])
  assert.equal(rows[0].text, '派出核一遍字段拼写')
  assert.equal(rows[1].text, '续问上一轮的总览')
  /* ralph's own argument is objective, which this fold does not read: the body falls to the tool's name. */
  assert.equal(rows[2].text, 'ralph')
})

test('a sentence cut never halves a file name: a full stop inside a word is no boundary', () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: { 'c-1': [said(1, undefined, 'read contract.ts 2 files. then merge')] },
  })
  const row = reading.children[0].rows[0]
  assert.equal(row.text, 'read contract.ts 2 files.')
  assert.equal(row.full, 'read contract.ts 2 files. then merge')
})

test("a run's output folds a second run row after the command; other tools' results fold to nothing", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [
        call(1, 'call-1', 'bash', { command: 'npx vitest run superworker-core' }),
        result(2, 'call-1', '14 个用例通过，0 失败'),
        call(3, 'call-2', 'read', { file_path: 'src/model/contract.ts' }),
        result(4, 'call-2', 'one long file the feed does not repeat'),
      ],
    },
  })
  const rows = reading.children[0].rows
  assert.deepEqual(rows.map((r) => r.kind), ['run', 'run', 'read'])
  assert.equal(rows[0].text, 'npx vitest run superworker-core')
  /* A comma is no sentence end: the short output is the body whole, as the demo's row is. */
  assert.equal(rows[1].text, '14 个用例通过，0 失败')
  assert.equal(rows[1].full, '14 个用例通过，0 失败')
})

test("the reader's own words fold to no row", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [{ type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: '继续' }] } } }],
    },
  })
  assert.deepEqual(reading.children[0].rows, [])
})

test("arguments nothing can be read off leave the tool's own name, nothing invented", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: { 'c-1': [call(1, 'call-1', 'read', { unreadable: true })] },
  })
  const row = reading.children[0].rows[0]
  assert.equal(row.kind, 'read')
  assert.equal(row.text, 'read')
  assert.equal(row.full, 'read')
})

test('a window draws only the most recent rows it has room for, in the order they happened', () => {
  const events = [1, 2, 3, 4, 5].map((at) => said(at, undefined, `sentence ${at}`))
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: { 'c-1': events },
    capacity: 3,
  })
  assert.deepEqual(reading.children[0].rows.map((r) => r.text), ['sentence 3', 'sentence 4', 'sentence 5'])
  const uncapped = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: { 'c-1': events },
  })
  assert.equal(uncapped.children[0].rows.length, 5)
})

test("the window's start is the earliest moment its own events carry", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: { 'c-1': [said(30, undefined, 'later'), call(10, 'call-1', 'bash', { command: 'ls' })] },
  })
  assert.deepEqual(reading.children[0].startedAt, new Date(10))
})
