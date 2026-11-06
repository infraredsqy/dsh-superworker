/**
 * What one write leaves behind, stated once: the note line's two kinds, the reading of a write's
 * answer, and the loop that puts that answer on the note line.
 *
 * The panel and the settings page both write through the tool and both say what came back on the
 * same line under the panel: the tool's own words carried out verbatim when it succeeded, a refusal
 * spelled by the shell when it did not (the code is all this layer can hand over — which language
 * the reader looks at is not known here). Two panes spelling that twice is what lets one of them
 * start saying it differently.
 */
import type { Failure, Outcome } from './failure.ts'
import { failureOf } from './failure.ts'

/**
 * What the one note line under the panel says.
 *
 * Two different things land there and they are not the same kind of text: the tool's own words,
 * carried out verbatim when it spoke while succeeding, and why an operation was refused, which is a
 * code this panel spells. Kept apart rather than flattened into one string, because only the second
 * is ours to translate.
 */
export type Note =
  | { readonly kind: 'said'; readonly text: string }
  | { readonly kind: 'failure'; readonly failure: Failure }

/**
 * The note a write's answer leaves: the tool's own words when it spoke, nothing when it succeeded
 * silently, or the refusal's code.
 */
export function noteOf(outcome: Outcome): Note | null {
  if (outcome.ok) return outcome.text.length > 0 ? { kind: 'said', text: outcome.text } : null
  return {
    kind: 'failure',
    failure: { code: outcome.code, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) },
  }
}

/** The note a rejected call leaves: this side's own refusal code, with what was thrown as its detail. */
export function failureNote(error: unknown): Note {
  return { kind: 'failure', failure: failureOf(error) }
}

/**
 * How far one reading has got: the three phases a pane's own read passes through.
 *
 * A pane with its own "nothing to read" phase (the shell's "no session picked") widens this rather
 * than writing a second union of the same three arms.
 */
export type Load<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ok'; readonly reading: T }
  | { readonly phase: 'failed'; readonly failure: Failure }

/**
 * The write → note line → read-again loop: run the write, put what came back on the note line, and
 * hand the caller's own follow-up the landing.
 *
 * `after` is where a pane puts what is its own: the shell re-reads the record only when the write
 * landed, the settings page re-reads either way (a refusal is a reading of the tool's opinion, and
 * the controls must show it). The returned promise is the landing itself, for the one row that only
 * clears its box when the sentence was recorded.
 */
export function writeToNote(
  run: () => Promise<Outcome>,
  hands: {
    readonly note: (note: Note | null) => void
    readonly after?: (landed: boolean) => void
  },
): Promise<boolean> {
  return run().then(
    (outcome) => {
      hands.note(noteOf(outcome))
      hands.after?.(outcome.ok)
      return outcome.ok
    },
    (error: unknown) => {
      hands.note(failureNote(error))
      hands.after?.(false)
      return false
    },
  )
}
