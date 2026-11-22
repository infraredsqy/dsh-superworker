/* The weight table's one home: the issue plugin's own declaration, and everywhere else derives from it.
 *
 * The spec's completion criterion is a repo-wide search: the hits are one source plus its own
 * derivatives, and you can say which one is the source. This file is that search, kept as a guard
 * rather than as a sentence in a report — a second copy of the numbers (in a doc, a skill's prose, a
 * constant on the host side) turns it red on the spot.
 *
 * **What counts as a hit** is a statement that reproduces the table's *values*: two or more tiers,
 * each paired with the number this plugin's own constant gives it. That precision is the whole
 * difficulty of this guard, and it is deliberate on two sides:
 *
 * - A list of tier names is not a copy: `P0 / P1 / P2 / P3` names the four bands and no numbers.
 * - Neither is a different set of numbers about the same tiers: `SEVERITY_RANK` orders the tiers
 *   `0/1/2/3` for sorting, and an issue count per tier (`{ P0: 1, P1: 1 }`) counts cases. Both are
 *   derived readings *about* tiers, not the table. Only values that agree with the source count.
 *
 * The expected numbers are read off the plugin itself, never written down here — a guard that spells
 * the table would be the second copy it exists to find.
 *
 * The fixtures under the engine's corpus are the plugin's own files copied byte for byte
 * (`plugin-issue-close-insert`'s test asserts that equality), so a hit there is the same file, not a
 * second home; it is skipped by path, and the copy's byte-equality is that test's job, not this one's.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEVERITY_WEIGHTS } from '../packages/superworker-core/plugins/issue/tools/storage.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

/** The one source: the issue plugin's storage layer, where `SEVERITY_WEIGHTS` is declared. */
const SOURCE = join(repo, 'packages', 'superworker-core', 'plugins', 'issue', 'tools', 'storage.mjs')

/** Where a copy is not a second home: the corpus fixture the plugin's byte-equality test pins to this very file. */
const FIXTURE_DIR = join(repo, 'packages', 'superworker-core', 'tests', 'fixtures')

/** Not the repo's authored text: build output, dependencies, and the pipeline's own local record. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', '.superworker', '.tmp'])

/** Files whose contents are not text. */
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zip'])

/**
 * One tier and the number standing next to it, in the spellings a copy really takes: the object cell
 * (`P<n>: <number>`), a table row (`| P<n> | <number> |`), an assignment (`P<n> = <number>`), and the
 * run a comment writes when it adds the weights up (`P<n>(<number>) + …`). At most six characters
 * between the two, none of them a letter or a digit, so a tier name cannot reach across a sentence —
 * or across a tier name — to a number about something else.
 */
const TIER_PAIR = /\bP([0-3])\b[^A-Za-z0-9\n]{0,6}(\d+)/gu

/**
 * The sentence spelling the old arrangement used: a chain of tiers equals a run of numbers
 * (`P0/P1/P2/P3 = …`). Caught separately because no single tier sits next to its own number there —
 * the numbers are stated as a run, in the chain's own order.
 */
const TIER_CHAIN = /((?:\bP[0-3]\b\s*\/\s*){1,}\bP[0-3]\b)\s*=\s*([\d\s/]+)/gu

/** Whether one tier paired with this number reproduces the source, i.e. is a statement of the table. */
function agrees(tier, value) {
  return SEVERITY_WEIGHTS[`P${tier}`] === Number(value)
}

/** Whether one line of text reproduces the table's values in the way a copy does. */
export function statesTable(line) {
  const pairs = [...line.matchAll(TIER_PAIR)].filter((found) => agrees(found[1], found[2]))
  if (pairs.length >= 2) return true
  for (const found of line.matchAll(TIER_CHAIN)) {
    const tiers = [...found[1].matchAll(/P([0-3])/gu)].map((one) => one[1])
    const numbers = found[2].split('/').map((one) => one.trim()).filter((one) => one !== '')
    if (tiers.length < 2 || numbers.length !== tiers.length) continue
    if (tiers.every((tier, at) => agrees(tier, numbers[at]))) return true
  }
  return false
}

/** Every authored file under `dir`, skipping build output, the pinned fixture, and binaries. */
function filesUnder(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (join(dir, entry.name) === FIXTURE_DIR) continue
      found.push(...filesUnder(join(dir, entry.name)))
    } else {
      const dot = entry.name.lastIndexOf('.')
      if (dot >= 0 && SKIP_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
      found.push(join(dir, entry.name))
    }
  }
  return found
}

/** The lines of one file that state the table, with their numbers. */
function tableStatements(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .flatMap((line, at) => (statesTable(line) ? [{ at: at + 1, line: line.trim() }] : []))
}

test('the weight table has one home: the only statements of its values are in the source itself', () => {
  const hits = filesUnder(repo).flatMap((file) => tableStatements(file).map((statement) => ({ file, ...statement })))

  assert.ok(
    hits.some((hit) => hit.file === SOURCE),
    'the source itself must be found, or this guard is measuring nothing',
  )

  assert.deepEqual(
    hits.filter((hit) => hit.file !== SOURCE).map((hit) => `${relative(repo, hit.file)}:${hit.at} ${hit.line}`),
    [],
    'the table is stated outside its one home: derive it from SEVERITY_WEIGHTS instead of copying the numbers',
  )
})

test('what the guard would catch, and what it must not: composed here so no copy is written to prove it', () => {
  /* A detector that can no longer see the shape it pins reads exactly like a clean repo. The shapes are
   * built out of the source's own numbers at run time — spelling them here would be the very copy this
   * file forbids. */
  const cell = (tier) => `${tier}: ${String(SEVERITY_WEIGHTS[tier])}`
  const object = `export const SEVERITY_WEIGHTS = Object.freeze({ ${Object.keys(SEVERITY_WEIGHTS).map(cell).join(', ')} })`
  const row = `| ${Object.keys(SEVERITY_WEIGHTS).map((tier) => `${tier} | ${String(SEVERITY_WEIGHTS[tier])}`).join(' | ')} |`
  const chain = `${Object.keys(SEVERITY_WEIGHTS).join('/')} = ${Object.values(SEVERITY_WEIGHTS).join('/')}`

  assert.equal(statesTable(object), true, 'the object spelling is a copy of the table')
  assert.equal(statesTable(row), true, 'a table row spelling it out is a copy')
  assert.equal(statesTable(`each tier counts by ${chain}`), true, 'the run spelling is a copy')
  assert.equal(
    statesTable(Object.keys(SEVERITY_WEIGHTS).map((tier) => `${tier}(${String(SEVERITY_WEIGHTS[tier])})`).join(' + ')),
    true,
    'the bracketed run a comment adds the weights up with is a copy too',
  )

  /* The near misses: same tiers, other numbers, and no numbers at all. */
  assert.equal(statesTable(`severity | ${Object.keys(SEVERITY_WEIGHTS).join(' / ')}`), false, 'tier names with no numbers name the bands, they do not copy the table')
  assert.equal(statesTable('const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 }'), false, 'the sort order is about the tiers, not the table')
  assert.equal(statesTable('expect(by_severity).toEqual({ P0: 1, P1: 1, P2: 1 })'), false, 'a count per tier is a reading about the pool, not the table')
  assert.equal(statesTable('P0 is duplicated and carries a bug risk; P1 crosses a line'), false, 'the bands in prose carry no numbers at all')
})
