// cdp.mjs — the shared headless-Chrome-over-bare-CDP plumbing behind tools/cdp-shot.mjs and
// tools/cdp-rec.mjs. Distilled from ~56 hand-rolled copies in the old `.tmp` dump
// (.tmp/rec/record-panel.mjs was the best of them); every guard below cost a real
// debugging session, so keep the comments when you change the code.
//
//   * Stale port file: `DevToolsActivePort` outlives the Chrome that wrote it. Delete it
//     before launch, and refuse to share a profile whose port still answers — Chrome is
//     single-instance per user-data-dir, so a second launch would silently hand control to
//     somebody else's browser instead of failing.
//   * The port wait distinguishes its two death modes: Chrome exited early, vs never wrote
//     the port file.
//   * Renderer-throttling flags plus focus/lifecycle emulation keep rAF-driven animation
//     flowing in a hidden window; without them a "background" page goes still.
//   * Screencast frames must be acked or the stream stalls (tools/cdp-rec.mjs).
//   * React-controlled `<select>` needs the prototype setter plus input/change events; a
//     plain `el.value = x` updates the DOM but not the app state.
//
// No dependencies: plain Node (fetch + global WebSocket), like the originals.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, watch } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/** Minimal `--flag value` / `--flag` parser shared by the cdp-* CLIs. */
export function parseArgs(argv) {
  return {
    arg: (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d },
    flag: (n) => argv.includes('--' + n),
  }
}

/** Launch headless Chrome with `--remote-debugging-port=0` and resolve the CDP port.
 * The port arrives via the DevToolsActivePort file (fs.watch), not stdout guessing. */
export async function launchChrome({ userDataDir, width = 1440, height = 960, chromePath, extraArgs = [] }) {
  const exe = chromePath || process.env.DSH_CHROME || DEFAULT_CHROME
  // The port wait below fs.watches this directory; it must exist even on the very first run.
  mkdirSync(userDataDir, { recursive: true })
  const portFile = join(userDataDir, 'DevToolsActivePort')
  // Refuse to share the profile with a live Chrome (single-instance per user-data-dir).
  try {
    const stale = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0
    if (stale) {
      const alive = await fetch(`http://127.0.0.1:${stale}/json/version`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.ok).catch(() => false)
      if (alive) {
        console.error(`refusing to start: a Chrome is already serving ${userDataDir} at port ${stale}.`)
        console.error('Kill that Chrome by pid first (never taskkill /IM chrome.exe), then rerun.')
        process.exit(4)
      }
    }
  } catch { /* unreadable port file: treated as stale below */ }
  rmSync(portFile, { force: true }) // a stale file points at a dead port

  const chrome = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${width},${height + 60}`,
    // Keep the renderer foregrounded: without these a hidden window throttles rAF and timers.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    '--mute-audio',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let chromeExited = null
  chrome.on('exit', (code) => { chromeExited = code })

  const cdpPort = await new Promise((res, rej) => {
    const read = () => { try { return Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0 } catch { return 0 } }
    // The fs.watch event below is the real signal; the timer is only the give-up guard.
    const t = setTimeout(() => {
      w.close()
      rej(new Error(chromeExited !== null
        ? `chrome exited with code ${chromeExited} before writing DevToolsActivePort (is another Chrome using ${userDataDir}?)`
        : `chrome wrote no DevToolsActivePort within 25s (missing chrome at ${exe}? set DSH_CHROME)`))
    }, 25000)
    const w = watch(userDataDir, (_e, name) => {
      if (name !== 'DevToolsActivePort') return
      const p = read(); if (!p) return
      clearTimeout(t); w.close(); res(p)
    })
    const now = read(); if (now) { clearTimeout(t); w.close(); res(now) }
  })

  return { chrome, cdpPort }
}

/** Connect to the first page target of a CDP endpoint. Returns a tiny request/event surface. */
export async function connectPage(cdpPort) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target in /json/list')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket to page target failed')) })

  let seq = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined) {
      const s = pending.get(m.id); pending.delete(m.id); if (!s) return
      m.error ? s.rej(new Error(`${s.method}: ${m.error.message}`)) : s.res(m.result)
    } else for (const f of listeners) f(m)
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej, method }); ws.send(JSON.stringify({ id, method, params }))
  })
  const on = (f) => listeners.push(f)
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result?.value
  }
  return { ws, send, on, evalJS, targetUrl: target.url }
}

/** Poll a DOM fact every 100ms until truthy or the deadline passes. Waits on facts, not clocks. */
export async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn().catch(() => false)
    if (v) return v
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** Dismiss the `dsh-boot-animation` full-screen overlay (DSH-specific, harmless elsewhere).
 * The overlay sits at z-index 2147483647, so screenshots capture it instead of the page even
 * when the DOM underneath is correct — compositor surface, not DOM. Escape is the plugin's own
 * skip key; seeding its once-per-day localStorage marker did NOT suppress it in practice. */
export async function dismissBootOverlay(evalJS) {
  const count = () => evalJS(`document.querySelectorAll('.dshba').length`).catch(() => 1)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await count() === 0) return true
    await evalJS(`(() => {
      for (const t of ['keydown', 'keyup']) {
        globalThis.dispatchEvent(new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }))
      }
      return true
    })()`).catch(() => {})
    // Wait for the node to go: the overlay fades, so this waits on the DOM fact, not a delay.
    for (let k = 0; k < 60; k++) {
      if (await count() === 0) return true
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return await count() === 0
}

/** Parse `x,y,w,h` into a CDP screenshot clip object; throw on anything else. */
export function parseClip(spec, deviceScaleFactor) {
  const parts = String(spec).split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`--clip expects x,y,w,h with numbers, got: ${spec}`)
  }
  const [x, y, width, height] = parts
  return { x, y, width, height, scale: deviceScaleFactor }
}
