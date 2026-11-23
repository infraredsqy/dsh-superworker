// cdp-shot.mjs — one headless-Chrome screenshot over bare CDP, no dependencies.
//
//   node tools/cdp-shot.mjs --url http://127.0.0.1:3080/ --out .tmp/shot.png
//   node tools/cdp-shot.mjs --url page.html --out shot.jpg --format jpeg --quality 85
//   node tools/cdp-shot.mjs --url http://127.0.0.1:3080/ --dismiss-boot --wait-selector '[class*="superworker-page"]' --out .tmp/panel.png
//   node tools/cdp-shot.mjs --url app.html --full-page --out full.png
//   node tools/cdp-shot.mjs --url app.html --clip 120,80,600,400 --out crop.png --keep
//
// WHY THIS TOOL EXISTS: agents used to hand-roll this harness per task — the old `.tmp` dump
// held 56 copies of the same spawn-chrome/find-port/capture loop. The traps those copies hit
// are baked into tools/lib/cdp.mjs and cdp-auth.mjs (stale DevToolsActivePort file, the
// boot-animation overlay that screenshots the compositor instead of the page, cookie jar
// placement, waits on DOM facts instead of sleeps). Read those headers before changing the
// launch or auth logic.
//
// Flags:
//   --url <file|url>     page to capture; http(s) kept as-is, anything else treated as a file path (required)
//   --out <path>         output image; extension defaults the format unless --format given (required)
//   --width/--height     viewport size (default 1440x960); --dsf device scale factor (default 1)
//   --wait <js>          poll a JS expression until truthy (default: body has text) before shooting
//   --wait-selector <css> poll a CSS selector until it exists (alternative to --wait)
//   --timeout <ms>       deadline for load + wait polling (default 15000)
//   --eval <js>          run a script right before the screenshot (return value printed)
//   --click <text>       click the first leaf element whose trimmed text matches exactly, before --eval
//                        (for React-controlled <select> use --eval with the prototype setter — see cdp.mjs header)
//   --dismiss-boot       skip the DSH boot-animation overlay first (only meaningful on the local GUI)
//   --full-page          captureBeyondViewport instead of the viewport surface
//   --clip x,y,w,h       capture a rectangle (CSS pixels, in device-scale units)
//   --format png|jpeg    --quality <1-100> (jpeg only)
//   --no-auth            skip the local-GUI cookie handshake (file:// pages never auth anyway)
//   --keep               leave Chrome and the CDP port alive after the shot (prints CDP_PORT=…)
//
// Exit codes: 0 shot written · 3 page never became ready / eval failed · 4 profile in use · 2 bad usage.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, launchChrome, connectPage, pollUntil, dismissBootOverlay, parseClip } from './lib/cdp.mjs'
import { authenticate, setCookieOnPage, isLocalApp, PROFILE_DIR } from './lib/cdp-auth.mjs'

const { arg, flag } = parseArgs(process.argv.slice(2))

const URL_IN = arg('url', '')
const OUT = arg('out', '')
if (!URL_IN || !OUT) {
  console.error('usage: node tools/cdp-shot.mjs --url <file|url> --out <path> [flags]  (see header)')
  process.exit(2)
}
const PAGE = /^https?:/i.test(URL_IN) ? URL_IN : pathToFileURL(resolve(URL_IN)).href
const WIDTH = Number(arg('width', '1440'))
const HEIGHT = Number(arg('height', '960'))
const DSF = Number(arg('dsf', '1'))
const TIMEOUT = Number(arg('timeout', '15000'))
const FORMAT = arg('format', OUT.toLowerCase().endsWith('.jpg') || OUT.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png')
const QUALITY = Number(arg('quality', '90'))
const OUT_PATH = resolve(OUT)
mkdirSync(dirname(OUT_PATH), { recursive: true })

const auth = !flag('no-auth') && isLocalApp(PAGE)

const { chrome, cdpPort } = await launchChrome({ userDataDir: PROFILE_DIR, width: WIDTH, height: HEIGHT })
const cleanup = async () => { try { chrome.kill() } catch { /* already gone */ } }
const fail = async (msg, code = 3) => { console.error(msg); await cleanup(); process.exit(code) }

try {
  const { ws, send, evalJS } = await connectPage(cdpPort)

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: DSF, mobile: false })
  // Keep the renderer foregrounded so rAF-driven animation settles into its real state.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  if (auth) {
    const { jar, minted } = await authenticate()
    console.log(`auth: ${minted ? 'minted new cookie' : 'reused stored cookie'}`)
    await setCookieOnPage(send, jar)
  }

  await send('Page.navigate', { url: PAGE })
  // Wait for a DOM fact (body with text), not a fixed sleep; the deadline is the give-up guard.
  const ready = await pollUntil(
    () => evalJS(`!!document.body && document.body.innerText.length > 0`),
    { timeoutMs: TIMEOUT },
  )
  if (!ready) await fail(`page never rendered anything within ${TIMEOUT}ms: ${PAGE}`)

  if (flag('dismiss-boot')) console.log(`boot overlay dismissed: ${await dismissBootOverlay(evalJS)}`)

  if (arg('wait-selector', '')) {
    const sel = JSON.stringify(arg('wait-selector', ''))
    const ok = await pollUntil(() => evalJS(`!!document.querySelector(${sel})`), { timeoutMs: TIMEOUT })
    if (!ok) await fail(`--wait-selector never matched within ${TIMEOUT}ms: ${sel}`)
  } else if (arg('wait', '')) {
    const expr = arg('wait', '')
    const ok = await pollUntil(() => evalJS(`!!(${expr})`), { timeoutMs: TIMEOUT })
    if (!ok) await fail(`--wait never became truthy within ${TIMEOUT}ms: ${expr}`)
  }

  if (arg('click', '')) {
    const want = JSON.stringify(arg('click', ''))
    const clicked = await evalJS(`(() => {
      const txt = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()
      for (const e of document.querySelectorAll('*')) {
        if (txt(e) !== ${want} || e.children.length !== 0) continue
        ;(e.closest('button,a,[role=button],[role=menuitem]') || e).click()
        return true
      }
      return false
    })()`)
    if (!clicked) await fail(`--click found no leaf element with exactly that text: ${arg('click', '')}`)
  }

  if (arg('eval', '')) {
    const v = await evalJS(arg('eval', ''))
    if (v !== undefined) console.log('eval:', JSON.stringify(v))
  }

  const params = { format: FORMAT }
  if (FORMAT === 'jpeg') params.quality = QUALITY
  if (flag('full-page')) params.captureBeyondViewport = true
  if (arg('clip', '')) params.clip = parseClip(arg('clip', ''), DSF)
  const shot = await send('Page.captureScreenshot', params)
  writeFileSync(OUT_PATH, Buffer.from(shot.data, 'base64'))

  console.log(JSON.stringify({ out: OUT_PATH, bytes: Buffer.from(shot.data, 'base64').length, format: FORMAT, url: PAGE }))

  if (flag('keep')) {
    console.log(`CDP_PORT=${cdpPort} (chrome left running for follow-up queries; kill it by pid when done)`)
    process.exit(0)
  }
  ws.close()
  await cleanup()
  process.exit(0)
} catch (e) {
  await fail(e?.message ?? String(e))
}
