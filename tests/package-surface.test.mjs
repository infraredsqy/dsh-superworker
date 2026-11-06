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

test('包面：这是一个可发布的包，版本号是一个真号', () => {
  assert.notEqual(manifest.private, true, 'private 拦着 publish')
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u, `version=${manifest.version}`)
  assert.notEqual(manifest.version, '0.0.0', '占位版本号发不出去')
})

test('包面：宿主入口与浏览器半身都指在 lib/ 下，且两份都被 files 盖住', () => {
  assert.equal(manifest.exports['.'].default, './lib/host/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  const files = manifest.files ?? []
  for (const entry of ['./lib/host/index.js', './lib/client.js', './cordis.patch.yml']) {
    const rel = entry.replace(/^\.\//u, '')
    assert.ok(
      files.some((pattern) => covered(pattern, rel)),
      `${rel} 没有被 files 里任何一条盖住：files=${JSON.stringify(files)}`,
    )
  }
})

test('包面：类型那一层只发 .d.ts——files 里没有哪条能把 lib/types 的 .js 一起装进包', () => {
  const files = manifest.files ?? []
  for (const pattern of files) {
    assert.ok(
      !covered(pattern, 'lib/types/host/index.js'),
      `${pattern} 会把 lib/types 下那份 .js 一起装进包——那是打包的输入，包里没有任何东西加载它：files=${JSON.stringify(files)}`,
    )
  }
})

test('包面：profile 里的挂载点与浏览器那一侧的 platform 都还在，patch 文件在盘上', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(existsSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))))
})

test('包面：浏览器那一侧声明了它等的加载依赖，`connection` 那一条排在前头', () => {
  const inject = manifest.dsh?.client?.inject
  assert.ok(Array.isArray(inject) && inject.length > 0, `dsh.client.inject=${JSON.stringify(inject)}`)
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-connection'),
    '没声明这条依赖，外壳就不知道要先把 connection 送达，面板应用得早、取数口子接不上',
  )
})

test('包面：engines.dsh 写着一段非空的范围', () => {
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
test('包面：这份包不交任何命令，`bin` 字段与 `files` 里都没有 `bin/`', () => {
  assert.equal(manifest.bin, undefined, `清单还在交命令：${JSON.stringify(manifest.bin)}`)
  const files = manifest.files ?? []
  for (const pattern of files) {
    assert.ok(!pattern.startsWith('bin/'), `files 还在收 bin/：${pattern}`)
  }
  assert.equal(existsSync(fileURLToPath(new URL('../bin', import.meta.url))), false, 'bin/ 还在盘上')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'profile 里那一行的挂载点动了')
})

test('包面：引擎的构建产物随包走，`prepack` 先把它构建出来', () => {
  const files = manifest.files ?? []
  for (const rel of ['packages/pf-core/dist/index.mjs', 'packages/pf-core/dist/merge-ledger.mjs']) {
    assert.ok(
      files.some((pattern) => covered(pattern, rel)),
      `${rel} 没进包：装出去的运行时身上没有引擎：files=${JSON.stringify(files)}`,
    )
  }
  assert.match(
    manifest.scripts?.prepack ?? '',
    /pnpm --filter pf-core build/u,
    `prepack 不构建引擎，包里那份 dist 就是旧的或者根本没有：prepack=${JSON.stringify(manifest.scripts?.prepack)}`,
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
test('包面：随包走的插件目录整个进包，插件技能的文件一个都不少', () => {
  const pluginsDir = fileURLToPath(new URL('../packages/pf-core/plugins', import.meta.url))
  assert.ok(existsSync(pluginsDir), 'packages/pf-core/plugins 不在盘上：技能就没有来源了')
  const files = manifest.files ?? []
  const shipped = filesUnder(pluginsDir).map((relative) => `packages/pf-core/plugins/${relative}`)
  assert.ok(shipped.length > 0, 'packages/pf-core/plugins 是空的')
  const uncovered = shipped.filter((relative) => !files.some((pattern) => covered(pattern, relative)))
  assert.deepEqual(uncovered, [], '这些插件文件没被 files 里任何一条盖住，装成品里就没有它们')
})

test('包面：插件交出的每一个 SKILL.md 都在盘上，且包里有它的位置', () => {
  const pluginsDir = fileURLToPath(new URL('../packages/pf-core/plugins', import.meta.url))
  const files = manifest.files ?? []
  const skills = filesUnder(pluginsDir).filter((relative) => relative.endsWith('/SKILL.md'))
  assert.ok(skills.length > 0, '包里的插件一个技能都不带')
  for (const relative of skills) {
    const full = `packages/pf-core/plugins/${relative}`
    assert.ok(files.some((pattern) => covered(pattern, full)), `${full} 没进包`)
  }
})

/*
 * The package's own locale metadata: DSH's plugin inventory reads `locale/<id>.json` to say what this
 * line is called, in the reader's language. It is a separate surface from the panel's word table —
 * that one lives in the browser bundle and words the panel — so it gets its own guard: a metadata
 * file that exists on disk but is not exported, or not covered by `files`, is simply absent from the
 * published package, and the inventory line falls back to the raw package name with nothing failing.
 */
test('包面：语言元数据两份都在盘上，各自的标题非空', async () => {
  for (const locale of ['zh', 'en']) {
    const path = fileURLToPath(new URL(`../locale/${locale}.json`, import.meta.url))
    assert.ok(existsSync(path), `locale/${locale}.json 不在盘上`)
    const held = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    assert.equal(typeof held.meta?.title, 'string')
    assert.ok(held.meta.title.trim().length > 0, `locale/${locale}.json 的 meta.title 是空的`)
    assert.ok(held.meta.title !== locale, `locale/${locale}.json 的 meta.title 还是语言名本身`)
  }
})

test('包面：语言元数据既经 exports 放行，也被 files 收进包', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', '没有这条 exports，外壳取不到元数据')
  const files = manifest.files ?? []
  for (const locale of ['zh', 'en']) {
    assert.ok(
      files.some((pattern) => covered(pattern, `locale/${locale}.json`)),
      `locale/${locale}.json 没有被 files 里任何一条盖住：files=${JSON.stringify(files)}`,
    )
  }
})