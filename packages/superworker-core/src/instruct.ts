import { cycleHoldingIds, readStateLedger } from './cycles';
import { readJsonFile } from './jsonio';
import { recordPaths, type RecordPaths } from './paths';
import type { CycleRecord, InstructionRecord, InstructionScope, NodeRecord } from './types';

/**
 * The engine's read side of the instruction record: who can see which entry, and from where.
 *
 * The record itself belongs to the `instruction` plugin now (`plugins/instruction/tools/storage.mjs`):
 * that folder writes `instructions.json` under its own lock, and its five verbs are the command
 * surface. The engine keeps this module because two of its own readings need the same visibility
 * decision — dispatch preparation renders the entries in force from a node's position, and the
 * planner reads a boundary entry's `stop_after_nodes` when it decides when a line stops. Both are
 * reads: nothing here writes a byte, takes a lock or asks the init gate, and a never-laid-down
 * account reads as an empty one.
 *
 * The decision itself is pure derivation: an entry is in scope only while it is live and its binding
 * has not lapsed (the bound line is still active, the bound node is not completed). The scope
 * decision is never landed on disk — when a line leaves service or a node is delivered, the entries
 * bound to them drop out of the reading by themselves, with no "change the state when the time comes"
 * write of any kind. The direction of the reading: global is visible everywhere; a bound cycle / node
 * is compared exactly against where the reader stands (when the position can be given), and without
 * a position it falls back to a wide read — the bound line is still active, the bound node is not
 * completed, so it counts as visible. An unrecognised scope word and an empty binding both read
 * towards "visible": missing a real constraint costs far more than reading one row too many.
 */

/**
 * The scopes an entry can bind to, in the order the record's own vocabulary lists them. The plugin's
 * command surface holds its own copy of this list (it has to: a plugin folder imports nothing from
 * the engine), and the pairing test (`tests/plugin-instruction-verbs.test.ts`) is what keeps the two
 * from drifting apart. The vocabulary itself, like every record's, is frozen in `types.ts`.
 */
export const SCOPES: readonly InstructionScope[] = ['global', 'cycle', 'node'];

/** An old entry missing the state key reads as this word; `live` is the only state word that is read. */
const LIVE_STATE = 'live';

// ── reading the instruction account ──────────────────────────────────────────

/** Whether this counts as live: `live` is the only word read, and an old entry missing the state also reads as it. */
export function isLive(entry: InstructionRecord): boolean {
  return (entry.state ?? LIVE_STATE) === LIVE_STATE;
}

/** The scope of an entry: a word outside the vocabulary (or a missing key) reads as global — erring towards "visible". */
export function entryScope(entry: InstructionRecord): InstructionScope {
  const scope = entry.scope;
  return SCOPES.includes(scope) ? scope : 'global';
}

/** What the scope is measured against: `('node', id)` / `('cycle', id)` / an empty binding. An empty binding has nothing to measure against, so it is visible everywhere. */
export function scopeBinding(entry: InstructionRecord): ['node' | 'cycle' | null, string | null] {
  const scope = entryScope(entry);
  if (scope === 'node' && entry.node) return ['node', entry.node];
  if (scope === 'cycle' && entry.cycle) return ['cycle', entry.cycle];
  return [null, null];
}

/**
 * The visibility decision (a pure function, THE one): whether this entry is visible from where the
 * reader stands.
 *
 * `readerCycle` / `readerNode` are the reader's position (line and node; null when it cannot be
 * given). With a position, the comparison is exact against the binding — an entry bound to another
 * node is not read onto this node; without a position it falls back to a wide read: the bound line is
 * still active, the bound node is not completed, so it counts as visible. global (and every entry
 * with nothing to measure against) is visible everywhere.
 */
export function instructionInScope(
  entry: InstructionRecord,
  nodes: Record<string, NodeRecord>,
  activeCycleIds: ReadonlySet<string>,
  readerCycle: string | null,
  readerNode: string | null,
): boolean {
  const [kind, bound] = scopeBinding(entry);
  if (kind === 'node') {
    if (readerNode !== null) return bound === readerNode;
    // Wide read: a bound node that is not delivered is in scope; a node missing from the graph (an old
    // entry merged in by hand) counts as not delivered too.
    return nodes[bound!]?.status !== 'completed';
  }
  if (kind === 'cycle') {
    if (readerCycle !== null) return bound === readerCycle;
    return activeCycleIds.has(bound!);
  }
  return true;
}

/**
 * Where the reader stands: `(line, node)`, both halves null when it cannot be given.
 * With one line active, that line is it; with two lines side by side it is pinned by the node named
 * (only a single active line that holds that node counts as pinned). The node half: a named node
 * counts as named (a node the line holds does not stand in for it); without a name the first node
 * the line holds is taken.
 */
function positionOf(
  cycles: CycleRecord[],
  namedNode: string | null,
): { cycle: string | null; node: string | null } {
  const active = cycles.filter((record) => record.status === 'active');
  let cycle: CycleRecord | undefined;
  if (active.length === 1) {
    cycle = active[0];
  } else if (namedNode !== null) {
    const hits = active.filter((record) => cycleHoldingIds(record).includes(namedNode));
    if (hits.length !== 1) return { cycle: null, node: null };
    cycle = hits[0]!;
  } else {
    return { cycle: null, node: null };
  }
  const cycleId = typeof cycle!.id === 'string' ? cycle!.id : null;
  if (cycleId === null) return { cycle: null, node: null };
  if (namedNode !== null) return { cycle: cycleId, node: namedNode };
  const holding = cycleHoldingIds(cycle);
  return { cycle: cycleId, node: holding.length > 0 ? holding[0]! : null };
}

/** The account's entries as they are on disk; an absent or shapeless document reads as none. */
async function readInstructionsAt(paths: RecordPaths): Promise<InstructionRecord[]> {
  const read = await readJsonFile(paths.instructionsJson, 'instructions.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  return Array.isArray(data.instructions) ? (data.instructions as InstructionRecord[]) : [];
}

/**
 * Read-only view of the line account: deciding visibility needs "is the line active, who does it
 * hold", and not one byte is written. The table comes from the engine's one reading of `state.json`
 * (`readStateLedger`), so entries that are not line records are dropped in one place.
 */
async function readStateCyclesAt(paths: RecordPaths): Promise<CycleRecord[]> {
  return (await readStateLedger(paths)).cycles;
}

/** Read-only view of the graph: visibility needs the statuses of the nodes entries are bound to. */
async function readNodesAt(paths: RecordPaths): Promise<Record<string, NodeRecord>> {
  const read = await readJsonFile(paths.ideasJson, 'ideas.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  const nodes = data.nodes;
  return nodes !== null && typeof nodes === 'object' && !Array.isArray(nodes)
    ? (nodes as Record<string, NodeRecord>)
    : {};
}

/**
 * The entries visible from where the reader stands, as the raw rows and in account order.
 *
 * This is the one visibility computation (see `instructionInScope`): dispatch preparation renders
 * these rows, and the planner reads the boundary cap off them. Reading holds no lock and asks no
 * gate. `node` names where the reader stands; without it the position is whatever the line account
 * says (one active line, the first node it holds).
 */
export async function visibleInstructionRows(
  root: string,
  filter: { node?: string } = {},
): Promise<InstructionRecord[]> {
  const paths = recordPaths(root);
  const entries = await readInstructionsAt(paths);
  const cycles = await readStateCyclesAt(paths);
  const position = positionOf(cycles, filter.node ?? null);
  const nodes = await readNodesAt(paths);
  const active = new Set(
    cycles
      .filter((record) => record.status === 'active')
      .map((record) => record.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  return entries
    .filter((entry) => isLive(entry))
    .filter((entry) => instructionInScope(entry, nodes, active, position.cycle, position.node));
}