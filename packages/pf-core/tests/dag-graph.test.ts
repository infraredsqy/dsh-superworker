import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { jsonOptionsForRecord } from '../src/jsonio';
import { nodeReady } from '../src/graph';

/**
 * Graph invariants: whole-graph validation (cycles / dangling / duplicate edges), the upstream
 * and downstream closure, the ordering rule (urgency times importance, completed sinks to the
 * bottom), readiness and filtering, and search. Cycles, dangling references and duplicate edges
 * are bad states the API cannot produce (link rejects on the spot, remove tears edges apart, a
 * duplicate edge is a no-op); those cases guard against records a hand merge wrote wrong, so they
 * plant ideas.json straight into a temp project in the on-disk format and then validate.
 */

let root: string;
let pf: ReturnType<typeof open>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-dag-graph-'));
  pf = open(root);
  return pf.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  pf = undefined!;
});

/** Plant the node table straight into ideas.json in the on-disk format (depth-sorted keys, platform line ending, no trailing newline). */
async function plantNodes(nodes: Record<string, unknown>): Promise<void> {
  const path = join(root, '.pf', 'ideas.json');
  const { atomicWriteJson } = await import('../src/jsonio');
  await atomicWriteJson(path, { nodes }, jsonOptionsForRecord('ideas'));
}

describe('validate: the whole-graph check', () => {
  it('a clean graph is ok, with every status counted', async () => {
    const a = await pf.ledger.dag.add({ title: '甲' });
    const b = await pf.ledger.dag.add({ title: '乙' });
    await pf.ledger.dag.setStatus(b.id, 'completed');
    await pf.ledger.dag.setStatus(a.id, 'shelved');
    const report = await pf.ledger.dag.validate();
    expect(report).toMatchObject({ ok: true, total: 2, status_counts: { shelved: 1, completed: 1 }, problems: [] });
    // A node no edge ever touched is isolated: it comes back named in on-disk order (isolation is named only, ok never turns red).
    expect(report.isolated).toEqual([a.id, b.id].sort());
  });

  it('a cycle reports FAIL, ok turns false, and the path starts and ends on the same node', async () => {
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const b = 'bbbbbbbb-2222-4222-8222-222222222222';
    await plantNodes({
      [a]: nodeOf('甲', [b]),
      [b]: nodeOf('乙', [a]),
    });
    const report = await pf.ledger.dag.validate();
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('check=no_cycles');
    expect(report.problems[0]).toContain('cycle detected');
    // The path spells out the ring: whom it starts from and to whom it returns.
    expect(report.problems[0]).toMatch(/cycle detected: .+ → .+ → .+/);
  });

  it('each dangling reference reports FAIL, naming both sides', async () => {
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const ghost = 'cccccccc-3333-4333-8333-333333333333';
    await plantNodes({ [a]: nodeOf('甲', [ghost]) });
    const report = await pf.ledger.dag.validate();
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      `FAIL  check=no_dangling  node=${a}  references=${ghost}`,
    ]);
  });

  it('a duplicate edge reports FAIL: a record a hand merge wrote wrong does not slip through', async () => {
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const b = 'bbbbbbbb-2222-4222-8222-222222222222';
    await plantNodes({
      [a]: nodeOf('甲', []),
      [b]: { ...nodeOf('乙', [a, a]) },
    });
    const report = await pf.ledger.dag.validate();
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      `FAIL  check=no_duplicate_edges  node=${b}  references=${a}`,
    ]);
  });

  it('isolation is found: a node with neither dependencies nor dependents comes back named, and ok stays green', async () => {
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const b = 'bbbbbbbb-2222-4222-8222-222222222222';
    const iso = 'dddddddd-4444-4444-8444-444444444444';
    await plantNodes({
      [a]: nodeOf('甲', [b]),
      [b]: nodeOf('乙', []),
      [iso]: nodeOf('孤岛', []),
    });
    const report = await pf.ledger.dag.validate();
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    // Only the island counts as isolated: b has no dependencies, but it does have a dependent (a points an edge at it).
    expect(report.isolated).toEqual([iso]);
  });

  it('a cycle and a dangling reference are reported together', async () => {
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const b = 'bbbbbbbb-2222-4222-8222-222222222222';
    const ghost = 'cccccccc-3333-4333-8333-333333333333';
    await plantNodes({
      [a]: nodeOf('甲', [b, ghost]),
      [b]: nodeOf('乙', [a]),
    });
    const report = await pf.ledger.dag.validate();
    expect(report.problems).toHaveLength(2);
    expect(report.problems.some((line) => line.includes('no_cycles'))).toBe(true);
    expect(report.problems.some((line) => line.includes('no_dangling'))).toBe(true);
  });
});

describe('context: the transitive upstream and downstream closure', () => {
  it('a chain and a diamond: depth starts at 1 and each side follows its own edges', async () => {
    const a = await pf.ledger.dag.add({ title: '地基' });
    const b = await pf.ledger.dag.add({ title: '中层', depends_on: [a.id] });
    const c = await pf.ledger.dag.add({ title: '顶层', depends_on: [b.id] });
    const d = await pf.ledger.dag.add({ title: '旁支', depends_on: [a.id] });

    const up = await pf.ledger.dag.context(c.id);
    expect(up.upstream).toEqual([
      { id: b.id, title: '中层', status: 'todo', depth: 1 },
      { id: a.id, title: '地基', status: 'todo', depth: 2 },
    ]);
    expect(up.downstream).toEqual([]);

    const mid = await pf.ledger.dag.context(b.id);
    expect(mid.upstream).toEqual([{ id: a.id, title: '地基', status: 'todo', depth: 1 }]);
    expect(mid.downstream).toEqual([{ id: c.id, title: '顶层', status: 'todo', depth: 1 }]);

    // Downstream de-queues breadth first: the first layer of dependents follows the on-disk order
    // of the reverse adjacency (sorted node id), the second layer is appended as it is found; depth
    // follows the edge.
    const base = await pf.ledger.dag.context(a.id);
    expect(base.upstream).toEqual([]);
    expect(base.downstream.map((entry) => entry.id)).toEqual([...[b.id, d.id].sort(), c.id]);
    expect(base.downstream.find((entry) => entry.id === b.id)).toEqual(
      { id: b.id, title: '中层', status: 'todo', depth: 1 },
    );
    expect(base.downstream.find((entry) => entry.id === c.id)).toEqual(
      { id: c.id, title: '顶层', status: 'todo', depth: 2 },
    );
    expect(base.downstream.find((entry) => entry.id === d.id)).toEqual(
      { id: d.id, title: '旁支', status: 'todo', depth: 1 },
    );
  });

  it('a dangling reference is listed as (unknown) and the closure does not blow up', async () => {
    const a = await pf.ledger.dag.add({ title: '挂着悬边的' });
    const ghost = 'cccccccc-3333-4333-8333-333333333333';
    const data = JSON.parse(readFileSync(join(root, '.pf', 'ideas.json'), 'utf8')) as {
      nodes: Record<string, unknown>;
    };
    (data.nodes[a.id] as { dependencies: string[] }).dependencies.push(ghost);
    const { atomicWriteJson } = await import('../src/jsonio');
    await atomicWriteJson(join(root, '.pf', 'ideas.json'), data, jsonOptionsForRecord('ideas'));

    const context = await pf.ledger.dag.context(a.id);
    expect(context.upstream).toEqual([
      { id: ghost, title: '(unknown)', status: '(unknown)', depth: 1 },
    ]);
  });
});

describe('list: the ordering rule and filtering', () => {
  it('importance times urgency: completed and shelved sink, and readiness and scores go only to nodes that can run', async () => {
    const a = await pf.ledger.dag.add({ title: '地基' });
    const b = await pf.ledger.dag.add({ title: '中层', depends_on: [a.id] });
    const c = await pf.ledger.dag.add({ title: '顶层', depends_on: [a.id, b.id] });

    const rows = await pf.ledger.dag.list();
    // More dependents means more important: the base (2) > the middle (1) > the top (0); scores exist only on runnable nodes.
    expect(rows.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
    expect(rows.map((row) => row.importance_score)).toEqual([2, 1, 0]);
    // Urgency: the less unfinished dependencies block a node the more urgent it is — whoever holds the fewest transitive dependencies scores highest, and the most scores zero.
    expect(rows.map((row) => row.urgency_level)).toEqual([2, 1, 0]);

    // Complete the base: it sinks (no score), and the middle becomes ready (todo with every dependency delivered).
    await pf.ledger.dag.setStatus(a.id, 'completed');
    const after = await pf.ledger.dag.list();
    // Rows are taken by id rather than pinned to a position: the completed base and the todo top
    // both tie at (0,0) and the tie breaks on on-disk node order (uuid order), so the slot follows
    // the uuid — score and readiness readings only concern the node itself.
    const rowOf = (rows: Awaited<ReturnType<typeof pf.ledger.dag.list>>, id: string) =>
      rows.find((row) => row.id === id)!;
    expect(after[0]!.id).toBe(b.id); // The middle holds the only score (importance 1) and stays first.
    expect(rowOf(after, a.id).importance_score).toBeUndefined();
    expect(rowOf(after, a.id).urgency_level).toBeUndefined();
    expect(rowOf(after, c.id).importance_score).toBe(0);
    expect(rowOf(after, c.id).urgency_level).toBe(0);
    expect(rowOf(after, b.id).ready).toBe(true);
    expect(rowOf(after, a.id).ready).toBe(false);
    expect(rowOf(after, c.id).ready).toBe(false);

    // Shelve the middle: it sinks the same way.
    await pf.ledger.dag.setStatus(b.id, 'shelved');
    const shelved = await pf.ledger.dag.list();
    // The shelved node holds the normalised top urgency yet emits no score, and the top is runnable
    // but also reads (0,0) — a three-way tie, resolved by on-disk node order.
    expect(shelved.map((row) => row.id)).toEqual([...[a.id, b.id, c.id].sort()]);
    expect(shelved.find((row) => row.id === b.id)!.urgency_level).toBeUndefined();
    expect(shelved.find((row) => row.id === c.id)!.urgency_level).toBe(0);
    expect(shelved.every((row) => row.ready === false)).toBe(true);
  });

  it('ready, status, tags and limit each filter on their own; a tagged node is invisible to an outside scope', async () => {
    const a = await pf.ledger.dag.add({ title: '编码活', tags: ['coding'] });
    const b = await pf.ledger.dag.add({ title: '写作活', tags: ['writing'] });
    const c = await pf.ledger.dag.add({ title: '无标签活' });
    await pf.ledger.dag.setStatus(c.id, 'completed');

    const ready = await pf.ledger.dag.list({ ready: true });
    expect(ready.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());

    expect((await pf.ledger.dag.list({ status: ['todo'] })).map((row) => row.id).sort())
      .toEqual([a.id, b.id].sort());
    expect((await pf.ledger.dag.list({ status: ['completed'] })).map((row) => row.id))
      .toEqual([c.id]);

    // The writing scope sees only the writing task and the untagged one; an untagged node is visible everywhere.
    const writing = await pf.ledger.dag.list({ tags: ['writing'] });
    expect(writing.map((row) => row.id).sort()).toEqual([b.id, c.id].sort());
    const coding = await pf.ledger.dag.list({ tags: ['coding'] });
    expect(coding.map((row) => row.id).sort()).toEqual([a.id, c.id].sort());

    const limited = await pf.ledger.dag.list({ limit: 1 });
    expect(limited).toHaveLength(1);
    // No limit (0 by default) gives everything.
    expect(await pf.ledger.dag.list()).toHaveLength(3);
  });

  it('a tag spelled with blanks meets the same word, and a tag of blanks only is no tag', async () => {
    // The on-disk shapes a hand merge leaves: a tag written with a leading blank, and one that is only
    // blanks. The read side trims both, so the first meets the word `coding` and the second reads as a
    // node without tags (visible in every picking range). A line's own range has to answer the same.
    const padded = 'aaaaaaaa-1111-4111-8111-111111111111';
    const blanks = 'bbbbbbbb-2222-4222-8222-222222222222';
    const other = 'cccccccc-3333-4333-8333-333333333333';
    await plantNodes({
      [padded]: { ...nodeOf('标签带空白', []), tags: [' coding'] },
      [blanks]: { ...nodeOf('只有空白的标签', []), tags: ['  '] },
      [other]: { ...nodeOf('别的范围', []), tags: ['writing'] },
    });

    const coding = await pf.ledger.dag.list({ tags: ['coding'] });
    expect(coding.map((row) => row.id).sort()).toEqual([padded, blanks].sort());
    // The padded word is printed normalised, and the blank-only tag is not a tag at all.
    expect(coding.find((row) => row.id === padded)!.tags).toEqual(['coding']);
    expect(coding.find((row) => row.id === blanks)!.tags).toBeUndefined();

    // The same two words decide what a line pins: the padded tag is inside the range, the blank-only
    // tag is no tag (visible everywhere), and the writing one is kept out.
    const line = await pf.ledger.cycles.start({ id: 'c1', tags: ['coding'], parallel: 2 });
    expect(line.holding.map((held) => held.id).sort()).toEqual([padded, blanks].sort());
  });

  it('importance runs before urgency: more dependents outranks more urgent', async () => {
    // Five nodes whose two readings disagree. base holds the most dependents (importance 3) and the top
    // urgency (2); middle holds two dependents (importance 2) but sits one level in (urgency 1); the
    // isolated head holds no dependents (importance 0) yet is as urgent as base (2); the two leaves are
    // the least urgent (0) and have nothing depending on them.
    const base = 'aaaaaaaa-1111-4111-8111-111111111111';
    const middle = 'bbbbbbbb-2222-4222-8222-222222222222';
    const leafA = 'cccccccc-3333-4333-8333-333333333333';
    const leafB = 'dddddddd-4444-4444-8444-444444444444';
    const alone = 'eeeeeeee-5555-4555-8555-555555555555';
    await plantNodes({
      [base]: nodeOf('地基', []),
      [middle]: nodeOf('中层', [base]),
      [leafA]: nodeOf('顶层甲', [middle]),
      [leafB]: nodeOf('顶层乙', [middle]),
      [alone]: nodeOf('孤岛', []),
    });

    const rows = await pf.ledger.dag.list();
    expect(rows.map((row) => row.id)).toEqual([base, middle, alone, leafA, leafB]);
    expect(rows.map((row) => row.importance_score)).toEqual([3, 2, 0, 0, 0]);
    expect(rows.map((row) => row.urgency_level)).toEqual([2, 1, 2, 0, 0]);
    // The discriminating pair is middle vs alone: importance says middle first, urgency says alone first
    // (2 > 1). Importance is the leading key, so middle keeps its place above the isolated head.
    expect(rows.findIndex((row) => row.id === middle)).toBeLessThan(
      rows.findIndex((row) => row.id === alone),
    );
  });

  it('the summary skeleton: tags and weight appear only when they really have content', async () => {
    const plain = await pf.ledger.dag.add({ title: '素节点' });
    const light = await pf.ledger.dag.add({ title: '轻节点', tags: ['art'], weight: 'light' });
    const rows = await pf.ledger.dag.list();
    const plainRow = rows.find((row) => row.id === plain.id)!;
    const lightRow = rows.find((row) => row.id === light.id)!;
    expect(plainRow.tags).toBeUndefined();
    expect(plainRow.weight).toBeUndefined();
    expect(lightRow.tags).toEqual(['art']);
    expect(lightRow.weight).toBe('light');
  });
});

describe('ready: an absent status reads todo, in every reader', () => {
  /**
   * The criterion `api.md` states — "a node with no status reads `todo`" — as a disk can really carry it:
   * a node with no `status` key at all, and one written as `null`. Both are todo, so both are ready; a
   * word outside the three states is not todo and is not ready. Every reader of ready (the listing, the
   * detail, the line's own ranking and the plan) has to answer that way, or the two sides of the flow
   * disagree about who can run.
   */
  it('list, info, the line ranking and the plan answer the same about a status-less node', async () => {
    const bare = 'aaaaaaaa-1111-4111-8111-111111111111'; // no status key
    const nulled = 'bbbbbbbb-2222-4222-8222-222222222222'; // status: null
    const odd = 'cccccccc-3333-4333-8333-333333333333'; // a word outside the three states
    const done = 'dddddddd-4444-4444-8444-444444444444'; // completed
    const child = 'eeeeeeee-5555-4555-8555-555555555555'; // waits on the status-less node
    await plantNodes({
      [bare]: withoutStatus(nodeOf('无状态', [])),
      [nulled]: { ...nodeOf('空状态', []), status: null },
      [odd]: { ...nodeOf('未知状态词', []), status: 'waiting' },
      [done]: { ...nodeOf('已完成', []), status: 'completed' },
      [child]: nodeOf('等无状态的那格', [bare]),
    });

    const rows = await pf.ledger.dag.list();
    const readyOf = (id: string) => rows.find((row) => row.id === id)!.ready;
    expect(readyOf(bare)).toBe(true);
    expect(readyOf(nulled)).toBe(true);
    // An unknown word is not todo: only an absent cell reads todo, never any cell at all.
    expect(readyOf(odd)).toBe(false);
    expect(readyOf(done)).toBe(false);
    // The dependency side reads an absent status as todo too, so the dependent is not delivered to.
    expect(readyOf(child)).toBe(false);

    // The detail is the second reader of the same criterion.
    for (const [id, wanted] of [
      [bare, true],
      [nulled, true],
      [odd, false],
      [done, false],
      [child, false],
    ] as const) {
      expect((await pf.ledger.dag.info(id)).ready).toBe(wanted);
    }

    // The line's own ranking (what `cycles start` pins) answers the same two nodes: both read todo, so
    // both are pinnable, and the unknown word and the delivered one stay out.
    const line = await pf.ledger.cycles.start({ id: 'c1', tags: ['coding'], parallel: 2 });
    expect(line.holding.map((held) => held.id)).toEqual([bare, nulled]);

    // And the plan hands the head of that same list to the dispatch step.
    const plan = await open(root).conductor.next({ cycle: 'c1' });
    expect(plan.action).toBe('dispatch');
    if (plan.action !== 'dispatch') return;
    expect(plan.node_id).toBe(bare);
  });

  it('a cell with no reading at all is not ready', () => {
    // The other end of the criterion, asked of the one function every reader uses: an id the table does
    // not hold has no reading, and an unreadable cell never counts as runnable.
    expect(nodeReady('ffffffff-6666-4666-8666-666666666666', {})).toBe(false);
  });
});

describe('search: a regex over titles and descriptions', () => {
  it('title hits come first and get the full text; a single hit in a description gets an excerpt', async () => {
    await pf.ledger.dag.add({ title: '登录页重做', description: '与登录无关的铺垫文字' });
    await pf.ledger.dag.add({ title: '导航条', description: '把登录入口挪到右上角' });
    await pf.ledger.dag.add({
      title: '页脚',
      description: '先把导航梳理一遍，把次级入口收进抽屉，然后再把登录入口挪到右上角并保证一眼可见，' +
        '注册入口次之，页脚保留备用通道以便排查问题',
    });

    const hits = await pf.ledger.dag.search('登录');
    expect(hits).toHaveLength(3);
    // Title hits come first and description-only hits after; inside each group the order follows the on-disk sort of node ids.
    expect(hits.slice(0, 1).map((hit) => hit.title)).toEqual(['登录页重做']);
    expect(hits.slice(1).map((hit) => hit.title).sort()).toEqual(['导航条', '页脚'].sort());
    // A title hit gives the full text.
    expect(hits[0]!.description).toBe('与登录无关的铺垫文字');
    const byTitle = new Map(hits.slice(1).map((hit) => [hit.title, hit]));
    // One hit in a short description: the window covers the whole text and the excerpt carries no ellipsis.
    expect(byTitle.get('导航条')!.description).toBe('把登录入口挪到右上角');
    // One hit in a long description: twenty characters on each side of the first hit, and both trimmed ends get an ellipsis.
    const footer = byTitle.get('页脚')!.description!;
    expect(footer.startsWith('...')).toBe(true);
    expect(footer.endsWith('...')).toBe(true);
    expect(footer.length).toBeLessThan(90);
    expect(hits.every((hit) => hit.status === 'todo')).toBe(true);
  });

  it('two or more hits in a description get the full text', async () => {
    await pf.ledger.dag.add({ title: '纯描述的', description: '缓存失效是唯一难题，缓存击穿更难' });
    const hits = await pf.ledger.dag.search('缓存');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.description).toBe('缓存失效是唯一难题，缓存击穿更难');
  });

  it('activeOnly leaves out completed nodes; limit caps the result (5 by default)', async () => {
    const done = await pf.ledger.dag.add({ title: '已完成的:alpha' });
    await pf.ledger.dag.setStatus(done.id, 'completed');
    await pf.ledger.dag.add({ title: '在册的:alpha' });

    const all = await pf.ledger.dag.search('alpha');
    expect(all).toHaveLength(2);
    const active = await pf.ledger.dag.search('alpha', { activeOnly: true });
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe('在册的:alpha');

    for (let index = 0; index < 6; index++) {
      await pf.ledger.dag.add({ title: `批量${index}:needle` });
    }
    expect(await pf.ledger.dag.search('needle')).toHaveLength(5);
    expect(await pf.ledger.dag.search('needle', { limit: 0 })).toHaveLength(6);
    expect(await pf.ledger.dag.search('needle', { limit: 2 })).toHaveLength(2);
  });

  it('a bad regex is rejected', async () => {
    await expect(pf.ledger.dag.search('(')).rejects.toThrow('invalid regex');
  });
});

/** The same node record with the `status` cell taken off: a hand merge can leave the key out entirely. */
function withoutStatus(node: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...node };
  delete copy.status;
  return copy;
}

/** The smallest node record in on-disk shape (key order is left to the writer's sorting). */
function nodeOf(title: string, dependencies: string[]): Record<string, unknown> {
  return {
    title,
    description: '',
    status: 'todo',
    mode: 'auto',
    dependencies,
    created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: '2026-01-01T00:00:00.000000Z',
  };
}
