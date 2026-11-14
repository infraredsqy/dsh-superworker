/**
 * The overview's windows: the reading of this moment, drawn.
 *
 * What comes in is the reading (`OverviewReading`) and the fetch beat's moment — nothing is
 * fetched here and no reading is judged again; the pane measures its own stage, lays the windows
 * out with `overview-geom`, and draws. Each motion is bound to exactly one fact, and the facts are
 * diffed between consecutive readings, never invented:
 *
 * - enter — the window set gained a window;
 * - leave — the set lost one; the pane lingers for the leave's span, then leaves the page;
 * - fresh row — one window's newest row is not the row it was (growth, or the cut that replaced
 *   the top row when the newest arrived);
 * - breathing border — the window's newest row is a dispatch row: it has sent work and is waiting
 *   for it. Only this motion loops by itself; its whole job is to be seen.
 *
 * A window's id is wiring, not words: it rides a `data-window` attribute and never prints.
 */
import * as React from 'react'
import type { OverviewReading, OverviewRowKind, OverviewWindow } from '../model/index.ts'
import { clock } from '../model/index.ts'
import {
  CHILD_FOOT,
  CHILD_HEAD,
  MAIN_FOOT,
  MAIN_HEAD,
  RAIL_LEFT,
  ROW_H,
  layoutOverview,
  railBarWidth,
  type OverviewBox,
  type StageSize,
} from './overview-geom.ts'
import { useT, type Translate } from './locale.ts'
import { timeOf } from './words.ts'
import type { WordKey } from './locales/index.ts'

/** How long the leave animation runs; the removal waits a breath past it. The span itself lives in the sheet. */
const LEAVE_SPAN_MS = 260

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
  return `${t(WEIGHT_WORDS[window.weight])} · ${t(modeWordOf(window.mode))}`
}

/** The breathing fact: a window whose newest row is a dispatch row has sent work and is waiting for it. */
function isWaiting(window: OverviewWindow): boolean {
  const last = window.rows[window.rows.length - 1]
  return last !== undefined && last.kind === 'dispatch'
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

/** One window's feed: the rows it holds, newest at the bottom, the top fading when the room ran out. */
function Feed(props: {
  readonly window: OverviewWindow
  /** How many rows the box has room for; past it the top row fades out. */
  readonly room: number
  /** Whether this window's newest row arrived on this beat. */
  readonly fresh: boolean
  readonly head: number
  readonly foot: number
}): React.ReactElement {
  const t = useT()
  const rows = props.window.rows
  return (
    <div
      className={`superworker-ofeed${rows.length > props.room ? ' is-fade' : ''}`}
      style={{ top: props.head, bottom: props.foot }}
    >
      {rows.map((row, at) => (
        <div
          key={at}
          className={`superworker-orow is-${row.kind}${at === rows.length - 1 && props.fresh ? ' is-fresh' : ''}`}
          title={row.full}
        >
          <KindMark kind={row.kind} />
          <span className="superworker-orow-t">{`${t(ROW_WORDS[row.kind])} · ${row.text}`}</span>
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
  readonly waiting: boolean
}): React.ReactElement {
  const t = useT()
  const { box, window: pane } = props
  const readings = readingsOf(t, pane)
  const cls = [
    'superworker-opane',
    props.main ? 'is-main' : 'is-child',
    props.enter ? 'is-enter' : '',
    props.leave ? 'is-leave' : '',
    props.waiting ? 'is-wait' : '',
  ]
    .filter((one) => one.length > 0)
    .join(' ')
  return (
    <section className={cls} data-window={pane.id} style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {props.main ? (
        <div className="superworker-oplate">
          {pane.title === null ? null : <p className="superworker-oplate-t">{pane.title}</p>}
          <p className="superworker-oplate-m">
            {readings === null ? null : <span>{readings}</span>}
            <span className="superworker-num">{timeOf(t, pane.startedAt, props.at)}</span>
          </p>
        </div>
      ) : (
        <div className="superworker-ohead">
          <span className="superworker-ohead-t">{pane.title ?? ''}</span>
          {readings === null ? null : <span className="superworker-ohead-r">{readings}</span>}
          <span className="superworker-num">{clock(pane.startedAt)}</span>
        </div>
      )}
      <Feed window={pane} room={box.rowsRoom} fresh={props.fresh} head={props.main ? MAIN_HEAD : CHILD_HEAD} foot={props.main ? MAIN_FOOT : CHILD_FOOT} />
    </section>
  )
}

/**
 * The overview pane over the reading of one moment. The motion facts ride the beat the reading
 * changes: enter on first sight, leave on a vanished id (held until the leave's span has run),
 * fresh on a replaced newest row, breathing on the waiting fact.
 */
export function OverviewPane(props: {
  readonly reading: OverviewReading
  readonly at: Date
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

  return (
    <div className="superworker-overview" ref={bodyRef}>
      {placement.railVisible ? (
        <div className="superworker-orail" aria-hidden="true" style={{ left: RAIL_LEFT }}>
          {reading.children.map((one, i) => (
            <b
              key={one.id}
              className={`${i === 0 ? 'is-on' : ''}${isWaiting(one) ? ' is-need' : ''}`.trim()}
              style={{ width: railBarWidth(one.rows.length, i === 0) }}
            />
          ))}
        </div>
      ) : null}
      <div
        className="superworker-ofield"
        style={{
          left: placement.fieldLeft,
          top: placement.fieldTop,
          width: placement.fieldWidth,
          height: placement.fieldHeight,
          '--superworker-plate-out': `${placement.plateOut}px`,
          '--superworker-orow-h': `${ROW_H}px`,
        } as React.CSSProperties}
      >
        {reading.main === null ? null : (
          <WindowPane
            box={placement.main}
            window={reading.main}
            at={at}
            main
            enter={enteredRef.current.has(reading.main.id)}
            leave={leaving.has(reading.main.id)}
            fresh={freshIds.has(reading.main.id)}
            waiting={isWaiting(reading.main)}
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
              waiting={isWaiting(one)}
            />
          )
        })}
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
              waiting={false}
            />
          )
        })}
      </div>
    </div>
  )
}
