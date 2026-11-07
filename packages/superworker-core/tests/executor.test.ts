import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { makeLab } from './helpers/plugin-lab';

/**
 * The simulated executor: opens sessions with deterministic ids and records every request it
 * receives; the seam has dispatch as its only door. The second half walks the real chain once —
 * dispatch → the test files the ticket → close — because a dispatch has no result to hand back.
 */

describe('SimulatedExecutor', () => {
  it('opens one session per dispatch, with deterministic ids (sess-1, sess-2, …)', async () => {
    const sim = new SimulatedExecutor();
    await expect(sim.dispatch({ prompt: 'a' })).resolves.toEqual({ sessionId: 'sess-1' });
    await expect(sim.dispatch({ prompt: 'b' })).resolves.toEqual({ sessionId: 'sess-2' });
    await expect(sim.dispatch({ prompt: 'c' })).resolves.toEqual({ sessionId: 'sess-3' });
  });

  it('records every dispatched request: order and content both', async () => {
    const sim = new SimulatedExecutor();
    await sim.dispatch({ cycle: 'cyc', node: 'n1', role: 'execute', prompt: 'p1' });
    await sim.dispatch({ node: 'n2', prompt: 'p2' });
    expect(sim.dispatched).toEqual([
      { cycle: 'cyc', node: 'n1', role: 'execute', prompt: 'p1' },
      { node: 'n2', prompt: 'p2' },
    ]);
  });

  it('stores the request as a copy: the caller cannot change the record afterwards', async () => {
    const sim = new SimulatedExecutor();
    const request = { node: 'n1', prompt: 'original' };
    const pending = sim.dispatch(request);
    request.prompt = 'mutated';
    await pending;
    expect(sim.dispatched[0]?.prompt).toBe('original');
  });

  it("'throw' opens no session and blows up: the way an executor that cannot open one behaves", async () => {
    const sim = new SimulatedExecutor('throw');
    await expect(sim.dispatch({ prompt: 'x' })).rejects.toThrow('opened no session');
    // The request still reached the executor (it was recorded), and no receipt came back.
    expect(sim.dispatched).toHaveLength(1);
  });

  it("'hang' never settles: the promise stays pending instead of answering", async () => {
    const sim = new SimulatedExecutor('hang');
    const winner = await Promise.race([
      sim.dispatch({ prompt: 'x' }).then(() => 'settled', () => 'settled'),
      Promise.resolve('pending'),
    ]);
    expect(winner).toBe('pending');
    expect(sim.dispatched).toHaveLength(1);
  });

  it('a function script decides per call: the request and the index both arrive', async () => {
    const sim = new SimulatedExecutor((_request, index) => (index === 0 ? 'open' : 'throw'));
    await expect(sim.dispatch({ prompt: 'a' })).resolves.toEqual({ sessionId: 'sess-1' });
    await expect(sim.dispatch({ prompt: 'b' })).rejects.toThrow('dispatch #2');
  });

  it('dispatch is the only door on the seam: nothing here launches a process or opens a session', () => {
    expect(Object.getOwnPropertyNames(SimulatedExecutor.prototype).sort())
      .toEqual(['constructor', 'dispatch']);
  });
});

describe('the executor injection point of open()', () => {
  /** A temp project plus one active cycle holding a node (the target of the dispatch seam; all engine work stays in temp dirs). */
  async function seededProject(prefix: string): Promise<{ root: string; nodeId: string; cycleId: string; cleanup(): void }> {
    const lab = makeLab(prefix);
    await lab.superworker.ledger.init();
    const added = await lab.superworker.ledger.dag.add({ title: 'dispatch seam' });
    lab.cycle('c1', [added.id]);
    return { root: lab.root, nodeId: added.id, cycleId: 'c1', cleanup: lab.cleanup };
  }

  it('with no executor, dispatch refuses to run: the executor can only be injected from outside', async () => {
    const project = await seededProject('superworker-exec-');
    try {
      const superworker = open(project.root);
      await expect(superworker.conductor.dispatch({ cycle: project.cycleId, node: project.nodeId }))
        .rejects.toThrow('needs an injected executor');
    } finally {
      project.cleanup();
    }
  });

  it('a green dispatch comes back as a receipt: the session is open, the claim is on disk, and no result exists yet', async () => {
    const project = await seededProject('superworker-exec-');
    try {
      const sim = new SimulatedExecutor();
      const superworker = open(project.root, { executor: sim });
      const receipt = await superworker.conductor.dispatch({ cycle: project.cycleId, node: project.nodeId });
      expect(receipt).toEqual({
        action: 'opened',
        cycle: project.cycleId,
        node_id: project.nodeId,
        node_title: 'dispatch seam',
        prompt: join(project.root, '.superworker', 'meta', 'launch', project.cycleId, project.nodeId, 'prompt.txt'),
        prompt_text: `/sw-conduct ${project.nodeId} [pipeline]\n`,
        session: { sessionId: 'sess-1' },
      });
      // The request carries the cycle and node identity, the role and the prompt line (the bytes dispatch preparation lays down); once the session opens, the claim is on disk.
      expect(sim.dispatched).toEqual([{
        cycle: project.cycleId,
        node: project.nodeId,
        role: 'execute',
        prompt: `/sw-conduct ${project.nodeId} [pipeline]\n`,
      }]);
      expect(existsSync(join(
        project.root, '.superworker', 'meta', 'launch', project.cycleId, project.nodeId, 'started',
      ))).toBe(true);
      // The node's result is not in the receipt: nothing has been settled, and no ticket exists.
      expect(existsSync(join(
        project.root, '.superworker', 'signals', project.cycleId, `${project.nodeId}.json`,
      ))).toBe(false);
      expect((await superworker.ledger.dag.get(project.nodeId))!.status).toBe('todo');
      expect(readFileSync(
        join(project.root, '.superworker', 'meta', 'launch', project.cycleId, project.nodeId, 'prompt.txt'),
        'utf8',
      ).replace(/\r\n/g, '\n')).toBe(`/sw-conduct ${project.nodeId} [pipeline]\n`);
    } finally {
      project.cleanup();
    }
  });

  it('the chain after the receipt: the test files the ticket through handoff, and close settles it', async () => {
    const project = await seededProject('superworker-exec-');
    try {
      const superworker = open(project.root, { executor: new SimulatedExecutor() });
      const receipt = await superworker.conductor.dispatch({ cycle: project.cycleId, node: project.nodeId });
      expect(receipt.action).toBe('opened');
      // The session's result is what a worker files, not what the executor returns: handoff lands the ticket.
      await superworker.conductor.handoff({
        cycle: project.cycleId,
        node: project.nodeId,
        status: 'completed',
        summary: 'the slot is done',
        outputs: {},
      });
      const settled = await superworker.conductor.close({ cycle: project.cycleId, node: project.nodeId });
      expect(settled.path[0]).toMatchObject({ node: project.nodeId, result: 'completed' });
      expect((await superworker.ledger.dag.get(project.nodeId))!.status).toBe('completed');
    } finally {
      project.cleanup();
    }
  });
});
