/**
 * The overview's reading: which windows the overview draws, and which rows
 * each one draws.
 *
 * What comes in is what the browser already holds: the session list's own
 * snapshot (a pushed state, so liveness is read straight off its running bit —
 * it is never probed by opening a session, an act that would wake an ended
 * one), each session's own events, and the record side: the judgement packet
 * the record's verdicts about its cells are assembled into once
 * ({@link readJudgement}), and those cells' own records verbatim. What comes
 * out is only the reading — which windows, which rows, what each row carries.
 * Sizes, positions, motion, pixels: none of that lives here.
 *
 * Which conversation is the main window is the pipeline's own fact, not the
 * window manager's: only a session this workspace's record names is ever drawn
 * (`pipelineSessions`), and among those the panel's own session wins, then the
 * one still running, then the one that moved last. DSH's `retainedBy.mainView`
 * is a browser-side count of who holds a session open — a conversation the
 * record never named can carry it, which is exactly how an unrelated old
 * conversation once got drawn — so it is read only when the caller says
 * nothing at all about which sessions this pipeline owns.
 *
 * A child window is a session that is still working this round: the list's own
 * bit says alive, or there is no window at all. Which sessions those are is two
 * admissions read together — a session the record names (the run notes' legs: a
 * relay reopens the next leg after one reads "closed", so the parent links it
 * leaves behind point wherever the last trigger stood and decide nothing), and
 * the main session's own `parentId` children, which is the whole admission when
 * the caller says nothing about the pipeline. A session with nothing readable —
 * no nameplate word, no row its own events fold into — is a box, not a window,
 * and the running bit alone never stands one up. A child that ended is not
 * drawn: the window it had is taken off the page by the client's leave
 * animation, which is why the drawing never has to keep a finished one.
 *
 * Unless its work is still on the table. The stage shows where the line stands
 * **now**, so a leg the record has not delivered keeps its window after its
 * conversation stopped — but only while the line stands still: a leg that
 * stopped is no shape of a stall while another leg of the line runs, and a leg
 * whose conversation began after this one's last word has taken its place. That
 * is one reading, not a memory of events: reloading the page shows the same
 * picture, and the red that says "broken" comes back with the stall rather than
 * being cleared once and forgotten. A delivered leg is never a window; it owes
 * nobody.
 *
 * A stop is read against the work the conversation still has out. A turn that
 * closed itself is a **yield** while a session it dispatched is running or came
 * home after its own last word — the notice that wakes it is still crossing, so
 * nothing is stuck and nothing is red. Only a turn the log cut short (an abort, an
 * error, an interruption), or one that closed with its work still owed and nobody
 * left to wake it, is a break. That is why a subagent that finished its job never
 * paints the frame red: it hands its turn back, and delivering is not its to do.
 *
 * A session DSH ran **for** one of these windows — its row carries the
 * `parentId` of the session that dispatched it, and the ordered list leaves it
 * out — is a child of that window: a window while it runs, and, when it was cut
 * off while its dispatcher's cell was still held and the line has stopped, a
 * window afterwards too. It works no node of its own, so its debt is its
 * dispatcher's: the work it was doing is still on the table and nothing took it
 * over. One that closed its own turn hands the work back and leaves; one whose
 * turn was cut keeps a red seat while the line stands, because that cut is where
 * the line stands.
 *
 * The main window is the conversation this panel lives in, and it
 * carries the facts the drawing's states are read from: `settled` (the list's
 * running bit is not true — the rows will not move again), `delivered` (the
 * record says the work is handed in), `waiting` (the record names this session
 * as one whose node stands at a person's gate) and `alert` (work is owed,
 * nobody is doing it, and the line has stopped). See
 * {@link OverviewWindow}.
 *
 * The snapshot's and the log's field spellings are DSH's own (`running`,
 * `parentId`, `updatedAt`, `tool/call`, …), read defensively: a field that is
 * not there reads as absent, and no default pretends to know it. No "still
 * running this round" projection folded out of logs is read either — that word
 * stops at its old value when a session dies mid-round, and the list's own
 * running bit is the authority.
 */
import type { NodeReading } from './contract.ts'
import type { SuperworkerNode } from './records.ts'
import { asRecord, secondsBetween, text, toEpoch } from './fields.ts'

/**
 * The window cap: more than this many child windows, and the overview draws
 * only the most recent ones. The cap counts the children alone — the main window
 * is the conversation this panel lives in, and it is one of the windows whenever
 * the record names it and the list has it.
 */
const WINDOW_CAP = 5

/** One row of the session-list snapshot, as far as this reading reads it. */
export interface OverviewSessionRow {
  readonly id?: unknown
  /** The list's running bit: the authoritative alive word for a child, and the second thing the main window is chosen by. */
  readonly running?: unknown
  /** The parent's id: what makes a session one of the main session's children. */
  readonly parentId?: unknown
  /** The label the list itself spells: a window's title when the record names no node and nobody dispatched it. */
  readonly displayTitle?: unknown
  /**
   * DSH's own projections of this conversation, as far as this reading reads them: the `subagent`
   * identity carries the `label` its dispatching call wrote ({@link dispatchLabelOf}).
   */
  readonly projectionValues?: unknown
  /** When the list last moved this row: the last thing the main window is chosen by, the newest surviving. */
  readonly updatedAt?: unknown
  /**
   * DSH's main-view count: who holds this session open in the browser. It is
   * **not** a pipeline fact — a conversation this record never named can carry
   * it — so it decides nothing while the caller says which sessions the
   * pipeline owns ({@link OverviewInput.pipelineSessions}).
   */
  readonly retainedBy?: { readonly mainView?: unknown }
}

/** The session-list snapshot, as far as this reading reads it. */
export interface OverviewSnapshot {
  /** The host list's order: the arrival order the window cap reads. */
  readonly ids?: unknown
  /** The list rows, keyed by session id. */
  readonly byId?: unknown
}

/** One event of a session's own log, as far as the fold reads it. */
export interface OverviewEvent {
  /** The log's own event name: `assistant/message`, `tool/call`, `tool/result`, … */
  readonly type?: unknown
  /** Epoch milliseconds. */
  readonly time?: unknown
  readonly data?: unknown
}

/**
 * What one drawn row is. The kind is the whole fact; the word and the mark it
 * is drawn with are the drawing half's business, so this set says only what
 * happened — a person's own words handed in, a reasoning step, a file read or
 * written, a command run, the model's own words, a task dispatched, a failure,
 * and the neutral `tool` for a call this fold does not know by name.
 *
 * `input` is the one row the conversation did not say: the prompt it was
 * handed. It is here because the feed is read as the conversation's own
 * transcript — DSH's own conversation half shows the same line — and a reply
 * with nothing above it is not a reading of what happened, it is a fragment.
 */
export type OverviewRowKind = 'input' | 'think' | 'read' | 'write' | 'run' | 'output' | 'dispatch' | 'fail' | 'tool'

/** One row a window draws. */
export interface OverviewRow {
  readonly kind: OverviewRowKind
  /** The one-sentence body: the cut the row shows. */
  readonly text: string
  /** The complete content the body was cut from. */
  readonly full: string
  /** Which tool call this row folds: DSH's own `callId` carried out verbatim; a row that folds no call carries none. */
  readonly callId?: string
  /**
   * The moment of the event this row folds, in epoch milliseconds: the row's
   * identity across redraws, read the same way every beat, so a drawing that
   * keys on it updates a row in place instead of remounting it. Absent on a
   * live tail, which is a buffer's newest slice and not an event of its own.
   */
  readonly at?: number
  /**
   * The streaming step's own tail: this row is a live buffer's newest slice, cut anew as the step
   * streams and redrawn at the animation frame, and it folds away when the step's message settles
   * into the ordinary rows above it. Absent on a settled row.
   */
  readonly live?: boolean
}

/**
 * How a conversation's last turn ended, read off DSH's own `turn/end` event and
 * carried verbatim: this module judges nothing about it, the drawing words it.
 *
 * The vocabulary is DSH's (`TurnEndReason`, merge-extensible there), so both
 * fields stay open: `kind` is `completed` for a turn the model closed itself,
 * `aborted` for a cancellation, `interrupted` for a turn the log had left open
 * when the process died, `error` for a failed turn, and `blocked` / `max-tokens`
 * / `forked` for the other ways one ends. `cause` is the cancellation's own
 * cause — `user`, `parent`, `hook`, `disposed`, `legacy` — present only when the
 * kind is `aborted`. A kind this reading has never seen is carried as it is: an
 * unknown ending is still an ending, and never read as `completed`.
 */
export interface OverviewEnding {
  /** DSH's own reason kind, verbatim. */
  readonly kind: string
  /** The cancellation cause, when `kind` is `aborted`. */
  readonly cause?: string
}

/** One window on the overview. */
export interface OverviewWindow {
  /** Which session it is. */
  readonly id: string
  /** Its title: the node's own when it works one, else the name its dispatcher gave it, else the list's own label; absent when none is written. */
  readonly title: string | null
  /** The node's weight, read the engine's way: written `light` is light, anything else standard; absent without a node. */
  readonly weight: 'light' | 'standard' | null
  /** The node's mode, unwritten meaning `auto` — the engine's own default; absent without a node. */
  readonly mode: string | null
  /** When the conversation started: the earliest moment its own events carry; absent when none does. */
  readonly startedAt: Date | null
  /**
   * How long it has been running, in whole seconds: from {@link startedAt} to the
   * moment this reading was taken while the running bit says alive, and to the
   * conversation's own last word once it is over — a window nobody is in must
   * not keep counting. Absent when there is no start to count from.
   */
  readonly elapsedSeconds: number | null
  /** The rows it draws: the most recent it has room for, in the order they happened. */
  readonly rows: readonly OverviewRow[]
  /**
   * Which call dispatched this window: the main window's row whose `callId` is
   * this one is the anchor. Absent when no exact pairing is read off the log —
   * never stood in for by a neighbour in the log, a moment, or a title. The
   * field is either a call id or not there at all.
   */
  readonly dispatchCallId?: string
  /**
   * Whether this window's conversation is over: true when the session list's
   * running bit is not true. It says the rows will not move again — nothing
   * more. A conversation stops for many reasons, and only {@link delivered}
   * says the piece of work was handed in. A child carries it only as a **ghost**
   * — a leg that stopped while the record has still not delivered its work, and
   * while no other leg of the line runs, which keeps its window so the debt has
   * somewhere to be read; a leg that is still moving carries nothing. Absent
   * means it is running.
   */
  readonly settled?: boolean
  /**
   * Whether the record says this window's work is handed in: its node is
   * delivered, no gate stands on it, and the conversation is over — while it
   * still runs, the record's word belongs to the previous round. This is the one
   * fact the check is drawn on — never the conversation being quiet.
   */
  readonly delivered?: boolean
  /**
   * Whether this window owes work that nobody is doing: its node is still owed
   * by a line, its session is not alive, its last turn can be read — stopped,
   * disposed of by the host, interrupted, failed, or closed by itself with
   * nobody taking the work up — and the line has stopped, meaning no leg of this
   * pipeline is running. A conversation that merely yielded to work of its own
   * (waiting for a leg it dispatched), or one that ran again since its abort, is
   * not this: the pipeline is still moving, so nothing is stuck. A ghost leg
   * carries it too — a leg that stopped while the record still has not delivered
   * its work is the case a ghost exists for.
   */
  readonly alert?: boolean
  /**
   * How the conversation's last turn ended, verbatim off DSH's own `turn/end`
   * reason ({@link OverviewEnding}): the fact a reader is told the reason with.
   * Absent when no `turn/end` is readable in the window's own events.
   */
  readonly ending?: OverviewEnding
  /**
   * Whether this window stands at a person's gate: the record named this session
   * as one whose node owes a person a word — a checkpoint (delivered, not
   * approved, and the line not yet walked past it) or a manual node nobody has
   * started — **and** the conversation is at rest. A gate is a stop: a window
   * still running is being worked, so it is waiting on nobody. That judgment is
   * the record's own (`readProject`'s node gate), read into the packet's cell
   * verdicts; this module carries the fact the packet states and never re-reads
   * the record for it. Only the main window carries it, and the drawing reads it
   * before anything else: a window at the gate is drawn as waiting, never as
   * finished and never as broken.
   */
  readonly waiting?: boolean
}

/**
 * One leg of the line the stage can be switched to: the node rail's entry.
 *
 * The stage draws **one** node's conversation — the main window and the sessions
 * that conversation itself dispatched — and every other leg of the line stands on
 * the rail as a bar. The rail is a switch, never an index: a press on a bar hands
 * the leg's session back to the caller, and which conversation the stage draws is
 * the caller's pick. Nothing is drawn for a leg that was not picked, so two steps
 * of one line never share a page.
 *
 * A leg carries no rows of its own: its window is read when it is picked. What the
 * bar needs is the one number it has always been drawn from — how many rows that
 * window would hold — and that is measured here, from the same events, so the
 * ruler and the window can never disagree.
 */
export interface OverviewLeg {
  /** Which session this leg is: what a press hands back. */
  readonly id: string
  /** Its title: the node's own, the same word its window's nameplate prints; absent when it works no node. */
  readonly title: string | null
  /** How many rows its window would draw at this moment — the bar's own length, and no other reading. */
  readonly rows: number
  /** Whether it stands at a person's gate: the bar's amber ink, the record's own reading carried as it is — worn only at rest, because a step still running is being worked and not waiting on anybody. */
  readonly waiting?: boolean
  /** Whether it owes work nobody is doing: the bar's break ink, carried the same way. */
  readonly alert?: boolean
}

/**
 * How the stage's subject was chosen, which is a different fact from which window it
 * is. A person's pick and a change of the conversation the panel stands in are asks:
 * the stage takes them at once. The line's own answer is a hand-over: the page the
 * reader was reading is a step that has finished and left, and the stage moves on to
 * where the line stands now — the drawing closes the old page and opens the new one.
 */
export type OverviewMainFrom = 'pick' | 'seat' | 'line' | 'view'

/** The overview's reading at this snapshot. */
export interface OverviewReading {
  /**
   * The main window: the conversation this panel's pipeline owns — the one the
   * reader picked on the rail when there is a pick, else its own session while the
   * record has not delivered it, else a step of the line still being worked, else a
   * named one still running, else the named one that moved last. Absent when the
   * record names none of the list's sessions: the stage stays empty rather than
   * showing a conversation the pipeline never mentioned. It is the only window that
   * can carry {@link OverviewWindow.waiting}, and the only one the gate and the
   * delivery are read for.
   */
  readonly main: OverviewWindow | null
  /**
   * How {@link main} was chosen ({@link OverviewMainFrom}); absent with no window. It
   * says nothing about *which* conversation is drawn — that is `main.id` — only about
   * the ask behind it, which is what the drawing reads to know whether a replacement
   * is a hand-over or an instant swap.
   */
  readonly mainFrom: OverviewMainFrom | null
  /**
   * The child windows, oldest first: the **subagent conversations this main window
   * dispatched** — the list's running rows whose parent is the main session — plus
   * the ghosts of a child its own dispatch cut short while the main still owes that
   * work, at most five, taken anew at every read. A node's own session is never a
   * child however it was dispatched: it is a leg ({@link legs}), because a pipeline
   * step is not a subagent of the step that happened to open it. A child that ended
   * owing nothing is not here, and neither is one with nothing readable: its window
   * leaves the page by the client's leave animation.
   */
  readonly children: readonly OverviewWindow[]
  /**
   * Every session the snapshot parents to the main window, **before** the
   * five-window cap: the drawn {@link children} are at most five windows of
   * these, and a child that ended — even one no seat keeps — is in here all the
   * same. This is the panel's watch list: a child's own log decides whether its
   * seat stays (the ghost's `turn/end`, read at the beat its dispatcher's cell
   * was still held), so that log has to be open before the seat exists, and the
   * cap must not fold a log this reading itself still reads. The snapshot's own
   * shape (`byId`, `parentId`) is read here and nowhere else — the shell never
   * re-spells it.
   */
  readonly mainChildIds: readonly string[]
  /**
   * The legs this stage can be switched to, in the reading's own order — the node
   * rail's entries and never windows. The set is the steps of the line still on the
   * table: the record-named legs the list calls running, the ones that stopped while
   * the record still owes their work (a ghost standing where the line stands), the
   * ones at a person's gate, and the main window's own leg, which is drawn lit. A leg
   * the record has delivered and left, and that owes nobody a word, is on none of
   * them: it owes nobody a look either.
   */
  readonly legs: readonly OverviewLeg[]
  /**
   * How many window seats the five-window cap folded away — a count, never a
   * window: 0 is 0. Dead seats count with live ones: the ghost seats stand after
   * the running children on the same column and compete for the same five, so a
   * seat the cap left out is counted here whatever its conversation is doing. A
   * session dropped for having nothing readable was never a window, so it is not
   * counted here either.
   */
  readonly hiddenChildren: number
}

/** What the overview's reading reads. */
export interface OverviewInput {
  /** The session-list snapshot as the browser holds it. */
  readonly sessions: OverviewSnapshot
  /** Each session's own events, keyed by session id; a session with none here draws none. */
  readonly events?: Readonly<Record<string, readonly OverviewEvent[]>>
  /**
   * Each session's transient live chunks, keyed by session id — DSH's own
   * `assistant/live-chunk` entries passed through verbatim by the forwarding
   * half. These are the conversation's Client-only presentation, never history:
   * they fold into the streaming step's tail rows and nothing else, and the
   * step's settlement retires them, so a session with none here (or none left)
   * draws no tail at all.
   */
  readonly live?: Readonly<Record<string, readonly OverviewEvent[]>>
  /**
   * The record's verdicts about the cells its sessions work, assembled once
   * ({@link readJudgement}): which cell each session works, and what the record
   * says about each cell. This module only carries them — it re-reads no record
   * and invents no verdict — so a cell's judgement is spelled in exactly one
   * place, and a new one is added there instead of in every list here.
   *
   * Absent, no session works a cell: every verdict is "the record says nothing",
   * which is what a caller with no record side at all hands over.
   */
  readonly judgement?: OverviewJudgement | undefined
  /** The nodes' records verbatim: a window's nameplate reads its title and its two readings here. */
  readonly nodes?: Readonly<Record<string, SuperworkerNode>>
  /** How many rows a window has room for; the most recent are kept. Absent means no cut. */
  readonly capacity?: unknown
  /**
   * Every session this workspace's record names — the node notes' `run` /
   * `discussion` entries. These are the **only** conversations the overview may
   * draw as its main window: a session the pipeline never named belongs to
   * something else, however open it is in the browser.
   *
   * Supplied as an empty array, the pipeline names nothing and no window is
   * drawn — better an empty stage than an unrelated conversation. Absent
   * altogether means the caller has no record side at all, and only then does
   * DSH's own `retainedBy.mainView` marker decide (see {@link OverviewSessionRow.retainedBy}).
   */
  readonly pipelineSessions?: readonly unknown[] | undefined
  /**
   * Which conversation this panel **stands in**, when the seat says so — DSH's
   * own `sessionId` for the cell the panel is mounted in. It is the main window
   * whenever the record names it: the reader's own conversation is the one they
   * expect to see, running or not.
   *
   * A seat that says nothing — the panel's own full page has no conversation of
   * its own — leaves this absent, and the browser's currently-open conversation
   * is **not** read in its place. A guess off `retainedBy.mainView` (or the
   * list's head) is the browser's fact, not the line's: it names whichever tab
   * the reader last had open, so a refresh would land the stage on an old step
   * of the pipeline. The stage follows the line instead (see {@link mainIdOf}).
   */
  readonly ownSession?: unknown
  /**
   * The leg the reader picked on the node rail, by session id: the one conversation
   * the stage draws, whatever the fallback rule would have picked.
   *
   * It wins over everything — including the panel's own session — because it is the
   * one thing on this input that a person said. An id the list does not hold is no
   * pick at all: the stage falls back rather than drawing a conversation this host
   * cannot see (a leg that just left its list, or a pick made in another workspace).
   */
  readonly shownSession?: unknown
  /**
   * The moment this reading is taken at, in epoch milliseconds (a moment string is
   * read the same way, the convention every other moment on this input follows).
   * It is read for one thing only: how long a window has been running
   * ({@link OverviewWindow.elapsedSeconds}), which is measured to it while the
   * conversation still runs. Absent, no running span is stated at all — a window
   * that cannot say how long it has run says nothing rather than a number
   * measured from the wrong end.
   */
  readonly at?: unknown
}

/**
 * The record's verdicts about one cell, as far as the overview reads them.
 *
 * One cell, one entry: the words a window's state is drawn from are read off
 * this and nowhere else, so a step's window and the rail's bar for that same step
 * can never be given two verdicts. What each word means is the record's own
 * judgement, made where the record is read; this layer only carries it.
 */
export interface OverviewCellVerdict {
  /**
   * Whether a person is owed a word here: a **checkpoint** (delivered, that
   * delivery not approved, and the line not yet walked past it), a cell put out to
   * wait (`shelved`), or a **manual** node nobody has started. A gate is a person
   * being owed, never a conversation being quiet; the manual kind therefore only
   * counts while no line holds the cell.
   */
  readonly waiting: boolean
  /** Whether the record calls this cell's work delivered: its state is `completed`. The one fact the check is drawn on. */
  readonly delivered: boolean
  /**
   * Whether a line still holds this cell: the record's own `running` reading. It is
   * the debt a red window is drawn on, and it is narrower than "not delivered" on
   * purpose — a cell nobody has started and nobody holds is the line's next work,
   * not money owed.
   */
  readonly held: boolean
  /**
   * Whether this cell's work was **handed in**: a handoff ticket on disk stating a
   * verdict (anything but `pending`, the mark a re-run leaves). It is the proof a
   * stopped conversation is read against, and it exists because the conversation's
   * own log cannot give that proof: DSH closes a turn with the same `completed`
   * word whether the step delivered or gave up first.
   */
  readonly handed: boolean
  /**
   * Whether the claim on this cell outlived the session it names: a claim on disk,
   * the cell still held by a line, and that session absent from this host's live
   * agents. It is the one debt that can be named as owed by nobody.
   */
  readonly stranded: boolean
}

/**
 * The judgement packet: the record's verdicts about its cells, keyed by node id,
 * with each cell's session turned round beside them — assembled once, by
 * {@link readJudgement}, and read here and by the shell's watch list.
 */
export interface OverviewJudgement {
  /**
   * Which cell each session works, keyed by session id: the record's session notes
   * turned round once. A session absent from here works no cell of the record, and
   * then no verdict about a cell applies to it.
   */
  readonly nodeOf: Readonly<Record<string, string>>
  /**
   * Each cell's verdicts, keyed by node id: every cell the project holds, **plus** every cell a
   * session is noted for even when the project has since let it go. An entry for a cell the project
   * no longer states is a cell whose delivery is unproved — `delivered` is false there, not because
   * the record denied it, but because nothing can state it — while its other words come from the
   * ticket and the claim read by node id. So a reader sees an entry for every cell a session works,
   * and `cells[id] === undefined` means only "no session is noted for this cell".
   */
  readonly cells: Readonly<Record<string, OverviewCellVerdict>>
  /**
   * The session the pipeline's own delivery lands on: the conversation the panel
   * reads the workspace for, when every cell **the project holds** has been
   * delivered and that conversation works none of them itself. The whole pipeline
   * handing itself in is what that conversation carries, even with no cell of its
   * own; `null` while any cell of the project is still owed, and when that session
   * works a cell (its own cell then says so, and one fact is never said twice).
   *
   * It is a verdict about the project's cells, not about every debt the record
   * carries: a session noted for a cell the project has let go of is owed
   * ({@link OverviewJudgement.owed}) without clearing this one, so the two can be
   * true at once — the project's work is all in, and one leg is still owed a look.
   */
  readonly pipelineDeliveredOn: string | null
  /**
   * The sessions whose work the record still owes: every session working a cell
   * its own record has not delivered, plus any session the record names as owing
   * work with no cell of its own to say it on.
   *
   * It is one fact, assembled here, and the window a stopped leg keeps hangs off
   * it: the stage shows where the line stands **now**, so a leg the record has not
   * delivered keeps its window (and the shell keeps its log open) after its
   * conversation stopped, because the window is the only place that debt is said.
   * Read off the packet rather than derived again by each reader, so the ids the
   * stage draws its ghosts from and the ids the shell keeps open cannot disagree.
   */
  readonly owed: readonly string[]
}

/** What the judgement packet is assembled from: the record-side facts, one entry each. */
export interface JudgementInput {
  /** Which session works each node — the record's session notes read (`readSessions`), keyed by node id. */
  readonly sessions: Readonly<Record<string, string>>
  /** The project's node readings, keyed by id: a cell's gate, delivery and hold are read off them. */
  readonly nodes: Readonly<Record<string, NodeReading>>
  /** The nodes the dispatch reading calls stranded, keyed by node: the cycle whose claim outlived its session. */
  readonly stranded?: Readonly<Record<string, string>> | undefined
  /** The cells whose work was handed in, keyed by node: the handoff tickets on disk, verdict already read. */
  readonly handed?: Readonly<Record<string, string>> | undefined
  /**
   * The sessions a caller knows to owe work that no cell of the record can say on its
   * behalf — a site with no record side, or a step whose cell the record has already let
   * go of. Each one is carried into {@link OverviewJudgement.owed} as it comes; the
   * judgements about cells are not touched, because a session with no cell has no cell
   * verdict to touch.
   */
  readonly owedSessions?: readonly unknown[] | undefined
  /** The conversation this panel reads the workspace for — the one the pipeline's own delivery lands on. */
  readonly panelSession?: unknown
}

/** The drawn row each tool name folds into. A name outside the four sets is a tool this fold does not know, and folds as the neutral `tool`. */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'read_image'])
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])
const RUN_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])
const DISPATCH_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork', 'subagent_continue', 'ralph'])

function callKindOf(name: string): OverviewRowKind {
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (RUN_TOOLS.has(name)) return 'run'
  if (DISPATCH_TOOLS.has(name)) return 'dispatch'
  return 'tool'
}

/**
 * The one thing a call's row names, read off the tool's own arguments: the
 * file a read or write touched, the command a run spelled, the task a dispatch
 * named. An argument that is not there leaves the tool's own name as the body;
 * nothing is invented in its place.
 */
function subjectOf(kind: OverviewRowKind, name: string, args: Record<string, unknown> | undefined): string {
  const path = text(args?.file_path) ?? text(args?.path)
  if (kind === 'read' || kind === 'write') return path ?? name
  if (kind === 'run') return text(args?.command) ?? name
  if (kind === 'dispatch') return text(args?.description) ?? text(args?.name) ?? name
  return text(args?.word) ?? text(args?.description) ?? name
}

function rowsOf(snapshot: OverviewSnapshot): Readonly<Record<string, OverviewSessionRow>> {
  return asRecord(snapshot.byId) as Readonly<Record<string, OverviewSessionRow>> | undefined ?? {}
}

function listedIds(snapshot: OverviewSnapshot): readonly string[] {
  if (!Array.isArray(snapshot.ids)) return []
  return snapshot.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * DSH's own main-view marker: the row whose `retainedBy.mainView` is over zero.
 *
 * This is a browser-side count — who holds the session open right now — and
 * says nothing about which conversation belongs to this workspace's pipeline.
 * It is read in exactly one place: a caller that hands over no record side and
 * no session of its own (see {@link OverviewInput.pipelineSessions}).
 */
function mainViewOf(rows: Readonly<Record<string, OverviewSessionRow>>): string | undefined {
  for (const row of Object.values(rows)) {
    const count = asRecord(row?.retainedBy)?.mainView
    if (typeof count !== 'number' || count <= 0) continue
    const id = row?.id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/**
 * The sessions the pipeline record names, or `undefined` when the caller said
 * nothing at all (which is a different fact from "the record names none").
 */
function pipelineOf(input: OverviewInput): ReadonlySet<string> | undefined {
  if (!Array.isArray(input.pipelineSessions)) return undefined
  const named = new Set<string>()
  for (const id of input.pipelineSessions) {
    if (typeof id === 'string' && id.length > 0) named.add(id)
  }
  return named
}

/** When the list last moved a row: epoch milliseconds, 0 when it says nothing readable. */
function movedAtOf(row: OverviewSessionRow | undefined): number {
  return toEpoch(row?.updatedAt) ?? 0
}

/** The moment a reading was taken at, read the same way a row's own moment is; absent says nothing. */
function atOf(raw: unknown): Date | null {
  const ms = toEpoch(raw)
  return ms === null ? null : new Date(ms)
}

/**
 * The newest of these sessions: the one whose row the list moved last, ties
 * falling to the later arrival in the list's own order. Unwritten moments read
 * as 0, so a list that carries none still answers with an arrival-order pick.
 */
function latestOf(
  ids: readonly string[],
  rows: Readonly<Record<string, OverviewSessionRow>>,
  order: readonly string[],
): string | undefined {
  let best: string | undefined
  let bestMoment = Number.NEGATIVE_INFINITY
  let bestAt = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const moment = movedAtOf(rows[id])
    const at = order.indexOf(id)
    if (best === undefined || moment > bestMoment || (moment === bestMoment && at > bestAt)) {
      best = id
      bestMoment = moment
      bestAt = at
    }
  }
  return best
}

/**
 * Which conversation is the main window — the one rule, in the order it reads, and
 * the ask behind it:
 *
 * 1. the leg the reader picked on the rail, while the list still holds it — a
 *    person's pick outranks every reading here;
 * 2. the conversation the panel stands in, when the seat says which one it is:
 *    the reader's own conversation, while it is still the line's to read. A seat
 *    the record has delivered — and no gate stands on it — has said its last word
 *    (its check), so it keeps the stage only while no other step of the line is
 *    **being worked**; with one running, the stage follows it. That is what lets a
 *    reader who stayed on a finished step's page watch the line go on, and what
 *    keeps the check when the line has really stopped. A seat that says nothing is
 *    not stood in for — the browser's open conversation is no reading of the line
 *    (see {@link OverviewInput.ownSession});
 * 3. else the step the record holds **and** whose conversation still runs: where
 *    the line is being worked this moment. It leads the held-but-stopped step on
 *    purpose — a step that has finished owes the stage its check, not its page,
 *    while a sibling is still being worked;
 * 4. else the step the record holds that has not left the line (a gate, or a debt
 *    nobody is working): that stop *is* where the line stands;
 * 5. else a named session the list still calls running (the newest of them when
 *    several are);
 * 6. else the one the record names that moved last;
 * 7. else nothing — no window at all, rather than a conversation the pipeline
 *    never mentioned.
 *
 * A named session the list does not hold is no window either, and it is never
 * stood in for by one the pipeline does not name: an unknown is unknown.
 *
 * Only a caller that says nothing about the pipeline — no named set, no session
 * of its own — falls back to DSH's `retainedBy.mainView` marker, which is the
 * browser's own "who has this open" count and no reading of the record.
 */
function mainIdOf(
  input: OverviewInput,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  order: readonly string[],
  held: ReadonlySet<string>,
  left: (id: string) => boolean,
): { readonly id: string; readonly from: OverviewMainFrom } | undefined {
  /* The pick is asked of the same list as everything else: a leg that left the
     list is no pick, and the fallback answers instead of a stale id. */
  const shown = text(input.shownSession)
  if (shown !== undefined && rows[shown] !== undefined) return { id: shown, from: 'pick' }
  const named = pipelineOf(input)
  if (named === undefined) {
    const marker = mainViewOf(rows)
    return marker === undefined ? undefined : { id: marker, from: 'view' }
  }
  const candidates = [...named].filter((id) => rows[id] !== undefined)
  const self = text(input.ownSession)
  if (self !== undefined && named.has(self)) {
    if (rows[self] === undefined) return undefined
    /* A seat that has left the line hands the stage over — but only to a step that is **being
     * worked** right now, and only because that is the page the line has moved on to. Nothing of
     * the line running means the check is the last word the stage has to say, and it stays where
     * the reader is looking; a step that stopped owing work keeps its bar either way. */
    const worked = candidates.some((id) => id !== self && rows[id]?.running === true)
    if (!(left(self) && worked)) return { id: self, from: 'seat' }
  }
  /* The step being worked right now is the line's own subject: it is the one reading
     that does not wait on the browser's liveness bit or its last-moved moment. A
     held but stopped step is read after it, because a step that stopped with its
     work owed is where the line stands only while nothing of the line still moves. */
  const live = candidates.filter((id) => held.has(id) && rows[id]?.running === true)
  const liveId = latestOf(live, rows, order)
  if (liveId !== undefined) return { id: liveId, from: 'line' }
  const stuck = candidates.filter((id) => held.has(id) && !left(id))
  const stuckId = latestOf(stuck, rows, order)
  if (stuckId !== undefined) return { id: stuckId, from: 'line' }
  const running = candidates.filter((id) => rows[id]?.running === true)
  const runningId = latestOf(running, rows, order)
  if (runningId !== undefined) return { id: runningId, from: 'line' }
  const last = latestOf(candidates, rows, order)
  return last === undefined ? undefined : { id: last, from: 'line' }
}

/**
 * The one-sentence body: cut at the first sentence end, else at the first line
 * break, else not at all. A full stop inside a word — a path's `d.ts` — is no
 * boundary: only a terminator followed by whitespace ends a sentence, so a
 * body never cuts a file name or a route word in half.
 */
function firstSentence(full: string): string {
  for (let at = 0; at < full.length; at++) {
    const mark = full[at]
    if (mark === '\n' || mark === '\r') return full.slice(0, at)
    if (mark === '。' || mark === '！' || mark === '？') return full.slice(0, at + 1)
    if (mark === '.' || mark === '!' || mark === '?') {
      const after = at + 1 < full.length ? full[at + 1] : ' '
      if (after === ' ' || after === '\t') return full.slice(0, at + 1)
    }
  }
  return full
}

/**
 * One row, only when there is something to say: no content, no row — and no
 * sentence, no row either. A body that opens with a line break cuts to an
 * empty sentence (a run result whose output opens with a blank line does:
 * PowerShell's tables all do), and a row with no sentence would draw as its
 * word and the separator alone. Its call's row already stands above it.
 */
function pushRow(rows: OverviewRow[], kind: OverviewRowKind, full: string | undefined, at: number | undefined): void {
  if (full === undefined || full.length === 0) return
  const cut = firstSentence(full)
  if (cut.length === 0) return
  rows.push({ kind, text: cut, full, ...(at === undefined ? {} : { at }) })
}

/* ---- the live step's tails --------------------------------------------------
 *
 * A conversation streams its step out chunk by chunk, and the reader watching
 * from the overview reads "alive" off a row that moves with it: the newest
 * slice of what the step is writing now, shown at the line's end. DSH's own
 * conversation half does the same dance — live chunks as Client-only transient
 * events, redraws published at the animation frame, the step's settlement
 * retiring the chunks — and these tails are this panel's reading of those
 * entries, never a second stream of its own.
 */

/**
 * How much of the live buffer a tail row keeps. The cut bounds the string the
 * row redraws every frame; what still does not fit the drawn row is the
 * drawing half's head crop, not this number's business.
 */
const LIVE_TAIL_LIMIT = 120

/**
 * The buffer's tail: its newest line, whitespace runs collapsed, cut to the
 * newest characters. A line break is where the newest content starts, so an
 * earlier finished line yields to the one being written — and a trailing break
 * (the newest line not yet begun) yields back to the line just finished, so
 * the row never goes blank between the two.
 */
function tailOf(buffer: string, limit: number): string {
  let cut = buffer.length
  while (cut > 0) {
    const start = buffer.lastIndexOf('\n', cut - 1) + 1
    const line = buffer.slice(start, cut).replace(/\s+/gu, ' ').trim()
    if (line.length > 0) {
      if (line.length <= limit) return line
      const tail = line.slice(-limit)
      /* A cut through a surrogate pair would print half a glyph: an orphaned
       * half at the slice's head is dropped, a whole pair kept. */
      const head = tail.charCodeAt(0)
      const next = tail.charCodeAt(1)
      const orphaned = head >= 0xd800 && head <= 0xdbff
        ? !(next >= 0xdc00 && next <= 0xdfff)
        : head >= 0xdc00 && head <= 0xdfff
      return orphaned ? tail.slice(1) : tail
    }
    cut = start === 0 ? 0 : start - 1
  }
  return ''
}

/**
 * The rows a window draws while its step streams: at most two, the thinking
 * tail and then the spoken tail, each the newest slice of that buffer. A
 * buffer that says nothing (whitespace, tool arguments, a chunk the fold does
 * not read) draws no row; a retry's chunks arrive under a new attempt id, and
 * the tails follow the newest attempt rather than mixing the two.
 */
function liveRowsOf(events: readonly OverviewEvent[] | undefined): readonly OverviewRow[] {
  let think = ''
  let spoken = ''
  let attempt: unknown
  for (const event of events ?? []) {
    if (text(event.type) !== 'assistant/live-chunk') continue
    const data = asRecord(event.data)
    if (data === undefined) continue
    if (data.attemptId !== attempt) {
      attempt = data.attemptId
      think = ''
      spoken = ''
    }
    const chunk = asRecord(data.chunk)
    const kind = text(chunk?.type)
    const delta = typeof chunk?.text === 'string' ? chunk.text : ''
    if (delta.length === 0) continue
    if (kind === 'reasoning-delta') think += delta
    else if (kind === 'text-delta') spoken += delta
  }
  const rows: OverviewRow[] = []
  const thinkTail = tailOf(think, LIVE_TAIL_LIMIT)
  if (thinkTail.length > 0) rows.push({ kind: 'think', text: thinkTail, full: thinkTail, live: true })
  const spokenTail = tailOf(spoken, LIVE_TAIL_LIMIT)
  if (spokenTail.length > 0) rows.push({ kind: 'output', text: spokenTail, full: spokenTail, live: true })
  return rows
}

/** The text a message's own content blocks carry, when it carries any. */
function contentTextOf(message: Record<string, unknown> | undefined): string | undefined {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const held = asRecord(block)
    if (held?.type === 'text' && typeof held.text === 'string' && held.text.length > 0) parts.push(held.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * One assistant message folds into at most two rows: its reasoning into a
 * `think` row, its text into an `output` row. The tool calls an assistant
 * message carries make no rows here — the log writes each of them again as its
 * own `tool/call` event, and one call must not become two rows.
 */
function foldAssistant(data: Record<string, unknown> | undefined, rows: OverviewRow[], at: number | undefined): void {
  const message = asRecord(data?.message)
  const content = message?.content
  if (!Array.isArray(content)) return
  const thinking: string[] = []
  const spoken: string[] = []
  for (const block of content) {
    const held = asRecord(block)
    const blockText = typeof held?.text === 'string' ? held.text : ''
    if (held?.type === 'reasoning' && blockText.length > 0) thinking.push(blockText)
    if (held?.type === 'text' && blockText.length > 0) spoken.push(blockText)
  }
  pushRow(rows, 'think', thinking.length > 0 ? thinking.join('\n') : undefined, at)
  pushRow(rows, 'output', spoken.length > 0 ? spoken.join('\n') : undefined, at)
}

/**
 * One `user/message` folds into an `input` row — the conversation's prompt, the
 * one line above the reply that is not the conversation's own.
 *
 * The row is drawn for a **person's** words and for nothing else. DSH writes
 * every user-role message through this one event, and its `source` is what
 * tells the kinds apart: a direct human prompt (or a dispatch's prompt, or a
 * continued child's) carries `kind: 'user'`, while the context the harness
 * injects for itself (a runtime snapshot, a workspace instruction file, the
 * skill catalog, a settled-child notice, a hook's word) carries its own
 * producer's `kind`. Those are not what the conversation was asked; drawing
 * them would bury the prompt under the machinery that delivers it. A message
 * with no readable `source` is none of them either — the kind is required on
 * every one of these events, so an absent one is not read as a person speaking.
 *
 * The message's blocks are the event's own `data.content`, **not** a nested
 * `data.message` — this event type is the surface message already, where an
 * assistant's is wrapped. A dispatch prompt is `kind: 'user'` too, and it is
 * drawn as the row: for a child window the prompt it was handed *is* what
 * opened it, and a window whose first row is already its own answer says
 * nothing about what it was doing there.
 */
function foldInput(data: Record<string, unknown> | undefined, rows: OverviewRow[], at: number | undefined): void {
  if (text(asRecord(data?.source)?.kind) !== 'user') return
  pushRow(rows, 'input', contentTextOf(data), at)
}

/** The call's own arguments, as an object; arguments that are not parsable text read as none. */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * One tool call folds into one row, named by the tool's own arguments. The
 * call's own id rides the row verbatim — a result or a child's dispatch anchor
 * answers by it — while a run's id is also kept aside, since only a run's
 * result is worth a row of its own. The id is kept before the sentence is cut,
 * so a call whose body cuts to nothing (a command opening on a line break)
 * still answers for its result without drawing its own wordless row.
 */
function foldCall(
  data: Record<string, unknown> | undefined,
  rows: OverviewRow[],
  runCalls: Set<string>,
  at: number | undefined,
): void {
  const name = text(data?.name)
  if (name === undefined) return
  const kind = callKindOf(name)
  const callId = text(data?.callId)
  if (kind === 'run' && callId !== undefined) runCalls.add(callId)
  const subject = subjectOf(kind, name, parseArguments(data?.arguments))
  const cut = firstSentence(subject)
  if (cut.length === 0) return
  rows.push({
    kind,
    text: cut,
    full: subject,
    ...(callId === undefined ? {} : { callId }),
    ...(at === undefined ? {} : { at }),
  })
}

/**
 * One tool result folds into a row only when it says something on its own: a
 * failure, whose reason is user-facing words kept outside the model's content,
 * or a run's output answering the call before it. Every other result — a
 * file's contents, an edit's receipt — is material the feed does not repeat:
 * its call's row already says what happened.
 */
function foldResult(
  data: Record<string, unknown> | undefined,
  rows: OverviewRow[],
  runCalls: ReadonlySet<string>,
  at: number | undefined,
): void {
  const message = asRecord(data?.message)
  const error = asRecord(data?.error)
  if (error !== undefined) {
    pushRow(rows, 'fail', text(error.reason) ?? contentTextOf(message) ?? text(error.code) ?? text(error.name), at)
    return
  }
  const callId = text(message?.toolCallId) ?? text(asRecord(message?.source)?.callId)
  if (callId === undefined || !runCalls.has(callId)) return
  pushRow(rows, 'run', contentTextOf(message), at)
}

/**
 * What a v0 dispatch result spells before the child's token: `started subagent
 * <token>` for a fresh child, `started continued subagent <token>` for one a
 * continuation opened. In v0 the token is the child session's id.
 */
const ACTIVATION_MARKER = /^started (?:continued )?subagent (\S+)/

/**
 * The token one dispatch result names its child by: v3 writes it as the
 * activation's own `name`, v0 writes it only into the sentence. Both are the
 * same word — the child's name in v3, the child's id in v0 — and a result that
 * spells neither names no child at all.
 */
function activationTokenOf(data: Record<string, unknown> | undefined): string | undefined {
  const named = text(asRecord(data?.meta)?.name)
  if (named !== undefined) return named
  const spelled = contentTextOf(asRecord(data?.message))
  if (spelled === undefined) return undefined
  return ACTIVATION_MARKER.exec(spelled)?.[1]
}

/**
 * Which call of the main session's own log dispatched which child window.
 *
 * The anchor is an identity, never an order. A dispatch call's result names the
 * child it started (v3 by the activation's `name`, v0 by the id its sentence
 * spells); the parent's own `subagent/catalog` carries that same token — `name`
 * in v3, the entry's own `childId` in v0 — beside the child session's id, and
 * that is the whole chain.
 *
 * `subagent_continue` is the one dispatch that also names a session in its own
 * arguments, and that id is the session it was asked to continue — the child the
 * call *opens* is a new one (a continuation writes a fresh `subagent/catalog` at
 * its own moment, under an id the arguments never carry). So the chain decides
 * first, and `arguments.sessionId` is read only when the answer names no child at
 * all: that is the one case where the arguments are the only identity there is.
 *
 * Unread on purpose: a catalog's `label` (a synthesized title, not an identity)
 * and any neighbour in the log (concurrent dispatches interleave their catalogs,
 * so the entry next to a call belongs to whichever dispatch settled first). A
 * dispatch still in flight, or one whose result failed, anchors nothing: an
 * unknown anchor stays unknown rather than borrowing the nearest row.
 *
 * The map is child → call, so a call that started more than one child — a loop
 * dispatch — anchors every child it named under its one call id.
 */
function dispatchAnchorsOf(events: readonly OverviewEvent[] | undefined): ReadonlyMap<string, string> {
  const dispatches = new Set<string>()
  const continued = new Map<string, string>()
  const byName = new Map<string, string[]>()
  const catalogued = new Set<string>()

  for (const event of events ?? []) {
    const type = text(event.type)
    const data = asRecord(event.data)
    if (type === 'tool/call') {
      const name = text(data?.name)
      if (name === undefined || !DISPATCH_TOOLS.has(name)) continue
      const callId = text(data?.callId)
      if (callId === undefined) continue
      dispatches.add(callId)
      if (name !== 'subagent_continue') continue
      const childId = text(parseArguments(data?.arguments)?.sessionId)
      if (childId !== undefined) continued.set(callId, childId)
      continue
    }
    if (type !== 'subagent/catalog') continue
    const childId = text(data?.childId)
    if (childId === undefined) continue
    catalogued.add(childId)
    const name = text(data?.name)
    if (name === undefined) continue
    const named = byName.get(name)
    if (named === undefined) byName.set(name, [childId])
    else named.push(childId)
  }

  const tokens = new Map<string, Set<string>>()
  for (const event of events ?? []) {
    if (text(event.type) !== 'tool/result') continue
    const data = asRecord(event.data)
    const message = asRecord(data?.message)
    const callId = text(message?.toolCallId) ?? text(asRecord(message?.source)?.callId)
    if (callId === undefined || !dispatches.has(callId)) continue
    if (asRecord(data?.error) !== undefined || message?.isError === true) continue
    const token = activationTokenOf(data)
    if (token === undefined) continue
    const held = tokens.get(callId)
    if (held === undefined) tokens.set(callId, new Set([token]))
    else held.add(token)
  }

  const anchors = new Map<string, string>()
  const chained = new Set<string>()
  for (const [callId, held] of tokens) {
    for (const token of held) {
      for (const childId of byName.get(token) ?? (catalogued.has(token) ? [token] : [])) {
        if (!anchors.has(childId)) anchors.set(childId, callId)
        chained.add(callId)
      }
    }
  }
  for (const [callId, childId] of continued) {
    if (chained.has(callId) || anchors.has(childId)) continue
    anchors.set(childId, callId)
  }
  return anchors
}

function foldRows(events: readonly OverviewEvent[] | undefined): readonly OverviewRow[] {
  const rows: OverviewRow[] = []
  const runCalls = new Set<string>()
  for (const event of events ?? []) {
    const type = text(event.type)
    if (type === undefined) continue
    const data = asRecord(event.data)
    const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
    if (type === 'user/message') foldInput(data, rows, at)
    else if (type === 'assistant/message') foldAssistant(data, rows, at)
    else if (type === 'tool/call') foldCall(data, rows, runCalls, at)
    else if (type === 'tool/result') foldResult(data, rows, runCalls, at)
  }
  return rows
}

/**
 * The room cut: a window draws the most recent rows it has room for, in the
 * order they happened; what falls off the top is the fade the drawing half
 * puts there. No room stated, no cut.
 */
function capped(rows: readonly OverviewRow[], capacity: unknown): readonly OverviewRow[] {
  if (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity <= 0) return rows
  return rows.length > capacity ? rows.slice(rows.length - capacity) : rows
}

/**
 * One end of the conversation's own span: the earliest moment its events carry
 * when `latest` is false (when it started), the newest when true (when it last
 * moved). The log's stamps are epoch milliseconds and read as numbers alone —
 * the row's and the reading's epoch-or-string convention (`toEpoch` in
 * fields.ts) is not the events'; a stamp that is not a finite number is not a
 * moment here.
 */
function extremeAtOf(events: readonly OverviewEvent[] | undefined, latest: boolean): Date | null {
  let best: number | undefined
  for (const event of events ?? []) {
    const time = event.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (best === undefined || (latest ? time > best : time < best)) best = time
  }
  return best === undefined ? null : new Date(best)
}

/** When the conversation started: the earliest moment its own events carry. */
function startedAtOf(events: readonly OverviewEvent[] | undefined): Date | null {
  return extremeAtOf(events, false)
}

/**
 * When the conversation last moved: the newest moment its own events carry. It is
 * the end of the span a window that stopped is measured to — the log's own last
 * word, not the moment this reading was taken, which would keep a dead window's
 * number counting for as long as the panel stays open.
 */
function endedAtOf(events: readonly OverviewEvent[] | undefined): Date | null {
  return extremeAtOf(events, true)
}

/**
 * When the conversation's last turn ended: the moment of the log's last `turn/end`,
 * in epoch milliseconds, or nothing when it carries none. It is the conversation's
 * own last word — the moment a window that yielded to work of its own is read
 * against — and both ends of that comparison are the log's own, so nothing here is a
 * guess about a clock.
 */
function turnedAtOf(events: readonly OverviewEvent[] | undefined): number | null {
  let last: number | null = null
  for (const event of events ?? []) {
    if (text(event.type) !== 'turn/end') continue
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) continue
    last = event.time
  }
  return last
}

/** Whether a conversation was cut off rather than closing its own turn: a readable ending that is not `completed`. */
function cutShort(events: readonly OverviewEvent[] | undefined): boolean {
  const ending = endingOf(events)
  return ending !== undefined && ending.kind !== 'completed'
}

/**
 * The name the dispatching call gave a conversation, off DSH's own `subagent` projection of its log:
 * the `label` that call wrote for display — the sentence DSH's own subagent list prints as the
 * child's own line, and the one word every dispatch result names it by.
 *
 * A title is a name. The list's `displayTitle` is not one for a dispatched conversation: it is the
 * conversation's first prompt line, so a dispatch that opens with `读 <路径> ，照它做` is titled with
 * a path cut off mid-way — the one thing on the stage that says nothing about what the window is.
 * The dispatcher's label is the same fact the dispatch row itself carries, so the seat and the row
 * that opened it read as one.
 *
 * Absent for a conversation nobody dispatched — a step of the line is named by its node, and wins
 * ahead of this — and for one whose projections have not been read yet, which keeps the list's own
 * label rather than an invented one.
 */
function dispatchLabelOf(row: OverviewSessionRow): string | null {
  const subagent = asRecord(asRecord(row.projectionValues)?.subagent)
  const label = text(subagent?.label)?.trim()
  return label === undefined || label.length === 0 ? null : label
}

function titleOf(row: OverviewSessionRow, node: SuperworkerNode | undefined): string | null {
  return text(node?.title) ?? dispatchLabelOf(row) ?? text(row.displayTitle) ?? null
}

/**
 * The engine's weight word for light (`NodeWeight`, packages/superworker-core/src/types.ts:
 * "`light` is implemented by the conductor alone; `standard` takes the standard path. A
 * missing key means standard"). Only a written `light` ever lands on disk — the engine
 * writes standard back by taking the key off — so a node whose word is absent, or spells
 * anything else, is standard. This constant quotes that one word; the judgment stays the
 * engine's and is not re-derived here.
 */
const WEIGHT_LIGHT = 'light'

/**
 * The engine's own default mode word (`NodeMode`, packages/superworker-core/src/types.ts:
 * `auto` opens the next node by itself; the read side folds a missing key to `auto`).
 * Quoted, not re-written: when the engine's default moves, this is the line to move with it.
 */
const MODE_UNWRITTEN = 'auto'

/** The engine's own reading of weight: only `light` ever lands on disk, so anything unwritten or other is standard. */
function weightOf(node: SuperworkerNode | undefined): 'light' | 'standard' | null {
  if (node === undefined) return null
  return text(node.weight) === WEIGHT_LIGHT ? 'light' : 'standard'
}

function modeOf(node: SuperworkerNode | undefined): string | null {
  if (node === undefined) return null
  return text(node.mode) ?? MODE_UNWRITTEN
}

function windowOf(
  id: string,
  row: OverviewSessionRow,
  node: SuperworkerNode | undefined,
  events: readonly OverviewEvent[] | undefined,
  capacity: unknown,
  live: readonly OverviewEvent[] | undefined,
  at: Date | null,
): OverviewWindow {
  const startedAt = startedAtOf(events)
  return {
    id,
    title: titleOf(row, node),
    weight: weightOf(node),
    mode: modeOf(node),
    startedAt,
    /* A leg that is still moving is measured to the moment this reading was taken; one that stopped
       is measured to its own last word. Either way the number is a span this reading states, never a
       clock the drawing reads for itself. */
    elapsedSeconds: secondsBetween(startedAt, row.running === true ? at : endedAtOf(events)),
    /* The settled rows stand first in their existing shape; the streaming
       step's tails hang after them — at most two, and gone again once the
       step's message lands among the settled rows. */
    rows: [...capped(foldRows(events), capacity), ...liveRowsOf(live)],
  }
}

/**
 * The judgement packet's one assembly: the record's session notes turned round,
 * and every verdict the overview draws a window's state from, read off the
 * record once ({@link OverviewJudgement}).
 *
 * It lives here rather than in the shell because the judgement is a fact about
 * the record, not about the page: the words a window is drawn with — a person's
 * gate, a delivery, a hold, a ticket, a claim nobody will settle — are read where
 * the record is read, and the shell only hands the packet over. That is what keeps
 * a step's window and its rail bar from ever being given two verdicts: both read
 * this one entry.
 *
 * `stranded` and `handed` are keyed by their own word — a node id, whether or not
 * the id names a cell the project holds — because a ticket is a fact about a cell
 * the record may already have let go of, and the debt it excuses is read by node
 * id rather than by the other map's shape.
 */
export function readJudgement(input: JudgementInput): OverviewJudgement {
  const nodeOf: Record<string, string> = {}
  for (const [nodeId, session] of Object.entries(input.sessions)) nodeOf[session] = nodeId
  const stranded = input.stranded ?? {}
  const handed = input.handed ?? {}
  const cells: Record<string, OverviewCellVerdict> = {}
  /* Every cell the project holds, plus every cell a session is noted for even when the project has
     since let it go: a session the notes name works a cell, and a cell the project no longer states
     is a cell whose delivery is unproved — not a delivered one. Reading the absence as delivery
     would let such a leg leave the stage owing its work. */
  const ids = new Set<string>(Object.keys(input.nodes))
  for (const nodeId of Object.values(nodeOf)) ids.add(nodeId)
  for (const id of ids) {
    const node = input.nodes[id]
    /* The gate's three kinds, read off the record's own gate reading. A manual node is a person
       being owed only while nobody is working it: a cell a line holds is being worked, and a
       conversation being quiet is not the same fact. `shelved` is a cell put out to wait, which is
       the record asking for the person who has to decide it. */
    const waiting = node?.gate?.kind === 'checkpoint' || node?.gate?.kind === 'shelved'
      || (node?.gate?.kind === 'manual' && node.running !== true)
    cells[id] = {
      waiting,
      delivered: node?.state === 'completed',
      held: node?.running === true,
      handed: Object.hasOwn(handed, id),
      stranded: Object.hasOwn(stranded, id),
    }
  }
  /* The whole pipeline handing itself in is a verdict about the workspace, and the conversation this
     panel reads it for carries that verdict even when it works no cell of its own. A conversation
     whose own cell already says it delivered says nothing twice. */
  const panelSession = text(input.panelSession)
  const project = Object.values(input.nodes)
  const pipelineDeliveredOn = panelSession !== undefined && project.length > 0
    && project.every((node) => node.state === 'completed')
    && verdictOf({ nodeOf, cells, pipelineDeliveredOn: null, owed: [] }, panelSession)?.delivered !== true
    ? panelSession
    : null
  /* The work the record still owes, session by session: every session working a cell its own record has
     not delivered, plus the sessions a caller knows owe work with no cell of their own. A session noted
     for a cell the project no longer holds is owed too — a cell no reading can call delivered states no
     delivery, and reading that absence as one would let the leg leave the stage owing its work. */
  const owed: string[] = []
  for (const [session, nodeId] of Object.entries(nodeOf)) {
    if (cells[nodeId]?.delivered !== true) owed.push(session)
  }
  for (const session of input.owedSessions ?? []) {
    if (typeof session === 'string' && session.length > 0 && !owed.includes(session)) owed.push(session)
  }
  return { nodeOf, cells, pipelineDeliveredOn, owed }
}

/**
 * The sessions whose cell's verdict answers this: one walk over the packet, keyed by session. It is
 * the only way a session-keyed question is asked here — every one of them reads the one packet, so a
 * verdict added to a cell is read by everyone who asks about it, and never re-derived per reader.
 *
 * A session noted for a cell the project does not hold still has a verdict, and it is not "no":
 * that cell's entry is assembled anyway ({@link OverviewJudgement.cells}), with `delivered` false —
 * the one word no reading can state for a cell the project has let go of — and its other words read
 * off the ticket and the claim by node id. So such a session answers whatever those words say, quite
 * apart from delivery; only a session the notes do not map to a cell has no verdict, and answers
 * `false`.
 */
function sessionsWhere(
  judgement: OverviewJudgement | undefined,
  pick: (cell: OverviewCellVerdict) => boolean,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const [session, nodeId] of Object.entries(judgement?.nodeOf ?? {})) {
    const cell = judgement?.cells[nodeId]
    if (cell !== undefined && pick(cell)) out.add(session)
  }
  return out
}

/**
 * The sessions whose work the record still owes — the packet's own {@link OverviewJudgement.owed},
 * handed over as the list the stage outlives a conversation by and the list the shell keeps its logs
 * open for. Assembled once, in {@link readJudgement}; read by everyone who needs it, so the two can
 * never disagree.
 */
export function owedSessions(judgement: OverviewJudgement | undefined): readonly string[] {
  return judgement?.owed ?? []
}

/**
 * One cell's verdict, or none: a session that works no cell of the record has no
 * verdict to answer with, and so reads `undefined` here. Which ids have an entry at
 * all is the packet's own statement ({@link OverviewJudgement.cells}) — this reader
 * only turns a session into the cell it works, and states nothing about the map.
 */
function verdictOf(judgement: OverviewJudgement | undefined, id: string): OverviewCellVerdict | undefined {
  const node = nodeIdOf(judgement, id)
  return node === undefined ? undefined : judgement?.cells[node]
}

/**
 * The node a session works, by id; a session that works none — or a caller with no
 * record side at all — names no node.
 */
function nodeIdOf(judgement: OverviewJudgement | undefined, id: string): string | undefined {
  return judgement?.nodeOf[id]
}

/** Whether this session's cell handed its work in: a ticket on disk, whoever still holds the cell. */
function handedOf(judgement: OverviewJudgement | undefined, id: string): boolean {
  return verdictOf(judgement, id)?.handed === true
}

/** Whether this session's cell's claim outlived the session: the debt nobody is left to settle. */
function strandedOf(judgement: OverviewJudgement | undefined, id: string): boolean {
  return verdictOf(judgement, id)?.stranded === true
}

/**
 * How the conversation's last turn ended: the **last** `turn/end` the events
 * carry, folded to the two facts above. Absent when the window has no such
 * event, which is not the same as "it ended well" — a conversation still
 * running has none, and one whose log could not be read has none either.
 */
export function endingOf(events: readonly OverviewEvent[] | undefined): OverviewEnding | undefined {
  let ending: OverviewEnding | undefined
  for (const event of events ?? []) {
    if (text(event.type) !== 'turn/end') continue
    const reason = asRecord(asRecord(event.data)?.reason)
    const kind = text(reason?.kind)
    if (kind === undefined) continue
    const cause = kind === 'aborted' ? text(asRecord(reason?.reason)?.kind) : undefined
    ending = cause === undefined ? { kind } : { kind, cause }
  }
  return ending
}

/**
 * The four facts a window's last state is read from, in the order the drawing
 * reads them — a person's gate first (a checkpoint is why its conversation
 * stopped, and nothing about it is broken), then the delivery the record names,
 * then a debt nobody is working.
 *
 * `alert` is deliberately narrow but it is **not** read off the turn's own ending
 * alone. DSH closes a turn with `completed` whether the step handed its work in or
 * gave up before it — the word says the model stopped talking, never that the node
 * was delivered — so a rule keyed on it cannot tell a clean finish from a step
 * that quit early, and keying one on it painted every self-closed stop as innocent.
 * The proof read here is the record's own: a **ticket** handed in for the cell.
 * Work is owed and no ticket stands behind it, so this conversation stopped before
 * delivering. Three further facts narrow it, and each is a real reason not to
 * accuse:
 *
 * - the cell must be owed (`stranded` / held): a cell nobody holds is the line's
 *   next work, not money owed.
 * - **no session of its own may still be running** — its own dispatched children.
 *   A leg that yielded to work of its own is a pipeline in motion. A *sibling* leg
 *   of the same line is not this window's business: whether the other parallel
 *   node is still working says nothing about whether this one stopped owing its
 *   work, and a rule that waited on the whole line hid a dead leg exactly as long
 *   as any sibling kept going.
 * - **no session of its own may be owed an answer** (`yielding`): a child that ended
 *   after this conversation's own last word has handed its result back and the
 *   conversation has not spoken since — the notice that wakes it is still crossing.
 *   A stop like that is a yield, not a quit: reading it as a break made the frame
 *   flash red for the beat between a background subagent finishing and the parent it
 *   woke, which is the one moment nothing of the window happens to be running. A
 *   turn the log cut short is still a break — a step killed mid-round is not
 *   excused by a worker of its own that came home afterwards.
 * - the window must be at rest. A debt is about work nobody is doing.
 *
 * A gate wins over all of it: a checkpoint or a manual node is a person being
 * owed, which is drawn as the breath and never as a break.
 */
function factsOf(input: {
  readonly settled: boolean
  readonly gated: boolean
  readonly delivered: boolean
  readonly owed: boolean
  readonly moving: boolean
  readonly yielding: boolean
  readonly handed: boolean
  readonly ending: OverviewEnding | undefined
}): Pick<OverviewWindow, 'settled' | 'delivered' | 'alert' | 'waiting' | 'ending'> {
  const ending = input.ending === undefined ? {} : { ending: input.ending }
  const settled = input.settled ? { settled: true } : {}
  if (input.gated) return { ...settled, ...ending, waiting: true }
  /* A delivery is a verdict about a piece of work that is over: while the conversation still runs, the
     record naming the node completed is the *previous* round's word, and stamping a moving window with
     a check would claim a run that has not ended. */
  if (input.delivered && input.settled) return { ...settled, ...ending, delivered: true }
  /* A debt is drawn only while this conversation stands still — `moving` is this window's own children,
     never the line's other legs; `yielding` is the one that came back after the window's last word and
     has not been read yet. A step that yielded to work of its own is a pipeline in motion; a step that
     stopped while a parallel sibling happened to keep working is not rescued by it.
     `handed` is the ticket: a cell whose work was handed in owes the record a settle, not the reader a
     red frame — the engine settles a clean end in its own time, and a record running behind its own
     session is a lag, not a fault. An unreadable ending accuses nobody either: a silence is not a debt
     being dropped. */
  const stalled = input.settled && !input.moving && !input.yielding
  const cut = !input.handed && input.ending !== undefined
  if (input.owed && stalled && cut) return { ...settled, ...ending, alert: true }
  return { ...settled, ...ending }
}

/**
 * Read the overview's windows and rows off one snapshot.
 *
 * The main window is the one conversation the stage draws
 * ({@link mainIdOf}): the leg the reader picked on the rail while the list
 * still holds it, else this pipeline's own session when the record names it,
 * else a named session still running, else the named one that moved last — and
 * no window at all when the record names none, or names only sessions the list
 * does not hold.
 *
 * A child counts as a window while the list's running bit says it is still
 * running and its `parentId` is that main session — which is the whole
 * admission a caller without a record side has. A session the record names for
 * a node is **never** a child, however it was dispatched: it is a leg, because a
 * step of the line is not a subagent of the step that happened to open it. That
 * one boundary is what keeps two parallel nodes off one stage. A child with no
 * readable head and no readable events is no window: the box it would draw says
 * nothing. A child that ended is not drawn and not counted, because the window it
 * had is taken off the page by the client's leave animation — unless the main
 * owes the work it was dispatched for and the line has stopped: that cut is where
 * the line stands, and it keeps its seat. A session of another conversation, and
 * any child of one, is never drawn here. Over five child windows the most recent
 * five are taken — taken whole from whoever is running at that moment, never the
 * first five pinned, never a gap filled at the end — and the seats the five leave
 * out are counted, not drawn: `hiddenChildren` is how many window seats the cap
 * folded away, the dead seats standing after the live ones included.
 *
 * The legs are the rail's entries and no windows at all ({@link OverviewLeg}): the
 * record-named steps the list still calls running, the ones that stopped while the
 * record still owes their work, the ones at a person's gate, and the main window's
 * own leg among them. They are the set a switch chooses from, so a reader can move
 * the stage to another step of the line without that step ever standing beside the
 * one it is replacing. A **child** is never one of them, however it is drawn: a
 * seat on the stage is a conversation to read, not a step to switch to.
 *
 * The window's state facts are read here and nowhere else ({@link factsOf}), and every one of them
 * that is a word about a cell is read off the judgement packet the record assembled
 * ({@link OverviewJudgement}): `waiting` is the record naming this session's cell as one owing a
 * person a word **and the window being at rest** — a gate is a stop, and a conversation still
 * running is being worked — `delivered` is that cell's entry saying the record calls the work
 * completed, and `alert` is a debt nobody is working — the record's stranded judgment and the
 * ticket the cell never handed in, read only while the line stands still (no leg of the pipeline
 * running) and only off a last turn that can be read. `settled` is the one fact that is the list's
 * own, not the record's: the running bit not being true. The check belongs to `delivered` alone: a
 * conversation going quiet is not a piece of work handed in, and a checkpoint's silence is why the
 * gate is drawn first.
 *
 * While a window's step streams, its two tail rows — each the newest slice of
 * one live buffer, read off the transient chunks the caller hands over — hang
 * after the settled rows and move with the stream; the step's message settling
 * folds them away into the ordinary rows again. The settled rows' shape does
 * not move.
 *
 * Which call dispatched a child is read off the main session's own events, whole
 * — outside the row capacity, because a dispatch row falling off the top of the
 * feed is the fade's business and not the anchor's: the fact stays even when the
 * row that carries it is no longer drawn. Its rows are that same session's
 * events, so the window and its anchors can never be read off two conversations.
 */
export function readOverview(input: OverviewInput): OverviewReading {
  const rows = rowsOf(input.sessions)
  const order = listedIds(input.sessions)
  const named = pipelineOf(input)
  const at = atOf(input.at)
  const judgement = input.judgement
  /* Every session-keyed question this reading asks is asked of the one judgement packet: a cell's
     verdicts come from there, never from a second reading of the record beside it. */
  const held = sessionsWhere(judgement, (cell) => cell.held)
  /* A person's gate is a **stop**, so the record's word is read with the one fact that is the
     conversation's own: a window still running is being worked, and it is not waiting on anybody. A
     pause drawn over a live stream says what the stream contradicts, and a rail bar lit for it says
     the same thing twice. */
  const waiting = sessionsWhere(judgement, (cell) => cell.waiting)
  const delivered = new Set(sessionsWhere(judgement, (cell) => cell.delivered))
  /* The whole pipeline handing itself in lands on the conversation this panel reads the workspace
     for, even one that works no cell of its own: that conversation carries the verdict. */
  const deliveredOn = judgement?.pipelineDeliveredOn
  if (deliveredOn !== null && deliveredOn !== undefined) delivered.add(deliveredOn)
  const atGate = (id: string): boolean => waiting.has(id) && rows[id]?.running !== true
  /* Whether this step has **left the line**: the record delivered its work and no gate stands
     on it. Its check is the last thing it has to tell the reader, and once the line has
     somewhere else to be, that is not the stage's subject any more — the page the reader was
     reading is a finished step while the line it belongs to goes on. It is also the one
     replacement the drawing hands over rather than swaps (`overview.tsx`). */
  const left = (id: string): boolean => delivered.has(id) && !atGate(id)
  const choice = mainIdOf(input, rows, order, held, left)
  const mainId = choice?.id
  const nodeFor = (id: string): SuperworkerNode | undefined => {
    const node = nodeIdOf(judgement, id)
    return node === undefined ? undefined : input.nodes?.[node]
  }
  const main = mainId === undefined ? undefined : rows[mainId]
  const undelivered = new Set(owedSessions(judgement))
  /* The rows the list knows without listing: DSH keeps a session's dispatched subagents in its own
     `byId` map — each carrying the `parentId` of the session that dispatched it — while the ordered
     list holds top-level sessions only. A row with no parent link is a top-level session and is drawn
     only when the list lists it; the bond to a window is the only reason to look past the list. */
  const parentOf = (id: string): string | undefined => {
    const parent = rows[id]?.parentId
    return typeof parent === 'string' && parent.length > 0 ? parent : undefined
  }
  const rowIds = [...new Set([...order, ...Object.keys(rows).filter((id) => parentOf(id) !== undefined)])]
  /* Whether this session owes work somebody was on: the record holding its cell, or the record's
     judgment that the claim outlived the session. */
  const debtOf = (id: string): boolean => held.has(id) || strandedOf(judgement, id)
  const mainWindowDebt = mainId === undefined ? false : debtOf(mainId)
  /* Whether a session is a step of the line rather than a subagent of one: the record
     names it for a node. A step of the line is a **leg** — the rail's entries — and
     never a child of the window that happened to dispatch it, which is what keeps a
     pipeline's parallel nodes from standing beside each other on one stage. */
  const isLeg = (id: string): boolean => named !== undefined && named.has(id)
  /* Whether this conversation is waiting on work of its own: a session it dispatched is still
     running, or ended **after** this conversation's own last word — its result came home and the
     conversation has not spoken since, so the notice that wakes it is still on its way. That is a
     yield, and a yield is not a quit: reading one as a break painted the frame red for the beat
     between a background subagent finishing and the turn it woke, which is the one beat nothing of
     the window happens to be running. A subagent is never a leg of this comparison — the notice a
     step's own dispatch leaves behind is the conductor's business, not a step's — and a child whose
     log cannot place it in that order is not read as owed an answer either. */
  const yielding = (id: string): boolean => {
    const spoken = turnedAtOf(input.events?.[id])
    for (const child of rowIds) {
      if (child === id || isLeg(child) || parentOf(child) !== id) continue
      if (rows[child]?.running === true) return true
      const ended = turnedAtOf(input.events?.[child])
      if (ended !== null && (spoken === null || ended >= spoken)) return true
    }
    return false
  }
  /* The seats the column can take, in two kinds. A **child**: a session the main
     conversation dispatched itself and the list still calls running — this one step's
     subagents, which is also the whole admission when the caller says nothing about the
     pipeline. A **ghost child**: one of those the main's own dispatch cut short while the
     main still owes that work, which keeps its seat so the cut is somewhere to be read.
     A **leg**: a record-named session still on the table. A running leg is a rail entry
     and not a seat at all, and so is a leg the record still owes (the packet's `owed`)
     whose conversation is not running — resting between rounds,
     dead, or gone from the list altogether. Nothing will settle such a leg next unless
     something prompts it, and the bar it keeps is the only place that debt can be read;
     letting it go with the conversation is how a broken leg becomes invisible. A stopped
     session whose node is delivered is no leg either: it left its work behind. */
  const kids: string[] = []
  const movingLegs: string[] = []
  const ghosts: string[] = []
  if (mainId !== undefined) {
    for (const id of rowIds) {
      if (id === mainId) continue
      const row: OverviewSessionRow | undefined = rows[id]
      if (row === undefined) continue
      const parent = parentOf(id)
      /* A ghost needs no parent link and no running bit — that is exactly what the dead leg lost — only
         the record's own word that the node is still on the table. */
      if (row.running !== true) {
        if (undelivered.has(id)) ghosts.push(id)
        else if (parent === mainId && mainWindowDebt && cutShort(input.events?.[id])) ghosts.push(id)
        continue
      }
      if (isLeg(id)) {
        movingLegs.push(id)
        continue
      }
      if (parent === mainId) kids.push(id)
    }
  }
  /* A leg the record has not delivered whose conversation the list no longer holds at all — deleted,
     or disposed without ever reaching the roster. Its node's own title is enough to stand the seat, and
     the window has no rows because there are none to draw: the debt is the whole of what is known. A
     leg that went quiet while its conversation stayed on the list is the case above, not this one. */
  for (const id of undelivered) {
    if (id === mainId || rows[id] !== undefined) continue
    if (nodeIdOf(judgement, id) === undefined) continue
    ghosts.push(id)
  }
  /* A conversation that began after another one took its place on the **stage**: the line is standing
     where the newest of them stands. Only this line's own conversations count — the session list is
     every workspace's, and a conversation opened afterwards in another one is no step of this
     pipeline. A conversation with no readable word of its own cannot be placed in that order, and
     stands. A dead **child** is held to one more judgment, the same one the stage has always kept:
     it stands while the line stands still, because a step still running means that cut is history
     rather than where the line is.

     This is a judgment about *which page the stage draws*, never about *which steps the line still
     has*. It is read in exactly one place — the seat a dead child keeps — and it compares against
     `mainId`, which the reader's own pick decides. Reading it on the rail put the display in a
     feedback loop with itself: the picked leg dropped out of the order, the leg after it lost its
     bar, and pressing the last two bars took the whole rail off the stage (a rail of one step is no
     switch). Which steps are on the table is the record's answer, read at `legIds` below. */
  const ofThisLine = (id: string): boolean => parentOf(id) === mainId
    || (named === undefined ? order.includes(id) : named.has(id))
  const supersededBy = (id: string): boolean => {
    const end = endedAtOf(input.events?.[id])
    if (end === null) return false
    for (const other of order) {
      if (other === id || other === mainId || !ofThisLine(other)) continue
      const start = startedAtOf(input.events?.[other])
      if (start !== null && start.getTime() > end.getTime()) return true
    }
    return false
  }
  /* Whether anything of this line is still moving: a running leg, or — with no record side at all — a
     session of the list the caller handed over. A pipeline with a leg still running has not stopped,
     which is what keeps the red off every window of it. */
  const moving = movingLegs.length > 0 || kids.length > 0
    || (named === undefined ? order : [...named]).some((id) => rows[id]?.running === true)
  /* Whether **this** conversation has work of its own still running: the children it dispatched. That
     is the only motion that keeps a debt from being drawn, and it is deliberately narrower than
     {@link moving}: a parallel sibling leg still working says nothing about whether this step stopped
     owing its work. A sibling's progress is the line's business, and the line's business is not what a
     break on this window would be reporting. */
  const ownMoving = kids.length > 0
  const standing = ghosts.filter((id) => !supersededBy(id) && (isLeg(id) || !moving))
  /* Whether this conversation owes work nobody is doing — the one formula the ghost seat and
     the rail bar share, so the two readers can never give one step two verdicts. The two words
     it replaces were the same formula once each reader's own context is carried in:
     - no readable ending: the record's stranded judgment is the only witness;
     - a cell the record names: a ticket excuses (the cell's own `handed`), and a turn still
       owed a wake (`yielding`) is a yield, not a quit. The bar reads this clause only after its
       own three rescues below — the step standing still, no worker of its own moving, no yield —
       so `yielding` is false there and the clause reduces to the bare `!handed` the bar has
       always spelled;
     - no cell of its own: a worker owes nobody a delivery, and only a turn the log cut short is
       its break. A leg is record-named for a node — the notes name both — so the bar never reads
       this word on this input; a caller that names a pipeline without its cell map does, and
       keeps the leg's bare `!handed` there. */
  const alertOf = (id: string): boolean => {
    const cell = nodeIdOf(judgement, id) ?? ''
    const ending = endingOf(input.events?.[id])
    if (ending === undefined) return strandedOf(judgement, id)
    if (cell.length === 0) return isLeg(id) ? !handedOf(judgement, id) : ending.kind !== 'completed'
    return !handedOf(judgement, id) && (ending.kind !== 'completed' || !yielding(id))
  }
  /* The legs the rail offers: the steps still on the table, in the reading's own order. The rail is
     the line's own list and **nothing else feeds it** — not which page the stage happens to draw, not
     the reader's pick, not one step's progress. That independence is the whole of what a switch is: a
     reader who presses a bar asks to look at that step, and a list that dropped the step it was asked
     about would be an answer to a question nobody asked. Reading `supersededBy` here — a judgment
     whose reference point is the stage's own page — put the display in a loop with itself and cost
     the rail its bars, one press at a time. */
  const legIds: string[] = []
  const self = text(input.ownSession)
  /* A **step** of the line is what the rail switches between, and nothing else is. A **seat** — a subagent
     conversation of the step being drawn, ghost or running — is already on the stage beside that step, and
     a bar for it would stand one conversation twice on one page, offering a switch to where the reader
     already is. The stage's seat keeps its window; the rail keeps the steps.

     A step is on the table while **the record still owes its work** — the sessions the
     judgement packet names as owed, which the record reads off each cell's own state. A step
     whose node is delivered has left the line and owes nobody a look: it drops off the
     rail with its check, and the map is where its history stays. A gate is no exception
     in the end: a finished checkpoint still owes a person a word, so `atGate` keeps its
     bar. The list's own running bit keeps it too — a step being worked this moment is on
     the table by definition, whatever the record has round to saying about its state yet.

     A caller that hands over no packet has said nothing about the record's debts, and the
     rail then falls back to what the session list alone can prove — a step the list still
     calls running. There is no second witness in that branch: every verdict about a cell is
     read off the packet, so a reading with no packet knows no held cell either, and promising
     one here would promise a fact this branch cannot state. Silence is never read as "the
     line owes nothing": that would empty the rail of every leg the caller did not enumerate. */
  const owes = judgement === undefined
    ? (id: string): boolean => rows[id]?.running === true
    : (id: string): boolean => undelivered.has(id) || rows[id]?.running === true || atGate(id)
  /* The stage's own page keeps its bar whatever the record owes, and so does the page this panel
     itself stands in: a bar that vanished from under the page being drawn would be a switch with no
     way back to it, and the reader who picked a finished step needs the door they came in by. */
  const aStep = (id: string): boolean => isLeg(id) && (owes(id) || id === mainId || id === self)
  for (const id of rowIds) {
    if (!aStep(id) || legIds.includes(id)) continue
    legIds.push(id)
  }
  /* A step the list has let go of altogether keeps its bar while the record owes the work: the debt is
     the whole of what is known about it, and the bar is the only place that debt can be read. */
  for (const id of undelivered) {
    if (legIds.includes(id) || !isLeg(id)) continue
    legIds.push(id)
  }
  const mainWindow = main === undefined || mainId === undefined
    ? null
    : {
      ...windowOf(mainId, main, nodeFor(mainId), input.events?.[mainId], input.capacity, input.live?.[mainId], at),
      ...factsOf({
        settled: main.running !== true,
        gated: atGate(mainId),
        delivered: delivered.has(mainId),
        owed: mainWindowDebt,
        moving: ownMoving,
        yielding: yielding(mainId),
        handed: handedOf(judgement, mainId),
        ending: endingOf(input.events?.[mainId]),
      }),
    }
  const anchors = dispatchAnchorsOf(mainId === undefined ? undefined : input.events?.[mainId])
  /* A window with nothing readable — no nameplate word and no row its own events fold into — is a
     box, not a window, and the running bit alone never stands one up. Dropped here, it is also no
     seat the cap could fold away, so the count keeps counting windows alone. */
  const seats: OverviewWindow[] = []
  for (const id of kids) {
    const window = windowOf(id, rows[id] ?? { id }, nodeFor(id), input.events?.[id], input.capacity, input.live?.[id], at)
    if (window.title === null && window.rows.length === 0) continue
    /* A seat that is still moving carries no state of its own: the gate, the delivery and the debt are
       verdicts about work at rest, and the main window is where those are read. The ending rides along
       all the same — it is a fact about the conversation, not about the work. */
    const ending = endingOf(input.events?.[id])
    seats.push(ending === undefined ? window : { ...window, ending })
  }
  /* The dead children stand after the moving seats. What one says is the thing the reader has to act
     on: the line stands here. It says "broken" only when the debt is proved — the record's stranded
     judgment (the claim is on disk and the session is gone), a step's last turn that did not close
     itself or closed it with no ticket behind it, or a **subagent's** last turn the log cut short —
     unless a person is the one owed (a gate), which is a different debt and is drawn as the breath.
     A step resting between rounds keeps its window quietly, which is the truth about it.
     A **subagent** that closed its own turn is never a break: its work is not its own to deliver —
     it hands the turn back to the conversation that dispatched it, and that conversation reads the
     result. Only a worker whose turn was cut (aborted, errored, interrupted) died owing the work,
     which is the one case its red seat exists for. */
  for (const id of standing) {
    if (isLeg(id)) continue
    const window = windowOf(id, rows[id] ?? { id }, nodeFor(id), input.events?.[id], input.capacity, input.live?.[id], at)
    if (window.title === null && window.rows.length === 0) continue
    const ending = endingOf(input.events?.[id])
    const gated = atGate(id)
    /* The proof is whichever witness spoke: a ticket the cell never handed in, or — when the log
       carried no word at all — the record's stranded judgment (the claim is on disk and the session is
       gone). A cell that did hand a ticket in is no break, whoever still holds it: the engine settles
       a clean end in its own time, and a record running behind its own session is a lag, not a fault.
       Whether a cell is owed at all is read off the record (`nodeOf`), not off the caller's naming:
       a session working a node can owe a ticket even when the caller said nothing about a pipeline. */
    const broken = !gated && alertOf(id)
    seats.push({
      ...window,
      settled: true,
      ...(gated ? { waiting: true } : broken ? { alert: true } : {}),
      ...(ending === undefined ? {} : { ending }),
    })
  }
  const drawn = seats.slice(-WINDOW_CAP)
  const legs = legIds.map((id): OverviewLeg => {
    const window = windowOf(id, rows[id] ?? { id }, nodeFor(id), input.events?.[id], input.capacity, input.live?.[id], at)
    const leg: OverviewLeg = { id, title: window.title, rows: window.rows.length }
    const gated = atGate(id)
    /* A bar says the two verdicts a step can stand in and nothing else: a person's gate in the warn
       ink, a debt nobody is working in the break's. Both are read the way the window's own frame reads
       them — one ink, one fact — and a debt is read off the ticket the cell never handed in, never off
       a sibling leg's progress: a parallel step still working is the line's own motion, and this bar
       reports this step. A bar still moving wears neither, and a gate is only ever worn at rest: a
       running step is being worked. A worker of this step's own that came home after its last word is
       no break either: the bar waits for the notice to land, the way the frame does. */
    if (gated) return { ...leg, waiting: true }
    /* The bar's own rescues come first — a step still running is being worked, the main's own
       work moving is the line at work, a yield is the notice still crossing — and then the one
       debt formula the seat reads too. After these rescues `yielding` is false, so the formula's
       yield clause folds away and the bar reads the same `!handed` it always has. */
    if (rows[id]?.running === true || ownMoving || yielding(id)) return leg
    return alertOf(id) ? { ...leg, alert: true } : leg
  })
  /* The main's parented children, untruncated: the set the panel holds event windows open
     for. It is the raw admission universe — running seats, dead seats, ended children no seat
     keeps — deliberately wider than the drawn `children` (the five the cap kept), because each
     child's own log decides whether its seat stays and that log has to be open before the seat
     exists. The snapshot's `byId` shape is read once, here, the model's own way; the ids come
     out in the map's own key order, which the watch list reads as a set. */
  const mainChildIds = mainId === undefined
    ? []
    : Object.keys(rows).filter((id) => parentOf(id) === mainId)
  return {
    main: mainWindow,
    mainFrom: mainWindow === null || choice === undefined ? null : choice.from,
    children: drawn.map((window) => {
      const dispatchCallId = anchors.get(window.id)
      return dispatchCallId === undefined ? window : { ...window, dispatchCallId }
    }),
    mainChildIds,
    legs,
    /* Counted off the seats, never off the five the cap kept: what the cap folded away is the
       windows it left out. */
    hiddenChildren: seats.length - drawn.length,
  }
}
