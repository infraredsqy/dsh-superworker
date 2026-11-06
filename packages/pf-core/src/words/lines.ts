/**
 * The lines a caller spells at the panel's edge, built by the engine that owns their vocabulary.
 *
 * Two facts live here, and nowhere else:
 *
 * - **The instruction scopes.** The command table states them as `--scope` choices, the parser refuses
 *   anything outside them, and a caller that pre-checks its own copy refuses what the engine would
 *   have accepted the day a fourth scope lands. So the list is exported and the table reads it; a
 *   caller forwards the word and lets the engine answer.
 * - **Panel words that name an engine call.** Archiving is not a verb of its own: it is
 *   `instruction resolve --state withdrawn`. That translation is a fact about the engine's surface,
 *   not about the panel's edge, so it is built here rather than spelled at the boundary.
 *
 * A built line is handed to the words layer's own `answer()`, which is what writes the record.
 */
import type { InstructionScope } from '../types';

/** The scopes an instruction can bind to, in the order the command table lists them. */
export const INSTRUCTION_SCOPES: readonly InstructionScope[] = ['global', 'cycle', 'node'];

/** Why one composed instruction line could not be built: the codes the words layer's own vocabulary uses. */
export type InstructionLineRefusalCode = 'scope-unknown' | 'empty-text';

/** One composed line: the argv to answer with, or why the call cannot be spelled at all. */
export type InstructionLine =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly code: InstructionLineRefusalCode; readonly detail: string };

/** What one `instruction add` needs: the sentence, the scope it binds to, and the scope's binding. */
export interface InstructionAddLineInput {
  /** The user's verbatim sentence: any sentence, and exactly one argv cell. */
  readonly text: string;
  /** The scope the sentence is visible from. */
  readonly scope: string;
  /** Which cycle to bind, when the scope is `cycle`. */
  readonly cycle?: string | undefined;
  /** Which node to bind, when the scope is `node`. */
  readonly node?: string | undefined;
}

/**
 * The `instruction add` line for one sentence.
 *
 * The scope is checked against the engine's own list, and an empty sentence is refused here: both are
 * facts about this call, and a caller that answered `scope-unknown` from a second copy of the list
 * would be a boundary refusing what the engine owns. `--text` goes last, with the sentence as the one
 * cell after it — every switch comes before it, so a sentence that starts with a dash is still a
 * sentence.
 */
export function instructionAddLine(input: InstructionAddLineInput): InstructionLine {
  const scope = INSTRUCTION_SCOPES.find((word) => word === input.scope);
  if (scope === undefined) {
    return { ok: false, code: 'scope-unknown', detail: String(input.scope) };
  }
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.trim().length === 0) return { ok: false, code: 'empty-text', detail: '' };
  const argv: string[] = ['instruction', 'add', '--scope', scope];
  if (scope === 'cycle' && typeof input.cycle === 'string' && input.cycle.length > 0) {
    argv.push('--cycle', input.cycle);
  }
  if (scope === 'node' && typeof input.node === 'string' && input.node.length > 0) {
    argv.push('--node', input.node);
  }
  argv.push('--text', text);
  return { ok: true, argv };
}

/**
 * The line one instruction is archived with: the record stays, it is merely no longer read, which is
 * what `resolve --state withdrawn` says. The panel calls this "archive"; the engine has no such verb.
 */
export function instructionArchiveLine(id: string): readonly string[] {
  return ['instruction', 'resolve', id, '--state', 'withdrawn'];
}

/** The line one archived instruction is put back with. */
export function instructionReviveLine(id: string): readonly string[] {
  return ['instruction', 'revive', id];
}

/** The line one instruction is removed with — the sentence goes with it, and nothing takes it back. */
export function instructionRemoveLine(id: string): readonly string[] {
  return ['instruction', 'rm', id];
}
