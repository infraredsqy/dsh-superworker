/**
 * Whether the issue pool's weight gauge is drawn at all, and with which two numbers.
 *
 * The gauge frames a pile's weighted sum against a policy line, so it needs both numbers to be real:
 * the table the cases were weighed by, and the line somebody set. A reading that has no table — or no
 * line — draws nothing, because the alternative is a scale whose every slot is a `0` nobody wrote.
 * That judgment lives here rather than inside the pane's JSX so it can be held to without mounting a
 * DOM: what it answers is a fact about the reading, not a fact about the layout.
 *
 * `weights === null` is the whole "no table" reading: the model makes it `null` exactly when the
 * table was not obtained, and every case's own weight is `null` on the same terms (see
 * `src/model/pool.ts`). A table that was obtained and names no such tier is not this case — that
 * tier weighs `0`, the table did speak.
 */
import type { PoolReading } from '../model/index.ts'

/** What the gauge draws: the two numbers, already judged to be real. */
export interface GaugeReading {
  /** The policy line the pile is read against. */
  readonly line: number
  /** The still-owed pile's weighted sum. */
  readonly total: number
}

/**
 * The gauge's reading, or `null` when it is not drawn.
 *
 * @param pool - The pool segment of the reading.
 * @returns The line and total when both are real, else `null`.
 */
export function gaugeOf(pool: PoolReading): GaugeReading | null {
  if (pool.weights === null) return null
  if (pool.line === null) return null
  if (pool.weight === null) return null
  return { line: pool.line, total: pool.weight }
}
