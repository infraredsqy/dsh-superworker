/**
 * The overview's windows: the reading of this moment, drawn.
 *
 * What comes in is the reading (`OverviewReading`) and the fetch beat's moment — nothing is
 * fetched here and no reading is judged again; the pane measures its own stage, lays the windows
 * out with `overview-geom`, and draws. Each motion is bound to exactly one fact, and the facts are
 * diffed between consecutive readings, never invented:
 *
 * - enter — the window set gained a window: it unfolds, sideways first and then down to its rows;
 * - leave — the set lost one; the pane folds as it lingers — the rows up into the title line, then
 *   the sliver away sideways — and when the span has run, the page loses it. A child that ended
 *   leaves this way: the reading stops drawing it the moment its session stops running, so it is
 *   never kept as a finished window — and a seat the line re-takes later comes back the same road,
 *   which is why a re-seated window reads as the same window opening again, not a jump;
 * - fresh row — one window's newest row is not the row it was (growth, or the cut that replaced
 *   the top row when the newest arrived);
 * - breathing border — the main window's node stands at a person's gate: it is waiting for the reader
 *   to say yes. It loops by itself; being seen is its whole job.
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
  readonly enter: boolean
  readonly leave: boolean
  readonly fresh: boolean
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
  /* The veil answers one fact: this conversation wants the reader to act, so its rows are context and
   * step back. Three verdicts wear it — work handed in, a break, a person's gate — and the frame's ink
   * is what tells them apart; a window still running is the only one whose rows are the subject. The
   * gate is read off its own fact rather than off `settled`, because a gate is a person being owed
   * whether or not the conversation behind it happens to be quiet. */
  const veiled = atGate || pane.settled === true
  /* The one mark a window's cell carries: the check for work handed in. */
  const mark = handed
    ? layoutMark({ width: box.width, height: box.height, head, foot, size: MARK_CHECK, stroke: MARK_CHECK_STROKE })
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
  const cls = [
    'superworker-opane',
    props.main ? 'is-main' : 'is-child',
    props.enter ? 'is-enter' : '',
    props.leave ? 'is-leave' : '',
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
         * hands its own values over as vars. */
        '--superworker-pane-w': `${box.width}px`,
        '--superworker-pane-h': `${box.height}px`,
        '--superworker-pane-fold': `${head + foot + BOX_BORDER}px`,
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
          className="superworker-omark"
          aria-hidden="true"
          style={{
            left: mark.left,
            top: mark.top,
            width: mark.size,
            height: mark.size,
            '--superworker-seal-scrim': `${MARK_SCRIM}px`,
          } as React.CSSProperties}
        >
          <FinishedMark stroke={mark.stroke} />
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
 * changes: enter on first sight, leave on a vanished id (held until the leave's span has run),
 * fresh on a replaced newest row, breathing on the person gate.
 */
export function OverviewPane(props: {
  readonly reading: OverviewReading
  readonly at: Date
  /** Where a press on a window goes: the panel's admission and DSH's own navigation gateway. */
  readonly go: WindowGo | null
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
  const childRows = React.useMemo(() => reading.children.map((one) => one.rows.length), [reading])
  const placement = React.useMemo(
    () => layoutOverview({ stage, mainRows, childRows }),
    [stage, mainRows, childRows],
  )

  /* The windows the five-window cap folded away: counted above the column, and not drawn at all when
   * there are none, when the column did not stand, or when the stage leaves no ground above it. */
  const spill = React.useMemo(
    () => layoutSpill({ children: placement.children, hiddenChildren: reading.hiddenChildren }),
    [placement, reading.hiddenChildren],
  )

  const currentIds = React.useMemo(
    () => new Set([reading.main?.id, ...reading.children.map((one) => one.id)].filter((one): one is string => one !== undefined)),
    [reading],
  )

  /* Enter: a window that has joined wears the mark for as long as it stands here — the animation
   * fills once and stays. The set is read while drawing (each pane asks whether it has entered);
   * the leave effect sheds a leaving window's mark, so a return is an entrance again. */
  const enteredRef = React.useRef<Set<string>>(new Set())
  for (const id of currentIds) enteredRef.current.add(id)

  /* Leave: the ids that vanished keep their last box for the leave's span, then the page loses them. */
  const [leaving, setLeaving] = React.useState<ReadonlySet<string>>(new Set())
  const timers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  React.useEffect(() => {
    setLeaving((held) => {
      const kept = [...held].filter((id) => !currentIds.has(id))
      if (kept.length === held.size) return held
      for (const id of held) {
        if (kept.includes(id)) continue
        const timer = timers.current.get(id)
        if (timer !== undefined) {
          clearTimeout(timer)
          timers.current.delete(id)
        }
      }
      return new Set(kept)
    })
    for (const id of [...enteredRef.current]) {
      if (currentIds.has(id)) continue
      /* The leaving window sheds its enter mark: if it comes back, it is an entrance again. */
      enteredRef.current.delete(id)
      if (timers.current.has(id)) continue
      const timer = setTimeout(() => {
        timers.current.delete(id)
        setLeaving((held) => {
          if (!held.has(id)) return held
          const next = new Set(held)
          next.delete(id)
          return next
        })
      }, LEAVE_SPAN_MS)
      timers.current.set(id, timer)
      setLeaving((held) => {
        if (held.has(id)) return held
        const next = new Set(held)
        next.add(id)
        return next
      })
    }
  }, [currentIds])
  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
    },
    [],
  )

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

  /* The last box and the last reading each id drew from: what a leaving pane has to draw with. */
  const boxesRef = React.useRef<Map<string, OverviewBox>>(new Map())
  const windowsRef = React.useRef<Map<string, OverviewWindow>>(new Map())
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
    reading.children.forEach((child, i) => tie(child.id, child, placement.children[i]))
    for (const id of leaving) {
      if (currentIds.has(id)) continue
      tie(id, windowsRef.current.get(id), boxesRef.current.get(id))
    }
    return out
  }, [reading, placement, leaving, currentIds])

  /* The rail's lit bar: the first child, which is the one the column is showing in hand — every child
   * the reading draws is still running, so the first is the one moving. */
  const litId = reading.children[0]?.id

  return (
    <div className="superworker-overview" ref={bodyRef}>
      {placement.railVisible ? (
        <div className="superworker-orail" aria-hidden="true" style={{ left: RAIL_LEFT }}>
          {reading.children.map((one) => (
            <b
              key={one.id}
              /* The lit bar follows the child the column shows in hand. The warn ink is the person
               * gate's alone: a bar wears it when the window it stands for is the one at the gate, and
               * a bar for a child never is — which is what keeps one ink meaning one fact. */
              className={`${one.id === litId ? 'is-on' : ''}${one.waiting === true ? ' is-need' : ''}`.trim()}
              style={{ width: railBarWidth(one.rows.length, one.id === litId) }}
            />
          ))}
        </div>
      ) : null}
      <div
        className="superworker-ofield"
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
            enter={enteredRef.current.has(reading.main.id)}
            leave={leaving.has(reading.main.id)}
            fresh={freshIds.has(reading.main.id)}
            go={props.go}
          />
        )}
        {reading.children.map((one, i) => {
          const box = placement.children[i]
          if (box === undefined) return null
          return (
            <WindowPane
              key={one.id}
              box={box}
              window={one}
              at={at}
              main={false}
              enter={enteredRef.current.has(one.id)}
              leave={leaving.has(one.id)}
              fresh={freshIds.has(one.id)}
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
        {[...leaving].map((id) => {
          if (currentIds.has(id)) return null
          const box = boxesRef.current.get(id)
          const window = windowsRef.current.get(id)
          if (box === undefined || window === undefined) return null
          return (
            <WindowPane
              key={id}
              box={box}
              window={window}
              at={at}
              main={false}
              enter={false}
              leave
              fresh={false}
              go={props.go}
            />
          )
        })}
      </div>
    </div>
  )
}
