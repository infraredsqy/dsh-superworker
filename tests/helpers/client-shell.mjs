/* The built browser half, booted the way the shell boots it — one copy for the cases that need a
 * mounted panel rather than a unit of the panel.
 *
 * jsdom is put in place before `react` is loaded (React touches window/document once at load time),
 * the bundle is loaded through the shell's own module loader, its factory is handed the module table
 * the shell hands it, the host half sits behind it over the in-memory port, and the panel is mounted
 * on the slot roster. What comes back is what a case judges: the container, the readings the boot
 * took (`asked`, `consulted`, `consoleErrors`), and a `settle()` that lets every read it started
 * land before the judge.
 *
 * `loadSpecOnly` is the boot's opt-in narrower face: the same globals, the same loader, the same
 * spec→factory assembly — and no host half, no roster, no mount. A file that wants the plugin's
 * units (`apply`, the descriptors) against a stand-in gateway it builds itself takes this face
 * instead of re-stating the boot.
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

/**
 * Load the bundle through the shell's loader (the first time only) and hand back its spec.
 */
async function specOf(window) {
  if (loadedSpec !== null) return loadedSpec
  let loaded = null
  window.__ModuleLoader__ = { load: (spec) => { loaded = spec } }
  await import(pathToFileURL(BUNDLE).href)
  if (loaded === null) throw new Error('the bundle loaded without handing the shell a spec')
  loadedSpec = loaded
  return loadedSpec
}

/** The module table the shell hands the factory: react comes from the test's own install. */
const clientOf = (loaded, React) => loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`this module table has no ${name}`)
})

/**
 * The jsdom page and the globals the bundle's load-time touches need, one copy for both faces of
 * the boot: `pretendToBeVisual` so the frame callbacks exist, and `navigator` written separately
 * because it is a getter-only property on Node.
 */
function bootPage() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
  })
  const globals = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'SVGElement', 'requestAnimationFrame', 'cancelAnimationFrame']
  for (const name of globals) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  /* `navigator` is a getter-only property on Node, so its descriptor is written separately. */
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  return dom.window
}

/**
 * The boot's spec-only face: the globals go up, the bundle loads through the shell's loader, the
 * factory gets the module table — and nothing mounts. What comes back is the plugin unit a case
 * applies against a gateway stand-in of its own.
 */
export async function loadSpecOnly() {
  const window = bootPage()
  const loaded = await specOf(window)
  const React = await import('react')
  return { client: clientOf(loaded, React), window }
}

/**
 * Boot the built panel and mount it on the in-memory port.
 *
 * `record` is the port's filename → text dict (the four sources with something in each, when a case
 * wants a drawn panel), or a function of the scope for a case that puts **two records** under one
 * mount — the scope carries the root being read, so a switch between workspaces draws a different
 * record; `workspaceRoot` is the root the session header hands the gateway.
 * `useSessions` is the seat's session-list hook, `sessionsService` lands in the context as DSH's
 * `sessions` service, `workspaces` is the workspace-list source — all three optional, all three
 * forwarded the way the real seat forwards them. `settingsForm` replaces the stand-in settings
 * document the boot attaches (a case that needs the write round trip held open passes one built with
 * `deferred`); it comes back as `form`, so the case can answer what stands queued. `onConsult`
 * answers the host's standing-corner doors for a case that presses one: it is handed
 * `{ door, sessionId, workspaceRoot }` (`door` is `route` or `conduct`) and may answer with a
 * promise (a case holding the call open to judge a door mid-flight); every call is recorded on
 * `consulted`, so a case can read which door the press opened and which workspace it named.
 * `openSession` is DSH's navigation gateway, the same hand the seat passes
 * down; without it every press on the panel is inert, which is what a deployment with no gateway
 * really draws (the sessions service it switches through is the stand-in `uiWorkspace`). `rerender`
 * re-renders the mounted panel with the same props, so a case that holds a mutable snapshot can move
 * it and redraw.
 */
export async function mountBuiltPanel({ record, workspaceRoot = 'C:\\workspace-for-the-render-check', sessionId = 'render-check-session', useSessions, sessionsService, workspaces, settingsForm, onConsult, openSession, agents, weightsFolder }) {
  const window = bootPage()
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
  const client = clientOf(loaded, React)

  /* ---- the host half behind it, read through the in-memory port ---- */
  const { SuperworkerRecordsGateway } = await import(pathToFileURL(join(repoRoot, 'src', 'host', 'index.ts')).href)
  const gateway = new SuperworkerRecordsGateway({
    workspaceFiles: fakeWorkspaceFiles(record),
    /* The real host resolves a session's workspace from its header's cwd. */
    sessions: { get: () => ({ header: { cwd: workspaceRoot } }) },
    sandboxPolicy: { workspaceRoot },
    /* Where the issue pool's weight table is read from, when a case wants a host with no table at all:
     * the shipped plugin folder is the default and is what a real deployment reads. */
    weightsFolder,
    /* No further services on this stand-in: every reading the panel asks for above answers from the
     * workspace-files port, and a service that is missing is a reading the panel has words for
     * rather than an error. The one exception is the agent registry: the stranded judgment asks it
     * who is alive, and a host that cannot answer says nobody is (that is the whole reading), so a
     * case that wants the judgment has to hand a roster over. */
    get: (name) => (name === 'agents' ? agents : undefined),
    provide: () => undefined,
  })

  /** The face the generated remote client would hand out: every call answers `{ ok, value }`. */
  const asked = []
  /* Every standing-corner press a case made, with the door it named and the answer that case chose to give it. */
  const consulted = []
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
    /* The channel is a stream, not a call: the face hands out the same shape the mounted namespace
     * does — an async iterable whose `dispose` cancels it — so the panel under test subscribes to it
     * exactly the way it does on a real host. */
    watch: (sessionId, workspaceRoot) => {
      const controller = new AbortController()
      asked.push('watch')
      const stream = (async function* () {
        try {
          for await (const frame of gateway.watch(sessionId, workspaceRoot, controller.signal)) yield frame
        } catch {
          /* The mount is done: the stream ends with it. */
        }
      })()
      return Object.assign(stream, { dispose: () => { controller.abort() } })
    },
    consultRoute: wrapped((sessionId, workspaceRoot) => {
      consulted.push({ door: 'route', sessionId, workspaceRoot })
      return onConsult === undefined ? { ok: true, session: 'consult-check-session' } : onConsult({ door: 'route', sessionId, workspaceRoot })
    }),
    consultConduct: wrapped((sessionId, workspaceRoot) => {
      consulted.push({ door: 'conduct', sessionId, workspaceRoot })
      return onConsult === undefined ? { ok: true, session: 'consult-check-session' } : onConsult({ door: 'conduct', sessionId, workspaceRoot })
    }),
  }

  /* ---- boot the plugin the way the shell does ---- */
  const { ledger, slots } = fakeSlotRoster()
  const provided = {}
  const form = settingsForm ?? fakeSettingsForm({}, { watchCount: true })
  const services = {
    'remote.superworker': remoteFace,
    slots,
    configForms: { get: () => form },
    uiWorkspace: { openSession: () => undefined },
  }
  if (sessionsService !== undefined) services.sessions = sessionsService
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
    /* The panel subscribes once and draws frames; a case waits for the first frame the way it waits
     * for its reads, so "let the reading land" still means what it says. */
    watch: (id, root, onFrame) => {
      let land
      track(new Promise((resolve) => { land = resolve }))
      return panel.port.watch(id, root, (frame) => { land(); onFrame(frame) })
    },
  }
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      const pending = inFlight.splice(0)
      if (pending.length === 0) return
      await act(async () => { await Promise.all(pending) })
    }
  }

  await act(async () => {
    /* `windows` is the panel api's own forwarding face over the context's `sessions` service — the
     * same object the slot's inject hands the real panel. */
    reactRoot.render(React.createElement(panel.Panel, { port, sessionId, prefs: panel.prefs, useSessions, workspaces, windows: panel.windows, openSession }))
  })
  await settle()

  const rerender = async () => {
    await act(async () => {
      reactRoot.render(React.createElement(panel.Panel, { port, sessionId, prefs: panel.prefs, useSessions, workspaces, windows: panel.windows, openSession }))
    })
    await settle()
  }

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
    form,
    asked,
    consulted,
    consoleErrors,
    settle,
    rerender,
    unmount,
    tabs: () => [...container.querySelectorAll('.superworker-tab')],
  }
}
