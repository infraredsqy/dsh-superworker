/**
 * The one module that still knows the old record directory.
 *
 * Every other module in the engine, the host half and the browser half spells the record directory
 * one way: {@link RECORD_DIR_NAME}, `.superworker`. A workspace that ran the pipeline before the
 * rename holds its records under `.pf` instead, and that spelling had to land somewhere or it would
 * have landed everywhere — so it lands here, once, and the three readers that must act on it ask
 * this module rather than spelling the directory themselves:
 *
 * - the wake (`src/host/wake.ts`), because a workspace with only the old directory has to reach
 *   `migrate` and `doctor` before it can reach anything else;
 * - the panel's record read (`src/host/records.ts`), because "there is an old directory here" is a
 *   reading of its own and not a blank panel;
 * - `doctor` and `migrate` themselves, which are the only two words allowed to name it back to a
 *   person.
 *
 * Nothing here reads a record, and nothing here writes one. This module answers three questions
 * about a workspace root — is there one, can it be recognised, may it be moved — and carries the
 * sentence the panel's link hands to a person.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRunner } from './git.ts';
import { INIT_MARKERS } from './initledger.ts';
import { RECORD_DIR_NAME } from './paths.ts';

/**
 * The record directory as it was spelled before the rename. This is the only copy of that literal
 * in the tree: a second copy is a second answer to "which directory is the old one".
 */
export const LEGACY_DIR_NAME = '.pf';

/** The old record directory of one workspace root. */
export function legacyRecordDir(root: string): string {
  return join(root, LEGACY_DIR_NAME);
}

/**
 * Whether this root holds a directory under the old name at all. A path that cannot be stat-ed is
 * not one: an unreadable root answers as the workspace that never had a record.
 */
export function hasLegacyRecord(root: string): boolean {
  try {
    const dir = legacyRecordDir(root);
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the old directory is one `init` laid down: the same two marks every record directory
 * carries, `.gitignore` and `.gitattributes`. A `.pf` that is not marked is somebody else's
 * directory that happens to share the name, and the pipeline treats it as absent every place but
 * `migrate`, which says so rather than guessing.
 *
 * The marks are asked of the layout table (`INIT_MARKERS`), not restated here: the day a third mark
 * lands, both readings learn it at once.
 */
export function isRecognizableLegacyRecord(root: string): boolean {
  if (!hasLegacyRecord(root)) return false;
  const dir = legacyRecordDir(root);
  return INIT_MARKERS.every((marker) => {
    const path = join(dir, marker);
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Why a workspace cannot simply be migrated by a person running `migrate 0.1.0`: the five refusals,
 * each one a fact about the tree, and each one an invitation to consult an agent rather than an
 * instruction to edit something by hand. `absent` is not a refusal in that sense — it is the answer
 * a root with no old directory gets, and the one an already-migrated workspace gets.
 */
export type MigrationRefusal =
  /** No old record directory, or no new one either: nothing to move. */
  | 'absent'
  /** Both directories are here, and only a person can say which records are the true ones. */
  | 'both-present'
  /** A `.pf` nobody `init`-ed: not a record this pipeline laid down. */
  | 'unrecognizable'
  /** The project's git tracks the old directory, so renaming it would half-remove it from history. */
  | 'tracked-by-git'
  /** The cross-process lock is held: a run is in flight. */
  | 'locked'
  /** A parallel-mode worktree is checked out, and worktree metadata holds absolute paths. */
  | 'worktrees';

/** The reading of one preconditions pass: ready to move, or the one fact that stops it. */
export type MigrationReading =
  | { readonly ready: true; readonly legacyDir: string; readonly recordDir: string }
  | { readonly ready: false; readonly refusal: MigrationRefusal };

/**
 * Whether one record directory an `init` laid down holds a worktree of the parallel mode. The
 * directory is the record tree's own, not a repository's: an empty `worktrees/` is a worktree
 * reading of zero.
 */
function holdsWorktrees(recordDir: string): boolean {
  const dir = join(recordDir, 'worktrees');
  try {
    return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir, { withFileTypes: true }).length > 0;
  } catch {
    return false;
  }
}

/** Whether the cross-process lock is present: a run that holds it is a run that must not be moved. */
function lockHeld(recordDir: string): boolean {
  try {
    return existsSync(join(recordDir, 'meta', 'ledger.lock'));
  } catch {
    return false;
  }
}

/**
 * Whether the project's git tracks the old record directory. Asked through the injected runner and
 * nothing else: the engine starts no process, and a git that cannot answer is read as "not
 * tracked" — the migration then proceeds and the tracked-directory check `init` performs catches
 * the mistake before a byte lands.
 */
async function trackedByProjectGit(root: string, git: GitRunner | undefined): Promise<boolean> {
  if (git === undefined) return false;
  try {
    const listing = await git.run(root, ['ls-files', '--', LEGACY_DIR_NAME]);
    return listing.code === 0 && listing.stdout.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * The one reading of "may this workspace's records be moved", shared by `doctor` and `migrate`.
 *
 * The order is the order a person needs: what is here, whether it is ours, whether git or a running
 * process is holding it. A refusal says which of those it was and stops; there is no partial
 * readiness.
 */
export async function migrationPreconditions(
  root: string,
  git?: GitRunner,
): Promise<MigrationReading> {
  const legacyDir = legacyRecordDir(root);
  const recordDir = join(root, RECORD_DIR_NAME);
  if (!hasLegacyRecord(root)) return { ready: false, refusal: 'absent' };
  if (!isRecognizableLegacyRecord(root)) return { ready: false, refusal: 'unrecognizable' };
  if (existsSync(recordDir)) return { ready: false, refusal: 'both-present' };
  if (await trackedByProjectGit(root, git)) return { ready: false, refusal: 'tracked-by-git' };
  if (lockHeld(legacyDir)) return { ready: false, refusal: 'locked' };
  if (holdsWorktrees(legacyDir)) return { ready: false, refusal: 'worktrees' };
  return { ready: true, legacyDir, recordDir };
}

/**
 * The first thing the panel's link sends into a new session: a person clicks "let an agent finish
 * this", and the agent arrives already knowing which directory moved and what it is being asked to
 * do with it. It is a fixed sentence rather than a composed one — a prompt assembled from the
 * workspace would be a second place that spells both directories.
 */
export const CONSULT_PROMPT =
  '/sw-route 本工作区的记录目录已由 .pf 更名为 .superworker。请先解释这次变更的影响，再完成迁移。';