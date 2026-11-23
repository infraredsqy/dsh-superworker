/**
 * The panel's vocabulary: the one place where a fact read out of the records becomes a word a
 * reader sees.
 *
 * The split this file exists to hold: the model layer says *what* a reading is (a node is `shelved`,
 * a gate's kind is `checkpoint`, three prerequisites are owed, a moment was two days ago), and this
 * layer says *how it reads*. Nothing here computes a reading, and nothing in the model spells a
 * sentence — which is what lets a second language be added without touching the model at all.
 *
 * Every function takes its translator as its first argument rather than reaching for one. That is
 * deliberate: a caller can be handed a translator from anywhere, the unit tests can pass a
 * lookup table directly, and there is no module-level language for a component to accidentally read
 * on a stale frame.
 */
import type { Translate } from './locale.ts'
import type { Failure, FailureCode } from './failure.ts'
import type { WordKey } from './locales/index.ts'
import { clock, dayParts, elapsedParts, everySourceIs } from '../model/index.ts'
import type {
  DayParts,
  DepsReading,
  ElapsedParts,
  GateReading,
  InstructionGroupReading,
  IssueState,
  NodeReading,
  NodeState,
  PoolReading,
  SuperworkerReading,
} from '../model/index.ts'

/**
 * Pick the singular spelling at exactly one, the other spelling everywhere else.
 *
 * Chinese has one form and English has two, so a table ships both and both are the same word in
 * a language that does not inflect. A language with more forms than two would need this widened;
 * none does today, and inventing the machinery before a language needs it would cost every call
 * site.
 */
export function unit(t: Translate, one: WordKey, other: WordKey, n: number): string {
  return t(n === 1 ? one : other)
}

/** What each of a node's three states reads as; the sections that head a node state take their word
 * from this table rather than spelling the key a second time. */
export const NODE_WORDS: Readonly<Record<NodeState, WordKey>> = {
  todo: 'state.todo',
  shelved: 'state.shelved',
  completed: 'state.done',
}

/** What each of the three gate kinds reads as; the shelved gate says the state's own word. */
const GATE_WORDS: Readonly<Record<GateReading['kind'], WordKey>> = {
  shelved: 'state.shelved',
  manual: 'gate.manual',
  checkpoint: 'gate.checkpoint',
}

/** What each of the four issue states reads as. */
const ISSUE_WORDS: Readonly<Record<IssueState, WordKey>> = {
  open: 'issue.open',
  acknowledged: 'issue.acknowledged',
  rejected: 'issue.rejected',
  resolved: 'issue.resolved',
}

/** A node's state, in words. */
export function nodeWord(t: Translate, state: NodeState): string {
  return t(NODE_WORDS[state])
}

/** Which kind of person-wait this is, in words. */
export function gateWord(t: Translate, gate: GateReading): string {
  return t(GATE_WORDS[gate.kind])
}

/** The cell's gate: which word, since when. */
export function gateTitle(t: Translate, node: NodeReading, at: Date): string {
  if (node.gate === null) return ''
  const word = gateWord(t, node.gate)
  return node.gate.since === null ? word : `${word} · ${timeOf(t, node.gate.since, at)}`
}

/** The issue's own state, in words. */
export function issueWord(t: Translate, state: IssueState): string {
  return t(ISSUE_WORDS[state])
}

/** The record's three not-owed states, one phrase each: the "full" button and the combined pill say the same thing. */
export function otherStatesWord(t: Translate, pool: PoolReading): string {
  return (['acknowledged', 'rejected', 'resolved'] as const)
    .map((key) => `${issueWord(t, key)} ${String(pool.census[key])}`)
    .join(' · ')
}

/**
 * The stranded dispatch's sentence: the claim is on disk, the session is gone.
 * The words carry the record's own two names and the exact command, so the
 * remedy can be followed as it is read — this side spells it because the
 * reader's language is the panel's, and the model only said which line the
 * cell is stranded on.
 */
export function strandedTitle(t: Translate, cycleId: string, nodeId: string): string {
  return t('cell.stranded', { cycle: cycleId, node: nodeId })
}

/**
 * The heading of one group on the instruction ledger.
 *
 * Spelled from the group's own key rather than carried in the reading: a group bound to a cycle is
 * headed by that cycle's id, which is a record's own word and reads the same in every language,
 * while the globals and the unnamed bucket have words of their own.
 */
export function groupWord(t: Translate, group: InstructionGroupReading): string {
  if (group.key === 'global') return t('common.global')
  if (group.key.startsWith('cycle:')) {
    const id = group.key.slice('cycle:'.length)
    /* A cycle-bound entry whose cycle the records do not name: the same bucket as a session that
     * belongs to no workspace, and it says so rather than heading a section with nothing. */
    return id.length > 0 ? id : t('workspace.ungrouped')
  }
  return group.key
}

/** The dependency sentence in pieces: the number stays separate so the panel can style it. */
export interface DepsSentence {
  /** The whole sentence, for a tooltip or any place that prints it flat. */
  readonly said: string
  /** What stands before the number; empty in a language that leads with the number. */
  readonly head: string
  /** How many prerequisites are owed; `null` for the ready sentence, which carries no number. */
  readonly count: number | null
  /** What stands after the number. */
  readonly tail: string
}

/**
 * What a node says on the dependency field: ready to start, or how many prerequisites are owed.
 *
 * Which of the two it is comes from the reading itself — the three conditions behind "ready" are
 * judged once, in the model. This side only says it.
 */
export function depsSentence(t: Translate, deps: DepsReading): DepsSentence {
  if (deps.ready) return { said: t('state.ready'), head: '', count: null, tail: '' }
  const count = deps.count ?? 0
  const head = t('deps.owed.head')
  const tail = t('deps.owed.tail')
  return { said: `${head}${String(count)}${tail}`, head, count, tail }
}

/**
 * The day a moment fell on: today / yesterday / the day before, or a month and a day.
 *
 * Which of those it is is measured by the model against the caller's "now"; the words are here.
 */
/** No moment to name is no day to name: the panel prints nothing where a day would stand. */
export function dayLabel(t: Translate, parts: DayParts | null): string {
  if (parts === null) return ''
  if (parts.unit === 'today') return t('date.today')
  if (parts.unit === 'yesterday') return t('date.yesterday')
  if (parts.unit === 'before-yesterday') return t('date.before-yesterday')
  return t('date.month-day', { month: parts.month, day: parts.day })
}

export function timeOf(t: Translate, moment: Date | null, at: Date): string {
  return moment === null ? '--' : `${dayLabel(t, dayParts(moment, at))} ${clock(moment)}`
}

/* How long something took is measured once, by the model (`elapsedParts`: which unit, how many of it,
 * how much of the smaller one is left), and said once, here. It is the only spelling of a span the
 * panel has: a compact `1h02` once stood beside a localised one, and a second spelling of one duration
 * is the thing this file exists to avoid. The number carries no verb ("已运行", "running for"): a
 * window is saying how long it has been open, and the reader already knows what they are looking at. */
export function elapsedOf(t: Translate, seconds: number | null): string {
  const parts: ElapsedParts | null = elapsedParts(seconds)
  if (parts === null) return '--'
  if (parts.unit === 'seconds') return t('span.seconds', { seconds: parts.value })
  if (parts.unit === 'minutes') {
    return parts.rest === 0
      ? t('span.minutes', { minutes: parts.value })
      : t('span.minutes-seconds', { minutes: parts.value, seconds: parts.rest })
  }
  return parts.rest === 0
    ? t('span.hours', { hours: parts.value })
    : t('span.hours-minutes', { hours: parts.value, minutes: parts.rest })
}

/** The legacy-directory notice in the three pieces the panel renders it with. */
export interface LegacyNoticeWords {
  /** What happened, as the card's heading. */
  readonly title: string
  /** Why there is nothing to draw, as the card's one sentence. */
  readonly body: string
  /** The one way forward, as the action's word. */
  readonly link: string
}

/**
 * The legacy-directory notice, when the reading is one.
 *
 * A workspace that still holds only the previous record directory hands this half a reading with
 * nothing in it — every source said `legacy` — and every pane would draw an empty board over it,
 * so the panel shows one card instead and this layer says its three pieces. The judgment is the
 * model's (`everySourceIs`), and the words are the lookup tables'; the body names the directory
 * this plugin reads and never the one it replaced, because the old name is the engine's fact to
 * spell and a reader who needs it can ask the agent this card hands the work to.
 */
export function legacyNoticeWords(t: Translate, reading: SuperworkerReading): LegacyNoticeWords | null {
  if (!everySourceIs(reading, 'legacy')) return null
  return { title: t('panel.legacy.title'), body: t('panel.legacy.body'), link: t('panel.legacy.link') }
}

/**
 * Which of the overview's empty stages this is: the fact, not the sentence.
 *
 * The three are told apart because they are three different things to know about a workspace, and
 * one sentence standing for all of them would hide which one the reader is in: the record holds no
 * node at all, it holds nodes but names no session that ever ran here, or it names sessions and
 * none of them can be drawn right now. The one move that changes any of them no longer stands on
 * the stage — it is the corner's standing doors, which are there in every state — so a stage says
 * only what it is.
 */
export type OverviewEmpty = 'no-nodes' | 'no-session' | 'no-window'

/* One word per stage, so a fourth stage fails to compile until it speaks. */
const EMPTY_WORDS: Readonly<Record<OverviewEmpty, WordKey>> = {
  'no-nodes': 'overview.empty.no-nodes',
  'no-session': 'overview.empty.no-session',
  'no-window': 'overview.empty.no-window',
}

/**
 * The overview's empty stage's one sentence: which situation the record says it is, in the reader's
 * language. Nothing here is measured — the panel hands over the stage it has judged from the record,
 * and the words are the lookup tables'.
 */
export function overviewEmptySaid(t: Translate, kind: OverviewEmpty): string {
  return t(EMPTY_WORDS[kind])
}

/** What each refusal code reads as. One entry per code, so a new code fails to compile until it speaks. */
const FAILURE_WORDS: Readonly<Record<FailureCode, WordKey>> = {
  'arg-not-allowed': 'failure.arg-not-allowed',
  'tool-refused': 'failure.tool-refused',
  'scope-unknown': 'failure.scope-unknown',
  'empty-text': 'failure.empty-text',
  'no-session-service': 'failure.no-session-service',
  'prompt-missing': 'failure.prompt-missing',
  'open-failed': 'failure.open-failed',
  'dispatch-refused': 'failure.dispatch-refused',
  'no-operation': 'failure.no-operation',
  'not-connected': 'failure.not-connected',
  'no-write-channel': 'failure.no-write-channel',
  'unparsable-answer': 'failure.unparsable-answer',
  'transport-failed': 'failure.transport-failed',
  'config-unreadable': 'failure.config-unreadable',
  'config-write-failed': 'failure.config-write-failed',
  'settings-refused': 'failure.settings-refused',
  'settings-unwritable': 'failure.settings-unwritable',
  'unstated': 'failure.unstated',
}

/**
 * Why an operation was refused, in words.
 *
 * The detail is handed to the wording as a placeholder, so a language decides where it lands; when
 * the wording is the detail and nothing else — the tool's own reason, a transport's message — an
 * empty detail would leave nothing to read, and the sentence for that stands in.
 */
export function failureWord(t: Translate, failure: Failure): string {
  const said = t(FAILURE_WORDS[failure.code], { detail: failure.detail ?? '' }).trim()
  return said.length > 0 ? said : t('failure.unstated')
}