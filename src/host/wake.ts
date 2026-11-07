/**
 * The wake: putting the agent-facing `superworker` tool in front of exactly the agents that have a
 * reason to see it, and nowhere else.
 *
 * Three triggers, one wake. A `.superworker/` workspace at the step's start (the fact trigger), the `skill`
 * tool's settled call result, and a user's `/superworker-*` invocation in a step proposal. An agent with none
 * of them keeps exactly the request header it would have without this plugin: no trigger, no tool.
 *
 * This module owns only that decision and its memory. The tool's face lives in `tool.ts`, and the
 * opener seam travels on the host face it is handed (`SuperworkerToolHost`), so this file imports
 * neither: the wake depends on the face it registers and on the seams it reads, nothing else.
 *
 * Registration is per agent scope (`agent.ctx.tools.register`) and idempotent: one agent, one
 * registration, one `tool-addition` developer record on the next request. The disposer hangs on the
 * agent's own effect, so an agent that goes away takes its tool with it and the wake's memory cannot
 * leak.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentIdOf, agentScopeOf, busOf, effectOf, liveWorkspaceRootOf, toolsOf } from './seams.ts'
import {
  PIPELINE_DIR,
  SKILL_NAME_PREFIX,
  SKILL_TOOL_NAME,
  defineSuperworkerTool,
  type SuperworkerToolDefinition,
  type SuperworkerToolHost,
} from './tool.ts'

/** The wake's own memory: the agents this process has already armed. One process, one table. */
const awake = /* @__PURE__*/ new WeakSet<object>()

/**
 * Wake one agent: register the tool into its own scope, once. A second wake for the
 * same agent is a no-op, so both triggers can fire for one session and the request
 * header still carries the tool once. Best effort by contract: an agent whose scope is
 * already gone refuses the registration, a host without a tools service has nothing to
 * register into — the wake answers quietly instead of throwing into its caller (a tool
 * pipeline or a step proposal, both of which must run on).
 *
 * The memory is one-way by design: a DSH agent's scope lives and dies with the agent,
 * so an agent remembered here never comes back to be armed again, and the entry leaves
 * with the agent object when the runtime collects it.
 */
export function wakeAgent(agent: object, host: SuperworkerToolHost): void {
  if (awake.has(agent)) return
  try {
    const ctx = agentScopeOf(agent)
    const registry = toolsOf<SuperworkerToolDefinition>(ctx)
    if (registry === undefined) return
    const dispose = registry.register(defineSuperworkerTool(host))
    effectOf(ctx)?.(() => dispose, 'superworker: the superworker tool')
    awake.add(agent)
  } catch {
    /* The scope is gone or the registration was refused: the agent is not there to arm.
     * Nothing is remembered, so a later wake for a live agent still lands. */
  }
}

/** Whether a message source names one of this pipeline's own skills. */
function isPipelineSkillSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const held = source as { kind?: unknown; name?: unknown }
  return held.kind === 'skill-invocation' && typeof held.name === 'string' && held.name.startsWith(SKILL_NAME_PREFIX)
}

/** Whether this agent already carries the tool: one agent, one registration, one wake. */
export function isAwake(agent: object): boolean {
  return awake.has(agent)
}

/**
 * Whether this workspace carries a pipeline record — the fact that arms a session.
 */
export function hasPipelineRecord(root: string | undefined): boolean {
  if (root === undefined) return false
  try {
    return existsSync(join(root, PIPELINE_DIR))
  } catch {
    /* An unreadable root is not a record: the session stays as it would be without us. */
    return false
  }
}

/**
 * Wake one agent whose workspace holds a pipeline record.
 *
 * The third trigger, and the one that makes the tool self-serve: a session sitting in a
 * `.superworker/` workspace sees the tool from its first request, with no skill loaded and no
 * guess about the conversation. Every other workspace keeps exactly the header it would
 * have had without this plugin — the answer is a fact on disk, not a judgement.
 */
export function wakeIfPipeline(agent: object, host: SuperworkerToolHost): void {
  if (isAwake(agent)) return
  const id = agentIdOf(agent)
  if (id === undefined) return
  if (!hasPipelineRecord(liveWorkspaceRootOf(host.ctx, id))) return
  wakeAgent(agent, host)
}

/** Whether one settled tool call was this session loading a skill successfully. */
function isSkillLoad(exec: { name?: unknown; agent?: unknown }, result: { isError?: unknown }): boolean {
  return exec.name === SKILL_TOOL_NAME && result.isError === false && typeof exec.agent === 'object' && exec.agent !== null
}

/**
 * Arm the wake: one listener on the skill tool's settled calls, one on the step
 * proposals that carry a user's `/superworker-*` invocation, and one on every step where the
 * agent's workspace holds a pipeline record. All three hit the same wake, and the
 * returned disposer takes the listeners back (the line's own effect collects it).
 * A host without an event surface takes nothing — the panel keeps working, only the
 * wake is absent.
 */
export function installToolWake(host: SuperworkerToolHost): () => void {
  const bus = busOf(host.ctx)
  if (bus === undefined) return () => undefined
  const offPost = bus.on('tools/post-execute', (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
    const pending = next()
    if (isSkillLoad(exec as { name?: unknown; agent?: unknown }, (result ?? {}) as { isError?: unknown })) {
      wakeAgent((exec as { agent: object }).agent, host)
    }
    return pending
  })
  const offStep = bus.on('agent/pre-step', (payload: unknown, next: () => Promise<unknown>) => {
    /* The fact trigger runs before the proposal settles: registering here lands the tool
     * in the request this very step assembles, which is what makes a `.superworker/` workspace
     * see it from its first step. The other two triggers ride the same step for a
     * session that started anywhere else. */
    const proposed = (payload as { agent?: unknown } | undefined)?.agent
    const agent = typeof proposed === 'object' && proposed !== null ? proposed : undefined
    if (agent !== undefined) wakeIfPipeline(agent, host)
    const decision = next() as Promise<{ kind?: unknown; messages?: unknown } | undefined>
    return decision.then((settled) => {
      const messages = Array.isArray(settled?.messages) ? settled.messages : []
      for (const message of messages) {
        const source = (message as { source?: unknown } | undefined)?.source
        if (!isPipelineSkillSource(source)) continue
        if (agent !== undefined) wakeAgent(agent, host)
      }
      return settled
    })
  })
  return () => {
    if (typeof offPost === 'function') offPost()
    if (typeof offStep === 'function') offStep()
  }
}
