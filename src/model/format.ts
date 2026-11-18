/**
 * How a moment and a span are measured.
 *
 * This module measures; it does not speak. A span's wording differs per language, so what is given
 * here is the *shape* of a duration — which unit it falls in, how many of that unit — and the client
 * says it. The only spellings that stay here are the ones that read the same in every language:
 * digits and the `--` that marks an absent value.
 *
 * When the moment is absent, an "absent" shape is given (`null`, or `--`) rather than a `0` that
 * reads as "exactly zero". Everything is based on the moment the caller provides; this module never
 * takes the current time itself. A span is measured between the two moments handed in — "how long ago
 * was it" is not a shape given here, because nothing on the panel asks it.
 */
export function two(n: number): string {
  return (n < 10 ? '0' : '') + String(n)
}

export function clock(moment: Date | null): string {
  return moment ? `${two(moment.getHours())}:${two(moment.getMinutes())}` : '--'
}

/** Which unit a span is said in, how many of it, and how much of the smaller unit is left over. */
export interface ElapsedParts {
  readonly unit: 'seconds' | 'minutes' | 'hours'
  /** Whole units the span is said in. */
  readonly value: number
  /** Whole minutes left past the hours, or whole seconds left past the minutes; `0` in the seconds unit. */
  readonly rest: number
}

/**
 * The unit a span is said in: under a minute goes to seconds, a whole minute but under an hour to
 * minutes and the seconds left past them, beyond that to hours and the minutes left past them.
 * Floored, never rounded — a window saying how long it has run may not claim a minute it has not run
 * yet. No span — or a moment not yet reached — has no unit at all.
 */
export function elapsedParts(seconds: number | null): ElapsedParts | null {
  if (seconds === null || seconds < 0) return null
  const whole = Math.floor(seconds)
  if (whole < 60) return { unit: 'seconds', value: whole, rest: 0 }
  if (whole < 3600) return { unit: 'minutes', value: Math.floor(whole / 60), rest: whole % 60 }
  return { unit: 'hours', value: Math.floor(whole / 3600), rest: Math.floor((whole % 3600) / 60) }
}

/**
 * Which day a moment fell on: today, yesterday, the day before, or a calendar date.
 *
 * One member per arm rather than a shared `'today' | 'yesterday' | 'before-yesterday'` literal: the
 * three relative days carry nothing and the calendar day carries a month and a day, and a
 * discriminant that is itself a union of three does not narrow to the other arm once its members
 * have been excluded — the reader would then be looking for a month on "today".
 */
export type DayParts =
  | { readonly unit: 'today' }
  | { readonly unit: 'yesterday' }
  | { readonly unit: 'before-yesterday' }
  | { readonly unit: 'date'; readonly month: number; readonly day: number }

/** The day that moment fell on, measured against the caller's own moment; `null` when there is none. */
export function dayParts(moment: Date | null, at: Date): DayParts | null {
  if (moment === null) return null
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  const then = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate())
  const diff = Math.round((today.getTime() - then.getTime()) / 86400000)
  if (diff === 0) return { unit: 'today' }
  if (diff === 1) return { unit: 'yesterday' }
  if (diff === 2) return { unit: 'before-yesterday' }
  return { unit: 'date', month: moment.getMonth() + 1, day: moment.getDate() }
}