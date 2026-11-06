/**
 * `plan`: what the next step is, read-only.
 *
 * One word, one operation: read the records and hand back the plan. It writes not one byte, never lands a
 * prompt and never touches the state — the action that carries a plan out is `advance` (or `dispatch`, the
 * single-cell half of it). `--after <node>` asks the plan the closing question instead: the ticket of that
 * node is on disk, and settling it, where would the line go (still a reading: the rehearsal of the same
 * criteria `settle` lands).
 */
import { handleOf, pyIndented, projectRootOf, refuse, short } from './out';
import type { VerbCall } from './types';

/**
 * One plan as the caller reads it: the action, then every cell a reader has to act on. Key order is that
 * reading's order, not the bag's.
 */
export function actionText(action: Record<string, any>): string {
  const lines: string[] = [`action: ${action.action}`];
  if (action.cycle !== undefined && action.cycle !== null) lines.push(`cycle:  ${action.cycle}`);
  for (const key of ['note', 'reason', 'question', 'hint', 'blocked', 'close_with']) {
    const value = action[key];
    if (value !== undefined && value !== null && value !== '') {
      lines.push(`${`${key}:`.padEnd(9)} ${value}`);
    }
  }
  if (action.node_id !== undefined && action.node_id !== null) {
    lines.push(`node:   ${action.node_title ?? ''}  (${action.node_id})`);
  }
  for (const item of (action.nodes ?? []) as any[]) {
    if (typeof item === 'object' && item !== null && item.node_id !== action.node_id) {
      lines.push(`node:   ${item.node_title ?? ''}  (${item.node_id})`);
    }
  }
  for (const step of (action.steps ?? []) as any[]) lines.push(`  - ${step}`);
  if (action.prompt !== undefined) lines.push(`prompt: ${action.prompt}`);
  if (action.spec !== undefined) lines.push(`spec:   ${action.spec}`);
  if (action.action === 'dispatch') lines.push(`mode:   ${action.mode}`);
  for (const item of (action.attention ?? []) as any[]) {
    const who = item.node_id ? `${item.node_title} (${item.node_id})` : '?';
    lines.push(`attention: ${item.kind}  ${who}`);
    if (item.hint) lines.push(`           ${item.hint}`);
  }
  return lines.join('\n');
}

/**
 * The line a closing rehearsal belongs to: the one holding the node — a worker should not have to learn
 * cycle bookkeeping. A node nobody holds, or one several lines hold, is refused with the reason (a node
 * already closed out has nothing left to rehearse).
 */
export async function holderOf(
  known: readonly any[],
  nodeId: string,
): Promise<{ cycle?: any; refusal?: string }> {
  const holders = known.filter((cycle) =>
    ((Array.isArray(cycle.holding) ? cycle.holding : []) as any[]).some((item) => item.id === nodeId),
  );
  if (holders.length === 1) return { cycle: holders[0] };
  if (holders.length > 1) {
    return {
      refusal: `${nodeId} is the node of several lines (${holders.map((cycle) => cycle.id).join(', ')}); name it with --cycle.`,
    };
  }
  const closed = known.filter((cycle) =>
    ((cycle.path ?? []) as any[]).some((step: any) => step.node === nodeId),
  );
  if (closed.length > 0) {
    return {
      refusal: `${nodeId} is already closed on ${closed.map((cycle) => cycle.id).join(', ')}; there is nothing left to settle. Reopen it, or start a new line.`,
    };
  }
  return {
    refusal:
      `${nodeId} is not a node any line is holding. Every line holds ` +
      `${known.map((cycle) => `${cycle.id}:${((cycle.holding ?? []) as any[]).map((item) => item.id).join(', ') || '(none)'}`).join('; ') || 'none'}.`,
  };
}

/** Print one plan: the JSON spelling when asked for, else the lines. */
export function printAction(action: Record<string, any>, asJson: boolean) {
  return { stdout: asJson ? pyIndented(action) : actionText(action) };
}

/** `plan`: read the plan (or the closing rehearsal), print it, write nothing. */
export async function planVerb(call: VerbCall) {
  const { values, io } = call;
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  const asJson = values.json === true;
  let cycleId: string | undefined = values.cycle;
  try {
    if (values.after !== undefined) {
      if (cycleId === undefined) {
        const found = await holderOf(await pf.ledger.cycles.list(), values.after);
        if (found.refusal !== undefined) return refuse(`${found.refusal} Nothing was changed.`, 2);
        cycleId = String(found.cycle.id);
      }
      const action = await pf.conductor.next({
        cycle: cycleId,
        after: values.after,
      });
      return printAction(action as Record<string, any>, asJson);
    }
    const action = await pf.conductor.next({
      ...(cycleId === undefined ? {} : { cycle: cycleId }),
    } as Record<string, any>);
    return printAction(action as Record<string, any>, asJson);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), 2);
  }
}

/** The node id a closing line names, or a refusal naming what the line does hold. */
export function requireHeldNode(line: any, nodeId: string | undefined): string | undefined {
  if (nodeId === undefined || nodeId === '') {
    return `a closing call names the node whose work ended (held: ${((line?.holding ?? []) as any[]).map((item) => short(item.id)).join('+') || 'nothing'}).`;
  }
  return undefined;
}