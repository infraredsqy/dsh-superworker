/* The shipped runtime assembled outside this repo: the command and the engine it carries.
 *
 * Installing the command does not install the checkout. `npm install --global` unpacks the artifact
 * into a directory of its own, and from there neither `bin/` nor the engine may reach back into this
 * repository: a `pf` that runs from the repo's own `node_modules` answers with the working tree's
 * engine, which is exactly the live wire the switch cuts. So the artifact has to carry both halves —
 * `bin/` and the engine's built product — and the command has to find the engine beside itself when
 * the package name resolves nowhere.
 *
 * Five legs, all over a copy assembled under `os.tmpdir()` (outside every `node_modules` walk-up
 * from this repo, so the by-name route really is gone):
 *
 * - `version` runs, exits 0, prints a real version number;
 * - every path it prints is under that copy — the runtime is that directory, not this checkout;
 * - `engineProductPath()` hands back the engine's product inside that copy (the fallback itself);
 * - `--help` answers (the command surface loads with the engine behind it);
 * - `merge-ledger` hands the arguments to that copy's own driver (the second place reached by path).
 *
 * The engine's product is what the copy needs, and `npm test` builds it before the suite runs
 * (`pnpm --filter pf-core build`, wired into package.json's `test` and `prepack`). Without it every
 * leg skips itself with the reason — the same discipline as `tests/engine-inline.test.mjs`.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const engineProduct = join(root, 'packages', 'pf-core', 'dist', 'index.mjs')
const built = existsSync(engineProduct)
const notBuilt = `packages/pf-core/dist/index.mjs is not built yet; npm test builds it first (pnpm --filter pf-core build)`

/** The shipped shape, copied out of the repo: `bin/`, the manifest, the engine's product. */
function ship() {
  const dir = mkdtempSync(join(tmpdir(), 'pf-runtime-'))
  cpSync(join(root, 'bin'), join(dir, 'bin'), { recursive: true })
  cpSync(join(root, 'package.json'), join(dir, 'package.json'))
  cpSync(join(root, 'packages', 'pf-core', 'dist'), join(dir, 'packages', 'pf-core', 'dist'), {
    recursive: true,
  })
  return dir
}

/** One `node <dir>/bin/pf.mjs …` in a directory outside every node_modules walk-up from this repo. */
function run(dir, args) {
  const result = spawnSync(process.execPath, [join(dir, 'bin', 'pf.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('仓外运行时：装成一份之后 `version` 跑得起来，印的是自己的版本号', { skip: built ? false : notBuilt }, () => {
  const dir = ship()
  try {
    const { code, stdout, stderr } = run(dir, ['version'])
    assert.equal(code, 0, `exit=${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    const line = stdout.trim()
    assert.match(line, /^pf \d+\.\d+\.\d+/u, `version 印的不是一行版本号：${JSON.stringify(line)}`)
    assert.ok(!line.includes('0.0.0'), `version 印的是占位号：${line}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('仓外运行时：`version` 印的落点全在这份拷贝下，不指回本仓', { skip: built ? false : notBuilt }, () => {
  const dir = ship()
  try {
    const { code, stdout, stderr } = run(dir, ['version'])
    assert.equal(code, 0, `exit=${code}\n${stdout}${stderr}`)
    const printed = [...stdout.matchAll(/[A-Za-z]:\\[^()\n]+/gu)].map((match) => match[0].trim())
    assert.ok(printed.length >= 2, `version 没有印出落点：${JSON.stringify(stdout)}`)
    for (const path of printed) {
      assert.ok(
        path.toLowerCase().startsWith(dir.toLowerCase()),
        `落点跑到这份拷贝外面去了：${path}（拷贝在 ${dir}）`,
      )
    }
    assert.ok(
      !stdout.toLowerCase().includes(root.toLowerCase()),
      `version 指回了本仓：${JSON.stringify(stdout)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('仓外运行时：引擎按名字找不到时，命令用的是自己身边那一份产物', { skip: built ? false : notBuilt }, async () => {
  const dir = ship()
  try {
    const { engineProductPath } = await import(`file:///${join(dir, 'bin', 'lib', 'engine.mjs').replace(/\\/gu, '/')}`)
    const reached = engineProductPath()
    assert.equal(
      reached,
      join(dir, 'packages', 'pf-core', 'dist', 'index.mjs'),
      `引擎没落在装机目录里：${reached}`,
    )
    assert.equal(existsSync(reached), true, `产物不在盘上：${reached}`)
    assert.ok(!reached.toLowerCase().startsWith(root.toLowerCase()), `引擎还指在本仓：${reached}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('仓外运行时：`--help` 答得出来（命令面带着引擎一起起来）', { skip: built ? false : notBuilt }, () => {
  const dir = ship()
  try {
    const { code, stdout, stderr } = run(dir, ['--help'])
    assert.equal(code, 0, `exit=${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    assert.match(stdout.split('\n')[0], /^pf -- /u, `--help 的头一行不是命令面：${JSON.stringify(stdout.slice(0, 200))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/*
 * The merge driver git calls by name. Its hand-off is the second place the engine is reached by
 * path, so it takes the same fallback: a runtime that can print a version but cannot start its
 * driver leaves every conflicting ledger merge dead, and git reports that as the repository's
 * problem rather than the command's.
 */
test('仓外运行时：`merge-ledger` 的手交到自己身边那份驱动上', { skip: built ? false : notBuilt }, () => {
  const dir = ship()
  try {
    /* The driver's three positionals are required, and the command parses before it hands off: an
     * argument-less call is refused by this command's own parser, so it never reaches the driver and
     * proves nothing about the hand-off. Three real files do: they are enough for the driver to load,
     * read them, judge them, and refuse them in its own words. None of the three is a record, which is
     * the stable, distinctive answer used here — the driver's exit 2 for "this is not a ledger file". */
    const sides = ['sides-base.json', 'sides-ours.json', 'sides-theirs.json']
    for (const name of sides) writeFileSync(join(dir, name), '{"kind":"not-a-record"}\n')
    const { code, stdout, stderr } = run(dir, ['merge-ledger', ...sides])
    const said = `${stdout}${stderr}`
    assert.equal(code, 2, `merge-ledger 的退出码不是驱动那格的 2：${JSON.stringify({ code, said })}`)
    assert.ok(
      !/^usage: pf merge-ledger/mu.test(said),
      `命令自己的解析器先拒了，驱动根本没接手：${JSON.stringify(said.slice(0, 400))}`,
    )
    assert.match(said, /not a ledger file|not touching it/u, `驱动没跑起来：${JSON.stringify(said.slice(0, 400))}`)
    assert.ok(
      !/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|the engine's product is not on disk/u.test(said),
      `merge-ledger 找不到引擎或驱动：${JSON.stringify(said.slice(0, 400))}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
