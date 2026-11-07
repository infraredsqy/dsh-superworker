/* Two judgments the panel needs before it can put words on the screen: whether the four sources all
 * landed on the same outcome, and which nodes a cycle's detail section collects. Plus the three
 * readings the drawing layer consumes instead of judging again: a card's bucket, its place in the
 * triage order, and the one moment it speaks of.
 *
 * What is locked are the criteria themselves — an empty set does not count as "all present", both
 * walked-by and held-by count, the delivered section orders newest completion first, and a line's
 * parked count names the same cards its detail's waiting section does.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { belongsTo, bucketOf, everySourceIs, lineStateOf, nodesOf, ownersOf, rankOf, readProject } from '../src/model/index.ts'
import { cycle, node, record } from './helpers/record-fixtures.mjs'

function readingWithSources(sources) {
  return { sources: Object.fromEntries(['nodes', 'cycles', 'instructions', 'issues'].map((key) => [key, sources[key] ?? sources.all])) }
}

test('all four sources must land on the same outcome; with none at all it does not count as "all present"', () => {
  assert.equal(everySourceIs(readingWithSources({ all: 'missing' }), 'missing'), true)
  assert.equal(everySourceIs(readingWithSources({ all: 'unusable' }), 'unusable'), true)
  assert.equal(everySourceIs(readingWithSources({ all: 'read' }), 'read'), true)

  assert.equal(everySourceIs(readingWithSources({ nodes: 'missing', cycles: 'unusable' }), 'missing'), false, 'mixed outcomes are not "all present"')
  assert.equal(everySourceIs(readingWithSources({ nodes: 'read', cycles: 'missing' }), 'missing'), false, 'one source read is not "none"')

  assert.equal(everySourceIs({ sources: {} }, 'missing'), false, 'no source listed at all: not read yet, not "all present"')
  assert.equal(everySourceIs(readingWithSources({ all: 'missing' }), 'unusable'), false, 'an outcome that does not match does not match')
})

test('the detail collects cells: ones it walked count, and the one it holds right now counts too', () => {
  const reading = readProject(record({
    nodes: {
      walked: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      held: node({ dependencies: [] }),
      other: node({ dependencies: [] }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'held', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'walked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }],
      }),
      cycle({ id: 'c2', holding: [{ id: 'walked', since: '2026-03-10T11:30:00.000Z' }] }),
    ],
  }))
  const c1 = reading.cycleById.c1
  const idsOf = (key) => nodesOf(key, c1, reading).map((one) => one.id)

  assert.deepEqual(idsOf('done'), ['walked'], 'a cell it walked counts as its own, even while another cycle holds it')
  assert.deepEqual(idsOf('run'), ['held'], 'the cell it holds right now counts in the running section')
  assert.deepEqual(idsOf('shelved'), [])
  assert.deepEqual(idsOf('ready'), [])
  assert.deepEqual(idsOf('wait'), [])
})

test('the detail collects cells: the delivered section puts the newest completion first', () => {
  const reading = readProject(record({
    nodes: {
      early: node({ status: 'completed', completed_at: '2026-03-10T07:00:00.000Z' }),
      late: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [
      cycle({
        path: [
          { node: 'early', started_at: '2026-03-10T06:00:00.000Z', ended_at: '2026-03-10T07:00:00.000Z', result: 'completed' },
          { node: 'late', started_at: '2026-03-10T09:00:00.000Z', ended_at: '2026-03-10T10:00:00.000Z', result: 'completed' },
        ],
      }),
    ],
  }))

  assert.deepEqual(
    nodesOf('done', reading.cycleById.c1, reading).map((one) => one.id),
    ['late', 'early'],
  )
})

test('the bucket reading: a cell that needs a person gates first, even while a cycle holds it', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual' }),
      busyGate: node({ mode: 'manual' }),
      checkpoint: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [cycle({ holding: [{ id: 'busyGate', since: '2026-03-10T11:00:00.000Z' }] })],
  }))

  assert.equal(bucketOf(reading.nodeById.gated), 'gate', 'a not-started cell with a manual gate falls in the gate bucket')
  assert.equal(bucketOf(reading.nodeById.busyGate), 'gate', 'the gate beats running: the cycle holding it cannot change that bucket')
  assert.equal(bucketOf(reading.nodeById.checkpoint), 'gate', 'a delivered checkpoint not yet approved falls in the gate bucket')
})

test('the bucket reading: a parked verdict gets its own bucket, the rest follow what is in hand and the cell\'s own state', () => {
  const reading = readProject(record({
    nodes: {
      parked: node({ status: undefined }),
      busy: node(),
      idle: node(),
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'busy', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }],
      }),
    ],
  }))

  assert.equal(bucketOf(reading.nodeById.parked), 'shelved', 'a verdict of failed parks it waiting for a person, in the shelved bucket')
  assert.equal(bucketOf(reading.nodeById.busy), 'run')
  assert.equal(bucketOf(reading.nodeById.idle), 'todo')
  assert.equal(bucketOf(reading.nodeById.done), 'done')
})

test('the triage rank: the buckets\' own order, splitting the not-started half into ready and still waiting', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual' }),
      parked: node({ status: undefined }),
      busy: node(),
      ready: node(),
      waiting: node({ dependencies: ['ready'] }),
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'busy', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }],
      }),
    ],
  }))

  assert.equal(rankOf(reading.nodeById.gated), 0, 'a cell that needs a person ranks first')
  assert.equal(rankOf(reading.nodeById.parked), 0, 'a parked cell ranks in the waiting tier too, whatever its delivery is right now')
  assert.equal(rankOf(reading.nodeById.busy), 1, 'in someone else\'s hands ranks next')
  assert.equal(rankOf(reading.nodeById.ready), 2, 'ready ranks third')
  assert.equal(rankOf(reading.nodeById.waiting), 3, 'still owing a prerequisite ranks fourth')
  assert.equal(rankOf(reading.nodeById.done), 4, 'settled ranks last')
})

test('a card\'s moment: the gate\'s before the hold\'s, the hold\'s before the step\'s end, the end before delivery, delivery before creation', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual', created_at: '2026-03-10T06:00:00.000Z' }),
      held: node({ created_at: '2026-03-10T06:00:00.000Z' }),
      stepped: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z', created_at: '2026-03-10T06:00:00.000Z' }),
      created: node({ created_at: '2026-03-10T06:00:00.000Z' }),
      bare: node(),
    },
    cycles: [
      {
        id: 'c1',
        status: 'active',
        holding: [{ id: 'gated', since: '2026-03-10T07:00:00.000Z' }],
        path: [{ node: 'gated', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }],
      },
      {
        id: 'c2',
        status: 'active',
        holding: [{ id: 'held', since: '2026-03-10T07:00:00.000Z' }],
        path: [
          { node: 'held', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' },
          { node: 'stepped', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' },
        ],
      },
    ],
  }))

  assert.equal(reading.nodeById.gated.stampAt?.toISOString(), '2026-03-10T08:00:00.000Z', 'the gate moment comes before the hold: 08:00 wins, the 07:00 hold does not step up')
  assert.equal(reading.nodeById.held.stampAt?.toISOString(), '2026-03-10T07:00:00.000Z', 'the hold moment comes before the step ends')
  assert.equal(reading.nodeById.stepped.stampAt?.toISOString(), '2026-03-10T09:00:00.000Z', 'the step ending comes before the delivery moment')
  assert.equal(reading.nodeById.created.stampAt?.toISOString(), '2026-03-10T06:00:00.000Z', 'a cell with nothing else falls to its creation moment')
  assert.equal(reading.nodeById.bare.stampAt, null, 'no moment at all is none, nothing else stands in')
})

test('which cycles a cell belongs to: every cycle that walked it plus the one holding it now; detail, blocked count and inking all read this one', () => {
  const reading = readProject(record({
    nodes: {
      carried: node({ status: undefined }),
      plain: node(),
    },
    cycles: [
      /* c1 holds the cell; c2 walked it first and the verdict parked it. */
      cycle({ id: 'c2', path: [{ node: 'carried', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }] }),
      cycle({ id: 'c1', holding: [{ id: 'carried', since: '2026-03-10T10:00:00.000Z' }] }),
    ],
  }))

  assert.deepEqual([...ownersOf(reading.nodeById.carried)], ['c2', 'c1'], 'the cycle that walked it first comes first, the holding cycle takes a share too')
  assert.deepEqual([...ownersOf(reading.nodeById.plain)], [], 'no cycle has touched it: it belongs to none')
  assert.deepEqual(reading.cycleById.c1.parked, ['carried'], 'a cycle holding it and with a parked verdict counts it in the blocked count')
  assert.deepEqual(nodesOf('shelved', reading.cycleById.c1, reading).map((one) => one.id), ['carried'],
    'the same criterion: the detail\'s shelved group and the blocked count name the same cell')
  assert.deepEqual(reading.cycleById.c2.parked, ['carried'], 'the cycle that walked it first records the same parking')
})

test('a cell two cycles walked: both count as having touched it, the re-run one is not "untouched"', () => {
  const reading = readProject(record({
    nodes: { rerun: node() },
    cycles: [
      /* c1 walked the cell first; c2 re-ran the same cell later and left it standing. */
      cycle({ id: 'c1', path: [{ node: 'rerun', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }] }),
      cycle({ id: 'c2', path: [{ node: 'rerun', started_at: '2026-03-10T10:00:00.000Z', ended_at: '2026-03-10T11:00:00.000Z', result: 'completed' }] }),
    ],
  }))
  const one = reading.nodeById.rerun

  assert.deepEqual([...one.cycleIds], ['c1', 'c2'], 'both cycles walked this cell: the record counts both as having touched it')
  assert.deepEqual([...ownersOf(one)], ['c1', 'c2'], 'each walking cycle takes a share, in record order')
  assert.equal(belongsTo(one, 'c1'), true)
  assert.equal(belongsTo(one, 'c2'), true, 'the re-run cycle touched this cell too, it is not "untouched"')
  assert.deepEqual(nodesOf('ready', reading.cycleById.c1, reading).map((each) => each.id), ['rerun'])
  assert.deepEqual(nodesOf('ready', reading.cycleById.c2, reading).map((each) => each.id), ['rerun'],
    'the detail groups and the inking read the same criterion: the re-run cycle gets this cell too')
})

test('a cycle\'s three states are judged once: a cell owed to a person is blocked, still in service is running, the rest are stopped', () => {
  const reading = readProject(record({
    nodes: { parked: node({ status: undefined }), busy: node() },
    cycles: [
      /* c1 owes a person: its verdict parked a cell. */
      cycle({ id: 'c1', path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }] }),
      cycle({ id: 'c2', holding: [{ id: 'busy', since: '2026-03-10T10:00:00.000Z' }] }),
      cycle({ id: 'c3', status: 'inactive' }),
      /* c4: no word written on it and nothing in hand — not in service, so stopped. */
      cycle({ id: 'c4', status: undefined }),
    ],
  }))

  assert.equal(lineStateOf(reading.cycleById.c1), 'blocked', 'one cell waiting on a person: the parking wins')
  assert.equal(lineStateOf(reading.cycleById.c2), 'run', 'no status written but work in hand: in service')
  assert.equal(lineStateOf(reading.cycleById.c3), 'stopped')
  assert.equal(lineStateOf(reading.cycleById.c4), 'stopped', 'no status and nothing in hand: not read as running')
})
