import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { atomicWriteJson, jsonOptionsForRecord } from '../src/jsonio';
import type { InstructionAddInput, InstructionRecord } from '../src/types';

/**
 * The instruction command surface: register, list, settle, revive, take away, plus visibility as a
 * pure deduction. Only invariants are pinned -- the visibility matrix (scope x binding state x
 * target), the add / list / resolve / revive round trip, tombstones hidden but kept, ids never
 * issued twice, and whole-file read-modify-write; implementation details (the internal order of
 * reads and writes) are not pinned.
 */

let root: string;
let superworker: ReturnType<typeof open>;

/** The seconds shape: 2026-...T...:...:...Z. That is the only shape an instruction stamp takes. */
const SECONDS_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-ins-cmd-'));
  superworker = open(root);
  return superworker.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  superworker = undefined!;
});

function readInstructionFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')) as Record<string, unknown>;
}

async function plantInstructions(entries: unknown[]): Promise<void> {
  await atomicWriteJson(
    join(root, '.superworker', 'instructions.json'),
    { instructions: entries },
    jsonOptionsForRecord('instructions'),
  );
}

const ins = (text: string, input: Partial<InstructionAddInput> = {}) =>
  superworker.ledger.instructions.add({ text, scope: 'global', ...input });

describe('add: registering one instruction', () => {
  it('default shape: stage / live / said_by user, optional keys not given stay off disk, the stamp is in seconds shape', async () => {
    const added = await ins('read the spec of this node first, then start');
    expect(added).toMatchObject({
      id: 'i-0001',
      text: 'read the spec of this node first, then start',
      scope: 'global',
      target: 'stage',
      state: 'live',
      cycle: null,
      node: null,
      said_by: 'user',
      resolved_at: null,
      note: null,
    });
    expect(added.at).toMatch(SECONDS_SHAPE);
    expect('stop_after_nodes' in added).toBe(false);

    // The key set on disk follows the frozen spelling in records.test.ts: one key off and the
    // record vocabulary has changed.
    const entry = (readInstructionFile().instructions as InstructionRecord[])[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      'at', 'cycle', 'id', 'node', 'note', 'resolved_at', 'said_by', 'scope',
      'state', 'target', 'text',
    ]);
  });

  it('every optional key given: target / said_by / note / stop_after_nodes, and the binding follows the named cycle', async () => {
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    const added = await superworker.ledger.instructions.add({
      text: 'clear the open questions before wrapping up',
      scope: 'cycle',
      cycle: 'main',
      target: 'boundary',
      said_by: 'owner',
      note: 'read it aloud at every wrap-up',
      stop_after_nodes: 2,
    });
    expect(added).toMatchObject({
      scope: 'cycle',
      target: 'boundary',
      cycle: 'main',
      said_by: 'owner',
      note: 'read it aloud at every wrap-up',
      stop_after_nodes: 2,
    });
    // stop_after_nodes is an optional key added later; it lands at the end of the record (the
    // writer's construction order).
    const entry = (readInstructionFile().instructions as InstructionRecord[])[0]!;
    expect(Object.keys(entry)[Object.keys(entry).length - 1]).toBe('stop_after_nodes');
  });

  it('the binding follows the spot: with a single line in service, cycle / node are remembered without being named (the node is the one the line holds)', async () => {
    const node = await superworker.ledger.dag.add({ title: 'A' });
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await superworker.ledger.cycles.hold('main', node.id);
    const byCycle = await superworker.ledger.instructions.add({ text: 'line constraint', scope: 'cycle' });
    const byNode = await superworker.ledger.instructions.add({ text: 'node constraint', scope: 'node' });
    expect(byCycle.cycle).toBe('main');
    expect(byCycle.node).toBe(node.id);
    expect(byNode.node).toBe(node.id);
    expect(byNode.cycle).toBe('main');
  });

  it('a named cycle that is not in the book, a node that is not on the graph: refused on the spot', async () => {
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await superworker.ledger.dag.add({ title: 'A' }); // Lay one node down: with a non-empty graph, node validation has a graph to check against.
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'cycle', cycle: 'ghost' }),
    ).rejects.toThrow(/cycle "ghost" is not in state\.json/);
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'node', node: 'no-such-node' }),
    ).rejects.toThrow(/node "no-such-node" is not in the DAG/);
    // Both refusals happen on the spot: not one byte ever landed in the instruction book.
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });

  it('an empty graph lets a named node through (the `if nodes and ...` rule): no validation, the node lands as given', async () => {
    // The graph is not up yet (not one node): there is no graph to check against, so a named node
    // is written as given. The cycle side has no such pass-through branch: naming a cycle against
    // an empty book still refuses.
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'cycle', cycle: 'ghost' }),
    ).rejects.toThrow(/cycle "ghost" is not in state\.json/);
    const added = await superworker.ledger.instructions.add({
      text: 'registration before the graph exists',
      scope: 'node',
      node: 'not-in-dag',
    });
    expect(added.node).toBe('not-in-dag');
    expect((readInstructionFile().instructions as InstructionRecord[])[0]!.node).toBe('not-in-dag');
  });

  it('a cycle / node scope with nothing to bind to: refused, and not one byte lands', async () => {
    // The cycle book and the graph are both empty: nothing to bind to. That is the gate being
    // pinned -- an entry with no binding would be read as visible everywhere.
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'cycle' }),
    ).rejects.toThrow(/needs a line to bind to/);
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'node' }),
    ).rejects.toThrow(/needs a node to bind to/);
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });

  it('with two lines side by side the cycle must be named; an empty body and a scope / target outside the vocabulary are refused', async () => {
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'cycle' }),
    ).rejects.toThrow(/needs a line to bind to/);
    const named = await superworker.ledger.instructions.add({ text: 'x', scope: 'cycle', cycle: 'two' });
    expect(named.cycle).toBe('two');

    await expect(superworker.ledger.instructions.add({ text: '  ', scope: 'global' })).rejects.toThrow(
      /text must not be empty/,
    );
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'round' as never }),
    ).rejects.toThrow(/scope must be one of/);
    await expect(
      superworker.ledger.instructions.add({ text: 'x', scope: 'global', target: 'round' as never }),
    ).rejects.toThrow(/target must be one of/);
  });

  it('an id once issued is never issued again: a tombstone left by a removal counts too', async () => {
    const a = await ins('first entry');
    const b = await ins('second entry');
    await superworker.ledger.instructions.remove(b.id);
    const c = await ins('third entry');
    expect(a.id).toBe('i-0001');
    expect(c.id).toBe('i-0003');
  });
});

describe('the visibility matrix: scope x binding state x target', () => {
  /**
   * A fixed scene: the first node is todo and held by the main line, the second is completed and
   * held by that line in parallel, the third is todo and held by the cycle that left service;
   * two globals (stage / boundary), one on the main line, one on the cycle out of service, three
   * node bindings, one archived, one taken away (a tombstone).
   */
  async function plantScenario(): Promise<{
    ids: Record<string, string>;
    nodeA: string;
    nodeB: string;
  }> {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    await superworker.ledger.dag.setStatus(nodeB, 'completed');
    const nodeC = (await superworker.ledger.dag.add({ title: 'C' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await superworker.ledger.cycles.hold('one', nodeB);
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await superworker.ledger.cycles.hold('two', nodeC);
    await superworker.ledger.cycles.setStatus('two', 'inactive');

    const ids: Record<string, string> = {};
    ids.g = (await ins('global constraint')).id;
    ids.bt = (await ins('global constraint on the wrap-up edge', { target: 'boundary' })).id;
    ids.k1 = (await superworker.ledger.instructions.add({ text: 'constraint of this line', scope: 'cycle', cycle: 'one' })).id;
    ids.k2 = (await superworker.ledger.instructions.add({ text: 'constraint of the out-of-service line', scope: 'cycle', cycle: 'two' })).id;
    ids.na = (await superworker.ledger.instructions.add({ text: 'constraint on node A', scope: 'node', node: nodeA })).id;
    ids.nb = (await superworker.ledger.instructions.add({ text: 'constraint on node B', scope: 'node', node: nodeB })).id;
    ids.nc = (await superworker.ledger.instructions.add({ text: 'constraint on node C', scope: 'node', node: nodeC })).id;
    ids.nw = (await ins('archived constraint')).id;
    await superworker.ledger.instructions.resolve(ids.nw!);
    ids.g2 = (await ins('constraint taken away')).id;
    await superworker.ledger.instructions.remove(ids.g2!);
    return { ids, nodeA, nodeB };
  }

  type ReadSpot = 'default' | 'on node B' | 'after the cycle leaves service' | 'full book';

  /** A matrix row: scope x binding state x target x reading spot -> seen / not seen. */
  const ROWS: Array<{ key: string; scope: string; binding: string; target: string; spot: ReadSpot; seen: boolean }> = [
    { key: 'g', scope: 'global', binding: '—', target: 'stage', spot: 'default', seen: true },
    { key: 'g', scope: 'global', binding: '—', target: 'stage', spot: 'on node B', seen: true },
    { key: 'g', scope: 'global', binding: '—', target: 'stage', spot: 'after the cycle leaves service', seen: true },
    { key: 'bt', scope: 'global', binding: '—', target: 'boundary', spot: 'default', seen: true },
    { key: 'bt', scope: 'global', binding: '—', target: 'boundary', spot: 'after the cycle leaves service', seen: true },
    { key: 'k1', scope: 'cycle', binding: 'cycle in service', target: 'stage', spot: 'default', seen: true },
    { key: 'k1', scope: 'cycle', binding: 'cycle in service', target: 'stage', spot: 'on node B', seen: true },
    { key: 'k1', scope: 'cycle', binding: 'cycle in service', target: 'stage', spot: 'after the cycle leaves service', seen: false },
    { key: 'k2', scope: 'cycle', binding: 'cycle out of service', target: 'stage', spot: 'default', seen: false },
    { key: 'k2', scope: 'cycle', binding: 'cycle out of service', target: 'stage', spot: 'on node B', seen: false },
    { key: 'k2', scope: 'cycle', binding: 'cycle out of service', target: 'stage', spot: 'after the cycle leaves service', seen: false },
    { key: 'na', scope: 'node', binding: 'node unfinished (held)', target: 'stage', spot: 'default', seen: true },
    { key: 'na', scope: 'node', binding: 'node unfinished', target: 'stage', spot: 'on node B', seen: false },
    { key: 'na', scope: 'node', binding: 'node unfinished', target: 'stage', spot: 'after the cycle leaves service', seen: true },
    { key: 'nb', scope: 'node', binding: 'node done', target: 'stage', spot: 'default', seen: false },
    { key: 'nb', scope: 'node', binding: 'node done (the node itself)', target: 'stage', spot: 'on node B', seen: true },
    { key: 'nb', scope: 'node', binding: 'node done', target: 'stage', spot: 'after the cycle leaves service', seen: false },
    { key: 'nc', scope: 'node', binding: 'cycle out of service, node unfinished', target: 'stage', spot: 'on node B', seen: false },
    { key: 'nc', scope: 'node', binding: 'cycle out of service, node unfinished', target: 'stage', spot: 'after the cycle leaves service', seen: true },
    { key: 'nw', scope: 'global', binding: 'archived', target: 'stage', spot: 'default', seen: false },
    { key: 'nw', scope: 'global', binding: 'archived', target: 'stage', spot: 'on node B', seen: false },
    { key: 'nw', scope: 'global', binding: 'archived', target: 'stage', spot: 'after the cycle leaves service', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'default', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'on node B', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'after the cycle leaves service', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'full book', seen: false },
  ];

  it.each(
    ROWS.map((row) => ({
      ...row,
      title: `${row.key} (${row.scope}/${row.binding}/${row.target}) from ${row.spot}: ${row.seen ? 'seen' : 'not seen'}`,
    })),
  )('$title', async ({ key, spot, seen }) => {
    const { ids, nodeB } = await plantScenario();
    let rows: Array<{ id: string }>;
    if (spot === 'on node B') rows = await superworker.ledger.instructions.list({ node: nodeB });
    else if (spot === 'after the cycle leaves service') {
      await superworker.ledger.cycles.setStatus('one', 'inactive');
      rows = await superworker.ledger.instructions.list();
    } else if (spot === 'full book') rows = await superworker.ledger.instructions.list({ all: true });
    else rows = await superworker.ledger.instructions.list();
    expect(rows.some((row) => row.id === ids[key]!)).toBe(seen);
  });

  it('a tombstone is hidden but kept: the body is gone from disk while removed keeps the id and the stamp', async () => {
    const { ids } = await plantScenario();
    const raw = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(raw).not.toContain('constraint taken away');
    const traces = readInstructionFile().removed as Array<{ id: string; at: string }>;
    expect(traces.map((trace) => trace.id)).toEqual([ids.g2]);
    expect(traces[0]!.at).toMatch(SECONDS_SHAPE);
    // A tombstone has only the id and the stamp, no body and no status word.
    expect(Object.keys(traces[0]!).sort()).toEqual(['at', 'id']);
  });
});

describe('resolve / revive: the settle and revive round trip', () => {
  it('resolve lands the state and the settling stamp: it leaves the default view while the full book still has it', async () => {
    const added = await ins('run the typecheck before handing it in');
    const resolved = await superworker.ledger.instructions.resolve(added.id);
    expect(resolved.state).toBe('withdrawn');
    expect(resolved.resolved_at).toMatch(SECONDS_SHAPE);
    expect(resolved.text).toBe('run the typecheck before handing it in');

    expect(await superworker.ledger.instructions.list()).toEqual([]);
    const account = await superworker.ledger.instructions.list({ all: true });
    expect(account.map((row) => row.id)).toEqual([added.id]);
    expect(account[0]!.text).toBe('run the typecheck before handing it in');
  });

  it('the resolve-then-revive round trip: back to live, the settling stamp cleared, the default view back', async () => {
    const added = await ins('the report writes the present value only');
    await superworker.ledger.instructions.resolve(added.id);
    const revived = await superworker.ledger.instructions.revive(added.id);
    expect(revived.state).toBe('live');
    expect(revived.resolved_at).toBeNull();
    expect((await superworker.ledger.instructions.list()).map((row) => row.id)).toEqual([added.id]);
    // Reviving touches only the state and stamp cells; every other key stays as it is.
    const entry = (readInstructionFile().instructions as InstructionRecord[])[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      'at', 'cycle', 'id', 'node', 'note', 'resolved_at', 'said_by', 'scope',
      'state', 'target', 'text',
    ]);
  });

  it('an entry already in force refuses to revive; on the refusal not one byte on disk moves', async () => {
    const added = await ins('still live');
    const before = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    await expect(superworker.ledger.instructions.revive(added.id)).rejects.toThrow(/already live/);
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toBe(before);
  });

  it('a taken-away id refuses to revive and names the stamp of the removal; an id the book never had refuses too', async () => {
    const added = await ins('the one to take away');
    await superworker.ledger.instructions.remove(added.id);
    await expect(superworker.ledger.instructions.revive(added.id)).rejects.toThrow(
      new RegExp(`was removed at .+; its text went with it`),
    );
    await expect(superworker.ledger.instructions.revive('i-9999')).rejects.toThrow(/no instruction/);
  });

  it('resolve with a note: the sentence lands on the record beside the settling stamp, and a later resolve without one leaves it', async () => {
    const added = await ins('archived with a note');
    const resolved = await superworker.ledger.instructions.resolve(added.id, { note: 'owner said so' });
    expect(resolved.note).toBe('owner said so');
    expect((readInstructionFile().instructions as InstructionRecord[])[0]!.note).toBe('owner said so');

    // Settling the same entry again with no note writes the state and the stamp only.
    const again = await superworker.ledger.instructions.resolve(added.id);
    expect(again.note).toBe('owner said so');
  });

  it('resolve refuses an id the book does not have; settling an archived entry again still moves its stamp forward', async () => {
    await expect(superworker.ledger.instructions.resolve('i-9999')).rejects.toThrow(/no instruction/);
    const added = await ins('archived twice');
    const first = await superworker.ledger.instructions.resolve(added.id);
    const second = await superworker.ledger.instructions.resolve(added.id);
    expect(second.state).toBe('withdrawn');
    expect(second.resolved_at! >= first.resolved_at!).toBe(true);
  });
});

describe('remove: taking away and tombstones', () => {
  it('a taken-away entry disappears from every reading and its body leaves the disk; the tombstone keeps the id and the stamp', async () => {
    const a = await ins('the first one to take away');
    const b = await ins('the second one left behind');
    await superworker.ledger.instructions.remove(a.id);

    expect((await superworker.ledger.instructions.list()).map((row) => row.id)).toEqual([b.id]);
    expect((await superworker.ledger.instructions.list({ all: true })).map((row) => row.id)).toEqual([b.id]);
    const raw = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(raw).not.toContain('the first one to take away');
    const file = readInstructionFile();
    expect(Object.keys(file)).toEqual(['instructions', 'removed']);
    const traces = file.removed as Array<{ id: string; at: string }>;
    expect(traces[0]!.id).toBe(a.id);
    expect(traces[0]!.at).toMatch(SECONDS_SHAPE);
  });

  it('removing a second time names the tombstone; an id the book never had is refused', async () => {
    const a = await ins('take away once');
    await superworker.ledger.instructions.remove(a.id);
    const before = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    await expect(superworker.ledger.instructions.remove(a.id)).rejects.toThrow(/was removed at .+; its text is already/);
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toBe(before);
    await expect(superworker.ledger.instructions.remove('i-9999')).rejects.toThrow(/no instruction/);
  });
});

describe('list: position and account order', () => {
  it('account order: neither view sorts; the rows come back in the order the file holds them', async () => {
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['coding'] });
    await superworker.ledger.cycles.hold('c1', 'node-a');
    await plantInstructions([
      { id: 'i-0001', text: 'old global', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0002', text: 'on the line', scope: 'cycle', target: 'stage', state: 'live', cycle: 'c1', node: 'node-a', said_by: 'user', at: '2026-01-02T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0003', text: 'on the node', scope: 'node', target: 'stage', state: 'live', cycle: null, node: 'node-b', said_by: 'user', at: '2026-01-03T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0004', text: 'new global', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-04T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0005', text: 'archived global', scope: 'global', target: 'stage', state: 'withdrawn', cycle: null, node: null, said_by: 'user', at: '2026-01-05T00:00:00Z', resolved_at: '2026-01-05T01:00:00Z', note: null },
    ]);
    const account = await superworker.ledger.instructions.list({ all: true });
    expect(account.map((row) => row.id)).toEqual(['i-0001', 'i-0002', 'i-0003', 'i-0004', 'i-0005']);
  });

  it('the default view is folded to the reader rows: id, text, the scope as read, the target as written and the reach word', async () => {
    const added = await superworker.ledger.instructions.add({ text: 'only read at wrap-up', scope: 'global', target: 'boundary' });
    expect(await superworker.ledger.instructions.list()).toEqual([{
      id: added.id,
      text: 'only read at wrap-up',
      scope: 'global',
      target: 'boundary',
      reach: 'boundary',
    }]);
    // A record that states no target folds to null, and its reach reads the stage default; a word
    // outside the two-word vocabulary reads the same way — reach is never a third word.
    await plantInstructions([
      { id: 'i-0009', text: 'no delivery channel written', scope: 'global', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
    ]);
    expect(await superworker.ledger.instructions.list()).toEqual([{
      id: 'i-0009', text: 'no delivery channel written', scope: 'global', target: null, reach: 'stage',
    }]);
    await plantInstructions([
      { id: 'i-0010', text: 'foreign delivery word', scope: 'global', target: 'round', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
    ]);
    expect(await superworker.ledger.instructions.list()).toEqual([{
      id: 'i-0010', text: 'foreign delivery word', scope: 'global', target: 'round', reach: 'stage',
    }]);
  });

  it("the default view follows the reader's spot: a named node pins it; with two lines side by side and no name it falls back to the wide read", async () => {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await superworker.ledger.cycles.hold('two', nodeB);
    const lineOne = await superworker.ledger.instructions.add({ text: 'constraint of line one', scope: 'cycle', cycle: 'one' });
    const lineTwo = await superworker.ledger.instructions.add({ text: 'constraint of line two', scope: 'cycle', cycle: 'two' });

    // Naming a node pins the line: the first node is in the first line's hand, so only that line
    // is read; the second is in the second's, so only the second is read.
    expect((await superworker.ledger.instructions.list({ node: nodeA })).map((row) => row.id)).toEqual([lineOne.id]);
    expect((await superworker.ledger.instructions.list({ node: nodeB })).map((row) => row.id)).toEqual([lineTwo.id]);
    // Nobody is named: the spot cannot be pinned, so the read goes wide -- both lines still in
    // service count as being in service.
    const wide = await superworker.ledger.instructions.list();
    expect(wide.map((row) => row.id).sort()).toEqual([lineOne.id, lineTwo.id].sort());
  });

  it('an old record with no binding is visible everywhere; an unrecognized scope word reads as global', async () => {
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['coding'] });
    await superworker.ledger.cycles.hold('c1', 'node-a');
    await plantInstructions([
      { id: 'i-0001', text: 'cycle scope with nothing bound', scope: 'cycle', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0002', text: 'node scope with nothing bound', scope: 'node', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-02T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0003', text: 'old-word scope', scope: 'once', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-03T00:00:00Z', resolved_at: null, note: null },
    ]);
    // node-a is in hand and c1 is in service: all three are readable (an empty binding measures
    // nothing; once reads as global), and they come back in the order the file holds them.
    const rows = await superworker.ledger.instructions.list();
    expect(rows.map((row) => row.id)).toEqual(['i-0001', 'i-0002', 'i-0003']);
    // The scope filter works on the scope as read: once falls into the global group.
    expect((await superworker.ledger.instructions.list({ scope: 'global' })).map((row) => row.id)).toEqual(['i-0003']);
    expect((await superworker.ledger.instructions.list({ scope: 'cycle' })).map((row) => row.id)).toEqual(['i-0001']);
    // The live account view drops the archived row and keeps the rest, raw and unsorted.
    const live = await superworker.ledger.instructions.list({ live: true });
    expect(live.map((row) => row.id)).toEqual(['i-0001', 'i-0002', 'i-0003']);
    expect('state' in live[0]!).toBe(true);
  });

  it('an empty project with no cycle book: both the default view and the full book are empty arrays', async () => {
    expect(await superworker.ledger.instructions.list()).toEqual([]);
    expect(await superworker.ledger.instructions.list({ all: true })).toEqual([]);
  });

  it('scope is never written down: the instruction book keeps every byte across three kinds of list', async () => {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    const g = await ins('global constraint');
    const k = await superworker.ledger.instructions.add({ text: 'line constraint', scope: 'cycle', cycle: 'one' });
    const n = await superworker.ledger.instructions.add({ text: 'constraint on A', scope: 'node', node: nodeA });
    await superworker.ledger.instructions.resolve(g.id);

    const file = join(root, '.superworker', 'instructions.json');
    const before = readFileSync(file, 'utf8');
    const defaultView = await superworker.ledger.instructions.list();
    const namedNodeB = await superworker.ledger.instructions.list({ node: nodeB });
    const fullBook = await superworker.ledger.instructions.list({ all: true });
    // Scope is worked out on every read and never written: after three readings the bytes on disk
    // are as they were.
    expect(readFileSync(file, 'utf8')).toBe(before);
    // The three views really do differ, so the byte comparison is not idling.
    expect(defaultView.map((row) => row.id).sort()).toEqual([k.id, n.id].sort());
    // With one line in service, naming the second node gives the spot (one, that node), so the
    // entry bound to the first node is not read.
    expect(namedNodeB.map((row) => row.id)).toEqual([k.id]);
    expect(fullBook.map((row) => row.id)).toEqual([g.id, k.id, n.id]);
  });

  it('a foreign state word reads as archived: absent from the default view, still in the full book, and never written back', async () => {
    await plantInstructions([
      { id: 'i-0001', text: 'foreign state word', scope: 'global', target: 'stage', state: 'some other word', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
    ]);
    expect(await superworker.ledger.instructions.list()).toEqual([]);
    expect((await superworker.ledger.instructions.list({ all: true })).map((row) => row.id)).toEqual(['i-0001']);
    // Archiving is decided on the read side only: the word stays on disk as it is, with no write
    // that flips the state afterwards.
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toContain('some other word');
  });

  it('naming a node nobody holds: the spot cannot be pinned, so the read goes wide -- both lines in service are read', async () => {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    const nodeC = (await superworker.ledger.dag.add({ title: 'C' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await superworker.ledger.cycles.hold('two', nodeB);
    const lineOne = await superworker.ledger.instructions.add({ text: 'constraint of line one', scope: 'cycle', cycle: 'one' });
    const lineTwo = await superworker.ledger.instructions.add({ text: 'constraint of line two', scope: 'cycle', cycle: 'two' });

    // The third node is on the graph but nobody holds it: the only way to pin a spot (the single
    // line in service and in hand) fails, so no spot is given and the read goes wide.
    const rows = await superworker.ledger.instructions.list({ node: nodeC });
    expect(rows.map((row) => row.id).sort()).toEqual([lineOne.id, lineTwo.id].sort());
  });
});

describe('the init gate: a `.superworker` that was never init-ed keeps every byte', () => {
  it('add refuses and the `.superworker` dir was never even raised', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'superworker-ins-gate-'));
    try {
      const naked = open(bare);
      await expect(
        naked.ledger.instructions.add({ text: 'the one that cannot get in', scope: 'global' }),
      ).rejects.toThrow(/was never init-ed .*Ask `init` first/);
      expect(existsSync(join(bare, '.superworker'))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('whole-file read-modify-write of instructions.json: every other top-level key is kept as it is', () => {
  it('a foreign top-level key is still there after add / resolve / remove write back', async () => {
    const added = await ins('witness to a foreign key');
    const file = join(root, '.superworker', 'instructions.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    data.hand_merged = { keep: 'me', nested: { v: 1 } };
    await atomicWriteJson(file, data, jsonOptionsForRecord('instructions'));

    await superworker.ledger.instructions.resolve(added.id);
    expect(readInstructionFile().hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });
    await superworker.ledger.instructions.remove(added.id);
    const after = readInstructionFile();
    expect(after.hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });
    expect(Object.keys(after)).toEqual(['instructions', 'hand_merged', 'removed']);
    expect((after.instructions as unknown[]).length).toBe(0);
  });
});
