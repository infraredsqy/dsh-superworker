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

/* The reading's map containers carry no borrowed prototype (records.ts builds them with
 * Object.create(null)): the assertions pin the own key table, so `own` copies it onto a plain
 * shell — deepStrictEqual would otherwise split hairs over the container's prototype. */
const own = (map) => ({ ...map })

const NODES = {
  n1: {
    title: 'first',
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
  '.superworker/ideas.json': json({ nodes: NODES }),
  '.superworker/state.json': json({ cycles: CYCLES }),
  '.superworker/instructions.json': json({ instructions: INSTRUCTIONS }),
  '.superworker/issues/issues.json': json({ version: 1, issues: ISSUES }),
})

test('Every source was read, and the entries are the record\'s own (weight / dsh_session as they are)', async () => {
  const { port } = fakeWorkspace(record(), { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.equal(reading.recordPath, '.superworker')
  assert.equal(reading.workspaceRoot, scope.workspaceRoot)
  assert.deepEqual(own(reading.nodes), NODES)
  assert.deepEqual(reading.cycles, CYCLES)
  assert.deepEqual(reading.instructions, INSTRUCTIONS)
  assert.deepEqual(own(reading.issues), ISSUES)
})

test('A record spanning several pages still comes back whole', async () => {
  const many = {}
  for (let i = 1; i <= 20; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i} ${'t'.repeat(300)}`, dependencies: [`n${i - 1}`] }
  }
  const files = record()
  files['.superworker/ideas.json'] = json({ nodes: many })
  const { port, calls } = fakeWorkspace(files, { pageLines: 3 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(own(reading.nodes), many)
  assert.ok(calls.filter(([kind]) => kind === 'read').length > 3, 'this one takes several pages to read')
})

test('No record in the workspace: an empty reading comes back without a sound', async () => {
  const { port } = fakeWorkspace({})
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.sources, { nodes: 'missing', cycles: 'missing', instructions: 'missing', issues: 'missing' })
  assert.deepEqual(own(reading.nodes), {})
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(own(reading.issues), {})
})

test('Record present, one file short: only that one reports missing, the rest still read', async () => {
  const files = record()
  delete files['.superworker/state.json']
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'missing', instructions: 'read', issues: 'read' })
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(own(reading.nodes), NODES)
})

test('The unreadable one reports unusable, the reading still comes back', async () => {
  const files = record()
  files['.superworker/state.json'] = '{ this line is not JSON\n'
  files['.superworker/instructions.json'] = json({ instructions: { not: 'a list' } })
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'unusable', instructions: 'unusable', issues: 'read' })
  assert.deepEqual(reading.cycles, [])
  assert.deepEqual(reading.instructions, [])
  assert.deepEqual(own(reading.nodes), NODES)
})

test('A read uses only list and read, and leaves the file table it was handed untouched', async () => {
  const files = record()
  const snapshot = structuredClone(files)
  const { port, calls } = fakeWorkspace(files, { pageLines: 500 })

  await readReading(port, scope, signal, null, null)

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
  assert.equal(await readWholeFile(port, scope, '.superworker/anything.json', signal), '')
  assert.equal(reads, 1)
})

test('When a page breaches the byte cap it shrinks and retries: the whole record still reads in full', async () => {
  const many = {}
  for (let i = 1; i <= 400; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i} ${'t'.repeat(300)}` }
  }
  const files = record()
  files['.superworker/ideas.json'] = json({ nodes: many })
  // The whole record fits within 500 lines, but a page's byte count breaches the cap: the byte side is what gets hit.
  const { port, calls, refusals } = fakeWorkspace(files, { pageLines: 500, maxBytes: 4096 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(own(reading.nodes), many)

  assert.ok(refusals.length > 0, 'this one must hit the port byte cap once first')
  assert.deepEqual([...new Set(refusals.map(({ code }) => code))], ['workspace-file/too-large'])
  const limits = calls.filter(([kind, path]) => kind === 'read' && path === '.superworker/ideas.json').map(([, , , limit]) => limit)
  assert.equal(limits[0], undefined, 'the first page asks for the port default tier')
  assert.ok(limits.slice(1).every((limit) => typeof limit === 'number' && limit < 500), 'after a refusal every page carries the shrunk line count')
})

test('A requested line count above the port tier shrinks and retries too: the whole record still reads in full', async () => {
  const many = {}
  for (let i = 1; i <= 40; i++) {
    many[`n${i}`] = { ...NODES.n2, title: `node ${i} ${'t'.repeat(3000)}` }
  }
  const files = record()
  files['.superworker/ideas.json'] = json({ nodes: many })
  // A page holds only 40 lines and the byte cap is 8192: after the cap is hit, the shrunk tier must first fit within 40 lines.
  const { port, refusals } = fakeWorkspace(files, { pageLines: 40, maxBytes: 8192 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.sources, { nodes: 'read', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(own(reading.nodes), many)
  assert.ok(
    refusals.some(({ code }) => code === 'gateway/bad-request'),
    'a shrunk tier above the port tier gets bad-request, and it must keep shrinking from there',
  )
})

test('When one line alone breaches the cap, that one really is unreadable', async () => {
  const files = record()
  files['.superworker/ideas.json'] = json({ nodes: { n1: { ...NODES.n2, title: 't'.repeat(9000) } } })
  const { port } = fakeWorkspace(files, { pageLines: 500, maxBytes: 4096 })
  const reading = await readReading(port, scope, signal, null, null)

  // That line cannot pass even as a page of its own; shrinking pages cannot save it.
  assert.deepEqual(reading.sources, { nodes: 'unusable', cycles: 'read', instructions: 'read', issues: 'read' })
  assert.deepEqual(own(reading.nodes), {})
})

/* The node-table judgement aligns with the engine's one reading (`readNodeTable` in
 * superworker-core/src/graph.ts): a JSON-parsed own key `__proto__` is a real key that must land in
 * the reading, and a cell that is not a node record drops itself instead of sinking the table. */
test('A node whose own key is __proto__ itself still lands in the reading', async () => {
  // An object literal would turn `__proto__` into the prototype; JSON.parse lays it down as a real
  // own key — exactly what the reader's JSON.parse of ideas.json holds.
  const nodes = JSON.parse(`{"n1": ${JSON.stringify(NODES.n1)}, "__proto__": ${JSON.stringify(NODES.n2)}}`)
  const files = record()
  files['.superworker/ideas.json'] = json({ nodes })
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.equal(reading.sources.nodes, 'read')
  assert.ok(Object.hasOwn(reading.nodes, '__proto__'), "the cell sits in the reading's own key table, not on a borrowed prototype")
  assert.deepEqual(own(reading.nodes), nodes)
})

test('A cell that is not a node record drops itself; the rest of the table still reads', async () => {
  const files = record()
  files['.superworker/ideas.json'] = json({
    nodes: { n1: NODES.n1, junkWord: 'not a node', junkNull: null, junkList: [NODES.n2], n2: NODES.n2 },
  })
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.equal(reading.sources.nodes, 'read', 'the table is not sunk by one bad cell')
  assert.deepEqual(Object.keys(own(reading.nodes)).sort(), ['n1', 'n2'])
})

/* Same family as the nodes round above (accumulators wear no borrowed prototype): a JSON-parsed own
 * key `__proto__` is a real key that must land in the reading's issue table, and the issue record
 * must not sink into the accumulator's prototype. */
test('An issue whose own key is __proto__ itself still lands in the reading', async () => {
  // An object literal would turn `__proto__` into the prototype; JSON.parse lays it down as a real
  // own key — exactly what the reader's JSON.parse of issues.json holds.
  const proto = { ...ISSUES.p1, id: 'proto', title: 'proto issue' }
  const issues = JSON.parse(`{"p1": ${JSON.stringify(ISSUES.p1)}, "__proto__": ${JSON.stringify(proto)}}`)
  const files = record()
  files['.superworker/issues/issues.json'] = json({ version: 1, issues })
  const { port } = fakeWorkspace(files, { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.equal(reading.sources.issues, 'read')
  assert.ok(Object.hasOwn(reading.issues, '__proto__'), "the cell sits in the reading's own key table, not on a borrowed prototype")
  assert.deepEqual(own(reading.issues), issues)
})

/* The one door instruction rows enter the reading through: a scope word the vocabulary retires stops
 * here, so no layer above ever learns the word. This is the whole of the retirement judgement on this
 * half — the model layer carries no scope vocabulary at all — which is why it is pinned here and
 * nowhere else. The vocabulary itself is never written into this file: it is handed in, the way the
 * host hands it in from the plugin's own storage layer. */
const RETIRED = { valid: ['global', 'cycle'], retired: ['node'] }

const retiredRecord = () => {
  const files = record()
  files['.superworker/instructions.json'] = json({
    instructions: [
      ...INSTRUCTIONS,
      { id: 'i2', text: 'the retired level', scope: 'node', target: 'stage', state: 'live', cycle: null, node: 'n1', said_by: 'user', at: '2026-01-08T00:00:00.000Z', resolved_at: null, note: null },
      { id: 'i3', text: 'a word nobody declares', scope: 'once', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-09T00:00:00.000Z', resolved_at: null, note: null },
    ],
  })
  return files
}

test('A row carrying a retired scope word never enters the reading; the other rows do', async () => {
  const { port } = fakeWorkspace(retiredRecord(), { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, RETIRED)

  assert.deepEqual(reading.instructions.map((row) => row.id), ['i1', 'i3'])
  assert.equal(reading.sources.instructions, 'read', 'the file itself was read: the rows are there, and one is judged not part of the account')
})

test('No vocabulary (a package without the plugin): nothing is judged retired, and the rows ride as they sit on disk', async () => {
  const { port } = fakeWorkspace(retiredRecord(), { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, null)

  assert.deepEqual(reading.instructions.map((row) => row.id), ['i1', 'i2', 'i3'], 'a judgement this installation cannot spell is not made')
})

test('The retired word is matched exactly: a word the vocabulary does not name flows on, as every unknown spelling always has', async () => {
  const { port } = fakeWorkspace(retiredRecord(), { pageLines: 500 })
  const reading = await readReading(port, scope, signal, null, { valid: ['global', 'cycle'], retired: [] })

  assert.deepEqual(reading.instructions.map((row) => row.id), ['i1', 'i2', 'i3'], 'an empty retired list retires nothing — `node` is only retired once the plugin says so')
})