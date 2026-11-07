import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJson, exclusiveCreateBytes, jsonBytes } from '../src/jsonio.ts';
import { RETRY_ATTEMPTS } from '../src/fs-helpers.ts';
import { recordPaths } from '../src/paths.ts';

/**
 * Atomic write: one temp file on the same volume plus a rename; a failure in the middle leaves
 * no half-written file, cleans up after itself, and a rename that is blocked retries with backoff
 * (within the cap). The "rename fails" step is forced through a module double: everything but
 * rename is the real implementation.
 *
 * Exclusive create is beside it: same temp-file discipline, but the landing is a hard link onto
 * the target name, which refuses with Node's own EEXIST when the target is there — the run doc's
 * landing, where the first writer wins and a live session's bytes are never overwritten.
 */

const renameProbe = vi.hoisted(() => ({ failRemaining: 0, calls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: unknown, to: unknown) => {
      renameProbe.calls += 1;
      if (renameProbe.failRemaining > 0) {
        renameProbe.failRemaining -= 1;
        const error = new Error('rename blocked (test double)') as { code?: string };
        error.code = 'EPERM';
        throw error;
      }
      return actual.rename(from as string, to as string);
    },
  };
});

let workdir: string | undefined;
const tmpFiles = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.endsWith('.tmp'));

beforeEach(() => {
  renameProbe.failRemaining = 0;
  renameProbe.calls = 0;
});

afterEach(() => {
  if (workdir !== undefined) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

function tempDir(): string {
  workdir = mkdtempSync(join(tmpdir(), 'superworker-atomic-'));
  return workdir;
}

describe('atomic write', () => {
  it('creates parent directories level by level; shorter content leaves nothing of the longer previous content', async () => {
    const root = tempDir();
    const paths = recordPaths(root);
    await atomicWriteJson(paths.issuesJson, { version: 1, issues: {} });
    expect(readFileSync(paths.issuesJson, 'utf8')).toBe(
      ['{', '  "version": 1,', '  "issues": {}', '}'].join('\n'),
    );
    await atomicWriteJson(paths.issuesJson, { version: 1, issues: { x: 1 } });
    const text = readFileSync(paths.issuesJson, 'utf8');
    expect(text.startsWith('{')).toBe(true);
    expect(text).toBe(
      [
        '{',
        '  "version": 1,',
        '  "issues": {',
        '    "x": 1',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('a rename blocked once still lands after the backoff', async () => {
    const root = tempDir();
    const target = join(root, 'record.json');
    renameProbe.failRemaining = 1;
    await atomicWriteJson(target, { ok: true });
    expect(renameProbe.calls).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ok: true });
    expect(tmpFiles(root)).toEqual([]);
  });

  it('blocked all the way: the failure is handed over, the temp file is cleared, the original is untouched (a mid-way failure leaves no half file)', async () => {
    const root = tempDir();
    const target = join(root, 'record.json');
    const before = jsonBytes({ old: true });
    writeFileSync(target, Buffer.from(before));
    renameProbe.failRemaining = 99;
    await expect(atomicWriteJson(target, { new: true })).rejects.toMatchObject({ code: 'EPERM' });
    expect(renameProbe.calls).toBe(RETRY_ATTEMPTS);
    expect(tmpFiles(root)).toEqual([]);
    // A reader sees either the old record or the new one: this is still the old one, not a byte moved.
    expect(readFileSync(target)).toEqual(Buffer.from(before));
  });

  it('fails when the landing path crosses a plain file: the error is handed over and nothing is added to disk', async () => {
    const root = tempDir();
    const blocker = join(root, 'stop.json');
    writeFileSync(blocker, 'plain file');
    const target = join(root, 'stop.json', 'nested', 'record.json');
    await expect(atomicWriteJson(target, { x: 1 })).rejects.toThrow();
    expect(readFileSync(blocker, 'utf8')).toBe('plain file');
    expect(existsSync(join(root, 'stop.json', 'nested'))).toBe(false);
  });
});

describe('exclusive create', () => {
  it('an absent target: the payload lands whole, parent directories and all', async () => {
    const root = tempDir();
    const target = join(root, 'deep', 'nested', 'run.md');
    await exclusiveCreateBytes(target, Buffer.from('first\n'));
    expect(readFileSync(target, 'utf8')).toBe('first\n');
    expect(tmpFiles(join(root, 'deep', 'nested'))).toEqual([]);
  });

  it('a target already there: EEXIST with a decidable code, not a byte touched, no temp left behind', async () => {
    const root = tempDir();
    const target = join(root, 'run.md');
    writeFileSync(target, 'the first preparation\n', 'utf8');
    await expect(exclusiveCreateBytes(target, Buffer.from('a second preparation\n'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(readFileSync(target, 'utf8')).toBe('the first preparation\n');
    expect(tmpFiles(root)).toEqual([]);
  });

  it('two creators race on one target: exactly one lands, the bytes on disk are one whole payload', async () => {
    const root = tempDir();
    const target = join(root, 'run.md');
    const outcomes = await Promise.allSettled([
      exclusiveCreateBytes(target, Buffer.from('first wins\n')),
      exclusiveCreateBytes(target, Buffer.from('second wins\n')),
    ]);
    const settled = outcomes.map((outcome) =>
      outcome.status === 'fulfilled'
        ? 'ok'
        : ((outcome.reason as { code?: string }).code ?? 'thrown'),
    );
    expect(settled.sort()).toEqual(['EEXIST', 'ok']);
    expect(readFileSync(target, 'utf8')).toMatch(/^(first|second) wins\n$/);
    expect(tmpFiles(root)).toEqual([]);
  });
});
