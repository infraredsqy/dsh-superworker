/**
 * The transcript's folding: a session's own log, read into the rows a window
 * draws.
 *
 * Each event folds by its own kind — a person's prompt into `input`, an
 * assistant message's reasoning and words into `think` and `output` rows, a
 * tool call into the row its tool and arguments name, a failure or a run's
 * output into the row that answers the call — and the streaming step's live
 * chunks fold into at most two tails at the line's end. The same log, read
 * whole, also yields the dispatch anchors: which call of the main session's
 * own transcript opened which child. What one event of the log is and what
 * one drawn row is ({@link OverviewEvent}, {@link OverviewRow}) are declared
 * here, beside the only code that builds them.
 */
import { asRecord, text } from './fields.ts'

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
export function liveRowsOf(events: readonly OverviewEvent[] | undefined): readonly OverviewRow[] {
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
export function dispatchAnchorsOf(events: readonly OverviewEvent[] | undefined): ReadonlyMap<string, string> {
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

export function foldRows(events: readonly OverviewEvent[] | undefined): readonly OverviewRow[] {
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
export function capped(rows: readonly OverviewRow[], capacity: unknown): readonly OverviewRow[] {
  if (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity <= 0) return rows
  return rows.length > capacity ? rows.slice(rows.length - capacity) : rows
}
