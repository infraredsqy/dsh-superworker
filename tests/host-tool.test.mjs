/* The agent-facing `superworker` tool and its wake: one registration, made once in the plugin's own
 * context (the registry's global layer), and one condition the registry asks on every step. The
 * condition is the fact this line has always read — the workspace holds a `.superworker/` record,
 * or a recognizable record directory under the old name (which is what keeps `migrate` reachable) —
 * plus the two triggers that speak for an agent: a successful load through the `skill` tool, and a
 * user's `/sw-*` invocation claimed for a step.
 *
 * - **never declared**: registration is not a trigger. An unrelated tool's settled call, a failed
 *   skill load and a `/some-skill` invocation arm nothing, and the step carries no declaration.
 * - **one registration, before any agent**: the entry is in the registry the moment the line
 *   applies, so a session's *first* request is judged like every other one — the per-agent
 *   registration this replaced could only land on the step after the one that proposed it.
 * - **asked every step**: a record that appears mid-session is carried by the very next step, and a
 *   session that walks out of the workspace stops carrying it.
 * - **the two triggers land where the host already knows**: a `/sw-*` claim happens inside the step
 *   proposal, before that step's tools are resolved, so it speaks for the request that carries the
 *   skill's instructions — and it is the *user's* message that carries the gesture, read out of its
 *   text the same way the host's skill plugin reads it (the message naming the skill in its `source`
 *   is the body that plugin injects later); a `skill` tool result settles after the request went
 *   out, so it speaks for the next one.
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
import { hasPipelineRecord, installToolWake, offersTool } from '../src/host/wake.ts'
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
 * A stand-in host context: the services by name, an event bus, a gating tool registry, and the
 * effects it collected. `options.cwd` is the cwd every live session's header carries;
 * `options.live` is a session id → record map a case can mutate (to move a workspace under a
 * running session); omitting both stands in for a session with no cwd at all, where the sandbox
 * root answers.
 */
const context = (options = {}) => fakeContext({
  sessionCwd: options.cwd,
  live: options.live,
  sandboxRoot: 'C:\\tool-root',
  bus: true,
  tools: true,
  provide: true,
  effect: true,
})

/** One agent as the condition reads it: the identity, and whatever the session service says of it. */
const agentOf = (id = 'agent-1') => ({ id })

/** The tool names this step's request carries, asked through the host's own rule. */
async function stepToolsOf(ctx, agent) {
  return [...(await ctx.tools.resolve({ agent })).keys()]
}

/** Settle one tool call through every `tools/post-execute` listener the context holds. */
async function firePostExecute(events, exec, result) {
  for (const listener of events.listenersOf('tools/post-execute')) {
    await listener(exec, result, async () => ({ kind: 'accept' }))
  }
}

/** Claim one message for a step: the loop does this before the step's tools are resolved. */
function claimMessage(events, agent, source, text) {
  const message = text === undefined ? { source } : { source, content: [{ type: 'text', text }] }
  events.emit('agent/inbox/claimed', { agent, message, turn: 1 })
}

test('One registration, made before any agent exists: the entry is in the registry the moment the line applies', () => {
  const { ctx } = context()
  apply(ctx)

  assert.equal(ctx.tools.entries.length, 1, 'registered once, globally — not once per agent')
  assert.equal(ctx.tools.entries[0].definition.name, TOOL_NAME)
  assert.equal(typeof ctx.tools.entries[0].when, 'function', 'and it carries the one per-step condition')
})

test('Never declared: an unrelated tool call, a failed skill load, another skill name — the step carries nothing', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const agent = agentOf()

  await firePostExecute(events, { name: 'bash', agent }, { isError: false })
  await firePostExecute(events, { name: 'skill', agent }, { isError: true })
  claimMessage(events, agent, { kind: 'user' }, '/some-skill list')
  claimMessage(events, agent, { kind: 'user' }, 'see /usr/bin and 5/8 for details')

  assert.deepEqual(await stepToolsOf(ctx, agent), [], 'no trigger spoke for this agent, so its request carries nothing')
})

test('The fact wake: a workspace holding .superworker carries the tool on the first step, with no trigger at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  mkdirSync(join(root, '.superworker'), { recursive: true })
  try {
    const { ctx } = context({ cwd: root })
    apply(ctx)

    assert.deepEqual(await stepToolsOf(ctx, agentOf()), [TOOL_NAME], 'the first request of a session already carries it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A user\'s /sw-* invocation is claimed before the step resolves, so the same request carries the tool — even with no record', async () => {
  const { ctx, events } = context()
  apply(ctx)

  /* The user's own message: an ordinary `user` message whose text carries the `/sw-*` gesture —
   * the same token the host's skill plugin reads to decide to inject the skill's body. */
  const asked = agentOf('agent-sw')
  claimMessage(events, asked, { kind: 'user' }, '/sw-route 帮我把这个需求谈成一个节点')
  assert.deepEqual(await stepToolsOf(ctx, asked), [TOOL_NAME], 'the request that carries the skill\'s instructions carries the tool')

  /* A host that names the skill in the source instead of the text is not missed either. */
  const structured = agentOf('agent-structured')
  claimMessage(events, structured, { kind: 'skill-invocation', name: 'sw-conduct' })
  assert.deepEqual(await stepToolsOf(ctx, structured), [TOOL_NAME])

  const other = agentOf('agent-quiet')
  assert.deepEqual(await stepToolsOf(ctx, other), [], 'the mark is per agent, not per line')
})

test('A skill the model loads settles after the request went out: that request keeps nothing, the next one carries it', async () => {
  const { ctx, events } = context()
  apply(ctx)
  const agent = agentOf()

  assert.deepEqual(await stepToolsOf(ctx, agent), [], 'the step that carried the skill call was resolved without the tool')
  await firePostExecute(events, { name: 'skill', agent }, { isError: false })
  assert.deepEqual(await stepToolsOf(ctx, agent), [TOOL_NAME], 'the next request carries it, beside the skill\'s answer')
})

test('Asked every step: no record means no declaration, a record that appears is carried by the next step, and walking out takes it away', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'superworker-elsewhere-'))
  const live = { 'agent-1': { header: { cwd: root } } }
  try {
    const { ctx } = context({ live })
    apply(ctx)
    const agent = agentOf()

    assert.equal(hasPipelineRecord(root), false)
    assert.deepEqual(await stepToolsOf(ctx, agent), [], 'an unrelated workspace gets not one byte more')

    mkdirSync(join(root, '.superworker'), { recursive: true })
    assert.equal(hasPipelineRecord(root), true)
    assert.deepEqual(await stepToolsOf(ctx, agent), [TOOL_NAME], 'once the record appears, the next step carries it')

    live['agent-1'].header.cwd = elsewhere
    assert.deepEqual(await stepToolsOf(ctx, agent), [], 'the session walked out: the tool goes with the workspace')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('Fact wake, the old directory: an unmigrated workspace still carries the tool, a same-named stranger does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'superworker-workspace-'))
  /* The old directory counts only when `init` laid it down — the same two marks every record
   * directory carries — because that recognition is what makes `migrate` and `doctor` reachable
   * in a workspace that has not moved yet: the tool is the only road to them. The control line
   * ties the fixture to the engine's own recognition reading, so the day a third mark lands
   * this case fails loudly here instead of arming on somebody else's directory. */
  mkdirSync(join(root, LEGACY_DIR_NAME), { recursive: true })
  try {
    const { ctx } = context({ cwd: root })
    apply(ctx)

    assert.equal(hasPipelineRecord(root), false, 'an unrecognized old directory is somebody else\'s: it counts as nothing')
    assert.deepEqual(await stepToolsOf(ctx, agentOf()), [], 'no recognizable record, no declaration')

    writeFileSync(join(root, LEGACY_DIR_NAME, '.gitignore'), '', 'utf8')
    writeFileSync(join(root, LEGACY_DIR_NAME, '.gitattributes'), '', 'utf8')
    assert.ok(isRecognizableLegacyRecord(root), 'the fixture is now one the engine recognizes')
    assert.equal(hasPipelineRecord(root), true, 'the old directory alone is a fact that offers the tool')
    assert.deepEqual(await stepToolsOf(ctx, agentOf()), [TOOL_NAME], 'an unmigrated workspace gets the tool, so it reaches migrate')
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
  /* The capability line `toolsOf` reads: `register` without `resolve` is a registry that would
   * show an unconditional tool to everybody. */
  ctx.tools = { register() { called = true; return () => undefined } }
  installToolWake(toolHost(ctx))
  assert.equal(called, false, 'an ungateable registry is never handed a tool every agent would see')
})

test('The tool\'s shape: name, parameters and output are all the declared surface', () => {
  const { ctx } = context()
  apply(ctx)

  const tool = ctx.tools.entries[0].definition
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
  apply(ctx)
  const answer = await ctx.tools.entries[0].definition.execute({ help: true }, { agent: agentOf() })
  assert.equal(answer.code, 0, answer.stderr)
  assert.match(answer.stdout, /superworker -- the agent pipeline/u, 'asked empty-handed, it answers the whole index')
})

test('Unloading: the line\'s effects take both trigger lines back and unregister the tool', async () => {
  const { ctx, events, effects } = context()
  apply(ctx)
  assert.equal(events.listenersOf('tools/post-execute').length, 1)
  assert.equal(events.listenersOf('agent/inbox/claimed').length, 1)
  assert.equal(ctx.tools.entries.length, 1)

  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  assert.equal(events.listenersOf('tools/post-execute').length, 0, 'the post-execute line is gone')
  assert.equal(events.listenersOf('agent/inbox/claimed').length, 0, 'the claim line is gone')
  assert.equal(ctx.tools.entries.length, 0, 'and the registration went with them')
})