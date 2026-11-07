/* The one wait the host-side tests share, and what each of its two shapes can and cannot say.
 *
 * The host's trigger road is fire-and-forget: the event bus hands a listener no promise, so nothing
 * can await "that round has been judged". What is left is a bounded yield loop, and its two uses
 * read differently:
 *
 * - {@link until} waits for a fact to become true. A fact that shows up is proven by the wait; the
 *   bound only decides when to give up.
 * - {@link drainFor} is the negative one: nothing should happen, so the loop yields for a stretch
 *   and then the case asserts "still nothing". This **only disproves**: it says the trigger had not
 *   done it by the time the bound ran out, never that it will not. The bound is the honest size of
 *   the work it is waiting on (a plan read is a handful of small file reads), not a proof.
 */

/** How long a negative wait runs, in milliseconds: the cheap plan read the trigger does behind the scenes. */
export const DRAIN_MS = 500

/** How long a positive wait may take before the case gives up, in milliseconds. */
export const WAIT_MS = 2000

/** Yield to the event loop once: pending IO callbacks run, and the loop turns over. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Wait until the fact holds, yielding to the event loop between looks; the wait is bounded by wall
 * clock, because the trigger is fire-and-forget and its work crosses real file IO. `notes` is
 * whatever reading makes a timeout call out its own cause (the relay's warnings, say).
 */
export async function until(check, what, notes = []) {
  const started = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`did not arrive: ${what}${notes.length > 0 ? `; reading: ${JSON.stringify(notes)}` : ''}`)
    }
    await turn()
  }
}

/**
 * The negative wait: drain the loop for a wall-clock stretch before a "still nothing" assert. A
 * fire-and-forget trigger has no completion event to await; this is that wait, stated honestly —
 * it can only ever disprove.
 */
export async function drainFor(ms = DRAIN_MS) {
  const started = Date.now()
  while (Date.now() - started < ms) await turn()
}

/**
 * Let the queued stretches schedule before judging: two turns of the loop, one macrotask each. The
 * opener's cases need it because a queued open resolves its root (a real `realpath`) before it
 * creates. This is a settle, not a wait: it asserts nothing.
 */
export async function flush() {
  await turn()
  await turn()
}
