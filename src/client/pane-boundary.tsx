/**
 * The pane-level crash guard: a React error boundary wrapped around every pane's body, so one pane
 * that cannot be drawn says so in its own place instead of taking the whole workshop cell down.
 *
 * Why this stands here: DSH wraps each slot entry in its own error boundary, and when that one
 * catches, it retires the entry — the whole center cell goes dark, the sidebar row stays, and only
 * a page reload brings the workshop back. The overview's measure loop once crashed exactly into
 * that boundary (React #185, thrown on switching to 当前), and the whole panel was the blast
 * radius. This guard stands inside DSH's, around each pane: a pane that fails collapses to one
 * sentence, and the header, the tab row and the other panes live on.
 *
 * The retry is the reader's own move, not a timer: leaving the pane and coming back re-arms it
 * (`active` falling to rising again). An automatic retry on every parent render would re-run a
 * deterministic crash once per frame for nothing; with the edge, a crash that always happens
 * crashes once per visit and says so, and a one-off crash heals on the way back.
 *
 * The catch must be loud: `componentDidCatch` prints to the console, because a quiet boundary
 * hides the very bug it caught. The test shell treats every `console.error` as a failure, so a
 * crash under test is loud there too. The sentence it draws is handed in already translated
 * (`said`, from `panel.crashed` — the reader's own approved wording), so a case can press this
 * guard with any sentence and the wording stays out of the unit's hands.
 *
 * A class component by necessity: only a class carries `getDerivedStateFromError` and
 * `componentDidCatch`. It is the one class in this browser half; everything else stays functions.
 * A crash above the panes — the shell, the header, the note line — is not this guard's to hold;
 * there DSH's own boundary still answers.
 */
import * as React from 'react'

/** The guard's own state: whether what it stands over failed to draw. */
interface PaneCrashState {
  readonly crashed: boolean
}

export class PaneBoundary extends React.Component<{
  /** Which pane this guard stands in, for the console line only (`overview`, `nodes`, …). */
  readonly pane: string
  /** Whether the pane is the shown one; the falling-to-rising edge is the re-arm. */
  readonly active: boolean
  /** The sentence to draw in the pane's place, already in the reader's language. */
  readonly said: string
  readonly children?: React.ReactNode
}, PaneCrashState> {
  override state: PaneCrashState = { crashed: false }

  /* Turn the failure into state, so the next render draws the sentence instead of the body. */
  static getDerivedStateFromError(): PaneCrashState {
    return { crashed: true }
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error)
    // eslint-disable-next-line no-console -- a caught crash must leave a traceable record
    console.error(`dsh-superworker: the pane ${this.props.pane} did not draw：${message}`, info.componentStack ?? '')
  }

  override componentDidUpdate(previous: { readonly active: boolean }): void {
    /* The re-arm: the reader left the broken pane and came back. A crash that still happens
     * crashes again on this very render and the sentence returns at once; a one-off crash heals. */
    if (this.state.crashed && !previous.active && this.props.active) this.setState({ crashed: false })
  }

  override render(): React.ReactNode {
    if (this.state.crashed) {
      /* The same ground and voice as the panel's nothing-to-draw sentence: one line, pinned to the
       * middle of the area, saying what this place is rather than drawing an invented pane. */
      return <div className="superworker-none"><p>{this.props.said}</p></div>
    }
    return this.props.children
  }
}
