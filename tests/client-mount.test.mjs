/* The two mount points of Superworker Center: locks in "which two seats get registered" and "unmount cleans up".
 *
 * For each seat: the slot name, entry id / key, order, the word the sidebar row shows (looked up
 * through the lookup table, not a literal), and the fact that the central section is handed exactly
 * the panel installed by this apply. When the effect is disposed, both registrations leave the
 * ledger and both injected style tags come off; a second plugin started on the same ledger stops at
 * this layer on the duplicate registration.
 *
 * The language port is measured here too: every shipped lookup table carries the same key set, a
 * language switch changes the words and wakes subscribers, and nothing attached means Chinese.
 *
 * The stand-ins follow the real protocol: registering the same id twice throws. The bodies of the
 * two stylesheets cannot be resolved in Node and cannot enter unit tests, so the tags are mounted
 * here by the same pair of markers and unmount is measured — mount and unmount both key on those
 * two markers.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  PANEL_ORDER,
  SEAT_WORD,
  createSessionNav,
  registerSeats,
} from '../src/client/mount.ts'
/* The session-list projections moved out of the mount file with the readings they answer: they are
 * pure, so they are imported from where they live rather than through the assembly. */
import { currentSessionOf, knownSessionsOf, sessionsSnapshotOf } from '../src/client/sessions-view.ts'
import { FALLBACK_LOCALE, LOCALE_NS, createLocalePort, localeOf } from '../src/client/locale.ts'
import { WORD_TABLES } from '../src/client/locales/index.ts'
import { PANEL_STYLE_ID, SETTINGS_STYLE_ID, dropStyleTag, ensureStyleTag } from '../src/client/style-tags.ts'
import { fakeLocaleService, fakeSlotRoster } from './helpers/dsh-standins.mjs'

const PANEL_ID = 'superworker'

/**
 * A stand-in context: `slots`, `effect`, and `inject` all present, shaped like a real deployment;
 * with `effect: false` the `effect` slot is removed to exercise the "context without effect" path.
 * The slot roster is the shared stand-in; the effects list and its dispose shape stay here.
 */
function harness({ withEffect = true, services = {} } = {}) {
  const { ledger, calls, slots } = fakeSlotRoster()
  const effects = []
  const ctx = {
    get: (name) => (name === 'slots' ? slots : services[name]),
    inject: (names, callback) => callback(ctx),
    provide: () => undefined,
  }
  if (withEffect) {
    ctx.effect = (run, name) => {
      const off = run()
      const dispose = () => { if (typeof off === 'function') off() }
      effects.push({ name, run, dispose })
      return dispose
    }
  }
  return { ledger, calls, effects, ctx }
}

/**
 * A panel: component and port are stand-ins.
 *
 * `locale` is the real port by default — the panel is handed one, and the sidebar row resolves its
 * word through it — so the row's label can be read as a word rather than as a key.
 */
function fakePanel({ locale = createLocalePort() } = {}) {
  const Panel = () => null
  return {
    id: PANEL_ID,
    title: '超级工坊',
    port: { source: 'none' },
    prefs: {},
    locale,
    Panel,
  }
}

test('the two registrations: slot, id / key, order, and the sidebar row name line up item by item', () => {
  const { ledger, ctx } = harness()
  const port = createLocalePort()
  const panel = fakePanel({ locale: port })

  registerSeats(ctx, panel, () => undefined)

  /* The two seats land in different slots, where registration order carries no semantics; this
   * only measures which two are registered, not their relative order. */
  assert.deepEqual([...ledger.keys()].sort(), [
    `main:${PANEL_ID}`,
    `sidebar.panellist:${PANEL_ID}`,
  ].sort())

  const side = ledger.get(`sidebar.panellist:${PANEL_ID}`).options
  assert.equal(side.name, 'sidebar.panellist')
  assert.equal(side.id, PANEL_ID)
  assert.equal(side.order, PANEL_ORDER)
  assert.equal(typeof side.label, 'function')
  /* The row is registered with a KEY, not a word, and marked with the lookup table it speaks; DSH
   * calls `label()` while drawing, so the word is looked up on every frame. */
  assert.equal(side.locale, LOCALE_NS)
  const t = localeOf(port).t
  assert.equal(side.label(), t(SEAT_WORD), 'what the row draws should be the word from the dictionary')
  assert.notEqual(side.label(), SEAT_WORD, 'the row must not draw the key itself')

  /* A language switch changes what the row says with no re-registration: the label is a function
   * reading the active language, not a word captured at registration time. */
  const service = fakeLocaleService()
  port.attach(service)
  service.switchTo('en')
  assert.equal(side.label(), WORD_TABLES.en[SEAT_WORD])

  const main = ledger.get(`main:${PANEL_ID}`).options
  assert.equal(main.name, 'main')
  assert.equal(main.key, PANEL_ID)
  assert.equal(main.key === 'conversation', false)
  assert.equal(main.locale, LOCALE_NS)

  for (const [, entry] of ledger) assert.equal(typeof entry.component, 'function')
})

test('the center-column seat hands the panel this apply installed; the port, prefs and where a card press goes are all its', () => {
  const opened = []
  const { ledger, ctx } = harness({ services: { uiWorkspace: { openSession: (target) => opened.push(target) } } })
  const panel = fakePanel()

  registerSeats(ctx, panel, () => undefined)

  const main = ledger.get(`main:${PANEL_ID}`)
  assert.equal(main.component, panel.Panel)
  const given = main.options.inject()
  /* The panel is handed the language port too: its words are resolved from the same place. */
  assert.deepEqual(
    { port: given.port, prefs: given.prefs, locale: given.locale },
    { port: panel.port, prefs: panel.prefs, locale: panel.locale },
  )
  assert.equal(typeof given.openSession, 'function')
  given.openSession('session-7')
  assert.deepEqual(opened, ['session-7'])
})

test('the navigation seam has not arrived: pressing a card does nothing and this layer does not throw', () => {
  const { ledger, ctx } = harness()
  registerSeats(ctx, fakePanel(), () => undefined)

  const given = ledger.get(`main:${PANEL_ID}`).options.inject()
  assert.equal(typeof given.openSession, 'function')
  assert.doesNotThrow(() => { given.openSession('session-7') })
})

test('the center-column seat also hands out the workspace list: the selector on top reads it', () => {
  const items = [{ workspaceId: 'w-1', path: 'C:\\ws', title: 'a workspace', sessionIds: ['s-1'] }]
  const snapshot = { items }
  const { ledger, ctx } = harness({
    services: { workspaces: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } } },
  })
  registerSeats(ctx, fakePanel(), () => undefined)

  const given = ledger.get(`main:${PANEL_ID}`).options.inject()
  assert.equal(typeof given.workspaces?.getSnapshot, 'function')
  assert.equal(typeof given.workspaces?.subscribe, 'function')
  assert.deepEqual(given.workspaces.getSnapshot().items, items)
})

test('the workspace-list service has not arrived: the empty list is handed out, and subscribers are told once it shows up', () => {
  const listeners = []
  const items = [{ workspaceId: 'w-1', path: 'C:\\ws', title: 'a workspace', sessionIds: ['s-1'] }]
  let registered
  const { ledger, ctx } = harness()
  /* Measures the "service arrives late" route: hand out the empty list first, notify subscribers once it shows up. */
  ctx.inject = (names, callback) => {
    if (names.includes('workspaces')) registered = callback
    else callback(ctx)
  }
  registerSeats(ctx, fakePanel(), () => undefined)

  const source = ledger.get(`main:${PANEL_ID}`).options.inject().workspaces
  assert.deepEqual(source.getSnapshot(), { items: [] })
  source.subscribe(() => listeners.push('changed'))
  assert.deepEqual(listeners, [])

  const snapshot = { items }
  registered({ get: (name) => (name === 'workspaces' ? { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } } : undefined) })
  assert.deepEqual(source.getSnapshot().items, items)
  assert.deepEqual(listeners, ['changed'])
})

test('the same empty list: with no workspace list, every hand-out is the same object', () => {
  const { ledger, ctx } = harness()
  registerSeats(ctx, fakePanel(), () => undefined)

  const source = ledger.get(`main:${PANEL_ID}`).options.inject().workspaces
  assert.equal(source.getSnapshot(), source.getSnapshot())
})

test('disposing the effect: both seats come off the ledger and both style tags are dropped', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  globalThis.document = dom.window.document

  const { ledger, effects, ctx } = harness()
  const panel = fakePanel()
  registerSeats(ctx, panel, () => {
    dropStyleTag(PANEL_STYLE_ID)
    dropStyleTag(SETTINGS_STYLE_ID)
  })

  /* The two tags are mounted by the same pair of markers: the real rendering route cannot be resolved in Node. */
  ensureStyleTag(PANEL_STYLE_ID, '.superworker-page{color:red}')
  ensureStyleTag(SETTINGS_STYLE_ID, '.superworker-settings-page{color:red}')
  assert.equal(ledger.size, 2)
  assert.equal(dom.window.document.getElementById(PANEL_STYLE_ID) === null, false)
  assert.equal(dom.window.document.getElementById(SETTINGS_STYLE_ID) === null, false)

  const seats = effects.find((one) => one.name === 'dsh-superworker: seats')
  assert.equal(seats === undefined, false)
  seats.dispose()

  assert.equal(ledger.size, 0)
  assert.equal(dom.window.document.getElementById(PANEL_STYLE_ID), null)
  assert.equal(dom.window.document.getElementById(SETTINGS_STYLE_ID), null)

  seats.run()
  assert.equal(ledger.size, 2)
})

test('a context without effect: both seats still register, and this layer hands no clean-up function back', () => {
  const { ledger, effects, ctx } = harness({ withEffect: false })
  const panel = fakePanel()
  let stylesDropped = 0
  const handedBack = registerSeats(ctx, panel, () => { stylesDropped += 1 })

  assert.equal(effects.length, 0)
  assert.equal(ledger.size, 2)

  /* This context carries no unmount notification: real Cordis contexts all have `effect`. */
  assert.equal(handedBack, undefined)
  assert.equal(stylesDropped, 0)
})

test('a second plugin on the same ledger: the duplicate registration stops at this layer, the ledger still holds those two', () => {
  const { ledger, calls, effects, ctx } = harness()
  const panel = fakePanel()

  /* The throw from the duplicate registration is caught at this layer, not swallowed: one warning each. */
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  try {
    registerSeats(ctx, panel, () => undefined)
    registerSeats(ctx, panel, () => undefined)
  } finally {
    console.warn = realWarn
  }

  assert.equal(ledger.size, 2)
  assert.equal(calls.filter((call) => call.startsWith('register/')).length, 4)
  assert.equal(effects.length, 2)
  assert.equal(warned.length, 2)

  /* The second plugin's effect holds nothing to dispose: it registered nothing, so disposing it must not touch the ledger. */
  effects[1].dispose()
  assert.equal(ledger.size, 2)
})

test('the seat props\' useSessions is a hook with a projection, the whole snapshot comes back through an identity projection', () => {
  /* Real shape: `ids` is the host's list order, the current session in `byId` carries
   * `retainedBy.mainView`, and the first row of the list is a different session (secondary
   * sessions also enter `byId`; they just do not carry mainView). */
  const snapshot = {
    ids: ['other', 's1'],
    byId: {
      other: { id: 'other', retainedBy: {} },
      s1: { id: 's1', retainedBy: { mainView: 1 } },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const seen = []
  const useSessions = (select) => { seen.push(select); return select(snapshot) }

  assert.deepEqual(sessionsSnapshotOf(useSessions), snapshot)
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0], 'function')

  /* Picks the entry carrying `mainView`: still picked even though it sits second in `ids`. */
  assert.equal(currentSessionOf(snapshot), 's1')

  /* With nobody carrying `mainView`, picking by `byId` key order would pick wrong. */
  assert.equal(currentSessionOf({ ids: [], byId: { z: { id: 'z', retainedBy: {} } }, phase: 'ready' }), undefined)

  /* The three identity probes still exist in other shapes: when present, they win first. */
  assert.equal(currentSessionOf({ ...snapshot, selectedId: 'picked' }), 'picked')

  /* With none of the three and no `mainView`, fall through to the `ids[0]` last resort. */
  const noMainView = { ids: ['first'], byId: { first: { id: 'first', retainedBy: {} } }, phase: 'ready' }
  assert.equal(currentSessionOf(noMainView), 'first')

  /* Without this hook on this deployment, both are undefined; throwing is not allowed. */
  assert.equal(sessionsSnapshotOf(undefined), undefined)
  assert.equal(currentSessionOf(undefined), undefined)
})

test('the session roster: both the host list and local list rows count, nothing else gets in', () => {
  const snapshot = {
    ids: ['s1', '', 's2'],
    byId: {
      s2: { id: 's2', retainedBy: {} },
      s3: { id: 's3', retainedBy: { mainView: 1 } },
      '': { id: '', retainedBy: {} },
    },
    phase: 'ready',
  }

  assert.deepEqual([...knownSessionsOf(snapshot)].sort(), ['s1', 's2', 's3'])
  /* An empty identity never enters the roster: when a record's session is the empty string, the card still has nowhere to go. */
  assert.equal(knownSessionsOf(snapshot).has(''), false)
  /* An unreadable snapshot, or a malformed `ids` / `byId` shape, yields an empty roster. */
  assert.deepEqual([...knownSessionsOf(undefined)], [])
  assert.deepEqual([...knownSessionsOf({ ids: 's1', byId: null })], [])
})

test('the session switch: with the navigation seam attached the identity is passed on, without it nothing happens', () => {
  const opened = []
  const nav = createSessionNav({
    get: (name) => (name === 'uiWorkspace' ? { openSession: (target) => opened.push(target) } : undefined),
  })
  nav.open('session-7')
  assert.deepEqual(opened, ['session-7'])

  /* The port arrives a layer late: this layer waits for it on `inject`. */
  const late = []
  let arrived
  const waiting = createSessionNav({
    get: () => undefined,
    inject: (names, callback) => { arrived = () => callback({ get: (name) => (name === 'uiWorkspace' ? { openSession: (target) => late.push(target) } : undefined) }) },
  })
  waiting.open('session-early')
  assert.deepEqual(late, [])
  arrived()
  waiting.open('session-late')
  assert.deepEqual(late, ['session-late'])

  /* The port's own call throws: stopped at this layer, not propagated upward. */
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => { warned.push(args.map(String).join(' ')) }
  try {
    const noisy = createSessionNav({ get: (name) => (name === 'uiWorkspace' ? { openSession: () => { throw new Error('cannot switch') } } : undefined) })
    assert.doesNotThrow(() => { noisy.open('session-7') })
  } finally {
    console.warn = realWarn
  }
  assert.match(warned.join('\n'), /cannot switch/u)
})

test('the bundled dictionary key sets line up: one key missing leaves one spot on screen untranslated', () => {
  const keys = Object.keys(WORD_TABLES.zh).sort()

  assert.deepEqual(
    Object.keys(WORD_TABLES.en).sort(),
    keys,
    'the English and Chinese dictionaries must line up key by key: one more or one less leaves an empty spot on screen',
  )
  assert.deepEqual(Object.keys(WORD_TABLES).sort(), ['en', 'zh'], 'the bundled languages are exactly these two')

  /* Every language carries every key, and carries a word rather than an empty spot. */
  for (const [locale, dict] of Object.entries(WORD_TABLES)) {
    for (const key of keys) assert.equal(typeof dict[key], 'string', `${locale} dictionary is missing ${key}`)
  }

  /* One key set, two languages: the same key reads differently in the two lookup tables. */
  assert.notEqual(WORD_TABLES.en[SEAT_WORD], WORD_TABLES.zh[SEAT_WORD])
})

test('switching language: the row changes to the other language and subscribers get the new reading at once', () => {
  const port = createLocalePort()
  const service = fakeLocaleService()
  port.attach(service)

  /* Attached with Chinese active: the same word the fallback would have said. */
  assert.equal(port.getSnapshot().active, 'zh')
  assert.equal(port.getSnapshot().t(SEAT_WORD), WORD_TABLES.zh[SEAT_WORD])

  const before = port.getSnapshot()
  const seen = []
  port.subscribe(() => seen.push(port.getSnapshot()))

  service.switchTo('en')

  /* A language switch must wake subscribers, or the panel keeps drawing the old language. */
  assert.equal(seen.length, 1, 'a language switch must wake subscribers')
  const after = port.getSnapshot()
  assert.equal(seen[0], after)
  assert.notEqual(after, before, 'a language switch must yield a new reading: useSyncExternalStore uses that identity to decide whether to redraw')
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.active, 'en')
  assert.equal(after.t(SEAT_WORD), WORD_TABLES.en[SEAT_WORD], 'the word drawn must come from the dictionary')
})

test('with no locale service present: this layer speaks Chinese from the bundled dictionary', () => {
  /* The fallback is not a stub: a deployment with no locale service keeps the words the panel had
   * before it could be translated — the mechanism must not change the copy. */
  assert.equal(FALLBACK_LOCALE, 'zh')
  const bare = createLocalePort()
  assert.equal(bare.getSnapshot().active, 'zh', 'with no service attached it speaks Chinese')
  assert.equal(bare.getSnapshot().t(SEAT_WORD), WORD_TABLES.zh[SEAT_WORD])

  /* Handing the service back (`attach(null)`) returns the port to that same fallback. */
  const port = createLocalePort()
  const service = fakeLocaleService()
  port.attach(service)
  service.switchTo('en')
  assert.equal(port.getSnapshot().t(SEAT_WORD), 'Superworker Center')
  port.attach(null)
  assert.equal(port.getSnapshot().active, FALLBACK_LOCALE)
})