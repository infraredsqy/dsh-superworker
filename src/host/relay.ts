/**
 * The dispatch relay: the one path every dispatch of this host half walks,
 * whatever pressed it — the panel's button or the relay itself.
 *
 * One dispatch, in order: the engine's `conductor.dispatch` lands the cell's
 * material (the launch prompt when it is not already on disk), hands the cell
 * to the executor seam, and — only after a session is really out — writes the
 * `started` claim that keeps the plan from counting the cell as dispatchable
 * again. The executor seam is the native opener (`executor.ts`) hung on the
 * engine: the session, its first instruction and its note are all the opener's
 * own work, and the claim lands as part of the same dispatch, not beside it.
 *
 * Three guarantees live here, and nowhere else:
 *
 * - **One path.** The button used to open a session directly, leaving no
 *   claim behind — a cell it opened was invisible to the plan. Both callers
 *   now walk `dispatchCell`, so a dispatch made by hand and one made by the
 *   relay leave the same marks on disk.
 * - **Serial.** One dispatch at a time, process-wide, whatever triggered it:
 *   every call joins the same chain. The engine's own claim check is still
 *   the guard against a second session (two calls for one cell resolve to
 *   `already_open`), and the chain keeps the calls from even interleaving.
 * - **The trigger.** The relay listens to `turn/end` of the sessions **this
 *   host opened** (tracked here when a dispatch returns), reads the plan
 *   read-only after each turn, and dispatches only when the plan says
 *   `dispatch` — a plan that says `wait` is never overridden, so a dead cell
 *   cannot be driven through. The switch (`autoRelay`, default on) turns the
 *   trigger off; the button keeps working whatever the switch says.
 *
 * The relay never throws into the event bus: a refused trigger logs one line
 * and the panel's button reports its own refusal to the reader.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { open, type Executor } from 'pf-core'
import { openNodeSession, type SessionOpenOutcome } from './executor.ts'
import type { PfRefusalCode } from './failure.ts'
import { PANEL_PREF_FIELDS } from './settings-fields.ts'
import { shippedPluginsDir } from './skills.ts'

/** The one refusal this layer adds: the engine (or the opener inside it) said no. */
export type DispatchRefusalCode = PfRefusalCode | 'dispatch-refused'

/** What one dispatch answers: the session it opened, or why it refused. */
export type DispatchOutcome = SessionOpenOutcome

/**
 * The sessions this host dispatched, by id, with the workspace root the
 * dispatch named. This is the relay's own memory of "its" sessions: a
 * `turn/end` from an id that is not here is nobody's business. One process,
 * one table; a host restart empties it, which is correct — after a restart
 * no agent of ours is alive to fire the event.
 */
const tracked = new Map<string, string>()

/**
 * The in-flight dispatch, process-wide: each call is appended to the tail of
 * the previous one, so two triggers never interleave their engine calls. A
 * refusal in front does not poison the line — the next call runs anyway.
 */
let inFlight: Promise<unknown> = Promise.resolve()

/** Why an open inside the dispatch failed, as the message the refusal carries. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The logger a real host carries, fetched structurally; stand-ins may lack it. */
function loggerOf(ctx: Context): { warn(line: string): void } | undefined {
  const held = (ctx as { logger?: { warn?(line: string): void } }).logger
  return typeof held?.warn === 'function' ? { warn: held.warn.bind(held) } : undefined
}

/**
 * The line's resolved settings, captured when the line loaded: the switch is
 * read off this object. The plugin context itself is not asked — on the real
 * host reading an undeclared property off the context proxy throws, and the
 * listener that reads it dies unseen, inside the event bus's per-listener
 * containment.
 */
let lineConfig: unknown = undefined

/**
 * Whether the switch says the relay may fire: absent surface or absent field
 * both read as on. The switch is a volatile settings field: on the real host
 * the resolved config hands it over as a stable reference whose `get()`
 * answers the current snapshot — read at the call, so a flip lands on the
 * next turn end without a reload. A plain boolean (stand-ins, older hosts)
 * reads as it is.
 */
function relayOn(): boolean {
  const config = lineConfig
  if (config === null || typeof config !== 'object') return true
  const held = (config as Record<string, unknown>)[PANEL_PREF_FIELDS.autoRelay]
  const value = held !== null && typeof held === 'object' && typeof (held as { get?: unknown }).get === 'function'
    ? (held as { get: () => unknown }).get()
    : held
  return value !== false
}

/**
 * The executor seam for one dispatch: the native opener hung on the engine.
 * The engine hands the request over after its own gates and preparation; the
 * opener reads the prompt it landed and creates the session. A refusal throws
 * — the engine then writes no claim and hands the reason back as the
 * dispatch's own refusal detail.
 */
function executorOf(ctx: Context, sessionId: SessionId, workspaceRoot: string): Executor {
  return {
    async dispatch(request) {
      const cycle = request.cycle ?? ''
      const node = request.node ?? ''
      if (cycle.length === 0 || node.length === 0) {
        throw new Error('the dispatch request named no cell (cycle and node are both required here)')
      }
      const outcome = await openNodeSession(ctx, sessionId, workspaceRoot, cycle, node)
      if (!outcome.ok) throw new Error(outcome.detail ?? outcome.code)
      return { sessionId: outcome.session, host: 'dsh' }
    },
  }
}

/** The dispatch itself, run strictly one at a time. */
async function runDispatch(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  cycle: string,
  node: string,
): Promise<DispatchOutcome> {
  try {
    /* The handle names the plugin folder this package ships, so the shipped plugin set (the `issue`
     * command surface and the two closing guards) answers here too — the same set the skills
     * placement reads. A project's own `plugins/` folder is not consulted through this path. */
    const pf = open(workspaceRoot, { executor: executorOf(ctx, sessionId, workspaceRoot), pluginsDir: shippedPluginsDir() })
    const receipt = await pf.conductor.dispatch({ cycle, node })
    if (receipt.action === 'opened' && receipt.session?.sessionId !== undefined) {
      tracked.set(receipt.session.sessionId, workspaceRoot)
    }
    return { ok: true, session: receipt.session?.sessionId ?? '' }
  } catch (error) {
    /* The engine's own words ride as the detail, verbatim: they name the cell,
     * the gate that blocked it, or the open that failed — another program's
     * reasons are not this layer's to rephrase. */
    return { ok: false, code: 'dispatch-refused', detail: messageOf(error) }
  }
}

/**
 * Dispatch one cell of one line: the one path the panel's button and the
 * relay both walk. Calls join the process-wide chain, so a dispatch that is
 * already in flight finishes (session opened, claim written) before this one
 * reaches the engine — and for the same cell, the engine's own claim check
 * answers `already_open` instead of opening a second session.
 */
export function dispatchCell(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  cycle: string,
  node: string,
): Promise<DispatchOutcome> {
  const mine = inFlight.then(
    () => runDispatch(ctx, sessionId, workspaceRoot, cycle, node),
    () => runDispatch(ctx, sessionId, workspaceRoot, cycle, node),
  )
  inFlight = mine.then(() => undefined, () => undefined)
  return mine
}

/**
 * The relay's answer to one turn end: read the plan read-only, and only a
 * plan that says `dispatch` opens the next round. The switch is read on the
 * spot — turning it off stops the next round, not a dispatch already in
 * flight. A dispatch that refuses is a log line, never a throw into the
 * event bus: the plan's own note (or the panel's button) is where a person
 * acts.
 */
async function judge(ctx: Context, sessionId: SessionId, workspaceRoot: string): Promise<void> {
  if (!relayOn()) return
  const plan = await open(workspaceRoot, { executor: executorOf(ctx, sessionId, workspaceRoot), pluginsDir: shippedPluginsDir() })
    .conductor.next({ plan: true })
  if (plan.action !== 'dispatch') return
  const outcome = await dispatchCell(ctx, sessionId, workspaceRoot, plan.cycle, plan.node_id)
  if (!outcome.ok) {
    loggerOf(ctx)?.warn(`dispatch relay did not open ${plan.cycle}/${plan.node_id}: ${outcome.detail ?? outcome.code}`)
  }
}

/**
 * Arm the trigger: listen to `turn/end` for the sessions this host
 * dispatched, and judge after each. A host without an event surface
 * (`ctx.on`) takes nothing — the button still works, only the automatic
 * relay is absent. The returned disposer takes the listeners back.
 */
export function installRelay(ctx: Context, config?: unknown): () => void {
  lineConfig = config
  const bus = ctx as unknown as {
    on?: (event: string, listener: (...args: never[]) => void) => unknown
  }
  if (typeof bus.on !== 'function') return () => undefined
  const off = bus.on('session/event', (...args: never[]) => {
    const session = args[0] as { id?: unknown } | undefined
    const event = args[1] as { type?: unknown } | undefined
    if (event?.type !== 'turn/end') return
    const id = typeof session?.id === 'string' ? session.id : ''
    const root = tracked.get(id)
    if (root === undefined) return
    void judge(ctx, id as SessionId, root).catch((error: unknown) => {
      /* A refused trigger is a log line, never a throw into the event bus:
       * the plan's own note (or the panel's button) is where a person acts. */
      loggerOf(ctx)?.warn(`dispatch relay judged and refused: ${messageOf(error)}`)
    })
  })
  return typeof off === 'function' ? (off as () => void) : () => undefined
}
