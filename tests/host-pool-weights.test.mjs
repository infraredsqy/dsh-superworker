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
import { SuperworkerRecordsGateway } from '../src/host/gateway.ts'
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

/*
 * The host this line really runs on: a Cordis context is a proxy that *refuses* a name no service
 * declares (`cannot get property "<name>" without inject`) instead of answering `undefined`. Every
 * stand-in in this repo is a plain object, so that refusal is the one host shape no other case here
 * has — and it is the shape that took a whole install down: reading the optional folder off such a
 * host threw inside the gateway's constructor, `apply` never finished, the line never activated, and
 * the panel came up with its shell (brand, workspace picker, tabs) and no reading behind it, because
 * no frame ever arrived. A refusal is "this host names no folder", so it must land on the shipped
 * one rather than unwind the line.
 */
test('a host that refuses an undeclared name names no folder: the line still builds and reads', async () => {
  const declared = { workspaceFiles: fakeWorkspaceFiles({}), on: () => () => undefined }
  const cordisLike = new Proxy(declared, {
    get: (target, prop, receiver) => {
      /* Symbols are the proxy's own business (Cordis reads its identity by one), never a service a
       * host would refuse — the real context lets them through the same way. */
      if (typeof prop === 'symbol' || Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  const gateway = new SuperworkerRecordsGateway(cordisLike)
  const reading = await gateway.read('refusing-host-session', 'C:\\refusing-host-workspace')
  assert.deepEqual(reading.poolWeights, { ...SEVERITY_WEIGHTS }, 'the line must fall back to the folder it ships, not fail to activate')
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
