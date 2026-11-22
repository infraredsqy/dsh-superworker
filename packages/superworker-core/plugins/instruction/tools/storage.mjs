/**
 * The landing spot of the instruction account, its vocabulary and the read and write of its own
 * fields: this plugin's own record layer.
 *
 * The account lives with the rest of this project's records, at
 * `<project root>/.superworker/instructions.json` — the same file, byte for byte, the engine wrote
 * before this folder owned it:
 *
 * - the whole document is written back as it was read: only the cells a verb changed differ, every
 *   other top-level key (a foreign section another tool keeps in the same file) comes back in its
 *   own place;
 * - key order is construction order, never sorted (the engine's writer sorts the two records that
 *   want sorting; this one does not);
 * - two-space indent, non-ASCII as it is, LF on every platform, no trailing newline; a write is
 *   atomic.
 *
 * **The account belongs to this plugin, and whoever owns a record writes it.** The record base —
 * the byte format, the atomic landing, the reader, the cross-process record lock, the moments — is
 * the engine's one foundation, reached only through the seam the host hands in (`ctx.base`, see
 * `src/plugins/base.ts` in the engine): every call below takes that `base` beside the project root
 * and keeps none of the mechanics here. What is left in this layer is the account's own: its
 * landing path, its lock path, its vocabulary, and the read and write of its own fields. The
 * account's bytes are the base's `writeJson` with no key sort — construction order — which is this
 * record's own habit, not a second byte rule.
 *
 * The moments a record carries (`at` / `resolved_at`) are the engine's SecondsTimestamp, taken
 * from the seam's `nowSeconds` — this layer keeps no clock of its own.
 *
 * The runtime hands in the base of a relative path as well: always resolved from the project root
 * `root` the host hands in (a plugin is given no working directory).
 *
 * Whether a record directory counts as init-ed is the engine's reading alone — this layer does not
 * answer that question a second time.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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
 * ending the answer had before this folder owned the verb, so a caller's line-anchored reading does
 * not depend on which machine answered. Deliberately the literal and not `base.EOL`: that cell is the
 * **platform** line ending, and taking it here would flip these answers to CRLF on Windows.
 */
export const EOL = '\n'

// ═══ Reading and writing ═════════════════════════════════════════════════════

/**
 * Read the whole document: absent means an empty account; bad bytes and unparsable text are the
 * base's decidable errors handed up as they are (`invalid_utf8` / `parse_failure`, the same
 * sentences the reader spells) and are never repaired automatically. A document whose top level is
 * not an object reads as an empty account (nothing in it could be one), the way the engine's reader
 * read it.
 */
export async function readInstructions(root, base) {
  const reading = await base.readJson(instructionsPath(root), 'instructions.json')
  if (reading.kind === 'missing') return { instructions: [] }
  const data = reading.value
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { instructions: [] }
  if (!Array.isArray(data.instructions)) data.instructions = []
  return data
}

/** Write the whole document: the base's atomic landing, this record's own key habit (construction order, never sorted). */
export async function writeInstructions(root, data, base) {
  await base.writeJson(instructionsPath(root), data)
}

// ═══ The other two records this layer reads (never writes) ═══════════════════

/** The line account: `state.json`'s `cycles` table, read as records. */
export async function readCycles(root, base) {
  const data = await readJsonRecord(join(recordDir(root), 'state.json'), 'state.json', base)
  return Array.isArray(data.cycles) ? data.cycles.filter(isRecord) : []
}

/** The graph: `ideas.json`'s `nodes` table, read as id → record. */
export async function readNodes(root, base) {
  const data = await readJsonRecord(join(recordDir(root), 'ideas.json'), 'ideas.json', base)
  const nodes = data.nodes
  return isRecord(nodes) ? nodes : {}
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One JSON record of another owner, read the way the engine reads it: absent is empty, unreadable reports, a non-object top level is empty. */
async function readJsonRecord(path, label, base) {
  const reading = await base.readJson(path, label)
  if (reading.kind === 'missing') return {}
  return isRecord(reading.value) ? reading.value : {}
}

// ═══ One read-modify-write at a time, in this process and across processes ═══

/**
 * Run one account "read → change → write" exclusively, through the seam's record lock under the
 * account's own lock path: inside this process, same-path bodies queue on the lock's promise chain;
 * across processes, the lock file (`instructionsLockPath`) is held from the snapshot through the
 * write, so a second process writing the same account waits instead of overwriting. One process runs
 * commands side by side (the panel's write while a session reads the account), and two bodies that
 * both took their snapshot before either landed would let the later snapshot drop the earlier write —
 * the account would come back missing an entry without a word.
 *
 * The protocol (exclusive creation, a 50 ms probe, a 10 s limit, a decidable `lock_timeout` naming
 * the path) is the base's, not this layer's; the path is this record's own.
 */
export function withInstructionsLock(root, body, base) {
  return base.withLock(instructionsLockPath(root), body, { label: 'instruction account' })
}

// ═══ Small pieces ════════════════════════════════════════════════════════════

/** The first eight characters of an id: the short form a printed line shows. */
export function short(id) {
  return String(id).slice(0, 8)
}
