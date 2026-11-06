import { existsSync } from 'node:fs';
import type {
  AskPlan,
  DispatchPlan,
  NextPlan,
  NextQuery,
  NoCyclePlan,
  OpenNodePlan,
  PlanAttention,
  PlanNodeEntry,
  StopPlan,
  WaitPlan,
} from './conductor';
import { cycleHoldingIds, cyclePolicy, readStateLedger } from './cycles';
import {
  eisenhowerOrder,
  inTagScope,
  nodeReady,
  rankScores,
  short,
  tagsOf,
  type NodeMap,
} from './graph';
import { instructionInScope, isLive } from './instruct';
import { readJsonFile } from './jsonio';
import {
  launchDir,
  launchPromptPath,
  pfPaths,
  signalPath,
  startedMarkerPath,
  type PfPaths,
} from './paths';
import type { CycleRecord, InstructionRecord, NodeMode, NodeRecord } from './types';

/**
 * The planner layer: read the graph, the lines, the instructions and the dispatch pieces, and hand back "what
 * the next step is" — a plan, not one byte written.
 *
 * This module is the whole of planning, and its reading is:
 *
 * - **read-only**: it holds no lock, passes no init gate and writes not one byte. The write-side verbs
 *   (closing, claiming, landing the prompt) are not in this module; the plan only answers "who to dispatch /
 *   why it stopped / whether to ask a person".
 * - **derived values do not land**: `ready` = todo, every dependency delivered (a dangling dependency counts
 *   as delivered), and no other line holding it; `running` = a todo some line is holding right now. Both are
 *   labels computed when read; on disk there are only the three states (todo / shelved / completed) and the
 *   line's `holding`; the two things each keep a field of their own and neither explains the other.
 * - **ordering has one place**: the full ordering comes from the graph side (`dag.list`'s urgency ×
 *   importance and its tie order), and this module only deletes rows by readiness, by the line's picking range
 *   and by another line's holdings — it never rewrites the scoring.
 * - **stopping has one place**: the node's own `mode` speaks (`checkpoint` stops at the close, `manual`'s gate
 *   is inside the session, `auto` opens the next one at the close), and a boundary instruction's
 *   `stop_after_nodes` can only tighten that rule. The line's own `when_shelved` decides whether the line goes
 *   on after "this node did not deliver".
 * - **the bytes of a plan are fixed byte for byte**: the action bag's key order is construction order (the
 *   corpus compares directly against the output of `plan --json`), and the preview keeps the "mechanical steps not
 *   run yet" outside the action, leaving only one `settling` note — that is the preview rule: **when the
 *   preview is in hand, the mechanical steps are still behind it**.
 */

// ── reading the records ──────────────────────────────────────────────────────

/** A record read as a table at the top level: empty, an array or absent all read as an empty table — the read side tolerates. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function readRecord(path: string, label: string): Promise<Record<string, unknown> | null> {
  const read = await readJsonFile(path, label);
  return read.kind === 'present' ? asObject(read.value) : null;
}

/** The node table: the `nodes` table of ideas.json, where a missing `mode` means `auto` (the same default as the graph side). */
async function loadNodes(paths: PfPaths): Promise<NodeMap> {
  const data = await readRecord(paths.ideasJson, 'ideas.json');
  const table = asObject(data?.nodes);
  const nodes: NodeMap = table === null ? {} : (table as NodeMap);
  for (const node of Object.values(nodes)) {
    if (node !== null && typeof node === 'object') node.mode = normalizeMode(node.mode);
  }
  return nodes;
}

/** The line account and its rosters: the `cycles` table of state.json, read through the engine's one reading of it. */
async function loadCycles(paths: PfPaths): Promise<CycleRecord[]> {
  return (await readStateLedger(paths)).cycles;
}

/** The instruction account: the `instructions` table of instructions.json, as it is on disk; visibility is computed when read. */
async function loadInstructions(paths: PfPaths): Promise<InstructionRecord[]> {
  const data = await readRecord(paths.instructionsJson, 'instructions.json');
  const rows = data?.instructions;
  return Array.isArray(rows) ? (rows as InstructionRecord[]) : [];
}

/** One handoff ticket; absent or still `pending` both read as "no answer". */
async function loadSignal(
  paths: PfPaths,
  cycleId: string,
  nodeId: string,
): Promise<Record<string, unknown> | null> {
  return readRecord(signalPath(paths, cycleId, nodeId), `signals/${cycleId}/${nodeId}.json`);
}

/**
 * The two facts of one cell that decide a dispatch, read in one place: **the material** (is this
 * cell's prompt already landed?) and **the claim** (is a session already out for it, the `started`
 * marker?). The dispatch gate is this pair — a prompt on disk with no `started` stamp is a dispatch
 * of its own — and the plan, the real dispatch and its rehearsal all read the cell through here, so
 * the three cannot drift apart.
 */
export interface CellMaterial {
  /** The prompt this cell's dispatch hands over is already at its location. */
  readonly prompt_on_disk: boolean;
  /** This cell's `started` claim is on disk: a session is out for it, and it is not dispatchable again. */
  readonly started: boolean;
}

/**
 * One cell's state: the material and the claim above, plus the ticket as it is (`null` when absent).
 * The ticket is the plan's business — the dispatch and its rehearsal take `CellMaterial` and spend no
 * read on it.
 */
export interface CellState extends CellMaterial {
  /** The ticket on disk, as it is; `null` when it is absent (or holds something that is not a table). */
  readonly ticket: Record<string, unknown> | null;
}

/** Read one cell's material and claim (`CellMaterial`): two `exists` calls, no record read. */
export async function materialOf(
  root: string,
  cycleId: string,
  nodeId: string,
): Promise<CellMaterial> {
  const paths = pfPaths(root);
  return {
    prompt_on_disk: existsSync(launchPromptPath(paths, cycleId, nodeId)),
    started: existsSync(startedMarkerPath(paths, cycleId, nodeId)),
  };
}

/** Read one cell's state (`CellState`): the material and the claim, plus the ticket. */
export async function cellState(
  root: string,
  cycleId: string,
  nodeId: string,
): Promise<CellState> {
  return {
    ...(await materialOf(root, cycleId, nodeId)),
    ticket: await loadSignal(pfPaths(root), cycleId, nodeId),
  };
}

/**
 * The gate's answer: open, with the ticket in hand; or closed, with the one sentence saying why.
 * Handing the ticket back on the open side is the point — no caller narrows a `null` of its own.
 */
export type SettleGate =
  | { readonly ok: true; readonly ticket: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * The one gate of "is there a verdict to settle": a ticket that is absent, or one still stating
 * `pending` (the mark a re-run leaves), has said nothing — and this is also the one sentence that says
 * so. The write side folds it into its refusal (`nothing_to_settle`) and the plan folds it into a
 * `wait`; the criterion, the sentence and the reading of what an open gate carries are not written a
 * second time on either side.
 */
export function settleGate(
  cycleId: string,
  nodeId: string,
  ticket: Record<string, unknown> | null,
): SettleGate {
  if (ticket !== null && ticket.status !== 'pending') return { ok: true, ticket };
  return {
    ok: false,
    reason:
      `${short(nodeId)} has not handed in a verdict yet ` +
      `(signals/${cycleId}/${short(nodeId)}….json is absent, or still pending) -- ` +
      'there is nothing to settle',
  };
}

/** The node's own `mode`, a missing key meaning `auto`; an unrecognised word is read as it is (only the write side refuses it). */
function normalizeMode(mode: unknown): NodeMode {
  const word = typeof mode === 'string' ? mode : '';
  return (word || 'auto') as NodeMode;
}

/** The single active line by default; a named line that is not on the account hands back null. */
function findCycle(cycles: CycleRecord[], cycleId: string | null): CycleRecord | null {
  if (cycleId !== null) return cycles.find((cycle) => cycle.id === cycleId) ?? null;
  const active = cycles.filter((cycle) => cycle.status === 'active');
  return active.length === 1 ? active[0]! : null;
}

/** {node: line}: one node appears on only one line's roster at a time (the first to register keeps it). */
function nodeHolders(cycles: CycleRecord[]): Map<string, string> {
  const holders = new Map<string, string>();
  for (const cycle of cycles) {
    for (const node of cycleHoldingIds(cycle)) {
      if (!holders.has(node)) holders.set(node, String(cycle.id));
    }
  }
  return holders;
}

// ── quoting and list spellings in the body ───────────────────────────────────
// A few places in the plan's body put ids, tag lists and state words inside a sentence, and the
// spelling is part of the product: the byte-for-byte comparison requires the quotes and commas to
// match, so they are gathered in one place here.

/** The quoted spelling of one string: single quotes by default; when the string already has a single quote and no double one, double quotes are used instead. */
function pyQuote(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text
    .split('\\')
    .join('\\\\')
    .split(quote)
    .join(`\\${quote}`)
    .split('\n')
    .join('\\n')
    .split('\r')
    .join('\\r')
    .split('\t')
    .join('\\t');
  return `${quote}${escaped}${quote}`;
}

/** The spelling of a list of words (or an empty table): `['a', 'b']` / `[]`. The run doc quotes tags the same way. */
export function pyList(items: readonly string[]): string {
  return `[${items.map(pyQuote).join(', ')}]`;
}

/** One cell in a sentence: a string as it is, an absent one spelled `None`. */
function pyBare(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return 'None';
  return String(value);
}

/** The short spelling of a node id: the eight characters the plan and the run doc use to cite it (the graph layer's one spelling). */
export { short } from './graph';

// ── readiness, ordering and picking ──────────────────────────────────────────

/** One readiness candidate: id, title, mode, tags (the cells of a graph row). */
export interface ReadyRow {
  id: string;
  title: string;
  mode: NodeMode;
  tags: string[];
}

/** The group of conditions used when picking. */
interface RankOptions {
  limit?: number;
  exclude?: string | null;
  excludeMany?: readonly string[];
  assumeCompleted?: readonly string[];
  tags?: readonly string[];
}

/**
 * The ready set, ordered by the graph's ordering: the graph layer's one ready criterion (`nodeReady`)
 * with the closing moment's `assumeCompleted`, and — this is all this layer adds — the named
 * exclusions.
 *
 * The holding and the picking-range deletions are left to the three readers below, each deleting its
 * own rows: one ordering serves three uses (what can be picked, what the range keeps out, what
 * another line holds), and the ordering is computed once, from the node table already in hand.
 */
function readyRows(
  nodes: NodeMap,
  options: RankOptions = {},
): ReadyRow[] {
  const assumed = new Set((options.assumeCompleted ?? []).filter((id) => id !== ''));
  const scores = rankScores(nodes);
  const drop = new Set(options.excludeMany ?? []);
  if (options.exclude !== undefined && options.exclude !== null) drop.add(options.exclude);
  const rows: ReadyRow[] = [];
  for (const [uid, node] of Object.entries(nodes)) {
    if (drop.has(uid)) continue;
    if (!nodeReady(uid, nodes, { assumeCompleted: assumed })) continue;
    rows.push({
      id: uid,
      title: node.title ?? '',
      mode: normalizeMode(node.mode),
      tags: tagsOf(node),
    });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return eisenhowerOrder(rows.map((row) => row.id), scores).map((id) => byId.get(id)!);
}

/**
 * The ready set this line can pick right now, ordered by the graph's order.
 *
 * Four deletions, none of them touching the ordering: the readiness criteria (`nodeReady`), the named
 * exclusions, **nodes another line holds right now** (that line has it, so this one cannot pick it),
 * and this line's own picking range (which only deletes rows, never reorders). `limit` counts slots:
 * it cuts a stretch as wide as the slots this line can occupy at once (the line's own `parallel`), and
 * the graph's order still runs from the top.
 */
function rankedReady(
  nodes: NodeMap,
  cycles: CycleRecord[],
  options: RankOptions = {},
): ReadyRow[] {
  const ready = readyRows(nodes, options);
  if (ready.length === 0) return [];
  const drop = new Set(options.excludeMany ?? []);
  if (options.exclude !== undefined && options.exclude !== null) drop.add(options.exclude);
  const holders = nodeHolders(cycles);
  // A named exclusion is "the caller's own", and must not be counted as "somebody else holds it" a second time.
  const free = ready.filter((row) => drop.has(row.id) || !holders.has(row.id));
  const tags = options.tags ?? [];
  const visible = free.filter((row) => inTagScope(row.tags, tags));
  return options.limit === undefined ? visible : visible.slice(0, options.limit);
}

/**
 * How many cells this line may still pin: the line's own `parallel` minus what it holds right now.
 * A line wider than its `parallel` cap (a record edited by hand) answers 0 rather than a negative.
 */
export function freeSlots(cycle: CycleRecord): number {
  const parallel = cyclePolicy(cycle).parallel;
  const cap = typeof parallel === 'number' ? parallel : 1;
  return Math.max(cap - cycleHoldingIds(cycle).length, 0);
}

/**
 * The nodes this line should pin right now, in the graph's ordering: as many as it has **free slots**,
 * one per slot — the same reading the plan's `open_node` carries, asked of a line that may already hold
 * cells (a close that freed one slot, a line that started on a sparse graph).
 *
 * Read-only: the caller claims them (`ledger.cycles.hold`). The nodes a line already holds do not come
 * back here (the claim table drops them), and neither does a node another line holds, nor one outside
 * the line's picking range, nor one whose dependencies are not delivered.
 */
export async function pinSlots(root: string, cycle: CycleRecord): Promise<ReadyRow[]> {
  const slots = freeSlots(cycle);
  if (slots === 0) return [];
  const view = await readLedger(pfPaths(root));
  const line = view.cycles.find((row) => String(row.id) === String(cycle.id)) ?? cycle;
  const tags = Array.isArray(line.tags) ? line.tags : [];
  return rankedReady(view.nodes, view.cycles, { limit: slots, tags });
}

/** The nodes that are ready but kept outside by this line's picking range (always empty when there is no filter set). */
function tagBlockedReady(
  nodes: NodeMap,
  tags: readonly string[],
  options: RankOptions = {},
): ReadyRow[] {
  if (tags.length === 0) return [];
  const ranked = readyRows(nodes, options);
  return ranked.filter((row) => !inTagScope(row.tags, tags));
}

/** The nodes that are ready but another line holds right now: this one cannot pick them, and they should not be told as "hidden by a tag". */
function holdingReady(
  nodes: NodeMap,
  cycles: CycleRecord[],
  options: RankOptions = {},
): ReadyRow[] {
  const holders = nodeHolders(cycles);
  const ranked = readyRows(nodes, options);
  return ranked.filter((row) => holders.has(row.id));
}

/** The ready nodes the filter set keeps out, one line each: title, id, tags (as a person reads them). */
function tagBlockedLines(blocked: readonly ReadyRow[]): string[] {
  return blocked.map(
    (row) => `  - ${row.title || '(untitled)'} (${row.id}) tags=${pyList(row.tags)}`,
  );
}

/**
 * The passage for "this line has nothing left in its picking range, but the graph still has ready nodes".
 *
 * It tells the reader three things: which nodes are ready, what tags keep them out, and a command that can be
 * copied as it is to open a line for them. Stopping here **hands the choice back to a person**: one line has
 * finished its work, and whether and when another line starts is theirs to decide.
 */
function crossLineReason(tags: readonly string[], blocked: readonly ReadyRow[]): string {
  const need: string[] = [];
  for (const row of blocked) {
    for (const tag of row.tags) if (!need.includes(tag)) need.push(tag);
  }
  const head =
    `This cycle has no ready node left in its filter set ${pyList(tags)}, but the graph still ` +
    `has ${blocked.length} ready node(s), only hidden outside by their tags:`;
  const tail =
    'One line has finished its work; whether and when another line starts is yours to ' +
    'decide.\n' +
    `Open another cycle to take it: cycle start <slug> --tags ${need.join(',')}`;
  return [head, ...tagBlockedLines(blocked), tail].join('\n');
}

/**
 * The two ways of saying "this line has no node to pick".
 *
 * To the inside of the pipeline the two reasons are one thing (nothing in hand), but to a reader they are two:
 * the filter set hid the nodes, or another line is running them. Calling the second the first sends the reader
 * to look at a tag that is not in the way.
 */
function blockedReason(
  holders: Map<string, string>,
  tags: readonly string[],
  tagged: readonly ReadyRow[],
  holding: readonly ReadyRow[],
): string {
  const lines: string[] = [];
  if (tagged.length > 0) lines.push(crossLineReason(tags, tagged));
  if (holding.length > 0) {
    const holdingLines = holding.map(
      (row) =>
        `  - ${row.title || '(untitled)'} (${row.id}): cycle ` +
        `${holders.get(row.id) ?? '?'} is holding it`,
    );
    lines.push(
      'These nodes in the graph are ready, but another cycle already occupies ' +
        'them, so this line cannot pick them:\n' +
        holdingLines.join('\n') +
        '\nTo get them, wait for that line to run them out (another line being ' +
        'busy is not a fault of this line).',
    );
  }
  return lines.join('\n');
}

/** The reading of one node's graph row (the row carries the id); when it is not on the graph, an empty row with only the id. */
function nodeRow(nodes: NodeMap, nodeId: string): NodeRecord & { id: string } {
  const row = nodes[nodeId];
  return row === undefined ? ({ id: nodeId } as NodeRecord & { id: string }) : { ...row, id: nodeId };
}

// ── the stopping criteria ────────────────────────────────────────────────────

/**
 * (whether to stop, and why). **An instruction can only tighten the stopping rule, never loosen it.**
 *
 * Whether a line goes on is decided only by this node's own `mode`, and the three gates each take one
 * position: `auto` has no human confirmation point (the close opens the next one itself), `manual`'s gate is
 * inside that node's session (the whole cell is the back-and-forth with the user, and `completed` is the user's
 * "done, go on", so the closing step adds no second gate), and `checkpoint`'s gate is at the closing step
 * itself (one round runs, then it stops once, and the next one opens only when a person says continue).
 *
 * Closing this node's own run follows the same reading: `--continue` cannot pry it open, and `--stop` can only
 * tighten it further.
 */
function stopCriterion(
  instructions: readonly InstructionRecord[],
  cycle: CycleRecord,
  node: { id: string; mode?: unknown } | null,
  dagNodes: NodeMap,
  activeCycleIds: ReadonlySet<string>,
): [boolean, string] {
  const mode = normalizeMode(node?.mode);
  if (mode === 'checkpoint') {
    return [
      true,
      'node mode=checkpoint: this round is done, and the next node opens only once ' +
        'you say continue',
    ];
  }
  for (const entry of instructions) {
    if (!isLive(entry)) continue;
    if ((entry.target ?? 'stage') !== 'boundary') continue;
    if (
      !instructionInScope(
        entry,
        dagNodes,
        activeCycleIds,
        String(cycle.id),
        node === null ? null : node.id,
      )
    ) {
      continue;
    }
    const cap = entry.stop_after_nodes;
    if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 0) {
      // "stop after N nodes": this close is the N-th — by now all N are delivered.
      const done = (Array.isArray(cycle.path) ? cycle.path.length : 0) + 1;
      if (done >= cap) {
        return [true, `instruction "${stringCellOf((entry as { text?: unknown }).text).slice(0, 40)}": stop after ${cap} nodes`];
      }
    }
  }
  return [false, ''];
}

/**
 * One cell read as a string, with "not there" reading as the empty string: a missing key and an empty
 * string mean the same thing on every read side. The one reader of such a cell — the planner's own
 * sentences, the run doc's instruction lines and the closing reason all come through it.
 */
export function stringCellOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ── the action bags ──────────────────────────────────────────────────────────
// The key order is the product: the caller serializes the JSON, and the byte-for-byte comparison requires the
// key order and the body's spelling to be identical. The preview strips the mechanical steps and keeps only
// `settling` — `settling` is always appended last, so it always ends up at the end.

/** The "stop" action bag: the reason it stopped is for a reader, and `attention` is what a person should look at on this sheet. */
function stopAction(
  nodes: NodeMap,
  cycle: CycleRecord,
  reason: string,
  options: {
    nodeId?: string | null;
    shelvedNodes?: readonly string[];
    stopLine?: boolean;
  } = {},
): StopPlan {
  const stopLine = options.stopLine ?? true;
  return {
    action: 'stop_pipeline',
    cycle: String(cycle.id),
    node_id: options.nodeId ?? null,
    reason,
    note: stopLine
      ? 'cycle parked; nothing more to do without a human'
      : 'the line stays in service: the nodes still in hand carry it on when their own closes run',
    attention: attentionItems(nodes, cycle, options.shelvedNodes ?? []),
    // There are always mechanical steps left on this path (closing the node, marking the graph, pinning the next
    // one / turning the line inactive): the preview therefore always carries settling. This tree has no plugins,
    // so the "not one command" gate (a plugin blocking the dispatch) is never reached and this cell is always
    // true.
    settling: true,
  };
}

/**
 * The loose ends a person should look at: the nodes this action is about to shelve, plus the ones already
 * shelved on the graph.
 *
 * The node just closed is still todo on disk (the command that marks the graph has not run), so it is named in
 * by the caller — otherwise the one sheet that should explain this stop the most would be the only place not
 * mentioning it. Delivered nodes **deliberately stay off this sheet**: the sheet reads as "go look at these",
 * and naming a success would send the reader off to revive work that is already done.
 */
function attentionItems(
  nodes: NodeMap,
  cycle: CycleRecord,
  shelvedNodes: readonly string[],
): PlanAttention[] {
  const shelved: string[] = [];
  for (const id of [...shelvedNodes, ...Object.keys(nodes).filter((uid) => nodes[uid]!.status === 'shelved')]) {
    if (id === '' || shelved.includes(id)) continue;
    shelved.push(id);
  }
  return shelved.map((uid) => ({
    kind: 'node_shelved' as const,
    cycle: String(cycle.id),
    node_id: uid,
    node_title: nodes[uid]?.title ?? '',
    hint:
      `dag revive ${uid} puts it back to todo (shelved → todo), or handle it by hand ` +
      'and restart the cycle',
  }));
}

/** Ask a person: the state cannot explain itself, or there is no line to push at all. */
function askAction(question: string, extra: Partial<AskPlan> = {}): AskPlan {
  return { action: 'ask_user', cycle: null, question, ...extra };
}

/** The two lines of "no line to push": none at all, and lines that exist but are none of them in service — the two cases have to read differently. */
function noLineAction(cycles: readonly CycleRecord[]): NextPlan {
  const inService = cycles.filter((cycle) => cycle.status === 'active').map((cycle) => String(cycle.id));
  if (inService.length > 1) {
    return askAction('several active cycles: continue which one?', { candidates: inService });
  }
  if (cycles.length === 0) {
    return {
      action: 'no_cycle',
      cycle: null,
      note:
        'no active cycle. Creating one needs human intent (which nodes, unattended or not); ' +
        'this planner will not invent it.',
      known_cycles: [],
    } satisfies NoCyclePlan;
  }
  const idle = cycles.map((cycle) => String(cycle.id));
  if (idle.length === 1) {
    const only = idle[0]!;
    return askAction(`no cycle is active; ${pyQuote(only)} is out of service (inactive)`, {
      requested: only,
      candidates: idle,
      known_cycles: idle,
      hint: `cycle status ${only} active`,
    });
  }
  return askAction(`no cycle is active right now; these lines are all out of service: ${pyList(idle)}`, {
    candidates: idle,
    known_cycles: idle,
    hint: 'cycle status <cycle> active',
  });
}

/** The one line handed to the session at dispatch: `/pf-conduct <node id> [pipeline]`, with nothing after it. */
export function promptTextOf(nodeId: string): string {
  return `/pf-conduct ${nodeId} [pipeline]\n`;
}

/** One node's cell in one dispatch: id, title, mode, the prompt's location and its body. */
function nodeEntry(paths: PfPaths, cycle: CycleRecord, row: ReadyRow): PlanNodeEntry {
  return {
    node_id: row.id,
    node_title: row.title,
    mode: normalizeMode(row.mode),
    prompt: launchPromptPath(paths, String(cycle.id), row.id),
    prompt_text: promptTextOf(row.id),
  };
}

/**
 * The answer when nodes are in hand and their sessions are not open yet: as many cells as the line is wide, one
 * node per cell.
 *
 * On a multi-node line every cell has its own prompt file, its own session and its own close; a single-node line
 * gets the same shape, with only one cell in `nodes`.
 */
function dispatchAction(
  paths: PfPaths,
  cycle: CycleRecord,
  nodeIds: readonly string[],
  nodes: NodeMap,
): DispatchPlan {
  const entries = nodeIds.map((nodeId) =>
    nodeEntry(paths, cycle, {
      id: nodeId,
      title: nodes[nodeId]?.title ?? '',
      mode: normalizeMode(nodes[nodeId]?.mode),
      tags: tagsOf(nodes[nodeId] ?? {}),
    }),
  );
  const head = entries[0]!;
  return {
    action: 'dispatch',
    cycle: String(cycle.id),
    node_id: head.node_id,
    node_title: head.node_title,
    nodes: entries,
    // A multi-node dispatch cannot say "which one is that prompt": the singular pair is left empty and the reader
    // goes by `nodes`.
    mode: head.mode,
    prompt: entries.length === 1 ? head.prompt : '',
    prompt_text: entries.length === 1 ? head.prompt_text : '',
    steps: [
      `write each node's prompt text to its own prompt.txt under ` +
        `${launchDir(paths, String(cycle.id))}`,
      'DSH: spawn one session per node (`dispatch <cycle>` does all of them; ' +
        '`advance --cycle <cycle>` is the one-shot spelling: pin the free slots, then dispatch)',
    ],
  };
}

/**
 * Pinning: when the line holds no node, the first few nodes the ordering picked (as many as the line is wide)
 * are handed to `apply` to pin down.
 *
 * Several ready rows are arbitrated by the ordering directly: the ordering decides unattended at every close (it
 * takes the first row), and the first pick when a line opens uses the same ordering. The line fills the slots
 * `parallel` allows — one pin per slot, in ordering order.
 */
function openAction(cycle: CycleRecord, chosen: readonly ReadyRow[]): OpenNodePlan {
  const head = chosen[0]!;
  const titles = chosen.map((row) => row.title || row.id).join(', ');
  const plan: OpenNodePlan = {
    action: 'open_node',
    cycle: String(cycle.id),
    node_id: head.id,
    node_title: head.title ?? '',
    nodes: chosen.map((row) => row.id),
    note: `the next pick is ${titles}`,
    // The claiming command has not run yet: the preview therefore says "not settled yet", and `settling` is always true.
    settling: true,
  };
  return plan;
}

/**
 * The node's work is handed back and the close has not run — that stable state.
 *
 * It always has to be a path with an exit: whoever lands here takes the closing command from `note` (and
 * `close_with`), and asking any number of times answers the same line. The step that opens the next session is
 * deliberately left outside `close_with`: closing the node and opening the next session are two steps, and the
 * session doing the work still has to commit and push first — only after the push does the next session start
 * on the same tree.
 */
function ticketWait(cycle: CycleRecord, nodeId: string, holding: readonly string[]): WaitPlan {
  const settleCommand = `settle ${nodeId}`;
  const others = holding.filter((id) => id !== nodeId);
  const tail =
    others.length > 0
      ? ` (still holding ${others.map(short).join(', ')}, their notes are collected as they ` +
        'arrive)'
      : '';
  return {
    action: 'wait',
    cycle: String(cycle.id),
    node_id: nodeId,
    close_with: settleCommand,
    note:
      `The note for ${short(nodeId)} is already on disk, but this node has not been closed ` +
      'out yet -- do not poll, and do not move the state yourself. ' +
      `Closing it out is one command: ${settleCommand} (the tool reads this node's note, ` +
      'records it in the line and on the graph, and runs the close-time plugin seam; it pins ' +
      'nothing and opens nothing).' +
      `${tail} The next session comes after this run's commit and push: ` +
      `\`advance --cycle ${cycle.id}\` pins the free slots and dispatches them (the host ` +
      'does that by itself when it runs this line).',
  };
}

/** Every cell in hand already has its session open: there is nothing to dispatch, so wait for their tickets — never poll. */
function sessionsWait(cycle: CycleRecord, nodeIds: readonly string[], holding: readonly string[]): WaitPlan {
  const others = holding.filter((id) => !nodeIds.includes(id));
  const tail =
    others.length > 0
      ? ` (still holding ${others.map(short).join(', ')}, they keep running)`
      : '';
  const names = nodeIds.map(short).join(', ');
  return {
    action: 'wait',
    cycle: String(cycle.id),
    node_id: nodeIds[0]!,
    note:
      `${names}: their sessions are already open (the \`started\` stamp is on disk) -- ` +
      'there is nothing to dispatch, so wait for their notes and never poll. ' +
      `Their own closes: settle <node id>.${tail}`,
  };
}

/** A ticket still `pending` is a blocker: wait, and name the commands that unwind it. */
function retryWait(cycle: CycleRecord, nodeId: string, holding: readonly string[]): WaitPlan {
  const others = holding.filter((id) => id !== nodeId);
  const tail =
    others.length > 0
      ? ` (still holding ${others.map(short).join(', ')}, they keep running)`
      : '';
  return {
    action: 'wait',
    cycle: String(cycle.id),
    node_id: nodeId,
    note:
      `The note for ${short(nodeId)} is still pending (no verdict yet, or somebody ` +
      'cleared the note to retry); do not poll. Three commands unwind it: ' +
      `cycle retry ${cycle.id} ${nodeId} --drop --summary "retry", then ` +
      `hold ${nodeId} --cycle ${cycle.id}, then dispatch ${cycle.id}.` +
      `${tail}`,
  };
}

// ── planning ─────────────────────────────────────────────────────────────────

/** One whole reading that planning uses: what was read from disk, handed once to the judgements below to share. */
interface LedgerView {
  nodes: NodeMap;
  cycles: CycleRecord[];
  instructions: InstructionRecord[];
}

/** Read the three records on disk in one go (graph, lines, instructions; tickets are read per node when needed). */
async function readLedger(paths: PfPaths): Promise<LedgerView> {
  return {
    nodes: await loadNodes(paths),
    cycles: await loadCycles(paths),
    instructions: await loadInstructions(paths),
  };
}

/**
 * When the line holds no node: name the next one (or several), or stop at a place whose reason can be read.
 *
 * The ordering decides unattended at every close, so a line's first pick and its slot-filling use the same rows;
 * nodes kept out by the range and nodes another line holds each state their own reason (see `blockedReason`).
 */
async function pickNext(cycle: CycleRecord, view: LedgerView): Promise<NextPlan> {
  const tags = Array.isArray(cycle.tags) ? cycle.tags : [];
  const parallel = cyclePolicy(cycle).parallel;
  const slots = typeof parallel === 'number' ? parallel : 1;
  const ready = rankedReady(view.nodes, view.cycles, { limit: slots, tags });
  if (ready.length > 0) return openAction(cycle, ready);
  const holders = nodeHolders(view.cycles);
  const tagged = tagBlockedReady(view.nodes, tags);
  const holding = holdingReady(view.nodes, view.cycles);
  if (tagged.length > 0 || holding.length > 0) {
    return stopAction(view.nodes, cycle, blockedReason(holders, tags, tagged, holding));
  }
  return stopAction(view.nodes, cycle, 'the DAG has no ready node left');
}

/**
 * The settlement answer of one close: the verdict word, the walk-or-stop decision, the slot-filling list, and
 * whether the line should be turned out of service.
 *
 * This is the one shape of the closing criteria: the planner (`closeOwnNode` → the closing rehearsal of `next`)
 * folds it into an action bag, and the write side (`conductor.close`) folds it into mechanical steps on the
 * records — both criteria come from the same place, and neither copies the other. The fields are fixed as
 * follows:
 *
 * - `outcome` is the ticket's own verdict word (the word landing in path; a non-delivered node lands `shelved` on
 *   the graph, which is a different thing);
 * - `filled` are the nodes the slots opened by this close were filled with (the precondition for filling: it was
 *   delivered, or the line's `when_shelved=continue` lets the line carry on);
 * - `parkLine` is "whether this close should turn the line inactive": only a decided stop, with no other node in
 *   flight in hand, parks it — other nodes are still held, and the relay is on their own closes;
 * - when the line is not in service only the recording happens: `decision` tightens to stop, no slot is filled
 *   and `parkLine` is always false — not one character of the line's status is written, that is a person's
 *   business.
 */
export interface CloseSettlement {
  readonly cycleId: string;
  readonly nodeId: string;
  /** The ticket's verdict word: completed / failed / stopped (the word landing in path). */
  readonly outcome: 'completed' | 'failed' | 'stopped';
  /** Whether it was delivered (every verdict other than `completed` is not a delivery). */
  readonly delivered: boolean;
  /** The decision of this close: carry on (fill the slot) or stop. */
  readonly decision: 'continue' | 'stop';
  /** The slot-filling list: the nodes the ordering picked after this close opened its slots. */
  readonly filled: ReadonlyArray<{ id: string; title: string }>;
  /** Whether the line should be turned out of service (inactive). */
  readonly parkLine: boolean;
  /** The reason sentence for stopping (filled only in the stopping case). */
  readonly reason: string;
}

/**
 * The settlement criteria of one close: read the graph and the instructions, and hand back "what the verdict
 * becomes, carry on or stop, who gets the slot, whether the line parks". The one set of criteria the read side
 * and the write side share (see `CloseSettlement`); not one byte is written here.
 *
 * `signal` is the ticket already read (a missing or still `pending` ticket never reaches here — that is the
 * caller's blocker: the plan answers wait and `conductor.settle` refuses). The criteria answer on their own:
 * what the close decides is the line's own state (`mode`, `when_shelved`, instructions), never a flag a
 * caller carried in — a person who wants the line stopped stops it (the line's status), and one who wants a
 * particular node next claims it (`ledger.cycles.hold`).
 */
export async function settleClose(
  root: string,
  cycle: CycleRecord,
  nodeId: string,
  signal: Record<string, unknown>,
): Promise<CloseSettlement> {
  const view = await readLedger(pfPaths(root));
  return settleAnswers(cycle, nodeId, signal, cycle.status === 'active', view);
}

/**
 * The body of the settlement criteria: the deciding block exists only here — `closeOwnNode` folds it into an
 * action bag (the closing rehearsal of the plan), `conductor.settle` folds it into mechanical steps on the
 * records, and neither side copies a second one.
 */
async function settleAnswers(
  cycle: CycleRecord,
  nodeId: string,
  signal: Record<string, unknown>,
  lineActive: boolean,
  view: LedgerView,
): Promise<CloseSettlement> {
  const nodes = view.nodes;
  const delivered = signal.status === 'completed';
  const policy = cyclePolicy(cycle);
  // A non-delivered node is always shelved; whether the line goes on is decided separately by the line's own
  // `when_shelved` (stop by default).
  const policyCarries = policy.when_shelved === 'continue';
  let carryOn = delivered || policyCarries;
  const others = cycleHoldingIds(cycle).filter((id) => id !== nodeId);
  if (!lineActive) carryOn = false;
  let decision: 'continue' | 'stop' = carryOn ? 'continue' : 'stop';
  const tags = Array.isArray(cycle.tags) ? cycle.tags : [];
  // How many slots this close can open, and whether the line takes one at a time or several: the line's own
  // `parallel` minus what is still in hand.
  const parallelRaw = policy.parallel;
  const parallel = typeof parallelRaw === 'number' ? parallelRaw : 1;
  const slots = Math.max(parallel - others.length, 0);
  const several = parallel > 1;
  // The closing command has not run yet and this node is still todo on the graph. Only by reading "delivered" in
  // can the downstream it just unlocked be asked about — excluding it would only hide those nodes, and the slots
  // would not fill with the ones just released.
  const assumed = delivered ? [nodeId] : [];

  // ── filling the slots: one node per empty slot ────────────────────────────
  let filled: ReadyRow[] = [];
  if (carryOn && decision === 'continue' && slots > 0) {
    filled = rankedReady(nodes, view.cycles, {
      limit: slots,
      exclude: nodeId,
      excludeMany: others,
      assumeCompleted: assumed,
      tags,
    });
  }

  // ── the stopping criteria: the gates are exactly the two numbers above ────
  const activeCycleIds = new Set(
    view.cycles.filter((row) => row.status === 'active').map((row) => String(row.id)),
  );
  let stopWhy = '';
  if (carryOn && (!several || filled.length === 0)) {
    // On a single-node line its close is its whole round: whatever follows on the graph goes through this gate
    // too. A multi-node line only asks when no slot could be filled: a slot that can be filled carries the line
    // on by itself.
    const [mustStop, why] = stopCriterion(
      view.instructions,
      cycle,
      nodeRow(nodes, nodeId),
      nodes,
      activeCycleIds,
    );
    if (mustStop) {
      decision = 'stop';
      stopWhy = why;
    }
  }

  const outcome = delivered
    ? 'completed'
    : (String(signal.status ?? 'failed') as CloseSettlement['outcome']);

  if (!lineActive) {
    let reason =
      `cycle ${pyQuote(String(cycle.id))} is not active (${pyBare(cycle.status)}): a close on this ` +
      `line only records -- it closes ${short(nodeId)} and marks the DAG, picks no next ` +
      'node and dispatches nothing; the line keeps the status it was given.';
    reason += ` To carry on: cycle status ${cycle.id} active`;
    // The line is not in service: only the recording happens. Not one character of the line's status is written
    // (parkLine=false) and no slot is filled either.
    return {
      cycleId: String(cycle.id),
      nodeId,
      outcome,
      delivered,
      decision: 'stop',
      filled: [],
      parkLine: false,
      reason,
    };
  }

  if (decision === 'stop' || filled.length === 0) {
    // A line with other nodes still in flight does not count as stopped: those nodes are still held and the relay
    // is on their own closes — turning the line inactive would make their closes recording-only, and the work they
    // release would have nobody to take it.
    const parkLine = decision === 'stop' || others.length === 0;
    const openNotes =
      decision === 'stop' && others.length > 0
        ? ` (still holding ${others.map(short).join(', ')}, their notes are ` +
          'collected as they arrive)'
        : '';
    let reason: string;
    if (!delivered && !policyCarries) {
      const slipped = stringCellOf(signal.summary) || '(no reason written)';
      reason = `this node did not deliver (${outcome}): ${slipped}`;
    } else if (stopWhy !== '') {
      reason = stopWhy;
      // The middle mode stops in order to wait for a person to say "continue": stopping turns the line out of
      // service, so both commands are handed out together (put it back in service, then go on) — otherwise that
      // "continue" would still have to be guessed at.
      if (normalizeMode(nodes[nodeId]?.mode) === 'checkpoint') {
        reason +=
          `; to carry on: cycle status ${cycle.id} active, ` +
          `then advance --cycle ${cycle.id}`;
      }
    } else if (filled.length === 0 && carryOn) {
      // Not one slot filled: this line still has work (the relay is on those closes), or the graph really has
      // nothing to pick — the two have to be told apart.
      if (others.length > 0) {
        reason =
          `${short(nodeId)} is closed; still holding ${others.map(short).join(', ')}, their ` +
          'notes are collected as they arrive (settle <node id>) -- ' +
          'this line stays in service, and on its own close that slot fills and ' +
          'advances.';
      } else {
        // On a single-node line the node delivered by this close is this node: the downstream it just unlocked is
        // the work the reader is looking for. A multi-node close reads the graph as it is on disk at this moment.
        const assumedForBlocked = several ? [] : assumed;
        const tagged = tagBlockedReady(nodes, tags, {
          exclude: nodeId,
          excludeMany: others,
          assumeCompleted: assumedForBlocked,
        });
        const holding = holdingReady(nodes, view.cycles, {
          exclude: nodeId,
          excludeMany: others,
          assumeCompleted: assumedForBlocked,
        });
        if (tagged.length > 0 || holding.length > 0) {
          reason = blockedReason(nodeHolders(view.cycles), tags, tagged, holding);
        } else {
          reason = 'the graph has no ready node left';
        }
      }
    } else {
      reason = 'stopping at the close';
    }
    if (openNotes !== '') reason += openNotes;
    return {
      cycleId: String(cycle.id),
      nodeId,
      outcome,
      delivered,
      decision: 'stop',
      filled: [],
      parkLine,
      reason,
    };
  }

  // ── the slots are filled: the whole list is handed out together, one pin per cell ──
  return {
    cycleId: String(cycle.id),
    nodeId,
    outcome,
    delivered,
    decision: 'continue',
    filled: filled.map((row) => ({ id: row.id, title: row.title })),
    parkLine: false,
    reason: '',
  };
}

/**
 * The plan of a session closing its own node: record this step and fill the released slots, or stop.
 *
 * The questions every close asks — was it delivered, can the line carry on, who gets the released slots, why it
 * stopped — all have their criteria in one place, `settleAnswers`; this only folds them into an action bag, and
 * the closing rehearsal (`next` with `after`) and the write side share the same answer, neither copying the other.
 */
async function closeOwnNode(
  cycle: CycleRecord,
  nodeId: string,
  signal: Record<string, unknown>,
  lineActive: boolean,
  view: LedgerView,
): Promise<NextPlan> {
  const settle = await settleAnswers(cycle, nodeId, signal, lineActive, view);
  const nodes = view.nodes;
  const parallelRaw = cyclePolicy(cycle).parallel;
  const several = (typeof parallelRaw === 'number' ? parallelRaw : 1) > 1;
  if (settle.decision === 'stop' || settle.filled.length === 0) {
    return stopAction(nodes, cycle, settle.reason, {
      nodeId,
      shelvedNodes: settle.delivered ? [] : [nodeId],
      stopLine: lineActive ? settle.parkLine : undefined,
    });
  }
  const head = settle.filled[0]!;
  const opening = several
    ? settle.filled.map((row) => row.title || row.id).join(', ')
    : head.title ?? '';
  return {
    action: 'open_node',
    cycle: String(cycle.id),
    node_id: head.id,
    node_title: head.title ?? '',
    ...(several ? { nodes: settle.filled.map((row) => row.id) } : {}),
    note: `${short(nodeId)} closed; opening ${opening}`,
    follow: {
      action: 'dispatch' as const,
      cycle: String(cycle.id),
      node_id: head.id,
      node_title: head.title ?? '',
    },
    settling: true as const,
  };
}

/**
 * The one entry of planning: read the records and hand back "what the next step is", writing not one byte.
 *
 * Two entries, two things:
 * - without `after`: the reading that drives the next step — with a node in hand, dispatch it / wait for its
 *   ticket; with an empty hand, pick the next one off the graph, and if nothing can be picked, say clearly why it
 *   stopped.
 * - with `after`: **the closing rehearsal** — that node's work is already handed back (its ticket is on disk), and
 *   settling on it, where would this line go. This is only computation; settling and dispatching still belong to
 *   the write side (`conductor.close` / `conductor.dispatch`).
 *
 * Both paths answer with the same action bag (the closing rehearsal goes through another read-only pure function,
 * and the caller is the one hooking it onto the closing action).
 */
export async function planNext(root: string, query: NextQuery = {}): Promise<NextPlan> {
  const paths = pfPaths(root);
  const view = await readLedger(paths);
  const requested = query.cycle ?? null;
  const cycle = findCycle(view.cycles, requested);
  if (cycle === null) {
    if (requested !== null) {
      return askAction(
        `no cycle named ${pyQuote(requested)}; known cycles: ` +
          `${pyList(view.cycles.map((row) => String(row.id)))}`,
        { requested },
      );
    }
    return noLineAction(view.cycles);
  }

  const selfVerified = query.after !== undefined && query.after !== null;
  if (cycle.status !== 'active' && !selfVerified) {
    return askAction(
      `cycle ${pyQuote(String(cycle.id))} exists but is not active (${pyBare(cycle.status)})`,
      {
        requested: String(cycle.id),
        candidates: [String(cycle.id)],
        hint: `cycle status ${cycle.id} active`,
      },
    );
  }

  const holding = cycleHoldingIds(cycle);

  // Nothing in hand: the line just opened, or everything it held is settled. Both cases ask the same question, and
  // the answer follows the same rule.
  if (holding.length === 0) return pickNext(cycle, view);

  if (selfVerified) {
    // A session's own close: settle the node that has already written its ticket. The other nodes the same line
    // holds stay in hand — each is settled by its own close.
    const closing = query.after ?? (holding.length === 1 ? holding[0]! : null);
    if (closing === null || !holding.includes(closing)) {
      return {
        action: 'wait',
        cycle: String(cycle.id),
        note:
          `${closing === null ? '(unnamed)' : short(closing)} is not in the hand of ` +
          `${cycle.id} (it is holding ${holding.map(short).join(', ')}) -- ` +
          'there is nothing to settle.',
      };
    }
    const cell = await cellState(root, String(cycle.id), closing);
    // A session's own close **is** the "close me" request, so a ticket that already states a result is enough:
    // `completed` and `failed` / `stopped` all have said their piece, and whichever it is does not stand in the way
    // of settling. Only a missing or still `pending` ticket is left to wait — the same gate, and the same
    // sentence, the write side refuses with.
    const gate = settleGate(String(cycle.id), closing, cell.ticket);
    if (!gate.ok) {
      return {
        action: 'wait',
        cycle: String(cycle.id),
        node_id: closing,
        note: `${gate.reason}.`,
      };
    }
    return closeOwnNode(cycle, closing, gate.ticket, cycle.status === 'active', view);
  }

  // Every node in hand already has a ticket in a terminal state: this batch is over, and the close is what consumes
  // them (one at a time, always that stable state). A node whose ticket is not written yet is a dispatch target (the
  // session that writes the ticket is already running); a `pending` ticket is the re-run case, with nothing to open.
  const cells = new Map<string, CellState>();
  for (const nodeId of holding) cells.set(nodeId, await cellState(root, String(cycle.id), nodeId));
  const terminal = holding.filter((nodeId) => {
    const status = cells.get(nodeId)!.ticket?.status;
    return status !== undefined && status !== null && status !== 'pending';
  });
  if (terminal.length > 0) return ticketWait(cycle, terminal[0]!, holding);
  const fresh = holding.filter((nodeId) => cells.get(nodeId)!.ticket === null);
  const waiting = fresh.filter((nodeId) => !cells.get(nodeId)!.started);
  if (waiting.length > 0) {
    return dispatchAction(paths, cycle, waiting, view.nodes);
  }
  if (fresh.length > 0) return sessionsWait(cycle, fresh, holding);
  return retryWait(cycle, holding[0]!, holding);
}