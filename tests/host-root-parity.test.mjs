/* The parity file for the one root seam: the same session, asked through every door, answers one
 * root — and one canonical spelling of it.
 *
 * The doors this half has, and what each does with the answer:
 *
 * - the wake's per-step condition (`offersTool`) reads a record at the root;
 * - the instruction injection (`holderOf`) reads one at the root as well;
 * - the gateway's endpoints narrow the root at their boundary (a non-string, non-absent argument
 *   is refused there, before any door) and hand the root to the panel, in the spelling the caller
 *   used — the panel's record reads land on the record-bearing tree, the injection's own;
 * - the dispatch relay and the session opener hand it to the engine and to `create()` in the one
 *   canonical spelling;
 * - the agent-facing tool runs its word at the root.
 *
 * Before the seam each of those carried a fallback order of its own, so the same session could be
 * answered two ways by two doors and nothing said so: a difference in one door surfaced as a failing
 * case in another door's file. These cases are the cross-check — one session, every door, one answer
 * — plus the differences the seam made explicit rather than implicit: which doors read a record (and
 * are therefore led from a linked worktree to its main tree by the engine's `projectRootOf`, which
 * this line does not touch), and which doors the host asks synchronously (and therefore never read
 * the persisted session header).
 *
 *   node --test tests/host-root-parity.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { answer, open, projectRootOf } from 'superworker-core'
import { canonicalRootOf, workspaceRootOf } from '../src/host/seams.ts'
import { executorOf, openConsultSession, openNodeSession } from '../src/host/executor.ts'
import { SuperworkerRecordsGateway } from '../src/host/gateway.ts'
import { ASSEMBLE_EVENT, INSTRUCTION_CONTEXT_NAME, installInstructionContext, markSuperworkerVerbRun } from '../src/host/instruction-context.ts'
import { advanceLine, dispatchCell } from '../src/host/relay.ts'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'
import { defineSuperworkerTool } from '../src/host/tool.ts'
import { offersTool } from '../src/host/wake.ts'
import { fakeAgents } from './helpers/agents-registry.mjs'
import { pinHome } from './helpers/env.mjs'
import { gitIn } from './helpers/git.mjs'
import { fakeContext } from './helpers/host-context.mjs'
import { absentError, readPage } from './helpers/workspace-files-port.mjs'

/* The engine reads this machine's layer during dispatch preparation, and the opener reads the
 * placement record under the DSH home: both are pinned to a temporary home here, never the machine's. */
const pinned = pinHome(['SUPERWORKER_HOME_DIR', 'DSH_HOME'], 'superworker-parity-home-')
test.after(pinned.restore)

/** The session every case asks about: one id, so the doors cannot be answering about different ones.
 * It has walked in — a real verb run, marked here once — so the injection door is judged on the tree
 * it reads, which is what this file is about, and never on the walk-in gate. */
const SESSION = 's1'
markSuperworkerVerbRun(SESSION)

/**
 * A real workspace with a real record in it: the layout the engine itself lays down, then one active
 * line holding one node and one standing constraint, so every door has something to read and one
 * door has something to open. Written over `ledger.init()`'s own output, so the layout files are the
 * ones the engine really writes rather than a copy of their names kept here.
 */
async function rigRecord() {
  const root = mkdtempSync(join(tmpdir(), 'superworker-parity-ws-'))
  await open(root).ledger.init()
  writeFileSync(join(root, '.superworker', 'ideas.json'), JSON.stringify({
    nodes: { 'n-1': { status: 'todo', title: 'first', mode: 'auto', dependencies: [] } },
  }))
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({
    cycles: [{ id: 'c-1', status: 'active', tags: [], holding: [{ id: 'n-1', since: '2026-10-18T00:00:00Z' }], path: [] }],
  }))
  return root
}

/** One root, one second spelling of it: a directory junction, the shape a symlinked home or a short (8.3) name puts in front of this half. */
function aliasOf(root) {
  const alias = join(tmpdir(), `superworker-parity-alias-${process.pid}-${Math.random().toString(16).slice(2)}`)
  symlinkSync(root, alias, 'junction')
  return alias
}

/**
 * A workspace-files port over the real tree, reading whichever root the scope names; `seen` collects
 * every root it was read through, which is how a case judges the root a door handed the engine.
 */
function fsPort(seen) {
  return {
    async list(scope, dir) {
      const base = scope?.workspaceRoot ?? ''
      if (seen !== undefined) seen.push(base)
      try {
        const { readdirSync } = await import('node:fs')
        return {
          path: dir,
          entries: readdirSync(join(base, dir), { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
          })),
          truncated: false,
        }
      } catch {
        throw absentError(dir)
      }
    },
    async read(scope, path, range) {
      const base = scope?.workspaceRoot ?? ''
      if (seen !== undefined) seen.push(base)
      try {
        const { readFileSync } = await import('node:fs')
        return readPage(readFileSync(join(base, path), 'utf8').split('\r\n').join('\n'), range)
      } catch {
        throw absentError(path)
      }
    },
  }
}

/**
 * The host context the doors read: one live session header naming `sessionCwd`, the sandbox policy
 * naming `sandboxRoot`, a record port over the real tree, an event bus, a logger, the prompt service
 * the injection door needs to exist at all, and the services a case adds. `seen` collects the roots
 * the port was read through.
 */
function context({ sessionCwd, sandboxRoot, seen, services = {}, port } = {}) {
  return fakeContext({
    sessionCwd,
    sandboxRoot,
    port: port ?? fsPort(seen),
    bus: true,
    logger: true,
    services: { sessions: {}, systemPrompt: { context: () => () => undefined }, ...services },
  })
}

/** The text the shipped instruction plugin prints for its default read at one root. */
async function readerView(root) {
  const said = await answer(['instruction', 'list'], { root, pluginsDir: shippedPluginsDir() })
  assert.equal(said.code, 0, said.stderr)
  return said.stdout.replace(/\n+$/u, '')
}

/** The assembly a step is given, with this module's contribution in place and empty. */
const freshAssembly = () => ({ sections: [], contexts: [{ name: INSTRUCTION_CONTEXT_NAME, text: '' }], tools: [], variables: {} })

/**
 * The injection door, driven the way the host drives it: install the line, run its assembly listener,
 * and read back what it wrote into the step's assembly.
 *
 * The context carries an `on` of this file's own — the shared stand-in's bus answers listeners but
 * discards what they return, and the waterfall's return value is exactly what is being judged — plus
 * a prompt service that collects the registration.
 */
async function injectedText(fake) {
  const listeners = []
  const ctx = { ...fake.ctx, on: (name, listener) => (listeners.push({ name, listener }), () => undefined) }
  const off = installInstructionContext(ctx, {})
  try {
    const listener = listeners.find((entry) => entry.name === ASSEMBLE_EVENT)?.listener
    assert.ok(listener !== undefined, 'no assembly listener was installed')
    const patched = await listener(freshAssembly(), { agent: { id: SESSION } }, () => Promise.resolve(freshAssembly()))
    return patched.contexts[0].text
  } finally {
    off()
  }
}

/** The root the `doctor` word prints: the project root the tool's own call was resolved at. */
async function toolRoot(fake) {
  const tool = defineSuperworkerTool({
    ctx: fake.ctx,
    executorOf: (sessionId, root) => executorOf(fake.ctx, sessionId, root),
  })
  const said = await tool.execute({ word: 'doctor' }, { agent: { id: SESSION } })
  const line = /^project root: (.*)$/mu.exec(said.stdout)
  assert.ok(line !== null, `the tool door printed no project root: ${said.stdout}${said.stderr}`)
  return line[1]
}

/**
 * One session, every door, one root — the case the seam exists for.
 *
 * The session's own root is an **alias** of the record tree, which is what makes the two halves of
 * one answer distinguishable: the doors that hand a root outward name the alias — they always did,
 * and that spelling is what the panel's selector is showing — while the doors that write a root down
 * take the one canonical spelling, which is the tree behind the alias. Before the seam those halves
 * came from four different functions; what is judged here is that every door now answers the root it
 * answered before, and that the two spellings in play are one root.
 */
test('One session, every door: the same root, and one canonical spelling of it', async () => {
  const real = await rigRecord()
  const alias = aliasOf(real)
  const agents = fakeAgents()
  const seen = []
  const fake = context({ sessionCwd: alias, sandboxRoot: alias, seen, services: { agents: agents.registry } })
  try {
    const said = await answer(['instruction', 'add', '--scope', 'global', '--text', 'a constraint every door must find'], {
      root: real,
      pluginsDir: shippedPluginsDir(),
    })
    assert.equal(said.code, 0, said.stderr)
    const listing = await readerView(real)
    assert.ok(listing.includes('a constraint every door must find'), 'the record really answers this sentence')

    /* 1. The wake's condition: a record at the root it resolves. The agent carries no cwd of its own,
     *    so the session store is what answers. */
    assert.equal(offersTool(fake.ctx, { id: SESSION }), true, 'the wake door did not land on the record tree')

    /* 2. The instruction injection: the shipped plugin's listing at that root, byte for byte. */
    assert.equal(await injectedText(fake), listing, 'the injection door read a different tree')

    /* 3. The gateway's endpoints: the root it hands the panel. */
    const gateway = new SuperworkerRecordsGateway(fake.ctx)
    const reading = await gateway.read(SESSION, '')
    assert.equal(reading.workspaceRoot, alias, 'the gateway door did not name the caller\'s spelling')

    /* 4. The dispatch relay: the root it handed the engine and the opener. The port's own log is
     *    cleared first, because the gateway's read above went through it in the alias spelling and
     *    that is a different door's answer. */
    seen.length = 0
    const dispatched = await dispatchCell(fake.ctx, SESSION, alias, 'c-1', 'n-1')
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    assert.ok(seen.length > 0, 'the dispatch read nothing through the port: there is nothing to judge here')
    assert.deepEqual([...new Set(seen)], [realpathSync(real)], 'the relay door handed out a second spelling of the root')

    /* 5. The session opener: the cwd the session was created in. The dispatch above minted a session
     *    of its own, so the one this door created is the entry added between these two counts — not
     *    the first row of the table, which is the relay's. */
    const openedBefore = agents.created.length
    const opened = await openNodeSession(fake.ctx, SESSION, alias, 'c-1', 'n-1')
    assert.equal(opened.ok, true, JSON.stringify(opened))
    assert.equal(agents.created.length, openedBefore + 1, 'the opener minted no session of its own')
    const openerCwd = agents.created[openedBefore].options.meta.cwd

    /* 6. The agent-facing tool: the project root its own word answered at. */
    assert.equal(await toolRoot(fake), alias, 'the tool door did not name the caller\'s spelling')

    /* The parity itself, over the four doors that hand a root out: each answers the caller's spelling
     * or the canonical one, and the two spellings are one tree. `canonicalRootOf` is the seam's own
     * answer, so this reads as "every handing door's root canonicalises to one string" rather than as
     * a comparison against `realpathSync`.
     *
     * The two remaining doors are read-only and hand out no root at all: the wake's condition answers
     * a boolean and the injection writes text into a step's assembly. They are judged above on the
     * tree they read (steps 1 and 2), and they have no cell here because there is nothing for them to
     * hand over — a literal in this table would be a value no door ever answered. */
    const doorway = {
      gateway: reading.workspaceRoot,
      relay: seen[0],
      opener: openerCwd,
      tool: await toolRoot(fake),
    }
    const spellings = [...new Set(Object.values(doorway))]
    assert.deepEqual(
      spellings.sort(),
      [alias, realpathSync(real)].sort(),
      `the doors answered more than the two spellings of one tree: ${JSON.stringify(doorway)}`,
    )
    for (const [door, root] of Object.entries(doorway)) {
      assert.equal(await canonicalRootOf(root), realpathSync(real), `${door} canonicalises to another tree`)
    }
    /* The two doors that answer a screen or a word with a root answered the caller's spelling, and
     * the two that write a root down answered the canonical one: that split is what each door
     * answered before the seam, and keeping it is the whole constraint on this change. */
    assert.equal(doorway.gateway, alias)
    assert.equal(doorway.tool, alias)
    assert.equal(doorway.relay, realpathSync(real))
    assert.equal(doorway.opener, realpathSync(real))
  } finally {
    rmSync(alias, { recursive: true, force: true })
    rmSync(real, { recursive: true, force: true })
  }
})

/**
 * A linked worktree checkout: git itself writes the pointer these doors read, so the `.git` file is
 * the one production meets — and the checkout carries no record of its own, the account stays in the
 * main tree.
 *
 * This case pins the split rather than papering over it: the doors that read a record are led
 * back to the main tree (that leading is the engine's `projectRootOf`, untouched by this change) —
 * and the panel's read door is one of them now, its unnamed read landing on the tree the injection
 * reads — while the doors that hand a root to the engine or to `create()` hand out the checkout
 * itself. What the seam settles for all of them is the root before that leading.
 *
 * What this case does not pin either is the canonical spelling through the worktree path alone: on this
 * machine `git worktree add` writes a checkout whose path is already its own `realpath`, so those two
 * spellings are one string here. That layer is pinned by the junction spelling below (and by the alias
 * case above): a second, separate spelling of the checkout is stacked in front of it, and the opener —
 * the one handing door that writes its root down — is asked to open at that spelling. Its answer must
 * be the checkout's real path, not the junction handed in, which is a reading `.canonicalRoot()`
 * swapped for `.root` cannot produce.
 */
test('A linked worktree checkout: the record-reading doors land on the main tree, the handing doors hand out one spelling', async () => {
  const main = mkdtempSync(join(tmpdir(), 'superworker-parity-main-'))
  const holder = mkdtempSync(join(tmpdir(), 'superworker-parity-holder-'))
  const worktree = join(holder, 'tree')
  /* A second spelling of the checkout, made before the case starts: a junction is the shape a symlinked
   * home or a short (8.3) name puts in front of this half, and it is the only way on this machine to
   * tell "the opener canonicalises" from "the opener took the letters it was handed". */
  const checkoutAlias = join(tmpdir(), `superworker-parity-checkout-alias-${process.pid}-${Math.random().toString(16).slice(2)}`)
  try {
    await gitIn(main, 'init', '-b', 'main')
    await gitIn(main, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(main, 'seed.md'), '# seed\n', 'utf8')
    await gitIn(main, 'add', '-A')
    await gitIn(main, 'commit', '-m', 'seed', '--no-gpg-sign')
    await gitIn(main, 'worktree', 'add', worktree, '-b', 'side')

    await open(main).ledger.init()
    const said = await answer(['instruction', 'add', '--scope', 'global', '--text', 'a constraint a worktree session must carry'], {
      root: main,
      pluginsDir: shippedPluginsDir(),
    })
    assert.equal(said.code, 0, said.stderr)
    const listing = await readerView(main)
    assert.ok(listing.includes('a constraint a worktree session must carry'), 'the main tree really answers this sentence')

    const agents = fakeAgents()
    const fake = context({
      sessionCwd: worktree,
      sandboxRoot: worktree,
      services: { agents: agents.registry },
      /* The prompt a real dispatch preparation would have landed, served so the opener can run: the
       * point of this door is the root it creates the session under, not the record it reads. */
      port: {
        async list(_scope, dir) {
          if (dir !== '.superworker/meta/launch/c-1/n-1') throw absentError(dir)
          return { path: dir, entries: [{ name: 'prompt.txt', type: 'file' }], truncated: false }
        },
        async read(_scope, path, range) {
          if (path !== '.superworker/meta/launch/c-1/n-1/prompt.txt') throw absentError(path)
          return readPage('/sw-conduct n-1 [pipeline]\n', range)
        },
      },
    })
    try {
      /* The record-reading doors: one main tree, all four — the panel's unnamed read is one of
       * them now, landing on the tree the injection resolves. */
      assert.equal(offersTool(fake.ctx, { id: SESSION }), true, 'the wake door did not reach the main tree')
      assert.equal(await injectedText(fake), listing, 'the injection door read something other than the main tree')
      assert.equal(await toolRoot(fake), realpathSync(main), 'the tool door answered a root other than the main tree')

      /* The panel's read door: the record-bearing tree, the engine's own leading. */
      const gateway = new SuperworkerRecordsGateway(fake.ctx)
      const reading = await gateway.read(SESSION, '')
      assert.equal(reading.workspaceRoot, projectRootOf(undefined, worktree), 'the panel read door did not land on the record-bearing tree')
      assert.equal(await canonicalRootOf(reading.workspaceRoot), realpathSync(main), 'the panel read door landed on a tree other than the main one')

      const opened = await openNodeSession(fake.ctx, SESSION, worktree, 'c-1', 'n-1')
      assert.equal(opened.ok, true, JSON.stringify(opened))
      assert.equal(agents.created.length, 1, 'the opener minted one session')
      assert.equal(agents.created[0].options.meta.cwd, realpathSync(worktree), 'the opener created the session somewhere other than the checkout')

      /* The spelling layer, read through the checkout's own second spelling: the opener is handed the
       * junction and must still create the session at the checkout behind it. This is the reading the
       * linked-worktree path cannot take on its own (the checkout is already its realpath here), and
       * the one a `.canonicalRoot()` swapped for `.root` goes red on — the session would be minted in
       * the junction's letters, which is a second spelling of one workspace. */
      symlinkSync(worktree, checkoutAlias, 'junction')
      const aliasAgents = fakeAgents()
      const aliasFake = context({
        sessionCwd: checkoutAlias,
        sandboxRoot: checkoutAlias,
        services: { agents: aliasAgents.registry },
        port: {
          async list(_scope, dir) {
            if (dir !== '.superworker/meta/launch/c-1/n-1') throw absentError(dir)
            return { path: dir, entries: [{ name: 'prompt.txt', type: 'file' }], truncated: false }
          },
          async read(_scope, path, range) {
            if (path !== '.superworker/meta/launch/c-1/n-1/prompt.txt') throw absentError(path)
            return readPage('/sw-conduct n-1 [pipeline]\n', range)
          },
        },
      })
      const openedAtAlias = await openNodeSession(aliasFake.ctx, SESSION, checkoutAlias, 'c-1', 'n-1')
      assert.equal(openedAtAlias.ok, true, JSON.stringify(openedAtAlias))
      assert.equal(aliasAgents.created.length, 1, 'the opener minted one session at the junction spelling')
      assert.equal(
        aliasAgents.created[0].options.meta.cwd,
        realpathSync(worktree),
        'the opener created the session at the letters it was handed instead of the checkout behind them',
      )
      assert.ok(aliasAgents.created[0].options.meta.cwd !== checkoutAlias, 'this reading needs the two spellings to differ')
    } finally {
      rmSync(checkoutAlias, { recursive: true, force: true })
      rmSync(holder, { recursive: true, force: true })
      rmSync(main, { recursive: true, force: true })
    }
  } finally {
    rmSync(checkoutAlias, { recursive: true, force: true })
    rmSync(holder, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  }
})

/**
 * The panel and the injection read one record: a linked worktree session, both doors, one root.
 *
 * The case the panel-alignment node exists for. The session sits in a real worktree checkout (git
 * wrote the pointer), the account lives in the main tree alone, and the two doors are asked with
 * nothing named: the panel's read answers the record-bearing root — byte for byte the root the
 * injection resolves with `projectRootOf(undefined, root)` — and carries that tree's instruction
 * account, the reading the panel's column draws. A write from the same door lands in the same
 * account, and the worktree holds no copy of its own, so "one record" is read off the files
 * rather than asserted of the roots alone.
 */
test('The panel reads the record the injection reads: one linked worktree session, two doors, one root', async () => {
  const main = mkdtempSync(join(tmpdir(), 'superworker-parity-panel-main-'))
  const holder = mkdtempSync(join(tmpdir(), 'superworker-parity-panel-holder-'))
  const worktree = join(holder, 'tree')
  try {
    await gitIn(main, 'init', '-b', 'main')
    await gitIn(main, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(main, 'seed.md'), '# seed\n', 'utf8')
    await gitIn(main, 'add', '-A')
    await gitIn(main, 'commit', '-m', 'seed', '--no-gpg-sign')
    await gitIn(main, 'worktree', 'add', worktree, '-b', 'side')
    await open(main).ledger.init()
    const said = await answer(['instruction', 'add', '--scope', 'global', '--text', 'a constraint only the main tree holds'], {
      root: main,
      pluginsDir: shippedPluginsDir(),
    })
    assert.equal(said.code, 0, said.stderr)

    const fake = context({ sessionCwd: worktree, sandboxRoot: worktree })
    const gateway = new SuperworkerRecordsGateway(fake.ctx)

    /* The read parity: the panel's unnamed read answers the injection's root, and the reading
     * carries the main tree's instruction account — the worktree has none of its own. */
    const reading = await gateway.read(SESSION, '')
    assert.equal(reading.workspaceRoot, projectRootOf(undefined, worktree), 'the panel read root is not the root the context injection resolves')
    assert.equal(reading.sources.instructions, 'read', 'the panel reading carried no instruction account')

    /* The write parity: a panel add from the worktree session lands in the main tree's account. */
    const written = await gateway.addInstruction(SESSION, '', 'a panel sentence at the worktree session', 'global', '')
    assert.equal(written.ok, true, `the panel add was refused: ${String(written.detail)}`)
    const account = JSON.parse(readFileSync(join(main, '.superworker', 'instructions.json'), 'utf8'))
    assert.ok(
      (account.instructions ?? []).some((entry) => entry.text === 'a panel sentence at the worktree session'),
      'the panel add did not land in the main tree\'s account',
    )
    assert.ok(!existsSync(join(worktree, '.superworker')), 'the worktree grew a record of its own, so the parity above proves nothing')
  } finally {
    rmSync(holder, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  }
})

/**
 * The session side of the frame stays at the checkout: one linked worktree, both halves, two trees.
 *
 * The cell the C1 round asked for. The panel's records half reads the main tree (the case above
 * pins it), but the session side — the notes, the dispatch claims, the handoff tickets — is
 * written at the root the dispatch was handed, which for a worktree session is the checkout. A
 * frame whose session side read anywhere else would show a dispatched cell as re-dispatchable and
 * a working session as gone. So the frame here is judged three ways at once: the cell state off
 * the files (claim, run note, ticket planted in the checkout, all three read back), the records
 * off the main tree, and — straight off the port's own log — the roots each half really asked:
 * the session side's walks at the checkout, the records' reads at the main tree, and neither half
 * on the other's tree.
 */
test('The frame\'s session side reads the checkout, its records the main tree: one linked worktree, two trees', async () => {
  const main = mkdtempSync(join(tmpdir(), 'superworker-parity-sess-main-'))
  const holder = mkdtempSync(join(tmpdir(), 'superworker-parity-sess-holder-'))
  const worktree = join(holder, 'tree')
  try {
    await gitIn(main, 'init', '-b', 'main')
    await gitIn(main, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(main, 'seed.md'), '# seed\n', 'utf8')
    await gitIn(main, 'add', '-A')
    await gitIn(main, 'commit', '-m', 'seed', '--no-gpg-sign')
    await gitIn(main, 'worktree', 'add', worktree, '-b', 'side')
    await open(main).ledger.init()
    /* An instruction account on the main tree: the records half's cell needs a source that is
       really there (ledger.init alone does not lay one down), and its one entry is what the frame
       must name when it claims to have read this tree. */
    writeFileSync(join(main, '.superworker', 'instructions.json'), JSON.stringify({
      instructions: [{ id: 'i-1', text: 'the main tree holds this sentence', scope: 'global', state: 'live', at: '2026-10-01T00:00:00Z' }],
    }))

    /* The session's own marks, where a dispatch at the checkout writes them: the started claim,
     * the run note, and a handed-in ticket. The record tree holds none of them. */
    mkdirSync(join(worktree, '.superworker', 'meta', 'launch', 'c-1', 'n-1'), { recursive: true })
    writeFileSync(join(worktree, '.superworker', 'meta', 'launch', 'c-1', 'n-1', 'started'), 'c-1\n')
    mkdirSync(join(worktree, '.superworker', 'meta', 'sessions'), { recursive: true })
    writeFileSync(join(worktree, '.superworker', 'meta', 'sessions', 'n-1.json'), JSON.stringify({
      node: 'n-1',
      v: 1,
      run: [{ session: 'session-run', at: '2026-10-02T00:00:00Z' }],
    }))
    mkdirSync(join(worktree, '.superworker', 'signals', 'c-1'), { recursive: true })
    writeFileSync(join(worktree, '.superworker', 'signals', 'c-1', 'n-1.json'), JSON.stringify({ status: 'passed' }))

    /* The port logs which root asked for which path — the reading that a same-tree rig cannot
     * take, since there the two halves' roots are one string. */
    const seen = []
    const disk = fsPort()
    const fake = context({
      sessionCwd: worktree,
      sandboxRoot: worktree,
      port: {
        async list(scope, dir, signal) { seen.push(`${scope.workspaceRoot} :: ${dir}`); return disk.list(scope, dir, signal) },
        async read(scope, path, range, signal) { seen.push(`${scope.workspaceRoot} :: ${path}`); return disk.read(scope, path, range, signal) },
      },
    })
    const recordRoot = projectRootOf(undefined, worktree)
    const gateway = new SuperworkerRecordsGateway(fake.ctx)
    const cancel = new AbortController()
    const frames = []
    try {
      for await (const frame of gateway.watch(SESSION, '', cancel.signal)) { frames.push(frame); break }
    } finally {
      /* A red assertion above this line must not leave the channel open: a follower that holds
         the pump's roots keeps the run alive after the file is over. */
      cancel.abort()
    }

    assert.equal(frames.length, 1, 'the stream sent no first frame')
    const frame = frames[0]

    /* The cell state: claim, run note and ticket read off the checkout; the records off the main
     * tree — and the one entry the account was seeded with is the reading itself. */
    assert.deepEqual(frame.sessions.claims, { 'n-1': 'c-1' }, 'the frame did not carry the checkout\'s dispatch claim')
    assert.deepEqual(frame.sessions.tickets, { 'n-1': 'passed' }, 'the frame did not carry the checkout\'s handoff ticket')
    assert.ok(frame.sessions.notes['n-1.json'] !== undefined, 'the frame did not carry the checkout\'s run note')
    assert.equal(frame.reading.sources.instructions, 'read', 'the frame did not carry the main tree\'s instruction account')
    assert.deepEqual(
      frame.reading.instructions.map((entry) => entry.text),
      ['the main tree holds this sentence'],
      'the frame\'s instruction column was read off some other tree than the main one',
    )

    /* The roots behind those readings, off the port's own log: each half on its own tree, and
     * neither half on the other's. */
    assert.ok(seen.some((line) => line.startsWith(`${worktree} :: .superworker/meta/launch`)), 'the session side did not list the checkout\'s launch cells')
    assert.ok(seen.some((line) => line.startsWith(`${worktree} :: .superworker/signals`)), 'the session side did not list the checkout\'s handoff tickets')
    assert.ok(seen.some((line) => line.startsWith(`${recordRoot} :: .superworker/instructions.json`)), 'the records half did not read the main tree\'s instruction account')
    assert.ok(!seen.some((line) => line.startsWith(`${recordRoot} :: .superworker/meta/`)), 'the session side was read off the main tree')
    assert.ok(!seen.some((line) => line.startsWith(`${recordRoot} :: .superworker/signals`)), 'the session side\'s tickets were read off the main tree')
    assert.ok(!seen.some((line) => line.startsWith(`${worktree} :: .superworker/instructions.json`)), 'the records half was read off the checkout')
  } finally {
    rmSync(holder, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  }
})

/**
 * The one difference between the doors the seam now spells as fields: the wake's step condition and
 * the instruction injection are asked synchronously — inside a step proposal and inside a
 * runtime-context provider — so they stop at the live session store, while every door that may await
 * goes on to the persisted header.
 *
 * A session only the store knows: the doors that may await answer the stored header's cwd, and the
 * two synchronous ones answer the sandbox policy's root without touching the store at all (that read
 * is a disk call, and there is no turn to spend it in).
 *
 * The opener is the door with the other reading of an empty name, and this case pins it: handed `''`
 * it takes the empty root rather than asking after a session, so the stored header is read once here
 * (by the gateway) and never a second time. That is the answer it gave before the seam, and the one
 * the relay gives too (the case below).
 */
test('A session only the store knows: the awaiting doors read the stored header, the synchronous ones never ask', async () => {
  const storedRoot = await rigRecord()
  const fallback = mkdtempSync(join(tmpdir(), 'superworker-parity-fallback-'))
  const agents = fakeAgents()
  try {
    const fake = fakeContext({
      live: {},
      sessionCwd: undefined,
      sandboxRoot: fallback,
      /* The real tree behind the port: the gateway's read is judged on the root it names, and this
       * port answers whichever root the scope carries, so the reading below really comes off the
       * stored tree. */
      port: fsPort(),
      stored: { [SESSION]: { header: { cwd: storedRoot } } },
      services: { sessions: {}, agents: agents.registry, systemPrompt: { context: () => () => undefined } },
    })
    const asked = fake.statCalls

    /* The two synchronous doors, asked first: the empty list below is what proves they never reached
     * the persisted record. */
    assert.equal(offersTool(fake.ctx, { id: SESSION }), false, 'the wake door read a record the sandbox root does not hold')
    assert.equal(await injectedText(fake), '', 'the injection door carried a listing from a root it must not have read')
    assert.deepEqual(asked, [], 'a synchronous door read the persisted session header')

    /* The awaiting doors: the stored header's cwd, with the store really asked. */
    const gateway = new SuperworkerRecordsGateway(fake.ctx)
    const reading = await gateway.read(SESSION, '')
    assert.equal(reading.workspaceRoot, storedRoot, 'the gateway door did not answer the stored header\'s cwd')
    assert.deepEqual(asked, [SESSION], 'the gateway door did not ask the persisted store exactly once')

    /* The opener takes the root it was handed, and this call was handed nothing: an empty string is
     * the empty root at this door, not "ask the session". So it refuses the cell before reading any
     * record, exactly as it did before the seam — no second store read, no session opened. */
    const opened = await openNodeSession(fake.ctx, SESSION, '', 'c-1', 'n-1')
    assert.equal(opened.ok, false, 'a cell with no prompt must not open')
    assert.equal(opened.code, 'prompt-missing')
    assert.deepEqual(asked, [SESSION], 'the opener resolved a root of its own for an empty name')
    assert.equal(agents.created.length, 0, 'an unnamed open must not mint a session')
  } finally {
    rmSync(storedRoot, { recursive: true, force: true })
    rmSync(fallback, { recursive: true, force: true })
  }
})

/**
 * The fallback order's last two steps, one pair at a time — the stretch the seam's own doc spells as
 * "a live session whose header carries no cwd has already answered, and asking the disk after it would
 * let a stale record contradict the running session", and "the sandbox policy's root is the last step".
 *
 * A reading of that sentence has to keep the two steps **apart**, so every source here is a different
 * real directory: a live header with a cwd, a persisted header, the sandbox policy, and a named root
 * for the control at the end. Asking the one seam with the same question under each pairing then tells
 * which step answered: the header's own directory, the store's, or the policy's — four strings, so no
 * step can be mistaken for its neighbour by landing on the same answer by accident.
 *
 * Each pairing is also judged on `statCalls`, the store's own log: the disk is either asked or it is
 * not, and that is the half a string comparison cannot see. In order:
 *
 * 1. a live header **with** a cwd wins over the sandbox policy — the step above it answers;
 * 2. a live header **without** a cwd answers, and the persisted header is never even asked — this is
 *    the one the doc's sentence is about: a stale record must not contradict a running session;
 * 3. only when the live store knows no such session does the persisted header's cwd answer;
 * 4. a persisted header with no cwd falls to the sandbox policy;
 * 5. a host keeping no persisted record at all falls to the sandbox policy, without a store call;
 * 6. the sandbox policy with no live session and no record is the last step, and it answers alone.
 *
 * The control at the end puts a named root in front of all four: it wins, and nothing below it is asked
 * — which is what makes the rest of the table a reading of the fallback order rather than of `named`.
 */
test('The fallback order\'s last two steps: a live header ends the disk, and the sandbox policy is last', async () => {
  /* Four distinct real directories: a value each step can answer with, none of them a literal. */
  const live = await rigRecord()
  const stored = await rigRecord()
  const sandbox = await rigRecord()
  const named = await rigRecord()
  /** One seam question over a context whose four sources are the four trees above, minus the ones a step says are absent. */
  const ask = async ({ liveHeader, storedHeader, namedRoot, keepSandbox = true } = {}) => {
    const fake = fakeContext({
      live: liveHeader === undefined ? {} : { [SESSION]: { header: liveHeader } },
      sessionCwd: undefined,
      ...(storedHeader === undefined ? {} : { stored: { [SESSION]: { header: storedHeader } } }),
      ...(keepSandbox ? { sandboxRoot: sandbox } : {}),
      port: fsPort(),
      services: { sessions: {} },
    })
    const question = { sessionId: SESSION, ...(namedRoot === undefined ? {} : { named: namedRoot }) }
    const answer = await workspaceRootOf(fake.ctx, question)
    return { root: answer.root, asked: [...fake.statCalls] }
  }
  try {
    /* 1. The live header's cwd: the step above the sandbox policy answers, and the disk is not touched. */
    assert.deepEqual(
      await ask({ liveHeader: { cwd: live } }),
      { root: live, asked: [] },
      'a live header carrying a cwd did not speak, or the persisted record was asked after it',
    )

    /* 2. A live header with no cwd **answers** — the persisted header must not be consulted. */
    assert.deepEqual(
      await ask({ liveHeader: {}, storedHeader: { cwd: stored } }),
      { root: sandbox, asked: [] },
      'a live header with no cwd let the stale persisted record speak (or stopped the order short of the sandbox policy)',
    )

    /* 3. No live session: the persisted header's cwd answers, and the store really was asked. */
    assert.deepEqual(
      await ask({ storedHeader: { cwd: stored } }),
      { root: stored, asked: [SESSION] },
      'a session only the store knows did not answer the persisted header\'s cwd',
    )

    /* 4. A persisted header with no cwd: the sandbox policy. */
    assert.deepEqual(
      await ask({ storedHeader: {} }),
      { root: sandbox, asked: [SESSION] },
      'a persisted header with no cwd did not fall to the sandbox policy',
    )

    /* 5. No persisted record kept at all: the sandbox policy, with no store call spent. */
    const noStore = await ask({})
    assert.deepEqual(noStore, { root: sandbox, asked: [] }, 'a host keeping no persisted record did not fall straight to the sandbox policy')

    /* 6. Nothing at all below the sandbox policy. The asynchronous form reads that root as the inject
     *    requirement it is, so a host that lost it does not answer an empty path: the seam refuses,
     *    and the door that asked refuses with that reason. This is the one step whose answer is a
     *    refusal rather than a directory, and it is stated as such. */
    await assert.rejects(
      async () => {
        const fake = fakeContext({ live: {}, sessionCwd: undefined, port: fsPort(), services: { sessions: {} } })
        return workspaceRootOf(fake.ctx, { sessionId: SESSION })
      },
      'a host holding neither a session root nor a sandbox policy answered a root it does not have',
    )

    /* The control: a named root in front of the four sources wins, and nothing below it is asked. */
    assert.deepEqual(
      await ask({ namedRoot: named, liveHeader: { cwd: live }, storedHeader: { cwd: stored } }),
      { root: named, asked: [] },
      'a named root did not win over the live header, the persisted one and the sandbox policy',
    )
  } finally {
    for (const root of [live, stored, sandbox, named]) rmSync(root, { recursive: true, force: true })
  }
})

/**
 * An unnamed call at the two doors that hand a root to the engine: the answer is the empty root, and
 * therefore a refusal — not a silent widening into the calling session's own workspace.
 *
 * This is the one reading the seam could quietly have changed and did not: the panel's endpoints read
 * an empty string as "this session's own root", and a door that takes its spelling from that reading
 * would open a session, and land a claim, in a workspace the caller never named. The relay and the
 * opener take the root they were handed, so `''` is the empty root at their seam question: the engine
 * refuses it before any record read, and nothing is minted.
 *
 * One cell per door, judged on what the call answered and on the fact that nothing landed.
 */
test('An unnamed call at the handing doors: the empty root, refused, and nothing written', async () => {
  const root = await rigRecord()
  const agents = fakeAgents()
  /* The session store names the record tree, so a door that fell back to the session would have a
   * real workspace to open in — and this case would go red on the session count, not on a missing
   * directory. That is what makes the cell bite. */
  const seen = []
  const fake = context({ sessionCwd: root, sandboxRoot: root, seen, services: { agents: agents.registry } })
  try {
    const dispatched = await dispatchCell(fake.ctx, SESSION, '', 'c-1', 'n-1')
    assert.equal(dispatched.ok, false, 'a dispatch with no named root must be refused')
    assert.equal(dispatched.code, 'dispatch-refused', dispatched.detail)
    assert.equal(agents.created.length, 0, 'an unnamed dispatch opened a session in a workspace nobody named')

    const advanced = await advanceLine(fake.ctx, SESSION, '', 'c-1')
    assert.equal(advanced.ok, false, 'an advance with no named root must be refused')
    assert.equal(advanced.code, 'dispatch-refused', advanced.detail)
    assert.equal(agents.created.length, 0, 'an unnamed advance opened a session')

    const opened = await openNodeSession(fake.ctx, SESSION, '', 'c-1', 'n-1')
    assert.equal(opened.ok, false, 'an open with no named root must be refused')
    assert.equal(opened.code, 'prompt-missing', JSON.stringify(opened))
    assert.equal(agents.created.length, 0, 'an unnamed open minted a session')
    assert.ok(!existsSync(claimPath(root, 'c-1', 'n-1')), 'an unnamed dispatch landed a claim on the session\'s tree')

    /* The consultations are the documented exception, and they keep it: an empty name there is the
     * calling session's own root, which is what that door has always answered. */
    const consulted = await openConsultSession(fake.ctx, SESSION, '')
    assert.equal(consulted.ok, true, JSON.stringify(consulted))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The started marker one dispatch of one cell lands: the claim's own path in the record. */
const claimPath = (root, cycle, node) => join(root, '.superworker', 'meta', 'launch', cycle, node, 'started')

/**
 * The wake door's other field, spelled as one: a step's own agent may carry the cwd, and that door
 * reads it before any service is asked. Two agents, one store, opposite answers — the agent carrying
 * the record tree is admitted, the one carrying a bare directory is not, whatever the store says
 * about the id they share.
 */
test('The wake door reads the step\'s own cwd before any service: two agents, one store, two answers', async () => {
  const withRecord = await rigRecord()
  const bare = mkdtempSync(join(tmpdir(), 'superworker-parity-bare-'))
  try {
    /* The store names the record tree for the id both agents share, so the second agent's answer can
     * only come from the cwd it carries. */
    const fake = context({ sessionCwd: withRecord, sandboxRoot: withRecord })
    assert.equal(offersTool(fake.ctx, { id: SESSION, session: { header: { cwd: withRecord } } }), true)
    assert.equal(
      offersTool(fake.ctx, { id: SESSION, session: { header: { cwd: bare } } }),
      false,
      'the step\'s own cwd did not win over the session store',
    )
    assert.equal(
      offersTool(fake.ctx, { id: SESSION, session: { header: { cwd: '' } } }),
      true,
      'an empty cwd names nothing, so the store answers',
    )
  } finally {
    rmSync(withRecord, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

/**
 * Every root a door can be handed, answered by that door itself — one table, four doors, twenty-one
 * shapes.
 *
 * This is the case the earlier version of this file was missing. Its five cases named a real root, an
 * alias of one, an empty string, "only the store knows" and "no identity at all": not one of them
 * handed a door a value that is not a string. A whole family of bugs lived in exactly that gap, and it
 * took three rounds to close because each round fixed the shape a reviewer had tried last:
 *
 * 1. `''` — read as a name, so a call that named nothing opened a session;
 * 2. `undefined`/`null`/a number — the same, because "is it a string" had replaced "is it there";
 * 3. a non-string **carrying a length** — the seam levelled every door onto "a non-empty string", but
 *    the consult open's own reading was HEAD's `workspaceRoot.length > 0`, a **property read**, so
 *    `['x']`, `new String('x')`, `{ length: 1 }` and `new Uint8Array([120])` were names there and are
 *    not names under a string test.
 *
 * The root cause of all three is one sentence: *"does this count as a name"* is a criterion each door
 * spelled differently, so it is now the question's own explicit field (`namedOf`, see `seams.ts`)
 * rather than one reading the seam picked for everybody. This table is what holds each door to its own
 * criterion, shape by shape, instead of to the seam's current favourite.
 *
 * So the table is exhaustive over **shapes**, not over the values a reviewer happened to try:
 *
 * - `named-real` — the caller names the record tree itself;
 * - `named-alias` — the caller names a second spelling of it (a junction);
 * - `empty` — `''`, the shape the first round of this family caught, and the one value every door
 *   agrees is not a name (`length === 0`);
 * - `undefined` — a value that is not there at all, and the shape `named?: string | undefined` makes
 *   the most likely to arrive by accident;
 * - `null` — a value that is there and is not a path;
 * - `number` — a value that is there and is not even close, which is what keeps the rule from being
 *   written down as "not a string" instead of "the field is present";
 * - `array-1` / `array-2` / `array-0` — `['x']`, `['x','y']`, `[]`: `.length` 1, 2 and 0. The third is
 *   the control that tells "a length was read" from "any array is a name": `[]` has no name in it and
 *   must follow the session, exactly as `''` does;
 * - `boxed-string` / `uint8` — `new String('x')` and `new Uint8Array([120])`: a non-string whose
 *   `.length` reads 1 for two unrelated reasons (a text object, a byte view);
 * - `length-1` — `{ length: 1 }`: nothing at all but the property, so a cell that answers it as a name
 *   proves the criterion really is the property read and not a lucky type check;
 * - `nan` / `zero` / `false` / `true` — the primitives a truthiness test would get wrong in four
 *   different ways (`NaN` and `0` are falsy and have no `.length`; `false` and `true` are falsy and
 *   truthy respectively);
 * - `whitespace` — `'   '`: a non-empty string that is not a path;
 * - `named-trailing-slash` / `named-dot` / `named-parent` — `'<real><sep>'`, `'<real><sep>.'` and
 *   `'<real><sep>..<sep><basename>'` (on Windows spelled with `\`, on POSIX with `/`): three spellings
 *   of the same real tree, which a length test cannot tell
 *   from a wrong path and a canonicaliser resolves — they are what pins "the door spells the root the
 *   caller used" at the boundary;
 * - `named-missing` — a real path that does not exist: there and not a directory, which is the last
 *   shape a resolver, not a name test, has to refuse.
 *
 * Each cell is answered by the door it names — `dispatchCell`, `advanceLine`, `openNodeSession`,
 * `openConsultSession` — and judged on three readings that are the door's own answers: the code it
 * refused with, the cwd of every session it minted, and whether a claim landed. A literal written
 * here instead of a door's answer would be a value no door ever answered, and would pin nothing. A
 * minted value that is not a directory at all is labelled by its own type and content
 * (`'<Array:["x"]>'`), because that **is** the answer: the consult open hands the value it was handed
 * to `create()`, and a label like `'named'` would pretend the door had resolved something.
 *
 * The session's own workspace is a **second record tree** — one that really can be opened in and really
 * can have a claim landed on it — while the root handed to the door is the first. That is what makes
 * "this door used the root it was handed" and "this door fell back to the session's own workspace" two
 * different answers a reader can tell apart: the fallback answers `ok`, mints a session in the
 * session's tree, and lands the claim there. A bare directory would not do: both branches would
 * refuse, and the cell would be green under the very bug it exists to catch.
 *
 * For the opener that used to be true only in principle. Its answer is `prompt-missing` whenever the
 * tree it lands on holds no launch prompt, and neither tree did: the branch that used the handed root
 * and the branch that fell back on the session's own answered the same string, so the `openNodeSession`
 * cells were green under three separate mutations that really do drop the handed root. Each cell now
 * plants the launch prompt in the session's own tree — and only there, so the `prompt-missing` the
 * named shapes gave before the seam stays the answer they are expected to give — and the fallback
 * becomes a visibly different answer: `ok`, one session minted in the session's tree.
 *
 * The answers are the ones these four doors gave before the seam existed, so this case is a
 * regression table rather than a new specification. Two things a reader should not misread:
 *
 * - `dispatchCell`/`advanceLine`/`openNodeSession` refuse every shape but a real root (with
 *   `dispatch-refused`, `dispatch-refused` and `prompt-missing` respectively) — they were handed the
 *   value unconditionally and the engine or the prompt read refused it, so they are the same answer for
 *   a value of any type;
 * - `openConsultSession` is the one door whose shapes differ from each other, and it differs **by the
 *   criterion**, which is why its column is the one with three kinds of answer in it: `''`, a number
 *   and the primitives are values that are there and are not names, so they follow the calling
 *   session's own workspace (that door's documented reading of all of them); `undefined` and `null`
 *   are `open-failed`, because reading `.length` off them threw before the seam existed; and the
 *   length-carrying non-strings are **minted as themselves** — HEAD handed them straight to `create()`.
 */
test('Every root shape, at every handing door: one table, and each cell is the door\'s own answer', async () => {
  /**
   * The twenty-one shapes, as what the caller hands over: two spellings of a real root, four tail
   * spellings of one, and every way of not naming a directory this seam has been wrong about.
   */
  const SHAPES = {
    'named-real': (rigged) => rigged.named,
    'named-alias': (rigged) => rigged.alias,
    empty: () => '',
    undefined: () => undefined,
    null: () => null,
    number: () => 42,
    'array-1': () => ['x'],
    'array-2': () => ['x', 'y'],
    'array-0': () => [],
    'boxed-string': () => new String('x'),
    'length-1': () => ({ length: 1 }),
    uint8: () => new Uint8Array([120]),
    nan: () => NaN,
    zero: () => 0,
    false: () => false,
    true: () => true,
    whitespace: () => '   ',
    'named-trailing-slash': (rigged) => `${rigged.named}${sep}`,
    'named-dot': (rigged) => `${rigged.named}${sep}.`,
    'named-parent': (rigged) => `${rigged.named}${sep}..${sep}${basename(rigged.named)}`,
    'named-missing': (rigged) => join(dirname(rigged.named), 'superworker-parity-does-not-exist'),
  }
  const DOORS = {
    dispatchCell: (handed) => (ctx) => dispatchCell(ctx, SESSION, handed, 'c-1', 'n-1'),
    advanceLine: (handed) => (ctx) => advanceLine(ctx, SESSION, handed, 'c-1'),
    openNodeSession: (handed) => (ctx) => openNodeSession(ctx, SESSION, handed, 'c-1', 'n-1'),
    openConsultSession: (handed) => (ctx) => openConsultSession(ctx, SESSION, handed),
  }
  /** What each shape answers at each door, as the four doors answered before the one root seam: the table this case pins. */
  const EXPECTED = {
    'named-real': {
      dispatchCell: { answer: 'ok', minted: ['named'], claim: 'named' },
      advanceLine: { answer: 'ok', minted: ['named'], claim: 'named' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['named'], claim: 'none' },
    },
    'named-alias': {
      dispatchCell: { answer: 'ok', minted: ['named'], claim: 'named' },
      advanceLine: { answer: 'ok', minted: ['named'], claim: 'named' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['named'], claim: 'none' },
    },
    empty: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    undefined: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'refused:open-failed', minted: [], claim: 'none' },
    },
    null: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'refused:open-failed', minted: [], claim: 'none' },
    },
    number: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    /* The family the third round missed: a non-string whose `.length` reads greater than zero. The
     * consult open hands each one to `create()` as it arrived, which is what HEAD did; the other three
     * doors refuse it before anything is minted. */
    'array-1': {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<Array:["x"]>'], claim: 'none' },
    },
    'array-2': {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<Array:["x","y"]>'], claim: 'none' },
    },
    /* The control: a length of zero is no name, so this one follows the session like `''` does. */
    'array-0': {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    'boxed-string': {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<String:"x">'], claim: 'none' },
    },
    'length-1': {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<Object:{"length":1}>'], claim: 'none' },
    },
    uint8: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<Uint8Array:{"0":120}>'], claim: 'none' },
    },
    /* The primitives: values that are there, are not names, and answer the same as `''` at the one
     * door with a fallback of its own. */
    nan: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    zero: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    false: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    true: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['session'], claim: 'none' },
    },
    whitespace: {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<string:   >'], claim: 'none' },
    },
    /* Three tail spellings of the real tree: each is a name for the same directory, so each door
     * answers exactly what it answers for `named-real`. */
    'named-trailing-slash': {
      dispatchCell: { answer: 'ok', minted: ['named'], claim: 'named' },
      advanceLine: { answer: 'ok', minted: ['named'], claim: 'named' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['named'], claim: 'none' },
    },
    'named-dot': {
      dispatchCell: { answer: 'ok', minted: ['named'], claim: 'named' },
      advanceLine: { answer: 'ok', minted: ['named'], claim: 'named' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['named'], claim: 'none' },
    },
    'named-parent': {
      dispatchCell: { answer: 'ok', minted: ['named'], claim: 'named' },
      advanceLine: { answer: 'ok', minted: ['named'], claim: 'named' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['named'], claim: 'none' },
    },
    /* A path that is there and is not a directory: the resolver's refusal, at the one door that opens
     * at whatever it was handed. */
    'named-missing': {
      dispatchCell: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      advanceLine: { answer: 'refused:dispatch-refused', minted: [], claim: 'none' },
      openNodeSession: { answer: 'refused:prompt-missing', minted: [], claim: 'none' },
      openConsultSession: { answer: 'ok', minted: ['<string:<other>>'], claim: 'none' },
    },
  }

  for (const [shape, handedOf] of Object.entries(SHAPES)) {
    for (const [door, callOf] of Object.entries(DOORS)) {
      /* One rig per cell: two record trees — the one the caller names and the one the session sits in
       * — plus a junction spelling of the first. A shared rig would let one cell's claim or session be
       * read as the next one's. */
      const named = await rigRecord()
      const own = await rigRecord()
      /* The launch prompt is planted in the **session's own** tree, and in that tree only. Without it
       * the opener's cells all answer `prompt-missing` for a reason that has nothing to do with
       * the root: neither tree could be opened in, so "used the root it was handed" and "fell back to
       * the session's own workspace" landed on the same string, and the whole column stayed green
       * under every mutation that drops the handed root. With it, the fallback is a different answer
       * (`ok`, one session minted in `own`) and the column bites — see the comment above the table.
       *
       * Not in `named`: a prompt there would make the named shapes answer `ok` instead of the
       * `prompt-missing` they gave before the seam, which would be this case rewriting the answers it
       * exists to keep. */
      mkdirSync(join(own, '.superworker', 'meta', 'launch', 'c-1', 'n-1'), { recursive: true })
      writeFileSync(join(own, '.superworker', 'meta', 'launch', 'c-1', 'n-1', 'prompt.txt'), `the prompt of ${shape}\n`)
      const alias = aliasOf(named)
      const agents = fakeAgents()
      const seen = []
      const fake = context({ sessionCwd: own, sandboxRoot: own, seen, services: { agents: agents.registry } })
      /**
       * Which of this cell's own trees a minted cwd is — or, for a value that is not a directory at
       * all, its type and content: that *is* the door's answer (it handed the value to `create()`).
       */
      const where = (value) => (value === named ? 'named' : value === alias ? 'alias' : value === own ? 'session'
        : typeof value === 'string' ? `<string:${value === '   ' ? value : '<other>'}>`
          : `<${Object.prototype.toString.call(value).slice(8, -1)}:${JSON.stringify(value)}>`)
      try {
        const outcome = await callOf(handedOf({ named, alias }))(fake.ctx)
        const answered = {
          answer: outcome.ok ? 'ok' : `refused:${outcome.code}`,
          minted: agents.created.map((record) => where(record.options.meta.cwd)),
          claim: existsSync(claimPath(named, 'c-1', 'n-1')) ? 'named' : existsSync(claimPath(own, 'c-1', 'n-1')) ? 'session' : 'none',
        }
        assert.deepEqual(answered, EXPECTED[shape][door], `${shape} at ${door}: the door answered something else than it did before the seam`)
      } finally {
        rmSync(alias, { recursive: true, force: true })
        rmSync(named, { recursive: true, force: true })
        rmSync(own, { recursive: true, force: true })
      }
    }
  }
})

/**
 * The relay's `named` field, read on its own: the caller names a real directory that holds no record.
 *
 * The one thing the dispatch relay must do with the root it was handed is **use it**. Before this
 * case, that was pinned only sideways, by the empty-string cell of "An unnamed call at the handing
 * doors" — and a review that dropped the `named` field from `dispatchCell`'s seam question found that
 * the cell which caught it was that one, while the reading this case now takes (a directory that is
 * real, is not the session's own, and holds nothing this line can dispatch) had no case at all.
 *
 * A door that widened the missing name into "the calling session's workspace" would answer `ok` and
 * open a session on the session's tree; a door that kept it refuses and lands no claim. Both halves
 * are asserted, because the claim is the half that outlives the call: a session opened on a tree
 * nobody named leaves a record behind.
 */
test('The relay uses the root the caller named: a real directory with no record is refused, and no claim lands', async () => {
  const record = await rigRecord()
  /* A real directory, not a missing path: the point is that the branch a widened name would take —
   * "open at the session's workspace" — is available and works, so only a door that uses the named
   * root refuses. The calling session sits here. */
  const bare = mkdtempSync(join(tmpdir(), 'superworker-parity-named-bare-'))
  const agents = fakeAgents()
  const fake = context({ sessionCwd: bare, sandboxRoot: bare, services: { agents: agents.registry } })
  try {
    const dispatched = await dispatchCell(fake.ctx, SESSION, bare, 'c-1', 'n-1')
    assert.equal(dispatched.ok, false, 'a dispatch naming a directory with no record must be refused')
    assert.equal(dispatched.code, 'dispatch-refused', dispatched.detail)
    assert.equal(agents.created.length, 0, 'a dispatch naming a directory with no record opened a session')
    assert.ok(!existsSync(claimPath(bare, 'c-1', 'n-1')), 'a dispatch naming a directory with no record landed a claim on it')
    assert.ok(!existsSync(claimPath(record, 'c-1', 'n-1')), 'the refused dispatch landed a claim on some other tree')

    /* The control: the same call at the record tree really does open and really does land a claim, so
     * the cell above is a refusal about the root and not a cell that can never work. */
    const real = await dispatchCell(fake.ctx, SESSION, record, 'c-1', 'n-1')
    assert.equal(real.ok, true, JSON.stringify(real))
    assert.ok(existsSync(claimPath(record, 'c-1', 'n-1')), 'the control dispatch did not land its claim, so the cell above proves nothing')
  } finally {
    rmSync(record, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

/**
 * The panel endpoints narrow their root argument once, at the boundary: a string passes, a value
 * that is not there at all keeps the unnamed fallback, and everything else is refused with the
 * boundary's one code before any read is performed.
 *
 * This is the case that used to pin the other reading — a non-string was *not a name* here, and
 * the session's own root answered it — which is exactly the silent fallback the boundary node was
 * ruled to close: a `['x']` payload read the calling session's workspace without a peep. So the
 * table now asks each non-string shape at the four endpoints and each must answer the one code
 * (`root-not-string`), each by its own channel: the reads throw, and the code rides on the error —
 * the same channel a real read failure rides. The controls make the table a reading of the
 * criterion and not of a door that refuses everything: a real named root still wins, a junction
 * spelling of it is handed out in the spelling it arrived in, `'   '` is still a non-empty string
 * and a name like any other, and `''`, `null` and `undefined` — the values that are empty or not
 * there at all — keep the unnamed fallback they have always answered.
 */
test('The panel endpoints narrow their root argument: a non-string is refused with the boundary\'s code, an absent one still follows the session', async () => {
  const session = await rigRecord()
  const namedRoot = await rigRecord()
  /** The shapes that are neither a string nor absent: every non-string the wire can carry. */
  const NOT_A_STRING = {
    'array-1': () => ['x'],
    'array-2': () => ['x', 'y'],
    'array-0': () => [],
    'boxed-string': () => new String('x'),
    'length-1': () => ({ length: 1 }),
    uint8: () => new Uint8Array([120]),
    number: () => 42,
    false: () => false,
    true: () => true,
  }
  /** The shapes that are empty or not there at all: the unnamed fallback keeps them. */
  const NOT_THERE = {
    empty: () => '',
    null: () => null,
    undefined: () => undefined,
  }
  /** The code one endpoint call answers with: the refusal's own, or a mark that it answered instead of refusing. */
  const answeredCode = async (asking) => {
    try {
      await asking()
    } catch (error) {
      return error.code
    }
    return '<the endpoint answered instead of refusing>'
  }
  /** The four endpoints' refusal codes for one root argument, each by its own channel. */
  const askCodes = async (handed) => {
    const fake = context({ sessionCwd: session, sandboxRoot: session })
    const gateway = new SuperworkerRecordsGateway(fake.ctx)
    return {
      read: await answeredCode(() => gateway.read(SESSION, handed)),
      watch: await answeredCode(async () => {
        for await (const frame of gateway.watch(SESSION, handed, new AbortController().signal)) return frame.workspaceRoot
        return '<the stream ended without a frame>'
      }),
      readConfig: await answeredCode(() => gateway.readConfig(SESSION, handed)),
      readSessions: await answeredCode(() => gateway.readSessions(SESSION, handed)),
    }
  }
  /** The four endpoints' resolved roots for one root argument — the cells that must answer, not refuse. */
  const askRoots = async (handed) => {
    const fake = context({ sessionCwd: session, sandboxRoot: session })
    const gateway = new SuperworkerRecordsGateway(fake.ctx)
    const watched = await (async () => {
      for await (const frame of gateway.watch(SESSION, handed, new AbortController().signal)) return frame.workspaceRoot
      return '<the stream ended without a frame>'
    })()
    return {
      read: (await gateway.read(SESSION, handed)).workspaceRoot,
      watch: watched,
      readConfig: (await gateway.readConfig(SESSION, handed)).workspaceRoot,
      readSessions: (await gateway.readSessions(SESSION, handed)).workspaceRoot,
    }
  }
  try {
    for (const [shape, handedOf] of Object.entries(NOT_A_STRING)) {
      const answered = await askCodes(handedOf())
      assert.deepEqual(
        answered,
        { read: 'root-not-string', watch: 'root-not-string', readConfig: 'root-not-string', readSessions: 'root-not-string' },
        `${shape} at the panel endpoints: a root that is neither a string nor absent must be refused with the boundary's one code`,
      )
    }

    /* The values that are empty or not there at all keep the answer they have always given: the
     * unnamed fallback, this session's own root — `''` spelled the panel's way, `null` and
     * `undefined` the wire's. */
    for (const [shape, handedOf] of Object.entries(NOT_THERE)) {
      const fake = context({ sessionCwd: session, sandboxRoot: session })
      const gateway = new SuperworkerRecordsGateway(fake.ctx)
      const reading = await gateway.read(SESSION, handedOf())
      assert.equal(reading.workspaceRoot, session, `${shape}: the unnamed fallback must still answer this session's own root`)
    }

    /* The control that makes the refusals above a reading of the criterion: a real named root wins
     * at all four endpoints, so "refused" above is about the value and not about the door. */
    const named = await askRoots(namedRoot)
    assert.deepEqual(
      named,
      { read: namedRoot, watch: namedRoot, readConfig: namedRoot, readSessions: namedRoot },
      'a real named root did not win at the panel endpoints, so the refusal cells above prove nothing',
    )

    /* The other control: a name this door accepts is handed out in the spelling it arrived in. A
     * second spelling of the named tree (a junction) is a name like any other, and an endpoint that
     * canonicalised it would answer the tree behind it. Also `'   '`: a non-empty string that is
     * not a directory is still a name here (only the resolver refuses those, and these endpoints
     * never call it), so its spelling comes back untouched too. */
    const alias = aliasOf(namedRoot)
    try {
      const spelled = await askRoots(alias)
      assert.deepEqual(
        spelled,
        { read: alias, watch: alias, readConfig: alias, readSessions: alias },
        'the panel endpoints must hand out the spelling the caller used, never the canonical one',
      )
      assert.notEqual(alias, realpathSync(namedRoot), 'this reading needs the two spellings to differ')
    } finally {
      rmSync(alias, { recursive: true, force: true })
    }
    const whitespace = await askRoots('   ')
    assert.deepEqual(
      whitespace,
      { read: '   ', watch: '   ', readConfig: '   ', readSessions: '   ' },
      'a non-empty string that is not a directory is still a name at the endpoints, and its spelling is what they hand out',
    )
  } finally {
    rmSync(session, { recursive: true, force: true })
    rmSync(namedRoot, { recursive: true, force: true })
  }
})
