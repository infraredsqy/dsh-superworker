/**
 * Every reach into the host context, in one file.
 *
 * This half declares four services as inject requirements (`workspaceFiles`, `sessions`,
 * `sandboxPolicy`, `tools`); everything else it touches — the agent registry, the preset roster, the
 * workspace registry, the skills catalog, the default model, the prompt service (the runtime-context
 * channel), the logger, the event bus, the effect seam, the folder the issue pool's weight table is
 * read from — may or may not be mounted, so each is
 * fetched structurally by name and anything answering
 * another shape counts as absent. That decision is made here, once per service: a module reads the
 * seam it needs and never spells `(ctx as {...})` itself, so a host shape change lands in one place
 * and a new optional service is one more function.
 *
 * Two shapes are deliberately narrow. {@link LogFace} is one verb with a fallback order, because the
 * hosts in front of us carry any subset of the three levels. {@link EffectFace} is the lifecycle seam
 * an unload's undo hangs on, taken as a callback rather than read off the context by each caller.
 *
 * The workspace root — "which tree does this session work in" — is the one fact every module here
 * asks, so it is answered here too: one resolution ({@link workspaceRootOf}) over one enumerated
 * fallback order, and one canonical spelling ({@link canonicalRootOf}). A module states which door it
 * is through the question it asks, never by carrying a fallback order of its own.
 */
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for these services live on the package entries; type-only, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PANEL_PREF_FIELDS } from './settings-fields.ts'

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

/** A string that really names a place; anything else (an empty string, a number, nothing) names none. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The other reading this half has of "this value names a place": whatever `.length` reads `> 0` off,
 * which is the property read HEAD's consult open made of its argument (`workspaceRoot.length > 0`).
 *
 * A name by this reading is not a path — an array, a boxed string, a `{ length: 1 }`, a `Uint8Array`
 * — and the resolver refuses it below exactly as it refuses any other name that is not a directory.
 * That refusal is the answer; what must not happen is the value being read as "nobody named a root",
 * which would drop the order onto the calling session's own workspace.
 *
 * The comparison is spelled the way that door spelled it, as a property read compared with `>`, so a
 * length that is not a number but compares greater than zero answers here as it answered there.
 */
function namedIfLonger(value: unknown): unknown {
  const length = (value as { readonly length?: unknown }).length
  return (length as number) > 0 ? value : undefined
}

/**
 * What one question's `named` settled to.
 *
 * `handed` is the half a value cannot carry: a root a door was handed is kept verbatim and nothing
 * below it is consulted, and a handed `undefined` is *that* — a root no resolver can use — rather
 * than "nobody named one". Stating the two apart is what keeps the order from falling through to the
 * session side on an argument somebody did hand over.
 */
interface NamedRoot {
  readonly handed: boolean
  readonly value: string | undefined
}

/**
 * The reading of `named`, taken once, under the fields that say which one a door means.
 *
 * `emptyNamed: 'root'` — the dispatch relay and the node opener — means "the thing I was handed is the
 * root", so **the field being present** is the whole criterion: never the value's type, and never its
 * usability. `''`, `null`, a number and an explicit `undefined` all ride verbatim into
 * {@link canonicalRootOf}, whose `realpath` refuses them, and that refusal is exactly what these doors
 * answered before this seam existed. Filtering on `typeof value === 'string'` is the one thing this
 * must never do: a value that is not a string would read as "nobody named a root", the order would fall
 * through to this session's own workspace, and a call that named no usable root would open a session
 * in — and land a claim on — a tree it never named.
 *
 * The default `'unnamed'` reading — the panel's endpoints — is the other way round: a name is a
 * non-empty string, so anything else is not one and the order moves on to `cwd` and the session side
 * (`namedOf: 'non-empty'`).
 *
 * `namedOf` is the criterion itself, and it is the third axis rather than part of `emptyNamed`: what
 * a door reads an **empty** name as and what it reads a **non-string** as are two different
 * questions, and the consult open answers them differently from the panel's endpoints. Its
 * `'length'` setting is HEAD's own read (`workspaceRoot.length > 0`), which counts an array, a boxed
 * string and a `{ length: 1 }` as names and hands them on — see
 * {@link WorkspaceRootQuestion.namedOf} for which door states which one.
 *
 * `absentNamed` then splits the one value neither reading can treat alike: a `named` that is `null` or
 * `undefined` is a value that is not there at all, as opposed to a value that is there and is not a
 * path (`42`, `''`). See {@link WorkspaceRootQuestion.absentNamed} for the two answers — and note it
 * is asked **before** either criterion, because both of them read a property off the value and that
 * read is what a door refusing one must never perform.
 *
 * The value is cast to the doors' own `string` here, once: the wire delivers whatever a caller sent,
 * and this is the single place the two part, so no door has to spell the cast or the lie.
 */
function namedRootOf(question: WorkspaceRootQuestion): NamedRoot {
  if (question.emptyNamed === 'root') {
    return { handed: 'named' in question, value: question.named as string | undefined }
  }
  if (question.named === null || question.named === undefined) {
    /* A root that is not there at all, at a door that refuses one: the throw is caught by that door
     * (the consult open) and answered as its `open-failed`, which is the answer it gave before this
     * seam existed — it read `.length` off the value, and that read threw. */
    if (question.absentNamed === 'refuse') {
      throw new Error(`the workspace root handed to this open is ${question.named === null ? 'null' : 'undefined'}: there is no directory in it to open at`)
    }
    return { handed: false, value: undefined }
  }
  const value = question.namedOf === 'length' ? namedIfLonger(question.named) : nonEmpty(question.named)
  return { handed: value !== undefined, value: value as string | undefined }
}

/** One session header, as far as this file reads one. */
type HeaderLike = { readonly cwd?: unknown }

/** The tree one session works in, as the one seam answers it. */
export interface WorkspaceRoot {
  /**
   * The root the question's order lands on, in the spelling the question carried: the root a caller
   * named, the cwd a session header holds, or the sandbox policy's root. A door that answered this
   * spelling before still takes this half, so its answer is the same string it was.
   */
  readonly root: string
  /**
   * The same root in the one canonical spelling, taken on demand.
   *
   * A member answering a promise rather than a second string, because the doors that only read (the
   * gateway's endpoints, the agent-facing tool) must not start paying a filesystem call for a half
   * they discard, and because one of the two readers the host asks synchronously cannot await one at
   * all.
   */
  canonicalRoot(): Promise<string>
}

/**
 * One workspace root in its canonical spelling: the `realpath` of what the caller named, or the name
 * itself when that cannot be resolved (the path does not exist yet, or the platform refuses the call)
 * — a spelling is not worth refusing an open over.
 *
 * The installed workspace layer compares the session header's `cwd` against the record it holds after
 * resolving both: macOS's `/tmp` → `/private/tmp`, a symlinked home, a Windows short (8.3) name or
 * another case are all the same workspace in different letters. Taking this once, at the entry, is
 * what keeps the queue key, the `create()` call and `meta.cwd` one spelling: a second spelling of one
 * root would otherwise queue a second line and fail its attach only after the session was minted.
 */
export async function canonicalRootOf(root: string): Promise<string> {
  try {
    return await realpath(root)
  } catch {
    return root
  }
}

/**
 * The one question this half asks about a workspace root, and the one place its answer is settled.
 *
 * Every door asks it — the wake's step condition, the instruction injection, the gateway's endpoints,
 * the dispatch relay, the session opener and the agent-facing tool — and what used to be a fallback
 * order per door is now the fields below:
 *
 * - a door that was handed a root names it in `named`, and a named root wins over everything read off
 *   the session: which workspace a reader is looking at has nothing to do with which one the session
 *   sits in, and that is the whole point of the panel's selector;
 * - what an **empty** string in `named` is, is the door's own answer — not the seam's. The panel's
 *   endpoints read `''` as *not named* (the selector hands it back to mean "this session's own
 *   workspace"), while the dispatch relay and the node opener take the root they were handed as it
 *   came, empty included, and refuse an empty one exactly as they did before this seam existed. That
 *   difference is `emptyNamed` below; it is not a fallback order of its own and no door may spell it
 *   at its call site;
 * - what counts as a **name** in the first place is the door's own answer too, and the doors did not
 *   agree before this seam: the panel's endpoints asked "is this a non-empty string", while the
 *   consult open asked "does `.length` read greater than zero" — a property read, so a non-string
 *   carrying a length was a name there. Levelling the two out is what three rounds of this change got
 *   wrong in three different shapes (an empty string, then `undefined`/`null`/a number, then a
 *   `{ length: 1 }`). That criterion is `namedOf` below; a door that was handed its root
 *   unconditionally states neither, because the field's presence is the whole of it;
 * - a door that already holds a cwd off the object in its hand passes it as `cwd`, read before any
 *   service is asked (the wake reads it off the step's own agent);
 * - a door that cannot await says `synchronous: true`, and its answer stops at the live session
 *   store: the persisted header is a disk read, and those two readers run inside a step proposal and
 *   inside a synchronous context provider;
 * - a door holding **no identity at all** — no root named, no cwd, no session to ask under — either
 *   falls through to the sandbox policy's root or answers "nothing at all", stated as `sessionless`
 *   (see {@link SynchronousWorkspaceRootQuestion}: the step condition is the one door that answers
 *   "nothing").
 *
 * The order itself, spelled once here: `named` → `cwd` → the live session's header → the persisted
 * session's header → the sandbox policy's root. The persisted header is consulted only when the live
 * store knows no such session at all: a live session whose header carries no cwd has already
 * answered, and asking the disk after it would let a stale record contradict the running session. The
 * last step is the one `sessionless` governs.
 */
export interface WorkspaceRootQuestion {
  /** The session whose root is asked for. */
  readonly sessionId?: string | undefined
  /** A root the caller was handed; see `emptyNamed` and `namedOf` for what this door makes of it. */
  readonly named?: string | undefined
  /**
   * What an empty `named` is at this door:
   *
   * - `'unnamed'` (the default, and what the panel's endpoints answer): not a name at all, so the
   *   order moves on to `cwd` and the session side;
   * - `'root'` (the dispatch relay and the node opener): a root like any other, used as it came. An
   *   empty string is then the empty root — what those doors were handed, and refused, before this
   *   seam existed.
   */
  readonly emptyNamed?: 'unnamed' | 'root'
  /**
   * What counts as a name at a door reading the default `'unnamed'` way — the criterion itself, which
   * HEAD spelled differently at different doors and which no one reading may level out:
   *
   * - `'non-empty'` (the default, and what the panel's six endpoints answer): a name is a non-empty
   *   string, so a value of any other type is not one and the order moves on to `cwd` and the session
   *   side. This is what `rootFor` read (`typeof workspaceRoot === 'string' && workspaceRoot.length > 0`);
   * - `'length'` (the consult open): a name is whatever `.length` reads greater than zero off — which
   *   is HEAD's `workspaceRoot.length > 0`, a **property read**, so an array, a boxed string, a
   *   `{ length: 1 }` and a `Uint8Array` are all names there and are handed on to the resolver, which
   *   refuses them exactly as it refused them before this seam. Reading that value as "not named"
   *   would drop the order onto the calling session's own workspace: a session opened on a tree
   *   nobody named, which is the one thing this door's refusal exists to prevent.
   *
   * Both readings are asked only of a value that is **there**: `null` and `undefined` are settled by
   * `absentNamed` first, since reading a property off either is the throw that door answers.
   *
   * A door that was handed its root unconditionally — the relay's three entries and the node opener —
   * states `emptyNamed: 'root'` and needs no criterion at all: the field's presence is the whole of it.
   */
  readonly namedOf?: 'non-empty' | 'length'
  /**
   * What a `named` that is not there at all — `null` or `undefined`, as opposed to a value that is
   * there and is not a path (`''`, `42`) — is worth at a door reading the default `'unnamed'` way:
   *
   * - `'fall-through'` (the default, and what the panel's endpoints answer): not a name, so the order
   *   moves on to `cwd` and the session side, exactly as those doors read it before this seam;
   * - `'refuse'` (the consult open): the open refuses, which is what that door answered before this
   *   seam existed — it read `.length` off the value, and that read threw into the refusal it returns.
   *   An open handed a root it cannot even read must not quietly open a session at the calling
   *   session's workspace instead: that is a record written on a tree nobody named.
   *
   * This is an axis of its own, never a third `emptyNamed`: `'unnamed'` still treats `''` and `42` as
   * "not a name" and moves on, which is what the consult open answered for both before this seam.
   */
  readonly absentNamed?: 'fall-through' | 'refuse'
  /** A cwd the caller already holds off the object in its hand; anything but a non-empty string names nothing. */
  readonly cwd?: unknown
}

/**
 * The question in the form the two readers the host asks without awaiting a turn can take: a step's
 * tool condition and a runtime-context provider. Its answer is the plain root, and `undefined` means
 * this host cannot name a workspace at all.
 */
export interface SynchronousWorkspaceRootQuestion extends WorkspaceRootQuestion {
  readonly synchronous: true
  /**
   * What a question that names **no session at all** is worth at this door — no `sessionId`, and
   * nothing named or held (`named`/`cwd` both empty or absent). A question that does name a session
   * the store knows nothing about is not this case: it still falls through to the sandbox root.
   *
   * - `'sandbox'` (the default, and what the injection's provider answers): the order goes on to the
   *   sandbox policy's root, as that door always read it;
   * - `'none'` (the wake's step condition): no root at all, because a step whose workspace nobody
   *   named is not a step this line can place. That has been this door's answer since it read the
   *   two facts itself; it is a field here rather than a guard at the call site, which would be one
   *   door carrying a fallback order of its own.
   */
  readonly sessionless?: 'sandbox' | 'none'
}

/** What the session side of the order answered: the root it could name, and the live header it read. */
interface SessionSideRoot {
  /**
   * Whether this stretch answered at all — and the answer may be a root no resolver can use. A door
   * handed `undefined` is answered `undefined`, and `root` alone cannot say that apart from "nothing
   * here answered, go on to the persisted header and the sandbox root".
   */
  readonly handed: boolean
  readonly root: string | undefined
  /** The live header, when the store knew this session — what tells "no live session" from "a live session with no cwd". */
  readonly live: HeaderLike | undefined
}

export function workspaceRootOf(ctx: Context, question: SynchronousWorkspaceRootQuestion): string | undefined
export function workspaceRootOf(ctx: Context, question: WorkspaceRootQuestion): Promise<WorkspaceRoot>
export function workspaceRootOf(
  ctx: Context,
  question: WorkspaceRootQuestion & { readonly synchronous?: true; readonly sessionless?: 'sandbox' | 'none' },
): string | undefined | Promise<WorkspaceRoot> {
  /* The two forms read the live session store differently, because they always have: the
   * asynchronous doors ask the service this context provides (a host that carries none has its open
   * refuse, which is an answer those doors already gave), while the synchronous ones read it
   * structurally (a stand-in with no session service at all is a host that knows no session, not a
   * broken one — and neither reader may throw into a step proposal or an assembly). Both forms were
   * written that way before this seam existed, and neither is this change's to alter. */
  const synchronous = question.synchronous === true
  const side = sessionSideRootOf(ctx, question, synchronous)
  if (synchronous) {
    /* A handed root ends the order here, even when it is `undefined`: the door was handed that and
     * nothing below it is consulted. Nothing is asked of the sandbox root or `sessionless` on its
     * behalf — those answer for a question that named and held nothing. */
    if (side.handed) return side.root
    /* Nothing from the cwd or the live header. `sessionless` speaks only for a question that named
     * no session at all; one that named a session the store cannot place keeps falling through to
     * the sandbox root, which is where both synchronous readers have always ended. */
    if (question.sessionless === 'none' && question.sessionId === undefined) return undefined
    return sandboxRootIfAny(ctx)
  }
  return settledRootOf(ctx, question, side)
}

/**
 * The session-side stretch of the order, shared by both forms: what the caller named, what it already
 * holds, and what the live store says. Neither of the first two costs a service call, so a door that
 * was handed a root never touches the session store at all.
 *
 * `named` is read by {@link namedRootOf}, once: a door that was handed a root skips the rest of this
 * stretch altogether — whatever the value was, since a root nobody can resolve is still the root that
 * door was handed — and a door that was not moves on to `cwd` and the session side.
 * @param structural - Whether the live store is read structurally (see {@link workspaceRootOf}).
 */
function sessionSideRootOf(ctx: Context, question: WorkspaceRootQuestion, structural: boolean): SessionSideRoot {
  const named = namedRootOf(question)
  /* The cast is the one place the doors' `string` and the wire's any-value part: a handed root is
   * kept verbatim, and the resolver refuses it downstream exactly as that door's own root was got
   * before this seam. Naming it here keeps every door from spelling the same lie. */
  if (named.handed) return { handed: true, root: named.value as string, live: undefined }
  const spoken = nonEmpty(question.cwd)
  if (spoken !== undefined) return { handed: true, root: spoken, live: undefined }
  if (question.sessionId === undefined) return { handed: false, root: undefined, live: undefined }
  const live = structural
    ? liveHeaderIfAny(ctx, question.sessionId)
    : ctx.sessions.get(question.sessionId as SessionId)?.header
  const held = nonEmpty(live?.cwd)
  return { handed: held !== undefined, root: held, live }
}

/**
 * The asynchronous finish: the persisted header — only for a session the live store does not know —
 * and then the sandbox policy's root, read as the inject requirement it is, so a host that lost it
 * has its open refuse with that reason rather than open at an empty path.
 */
async function settledRootOf(
  ctx: Context,
  question: WorkspaceRootQuestion,
  side: SessionSideRoot,
): Promise<WorkspaceRoot> {
  /* A handed root ends the order here, `undefined` included: the door was handed that, and the
   * persisted header or the sandbox root would be answers to a question nobody asked. */
  if (side.handed) return answered(side.root as string)
  const stored = side.live === undefined ? await persistedHeaderOf(ctx, question.sessionId) : undefined
  return answered(nonEmpty(stored?.cwd) ?? ctx.sandboxPolicy.workspaceRoot)
}

/** One answer, with its canonical spelling taken on demand (see {@link WorkspaceRoot.canonicalRoot}). */
function answered(root: string): WorkspaceRoot {
  return { root, canonicalRoot: () => canonicalRootOf(root) }
}

/**
 * The header of one live session, read structurally for the two synchronous readers: the way this
 * file reads every optional service, so a host answering nothing here knows no session rather than
 * being a broken one. A session the store knows but whose header carries no cwd comes back as that
 * header — that is what keeps the persisted one from being consulted afterwards.
 */
function liveHeaderIfAny(ctx: Context, sessionId: string | undefined): HeaderLike | undefined {
  if (sessionId === undefined) return undefined
  const sessions = (ctx as unknown as { sessions?: { get?: (id: string) => unknown } }).sessions
  if (typeof sessions?.get !== 'function') return undefined
  return (sessions.get(sessionId) as { header?: HeaderLike } | undefined)?.header
}

/**
 * The persisted session's header, when this host keeps one and knows the session; nothing when it
 * keeps none. The store answers a record whose header is the same shape the live store's carries, so
 * the two read the same field — that is what makes the two sources interchangeable in the order.
 */
async function persistedHeaderOf(ctx: Context, sessionId: string | undefined): Promise<HeaderLike | undefined> {
  if (sessionId === undefined) return undefined
  const stored = (await ctx.get('sessionPersistence')?.stat(sessionId as SessionId)) as
    | { readonly header?: HeaderLike }
    | undefined
  return stored?.header
}

/**
 * The sandbox policy's root, when this host names one, for the synchronous form: `undefined` when the
 * host carries no policy at all or names an empty root, which is "this host cannot say" rather than a
 * root. The asynchronous form reads the same field as the inject requirement it is.
 */
function sandboxRootIfAny(ctx: Context): string | undefined {
  try {
    return nonEmpty(ctx.sandboxPolicy.workspaceRoot)
  } catch {
    /* A host carrying no policy cannot name a root: the two synchronous readers answer "nothing"
     * rather than failing somebody else's step or assembly. */
    return undefined
  }
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

/**
 * The folder the issue pool's weight table is read from, when this host names one.
 *
 * The table's one home is the issue plugin's own declaration, and a normal deployment reads it out of
 * the plugin folder this package ships — that is what `undefined` means here, and it is the answer on
 * every real host. A host that names a folder is read instead, and one that names `null` runs with no
 * table at all: the same reading as a folder whose issue plugin is missing, which the panel draws by
 * withholding the gauge rather than by inventing a weight. Naming one is a test's or a diagnostic's
 * move, not a deployment's.
 *
 * Read structurally like every seam here: a host carrying no such field answers "the shipped one",
 * so this never asks a real deployment to know the field exists.
 *
 * A real Cordis context **refuses** the read rather than answering `undefined`: its proxy throws
 * `cannot get property "<name>" without inject` for any name no service declares, and this one is a
 * field, never a service. That refusal is the same answer as an absent field — and it is the answer
 * every deployment gives — so it is caught here. Letting it escape would fail `apply` itself: the
 * line would not activate at all, and the panel would stand there with its shell and no reading.
 */
export function weightsFolderOf(ctx: unknown): string | null | undefined {
  let held: unknown
  try {
    held = (ctx as { weightsFolder?: unknown } | null | undefined)?.weightsFolder
  } catch {
    return undefined
  }
  return typeof held === 'string' || held === null ? held : undefined
}

/**
 * Whether one panel preference reads as on, off the line's resolved settings.
 *
 * The panel's switch fields are volatile: on the real host the resolved config hands them over as a
 * stable reference whose `get()` answers the current snapshot (schemastery wraps a volatile field
 * with cosmokit's `createVolatile`, and `apply(ctx, config)` receives that reference) — read at the
 * call, so a flip lands on the next read without a reload. A plain boolean (stand-ins, older hosts
 * that lack `.volatile()`) reads as it is, and an absent surface or an absent field reads as on —
 * the factory default, which every switch in this section carries.
 *
 * This is the one spelling of that read: the relay trigger and the injection switch both ask it,
 * so a change to the reading semantics cannot leave one switch behind.
 */
export function panelSwitchOn(config: unknown, field: keyof typeof PANEL_PREF_FIELDS): boolean {
  if (config === null || typeof config !== 'object') return true
  const held = (config as Record<string, unknown>)[PANEL_PREF_FIELDS[field]]
  const value = held !== null && typeof held === 'object' && typeof (held as { get?: unknown }).get === 'function'
    ? (held as { get: () => unknown }).get()
    : held
  return value !== false
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
