import { nowSeconds } from './clock';
import { cycleHoldingIds } from './cycles';
import { atomicWriteJson, jsonOptionsForRecord, readJsonFile } from './jsonio';
import { assertLedgerInitialized } from './initledger';
import type {
  InstructionAddInput,
  InstructionListFilter,
  InstructionReaderRow,
  InstructionResolveOptions,
  InstructionsNamespace,
} from './ledger';
import { withLedgerLock } from './ledgerlock';
import { pfPaths, type PfPaths } from './paths';
import type {
  CycleRecord,
  InstructionRecord,
  InstructionRemovalTrace,
  InstructionScope,
  InstructionTarget,
  NodeRecord,
} from './types';

/**
 * The real implementation of the instructions namespace: register, list, resolve, revive, remove
 * (leaving a tombstone). Behaviour and on-disk bytes are fixed point by point:
 *
 * - every verb that changes instructions.json holds the record tree's lock through the whole
 *   "read → change → write"; the init gate comes before the lock (the gate sits before the lock
 *   creates any directory, so a `.pf` that was never initialised gets not one byte). Read-side
 *   verbs (list) hold no lock and ask no gate: writes are atomic, and a never-laid-down instruction
 *   account reads as an empty one.
 * - instructions.json is read and rewritten as a whole document: the instructions own only the
 *   `instructions` table, and every other top-level key (foreign sections) is carried back as it
 *   was; the `removed` tombstone table only appears on disk once something was really removed.
 *   Key order lands in the writer's construction order (no sorting); the timestamps of instruction
 *   records are always the seconds shape.
 * - visibility is pure derivation: an entry is in scope only while it is live and its binding has
 *   not lapsed (the bound line is still active, the bound node is not completed). The scope decision
 *   is not landed on disk, it is computed on every read — when a line leaves service or a node is
 *   delivered, the instructions bound to them drop out of the reading by themselves, with no
 *   "change the state when the time comes" write of any kind.
 * - the direction of the scope reading: global is visible everywhere; a bound cycle / node is
 *   compared exactly against where the reader stands (when the position can be given), and without a
 *   position it falls back to a wide read — the bound line is still active, the bound node is not
 *   completed, so it counts as visible. An unrecognised scope word and an empty binding both read
 *   towards "visible": missing a real constraint costs far more than reading one row too many.
 * - the binding at registration follows the position: a cycle / node the caller names is checked
 *   first (the line must be in the line account; a named node must be on the graph when the graph is
 *   non-empty — an empty graph has nothing to check against and is let through), and without a name
 *   the single active line and the node it holds are taken; a cycle / node scope with no binding to
 *   record is refused — an entry without a binding would be read as "visible everywhere, never
 *   lapsing", which is exactly what the scope exists to prevent.
 * - removal leaves a tombstone: the entry leaves the account together with its text, and `removed`
 *   keeps the id and the timestamp (no text, no state word); an issued id is never issued again —
 *   the next id is "the highest issued + 1", and tombstones count too.
 * - the reading has two shapes, one verb: by default it is the reader-facing view — the live entries
 *   visible from where the reader stands, in account order, folded to the three structural words
 *   (`scope`, `target`, `reach`) plus text and id. The account switches (`all` / `live` / `scope`)
 *   hand back the raw rows, also in account order. Visibility is the same decision either way.
 */

const SCOPES: readonly InstructionScope[] = ['global', 'cycle', 'node'];
const TARGETS: readonly InstructionTarget[] = ['stage', 'boundary'];

/** An old entry missing the state key reads as this word; `live` is the only state word that is read. */
const LIVE_STATE = 'live';
/** The key of the tombstone table: the id plus timestamp a removal left. Bookkeeping, shown to no reading. */
const REMOVED_KEY = 'removed';
/** The shape of an issued instruction id: starting with `i-` followed by digits. An issued number is never issued again. */
const ISSUED_ID = /^i-(\d+)$/;

interface InstructionsLedger {
  /** The whole document object of instructions.json: the instructions own only the `instructions`
   *  table, and every other top-level key (foreign sections) is carried back as it was — the same
   *  reading as dag / state. */
  data: Record<string, unknown>;
  instructions: InstructionRecord[];
}

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
 * The visibility decision (a pure function, THE one): whether this instruction is visible from where
 * the reader stands.
 *
 * `readerCycle` / `readerNode` are the reader's position (line and node; null when it cannot be
 * given). With a position, the comparison is exact against the binding — an instruction bound to
 * another node is not read onto this node; without a position it falls back to a wide read: the bound
 * line is still active, the bound node is not completed, so it counts as visible. global (and every
 * entry with nothing to measure against) is visible everywhere.
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

/** The tombstone table: a missing key, or a key that is not an array, reads as none. */
function removedTracesOf(data: Record<string, unknown>): InstructionRemovalTrace[] {
  const traces = data[REMOVED_KEY];
  return Array.isArray(traces) ? (traces as InstructionRemovalTrace[]) : [];
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

/** The next id: the highest issued + 1 (entries and tombstones counted together); an issued number is never issued again. */
function nextInstructionId(ledger: InstructionsLedger): string {
  let highest = 0;
  const records: unknown[] = [...ledger.instructions, ...removedTracesOf(ledger.data)];
  for (const record of records) {
    const value = record !== null && typeof record === 'object'
      ? (record as { id?: unknown }).id
      : undefined;
    if (typeof value !== 'string') continue;
    const match = ISSUED_ID.exec(value);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `i-${String(highest + 1).padStart(4, '0')}`;
}

/** Find an id: `(entry, tombstone)` hits at most one place; when both miss, the id never existed on this account. */
function locate(
  ledger: InstructionsLedger,
  id: string,
): [InstructionRecord | null, InstructionRemovalTrace | null] {
  for (const entry of ledger.instructions) {
    if (entry !== null && typeof entry === 'object' && entry.id === id) return [entry, null];
  }
  for (const trace of removedTracesOf(ledger.data)) {
    if (trace !== null && typeof trace === 'object' && trace.id === id) return [null, trace];
  }
  return [null, null];
}

// ── presenting the reading ───────────────────────────────────────────────────

/**
 * One entry as the reader-facing view carries it: the sentence, the scope as read, and how it is
 * delivered. The ids and the bookkeeping stay on the account; `reach` is the delivery channel with the
 * read side's default filled in, so it is always one of the two words and never a sentence.
 */
function foldReaderRow(entry: InstructionRecord): InstructionReaderRow {
  const target = entry.target ?? null;
  return {
    id: entry.id,
    text: typeof entry.text === 'string' ? entry.text : '',
    scope: entryScope(entry),
    target,
    // The delivery channel keeps the two words only: a word outside the vocabulary is not a channel a
    // reader could have been promised, so it reads the stage default (the noisy direction).
    reach: target === 'boundary' ? 'boundary' : 'stage',
  };
}

// ── the namespace ────────────────────────────────────────────────────────────

async function readInstructionsAt(paths: PfPaths): Promise<InstructionsLedger> {
  const read = await readJsonFile(paths.instructionsJson, 'instructions.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  if (!Array.isArray(data.instructions)) data.instructions = [];
  return { data, instructions: data.instructions as InstructionRecord[] };
}

/** Write instructions.json: the whole document is written back as it was (only the changed cells), in construction order (no sorting). */
async function writeInstructionsAt(paths: PfPaths, ledger: InstructionsLedger): Promise<void> {
  await atomicWriteJson(paths.instructionsJson, ledger.data, jsonOptionsForRecord('instructions'));
}

/** Read-only view of the line account: registering a binding and deciding visibility need "is the line active, who does it hold", and not one byte is written. */
async function readStateCyclesAt(paths: PfPaths): Promise<CycleRecord[]> {
  const read = await readJsonFile(paths.stateJson, 'state.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  return Array.isArray(data.cycles) ? (data.cycles as CycleRecord[]) : [];
}

/** Read-only view of the graph: registering a binding has to check whether the named node is on the graph (visibility needs its statuses too). */
async function readNodesAt(paths: PfPaths): Promise<Record<string, NodeRecord>> {
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
 * The instructions visible from where the reader stands, as the raw rows and in account order.
 *
 * This is the one visibility computation (see `instructionInScope`): `list`'s default view folds these
 * rows for a reader, and dispatch preparation renders them (it needs the binding and the stopping
 * boundary, which the reader-facing row does not carry). Reading holds no lock and asks no gate.
 */
export async function visibleInstructionRows(
  root: string,
  filter: InstructionListFilter = {},
): Promise<InstructionRecord[]> {
  const paths = pfPaths(root);
  const { instructions } = await readInstructionsAt(paths);
  const cycles = await readStateCyclesAt(paths);
  const position = positionOf(cycles, filter.node ?? null);
  const nodes = await readNodesAt(paths);
  const active = new Set(
    cycles
      .filter((record) => record.status === 'active')
      .map((record) => record.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  return instructions
    .filter((entry) => isLive(entry))
    .filter((entry) => instructionInScope(entry, nodes, active, position.cycle, position.node));
}

/** Build the instructions namespace: one per project root. */
export function createInstructionsNamespace(root: string): InstructionsNamespace {
  const paths = pfPaths(root);

  const readInstructions = (): Promise<InstructionsLedger> => readInstructionsAt(paths);
  const writeInstructions = (ledger: InstructionsLedger): Promise<void> => writeInstructionsAt(paths, ledger);
  const readStateCycles = (): Promise<CycleRecord[]> => readStateCyclesAt(paths);
  const readNodes = (): Promise<Record<string, NodeRecord>> => readNodesAt(paths);

  /** The one gate the verbs that change the instruction account share: the init decision first (which creates no directory), then the lock and the read-change-write. */
  function mutate<T>(body: (ledger: InstructionsLedger) => Promise<T>): Promise<T> {
    assertLedgerInitialized(paths);
    return withLedgerLock(paths, async () => {
      const ledger = await readInstructions();
      return body(ledger);
    });
  }

  /**
   * The binding of a new instruction: first take what the caller named (checked first: the line must
   * be in the line account; a named node must be on the graph when the graph is non-empty — an empty
   * graph has nothing to check against and is let through), and without a name take the single active
   * line and the first node it holds. A cycle / node scope with no binding to record is refused and
   * nothing is written — an entry without a binding would be read as visible everywhere, never
   * lapsing.
   */
  function bindingFor(
    input: InstructionAddInput,
    cycles: CycleRecord[],
    nodes: Record<string, NodeRecord>,
  ): { cycle: string | null; node: string | null } {
    const active = cycles.filter((record) => record.status === 'active');
    const known = cycles
      .map((record) => record.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    let cycleId: string | null = null;
    if (input.cycle !== undefined && input.cycle !== null) {
      if (!known.includes(input.cycle)) {
        throw new Error(
          `cycle ${JSON.stringify(input.cycle)} is not in state.json; the account has ` +
            `${known.length > 0 ? JSON.stringify(known) : 'no cycle'}`,
        );
      }
      cycleId = input.cycle;
    } else if (active.length === 1) {
      const only = active[0]!.id;
      cycleId = typeof only === 'string' ? only : null;
    }

    let nodeId: string | null = null;
    if (input.node !== undefined && input.node !== null) {
      // A non-empty graph is the precondition for checking the name: an empty graph has nothing to
      // check against, so the name is written as given; the cycle side has no such pass-through, do
      // not widen it.
      if (Object.keys(nodes).length > 0 && !(input.node in nodes)) {
        throw new Error(`node ${JSON.stringify(input.node)} is not in the DAG`);
      }
      nodeId = input.node;
    }

    if (cycleId !== null && nodeId === null) {
      const record = cycles.find((entry) => entry.id === cycleId);
      const holding = record === undefined ? [] : cycleHoldingIds(record);
      nodeId = holding.length > 0 ? holding[0]! : null;
    }

    if (input.scope === 'cycle' && cycleId === null) {
      throw new Error(
        'a cycle-scoped entry needs a line to bind to (no single active cycle in state.json). ' +
          'Name it: cycle: <id>. Without a binding the entry would be read as visible to ' +
          'everyone, forever, so nothing was written.',
      );
    }
    if (input.scope === 'node' && nodeId === null) {
      throw new Error(
        'a node-scoped entry needs a node to bind to, and the state does not name one ' +
          '(no active cycle, or the cycle it names is holding no node). Name it: node: <id>. ' +
          'Without a binding the entry would be read as visible to everyone, so nothing was written.',
      );
    }
    return { cycle: cycleId, node: nodeId };
  }

  return {
    async add(input: InstructionAddInput): Promise<InstructionRecord> {
      // The wording and the text are checked first (no disk touched): a refusal names the vocabulary and nothing is written.
      if (typeof input.text !== 'string' || input.text.trim() === '') {
        throw new Error('text must not be empty');
      }
      if (!SCOPES.includes(input.scope)) {
        throw new Error(
          `scope must be one of ${JSON.stringify([...SCOPES])}, got ${JSON.stringify(input.scope)}`,
        );
      }
      const target = input.target ?? 'stage';
      if (!TARGETS.includes(target)) {
        throw new Error(
          `target must be one of ${JSON.stringify([...TARGETS])}, got ${JSON.stringify(target)}`,
        );
      }
      return mutate(async (ledger) => {
        // The binding is measured against the line account and the graph (read under the same lock, the write still lands only on the instruction account).
        const cycles = await readStateCycles();
        const nodes = await readNodes();
        const binding = bindingFor(input, cycles, nodes);
        const entry: InstructionRecord = {
          id: nextInstructionId(ledger),
          text: input.text,
          scope: input.scope,
          target,
          state: 'live',
          cycle: binding.cycle,
          node: binding.node,
          said_by: input.said_by ?? 'user',
          at: nowSeconds(),
          resolved_at: null,
          note: input.note ?? null,
        };
        if (input.stop_after_nodes !== undefined && input.stop_after_nodes !== null) {
          entry.stop_after_nodes = input.stop_after_nodes;
        }
        ledger.instructions.push(entry);
        await writeInstructions(ledger);
        return entry;
      });
    },

    async list(filter: InstructionListFilter = {}): Promise<InstructionReaderRow[] | InstructionRecord[]> {
      if (filter.all === true || filter.live === true || filter.scope !== undefined) {
        // The account view: the raw rows, in account order. Only `all` brings archived rows along;
        // `live` keeps the live ones, and `scope` narrows the account to one scope (an unrecognised
        // scope word reads as global, so it lands in the global group).
        const { instructions } = await readInstructions();
        let rows = instructions;
        if (filter.all !== true) rows = rows.filter((entry) => isLive(entry));
        if (filter.scope !== undefined) {
          rows = rows.filter((entry) => entryScope(entry) === filter.scope);
        }
        if (filter.live === true) rows = rows.filter((entry) => isLive(entry));
        return rows;
      }
      // The default view: the one visibility decision (the reader's spot) over the whole account, then
      // folded to the reader-facing rows. Account order is kept on both sides: the reading never sorts.
      const rows = await visibleInstructionRows(root, { node: filter.node });
      return rows.map(foldReaderRow);
    },

    async resolve(id: string, options?: InstructionResolveOptions): Promise<InstructionRecord> {
      return mutate(async (ledger) => {
        const hit = ledger.instructions.find((entry) => entry.id === id);
        if (hit === undefined) {
          throw new Error(`no instruction ${JSON.stringify(id)}`);
        }
        // Resolving touches the state and timestamp cells, plus the note when one is given: text,
        // scope and binding are all kept as they are, and a note that was never given is not cleared.
        hit.state = 'withdrawn';
        hit.resolved_at = nowSeconds();
        if (options?.note !== undefined && options.note !== '') hit.note = options.note;
        await writeInstructions(ledger);
        return hit;
      });
    },

    async revive(id: string): Promise<InstructionRecord> {
      return mutate(async (ledger) => {
        const [hit, trace] = locate(ledger, id);
        if (hit === null && trace === null) {
          throw new Error(`no instruction ${JSON.stringify(id)}`);
        }
        if (hit === null) {
          throw new Error(
            `instruction ${JSON.stringify(id)} was removed at ${trace!.at}; its text went with ` +
              'it, and putting an entry back is not how a removal is undone',
          );
        }
        if (isLive(hit)) {
          throw new Error(
            `instruction ${JSON.stringify(id)} is already live: there is nothing to put back`,
          );
        }
        // Reviving touches only the state and the timestamp: a live entry has no resolution timestamp, so it is cleared back to the shape it had when it came in.
        hit.state = 'live';
        hit.resolved_at = null;
        await writeInstructions(ledger);
        return hit;
      });
    },

    async remove(id: string): Promise<void> {
      return mutate(async (ledger) => {
        const [hit, trace] = locate(ledger, id);
        if (hit === null && trace === null) {
          throw new Error(`no instruction ${JSON.stringify(id)}`);
        }
        if (hit === null) {
          throw new Error(
            `instruction ${JSON.stringify(id)} was removed at ${trace!.at}; its text is already ` +
              'off the account',
          );
        }
        // Removal: the entry leaves the account together with its text; the tombstone keeps the id and
        // the timestamp (no text), and the issued number is not issued again. The tombstone table only
        // goes to disk the first time something is really removed.
        const at = ledger.instructions.indexOf(hit);
        ledger.instructions.splice(at, 1);
        let traces = ledger.data[REMOVED_KEY];
        if (!Array.isArray(traces)) {
          traces = [];
          ledger.data[REMOVED_KEY] = traces;
        }
        (traces as InstructionRemovalTrace[]).push({ id, at: nowSeconds() });
        await writeInstructions(ledger);
      });
    },
  };
}
