import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The surface under test is this plugin folder's own implementation (the very files the host loads
// by path), plus the one entry the pool's read-modify-write goes through.
import { main as issue } from '../plugins/issue/tools/commands.mjs';
import { withPoolLock } from '../plugins/issue/tools/storage.mjs';

/**
 * The pool's one-writer rule inside one process.
 *
 * One process runs commands side by side; when two of them take their snapshot of the pool before
 * either write landed, the pool comes back without one of the two issues and nobody is told. The
 * overlap is brought about for real below: the first write misses its rename once, which sends it
 * back for the retry the atomic write already backs off from — while it waits, the second command
 * runs all the way through unless something queues it.
 *
 * The "rename blocked" step is forced through a module double: everything but `renameSync` is the
 * real implementation (the plugin reads and writes with `node:fs`'s synchronous surface).
 */

const renameProbe = vi.hoisted(() => ({ failRemaining: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: unknown, to: unknown) => {
      if (renameProbe.failRemaining > 0) {
        renameProbe.failRemaining -= 1;
        const error = new Error('rename blocked (test double)') as { code?: string };
        error.code = 'EPERM';
        throw error;
      }
      return actual.renameSync(from as string, to as string);
    },
  };
});

let root: string;

const POOL = (): string => join(root, '.superworker', 'issues', 'issues.json');

/** The ids in the pool as it stands on disk, sorted. */
function pooledIds(): string[] {
  const data = JSON.parse(readFileSync(POOL(), 'utf8')) as { issues: Record<string, unknown> };
  return Object.keys(data.issues).sort();
}

async function run(argv: string[]): Promise<string> {
  const main = issue as (argv: string[], ctx: { root: string }) => Promise<unknown>;
  return String(await main(argv, { root }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-issue-lock-'));
  renameProbe.failRemaining = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('two writes at once', () => {
  it('a write that lost its rename once cannot drop the write that ran in the meantime: both issues are in the pool', async () => {
    renameProbe.failRemaining = 1;
    const first = run(['add', '--id', 'first', '--title', 'First']);
    const second = run(['add', '--id', 'second', '--title', 'Second']);
    const answers = await Promise.all([first, second]);
    // The double ate the missed rename: had it not been hit, neither write would have looked at a
    // snapshot the other one had already replaced, and this test would pass without the queue.
    expect(renameProbe.failRemaining).toBe(0);
    // Both commands report success: a loss here would be silent, which is the whole point.
    expect(answers[0]).toContain('Issue created: first');
    expect(answers[1]).toContain('Issue created: second');
    expect(pooledIds()).toEqual(['first', 'second']);
  });

  it('every mutating verb goes through the same queue: a write waits for the one in front of it', async () => {
    await run(['add', '--id', 'seed', '--title', 'Seed']);
    // The same overlap as above, between two different verbs: the mark is held back by a missed
    // rename, and the resolve running in the meantime must not land on top of it.
    renameProbe.failRemaining = 1;
    const marked = run(['mark', 'seed']);
    const resolved = run(['resolve', 'seed']);
    await Promise.all([marked, resolved]);
    // Same premise as above: the window the queue has to close only exists because the rename was
    // missed, so the double's hit is asserted rather than assumed.
    expect(renameProbe.failRemaining).toBe(0);
    const status = JSON.parse(readFileSync(POOL(), 'utf8')) as {
      issues: Record<string, { status: string; check_count: number }>;
    };
    // Both landed on the same record, in the order they were called: the mark's count and the
    // resolve's status are both there, so the second body read what the first one wrote (a new
    // record is collected once, hence 1 + the mark).
    expect(status.issues.seed!.status).toBe('resolved');
    expect(status.issues.seed!.check_count).toBe(2);
  });
});

describe('the writers queue, the readers do not', () => {
  it('a write started while the queue is held waits for it, while a reading verb answers right away', async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let entered!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const holding = withPoolLock(root, async () => {
      entered();
      await held;
    });
    await inside;

    const adding = run(['add', '--id', 'queued', '--title', 'Queued']);
    await Promise.resolve();
    await Promise.resolve();
    // The write has not started: it is behind the held body, and nothing has landed yet.
    expect(existsSync(POOL())).toBe(false);

    // The reader's answer is computed when it is called: had it queued behind the held body as well,
    // it would have answered after the write landed and seen the new issue.
    const reading = run(['list']);
    release();
    await Promise.all([holding, adding]);
    expect(String(await reading).trim()).toBe('[]');
    expect(pooledIds()).toEqual(['queued']);
  });
});