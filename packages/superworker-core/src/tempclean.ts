import { readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cycleHoldingIds, readStateLedger } from './cycles.ts';
import { isMissingPath } from './fs-helpers.ts';
import { nodeTempDir, type RecordPaths } from './paths.ts';

/**
 * The temp sweep (the piece `clean-temp` runs): list or delete each node's process-artifact
 * directory `nodes/<id>/temp/`.
 *
 * One place is swept, and only this one: the nodes dir of the record tree handed in. The worktrees
 * area (`<record>/worktrees/`) is not entered, because nothing under it is provably ours: a checkout of
 * a project set up here does carry its `.superworker` records when the layout is in-repo, but no `temp/` cell
 * of ours — `temp/` is kept out of the repository by the record dir's own `.gitignore` — and a
 * directory name is user data, not a provenance record.
 *
 * Only this one cell is touched: spec, reports, run doc, session notes and the rest of the tree
 * stay as they are. Nodes a line holds (`holding` in `state.json`) are skipped unless `force` — raw
 * output there may be being written at this moment. A `state.json` that will not read — bytes that
 * are not JSON, or a document whose top level is not an object — refuses the whole thing and touches
 * no temp: reading it as "no one holds anything" and going ahead is the worst kind of silent error.
 * That gate is not judged here: it is the one reading's (`readStateLedger`), so this sweep and every
 * other reader meet the same answer.
 */

/** The options of `cleanTemp`. */
export interface CleanTempOptions {
  /** Scan only this node: the full id or a prefix of it (the word's `--node`). */
  readonly node?: string;
  /** Really delete (the word's `--yes`); by default it only lists, touching not one byte. */
  readonly remove?: boolean;
  /** Clean the nodes a line holds (`holding` in `state.json`) too (the word's `--force`). */
  readonly force?: boolean;
}

/** The `temp/` directory reading of one node: whose it is, and how big. */
export interface CleanTempEntry {
  /** The name in the listing: the node id. */
  readonly name: string;
  readonly node: string;
  /** Which worktree this cell belongs to; every cell swept is the main tree's, so this is always `null`. */
  readonly worktree: string | null;
  /** The absolute location of `temp/`. */
  readonly dir: string;
  /** The number of files in the directory (recursive). */
  readonly files: number;
  /** The byte sum of those files. */
  readonly bytes: number;
}

/** The reading of `cleanTemp`. */
export interface CleanTempReport {
  /** The directories that would be deleted (listing) or were deleted (`remove`), in node name order. */
  readonly targets: readonly CleanTempEntry[];
  /** The directories a line holds and this round skipped (they are gone from here once `force` is given). */
  readonly running: readonly CleanTempEntry[];
  /** The directories really deleted (only filled under `remove`). */
  readonly removed: readonly CleanTempEntry[];
}

/** Clean the leftover `temp/` directories: list or delete each node's process-artifact directory. */
export async function cleanTemp(
  paths: RecordPaths,
  options: CleanTempOptions = {},
): Promise<CleanTempReport> {
  const held = await heldNodeIds(paths);
  const targets: CleanTempEntry[] = [];
  const running: CleanTempEntry[] = [];

  for (const name of nodeDirectoryNames(paths.nodesDir)) {
    if (options.node !== undefined && name !== options.node && !name.startsWith(options.node)) {
      continue;
    }
    const dir = nodeTempDir(paths, name);
    if (!isDirectory(dir)) continue;
    const entry: CleanTempEntry = {
      name,
      node: name,
      worktree: null,
      dir,
      ...measure(dir),
    };
    if (held.has(name) && options.force !== true) running.push(entry);
    else targets.push(entry);
  }

  const removed: CleanTempEntry[] = [];
  if (options.remove === true) {
    for (const entry of targets) {
      // One that will not delete stays on disk (the same reading as a tolerant delete): the report records only what was really deleted.
      try {
        await rm(entry.dir, { recursive: true, force: true });
      } catch {
        // A half-deleted directory will still be listed next time; it is not counted as cleaned here.
      }
      if (!isDirectory(entry.dir)) removed.push(entry);
    }
  }
  return { targets, running, removed };
}

// ── internals ───────────────────────────────────────────────────────────────

/** The node directory names under one nodes dir, sorted. */
function nodeDirectoryNames(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The file count (recursive) and byte sum of one directory. */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Whether this location is a directory; a missing one answers "no such cell", and any other disk error is thrown as it is. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

/**
 * The node ids the lines hold right now: the `holding` ids of every line in `state.json` (nothing held is
 * an empty set). The table comes from the engine's one reading of `state.json` (`readStateLedger`): a
 * record that will not read still refuses the whole clean through that reading (`parse_failure`), the
 * top-level shape gate included — refusing to read a document that is not an object is that reading's
 * job, not a second judgement here — and entries that cannot be line records are dropped there too.
 */
async function heldNodeIds(paths: RecordPaths): Promise<ReadonlySet<string>> {
  const ledger = await readStateLedger(paths);
  const held = new Set<string>();
  for (const cycle of ledger.cycles) {
    // Both on-disk shapes of a claim are read in one place (`cycleHoldingIds`): the canonical
    // `[{ id, since }]` and the bare id string an older disc carries.
    for (const id of cycleHoldingIds(cycle)) held.add(id);
  }
  return held;
}
