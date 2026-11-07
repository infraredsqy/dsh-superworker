/* The engine's way into the shipped artifact.
 *
 * The engine lives in this repo as its own package (`packages/superworker-core`), and the install face
 * stays one plugin package: the host build has to inline the engine's product rather than leave a
 * package a user would have to install beside it. What is locked here is the shape that carries
 * that, not the wiring — which host module imports the engine belongs to the nodes that give the
 * host half its engine-backed work.
 *
 * Three legs:
 *
 * - the engine is a workspace package of this repo, linked at `node_modules/superworker-core`, so the host
 *   half reaches it by name (`from 'superworker-core'`) the way it reaches any dependency;
 * - the repo's own build externals — the `deps.neverBundle` list `tsdown.config.ts` carries — name
 *   nothing of the engine: the bundler holds no instruction to leave it out;
 * - a bundle whose entry imports the engine by that name comes out carrying the engine's code and
 *   pointing at nothing but `node:` built-ins: engine inside the artifact, no reference back to a
 *   package. The probe entry is written under `.tmp/`, where the name resolves exactly as it does
 *   from `src/host/`: both walk up to this repo's `node_modules`.
 *
 * The engine's product is what the host half will import, and `npm test` builds it before the
 * suite runs (`pnpm --filter superworker-core build`, wired into package.json's `test`). Without it the two
 * legs that need the product skip themselves with the reason — the same discipline as the browser
 * half's render case.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('..', import.meta.url))
const engineDir = join(root, 'packages', 'superworker-core')
const engineProduct = join(engineDir, 'dist', 'index.mjs')
const built = existsSync(engineProduct)
const notBuilt = `packages/superworker-core/dist/index.mjs is not built yet; npm test builds it first (pnpm --filter superworker-core build)`

/** The externals the repo's own host build keeps out of the bundle, read from the config the build runs. */
const { default: tsdownConfig } = await import('../tsdown.config.ts')
const neverBundle = tsdownConfig.deps?.neverBundle ?? []

/**
 * Every specifier the bundle still reaches for: `from '…'` and a bare `import '…'`.
 *
 * A module specifier is one word between the two quotes of one style, and the whole match is spelled
 * out here: no whitespace inside, no brace, and the closing quote is the same style the opening one
 * was. The engine's own word table travels in the bundle as literal text too, and a sentence that
 * happens to end in `from` sits in front of a quote exactly where a specifier would
 * (`… nothing to pick from"`), so the pattern itself refuses what a specifier cannot be. Tightening
 * the pattern matters: a filter applied after a looser match would swallow `from "superworker-core"` sitting
 * right behind such a sentence, and the scan would answer green to the one accident it exists for.
 */
function outsideSpecifiers(code) {
  const out = new Set()
  for (const match of code.matchAll(/(?:from|import)\s*(["'])([^\s"'{}[\]]+)\1/gu)) out.add(match[2])
  return [...out]
}

test('package face: the scan does not miss a specifier hugging prose — a `from"` in prose must not swallow the next externals entry', () => {
  // The accident this whole file exists for, placed where the bundle's own prose makes it easiest to
  // lose: a sentence ending in `from"`, then an import spelled with the same quote style right behind
  // it. A scan that matches loosely and then filters its findings answers `[]` here.
  assert.deepEqual(outsideSpecifiers('nothing to pick from" from "superworker-core"'), ['superworker-core'])
})

test('package face: the engine is this repo\'s workspace package, the host half reaches it by name', () => {
  const link = join(root, 'node_modules', 'superworker-core')
  assert.ok(existsSync(link), 'node_modules/superworker-core is missing: pnpm install did not link the workspace package')
  assert.equal(realpathSync(link), realpathSync(engineDir), 'node_modules/superworker-core does not point at this repo\'s engine package')
  const manifest = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'superworker-core')
  assert.equal(manifest.private, true, 'the engine package is private: it is not released on its own, it ships inside the host build')
})

test('package face: the engine is not among the externals — no build directive leaves it outside the bundle', () => {
  const offenders = neverBundle.filter((spec) => spec === 'superworker-core' || spec.startsWith('superworker-core/'))
  assert.deepEqual(
    offenders,
    [],
    `tsdown.config.ts deps.neverBundle externalized the engine: ${JSON.stringify(neverBundle)}`,
  )
})

test('package face: what the host half gets by name is the engine\'s own product', { skip: built ? false : notBuilt }, () => {
  const resolved = import.meta.resolve('superworker-core')
  assert.equal(
    fileURLToPath(resolved),
    engineProduct,
    "by-name import no longer lands on the engine package's own product",
  )
})

test('package face: an entry importing the engine bundles into a self-contained chunk: the engine code is inside, nothing points back out to the package', { skip: built ? false : notBuilt }, async () => {
  mkdirSync(join(root, '.tmp'), { recursive: true })
  const probeDir = mkdtempSync(join(root, '.tmp', 'engine-inline-'))
  try {
    const entry = join(probeDir, 'entry.mjs')
    writeFileSync(entry, "export { SimulatedExecutor, open } from 'superworker-core'\n", 'utf8')
    const bundle = await rolldown({ input: entry, platform: 'node', external: [...neverBundle] })
    const pieces = (await bundle.generate({ format: 'esm' })).output
    await bundle.close()
    const chunk = pieces.find((piece) => piece.type === 'chunk')
    assert.ok(chunk !== undefined, 'the bundle produced no code')
    assert.ok(chunk.code.includes('SimulatedExecutor'), 'the engine code is not in the product: the engine was not bundled into this one')
    const outside = outsideSpecifiers(chunk.code).filter((spec) => !spec.startsWith('node:'))
    assert.deepEqual(outside, [], `the product still points at something outside: ${JSON.stringify(outside)}`)
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})