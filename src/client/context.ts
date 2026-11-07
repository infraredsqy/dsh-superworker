/**
 * Assembly helpers shared by the three entry points (the plugin entry, the settings section, and
 * the two dispatch-center spots): the handful of methods reachable on the DSH plugin context, the
 * warning emitted when assembly goes wrong, and the boilerplate for "mount once the service arrives".
 *
 * Services are awaited with dynamic `ctx.inject([...])`: slots are declared by others at runtime,
 * and registering into an undeclared slot throws at load time. When unreachable, quietly do nothing
 * — this layer never breaks the plugin's `apply`; every throw inside `wire` is contained in its own
 * layer and leaves only a traceable record.
 */

/** The methods this layer needs from the plugin context. */
export interface ClientContext {
  inject?: (names: readonly string[], callback: (owner: unknown) => void) => unknown
}

/** Slots service: the gateway for registering into slots declared by others. */
export interface SlotsService {
  inject?: (key: string, register: () => unknown) => unknown
  register?: (options: unknown, component: unknown) => unknown
}

/** Context with unmount notification: real Cordis contexts carry `effect`; stand-in contexts do not. */
export interface EffectOwner {
  effect?: (run: () => () => void, name?: string) => unknown
}

/** One warning; an assembly failure must not stay silent. */
export function report(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  // eslint-disable-next-line no-console -- assembly failures must leave a traceable record
  console.warn(`dsh-superworker: ${what}：${message}`)
}

/**
 * Wait for the given names to arrive, then hand what arrived to `wire`.
 *
 * `what` is the name this assembly path calls itself: throws inside `wire` and throws from `inject`
 * itself are both reported under it.
 * @param ctx - The browser-half plugin context.
 * @param wire - How to wire up once services arrive; its throws do not escape.
 */
export function injectAt(ctx: unknown, names: readonly string[], what: string, wire: (owner: unknown) => void): void {
  const holder = ctx as ClientContext | null | undefined
  if (holder === null || holder === undefined || typeof holder.inject !== 'function') return
  try {
    holder.inject(names, (owner) => {
      try {
        wire(owner)
      } catch (error) {
        report(what, error)
      }
    })
  } catch (error) {
    report(what, error)
  }
}

/**
 * Hang the same registration on the owner's own `effect`: mount it when present (cleanup runs on
 * unmount), run it inline otherwise — a context without `effect` has no one managing unmount for
 * it, and the cleanup would have nowhere to go.
 */
export function serveOn(owner: unknown, serve: () => () => void, name: string): void {
  const effect = (owner as EffectOwner).effect
  if (typeof effect === 'function') effect.call(owner, serve, name)
  else serve()
}
