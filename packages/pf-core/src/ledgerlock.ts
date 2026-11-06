import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PfError } from './errors.ts';
import { isExistingPath, sleep, unlinkWithRetry } from './fs-helpers.ts';
import { ledgerLockPath, type PfPaths } from './paths.ts';

/**
 * The cross-process lock: one lock per record tree —
 * `<pf>/meta/ledger.lock`, held through every "read → change → write" so that all writers of
 * records stay out of each other's way. The lock file exists while the lock is held and is empty.
 *
 * How it lands is up to the runtime: byte-range locks (msvcrt / fcntl) are released by the
 * operating system when the process dies, and Node's standard surface does not have one, so
 * exclusive creation is the mutex here — taking the lock is creating an empty file with wx,
 * releasing it is deleting that file. The path, the timeout limit, the polling cadence and the
 * decidable timeout error all follow this one reading; when a holder dies mid-way the lock file
 * stays behind, and the next one waits out the timeout and gets a decidable `lock_timeout`
 * instead of hanging silently.
 *
 * - Waiting has a limit (10 seconds by default), probing every 50 ms whether the file can be
 *   created exclusively; on timeout a `PfError('lock_timeout')` is thrown, nothing was changed,
 *   and who was waited for and how long are both in the error.
 * - The lock is registered by "the resolved lock path". In one process, same-path callers are
 *   serialized on a promise chain: a caller waits for the previous holder of the same path to
 *   release before it reaches the file, so two concurrent writers in one process cannot
 *   interleave their "read → change → write". A call made from inside the holding body is a
 *   re-entry: it stays on the same chain — it runs under the held lock instead of queueing
 *   behind itself — and only the outermost acquire / release touches the file. Re-entry of the
 *   holding process is not mutually exclusive, consistent with this reading (registration
 *   follows the process).
 * - Gatekeeping of the "this record does not allow writes at all" kind (`gate`) belongs to the
 *   init decision.
 */

/** The default limit for waiting on the lock: writing one record takes a few milliseconds, and the limit only guards against a deadlock — it is never reached in ordinary work. */
export const LEDGER_LOCK_TIMEOUT_MS = 10_000;

/** The probe interval: the release of a lock has no event to hang on (deleting a file across processes broadcasts nothing), so it is looked at on a cadence. */
export const LEDGER_LOCK_POLL_MS = 50;

/**
 * Which resolved lock path the running async extent currently holds: a call that sees its own
 * key here is a re-entry — it rejoins the holding body instead of queueing behind it.
 */
const holding = new AsyncLocalStorage<string>();

/** The tail of the chain of same-path holders in this process; the key is the resolved lock path. */
const chains = new Map<string, Promise<unknown>>();

export interface LedgerLockOptions {
  /** The limit for waiting on the lock (milliseconds); `LEDGER_LOCK_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
}

/** Hold the lock through one "read → change → write". Not getting the lock throws `PfError('lock_timeout')`. */
export async function withLedgerLock<T>(
  paths: PfPaths,
  body: () => Promise<T>,
  options: LedgerLockOptions = {},
): Promise<T> {
  const path = ledgerLockPath(paths);
  const key = resolve(path);
  if (holding.getStore() === key) {
    return body();
  }
  const timeoutMs = options.timeoutMs ?? LEDGER_LOCK_TIMEOUT_MS;
  const base: Promise<unknown> = chains.get(key) ?? Promise.resolve();
  const claim = base.then(() =>
    holding.run(key, async () => {
      await acquire(path, timeoutMs);
      try {
        return await body();
      } finally {
        await release(path);
      }
    }),
  );
  // The chain lives on past a failed claim, so the next same-path caller still reaches the file.
  const settled = claim.catch(() => undefined);
  chains.set(key, settled);
  // An idle lock leaves nothing behind: when the tail settles unclaimed, its entry is removed.
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return claim;
}

async function acquire(path: string, timeoutMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      if (!isExistingPath(error)) throw error;
      if (Date.now() >= deadline) {
        throw new PfError(
          'lock_timeout',
          path,
          `the ledger lock ${path} stayed busy for ${timeoutMs} ms; another process is ` +
            'mid-write. If you are sure nobody is writing right now, delete that path and run ' +
            'again: an empty lock file is the only thing a holder that died leaves behind. ' +
            'Nothing was changed.',
          { cause: error },
        );
      }
      await sleep(LEDGER_LOCK_POLL_MS);
      continue;
    }
    await handle.close();
    return;
  }
}

/**
 * Delete the lock file: the foundation's one unlink protocol (`fs-helpers.unlinkWithRetry`), the same
 * retry a record file's removal takes. A file that is already gone counts as released, and a brief
 * standoff backs off and retries in both of its spellings — the two PermissionError codes and Node on
 * Windows' own `EBUSY`; giving up here would leave the lock file on disk, and the next acquire would
 * wait out the whole timeout before reporting `lock_timeout`.
 */
async function release(path: string): Promise<void> {
  await unlinkWithRetry(path);
}
