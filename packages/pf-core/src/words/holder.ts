/**
 * Which line a closing call belongs to. The record judgement is the engine's own (`ledger.cycles.holder`
 * reads the claim and the walked path once); what lives here is only the words a caller reads when
 * there is no single line to name.
 */
import type { Pf } from '../open';

/** The line a closing call started without `--cycle`, or the sentence that says why there is none. */
export async function lineHoldingOf(
  pf: Pf,
  nodeId: string,
): Promise<{ cycle?: string; refusal?: string }> {
  const holder = await pf.ledger.cycles.holder(nodeId);
  const several = holder.holders.map((cycle) => String(cycle.id));
  if (several.length === 1) return { cycle: several[0] };
  if (several.length > 1) {
    return {
      refusal: `${nodeId} is the node of several lines (${several.join(', ')}); name it with --cycle.`,
    };
  }
  const closedOn = holder.closedOn.map((cycle) => String(cycle.id));
  if (closedOn.length > 0) {
    return {
      refusal: `${nodeId} is already closed on ${closedOn.join(', ')}; there is nothing left to settle. ` +
        'Reopen it, or start a new line.',
    };
  }
  const holding = holder.lines.map(
    (cycle) =>
      `${String(cycle.id)}:${((cycle.holding ?? []) as readonly { id: string }[]).map((item) => item.id).join(', ') || '(none)'}`,
  );
  return {
    refusal:
      `${nodeId} is not a node any line is holding. Every line holds ${holding.join('; ') || 'none'}.`,
  };
}
