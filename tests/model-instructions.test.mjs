/* The instruction visibility segment: invariants only — which fields decide whether a sentence
 * still counts.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupInstructions, readProject } from '../src/model/index.ts'
import { AT, instruction as baseInstruction, record } from './helpers/record-fixtures.mjs'

/** An instruction; this file's own defaults layered on the shared body: staged, spoken at 09:00. */
const instruction = (fields = {}) => baseInstruction({ target: 'stage', at: '2026-03-10T09:00:00.000Z', ...fields })

function read(instructions, parts = {}) {
  return readProject(record({ ...parts, instructions })).instructions
}

const ids = (list) => list.map((item) => item.id)

test('a sentence not yet spoken at that moment is not in this reading', () => {
  const out = read([
    instruction({ id: 'said' }),
    instruction({ id: 'later', at: '2026-03-10T13:00:00.000Z' }),
    instruction({ id: 'never', at: null }),
  ])

  assert.deepEqual(ids(out), ['said'])
  assert.equal(out[0].inForce, true)
})

test('a withdrawn sentence does not count: a closed moment already reached, or a word other than live', () => {
  const out = read([
    instruction({ id: 'withdrawn', state: 'withdrawn', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'closed-while-live', resolved_at: '2026-03-10T11:00:00.000Z' }),
    instruction({ id: 'word-only', state: 'withdrawn' }),
  ])

  assert.deepEqual(out.filter((item) => item.inForce).map((item) => item.id), [])
  assert.ok(out.every((item) => item.standing === false))
  assert.equal(out[2].closedAt, null, 'the record has no closed moment: the word itself says this sentence is not in force')
})

test('legacy values read as "archived": fed done / superseded / applied / n/a, none throws, all are out of force', () => {
  const legacy = ['done', 'superseded', 'applied', 'n/a']
  let out
  assert.doesNotThrow(() => {
    out = read([
      instruction({ id: 'live', state: 'live' }),
      ...legacy.map((state, index) => instruction({ id: `legacy-${index}`, state })),
      ...legacy.map((state, index) => instruction({
        id: `legacy-closed-${index}`,
        state,
        resolved_at: '2026-03-10T11:00:00.000Z',
      })),
    ])
  })

  assert.deepEqual(ids(out.filter((item) => item.inForce)), ['live'])
  assert.equal(out.filter((item) => item.standing).length, 1, 'no legacy value stands')
  assert.equal(out[1].recordState, 'done', 'the word the record wrote comes out as it is, no mapping, no rewriting')
  assert.equal(out[1].closedAt, null, 'legacy values are not judged by a closed moment: not live means not in force')
})

test('outside the word table, or no word at all: both read as archived, no mapping for them', () => {
  const out = read([
    instruction({ id: 'live', state: 'live' }),
    instruction({ id: 'pending', state: 'pending' }),
    instruction({ id: 'strange', state: 'some other spelling' }),
    instruction({ id: 'no-word', state: undefined }),
  ])

  assert.deepEqual(ids(out.filter((item) => item.inForce)), ['live'])
  assert.equal(Object.hasOwn(out[3], 'recordState'), false, 'no word written means no word, none filled in')
})

test('a closed moment later than the reading moment: at that moment it still counts', () => {
  const out = read([instruction({ id: 'i1', resolved_at: '2026-03-10T13:00:00.000Z' })])

  assert.equal(out[0].standing, true)
  assert.equal(out[0].inForce, true)
  assert.equal(out[0].closedAt, null, 'not yet closed at that moment: the reading carries no such moment')
})

test('scope: a bound cycle not in service does not count, a bound cell already delivered does not count', () => {
  const out = read([
    instruction({ id: 'global', scope: 'global' }),
    instruction({ id: 'in-service', scope: 'cycle', cycle: 'c1' }),
    instruction({ id: 'out-of-service', scope: 'cycle', cycle: 'c2' }),
    instruction({ id: 'gone-cycle', scope: 'cycle', cycle: 'c9' }),
    instruction({ id: 'open-node', scope: 'node', node: 'n1' }),
    instruction({ id: 'completed-node', scope: 'node', node: 'n2' }),
    instruction({ id: 'gone-node', scope: 'node', node: 'n9' }),
    instruction({ id: 'no-binding', scope: 'cycle' }),
    instruction({ id: 'no-scope' }),
    instruction({ id: 'other-scope', scope: 'elsewhere' }),
  ], {
    nodes: {
      n1: { mode: 'auto', status: 'todo', dependencies: [] },
      n2: { mode: 'auto', status: 'completed', dependencies: [], completed_at: '2026-03-10T09:00:00.000Z' },
    },
    cycles: [
      { id: 'c1', status: 'active', holding: [], path: [] },
      { id: 'c2', status: 'inactive', holding: [], path: [] },
    ],
  })

  assert.deepEqual(
    ids(out.filter((item) => item.inForce)),
    ['global', 'in-service', 'gone-cycle', 'open-node', 'gone-node', 'no-binding', 'no-scope', 'other-scope'],
    'what cannot be measured counts: a bound cycle or cell no longer in the record still reads',
  )
  assert.deepEqual(ids(out.filter((item) => !item.inScope)), ['out-of-service', 'completed-node'])
})

test('a field the record did not write stays empty, no default filled in', () => {
  const out = read([{ id: 'i1', at: '2026-03-10T09:00:00.000Z' }])

  assert.equal(out[0].inForce, false, 'no status written means no live written: it reads as archived, and no word is filled in')
  assert.equal(Object.hasOwn(out[0], 'scope'), false)
  assert.equal(Object.hasOwn(out[0], 'recordState'), false)
  assert.equal(Object.hasOwn(out[0], 'text'), false)
})

test('a note in the record rides along with the reading: none written means none', () => {
  const out = read([
    instruction({ id: 'with', note: 'why this was said at the time' }),
    instruction({ id: 'without' }),
    instruction({ id: 'empty', note: null }),
  ])

  assert.equal(out[0].note, 'why this was said at the time')
  assert.equal(Object.hasOwn(out[1], 'note'), false)
  assert.equal(Object.hasOwn(out[2], 'note'), false)
})

test('grouping comes from the reading: global first, cycles in record order, an unrecognized cycle in its own group, the last slot', () => {
  const project = readProject({
    nodes: { n1: { mode: 'auto', status: 'todo', dependencies: [] } },
    cycles: [
      { id: 'c2', status: 'active', holding: [], path: [] },
      { id: 'c1', status: 'active', holding: [], path: [] },
    ],
    instructions: [
      instruction({ id: 'node-1', scope: 'node', node: 'n1' }),
      instruction({ id: 'line-c1', scope: 'cycle', cycle: 'c1' }),
      instruction({ id: 'line-gone', scope: 'cycle', cycle: 'c9' }),
      instruction({ id: 'line-none', scope: 'cycle' }),
      instruction({ id: 'world', scope: 'global' }),
      instruction({ id: 'strange', scope: 'elsewhere' }),
      instruction({ id: 'no-scope', scope: undefined }),
    ],
    issues: {},
    at: AT,
  })
  const groups = groupInstructions(project, project.instructions)

  assert.deepEqual(groups.map((group) => group.key), ['global', 'cycle:c1', 'cycle:c9', 'cycle:', 'node'], 'a cycle nothing falls into forms no group')
  assert.equal(groups.every((group) => !Object.hasOwn(group, 'label')), true, 'group heads no longer get words from the model: the key says which pile')
  assert.deepEqual(groups[3].entries.map((entry) => entry.id), ['line-none'], 'the bound cycle was not written: the ungrouped pile')
  assert.deepEqual(
    groups[4].entries.map((entry) => entry.id),
    ['node-1', 'strange', 'no-scope'],
    'an unrecognized scope reads as in force, and falls in this group',
  )
})

test('order within a group: still-standing first, newest first; empty groups are dropped', () => {
  const project = readProject({
    nodes: {},
    cycles: [{ id: 'c1', status: 'active', holding: [], path: [] }],
    instructions: [
      instruction({ id: 'old-live', at: '2026-03-10T08:00:00.000Z' }),
      instruction({ id: 'new-dead', state: 'withdrawn', resolved_at: '2026-03-10T11:00:00.000Z' }),
      instruction({ id: 'new-live', at: '2026-03-10T10:00:00.000Z' }),
    ],
    issues: {},
    at: AT,
  })
  const groups = groupInstructions(project, project.instructions)

  assert.deepEqual(groups.map((group) => group.key), ['global'], 'a cycle nothing falls into forms no group')
  assert.deepEqual(groups[0].entries.map((entry) => entry.id), ['new-live', 'old-live', 'new-dead'])
})