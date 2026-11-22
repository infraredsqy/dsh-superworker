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
import { flush } from './helpers/wait.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

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
