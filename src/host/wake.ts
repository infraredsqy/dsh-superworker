/**
 * The wake: putting the agent-facing `superworker` tool in front of exactly the agents that have a
 * reason to see it, and nowhere else.
 *
 * One registration, made once, in this plugin's own context — the registry's global layer — carrying
 * one condition the registry asks on every step. Nothing is registered per agent, and nothing waits
 * for a step proposal, because a step's tools are resolved before any per-step hook runs: a
 * registration made inside `agent/pre-step` can only reach the step after it. A global registration
 * exists before any agent does, so the first request of every session is judged by the condition
 * like every other one.
 *
 * The condition is the same fact this line has always read, asked again every step: the workspace
 * holds a record directory the pipeline recognizes — the one it lays down today, or the older layer
 * a workspace that has not migrated yet still holds, which must reach `migrate` and `doctor` at all,
 * and the tool is how — or a trigger has spoken for this agent: the `skill` tool's settled call
 * result, or a user's `/sw-*` invocation. An agent with neither keeps exactly the request header it
 * would have without this plugin.
 *
 * Registering unconditionally is safe *because* of the condition, and that is what the condition's
 * headless rule buys: asked per step, a record appearing mid-session arms the very next step and a
 * workspace the session walks out of takes the tool away.
 *
 * The two triggers land at different points on purpose. A user's `/sw-*` invocation is claimed from
 * the inbox *before* the step's tools are resolved, so it speaks for that very step: the request that
 * carries the skill's instructions carries the tool as well. The message that carries the gesture is
 * the user's own — the host's skill plugin reads the same `/name` token out of its text and injects
 * the body later, inside the step proposal, which is too late to speak for the step that carries it.
 * A skill the model loads through the `skill` tool can only speak for the next request, because that
 * request has already gone out — and by the time the skill's answer comes back, the next request
 * carries both.
 *
 * This module owns only that decision and its memory. The tool's face lives in `tool.ts`, the
 * record directory's one spelling comes from the contract (`RECORD_DIR`), the older layer's
 * recognition is the engine's (`isRecognizableLegacyRecord`), and the opener seam travels on the
 * host face it is handed (`SuperworkerToolHost`): the wake depends on the face it registers, the
 * seams it reads, and those two facts, and it never reaches the opener or the relay themselves.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isRecognizableLegacyRecord } from 'superworker-core'
import { RECORD_DIR } from './contract.ts'
import { agentIdOf, busOf, liveWorkspaceRootOf, toolsOf } from './seams.ts'
import {
  SKILL_NAME_PREFIX,
  SKILL_TOOL_NAME,
  defineSuperworkerTool,
  type SuperworkerToolDefinition,
  type SuperworkerToolHost,
} from './tool.ts'

/**
 * The agents a trigger has spoken for: one skill was loaded, or a user typed `/sw-*`. A mark that
 * the condition reads; nothing is registered for it.
 */
const armed = /* @__PURE__*/ new WeakSet<object>()

/**
 * Speak for one agent: it loaded a pipeline skill, or a user asked for one. From the step being
 * prepared — or the next one, when the trigger settled too late to be seen — the condition answers
 * `true` for it.
 */
export function armAgent(agent: object): void {
  armed.add(agent)
}

/**
 * The `/name` gesture the host's own skill plugin reads out of a user's text — the same pattern,
 * because this line has to recognize exactly the messages that plugin turns into a skill
 * invocation. A user's `/sw-route` arrives as an ordinary `user` message carrying that text; the
 * message that names the skill in its `source` is the body the skill plugin injects afterwards,
 * inside the step proposal, which is too late to speak for the step that carries it.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/gu

/** Whether a message source names one of this pipeline's own skills. */
function isPipelineSkillSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const held = source as { kind?: unknown; name?: unknown }
  return held.kind === 'skill-invocation' && typeof held.name === 'string' && held.name.startsWith(SKILL_NAME_PREFIX)
}

/** Whether one claimed message is a user asking for one of this pipeline's skills in their own words. */
function userAskedForPipelineSkill(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false
  const held = message as { source?: { kind?: unknown }; content?: unknown }
  if (held.source?.kind !== 'user') return false
  const blocks = Array.isArray(held.content) ? held.content : []
  for (const block of blocks) {
    const typed = block as { type?: unknown; text?: unknown } | null
    if (typed === null || typed.type !== 'text' || typeof typed.text !== 'string') continue
    for (const match of typed.text.matchAll(SKILL_GESTURE)) {
      const name = match[2]
      if (typeof name === 'string' && name.startsWith(SKILL_NAME_PREFIX)) return true
    }
  }
  return false
}

/**
 * Whether this workspace carries a pipeline record — the fact that offers a session the tool.
 *
 * A record under today's name answers first. A workspace holding only the older layer counts
 * too, when the engine recognizes it as one the pipeline laid down, so an unmigrated workspace
 * reaches `migrate` and `doctor` at all — the tool is how it reaches them. An old directory the
 * engine does not recognize is somebody else's directory that shares a name: it counts as
 * nothing, and the workspace keeps the header it would have had without this plugin.
 */
export function hasPipelineRecord(root: string | undefined): boolean {
  if (root === undefined) return false
  try {
    if (existsSync(join(root, RECORD_DIR))) return true
    return isRecognizableLegacyRecord(root)
  } catch {
    /* An unreadable root is not a record: the session stays as it would be without us. */
    return false
  }
}

/**
 * The workspace root one agent's step is asked about: the live session's own cwd, read off the
 * agent when the host keeps it there, else the same reading `liveWorkspaceRootOf` makes through the
 * session service (and, behind both, the sandbox policy's root).
 *
 * Symmetric on purpose: asking the agent first costs nothing and needs no service, and a session
 * service that has let go of this id still answers from the root the workspace stands in.
 */
function stepRootOf(ctx: Context, agent: object): string | undefined {
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } }).session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  const id = agentIdOf(agent)
  return id === undefined ? undefined : liveWorkspaceRootOf(ctx, id)
}

/**
 * The one condition a registration carries: does this step's agent have a reason to see the tool.
 *
 * **Total by contract.** The registry fails the whole step preparation on a condition that throws
 * (`ToolActivationError`), so every way of not knowing — no agent, no workspace, a session service
 * that throws, an unreadable root — answers `false` here: a step that cannot be judged carries no
 * tool, and no step is failed on this line's account.
 *
 * The two marks are independent: `armed` is what the triggers set, and the record reading is the
 * fact on disk, so a session that starts in a record-bearing workspace needs neither a skill nor a
 * word from the user.
 */
export function offersTool(ctx: Context, agent: object | undefined): boolean {
  try {
    if (agent === undefined || agent === null) return false
    if (armed.has(agent)) return true
    return hasPipelineRecord(stepRootOf(ctx, agent))
  } catch {
    /* A condition that throws would fail the step: an unanswerable question answers "no". */
    return false
  }
}

/** Whether one settled tool call was this session loading a skill successfully. */
function isSkillLoad(exec: { name?: unknown; agent?: unknown }, result: { isError?: unknown }): boolean {
  return exec.name === SKILL_TOOL_NAME && result.isError === false && typeof exec.agent === 'object' && exec.agent !== null
}

/**
 * Install the registration and the two triggers, and answer the one disposer that takes them back.
 *
 * The registration goes into this plugin's own context, which is what puts it in the registry's
 * global layer: visible to every agent, admitted per step by the condition. A host whose registry
 * cannot gate (no `resolve`, so `toolsOf` answers nothing) is left alone rather than handed a tool
 * every agent would see — the wake answers quietly instead of throwing into its caller, which is
 * the plugin's own apply. The listeners need an event surface; a host without one keeps the
 * record-based half of the wake and loses only the two triggers.
 */
export function installToolWake(host: SuperworkerToolHost): () => void {
  const registry = toolsOf<SuperworkerToolDefinition>(host.ctx)
  if (registry === undefined) return () => undefined
  let disposeRegistration: () => void
  try {
    disposeRegistration = registry.register(defineSuperworkerTool(host), {
      /* The step's own agent is the one the condition judges; a global registration serves every
       * agent, so the question has to be asked of the step rather than of the registration. */
      when: (step) => offersTool(host.ctx, step.agent),
    })
  } catch {
    /* A registry that refuses the name (or unloads mid-registration) leaves the line without a
     * tool rather than with a broken one: the panel keeps working, only the wake is absent. */
    return () => undefined
  }
  const bus = busOf(host.ctx)
  if (bus === undefined) {
    return () => {
      if (typeof disposeRegistration === 'function') disposeRegistration()
    }
  }
  /* Claimed *inside* the step proposal, before that step's tools are resolved: a `/sw-*` message
   * therefore speaks for the request that carries the skill's instructions, not the one after.
   * The user's own message is the one that names the skill in its text (the host's skill plugin
   * reads the same gesture and injects the body later); a claimed message whose `source` already
   * names the skill is accepted too, so a host that delivers it that way is not missed. */
  const offClaim = bus.on('agent/inbox/claimed', (payload: unknown) => {
    try {
      const held = payload as { agent?: unknown; message?: unknown } | undefined
      const agent = held?.agent
      if (typeof agent !== 'object' || agent === null) return
      const message = held?.message as { source?: unknown } | undefined
      if (isPipelineSkillSource(message?.source) || userAskedForPipelineSkill(message)) armAgent(agent)
    } catch {
      /* A message shape this line cannot read is not a reason to fail someone else's step. */
    }
  })
  /* A settled skill load speaks for the next request: this one has already gone out. */
  const offPost = bus.on('tools/post-execute', (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
    const pending = next()
    if (isSkillLoad(exec as { name?: unknown; agent?: unknown }, (result ?? {}) as { isError?: unknown })) {
      armAgent((exec as { agent: object }).agent)
    }
    return pending
  })
  return () => {
    if (typeof offClaim === 'function') offClaim()
    if (typeof offPost === 'function') offPost()
    disposeRegistration()
  }
}