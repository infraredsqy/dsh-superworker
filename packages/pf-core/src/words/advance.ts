/**
 * The two words that open sessions: `dispatch` (the single op: a session for a cell this line holds) and
 * `advance` (the composed one — claim, land the material, open the sessions).
 *
 * The standard flow needs neither to be composed: `plan` reads what to do, `hold` claims it, and
 * `dispatch` lands the cell's material and opens its session -- three words, one operation each, a reading
 * between the first and the second. `advance` is the same three moves as one word, for the host that drives
 * the line without a person in between; every step of it is a primitive (`ledger.cycles.hold`, the dispatch
 * preparation, `conductor.dispatch`). `dispatch` never claims a node and never settles one, which is what
 * makes "commit and push first, then open the next session" expressible as two commands.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { handleOf, messageOf, projectRootOf, pyIndented, pyList, refuse, short } from './out';
import { actionText } from './plan';
import type { VerbCall } from './types';

/** The cells one advance hands to the executor, as the receipt reads them. */
function receiptText(receipt: Record<string, any>, spawnError?: string): string {
  const lines: string[] = ['action: advance', `cycle:  ${receipt.cycle}`];
  lines.push(`pinned: ${pyList((receipt.pinned ?? []) as string[])}`);
  const opened = ((receipt.dispatches ?? []) as any[]).filter((cell) => cell.receipt?.action === 'opened');
  const skipped = ((receipt.dispatches ?? []) as any[])
    .filter((cell) => cell.receipt?.action === 'already_open')
    .map((cell) => String(cell.node_id));
  lines.push(
    `spawned: ${opened.length === 0 ? '[]' : pyList(opened.map((cell) => String(cell.receipt.session?.sessionId ?? cell.node_id)))}`,
  );
  if (skipped.length > 0) lines.push(`spawn_skipped: ${pyList(skipped)}`);
  if (spawnError !== undefined) lines.push(`spawn_error: ${spawnError}`);
  lines.push(`parked: ${receipt.parked === true ? 'yes' : 'no'}`);
  if (receipt.plan !== undefined) lines.push('', actionText(receipt.plan as Record<string, any>));
  return lines.join('\n');
}

/** `advance [--cycle <id>] [--model <route>] [--json]`: carry the line one step. */
export async function advanceVerb(call: VerbCall) {
  const { values, io } = call;
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  const asJson = values.json === true;
  const named = {
    ...(values.cycle === undefined ? {} : { cycle: values.cycle }),
    ...(values.model === undefined ? {} : { model: values.model }),
  };
  try {
    // The opener is the host half's: a process without one cannot open a session. The claim still happens
    // (a node in hand is a record, not a running session), and the material is not landed -- that is the
    // dispatch's step, and the panel (which has the opener) does it when it dispatches. What this word
    // refuses to do here is write a `started` claim with no session behind it.
    if (io.openerAvailable !== true) {
      const receipt = await pf.conductor.advance({ ...named, openSessions: false });
      const prompts = ((receipt.plan as any)?.nodes ?? []) as any[];
      const sentence = noOpenerSentence(root, receipt.cycle, prompts.map((cell) => cell.node_id));
      if (asJson) {
        return {
          stdout: pyIndented({
            action: 'advance',
            cycle: receipt.cycle,
            pinned: receipt.pinned,
            spawned: [],
            spawn_error: sentence,
            parked: receipt.parked,
            plan: receipt.plan,
          }),
        };
      }
      return { stdout: receiptText(receipt as unknown as Record<string, any>, sentence) };
    }
    const receipt = await pf.conductor.advance(named);
    if (asJson) {
      const opened = receipt.dispatches.filter((cell) => cell.receipt.action === 'opened');
      const skipped = receipt.dispatches
        .filter((cell) => cell.receipt.action === 'already_open')
        .map((cell) => cell.node_id);
      return {
        stdout: pyIndented({
          action: 'advance',
          cycle: receipt.cycle,
          pinned: receipt.pinned,
          spawned: opened.map((cell) => cell.receipt.session?.sessionId ?? cell.node_id),
          spawn_skipped: skipped,
          parked: receipt.parked,
          plan: receipt.plan,
        }),
      };
    }
    return { stdout: receiptText(receipt as unknown as Record<string, any>) };
  } catch (error) {
    return refuse(messageOf(error), 2);
  }
}

/** The sentence a process without an opener answers: no session opens here, and where the material goes. */
function noOpenerSentence(root: string, cycleId: unknown, nodeIds: readonly unknown[]): string {
  const prompts = nodeIds.map((nodeId) => launchPromptPath(root, cycleId, nodeId));
  const where = prompts.length === 0 ? 'the plan names no cell' : `the material goes to ${prompts.join(', ')}`;
  return (
    'no session can be opened from this process: the opener is the panel (寻路中心), and a command ' +
    `line carries none. ${where}; \`prepare --cycle ${String(cycleId)}\` writes it, then dispatch that ` +
    'cell in the panel, or start a new session and paste its prompt line in.'
  );
}

/** Where one dispatch's prompt lands and where its claim does: the two disk facts the `dispatch` word reads. */
function launchPromptPath(root: string, cycleId: unknown, nodeId: unknown): string {
  return join(root, '.pf', 'meta', 'launch', String(cycleId), String(nodeId), 'prompt.txt');
}

function launchStartedPath(root: string, cycleId: unknown, nodeId: unknown): string {
  return join(root, '.pf', 'meta', 'launch', String(cycleId), String(nodeId), 'started');
}

/**
 * The refusal when every node in hand already had its session started: one more dispatch would boot a
 * second one. This sentence is the only place that names the way back in, so the three commands are
 * carried whole — retry with `--drop`, hold again, then `dispatch`.
 */
function alreadyStartedRefusal(cycleId: string, ids: readonly string[]) {
  return refuse(
    `every node this cycle holds already had its session started (${ids.map(short).join(', ') || '(none)'}), ` +
      'so there is nothing to dispatch: doing it again would boot a second session onto the same node. ' +
      `To reopen one, retry it the documented way: \`cycle retry ${cycleId} <node> --drop\`, then ` +
      `\`hold <node> --cycle ${cycleId}\`, then \`dispatch ${cycleId}\`.`,
    2,
  );
}

/** `dispatch <cycle> [--model <route>] [--json]`: open the sessions of the cells this line holds. */
export async function dispatchVerb(call: VerbCall) {
  const { values, io, positionals } = call;
  const cycleId: string = positionals[0]![0]!;
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  try {
    const line = (await pf.ledger.cycles.list()).find((cycle) => cycle.id === cycleId);
    if (line === undefined) {
      return refuse(
        `no cycle named ${JSON.stringify(cycleId)} in ${root}; nothing to dispatch.`,
        2,
      );
    }
    if (line.status !== 'active') {
      return refuse(
        `cycle "${cycleId}" is '${line.status}', not active: a line that is not in service does not ` +
          `dispatch. \`cycle status ${cycleId} active\` puts it back.`,
        2,
      );
    }
    const held = (line.holding ?? []).map((item) => item.id);
    if (held.length === 0) {
      return refuse(
        `cycle "${cycleId}" is holding no node, so there is nothing to dispatch. ` +
          `\`advance --cycle ${cycleId}\` claims the next one and opens it.`,
        2,
      );
    }
    // The gate this verb asks before it opens anything is the `started` claim: that marker is the evidence a
    // session is out already, and a second session on the same node never pays for itself. Everything else the
    // dispatch needs -- its prompt, its run doc -- is the engine's preparation, landed here when it is not on
    // disk yet: a node claimed by hand (`hold`) and dispatched in the next command has no material until
    // this one writes it.
    const pending: string[] = [];
    for (const nodeId of held) {
      if (existsSync(launchStartedPath(root, cycleId, nodeId))) continue;
      pending.push(nodeId);
    }
    if (pending.length === 0) {
      return alreadyStartedRefusal(cycleId, held);
    }
    // The rehearsal: the same gates read the same cells, the engine answers each one's preview, and nothing is
    // claimed, landed or opened. A cell a plugin gate would refuse is printed with its reasons and the call leaves
    // with the same non-zero code the real refusal would; the opener is not asked for anything.
    if (values.dry_run === true) {
      const named = {
        ...(values.model === undefined ? {} : { model: values.model }),
      };
      const cells = [];
      for (const nodeId of pending) {
        cells.push(await pf.conductor.dispatchPreview({ cycle: cycleId, node: nodeId, ...named }));
      }
      const blocked = cells.some((cell) => cell.blocked.length > 0);
      if (values.json === true) {
        return {
          ...(blocked ? { code: 2 } : {}),
          stdout: pyIndented({
            action: 'dispatch',
            dry_run: true,
            cycle: cycleId,
            nodes: cells.map((cell) => cell.node_id),
            cells,
          }),
        };
      }
      const lines = ['dry run: nothing was opened, nothing was written'];
      for (const cell of cells) {
        const route = [
          cell.model === undefined ? '' : `(model ${cell.model})`,
        ].filter((part) => part !== '').join(' ');
        lines.push(
          `would open ${short(cell.node_id)}  ${JSON.stringify(cell.node_title)}` +
            `${route === '' ? '' : `  ${route}`}`,
        );
        lines.push(
          `  prompt   ${cell.prompt}  ` +
            `(${cell.material === 'on_disk' ? 'already on disk' : 'not on disk yet: the dispatch would land it'})`,
        );
        for (const reason of cell.blocked) lines.push(`  blocked  ${reason}`);
        for (const warning of cell.warnings) lines.push(warning);
      }
      if (blocked) {
        return {
          code: 2,
          stdout: lines.join('\n'),
          stderr: 'dispatch would be blocked by plugin gate(s); nothing was opened, nothing was written',
        };
      }
      return { stdout: lines.join('\n') };
    }
    // The opener comes before the engine, which lands the claim and only then asks its executor: a process
    // with none would claim the cell and leave no session behind. The gate above wrote nothing, so this
    // refusal leaves the records exactly as it found them.
    if (io.openerAvailable !== true) {
      return refuse(noOpenerSentence(root, cycleId, pending), 2);
    }
    const opened: Array<{ node_id: string; session: string }> = [];
    let prompt: string | undefined;
    for (const nodeId of pending) {
      const receipt = await pf.conductor.dispatch({
        cycle: cycleId,
        node: nodeId,
        ...(values.model === undefined ? {} : { model: values.model }),
      });
      if (receipt.action === 'already_open') continue;
      if (prompt === undefined) prompt = receipt.prompt;
      opened.push({ node_id: nodeId, session: receipt.session?.sessionId ?? '' });
    }
    if (opened.length === 0) {
      return alreadyStartedRefusal(cycleId, held);
    }
    if (values.json === true) {
      return {
        stdout: pyIndented({
          action: 'dispatch',
          cycle: cycleId,
          node_id: opened[0]!.node_id,
          prompt,
          nodes: opened.map((cell) => cell.node_id),
          spawned: opened.length > 1 ? opened.map((cell) => cell.session) : opened[0]!.session,
        }),
      };
    }
    return { stdout: opened.map((cell) => `opened ${cell.session}`).join('\n') };
  } catch (error) {
    return refuse(messageOf(error), 3);
  }
}