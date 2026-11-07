import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitResult } from '../src/git.ts';
import { gitRunner } from './helpers/git-runner.ts';

/**
 * The git seam: git enters the engine only from outside, and one call is one answer.
 *
 * The engine starts no process itself, so the shape in `src/git.ts` is the whole contract: a runner
 * handed in by the caller, a call that names its tree, both output streams decoded as strings, and
 * **a non-zero exit is an answer, not an exception** — "not a repository" and "no such branch" are
 * both readings the caller branches on. The runner used here is the concrete one behind that seam
 * (`tests/helpers/git-runner.ts`), working against real git.
 */

describe('the injected git runner', () => {
  it('a call that goes through answers with code 0 and its output on stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'superworker-git-seam-'));
    try {
      const result: GitResult = await gitRunner.run(dir, ['--version']);

      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith('git version')).toBe(true);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-zero exit is an answer, not a throw: a ref that is not there comes back as a code plus the streams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'superworker-git-seam-plain-'));
    try {
      const result = await gitRunner.run(dir, [
        'rev-parse',
        '--verify',
        '--quiet',
        'refs/heads/sw/nothing-here',
      ]);

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(typeof result.stderr).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
