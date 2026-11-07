/**
 * The panel's legacy-directory notice: the card that replaces the whole content area when the
 * workspace still holds only the previous record directory.
 *
 * Nothing was read in that state, and the law "draw nothing that is not there" forbids a row of
 * empty tabs over five empty panes — so no map, node, or line is drawn at all, and this card is
 * the content area: what happened, why nothing is here, and the one way forward. The words arrive
 * already said (`words.ts` spells them from the reading); this component only draws them and
 * carries the one move, handing the migration to an agent through the host. The action stands
 * disabled while that call is in flight and comes back after, either way — a landed call opens a
 * session in DSH, which is the whole effect, and a refused one lands on the panel's note line.
 */
import * as React from 'react'
import type { LegacyNoticeWords } from './words.ts'

export function LegacyNotice(props: {
  /** The three words, spelled by `words.ts` in the reader's language. */
  readonly notice: LegacyNoticeWords
  /** Whether the consult call is in flight: the action stands down until it settles. */
  readonly busy: boolean
  readonly onConsult: () => void
}): React.ReactElement {
  return (
    <div className="superworker-legacy">
      <div className="superworker-legacy-card">
        <h2 className="superworker-legacy-title">{props.notice.title}</h2>
        <p className="superworker-legacy-body">{props.notice.body}</p>
        {/* The panel's own secondary action (`superworker-btn`), not a new object: the migration
            hand is one more button on this panel, and a second spelling of one button is where
            copies start drifting apart. */}
        <button type="button" className="superworker-btn" disabled={props.busy} onClick={props.onConsult}>
          {props.notice.link}
        </button>
      </div>
    </div>
  )
}
