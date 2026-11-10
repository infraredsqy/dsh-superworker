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
 *    already has a live session in it — arm the session's `superworker` tool,
 *    hand the prompt over as the first instruction, and note the session
 *    through the engine's writer — this side only names the entry.
 *
 * That is the whole answer: the session, minted, holding its first instruction,
 * with its note on disk. The round the session then runs is its own business —
 * this file arms nothing to watch it and waits for no part of it. An open
 * answers "the session is out" or the reason no session could be opened (a
 * missing prompt, a refused create, a session that cannot be minted); how the
 * node's work goes is the worker's ticket and the line's close, never this
 * call's answer. The wait cannot be folded in either: a session asked to do a
 * node's work runs its first round for as long as that work takes, and a round
 * that stops to ask a person runs for as long as the person takes. Whoever
 * wants to watch a session watches it — the caller's `onOpened`, the relay's
 * turn-end trigger — and a dispatch that waited would be answering a question
 * the engine never asked it.
 *
 * Step 3 touches the workspace (the session log's directory and the note
 * file) and runs inside a per-workspace queue, so two opens aimed at one
 * workspace create their sessions strictly one after another and their notes
 * never interleave mid-write. The skill placement's session-side diagnostic —
 * one catalog read, which can never fail the open — runs outside that queue: a
 * slow catalog read must not hold the next open of the same workspace hostage.
 *
 * The engine's own executor seam ({@link executorOf}) lives here too, beside the
 * open it drives: a dispatch's opener is this file and nothing else, and the
 * caller that wants to watch its sessions passes `onOpened` instead of wrapping
 * the open.
 *
 * The consult session the panel's legacy notice opens is a sibling open in this
 * file as well ({@link openConsultSession}): it shares the sides above — the
 * session-side probe, the standing preset, the workspace attach, the tool arm —
 * and drops the record-facing halves (no launch prompt to read, no note to
 * write), because a workspace whose records sit only in the older layer has
 * neither to offer.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for `agents` and the agent events live on the package entries; type-only, nothing enters the runtime. */
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { CONSULT_PROMPT, type Executor } from 'superworker-core'
import { LAUNCH_PROMPT_FILE, RECORD_LAUNCH } from './contract.ts'
import type { RecordFailure, RecordRefusalCode } from './failure.ts'
import { isAbsent, readWholeFile, type SuperworkerScope } from './records.ts'
import {
  agentsOf,
  logLineOf,
  messageOf,
  modelSelectionOf,
  presetPortOf,
  skillHostOf,
  workspaceRegistryOf,
  workspaceRootOf,
  type WorkspaceRegistryPort,
} from './seams.ts'
import { noteOpenedSession } from './session-note.ts'
import { confirmSkillsForWorkspace, reportSkillView } from './skills/view.ts'
import { wakeAgent } from './wake.ts'

/** What one open brought back: the session now working this node. The id is an address for the panel's navigation, not a word a reader is shown. */
export type SessionOpenOutcome =
  | { readonly ok: true; readonly session: string }
  | { readonly ok: false; readonly code: RecordRefusalCode; readonly detail?: string }

/** Options an in-process caller may hand an open; over the wire the open runs to its own end. */
export interface SessionOpenOptions {
  /**
   * The model route this session opens with (`provider/model`, as the engine carries it): the
   * dispatch's own name comes down here, and the engine has already resolved the call > line policy >
   * machine-switch order. Absent leaves the deployment's own default in force.
   */
  readonly model?: string
  /**
   * Runs once the session is minted and alive, before its first instruction
   * goes in — the earliest point a caller can start watching it, ahead of
   * every event the round will emit. Best effort: a throwing hook does not
   * fail the open.
   */
  readonly onOpened?: (session: string) => void
  /**
   * The opener seam the session's own `superworker` tool opens through. A dispatched session arms its
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
function segmentFailure(value: string): RecordFailure | undefined {
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
function sessionSideOf(ctx: Context): AgentRegistry | RecordFailure {
  const agents = agentsOf(ctx)
  if (agents === undefined) return { ok: false, code: 'no-session-service', detail: 'agents' }
  return agents
}

/** Say that the session is open and stays un-attached, naming what was opened and the workspace it missed. */
function reportUnattached(ctx: Context, subject: string, root: string, reason: string): void {
  logLineOf(ctx, 'warn', `could not attach ${subject} to the workspace at ${root}: ${reason}; the session stays cwd-only`)
}

/** Why no attach happened when the host answered none at all: no service to ask, or no workspace answered. */
function attachMissReason(registry: WorkspaceRegistryPort | undefined): string {
  return registry === undefined
    ? 'this host exposes no workspace service'
    : 'this host\'s workspace service answered no attachable workspace'
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
function openFailure(reason: string): { ok: false; code: RecordRefusalCode; detail: string } {
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
 * The promise ends when the session is out — minted, holding its first instruction, noted — and
 * not one step further: the round's course is the worker's ticket and the line's close, so this
 * seam has no answer about it to give.
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
 * Open the session that works one node: the session exists, its first
 * instruction is in, and its note names it — nothing after that.
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

  /* The prompt read takes a signal, and nothing here is cancellable: an open is a handful of local
   * steps, and the answer is the session, so there is no stretch worth aborting. */
  const signal = new AbortController().signal
  const scope: SuperworkerScope = { sessionId, workspaceRoot: root }
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

  /* The workspace-touching stretch, queued: create the session under the root, join it to that one workspace, arm the tool, hand the prompt over, then note the session. */
  let agent: Agent
  try {
    agent = await inLine(root, async () => {
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
          reportUnattached(ctx, `the session opened for ${cycle}/${node}`, root, attachMissReason(registry))
        } else {
          await workspace.attachSession(opened)
        }
      } catch (error) {
        /* The session is already minted: the host refused the grouping after the fact. The open
         * goes on cwd-only — the first instruction and the note below still land, so the session
         * has its record and the panel keeps its cell — and one log line says which cell and which
         * workspace missed the grouping, with the host's own reason. Failing here would leave a
         * live session nobody wrote down. */
        reportUnattached(ctx, `the session opened for ${cycle}/${node}`, root, messageOf(error))
      }
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
       * not gone in — registration here lands ahead of every event the round emits. */
      try {
        options?.onOpened?.(opened)
      } catch {
        /* A caller's registration problem is not this open's failure. */
      }
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await noteOpenedSession(root, node, opened)
      return handle.agent
    })
  } catch (error) {
    /* The session may be out already and the note missing: say so plainly instead of letting the next open run a second session on this cell. */
    return openFailure(messageOf(error))
  }

  /* The placement's session-side diagnostic, taken once outside the queue. This is the one stretch
   * that knows both the workspace and the live session's own scope, so a same-name copy in a project
   * root (rank 100/200 — DSH's own per-workspace override, outside this node's judgement) gets a name
   * and both places in one log line rather than passing silently. One catalog read is real IO: held
   * inside the queue it would block the next open of this workspace for as long as the catalog takes,
   * and it cannot fail the open (the check hands back a code, the report writes a line). This
   * diagnostic is not an acceptance reading anyone can point at — the session's own catalog is. */
  const skills = skillHostOf(ctx)
  reportSkillView(skills, await confirmSkillsForWorkspace(skills, root, agent))

  return { ok: true, session: opened }
}

/**
 * Open the consult session the panel's legacy notice hands a person: one session of this host's
 * own, at the workspace the reader was looking at, whose first instruction is the engine's fixed
 * consult sentence ({@link CONSULT_PROMPT}) — spelled in the engine and only there, so the panel
 * carries no second copy of it.
 *
 * It is a sibling of {@link openNodeSession}, sharing its sides and dropping its record-facing
 * halves. Shared: the session-side probe (a host without the agent registry is refused before
 * anything is minted), the standing preset the session composes through, the workspace attach,
 * the queue around the create/attach stretch, and the tool arm — the last one being the point of
 * the whole open, because the wake's event paths cannot see a session this host minted, and
 * without the tool the consult session would have no way to reach `migrate` and `doctor`. Dropped:
 * a workspace whose records sit only in the older layer has no launch cell to read a prompt from
 * and no node to hang a note on, so neither happens, and the open answers as soon as the consult
 * sentence has gone in — the person follows the session in DSH's own session view, the way they
 * would one they opened by hand.
 *
 * An empty `workspaceRoot` follows the boundary's own convention — the calling session's own
 * workspace — so an in-process caller needs no root of its own.
 */
export async function openConsultSession(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
): Promise<SessionOpenOutcome> {
  const side = sessionSideOf(ctx)
  if ('code' in side) return side

  /* One canonical spelling, taken once here: the queue this open joins, the `create()` call and
   * the workspace it is attached to all name the same directory — whatever letters the caller
   * used, or none. An empty name falls back to the calling session's own root, and a root that
   * cannot be resolved at all is an open refusal, not a thrown error. */
  let named: string
  try {
    named = workspaceRoot.length > 0 ? workspaceRoot : await workspaceRootOf(ctx, sessionId)
  } catch (error) {
    return openFailure(messageOf(error))
  }
  const root = await canonicalWorkspaceRoot(named)

  /* The standing preset this open composes through, the same resolution the node open runs:
   * the mount is what gives the session its scoped world (tools, skills). A roster that cannot
   * resolve its own default is an open refusal naming the reason, not a bare session that can
   * do nothing. */
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

  /* The session identity is this host's own mint, spelled the way the host spells its own: `session-` + a fresh uuid. The brand is a compile-time fact; the string is what crosses. */
  const opened = `session-${randomUUID()}` as SessionId
  const selection = modelSelectionOf(ctx)

  /* The workspace-touching stretch, queued: create the session under the root, join it to that
   * one workspace, arm the tool, hand the consult sentence over. No note follows — there is no
   * node to name — and nothing waits for the round: it is the person's to watch. */
  try {
    await inLine(root, async () => {
      const handle = await side.create({
        sessionId: opened,
        meta: { cwd: root, ...(standing === undefined ? {} : { agentPreset: standing.id }) },
        ...(selection === undefined ? {} : { agentOptions: selection }),
        ...(mount === undefined ? {} : { setup: mount }),
      })
      const registry = workspaceRegistryOf(ctx)
      try {
        const workspace = registry === undefined ? undefined : await registry.create(root)
        if (workspace === undefined) {
          reportUnattached(ctx, 'the consult session', root, attachMissReason(registry))
        } else {
          await workspace.attachSession(opened)
        }
      } catch (error) {
        /* The session is already minted: the open goes on cwd-only, with one log line naming what
         * missed the grouping — the same trade the node open makes, for the same reason: failing
         * here would leave a live session nobody wrote down. */
        reportUnattached(ctx, 'the consult session', root, messageOf(error))
      }
      /* Arm the session's own tool before the first instruction goes in, exactly as the node open
       * does: the wake's event paths cannot see a session this host minted, and this session has
       * to reach `migrate` and `doctor` — that reach is the whole reason it exists. */
      wakeAgent(handle.agent, {
        ctx,
        executorOf: (id: SessionId, at: string) => executorOf(ctx, id, at),
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: CONSULT_PROMPT }],
        source: { kind: 'user' },
      }))
    })
  } catch (error) {
    /* The session may be minted already with the sentence undelivered: say so plainly instead of
     * answering an ok a reader would trust. */
    return openFailure(messageOf(error))
  }
  return { ok: true, session: opened }
}

