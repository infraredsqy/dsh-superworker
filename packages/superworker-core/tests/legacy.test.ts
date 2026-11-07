import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INIT_MARKERS } from '../src/initledger';
import {
  CONSULT_PROMPT,
  LEGACY_DIR_NAME,
  hasLegacyRecord,
  isRecognizableLegacyRecord,
  legacyRecordDir,
  migrationPreconditions,
} from '../src/legacy';
import { RECORD_DIR_NAME } from '../src/paths';
import { open } from '../src/open';
import type { GitRunner } from '../src/git';
import { git, gitRunner as realGit } from './helpers/git-runner';

/**
 * The one module that still knows the old record directory, read as the three questions it answers
 * about a workspace root: is there a directory under the old name, is it one `init` laid down, and
 * may it be moved. Recognition reads the marks off the layout table (`INIT_MARKERS`), so a third
 * mark would teach both this module and `init` at once; the preconditions are the one reading
 * `doctor` and `migrate` share, so the two words cannot disagree about a workspace.
 *
 * The old directory is staged by running `init` and renaming the directory it lays down — the
 * marks then are the ones `init` really lays, not a hand-made stand-in for them.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-legacy-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** An init-ed record directory under the old name: run init (no git, the bottom line suffices), then rename the directory. Plain files only, so a case can really put the tree into a git index. */
async function stageLegacyRecord(gitRunner?: GitRunner): Promise<void> {
  await open(root).ledger.init({ ownRepo: false, ...(gitRunner === undefined ? {} : { git: gitRunner }) });
  renameSync(join(root, RECORD_DIR_NAME), legacyRecordDir(root));
}

describe('hasLegacyRecord: the directory under the old name is there, or it is not', () => {
  it('the builder and the constant agree on where the old directory lives, and the two names differ', () => {
    // The whole rename rests on the old and the new name being two different names: a workspace
    // holding both is a refusal, and a workspace holding one is readable — neither holds if the
    // two spellings collapse into one.
    expect(LEGACY_DIR_NAME).not.toBe(RECORD_DIR_NAME);
    expect(legacyRecordDir(root)).toBe(join(root, LEGACY_DIR_NAME));
  });

  it('an init-ed record directory renamed to the old name answers present; a fresh root and a migrated one answer not', async () => {
    expect(hasLegacyRecord(root)).toBe(false);
    await stageLegacyRecord();
    expect(hasLegacyRecord(root)).toBe(true);
    // After the move there is a record directory again — under the new name, which this reading
    // does not count: the old name is the only thing this question is about.
    renameSync(legacyRecordDir(root), join(root, RECORD_DIR_NAME));
    expect(hasLegacyRecord(root)).toBe(false);
  });

  it('a file spelled as the old directory is not a record directory: the question asks for a directory', () => {
    // Someone's loose file sharing the name must not read as "an old record is here" — every
    // reader downstream (wake, panel, doctor) would switch its behaviour on a file.
    writeFileSync(join(root, LEGACY_DIR_NAME), 'not a directory\n', 'utf8');
    expect(hasLegacyRecord(root)).toBe(false);
  });
});

describe('isRecognizableLegacyRecord: recognised by the marks init lays down, read off the layout table', () => {
  it('a record directory init laid down, under the old name, is recognised', async () => {
    await stageLegacyRecord();
    expect(isRecognizableLegacyRecord(root)).toBe(true);
  });

  it('the marks are init\'s init-marker files: a hand-built directory carrying exactly them is recognised too', () => {
    // Recognition asks the layout table, not a private list: this directory is built from
    // INIT_MARKERS itself, so the day a mark is added, this case and `init` move together.
    mkdirSync(legacyRecordDir(root), { recursive: true });
    for (const marker of INIT_MARKERS) {
      writeFileSync(join(legacyRecordDir(root), marker), 'laid down\n', 'utf8');
    }
    expect(isRecognizableLegacyRecord(root)).toBe(true);
  });

  it('a directory under the old name without the marks is somebody else\'s: not recognised, and treated as absent', () => {
    // A name is not an identity: a directory somebody else happened to give the same name must not
    // put the pipeline into "records need migrating" mode, so every reader but `migrate` (which
    // says so instead of guessing) answers as if it were not there.
    mkdirSync(legacyRecordDir(root), { recursive: true });
    writeFileSync(join(legacyRecordDir(root), 'state.json'), '{"cycles":[]}', 'utf8');
    expect(isRecognizableLegacyRecord(root)).toBe(false);
    expect(hasLegacyRecord(root)).toBe(true);
  });

  it('one missing mark is enough to fail recognition', async () => {
    await stageLegacyRecord();
    rmSync(join(legacyRecordDir(root), INIT_MARKERS[0]!));
    expect(isRecognizableLegacyRecord(root)).toBe(false);
  });
});

describe('migrationPreconditions: the one reading of "may this workspace\'s records move", shared by doctor and migrate', () => {
  it('nothing under the old name: absent', async () => {
    expect(await migrationPreconditions(root)).toEqual({ ready: false, refusal: 'absent' });
  });

  it('a directory under the old name that carries no marks: unrecognizable', async () => {
    mkdirSync(legacyRecordDir(root), { recursive: true });
    expect(await migrationPreconditions(root)).toEqual({ ready: false, refusal: 'unrecognizable' });
  });

  it('both record directories on disk: both-present, and neither reading guesses which is true', async () => {
    await stageLegacyRecord();
    mkdirSync(join(root, RECORD_DIR_NAME), { recursive: true });
    expect(await migrationPreconditions(root)).toEqual({ ready: false, refusal: 'both-present' });
  });

  it('the project git tracks the old directory: tracked-by-git, asked through the injected runner', async () => {
    // Renaming a tracked directory would half-remove it from the repository's history, so the
    // precondition is asked of git itself — here with the real one, `git ls-files` naming the tree.
    await git(root, 'init', '-b', 'master');
    await stageLegacyRecord(realGit);
    await git(root, 'add', '-f', LEGACY_DIR_NAME);
    expect(await migrationPreconditions(root, realGit)).toEqual({
      ready: false,
      refusal: 'tracked-by-git',
    });
  });

  it('the cross-process lock is in the old tree: locked, a run in flight', async () => {
    await stageLegacyRecord();
    const lock = join(legacyRecordDir(root), 'meta', 'ledger.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '', 'utf8');
    expect(await migrationPreconditions(root)).toEqual({ ready: false, refusal: 'locked' });
  });

  it('a parallel-mode worktree is checked out in the old tree: worktrees, its metadata carries absolute paths', async () => {
    await stageLegacyRecord();
    const worktree = join(legacyRecordDir(root), 'worktrees', 'dead1o2e');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'README'), 'a checked-out worktree\n', 'utf8');
    expect(await migrationPreconditions(root)).toEqual({ ready: false, refusal: 'worktrees' });
  });

  it('an empty worktrees directory is not a worktree: the reading stays ready', async () => {
    // The directory exists in every init-ed tree; only a checked-out worktree inside it (an entry)
    // stops a move, so emptiness must not read as one.
    await stageLegacyRecord();
    mkdirSync(join(legacyRecordDir(root), 'worktrees'), { recursive: true });
    const reading = await migrationPreconditions(root);
    expect(reading.ready).toBe(true);
  });

  it('a movable workspace: ready, with the two directories named', async () => {
    await stageLegacyRecord();
    expect(await migrationPreconditions(root)).toEqual({
      ready: true,
      legacyDir: legacyRecordDir(root),
      recordDir: join(root, RECORD_DIR_NAME),
    });
  });

  it('a git that cannot answer is read as "not tracked": the reading stays ready, and init\'s tracked gate catches the mistake', async () => {
    // The precondition is a best-effort question, not a gate: a git that refuses (or is absent)
    // folds to "not tracked", the move proceeds, and the tracked-directory refusal of `init` is the
    // hard stop that catches a tracked tree before a byte lands.
    const refused: GitRunner = {
      run: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    };
    await stageLegacyRecord();
    expect(await migrationPreconditions(root, refused).then((reading) => reading.ready)).toBe(true);
    expect(await migrationPreconditions(root)).toEqual({
      ready: true,
      legacyDir: legacyRecordDir(root),
      recordDir: join(root, RECORD_DIR_NAME),
    });
  });
});

describe('CONSULT_PROMPT: the fixed sentence the panel\'s link hands to a new session', () => {
  it('the prompt is fixed, names both directories, and routes to the route skill', () => {
    // A sentence assembled from the workspace would be a second place that spells both directory
    // names; the fixed one spells them in the one module that owns the old name, and points the
    // session at the skill that finishes a migration.
    expect(CONSULT_PROMPT.startsWith('/sw-route ')).toBe(true);
    expect(CONSULT_PROMPT).toContain(LEGACY_DIR_NAME);
    expect(CONSULT_PROMPT).toContain(RECORD_DIR_NAME);
  });
});
