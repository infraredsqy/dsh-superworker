// cdp-rec.mjs — headless-Chrome screencast recorder over bare CDP, distilled from the old
// `.tmp/rec/record-panel.mjs` (the deepest instrument in the 56-copy dump).
//
//   node tools/cdp-rec.mjs --url http://127.0.0.1:3080/ --seconds 6 --out .tmp/rec/my-run
//   node tools/cdp-rec.mjs --url page.html --seconds 30 --raw-frames --out .tmp/rec/fine
//
// TWO CAPTURE ROUTES
// ------------------
// default  `Page.startScreencast` (damage-driven) -> JPEGs piped straight into ffmpeg stdin ->
//          one mp4. Frames are NEVER written as images, so a 20-minute run costs the mp4's
//          size, not 66000 PNGs. Timeline: when a frame lands at wall time t, the previous
//          picture is repeated until the output reaches round((t-t0)*FPS), then the new one is
//          laid down; a 250ms ticker advances the timeline while the page is quiet.
// --raw-frames  `Page.captureScreenshot` on a fixed cadence -> frames/*.png + ffconcat with
//          true per-frame durations -> mp4, plus scene-cut moments (moments.json). Use it when
//          screencast stays suspiciously silent (GPU/canvas animations can produce no damage).
//
// "QUIET" vs "DEAD": screencast is damage-driven — a still page yields no frames at all, which
// makes "not moving" indistinguishable from "stream died" if you only count frames. A
// heartbeat therefore asks the page a cheap question every few seconds and records that it
// still answers (title/visibility). `mostlyStill` in the summary is a measured claim, not an
// excuse.
//
// TIMING HONESTY: the input side of ffmpeg declares `-framerate` because image2pipe defaults
// to 25fps — without it 1800 frames became 2160 encoded ones and a 60s recording came out 72s.
// The container duration is cross-checked with ffprobe at the end and any drift is reported.
//
// Flags: --url (file|http) and --out dir required; --seconds (10) · --fps (30) · --quality
// (90, screencast jpeg) · --width/--height (1440x960) · --heartbeat ms (5000) · --stop-file
// (touch it to end early without killing the process — killing node truncates the mp4, ffmpeg
// never sees stdin close) · --raw-frames · --dismiss-boot · --wait/--wait-selector/--eval/
// --click (same semantics as cdp-shot.mjs) · --no-auth · --keep (leave Chrome alive, print
// CDP_PORT) · env DSH_CHROME overrides the Chrome path.
// Exit codes: 0 ok · 3 page never ready · 4 profile in use · 2 bad usage.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, launchChrome, connectPage, pollUntil, dismissBootOverlay, parseClip } from './lib/cdp.mjs'
import { authenticate, setCookieOnPage, isLocalApp, PROFILE_DIR } from './lib/cdp-auth.mjs'

const { arg, flag } = parseArgs(process.argv.slice(2))

const URL_IN = arg('url', '')
const OUT = resolve(arg('out', ''))
if (!URL_IN || !OUT) {
  console.error('usage: node tools/cdp-rec.mjs --url <file|url> --out <dir> [flags]  (see header)')
  process.exit(2)
}
const PAGE = /^https?:/i.test(URL_IN) ? URL_IN : pathToFileURL(resolve(URL_IN)).href
const WIDTH = Number(arg('width', '1440'))
const HEIGHT = Number(arg('height', '960'))
const SECONDS = Math.max(1, Number(arg('seconds', '10')))
const FPS = Math.max(1, Number(arg('fps', '30')))
const QUALITY = Number(arg('quality', '90'))
const HEARTBEAT_MS = Math.max(2000, Math.min(15000, Number(arg('heartbeat', '5000'))))
const STOP_FILE = arg('stop-file', '')
const RAW = flag('raw-frames')
const TIMEOUT = Number(arg('timeout', '15000'))
mkdirSync(OUT, { recursive: true }) // never rmSync(OUT): the auth profile must survive reruns
if (RAW) {
  rmSync(join(OUT, 'frames'), { recursive: true, force: true })
  mkdirSync(join(OUT, 'frames'), { recursive: true })
}

const auth = !flag('no-auth') && isLocalApp(PAGE)

const { chrome, cdpPort } = await launchChrome({ userDataDir: PROFILE_DIR, width: WIDTH, height: HEIGHT })
const cleanup = async () => { try { chrome.kill() } catch { /* already gone */ } }
const fail = async (msg, code = 3) => { console.error(msg); await cleanup(); process.exit(code) }

try {
  const { ws, send, on, evalJS } = await connectPage(cdpPort)

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  if (auth) {
    const { jar, minted } = await authenticate()
    console.log(`auth: ${minted ? 'minted new cookie' : 'reused stored cookie'}`)
    await setCookieOnPage(send, jar)
  }

  await send('Page.navigate', { url: PAGE })
  const ready = await pollUntil(() => evalJS(`!!document.body && document.body.innerText.length > 0`), { timeoutMs: TIMEOUT })
  if (!ready) await fail(`page never rendered anything within ${TIMEOUT}ms: ${PAGE}`)
  if (flag('dismiss-boot')) console.log(`boot overlay dismissed: ${await dismissBootOverlay(evalJS)}`)
  if (arg('wait-selector', '')) {
    const sel = JSON.stringify(arg('wait-selector', ''))
    if (!await pollUntil(() => evalJS(`!!document.querySelector(${sel})`), { timeoutMs: TIMEOUT })) {
      await fail(`--wait-selector never matched within ${TIMEOUT}ms: ${sel}`)
    }
  } else if (arg('wait', '')) {
    if (!await pollUntil(() => evalJS(`!!(${arg('wait', '')})`), { timeoutMs: TIMEOUT })) {
      await fail(`--wait never became truthy within ${TIMEOUT}ms`)
    }
  }
  if (arg('click', '')) {
    const want = JSON.stringify(arg('click', ''))
    if (!await evalJS(`(() => {
      const txt = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()
      for (const e of document.querySelectorAll('*')) {
        if (txt(e) !== ${want} || e.children.length !== 0) continue
        ;(e.closest('button,a,[role=button],[role=menuitem]') || e).click()
        return true
      }
      return false
    })()`)) await fail(`--click found no matching leaf element: ${arg('click', '')}`)
  }
  if (arg('eval', '')) {
    const v = await evalJS(arg('eval', ''))
    if (v !== undefined) console.log('eval:', JSON.stringify(v))
  }

  /* ── the heartbeat: "quiet page" vs "dead renderer" ─────────────────────────────────────── */
  const heartbeat = []
  const heartbeatOnce = async () => {
    const ok = await evalJS(`({ title: document.title, visibility: document.visibilityState, url: location.href })`)
      .catch((e) => ({ error: String(e) }))
    heartbeat.push({ at: +((Date.now() - startedAt) / 1000).toFixed(1), sinceLastFrameMs: Date.now() - lastFrameAt, ...ok })
  }

  const startedAt = Date.now()
  const stopAt = startedAt + SECONDS * 1000
  let lastFrameAt = Date.now()

  /* ── route 1: screencast -> ffmpeg stdin -> mp4 ──────────────────────────────────────────── */
  let ffmpeg = null
  let ffErr = ''
  const captured = []       // every screencast frame, with its wall stamp
  let written = 0           // frames laid down into the video
  let lastJpeg = null       // most recent picture (idle ticker repeats it)
  let prevJpeg = null       // picture current before the one being handled
  let t0 = null             // wall seconds of the first captured frame
  // Screencast-route pump state, hoisted so the shutdown tail can always reference it.
  const queue = []          // bounded ring of pending JPEGs
  let pumping = false
  let dropped = 0
  let pushJpeg = () => {}
  let ticker = null

  if (!RAW) {
    ffmpeg = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      // `-framerate` on the INPUT is load-bearing: image2pipe defaults to 25fps, and letting it
      // resample stretched a 60s recording to 72s. Declaring the input rate makes it 1:1.
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-r', String(FPS), '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', join(OUT, 'rec.mp4'),
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    ffmpeg.stderr.on('data', (d) => { ffErr += d.toString() })
    ffmpeg.on('error', (e) => { ffErr += String(e) })

    /* Bounded write path: exactly one pump owns a small ring of JPEGs; when write() returns
     * false it awaits the SINGLE next drain. Pictures are dropped and counted past MAX_QUEUE —
     * a drop costs temporal detail, never timing, because the timeline repeats the surviving
     * picture. The naive per-write once('drain') version died with ENOMEM on a 60s run. */
    const MAX_QUEUE = 64
    const pump = async () => {
      if (pumping || ffmpeg === null) return
      pumping = true
      try {
        while (queue.length > 0) {
          const buf = queue.shift()
          if (!ffmpeg.stdin.write(buf)) {
            await new Promise((res) => {
              const done = () => { ffmpeg.stdin.off('drain', done); ffmpeg.stdin.off('error', done); res() }
              ffmpeg.stdin.once('drain', done)
              ffmpeg.stdin.once('error', done)
            })
          }
        }
      } finally { pumping = false }
    }
    pushJpeg = (buf) => {
      if (ffmpeg === null) return
      if (queue.length >= MAX_QUEUE) { dropped++; return }
      queue.push(buf)
      void pump()
    }
    const layDownTo = (wallSeconds) => {
      if (lastJpeg === null || t0 === null) return
      const target = Math.round((wallSeconds - t0) * FPS)
      while (written < target) { pushJpeg(lastJpeg); written++ }
    }

    on((m) => {
      if (m.method !== 'Page.screencastFrame') return
      const { data, metadata, sessionId } = m.params
      // Ack every frame or the stream stalls — this is not optional.
      send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      const wallMs = metadata.timestamp * 1000
      lastFrameAt = Date.now()
      const jpeg = Buffer.from(data, 'base64')
      captured.push({ wall: +wallMs.toFixed(1), bytes: jpeg.length })
      if (t0 === null) { t0 = metadata.timestamp; written = 0 }
      const target = Math.round((metadata.timestamp - t0) * FPS)
      if (target >= written) {
        // Hold the picture that WAS current until this instant, then lay the new one down.
        const fill = prevJpeg ?? jpeg
        while (written < target) { pushJpeg(fill); written++ }
        pushJpeg(jpeg); written++
      }
      prevJpeg = jpeg
      lastJpeg = jpeg
    })

    await send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 })
    // The ticker advances the video timeline while the page is quiet — waiting on time itself
    // (a constant-rate muxer), not polling for a condition.
    ticker = setInterval(() => { if (t0 !== null) layDownTo(Date.now() / 1000) }, 250)
  }

  /* ── route 2: captureScreenshot cadence -> png frames -> ffconcat -> mp4 ─────────────────── */
  const frames = []
  if (RAW) {
    const shot = () => send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const t0raw = Date.now()
    let i = 0
    while (Date.now() - t0raw < SECONDS * 1000) {
      const at = +((Date.now() - t0raw) / 1000).toFixed(4)
      let data
      try { data = (await shot()).data } catch { break }
      i++
      const name = `f${String(i).padStart(6, '0')}.png`
      writeFileSync(join(OUT, 'frames', name), Buffer.from(data, 'base64'))
      frames.push({ i, name, at })
      lastFrameAt = Date.now()
      // Pace to the requested cadence, but never sleep past the deadline.
      const spent = Date.now() - t0raw - at * 1000
      const want = 1000 / FPS
      if (spent < want) await new Promise((r) => setTimeout(r, want - spent))
    }
    // ffconcat with true durations: this is what keeps the video timeline = wall clock.
    const durations = frames.map((f, k) => {
      const next = k + 1 < frames.length ? frames[k + 1].at : f.at + 1 / FPS
      return +Math.max(0.001, next - f.at).toFixed(4)
    })
    const concat = ['ffconcat version 1.0']
    frames.forEach((f, k) => { concat.push(`file 'frames/${f.name}'`); concat.push(`duration ${durations[k]}`) })
    concat.push(`file 'frames/${frames[frames.length - 1].name}'`)
    writeFileSync(join(OUT, 'list.ffconcat'), concat.join('\n'))
  }

  const beats = setInterval(() => { void heartbeatOnce() }, HEARTBEAT_MS)
  await heartbeatOnce()

  process.on('SIGINT', () => {
    console.log('\nSIGINT — finishing the recording cleanly (killing node would truncate the mp4).')
    try { clearInterval(beats); if (ticker !== null) clearInterval(ticker) } catch { /* shutting down */ }
    process.exit(130)
  })

  /* Wait out the recording window — or until the stop file appears, whichever comes first. */
  while (Date.now() < stopAt) {
    if (STOP_FILE !== '' && existsSync(STOP_FILE)) {
      console.log(`\nstop file seen (${STOP_FILE}) — finishing the recording early.`)
      break
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, stopAt - Date.now()))))
  }
  clearInterval(beats)
  if (ticker !== null) clearInterval(ticker)
  await heartbeatOnce()

  const span = (Date.now() - startedAt) / 1000
  const summary = {
    url: PAGE, route: RAW ? 'screenshot-cadence' : 'screencast',
    outputFps: FPS, seconds: +span.toFixed(2),
    capturedFrames: RAW ? frames.length : captured.length,
    heartbeatBeats: heartbeat.length,
    pageAnsweredThroughout: heartbeat.every((b) => !b.error),
    mostlyStill: (RAW ? frames.length : captured.length) / Math.max(1, span) < 2,
  }

  if (RAW) {
    const ff = await new Promise((res) => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.ffconcat',
        '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', 'rec.mp4'],
      { cwd: OUT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let err = ''; p.stderr.on('data', (d) => { err += d.toString() })
      p.on('error', (e) => res({ code: -1, text: String(e) })); p.on('exit', (c) => res({ code: c, text: err }))
    })
    summary.encodeExit = ff.code
    if (ff.text.trim()) summary.encodeErr = ff.text.trim().slice(0, 400)
    // Scene-cut moments: where the page visibly changed (useful for picking highlights).
    const sc = await new Promise((res) => {
      const p = spawn('ffmpeg', ['-i', 'rec.mp4', '-vf', "select='gt(scene,0.0008)',showinfo", '-f', 'null', '-'],
        { cwd: OUT, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let out = ''; p.stdout.on('data', (d) => { out += d.toString() })
      p.on('error', () => res('')); p.on('close', () => res(out))
    })
    const moments = [...sc.matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => +m[1])
      .filter((t, k, a) => k === 0 || t - a[k - 1] > 0.02)
    writeFileSync(join(OUT, 'moments.json'), JSON.stringify({ count: moments.length, moments }, null, 2))
    summary.sceneCuts = moments.length
  } else {
    await send('Page.stopScreencast').catch(() => {})
    // Fill the tail so the video ends where the wall clock did.
    if (t0 !== null && lastJpeg !== null) {
      const target = Math.round((Date.now() / 1000 - t0) * FPS)
      while (written < target) { pushJpeg(lastJpeg); written++ }
    }
    // Drain the pump before closing the pipe, or the tail frames never reach the encoder.
    if (ffmpeg !== null) {
      const closed = new Promise((res) => ffmpeg.once('close', res))
      for (let k = 0; k < 600 && (queue.length > 0 || pumping); k++) await new Promise((r) => setTimeout(r, 50))
      ffmpeg.stdin.end()
      await closed
    }
    summary.droppedForBackpressure = dropped
    summary.videoFrames = written
    const firstWall = captured.length ? captured[0].wall : 0
    for (const f of captured) f.at = +((f.wall - firstWall) / 1000).toFixed(4)
    const gaps = []
    for (let k = 1; k < captured.length; k++) gaps.push(captured[k].wall - captured[k - 1].wall)
    const sorted = [...gaps].sort((a, b) => a - b)
    summary.medianGapMs = sorted.length ? +(sorted[sorted.length >> 1]).toFixed(1) : 0
    summary.worstGapMs = sorted.length ? +(sorted[sorted.length - 1]).toFixed(1) : 0
    summary.frameList = captured
  }

  /* ── timeline honesty: cross-check the container duration against the wall clock ─────────── */
  const mp4Path = join(OUT, 'rec.mp4')
  let bytes = 0
  try { bytes = statSync(mp4Path).size } catch { /* no video produced */ }
  if (bytes) {
    const probe = await new Promise((res) => {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4Path], { windowsHide: true })
      let out = ''; p.stdout.on('data', (d) => { out += d.toString() })
      p.on('close', () => res(Number(out.trim()))); p.on('error', () => res(NaN))
    })
    if (Number.isFinite(probe) && probe > 0) {
      summary.videoSeconds = +probe.toFixed(2)
      const want = RAW ? span : written / FPS
      summary.timelineDriftSeconds = +(probe - want).toFixed(2)
    }
    summary.videoMiB = +(bytes / 1048576).toFixed(1)
  }
  if (ffErr.trim()) summary.ffmpegErr = ffErr.trim().slice(0, 400)
  writeFileSync(join(OUT, 'record.json'), JSON.stringify(summary, null, 2))

  console.log('\n=== recording done ===')
  console.log(`  route             : ${summary.route}`)
  console.log(`  duration          : ${span.toFixed(1)} s`)
  console.log(`  captured frames   : ${summary.capturedFrames}`)
  console.log(`  heartbeat         : ${heartbeat.length} beats, page answered: ${summary.pageAnsweredThroughout}`)
  if (summary.mostlyStill) console.log('  NOTE: mostly still — screencast is damage-driven; the heartbeat beats are the aliveness proof.')
  if (summary.videoSeconds !== null && summary.videoSeconds !== undefined) {
    console.log(`  video             : ${summary.videoMiB} MiB, ${summary.videoSeconds} s (drift ${summary.timelineDriftSeconds} s)`)
  }
  if (summary.ffmpegErr) console.log(`  ffmpeg stderr     : ${summary.ffmpegErr}`)
  console.log(`  output dir        : ${OUT}`)

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
