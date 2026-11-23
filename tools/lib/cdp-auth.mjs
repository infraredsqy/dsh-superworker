// cdp-auth.mjs — the durable key to this machine's `dsh web`, in one place. Shared by
// tools/cdp-shot.mjs and tools/cdp-rec.mjs (distilled from the old .tmp/rec/auth.mjs +
// session.mjs pair).
//
// WHY THIS EXISTS: an early recorder deleted its own output directory on every run
// (`rmSync(OUT)`), and the Chrome profile holding the auth cookie lived *inside* that
// directory. So every run started cold, had to spend a launch token again, and looked like
// "the token is single-use". It is not: a valid `GET /?token=…` mints a cookie and 303s to the
// clean path, as often as you like. The token only changes when the `dsh web` process
// restarts, and `dsh web` prints a fresh one into `~/.dsh/web-run.log` on every launch.
//
// The cookie is long-lived: its signed payload carries an absolute expiry (a deployment-level
// `cookieMaxAgeDays`), and its signing secret persists in `$DSH_HOME/.credentials.yaml`, so a
// cookie saved once keeps working across recorder runs, Chrome restarts, and `dsh web`
// restarts (until the secret rotates).
//
// THE RULE: acquire once, store OUTSIDE any directory a run cleans, reuse forever. The jar and
// profile live in `<repo>/.tmp/cdp-auth/` — gitignored, survives every run; a bulk cleanup of
// `.tmp` merely costs one re-mint on the next run.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Repo root = two levels above this file (tools/lib/). */
const REPO_ROOT = join(import.meta.dirname, '..', '..')

/** Where the jar lives. Deliberately NOT under any output dir the tools create. */
export const JAR_PATH = join(REPO_ROOT, '.tmp', 'cdp-auth', 'cookie.json')

/** The persistent Chrome profile. Kept apart from output dirs so it survives a rerun. */
export const PROFILE_DIR = join(REPO_ROOT, '.tmp', 'cdp-auth', 'profile')

/** True when a URL points at the local DSH web GUI (the only thing this auth opens). */
export function isLocalApp(url) {
  try {
    const h = new URL(url).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
  } catch { return false }
}

/** Every launch URL the server has printed into its boot log, newest last. */
export function launchUrls() {
  const path = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'web-run.log')
  if (!existsSync(path)) return []
  const out = []
  for (const m of readFileSync(path, 'utf8').matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/g)) {
    out.push(m[0])
  }
  return out
}

/** Read the stored jar, or undefined when there is none. */
export function readJar() {
  if (!existsSync(JAR_PATH)) return undefined
  try {
    const jar = JSON.parse(readFileSync(JAR_PATH, 'utf8'))
    return jar.name && jar.value ? jar : undefined
  } catch {
    return undefined
  }
}

/** Ask the running server whether this jar still opens the index page. */
export async function jarWorks(jar) {
  try {
    const r = await fetch(`http://${jar.authority}/`, {
      headers: { cookie: `${jar.name}=${jar.value}` },
      redirect: 'manual',
    })
    return r.status === 200
  } catch {
    return false
  }
}

/** Exchange the newest live launch token for a fresh cookie. Costs nothing recurring. */
async function mint() {
  for (const url of [...new Set(launchUrls())].reverse()) {
    const r = await fetch(url, { redirect: 'manual' })
    if (r.status !== 303) continue // a spent or superseded token 401s; try the next one
    const pair = (r.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).find((c) => c?.includes('='))
    if (!pair) continue
    const at = pair.indexOf('=')
    const name = pair.slice(0, at)
    const value = pair.slice(at + 1)
    const authority = new URL(url).host
    // The payload is signed but not encrypted: its middle segment is readable base64url JSON.
    let expiresAt
    try {
      const body = JSON.parse(Buffer.from(value.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString())
      if (typeof body.expiresAt === 'number') expiresAt = body.expiresAt
    } catch { /* an unreadable payload still works; it just cannot report its expiry */ }
    return { name, value, authority, expiresAt, savedAt: new Date().toISOString() }
  }
  return null
}

/**
 * The one call every run against the local GUI makes: hand back a working cookie, minting only
 * when needed.
 * @returns the jar, plus whether this call had to spend a token.
 */
export async function authenticate() {
  const stored = readJar()
  if (stored !== undefined && await jarWorks(stored)) {
    return { jar: stored, minted: false }
  }
  const fresh = await mint()
  if (fresh === null) throw new Error('no live launch token found in ~/.dsh/web-run.log, and no stored cookie works')
  mkdirSync(dirname(JAR_PATH), { recursive: true })
  writeFileSync(JAR_PATH, JSON.stringify(fresh, null, 2))
  return { jar: fresh, minted: true }
}

/** Put the stored cookie into a headless page so it loads the authenticated app.
 * Must run BEFORE Page.navigate: the cookie has to be in the jar when the request goes out. */
export async function setCookieOnPage(send, jar) {
  await send('Network.enable')
  await send('Network.setCookie', {
    name: jar.name,
    value: jar.value,
    domain: new URL(`http://${jar.authority}`).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  })
}
