/**
 * The model layer's outward shapes: what goes in is the four records plus a
 * moment; what comes out is the reading at that moment.
 *
 * The input is the records' own shapes, all four passed in verbatim — no
 * field renamed, no default filled in. Readings are always given as lists:
 * when a reading has nothing at all, an empty list is produced, never a `0`
 * for someone to print.
 */
import type {
  PathfinderCycle,
  PathfinderInstruction,
  PathfinderIssue,
  PathfinderNode,
} from './records.ts'

/** What the model needs: the four records, plus "read up to which moment". */
export interface RecordsAtMoment {
  /** Keys are node ids; entries are the records verbatim. */
  readonly nodes: Readonly<Record<string, PathfinderNode>>
  readonly cycles: readonly PathfinderCycle[]
  readonly instructions: readonly PathfinderInstruction[]
  /** The issue pool reading's own input: which entries are on the books is decided by each one's discovered moment. */
  readonly issues: Readonly<Record<string, PathfinderIssue>>
  readonly at: Date
}

/**
 * A card's own state, only three words. A card currently worked on by some
 * cycle is still `todo`: who is working it is recorded in the cycle's
 * holdings (see {@link NodeReading.running}); the two facts each get their
 * own field.
 */
export type NodeState = 'todo' | 'shelved' | 'completed'

/**
 * The one bucket a card sits in on the boards: the reading its frame, ring and mark are all drawn
 * from. Judged once per node, from the criteria the reading already holds — the gate, the line's
 * hold, the card's own state — so the drawing layer maps a bucket to a class and never re-judges.
 *
 * What a bucket is called on the screen is a word, and words are the client's business; this is
 * the bucket and nothing else.
 */
export type NodeBucket = 'gate' | 'run' | 'shelved' | 'todo' | 'done'

/**
 * Where a card stands in the triage order the board draws its page in, 0 first: a card that wants a
 * person, then one in someone's hands, then what may start, then what still owes a prerequisite, and
 * only then what has already settled.
 *
 * An order over the one classification rather than a second one: the two halves of `todo` are the
 * only place a rank says more than its {@link NodeBucket}, and "ready" is the reading's own answer,
 * not a judgment made again here.
 */
export type NodeRank = 0 | 1 | 2 | 3 | 4

/**
 * The human gate: when a node needs a person. Which of the three it is plus a moment, all criteria
 * in the records — no new data here.
 *
 * The kind is the whole fact. What a reader calls it is a word, and words are the client's business
 * (see `src/client/words.ts`): a reading that carried the word as well as the kind would carry two
 * spellings of one fact, and only one of them could be the reader's language.
 */
export interface GateReading {
  readonly kind: 'shelved' | 'manual' | 'checkpoint'
  /** That moment; `null` when the records have no such moment — none is invented. */
  readonly since: Date | null
}

/** One step a node has taken, at that moment. */
export interface StepReading {
  /** Which cycle took this step; an empty id when the cycle's record has no id. */
  readonly cycleId: string
  readonly node?: string
  /** When the step started, cut by the moment: not yet started means absent. */
  readonly startedAt: Date | null
  /** When the step ended, cut by the moment: not yet ended means absent. */
  readonly endedAt: Date | null
  readonly result?: string
  /** How long the step took; `null` when either end is missing. */
  readonly seconds: number | null
}

/** One node's reading at that moment. */
export interface NodeReading {
  readonly id: string
  readonly title?: string
  readonly state: NodeState
  /**
   * Running: at that moment some cycle holds it and it is not yet completed;
   * the cycle records' holdings are the authority.
   */
  readonly running: boolean
  /**
   * Ready to start: itself `todo`, every dependency completed, and no cycle
   * holding it. All three conditions are required.
   */
  readonly ready: boolean
  /** The word the record itself wrote, verbatim; absent when not written. */
  readonly recordStatus?: string
  /** The mode this node runs in, verbatim. */
  readonly mode?: string
  /** Which session this node was opened on: carried out when the record itself has the field, absent otherwise. */
  readonly session?: string
  /** The dependencies written in the record, verbatim, not one dropped. */
  readonly dependencies: readonly string[]
  /** The dependencies not yet completed at that moment: not one of them counts as completed. */
  readonly openDependencies: readonly string[]
  /** Ids of the cycles holding it at that moment, in record order. */
  readonly heldBy: readonly string[]
  /** The holdings' own moment: when it was first picked up; `null` when unrecorded or not yet reached. */
  readonly heldSince: Date | null
  /** Creation moment, cut by that moment. */
  readonly createdAt: Date | null
  /** Completion moment, cut by that moment. */
  readonly completedAt: Date | null
  /** When its own step started. */
  readonly startedAt: Date | null
  /** When its own step ended. */
  readonly endedAt: Date | null
  /** How long its own step took. */
  readonly seconds: number | null
  /** How long it has been running (up to that moment); `null` when not running or the moment is absent. */
  readonly elapsedSeconds: number | null
  /** The shelved moment: the verdict step's end moment; `null` when there is none (not 0). */
  readonly parkedSince: Date | null
  /** The steps it has taken. */
  readonly steps: readonly StepReading[]
  /** The cycles that passed through it. */
  readonly cycleIds: readonly string[]
  /** The human gate: which kind, and which moment, if this node needs a person; `null` when it does not. */
  readonly gate: GateReading | null
  /**
   * The one moment this card speaks of: the gate's moment, else the pick-up, else the step's end,
   * else the delivery, else the creation.
   *
   * Which moment is news about this card is a judgment of the reading's, made once here; a card
   * drawn on a board prints this field and does not pick among the moments again.
   */
  readonly stampAt: Date | null
}

/**
 * What a node answers on the dependency field: whether it may start, or how
 * many prerequisites it still owes.
 *
 * Which of the two belongs to a node is stated by the reading's own `ready`;
 * the UI does not re-judge the three conditions. Completed, running, and
 * shelved nodes owe no such answer — dependencies are written only for work
 * not yet started.
 *
 * The sentence itself is not here: a reader's wording differs per language, so
 * the client spells it from these two facts (`src/client/words.ts`).
 */
export interface DepsReading {
  /** Whether it is the ready-to-start answer. */
  readonly ready: boolean
  /** The owed-prerequisite count in the not-ready answer; the ready one has no number. */
  readonly count: number | null
}

/** A cycle holding at that moment. */
export interface HoldingReading {
  readonly nodeId: string
  /** When the hold was taken; `null` when unrecorded or not yet reached. */
  readonly since: Date | null
}

/** One cycle's reading at that moment. */
export interface CycleReading {
  readonly id: string
  readonly title?: string
  /** The word the record itself wrote, verbatim; absent when not written. */
  readonly recordStatus?: string
  /** Whether it is in service at that moment. */
  readonly inService: boolean
  readonly holding: readonly HoldingReading[]
  /** The steps it has walked by that moment (a step not yet ended in the records does not count as walked). */
  readonly path: readonly StepReading[]
  /** Its last walked step at that moment; `null` if it has walked none. */
  readonly lastStep: StepReading | null
  /** Ids of the nodes parked under it: which nodes it stopped at, waiting for a person. */
  readonly parked: readonly string[]
}

/**
 * One group on the instruction ledger: the section piled by scope. A key as
 * the group head, a stack of entries beneath.
 *
 * The key is read in exactly one place, where readings are produced: global
 * first, then each cycle in record order, then the unrecognized cycle last;
 * empty groups are not collected. What the head says is the client's business
 * — the key is what identifies the bucket, and one of them is headed by a
 * cycle's own id, which is a record's word and reads the same in every
 * language.
 */
export interface InstructionGroupReading {
  /** This group's id: `global` / the bound cycle (`cycle:<cycle id>`) / `node`. */
  readonly key: string
  /** The entries in this group: still-counting ones first, newly spoken ones first. */
  readonly entries: readonly InstructionReading[]
}

/** One instruction's reading at that moment. */
export interface InstructionReading {
  readonly id: string
  readonly text?: string
  /** The note the record itself wrote, verbatim; absent when not written. */
  readonly note?: string
  /** The scope, verbatim: global / bound to a cycle / bound to a node, plus any other spellings in the records; absent when not written. */
  readonly scope?: string
  /** Which cycle it is bound to; `null` when unbound. */
  readonly cycleId: string | null
  /** Which node it is bound to; `null` when unbound. */
  readonly nodeId: string | null
  /** When it was spoken, cut by that moment. */
  readonly saidAt: Date | null
  /** When it was closed, cut by that moment: not yet closed at that moment means absent. */
  readonly closedAt: Date | null
  /** The word the record itself wrote, verbatim (legacy old values come out verbatim too, no folding); absent when not written. */
  readonly recordState?: string
  /**
   * Whether it still stands at that moment: the word says `live`, and no
   * already-reached moment has collected it.
   */
  readonly standing: boolean
  /** Whether it applies at that moment: the scope says "whose head this sentence counts on". */
  readonly inScope: boolean
  /** In force = spoken (hence present in the reading) + still standing + in scope. */
  readonly inForce: boolean
}

/** Each of the four columns on the word table, mutually exclusive: a node appears in exactly one. */
export interface ColumnReadings {
  readonly completed: readonly NodeReading[]
  /** Running: held by some cycle at that moment and not yet completed. */
  readonly running: readonly NodeReading[]
  /** Shelved: parked waiting for a person at that moment; when there are none, the column is an empty list — not drawn, and no 0 written. */
  readonly shelved: readonly NodeReading[]
  /** Not started: in play, not yet completed, and nobody working it (running nodes are not in this column). */
  readonly todo: readonly NodeReading[]
  /** Ready: the half of not-started whose dependencies are all completed and which nobody holds. */
  readonly ready: readonly NodeReading[]
  /** The half with uncompleted prerequisites. */
  readonly blocked: readonly NodeReading[]
}

/** An edge on the dependency field: `from` is the prerequisite, `to` the node waiting on it, and `span` how many layers apart the two are (at least 1). */
export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly span: number
}

/**
 * The dependency field's reading at that moment: a layered graph.
 *
 * A node's layer number is its longest-path tier: it stands one layer to the
 * right of its deepest prerequisite.
 */
export interface GraphReading {
  /** The nodes in each layer, in record order. Empty when there are no nodes at all. */
  readonly layers: readonly (readonly NodeReading[])[]
  readonly maxDepth: number
  readonly edges: readonly GraphEdge[]
}

/** The four states of an issue in the pool, the records' own words. */
export type IssueState = 'open' | 'acknowledged' | 'rejected' | 'resolved'

/** One issue at that moment. */
export interface IssueReading {
  readonly id: string
  readonly title?: string
  /** The severity tier, verbatim. */
  readonly severity?: string
  /** How many times that tier counts in the records' weight table; 0 when the table has no such tier. */
  readonly weight: number
  /** Which state it sits in at that moment: the record's own word, `open` when not yet written down by that moment. */
  readonly status: IssueState
  /** The word the record itself wrote, verbatim; absent when not written. */
  readonly recordStatus?: string
  readonly module?: string
  /** Who reported it. */
  readonly source?: string
  /** The verdict. */
  readonly decision?: string
  /** Whether this issue weighs on the line: `false` when the verdict exempts it from the scale — still on the books, still standing, just left out of the weighted sum. */
  readonly payable: boolean
  /** When it was discovered, cut by that moment: not yet discovered at that moment means absent. */
  readonly discoveredAt: Date | null
  /** Last modified moment, cut by that moment. */
  readonly updatedAt: Date | null
  readonly checkCount: number | null
  readonly files: readonly string[]
  readonly description?: string
  readonly suggestion?: string
  readonly reason?: string
  readonly planPath?: string
}

/** One pile in the issue pool: the issues under one state. */
export interface IssueGroupReading {
  /** Which state this pile holds; what it is called is the client's word. */
  readonly key: IssueState
  /** Whether this pile counts as still owed by the pool: the two standing piles count, the two set-down piles do not. */
  readonly standing: boolean
  /** The issues in this pile, ordered as in {@link PoolReading}. */
  readonly entries: readonly IssueReading[]
  readonly count: number
  /** This pile's weighted sum: non-paying issues stay out of the sum. */
  readonly weight: number
}

/** The weight table: how many times a tier written in the records counts. */
export type PoolWeights = Readonly<Record<string, number>>

/** The issue pool's reading at that moment. */
export interface PoolReading {
  /** The policy line: the number a cycle set via `issue_pool_weight_limit`; `null` when no record sets it — 0 is never printed. */
  readonly line: number | null
  /** The weight table: the one written in the records (how many times each tier counts); `null` when the records have none. */
  readonly weights: PoolWeights | null
  readonly rows: readonly IssueReading[]
  /** The four piles, in the order a reader meets them; empty piles are not collected. */
  readonly groups: readonly IssueGroupReading[]
  /**
   * The issues still owed: open followed by acknowledged. The pool's weight
   * is the weight of the entries in this list that enter the sum; without a
   * weight table this list is absent too.
   */
  readonly standing: readonly IssueReading[]
  /** The weighted sum of the standing issues, non-paying ones excluded; `null` when the weight table cannot be read. */
  readonly weight: number | null
  /** Four counts, plus a total. */
  readonly census: PoolCensus
}

/** The issue pool's counts. */
export interface PoolCensus {
  /** How many issues are on the books in total. */
  readonly total: number
  /** How many are standing in total. */
  readonly standing: number
  readonly open: number
  readonly acknowledged: number
  readonly rejected: number
  readonly resolved: number
}

/** The project reading at that moment. */
export interface ProjectReading {
  readonly at: Date
  readonly nodes: readonly NodeReading[]
  /** The same readings keyed by id. */
  readonly nodeById: Readonly<Record<string, NodeReading>>
  readonly columns: ColumnReadings
  readonly cycles: readonly CycleReading[]
  /** The same readings keyed by id. */
  readonly cycleById: Readonly<Record<string, CycleReading>>
  /** The instructions in force at that moment. */
  readonly instructions: readonly InstructionReading[]
  /** The dependency field at that moment: who blocks whom. */
  readonly graph: GraphReading
  readonly pool: PoolReading
}