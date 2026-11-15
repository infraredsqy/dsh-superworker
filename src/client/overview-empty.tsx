/**
 * The overview's empty stage: one sentence and one action, centred in the pane.
 *
 * The record is here and yet no window can be drawn — no node at all, no session it ever named, or
 * none of the sessions it named that this machine still holds. The law forbids standing a window in
 * for one the record never mentioned, so the stage says which situation it is and offers the one
 * move that changes it: an agent reads this workspace and draws its first node. The sentence and
 * the action's word arrive already said (`words.ts` spells them from the panel's judgment); this
 * component only draws them and hands the move to the host, which opens the session.
 *
 * The action stands disabled while that call is in flight and comes back after, either way — a
 * landed call opens a session in DSH, which is the whole effect, and a refused one lands on the
 * panel's note line. The button is the panel's own secondary action (`superworker-btn`): the same
 * object the legacy notice's migration hand wears, because two spellings of one button is where
 * copies start drifting apart.
 */
import * as React from 'react'
import type { OverviewEmptyWords } from './words.ts'

export function OverviewEmptyStage(props: {
  /** The two pieces, spelled by `words.ts` in the reader's language. */
  readonly words: OverviewEmptyWords
  /** Whether the consult call is in flight: the action stands down until it settles. */
  readonly busy: boolean
  readonly onConsult: () => void
}): React.ReactElement {
  return (
    <div className="superworker-oempty">
      <p>{props.words.said}</p>
      <button type="button" className="superworker-btn" disabled={props.busy} onClick={props.onConsult}>
        {props.words.link}
      </button>
    </div>
  )
}
