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
import type { OverviewEvent, OverviewRow } from './overview-fold.ts'
import { capped, dispatchAnchorsOf, foldRows, liveRowsOf } from './overview-fold.ts'
import type { OverviewMainFrom } from './overview-main.ts'
import { mainIdOf, pipelineOf } from './overview-main.ts'

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

function rowsOf(snapshot: OverviewSnapshot): Readonly<Record<string, OverviewSessionRow>> {
  return asRecord(snapshot.byId) as Readonly<Record<string, OverviewSessionRow>> | undefined ?? {}
}

function listedIds(snapshot: OverviewSnapshot): readonly string[] {
  if (!Array.isArray(snapshot.ids)) return []
  return snapshot.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** The moment a reading was taken at, read the same way a row's own moment is; absent says nothing. */
function atOf(raw: unknown): Date | null {
  const ms = toEpoch(raw)
  return ms === null ? null : new Date(ms)
}

/**
 * One session's four derived moments, off its own events: when the conversation
 * started, when it last moved, when its last turn ended, and how that turn ended
 * ({@link OverviewEnding}).
 */
interface SessionDerived {
  readonly startedAt: Date | null
  readonly endedAt: Date | null
  readonly turnedAt: number | null
  readonly ending: OverviewEnding | undefined
}

/** What a session with no events at all derives to: no moment, no ending. */
const NOTHING_DERIVED: SessionDerived = { startedAt: null, endedAt: null, turnedAt: null, ending: undefined }

/**
 * The per-session event index, built once as the reading opens (one
 * {@link derivedOf} scan per session): when the conversation started (the
 * earliest moment its events carry), when it last moved (the newest — the end of
 * the span a window that stopped is measured to, the log's own last word, not the
 * moment this reading was taken), when its last turn ended (the log's last
 * `turn/end`), and how that turn ended. Every judgment below reads the index
 * instead of walking the same table again, however many seats, bars and yields
 * ask.
 *
 * The log's stamps are epoch milliseconds and read as numbers alone — the
 * row's and the reading's epoch-or-string convention (`toEpoch` in fields.ts)
 * is not the events'; a stamp that is not a finite number is not a moment here.
 * `turnedAt` is the conversation's own last word — the moment a window that
 * yielded to work of its own is read against — and both ends of that comparison
 * are the log's own, so nothing here is a guess about a clock.
 */
function derivedAll(
  events: Readonly<Record<string, readonly OverviewEvent[]>> | undefined,
): Readonly<Record<string, SessionDerived>> {
  const derived: Record<string, SessionDerived> = {}
  for (const [id, list] of Object.entries(events ?? {})) derived[id] = derivedOf(list)
  return derived
}

/** One session's index entry: the four derived values, read in one walk of its own events. */
function derivedOf(events: readonly OverviewEvent[] | undefined): SessionDerived {
  let low: number | undefined
  let high: number | undefined
  let turnedAt: number | null = null
  let ending: OverviewEnding | undefined
  for (const event of events ?? []) {
    const time = event.time
    if (typeof time === 'number' && Number.isFinite(time)) {
      if (low === undefined || time < low) low = time
      if (high === undefined || time > high) high = time
    }
    if (text(event.type) !== 'turn/end') continue
    if (typeof time === 'number' && Number.isFinite(time)) turnedAt = time
    const reason = asRecord(asRecord(event.data)?.reason)
    const kind = text(reason?.kind)
    if (kind === undefined) continue
    const cause = kind === 'aborted' ? text(asRecord(reason?.reason)?.kind) : undefined
    ending = cause === undefined ? { kind } : { kind, cause }
  }
  return {
    startedAt: low === undefined ? null : new Date(low),
    endedAt: high === undefined ? null : new Date(high),
    turnedAt,
    ending,
  }
}

/** The index's entry for a session; a session with no entry derives to nothing. */
function derivedIn(derived: Readonly<Record<string, SessionDerived>>, id: string): SessionDerived {
  return derived[id] ?? NOTHING_DERIVED
}

/**
 * How the conversation's last turn ended: the **last** `turn/end` the events
 * carry, folded to the two facts above. Absent when the window has no such
 * event, which is not the same as "it ended well" — a conversation still
 * running has none, and one whose log could not be read has none either.
 */
export function endingOf(events: readonly OverviewEvent[] | undefined): OverviewEnding | undefined {
  return derivedOf(events).ending
}

/** Whether a conversation was cut off rather than closing its own turn: a readable ending that is not `completed`. */
function cutShortOf(ending: OverviewEnding | undefined): boolean {
  return ending !== undefined && ending.kind !== 'completed'
}

/**
 * The fold, once per session: the reader that folds a session's log into its
 * rows, remembering each id's rows as it goes — a window's rows and its leg's
 * row count read one folding, never two.
 */
function foldsOnce(
  events: Readonly<Record<string, readonly OverviewEvent[]>> | undefined,
): (id: string) => readonly OverviewRow[] {
  const memo = new Map<string, readonly OverviewRow[]>()
  return (id) => {
    const held = memo.get(id)
    if (held !== undefined) return held
    const rows = foldRows(events?.[id])
    memo.set(id, rows)
    return rows
  }
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

function windowOf(
  id: string,
  row: OverviewSessionRow,
  node: SuperworkerNode | undefined,
  derived: SessionDerived,
  folded: readonly OverviewRow[],
  capacity: unknown,
  live: readonly OverviewEvent[] | undefined,
  at: Date | null,
): OverviewWindow {
  const startedAt = derived.startedAt
  return {
    id,
    title: titleOf(row, node),
    weight: weightOf(node),
    mode: modeOf(node),
    startedAt,
    /* A leg that is still moving is measured to the moment this reading was taken; one that stopped
       is measured to its own last word. Either way the number is a span this reading states, never a
       clock the drawing reads for itself. */
    elapsedSeconds: secondsBetween(startedAt, row.running === true ? at : derived.endedAt),
    /* The settled rows stand first in their existing shape; the streaming
       step's tails hang after them — at most two, and gone again once the
       step's message lands among the settled rows. */
    rows: [...capped(folded, capacity), ...liveRowsOf(live)],
  }
}

/**
 * What one window's building reads this reading: the list's rows, the record's
 * packet and the nodes' records verbatim, the room cut, the live chunks, the
 * moment, the per-session event index, and the once-per-session fold.
 */
interface WindowContext {
  readonly rows: Readonly<Record<string, OverviewSessionRow>>
  readonly judgement: OverviewJudgement | undefined
  readonly nodes: Readonly<Record<string, SuperworkerNode>> | undefined
  readonly capacity: unknown
  readonly live: Readonly<Record<string, readonly OverviewEvent[]>> | undefined
  readonly at: Date | null
  readonly derived: Readonly<Record<string, SessionDerived>>
  readonly folded: (id: string) => readonly OverviewRow[]
}

/**
 * The node a session works, read off this reading's own nodes: none, when the
 * packet names no node for it.
 */
function nodeForOf(
  id: string,
  judgement: OverviewJudgement | undefined,
  nodes: Readonly<Record<string, SuperworkerNode>> | undefined,
): SuperworkerNode | undefined {
  const node = nodeIdOf(judgement, id)
  return node === undefined ? undefined : nodes?.[node]
}

/** One session's window, off this reading's stock: its row as the list holds it, its node, its derived moments, its fold. */
function windowFor(id: string, stock: WindowContext): OverviewWindow {
  return windowOf(
    id,
    stock.rows[id] ?? { id },
    nodeForOf(id, stock.judgement, stock.nodes),
    derivedIn(stock.derived, id),
    stock.folded(id),
    stock.capacity,
    stock.live?.[id],
    stock.at,
  )
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

/** A row's parent link: the session that dispatched it, when the row names one. */
function parentOf(id: string, rows: Readonly<Record<string, OverviewSessionRow>>): string | undefined {
  const parent = rows[id]?.parentId
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined
}

/* The rows the list knows without listing: DSH keeps a session's dispatched subagents in its own
    `byId` map — each carrying the `parentId` of the session that dispatched it — while the ordered
    list holds top-level sessions only. A row with no parent link is a top-level session and is drawn
    only when the list lists it; the bond to a window is the only reason to look past the list. */
function rowIdsOf(order: readonly string[], rows: Readonly<Record<string, OverviewSessionRow>>): readonly string[] {
  return [...new Set([...order, ...Object.keys(rows).filter((id) => parentOf(id, rows) !== undefined)])]
}

/* Whether this session owes work somebody was on: the record holding its cell, or the record's
   judgment that the claim outlived the session. */
function debtOf(id: string, held: ReadonlySet<string>, judgement: OverviewJudgement | undefined): boolean {
  return held.has(id) || strandedOf(judgement, id)
}

/* Whether a session is a step of the line rather than a subagent of one: the record
    names it for a node. A step of the line is a **leg** — the rail's entries — and
    never a child of the window that happened to dispatch it, which is what keeps a
    pipeline's parallel nodes from standing beside each other on one stage. */
function isLegOf(id: string, named: ReadonlySet<string> | undefined): boolean {
  return named !== undefined && named.has(id)
}

/**
 * The record's gate word, held at rest: the session owes a person a word and its
 * conversation is not running — a gate is a stop, and a window still running is
 * being worked.
 */
function atGateOf(id: string, waiting: ReadonlySet<string>, rows: Readonly<Record<string, OverviewSessionRow>>): boolean {
  return waiting.has(id) && rows[id]?.running !== true
}

/* Whether this step has **left the line**: the record delivered its work and no gate stands
   on it. Its check is the last thing it has to tell the reader, and once the line has
   somewhere else to be, that is not the stage's subject any more — the page the reader was
   reading is a finished step while the line it belongs to goes on. It is also the one
   replacement the drawing hands over rather than swaps (`overview.tsx`). */
function leftOf(
  id: string,
  delivered: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  rows: Readonly<Record<string, OverviewSessionRow>>,
): boolean {
  return delivered.has(id) && !atGateOf(id, waiting, rows)
}

/* Whether this conversation is waiting on work of its own: a session it dispatched is still
    running, or ended **after** this conversation's own last word — its result came home and the
    conversation has not spoken since, so the notice that wakes it is still on its way. That is a
    yield, and a yield is not a quit: reading one as a break painted the frame red for the beat
    between a background subagent finishing and the turn it woke, which is the one beat nothing of
    the window happens to be running. A subagent is never a leg of this comparison — the notice a
    step's own dispatch leaves behind is the conductor's business, not a step's — and a child whose
    log cannot place it in that order is not read as owed an answer either. */
function yieldingOf(
  id: string,
  rowIds: readonly string[],
  rows: Readonly<Record<string, OverviewSessionRow>>,
  named: ReadonlySet<string> | undefined,
  derived: Readonly<Record<string, SessionDerived>>,
): boolean {
  const spoken = derivedIn(derived, id).turnedAt
  for (const child of rowIds) {
    if (child === id || isLegOf(child, named) || parentOf(child, rows) !== id) continue
    if (rows[child]?.running === true) return true
    const ended = derivedIn(derived, child).turnedAt
    if (ended !== null && (spoken === null || ended >= spoken)) return true
  }
  return false
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
function ofThisLineOf(
  id: string,
  mainId: string | undefined,
  order: readonly string[],
  named: ReadonlySet<string> | undefined,
  rows: Readonly<Record<string, OverviewSessionRow>>,
): boolean {
  return parentOf(id, rows) === mainId
    || (named === undefined ? order.includes(id) : named.has(id))
}

function supersededByOf(
  id: string,
  mainId: string | undefined,
  order: readonly string[],
  named: ReadonlySet<string> | undefined,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  derived: Readonly<Record<string, SessionDerived>>,
): boolean {
  const end = derivedIn(derived, id).endedAt
  if (end === null) return false
  for (const other of order) {
    if (other === id || other === mainId || !ofThisLineOf(other, mainId, order, named, rows)) continue
    const start = derivedIn(derived, other).startedAt
    if (start !== null && start.getTime() > end.getTime()) return true
  }
  return false
}

/* Whether anything of this line is still moving: a running leg, or — with no record side at all — a
   session of the list the caller handed over. A pipeline with a leg still running has not stopped,
   which is what keeps the red off every window of it. */
function movingOf(
  movingLegs: readonly string[],
  kids: readonly string[],
  named: ReadonlySet<string> | undefined,
  order: readonly string[],
  rows: Readonly<Record<string, OverviewSessionRow>>,
): boolean {
  return movingLegs.length > 0 || kids.length > 0
    || (named === undefined ? order : [...named]).some((id) => rows[id]?.running === true)
}

/* Whether **this** conversation has work of its own still running: the children it dispatched. That
    is the only motion that keeps a debt from being drawn, and it is deliberately narrower than
    {@link movingOf}: a parallel sibling leg still working says nothing about whether this step stopped
    owing its work. A sibling's progress is the line's business, and the line's business is not what a
    break on this window would be reporting. */
function ownMovingOf(kids: readonly string[]): boolean {
  return kids.length > 0
}

/**
 * The seats the column can take, in two kinds. A **child**: a session the main
 * conversation dispatched itself and the list still calls running — this one step's
 * subagents, which is also the whole admission when the caller says nothing about the
 * pipeline. A **ghost child**: one of those the main's own dispatch cut short while the
 * main still owes that work, which keeps its seat so the cut is somewhere to be read.
 * A **leg**: a record-named session still on the table. A running leg is a rail entry
 * and not a seat at all, and so is a leg the record still owes (the packet's `owed`)
 * whose conversation is not running — resting between rounds,
 * dead, or gone from the list altogether. Nothing will settle such a leg next unless
 * something prompts it, and the bar it keeps is the only place that debt can be read;
 * letting it go with the conversation is how a broken leg becomes invisible. A stopped
 * session whose node is delivered is no leg either: it left its work behind.
 */
function seatKindsOf(
  mainId: string | undefined,
  rowIds: readonly string[],
  rows: Readonly<Record<string, OverviewSessionRow>>,
  named: ReadonlySet<string> | undefined,
  undelivered: ReadonlySet<string>,
  mainWindowDebt: boolean,
  judgement: OverviewJudgement | undefined,
  derived: Readonly<Record<string, SessionDerived>>,
): { readonly kids: string[]; readonly movingLegs: string[]; readonly ghosts: string[] } {
  const kids: string[] = []
  const movingLegs: string[] = []
  const ghosts: string[] = []
  if (mainId !== undefined) {
    for (const id of rowIds) {
      if (id === mainId) continue
      const row: OverviewSessionRow | undefined = rows[id]
      if (row === undefined) continue
      const parent = parentOf(id, rows)
      /* A ghost needs no parent link and no running bit — that is exactly what the dead leg lost — only
         the record's own word that the node is still on the table. */
      if (row.running !== true) {
        if (undelivered.has(id)) ghosts.push(id)
        else if (parent === mainId && mainWindowDebt && cutShortOf(derivedIn(derived, id).ending)) ghosts.push(id)
        continue
      }
      if (isLegOf(id, named)) {
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
  return { kids, movingLegs, ghosts }
}

/**
 * The ghosts that keep their seat: the ones no later conversation of the line has
 * taken the place of, and — a child, not a leg — only while the line stands still.
 */
function standingOf(
  ghosts: readonly string[],
  mainId: string | undefined,
  order: readonly string[],
  named: ReadonlySet<string> | undefined,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  derived: Readonly<Record<string, SessionDerived>>,
  moving: boolean,
): readonly string[] {
  return ghosts.filter((id) =>
    !supersededByOf(id, mainId, order, named, rows, derived) && (isLegOf(id, named) || !moving)
  )
}

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
function alertOf(
  id: string,
  judgement: OverviewJudgement | undefined,
  named: ReadonlySet<string> | undefined,
  rowIds: readonly string[],
  rows: Readonly<Record<string, OverviewSessionRow>>,
  derived: Readonly<Record<string, SessionDerived>>,
): boolean {
  const cell = nodeIdOf(judgement, id) ?? ''
  const ending = derivedIn(derived, id).ending
  if (ending === undefined) return strandedOf(judgement, id)
  if (cell.length === 0) return isLegOf(id, named) ? !handedOf(judgement, id) : ending.kind !== 'completed'
  return !handedOf(judgement, id) && (ending.kind !== 'completed' || !yieldingOf(id, rowIds, rows, named, derived))
}

/**
 * A caller that hands over no packet has said nothing about the record's debts, and the
 * rail then falls back to what the session list alone can prove — a step the list still
 * calls running. There is no second witness in that branch: every verdict about a cell is
 * read off the packet, so a reading with no packet knows no held cell either, and promising
 * one here would promise a fact this branch cannot state. Silence is never read as "the
 * line owes nothing": that would empty the rail of every leg the caller did not enumerate.
 */
function owesOf(
  id: string,
  judgement: OverviewJudgement | undefined,
  undelivered: ReadonlySet<string>,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  waiting: ReadonlySet<string>,
): boolean {
  return judgement === undefined
    ? rows[id]?.running === true
    : undelivered.has(id) || rows[id]?.running === true || atGateOf(id, waiting, rows)
}

/**
 * A **step** of the line is what the rail switches between, and nothing else is. A **seat** — a subagent
 * conversation of the step being drawn, ghost or running — is already on the stage beside that step, and
 * a bar for it would stand one conversation twice on one page, offering a switch to where the reader
 * already is. The stage's seat keeps its window; the rail keeps the steps.
 *
 * A step is on the table while **the record still owes its work** — the sessions the
 * judgement packet names as owed, which the record reads off each cell's own state. A step
 * whose node is delivered has left the line and owes nobody a look: it drops off the
 * rail with its check, and the map is where its history stays. A gate is no exception
 * in the end: a finished checkpoint still owes a person a word, so `atGate` keeps its
 * bar. The list's own running bit keeps it too — a step being worked this moment is on
 * the table by definition, whatever the record has round to saying about its state yet.
 *
 * The stage's own page keeps its bar whatever the record owes, and so does the page this panel
 * itself stands in: a bar that vanished from under the page being drawn would be a switch with no
 * way back to it, and the reader who picked a finished step needs the door they came in by.
 */
function aStepOf(
  id: string,
  named: ReadonlySet<string> | undefined,
  judgement: OverviewJudgement | undefined,
  undelivered: ReadonlySet<string>,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  waiting: ReadonlySet<string>,
  mainId: string | undefined,
  self: string | undefined,
): boolean {
  return isLegOf(id, named)
    && (owesOf(id, judgement, undelivered, rows, waiting) || id === mainId || id === self)
}

/**
 * The legs the rail offers: the steps still on the table, in the reading's own order. The rail is
 * the line's own list and **nothing else feeds it** — not which page the stage happens to draw, not
 * the reader's pick, not one step's progress. That independence is the whole of what a switch is: a
 * reader who presses a bar asks to look at that step, and a list that dropped the step it was asked
 * about would be an answer to a question nobody asked. Reading `supersededBy` here — a judgment
 * whose reference point is the stage's own page — put the display in a loop with itself and cost
 * the rail its bars, one press at a time.
 */
function legIdsOf(
  rowIds: readonly string[],
  undelivered: ReadonlySet<string>,
  named: ReadonlySet<string> | undefined,
  judgement: OverviewJudgement | undefined,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  waiting: ReadonlySet<string>,
  mainId: string | undefined,
  self: string | undefined,
): readonly string[] {
  const legIds: string[] = []
  for (const id of rowIds) {
    if (!aStepOf(id, named, judgement, undelivered, rows, waiting, mainId, self) || legIds.includes(id)) continue
    legIds.push(id)
  }
  /* A step the list has let go of altogether keeps its bar while the record owes the work: the debt is
      the whole of what is known about it, and the bar is the only place that debt can be read. */
  for (const id of undelivered) {
    if (legIds.includes(id) || !isLegOf(id, named)) continue
    legIds.push(id)
  }
  return legIds
}

/* A window with nothing readable — no nameplate word and no row its own events fold into — is a
   box, not a window, and the running bit alone never stands one up. Dropped here, it is also no
   seat the cap could fold away, so the count keeps counting windows alone. */
function childSeatsOf(
  kids: readonly string[],
  standing: readonly string[],
  named: ReadonlySet<string> | undefined,
  waiting: ReadonlySet<string>,
  rowIds: readonly string[],
  stock: WindowContext,
): OverviewWindow[] {
  const seats: OverviewWindow[] = []
  for (const id of kids) {
    const window = windowFor(id, stock)
    if (window.title === null && window.rows.length === 0) continue
    /* A seat that is still moving carries no state of its own: the gate, the delivery and the debt are
       verdicts about work at rest, and the main window is where those are read. The ending rides along
       all the same — it is a fact about the conversation, not about the work. */
    const ending = derivedIn(stock.derived, id).ending
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
    if (isLegOf(id, named)) continue
    const window = windowFor(id, stock)
    if (window.title === null && window.rows.length === 0) continue
    const ending = derivedIn(stock.derived, id).ending
    const gated = atGateOf(id, waiting, stock.rows)
    /* The proof is whichever witness spoke: a ticket the cell never handed in, or — when the log
        carried no word at all — the record's stranded judgment (the claim is on disk and the session is
        gone). A cell that did hand a ticket in is no break, whoever still holds it: the engine settles
        a clean end in its own time, and a record running behind its own session is a lag, not a fault.
        Whether a cell is owed at all is read off the record (`nodeOf`), not off the caller's naming:
        a session working a node can owe a ticket even when the caller said nothing about a pipeline. */
    const broken = !gated && alertOf(id, stock.judgement, named, rowIds, stock.rows, stock.derived)
    seats.push({
      ...window,
      settled: true,
      ...(gated ? { waiting: true } : broken ? { alert: true } : {}),
      ...(ending === undefined ? {} : { ending }),
    })
  }
  return seats
}

function legsOf(
  legIds: readonly string[],
  named: ReadonlySet<string> | undefined,
  waiting: ReadonlySet<string>,
  rowIds: readonly string[],
  ownMoving: boolean,
  stock: WindowContext,
): OverviewLeg[] {
  return legIds.map((id): OverviewLeg => {
    const window = windowFor(id, stock)
    const leg: OverviewLeg = { id, title: window.title, rows: window.rows.length }
    const gated = atGateOf(id, waiting, stock.rows)
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
    if (stock.rows[id]?.running === true || ownMoving || yieldingOf(id, rowIds, stock.rows, named, stock.derived)) return leg
    return alertOf(id, stock.judgement, named, rowIds, stock.rows, stock.derived) ? { ...leg, alert: true } : leg
  })
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
  /* Built once for the whole reading: the per-session event index the four derived
     moments read, and the fold taken once per session and shared — a window's rows
     and its leg's row count never fold the same log twice. */
  const derived = derivedAll(input.events)
  const folded = foldsOnce(input.events)
  const stock: WindowContext = {
    rows,
    judgement,
    nodes: input.nodes,
    capacity: input.capacity,
    live: input.live,
    at,
    derived,
    folded,
  }
  /* The leaving test is {@link leftOf}'s; the choice asks it of this reading's own sets. */
  const left = (id: string): boolean => leftOf(id, delivered, waiting, rows)
  const choice = mainIdOf(input, rows, order, held, left)
  const mainId = choice?.id
  const main = mainId === undefined ? undefined : rows[mainId]
  const undelivered = new Set(owedSessions(judgement))
  const rowIds = rowIdsOf(order, rows)
  const mainWindowDebt = mainId === undefined ? false : debtOf(mainId, held, judgement)
  const { kids, movingLegs, ghosts } = seatKindsOf(mainId, rowIds, rows, named, undelivered, mainWindowDebt, judgement, derived)
  const moving = movingOf(movingLegs, kids, named, order, rows)
  const ownMoving = ownMovingOf(kids)
  const standing = standingOf(ghosts, mainId, order, named, rows, derived, moving)
  const self = text(input.ownSession)
  const legIds = legIdsOf(rowIds, undelivered, named, judgement, rows, waiting, mainId, self)
  const mainWindow = main === undefined || mainId === undefined
    ? null
    : {
      ...windowFor(mainId, stock),
      ...factsOf({
        settled: main.running !== true,
        gated: atGateOf(mainId, waiting, rows),
        delivered: delivered.has(mainId),
        owed: mainWindowDebt,
        moving: ownMoving,
        yielding: yieldingOf(mainId, rowIds, rows, named, derived),
        handed: handedOf(judgement, mainId),
        ending: derivedIn(derived, mainId).ending,
      }),
    }
  const anchors = dispatchAnchorsOf(mainId === undefined ? undefined : input.events?.[mainId])
  const seats = childSeatsOf(kids, standing, named, waiting, rowIds, stock)
  const drawn = seats.slice(-WINDOW_CAP)
  const legs = legsOf(legIds, named, waiting, rowIds, ownMoving, stock)
  /* The main's parented children, untruncated: the set the panel holds event windows open
      for. It is the raw admission universe — running seats, dead seats, ended children no seat
      keeps — deliberately wider than the drawn `children` (the five the cap kept), because each
      child's own log decides whether its seat stays and that log has to be open before the seat
      exists. The snapshot's `byId` shape is read once, here, the model's own way; the ids come
      out in the map's own key order, which the watch list reads as a set. */
  const mainChildIds = mainId === undefined
    ? []
    : Object.keys(rows).filter((id) => parentOf(id, rows) === mainId)
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
