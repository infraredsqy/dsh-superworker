// The one command that runs both suites in this repo.
//
//   node tools/test-all.mjs
//
// Two suites live here, and this entry runs both — each in its own process on its own runner:
//
// - the plugin's own suite: node's test runner over `tests/`, the host half, the model layer and
//   the built browser half;
// - the engine's suite: the in-repo engine package's own `test` script, run through pnpm from the
//   workspace root, with its own test runner, its own dev dependencies and its own start-up shape.
//
// It prints one line per suite plus a total — test files, cases and the wall seconds each took —
// so a single command answers "both green, how much of each, how long". A failing suite's raw
// output is kept in `.tmp/test-all/<suite>.log` (gitignored; the path is printed) and its tail is
// echoed here.
//
// `npm test` builds the products first (`npm run build:products` — the one place the chain is
// written; this file does not restate it) because the packaging case in `tests/` drives them; run
// this file alone and that case skips itself with the reason.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const engineDir = join(root, 'packages', 'superworker-core')
const logDir = join(root, '.tmp', 'test-all')

mkdirSync(logDir, { recursive: true })

/** Every `*.test.mjs` under a directory — the set node's runner picks up for the plugin suite. */
function testFilesUnder(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFilesUnder(full))
    else if (entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

/**
 * One child suite: stdout and stderr both land in `logPath` (no pipes are held), and the promise
 * settles with the exit code and the wall seconds. A child that cannot even start is a failure of
 * its own kind — the message goes into the log so the tail printed below carries it.
 *
 * With `shell`, `command` is a whole command line and `args` stays empty: that form is for runners
 * reached by name rather than by path (pnpm is a program on PATH, and on Windows its entry is a
 * `.cmd` shim node will not spawn directly). Nothing is passed separately there, so nothing has to
 * be escaped.
 */
function runChild(command, args, cwd, logPath, shell = false) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, 'w')
    const started = process.hrtime.bigint()
    const child = spawn(command, args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true, shell })
    let spawnError
    child.on('error', (error) => {
      spawnError = error
      writeFileSync(fd, `\n${command} could not start: ${error.message}\n`)
    })
    child.on('close', (code) => {
      closeSync(fd)
      const seconds = Number(process.hrtime.bigint() - started) / 1e9
      resolve({ code: spawnError === undefined ? code : 1, seconds })
    })
  })
}

/**
 * How the engine package's suite starts, read off that package's own manifest: the `test` script it
 * declares, which is the same entry `pnpm --filter superworker-core test` runs. Building a vitest argv here
 * instead would put a second copy of the start-up in this file — a different runner, a config flag
 * or a worker count changes in the package and this file would go on running the old shape.
 *
 * Two refusals are read off the manifest and the disk rather than guessed from a failed spawn: a
 * package that declares no `test` script, and one whose `vitest` devDependency is not installed.
 */
function engineTestScript() {
  const manifestPath = join(engineDir, 'package.json')
  if (!existsSync(manifestPath)) return { reason: `packages/superworker-core/package.json is missing: ${manifestPath}` }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const script = manifest.scripts?.test
  if (typeof script !== 'string' || script.trim().length === 0) {
    return { reason: 'packages/superworker-core/package.json declares no test script: nothing to run' }
  }
  const declared = typeof manifest.devDependencies?.vitest === 'string'
  const installed = existsSync(join(engineDir, 'node_modules', 'vitest'))
  if (!declared || !installed) {
    return {
      reason: `packages/superworker-core's vitest is devDependency declared=${String(declared)} installed=${String(installed)}: run pnpm install first.`,
    }
  }
  return { script }
}

/** One number out of the runner's summary, whichever of the two spellings it printed. */
function summaryNumber(log, name) {
  const match =
    new RegExp(`^# ${name}\\s+(\\d+)`, 'mu').exec(log) ??
    new RegExp(`^\u2139 ${name}\\s+(\\d+)`, 'mu').exec(log)
  return match === null ? undefined : Number(match[1])
}

function tailOf(path, lines = 60) {
  const text = readFileSync(path, 'utf8').split(/\r?\n/u)
  return text.slice(Math.max(0, text.length - lines)).join('\n')
}

const total = { files: 0, cases: 0, seconds: 0 }
const failures = []

/** Report one suite's readings, in the shape all three lines share. */
function report(label, detail, readings) {
  const cells = [`${String(readings.files).padStart(4)} files`, `${String(readings.cases).padStart(4)} cases`, `${readings.seconds.toFixed(2).padStart(6)}s`]
  console.log(`${label.padEnd(13)} ${detail.padEnd(42)} ${cells.join('  ')}`)
  total.files += readings.files
  total.cases += readings.cases
  total.seconds += readings.seconds
}

// The plugin suite: node's own runner over tests/, TAP on stdout so the summary lines are readable
// whether or not the console is a terminal.
const pluginLog = join(logDir, 'plugin.log')
const pluginFiles = testFilesUnder(join(root, 'tests'))
const pluginRun = await runChild(
  process.execPath,
  ['--test', '--test-reporter=tap', 'tests/'],
  root,
  pluginLog,
)
const pluginText = readFileSync(pluginLog, 'utf8')
report('plugin suite', 'node --test tests/', {
  files: pluginFiles.length,
  cases: summaryNumber(pluginText, 'tests') ?? 0,
  seconds: pluginRun.seconds,
})
if (pluginRun.code !== 0) failures.push(['plugin suite', pluginLog])

// The engine suite: the package's own `test` script, run through pnpm from the workspace root so
// its config and its node_modules answer. The JSON reporter writes the case counts beside the run,
// and the default reporter writes the human-readable one — the failing case and its reason — into
// the log echoed below, so a red engine suite names what broke here rather than only in the JSON
// file. The JSON reporter resolves its output path against the package's own working directory
// (pnpm runs a package's script from that package's directory), so the path is handed over relative
// to `packages/superworker-core`.
const engineLog = join(logDir, 'engine.log')
const engineJson = join(logDir, 'engine.json')
const engineJsonArg = relative(engineDir, engineJson).split(sep).join('/')
const engineScript = engineTestScript()
let engineReadings = { files: 0, cases: 0 }
let engineCode = 1
if (engineScript.reason !== undefined) {
  writeFileSync(engineLog, `${engineScript.reason}\n`)
} else {
  const engineCommand = [
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    '--filter', 'superworker-core', 'test',
    // Two reporters: `default` for the failure detail, `json` for the counts; `.json=` scopes the
    // output file to the JSON one alone, so the default reporter keeps printing to stdout.
    '--reporter=default', '--reporter=json', `--outputFile.json=${engineJsonArg}`,
  ].join(' ')
  const engineRun = await runChild(engineCommand, [], root, engineLog, true)
  engineCode = engineRun.code
  const json = existsSync(engineJson) ? JSON.parse(readFileSync(engineJson, 'utf8')) : undefined
  engineReadings = {
    files: Array.isArray(json?.testResults) ? json.testResults.length : 0,
    cases: typeof json?.numTotalTests === 'number' ? json.numTotalTests : 0,
  }
  report('engine suite', 'pnpm --filter superworker-core test', { ...engineReadings, seconds: engineRun.seconds })
  if (engineRun.code !== 0) failures.push(['engine suite', engineLog])
}
if (engineScript.reason !== undefined) {
  report('engine suite', 'pnpm --filter superworker-core test', { ...engineReadings, seconds: 0 })
  failures.push(['engine suite', engineLog])
}

report('both suites', '', { ...total })

for (const [label, logPath] of failures) {
  console.error(`\n----- ${label} failed; raw output kept in ${logPath} -----\n${tailOf(logPath)}`)
}
process.exitCode = pluginRun.code === 0 && engineCode === 0 ? 0 : 1