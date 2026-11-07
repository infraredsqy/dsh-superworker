import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedExecutor } from '../src/executor';
import { open, type Pf } from '../src/open';
import { answer } from '../src/words/router';
import type { WordsIO } from '../src/words/types';
import { EOL } from '../plugins/issue/tools/storage.mjs';

/**
 * How one `issue …` line ends, at the words layer: the two endings the plugin's own header speaks of.
 *
 * A **usage error** — the verb is unknown, the flag is not one this verb takes, the positional count is
 * wrong, the value misses a closed set, a flag the verb requires was left out, the value is of the wrong
 * shape — carries `code: 2`, the same code the core's own parser answers a refused line with, and prints
 * the usage spelling instead of being folded into `main failed`. Any other failure is about the pool
 * rather than the line, carries no code, and keeps that fold at `1`.
 * Turning a thrown refusal into an exit code is this round's new seam: `main` could already hand a number
 * back, and now a thrown error carrying exactly `code: 2` does too — a number other than 2 is not a code
 * this seam carries, and folds to 1 the way a refusal with no code does.
 *
 * Engine work lands in a temp project root, with this repo's plugin copied into it as it is.
 */

const REPO_PLUGIN = new URL('../plugins/issue', import.meta.url);

let root: string;
let superworker: Pf;
let io: WordsIO;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-issue-word-'));
  superworker = open(root);
  await superworker.ledger.init();
  cpSync(REPO_PLUGIN, join(root, 'plugins', 'issue'), { recursive: true });
  io = { root, homeDir: join(root, '_home'), executor: new SimulatedExecutor(), openerAvailable: true };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('how one issue line ends: the line was wrong, or the pool said no', () => {
  it('a usage error keeps the usage spelling and leaves with 2, not folded into `main failed`', async () => {
    const refused = await answer(['issue', 'frobnicate'], io);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('usage: issue <verb> [options]');
    expect(refused.stderr).toContain('unrecognized command "frobnicate"');
    expect(refused.stderr).not.toContain('main failed');
    expect(refused.stdout).toBe('');
  });

  it('every user error about the line is that same ending: an unknown flag, a stray positional, a value outside the set, a required flag left out, a value of the wrong shape', async () => {
    for (const argv of [
      ['issue', 'list', '--wat'],
      ['issue', 'weight', 'extra'],
      ['issue', 'list', '--severity', 'P9'],
      ['issue', 'list', '-n', 'many'],
      // The three the parser cannot see: the verb reaches its runner and the line still lacks what it needs.
      ['issue', 'add'],
      ['issue', 'reject', 'x'],
      ['issue', 'search', '('],
    ]) {
      const refused = await answer(argv, io);
      expect(refused.code, argv.join(' ')).toBe(2);
      expect(refused.stdout, argv.join(' ')).toBe('');
      expect(refused.stderr, argv.join(' ')).toContain('usage: issue <verb> [options]');
      expect(refused.stderr, argv.join(' ')).not.toContain('main failed');
    }
  });

  it('a failure about the pool still answers 1 through the `main failed` fold', async () => {
    const refused = await answer(['issue', 'resolve', 'ghost'], io);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('plugin \'issue\': main failed: issue "ghost" not found');
  });

  it('a line that runs answers its text and 0', async () => {
    const ok = await answer(['issue', 'weight'], io);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe(`0${EOL}`);
    // The same word through the plugin seam keeps the code the plugin handed back.
    const direct = await superworker.conductor.pluginCommand({ word: 'issue', argv: ['frobnicate'] });
    expect(direct.ran).toBe(false);
    expect(direct.code).toBe(2);
  });
});
