import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConductorNamespace } from '../src/conductor';
import type { DoctorReport } from '../src/conductor';
import type { GitResult, GitRunner } from '../src/git';
import { git, gitRunner as realGit } from './helpers/git-runner';

/**
 * The merge-driver cell of doctor: is the driver registered, and does this machine answer the
 * registration. The registration has one form now — the absolute one, the quoted node path plus
 * the quoted built entry — so the cell judges the string against this machine: green only when
 * both quoted paths are files here, red when they are gone (a moved checkout leaves its paths
 * behind), and red for any other string, including the command forms an older release wrote, for
 * which nothing answers any more. The cell decides nothing from what a machine happens to have on
 * `PATH`: there is no probe of `PATH` left to make.
 *
 * `merge.superworker.driver` is the key git runs and `merge.superworker.name` is only the label it shows, so a driver
 * with no label is green with the incomplete pair said out loud — never red. (The green
 * absolute-form cell does say what a moved checkout would do to the registration; that sentence is
 * about a future merge, not about one this driver fails to answer.)
 *
 * Not a git checkout — or no git handed in — is not red: a project outside git has nowhere to
 * register a driver, and a reading that cannot be taken is never read as zero. The git is handed in
 * on the call (`doctor({ git })`, the shape `ledger.init` / `ledger.register` take); the namespace
 * assembled by `open` keeps none, so the same handle can answer "not asked" and then judge.
 *
 * Every question the cell puts to git carries a bound (`DOCTOR_GIT_TIMEOUT_MS`): a git that never
 * answers reds the cell within the bound, names the question and the wait, and leaves the other
 * cells computed — the check-up never waits forever on a git. A case narrows the bound through the
 * namespace options instead of waiting the default out.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-doctor-driver-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** One check-up with the real git handed in on the call: the per-call slot `ledger.init` / `ledger.register` also use. */
function doctorWithGit(): Promise<DoctorReport> {
  return createConductorNamespace(root).doctor({ git: realGit });
}

/** A runner that answers the three config questions the cell asks, with the driver string under test. */
function registeredAgainst(driver: string): GitRunner {
  return {
    run(_cwd: string, args: readonly string[]): Promise<GitResult> {
      const spelled = args.join(' ');
      if (spelled === 'rev-parse --git-common-dir') {
        return Promise.resolve({ code: 0, stdout: '.git\n', stderr: '' });
      }
      if (spelled === 'config --local --get merge.superworker.name') {
        return Promise.resolve({ code: 0, stdout: 'superworker ledger three-way merge\n', stderr: '' });
      }
      if (spelled === 'config --local --get merge.superworker.driver') {
        return Promise.resolve({ code: 0, stdout: `${driver}\n`, stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

/** The same three questions, with the label key absent: the state `ledger.register` half wrote. */
function driverOnlyAgainst(driver: string): GitRunner {
  const full = registeredAgainst(driver);
  return {
    run(cwd: string, args: readonly string[]): Promise<GitResult> {
      if (args.join(' ') === 'config --local --get merge.superworker.name') {
        // git answers a key it does not have with exit 1 and no text: absent, not empty.
        return Promise.resolve({ code: 1, stdout: '', stderr: '' });
      }
      return full.run(cwd, args);
    },
  };
}

/** An absolute-form registration whose two quoted paths really are files on this machine. */
function liveAbsoluteDriver(): string {
  const script = join(root, 'merge-ledger.mjs');
  writeFileSync(script, '#!/usr/bin/env node\n', 'utf8');
  return `"${process.execPath}" "${script}" %O %A %B %P`;
}

describe('the merge-driver cell', () => {
  it('no git handed in: the cell is there, not red, and says it was not asked', async () => {
    const report = await createConductorNamespace(root).doctor();
    const check = report.checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('not asked');
    expect(report.ok).toBe(true);
  });

  it('the git slot belongs to the call, not the handle: one namespace says "not asked" first, then judges once a runner is handed in', async () => {
    await git(root, 'init', '-b', 'master');
    const namespace = createConductorNamespace(root);
    const before = (await namespace.doctor()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(before.ok).toBe(true);
    expect(before.detail).toContain('not asked');
    const after = (await namespace.doctor({ git: realGit })).checks.find(
      (entry) => entry.name === 'merge-driver',
    )!;
    expect(after.ok).toBe(false);
    expect(after.detail).toContain('merge.superworker.driver');
  });

  it('not a git checkout: not red, and nothing is claimed to be missing', async () => {
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('not a git checkout');
  });

  it('a checkout with no driver registered: red, naming both missing keys', async () => {
    await git(root, 'init', '-b', 'master');
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('merge.superworker.name');
    expect(check.detail).toContain('merge.superworker.driver');
    expect(check.detail).toContain('ledger.register');
  });

  it('only merge.superworker.name registered: red, naming the driver key — the label is not the registration', async () => {
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge');
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('merge.superworker.driver');
    expect(check.detail).toContain('ledger.register');
  });

  it('only merge.superworker.driver registered, in an absolute form this machine answers: green, and the incomplete pair is named', async () => {
    // The state `ledger.register` half wrote, and a state git really does drive merges in: the
    // driver key alone. Reding it would call a working registration dead; passing it in silence
    // would hide that the pair is incomplete.
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.driver', liveAbsoluteDriver());
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('absolute form');
    expect(check.detail).toContain('pair ledger.register writes is incomplete');
    expect(check.detail).toContain('merge.superworker.name');
    // The label's absence is said as a pair gap, not as a present failure: the cell does not claim
    // the driver is missing.
    expect(check.detail).not.toContain('not registered');
  });

  it('registered in the absolute form and both quoted paths are files here: green, with the after-a-move advice said out loud', async () => {
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge');
    // An absolute form whose interpreter and script both exist on this machine: the one form this
    // package writes. (The script's content is irrelevant to the cell: what is checked is that the
    // registration can be answered here.)
    await git(root, 'config', '--local', 'merge.superworker.driver', liveAbsoluteDriver());
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('absolute form');
    expect(check.detail).toContain('both quoted paths are here');
    expect(check.detail).toContain('re-register with ledger.register after a move');
    // Two existing paths are what was measured; "it works on this machine" is more than that.
    expect(check.detail).not.toContain('works on this machine');
  });

  it('registered in the absolute form but pointing at a moved checkout: red, with the re-register advice and not "it works"', async () => {
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge');
    const driver =
      '"C:/nonexistent/old-checkout/node.exe" ' +
      '"C:/nonexistent/old-checkout/dist/merge-ledger.mjs" %O %A %B %P';
    await git(root, 'config', '--local', 'merge.superworker.driver', driver);
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('C:/nonexistent/old-checkout/dist/merge-ledger.mjs');
    expect(check.detail).toContain('ledger.register');
    expect(check.detail).not.toContain('works on this machine');
    // The dead string is not certified as answerable here: the green cell's sentence is absent.
    expect(check.detail).not.toContain('both quoted paths are here');
  });

  it('registered as a command form an older release wrote: red, naming the string — nothing answers it now', async () => {
    // An older release wrote the driver as a bare command and let git resolve it; the tree writes
    // the absolute form only now, and nothing answers the old string — whatever this machine has on
    // `PATH`. The cell must call it dead rather than probe for it.
    for (const driver of ['sw-merge-ledger %O %A %B %P', 'superworker merge-ledger %O %A %B %P']) {
      const check = (
        await createConductorNamespace(root).doctor({ git: registeredAgainst(driver) })
      ).checks.find((entry) => entry.name === 'merge-driver')!;
      expect(check.ok, driver).toBe(false);
      expect(check.detail).toContain(driver);
      expect(check.detail).toContain('not the absolute form');
      expect(check.detail).toContain('ledger.register');
      expect(check.detail).not.toContain('works on this machine');
    }
  });
});

/**
 * The bound on every question the cell puts to git. The check-up must come back even when a git never
 * answers: the question that stays unanswered ends the cell (red) within the bound, the red names the
 * question and how long was waited, and the other cells are computed as usual. The bound is handed in
 * through the namespace options (`createConductorNamespace(root, executor, { gitTimeoutMs })`, the same
 * seam a test shuts `homeDir` through) so a case can stand in a git that never answers and still be over
 * in tens of milliseconds instead of waiting out `DOCTOR_GIT_TIMEOUT_MS`.
 */
describe('the bound on the questions the cell asks git', () => {
  it('a git that never answers: the cell reds within the bound, naming the question and the wait, and every other cell is still computed', async () => {
    const namespace = createConductorNamespace(root, undefined, { gitTimeoutMs: 30 });
    const neverAnswers: GitRunner = { run: () => new Promise<GitResult>(() => {}) };

    const startedAt = Date.now();
    const report = await namespace.doctor({ git: neverAnswers });
    const tookMs = Date.now() - startedAt;
    // Bounded, not merely eventual: without the bound this call would never come back at all.
    expect(tookMs).toBeLessThan(2000);
    // The other cells are all there and were really computed, not left behind by the hanging question.
    expect(report.checks.map((entry) => entry.name)).toEqual([
      'plugins', 'knobs', 'commands', 'records', 'graph', 'cycles', 'merge-driver',
    ]);
    expect(report.checks.find((entry) => entry.name === 'records')!.detail).toContain('ledger.init');
    const answerless = report.checks.find((entry) => entry.name === 'merge-driver')!;
    expect(answerless.ok).toBe(false);
    expect(answerless.detail).toContain('did not answer within 30 ms');
    expect(answerless.detail).toMatch(/waited \d+ ms/);
    expect(answerless.detail).toContain('rev-parse --git-common-dir');
    expect(answerless.detail).toContain('ledger.register');
    expect(report.ok).toBe(false);

    // The question whose answer decides green or red is bounded the same way: this git answers the
    // checkout and the label, then hangs on the driver key.
    const stallsAtDriver: GitRunner = {
      run(_cwd: string, args: readonly string[]): Promise<GitResult> {
        const spelled = args.join(' ');
        if (spelled === 'rev-parse --git-common-dir') {
          return Promise.resolve({ code: 0, stdout: '.git\n', stderr: '' });
        }
        if (spelled === 'config --local --get merge.superworker.name') {
          return Promise.resolve({ code: 0, stdout: 'superworker ledger three-way merge\n', stderr: '' });
        }
        return new Promise<GitResult>(() => {});
      },
    };
    const stalled = (await namespace.doctor({ git: stallsAtDriver })).checks.find(
      (entry) => entry.name === 'merge-driver',
    )!;
    expect(stalled.ok).toBe(false);
    expect(stalled.detail).toContain('did not answer within 30 ms');
    expect(stalled.detail).toMatch(/waited \d+ ms/);
    expect(stalled.detail).toContain('config --local --get merge.superworker.driver');
  });
});
