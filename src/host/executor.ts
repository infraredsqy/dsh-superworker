/**
 * The host half's native executor: the session that works a node is opened
 * here, by the host's own services — no external script and no
 * platform-specific shell.
 *
 * One open, in order:
 *
 * 1. probe the host's session side: the `sessions` store is an inject
 *    requirement, and a missing `agents` registry is an explicit refusal
 *    naming the piece, never silence;
 * 2. read the plan's launch prompt for this cell out of the record store —
 *    the first instruction is exactly that line, so it agrees with the plan
 *    by construction;
 * 3. create the agent and its session under the workspace root, composed
 *    through the standing agent preset when the host carries a roster (the
 *    preset's mount is what gives the session its scoped world — tools and
 *    skills; without a roster the bare open stands, as before), attach the
 *    session to that workspace when the host carries a workspace service
 *    (`cwd` alone joins nothing) — a host that answers no attachable
 *    workspace, or refuses the attach after the session is minted, leaves the
 *    session open cwd-only with one log line instead of failing an open that
 *    already has a live session in it — arm the session's `pathfinder` tool,
 *    arm the opening round's listeners, hand the prompt over as the first
 *    instruction, and note the session through the engine's writer — this side
 *    only names the entry;
 * 4. settle the opening round: hosts whose agents expose the wait interface
 *    get `whenIdle()`; older ones get the idle notification plus the
 *    turn-end events, resolved together.
 *
 * Step 3 touches the workspace (the session log's directory and the note
 * file) and runs inside a per-workspace queue, so two opens aimed at one
 * workspace create their sessions strictly one after another and their notes
 * never interleave mid-write. The listeners are armed before the first
 * instruction goes in: a loop that finishes its round instantly must not
 * outrun its own settlement. The settlement wait runs outside the queue: a
 * slow first round must not hold the next open of the same workspace
 * hostage.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for `agents` and the agent events live on the package entries; type-only, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { RECORD_DIR } from './contract.ts'
import type { PfFailure, PfRefusalCode } from './failure.ts'
import { isAbsent, readWholeFile, type PathfinderScope } from './records.ts'
import { noteOpenedSession } from './session-note.ts'
import { confirmSkillsForWorkspace, reportSkillView } from './skills.ts'
import { wakeAgent } from './tool.ts'
import type { SkillCatalogPort, SkillHostContext } from './skills.ts'

/** What one open brought back: the session now working this node. The id is an address for the panel's navigation, not a word a reader is shown. */
export type SessionOpenOutcome =
  | { readonly ok: true; readonly session: string }
  | { readonly ok: false; readonly code: PfRefusalCode; readonly detail?: string }

/** Options an in-process caller may hand an open; over the wire the open runs to its own end. */
export interface SessionOpenOptions {
  /** Stops the settlement wait; the session and its note stay whatever this decides. */
  readonly signal?: AbortSignal
  /**
   * The model route this session opens with (`provider/model`, as the engine carries it): the
   * dispatch's own name comes down here, and the engine has already resolved the call > line policy >
   * machine-switch order. Absent leaves the deployment's own default in force.
   */
  readonly model?: string
  /**
   * Runs once the session is minted and alive, before its first instruction
   * goes in — the earliest point a caller can start watching it, ahead of
   * every event the opening round will emit (the round may settle before this
   * open returns, so a watcher that registers on the return never sees the
   * round's own turn end). Best effort: a throwing hook does not fail the open.
   */
  readonly onOpened?: (session: string) => void
}

/**
 * One record-directory segment, guarded at the one place it becomes a path:
 * an empty id, a self or parent segment, or anything outside the record
 * tree's own character set would address a file outside that cell's own
 * place. The refusal is this record-path guard's own code (`arg-not-allowed`);
 * the offending value rides as the detail.
 */
function segmentFailure(value: string): PfFailure | undefined {
  const SAFE_SEGMENT = /^[A-Za-z0-9_.:+-]{1,200}$/
  if (value.length === 0 || value === '.' || value === '..' || !SAFE_SEGMENT.test(value)) {
    return { ok: false, code: 'arg-not-allowed', detail: value }
  }
  return undefined
}

/** Which pieces of the host's session side this open needs, fetched on the spot. */
interface SessionSide {
  readonly agents: AgentRegistry
}

/**
 * The preset side of one open, as a narrow local face. The session-controller composes its own
 * sessions through the standing agent preset — the mount is what gives a session its scoped
 * world (tools, skills, the lot). This line opens the sessions that work nodes, so it composes
 * them the same way: resolve the standing preset and hand the mount in as creation-time setup.
 * The service is fetched by name and anything answering another shape counts as absent: a
 * headless composition without the roster keeps the bare open it always had.
 */
interface PresetPort {
  resolve(presetId?: string): Promise<{ readonly id: string }>
  mount(agentCtx: Context, id: string): Promise<void>
}

/** The preset roster this context carries, when it answers the shape above. */
function presetPortOf(ctx: Context): PresetPort | undefined {
  const read = (ctx as { get?: (name: string) => unknown }).get
  const held = typeof read === 'function' ? read.call(ctx, 'agentPresets') : undefined
  if (held === null || typeof held !== 'object') return undefined
  const resolve = (held as { resolve?: unknown }).resolve
  const mount = (held as { mount?: unknown }).mount
  if (typeof resolve !== 'function' || typeof mount !== 'function') return undefined
  return {
    async resolve(presetId?: string): Promise<{ readonly id: string }> {
      return (await (resolve as (presetId?: string) => Promise<unknown>).call(held, presetId)) as { readonly id: string }
    },
    async mount(agentCtx: Context, id: string): Promise<void> {
      await (mount as (agentCtx: Context, id: string) => Promise<unknown>).call(held, agentCtx, id)
    },
  }
}

/**
 * Probe the host's session side before anything else: the `sessions` store is
 * an inject requirement of this line, and an open needs the `agents` registry
 * itself — a deployment without it gets a refusal naming the piece. An open
 * that never happened must not read as one that failed halfway.
 */
function sessionSideOf(ctx: Context): SessionSide | PfFailure {
  const agents = ctx.get('agents')
  if (agents === undefined || agents === null) return { ok: false, code: 'no-session-service', detail: 'agents' }
  return { agents: agents as AgentRegistry }
}

/**
 * The workspace side of one open, as a narrow local face. The installed host
 * exposes a workspace registry: `create` answers the entity for a canonical
 * path (repeating it for the same path answers the same entity unchanged), and
 * `attachSession` is what joins a live session to it. Neither is a declared
 * dependency of this line — a headless composition mounts no workspace layer —
 * so the service is fetched by name and anything that answers another shape
 * counts as absent.
 */
interface WorkspacePort {
  attachSession(session: SessionId): Promise<void>
}

interface WorkspaceRegistryPort {
  /** The workspace at one canonical path; `undefined` when the entity names no `attachSession`. */
  create(path: string): Promise<WorkspacePort | undefined>
}

/** The workspace registry this context carries, when it answers the shape above. */
function workspaceRegistryOf(ctx: Context): WorkspaceRegistryPort | undefined {
  const read = (ctx as { get?: (name: string) => unknown }).get
  const held = typeof read === 'function' ? read.call(ctx, 'workspaceRegistry') : undefined
  if (held === null || typeof held !== 'object') return undefined
  const create = (held as { create?: unknown }).create
  if (typeof create !== 'function') return undefined
  return {
    async create(path: string): Promise<WorkspacePort | undefined> {
      const workspace = await (create as (path: string) => Promise<unknown>).call(held, path)
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

/** The logging face this open reads; every level is optional, like the skill host's. */
interface LogPort {
  info?(line: string): void
  warn?(line: string): void
}

/** One line through the host's logger, when it carries one; a logger that throws never takes the open down. */
function logLine(ctx: Context, line: string): void {
  const held = (ctx as { logger?: LogPort }).logger
  if (held === undefined || held === null) return
  const write = held.warn ?? held.info
  if (write === undefined) return
  try {
    write.call(held, line)
  } catch {
    /* The logger is the composition's, and the open has its own answer to give. */
  }
}

/** Say that the session is open and stays un-attached, naming the cell and the workspace it missed. */
function reportUnattached(ctx: Context, cycle: string, node: string, root: string, reason: string): void {
  logLine(ctx, `could not attach the session opened for ${cycle}/${node} to the workspace at ${root}: ${reason}; the session stays cwd-only`)
}

/**
 * The model selection a fresh session opens with: the route the dispatch named when it named one,
 * else the deployment's current choice (the same one a session opened through the host's own surface
 * gets). The service that knows the default is asked for by name on the spot, structurally — a host
 * without it (or one whose answer cannot be read) omits the selection and the loop's own defaults apply.
 *
 * The route arrives in the ecosystem's spelling, `provider/model`, carried whole by the engine: the
 * split happens here, at the one place that hands it to the session. A route with no slash is read as
 * the model alone (the host's own default provider), which is what a bare model word means elsewhere.
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

function modelSelectionOf(ctx: Context, named?: string): AgentOptions | undefined {
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
 * The per-workspace queue: opens aimed at one workspace hold its line one at
 * a time, whatever the previous open answered — a refusal must not poison
 * the line for the next open. One process, one queue: two gateway instances
 * in the same host would still be writing the same directories.
 */
const queues = new Map<string, Promise<unknown>>()

function inLine<T>(root: string, step: () => Promise<T>): Promise<T> {
  const ahead = queues.get(root) ?? Promise.resolve()
  const mine = ahead.then(step, step)
  queues.set(root, mine.then(() => undefined, () => undefined))
  return mine
}

/**
 * One workspace root in its canonical spelling: the `realpath` of what the caller named, or the
 * name itself when that cannot be resolved (the path does not exist yet, or the platform refuses
 * the call) — a spelling is not worth refusing an open over.
 *
 * The installed workspace layer compares the session header's `cwd` against the record it holds
 * after resolving both: macOS's `/tmp` → `/private/tmp`, a symlinked home, a Windows short (8.3)
 * name or another case are all the same workspace in different letters. Taking this once, at the
 * entry, is what keeps the queue key, the `create()` call and `meta.cwd` one spelling: a second
 * spelling of one root would otherwise queue a second line and fail its attach only after the
 * session was already minted.
 */
export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  try {
    return await realpath(root)
  } catch {
    return root
  }
}

/** Why an open stopped after (or without) a session: the reason rides verbatim as the refusal's detail. */
function openFailure(reason: string): { ok: false; code: PfRefusalCode; detail: string } {
  return { ok: false, code: 'open-failed', detail: reason }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The host's own skill catalog and logger, fetched structurally rather than declared as
 * dependencies: this line loads on hosts that mount no skill service, and the session-view
 * diagnostic on such a host refuses (naming the missing service) instead of claiming anything about
 * a catalog.
 */
function skillHostOf(ctx: Context): SkillHostContext {
  const read = (ctx as { get?: (name: string) => unknown }).get
  const skills = typeof read === 'function' ? (read.call(ctx, 'skills') as SkillCatalogPort | undefined) : undefined
  const logger = (ctx as { logger?: SkillHostContext['logger'] }).logger
  return {
    ...(skills === undefined || skills === null ? {} : { skills }),
    ...(logger === undefined ? {} : { logger }),
  }
}

/**
 * Open the session that works one node, and settle its opening round.
 *
 * The plan's launch prompt (`<pf>/meta/launch/<line>/<node>/prompt.txt`) is
 * the first instruction, read verbatim out of the record store; the note
 * naming the session is written by this side once the session exists. See
 * the module comment for the whole order and why the queue holds only the
 * workspace-touching stretch.
 */
export async function openNodeSession(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  cycle: string,
  node: string,
  options?: SessionOpenOptions,
): Promise<SessionOpenOutcome> {
  const side = sessionSideOf(ctx)
  if ('code' in side) return side
  const named = segmentFailure(cycle) ?? segmentFailure(node)
  if (named !== undefined) return named

  /* One canonical spelling, taken once here: the record reads/writes below, the queue this open
   * joins, the `create()` call and the workspace it is attached to all name the same directory —
   * whatever letters the caller used. */
  const root = await canonicalWorkspaceRoot(workspaceRoot)

  const signal = options?.signal ?? new AbortController().signal
  const scope: PathfinderScope = { sessionId, workspaceRoot: root }
  let prompt: string
  try {
    prompt = await readWholeFile(ctx.workspaceFiles, scope, `${RECORD_DIR}/meta/launch/${cycle}/${node}/prompt.txt`, signal)
  } catch (error) {
    if (isAbsent(error)) return { ok: false, code: 'prompt-missing', detail: `${cycle}/${node}` }
    return openFailure(messageOf(error))
  }
  if (prompt.trim().length === 0) return { ok: false, code: 'prompt-missing', detail: `${cycle}/${node}` }

  /* The session identity is this host's own mint, spelled the way the host spells its own: `session-` + a fresh uuid. The brand is a compile-time fact; the string is what crosses. */
  const opened = `session-${randomUUID()}` as SessionId
  const selection = modelSelectionOf(ctx, options?.model)

  /* The standing preset this open composes through: the mount is what gives the session its
   * scoped world (tools, skills). A roster that cannot resolve its own default is an open
   * refusal naming the reason, not a bare session that can do nothing. */
  const presets = presetPortOf(ctx)
  let standing: { readonly id: string } | undefined
  let mount: AgentSetup | undefined
  if (presets !== undefined) {
    try {
      standing = await presets.resolve(undefined)
    } catch (error) {
      return openFailure(messageOf(error))
    }
    const id = standing.id
    mount = (agentCtx) => presets.mount(agentCtx, id)
  }

  /* The workspace-touching stretch, queued: create the session under the root, join it to that one workspace, arm the round's listeners, hand the prompt over, then note the session while the line still holds. */
  let settlement: Settlement
  try {
    settlement = await inLine(root, async () => {
      const handle = await side.agents.create({
        sessionId: opened,
        meta: { cwd: root, ...(standing === undefined ? {} : { agentPreset: standing.id }) },
        ...(selection === undefined ? {} : { agentOptions: selection }),
        ...(mount === undefined ? {} : { setup: mount }),
      })
      /* A host with a workspace layer owns the grouping: the session is attached to the entity of the root, which is the call that puts it in that workspace. A composition without the layer keeps the cwd-only open. */
      const registry = workspaceRegistryOf(ctx)
      try {
        const workspace = registry === undefined ? undefined : await registry.create(root)
        if (workspace === undefined) {
          reportUnattached(
            ctx,
            cycle,
            node,
            root,
            registry === undefined
              ? 'this host exposes no workspace service'
              : 'this host\'s workspace service answered no attachable workspace',
          )
        } else {
          await workspace.attachSession(opened)
        }
      } catch (error) {
        /* The session is already minted: the host refused the grouping after the fact. The open
         * goes on cwd-only — the first instruction and the note below still land, so the session
         * has its record and the panel keeps its cell — and one log line says which cell and which
         * workspace missed the grouping, with the host's own reason. Failing here would leave a
         * live session nobody wrote down. */
        reportUnattached(ctx, cycle, node, root, messageOf(error))
      }
      const armed = armSettlement(ctx, handle.agent, opened)
      /* Arm the session's own tool before the first instruction goes in: the wake's event
       * paths cannot see a dispatched session — `agent/pre-step` carries no agent in its
       * payload, and the pipeline skills are not model-invocable, so no skill-tool load can
       * ever carry them. The opener knows the agent it just minted, so it arms it here,
       * before the first step's tool set resolves. */
      wakeAgent(handle.agent, { ctx })
      /* The caller's earliest watch point: the session exists and its first instruction has
       * not gone in — registration here lands ahead of every event the opening round emits. */
      try {
        options?.onOpened?.(opened)
      } catch {
        /* A caller's registration problem is not this open's failure. */
      }
      try {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await noteOpenedSession(root, node, opened)
        /* The placement's session-side diagnostic. This is the one stretch that knows both the
         * workspace and the live session's own scope, so a same-name copy in a project root
         * (rank 100/200 — DSH's own per-workspace override, outside this node's judgement) gets a
         * name and both places in one log line rather than passing silently. Neither call can fail
         * the open: the check hands back a code and the report writes a line. This diagnostic is not
         * an acceptance reading anyone can point at — the session's own catalog is. */
        reportSkillView(skillHostOf(ctx), await confirmSkillsForWorkspace(skillHostOf(ctx), root, handle.agent))
      } catch (error) {
        armed.drop()
        throw error
      }
      return armed
    })
  } catch (error) {
    /* The session may be out already and the note missing: say so plainly instead of letting the next open run a second session on this cell. */
    return openFailure(messageOf(error))
  }

  try {
    await settlement.wait(signal)
  } catch (error) {
    settlement.drop()
    /* The wait ended without a settled round: the session is open and its note is on disk, but
     * this open cannot vouch for the round. The refusal names the cell — line and node — because
     * this sentence reaches a reader through the panel's {detail}, and a session id is an address
     * for navigation, not a word a reader is shown. */
    return openFailure(`${cycle}/${node} is open but its opening round was not seen to settle: ${messageOf(error)}`)
  }
  return { ok: true, session: opened }
}

/** The opening round's wait, once it is armed. */
interface Settlement {
  /** Wait the opening round out; the signal cuts the wait short. */
  wait(signal: AbortSignal): Promise<void>
  /** Take the listeners back down: the open failed before its round, or the wait already answered. */
  drop(): void
}

/**
 * Arm the opening round's listeners before the first instruction goes in —
 * a loop that finishes its round instantly settles while the listeners are
 * already on, not after they would have been missed. The wait adapts to the
 * host in front of us: agents that carry the wait interface answer through
 * `whenIdle()`; hosts whose agents lack it answer through the idle
 * notification (`agent/status` flipping to `idle`) together with the
 * turn-end events (`session/event` carrying `turn/end`) — both must be seen.
 * A session torn down before its first round answers nothing further: there
 * is no round left to settle.
 */
function armSettlement(ctx: Context, agent: Agent, sessionId: SessionId): Settlement {
  let turnEnded = false
  let idle = false
  let met = false
  let detached = false
  let wake: (() => void) | undefined
  const offs: (() => void)[] = []
  const detach = (): void => {
    if (detached) return
    detached = true
    for (const off of offs) off()
  }
  const answer = (): void => {
    met = true
    detach()
    const release = wake
    wake = undefined
    release?.()
  }
  offs.push(ctx.on('agent/status', (payload) => {
    if (payload.agent !== agent) return
    idle = payload.status === 'idle'
    if (turnEnded && idle) answer()
  }))
  offs.push(ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    if (event.type === 'turn/end') {
      turnEnded = true
      if (idle) answer()
    }
  }))
  offs.push(ctx.on('agent/disposed', (payload) => {
    if (payload.agent === agent) answer()
  }))
  return {
    wait(signal) {
      /* The wait interface, when the host carries it, is the whole answer: the fallback listeners stand down unused. */
      if (typeof agent.whenIdle === 'function') {
        detach()
        return raceAbort(agent.whenIdle(), signal)
      }
      /* The round may have settled while the listeners were the only ones watching: the answer is already in. */
      if (met) return Promise.resolve()
      return raceAbort(new Promise<void>((resolve) => { wake = resolve }), signal)
    },
    drop: detach,
  }
}

/**
 * Run one wait against the caller's signal: the wait's own answer wins, the
 * signal's rejection cuts in. The signal rejects with its own reason, so a
 * cancelled wait reads as a cancelled wait. A signal that already fired
 * rejects on the spot — the abort event never replays for a late listener.
 */
function raceAbort<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    let done = false
    const onAbort = (): void => settleWith(() => reject(signal.reason))
    const settleWith = (run: () => void): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      run()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    wait.then(
      (value) => settleWith(() => resolve(value)),
      (error) => settleWith(() => reject(error)),
    )
  })
}
