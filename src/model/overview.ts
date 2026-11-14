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
 * The snapshot's and the log's field spellings are DSH's own (`running`,
 * `parentId`, `retainedBy.mainView`, `tool/call`, …), read defensively: a
 * field that is not there reads as absent, and no default pretends to know it.
 * No "still running this round" projection folded out of logs is read either —
 * that word stops at its old value when a session dies mid-round, and the
 * list's own running bit is the authority.
 */
import type { SuperworkerNode } from './records.ts'
import { text } from './fields.ts'

/**
 * The window cap: more than this many children still running, and the overview
 * draws only the most recent ones. The cap counts the children alone — the
 * main window is the conversation this panel lives in, and it is one of the
 * windows whenever the list has it.
 */
const WINDOW_CAP = 5

/** One row of the session-list snapshot, as far as this reading reads it. */
export interface OverviewSessionRow {
  readonly id?: unknown
  /** The list's running bit: the authoritative alive word for a child. */
  readonly running?: unknown
  /** The parent's id: what makes a session one of the main session's children. */
  readonly parentId?: unknown
  /** The label the list itself spells: a window's title when it works no node. */
  readonly displayTitle?: unknown
  /** Local ownership counts; `mainView` over zero marks the main view's session. */
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
}

/** The overview's reading at this snapshot. */
export interface OverviewReading {
  /** The main window: the conversation this panel lives in; absent when the list has none. */
  readonly main: OverviewWindow | null
  /** The children still running this round, oldest first: at most five, taken anew at every read. */
  readonly children: readonly OverviewWindow[]
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
 * The main view's session: the row whose `retainedBy.mainView` is over zero —
 * the list's own standard for "the one currently open", read the one way it is
 * read anywhere in this panel.
 */
function mainIdOf(snapshot: OverviewSnapshot): string | undefined {
  for (const row of Object.values(rowsOf(snapshot))) {
    const count = asRecord(row?.retainedBy)?.mainView
    if (typeof count !== 'number' || count <= 0) continue
    const id = row?.id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
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
 * One tool call folds into one row, named by the tool's own arguments. A run
 * tool's call id is kept: the result event answers by it, and only a run's
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
  rows.push({ kind, text: firstSentence(subject), full: subject })
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

/**
 * Read the overview's windows and rows off one snapshot.
 *
 * The main session in the list is one window — its being the list's main view
 * is the whole fact, running or not, because it is the conversation the reader
 * is in. A child counts as a window only while the list's running bit says it
 * is still running this round: ended it drops, called up again it is a window
 * again, and nothing is probed or pinned to hold it. Over five running
 * children the most recent five are taken — taken whole from whoever is alive
 * at that moment, never the first five pinned, never a gap filled at the end.
 * A list without a main view makes no overview at all: the children hang from
 * the conversation this panel lives in, and without it there is nothing to
 * hang them on.
 */
export function readOverview(input: OverviewInput): OverviewReading {
  const rows = rowsOf(input.sessions)
  const order = listedIds(input.sessions)
  const mainId = mainIdOf(input.sessions)
  const nodeFor = (id: string): SuperworkerNode | undefined =>
    input.nodeOf === undefined ? undefined : input.nodes?.[input.nodeOf[id] ?? '']
  const main = mainId === undefined ? undefined : rows[mainId]
  const children = mainId === undefined
    ? []
    : order
      .filter((id) => {
        if (id === mainId) return false
        const row = rows[id]
        return row !== undefined && row.parentId === mainId && row.running === true
      })
      .slice(-WINDOW_CAP)
  return {
    main:
      main === undefined || mainId === undefined
        ? null
        : windowOf(mainId, main, nodeFor(mainId), input.events?.[mainId], input.capacity),
    children: children.map((id) => {
      const row = rows[id] ?? { id }
      return windowOf(id, row, nodeFor(id), input.events?.[id], input.capacity)
    }),
  }
}
