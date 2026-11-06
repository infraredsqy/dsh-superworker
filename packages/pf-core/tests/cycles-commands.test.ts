import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * The cycle command surface: creating, starting, active/inactive, claim exclusion, path and retry,
 * cycle-level policy. Only invariants are locked — a refusal that should happen has a reason
 * (parallel cap, empty graph, claim exclusion), the timestamps that should move move, and policy
 * lands only in the cycle record; the on-disk bytes are pinned byte for byte by the golden corpus
 * (the cycle-* fixtures), so they are not repeated here.
 */

let root: string;
let pf: ReturnType<typeof open>;

/** The seconds-form timestamp: 2026-…T…:…:…Z. */
const SECONDS_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-cycle-cmd-'));
  pf = open(root);
  return pf.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  pf = undefined!;
});

async function addNode(title: string, options: { tags?: string[]; mode?: 'auto' | 'checkpoint' | 'manual'; dependsOn?: string } = {}) {
  const node = await pf.ledger.dag.add({ title, tags: options.tags, mode: options.mode });
  if (options.dependsOn !== undefined) {
    await pf.ledger.dag.link(node.id, options.dependsOn);
  }
  return node;
}

describe('create: making a cycle', () => {
  it('tags must be declared: an empty range is refused, words outside the vocabulary are taken as they come', async () => {
    await expect(pf.ledger.cycles.create({ id: 'main', tags: [] })).rejects.toThrow('must be given tags');
    await expect(pf.ledger.cycles.create({ id: 'main', tags: ['  '] })).rejects.toThrow('must be given tags');
    const cycle = await pf.ledger.cycles.create({ id: 'main', tags: ['köching'] });
    expect(cycle.tags).toEqual(['köching']);
  });

  it('the default shape: starts active, holds nothing, and the default title takes the day\'s date', async () => {
    const cycle = await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    expect(cycle.status).toBe('active');
    expect(cycle.holding).toEqual([]);
    expect(cycle.path).toEqual([]);
    expect(cycle.policies).toBeUndefined();
    expect(cycle.created_at).toBe(cycle.updated_at);
    expect(cycle.created_at).toMatch(SECONDS_SHAPE);
    expect(cycle.title).toBe(`Cycle ${cycle.created_at.slice(0, 10)}`);
  });

  it('a duplicate name is refused, and so is a second cycle while another is active; force overrides it explicitly', async () => {
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await expect(pf.ledger.cycles.create({ id: 'main', tags: ['coding'] })).rejects.toThrow('already exists');
    await expect(pf.ledger.cycles.create({ id: 'second', tags: ['coding'] })).rejects.toThrow('one cycle at a time');
    const forced = await pf.ledger.cycles.create({ id: 'second', tags: ['coding'], force: true });
    expect(forced.status).toBe('active');
  });
});

describe('start: make a cycle and pin the nodes it opens with', () => {
  it('an empty graph refuses to start, and not a character of state.json is written', async () => {
    await expect(pf.ledger.cycles.start({ id: 'main', tags: ['coding'] })).rejects.toThrow('no ready node');
    expect(existsSync(join(root, '.pf', 'state.json'))).toBe(false);
  });

  it('parallel cap: as many ready slots as parallel allows are pinned in one go by rank, and the node with more dependents ranks first', async () => {
    const hub = await addNode('中枢', { tags: ['coding'] });
    await addNode('叶子', { tags: ['coding'], dependsOn: hub.id });
    const extra = await addNode('旁件', { tags: ['coding'] });
    // What is ready is the hub and the spare (the leaf waits for the hub); the hub has dependents,
    // so its importance score is higher and it ranks first.
    const started = await pf.ledger.cycles.start({ id: 'main', tags: ['coding'], parallel: 2 });
    expect(started.holding.map((item) => item.id)).toEqual([hub.id, extra.id]);
    expect(started.holding.every((item) => item.since === started.created_at)).toBe(true);
    expect(started.policies).toEqual({ parallel: 2 });
  });

  it('parallel defaults to one; a non-positive integer is refused; the cap is a ceiling, not a quota, so as many as remain are pinned', async () => {
    const first = await addNode('头一件', { tags: ['coding'] });
    const secondNode = await addNode('第二件', { tags: ['coding'] });
    const started = await pf.ledger.cycles.start({ id: 'main', tags: ['coding'] });
    // When two rows tie (same score) the rank falls to the on-disk key order; the cap defaults to
    // one, so either of them is the one pinned.
    expect(started.holding).toHaveLength(1);
    expect([first.id, secondNode.id]).toContain(started.holding[0]!.id);
    expect(started.policies).toBeUndefined();
    const spare = await addNode('剩下的那件', { tags: ['coding'] });
    const second = await pf.ledger.cycles.start({ id: 'next', tags: ['coding'], force: true, parallel: 5 });
    // What another cycle holds does not enter the ranking; everything else fills the slots (cap 5,
    // and with only two ready nodes two are pinned).
    const held = started.holding[0]!.id;
    expect(second.holding).toHaveLength(2);
    expect(second.holding.map((item) => item.id)).not.toContain(held);
    expect(second.holding.map((item) => item.id)).toEqual(
      expect.arrayContaining([first.id === held ? secondNode.id : first.id, spare.id]),
    );
    await expect(pf.ledger.cycles.start({ id: 'bad', tags: ['coding'], parallel: 0, force: true }))
      .rejects.toThrow('at least 1');
    await expect(pf.ledger.cycles.start({ id: 'worse', tags: ['coding'], parallel: 1.5, force: true }))
      .rejects.toThrow('takes a positive integer');
  });

  it('tags are the picking range: a ready node outside it stays out of the ranking, and when everything is kept out the tags are blamed', async () => {
    await addNode('圈外件', { tags: ['art'] });
    await expect(pf.ledger.cycles.start({ id: 'main', tags: ['coding'] })).rejects.toThrow('kept out by tag');
    await addNode('圈 内 件', { tags: ['coding'] });
    const started = await pf.ledger.cycles.start({ id: 'main', tags: ['coding'] });
    expect(started.holding).toHaveLength(1);
    const pinned = await pf.ledger.dag.get(started.holding[0]!.id);
    expect(pinned!.title).toBe('圈 内 件');
  });

  it('a tag-based refusal does not count another cycle\'s hold: when the only ready node is both held elsewhere and outside the range, the refusal still blames the tags', async () => {
    const held = await addNode('圈外又被占的', { tags: ['art'] });
    await pf.ledger.cycles.create({ id: 'holder', tags: ['art'] });
    await pf.ledger.cycles.hold('holder', held.id);
    const before = readFileSync(join(root, '.pf', 'state.json'), 'utf8');
    // The reason this cycle cannot pick a node is the tag (the only ready node is art, the cycle
    // wants coding); another cycle's hold cannot turn that around.
    await expect(pf.ledger.cycles.start({ id: 'main', tags: ['coding'], force: true }))
      .rejects.toThrow('kept out by tag');
    expect(readFileSync(join(root, '.pf', 'state.json'), 'utf8')).toBe(before);
  });

  it('a node another cycle is holding stays out of the ranking: a cycle that left service still holds the node it never delivered', async () => {
    const held = await addNode('被占的', { tags: ['coding'] });
    const first = await pf.ledger.cycles.start({ id: 'first', tags: ['coding'] });
    expect(first.holding.map((item) => item.id)).toEqual([held.id]);
    await pf.ledger.cycles.setStatus('first', 'inactive');
    const free = await addNode('空着的', { tags: ['coding'] });
    const second = await pf.ledger.cycles.create({ id: 'second', tags: ['coding'] });
    expect(second.status).toBe('active');
    const claimed = await pf.ledger.cycles.hold('second', free.id);
    expect(claimed.holding.map((item) => item.id)).toEqual([free.id]);
    // The held node is not under the third cycle's name — and it does not come back into the
    // selectable set just because the first cycle left service.
    const spare = await addNode('再一件', { tags: ['coding'] });
    const startedThird = await pf.ledger.cycles.start({ id: 'third', tags: ['coding'], force: true });
    expect(startedThird.holding.map((item) => item.id)).toEqual([spare.id]);
    await pf.ledger.cycles.setStatus('third', 'inactive');
    await pf.ledger.cycles.setStatus('second', 'inactive');
    expect((await pf.ledger.cycles.show('second')).holding.map((item) => item.id)).toEqual([free.id]);
  });
});

describe('status: active and inactive', () => {
  it('any word other than active / inactive is refused', async () => {
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await expect(pf.ledger.cycles.setStatus('main', 'paused' as 'active')).rejects.toThrow('must be one of');
  });

  it('current follows active: a cycle that left service is no longer picked, and pulling it back brings it in', async () => {
    expect(await pf.ledger.cycles.current()).toBeNull();
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    expect((await pf.ledger.cycles.current())!.id).toBe('main');
    await pf.ledger.cycles.setStatus('main', 'inactive');
    expect(await pf.ledger.cycles.current()).toBeNull();
    await pf.ledger.cycles.setStatus('main', 'active');
    expect((await pf.ledger.cycles.current())!.id).toBe('main');
  });

  it('two cycles active at once: current refuses to pick on the caller\'s behalf', async () => {
    await pf.ledger.cycles.create({ id: 'a', tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'b', tags: ['coding'], force: true });
    await expect(pf.ledger.cycles.current()).rejects.toThrow('several active cycles');
  });

  it('pulling back into service is the continue that stands before the checkpoint gate: the approval is written onto the node', async () => {
    const gate = await addNode('过门的', { mode: 'checkpoint', tags: ['coding'] });
    const line = await pf.ledger.cycles.start({ id: 'main', tags: ['coding'] });
    await pf.ledger.dag.setStatus(gate.id, 'completed');
    await pf.ledger.cycles.close('main', { node: gate.id, result: 'completed' });
    await pf.ledger.cycles.setStatus('main', 'inactive');
    expect((await pf.ledger.dag.get(gate.id))!.approved_at).toBeUndefined();
    await pf.ledger.cycles.setStatus('main', 'active');
    const approved = (await pf.ledger.dag.get(gate.id))!;
    expect(approved.approved_at).toBeDefined();
    expect(approved.approved_at! >= approved.completed_at!).toBe(true);
    expect(line.id).toBe('main');
  });

  it('a landing spot that is not a checkpoint, or one already approved: activation writes nothing (the approval stamp does not move)', async () => {
    const plain = await addNode('普通件', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await pf.ledger.dag.setStatus(plain.id, 'completed');
    await pf.ledger.cycles.hold('main', plain.id);
    await pf.ledger.cycles.close('main', { node: plain.id, result: 'completed' });
    await pf.ledger.cycles.setStatus('main', 'inactive');
    await pf.ledger.cycles.setStatus('main', 'active');
    expect((await pf.ledger.dag.get(plain.id))!.approved_at).toBeUndefined();

    const gate = await addNode('过门的', { mode: 'checkpoint', tags: ['coding'] });
    await pf.ledger.dag.setStatus(gate.id, 'completed');
    await pf.ledger.cycles.hold('main', gate.id);
    await pf.ledger.cycles.close('main', { node: gate.id, result: 'completed' });
    const first = await pf.ledger.dag.approve(gate.id);
    await pf.ledger.cycles.setStatus('main', 'inactive');
    await pf.ledger.cycles.setStatus('main', 'active');
    expect((await pf.ledger.dag.get(gate.id))!.approved_at).toBe(first.approved_at);
  });
});

describe('hold: claiming', () => {
  it('a claim lands in the registered list and since records the moment; re-claiming it yourself does not duplicate (restart semantics)', async () => {
    const node = await addNode('要做的', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    const first = await pf.ledger.cycles.hold('main', node.id);
    expect(first.holding).toEqual([{ id: node.id, since: expect.stringMatching(SECONDS_SHAPE) }]);
    const again = await pf.ledger.cycles.hold('main', node.id);
    expect(again.holding).toEqual(first.holding);
    expect(again.updated_at >= first.updated_at).toBe(true);
  });

  it('claim exclusion holds across cycles: a node in someone else\'s hands cannot be taken, whether that cycle is active or not', async () => {
    const node = await addNode('独一件', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'a', tags: ['coding'] });
    await pf.ledger.cycles.hold('a', node.id);
    await pf.ledger.cycles.setStatus('a', 'inactive');
    await pf.ledger.cycles.create({ id: 'b', tags: ['coding'], force: true });
    await expect(pf.ledger.cycles.hold('b', node.id)).rejects.toThrow('already held by cycle "a"');
  });

  it('a cycle not on the books: the claim is refused', async () => {
    const node = await addNode('无主的', { tags: ['coding'] });
    await expect(pf.ledger.cycles.hold('ghost', node.id)).rejects.toThrow('not found in state.json');
  });
});

describe('close: closing and the path', () => {
  it('the verdict enters path (who, from when to when, and the result), and the claim drops with it', async () => {
    const node = await addNode('走一步', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    const held = await pf.ledger.cycles.hold('main', node.id);
    const closed = await pf.ledger.cycles.close('main', { node: node.id, result: 'completed' });
    expect(closed.holding).toEqual([]);
    expect(closed.path).toHaveLength(1);
    expect(closed.path[0]).toEqual({
      node: node.id,
      started_at: held.holding[0]!.since,
      ended_at: expect.stringMatching(SECONDS_SHAPE),
      result: 'completed',
    });
    expect(closed.updated_at).toBe(closed.path[0]!.ended_at);
  });

  it('a node not in hand cannot be closed; a verdict outside the result vocabulary is refused; the cycle records do not move', async () => {
    const node = await addNode('别家的', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await expect(pf.ledger.cycles.close('main', { node: node.id, result: 'completed' }))
      .rejects.toThrow('is not holding');
    await pf.ledger.cycles.hold('main', node.id);
    await expect(pf.ledger.cycles.close('main', { node: node.id, result: 'ok' as 'completed' }))
      .rejects.toThrow('result must be one of');
    expect((await pf.ledger.cycles.show('main')).path).toEqual([]);
  });

  it('a retry is legal: the same node enters path again and again, one step per run', async () => {
    const node = await addNode('返工的', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await pf.ledger.cycles.hold('main', node.id);
    await pf.ledger.cycles.close('main', { node: node.id, result: 'failed' });
    await pf.ledger.cycles.hold('main', node.id);
    const second = await pf.ledger.cycles.close('main', { node: node.id, result: 'completed' });
    expect(second.path).toHaveLength(2);
    expect(second.path.map((step) => step.result)).toEqual(['failed', 'completed']);
    expect(second.path.every((step) => step.node === node.id)).toBe(true);
  });
});

describe('retry: a retry only clears the ticket', () => {
  it('the old ticket is taken down and rewritten as a six-key pending ticket; the cycle record is not changed by a character', async () => {
    const node = await addNode('要重跑的', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await pf.ledger.cycles.hold('main', node.id);
    const signalPath = join(root, '.pf', 'signals', 'main', `${node.id}.json`);
    mkdirSync(dirname(signalPath), { recursive: true });
    writeFileSync(signalPath, JSON.stringify({
      cycle: 'main', node: node.id, status: 'failed', summary: '上回没成', outputs: {}, timestamp: '2026-01-01T00:00:00Z',
    }), 'utf8');
    const before = await pf.ledger.cycles.show('main');
    const after = await pf.ledger.cycles.retry('main', node.id);
    expect(after.holding).toEqual(before.holding);
    expect(after.updated_at).toBe(before.updated_at);
    const ticket = JSON.parse(readFileSync(signalPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(ticket)).toEqual(['cycle', 'node', 'status', 'summary', 'outputs', 'timestamp']);
    expect(ticket.status).toBe('pending');
    expect(ticket.summary).toBe('Node restarted (previous signal cleared)');
    expect(ticket.timestamp).toMatch(SECONDS_SHAPE);
  });

  it('the retry ticket carries the sentence the caller gave; without one the fixed note stays', async () => {
    const node = await addNode('重票据', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await pf.ledger.cycles.hold('main', node.id);
    const signalPath = join(root, '.pf', 'signals', 'main', `${node.id}.json`);

    await pf.ledger.cycles.retry('main', node.id, { summary: 'redo it' });
    expect((JSON.parse(readFileSync(signalPath, 'utf8')) as Record<string, unknown>).summary)
      .toBe('redo it');

    // The fixed note is what a retry without a sentence leaves, and an empty string reads the same way.
    await pf.ledger.cycles.retry('main', node.id);
    expect((JSON.parse(readFileSync(signalPath, 'utf8')) as Record<string, unknown>).summary)
      .toBe('Node restarted (previous signal cleared)');
    await pf.ledger.cycles.retry('main', node.id, { summary: '' });
    expect((JSON.parse(readFileSync(signalPath, 'utf8')) as Record<string, unknown>).summary)
      .toBe('Node restarted (previous signal cleared)');
  });

  it('node defaults to the one in hand; empty-handed and with nothing walked, there is nothing to retry', async () => {
    const node = await addNode('在手件', { tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await pf.ledger.cycles.hold('main', node.id);
    const retried = await pf.ledger.cycles.retry('main');
    expect(retried.holding.map((item) => item.id)).toEqual([node.id]);
    expect(existsSync(join(root, '.pf', 'signals', 'main', `${node.id}.json`))).toBe(true);

    await pf.ledger.cycles.close('main', { node: node.id, result: 'completed' });
    const walked = await pf.ledger.cycles.retry('main');
    expect(existsSync(join(root, '.pf', 'signals', 'main', `${node.id}.json`))).toBe(true);
    expect(walked.path).toHaveLength(1);
    await pf.ledger.cycles.retry('main', node.id);
    await expect(pf.ledger.cycles.retry('other')).rejects.toThrow('not found in state.json');
  });
});

describe('policy: the cycle\'s own policies', () => {
  it('the effective set = the defaults underneath plus what the cycle wrote: writing one entry returns the whole effective set', async () => {
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    expect(await pf.ledger.cycles.setPolicy('main', 'parallel', 3)).toEqual({
      when_shelved: 'stop',
      parallel: 3,
    });
    expect(await pf.ledger.cycles.setPolicy('main', 'when_shelved', 'continue')).toEqual({
      when_shelved: 'continue',
      parallel: 3,
    });
    const shown = await pf.ledger.cycles.show('main');
    expect(shown.policies).toEqual({ parallel: 3, when_shelved: 'continue' });
  });

  it('a policy key this engine does not know is skipped as an unknown key: the line still reads, and the word is in no effective set', async () => {
    // A record another implementation wrote carries a word of its own in the same `policies` slot.
    // It stays on disk as data; the reading neither throws nor leaves it out of the line record.
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    const statePath = join(root, '.pf', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.cycles[0].policies = { parallel: 2, spawner: 'zcode' };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    expect(await pf.ledger.cycles.policies('main')).toEqual({ when_shelved: 'stop', parallel: 2 });
    expect((await pf.ledger.cycles.current())!.policies).toEqual({ parallel: 2, spawner: 'zcode' });
    // Writing one key of the effective set goes through the same tolerant read: the old word is not
    // carried into the set it echoes back, and it is still there on the record, untouched.
    expect(await pf.ledger.cycles.setPolicy('main', 'parallel', 3)).toEqual({
      when_shelved: 'stop',
      parallel: 3,
    });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).cycles[0].policies).toEqual({
      parallel: 3,
      spawner: 'zcode',
    });
  });

  it('the write side checks: a word outside the vocabulary, a value that fails its kind, and a key with no name are all refused', async () => {
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await expect(pf.ledger.cycles.setPolicy('main', 'when_shelved', 'pause')).rejects.toThrow('must be one of');
    await expect(pf.ledger.cycles.setPolicy('main', 'parallel', 'many')).rejects.toThrow('positive integer');
    await expect(pf.ledger.cycles.setPolicy('main', 'spawner', 'dsh')).rejects.toThrow('unknown policy');
    await expect(pf.ledger.cycles.setPolicy('main', 'max_agents', 2)).rejects.toThrow('unknown policy');
  });

  it('off / null clears one entry: the policies key stays (as an empty object) and the default shows again', async () => {
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await pf.ledger.cycles.setPolicy('main', 'parallel', 2);
    const cleared = await pf.ledger.cycles.setPolicy('main', 'parallel', 'off');
    expect(cleared).toEqual({ when_shelved: 'stop', parallel: 1 });
    expect((await pf.ledger.cycles.show('main')).policies).toEqual({});
    const nullCleared = await pf.ledger.cycles.setPolicy('main', 'when_shelved', null);
    expect(nullCleared).toEqual({ when_shelved: 'stop', parallel: 1 });
  });
});

describe('list / show / current: the read side', () => {
  it('list gives every cycle in on-disk order; show names one; a ledger never init-ed is an empty ledger', async () => {
    await pf.ledger.cycles.create({ id: 'first', tags: ['coding'] });
    await pf.ledger.cycles.create({ id: 'second', tags: ['coding'], force: true });
    const listed = await pf.ledger.cycles.list();
    expect(listed.map((cycle) => cycle.id)).toEqual(['first', 'second']);
    expect((await pf.ledger.cycles.show('second')).id).toBe('second');
    await expect(pf.ledger.cycles.show('ghost')).rejects.toThrow('not found in state.json');
    await expect(pf.ledger.cycles.hold('ghost', 'x')).rejects.toThrow('not found in state.json');
  });

  it('a line id this record does not have refuses with cycle_not_found, the same code the settings chain uses', async () => {
    await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    for (const call of [
      () => pf.ledger.cycles.show('ghost'),
      () => pf.ledger.cycles.policies('ghost'),
      () => pf.ledger.cycles.rename('ghost', 'x'),
    ]) {
      const refusal = await call().then(
        () => {
          throw new Error('a call naming a line that is not there went through');
        },
        (error: unknown) => error as { code?: string; path?: string },
      );
      // One absence, one decidable answer: the code a caller branches on, and the record it is about.
      expect(refusal.code).toBe('cycle_not_found');
      expect(refusal.path).toBe(join(root, '.pf', 'state.json'));
    }
  });

  it('a .pf never init-ed: not a byte is written, and reading gives an empty ledger', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'pf-cycle-bare-'));
    try {
      const barePf = open(bare);
      await expect(barePf.ledger.cycles.create({ id: 'main', tags: ['coding'] })).rejects.toThrow('never init-ed');
      expect(existsSync(join(bare, '.pf'))).toBe(false);
      expect(await barePf.ledger.cycles.list()).toEqual([]);
      expect(await barePf.ledger.cycles.current()).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a record written on a cycle comes back whole: rename / show round-trip', async () => {
    await pf.ledger.cycles.create({ id: 'main', title: '旧名', tags: ['coding'] });
    const renamed = await pf.ledger.cycles.rename('main', '新名');
    expect(renamed.title).toBe('新名');
    expect((await pf.ledger.cycles.show('main')).title).toBe('新名');
    const raw = JSON.parse(readFileSync(join(root, '.pf', 'state.json'), 'utf8')) as {
      cycles: Array<Record<string, unknown>>;
    };
    expect(Object.keys(raw.cycles[0]!)).toEqual([
      'id', 'title', 'status', 'holding', 'path', 'created_at', 'updated_at', 'tags',
    ]);
  });
});
