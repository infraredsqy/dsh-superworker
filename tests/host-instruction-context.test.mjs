/* The injection point (L2): the standing constraints in force in a session's workspace, carried
 * into that session's runtime context.
 *
 * What this file pins is the contract, not the drawing:
 *   - the words are the plugin's own — the carried text is byte for byte the reader view
 *     `instruction list` answers at that root, so the two cannot drift apart by a re-spelling;
 *   - four silences carry nothing at all: no record, a record with no reachable entry, a record
 *     whose entries are all archived, and a word that is not installed here;
 *   - the contribution goes through the host's prompt service under its own name and an order
 *     among the workspace facts, and a host without that service simply has no contribution;
 *   - a session whose working directory is a linked worktree carries the main tree's reading: the
 *     record-presence gate and the word resolve the same project root, so the worktree sessions —
 *     the ones a standing constraint exists for — do not get an empty snapshot;
 *   - the switch is read per assembly: off means not one byte — whether it arrives as a plain
 *     boolean or as the volatile reference the real host hands over — and the provider a request
 *     admission re-reads holds exactly what the step's assembly was given.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, open } from 'superworker-core'
import {
  ASSEMBLE_EVENT,
  INSTRUCTION_CONTEXT_NAME,
  INSTRUCTION_CONTEXT_ORDER,
  installInstructionContext,
  instructionContextTextOf,
  instructionListArgv,
  instructionTextViewOf,
  withInstructionText,
} from '../src/host/instruction-context.ts'
import { PANEL_PREF_FIELDS } from '../src/host/settings-fields.ts'
import { shippedPluginsDir } from '../src/host/skill-paths.ts'
import { fakeContext } from './helpers/host-context.mjs'
import { project as throwaway } from './helpers/superworker-project.mjs'

/** The seams one word line answers through, as the production path builds them. */
const ioAt = (root) => ({ root, pluginsDir: shippedPluginsDir() })

/** What the plugin itself prints for its default read at one root: no flag at all. */
async function readerView(root) {
  const said = await answer(['instruction', 'list'], ioAt(root))
  assert.equal(said.code, 0, said.stderr)
  return said.stdout
}

/** One entry added through the plugin's own verb, so the record is written the way a person writes it. */
async function say(stage, text) {
  const said = await answer(['instruction', 'add', '--scope', 'global', '--text', text], ioAt(stage.root))
  assert.equal(said.code, 0, said.stderr)
}

/** The ids on the account, through the word's machine read. */
async function idsOn(stage) {
  const said = await answer(['instruction', 'list', '--json', '--project', stage.root], ioAt(stage.root))
  assert.equal(said.code, 0, said.stderr)
  return JSON.parse(said.stdout).map((row) => row.id)
}

/**
 * One git line in a directory, the conventions of the engine's own fixture runner: `cwd` always
 * given, a fixed identity through the environment, a non-zero exit throws (an unbuildable fixture
 * would make the case below assert about the wrong thing).
 */
function gitIn(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'superworker test',
          GIT_AUTHOR_EMAIL: 'superworker-test@example.invalid',
          GIT_COMMITTER_NAME: 'superworker test',
          GIT_COMMITTER_EMAIL: 'superworker-test@example.invalid',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout)
        else reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || error.message}`))
      },
    )
  })
}

/**
 * A host carrying a prompt service whose registrations are collected, plus the waterfall runner a
 * case drives: one listener, whose `next` hands the same assembly back.
 *
 * The context is the shared stand-in with an `on` of this file's own, so the waterfall's return
 * value is visible — the stand-in's bus answers listeners but discards what they return.
 */
function contextWithPrompt(root) {
  const registered = []
  const listeners = []
  const fake = fakeContext({ root, services: { systemPrompt: { context: (contribution) => (registered.push(contribution), () => undefined) } } })
  const ctx = { ...fake.ctx, on: (name, listener) => (listeners.push({ name, listener }), () => undefined) }
  const assemble = async (assembly, agent = { id: 's1' }) => {
    const listener = listeners.find((entry) => entry.name === ASSEMBLE_EVENT)?.listener
    assert.ok(listener !== undefined, 'no assembly listener was installed')
    return listener(assembly, { agent }, () => Promise.resolve(assembly))
  }
  return { ctx, registered, listeners, assemble }
}

/** The assembly a step is given: this module's contribution in place, empty until it is filled. */
const freshAssembly = () => ({
  sections: [],
  contexts: [{ name: INSTRUCTION_CONTEXT_NAME, text: '' }],
  tools: [],
  variables: {},
})

test('the carried text is the word\'s own reader view, byte for byte', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  try {
    await say(stage, 'keep one entry per sentence')
    await say(stage, 'read the record before writing a conclusion')

    const printed = await readerView(stage.root)
    const carried = await instructionContextTextOf(stage.root)

    assert.equal(carried, printed.replace(/\n+$/u, ''), 'the context carries the listing verbatim (the joiner supplies its own line ends)')
    assert.match(carried, /^This project has 2 instruction\(s\) visible from this step:$/mu)
    assert.ok(carried.includes('keep one entry per sentence'), 'the sentence rides as it was written')
    assert.ok(carried.includes('read the record before writing a conclusion'))
    assert.match(carried, /visibility: global \(counts anywhere\)$/mu, 'the scope word is the plugin\'s own')
  } finally {
    stage.done()
  }
})

test('one entry changed: the next read is the new text, not the old one', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  try {
    await say(stage, 'first constraint')
    const before = await instructionContextTextOf(stage.root)
    assert.ok(before.includes('first constraint'))

    const [first] = await idsOn(stage)
    await answer(['instruction', 'resolve', first, '--state', 'withdrawn'], ioAt(stage.root))
    await say(stage, 'second constraint')
    const after = await instructionContextTextOf(stage.root)

    assert.notEqual(after, before, 'a change on the account is a change in the text')
    assert.ok(after.includes('second constraint'))
    assert.ok(!after.includes('first constraint'), 'the archived sentence is gone from the listing')
    /* The archived-only case lives in the next case; here the point is that a change lands. */
  } finally {
    stage.done()
  }
})

test('no record at all: nothing is carried — not the reader view\'s own empty-state sentences', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'superworker-instruction-bare-'))
  try {
    assert.equal(await instructionContextTextOf(bare), '')
    /* The word does answer, with a sentence about the absence: that sentence is not a constraint. */
    const said = await answer(instructionListArgv(bare), ioAt(bare))
    assert.equal(said.code, 0, said.stderr)
    assert.match(said.stdout, /no instruction record at all/u)
    assert.equal(instructionTextViewOf(said), '')
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a record whose entries are all archived, or none of which reach this step: nothing is carried either', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  try {
    await say(stage, 'a sentence that will be archived')
    const [only] = await idsOn(stage)
    await answer(['instruction', 'resolve', only, '--state', 'withdrawn'], ioAt(stage.root))

    assert.equal(await instructionContextTextOf(stage.root), '')
    const said = await answer(instructionListArgv(stage.root), ioAt(stage.root))
    assert.equal(said.code, 0, said.stderr)
    assert.match(said.stdout, /No instruction is visible from this step/u)
    assert.equal(instructionTextViewOf(said), '', 'the empty-state answer is not carried')
  } finally {
    stage.done()
  }
})

test('the plugin moved away: the word refuses and not one byte is carried, with no throw', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  const emptyPlugins = mkdtempSync(join(tmpdir(), 'superworker-no-plugins-'))
  try {
    await say(stage, 'a constraint that nobody can read once the plugin is gone')
    const io = { root: stage.root, pluginsDir: emptyPlugins }
    const said = await answer(instructionListArgv(stage.root), io)
    assert.notEqual(said.code, 0, 'with no plugin installed the word is not answered')
    assert.equal(instructionTextViewOf(said), '', 'a refusal carries nothing')
  } finally {
    stage.done()
    rmSync(emptyPlugins, { recursive: true, force: true })
  }
})

test('the contribution: its own name, an order among the workspace facts, and the provider a request admission re-reads', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  try {
    await say(stage, 'carried into the step')
    const { ctx, registered, assemble } = contextWithPrompt(stage.root)
    const off = installInstructionContext(ctx, {})
    try {
      assert.equal(registered.length, 1)
      const contribution = registered[0]
      assert.equal(contribution.name, INSTRUCTION_CONTEXT_NAME)
      assert.equal(contribution.order, INSTRUCTION_CONTEXT_ORDER)
      assert.ok(
        contribution.order > 100 && contribution.order < 200,
        'the contribution sits with the workspace facts: after the working directory, before the deployment surfaces',
      )

      /* The first step of a session has nothing cached: the assembly listener is what fills it. */
      assert.equal(contribution.text({ agent: { id: 's1' } }), '')

      const patched = await assemble(freshAssembly())
      const expected = (await readerView(stage.root)).replace(/\n+$/u, '')
      assert.equal(patched.contexts[0].text, expected, 'the step carries the text computed for it')
      assert.equal(patched.contexts[0].name, INSTRUCTION_CONTEXT_NAME)

      /* Request admission re-reads the provider (DSH's `refreshContext`): it must hand back exactly
       * what the assembly was given, or the request would carry a different snapshot. */
      assert.equal(contribution.text({ agent: { id: 's1' } }), expected)
    } finally {
      off()
    }
  } finally {
    stage.done()
  }
})

test('the switch: off means not one byte, on the assembly and on the provider alike', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  try {
    await say(stage, 'a constraint the switch can silence')
    const { ctx, registered, assemble } = contextWithPrompt(stage.root)
    const off = installInstructionContext(ctx, { [PANEL_PREF_FIELDS.injectInstructions]: false })
    try {
      const patched = await assemble(freshAssembly())
      assert.equal(patched.contexts[0].text, '', 'the switch off contributes nothing')
      assert.equal(registered[0].text({ agent: { id: 's1' } }), '', 'and the provider says the same, so admission carries nothing either')
    } finally {
      off()
    }
  } finally {
    stage.done()
  }
})

test('the switch in the shape the real host hands it: a volatile reference, read at the assembly', async () => {
  const stage = await throwaway('superworker-instruction-context-')
  try {
    await say(stage, 'a constraint a reference-shaped switch can silence')
    /* A volatile settings field is not a plain value: the resolved config carries it as a stable
     * reference whose `get()` answers the current snapshot — the shape pinned for the relay switch in
     * `tests/host-relay.test.mjs`. Only a plain boolean was fed here before, so a reference read as
     * "not false" stayed on for every session whose switch the user had turned off. */
    for (const snapshot of [false, true]) {
      const { ctx, registered, assemble } = contextWithPrompt(stage.root)
      const off = installInstructionContext(ctx, {
        [PANEL_PREF_FIELDS.injectInstructions]: { get: () => snapshot },
      })
      try {
        const patched = await assemble(freshAssembly())
        if (snapshot) {
          const expected = (await readerView(stage.root)).replace(/\n+$/u, '')
          assert.equal(patched.contexts[0].text, expected, 'a reference answering true carries the listing as before')
          assert.equal(registered[0].text({ agent: { id: 's1' } }), expected, 'and admission re-reads the same text')
        } else {
          assert.equal(patched.contexts[0].text, '', 'a reference answering false contributes nothing')
          assert.equal(registered[0].text({ agent: { id: 's1' } }), '', 'and admission carries nothing either')
        }
      } finally {
        off()
      }
    }
  } finally {
    stage.done()
  }
})

test('a workspace with no record directory carries nothing through a whole assembly either', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'superworker-instruction-bare-'))
  try {
    const { ctx, registered, assemble } = contextWithPrompt(bare)
    const off = installInstructionContext(ctx, {})
    try {
      const patched = await assemble(freshAssembly())
      assert.equal(patched.contexts[0].text, '', 'no record directory, no byte in the step')
      assert.equal(registered[0].text({ agent: { id: 's1' } }), '')
    } finally {
      off()
    }
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a session working in a linked worktree carries its main tree\'s listing, not nothing', async () => {
  /* `fork` mode runs a node's work sessions in their own worktrees, and such a checkout carries the
   * record only as of the fork — the account stays in the main tree. The worktree here is made by git
   * itself, so the `.git` pointer the resolution reads is the one git really writes. */
  const main = mkdtempSync(join(tmpdir(), 'superworker-instruction-main-'))
  const holder = mkdtempSync(join(tmpdir(), 'superworker-instruction-wt-'))
  const worktree = join(holder, 'tree')
  try {
    await gitIn(main, 'init', '-b', 'main')
    await gitIn(main, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(main, 'seed.md'), '# seed\n', 'utf8')
    await gitIn(main, 'add', '-A')
    await gitIn(main, 'commit', '-m', 'seed', '--no-gpg-sign')
    await gitIn(main, 'worktree', 'add', worktree, '-b', 'side')

    await open(main).ledger.init()
    await say({ root: main }, 'a constraint that has to reach the worktree session')

    /* The two facts the old gate read at the raw session root: no record under it, and a checkout
     * this is. Looked for there, the gate emptied every worktree session. */
    assert.equal(existsSync(join(worktree, '.superworker')), false, 'the checkout carries no record of its own')
    assert.equal(statSync(join(worktree, '.git')).isFile(), true, 'git made this a linked worktree')

    const { ctx, registered, assemble } = contextWithPrompt(worktree)
    const off = installInstructionContext(ctx, {})
    try {
      const patched = await assemble(freshAssembly())
      const expected = (await readerView(main)).replace(/\n+$/u, '')
      assert.ok(expected.includes('has to reach the worktree session'), 'the main tree really answers this sentence')
      assert.equal(patched.contexts[0].text, expected, 'the worktree session carries the main tree\'s default read, byte for byte')
      assert.equal(registered[0].text({ agent: { id: 's1' } }), expected, 'and admission re-reads the same text')
    } finally {
      off()
    }
  } finally {
    rmSync(holder, { recursive: true, force: true })
    rmSync(main, { recursive: true, force: true })
  }
})

test('a host with no prompt service: no registration, no listener, no throw', () => {
  const stage = mkdtempSync(join(tmpdir(), 'superworker-instruction-noprompt-'))
  try {
    const fake = fakeContext({ root: stage, bus: true })
    const off = installInstructionContext(fake.ctx, {})
    assert.equal(typeof off, 'function', 'the installer always answers a disposer')
    assert.deepEqual(fake.events.listenersOf(ASSEMBLE_EVENT), [], 'nothing is listened to when there is nothing to contribute to')
    off()
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})

test('patching an assembly leaves an absent contribution absent: the host\'s own suppression is respected', () => {
  const foreign = { sections: [], contexts: [{ name: 'working-directory:current', text: 'here' }], tools: [], variables: {} }
  assert.equal(withInstructionText(foreign, 'anything'), foreign, 'an assembly without this contribution is handed back untouched')

  const ours = { sections: [], contexts: [{ name: INSTRUCTION_CONTEXT_NAME, text: 'old' }, { name: 'other', text: 'x' }], tools: [], variables: {} }
  const patched = withInstructionText(ours, 'new')
  assert.equal(patched.contexts[0].text, 'new')
  assert.equal(patched.contexts[1].text, 'x', 'neighbours are untouched')
  assert.equal(ours.contexts[0].text, 'old', 'the assembly is not mutated in place')
  assert.equal(withInstructionText(ours, '').contexts.length, 2, 'an empty text stays in place and renders to nothing')
})

test('the injected line is the plugin\'s default read at that root — one word, one position rule', () => {
  assert.deepEqual(instructionListArgv('C:\\ws'), ['instruction', 'list', '--project', 'C:\\ws'])
})