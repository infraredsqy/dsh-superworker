/**
 * `plan`: what the next step is, read-only.
 *
 * One word, one operation: read the records and hand back the plan. It writes not one byte, never lands a
 * prompt and never touches the state — the action that carries a plan out is `advance` (or `dispatch`, the
 * single-cell half of it). `--after <node>` asks the plan the closing question instead: the ticket of that
 * node is on disk, and settling it, where would the line go (still a reading: the rehearsal of the same
 * criteria `settle` lands).
 */
import { EXIT, pyIndented, refuse, run } from './out';
import type { VerbAnswer } from './types';
import { lineHoldingOf } from './holder';

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

/** Print one plan: the JSON spelling when asked for, else the lines. */
export function printAction(action: Record<string, any>, asJson: boolean): VerbAnswer {
  return { stdout: asJson ? pyIndented(action) : actionText(action) };
}

/** `plan`: read the plan (or the closing rehearsal), print it, write nothing. */
export const planVerb = run('plan', async (call) => {
  const { values, pf } = call;
  const asJson = values.json === true;
  let cycleId: string | undefined = values.cycle;
  if (values.after !== undefined) {
    if (cycleId === undefined) {
      const found = await lineHoldingOf(pf, values.after);
      if (found.refusal !== undefined) return refuse(`${found.refusal} Nothing was changed.`, EXIT.refused);
      cycleId = found.cycle;
    }
    const action = await pf.conductor.next({ cycle: cycleId, after: values.after });
    return printAction(action as Record<string, any>, asJson);
  }
  const action = await pf.conductor.next({
    ...(cycleId === undefined ? {} : { cycle: cycleId }),
  } as Record<string, any>);
  return printAction(action as Record<string, any>, asJson);
});
