/* What one write leaves on the note line (src/client/outcome.ts): the shell and the settings page
 * read one answer, so a landed sentence, a silent success and a refusal are told apart in one place.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { noteOf, writeToNote } from '../src/client/outcome.ts'
import { RefusedError } from '../src/client/failure.ts'

test('写成的回话：工具说了话就原样留一行，没说话就不留', () => {
  assert.deepEqual(noteOf({ ok: true, text: '已经记下' }), { kind: 'said', text: '已经记下' })
  assert.equal(noteOf({ ok: true, text: '' }), null, '成功了却什么都没说：note 线上不写')
})

test('被拒的回话：带出的是 code，详情原样跟着', () => {
  assert.deepEqual(noteOf({ ok: false, code: 'scope-unknown' }), { kind: 'failure', failure: { code: 'scope-unknown' } })
  assert.deepEqual(
    noteOf({ ok: false, code: 'tool-refused', detail: '那一格不在' }),
    { kind: 'failure', failure: { code: 'tool-refused', detail: '那一格不在' } },
  )
})

test('回路：写成功才把读一遍交出去，失败也留下它的句子', async () => {
  const seen = []
  const landed = await writeToNote(() => Promise.resolve({ ok: true, text: '记下了' }), {
    note: (note) => seen.push(['note', note]),
    after: (landed) => seen.push(['after', landed]),
  })

  assert.equal(landed, true)
  assert.deepEqual(seen, [
    ['note', { kind: 'said', text: '记下了' }],
    ['after', true],
  ], '先落 note，再交回「有没有落地」')
})

test('回路：被拒的时候如实把带 code 的句子交出去，落地是 false', async () => {
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

test('回路：调用本身炸了，也落成一句带原因的话，不吞掉', async () => {
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

test('回路：不关心落地的调用方可以不交 after', async () => {
  assert.equal(await writeToNote(() => Promise.resolve({ ok: true, text: '' }), { note: () => undefined }), true)
})
