import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConductorNamespace } from '../src/conductor';
import type { DoctorReport } from '../src/conductor';
import type { GitResult, GitRunner } from '../src/git';
import { git, gitRunner as realGit } from './helpers/git-runner';

/**
 * The merge-driver cell of doctor: is the driver registered, and does this machine answer the
 * registration. The cell decides nothing from the shape of the string: the name form is green only
 * when the command resolves on `PATH`, the absolute form only when both quoted paths are files
 * here. A registration nothing answers is red — including the name form whose command is not on
 * this machine and the absolute form of a checkout that has moved away.
 *
 * `merge.superworker.driver` is the key git runs and `merge.superworker.name` is only the label it shows, so a driver
 * with no label is green with the incomplete pair said out loud — never red, and never "a plain git
 * conflict" for a merge the driver does answer.
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
let pathBefore: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-doctor-driver-'));
  pathBefore = process.env['PATH'];
});

afterEach(() => {
  if (pathBefore === undefined) delete process.env['PATH'];
  else process.env['PATH'] = pathBefore;
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

/** Put one `superworker` on `PATH` for the duration of one test (this tree's own command, which routes the word). */
function onPath(): string {
  const shimDir = mkdtempSync(join(tmpdir(), 'superworker-command-'));
  writeFileSync(join(shimDir, 'superworker'), '#!/usr/bin/env node\n', 'utf8');
  process.env['PATH'] = `${shimDir}${delimiter}${pathBefore ?? ''}`;
  return shimDir;
}

/** Put one `sw-merge-ledger` on `PATH` for the duration of one test (the shim this package installs). */
function shimOnPath(): string {
  const shimDir = mkdtempSync(join(tmpdir(), 'superworker-shim-'));
  writeFileSync(join(shimDir, 'sw-merge-ledger'), '#!/usr/bin/env node\n', 'utf8');
  process.env['PATH'] = `${shimDir}${delimiter}${pathBefore ?? ''}`;
  return shimDir;
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

  it('registered in the name form and the command resolves on PATH: green, and both facts are named', async () => {
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge');
    await git(root, 'config', '--local', 'merge.superworker.driver', 'sw-merge-ledger %O %A %B %P');
    const shimDir = shimOnPath();
    try {
      const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
      expect(check.ok).toBe(true);
      expect(check.detail).toContain('name form');
      expect(check.detail).toContain('resolves on PATH');
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('only merge.superworker.driver registered: green (git runs the driver, the name is its label), and the incomplete pair is named', async () => {
    // The state `ledger.register` half wrote, and a state git really does drive merges in: the
    // driver key alone. Reding it would call a working registration dead; passing it in silence
    // would hide that the pair is incomplete.
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.driver', 'sw-merge-ledger %O %A %B %P');
    const shimDir = shimOnPath();
    try {
      const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
      expect(check.ok).toBe(true);
      expect(check.detail).toContain('name form');
      expect(check.detail).toContain('pair ledger.register writes is incomplete');
      expect(check.detail).toContain('merge.superworker.name');
      expect(check.detail).not.toContain('plain git conflict');
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('registered in the name form but the command does not resolve on PATH: red, naming the missing command', async () => {
    // The registration was written where the package was installed; this machine's PATH has no
    // `sw-merge-ledger`. An empty directory stands in for that PATH so the case does not depend on
    // what the test machine happens to have installed.
    const emptyPath = mkdtempSync(join(tmpdir(), 'superworker-nopath-'));
    try {
      process.env['PATH'] = emptyPath;
      const check = (
        await createConductorNamespace(root).doctor({
          git: registeredAgainst('sw-merge-ledger %O %A %B %P'),
        })
      ).checks.find((entry) => entry.name === 'merge-driver')!;
      expect(check.ok).toBe(false);
      expect(check.detail).toContain('sw-merge-ledger does not resolve on PATH');
      expect(check.detail).toContain('ledger.register');
      // The dead string must not be certified as working: no "it works on this machine" sentence.
      expect(check.detail).not.toContain('works on this machine');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it('registered in the absolute form and both quoted paths are files here: not red, but it says to re-register as the name form', async () => {
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge');
    // An absolute form whose interpreter and script both exist on this machine: the form this
    // package writes when the name form cannot be used. (The script's content is irrelevant to the
    // cell: what is checked is that the registration can be answered here.)
    const script = join(root, 'merge-ledger.mjs');
    writeFileSync(script, '#!/usr/bin/env node\n', 'utf8');
    const driver = `"${process.execPath}" "${script}" %O %A %B %P`;
    await git(root, 'config', '--local', 'merge.superworker.driver', driver);
    const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('absolute form');
    expect(check.detail).toContain('both quoted paths are here');
    expect(check.detail).toContain('re-register as the name form');
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
    expect(check.detail).not.toContain('registered in the absolute form (');
  });

  it('registered in the command form this tree routes (`superworker merge-ledger …`) with superworker on PATH: green', async () => {
    // The command form this tree answers through its own `superworker` command:
    // a real registration in a drill area is this string, so the cell must not call it dead.
    await git(root, 'init', '-b', 'master');
    await git(root, 'config', '--local', 'merge.superworker.name', 'superworker ledger three-way merge');
    await git(root, 'config', '--local', 'merge.superworker.driver', 'superworker merge-ledger %O %A %B %P');
    const commandDir = onPath();
    try {
      const check = (await doctorWithGit()).checks.find((entry) => entry.name === 'merge-driver')!;
      expect(check.ok).toBe(true);
      expect(check.detail).toContain('name form (superworker merge-ledger)');
      expect(check.detail).toContain('resolves on PATH');
      expect(check.detail).not.toContain('plain git conflict');
    } finally {
      rmSync(commandDir, { recursive: true, force: true });
    }
  });

  it('registered as `superworker merge-ledger …` but superworker does not resolve on PATH: red, naming the missing command', async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'superworker-nopath-'));
    try {
      process.env['PATH'] = emptyPath;
      const check = (
        await createConductorNamespace(root).doctor({
          git: registeredAgainst('superworker merge-ledger %O %A %B %P'),
        })
      ).checks.find((entry) => entry.name === 'merge-driver')!;
      expect(check.ok).toBe(false);
      expect(check.detail).toContain('superworker merge-ledger');
      expect(check.detail).toContain('superworker does not resolve on PATH');
      expect(check.detail).toContain('ledger.register');
      expect(check.detail).not.toContain('works on this machine');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
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
