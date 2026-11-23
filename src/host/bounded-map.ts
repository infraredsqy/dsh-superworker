/**
 * A map whose entries stay bounded: past the explicit cap, the least recently
 * used entries give way — except the ones a tenant is holding.
 *
 * Two tenants in this half keep per-root state for the process's whole life —
 * the opener's per-workspace queues (`executor.ts`) and the injection's
 * carried listings (`instruction-context.ts`) — and a long-lived fork-mode
 * host keeps meeting new worktree roots: without a bound those tables only
 * ever grow. Both take this one mechanism, so the bound is stated once here.
 * A hit refreshes its recency, an insert past the cap gives the oldest entry
 * away, and the cap is generous enough that it never bites a real deployment —
 * it exists so the growth has an end, not to manage the working set.
 *
 * A tenant with work still in flight holds the entry that work sits behind:
 * eviction skips held entries and takes the next oldest unheld one, and when
 * every seat is held the table may sit past its cap until a hold comes off.
 * That overshoot is the semantics, not a leak — a hold stands for work still
 * running, and the one thing the cap must never do is throw a running line's
 * seat away. Holds are counted: one `pin` is one hold, and the entry stays
 * unevictable until its last hold is released, so two opens queued on one
 * root hold it twice and neither release strands the other's line.
 */

/** The one cap both per-root tenants share: workspaces holding an open line, and (root, session) listings — a count no real host crosses. */
export const PER_ROOT_STATE_CAP = 128

/** A map that keeps at most `cap` entries, evicting the least recently used — never one a tenant still holds. */
export class BoundedMap<K, V> {
  readonly #cap: number
  readonly #entries = new Map<K, V>()
  /** One hold per `pin`: the key stays unevictable until every hold is released. */
  readonly #holds = new Map<K, number>()

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`the cap must be a positive integer, got ${cap}`)
    this.#cap = cap
  }

  /** How many entries the table holds right now; past the cap only while holds keep it there or for the stretch of one insert. */
  get size(): number {
    return this.#entries.size
  }

  /**
   * Read one entry. A hit is a use: the entry moves to the freshest seat, so
   * one the process keeps asking for is never the one that gives way.
   */
  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined
    const value = this.#entries.get(key) as V
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  /**
   * Write one entry; if the table grew past the cap, the oldest seat gives
   * way — the oldest *unheld* seat other than the one just written: a held
   * entry is skipped, the insert never evicts itself, and when every older
   * seat is held nothing gives way and the table stays past the cap until a
   * hold comes off.
   */
  set(key: K, value: V): this {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.#cap) {
      let oldest: K | undefined
      for (const seat of this.#entries.keys()) {
        if (seat !== key && !this.#holds.has(seat)) {
          oldest = seat
          break
        }
      }
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return this
  }

  /**
   * Hold one entry against eviction while the work it stands for is still in
   * flight. Holds are counted: two holds need two releases, so two opens
   * queued on one root hold it twice and neither release strands the other's
   * line. A hold on a key that is not seated has nothing to protect; it takes
   * effect only if that key is written again.
   */
  pin(key: K): void {
    this.#holds.set(key, (this.#holds.get(key) ?? 0) + 1)
  }

  /**
   * Release one hold; the entry is evictable again once its last hold is
   * gone. Releasing a key with no hold outstanding is a no-op.
   */
  unpin(key: K): void {
    const holds = this.#holds.get(key)
    if (holds === undefined) return
    if (holds <= 1) this.#holds.delete(key)
    else this.#holds.set(key, holds - 1)
  }

  /**
   * Drop one entry explicitly — eviction aside, the same power a plain map
   * has. The entry's holds lapse with it: a hold protects this entry, never
   * the seat's next tenant.
   */
  delete(key: K): boolean {
    this.#holds.delete(key)
    return this.#entries.delete(key)
  }
}
