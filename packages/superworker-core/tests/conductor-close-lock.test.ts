import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRecordError } from '../src/errors';
import type { AddedNode } from '../src/ledger';
import { makeLab } from './helpers/plugin-lab';

/**
 * The lock boundary of one close: the plugin half — the scan, the dynamic load, every plugin's
 * question — is done before the lock is taken, on one snapshot of the scene; under the lock the line
 * and the ticket are read again, the settle answers to those bytes, and what is left in there is the
 * record write.
 *
 * The four invariants this file locks:
 *
 * - a plugin that takes its time answering does not keep another writer **in this process** waiting:
 *   its question is not asked inside the lock, so the other writer lands while the plugin is parked;
 * - a ticket rewritten in that window — here by the plugin that got its turn first — is the one the
 *   settle answers to: the verdict comes from the bytes read under the lock, not from the ones the
 *   plugin half was handed.
 * - the graph snapshot the plugin judges on is the one taken before the lock: the node this very
 *   close is closing is still `todo` in it, so a plugin whose gate asks `nodesWithTag` counts the
 *   closing node itself and stays shut;
 * - the ticket is read a third time under the lock, and a plugin that takes the cell's ticket away
 *   (or leaves it stating `pending`) in the window is refused with `nothing_to_settle`, before the
 *   record snapshot and before any write.
 *
 * The implementation of these plugins is written by the test itself (the lab writer lays the
 * declaration beside it), and every tree a test touches is a temporary project root.
 */

/** The ticket of one cell: `<record>/signals/<line>/<node>.json`. */
function ticketPathOf(root: string, cycle: string, node: string): string {
  return join(root, '.superworker', 'signals', cycle, `${node}.json`);
}

/**
 * Wait for one file to appear: a plugin's question has no callback to hang on, and its first act is
 * that write, so this is a bounded readiness probe (a look every 10 ms, 5 s at most).
 */
async function waitForFile(path: string, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Stage one line with one node in hand and a completed ticket on disk. */
async function stageTicketedLine(prefix: string): Promise<{ lab: ReturnType<typeof makeLab>; node: string }> {
  const lab = makeLab(prefix);
  await lab.superworker.ledger.init();
  const node = (await lab.superworker.ledger.dag.add({ title: 'held node' })).id;
  lab.cycle('c1', [node]);
  await lab.superworker.conductor.handoff({ cycle: 'c1', node, status: 'completed', summary: 'done', outputs: {} });
  return { lab, node };
}

describe('the lock boundary of a close: the plugin half is asked outside the lock', () => {
  it('a plugin that answers late does not keep another writer in this process waiting', async () => {
    const { lab, node } = await stageTicketedLine('superworker-close-lock-');
    try {
      const entered = join(lab.root, 'plugin-entered');
      const released = join(lab.root, 'plugin-released');
      // A close plugin that parks in its question: it says so by writing one file, then it only leaves
      // when this test writes the other one (a bounded wait, so a test that never releases it ends).
      lab.plugin('patient', {
        name: 'patient',
        summary: 'a close plugin that answers late',
        timing: 'close',
        action: 'insert',
      }, {
        'impl.mjs': [
          "import { existsSync, writeFileSync } from 'node:fs';",
          `const ENTERED = ${JSON.stringify(entered)};`,
          `const RELEASED = ${JSON.stringify(released)};`,
          'const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
          'export async function offer() {',
          "  writeFileSync(ENTERED, 'asked');",
          '  const deadline = Date.now() + 10000;',
          '  while (!existsSync(RELEASED) && Date.now() < deadline) await wait(5);',
          '  return null;',
          '}',
        ].join('\n'),
      });

      const closing = lab.superworker.conductor.close({ cycle: 'c1', node });
      await waitForFile(entered, "the plugin's question to be asked");
      // The plugin is parked in its question here. A second writer in the same process lands while that
      // question is still outstanding: it is the lock the writer has to wait on, and the question is
      // not asked under it. The bound is a failure sentinel, not a poll: the expected answer is a
      // resolved promise, so the race is decided by that promise settling, never by the clock.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<'blocked'>((resolveGuard) => {
        timer = setTimeout(() => resolveGuard('blocked'), 1000);
      });
      let landed: AddedNode | 'blocked';
      try {
        landed = await Promise.race([
          lab.superworker.ledger.dag.add({ title: 'written while the plugin was asked' }),
          guard,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Release the plugin and let the close come to its end before the tree is taken away.
        writeFileSync(released, '');
        await closing.catch(() => undefined);
      }
      expect(landed).not.toBe('blocked');
      expect((landed as AddedNode).title).toBe('written while the plugin was asked');
      await closing;
    } finally {
      lab.cleanup();
    }
  }, 15000);

  it('a ticket rewritten before the lock is taken: the settle answers to the bytes read under the lock', async () => {
    const { lab, node } = await stageTicketedLine('superworker-close-settle-');
    try {
      // The plugin is asked in the window before the lock: it rewrites this cell's ticket there and
      // offers nothing, so the one thing the whole call is about is which ticket the settle reads.
      lab.plugin('rewriter', {
        name: 'rewriter',
        summary: 'a close plugin that rewrites the ticket before the lock is taken',
        timing: 'close',
        action: 'insert',
      }, {
        'impl.mjs': [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'export function offer(ctx) {',
          "  const ticket = join(ctx.root, '.superworker', 'signals', String(ctx.cycle.id), ctx.nodeId + '.json');",
          "  const record = JSON.parse(readFileSync(ticket, 'utf8'));",
          "  const changed = { ...record, status: 'failed', summary: 'the worker changed its answer' };",
          "  writeFileSync(ticket, JSON.stringify(changed, null, 2) + '\\n', 'utf8');",
          '  return null;',
          '}',
        ].join('\n'),
      });

      const settled = await lab.superworker.conductor.close({ cycle: 'c1', node });
      // The ticket said `failed` by the time the lock was taken, and that is the verdict that landed:
      // the pre-lock reading (the one the plugin half was handed) said `completed`.
      expect(JSON.parse(readFileSync(ticketPathOf(lab.root, 'c1', node), 'utf8')))
        .toMatchObject({ status: 'failed' });
      expect(settled.path[0]).toMatchObject({ node, result: 'failed' });
      expect(settled.status).toBe('inactive');
      expect((await lab.superworker.ledger.dag.get(node))!.status).toBe('shelved');
    } finally {
      lab.cleanup();
    }
  });

  it('the scene a close plugin judges on is the one read before the lock: the node being closed is still `todo` in it', async () => {
    const lab = makeLab('superworker-close-snapshot-');
    try {
      await lab.superworker.ledger.init();
      const node = (await lab.superworker.ledger.dag.add({ title: 'watched node', tags: ['watched'] })).id;
      lab.cycle('c1', [node]);
      await lab.superworker.conductor.handoff({ cycle: 'c1', node, status: 'completed', summary: 'done', outputs: {} });

      const reading = join(lab.root, 'plugin-reading.json');
      // A gate of the same shape as the issue pool's close plugin (one tagged metric, one live node):
      // it writes down what it saw of the graph, and it offers its insert only while no node carrying
      // the tag is still open.
      lab.plugin('watcher', {
        name: 'watcher',
        summary: 'a close plugin whose gate counts the tagged nodes it sees',
        timing: 'close',
        action: 'insert',
      }, {
        'impl.mjs': [
          "import { writeFileSync } from 'node:fs';",
          `const READING = ${JSON.stringify(reading)};`,
          'export function offer(ctx) {',
          "  const ids = ctx.nodesWithTag('watched');",
          '  const closed = String(ctx.nodeId);',
          '  const seen = ctx.dag.nodes[closed];',
          '  writeFileSync(READING, JSON.stringify({',
          '    count: ids.length,',
          '    closedNodeIdIsInIt: ids.includes(closed),',
          '    closedStatusInSnapshot: seen ? seen.status : null,',
          '  }), "utf8");',
          '  if (ids.length > 0) return null;',
          '  return {',
          "    title: 'inserted by the liveness gate',",
          "    tags: ['watched'],",
          '    spec_of: () => "# inserted by the liveness gate\\n",',
          "    why: 'no tagged node was open',",
          "    note: 'inserted by the liveness gate',",
          '  };',
          '}',
        ].join('\n'),
      });

      const settled = await lab.superworker.conductor.close({ cycle: 'c1', node });
      // The snapshot is the scene read before the lock, so the closing node has not taken its
      // `completed` yet: the gate counts that very node and finds the tag occupied.
      expect(JSON.parse(readFileSync(reading, 'utf8'))).toEqual({
        count: 1,
        closedNodeIdIsInIt: true,
        closedStatusInSnapshot: 'todo',
      });
      // The gate stayed shut: nothing was inserted...
      const titles = ((await lab.superworker.ledger.dag.list()) as unknown as Array<{ title: string }>)
        .map((row) => row.title);
      expect(titles).not.toContain('inserted by the liveness gate');
      // ...while the settle itself went through as usual.
      expect(settled.path[0]).toMatchObject({ node, result: 'completed' });
      expect(settled.status).toBe('inactive');
      expect((await lab.superworker.ledger.dag.get(node))!.status).toBe('completed');
    } finally {
      lab.cleanup();
    }
  });

  it('the ticket taken away in the plugin window: close refuses with nothing_to_settle and not one record byte moves', async () => {
    for (const spelling of ['deleted', 'pending']) {
      const lab = makeLab(`superworker-close-vanish-${spelling}-`);
      try {
        await lab.superworker.ledger.init();
        const node = (await lab.superworker.ledger.dag.add({ title: 'held node' })).id;
        lab.cycle('c1', [node]);
        await lab.superworker.conductor.handoff({ cycle: 'c1', node, status: 'completed', summary: 'done', outputs: {} });

        // The plugin is asked in the window before the lock, and it takes this cell's ticket out from
        // under the settle there: it either deletes the file, or rewrites it into the `pending` mark.
        const body = spelling === 'deleted' ? [
          "import { rmSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'export function offer(ctx) {',
          "  rmSync(join(ctx.root, '.superworker', 'signals', String(ctx.cycle.id), ctx.nodeId + '.json'));",
          '  return null;',
          '}',
        ] : [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'export function offer(ctx) {',
          "  const cell = join(ctx.root, '.superworker', 'signals', String(ctx.cycle.id), ctx.nodeId + '.json');",
          "  const record = JSON.parse(readFileSync(cell, 'utf8'));",
          "  writeFileSync(cell, JSON.stringify({ ...record, status: 'pending' }, null, 2) + '\\n', 'utf8');",
          '  return null;',
          '}',
        ];
        lab.plugin('vanisher', {
          name: 'vanisher',
          summary: 'a close plugin that takes the cell ticket away before the lock is taken',
          timing: 'close',
          action: 'insert',
        }, { 'impl.mjs': body.join('\n') });

        const statePath = join(lab.root, '.superworker', 'state.json');
        const ideasPath = join(lab.root, '.superworker', 'ideas.json');
        const stateBefore = readFileSync(statePath);
        const ideasBefore = readFileSync(ideasPath);

        let caught: unknown;
        try {
          await lab.superworker.conductor.close({ cycle: 'c1', node });
        } catch (error) {
          caught = error;
        }
        // The re-read under the lock finds no verdict to settle and refuses on the spot — before the
        // record snapshot is taken, so no byte of the records moves.
        expect(isRecordError(caught, 'nothing_to_settle')).toBe(true);
        expect(readFileSync(statePath)).toEqual(stateBefore);
        expect(readFileSync(ideasPath)).toEqual(ideasBefore);
        // And nothing settled either: the node is still open and still on the line's claim list.
        expect((await lab.superworker.ledger.dag.get(node))!.status).toBe('todo');
        const line = await lab.superworker.ledger.cycles.show('c1');
        expect(line.status).toBe('active');
        expect(line.holding.map((item) => item.id)).toEqual([node]);
      } finally {
        lab.cleanup();
      }
    }
  });
});