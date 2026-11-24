/**
 * The session hook the main seat hands the panel, bridged for the settings page.
 *
 * The settings page is drawn in DSH's own settings tree, where no slot hands a `useSessions` hook
 * over; the panel's own mount is the one place DSH gives it. The latest hook is kept here, and the
 * settings page's machine-layer row reads the current session from it — the one workspace it may
 * borrow, because the engine answers settings verbs only where a record directory stands. A page
 * load that has never opened the panel reads no session, and the row says so rather than guessing.
 */
let bridged: unknown = undefined

/** Keep the latest session hook the seat handed the panel; a non-function is not a hook and is ignored. */
export function bridgeSessions(useSessions: unknown): void {
  if (typeof useSessions === 'function') bridged = useSessions
}

/** The latest bridged hook, or nothing: the same shape the seat's own prop carries. */
export function bridgedSessions(): unknown {
  return bridged
}
