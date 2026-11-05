/**
 * The agent-facing `pathfinder` tool, and the wake that registers it.
 *
 * The words themselves live in the engine (`answer` / `describe`); this file is the
 * registration half: the tool's face (name, description, parameters, output), and the
 * one wake function that puts it in front of exactly the agents whose session touched a
 * pipeline skill — the `skill` tool's call result, or a user `/pf-*` invocation — and
 * never in front of anyone else. No trigger, no tool: an unrelated session's request
 * header stays exactly as it would be without this plugin.
 *
 * Three names are pinned in one place ({@link PATHFINDER_TOOL_NAME},
 * {@link SKILL_TOOL_NAME}, {@link SKILL_NAME_PREFIX}); the registration, the skill-body
 * scan and the README all read them, and the lock test goes red when they disagree.
 *
 * Registration is per agent scope (`agent.ctx.tools.register`) and idempotent: one
 * agent, one registration, one `tool-addition` developer record on the next request.
 * The disposer hangs on the agent's own effect, so an agent that goes away takes its
 * tool with it and the wake's memory cannot leak.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { answer, describe, longResultPointerOf } from 'pf-core'
import { workspaceRootOf } from './gateway.ts'
import { executorOf } from './relay.ts'
import { shippedPluginsDir } from './skills.ts'

/** The agent-facing tool's name: the same spelling the skills and the README name. */
export const PATHFINDER_TOOL_NAME = 'pathfinder'
/** The tool whose call result means "a skill was loaded": DSH's own skill loader. */
export const SKILL_TOOL_NAME = 'skill'
/** The prefix the pipeline's skills are named with, in the catalog and as `/pf-*`. */
export const SKILL_NAME_PREFIX = 'pf-'

/** The tool's parameters, as the model spells them (the words are never enumerated here). */
export interface PathfinderToolArgs {
  readonly word?: unknown
  readonly args?: unknown
  readonly help?: unknown
}

/** The caller identity one execution carries, as far as this layer reads it. */
export interface PathfinderToolExecution {
  readonly agent?: { readonly id?: unknown } | undefined
}

/** The registry face this layer registers through (the real host's `ctx.tools`). */
export interface ToolRegistryFace {
  register(definition: PathfinderToolDefinition): () => void
}

/** The definition as the registry accepts it; schemas stay structural here. */
export interface PathfinderToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: PathfinderToolArgs, value: unknown): ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  }
  execute(args: PathfinderToolArgs, exec: PathfinderToolExecution): Promise<unknown>
}

/**
 * The description the tool registers with, generated from the engine's own index data.
 *
 * This is layer 0: the one text an agent has in context on every turn, so it has to teach the
 * recursion in the order the caller needs it — the index, a word's own page, the page of an
 * exact call (a word plus its args), and running that call. One word is named, as the example;
 * the index itself is not repeated here. The 400-byte lock (`tests/host-tool-answer.test.mjs`)
 * is the ceiling on how much teaching fits.
 */
export function toolDescriptionOf(): string {
  const index = describe()
  const what = index.shape.split('\n')[0] ?? 'pf — the pipeline words'
  return (
    `${what}. The words answer from this session's workspace. ` +
    'help:true gives the word index; help:true plus a word gives that word\'s own page; ' +
    'help:true plus a word and its args gives that exact call\'s page (word:"dag", args:["list"] ' +
    'asks dag list --help). A word with args and no help runs it.'
  )
}

/**
 * The argv one tool call spells, in the words layer's own vocabulary.
 *
 * `help: true` composes with `args` instead of throwing them away: it asks the page of the exact
 * call the caller spelled, so `word: "issue", args: ["status"]` asks `issue status --help`, not
 * the group page. That flag rides in the line's last cell, which is how a table row and a plugin
 * word alike are asked for a call's page, so the composed call is a page; a caller who already
 * ended the line with `--help` keeps their own spelling rather than getting a second one.
 */
export function argvOf(args: PathfinderToolArgs): string[] {
  const word = typeof args.word === 'string' && args.word !== '' ? args.word : undefined
  const rest = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === 'string') : []
  if (args.help === true) {
    if (word === undefined) return ['help']
    return rest[rest.length - 1] === '--help' ? [word, ...rest] : [word, ...rest, '--help']
  }
  if (word === undefined) return ['help']
  return [word, ...rest]
}

/** One call's canonical value: the words layer's two streams and the exit code. */
export interface PathfinderToolValue {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The facts one execution reads off the host: the context seams the words layer is wired to. */
export interface PathfinderToolHost {
  readonly ctx: Context
}

/** The tool itself: every call goes through the words layer's one `answer()`. */
export function definePathfinderTool(host: PathfinderToolHost): PathfinderToolDefinition {
  return {
    name: PATHFINDER_TOOL_NAME,
    description: toolDescriptionOf(),
    parameters: {
      type: 'object',
      properties: {
        word: { type: 'string', description: 'the word to answer or run ("help" answers the index)' },
        args: { type: 'array', items: { type: 'string' }, description: "the rest of the line for a word that takes one" },
        help: { type: 'boolean', description: 'true: answer the index (no word), that word\'s own page (word only), or that exact call\'s page (word plus args), instead of running it' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          code: { type: 'integer', description: 'the exit code the word answered with' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['code', 'stdout', 'stderr'],
        additionalProperties: false,
      },
      render(_args, value) {
        // The streams pass verbatim (the CLI's bytes are the contract); the one thing this
        // projection adds is the exit code spelled out when it is not zero.
        const answer = value as PathfinderToolValue
        const text = `${answer.stdout}${answer.stderr}${answer.code === 0 ? '' : `\n(exit code ${answer.code})`}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const raw = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
      const sessionId = raw as SessionId
      const root = await workspaceRootOf(host.ctx, sessionId)
      const argv = argvOf(args)
      const outcome = await answer(argv, {
        root,
        executor: executorOf(host.ctx, sessionId, root),
        openerAvailable: true,
        pluginsDir: shippedPluginsDir(),
      })
      // The long-answer contract comes from the words layer, never restated here: an
      // oversized answer travels whole, with the pointer as its own last line. The word
      // a pointer is asked about is the line's first two cells (`dag list`), the way the
      // table spells a group's verb.
      const word = argv.length >= 2 ? `${argv[0]} ${argv[1]}` : (argv[0] ?? '')
      const pointer = longResultPointerOf(outcome.stdout, word)
      const stdout = pointer === null ? outcome.stdout : `${outcome.stdout}\n(${pointer})\n`
      return { code: outcome.code, stdout, stderr: outcome.stderr }
    },
  }
}

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
export function wakeAgent(agent: object, host: PathfinderToolHost): void {
  if (awake.has(agent)) return
  try {
    const ctx = (agent as { ctx?: unknown }).ctx
    const registry = (typeof ctx === 'object' && ctx !== null ? (ctx as { tools?: unknown }).tools : undefined) as
      | ToolRegistryFace
      | undefined
    if (registry === undefined || typeof registry.register !== 'function') return
    const dispose = registry.register(definePathfinderTool(host))
    const effect = (ctx as { effect?: (make: () => unknown, label?: string) => unknown }).effect
    if (typeof effect === 'function') effect.call(ctx, () => dispose, 'pathfinder: the pathfinder tool')
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

/** Whether one settled tool call was this session loading a skill successfully. */
function isSkillLoad(exec: { name?: unknown; agent?: unknown }, result: { isError?: unknown }): boolean {
  return exec.name === SKILL_TOOL_NAME && result.isError === false && typeof exec.agent === 'object' && exec.agent !== null
}

/**
 * Arm the wake: one listener on the skill tool's settled calls, one on the step
 * proposals that carry a user's `/pf-*` invocation. Both hit the same wake, and the
 * returned disposer takes both listeners back (the line's own effect collects it).
 * A host without an event surface takes nothing — the panel keeps working, only the
 * wake is absent.
 */
export function installToolWake(ctx: Context): () => void {
  const bus = ctx as unknown as {
    on?: (event: string, listener: (...args: never[]) => unknown) => unknown
  }
  if (typeof bus.on !== 'function') return () => undefined
  const host: PathfinderToolHost = { ctx }
  const offPost = bus.on('tools/post-execute', (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
    const pending = next()
    if (isSkillLoad(exec as { name?: unknown; agent?: unknown }, (result ?? {}) as { isError?: unknown })) {
      wakeAgent((exec as { agent: object }).agent, host)
    }
    return pending
  })
  const offStep = bus.on('agent/pre-step', (payload: unknown, next: () => Promise<unknown>) => {
    const decision = next() as Promise<{ kind?: unknown; messages?: unknown } | undefined>
    return decision.then((settled) => {
      const messages = Array.isArray(settled?.messages) ? settled.messages : []
      for (const message of messages) {
        const source = (message as { source?: unknown } | undefined)?.source
        if (!isPipelineSkillSource(source)) continue
        const agent = (payload as { agent?: unknown } | undefined)?.agent
        if (typeof agent === 'object' && agent !== null) wakeAgent(agent, host)
      }
      return settled
    })
  })
  return () => {
    if (typeof offPost === 'function') offPost()
    if (typeof offStep === 'function') offStep()
  }
}
