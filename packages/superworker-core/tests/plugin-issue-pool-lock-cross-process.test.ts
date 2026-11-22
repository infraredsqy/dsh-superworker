import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The surface under test is the plugin folder's own implementation (the very files the host loads
// by path), plus the worker fixture that runs it in a second process. The record base the plugin
// takes its mechanics from is handed in the way the host hands it in.
import { pluginBase } from '../src/plugins/base';
import { withPoolLock, poolLockPath } from '../plugins/issue/tools/storage.mjs';
import { SLOW } from './helpers/slow';

/**
 * The pool's one-writer rule **across processes**, and its recovery from a holder that died.
 *
 * The in-process queue is `plugin-issue-pool-lock.test.ts`; this file pins the other half: two
 * processes each adding one issue must both be in the pool. The overlap is brought about for real
 * — a worker takes the lock, snapshots the pool, announces `HELD`, and only writes after a pause;
 * the second process starts during that pause. Without the lock file the second write lands inside
 * the window and the first snapshot puts it back out; with it, the second process waits. The same
 * pause is opened from **both** sides in the second case, so neither the test's start order nor a
 * lucky scheduling gap can stand in for the lock.
 *
 * The crash case is the residue half of the same contract: a worker that dies mid-write leaves a
 * temporary file and the lock file behind, the pool itself is untouched, and — once the lock file
 * is cleared, the one recovery step the lock error's own sentence describes — the next process
 * writes normally, without the residue disturbing read or write.
 */

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);

// The worker loads the engine's .ts (the record base): --experimental-strip-types exists from 22.6
// on, 23.6+/24+ load it natively; only 22.0–22.5, which truly has no flag, skips the slow cases.
const workerLoadsTs = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

let root: string;

const POOL = (): string => join(root, '.superworker', 'issues', 'issues.json');

/** The ids in the pool as it stands on disk, sorted. */
function pooledIds(): string[] {
  const data = JSON.parse(readFileSync(POOL(), 'utf8')) as { issues: Record<string, unknown> };
  return Object.keys(data.issues).sort();
}

/** The pool directory's leftover temporary files (the writer's own naming shape). */
function tempResidues(): string[] {
  const dir = join(root, '.superworker', 'issues');
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

const workerPath = fileURLToPath(new URL('./fixtures/issue-pool-worker.mjs', import.meta.url));

interface WorkerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunningWorker {
  /** Settles when the process is gone. */
  readonly done: Promise<WorkerResult>;
  /** Resolves once the worker's stdout carries this text (the worker prints its own handshake). */
  readonly whenOutput: (needle: string) => Promise<void>;
}

function startWorker(args: string[]): RunningWorker {
  // Below 24 a .ts file will not load without the flag (native support starts at 23.6+); from 22.6
  // on, --experimental-strip-types is enough.
  const loadTsArgs = workerLoadsTs && nodeMajor < 24 ? ['--experimental-strip-types'] : [];
  const child = spawn(process.execPath, [...loadTsArgs, workerPath, ...args], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ needle: string; resolveSeen: () => void }> = [];
  const settleWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (stdout.includes(waiter.needle)) {
        waiters.splice(index, 1);
        waiter.resolveSeen();
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    settleWaiters();
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<WorkerResult>((resolveDone) => {
    child.on('close', (code) => {
      resolveDone({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
  // The handshake hangs on the stdout event; a worker that dies before printing it fails the wait
  // with its own output instead of leaving the case to time out.
  const whenOutput = (needle: string): Promise<void> =>
    Promise.race([
      new Promise<void>((resolveSeen) => {
        waiters.push({ needle, resolveSeen });
        settleWaiters();
      }),
      done.then((result) => {
        throw new Error(`worker exited before "${needle}" (code ${String(result.code)}): ${result.stderr}`);
      }),
    ]);
  return { done, whenOutput };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-issue-xproc-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!SLOW)('two processes writing one pool', () => {
  it('a write held through its read → write window makes the other process wait: both issues are in the pool', async () => {
    const holder = startWorker(['slow', root, 'slow', '600']);
    await holder.whenOutput('HELD');
    const contender = startWorker(['add', root, 'fast']);
    const [held, added] = await Promise.all([holder.done, contender.done]);
    expect(held.code).toBe(0);
    expect(added.code).toBe(0);
    // A loss here would be silent: both commands report success either way, the pool is the witness.
    expect(pooledIds()).toEqual(['fast', 'slow']);
    // The lock is released when the last writer is done, not left behind for the next run.
    expect(existsSync(poolLockPath(root))).toBe(false);
  }, 20_000);

  it('two processes each adding one issue at the same time: both land', async () => {
    // Both sides run the slow writer, so the same overlap happens on both sides: each takes its
    // snapshot, then pauses, then writes. Without the lock file both snapshots are empty and the
    // later write puts the earlier one back out; with it, one of them waits — its snapshot is
    // taken only after the other's write — and both survive. Both workers are started before
    // either handshake is awaited, so the test's own ordering does not serialize them.
    const first = startWorker(['slow', root, 'first', '900']);
    const second = startWorker(['slow', root, 'second', '900']);
    await Promise.all([first.whenOutput('HELD'), second.whenOutput('HELD')]);
    const [one, two] = await Promise.all([first.done, second.done]);
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    // Neither side is told about a loss; the pool is the only witness.
    expect(pooledIds()).toEqual(['first', 'second']);
    expect(existsSync(poolLockPath(root))).toBe(false);
  }, 20_000);
});

describe.skipIf(!SLOW)('a holder that died mid-write: the residue is recoverable', () => {
  it('the temp file and the lock file are left behind, the pool is untouched, and the next write is normal once the lock is cleared', async () => {
    // The crash: lock taken, pool read, a temp file on disk, then a hard exit — nothing renamed,
    // the lock never released. Exit code 1 is the worker's own.
    const crasher = startWorker(['crash', root, 'ghost']);
    const crashed = await crasher.done;
    expect(crashed.code).toBe(1);
    // What a holder that died mid-write leaves: its temporary file, its lock file — and the pool
    // itself as it was (the temp was never renamed onto it, so there is no pool file yet).
    expect(tempResidues()).toHaveLength(1);
    expect(existsSync(poolLockPath(root))).toBe(true);
    expect(existsSync(POOL())).toBe(false);

    // The one recovery step the lock error's sentence describes: a person, sure nobody is writing,
    // deletes the lock path. The residue temp stays where it is — clearing it is nobody's urgent
    // business, and the next write must not need it gone.
    unlinkSync(poolLockPath(root));

    // The next process writes normally: the residue does not disturb read or write.
    const adder = startWorker(['add', root, 'recovered']);
    const added = await adder.done;
    expect(added.code).toBe(0);
    // Neither side is told about a loss or a gain: the pool is the only witness.
    expect(pooledIds()).toEqual(['recovered']);
  }, 20_000);
});

describe("the pool's lock is its own file", () => {
  it('a write holds `<root>/.superworker/meta/issues.lock` and never the record tree\'s `ledger.lock`', async () => {
    const ledgerLock = join(root, '.superworker', 'meta', 'ledger.lock');
    const seen: boolean[] = [];
    await withPoolLock(root, async () => {
      seen.push(existsSync(poolLockPath(root)), existsSync(ledgerLock));
    }, pluginBase());
    expect(seen).toEqual([true, false]);
    expect(existsSync(poolLockPath(root))).toBe(false);
  });
});
