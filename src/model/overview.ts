/**
 * The overview's reading: which windows the overview draws, and which rows
 * each one draws.
 *
 * What comes in is what the browser already holds: the session list's own
 * snapshot (a pushed state, so liveness is read straight off its running bit —
 * it is never probed by opening a session, an act that would wake an ended
 * one), each session's own events, and the record side that names a window:
 * which node the session works, and that node's verbatim record. What comes
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
 * drawn and not counted — the window it had is taken off the page by the
 * client's leave animation, which is why the drawing never has to keep a
 * finished one. The main window is the conversation this panel lives in, and it
 * carries the facts the drawing's states are read from: `settled` (the list's
 * running bit is not true — the rows will not move again), `delivered` (the
 * record says the work is handed in), `waiting` (the caller names this session
 * as one whose node stands at a person's gate) and `alert` (work is owed,
 * nobody is doing it, and the conversation did not end by itself). See
 * {@link OverviewWindow}.
 *
 * The snapshot's and the log's field spellings are DSH's own (`running`,
 * `parentId`, `updatedAt`, `tool/call`, …), read defensively: a field that is
 * not there reads as absent, and no default pretends to know it. No "still
 * running this round" projection folded out of logs is read either — that word
 * stops at its old value when a session dies mid-round, and the list's own
 * running bit is the authority.
 */
import type { SuperworkerNode } from './records.ts'
import { secondsBetween, text } from './fields.ts'

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
  /** The label the list itself spells: a window's title when it works no node. */
  readonly displayTitle?: unknown
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
 * happened — a reasoning step, a file read or written, a command run, the
 * model's own words, a task dispatched, a failure, and the neutral `tool` for
 * a call this fold does not know by name.
 */
export type OverviewRowKind = 'think' | 'read' | 'write' | 'run' | 'output' | 'dispatch' | 'fail' | 'tool'

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
  /** Its title: the node's own when it works one, else the list's own label; absent when neither is written. */
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
   * says the piece of work was handed in. The main window is the only one that
   * can carry it today — a child is a window only while it is still running, so
   * the reading never produces a settled child. Absent means it is running.
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
   * by a line, its session is not alive, and its conversation did not end by
   * itself — it was stopped, the host disposed of it, the process interrupted
   * it, it failed — or it ended with the debt still held while no leg of this
   * pipeline is moving at all. A conversation that merely yielded to work of its
   * own (waiting for a leg it dispatched) is not this: the pipeline is still
   * moving, so nothing is stuck.
   */
  readonly alert?: boolean
  /**
   * How the conversation's last turn ended, verbatim off DSH's own `turn/end`
   * reason ({@link OverviewEnding}): the fact a reader is told the reason with.
   * Absent when no `turn/end` is readable in the window's own events.
   */
  readonly ending?: OverviewEnding
  /**
   * Whether this window stands at a person's gate: the caller named this session
   * as one whose node owes a person a word — a checkpoint (delivered, not
   * approved) or a manual node nobody has started. That judgment is the record's
   * own (`readProject`'s node gate); this module only carries the fact the
   * caller hands over and never re-reads the record for it. Only the main window
   * carries it, and the drawing reads it before anything else: a window at the
   * gate is drawn as waiting, never as finished and never as broken.
   */
  readonly waiting?: boolean
}

/** The overview's reading at this snapshot. */
export interface OverviewReading {
  /**
   * The main window: the conversation this panel's pipeline owns — its own
   * session when the record names it, else a named one still running, else the
   * named one that moved last. Absent when the record names none of the list's
   * sessions: the stage stays empty rather than showing a conversation the
   * pipeline never mentioned. It is the only window that can carry
   * {@link OverviewWindow.settled}, {@link OverviewWindow.delivered},
   * {@link OverviewWindow.waiting} and {@link OverviewWindow.alert}.
   */
  readonly main: OverviewWindow | null
  /**
   * The child windows, oldest first: the sessions the list still calls running
   * that the record names, plus the main session's own running children — at
   * most five, taken anew at every read. A child that ended is not here, and
   * neither is one with nothing readable: its window leaves the page by the
   * client's leave animation.
   */
  readonly children: readonly OverviewWindow[]
  /**
   * How many **running** children the five-window cap folded away — a count,
   * never a window: 0 is 0. A session dropped for having nothing readable was
   * never a window, so it is not counted here either.
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
  /** Which node each session works, keyed by session id — folded by the caller out of the records' own session notes, not re-read here. */
  readonly nodeOf?: Readonly<Record<string, string>>
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
   * Which session this panel itself belongs to (DSH's own `sessionId` prop).
   * It is the main window whenever the record names it — the reader's own
   * conversation is the one they expect to see, running or not.
   */
  readonly sessionId?: unknown
  /**
   * The sessions whose node stands at a person's gate, both kinds: a
   * **checkpoint** (delivered, and that delivery not approved yet) and a
   * **manual** node nobody has started. The panel computes it off the record's
   * own gate reading (`readProject`'s `node.gate.kind`) — the manual kind only
   * while nobody is working the node, since a gate is a person being owed, not a
   * conversation being quiet — and hands the session ids over; this module only
   * carries the fact, so the gate is never re-read and never invented here. The
   * main window stands waiting when its session is one of these; absent means
   * none is.
   */
  readonly waitingSessions?: readonly unknown[] | undefined
  /**
   * The sessions whose node the record calls **delivered**: the node's state is
   * `completed` and no gate of this reading stands on it. The judgment is the
   * record's own (`readProject`'s `node.state`); this module only carries it, and
   * the drawing puts its check on nothing else.
   */
  readonly deliveredSessions?: readonly unknown[] | undefined
  /**
   * The nodes the dispatch reading calls **stranded** — a claim on disk, the
   * cell still held by a line, and the session its note names absent from this
   * host's live agents (`strandedCycleOf`). The judgment is already made by the
   * caller, which has the three facts; this module only reads the debt off it.
   */
  readonly strandedNodes?: readonly unknown[] | undefined
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
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
  const raw = row?.updatedAt
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.length > 0) {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return ms
  }
  return 0
}

/** The moment a reading was taken at, read the same way a row's own moment is; absent says nothing. */
function atOf(raw: unknown): Date | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw)
  if (typeof raw === 'string' && raw.length > 0) {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return new Date(ms)
  }
  return null
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
 * Which conversation is the main window — the one rule, in the order it reads:
 *
 * 1. the panel's own session, when the record names it: the reader's own
 *    conversation, running or not;
 * 2. else a session the record names that the list still calls running (the
 *    newest of them when several are);
 * 3. else the one the record names that moved last;
 * 4. else nothing — no window at all, rather than a conversation the pipeline
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
): string | undefined {
  const named = pipelineOf(input)
  const self = text(input.sessionId)
  if (named === undefined) {
    if (self !== undefined) return rows[self] === undefined ? undefined : self
    return mainViewOf(rows)
  }
  if (self !== undefined && named.has(self)) return rows[self] === undefined ? undefined : self
  const candidates = [...named].filter((id) => rows[id] !== undefined)
  const running = candidates.filter((id) => rows[id]?.running === true)
  if (running.length > 0) return latestOf(running, rows, order)
  return candidates.length > 0 ? latestOf(candidates, rows, order) : undefined
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
function pushRow(rows: OverviewRow[], kind: OverviewRowKind, full: string | undefined): void {
  if (full === undefined || full.length === 0) return
  const cut = firstSentence(full)
  if (cut.length === 0) return
  rows.push({ kind, text: cut, full })
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
 * own `tool/call` event, and one call must not become two rows. The reader's
 * own words fold to nothing: the feed shows what the conversation is doing,
 * and the reader already knows what they said.
 */
function foldAssistant(data: Record<string, unknown> | undefined, rows: OverviewRow[]): void {
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
  pushRow(rows, 'think', thinking.length > 0 ? thinking.join('\n') : undefined)
  pushRow(rows, 'output', spoken.length > 0 ? spoken.join('\n') : undefined)
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
): void {
  const message = asRecord(data?.message)
  const error = asRecord(data?.error)
  if (error !== undefined) {
    pushRow(rows, 'fail', text(error.reason) ?? contentTextOf(message) ?? text(error.code) ?? text(error.name))
    return
  }
  const callId = text(message?.toolCallId) ?? text(asRecord(message?.source)?.callId)
  if (callId === undefined || !runCalls.has(callId)) return
  pushRow(rows, 'run', contentTextOf(message))
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
    if (type === 'assistant/message') foldAssistant(data, rows)
    else if (type === 'tool/call') foldCall(data, rows, runCalls)
    else if (type === 'tool/result') foldResult(data, rows, runCalls)
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

/** When the conversation started: the earliest moment its own events carry. */
function startedAtOf(events: readonly OverviewEvent[] | undefined): Date | null {
  let earliest: number | undefined
  for (const event of events ?? []) {
    const time = event.time
    if (typeof time === 'number' && Number.isFinite(time) && (earliest === undefined || time < earliest)) {
      earliest = time
    }
  }
  return earliest === undefined ? null : new Date(earliest)
}

/**
 * When the conversation last moved: the newest moment its own events carry. It is
 * the end of the span a window that stopped is measured to — the log's own last
 * word, not the moment this reading was taken, which would keep a dead window's
 * number counting for as long as the panel stays open.
 */
function endedAtOf(events: readonly OverviewEvent[] | undefined): Date | null {
  let latest: number | undefined
  for (const event of events ?? []) {
    const time = event.time
    if (typeof time === 'number' && Number.isFinite(time) && (latest === undefined || time > latest)) {
      latest = time
    }
  }
  return latest === undefined ? null : new Date(latest)
}

function titleOf(row: OverviewSessionRow, node: SuperworkerNode | undefined): string | null {
  return text(node?.title) ?? text(row.displayTitle) ?? null
}

/** The engine's own reading of weight: only `light` ever lands on disk, so anything unwritten or other is standard. */
function weightOf(node: SuperworkerNode | undefined): 'light' | 'standard' | null {
  if (node === undefined) return null
  return text(node.weight) === 'light' ? 'light' : 'standard'
}

function modeOf(node: SuperworkerNode | undefined): string | null {
  if (node === undefined) return null
  return text(node.mode) ?? 'auto'
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

/** The sessions the caller named as standing at a person's gate; nothing named is none. */
function waitingOf(input: OverviewInput): ReadonlySet<string> {
  return namedSet(input.waitingSessions)
}

/**
 * The one way a caller-named list of sessions is read: ids that name something,
 * a list that is absent or not a list naming nobody. (A named *pipeline* keeps
 * its own tri-state reading — `pipelineOf` — because "nobody said" and "the
 * record names none" are different facts there.)
 */
function namedSet(list: readonly unknown[] | undefined): ReadonlySet<string> {
  const named = new Set<string>()
  if (!Array.isArray(list)) return named
  for (const id of list) {
    if (typeof id === 'string' && id.length > 0) named.add(id)
  }
  return named
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
 * `alert` is deliberately narrow: it needs the debt (`stranded`, which the
 * caller has already judged against the record and this host's live agents) and
 * a conversation that did not end by itself, or one that did but left the debt
 * standing while nothing else in the pipeline moves. A conversation that yielded
 * to a leg of its own is a pipeline still in motion, and that is not a break.
 */
function factsOf(input: {
  readonly settled: boolean
  readonly gated: boolean
  readonly delivered: boolean
  readonly owed: boolean
  readonly moving: boolean
  readonly ending: OverviewEnding | undefined
}): Pick<OverviewWindow, 'settled' | 'delivered' | 'alert' | 'waiting' | 'ending'> {
  const ending = input.ending === undefined ? {} : { ending: input.ending }
  const settled = input.settled ? { settled: true } : {}
  if (input.gated) return { ...settled, ...ending, waiting: true }
  /* A delivery is a verdict about a piece of work that is over: while the conversation still runs, the
     record naming the node completed is the *previous* round's word, and stamping a moving window with
     a check would claim a run that has not ended. */
  if (input.delivered && input.settled) return { ...settled, ...ending, delivered: true }
  const broken = input.ending !== undefined && input.ending.kind !== 'completed'
  const stuck = input.ending !== undefined && input.ending.kind === 'completed' && !input.moving
  if (input.owed && (broken || stuck)) return { ...settled, ...ending, alert: true }
  return { ...settled, ...ending }
}

/**
 * Read the overview's windows and rows off one snapshot.
 *
 * The main window is the conversation this pipeline owns
 * ({@link mainIdOf}): its own session when the record names it, else a named
 * session still running, else the named one that moved last — and no window at
 * all when the record names none, or names only sessions the list does not
 * hold. A child counts as a window while the list's running bit says it is
 * still running and the record names it — or, named or not, its `parentId` is
 * that main session, which is the one admission a caller without a record side
 * has. A child with no readable head and no readable events is no window: the
 * box it would draw says nothing. A child that ended is not drawn and not
 * counted, because the window it had is taken off the page by the client's
 * leave animation — the reading never has to keep a finished one. A session of
 * another conversation, and any child of one, is never drawn here.
 * Over five child windows the most recent five are taken — taken whole from
 * whoever is running at that moment, never the first five pinned, never a gap
 * filled at the end — and the running ones the five leave out are counted, not
 * drawn: `hiddenChildren` is how many running children the cap folded away.
 *
 * The window's state facts are read here and nowhere else ({@link factsOf}):
 * `settled` is the list's running bit not being true, `waiting` is the caller
 * naming this session as one whose node owes a person a word, `delivered` is the
 * caller naming it as a node the record calls completed, and `alert` is a debt
 * nobody is working — the caller's stranded reading, plus a conversation that did
 * not end by itself (`turn/end` says so) or that ended with the debt standing
 * while no leg of the pipeline moves. The check belongs to `delivered` alone: a
 * conversation going quiet is not a piece of work handed in, and a checkpoint's
 * silence is why the gate is drawn first.
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
  const mainId = mainIdOf(input, rows, order)
  const nodeFor = (id: string): SuperworkerNode | undefined =>
    input.nodeOf === undefined ? undefined : input.nodes?.[input.nodeOf[id] ?? '']
  const main = mainId === undefined ? undefined : rows[mainId]
  const at = atOf(input.at)
  const waiting = waitingOf(input)
  const delivered = namedSet(input.deliveredSessions)
  const stranded = namedSet(input.strandedNodes)
  /* Whether any leg of this pipeline is still alive right now: a conversation
     that yielded while these move is waiting on its own work, not broken. A
     caller that named nothing judges across the whole list it handed over. */
  const moving = (named === undefined ? order : [...named]).some((id) => rows[id]?.running === true)
  const owedBy = (id: string): boolean => {
    const node = input.nodeOf?.[id]
    return node !== undefined && stranded.has(node)
  }
  const mainWindow = main === undefined || mainId === undefined
    ? null
    : {
      ...windowOf(mainId, main, nodeFor(mainId), input.events?.[mainId], input.capacity, input.live?.[mainId], at),
      ...factsOf({
        settled: main.running !== true,
        gated: waiting.has(mainId),
        delivered: delivered.has(mainId),
        owed: owedBy(mainId),
        moving,
        ending: endingOf(input.events?.[mainId]),
      }),
    }
  const anchors = dispatchAnchorsOf(mainId === undefined ? undefined : input.events?.[mainId])
  /* The seats the column can take: the sessions the record names and the list calls running — the
     relay's legs, whose parent links point wherever the last trigger stood — plus the main session's
     own running children, which is the whole admission when the caller says nothing about the
     pipeline. A finished session is no seat however its dispatch row stands: its window leaves the
     page by the client's leave animation, and the reading keeps no finished one. */
  const running: string[] = []
  if (mainId !== undefined) {
    for (const id of order) {
      if (id === mainId) continue
      const row: OverviewSessionRow | undefined = rows[id]
      if (row === undefined || row.running !== true) continue
      const admitted = named === undefined || named.has(id) || row.parentId === mainId
      if (!admitted) continue
      running.push(id)
    }
  }
  /* A window with nothing readable — no nameplate word and no row its own events fold into — is a
     box, not a window, and the running bit alone never stands one up. Dropped here, it is also no
     seat the cap could fold away, so the count keeps counting windows alone. */
  const seats: OverviewWindow[] = []
  for (const id of running) {
    const window = windowOf(id, rows[id] ?? { id }, nodeFor(id), input.events?.[id], input.capacity, input.live?.[id], at)
    if (window.title === null && window.rows.length === 0) continue
    /* A seat is drawn only while it runs, so it carries no state of its own: the gate, the delivery
       and the debt are verdicts about work at rest, and the main window is where they are read. The
       ending rides along all the same — it is a fact about the conversation, not about the work. */
    const ending = endingOf(input.events?.[id])
    seats.push(ending === undefined ? window : { ...window, ending })
  }
  const drawn = seats.slice(-WINDOW_CAP)
  return {
    main: mainWindow,
    children: drawn.map((window) => {
      const dispatchCallId = anchors.get(window.id)
      return dispatchCallId === undefined ? window : { ...window, dispatchCallId }
    }),
    /* Counted off the seats, never off the five the cap kept: what the cap folded away is the
       windows it left out. */
    hiddenChildren: seats.length - drawn.length,
  }
}
