// reset.mjs — reset the rehearsal workspace to "graph in place, five nodes todo, zero sessions".
//
//   node tools/rehearsal/reset.mjs --root C:\Users\inf_NAS\dsh-rehearsal
//
// This is deliberately a narrow, explicit script rather than a general tool. Three guards run
// before anything is touched, and the script refuses to run (exit 2) when any of them fails:
//   1. --root must be given explicitly; a directory that looks like a real checkout (a package.json
//      at the root) is refused — a rehearsal stage holds no code of its own.
//   2. the stage must already carry a ledger: `.superworker/ideas.json` plus `.superworker/nodes/`,
//      and every registered node must have its own directory with a spec.md in it (a reset keeps
//      the spec — the graph's flesh — and drops only what runs produced).
//   3. the node set is enumerated from ideas.json, nothing is hard-coded; a stage registering zero
//      nodes is not the workspace this script expects.
//
// What a reset does (in order):
//   1. the workspace root: everything except `.superworker/` goes.
//   2. the ledger's own git and the execution record: `.git/`, `signals/`, `meta/`, `worktrees/`.
//   3. each node: keep spec.md, drop everything a run produced (run/review/report/fix, temp/).
//   4. ideas.json: every node back to status todo, completion timestamps dropped.
//   5. state.json: path [], holding [], status inactive.
//   6. the two empty base repositories the pipeline needs (workspace root + ledger, one commit each).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : '' }
const ROOT = arg('root')
const SW = join(ROOT, '.superworker')

function say(line) { process.stdout.write(line + '\n') }
function fail(why) { console.error(`refusing to reset: ${why}`); process.exit(2) }

/* ── the guards ─────────────────────────────────────────────────────────────────────────── */
if (ROOT === '') fail('--root is required (pass the rehearsal stage explicitly, never a checkout)')
if (existsSync(join(ROOT, 'package.json'))) fail(`${ROOT} has a package.json at the root — that looks like a real checkout, not a rehearsal stage`)
if (!existsSync(join(SW, 'ideas.json'))) fail(`${SW} is missing — not a rehearsal stage with a ledger`)
if (!existsSync(join(SW, 'state.json'))) fail(`${SW} is missing — not a rehearsal stage with a ledger`)
if (!existsSync(join(SW, 'nodes'))) fail(`${SW}\\nodes is missing — not a rehearsal stage with nodes`)

let ideas
try { ideas = JSON.parse(readFileSync(join(SW, 'ideas.json'), 'utf8')) }
catch (e) { fail(`ideas.json does not parse (${String(e.message || e)})`) }
const ids = Object.keys(ideas?.nodes ?? {})
if (ids.length === 0) fail('ideas.json registers zero nodes — not the workspace this script expects')
for (const id of ids) {
  if (!existsSync(join(SW, 'nodes', id))) fail(`node ${id} has no directory under nodes/`)
  if (!existsSync(join(SW, 'nodes', id, 'spec.md'))) fail(`node ${id} has no spec.md — a reset keeps the spec, so this is not a stage this script expects`)
}

say(`resetting ${ROOT} (${ids.length} node(s) enumerated from ideas.json)`)

/* ── 1. the workspace root: everything but .superworker goes ──────────────────────────────── */
say('== workspace root ==')
for (const entry of readdirSync(ROOT)) {
  if (entry === '.superworker') continue
  rmSync(join(ROOT, entry), { recursive: true, force: true })
  say(`  removed  ${entry}`)
}

/* ── 2. the ledger's own git, and the execution record ───────────────────────────────────── */
say('== .superworker ==')
rmSync(join(SW, '.git'), { recursive: true, force: true })
say('  removed  .git/')
for (const dir of ['signals', 'meta', 'worktrees']) {
  if (existsSync(join(SW, dir))) {
    rmSync(join(SW, dir), { recursive: true, force: true })
    say(`  removed  ${dir}/`)
  }
}

/* ── 3. each node: keep spec.md, drop everything the run produced ────────────────────────── */
say('== nodes ==')
for (const id of ids) {
  const dir = join(SW, 'nodes', id)
  for (const entry of readdirSync(dir)) {
    if (entry === 'spec.md') continue
    rmSync(join(dir, entry), { recursive: true, force: true })
    say(`  removed  nodes/${id.slice(0, 8)}/${entry}`)
  }
}

/* ── 4. ideas.json: status back to todo, no completion timestamps ────────────────────────── */
const cleanIdeas = { nodes: {} }
for (const id of ids) {
  const node = { ...ideas.nodes[id] }
  node.status = 'todo'
  delete node.completed_at
  delete node.updated_at
  cleanIdeas.nodes[id] = node
}
writeFileSync(join(SW, 'ideas.json'), JSON.stringify(cleanIdeas, null, 2) + '\n', 'utf8')
say('== ideas.json ==')
say(`  ${ids.length} node(s) -> status todo, completed_at / updated_at dropped`)

/* ── 5. state.json: empty path, nothing held ─────────────────────────────────────────────── */
const state = JSON.parse(readFileSync(join(SW, 'state.json'), 'utf8'))
for (const cycle of state.cycles) {
  cycle.path = []
  cycle.holding = []
  cycle.status = 'inactive'
}
writeFileSync(join(SW, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8')
say('== state.json ==')
say('  path [] , holding [] , status inactive')

/* ── 6. the two empty base repositories the pipeline needs ───────────────────────────────── */
say('== git base ==')
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
git(ROOT, ['init', '-q'])
git(ROOT, ['-c', 'user.email=rehearsal@local', '-c', 'user.name=rehearsal', 'commit', '-q', '--allow-empty', '-m', 'chore: initialize rehearsal workspace'])
say('  root: 1 empty base commit')
git(SW, ['init', '-q'])
git(SW, ['add', '-A'])
git(SW, ['-c', 'user.email=rehearsal@local', '-c', 'user.name=rehearsal', 'commit', '-q', '-m', 'chore: initialize rehearsal ledger'])
say('  ledger: 1 base commit')

say('\ndone.')
