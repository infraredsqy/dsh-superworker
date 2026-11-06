import { createCyclesNamespace } from './cycles';
import { createDagNamespace } from './dag';
import { createInstructionsNamespace } from './instruct';
import { initLedger, registerLedger } from './initledger';
import type { InitReport, LedgerInitOptions, LedgerRegisterOptions } from './initledger';
import { pfPaths } from './paths';
import { cleanTemp } from './tempclean';
import type { CleanTempOptions, CleanTempReport } from './tempclean';
import type {
  CycleRecord,
  CycleStatus,
  InstructionRecord,
  InstructionScope,
  InstructionTarget,
  MicroTimestamp,
  NodeMode,
  NodeRecord,
  NodeResult,
  NodeStatus,
  NodeWeight,
  SecondsTimestamp,
  SessionNoteEntry,
} from './types';

// ── dag: the graph ───────────────────────────────────────────────────────────

/** What registering a node takes: the title is required, the rest has defaults. */
export interface DagAddInput {
  title: string;
  description?: string;
  mode?: NodeMode;
  tags?: string[];
  weight?: NodeWeight;
  /** Dependencies declared right at node creation (node ids). */
  depends_on?: string[];
}

/**
 * One row of a batch registration: the same cells as a single add, plus a `ref` this batch's own
 * `depends_on` may name instead of the id the engine generates.
 */
export interface DagAddManyRow {
  /** A name for this row inside the batch: unique among the rows, and never an id already on the graph. */
  ref?: string;
  title: string;
  description?: string;
  mode?: NodeMode;
  weight?: NodeWeight;
  tags?: string[];
  /** Dependency ids, or refs of other rows of this batch. */
  depends_on?: string[];
}

/** Change one node: whichever key is given is the key that changes. */
export interface DagUpdateInput {
  title?: string;
  description?: string;
  mode?: NodeMode;
  /** Replace with a new set of tags; null takes them all off (back to visible to every filter set). */
  tags?: string[] | null;
  /** Writing standard takes the weight key off (a missing key means standard). */
  weight?: NodeWeight;
}

/** The choices when removing a node. */
export interface DagRemoveOptions {
  /** Force the removal even when other nodes depend on it (the dependency edges are torn down with it). */
  force?: boolean;
}

/** The filter of list: by status, by readiness, by tag range, and a limit. */
export interface DagListFilter {
  status?: NodeStatus[];
  /** Ready ones only (the node itself is todo and every dependency is completed). */
  ready?: boolean;
  /** The filter range: in range means hitting at least one tag, or neither side having tags. */
  tags?: string[];
  limit?: number;
}

/** The choices of search. */
export interface DagSearchOptions {
  /** Search only nodes that are not finished. */
  activeOnly?: boolean;
  limit?: number;
}

/** A list row: the skeleton fields are all there; scores are given only on runnable nodes, blocked and completed ones have none. */
export interface NodeSummary {
  id: string;
  title: string;
  status: NodeStatus;
  mode: NodeMode;
  /** The node itself is todo and every dependency is completed. */
  ready: boolean;
  tags?: string[];
  weight?: NodeWeight;
  urgency_level?: number;
  importance_score?: number;
}

/** One upstream / downstream entry of context: depth starts at 1. */
export interface NodeContextEntry {
  id: string;
  title: string;
  status: string;
  depth: number;
}

/** The transitive closure of one node's upstream and downstream. */
export interface NodeContext {
  id: string;
  title: string;
  status: NodeStatus;
  upstream: NodeContextEntry[];
  downstream: NodeContextEntry[];
}

/** One row a search hit. */
export interface DagSearchHit {
  id: string;
  title: string;
  status: NodeStatus;
  ready: boolean;
  /** The full text when the title matched; when only the description matched, the full text or an excerpt depending on the number of hits. */
  description?: string;
}

/** The report of validate: cycles, dangling references, duplicate edges and isolated nodes. */
export interface DagValidationReport {
  ok: boolean;
  total: number;
  status_counts: Record<string, number>;
  /** One line per problem (cycle paths, dangling references, duplicate edges). */
  problems: string[];
  /** The isolated nodes found (ids of nodes with no `dependencies` and no dependents, in on-disk order).
   *  Isolated nodes are only named, not marked red: the verdict of `ok` still covers only cycles / dangling / duplicate edges. */
  isolated?: string[];
}

/** A registered node: the on-disk record plus an `id`. The on-disk record does not carry its own id (it
 *  is the key of the ideas.json node table), but add is the only verb where the engine generates an id,
 *  and without handing it back the caller cannot reach any following verb. */
export type AddedNode = NodeRecord & { id: string };

/** The choices of the node detail: whether the extended fields are read as well. */
export interface DagInfoOptions {
  /** Read the extended fields too: the two timestamps and the status of every edge's other end. */
  verbose?: boolean;
}

/**
 * One end of a dependency edge in the node detail: the node's id and title, and — under `verbose` —
 * the word its own record carries. A dependency the graph no longer holds reads `(unknown)` for both;
 * a dependent that names no status reads the empty string (the two defaults the read side has).
 */
export interface DagInfoEdge {
  id: string;
  title: string;
  status?: NodeStatus | '(unknown)' | '';
}

/**
 * The node detail: everything one node's record says, plus what only the graph can answer — who it
 * waits on and who waits on it, whether it is ready, where it stands in the ordering, and the two
 * session lists only this machine holds.
 *
 * Key order is the read side's own and is fixed: id, title, status, mode, description, depends_on,
 * depended_by, ready, urgency_level, importance_score, then the optional cells in this order —
 * weight (only light), created_at / updated_at (only under `verbose`), sessions (only when a note
 * has something in it), completed_at, approved_at (each only when its moment was written).
 */
export interface DagInfo {
  id: string;
  title: string;
  status: NodeStatus;
  mode: NodeMode;
  description: string;
  depends_on: DagInfoEdge[];
  depended_by: DagInfoEdge[];
  ready: boolean;
  /** The urgency reading, worked out on the unfinished graph; a shelved node does not rank and reads 0. */
  urgency_level: number;
  /** The importance reading, worked out the same way; a shelved node reads 0 too. */
  importance_score: number;
  /** Lands only for light; standard does not write this key. */
  weight?: NodeWeight;
  created_at?: MicroTimestamp;
  updated_at?: MicroTimestamp;
  /** Both lists of this node's session file; the key is absent when both are empty. */
  sessions?: { discussion: SessionNoteEntry[]; run: SessionNoteEntry[] };
  completed_at?: MicroTimestamp;
  approved_at?: MicroTimestamp;
}

/** The graph namespace: reading and writing nodes and edges, these sixteen verbs. */
export interface DagNamespace {
  add(input: DagAddInput): Promise<AddedNode>;
  /**
   * Register a batch of nodes as one graph write: the rows may name one another by `ref`, and a bad
   * row, an unknown dependency or a cycle refuses the whole batch, writing not one byte.
   */
  addMany(rows: readonly DagAddManyRow[]): Promise<Array<AddedNode & { ref?: string }>>;
  remove(id: string, options?: DagRemoveOptions): Promise<void>;
  update(id: string, patch: DagUpdateInput): Promise<NodeRecord>;
  /**
   * Add dependency edges (id depends on dependsOn); the edge is checked for cycles itself and refused
   * on one. An array is one batch, one write: every dependency is resolved first, and all or none of
   * them land.
   */
  link(id: string, dependsOn: string | readonly string[]): Promise<void>;
  /** Take one dependency edge off. */
  unlink(id: string, dependency: string): Promise<void>;
  /** Change the status; landing completed writes completed_at, leaving completed takes it off. */
  setStatus(id: string, status: NodeStatus): Promise<NodeRecord>;
  /** Record a person's approval of this delivery; the timestamp defaults to now and only counts after the completion timestamp. */
  approve(id: string, at?: MicroTimestamp): Promise<NodeRecord>;
  /** Put a shelved node back to todo. */
  revive(id: string): Promise<NodeRecord>;
  /** Read one node's record; null when it is not on the graph. */
  get(id: string): Promise<NodeRecord | null>;
  /** Read one node's detail: the record, both directions of its edges, readiness, the two readings and the session lists. */
  info(id: string, options?: DagInfoOptions): Promise<DagInfo>;
  /** Read the transitive closure of one node's upstream and downstream. */
  context(id: string): Promise<NodeContext>;
  /** Search titles and descriptions by regex; title hits come first. */
  search(query: string, options?: DagSearchOptions): Promise<DagSearchHit[]>;
  list(filter?: DagListFilter): Promise<NodeSummary[]>;
  /** The location path of one node's spec.md. */
  specPath(id: string): Promise<string>;
  /** Validate the whole graph: cycles, dangling references, duplicate edges and isolated nodes (isolated ones are only named, not marked red). */
  validate(): Promise<DagValidationReport>;
}

// ── cycles: lines ────────────────────────────────────────────────────────────

/** Set up a line: the id and the picking range are required. */
export interface CycleCreateInput {
  id: string;
  title?: string;
  /** The filter range this line picks nodes by. */
  tags: string[];
  /** Force another one even when another line is already running. */
  force?: boolean;
}

/** Set up a line and pin the node that opens it: parallel lands in this line's policy-layer parallel slot. */
export interface CycleStartInput extends CycleCreateInput {
  /** How many nodes this line claims at once; 1 by default. */
  parallel?: number;
}

/** One policy value: word / integer / number / switch; null takes this entry off and drops back to the next layer. */
export type CyclePolicyValue = string | number | boolean | null;

/** The effective policy set of one line (the current values, as read). */
export type CyclePolicySet = Record<string, string | number | boolean>;

/** Settle one step of a line: hand back the verdict and the line records this step in path. */
export interface CycleCloseInput {
  node: string;
  result: NodeResult;
  summary?: string;
  outputs?: Record<string, unknown>;
}

/** One step a line walked, as the standing reading hands it back (both moments spelled out). */
export interface CycleStandingStep {
  result: NodeResult;
  started_at: SecondsTimestamp | null;
  ended_at: SecondsTimestamp | null;
}

/** The ticket on disk for one (line, node), as the standing reading hands it back. */
export interface CycleStandingSignal {
  status: string;
  summary: string;
  outputs: Record<string, unknown> | null;
}

/** One node's standing in one line: held now, walked before, or nothing; plus the ticket on disk. */
export interface CycleStanding {
  cycle: string;
  node: string;
  standing: 'holding' | 'walked' | 'nothing';
  /** The claim's moment; present only while holding. */
  since?: SecondsTimestamp | null;
  /** The most recent walked step naming this node; present only after a walk. */
  step?: CycleStandingStep;
  signal: CycleStandingSignal | null;
}

/** The cycles namespace: setting up, running, stopping and settling one work line, these thirteen verbs. */
export interface CyclesNamespace {
  create(input: CycleCreateInput): Promise<CycleRecord>;
  start(input: CycleStartInput): Promise<CycleRecord>;
  rename(id: string, title: string): Promise<CycleRecord>;
  setStatus(id: string, status: CycleStatus): Promise<CycleRecord>;
  /** Write one policy of a line's own and hand back the whole effective set. */
  setPolicy(id: string, key: string, value: CyclePolicyValue): Promise<CyclePolicySet>;
  list(): Promise<CycleRecord[]>;
  /** The line that should be working now; null when there is none. */
  current(): Promise<CycleRecord | null>;
  show(id: string): Promise<CycleRecord>;
  /** One line's effective policy set: the defaults this line's picks read, then whatever it states. */
  policies(id: string): Promise<CyclePolicySet>;
  /** One node's standing in this line: held now / walked before / nothing, plus the ticket on disk. */
  standing(id: string, node: string): Promise<CycleStanding>;
  /** Claim one node — or a batch of them — onto this line's roster: one write, and all or none of it. */
  hold(id: string, nodes: string | readonly string[]): Promise<CycleRecord>;
  /** Settle one step: the verdict goes into path, and the claim is laid down with it. */
  close(id: string, input: CycleCloseInput): Promise<CycleRecord>;
  /** Pick a line that did not run to the end back up and run it again; `drop` also clears the claim, which is what a dead session needs, and `summary` is the sentence the new pending ticket carries. */
  retry(id: string, node?: string, options?: { drop?: boolean; summary?: string }): Promise<CycleRecord>;
}

// ── instructions ─────────────────────────────────────────────────────────────

/** Register one instruction: the text and the scope are required, the binding follows the scope. */
export interface InstructionAddInput {
  text: string;
  scope: InstructionScope;
  target?: InstructionTarget;
  /** The binding when scope is cycle / node. */
  cycle?: string;
  node?: string;
  said_by?: string;
  note?: string;
  /** Lapses after this many nodes have closed the line. */
  stop_after_nodes?: number;
}

/** The filter of `list`: the reader-facing view by default, the raw account when one of the three account switches is given. */
export interface InstructionListFilter {
  /** Account view: the whole account, archived entries included. */
  all?: boolean;
  /** Account view: only the entries whose state is live. */
  live?: boolean;
  /** Account view narrowed to one scope. */
  scope?: InstructionScope;
  /** The node the reader stands on: with two lines side by side it is what pins the line down too. */
  node?: string;
}

/**
 * What a resolve leaves beside the state and the moment: the note the owner put on the archive. An
 * entry already carrying one is not cleared by resolving without a note — only a note that is
 * actually given is written.
 */
export interface InstructionResolveOptions {
  note?: string;
}

/**
 * One row of the reader-facing view: what the instruction says, where it can be seen from, and how it
 * is delivered — ids and bookkeeping stay on the account.
 *
 * `scope` is the scope as read (an unrecognised word reads global); `target` is the word the record
 * carries, `null` when it carries none; `reach` is the same delivery channel with the read side's
 * default filled in, always `stage` or `boundary`. The engine gives the words, never a sentence: how
 * a reach reads to a person is the presentation layer's business.
 */
export interface InstructionReaderRow {
  id: string;
  text: string;
  scope: InstructionScope;
  target: InstructionTarget | null;
  reach: InstructionTarget;
}

/** The instructions namespace: the user instruction channel, these five verbs. */
export interface InstructionsNamespace {
  add(input: InstructionAddInput): Promise<InstructionRecord>;
  /**
   * The default view is the reader-facing one: the live entries visible from where the reader stands,
   * in account order, each folded to `InstructionReaderRow`. The account views (`all` / `live` /
   * `scope`) hand back the raw rows, also in account order.
   */
  list(filter?: InstructionListFilter): Promise<InstructionReaderRow[] | InstructionRecord[]>;
  /** Resolve one instruction (lands resolved_at, and the note when one is given). */
  resolve(id: string, options?: InstructionResolveOptions): Promise<InstructionRecord>;
  /** Put an archived instruction back in force. */
  revive(id: string): Promise<InstructionRecord>;
  /** Take the instruction off the records (leaving a trace of the id and the timestamp). */
  remove(id: string): Promise<void>;
}

// ── ledger: the record directory and the three sub-namespaces ────────────────

export type {
  ExcludeReading,
  InitReport,
  LedgerInitOptions,
  LedgerLayout,
  LedgerRegisterOptions,
  MergeDriverReading,
  OwnRepoReading,
} from './initledger';

/** The record directory (`.pf/`) namespace: init, register, and the graph, cycles and instructions sub-spaces. */
export interface LedgerNamespace {
  /**
   * Set up the `.pf/` record directory for a project and hand back what it did: the layout files
   * (always), plus the three best-effort attachments — a repository of `.pf`'s own, the project
   * repository's `info/exclude` line, the merge driver's two git config keys — each missing one
   * named in `warnings` rather than thrown.
   */
  init(options?: LedgerInitOptions): Promise<InitReport>;
  /**
   * Write the merge driver into this project's git config (the `[merge "pf"]` section), unless a
   * registration this machine already answers is there — that one is kept as it is. Hands back the
   * command now in force, or null when nothing was registered (no runner, or not a git checkout).
   */
  register(options?: LedgerRegisterOptions): Promise<string | null>;
  /** List (or, with `remove`, delete) every node's `temp/` directory: one sweep, whole directories only. */
  cleanTemp(options?: CleanTempOptions): Promise<CleanTempReport>;
  readonly dag: DagNamespace;
  readonly cycles: CyclesNamespace;
  readonly instructions: InstructionsNamespace;
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Assemble the ledger namespace: init, register, the temp sweep and the three blocks of graph, lines
 * and instructions (the locations come from the caller's project root).
 */
export function createLedgerNamespace(root: string): LedgerNamespace {
  return {
    init: (initOptions) => initLedger(root, initOptions),
    register: (registerOptions) => registerLedger(root, registerOptions),
    cleanTemp: (cleanOptions) => cleanTemp(pfPaths(root), cleanOptions),
    dag: createDagNamespace(root),
    cycles: createCyclesNamespace(root),
    instructions: createInstructionsNamespace(root),
  };
}
