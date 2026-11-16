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
 * A child window is a child that is still running: the list's own bit says
 * alive, or the child is no window at all. A child that ended is not drawn and
 * not counted — the window it had is taken off the page by the client's leave
 * animation, which is why the drawing never has to keep a finished one. The
 * main window is the conversation this panel lives in, and it carries the two
 * bits the drawing's three states are read from: `done` (the list's running bit
 * is not true) and `waiting` (the caller names this session as one whose node
 * stands at the person gate — a checkpoint). See
 * {@link OverviewWindow.done} and {@link OverviewWindow.waiting}.
 *
 * The snapshot's and the log's field spellings are DSH's own (`running`,
 * `parentId`, `updatedAt`, `tool/call`, …), read defensively: a field that is
 * not there reads as absent, and no default pretends to know it. No "still
 * running this round" projection folded out of logs is read either — that word
 * stops at its old value when a session dies mid-round, and the list's own
 * running bit is the authority.
 */
import type { SuperworkerNode } from './records.ts'
import { text } from './fields.ts'

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
   * running bit is not true. The main window is the only one that can carry it —
   * a child is a window only while it is still running, and one that ended leaves
   * the page by the client's leave animation instead of staying as a finished
   * window, so the reading never produces a done child. Absent means the
   * conversation is running.
   */
  readonly done?: boolean
  /**
   * Whether this window stands at a person's gate: the caller named this session
   * as one whose node is a checkpoint — the node's mode is `checkpoint`, it is
   * delivered, and this delivery has not been approved yet. That judgment is the
   * record's own (`readProject`'s node gate); this module only carries the fact
   * the caller hands over and never re-reads the record for it. Only the main
   * window carries it, and the drawing reads it before {@link done}: a window at
   * the gate is drawn as waiting, never as finished. Absent means no gate.
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
   * pipeline never mentioned. It is the only window that carries
   * {@link OverviewWindow.done} and {@link OverviewWindow.waiting}.
   */
  readonly main: OverviewWindow | null
  /**
   * The child windows, oldest first: the ones still running this round — at most
   * five, taken anew at every read. A child that ended is not here: its window
   * leaves the page by the client's leave animation.
   */
  readonly children: readonly OverviewWindow[]
  /**
   * How many **running** children the five-window cap folded away — a count,
   * never a window: 0 is 0.
   */
  readonly hiddenChildren: number
}

/** What the overview's reading reads. */
export interface OverviewInput {
  /** The session-list snapshot as the browser holds it. */
  readonly sessions: OverviewSnapshot
  /** Each session's own events, keyed by session id; a session with none here draws none. */
  readonly events?: Readonly<Record<string, readonly OverviewEvent[]>>
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
   * The sessions whose node stands at a person's gate and reads as a
   * **checkpoint**: the node's mode is `checkpoint`, it has been delivered, and
   * that delivery has not been approved yet. The panel already computes it off
   * the record's own gate reading (`readProject`'s `node.gate.kind`), and hands
   * the session ids over; this module only carries the fact, so the gate is
   * never re-read and never invented here. The main window stands waiting when
   * its session is one of these; absent means none is.
   */
  readonly waitingSessions?: readonly unknown[] | undefined
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

/** One row, only when there is something to say: a row with no content is not drawn. */
function pushRow(rows: OverviewRow[], kind: OverviewRowKind, full: string | undefined): void {
  if (full === undefined || full.length === 0) return
  rows.push({ kind, text: firstSentence(full), full })
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
 * result is worth a row of its own.
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
  rows.push({
    kind,
    text: firstSentence(subject),
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
): OverviewWindow {
  return {
    id,
    title: titleOf(row, node),
    weight: weightOf(node),
    mode: modeOf(node),
    startedAt: startedAtOf(events),
    rows: capped(foldRows(events), capacity),
  }
}

/** The sessions the caller named as standing at a person's gate; nothing named is none. */
function waitingOf(input: OverviewInput): ReadonlySet<string> {
  const waiting = new Set<string>()
  if (!Array.isArray(input.waitingSessions)) return waiting
  for (const id of input.waitingSessions) {
    if (typeof id === 'string' && id.length > 0) waiting.add(id)
  }
  return waiting
}

/**
 * Read the overview's windows and rows off one snapshot.
 *
 * The main window is the conversation this panel's pipeline owns
 * ({@link mainIdOf}): its own session when the record names it, else a named
 * session still running, else the named one that moved last — and no window at
 * all when the record names none, or names only sessions the list does not
 * hold. A child counts as a window while its `parentId` is that main session
 * **and** the list's running bit says it is still running; a child that ended is
 * not drawn and not counted, because the window it had is taken off the page by
 * the client's leave animation — the reading never has to keep a finished one.
 * A session of another conversation, and any child of one, is never drawn here.
 * Over five child windows the most recent five are taken — taken whole from
 * whoever is running at that moment, never the first five pinned, never a gap
 * filled at the end — and the running ones the five leave out are counted, not
 * drawn: `hiddenChildren` is how many running children the cap folded away.
 *
 * The main window's two bits are read here and nowhere else: `done` is the
 * list's running bit not being true, and `waiting` is the caller naming this
 * session as one whose node stands at the person gate (a checkpoint). Which of
 * the three states a window is drawn in is the drawing half's business, and the
 * gate is read before `done` there: a checkpoint is why its conversation stopped,
 * not a finished piece of work.
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
  const mainId = mainIdOf(input, rows, order)
  const nodeFor = (id: string): SuperworkerNode | undefined =>
    input.nodeOf === undefined ? undefined : input.nodes?.[input.nodeOf[id] ?? '']
  const main = mainId === undefined ? undefined : rows[mainId]
  const waiting = waitingOf(input)
  const mainWindow = main === undefined || mainId === undefined
    ? null
    : {
      ...windowOf(mainId, main, nodeFor(mainId), input.events?.[mainId], input.capacity),
      done: main.running !== true,
      ...(waiting.has(mainId) ? { waiting: true } : {}),
    }
  const anchors = dispatchAnchorsOf(mainId === undefined ? undefined : input.events?.[mainId])
  /* The children the cap has to seat: the ones alive this round, and nothing else. A finished child
     is not a window however its dispatch row stands — its window leaves the page by the client's
     leave animation, and the reading keeps no finished one to draw. */
  const running: string[] = []
  if (mainId !== undefined) {
    for (const id of order) {
      if (id === mainId) continue
      const row: OverviewSessionRow | undefined = rows[id]
      if (row === undefined || row.parentId !== mainId) continue
      if (row.running === true) running.push(id)
    }
  }
  const drawn = order.filter((id) => running.includes(id)).slice(-WINDOW_CAP)
  return {
    main: mainWindow,
    children: drawn.map((id) => {
      const row: OverviewSessionRow = rows[id] ?? { id }
      const window = windowOf(id, row, nodeFor(id), input.events?.[id], input.capacity)
      const dispatchCallId = anchors.get(id)
      return dispatchCallId === undefined ? window : { ...window, dispatchCallId }
    }),
    /* Counted off the running list, never off the five the cap kept: what the cap folded away is
       the running children it left out. */
    hiddenChildren: running.length - drawn.length,
  }
}
