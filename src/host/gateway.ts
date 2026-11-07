/**
 * The host half's remote surface: every reading the panel wants and every
 * write leaves this layer through here.
 *
 * Endpoint markers are applied as function calls in the constructor rather
 * than decorator syntax: this source must load directly under Node
 * (`node --test` reads `.ts` that way) and type stripping does not accept
 * `@Remote(...)`.
 */
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for the three services live on each package entry; importing only the `…/types` subpath misses that part. */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
import {
  INSTRUCTION_SCOPES,
  instructionAddLine,
  instructionArchiveLine,
  instructionRemoveLine,
  instructionReviveLine,
} from 'superworker-core'
import type { SuperworkerReading, SuperworkerReadOptions, SuperworkerRecords } from './contract.ts'
import { openConsultSession, type SessionOpenOutcome } from './executor.ts'
import type { RecordOutcome } from './failure.ts'
import { parseConfigList, type SuperworkerConfigReading } from './project-config.ts'
import { dispatchCell } from './relay.ts'
import { readReading } from './records.ts'
import { aliveAgentIds, workspaceRootOf } from './seams.ts'
import { readClaims, readSessionNotes, type SuperworkerSessionsReading } from './sessions.ts'
import { runWords } from './write.ts'

/**
 * The scopes an instruction can bind to, as the engine spells them: this side keeps no list of its
 * own — a fourth scope lands in the engine's table and here at the same time, and the write path
 * below forwards the word instead of pre-judging it.
 */
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number]


/** Endpoint table: each method listed here gets an endpoint of the same name; a method on the class missing from this table fails construction on the spot. */
const REMOTE_METHODS: readonly string[] = [
  'read',
  'addInstruction',
  'archiveInstruction',
  'reviveInstruction',
  'removeInstruction',
  'readConfig',
  'setConfig',
  'readSessions',
  'openNodeSession',
  'consultMigration',
]

/**
 * The signal a read uses when the caller passes none: never cancelled.
 *
 * "Never cancelled" is this layer's standing trade-off (these are all small
 * reads and writes, worth waiting for), but the idiom is declared exactly
 * once in this module; every read that needs it takes it from this constant.
 * A write carries no signal at all: the words layer answers it in this
 * process and is not interruptible.
 */
const NEVER_ABORT = new AbortController().signal

/**
 * Attach an endpoint marker to a method on an instance.
 *
 * A standard decorator hands the marker to a construction-phase initializer
 * callback; here that callback is invoked directly with `this` set to the
 * instance, so the marker lands in the same spot on its prototype — the
 * gateway's marker-reading path cannot tell the two apart.
 */
function markRemote(instance: object, method: string, endpoint: string): void {
  const implementation: unknown = Reflect.get(instance, method)
  const decorate = Remote(endpoint) as unknown as (fn: unknown, context: unknown) => void
  decorate(implementation, {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer: (callback: (this: object) => void) => { callback.call(instance) },
  })
}

/**
 * The face the host half shows the browser half.
 *
 * It does not extend cordis's `Service`: all this class needs is to attach its
 * own name and endpoint markers to itself, which `bindTypertRemote` already
 * covers; one less base class, and the minimal test context can still install
 * it.
 */
export class SuperworkerRecordsGateway implements SuperworkerRecords {
  /** The binding the gateway recognizes endpoints by; its name must match the key given to `ctx.provide`. */
  readonly typertRemote: TypertGatewayBinding<this>
  /** How this half reaches the host context — same name as the `Service` base class field, and the gateway reads from here too. */
  readonly ctx: Context

  /**
   * @param serviceKey - The service key, i.e. the remote namespace; normally omitted.
   */
  constructor(ctx: Context, serviceKey = 'superworker') {
    this.ctx = ctx
    const registered = new Set<string>()
    for (const method of REMOTE_METHODS) {
      markRemote(this, method, method)
      registered.add(method)
    }
    /* Unregistered methods must not fail silently: a callable method on the class (subclasses included) without an endpoint marker would be invisible to the browser half, and nothing would error — turn that from silence into noise by failing construction on the spot. True privates like `#superworker` are not on the prototype, so the scan cannot see them. */
    for (let proto = Object.getPrototypeOf(this); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor' || registered.has(name)) continue
        if (typeof Reflect.get(proto, name) !== 'function') continue
        throw new Error(`the endpoint table is missing an entry: method ${name} is on the class but is not in REMOTE_METHODS, so the browser half cannot see it.`)
      }
    }
    this.typertRemote = bindTypertRemote(this, serviceKey)
  }

  /**
   * Read the four records of the named workspace.
   *
   * No default values in the parameter list and no trailing comma: the
   * gateway parses parameters from the method source, and either pattern
   * would be judged "unclear signature", disabling the whole endpoint.
   * Omitting the final cancel signal is the same as passing an empty object.
   * @param sessionId - Session identity; the workspace file gateway resolves paths by it.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async read(sessionId: SessionId, workspaceRoot: string, options?: SuperworkerReadOptions): Promise<SuperworkerReading> {
    const signal = options?.signal ?? NEVER_ABORT
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    return readReading(this.ctx.workspaceFiles, { sessionId, workspaceRoot: root }, signal)
  }

  /**
   * Record an instruction: the user's words are copied verbatim, with the
   * scope named.
   *
   * The line itself is the engine's to spell (`instructionAddLine`): the scope
   * vocabulary, the switch order, and the refusal of a scope outside it are all
   * facts about that call, so this side forwards the words and reports the
   * engine's own code. Which cycle or node the scope binds to is the panel's
   * call: pass it when named, otherwise the words layer resolves it from the
   * records.
   *
   * The parameter list stays on one line with no trailing comma: the gateway
   * splits method parameters from source, same reason as `read` above.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   * @param cycle - Which cycle to bind, by cycle id; pass an empty string for other scopes.
   * @param node - Which node to bind, by node id; pass an empty string for other scopes.
   */
  async addInstruction(sessionId: SessionId, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string, node: string): Promise<RecordOutcome> {
    const line = instructionAddLine({ text, scope, cycle, node })
    if (!line.ok) {
      return { ok: false, code: line.code, ...(line.detail.length > 0 ? { detail: line.detail } : {}) }
    }
    return this.#superworker(sessionId, workspaceRoot, line.argv)
  }

  /**
   * Archive an instruction: move it from the active pile in the records into
   * the archive, leaving the sentence itself in place.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async archiveInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, instructionArchiveLine(id))
  }

  /**
   * Move an archived instruction back into the active pile.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async reviveInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, instructionReviveLine(id))
  }

  /**
   * Remove an instruction together with its sentence from the records; this cannot be undone.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async removeInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, instructionRemoveLine(id))
  }

  /**
   * Read the project settings of the named workspace.
   *
   * What gets read is the four lines the words layer prints: values live on
   * three layers (factory defaults / global / project), the global layer lives
   * in the home directory where the workspace file gateway cannot look, and
   * only the words layer can tell the effective value and which layer it came
   * from — so this asks it instead of reading a file.
   *
   * The parameter list stays on one line with no trailing comma, same reason as `read`.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async readConfig(sessionId: SessionId, workspaceRoot: string): Promise<SuperworkerConfigReading> {
    const project = await rootFor(this.ctx, sessionId, workspaceRoot)
    const outcome = await runWords(project, ['config', 'list'])
    if (!outcome.ok) {
      return {
        workspaceRoot: project,
        ok: false,
        text: '',
        refusal: { code: outcome.code, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) },
        entries: {},
      }
    }
    return {
      workspaceRoot: project,
      ok: true,
      text: outcome.text,
      refusal: null,
      entries: parseConfigList(outcome.text),
    }
  }

  /**
   * Write one project setting. Always changes the project layer: no
   * `--global`, since that layer follows the user, while this panel cell
   * edits what belongs to this workspace.
   *
   * There is no `--project <root>`: the words answer at the workspace root
   * handed in, and `config set`'s `--project` defaults to that root, so the
   * landing spot is exact; besides, this path builds its own argv and takes no
   * raw line from a browser, so a Windows path needs neither a gate nor
   * quoting — it is one cell the engine reads, not a command line.
   *
   * Value validity is the words layer's call: its `parse_value` is the only
   * judge, and a non-zero answer means nothing was written. Keys get the same
   * treatment: only the engine knows which keys it accepts, so no allow-list is
   * kept here — key and value are passed through as-is; for an unknown key it
   * errors, answers non-zero, writes nothing, and its message surfaces verbatim.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async setConfig(sessionId: SessionId, workspaceRoot: string, key: string, value: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, ['config', 'set', key, value])
  }

  /**
   * Bring back the session side of the named workspace's layer, verbatim:
   * the per-node note files, the dispatch claims on disk (`started` markers
   * under the launch cells), and which sessions have a live agent in this
   * host right now. Session identity lives on this machine's own notes, and
   * a session exists only on the machine that opened it. Like the four
   * records, this lives in the workspace, so the notes and the claims go
   * through the same read-only gateway; the live-agents half comes from the
   * host's own registry and answers `null` when this host cannot say. This
   * only moves the data — which cell is stranded (claim on disk, session
   * gone) is the model layer's call.
   *
   * The parameter list stays on one line with no trailing comma, same reason as `read`.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async readSessions(sessionId: SessionId, workspaceRoot: string, options?: SuperworkerReadOptions): Promise<SuperworkerSessionsReading> {
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    const scope = { sessionId, workspaceRoot: root }
    const signal = options?.signal ?? NEVER_ABORT
    const [reading, claims] = await Promise.all([
      readSessionNotes(this.ctx.workspaceFiles, scope, signal),
      readClaims(this.ctx.workspaceFiles, scope, signal),
    ])
    return { ...reading, claims, alive: aliveAgentIds(this.ctx) }
  }

  /**
   * Dispatch, natively, the cell of one line: the engine lands the plan's
   * launch prompt (when it is not already on disk), this host opens the
   * session through its own opener, and the `started` claim lands with the
   * dispatch — the same marks, in the same order, whatever pressed it. The
   * panel's button and the automatic relay both walk this one path
   * (`relay.ts`), so a cell opened by hand is as real to the plan as one the
   * relay opened, and a second call for the same cell answers instead of
   * opening a second session.
   *
   * The workspace-touching steps (create, note) run one at a time per
   * workspace — two opens on one workspace never race their sessions or
   * their notes — and dispatches process-wide run one at a time. A host
   * without its session side is refused up front, with the missing piece
   * named; a dispatch the engine refuses carries its reason verbatim as the
   * `dispatch-refused` detail. The parameter list stays on one line with no
   * trailing comma, same reason as `read`.
   * @param workspaceRoot - The workspace to open the session in, absolute; an empty string means this session's own root.
   * @param cycle - Which line this cell sits on, by line id.
   * @param node - Which node to open the session for, by node id.
   */
  async openNodeSession(sessionId: SessionId, workspaceRoot: string, cycle: string, node: string): Promise<SessionOpenOutcome> {
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    return dispatchCell(this.ctx, sessionId, root, cycle, node)
  }

  /**
   * Open the consult session the panel's legacy notice links to: one session of
   * this host's own, at the named workspace, whose first instruction is the
   * engine's fixed consult sentence. The panel only opens the door — what the
   * session is asked to do is the engine's sentence, spelled in one place there
   * so this half never carries a second copy of it. The open shares the node
   * open's sides (agent registry, standing preset, workspace attach, tool arm)
   * and answers its own refusals as codes, the way every open here does.
   *
   * The parameter list stays on one line with no trailing comma, same reason as `read`.
   * @param workspaceRoot - The workspace to open the session in, absolute; an empty string means this session's own root.
   */
  async consultMigration(sessionId: SessionId, workspaceRoot: string): Promise<SessionOpenOutcome> {
    return openConsultSession(this.ctx, sessionId, workspaceRoot)
  }

  /**
   * The single write path shared by the five write endpoints; the true private `#superworker` is not on the prototype, so the endpoint table's missing-registration scan cannot see it.
   */
  async #superworker(sessionId: SessionId, workspaceRoot: string, args: readonly string[], said?: string): Promise<RecordOutcome> {
    const root = await rootFor(this.ctx, sessionId, workspaceRoot)
    return runWords(root, args, said)
  }
}

/**
 * Which workspace root this operation touches: use the caller-named one when
 * given; only when not named (empty string, or the parameter absent entirely)
 * resolve it from the session identity.
 *
 * Named-first is the whole point of this layer: which workspace the session
 * currently sits in has nothing to do with which one the reader wants to see.
 * @param workspaceRoot - The named workspace root, absolute; an empty string means not named.
 */
export async function rootFor(ctx: Context, sessionId: SessionId, workspaceRoot: string): Promise<string> {
  if (typeof workspaceRoot === 'string' && workspaceRoot.length > 0) return workspaceRoot
  return workspaceRootOf(ctx, sessionId)
}