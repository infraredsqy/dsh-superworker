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
 * outrun its own settlement. The settlement wait — and the skill placement's
 * session-side diagnostic, which is one catalog read and can never fail the
 * open — run outside the queue: a slow first round or a slow catalog read must
 * not hold the next open of the same workspace hostage.
 *
 * The engine's own executor seam ({@link executorOf}) lives here too, beside the
 * open it drives: a dispatch's opener is this file and nothing else, and the
 * caller that wants to watch its sessions passes `onOpened` instead of wrapping
 * the open.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for `agents` and the agent events live on the package entries; type-only, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Executor } from 'pf-core'
import { LAUNCH_PROMPT_FILE, RECORD_LAUNCH } from './contract.ts'
import type { PfFailure, PfRefusalCode } from './failure.ts'
import { isAbsent, readWholeFile, type PathfinderScope } from './records.ts'
import {
  agentsOf,
  logLineOf,
  messageOf,
  modelSelectionOf,
  presetPortOf,
  skillHostOf,
  workspaceRegistryOf,
} from './seams.ts'
import { noteOpenedSession } from './session-note.ts'
import { confirmSkillsForWorkspace, reportSkillView } from './skills/view.ts'
import { wakeAgent } from './wake.ts'

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
  /**
   * The opener seam the session's own `pathfinder` tool opens through. A dispatched session arms its
   * tool before its first step; when that tool opens a session of its own (`dag open`), the opener
   * watches it the same way, so a caller passes its own seam here and the nesting keeps the watcher.
   * Absent: this module's plain {@link executorOf}, unwatched.
   */
  readonly openerOf?: (sessionId: SessionId, workspaceRoot: string) => Executor
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

/**
 * Probe the host's session side before anything else: the `sessions` store is
 * an inject requirement of this line, and an open needs the `agents` registry
 * itself — a deployment without it gets a refusal naming the piece. An open
 * that never happened must not read as one that failed halfway.
 */
function sessionSideOf(ctx: Context): AgentRegistry | PfFailure {
  const agents = agentsOf(ctx)
  if (agents === undefined) return { ok: false, code: 'no-session-service', detail: 'agents' }
  return agents
}

/** Say that the session is open and stays un-attached, naming the cell and the workspace it missed. */
function reportUnattached(ctx: Context, cycle: string, node: string, root: string, reason: string): void {
  logLineOf(ctx, 'warn', `could not attach the session opened for ${cycle}/${node} to the workspace at ${root}: ${reason}; the session stays cwd-only`)
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

/**
 * The engine's executor seam for one dispatch: the native opener hung on the engine.
 *
 * The engine hands the request over after its own gates and preparation; the opener reads the
 * prompt it landed and creates the session. A refusal throws — the engine then writes no claim and
 * hands the reason back as the dispatch's own refusal detail. A caller that wants to watch the
 * sessions this seam opens hands `onOpened` in; the open calls it the moment a session is minted.
 *
 * A request that carries `dryRun` is a drill: the call is answered with a receipt that says so and
 * nothing is opened here — no agent, no note. The receipt carries no session id, which is also what
 * keeps a watcher's table from treating a rehearsal as one of its own live sessions.
 */
export function executorOf(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  onOpened?: (session: string) => void,
): Executor {
  return {
    async dispatch(request) {
      const cycle = request.cycle ?? ''
      const node = request.node ?? ''
      if (cycle.length === 0 || node.length === 0) {
        throw new Error('the dispatch request named no cell (cycle and node are both required here)')
      }
      if (request.dryRun === true) return { host: 'drill' }
      /* The seam this opener hands its sessions own tools: this one, with the same watcher, so a
       * session opened from a tool call is watched by whoever watched the session that called it. */
      const openerOf = (id: SessionId, at: string) => executorOf(ctx, id, at, onOpened)
      const outcome = await openNodeSession(ctx, sessionId, workspaceRoot, cycle, node, {
        ...(onOpened === undefined ? {} : { onOpened }),
        openerOf,
        ...(request.model === undefined ? {} : { model: request.model }),
      })
      if (!outcome.ok) throw new Error(outcome.detail ?? outcome.code)
      return { sessionId: outcome.session, host: 'dsh' }
    },
  }
}

/**
 * Open the session that works one node, and settle its opening round.
 *
 * The plan's launch prompt (`<launch>/<line>/<node>/<file>`) is the first
 * instruction, read verbatim out of the record store; the note naming the
 * session is written by this side once the session exists. See the module
 * comment for the whole order and why the queue holds only the
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
    prompt = await readWholeFile(ctx.workspaceFiles, scope, `${RECORD_LAUNCH}/${cycle}/${node}/${LAUNCH_PROMPT_FILE}`, signal)
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
  let agent: Agent
  try {
    const lane = await inLine(root, async () => {
      const handle = await side.create({
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
       * before the first step's tool set resolves. The opener seam the tool may call back
       * through is this file's own `executorOf`: a word the tool runs that opens a session
       * lands on the same opener, watched by whoever handed `onOpened` in. */
      wakeAgent(handle.agent, {
        ctx,
        executorOf: options?.openerOf ?? ((id: SessionId, at: string) => executorOf(ctx, id, at)),
      })
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
      } catch (error) {
        armed.drop()
        throw error
      }
      return { armed, agent: handle.agent }
    })
    settlement = lane.armed
    agent = lane.agent
  } catch (error) {
    /* The session may be out already and the note missing: say so plainly instead of letting the next open run a second session on this cell. */
    return openFailure(messageOf(error))
  }

  /* The placement's session-side diagnostic, taken once outside the queue. This is the one stretch
   * that knows both the workspace and the live session's own scope, so a same-name copy in a project
   * root (rank 100/200 — DSH's own per-workspace override, outside this node's judgement) gets a name
   * and both places in one log line rather than passing silently. One catalog read is real IO: held
   * inside the queue it would block the next open of this workspace for as long as the catalog takes,
   * and it cannot fail the open (the check hands back a code, the report writes a line), so nothing
   * downstream waits on it. This diagnostic is not an acceptance reading anyone can point at — the
   * session's own catalog is. */
  const skills = skillHostOf(ctx)
  reportSkillView(skills, await confirmSkillsForWorkspace(skills, root, agent))

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
