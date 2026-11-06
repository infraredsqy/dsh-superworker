import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigNamespace } from '../src/config.ts';
import { globalConfigPath } from '../src/paths.ts';

/**
 * The machine layer ( `<home>/.pf/config.json` ) is one record file with one writer at a time, across
 * processes too — the same rule the project tree's records live under, on a file that belongs to no
 * project tree. Its lock is the machine record directory's own ledger lock
 * (`<home>/.pf/meta/ledger.lock`): the same protocol and a file of its own, never the project's.
 *
 * The overlap is brought about for real, and nothing here leans on a pause: a worker takes the
 * machine lock, snapshots `{}` — the stale reading — and announces `HELD`, and it will not write or
 * let go until this process tells it to. This process then runs its real `set --global` and, instead
 * of hoping it lands inside a fixed window, **waits for the write path to be refused by that lock**:
 * the stub below counts the `open(lock, 'wx')` attempts that come back `EEXIST`. Two refusals are a
 * whole retry cycle of the acquire loop, and they can only happen while the holder has the file — a
 * write that never asks the lock lands without a single refusal (that is the red side). Only then is
 * the holder told to write. Both keys in the file afterwards witness the ordering: the stale
 * snapshot went down first, and the second writer read the fresh file inside the lock instead of
 * rewriting its own stale reading over it.
 */

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);

// The worker loads src's .ts: --experimental-strip-types exists from 22.6 on (enough for TS that is
// nothing but type annotations), 23.6+/24+ load it natively; only 22.0–22.5, which truly has no
// flag, skips the case.
const workerLoadsTs = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

/**
 * Every `open(…, 'wx')` that was refused because the file was already there, in this process.
 *
 * The count lives here because the mock above is hoisted above every case; what a case waits on is
 * still its own — `beforeEach` empties this list, so "refused twice" can only ever be counted from
 * the case that is asking. Left across cases, a second case would start with the first one's
 * refusals in hand and read as blocked before it had waited at all.
 */
const refusals = vi.hoisted(() => {
  const paths: string[] = [];
  const waiters: Array<{ path: string; count: number; done: () => void }> = [];
  const reset = (): void => {
    paths.length = 0;
    waiters.length = 0;
  };
  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (paths.filter((path) => path === waiter.path).length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.done();
      }
    }
  };
  return { paths, waiters, notify, reset };
});

// The one seam this case needs: an exclusive creation meeting a file that is already there. It
// records the refusal and then rethrows — nothing about the call itself is changed.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = actual.open as (path: string, flags?: string, mode?: number) => Promise<unknown>;
  return {
    ...actual,
    open: async (path: string, flags?: string, mode?: number): Promise<unknown> => {
      try {
        return await open(path, flags, mode);
      } catch (error) {
        if (flags === 'wx' && (error as { code?: string }).code === 'EEXIST') {
          refusals.paths.push(resolve(path));
          refusals.notify();
        }
        throw error;
      }
    },
  };
});

let root: string;
let home: string;
let workers: ChildProcess[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-config-global-xproc-'));
  // A settings verb is only answered inside a directory that holds a `.pf` of its own.
  mkdirSync(join(root, '.pf'), { recursive: true });
  home = join(root, '_home');
  workers = [];
  // Each case counts its own refusals: a list carried over from the case before would make the wait
  // below answer for work this case never saw.
  refusals.reset();
});

afterEach(() => {
  // A case that fails before telling the holder to finish must not leave a process behind.
  for (const worker of workers) worker.kill();
  workers = [];
  rmSync(root, { recursive: true, force: true });
});

const workerPath = fileURLToPath(new URL('./fixtures/config-global-worker.mjs', import.meta.url));

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
  /** Deliver one line on the worker's stdin: its next step is gated on it. */
  readonly send: (line: string) => void;
}

function startWorker(args: string[]): RunningWorker {
  // Below 24 a .ts file will not load without the flag (native support starts at 23.6+); from 22.6
  // on, --experimental-strip-types is enough.
  const loadTsArgs = nodeMajor < 24 ? ['--experimental-strip-types'] : [];
  const child = spawn(process.execPath, [...loadTsArgs, workerPath, ...args], { windowsHide: true });
  workers.push(child);
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
  // A write to a worker that is already gone reports nothing useful here; `done` says why it went.
  child.stdin.on('error', () => undefined);
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
  const send = (line: string): void => {
    child.stdin.write(`${line}\n`);
  };
  return { done, whenOutput, send };
}

/** The machine layer's lock file: the machine record directory's own ledger lock. */
function machineLock(): string {
  return join(home, '.pf', 'meta', 'ledger.lock');
}

/**
 * Resolve once the write path has been refused by `path` `count` times — the acquire loop ran a
 * whole retry cycle and is still waiting. Resolves to `'blocked'`.
 */
function whenLockRefuses(path: string, count: number): Promise<'blocked'> {
  const wanted = resolve(path);
  return new Promise<'blocked'>((done) => {
    refusals.waiters.push({ path: wanted, count, done: () => done('blocked') });
    refusals.notify();
  });
}

describe.skipIf(!workerLoadsTs)('two processes writing the machine layer', () => {
  it('a write held through its read → write window makes the other process wait: both keys are in the file', async () => {
    const config = createConfigNamespace(root, { homeDir: home });
    // The slow writer takes the machine lock, snapshots `{}`, and announces HELD; it writes its
    // snapshot and lets go only when told to, so the window is as wide as this case needs.
    const holder = startWorker(['slow', home]);
    await holder.whenOutput('HELD');
    // While it is held, the lock file is the machine record directory's own — not a project tree's.
    expect(existsSync(machineLock())).toBe(true);

    // The second writer's real `set` inside that window. It either lands (no lock in the write path)
    // or keeps being refused by the lock — the refusal is the witness that it is waiting on it.
    const attempt = config.set('test_tier', 'minimal', { global: true });
    const outcome = await Promise.race([
      whenLockRefuses(machineLock(), 2),
      attempt.then(() => 'landed' as const),
      holder.done.then((result) => {
        throw new Error(`holder exited early (code ${String(result.code)}): ${result.stderr}`);
      }),
    ]);
    expect(outcome, 'the write landed while another process held the machine lock').toBe('blocked');
    // Still held, and this process really is the one being held out of it.
    expect(existsSync(machineLock())).toBe(true);

    // Let go: the holder lands its stale snapshot first, then drops the lock; only after that does
    // this process's write land, reading the fresh file inside the lock.
    holder.send('WROTE');
    await attempt;
    const result = await holder.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('RELEASED');
    // A loss here is silent: both commands report success either way, the file is the witness.
    expect(JSON.parse(readFileSync(globalConfigPath(home), 'utf8'))).toEqual({
      max_agents: 4,
      test_tier: 'minimal',
    });
    // Released when the last writer is done, not left behind for the next run to wait out.
    expect(existsSync(machineLock())).toBe(false);
  }, 20_000);
});
