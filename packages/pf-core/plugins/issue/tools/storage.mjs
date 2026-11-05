/**
 * The landing spot of the issue pool, its constants and the low-level read and write: this
 * plugin's own record layer.
 *
 * The pool lives with the rest of this project's records, at `<project root>/.pf/issues/issues.json`:
 * clearing `temp/` does not touch it, and it travels with the project wherever the project goes.
 * Record io has its one foundation on the core side (`src/jsonio.ts`), and that foundation serves
 * the core's four records and never goes into the package exports; a plugin is given no way to read
 * the records a second time (the host hands in a context holding `root` and the snapshots it has
 * already read), so this layer carries the pool's reads and writes itself — the same byte-level rules
 * as core (two-space indent, non-ASCII as it is, deeply sorted keys, LF on every platform, no
 * trailing newline), and a write is atomic.
 *
 * The runtime hands in two facts:
 * - Locking: a write lands atomically (a temp file in the target's own directory is renamed over
 *   it), so a reader never sees half a record; and every "read → change → write" of one command
 *   runs exclusively against the other commands of **this process** through `withPoolLock` below,
 *   so a write that took its snapshot before another one landed cannot put that one back out of the
 *   pool. Nothing here locks across processes: core's own lock is a module-level exclusive-create
 *   mutex that is not shared with a plugin, plugin commands run inside the host's process, and two
 *   processes writing the same pool at once are still last-writer-wins.
 * - The base of a relative path: always resolved from the project root `root` the host hands in
 *   (a plugin is given no working directory).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// ═══ Paths and constants ═════════════════════════════════════════════════════

export function poolPath(root) {
  return join(root, '.pf', 'issues', 'issues.json');
}

/** Where the record directory lands: `<root>/.pf` (the path `init` looks for). */
export function ledgerDir(root) {
  return join(root, '.pf');
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

// ═══ Moments ═════════════════════════════════════════════════════════════════

const PAD_WIDTH = 2;

function pad(value, width = PAD_WIDTH) {
  return String(value).padStart(width, '0');
}

/** The microsecond spelling of one epoch-microsecond reading (UTC with a literal Z). */
export function microTimestampOf(epochUs) {
  const epochMs = Math.floor(epochUs / 1000);
  const microRemainder = epochUs - epochMs * 1000;
  const moment = new Date(epochMs);
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}` +
    `T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}` +
    `.${pad(moment.getUTCMilliseconds() * 1000 + microRemainder, 6)}Z`
  );
}

// Anchor of the microsecond clock: the wall clock only has millisecond coarseness, so the
// microsecond remainder is made up from the monotonic clock's elapsed time; when the two readings
// drift more than a millisecond apart, the anchor is taken again. Strictly increasing within the
// process — two writes inside one millisecond each get their own moment.
let anchorWallUs = 0;
let anchorNs = 0n;
let lastUs = Number.NEGATIVE_INFINITY;

const REANCHOR_TOLERANCE_US = 1000;

function epochMicros() {
  const wallMs = Date.now();
  const ns = process.hrtime.bigint();
  if (anchorNs === 0n) {
    anchorWallUs = wallMs * 1000;
    anchorNs = ns;
  }
  let us = anchorWallUs + Number((ns - anchorNs) / 1000n);
  if (Math.abs(wallMs * 1000 - us) > REANCHOR_TOLERANCE_US) {
    anchorWallUs = wallMs * 1000;
    anchorNs = ns;
    us = anchorWallUs;
  }
  if (us <= lastUs) us = lastUs + 1;
  lastUs = us;
  return us;
}

/** The microsecond spelling of this moment: the shape of `discovered` / `updated_at` in the pool. */
export function now() {
  return microTimestampOf(epochMicros());
}

// ═══ The bytes of one record on disk ═════════════════════════════════════════

/** Keys are compared by code point, not in UTF-16 code unit order. */
function compareCodePoints(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const difference = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const source = value;
    const sorted = {};
    for (const key of Object.keys(source).sort(compareCodePoints)) sorted[key] = sortDeep(source[key]);
    return sorted;
  }
  return value;
}

/** The bytes of one record: two-space indent, non-ASCII as it is, deeply sorted keys, LF on every platform (the same bytes whichever machine wrote them), no trailing newline. */
export function jsonBytes(value) {
  const text = JSON.stringify(sortDeep(value), null, 2);
  if (text === undefined) throw new TypeError('the pool holds a value JSON cannot spell');
  return text;
}

// ═══ Reading and writing ═════════════════════════════════════════════════════

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read the pool: absent means an empty pool; bad bytes and unparsable text report on the spot and are never repaired automatically. */
export function readPool(root) {
  const path = poolPath(root);
  if (!existsSync(path)) return { version: 1, issues: {} };
  let text;
  try {
    text = strictUtf8.decode(readFileSync(path));
  } catch (error) {
    throw new Error(`issues.json is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`issues.json parse failure: ${error instanceof Error ? error.message : String(error)}`);
  }
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

/** Write the whole pool: the temporary file lands in the target's own directory, is fsynced, then renamed over it. */
export async function writePool(root, data) {
  await atomicWriteBytes(poolPath(root), jsonBytes(data));
}

// ═══ One read-modify-write at a time, inside this process ════════════════════

/** The tail of the queue per pool path: the body queued behind it starts once this settles. */
const poolTails = new Map();

/**
 * Run one pool "read → change → write" exclusively inside this process.
 *
 * One process runs commands side by side (a session's `issue add` while a close-time pass reads
 * the pool, a batch import beside a mark), and two bodies that both took their snapshot before
 * either landed would let the later snapshot drop the earlier write — the pool would come back
 * missing an issue without a word. The bodies therefore queue on the pool's resolved path: each one
 * starts only after every body queued before it on the same pool has settled, and the next one
 * waits for this one. A body must not take the lock again for the same pool (there is no re-entry
 * here); nothing in this folder calls one command from inside another, so nothing ever would.
 *
 * The queue is keyed by the pool path, so two projects do not wait for each other, and it is
 * dropped as soon as it drains (an idle pool leaves nothing behind). A body that throws releases
 * the queue just the same, and only the atomic write's own bytes ever reach the disk: this orders
 * the writers of one process, it does not lock the file across processes.
 */
export function withPoolLock(root, body) {
  const key = poolPath(root);
  const previous = poolTails.get(key) ?? Promise.resolve();
  const run = previous.then(body, body);
  const settled = run.then(() => undefined, () => undefined);
  poolTails.set(key, settled);
  void settled.then(() => {
    if (poolTails.get(key) === settled) poolTails.delete(key);
  });
  return run;
}

async function atomicWriteBytes(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), tempName(basename(path)));
  let fd;
  try {
    fd = openSync(tmp, 'wx');
    writeSync(fd, Buffer.from(text, 'utf8'));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    await renameWithRetry(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A handle that will not close goes away with the process; a failed cleanup must not
        // cover the original error that is about to be handed out.
      }
    }
    discardTemp(tmp);
    throw error;
  }
}

let tempSequence = 0;

function tempName(target) {
  tempSequence += 1;
  const entropy = `${Date.now().toString(36)}-${tempSequence}-${Math.random().toString(36).slice(2, 10)}`;
  return `.${target}.${entropy}.tmp`;
}

/** A rename meeting a process that is reading (a brief standoff on Windows) backs off and retries. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(50 * attempt);
    }
  }
}

function discardTemp(tmp) {
  try {
    unlinkSync(tmp);
  } catch {
    // If it will not clear, leave it — the original error is the thing to hand out.
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// ═══ Small pieces ════════════════════════════════════════════════════════════

/** Where a repair plan lands: the directory is created (a relative spelling resolves from the project root). */
export function ensurePlanDir(root, planPath) {
  mkdirSync(dirname(resolve(root, planPath)), { recursive: true });
}

export function absolutePlanPath(root, planPath) {
  return resolve(root, planPath);
}

/** Whether this record directory counts as initialized: the directory is there and both markers are there (the reading of `src/initledger.ts`). */
export function isInitialized(root) {
  const dir = ledgerDir(root);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return ['.gitignore', '.gitattributes'].every((marker) => {
    const path = join(dir, marker);
    return existsSync(path) && statSync(path).isFile();
  });
}

/** A relative path resolves against the project root (a plugin is given no working directory). */
export function resolveFrom(root, path) {
  return resolve(root, path);
}

export function missingIssue(id) {
  return new Error(`issue "${id}" not found`);
}