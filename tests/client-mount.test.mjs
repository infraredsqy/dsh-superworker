/* The two mount points of Pathfinder Center: locks in "which two seats get registered" and "unmount cleans up".
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

const PANEL_ID = 'pathfinder'

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
    title: '寻路中心',
    port: { source: 'none' },
    prefs: {},
    locale,
    Panel,
  }
}

test('两处注册：槽位、id / key、order、侧栏那一行的名字逐条对上', () => {
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
  assert.equal(SEAT_WORD, 'seat.label')
  assert.equal(side.locale, LOCALE_NS)
  const t = localeOf(port).t
  assert.equal(t(SEAT_WORD), '寻路中心', '随包的中文词典里那一行就是这个字')
  assert.equal(side.label(), t(SEAT_WORD), '那一行画出来的应当是词典里的字')
  assert.notEqual(side.label(), SEAT_WORD, '那一行不能把键本身画出来')

  /* A language switch changes what the row says with no re-registration: the label is a function
   * reading the active language, not a word captured at registration time. */
  const service = fakeLocaleService()
  port.attach(service)
  service.switchTo('en')
  assert.equal(side.label(), 'Pathfinder Center')
  assert.equal(side.label(), WORD_TABLES.en[SEAT_WORD])

  const main = ledger.get(`main:${PANEL_ID}`).options
  assert.equal(main.name, 'main')
  assert.equal(main.key, PANEL_ID)
  assert.equal(main.key === 'conversation', false)
  assert.equal(main.locale, LOCALE_NS)

  for (const [, entry] of ledger) assert.equal(typeof entry.component, 'function')
})

test('中央栏那一格交的是这次 apply 装的那块面板，口子、偏好与卡上那一下的去处都是它的', () => {
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

test('那条导航口子还没到场：卡上那一下点下去什么也不发生，这一层不抛', () => {
  const { ledger, ctx } = harness()
  registerSeats(ctx, fakePanel(), () => undefined)

  const given = ledger.get(`main:${PANEL_ID}`).options.inject()
  assert.equal(typeof given.openSession, 'function')
  assert.doesNotThrow(() => { given.openSession('session-7') })
})

test('中央栏那一格另交出那份工作区清单：顶上那枚选择器读的就是它', () => {
  const items = [{ workspaceId: 'w-1', path: 'C:\\ws', title: '一个工作区', sessionIds: ['s-1'] }]
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

test('工作区清单那份服务还没到场：交出去的是一份空名单，它一到场就叫一声', () => {
  const listeners = []
  const items = [{ workspaceId: 'w-1', path: 'C:\\ws', title: '一个工作区', sessionIds: ['s-1'] }]
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

test('同一份空名单：没有工作区清单时每次给出的都是同一个对象', () => {
  const { ledger, ctx } = harness()
  registerSeats(ctx, fakePanel(), () => undefined)

  const source = ledger.get(`main:${PANEL_ID}`).options.inject().workspaces
  assert.equal(source.getSnapshot(), source.getSnapshot())
})

test('收掉那条 effect：两条从名册上撤下来，两张样式标签跟着摘掉', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  globalThis.document = dom.window.document

  const { ledger, effects, ctx } = harness()
  const panel = fakePanel()
  registerSeats(ctx, panel, () => {
    dropStyleTag(PANEL_STYLE_ID)
    dropStyleTag(SETTINGS_STYLE_ID)
  })

  /* The two tags are mounted by the same pair of markers: the real rendering route cannot be resolved in Node. */
  ensureStyleTag(PANEL_STYLE_ID, '.pf-page{color:red}')
  ensureStyleTag(SETTINGS_STYLE_ID, '.pfset-page{color:red}')
  assert.equal(ledger.size, 2)
  assert.equal(dom.window.document.getElementById(PANEL_STYLE_ID) === null, false)
  assert.equal(dom.window.document.getElementById(SETTINGS_STYLE_ID) === null, false)

  const seats = effects.find((one) => one.name === 'dsh-pathfinder: seats')
  assert.equal(seats === undefined, false)
  seats.dispose()

  assert.equal(ledger.size, 0)
  assert.equal(dom.window.document.getElementById(PANEL_STYLE_ID), null)
  assert.equal(dom.window.document.getElementById(SETTINGS_STYLE_ID), null)

  seats.run()
  assert.equal(ledger.size, 2)
})

test('没有 effect 的上下文：两条照样挂上，这一层不往调用点交回清理函数', () => {
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

test('同一本名册上再起一条插件：重复登记那一下停在这一层里，名册还是那两条', () => {
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

test('座席标准 props 里的 useSessions 是一条带投影的 hook，整份快照要靠恒等投影取回来', () => {
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
  assert.equal(snapshot.ids[0], 'other')

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

test('会话名册：宿主清单与本地清单行两处都算数，其余的不许进册', () => {
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

test('切会话那一手：接上导航口子就把身份递过去，没接上就安安静静', () => {
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
    const noisy = createSessionNav({ get: (name) => (name === 'uiWorkspace' ? { openSession: () => { throw new Error('切不动') } } : undefined) })
    assert.doesNotThrow(() => { noisy.open('session-7') })
  } finally {
    console.warn = realWarn
  }
  assert.match(warned.join('\n'), /切不动/u)
})

test('随包的词典键集逐个对得上：少一个键，屏幕上就有一处没换过去', () => {
  const keys = Object.keys(WORD_TABLES.zh).sort()

  assert.deepEqual(
    Object.keys(WORD_TABLES.en).sort(),
    keys,
    '英文词典与中文词典的键必须逐个对得上：多一个、少一个都是一个屏幕上没人填的空',
  )
  assert.deepEqual(Object.keys(WORD_TABLES).sort(), ['en', 'zh'], '随包的语言就是这两份')

  /* Every language carries every key, and carries a word rather than an empty spot. */
  for (const [locale, dict] of Object.entries(WORD_TABLES)) {
    for (const key of keys) assert.equal(typeof dict[key], 'string', `${locale} 词典里缺了 ${key}`)
  }

  /* One key set, two languages: the same key reads differently in the two lookup tables. */
  assert.notEqual(WORD_TABLES.en[SEAT_WORD], WORD_TABLES.zh[SEAT_WORD])
})

test('切换语言：那一行换成另一种语言，订阅者当场收到新读数', () => {
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
  assert.equal(seen.length, 1, '换语言要叫醒订阅者')
  const after = port.getSnapshot()
  assert.equal(seen[0], after)
  assert.notEqual(after, before, '换语言后读数必须是一份新的：useSyncExternalStore 靠这个身份判断要不要重画')
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.active, 'en')
  assert.equal(after.t(SEAT_WORD), 'Pathfinder Center')
  assert.equal(after.t(SEAT_WORD), WORD_TABLES.en[SEAT_WORD], '画出来的那个字要出自词典')
  /* Every key moves with the language, not just the one the row asks for. */
  assert.equal(after.t('view.notes'), 'Instructions')
})

test('没有语言服务在场：这一层说中文，取的是随包那份词典', () => {
  /* The fallback is not a stub: a deployment with no locale service keeps the words the panel had
   * before it could be translated — the mechanism must not change the copy. */
  assert.equal(FALLBACK_LOCALE, 'zh')
  const bare = createLocalePort()
  assert.equal(bare.getSnapshot().active, 'zh', '没接上服务时说的是中文')
  assert.equal(bare.getSnapshot().t(SEAT_WORD), WORD_TABLES.zh[SEAT_WORD])
  assert.equal(bare.getSnapshot().t('view.notes'), '指令')

  /* Handing the service back (`attach(null)`) returns the port to that same fallback. */
  const port = createLocalePort()
  const service = fakeLocaleService()
  port.attach(service)
  service.switchTo('en')
  assert.equal(port.getSnapshot().t(SEAT_WORD), 'Pathfinder Center')
  port.attach(null)
  assert.equal(port.getSnapshot().active, FALLBACK_LOCALE)
  assert.equal(port.getSnapshot().t(SEAT_WORD), '寻路中心')
})