/* The built browser half, booted the way the shell boots it — one copy for the cases that need a
 * mounted panel rather than a unit of the panel.
 *
 * jsdom is put in place before `react` is loaded (React touches window/document once at load time),
 * the bundle is loaded through the shell's own module loader, its factory is handed the module table
 * the shell hands it, the host half sits behind it over the in-memory port, and the panel is mounted
 * on the slot roster. What comes back is what a case judges: the container, the readings the boot
 * took (`asked`, `consoleErrors`), and a `settle()` that lets every read it started land before the
 * judge.
 *
 * Needs `lib/client.js`; `npm test` builds it first. `bundleSkip` is that missing reason, so a file
 * can skip itself with it instead of failing on an import that cannot load.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { fakeSettingsForm, fakeSlotRoster } from './dsh-standins.mjs'
import { fakeWorkspaceFiles } from './workspace-files-port.mjs'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** The built browser half this helper mounts. */
export const BUNDLE = join(repoRoot, 'lib', 'client.js')

/** Why a case has to skip, or `false` when the bundle is there. */
export const bundleSkip = existsSync(BUNDLE) ? false : `${BUNDLE} is not there: run npm run bundle:client first (npm test runs it first)`

/**
 * The spec the bundle hands the shell. A module is loaded once per process, so a second mount in the
 * same file reuses it: the spec is the module's own, not the page's.
 */
let loadedSpec = null

/** Load the bundle through the shell's loader (the first time only) and hand back its spec. */
async function specOf(window) {
  if (loadedSpec !== null) return loadedSpec
  let loaded = null
  window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
  await import(pathToFileURL(BUNDLE).href)
  if (loaded === null) throw new Error('the bundle loaded without handing the shell a spec')
  loadedSpec = loaded
  return loadedSpec
}

/**
 * Boot the built panel and mount it on the in-memory port.
 *
 * `record` is the port's filename → text dict (the four sources with something in each, when a case
 * wants a drawn panel); `workspaceRoot` is the root the session header hands the gateway.
 */
export async function mountBuiltPanel({ record, workspaceRoot = 'C:\\workspace-for-the-render-check', sessionId = 'render-check-session' }) {
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

  /* Every `console.error` is a failure: this is the one reading a smoke case can take without
   * pinning copy. */
  const consoleErrors = []
  const realError = console.error
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); realError(...args) }

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = React

  /* ---- what the shell gets: one spec, then a factory ---- */
  const loaded = await specOf(window)
  const client = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`this module table has no ${name}`)
  })

  /* ---- the host half behind it, read through the in-memory port ---- */
  const { PathfinderRecordsGateway } = await import(pathToFileURL(join(repoRoot, 'src', 'host', 'index.ts')).href)
  const gateway = new PathfinderRecordsGateway({
    workspaceFiles: fakeWorkspaceFiles(record),
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
  if (panel === undefined) throw new Error('the plugin provided no panel')

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
    reactRoot.render(React.createElement(panel.Panel, { port, sessionId, prefs: panel.prefs }))
  })
  await settle()

  const unmount = async () => {
    await act(async () => { reactRoot.unmount() })
    console.error = realError
  }

  return {
    window,
    React,
    act,
    client,
    loaded,
    panel,
    provided,
    ledger,
    container,
    asked,
    consoleErrors,
    settle,
    unmount,
    tabs: () => [...container.querySelectorAll('.pf-tab')],
  }
}
