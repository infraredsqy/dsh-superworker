/**
 * Reading DSH's session-list snapshot: the three pure projections the panel needs before it can draw
 * a card — the snapshot itself, which session is the current one, and which sessions this machine
 * knows.
 *
 * Kept out of `mount.ts` on purpose: that file assembles slots and services, and locking a projection
 * down in a unit test should not mean standing a slot registry up with it. Nothing here touches a
 * context, a service, or a DOM; the snapshot is handed in as it arrives.
 */

/**
 * The `useSessions` snapshot from the seat's standard props.
 *
 * It is a hook with a projection: the whole snapshot must be fetched through an identity projection,
 * and passing none amounts to calling it with `undefined` as the selector.
 * @param useSessions - The hook handed over by the slot; nothing when not on this deployment.
 */
export function sessionsSnapshotOf(useSessions: unknown): unknown {
  if (typeof useSessions !== 'function') return undefined
  return (useSessions as (select: (state: unknown) => unknown) => unknown)((state) => state)
}

interface SessionInList {
  readonly id?: unknown
  /** Who still retains it: the entry with `mainView > 0` is the current session. */
  readonly retainedBy?: { readonly mainView?: unknown }
}

/**
 * Pick the current one out of the session list's snapshot at this moment.
 *
 * DSH's own standard is the entry in `byId` with `retainedBy.mainView > 0` — `ids` is the host
 * list's order, and secondary sessions also enter `byId`, so neither equals "the one currently
 * open". The `selectedId` / `currentId` / `activeId` probes serve other shapes and stand-ins, and
 * are used first when present; only when all three are absent and nobody hangs `mainView` does it
 * fall to the list's head as the last resort.
 */
export function currentSessionOf(snapshot: unknown): string | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const held = snapshot as {
    readonly selectedId?: unknown
    readonly currentId?: unknown
    readonly activeId?: unknown
    readonly ids?: unknown
    readonly byId?: unknown
  }
  for (const value of [held.selectedId, held.currentId, held.activeId]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (typeof held.byId === 'object' && held.byId !== null) {
    const sessions = Object.values(held.byId as Record<string, SessionInList | undefined>)
    const current = sessions.find((session) => {
      const held = session?.retainedBy?.mainView
      return typeof held === 'number' && held > 0
    })
    if (typeof current?.id === 'string' && current.id.length > 0) return current.id
  }
  if (Array.isArray(held.ids)) {
    const first = held.ids.find((id): id is string => typeof id === 'string' && id.length > 0)
    if (first !== undefined) return first
  }
  return undefined
}

/**
 * Which sessions this machine has, within the session list's snapshot at this moment.
 *
 * Both places count: `ids` is the host list's order, `byId` is the list rows plus those kept
 * locally. The panel compares this roster against the record to see whether its session exists on
 * this machine — absent from both, a card click has nowhere to go.
 */
export function knownSessionsOf(snapshot: unknown): ReadonlySet<string> {
  const known = new Set<string>()
  if (typeof snapshot !== 'object' || snapshot === null) return known
  const held = snapshot as { readonly ids?: unknown; readonly byId?: unknown }
  if (Array.isArray(held.ids)) {
    for (const id of held.ids) if (typeof id === 'string' && id.length > 0) known.add(id)
  }
  if (typeof held.byId === 'object' && held.byId !== null) {
    for (const id of Object.keys(held.byId)) if (id.length > 0) known.add(id)
  }
  return known
}
