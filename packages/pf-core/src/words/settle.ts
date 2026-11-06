/**
 * `settle`: one node's end, recorded — and nothing else.
 *
 * The engine reads the ticket, puts the verdict into the line's path, lays the claim down, marks the graph
 * node and runs the close-time plugin seam. This word adds no second operation: it pins nothing, lands no
 * prompt, opens no session and does not park the line. What the line does next is printed underneath as the
 * plan, and the command that carries it out is `advance` (the host runs it by itself when it drives the
 * line). To stop the line a person runs `cycle status <id> inactive`; to name the next node, `cycle hold`.
 */
import { handleOf, projectRootOf, pyIndented, refuse, short } from './out';
import { actionText, holderOf } from './plan';
import type { VerbCall } from './types';

/** `settle <node> [--cycle <id>] [--json]`: the one write half of a worker's close. */
export async function settleVerb(call: VerbCall) {
  const { values, positionals, io } = call;
  const nodeId: string | undefined = positionals[0]?.[0];
  if (nodeId === undefined || nodeId === '') {
    return refuse('settle names the node whose ticket is on disk. Nothing was changed.', 2);
  }
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  const asJson = values.json === true;
  try {
    let cycleId: string | undefined = values.cycle;
    if (cycleId === undefined) {
      const found = await holderOf(await pf.ledger.cycles.list(), nodeId);
      if (found.refusal !== undefined) return refuse(`${found.refusal} Nothing was changed.`, 2);
      cycleId = String(found.cycle.id);
    }
    const settled = await pf.conductor.settle({ cycle: cycleId, node: nodeId });
    const steps = (settled.path ?? []) as any[];
    const last = steps[steps.length - 1];
    const plan = await pf.conductor.next({ cycle: cycleId });
    if (asJson) {
      return {
        stdout: pyIndented({
          action: 'settle',
          cycle: cycleId,
          node: nodeId,
          result: last?.result ?? '',
          plan,
        }),
      };
    }
    return {
      stdout: [
        `settled: ${short(nodeId)} on ${cycleId} (result: ${last?.result ?? ''})`,
        '',
        actionText(plan as Record<string, any>),
      ].join('\n'),
    };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), 2);
  }
}