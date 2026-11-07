/* The model layer's reading segment: invariants only — how the four readings are computed, what
 * readings are given at the edges, and what stays blank when the record has no such moment.
 * When a sample changes the assertions follow; no layout and no snapshots are locked.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'
import { AT, cycle, node, record } from './helpers/record-fixtures.mjs'

function step(id, started, ended, result) {
  return { node: id, started_at: started, ended_at: ended, result }
}

const ids = (list) => list.map((item) => item.id)
const nodesOf = (list) => list.map((item) => item.node)

test('an empty record: all four readings are empty, and it says nothing', () => {
  const reading = readProject(record())

  assert.deepEqual(reading.nodes, [])
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(reading.columns, { completed: [], running: [], shelved: [], todo: [], ready: [], blocked: [] })
})

test('what comes in is not a moment: it is reported on the spot', () => {
  assert.throws(() => readProject(record({ at: new Date('not a moment') })), TypeError)
})

test('running follows the cycle record\'s holding relation: the card\'s own word stays not started', () => {
  const reading = readProject(record({
    nodes: { n1: node() },
    cycles: [cycle({ holding: [{ id: 'n1', since: '2026-03-10T11:00:00.000Z' }] })],
  }))
  const n1 = reading.nodeById.n1

  assert.equal(n1.state, 'todo', 'a card a cycle is working on still reads not started')
  assert.equal(n1.running, true)
  assert.deepEqual(n1.heldBy, ['c1'])
  assert.deepEqual(ids(reading.columns.running), ['n1'])
  assert.deepEqual(reading.columns.todo, [], 'a running cell is not in the not-started column')
  assert.equal(n1.heldSince.getTime(), Date.parse('2026-03-10T11:00:00.000Z'))
  assert.equal(n1.startedAt, null, 'the step has not started: the record has no such moment')
  assert.equal(n1.elapsedSeconds, null, 'no moment means no duration, never 0')
})

test('ready needs all three criteria', () => {
  const reading = readProject(record({
    nodes: {
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      r1: node({ dependencies: ['done'] }),
      s1: node({ status: 'shelved', dependencies: ['done'] }),
      h1: node({ dependencies: ['done'] }),
      w1: node({ dependencies: ['nope'] }),
    },
    cycles: [cycle({ holding: [{ id: 'h1', since: '2026-03-10T11:00:00.000Z' }] })],
  }))

  assert.deepEqual(ids(reading.columns.ready), ['r1'], 'prerequisites delivered and no one holding it: only then is it ready')
  assert.equal(reading.nodeById.s1.ready, false, 'without the first: a parked cell waiting on a person is not dressed up as ready')
  assert.equal(reading.nodeById.h1.ready, false, 'without the third: one in someone else\'s hand is not dressed up as ready')
  assert.equal(reading.nodeById.w1.ready, false, 'without the second: undelivered prerequisites mean not ready')
  assert.deepEqual(reading.nodeById.w1.openDependencies, ['nope'], 'a dependency the record lacks counts as undelivered')
})

test('a single parked node waiting on a person: the shelved column holds exactly one, everything else is empty', () => {
  const reading = readProject(record({
    nodes: { only: node({ status: 'shelved', updated_at: '2026-03-09T00:00:00.000Z' }) },
  }))
  const only = reading.nodeById.only

  assert.deepEqual(ids(reading.columns.shelved), ['only'])
  assert.deepEqual(reading.columns.completed, [])
  assert.deepEqual(reading.columns.running, [])
  assert.deepEqual(reading.columns.todo, [])
  assert.equal(only.state, 'shelved')
  assert.equal(only.gate.kind, 'shelved', 'the gate says only which kind, its name is the client\'s word')
  assert.equal(only.parkedSince, null, 'no verdict step means no such moment')
})

test('one node failed then delivered: it reads delivered, not parked waiting on a person', () => {
  const reading = readProject(record({
    nodes: { n: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }) },
    cycles: [cycle({
      path: [
        step('n', '2026-03-09T08:00:00.000Z', '2026-03-09T09:00:00.000Z', 'failed'),
        step('n', '2026-03-10T08:00:00.000Z', '2026-03-10T10:00:00.000Z', 'completed'),
      ],
    })],
  }))
  const n = reading.nodeById.n

  assert.equal(n.state, 'completed')
  assert.equal(n.gate, null, 'a delivered auto cell needs no person')
  assert.deepEqual(ids(reading.columns.completed), ['n'])
  assert.deepEqual(reading.columns.shelved, [], 'the later successful step brought it back out of the parked state')
  assert.equal(n.steps.length, 2)
  assert.equal(n.seconds, 3600, 'its own step is the first the record walked')
})

test('one node failed, the rerun settled on completed, and the cell has no delivery moment: it reads not started', () => {
  /* `updated_at` is later than the moment of reading, so this word was not written yet at that
   * time: status can only be judged from the steps walked, and the last step to settle brought
   * back completed. */
  const reading = readProject(record({
    nodes: { n: node({ status: 'completed', updated_at: '2026-03-10T13:00:00.000Z' }) },
    cycles: [cycle({
      path: [
        step('n', '2026-03-09T08:00:00.000Z', '2026-03-09T09:00:00.000Z', 'failed'),
        step('n', '2026-03-10T08:00:00.000Z', '2026-03-10T10:00:00.000Z', 'completed'),
      ],
    })],
  }))
  const n = reading.nodeById.n

  assert.equal(n.state, 'todo', 'the last step to settle brought back completed, so the cell is back in play')
  assert.equal(n.ready, true, 'prerequisites delivered, nobody holding it, so it is ready')
  assert.equal(n.gate, null, 'a cell back in play needs no person')
  assert.equal(n.parkedSince, null, 'no parking here means no such moment')
  assert.deepEqual(ids(reading.columns.todo), ['n'])
  assert.deepEqual(reading.columns.shelved, [], 'the earlier run\'s verdict is overwritten by the rerun')
  assert.deepEqual(ids(reading.columns.ready), ['n'])
})

test('the older holding spelling: the single-valued current_node / current_started_at on the cycle is read too', () => {
  const old = readProject(record({
    nodes: { n1: node() },
    cycles: [cycle({ current_node: 'n1', current_started_at: '2026-03-10T11:00:00.000Z' })],
  }))
  const n1 = old.nodeById.n1

  assert.equal(n1.state, 'todo', 'the card\'s own word still reads not started')
  assert.equal(n1.running, true)
  assert.deepEqual(n1.heldBy, ['c1'])
  assert.equal(n1.heldSince.getTime(), Date.parse('2026-03-10T11:00:00.000Z'))
  assert.deepEqual(old.cycleById.c1.holding, [{ nodeId: 'n1', since: new Date('2026-03-10T11:00:00.000Z') }])
  assert.deepEqual(ids(old.columns.running), ['n1'])

  /* That moment has not been picked up yet: the record writes it later on. */
  const later = readProject(record({
    nodes: { n1: node() },
    cycles: [cycle({ current_node: 'n1', current_started_at: '2026-03-10T13:00:00.000Z' })],
  }))

  assert.equal(later.nodeById.n1.running, false)
  assert.deepEqual(later.nodeById.n1.heldBy, [])
  assert.equal(later.nodeById.n1.heldSince, null, 'the record has no such moment: empty, nothing made up')
  assert.deepEqual(later.cycleById.c1.holding, [])
})

test('moment cutting: the record\'s own word counts only once written by that moment', () => {
  const nodes = { n: node({ status: 'todo', updated_at: '2026-03-10T11:30:00.000Z' }) }
  const cycles = [cycle({ path: [step('n', '2026-03-10T09:00:00.000Z', '2026-03-10T10:00:00.000Z', 'failed')] })]

  const early = readProject(record({ nodes, cycles, at: new Date('2026-03-10T11:00:00.000Z') }))
  const late = readProject(record({ nodes, cycles }))

  assert.equal(early.nodeById.n.state, 'shelved', 'the word "not started" is not yet written at that moment, so it reads from the verdict step')
  assert.equal(early.nodeById.n.parkedSince.getTime(), Date.parse('2026-03-10T10:00:00.000Z'))
  assert.equal(late.nodeById.n.state, 'todo', 'the word is written: the record says it is back in play')
})

test('delivery reads its own moment: not yet reached means not yet delivered', () => {
  const early = readProject(record({
    nodes: { n: node({ status: 'completed', completed_at: '2026-03-10T13:00:00.000Z' }) },
    at: new Date('2026-03-10T12:00:00.000Z'),
  }))
  const word = readProject(record({ nodes: { n: node({ status: 'completed' }) } }))

  assert.equal(early.nodeById.n.state, 'todo')
  assert.equal(early.nodeById.n.completedAt, null, 'that moment has not arrived, so the reading has no such moment')
  assert.equal(word.nodeById.n.state, 'completed', 'with no delivery moment in the record at all, its own word is what counts')
})

test('the human gate: one word + that moment, and a cell needing nobody has no such word', () => {
  const shelved = readProject(record({
    nodes: { s: node({ status: 'shelved', updated_at: '2026-03-10T11:00:00.000Z' }) },
    cycles: [cycle({ path: [step('s', '2026-03-10T09:00:00.000Z', '2026-03-10T10:00:00.000Z', 'stopped')] })],
  }))
  assert.deepEqual(shelved.nodeById.s.gate, {
    kind: 'shelved', since: new Date('2026-03-10T10:00:00.000Z'),
  })

  /* That word was not written yet at that moment (its last modification is later than the moment
   * of reading): read from the verdict step. */
  const bySteps = readProject(record({
    nodes: { s: node({ updated_at: '2026-03-10T13:00:00.000Z' }) },
    cycles: [cycle({ path: [step('s', '2026-03-10T09:00:00.000Z', '2026-03-10T10:00:00.000Z', 'failed')] })],
  }))
  assert.equal(bySteps.nodeById.s.state, 'shelved')
  assert.equal(bySteps.nodeById.s.gate.kind, 'shelved')
  assert.equal(bySteps.nodeById.s.gate.since.getTime(), Date.parse('2026-03-10T10:00:00.000Z'))

  const manual = readProject(record({
    nodes: { m: node({ mode: 'manual' }) },
    cycles: [cycle({ path: [step('m', '2026-03-10T09:00:00.000Z', null, null)] })],
  }))
  assert.equal(manual.nodeById.m.gate.kind, 'manual')
  assert.equal(Object.hasOwn(manual.nodeById.m.gate, 'word'), false, 'the gate no longer carries a word: the kind alone says which')
  assert.equal(manual.nodeById.m.gate.since.getTime(), Date.parse('2026-03-10T09:00:00.000Z'))

  const hand = readProject(record({ nodes: { m: node({ mode: 'manual' }) } }))
  assert.equal(hand.nodeById.m.gate.kind, 'manual')
  assert.equal(hand.nodeById.m.gate.since, null, 'the record has no such moment: empty, nothing made up')

  /* A checkpoint's gate reads this node's own record alone: delivered, and this delivery not approved
   * by a person. Where the line has walked since says nothing about that delivery. */
  const checkpoint = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T09:20:00.000Z' }) },
    cycles: [cycle({ path: [step('cp', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed')] })],
  }))
  assert.equal(checkpoint.nodeById.cp.gate.kind, 'checkpoint', 'delivered and nobody approved it: the gate stays lit')
  assert.equal(Object.hasOwn(checkpoint.nodeById.cp.gate, 'word'), false, 'the gate no longer carries a word: the kind alone says which')
  assert.equal(
    checkpoint.nodeById.cp.gate.since.getTime(),
    Date.parse('2026-03-10T09:20:00.000Z'),
    'that moment is the delivery moment; when the step settled is irrelevant',
  )

  const approved = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T09:00:00.000Z', approved_at: '2026-03-10T10:00:00.000Z' }) },
  }))
  assert.equal(approved.nodeById.cp.gate, null, 'approved after delivery: this delivery was approved, so the gate is gone')

  const approvedEarly = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T10:00:00.000Z', approved_at: '2026-03-10T09:00:00.000Z' }) },
  }))
  assert.equal(approvedEarly.nodeById.cp.gate.kind, 'checkpoint', 'a redelivery moves the delivery moment past that approval: the old approval does not count, the gate is back')
  assert.equal(approvedEarly.nodeById.cp.gate.since.getTime(), Date.parse('2026-03-10T10:00:00.000Z'))

  const moved = readProject(record({
    nodes: {
      cp: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      after: node({ status: 'completed', completed_at: '2026-03-10T10:30:00.000Z' }),
    },
    cycles: [cycle({
      path: [
        step('cp', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed'),
        step('after', '2026-03-10T10:00:00.000Z', '2026-03-10T10:30:00.000Z', 'completed'),
      ],
    })],
  }))
  assert.equal(moved.nodeById.cp.gate.kind, 'checkpoint', 'the cycle moving on does not clear the gate: unapproved means still gated')
  assert.equal(moved.nodeById.after.gate, null, 'an auto cell needs no person')

  const shapes = readProject(record({
    nodes: {
      late: node({
        mode: 'checkpoint', status: 'completed',
        completed_at: '2026-03-10T09:00:44Z', approved_at: '2026-03-10T09:00:44.500000Z',
      }),
      early: node({
        mode: 'checkpoint', status: 'completed',
        completed_at: '2026-03-10T09:00:44.500000Z', approved_at: '2026-03-10T09:00:44Z',
      }),
    },
  }))
  assert.equal(shapes.nodeById.late.gate, null, 'two moment shapes mixed: an approval half a second later counts as approved by moment comparison')
  assert.equal(shapes.nodeById.early.gate.kind, 'checkpoint', 'an approval half a second earlier would read backwards under string comparison; by moment it is unapproved')

  const undated = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint', status: 'completed' }) },
  }))
  assert.equal(undated.nodeById.cp.gate.kind, 'checkpoint', 'delivery said but no delivery moment: there is no delivery to approve, so the gate stays lit')
  assert.equal(undated.nodeById.cp.gate.since, null, 'the record has no such moment: empty, nothing made up')

  const running = readProject(record({
    nodes: { cp: node({ mode: 'checkpoint' }) },
  }))
  assert.equal(running.nodeById.cp.gate, null, 'a checkpoint not yet delivered: the gate is not on it')
})

test('the cycle: what it holds, what steps it walked, who under it waits on a person', () => {
  const reading = readProject(record({
    nodes: {
      held: node(),
      walked: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      open: node(),
      parked: node(),
    },
    cycles: [cycle({
      holding: [{ id: 'held', since: '2026-03-10T11:00:00.000Z' }],
      path: [
        step('walked', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed'),
        step('open', '2026-03-10T11:30:00.000Z', null, null),
        step('parked', '2026-03-10T13:00:00.000Z', '2026-03-10T13:30:00.000Z', 'failed'),
      ],
    })],
  }))
  const c1 = reading.cycleById.c1

  assert.equal(c1.inService, true)
  assert.deepEqual(c1.holding, [{ nodeId: 'held', since: new Date('2026-03-10T11:00:00.000Z') }])
  assert.deepEqual(nodesOf(c1.path), ['walked'], 'a step not yet settled at that moment does not count as walked')
  assert.equal(c1.lastStep.node, 'walked')
  assert.deepEqual(c1.parked, [], 'no one is parked at that moment')
})

test('the payload the data bridge hands in works as input directly', () => {
  const payload = {
    workspaceRoot: 'C:\\workspace-for-tests',
    recordPath: '.superworker',
    sources: { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'missing' },
    nodes: { n1: node() },
    cycles: [cycle()],
    instructions: [],
    issues: {},
  }
  const reading = readProject({ ...payload, at: AT })

  assert.equal(reading.nodeById.n1.state, 'todo')
  assert.deepEqual(reading.cycles.map((item) => item.id), ['c1'])
})

test('the version that writes the session on the record itself: the session comes out as is, and unwritten cells have no such field', () => {
  const reading = readProject(record({
    nodes: {
      n1: node({ dsh_session: 'session-7' }),
      n2: node({ dsh_session: '' }),
      n3: node(),
    },
  }))

  assert.equal(reading.nodeById.n1.session, 'session-7')
  assert.equal(reading.nodeById.n2.session, undefined)
  assert.equal(reading.nodeById.n3.session, undefined)
})

test('reading does not change the record handed to it', () => {
  const input = record({
    nodes: { n1: node({ dependencies: ['n2'] }), n2: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }) },
    cycles: [cycle({ holding: [{ id: 'n1', since: '2026-03-10T11:00:00.000Z' }], path: [step('n2', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', 'completed')] })],
  })
  const snapshot = structuredClone(input)

  readProject(input)

  assert.deepEqual(input, snapshot, 'none of the four records nor the moment may be changed')
})