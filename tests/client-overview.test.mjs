/* The overview on the built panel: the reading drawn as windows, the motion marks each bound to its
 * fact, and the three states a window can be in.
 *
 * The session list arrives the way the seat hands it over (a `useSessions` hook over a snapshot the
 * case holds and moves), and the event windows arrive through a stand-in for DSH's `sessions`
 * service — the same narrow face `session-events.ts` reads. What the cases hold down:
 *
 * - the windows and their words: the node's own nameplate on the main window, running children
 *   only, a child that ended no window at all, and no session id printed anywhere;
 * - the two entrances, which are not the same fact: a child grows out of the dispatch row that opened
 *   it (its box is the geometry's, its source point is that row), while the main window has no source
 *   at all — it is the conversation the pane is about, so it never travels; and a set that is replaced
 *   whole (another workspace's record under the pane) leaves no pane behind to fold;
 * - one arrival, one flight: the aim is read on the joining beat and a re-measure under it never
 *   re-aims it, and a seat the reading loses for a beat and hands straight back is the same window
 *   standing — it does not fly out a second time;
 * - one opening: a window stands measured over no rows while its own session windows are being read,
 *   and the growth into the box those rows need is spent once, on the way — every later box follows
 *   the geometry;
 * - leave — a window leaving carries the mark, and after the leave's span the page has lost it;
 *   a child that ends is exactly that: the reading stops drawing it, and the animation takes it away;
 * - the hand-over — the one replacement that is a motion: a page the line left (its check standing
 *   while nothing else was out) folds in the box it stood in as the step now being worked arrives and
 *   the rail's lit bar moves, while a person's pick and a replaced cast keep their instant swap;
 * - fresh row — the arrival's two readings carry the mark, on that row alone: a gained row even
 *   when its text repeats the previous newest (growth), and a swapped newest at a steady count
 *   (the cut);
 * - breathing — the person gate's alone: the main window at a checkpoint wears it, while a window
 *   whose newest row is a dispatch row keeps its ring and draws no border; and a gate is a **stop**,
 *   so the checkpoint a person is working through draws as it runs — no pause over a live stream;
 * - the main window's three states, one fact each: running draws as it runs; not running under no
 *   gate is finished — rows in place under the veil and the check; at a person's gate (a checkpoint
 *   the record's own gate reading names) it breathes amber over its veiled rows, under the pause
 *   mark — the check's own square, two bars instead of one stroke, so the gate is never read as
 *   "handed in" nor as the turning ring beside it;
 * - where the stage lands: the line's held step, then the one still running — never the conversation
 *   a browser tab left open, so a refresh mid-run does not put an old step back on the stage;
 * - a running child turns the small ring, and wears neither veil nor check.
 * - the press — a window opens the conversation it stands for: the main window its own, a child its
 *   own, and a tap a touch can make anywhere on the window, the verdict mark over it included; a
 *   conversation this machine cannot open stays the drawing it was, with no role and no press.
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

/** The same record a beat before it speaks for itself: the conversation has ended and the record has
 *  not settled its node yet — nothing delivered, nobody holding the cell, no gate. That beat is one
 *  no reader can tell from a stop nothing was ever written down for. */
const recordBeforeItSpeaks = () => ({
  ...record(),
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        description: 'the piece the main conversation drives',
        tags: [],
        mode: 'auto',
        status: 'todo',
        created_at: '2026-01-08T00:00:00.000Z',
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
        path: [{ node: 'n0', started_at: '2026-01-08T00:00:00.000Z' }],
      },
    ],
  }),
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

/** The session-list snapshot, in the shape the seat's `useSessions` hook hands over. `mainRunning` is
 * the reader's own conversation's bit: a scene read after the line has stopped says false. */
const snapshotOf = (children, mainRunning = true) => ({
  ids: ['m1', ...children.map((one) => one.id)],
  byId: {
    m1: { id: 'm1', running: mainRunning, retainedBy: { mainView: 1 }, displayTitle: 'the main conversation' },
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

/**
 * What a pane was inserted WITH, caught at the insertion itself.
 *
 * The entrance is a motion from a box the window is not standing in, so the only frame that can
 * carry it is the frame that first draws the window. Reading the DOM after `rerender()` has flushed
 * the effect cannot tell that frame from the one after it: by then the join mark is set either way,
 * and the difference between a working entrance and a dead one is exactly which of the two frames
 * got it. So the insertion is observed — React hands the node to `appendChild` / `insertBefore` with
 * its attributes already on it, so what those see IS the first painted frame, and jsdom writes the
 * inline `--superworker-born-*` all the same.
 *
 * Only the entries whose `data-window` the caller asked for are kept; every inserted node is walked,
 * because the pane may arrive inside a wrapper rather than alone.
 */
function watchPaneInsertions(mounted) {
  const seen = []
  const look = (node) => {
    if (node === null || node === undefined || node.nodeType !== 1) return
    const cls = typeof node.className === 'string' ? node.className : ''
    if (!cls.includes('superworker-opane')) {
      for (const one of [...(node.querySelectorAll?.('.superworker-opane') ?? [])]) look(one)
      return
    }
    seen.push({
      id: node.getAttribute('data-window'),
      cls,
      bornX: node.style.getPropertyValue('--superworker-born-x'),
      bornY: node.style.getPropertyValue('--superworker-born-y'),
    })
  }
  const restore = []
  for (const name of ['appendChild', 'insertBefore']) {
    const real = mounted.window.Node.prototype[name]
    mounted.window.Node.prototype[name] = function (node, ...rest) {
      look(node)
      return real.call(this, node, ...rest)
    }
    restore.push(() => { mounted.window.Node.prototype[name] = real })
  }
  return { seen, restore: () => { for (const one of restore) one() } }
}

/** The `--superworker-born-x/y` a pane stands with, and whether it wears the entrance's own mark. */
const bornOf = (pane) => ({
  x: pane.style.getPropertyValue('--superworker-born-x'),
  y: pane.style.getPropertyValue('--superworker-born-y'),
  born: pane.className.includes('is-born'),
})

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
  assert.equal(main.querySelector('.superworker-oplate-n')?.textContent, 'the driven node', 'the nameplate does not read the record node the note names')
  assert.ok((main.querySelector('.superworker-oplate-m span')?.textContent ?? '').length > 0, 'the nameplate carries no readings line')
  assert.notEqual(main.querySelector('.superworker-ocorner .superworker-num'), null, 'the nameplate states no running span')

  const child = container.querySelector('[data-window="c1"]')
  assert.notEqual(child, null, 'a running child is not drawn')
  assert.equal(child.querySelector('.superworker-ohead-t')?.textContent, 'the first child', 'the child title line does not read the list label')
  assert.equal(child.querySelector('.superworker-ohead-r'), null, 'a window that works no node carries a readings line')
  assert.notEqual(child.querySelector('.superworker-ohead .superworker-num'), null, 'the child title line states no running span')
  assert.equal(container.querySelector('[data-window="c2"]'), null, 'a stopped child became a window')

  assert.ok(!((container.textContent ?? '').includes('m1') || (container.textContent ?? '').includes('c1')), 'a session id printed on the page')

  assert.equal(main.querySelectorAll('.superworker-orow').length, 2, 'the main window does not draw its two rows')
  assert.equal(child.querySelectorAll('.superworker-orow').length, 1, 'the child does not draw its one row')

  /* One step of the line: no node rail — there is nowhere to switch to, whatever the column holds.
   * The main window's newest row is a dispatch row, and the amber border answers the person gate
   * alone — so neither window breathes here. */
  assert.equal(container.querySelector('.superworker-orail'), null, 'one step of the line drew a node rail')
  assert.ok(!main.className.includes('is-wait'), 'a main window whose newest row is a dispatch row breathes: the border answers the gate alone')
  assert.ok(!child.className.includes('is-wait'), 'a child whose newest row is a read breathes')

  /* The first drawing of the pane joins nothing: the pane appeared, and its windows were always part
   * of it. An entrance is played for a window that joined a set already standing — which is what the
   * two dedicated cases below judge. */
  assert.ok(!main.className.includes('is-born'), 'the main window plays an entrance on the pane\'s first drawing')
  assert.ok(!child.className.includes('is-born'), 'a child plays an entrance on the pane\'s first drawing')

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

test('an unmeasured stage draws no window at all, so nothing is ever seen standing in its corner', { skip: bundleSkip }, async () => {
  /* The reader's complaint, on opening the panel: the windows flew out of the stage's top-left corner.
   * The corner was never an origin — it is what an unmeasured stage is. The pane is mounted inside a
   * tab that may still be `hidden`, so its first render has no box; the geometry answers with a
   * zero-width window at (0, 0), and the opening's own growth then spent that hop as travel. The rule
   * is the one thing that must hold whatever the geometry says: a stage with no numbers has no
   * windows to place. */
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 1000), dispatched('look for conflicts', 2000, 'd1')])
  service.set('c1', [read('a.ts', 3000)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
  })
  /* This is the state the panel really opens in: mounted, and not yet measured. */
  assert.equal(container(mounted).querySelectorAll('[data-window]').length, 0, 'a window was drawn before the stage had a box: it stands in the corner')

  /* Measured, and the same reading draws its cast — in place, and grown where it stands. */
  await stageAt(mounted, 1024, 720)
  const main = container(mounted).querySelector('[data-window="m1"]')
  const child = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(main, null, 'the stage was measured and still draws no main window')
  assert.notEqual(child, null, 'the stage was measured and still draws no child')
  assert.notEqual(main.style.left, '0px', 'the main window stands on the stage\'s own left edge')
  assert.notEqual(child.style.left, '0px', 'the child stands on the stage\'s own left edge')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the stage\'s arrival grows the windows where they stand: a scale about each box\'s own middle, never a translation', () => {
  /* The other half of the same fix. Holding the windows back until the stage is measured leaves
   * nothing to travel from, so the entrance that plays on the panel's opening (and on every return to
   * this tab) can only be a growth in place. The sheet is where that is stated, and the two ways it
   * could be wrong are both checkable there: a `translate` would be an invented origin, and a
   * `transform-origin` other than the box's own middle would move the growth's centre off the window. */
  const sheet = stripComments(readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8'))
  const rules = cssBlocks(sheet, { descend: 'all' }).filter((block) => block.kind === 'rule')

  const rule = rules.find((one) => one.at === '' && one.prelude.includes('superworker-ofield.is-first') && one.prelude.includes('superworker-opane'))
  assert.notEqual(rule, undefined, 'no rule plays the stage\'s own arrival')
  assert.match(rule.body, /transform-origin:\s*center center/u, 'the stage\'s arrival is not centred on each window\'s own box')
  /* A flying child is excluded: its own flight owns the transform for that beat. */
  assert.match(rule.prelude, /:not\(\.is-born\)/u, 'the stage\'s arrival and a child\'s flight can land on one box together')
  assert.match(rule.prelude, /:not\(\.is-leave\)/u, 'a window on its way out plays the arrival as well')

  const named = /animation:\s*([\w-]+)/u.exec(rule.body)
  assert.notEqual(named, null, 'the stage\'s arrival names no animation')
  const steps = rules.filter((one) => one.at === `@keyframes ${named[1]}`)
  assert.ok(steps.length >= 2, `the arrival ${named[1]} is named but never stated`)
  const from = steps[0].body
  assert.match(from, /scale\(/u, 'the stage\'s arrival does not grow the window')
  assert.ok(!/translate/u.test(from), `the stage's arrival translates the window: ${from}`)
  assert.match(steps.at(-1).body, /transform:\s*none/u, 'the arrival does not land on the box the geometry set')
})

test('a joining child grows out of the dispatch row that opened it', { skip: bundleSkip }, async () => {
  /* The two windows are not the same kind of thing, and their entrances say so. A child has a source:
   * the row that dispatched it, a real row of the main conversation's feed. It grows out of the
   * line's own leaving point, so the box it lands on is the geometry's and the point it starts from
   * is the row's — never a corner of the stage invented for the occasion. */
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('c2', 'd2', 'the second job', 100), said('both of them are out.', 200)])
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
  assert.ok(second.className.includes('is-born'), 'the joining child plays no entrance at all')
  /* The box it lands on is the geometry's, and the point it grows from is the dispatch row's: the
   * two numbers the sheet is handed are the shift between them, so the first frame stands on the row
   * that dispatched it. The expectation is laid out from the rows that were actually drawn, so the
   * case pins "the box is the geometry's answer", not one arithmetic I did by hand. */
  const rowsIn = (id) => container(mounted).querySelectorAll(`[data-window="${id}"] .superworker-orow`).length
  const placement = layoutOverview({
    stage: { width: 1024, height: 720 },
    mainRows: rowsIn('m1'),
    childRows: [rowsIn('c1'), rowsIn('c2')],
  })
  const box = placement.children[1]
  assert.equal(second.style.width, `${box.width}px`, 'the joining child is not at the width the geometry gives it')
  assert.equal(second.style.height, `${box.height}px`, 'the joining child is not at the height the geometry gives it')
  assert.equal(second.style.left, `${box.left}px`, 'the joining child is not at the left the geometry gives it')
  assert.equal(second.style.top, `${box.top}px`, 'the joining child is not at the top the geometry gives it')
  const bornX = second.style.getPropertyValue('--superworker-born-x')
  const bornY = second.style.getPropertyValue('--superworker-born-y')
  assert.match(bornX, /^-?\d+px$/u, `the joining child grows from no source point in x: ${bornX}`)
  assert.match(bornY, /^-?\d+px$/u, `the joining child grows from no source point in y: ${bornY}`)
  /* It grows from the main window's right edge — where the line leaves — not from the stage corner. */
  assert.equal(Number.parseInt(bornX, 10), placement.main.left + placement.main.width - box.left, 'the child grows from somewhere other than the row that dispatched it')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a flight is aimed on the joining beat, and the stage moving under it does not re-aim it', { skip: bundleSkip }, async () => {
  /* What the reader saw: the child flew out of the dispatch row, jumped back to it and flew out
   * again. A flight's start frame is a shift against the box the window stands in, so re-reading it
   * every beat re-aims a flight already in the air — and a real dispatch moves the stage three times
   * while the flight plays: the child's own first rows land (its box grows upward), then the parent's
   * feed writes the next row (the anchored row rises). None of that says the window came from
   * somewhere else. So the aim is read once, on the joining beat, and the cases pins that both
   * numbers stand still while the window travels. */
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('c1', 'd1', 'the job', 100), said('it is out.', 200)])
  let snap = snapshotOf([])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(container(mounted).querySelector('[data-window="c1"]'), null, 'the child is drawn before it runs')
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const child = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(child, null, 'the joining child is not drawn')
  const aimed = {
    x: child.style.getPropertyValue('--superworker-born-x'),
    y: child.style.getPropertyValue('--superworker-born-y'),
    s: child.style.getPropertyValue('--superworker-born-s'),
  }
  const stoodAt = child.style.top
  assert.match(aimed.x, /^-?\d+px$/u, `the child grows from no source point in x: ${aimed.x}`)

  /* The child's own first row lands: its box grows and its top rises under the flight. */
  await mounted.act(async () => {
    service.set('c1', [read('a.ts', 3000)])
  })
  /* Then the parent writes the next row: the row this child grew out of rises up the feed. */
  await mounted.act(async () => {
    service.set('m1', [...dispatchRun('c1', 'd1', 'the job', 100), said('it is out.', 200), said('and now wait.', 400)])
  })
  const flown = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(flown, null, 'the travelling child is not drawn')
  assert.ok(flown.className.includes('is-born'), 'the child lost its entrance before the span ran')
  assert.notEqual(flown.style.top, stoodAt, 'the stage did not move under the flight — the case proves nothing')
  assert.equal(flown.style.getPropertyValue('--superworker-born-x'), aimed.x, 'the flight was re-aimed in x by a re-measure under it')
  assert.equal(flown.style.getPropertyValue('--superworker-born-y'), aimed.y, 'the flight was re-aimed in y by a re-measure under it — the window flies out twice')
  assert.equal(flown.style.getPropertyValue('--superworker-born-s'), aimed.s, 'the flight was re-sized under it')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a joining child wears its entrance on the very frame it is first drawn, with a shift that is not nothing', { skip: bundleSkip }, async () => {
  /* The defect this case pins: the child appeared at its final box, already full size, already in
   * place — no growth at all. The mark was published from an effect, so the frame that first drew
   * the window had none, and by the frame that got it the window already stood at the box the flight
   * was measured against. A shift of zero plays an entrance that shows nothing. */
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('c2', 'd2', 'the second job', 100), said('both of them are out.', 200)])
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(container(mounted).querySelector('[data-window="c2"]'), null, 'the second child is there before it runs')

  const watched = watchPaneInsertions(mounted)
  snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c2', running: true, title: 'the second child' },
  ])
  await mounted.rerender()
  watched.restore()

  /* The frame the window was first drawn in — not the one after it. */
  const first = watched.seen.filter((one) => one.id === 'c2')
  assert.equal(first.length, 1, `the joining child was drawn in ${first.length} insertions`)
  assert.ok(first[0].cls.includes('is-born'), `the frame that first drew the child has no entrance on it: ${first[0].cls}`)
  assert.match(first[0].bornX, /^-?\d+px$/u, `the child's first frame carries no shift in x: "${first[0].bornX}"`)
  assert.match(first[0].bornY, /^-?\d+px$/u, `the child's first frame carries no shift in y: "${first[0].bornY}"`)

  /* A shift of zero is the defect wearing the mark: the window would be drawn where it already is. */
  const placement = layoutOverview({
    stage: { width: 1024, height: 720 },
    mainRows: container(mounted).querySelectorAll('[data-window="m1"] .superworker-orow').length,
    childRows: ['c1', 'c2'].map((id) => container(mounted).querySelectorAll(`[data-window="${id}"] .superworker-orow`).length),
  })
  assert.notEqual(first[0].bornX, '0px', 'the child was handed a zero shift in x: the entrance plays nothing')
  /* The shift is the row's own leaving point minus the box: it grows out of the line, not the corner,
   * and it is not aligned with the window it lands on either. */
  assert.equal(Number.parseInt(first[0].bornX, 10), placement.main.left + placement.main.width - placement.children[1].left, 'the child grows from somewhere other than the row that dispatched it')
  assert.notEqual(first[0].bornY, '0px', 'the child was handed a zero shift in y: the entrance plays nothing')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a seat the reading loses for one beat and hands back keeps its entrance off, on the frame it returns in', { skip: bundleSkip }, async () => {
  /* `arrivedOnce`'s own reading, taken at the frame it belongs to: the returns are observed at their
   * insertion too, because a mark that shows up a frame late is exactly what this fix moved. A window
   * that was lost for one beat and handed back inside the leave's span never left the stage, so the
   * frame that draws it again must not carry an entrance. */
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('c1', 'd1', 'the job', 100)])
  let snap = snapshotOf([])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const first = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(first, null, 'the joining child is not drawn')
  const arrival = bornOf(first)
  assert.ok(arrival.born, 'the arriving child plays no entrance at all')
  assert.match(arrival.y, /^-?\d+px$/u, `the arriving child carries no shift in y: "${arrival.y}"`)

  /* One beat without it, then handed straight back — inside the leave's span, so it never left. */
  snap = snapshotOf([])
  await mounted.rerender()
  const watched = watchPaneInsertions(mounted)
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  watched.restore()

  /* Inserted again as the same element or not, the fact is the same: whatever drew it drew it with no
   * entrance and no source point. */
  for (const one of watched.seen.filter((pane) => pane.id === 'c1')) {
    assert.ok(!one.cls.includes('is-born'), `the returning window was drawn with an entrance: ${one.cls}`)
    assert.equal(one.bornY, '', 'the returning window was handed a source point again')
  }
  const back = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(back, null, 'the returning seat is not drawn')
  assert.ok(!back.className.includes('is-leave'), 'the returning seat is still folding')
  const returned = bornOf(back)
  assert.ok(!returned.born, 'the window flew out a second time without ever leaving the stage')
  assert.equal(returned.y, '', 'the returning window was handed a source point again')
  assert.equal(back.style.top, first.style.top, 'the returning window does not stand where it stood')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a replaced cast arrives whole in nothing: the new main window appears without travelling, and no old pane folds', { skip: bundleSkip }, async () => {
  /* Another conversation under the pane is another cast. The window it names was never absent and has
   * nowhere to come from, so the frame that draws it carries no source point — and the panes of the
   * cast that was replaced are gone at once rather than held to fold. */
  const twoNodes = {
    ...record(),
    '.superworker/ideas.json': json({
      nodes: {
        n0: { title: 'the first workspace cell', tags: [], mode: 'auto', status: 'completed', created_at: '2026-01-08T00:00:00.000Z', completed_at: '2026-01-09T00:00:00.000Z', dependencies: [] },
        n1: { title: 'the second workspace cell', tags: [], mode: 'auto', status: 'completed', created_at: '2026-01-08T00:00:00.000Z', completed_at: '2026-01-09T00:00:00.000Z', dependencies: [] },
      },
    }),
    '.superworker/meta/sessions/n0.json': json({ run: [{ session: 'm1', at: '2026-01-09T00:00:00.000Z' }] }),
    '.superworker/meta/sessions/n1.json': json({ run: [{ session: 'm2', at: '2026-01-09T00:00:00.000Z' }] }),
  }
  const service = fakeSessionsService()
  service.set('m1', [said('the first workspace own words.', 1000)])
  service.set('m2', [said('the second workspace own words.', 2000)])
  let snap = { ids: ['m1'], byId: { m1: { id: 'm1', running: true, displayTitle: 'the first conversation' } } }
  const mounted = await mountBuiltPanel({
    record: twoNodes,
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  assert.notEqual(container(mounted).querySelector('[data-window="m1"]'), null, 'the first conversation is not drawn')

  const watched = watchPaneInsertions(mounted)
  snap = { ids: ['m2'], byId: { m2: { id: 'm2', running: true, displayTitle: 'the second conversation' } } }
  await mounted.rerender()
  watched.restore()

  for (const one of watched.seen.filter((pane) => pane.id === 'm2')) {
    assert.ok(!one.cls.includes('is-born'), `a window of the new cast was drawn arriving: ${one.cls}`)
    assert.equal(one.bornX, '', 'a window of the new cast was handed a source point in x')
  }
  const second = container(mounted).querySelector('[data-window="m2"]')
  assert.notEqual(second, null, 'the second conversation is not drawn')
  const drawn = bornOf(second)
  assert.ok(!drawn.born, 'the main window plays an entrance it has no source for')
  assert.equal(drawn.x, '', 'the main window was handed a source point in x')
  assert.equal(container(mounted).querySelector('[data-window="m1"]'), null, 'the previous cast\'s window was held to fold on a set that was replaced')
  assert.equal(container(mounted).querySelectorAll('.superworker-opane.is-leave').length, 0, 'the replaced set holds panes mid-fold')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a seat the reading loses for one beat and hands back is the same window standing: no second flight', { skip: bundleSkip }, async () => {
  /* The session list keeps a child in two projections — the parent's own catalog, and the child's
   * scope while one is materialized — and their running bits need not agree on every frame while a
   * scope is being made. A child can therefore drop out of the reading for a beat and come straight
   * back. It is the same window, still standing where it stood: playing its arrival again said it
   * had just come, and the reader saw the unbroken window fly out a second time. */
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('c1', 'd1', 'the job', 100)])
  let snap = snapshotOf([])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const before = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(before, null, 'the joining child is not drawn')
  assert.ok(before.className.includes('is-born'), 'the arriving child plays no entrance at all')

  /* One beat without it: the list's running bit dips, so the reading drops the seat. */
  snap = snapshotOf([])
  await mounted.rerender()
  /* And the next beat hands it back — inside the leave's span, so the window never actually left. */
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const back = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(back, null, 'the returning seat is not drawn')
  assert.ok(!back.className.includes('is-leave'), 'the returning seat is still folding')
  assert.ok(!back.className.includes('is-born'), 'the window flew out a second time without ever leaving the stage')
  assert.equal(back.style.getPropertyValue('--superworker-born-y'), '', 'the returning window was handed a source point again')
  assert.equal(back.style.top, before.style.top, 'the returning window does not stand where it stood')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the main window never travels: it has no source to arrive from', { skip: bundleSkip }, async () => {
  /* The main window is the conversation this pane is about — the pipeline's own subject, already the
   * frame the drawing stands in. It was here; it has nowhere to fly in from. So it wears no birth
   * point at all, which is the whole correction: an entrance invented for it is the sliver in the
   * stage's corner the reader saw. */
  const service = fakeSessionsService()
  service.set('m1', [said('the conversation this panel is about.', 100)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
  })
  await stageAt(mounted, 1024, 720)
  const main = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')
  assert.ok(!main.className.includes('is-born'), 'the main window plays an entrance it has no source for')
  assert.equal(main.style.getPropertyValue('--superworker-born-x'), '', 'the main window was handed a source point in x')
  assert.equal(main.style.getPropertyValue('--superworker-born-y'), '', 'the main window was handed a source point in y')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a replaced set is another cast, not windows that left: nothing is held to fold', { skip: bundleSkip }, async () => {
  /* What a workspace switch looks like from inside this pane: the record under it is another one, so
   * the conversation it is about is another one. That is not "one window left the set" — no window
   * left, the whole cast is different — and holding the old panes for their fold made the switch play
   * every fold at once, which is the contraction that read as the stage shrinking. */
  const twoNodes = {
    ...record(),
    '.superworker/ideas.json': json({
      nodes: {
        n0: { title: 'the first workspace cell', tags: [], mode: 'auto', status: 'completed', created_at: '2026-01-08T00:00:00.000Z', completed_at: '2026-01-09T00:00:00.000Z', dependencies: [] },
        n1: { title: 'the second workspace cell', tags: [], mode: 'auto', status: 'completed', created_at: '2026-01-08T00:00:00.000Z', completed_at: '2026-01-09T00:00:00.000Z', dependencies: [] },
      },
    }),
    '.superworker/meta/sessions/n0.json': json({ run: [{ session: 'm1', at: '2026-01-09T00:00:00.000Z' }] }),
    '.superworker/meta/sessions/n1.json': json({ run: [{ session: 'm2', at: '2026-01-09T00:00:00.000Z' }] }),
  }
  const service = fakeSessionsService()
  service.set('m1', [said('the first workspace own words.', 1000)])
  service.set('m2', [said('the second workspace own words.', 2000)])
  let snap = { ids: ['m1'], byId: { m1: { id: 'm1', running: true, displayTitle: 'the first conversation' } } }
  const mounted = await mountBuiltPanel({
    record: twoNodes,
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  assert.notEqual(container.querySelector('[data-window="m1"]'), null, 'the first conversation is not drawn')

  /* Another record under the pane: its own conversation, and the old one not its business. */
  snap = { ids: ['m2'], byId: { m2: { id: 'm2', running: true, displayTitle: 'the second conversation' } } }
  await mounted.rerender()
  assert.notEqual(container.querySelector('[data-window="m2"]'), null, 'the second conversation is not drawn')
  /* The old pane is gone at once. A held pane would still be on the page, wearing the leave mark. */
  assert.equal(container.querySelector('[data-window="m1"]'), null, 'the previous workspace\'s window was held to fold on a set that was replaced')
  assert.equal(container.querySelectorAll('.superworker-opane.is-leave').length, 0, `the replaced set holds ${container.querySelectorAll('.superworker-opane.is-leave').length} panes mid-fold`)

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
  /* One node, one leg: the rail is the line's switch, and a line with one step has nowhere to switch
   * to — the children column being full is not what stands a rail up any more. */
  assert.equal(container(mounted).querySelector('.superworker-orail'), null, 'one leg — nowhere to switch — drew a node rail')
  assert.equal(container(mounted).querySelectorAll('.superworker-olinks path').length, 2, 'two anchored children drew two lines')
  snap = snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])
  await mounted.rerender()
  const leaving = container(mounted).querySelector('[data-window="c3"]')
  assert.notEqual(leaving, null, 'the leaving pane left the page before its leave ran')
  assert.ok(leaving.className.includes('is-leave'), 'the leaving pane carries no leave mark')
  /* The tie stands with the pane it ties: the line leaves when the pane does, not a beat early. */
  assert.equal(container(mounted).querySelectorAll('.superworker-olinks path').length, 2, 'the leaving pane lost its line before it left')
  /* A child leaving says nothing about the rail: the rail is the line's own switch, not this column's
   * index — so it stands exactly as it did, and here it was never standing. */
  assert.equal(container(mounted).querySelector('.superworker-orail'), null, 'the rail came back with the column it no longer indexes')

  /* Waiting on the leave's own span: the removal is the component's timer, and jsdom fires no
   * animationend to hang on — the only fact to wait for is the span itself running out. Inside
   * act, because the span's expiry is what updates the drawing. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 480))
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
  /* Two running children of one step: the children column is full, and the line has nothing to
   * switch to — a rail is the switch over the line's steps, not this column's index. */
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
  /* The rail's warn ink answers the same one fact, on the bars: no step of this line is at a gate,
   * and a child waiting for an answer is not one — a column of children never lights it. */
  assert.equal(container(mounted).querySelectorAll('.superworker-orail button.is-need').length, 0, 'a rail bar lit the gate ink for a child waiting on an answer')
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
    await new Promise((resolve) => setTimeout(resolve, 480))
  })
  assert.equal(container.querySelector('[data-window="c1"]'), null, 'the page kept the finished child past the leave span')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a fold keeps the room still: the survivors hold their boxes until it has run, then the room closes up', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('c1', 'd1', 'one job', 100), ...dispatchRun('c2', 'd2', 'another job', 200)])
  service.set('c1', [read('a.ts', 200)])
  service.set('c2', [read('b.ts', 300)])
  let snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c2', running: true, title: 'the second child' },
  ])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const before = boxOf(container, 'c1')
  assert.notEqual(before, null, 'the surviving child was not drawn')

  /* The second child's session stops. Its pane folds; the first one must not move while it does —
   * a survivor that re-measures on the fold's first frame is the tear this pins against. */
  snap = snapshotOf([
    { id: 'c1', running: true, title: 'the first child' },
    { id: 'c2', running: false, title: 'the second child' },
  ])
  await mounted.rerender()
  assert.ok(container.querySelector('[data-window="c2"]')?.className.includes('is-leave'), 'the folded pane carries no leave mark')
  assert.equal(fieldSettling(container), false, 'the room closed up while the fold was still playing')
  assert.deepEqual(boxOf(container, 'c1'), before, 'a survivor moved while the fold was still playing')
  /* One step of the line stands: the rail is not the column's index, so nothing about a child
   * folding off the stage can stand one up. */
  assert.equal(container.querySelector('.superworker-orail'), null, 'a child folding off the stage stood a rail up')

  /* Past the fold's span the pane is gone, the room closes up, and the survivor takes the new box —
   * by a transition the sheet spends, never by a jump. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 480))
  })
  assert.equal(container.querySelector('[data-window="c2"]'), null, 'the page kept the folded pane past its span')
  assert.notDeepEqual(boxOf(container, 'c1'), before, 'the room never closed up: the survivor kept the stale box')
  assert.equal(fieldSettling(container), true, 'the room closed up without the settle mark that spends the distance')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

/** The inline box one window stands at, as the geometry wrote it. */
function boxOf(container, id) {
  const el = container.querySelector(`[data-window="${id}"]`)
  if (el === null) return null
  return { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }
}

/** Whether the stage is spending the room's closing-up rather than snapping to it. */
function fieldSettling(container) {
  const field = container.querySelector('.superworker-ofield')
  return field !== null && field.className.includes('is-settle')
}

/**
 * The two boxes a pane draws with, as the inline styles spell them: what the geometry handed this
 * window on this beat.
 */
function rectOf(container, id) {
  const box = boxOf(container, id)
  if (box === null) return null
  return { left: parseFloat(box.left), top: parseFloat(box.top), width: parseFloat(box.width), height: parseFloat(box.height) }
}

/** Whether two boxes claim the same ground: no layout puts two windows on top of each other. */
function overlapOf(a, b) {
  if (a === null || b === null) return null
  const x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return x > 0 && y > 0 ? { x, y } : null
}

/**
 * A child that arrives while an earlier fold is still in flight, and ends before that fold has run.
 *
 * The window in question is the newcomer: it is live on no beat with nothing leaving, so it never
 * reaches the list the column's slots are rebuilt from. The column therefore measures the stage as if
 * it were not there, while the pane is still drawn — and the two windows stand on the same ground.
 *
 * What is pinned is a relation, not a distance: no two windows may be drawn on one another, and a
 * window still standing is measured together with the ones it stands beside. The gap's own number is
 * the geometry's business (`overview-geom.test.mjs` holds that table); a case here that named it would
 * break the moment the stage's breathing gap was retuned, which is a change this behaviour survives.
 */
test('a window that arrives mid-fold and leaves again is still measured while it is drawn', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [...dispatchRun('cA', 'dA', 'the first job', 100), ...dispatchRun('cX', 'dX', 'the next job', 200)])
  service.set('cA', [read('a.ts', 200)])
  service.set('cX', [read('x.ts', 300)])
  let snap = snapshotOf([
    { id: 'cA', running: true, title: 'the first child' },
    { id: 'cX', running: true, title: 'the next child' },
  ])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted

  /* `cA` ends first: its pane folds, and `cX` keeps standing. */
  snap = snapshotOf([{ id: 'cX', running: true, title: 'the next child' }])
  await mounted.rerender()
  assert.notEqual(rectOf(container, 'cX'), null, 'the surviving child left the stage with the folded one')
  assert.ok(container.querySelector('[data-window="cA"]')?.className.includes('is-leave'), 'the ended child carries no leave mark')

  /* The newcomer ends too, before the first fold's span has run. Both panes are still on the page, and
   * neither may be drawn over the other: two windows on one ground is a frame the geometry cannot
   * produce, so it can only come from the two having been measured by different readings. */
  snap = snapshotOf([])
  await mounted.rerender()
  const cA = rectOf(container, 'cA')
  const cX = rectOf(container, 'cX')
  assert.notEqual(cA, null, 'the first folding pane vanished before its fold ran')
  assert.notEqual(cX, null, 'the second folding pane vanished before its fold ran')
  assert.equal(overlapOf(cA, cX), null, `two windows were drawn on the same ground: ${JSON.stringify({ cA, cX })}`)

  /* A child still standing is part of what the column is measured over: each drawn window gets its own
   * place in that column. The failure this pins had both panes claiming one column, so "distinct
   * columns" is the relation — not any particular left edge or width, which is the geometry's. */
  const main = rectOf(container, 'm1')
  assert.notEqual(main, null, 'the main window left the stage')
  assert.notDeepEqual(cA, cX, 'both folding panes were given the same box')
  assert.equal(overlapOf(main, cA), null, 'the main window and a folding pane were drawn on the same ground')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

/** A folding pane's words, as the sheet's own rules spell them: the fade that keeps the fold's edge
 *  from cutting a row that is still at full strength. The case pins the rule, never a frame — a fold
 *  whose rows simply stay lit while the box closes is the guillotine, and that is a fact about the
 *  sheet, not about any one span's number. */
test('a folding window takes its words out with it, so the frame edge never cuts a live row', { skip: bundleSkip }, () => {
  const sheet = stripComments(readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8'))
  const blocks = cssBlocks(sheet, { descend: 'all' })
  const rules = blocks.filter((block) => block.kind === 'rule')

  /* The pane clips while it folds (`overflow: hidden`), so its rows need a fade of their own. */
  const clipping = rules.find((rule) => rule.prelude.includes('.superworker-opane.is-leave'))
  assert.notEqual(clipping, undefined, 'the sheet states no rule for a folding pane')
  assert.match(clipping.body, /overflow:\s*hidden/u, 'the folding pane no longer clips, so this case is asking the wrong question')

  const fade = rules.find((rule) => rule.prelude.includes('.superworker-opane.is-leave') && rule.prelude.includes('.superworker-ofeed'))
  assert.notEqual(fade, undefined, 'a folding window animates no fade on its rows: the fold cuts them at full strength')
  const named = /animation:\s*([\w-]+)/u.exec(fade.body)
  assert.notEqual(named, null, 'the folding window states no animation for its rows')

  /* The keyframes it names must exist, and must end at nothing: a fade that stops part-way still
   * leaves a row at full strength under the closing edge. */
  const steps = rules.filter((rule) => rule.at === `@keyframes ${named[1]}`)
  assert.ok(steps.length >= 2, `the fade ${named[1]} is named but never stated`)
  const last = steps.at(-1)
  assert.match(last.body, /opacity:\s*0/u, `the fade ${named[1]} does not end at nothing`)

  /* And a reader who asked for motion off is not handed a second fade inside the pane's own. */
  assert.match(sheet, /prefers-reduced-motion[\s\S]*?superworker-opane\.is-leave[\s\S]*?superworker-ofeed[\s\S]*?animation:\s*none/u, 'a reader with motion off is still shown the fold\'s own second fade')
})

test('a window stopped before the record spoke: its rows stay sharp, and no mark says what happened', { skip: bundleSkip }, async () => {
  /* The reader's complaint: the rehearsal wrapped up and the last window wore no check. It was the
   * beat between the conversation's last turn and the settle that follows it — stopped, delivered
   * nothing yet — and the veil was drawn for the stop alone. A veiled window claims the frame has
   * the answer; here the frame has nothing at all, so the rows are the only reading there is. */
  const service = fakeSessionsService()
  service.set('m1', [said('a word from the conversation being read.', 100)])
  const snap = {
    ids: ['m1'],
    byId: { m1: { id: 'm1', running: false, displayTitle: 'the main conversation' } },
  }
  const mounted = await mountBuiltPanel({
    record: recordBeforeItSpeaks(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const main = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')
  const feed = main.querySelector('.superworker-ofeed')
  assert.ok(!feed.className.includes('is-veiled'), 'a window with nothing said about it hid its rows behind the veil')
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the window lost its rows')
  assert.equal(main.querySelector('.superworker-omark'), null, 'a window the record has said nothing about wears a mark')
  assert.equal(main.className.includes('is-broken'), false, 'a quiet stop wears the break’s frame')
  assert.equal(main.className.includes('is-wait'), false, 'a quiet stop breathes like a gate')
  assert.equal(main.querySelector('.superworker-oring'), null, 'a stopped window turns a ring')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a window opening into its real box: the growth is spent on the way, once', { skip: bundleSkip }, async () => {
  /* What the reader saw on opening the panel: every window stood measured over nothing — its rows
   * are its own conversation's, and they cannot be read until the session windows are held open — so
   * it was a flat bar, and it snapped to a full window a beat later. The growth out of that first box
   * is the one box change the sheet spends, and it is spent once: every later box is a re-measure or
   * a row landing, and those follow the geometry straight away. */
  const service = fakeSessionsService()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
  })
  await stageAt(mounted, 1024, 720)
  const flat = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(flat, null, 'the main window is not drawn')
  /* The arm is on while the box is still the provisional one — it has to be, or the commit that
   * grows the box arrives with nothing to travel from and the reader sees the jump again. */
  assert.ok(flat.className.includes('is-grow'), 'a window standing in its provisional box is not armed to expand')
  assert.equal(flat.querySelectorAll('.superworker-orow').length, 0, 'the first box was not the provisional one — the case proves nothing')
  const flatHeight = flat.style.height

  /* The rows land, and the box grows with them. */
  await mounted.act(async () => {
    service.set('m1', [said('one.', 100), said('two.', 200), said('three.', 300)])
  })
  const grown = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(grown.style.height, flatHeight, 'the window did not grow — the case proves nothing')
  assert.ok(grown.className.includes('is-grow'), 'the window jumped into its real box instead of expanding into it')

  /* The sheet is what spends it, and it is an ease-out expansion on the box. */
  const sheet = readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8')
  const rule = cssBlocks(stripComments(sheet), { descend: 'all' })
    .filter((block) => block.kind === 'rule' && block.prelude.includes('.superworker-opane.is-grow'))
    .at(0)
  assert.notEqual(rule, undefined, 'no rule spends the opening growth')
  assert.match(rule.body, /transition:[^;]*height/u, 'the opening growth transitions no height')
  assert.match(rule.body, /cubic-bezier\(0\.22,\s*0\.61,\s*0\.36,\s*1\)/u, 'the opening growth is not eased out')

  /* The opening is over once the rows have landed and their growth has had its span: from there the
   * window follows the geometry, so a later row landing travels nothing. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 420))
  })
  assert.ok(!grown.className.includes('is-grow'), 'the expansion mark outlived the opening')
  const stoodAt = grown.style.height
  await mounted.act(async () => {
    service.set('m1', [said('one.', 100), said('two.', 200), said('three.', 300), said('four.', 400)])
  })
  assert.notEqual(grown.style.height, stoodAt, 'the later row did not move the box — the case proves nothing')
  assert.ok(!grown.className.includes('is-grow'), 'a later row landing borrowed the opening expansion')
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
  assert.equal(main.className.includes('is-broken'), false, 'a clean stop wears the break’s frame')
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

test("the main window at a person's gate stops as a checkpoint: it breathes amber, veiled, under the pause", { skip: bundleSkip }, async () => {
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
  /* The gate's own fact is what the reader acts on, so the rows step back behind it — one veil for
   * every ending, and the frame's ink (amber here) is what says which ending it is. */
  assert.ok(main.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'the checkpoint window keeps its rows sharp beside the gate it is asking about')
  /* The gate carries a mark of its own, in the check's square — and it is *not* the check and *not*
   * the ring: a person is owed a word, which is neither "handed in" nor "still moving". */
  const gated = main.querySelector('.superworker-omark')
  assert.notEqual(gated, null, 'the window at a gate says nothing in the band where every verdict stands')
  assert.ok(gated.className.includes('is-gate'), 'the gate mark is drawn in the check’s own ink')
  assert.notEqual(gated.querySelector('svg'), null, 'the gate mark has no drawing')
  assert.equal(gated.style.width, '44px', `the gate's square is ${gated.style.width}, not the check's 44`)
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the checkpoint window lost its rows')
  assert.equal(main.querySelector('.superworker-oring'), null, 'the checkpoint window turns a ring')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the main window still running draws as it runs: no veil, no check, no gate, and the ring turns in its nameplate', { skip: bundleSkip }, async () => {
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
  /* "Still moving" is drawn on the window that is moving, whichever window it is: a reader looking for
   * the spinner in one place must not have to learn that the main window keeps it somewhere else. */
  const ring = main.querySelector('.superworker-oring')
  assert.notEqual(ring, null, 'a running main window turns no ring')
  assert.notEqual(main.querySelector('.superworker-oplate .superworker-oring'), null, 'the main window’s ring is not in its nameplate')
  assert.equal(ring.style.width, '10px', `the ring is ${ring.style.width} across, not 10`)
  assert.ok(!main.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'a running main window is veiled')
  assert.equal(main.className.includes('is-wait'), false, 'a running main window nobody waits on breathes')
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the running main window lost its rows')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a checkpoint the person is working through is no gate: a running window draws as it runs', { skip: bundleSkip }, async () => {
  /* The record still calls the checkpoint a delivery owing a person a word (no `approved_at` was
   * ever written), and the conversation is running again — the person answered, and the step is being
   * worked. A pause over the live stream would say the one thing the stream contradicts, and the rail
   * would light the gate's ink for a step that is running. */
  const service = fakeSessionsService()
  service.set('m1', [said('the person said go; working through the checkpoint.', 100)])
  const mounted = await mountBuiltPanel({
    record: recordAtCheckpoint(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const main = container.querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')
  assert.equal(main.className.includes('is-wait'), false, 'a running conversation was drawn at a gate')
  assert.equal(main.querySelector('.superworker-omark'), null, 'the pause stands over a running conversation')
  assert.ok(!main.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'a running conversation hid its rows behind a gate veil')
  assert.notEqual(main.querySelector('.superworker-oring'), null, 'the running conversation turns no ring')
  assert.equal(container.querySelectorAll('.superworker-orail button.is-need').length, 0, 'the rail lit the gate ink for a step being worked')

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

/** The record a ghost comes from: the panel's own node delivered, and a second node the line is still
 * holding, whose launch cell was written and whose note names a session that is not running any more.
 * The debt is on the record; only the leg's conversation is gone. */
const recordOfADeadLeg = () => ({
  ...record(),
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
      n1: {
        title: 'the leg that died',
        description: 'a piece of work the line still holds',
        tags: [],
        mode: 'auto',
        status: 'todo',
        created_at: '2026-01-08T00:00:00.000Z',
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
        holding: [{ id: 'n1', since: '2026-01-08T00:00:00.000Z' }],
        path: [{ node: 'n0', started_at: '2026-01-08T00:00:00.000Z', ended_at: '2026-01-09T00:00:00.000Z', result: 'delivered' }],
      },
    ],
  }),
  '.superworker/meta/sessions/n1.json': json({ run: [{ session: 'c1', at: '2026-01-08T00:00:00.000Z' }] }),
  '.superworker/meta/launch/c0/n1/prompt.txt': 'go\n',
  '.superworker/meta/launch/c0/n1/started': '2026-01-08T00:00:00.000Z',
})

/** The same line with a second step of its own: n1 is on the table and c1 is working it. */
const recordWithARunningLeg = () => ({
  ...recordOfADeadLeg(),
  '.superworker/meta/sessions/n1.json': json({ run: [{ session: 'c1', at: '2026-01-08T00:00:00.000Z' }] }),
})

/** The same line, ending at a checkpoint nobody has approved: n1 is delivered and a person is owed. */
const recordWithAGatedLeg = () => ({
  ...record(),
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
      n1: {
        title: '闸口：等一声批准',
        description: 'collects the two hand-ins and waits for a person',
        tags: [],
        mode: 'checkpoint',
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
          { node: 'n0', started_at: '2026-01-08T00:00:00.000Z', ended_at: '2026-01-08T12:00:00.000Z', result: 'delivered' },
          { node: 'n1', started_at: '2026-01-08T12:00:00.000Z', ended_at: '2026-01-09T00:00:00.000Z', result: 'delivered' },
        ],
      },
    ],
  }),
  '.superworker/meta/sessions/n1.json': json({ run: [{ session: 'c1', at: '2026-01-08T12:00:00.000Z' }] }),
})

/** Two steps on the table at once: m1's node delivered, c1's still being worked. */
const snapshotOfTwoLegs = () => ({
  ids: ['m1', 'c1'],
  byId: {
    m1: { id: 'm1', running: true, retainedBy: { mainView: 1 }, displayTitle: 'the main conversation' },
    /* The dispatch's own parent link: the main conversation is the one that opened the next step, and
     * that bond is exactly what must not put a node's session in the children column. */
    c1: { id: 'c1', running: true, parentId: 'm1', displayTitle: 'the second step' },
  },
})

test('a leg that died owing work keeps its bar, in the break\'s ink, and stands off the stage', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('dispatched it, and it never came back.', 100)])
  service.set('c1', [read('a.ts', 200), { type: 'turn/end', time: 300, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }])
  const mounted = await mountBuiltPanel({
    record: recordOfADeadLeg(),
    sessionsService: service,
    /* The reader is in the delivered step's own conversation; the dead leg is the other step. */
    sessionId: 'm1',
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: false, title: 'the leg that died' }], false)),
    /* The host's own roster: the main conversation is alive, the leg is not. That is what makes the
     * claim on disk a stranded one. */
    agents: { list: () => [{ id: 'm1' }] },
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  /* The dead leg is a step of the line, so what stands for it is a bar on the rail — never a second
   * window beside the one being read. Two steps on the table is also what gives the rail its job.
   * Counts, not elements: an assertion that stringifies a jsdom element takes half a minute to fail. */
  assert.equal(container.querySelectorAll('[data-window]').length, 1, `the stage drew ${container.querySelectorAll('[data-window]').length} windows`)
  const bars = container.querySelectorAll('.superworker-orail button')
  assert.equal(bars.length, 2, `the rail offers ${bars.length} bars`)
  /* The order is the reading's: the step the stage is drawing first, lit; the dead one after it, in
   * the break's ink. One ink, one fact. */
  assert.ok(bars[0].className.includes('is-on'), 'the step the stage is drawing is not the lit bar')
  assert.equal(bars[0].getAttribute('aria-current'), 'true', 'the lit bar does not say it is the current step')
  assert.ok(bars[1].className.includes('is-broken'), 'the dead leg’s bar says nothing about the work it still owes')
  assert.equal(bars[1].className.includes('is-on'), false, 'the dead leg’s bar lit as the step on the stage')
  /* A bar carries no word; the node's own title is the bar's name, for a hover and for a screen reader. */
  assert.equal(bars[1].getAttribute('title'), 'the leg that died', 'the bar does not name the step it stands for')
  assert.equal(bars[1].getAttribute('aria-label'), 'the leg that died', 'the bar has no name for a screen reader')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the rail is a switch: a press on a bar draws that step, and never two of them', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('this conversation dispatched the next step.', 100)])
  service.set('c1', [read('b.ts', 200)])
  const mounted = await mountBuiltPanel({
    record: recordWithARunningLeg(),
    sessionsService: service,
    /* The reader is in the delivered step's own conversation: this stage is that step, and the
     * other one is a bar on the rail. */
    sessionId: 'm1',
    useSessions: (select) => select(snapshotOfTwoLegs()),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  /* One stage, one step: the second step of the line was dispatched by this very conversation, and it
   * is still a bar — never a window in the children column. Counts only: a failed assertion that
   * stringifies a jsdom element is slow enough to look like a hang. */
  assert.equal(container.querySelectorAll('[data-window]').length, 1, `the stage drew ${container.querySelectorAll('[data-window]').length} windows`)
  assert.equal(container.querySelector('.superworker-orail') === null, false, 'two steps on the table drew no rail')
  let bars = container.querySelectorAll('.superworker-orail button')
  assert.equal(bars.length, 2, `the rail offers ${bars.length} bars`)

  await mounted.act(async () => {
    bars[1].click()
  })
  /* The stage is the step that was pressed, named by its own node, and the other step is nowhere on
   * the page: the switch moved the stage rather than adding to it, and the step it replaced is not
   * held to fold — a replaced cast is gone, not a window that left. Counts before elements: an
   * assertion that stringifies a jsdom element takes half a minute to fail. */
  assert.equal(container.querySelectorAll('[data-window]').length, 1, `the stage drew ${container.querySelectorAll('[data-window]').length} windows after the switch`)
  assert.equal(container.querySelectorAll('.superworker-opane.is-leave').length, 0, 'the step that was replaced was held to fold')
  const second = container.querySelector('[data-window="c1"]')
  assert.equal(second === null, false, 'the step the reader pressed is not on the stage')
  assert.ok(second.className.includes('is-main'), 'the pressed step was drawn as a child of the step it replaced')
  assert.equal(second.querySelector('.superworker-oplate-n')?.textContent, 'the leg that died', 'the nameplate does not read the pressed step\'s node')
  bars = container.querySelectorAll('.superworker-orail button')
  assert.equal(bars[0].getAttribute('aria-current'), null, 'the old step is still the lit bar')
  assert.equal(bars[1].getAttribute('aria-current'), 'true', 'the pressed step\u2019s bar is not the lit one')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the line hands the stage on: the finished page folds in its own box, and the rail moves with it', { skip: bundleSkip }, async () => {
  /* The reader stayed on a finished step's page: its node was delivered and nothing else of the line
   * was out, so the check stood on the stage. Then the next step starts — the line has left that page
   * — and the stage hands over: the page being closed folds where it stood, the page arriving grows
   * where it stands, and the rail's lit bar moves in the same frame. The closed page repeats no
   * verdict: its check ended it, and what came of it is the page the stage now stands on. */
  const service = fakeSessionsService()
  service.set('m1', [said('这一个节点交完了.', 100), { type: 'turn/end', time: 200, data: { reason: { kind: 'completed' } } }])
  service.set('c1', [read('a.ts', 300)])
  let snap = {
    ids: ['m1', 'c1'],
    byId: {
      m1: { id: 'm1', running: false, displayTitle: 'the finished step' },
      /* The next step of the same line: on the table, not yet started — the stage is the reader's own
       * page, under the check. */
      c1: { id: 'c1', running: false, displayTitle: 'the step about to start' },
    },
  }
  const mounted = await mountBuiltPanel({
    record: recordOfADeadLeg(),
    sessionsService: service,
    /* The reader is in the delivered step's own conversation. */
    sessionId: 'm1',
    useSessions: (select) => select(snap),
    agents: { list: () => [{ id: 'm1' }] },
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const finished = container.querySelector('[data-window="m1"]')
  assert.notEqual(finished, null, 'the stage does not draw the delivered step the reader is on')
  assert.notEqual(finished.querySelector('.superworker-omark'), null, 'the delivered page carries no check')
  let bars = container.querySelectorAll('.superworker-orail button')
  assert.equal(bars.length, 2, `the rail offers ${bars.length} bars`)
  assert.equal(bars[0].getAttribute('aria-current'), 'true', 'the finished page is not the lit bar')

  /* The next step starts being worked: the line has moved on, and the page the reader was reading
   * is handed over. */
  snap = {
    ids: ['m1', 'c1'],
    byId: {
      m1: { id: 'm1', running: false, displayTitle: 'the finished step' },
      c1: { id: 'c1', running: true, displayTitle: 'the step about to start' },
    },
  }
  await mounted.rerender()
  const closing = container.querySelector('[data-window="m1"]')
  assert.notEqual(closing, null, 'the page the line left was swapped out instead of folding')
  assert.ok(closing.className.includes('is-leave'), 'the page the line left carries no leave mark')
  assert.ok(closing.className.includes('is-main'), 'the page the line left folds as a child window')
  assert.equal(closing.querySelector('.superworker-omark'), null, 'the closed page repeats a verdict of its own')
  const opened = container.querySelector('[data-window="c1"]')
  assert.notEqual(opened, null, 'the page the line moved on to is not drawn')
  assert.ok(opened.className.includes('is-main'), 'the page the line moved on to was drawn as a child')
  assert.equal(opened.className.includes('is-leave'), false, 'the page the line moved on to is folding')
  bars = container.querySelectorAll('.superworker-orail button')
  assert.equal(bars[0].getAttribute('aria-current'), null, 'the rail kept the lit bar on the page the line left')
  assert.equal(bars[1].getAttribute('aria-current'), 'true', 'the rail did not move with the stage')
  /* The stage's own appearance is on the page it opened: one cast replacing another has no source to
   * fly in from, so the windows grow where they stand. */
  assert.ok(container.querySelector('.superworker-ofield').className.includes('is-first'), 'the page the line opened arrived with no motion at all')

  /* The fold runs its span, and the page is gone: the stage is the step being worked and nothing
   * else. */
  await mounted.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 480))
  })
  assert.equal(container.querySelector('[data-window="m1"]'), null, 'the page the line left was kept past the fold')
  assert.notEqual(container.querySelector('[data-window="c1"]'), null, 'the page the line moved on to left the stage')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the step on the table and the seat that stopped with it: two windows, one step, and no rail', { skip: bundleSkip }, async () => {  /* Filed from the iPad: one node is held by the line, its conversation was stopped by hand, and the
   * subagent it had dispatched stopped with it. The seat stands beside the step — the cut is where the
   * line stands — but the rail is the line's switch over **steps**, and one step has nowhere to switch
   * to: a second bar would be a conversation the stage is already drawing, offered a second time. */
  const service = fakeSessionsService()
  service.set('c1', [read('a.ts', 200), { type: 'turn/end', time: 300, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }])
  service.set('g1', [read('b.ts', 400), { type: 'turn/end', time: 500, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }])
  const mounted = await mountBuiltPanel({
    record: recordOfADeadLeg(),
    sessionsService: service,
    useSessions: (select) => select({
      ids: ['m1', 'c1'],
      byId: {
        m1: { id: 'm1', running: false, displayTitle: 'the delivered step' },
        c1: { id: 'c1', running: false, parentId: 'm1', displayTitle: 'the step on the table' },
        /* A subagent's own session: DSH keeps it in the map without listing it, and its parent is the
         * step being drawn — which is exactly what makes it a seat of this stage, not a step of the line. */
        g1: { id: 'g1', running: false, parentId: 'c1', displayTitle: '你这一趟只做一件事：按节点' },
      },
    }),
    /* The claim is on disk and the session is gone from this host's roster: the debt is proved. */
    agents: { list: () => [{ id: 'm1' }] },
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  assert.equal(container.querySelectorAll('[data-window]').length, 2, `the stage drew ${container.querySelectorAll('[data-window]').length} windows`)
  const seat = container.querySelector('[data-window="g1"]')
  assert.notEqual(seat, null, 'the seat where the cut is read left the stage')
  assert.ok(seat.className.includes('is-broken'), 'the seat stopped by hand says nothing about the work it still owes')
  assert.equal(container.querySelector('.superworker-orail'), null, 'a seat of the stage stood on the rail as a step of the line')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the step a reader switches to, dead and owing work: the break is the frame, and one word says why', { skip: bundleSkip }, async () => {
  /* The same dead leg as above, this time pressed on the rail: on the stage its own window is read
   * with what it owes, which is the whole reason a stopped leg keeps a bar. */
  const service = fakeSessionsService()
  service.set('m1', [said('dispatched it, and it never came back.', 100)])
  service.set('c1', [read('a.ts', 200), { type: 'turn/end', time: 300, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }])
  const mounted = await mountBuiltPanel({
    record: recordOfADeadLeg(),
    sessionsService: service,
    /* The reader is in the delivered step's own conversation; the dead leg is the other step. */
    sessionId: 'm1',
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: false, title: 'the leg that died' }], false)),
    agents: { list: () => [{ id: 'm1' }] },
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  await mounted.act(async () => {
    container.querySelectorAll('.superworker-orail button')[1].click()
  })
  const ghost = container.querySelector('[data-window="c1"]')
  assert.notEqual(ghost, null, 'the step the reader pressed is not on the stage')
  assert.ok(ghost.className.includes('is-main'), 'the dead leg was drawn as a child window')
  /* The conversation is over, but its frame is what says so. The rows step back behind it: they are
   * how far the leg got, kept in place and said dimmer, so the one word the window says is read on its
   * own ground instead of over passing text. */
  assert.ok(ghost.querySelector('.superworker-ofeed').className.includes('is-veiled'), 'the dead leg’s rows stay sharp behind the notice the frame is already asking about')
  assert.equal(ghost.querySelectorAll('.superworker-orow').length, 1, 'the dead leg lost the rows it died with')
  assert.ok(ghost.className.includes('is-broken'), 'the dead leg’s frame says nothing about the work it still owes')
  assert.equal(ghost.querySelector('.superworker-omark'), null, 'the dead leg wears a mark inside a frame that already says it')
  const fault = ghost.querySelector('.superworker-ofault')
  assert.notEqual(fault, null, 'the dead leg says no word')
  /* The notice owns a ground of its own. The outer box is the geometry's — it only centres — and the
   * inner one is what the word stands on; without it the red is read straight over whatever rows are
   * passing under it, which is the whole point of the ground. */
  const notice = fault.querySelector('.superworker-ofault-n')
  assert.notEqual(notice, null, 'the fault line paints no ground, so its word is read over the rows')
  assert.equal(notice.textContent, zh['overview.fault.user'], 'the dead leg’s word is not how its turn ended')
  assert.equal(fault.querySelector('svg') === null, false, 'the fault line carries no glyph')
  assert.equal(ghost.getAttribute('title'), null, 'the frame still carries a hover of its own')
  /* It is not moving any more, so the ring is gone with the motion. */
  assert.equal(ghost.querySelector('.superworker-oring'), null, 'a stopped leg still turns its ring')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the same leg, its work handed in: no bar, and no window with it', { skip: bundleSkip }, async () => {
  /* The same scene with the record saying the node was delivered and the line no longer holding it:
   * the debt is gone, so nothing keeps the bar — the step owes nobody a look, and the rail left with
   * a single step on the table. */
  const record = recordOfADeadLeg()
  record['.superworker/ideas.json'] = json({
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
      n1: {
        title: 'the leg that died',
        description: 'a piece of work the line still holds',
        tags: [],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-08T00:00:00.000Z',
        completed_at: '2026-01-09T00:00:00.000Z',
        dependencies: [],
      },
    },
  })
  record['.superworker/state.json'] = json({
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
        path: [{ node: 'n1', started_at: '2026-01-08T00:00:00.000Z', ended_at: '2026-01-09T00:00:00.000Z', result: 'delivered' }],
      },
    ],
  })
  const service = fakeSessionsService()
  service.set('m1', [said('dispatched it, and it delivered.', 100)])
  const mounted = await mountBuiltPanel({
    record,
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: false, title: 'the leg that died' }])),
    agents: { list: () => [{ id: 'm1' }] },
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(mounted.container.querySelector('[data-window="c1"]') === null, true, 'a finished leg that owes nothing kept its window')
  assert.equal(mounted.container.querySelector('.superworker-orail'), null, 'a delivered leg kept a bar on the rail')

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
  /* The narrow stage: 500 leaves the pair less than their floors, so the column leaves. */
  await stageAt(mounted, 500, 480)
  const { container } = mounted
  assert.ok(container.querySelector('[data-window="c1"]') === null, 'the column was drawn on the narrow stage')
  assert.ok(container.querySelector('.superworker-olinks') === null, 'a line was drawn to a window that is not there')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a step at a person\'s gate keeps its bar, in the warn ink, and pressing it opens that step', { skip: bundleSkip }, async () => {
  /* A checkpoint delivered its work and stopped: the line owes it nothing, a *person* is still owed a
   * word. The rail must offer it — the gate is the one thing the record asks the reader to do — and
   * its bar wears the warn ink, the same ink the window's border wears for the same fact. */
  const service = fakeSessionsService()
  service.set('m1', [said('handed the checkpoint over, and it waits on you.', 100)])
  service.set('c1', [said('the checkpoint is written.', 200)])
  const mounted = await mountBuiltPanel({
    record: recordWithAGatedLeg(),
    sessionsService: service,
    sessionId: 'm1',
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: false, title: 'the gate' }], false)),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const bars = container.querySelectorAll('.superworker-orail button')
  assert.equal(bars.length, 2, `the rail offers ${bars.length} bars`)
  assert.ok(bars[1].className.includes('is-need'), 'the bar of a step waiting on a person wears no gate ink')
  assert.equal(bars[1].className.includes('is-broken'), false, 'a step at a gate was drawn as a break')
  assert.equal(bars[1].getAttribute('title'), '闸口：等一声批准', 'the bar does not name the step it waits on')

  await mounted.act(async () => {
    bars[1].click()
  })
  const gated = container.querySelector('[data-window="c1"]')
  assert.equal(gated === null, false, 'the step at the gate did not come to the stage')
  assert.ok(gated.className.includes('is-main'), 'the step at the gate was drawn as a child')
  assert.ok(gated.className.includes('is-wait'), 'the stage does not say a person is owed a word')
  /* The step the reader switched to carries the same gate mark the stage always draws for a word
   * owed — the switch changes which step is read, never how a step is drawn. */
  const pause = gated.querySelector('.superworker-omark')
  assert.notEqual(pause, null, 'the step the reader switched to says nothing in the band where every verdict stands')
  assert.ok(pause.className.includes('is-gate'), 'the switched-to gate is drawn in the check’s ink')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the rail keeps its lane on a stage too narrow for a children column, and indexes nothing', { skip: bundleSkip }, async () => {
  /* 520 is under the pair's floors once the lane and the probe are taken out: a column could not
   * stand. The rail is the line's switch and not that column's index, so a stage that drops the
   * column still keeps the bar that moves the stage to another step. */
  const service = fakeSessionsService()
  service.set('m1', [said('this conversation dispatched the next step.', 100)])
  service.set('c1', [read('b.ts', 200)])
  const mounted = await mountBuiltPanel({
    record: recordWithARunningLeg(),
    sessionsService: service,
    /* The reader is in the delivered step's own conversation: this stage is that step, and the
     * other one is a bar on the rail. */
    sessionId: 'm1',
    useSessions: (select) => select(snapshotOfTwoLegs()),
  })
  await stageAt(mounted, 520, 480)
  const { container } = mounted
  assert.equal(container.querySelectorAll('[data-window]').length, 1, `the narrow stage drew ${container.querySelectorAll('[data-window]').length} windows`)
  assert.equal(container.querySelector('.superworker-orail') === null, false, 'the rail left with a column it no longer indexes')
  assert.equal(container.querySelectorAll('.superworker-orail button').length, 2, 'the rail lost a step of the line on a narrow stage')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a running child with no label and no readable events draws no pane', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  /* c1 can be retained, but its window holds nothing readable and its row spells no label: the box
     it would draw has no head and nothing to say. c2, labelled, is the control: a head alone is
     enough for a window to say what it is. */
  const snap = snapshotOf([
    { id: 'c1', running: true, title: '' },
    { id: 'c2', running: true, title: 'the labelled child' },
  ])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  assert.equal(container.querySelector('[data-window="c1"]'), null, 'a headless, eventless box was drawn as a window')
  assert.notEqual(container.querySelector('[data-window="c2"]'), null, 'the labelled child lost its window')
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
  assert.equal(main.querySelector('.superworker-oplate-n')?.textContent, 'the driven node', 'the nameplate does not read the node the note names')
  assert.equal(container.querySelector('[data-window="session-old"]'), null, 'the conversation DSH holds as its main view was drawn')
  assert.equal(main.querySelectorAll('.superworker-orow').length, 1, 'the main window does not draw its one row')
  assert.ok((container.textContent ?? '').includes('this pipeline own words.'), "the main window's row is not its own conversation's")
  assert.ok(!(container.textContent ?? '').includes('an unrelated old conversation.'), "another conversation's rows are on the page")

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a refresh lands the stage where the line stands: the held step, not the conversation the browser kept', { skip: bundleSkip }, async () => {
  /* The reader reloads the panel's page mid-run: the browser's snapshot still marks the *delivered*
   * step as its main view (that is the tab the reader last had open), its row moved last, and the
   * list's running bit is one beat behind. The record says otherwise — a cycle holds the second step
   * — so that is the line's work, and it is the conversation the stage draws. The delivered step owes
   * nobody a look: it leaves the rail with its conversation. */
  const service = fakeSessionsService()
  service.set('m1', [said('the delivered step.', 100)])
  service.set('c1', [read('b.ts', 200)])
  const mounted = await mountBuiltPanel({
    record: recordWithARunningLeg(),
    sessionsService: service,
    useSessions: (select) => select({
      ids: ['m1', 'c1'],
      byId: {
        m1: { id: 'm1', running: false, retainedBy: { mainView: 1 }, updatedAt: '2026-11-20T00:00:00.000Z', displayTitle: 'the delivered step' },
        c1: { id: 'c1', running: false, parentId: 'm1', updatedAt: '2026-11-19T00:00:00.000Z', displayTitle: 'the step the line holds' },
      },
    }),
  })
  await stageAt(mounted, 1024, 720)
  const { container } = mounted
  const main = container.querySelector('[data-window="c1"]')
  assert.notEqual(main, null, 'the stage drew the delivered step the browser kept')
  assert.ok(main.className.includes('is-main'), 'the held step was drawn as a child')
  assert.equal(container.querySelector('[data-window="m1"]'), null, 'the delivered step stayed on the stage')
  assert.equal(container.querySelectorAll('.superworker-orail button.is-need').length, 0, 'the rail kept a step the line has left')

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
  const ring = rules.find((rule) => rule.prelude.trim() === '.superworker-page .superworker-oring' && rule.at === '')
  assert.notEqual(ring, undefined, 'no rule turns the running ring')
  assert.match(ring.body, /animation:\s*superworker-oring-spin 1\.3s linear infinite/u, 'the ring does not turn at the demo\'s pace')
  assert.match(ring.body, /border:\s*1\.5px solid/u, 'the ring is not on the panel\'s 1.5px track')
  assert.ok(
    rules.some((rule) => rule.at === '@keyframes superworker-oring-spin' && /rotate\(1turn\)/u.test(rule.body)),
    'the ring has no turn to make',
  )
  /* The main window's ring is that same ring with its cell in the nameplate: the sheet gives it a
   * place and nothing else, so it can never drift into a second kind of spinner. */
  const plate = rules.find((rule) => rule.prelude.trim() === '.superworker-page .superworker-oplate .superworker-oring' && rule.at === '')
  assert.notEqual(plate, undefined, 'no rule gives the nameplate’s ring its cell')
  assert.ok(!/animation|border/u.test(plate.body), 'the nameplate’s ring declares a turn or a track of its own')
  assert.match(plate.body, /top:\s*16px/u, 'the nameplate’s ring is not centred on the title line')
  const still = rules.find((rule) => rule.at.includes('prefers-reduced-motion') && rule.prelude.trim() === '.superworker-page .superworker-oring')
  assert.notEqual(still, undefined, 'the ring keeps turning under reduced motion')
  assert.match(still.body, /animation:\s*none/u, 'the ring keeps turning under reduced motion')
  assert.match(still.body, /border-style:\s*dashed/u, 'the still ring is not left as a dashed ring')
})

function container(mounted) {
  return mounted.container
}

/* ------------------------------------------------------------------ the press: a window opens its conversation */

/** A gateway a case hands the mount: every session DSH would be asked to open, in the order asked. */
function gateway() {
  const opened = []
  return { opened, open: (target) => { opened.push(target) } }
}

/**
 * The sequence one tap sends on an iPad, in the order WebKit sends it: the pointer pair, the touch
 * pair beside it, and the click the browser synthesizes once nothing has taken the gesture away.
 * `dispatchEvent` answers false for an event something prevented, which is the reading a tap has to
 * survive: a prevented touch is the browser handing the press to its own scroll or double-tap zoom,
 * and a prevented click is a press a listener ate.
 */
function tap(window, element) {
  const at = { clientX: 40, clientY: 40 }
  const pointer = (type) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...at })
    /* jsdom has no PointerEvent: the type and the pointer's kind are what React's own handlers read. */
    Object.defineProperty(event, 'pointerType', { value: 'touch' })
    return event
  }
  const touch = (type) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    const finger = { identifier: 9, ...at }
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [finger] })
    Object.defineProperty(event, 'changedTouches', { value: [finger] })
    return event
  }
  return {
    pointerdown: element.dispatchEvent(pointer('pointerdown')),
    touchstart: element.dispatchEvent(touch('touchstart')),
    pointerup: element.dispatchEvent(pointer('pointerup')),
    touchend: element.dispatchEvent(touch('touchend')),
    click: element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...at })),
  }
}

test('a press on the main window opens the conversation it stands for', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 1000)])
  const goes = gateway()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
    openSession: goes.open,
  })
  await stageAt(mounted, 1024, 720)
  const main = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')

  /* The window says it can be pressed, and the name it is announced by is its own title — never
   * its session id, which prints nowhere. */
  assert.equal(main.getAttribute('role'), 'button', 'a window this machine can open is not a control')
  assert.ok(main.className.includes('is-go'), 'the pressable window wears no press mark')
  assert.equal(main.getAttribute('aria-label'), 'the driven node', 'the window is not announced by the title it shows')
  assert.ok(!(main.getAttribute('aria-label') ?? '').includes('m1'), 'a session id was printed as the window`s name')

  await mounted.act(async () => {
    main.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(goes.opened, ['m1'], 'a press on the main window did not open its own conversation')

  /* The keyboard is the same road: the role is a button's, so Enter and Space have to answer. */
  await mounted.act(async () => {
    main.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  assert.deepEqual(goes.opened, ['m1', 'm1'], 'Enter on a focused window did not open its conversation')
  await mounted.act(async () => {
    main.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  assert.equal(goes.opened.length, 3, 'Space on a focused window did not open its conversation')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test("a press on a child opens that child's conversation, wherever on the window it lands", { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100)])
  service.set('c1', [read('a.ts', 300)])
  const goes = gateway()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
    openSession: goes.open,
  })
  await stageAt(mounted, 1024, 720)
  const child = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(child, null, 'the running child is not drawn')
  assert.equal(child.getAttribute('aria-label'), 'the first child', 'the child window is not announced by its title line')

  /* The whole face is the target: a finger has nowhere small to land, so the title line, the rows
   * and the running ring all open the same conversation. */
  const spots = {
    frame: child,
    head: child.querySelector('.superworker-ohead-t'),
    row: child.querySelector('.superworker-orow'),
    ring: child.querySelector('.superworker-oring'),
  }
  for (const [where, element] of Object.entries(spots)) {
    assert.notEqual(element, null, `the child's ${where} is missing`)
    await mounted.act(async () => {
      element.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
    })
  }
  assert.deepEqual(goes.opened, ['c1', 'c1', 'c1', 'c1'], 'a press did not open the child conversation on every spot of its window')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a tap a touch can make: the iPad sequence opens the window, and nothing takes the gesture', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('c1', [read('a.ts', 300)])
  const goes = gateway()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the first child' }])),
    openSession: goes.open,
  })
  await stageAt(mounted, 1024, 720)
  const child = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(child, null, 'the running child is not drawn')

  let taken
  await mounted.act(async () => {
    taken = tap(mounted.window, child)
  })
  assert.deepEqual(taken, { pointerdown: true, touchstart: true, pointerup: true, touchend: true, click: true }, 'a listener took the tap: the browser would never synthesize its click')
  assert.deepEqual(goes.opened, ['c1'], `one tap opened ${goes.opened.length} conversations instead of one`)

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a tap on the verdict mark is a press on its window, and the hover title keeps its own element', { skip: bundleSkip }, async () => {
  /* The mark is the one layer that answers the pointer on purpose (its `title` says how the
   * conversation ended), so it is the layer a press could go missing in: it stands over the window,
   * it is a child of it, and a tap on it has to travel on. */
  const service = fakeSessionsService()
  service.set('m1', [said('a word from the conversation being read.', 100)])
  const goes = gateway()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select({
      ids: ['m1'],
      byId: { m1: { id: 'm1', running: false, displayTitle: 'the main conversation' } },
    }),
    openSession: goes.open,
  })
  await stageAt(mounted, 1024, 720)
  const mark = container(mounted).querySelector('[data-window="m1"] .superworker-omark')
  assert.notEqual(mark, null, 'the stopped window wears no mark')

  let taken
  await mounted.act(async () => {
    taken = tap(mounted.window, mark)
  })
  assert.deepEqual(taken, { pointerdown: true, touchstart: true, pointerup: true, touchend: true, click: true }, 'the mark took the tap instead of letting it through')
  assert.deepEqual(goes.opened, ['m1'], 'a tap on the window`s mark did not open the window`s conversation')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a window whose conversation this machine no longer holds is not pressable', { skip: bundleSkip }, async () => {
  /* The end of a child: the reading stops drawing it, the pane runs its leave animation for a breath
   * with the session already gone from the list. A press there would ask DSH to open a conversation
   * that is not there — so the window is drawn, and takes no press. */
  const service = fakeSessionsService()
  service.set('c1', [read('a.ts', 300)])
  const goes = gateway()
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the finishing child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
    openSession: goes.open,
  })
  await stageAt(mounted, 1024, 720)
  const running = container(mounted).querySelector('[data-window="c1"]')
  assert.equal(running.getAttribute('role'), 'button', 'a running child this machine holds is not a control')

  snap = snapshotOf([])
  await mounted.rerender()
  const leaving = container(mounted).querySelector('[data-window="c1"]')
  assert.notEqual(leaving, null, 'the leaving pane left the page before its leave ran')
  assert.ok(leaving.className.includes('is-leave'), 'the leaving pane carries no leave mark')
  assert.equal(leaving.getAttribute('role'), null, 'a conversation this machine no longer holds was announced as a control')
  assert.ok(!leaving.className.includes('is-go'), 'a conversation this machine no longer holds wears the press mark')

  let taken
  await mounted.act(async () => {
    taken = tap(mounted.window, leaving)
  })
  assert.equal(taken.click, true, 'the leaving pane ate the click instead of letting it pass')
  assert.deepEqual(goes.opened, [], 'a press on a conversation this machine no longer holds reached the gateway')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('with no navigation gateway every window is a drawing: no control, no press, nothing said', { skip: bundleSkip }, async () => {
  /* The deployment DSH's own gateway has not arrived on: the windows are still the reading, and a
   * press has nowhere to go — so they claim no role and take no press, rather than failing on one. */
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 1000)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
  })
  await stageAt(mounted, 1024, 720)
  const main = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the main window is not drawn')
  assert.equal(main.getAttribute('role'), null, 'a window claimed a button`s role with no gateway behind it')
  assert.equal(main.getAttribute('tabindex'), null, 'a window entered the tab order with no gateway behind it')
  assert.ok(!main.className.includes('is-go'), 'a window wore the press mark with no gateway behind it')

  await mounted.act(async () => {
    main.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(main.getAttribute('role'), null, 'a press gave the window a role it never had')
  assert.ok(main.className.includes('is-main'), 'the window stopped being the drawing it was')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the pressable window is the drawing it was: the cursor and the touch action, and no paint of its own', () => {
  const sheet = readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8')
  const rules = cssBlocks(stripComments(sheet), { descend: 'all' }).filter((block) => block.kind === 'rule')
  const go = rules.find((rule) => rule.prelude.trim() === '.superworker-page .superworker-opane.is-go' && rule.at === '')
  assert.notEqual(go, undefined, 'no rule answers a press on a window')
  assert.match(go.body, /cursor:\s*pointer/u, 'a pressable window does not say it can be pressed')
  /* The touch half: without it WebKit holds a tap on a plain box back to see whether a double-tap
   * zoom is coming, and the activation lands late or not at all. */
  assert.match(go.body, /touch-action:\s*manipulation/u, "the touch's own action is missing from the pressable window")
  /* The press paints nothing: a window that can be opened looks exactly like one that cannot, and
   * every colour on this sheet is a token's. */
  assert.ok(
    !/var\(--|#[0-9a-fA-F]{3}|rgba?\(|border|background|animation|transition/u.test(go.body),
    `the pressable class paints: ${go.body}`,
  )
})

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

/** The record with its one node back at the start: never run, never delivered — workable. */
const recordUnstarted = () => ({
  ...recordWithoutNotes(),
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        description: 'the piece the main conversation drives',
        tags: [],
        mode: 'auto',
        status: 'todo',
        created_at: '2026-01-08T00:00:00.000Z',
        dependencies: [],
      },
    },
  }),
})

/** The empty stage's one sentence, read where the reader sees it: nothing when no stage stands. */
function emptyStage(mounted) {
  const stage = mounted.container.querySelector('#pane-overview .superworker-oempty')
  if (stage === null) return null
  return { said: stage.querySelector('p')?.textContent ?? '' }
}

/** The standing corner's three pieces, read where the reader sees them. */
function launchCorner(mounted) {
  const corner = mounted.container.querySelector('#pane-overview .superworker-ofab')
  if (corner === null) return null
  return {
    corner,
    pin: corner.querySelector('.superworker-ofab-pin'),
    route: corner.querySelector('.superworker-ofab-door.is-route'),
    conduct: corner.querySelector('.superworker-ofab-door.is-conduct'),
  }
}

/** A promise whose release the case holds: the action is judged while the call is still out. */
function defer() {
  let resolve
  const promise = new Promise((give) => { resolve = give })
  return { promise, resolve }
}

test('the stage with no window says which of the three situations it is; the corner carries the one move for all of them', { skip: bundleSkip }, async () => {
  /* (a) The record names no session at all: a fresh clone, or a workspace just initialised. */
  const unstarted = await mountBuiltPanel({
    record: recordWithoutNotes(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
  })
  assert.deepEqual(
    { said: emptyStage(unstarted)?.said },
    { said: zh['overview.empty.no-session'] },
    'a record that names no session says something else',
  )
  assert.equal(unstarted.container.querySelectorAll('[data-window]').length, 0, 'a stand-in window was drawn')
  assert.ok(unstarted.container.querySelector('#pane-overview .superworker-ofield') === null, 'the empty stage still drew a window field')
  /* The corner stands on the pane in every state. Its line door is dark here — the record's one
   * node has already delivered, so a line has nothing left to drive — while the graph door is the
   * one door every state may press. */
  const unstartedCorner = launchCorner(unstarted)
  assert.notEqual(unstartedCorner, null, 'the standing corner is missing from the empty stage')
  assert.equal(unstartedCorner.conduct.disabled, true, 'the line door stayed lit with nothing left to work')
  assert.equal(unstartedCorner.route.disabled, false, 'the graph door did not stay pressable')
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
  assert.equal(gone.container.querySelectorAll('[data-window]').length, 0, 'a stranger was drawn instead of nothing')
  assert.notEqual(launchCorner(gone), null, 'the standing corner is missing while a stage sentence stands')
  await gone.unmount()
  assert.deepEqual(gone.consoleErrors, [], 'there is an error in the console')

  /* (c) The record holds no node yet. */
  const bare = await mountBuiltPanel({
    record: recordWithoutNodes(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
  })
  assert.equal(emptyStage(bare)?.said, zh['overview.empty.no-nodes'], 'a record with no node says something else')
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

test('the standing corner: a press unfolds the doors, a door opens that door\'s session, and the corner stands down while the call is out', { skip: bundleSkip }, async () => {
  const gate = defer()
  const mounted = await mountBuiltPanel({
    record: recordUnstarted(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
    onConsult: ({ door }) => (door === 'route' ? gate.promise : { ok: true, session: 'consult-check-session' }),
  })
  const corner = launchCorner(mounted)
  assert.notEqual(corner, null, 'the standing corner is missing')
  assert.equal(corner.corner.classList.contains('is-open'), false, 'the corner stood unfolded')
  assert.equal(corner.conduct.disabled, false, 'the line door stayed dark with a node still to work')
  assert.equal(corner.route.disabled, false, 'the graph door did not stay pressable')

  /* Fold open: the pin stands the doors up over it. */
  await mounted.act(async () => {
    corner.pin.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(corner.corner.classList.contains('is-open'), true, 'the pin did not unfold the doors')
  /* The doors wear the invocation they open with: what a press sends is readable before the press. */
  assert.equal(corner.route.textContent, '/sw-route', 'the graph door does not name the invocation it opens')
  assert.equal(corner.conduct.textContent, '/sw-conduct', 'the line door does not name the invocation it opens')

  /* The route door answers with the door it named, this session, and the root the selector gave. */
  await mounted.act(async () => {
    corner.route.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(
    mounted.consulted,
    [{ door: 'route', sessionId: 'render-check-session', workspaceRoot: '' }],
    'the press did not reach the host half with the door, this session and the root the selector gave',
  )
  assert.equal(corner.route.disabled, true, 'the doors stayed pressable while the call was out')
  assert.equal(corner.pin.disabled, true, 'the fold stayed pressable while the call was out')
  assert.equal(corner.corner.classList.contains('is-open'), false, 'the corner stayed unfolded after its press')

  await mounted.act(async () => {
    gate.resolve({ ok: true, session: 'consult-check-session' })
    await flush()
  })
  assert.equal(corner.route.disabled, false, 'the doors never came back after the call settled')
  assert.ok(mounted.container.querySelector('.superworker-page > .superworker-innone') === null, 'a landed consult wrote a note line: it has nothing to say')
  assert.equal(mounted.consulted.length, 1, 'one press opened more than one session')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a door press lands the panel in the session it opened, and a refused one navigates nowhere', { skip: bundleSkip }, async () => {
  const went = []
  const mounted = await mountBuiltPanel({
    record: recordUnstarted(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
    /* Each door answers with its own session, so the case can tell which conversation was opened
     * apart from which one was navigated to. */
    onConsult: ({ door }) => ({ ok: true, session: `${door}-session` }),
    openSession: (id) => { went.push(id) },
  })
  const corner = launchCorner(mounted)
  await mounted.act(async () => {
    corner.pin.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  /* Pressing a door is asking to be in that conversation: opening it and going there are one move,
   * and the session the panel lands in is the one that door just opened — not merely some session. */
  await mounted.act(async () => {
    corner.route.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.deepEqual(went, ['route-session'], 'the graph door opened a session and left the reader behind')

  await mounted.act(async () => {
    corner.pin.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  await mounted.act(async () => {
    corner.conduct.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.deepEqual(went, ['route-session', 'conduct-session'], 'the line door opened a session and left the reader behind')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a refused door navigates nowhere: there is no session to be carried into', { skip: bundleSkip }, async () => {
  const went = []
  const mounted = await mountBuiltPanel({
    record: recordUnstarted(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
    onConsult: () => ({ ok: false, code: 'no-session-service', detail: 'agents' }),
    openSession: (id) => { went.push(id) },
  })
  const corner = launchCorner(mounted)
  await mounted.act(async () => {
    corner.pin.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  await mounted.act(async () => {
    corner.route.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  assert.deepEqual(went, [], 'a refused door carried the reader off to a session that was never opened')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a refused door says why on the panel\'s note line', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({
    record: recordUnstarted(),
    sessionsService: fakeSessionsService(),
    useSessions: (select) => select(snapshotOf([])),
    onConsult: () => ({ ok: false, code: 'no-session-service', detail: 'agents' }),
  })
  const corner = launchCorner(mounted)
  await mounted.act(async () => {
    corner.pin.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
  })
  await mounted.act(async () => {
    corner.conduct.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const note = mounted.container.querySelector('.superworker-page > .superworker-innone')
  assert.notEqual(note, null, 'the refusal was swallowed: nothing stands on the panel\'s note line')
  assert.equal(
    note.textContent,
    zh['failure.no-session-service'].replace('{detail}', 'agents'),
    'the refusal does not read as the lookup table\'s sentence for its code',
  )
  assert.equal(corner.conduct.disabled, false, 'the doors stayed down after a refused call')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})
