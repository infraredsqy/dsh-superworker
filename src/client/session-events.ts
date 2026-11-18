/**
 * The overview's session-event windows: what each window's pane folds its rows from.
 *
 * DSH's browser half holds every session's own event window behind its `sessions` service — the
 * same layer every conversation view reads through. This file forwards that service to the panel
 * under a narrow face: `watch` names the sessions whose windows the overview holds open (the main
 * conversation, the children still running, and the finished children the reading still draws),
 * `getSnapshot` hands the durable events back keyed by session, and `getLive` hands the window's
 * transient live chunks back the same way — DSH's own `assistant/live-chunk` presentation, kept
 * apart from the durable log because they are never history. The live chunks are the high-rate
 * half: one redraw follows the animation frame, not the chunk — the same cadence DSH's
 * conversation half publishes them at — while a durable event publishes on the spot, taking any
 * pending frame with it (a settlement retires the chunks it settles). The service arrives late on
 * some deployments, so the forwarding is written the way the workspace list's is: adopt once, tell
 * the listeners, and until then serve one stable empty snapshot.
 *
 * Everything is read defensively off the shapes DSH actually ships; nothing here throws.
 */
import { injectAt, type ClientContext } from './context.ts'
import { serviceAt } from './data.ts'
import type { OverviewEvent } from '../model/index.ts'

/**
 * The overview's face on DSH's session windows: watch, read, subscribe.
 *
 * `watch` is the holding hand: the ids named are retained and their windows subscribed; ids no
 * longer named are released. An id whose window cannot open draws no rows and says nothing.
 */
export interface SessionWindows {
  getSnapshot(): Readonly<Record<string, readonly OverviewEvent[]>>
  /** The transient live chunks, keyed by session id: the streaming step's own half of the window. */
  getLive(): Readonly<Record<string, readonly OverviewEvent[]>>
  subscribe(listener: () => void): () => void
  watch(ids: readonly string[]): void
}

/** The snapshot when nothing is held. One stable object: React compares identities. */
const EMPTY: Readonly<Record<string, readonly OverviewEvent[]>> = Object.freeze({})

/** The face a deployment without the service serves: nothing held, nobody notified. */
export const NO_WINDOWS: SessionWindows = {
  getSnapshot: () => EMPTY,
  getLive: () => EMPTY,
  subscribe: () => () => undefined,
  watch: () => undefined,
}

/** A window with no readable events reads as empty — and reads as the same object, not a fresh one. */
const EMPTY_EVENTS: readonly OverviewEvent[] = Object.freeze([])

interface Hold {
  release?: (() => void) | undefined
  off?: (() => void) | undefined
  events: readonly OverviewEvent[]
  live: readonly OverviewEvent[]
}

/** One window read apart: the durable log, and the transient live chunks beside it. */
interface WindowRead {
  readonly events: readonly OverviewEvent[]
  readonly live: readonly OverviewEvent[]
}

/** Whether two forwarded lists hold the same entries in the same order — the test that keeps an unchanged window from asking for a redraw. */
function sameEvents(left: readonly OverviewEvent[], right: readonly OverviewEvent[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let at = 0; at < left.length; at++) {
    if (left[at] !== right[at]) return false
  }
  return true
}

/** What one window carries: durable entries forward whole; live chunks ride `transient` and land in their own list, never the durable one. */
function readWindow(source: unknown): WindowRead {
  const read = (source as { getSnapshot?: unknown } | null | undefined)?.getSnapshot
  if (typeof read !== 'function') return { events: EMPTY_EVENTS, live: EMPTY_EVENTS }
  let held: unknown
  try {
    held = (read as () => unknown).call(source)
  } catch {
    return { events: EMPTY_EVENTS, live: EMPTY_EVENTS }
  }
  const entries = (held as { entries?: unknown } | null | undefined)?.entries
  if (!Array.isArray(entries)) return { events: EMPTY_EVENTS, live: EMPTY_EVENTS }
  const events: OverviewEvent[] = []
  const live: OverviewEvent[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const event = (entry as { event?: unknown }).event
    if (event === null || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') continue
    const kind = (entry as { type?: unknown }).type
    if (kind === 'transient') live.push(event as OverviewEvent)
    else if (kind === 'event') events.push(event as OverviewEvent)
  }
  return { events, live }
}

/**
 * Take the forwarding face off a context that already has the service.
 * @param owner - A context (the plugin's own, or the one given to the inject callback).
 */
export function sessionWindowsAt(owner: unknown): SessionWindows | undefined {
  const service = serviceAt(owner, 'sessions') as
    | { retain?: unknown }
    | undefined
  const retain = service?.retain
  if (typeof retain !== 'function') return undefined

  const holds = new Map<string, Hold>()
  const listeners = new Set<() => void>()
  let eventsSnapshot = EMPTY
  let liveSnapshot = EMPTY
  let dirtyEvents = false
  let dirtyLive = false
  /* The pending live frame, when one is: further chunks ask for nothing while it stands. */
  let frame: number | undefined

  const publish = (): void => {
    if (!dirtyEvents && !dirtyLive) return
    if (dirtyEvents) {
      const next: Record<string, readonly OverviewEvent[]> = {}
      for (const [id, hold] of holds) next[id] = hold.events
      eventsSnapshot = next
      dirtyEvents = false
    }
    if (dirtyLive) {
      const next: Record<string, readonly OverviewEvent[]> = {}
      for (const [id, hold] of holds) next[id] = hold.live
      liveSnapshot = next
      dirtyLive = false
    }
    for (const listener of listeners) listener()
  }

  /** Publish on the spot, taking a pending live frame with it: a durable event is a settlement, and the chunks it retires never wait behind a frame. */
  const publishNow = (): void => {
    if (frame !== undefined) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      frame = undefined
    }
    publish()
  }

  /**
   * The live chunks' beat: one redraw follows the animation frame, not the chunk — the cadence
   * DSH's conversation half publishes live chunks at. While a frame is pending, further chunks
   * ask for nothing; the pending frame already carries them.
   */
  const scheduleLive = (): void => {
    if (frame !== undefined) return
    if (typeof requestAnimationFrame !== 'function') {
      publish()
      return
    }
    /* Cross three paint opportunities before the redraw, exactly DSH's own cadence. */
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = undefined
          publish()
        })
      })
    })
  }

  const open = (id: string): void => {
    let reference: {
      readonly binding?: { readonly eventSource?: unknown } | undefined
      readonly release?: (() => void) | undefined
    } | undefined
    try {
      reference = (retain as (target: string, options: unknown) => unknown).call(service, id, {
        source: 'superworker-overview',
      }) as typeof reference
    } catch {
      return
    }
    if (reference === undefined || reference === null) return
    const hold: Hold = {
      release: typeof reference.release === 'function' ? () => reference?.release?.() : undefined,
      off: undefined,
      events: EMPTY_EVENTS,
      live: EMPTY_EVENTS,
    }
    const source = reference.binding?.eventSource
    const read = (source as { getSnapshot?: unknown } | null | undefined)?.getSnapshot
    const subscribe = (source as { subscribe?: unknown } | null | undefined)?.subscribe
    if (typeof read === 'function' && typeof subscribe === 'function') {
      const first = readWindow(source)
      hold.events = first.events
      hold.live = first.live
      try {
        const off = (subscribe as (listener: () => void) => unknown).call(source, () => {
          const next = readWindow(source)
          const eventsMoved = !sameEvents(hold.events, next.events)
          const liveMoved = !sameEvents(hold.live, next.live)
          hold.events = next.events
          hold.live = next.live
          if (eventsMoved) {
            dirtyEvents = true
            dirtyLive = true
            publishNow()
          } else if (liveMoved) {
            dirtyLive = true
            scheduleLive()
          }
        })
        hold.off = typeof off === 'function' ? (off as () => void) : undefined
      } catch {
        /* A window that cannot be subscribed still reads its snapshot; it just stops living. */
      }
    }
    holds.set(id, hold)
    dirtyEvents = true
    dirtyLive = true
  }

  const face: SessionWindows = {
    getSnapshot: () => eventsSnapshot,
    getLive: () => liveSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    watch(ids) {
      const wanted = new Set(ids)
      for (const [id, hold] of [...holds]) {
        if (wanted.has(id)) continue
        hold.off?.()
        try {
          hold.release?.()
        } catch {
          /* Releasing is best-effort: the window drops from the snapshot either way. */
        }
        holds.delete(id)
        dirtyEvents = true
        dirtyLive = true
      }
      for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0 || holds.has(id)) continue
        open(id)
      }
      publishNow()
    },
  }
  return face
}

/**
 * The forwarded face for the plugin's own context: the service if it stands there now, otherwise
 * the empty face until it arrives — then the listeners hear about it and the panel re-reads.
 * @param ctx - The browser-half plugin context.
 */
export function createSessionWindows(ctx: unknown): SessionWindows {
  let face: SessionWindows | undefined
  const listeners = new Set<() => void>()
  let stopFace: (() => void) | undefined
  const sync = (): void => {
    for (const listener of listeners) listener()
  }
  const adopt = (found: SessionWindows | undefined): void => {
    if (found === undefined || found === face) return
    stopFace?.()
    stopFace = undefined
    face = found
    if (listeners.size > 0) stopFace = found.subscribe(sync)
    sync()
  }
  adopt(sessionWindowsAt(ctx))
  if (face === undefined) {
    injectAt(ctx as ClientContext, ['sessions'], 'the session windows did not attach', (owner) => {
      adopt(sessionWindowsAt(owner))
    })
  }
  return {
    getSnapshot: () => face?.getSnapshot() ?? EMPTY,
    getLive: () => face?.getLive() ?? EMPTY,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1 && face !== undefined) {
        stopFace = face.subscribe(sync)
        sync()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopFace?.()
          stopFace = undefined
        }
      }
    },
    watch(ids) {
      face?.watch(ids)
    },
  }
}
