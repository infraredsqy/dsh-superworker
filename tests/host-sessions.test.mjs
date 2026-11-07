/* The host-half hand that carries session notes back: locks in "that directory comes back verbatim".
 *
 * Which file counts as a note, which cell it belongs to, which session to look at when a cell
 * opened several — those are reading-level judgments, not this layer's (the model layer has its
 * own unit tests). What this layer must honor: every file comes back verbatim (no extension
 * filtering, no name stripping), an unreadable one is skipped, and a missing directory yields an
 * empty set.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { absentError, fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'
import { readClaims, readSessionNotes } from '../src/host/sessions.ts'

/** This file's own cases on top of the shared stand-in: the whole layer absent from the workspace,
 * and files listed but unreadable (plus a directory entry nothing should try to carry over). */
function fakePort(files, { absent = false, refuse = false, phantom = [] } = {}) {
  const port = fakeWorkspaceFiles(files)
  return {
    async list(scope, path) {
      if (absent) throw absentError(path)
      if (refuse) throw new Error(`listing ${path} refused`)
      const listing = await port.list(scope, path)
      return {
        ...listing,
        entries: [
          ...listing.entries,
          ...phantom.map((name) => ({ name, type: 'file' })),
          { name: 'notes', type: 'directory' },
        ],
      }
    },
    read: port.read,
  }
}

const scope = { sessionId: 's1', workspaceRoot: 'C:\\ws' }
const signal = new AbortController().signal

test('One directory carried back as it is: every file there, names and contents unchanged', async () => {
  const note = JSON.stringify({ node: 'n-1', v: 1, run: [{ session: 'session-7', at: '2026-10-18T00:00:00Z' }] })
  const port = fakePort({
    '.superworker/meta/sessions/n-1.json': note,
    '.superworker/meta/sessions/a-note-jotted-down.txt': 'copied as is even though it is not JSON',
  })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'read')
  assert.equal(reading.recordPath, '.superworker/meta/sessions')
  assert.equal(reading.workspaceRoot, 'C:\\ws')
  assert.deepEqual(reading.notes, { 'n-1.json': note, 'a-note-jotted-down.txt': 'copied as is even though it is not JSON' })
})

test('The unreadable one is skipped, the rest carry over; a directory entry is not carried', async () => {
  const port = fakePort({
    '.superworker/meta/sessions/n-1.json': '{"run": []}',
  }, { phantom: ['ghost.json'] })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'read')
  assert.deepEqual(reading.notes, { 'n-1.json': '{"run": []}' })
})

test('That directory absent (another machine, a fresh clone of the record): empty comes back', async () => {
  const port = fakePort({}, { absent: true })
  const reading = await readSessionNotes(port, scope, signal)

  assert.equal(reading.state, 'missing')
  assert.deepEqual(reading.notes, {})
})

/* ---- the dispatch claims: which cell carries a `started` marker ----------- */

test('The claims layer: cells carrying a started marker come in, the value being the line the cell sits on', async () => {
  const port = fakePort({
    '.superworker/meta/launch/c-1/n-1/prompt.txt': '/sw-conduct n-1 [pipeline]\n',
    '.superworker/meta/launch/c-1/n-1/started': '4242 started 2026-10-18T00:00:00Z\n',
    '.superworker/meta/launch/c-2/n-2/prompt.txt': '/sw-conduct n-2 [pipeline]\n',
  })
  const claims = await readClaims(port, scope, signal)

  assert.deepEqual(claims, { 'n-1': 'c-1' })
})

test('The claims layer absent (never a dispatch): empty comes back, no throw', async () => {
  const port = fakePort({})
  const claims = await readClaims(port, scope, signal)

  assert.deepEqual(claims, {})
})

test('The claims layer refuses as a whole (not absent): same discipline as notes, a failure that is not absence rides up', async () => {
  const port = fakePort({}, { refuse: true })
  await assert.rejects(() => readClaims(port, scope, signal), { message: /refused/u })
})
