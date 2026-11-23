/**
 * The stage's own switch: the feed whole, or one line per step — 完整 / 简洁, on the pane's top-right
 * corner.
 *
 * It is the node page's segmented control in the same seat the standing corner takes, because it is
 * the same kind of fact: one reading, two drawings, and which one stands in front is where the
 * reader was. So it lives on the pane and nowhere else — the settings page gets no row for it, the
 * same way it has none for the tab or for the node page's own two drawings. A row there would be
 * overwritten by the next press anyway.
 *
 * It answers one question and nothing else: how much of a step the feed draws. Which drawing is in
 * front is not a fact about the conversation, so the switch says nothing about the reading and the
 * reading knows nothing about it — the pane picks the list it draws, and the model's rows are the
 * same rows either way.
 *
 * The corner is the pane's, not the field's: the field is the windows' painting layer and takes no
 * pointer at all, so a control inside it would be a picture of a switch.
 */
import * as React from 'react'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { OVERVIEW_MODES, type OverviewMode } from './prefs.ts'

/** What each drawing is called, as a key rather than as a word: the control says it when it draws. */
const DRAW_WORDS: Readonly<Record<OverviewMode, WordKey>> = {
  full: 'overview.draw.full',
  brief: 'overview.draw.brief',
}

export function OverviewModeControl(props: {
  /** Which drawing stands in front. */
  readonly mode: OverviewMode
  /** Where a pick goes: the panel owns it and writes it back to the settings document. */
  readonly onMode: (mode: OverviewMode) => void
}): React.ReactElement {
  const t = useT()
  return (
    <div className="superworker-omode">
      {/* One of the two is in play, both are named — the same control, in the same words, that the
          node page's band already stands. */}
      <div className="superworker-seg" role="group" aria-label={t('overview.draw.aria')}>
        {OVERVIEW_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="superworker-segbtn"
            id={`overview-draw-${mode}`}
            aria-pressed={props.mode === mode}
            onClick={() => props.onMode(mode)}
          >
            {t(DRAW_WORDS[mode])}
          </button>
        ))}
      </div>
    </div>
  )
}
