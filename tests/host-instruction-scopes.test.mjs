/* The host half's instruction-scope segment: the vocabulary comes from the instruction plugin's own
 * storage layer, and a folder that cannot answer it gives `null` rather than an invented list.
 *
 * Nothing here pins the scope words themselves beyond "the two the plugin declares, and the one it
 * retires are the same constants the plugin exports": a case that wrote `retired: ['node']` down here
 * would be the second copy this arrangement exists to prevent. What is compared is identity.
 *
 * Every case but the last reads the seam out of `src/`: no build and no `lib/` needed, since the seam
 * loads the plugin file the way the engine loads a plugin entry.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  instructionScopesPath,
  isRetiredScope,
  readInstructionScopes,
} from '../src/host/instruction-scopes.ts'
import { RETIRED_SCOPES, VALID_SCOPES } from '../packages/superworker-core/plugins/instruction/tools/storage.mjs'

/** The plugin folder this package ships. */
const SHIPPED = fileURLToPath(new URL('../packages/superworker-core/plugins/', import.meta.url))

test('the vocabulary is the plugin\'s own: the same two constants its storage layer exports', async () => {
  const scopes = await readInstructionScopes(SHIPPED)

  assert.deepEqual(scopes, { valid: [...VALID_SCOPES], retired: [...RETIRED_SCOPES] })
  assert.equal(scopes.retired.includes('node'), true, 'the retired list is the plugin\'s word, read off its own file')
})

test('a folder with no instruction plugin in it: no vocabulary, and no invented list', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'sw-scopes-'))
  try {
    assert.equal(await readInstructionScopes(empty), null)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a file of the wrong shape is no vocabulary: a missing export is not read as an empty list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-scopes-'))
  try {
    const put = (body) => {
      mkdirSync(join(root, 'instruction', 'tools'), { recursive: true })
      writeFileSync(join(root, 'instruction', 'tools', 'storage.mjs'), body, 'utf8')
    }
    put('export const VALID_SCOPES = Object.freeze(["global"]);\n')
    assert.equal(await readInstructionScopes(root), null, 'the retired list is missing, so the file is not this vocabulary')

    put('export const VALID_SCOPES = Object.freeze(["global"]);\nexport const RETIRED_SCOPES = "node";\n')
    assert.equal(await readInstructionScopes(root), null, 'a word is not a list')

    put('export const VALID_SCOPES = Object.freeze([]);\nexport const RETIRED_SCOPES = Object.freeze([]);\n')
    assert.equal(await readInstructionScopes(root), null, 'an issued list naming no word is not a vocabulary')

    put('export const VALID_SCOPES = Object.freeze(["global"]);\nexport const RETIRED_SCOPES = Object.freeze([3]);\n')
    assert.equal(await readInstructionScopes(root), null, 'a list that is not all words is refused rather than half-read')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a real plugin folder that retired nothing is still a vocabulary: the retired list may be empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-scopes-'))
  try {
    cpSync(join(SHIPPED, 'instruction'), join(root, 'instruction'), { recursive: true })
    const storage = join(root, 'instruction', 'tools', 'storage.mjs')
    writeFileSync(
      storage,
      readFileSync(storage, 'utf8').replace(
        "export const RETIRED_SCOPES = Object.freeze(['node'])",
        'export const RETIRED_SCOPES = Object.freeze([])',
      ),
      'utf8',
    )
    assert.deepEqual(await readInstructionScopes(root), { valid: ['global', 'cycle'], retired: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('"do not look at all" opens nothing, and no file is named', async () => {
  assert.equal(await readInstructionScopes(null), null)
  assert.equal(instructionScopesPath(null), null)
  assert.equal(instructionScopesPath(SHIPPED)?.endsWith(join('instruction', 'tools', 'storage.mjs')), true)
})

test('the one judgement the reading makes: a word is retired only when the vocabulary says so', () => {
  const scopes = { valid: ['global', 'cycle'], retired: ['node'] }
  assert.equal(isRetiredScope(scopes, 'node'), true)
  assert.equal(isRetiredScope(scopes, 'global'), false)
  assert.equal(isRetiredScope(scopes, 'once'), false, 'a word nobody declares is not retired — it is unknown, and reads as global')
  assert.equal(isRetiredScope(scopes, undefined), false)
  assert.equal(isRetiredScope(null, 'node'), false, 'a vocabulary that could not be read judges nothing')
})
