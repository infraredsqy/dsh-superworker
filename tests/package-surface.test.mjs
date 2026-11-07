/* The package surface: the places the shipped artifact must hold up — the prerequisites for
 * "installs, and installs with a panel".
 *
 * These are all invariants: the package must be publishable, `version` must be a real version
 * number, the artifacts both entries point at must fall within `files` coverage, the skills the
 * shipped plugins carry must be in the artifact too, and the profile's mount points and the browser
 * side's declared injection dependencies must still be there.
 *
 * Only `package.json`, the patch file's on-disk presence and the plugin folders under
 * `packages/pf-core/plugins` (which are checked in, not built) are read here — not `lib/` (not built
 * in a fresh clone), and `npm pack` is not run.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { covered, filesUnder } from './helpers/npm-files.mjs'

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))

test('package face: this is a publishable package, and the version is a real number', () => {
  assert.notEqual(manifest.private, true, 'private blocks publish')
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u, `version=${manifest.version}`)
  assert.notEqual(manifest.version, '0.0.0', 'a placeholder version cannot be published')
})

test('package face: the host entry and the browser half both point under lib/, and files covers both', () => {
  assert.equal(manifest.exports['.'].default, './lib/host/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  const files = manifest.files ?? []
  for (const entry of ['./lib/host/index.js', './lib/client.js', './cordis.patch.yml']) {
    const rel = entry.replace(/^\.\//u, '')
    assert.ok(
      files.some((pattern) => covered(pattern, rel)),
      `${rel} is not covered by any files pattern: files=${JSON.stringify(files)}`,
    )
  }
})

test('package face: the types layer ships only .d.ts — no files pattern can pack the .js under lib/types', () => {
  const files = manifest.files ?? []
  for (const pattern of files) {
    assert.ok(
      !covered(pattern, 'lib/types/host/index.js'),
      `${pattern} would pack the .js under lib/types too — that is a bundling input, nothing in the package loads it: files=${JSON.stringify(files)}`,
    )
  }
})

test('package face: the profile\'s mount point and the browser side\'s platform are still there, and the patch file is on disk', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(existsSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))))
})

test('package face: the browser side declares the load dependency it waits on, with `connection` first', () => {
  const inject = manifest.dsh?.client?.inject
  assert.ok(Array.isArray(inject) && inject.length > 0, `dsh.client.inject=${JSON.stringify(inject)}`)
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-connection'),
    'without this dependency declared, the shell does not know to deliver connection first: the panel applies too early and the data seam never connects',
  )
})

test('package face: engines.dsh states a non-empty range', () => {
  assert.equal(typeof manifest.engines?.dsh, 'string')
  assert.ok(manifest.engines.dsh.trim().length > 0)
})

/*
 * No command travels with this package.
 *
 * The pipeline answers in-process: the `pathfinder` tool inside a session, the panel's endpoints, and
 * git's merge driver. Nothing in this artifact is meant to be typed at a shell, so the manifest names
 * no command and the artifact carries no `bin/`.
 */
test('package face: this package ships no command: no `bin` field, no `bin/` under `files`', () => {
  assert.equal(manifest.bin, undefined, `the manifest still ships a command: ${JSON.stringify(manifest.bin)}`)
  const files = manifest.files ?? []
  for (const pattern of files) {
    assert.ok(!pattern.startsWith('bin/'), `files still packs bin/: ${pattern}`)
  }
  assert.equal(existsSync(fileURLToPath(new URL('../bin', import.meta.url))), false, 'bin/ is still on disk')
})

test('package face: the engine build ships with the package, and the build chain builds it first', () => {
  const files = manifest.files ?? []
  for (const rel of ['packages/pf-core/dist/index.mjs', 'packages/pf-core/dist/merge-ledger.mjs']) {
    assert.ok(
      files.some((pattern) => covered(pattern, rel)),
      `${rel} is not in the package: the shipped runtime carries no engine: files=${JSON.stringify(files)}`,
    )
  }
  assert.match(
    manifest.scripts?.['build:products'] ?? '',
    /pnpm --filter pf-core build/u,
    `the build chain does not build the engine, so the dist in the package is stale or missing outright: build:products=${JSON.stringify(manifest.scripts?.['build:products'])}`,
  )
})

/*
 * The build chain has one home: `package.json`'s `build:products`. `prepack` and `npm test` both
 * call it, and the four steps are written only there — a step dropped from the chain, or a caller
 * drifting off it, ships an artifact nobody can load while every other case stays green.
 * `docs/publish.md` and `tools/test-all.mjs` point back at this name instead of repeating the steps;
 * prose cannot be asserted, so this case is what holds the name in place.
 */
test('package face: the build chain has one home, prepack and test both call it, and each of the four steps is in the chain', () => {
  const scripts = manifest.scripts ?? {}
  for (const caller of ['prepack', 'test']) {
    assert.match(
      scripts[caller] ?? '',
      /npm run build:products/u,
      `${caller} does not walk the same build chain: ${caller}=${JSON.stringify(scripts[caller])}`,
    )
  }
  const chain = scripts['build:products'] ?? ''
  const steps = [
    ['engine build', /pnpm --filter pf-core build/u],
    ['types', /npm run types(?![\w:])/u],
    ['host half', /npm run bundle(?![\w:])/u],
    ['browser half', /npm run bundle:client/u],
  ]
  for (const [label, pattern] of steps) {
    assert.match(chain, pattern, `build:products is missing the ${label} step: build:products=${JSON.stringify(chain)}`)
  }
})

/*
 * Both spellings of the types entry — the manifest's `types` and `exports['.'].types` — must land
 * inside `files`. They are read by different tooling (a path reader and an exports resolver), so one
 * of them dropping out of the package loses types for half the callers with nothing failing.
 */
test('package face: both spellings of the types entry land in files', () => {
  const files = manifest.files ?? []
  for (const target of [manifest.types, manifest.exports?.['.']?.types]) {
    assert.equal(typeof target, 'string', `the manifest does not write a types entry: ${JSON.stringify(target)}`)
    const rel = target.replace(/^\.\//u, '')
    assert.ok(
      files.some((pattern) => covered(pattern, rel)),
      `${rel} is not covered by any files pattern: files=${JSON.stringify(files)}`,
    )
  }
})

/*
 * The three runtime mouths are the package's whole face at runtime: the host hand (`.`), the browser
 * hand (`./client`), the locale metadata (`./locale/*.json`). The two non-code entries ride along so
 * a profile layer and the manifest itself can be read out of the installed tree. A key appearing or
 * vanishing here changes what an installer can reach, and no build step would notice.
 */
test('package face: the exports key set is the three runtime mouths plus cordis.patch.yml and package.json', () => {
  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).sort(),
    ['.', './client', './cordis.patch.yml', './locale/*.json', './package.json'].sort(),
  )
})

/*
 * The plugins this package ships, folder and all: `packages/pf-core/plugins/<plugin>/` carries the
 * declaration, the implementation and the skills, and the host half reads a plugin's skills straight
 * out of it at load. A folder that ships only in the checkout is a panel whose skills appear for the
 * author and for nobody who installed the package — and the failure is silent, because a plugin
 * directory that holds nothing is a normal state to the engine.
 *
 * Every file of every plugin folder is required to be covered: a skill points at its siblings
 * (`anti-patterns.md`, `pool.md`), so a half-shipped folder installs a body that references files that
 * are not there.
 */
test('package face: the shipped plugin directories go in whole, and no plugin skill file is missing', () => {
  const pluginsDir = fileURLToPath(new URL('../packages/pf-core/plugins', import.meta.url))
  assert.ok(existsSync(pluginsDir), 'packages/pf-core/plugins is not on disk: the skills have no source')
  const files = manifest.files ?? []
  const shipped = filesUnder(pluginsDir).map((relative) => `packages/pf-core/plugins/${relative}`)
  assert.ok(shipped.length > 0, 'packages/pf-core/plugins is empty')
  const uncovered = shipped.filter((relative) => !files.some((pattern) => covered(pattern, relative)))
  assert.deepEqual(uncovered, [], 'these plugin files are not covered by any files pattern, so the installed product lacks them')
})

test('package face: every SKILL.md a plugin hands out is on disk and has a place in the package', () => {
  const pluginsDir = fileURLToPath(new URL('../packages/pf-core/plugins', import.meta.url))
  const files = manifest.files ?? []
  const skills = filesUnder(pluginsDir).filter((relative) => relative.endsWith('/SKILL.md'))
  assert.ok(skills.length > 0, 'no plugin in the package carries a skill')
  for (const relative of skills) {
    const full = `packages/pf-core/plugins/${relative}`
    assert.ok(files.some((pattern) => covered(pattern, full)), `${full} is not in the package`)
  }
})

/*
 * The package's own locale metadata: DSH's plugin inventory reads `locale/<id>.json` to say what this
 * line is called, in the reader's language. It is a separate surface from the panel's word table —
 * that one lives in the browser bundle and words the panel — so it gets its own guard: a metadata
 * file that exists on disk but is not exported, or not covered by `files`, is simply absent from the
 * published package, and the inventory line falls back to the raw package name with nothing failing.
 */
test('package face: both locale metadata files are on disk, each with a non-empty title', async () => {
  for (const locale of ['zh', 'en']) {
    const path = fileURLToPath(new URL(`../locale/${locale}.json`, import.meta.url))
    assert.ok(existsSync(path), `locale/${locale}.json is not on disk`)
    const held = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    assert.equal(typeof held.meta?.title, 'string')
    assert.ok(held.meta.title.trim().length > 0, `locale/${locale}.json has an empty meta.title`)
    assert.ok(held.meta.title !== locale, `locale/${locale}.json meta.title is still the language name itself`)
  }
})

test('package face: locale metadata is both exported and packed by files', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'without this exports entry the shell cannot reach the metadata')
  const files = manifest.files ?? []
  for (const locale of ['zh', 'en']) {
    assert.ok(
      files.some((pattern) => covered(pattern, `locale/${locale}.json`)),
      `locale/${locale}.json is not covered by any files pattern: files=${JSON.stringify(files)}`,
    )
  }
})