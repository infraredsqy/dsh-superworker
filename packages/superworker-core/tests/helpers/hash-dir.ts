import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A directory hash: every entry's relative path and content, sorted by name, fed into sha256 one
 * after another. Any byte of a record changing changes the hash; anything outside the records is
 * none of its business. It backs the invariant "the repo root .superworker hash is the same before and
 * after the full suite".
 *
 * Three kinds of directory are skipped: a top-level `worktrees/`, a top-level `meta/`, and a
 * `temp/` at any depth (per the layout in `src/paths.ts`, `temp` only appears at
 * `nodes/<id>/temp`). They are the areas the superworker tool runs itself (`.superworker/.gitignore` takes them out
 * of the repository too): `worktrees/` holds the forked node work areas, where vitest caches and
 * temp files keep changing while a parallel line runs tests in them; `meta/` holds cross-process
 * locks, session notes and dispatch papers, written by the tool itself; `nodes/<id>/temp/` holds
 * each node's probes and raw output. The sentinel protects records under the invariant "engine
 * operations must not land in the repo root .superworker" -- writes into these tool-run areas are not
 * covered, and hashing them would let a parallel line's ordinary work trip the sentinel by
 * mistake.
 *
 * A directory that does not exist comes back as a fixed sentinel: absent before and absent after
 * means consistent; a directory appearing out of nowhere mid-run is still caught. The records
 * themselves do travel with a checkout (the in-repo layout puts them in the repository); the cell a
 * checkout never carries is a node's `temp/` one, kept out by the record dir's own `.gitignore`.
 */
export function hashDirectory(dir: string): string {
  if (!existsSync(dir)) return createHash('sha256').update('absent').digest('hex');
  const hash = createHash('sha256');
  walk(dir, dir, hash);
  return hash.digest('hex');
}

/** Names the tool runs itself, appearing only at the top of the records dir; the whole tree is skipped. */
const TOOL_MANAGED_AT_TOP = new Set(['worktrees', 'meta']);

/** Names of tool-run process-artifact dirs, skipped at any depth. */
const TOOL_MANAGED_ANYWHERE = new Set(['temp']);

function walk(rootDir: string, dir: string, hash: ReturnType<typeof createHash>): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(rootDir, full).split('\\').join('/');
    if (entry.isDirectory()) {
      if (TOOL_MANAGED_ANYWHERE.has(entry.name)) continue;
      if (dir === rootDir && TOOL_MANAGED_AT_TOP.has(entry.name)) continue;
      hash.update(`dir:${rel}\n`);
      walk(rootDir, full, hash);
    } else if (entry.isFile()) {
      hash.update(`file:${rel}\n`);
      hash.update(readFileSync(full));
      hash.update('\n');
    }
    // Entries that are neither a directory nor a plain file (symlinks and the like) do not enter
    // the hash; there are none of those in a records dir.
  }
}
