/**
 * The host half's remote surface: every reading the panel wants and every
 * write leaves this layer through here.
 *
 * Endpoint markers are applied as function calls in the constructor rather
 * than decorator syntax: this source must load directly under Node
 * (`node --test` reads `.ts` that way) and type stripping does not accept
 * `@Remote(...)`.
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for the three services live on each package entry; importing only the `…/types` subpath misses that part. */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertGatewayBinding } from '@deepseek-ai/dsh-typert-protocol'
import { projectRootOf } from 'superworker-core'
import {
  INSTRUCTION_SCOPES,
  instructionAddLine,
  instructionArchiveLine,
  instructionRemoveLine,
  instructionReviveLine,
} from './instruction-lines.ts'
import { readInstructionScopes } from './instruction-scopes.ts'
import type { SuperworkerFrame, SuperworkerReading, SuperworkerReadOptions, SuperworkerRecords } from './contract.ts'
import { openConsultSession, openConductSession, openRouteSession, type SessionOpenOutcome } from './executor.ts'
import type { RecordFailure, RecordOutcome, RecordRefusalCode } from './failure.ts'
import { RecordsPump, stampOf } from './pump.ts'
import { readPoolWeights, type PoolWeightsFolder } from './pool-weights.ts'
import { declaredKnobs, parseConfigList, withDeclaredKnobs, type SuperworkerConfigReading } from './project-config.ts'
import { dispatchCell } from './relay.ts'
import { readReading } from './records.ts'
import { aliveAgentIds, weightsFolderOf, workspaceRootOf } from './seams.ts'
import { readSessionSide, type SuperworkerSessionsReading } from './sessions.ts'
import { runWords } from './write.ts'

/**
 * The scopes an entry can bind to, as this side spells them (`instruction-lines.ts`): the word is
 * forwarded to the plugin that owns the surface instead of being pre-judged here.
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
  'readLineConfig',
  'setLineConfig',
  'unsetLineConfig',
  'readGlobalConfig',
  'setGlobalConfig',
  'readSessions',
  'openNodeSession',
  'consultMigration',
  'consultRoute',
  'consultConduct',
  'watch',
]

/**
 * The endpoints that answer as one stream of items rather than one value: the
 * panel's own channel. Every other endpoint is a plain call.
 */
const STREAM_METHODS: ReadonlySet<string> = new Set(['watch'])

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
 * The verdict a root argument earns once, at this boundary — before any resolver, and before any
 * of the doors below asks the seam's "is this a name" question.
 *
 * The wire delivers whatever a caller handed over (`SuperworkerRecordsGateway`'s parameters are
 * `string` at compile time only), and until this narrowing every value reached the doors: a
 * `['x']` or a `{ length: 1 }` was read as a name by the consult open's own criterion and minted
 * a session whose `cwd` was the array, and a `42` fell through the panel's doors onto the calling
 * session's workspace without a peep. The boundary settles it in one place instead:
 *
 * - a **string** passes verbatim, empty included (`''` stays the panel's "this session's own root");
 * - a value that is **not there at all** — `undefined`, a missing key, `null` — rides on as it
 *   arrived, so every door answers it exactly as it did before this narrowing existed: the panel
 *   doors take their unnamed fallback, the consult open keeps its refuse;
 * - everything else — arrays, plain objects, numbers, booleans, boxed anything — is refused with
 *   the one code (`root-not-string`), before a record is read, a word is run, or a session is
 *   minted. The doors' own "is this a name" readings are not simplified or levelled here: this is
 *   a boundary check in front of them, not a replacement for them.
 */
type RootArgument =
  | { readonly verdict: 'string'; readonly root: string }
  | { readonly verdict: 'absent' }
  | { readonly verdict: 'refused'; readonly detail: string }

function rootArgumentOf(workspaceRoot: unknown): RootArgument {
  if (workspaceRoot === undefined || workspaceRoot === null) return { verdict: 'absent' }
  if (typeof workspaceRoot === 'string') return { verdict: 'string', root: workspaceRoot }
  return { verdict: 'refused', detail: rootArgumentDetailOf(workspaceRoot) }
}

/** The offending argument, as the refusal's `detail` carries it: arrays and objects rendered whole, primitives as their own words. */
function rootArgumentDetailOf(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * The refusal a write or an open answers with: the boundary's one code, the offending value as
 * the detail, and nothing performed — no record moved, no session minted.
 */
function rootArgumentRefusal(detail: string): RecordFailure {
  return { ok: false, code: 'root-not-string', detail }
}

/**
 * The error a read answers with when its root argument is refused: reads throw on an unusable
 * read (`readReading` rethrows real errors the same way), and the code rides on the error so a
 * caller — and a log reader — can tell this refusal from any other.
 */
function rootArgumentRefusedError(detail: string): Error & { readonly code: RecordRefusalCode } {
  const error = new Error(
    `the workspace root this call was handed is ${detail}: not a string, so the boundary refused it before any record was read`,
  ) as Error & { code: RecordRefusalCode }
  error.code = 'root-not-string'
  return error
}

/**
 * The tree the panel's record doors act on: the record-bearing tree itself.
 *
 * A plain directory answers as it is; a linked worktree's checkout leads back to the main tree
 * that really holds `.superworker/` — the engine's own `projectRootOf`, the same function the
 * context injection (`instruction-context.ts`) resolves the account with, so the panel's reading
 * and a session's injected listing are two reads of one record, never two.
 */
function recordRootOf(root: string): string {
  return projectRootOf(undefined, root)
}

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
  /**
   * Attach the marker the gateway reads, in the shape the protocol's types allow: a plain name for a
   * call that answers one value, the options form for a stream (the name and `mode: 'stream'` are the
   * two things a stream endpoint adds).
   */
  const decorate = (STREAM_METHODS.has(method)
    ? Remote({ name: endpoint, mode: 'stream' as const })
    : Remote(endpoint)) as unknown as (fn: unknown, context: unknown) => void
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
  /** The one channel the panel watches: the reading pushed when the records change, never polled. */
  readonly #pump: RecordsPump
  /**
   * Where this package's shipped plugin declarations are read from — the pool's weight table and the
   * instruction account's scope vocabulary both live in that folder; `undefined` is the folder this
   * package ships.
   */
  readonly #weightsFolder: PoolWeightsFolder

  /**
   * @param serviceKey - The service key, i.e. the remote namespace; normally omitted.
   */
  constructor(ctx: Context, serviceKey = 'superworker') {
    this.ctx = ctx
    /* Where the shipped plugin declarations are read from: the folder this package ships, unless this
     * host names another one (`weightsFolderOf` makes that call — this half never spells a `ctx as …`
     * itself). A host that names `null` reads no declaration at all, which is the same reading as a
     * folder with no such plugins in it: no weights, and no scope vocabulary to filter by. */
    this.#weightsFolder = weightsFolderOf(ctx)
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
    this.#pump = new RecordsPump(ctx)
  }

  /**
   * Read the four records of the named workspace.
   *
   * No default values in the parameter list and no trailing comma: the
   * gateway parses parameters from the method source, and either pattern
   * would be judged "unclear signature", disabling the whole endpoint.
   * Omitting the final cancel signal is the same as passing an empty object.
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}: a non-string,
   * non-absent argument is refused before any read), and the reading lands on the
   * record-bearing tree ({@link recordRootOf}) — the same root the context injection reads, so
   * a worktree session's panel and its injected listing are one record.
   * @param sessionId - Session identity; the workspace file gateway resolves paths by it.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async read(sessionId: SessionId, workspaceRoot: string, options?: SuperworkerReadOptions): Promise<SuperworkerReading> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') throw rootArgumentRefusedError(argument.detail)
    const signal = options?.signal ?? NEVER_ABORT
    const root = recordRootOf((await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root)
    /* The two plugin declarations the reading leans on — the pool's weight table and the instruction
     * account's scope vocabulary — are read off the same shipped plugins folder before the records:
     * neither is one of the four records, and both cost a cached lookup after the first frame. */
    const scope = { sessionId, workspaceRoot: root }
    return readReading(
      this.ctx.workspaceFiles,
      scope,
      signal,
      await readPoolWeights(this.#weightsFolder),
      await readInstructionScopes(this.#weightsFolder),
    )
  }

  /**
   * The panel's one channel: the whole reading of this workspace, pushed whenever it changes.
   *
   * This is what every pane draws from — the four records and the session side read at one moment
   * and sent as one frame ({@link SuperworkerFrame}) — so no part of the panel has to decide when to
   * ask again. The first frame goes out at once (a panel that just opened has nothing), then one per
   * change, coalesced by the pump (`pump.ts`): the record directory watched on this host, the
   * session notices, and this half's own writes. A read that fails rides its refusal on a frame, and
   * the stream stays open — a channel that dies on one bad read is a panel that stops updating.
   *
   * The stream ends when the browser stops reading it: the cancellation is the carrier's own, handed
   * to the one parameter the gateway appends.
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}: a non-string, non-absent
   * argument is refused before the channel exists). One stream, two trees when they differ: the
   * frame's records half (the instruction column among them) reads the record-bearing tree
   * ({@link recordRootOf}) — the same record the context injection reads — while the session side
   * reads the root the caller resolved, where the dispatch writes its claims and notes; the pump
   * follows each tree under its own key, so a words write at the record tree and a dispatch's stir
   * at the session root both wake this channel.
   *
   * @param sessionId - Session identity; the workspace file gateway resolves paths by it.
   * @param workspaceRoot - The workspace root to read, absolute; an empty string means this session's own root.
   * @param signal - The stream's cancellation; ending the iteration releases the workspace.
   */
  async *watch(sessionId: SessionId, workspaceRoot: string, signal: AbortSignal): AsyncIterable<SuperworkerFrame> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') throw rootArgumentRefusedError(argument.detail)
    const root = (await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root
    const records = recordRootOf(root)
    /* One tree, one key — the shape every plain session takes. The split below is only for the
       worktree case, where the two halves really live apart. */
    if (records === root) {
      yield* this.#pump.follow(root, (mine) => this.#frameOf(sessionId, root, mine), signal)
      return
    }
    yield* this.#followSplitKeys(sessionId, root, records, signal)
  }

  /**
   * The split-key follow: the two halves of the frame live on two trees, and each tree carries its
   * own wake — the dispatch's stir and its claims at the caller's root, a words write and the
   * records at the record-bearing tree. Two followers, one stream: whichever key wakes first hands
   * over its frame, a frame the other key just carried is not sent twice (the pump's own stamp
   * judges), and ending the iteration or the cancellation releases both roots.
   *
   * A true private, like the write path's `#superworker`: the endpoint table's missing-registration
   * scan reads the prototype, and this is no endpoint of its own.
   */
  async *#followSplitKeys(sessionId: SessionId, root: string, records: string, signal: AbortSignal): AsyncIterable<SuperworkerFrame> {
    type Step = { readonly iterator: AsyncIterator<SuperworkerFrame>; readonly step: IteratorResult<SuperworkerFrame> }
    /* One pending read per follower; a step that lands arms its follower again. A rejection is
       folded into an ended step, so the race below can never sit on a promise nobody handles. */
    const arm = (iterator: AsyncIterator<SuperworkerFrame>): Promise<Step> => iterator.next().then(
      (step): Step => ({ iterator, step }),
      (): Step => ({ iterator, step: { done: true, value: undefined } }),
    )
    const read = (mine: AbortSignal): Promise<SuperworkerFrame> => this.#frameOf(sessionId, root, mine)
    const followers = [root, records].map((key) => this.#pump.follow(key, read, signal))
    const iterators = followers.map((stream) => stream[Symbol.asyncIterator]())
    const armed = new Map(iterators.map((iterator) => [iterator, arm(iterator)]))
    try {
      let previous: string | undefined
      while (!signal.aborted && armed.size > 0) {
        const { iterator, step } = await Promise.race([...armed.values()])
        armed.delete(iterator)
        if (step.done) continue
        const stamp = stampOf(step.value)
        if (stamp !== previous) {
          previous = stamp
          yield step.value
        }
        armed.set(iterator, arm(iterator))
      }
    } finally {
      /* Every follower is taken back, not just the ones still armed: the one whose frame the race
         consumed is suspended at its own yield, holding its root, and nobody will ask it again —
         an ending stream or a cancellation must reach it too, or the pump's watcher outlives the
         channel and keeps the host alive after it. */
      for (const iterator of iterators) {
        void iterator.return?.()?.then(() => undefined, () => undefined)
      }
    }
  }

  /**
   * One frame: the two halves read together, at one moment, each off its own root.
   *
   * A true private, like the write path's `#superworker`: the endpoint table's missing-registration
   * scan reads the prototype, and this is no endpoint of its own.
   * @param workspaceRoot - The root the stream resolved from the caller's argument, and the one the
   * frame names: the session side (notes, claims, tickets) reads here — where the dispatch writes
   * them — while the records half reads the record-bearing tree ({@link recordRootOf}), the same
   * record the context injection reads. On a plain workspace the two roots are one string and the
   * frame is what it always was.
   * @param signal - The read's cancellation.
   */
  async #frameOf(sessionId: SessionId, workspaceRoot: string, signal: AbortSignal): Promise<SuperworkerFrame> {
    const scope = { sessionId, workspaceRoot }
    const recordScope = { sessionId, workspaceRoot: recordRootOf(workspaceRoot) }
    /* The weight table first, then the records weighed by it: it is not one of the four records, but
     * the frame that carries the issues has to carry the table they are weighed by. The read is a
     * module load off the shipped plugin folder — after the first frame it costs a cached lookup — and
     * it never touches the workspace's own files. The scope vocabulary rides the same folder and the
     * same terms: the reading it filters is the one this frame carries. */
    const poolWeights = await readPoolWeights(this.#weightsFolder)
    const instructionScopes = await readInstructionScopes(this.#weightsFolder)
    const [reading, sessions] = await Promise.all([
      readReading(this.ctx.workspaceFiles, recordScope, signal, poolWeights, instructionScopes),
      readSessionSide(this.ctx.workspaceFiles, scope, signal, () => aliveAgentIds(this.ctx)),
    ])
    /* The frame's roster is sampled here — after the whole reading, records and session side alike,
     * has landed: the moment this door sampled it before the session side moved into the assembly.
     * The assembly asks after its own three reads, which can land while `readReading` is still out;
     * that moment is `readSessions`' own, and its endpoint carries it. A frame that carried the
     * assembly's sample would let agents starting or stopping inside that window reach the panel
     * under a sampling moment the frame never stood for, so this path overwrites the slot with one
     * taken now. */
    return { workspaceRoot, at: Date.now(), reading, sessions: { ...sessions, alive: aliveAgentIds(this.ctx) } }
  }

  /**
   * Record an instruction: the user's words are copied verbatim, with the
   * scope named.
   *
   * The line is this side's to spell (`instructionAddLine`): the plugin that
   * owns the `instruction` surface ships with this package and imports nothing
   * from the engine, so the scope vocabulary and the four panel-to-line
   * translations live in `instruction-lines.ts` next to this path. This side
   * forwards the words and reports the words layer's own code; the plugin's
   * `--scope` choices are still the authority on the vocabulary.
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}), and the write lands on the
   * record-bearing tree ({@link recordRootOf}) — the same record the context injection reads — via
   * the shared write path below.
   *
   * The parameter list stays on one line with no trailing comma: the gateway
   * splits method parameters from source, same reason as `read` above.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   * @param cycle - Which cycle to bind, by cycle id; pass an empty string for other scopes.
   */
  async addInstruction(sessionId: SessionId, workspaceRoot: string, text: string, scope: InstructionScope, cycle: string): Promise<RecordOutcome> {
    const line = instructionAddLine({ text, scope, cycle })
    if (!line.ok) {
      return { ok: false, code: line.code, ...(line.detail.length > 0 ? { detail: line.detail } : {}) }
    }
    return this.#superworker(sessionId, workspaceRoot, line.argv, recordRootOf)
  }

  /**
   * Archive an instruction: move it from the active pile in the records into
   * the archive, leaving the sentence itself in place.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async archiveInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, instructionArchiveLine(id), recordRootOf)
  }

  /**
   * Move an archived instruction back into the active pile.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async reviveInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, instructionReviveLine(id), recordRootOf)
  }

  /**
   * Remove an instruction together with its sentence from the records; this cannot be undone.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async removeInstruction(sessionId: SessionId, workspaceRoot: string, id: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, instructionRemoveLine(id), recordRootOf)
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
   * Each entry also carries the candidate words its key's declaration states,
   * read off the engine here and handed along with the reading: the client
   * spells no vocabulary of its own, so an engine edit moves the panel without
   * a client change.
   *
   * The parameter list stays on one line with no trailing comma, same reason as `read`.
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}): a non-string, non-absent
   * argument is refused before the words layer is asked — a refusal of the reading side itself,
   * which this reading answers by throwing, the way every read here answers an unusable read.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async readConfig(sessionId: SessionId, workspaceRoot: string): Promise<SuperworkerConfigReading> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') throw rootArgumentRefusedError(argument.detail)
    const project = (await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root
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
      entries: withDeclaredKnobs(parseConfigList(outcome.text), await declaredKnobs()),
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
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}), but this door does not
   * move to the record-bearing tree: the settings column is the one panel door that reads its own
   * boundary, kept as it is by this node's own terms.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   */
  async setConfig(sessionId: SessionId, workspaceRoot: string, key: string, value: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, ['config', 'set', key, value], (root) => root)
  }

  /**
   * Read what one line can see: the chain named at that line
   * (`config list --cycle`), so the reading carries the line's own policies
   * and every plugin knob that line may override, each with the layer its
   * value in force came from. Which keys those are is the declaration's call
   * and rides on the entries (`layers`); this side spells none of them.
   *
   * The line itself is the engine's to judge: an id that is not on the record
   * comes back as the tool's refusal, on the same reading shape as a failed
   * read here.
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}); the
   * read lands where {@link readConfig} lands.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   * @param cycle - Which line to read, by line id.
   */
  async readLineConfig(sessionId: SessionId, workspaceRoot: string, cycle: string): Promise<SuperworkerConfigReading> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') throw rootArgumentRefusedError(argument.detail)
    const project = (await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root
    const outcome = await runWords(project, ['config', 'list', '--cycle', cycle])
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
      entries: withDeclaredKnobs(parseConfigList(outcome.text), await declaredKnobs()),
    }
  }

  /**
   * Write one setting onto one line's layer (`config set --cycle`): the line's
   * own policies and the plugin knobs a line may override share this one door,
   * and the words layer judges key, value and line. The write stays at the
   * root the caller resolved, the way {@link setConfig} does.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   * @param cycle - Which line to write, by line id.
   */
  async setLineConfig(sessionId: SessionId, workspaceRoot: string, cycle: string, key: string, value: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, ['config', 'set', key, value, '--cycle', cycle], (root) => root)
  }

  /**
   * Take one setting off one line's layer (`config unset --cycle`): the entry
   * is dropped, the next layer of the chain shows through. The one way off for
   * a number / integer / word, and the way to clear a switch's line statement.
   * @param workspaceRoot - The workspace root to write; an empty string means this session's own root.
   * @param cycle - Which line to clear, by line id.
   */
  async unsetLineConfig(sessionId: SessionId, workspaceRoot: string, cycle: string, key: string): Promise<RecordOutcome> {
    return this.#superworker(sessionId, workspaceRoot, ['config', 'unset', key, '--cycle', cycle], (root) => root)
  }

  /**
   * Read the machine layer alone (`config list --global`): the person's own
   * defaults, before any project states anything. This is what the settings
   * page that lives outside any workspace draws — the row for a knob that
   * travels with the person reads this, and writes with
   * {@link setGlobalConfig}.
   *
   * The read still lands in a workspace: the words layer answers settings
   * verbs only where a record directory holds the plugins and the lock, so the
   * caller's session resolves the root, exactly as {@link readConfig} does.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async readGlobalConfig(sessionId: SessionId, workspaceRoot: string): Promise<SuperworkerConfigReading> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') throw rootArgumentRefusedError(argument.detail)
    const project = await this.#globalRoot(sessionId, argument.verdict === 'string' ? argument.root : '')
    const outcome = await runWords(project, ['config', 'list', '--global'])
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
      entries: withDeclaredKnobs(parseConfigList(outcome.text), await declaredKnobs()),
    }
  }

  /**
   * Write one setting onto the machine layer (`config set --global`): the
   * layer that travels with the person and the machine. The landing spot is
   * the home directory's own file, judged by the words layer; no project
   * directory is required.
   * @param workspaceRoot - The workspace root to resolve against; an empty string falls back to the session's root or home directory.
   */
  async setGlobalConfig(sessionId: SessionId, workspaceRoot: string, key: string, value: string): Promise<RecordOutcome> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') return rootArgumentRefusal(argument.detail)
    const root = await this.#globalRoot(sessionId, argument.verdict === 'string' ? argument.root : '')
    const outcome = await runWords(root, ['config', 'set', key, value, '--global'])
    this.#pump.stir(root)
    return outcome
  }

  /**
   * Resolve a directory to hand to `runWords` for machine-layer (`--global`) config calls.
   * Prefers the caller's workspace root when available (so `#pump.stir` wakes any panel watching it),
   * and falls back to the user's home directory when no session or workspace is active.
   */
  async #globalRoot(sessionId: SessionId, named: string): Promise<string> {
    try {
      const resolved = (await workspaceRootOf(this.ctx, { sessionId, named })).root
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    } catch {
      /* Global settings live under the user's home directory and do not require an active workspace. */
    }
    return homedir()
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
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}): a non-string, non-absent
   * argument is refused before any read. This door is not one of the panel's record doors — the
   * notes are read where the caller names, per this node's own boundary.
   * @param workspaceRoot - The workspace root to read; an empty string means this session's own root.
   */
  async readSessions(sessionId: SessionId, workspaceRoot: string, options?: SuperworkerReadOptions): Promise<SuperworkerSessionsReading> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') throw rootArgumentRefusedError(argument.detail)
    const root = (await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root
    const scope = { sessionId, workspaceRoot: root }
    const signal = options?.signal ?? NEVER_ABORT
    return readSessionSide(this.ctx.workspaceFiles, scope, signal, () => aliveAgentIds(this.ctx))
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
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}): a non-string, non-absent
   * argument is refused before the dispatch, so no claim lands and no session is minted on a tree
   * the call never named. This is a session-opening door: the root the caller named is the one it
   * opens at, and the boundary check is the only thing added in front of it.
   * @param workspaceRoot - The workspace to open the session in, absolute; an empty string means this session's own root.
   * @param cycle - Which line this cell sits on, by line id.
   * @param node - Which node to open the session for, by node id.
   */
  async openNodeSession(sessionId: SessionId, workspaceRoot: string, cycle: string, node: string): Promise<SessionOpenOutcome> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') return rootArgumentRefusal(argument.detail)
    const root = (await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root
    const outcome = await dispatchCell(this.ctx, sessionId, root, cycle, node)
    /* A dispatch lands the claim and the session note: the panel that pressed the button sees its own
       dispatch on the next frame instead of on the next page flip. */
    this.#pump.stir(root)
    return outcome
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
   *
   * The root is narrowed once at the boundary ({@link rootArgumentOf}): a non-string, non-absent
   * argument is refused before the open — the array that used to ride into `create()` as the
   * session's `cwd` stops here. A value that is not there at all passes on as it arrived, so the
   * open answers it exactly as it always has. These are session-opening doors: the root the caller
   * named is the one the session opens at.
   * @param workspaceRoot - The workspace to open the session in, absolute; an empty string means this session's own root.
   */
  async consultMigration(sessionId: SessionId, workspaceRoot: string): Promise<SessionOpenOutcome> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') return rootArgumentRefusal(argument.detail)
    return openConsultSession(this.ctx, sessionId, argument.verdict === 'string' ? argument.root : workspaceRoot)
  }

  /**
   * Open the overview's standing corner's two doors: one session of this host's own, at the named
   * workspace, whose first instruction is the bare skill invocation the door is named for. The
   * panel only opens the door — what the session is asked to do is the skill's own opening
   * conversation, so this half carries no reading of the record and judges nothing. The open is
   * the migration consult's own road with another sentence: same probes, same refusals, same
   * silence when it lands.
   *
   * The parameter list stays on one line with no trailing comma, same reason as `read`.
   * @param workspaceRoot - The workspace to open the session in, absolute; an empty string means this session's own root.
   */
  async consultRoute(sessionId: SessionId, workspaceRoot: string): Promise<SessionOpenOutcome> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') return rootArgumentRefusal(argument.detail)
    return openRouteSession(this.ctx, sessionId, argument.verdict === 'string' ? argument.root : workspaceRoot)
  }

  async consultConduct(sessionId: SessionId, workspaceRoot: string): Promise<SessionOpenOutcome> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') return rootArgumentRefusal(argument.detail)
    return openConductSession(this.ctx, sessionId, argument.verdict === 'string' ? argument.root : workspaceRoot)
  }

  /**
   * The single write path shared by the five write endpoints; the true private `#superworker` is not on the prototype, so the endpoint table's missing-registration scan cannot see it.
   *
   * The root argument is narrowed once here for all five ({@link rootArgumentOf}): a non-string,
   * non-absent argument is refused before any word is run, with the boundary's one code. What the
   * resolved root is then worth is the caller's stated difference, hung on `atRecords`: the four
   * instruction verbs hand it {@link recordRootOf}, so their write — and the pump stir that wakes
   * the panel — land on the record-bearing tree, the same record the context injection reads;
   * `setConfig` hands the root through as it resolved, per its own node's terms.
   */
  async #superworker(sessionId: SessionId, workspaceRoot: string, args: readonly string[], atRecords: (root: string) => string): Promise<RecordOutcome> {
    const argument = rootArgumentOf(workspaceRoot)
    if (argument.verdict === 'refused') return rootArgumentRefusal(argument.detail)
    const root = atRecords((await workspaceRootOf(this.ctx, { sessionId, named: argument.verdict === 'string' ? argument.root : '' })).root)
    const outcome = await runWords(root, args)
    /* The write landed on disk a moment ago: the panel's channel is told now rather than waiting for
       its own file change to come back around through the directory watch. */
    this.#pump.stir(root)
    return outcome
  }
}
