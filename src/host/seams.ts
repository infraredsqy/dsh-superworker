/**
 * Every reach into the host context, in one file.
 *
 * This half declares four services as inject requirements (`workspaceFiles`, `sessions`,
 * `sandboxPolicy`, `tools`); everything else it touches — the agent registry, the preset roster, the
 * workspace registry, the skills catalog, the default model, the prompt service (the runtime-context
 * channel), the logger, the event bus, the effect seam — may or may not be mounted, so each is
 * fetched structurally by name and anything answering
 * another shape counts as absent. That decision is made here, once per service: a module reads the
 * seam it needs and never spells `(ctx as {...})` itself, so a host shape change lands in one place
 * and a new optional service is one more function.
 *
 * Two shapes are deliberately narrow. {@link LogFace} is one verb with a fallback order, because the
 * hosts in front of us carry any subset of the three levels. {@link EffectFace} is the lifecycle seam
 * an unload's undo hangs on, taken as a callback rather than read off the context by each caller.
 */
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for these services live on the package entries; type-only, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The three levels this half writes at. */
export type LogLevel = 'info' | 'warn' | 'error'

/** A logger as a host may carry it: every level optional, so a stand-in can offer only the one it uses. */
export interface Logging {
  info?(line: string): void
  warn?(line: string): void
  error?(line: string): void
}

/** The one logger face this half writes through: `write` picks the level, and a missing level falls back to the one the host does carry. */
export interface LogFace {
  write(level: LogLevel, line: string): void
}

/** An event bus as this half reads it: subscription only, and the off function it answers is optional. */
export interface BusFace {
  on(event: string, listener: (...args: never[]) => unknown): unknown
}

/**
 * One model step, as far as a tool's own condition reads it: the agent preparing the step. The
 * registry hands the rest along too (the captured model selection, the preparation's abort
 * signal); this half asks only about the agent, and the port stays narrow because it is this
 * half's reading, not the host's contract.
 */
export interface ToolActivation {
  readonly agent: object
}

/** What one registration hands the registry besides the definition: the step-time condition. */
export interface ToolRegistrationOptions {
  /** Asked once per step; `false` keeps the tool out of that step's declarations and dispatch. */
  when(context: ToolActivation): boolean | Promise<boolean>
}

/**
 * A tool registry as an agent's own scope carries it, when it gates: one `register` answered with
 * the off function, and the per-step `resolve` that makes a condition mean anything.
 *
 * The `resolve` member is the capability line, read once here (0.2.1 hosts had a `register` that
 * took one argument and honored no condition; a silent extra argument would have left the tool
 * visible to every agent). A registry without `resolve` therefore reads as *absent* below, and the
 * wake arms nothing rather than arming everyone: the stricter engine range is what keeps this line
 * off such a host in the first place.
 */
export interface ToolRegistryPort<Definition> {
  register(definition: Definition, options?: ToolRegistrationOptions): () => void
  resolve(context: ToolActivation): Promise<unknown>
}

/** The session identity one agent stands for (`agent.id`), when the object carries a non-empty string. */
export function agentIdOf(agent: object): string | undefined {
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The tool registry this context carries, when it answers that shape. Called with the plugin's own
 * context, which has no scope: the registration lands in the registry's global layer, visible to
 * every agent and admitted per step by the registration's condition.
 */
export function toolsOf<Definition>(ctx: unknown): ToolRegistryPort<Definition> | undefined {
  const tools = (ctx as { tools?: unknown } | null | undefined)?.tools
  if (tools === null || typeof tools !== 'object') return undefined
  if (typeof (tools as { register?: unknown }).register !== 'function') return undefined
  if (typeof (tools as { resolve?: unknown }).resolve !== 'function') return undefined
  return tools as ToolRegistryPort<Definition>
}

/**
 * The workspace root one agent sits in right now, as the wake reads it: the live session's own cwd,
 * else the root the sandbox policy records.
 *
 * The same order {@link workspaceRootOf} reads, minus the persisted header — a live agent always has
 * one — and synchronous on purpose: this runs inside a step proposal, before the request is
 * assembled, not in a tool body that may await.
 */
export function liveWorkspaceRootOf(ctx: Context, agentId: string): string | undefined {
  const sessions = (ctx as unknown as { sessions?: { get?: (id: string) => unknown } }).sessions
  const live = typeof sessions?.get === 'function'
    ? (sessions.get(agentId) as { header?: { cwd?: unknown } } | undefined)
    : undefined
  const cwd = live?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  const fallback = (ctx as unknown as { sandboxPolicy?: { workspaceRoot?: unknown } }).sandboxPolicy?.workspaceRoot
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined
}

/** The effect seam (cordis's own): run once, with the result collected as an effect of the calling plugin. */
export type EffectFace = (make: () => unknown, label?: string) => unknown

/**
 * One optional service, fetched by name: `undefined` when the context holds nothing under that name
 * or holds something that is not an object (a host that answers `null` and one that answers nothing
 * are the same absence here).
 */
function serviceOf(ctx: unknown, name: string): Record<string, unknown> | undefined {
  const read = (ctx as { get?: (service: string) => unknown } | undefined)?.get
  if (typeof read !== 'function') return undefined
  const held = read.call(ctx, name)
  return held === null || typeof held !== 'object' ? undefined : (held as Record<string, unknown>)
}

/** The function member `name` of one held service, when it is a function; anything else is absent. */
function memberOf(held: Record<string, unknown> | undefined, name: string): ((...args: unknown[]) => unknown) | undefined {
  const member = held?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : undefined
}

/**
 * The agent registry, when this host carries one. The caller decides what it needs of it: an open
 * needs `create`, the liveness reading needs `list`.
 */
export function agentsOf(ctx: Context): AgentRegistry | undefined {
  return serviceOf(ctx, 'agents') as AgentRegistry | undefined
}

/** The preset side of one open, as a narrow local face. */
export interface PresetPort {
  resolve(presetId?: string): Promise<{ readonly id: string }>
  mount(agentCtx: Context, id: string): Promise<void>
}

/**
 * The preset roster this context carries, when it answers the shape above. The session-controller
 * composes its own sessions through the standing agent preset — the mount is what gives a session its
 * scoped world (tools, skills, the lot) — so this line composes the sessions that work nodes the same
 * way. A headless composition without the roster keeps the bare open.
 */
export function presetPortOf(ctx: Context): PresetPort | undefined {
  const held = serviceOf(ctx, 'agentPresets')
  const resolve = memberOf(held, 'resolve')
  const mount = memberOf(held, 'mount')
  if (held === undefined || resolve === undefined || mount === undefined) return undefined
  return {
    async resolve(presetId?: string): Promise<{ readonly id: string }> {
      return (await resolve.call(held, presetId)) as { readonly id: string }
    },
    async mount(agentCtx: Context, id: string): Promise<void> {
      await mount.call(held, agentCtx, id)
    },
  }
}

/** The workspace a session is attached to, as the only part this half uses. */
export interface WorkspacePort {
  attachSession(session: SessionId): Promise<void>
}

/** The workspace registry, as the only part this half uses. */
export interface WorkspaceRegistryPort {
  /** The workspace at one canonical path; `undefined` when the entity names no `attachSession`. */
  create(path: string): Promise<WorkspacePort | undefined>
}

/**
 * The workspace registry this context carries, when it answers the shape above: `create` answers the
 * entity for a canonical path (repeating it for the same path answers the same entity unchanged), and
 * `attachSession` is what joins a live session to it. Neither is a declared dependency of this line —
 * a headless composition mounts no workspace layer.
 */
export function workspaceRegistryOf(ctx: Context): WorkspaceRegistryPort | undefined {
  const held = serviceOf(ctx, 'workspaceRegistry')
  const create = memberOf(held, 'create')
  if (held === undefined || create === undefined) return undefined
  return {
    async create(path: string): Promise<WorkspacePort | undefined> {
      const workspace = await create.call(held, path)
      if (workspace === null || typeof workspace !== 'object') return undefined
      const attach = (workspace as { attachSession?: unknown }).attachSession
      if (typeof attach !== 'function') return undefined
      return {
        async attachSession(session: SessionId): Promise<void> {
          await (attach as (session: SessionId) => Promise<unknown>).call(workspace, session)
        },
      }
    },
  }
}

/**
 * The model selection a fresh session opens with: the route the dispatch named when it named one, else
 * the deployment's current choice (the same one a session opened through the host's own surface gets).
 * The service that knows the default is asked for by name on the spot, structurally — a host without
 * it (or one whose answer cannot be read) omits the selection and the loop's own defaults apply.
 */
export function modelSelectionOf(ctx: Context, named?: string): AgentOptions | undefined {
  const source = ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
  if (source === undefined || typeof source.currentSelection !== 'function') return routeOf(named)
  let picked: unknown
  try {
    picked = source.currentSelection()
  } catch {
    return routeOf(named)
  }
  const asked = routeOf(named)
  if (asked !== undefined) return asked
  if (picked === null || typeof picked !== 'object') return undefined
  const held = picked as { provider?: unknown; model?: unknown }
  const provider = typeof held.provider === 'string' && held.provider.length > 0 ? held.provider : undefined
  const model = typeof held.model === 'string' && held.model.length > 0 ? held.model : undefined
  if (provider === undefined && model === undefined) return undefined
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * One route in the ecosystem's spelling, `provider/model`, split here: the route arrives whole,
 * carried by the engine. A route with no slash is read as the model alone (the host's own default
 * provider), which is what a bare model word means elsewhere.
 */
function routeOf(word: string | undefined): AgentOptions | undefined {
  if (word === undefined) return undefined
  const text = word.trim()
  if (text.length === 0) return undefined
  const at = text.indexOf('/')
  if (at > 0 && at < text.length - 1) {
    return { provider: text.slice(0, at), model: text.slice(at + 1) }
  }
  return { model: text }
}

/** One winning catalog entry, as much of it as the diagnostic reads. */
export interface SkillSummaryReading {
  readonly name: string
  readonly provider: string
  readonly source: string
  readonly path?: string
}

/** The part of DSH's skill service this half uses: one catalog read in a given view; every other member is somebody else's contract. */
export interface SkillCatalogPort {
  list(options?: {
    readonly cwd?: string | undefined
    readonly scope?: unknown
  }): Promise<readonly SkillSummaryReading[]>
}

/**
 * The host facts the skills step reads, as a narrow face rather than the whole context: the catalog
 * to read back through, a logger, and the lifecycle seam an unload's undo hangs on.
 */
export interface SkillHostContext {
  readonly skills?: SkillCatalogPort | undefined
  readonly logger?: Logging | undefined
  readonly effect?: EffectFace | undefined
}

/** The host's own skill catalog and logger, fetched structurally rather than declared as dependencies. */
export function skillHostOf(ctx: Context): SkillHostContext {
  const skills = serviceOf(ctx, 'skills')
  const logger = (ctx as { logger?: Logging }).logger
  return {
    ...(skills === undefined ? {} : { skills: skills as unknown as SkillCatalogPort }),
    ...(logger === undefined ? {} : { logger }),
  }
}

/**
 * One dynamic runtime-context contribution, as DSH's prompt service takes it.
 *
 * The fields are the service's own; `text` may be a provider, and that provider is called
 * synchronously at assembly and again at request admission (`refreshContext`), which is why the
 * caller behind it reads a value it already holds rather than a file it would have to await.
 */
export interface PromptContextContribution {
  readonly name: string
  /** Where this contribution sits among the others: ascending, the service's own order numbers. */
  readonly order: number
  readonly text: string | ((context: unknown) => string)
}

/** The runtime-context half of the host's prompt service: one registration, one disposer. */
export interface PromptContextPort {
  context(contribution: PromptContextContribution): () => void
}

/**
 * DSH's prompt service, when this host mounts one.
 *
 * The injection is an optional contribution: a deployment without the service (a headless
 * composition, an older host) simply has no runtime context to add, and the rest of this half runs
 * as it did. Fetched structurally like every other service in this file — the plugin never declares
 * it as a requirement, so its absence cannot hold `apply` back.
 */
export function promptContextPortOf(ctx: Context): PromptContextPort | undefined {
  const held = serviceOf(ctx, 'systemPrompt')
  const register = memberOf(held, 'context')
  if (held === undefined || register === undefined) return undefined
  return {
    context(contribution: PromptContextContribution): () => void {
      const off = register.call(held, contribution)
      return typeof off === 'function' ? (off as () => void) : () => undefined
    },
  }
}

/**
 * Which sessions have a live agent in this host right now: the registry's own list, ids only. `null`
 * when this host exposes no agent registry — a host that cannot say does not claim every session is
 * gone.
 */
export function aliveAgentIds(ctx: Context): readonly string[] | null {
  const agents = agentsOf(ctx) as { list?: () => unknown } | undefined
  if (typeof agents?.list !== 'function') return null
  try {
    const ids: string[] = []
    /* The session identity sits on the agent's own `id` (the DSH agent contract spells
     * `Agent { readonly id: SessionId }`; there is no `sessionId` field to read). Reading any other
     * field would filter every live agent out and answer "no live sessions" while the registry is up —
     * an answer the stranded judgment would take as "gone". */
    for (const agent of agents.list() as readonly { id?: unknown }[]) {
      const id = typeof agent?.id === 'string' ? agent.id : ''
      if (id.length > 0) ids.push(id)
    }
    return ids
  } catch {
    return null
  }
}

/**
 * Resolve the workspace root from the session identity: ask the live session first, and only if there
 * is no live session header consult the persisted one; when neither has a cwd (including a session
 * nobody recognizes), fall back to the root recorded by the sandbox policy. The workspace file
 * gateway's own resolution follows the same order, so the root resolved here is the same one it reads
 * files from.
 */
export async function workspaceRootOf(ctx: Context, sessionId: SessionId): Promise<string> {
  const live = ctx.sessions.get(sessionId)?.header
  const stored = live === undefined ? await ctx.get('sessionPersistence')?.stat(sessionId) : undefined
  const cwd = (live ?? stored?.header)?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return ctx.sandboxPolicy.workspaceRoot
}

/** The logger a real host carries, fetched structurally; its levels fall back in the order the hosts differ: asked, warn, error, info. */
export function loggerOf(ctx: unknown): LogFace | undefined {
  const held = (ctx as { logger?: Logging } | undefined)?.logger
  if (held === undefined || held === null || typeof held !== 'object') return undefined
  return {
    write(level: LogLevel, line: string): void {
      const write = held[level] ?? held.warn ?? held.error ?? held.info
      if (write === undefined) return
      try {
        write.call(held, line)
      } catch {
        /* The logger is the composition's, not ours: one that throws must not take the line down. */
      }
    },
  }
}

/** One line through the host's logger at `level`, when it carries one; nothing happens when it does not. */
export function logLineOf(ctx: unknown, level: LogLevel, line: string): void {
  loggerOf(ctx)?.write(level, line)
}

/** The event surface, when this host carries one; a stand-in without `on` takes no listeners and the callers answer as if unsubscribed. */
export function busOf(ctx: Context): BusFace | undefined {
  const on = (ctx as unknown as { on?: unknown }).on
  if (typeof on !== 'function') return undefined
  return {
    on(event: string, listener: (...args: never[]) => unknown): unknown {
      return (on as (event: string, listener: (...args: never[]) => unknown) => unknown).call(ctx, event, listener)
    },
  }
}

/** The lifecycle seam this line's undos hang on, bound to the context that owns it; absent on a stand-in, which keeps its listeners unowned. */
export function effectOf(ctx: unknown): EffectFace | undefined {
  const effect = (ctx as { effect?: unknown } | undefined)?.effect
  if (typeof effect !== 'function') return undefined
  return (make, label) => (effect as EffectFace).call(ctx, make, label)
}

/** An error's own words, or its string form: the one spelling of "say what was refused" in this half. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
