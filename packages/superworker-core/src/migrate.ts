import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRunner } from './git';
import { isExistingPath, isMissingPath } from './fs-helpers';
import {
  excludeDecoder,
  excludeLineFor,
  gitPathOf,
  isFileThere,
  mergeDriverCommand,
  repairLayoutFile,
  withExcludeLine,
  writeMergeDriverKeys,
} from './initledger';
import {
  atomicWriteBytes,
  atomicWriteJson,
  exclusiveCreateBytes,
  jsonOptionsForRecord,
  readJsonFile,
} from './jsonio';
import { withLedgerLock } from './ledgerlock';
import { LEGACY_DIR_NAME, legacyRecordDir, migrationPreconditions } from './legacy';
import type { MigrationRefusal } from './legacy';
import { RECORD_DIR_NAME, globalConfigPath, globalHomeDir, recordPaths } from './paths';
import type { RecordPaths } from './paths';

/**
 * `migrate`: the one act that moves a workspace's records from the old record directory to
 * `.superworker/`. The move is generation-labelled because a move is judged against the writer that
 * laid the records down, not guessed from the files: `0.1.0` is the one generation this engine
 * knows, the records 0.1.x wrote.
 *
 * The reading:
 *
 * - **The refusals are not spelled here.** `migrationPreconditions` is the one reading of "may this
 *   workspace's records move", shared with `doctor`, so the two words cannot disagree about a
 *   workspace. `absent` is the quiet answer — a migrated workspace runs again as empty work — and
 *   the other five throw, each sentence pointing at an agent rather than at a hand edit.
 * - **The rename is the bottom line, the rest are attachments.** The directory moves first, in one
 *   atomic step; every step after works on the new location, and a step that does not happen is one
 *   sentence of `warnings` — the same shape `init` reports in, and never a rollback.
 * - **The attachments reuse the writers `init` uses.** The exclude line goes through the same strict
 *   reader and line splicer (a file this engine cannot re-encode is not rewritten); the record
 *   directory's own `.gitattributes` is brought to the current constant bytes; the driver is
 *   re-registered in the absolute form; the machine layer's settings are **copied**, never moved (an
 *   install that has not moved yet keeps answering where it always did), and a settings file already
 *   at the new home is kept, because it is newer than anything migration may add; the issue pool's
 *   `plan_path` values follow the directory, because a value still naming the old one is a directory
 *   the pipeline would recreate on its next write.
 * - **The migrated tree is a record tree like any other once it has moved.** The steps that write
 *   into it run under its own record lock, the same protocol every engine writer holds; the rename
 *   itself runs before that lock exists to hold, and the preconditions are what gate it.
 */

/** One generation this engine can move: the word a person types, and the one line about what a workspace of that generation holds. */
export interface KnownGeneration {
  readonly id: string;
  readonly label: string;
}

/**
 * The generations this engine moves, in the order they are printed. A second entry lands only with
 * its own writer's reading — a move is judged against the generation that wrote the records, and a
 * generation nobody can read is a refusal, not a guess.
 */
export const KNOWN_GENERATIONS: readonly KnownGeneration[] = [
  { id: '0.1.0', label: 'the records 0.1.x wrote' },
];

/** The choices of `migrate`. */
export interface LedgerMigrateOptions {
  /** The git capability; without it the two git-side attachments are skipped and named in `warnings`. */
  readonly git?: GitRunner;
  /** The machine layer's home; absent, it resolves the way every home does (`paths.globalHomeDir`). */
  readonly homeDir?: string;
}

/** How the exclude attachment read this time. */
export type MigrationExcludeReading =
  /** The old line is out and the new one is in place (written now, or already there). */
  | 'written'
  /** Nothing was moved, so no line was looked at. */
  | 'skipped'
  /** No git to ask, not a checkout, or git would not say where the file or this project is. */
  | 'skipped-not-a-checkout'
  /** The file was found and could not be rewritten; `warnings` names the file and the failure. */
  | 'failed';

/** How the record directory's own `.gitattributes` read this time. */
export type MigrationGitAttributesReading =
  /** The bytes differ from the current constant body, and the current body was written. */
  | 'rewritten'
  /** The file already carries the current bytes, so nothing was written. */
  | 'unchanged'
  /** Nothing was moved, so the file was not looked at. */
  | 'skipped'
  /** The file could not be rewritten; `warnings` names why, and the old attribute may still be in force. */
  | 'failed';

/**
 * How the merge driver's re-registration read this time. `kept` is not among the readings: a
 * migration writes the registration, because the registration a 0.1.x machine holds answers the old
 * attribute's name and is exactly what this step replaces.
 */
export type MigrationDriverReading =
  /** The two keys were written now. */
  | 'written'
  /** Nothing was moved, so no registration was written. */
  | 'skipped'
  /** No writable git config (no runner, or git refused); `warnings` names it. */
  | 'skipped-no-config';

/** How the machine layer's settings read this time. */
export type MigrationMachineLayerReading =
  /** The source was there, the target was not, and the copy landed. */
  | 'copied'
  /** A settings file is already at the new home; the old copy was left alone. */
  | 'skipped-target-present'
  /** The old machine layer held no settings file; there is nothing this machine carried to copy. */
  | 'skipped-no-source'
  /** Nothing was moved, so the machine layer was not looked at. */
  | 'skipped'
  /** The copy failed; the old machine layer is untouched, and `warnings` names why. */
  | 'failed';

/** What `migrate` hands back: what it moved, what it skipped, and why — the same shape `init` reports in. */
export interface MigrationReport {
  /** The generation this run acted on; empty when the call named none and nothing was done. */
  generation: string;
  /** Whether the records moved. False: the call named no generation, or the workspace has nothing left to move. */
  moved: boolean;
  /** The generations this engine moves, handed back for the call that named none. */
  known?: readonly KnownGeneration[];
  /** The directory the records moved out of; present only when `moved`. */
  from?: string;
  /** The directory the records answer under now; present only when `moved`. */
  to?: string;
  exclude: MigrationExcludeReading;
  gitattributes: MigrationGitAttributesReading;
  mergeDriver: MigrationDriverReading;
  /** The command `merge.superworker.driver` holds after this run; null when it could not be written. */
  mergeDriverCommand: string | null;
  machineLayer: MigrationMachineLayerReading;
  /** How many `plan_path` values in the issue pool now name the new directory. */
  planPathsRewritten: number;
  /** One sentence per attachment that did not happen: what was not done, why, and what the workspace is like without it. */
  warnings: string[];
}

/** One attachment's outcome: its reading, and the one sentence a failed or skipped attachment leaves. */
interface Step<Reading> {
  readonly reading: Reading;
  readonly warning?: string;
}

/** The driver step's outcome carries the command that was written, so a caller can print what is in force. */
interface DriverStep extends Step<MigrationDriverReading> {
  readonly command: string | null;
}

/** The issue pool step's outcome carries the count of rewritten values. */
interface PlanPathStep {
  readonly rewritten: number;
  readonly warning?: string;
}

/**
 * Move a workspace's records from the old record directory to `.superworker/`. Without a generation
 * nothing is read and nothing is written — the report only carries the known generations for the
 * caller to print; with an unknown one the call throws, again without moving a byte.
 */
export async function migrateLedger(
  root: string,
  generation?: string,
  options: LedgerMigrateOptions = {},
): Promise<MigrationReport> {
  if (generation === undefined) {
    return quietReport('', KNOWN_GENERATIONS);
  }
  if (!KNOWN_GENERATIONS.some((entry) => entry.id === generation)) {
    throw new Error(
      `unknown generation ${JSON.stringify(generation)}: this engine moves ` +
        `${KNOWN_GENERATIONS.map((entry) => entry.id).join(', ')} — name one of those, or run ` +
        '`migrate` with no generation to see the list. Nothing was moved.',
    );
  }
  const reading = await migrationPreconditions(root, options.git);
  if (!reading.ready) {
    if (reading.refusal === 'absent') return quietReport(generation);
    throw refusalError(root, reading.refusal);
  }
  // The bottom line: one atomic step, all or nothing. Everything after works on the new location,
  // and the record tree's writers hold its lock there from this point on.
  await rename(reading.legacyDir, reading.recordDir);
  const paths: RecordPaths = recordPaths(root);
  const warnings: string[] = [];
  return withLedgerLock(paths, async () => {
    const exclude = await moveExcludeLine(root, options.git);
    if (exclude.warning !== undefined) warnings.push(exclude.warning);
    const gitattributes = await repairDriverAttributes(paths);
    if (gitattributes.warning !== undefined) warnings.push(gitattributes.warning);
    const driver = await registerMigratedDriver(root, options.git);
    if (driver.warning !== undefined) warnings.push(driver.warning);
    const machineLayer = await copyMachineLayer(options.homeDir);
    if (machineLayer.warning !== undefined) warnings.push(machineLayer.warning);
    const planPaths = await rewritePlanPaths(paths);
    if (planPaths.warning !== undefined) warnings.push(planPaths.warning);
    return {
      generation,
      moved: true,
      from: reading.legacyDir,
      to: reading.recordDir,
      exclude: exclude.reading,
      gitattributes: gitattributes.reading,
      mergeDriver: driver.reading,
      mergeDriverCommand: driver.command,
      machineLayer: machineLayer.reading,
      planPathsRewritten: planPaths.rewritten,
      warnings,
    };
  });
}

/**
 * The report a run hands back when it acts on nothing: every cell skipped, no warnings, and the
 * known generations for the caller that named none. A migrated workspace reads exactly this, which
 * is what makes re-running a migration empty work rather than a second move.
 */
function quietReport(generation: string, known?: readonly KnownGeneration[]): MigrationReport {
  return {
    generation,
    moved: false,
    ...(known === undefined ? {} : { known }),
    exclude: 'skipped',
    gitattributes: 'skipped',
    mergeDriver: 'skipped',
    mergeDriverCommand: null,
    machineLayer: 'skipped',
    planPathsRewritten: 0,
    warnings: [],
  };
}

/**
 * The error a refused migration throws. Each sentence names the fact that stopped the move and hands
 * the job to an agent: every one of these refusals is a judgement or a removal this engine must not
 * make, and talking a person into a hand edit is how a record tree gets hurt.
 */
function refusalError(root: string, refusal: MigrationRefusal): Error {
  const oldDir = legacyRecordDir(root);
  const newDir = join(root, RECORD_DIR_NAME);
  const sentence =
    refusal === 'both-present'
      ? `both ${oldDir} and ${newDir} are here, and which records are the true ones is a judgement no word can make`
      : refusal === 'unrecognizable'
        ? `${oldDir} is here but does not carry the marks an init lays down, so it may not be a record directory of this pipeline at all`
        : refusal === 'tracked-by-git'
          ? `${oldDir} is tracked by this project's git, and renaming it would half-remove it from the repository's history`
          : refusal === 'locked'
            ? `${oldDir} holds the record lock, so a run is in flight and the records must not move under it`
            : refusal === 'worktrees'
              ? `${oldDir} holds a parallel-mode worktree, and a worktree's git metadata carries absolute paths`
              : 'there is nothing to move here';
  return new Error(
    `${sentence} — consult an agent rather than editing anything by hand; nothing was moved.`,
  );
}

// ── the exclude line ─────────────────────────────────────────────────────────

/** The opening clause of every exclude warning: the sentence says what the workspace is like without the line. */
const EXCLUDE_NOT_KEPT_OUT = `the new record directory (${RECORD_DIR_NAME}/) is not kept out of the project repository`;

function notKeptOut(why: string): string {
  return `${EXCLUDE_NOT_KEPT_OUT}: ${why}.`;
}

/**
 * Switch the project repository's `info/exclude` to the new directory: the old line out, the new
 * line in. The reader, the splicer and the byte rules are `init`'s own — a file that cannot be
 * re-encoded is not rewritten, and a read failure is never folded to an empty file, because
 * rewriting from a half-reading would drop every other project's line in it. The old spelling is
 * taken out in both forms it is written in: the root-anchored one for a project at the repository
 * root, the prefixed one for a project that sits deeper.
 */
async function moveExcludeLine(
  root: string,
  git: GitRunner | undefined,
): Promise<Step<MigrationExcludeReading>> {
  if (git === undefined) {
    return {
      reading: 'skipped-not-a-checkout',
      warning: notKeptOut('the info/exclude line was not written because no git was handed to the engine'),
    };
  }
  const excludePath = await gitPathOf(root, git, '--git-path', 'info/exclude');
  if (excludePath === null) {
    return {
      reading: 'skipped-not-a-checkout',
      warning:
        notKeptOut('git would not say where info/exclude is ' +
          '(rev-parse --git-path info/exclude answered nothing usable)'),
    };
  }
  const newLine = await excludeLineFor(root, git, RECORD_DIR_NAME);
  if (newLine === null) {
    return {
      reading: 'skipped-not-a-checkout',
      warning:
        notKeptOut('git would not say where this project sits inside the repository ' +
          '(rev-parse --show-prefix answered nothing usable)'),
    };
  }
  const oldLine = await excludeLineFor(root, git, LEGACY_DIR_NAME);
  let bytes: Uint8Array | null = null;
  try {
    bytes = await readFile(excludePath);
  } catch (error) {
    // Only a file that is not there yet means "no exclude file"; any other read failure is named,
    // and nothing is written — the same rule `init` reads the file by.
    if (!isMissingPath(error)) {
      return {
        reading: 'failed',
        warning:
          `${EXCLUDE_NOT_KEPT_OUT}: ${excludePath} was found but could not be read (${messageOf(error)}), ` +
          'so rewriting it could drop another project\'s line; nothing was written, and the old line is still there.',
      };
    }
  }
  let current = '';
  if (bytes !== null) {
    try {
      current = excludeDecoder.decode(bytes);
    } catch {
      return {
        reading: 'failed',
        warning:
          `${EXCLUDE_NOT_KEPT_OUT}: ${excludePath}'s bytes are not valid UTF-8, so rewriting it would replace ` +
          'bytes this engine cannot re-encode; nothing was written, and the old line is still there.',
      };
    }
  }
  const withoutRootForm = withExcludeLine(current, `/${LEGACY_DIR_NAME}/`, false);
  const withoutOld = oldLine === null ? withoutRootForm : withExcludeLine(withoutRootForm.text, oldLine, false);
  const next = withExcludeLine(withoutOld.text, newLine, true);
  if (next.text === current) return { reading: 'written' };
  try {
    await atomicWriteBytes(excludePath, new TextEncoder().encode(next.text));
  } catch (error) {
    return {
      reading: 'failed',
      warning:
        `${EXCLUDE_NOT_KEPT_OUT}: ${excludePath} was found but could not be written (${messageOf(error)}); ` +
        'the old line may still be there and the new one may be missing.',
    };
  }
  return { reading: 'written' };
}

// ── the record directory's own .gitattributes ────────────────────────────────

/**
 * Bring the record directory's own `.gitattributes` to the current constant bytes. The driver's
 * attribute moved with the rename, and the constant body is the only spelling of the new one — the
 * same repair rule `init` applies to the file: rewritten when the bytes differ, untouched when they
 * match, so a migrated directory and an init-ed one carry the same file.
 */
async function repairDriverAttributes(paths: RecordPaths): Promise<Step<MigrationGitAttributesReading>> {
  try {
    return { reading: (await repairLayoutFile(paths, '.gitattributes')) ? 'rewritten' : 'unchanged' };
  } catch (error) {
    return {
      reading: 'failed',
      warning:
        `The record directory's .gitattributes could not be rewritten (${messageOf(error)}): until it names ` +
        'the current driver, a merge of records between two branches comes back as a plain git conflict.',
    };
  }
}

// ── the merge driver's registration ──────────────────────────────────────────

/**
 * Re-register the merge driver for the new attribute name, in the absolute form — the one form this
 * package writes. The two keys are written unconditionally: a registration is kept only when this
 * machine really answers it, and the registration a 0.1.x machine holds answers the old attribute's
 * name, which is exactly what this step replaces.
 */
async function registerMigratedDriver(root: string, git: GitRunner | undefined): Promise<DriverStep> {
  if (git === undefined) {
    return {
      reading: 'skipped-no-config',
      command: null,
      warning:
        'The merge driver was not re-registered because no git was handed to the engine: two branches that both ' +
        'changed a record come back as a plain git conflict until `register` runs.',
    };
  }
  const command = mergeDriverCommand();
  try {
    const wrote = await writeMergeDriverKeys(root, git, command);
    if (!wrote.ok) {
      return {
        reading: 'skipped-no-config',
        command: null,
        warning:
          `The merge driver was not re-registered: ${wrote.detail}. Two branches that both changed a record ` +
          'come back as a plain git conflict.',
      };
    }
    return { reading: 'written', command };
  } catch (error) {
    return {
      reading: 'skipped-no-config',
      command: null,
      warning: `The merge driver was not re-registered: git could not be run (${messageOf(error)}).`,
    };
  }
}

// ── the machine layer ────────────────────────────────────────────────────────

/**
 * Copy the machine layer's settings to the new home. **Copy, never move, and never onto what is
 * already there**: the old machine layer keeps answering for an install that has not moved yet, and
 * a settings file at the new home is somebody's newer writing, not a leftover to overwrite. The
 * landing is the record foundation's exclusive creation, so two runs racing on one target cannot
 * both write it.
 */
async function copyMachineLayer(homeDir?: string): Promise<Step<MigrationMachineLayerReading>> {
  const home = globalHomeDir(homeDir);
  const source = join(home, LEGACY_DIR_NAME, 'config.json');
  const target = globalConfigPath(homeDir);
  if (isFileThere(target)) return { reading: 'skipped-target-present' };
  if (!isFileThere(source)) return { reading: 'skipped-no-source' };
  let bytes: Uint8Array;
  try {
    bytes = await readFile(source);
  } catch (error) {
    return {
      reading: 'failed',
      warning:
        `The machine layer's settings were not copied: ${source} could not be read (${messageOf(error)}). ` +
        'The old machine layer is untouched, and the settings fall back to the factory defaults until the copy lands.',
    };
  }
  try {
    await exclusiveCreateBytes(target, bytes);
    return { reading: 'copied' };
  } catch (error) {
    if (isExistingPath(error)) return { reading: 'skipped-target-present' };
    return {
      reading: 'failed',
      warning:
        `The machine layer's settings were not copied: ${target} could not be written (${messageOf(error)}). ` +
        'The old machine layer is untouched, and the settings fall back to the factory defaults until the copy lands.',
    };
  }
}

// ── the issue pool's plan paths ──────────────────────────────────────────────

/**
 * The prefix a `plan_path` value may still carry, spelled as a path segment: the old directory's
 * name at the value's start or behind a separator, and nowhere else — a directory that merely ends
 * in the old name is somebody else's and stays as it is.
 */
const OLD_PREFIX = new RegExp(`(^|/)${LEGACY_DIR_NAME.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/`, 'gu');

/**
 * Rewrite the `plan_path` values of the issue pool that name the old directory, and nothing else in
 * the pool: every other field, free text included, travels through the round-trip untouched. The
 * write is the pool's own byte contract (its writer sorts the keys), so the file on disk stays a
 * file the pool wrote; the pool's own lock is not taken, because the migration runs only where the
 * preconditions found no run in flight — and the step is worth its window, since a value left
 * naming the old directory is a directory the pipeline would recreate.
 */
async function rewritePlanPaths(paths: RecordPaths): Promise<PlanPathStep> {
  let value: unknown;
  try {
    const read = await readJsonFile(paths.issuesJson, 'issues.json');
    if (read.kind === 'missing') return { rewritten: 0 };
    value = read.value;
  } catch (error) {
    return {
      rewritten: 0,
      warning:
        `The issue pool's plan paths were not rewritten: ${paths.issuesJson} could not be read as a record ` +
        `(${messageOf(error)}); a plan path still naming the old directory makes the pipeline recreate it — consult an agent.`,
    };
  }
  const pool = value as { issues?: unknown };
  if (pool === null || typeof pool !== 'object' || typeof pool.issues !== 'object' || pool.issues === null) {
    return { rewritten: 0 };
  }
  let rewritten = 0;
  for (const record of Object.values(pool.issues as Record<string, unknown>)) {
    if (record === null || typeof record !== 'object') continue;
    const planPath = (record as { plan_path?: unknown }).plan_path;
    if (typeof planPath !== 'string') continue;
    const next = planPath.replace(OLD_PREFIX, `$1${RECORD_DIR_NAME}/`);
    if (next === planPath) continue;
    (record as { plan_path: string }).plan_path = next;
    rewritten += 1;
  }
  if (rewritten === 0) return { rewritten: 0 };
  try {
    await atomicWriteJson(paths.issuesJson, value, jsonOptionsForRecord('issues'));
  } catch (error) {
    return {
      rewritten: 0,
      warning:
        `The issue pool's plan paths were read but not rewritten: ${paths.issuesJson} could not be written ` +
        `(${messageOf(error)}); a plan path still naming the old directory makes the pipeline recreate it — consult an agent.`,
    };
  }
  return { rewritten };
}

/** The one line an error answer carries, here and in `initledger`: an error's message as a sentence, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
