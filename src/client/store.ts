/**
 * The one external-store skeleton the panel's ports stand on: a subscriber set, a snapshot that only
 * changes identity when it truly changed, a notification that carries one subscriber's throw no
 * further, and the count of who is watching right now.
 *
 * Three ports need exactly this (the preferences, the language, and the workspace list's forwarding)
 * and each of them only differs in what it derives from its upstream. Writing the skeleton once is
 * what keeps "subscribe, put, notify" from being three slightly different behaviours: a listener
 * that throws must not silence the next one in any of them, and `useSyncExternalStore` redraws
 * forever if any of them fabricates a fresh snapshot on every read.
 *
 * This is a skeleton, not a policy: when two readings say the same thing is the caller's judgment,
 * handed in as `same`.
 */

/** One store's face: what a component reads and subscribes to, plus the one move its port owns. */
export interface Store<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  /** Replace the snapshot and tell everyone standing, but only when `same` says it truly changed. */
  put(next: T): void
  /** How many subscribers stand now: an upstream join is only worth taking while someone watches. */
  readonly watching: number
}

/**
 * Build one store.
 * @param initial - The reading before anything attached.
 * @param same - Whether two snapshots say the same thing; `Object.is` when absent.
 */
export function createStore<T>(initial: T, same: (left: T, right: T) => boolean = Object.is): Store<T> {
  const listeners = new Set<() => void>()
  let snapshot = initial

  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        /* One subscriber failing must not take the others down with it. */
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    put(next) {
      if (same(snapshot, next)) return
      snapshot = next
      announce()
    },
    get watching() {
      return listeners.size
    },
  }
}
