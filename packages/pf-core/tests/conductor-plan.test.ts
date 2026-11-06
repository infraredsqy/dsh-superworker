import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { NextPlan } from '../src/conductor';
import { open } from '../src/open';
import { replayCase } from './helpers/corpus';
import { hashDirectory } from './helpers/hash-dir.ts';

/**
 * `conductor.next`: a plan that can be read, explained and not executed.
 *
 * The corpus (tests/fixtures/plan-*) already pins the **bytes** of every answer; this file adds
 * the faces the corpus cannot reach: a scene built from the public verbs (the seam from records to
 * plan), the mutual exclusion of `running` and `ready`, cycle width and the two cycle policies,
 * and the "read only" boundary itself. What is locked is the criterion (who enters the ready set,
 * why it stops, where it stops), not the shape of the implementation.
 */

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pf-plan-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Lay down a handoff signal (the write side has no verb for it yet, so the test lays it itself). */
function putSignal(root: string, cycle: string, node: string, status: string, summary = 'done'): void {
  const path = join(root, '.pf', 'signals', cycle, `${node}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { cycle, node, status, summary, outputs: {}, timestamp: '2026-01-01T00:00:03Z' },
      null,
      2,
    ),
    'utf8',
  );
}

/** The plan's action word, narrowed for the tests that read node_id / reason off the plan. */
function actionOf(plan: NextPlan): string {
  return plan.action;
}

describe('planning: readiness criterion and picking', () => {
  it('no cycle yet: answers no_cycle and says that opening one needs a human intent', async () => {
    const root = freshRoot();
    await open(root).ledger.init();
    const plan = await open(root).conductor.next();
    expect(actionOf(plan)).toBe('no_cycle');
    if (plan.action !== 'no_cycle') return;
    expect(plan.cycle).toBeNull();
    expect(plan.note).toContain('needs human intent');
  });

  it('cycle active, hands empty, one ready node in the graph: open_node names it', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const node = await pf.ledger.dag.add({ title: 'write it' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    const plan = await open(root).conductor.next();
    expect(actionOf(plan)).toBe('open_node');
    if (plan.action !== 'open_node') return;
    expect(plan.node_id).toBe(node.id);
    expect(plan.nodes).toEqual([node.id]);
    expect(plan.settling).toBe(true);
  });

  it('running and ready exclude each other: a node another cycle holds cannot be picked, and the reason names that cycle', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const busy = await pf.ledger.dag.add({ title: 'busy elsewhere' });
    const mine = await pf.ledger.dag.add({ title: 'mine', depends_on: [busy.id] });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.create({ id: 'c2', tags: ['writing'], force: true });
    await pf.ledger.cycles.hold('c2', busy.id);
    const plan = await open(root).conductor.next({ cycle: 'c1' });
    expect(actionOf(plan)).toBe('stop_pipeline');
    if (plan.action !== 'stop_pipeline') return;
    expect(plan.reason).toContain('another cycle already occupies');
    expect(plan.reason).toContain(busy.id);
    // The node itself is still todo: who works on it is a property of the cycle, so the three states do not move.
    expect((await pf.ledger.dag.get(mine.id))!.status).toBe('todo');
  });

  it('a node whose dependency has not delivered stays out of the ready set: the chain head is picked, downstream waits', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const first = await pf.ledger.dag.add({ title: 'first' });
    const second = await pf.ledger.dag.add({ title: 'second', depends_on: [first.id] });
    await pf.ledger.dag.add({ title: 'third', depends_on: [second.id] });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    const plan = await open(root).conductor.next();
    expect(actionOf(plan)).toBe('open_node');
    if (plan.action !== 'open_node') return;
    expect(plan.node_id).toBe(first.id);
    expect(plan.nodes).toEqual([first.id]);
  });

  it('ties: equally scored rows are settled by the graph ordering (it takes the first row of that ordering)', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    await pf.ledger.dag.add({ title: 'beta' });
    await pf.ledger.dag.add({ title: 'alpha' });
    await pf.ledger.dag.add({ title: 'gamma' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    // Three rows score alike (importance and urgency are both 0), so the order is entirely the
    // graph's own sort; planning takes only its first row.
    const head = (await pf.ledger.dag.list({ ready: true }))[0]!;
    const plan = await open(root).conductor.next();
    expect(actionOf(plan)).toBe('open_node');
    if (plan.action !== 'open_node') return;
    expect(plan.node_id).toBe(head.id);
  });

  it('tag filter: a ready node outside the range is named, and the reason carries the filter set and its own tags', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    await pf.ledger.dag.add({ title: 'drawing', tags: ['art'] });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    const plan = await open(root).conductor.next();
    expect(actionOf(plan)).toBe('stop_pipeline');
    if (plan.action !== 'stop_pipeline') return;
    expect(plan.reason).toContain("filter set ['writing']");
    expect(plan.reason).toContain("tags=['art']");
    expect(plan.reason).toContain('--tags art');
  });

  it('cycle width: a cycle with parallel=2 picks both ready nodes at once, in graph order', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    await pf.ledger.dag.add({ title: 'one' });
    await pf.ledger.dag.add({ title: 'two' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.setPolicy('c1', 'parallel', 2);
    const order = (await pf.ledger.dag.list({ ready: true })).map((row) => row.id);
    const plan = await open(root).conductor.next();
    expect(actionOf(plan)).toBe('open_node');
    if (plan.action !== 'open_node') return;
    expect(plan.nodes).toEqual(order.slice(0, 2));
  });
});

describe('planning: when to stop', () => {
  it('when_shelved=stop: it stops when nothing is delivered, and the shelved node goes to attention', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const slips = await pf.ledger.dag.add({ title: 'slips' });
    await pf.ledger.dag.add({ title: 'next' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.hold('c1', slips.id);
    putSignal(root, 'c1', slips.id, 'failed', 'it broke');
    const plan = await open(root).conductor.next({ after: slips.id });
    expect(actionOf(plan)).toBe('stop_pipeline');
    if (plan.action !== 'stop_pipeline') return;
    expect(plan.reason).toContain('this node did not deliver (failed): it broke');
    expect(plan.attention.map((item) => item.node_id)).toEqual([slips.id]);
  });

  it('when_shelved=continue: it keeps picking after a miss and the slot is filled on the spot', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const slips = await pf.ledger.dag.add({ title: 'slips' });
    const next = await pf.ledger.dag.add({ title: 'next' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.hold('c1', slips.id);
    await pf.ledger.cycles.setPolicy('c1', 'when_shelved', 'continue');
    putSignal(root, 'c1', slips.id, 'failed', 'it broke');
    const plan = await open(root).conductor.next({ after: slips.id });
    expect(actionOf(plan)).toBe('open_node');
    if (plan.action !== 'open_node') return;
    expect(plan.node_id).toBe(next.id);
  });

  it('the stop point reads the node mode: checkpoint stops at its close, manual closes and opens the next one', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const round = await pf.ledger.dag.add({ title: 'round', mode: 'checkpoint' });
    const next = await pf.ledger.dag.add({ title: 'next' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.hold('c1', round.id);
    putSignal(root, 'c1', round.id, 'completed');
    const stopped = await open(root).conductor.next({ after: round.id });
    expect(actionOf(stopped)).toBe('stop_pipeline');
    if (stopped.action === 'stop_pipeline') {
      expect(stopped.reason).toContain('node mode=checkpoint');
      expect(stopped.reason).toContain('say continue');
    }
    // Switch the cell to manual: the gate goes back into the session and this close step opens the next one.
    await pf.ledger.dag.update(round.id, { mode: 'manual' });
    const carried = await open(root).conductor.next({ after: round.id });
    expect(actionOf(carried)).toBe('open_node');
    if (carried.action === 'open_node') expect(carried.node_id).toBe(next.id);
  });

  it('a boundary instruction tightens the stop: "walk two nodes then stop" stops at the 2nd, and keeps walking before that', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const first = await pf.ledger.dag.add({ title: 'first round' });
    const second = await pf.ledger.dag.add({ title: 'second round' });
    const next = await pf.ledger.dag.add({ title: 'next' });
    // One round is done: one step in the path, and the graph marks that step as delivered the same way the write side does.
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.hold('c1', first.id);
    await pf.ledger.cycles.close('c1', { node: first.id, result: 'completed' });
    await pf.ledger.dag.setStatus(first.id, 'completed');
    await pf.ledger.cycles.hold('c1', second.id);
    putSignal(root, 'c1', second.id, 'completed');
    const cap = await pf.ledger.instructions.add({
      text: 'stop after two nodes',
      scope: 'global',
      target: 'boundary',
      stop_after_nodes: 2,
    });
    const stopped = await open(root).conductor.next({ after: second.id });
    expect(actionOf(stopped)).toBe('stop_pipeline');
    if (stopped.action === 'stop_pipeline') {
      expect(stopped.reason).toBe('instruction "stop after two nodes": stop after 2 nodes');
    }
    // The same instruction relaxed to 3: the count has not been reached, so the cycle picks the next one.
    await pf.ledger.instructions.remove(cap.id);
    await pf.ledger.instructions.add({
      text: 'stop after three nodes',
      scope: 'global',
      target: 'boundary',
      stop_after_nodes: 3,
    });
    const carried = await open(root).conductor.next({ after: second.id });
    expect(actionOf(carried)).toBe('open_node');
    if (carried.action === 'open_node') expect(carried.node_id).toBe(next.id);
  });
});

describe('planning: read only', () => {
  it('asked any number of times, the record directory does not lose a byte', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const slips = await pf.ledger.dag.add({ title: 'slips' });
    const next = await pf.ledger.dag.add({ title: 'next', mode: 'checkpoint' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.hold('c1', slips.id);
    putSignal(root, 'c1', slips.id, 'completed');
    const before = hashDirectory(join(root, '.pf'));
    const plan = await open(root).conductor.next();
    await open(root).conductor.next({ after: slips.id });
    await open(root).conductor.next({ after: next.id, decision: 'stop', note: 'done for now' });
    expect(hashDirectory(join(root, '.pf'))).toBe(before);
    // The ticket is already on disk and the node is not closed yet: that stable state reads as
    // "wait", and it offers the one command that closes it.
    expect(actionOf(plan)).toBe('wait');
    if (plan.action === 'wait') expect(plan.close_with).toContain(slips.id);
  });

  it('the query names a line and a closing rehearsal, and nothing that would make it write', async () => {
    const root = freshRoot();
    const pf = open(root);
    await pf.ledger.init();
    const slips = await pf.ledger.dag.add({ title: 'slips' });
    await pf.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await pf.ledger.cycles.hold('c1', slips.id);
    putSignal(root, 'c1', slips.id, 'completed');
    const before = hashDirectory(join(root, '.pf'));
    const rehearsal = await pf.conductor.next({ cycle: 'c1', after: slips.id });
    expect(rehearsal.cycle).toBe('c1');
    expect(hashDirectory(join(root, '.pf'))).toBe(before);
  });
});

describe('corpus mechanism self-check: a corrupted plan expectation must go red', () => {
  it('with node_title in the plan changed, the replayer points at the first difference', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'pf-plan-selfcheck-'));
    try {
      cpSync(join(fixturesDir, 'plan-tie-stable-order'), join(copy, 'plan-tie-stable-order'), {
        recursive: true,
      });
      const expectedPath = join(copy, 'plan-tie-stable-order', 'expected', 'return.json');
      const original = readFileSync(expectedPath, 'utf8');
      const marker = '"node_title": "beta"';
      expect(original).toContain(marker);
      writeFileSync(expectedPath, original.replace(marker, '"node_title": "BETA"'), 'utf8');
      const result = await replayCase(join(copy, 'plan-tie-stable-order'));
      expect(result.ok).toBe(false);
      expect(result.problems.join('\n')).toContain('the first difference');
      expect(result.problems.join('\n')).toContain('return.json');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});