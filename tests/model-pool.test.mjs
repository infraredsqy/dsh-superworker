/* The issue pool segment: invariants only — where the weight table and policy line come from,
 * at what moment an issue counts as on the books, how weights add up, how the four piles are
 * ordered. No layout and no snapshots are locked.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readLine, readPool, readProject, readWeights } from '../src/model/index.ts'
import { AT, cycle, issue, record } from './helpers/record-fixtures.mjs'

/** The maintenance chore that carries the weight table. */
const CARRIER = { title: 'tidy the issue pool', description: 'each tier counts by P3/P2/P1/P0 = 1/2/4/8.' }

test('the weight table: taken from the maintenance chore\'s own description in the record', () => {
  assert.deepEqual(readWeights({ n1: CARRIER }), { P3: 1, P2: 2, P1: 4, P0: 8 })
  assert.equal(readWeights({ n1: { title: 'other work' } }), null, 'no table in the record means none')
  assert.equal(readWeights({}), null)
})

test('the policy line: which cycle set that number itself', () => {
  assert.equal(readLine([cycle({ policies: { parallel: 1 } })]), null, 'no cycle set one means no line')
  assert.equal(readLine([cycle({ policies: { parallel: 1 } }), cycle({ id: 'c2', policies: { issue_pool_weight_limit: 40 } })]), 40)
})

test('the pool weight: the still-owed issues summed by the weight table, those judged external drop out of the sum', () => {
  const reading = readPool(
    { n1: CARRIER },
    [cycle({ policies: { issue_pool_weight_limit: 40 } })],
    {
      a: issue({ id: 'a', severity: 'P0' }),
      b: issue({ id: 'b', severity: 'P2', status: 'acknowledged', decision: 'external' }),
      c: issue({ id: 'c', severity: 'P1', status: 'resolved', updated_at: '2026-03-05T00:00:00.000Z' }),
      d: issue({ id: 'd', severity: 'P3', decision: 'autofix' }),
      e: issue({ id: 'e', severity: 'P3', decision: 'unknown' }),
    },
    AT,
  )

  assert.equal(reading.line, 40)
  assert.deepEqual(reading.weights, { P3: 1, P2: 2, P1: 4, P0: 8 })
  /* `a` is undecided (counts as unknown) and `d` is autofix: both still enter the sum; `b` is
   * external and `c` is settled: neither enters. */
  assert.equal(reading.weight, 10, '8 + 1 + 1: the external one and the two settled ones do not enter the sum')
  assert.equal(reading.rows.find((row) => row.id === 'b')?.payable, false, 'the one judged external: the reading itself says it does not weigh on the line')
  assert.equal(reading.rows.find((row) => row.id === 'a')?.payable, true, 'the undecided one still weighs on the line')
  assert.equal(
    reading.groups.find((group) => group.key === 'acknowledged')?.weight,
    0,
    'the acknowledged pile holds one issue judged external: it stays out of that pile\'s weighted sum',
  )
  assert.deepEqual(reading.standing.map((row) => row.id), ['a', 'd', 'e', 'b'], 'the external one is still among the still-owed: the count still takes it in')
  assert.deepEqual(reading.census, { total: 5, standing: 4, open: 3, acknowledged: 1, rejected: 0, resolved: 1 })
})

test('the pool weight: with no weight table there is no reading, and 0 does not stand in', () => {
  const reading = readPool({}, [], { a: issue({ severity: 'P0' }) }, AT)

  assert.equal(reading.weights, null)
  assert.equal(reading.line, null)
  assert.equal(reading.weight, null, 'the record has no such table, so the number does not exist')
  assert.equal(reading.census.open, 1, 'the registered count still comes out')
})

test('when an issue counts as on the books: one not yet discovered is not', () => {
  const reading = readPool({}, [], {
    early: issue({ id: 'early', discovered: '2026-03-01T00:00:00.000Z' }),
    late: issue({ id: 'late', discovered: '2026-03-20T00:00:00.000Z' }),
    unknown: issue({ id: 'unknown', discovered: null }),
  }, AT)

  assert.deepEqual(reading.rows.map((row) => row.id), ['early'])
})

test('the word the record wrote belongs to the moment it was written: before that moment it reads as not yet settled', () => {
  const reading = readPool({}, [], {
    settled: issue({ id: 'settled', status: 'resolved', updated_at: '2026-03-05T00:00:00.000Z' }),
    settledLater: issue({ id: 'settledLater', status: 'resolved', updated_at: '2026-03-20T00:00:00.000Z' }),
    neverTouched: issue({ id: 'neverTouched', status: 'rejected', updated_at: null }),
    strange: issue({ id: 'strange', status: 'carried-over' }),
  }, AT)

  assert.equal(reading.rows.find((row) => row.id === 'settled').status, 'resolved')
  assert.equal(reading.rows.find((row) => row.id === 'settledLater').status, 'open', 'the word is not yet written at that moment')
  assert.equal(reading.rows.find((row) => row.id === 'neverTouched').status, 'rejected', 'no last change recorded, so the word counts')
  assert.equal(reading.rows.find((row) => row.id === 'strange').status, 'open', 'an unknown word reads as nobody settled it')
})

test('the four state words live once, in the model layer: empty piles form no group, the words are still asked for', () => {
  /* The pool holds one still-outstanding issue: the settled piles are empty piles and form no
   * groups, yet which pile each of the four is still comes from this one reading. */
  const reading = readPool({}, [], { a: issue() }, AT)

  assert.deepEqual(reading.groups.map((group) => group.key), ['open'])
  assert.equal(reading.groups[0]?.standing, true, 'the still-owed pile counts as standing')
  assert.equal(reading.groups[0]?.count, 1)
  assert.equal(Object.hasOwn(reading.groups[0], 'label'), false, 'pile heads no longer get words from the model: the key says which pile')
})

test('optional fields on the reading: only written ones show, unwritten ones get no empty string in their place', () => {
  const reading = readPool({}, [], {
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
  }, AT)
  const optional = ['title', 'severity', 'recordStatus', 'module', 'source', 'decision', 'description', 'suggestion', 'reason', 'planPath']

  const full = reading.rows.find((row) => row.id === 'full')
  for (const key of optional) assert.equal(key in full, true, `${key} is written so it must show`)

  const bare = reading.rows.find((row) => row.id === 'bare')
  for (const key of optional) assert.equal(key in bare, false, `${key} is not written so it must not show`)
})

test('the four piles: empty ones dropped, still-owed heaviest first and longest parked first, settled newest first', () => {
  const reading = readPool({ n1: CARRIER }, [], {
    light: issue({ id: 'light', severity: 'P3', discovered: '2026-03-01T00:00:00.000Z' }),
    heavyOld: issue({ id: 'heavyOld', severity: 'P0', discovered: '2026-03-02T00:00:00.000Z' }),
    heavyNew: issue({ id: 'heavyNew', severity: 'P0', discovered: '2026-03-03T00:00:00.000Z' }),
    carried: issue({ id: 'carried', severity: 'P2', status: 'acknowledged' }),
    closedOld: issue({ id: 'closedOld', severity: 'P1', status: 'resolved', updated_at: '2026-03-04T00:00:00.000Z' }),
    closedNew: issue({ id: 'closedNew', severity: 'P1', status: 'resolved', updated_at: '2026-03-08T00:00:00.000Z' }),
  }, AT)

  assert.deepEqual(reading.groups.map((group) => group.key), ['open', 'acknowledged', 'resolved'], 'the rejected pile holds nothing, so it is dropped')
  assert.deepEqual(reading.groups.map((group) => group.standing), [true, true, false], 'the two still-owed piles count as standing, the settled one does not')
  assert.equal(reading.groups.every((group) => !Object.hasOwn(group, 'label')), true, 'pile heads no longer get words from the model: the key says which pile')
  assert.deepEqual(reading.groups[0].entries.map((row) => row.id), ['heavyOld', 'heavyNew', 'light'])
  assert.deepEqual(reading.groups[1].entries.map((row) => row.id), ['carried'])
  assert.deepEqual(reading.groups[2].entries.map((row) => row.id), ['closedNew', 'closedOld'])
  assert.equal(reading.groups[0].weight, 17, '8 + 8 + 1')
  assert.equal(reading.groups[2].standing, false)
})

test('the project reading brings the dependency field and the issue pool together', () => {
  const reading = readProject(record({
    nodes: { n1: { ...CARRIER, dependencies: [] }, n2: { mode: 'auto', status: 'todo', dependencies: ['n1'] } },
    cycles: [cycle({ policies: { issue_pool_weight_limit: 7 } })],
    issues: { a: issue({ severity: 'P1' }) },
  }))

  assert.equal(reading.graph.maxDepth, 1)
  assert.equal(reading.pool.line, 7)
  assert.equal(reading.pool.weight, 4)
})

test('reading the issue pool does not change the record handed to it', () => {
  const input = record({
    nodes: { n1: CARRIER },
    cycles: [cycle({ policies: { issue_pool_weight_limit: 40 } })],
    issues: { a: issue({ files: ['a.ts'] }) },
  })
  const snapshot = structuredClone(input)

  readProject(input)

  assert.deepEqual(input, snapshot)
})