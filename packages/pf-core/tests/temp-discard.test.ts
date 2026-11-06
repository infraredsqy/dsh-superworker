import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exclusiveCreateBytes } from '../src/jsonio.ts';

/**
 * Clearing the temporary file a landing wrote: the same removal protocol as deleting a lock or a
 * record file, in the never-throwing spelling. A leftover `.<name>.<entropy>.tmp` is silent — no
 * error, no caller waiting on it, and no other sweep collects it — so a brief standoff on the same
 * file must be backed off and retried rather than given up on the first busy reading.
 *
 * The standoff is scheduled inside the stub: `unlink` fails with the given code for the first N
 * calls and passes everything else through. A retrying removal shows up as the count of failures
 * and as an empty directory; a removal that gives up on the first one leaves the temporary file
 * next to the landed record.
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

function tempDir(): string {
  workdir = mkdtempSync(join(tmpdir(), 'pf-temp-discard-'));
  return workdir;
}

beforeEach(() => {
  fault.remaining = 0;
  fault.code = 'EBUSY';
  fault.thrown = 0;
});

afterEach(() => {
  if (workdir !== undefined) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

describe('clearing the temporary file of a landing', () => {
  it('a cleanup meeting a brief EBUSY standoff retries: the record lands, no temporary file is left', async () => {
    const root = tempDir();
    const target = join(root, 'run.md');
    fault.remaining = 2;

    await expect(exclusiveCreateBytes(target, Buffer.from('prepared\n'))).resolves.toBeUndefined();

    // Nothing is left beside the record: only the landed file, no `.<name>.<entropy>.tmp`.
    expect(readdirSync(root)).toEqual(['run.md']);
    // Both failures were really met: the retry (not a lucky first call) is what cleared the file.
    expect(fault.thrown).toBe(2);
    expect(fault.remaining).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('prepared\n');
  });

  it('a cleanup that will never clear is left alone: the caller still gets its record and no error', async () => {
    const root = tempDir();
    const target = join(root, 'run.md');
    // Past the retry limit the file stays where it is; the removal is silent by contract.
    fault.remaining = 99;

    await expect(exclusiveCreateBytes(target, Buffer.from('prepared\n'))).resolves.toBeUndefined();

    expect(readFileSync(target, 'utf8')).toBe('prepared\n');
    // Every attempt the limit allows was made, and the leftover was not spun on forever.
    expect(fault.thrown).toBeGreaterThanOrEqual(2);
  });
});
