import { createDagNamespace } from './dag';
import { nowMicro, nowSeconds } from './clock';
import { RecordError } from './errors';
import { unlinkWithRetry } from './fs-helpers';
import { atomicWriteJson, jsonOptionsForRecord, readJsonFile } from './jsonio';
import { assertLedgerInitialized } from './initledger';
import type {
  CycleCloseInput,
  CycleCreateInput,
  CycleHolder,
  CyclePolicySet,
  CyclePolicyValue,
  CycleStanding,
  CycleStartInput,
  CyclesNamespace,
} from './ledger';
import { withLedgerLock } from './ledgerlock';
import { recordPaths, signalPath, startedMarkerPath, type RecordPaths } from './paths';
import type {
  CycleHolding,
  CyclePolicies,
  CycleRecord,
  CycleStatus,
  NodeRecord,
  NodeResult,
  SecondsTimestamp,
} from './types';
import {
  eisenhowerOrder,
  inTagScope,
  nodeReady,
  normalizeTags,
  rankScores,
  short,
  tagsOf,
  type NodeMap,
} from './graph';

/**
 * The real implementation of the cycles namespace: set up a line, start it, rename it, bring it into and
 * out of service, line-level policies, list, current, show the record, claim, settle, re-run. Behaviour and
 * on-disk bytes are fixed point by point:
 *
 * - every verb that changes state.json holds the record tree's lock through the whole "read → change →
 *   write"; the init gate comes before the lock (the gate sits before the lock creates any directory, so a
 *   `.superworker` that was never initialised gets not one byte). Read-side verbs (list / current / show) hold no
 *   lock and ask no gate: writes are atomic, and a never-initialised line account reads as an empty one.
 * - state.json is read and rewritten as a whole document: the lines own only the `cycles` table, and every
 *   other top-level key is carried back as it was. Key order lands in the writer's construction order (no
 *   sorting); the timestamps of line records are always the seconds shape.
 * - the picking range (tags) must be declared when a line is set up; only one line may be active at a time
 *   (another one still active is refused, force overrides it explicitly); the default title takes the date
 *   of the moment the line is set up (`Cycle <YYYY-MM-DD>`).
 * - starting a line pins the opening nodes by the graph's ranking: ready = todo and every dependency
 *   delivered (absent counts as delivered); the ranking puts importance first and urgency after (the same
 *   ordering rule as `dag list`); nodes another line is holding do not enter the ranking; the line's own tags only
 *   delete rows, they never reorder; parallel is this line's claim ceiling (1 by default), and an empty
 *   ranking refuses to start.
 * - claims are mutually exclusive across lines: one node is on only one line's roster at a time
 *   (re-claiming one's own is legitimate, the restart reading).
 * - settling writes only the line account: the verdict goes into path, the claim is laid down; the handoff
 *   ticket is a conductor-layer action and is not written here (the summary / outputs of CycleCloseInput do
 *   not land on this layer, and the return value is still the whole line record).
 * - the reading of a re-run: the old ticket of that step is cleared and rewritten as pending (the marker a
 *   re-run leaves), and the line account is not changed by one character; node defaults to the single step
 *   in hand, otherwise the step walked most recently.
 * - the switch from out of service to in service has an acceptance gate: when the most recent landing is a
 *   checkpoint node and a person has not approved this batch of deliveries yet, the approval is written onto
 *   the node (through dag's approve, landing in ideas.json) — "bring the line back into service" is exactly
 *   that continue.
 */

const VALID_CYCLE_STATUSES: readonly CycleStatus[] = ['active', 'inactive'];
const VALID_NODE_RESULTS: readonly NodeResult[] = ['completed', 'failed', 'stopped'];
const CYCLE_TAGS_VOCABULARY = ['writing', 'coding', 'art'] as const;

/** The line's own three policy keys: they do not enter the settings list, and both reading and writing land only in the `policies` of the line record. */
const LINE_POLICIES = {
  when_shelved: { kind: 'word', values: ['stop', 'continue'], default: 'stop' },
  parallel: { kind: 'integer', default: 1 },
  model: { kind: 'text', default: null },
} as const;

type PolicyKind = 'word' | 'integer' | 'text';
type PolicySpec = { kind: PolicyKind; values?: readonly string[]; default: string | number | null };
type PolicyTable = Record<string, PolicySpec>;

const POLICY_TABLE: PolicyTable = {
  when_shelved: LINE_POLICIES.when_shelved,
  parallel: LINE_POLICIES.parallel,
  model: LINE_POLICIES.model,
};

/** The defaults of the two always-present policies: they go underneath when reading the effective set, and a value written on the line is parsed by kind and laid on top. */
const POLICY_DEFAULTS: Record<string, string | number> = {
  when_shelved: LINE_POLICIES.when_shelved.default as string,
  parallel: LINE_POLICIES.parallel.default as number,
};

/** The reading of state.json the whole engine shares: the whole document, and its `cycles` table normalized into line records. */
export interface StateLedger {
  /** The whole document object of state.json: the lines own only the `cycles` table, and every other top-level key is carried back as it was. */
  data: Record<string, unknown>;
  cycles: CycleRecord[];
}

/** Whether one cell of the `cycles` table is a line record: a JSON object (an array or a bare word is not). */
function isCycleRecord(value: unknown): value is CycleRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The one reading of state.json — the record tree's lines table — for the whole engine: the cycles
 * verbs and the settings chain both ask it, so "where the table is, how an entry is recognized, what
 * a bad shape reads as" is written here once.
 *
 * The whole document is handed back (the lines own only the `cycles` table, every other top-level key
 * is carried back as it was), and the table is normalized in place: a missing or non-list `cycles` is
 * an empty table, and entries that are not line records are dropped. Those cells cannot be read as
 * lines, and the read side keeps that kind of silence everywhere else — dropping them here is what
 * keeps a hand-edited table from crashing one reader while the other looks past it.
 *
 * One shape is refused rather than normalized: a document whose top level is not a JSON object (an
 * array, a bare word, a number, `null`) is not a record at all. Reading it as an empty table would
 * hand every reader "nothing is held" from a document that says nothing of the kind — and a reader
 * that acts on that (the temp sweep) would delete what a line holds. So the gate is here, once: every
 * reader meets the same answer, and no reader has a reason to judge the shape a second time.
 */
export async function readStateLedger(paths: RecordPaths): Promise<StateLedger> {
  const read = await readJsonFile(paths.stateJson, 'state.json');
  const document = read.kind === 'present' ? read.value : {};
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new RecordError(
      'parse_failure',
      paths.stateJson,
      'state.json is not an object with a cycles list; refusing to read it as a record',
    );
  }
  const data = document as Record<string, unknown>;
  if (!Array.isArray(data.cycles)) data.cycles = [];
  const table = data.cycles as unknown[];
  for (let index = table.length - 1; index >= 0; index -= 1) {
    if (!isCycleRecord(table[index])) table.splice(index, 1);
  }
  return { data, cycles: table as CycleRecord[] };
}

/** One line by exact id — never a prefix guess for the caller; not on the table answers `undefined`. */
export function findCycleRecord(ledger: StateLedger, cycleId: string): CycleRecord | undefined {
  return ledger.cycles.find((record) => record.id === cycleId);
}

/** The lines holding one node right now, read through the same claim reader: both on-disk shapes count. */
export function holdingCycles(ledger: StateLedger, nodeId: string): CycleRecord[] {
  return ledger.cycles.filter((record) => holdingIds(record).includes(nodeId));
}

/** Split a list of tags: the graph layer's one normalisation (trim, drop empty words, keep the order, dedupe); the vocabulary is only a human convention, and the engine takes whatever it is given. */
function parseCycleTags(raw: Iterable<string>): string[] {
  return normalizeTags(raw);
}

/** Parse one policy value by kind: a value that fails this gate is refused on the spot (the write side gates, the read side tolerates). */
function parsePolicyValue(kind: PolicyKind, value: unknown, values?: readonly string[]): unknown {
  if (kind === 'integer') {
    if (typeof value === 'boolean') return undefined;
    let candidate = value;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!/^-?\d+$/.test(trimmed)) return undefined;
      candidate = Number(trimmed);
    }
    return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1
      ? candidate
      : undefined;
  }
  if (typeof value !== 'string') return undefined;
  return values === undefined || values.includes(value) ? value : undefined;
}

/**
 * The effective policy set of one line: the defaults underneath, the values written on the line parsed by
 * kind, and the ones that do not parse taken as never written.
 *
 * The one read-side place: the line account's own verbs use it, and the planner (parallel / when_shelved)
 * reads from here too — the same defaults and the same parsing are not written a second time anywhere else.
 */
export function cyclePolicy(record: CycleRecord): CyclePolicySet {
  const out: CyclePolicySet = { ...POLICY_DEFAULTS };
  const stated = record.policies;
  if (stated === undefined || stated === null || typeof stated !== 'object') return out;
  for (const [key, value] of Object.entries(stated as CyclePolicies)) {
    const spec = POLICY_TABLE[key];
    if (spec === undefined) continue;
    const parsed = parsePolicyValue(spec.kind, value, spec.values);
    if (parsed !== undefined) out[key] = parsed as string | number;
  }
  return out;
}

/** One policy value on the write side: `off` / null clears the entry; a value that fails the kind gate is refused. */
function policyValueForRecord(key: string, value: CyclePolicyValue): string | number | null {
  const spec = POLICY_TABLE[key];
  if (spec === undefined) {
    throw new Error(`unknown policy ${JSON.stringify(key)}; valid keys: ${Object.keys(POLICY_TABLE)}`);
  }
  if (value === null) return null;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'off') return null;
  if (spec.kind === 'integer') {
    const candidate = typeof value === 'string' ? value.trim() : value;
    let parsed: number | undefined;
    if (typeof candidate === 'number' && Number.isInteger(candidate)) parsed = candidate;
    else if (typeof candidate === 'string' && /^-?\d+$/.test(candidate)) parsed = Number(candidate);
    if (parsed === undefined) {
      throw new Error(`policy ${key} takes a positive integer or \`off\`, got ${JSON.stringify(value)}`);
    }
    if (parsed < 1) {
      throw new Error(`policy ${key} must be at least 1 (a line holds at least one node)`);
    }
    return parsed;
  }
  if (spec.kind === 'text') {
    if (typeof value !== 'string') {
      throw new Error(`policy ${key} takes one word, got ${JSON.stringify(value)}`);
    }
    const text = value.trim();
    if (text === '' || /\s/u.test(text)) {
      throw new Error(`policy ${key} takes one word without blanks, got ${JSON.stringify(value)}`);
    }
    return text;
  }
  if (typeof value !== 'string' || !spec.values!.includes(value)) {
    throw new Error(
      `policy ${key} must be one of ${JSON.stringify(spec.values ?? [])} or \`off\`, ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The roster a line holds, canonical shape: `[{id, since}]`; the old on-disk shape (a bare id string) reads as since null. */
function holdingOf(record: CycleRecord): CycleHolding[] {
  const holding = record.holding;
  if (!Array.isArray(holding)) return [];
  const out: CycleHolding[] = [];
  for (const item of holding) {
    if (item !== null && typeof item === 'object' && typeof (item as CycleHolding).id === 'string' && (item as CycleHolding).id !== '') {
      out.push({ id: (item as CycleHolding).id, since: (item as CycleHolding).since ?? null });
    } else if (typeof item === 'string' && item !== '') {
      out.push({ id: item, since: null });
    }
  }
  return out;
}

function holdingIds(record: CycleRecord): string[] {
  return holdingOf(record).map((item) => item.id);
}

/** The ids of the nodes one line holds right now, accepting both on-disk shapes — the canonical one and a bare id string (the single exit of the read side). */
export function cycleHoldingIds(record: CycleRecord): string[] {
  return holdingIds(record);
}

/** Write the canonical shape back onto this line: `holding` has exactly one shape. */
function setHolding(record: CycleRecord, items: CycleHolding[]): void {
  record.holding = items.map((item) => ({ id: item.id, since: item.since ?? null }));
}

/** Both timestamp spellings parse into epoch microseconds, null when unrecognisable (comparisons are only made on these two shapes). */
function momentToUs(value: string): number | null {
  const seconds = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (seconds !== null) {
    const [, y, m, d, h, mi, s] = seconds;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)) * 1000;
  }
  const micro = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
  if (micro !== null) {
    const [, y, m, d, h, mi, s, frac] = micro;
    return (
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)) * 1000 +
      Number(frac)
    );
  }
  return null;
}

/** Whether a person approved this batch of deliveries: the approval only counts when its timestamp is after the completion timestamp (one of the criteria for an approval holding). */
function deliveryApproved(node: NodeRecord): boolean {
  const { approved_at: approved, completed_at: completed } = node;
  if (!approved || !completed) return false;
  const approvedUs = momentToUs(approved);
  const completedUs = momentToUs(completed);
  if (approvedUs !== null && completedUs !== null) return approvedUs >= completedUs;
  return approved >= completed;
}

/** Build the cycles namespace: one per project root. */
export function createCyclesNamespace(root: string): CyclesNamespace {
  const paths = recordPaths(root);
  const dag = createDagNamespace(root);

  /** The record's one reading (see `readStateLedger`), on this tree's paths. */
  async function readState(): Promise<StateLedger> {
    return readStateLedger(paths);
  }

  /** Write state.json: the whole document is written back as it was (only the cycles table is changed), in construction order (state is not sorted). */
  async function writeState(ledger: StateLedger): Promise<void> {
    await atomicWriteJson(paths.stateJson, ledger.data, jsonOptionsForRecord('state'));
  }

  /**
   * Find this line: by exact id, never guessing a prefix for the caller; an id not on the account is
   * refused on the spot with the record's own `cycle_not_found` — the same code and the same landing
   * (`state.json`) the settings chain refuses a line id with, so one absence has one answer wherever
   * a caller meets it and the code table covers the whole path.
   */
  function findCycle(ledger: StateLedger, id: string): CycleRecord {
    const found = findCycleRecord(ledger, id);
    if (found === undefined) {
      throw new RecordError('cycle_not_found', paths.stateJson, `cycle "${id}" not found in state.json`);
    }
    return found;
  }

  /** The block both set-up verbs share: tags must be declared, the id must be unused, only one line may be active at a time (force overrides it explicitly). */
  function createEntry(ledger: StateLedger, verb: string, input: CycleCreateInput, now: SecondsTimestamp): CycleRecord {
    const tags = parseCycleTags(input.tags ?? []);
    if (tags.length === 0) {
      throw new Error(
        `${verb} must be given tags (the range this line picks from). ` +
          `For example: tags: ['coding']. Known words: ${CYCLE_TAGS_VOCABULARY.join('/')} ` +
          '(a word outside the vocabulary is fine too; it is taken as given). ' +
          'Every pick this line makes reads this one range.',
      );
    }
    if (ledger.cycles.some((record) => record.id === input.id)) {
      throw new Error(`cycle "${input.id}" already exists`);
    }
    const active = ledger.cycles
      .filter((record) => record.status === 'active')
      .map((record) => record.id);
    if (active.length > 0 && input.force !== true) {
      throw new Error(
        `cycle(s) ${JSON.stringify(active)} still active -- one cycle at a time. Take them out ` +
          'of service (status "inactive"), or pass force to run two anyway.',
      );
    }
    const entry: CycleRecord = {
      id: input.id,
      title: input.title !== undefined && input.title !== null && input.title !== ''
        ? input.title
        : `Cycle ${now.slice(0, 10)}`,
      status: 'active',
      holding: [],
      path: [],
      created_at: now,
      updated_at: now,
    };
    entry.tags = tags;
    ledger.cycles.push(entry);
    return entry;
  }

  /**
   * The acceptance gate of out of service → in service: when the most recent landing is a checkpoint node
   * and a person has not approved this batch of deliveries yet, the approval is written (through dag's
   * approve, landing in ideas.json). Not on the graph, not a checkpoint, already approved, or never
   * delivered — not one byte is written in any of those cases.
   */
  async function approveGateDelivery(record: CycleRecord): Promise<void> {
    const ended = (record.path ?? []).filter(
      (step) => step.ended_at !== null && step.ended_at !== undefined && step.node,
    );
    const last = ended[ended.length - 1];
    if (last === undefined) return;
    const node = await dag.get(last.node);
    if (node === null || node.mode !== 'checkpoint') return;
    if (deliveryApproved(node)) return;
    const delivered = node.status === 'completed' || node.completed_at !== undefined;
    if (!delivered) return;
    await dag.approve(last.node, nowMicro());
  }

  /**
   * The ranking of ready nodes: todo and every dependency delivered (the graph layer's one ready
   * criterion); importance first, urgency after (the graph layer's one ordering, the same rule as
   * `dag list`, and the stable sort keeps the on-disk order); nodes another line holds right now do
   * not enter the ranking; the line's tags only delete rows, they never reorder.
   */
  function rankedReadyNodes(nodes: NodeMap, busyElsewhere: Set<string>, tags: string[]): string[] {
    const ready = Object.entries(nodes)
      .filter(([uid]) => nodeReady(uid, nodes))
      .filter(([uid]) => !busyElsewhere.has(uid))
      .filter(([, node]) => inTagScope(tagsOf(node), tags))
      .map(([uid]) => uid);
    return eisenhowerOrder(ready, rankScores(nodes));
  }

  /** The nodes another line holds right now: the reading of claim exclusivity, which the ranking of a starting line has to subtract first. */
  function nodesHeldElsewhere(ledger: StateLedger, exceptCycleId: string | null): Set<string> {
    const busy = new Set<string>();
    for (const record of ledger.cycles) {
      if (record.id === exceptCycleId) continue;
      for (const id of holdingIds(record)) busy.add(id);
    }
    return busy;
  }

  /** The one gate the verbs that change the line account share: the init decision first (which creates no directory), then the lock and the read-change-write. */
  function mutate<T>(body: (ledger: StateLedger) => Promise<T>): Promise<T> {
    assertLedgerInitialized(paths);
    return withLedgerLock(paths, async () => {
      const ledger = await readState();
      return body(ledger);
    });
  }

  /** Clear one old ticket: a file that is not there counts as cleared (the ordinary case on the re-run path), and a standoff backs off and retries at the foundation's cadence. */
  async function dropSignal(cycleId: string, nodeId: string): Promise<void> {
    await unlinkWithRetry(signalPath(paths, cycleId, nodeId));
  }

  return {
    async create(input: CycleCreateInput): Promise<CycleRecord> {
      return mutate(async (ledger) => {
        const entry = createEntry(ledger, 'ledger.cycles.create', input, nowSeconds());
        await writeState(ledger);
        return entry;
      });
    },

    async start(input: CycleStartInput): Promise<CycleRecord> {
      return mutate(async (ledger) => {
        const tags = parseCycleTags(input.tags ?? []);
        if (tags.length === 0) {
          throw new Error(
            'ledger.cycles.start must be given tags (the range this line picks from). ' +
              `Known words: ${CYCLE_TAGS_VOCABULARY.join('/')} (a word outside the vocabulary is ` +
              'fine too; it is taken as given).',
          );
        }
        // parallel lands in the parallel slot of this line's policy layer: a positive integer lands on disk, off/null falls back to the default.
        let stated: number | null = null;
        if (input.parallel !== undefined && input.parallel !== null) {
          const parsed = policyValueForRecord('parallel', input.parallel);
          stated = parsed === null ? null : (parsed as number);
        }
        const cap = stated ?? (POLICY_DEFAULTS.parallel as number);

        // Picking happens before the account is written (under the same lock): the nodes the starting line pins come from here.
        const ideasRead = await readJsonFile(paths.ideasJson, 'ideas.json');
        const nodes: NodeMap =
          ideasRead.kind === 'present' &&
          ideasRead.value !== null &&
          typeof ideasRead.value === 'object'
            ? (((ideasRead.value as Record<string, unknown>).nodes ?? {}) as NodeMap)
            : {};
        const busy = nodesHeldElsewhere(ledger, null);
        const ranked = rankedReadyNodes(nodes, busy, tags).slice(0, cap);
        if (ranked.length === 0) {
          // The reading of the refusal direction only goes through tags, not through busy: this scan does not
          // subtract "held by another line" — something held by another line is the topic "go start that
          // line", and calling it "no work on the graph" would report the direction backwards.
          const blocked = rankedReadyNodes(nodes, new Set<string>(), []);
          if (blocked.some((uid) => !inTagScope(tagsOf(nodes[uid]!), tags))) {
            throw new Error(
              `--tags ${tags.join(',')}: this filter set has no ready node; there are ready ` +
                'nodes in the graph kept out by tag. Widen tags (a node with no tag is in every range).',
            );
          }
          throw new Error(
            'the graph has no ready node -- there is no work to run. Have the route be built ' +
              'first, then start the line.',
          );
        }

        const now = nowSeconds();
        const entry = createEntry(ledger, 'ledger.cycles.start', input, now);
        if (stated !== null) {
          // The policies key is a cell added later: when the key is missing it lands at the end of this record, with the same byte order as the record writer.
          const policies: CyclePolicies = (entry.policies ?? {}) as CyclePolicies;
          policies.parallel = stated;
          entry.policies = policies;
        }
        // The nodes the starting line pins; the claim timestamp is the moment the line was set up.
        setHolding(
          entry,
          ranked.map((uid) => ({ id: uid, since: entry.created_at })),
        );
        await writeState(ledger);
        return entry;
      });
    },

    async rename(id: string, title: string): Promise<CycleRecord> {
      return mutate(async (ledger) => {
        const record = findCycle(ledger, id);
        record.title = title;
        record.updated_at = nowSeconds();
        await writeState(ledger);
        return record;
      });
    },

    async setStatus(id: string, status: CycleStatus): Promise<CycleRecord> {
      return mutate(async (ledger) => {
        const record = findCycle(ledger, id);
        if (!VALID_CYCLE_STATUSES.includes(status)) {
          throw new Error(
            `cycle status must be one of ${JSON.stringify([...VALID_CYCLE_STATUSES].sort())}`,
          );
        }
        const wasInService = record.status === 'active';
        if (status === 'active' && !wasInService) {
          // Bringing a line back into service is exactly the continue a person gives at the checkpoint gate; the approval is written first, then the line account moves.
          await approveGateDelivery(record);
        }
        record.status = status;
        record.updated_at = nowSeconds();
        await writeState(ledger);
        return record;
      });
    },

    async setPolicy(id: string, key: string, value: CyclePolicyValue): Promise<CyclePolicySet> {
      return mutate(async (ledger) => {
        const record = findCycle(ledger, id);
        const stored = policyValueForRecord(key, value);
        const policies: CyclePolicies = (record.policies ?? {}) as CyclePolicies;
        if (stored === null) delete policies[key];
        else policies[key] = stored;
        record.policies = policies;
        record.updated_at = nowSeconds();
        await writeState(ledger);
        return cyclePolicy(record);
      });
    },

    async list(): Promise<CycleRecord[]> {
      const { cycles } = await readState();
      // The reading hands back the canonical shape: the old bare-id shape reads as since null, and the on-disk bytes are not touched.
      return cycles.map((record) => ({ ...record, holding: holdingOf(record) }));
    },

    async current(): Promise<CycleRecord | null> {
      const { cycles } = await readState();
      const active = cycles.filter((record) => record.status === 'active');
      if (active.length === 1) {
        const record = active[0]!;
        return { ...record, holding: holdingOf(record) };
      }
      if (active.length === 0) return null;
      // A second active line set up with force: it has to be named, never picked for the caller.
      throw new Error(
        `several active cycles: continue which one? ${JSON.stringify(active.map((record) => record.id))}`,
      );
    },

    async show(id: string): Promise<CycleRecord> {
      const ledger = await readState();
      const record = findCycle(ledger, id);
      return { ...record, holding: holdingOf(record) };
    },

    /**
     * Which line holds one node now, and which lines have already walked it. One record judgement, in
     * one place: the same reading the closing gate asks (`holding` / `path`), handed back to whoever
     * has to say it in words. A read verb: no lock, no write.
     */
    async holder(node: string): Promise<CycleHolder> {
      const { cycles } = await readState();
      const lines = cycles.map((record) => ({ ...record, holding: holdingOf(record) }));
      const holders = lines.filter((line) => holdingOf(line).some((item) => item.id === node));
      const closedOn = lines.filter((line) =>
        ((line.path ?? []) as readonly { node?: unknown }[]).some((step) => step.node === node),
      );
      return {
        holders,
        closedOn,
        lines,
      };
    },

    /** One line's effective policy set: the defaults, then whatever this line states, in one reading. */
    async policies(id: string): Promise<CyclePolicySet> {
      const ledger = await readState();
      return cyclePolicy(findCycle(ledger, id));
    },

    /**
     * One node's standing in one line: whether this line holds it now (with the claim's moment), walked
     * it before (the most recent step naming it), or knows nothing about it -- plus the ticket on disk
     * for that (line, node), read as it is. A read verb: no lock, no init gate, not one byte written.
     */
    async standing(id: string, node: string): Promise<CycleStanding> {
      const ledger = await readState();
      const record = findCycle(ledger, id);
      const standing: CycleStanding = { cycle: id, node, standing: 'nothing', signal: null };
      const held = holdingOf(record).find((item) => item.id === node);
      if (held !== undefined) {
        standing.standing = 'holding';
        standing.since = held.since ?? null;
      } else {
        const steps = record.path ?? [];
        const step = [...steps].reverse().find((item) => item.node === node);
        if (step !== undefined) {
          const raw = step as unknown as Record<string, unknown>;
          standing.standing = 'walked';
          standing.step = {
            result: step.result,
            started_at: (raw.started_at as string | null | undefined) ?? null,
            ended_at: (raw.ended_at as string | null | undefined) ?? null,
          };
        }
      }
      const read = await readJsonFile(signalPath(paths, id, node), 'signal');
      if (read.kind === 'present' && read.value !== null && typeof read.value === 'object') {
        const ticket = read.value as Record<string, unknown>;
        const outputs = ticket.outputs;
        standing.signal = {
          status: String(ticket.status ?? ''),
          summary: String(ticket.summary ?? ''),
          outputs: outputs !== null && typeof outputs === 'object' && !Array.isArray(outputs)
            ? (outputs as Record<string, unknown>)
            : null,
        };
      }
      return standing;
    },

    async hold(id: string, nodes: string | readonly string[]): Promise<CycleRecord> {
      // One claim or a batch of them: the caller's own words are read the same way, and the write is
      // one record either way. The whole batch lands or none of it does — a node another line holds
      // stops the call before anything is written.
      const wanted = (typeof nodes === 'string' ? [nodes] : [...nodes]).filter((node) => node !== '');
      if (wanted.length === 0) {
        throw new Error('hold needs at least one node id; nothing was changed.');
      }
      return mutate(async (ledger) => {
        const record = findCycle(ledger, id);
        const holding = holdingOf(record);
        const now = nowSeconds();
        for (const node of wanted) {
          const holder = ledger.cycles.find(
            (other) => other.id !== id && holdingIds(other).includes(node),
          );
          if (holder !== undefined) {
            throw new Error(
              `node "${node}" is already held by cycle "${holder.id}" (status ${holder.status}). ` +
                '-- one node belongs to one cycle at a time, whatever that line\'s status. ' +
                'Close it there first, or pick another node.',
            );
          }
          if (!holding.some((item) => item.id === node)) {
            holding.push({ id: node, since: now });
          }
        }
        setHolding(record, holding);
        record.updated_at = now;
        await writeState(ledger);
        return { ...record, holding: holdingOf(record) };
      });
    },

    async close(id: string, input: CycleCloseInput): Promise<CycleRecord> {
      return mutate(async (ledger) => {
        const record = findCycle(ledger, id);
        if (!VALID_NODE_RESULTS.includes(input.result)) {
          throw new Error(
            `result must be one of ${JSON.stringify([...VALID_NODE_RESULTS].sort())}`,
          );
        }
        const holding = holdingOf(record);
        const item = holding.find((entry) => entry.id === input.node);
        if (item === undefined) {
          const names = holding.map((entry) => short(entry.id)).join(', ') || 'nothing';
          throw new Error(
            `cycle "${id}" is not holding ${input.node} (it holds ${names}); nothing was changed.`,
          );
        }
        const now = nowSeconds();
        // One settle lands one entry: who, from when to when, and with what result. The handoff ticket is not written here (a conductor-layer action).
        record.path = [...(record.path ?? []), {
          node: input.node,
          started_at: item.since,
          ended_at: now,
          result: input.result,
        }];
        setHolding(record, holding.filter((entry) => entry.id !== input.node));
        record.updated_at = now;
        await writeState(ledger);
        return { ...record, holding: holdingOf(record) };
      });
    },

    async retry(id: string, node?: string, options?: { drop?: boolean; summary?: string }): Promise<CycleRecord> {
      return mutate(async (ledger) => {
        const record = findCycle(ledger, id);
        // The default step: the single one in hand, otherwise the one walked most recently; with neither there is nothing to re-run.
        let target = node;
        if (target === undefined || target === null) {
          const holding = holdingIds(record);
          if (holding.length === 1) target = holding[0]!;
          else {
            const steps = record.path ?? [];
            const last = steps[steps.length - 1];
            if (last !== undefined && last.node) target = last.node;
          }
        }
        if (target === undefined || target === null || target === '') {
          throw new Error(`cycle "${id}" has no node to retry (nothing in hand, nothing walked)`);
        }
        // A re-run only clears the ticket: the old one is taken down and rewritten as pending (the marker a
        // re-run leaves, which the read side waits on as a blocker). The line account is not changed by one
        // character — claiming again goes through hold, and the two jobs each keep to one place.
        await dropSignal(id, target);
        // `drop` is the retry a dead session needs: no ticket left at all, and the claim goes with it. The
        // claim is what makes a dispatch answer `already_open`, so leaving it behind strands the cell — the
        // plan waits on the pending ticket, and dispatching it again refuses on a session that is gone.
        if (options?.drop === true) {
          await unlinkWithRetry(startedMarkerPath(paths, id, target));
          return { ...record, holding: holdingOf(record) };
        }
        const ticket = {
          cycle: id,
          node: target,
          status: 'pending',
          // The caller's sentence when one was given, the plain note otherwise: a retry's ticket is
          // what the next reader of this line reads as the step's own words.
          summary:
            options?.summary !== undefined && options.summary !== ''
              ? options.summary
              : 'Node restarted (previous signal cleared)',
          outputs: {},
          timestamp: nowSeconds(),
        };
        await atomicWriteJson(signalPath(paths, id, target), ticket, jsonOptionsForRecord('signal'));
        return { ...record, holding: holdingOf(record) };
      });
    },
  };
}
