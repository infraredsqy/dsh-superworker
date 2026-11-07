import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { RECORD_DIR_NAME } from '../src/paths';
import { LEGACY_DIR_NAME, legacyRecordDir } from '../src/legacy';
import { git, gitRunner as realGit } from './helpers/git-runner';

/**
 * The two migration cells of doctor, read through `conductor.doctor` the way the other doctor
 * cases read theirs.
 *
 * `record-directory` appears only when a recognizable old record directory is here, and it is
 * never red — a workspace that has not moved forward is not broken, its records are all there —
 * but what it says depends on the shared preconditions (`migrationPreconditions`, the one reading
 * `migrate` grades its move by): ready → "run `migrate 0.1.0`"; refused → the refusal said out
 * loud, with an agent to consult. A directory under the old name that this pipeline never laid
 * down gets no cell at all, the same as no old directory.
 *
 * `record-tracked` is the one red cell: a record directory the project's git tracks is a state
 * `init` refuses and no word can undo, because taking records back out of history is a person's
 * decision.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-doctor-migration-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** An init-ed record directory under the old name: run init (no git, the bottom line suffices), then rename the directory. */
async function stageLegacyRecord(): Promise<void> {
  await open(root).ledger.init();
  renameSync(join(root, RECORD_DIR_NAME), legacyRecordDir(root));
}

describe('the record-directory cell: only a recognizable old directory gets one', () => {
  it('a workspace with no old directory and an unrecognizable one get no cell at all', async () => {
    // A fresh root has nothing to say about migration, and neither has a directory under the old
    // name this pipeline never laid down: the reading treats an unrecognizable directory as
    // absent everywhere.
    const fresh = (await open(root).conductor.doctor()).checks.map((check) => check.name);
    expect(fresh).not.toContain('record-directory');
    expect(fresh).not.toContain('record-tracked');

    mkdirSync(legacyRecordDir(root), { recursive: true });
    writeFileSync(join(legacyRecordDir(root), 'state.json'), '{"cycles":[]}', 'utf8');
    const unrecognizable = (await open(root).conductor.doctor()).checks.map((check) => check.name);
    expect(unrecognizable).not.toContain('record-directory');
    expect(unrecognizable).not.toContain('record-tracked');
  });

  it('a movable old record directory: the cell is green and says to run migrate 0.1.0', async () => {
    await stageLegacyRecord();
    const report = await open(root).conductor.doctor();
    const check = report.checks.find((entry) => entry.name === 'record-directory')!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('migrate 0.1.0');
    // Green advice is not a red report: the workspace works, it reads one directory only.
    expect(report.ok).toBe(true);
    // The cell sits with the record face, before the merge-driver cell.
    expect(report.checks.map((entry) => entry.name)).toEqual([
      'plugins', 'knobs', 'commands', 'records', 'graph', 'cycles', 'record-directory', 'merge-driver',
    ]);
  });

  it('both directories on disk: the cell stays green, and the refusal is said out loud with an agent to consult', async () => {
    // Which records are the true ones is a judgement no word can make, so the cell says the state
    // and points at an agent instead of grading the workspace broken.
    await stageLegacyRecord();
    mkdirSync(join(root, RECORD_DIR_NAME), { recursive: true });
    const check = (await open(root).conductor.doctor()).checks.find(
      (entry) => entry.name === 'record-directory',
    )!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('both');
    expect(check.detail).toContain(RECORD_DIR_NAME);
    expect(check.detail).toContain('consult an agent');
  });

  it('a run holding the record lock: the cell says to wait for it, or consult an agent', async () => {
    await stageLegacyRecord();
    const lock = join(legacyRecordDir(root), 'meta', 'ledger.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '', 'utf8');
    const check = (await open(root).conductor.doctor()).checks.find(
      (entry) => entry.name === 'record-directory',
    )!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('record lock');
    expect(check.detail).toContain('consult an agent');
  });

  it('a parallel-mode worktree checked out: the cell names the worktree and the agent', async () => {
    // The worktree's git metadata carries absolute paths, so the move is refused until it is gone;
    // the cell grades by the same preconditions migrate refuses by.
    await stageLegacyRecord();
    const worktree = join(legacyRecordDir(root), 'worktrees', 'dead1o2e');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'README'), 'a checked-out worktree\n', 'utf8');
    const check = (await open(root).conductor.doctor()).checks.find(
      (entry) => entry.name === 'record-directory',
    )!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('worktree');
    expect(check.detail).toContain('consult an agent');
  });

  it('the old directory tracked by the project git: the cell says so, still green, agent to consult', async () => {
    // The precondition is asked of git itself: this tree is really tracked (`git add -f` through
    // the ignores), and the refusal — not a red cell — is what a tracked old directory earns,
    // because only a person may take it out of history.
    await git(root, 'init', '-b', 'master');
    // No repository of the record tree's own: the tree must stay plain files so git can track it.
    await open(root).ledger.init({ git: realGit, ownRepo: false });
    renameSync(join(root, RECORD_DIR_NAME), legacyRecordDir(root));
    await git(root, 'add', '-f', LEGACY_DIR_NAME);
    const check = (await open(root).conductor.doctor({ git: realGit })).checks.find(
      (entry) => entry.name === 'record-directory',
    )!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('tracked');
    expect(check.detail).toContain('consult an agent');
    // The tracked old directory earns no red: the red cell below is about the new directory only.
    expect((await open(root).conductor.doctor({ git: realGit })).checks.map((entry) => entry.name))
      .not.toContain('record-tracked');
  });
});

describe('the record-tracked cell: the one red cell, about the new directory only', () => {
  it('the project git tracks .superworker: red, naming the directory and an agent to consult', async () => {
    // The state init refuses outright: the records are in the index, and no word can take them out.
    await git(root, 'init', '-b', 'master');
    await open(root).ledger.init({ git: realGit, ownRepo: false });
    await git(root, 'add', '-f', RECORD_DIR_NAME);
    const report = await open(root).conductor.doctor({ git: realGit });
    const check = report.checks.find((entry) => entry.name === 'record-tracked')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(RECORD_DIR_NAME);
    expect(check.detail).toContain('consult an agent');
    // No old directory here, so the migration advice has nothing to say.
    expect(report.checks.map((entry) => entry.name)).not.toContain('record-directory');
    expect(report.ok).toBe(false);
  });

  it('a record directory outside the index earns no cell: untracked is the ordinary state', async () => {
    await git(root, 'init', '-b', 'master');
    await open(root).ledger.init({ git: realGit, ownRepo: false });
    const names = (await open(root).conductor.doctor({ git: realGit })).checks.map(
      (entry) => entry.name,
    );
    expect(names).not.toContain('record-tracked');
    expect(names).not.toContain('record-directory');
  });
});
