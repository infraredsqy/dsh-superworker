/* The formatting segment: invariants only — which unit a duration falls in, which day a moment
 * fell on, and what is given when there is no such moment. The model measures; the words are the
 * client's.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { clock, dayParts, duration, durationParts, two } from '../src/model/format.ts'

test('with no such moment, give the "none" shape, never 0', () => {
  const at = new Date('2026-03-10T12:00:00.000Z')

  assert.equal(clock(null), '--')
  assert.equal(duration(null), '--')
  assert.equal(durationParts(null), null)
  assert.equal(dayParts(null, at), null)
})

test('duration written by unit: seconds / minutes / hours', () => {
  assert.equal(duration(0), '0s', 'exactly zero seconds is a real reading')
  assert.equal(duration(59), '59s')
  assert.equal(duration(60), '1m')
  assert.equal(duration(3600), '1h')
  assert.equal(duration(3700), '1h02')
  assert.equal(duration(-5), '--', 'that moment has not arrived: no duration, and no negative one either')
})

test('the long duration spelling', () => {
  assert.deepEqual(durationParts(45), { unit: 'seconds', value: 45, rest: 0 })
  assert.deepEqual(durationParts(300), { unit: 'minutes', value: 5, rest: 0 })
  assert.deepEqual(durationParts(3600), { unit: 'hours', value: 1, rest: 0 })
  assert.deepEqual(durationParts(8040), { unit: 'hours', value: 2, rest: 14 }, 'the whole minutes left in the hour come with it')
  assert.equal(durationParts(-5), null, 'that moment has not arrived: no duration kind, and no negative one either')
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
  assert.equal(entry.two, undefined)
  assert.equal(entry.dayLabel, undefined)
  assert.equal(Object.hasOwn(format, 'ago'), false, 'the old spelling is gone entirely, not tucked into the module')
  assert.equal(Object.hasOwn(format, 'durationLong'), false)
  assert.equal(Object.hasOwn(format, 'elapsedSince'), false, 'removed outright: no copy left in the module either')
  assert.equal(Object.hasOwn(format, 'agoParts'), false)
  assert.equal(Object.hasOwn(format, 'dayLabel'), false)
  assert.equal(typeof format.two, 'function', 'two-digit padding is module-local, off the entry')
  assert.equal(typeof entry.duration, 'function', 'what the panel really uses still comes from the entry')
  assert.equal(typeof entry.dayParts, 'function', 'what the panel really uses still comes from the entry')
  assert.equal(typeof entry.durationParts, 'function', 'the long spelling is known only to this module and the tests, not counted as panel use')
})
