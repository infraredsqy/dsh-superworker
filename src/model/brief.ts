/**
 * The overview's concise reading: one line per step, one line per answer.
 *
 * The overview draws one reading twice. The full drawing is the feed as it happened — one line per
 * event, each carrying the file it touched, the command it ran, the task it dispatched. The concise
 * drawing is that same reading at a distance: a **step** is one line saying what a run of work was,
 * and an **answer** is one line saying what the conversation said back. Nothing is fetched, judged
 * or invented here; this module folds rows the full drawing already holds.
 *
 * The step's own vocabulary is DSH's, quoted rather than written: which tool belongs to which
 * category (`activity()` in `ui-chat`'s `conversation-nodes/process-activity.ts`) and how several
 * categories become one title (`processTitle()` in `chat/step-process.ts`) are the harness's own
 * answers, so a reader who has read a collapsed step in DSH's conversation reads the same words
 * here. One word deviates on purpose and it is this panel's own: a dispatch says 派出 — the word the
 * full feed already gives that row — rather than DSH's 协调子智能体, and `ralph`, a dispatch tool of
 * this panel and not of DSH, files under it.
 *
 * What a step leaves out is the point of the drawing: no paths, no commands, no arguments. A step is
 * "已读取文件并搜索代码" — never which file, never which pattern.
 *
 * A step is a run of adjacent process rows: reasoning, calls, their failures. An answer or a prompt
 * closes it, and the **last** step of a conversation that still runs is open — it is being worked,
 * so its line says what it is on now (`正在…`) instead of what it did. A step that only reasoned
 * reads 已完成分析 / 正在分析请求, DSH's own word for a group with no call to name.
 *
 * Three rows say nothing of their own. A prompt draws no line: the window's nameplate is the prompt,
 * and a feed that repeats it says one thing twice. A failed call's row joins the step and adds no
 * category — a failure is that call's outcome, not another call, and DSH's collapsed title does not
 * name it either; the window's frame says when work is owed, and the press opens the conversation
 * for whoever needs to know which call failed. A run's output row is the same: the call above it
 * already counted.
 *
 * The streaming step's tails fold in by the same rule. Its reasoning belongs to the step and is
 * never drawn as a line of its own — the step's `正在…` word is what says it is thinking. Its spoken
 * tail is the answer being written, and that is the conversation itself: it draws as an answer line,
 * read from the **head** of the buffer so the line stands still while the words arrive. (The full
 * drawing reads the tail, where the newest words are the whole point; a line that covers a step has
 * no such business, and a line whose beginning slides under the reader's eye is the flicker this
 * drawing exists to be free of.)
 */
import type { OverviewRow, OverviewRowKind } from './overview-fold.ts'

/**
 * What a call's tool is, as one word of work: the categories DSH's own step titles are built from,
 * spelled with DSH's own ids. Quoted, not re-derived — when the harness adds a category, this is the
 * line to move with it.
 */
export type BriefCategory =
  | 'read'
  | 'readImage'
  | 'search'
  | 'write'
  | 'edit'
  | 'commands'
  | 'code'
  | 'webSearch'
  | 'webFetch'
  | 'subagents'
  | 'plan'
  | 'questions'
  | 'tools'

/** The fields both lines carry: where the line stands in the list it was read from, and its identity
 *  across redraws. */
interface BriefLine {
  /** The row's identity: stable while the line grows, so a redraw updates it in place. */
  readonly key: string
  /** The first source row this line folds, as an index into the list it was read from. */
  readonly from: number
  /** The last one, inclusive. A step covers a run of rows; an answer covers one. */
  readonly to: number
}

/** One step, said in one line. */
export interface BriefStep extends BriefLine {
  readonly kind: 'step'
  /** The tool categories it reached for, most-used first, ties by first appearance. Empty when it only reasoned. */
  readonly categories: readonly BriefCategory[]
  /** Whether it is still being worked: the last step of a conversation that still runs. */
  readonly open: boolean
  /** What an open step is on now; `null` while it is reasoning. A closed step states nothing. */
  readonly now: BriefCategory | null
}

/** One answer, said in one line: the sentence it opens with. */
export interface BriefReply extends BriefLine {
  readonly kind: 'reply'
  readonly text: string
}

/** One line of the concise drawing. */
export type BriefRow = BriefStep | BriefReply

/** The rows a step is made of: everything the conversation did, as against what it was asked and
 *  what it said back. Those two are the lines' closers. */
const PROCESS_ROWS: ReadonlySet<OverviewRowKind> = new Set<OverviewRowKind>([
  'think',
  'read',
  'write',
  'run',
  'dispatch',
  'fail',
  'tool',
])

/** How much of a streaming answer a line keeps: a head far past the one line a window can show, so
 *  the line stops moving once it has filled and no frame redraws it for a word that cannot be seen. */
const BRIEF_HEAD = 160

/**
 * A call's tool, as one category of work — DSH's own classification, quoted line for line from
 * `process-activity.ts`. A name outside it is a tool this classification does not know, and files
 * under the neutral `tools`, exactly as DSH files it.
 */
function activityOf(name: string): BriefCategory {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_') || name === 'ralph') return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

/**
 * The category an open step is on now: the call its newest row stands for. A row that names no tool
 * is not a call — a run's output answers the command above it, a failure answers the call above it —
 * and the step is then reasoning, which is what DSH says when no tool is running.
 */
function nowOf(row: OverviewRow): BriefCategory | null {
  if (row.name !== undefined) return activityOf(row.name)
  if (row.kind === 'run') return 'commands'
  return null
}

/** The head of a buffer, its whitespace flattened, cut to what one line may keep. A cut through a
 *  surrogate pair drops the orphaned half rather than printing half a glyph. */
function headOf(full: string): string {
  const flat = full.replace(/\s+/gu, ' ').trim()
  if (flat.length <= BRIEF_HEAD) return flat
  const cut = flat.slice(0, BRIEF_HEAD)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** What an answer's line says: its opening sentence once it has settled, its head while it streams. */
function replyTextOf(row: OverviewRow): string {
  return row.live === true ? headOf(row.full) : row.text
}

/**
 * The concise reading of one window's rows.
 *
 * @param input.rows - The rows the full drawing draws, in the order they happened.
 * @param input.running - Whether the conversation is still running: the one fact that makes its last
 *   step open, and the only one that could — a step is closed by what came after it, never by a clock.
 */
export function briefRowsOf(input: {
  readonly rows: readonly OverviewRow[]
  readonly running: boolean
}): readonly BriefRow[] {
  const { rows, running } = input
  const out: BriefRow[] = []
  const seen = new Set<string>()
  /** A line's identity: the moment of the row it opens on, so a step growing at its end keeps the
   *  line it was drawn as. A live row carries no moment, and its place in the list is its identity. */
  const keyOf = (kind: 'step' | 'reply', first: OverviewRow | undefined, index: number): string => {
    const base = first?.at === undefined ? `${kind}:live:${index}` : `${kind}:${first.at}`
    let key = base
    while (seen.has(key)) key = `${key}+`
    seen.add(key)
    return key
  }
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row === undefined) break
    if (row.kind === 'input') {
      index += 1
      continue
    }
    if (row.kind === 'output') {
      out.push({
        kind: 'reply',
        key: keyOf('reply', row, index),
        from: index,
        to: index,
        text: replyTextOf(row),
      })
      index += 1
      continue
    }
    let end = index
    while (end + 1 < rows.length) {
      const next = rows[end + 1]
      if (next === undefined || !PROCESS_ROWS.has(next.kind)) break
      end += 1
    }
    out.push(stepOf(rows, index, end, running, keyOf('step', rows[index], index)))
    index = end + 1
  }
  return out
}

/** One step, off the rows it folds: its categories ranked, and whether it is still being worked. */
function stepOf(
  rows: readonly OverviewRow[],
  from: number,
  to: number,
  running: boolean,
  key: string,
): BriefStep {
  const ranked = new Map<BriefCategory, { count: number; first: number }>()
  const counted = new Set<string>()
  for (let at = from; at <= to; at++) {
    const row = rows[at]
    if (row === undefined || row.name === undefined) continue
    /* One call, one count: the call's own id is its identity, and a row carrying none counts once on
       its own. Ranking by how many rows a category was written on rather than by how many calls it
       made is exactly the drift this guard keeps out. */
    if (row.callId !== undefined) {
      if (counted.has(row.callId)) continue
      counted.add(row.callId)
    }
    const category = activityOf(row.name)
    const held = ranked.get(category)
    if (held === undefined) ranked.set(category, { count: 1, first: at })
    else held.count += 1
  }
  const categories = [...ranked.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].first - right[1].first)
    .map(([category]) => category)
  const open = running && to === rows.length - 1
  const last = rows[to]
  return {
    kind: 'step',
    key,
    from,
    to,
    categories,
    open,
    now: open && last !== undefined ? nowOf(last) : null,
  }
}
