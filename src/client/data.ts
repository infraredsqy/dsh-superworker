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
import type { SuperworkerFrame, SuperworkerReading } from '../host/contract.ts'
import type { SuperworkerConfigReading } from '../host/project-config.ts'
import type { SuperworkerSessionsReading } from '../host/sessions.ts'
import type { InstructionScope } from '../host/gateway.ts'
import type { SessionOpenOutcome } from '../host/executor.ts'
import { report } from './context.ts'
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
  /**
   * The one channel: every reading this panel draws, pushed when the records change.
   *
   * A frame carries the four records and the record's session side read at one moment, so no pane
   * keeps its own fetch beat. The first frame arrives on the spot — a panel that just opened has
   * nothing to draw until it does — and later ones when the host sees a change: the record directory
   * changing, a session notice, or one of this panel's own writes. A channel that cannot be opened
   * (this deployment carries no stream) answers one frame and then silence, and the panel's own
   * writes ask again; nothing here polls.
   * @param onFrame - Called for each frame, in order, until the returned disposer is called.
   * @returns The cancellation: no frame arrives after it, and the host's stream is closed.
   */
  watch(sessionId: string, workspaceRoot: string, onFrame: (frame: SuperworkerFrame) => void): () => void
  /** Read the four records of the named workspace; rejects with a {@link RefusedError} when it cannot. */
  read(sessionId: string, workspaceRoot: string): Promise<SuperworkerReading>
  /** The most recent session opened for each cell in the named workspace: where card clicks go. */
  readSessions(sessionId: string, workspaceRoot: string): Promise<SuperworkerSessionsReading>
  /** Record an instruction: hand the user's verbatim text and scope to the tool. */
  say(sessionId: string, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string): Promise<Outcome>
  /** Archive / revive / delete an instruction. */
  write(verb: WriteVerb, sessionId: string, workspaceRoot: string, id: string): Promise<Outcome>
  /** The named workspace's project settings: effective values and which layer each lives on, from the tool's command. */
  readConfig(sessionId: string, workspaceRoot: string): Promise<SuperworkerConfigReading>
  /** Write one project setting; it always lands on this project's layer. */
  setConfig(sessionId: string, workspaceRoot: string, key: string, value: string): Promise<Outcome>
  /** What one line can see: the chain named at that line, its own policies included. */
  readLineConfig(sessionId: string, workspaceRoot: string, cycle: string): Promise<SuperworkerConfigReading>
  /** Write one setting onto one line's layer. */
  setLineConfig(sessionId: string, workspaceRoot: string, cycle: string, key: string, value: string): Promise<Outcome>
  /** Take one setting off one line's layer, letting the next layer show through. */
  unsetLineConfig(sessionId: string, workspaceRoot: string, cycle: string, key: string): Promise<Outcome>
  /** The machine layer alone: the person's own defaults, before any project states anything. */
  readGlobalConfig(sessionId: string, workspaceRoot: string): Promise<SuperworkerConfigReading>
  /** Write one setting onto the machine layer. */
  setGlobalConfig(sessionId: string, workspaceRoot: string, key: string, value: string): Promise<Outcome>
  /** Open, on the host, the session that works one node of one line: the plan's prompt goes in as the first instruction. */
  openNodeSession(sessionId: string, workspaceRoot: string, cycle: string, node: string): Promise<Outcome>
  /** Hand a legacy record directory's migration to an agent: the host opens the session that does it. */
  consultMigration(sessionId: string, workspaceRoot: string): Promise<Outcome>
  /** Open the standing corner's route door: one session whose first word is the bare `/sw-route`. */
  consultRoute(sessionId: string, workspaceRoot: string): Promise<Outcome>
  /** Open the standing corner's conduct door: one session whose first word is the bare `/sw-conduct`. */
  consultConduct(sessionId: string, workspaceRoot: string): Promise<Outcome>
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

/**
 * The port the panel is handed, plus the one move the rest of this layer needs from it.
 *
 * `refresh` re-resolves which layer is available and keeps the better one: the namespace is mounted
 * asynchronously (see `remote-mount.ts`), so a port created during `apply` starts on whatever the
 * carrier layer offers and moves to the mounted namespace when that mount lands. Every open channel
 * is re-opened on the better layer as it moves, so a panel that opened before the mount finished
 * ends up on the stream rather than staying on the one-frame road for its whole life.
 */
export interface LivePanelPort extends PanelPort {
  /** Re-read the available layers; upgrades in place, and returns whether the layer changed. */
  refresh(): boolean
}

/** Which layer is better: a mounted namespace beats the carrier, and anything beats nothing. */
const RANK: Readonly<Record<PanelPort['source'], number>> = { none: 0, carrier: 1, remote: 2 }

export function createPanelPort(ctx: unknown): LivePanelPort {
  return livePortOf(ctx, resolvedPort(ctx))
}

/**
 * Which port the context can offer right now: the mounted namespace first, the carrier underneath it
 * (so a deployment without the namespace still reads), and nothing when neither is there.
 */
function resolvedPort(ctx: unknown): PanelPort {
  const remote = remoteNamespace(ctx)
  if (remote !== undefined) return remotePort(remote)
  const carrier = serviceAt(ctx, 'connection') as Carrier | undefined
  if (carrier?.rpc !== undefined) return carrierPort(carrier.rpc)
  return absentPort()
}

/**
 * Wrap one layer in the live port the panel holds.
 *
 * The wrapper exists for the async mount: a layer that arrives after `apply` has to reach a channel
 * that is already open. Every open channel keeps its own cancellation and its own restart, so the
 * disposer the panel was handed stays the one it calls and no channel is ever opened twice at once.
 * @param ctx - The browser-half plugin context, kept for the re-resolution.
 * @param first - The layer available at assembly time.
 */
function livePortOf(ctx: unknown, first: PanelPort): LivePanelPort {
  let current = first
  const restarts = new Set<() => void>()
  const port: Record<string, unknown> = {
    get source() {
      return current.source
    },
    refresh() {
      const found = resolvedPort(ctx)
      if (RANK[found.source] <= RANK[current.source]) return false
      current = found
      for (const restart of [...restarts]) restart()
      return true
    },
    watch(sessionId: string, workspaceRoot: string, onFrame: (frame: SuperworkerFrame) => void) {
      let live = true
      let off = current.watch(sessionId, workspaceRoot, onFrame)
      const restart = () => {
        if (!live) return
        off()
        off = current.watch(sessionId, workspaceRoot, onFrame)
      }
      restarts.add(restart)
      return () => {
        live = false
        restarts.delete(restart)
        off()
      }
    },
  }
  /* The calling methods forward to whichever layer is in force at call time — the same face table
   * the port itself is generated from, so a method added there is forwarded here on its own. */
  for (const method of Object.keys(PANEL_FACE)) {
    port[method] = (...parts: unknown[]) => {
      const layer = current as unknown as Readonly<Record<string, unknown>>
      return (layer[method] as (...ps: unknown[]) => unknown).apply(layer, parts)
    }
  }
  return port as unknown as LivePanelPort
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

/** The endpoints the host answers as one stream of items; every other one is a plain call. */
export const REMOTE_STREAMS: ReadonlySet<string> = new Set(['watch'])

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
 *
 * Exported because the Client contribution this plugin mounts is built from it (`remote-mount.ts`):
 * the descriptor's wire fields have to be these names in this order, or the host's gateway judges
 * the whole endpoint unreadable.
 */
export const REMOTE_PARAM_ORDER: Readonly<Record<string, readonly string[]>> = {
  watch: ['sessionId', 'workspaceRoot'],
  read: ['sessionId', 'workspaceRoot', 'options'],
  readSessions: ['sessionId', 'workspaceRoot'],
  addInstruction: ['sessionId', 'workspaceRoot', 'text', 'scope', 'cycle'],
  archiveInstruction: ['sessionId', 'workspaceRoot', 'id'],
  reviveInstruction: ['sessionId', 'workspaceRoot', 'id'],
  removeInstruction: ['sessionId', 'workspaceRoot', 'id'],
  readConfig: ['sessionId', 'workspaceRoot'],
  setConfig: ['sessionId', 'workspaceRoot', 'key', 'value'],
  readLineConfig: ['sessionId', 'workspaceRoot', 'cycle'],
  setLineConfig: ['sessionId', 'workspaceRoot', 'cycle', 'key', 'value'],
  unsetLineConfig: ['sessionId', 'workspaceRoot', 'cycle', 'key'],
  readGlobalConfig: ['sessionId', 'workspaceRoot'],
  setGlobalConfig: ['sessionId', 'workspaceRoot', 'key', 'value'],
  openNodeSession: ['sessionId', 'workspaceRoot', 'cycle', 'node'],
  consultMigration: ['sessionId', 'workspaceRoot'],
  consultRoute: ['sessionId', 'workspaceRoot'],
  consultConduct: ['sessionId', 'workspaceRoot'],
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

/**
 * One open stream as this layer holds it: the items it delivers, and its own cancellation. DSH's
 * generated stream handle is this shape (`AsyncIterable` plus `dispose`); only these two things are
 * named here, because the browser half must not carry the protocol's types into its bundle.
 */
interface StreamHandle<T> extends AsyncIterable<T> {
  dispose?: () => void
}

/**
 * Opening one stream endpoint: the method name, the named arguments, and the sink each item lands
 * in. Answers the cancellation, so the two paths keep one shape for the panel.
 */
type StreamOpen = (
  method: string,
  args: Readonly<Record<string, unknown>>,
  onItem: (item: unknown) => void,
) => () => void

/** A frame that carries why it could not read: the panel keeps the last reading it had and says the refusal. */
function refusalFrame(workspaceRoot: string, failure: Failure): SuperworkerFrame {
  return {
    workspaceRoot,
    at: Date.now(),
    reading: null,
    sessions: null,
    failure: { code: failure.code, ...(failure.detail !== undefined ? { detail: failure.detail } : {}) },
  }
}

/** A refusal in the shape a write hands back, without the `ok` tag the reading already carries. */
function refused(failure: Failure): Outcome {
  return { ok: false, code: failure.code, ...(failure.detail !== undefined ? { detail: failure.detail } : {}) }
}

/**
 * What one open session leaves on this side: nothing when a session is out, the host's own refusal
 * when it is not.
 *
 * An open's answer is a *value* (`SessionOpenOutcome`), not an envelope failure, so its `ok` has to
 * be unfolded here — reading only the envelope would report a refused open as a landed one and the
 * panel's note line would stay silent about the reason. A landed open says nothing at all: the
 * session appearing in DSH is the whole effect and its session id is a navigation address, never a
 * word the panel shows — so the id rides the outcome for the caller to navigate by, and no part of
 * it reaches the note line.
 */
function openOutcome(answer: Answer<SessionOpenOutcome>): Outcome {
  if (!answer.ok) return refused(answer.failure)
  return answer.value.ok ? { ok: true, text: '', session: answer.value.session } : refused(answer.value)
}

/**
 * How a row's answer unfolds for the method that made it: `reject` throws a {@link RefusedError}
 * (a caller awaiting a reading has nowhere to put a failure but the rejection), `refuse` answers
 * the failure as an `Outcome` (its callers place the reason on the note line and carry on), and
 * `open` unfolds a door open through {@link openOutcome}.
 */
type Unfold = 'reject' | 'refuse' | 'open'

/** The methods that call through: every one of the port's but the `source` tag and the `watch` channel. */
type PanelMethod = Exclude<keyof PanelPort, 'source' | 'watch'>

/** One row of the face table as the generation loop reads it: the loose shape at the seam. */
interface PanelFace {
  /** The host endpoint the method lands on; `write` resolves its own per verb (`WRITE_ENDPOINTS`). */
  readonly endpoint: string | Readonly<Record<WriteVerb, string>>
  readonly unfold: Unfold
  readonly args: (...parts: readonly unknown[]) => Readonly<Record<string, unknown>>
}

/** One row checked against the method's own signature, so an args builder that stops matching the
 * `PanelPort` face fails to compile on its own. */
type FaceOf<M extends PanelMethod> = PanelPort[M] extends (...parts: infer P) => unknown
  ? {
    readonly endpoint: string | Readonly<Record<WriteVerb, string>>
    readonly unfold: Unfold
    readonly args: (...parts: P) => Readonly<Record<string, unknown>>
  }
  : never

/**
 * The port's one table: each calling method's route — which host endpoint it lands on, how the
 * answer unfolds, and how the method's arguments lay out as the endpoint's named arguments. The
 * three port implementations are generated from it (`portFromCall`, `livePortOf`'s forwarding,
 * `absentPort`), so adding an endpoint touches this table, the `PanelPort` face and
 * `REMOTE_PARAM_ORDER` — and nothing else.
 */
const PANEL_FACE = {
  read: {
    endpoint: 'read',
    unfold: 'reject',
    args: (sessionId: string, workspaceRoot: string) => readArgs(sessionId, workspaceRoot),
  },
  readSessions: {
    endpoint: 'readSessions',
    unfold: 'reject',
    args: (sessionId: string, workspaceRoot: string) => ({ sessionId, workspaceRoot }),
  },
  say: {
    endpoint: 'addInstruction',
    unfold: 'refuse',
    args: (sessionId: string, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string) => ({ sessionId, workspaceRoot, text, scope, cycle }),
  },
  write: {
    endpoint: WRITE_ENDPOINTS,
    unfold: 'refuse',
    args: (_verb: WriteVerb, sessionId: string, workspaceRoot: string, id: string) => ({ sessionId, workspaceRoot, id }),
  },
  readConfig: {
    endpoint: 'readConfig',
    unfold: 'reject',
    args: (sessionId: string, workspaceRoot: string) => ({ sessionId, workspaceRoot }),
  },
  setConfig: {
    endpoint: 'setConfig',
    unfold: 'refuse',
    args: (sessionId: string, workspaceRoot: string, key: string, value: string) => ({ sessionId, workspaceRoot, key, value }),
  },
  readLineConfig: {
    endpoint: 'readLineConfig',
    unfold: 'reject',
    args: (sessionId: string, workspaceRoot: string, cycle: string) => ({ sessionId, workspaceRoot, cycle }),
  },
  setLineConfig: {
    endpoint: 'setLineConfig',
    unfold: 'refuse',
    args: (sessionId: string, workspaceRoot: string, cycle: string, key: string, value: string) => ({ sessionId, workspaceRoot, cycle, key, value }),
  },
  unsetLineConfig: {
    endpoint: 'unsetLineConfig',
    unfold: 'refuse',
    args: (sessionId: string, workspaceRoot: string, cycle: string, key: string) => ({ sessionId, workspaceRoot, cycle, key }),
  },
  readGlobalConfig: {
    endpoint: 'readGlobalConfig',
    unfold: 'reject',
    args: (sessionId: string, workspaceRoot: string) => ({ sessionId, workspaceRoot }),
  },
  setGlobalConfig: {
    endpoint: 'setGlobalConfig',
    unfold: 'refuse',
    args: (sessionId: string, workspaceRoot: string, key: string, value: string) => ({ sessionId, workspaceRoot, key, value }),
  },
  openNodeSession: {
    endpoint: 'openNodeSession',
    unfold: 'open',
    /* The receipt's session id is an address for navigation, not a word the panel shows: a landed open says nothing on the note line, and the re-read that follows shows the session where it belongs. */
    args: (sessionId: string, workspaceRoot: string, cycle: string, node: string) => ({ sessionId, workspaceRoot, cycle, node }),
  },
  consultMigration: {
    endpoint: 'consultMigration',
    unfold: 'open',
    /* The same silence as an opened node session: a landed consult renders nothing here — the
     * new session appearing in DSH is the whole effect, and the migration itself happens over
     * there, so a re-read could only repeat this panel's own notice. */
    args: (sessionId: string, workspaceRoot: string) => ({ sessionId, workspaceRoot }),
  },
  consultRoute: {
    endpoint: 'consultRoute',
    unfold: 'open',
    /* And the same silence: the session the door opens appears in DSH, which is the whole
     * effect — what it is asked to do is the skill's own opening conversation, so a re-read
     * could only repeat this corner's own state. */
    args: (sessionId: string, workspaceRoot: string) => ({ sessionId, workspaceRoot }),
  },
  consultConduct: {
    endpoint: 'consultConduct',
    unfold: 'open',
    /* And the same silence: the door's session appears in DSH with the bare `/sw-conduct` as its
     * first word, which is the whole effect — what it is asked to do is that conversation's own
     * work, so a re-read could only repeat this corner's own state. */
    args: (sessionId: string, workspaceRoot: string) => ({ sessionId, workspaceRoot }),
  },
} satisfies { readonly [M in PanelMethod]: FaceOf<M> }

/** The endpoint a row lands on; the verb-shaped row resolves its own per verb (`WRITE_ENDPOINTS`). */
function endpointOf(face: PanelFace, parts: readonly unknown[]): string {
  if (typeof face.endpoint === 'string') return face.endpoint
  return face.endpoint[parts[0] as WriteVerb]
}

/** One call through a row: the arguments laid out as the endpoint names them, the answer unfolded per the row's mode. */
async function faceCall(face: PanelFace, parts: readonly unknown[], call: PortCall): Promise<unknown> {
  const answer = await call<unknown>(endpointOf(face, parts), face.args(...parts))
  switch (face.unfold) {
    case 'reject':
      if (!answer.ok) throw new RefusedError(answer.failure)
      return answer.value
    case 'refuse':
      return answer.ok ? answer.value : refused(answer.failure)
    case 'open':
      return openOutcome(answer as Answer<SessionOpenOutcome>)
  }
}

/**
 * The common skeleton of the panel's port: the `watch` channel written once, and every calling
 * method generated from {@link PANEL_FACE}, with the two paths differing only in the `call` layer.
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
function portFromCall(source: PanelPort['source'], call: PortCall, stream?: StreamOpen | undefined): PanelPort {
  const port: Record<string, unknown> = {
    source,
    watch(sessionId: string, workspaceRoot: string, onFrame: (frame: SuperworkerFrame) => void) {
      if (stream !== undefined) {
        try {
          return stream('watch', { sessionId, workspaceRoot }, (item) => {
            if (item !== null && typeof item === 'object') onFrame(item as SuperworkerFrame)
          })
        } catch (error) {
          /* The name is mounted but cannot be opened as a stream: the one-frame road below is the
             reading this panel still gets, rather than an empty stage that says nothing at all. It
             leaves a trace, because a namespace that was mounted with the wrong descriptor shape
             looks exactly like a deployment that carries no stream at all — and this line is the
             only place the two can be told apart. */
          report('the mounted watch endpoint cannot be opened as a stream, falling back to one read', error)
        }
      }
      /* This deployment carries no stream: one frame, read the old way, and silence after it. The
         panel's own writes re-subscribe, which is the whole retry — nothing here polls, and no
         second implementation of the reading is kept just for this path. */
      let live = true
      void (async () => {
        try {
          const [reading, sessions] = await Promise.all([
            call<SuperworkerReading>('read', readArgs(sessionId, workspaceRoot)),
            call<SuperworkerSessionsReading>('readSessions', { sessionId, workspaceRoot }),
          ])
          if (!live) return
          if (!reading.ok) {
            onFrame(refusalFrame(workspaceRoot, reading.failure))
            return
          }
          if (!sessions.ok) {
            onFrame(refusalFrame(workspaceRoot, sessions.failure))
            return
          }
          onFrame({ workspaceRoot, at: Date.now(), reading: reading.value, sessions: sessions.value })
        } catch (error) {
          if (!live) return
          onFrame({ workspaceRoot, at: Date.now(), reading: null, sessions: null, failure: { code: 'transport-failed', detail: textOf(error) } })
        }
      })()
      return () => { live = false }
    },
  }
  for (const [method, face] of Object.entries(PANEL_FACE) as readonly [string, PanelFace][]) {
    port[method] = async (...parts: unknown[]) => faceCall(face, parts, call)
  }
  /* The seam: the row shapes were checked against the `PanelPort` face by the table's own
   * `satisfies` clause, so the assembled record is cast back to the interface here. */
  return port as unknown as PanelPort
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
  return portFromCall('remote', call, streamOf(namespace))
}

/**
 * The mounted namespace's stream endpoint, opened as this layer's own {@link StreamOpen}.
 *
 * Absent when the deployment mounted no such method (an older host): the port then serves the one
 * frame path, and the panel keeps working without a channel rather than inventing one.
 * @param namespace - The mounted remote namespace.
 */
function streamOf(namespace: Service): StreamOpen | undefined {
  const open = namespace['watch']
  if (typeof open !== 'function') return undefined
  return (method, args, onItem) => {
    const opened = (open as (...values: unknown[]) => StreamHandle<unknown>).call(namespace, ...positional(method, args))
    /* A host that mounted this name as a plain call would hand back a promise: reading it as a stream is
       not this layer's to guess. Say so on the spot, and the caller keeps the one-frame road. */
    if (opened === null || typeof opened !== 'object' || typeof (opened as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('the mounted watch endpoint is not a stream')
    }
    let live = true
    void (async () => {
      try {
        for await (const item of opened) {
          if (!live) return
          onItem(item)
        }
      } catch {
        /* The carrier was lost: the last frame stays on screen, and the panel's own writes ask again. */
      }
    })()
    return () => {
      live = false
      try {
        opened.dispose?.()
      } catch {
        /* The handle is finished either way. */
      }
    }
  }
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
  const port: Record<string, unknown> = { source: 'none', watch: () => () => undefined }
  /* A read face (which rejects through a real port) throws here too; the write and door faces
   * refuse, each with its own code. The face table keeps the two vocabularies from drifting. */
  for (const [method, face] of Object.entries(PANEL_FACE) as readonly [string, PanelFace][]) {
    port[method] = face.unfold === 'reject' ? missing : refusedWrite
  }
  /* The seam: the row shapes were checked against the `PanelPort` face by the table's own
   * `satisfies` clause, so the assembled record is cast back to the interface here. */
  return port as unknown as PanelPort
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
  'root-not-string': true,
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