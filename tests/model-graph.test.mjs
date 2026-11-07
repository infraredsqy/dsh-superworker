/* The dependency field segment: invariants only — how layers are computed, how edges grow, and
 * what happens to things absent from the record. No layout and no snapshots are locked.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readDeps, readProject } from '../src/model/index.ts'
import { node, record } from './helpers/record-fixtures.mjs'

const layerIds = (reading) => reading.graph.layers.map((layer) => layer.map((item) => item.id))

test('the dependency field: a cell\'s layer is its deepest prerequisite plus one', () => {
  const reading = readProject(record({
    nodes: {
      root: node(),
      deep: node({ dependencies: ['root'] }),
      deeper: node({ dependencies: ['deep'] }),
      far: node({ dependencies: ['root', 'deeper'] }),
    },
  }))

  assert.equal(reading.graph.maxDepth, 3)
  assert.deepEqual(layerIds(reading), [['root'], ['deep'], ['deeper'], ['far']])
  assert.deepEqual(
    reading.graph.edges.map((edge) => `${edge.from}->${edge.to}:${String(edge.span)}`),
    ['root->deep:1', 'deep->deeper:1', 'root->far:3', 'deeper->far:1'],
  )
})

test('the dependency field: within a layer the record order is kept', () => {
  const reading = readProject(record({
    nodes: {
      b: node({ dependencies: ['a'] }),
      a: node(),
      c: node({ dependencies: ['a'] }),
      d: node({ dependencies: ['a'] }),
    },
  }))

  assert.deepEqual(layerIds(reading), [['a'], ['b', 'c', 'd']], 'recorded first comes first, not sorted by id')
})

test('the dependency field: a prerequisite the record lacks does not block', () => {
  const reading = readProject(record({
    nodes: { n1: node({ dependencies: ['gone', 'here'] }), here: node() },
  }))

  assert.equal(reading.nodeById.n1.dependencies.length, 2, 'no dependency written in the record is dropped')
  assert.deepEqual(reading.graph.edges.map((edge) => edge.from), ['here'], 'a prerequisite that cannot be resolved draws no edge')
  assert.equal(reading.graph.maxDepth, 1)
})

test('the dependency field: data looping into a cycle still yields a reading', () => {
  const reading = readProject(record({
    nodes: { a: node({ dependencies: ['b'] }), b: node({ dependencies: ['a'] }) },
  }))

  assert.equal(reading.graph.layers.length, reading.graph.maxDepth + 1)
  assert.equal(reading.graph.edges.length, 2, 'both edges are there, the loop does not swallow them')
})

test('the dependency field: with no node at all, it is empty', () => {
  const reading = readProject(record())

  assert.deepEqual(reading.graph.layers, [], 'what is not there is not drawn, and no empty layer is left behind')
  assert.equal(reading.graph.maxDepth, -1)
  assert.deepEqual(reading.graph.edges, [])
})

test('a node reading carries the title from the record', () => {
  const reading = readProject(record({
    nodes: { n1: node({ title: 'write the static checker' }), n2: node() },
  }))

  assert.equal(reading.nodeById.n1.title, 'write the static checker')
  assert.equal(reading.nodeById.n2.title, undefined, 'no title in the record means none, the id does not stand in')
})

test('the dependency sentence: ready counts only the reading\'s own value, others owe nothing of the kind', () => {
  const reading = readProject(record({
    nodes: {
      plain: node(),
      second: node(),
      owed: node({ dependencies: ['plain', 'second'] }),
      held: node(),
      shelved: node({ status: 'shelved', updated_at: '2026-03-10T09:00:00.000Z' }),
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
    },
    cycles: [
      { id: 'w', status: 'active', holding: [{ id: 'held', since: '2026-03-10T08:00:00.000Z' }], path: [] },
    ],
  }))

  assert.deepEqual(readDeps(reading.nodeById.plain), { ready: true, count: null }, 'the ready arm only says ready, with no count')
  assert.deepEqual(readDeps(reading.nodeById.owed), { ready: false, count: 2 }, 'the owing arm carries the number of prerequisites')
  assert.equal(readDeps(reading.nodeById.held), null, 'in someone else\'s hands right now: even with no prerequisite left, it does not count as ready')
  assert.equal(readDeps(reading.nodeById.shelved), null, 'a shelved one waiting on someone owes nothing of the kind')
  assert.equal(readDeps(reading.nodeById.done), null, 'a settled one owes no one\'s prerequisite')
})
