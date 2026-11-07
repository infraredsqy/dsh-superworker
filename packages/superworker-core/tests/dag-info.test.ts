import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { recordPaths, sessionNotePath } from '../src/paths';

/**
 * The node detail (`ledger.dag.info`): what only the graph can answer about one node, next to the
 * record `get` already hands back. Only invariants are pinned — the field vocabulary and its fixed
 * order, the two edge directions, readiness, and the two readings being the same ones `list`
 * computes (never a second algorithm). The exact score of a graph is not a promise this file makes.
 */

let root: string;
let superworker: ReturnType<typeof open>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-dag-info-'));
  superworker = open(root);
  return superworker.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  superworker = undefined!;
});

/** The detail's key order with nothing optional in play. */
const BASE_KEYS = [
  'id', 'title', 'status', 'mode', 'description', 'depends_on', 'depended_by',
  'ready', 'urgency_level', 'importance_score',
];

/** A small graph: b is completed and approved, a waits on b, c waits on a, d is shelved on its own. */
async function plantGraph(): Promise<Record<'a' | 'b' | 'c' | 'd', string>> {
  const b = (await superworker.ledger.dag.add({ title: 'B' })).id;
  await superworker.ledger.dag.setStatus(b, 'completed');
  await superworker.ledger.dag.approve(b, '2021-01-01T00:00:00.000000Z');
  const a = (await superworker.ledger.dag.add({ title: 'A', description: 'the note on A', depends_on: [b] })).id;
  const c = (await superworker.ledger.dag.add({ title: 'C', depends_on: [a] })).id;
  const d = (await superworker.ledger.dag.add({ title: 'D' })).id;
  await superworker.ledger.dag.setStatus(d, 'shelved');
  return { a, b, c, d };
}

describe('the detail: the record plus both edge directions', () => {
  it('the default field set and its order are fixed; a standard node carries no weight key and no timestamps', async () => {
    const { a } = await plantGraph();
    const info = await superworker.ledger.dag.info(a);
    expect(Object.keys(info)).toEqual(BASE_KEYS);
    expect(info).toMatchObject({ id: a, title: 'A', status: 'todo', mode: 'auto', description: 'the note on A' });
  });

  it('both directions come back in their own orders: dependencies as the record has them, dependents as the table has them', async () => {
    const { a, b, c } = await plantGraph();
    const info = await superworker.ledger.dag.info(a);
    expect(info.depends_on).toEqual([{ id: b, title: 'B' }]);
    expect(info.depended_by).toEqual([{ id: c, title: 'C' }]);
  });

  it('a dependency the graph no longer holds reads `(unknown)`, and it still counts as delivered for ready', async () => {
    const a = (await superworker.ledger.dag.add({ title: 'no dependencies' })).id;
    // Write the dangling edge straight into the record: the read side of the graph tolerates it.
    const file = join(root, '.superworker', 'ideas.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      nodes: Record<string, { dependencies: string[] }>;
    };
    data.nodes[a]!.dependencies = ['11111111-1111-4111-8111-111111111111'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const info = await superworker.ledger.dag.info(a);
    expect(info.depends_on).toEqual([{ id: '11111111-1111-4111-8111-111111111111', title: '(unknown)' }]);
    expect(info.ready).toBe(true);
    const verbose = await superworker.ledger.dag.info(a, { verbose: true });
    expect(verbose.depends_on[0]!.status).toBe('(unknown)');
  });

  it('weight lands only for light; readiness is the same word list gives', async () => {
    const light = (await superworker.ledger.dag.add({ title: 'the light one', weight: 'light' })).id;
    const info = await superworker.ledger.dag.info(light);
    expect(info.weight).toBe('light');
    const standard = (await superworker.ledger.dag.add({ title: 'the standard one' })).id;
    expect('weight' in (await superworker.ledger.dag.info(standard))).toBe(false);
    const rows = await superworker.ledger.dag.list();
    for (const row of rows) {
      expect((await superworker.ledger.dag.info(row.id)).ready).toBe(row.ready);
    }
  });

  it('the two readings are the ones list computes on the unfinished graph; a shelved node is not ranked', async () => {
    const { a, b, d } = await plantGraph();
    const rows = await superworker.ledger.dag.list();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const infoA = await superworker.ledger.dag.info(a);
    expect(infoA.urgency_level).toBe(byId.get(a)!.urgency_level);
    expect(infoA.importance_score).toBe(byId.get(a)!.importance_score);
    // The completed dependency reads as it does in list (0 there too): the ordering is computed on the
    // unfinished part of the graph, and a delivered node sinks.
    const infoB = await superworker.ledger.dag.info(b);
    expect(infoB.urgency_level).toBe(0);
    expect(infoB.importance_score).toBe(0);
    // A shelved node is out of play: both readings are 0 even though it sits on the graph.
    const infoD = await superworker.ledger.dag.info(d);
    expect(infoD.urgency_level).toBe(0);
    expect(infoD.importance_score).toBe(0);
  });

  it('verbose adds the two timestamps and the status of every edge end; the default view carries neither', async () => {
    const { a, b, c } = await plantGraph();
    const plain = await superworker.ledger.dag.info(a);
    expect('created_at' in plain).toBe(false);
    expect('updated_at' in plain).toBe(false);
    expect('status' in plain.depends_on[0]!).toBe(false);
    const verbose = await superworker.ledger.dag.info(a, { verbose: true });
    expect(Object.keys(verbose)).toEqual([...BASE_KEYS, 'created_at', 'updated_at']);
    expect(verbose.created_at).toBe((await superworker.ledger.dag.get(a))!.created_at);
    expect(verbose.updated_at).toBe((await superworker.ledger.dag.get(a))!.updated_at);
    expect(verbose.depends_on).toEqual([{ id: b, title: 'B', status: 'completed' }]);
    expect(verbose.depended_by).toEqual([{ id: c, title: 'C', status: 'todo' }]);
  });

  it('the completion and approval moments land only when they were written', async () => {
    const { a, b } = await plantGraph();
    const info = await superworker.ledger.dag.info(b);
    expect(info.status).toBe('completed');
    expect(info.completed_at).toBe((await superworker.ledger.dag.get(b))!.completed_at);
    expect(info.approved_at).toBe('2021-01-01T00:00:00.000000Z');
    expect('completed_at' in (await superworker.ledger.dag.info(a))).toBe(false);
    expect('approved_at' in (await superworker.ledger.dag.info(a))).toBe(false);
  });

  it('the session key is present only when the note has something in it, and it carries both lists', async () => {
    const { a } = await plantGraph();
    expect('sessions' in (await superworker.ledger.dag.info(a))).toBe(false);
    mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
    writeFileSync(sessionNotePath(recordPaths(root), a), JSON.stringify({
      v: 1,
      discussion: [{ session: 'session-d1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'sess_r1', host: 'dsh', at: null }],
    }, null, 2));
    const info = await superworker.ledger.dag.info(a);
    expect(info.sessions).toEqual({
      discussion: [{ session: 'session-d1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'sess_r1', host: 'dsh', at: null }],
    });
  });

  it('a record that says nothing reads the read side own defaults: status todo, and empty timestamps under verbose', async () => {
    const { a } = await plantGraph();
    // A record the writer never laid down: no status, no stamps. The detail is a read face for
    // records it did not write, so the three cells keep their shape instead of disappearing.
    const file = join(root, '.superworker', 'ideas.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    const node = data.nodes[a]!;
    delete node.status;
    delete node.created_at;
    delete node.updated_at;
    writeFileSync(file, JSON.stringify(data, null, 2));
    const info = await superworker.ledger.dag.info(a);
    expect(info.status).toBe('todo');
    const verbose = await superworker.ledger.dag.info(a, { verbose: true });
    expect(verbose.created_at).toBe('');
    expect(verbose.updated_at).toBe('');
  });

  it('the id accepts the full form and a unique prefix; a node that is not there stops the call', async () => {
    const { a } = await plantGraph();
    expect((await superworker.ledger.dag.info(a.slice(0, 6))).id).toBe(a);
    await expect(superworker.ledger.dag.info('ffffffff')).rejects.toThrow(/not found/);
  });
});
