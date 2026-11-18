/**
 * The overview's standing corner: two doors and their fold, on the pane's bottom-right edge, in
 * every state the stage can be in.
 *
 * The corner is deliberately the panel's dumbest control. Each door opens one session whose first
 * word is the bare skill invocation — the graph's (`/sw-route`) or the line's (`/sw-conduct`) — and
 * every question a setup or a start could ask (whether the graph needs drawing at all, which line
 * to drive) is that skill's own opening conversation, never a reading made here. A superworker may
 * run a second line while one runs, so no state of the record decides whether opening is allowed;
 * the one fact this corner reads is whether the record still holds a node that could ever be
 * worked, and that only greys the line's door: with nothing to work, a session that drives lines
 * has nothing to drive.
 *
 * Collapsed it is one quiet disc, so an empty stage keeps its emptiness; a press stands the two
 * doors up over it, and a press anywhere else folds them back. Each door wears the invocation it
 * will open its session with — the slash, the skill, in the command face — so what a press starts
 * is read before the press, not after it. Both roads are presses, never a
 * hover — the reader is on a touch screen half the time, and a control that opens on hover has no
 * road there.
 */
import * as React from 'react'
import { useT } from './locale.ts'

export function OverviewLaunch(props: {
  /** Whether the record still holds a node that could be worked: the line door's own light. */
  readonly runnable: boolean
  /** Whether a door's call is in flight: both doors and the fold stand down while it is. */
  readonly busy: boolean
  readonly onRoute: () => void
  readonly onConduct: () => void
}): React.ReactElement {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const root = React.useRef<HTMLDivElement | null>(null)
  /* A press anywhere outside the corner folds it back. The listener lives only while the doors
   * stand, so a closed corner costs nothing and a press inside it never folds it. */
  React.useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return (
    <div ref={root} className={`superworker-ofab${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="superworker-ofab-door is-route"
        aria-label={t('overview.launch.route')}
        disabled={props.busy}
        onClick={() => { setOpen(false); props.onRoute() }}
      >
        {/* The graph's glyph: one node handed down to two — the drawing the map's own rail says. */}
        <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true">
          <path d="M6 3.6 3.4 8.7M6 3.6l2.6 5.1" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="6" cy="2.7" r="1.3" fill="currentColor" />
          <circle cx="2.9" cy="9.2" r="1.3" fill="currentColor" />
          <circle cx="9.1" cy="9.2" r="1.3" fill="currentColor" />
        </svg>
        {/* The door wears the invocation it will open the session with, slash and all, in the code
         * face every command on this panel wears — the same word, the same spelling, the reader
         * would type. It is the host half's own first sentence for this door, shown before the
         * press instead of after it. */}
        <span className="superworker-ofab-word">{'/sw-route'}</span>
      </button>
      <button
        type="button"
        className="superworker-ofab-door is-conduct"
        aria-label={t('overview.launch.conduct')}
        disabled={props.busy || !props.runnable}
        onClick={() => { setOpen(false); props.onConduct() }}
      >
        {/* The line's glyph: the same play a reader reads as "this runs". */}
        <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true">
          <path d="M4.2 2.9v6.2l5-3.1z" fill="currentColor" />
        </svg>
        <span className="superworker-ofab-word">{'/sw-conduct'}</span>
      </button>
      <button
        type="button"
        className="superworker-ofab-pin"
        aria-label={t('overview.launch.pin')}
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true">
          <path d="M6 3.1v5.8M3.1 6h5.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
