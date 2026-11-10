/**
 * The lines the panel spells for the instruction verbs, built on this side of the boundary.
 *
 * The `instruction` verb surface belongs to the plugin folder this package ships
 * (`packages/superworker-core/plugins/instruction/`), and a plugin folder imports nothing from the
 * engine. So the four translations from a panel action to a word line live here, next to the panel's
 * write path, instead of in the engine:
 *
 * - `add` is `instruction add --scope … --text …`, with the scope vocabulary checked before the line
 *   is handed over (an empty sentence and an unknown scope are refusals of this call, reported as
 *   codes rather than as a line the words layer would have to refuse);
 * - `archive` is `instruction resolve … --state withdrawn` — the panel's word for a move the account
 *   itself has no verb for (the entry stays on the record and stops being read);
 * - `revive` and `delete` are the account's own two lines.
 *
 * The scope list is this side's copy of the record vocabulary: the panel picks one of three words and
 * the write path forwards it verbatim, so a scope word that reaches a record is the word the user
 * chose, never a pre-judged one. The plugin's `--scope` choices are the authority — the vocabulary is
 * frozen with the record (`types.ts`) — and this list is kept in step with it by the test that runs
 * each of these words through the plugin's own command surface (`tests/host-instruction-lines.test.mjs`).
 */

/** The scopes an entry can bind to, in the order the command surface lists them. */
export const INSTRUCTION_SCOPES = ['global', 'cycle', 'node'] as const

/** One of the scopes above. */
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number]

/** Why one composed line could not be built: the codes the panel reports for this call. */
export type InstructionLineRefusalCode = 'scope-unknown' | 'empty-text'

/** One composed line: the argv to answer with, or why the call cannot be spelled at all. */
export type InstructionLine =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly code: InstructionLineRefusalCode; readonly detail: string }

/** What one `instruction add` needs: the sentence, the scope it binds to, and the scope's binding. */
export interface InstructionAddLineInput {
  /** The user's verbatim sentence: any sentence, and exactly one argv cell. */
  readonly text: string
  /** The scope the sentence is visible from. */
  readonly scope: string
  /** Which cycle to bind, when the scope is `cycle`. */
  readonly cycle?: string | undefined
  /** Which node to bind, when the scope is `node`. */
  readonly node?: string | undefined
}

/**
 * The `instruction add` line for one sentence.
 *
 * `--text` goes last, with the sentence as the one cell after it — every switch comes before it, so a
 * sentence that starts with a dash is still a sentence (the plugin's parser takes the cell after a
 * value-taking flag as that flag's value, dash and all).
 */
export function instructionAddLine(input: InstructionAddLineInput): InstructionLine {
  const scope = INSTRUCTION_SCOPES.find((word) => word === input.scope)
  if (scope === undefined) {
    return { ok: false, code: 'scope-unknown', detail: String(input.scope) }
  }
  const text = typeof input.text === 'string' ? input.text : ''
  if (text.trim().length === 0) return { ok: false, code: 'empty-text', detail: '' }
  const argv: string[] = ['instruction', 'add', '--scope', scope]
  if (scope === 'cycle' && typeof input.cycle === 'string' && input.cycle.length > 0) {
    argv.push('--cycle', input.cycle)
  }
  if (scope === 'node' && typeof input.node === 'string' && input.node.length > 0) {
    argv.push('--node', input.node)
  }
  argv.push('--text', text)
  return { ok: true, argv }
}

/** The line one entry is archived with: the record stays, it is merely no longer read. */
export function instructionArchiveLine(id: string): readonly string[] {
  return ['instruction', 'resolve', id, '--state', 'withdrawn']
}

/** The line one archived entry is put back with. */
export function instructionReviveLine(id: string): readonly string[] {
  return ['instruction', 'revive', id]
}

/** The line one entry is removed with — the sentence goes with it, and nothing takes it back. */
export function instructionRemoveLine(id: string): readonly string[] {
  return ['instruction', 'rm', id]
}