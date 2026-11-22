/**
 * The landing spot of the issue pool, its constants and the read and write of its own fields: this
 * plugin's own record layer.
 *
 * The pool lives with the rest of this project's records, at `<project root>/.superworker/issues/issues.json`:
 * clearing `temp/` does not touch it, and it travels with the project wherever the project goes.
 * **The pool belongs to this plugin, and whoever owns a record writes it.** The record base — the
 * byte format, the atomic landing, the reader, the record lock, the moments — is the engine's one
 * foundation, reached only through the seam the host hands in (`ctx.base`, see `src/plugins/base.ts`
 * in the engine): every call below takes that `base` beside the project root and keeps none of the
 * mechanics here. What is left in this layer is the pool's own: its landing path, its lock path
 * (`<root>/.superworker/meta/issues.lock`, deliberately not the record tree's `ledger.lock` — two
 * records, two locks, and no operation holds both), its vocabulary, and the read and write of its
 * own fields (the pool's shape checks and the `issues` table). The pool's bytes are the base's
 * `writeJson` with the deep key sort — the same byte rules as the engine's own records (two-space
 * indent, non-ASCII as it is, deeply sorted keys, LF on every platform, no trailing newline), and
 * a write is atomic.
 *
 * The moment a record carries (`discovered` / `updated_at`) is the engine's MicroTimestamp, taken
 * from the seam's `nowMicro` — the pool does not keep a clock of its own.
 *
 * Whether a record directory counts as init-ed is the engine's reading alone — this layer does not
 * answer that question a second time.
 *
 * The runtime hands in the base of a relative path as well: always resolved from the project root
 * `root` the host hands in (a plugin is given no working directory).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The record directory's name is spelled here because a plugin's tool file cannot import the engine's constant.
const RECORD_DIR_NAME = '.superworker';

export function poolPath(root) {
  return join(root, RECORD_DIR_NAME, 'issues', 'issues.json');
}

/**
 * Where the pool's cross-process lock lands: `<root>/.superworker/meta/issues.lock`.
 *
 * Deliberately not the record tree's `ledger.lock`: the two records get two locks, so one protocol
 * can never stand in for the other, and no operation ends up holding both. The protocol itself is
 * the engine's one record lock, taken through the seam's `withLock` (exclusive creation, a 50 ms
 * probe, a 10 s limit, a decidable `lock_timeout` naming the path). A holder that dies mid-way
 * leaves the file behind and it is not swept: cleaning it up has a race of its own, the same
 * reason the engine gives.
 */
export function poolLockPath(root) {
  return join(root, RECORD_DIR_NAME, 'meta', 'issues.lock');
}

/** Issue status: `open` -> `acknowledged` -> `resolving` -> `resolved`, or `rejected` for one left unfixed. */
export const VALID_STATUSES = Object.freeze(['open', 'acknowledged', 'resolving', 'resolved', 'rejected']);
/** Severity: P0 is the heaviest (one P0 is worth eight P3s). */
export const VALID_SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
/** Disposition decision: we fix it / someone outside does / not settled yet. */
export const VALID_DECISIONS = Object.freeze(['autofix', 'external', 'unknown']);
/** Where it came from: found by a scan / entered by hand / an issue filed by a session that ran into it. */
export const VALID_SOURCES = Object.freeze(['scan', 'manual', 'conduct']);

/** Severity -> weight: the pool's weight is the sum of these. */
export const SEVERITY_WEIGHTS = Object.freeze({ P0: 8, P1: 4, P2: 2, P3: 1 });

/** The line ending of the text a command hands back to a person (stdout only); a record on disk is LF on every platform. */
export const EOL = process.platform === 'win32' ? '\r\n' : '\n';

// ═══ Reading and writing ═════════════════════════════════════════════════════

/**
 * Read the pool: absent means an empty pool; bad bytes and unparsable text are the base's
 * decidable errors handed up as they are (`invalid_utf8` / `parse_failure`, the same sentences the
 * reader spells) and are never repaired automatically. A file that parses but is not one pool
 * reports here: this shape is the pool's own.
 */
export async function readPool(root, base) {
  const path = poolPath(root);
  const reading = await base.readJson(path, 'issues.json');
  if (reading.kind === 'missing') return { version: 1, issues: {} };
  const data = reading.value;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('issues.json is not an object (one pool per file)');
  }
  const issues = data.issues;
  if (issues === undefined) data.issues = {};
  else if (issues === null || typeof issues !== 'object' || Array.isArray(issues)) {
    throw new Error('issues.json holds no "issues" table');
  }
  return data;
}

/** Write the whole pool: the base's atomic landing, the pool's own byte habit (deeply sorted keys). */
export async function writePool(root, data, base) {
  await base.writeJson(poolPath(root), data, { sortKeys: true });
}

// ═══ One read-modify-write at a time, in this process and across processes ═══

/**
 * Run one pool "read → change → write" exclusively, through the seam's record lock under the
 * pool's own lock path: inside this process, same-path bodies queue on a promise chain; across
 * processes, the lock file (`poolLockPath`) is held from the snapshot through the write, so a
 * second process writing the same pool waits instead of overwriting. One process can run commands
 * side by side (a session's `issue add` while a close-time pass reads the pool), and two bodies
 * that both took their snapshot before either landed would let the later snapshot drop the earlier
 * write — the pool would come back missing an issue without a word.
 *
 * A body must not take the lock again for the same pool; nothing in this folder calls one command
 * from inside another, so nothing ever would. The reading verbs stay out of the lock: a write
 * lands atomically, so a read never needs it and must not wait behind a write.
 */
export function withPoolLock(root, body, base) {
  return base.withLock(poolLockPath(root), body, { label: 'issue pool' });
}

// ═══ Small pieces ════════════════════════════════════════════════════════════

/** Where a repair plan lands: the directory is created (a relative spelling resolves from the project root). */
export function ensurePlanDir(root, planPath) {
  mkdirSync(dirname(resolve(root, planPath)), { recursive: true });
}

/** A relative path resolves against the project root (a plugin is given no working directory); the one spelling of that reading. */
export function resolveFrom(root, path) {
  return resolve(root, path);
}

export function missingIssue(id) {
  return new Error(`issue "${id}" not found`);
}
