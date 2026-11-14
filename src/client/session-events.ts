/**
 * The overview's session-event windows: what each window's pane folds its rows from.
 *
 * DSH's browser half holds every session's own event window behind its `sessions` service — the
 * same layer every conversation view reads through. This file forwards that service to the panel
 * under a narrow face: `watch` names the sessions whose windows the overview holds open (the main
 * conversation and the children still running), `getSnapshot` hands the durable events back keyed
 * by session. The service arrives late on some deployments, so the forwarding is written the way
 * the workspace list's is: adopt once, tell the listeners, and until then serve one stable empty
 * snapshot.
 *
 * Only durable events come through — a live chunk is presentation for a view that owns it, never
 * history. Everything is read defensively off the shapes DSH actually ships; nothing here throws.
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
  subscribe(listener: () => void): () => void
  watch(ids: readonly string[]): void
}

/** The snapshot when nothing is held. One stable object: React compares identities. */
const EMPTY: Readonly<Record<string, readonly OverviewEvent[]>> = Object.freeze({})

/** The face a deployment without the service serves: nothing held, nobody notified. */
export const NO_WINDOWS: SessionWindows = {
  getSnapshot: () => EMPTY,
  subscribe: () => () => undefined,
  watch: () => undefined,
}

/** A window with no readable events reads as empty — and reads as the same object, not a fresh one. */
const EMPTY_EVENTS: readonly OverviewEvent[] = Object.freeze([])

interface Hold {
  release?: (() => void) | undefined
  off?: (() => void) | undefined
  events: readonly OverviewEvent[]
}

/** What one durable entry carries; live chunks carry `transient` and stop here. */
function readWindow(source: unknown): readonly OverviewEvent[] {
  const read = (source as { getSnapshot?: unknown } | null | undefined)?.getSnapshot
  if (typeof read !== 'function') return EMPTY_EVENTS
  let held: unknown
  try {
    held = (read as () => unknown).call(source)
  } catch {
    return EMPTY_EVENTS
  }
  const entries = (held as { entries?: unknown } | null | undefined)?.entries
  if (!Array.isArray(entries)) return EMPTY_EVENTS
  const events: OverviewEvent[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || (entry as { type?: unknown }).type !== 'event') continue
    const event = (entry as { event?: unknown }).event
    if (event === null || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') continue
    events.push(event as OverviewEvent)
  }
  return events
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
  let snapshot = EMPTY
  let dirty = false

  const publish = (): void => {
    if (!dirty) return
    const next: Record<string, readonly OverviewEvent[]> = {}
    for (const [id, hold] of holds) next[id] = hold.events
    snapshot = next
    dirty = false
    for (const listener of listeners) listener()
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
    }
    const source = reference.binding?.eventSource
    const read = (source as { getSnapshot?: unknown } | null | undefined)?.getSnapshot
    const subscribe = (source as { subscribe?: unknown } | null | undefined)?.subscribe
    if (typeof read === 'function' && typeof subscribe === 'function') {
      hold.events = readWindow(source)
      try {
        const off = (subscribe as (listener: () => void) => unknown).call(source, () => {
          hold.events = readWindow(source)
          dirty = true
          publish()
        })
        hold.off = typeof off === 'function' ? (off as () => void) : undefined
      } catch {
        /* A window that cannot be subscribed still reads its snapshot; it just stops living. */
      }
    }
    holds.set(id, hold)
    dirty = true
  }

  const face: SessionWindows = {
    getSnapshot: () => snapshot,
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
        dirty = true
      }
      for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0 || holds.has(id)) continue
        open(id)
      }
      publish()
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
