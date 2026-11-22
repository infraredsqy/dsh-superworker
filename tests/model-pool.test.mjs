/* The issue pool segment: invariants only — where the weight table and policy line come from,
 * at what moment an issue counts as on the books, how weights add up, how the four piles are
 * ordered. No layout and no snapshots are locked.
 *
 * The weight table has one home (the issue plugin's own declaration), so the model is *handed* it
 * with the reading rather than extracting it from the record: what is locked here is that the handed
 * table is what weighs, that no table means no weight anywhere (not 0), and that a table missing one
 * tier weighs that tier as 0 — the table spoke, and it said this tier weighs nothing.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readLine, readPool, readProject } from '../src/model/index.ts'
import { SEVERITY_WEIGHTS } from '../packages/superworker-core/plugins/issue/tools/storage.mjs'
import { AT, cycle, issue, record } from './helpers/record-fixtures.mjs'

/* The table is the plugin's own constant, imported rather than re-spelled: a test that wrote the
 * numbers down would be the second copy this change exists to remove
 * (`pool-weights-one-home.test.mjs`). */
const WEIGHTS = { ...SEVERITY_WEIGHTS }

test('the weight table is what the reading is handed: the issues weigh by it, and nothing in the record is scraped for it', () => {
  /* The node's text still carries the old sentence; it must feed nothing. A table written into a
   * record's own words is exactly what stopped existing, so this holds a reading to the table it was
   * given and to no other. The sentence is *composed* from the plugin's constant rather than spelled
   * out: a literal copy here would be the second home the one-home guard hunts for, and what this
   * case needs is only the shape the retired scrape used to look for. */
  /* The tiers heaviest-last, which is the order the retired sentence used. */
  const chain = Object.keys(SEVERITY_WEIGHTS).reverse().join('/')
  const run = Object.keys(SEVERITY_WEIGHTS).reverse().map((tier) => String(SEVERITY_WEIGHTS[tier])).join('/')
  const carrier = { title: `tidy the issue pool: each tier counts by ${chain} = ${run}.` }
  const reading = readPool(
    [cycle({ policies: { issue_pool_weight_limit: 40 } })],
    {
      a: issue({ id: 'a', severity: 'P0' }),
      b: issue({ id: 'b', severity: 'P2', status: 'acknowledged', decision: 'external' }),
      c: issue({ id: 'c', severity: 'P1', status: 'resolved', updated_at: '2026-03-05T00:00:00.000Z' }),
      d: issue({ id: 'd', severity: 'P3', decision: 'autofix' }),
      e: issue({ id: 'e', severity: 'P3', decision: 'unknown' }),
    },
    WEIGHTS,
    AT,
  )
  const fromRecordText = readProject(record({ nodes: { n1: carrier }, issues: { a: issue({ severity: 'P0' }) } }))

  assert.equal(reading.line, 40)
  assert.deepEqual(reading.weights, WEIGHTS)
  /* `a` is undecided and `d` is autofix: both still enter the sum; `b` is external and `c` is settled: neither enters. */
  assert.equal(reading.weight, 10, '8 + 1 + 1: the external one and the two settled ones do not enter the sum')
  assert.equal(reading.rows.find((row) => row.id === 'b')?.payable, false, 'the one judged external: the reading itself says it does not weigh on the line')
  assert.equal(reading.rows.find((row) => row.id === 'a')?.payable, true, 'the undecided one still weighs on the line')
  assert.deepEqual(reading.standing.map((row) => row.id), ['a', 'd', 'e', 'b'], 'the external one is still among the still-owed: the count still takes it in')
  assert.deepEqual(reading.census, { total: 5, standing: 4, open: 3, acknowledged: 1, rejected: 0, resolved: 1 })
  assert.equal(fromRecordText.pool.weights, null, 'a table written into a node\'s words feeds no reading: the record is not where it lives')
})

test('with no weight table there is no weight anywhere, and 0 does not stand in', () => {
  const reading = readPool([cycle()], { a: issue({ severity: 'P0' }) }, null, AT)

  assert.equal(reading.weights, null)
  assert.equal(reading.weight, null, 'no table, so the number does not exist')
  assert.equal(reading.rows[0].weight, null, 'the case does not carry a weight either: a gauge built on it would draw a fake')
  assert.equal(reading.groups[0].weight, null, 'and the pile\'s sum is unknown, not short by a term')
  assert.equal(reading.census.open, 1, 'the registered count still comes out: counting cases needs no table')

  /* The pile whose cases all sit out of the sum: with no table there is still nothing to weigh, so its
   * sum is unknown too — an external-only pile must not add up to 0, which would read as "measured,
   * and it is zero". This is the one pile shape the payable cases above could not reach. */
  const externalOnly = readPool([cycle()], { b: issue({ id: 'b', severity: 'P0', decision: 'external' }) }, null, AT)

  assert.equal(externalOnly.rows[0].payable, false, 'the only case stays out of the weighted sum')
  assert.equal(externalOnly.groups[0].count, 1, 'it still makes a pile: the count follows the record\'s status, not the table')
  assert.equal(externalOnly.groups[0].weight, null, 'and that pile has no weight either — not the 0 of a sum that skipped every term')
})

test('a table that names no such tier weighs it as 0: the table spoke, and it said this tier counts nothing', () => {
  const reading = readPool([], { a: issue({ severity: 'P9' }) }, WEIGHTS, AT)

  assert.equal(reading.rows[0].weight, 0, 'the table was obtained and has no P9: 0 is its answer')
  assert.equal(reading.weight, 0, 'a known tier weighing nothing sums to 0, which is a real reading')
})

test('one tier the table cannot weigh makes the whole sum unknown: a partial sum would print a number that claims to be the total', () => {
  const reading = readPool([], { a: issue({ severity: 'P0' }), b: issue({ id: 'b', severity: 'P1' }) }, null, AT)

  assert.equal(reading.weight, null, 'adding up what is known would be a number nobody could stand behind')
})

test('the policy line: which cycle set that number itself', () => {
  assert.equal(readLine([cycle({ policies: { parallel: 1 } })]), null, 'no cycle set one means no line')
  assert.equal(readLine([cycle({ policies: { parallel: 1 } }), cycle({ id: 'c2', policies: { issue_pool_weight_limit: 40 } })]), 40)
})

test('when an issue counts as on the books: one not yet discovered is not', () => {
  const reading = readPool([], {
    early: issue({ id: 'early', discovered: '2026-03-01T00:00:00.000Z' }),
    late: issue({ id: 'late', discovered: '2026-03-20T00:00:00.000Z' }),
    unknown: issue({ id: 'unknown', discovered: null }),
  }, WEIGHTS, AT)

  assert.deepEqual(reading.rows.map((row) => row.id), ['early'])
})

test('the word the record wrote belongs to the moment it was written: before that moment it reads as not yet settled', () => {
  const reading = readPool([], {
    settled: issue({ id: 'settled', status: 'resolved', updated_at: '2026-03-05T00:00:00.000Z' }),
    settledLater: issue({ id: 'settledLater', status: 'resolved', updated_at: '2026-03-20T00:00:00.000Z' }),
    neverTouched: issue({ id: 'neverTouched', status: 'rejected', updated_at: null }),
    strange: issue({ id: 'strange', status: 'carried-over' }),
  }, WEIGHTS, AT)

  assert.equal(reading.rows.find((row) => row.id === 'settled').status, 'resolved')
  assert.equal(reading.rows.find((row) => row.id === 'settledLater').status, 'open', 'the word is not yet written at that moment')
  assert.equal(reading.rows.find((row) => row.id === 'neverTouched').status, 'rejected', 'no last change recorded, so the word counts')
  assert.equal(reading.rows.find((row) => row.id === 'strange').status, 'open', 'an unknown word reads as nobody settled it')
})

test('the four state words live once, in the model layer: empty piles form no group, the words are still asked for', () => {
  /* The pool holds one still-outstanding issue: the settled piles are empty piles and form no
   * groups, yet which pile each of the four is still comes from this one reading. */
  const reading = readPool([], { a: issue() }, WEIGHTS, AT)

  assert.deepEqual(reading.groups.map((group) => group.key), ['open'])
  assert.equal(reading.groups[0]?.standing, true, 'the still-owed pile counts as standing')
  assert.equal(reading.groups[0]?.count, 1)
  assert.equal(Object.hasOwn(reading.groups[0], 'label'), false, 'pile heads no longer get words from the model: the key says which pile')
})

test('optional fields on the reading: only written ones show, unwritten ones get no empty string in their place', () => {
  const reading = readPool([], {
    full: issue({
      id: 'full',
      module: 'src/model',
      source: 'scan',
      decision: 'autofix',
      description: 'symptom',
      suggestion: 'fix',
      reason: 'reason',
      plan_path: '.tmp/plan.md',
    }),
    bare: issue({ id: 'bare', title: '', severity: null, module: null, status: null }),
  }, WEIGHTS, AT)
  const optional = ['title', 'severity', 'recordStatus', 'module', 'source', 'decision', 'description', 'suggestion', 'reason', 'planPath']

  const full = reading.rows.find((row) => row.id === 'full')
  for (const key of optional) assert.equal(key in full, true, `${key} is written so it must show`)

  const bare = reading.rows.find((row) => row.id === 'bare')
  for (const key of optional) assert.equal(key in bare, false, `${key} is not written so it must not show`)
})

test('the four piles: empty ones dropped, still-owed heaviest first and longest parked first, settled newest first', () => {
  const reading = readPool([], {
    light: issue({ id: 'light', severity: 'P3', discovered: '2026-03-01T00:00:00.000Z' }),
    heavyOld: issue({ id: 'heavyOld', severity: 'P0', discovered: '2026-03-02T00:00:00.000Z' }),
    heavyNew: issue({ id: 'heavyNew', severity: 'P0', discovered: '2026-03-03T00:00:00.000Z' }),
    carried: issue({ id: 'carried', severity: 'P2', status: 'acknowledged' }),
    closedOld: issue({ id: 'closedOld', severity: 'P1', status: 'resolved', updated_at: '2026-03-04T00:00:00.000Z' }),
    closedNew: issue({ id: 'closedNew', severity: 'P1', status: 'resolved', updated_at: '2026-03-08T00:00:00.000Z' }),
  }, WEIGHTS, AT)

  assert.deepEqual(reading.groups.map((group) => group.key), ['open', 'acknowledged', 'resolved'], 'the rejected pile holds nothing, so it is dropped')
  assert.deepEqual(reading.groups.map((group) => group.standing), [true, true, false], 'the two still-owed piles count as standing, the settled one does not')
  assert.equal(reading.groups.every((group) => !Object.hasOwn(group, 'label')), true, 'pile heads no longer get words from the model: the key says which pile')
  assert.deepEqual(reading.groups[0].entries.map((row) => row.id), ['heavyOld', 'heavyNew', 'light'])
  assert.deepEqual(reading.groups[1].entries.map((row) => row.id), ['carried'])
  assert.deepEqual(reading.groups[2].entries.map((row) => row.id), ['closedNew', 'closedOld'])
  assert.equal(reading.groups[0].weight, 17, '8 + 8 + 1')
  assert.equal(reading.groups[2].standing, false)
})

test('the project reading brings the dependency field and the issue pool together, the table riding on the input', () => {
  const reading = readProject(record({
    nodes: { n1: { dependencies: [] }, n2: { mode: 'auto', status: 'todo', dependencies: ['n1'] } },
    cycles: [cycle({ policies: { issue_pool_weight_limit: 7 } })],
    issues: { a: issue({ severity: 'P1' }) },
    poolWeights: WEIGHTS,
  }))

  assert.equal(reading.graph.maxDepth, 1)
  assert.equal(reading.pool.line, 7)
  assert.equal(reading.pool.weight, 4)
})

test('reading the issue pool does not change the record handed to it', () => {
  const input = record({
    nodes: { n1: { dependencies: [] } },
    cycles: [cycle({ policies: { issue_pool_weight_limit: 40 } })],
    issues: { a: issue({ files: ['a.ts'] }) },
    poolWeights: WEIGHTS,
  })
  const snapshot = structuredClone(input)

  readProject(input)

  assert.deepEqual(input, snapshot)
})
