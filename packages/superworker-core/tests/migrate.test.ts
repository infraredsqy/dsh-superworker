import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeDriverCommand, readAbsoluteForm } from '../src/initledger';
import { LEGACY_DIR_NAME, legacyRecordDir } from '../src/legacy';
import { open } from '../src/open';
import { RECORD_DIR_NAME, globalConfigPath } from '../src/paths';
import { git, gitRunner as realGit } from './helpers/git-runner';
import { SLOW } from './helpers/slow';

/**
 * `migrate` end to end, on a workspace staged the way the 0.1.x generation left it (a real git
 * checkout, the old directory carrying init's marks): the rename is the bottom line and the five
 * attachments follow — the exclude line switches names, the record tree's `.gitattributes` comes
 * back to the current constant, the driver is re-registered in the one absolute form, the machine
 * layer's settings are **copied** (never moved, never onto what is already there), and the pool's
 * `plan_path` values follow the directory while every other field travels untouched.
 *
 * The move is judged, not attempted: the five refusals each leave the old tree exactly where it
 * was and hand the job to an agent, an unknown generation is refused before any read, a call with
 * no generation only lists what is known, and a migrated workspace runs again as empty work.
 *
 * The old generation is staged through the engine's own `init` (run, then the directory renamed),
 * so the marks are the ones `init` really lays; the exclude line and the attributes are re-spelled
 * afterwards to stand for what the older generation wrote.
 */

let root: string;
let homes: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-migrate-'));
  homes = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  root = undefined!;
});

interface Staged {
  /** The project root `migrate` is called on (a project of the repository, possibly deep). */
  project: string;
  /** The repository's `info/exclude`, spelled by the older generation with the old name's line. */
  excludePath: string;
  /** The machine layer's home, when one was asked for. */
  home?: string;
}

/** One issue row, only the cells the migration may or may not touch. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'x', title: 'a ticket', severity: 'P3', status: 'open', plan_path: null, ...overrides };
}

/**
 * A workspace as 0.1.x left it: init-ed through the engine, renamed to the old directory name,
 * the exclude line carrying the old name, the record tree's `.gitattributes` carrying bytes that
 * are not the current constant, and a pool with two plan paths under the old directory (one
 * root-anchored, one behind another segment), one path that merely begins with the old name's
 * letters, and free text naming the old directory in prose.
 */
async function stageGeneration010(options: { prefix?: string; home?: boolean } = {}): Promise<Staged> {
  const project = options.prefix === undefined ? root : join(root, options.prefix);
  await git(root, 'init', '-b', 'master');
  if (options.prefix !== undefined) mkdirSync(project, { recursive: true });
  // No repository of the record tree's own: the tree stays plain files, so the tracked refusal
  // below can really put it into the index.
  await open(project).ledger.init({ git: realGit, ownRepo: false });
  renameSync(join(project, RECORD_DIR_NAME), legacyRecordDir(project));

  // The exclude line, spelled the way the older generation wrote it: same anchor, old name.
  const excludePath = join(root, '.git', 'info', 'exclude');
  const anchor = options.prefix === undefined ? '' : `${options.prefix}/`;
  writeFileSync(excludePath, `/${anchor}${LEGACY_DIR_NAME}/\n`, 'utf8');

  // The record tree's own `.gitattributes` with bytes that are not the current constant: the old
  // driver's attribute stood there, and any stale bytes must do — the repair writes the constant.
  writeFileSync(join(legacyRecordDir(project), '.gitattributes'), 'stale attributes of the old generation\n', 'utf8');

  // The issue pool with the paths and prose above.
  const poolDir = join(legacyRecordDir(project), 'issues');
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(
    join(poolDir, 'issues.json'),
    JSON.stringify({
      version: 1,
      issues: {
        moved_root: row({ plan_path: `${LEGACY_DIR_NAME}/plan/a.md` }),
        moved_nested: row({ plan_path: `docs/${LEGACY_DIR_NAME}/plan/b.md` }),
        kept_prefix: row({ plan_path: `${LEGACY_DIR_NAME}notes/keep.md` }),
        free_text: row({
          title: `the old directory ${LEGACY_DIR_NAME}/ is named in prose`,
          description: `${LEGACY_DIR_NAME}/ everywhere`,
        }),
      },
    }, null, 2),
    'utf8',
  );

  // The machine layer's home, when asked for: settings under the old home spelling.
  if (options.home === true) {
    const home = mkdtempSync(join(tmpdir(), 'superworker-migrate-home-'));
    homes.push(home);
    mkdirSync(join(home, LEGACY_DIR_NAME), { recursive: true });
    writeFileSync(join(home, LEGACY_DIR_NAME, 'config.json'), '{"session_host_override":"on"}', 'utf8');
    return { project, excludePath, home };
  }
  return { project, excludePath };
}

/** Hash of the whole tree (relative path + content fed to sha256 one after another): the measure of "not a byte moved". */
function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else {
        hash.update(`${prefix}${name}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

describe('the six steps, end to end on a real checkout', () => {
  it.skipIf(!SLOW)('the tree moves, the exclude line and the attributes follow, the driver is re-registered, the machine layer is copied, the plan paths are rewritten', async () => {
    const staged = await stageGeneration010({ home: true });
    const report = await open(staged.project).ledger.migrate('0.1.0', { git: realGit, homeDir: staged.home });

    expect(report.moved).toBe(true);
    expect(report.from).toBe(legacyRecordDir(staged.project));
    expect(report.to).toBe(join(staged.project, RECORD_DIR_NAME));
    // 1. the rename, in one step: the old name is gone, the new one holds the tree.
    expect(existsSync(legacyRecordDir(staged.project))).toBe(false);
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(true);
    // 2. the exclude line switched names: old line out, new line in, nothing else disturbed.
    expect(report.exclude).toBe('written');
    const exclude = readFileSync(staged.excludePath, 'utf8');
    expect(exclude).toContain(`/${RECORD_DIR_NAME}/`);
    expect(exclude).not.toContain(`/${LEGACY_DIR_NAME}/`);
    // 3. the record tree's own `.gitattributes` is at the current constant: every merge attribute
    //    names the current driver.
    expect(report.gitattributes).toBe('rewritten');
    const attributes = readFileSync(join(staged.project, RECORD_DIR_NAME, '.gitattributes'), 'utf8');
    expect(attributes).not.toBe('stale attributes of the old generation\n');
    for (const line of attributes.split('\n').filter((one) => one.includes('merge='))) {
      expect(line).toContain('merge=superworker');
    }
    // 4. the driver is re-registered in the one absolute form, and the string it names answers here.
    expect(report.mergeDriver).toBe('written');
    expect(report.mergeDriverCommand).toBe(mergeDriverCommand());
    const registered = (await git(staged.project, 'config', '--local', '--get', 'merge.superworker.driver')).trim();
    expect(registered).toBe(mergeDriverCommand());
    expect(readAbsoluteForm(registered).missing).toEqual([]);
    // 5. the machine layer was copied, never moved: the new home answers, the old file stands.
    expect(report.machineLayer).toBe('copied');
    expect(readFileSync(globalConfigPath(staged.home), 'utf8')).toBe('{"session_host_override":"on"}');
    expect(readFileSync(join(staged.home, LEGACY_DIR_NAME, 'config.json'), 'utf8'))
      .toBe('{"session_host_override":"on"}');
    // 6. the pool's plan paths follow the directory; the path that merely begins with the old
    //    name's letters and the free text do not.
    expect(report.planPathsRewritten).toBe(2);
    const pool = JSON.parse(
      readFileSync(join(staged.project, RECORD_DIR_NAME, 'issues', 'issues.json'), 'utf8'),
    ) as { issues: Record<string, Record<string, unknown>> };
    expect(pool.issues.moved_root!.plan_path).toBe(`${RECORD_DIR_NAME}/plan/a.md`);
    expect(pool.issues.moved_nested!.plan_path).toBe(`docs/${RECORD_DIR_NAME}/plan/b.md`);
    expect(pool.issues.kept_prefix!.plan_path).toBe(`${LEGACY_DIR_NAME}notes/keep.md`);
    expect(pool.issues.free_text!.title).toBe(`the old directory ${LEGACY_DIR_NAME}/ is named in prose`);
    expect(pool.issues.free_text!.description).toBe(`${LEGACY_DIR_NAME}/ everywhere`);
    // Everything was staged to succeed, so no attachment has a warning.
    expect(report.warnings).toEqual([]);
  });

  it.skipIf(!SLOW)('a project deeper in the repository: the prefixed exclude line moves the same way', async () => {
    const staged = await stageGeneration010({ prefix: 'packages/app' });
    const report = await open(staged.project).ledger.migrate('0.1.0', { git: realGit });
    expect(report.exclude).toBe('written');
    const exclude = readFileSync(staged.excludePath, 'utf8');
    expect(exclude).toContain('/packages/app/.superworker/');
    expect(exclude).not.toContain(`/packages/app/${LEGACY_DIR_NAME}/`);
  });

  it.skipIf(!SLOW)('the machine layer keeps what is already at the new home: skipped, both files keep their own bytes', async () => {
    const staged = await stageGeneration010({ home: true });
    const target = globalConfigPath(staged.home);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{"newer_writing":true}', 'utf8');

    const report = await open(staged.project).ledger.migrate('0.1.0', { git: realGit, homeDir: staged.home });
    expect(report.machineLayer).toBe('skipped-target-present');
    // A settings file at the new home is somebody's newer writing, not a leftover: it stays, and
    // the old home is untouched — copy never moves, and never onto what is there.
    expect(readFileSync(target, 'utf8')).toBe('{"newer_writing":true}');
    expect(readFileSync(join(staged.home, LEGACY_DIR_NAME, 'config.json'), 'utf8'))
      .toBe('{"session_host_override":"on"}');
  });

  it('no git handed in: the directory still moves, and the two git-side attachments are named in warnings', async () => {
    // The rename is the bottom line; the attachments are best-effort. A caller without a git gets
    // the move and two sentences saying what the workspace is like without the lines.
    const home = mkdtempSync(join(tmpdir(), 'superworker-migrate-home-'));
    homes.push(home);
    await open(root).ledger.init();
    renameSync(join(root, RECORD_DIR_NAME), legacyRecordDir(root));

    const report = await open(root).ledger.migrate('0.1.0', { homeDir: home });
    expect(report.moved).toBe(true);
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.warnings).toHaveLength(2);
    const said = report.warnings.join('\n');
    expect(said).toContain('not kept out of the project repository');
    expect(said).toContain('merge driver');
    // The machine layer was still asked: an empty walled home has no old settings to copy.
    expect(report.machineLayer).toBe('skipped-no-source');
  });
});

describe('idempotence and the two quiet answers', () => {
  it.skipIf(!SLOW)('a second run is empty work: not a byte moves anywhere', async () => {
    const staged = await stageGeneration010({ home: true });
    const superworker = open(staged.project);
    await superworker.ledger.migrate('0.1.0', { git: realGit, homeDir: staged.home });
    const treeBefore = hashTree(join(staged.project, RECORD_DIR_NAME));
    const excludeBefore = readFileSync(staged.excludePath, 'utf8');
    const homeBefore = hashTree(staged.home);

    const again = await superworker.ledger.migrate('0.1.0', { git: realGit, homeDir: staged.home });
    expect(again.moved).toBe(false);
    expect(again.exclude).toBe('skipped');
    expect(again.gitattributes).toBe('skipped');
    expect(again.mergeDriver).toBe('skipped');
    expect(again.mergeDriverCommand).toBeNull();
    expect(again.machineLayer).toBe('skipped');
    expect(again.planPathsRewritten).toBe(0);
    expect(again.warnings).toEqual([]);
    expect(again.known).toBeUndefined();
    expect(hashTree(join(staged.project, RECORD_DIR_NAME))).toBe(treeBefore);
    expect(readFileSync(staged.excludePath, 'utf8')).toBe(excludeBefore);
    expect(hashTree(staged.home)).toBe(homeBefore);
  });

  it('a workspace with nothing under the old name: empty work, not an error', async () => {
    const report = await open(root).ledger.migrate('0.1.0', { git: realGit });
    expect(report.moved).toBe(false);
    expect(report.exclude).toBe('skipped');
    expect(report.warnings).toEqual([]);
    expect(existsSync(join(root, RECORD_DIR_NAME))).toBe(false);
  });

  it.skipIf(!SLOW)('no generation named: the known generations come back and nothing is done', async () => {
    const staged = await stageGeneration010();
    const excludeBefore = readFileSync(staged.excludePath, 'utf8');

    const report = await open(staged.project).ledger.migrate(undefined, { git: realGit });
    expect(report.generation).toBe('');
    expect(report.moved).toBe(false);
    expect(report.known?.map((entry) => entry.id)).toEqual(['0.1.0']);
    for (const entry of report.known ?? []) expect(typeof entry.label).toBe('string');
    // Nothing was read beyond what a listing needs: the workspace stands as it was.
    expect(existsSync(legacyRecordDir(staged.project))).toBe(true);
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(false);
    expect(readFileSync(staged.excludePath, 'utf8')).toBe(excludeBefore);
  });

  it.skipIf(!SLOW)('an unknown generation: refused with the known ones named, and nothing moved', async () => {
    const staged = await stageGeneration010();
    const excludeBefore = readFileSync(staged.excludePath, 'utf8');

    let caught: unknown;
    try {
      await open(staged.project).ledger.migrate('9.9.9', { git: realGit });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toContain('unknown generation');
    expect(message).toContain('0.1.0');
    expect(message).toContain('Nothing was moved');
    expect(existsSync(legacyRecordDir(staged.project))).toBe(true);
    expect(readFileSync(staged.excludePath, 'utf8')).toBe(excludeBefore);
  });
});

describe.skipIf(!SLOW)('the five refusals: each names the fact that stopped the move, hands the job to an agent, and moves nothing', () => {
  /** Run the migration expecting the refusal named by `pattern`; the old tree stands, nothing moved. */
  async function expectRefusal(project: string, pattern: RegExp): Promise<string> {
    let caught: unknown;
    try {
      await open(project).ledger.migrate('0.1.0', { git: realGit });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toMatch(pattern);
    // Every refusal points at an agent rather than at a hand edit, and says what did not happen.
    expect(message).toContain('consult an agent');
    expect(message).toContain('nothing was moved');
    expect(existsSync(legacyRecordDir(project))).toBe(true);
    return message;
  }

  it('both record directories on disk: both-present', async () => {
    const staged = await stageGeneration010();
    mkdirSync(join(staged.project, RECORD_DIR_NAME), { recursive: true });
    await expectRefusal(staged.project, /both .* are here/);
    // The refusal judges, it does not tidy: both directories are exactly where they were.
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(true);
  });

  it('the old tree carries no init marks: unrecognizable', async () => {
    const staged = await stageGeneration010();
    rmSync(join(legacyRecordDir(staged.project), '.gitignore'));
    await expectRefusal(staged.project, /does not carry the marks/);
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(false);
  });

  it('the old tree tracked by the project git: tracked-by-git', async () => {
    // Renaming a tracked directory would half-remove it from the repository's history, so this
    // refusal is asked of git itself — here it is really tracked (`git add -f` through the ignore).
    const staged = await stageGeneration010();
    await git(root, 'add', '-f', LEGACY_DIR_NAME);
    await expectRefusal(staged.project, /tracked by this project's git/);
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(false);
  });

  it('the record lock is held in the old tree: locked', async () => {
    const staged = await stageGeneration010();
    const lock = join(legacyRecordDir(staged.project), 'meta', 'ledger.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '', 'utf8');
    await expectRefusal(staged.project, /record lock/);
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(false);
  });

  it('a parallel-mode worktree is checked out in the old tree: worktrees', async () => {
    const staged = await stageGeneration010();
    const worktree = join(legacyRecordDir(staged.project), 'worktrees', 'dead1o2e');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'README'), 'a checked-out worktree\n', 'utf8');
    await expectRefusal(staged.project, /worktree/);
    expect(existsSync(join(staged.project, RECORD_DIR_NAME))).toBe(false);
  });
});
