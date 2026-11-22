import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A directory hash: every entry's relative path and content, sorted by name, fed into sha256 one
 * after another. Any byte of a record changing changes the hash; anything outside the records is
 * none of its business. Two faces share this one walk:
 *
 * - The default face reads **every byte of a record**. It backs the idempotence pins: a verb asked
 *   twice (a `plan` re-read, a dispatch prepared again) must not move a byte of the record it
 *   stands on, and a byte it did move has to go red.
 * - `skipLiveFaces: true` is the repo-root guard's face (`tests/global-setup.ts`). When the pipeline
 *   that drives this repo runs a parallel cycle, its sessions write records for the whole suite
 *   window: the node and handoff and issue directories (`nodes/`, `signals/`, `issues/`), the
 *   record files (`ideas.json`, `state.json`, `instructions.json`), the settings layer
 *   (`config.json`), and the record repo's own object store (`.git`, which grows with every
 *   node-close commit — and with it the two full-tree reads past any time budget). This face skips
 *   those, top-level only, and covers the stable remainder: the seed files `init` lays into a
 *   checkout (`.gitignore`, `.gitattributes`, `AGENTS.md`) and any byte that is not one of the known
 *   faces — so another cell's ordinary work cannot trip the sentinel by mistake, while a suite that
 *   lands anything new, or touches the seed, still goes red.
 *
 * Three kinds of directory are skipped on both faces: a top-level `worktrees/`, a top-level
 * `meta/`, and a `temp/` at any depth (per the layout in `src/paths.ts`, `temp` only appears at
 * `nodes/<id>/temp`). They are the areas the superworker tool runs itself (`.superworker/.gitignore` takes them out
 * of the repository too): `worktrees/` holds the forked node work areas, where vitest caches and
 * temp files keep changing while a parallel line runs tests in them; `meta/` holds cross-process
 * locks, session notes and dispatch papers, written by the tool itself; `nodes/<id>/temp/` holds
 * each node's probes and raw output.
 *
 * A directory that does not exist comes back as a fixed sentinel: absent before and absent after
 * means consistent; a directory appearing out of nowhere mid-run is still caught. The records stay
 * out of the project repository — the one layout there is — so a checkout of this project carries
 * no records of its own; the cell a checkout would never carry even then is a node's `temp/` one,
 * kept out of any repository by the record dir's own `.gitignore`.
 */
export function hashDirectory(dir: string, { skipLiveFaces = false } = {}): string {
  if (!existsSync(dir)) return createHash('sha256').update('absent').digest('hex');
  const hash = createHash('sha256');
  walk(dir, dir, hash, skipLiveFaces);
  return hash.digest('hex');
}

/** Names the tool runs itself, appearing only at the top of the records dir; the whole tree is skipped. */
const TOOL_MANAGED_AT_TOP = new Set(['worktrees', 'meta']);

/** The record repo the engine lays inside the records dir when `ledger.init` is asked for one: git machinery, never a record byte. */
const RECORD_REPO_AT_TOP = new Set(['.git']);

/** The live-session write faces: top-level directories a running line's sessions write in ordinary work. */
const LIVE_SESSION_DIRS_AT_TOP = new Set(['nodes', 'signals', 'issues']);

/** The live-session write faces: the record files and the settings layer at the top of the records dir. */
const LIVE_SESSION_FILES_AT_TOP = new Set(['ideas.json', 'state.json', 'instructions.json', 'config.json']);

/** Names of tool-run process-artifact dirs, skipped at any depth. */
const TOOL_MANAGED_ANYWHERE = new Set(['temp']);

function walk(
  rootDir: string,
  dir: string,
  hash: ReturnType<typeof createHash>,
  skipLiveFaces: boolean,
): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(rootDir, full).split('\\').join('/');
    if (entry.isDirectory()) {
      if (TOOL_MANAGED_ANYWHERE.has(entry.name)) continue;
      if (dir === rootDir) {
        if (TOOL_MANAGED_AT_TOP.has(entry.name)) continue;
        if (RECORD_REPO_AT_TOP.has(entry.name)) continue;
        if (skipLiveFaces && LIVE_SESSION_DIRS_AT_TOP.has(entry.name)) continue;
      }
      hash.update(`dir:${rel}\n`);
      walk(rootDir, full, hash, skipLiveFaces);
    } else if (entry.isFile()) {
      if (skipLiveFaces && dir === rootDir && LIVE_SESSION_FILES_AT_TOP.has(entry.name)) continue;
      hash.update(`file:${rel}\n`);
      hash.update(readFileSync(full));
      hash.update('\n');
    }
    // Entries that are neither a directory nor a plain file (symlinks and the like) do not enter
    // the hash; there are none of those in a records dir.
  }
}
