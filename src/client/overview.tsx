/**
 * The overview's windows: the reading of this moment, drawn.
 *
 * What comes in is the reading (`OverviewReading`) and the fetch beat's moment — nothing is
 * fetched here and no reading is judged again; the pane measures its own stage, lays the windows
 * out with `overview-geom`, and draws. Each motion is bound to exactly one fact, and the facts are
 * diffed between consecutive readings, never invented:
 *
 * - leave — the set lost one; the pane folds as it lingers — the rows up into the title line, then
 *   the sliver away sideways — and when the span has run, the page loses it. A child that ended
 *   leaves this way: the reading stops drawing it the moment its session stops running, so it is
 *   never kept as a finished window;
 * - fresh row — one window's newest row is not the row it was (growth, or the cut that replaced
 *   the top row when the newest arrived);
 * - enter — a child joined the set: it grows out of the dispatch row that opened it, from that row's
 *   own leaving point, so the window is seen coming from where it actually came from. The main
 *   window has no source to come from — it is the conversation this pane is about, so it was
 *   already here — and only fades in;
 * - breathing border — the main window's node stands at a person's gate: it is waiting for the reader
 *   to say yes. It loops by itself; being seen is its whole job.
 *
 * A wholesale replacement is not a set that lost a window: when the main window is a different
 * conversation, the old panes are not held for a fold, they are gone, and the new cast is simply
 * here — nothing of another cast arrives.
 *
 * A window's state is one drawing per fact, and the person's gate stands first. At a gate
 * (`waiting` — a checkpoint or a manual node; the drawing never asks which, and nothing here keys a
 * state to one of those two modes) it wears the amber breathing border and nothing else: no veil, no
 * mark. Otherwise the frame follows the record's own verdict, never the quiet: the check belongs to
 * `delivered`, and `alert` — work owed, nobody doing it, and the conversation not ended by itself —
 * is the frame itself, in the break's ink. A border is read before any glyph, so the frame is the
 * state's own drawing on a child as much as on the window this panel lives in: the debt is the same
 * debt whoever left it, and the one red frame says it. A conversation that merely went quiet, with
 * no verdict on the record, changes nothing about its frame.
 *
 * What the frame leaves out is *why*, and that is one line's work: a glyph and a short word, centred
 * on the band's middle, saying how the conversation's last turn ended in a few syllables — the same
 * middle the check takes, so a verdict is always found in one place. The word says only that much;
 * the conversation behind the press carries the detail, which is why no hover and no caption repeats
 * it.
 *
 * The veil is what a stopped conversation wears: its rows stay where they stand, said dimmer. It
 * answers one fact and only one — the conversation is no longer the live subject — so a window that
 * stopped owing work is veiled exactly like one that stopped delivered or one waiting at a person's
 * gate, and the frame's own ink is what tells those apart: the check for work handed in, the red
 * frame and its one word for a break, the amber breath for a gate. A running window is the only one
 * whose rows stay sharp, because there they are the reading itself.
 *
 * A notice drawn over a feed — the fault line a break carries — stands on a band of the window's own
 * ground. That is the rule for anything this drawing centres over rows: the rows are context, and a
 * word laid straight over passing text is read against whatever happens to sit under it.
 *
 * The check and the veil are the main window's alone — a child that finished is no longer a window
 * at all.
 *
 * A running child turns the small ring in its cell, half the border's pace — that is the whole of
 * what "still moving" says. Neither the ring nor any other fact reaches for the border: the amber
 * breath belongs to the gate and the red frame to a break, so a window that sent work out and is
 * waiting for it back says nothing but its ring.
 *
 * A window answers a press with the conversation it stands for — the move the map's cards already
 * make — and its whole face is the target, because a finger has nowhere small to land. Whether a
 * window may be pressed at all is the panel's admission (`WindowGo`): a conversation this machine
 * cannot open keeps the drawing and nothing else, so no press can ever go nowhere.
 *
 * A window's id is wiring, not words: it rides a `data-window` attribute and never prints.
 */
import * as React from 'react'
import type { OverviewEnding, OverviewReading, OverviewRowKind, OverviewWindow } from '../model/index.ts'
import {
  CHILD_FOOT,
  CHILD_HEAD,
  BOX_BORDER,
  FAULT_MARK,
  FEED_LEFT,
  FEED_RIGHT,
  HEAD_RIGHT,
  LINK_DOT_R,
  MAIN_FOOT,
  MAIN_HEAD,
  MARK_CHECK,
  MARK_CHECK_STROKE,
  MARK_SCRIM,
  RAIL_LEFT,
  RING_SIZE,
  ROW_H,
  SPILL_DOTS,
  layoutFault,
  layoutBirth,
  layoutLink,
  layoutMark,
  layoutOverview,
  layoutRing,
  layoutSpill,
  railBarWidth,
  type OverviewBox,
  type OverviewLink,
  type StageSize,
} from './overview-geom.ts'
import { useT, type Translate } from './locale.ts'
import { elapsedOf } from './words.ts'
import type { WordKey } from './locales/index.ts'

/** How long the leave's fold runs, and a breath past it before the page loses the pane. The fold
 * itself lives in the sheet. */
const LEAVE_SPAN_MS = 380

/** How long the survivors take to reach the numbers the folded window freed. A fold says one window
 * left the set; the room closing up is that same fact seen in the rest of the stage, so it is spent
 * rather than snapped — but only here, on a leave's own account, never on a re-measure. */
const SETTLE_SPAN_MS = 200

/** How long the entrance runs. The mark is held for exactly this span: an entrance is a beat, and a
 * window that kept the mark would replay its growth every time anything else redrew the stage. */
const ENTER_SPAN_MS = 260

/** How long a window's first box is allowed to take in reaching its real numbers — the span the
 *  sheet's expansion runs, and a breath past it so a second batch of rows joins the same growth. */
/** How long the opening's growth is spent for: a breath past the sheet's own expansion, so a second
 *  batch of rows landing right behind the first belongs to the same growth rather than snapping. */
const GROW_SPAN_MS = 360

/** How long a window may stand in its provisional box at the longest. A window that never reads a row
 *  is written off after this: what the opening waits for is the panel's own read of the sessions, and
 *  that is over by now — a re-measure after it must never be spent. */
const OPENING_MAX_MS = 3000

/**
 * What one press on a window may do: the map's own two hands (`CardGo`), asked of a session instead
 * of a node — a window *is* a conversation, and whether this machine can open it is the panel's
 * reading (`panel.tsx`), never this drawing's.
 */
export interface WindowGo {
  /** Where the window's conversation goes, or null when this machine cannot open it: a window that stays a drawing. */
  targetOf(session: string): string | null
  open(target: string): void
}

/** What each row kind says. */
const ROW_WORDS: Readonly<Record<OverviewRowKind, WordKey>> = {
  think: 'overview.row.think',
  read: 'overview.row.read',
  write: 'overview.row.write',
  run: 'overview.row.run',
  output: 'overview.row.output',
  dispatch: 'overview.row.dispatch',
  fail: 'overview.row.fail',
  tool: 'overview.row.tool',
}

/** What a node's weight reads as; absent without a node, and then nothing is said. */
const WEIGHT_WORDS: Readonly<Record<'light' | 'standard', WordKey>> = {
  light: 'overview.weight.light',
  standard: 'overview.weight.standard',
}

/** What a node's mode reads as; the two person-waiting modes are the gate words, said the same way on every view. */
function modeWordOf(mode: string): WordKey {
  if (mode === 'checkpoint') return 'gate.checkpoint'
  if (mode === 'manual') return 'gate.manual'
  return 'overview.mode.auto'
}

/** The window's `weight · mode` line, when the record names a node; a window that works no node carries no readings. */
function readingsOf(t: Translate, window: OverviewWindow): string | null {
  if (window.weight === null || window.mode === null) return null
  const line = `${t(WEIGHT_WORDS[window.weight])} · ${t(modeWordOf(window.mode))}`
  /* A cell put out to wait is a person being owed, and its mode does not say so — a shelved `auto` cell
     still reads 自动. The gate's word rides this caption line, which is where the other two gates
     already say themselves through their mode; there is one word for it, and it is the state's own. */
  const gated = window.waiting === true && window.mode !== 'manual' && window.mode !== 'checkpoint'
  return gated ? `${line} · ${t('state.shelved')}` : line
}

/**
 * The one short word a broken window's fault line says: how the conversation's last turn ended, in
 * the fewest syllables the reader can still tell apart.
 *
 * The kind and the cause are DSH's own strings (`OverviewEnding`), carried off `turn/end` verbatim,
 * so this is a reading of exact words and never a guess. A turn the conversation closed itself never
 * reaches this table — that is no fault — and an ending the table has never seen, or a log that
 * carries none at all, reads as the one word for an end without account. The line says only this
 * much: the conversation behind the press carries the detail.
 */
function faultWordOf(ending: OverviewEnding | undefined): WordKey {
  if (ending?.kind === 'aborted') {
    if (ending.cause === 'user') return 'overview.fault.user'
    if (ending.cause === 'disposed') return 'overview.fault.disposed'
    return 'overview.fault.other'
  }
  if (ending?.kind === 'interrupted') return 'overview.fault.interrupted'
  if (ending?.kind === 'error') return 'overview.fault.error'
  return 'overview.fault.other'
}

/** The row's own mark, one small drawing per kind, the way the state marks are drawn. */
function KindMark(props: { readonly kind: OverviewRowKind }): React.ReactElement {
  switch (props.kind) {
    case 'think':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1" />
          <circle cx="6" cy="6" r="1" fill="currentColor" />
        </svg>
      )
    case 'read':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.4 4.4h7.2M2.4 7.6h4.8" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      )
    case 'write':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <rect x="2.6" y="2.6" width="6.8" height="6.8" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M5.2 6.8 9.8 2.2" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      )
    case 'run':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M3.2 3.6 6 6 3.2 8.4" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7.6 8.4h2" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      )
    case 'output':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.6 7v2.4h6.8V7" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 2.4v3.8M4.4 4.6 6 6.2l1.6-1.6" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'dispatch':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M4.3 6 8 3.4M4.3 6 8 8.6" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <circle cx="3" cy="6" r="1.3" fill="currentColor" />
          <circle cx="9.2" cy="3.4" r="1.3" fill="currentColor" />
          <circle cx="9.2" cy="8.6" r="1.3" fill="currentColor" />
        </svg>
      )
    case 'fail':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M6 3.8v2.8" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <circle cx="6" cy="8.2" r="0.9" fill="currentColor" />
        </svg>
      )
    case 'tool':
      return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M6 2.2 9.8 6 6 9.8 2.2 6Z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        </svg>
      )
  }
}

/**
 * The check the main window's record verdict wears: the panel's own drawing for work handed in, in
 * the same 12-unit box every other mark is drawn in; the size and the pen that land on screen are
 * `overview-geom.ts`'s. It is the only mark a window carries — a break's drawing is the fault line,
 * and that has a glyph of its own.
 */
function FinishedMark(props: { readonly stroke: number }): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2.5 6.5l2.4 2.4 4.6-5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth={props.stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The mark a window held at a person's gate wears: the panel's own drawing for "a word is owed", the
 * very one the map's cards and the detail rows stand up, drawn in the check's square. Two bars and
 * not a circle — the turning ring already means "still moving", and the two marks are read at a
 * glance from across the stage, so they may never be told apart by ink alone.
 */
function GatedMark(props: { readonly stroke: number }): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M4.6 2.6v6.8M7.4 2.6v6.8"
        fill="none"
        stroke="currentColor"
        strokeWidth={props.stroke}
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The fault line's glyph: the panel's own failed drawing, the same one a failed row wears — a
 * reader who has met it in a feed meets it again here with the same meaning. Its size is the
 * geometry's (`FAULT_MARK`), and the line it stands in is the geometry's too.
 */
function FaultMark(): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" width={FAULT_MARK} height={FAULT_MARK} aria-hidden="true">
      <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M6 3.8v2.8" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <circle cx="6" cy="8.2" r="0.9" fill="currentColor" />
    </svg>
  )
}

/** One window's feed: the rows it holds, newest at the bottom, the top fading when the room ran out.
 * A live row is the streaming step's own tail: it redraws at the animation frame, and its clip is
 * the sheet's head-crop — the newest words stay on the line's end, while the row's word stays whole
 * outside that clip: which buffer is speaking is not a thing the crop is allowed to eat. */
function Feed(props: {
  readonly window: OverviewWindow
  /** How many rows the box has room for; past it the top row fades out. */
  readonly room: number
  /** Whether this window's newest row arrived on this beat. */
  readonly fresh: boolean
  /** Whether the conversation is over and its frame says nothing: the rows stay where they stand, said dimmer. */
  readonly veiled: boolean
  readonly head: number
  readonly foot: number
}): React.ReactElement {
  const t = useT()
  const rows = props.window.rows
  return (
    <div
      className={`superworker-ofeed${rows.length > props.room ? ' is-fade' : ''}${props.veiled ? ' is-veiled' : ''}`}
      style={{ left: FEED_LEFT, right: FEED_RIGHT, top: props.head, bottom: props.foot }}
    >
      {rows.map((row, at) => (
        /* No hover title on a row: the row is a reading and a press away from the conversation itself,
           and a tooltip full of build paths over a long thought is noise over a page read at a glance
           — the window opens the whole thing for whoever needs it. */
        <div
          key={at}
          className={`superworker-orow is-${row.kind}${row.live === true ? ' is-live' : ''}${at === rows.length - 1 && props.fresh ? ' is-fresh' : ''}`}
        >
          <KindMark kind={row.kind} />
          <span className={`superworker-orow-t${row.live === true ? ' is-live' : ''}`}>
            {row.live === true
              ? (
                <>
                  <span className="superworker-orow-w">{`${t(ROW_WORDS[row.kind])} · `}</span>
                  <span className="superworker-orow-cut">
                    <span className="superworker-orow-live">{row.text}</span>
                  </span>
                </>
              )
              : `${t(ROW_WORDS[row.kind])} · ${row.text}`}
          </span>
        </div>
      ))}
    </div>
  )
}

/** One window pane: the main window wears its nameplate outside the frame, a child keeps its title line inside. */
function WindowPane(props: {
  readonly box: OverviewBox
  readonly window: OverviewWindow
  readonly at: Date
  readonly main: boolean
  readonly leave: boolean
  readonly fresh: boolean
  /** The flight this window is flying — shift, size, and where it is aimed — or nothing when it did
   *  not just join; the start frame is read once, on the joining beat, and never re-read. */
  readonly born: { readonly dx: number; readonly dy: number; readonly s: number } | undefined
  /** Whether this window is still reaching its real box: its first box is measured over no rows, so
   *  the growth out of it is spent on the way rather than snapped. */
  readonly grow: boolean
  /** Where a press on this window goes; null when nothing on this machine may be pressed. */
  readonly go: WindowGo | null
}): React.ReactElement {
  const t = useT()
  const { box, window: pane } = props
  const readings = readingsOf(t, pane)
  const head = props.main ? MAIN_HEAD : CHILD_HEAD
  const foot = props.main ? MAIN_FOOT : CHILD_FOOT
  /* The conversation this window stands for, admitted by the panel: a window this machine cannot open
   * stays the drawing it was — no role, no tab stop, no press, no cursor. */
  const target = props.go === null ? null : props.go.targetOf(pane.id)
  const press = (): void => {
    if (target !== null) props.go?.open(target)
  }
  /* A press travels the browser's own activation road — `click`, which a mouse, a pen, a finger and a
   * keyboard all end at; `mousedown` alone would be the mouse's road only. The pane wears the button
   * role instead of being a `<button>` because it holds block content (a nameplate, a feed of rows, a
   * verdict mark) that a button may not legally contain, and its box, ink and motion are the
   * geometry's. The whole face is the target: the nameplate, the title line, the rows, and the mark
   * standing over them are all children here, so even the mark's own hover title never eats a press. */
  const pressable: React.HTMLAttributes<HTMLElement> = target === null ? {} : {
    role: 'button',
    tabIndex: 0,
    'aria-label': pane.title ?? t('overview.window.aria'),
    onClick: press,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      press()
    },
  }
  /* The states a window wears, one drawing per fact and the person's gate first. A gate — a checkpoint
   * or a manual node, the reading does not say which and this drawing never asks — is why its
   * conversation stopped, so the window breathes amber and carries no check. The rest reach both
   * windows: a leg that stopped with its work still owed is a ghost, and it is drawn broken exactly
   * like the conversation this panel lives in — the debt is the same debt whoever left it. */
  const atGate = pane.waiting === true
  /* The check is the record's delivery and nothing else. A conversation that merely went quiet has
   * not handed anything in, and earns no mark at all. */
  const handed = props.main && !atGate && pane.delivered === true
  /* The broken leg: work is owed, nobody is doing it, and the conversation did not just yield to a
   * leg of its own. It is drawn by its frame, not by a mark inside it — the whole window is the one
   * drawing, and a red border is read sooner than any glyph. */
  const broken = !atGate && !handed && pane.alert === true
  /* The veil answers one fact: this conversation has a verdict, and the verdict is what the reader
   * acts on — so its rows are context and step back. Three verdicts wear it — work handed in, a
   * break, a person's gate — and the frame's ink is what tells them apart. The veil follows the
   * verdict and never the stop alone: a window whose conversation has finished before the record has
   * spoken about it (the beat between a last turn and the settle that follows it, or a stop nothing
   * was ever written down for) has said nothing yet, and its rows are all it has to say — fading them
   * left a window that looked finished, veiled, with no mark on it at all. The gate is read off its
   * own fact rather than off `settled`, because a gate is a person being owed whether or not the
   * conversation behind it happens to be quiet. */
  const veiled = atGate || handed || broken
  /* The mark a window's cell carries: the check for work handed in, the pause for a word owed to a
   * person. Both take the band's middle, the same 44 square and the same pen, because they are one
   * verdict at two shapes — the reader who learned where the check stands finds the gate there too,
   * and the shape alone tells the two apart. A break states none: its frame is the whole drawing. */
  const mark = handed || atGate
    ? layoutMark({
      width: box.width,
      height: box.height,
      head,
      foot,
      size: MARK_CHECK,
      stroke: MARK_CHECK_STROKE,
    })
    : undefined
  /* The one line a broken window says: the fault's glyph and its short word, centred on the band's
   * middle — the same middle the check takes, so the eye that learned where a verdict lives finds
   * this one there too. The word says only how the turn ended; the conversation behind the press
   * carries the detail, which is why the line keeps it to a few syllables in every language. */
  const fault = broken
    ? layoutFault({ width: box.width, height: box.height, head, foot })
    : undefined
  /* The ring says "still moving" on both windows — the conversation this panel lives in is as much a
   * thing that runs as a leg it dispatched, and a reader who has to look for the spinner only on some
   * windows learns to stop looking. Only two windows wear none: one whose conversation stopped, and
   * one at a person's gate, where the gate's own breath is already the mark. */
  const moving = !atGate && pane.settled !== true
  const ring = !props.main && moving ? layoutRing({ width: box.width }) : undefined
  /* A window that just joined grows out of the point it came from: how far it must travel to stand
   * where the geometry puts it, and how small it starts on the way. A child grows from the dispatch
   * row that opened it; the main window and any unanchored child have no source and only fade. The
   * three numbers are read once, by the stage, on the beat the window joined — a flight already in
   * the air is not re-aimed by a re-measure under it (`flightOf`). */
  const born = props.born
  const cls = [
    'superworker-opane',
    props.main ? 'is-main' : 'is-child',
    props.leave ? 'is-leave' : '',
    born === undefined ? '' : 'is-born',
    props.grow ? 'is-grow' : '',
    atGate ? 'is-wait' : '',
    broken ? 'is-broken' : '',
    target === null ? '' : 'is-go',
  ]
    .filter((one) => one.length > 0)
    .join(' ')
  return (
    <section
      className={cls}
      data-window={pane.id}
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        /* The fold's own numbers, read by the sheet's keyframes from wherever the pane stands: the
         * box it holds now, and the title line it folds down to when it goes. The keyframes are the
         * one place a pane's box may be animated — inline styles cannot be keyframed to, so the box
         * hands its own values over as vars. An entering window hands over its own way there in the
         * same place: the shift from its source point, and the size it starts at. */
        '--superworker-pane-w': `${box.width}px`,
        '--superworker-pane-h': `${box.height}px`,
        '--superworker-pane-fold': `${head + foot + BOX_BORDER}px`,
        ...(born === undefined
          ? {}
          : {
            '--superworker-born-x': `${born.dx}px`,
            '--superworker-born-y': `${born.dy}px`,
            '--superworker-born-s': `${born.s}`,
          }),
      } as React.CSSProperties}
      {...pressable}
    >
      {props.main ? (
        /* The nameplate is this window's title line, so its own right end carries the two facts a
         * child's title line carries: how long the conversation has run, and the ring while it still
         * moves. The number lives here and not on the readings line, where it would stand in the
         * left-aligned flow and be read as part of the caption. */
        <div className="superworker-oplate">
          <p className="superworker-oplate-t">
            <span className="superworker-oplate-n">{pane.title ?? ''}</span>
            <span className="superworker-ocorner">
              <span className="superworker-num">{elapsedOf(t, pane.elapsedSeconds)}</span>
            </span>
          </p>
          {readings === null ? null : (
            <p className="superworker-oplate-m">
              <span>{readings}</span>
            </p>
          )}
          {moving ? <i className="superworker-oring" aria-hidden="true" style={{ width: RING_SIZE, height: RING_SIZE }} /> : null}
        </div>
      ) : (
        <div className="superworker-ohead" style={{ right: HEAD_RIGHT }}>
          <span className="superworker-ohead-t">{pane.title ?? ''}</span>
          {readings === null ? null : <span className="superworker-ohead-r">{readings}</span>}
          <span className="superworker-num">{elapsedOf(t, pane.elapsedSeconds)}</span>
        </div>
      )}
      <Feed
        window={pane}
        room={box.rowsRoom}
        fresh={props.fresh}
        veiled={veiled}
        head={head}
        foot={foot}
      />
      {mark === undefined ? null : (
        <span
          className={`superworker-omark${handed ? '' : ' is-gate'}`}
          aria-hidden="true"
          style={{
            left: mark.left,
            top: mark.top,
            width: mark.size,
            height: mark.size,
            '--superworker-seal-scrim': `${MARK_SCRIM}px`,
          } as React.CSSProperties}
        >
          {handed ? <FinishedMark stroke={mark.stroke} /> : <GatedMark stroke={mark.stroke} />}
        </span>
      )}
      {fault === undefined ? null : (
        /* The one line a broken window says: the glyph, the short word, nothing else. The outer box
         * is the geometry's — the band's whole width, so the line centres where the check does — and
         * the inner one is the notice itself: it carries the ground, so the word never stands on the
         * rows passing behind it. */
        <span
          className="superworker-ofault"
          style={{ left: fault.left, top: fault.top, width: fault.width, height: fault.height }}
        >
          <span className="superworker-ofault-n">
            <FaultMark />
            <span>{t(faultWordOf(pane.ending))}</span>
          </span>
        </span>
      )}
      {ring === undefined ? null : (
        <i
          className="superworker-oring"
          aria-hidden="true"
          style={{ left: ring.left, top: ring.top, width: ring.size, height: ring.size }}
        />
      )}
    </section>
  )
}

/**
 * The overview pane over the reading of one moment. The motion facts ride the beat the reading
 * changes: enter on an id the previous beat had not, leave on a vanished id (held until the leave's
 * span has run), fresh on a replaced newest row, breathing on the person gate.
 */
export function OverviewPane(props: {
  readonly reading: OverviewReading
  readonly at: Date
  /** Where a press on a window goes: the panel's admission and DSH's own navigation gateway. */
  readonly go: WindowGo | null
  /**
   * Where a press on a rail bar goes: the leg whose step the stage should draw. The panel owns that
   * pick and hands it back to the reading, so this drawing decides nothing about it — it only says
   * which bar was pressed. Absent, the rail is a drawing: its bars are marks, and no press lands.
   */
  readonly pick?: ((session: string) => void) | null
}): React.ReactElement {
  const { reading, at } = props
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const [stage, setStage] = React.useState<StageSize>({ width: 0, height: 0 })
  const measure = React.useCallback((): void => {
    const el = bodyRef.current
    if (el === null) return
    setStage((held) => {
      const width = el.clientWidth
      const height = el.clientHeight
      return held.width === width && held.height === height ? held : { width, height }
    })
  }, [])
  /* Measured on every drawing: a pane shown for the first time, or a stage that moved between
   * beats, must not keep the previous beat's boxes. The observer below covers the sizes that move
   * while nothing re-renders. */
  React.useLayoutEffect(measure)
  React.useEffect(() => {
    const el = bodyRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  const mainRows = reading.main?.rows.length ?? 0

  /* Leave: the ids that vanished keep their last box for the leave's span, then the page loses them.
   * The comparison is the previous beat's ids against this one's, held in a ref: state is what the
   * drawing reads, the ref is what the diff reads, and they are never asked to be the same thing.
   *
   * The same diff says which windows arrived, which is what an entrance is played for — and that one
   * is read during the render, not published from here (the note at `arrivedNow` says why). The
   * entrance needs no state of its own: its mark lives in `flying`, and the timer below is what takes
   * the mark away when the span has run. */
  const [leaving, setLeaving] = React.useState<ReadonlySet<string>>(new Set())
  /* The windows inside their entrance's span: the mark is held for exactly that long (the note at
   * `arrivedNow` says why the *arrival* is not read from this). */
  const [joined, setJoined] = React.useState<ReadonlySet<string>>(new Set())
  const timers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const enterTimers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const currentIds = React.useMemo(
    () => new Set([reading.main?.id, ...reading.children.map((one) => one.id)].filter((one): one is string => one !== undefined)),
    [reading],
  )

  /* The conversation this pane is about. A different one on a later beat is not a set that lost a
   * window: the whole cast is another one, every pane stands for something else now. Nothing is held
   * to fold there — a fold says "one window left this set", and no such window left; without this the
   * switch played every old pane's fold at once, which is the contraction a reader saw. */
  const mainId = reading.main?.id

  /* The windows that have already arrived on this stage. An entrance is played for a window's
   * arrival, and a window that is still standing has already arrived: a reading that drops it for a
   * beat — the session list's two projections disagreeing about a child's running bit while its
   * scope is being made, a seat falling out of the five-window cap and back — is no second arrival,
   * and playing one said the window had just come when the reader was still looking at it. The name
   * leaves this set when the window's fold has run, which is the moment the stage really lost it, and
   * is written while drawing, on the arrival itself: the drawing asks this set for the entrance's
   * first frame, so it has to be answerable before the commit. */
  const arrivedOnce = React.useRef<Set<string>>(new Set())
  const heldIds = React.useRef<ReadonlySet<string>>(currentIds)
  const heldMain = React.useRef<string | undefined>(mainId)

  /* The last box and the last reading each id drew from: what a leaving pane has to draw with. */
  const boxesRef = React.useRef<Map<string, OverviewBox>>(new Map())
  const windowsRef = React.useRef<Map<string, OverviewWindow>>(new Map())

  /* The flight each window is already flying, read once on the beat it joins and never re-read while
   * it travels.
   *
   * A flight's start frame is a difference against the box the window stands in, so re-reading it on
   * every beat re-aims a flight already in the air: the stage's own reading moves under it while it
   * plays — the child's first rows land and its box grows, the parent's feed writes the next row and
   * the anchor rises — and each of those is the geometry saying something new about where the window
   * *ends*, never about where it came from. The reader saw exactly that: a window that flew out,
   * jumped back to the row it started from, and flew out again. The source point is the joining
   * beat's reading of the line; the shift and the size are that one beat's, and the mark is dropped
   * with the join mark itself (the enter span below).
   *
   * The mark is taken on that joining beat's own drawing (`flightOf` below), which is the only
   * drawing whose box is the one the window arrives at. Taken a beat later, the window already
   * stands where it belongs and the shift reads as nothing: the entrance played with a zero
   * translate, which is a window that simply appears. */
  const flying = React.useRef<Map<string, { readonly dx: number; readonly dy: number; readonly s: number }>>(new Map())

  /* The windows that left on THIS beat, read during render rather than from the leave state.
   *
   * `heldIds` is advanced inside the effect below, so at this point it still names the previous beat:
   * the difference is exactly the windows the reading just dropped. Waiting for the effect to publish
   * the same fact would give one painted frame in which the column had already re-measured without
   * the folding window — the pane would blink out, the survivors would jump, and the fold would then
   * play in a room that had already moved. Reading it here means the very first render after the
   * reading changes already holds the slot, so no such frame is ever painted. */
  /* Recomputed on every render, never memoized: `heldIds` is a ref the effect advances *after* the
   * commit, so a memoized answer would keep naming the window long after its fold had finished and
   * the cast would hold the slot forever. Reading the ref here is what makes the diff self-correcting
   * on the very next render.
   *
   * A **changed main window** is asked first: another conversation on the stage is another cast, not
   * a set that lost a window, so nothing this beat is gone — every pane of the old cast is simply
   * gone. The effect below drops the hold for the same reason, but it lands after this render, so a
   * diff that still named the old windows would paint one folded pane of the step the reader just
   * left — which is exactly the tear a switch shows as a window flying out of the stage. */
  const swappedMain = heldMain.current !== mainId
  const goneNow = swappedMain ? [] : [...heldIds.current].filter((id) => !currentIds.has(id))
  const goneKey = goneNow.join('|')
  const leavingIds = React.useMemo(
    () => {
      const out = [...leaving]
      for (const id of goneKey === '' ? [] : goneKey.split('|')) if (!out.includes(id)) out.push(id)
      return out
    },
    [leaving, goneKey],
  )

  /* The windows that arrived on THIS beat, read the same way and for the same reason — the other
   * direction of the one difference above, against the same ref.
   *
   * An entrance is a motion from a place the window does not stand in yet, so it has to be on the
   * pane in the very frame that first draws the window at the box it lands on. Publishing the
   * arrival from the effect below instead printed that frame without the mark, and the window stood
   * at its final box; the mark then arrived on the next frame, when the box was the one it had
   * already been drawn at, so the flight was aimed from the window's own box and the entrance played
   * nothing. So the beat's arrivals are read here, where `heldIds` still names the previous beat, and
   * the effect below only holds the mark for its span afterwards.
   *
   * A window already named in `arrivedOnce` is no arrival: the reading lost it for a beat and handed
   * it back, and that window has been standing the whole time. A replaced cast arrives whole in
   * nothing — another conversation's windows were here before this pane was. */
  const arrivedNow = swappedMain
    ? []
    : [...currentIds].filter((id) => !heldIds.current.has(id) && !arrivedOnce.current.has(id))

  /* The cast the column is measured over: the reading's children, plus the ones still folding, held
   * in the slot each one stood in. A fold is a window on its way out — it is still on the stage while
   * it plays, so its ground is still taken. Measuring the column without it the instant the reading
   * drops the window re-measured every survivor on the fold's own first frame: the pane shrank in a
   * room that had already moved around it, which is the tear a reader saw. */
  const castOrder = React.useRef<readonly string[]>([])
  const cast = React.useMemo((): readonly { readonly id: string; readonly rows: number }[] => {
    const live = reading.children.map((one) => ({ id: one.id, rows: one.rows.length }))
    const held = leavingIds.filter((id) => !live.some((one) => one.id === id))
    if (held.length === 0) return live
    const out: { id: string; rows: number }[] = []
    for (const id of castOrder.current) {
      const now = live.find((one) => one.id === id)
      if (now !== undefined) { out.push(now); continue }
      if (!held.includes(id)) continue
      const window = windowsRef.current.get(id)
      if (window !== undefined) out.push({ id, rows: window.rows.length })
    }
    for (const one of live) if (!out.some((kept) => kept.id === one.id)) out.push(one)
    return out
  }, [reading, leavingIds])
  /* The order the column last drew with no fold in flight: what a held window's slot is read from. */
  if (leavingIds.length === 0) castOrder.current = cast.map((one) => one.id)

  const childRows = React.useMemo(() => cast.map((one) => one.rows), [cast])
  /* The rail's own count, not the column's: the lane is kept for the line's switch, and a stage that
   * draws no child at all still keeps it while there is a second step to move to. */
  const legCount = reading.legs.length
  const placement = React.useMemo(
    () => layoutOverview({ stage, mainRows, childRows, legCount }),
    [stage, mainRows, childRows, legCount],
  )
  /* Where a window stands, by id: the cast is the column's own order, so a survivor keeps the box it
   * drew with and a folded window keeps the one it is folding in. */
  const boxOf = React.useCallback(
    (id: string): OverviewBox | undefined => {
      const index = cast.findIndex((one) => one.id === id)
      return index < 0 ? undefined : placement.children[index]
    },
    [cast, placement],
  )

  /* The windows the five-window cap folded away: counted above the column, and not drawn at all when
   * there are none, when the column did not stand, or when the stage leaves no ground above it. */
  const spill = React.useMemo(
    () => layoutSpill({ children: placement.children, hiddenChildren: reading.hiddenChildren }),
    [placement, reading.hiddenChildren],
  )
  React.useEffect(() => {
    const before = heldIds.current
    heldIds.current = currentIds
    /* A replaced set has nothing to leave: drop what was held, say nothing, and draw the new cast. */
    const swappedNow = heldMain.current !== mainId
    heldMain.current = mainId
    if (swappedNow) {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      for (const timer of enterTimers.current.values()) clearTimeout(timer)
      enterTimers.current.clear()
      arrivedOnce.current.clear()
      flying.current.clear()
      setLeaving((held) => (held.size === 0 ? held : new Set()))
      setJoined((held) => (held.size === 0 ? held : new Set()))
      return
    }
    /* The beat's arrivals — read during the render above, so the drawing that first stands these
     * windows already carries their entrance — hold their mark for the entrance's own span, then
     * shed it. Without the span the mark would be dropped on the next render: the growth would be
     * cancelled mid-frame by whatever redrew the stage, which is every pushed frame. */
    if (arrivedNow.length > 0) {
      for (const id of arrivedNow) {
        arrivedOnce.current.add(id)
        const known = enterTimers.current.get(id)
        if (known !== undefined) clearTimeout(known)
        const timer = setTimeout(() => {
          enterTimers.current.delete(id)
          flying.current.delete(id)
          setJoined((held) => {
            if (!held.has(id)) return held
            const next = new Set(held)
            next.delete(id)
            return next
          })
        }, ENTER_SPAN_MS)
        enterTimers.current.set(id, timer)
      }
      setJoined((held) => {
        const next = new Set(held)
        for (const id of arrivedNow) next.add(id)
        return next.size === held.size ? held : next
      })
    }
    /* A window back before its span ran keeps standing: its leave is cancelled, not replayed. */
    for (const id of currentIds) {
      const known = timers.current.get(id)
      if (known === undefined) continue
      clearTimeout(known)
      timers.current.delete(id)
    }
    setLeaving((held) => {
      const kept = [...held].filter((id) => !currentIds.has(id))
      return kept.length === held.size ? held : new Set(kept)
    })
    const gone = [...before].filter((id) => !currentIds.has(id))
    if (gone.length === 0) return
    /* A window on its way out keeps no join mark: it is leaving, not arriving, and a return before
     * its fold has run is the same window standing again — the mark's absence is what keeps that
     * return from playing the arrival a second time. Its opening is over too: a window that comes
     * back is read again, and its rows arrive with it. */
    for (const id of gone) {
      openings.current.delete(id)
      const openingTimer = openingTimers.current.get(id)
      if (openingTimer !== undefined) {
        clearTimeout(openingTimer.timer)
        openingTimers.current.delete(id)
      }
      const entering = enterTimers.current.get(id)
      if (entering !== undefined) {
        clearTimeout(entering)
        enterTimers.current.delete(id)
        flying.current.delete(id)
        setJoined((held) => {
          if (!held.has(id)) return held
          const next = new Set(held)
          next.delete(id)
          return next
        })
      }
    }
    for (const id of gone) {
      if (timers.current.has(id)) continue
      const timer = setTimeout(() => {
        timers.current.delete(id)
        /* The fold has run: the stage has really lost this window, so a later return is a new
         * arrival and may fly again. */
        arrivedOnce.current.delete(id)
        setLeaving((held) => {
          if (!held.has(id)) return held
          const next = new Set(held)
          next.delete(id)
          return next
        })
        /* Same batch as the removal: the render that hands out the freed boxes carries the mark. */
        setSettling(true)
        clearTimeout(settleTimer.current)
        settleTimer.current = setTimeout(() => setSettling(false), SETTLE_SPAN_MS)
      }, LEAVE_SPAN_MS)
      timers.current.set(id, timer)
    }
    setLeaving((held) => {
      const next = new Set(held)
      for (const id of gone) next.add(id)
      return next.size === held.size ? held : next
    })
  }, [currentIds, mainId])
  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      for (const timer of enterTimers.current.values()) clearTimeout(timer)
      enterTimers.current.clear()
      clearTimeout(settleTimer.current)
      for (const scheduled of openingTimers.current.values()) clearTimeout(scheduled.timer)
      openingTimers.current.clear()
    },
    [],
  )

  /* When the last fold has run, the room closes up: the survivors take the numbers the folded window
   * freed, and they spend that on the way rather than snapping to it. This is the leave's own second
   * half, not a re-measure — a stage that changed for another reason still takes its new numbers at
   * once, exactly as the sheet's own note asks.
   *
   * The mark is raised inside the leave's own timer, in the same batch as the removal, so the render
   * that hands out the new boxes is the render that carries `is-settle`. Setting it from an effect
   * instead would land one paint too late: the boxes would already have snapped by the time the
   * transition arrived, and the transition would have nothing left to spend. */
  const [settling, setSettling] = React.useState(false)
  const settleTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /* Fresh row: the newest row is not the one this window showed before, or the feed gained a
   * row (the two readings of the arrival — growth, or the cut's swap). The comparison runs in an
   * effect and lands in state, never while drawing: a host's double render (StrictMode) would run
   * the comparison twice and the second pass would find the row it recorded itself — the mark
   * would be eaten in the very beat it belongs to. The ref is the effect's own memory; state
   * commits what the beat saw. */
  const lastRowRef = React.useRef<Map<string, { full: string; len: number }>>(new Map())
  const [freshIds, setFreshIds] = React.useState<ReadonlySet<string>>(new Set())
  React.useEffect(() => {
    const fresh = new Set<string>()
    for (const one of [reading.main, ...reading.children]) {
      if (one === null) continue
      const last = one.rows[one.rows.length - 1]
      const was = lastRowRef.current.get(one.id)
      /* The arrival reads two ways: under the room cut the feed only grows, so a row gained is
       * an arrival even when its text repeats the previous newest row's; past the cut the count
       * holds and the arrival is the newest row being swapped. */
      if (was !== undefined && last !== undefined && (last.full !== was.full || one.rows.length > was.len)) fresh.add(one.id)
      if (last === undefined) lastRowRef.current.delete(one.id)
      else lastRowRef.current.set(one.id, { full: last.full, len: one.rows.length })
    }
    setFreshIds((held) => (held.size === 0 && fresh.size === 0 ? held : fresh))
  }, [reading])

  /* The box and the reading each id drew from on this beat: a leaving pane reads them back below, and
   * the cast above reads a held window's row count from `windowsRef` after the reading drops it. */
  if (reading.main !== null) {
    boxesRef.current.set(reading.main.id, placement.main)
    windowsRef.current.set(reading.main.id, reading.main)
  }
  reading.children.forEach((one, i) => {
    const box = placement.children[i]
    if (box === undefined) return
    boxesRef.current.set(one.id, box)
    windowsRef.current.set(one.id, one)
  })

  /* The ties from a dispatch row to the window it opened: one per child the field draws, paired by
   * the row's own call id — the reading hands the child that id and nothing is guessed from a
   * neighbour. A pane on its way out keeps its tie for the breath it still stands, so the line
   * leaves with the pane rather than a beat early. A child the reading cannot pair — no id, or an
   * id whose row the feed no longer shows — draws nothing. */
  const links = React.useMemo((): readonly { readonly id: string; readonly link: OverviewLink }[] => {
    const main = reading.main
    if (main === null) return []
    const out: { readonly id: string; readonly link: OverviewLink }[] = []
    const tie = (id: string, window: OverviewWindow | undefined, box: OverviewBox | undefined): void => {
      if (window === undefined || box === undefined) return
      const callId = window.dispatchCallId
      if (callId === undefined) return
      const rowIndex = main.rows.findIndex((row) => row.callId === callId)
      if (rowIndex < 0) return
      const link = layoutLink({
        main: placement.main,
        child: box,
        rowIndex,
        rowCount: main.rows.length,
        gap: box.left - (placement.main.left + placement.main.width),
      })
      if (link !== undefined) out.push({ id, link })
    }
    reading.children.forEach((child) => {
      const box = boxOf(child.id)
      if (box !== undefined) tie(child.id, child, box)
    })
    for (const id of leavingIds) {
      if (currentIds.has(id)) continue
      tie(id, windowsRef.current.get(id), boxOf(id) ?? boxesRef.current.get(id))
    }
    return out
  }, [reading, placement, boxOf, leavingIds, currentIds])

  /* The rail's lit bar: the leg the stage is drawing, which is the main window's own step. A leg is
   * a step of the line, so the lit bar is a step and never the child column's first seat. */
  const litId = reading.main?.id

  /* Which windows joined on this beat, and the point each grew from — the line's own leaving point,
   * so the tie and the growth agree by construction. The main window is never one of them: it is the
   * conversation this pane is about, so it was already there and has nowhere to arrive from. A child
   * whose row is off the feed has no source either, and is simply drawn. */
  const births = React.useMemo((): ReadonlyMap<string, { readonly x: number; readonly y: number }> => {
    const out = new Map<string, { readonly x: number; readonly y: number }>()
    for (const { id, link } of links) {
      const born = layoutBirth({ main: false, link })
      if (born !== undefined) out.set(id, born)
    }
    return out
  }, [links])

  /* The shift and the size a window's flight starts at, read off the joining beat and kept for the
   * span it plays (`flying` above).
   *
   * The mark is taken the first time a window is drawn while its entrance is still owed — on the
   * arrival's own beat, or on the first beat after it that the reading knows where the window came
   * from. A child is listed the moment its session exists, while the dispatch row that anchors it is
   * written when the tool that started it answers, a few frames later: the source is not always
   * there on the arrival. Once taken, the aim is never re-read, so a re-measure under the flight
   * cannot re-aim it. */
  const flightOf = (id: string, box: OverviewBox): { readonly dx: number; readonly dy: number; readonly s: number } | undefined => {
    const held = flying.current.get(id)
    if (held !== undefined) return held
    if (!arrivedNow.includes(id) && !joined.has(id)) return undefined
    const born = births.get(id)
    if (born === undefined) return undefined
    const mark = {
      dx: Math.round(born.x - box.left),
      dy: Math.round(born.y - box.top),
      s: Math.min(0.28, 44 / Math.max(1, box.width)),
    }
    flying.current.set(id, mark)
    return mark
  }

  /* A window's first box is a provisional one. The rows that fill it are its own conversation's, and
   * the pane cannot read them until the session windows are held open — so every window first stands
   * measured over nothing, a title line, and reaches its real numbers a beat later. That growth is
   * the one box change worth spending on the way: the panel opens with its windows expanding into
   * place instead of snapping from a flat bar to a full one (the sheet's own note says why only this
   * one bit of travel is allowed).
   *
   * So the mark covers a window's **opening**: it is on from the first beat the window stands, and it
   * stays until the rows it was waiting for have landed and their growth has had its span — a breath
   * past that, and the pane is drawn by the geometry alone, exactly like every window after its
   * opening. The arm has to be on the pane *before* the change it is there for: a commit that grows
   * the box with nothing to travel from is the jump this is here to end. A window that never reads a
   * row keeps the arm only as long as the opening could plausibly last, so a re-measure later is
   * never spent. */
  const openings = React.useRef<Map<string, { readonly at: number; rowsAt?: number }>>(new Map())
  const openingTimers = React.useRef<Map<string, { readonly until: number; readonly timer: ReturnType<typeof setTimeout> }>>(new Map())
  const [, setOpeningPass] = React.useState(0)
  const rowsIn = new Map<string, number>()
  if (reading.main !== null) rowsIn.set(reading.main.id, reading.main.rows.length)
  for (const one of reading.children) rowsIn.set(one.id, one.rows.length)
  const opening: string[] = []
  {
    const now = Date.now()
    for (const id of currentIds) {
      let held = openings.current.get(id)
      if (held === undefined) {
        held = { at: now }
        openings.current.set(id, held)
      }
      if (held.rowsAt === undefined && (rowsIn.get(id) ?? 0) > 0) held.rowsAt = now
      if (held.rowsAt === undefined ? now - held.at >= OPENING_MAX_MS : now - held.rowsAt >= GROW_SPAN_MS) continue
      opening.push(id)
      /* The rows landing is what shortens this window's deadline, so the timer is re-read from the
       * deadline it was set for rather than only when there is none: a stale 3s wait would hold the
       * mark long past the opening and spend a re-measure the reader did not ask for. */
      const until = held.rowsAt === undefined ? held.at + OPENING_MAX_MS : held.rowsAt + GROW_SPAN_MS
      const scheduled = openingTimers.current.get(id)
      if (scheduled !== undefined) {
        if (scheduled.until === until) continue
        clearTimeout(scheduled.timer)
      }
      /* The span running out is what sheds the mark: a class left standing would spend the next
       * change too, and only the opening's growth is allowed to travel. */
      const timer = setTimeout(() => {
        openingTimers.current.delete(id)
        setOpeningPass((pass) => pass + 1)
      }, Math.max(0, until - now) + 40)
      openingTimers.current.set(id, { until, timer })
    }
  }

  return (
    <div className="superworker-overview" ref={bodyRef}>
      {placement.railVisible ? (
        /* The rail is the line's switch: one bar per step still on the table, the one the stage is
         * drawing lit. A bar carries no word — the nameplate on the stage is what names the step being
         * read — so the node's title rides the bar's own name, for a hover and for a screen reader.
         * A press hands the leg back; the panel is what decides the stage follows it. */
        <div className="superworker-orail" style={{ left: RAIL_LEFT }}>
          {reading.legs.map((one) => {
            const on = one.id === litId
            const pick = props.pick ?? null
            return (
              <button
                key={one.id}
                type="button"
                /* One ink, one fact: the lit bar is the step being read, the warn ink is a person's
                 * gate, the break's ink is work owed with nobody on it. */
                className={[
                  on ? 'is-on' : '',
                  one.waiting === true ? 'is-need' : '',
                  one.alert === true ? 'is-broken' : '',
                ].filter((word) => word.length > 0).join(' ')}
                style={{ width: railBarWidth(one.rows, on) }}
                title={one.title ?? undefined}
                aria-label={one.title ?? undefined}
                aria-current={on ? 'true' : undefined}
                disabled={pick === null}
                onClick={pick === null ? undefined : () => pick(one.id)}
              >
                <b aria-hidden="true" />
              </button>
            )
          })}
        </div>
      ) : null}
      <div
        className={`superworker-ofield${settling ? ' is-settle' : ''}`}
        style={{
          /* The field is the stage's own frame — the sheet lays it over the whole stage — and the
           * boxes inside it are already in stage coordinates. Writing the field's own left/top here
           * as well would add that offset a second time. */
          '--superworker-plate-out': `${placement.plateOut}px`,
          '--superworker-orow-h': `${ROW_H}px`,
        } as React.CSSProperties}
      >
        {links.length === 0 ? null : (
          /* Drawn first, so the windows stand over it: a line runs under the panes it ties. */
          <svg className="superworker-olinks" aria-hidden="true">
            {links.map(({ id, link }) => (
              <g key={id}>
                <path className="superworker-olink is-live" d={link.d} />
                <circle className="superworker-olink-dot" cx={link.fromX} cy={link.fromY} r={LINK_DOT_R} />
              </g>
            ))}
          </svg>
        )}
        {reading.main === null ? null : (
          <WindowPane
            box={placement.main}
            window={reading.main}
            at={at}
            main
            leave={leavingIds.includes(reading.main.id)}
            fresh={freshIds.has(reading.main.id)}
            /* The main window has no source: it is the conversation this pane is about, so it was
             * already here. Its own appearance fades in; it never travels. */
            born={undefined}
            grow={opening.includes(reading.main.id)}
            go={props.go}
          />
        )}
        {reading.children.map((one) => {
          /* The box comes from the cast by id, never from the child's index: a window still folding
           * holds the slot it stood in, so the survivors keep the boxes they drew with. */
          const box = boxOf(one.id)
          if (box === undefined) return null
          return (
            <WindowPane
              key={one.id}
              box={box}
              window={one}
              at={at}
              main={false}
              leave={leavingIds.includes(one.id)}
              fresh={freshIds.has(one.id)}
              /* A child grows out of the row that dispatched it, and only while its entrance is
               * owed: the mark is taken on the first drawing that can carry it and kept in `flying`
               * until the entrance's span has run. */
              born={flightOf(one.id, box)}
              grow={opening.includes(one.id)}
              go={props.go}
            />
          )
        })}
        {spill === undefined ? null : (
          /* The count of windows the cap folded away: three dots and the number, on the column's own
           * top edge. It says a fact the five windows cannot say about themselves, and it is a count,
           * never a window. */
          <div
            className="superworker-ospill"
            aria-hidden="true"
            style={{ left: spill.left, top: spill.top, width: spill.width, height: spill.height }}
          >
            {Array.from({ length: SPILL_DOTS }, (_, dot) => <i key={dot} />)}
            <span className="superworker-num">{`+${reading.hiddenChildren}`}</span>
          </div>
        )}
        {leavingIds.map((id) => {
          if (currentIds.has(id)) return null
          /* Its slot is still in the cast — that is what keeps the room from closing under it — so the
           * box it folds in is the one the column is measuring right now, not a remembered copy. */
          const box = boxOf(id) ?? boxesRef.current.get(id)
          const window = windowsRef.current.get(id)
          if (box === undefined || window === undefined) return null
          return (
            <WindowPane
              key={id}
              box={box}
              window={window}
              at={at}
              main={false}
              leave
              fresh={false}
              born={undefined}
              grow={false}
              go={props.go}
            />
          )
        })}
      </div>
    </div>
  )
}
