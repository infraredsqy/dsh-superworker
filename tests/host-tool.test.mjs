/* The agent-facing `superworker` tool and its wake: the tool exists for the agents whose
 * workspace holds a `.superworker/` record (or a recognizable record directory under the
 * old name, which is what keeps `migrate` reachable), and for those whose session loads a
 * pipeline skill — by the `skill` tool's call result or by a user `/sw-*` invocation —
 * never for anyone else, and only once per agent.
 *
 * - **never resident**: an unrelated agent's scope stays without the tool; a settled call of a
 *   tool that is not `skill`, a failed skill load, a `/some-skill` invocation, and a
 *   workspace with no `.superworker/` all leave the scope unarmed.
 * - **wakes once**: every trigger hits the same wake; a second skill load, and a second
 *   step in a record's workspace, register nothing more.
 * - the description the tool registers with stays at or under 400 bytes;
 * - the name lock: the registered name, the README and every markdown page the skills
 *   ship under a `skills/` tree come from one constant — the whole tree is walked, not
 *   just `SKILL.md`, and every `SKILL.md` has to name the tool at least once (without
 *   that leg a walk over a corpus that never names it would pass vacuously). A mention is
 *   the bare word: a `superworker` that is a segment of a path (the manifest directory) is
 *   a different constant and is not counted.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_DIR_NAME, isRecognizableLegacyRecord } from 'superworker-core'
import { apply } from '../src/host/index.ts'
import { executorOf } from '../src/host/executor.ts'
import {
  TOOL_NAME,
  SKILL_NAME_PREFIX,
  argvOf,
  toolDescriptionOf,
} from '../src/host/tool.ts'
import { hasPipelineRecord, installToolWake, wakeAgent } from '../src/host/wake.ts'
import { pinHome } from './helpers/env.mjs'
import { fakeContext } from './helpers/host-context.mjs'

/**
 * The host face a wake reads: the context, and the opener seam a word that opens a session travels
 * through. Production hands the same pair (`index.ts` passes the tracked seam the relay uses).
 */
function toolHost(ctx) {
  return { ctx, executorOf: (sessionId, root) => executorOf(ctx, sessionId, root) }
}

/* Loading this line places the shipped skills into the DSH skill root; the root these
 * cases would write into is pinned to a temp home here, never the machine's own. */
const pinned = pinHome(['DSH_HOME'], 'superworker-tool-home-')
test.after(pinned.restore)

const repo = fileURLToPath(new URL('..', import.meta.url))

/**
 * A stand-in host context: the services by name, an event bus, and the effects it collected.
 * `options.cwd` is the live session's workspace root the fact trigger reads; omitting it
 * stands in for a session with no cwd at all (the sandbox root answers then).
 */
const context = (options = {}) => fakeContext({
  sessionCwd: options.cwd,
  sandboxRoot: 'C:\\tool-root',
  bus: true,
  provide: true,
  effect: true,
})

/** An agent with a scoped context whose tools registry records what lands in it. */
function fakeAgent(id = 'agent-1') {
  const registered = []
  const agent = {
    id,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {
            const at = registered.indexOf(definition)
            if (at >= 0) registered.splice(at, 1)
          }
        },
      },
      effect: (make) => {
        make()
      },
    },
  }
  return { agent, registered }
}

/** Settle one tool call through every `tools/post-execute` listener the context holds. */
async function firePostExecute(events, exec, result) {
  for (const listener of events.listenersOf('tools/post-execute')) {
    await listener(exec, result, async () => ({ kind: 'accept' }))
  }
}

/** Propose one step through every `agent/pre-step` listener the context holds. */
async function firePreStep(events, payload, messages) {
  for (const listener of events.listenersOf('agent/pre-step')) {
    await listener(payload, async () => ({ kind: 'enter', messages }))
  }
}

test('Never resident: a call to an unrelated tool, a failed skill load, another skill name, none wakes', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePostExecute(events, { name: 'bash', agent }, { isError: false })
  await firePostExecute(events, { name: 'skill', agent }, { isError: true })
  await firePreStep(
    events,
    { agent },
    [{ source: { kind: 'skill-invocation', name: 'some-skill' } }],
  )
  assert.equal(registered.length, 0, 'no trigger line armed this agent')
})

test('Wakes once: the skill tool loads a skill, and the next round this agent\'s scope has one superworker, no more', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  assert.equal(registered.length, 1, 'registered once')
  assert.equal(registered[0].name, TOOL_NAME)

  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  await firePreStep(events, { agent }, [{ source: { kind: 'skill-invocation', name: 'sw-route' } }])
  assert.equal(registered.length, 1, 'one copy per agent')
})

test('Wakes once: a user typing /sw-route goes through the same wake, the two lines do not register each their own', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePreStep(events, { agent }, [
    { source: { kind: 'skill-invocation', name: 'sw-route' } },
    { source: { kind: 'skill-invocation', name: 'sw-conduct' } },
  ])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, TOOL_NAME)
})

test('Fact wake: the workspace has .superworker, so the first step request carries the tool, no skill needed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  mkdirSync(join(root, '.superworker'), { recursive: true })
  try {
    const { ctx, events } = context({ cwd: root })
    apply(ctx)
    const { agent, registered } = fakeAgent()

    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'the workspace has a record, armed on the first step')
    assert.equal(registered[0].name, TOOL_NAME)

    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'one copy per agent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Fact wake: no .superworker in the workspace, no arming; once the record appears, the next step arms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  try {
    const { ctx, events } = context({ cwd: root })
    apply(ctx)
    const { agent, registered } = fakeAgent()

    assert.equal(hasPipelineRecord(root), false)
    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 0, 'an unrelated workspace gets not one byte more')

    mkdirSync(join(root, '.superworker'), { recursive: true })
    assert.equal(hasPipelineRecord(root), true)
    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'once the record appears, the next step arms')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Fact wake: only the old record directory, and only when the engine recognizes it — an unmigrated workspace still arms, a same-named stranger does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  /* The old directory counts only when `init` laid it down — the same two marks every record
   * directory carries — because that recognition is what makes `migrate` and `doctor` reachable
   * in a workspace that has not moved yet: the tool is the only road to them. The control line
   * ties the fixture to the engine's own recognition reading, so the day a third mark lands
   * this case fails loudly here instead of arming on somebody else's directory. */
  mkdirSync(join(root, LEGACY_DIR_NAME), { recursive: true })
  try {
    const { ctx, events } = context({ cwd: root })
    apply(ctx)
    const { agent, registered } = fakeAgent()

    assert.equal(hasPipelineRecord(root), false, 'an unrecognized old directory is somebody else\'s: it counts as nothing')
    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 0, 'no recognizable record, no arming')

    writeFileSync(join(root, LEGACY_DIR_NAME, '.gitignore'), '', 'utf8')
    writeFileSync(join(root, LEGACY_DIR_NAME, '.gitattributes'), '', 'utf8')
    assert.ok(isRecognizableLegacyRecord(root), 'the fixture is now one the engine recognizes')
    assert.equal(hasPipelineRecord(root), true, 'the old directory alone is a fact that arms')
    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'an unmigrated workspace gets the tool, so it reaches migrate')
    assert.equal(registered[0].name, TOOL_NAME)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('The tool\'s shape: name, description bytes, parameters and output are all the declared surface', () => {
  const { ctx } = context()
  const { agent, registered } = fakeAgent()
  wakeAgent(agent, toolHost(ctx))

  const tool = registered[0]
  assert.equal(tool.name, TOOL_NAME)
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), ['word', 'args', 'help'])
  assert.deepEqual(tool.parameters.required, undefined, 'no required parameters: word names are not enumerated')
  assert.deepEqual(Object.keys(tool.output.schema.properties ?? {}), ['code', 'stdout', 'stderr'])
})

test('The tool\'s four layers of help: argv is composed from word / args / help, help adds to args, the words layer answers itself', async () => {
  // Asked empty-handed, it answers the whole index; help lands on the same word as no word at all.
  assert.deepEqual(argvOf({}), ['help'])
  assert.deepEqual(argvOf({ help: true }), ['help'])
  // A word without help: run it.
  assert.deepEqual(argvOf({ word: 'next' }), ['next'])
  // Word + help: that word's own page.
  assert.deepEqual(argvOf({ help: true, word: 'next' }), ['next', '--help'])
  // Word + args + help: this call's own page — args ride along, not dropped.
  assert.deepEqual(argvOf({ help: true, word: 'dag', args: ['list'] }), ['dag', 'list', '--help'])
  // args already end with --help: keep the caller's spelling, append no second one.
  assert.deepEqual(argvOf({ help: true, word: 'issue', args: ['status', '--help'] }), ['issue', 'status', '--help'])
  // --help not at the end: leave it in place and add one at the end — the words layer reads only the trailing
  // one as a help ask, and the middle one does not count when finding the group's verb.
  assert.deepEqual(argvOf({ help: true, word: 'dag', args: ['--help', 'list'] }), ['dag', '--help', 'list', '--help'])
  // No help: word + args is running this call.
  assert.deepEqual(argvOf({ word: 'dag', args: ['list'] }), ['dag', 'list'])

  const { ctx } = context()
  const { agent, registered } = fakeAgent()
  wakeAgent(agent, toolHost(ctx))
  const answer = await registered[0].execute({ help: true }, { agent })
  assert.equal(answer.code, 0, answer.stderr)
  assert.match(answer.stdout, /superworker -- the agent pipeline/u, 'asked empty-handed, it answers the whole index')
})

test('Name lock: the registered name and the README spelling come from one constant; the skill bodies spell it the same, and every SKILL.md names it', () => {
  assert.equal(TOOL_NAME, 'superworker')
  assert.equal(SKILL_NAME_PREFIX, 'sw-')
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(repo, file), 'utf8')
    assert.match(text, /`superworker`/u, `${file} spells the tool the way the registry does`)
  }
  // The skills live under the shipped plugins. Walk *every* markdown page in their
  // `skills/` trees — the pools and the reference pages quote command lines too — and
  // wherever one names the tool it names the registered spelling. A page that never
  // names it is not this lock's business; a `SKILL.md` that never names it is, because
  // otherwise the spelling scan passes without ever reading a spelling this phase wrote.
  const pluginsRoot = join(repo, 'packages', 'superworker-core', 'plugins')
  const files = []
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) collect(full)
      else if (entry.name.endsWith('.md')) files.push(full)
    }
  }
  const walkSkills = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'skills') collect(full)
      else walkSkills(full)
    }
  }
  walkSkills(pluginsRoot)
  assert.ok(files.length >= 60, `every shipped skill body is walked (walked ${files.length} files, at least 60)`)
  // The tool is a word, not a directory: `MANIFEST_DIR` in `src/host/skill-paths.ts` happens
  // to spell `superworker` too, and a tool rename must not force the doc path to move. Keep
  // only path-free tokens — not preceded by a slash or a backslash, not followed by a
  // slash — so `<dshHome>/superworker/skills.json` is a path, not a spelling of the tool.
  const TOOL_MENTION = /(?<![/\\])superworker[A-Za-z]*(?!\/)/gu
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const mentions = text.match(TOOL_MENTION) ?? []
    for (const spelling of mentions) {
      assert.equal(spelling, TOOL_NAME, `${file}: ${spelling} is not the registered spelling`)
    }
    if (file.endsWith('SKILL.md')) {
      const named = mentions.filter((spelling) => spelling === TOOL_NAME)
      assert.ok(named.length >= 1, `${file}: names no ${TOOL_NAME}, so the name lock spins on nothing`)
    }
  }
})

test('Unloading: the line\'s effect takes both trigger lines back; the agent\'s effect takes the tool back', async () => {
  const { ctx, events, effects } = context()
  apply(ctx)
  assert.equal(events.listenersOf('tools/post-execute').length, 1)
  assert.equal(events.listenersOf('agent/pre-step').length, 1)

  const { agent, registered } = fakeAgent()
  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  assert.equal(registered.length, 1)

  // The line's own effects: the wake's disposer is collected there, so an unload
  // takes both triggers back. (The skills placement's effect settles later and is not
  // this test's business.)
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  assert.equal(events.listenersOf('tools/post-execute').length, 0, 'the post-execute line is gone')
  assert.equal(events.listenersOf('agent/pre-step').length, 0, 'the pre-step line is gone')

  // The agent's own effect: the registration disposer is collected there.
  const { ctx: ctx2, events: events2 } = context()
  installToolWake(toolHost(ctx2))
  const holder = []
  const agent2 = {
    id: 'agent-2',
    ctx: {
      tools: {
        register(definition) {
          holder.push(definition)
          return () => {
            const at = holder.indexOf(definition)
            if (at >= 0) holder.splice(at, 1)
          }
        },
      },
      effect: (make) => {
        agent2.dispose = make()
      },
    },
  }
  await firePostExecute(events2, { name: 'skill', agent: agent2 }, { isError: false })
  assert.equal(holder.length, 1)
  agent2.dispose()
  assert.equal(holder.length, 0, 'the agent is gone, the tool goes with it')
})

