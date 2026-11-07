/**
 * The browser half's single path for fetching data and writing back: hands over "which session"
 * and brings the reading back.
 *
 * Both lines reach the same endpoint: first through DSH's mounted remote namespace; deployments
 * without that namespace fall back to the carrier layer calling the same endpoint on `/api`
 * directly. The endpoint name string appears only once, here.
 *
 * Nothing on this layer writes a sentence. A read that fails rejects with a code (see
 * `failure.ts`), and a write that fails answers with one; the panel turns it into words
 * (`src/client/words.ts`), because the panel is the only place that knows the reader's language.
 */
import type { SuperworkerReading } from '../host/contract.ts'
import type { SuperworkerConfigReading } from '../host/project-config.ts'
import type { SuperworkerSessionsReading } from '../host/sessions.ts'
import type { InstructionScope } from '../host/gateway.ts'
import type { SessionOpenOutcome } from '../host/executor.ts'
import { RefusedError, type Failure, type FailureCode, type Outcome } from './failure.ts'

/** The namespace, named after the host-half service key. */
export const NAMESPACE = 'superworker'

export type WriteVerb = 'archive' | 'revive' | 'remove'

/** Which host endpoint each write verb maps to. */
const WRITE_ENDPOINTS: Readonly<Record<WriteVerb, string>> = {
  archive: 'archiveInstruction',
  revive: 'reviveInstruction',
  remove: 'removeInstruction',
}

/**
 * The port the panel uses to talk to the host.
 *
 * Every method carries a `workspaceRoot`: the root picked in the workspace selector at the top of
 * the panel (an absolute path); an empty string means nothing was picked, and the read falls back
 * to this session's own root. Whichever is picked is read — unrelated to which workspace the
 * session belongs to.
 *
 * `source` says which layer this port ultimately connected through: `remote` is the mounted remote
 * namespace, `carrier` is the carrier layer, `none` is neither — every read then fails outright,
 * since no reading can be fabricated.
 */
export interface PanelPort {
  readonly source: 'remote' | 'carrier' | 'none'
  /** Read the four records of the named workspace; rejects with a {@link RefusedError} when it cannot. */
  read(sessionId: string, workspaceRoot: string): Promise<SuperworkerReading>
  /** The most recent session opened for each cell in the named workspace: where card clicks go. */
  readSessions(sessionId: string, workspaceRoot: string): Promise<SuperworkerSessionsReading>
  /** Record an instruction: hand the user's verbatim text and scope to the tool. */
  say(sessionId: string, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string, node: string): Promise<Outcome>
  /** Archive / revive / delete an instruction. */
  write(verb: WriteVerb, sessionId: string, workspaceRoot: string, id: string): Promise<Outcome>
  /** The named workspace's project settings: effective values and which layer each lives on, from the tool's command. */
  readConfig(sessionId: string, workspaceRoot: string): Promise<SuperworkerConfigReading>
  /** Write one project setting; it always lands on this project's layer. */
  setConfig(sessionId: string, workspaceRoot: string, key: string, value: string): Promise<Outcome>
  /** Open, on the host, the session that works one node of one line: the plan's prompt goes in as the first instruction. */
  openNodeSession(sessionId: string, workspaceRoot: string, cycle: string, node: string): Promise<Outcome>
}

/** What one endpoint call yields before the two branches are unfolded: the value, or why not. */
type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure }

/** The minimal shape of a service: this layer only needs the few methods below. */
type Service = Readonly<Record<string, unknown>>

interface Carrier {
  readonly rpc?: {
    call(
      path: string,
      endpoint: string,
      payload: { readonly args: Readonly<Record<string, unknown>> },
    ): Promise<unknown>
  }
}

/**
 * Fetch a service from the context's several entrances, on the spot.
 *
 * Both are tried: first the context's own `get`, then the property proxy. If it cannot be fetched,
 * it cannot be fetched — this layer does not throw; callers treat it as "absent".
 * @param owner - A context (the plugin's own, or the one given to the inject callback).
 */
export function serviceAt(owner: unknown, name: string): Service | undefined {
  const holder = owner as { get?: (key: string) => unknown } | null | undefined
  if (holder !== null && holder !== undefined && typeof holder.get === 'function') {
    try {
      const value = holder.get(name)
      if (value !== undefined && value !== null) return value as Service
    } catch (error) {
      /* Asking for an undeclared name throws, which counts the same as "absent". */
    }
  }
  try {
    const value = (owner as Record<string, unknown> | null | undefined)?.[name]
    return value === undefined || value === null ? undefined : (value as Service)
  } catch (error) {
    return undefined
  }
}

export function createPanelPort(ctx: unknown): PanelPort {
  const remote = remoteNamespace(ctx)
  if (remote !== undefined) return remotePort(remote)
  const carrier = serviceAt(ctx, 'connection') as Carrier | undefined
  if (carrier?.rpc !== undefined) return carrierPort(carrier.rpc)
  return absentPort()
}

/** The mounted remote namespace; both lookups are tried. */
function remoteNamespace(ctx: unknown): Service | undefined {
  const direct = serviceAt(ctx, `remote.${NAMESPACE}`)
  if (direct !== undefined) return direct
  const remote = serviceAt(ctx, 'remote')
  if (remote === undefined) return undefined
  try {
    const namespace = remote[NAMESPACE]
    return namespace === undefined || namespace === null ? undefined : (namespace as Service)
  } catch (error) {
    /* Reading an undeclared namespace off the proxy throws: treated here as "not mounted". */
    return undefined
  }
}

/** Arguments for a read call: all three positions present. */
function readArgs(sessionId: string, workspaceRoot: string): Readonly<Record<string, unknown>> {
  return { sessionId, workspaceRoot, options: {} }
}

/**
 * The order in which each endpoint takes its arguments: the remote layer passes them by position,
 * so actual arguments follow this table.
 *
 * When an endpoint changes signature, this table changes with it — the layer refuses to lean on the
 * unsourced convention "object key order = endpoint parameter order", whose silent misalignment on
 * a key reorder is debt this layer does not carry.
 */
const REMOTE_PARAM_ORDER: Readonly<Record<string, readonly string[]>> = {
  read: ['sessionId', 'workspaceRoot', 'options'],
  readSessions: ['sessionId', 'workspaceRoot'],
  addInstruction: ['sessionId', 'workspaceRoot', 'text', 'scope', 'cycle', 'node'],
  archiveInstruction: ['sessionId', 'workspaceRoot', 'id'],
  reviveInstruction: ['sessionId', 'workspaceRoot', 'id'],
  removeInstruction: ['sessionId', 'workspaceRoot', 'id'],
  readConfig: ['sessionId', 'workspaceRoot'],
  setConfig: ['sessionId', 'workspaceRoot', 'key', 'value'],
  openNodeSession: ['sessionId', 'workspaceRoot', 'cycle', 'node'],
}

/** The arguments this endpoint call receives: laid out per the parameter table; keys absent from it are dropped. */
function positional(method: string, args: Readonly<Record<string, unknown>>): readonly unknown[] {
  return (REMOTE_PARAM_ORDER[method] ?? []).map((key) => args[key])
}

/** What each of the two fetch paths yields: one call whose answer already arrives unfolded into the two branches. */
type PortCall = <T>(
  method: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<Answer<T>>

/** A refusal in the shape a write hands back, without the `ok` tag the reading already carries. */
function refused(failure: Failure): Outcome {
  return { ok: false, code: failure.code, ...(failure.detail !== undefined ? { detail: failure.detail } : {}) }
}

/**
 * The common skeleton of the panel's port: the six methods written once, with the two paths
 * differing only in the `call` layer.
 *
 * Every call is a read or a write the panel means to see through: the panel draws what comes back,
 * and a call nobody waits for is a call nobody wanted. So none of them carries a cancellation — a
 * read runs to its answer, and the panel drops a late one on its own side.
 *
 * A read that cannot happen rejects with {@link RefusedError} — a caller awaiting a reading has
 * nowhere to put a failure but the rejection. A write answers with the failure instead, because its
 * callers place the reason on the panel's note line and carry on.
 * @param source - Which layer this port ultimately connected through.
 * @param call - Given the endpoint name and named arguments; it unfolds the answer into the two branches.
 */
function portFromCall(source: PanelPort['source'], call: PortCall): PanelPort {
  return {
    source,
    async read(sessionId, workspaceRoot) {
      const answer = await call<SuperworkerReading>('read', readArgs(sessionId, workspaceRoot))
      if (!answer.ok) throw new RefusedError(answer.failure)
      return answer.value
    },
    async readSessions(sessionId, workspaceRoot) {
      const answer = await call<SuperworkerSessionsReading>('readSessions', { sessionId, workspaceRoot })
      if (!answer.ok) throw new RefusedError(answer.failure)
      return answer.value
    },
    async say(sessionId, workspaceRoot, text, scope, cycle, node) {
      const answer = await call<Outcome>('addInstruction', { sessionId, workspaceRoot, text, scope, cycle, node })
      return answer.ok ? answer.value : refused(answer.failure)
    },
    async write(verb, sessionId, workspaceRoot, id) {
      const answer = await call<Outcome>(WRITE_ENDPOINTS[verb], { sessionId, workspaceRoot, id })
      return answer.ok ? answer.value : refused(answer.failure)
    },
    async readConfig(sessionId, workspaceRoot) {
      const answer = await call<SuperworkerConfigReading>('readConfig', { sessionId, workspaceRoot })
      if (!answer.ok) throw new RefusedError(answer.failure)
      return answer.value
    },
    async setConfig(sessionId, workspaceRoot, key, value) {
      const answer = await call<Outcome>('setConfig', { sessionId, workspaceRoot, key, value })
      return answer.ok ? answer.value : refused(answer.failure)
    },
    async openNodeSession(sessionId, workspaceRoot, cycle, node) {
      const answer = await call<SessionOpenOutcome>('openNodeSession', { sessionId, workspaceRoot, cycle, node })
      /* The receipt's session id is an address for navigation, not a word the panel shows: a landed open says nothing on the note line, and the re-read that follows shows the session where it belongs. */
      return answer.ok ? { ok: true, text: '' } : refused(answer.failure)
    },
  }
}

/** The remote-namespace path: lays arguments out positionally per the parameter table. */
function remotePort(namespace: Service): PanelPort {
  const call: PortCall = async <T>(
    method: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Answer<T>> => {
    const implementation = namespace[method]
    if (typeof implementation !== 'function') return { ok: false, failure: { code: 'no-operation', detail: method } }
    try {
      const answer = await (implementation as (...values: unknown[]) => Promise<unknown>).call(
        namespace,
        ...positional(method, args),
      )
      return unwrap<T>(answer)
    } catch (error) {
      return { ok: false, failure: { code: 'transport-failed', detail: textOf(error) } }
    }
  }
  return portFromCall('remote', call)
}

/** The carrier layer: assembles endpoint and arguments itself; the answer still wears the `{ ok, value }` shape. */
function carrierPort(rpc: NonNullable<Carrier['rpc']>): PanelPort {
  const call: PortCall = async <T>(
    method: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<Answer<T>> => {
    try {
      const answer = await rpc.call('/api', `${NAMESPACE}/${method}`, { args })
      return unwrap<T>(answer)
    } catch (error) {
      return { ok: false, failure: { code: 'transport-failed', detail: textOf(error) } }
    }
  }
  return portFromCall('carrier', call)
}

/** The port used when neither path connects: every read states the failure outright. */
function absentPort(): PanelPort {
  const missing = async (): Promise<never> => {
    throw new RefusedError({ code: 'not-connected' })
  }
  const refusedWrite = async (): Promise<Outcome> => ({ ok: false, code: 'no-write-channel' })
  return { source: 'none', read: missing, readSessions: missing, say: refusedWrite, write: refusedWrite, readConfig: missing, setConfig: refusedWrite, openNodeSession: refusedWrite }
}

/**
 * Unfolds the `{ ok, value }` shape into the two branches this layer uses.
 *
 * The failure branch carries whatever the far side said. When the host refused with one of its own
 * codes those survive the trip as a `code`; anything else — a transport error, a thrown Error —
 * arrives as a message, which is genuinely another program's words and rides as the detail.
 */
function unwrap<T>(answer: unknown): Answer<T> {
  if (typeof answer !== 'object' || answer === null) return { ok: false, failure: { code: 'unparsable-answer' } }
  const held = answer as { ok?: unknown; value?: unknown; error?: unknown }
  if (held.ok === true) return { ok: true, value: held.value as T }
  return { ok: false, failure: failureIn(held.error) }
}

/** Read a host-side failure out of the answer's `error` field. */
function failureIn(error: unknown): Failure {
  if (typeof error === 'object' && error !== null) {
    const held = error as { message?: unknown; code?: unknown }
    const detail = typeof held.message === 'string' && held.message.length > 0 ? held.message : undefined
    /* A code this half knows is carried through; an unknown one is the host's own vocabulary
     * (DSH's error codes), which this panel has no words for — it says the message instead. */
    const code = typeof held.code === 'string' && Object.hasOwn(KNOWN_CODES, held.code) ? (held.code as Failure['code']) : undefined
    if (code !== undefined) return { code, ...(detail !== undefined ? { detail } : {}) }
    if (detail !== undefined) return { code: 'transport-failed', detail }
  }
  return { code: 'unparsable-answer' }
}

/** The refusal codes this half can spell; a code outside this table is another system's vocabulary.
 * One entry per `FailureCode`, so a code added to the vocabulary fails to compile until it lands here. */
const KNOWN_CODES = {
  'arg-not-allowed': true,
  'tool-refused': true,
  'scope-unknown': true,
  'empty-text': true,
  'no-session-service': true,
  'prompt-missing': true,
  'open-failed': true,
  'dispatch-refused': true,
  'no-operation': true,
  'not-connected': true,
  'no-write-channel': true,
  'unparsable-answer': true,
  'transport-failed': true,
  'config-unreadable': true,
  'config-write-failed': true,
  'settings-refused': true,
  'settings-unwritable': true,
  'unstated': true,
} as const satisfies Readonly<Record<FailureCode, true>>

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}