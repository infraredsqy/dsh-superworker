/* The formatting segment: invariants only — which unit a duration is said in, which day a moment
 * fell on, and what is given when there is no such moment. The model measures; the words are the
 * client's.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { clock, dayParts, elapsedParts, two } from '../src/model/format.ts'

test('with no such moment, give the "none" shape, never 0', () => {
  const at = new Date('2026-03-10T12:00:00.000Z')

  assert.equal(clock(null), '--')
  assert.equal(elapsedParts(null), null)
  assert.equal(dayParts(null, at), null)
})

test('a span is said by the unit a reader would use: seconds / minutes / hours', () => {
  assert.deepEqual(elapsedParts(0), { unit: 'seconds', value: 0, rest: 0 }, 'exactly zero seconds is a real reading')
  assert.deepEqual(elapsedParts(45), { unit: 'seconds', value: 45, rest: 0 })
  assert.deepEqual(elapsedParts(60), { unit: 'minutes', value: 1, rest: 0 })
  assert.deepEqual(elapsedParts(3600), { unit: 'hours', value: 1, rest: 0 })
  assert.deepEqual(elapsedParts(8040), { unit: 'hours', value: 2, rest: 14 }, 'the whole minutes left in the hour come with it')
  assert.equal(elapsedParts(-5), null, 'that moment has not arrived: no span, and no negative one either')
})

test('a span is floored, never rounded up: a window may not claim a minute it has not run', () => {
  assert.deepEqual(elapsedParts(119), { unit: 'minutes', value: 1, rest: 59 }, 'two minutes short of the rounding line')
  assert.deepEqual(elapsedParts(3599), { unit: 'minutes', value: 59, rest: 59 })
  assert.deepEqual(elapsedParts(7259), { unit: 'hours', value: 2, rest: 0 }, 'the hours do not come up a minute early')
  assert.deepEqual(elapsedParts(750.9), { unit: 'minutes', value: 12, rest: 30 }, 'a fraction of a second is dropped, not carried')
})

test('the clock reads local time', () => {
  assert.equal(clock(new Date(2026, 2, 10, 9, 5)), '09:05')
  assert.equal(two(7), '07')
  assert.equal(two(31), '31')
})

test('the day is counted from the moment read', () => {
  const at = new Date(2026, 2, 10, 12, 0)

  assert.deepEqual(dayParts(new Date(2026, 2, 10, 9, 0), at), { unit: 'today' })
  assert.deepEqual(dayParts(new Date(2026, 2, 9, 23, 0), at), { unit: 'yesterday' }, 'counted by calendar day, not by 24 hours')
  assert.deepEqual(dayParts(new Date(2026, 2, 8, 23, 0), at), { unit: 'before-yesterday' })
  assert.deepEqual(dayParts(new Date(2026, 2, 1, 0, 0), at), { unit: 'date', month: 3, day: 1 }, 'further back gives month and day, no year')
})

test('a narrowed exit: the removed spellings are gone from both entry and module, and module-only helpers stay off the entry', async () => {
  const entry = await import('../src/model/index.ts')
  const format = await import('../src/model/format.ts')

  assert.equal(entry.ago, undefined)
  assert.equal(entry.durationLong, undefined)
  assert.equal(entry.elapsedSince, undefined, 'a compact spelling nobody reads stays off the entry')
  assert.equal(entry.agoParts, undefined, 'a relative time nobody reads stays off the entry')
  assert.equal(entry.duration, undefined, 'the compact spelling is gone: one span is said one way, and the client says it')
  assert.equal(entry.durationParts, undefined, 'the rounded measurement went with it')
  assert.equal(entry.two, undefined)
  assert.equal(entry.dayLabel, undefined)
  assert.equal(Object.hasOwn(format, 'ago'), false, 'the old spelling is gone entirely, not tucked into the module')
  assert.equal(Object.hasOwn(format, 'durationLong'), false)
  assert.equal(Object.hasOwn(format, 'elapsedSince'), false, 'removed outright: no copy left in the module either')
  assert.equal(Object.hasOwn(format, 'agoParts'), false)
  assert.equal(Object.hasOwn(format, 'dayLabel'), false)
  assert.equal(Object.hasOwn(format, 'durationParts'), false, 'the rounded measurement left no copy in the module either')
  assert.equal(typeof format.two, 'function', 'two-digit padding is module-local, off the entry')
  assert.equal(typeof entry.elapsedParts, 'function', 'what the panel really uses still comes from the entry')
  assert.equal(typeof entry.dayParts, 'function', 'what the panel really uses still comes from the entry')
})
