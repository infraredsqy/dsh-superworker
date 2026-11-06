import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeDir, nodeTempDir, PF_DIR_NAME, type PfPaths, pfPaths } from '../src/paths.ts';
import { cleanTemp } from '../src/tempclean.ts';
import { rejection } from './helpers/rejection.ts';

/**
 * Leftover cleanup: list and delete each node's `temp/` dir (the `clean-temp` rule).
 *
 * One place is swept: the main tree's `nodes/<id>/temp/`. Only that cell is touched; a node a cycle
 * holds (the `holding` in `state.json`) is skipped unless `force`; a list-only run changes not one
 * byte; an unreadable `state.json` makes the whole thing refuse.
 *
 * The area under `.pf/worktrees/` is never entered. A checkout of this project set up there does
 * carry its `.pf` records when the layout is in-repo, and the cell a checkout never carries is a
 * node's `temp/` one — `temp/` is kept out of the repository by the record dir's own `.gitignore`.
 * So a `temp/` cell found under that area was not laid down by a checkout of ours, and the sweep's
 * one place stays the record tree it was handed: no cell under that area is swept — not even one
 * named like the short id of a node this project holds. That rule is what the delete pass hangs on,
 * so it is pinned here.
 */

const NODE_A = 'aaaaaaaa-1111-4444-8888-000000000001';
const NODE_B = 'bbbbbbbb-1111-4444-8888-000000000002';
const NODE_C = 'cccccccc-1111-4444-8888-000000000003';
const WORKTREE = 'aaaaaaaa';
/** The name shape the old sweep accepted: eight hex characters. Spelled out because it is the case to beat. */
const SHORT_ID_NAMED = 'deadbeef';

let root: string;
let paths: PfPaths;

/** One worktree's node cell: `<pf>/worktrees/<name>/.pf/nodes/<id>/temp`. */
function worktreeTempDir(name: string, nodeId: string): string {
  return join(paths.worktreesDir, name, PF_DIR_NAME, 'nodes', nodeId, 'temp');
}

function plant(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** A byte snapshot of the whole tree: paths with forward slashes, values are the file text. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-clean-temp-'));
  paths = pfPaths(root);
  // Main tree: A has a temp (1 file, 10 bytes), B has a temp (2 files, 5 bytes), C has only a spec.
  plant(join(nodeTempDir(paths, NODE_A), 'probe.txt'), 'raw output');
  plant(join(nodeTempDir(paths, NODE_B), 'a.txt'), 'aa');
  plant(join(nodeTempDir(paths, NODE_B), 'sub', 'b.txt'), 'bbb');
  plant(join(nodeDir(paths, NODE_C), 'spec.md'), '# spec\n');
  plant(join(paths.metaDir, 'sessions', `${NODE_A}.json`), '{"v":1}\n');
  // The worktrees area: a directory shaped like a real node's short id that grew the same cell, a
  // hand-made directory whose name is the old rule's accepted shape and carries its own `.pf` tree,
  // a scratch dir, and a `.pf` nested deeper. None of them is a project root of ours.
  plant(join(worktreeTempDir(WORKTREE, NODE_A), 'wt.txt'), 'wt');
  plant(join(worktreeTempDir(SHORT_ID_NAMED, NODE_A), 'manual.txt'), 'manual');
  plant(join(paths.worktreesDir, SHORT_ID_NAMED, PF_DIR_NAME, 'nodes', NODE_A, 'spec.md'), '# spec by hand\n');
  plant(join(paths.worktreesDir, 'scratch', 'temp', 'note.txt'), 'scratch');
  plant(join(paths.worktreesDir, WORKTREE, 'sub', PF_DIR_NAME, 'nodes', NODE_A, 'temp', 'deep.txt'), 'deep');
  // A cycle holds B right now: its temp may be holding raw output a session is still writing.
  plant(
    paths.stateJson,
    JSON.stringify({ cycles: [{ id: 'cyc', holding: [{ id: NODE_B, since: null }] }] }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listing', () => {
  it('only the main tree cells are listed, the cycle-held node skipped, and not one byte changed', async () => {
    const before = snapshot(root);

    const report = await cleanTemp(paths);

    expect(report.targets.map((entry) => entry.name)).toEqual([NODE_A]);
    expect(report.running.map((entry) => entry.name)).toEqual([NODE_B]);
    expect(report.removed).toEqual([]);
    expect(report.targets[0]).toMatchObject({ node: NODE_A, worktree: null, files: 1, bytes: 10 });
    expect(report.running[0]).toMatchObject({ node: NODE_B, files: 2, bytes: 5 });
    // A list-only run deletes nothing: not one byte of the tree changed.
    expect(snapshot(root)).toEqual(before);
  });

  it('a directory in the worktrees area is never read as a project root, even one named like a short id', async () => {
    const handMadeBefore = snapshot(join(paths.worktreesDir, SHORT_ID_NAMED));

    const report = await cleanTemp(paths, { remove: true });

    // Only the main tree's cells are ever listed; no worktree row is produced at all.
    expect(report.targets.map((entry) => entry.worktree)).toEqual([null]);
    expect(report.removed.map((entry) => entry.name)).toEqual([NODE_A]);
    // `deadbeef` carries the exact name shape the old sweep accepted, and its cell is the one that
    // could be deleted: it survives byte for byte.
    expect(snapshot(join(paths.worktreesDir, SHORT_ID_NAMED))).toEqual(handMadeBefore);
    expect(existsSync(worktreeTempDir(SHORT_ID_NAMED, NODE_A))).toBe(true);
    expect(existsSync(join(paths.worktreesDir, 'scratch', 'temp', 'note.txt'))).toBe(true);
  });

  it('nothing left to clean: empty tables come back', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pf-clean-temp-empty-'));
    try {
      const report = await cleanTemp(pfPaths(empty));
      expect(report).toEqual({ targets: [], running: [], removed: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('deleting', () => {
  it('only the temp goes: everything else in the node dir, the holder temp, the worktrees area and the bytes not ours stay', async () => {
    const stateBytes = readFileSync(paths.stateJson, 'utf8');
    const worktreesBefore = snapshot(paths.worktreesDir);

    const report = await cleanTemp(paths, { remove: true });

    expect(report.removed.map((entry) => entry.name)).toEqual([NODE_A]);
    expect(existsSync(nodeTempDir(paths, NODE_A))).toBe(false);
    // Nothing else moves: C's spec, A's session note, the temp of holder B, the bytes of state.json,
    // and the whole worktrees area — not one byte under it changes.
    expect(existsSync(join(nodeDir(paths, NODE_C), 'spec.md'))).toBe(true);
    expect(existsSync(join(paths.metaDir, 'sessions', `${NODE_A}.json`))).toBe(true);
    expect(existsSync(nodeTempDir(paths, NODE_B))).toBe(true);
    expect(snapshot(paths.worktreesDir)).toEqual(worktreesBefore);
    expect(readFileSync(paths.stateJson, 'utf8')).toBe(stateBytes);
  });

  it('force: the cell a cycle holds is cleaned along with the rest', async () => {
    const report = await cleanTemp(paths, { remove: true, force: true });

    expect(report.running).toEqual([]);
    expect(report.removed.map((entry) => entry.name)).toEqual([NODE_A, NODE_B]);
    expect(existsSync(nodeTempDir(paths, NODE_B))).toBe(false);
  });
});

describe('filtering and an unreadable record', () => {
  it('node matches by prefix: only the named one is scanned', async () => {
    const report = await cleanTemp(paths, { node: 'bbbb' });

    expect(report.targets).toEqual([]);
    expect(report.running.map((entry) => entry.node)).toEqual([NODE_B]);
    expect(existsSync(nodeTempDir(paths, NODE_A))).toBe(true);
  });

  it('unreadable state.json: the whole thing refuses and no temp is touched', async () => {
    writeFileSync(paths.stateJson, '{not json', 'utf8');
    const before = snapshot(root);

    const error = await rejection(cleanTemp(paths, { remove: true }));

    expect(error.code).toBe('parse_failure');
    expect(snapshot(root)).toEqual(before);
  });

  // Valid JSON that is not a record: the top-level shape gate of the one reading refuses it, so the
  // sweep never reads a broken document as "no one holds anything" and deletes what a line holds.
  it.each(['[]', '"x"', '123', 'null'])(
    'state.json is valid JSON but not an object (%s): the whole thing refuses, the held temp stays',
    async (body) => {
      writeFileSync(paths.stateJson, body, 'utf8');
      const before = snapshot(root);

      const error = await rejection(cleanTemp(paths, { remove: true }));

      expect(error.code).toBe('parse_failure');
      // The node a line holds was never read as free: its cell is still there, and nothing moved at all.
      expect(existsSync(nodeTempDir(paths, NODE_B))).toBe(true);
      expect(existsSync(nodeTempDir(paths, NODE_A))).toBe(true);
      expect(snapshot(root)).toEqual(before);
    },
  );
});
