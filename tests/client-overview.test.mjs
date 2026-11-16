/* The overview on the built panel: the reading drawn as windows, the four motion marks each bound
 * to its fact, and the three states a window can be in.
 *
 * The session list arrives the way the seat hands it over (a `useSessions` hook over a snapshot the
 * case holds and moves), and the event windows arrive through a stand-in for DSH's `sessions`
 * service — the same narrow face `session-events.ts` reads. What the cases hold down:
 *
 * - the windows and their words: the node's own nameplate on the main window, running children
 *   only, a child that ended no window at all, and no session id printed anywhere;
 * - enter — a window joining the set carries the mark;
 * - leave — a window leaving carries the mark, and after the leave's span the page has lost it;
 *   a child that ends is exactly that: the reading stops drawing it, and the animation takes it away;
 * - fresh row — the arrival's two readings carry the mark, on that row alone: a gained row even
 *   when its text repeats the previous newest (growth), and a swapped newest at a steady count
 *   (the cut);
 * - breathing — the person gate's alone: the main window at a checkpoint wears it, while a window
 *   whose newest row is a dispatch row keeps its ring and draws no border;
 * - the main window's three states, one fact each: running draws as it runs; not running under no
 *   gate is finished — rows in place under the veil and the check; at a person's gate (a checkpoint
 *   the record's own gate reading names) it breathes amber, with no veil and no check;
 * - a running child turns the small ring, and wears neither veil nor check.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/client-overview.test.mjs`.
 */
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssBlocks, stripComments } from '../tools/lib/cssrules.mjs'
import {
  LINK_DOT_R,
  MAIN_FOOT,
  MAIN_HEAD,
  MARK_CHECK,
  MARK_CHECK_STROKE,
  READING_CAPACITY,
  ROW_H,
  layoutLink,
  layoutMark,
  layoutOverview,
  layoutRing,
  layoutSpill,
} from '../src/client/overview-geom.ts'
import { zh } from '../src/client/locales/zh.ts'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'
import { flush } from './helpers/wait.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** The record: one node, one line, and the note that names m1 as that node's session. */
const record = () => ({
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        description: 'the piece the main conversation drives',
        tags: [],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-08T00:00:00.000Z',
        completed_at: '2026-01-09T00:00:00.000Z',
        dependencies: [],
      },
    },
  }),
  '.superworker/state.json': json({
    cycles: [
      {
        id: 'c0',
        title: 'a line',
        status: 'active',
        tags: [],
        created_at: '2026-01-08T00:00:00.000Z',
        updated_at: '2026-01-09T00:00:00.000Z',
        policies: {},
        holding: [],
        path: [
          { node: 'n0', started_at: '2026-01-08T00:00:00.000Z', ended_at: '2026-01-09T00:00:00.000Z', result: 'delivered' },
        ],
      },
    ],
  }),
  '.superworker/instructions.json': json({ instructions: [] }),
  '.superworker/issues/issues.json': json({ version: 1, issues: {} }),
  '.superworker/meta/sessions/n0.json': json({ run: [{ session: 'm1', at: '2026-01-09T00:00:00.000Z' }] }),
})

/** The same record, with the node at a person's gate: delivered, and that delivery not yet approved. */
const recordAtCheckpoint = () => ({
  ...record(),
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        description: 'the piece the main conversation drives',
        tags: [],
        mode: 'checkpoint',
        status: 'completed',
        created_at: '2026-01-08T00:00:00.000Z',
        completed_at: '2026-01-09T00:00:00.000Z',
        dependencies: [],
      },
    },
  }),
})

/** The session-list snapshot, in the shape the seat's `useSessions` hook hands over. */
const snapshotOf = (children) => ({
  ids: ['m1', ...children.map((one) => one.id)],
  byId: {
    m1: { id: 'm1', running: true, retainedBy: { mainView: 1 }, displayTitle: 'the main conversation' },
    ...Object.fromEntries(children.map((one) => [
      one.id,
      { id: one.id, running: one.running, parentId: 'm1', displayTitle: one.title },
    ])),
  },
})

/** A stand-in for DSH's `sessions` service: retaining opens one event window, `set` moves its tail.
 * `set` takes bare session events and stores them the way DSH's window carries them — every row a
 * `{ type: 'event', event }` entry; the live-chunk shape is never produced here. */
function fakeSessionsService() {
  const windows = new Map()
  const stateOf = (id) => {
    let state = windows.get(id)
    if (state === undefined) {
      state = { entries: [], listeners: new Set() }
      windows.set(id, state)
    }
    return state
  }
  return {
    windows,
    retain(id) {
      const state = stateOf(id)
      const source = {
        getSnapshot: () => ({ entries: state.entries, hasMore: false, revision: 0, change: { kind: 'replace', entries: state.entries } }),
        subscribe(listener) {
          state.listeners.add(listener)
          return () => state.listeners.delete(listener)
        },
      }
      return { sessionId: id, binding: { eventSource: source }, ready: Promise.resolve({}), release() {} }
    },
    set(id, events) {
      const state = stateOf(id)
      state.entries = events.map((event) => ({ type: 'event', event }))
      for (const listener of [...state.listeners]) listener()
    },
  }
}

const said = (text, time) => ({ type: 'assistant/message', time, data: { message: { content: [{ type: 'text', text }] } } })
const dispatched = (text, time, callId) => ({ type: 'tool/call', time, data: { name: 'subagent', callId, arguments: JSON.stringify({ description: text }) } })
const read = (path, time) => ({ type: 'tool/call', time, data: { name: 'read', callId: `r${time}`, arguments: JSON.stringify({ file_path: path }) } })
/** The parent's own discovery fact for one child: what the anchor is chained through. */
const catalogued = (childId, time) => ({ type: 'subagent/catalog', time, data: { version: 0, childId, childCreatedAt: time, mode: 'continuable', label: `child ${childId}` } })
/** A dispatch's answer, naming the child it started: the other half of the chain. */
const started = (callId, childId, time) => ({
  type: 'tool/result',
  time,
  data: { message: { toolCallId: callId, content: [{ type: 'text', text: `started subagent ${childId}` }] } },
})
/** One dispatch, whole: the call, the catalogue it wrote, and the answer that names its child. */
const dispatchRun = (childId, callId, text, time) => [
  dispatched(text, time, callId),
  catalogued(childId, time + 1),
  started(callId, childId, time + 2),
]

/** The stage the pane measures: jsdom has no layout engine, so the box is pinned per case. */
const stageAt = (mounted, width, height) => {
  const body = mounted.container.querySelector('.superworker-overview')
  Object.defineProperty(body, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(body, 'clientHeight', { value: height, configurable: true })
  return mounted.rerender()
}

test('the overview draws the reading: the node nameplate on the main window, running children only, no session id printed', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 1000), dispatched('look for conflicts', 2000, 'd1')])
  service.set('c1', [read('a.ts', 3000)])
  let snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c2', running: false, title: 'the stopped child' },
  ])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted

  const main = container.querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')
  assert.ok(main.className.includes('is-main'), 'the main window does not wear the main class')
  assert.equal(main.querySelector('.superworker-oplate-t')?.textContent, 'the driven node', 'the nameplate does not read the record node the note names')
  assert.ok((main.querySelector('.superworker-oplate-m span')?.textContent ?? '').length > 0, 'the nameplate carries no readings line')
  assert.notEqual(main.querySelector('.superworker-oplate-m .superworker-num'), null, 'the nameplate carries no moment')

  const child = container.querySelector('[data-window="c1"]')
  assert.notEqual(child, null, 'a running child is not drawn')
  assert.equal(child.querySelector('.superworker-ohead-t')?.textContent, 'the first child', 'the child title line does not read the list label')
  assert.equal(child.querySelector('.superworker-ohead-r'), null, 'a window that works no node carries a readings line')
  assert.notEqual(child.querySelector('.superworker-ohead .superworker-num'), null, 'the child title line carries no moment')
  assert.equal(container.querySelector('[data-window="c2"]'), null, 'a stopped child became a window')

  assert.ok(!((container.textContent ?? '').includes('m1') || (container.textContent ?? '').includes('c1')), 'a session id printed on the page')

  assert.equal(main.querySelectorAll('.superworker-orow').length, 2, 'the main window does not draw its two rows')
  assert.equal(child.querySelectorAll('.superworker-orow').length, 1, 'the child does not draw its one row')

  /* One running child: no node rail. The main window's newest row is a dispatch row, and the amber
   * border answers the person gate alone — so neither window breathes here. */
  assert.equal(container.querySelector('.superworker-orail'), null, 'one child drew a node rail')
  assert.ok(!main.className.includes('is-wait'), 'a main window whose newest row is a dispatch row breathes: the border answers the gate alone')
  assert.ok(!child.className.includes('is-wait'), 'a child whose newest row is a read breathes')

  /* Enter marks on first sight: both windows joined the set on this beat. */
  assert.ok(main.className.includes('is-enter'), 'the main window carries no enter mark')
  assert.ok(child.className.includes('is-enter'), 'a joining child carries no enter mark')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the field is the stage frame at the origin, and every pane stands at the geometry\'s own coordinate', { skip: bundleSkip }, async () => {
  /* The one convention the drawing owed the arithmetic: the boxes are stage coordinates already, so
   * the field carries no offset of its own — a left/top on it as well would add the same offset a
   * second time, which is how the whole group once slid right off the stage. */
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 1000), dispatched('look for conflicts', 2000, 'd1')])
  service.set('c1', [read('a.ts', 3000)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  /* The same inputs the pane measures and reads: one main window holding two rows, one child one row. */
  const placement = layoutOverview({ stage: { width: 1024, height: 720 }, mainRows: 2, childRows: [1] })

  const field = container.querySelector('.superworker-ofield')
  assert.notEqual(field, null, 'the field is not drawn')
  for (const side of ['left', 'top', 'width', 'height']) {
    assert.equal(field.style[side], '', `the field carries an inline ${side}: the geometry's offset is written twice`)
  }
  const computed = mounted.window.getComputedStyle(field)
  assert.equal(computed.position, 'absolute', 'the field is not an absolutely placed frame')
  const coversStage = computed.inset === '0' || (computed.left === '0px' && computed.top === '0px')
  assert.ok(coversStage, `the field does not sit on the stage's origin: inset ${computed.inset}, left ${computed.left}, top ${computed.top}`)

  const main = container.querySelector('[data-window="m1"]')
  const child = container.querySelector('[data-window="c1"]')
  assert.equal(main.style.left, `${placement.main.left}px`, `the main window stands at ${main.style.left}, the geometry says ${placement.main.left}`)
  assert.equal(main.style.top, `${placement.main.top}px`, `the main window stands at ${main.style.top}, the geometry says ${placement.main.top}`)
  assert.equal(main.style.width, `${placement.main.width}px`, `the main window is ${main.style.width} wide, the geometry says ${placement.main.width}`)
  assert.equal(main.style.height, `${placement.main.height}px`, `the main window is ${main.style.height} tall, the geometry says ${placement.main.height}`)
  assert.equal(child.style.left, `${placement.children[0].left}px`, `the child stands at ${child.style.left}, the geometry says ${placement.children[0].left}`)
  assert.equal(child.style.top, `${placement.children[0].top}px`, `the child stands at ${child.style.top}, the geometry says ${placement.children[0].top}`)
  /* Both panes hang off the one field, which is the stage whole: the numbers are read against one
   * frame, not against a frame that was itself moved. */
  assert.equal(main.parentElement, field, 'the main window does not hang off the field')
  assert.equal(child.parentElement, field, 'the child does not hang off the field')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('enter: a window joining the set carries the mark', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(container(mounted).querySelector('[data-window="c2"]'), null, 'the second child is there before it runs')
  snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c2', running: true, title: 'the second child' },
  ])
  await mounted.rerender()
  const second = container(mounted).querySelector('[data-window="c2"]')
  assert.notEqual(second, null, 'the joining child did not become a window')
  assert.ok(second.className.includes('is-enter'), 'the joining child carries no enter mark')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('leave: the pane fades where it stands, and after the span the page has lost it', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* Both children are anchored, so the leaving pane's own line says how the tie leaves with it. */
  service.set('m1', [...dispatchRun('c1', 'd1', 'the first job', 100), ...dispatchRun('c3', 'd3', 'the leaving job', 200)])
  let snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c3', running: true, title: 'the leaving child' },
  ])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(container(mounted).querySelectorAll('.superworker-orail b').length, 2, 'two running children drew a node rail')
  assert.equal(container(mounted).querySelectorAll('.superworker-olinks path').length, 2, 'two anchored children drew two lines')
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const leaving = container(mounted).querySelector('[data-window="c3"]')
  assert.notEqual(leaving, null, 'the leaving pane left the page before its leave ran')
  assert.ok(leaving.className.includes('is-leave'), 'the leaving pane carries no leave mark')
  /* The tie stands with the pane it ties: the line leaves when the pane does, not a beat early. */
  assert.equal(container(mounted).querySelectorAll('.superworker-olinks path').length, 2, 'the leaving pane lost its line before it left')
  /* One running child left: the node rail is gone whole — a single window draws no rail. */
  assert.equal(container(mounted).querySelector('.superworker-orail'), null, 'the rail lingered on one child')

  /* Waiting on the leave's own span: the removal is the component's timer, and jsdom fires no
   * animationend to hang on — the only fact to wait for is the span itself running out. Inside
   * act, because the span's expiry is what updates the drawing. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 340))
  })
  assert.equal(container(mounted).querySelector('[data-window="c3"]'), null, 'the page kept the pane past the leave span')
  assert.equal(container(mounted).querySelectorAll('.superworker-olinks path').length, 1, 'the page kept the leaving child\'s line past the leave span')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('fresh row: the replaced newest row carries the mark, on that row alone', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('c1', [said('first words.', 1000)])
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow.is-fresh').length, 0, 'the first sight of a window is a fresh row')

  await mounted.act(async () => {
    service.set('c1', [said('first words.', 1000), said('the second words.', 2000)])
  })
  const fresh = container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow.is-fresh')
  assert.equal(fresh.length, 1, `the fresh mark landed on ${fresh.length} rows`)
  assert.ok(fresh[0].textContent.includes('the second words.'), 'the mark is not on the newest row')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('fresh row: a row gained whose text repeats the previous newest is still an arrival', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('c1', [said('first words.', 1000)])
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)

  /* Under the room cut the feed only grows: the second beat gains a row whose text is the
   * previous newest row's own. Row count 1 -> 2, newest row's text unchanged. */
  await mounted.act(async () => {
    service.set('c1', [said('first words.', 1000), said('first words.', 2000)])
  })
  const rows = container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow')
  assert.equal(rows.length, 2, 'the feed did not gain the repeated row')
  const fresh = container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow.is-fresh')
  assert.equal(fresh.length, 1, `the repeated row's arrival carries ${fresh.length} fresh marks`)
  assert.ok(fresh[0].textContent.includes('first words.'), 'the mark is not on the newest row')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('fresh row: at a steady count the swapped newest row carries the mark', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* Full room: the feed stands at the capacity the panel hands the reading's cut, so the next
   * beat's rows keep the count and swap the newest row — the capped reading of the arrival. */
  const feed = (last) => [
    ...Array.from({ length: READING_CAPACITY - 1 }, (_, i) => said(`row ${i}.`, 1000 + i)),
    last,
  ]
  service.set('c1', feed(said(`row ${READING_CAPACITY - 1}.`, 5000)))
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(
    container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow').length,
    READING_CAPACITY,
    'the feed is not standing at the room cut',
  )

  await mounted.act(async () => {
    service.set('c1', feed(said('the swapped row.', 9000)))
  })
  const rows = container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow')
  assert.equal(rows.length, READING_CAPACITY, 'the count did not hold at the cut')
  const fresh = container(mounted).querySelectorAll('[data-window="c1"] .superworker-orow.is-fresh')
  assert.equal(fresh.length, 1, `the swapped newest row carries ${fresh.length} fresh marks`)
  assert.ok(fresh[0].textContent.includes('the swapped row.'), 'the mark is not on the swapped row')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('breathing belongs to the person gate alone: a child whose newest row is a dispatch row keeps its ring', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* Two running children, so the node rail stands and its bars can be read. */
  const snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c2', running: true, title: 'the second child' },
  ])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  await mounted.act(async () => {
    service.set('c1', [dispatched('a task out', 1000, 'd9')])
  })
  const pane = container(mounted).querySelector('[data-window="c1"]')
  assert.ok(!pane.className.includes('is-wait'), 'a window whose newest row is a dispatch row breathes: the amber border answers the gate alone')
  assert.notEqual(pane.querySelector('.superworker-oring'), null, 'a running child waiting on its dispatch lost its ring')
  /* The rail's warn ink answers the same one fact: a bar lights for the window at the gate, and a
   * child waiting for an answer stands for nothing there. */
  assert.equal(container(mounted).querySelectorAll('.superworker-orail b.is-need').length, 0, 'a rail bar lit the gate ink for a child waiting on an answer')
  await mounted.act(async () => {
    service.set('c1', [dispatched('a task out', 1000, 'd9'), said('it came back.', 2000)])
  })
  assert.ok(!container(mounted).querySelector('[data-window="c1"]').className.includes('is-wait'), 'the row stopped being a dispatch and the window started breathing')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

/* ---- the cell: the main window's three states, a running child's ring ------ */

test('a child that ends leaves the page: the pane fades where it stands, and after the span it is gone', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* The dispatch row that opened it is still on the main feed — a finished child is no window on it. */
  service.set('m1', [...dispatchRun('c1', 'd1', 'the finishing job', 100), said('it came back.', 400)])
  service.set('c1', [read('a.ts', 200), said('the child finished its work.', 300)])
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the finishing child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  assert.notEqual(container.querySelector('[data-window="c1"]'), null, 'the running child is not drawn')

  /* The child's session stops running. The reading stops drawing it, so the pane leaves by the
   * animation it already runs when an id vanishes: it is not kept as a finished window, it carries
   * no check, and nothing stands where it stood. */
  snap = snapshotOf([{ id: 'c1', running: false, title: 'the finishing child' }])
  await mounted.rerender()
  const leaving = container.querySelector('[data-window="c1"]')
  assert.notEqual(leaving, null, 'the pane left the page before its leave ran')
  assert.ok(leaving.className.includes('is-leave'), 'the leaving pane carries no leave mark')
  assert.equal(leaving.querySelector('.superworker-omark'), null, 'a finished child was kept with the check')
  assert.ok(!leaving.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'a finished child was kept veiled')

  /* Waiting on the leave's own span: the removal is the component's timer, and jsdom fires no
   * animationend to hang on — the only fact to wait for is the span itself running out. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 340))
  })
  assert.equal(container.querySelector('[data-window="c1"]'), null, 'the page kept the finished child past the leave span')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the main window whose session has stopped: veiled rows and the check, nothing else', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('a word from the conversation being read.', 100)])
  /* The list says nobody is typing into it: the conversation has stopped, and its reader is the next
   * move. That is the finished state — the rows stay where they stand, veiled, under the one mark. */
  const snap = {
    ids: ['m1'],
    byId: { m1: { id: 'm1', running: false, displayTitle: 'the main conversation' } },
  }
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const main = container.querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')

  const feed = main.querySelector('.superworker-ofeed')
  assert.ok(feed.className.includes('is-veiled'), "the stopped window's rows are not veiled")
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the stopped window lost its rows instead of keeping them in place')
  const mark = main.querySelector('.superworker-omark')
  assert.notEqual(mark, null, 'the stopped window wears no check')
  assert.notEqual(mark.querySelector('svg'), null, 'the check is not drawn')
  assert.equal(mark.className.includes('is-fail'), false, 'a clean stop wears the failed mark')
  assert.equal(main.querySelector('.superworker-oring'), null, 'the main window turns a ring')
  assert.equal(main.className.includes('is-wait'), false, 'a stopped window no gate holds still waits')

  /* The mark's box and pen are the geometry's own: the process band's middle, 44 across. */
  const placement = layoutOverview({ stage: { width: 1024, height: 720 }, mainRows: 1, childRows: [] })
  const expected = layoutMark({
    width: placement.main.width,
    height: placement.main.height,
    head: MAIN_HEAD,
    foot: MAIN_FOOT,
    size: MARK_CHECK,
    stroke: MARK_CHECK_STROKE,
  })
  assert.equal(mark.style.left, `${expected.left}px`, `the check stands at ${mark.style.left}, the geometry says ${expected.left}`)
  assert.equal(mark.style.top, `${expected.top}px`, `the check stands at ${mark.style.top}, the geometry says ${expected.top}`)
  assert.equal(mark.style.width, `${expected.size}px`, `the check is ${mark.style.width} across, the geometry says ${expected.size}`)

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test("the main window at a person's gate stops as a checkpoint: it breathes amber, unveiled and unchecked", { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* An output row, not a dispatch row: the only thing that can make this window breathe is the gate. */
  service.set('m1', [said('delivered, waiting for the person.', 100)])
  const snap = {
    ids: ['m1'],
    byId: { m1: { id: 'm1', running: false, displayTitle: 'the main conversation' } },
  }
  const mounted = await mountBuiltPanel({
    record: recordAtCheckpoint(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const main = container.querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')

  assert.ok(main.className.includes('is-wait'), 'the window whose node is a checkpoint does not breathe')
  assert.ok(!main.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'the checkpoint window is veiled')
  assert.equal(main.querySelector('.superworker-omark'), null, 'the checkpoint window wears the finished check')
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the checkpoint window lost its rows')
  assert.equal(main.querySelector('.superworker-oring'), null, 'the checkpoint window turns a ring')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the main window still running draws as it runs: no veil, no check, no gate', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [read('a.ts', 100)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const main = container.querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')
  assert.equal(main.querySelector('.superworker-omark'), null, 'a running main window wears a check')
  assert.equal(main.querySelector('.superworker-oring'), null, 'a running main window turns a ring')
  assert.ok(!main.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'a running main window is veiled')
  assert.equal(main.className.includes('is-wait'), false, 'a running main window nobody waits on breathes')
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the running main window lost its rows')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a running child turns the ring, and wears neither the veil nor a check', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100)])
  service.set('c1', [read('a.ts', 300)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the running child' }])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const child = container.querySelector('[data-window="c1"]')
  assert.notEqual(child, null, 'the running child is not drawn')

  const ring = child.querySelector('.superworker-oring')
  assert.notEqual(ring, null, 'a running child turns no ring')
  assert.equal(child.querySelector('.superworker-omark'), null, 'a running child wears a check')
  assert.ok(!child.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'a running window is veiled')

  /* The ring's box is the geometry's own: 10 across, in the title-line cell. */
  const placement = layoutOverview({ stage: { width: 1024, height: 720 }, mainRows: 1, childRows: [1] })
  const expected = layoutRing({ width: placement.children[0].width })
  assert.equal(ring.style.left, `${expected.left}px`, `the ring stands at ${ring.style.left}, the geometry says ${expected.left}`)
  assert.equal(ring.style.top, `${expected.top}px`, `the ring stands at ${ring.style.top}, the geometry says ${expected.top}`)
  assert.equal(ring.style.width, `${expected.size}px`, `the ring is ${ring.style.width} across, the geometry says ${expected.size}`)

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a dispatched child is tied to its own row: two children, two lines, each on its dispatch row', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [
    said('start.', 100),
    ...dispatchRun('c1', 'd1', 'the first job', 200),
    ...dispatchRun('c2', 'd2', 'the second job', 300),
  ])
  service.set('c1', [read('a.ts', 400)])
  service.set('c2', [read('b.ts', 500)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([
      { id: 'c1', running: true, title: 'the first child' },
      { id: 'c2', running: true, title: 'the second child' },
    ])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  /* The reading the pane has: an output row, then one dispatch row per child. */
  const placement = layoutOverview({ stage: { width: 1024, height: 720 }, mainRows: 3, childRows: [1, 1] })
  const gap = placement.children[0].left - (placement.main.left + placement.main.width)
  const expected = placement.children.map((child, i) => layoutLink({ main: placement.main, child, rowIndex: i + 1, rowCount: 3, gap }))

  const field = container.querySelector('.superworker-ofield')
  const svg = container.querySelector('.superworker-olinks')
  assert.notEqual(svg, null, 'two anchored children drew no line layer')
  assert.equal(svg.parentElement, field, 'the lines do not hang off the field')
  assert.equal(field.firstElementChild, svg, 'the line layer is not drawn under the windows')
  const paths = [...svg.querySelectorAll('path')]
  const dots = [...svg.querySelectorAll('circle')]
  assert.equal(paths.length, 2, `the layer holds ${paths.length} of two lines`)
  assert.equal(dots.length, 2, `the layer holds ${dots.length} of two dots`)
  paths.forEach((path, i) => {
    assert.ok(path.classList.contains('superworker-olink'), 'a line does not wear the line class')
    assert.ok(path.classList.contains('is-live'), "a running child's line is not the dashed one")
    assert.equal(path.getAttribute('d'), expected[i].d, `line ${i} does not follow the geometry: ${path.getAttribute('d')}`)
    assert.equal(dots[i].getAttribute('cx'), `${expected[i].fromX}`, `dot ${i} is not at the line's start`)
    assert.equal(dots[i].getAttribute('cy'), `${expected[i].fromY}`, `dot ${i} is not at the line's start`)
    assert.equal(dots[i].getAttribute('r'), `${LINK_DOT_R}`, "the dot is not the demo's own")
    /* Each line leaves on the middle of its own dispatch row, counted up from the pane's bottom:
     * 190 − 0.5 − 20 − (2 − rowIndex) * 24 − 12. The dot itself is read back with that number. */
    const rowMiddle = [133.5, 157.5][i]
    assert.equal(expected[i].fromY, placement.main.top + rowMiddle, `line ${i} is not on its dispatch row`)
    assert.equal(Number(dots[i].getAttribute('cy')), placement.main.top + rowMiddle, `dot ${i} stands at ${dots[i].getAttribute('cy')}, its row's middle is ${placement.main.top + rowMiddle}`)
    assert.equal(expected[i].toX, placement.children[i].left, `line ${i} does not arrive on its own window`)
  })
  assert.notEqual(expected[0].fromY, expected[1].fromY, 'the two lines left the same row')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('no anchor, no line: a child whose dispatch never named it is drawn, and nothing ties it to a row', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* The call is still in flight: no catalogue, no answer naming a child — so no exact pairing. */
  service.set('m1', [said('start.', 100), dispatched('a job still in flight', 200, 'd1')])
  service.set('c1', [read('a.ts', 400)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  assert.notEqual(container.querySelector('[data-window="c1"]'), null, 'the running child is not drawn')
  assert.ok(container.querySelector('.superworker-olinks') === null, 'a line was drawn to a row nothing names')
  assert.equal(container.querySelectorAll('.superworker-olink').length, 0, 'a line was drawn to a row nothing names')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('an anchor whose row the feed no longer shows: the child stands alone, and no other row stands in', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* The dispatch row is the oldest of more rows than the reading keeps: it is cut off the top. */
  const later = Array.from({ length: READING_CAPACITY + 1 }, (_, i) => said(`later ${i}.`, 300 + i))
  service.set('m1', [...dispatchRun('c1', 'd1', 'the long job', 100), ...later])
  service.set('c1', [read('a.ts', 400)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  assert.notEqual(container.querySelector('[data-window="c1"]'), null, 'the running child is not drawn')
  assert.ok(container.querySelector('.superworker-olinks') === null, 'a line pointed at a row that is no longer on screen')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the column left the stage: an anchored child draws no window and no line', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100), ...dispatchRun('c1', 'd1', 'the job', 200)])
  service.set('c1', [read('a.ts', 400)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
  })
  /* The narrow stage: two windows cannot both keep their smallest sizes, so the column leaves. */
  await stageAt(mounted, 640, 480)
  const { container } = mounted
  assert.ok(container.querySelector('[data-window="c1"]') === null, 'the column was drawn on the narrow stage')
  assert.ok(container.querySelector('.superworker-olinks') === null, 'a line was drawn to a window that is not there')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('six running children draw five windows and count the one folded away', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  const children = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ id, running: true, title: `child ${id}` }))
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf(children)),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  /* Five child windows stand, so the reading's own count is what the badge has to say. */
  const placement = layoutOverview({ stage: { width: 1024, height: 720 }, mainRows: 0, childRows: [0, 0, 0, 0, 0] })
  const spill = layoutSpill({ children: placement.children, hiddenChildren: 1 })
  assert.notEqual(spill, undefined, 'the geometry drew no badge for one folded window')

  const badge = container.querySelector('.superworker-ospill')
  assert.notEqual(badge, null, 'the folded window was counted nowhere on the page')
  assert.equal(badge.textContent, '+1', `the badge reads "${badge.textContent}"`)
  assert.equal(badge.querySelectorAll('i').length, 3, 'the badge does not carry its three dots')
  assert.ok(badge.querySelector('.superworker-num') !== null, 'the count does not take the panel\'s figures')
  assert.equal(badge.parentElement, container.querySelector('.superworker-ofield'), 'the badge does not hang off the field')
  assert.equal(badge.style.left, `${spill.left}px`, `the badge stands at ${badge.style.left}, the geometry says ${spill.left}`)
  assert.equal(badge.style.top, `${spill.top}px`, `the badge stands at ${badge.style.top}, the geometry says ${spill.top}`)

  /* Its right edge is the drawn column's own right edge, and its ground is above the column's top. */
  const first = container.querySelector('[data-window="c2"]')
  assert.notEqual(first, null, 'the oldest live child of the five is not drawn')
  const columnRight = Number.parseFloat(first.style.left) + Number.parseFloat(first.style.width)
  const badgeRight = Number.parseFloat(badge.style.left) + Number.parseFloat(badge.style.width)
  assert.equal(badgeRight, columnRight, `the badge's right edge is ${badgeRight}, the column's is ${columnRight}`)
  assert.ok(
    Number.parseFloat(badge.style.top) + Number.parseFloat(badge.style.height) < Number.parseFloat(first.style.top),
    'the badge does not stand above the column',
  )

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('nothing folded away, no badge: five running children and three both draw none', { skip: bundleSkip }, async () => {
  for (const running of [5, 3]) {
    const service = fakeSessionsService()
    const children = Array.from({ length: running }, (_, i) => ({ id: `c${i + 1}`, running: true, title: `child ${i + 1}` }))
    const mounted = await mountBuiltPanel({
      record: record(),
      sessionsService: service,
      useSessions: (select) => select(snapshotOf(children)),
    })
    await stageAt(mounted, 1024, 720)
    assert.ok(
      container(mounted).querySelector('.superworker-ospill') === null,
      `${running} running children drew a badge with nothing folded away`,
    )
    await mounted.unmount()
    assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
  }
})

/** The same record, with the note naming the session this pipeline owns: the only main window it may draw. */
const recordNaming = (session) => ({
  ...record(),
  '.superworker/meta/sessions/n0.json': json({ run: [{ session, at: '2026-01-09T00:00:00.000Z' }] }),
})

test('the built panel draws the conversation the record names, not the one DSH holds as its main view', { skip: bundleSkip }, async () => {
  /* The user's own scene: an unrelated old conversation carries `retainedBy.mainView`, the record
   * names a different session, and the panel is in neither of them (the seat's own fallback session
   * is the mount's `render-check-session`). What must be drawn is the record's conversation. */
  const service = fakeSessionsService()
  service.set('session-old', [said('an unrelated old conversation.', 1000)])
  service.set('session-pipeline', [said('this pipeline own words.', 2000)])
  const snap = {
    ids: ['session-old', 'session-pipeline'],
    byId: {
      'session-old': { id: 'session-old', running: false, retainedBy: { mainView: 1 }, displayTitle: 'the unrelated old conversation' },
      'session-pipeline': { id: 'session-pipeline', running: true, updatedAt: '2026-11-15T16:00:00.000Z', displayTitle: 'the pipeline conversation' },
    },
  }
  const mounted = await mountBuiltPanel({
    record: recordNaming('session-pipeline'),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted

  const main = container.querySelector('[data-window="session-pipeline"]')
  assert.notEqual(main, null, 'the record-named conversation is not drawn')
  assert.ok(main.className.includes('is-main'), 'the record-named conversation does not wear the main class')
  assert.equal(main.querySelector('.superworker-oplate-t')?.textContent, 'the driven node', 'the nameplate does not read the node the note names')
  assert.equal(container.querySelector('[data-window="session-old"]'), null, 'the conversation DSH holds as its main view was drawn')
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the main window does not draw its one row')
  assert.ok((container.textContent ?? '').includes('this pipeline own words.'), "the main window's row is not its own conversation's")
  assert.ok(!(container.textContent ?? '').includes('an unrelated old conversation.'), "another conversation's rows are on the page")

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the record names a session this machine does not hold: the panel draws no window rather than a stranger', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('session-old', [said('an unrelated old conversation.', 1000)])
  const snap = {
    ids: ['session-old'],
    byId: { 'session-old': { id: 'session-old', running: true, retainedBy: { mainView: 1 }, displayTitle: 'the unrelated old conversation' } },
  }
  const mounted = await mountBuiltPanel({
    record: recordNaming('session-gone'),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  const { container } = mounted

  assert.equal(container.querySelectorAll('[data-window]').length, 0, 'a window was drawn for a conversation the record does not name')
  assert.ok(!(container.textContent ?? '').includes('an unrelated old conversation.'), "another conversation's rows are on the page")
  /* Nothing drawable is the empty stage's business, and it stands here: no window field to measure,
   * so the case that used to pin the stage's box now pins the sentence instead. */
  assert.equal(emptyStage(mounted)?.said, zh['overview.empty.no-window'], 'the stage stood empty and silent over a record whose session is gone')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('self-looping motion lives in exactly three places here: the waiting border, the walking line, and the running ring', () => {
  const sheet = readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8')
  const rules = cssBlocks(stripComments(sheet), { descend: 'all' }).filter((block) => block.kind === 'rule')
  /* A loop is an animation that never ends. An enter, a fade or a row arriving fills once and stops;
   * a fourth looping motion is a change to the design, and this is where it reports itself. */
  const looping = rules
    .filter((rule) => /animation:[^;]*infinite/u.test(rule.body))
    .map((rule) => rule.prelude)
    .sort()
  assert.deepEqual(
    looping,
    ['.superworker-page .superworker-olink.is-live', '.superworker-page .superworker-opane.is-wait', '.superworker-page .superworker-oring'],
    `the sheet loops in ${looping.length} places: ${looping.join(' | ')}`,
  )
  /* The walking line: the demo's own 16px walk, on the dash it draws. */
  const live = rules.find((rule) => rule.prelude.includes('superworker-olink.is-live') && rule.at === '')
  assert.notEqual(live, undefined, "no rule dashes a running child's line")
  assert.match(live.body, /stroke-dasharray:\s*3\s+5/u, "the line is not the demo's dash")
  assert.match(live.body, /animation:\s*superworker-olink-flow 1\.2s linear infinite/u, 'the line does not walk as the demo walks it')
  assert.ok(
    rules.some((rule) => rule.at === '@keyframes superworker-olink-flow' && /stroke-dashoffset:\s*-16/u.test(rule.body)),
    "the flow is not the demo's own 16px walk",
  )
  /* Reduced motion stills the walking and keeps the dash: the line still says "alive". */
  const reduced = rules.filter((rule) => rule.at.includes('prefers-reduced-motion') && rule.prelude.includes('superworker-olink'))
  assert.equal(reduced.length, 1, `the reduced-motion block covers ${reduced.length} link rules`)
  assert.match(reduced[0].body, /animation:\s*none/u, 'the line walks under reduced motion')
  assert.ok(!/stroke-dasharray/u.test(reduced[0].body), 'the reduced-motion block takes the dash away')

  /* The running ring: one turn every 1.3 seconds (half the border's 2.6s breath), on the panel's
   * 1.5px track. Under reduced motion it stops and keeps a dashed ring — the panel's still form. */
  const ring = rules.find((rule) => rule.prelude.endsWith('superworker-oring') && rule.at === '')
  assert.notEqual(ring, undefined, 'no rule turns the running ring')
  assert.match(ring.body, /animation:\s*superworker-oring-spin 1\.3s linear infinite/u, 'the ring does not turn at the demo\'s pace')
  assert.match(ring.body, /border:\s*1\.5px solid/u, 'the ring is not on the panel\'s 1.5px track')
  assert.ok(
    rules.some((rule) => rule.at === '@keyframes superworker-oring-spin' && /rotate\(1turn\)/u.test(rule.body)),
    'the ring has no turn to make',
  )
  const still = rules.find((rule) => rule.at.includes('prefers-reduced-motion') && rule.prelude.endsWith('superworker-oring'))
  assert.notEqual(still, undefined, 'the ring keeps turning under reduced motion')
  assert.match(still.body, /animation:\s*none/u, 'the ring keeps turning under reduced motion')
  assert.match(still.body, /border-style:\s*dashed/u, 'the still ring is not left as a dashed ring')
})

function container(mounted) {
  return mounted.container
}

/* ------------------------------------------------------------------ the empty stage */

/** The same record with no session note at all: the nodes no conversation has run. */
const recordWithoutNotes = () => {
  const full = record()
  delete full['.superworker/meta/sessions/n0.json']
  return full
}

/** A record that holds no node yet: a workspace initialised and left there. */
const recordWithoutNodes = () => ({
  ...record(),
  '.superworker/ideas.json': json({ nodes: {} }),
  '.superworker/state.json': json({ cycles: [] }),
  '.superworker/meta/sessions/n0.json': json({ run: [] }),
})

/** The empty stage's two pieces, read where the reader sees them: nothing when none stands. */
function emptyStage(mounted) {
  const stage = mounted.container.querySelector('#pane-overview .superworker-oempty')
  if (stage === null) return null
  return {
    said: stage.querySelector('p')?.textContent ?? '',
    link: stage.querySelector('.superworker-btn')?.textContent ?? '',
    button: stage.querySelector('.superworker-btn'),
  }
}

/** A promise whose release the case holds: the action is judged while the call is still out. */
function defer() {
  let resolve
  const promise = new Promise((give) => { resolve = give })
  return { promise, resolve }
}

test('the stage with no window says which of the three situations it is; all three carry the one move', { skip: bundleSkip }, async () => {
  /* (a) The record names no session at all: a fresh clone, or a workspace just initialised. */
  const unstarted = await mountBuiltPanel({
    record: recordWithoutNotes(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
  })
  assert.deepEqual(
    { said: emptyStage(unstarted)?.said, link: emptyStage(unstarted)?.link },
    { said: zh['overview.empty.no-session'], link: zh['overview.empty.link'] },
    'a record that names no session says something else',
  )
  assert.equal(unstarted.container.querySelectorAll('[data-window]').length, 0, 'a stand-in window was drawn')
  assert.ok(unstarted.container.querySelector('#pane-overview .superworker-ofield') === null, 'the empty stage still drew a window field')
  await unstarted.unmount()
  assert.deepEqual(unstarted.consoleErrors, [], 'there is an error in the console')

  /* (b) The record names a session this machine does not hold: nothing drawable right now. */
  const gone = await mountBuiltPanel({
    record: recordNaming('session-gone'),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select({
      ids: ['session-old'],
      byId: { 'session-old': { id: 'session-old', running: true, retainedBy: { mainView: 1 }, displayTitle: 'the unrelated old conversation' } },
    }),
  })
  assert.equal(emptyStage(gone)?.said, zh['overview.empty.no-window'], 'a record whose named session is gone says something else')
  assert.equal(emptyStage(gone)?.link, zh['overview.empty.link'], 'the two situations carry different actions')
  assert.equal(gone.container.querySelectorAll('[data-window]').length, 0, 'a stranger was drawn instead of nothing')
  await gone.unmount()
  assert.deepEqual(gone.consoleErrors, [], 'there is an error in the console')

  /* (c) The record holds no node yet. */
  const bare = await mountBuiltPanel({
    record: recordWithoutNodes(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
  })
  assert.equal(emptyStage(bare)?.said, zh['overview.empty.no-nodes'], 'a record with no node says something else')
  assert.equal(emptyStage(bare)?.link, zh['overview.empty.link'], 'the three situations do not share one action')
  await bare.unmount()
  assert.deepEqual(bare.consoleErrors, [], 'there is an error in the console')
})

test('a stage with a window draws no empty state', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('the pipeline is running.', 1000)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
  })
  await stageAt(mounted, 1024, 720)
  assert.notEqual(container(mounted).querySelector('[data-window="m1"]'), null, 'the window the record names is not drawn')
  assert.equal(emptyStage(mounted), null, 'an empty sentence stood beside a drawn window')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the empty stage\'s action hands this workspace to an agent: consultSetup, the action standing down while it is out', { skip: bundleSkip }, async () => {
  const gate = defer()
  const mounted = await mountBuiltPanel({
    record: recordWithoutNotes(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
    onConsultSetup: () => gate.promise,
  })
  const button = emptyStage(mounted)?.button
  assert.notEqual(button, null, 'the empty stage carries no action')

  await mounted.act(async () => {
    button.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(
    mounted.consulted,
    [{ sessionId: 'render-check-session', workspaceRoot: '' }],
    'the press did not reach the host half with this session and the root the selector gave',
  )
  assert.equal(button.disabled, true, 'the action stayed pressable while the call was out')

  await mounted.act(async () => {
    gate.resolve({ ok: true, session: 'consult-check-session' })
    await flush()
  })
  assert.equal(button.disabled, false, 'the action never came back after the call settled')
  assert.ok(mounted.container.querySelector('.superworker-page > .superworker-innone') === null, 'a landed consult wrote a note line: it has nothing to say')
  assert.equal(mounted.consulted.length, 1, 'one press opened more than one session')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a refused setup consult says why on the panel\'s note line', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({
    record: recordWithoutNotes(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
    onConsultSetup: () => ({ ok: false, code: 'no-session-service', detail: 'agents' }),
  })
  const button = emptyStage(mounted)?.button
  await mounted.act(async () => {
    button.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const note = mounted.container.querySelector('.superworker-page > .superworker-innone')
  assert.notEqual(note, null, 'the refusal was swallowed: nothing stands on the panel\'s note line')
  assert.equal(
    note.textContent,
    zh['failure.no-session-service'].replace('{detail}', 'agents'),
    'the refusal does not read as the lookup table\'s sentence for its code',
  )
  assert.equal(button.disabled, false, 'the action stayed down after a refused call')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})
