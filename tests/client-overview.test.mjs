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
import test from 'node:test'
import assert from 'node:assert/strict'
import { READING_CAPACITY } from '../src/client/overview-geom.ts'
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
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const leaving = container(mounted).querySelector('[data-window="c3"]')
  assert.notEqual(leaving, null, 'the leaving pane left the page before its leave ran')
  assert.ok(leaving.className.includes('is-leave'), 'the leaving pane carries no leave mark')
  /* One running child left: the node rail is gone whole — a single window draws no rail. */
  assert.equal(container(mounted).querySelector('.superworker-orail'), null, 'the rail lingered on one child')

  /* Waiting on the leave's own span: the removal is the component's timer, and jsdom fires no
   * animationend to hang on — the only fact to wait for is the span itself running out. Inside
   * act, because the span's expiry is what updates the drawing. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 340))
  })
  assert.equal(container(mounted).querySelector('[data-window="c3"]'), null, 'the page kept the pane past the leave span')
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

function container(mounted) {
  return mounted.container
}
