/**
 * The overview's empty stage: one sentence, centred in the pane, and nothing else.
 *
 * The record is here and yet no window can be drawn — no node at all, no session it ever named, or
 * none of the sessions it named that this machine still holds. The law forbids standing a window in
 * for one the record never mentioned, so the stage says which situation it is. It carries no action:
 * the move that changes any of these states is the corner's standing doors, which are on the pane in
 * every state, so an action here would be the same object said twice. The sentence arrives already
 * said (`words.ts` spells it from the panel's judgment); this component only draws it.
 */
import * as React from 'react'

export function OverviewEmptyStage(props: {
  /** The one sentence, spelled by `words.ts` in the reader's language. */
  readonly said: string
}): React.ReactElement {
  return (
    <div className="superworker-oempty">
      <p>{props.said}</p>
    </div>
  )
}
