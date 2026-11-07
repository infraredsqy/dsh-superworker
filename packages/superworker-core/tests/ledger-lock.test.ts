import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isRecordError, type RecordError } from '../src/errors.ts';
import { withLedgerLock } from '../src/ledgerlock.ts';
import { ledgerLockPath, recordPaths, type RecordPaths } from '../src/paths.ts';

/**
 * The cross-process lock: while held, the lock file exists and is empty; released, it is gone.
 * The same process may re-enter, and only the outermost frame writes to disk. Two record trees
 * give two unrelated locks. Two processes writing the same record at once make one wait and one
 * write. Waiting past the timeout yields a judgeable lock_timeout, never a quiet carry-on.
 * The two cross-process cases go through a worker (tests/fixtures/lock-worker.mjs): Node
 * 22.6–23.x loads it through runWorker with --experimental-strip-types, 24+ loads it natively,
 * and only 22.0–22.5 skips.
 */

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);

// The worker has to load src's .ts: --experimental-strip-types exists from 22.6 on (enough for
// TS that is nothing but type annotations), 23.6+/24+ load it natively; only 22.0–22.5, which
// truly has no flag, skips the two cross-process cases.
const workerLoadsTs = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

let workdir: string | undefined;

function tempPaths(): RecordPaths {
  workdir = mkdtempSync(join(tmpdir(), 'superworker-lock-'));
  return recordPaths(workdir);
}

afterEach(() => {
  if (workdir !== undefined) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

// Wait for the other process to take the lock (the lock file appears): there is no callback to
// hang on the other process, and fs.watch is unreliable over a meta/ directory that does not
// exist yet, so this is a bounded handshake poll (a look every 10ms, 5 seconds at most).
function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  return new Promise((resolveWait, rejectWait) => {
    const tick = (): void => {
      if (condition()) {
        resolveWait();
        return;
      }
      if (Date.now() > deadline) {
        rejectWait(new Error(`timed out waiting for: ${what}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const workerPath = fileURLToPath(new URL('./fixtures/lock-worker.mjs', import.meta.url));

interface WorkerResult {
  code: number | null;
  stdout: string;
}

function runWorker(args: string[]): Promise<WorkerResult> {
  return new Promise((resolveRun) => {
    // Below 24 a .ts file will not load without the flag (native support starts at 23.6+); from 22.6 on, --experimental-strip-types is enough.
    const loadTsArgs = nodeMajor < 24 ? ['--experimental-strip-types'] : [];
    const child = spawn(process.execPath, [...loadTsArgs, workerPath, ...args], { windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('close', (code) => {
      resolveRun({ code, stdout: stdout.trim() });
    });
  });
}

describe('in-process lock invariants', () => {
  it('while held the lock file exists and is empty; once released it is gone', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    let observedSize = -1;
    await withLedgerLock(paths, async () => {
      observedSize = statSync(lock).size;
    });
    expect(observedSize).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('a lock file nobody is releasing: a decidable lock_timeout naming the path, and how to clear it', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    // A 0-byte file is the whole of what a holder that died leaves behind (an older protocol kept
    // one resident, and this reading is what made it wait 10 seconds before saying so).
    mkdirSync(join(paths.recordDir, 'meta'), { recursive: true });
    writeFileSync(lock, '');
    const failure: unknown = await withLedgerLock(paths, async () => 'never reached', { timeoutMs: 0 }).catch(
      (error: unknown) => error,
    );
    expect(isRecordError(failure, 'lock_timeout')).toBe(true);
    const error = failure as RecordError;
    // The code is the contract; the sentence still has to let a person act on their own.
    expect(error.path).toBe(lock);
    expect(error.message).toContain(lock);
    expect(error.message).toContain('delete that path');
    // Nothing is swept for the caller: clearing a lock file stays a person's call.
    expect(existsSync(lock)).toBe(true);
  });

  it('re-entrant within one process: nested holds do not stall, and only the outermost frame writes to disk', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    const seen: string[] = [];
    await withLedgerLock(paths, async () => {
      seen.push(`outer:${existsSync(lock)}`);
      await withLedgerLock(paths, async () => {
        seen.push(`inner:${existsSync(lock)}`);
      });
      seen.push(`back:${existsSync(lock)}`);
    });
    expect(seen).toEqual(['outer:true', 'inner:true', 'back:true']);
    expect(existsSync(lock)).toBe(false);
  });

  it('two concurrent writers in one process: both changes land, neither is lost', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    const readTokens = (): string[] => {
      if (!existsSync(paths.stateJson)) return [];
      return (JSON.parse(readFileSync(paths.stateJson, 'utf8')) as { tokens: string[] }).tokens;
    };
    const appendToken = (token: string, base: string[]): void => {
      writeFileSync(paths.stateJson, JSON.stringify({ tokens: [...base, token] }), 'utf8');
    };
    // The first writer parks mid-body with the lock held: base state read, write not yet made.
    let openFirst: (() => void) | undefined;
    const firstAtGate = new Promise<void>((resolveGate) => {
      openFirst = resolveGate;
    });
    let releaseFirst: (() => void) | undefined;
    const firstThroughGate = new Promise<void>((resolveThrough) => {
      releaseFirst = resolveThrough;
    });
    const first = withLedgerLock(paths, async () => {
      const base = readTokens();
      openFirst!();
      await firstThroughGate;
      appendToken('first', base);
    });
    await firstAtGate;
    // The lock is provably held mid-body here: start the second writer from outside, then let the first finish. The invariant under test: both changes land, none lost (arrival order is not pinned).
    const second = withLedgerLock(paths, async () => {
      appendToken('second', readTokens());
    });
    releaseFirst!();
    await Promise.all([first, second]);
    const tokens = (JSON.parse(readFileSync(paths.stateJson, 'utf8')) as { tokens: string[] }).tokens;
    expect([...tokens].sort()).toEqual(['first', 'second']);
    expect(existsSync(lock)).toBe(false);
  });

  it('two record trees, two locks: held at the same time, they do not interfere', async () => {
    const first = tempPaths();
    const second = tempPaths();
    await withLedgerLock(first, async () => {
      await withLedgerLock(second, async () => {
        expect(existsSync(ledgerLockPath(first))).toBe(true);
        expect(existsSync(ledgerLockPath(second))).toBe(true);
      });
    });
    expect(existsSync(ledgerLockPath(first))).toBe(false);
    expect(existsSync(ledgerLockPath(second))).toBe(false);
  });
});

describe.skipIf(!workerLoadsTs)('cross-process lock behaviour', () => {
  it('two writers on one record at once: one waits, one writes, and the record is always whole', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    const holder = runWorker(['hold', paths.root, paths.stateJson, '700']);
    await waitFor(() => existsSync(lock), 'the lock holder has the lock');

    const startedAt = Date.now();
    const contender = runWorker(['contend', paths.root, paths.stateJson, 'contender', '10000']);
    const result = await contender;
    const waitedMs = Date.now() - startedAt;

    expect(result.stdout).toBe('ACQUIRED');
    expect(result.code).toBe(0);
    expect(waitedMs).toBeGreaterThanOrEqual(300);
    // The contender writes the last one: the record is whole, parses, and holds its payload.
    expect(JSON.parse(readFileSync(paths.stateJson, 'utf8'))).toEqual({ payload: 'contender' });

    await holder;
    // Releasing the lock means deleting the file; on Windows a deleted directory entry may stay visible for a moment, so wait for it to go before asserting.
    await waitFor(() => !existsSync(lock), 'the lock holder lets go');
  }, 15000);

  it('waiting past the timeout: a judgeable lock_timeout, nothing written, no quiet carry-on', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    const holder = runWorker(['hold', paths.root, paths.stateJson, '1200']);
    await waitFor(() => existsSync(lock), 'the lock holder has the lock');

    const startedAt = Date.now();
    const contender = runWorker(['contend', paths.root, paths.stateJson, 'contender', '300']);
    const result = await contender;
    const waitedMs = Date.now() - startedAt;
    // The contender already stopped at the timeout; the holder finishes on its own, and it is collected here so that no dangling process is left behind.
    const holderResult = await holder;
    expect(holderResult.code).toBe(0);

    expect(result.stdout).toBe('TIMEOUT:lock_timeout');
    expect(result.code).toBe(3);
    expect(waitedMs).toBeLessThan(1100);
    // The side that timed out wrote nothing: the record holds only the one the holder wrote at the start.
    expect(JSON.parse(readFileSync(paths.stateJson, 'utf8'))).toEqual({ payload: 'holder' });
    await waitFor(() => !existsSync(lock), 'the lock holder lets go');
  }, 15000);
});
