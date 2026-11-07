/* The host-half reading segment: invariants only — reads correctly, missing files do not throw,
 * a refused page shrinks and retries, and the whole thing is read-only.
 *
 * No snapshots: what is compared is "the entries in the payload are the same thing as the record's
 * own copy". What a record looks like is decided by the samples below; when a sample changes the
 * assertions follow — never the other way around.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readReading, readWholeFile } from '../src/host/records.ts'
import { fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'

const scope = { sessionId: 'session-for-tests', workspaceRoot: 'C:\\workspace-for-tests' }
const signal = new AbortController().signal

/** The stand-in port with this file's own instrumentation: every port call recorded, every page
 * refusal recorded. The paging itself is the shared one; the tier and byte cap ride on it as
 * options — the two codes the port refuses pages with are what lands in `refusals`. */
function fakeWorkspace(files, { pageLines = 2, maxBytes = Infinity } = {}) {
  const calls = []
  const refusals = []
  const base = fakeWorkspaceFiles(files, { tier: pageLines, maxBytes })
  const port = {
    list(scope, dir) {
      calls.push(['list', dir])
      return base.list(scope, dir)
    },
    async read(scope, path, range) {
      calls.push(['read', path, range.offset, range.limit])
      try {
        return await base.read(scope, path, range)
      } catch (error) {
        if (error?.code === 'workspace-file/too-large' || error?.code === 'gateway/bad-request') {
          refusals.push({ path, offset: range.offset ?? 1, limit: range.limit, code: error.code })
        }
        throw error
      }
    },
  }
  return { port, calls, refusals }
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

const NODES = {
  n1: {
    title: 'first',
    description: 'the first node',
    tags: ['t0'],
    mode: 'auto',
    weight: 'w1',
    dsh_session: 'sess-1',
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-03T00:00:00.000Z',
    dependencies: [],
  },
  // The second node deliberately carries no weight and no dsh_session: absent in the record, absent in the payload.
  n2: {
    title: 'second',
    description: 'the second node',
    tags: [],
    mode: 'manual',
    status: 'todo',
    created_at: '2026-01-04T00:00:00.000Z',
    updated_at: '2026-01-05T00:00:00.000Z',
    dependencies: ['n1'],
  },
}
const CYCLES = [
  {
    id: 'c1',
    title: 'a line',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-06T00:00:00.000Z',
    policies: { issue_pool_weight_limit: 8 },
    holding: [{ id: 'n2', since: '2026-01-06T00:00:00.000Z' }],
    path: [{ node: 'n1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-02T00:00:00.000Z', result: 'delivered' }],
  },
]
const INSTRUCTIONS = [
  { id: 'i1', text: 'a sentence the user said', scope: 'global', target: 'stage', state: 'live', cycle: null, said_by: 'user', at: '2026-01-07T00:00:00.000Z', resolved_at: null, note: 'a note' },
]
const ISSUES = {
  p1: {
    id: 'p1',
    title: 'a case',
    severity: 'P1',
    status: 'open',
    module: 'mod-a',
    source: 'review',
    decision: 'fix',
    discovered: '2026-01-08T00:00:00.000Z',
    updated_at: '2026-01-09T00:00:00.000Z',
    check_count: 2,
    files: ['a.ts'],
    description: 'what went wrong',
    suggestion: 'what to do',
    reason: 'why',
  },
}

const record = () => ({
  '.pf/ideas.json': json({ nodes: NODES }),
  '.pf/state.json': json({ cycles: CYCLES }),
  '.pf/instructions.json': json({ instructions: INSTRUCTIONS }),
  '.pf/issues/issues.json': json({ version: 1, issues: ISSUES }),
})

test('Every source was read, and the entries are the record\'s own (weight / description / dsh_session as they are)', async () => {
  const { port } = fakeWorkspace(record(), { pageLines: 500 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.equal(reading.recordPath, '.pf')
  assert.equal(reading.workspaceRoot, scope.workspaceRoot)
  assert.deepEqual(reading.nodes, NODES)
  assert.deepEqual(reading.cycles, CYCLES)
  assert.deepEqual(reading.instructions, INSTRUCTIONS)
  assert.deepEqual(reading.issues, ISSUES)
})

test('A record spanning several pages still comes back whole', async () => {
  const many = {}
  for (let i = 1; i <= 20; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i}`, description: `description ${i}`, dependencies: [`n${i - 1}`] }
  }
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: many })
  const { port, calls } = fakeWorkspace(files, { pageLines: 3 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.nodes, many)
  assert.ok(calls.filter(([kind]) => kind === 'read').length > 3, 'this one takes several pages to read')
})

test('No record in the workspace: an empty reading comes back without a sound', async () => {
  const { port } = fakeWorkspace({})
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'missing', cycles: 'missing', instructions: 'missing', issues: 'missing' })
  assert.deepEqual(reading.nodes, {})
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(reading.issues, {})
})

test('Record present, one file short: only that one reports missing, the rest still read', async () => {
  const files = record()
  delete files['.pf/state.json']
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'missing', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.nodes, NODES)
})

test('The unreadable one reports unusable, the reading still comes back', async () => {
  const files = record()
  files['.pf/state.json'] = '{ this line is not JSON\n'
  files['.pf/instructions.json'] = json({ instructions: { not: 'a list' } })
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'unusable', instructions: 'unusable', issues: 'read' })
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(reading.nodes, NODES)
})

test('A read uses only list and read, and leaves the file table it was handed untouched', async () => {
  const files = record()
  const snapshot = structuredClone(files)
  const { port, calls } = fakeWorkspace(files, { pageLines: 500 })

  await readReading(port, scope, signal)

  assert.ok(calls.length > 0)
  assert.deepEqual([...new Set(calls.map(([kind]) => kind))].sort(), ['list', 'read'])
  assert.deepEqual(files, snapshot)
})

test('A page that will not move forward does not spin forever', async () => {
  let reads = 0
  const port = {
    async read() {
      reads += 1
      return { text: '', lines: 0, eof: false }
    },
  }
  assert.equal(await readWholeFile(port, scope, '.pf/anything.json', signal), '')
  assert.equal(reads, 1)
})

test('When a page breaches the byte cap it shrinks and retries: the whole record still reads in full', async () => {
  const many = {}
  for (let i = 1; i <= 400; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i}`, description: 'd'.repeat(300) }
  }
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: many })
  // The whole record fits within 500 lines, but a page's byte count breaches the cap: the byte side is what gets hit.
  const { port, calls, refusals } = fakeWorkspace(files, { pageLines: 500, maxBytes: 4096 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.nodes, many)

  assert.ok(refusals.length > 0, 'this one must hit the port byte cap once first')
  assert.deepEqual([...new Set(refusals.map(({ code }) => code))], ['workspace-file/too-large'])
  const limits = calls.filter(([kind, path]) => kind === 'read' && path === '.pf/ideas.json').map(([, , , limit]) => limit)
  assert.equal(limits[0], undefined, 'the first page asks for the port default tier')
  assert.ok(limits.slice(1).every((limit) => typeof limit === 'number' && limit < 500), 'after a refusal every page carries the shrunk line count')
})

test('A requested line count above the port tier shrinks and retries too: the whole record still reads in full', async () => {
  const many = {}
  for (let i = 1; i <= 40; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i}`, description: 'd'.repeat(3000) }
  }
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: many })
  // A page holds only 40 lines and the byte cap is 8192: after the cap is hit, the shrunk tier must first fit within 40 lines.
  const { port, refusals } = fakeWorkspace(files, { pageLines: 40, maxBytes: 8192 })
  const reading = await readReading(port, scope, signal)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.nodes, many)
  assert.ok(
    refusals.some(({ code }) => code === 'gateway/bad-request'),
    'a shrunk tier above the port tier gets bad-request, and it must keep shrinking from there',
  )
})

test('When one line alone breaches the cap, that one really is unreadable', async () => {
  const files = record()
  files['.pf/ideas.json'] = json({ nodes: { n1: { ...NODES.n2, description: 'd'.repeat(9000) } } })
  const { port } = fakeWorkspace(files, { pageLines: 500, maxBytes: 4096 })
  const reading = await readReading(port, scope, signal)

  // That line cannot pass even as a page of its own; shrinking pages cannot save it.
  assert.deepEqual(reading.sources, { nodes: 'unusable', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.nodes, {})
})