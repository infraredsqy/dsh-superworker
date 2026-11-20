/* The session notes reading: which file counts as a note, which cell it belongs to, and which
 * session to look at when a cell opened several.
 *
 * Session notes are another input of the model layer: the host half carries that directory back
 * verbatim, and which session to surface to the reader is judged here.
 *
 * A note answers two separate questions and the two are never substituted for each other: `run`
 * names the session that works the cell, `discussion` the conversation it was born in.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bornInSessionOf, readBirthplaces, readSessions, runSessionOf, strandedCycleOf } from '../src/model/index.ts'

test('the working session is the run entry, whatever the discussion says and whenever it happened', () => {
  assert.equal(runSessionOf({
    discussion: [{ session: 'session-talk', host: 'dsh', at: '2026-10-16T18:21:28Z' }],
    run: [{ session: 'session-run', host: 'dsh', at: '2026-10-18T17:59:44Z' }],
  }), 'session-run')

  /* The case this file exists for: a later discussion must not win the working session. That
     conversation is the one the cell was created in, and it belongs to whoever started it. */
  assert.equal(runSessionOf({
    discussion: [{ session: 'session-talk', at: '2026-10-19T01:00:00Z' }],
    run: [{ session: 'session-run', at: '2026-10-18T17:59:44Z' }],
  }), 'session-run')
})

test('a cell nobody was dispatched to has no working session — a birthplace is not one', () => {
  /* The shape of a cell that was prepared and never started: the note names only the conversation
     that created it, and the run list is empty. */
  const neverStarted = {
    v: 1,
    discussion: [{ session: 'session-created-me', host: 'dsh', at: '2026-11-19T21:13:15Z' }],
    run: [],
  }
  assert.equal(runSessionOf(neverStarted), undefined)
  assert.equal(bornInSessionOf(neverStarted), 'session-created-me')
})

test('the birthplace is the discussion entry, and the two readings never trade places', () => {
  const both = {
    discussion: [{ session: 'session-talk', at: '2026-10-19T01:00:00Z' }],
    run: [{ session: 'session-run', at: '2026-10-18T17:59:44Z' }],
  }
  assert.equal(bornInSessionOf(both), 'session-talk')
  assert.equal(runSessionOf(both), 'session-run')
  assert.equal(runSessionOf({ discussion: [{ session: 'session-talk' }] }), undefined)
  assert.equal(bornInSessionOf({ run: [{ session: 'session-run' }] }), undefined)
})

test('several of one kind opened: the one with the latest moment wins', () => {
  assert.equal(runSessionOf({
    run: [
      { session: 'session-first', at: '2026-10-17T00:00:00Z' },
      { session: 'session-again', at: '2026-10-18T00:00:00Z' },
    ],
  }), 'session-again')
})

test('an unreadable one resolves nothing and does not throw', () => {
  assert.equal(runSessionOf({ run: [{ host: 'dsh' }] }), undefined)
  assert.equal(runSessionOf({ run: [{ session: '' }] }), undefined)
  assert.equal(runSessionOf({ run: 'a string of stuff' }), undefined)
  assert.equal(runSessionOf('a note is not a record'), undefined)
  assert.equal(runSessionOf(undefined), undefined)
})

test('a layer of notes read into a reading: the file name minus its suffix is the node id, a wrong suffix is not a note', () => {
  const out = readSessions({
    'n-1.json': JSON.stringify({ run: [{ session: 'session-7' }] }),
    'n-2.json': JSON.stringify({ discussion: [{ session: 'session-talk' }] }),
    'readme.md': JSON.stringify({ run: [{ session: 'session-md' }] }),
    '.json': JSON.stringify({ run: [{ session: 'session-bare' }] }),
  })

  /* `n-2` is absent on purpose: it was created in `session-talk` and never dispatched, so it has no
     working session and earns no window. */
  assert.deepEqual(out, { 'n-1': 'session-7' })
})

test('the birthplace reading keeps what the working reading drops, and only there', () => {
  const notes = {
    'n-1.json': JSON.stringify({ discussion: [{ session: 'session-born' }], run: [{ session: 'session-7' }] }),
    'n-2.json': JSON.stringify({ discussion: [{ session: 'session-talk' }] }),
    'n-3.json': JSON.stringify({ run: [{ session: 'session-9' }] }),
  }

  assert.deepEqual(readSessions(notes), { 'n-1': 'session-7', 'n-3': 'session-9' })
  assert.deepEqual(readBirthplaces(notes), { 'n-1': 'session-born', 'n-2': 'session-talk' })
})

test('an unparsable one: that cell is skipped, the rest read on', () => {
  const out = readSessions({
    'n-1.json': 'this is not readable JSON text',
    'n-2.json': JSON.stringify({ run: [{ host: 'dsh' }] }),
    'n-3.json': JSON.stringify({ run: [{ session: 'session-3' }] }),
  })

  assert.deepEqual(out, { 'n-3': 'session-3' })
})

test('a layer with no note at all: an empty one comes back', () => {
  assert.deepEqual(readSessions({}), {})
})

/* ---- the stranded dispatch: claim on disk, session gone ------------------ */

const heldNode = { id: 'n-1', running: true }

test('claim on disk, session gone: this cell is stranded, and the cycle the claim names comes back', () => {
  const claims = { 'n-1': 'c-1' }
  const sessions = { 'n-1': 'session-7' }
  const alive = new Set(['session-other'])

  assert.equal(strandedCycleOf(heldNode, claims, sessions, alive), 'c-1')
})

test('the session is alive: not stranded', () => {
  const alive = new Set(['session-7'])

  assert.equal(strandedCycleOf(heldNode, { 'n-1': 'c-1' }, { 'n-1': 'session-7' }, alive), null)
})

test('no claim: not stranded — claims are the gate of this reading', () => {
  const alive = new Set([])

  assert.equal(strandedCycleOf(heldNode, {}, { 'n-1': 'session-7' }, alive), null)
  assert.equal(strandedCycleOf(heldNode, { 'n-1': '' }, { 'n-1': 'session-7' }, alive), null)
})

test('the note gives no session identity: "gone" cannot be judged, so not stranded', () => {
  const alive = new Set([])

  assert.equal(strandedCycleOf(heldNode, { 'n-1': 'c-1' }, {}, alive), null)
  assert.equal(strandedCycleOf(heldNode, { 'n-1': 'c-1' }, { 'n-1': 'session-7' }, null), null)
})

test('the cell is in no cycle\'s hands: even with claim and note present it is not stranded — a settled cell always carries both', () => {
  const done = { id: 'n-1', running: false }
  const alive = new Set([])

  assert.equal(strandedCycleOf(done, { 'n-1': 'c-1' }, { 'n-1': 'session-7' }, alive), null)
})
