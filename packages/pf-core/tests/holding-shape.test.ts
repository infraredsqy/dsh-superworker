import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import type { CycleRecord, NodeRecord } from '../src/types';

/**
 * The old on-disk shape of "who the line is holding": a bare id string where the canonical shape is
 * `{ id, since }`.
 *
 * A disc written by an older release still carries it, and every reader of a line's claim has to read
 * both shapes alike. The two places where reading only one shape stops the line are the settlement
 * path (`settle`) and the ticket path (`handoff`): both answer `not_holding` about a node that
 * `cycles.show` and the plan report in hand — `not_holding` is a P0 blocker on the flow's critical
 * path. `doctor` reads the same table to say whether a held node is still on the graph, so a stale
 * claim in the old shape is named there too.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One record in the old shape: the on-disk table an earlier release left, the claim written as bare ids. */
function oldShapeCycle(holding: string[]): CycleRecord {
  return {
    id: 'c1',
    title: 'cycle c1',
    status: 'active',
    holding: holding as unknown as CycleRecord['holding'],
    path: [],
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  };
}

async function stage(holding: string[]): Promise<{ root: string; node: string }> {
  const root = mkdtempSync(join(tmpdir(), 'pf-holding-shape-'));
  roots.push(root);
  const pf = open(root);
  await pf.ledger.init();
  const node = (await pf.ledger.dag.add({ title: 'held in the old shape' })).id;
  const claimed = holding.map((id) => (id === '<the node>' ? node : id));
  writeFileSync(
    join(root, '.pf', 'state.json'),
    `${JSON.stringify({ cycles: [oldShapeCycle(claimed)] }, null, 2)}\n`,
    'utf8',
  );
  return { root, node };
}

/** The ticket a worker files: the six keys of the handoff shape, already on disk. */
function writeTicket(root: string, cycle: string, node: string): void {
  mkdirSync(join(root, '.pf', 'signals', cycle), { recursive: true });
  writeFileSync(
    join(root, '.pf', 'signals', cycle, `${node}.json`),
    `${JSON.stringify(
      {
        cycle,
        node,
        status: 'completed',
        summary: 'the worker delivered',
        outputs: { deliverable: 'the thing' },
        timestamp: '2020-01-01T00:00:03Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('the line holding a node in the old bare-id shape', () => {
  it('handoff accepts the claim and writes the ticket', async () => {
    const { root, node } = await stage(['<the node>']);
    const ticket = await open(root).conductor.handoff({
      cycle: 'c1',
      node,
      status: 'completed',
      summary: 'done',
      outputs: { deliverable: 'the thing' },
    });
    expect(ticket.node).toBe(node);
    const written = JSON.parse(
      readFileSync(join(root, '.pf', 'signals', 'c1', `${node}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(written).toMatchObject({ cycle: 'c1', node, status: 'completed', summary: 'done' });
  });

  it('settle finds the node in hand without being named, and the close lands', async () => {
    const { root, node } = await stage(['<the node>']);
    writeTicket(root, 'c1', node);
    const line = await open(root).conductor.settle({ cycle: 'c1' });
    expect(line.path.map((step) => step.node)).toEqual([node]);
    expect(line.holding).toEqual([]);
    const graph = (await open(root).ledger.dag.get(node)) as NodeRecord;
    expect(graph.status).toBe('completed');
  });

  it('doctor names a held node that is not on the graph, in the old shape too', async () => {
    const { root } = await stage(['deadbeef-not-on-the-graph']);
    const report = await open(root).conductor.doctor();
    const cycles = report.checks.find((check) => check.name === 'cycles')!;
    expect(cycles.ok).toBe(false);
    expect(cycles.detail).toContain('cycle "c1" holds deadbeef-not-on-the-graph');
    expect(cycles.detail).toContain('which is not on the graph');
  });
});
