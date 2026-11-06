/**
 * The frozen record types: node, line, instruction, issue, handoff ticket, session file.
 *
 * Key names and value vocabularies are written as `.pf` records are on disk (snake_case key names
 * included): whatever a record on disk looks like, the interface here looks the same. Optional keys land
 * only when their condition holds, and by default no key is written — whatever shape the record has on
 * disk is the shape it has here.
 *
 * There are two timestamp shapes, both UTC with a literal `Z`:
 * - the microsecond shape (`2026-01-01T00:00:00.000000Z`): used by the graph (node records) and by the
 *   records a plugin keeps of its own;
 * - the seconds shape (`2026-01-01T00:00:00Z`): used by lines (state.json), handoff tickets, instructions
 *   and session files.
 */

/** A seconds-shape timestamp (`2026-01-01T00:00:00Z`). */
export type SecondsTimestamp = string;

/** A microsecond-shape timestamp (`2026-01-01T00:00:00.000000Z`). */
export type MicroTimestamp = string;

// ── node ─────────────────────────────────────────────────────────────────────

/** Node status: `todo` is on the books and not delivered, `shelved` is off the books waiting for someone, `completed` is delivered. */
export type NodeStatus = 'todo' | 'shelved' | 'completed';

/** Node mode: `manual` is the discussion slot; `checkpoint` stops at the end of the line and waits for someone to continue; `auto` opens the next node by itself. */
export type NodeMode = 'manual' | 'checkpoint' | 'auto';

/** Node weight: `light` is implemented by the conductor alone; `standard` takes the standard path. A missing key means standard. */
export type NodeWeight = 'light' | 'standard';

/** A node record (a value of the `nodes` table in ideas.json). */
export interface NodeRecord {
  title: string;
  description: string;
  status: NodeStatus;
  mode: NodeMode;
  /** The ids of the nodes it depends on (the edges on the graph). */
  dependencies: string[];
  created_at: MicroTimestamp;
  updated_at: MicroTimestamp;
  /** Tags (the words of a filter range). Present only when tags were given; a node without tags is visible to every filter set. */
  tags?: string[];
  /** Lands only for light; standard does not write this key. */
  weight?: NodeWeight;
  /** Present only while status is completed; leaving completed takes it off. */
  completed_at?: MicroTimestamp;
  /** When a person approved this delivery; present only once approved. An approval only counts for a delivery after the completion timestamp. */
  approved_at?: MicroTimestamp;
}

// ── line ─────────────────────────────────────────────────────────────────────

/** The verdict word of one step of work: completed / failed / stopped. */
export type NodeResult = 'completed' | 'failed' | 'stopped';

/** Line status: `active` should be pushed forward, `inactive` is not pushed. The reason it stopped is not written into the status. */
export type CycleStatus = 'active' | 'inactive';

/** One current claim of a line: one node appears on only one line's roster at a time. */
export interface CycleHolding {
  id: string;
  since: SecondsTimestamp | null;
}

/** One step a line walked; one settle lands one entry. */
export interface CyclePathStep {
  node: string;
  started_at: SecondsTimestamp | null;
  ended_at: SecondsTimestamp | null;
  result: NodeResult;
}

/** The policy layer a line declares itself; besides the three core keys these are knobs a plugin declares, which land on this layer under the same name. */
export interface CyclePolicies {
  /** When a node is put down without being delivered: stop the line and wait for someone, or record it as shelved and keep picking. Defaults to stop. */
  when_shelved?: 'stop' | 'continue';
  /** How many nodes this line claims at once and how many sessions it opens; 1 by default. It is a ceiling: whether they can run in parallel is up to the graph. */
  parallel?: number;
  /** Knobs a plugin declares and that are allowed to be declared on the line layer. */
  [key: string]: unknown;
}

/** A line (an entry of the `cycles` table in state.json): one work line, whose claims and walked path both live in this record. */
export interface CycleRecord {
  id: string;
  title: string;
  status: CycleStatus;
  /** The nodes it holds right now. */
  holding: CycleHolding[];
  /** Every step walked. */
  path: CyclePathStep[];
  created_at: SecondsTimestamp;
  updated_at: SecondsTimestamp;
  /** The filter range this line picks nodes by; it must be declared when the line is set up. */
  tags?: string[];
  /** The policy layer the line declares itself. */
  policies?: CyclePolicies;
}

// ── instruction ──────────────────────────────────────────────────────────────

/** The visible range of an instruction: global / one line / one node. */
export type InstructionScope = 'global' | 'cycle' | 'node';

/** What an instruction hangs on: `stage` is in force on a process stage; `boundary` is in force at the line-closing boundary. */
export type InstructionTarget = 'stage' | 'boundary';

/** Instruction state: `live` is in force; `withdrawn` is archived (the record stays, it is just no longer read). */
export type InstructionState = 'live' | 'withdrawn';

/** An instruction record (an entry of the `instructions` table in instructions.json): the standing user instruction channel. */
export interface InstructionRecord {
  id: string;
  text: string;
  scope: InstructionScope;
  target: InstructionTarget;
  state: InstructionState;
  /** The binding when scope is cycle / node; null for global. */
  cycle: string | null;
  node: string | null;
  said_by: string;
  at: SecondsTimestamp;
  resolved_at: SecondsTimestamp | null;
  note: string | null;
  /** Optional: lapses after this many nodes have closed the line. */
  stop_after_nodes?: number;
}

/** The trace an instruction removal leaves: only the id and the timestamp, no text. */
export interface InstructionRemovalTrace {
  id: string;
  at: SecondsTimestamp;
}

/** The whole instructions.json document: the instruction table plus the removal traces (bookkeeping, shown to no view). */
export interface InstructionLedger {
  instructions: InstructionRecord[];
  removed?: InstructionRemovalTrace[];
}

// ── issue ────────────────────────────────────────────────────────────────────

/** Issue severity: P0 is the heaviest (one P0 outweighs eight P3s). */
export type IssueSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** The disposal decision: fix it here / handle it outside / not decided yet. */
export type IssueDecision = 'autofix' | 'external' | 'unknown';

/** Where it came from: found by a scan / registered by hand / debt a working session reported along the way. */
export type IssueSource = 'scan' | 'manual' | 'conduct';

/** Issue status: open → acknowledged → resolving → resolved; or rejected, not to be fixed. */
export type IssueStatus = 'open' | 'acknowledged' | 'resolving' | 'resolved' | 'rejected';

/** An issue record (a value of the `issues` table in issues.json). */
export interface IssueRecord {
  id: string;
  severity: IssueSeverity;
  module: string;
  title: string;
  decision: IssueDecision;
  source: IssueSource;
  status: IssueStatus;
  discovered: MicroTimestamp;
  updated_at: MicroTimestamp;
  /** How many times it has been hit by a scan; 1 the first time. */
  check_count: number;
  files: string[];
  functions: string[];
  description: string;
  suggestion: string;
  /** A one-line reason the registrar gave; may be null. */
  reason: string | null;
  /** Where the fix plan lives; may be null. */
  plan_path: string | null;
}

/** The whole issues.json document. */
export interface IssueLedger {
  version: 1;
  issues: Record<string, IssueRecord>;
}

// ── handoff ticket ───────────────────────────────────────────────────────────

/** A handoff ticket (signals/<cycle>/<node>.json): the verdict sheet one step of work hands back, these six keys only. */
export interface HandoffRecord {
  cycle: string;
  node: string;
  status: NodeResult;
  summary: string;
  outputs: Record<string, unknown>;
  timestamp: SecondsTimestamp;
}

// ── session file ─────────────────────────────────────────────────────────────

/** The host that opens sessions: this engine opens DSH sessions and nothing else, so the vocabulary is this one word. */
export type SessionHost = 'dsh';

/** One entry of a session file: which session, which host opened it, when (null when unknown, no timestamp is made up). */
export interface SessionNoteEntry {
  session: string;
  /**
   * The host this engine opens sessions with. A note may still carry an older word (another
   * implementation writes those records too): it stays on disk as written, and reading it is never
   * an error — every entry reads and shows as the DSH host (see `src/sessions.ts`).
   */
  host: SessionHost;
  at: SecondsTimestamp | null;
  /** Marks where the value came from when it was taken over from an older field. */
  source?: string;
}

/** A session file (meta/sessions/<node id>.json): which session gave birth to this node, which sessions ran it. */
export interface SessionNoteRecord {
  v: 1;
  discussion: SessionNoteEntry[];
  run: SessionNoteEntry[];
}
