/* The overview's presses, over the built panel: what a press opens, and what it must leave alone.
 *
 * The session list arrives the way the seat hands it over, each session's events through a stand-in
 * for DSH's `sessions` service, and the navigation gateway is the one the seat passes down. What the
 * cases hold down: a press on the main window opens its own conversation, a press on a child opens
 * that child's, and a tap a touch can make is one press with nothing taking the gesture; the rail
 * switches the drawn step and never draws two; the standing corner opens a door's session once,
 * lands the reader in the session it just opened, and stands down while the call is out — while a
 * refused door leaves the reader where they are; and a window whose conversation this machine cannot
 * open stays the drawing it was, as does every window on a host with no gateway at all.
 *
 * The drawing itself — the boxes, the motion marks, the tails — is on the hand pass, not here.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/client-overview.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'
import { flush, until } from './helpers/wait.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/**
 * Wait through a mark's span the way the reader lives it: the shed timer fires in real time and the
 * draw it asks for lands. While it happens the flag that names this a test-only act environment
 * stands down — an update the pane's own timer schedules is production work, not an act, and the
 * act queue would otherwise hold the shed's render behind the wait (the shed never reaches the
 * drawing inside one).
 */
const across = async (mounted, check, what) => {
  const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  try {
    await until(check, what)
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
  }
}

/** The record: one node, one line, and the note that names m1 as that node's session. */
const record = () => ({
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
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

/** The session-list snapshot, in the shape the seat's `useSessions` hook hands over. `mainRunning` is
 * the reader's own conversation's bit: a scene read after the line has stopped says false. A child
 * may carry DSH's own `projections` for it — the `subagent` identity a dispatch writes — which is
 * the field the reading takes a seat's name from. */
const snapshotOf = (children, mainRunning = true) => ({
  ids: ['m1', ...children.map((one) => one.id)],
  byId: {
    m1: { id: 'm1', running: mainRunning, retainedBy: { mainView: 1 }, displayTitle: 'the main conversation' },
    ...Object.fromEntries(children.map((one) => [
      one.id,
      {
        id: one.id,
        running: one.running,
        parentId: 'm1',
        displayTitle: one.title,
        ...(one.projections === undefined ? {} : { projectionValues: one.projections }),
      },
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
const read = (path, time) => ({ type: 'tool/call', time, data: { name: 'read', callId: `r${time}`, arguments: JSON.stringify({ file_path: path }) } })

/** The stage the pane measures: jsdom has no layout engine, so the box is pinned per case. */
const stageAt = (mounted, width, height) => {
  const body = mounted.container.querySelector('.superworker-overview')
  Object.defineProperty(body, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(body, 'clientHeight', { value: height, configurable: true })
  return mounted.rerender()
}

/** The record a ghost comes from: the panel's own node delivered, and a second node the line is still
 * holding, whose launch cell was written and whose note names a session that is not running any more.
 * The debt is on the record; only the leg's conversation is gone. */
const recordOfADeadLeg = () => ({
  ...record(),
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        tags: [],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-08T00:00:00.000Z',
        completed_at: '2026-01-09T00:00:00.000Z',
        dependencies: [],
      },
      n1: {
        title: 'the leg that died',
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

/* ------------------------------------------------------------------ the timed marks: armed on the beat, shed at the span */

/* The motion marks are the panel's own invariants — each one arms on the beat its fact lands and
 * sheds when its span has run — so their moments are pinned here, in real clock time. What the
 * cases hold is the arming and the shedding, never what the drawing looks like. */

test('a fresh row wears its mark on the beat it lands, and sheds when the fresh span has run', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100)])
  service.set('c1', [read('a.ts', 300)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the growing child' }])),
  })
  try {
    await stageAt(mounted, 1024, 720)
    /* The rows the first beat drew with are the window's first sight of itself: none of them is new. */
    assert.equal(container(mounted).querySelector('.superworker-orow.is-fresh'), null, 'a row the window first saw wore the fresh mark')

    await mounted.act(async () => {
      service.set('c1', [read('a.ts', 300), read('b.ts', 400)])
    })
    await across(mounted, () => container(mounted).querySelector('.superworker-orow.is-fresh') !== null, 'the landed row to wear its fresh mark')
    const fresh = container(mounted).querySelector('.superworker-orow.is-fresh')
    assert.ok(fresh.className.includes('is-read'), 'the fresh mark stood on a row other than the one that landed')

    await across(mounted, () => container(mounted).querySelector('.superworker-orow.is-fresh') === null, 'the fresh mark to shed when its span had run')
  } finally {
    await mounted.unmount()
  }
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a leaving pane folds for the leave span, then the room closes up and settles back', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('c1', [read('a.ts', 300)])
  let snap = snapshotOf([{ id: 'c1', running: true, title: 'the finishing child' }])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  try {
    await stageAt(mounted, 1024, 720)
    const field = () => container(mounted).querySelector('.superworker-ofield')

    snap = snapshotOf([])
    await mounted.rerender()
    const leaving = container(mounted).querySelector('[data-window="c1"]')
    assert.notEqual(leaving, null, 'the leaving pane left the page before its leave ran')
    assert.ok(leaving.className.includes('is-leave'), 'the leaving pane carries no leave mark')

    /* The fold runs its span before the page loses the pane, and the room closing up is raised in the
     * same breath as the loss — the render that drops the pane is the render that carries the settle. */
    await across(mounted, () => container(mounted).querySelector('[data-window="c1"]') === null, 'the folded pane to leave the page when its span had run')
    assert.ok(field().className.includes('is-settle'), 'the room did not close up in the breath that lost the pane')
    await across(mounted, () => !field().className.includes('is-settle'), 'the settle mark to shed when its span had run')
  } finally {
    await mounted.unmount()
  }
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the stage\u2019s own arrival wears the entrance mark for the entrance span, then sheds it', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 1000)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
  })
  try {
    /* The unmeasured stage draws nothing; the beat that first draws the windows at their real boxes
     * is the stage's own arrival, and it is the one render the entrance mark arms on. */
    assert.equal(container(mounted).querySelector('.superworker-ofield.is-first'), null, 'an unmeasured stage wore the entrance mark')
    await stageAt(mounted, 1024, 720)
    const field = () => container(mounted).querySelector('.superworker-ofield')
    assert.ok(field().className.includes('is-first'), 'the stage\u2019s own arrival carried no entrance mark')

    await across(mounted, () => !field().className.includes('is-first'), 'the entrance mark to shed when the entrance span had run')
  } finally {
    await mounted.unmount()
  }
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a hand-over folds the page it handed on from and arrives by its own appearance, both shedding at their spans', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('this conversation dispatched the next step.', 100)])
  service.set('c1', [read('a.ts', 200)])
  /* The page the reader stands on is a step the record delivered: held, its conversation stopped.
   * The line's next step is on the table but not yet being worked. */
  let snap = { ids: ['m1'], byId: { m1: { id: 'm1', running: false, displayTitle: 'the finished step' } } }
  const mounted = await mountBuiltPanel({
    record: recordWithARunningLeg(),
    sessionsService: service,
    useSessions: (select) => select(snap),
    sessionId: 'm1',
  })
  try {
    await stageAt(mounted, 1024, 720)
    const field = () => container(mounted).querySelector('.superworker-ofield')
    const stageIs = (id) => container(mounted).querySelector(`[data-window="${id}"]`)

    /* The step the line handed on to is being worked now: the stage follows it, the old page folds in
     * the boxes it last drew in, and the new page arrives by the stage's own appearance. */
    snap = { ids: ['m1', 'c1'], byId: { m1: { id: 'm1', running: false, displayTitle: 'the finished step' }, c1: { id: 'c1', running: true, parentId: 'm1', displayTitle: 'the second step' } } }
    await mounted.rerender()
    const pastPane = stageIs('m1')
    assert.notEqual(pastPane, null, 'the page being closed left the stage before its fold ran')
    assert.ok(pastPane.className.includes('is-leave'), 'the page the line handed on from carries no fold mark')
    const page = stageIs('c1')
    assert.notEqual(page, null, 'the step being worked did not take the stage')
    assert.ok(page.className.includes('is-main'), 'the step being worked was drawn as a child of the step it replaced')
    assert.ok(field().className.includes('is-first'), 'the hand-over did not arrive by the stage\u2019s own appearance')

    await across(mounted, () => !field().className.includes('is-first'), 'the hand-over\u2019s entrance mark to shed when the entrance span had run')
    await across(mounted, () => stageIs('m1') === null, 'the folded page to leave the stage when the leave span had run')
  } finally {
    await mounted.unmount()
  }
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('an opening window wears the growth mark from its first beat, and sheds it when the growth span has run', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100)])
  service.set('c1', [read('a.ts', 300)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([{ id: 'c1', running: true, title: 'the opening child' }])),
  })
  try {
    await stageAt(mounted, 1024, 720)
    /* The window's first box is provisional: the mark is on from the very beat the window stands. */
    const opening = container(mounted).querySelector('[data-window="c1"]')
    assert.notEqual(opening, null, 'the running child is not drawn')
    assert.ok(opening.className.includes('is-grow'), 'the opening window carried no growth mark')

    /* The growth is spent once: rows landed with the window, so the span ends one breath past the
     * growth itself — no row arrives again, and the mark does not wait past its own deadline. */
    await across(mounted, () => !container(mounted).querySelector('[data-window="c1"]').className.includes('is-grow'), 'the growth mark to shed when the growth span had run')
  } finally {
    await mounted.unmount()
  }
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a joining window holds the field\u2019s join mark for the entrance span, then sheds it', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100)])
  service.set('c1', [read('a.ts', 300)])
  let snap = snapshotOf([])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snap),
  })
  try {
    await stageAt(mounted, 1024, 720)
    const field = () => container(mounted).querySelector('.superworker-ofield')

    snap = snapshotOf([{ id: 'c1', running: true, title: 'the joining child' }])
    await mounted.rerender()
    assert.notEqual(container(mounted).querySelector('[data-window="c1"]'), null, 'the joining child did not take the stage')
    assert.ok(field().className.includes('is-join'), 'the beat that seated a joiner carried no join mark')

    await across(mounted, () => !field().className.includes('is-join'), 'the join mark to shed when the entrance span had run')
  } finally {
    await mounted.unmount()
  }
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
  assert.ok(main.className.includes('is-run'), 'the running window does not wear the running frame the map gives its card')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

/* The frame is the state's own drawing on both pages: a window at rest whose work the record
 * delivered wears the same done frame the map's card wears, and not the running one. */
test('a delivered window at rest wears the done frame, not the running one', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('done.', 1000)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([], false)),
  })
  await stageAt(mounted, 1024, 720)
  const main = container(mounted).querySelector('[data-window="m1"]')
  assert.notEqual(main, null, 'the delivered window is not drawn')
  assert.ok(main.className.includes('is-done'), 'the delivered window does not wear the done frame')
  assert.ok(!main.className.includes('is-run'), 'the delivered window still wears the running frame')
  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

/* ------------------------------------------------------------------ the standing corner: a door opens its own session */

/** The same record with no session note at all: the nodes no conversation has run. */
const recordWithoutNotes = () => {
  const full = record()
  delete full['.superworker/meta/sessions/n0.json']
  return full
}

/** The record with its one node back at the start: never run, never delivered — workable. */
const recordUnstarted = () => ({
  ...recordWithoutNotes(),
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        tags: [],
        mode: 'auto',
        status: 'todo',
        created_at: '2026-01-08T00:00:00.000Z',
        dependencies: [],
      },
    },
  }),
})

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

/* ------------------------------------------------------------------ the double render: a drawing that reads nothing it wrote */

/* The stage's motion facts live in state and the registry, and the render only reads them: in
 * development React draws every component twice (StrictMode), so a render that wrote what it read
 * would answer its own second pass with the first pass's notes — the arrival beat would find
 * itself already arrived and commit without its entrance mark. The panel is mounted here the way
 * the seat mounts it, wrapped in StrictMode, and the marks are read on the very commits they
 * belong to. */
test('under StrictMode the beat marks stand on their own first commit: the double render reads nothing the first pass wrote', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  service.set('m1', [said('start.', 100)])
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshotOf([])),
    sessionId: 'm1',
  })
  const { React, act, window, panel } = mounted
  const { createRoot } = await import('react-dom/client')
  const holder = window.document.createElement('div')
  window.document.body.appendChild(holder)
  const root = createRoot(holder)
  /* No `windows` on this root: the session-event windows are one forwarding instance per plugin
   * (`apply` made it), and a second panel that `watch`es it would fight the first over which
   * windows are held — each watch releases the other's ids, and the reading would flip forever.
   * The marks this case reads are window-set facts, not rows, so the strict root draws without
   * them and the two roots never touch the same holds. */
  const draw = async (snap) => {
    await act(async () => {
      root.render(React.createElement(
        React.StrictMode,
        null,
        React.createElement(panel.Panel, {
          port: panel.port,
          sessionId: 'm1',
          prefs: panel.prefs,
          useSessions: (select) => select(snap),
        }),
      ))
    })
  }
  try {
    const field = () => holder.querySelector('.superworker-ofield')
    const pane = (id) => holder.querySelector(`[data-window="${id}"]`)

    await draw(snapshotOf([]))
    /* The stage is measured on its own root, the way `stageAt` measures the seat's mount: jsdom has
     * no layout engine, so the box is pinned per draw. */
    const bodyEl = holder.querySelector('.superworker-overview')
    Object.defineProperty(bodyEl, 'clientWidth', { value: 1024, configurable: true })
    Object.defineProperty(bodyEl, 'clientHeight', { value: 720, configurable: true })
    await draw(snapshotOf([]))

    /* The stage's own arrival is the commit that first draws the windows at their real boxes, and
     * the entrance mark stands on that very commit — the double render must not read the first
     * pass's note and find the stage already arrived. */
    assert.ok(field().className.includes('is-first'), 'the stage’s arrival mark missed its own first commit under the double render')
    assert.ok(pane('m1') !== null && pane('m1').className.includes('is-grow'), 'the opening window carried no growth mark on its first beat')

    /* A joiner seated on a later beat: the join mark is on the field in the same breath, read off
     * the previous beat's held ids — a fact the render only reads, twice, the same way. */
    const join = snapshotOf([{ id: 'c1', running: true, title: 'the joining child' }])
    await draw(join)
    assert.ok(field().className.includes('is-join'), 'the beat that seated a joiner carried no join mark under the double render')
    assert.ok(pane('c1') !== null && pane('c1').className.includes('is-grow'), 'the joining window carried no growth mark on its first beat')

    /* Drawing the same beat again draws the same stage: the render is a read, not a diary. */
    const held = field().className
    await draw(join)
    assert.equal(field().className, held, 'a second draw of the same beat drew another stage')

    await across(mounted, () => !field().className.includes('is-join'), 'the join mark to shed when the entrance span had run')
    await across(mounted, () => !field().className.includes('is-first'), 'the arrival mark to shed when the entrance span had run')
  } finally {
    await act(async () => { root.unmount() })
    holder.remove()
    await mounted.unmount()
  }
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})
