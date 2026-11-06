/* The whole pipeline from the shipped shape, with no `pf` on PATH and no checkout behind it.
 *
 * What a real install supplies: the package unpacked into a directory of its own, and the
 * agent-facing half then answers out of that directory — the engine's built product, beside the
 * plugins folder and the host bundle. Nothing in that directory reaches back into this repository,
 * and nothing there is a command: the pipeline answers in-process. So this case assembles exactly
 * the shipped `files` list, proves the tree holds no `bin/` and no `pf` executable, and runs the
 * flow from it in a child process whose PATH has every directory holding a `pf` command taken out.
 * The child proves `pf` is unresolvable from inside itself before it runs anything; a step that
 * tried to shell out would surface `ENOENT`.
 *
 * One child run, six legs:
 *
 * - the empty target project has no `.pf/`, and `help` answers the word index there (exit 0);
 * - `init` → `dag add` ×2 → `cycle create` → `cycle start` → `plan` → `advance` → `handoff` →
 *   `settle` → `plan` again → `advance` again, every word exit 0 with an empty stderr. The words
 *   layer's own spelling is used: `cycle start` opens the line (a created line cannot be started —
 *   the engine refuses the duplicate), the pipeline's closing call is `settle <node>` (the receipt
 *   `handoff` prints names it), and the two `dag add` calls are the graph the flow has to run on.
 *   Each step's answer is recorded;
 * - `advance` claims the free slot, lands the material and hands the node to the engine's
 *   `SimulatedExecutor` (the seam where a host's own opener lands); the claim `started` is on disk
 *   afterwards — the record shows the one call it received;
 * - the host bundle applies to a minimal stand-in context from inside the release tree: it registers
 *   **no tool** by itself, and the tool appears only after a `skill` tool call settles;
 * - the skills the shipped plugins carry land under the child's own temp DSH home, not the machine's;
 * - the applied service answers a write from that tree: an `instruction add` through the endpoint the
 *   panel calls lands the sentence in the project, and no command runs anywhere — the tree carries no
 *   `bin/`. A static lock beside it reads the assembled tree and `src/host/**`: no file there names a
 *   command entry, in either spelling.
 *
 * The engine product and the host bundle must be built, and the host half's declared peer must be
 * installed (`npm test` builds both; nothing in this suite builds `lib/` — the published package
 * builds it at `prepack`). Without them every leg skips itself with that reason, the same discipline
 * as `tests/runtime-outside-repo.test.mjs`.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const engineProduct = join(repo, 'packages', 'pf-core', 'dist', 'index.mjs')
const hostEntry = join(repo, 'lib', 'host', 'index.js')
/* The one runtime dependency the host bundle declares beside the engine: the host half's peer, which
 * the plugin's own `peerDependencies` says the install supplies. A real profile provides it; this
 * case provides it outside the assembled tree, never inside it. */
const peerPackage = join(repo, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
const notBuilt =
  'the release shape is not built here: packages/pf-core/dist/index.mjs or lib/host/index.js is missing, ' +
  'or node_modules/@deepseek-ai/dsh-typert-protocol (the host bundle\'s peer) is not installed. ' +
  '`npm test` builds the engine product; `npm run types && npm run bundle` builds the host bundle.'
const skip = existsSync(engineProduct) && existsSync(hostEntry) && existsSync(peerPackage) ? false : notBuilt

/** The names a `pf` command takes on the three platforms this repo runs on. */
const PF_NAMES = ['pf', 'pf.cmd', 'pf.exe']

/** npm's `files` wildcard (`**` crosses directories, `*` does not), matched the way npm reads it. */
function covered(pattern, file) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    /* One pass, so the group a replacement inserts is not scanned again by the next rule. */
    .replace(/\*\*\/|\*/gu, (match) => (match === '**/' ? '(?:[^/]+/)*' : '[^/]*'))
  return new RegExp(`^${body}$`, 'u').test(file)
}

/** Every file under a directory, as a slash-separated path relative to it. */
function filesUnder(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

/** Every file in a tree whose leaf name is one of the command's own spellings. */
function pfExecutables(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...pfExecutables(full))
    else if (PF_NAMES.includes(entry.name.toLowerCase())) found.push(full)
  }
  return found
}

/** Every file in a tree carrying the given literal, as its slash-separated path and how many times. */
function filesSaying(dir, literal, prefix = '') {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...filesSaying(full, literal, rel))
      continue
    }
    const count = readFileSync(full, 'utf8').split(literal).length - 1
    if (count > 0) found.push({ path: rel, count })
  }
  return found
}

/**
 * The shipped shape: exactly the manifest's `files` entries, plus a manifest of the same name,
 * version, type and exports. Returns the inventory it copied.
 */
function ship(dir) {
  const patterns = manifest.files ?? []
  assert.ok(patterns.length > 0, 'the manifest lists no files')
  const inventory = []
  for (const pattern of patterns) {
    const star = pattern.indexOf('*')
    if (star === -1) {
      assert.ok(existsSync(join(repo, pattern)), `${pattern} is listed in files but is not on disk`)
      mkdirSync(dirname(join(dir, pattern)), { recursive: true })
      cpSync(join(repo, pattern), join(dir, pattern))
      inventory.push({ path: pattern, bytes: readFileSync(join(repo, pattern)).length })
      continue
    }
    /* Everything a wildcard can match lives under the pattern's literal directory prefix. */
    const base = pattern.slice(0, pattern.slice(0, star).lastIndexOf('/'))
    assert.ok(existsSync(join(repo, base)), `${base} is listed in files but is not on disk`)
    for (const rel of filesUnder(join(repo, base))) {
      const relative = `${base}/${rel}`
      if (!covered(pattern, relative)) continue
      mkdirSync(dirname(join(dir, relative)), { recursive: true })
      cpSync(join(repo, relative), join(dir, relative))
      inventory.push({ path: relative, bytes: readFileSync(join(repo, relative)).length })
    }
  }
  mkdirSync(dir, { recursive: true })
  const shaped = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    main: manifest.main,
    types: manifest.types,
    exports: manifest.exports,
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(shaped, null, 2)}\n`)
  inventory.push({ path: 'package.json', bytes: readFileSync(join(dir, 'package.json')).length })
  return inventory
}

/**
 * The child: it proves its own isolation, runs the flow through the release's engine product, then
 * applies the release's host bundle to a stand-in context. It prints one JSON record; the parent
 * judges it. Paths are read off its own location, so nothing about this checkout crosses over. Its
 * one mention of the command is the gate probe; no step ever reaches for it.
 */
const CHILD = `import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const work = fileURLToPath(new URL('.', import.meta.url))
const release = join(work, 'release')
const project = join(work, 'project')
const home = join(work, 'home')
const snapshot = (value) => JSON.parse(JSON.stringify(value))

const record = {
  cwd: process.cwd(),
  path: process.env.PATH ?? '',
  beforeInit: existsSync(join(project, '.pf')),
  pf: null,
  help: null,
  steps: [],
  held: [],
  executor: [],
  executorFinal: [],
  host: null,
  skills: null,
  write: null,
}

/* The "no command on PATH" gate, made explicit from inside the child: if a shell ever tried the
 * command, this is the same resolution it would fail on. */
const gate = spawnSync('pf', ['--version'], { encoding: 'utf8', windowsHide: true })
record.pf = { error: gate.error?.code ?? null, status: gate.status }
if (gate.error?.code !== 'ENOENT') throw new Error('a pf command is still resolvable inside the child: ' + JSON.stringify(record.pf))
if (record.beforeInit) throw new Error('the target project already had a .pf before the flow started')

const engine = await import(pathToFileURL(join(release, 'packages', 'pf-core', 'dist', 'index.mjs')).href)
const executor = new engine.SimulatedExecutor()
const io = { root: project, executor, homeDir: home, openerAvailable: true }
const step = async (label, argv) => {
  const answer = await engine.answer(argv, io)
  record.steps.push({ label, argv, code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' })
  return answer
}

/* Layer 1 has to answer before any .pf exists: the index is a word, not a record read. */
const help = await engine.answer(['help'], io)
record.help = { code: help.code, bytes: Buffer.byteLength(help.stdout ?? ''), stdout: help.stdout ?? '', stderr: help.stderr ?? '' }
record.afterHelp = existsSync(join(project, '.pf'))

await step('init', ['init'])
await step('dag add (first leg)', ['dag', 'add', 'first leg'])
await step('dag add (second leg)', ['dag', 'add', 'second leg'])
/* The words layer cannot create and start one id in two calls: the second is refused as a duplicate.
 * So each word gets its own line: the one 'cycle create' opens (it must stay empty) and the one
 * 'cycle start' opens and pins. --force is the engine's stated way to run a second line. */
await step('cycle create', ['cycle', 'create', 'seed', '--tags', 'coding', '--title', 'the empty line'])
await step('cycle start', ['cycle', 'start', 'c-1', '--tags', 'coding', '--force', '--title', 'the flow'])
await step('plan', ['plan', '--cycle', 'c-1'])
await step('dispatch', ['dispatch', 'c-1'])
record.held = JSON.parse(readFileSync(join(project, '.pf', 'state.json'), 'utf8'))
  .cycles.find((cycle) => cycle.id === 'c-1')
  .holding.map((entry) => entry.id)
record.executor = snapshot(executor.dispatched)
await step('handoff', ['handoff', 'c-1', record.held[0], 'completed', '-s', 'leg one done'])
/* The closing word is 'settle': it records this node's end and nothing else -- no claim, no prompt, no
 * session, no parking. What the line would do next is 'plan''s answer; claiming it is 'cycle hold', and
 * opening its session is 'dispatch'. The composed 'advance' is the same three moves as one word. */
await step('settle', ['settle', record.held[0], '--cycle', 'c-1', '--json'])
record.planAfterSettle = JSON.parse((await step('plan (the next leg)', ['plan', '--cycle', 'c-1', '--json'])).stdout)
await step('cycle hold (the next leg)', ['cycle', 'hold', 'c-1', record.planAfterSettle.node_id])
await step('dispatch (the next leg)', ['dispatch', 'c-1'])
record.executorFinal = snapshot(executor.dispatched)

/* The host bundle, from the release tree, over a stand-in context shaped like the host's: the four
 * injected services, an event bus, the fiber effect seam, and a tools registry that records. */
const host = await import(pathToFileURL(join(release, 'lib', 'host', 'index.js')).href)
const provided = {}
const listeners = {}
const effects = []
const registered = []
const tools = {
  schemas: [],
  register(definition) {
    registered.push(definition)
    return () => {
      const at = registered.indexOf(definition)
      if (at >= 0) registered.splice(at, 1)
    }
  },
}
const ctx = {
  provide(name, value) {
    provided[name] = value
  },
  on(name, listener) {
    (listeners[name] ??= []).push(listener)
    return () => {
      const held = listeners[name] ?? []
      const at = held.indexOf(listener)
      if (at >= 0) held.splice(at, 1)
    }
  },
  effect(make) {
    const value = make()
    effects.push(value)
    return value
  },
  workspaceFiles: {
    async list() {
      return { path: '', entries: [], truncated: false }
    },
    async read() {
      const error = new Error('no file here')
      error.code = 'ENOENT'
      throw error
    },
  },
  sessions: { get: () => undefined },
  sandboxPolicy: { workspaceRoot: project },
  tools,
  get: () => undefined,
}
await host.apply(ctx)
const shape = () => ({ registered: registered.map((definition) => definition.name), schemas: tools.schemas.length })
record.host = { service: typeof provided.pathfinder, listeners: Object.keys(listeners), beforeWake: shape() }
/* The wake exactly as the host fires it: a settled 'skill' call, then the agent's own scope. */
const agent = { id: 'agent-1', ctx: { tools, effect(make) { make() } } }
const wake = async () => {
  for (const listener of listeners['tools/post-execute'] ?? []) {
    await listener({ name: 'skill', agent }, { isError: false }, async () => ({ kind: 'accept' }))
  }
}
await wake()
record.host.afterWake = shape()
await wake()
record.host.afterSecondWake = shape()

const manifestPath = join(home, 'pathfinder', 'skills.json')
record.skills = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8')).skills.flatMap((skill) => skill.files.map((file) => join(home, 'skills', file)))
  : null

/* The panel's write endpoint, from the release tree: the applied service answers it through the words
 * layer the bundle carries, and the sentence lands in the project. A write that reached for a command
 * entry would have to find one — and this tree has none. */
const said = 'the release shape wrote this'
const answered = await provided.pathfinder.addInstruction('agent-1', project, said, 'global', '', '')
const instructionFile = join(project, '.pf', 'instructions.json')
record.write = {
  outcome: snapshot(answered),
  landed: existsSync(instructionFile)
    ? JSON.parse(readFileSync(instructionFile, 'utf8')).instructions.filter((entry) => entry.text === said)
    : [],
  binAfter: existsSync(join(release, 'bin')),
}

process.stdout.write(JSON.stringify(record) + '\\n')
`

test('发布形状无 bin/：PATH 上没有 pf 时整条管线照跑，空项目先答词索引', { skip }, () => {
  /* A stale host bundle is the one failure the rest of this case cannot see: the assembled tree copies
   * whatever `lib/host/index.js` already is, so a write path that still named a command could hide
   * behind a bundle built before that change. The bundle must therefore be newer than every source it
   * claims to be built from, and newer than the two files that shape it. */
  const hostSrcDir = fileURLToPath(new URL('../src/host/', import.meta.url))
  if (existsSync(hostEntry)) {
    const newest = [
      ...filesUnder(hostSrcDir).map((relative) => join(hostSrcDir, relative)),
      join(repo, 'tsdown.config.ts'),
      join(repo, 'package.json'),
    ]
      .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
      .reduce((latest, next) => (next.mtimeMs > latest.mtimeMs ? next : latest))
    assert.ok(
      statSync(hostEntry).mtimeMs >= newest.mtimeMs,
      `lib/host/index.js is older than ${newest.file}: the host bundle is stale. Rebuild it with \`npm run types && npm run bundle\` (or \`npm test\`, which builds it).`,
    )
  }
  const work = mkdtempSync(join(tmpdir(), 'pf-no-cli-'))
  try {
    const release = join(work, 'release')
    const project = join(work, 'project')
    const home = join(work, 'home')
    mkdirSync(project, { recursive: true })
    mkdirSync(home, { recursive: true })

    /* Step 1: the shipped list, and the shape it must have. */
    const inventory = ship(release)
    assert.equal(existsSync(join(release, 'bin')), false, 'the assembled tree must not hold a bin/ directory')
    assert.deepEqual(pfExecutables(release), [], 'the assembled tree must not hold a pf executable')
    assert.equal(JSON.parse(readFileSync(join(release, 'package.json'), 'utf8')).bin, undefined, 'the release manifest must not name a command')
    for (const required of [
      'cordis.patch.yml',
      'lib/client.js',
      'lib/host/index.js',
      'lib/types/host/index.d.ts',
      'locale/en.json',
      'locale/zh.json',
      'packages/pf-core/dist/index.mjs',
      'packages/pf-core/dist/merge-ledger.mjs',
      'packages/pf-core/plugins/pipeline/plugin.json',
    ]) {
      assert.ok(inventory.some((entry) => entry.path === required), `the shipped shape is missing ${required}`)
    }
    assert.equal(existsSync(join(release, 'lib', 'types', 'host', 'index.js')), false, 'lib/types must ship only its .d.ts: the compiled .js is packing input, not payload')

    /* Step 1b: the static lock. Nothing the release carries spells a command entry, and no host source
     * names a `bin/` path in either spelling. The engine text that used to spell one is gone with the
     * command, so the lock reads what ships and asks it to stay empty. */
    assert.deepEqual(filesSaying(release, 'bin/pf.mjs'), [], 'the assembled tree must carry no reference to a command entry')
    assert.deepEqual(
      filesSaying(hostSrcDir, 'bin/'),
      [],
      'src/host/** must name no `bin/` path: the slash spelling failed',
    )
    assert.deepEqual(
      filesSaying(hostSrcDir, 'bin\\'),
      [],
      'src/host/** must name no `bin\\` path: the Windows spelling failed',
    )

    /* The host half's declared peer, provided outside the assembled tree the way a profile does. */
    mkdirSync(join(work, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(peerPackage, join(work, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol'), 'junction')

    /* Step 2: the child, on an environment that cannot reach a pf command. */
    writeFileSync(join(work, 'run.mjs'), CHILD)
    const entries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0)
    const removed = entries.filter((entry) => PF_NAMES.some((name) => existsSync(join(entry, name))))
    const kept = entries.filter((entry) => !removed.includes(entry))
    const scrubbed = ['PF_PLUGINS_DIR', 'DSH_CONDUCT_SPAWNER', 'DSH_CONDUCT_SPAWN_DRY_RUN', 'DSH_SESSION_ID', 'ZCODE_DATA_BASE_DIR', 'NODE_OPTIONS', 'NODE_PATH']
    const env = { ...process.env, PATH: kept.join(delimiter), PF_HOME_DIR: home, DSH_HOME: home }
    const wasSet = scrubbed.filter((name) => env[name] !== undefined)
    for (const name of scrubbed) delete env[name]
    /* Whatever the platform and git need stays in; only the command and the switches that would
     * steer this run leave. */
    for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT']) {
      if (process.env[name] !== undefined) assert.equal(env[name], process.env[name], `${name} must survive into the child`)
    }
    const started = Date.now()
    const child = spawnSync(process.execPath, [join(work, 'run.mjs')], {
      cwd: project,
      env,
      encoding: 'utf8',
      windowsHide: true,
    })
    const elapsedMs = Date.now() - started
    const said = `exit=${child.status}\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`
    assert.equal(child.status, 0, said)
    const record = JSON.parse(child.stdout.trim().split('\n').pop())
    const run = { assembly: { root: release, files: inventory }, path: { kept, removed, wasSet, scrubbed }, elapsedMs, record }

    /* The gate: no pf from inside the child, and no .pf in the target before anything ran. */
    assert.deepEqual(record.pf, { error: 'ENOENT', status: null }, `pf is still resolvable inside the child: ${JSON.stringify(record.pf)}`)
    assert.equal(record.path, kept.join(delimiter), 'the child saw exactly the filtered PATH')
    assert.ok(record.cwd.toLowerCase().includes(basename(work).toLowerCase()), `the child must stand in the temp project, not the checkout: ${record.cwd}`)
    assert.equal(record.beforeInit, false, 'the target project must have no .pf/ before the flow')

    /* Step 5: the empty project answers the index, and reading it writes nothing. */
    assert.equal(record.help.code, 0, record.help.stderr)
    assert.equal(record.help.stderr, '')
    assert.equal(record.help.bytes, Buffer.byteLength(record.help.stdout), 'the recorded byte count is the answer itself')
    assert.ok(record.help.bytes > 200, `the word index should be more than a line: ${record.help.bytes} bytes`)
    assert.match(record.help.stdout, /pathfinder -- the agent pipeline/u, 'the index is the words layer\'s own top listing')
    assert.equal(record.afterHelp, false, 'answering the index must not create .pf/')

    /* Step 4: the flow, word by word, all eight plus the graph it runs on. */
    assert.deepEqual(
      record.steps.map((step) => [step.label, step.argv]),
      [
        ['init', ['init']],
        ['dag add (first leg)', ['dag', 'add', 'first leg']],
        ['dag add (second leg)', ['dag', 'add', 'second leg']],
        ['cycle create', ['cycle', 'create', 'seed', '--tags', 'coding', '--title', 'the empty line']],
        ['cycle start', ['cycle', 'start', 'c-1', '--tags', 'coding', '--force', '--title', 'the flow']],
        ['plan', ['plan', '--cycle', 'c-1']],
        ['dispatch', ['dispatch', 'c-1']],
        ['handoff', ['handoff', 'c-1', record.held[0], 'completed', '-s', 'leg one done']],
        ['settle', ['settle', record.held[0], '--cycle', 'c-1', '--json']],
        ['plan (the next leg)', ['plan', '--cycle', 'c-1', '--json']],
        ['cycle hold (the next leg)', ['cycle', 'hold', 'c-1', record.planAfterSettle.node_id]],
        ['dispatch (the next leg)', ['dispatch', 'c-1']],
      ],
    )
    for (const step of record.steps) {
      assert.equal(step.code, 0, `${step.label} exited ${step.code}: ${step.stderr}`)
      assert.equal(step.stderr, '', `${step.label} wrote to stderr: ${step.stderr}`)
      assert.ok(!/ENOENT|not recognized|is not recognized/u.test(step.stderr + step.stdout), `${step.label} looks like it reached for a missing command`)
    }
    const byLabel = Object.fromEntries(record.steps.map((step) => [step.label, step]))
    assert.match(byLabel.init.stdout, /^Ledger: /mu, 'init answers where it put the ledger')
    assert.match(byLabel.plan.stdout, /^action: dispatch$/mu, 'cycle start pinned a node, so the plan asks to dispatch it')
    assert.match(byLabel.plan.stdout, /^cycle:\s+c-1$/mu)
    assert.match(byLabel['cycle start'].stdout, /^STARTED: cycle "c-1"/mu)
    assert.match(byLabel.dispatch.stdout, /^opened /mu)
    assert.match(byLabel.handoff.stdout, /^handoff: /mu)

    /* init wrote the four layout files; the graph holds the two nodes. */
    for (const file of ['.gitignore', '.gitattributes', 'AGENTS.md', 'config.json']) {
      assert.ok(existsSync(join(project, '.pf', file)), `init did not land .pf/${file}`)
    }
    const state = JSON.parse(readFileSync(join(project, '.pf', 'state.json'), 'utf8'))
    const seed = state.cycles.find((cycle) => cycle.id === 'seed')
    const flow = state.cycles.find((cycle) => cycle.id === 'c-1')
    assert.deepEqual(seed.holding, [], 'the line `cycle create` opened must stay empty: it is not the line the flow runs on')
    assert.equal(record.held.length, 1, `the flow line must hold exactly one node: ${JSON.stringify(record.held)}`)

    /* `cycle start` claimed the node; `dispatch` asked the executor — not a process — to open its session. */
    const node = record.held[0]
    assert.equal(record.executor.length, 1, `exactly one dispatch reached the executor: ${JSON.stringify(record.executor)}`)
    assert.equal(record.executor[0].node, node)
    assert.equal(record.executor[0].cycle, 'c-1')
    assert.match(record.executor[0].prompt, new RegExp(`^/pf-conduct ${node} \\[pipeline\\]`, 'u'), 'the executor was handed the prompt the engine landed')
    const launch = join(project, '.pf', 'meta', 'launch', 'c-1', node)
    assert.ok(existsSync(join(launch, 'started')), 'the started claim must be on disk after dispatch')
    assert.ok(existsSync(join(launch, 'prompt.txt')), 'dispatch preparation lands the prompt')
    assert.equal(
      readFileSync(join(launch, 'prompt.txt'), 'utf8').replace(/\r\n/gu, '\n').trim(),
      record.executor[0].prompt.trim(),
      'the executor got the prompt that is on disk',
    )

    /* handoff wrote the ticket; settle recorded it and released the hand (the receipt's own plan asks for the
     * next claim); cycle hold claimed that pick; dispatch landed its material and opened its session. */
    const ticket = JSON.parse(readFileSync(join(project, '.pf', 'signals', 'c-1', `${node}.json`), 'utf8'))
    assert.equal(ticket.node, node)
    assert.equal(ticket.status, 'completed')
    assert.equal(ticket.summary, 'leg one done')
    const settled = JSON.parse(readFileSync(join(project, '.pf', 'state.json'), 'utf8')).cycles.find((cycle) => cycle.id === 'c-1')
    assert.equal(settled.path.length, 1, 'settle puts exactly one step in the line\'s path')
    assert.equal(settled.path[0].node, node)
    assert.equal(settled.path[0].result, 'completed')
    const ideas = JSON.parse(readFileSync(join(project, '.pf', 'ideas.json'), 'utf8')).nodes
    assert.equal(ideas[node].status, 'completed', 'the settled node is completed on the graph')
    assert.equal(record.planAfterSettle.action, 'open_node', 'the plan asks for the next claim')
    const nextLeg = record.planAfterSettle.nodes[0]
    assert.ok(nextLeg === undefined || typeof nextLeg === 'string')
    /* The settle receipt carries the plan it leaves behind: it names the line and the verdict, and claims
     * nothing -- an open_node plan is the evidence, since a claim would read as dispatch. */
    const settleReceipt = JSON.parse(byLabel.settle.stdout)
    assert.equal(settleReceipt.action, 'settle')
    assert.equal(settleReceipt.result, 'completed')
    assert.equal(settleReceipt.plan.action, 'open_node')
    /* cycle hold claimed the next leg; dispatch opened its session: the material is on disk and the claim too. */
    const afterNext = JSON.parse(readFileSync(join(project, '.pf', 'state.json'), 'utf8')).cycles.find((cycle) => cycle.id === 'c-1')
    assert.equal(afterNext.holding.length, 1, 'cycle hold claimed the next node')
    const claimed = afterNext.holding[0].id
    assert.equal(claimed, record.planAfterSettle.node_id, 'the claim is the node the plan named')
    assert.notEqual(claimed, node, 'the next leg is a different node')
    assert.equal(ideas[claimed].status, 'todo', 'the next leg is still to do')
    assert.match(byLabel['cycle hold (the next leg)'].stdout, /^CURRENT_NODE: c-1 /mu)
    assert.match(byLabel['dispatch (the next leg)'].stdout, /^opened /mu)
    const nextLaunch = join(project, '.pf', 'meta', 'launch', 'c-1', claimed)
    assert.ok(existsSync(join(nextLaunch, 'prompt.txt')), 'the dispatch landed the next leg\'s prompt')
    assert.ok(existsSync(join(nextLaunch, 'started')), 'the dispatch opened the next leg\'s session')
    assert.equal(record.executorFinal.length, 2, 'the second dispatch opened the next leg')
    assert.equal(record.executorFinal[1].node, claimed)

    /* Step 6: the host bundle applies, registers nothing by itself, and arms the wake. */
    assert.equal(record.host.service, 'object', 'apply installed the pathfinder service')
    for (const event of ['session/event', 'tools/post-execute', 'agent/pre-step']) {
      assert.ok(record.host.listeners.includes(event), `apply did not arm ${event}`)
    }
    assert.deepEqual(record.host.beforeWake, { registered: [], schemas: 0 }, `apply alone must register no tool: ${JSON.stringify(record.host.beforeWake)}`)
    assert.deepEqual(record.host.afterWake, { registered: ['pathfinder'], schemas: 0 }, `the wake must register the tool: ${JSON.stringify(record.host.afterWake)}`)
    assert.deepEqual(record.host.afterSecondWake, { registered: ['pathfinder'], schemas: 0 }, 'a second wake registers nothing more')
    assert.ok(Array.isArray(record.skills) && record.skills.length > 0, 'the release\'s plugin skills must be found through the host bundle\'s own location')
    for (const file of record.skills) {
      assert.ok(file.toLowerCase().startsWith(join(home, 'skills').toLowerCase()), `a skill was placed outside the temp home: ${file}`)
      assert.ok(existsSync(file), `the skills manifest records a file that is not on disk: ${file}`)
    }

    /* Step 7: the write endpoint, from the release tree — the sentence lands in the project, and the
     * tree that answered it never held a command entry and never had one resolvable on PATH. */
    assert.equal(record.write.outcome.ok, true, `the write endpoint refused from the release shape: ${JSON.stringify(record.write.outcome)}`)
    assert.match(
      record.write.outcome.text,
      /^INSTRUCTION \S+: \[global\/stage\] the release shape wrote this$/u,
      'the words layer\'s own line came back',
    )
    assert.equal(record.write.landed.length, 1, `the sentence did not land in the project: ${JSON.stringify(record.write.landed)}`)
    assert.equal(record.write.landed[0].scope, 'global')
    assert.equal(record.write.landed[0].state, 'live')
    assert.equal(record.write.binAfter, false, 'the assembled tree must still hold no bin/ after the write')

    /* One real run's full record, for a report: opt-in, and only into the repo's gitignored scratch.
     *   PF_NO_CLI_RECORD=1 node --test tests/host-no-cli.test.mjs */
    if (process.env.PF_NO_CLI_RECORD === '1') {
      const out = join(repo, '.tmp', 'host-no-cli-record.json')
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
