/* The DSH-facing stand-ins three fixtures share: the settings document the panel's preferences ride
 * on, the locale service the words ride on, and the slot roster a boot registers onto. One copy of
 * each; what one caller needs beyond the common face stays at the caller as an opt-in — the unit
 * tests sometimes measure a face deliberately less than the real thing, and "less" is not unified
 * away here.
 */

/**
 * A settings document, shaped like what `configForms` hands out: the document, a ready snapshot
 * with its revision, a subscriber list the writes walk, and the revision-mismatch refusal — the
 * same contract as the real controller.
 *
 * `base` / `user` ride along `undefined`: the real snapshot carries them, and the reader treats
 * absent and undefined alike; a fixture measuring THEM stands its own face up.
 *
 * @param watchCount - adds `watching()`: the subscriber count, so "was the disposer returned" is
 *   judged by count alone (the render check's need).
 * @param writeLog - adds `writes` (every `mutate` recorded), `notify()` (wake subscribers without
 *   touching a byte — the "unchanged means no notification" path) and `bump()` (someone else moved
 *   the revision before this side read — the stale-fence path). The client-prefs tests' need.
 * @param deferred - the write is a real round trip: `mutate` returns a promise that stands pending
 *   until `land()` serves it, and the fence is judged when it is served, not when it is issued. That
 *   is the ordering a case needs when it judges what the panel does *while* a write is in flight —
 *   the panel's own echo of an earlier view landing after the reader has already picked a newer one
 *   (the view-flash case). `land()` answers queued writes in issue order, all of them unless a
 *   count is handed in, and `queued()` says how many stand unanswered now.
 */
export function fakeSettingsForm(initial, { watchCount = false, writeLog = false, deferred = false } = {}) {
  let value = { ...initial }
  let revision = 1
  let refuse = false
  const listeners = new Set()
  const writes = []
  const waiting = []
  /** Serve one write the way the settings service would: judge the fence, apply, bump, tell everyone. */
  const serve = (ops, expected) => {
    if (refuse || (expected !== undefined && expected !== revision)) return false
    for (const op of ops) if (op.op === 'set') value = { ...value, [op.path[0]]: op.value }
    revision += 1
    for (const listener of [...listeners]) listener()
    return true
  }
  const form = {
    document: () => value,
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: undefined, revision, writable: true }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate(ops, expected) {
      if (writeLog) writes.push({ ops, expected })
      if (!deferred) return Promise.resolve(serve(ops, expected))
      return new Promise((resolve) => { waiting.push({ ops, expected, resolve }) })
    },
    /* This document refuses all writes: it backs the "no silence when both writes are voided" rule. */
    refuse: (on = true) => { refuse = on },
  }
  if (watchCount) form.watching = () => listeners.size
  if (writeLog) {
    form.writes = writes
    form.notify = () => { for (const listener of [...listeners]) listener() }
    form.bump = () => { revision += 1 }
  }
  if (deferred) {
    form.queued = () => waiting.length
    form.land = (count = waiting.length) => {
      let landed = 0
      for (; landed < count; landed += 1) {
        const next = waiting.shift()
        if (next === undefined) break
        next.resolve(serve(next.ops, next.expected))
      }
      return landed
    }
  }
  return form
}

/**
 * A stand-in for DSH's locale service, shaped like the interface `src/client/locale.ts` binds to:
 * lookup tables registered per namespace (the same namespace+locale registered twice throws), a
 * translator bound per namespace, a snapshot saying which language is active, and a subscriber
 * list the language switch walks.
 *
 * The bound translator resolves against the language active at call time, which is exactly what
 * the port relies on: one bound reference serves every language.
 *
 * @param initial - the language active at birth; the deployment's own default is `zh`.
 */
export function fakeLocaleService(initial = 'zh') {
  const dicts = new Map()
  const listeners = new Set()
  let active = initial
  let revision = 0
  const nsOf = (ns) => { if (!dicts.has(ns)) dicts.set(ns, new Map()); return dicts.get(ns) }
  return {
    register(ns, locale, dict) {
      const held = nsOf(ns)
      if (held.has(locale)) throw new Error(`namespace ${ns} already has ${locale}`)
      held.set(locale, dict)
    },
    bind(ns) {
      return (key, params) => {
        const raw = nsOf(ns).get(active)?.[key] ?? key
        return params === undefined ? raw
          : raw.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot() { return { active, revision } },
    getLocale() { return { active, revision } },
    /* Flip the language the way DSH's own service does: change the fact, then tell subscribers. */
    switchTo(next) { active = next; revision += 1; for (const listener of [...listeners]) listener() },
  }
}

/**
 * The slot roster a boot registers onto, written to the real protocol: single-seat and list slots
 * match by `id`, the keyed slot by `key`, and registering the same identity twice throws — exactly
 * the accident to avoid. What the surrounding context wires (services, effects) stays with the
 * caller; a resumption (profile reload, HMR, the double-boot pass) passes its existing `ledger`
 * and `calls` back in so idempotency lands on the same roster.
 */
export function fakeSlotRoster({ ledger = new Map(), calls = [] } = {}) {
  return {
    ledger,
    calls,
    slots: {
      inject(key, register) {
        calls.push(`inject/${key}`)
        const off = register()
        return typeof off === 'function' ? off : () => undefined
      },
      register(options, component) {
        const id = `${options.name}:${options.id ?? options.key}`
        calls.push(`register/${id}`)
        if (ledger.has(id)) throw new Error(`list slot "${options.name}" already has an entry with id "${String(options.id ?? options.key)}"`)
        ledger.set(id, { options, component })
        return () => { ledger.delete(id) }
      },
    },
  }
}
