/* The host half's weight-table segment: invariants only — the table comes from the issue plugin's own
 * declaration (the constant its `issue weight` command adds up by), it rides the reading, and a
 * table that cannot be obtained comes back as `null` rather than as a set of zeros.
 *
 * Nothing here pins the tier numbers: those live in the plugin and nowhere else, so a case that wrote
 * `{ P0: 8, … }` down here would be the second copy this whole arrangement exists to prevent. What is
 * compared is the identity — the table the seam answers *is* what the plugin's own file exports.
 *
 * Every case but the last reads the seam out of `src/`: no build and no `lib/` needed, since the seam
 * loads the plugin file the way the engine loads a plugin entry. The last one stages the *installed*
 * layout — the bundle at `lib/host/index.js`, the plugins beside `package.json` — because the folder
 * that path walks up to is the one thing no source-tree case can see.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { poolWeightsPath, readPoolWeights } from '../src/host/pool-weights.ts'
import { readReading } from '../src/host/records.ts'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'
import { readPool } from '../src/model/index.ts'
import { fakeWorkspaceFiles } from './helpers/workspace-files-port.mjs'
import { SEVERITY_WEIGHTS } from '../packages/superworker-core/plugins/issue/tools/storage.mjs'

/** This checkout's root: the `.tmp/` the staged package is built under, and the plugin folder it copies. */
const repo = fileURLToPath(new URL('..', import.meta.url))

/** The built host half — the artifact an install actually loads, and the thing whose walk has to land. */
const HOST_BUNDLE = join(repo, 'lib', 'host', 'index.js')

/** Why the installed-layout case has to skip, or `false` when the host bundle is there. */
const hostBundleSkip = existsSync(HOST_BUNDLE)
  ? false
  : `${HOST_BUNDLE} is not there: run npm run types && npm run bundle first (npm test builds it first)`

test('the table the host obtains is the issue plugin\'s own constant, not a copy of it', async () => {
  const table = await readPoolWeights()

  assert.notEqual(table, null, 'the shipped plugin folder really has a table')
  assert.deepEqual(table, { ...SEVERITY_WEIGHTS }, 'the host read a different table than the plugin declares: there is a second copy somewhere')
  assert.notEqual(table, SEVERITY_WEIGHTS, 'the table is copied out, so a caller cannot mutate the plugin\'s own constant')
})

test('the shipped plugin folder answers by default; the file it is read from is that plugin\'s storage layer', async () => {
  const path = poolWeightsPath()

  assert.equal(path, join(shippedPluginsDir(), 'issue', 'tools', 'storage.mjs'))
  assert.deepEqual(await readPoolWeights(undefined), await readPoolWeights(shippedPluginsDir()), 'an absent folder is the shipped one')
})

test('a folder with no issue plugin in it: no table, and no zeros standing in for one', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'sw-weights-'))
  try {
    assert.equal(await readPoolWeights(empty), null, 'a folder that holds no such plugin cannot produce a table')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a table of the wrong shape is no table: an empty one would weigh every tier as 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-weights-'))
  try {
    const put = (body) => {
      mkdirSync(join(root, 'issue', 'tools'), { recursive: true })
      writeFileSync(join(root, 'issue', 'tools', 'storage.mjs'), body, 'utf8')
    }
    put('export const SEVERITY_WEIGHTS = Object.freeze({});\n')
    assert.equal(await readPoolWeights(root), null, 'an empty table is refused: read as weights it would say every tier is free')

    put('export const SEVERITY_WEIGHTS = Object.freeze({ P0: 8, P1: "four" });\n')
    assert.equal(await readPoolWeights(root), null, 'a non-numeric entry is refused rather than half-read')

    put('export const SOMETHING_ELSE = Object.freeze({ P0: 8 });\n')
    assert.equal(await readPoolWeights(root), null, 'the constant is spelled by its own name; another export is not it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('"do not look at all" really opens nothing: the caller that passes null gets no table', async () => {
  assert.equal(await readPoolWeights(null), null)
  assert.equal(poolWeightsPath(null), null, 'and there is no file to name either')
})

test('the reading carries the table, and the pool weighed by it is the plugin\'s own sum, not one this side invented', async () => {
  /* The end of the chain the panel draws from: the host hands the records *and* the table over, and the
   * model weighs the pool by that table. A reading without it would make every weight `null` — the
   * honest answer, and the one the gauge refuses to draw. */
  const scope = { sessionId: 'weights-session', workspaceRoot: 'C:\\weights-workspace' }
  const signal = new AbortController().signal
  const files = {
    '.superworker/issues/issues.json': JSON.stringify({
      issues: {
        heavy: { id: 'heavy', severity: 'P0', status: 'open', decision: 'unknown', discovered: '2026-01-01T00:00:00.000Z' },
        light: { id: 'light', severity: 'P3', status: 'open', decision: 'unknown', discovered: '2026-01-01T00:00:00.000Z' },
      },
    }),
  }
  const withTable = await readReading(fakeWorkspaceFiles(files), scope, signal, await readPoolWeights())
  const withoutTable = await readReading(fakeWorkspaceFiles(files), scope, signal, null)

  const read = (reading) => readPool(
    reading.cycles,
    reading.issues,
    reading.poolWeights,
    new Date('2026-03-10T12:00:00.000Z'),
  )
  assert.deepEqual(withTable.poolWeights, { ...SEVERITY_WEIGHTS }, 'the frame the panel draws from carries the table')
  assert.equal(
    read(withTable).weight,
    (SEVERITY_WEIGHTS.P0 ?? 0) + (SEVERITY_WEIGHTS.P3 ?? 0),
    'the pool sums to what the plugin\'s own constant says: a second copy would show up as a different total',
  )
  assert.equal(withoutTable.poolWeights, null, 'a reading with no table says so')
  assert.equal(read(withoutTable).weight, null, 'and its pool has no weight at all — never a sum of 0')
})

/*
 * The road that only exists once this line is installed: the *bundled* host half walks up from
 * `lib/host/index.js` to the package root and reads the plugin folder shipped there. Nothing about
 * that is visible from `src/`, so every case above stays green if the walk lands one level off — the
 * panel would simply never draw a gauge, and no error would be raised anywhere. This case stages both
 * halves of an installed package and drives the real gateway, so a wrong depth is red on the spot.
 *
 * The plugin folder is copied, not moved, and the staged package lives under `.tmp/` — the same
 * placement `engine-inline` uses, where module resolution still finds this repo's `node_modules`.
 * Two separate stage roots on purpose: the seam answers each folder once, so asking a second time
 * about a folder whose plugins were just removed would be answered by that cache, not by the disk.
 */
test('the installed layout: the bundled host half finds the plugins beside its package root, and a package without them answers null', { skip: hostBundleSkip }, async () => {
  const plugins = join(repo, 'packages', 'superworker-core', 'plugins')
  mkdirSync(join(repo, '.tmp'), { recursive: true })

  /** One staged package root: `lib/host/index.js` plus (optionally) the plugin folder a real install carries. */
  const made = []
  const stage = (name, withPlugins) => {
    const dir = mkdtempSync(join(repo, '.tmp', `${name}-`))
    made.push(dir)
    mkdirSync(join(dir, 'lib', 'host'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-superworker', type: 'module' }), 'utf8')
    cpSync(HOST_BUNDLE, join(dir, 'lib', 'host', 'index.js'))
    if (withPlugins) cpSync(plugins, join(dir, 'packages', 'superworker-core', 'plugins'), { recursive: true })
    return dir
  }

  /** The table the bundled gateway reads, off the reading it hands the panel. */
  const tableOf = async (dir) => {
    const mod = await import(pathToFileURL(join(dir, 'lib', 'host', 'index.js')).href)
    const gateway = new mod.SuperworkerRecordsGateway({ workspaceFiles: fakeWorkspaceFiles({}) })
    return (await gateway.read('installed-layout-session', 'C:\\installed-layout-workspace')).poolWeights
  }

  try {
    const shipped = stage('installed-layout', true)
    const shippedWithoutPlugins = stage('installed-layout-bare', false)
    assert.deepEqual(await tableOf(shipped), { ...SEVERITY_WEIGHTS }, 'the installed package no longer reaches the plugin folder it ships: the walk from lib/host/index.js lands somewhere else')
    assert.equal(await tableOf(shippedWithoutPlugins), null, 'a package whose plugin folder is missing still answers null, never a table of zeros')
  } finally {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  }
})
