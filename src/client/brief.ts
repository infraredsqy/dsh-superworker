/**
 * The concise drawing's words: one line's sentence, off the facts `model/brief.ts` folded.
 *
 * The model says what a step *was* — its categories, ranked, and whether it is still being worked —
 * and never what to call it, because a word belongs to the reader's language. This file is that
 * second half, and it writes nothing of its own either: the sentences are DSH's `message.stepProcess`
 * words and DSH's `processTitle()` join, quoted from `ui-chat`'s own table and function, so a step
 * says the same thing here as it does in a collapsed step in the harness's conversation.
 *
 * Two things are this panel's own and both are stated where they are used: the dispatch word (the
 * panel's `派出`, not the harness's `协调子智能体`) and the absence of a hold on the open step's
 * word. DSH holds a live title for 150ms because that title carries the streaming task detail, which
 * changes with every chunk; this one carries no detail, so it has nothing to debounce — it changes
 * when the step reaches for a new kind of work, and that is a change worth showing at once.
 */
import type { BriefCategory, BriefRow } from '../model/index.ts'
import type { Translate } from './locale.ts'
import type { WordKey } from './locales/index.ts'

/** What a closed step says it did, per category. */
const DONE_WORDS: Readonly<Record<BriefCategory, WordKey>> = {
  read: 'brief.done.read',
  readImage: 'brief.done.readImage',
  search: 'brief.done.search',
  write: 'brief.done.write',
  edit: 'brief.done.edit',
  commands: 'brief.done.commands',
  code: 'brief.done.code',
  webSearch: 'brief.done.webSearch',
  webFetch: 'brief.done.webFetch',
  subagents: 'brief.done.subagents',
  plan: 'brief.done.plan',
  questions: 'brief.done.questions',
  tools: 'brief.done.tools',
}

/** What an open step says it is on. `thinking` is DSH's own word for a step with no call to name. */
const RUN_WORDS: Readonly<Record<BriefCategory | 'thinking', WordKey>> = {
  thinking: 'brief.run.thinking',
  read: 'brief.run.read',
  readImage: 'brief.run.readImage',
  search: 'brief.run.search',
  write: 'brief.run.write',
  edit: 'brief.run.edit',
  commands: 'brief.run.commands',
  code: 'brief.run.code',
  webSearch: 'brief.run.webSearch',
  webFetch: 'brief.run.webFetch',
  subagents: 'brief.run.subagents',
  plan: 'brief.run.plan',
  questions: 'brief.run.questions',
  tools: 'brief.run.tools',
}

/**
 * The one line a concise row draws.
 * @param t - The translator for the reader's language.
 * @param row - The line the model folded.
 */
export function briefLineOf(t: Translate, row: BriefRow): string {
  if (row.kind === 'reply') return row.text
  if (row.open) return t(RUN_WORDS[row.now ?? 'thinking'])
  return joinedTitle(t, row.categories)
}

/**
 * A closed step's title: DSH's `processTitle()` quoted, three categories at most.
 *
 * Two labels that share a prefix say it once — `已读取文件并搜索代码`, not `已读取文件并已搜索代码` —
 * and the prefix is a word of the language's own, so a language that has none never elides. Every
 * label but the first is continued in lower case, which is what lets a language whose labels open
 * with a capital read the join as one sentence.
 *
 * @param t - The translator for the reader's language.
 * @param categories - The step's categories, ranked; empty when it only reasoned.
 */
function joinedTitle(t: Translate, categories: readonly BriefCategory[]): string {
  const labels = categories.slice(0, 3).map((kind) => t(DONE_WORDS[kind]))
  const first = labels[0]
  if (first === undefined) return t('brief.done.thinking')
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const prefix = t('brief.step.shared')
    const shared = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
    return t('brief.step.joinTwo', { first, second: continuation(shared ? second.slice(prefix.length) : second) })
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t('brief.step.comma'))
  /* Past three the title says three and stops: the number of categories is not a reading anyone acts
   * on, and a count beside a word this short would be read before the word. */
  return categories.length > 3 ? t('brief.step.more', { title }) : title
}
