/* What one write leaves on the note line (src/client/outcome.ts): the shell and the settings page
 * read one answer, so a landed sentence, a silent success and a refusal are told apart in one place.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { noteOf, writeToNote } from '../src/client/outcome.ts'
import { RefusedError } from '../src/client/failure.ts'

test('a successful answer: words from the tool keep one line as they are, no words leaves none', () => {
  assert.deepEqual(noteOf({ ok: true, text: 'noted already' }), { kind: 'said', text: 'noted already' })
  assert.equal(noteOf({ ok: true, text: '' }), null, 'succeeded but said nothing: nothing goes on the note line')
})

test('a refused answer: what comes out is a code, the detail follows as it is', () => {
  assert.deepEqual(noteOf({ ok: false, code: 'scope-unknown' }), { kind: 'failure', failure: { code: 'scope-unknown' } })
  assert.deepEqual(
    noteOf({ ok: false, code: 'tool-refused', detail: 'that cell is not there' }),
    { kind: 'failure', failure: { code: 'tool-refused', detail: 'that cell is not there' } },
  )
})

test('the loop: the write lands before the read is handed back; a failure still leaves its sentence', async () => {
  const seen = []
  const landed = await writeToNote(() => Promise.resolve({ ok: true, text: 'noted' }), {
    note: (note) => seen.push(['note', note]),
    after: (landed) => seen.push(['after', landed]),
  })

  assert.equal(landed, true)
  assert.deepEqual(seen, [
    ['note', { kind: 'said', text: 'noted' }],
    ['after', true],
  ], 'note lands first, then whether it landed comes back')
})

test('the loop: on refusal the code-carrying sentence is handed back truthfully, landed is false', async () => {
  const seen = []
  const landed = await writeToNote(() => Promise.resolve({ ok: false, code: 'config-write-failed' }), {
    note: (note) => seen.push(['note', note]),
    after: (landed) => seen.push(['after', landed]),
  })

  assert.equal(landed, false)
  assert.deepEqual(seen, [
    ['note', { kind: 'failure', failure: { code: 'config-write-failed' } }],
    ['after', false],
  ])
})

test('the loop: the call itself blowing up still lands as a sentence with its reason, not swallowed', async () => {
  const seen = []
  const landed = await writeToNote(() => Promise.reject(new RefusedError({ code: 'not-connected' })), {
    note: (note) => seen.push(['note', note]),
    after: (landed) => seen.push(['after', landed]),
  })

  assert.equal(landed, false)
  assert.deepEqual(seen, [
    ['note', { kind: 'failure', failure: { code: 'not-connected' } }],
    ['after', false],
  ])
})

test('the loop: a caller that does not care about landing can omit after', async () => {
  assert.equal(await writeToNote(() => Promise.resolve({ ok: true, text: '' }), { note: () => undefined }), true)
})
