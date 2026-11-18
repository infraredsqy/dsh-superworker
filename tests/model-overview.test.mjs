/* The overview's reading: which windows the overview draws, and which rows each one draws.
 *
 * What comes in is the session-list snapshot the browser already holds plus each session's own
 * events; what comes out is only the reading. The cases below pin the invariants the spec names:
 * which windows survive the alive bit and the cap, that the five are taken anew when one ends or
 * one arrives, what a window says about its conversation — how its last turn ended, and the four
 * facts the drawing reads (settled, waiting, delivered, alert) — and that a failed tool call folds
 * into a fail row.
 *
 *   node --test tests/model-overview.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { endingOf, readOverview } from '../src/model/index.ts'

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

/** A tool result's event: the text it answers with, the failure identity when it failed, and the v3 activation. */
function result(time, callId, text, error, extra = {}) {
  return {
    type: 'tool/result',
    time,
    data: {
      message: {
        toolCallId: callId,
        content: [{ type: 'text', text }],
        ...(extra.isError === undefined ? {} : { isError: extra.isError }),
      },
      ...(error === undefined ? {} : { error }),
      ...(extra.meta === undefined ? {} : { meta: extra.meta }),
    },
  }
}

/** A subagent catalog entry: the parent's own discovery fact for one child. */
function catalog(time, data) {
  return { type: 'subagent/catalog', time, data }
}

const MAIN = 'session-main'

/** The plain scene: one main session, no children. */
function mainAlone() {
  return readOverview({ sessions: snapshot([MAIN], { [MAIN]: mainRow(MAIN) }) })
}

/**
 * The dispatch scene: the main session's own log, the children it started, and each
 * child's own log. The children are running, so all of them draw a window.
 */
function dispatched(mainEvents, children, childEvents = {}, extra = {}) {
  const byId = { [MAIN]: mainRow(MAIN) }
  for (const id of children) byId[id] = childRow(id, MAIN)
  return readOverview({
    sessions: snapshot([MAIN, ...children], byId),
    events: { [MAIN]: mainEvents, ...childEvents },
    ...extra,
  })
}

/** One child's dispatch anchor, as the reading carries it. */
function anchorOf(reading, id) {
  return reading.children.find((window) => window.id === id)?.dispatchCallId
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

test('the cap counts what it folded away: six alive children draw five, and one is counted', () => {
  const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6']
  const byId = { [MAIN]: mainRow(MAIN), ...Object.fromEntries(ids.map((id) => [id, childRow(id, MAIN)])) }
  const six = readOverview({ sessions: snapshot([MAIN, ...ids], byId) })
  assert.equal(six.children.length, 5, `six alive children drew ${six.children.length} windows`)
  /* Counted off the alive list, never off the five the cap kept: that one is already five, and a
     count taken from it would always read 0. */
  assert.equal(six.hiddenChildren, 1, `the count reads ${six.hiddenChildren} with six alive children`)

  const seven = readOverview({
    sessions: snapshot([MAIN, ...ids, 'c-7'], { ...byId, 'c-7': childRow('c-7', MAIN) }),
  })
  assert.equal(seven.children.length, 5, `seven alive children drew ${seven.children.length} windows`)
  assert.equal(seven.hiddenChildren, 2, `the count reads ${seven.hiddenChildren} with seven alive children`)

  /* Five or fewer: nothing is folded away, and the count is 0 — a number, not an absence. */
  assert.equal(readOverview({ sessions: snapshot([MAIN, ...ids.slice(0, 5)], byId) }).hiddenChildren, 0, 'five alive children were counted as hidden')
  assert.equal(mainAlone().hiddenChildren, 0, 'a window with no children counted hidden ones')
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

/* ---- which sessions stand a window up: the alive bit ---------------------
 *
 * A child is a window only while the list says it is running. One that ended is
 * not drawn and not counted: the window it had is taken off the page by the
 * client's leave animation, so the reading never carries a finished child — a
 * finished child's dispatch row still being on the screen stands nothing up.
 * Which facts a window carries is the next section's business.
 */

/** The main log a child hangs off: the call, the catalogue it wrote, and the answer that names it. */
function dispatchOf(childId, callId = 'call-1') {
  return [
    call(1, callId, 'subagent', { description: '派出去做长活', prompt: '…' }),
    catalog(2, { version: 0, childId, childCreatedAt: 2, mode: 'continuable', label: '派出去做长活' }),
    result(3, callId, `started subagent ${childId}`),
  ]
}

/** One child under the main session, finished unless said otherwise, with the main log's tail as asked. */
function oneChild(mainTail, { running = false, capacity } = {}) {
  return readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN, running) }),
    events: { [MAIN]: [...dispatchOf('c-1'), ...mainTail], 'c-1': [said(4, undefined, '它把活干完了')] },
    ...(capacity === undefined ? {} : { capacity }),
  })
}

test('a child that ended is no window, even while its dispatch row is still drawn', () => {
  /* The dispatch row that opened it is on the screen and the anchor still names it. Nothing on the
   * screen stands the window up any more: a finished child leaves by the leave animation, and the
   * reading keeps no finished one. */
  const reading = oneChild([said(5, undefined, '它回来了')])
  assert.deepEqual(reading.children, [], 'a finished child was drawn as a window')
  assert.equal(reading.hiddenChildren, 0, 'a finished child was counted as a running one folded away')

  /* Cut or kept, the row's own footing decides nothing: the same child is no window either way. */
  const cut = oneChild([said(5, undefined, '它回来了')], { capacity: 1 })
  assert.deepEqual(cut.children, [], 'a finished child whose dispatch row the cut took away is still drawn')
  const kept = oneChild([said(5, undefined, '它回来了')], { capacity: 2 })
  assert.deepEqual(kept.children, [], 'a dispatch row still on the screen stood a finished child up as a window')
})

test('a child still running is a window whatever its dispatch row does, and carries no settled or done bit', () => {
  const read = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN, true) }),
    /* No catalogue and no answer: nothing anchors this child, and the capacity keeps no row anyway. */
    events: { [MAIN]: [call(1, 'call-1', 'subagent', { description: '还没回来', prompt: '…' })] },
    capacity: 1,
  })
  assert.deepEqual(read.children.map((w) => w.id), ['c-1'], 'a running child lost its window for want of an anchor row')
  /* It is a window because it is running: no settled (it is not stopped) and no retired done. */
  assert.equal('settled' in read.children[0], false, 'a running child window carries the settled bit')
  assert.equal('done' in read.children[0], false, "a child window carries the retired done bit")
})

test('a child that ended with no dispatch anchor at all is no window: nothing stands it up', () => {
  const read = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN, false) }),
  })
  assert.deepEqual(read.children, [])
})

test('a finished child takes no slot in the cap: the five are running children alone', () => {
  const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5']
  const byId = { [MAIN]: mainRow(MAIN) }
  for (const id of ids) byId[id] = childRow(id, MAIN)
  /* The sixth arrives finished and last in the list: it is no window and folds nothing away. */
  byId['c-6'] = childRow('c-6', MAIN, false)
  const read = readOverview({ sessions: snapshot([MAIN, ...ids, 'c-6'], byId) })
  assert.deepEqual(
    read.children.map((w) => w.id),
    ids,
    'the five drawn are not the running children alone',
  )
  assert.equal(read.hiddenChildren, 0, 'a finished child was counted as a running one the cap folded away')
})

/* ---- how the last turn ended --------------------------------------------
 *
 * DSH's own `turn/end` reason, folded to its `kind` and — on a cancellation —
 * the `cause` under it. The fact is carried verbatim: this reading judges
 * nothing about it, the drawing words it. The last one in the log wins, since a
 * log holds every turn the conversation ran; a kind this reading has never seen
 * is still an ending and is never read as `completed`; and a log with no
 * `turn/end`, or one nothing can be read off, names no ending at all — which is
 * not the same as "it ended well".
 */

/** One turn's end the way DSH writes it: the reason, and a cancellation's own cause under it. */
function turnEnd(time, kind, cause) {
  return {
    type: 'turn/end',
    time,
    data: { reason: { kind, ...(cause === undefined ? {} : { reason: { kind: cause } }) } },
  }
}

test('the last turn/end wins: the ending is what the conversation did last', () => {
  assert.deepEqual(endingOf([turnEnd(1, 'completed'), turnEnd(2, 'aborted', 'user')]), { kind: 'aborted', cause: 'user' })
  /* A turn that ended well after a cancelled one: the cancellation is history, not the ending. */
  assert.deepEqual(endingOf([turnEnd(1, 'aborted', 'parent'), turnEnd(2, 'completed')]), { kind: 'completed' })
})

test('the cause rides only an aborted turn, and only when the log spells one', () => {
  assert.deepEqual(endingOf([turnEnd(1, 'aborted', 'user')]), { kind: 'aborted', cause: 'user' })
  assert.deepEqual(endingOf([turnEnd(1, 'aborted')]), { kind: 'aborted' }, 'a cause nobody wrote was invented')
})

test('interrupted and error are carried as they are, never folded to completed', () => {
  assert.deepEqual(endingOf([turnEnd(1, 'interrupted')]), { kind: 'interrupted' })
  assert.deepEqual(endingOf([turnEnd(1, 'error')]), { kind: 'error' })
})

test('no turn/end, or one nothing can be read off: no ending at all, and nothing throws', () => {
  assert.equal(endingOf([said(1, undefined, '一句话')]), undefined, 'a log with no turn/end named an ending')
  assert.equal(endingOf([]), undefined)
  assert.equal(endingOf(undefined), undefined)
  assert.equal(endingOf([{ type: 'turn/end' }]), undefined, 'an ending with no data named a kind')
  assert.equal(endingOf([{ type: 'turn/end', data: 'nonsense' }]), undefined)
  assert.equal(endingOf([{ type: 'turn/end', data: { reason: 5 } }]), undefined)
  assert.equal(endingOf([{ type: 'turn/end', data: { reason: {} } }]), undefined, 'an ending with no kind named one')
})

/* ---- the main window's facts: settled, waiting, delivered, alert ----------
 *
 * The main window is the one these facts decide the drawing for. `settled` says
 * one thing alone — the list's running bit is not true, so the rows will not
 * move again; it is not a verdict on the work, and the retired `done` bit is
 * gone. `waiting` is the caller's person's gate (a checkpoint, or a manual
 * node), and `delivered` is the record's word that the work is handed in — the
 * one fact the check is drawn on. `alert` is the narrow one: work is owed (the
 * caller's stranded nodes), and the conversation either did not end by itself
 * or ended with the debt still held while no leg of the pipeline moves. The
 * order is the drawing's order: a gate, then a delivery, then a debt. A gated
 * window is never also handed in or broken, and a conversation that yielded to
 * a leg of its own is a pipeline in motion rather than a broken one.
 */

/** The node the scene's main session works: the one word that makes a debt possible. */
const OWED_NODE = 'n-owed'

/**
 * The main session working one node, with its log's last ending, the caller's
 * record-side words, and — when given — a second named session still running to
 * the side. The pipeline names MAIN and the panel sits in it, so MAIN is the
 * main window however the leg is doing; the leg only decides whether anything
 * is still moving.
 */
function factScene({ running = false, ending, waiting, delivered, stranded, runningLeg } = {}) {
  const byId = { [MAIN]: mainRow(MAIN, { running }) }
  const ids = [MAIN]
  const pipeline = [MAIN]
  if (runningLeg !== undefined) {
    byId[runningLeg] = { id: runningLeg, running: true, displayTitle: `leg ${runningLeg}`, retainedBy: {} }
    ids.push(runningLeg)
    pipeline.push(runningLeg)
  }
  return readOverview({
    sessions: snapshot(ids, byId),
    pipelineSessions: pipeline,
    sessionId: MAIN,
    nodeOf: { [MAIN]: OWED_NODE },
    ...(ending === undefined ? {} : { events: { [MAIN]: [ending] } }),
    ...(waiting === undefined ? {} : { waitingSessions: waiting }),
    ...(delivered === undefined ? {} : { deliveredSessions: delivered }),
    ...(stranded === undefined ? {} : { strandedNodes: stranded }),
  })
}

test('settled replaces done: a stopped conversation says its rows will not move, nothing more', () => {
  /* The list's running bit is the whole fact: not running, and the window is settled — the
   * conversation this panel lives in has stopped, and its rows are said quieter rather than removed. */
  const idle = factScene()
  assert.equal(idle.main.settled, true, 'a main window whose session stopped does not read as settled')
  assert.equal('done' in idle.main, false, 'the retired done bit is still on the window')
  assert.equal('delivered' in idle.main, false, 'a quiet conversation was read as handed in')

  const running = factScene({ running: true })
  assert.equal('settled' in running.main, false, 'a running main window reads as settled')
  assert.equal('done' in running.main, false, 'the retired done bit is still on a running window')

  /* The main window beside a finished child is still the stopped one. */
  const besideChild = oneChild([said(5, undefined, '它回来了')])
  assert.equal(besideChild.main.settled, true, 'the main window read as running beside a finished child')
  assert.equal('done' in besideChild.main, false, 'the retired done bit is still on a stopped window')
})

test('waiting lands on the main window, from the fact the caller hands over', () => {
  /* The caller read the record's own gate: this session's node is a checkpoint. The reading carries
   * that word alone, and it does not touch the running fact — the drawing reads the gate first. */
  const both = factScene({ waiting: [MAIN], delivered: [MAIN] })
  assert.equal(both.main.waiting, true, 'the session the caller named at a checkpoint does not read as waiting')
  assert.equal('delivered' in both.main, false, 'a gated window was also drawn as handed in')
  assert.equal(both.main.settled, true, 'the gate rewrote the running bit')

  const plain = mainAlone()
  assert.equal('waiting' in plain.main, false, 'a window nobody named at a gate reads as waiting')

  /* The gate is the caller's word about one session, not a mood every window catches: a window the
   * caller never named carries nothing, and the named one is still the main window. */
  const beside = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    waitingSessions: [MAIN],
  })
  assert.equal(beside.main.waiting, true, 'the gate did not land on the window it names')
  assert.equal('waiting' in beside.children[0], false, 'the gate spilled onto a window the caller never named')
})

test("delivered lands from the record's word alone: the check is drawn on it, and it is no alert", () => {
  const reading = factScene({ delivered: [MAIN] })
  assert.equal(reading.main.delivered, true, 'a session the record calls delivered does not read as handed in')
  assert.equal('alert' in reading.main, false, 'a delivered window was drawn as broken')
  assert.equal('waiting' in reading.main, false, 'a delivered window carries the person gate')
  /* The record's judgment, not the conversation's: its log said nothing about it. */
  assert.equal('ending' in reading.main, false, 'a delivery invented an ending')
})

test('alert: a killed turn on a stranded node is a broken leg at once, even while a leg still runs', () => {
  const reading = factScene({ ending: turnEnd(9, 'aborted', 'user'), stranded: [OWED_NODE], runningLeg: 'leg-1' })
  assert.equal(reading.main.alert, true, 'a leg killed with its node still owed read as nothing wrong')
  assert.deepEqual(reading.main.ending, { kind: 'aborted', cause: 'user' }, 'the ending was not carried verbatim')
})

test('alert: a completed turn on a stranded node with the pipeline quiet is the phantom dispatch', () => {
  /* It says it is done, nothing was handed in, and no named session is running: the debt is standing
   * and nobody is working it. */
  const reading = factScene({ ending: turnEnd(9, 'completed'), stranded: [OWED_NODE] })
  assert.equal(reading.main.alert, true, 'a quiet pipeline with the debt still held read as nothing wrong')
})

test('no alert: a completed turn that yielded to its own running leg is a pipeline in motion', () => {
  const reading = factScene({ ending: turnEnd(9, 'completed'), stranded: [OWED_NODE], runningLeg: 'leg-1' })
  assert.equal('alert' in reading.main, false, 'a conversation that yielded to its own leg was called broken')
})

test('no alert: a stopped turn that owes nothing is no broken leg', () => {
  const reading = factScene({ ending: turnEnd(9, 'aborted', 'user') })
  assert.equal('alert' in reading.main, false, 'a conversation that owes nothing was called broken')
})

test('no alert on an unreadable ending: an unknown ending is never accused', () => {
  /* The node is stranded, but the log carries no turn/end to read: there is nothing to go on, and a
   * debt is not proved broken by a silence. */
  const reading = factScene({ stranded: [OWED_NODE] })
  assert.equal('alert' in reading.main, false, 'a window with no turn/end to read was accused')
})

test('a running window never alerts: a debt is about work nobody is doing', () => {
  const reading = factScene({ running: true, ending: turnEnd(9, 'completed'), stranded: [OWED_NODE] })
  assert.equal('alert' in reading.main, false, 'a running window was accused of being stranded')
  assert.equal('settled' in reading.main, false, 'the running bit was rewritten by the debt')

  /* The same on a child: running, its node owed by a line, and nothing to read off its log. */
  const child = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    nodeOf: { 'c-1': OWED_NODE },
    strandedNodes: [OWED_NODE],
  })
  assert.equal('alert' in child.children[0], false, 'a running child was accused of being stranded')
})

test('precedence: a gate beats a delivery beats a debt — gated, delivered and stranded reads waiting only', () => {
  const all = factScene({
    ending: turnEnd(9, 'aborted', 'user'),
    waiting: [MAIN],
    delivered: [MAIN],
    stranded: [OWED_NODE],
  })
  assert.equal(all.main.waiting, true, 'the gate lost to the facts below it')
  assert.equal('delivered' in all.main, false, 'a gated window also read as handed in')
  assert.equal('alert' in all.main, false, 'a gated window also read as broken')

  /* The next rung: the same scene without the gate would have alerted, and reads as handed in alone. */
  const delivered = factScene({ ending: turnEnd(9, 'aborted', 'user'), delivered: [MAIN], stranded: [OWED_NODE] })
  assert.equal(delivered.main.delivered, true, 'the delivery lost to the debt below it')
  assert.equal('alert' in delivered.main, false, 'a delivered window also read as broken')
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
  assert.deepEqual(reading, { main: null, children: [], hiddenChildren: 0 })
})

test('a snapshot nothing can be read off: an empty reading, and no throw', () => {
  assert.deepEqual(readOverview({ sessions: {} }), { main: null, children: [], hiddenChildren: 0 })
  assert.deepEqual(readOverview({ sessions: { ids: 'nonsense', byId: 5 } }), { main: null, children: [], hiddenChildren: 0 })
  assert.deepEqual(
    readOverview({ sessions: snapshot(['x'], { x: { retainedBy: 'nonsense' } }) }),
    { main: null, children: [], hiddenChildren: 0 },
  )
})

/* ---- which conversation is the main window -------------------------------
 *
 * The main window is the pipeline's own conversation, never the browser's. The
 * record names the sessions this workspace's pipeline owns (the node notes'
 * sessions); a session it never named belongs to something else, however open
 * it is. DSH's `retainedBy.mainView` marker is a browser-side "who holds this
 * open" count and decides nothing while the record side is in hand.
 */

/** A session the record names: its own liveness and last move, read off the list. */
function pipelineRow(id, extra = {}) {
  return { id, running: false, displayTitle: `pipeline ${id}`, updatedAt: '2026-01-01T00:00:00.000Z', ...extra }
}

test('the stale conversation DSH marks as its main view is not drawn: the record-named one is', () => {
  /* The user's own scene: the browser still holds an unrelated old conversation open (it carries
   * `retainedBy.mainView`), while the record names a different session as this pipeline's own. */
  const stale = 'session-old'
  const ours = 'session-pipeline'
  const reading = readOverview({
    sessions: snapshot([stale, ours, 'c-old', 'c-ours'], {
      [stale]: mainRow(stale, { running: false, updatedAt: '2026-11-13T13:57:50.000Z' }),
      [ours]: pipelineRow(ours, { running: true, updatedAt: '2026-11-15T16:00:00.000Z' }),
      'c-old': childRow('c-old', stale),
      'c-ours': childRow('c-ours', ours),
    }),
    pipelineSessions: [ours],
    sessionId: 'session-elsewhere',
    events: {
      [stale]: [said(1, undefined, '一条旧会话的行')],
      [ours]: [said(2, undefined, '这条管道自己的行')],
      'c-old': [said(3, undefined, '旧会话的子窗')],
      'c-ours': [said(4, undefined, '管道的子窗')],
    },
  })
  assert.equal(reading.main.id, ours, `the main window is ${reading.main.id}, not the record-named session`)
  assert.deepEqual(reading.children.map((w) => w.id), ['c-ours'], `the drawn children are ${reading.children.map((w) => w.id)}`)
  assert.deepEqual(reading.main.rows.map((row) => row.full), ['这条管道自己的行'], "the main window's rows are not its own log")
  assert.equal(reading.hiddenChildren, 0, 'the stale conversation was counted as a folded child')
})

test("the panel's own session wins among the record-named ones, running or not", () => {
  const mine = 'session-mine'
  const other = 'session-other'
  const reading = readOverview({
    sessions: snapshot([other, mine], {
      [other]: pipelineRow(other, { running: true, updatedAt: '2026-11-15T20:00:00.000Z' }),
      [mine]: pipelineRow(mine, { running: false, updatedAt: '2026-11-14T19:33:48.000Z' }),
    }),
    pipelineSessions: [other, mine],
    sessionId: mine,
    events: { [mine]: [said(1, undefined, '我自己的最后一句')], [other]: [said(2, undefined, '另一个会话的行')] },
  })
  assert.equal(reading.main.id, mine, `the main window is ${reading.main.id}, not the panel's own session`)
  assert.deepEqual(reading.main.rows.map((row) => row.full), ['我自己的最后一句'])
})

test('several historical pipeline sessions and one still running: the running one is drawn', () => {
  /* The machine's own state: every finished node left its session in the record. */
  const historical = ['session-a', 'session-b', 'session-c', 'session-e']
  const running = 'session-running'
  const byId = { [running]: pipelineRow(running, { running: true, updatedAt: '2026-11-15T15:00:00.000Z' }) }
  for (const id of historical) byId[id] = pipelineRow(id, { updatedAt: '2026-11-04T00:00:00.000Z' })
  const reading = readOverview({
    sessions: snapshot([...historical, running], byId),
    pipelineSessions: [...historical, running],
    sessionId: 'session-subagent',
  })
  assert.equal(reading.main.id, running, `the main window is ${reading.main.id}, not the one still running`)
})

test('none of the record-named sessions is running: the one that moved last is drawn', () => {
  const older = 'session-older'
  const newer = 'session-newer'
  const reading = readOverview({
    sessions: snapshot([older, newer], {
      [older]: pipelineRow(older, { updatedAt: '2026-11-04T00:00:00.000Z' }),
      [newer]: pipelineRow(newer, { updatedAt: '2026-11-15T02:00:00.000Z' }),
    }),
    pipelineSessions: [older, newer],
  })
  assert.equal(reading.main.id, newer, `the main window is ${reading.main.id}, not the one that moved last`)
})

test('a record-named session the list does not hold draws nothing: the stale main view is no stand-in', () => {
  const stale = 'session-old'
  const reading = readOverview({
    sessions: snapshot([stale, 'c-old'], { [stale]: mainRow(stale), 'c-old': childRow('c-old', stale) }),
    pipelineSessions: ['session-not-on-this-machine'],
    sessionId: 'session-not-on-this-machine',
  })
  assert.equal(reading.main, null, 'a window was drawn for a session the list does not hold')
  assert.deepEqual(reading.children, [], 'children were drawn off a session the list does not hold')
})

test('the record names no session at all: no window, rather than an unrelated conversation', () => {
  const stale = 'session-old'
  const reading = readOverview({
    sessions: snapshot([stale, 'c-old'], {
      [stale]: mainRow(stale, { running: true }),
      'c-old': childRow('c-old', stale),
    }),
    pipelineSessions: [],
    sessionId: 'session-subagent',
    events: { [stale]: [said(1, undefined, '不该出现的行')] },
  })
  assert.deepEqual(reading, { main: null, children: [], hiddenChildren: 0 })
})

test('another conversation in the same workspace, and its children, are never drawn', () => {
  const ours = 'session-pipeline'
  const stranger = 'session-unrelated'
  const reading = readOverview({
    sessions: snapshot(['c1', ours, stranger, 'c-stranger'], {
      [ours]: pipelineRow(ours, { running: true, updatedAt: '2026-11-15T15:00:00.000Z' }),
      c1: childRow('c1', ours),
      [stranger]: pipelineRow(stranger, { running: true, updatedAt: '2026-11-15T16:00:00.000Z' }),
      'c-stranger': childRow('c-stranger', stranger),
    }),
    pipelineSessions: [ours],
    sessionId: 'session-elsewhere',
    events: {
      'c-stranger': [said(1, undefined, '别人的子会话的行')],
      c1: [said(2, undefined, '我的子会话的行')],
    },
  })
  assert.equal(reading.main.id, ours)
  assert.deepEqual(reading.children.map((w) => w.id), ['c1'], `the drawn children are ${reading.children.map((w) => w.id)}`)
  assert.deepEqual(reading.children[0].rows.map((row) => row.full), ['我的子会话的行'])
  assert.equal(reading.hiddenChildren, 0, 'a child of another conversation was counted as a folded window')
})

test("the main window's anchors are read off its own log, never the conversation beside it", () => {
  const ours = 'session-pipeline'
  const stale = 'session-old'
  const reading = readOverview({
    sessions: snapshot([stale, 'c-stale', ours, 'c-ours'], {
      [stale]: mainRow(stale),
      'c-stale': childRow('c-stale', stale),
      [ours]: pipelineRow(ours, { running: true }),
      'c-ours': childRow('c-ours', ours),
    }),
    pipelineSessions: [ours],
    sessionId: 'session-elsewhere',
    events: {
      /* Both conversations dispatched, each with its own call id. */
      [stale]: [
        call(1, 'call-stale', 'subagent', { description: '旧会话派出去的', prompt: '…' }),
        catalog(2, { version: 0, childId: 'c-stale', childCreatedAt: 2, mode: 'continuable', label: '旧会话派出去的' }),
        result(3, 'call-stale', 'started subagent c-stale'),
      ],
      [ours]: [
        call(4, 'call-ours', 'subagent', { description: '管道派出去的', prompt: '…' }),
        catalog(5, { version: 0, childId: 'c-ours', childCreatedAt: 5, mode: 'continuable', label: '管道派出去的' }),
        result(6, 'call-ours', 'started subagent c-ours'),
      ],
    },
    nodeOf: { [ours]: 'n-ours', [stale]: 'n-stale' },
    nodes: { 'n-ours': { title: '管道自己的节点', mode: 'auto' }, 'n-stale': { title: '旧会话的节点', mode: 'auto' } },
  })
  assert.equal(reading.main.title, '管道自己的节点', `the nameplate reads ${reading.main.title}`)
  assert.deepEqual(reading.main.rows.map((row) => row.callId), ['call-ours'], "the main window's rows came from another conversation")
  assert.equal(anchorOf(reading, 'c-ours'), 'call-ours', 'the child is not anchored to its own dispatch')
  assert.equal(reading.children.length, 1, `the reading drew ${reading.children.length} children`)
})

test('a caller that says nothing about the pipeline keeps DSH\'s main view: the old reading stands', () => {
  const reading = mainAlone()
  assert.equal(reading.main.id, MAIN, 'the main view is no longer read when the caller says nothing')
  const said_nothing = readOverview({
    sessions: snapshot([MAIN], { [MAIN]: mainRow(MAIN) }),
    events: { [MAIN]: [said(1, undefined, '一句话')] },
  })
  assert.deepEqual(said_nothing.main.rows.map((row) => row.full), ['一句话'])
})

/* ---- the record's parallel legs -------------------------------------------
 *
 * A relay opens each leg after the one before it reads "closed", and a restart
 * mid-line leaves the parent links pointing wherever the last trigger stood —
 * so the parentage of two legs dispatched side by side groups nothing. The run
 * notes are the one fact about which sessions are this line's work: a leg the
 * list still calls running draws its window off the record's word alone, beside
 * the window the reader sits in, and a leg whose running bit went false draws
 * nothing again — the last completed one is the main window's own rule, and it
 * does not move.
 */

test('two record-named legs still running draw two child windows, whatever their parent links say', () => {
  const conductor = 'session-conductor'
  const fast = 'session-fast-leg'
  const slow = 'session-slow-leg'
  const reading = readOverview({
    sessions: snapshot([conductor, fast, slow], {
      [conductor]: pipelineRow(conductor, { updatedAt: '2026-11-17T06:20:15.000Z' }),
      /* The parent links are the relay's own leftovers: one points at a session that is gone, one
         at the main — neither admission is what stands these windows up. */
      [fast]: pipelineRow(fast, { running: true, parentId: 'session-gone-leg', updatedAt: '2026-11-17T06:20:40.000Z' }),
      [slow]: pipelineRow(slow, { running: true, parentId: conductor, updatedAt: '2026-11-17T06:20:41.000Z' }),
    }),
    pipelineSessions: [conductor, fast, slow],
    sessionId: conductor,
    nodeOf: { [fast]: 'n-fast', [slow]: 'n-slow' },
    nodes: {
      'n-fast': { title: '快工：一张小抄', mode: 'auto' },
      'n-slow': { title: '慢工：三段小传', mode: 'auto' },
    },
    events: { [fast]: [said(1, undefined, '快工的行')], [slow]: [said(2, undefined, '慢工的行')] },
  })
  assert.equal(reading.main.id, conductor, `the main window is ${reading.main.id}, not the reader's own conversation`)
  assert.deepEqual(reading.children.map((w) => w.id), [fast, slow], `the drawn children are ${reading.children.map((w) => w.id)}`)
  assert.deepEqual(
    reading.children.map((w) => w.title),
    ['快工：一张小抄', '慢工：三段小传'],
    'a parallel leg lost the node nameplate its run note names',
  )
  assert.equal(reading.hiddenChildren, 0, 'a drawn leg was counted as one the cap folded away')
})

test('a record-named leg whose running bit went false is no child window', () => {
  /* The slow leg's own session reads not running — whatever still moves inside
     it is another session's bit, and this reading never chases it. The main
     window's own rule is untouched: the reader's own conversation still wins
     among the record-named ones, running or not. */
  const conductor = 'session-conductor'
  const fast = 'session-fast-leg'
  const slow = 'session-slow-leg'
  const reading = readOverview({
    sessions: snapshot([conductor, fast, slow], {
      [conductor]: pipelineRow(conductor),
      [fast]: pipelineRow(fast, { running: true, updatedAt: '2026-11-17T06:20:40.000Z' }),
      [slow]: pipelineRow(slow, { parentId: conductor, updatedAt: '2026-11-17T06:20:41.000Z' }),
    }),
    pipelineSessions: [conductor, fast, slow],
    sessionId: slow,
  })
  assert.equal(reading.main.id, slow, `the main window is ${reading.main.id}, not the reader's own conversation`)
  assert.deepEqual(reading.children.map((w) => w.id), [fast], `the drawn children are ${reading.children.map((w) => w.id)}`)
})

/* ---- a window that can say nothing is no window ---------------------------
 *
 * The list's running bit alone never stands a window up: a session with no
 * nameplate word (no node the notes name, no label the list spells) and no row
 * its own events fold into would draw as a bordered box with an empty head —
 * the one thing this panel must never invent. One readable half is enough,
 * either half: a label names the window, rows say what it is doing.
 */

test('a running session with no readable head and no readable events is a box, not a window', () => {
  const speechless = readOverview({
    sessions: snapshot([MAIN, 'c-1', 'c-2'], {
      [MAIN]: mainRow(MAIN),
      'c-1': { id: 'c-1', running: true, parentId: MAIN, retainedBy: {} },
      'c-2': childRow('c-2', MAIN),
    }),
  })
  assert.deepEqual(speechless.children.map((w) => w.id), ['c-2'], 'a headless, eventless box was drawn as a window')
  assert.equal(speechless.hiddenChildren, 0, 'the box was counted as a window the cap folded away')

  const titled = readOverview({
    sessions: snapshot([MAIN, 'c-1'], {
      [MAIN]: mainRow(MAIN),
      'c-1': { id: 'c-1', running: true, parentId: MAIN, displayTitle: 'the label the list spells', retainedBy: {} },
    }),
  })
  assert.deepEqual(titled.children.map((w) => w.id), ['c-1'], 'a running session with a label but no rows lost its window')

  const spoken = readOverview({
    sessions: snapshot([MAIN, 'c-1'], {
      [MAIN]: mainRow(MAIN),
      'c-1': { id: 'c-1', running: true, parentId: MAIN, retainedBy: {} },
    }),
    events: { 'c-1': [said(1, undefined, '它干了什么')] },
  })
  assert.deepEqual(spoken.children.map((w) => w.id), ['c-1'], 'a running session with rows but no label lost its window')
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

test("a run result that opens on a blank line cuts to no sentence, so it folds to no row", () => {
  /* The shape the real rehearsal log carries: PowerShell's table output opens with a
     blank line, the cut lands before the first word, and a wordless run row would
     draw as its word and the separator alone. The command's row already stands. */
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [
        call(1, 'call-1', 'pwsh', { command: 'Get-ChildItem C:\\demo' }),
        result(2, 'call-1', '\r\nPath\r\n----\r\nC:\\demo\r\n\r\n'),
        call(3, 'call-2', 'bash', { command: 'echo done' }),
        result(4, 'call-2', '\r\n\r\n'),
      ],
    },
  })
  const rows = reading.children[0].rows
  assert.deepEqual(rows.map((r) => r.kind), ['run', 'run'], 'a wordless run row was collected')
  assert.deepEqual(rows.map((r) => r.text), ['Get-ChildItem C:\\demo', 'echo done'])
})

test("a command opening on a line break draws no wordless row, yet its result still answers", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: {
      'c-1': [
        call(1, 'call-1', 'bash', { command: '\n npx vitest run superworker-core' }),
        result(2, 'call-1', '14 个用例通过'),
      ],
    },
  })
  const rows = reading.children[0].rows
  assert.deepEqual(rows.map((r) => r.kind), ['run'], 'the result lost its answer for want of the call id')
  assert.equal(rows[0].text, '14 个用例通过')
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

/* ---- which call dispatched which window ---------------------------------- */

test('v0: the sentence names the child id, and the window keeps the call that started it', () => {
  const reading = dispatched(
    [
      call(1, 'call-1', 'subagent', { description: '调研会话读取', prompt: '…' }),
      catalog(2, { version: 0, childId: 'c-1', childCreatedAt: 2, mode: 'continuable', label: '调研会话读取' }),
      result(3, 'call-1', 'started subagent c-1'),
    ],
    ['c-1'],
  )
  const row = reading.main.rows[0]
  assert.equal(row.kind, 'dispatch')
  assert.equal(row.text, '调研会话读取')
  assert.equal(row.callId, 'call-1')
  assert.equal(anchorOf(reading, 'c-1'), 'call-1')
})

test('v3: the activation name and the catalog name are the chain, and the sentence is never read', () => {
  const reading = dispatched(
    [
      call(1, 'call-1', 'subagent', { description: '复审节点', prompt: '…', name: 'review-45567ffa' }),
      catalog(2, {
        version: 3,
        childId: 'c-1',
        childCreatedAt: 2,
        mode: 'continuable',
        label: '复审节点 45567ffa 第 1 轮',
        name: 'review-45567ffa',
      }),
      /* The sentence says nothing about the child: only the activation's own name does. */
      result(3, 'call-1', 'the words a v0 log would have spelled are absent here', undefined, {
        meta: { kind: 'activation', name: 'review-45567ffa' },
      }),
    ],
    ['c-1'],
  )
  assert.equal(reading.main.rows[0].callId, 'call-1')
  assert.equal(anchorOf(reading, 'c-1'), 'call-1')
})

test('three concurrent dispatches: every window keeps the call that named it, not the catalogue beside it', () => {
  /* The log's real interleaving: the three calls come back to back, and each catalogue and
   * its result lands after some later call — the entry next to a call belongs to another one. */
  const reading = dispatched(
    [
      call(10, 'call-a', 'subagent', { description: 'A 调研', prompt: '…' }),
      call(11, 'call-b', 'subagent', { description: 'B 调研', prompt: '…' }),
      call(12, 'call-c', 'subagent', { description: 'C 调研', prompt: '…' }),
      catalog(13, { version: 0, childId: 'c-b', childCreatedAt: 13, mode: 'continuable', label: 'B 调研' }),
      result(14, 'call-c', 'started subagent c-c'),
      catalog(15, { version: 0, childId: 'c-c', childCreatedAt: 15, mode: 'continuable', label: 'C 调研' }),
      result(16, 'call-a', 'started subagent c-a'),
      catalog(17, { version: 0, childId: 'c-a', childCreatedAt: 17, mode: 'continuable', label: 'A 调研' }),
      result(18, 'call-b', 'started subagent c-b'),
    ],
    ['c-a', 'c-b', 'c-c'],
  )
  assert.equal(anchorOf(reading, 'c-a'), 'call-a')
  assert.equal(anchorOf(reading, 'c-b'), 'call-b')
  assert.equal(anchorOf(reading, 'c-c'), 'call-c')
})

test('two children born in the same millisecond: each still keeps its own call', () => {
  /* Every time in this scene is equal, so no reading of the clock can tell the two apart. */
  const reading = dispatched(
    [
      call(100, 'call-a', 'subagent', { description: 'A 调研', prompt: '…' }),
      call(100, 'call-b', 'subagent', { description: 'B 调研', prompt: '…' }),
      catalog(100, { version: 0, childId: 'c-2', childCreatedAt: 100, mode: 'continuable', label: 'B 调研' }),
      catalog(100, { version: 0, childId: 'c-1', childCreatedAt: 100, mode: 'continuable', label: 'A 调研' }),
      result(100, 'call-a', 'started subagent c-1'),
      result(100, 'call-b', 'started subagent c-2'),
    ],
    ['c-1', 'c-2'],
  )
  assert.equal(anchorOf(reading, 'c-1'), 'call-a')
  assert.equal(anchorOf(reading, 'c-2'), 'call-b')
})

test('one call may stand behind two windows: a loop dispatch anchors every child it started', () => {
  const reading = dispatched(
    [
      call(1, 'call-ralph', 'ralph', { objective: '把快档跑绿' }),
      catalog(2, { version: 0, childId: 'c-1', childCreatedAt: 2, mode: 'one-shot', label: 'Ralph round 1' }),
      catalog(3, { version: 0, childId: 'c-2', childCreatedAt: 3, mode: 'one-shot', label: 'Ralph round 2' }),
      /* A loop answers once for each child it started. */
      result(4, 'call-ralph', 'started subagent c-1'),
      result(5, 'call-ralph', 'started subagent c-2'),
    ],
    ['c-1', 'c-2'],
  )
  assert.equal(anchorOf(reading, 'c-1'), 'call-ralph')
  assert.equal(anchorOf(reading, 'c-2'), 'call-ralph')
  assert.equal(reading.main.rows[0].callId, 'call-ralph')
})

test('subagent_continue names its child in the arguments, and needs no catalogue', () => {
  const reading = dispatched(
    [call(1, 'call-9', 'subagent_continue', { description: '续问上一轮的总览', sessionId: 'c-1' })],
    ['c-1'],
  )
  const row = reading.main.rows[0]
  assert.equal(row.kind, 'dispatch')
  assert.equal(row.callId, 'call-9')
  assert.equal(anchorOf(reading, 'c-1'), 'call-9')
})

test('a continuation that opens a fresh child anchors that child, not the session its arguments name', () => {
  /* The log's real shape: the arguments name the session to continue (`c-old`), while the answer and
   * the catalogue it wrote at that moment name the child the continuation opened (`c-new`). */
  const reading = dispatched(
    [
      call(1, 'call-9', 'subagent_continue', { description: 'Recover M1 requirement context', sessionId: 'c-old' }),
      catalog(2, {
        version: 0,
        childId: 'c-new',
        childCreatedAt: 2,
        mode: 'continuable',
        label: 'Recover M1 requirement context',
      }),
      result(3, 'call-9', 'started continued subagent c-new'),
    ],
    ['c-old', 'c-new'],
  )
  assert.equal(anchorOf(reading, 'c-new'), 'call-9')
  assert.equal('dispatchCallId' in reading.children.find((w) => w.id === 'c-old'), false)
})

test('a dispatch row cut by the window capacity still anchors its child, and no other row stands in', () => {
  const reading = dispatched(
    [
      call(1, 'call-1', 'subagent', { description: '派出去做长活', prompt: '…' }),
      catalog(2, { version: 0, childId: 'c-1', childCreatedAt: 2, mode: 'continuable', label: '派出去做长活' }),
      result(3, 'call-1', 'started subagent c-1'),
      said(4, undefined, 'c-1 已经接手'),
      said(5, undefined, '继续等它回来'),
    ],
    ['c-1'],
    {},
    { capacity: 1 },
  )
  /* The anchor is a fact about the log, not about the drawing: the row carrying it fell off the
   * top, so the main window has no line pointing at the child — and the reading must not borrow one. */
  assert.equal(anchorOf(reading, 'c-1'), 'call-1')
  assert.deepEqual(reading.main.rows.map((row) => row.text), ['继续等它回来'])
  assert.deepEqual(reading.main.rows.map((row) => row.callId), [undefined])
  assert.equal('dispatchCallId' in reading.main, false)
})

test('an unreadable dispatch anchors nothing: still in flight, or answered by a failure', () => {
  const inFlight = dispatched(
    [
      call(1, 'call-1', 'subagent', { description: '派出去还没回来', prompt: '…' }),
      catalog(2, { version: 0, childId: 'c-1', childCreatedAt: 2, mode: 'continuable', label: '派出去还没回来' }),
    ],
    ['c-1'],
  )
  assert.equal('dispatchCallId' in inFlight.children[0], false)

  const failed = dispatched(
    [
      call(1, 'call-1', 'subagent', { description: '派出去了但失败了', prompt: '…' }),
      catalog(2, { version: 0, childId: 'c-1', childCreatedAt: 2, mode: 'continuable', label: '派出去了但失败了' }),
      result(3, 'call-1', '', { name: 'ToolFailure', code: 'dispatch-failed', reason: '子代理起不来' }),
    ],
    ['c-1'],
  )
  assert.equal('dispatchCallId' in failed.children[0], false)

  const isError = dispatched(
    [
      call(1, 'call-1', 'subagent', { description: '结果是错的', prompt: '…' }),
      catalog(2, { version: 0, childId: 'c-1', childCreatedAt: 2, mode: 'continuable', label: '结果是错的' }),
      result(3, 'call-1', 'started subagent c-1', undefined, { isError: true }),
    ],
    ['c-1'],
  )
  assert.equal('dispatchCallId' in isError.children[0], false)
})

/* ---- the live step's tails -------------------------------------------------
 *
 * While a step streams, the transient live chunks the caller hands over draw
 * at most two rows — the thinking tail, then the spoken tail — each the live
 * buffer's newest slice, cut to a small tail and moving with the stream. They
 * hang after the settled rows, and the step's message settling folds them away
 * into the ordinary rows. The settled rows' shape does not move.
 */

/** One live chunk, the way DSH's transient entries carry it. */
function liveChunk(type, delta, attemptId = 'attempt-1') {
  return { type: 'assistant/live-chunk', time: 1, data: { attemptId, chunk: { type, text: delta } } }
}

/** One child streaming under the main session. */
function streamed(durable, live, extra = {}) {
  return readOverview({
    sessions: snapshot([MAIN, 'c-1'], { [MAIN]: mainRow(MAIN), 'c-1': childRow('c-1', MAIN) }),
    events: { 'c-1': durable },
    ...(live === undefined ? {} : { live: { 'c-1': live } }),
    ...extra,
  })
}

test('a streaming step draws at most two tails, after the settled rows', () => {
  const reading = streamed(
    [call(1, 'call-1', 'read', { file_path: 'a.ts' })],
    [
      /* Tool arguments stream the same way and read to nothing here. */
      { type: 'assistant/live-chunk', time: 1, data: { attemptId: 'attempt-1', chunk: { type: 'tool-call-delta', index: 0, id: 't1', argumentsDelta: '{"a":1}' } } },
      liveChunk('reasoning-delta', '先读先例，'),
      liveChunk('reasoning-delta', '再比对拼写。'),
      liveChunk('text-delta', '条目级合并要认出'),
    ],
  )
  const rows = reading.children[0].rows
  assert.deepEqual(rows.map((r) => r.kind), ['read', 'think', 'output'], 'the tails did not hang after the settled rows in order')
  assert.deepEqual(rows.map((r) => r.live), [undefined, true, true], 'the tails do not read as live rows, or the settled row does')
  assert.equal(rows[1].text, '先读先例，再比对拼写。')
  assert.equal(rows[2].text, '条目级合并要认出')
  /* Each tail carries its own slice as its whole content: a live row keeps no "full" copy for a tooltip to churn per frame. */
  assert.equal(rows[1].full, rows[1].text)
})

test('a long line keeps only its tail: the newest characters, never half a glyph', () => {
  const spoken = 'x'.repeat(200) + '最新的一小段'
  const reading = streamed([], [liveChunk('text-delta', spoken)])
  const tail = reading.children[0].rows[0].text
  assert.equal(tail, spoken.slice(-120), 'the tail is not the buffer\'s newest slice')
  assert.ok(tail.endsWith('最新的一小段'), 'the tail lost its newest words')

  /* A slice that lands between the two halves of a surrogate pair drops the orphan, and keeps a whole pair. */
  const split = 'a' + '😀' + 'b'.repeat(119)
  assert.equal(streamed([], [liveChunk('text-delta', split)]).children[0].rows[0].text, 'b'.repeat(119))
  const whole = 'a'.repeat(119) + '😀'
  assert.equal(streamed([], [liveChunk('text-delta', whole)]).children[0].rows[0].text, 'a'.repeat(118) + '😀')
})

test('the tail follows the newest line, and a trailing break falls back to the finished one', () => {
  const moved = streamed([], [liveChunk('reasoning-delta', '第一行已经写完。\n第二行正在写')])
  assert.equal(moved.children[0].rows[0].text, '第二行正在写', 'the tail did not follow the line break')
  const trailing = streamed([], [liveChunk('reasoning-delta', '刚写完的一行\n')])
  assert.equal(trailing.children[0].rows[0].text, '刚写完的一行', 'a trailing break blanked the row')
  const collapsed = streamed([], [liveChunk('text-delta', '词  之间\t的空白收拢')])
  assert.equal(collapsed.children[0].rows[0].text, '词 之间 的空白收拢')
})

test('the step settling folds the tails away into the ordinary rows', () => {
  const durable = [said(1, '先读先例。', '条目级合并要认出插件自己声明的域。覆盖和缺省分开存。')]
  const streaming = streamed(
    durable,
    [liveChunk('reasoning-delta', '先读先例的最后一小段'), liveChunk('text-delta', '覆盖和缺省分开存的最后一小段')],
  )
  assert.deepEqual(
    streaming.children[0].rows.map((r) => [r.kind, r.live]),
    [['think', undefined], ['output', undefined], ['think', true], ['output', true]],
    'the tails did not hang after the settled rows, or were not live',
  )
  /* The chunks retired, the same conversation folds the old way: first-sentence rows, nothing live. */
  const settled = streamed(durable)
  assert.deepEqual(
    settled.children[0].rows.map((r) => r.text),
    ['先读先例。', '条目级合并要认出插件自己声明的域。'],
  )
  assert.ok(settled.children[0].rows.every((r) => r.live === undefined), 'a settled row carried the live mark')
})

test('a retry starts the tails over: the newest attempt is the one read', () => {
  const reading = streamed([], [
    liveChunk('text-delta', '旧的一次尝试写到一半', 'attempt-1'),
    liveChunk('text-delta', '新的一次从头写', 'attempt-2'),
  ])
  assert.deepEqual(reading.children[0].rows.map((r) => r.text), ['新的一次从头写'])
})

test('chunks that say nothing draw no tail', () => {
  const reading = streamed([], [
    liveChunk('text-delta', '   '),
    liveChunk('text-delta', '\n\t\n'),
    { type: 'assistant/live-chunk', time: 1, data: { attemptId: 'attempt-1', chunk: { type: 'finish', reason: 'stop' } } },
  ])
  assert.deepEqual(reading.children[0].rows, [])
})

test("the main window draws the same tails off its own conversation's chunks", () => {
  const reading = readOverview({
    sessions: snapshot([MAIN], { [MAIN]: mainRow(MAIN, { running: true }) }),
    live: { [MAIN]: [liveChunk('text-delta', '正在说的一句话')] },
  })
  assert.deepEqual(reading.main.rows.map((r) => [r.kind, r.text]), [['output', '正在说的一句话']])
})
