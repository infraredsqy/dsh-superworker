import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJson } from '../src/jsonio.ts';
import { withLedgerLock } from '../src/ledgerlock.ts';
import { ledgerLockPath, recordPaths, type RecordPaths } from '../src/paths.ts';

/**
 * The release half of the record tree's lock: deleting the lock file is the same retry protocol as
 * removing a record file, so a brief standoff on Windows is backed off and retried instead of being
 * handed to the caller — a lock file left on disk makes every later acquire wait out the ten-second
 * timeout and report `lock_timeout`, which stops the whole record tree until a person deletes it.
 *
 * The standoff is scheduled inside the stub below, never brought about through the real system call:
 * `unlink` fails with the given code for the first N calls and passes everything else through, so a
 * release that retries is visible as the count of failures and a release that gives up is visible as
 * the lock file still being there.
 */

const fault = vi.hoisted(() => ({ remaining: 0, code: 'EBUSY', thrown: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]): Promise<void> => {
      if (fault.remaining > 0) {
        fault.remaining -= 1;
        fault.thrown += 1;
        const error = new Error(`scheduled ${fault.code} on ${String(path)}`);
        (error as { code?: string }).code = fault.code;
        throw error;
      }
      return actual.unlink(path);
    },
  };
});

let workdir: string | undefined;

function tempPaths(): RecordPaths {
  workdir = mkdtempSync(join(tmpdir(), 'superworker-lock-release-'));
  return recordPaths(workdir);
}

beforeEach(() => {
  fault.remaining = 0;
  fault.thrown = 0;
});

afterEach(() => {
  if (workdir !== undefined) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

/** Arm the standoff: the next `count` unlinks fail with `code`, everything after them passes through. */
function armStandoff(code: string, count: number): void {
  fault.code = code;
  fault.remaining = count;
  fault.thrown = 0;
}

describe('releasing the lock file', () => {
  // Every spelling a runtime gives a brief "another process holds it" on the same file: the two
  // PermissionError spellings and Node on Windows' own EBUSY. The release has to be one protocol,
  // so it is asked through all three rather than through the one spelling that happened to work.
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    it(`a release meeting a brief ${code} standoff retries: no lock file is left, and the next write gets in at once`, async () => {
      const paths = tempPaths();
      const lock = ledgerLockPath(paths);
      armStandoff(code, 2);

      await withLedgerLock(paths, async () => {
        await atomicWriteJson(paths.stateJson, { tokens: ['first'] });
      });

      // Both failures were really met: the retry is what let the release through.
      expect(fault.thrown).toBe(2);
      expect(fault.remaining).toBe(0);
      // Nothing is left on disk: a lock file here would be waited out for ten seconds by the next one.
      expect(existsSync(lock)).toBe(false);

      // The proof the release let go: a second writer with no waiting budget at all gets straight in.
      await withLedgerLock(
        paths,
        async () => {
          await atomicWriteJson(paths.stateJson, { tokens: ['second'] });
        },
        { timeoutMs: 0 },
      );
      expect(JSON.parse(readFileSync(paths.stateJson, 'utf8'))).toEqual({ tokens: ['second'] });
    });
  }

  it('a release whose lock file was already taken away counts as released: no failure is reported', async () => {
    const paths = tempPaths();
    const lock = ledgerLockPath(paths);
    await withLedgerLock(paths, async () => {
      await atomicWriteJson(paths.stateJson, { tokens: ['done'] });
      // What an external sweep would leave behind: nothing. The release meets an absent file.
      rmSync(lock, { force: true });
    });
    expect(existsSync(lock)).toBe(false);
    expect(fault.thrown).toBe(0);
  });
});
