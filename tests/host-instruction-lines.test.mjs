/* The lines the panel spells for the instruction verbs — now spelled on this side of the boundary.
 *
 * The `instruction` word belongs to the plugin folder this package ships
 * (`packages/superworker-core/plugins/instruction/`), and a plugin folder imports nothing from the
 * engine, so the four translations from a panel action to a word line live in
 * `src/host/instruction-lines.ts`. What this file holds is the pair that can drift:
 *
 *   - the shape of each built line (`add` keeps the sentence verbatim and last; `archive` is the
 *     account's `resolve --state withdrawn`);
 *   - the scope vocabulary: the list this side pre-checks against, and the words the plugin's own
 *     surface accepts. A fourth scope lands in the plugin's command surface; this file goes red the
 *     moment the two lists disagree, which is the only way a copy can be kept honest.
 *   - the two exit codes a refused line answers with, and the stream each lands on: 2 with the page
 *     for a line the parser refuses, 1 for a sentence the account will not take.
 *
 * The words themselves are answered through the engine's `answer()` against the shipped plugin
 * directory, so nothing here runs a process or a shell.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer } from 'superworker-core'
import {
  INSTRUCTION_SCOPES,
  instructionAddLine,
  instructionArchiveLine,
  instructionRemoveLine,
  instructionReviveLine,
} from '../src/host/instruction-lines.ts'
import { project } from './helpers/superworker-project.mjs'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'

/* The words: each panel action is one line, and the sentence stays one argv cell. */
test('the four panel actions spell the account\'s own lines', () => {
  assert.deepEqual(instructionAddLine({ text: 'do the thing', scope: 'node', node: 'n-1' }), {
    ok: true,
    argv: ['instruction', 'add', '--scope', 'node', '--node', 'n-1', '--text', 'do the thing'],
  })
  // A global line takes no binding, even when the panel hands one over.
  assert.deepEqual(instructionAddLine({ text: 'global note', scope: 'global', node: 'ignored' }), {
    ok: true,
    argv: ['instruction', 'add', '--scope', 'global', '--text', 'global note'],
  })
  assert.deepEqual(instructionArchiveLine('i-1'), ['instruction', 'resolve', 'i-1', '--state', 'withdrawn'])
  assert.deepEqual(instructionReviveLine('i-1'), ['instruction', 'revive', 'i-1'])
  assert.deepEqual(instructionRemoveLine('i-1'), ['instruction', 'rm', 'i-1'])
})

test('a scope outside the list and an empty sentence are refused here, before any word is answered', () => {
  assert.deepEqual(instructionAddLine({ text: 'x', scope: 'everywhere' }), {
    ok: false,
    code: 'scope-unknown',
    detail: 'everywhere',
  })
  assert.deepEqual(instructionAddLine({ text: '   ', scope: 'global' }), { ok: false, code: 'empty-text', detail: '' })
})

test('the scope vocabulary is what the plugin accepts: every word this side spells lands on the record as written', async () => {
  const machine = await project('superworker-instruction-lines-')
  try {
    const io = { root: machine.root, pluginsDir: shippedPluginsDir() }
    const page = await answer(['instruction', 'help'], io)
    assert.equal(page.code, 0)
    for (const scope of INSTRUCTION_SCOPES) assert.ok(page.stdout.includes(scope), `the plugin's page names ${scope}`)
    // No fourth word: the page lists exactly the three scopes, one line of vocabulary.
    const listed = page.stdout.split(/\r?\n/u).find((line) => line.startsWith('scopes:'))
    assert.equal(listed, `scopes: ${INSTRUCTION_SCOPES.join(' / ')} (where an entry can be read from, not who remembers to resolve it).`)

    // Each scope's built line is answered by the plugin and read back off the record: a word this side
    // spells but the plugin read some other way would show up as a different scope on disk.
    const global = instructionAddLine({ text: 'global words', scope: 'global' })
    assert.equal(global.ok, true)
    const settled = await answer(global.argv, io)
    assert.equal(settled.code, 0, settled.stderr)
    assert.equal(settled.stdout.trim(), 'INSTRUCTION i-0001: [global/stage] global words')
    const record = JSON.parse(readFileSync(join(machine.root, '.superworker', 'instructions.json'), 'utf8'))
    assert.equal(record.instructions[0].scope, 'global')

    // An entry bound to a line the project does not have is refused by the plugin, and the panel's
    // line is exactly what asked for it: nothing is invented here.
    const bound = instructionAddLine({ text: 'line words', scope: 'cycle', cycle: 'no-such-line' })
    assert.equal(bound.ok, true)
    const refused = await answer(bound.argv, io)
    assert.equal(refused.code, 1)
    assert.ok(refused.stderr.includes('is not in state.json'), refused.stderr)
  } finally {
    machine.done()
  }
})

test('archiving, reviving and removing a sentence go through the words the plugin owns', async () => {
  const machine = await project('superworker-instruction-lines-')
  try {
    const io = { root: machine.root, pluginsDir: shippedPluginsDir() }
    const added = instructionAddLine({ text: 'the one to move around', scope: 'global' })
    assert.equal((await answer(added.argv, io)).code, 0)

    const archived = await answer(instructionArchiveLine('i-0001'), io)
    assert.equal(archived.code, 0)
    assert.equal(archived.stdout.trim(), 'INSTRUCTION i-0001 → withdrawn')
    const revived = await answer(instructionReviveLine('i-0001'), io)
    assert.equal(revived.code, 0)
    assert.equal(revived.stdout.trim(), 'INSTRUCTION i-0001 → live')
    const removed = await answer(instructionRemoveLine('i-0001'), io)
    assert.equal(removed.code, 0)
    assert.ok(removed.stdout.includes('REMOVED i-0001'))

    // The account reads back emptied, the tombstone keeping the id.
    const record = JSON.parse(readFileSync(join(machine.root, '.superworker', 'instructions.json'), 'utf8'))
    assert.equal(record.instructions.length, 0)
    assert.equal(record.removed[0].id, 'i-0001')
  } finally {
    machine.done()
  }
})

test('a refused line answers with its own exit code on stderr: 2 and the page for no verb, 1 for an empty sentence', async () => {
  const machine = await project('superworker-instruction-lines-')
  try {
    const io = { root: machine.root, pluginsDir: shippedPluginsDir() }
    // The bare word names no verb: the plugin's own page is the refusal, it carries the usage code, and
    // it lands on the stderr stream (the seam's envelope prefixes its first line).
    const bare = await answer(['instruction'], io)
    assert.equal(bare.code, 2)
    assert.equal(bare.stdout, '')
    assert.ok(bare.stderr.includes('usage: instruction <verb> [options]'), bare.stderr)
    assert.ok(bare.stderr.includes('the standing instruction account'), bare.stderr)

    // An empty sentence is the account refusing the words, not the parser refusing the line: code 1,
    // the sentence it always answered, and not one byte on disk.
    const blank = await answer(['instruction', 'add', '--scope', 'global', '--text', '   '], io)
    assert.equal(blank.code, 1)
    assert.equal(blank.stdout, '')
    assert.ok(blank.stderr.includes('text must not be empty'), blank.stderr)
    assert.equal(existsSync(join(machine.root, '.superworker', 'instructions.json')), false)
  } finally {
    machine.done()
  }
})