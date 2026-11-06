/**
 * `settle`: one node's end, recorded — and nothing else.
 *
 * The engine reads the ticket, puts the verdict into the line's path, lays the claim down, marks the graph
 * node and runs the close-time plugin seam. This word adds no second operation: it pins nothing, lands no
 * prompt, opens no session and does not park the line. What the line does next is printed underneath as the
 * plan, and the command that carries it out is `advance` (the host runs it by itself when it drives the
 * line). To stop the line a person runs `cycle status <id> inactive`; to name the next node, `hold`.
 *
 * `--dry-run` is the same gates and the same criteria with the effect shaped away: the engine answers
 * `settlePreview`, the close seam is asked its own previews, and not one record byte is written. It is a
 * rehearsal, not a second word — what it prints is what this word would land.
 */
import { handleOf, projectRootOf, pyIndented, refuse, short } from './out';
import { actionText, holderOf } from './plan';
import type { VerbCall } from './types';

/** `settle <node> [--cycle <id>] [--dry-run] [--json]`: the one write half of a worker's close. */
export async function settleVerb(call: VerbCall) {
  const { values, positionals, io } = call;
  const nodeId: string | undefined = positionals[0]?.[0];
  if (nodeId === undefined || nodeId === '') {
    return refuse('settle names the node whose ticket is on disk. Nothing was changed.', 2);
  }
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  const asJson = values.json === true;
  const dryRun = values.dry_run === true;
  try {
    let cycleId: string | undefined = values.cycle;
    if (cycleId === undefined) {
      const found = await holderOf(await pf.ledger.cycles.list(), nodeId);
      if (found.refusal !== undefined) return refuse(`${found.refusal} Nothing was changed.`, 2);
      cycleId = String(found.cycle.id);
    }
    if (dryRun) {
      const preview = await pf.conductor.settlePreview({ cycle: cycleId, node: nodeId });
      if (asJson) {
        return {
          stdout: pyIndented({
            action: 'settle',
            dry_run: true,
            cycle: preview.cycle,
            node: preview.node_id,
            result: preview.result,
            graph: preview.graph,
            target: preview.target,
            filled: preview.filled,
            park_line: preview.park_line,
            seam: preview.seam,
            warnings: preview.warnings,
            plan: preview.plan,
          }),
        };
      }
      const where = preview.target === null
        ? 'nothing (this close opens no next node)'
        : `${short(preview.target)} (the node this close would open next)`;
      const seam = preview.seam.length === 0
        ? 'no plugin would insert this round'
        : preview.seam
            .map((offer) =>
              `would insert ${JSON.stringify(offer.title)} in front of ${where} (plugin ${offer.plugin})` +
              `${offer.why === '' ? '' : `\n        why: ${offer.why}`}`)
            .join('\n        ');
      return {
        stdout: [
          'dry run: nothing was written',
          `settle: ${short(nodeId)} on ${cycleId} (result would be: ${preview.result}; graph: ${preview.graph})`,
          `seam:   ${seam}`,
          ...preview.warnings,
          '',
          actionText(preview.plan as Record<string, any>),
        ].join('\n'),
      };
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