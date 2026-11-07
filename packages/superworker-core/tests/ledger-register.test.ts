import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeDriverCommand } from '../src/initledger';
import { open } from '../src/open';
import { git, gitRunner as realGit, makeRepo } from './helpers/git-runner';

/**
 * `register` on its own: the two merge-driver keys go into this project's git config through git
 * (`git config --local`), and the engine lays down no layout file and writes no config byte itself.
 *
 * The registration string is computed at write time, and in a linked worktree the keys land in the
 * common git config — because git owns that decision, not the engine.
 */

/** The one line this engine owns: a repository-root-anchored `.superworker/`. */
function excludeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /^\s*\/.*\.superworker\/\s*$/.test(line));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-register-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

describe('ledger.register', () => {
  it("writes the two keys into this project's git config and lays down no layout", async () => {
    await git(root, 'init', '-b', 'master');
    await open(root).ledger.register({ git: realGit });
    expect((await git(root, 'config', '--local', '--get', 'merge.superworker.driver')).trim())
      .toBe(mergeDriverCommand());
    expect(existsSync(join(root, '.superworker'))).toBe(false);
  });

  it('without git it is a silent no-op (no command to claim), and not a throw', async () => {
    await expect(open(root).ledger.register()).resolves.toBeNull();
    expect(existsSync(join(root, '.superworker'))).toBe(false);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('hands back the command now in force, and keeps a registration this machine already answers', async () => {
    await git(root, 'init', '-b', 'master');
    const written = await open(root).ledger.register({ git: realGit });
    expect(written).toBe(mergeDriverCommand());
    // A working registration someone chose on purpose is left byte for byte, and handed back as it is:
    // the absolute form names two paths that are both here, so this machine really answers it.
    const chosenScript = join(root, 'chosen-merge.mjs');
    writeFileSync(chosenScript, '#!/usr/bin/env node\n', 'utf8');
    const chosen = `"${process.execPath}" "${chosenScript}" %O %A %B %P`;
    await git(root, 'config', '--local', 'merge.superworker.driver', chosen);
    await expect(open(root).ledger.register({ git: realGit })).resolves.toBe(chosen);
    expect((await git(root, 'config', '--local', '--get', 'merge.superworker.driver')).trim()).toBe(chosen);
  });

  it('in a linked worktree the keys land in the common git config (git decides where, not the engine)', async () => {
    await makeRepo(root);
    const worktree = join(mkdtempSync(join(tmpdir(), 'superworker-register-wt-')), 'tree');
    try {
      await git(root, 'worktree', 'add', worktree, '-b', 'side');
      await open(worktree).ledger.init({ git: realGit });
      const driver = (await git(root, 'config', '--local', '--get', 'merge.superworker.driver')).trim();
      expect(driver).toBe(mergeDriverCommand());
      // One exclude file for the whole repository: the line is there once, anchored at the root.
      expect(excludeLines(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')))
        .toEqual(['/.superworker/']);
    } finally {
      rmSync(join(worktree, '..'), { recursive: true, force: true });
    }
  }, 20000);
});
