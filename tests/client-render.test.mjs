/* The built browser half, mounted on its own: the artifact the package ships is handed to the shell,
 * boots onto a roster, draws itself, walks every pane, and leaves the console clean.
 *
 * The record comes from the in-memory port stand-in, so this file needs no `.pf` directory on disk,
 * no `pf` command and no fixture of its own: the panel reads through a port. What the panel *says*
 * about a record is deliberately not measured here — the copy and the layout move far more often
 * than the three things below, and a test pinning them costs an edit per change; the readings that
 * do need a record are walked by hand.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/` without that build and
 * this file skips itself, saying so.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { fakeSettingsForm, fakeSlotRoster } from './helpers/dsh-standins.mjs'
import { fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(root, 'lib', 'client.js')

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** A record with something in every one of the four sources: the panes draw content rather than an empty state. */
const record = () => ({
  '.pf/ideas.json': json({
    nodes: {
      n1: {
        title: '第一个节点',
        description: '一件做完的事',
        tags: ['t0'],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-02T00:00:00.000Z',
        dependencies: [],
      },
      n2: {
        title: '第二个节点',
        tags: [],
        mode: 'manual',
        status: 'todo',
        created_at: '2026-01-04T00:00:00.000Z',
        dependencies: ['n1'],
      },
      n3: {
        title: '搁置的一个',
        tags: ['t0'],
        mode: 'auto',
        status: 'shelved',
        created_at: '2026-01-05T00:00:00.000Z',
        dependencies: ['n1'],
      },
    },
  }),
  '.pf/state.json': json({
    cycles: [
      {
        id: 'c1',
        title: '一条线',
        status: 'active',
        tags: ['main'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-06T00:00:00.000Z',
        policies: { issue_pool_weight_limit: 8 },
        holding: [{ id: 'n2', since: '2026-01-06T00:00:00.000Z' }],
        path: [
          { node: 'n1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-02T00:00:00.000Z', result: 'delivered' },
        ],
      },
    ],
  }),
  '.pf/instructions.json': json({
    instructions: [
      { id: 'i1', text: '用户说过的一句话', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, at: '2026-01-07T00:00:00.000Z', resolved_at: null, note: '一条备注' },
      { id: 'i2', text: '收回去了的一句', scope: 'cycle', target: 'stage', state: 'archived', cycle: 'c1', node: null, at: '2026-01-03T00:00:00.000Z', resolved_at: '2026-01-08T00:00:00.000Z', note: null },
    ],
  }),
  '.pf/issues/issues.json': json({
    version: 1,
    issues: {
      p1: {
        id: 'p1',
        title: '一处毛病',
        severity: 'P1',
        status: 'open',
        module: 'mod-a',
        source: 'review',
        decision: 'fix',
        discovered: '2026-01-08T00:00:00.000Z',
        updated_at: '2026-01-09T00:00:00.000Z',
        check_count: 2,
        files: ['a.ts'],
        description: '哪里不对',
        suggestion: '该怎么办',
      },
    },
  }),
})

const skipReason = existsSync(BUNDLE) ? false : `${BUNDLE} 不在：先跑 npm run bundle:client（npm test 会自己先跑一遍）`

test('这一份产物：外壳装得上、画得出来、每一格都走得通，控制台一路干净', { skip: skipReason }, async () => {
  /* React touches window/document once at load time, so jsdom has to be in place before anything else. */
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const globals = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'SVGElement', 'requestAnimationFrame', 'cancelAnimationFrame']
  for (const name of globals) Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
  /* `navigator` is a getter-only property on Node, so its descriptor is written separately. */
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  /* Every `console.error` is a failure: this is the one reading a smoke test can take without pinning copy. */
  const consoleErrors = []
  const realError = console.error
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); realError(...args) }

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = React

  /* ---- what the shell gets: one spec, then a factory ---- */
  let loaded = null
  window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
  await import(pathToFileURL(BUNDLE).href)
  assert.equal(loaded?.id, 'dsh-pathfinder', '外壳按 id 认这一份')
  const client = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`这个模块表上没有 ${name}`)
  })
  assert.equal(typeof client.apply, 'function', '这一份导出了 apply')

  /* ---- the host half behind it, read through the in-memory port ---- */
  const { PathfinderRecordsGateway } = await import(pathToFileURL(join(root, 'src', 'host', 'index.ts')).href)
  const workspaceRoot = 'C:\\workspace-for-the-render-check'
  const gateway = new PathfinderRecordsGateway({
    workspaceFiles: fakeWorkspaceFiles(record()),
    /* The real host resolves a session's workspace from its header's cwd. */
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    /* No further services on this stand-in: every reading the panel asks for above answers from the
     * workspace-files port, and a service that is missing is a reading the panel has words for
     * rather than an error. */
    get: () => undefined,
    provide: () => undefined,
  })

  /** The face the generated remote client would hand out: every call answers `{ ok, value }`. */
  const asked = []
  const wrapped = (run) => async (...values) => {
    try {
      return { ok: true, value: await run(...values) }
    } catch (error) {
      return { ok: false, error: { code: 'render-check', message: String(error) } }
    }
  }
  const remoteFace = {
    read: wrapped((...values) => { asked.push('read'); return gateway.read(...values) }),
    readSessions: wrapped((...values) => gateway.readSessions(...values)),
    readConfig: wrapped((...values) => gateway.readConfig(...values)),
  }

  /* ---- boot the plugin the way the shell does ---- */
  const { ledger, slots } = fakeSlotRoster()
  const provided = {}
  const form = fakeSettingsForm({}, { watchCount: true })
  const services = {
    'remote.pathfinder': remoteFace,
    slots,
    configForms: { get: () => form },
    uiWorkspace: { openSession: () => undefined },
  }
  const ctx = {
    get: (name) => services[name],
    inject: (_names, callback) => callback(ctx),
    effect: (run, name) => {
      const off = run()
      const dispose = () => { if (typeof off === 'function') off() }
      ctx.effects.push({ name, dispose })
      return dispose
    },
    effects: [],
    provide: (key, value) => { provided[key] = value },
  }
  client.apply(ctx)

  const panel = provided[client.SERVICE_KEY]
  assert.equal(panel?.id, 'pathfinder', '面板装成了一条服务')
  assert.equal(ledger.size, 3, `这一层登记三条：${[...ledger.keys()].join(', ')}`)

  /* ---- mount it, and let every read it starts land before judging ---- */
  const container = window.document.getElementById('app')
  const reactRoot = createRoot(container)
  const inFlight = []
  const track = (promise) => { inFlight.push(promise.catch(() => undefined)); return promise }
  const port = {
    ...panel.port,
    read: (id, root, signal) => track(panel.port.read(id, root, signal)),
    readSessions: (id, root, signal) => track(panel.port.readSessions(id, root, signal)),
  }
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      const pending = inFlight.splice(0)
      if (pending.length === 0) return
      await act(async () => { await Promise.all(pending) })
    }
  }

  await act(async () => {
    reactRoot.render(React.createElement(panel.Panel, { port, sessionId: 'render-check-session', prefs: panel.prefs }))
  })
  await settle()

  assert.notEqual(container.querySelector('.pf-page'), null, '画出了面板那一页')
  assert.ok((container.textContent ?? '').length > 0, '面板上有字')
  assert.ok(asked.length > 0, '它向宿主半身要了记录')

  /* Every pane its tabs point at: press each one, and the thing it says it controls has to be there
   * and to be the shown one. The tab set is read off the panel, so a pane added or dropped later
   * moves both sides together. */
  const tabs = [...container.querySelectorAll('.pf-tab')]
  assert.ok(tabs.length > 0, '标签栏画出来了')
  for (const tab of tabs) {
    await act(async () => { tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
    const pane = container.querySelector(`#${String(tab.getAttribute('aria-controls'))}`)
    assert.notEqual(pane, null, `「${tab.textContent}」那一格不在`)
    assert.equal(tab.getAttribute('aria-selected'), 'true', `「${tab.textContent}」按下去没选中`)
  }

  /* The map answers a finger as it answers the pointer: a touch drag carries the drawing and holds
   * the gesture — the touchmove is prevented, which is what keeps iPad Safari from handing the same
   * finger to its own scroll and cancelling the pan a few moves in. A tap sends no touchmove, so
   * pressing a card stays a press; that road is walked by hand on a real touch screen. */
  const mapTab = tabs.find((tab) => tab.getAttribute('aria-controls') === 'pane-map')
  assert.notEqual(mapTab, undefined, '地图那一格不在标签栏上')
  await act(async () => { mapTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const field = container.querySelector('.pf-field')
  const canvas = container.querySelector('.pf-canvas')
  assert.notEqual(field, null, '地图的画布区不在')
  assert.notEqual(canvas, null, '地图的画布不在')
  const cameraBefore = canvas.style.transform
  const touchAt = (type, x, y) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    const at = { identifier: 7, clientX: x, clientY: y }
    Object.defineProperty(event, 'touches', { value: [at] })
    Object.defineProperty(event, 'changedTouches', { value: [at] })
    return event
  }
  let gestureHeld
  await act(async () => {
    field.dispatchEvent(touchAt('touchstart', 40, 40))
    gestureHeld = field.dispatchEvent(touchAt('touchmove', 160, 40))
    field.dispatchEvent(touchAt('touchend', 160, 40))
  })
  assert.equal(gestureHeld, false, 'touchmove 没被拦下（preventDefault 没调）：浏览器的手势会半路夺走这根手指')
  assert.notEqual(canvas.style.transform, cameraBefore, '触摸拖了一下，画布没动')

  /* Two fingers spread: the camera scales around the fingers' midpoint and rides the midpoint's own
   * travel — the wheel's arithmetic carried by the touch road. */
  const pinchAt = (type, a, b) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    const at = (identifier, [x, y]) => ({ identifier, clientX: x, clientY: y })
    Object.defineProperty(event, 'touches', { value: [at(3, a), at(4, b)] })
    Object.defineProperty(event, 'changedTouches', { value: type === 'touchmove' ? [] : [at(3, a), at(4, b)] })
    return event
  }
  const cameraPinched = canvas.style.transform
  let spreadHeld
  await act(async () => {
    field.dispatchEvent(pinchAt('touchstart', [200, 200], [280, 200]))
    spreadHeld = field.dispatchEvent(pinchAt('touchmove', [160, 200], [320, 200]))
    field.dispatchEvent(pinchAt('touchend', [160, 200], [320, 200]))
  })
  assert.equal(spreadHeld, false, '捏合的 touchmove 没被拦下：浏览器的页面缩放会把它抢走')
  assert.notEqual(canvas.style.transform, cameraPinched, '双指张开，镜头没有缩放')

  await act(async () => { reactRoot.unmount() })

  assert.deepEqual(consoleErrors, [], '控制台里有 error')
})