/* The engine's way into the shipped artifact.
 *
 * The engine lives in this repo as its own package (`packages/pf-core`), and the install face
 * stays one plugin package: the host build has to inline the engine's product rather than leave a
 * package a user would have to install beside it. What is locked here is the shape that carries
 * that, not the wiring — which host module imports the engine belongs to the nodes that give the
 * host half its engine-backed work.
 *
 * Three legs:
 *
 * - the engine is a workspace package of this repo, linked at `node_modules/pf-core`, so the host
 *   half reaches it by name (`from 'pf-core'`) the way it reaches any dependency;
 * - the repo's own build externals — the `deps.neverBundle` list `tsdown.config.ts` carries — name
 *   nothing of the engine: the bundler holds no instruction to leave it out;
 * - a bundle whose entry imports the engine by that name comes out carrying the engine's code and
 *   pointing at nothing but `node:` built-ins: engine inside the artifact, no reference back to a
 *   package. The probe entry is written under `.tmp/`, where the name resolves exactly as it does
 *   from `src/host/`: both walk up to this repo's `node_modules`.
 *
 * The engine's product is what the host half will import, and `npm test` builds it before the
 * suite runs (`pnpm --filter pf-core build`, wired into package.json's `test`). Without it the two
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
const engineDir = join(root, 'packages', 'pf-core')
const engineProduct = join(engineDir, 'dist', 'index.mjs')
const built = existsSync(engineProduct)
const notBuilt = `packages/pf-core/dist/index.mjs is not built yet; npm test builds it first (pnpm --filter pf-core build)`

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
 * the pattern matters: a filter applied after a looser match would swallow `from "pf-core"` sitting
 * right behind such a sentence, and the scan would answer green to the one accident it exists for.
 */
function outsideSpecifiers(code) {
  const out = new Set()
  for (const match of code.matchAll(/(?:from|import)\s*(["'])([^\s"'{}[\]]+)\1/gu)) out.add(match[2])
  return [...out]
}

test('包面：扫描不放过紧贴散文的 specifier——散文里的 `from"` 不能把下一条外置吞掉', () => {
  // The accident this whole file exists for, placed where the bundle's own prose makes it easiest to
  // lose: a sentence ending in `from"`, then an import spelled with the same quote style right behind
  // it. A scan that matches loosely and then filters its findings answers `[]` here.
  assert.deepEqual(outsideSpecifiers('nothing to pick from" from "pf-core"'), ['pf-core'])
})

test('包面：引擎是本仓的 workspace 包，宿主半身按名字就能到它', () => {
  const link = join(root, 'node_modules', 'pf-core')
  assert.ok(existsSync(link), 'node_modules/pf-core 不在：pnpm install 没有把 workspace 包链上')
  assert.equal(realpathSync(link), realpathSync(engineDir), 'node_modules/pf-core 指向的不是本仓那个引擎包')
  const manifest = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'pf-core')
  assert.equal(manifest.private, true, '引擎包是私有包：它不发版，只随宿主这一份产物出去')
})

test('包面：外置面里没有引擎——构建没有哪条指令把它留在包外', () => {
  const offenders = neverBundle.filter((spec) => spec === 'pf-core' || spec.startsWith('pf-core/'))
  assert.deepEqual(
    offenders,
    [],
    `tsdown.config.ts 的 deps.neverBundle 把引擎外置了：${JSON.stringify(neverBundle)}`,
  )
})

test('包面：宿主半身按名字取到的是引擎自己的产物', { skip: built ? false : notBuilt }, () => {
  const resolved = import.meta.resolve('pf-core')
  assert.equal(
    fileURLToPath(resolved),
    engineProduct,
    "by-name import no longer lands on the engine package's own product",
  )
})

test('包面：一条 import 引擎的入口打成自足的一份：引擎代码在里面，外头不指回包', { skip: built ? false : notBuilt }, async () => {
  mkdirSync(join(root, '.tmp'), { recursive: true })
  const probeDir = mkdtempSync(join(root, '.tmp', 'engine-inline-'))
  try {
    const entry = join(probeDir, 'entry.mjs')
    writeFileSync(entry, "export { SimulatedExecutor, open } from 'pf-core'\n", 'utf8')
    const bundle = await rolldown({ input: entry, platform: 'node', external: [...neverBundle] })
    const pieces = (await bundle.generate({ format: 'esm' })).output
    await bundle.close()
    const chunk = pieces.find((piece) => piece.type === 'chunk')
    assert.ok(chunk !== undefined, 'the bundle produced no code')
    assert.ok(chunk.code.includes('SimulatedExecutor'), '产物里没有引擎的代码：引擎没被打进这一份')
    const outside = outsideSpecifiers(chunk.code).filter((spec) => !spec.startsWith('node:'))
    assert.deepEqual(outside, [], `产物还在指往外头的东西：${JSON.stringify(outside)}`)
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})