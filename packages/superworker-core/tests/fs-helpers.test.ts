import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesEqual, messageOf, RETRY_ATTEMPTS, unlinkWithRetry } from '../src/fs-helpers.ts';

/**
 * The shared exit for unlinking: an absent file counts as already unlinked; a hold backs off on
 * the base layer's rhythm, and once the limit is reached the error is handed out unchanged.
 * Holds are forced with a module double (the same trick as atomic-write.test.ts): everything but
 * unlink goes through the real implementation. EPERM/EACCES and EBUSY are two spellings of the
 * same share violation — one from POSIX permission errors, one from Node on Windows — and both
 * must be swallowed.
 */

const unlinkProbe = vi.hoisted(() => ({ failRemaining: 0, calls: 0, busyCode: 'EPERM' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (path: unknown) => {
      unlinkProbe.calls += 1;
      if (unlinkProbe.failRemaining > 0) {
        unlinkProbe.failRemaining -= 1;
        const error = new Error('unlink held (test double)') as { code?: string };
        error.code = unlinkProbe.busyCode;
        throw error;
      }
      return actual.unlink(path as string);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superworker-fs-helpers-'));
  unlinkProbe.failRemaining = 0;
  unlinkProbe.calls = 0;
  unlinkProbe.busyCode = 'EPERM';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  dir = undefined!;
});

function ticket(): string {
  const path = join(dir, 'ticket.json');
  writeFileSync(path, '{}', 'utf8');
  return path;
}

describe('unlinkWithRetry: unlinking a record file', () => {
  it('an absent file counts as unlinked: the path returns on the first try, no retry needed', async () => {
    await expect(unlinkWithRetry(join(dir, 'absent.json'))).resolves.toBeUndefined();
    expect(unlinkProbe.calls).toBe(1);
  });

  it('a file that is there gets unlinked', async () => {
    const target = ticket();
    await expect(unlinkWithRetry(target)).resolves.toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });

  it('a hold that lets go on the first try: unlinks after backing off (EPERM spelling)', async () => {
    const target = ticket();
    unlinkProbe.failRemaining = 1;
    await expect(unlinkWithRetry(target)).resolves.toBeUndefined();
    expect(unlinkProbe.calls).toBe(2);
    expect(existsSync(target)).toBe(false);
  });

  it('a hold that lets go on the first try: unlinks after backing off (EBUSY, the Node spelling on Windows)', async () => {
    const target = ticket();
    unlinkProbe.busyCode = 'EBUSY';
    unlinkProbe.failRemaining = 1;
    await expect(unlinkWithRetry(target)).resolves.toBeUndefined();
    expect(unlinkProbe.calls).toBe(2);
    expect(existsSync(target)).toBe(false);
  });

  it('a hold that never lets go: the error is handed out unchanged, never swallowed, after exactly the rhythm limit of tries', async () => {
    const target = ticket();
    unlinkProbe.failRemaining = 99;
    await expect(unlinkWithRetry(target)).rejects.toMatchObject({ code: 'EPERM' });
    expect(unlinkProbe.calls).toBe(RETRY_ATTEMPTS);
    expect(existsSync(target)).toBe(true);
  });
});

describe('messageOf: the one line an error answer carries', () => {
  it('an Error answers with its message; anything thrown otherwise is spelled as a string', () => {
    expect(messageOf(new Error('the record is held'))).toBe('the record is held');
    expect(messageOf('a plain refusal')).toBe('a plain refusal');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('bytesEqual: the one byte comparison', () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('same bytes');

  it('the same bytes answer true, including two empty strings', () => {
    expect(bytesEqual(bytes, encoder.encode('same bytes'))).toBe(true);
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('a different length answers false before a single byte is compared', () => {
    expect(bytesEqual(bytes, encoder.encode('same byte'))).toBe(false);
    expect(bytesEqual(bytes, encoder.encode('same bytes!'))).toBe(false);
  });

  it('one differing byte answers false, at the end included', () => {
    expect(bytesEqual(bytes, encoder.encode('same bytex'))).toBe(false);
    expect(bytesEqual(bytes, encoder.encode('Xame bytes'))).toBe(false);
  });
});
