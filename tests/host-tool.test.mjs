/* The agent-facing `superworker` tool and its wake: one registration per agent, and one condition
 * the registry asks on every step. The condition is the fact this line has always read — the
 * workspace holds a `.superworker/` record, or a recognizable record directory under the old name
 * (which is what keeps `migrate` reachable) — plus the two triggers that speak for an agent: a
 * successful load through the `skill` tool, and a user's `/sw-*` invocation in a step proposal.
 *
 * - **never declared**: an unrelated tool's settled call, a failed skill load, and a `/some-skill`
 *   invocation arm nothing; the step still registers the tool (registration is not the trigger) and
 *   the condition keeps it out of that step's request.
 * - **registers once**: every road to one agent lands on the same registration; a second skill load
 *   and a second step add nothing.
 * - **asked every step**: a record that appears mid-session is carried by the very next step, and a
 *   session that walks out of the workspace stops carrying it — the registration-time reading used
 *   to stick at whichever answer came first.
 * - **total**: a reading that throws answers "no" instead of failing the step (`ToolActivationError`
 *   would take the whole step preparation down), and a registry that cannot gate is never handed a
 *   tool every agent would see.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_DIR_NAME, isRecognizableLegacyRecord } from 'superworker-core'
import { apply } from '../src/host/index.ts'
import { executorOf } from '../src/host/executor.ts'
import { TOOL_NAME, argvOf } from '../src/host/tool.ts'
import { hasPipelineRecord, installToolWake, offersTool, registerAgent } from '../src/host/wake.ts'
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

/**
 * A stand-in host context: the services by name, an event bus, and the effects it collected.
 * `options.cwd` is the cwd every live session's header carries; `options.live` is a session id →
 * record map a case can mutate (to move a workspace under a running session); omitting both stands
 * in for a session with no cwd at all, where the sandbox root answers.
 */
const context = (options = {}) => fakeContext({
  sessionCwd: options.cwd,
  live: options.live,
  sandboxRoot: 'C:\\tool-root',
  bus: true,
  provide: true,
  effect: true,
})

/**
 * An agent with a scoped context whose tools registry records what lands in it — `{ definition,
 * when }`, both of them — and, like the host's own registry, asks that condition once per step
 * before admitting the tool. `stepToolsOf` is the step's request, read through the same rule.
 */
function fakeAgent(id = 'agent-1') {
  const registered = []
  const agent = {
    id,
    ctx: {
      tools: {
        register(definition, options) {
          const entry = { definition, when: options?.when }
          registered.push(entry)
          return () => {
            const at = registered.indexOf(entry)
            if (at >= 0) registered.splice(at, 1)
          }
        },
        /* The host's own rule in one line: a condition that says no keeps the tool out of this
         * step, and a registration without one is admitted (the host's default). */
        async resolve({ agent: step }) {
          const visible = new Map()
          for (const entry of registered) {
            if (entry.when !== undefined && !(await entry.when({ agent: step }))) continue
            visible.set(entry.definition.name, entry.definition)
          }
          return visible
        },
      },
      effect: (make) => {
        make()
      },
    },
  }
  return { agent, registered }
}

/** The tool names this step's request carries. */
async function stepToolsOf(agent) {
  return [...(await agent.ctx.tools.resolve({ agent })).keys()]
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

test('Never declared: an unrelated tool call, a failed skill load, another skill name — the step registers once and carries no declaration', async () => {
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
  assert.equal(registered.length, 1, 'the step registers: registering is not what makes it visible')
  assert.deepEqual(await stepToolsOf(agent), [], 'no trigger spoke for this agent, so its request carries nothing')
})

test('Registers once: the skill tool loads a skill, the agent is marked, and its next step carries one superworker and no more', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  assert.equal(registered.length, 0, 'arming is a mark: registration belongs to the step proposal')
  await firePreStep(events, { agent }, [])
  assert.equal(registered.length, 1, 'registered once')
  assert.equal(registered[0].definition.name, TOOL_NAME)
  assert.deepEqual(await stepToolsOf(agent), [TOOL_NAME], 'the loaded skill is a reason to see the tool')

  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  await firePreStep(events, { agent }, [])
  assert.equal(registered.length, 1, 'one copy per agent')
})

test('Registers once: a user typing /sw-route goes through the same wake, and the step it was typed in already carries the tool', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const { agent, registered } = fakeAgent()

  await firePreStep(events, { agent }, [
    { source: { kind: 'skill-invocation', name: 'sw-route' } },
    { source: { kind: 'skill-invocation', name: 'sw-conduct' } },
  ])
  assert.equal(registered.length, 1)
  assert.deepEqual(await stepToolsOf(agent), [TOOL_NAME], 'the word lands before this same step resolves')
})

test('Fact wake: the workspace has .superworker, so the first step request carries the tool, no skill needed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  mkdirSync(join(root, '.superworker'), { recursive: true })
  try {
    const { ctx, events } = context({ cwd: root })
    apply(ctx)
    const { agent, registered } = fakeAgent()

    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'the workspace has a record: registered and carried on the first step')
    assert.equal(registered[0].definition.name, TOOL_NAME)
    assert.deepEqual(await stepToolsOf(agent), [TOOL_NAME])

    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'one copy per agent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Fact wake, asked every step: no record means no declaration, a record that appears is carried by the next step, and walking out of the workspace takes it away', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'superworker-elsewhere-'))
  const live = { 'agent-1': { header: { cwd: root } } }
  try {
    const { ctx, events } = context({ live })
    apply(ctx)
    const { agent, registered } = fakeAgent()

    assert.equal(hasPipelineRecord(root), false)
    await firePreStep(events, { agent }, [])
    assert.deepEqual(await stepToolsOf(agent), [], 'an unrelated workspace gets not one byte more')

    mkdirSync(join(root, '.superworker'), { recursive: true })
    assert.equal(hasPipelineRecord(root), true)
    await firePreStep(events, { agent }, [])
    assert.equal(registered.length, 1, 'the registration was already there: the condition is what changed')
    assert.deepEqual(await stepToolsOf(agent), [TOOL_NAME], 'once the record appears, the next step carries it')

    /* The new behaviour the per-step condition buys, and the one the old registration-time reading
     * could not: the workspace under a running session moved away from its record. */
    live['agent-1'].header.cwd = elsewhere
    await firePreStep(events, { agent }, [])
    assert.deepEqual(await stepToolsOf(agent), [], 'the session walked out: the tool goes with the workspace')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('Fact wake: only the old record directory, and only when the engine recognizes it — an unmigrated workspace still carries the tool, a same-named stranger does not', async () => {
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
    const { agent } = fakeAgent()

    assert.equal(hasPipelineRecord(root), false, 'an unrecognized old directory is somebody else\'s: it counts as nothing')
    await firePreStep(events, { agent }, [])
    assert.deepEqual(await stepToolsOf(agent), [], 'no recognizable record, no declaration')

    writeFileSync(join(root, LEGACY_DIR_NAME, '.gitignore'), '', 'utf8')
    writeFileSync(join(root, LEGACY_DIR_NAME, '.gitattributes'), '', 'utf8')
    assert.ok(isRecognizableLegacyRecord(root), 'the fixture is now one the engine recognizes')
    assert.equal(hasPipelineRecord(root), true, 'the old directory alone is a fact that offers the tool')
    await firePreStep(events, { agent }, [])
    assert.deepEqual(await stepToolsOf(agent), [TOOL_NAME], 'an unmigrated workspace gets the tool, so it reaches migrate')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('The condition is total: an unreadable session and a missing agent answer no, they never fail the step', () => {
  const { ctx } = context()
  /* The registry turns a condition that throws into `ToolActivationError`, which takes the whole
   * step preparation down — so every way of not knowing has to answer "no" here instead. */
  const broken = { ...ctx, sessions: { get() { throw new Error('the session is gone') } } }
  assert.equal(offersTool(broken, { id: 'agent-1' }), false)
  assert.equal(offersTool(ctx, undefined), false)
  assert.equal(offersTool(ctx, { id: 'agent-unknown' }), false, 'no cwd, no record: the sandbox root answers nothing')
})

test('A registry that cannot gate is left alone: without `resolve` a tool would be handed to every agent, so none is registered', () => {
  const { ctx } = context()
  let called = false
  const ungated = {
    id: 'agent-old',
    ctx: {
      tools: {
        register() {
          called = true
          return () => undefined
        },
      },
    },
  }
  registerAgent(ungated, toolHost(ctx))
  assert.equal(called, false, 'an ungateable registry is never handed a tool every agent would see')
})

test('The tool\'s shape: name, parameters and output are all the declared surface', () => {
  const { ctx } = context()
  const { agent, registered } = fakeAgent()
  registerAgent(agent, toolHost(ctx))

  const tool = registered[0].definition
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
  registerAgent(agent, toolHost(ctx))
  const answer = await registered[0].definition.execute({ help: true }, { agent })
  assert.equal(answer.code, 0, answer.stderr)
  assert.match(answer.stdout, /superworker -- the agent pipeline/u, 'asked empty-handed, it answers the whole index')
})

test('Unloading: the line\'s effect takes both trigger lines back; the agent\'s effect takes the tool back', async () => {
  const { ctx, events, effects } = context()
  apply(ctx)
  assert.equal(events.listenersOf('tools/post-execute').length, 1)
  assert.equal(events.listenersOf('agent/pre-step').length, 1)

  const { agent, registered } = fakeAgent()
  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  await firePreStep(events, { agent }, [])
  assert.equal(registered.length, 1)
  await firePreStep(events, { agent }, [])
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
        resolve: async () => ({}),
      },
      effect: (make) => {
        agent2.dispose = make()
      },
    },
  }
  await firePostExecute(events2, { name: 'skill', agent: agent2 }, { isError: false })
  await firePreStep(events2, { agent: agent2 }, [])
  assert.equal(holder.length, 1)
  agent2.dispose()
  assert.equal(holder.length, 0, 'the agent is gone, the tool goes with it')
})