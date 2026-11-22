/* The issue pane's weight gauge: when it is drawn at all, and with which two numbers.
 *
 * The rule is the spec's: a table that could not be obtained draws nothing, and a fake number never
 * stands in for one. What is locked here is that judgment (`gaugeOf`) — a fact about the reading, not
 * about the layout, so it needs no DOM and no built bundle. The drawing (slot widths, fills, the
 * line's own position) is the hand pass's, not this file's.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { gaugeOf } from '../src/client/pool-gauge.ts'
import { SEVERITY_WEIGHTS } from '../packages/superworker-core/plugins/issue/tools/storage.mjs'

/** A pool segment with only the fields the gauge's judgment reads. */
function pool({ weights, line, weight, rows = [] }) {
  return { weights, line, weight, rows, groups: [], standing: [], census: {} }
}

/* The table is the plugin's own constant, never re-spelled here: a test that wrote the numbers down
 * would be the second copy this change exists to remove (`pool-weights-one-home.test.mjs`). */
const WEIGHTS = { ...SEVERITY_WEIGHTS }

test('a table and a line both obtained: the gauge draws that line and that sum, as read', () => {
  assert.deepEqual(gaugeOf(pool({ weights: WEIGHTS, line: 40, weight: 17 })), { line: 40, total: 17 })
  assert.deepEqual(gaugeOf(pool({ weights: WEIGHTS, line: 0, weight: 0 })), { line: 0, total: 0 }, 'both really 0 is a reading, not an absence')
})

test('no weight table: the gauge is not drawn, and 0 does not stand in for the table', () => {
  assert.equal(gaugeOf(pool({ weights: null, line: 40, weight: null })), null)
  assert.equal(gaugeOf(pool({ weights: null, line: 40, weight: 0 })), null, 'the table is the thing that is missing: a sum alone does not rescue it')
})

test('no policy line: the gauge is not drawn — there is nothing to frame the pool against', () => {
  assert.equal(gaugeOf(pool({ weights: WEIGHTS, line: null, weight: 17 })), null)
})

test('a sum that could not be computed: the gauge is not drawn, even with the table and line in hand', () => {
  assert.equal(gaugeOf(pool({ weights: WEIGHTS, line: 40, weight: null })), null)
})
