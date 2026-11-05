/**
 * The two verbs that carry a line forward: `next` (the composed one: plan, settle, pin, land the
 * material, open the session) and `dispatch` (start the sessions of the nodes the line holds).
 *
 * `next` is not a forwarding row. The engine's `conductor.next` is a **read-only plan**; carrying the
 * step out is `conductor.closeWith` (a settle), `ledger.cycles.hold` (a pin), `conductor.prepare` (the
 * prompt and the run doc, no session) and `conductor.dispatch` (a session). This file is the one place
 * those are composed in that order, so a caller reads one line's answer for one command.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { handleOf, messageOf, projectRootOf, pyScalar, refuse, short, pyIndented } from './out';
import type { VerbCall, WordsIO } from './types';

/**
 * One plan as the caller reads it: the action, then every cell a
 * reader has to act on. Key order is that reading's order, not the bag's.
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
  for (const key of ['why', 'before_node']) {
    const value = action[key];
    if (value === undefined || value === null || value === '') continue;
    lines.push(
      key === 'why'
        ? `${'why:'.padEnd(9)} ${value}`
        : `${'after:'.padEnd(9)} ${action.before_title ?? ''}  (${value})`,
    );
  }
  if ('applied' in action) lines.push(`applied: ${pyScalar(action.applied)}`);
  if (action.spawn_error !== undefined) lines.push(`spawn_error: ${action.spawn_error}`);
  for (const extra of ((action.insertions ?? []) as any[]).slice(1)) {
    lines.push(`node:   ${extra.title ?? ''}  (${extra.node_id ?? extra.spec_path ?? ''})`);
    if (extra.spec_path !== undefined) lines.push(`spec:   ${extra.spec_path}`);
    for (const step of (extra.steps ?? []) as any[]) lines.push(`  - ${step}`);
  }
  for (const item of (action.attention ?? []) as any[]) {
    const who = item.node_id ? `${item.node_title} (${item.node_id})` : '?';
    lines.push(`attention: ${item.kind}  ${who}`);
    if (item.hint) lines.push(`           ${item.hint}`);
  }
  return lines.join('\n');
}

/** The node ids on the graph right now: the proof that a close inserted something. */
async function graphIds(pf: Awaited<ReturnType<typeof handleOf>>) {
  const rows = await pf.ledger.dag.list({});
  return new Set(rows.map((row) => row.id));
}

/**
 * The insertion one close made, if it made one: the nodes that were not on the graph before the
 * settle and are on it after it. Their ids are the only thing that has to be read; everything else a
 * reader needs (title, tags, where the spec landed) is read off those nodes. The plugin's own `why`
 * sentence is not among them — the engine keeps no copy of an offer once it has landed, so this
 * action carries the shape and the provable cells, and not one word the plugin did not hand back.
 */
async function insertionAction(
  pf: Awaited<ReturnType<typeof handleOf>>,
  cycleId: string,
  closedNode: string,
  before: Set<string>,
  after: Set<string>,
  heldNow: string | undefined,
): Promise<Record<string, any> | null> {
  const fresh = [...after].filter((id) => !before.has(id));
  if (fresh.length === 0) return null;
  const insertions: Record<string, any>[] = [];
  for (const id of fresh) {
    const info = await pf.ledger.dag.info(id);
    // The detail reading has no tag cell: the record itself is where the tags landed, and they are the
    // node's own (the plugin's tag included), so they are read off `dag.get` rather than assumed empty.
    const record = await pf.ledger.dag.get(id);
    const spec = await pf.ledger.dag.specPath(id);
    const specPosix = spec.split('\\').join('/');
    const steps = [
      `insert a node with the generated spec (${specPosix}), behind ${closedNode}`,
      'no session was opened and the inserted node is not pinned: the next dispatch picks it by the usual ranking',
    ];
    const cell: Record<string, any> = {
      title: info.title,
      tags: record?.tags ?? [],
      spec_path: specPosix,
      fields: {},
      note: `a node was put into the graph by this close (${short(closedNode)}); nothing was opened and it is not pinned`,
      steps,
    };
    if (heldNow !== undefined) {
      const pinned = await pf.ledger.dag.info(heldNow);
      cell.before_node = heldNow;
      cell.before_title = pinned.title;
    }
    cell.node_id = id;
    insertions.push(cell);
  }
  const first = insertions[0]!;
  const action: Record<string, any> = { action: 'insert_node', cycle: cycleId };
  action.node_id = first.node_id;
  action.node_title = first.title;
  action.note = first.note;
  action.steps = first.steps;
  action.spec = first.spec_path;
  action.insertions = insertions;
  return action;
}

/** Print one plan: the JSON spelling when asked for, else the lines. */
function printAction(action: Record<string, any>, asJson: boolean) {
  return { stdout: asJson ? pyIndented(action) : actionText(action) };
}

/** The cycle that holds one node, when exactly one does; the refusal sentence otherwise. */
async function holderOf(
  _pf: Awaited<ReturnType<typeof handleOf>>,
  nodeId: string,
  known: readonly any[],
): Promise<{ cycle?: any; refusal?: string }> {
  const holders = known.filter((cycle) =>
    ((Array.isArray(cycle.holding) ? cycle.holding : []) as any[]).some((item) => item.id === nodeId),
  );
  if (holders.length === 1) return { cycle: holders[0] };
  if (holders.length > 1) {
    return {
      refusal: `--after ${nodeId} is the node of several cycles (${holders.map((cycle) => cycle.id).join(', ')}); name it with --cycle.`,
    };
  }
  const closed = known.filter((cycle) =>
    ((cycle.path ?? []) as any[]).some((step) => step.node === nodeId),
  );
  if (closed.length > 0) {
    return {
      refusal: `--after ${nodeId} is already closed on ${closed.map((cycle) => cycle.id).join(', ')}; there is nothing left to settle. Reopen it, or start a new cycle.`,
    };
  }
  return {
    refusal:
      `--after ${nodeId} does not name a node any cycle is holding. Every cycle holds ` +
      `${known.map((cycle) => `${cycle.id}:${((cycle.holding ?? []) as any[]).map((item) => item.id).join(', ') || '(none)'}`).join('; ') || 'none'}.`,
  };
}

/** `pf next`: read the plan, carry it out (settle → pin, then the session), then print what is next. */
export async function nextVerb(call: VerbCall) {
  const { values, io } = call;
  const decision = values.continue === true ? 'continue' : values.stop === true ? 'stop' : undefined;
  const answersGiven =
    decision !== undefined ||
    values.node !== undefined ||
    (values.note !== undefined && values.note !== '');
  if (answersGiven && values.after === undefined && values.plan !== true) {
    return refuse(
      "--continue/--stop/--node/--note are the closing call's answers and need --after <node> " +
        '(settle that node) or --plan (preview it). Nothing was changed.',
      2,
    );
  }
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  let cycleId: string | undefined = values.cycle;
  const asJson = values.json === true;
  const planMode = values.plan === true;
  try {
    let action: Record<string, any>;
    let did: string[] = [];
    let before: Awaited<ReturnType<typeof progressOf>> | undefined;
    if (values.after !== undefined) {
      // Which line the finished node belongs to: a worker should not have to learn cycle bookkeeping,
      // so the node names its own line — unless the caller named one, which is checked below.
      const known = await pf.ledger.cycles.list();
      if (cycleId === undefined) {
        const found = await holderOf(pf, values.after, known);
        if (found.refusal !== undefined) return refuse(`${found.refusal} Nothing was changed.`, 2);
        cycleId = found.cycle.id;
      }
      const line = known.find((cycle) => cycle.id === cycleId);
      if (line === undefined) {
        return refuse(`no cycle named ${JSON.stringify(cycleId)}; nothing was changed.`, 2);
      }
      const held = (line.holding ?? []).some((item) => item.id === values.after);
      if (!held) {
        return refuse(
          `--after ${values.after} does not name a node this cycle is holding ` +
            `(${(line.holding ?? []).map((item) => short(item.id)).join('+') || 'none'} of cycle ${cycleId}). ` +
            'Nothing was changed. Name the node whose work you are closing.',
          2,
        );
      }
      // The rehearsal first: a read-only plan of what settling on this node would decide. It is what a
      // stop is reported from, and it costs no write.
      const rehearsal = await pf.conductor.next({
        cycle: cycleId,
        after: values.after,
        ...(decision === undefined ? {} : { decision }),
        ...(values.note === undefined ? {} : { note: values.note }),
        ...(values.node === undefined ? {} : { named: values.node }),
      });
      before = await progressOf(pf, cycleId);
      const grid = await graphIds(pf);
      const closed = await pf.conductor.closeWith({
        cycle: cycleId,
        node: values.after,
        ...(decision === undefined ? {} : { decision }),
        ...(values.note === undefined ? {} : { note: values.note }),
        ...(values.node === undefined ? {} : { named: values.node }),
      });
      did = [`pf: settled ${values.after} on ${cycleId}`];
      const after = await graphIds(pf);
      const pinned = (closed.holding ?? [])[0]?.id;
      const inserted = await insertionAction(pf, cycleId!, values.after, grid, after, pinned);
      if (inserted !== null) {
        const folded = applyCells(inserted, { did });
        return printAction(folded, asJson);
      }
      if (rehearsal.action === 'stop_pipeline') {
        // The settle parked the line; the rehearsal is the action that explains it. Reading the plan
        // again would answer "this line is not in service", which is the outcome rather than the news.
        const folded = applyCells(rehearsal, {
          did,
          opened: undefined,
          before,
          after: await progressOf(pf, cycleId),
        });
        return printAction(folded, asJson);
      }
      action = await pf.conductor.next({ cycle: cycleId });
      if (rehearsal.action === 'dispatch' && pinned !== undefined) {
        did.push(`pf: pinned ${pinned} on ${cycleId}`);
        const note = `${short(values.after)} closed; opening ${action.node_title ?? ''}`;
        action = { ...action, note };
      }
    } else {
      // The plan: what the line should do next. Read-only; the write side is below.
      action = await pf.conductor.next({ ...(cycleId === undefined ? {} : { cycle: cycleId }) });
      if (action.action === 'open_node' && !planMode) {
        // The line has room and nothing in hand: pin the nodes the ranking picked, then read the plan
        // again — a pin is the mechanical step behind `open_node`, and what a caller reads is the
        // slot it opens.
        const picks = action.nodes ?? (action.node_id === undefined ? [] : [action.node_id]);
        for (const id of picks) {
          await pf.ledger.cycles.hold(String(cycleId), String(id));
          did.push(`pf: pinned ${String(id)} on ${String(cycleId)}`);
        }
        action = await pf.conductor.next({ ...(cycleId === undefined ? {} : { cycle: cycleId }) });
      }
    }
    // The pinning step lands the material, never the standalone verb: the prompt each node's session is
    // started from, and this round's run doc. A preview (`--plan` without `--after`) is not executable
    // and writes nothing; every other spelling of `next` is the step that pinned the node, so the
    // material lands here — that is what makes the skill's two lines (`pf next --after <node> --json`,
    // then `pf dispatch <cycle>`) run in that order, the second one finding what the first one wrote.
    if ((planMode === false || values.after !== undefined) && action.action === 'dispatch') {
      await pf.conductor.prepare({ cycle: action.cycle });
    }
    if (values.open_sessions === true && (planMode === false || values.after !== undefined)) {
      const folded = await openPlan(root, pf, action, values.spawner, io);
      did.push(...(folded.opened_did ?? []));
      action = folded.action;
    }
    if (values.after !== undefined && action.action === 'dispatch') {
      // The note a closing call's answer carries: which node closed, and which slot this is.
      action = { ...action, note: `${short(values.after)} closed; opening ${action.node_title ?? ''}` };
    }
    const applied = applyCells(action, {
      did,
      ...(action.action === 'dispatch' && action.spawn_error === undefined ? { opened: action.node_id } : {}),
      // The progress reading is the stopping action's: it says what the line held and where it went.
      ...(action.action !== 'stop_pipeline' || before === undefined
        ? {}
        : { before, after: await progressOf(pf, action.cycle) }),
      ...(planMode && values.after === undefined ? { preview: true } : {}),
    });
    return printAction(applied, asJson);
  } catch (error) {
    return refuse(messageOf(error), 2);
  }
}

/**
 * The bookkeeping cells an applied action carries: what the tool did on the caller's behalf. They are
 * the tool's own words — the runs are this process's calls, not a command list — and the caller reads
 * `action` and acts on that alone. Key order follows the applied shape: the action's own
 * cells, then `commands` (a dispatch carries the empty list: the mechanical steps have run), then
 * `applied`, `opened_node`, `did`, and — on a dispatch — the note that says what it opened.
 */
function applyCells(
  action: Record<string, any>,
  { did = [], opened, before, after, preview = false }: {
    did?: string[];
    opened?: string;
    before?: Awaited<ReturnType<typeof progressOf>>;
    after?: Awaited<ReturnType<typeof progressOf>>;
    preview?: boolean;
  } = {},
): Record<string, any> {
  if (preview) return action;
  const dispatch = action.action === 'dispatch';
  const folded: Record<string, any> = {};
  for (const [key, value] of Object.entries(action)) {
    if (key === 'settling') continue;
    if (key === 'note' && dispatch) continue;
    folded[key] = value;
  }
  if (dispatch) folded.commands = [];
  folded.applied = true;
  if (opened !== undefined) folded.opened_node = opened;
  folded.did = did;
  if (dispatch && action.note !== undefined) folded.note = action.note;
  if (before !== undefined && after !== undefined) folded.progress = { before, after };
  return folded;
}

/** One line's standing as the closing bookkeeping reads it: what is in hand, whether a step landed, its state. */
async function progressOf(pf: Awaited<ReturnType<typeof handleOf>>, cycleId: string | undefined) {
  const line = (await pf.ledger.cycles.list()).find((cycle) => cycle.id === cycleId);
  if (line === undefined) return undefined;
  const hand: Array<[string, string | null]> = [];
  for (const item of line.holding ?? []) {
    const standing = await pf.ledger.cycles.standing(cycleId!, item.id);
    hand.push([item.id, standing.signal?.status ?? null]);
  }
  return { hand, path: (line.path ?? []).length > 0, status: line.status };
}

/** Start one session per node a dispatch plan names, and fold the receipts into the plan's print. */
async function openPlan(
  root: string,
  pf: Awaited<ReturnType<typeof handleOf>>,
  action: Record<string, any>,
  spawner: string | undefined,
  io: WordsIO,
): Promise<{ action: Record<string, any>; opened_did?: string[] }> {
  if (action.action !== 'dispatch' || (action.nodes ?? []).length === 0) {
    return { action, opened_did: [] };
  }
  // The plan still prints; the session step reports itself as not done, and not one node is claimed.
  // Handing the call to the engine is what would land the claim before a missing opener refused,
  // leaving the cell "already open" with no session behind it.
  if (io.openerAvailable !== true) {
    const folded = {
      ...action,
      spawn_error: noOpenerSentence(root, action.cycle, (action.nodes as any[]).map((item) => item.node_id)),
    };
    return { action: folded, opened_did: [] };
  }
  const opened: string[] = [];
  const skipped: string[] = [];
  const openedDid: string[] = [];
  for (const item of action.nodes) {
    const receipt = await pf.conductor.dispatch({
      cycle: action.cycle,
      node: item.node_id,
      ...(spawner === undefined ? {} : { spawner }),
    });
    if (receipt.action === 'already_open') {
      skipped.push(item.node_id);
      continue;
    }
    openedDid.push(`pf: opened a session for ${item.node_id} on ${action.cycle}`);
    opened.push(receipt.session?.sessionId ?? item.node_id);
  }
  const folded = { ...action };
  if (skipped.length > 0) folded.spawn_skipped = skipped;
  folded.spawned = opened.length > 1 ? opened : (opened[0] ?? '');
  return { action: folded, opened_did: openedDid };
}

/**
 * Where one dispatch's prompt lands and where its claim does: `<pf>/meta/launch/<cycle>/<node>/prompt.txt`
 * and `…/started`. The engine computes the same two locations when it prepares the material and claims
 * the session; these readings are the two the `dispatch` verb asks before it does anything, node by
 * node — a node whose prompt the pinning step never wrote is refused, not invented, and a node whose
 * claim is already on disk is a session that is out already, not a cell to dispatch again.
 */
function launchPromptPath(root: string, cycleId: unknown, nodeId: unknown): string {
  return join(root, '.pf', 'meta', 'launch', String(cycleId), String(nodeId), 'prompt.txt');
}

/** The claim of one dispatch: `<pf>/meta/launch/<cycle>/<node>/started`, the one "already open" evidence. */
function launchStartedPath(root: string, cycleId: unknown, nodeId: unknown): string {
  return join(root, '.pf', 'meta', 'launch', String(cycleId), String(nodeId), 'started');
}

/**
 * The sentence both open paths answer when this call has no session opener: the panel is the
 * opener on this machine, the material is already on disk, and the line in it is the instruction a
 * session works from. It names the paths and both ways a human finishes the dispatch by hand.
 */
function noOpenerSentence(root: string, cycleId: unknown, nodeIds: readonly unknown[]): string {
  const prompts = nodeIds.map((nodeId) => launchPromptPath(root, cycleId, nodeId));
  return (
    'no session can be opened from this process: the opener is the panel (寻路中心), and a command ' +
    `line carries none. The material is at ${prompts.join(', ')}; dispatch it in the panel, or start ` +
    'a new session and paste that line in.'
  );
}

/** The refusal for a node whose prompt is not on disk: where it should be, and the command that writes it. */
function noPromptRefusal(prompt: string, nodeId: string) {
  return refuse(
    `no prompt file at ${prompt}. That file is written by the step that pinned this node: usually ` +
      `the closing call (\`pf next --after ${nodeId} --json\`), and after an insertion the later ` +
      '`next` that picks the node up.',
    2,
  );
}

/**
 * The refusal when every node in hand already had its session started: one more dispatch would boot a
 * second one. This sentence is the only place that names the way back in, so the three commands are
 * carried whole — retry with `--drop`, hold again, then the one-shot opening.
 */
function alreadyStartedRefusal(cycleId: string, ids: readonly string[]) {
  return refuse(
    `every node this cycle holds already had its session started (${ids.map(short).join(', ') || '(none)'}), ` +
      'so there is nothing to dispatch: doing it again would boot a second session onto the same node. ' +
      `To reopen one, retry it the documented way: \`pf cycle retry ${cycleId} <node> --drop\`, then ` +
      `\`pf cycle hold ${cycleId} <node>\`, then \`pf next --cycle ${cycleId} --spawn --json\`.`,
    2,
  );
}

/** `pf dispatch`: start the sessions of the nodes this line holds, and nothing else. */
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
          `dispatch. \`pf cycle status ${cycleId} active\` puts it back.`,
        2,
      );
    }
    const held = (line.holding ?? []).map((item) => item.id);
    if (held.length === 0) {
      return refuse(
        `cycle "${cycleId}" is holding no node, so there is nothing to dispatch. ` +
          `\`next --cycle ${cycleId} --json\` picks the next one and writes its prompt.`,
        2,
      );
    }
    // The gate this verb asks before it opens anything is the pair of disk facts, node by node and in
    // this order. The `started` claim comes first: it is the evidence that a session is out
    // already, and a second session on the same node never pays for itself. Then the prompt file the
    // step that pinned the node wrote. A node with neither is where this verb stops, having written
    // nothing; a node with the prompt and no claim is a dispatch — the line may still be waiting on
    // that node's ticket, and the plan is not this verb's gate — so it goes to the engine below.
    const prompts: string[] = [];
    const already: string[] = [];
    for (const nodeId of held) {
      if (existsSync(launchStartedPath(root, cycleId, nodeId))) {
        already.push(nodeId);
        continue;
      }
      const prompt = launchPromptPath(root, cycleId, nodeId);
      if (!existsSync(prompt)) return noPromptRefusal(prompt, nodeId);
      prompts.push(nodeId);
    }
    if (prompts.length === 0) {
      return alreadyStartedRefusal(cycleId, already);
    }
    // The opener comes before the engine, which lands the claim and only then asks its executor: a
    // process with none would claim the cell and leave no session behind. The gate above wrote
    // nothing, so this refusal leaves the records exactly as it found them.
    if (io.openerAvailable !== true) {
      return refuse(noOpenerSentence(root, cycleId, prompts), 2);
    }
    // The material is on disk and this half only opens the session: the engine's dispatch finds the
    // landed prompt, leaves it alone and lands the claim. Nothing here writes a file.
    const opened: Array<{ node_id: string; session: string }> = [];
    let prompt: string | undefined;
    for (const nodeId of prompts) {
      const receipt = await pf.conductor.dispatch({
        cycle: cycleId,
        node: nodeId,
        ...(values.spawner === undefined ? {} : { spawner: values.spawner }),
      });
      if (receipt.action === 'already_open') {
        already.push(nodeId);
        continue;
      }
      if (prompt === undefined) prompt = receipt.prompt;
      opened.push({ node_id: nodeId, session: receipt.session?.sessionId ?? '' });
    }
    if (opened.length === 0) {
      return alreadyStartedRefusal(cycleId, already);
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
