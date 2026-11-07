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
 * - **The trigger.** The relay listens to the two ways one of its own sessions
 *   stops running: `turn/end` of a session **this host opened** (tracked here
 *   when a dispatch returns), and the host's `session/disposed` — a session
 *   that crashed, was stopped, or ran out of context never reaches the first
 *   one, and a line parked on that cell would wait for a person forever.
 *   Either notice re-reads the plan read-only and carries the line on when the
 *   plan asks for it — claim the free slots, land each cell's material, open
 *   one session per cell (`conductor.advance`), or park a line with nothing
 *   left. The judgement is the same one for both, so a plan that says `wait`
 *   is never overridden and a second notice for a session already judged
 *   cannot open a second time: the claim the first pass wrote is what the
 *   re-read sees. The switch (`autoRelay`, default on) turns the trigger off;
 *   the button keeps working whatever the switch says.
 *
 * The relay never throws into the event bus: a refused trigger logs one line
 * and the panel's button reports its own refusal to the reader.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { open, type Executor, type Pf } from 'superworker-core'
import { canonicalWorkspaceRoot, executorOf, type SessionOpenOutcome } from './executor.ts'
import type { RecordRefusalCode } from './failure.ts'
import { busOf, logLineOf, messageOf } from './seams.ts'
import { PANEL_PREF_FIELDS } from './settings-fields.ts'
import { shippedPluginsDir } from './skill-paths.ts'

/** The one refusal this layer adds: the engine (or the opener inside it) said no. */
export type DispatchRefusalCode = RecordRefusalCode | 'dispatch-refused'

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
 * The one writer of that table: a session this relay opened, and the root it
 * opened it for. Both paths that learn of an open — the opener's `onOpened`, a
 * dispatch receipt, an advance receipt — come through here, so the table has a
 * single spelling of "one of mine".
 */
function remember(session: string | undefined, workspaceRoot: string): void {
  if (session === undefined || session.length === 0) return
  tracked.set(session, workspaceRoot)
}

/**
 * The in-flight dispatch, process-wide: each call is appended to the tail of
 * the previous one, so two triggers never interleave their engine calls. A
 * refusal in front does not poison the line — the next call runs anyway.
 */
let inFlight: Promise<unknown> = Promise.resolve()

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
 * The executor seam one dispatch runs through: the native opener, with every
 * session it mints remembered in this relay's table the moment it exists —
 * before its opening round can settle. An open does not return until that round
 * does, so a registration on the return would always lose the round's own
 * turn-end event, and the relay would never hear a session it opened itself.
 *
 * The words layer's tool opens sessions through this same seam, which is why it
 * is exported: a cell opened from a tool call is as real to the plan — and to
 * the trigger — as one the panel's button opened.
 */
export function trackedExecutorOf(ctx: Context, sessionId: SessionId, workspaceRoot: string): Executor {
  return executorOf(ctx, sessionId, workspaceRoot, (session) => remember(session, workspaceRoot))
}

/**
 * The engine handle one dispatch-side call reads: the opener seam above, the
 * plugin folder this package ships (so the shipped plugin set — the `issue`
 * command surface and the two closing guards — answers here too, the same set
 * the skills placement reads; a project's own `plugins/` folder is not
 * consulted through this path), and the one table that remembers what it
 * opened. Every dispatch-side call — `dispatch`, `advance`, the read-only
 * `next` — builds its handle here, so the option set has one spelling.
 */
function dispatchHandleOf(ctx: Context, sessionId: SessionId, workspaceRoot: string): Pf {
  return open(workspaceRoot, {
    executor: trackedExecutorOf(ctx, sessionId, workspaceRoot),
    pluginsDir: shippedPluginsDir(),
  })
}

/** What a dispatch receipt carries once a session is really out. */
interface OpenedReceipt {
  readonly action?: string
  readonly session?: { readonly sessionId?: string }
}

/** Remember whatever a receipt says was opened, the same way the opener's own callback does. */
function rememberReceipt(receipt: OpenedReceipt, workspaceRoot: string): void {
  if (receipt.action !== 'opened') return
  remember(receipt.session?.sessionId, workspaceRoot)
}

/** The dispatch itself, run strictly one at a time. */
async function runDispatch(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  cycle: string,
  node: string,
): Promise<DispatchOutcome> {
  /* The dispatch entry takes the canonical spelling once: the engine's handle, the opener's queue
   * key and `cwd`, and the workspace this dispatch remembers are one string.
   *
   * Known untested on its own: the alias case's green does not ride on this line — the opener
   * canonicalises a second time inside `openNodeSession`, so removing this call alone keeps every
   * case green; the relay's and the opener's calls have to go together for the alias case to turn
   * red. No reading pins this line by itself. */
  const root = await canonicalWorkspaceRoot(workspaceRoot)
  try {
    const receipt = await dispatchHandleOf(ctx, sessionId, root).conductor.dispatch({ cycle, node })
    rememberReceipt(receipt, root)
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
 * Carry one line a step, on the host's own executor: the applier's work (`plan` → claim the free
 * slots → land the material → open a session per cell → park a stopped line) is the engine's
 * `advance`, and this is the host's one caller of it. Calls join the process-wide chain for the same
 * reason `dispatchCell` does: two triggers never interleave their engine calls.
 */
export function advanceLine(
  ctx: Context,
  sessionId: SessionId,
  workspaceRoot: string,
  cycle: string,
): Promise<DispatchOutcome> {
  const step = async (): Promise<DispatchOutcome> => {
    /* Same entry discipline as `dispatchCell`: one canonical spelling for the handle, the opener and
     * the workspace the relay remembers. Known untested on its own, like the dispatch entry's call —
     * see the note there. */
    const root = await canonicalWorkspaceRoot(workspaceRoot)
    try {
      const receipt = await dispatchHandleOf(ctx, sessionId, root).conductor.advance({ cycle })
      for (const cell of receipt.dispatches) rememberReceipt(cell.receipt, root)
      const first = receipt.dispatches[0]?.receipt
      return { ok: true, session: first?.session?.sessionId ?? '' }
    } catch (error) {
      return { ok: false, code: 'dispatch-refused', detail: messageOf(error) }
    }
  }
  const mine = inFlight.then(step, step)
  inFlight = mine.then(() => undefined, () => undefined)
  return mine
}

/**
 * The relay's answer to either notice: read the plan read-only, and carry the line on when the plan
 * asks for it (`dispatch` / `open_node` to open or claim the next cell, `stop_pipeline` to park a line
 * that has nothing left). A plan that says `wait` is never overridden — the ticket owed, or the
 * session already out, is the caller's business — so a dead cell cannot be driven through, and the
 * two notices cannot double-dispatch: the first pass writes the claim the second one reads. The switch
 * is read on the spot — turning it off stops the next round, not a step already in flight. A refusal
 * is a log line, never a throw into the event bus: the plan's own note (or the panel's button) is
 * where a person acts.
 */
async function judge(ctx: Context, sessionId: SessionId, workspaceRoot: string): Promise<void> {
  if (!relayOn()) return
  /* The root already arrives canonical from the dispatch that tracked it, and the entry takes it
   * once more so a plan read can never disagree with the root a dispatch would use. Known untested
   * on its own, like the dispatch entry's call — see the note there. */
  const root = await canonicalWorkspaceRoot(workspaceRoot)
  const plan = await dispatchHandleOf(ctx, sessionId, root).conductor.next({})
  if (plan.action !== 'dispatch' && plan.action !== 'open_node' && plan.action !== 'stop_pipeline') return
  const cycle = typeof plan.cycle === 'string' ? plan.cycle : ''
  if (cycle === '') return
  const outcome = await advanceLine(ctx, sessionId, root, cycle)
  if (!outcome.ok) {
    logLineOf(ctx, 'warn', `dispatch relay could not advance ${cycle}: ${outcome.detail ?? outcome.code}`)
  }
}

/**
 * Arm the triggers: the two notices one of this host's own sessions can leave
 * behind, each judged the same way.
 *
 * - `turn/end` says the session finished a round; the line carries on after it.
 * - `session/disposed` says the session left the host's store — it crashed, was
 *   stopped, or ran out of context, so no `turn/end` is ever coming. The entry
 *   leaves the tracked table (that session can never answer again) and the same
 *   judge runs: the plan decides, and a cell a `turn/end` already carried on is
 *   now blocked by its own claim.
 *
 * A host without an event surface (`ctx.on`) takes nothing — the button still
 * works, only the automatic relay is absent. The returned disposer takes the
 * listeners back.
 */
export function installRelay(ctx: Context, config?: unknown): () => void {
  lineConfig = config
  const bus = busOf(ctx)
  if (bus === undefined) return () => undefined
  const offs: (() => void)[] = []
  const keep = (off: unknown): void => {
    if (typeof off === 'function') offs.push(off as () => void)
  }
  const judgeSoon = (id: string, root: string): void => {
    void judge(ctx, id as SessionId, root).catch((error: unknown) => {
      /* A refused trigger is a log line, never a throw into the event bus:
       * the plan's own note (or the panel's button) is where a person acts. */
      logLineOf(ctx, 'warn', `dispatch relay judged and refused: ${messageOf(error)}`)
    })
  }
  keep(bus.on('session/event', (...args: never[]) => {
    const session = args[0] as { id?: unknown } | undefined
    const event = args[1] as { type?: unknown } | undefined
    if (event?.type !== 'turn/end') return
    const id = typeof session?.id === 'string' ? session.id : ''
    const root = tracked.get(id)
    if (root === undefined) return
    judgeSoon(id, root)
  }))
  keep(bus.on('session/disposed', (...args: never[]) => {
    const session = args[0] as { id?: unknown } | undefined
    const id = typeof session?.id === 'string' ? session.id : ''
    const root = tracked.get(id)
    if (root === undefined) return
    tracked.delete(id)
    judgeSoon(id, root)
  }))
  return () => {
    for (const off of offs) off()
  }
}
