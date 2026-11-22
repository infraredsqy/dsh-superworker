import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeLab } from './helpers/plugin-lab';

/**
 * The rollback branch of one settle: the transaction snapshots `state.json` and `ideas.json` before
 * the records move, but the closing insertion seam's `dag.add` also sets the new node's **directory**
 * (`nodes/<uuid>/`, spec.md included) up inside the transaction and may hang a session note beside it
 * (`meta/sessions/<uuid>.json`) — files no snapshot carries. A failure after an insertion landed must
 * put the records back *and* take those files with it, so no orphan directory or session note is left
 * naming a node no record holds.
 *
 * The mid-way failure is forced with a module double on the cycles namespace: the transaction's last
 * step (`cycles.show`) is made to throw once, after the insertion has landed. Everything else goes
 * through the real implementation.
 */

const settleProbe = vi.hoisted(() => ({ failNextShow: false }));

vi.mock('../src/cycles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cycles')>();
  return {
    ...actual,
    createCyclesNamespace: (root: string) => {
      const real = actual.createCyclesNamespace(root);
      return {
        ...real,
        show: async (id: string) => {
          if (settleProbe.failNextShow) {
            settleProbe.failNextShow = false;
            throw new Error('show failed on purpose (rollback test double)');
          }
          return real.show(id);
        },
      };
    },
  };
});

/** The node directories on disk (`nodes/<id>/`, names only). */
function nodeDirs(root: string): string[] {
  const dir = join(root, '.superworker', 'nodes');
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
}

/** The session notes on disk (`meta/sessions/<id>.json`, names only). */
function sessionNotes(root: string): string[] {
  const dir = join(root, '.superworker', 'meta', 'sessions');
  return existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
}

let roots: string[] = [];

afterEach(() => {
  settleProbe.failNextShow = false;
  delete process.env.DSH_SESSION_ID;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a settle's rollback: the insertion seam's directories and session notes go with it", () => {
  it('a failure after an insertion landed: the records roll back and no orphan node directory or session note is left', async () => {
    const root = mkdtempSync(join(tmpdir(), 'superworker-settle-rollback-'));
    roots.push(root);
    const lab = makeLab('superworker-settle-rollback-lab-');
    // dag.add notes the session a node was born in only when the process names one: name it, so the
    // rollback has a session note to take away too.
    process.env.DSH_SESSION_ID = 'sess-rollback-check';
    try {
      await lab.superworker.ledger.init();
      const node = (await lab.superworker.ledger.dag.add({ title: 'held node' })).id;
      lab.cycle('c1', [node]);
      await lab.superworker.conductor.handoff({ cycle: 'c1', node, status: 'completed', summary: 'done', outputs: {} });

      // A close-time plugin that inserts one node: its dag.add lands a directory (spec.md included)
      // and a session note inside the transaction, before the step below fails.
      lab.plugin('inserter', {
        name: 'inserter',
        summary: 'a close plugin that inserts a node at the close',
        timing: 'close',
        action: 'insert',
      }, {
        'impl.mjs': [
          'export function offer() {',
          '  return {',
          "    title: 'inserted at the close',",
          "    tags: ['inserted'],",
          "    spec_of: () => '# inserted at the close\\n',",
          "    why: 'the close asked for it',",
          "    note: 'inserted at the close',",
          '  };',
          '}',
        ].join('\n'),
      });

      const dirsBefore = nodeDirs(lab.root).sort();
      const notesBefore = sessionNotes(lab.root).sort();

      settleProbe.failNextShow = true;
      let caught: unknown;
      try {
        await lab.superworker.conductor.settle({ cycle: 'c1', node });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toContain('show failed on purpose');

      // The records rolled back: the line still holds the node, the verdict did not land, the graph
      // still counts one node — the inserted one is gone from the record.
      const line = await lab.superworker.ledger.cycles.show('c1');
      expect(line.status).toBe('active');
      expect(line.holding.map((item) => item.id)).toEqual([node]);
      expect(line.path ?? []).toEqual([]);
      expect((await lab.superworker.ledger.dag.get(node))?.status).toBe('todo');
      expect((await lab.superworker.ledger.dag.list()).map((row) => row.title)).toEqual(['held node']);

      // And the disk carries no orphan: the same node directories and session notes as before the
      // settle, the insertion's own taken away with the rollback.
      expect(nodeDirs(lab.root).sort()).toEqual(dirsBefore);
      expect(sessionNotes(lab.root).sort()).toEqual(notesBefore);
    } finally {
      lab.cleanup();
    }
  });
});
