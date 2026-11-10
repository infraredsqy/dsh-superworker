/**
 * The landing spot of the instruction account, its vocabulary and its low-level read and write: this
 * plugin's own record layer.
 *
 * The account lives with the rest of this project's records, at
 * `<project root>/.superworker/instructions.json` — the same file, byte for byte, the engine wrote
 * before this folder owned it:
 *
 * - the whole document is written back as it was read: only the cells a verb changed differ, every
 *   other top-level key (a foreign section another tool keeps in the same file) comes back in its
 *   own place;
 * - key order is construction order, never sorted (the engine's writer for this record does not
 *   sort, and the golden corpus compares the bytes);
 * - two-space indent, non-ASCII as it is, LF on every platform, no trailing newline; a write is
 *   atomic (a temp file in the target's own directory is fsynced and renamed over it).
 *
 * **The account belongs to this plugin, and whoever owns a record writes it.** The engine's
 * foundation (`src/jsonio.ts`) serves the engine's own records and never goes into the package
 * exports, so this layer carries the account's reads and writes itself. The sameness is not kept by
 * editing both sides together: the golden corpus cases that replay this plugin's verbs compare the
 * file byte for byte (`tests/fixtures/instruction-*`), so a change to either side's indent, key
 * order, line ending, number spelling or timestamp shape turns them red on the spot. The moment this
 * layer writes (`nowSeconds` and the microsecond anchor under it) is a copy of `src/clock.ts`; the
 * corpus cases compare the seconds spelling, so a change to either side's padding or literal `Z`
 * turns them red the same way.
 *
 * The runtime hands in two facts:
 * - Locking: a write lands atomically, so a reader never sees half a record; and every
 *   "read → change → write" of one command runs exclusively against every other one — inside this
 *   process through the promise chain below, **across processes through this plugin's own lock
 *   file** (`<root>/.superworker/meta/instructions.lock`). The protocol is the engine's ledger
 *   lock's: taking it is creating an empty file exclusively, releasing it is deleting that file, a
 *   contender retries every 50 ms and gives up after 10 s with a decidable error naming the path.
 *   The path is not the engine's `ledger.lock` and not the issue pool's `issues.lock`: each owner of
 *   a record holds its own lock, and no operation holds two.
 * - The base of a relative path: always resolved from the project root `ctx.root` the host hands in
 *   (a plugin is given no working directory).
 *
 * **The init gate stays in front of every write** (and out of every read): a record directory that
 * was never set up is refused with the engine's own sentence, so a project that never ran `init`
 * gets not one byte from a verb that changes the account — while `list` still reads an absent
 * account as an empty one, which is an answer and not a failure.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

// ═══ Paths and constants ═════════════════════════════════════════════════════

// The record directory's name is spelled here because a plugin's tool file cannot import the engine's constant.
const RECORD_DIR_NAME = '.superworker'

export function recordDir(root) {
  return join(root, RECORD_DIR_NAME)
}

export function instructionsPath(root) {
  return join(recordDir(root), 'instructions.json')
}

/**
 * Where the account's cross-process lock lands: `<root>/.superworker/meta/instructions.lock`.
 *
 * Deliberately not the engine's `ledger.lock` nor the issue pool's `issues.lock`: one record, one
 * lock; no operation of this folder holds another record's lock.
 */
export function instructionsLockPath(root) {
  return join(recordDir(root), 'meta', 'instructions.lock')
}

/**
 * The main tree a linked worktree's checkout root points back at, or `null` when this is no worktree root.
 *
 * A worktree root is recognised by its `.git` being a **file**, whose first line is
 * `gitdir: <main>/.git/worktrees/<name>`; that pointer leads back to the main tree, and only when the
 * main tree really has a `.superworker/` of its own. Everything else — a subdirectory, a submodule (its
 * `.git` file points at `.git/modules/…`), a directory that is no project at all — is no main tree.
 */
function mainTreeOf(start) {
  let firstLine
  try {
    const dotGit = join(start, '.git')
    if (!statSync(dotGit).isFile()) return null
    firstLine = readFileSync(dotGit, 'utf8').split('\n')[0].trim()
  } catch {
    return null
  }
  if (!firstLine.startsWith('gitdir:')) return null
  const target = firstLine.slice('gitdir:'.length).trim()
  if (target === '') return null
  const gitdir = resolve(start, target)
  // `<main>/.git/worktrees/<name>` and nothing else: a submodule's `gitdir:` does not name a worktree.
  if (basename(dirname(gitdir)) !== 'worktrees') return null
  const main = resolve(gitdir, '..', '..', '..')
  try {
    if (!statSync(join(main, RECORD_DIR_NAME)).isDirectory()) return null
  } catch {
    return null
  }
  return main
}

/**
 * The project root an explicitly named `--project` acts on: the directory named, else the main tree a
 * linked worktree's checkout root points back at.
 *
 * A worktree's own copy of `.superworker/` is never the account: it is the record as of the fork, so a
 * command that accepted it would settle on a stale snapshot. That decision belongs here, with the word
 * — the host used to resolve it before handing the word over. The default path is not this function's
 * business: `ctx.root` arrives already resolved by the host and is taken exactly as it comes.
 */
export function projectRootOf(named) {
  const base = resolve(named)
  return mainTreeOf(base) ?? base
}

/** The limit for waiting on the account's lock: writing one record takes milliseconds; the limit only guards against a deadlock. */
export const LOCK_TIMEOUT_MS = 10_000

/** The probe interval of a contender: the engine's ledger lock probes on the same cadence. */
export const LOCK_POLL_MS = 50

/**
 * The scopes an entry can bind to, in the order the command surface lists them — the one home of this
 * vocabulary (the `--scope` choices read it, and so does `list`'s account view).
 */
export const VALID_SCOPES = Object.freeze(['global', 'cycle', 'node'])

/** What an entry hangs on: a process stage, or the line-closing boundary. */
export const VALID_TARGETS = Object.freeze(['stage', 'boundary'])

/** The one state word a live entry carries; `withdrawn` is the archived one. */
export const LIVE_STATE = 'live'

/** The key of the tombstone table: the id and the moment a removal left (bookkeeping, shown to no view). */
export const REMOVED_KEY = 'removed'

/** The shape of an issued id: `i-` and digits. An issued number is never issued again. */
export const ISSUED_ID = /^i-(\d+)$/

/** The two marks the account view prints beside an entry. */
export const STATE_MARKS = Object.freeze({ live: '●', withdrawn: '✗' })

/**
 * The text a command hands back to a person ends its lines with LF on every platform — the same line
 * ending the answer had before this folder owned the verb, so a caller's byte comparison does not
 * depend on which machine answered.
 */
export const EOL = '\n'

// ═══ Moments ═════════════════════════════════════════════════════════════════

const PAD_WIDTH = 2

function pad(value, width = PAD_WIDTH) {
  return String(value).padStart(width, '0')
}

// Anchor of the microsecond clock: the wall clock only has millisecond coarseness, so the
// microsecond remainder is made up from the monotonic clock's elapsed time; when the two readings
// drift more than a millisecond apart, the anchor is taken again. Strictly increasing within the
// process — two writes inside one millisecond each get their own moment.
let anchorWallUs = 0
let anchorNs = 0n
let lastUs = Number.NEGATIVE_INFINITY

const REANCHOR_TOLERANCE_US = 1000

function epochMicros() {
  const wallMs = Date.now()
  const ns = process.hrtime.bigint()
  if (anchorNs === 0n) {
    anchorWallUs = wallMs * 1000
    anchorNs = ns
  }
  let us = anchorWallUs + Number((ns - anchorNs) / 1000n)
  if (Math.abs(wallMs * 1000 - us) > REANCHOR_TOLERANCE_US) {
    anchorWallUs = wallMs * 1000
    anchorNs = ns
    us = anchorWallUs
  }
  if (us <= lastUs) us = lastUs + 1
  lastUs = us
  return us
}

/** The seconds spelling of one epoch-microsecond reading (UTC with a literal `Z`, sub-second tail cut off). */
export function secondsTimestampOf(epochUs) {
  const moment = new Date(Math.floor(epochUs / 1000))
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}` +
    `T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}Z`
  )
}

/** The seconds spelling of this moment: the shape `at` / `resolved_at` carry in the account. */
export function nowSeconds() {
  return secondsTimestampOf(epochMicros())
}

// ═══ The bytes of the document on disk ═══════════════════════════════════════

/**
 * The bytes of the whole document: two-space indent, non-ASCII as it is, LF on every platform, no
 * trailing newline, and the key order the object was built in (this record is not sorted).
 */
export function instructionsBytes(data) {
  const text = JSON.stringify(data, null, 2)
  if (text === undefined) throw new TypeError('the instruction account holds a value JSON cannot spell')
  return text
}

function withLf(text) {
  return text.split('\r\n').join('\n')
}

// ═══ Reading and writing ═════════════════════════════════════════════════════

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Read the whole document: absent means an empty account; bad bytes and unparsable text report on the
 * spot and are never repaired automatically. A document whose top level is not an object reads as an
 * empty account (nothing in it could be one), the way the engine's reader read it.
 */
export function readInstructions(root) {
  const path = instructionsPath(root)
  if (!existsSync(path)) return { instructions: [] }
  let text
  try {
    text = strictUtf8.decode(readFileSync(path))
  } catch (error) {
    throw new Error(`instructions.json is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`instructions.json parse failure: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { instructions: [] }
  if (!Array.isArray(data.instructions)) data.instructions = []
  return data
}

/** Write the whole document: the temporary file lands in the target's own directory, is fsynced, then renamed over it. */
export async function writeInstructions(root, data) {
  await atomicWriteText(instructionsPath(root), instructionsBytes(data))
}

// ═══ The other two records this layer reads (never writes) ═══════════════════

/** The line account: `state.json`'s `cycles` table, read as records. */
export function readCycles(root) {
  const data = readJsonRecord(join(recordDir(root), 'state.json'), 'state.json')
  return Array.isArray(data.cycles) ? data.cycles.filter(isRecord) : []
}

/** The graph: `ideas.json`'s `nodes` table, read as id → record. */
export function readNodes(root) {
  const data = readJsonRecord(join(recordDir(root), 'ideas.json'), 'ideas.json')
  const nodes = data.nodes
  return isRecord(nodes) ? nodes : {}
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One JSON record of another owner, read the way the engine reads it: absent is empty, unreadable reports, a non-object top level is empty. */
function readJsonRecord(path, label) {
  if (!existsSync(path)) return {}
  let text
  try {
    text = strictUtf8.decode(readFileSync(path))
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} parse failure: ${error instanceof Error ? error.message : String(error)}`)
  }
  return isRecord(data) ? data : {}
}

// ═══ One read-modify-write at a time, in this process and across processes ═══

/** The tail of the queue per account path: the body queued behind it starts once this settles. */
const tails = new Map()

/**
 * Run one account "read → change → write" exclusively.
 *
 * One process runs commands side by side (the panel's write while a session reads the account), and
 * two bodies that both took their snapshot before either landed would let the later snapshot drop
 * the earlier write — the account would come back missing an entry without a word. The bodies
 * therefore queue on the account's resolved path, and inside this process's turn the body holds the
 * account's own lock file from the snapshot through the write, so a second **process** writing the
 * same account waits instead of overwriting.
 */
export function withInstructionsLock(root, body) {
  const key = instructionsPath(root)
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(
    () => inLockFile(root, body),
    () => inLockFile(root, body),
  )
  const settled = run.then(() => undefined, () => undefined)
  tails.set(key, settled)
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key)
  })
  return run
}

/**
 * The decidable "the account lock stayed busy" error: `code` is `lock_timeout` (the code the engine
 * uses for the same fact), `path` is the file a person can delete once nobody is writing.
 */
export class InstructionsLockError extends Error {
  constructor(path, timeoutMs) {
    super(
      `the instruction account lock ${path} stayed busy for ${timeoutMs} ms; another process is ` +
        'writing the account. Confirm nobody is writing, then delete that path. Nothing was changed.',
    )
    this.name = 'InstructionsLockError'
    this.code = 'lock_timeout'
    this.path = path
  }
}

/** Hold the account's lock file through one body; a body that throws releases it just the same. */
async function inLockFile(root, body) {
  const lockPath = instructionsLockPath(root)
  await acquireLock(lockPath)
  try {
    return await body()
  } finally {
    await releaseLock(lockPath)
  }
}

/** Take the lock: exclusive creation of an empty file. A file left by a holder that died is waited out, not swept. */
async function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    let handle
    try {
      handle = openSync(lockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new InstructionsLockError(lockPath, LOCK_TIMEOUT_MS)
      await sleep(LOCK_POLL_MS)
      continue
    }
    closeSync(handle)
    return
  }
}

/** Release the lock: delete the file, backing off on a brief standoff (a reader, Windows). */
async function releaseLock(lockPath) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      unlinkSync(lockPath)
      return
    } catch (error) {
      const code = error?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      const busy = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!busy || attempt >= 4) throw error
      await sleep(50 * attempt)
    }
  }
}

async function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), tempName(basename(path)))
  let fd
  try {
    fd = openSync(tmp, 'wx')
    writeSync(fd, Buffer.from(withLf(text), 'utf8'))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    await renameWithRetry(tmp, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A handle that will not close goes away with the process; a failed cleanup must not cover
        // the original error that is about to be handed out.
      }
    }
    discardTemp(tmp)
    throw error
  }
}

let tempSequence = 0

function tempName(target) {
  tempSequence += 1
  const entropy = `${Date.now().toString(36)}-${tempSequence}-${Math.random().toString(36).slice(2, 10)}`
  return `.${target}.${entropy}.tmp`
}

/** A rename meeting a process that is reading (a brief standoff on Windows) backs off and retries. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= 4) throw error
      await sleep(50 * attempt)
    }
  }
}

function discardTemp(tmp) {
  try {
    unlinkSync(tmp)
  } catch {
    // If it will not clear, leave it — the original error is the thing to hand out.
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

// ═══ The init gate ═══════════════════════════════════════════════════════════

/** The two files whose presence is what "this record directory was set up" means here (a pure filesystem question). */
const INIT_MARKERS = ['.gitignore', '.gitattributes']

/** Whether this project's record directory counts as init-ed (the version of the engine's reading, for this folder's own use). */
export function isInitialized(root) {
  const dir = recordDir(root)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
  return INIT_MARKERS.every((marker) => {
    const path = join(dir, marker)
    return existsSync(path) && statSync(path).isFile()
  })
}

/** Refuse to change the account when the record directory was never set up: no byte lands, no directory is created. */
export function assertInitialized(root) {
  if (isInitialized(root)) return
  throw new Error(
    `${recordDir(root)} was never init-ed (missing ${INIT_MARKERS.join(' or ')}). Ask \`init\` first.`,
  )
}

// ═══ Small pieces ════════════════════════════════════════════════════════════

/** The first eight characters of an id: the short form a printed line shows. */
export function short(id) {
  return String(id).slice(0, 8)
}

/** One refusal about the line as written: `code = 2` is what such a line answers with (the core's own usage refusals answer 2). */
export class UsageError extends Error {
  constructor(sentence) {
    super(sentence)
    this.name = 'UsageError'
    this.code = 2
  }
}