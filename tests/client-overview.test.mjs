/* The overview on the built panel: the reading drawn as windows, and the four motion marks each
 * bound to its fact.
 *
 * The session list arrives the way the seat hands it over (a `useSessions` hook over a snapshot the
 * case holds and moves), and the event windows arrive through a stand-in for DSH's `sessions`
 * service — the same narrow face `session-events.ts` reads. What the cases hold down:
 *
 * - the windows and their words: the node's own nameplate on the main window, running children
 *   only, a stopped child no window at all, and no session id printed anywhere;
 * - enter — a window joining the set carries the mark;
 * - leave — a window leaving carries the mark, and after the leave's span the page has lost it;
 * - fresh row — the arrival's two readings carry the mark, on that row alone: a gained row even
 *   when its text repeats the previous newest (growth), and a swapped newest at a steady count
 *   (the cut);
 * - breathing — a window whose newest row is a dispatch row wears it, and stops when the newest
 *   row is no longer one.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/client-overview.test.mjs`.
 */
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssBlocks, stripComments } from '../tools/lib/cssrules.mjs'
import {
  LINK_DOT_R,
  READING_CAPACITY,
  ROW_H,
  layoutLink,
  layoutOverview,
  layoutSpill,
} from '../src/client/overview-geom.ts'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'

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

  /* One running child: no node rail. The main window's newest row is a dispatch row: it breathes. */
  assert.equal(container.querySelector('.superworker-orail'), null, 'one child drew a node rail')
  assert.ok(main.className.includes('is-wait'), 'a dispatch-newest main window does not breathe')
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

test('breathing: the mark follows the newest row being a dispatch row', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
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
  assert.ok(pane.className.includes('is-wait'), 'a dispatch-newest window does not breathe')
  await mounted.act(async () => {
    service.set('c1', [dispatched('a task out', 1000, 'd9'), said('it came back.', 2000)])
  })
  assert.ok(!container(mounted).querySelector('[data-window="c1"]').className.includes('is-wait'), 'the window went on breathing after the newest row stopped being a dispatch')
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
  await stageAt(mounted, 1024, 720)
  const { container } = mounted

  assert.equal(container.querySelectorAll('[data-window]').length, 0, 'a window was drawn for a conversation the record does not name')
  assert.ok(!(container.textContent ?? '').includes('an unrelated old conversation.'), "another conversation's rows are on the page")

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('self-looping motion lives in exactly two places here: the waiting border and the walking line', () => {
  const sheet = readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8')
  const rules = cssBlocks(stripComments(sheet), { descend: 'all' }).filter((block) => block.kind === 'rule')
  /* A loop is an animation that never ends. An enter, a fade or a row arriving fills once and stops;
     a third looping motion is a change to the design, and this is where it reports itself. */
  const looping = rules
    .filter((rule) => /animation:[^;]*infinite/u.test(rule.body))
    .map((rule) => rule.prelude)
    .sort()
  assert.deepEqual(
    looping,
    ['.superworker-page .superworker-olink.is-live', '.superworker-page .superworker-opane.is-wait'],
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
})

function container(mounted) {
  return mounted.container
}
