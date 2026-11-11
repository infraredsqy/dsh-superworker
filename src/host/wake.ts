/**
 * The wake: putting the agent-facing `superworker` tool in front of exactly the agents that have a
 * reason to see it, and nowhere else.
 *
 * Registration and visibility are two different questions, and the host asks them at two different
 * times. Registration is per agent scope (`agent.ctx.tools.register`) and happens once: the step
 * proposal registers the tool into the agent that proposed the step, an idempotent no-op after the
 * first time, and an agent minted by this line's opener (`executor.ts`) is registered for directly,
 * because that session's first step may leave the proposal's event path behind. Visibility is the
 * registry's per-step question: the registration carries one condition, the registry asks it for
 * every step, and a step that answers `false` has neither the tool's declaration nor its dispatch.
 *
 * The condition is the same fact this line has always read, asked again every step: the workspace
 * holds a record directory the pipeline recognizes — the one it lays down today, or the older layer
 * a workspace that has not migrated yet still holds, which must reach `migrate` and `doctor` at all,
 * and the tool is how — or a trigger has spoken for this agent: the `skill` tool's settled call
 * result, or a user's `/sw-*` invocation in a step proposal. An agent with neither keeps exactly
 * the request header it would have without this plugin.
 *
 * Registering unconditionally is safe *because* of the condition, and that is what the condition's
 * headless rule buys: asked per step, a record appearing mid-session arms the very next step and a
 * workspace the session walks out of takes the tool away. The old registration-time reading stuck
 * at whichever answer came first.
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
import { agentIdOf, agentScopeOf, busOf, effectOf, liveWorkspaceRootOf, toolsOf } from './seams.ts'
import {
  SKILL_NAME_PREFIX,
  SKILL_TOOL_NAME,
  defineSuperworkerTool,
  type SuperworkerToolDefinition,
  type SuperworkerToolHost,
} from './tool.ts'

/**
 * The agents a trigger has spoken for: one skill was loaded, or a user typed `/sw-*`. A mark, not a
 * registration — the condition reads it, and the step's own registration is what puts the tool in
 * reach.
 */
const armed = /* @__PURE__*/ new WeakSet<object>()

/** The agents this process has already registered the tool into: one agent, one registration. */
const registered = /* @__PURE__*/ new WeakSet<object>()

/**
 * Speak for one agent: it loaded a pipeline skill, or a user asked for one. From this step or the
 * next, the condition answers `true` for it. A mark only — registration belongs to the step
 * proposal, which runs ahead of every request that could carry the tool.
 */
export function armAgent(agent: object): void {
  armed.add(agent)
}

/** Whether a message source names one of this pipeline's own skills. */
function isPipelineSkillSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const held = source as { kind?: unknown; name?: unknown }
  return held.kind === 'skill-invocation' && typeof held.name === 'string' && held.name.startsWith(SKILL_NAME_PREFIX)
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

/**
 * Register the tool into one agent's own scope, once, with the condition above.
 *
 * Idempotent by the `registered` mark: the step proposal, the opener, and a second loaded skill can
 * all reach one agent, and the request header still carries the tool once. Best effort by contract:
 * an agent whose scope is already gone refuses the registration, and a host whose registry cannot
 * gate (no `resolve`, so `toolsOf` answers nothing) is left alone rather than handed a tool every
 * agent would then see — the wake answers quietly instead of throwing into its caller (a tool
 * pipeline or a step proposal, both of which must run on).
 *
 * The memory is one-way by design: a DSH agent's scope lives and dies with the agent, so an agent
 * remembered here never comes back to be armed again, and the entry leaves with the agent object
 * when the runtime collects it.
 */
export function registerAgent(agent: object, host: SuperworkerToolHost): void {
  if (registered.has(agent)) return
  try {
    const ctx = agentScopeOf(agent)
    const registry = toolsOf<SuperworkerToolDefinition>(ctx)
    if (registry === undefined) return
    const dispose = registry.register(defineSuperworkerTool(host), {
      /* The step's own agent is the one the condition judges; the agent this registration hangs on
       * is the same object, so the pass-through cannot arm somebody else's request. */
      when: (step) => offersTool(host.ctx, step.agent),
    })
    effectOf(ctx)?.(() => dispose, 'superworker: the superworker tool')
    registered.add(agent)
  } catch {
    /* The scope is gone or the registration was refused: the agent is not there to arm.
     * Nothing is remembered, so a later wake for a live agent still lands. */
  }
}

/** Whether one settled tool call was this session loading a skill successfully. */
function isSkillLoad(exec: { name?: unknown; agent?: unknown }, result: { isError?: unknown }): boolean {
  return exec.name === SKILL_TOOL_NAME && result.isError === false && typeof exec.agent === 'object' && exec.agent !== null
}

/**
 * Arm the wake: one listener on the skill tool's settled calls, one on the step proposals that
 * carry a user's `/sw-*` invocation, and one on every step, which is where the tool is registered
 * into the proposing agent's scope — ahead of the request that step assembles, so the condition is
 * already in place when the registry asks it. Both triggers only mark their agent; the proposal's
 * own registration is what puts the tool in reach, and the condition is what keeps it out of
 * everybody else's request. The returned disposer takes the listeners back (the line's own effect
 * collects it). A host without an event surface takes nothing — the panel keeps working, only the
 * wake is absent.
 */
export function installToolWake(host: SuperworkerToolHost): () => void {
  const bus = busOf(host.ctx)
  if (bus === undefined) return () => undefined
  const offPost = bus.on('tools/post-execute', (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
    const pending = next()
    if (isSkillLoad(exec as { name?: unknown; agent?: unknown }, (result ?? {}) as { isError?: unknown })) {
      armAgent((exec as { agent: object }).agent)
    }
    return pending
  })
  const offStep = bus.on('agent/pre-step', (payload: unknown, next: () => Promise<unknown>) => {
    /* The registration runs before the proposal settles: it lands in the scope this very step's
     * tool set resolves against, and the condition it carries is asked by that resolution. */
    const proposed = (payload as { agent?: unknown } | undefined)?.agent
    const agent = typeof proposed === 'object' && proposed !== null ? proposed : undefined
    if (agent !== undefined) registerAgent(agent, host)
    const decision = next() as Promise<{ kind?: unknown; messages?: unknown } | undefined>
    return decision.then((settled) => {
      const messages = Array.isArray(settled?.messages) ? settled.messages : []
      for (const message of messages) {
        const source = (message as { source?: unknown } | undefined)?.source
        if (!isPipelineSkillSource(source)) continue
        /* The user asked in this step, so the mark lands before the same step resolves: a
         * `/sw-*` proposal sees the tool immediately, not on the step after. */
        if (agent !== undefined) armAgent(agent)
      }
      return settled
    })
  })
  return () => {
    if (typeof offPost === 'function') offPost()
    if (typeof offStep === 'function') offStep()
  }
}