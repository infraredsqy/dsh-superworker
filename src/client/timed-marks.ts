/**
 * The one timed-mark registry the overview's motion stations share: "lit, and shed N milliseconds
 * later", written once.
 *
 * A station declares which ids stand marked and for how long; this owns the rest. The marks live in
 * state the drawing reads (`held`), each mark's timer is kept here, a mark is shed when its span has
 * run, and the unmount clears every timer at once — the cleanup no station writes itself, so a new
 * station cannot forget it.
 *
 * Two ways to hold a mark, one mechanism:
 *
 * - `hold(ids, span)` — each id is marked for `span` milliseconds from this call. Holding an id that
 *   is already marked never strips its mark and never doubles it: the mark stands on through the
 *   re-arm, and its span starts over. That is what keeps a beat landing between two arrivals from
 *   blinking the newest row's mark away mid-animation.
 * - `holdUntil(ids, untilOf)` — each id is armed until the absolute moment `untilOf` names for it,
 *   for marks whose standing the station reads from its own refs (an opening's deadline, a closing
 *   page) rather than from here: the shed answers `onExpire` and asks for the redraw. A re-arm
 *   naming the moment already being waited on leaves the running timer alone, so a redraw under
 *   the mark cannot spend the span twice.
 *
 * `shed` takes marks back before their span has run, and nothing that waits on expiry fires — a
 * window back before its fold has run keeps standing, and is not read as an arrival again. `end`
 * drops everything at once, for a cast that was replaced whole: it held nothing, so nothing sheds.
 *
 * Expiry answers `onExpire` — the one consequence that is the station's own (the room closing up as
 * a fold ends, a flight aim dying with its entrance) — after the mark is shed, in the same breath:
 * the render that reads the shed mark is the render that carries the consequence.
 */
import * as React from 'react'

/** One mark's wait: the moment it sheds at, and the timer that sheds it. */
interface Wait {
  readonly until: number
  readonly timer: ReturnType<typeof setTimeout>
}

/** What one motion station declares: the ids standing marked, and the registry running their spans. */
export interface TimedMarks {
  /** The ids standing marked by `hold`, read while drawing. */
  readonly held: ReadonlySet<string>
  /** Mark each id for `span` milliseconds from this call; a mark already standing stands on, its span restarting. */
  hold(ids: Iterable<string>, span: number): void
  /** Arm each id until the moment `untilOf` names for it; a re-arm naming the waited-on moment idles, and the shed answers `onExpire`. */
  holdUntil(ids: Iterable<string>, untilOf: (id: string) => number): void
  /** Take marks back before their span has run; nothing that waits on expiry fires. */
  shed(ids: Iterable<string>): void
  /** Drop every mark and every timer at once. */
  end(): void
}

/**
 * The stations' registry, one instance per station shape. The stations that read their marks while
 * drawing take the state face (`hold`); the stations whose marks live in their own refs take the
 * timer-only face (`holdUntil`, with the expiry redraw this keeps bumping). The timers are the one
 * thing every instance keeps here.
 */
export function useTimedMarks(onExpire?: (id: string) => void): TimedMarks {
  const [held, setHeld] = React.useState<ReadonlySet<string>>(() => new Set<string>())
  /* Expiry must reach the draw even when the station reads no state here: the shed itself is what
   * asks for the redraw, since the mark's standing is not always readable off `held`. */
  const [, shedPass] = React.useState(0)
  const waits = React.useRef<Map<string, Wait>>(new Map())
  const expire = React.useRef(onExpire)
  expire.current = onExpire

  /* The one cleanup the stations no longer write: every timer this registry armed dies with the pane. */
  React.useEffect(
    () => () => {
      for (const wait of waits.current.values()) clearTimeout(wait.timer)
      waits.current.clear()
    },
    [],
  )

  const arm = (id: string, until: number): void => {
    const wait = waits.current.get(id)
    if (wait !== undefined && wait.until === until) return
    if (wait !== undefined) clearTimeout(wait.timer)
    const timer = setTimeout(() => {
      waits.current.delete(id)
      setHeld((marked) => {
        if (!marked.has(id)) return marked
        const next = new Set(marked)
        next.delete(id)
        return next
      })
      shedPass((pass) => pass + 1)
      expire.current?.(id)
    }, Math.max(0, until - Date.now()))
    waits.current.set(id, { until, timer })
  }

  const hold = (ids: Iterable<string>, span: number): void => {
    const at = Date.now()
    const marked: string[] = []
    for (const id of ids) marked.push(id)
    for (const id of marked) arm(id, at + span)
    setHeld((standing) => {
      const next = new Set(standing)
      for (const id of marked) if (!standing.has(id)) next.add(id)
      return next.size === standing.size ? standing : next
    })
  }

  const holdUntil = (ids: Iterable<string>, untilOf: (id: string) => number): void => {
    for (const id of ids) arm(id, untilOf(id))
  }

  const shed = (ids: Iterable<string>): void => {
    const taken = new Set(ids)
    for (const id of taken) {
      const wait = waits.current.get(id)
      if (wait === undefined) continue
      clearTimeout(wait.timer)
      waits.current.delete(id)
    }
    setHeld((standing) => {
      const kept = [...standing].filter((id) => !taken.has(id))
      return kept.length === standing.size ? standing : new Set(kept)
    })
  }

  const end = (): void => {
    for (const wait of waits.current.values()) clearTimeout(wait.timer)
    waits.current.clear()
    setHeld((standing) => (standing.size === 0 ? standing : new Set<string>()))
  }

  return { held, hold, holdUntil, shed, end }
}
