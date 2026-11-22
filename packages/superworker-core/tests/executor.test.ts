import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { makeLab } from './helpers/plugin-lab';

/**
 * The executor injection point of open(): the seam has dispatch as its only door, and a dispatch
 * has no result to hand back — these tests walk the real chain once, dispatch → the test files
 * the ticket → close.
 */

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
