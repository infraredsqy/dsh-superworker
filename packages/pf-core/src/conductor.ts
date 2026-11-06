import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDagNamespace } from './dag';
import { nowSeconds } from './clock';
import { pluginAssemblyOf } from './plugins/assembly';
import type { PluginAssembly } from './plugins/assembly';
import { createContext, readGraphSnapshot, warnLine } from './plugins/context';
import { collectGates, collectOffers } from './plugins/host';
import { applyInsertion } from './plugins/insertion';
import {
  commandClashes,
  implOf,
  pluginListing,
  pluginsDirOf,
  previewGaps,
  routableCommands,
  shadowedKnobs,
  verifyPlugins,
} from './plugins/registry';
import type { DispatchRequest, Executor, OpenedSession } from './executor';
import { envModel, envSpawnDryRun } from './env';
import { PfError } from './errors';
import type { GitResult, GitRunner } from './git';
import { atomicWriteBytes, atomicWriteJson, EOL, jsonOptionsForRecord, readJsonFile } from './jsonio';
import {
  assertLedgerInitialized,
  MERGE_DRIVER_NAME_FORM,
  MERGE_DRIVER_PF_FORM,
  namedDriverCommand,
  readAbsoluteForm,
  resolvesOnPath,
} from './initledger';
import { pinSlots, planNext, promptTextOf, settleClose } from './planner';
import { prepareDispatch, ticketReadings } from './prepare';
import type { PreparedDispatch } from './prepare';
import { launchPromptPath, PF_DIR_NAME, pfPaths, signalPath, startedMarkerPath, type PfPaths } from './paths';
import type { DagNamespace } from './ledger';
import type { CycleRecord, HandoffRecord, NodeMode, NodeResult } from './types';
import type { PluginCommandEntry, PluginContext, PluginFolder } from './plugins/types';
import { withLedgerLock } from './ledgerlock';
import { createCyclesNamespace, cycleHoldingIds, cyclePolicy } from './cycles';

/** The verdict words a handoff ticket takes: these three only (`pending` is the marker a re-run leaves, coming from the re-run verb, not from a session). */
const HANDOFF_RESULTS: readonly NodeResult[] = ['completed', 'failed', 'stopped'];

/**
 * The exit for WARNING lines on the tolerant path: close / dispatch hang each line a broken plugin folds
 * into on the **return value** (a module-level WeakMap, the record object itself keeps every byte), and
 * `warningsOf` reads it back out. The frozen surface has no warning channel (the return types may not
 * change), and this is the way to get warnings out to the caller without touching the types.
 */
const warningsByResult = new WeakMap<object, readonly string[]>();

/** Read the WARNING lines hung on the return value of a close / dispatch (an empty table when there are none). */
export function warningsOf(result: object): readonly string[] {
  return warningsByResult.get(result) ?? [];
}

/** Which line and which node to answer about; by default the line currently in service is read. */
export interface ConductorTarget {
  cycle?: string;
  node?: string;
}

/**
 * What one dispatch names on the call itself: the line, the node and the model route. The route
 * resolves the most specific answer first: the call's own name beats the line's `model` policy, which
 * beats the machine's switch (`DSH_CONDUCT_MODEL`); left out, the executor's own default opens the
 * session. The model is the ecosystem's route spelling (`provider/model`), carried whole.
 */
export interface ConductorDispatchInput extends ConductorTarget {
  model?: string;
}

/**
 * What one advance names on the call itself: which line, and — handed down to every session it opens — the
 * model route. The line defaults to the one active line, as every verb of this namespace does.
 */
export interface ConductorAdvanceInput extends ConductorTarget {
  model?: string;
  /**
   * Whether this step opens sessions. alse claims the free slots and lands their material only — what a
   * process with no opener can do, and what close asks for. Absent means 	rue.
   */
  openSessions?: boolean;
}

/**
 * What one advance did, step by step: the nodes it claimed for the line, the cells it handed to the
 * executor (with their receipts), whether it turned the line out of service, and the plan read after the
 * steps — the line's state as the next caller will read it.
 */
export interface AdvanceReceipt {
  readonly cycle: string;
  /** The nodes this call pinned (empty when there was no free slot, or nothing in the picking range). */
  readonly pinned: readonly string[];
  /** The cells this call dispatched, in plan order; `receipt.action` says opened or already open. */
  readonly dispatches: ReadonlyArray<{ node_id: string; receipt: DispatchReceipt }>;
  /** Whether this call parked the line (a stop with nothing left in hand). */
  readonly parked: boolean;
  /** The plan read after these steps. */
  readonly plan: NextPlan;
}

/**
 * The receipt of one dispatch: the node was handed to a session, and that is all this says.
 *
 * `action` has two words. `opened` — a session was opened just now, and `session` is its receipt.
 * `already_open` — the claim of an earlier dispatch is on disk for this (line, node), so this call
 * opened nothing and wrote nothing; `session` is absent because that receipt belongs to the call
 * that opened it. The node's result is not in here: the worker files its ticket (`conductor.handoff`)
 * and `conductor.close` settles it.
 */
export interface DispatchReceipt {
  action: 'opened' | 'already_open';
  cycle: string;
  node_id: string;
  node_title: string;
  /** Where this node's prompt lives (`<pf>/meta/launch/<line>/<node>/prompt.txt`). */
  prompt: string;
  /** The one line that file holds. */
  prompt_text: string;
  /** The session this call opened; absent on `already_open`. */
  session?: OpenedSession;
}

/**
 * What one dispatch's rehearsal answers (`dispatchPreview`): the cell as the executor would receive it, with
 * nothing written and nothing opened. `material` says whether the prompt is already on disk or the real dispatch
 * would land it; `blocked` carries the lines a dispatch-time plugin gate would refuse with, in the same shape the
 * real refusal prints (a rehearsal answers them instead of throwing, since refusing is the thing being rehearsed).
 */
export interface DispatchPreview {
  readonly action: 'dispatch';
  readonly dry_run: true;
  readonly cycle: string;
  readonly node_id: string;
  readonly node_title: string;
  /** Where the prompt lives (`<pf>/meta/launch/<line>/<node>/prompt.txt`). */
  readonly prompt: string;
  /** The one line that file holds (or would hold). */
  readonly prompt_text: string;
  readonly material: 'on_disk' | 'to_land';
  readonly model?: string;
  readonly blocked: readonly string[];
  readonly warnings: readonly string[];
}

/** One insertion a close-time plugin says it would make, as a rehearsal reads it (the node has no uuid yet, so no body). */
export interface SettlePreviewSeam {
  readonly plugin: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly note: string;
  readonly why: string;
}

/**
 * What one settle's rehearsal answers (`settlePreview`): the step the verdict would write into `path`, the graph
 * mark, which freed slot the line would fill, what the close-time seam would insert and in front of which node, and
 * the plan the line would read afterwards — with not one record written.
 */
export interface SettlePreview {
  readonly action: 'settle';
  readonly dry_run: true;
  readonly cycle: string;
  readonly node_id: string;
  /** The verdict word the ticket states (the word that would land in `path`). */
  readonly result: 'completed' | 'failed' | 'stopped';
  readonly delivered: boolean;
  readonly graph: 'completed' | 'shelved';
  /** The node the close would have opened next: where an offered node is wired in front of (`null` when the line stops or has no free slot). */
  readonly target: string | null;
  /** The freed slots the criteria would fill. */
  readonly filled: readonly string[];
  readonly park_line: boolean;
  readonly seam: readonly SettlePreviewSeam[];
  readonly warnings: readonly string[];
  readonly plan: NextPlan;
}

/**
 * One query of `next`: which line, and the closing rehearsal.
 *
 * - `cycle` — the line to read; without a name the one active line is taken.
 * - `after` — the closing rehearsal: name the node whose work is already handed back (the ticket is on
 *   disk) and ask "settling on it, where would this line go". Nothing is written on this path: the
 *   rehearsal is a reading of the criteria the settle itself uses, and the settle is `conductor.settle`.
 *
 * There is no "execute it on the way" mode here: this action reads the records and hands back what the
 * next step is, and the action that carries a step out is `conductor.advance` (or `dispatch`).
 */
export interface NextQuery extends ConductorTarget {
  after?: string;
}

/**
 * The next step: a plan that can be read and explained and is not executed.
 *
 * The literals of the action bag and their key order are fixed (the output of `plan --json`), and
 * the byte-for-byte comparison rests on exactly that; the six actions each take one word:
 *
 * - `dispatch` — the node is pinned and the prompt's location is named too: hand this step to the executor.
 * - `open_node` — the line holds no node, and the one (or ones) the ranking picked should be pinned down.
 * - `stop_pipeline` — nothing left to do / someone called a stop / this line is not in service: close out and
 *   explain how it ended.
 * - `wait` — the time has not come yet: read `note` (and `close_with`), never poll.
 * - `ask_user` — the state cannot explain itself and a person has to be asked.
 * - `no_cycle` — there is no line yet: opening one is a person's intent.
 *
 * An action carries no command for the caller to run: mechanical steps belong to the write side
 * (`conductor.dispatch` / `conductor.close`), and the plan only calls the "not settled yet" of it `settling`.
 */
export type NextPlan =
  | DispatchPlan
  | OpenNodePlan
  | StopPlan
  | WaitPlan
  | AskPlan
  | NoCyclePlan;

/** One node's cell in one dispatch. */
export interface PlanNodeEntry {
  node_id: string;
  node_title: string;
  mode: NodeMode;
  /** Where this node's prompt lands (`<pf>/meta/launch/<line>/<node>/prompt.txt`). */
  prompt: string;
  /** The one line to write into that file. */
  prompt_text: string;
}

/** Dispatch: the node and the prompt are both ready, hand it to the executor. */
export interface DispatchPlan {
  action: 'dispatch';
  cycle: string;
  node_id: string;
  node_title: string;
  nodes: PlanNodeEntry[];
  mode: NodeMode;
  prompt: string;
  prompt_text: string;
  steps: string[];
}

/** Pinning: claim the nodes the ranking picked (this step still carries mechanical steps, which is what `settling` speaks of). */
export interface OpenNodePlan {
  action: 'open_node';
  cycle: string;
  node_id: string;
  node_title: string;
  nodes?: string[];
  note: string;
  follow?: { action: 'dispatch'; cycle: string; node_id: string; node_title: string };
  settling?: true;
}

/** One loose end handed to a person when it stops: which node was shelved, and how to put it back. */
export interface PlanAttention {
  kind: 'node_shelved';
  cycle: string;
  node_id: string;
  node_title: string;
  hint: string;
}

/** Stop: nothing left to do, or someone called a stop. The reason is in `reason`. */
export interface StopPlan {
  action: 'stop_pipeline';
  cycle: string;
  node_id: string | null;
  reason: string;
  note: string;
  attention: PlanAttention[];
  settling?: true;
}

/** Wait: the ticket has no verdict yet, the session is still running, the ticket is still pending — read `note`, do not poll. */
export interface WaitPlan {
  action: 'wait';
  cycle: string;
  node_id?: string;
  /** The one command that settles this node (given when `wait` lands in the cell "the ticket is in, the node is not settled yet"). */
  close_with?: string;
  note: string;
}

/** Ask a person: the state cannot explain itself. */
export interface AskPlan {
  action: 'ask_user';
  cycle: null;
  question: string;
  requested?: string;
  candidates?: string[];
  known_cycles?: string[];
  hint?: string;
}

/** No line yet: opening one comes from a person's intent, and the plan does not invent one for them. */
export interface NoCyclePlan {
  action: 'no_cycle';
  cycle: null;
  note: string;
  known_cycles: string[];
}

/** Write one handoff ticket: the verdict and a one-line account. */
export interface ConductorHandoffInput {
  cycle: string;
  node: string;
  status: NodeResult;
  summary: string;
  outputs?: Record<string, unknown>;
}

/** One reading slot the ticket shape of a line asks for: the key, and the question the declaration carries. */
export interface HandoffFormReading {
  key: string;
  ask: string;
}

/** The shape of the ticket this line asks for: which line, and which reading slots a worker is asked to report. */
export interface HandoffForm {
  cycle: string;
  /** The reading slots (`source: ticket`) in force on this line; empty means nobody reports a number. */
  readings: HandoffFormReading[];
}

/** One routed plugin command: the word and the rest of the line. */
export interface ConductorPluginCommandInput {
  word: string;
  argv?: readonly string[];
}

/**
 * What one routed plugin command did: which plugin answered, whether it ran to its end, the text it answered
 * with, and — when it did not run — the sentence the failure leaves. `main` may hand back a number as its
 * answer: that number is the exit code the run asks for, and it lands in `code` (null when the plugin asked
 * for none). A caller that runs a word keeps it, the way a process's own exit code is kept.
 */
export interface PluginCommandAnswer {
  word: string;
  /** The plugin folder that answered; null when no installed plugin claims this word. */
  plugin: string | null;
  ran: boolean;
  text: string | null;
  /** The exit code the plugin handed back (a number from `main`); null when it handed back none. */
  code: number | null;
  error: string | null;
}

/** One check of doctor. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The check-up report of doctor. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * The per-call options of `doctor`: the git capability is handed in by the caller of that one call, the
 * same shape as `ledger.init` / `ledger.register`. The handle holds no git of its own.
 */
export interface ConductorDoctorOptions {
  /** The git capability for the merge-driver cell; without it the cell is not asked (and so never red). */
  readonly git?: GitRunner;
}

/**
 * The own options of the conductor namespace when it is assembled (not on the frozen surface, the same
 * way as config).
 */
export interface ConductorNamespaceOptions {
  /** The home of the machine-layer settings (`<home>/.pf/config.json`); this machine's user home directory by default, which tests shut into a temporary directory. */
  readonly homeDir?: string;
  /** The location of the plugin directory; `<root>/plugins` by default, one folder per plugin. */
  readonly pluginsDir?: string;
  /**
   * The bound on one git question the check-up asks (milliseconds); `DOCTOR_GIT_TIMEOUT_MS` by default.
   * A caller that cannot wait out the default -- a test standing in a git that never answers -- hands in
   * a much smaller one, the way a test shuts `homeDir` into a temporary directory.
   */
  readonly gitTimeoutMs?: number;
}

/** The pipeline namespace: the group of actions that pushes a line along. */
export interface ConductorNamespace {
  /** Read what the next step is: a plan (dispatch / pin / stop / wait / ask a person / no line yet). */
  next(input?: NextQuery): Promise<NextPlan>;
  /**
   * Land the material of one dispatch and open no session: the prompt at its location, this round's
   * run doc in the node directory, and the handoff template handed back with them. This is the
   * write-side half the step that pins a node calls (`next` in the shell in front of this package);
   * `dispatch` is the same preparation followed by the session. Only a dispatch plan has material to
   * land: called on any other plan it says so on the spot and writes not one byte.
   */
  prepare(input?: ConductorTarget): Promise<PreparedDispatch>;
  /**
   * Hand the next step to the executor: the node goes to a session, and the promise ends when that
   * session is **open**. The result is not here — the worker files a ticket and `close` settles it.
   */
  dispatch(input?: ConductorDispatchInput): Promise<DispatchReceipt>;
  /**
   * The rehearsal of one dispatch: the cell as the executor would receive it — the material's spot and whether it
   * is already on disk, the model route, and the lines a dispatch-time gate would refuse with.
   * Nothing is written, nothing claims the cell, and the opener is not asked for a session.
   */
  dispatchPreview(input?: ConductorDispatchInput): Promise<DispatchPreview>;
  /** Write one handoff ticket, landing at "line id / node id" under signals. */
  handoff(input: ConductorHandoffInput): Promise<HandoffRecord>;
  /**
   * Settle one node, and nothing else: the verdict goes into the line's `path`, the claim is laid down, the
   * graph node lands `completed` / `shelved`, and the close-time plugin seam runs (an offer may put a node
   * into the graph). No slot is claimed, no line is parked, no material lands and no session opens; those
   * are `advance`'s steps (and `close`'s, which settles and then takes them without a session).
   */
  settle(input?: ConductorTarget): Promise<CycleRecord>;
  /**
   * The rehearsal of one settle: the same two gates, the same criteria, and the close-time seam asked its own
   * preview — the path step, the graph mark, the slot it would fill and what would be inserted in front of that
   * node, with not one record written. A plugin that ships no close preview is skipped with one WARNING line.
   */
  settlePreview(input?: ConductorTarget): Promise<SettlePreview>;
  /** The settle plus the applier's steps with no session opened: claim the freed slots, park a stopped line. */
  close(input?: ConductorTarget): Promise<CycleRecord>;
  /**
   * Carry the line one step: claim the nodes it has free slots for, hand the cells in hand to the executor
   * (one session per cell), park a line that stopped with nothing left. The composed entry — its name says
   * what it does, and every step in it is one of the primitives above.
   */
  advance(input?: ConductorAdvanceInput): Promise<AdvanceReceipt>;
  /**
   * Route one plugin command: the word and the rest of the line go to the installed plugin that declares it,
   * run in this process through the plugin contract, and its answer comes back — the text it answered with,
   * and the exit code it handed back when `main` answered a number. A word no installed plugin claims answers
   * `plugin: null, ran: false` — the caller says "no such command".
   */
  pluginCommand(input: ConductorPluginCommandInput): Promise<PluginCommandAnswer>;
  /** The plugin commands installed here claim, in folder order, with the name the router matches. */
  pluginCommands(): Promise<PluginCommandEntry[]>;
  /** The ticket shape this line asks for: which reading slots a worker reports (writes nothing). */
  handoffForm(input?: ConductorTarget): Promise<HandoffForm>;
  /** Check-up: the installed plugins are listed one by one, the records are complete, no reference dangles, nothing cycles; the merge-driver cell is asked with the git handed in on this call (without one it is not asked). */
  doctor(options?: ConductorDoctorOptions): Promise<DoctorReport>;
}

/**
 * One line of the plugin face: how fresh a plugin reading is, in the two halves that behave apart.
 *
 * An implementation entry is loaded into this process once, and a copy of the declaration an
 * implementation reads for itself at that first load stays with it: an edit on disk on either reaches
 * a running process only after a restart. The declaration file itself is not read once — every scan
 * reads it off the folder again, so a plugin installed or removed, a knob, a command word or a
 * reading changed on disk is in force on the next call. Nothing else says this out loud, and a person
 * who changed a plugin and cannot see the change has nowhere to read it, so the check-up carries
 * both halves.
 */
const PLUGIN_LOAD_NOTE =
  "a plugin's implementation entry is read once, when the plugin first loads in this process, and a " +
  'copy of the declaration the implementation reads for itself stays with it: an edit on disk takes ' +
  'effect after a restart. The declaration file (plugin.json) is not read once: every scan reads it ' +
  'off the folder again, so a plugin installed or removed, or a knob, a command word or a reading ' +
  'changed on disk, is in force on the next call without a restart';

/**
 * Assemble the conductor namespace: how the ten verbs are wired:
 *
 * - `prepare`'s **landing the material**: the same preparation `dispatch` does, without the session.
 *   The line is resolved (an id that is not on the record is refused the way every verb refuses one),
 *   the plan is read, and only a dispatch plan has material to land — a prompt at its location, the
 *   run doc in the node directory, the handoff template handed back with them. Any other plan is
 *   answered on the spot with not one byte written. This is the write-side half of the step that pins
 *   a node, so the shell in front of this package can land the prompt on the pinning call and start
 *   the session on the next one.
 * - `dispatch`'s **whole dispatch**: the claim of an earlier dispatch is read first — when this
 *   (line, node)'s `started` marker is already on disk the answer is `already_open`, with no executor
 *   call and not one byte written. Otherwise: the plugin blocking seam (a blocker lists every reason
 *   and throws `dispatch_blocked`) → dispatch preparation → build the `DispatchRequest` (the line's
 *   and the node's identity carried as they are, `role` carried by the request, the prompt being the
 *   one line preparation handed back) and give it to the injected executor → take the `OpenedSession`
 *   as the receipt and land the claim (`started`), after which the plan treats this cell as in flight
 *   and never dispatches it a second time. The preparation is skipped for a cell whose prompt is
 *   **already on disk**: that prompt is the one the pinning step landed, and a prompt on disk with no
 *   `started` stamp is a dispatch of its own (the dispatch gate), even while the plan is still
 *   waiting on the ticket — nothing is left to land, so no second prompt and no run doc are written.
 *   An executor that throws means no session was opened: no marker lands and no record moves. A claim
 *   that cannot be written is **not** a warning: the session is out and nothing on disk says so, so
 *   the call throws with the session id in the message (dispatching the same cell again would open a
 *   second session) — success is never handed back without the claim.
 * - `close`'s **closing settle**: the blockers refuse first (the ticket is missing or still `pending`, so
 *   there is no verdict to settle); the settling criteria are shared with the plan (`settleClose`) — the
 *   verdict goes into path, the claim is laid down, the node lands `completed` / `shelved`, the filled slots
 *   are pinned one by one, and a line decided to stop is turned `inactive` (only recorded when the line is not
 *   in service); the record tree's lock is held throughout, the records that moved get a byte snapshot first,
 *   and a mid-way failure puts them back by the snapshot (no half record is left); the closing insertion seam
 *   runs after the settle as before (zero semantic change). A broken plugin's WARNING hangs on the returned
 *   line record (read with `warningsOf`).
 * - `handoff`'s **landing the ticket**: the line must exist and the node must be on its claim list (otherwise
 *   it refuses having written nothing), and the ticket's six keys land in `signals/<line>/<node>.json` in the
 *   fixed shape and key order (the write is atomic; a second ticket for the same node is legitimate and
 *   overwrites the whole file).
 * - `doctor`'s **strict plugin face**: the installed plugins are listed one by one first (each folder's
 *   name and its own summary, the knobs it declares with kind, default and summary, its tags, methods,
 *   sources and commands — all read off the declarations, none of it restated), then the bad spots are
 *   listed one by one (the declaration, loading the implementation, the skills, the sources, and a real
 *   question put to the implementation against a stand-in project), plus two tables — a knob shadowing a
 *   built-in name, a command claiming a core word; the
 *   **record face** has four more cells: whether `init`'s four layout files are there, whether the graph
 *   has cycles and dangling references, whether the nodes a line holds are still on the graph, and whether
 *   the merge driver's two keys are in this project's git config — that last cell is asked with the git
 *   handed in on this one call (`doctor({ git })`), never with one kept on the handle, and every question it
 *   puts to git carries a bound (`DOCTOR_GIT_TIMEOUT_MS`, narrowed through the namespace options for a caller
 *   that cannot wait it out): a question left unanswered reds that cell and names the question and the wait
 *   instead of holding the whole check-up open, while the other cells are computed all the same.
 *
 * The executor is taken on the green light path of `dispatch` only; `next` is still a read-only plan,
 * and `prepare` is the preparation half of a dispatch, which needs no executor at all.
 */
export function createConductorNamespace(
  root: string,
  executor?: Executor,
  options: ConductorNamespaceOptions = {},
): ConductorNamespace {
  const paths = pfPaths(root);
  const dag = createDagNamespace(root);
  const cycles = createCyclesNamespace(root);

  /** The reading of a line record: name an id and find that line; without a name the first active one is taken (and if there is none, it stops on the spot). */
  async function resolveCycle(targetCycle: string | undefined): Promise<CycleRecord> {
    const read = await readJsonFile(paths.stateJson, 'state.json');
    const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
      ? (read.value as Record<string, unknown>)
      : {};
    const cycles = Array.isArray(data.cycles)
      ? (data.cycles as CycleRecord[])
      : [];
    if (targetCycle !== undefined) {
      const named = cycles.find((cycle) => cycle !== null && typeof cycle === 'object' && cycle.id === targetCycle);
      if (named === undefined) {
        throw new PfError(
          'cycle_not_found',
          paths.stateJson,
          `this project's record has no cycle "${targetCycle}"`,
        );
      }
      return named;
    }
    const current = cycles.find((cycle) => cycle !== null && typeof cycle === 'object' && cycle.status === 'active');
    if (current === undefined) {
      throw new PfError(
        'cycle_not_found',
        paths.stateJson,
        'no active cycle to act on (name one with { cycle }); nothing was changed',
      );
    }
    return current;
  }

  /** The node this step works on: the named one when one is named, otherwise the line's claim; with neither it stops. */
  function heldNodeId(cycle: CycleRecord, targetNode: string | undefined): string {
    if (targetNode !== undefined && targetNode !== '') return targetNode;
    const [first] = cycleHoldingIds(cycle);
    if (first !== undefined) return first;
    throw new Error(
      `cycle "${String(cycle.id ?? '')}" holds no node to act on; name one with { node }`,
    );
  }

  /**
   * The ticket of one cell as it is on disk: the object when the file is there and holds one, `null` when it is
   * absent or holds something else. The read side presumes no shape (pending is not in the frozen verdict
   * vocabulary), so the caller asks what it needs off the returned table.
   */
  async function ticketOf(cycleId: string, nodeId: string): Promise<Record<string, unknown> | null> {
    const read = await readJsonFile(signalPath(paths, cycleId, nodeId), `signals/${cycleId}/${nodeId}.json`);
    return read.kind === 'present' && read.value !== null && typeof read.value === 'object'
      ? (read.value as Record<string, unknown>)
      : null;
  }

  /**
   * The refusal of a close with nothing to settle: the ticket is absent, or it is the `pending` mark a re-run
   * leaves. There is no verdict to settle, and not one byte moves.
   */
  function nothingToSettle(cycleId: string, nodeId: string): PfError {
    return new PfError(
      'nothing_to_settle',
      signalPath(paths, cycleId, nodeId),
      `${nodeId.slice(0, 8)} has not handed in a verdict yet ` +
        `(signals/${cycleId}/${nodeId.slice(0, 8)}….json is absent, or still pending) -- ` +
        'there is nothing to settle; nothing was changed.',
    );
  }

  /** The claim of a dispatch that opened a session: this cell's `started` marker, so the plan no longer counts it as dispatchable. */
  async function writeStartedMarker(cycleId: string, nodeId: string): Promise<void> {
    const text = `${process.pid} started ${nowSeconds()}\n`;
    await atomicWriteBytes(
      startedMarkerPath(paths, cycleId, nodeId),
      new TextEncoder().encode(text.replace(/\n/g, EOL)),
    );
  }

  /**
   * The failure of a claim write: the session is out and nothing on disk says so. It carries the
   * session id and says the plain thing — dispatching the same cell again opens a second session.
   */
  function claimMissingError(nodeId: string, session: OpenedSession, error: unknown): Error {
    const reason = error instanceof Error ? error.message : String(error);
    const opened = session.sessionId === undefined ? 'the session' : `session ${session.sessionId}`;
    return new Error(
      `the \`started\` claim for ${nodeId.slice(0, 8)} could not be written (${reason}). ` +
        `${opened} is out already, but the claim that says so is missing: dispatching this cell ` +
        'again would open a second session. Write the claim before anything else.',
      { cause: error },
    );
  }

  /** A byte snapshot of one record file (for rollback); a missing file is recorded as null and skipped on restore. */
  async function snapshotRecord(path: string): Promise<{ path: string; bytes: Uint8Array } | null> {
    try {
      return { path, bytes: await readFile(path) };
    } catch {
      return null;
    }
  }

  /**
   * The two gates of a settle, and the scene they read: the line must hold the node, and the ticket on disk must
   * state a verdict. The write and its rehearsal share this one block — a rehearsal refuses exactly what the write
   * refuses (refusing is not a write), and neither copies the other's sentences.
   */
  async function settleScene(input: ConductorTarget | undefined): Promise<{
    cycle: CycleRecord;
    cycleId: string;
    nodeId: string;
    sig: Record<string, unknown>;
  }> {
    assertLedgerInitialized(paths);
    const cycle = await resolveCycle(input?.cycle);
    const cycleId = String(cycle.id ?? '');
    const nodeId = heldNodeId(cycle, input?.node);
    const known = await dag.get(nodeId);
    if (known === null) {
      throw new Error(`node ${nodeId} not found`);
    }
    // Gate one of the closing: the node must be on this line's claim list (the same gate as the closing itself).
    // The claim is read in one place for every shape on disk (`cycleHoldingIds`): the canonical `[{ id, since }]`
    // and the bare id string an older disc carries.
    const inHand = cycleHoldingIds(cycle).includes(nodeId);
    if (!inHand) {
      const names = cycleHoldingIds(cycle).map((id) => id.slice(0, 8));
      throw new PfError(
        'not_holding',
        paths.stateJson,
        `cycle "${cycleId}" is not holding ${nodeId} (it is holding ` +
          `${names.join(', ') || 'nothing'}); there is nothing to settle`,
      );
    }
    // Gate two of the closing: the ticket has to be on disk and it has to state a result. A missing ticket, or one
    // still pending, is a blocker (nothing was handed in, or it is a re-run marker) — there is no verdict to
    // settle, and not one byte moves.
    const sig = await ticketOf(cycleId, nodeId);
    if (sig === null || sig.status === 'pending') throw nothingToSettle(cycleId, nodeId);
    return { cycle, cycleId, nodeId, sig };
  }

  /**
   * One plugin round's context: the folders, the context itself (built on the scene the caller already read) and
   * where its WARNING lines land. A rehearsal asks the same scene with `preview: true`, and there `run` refuses —
   * the plugin may read (`knob`, `reading`, `capture`), and an effect waits for the real timing.
   */
  async function pluginContext(
    scene: {
      cycle: CycleRecord;
      nodeId: string;
      sig?: unknown;
      preview?: boolean;
    },
    assembly: PluginAssembly = pluginAssemblyOf(root, options.pluginsDir),
  ): Promise<{ assembly: PluginAssembly; folders: PluginFolder[]; ctx: PluginContext; warnings: string[] }> {
    const warnings: string[] = [];
    const folders = await assembly.folders();
    const ctx = createContext({
      root,
      folders,
      homeDir: options.homeDir,
      warnings,
      cycle: scene.cycle as unknown as Record<string, unknown>,
      nodeId: scene.nodeId,
      sig: scene.sig ?? null,
      dag: await readGraphSnapshot(paths),
      target: null,
      ...(scene.preview === true ? { preview: true } : {}),
    });
    return { assembly, folders, ctx, warnings };
  }

  /**
   * The settle: one node's end, recorded — and nothing else.
   *
   * The gates first (the line must hold the node; the ticket must be on disk with a verdict), then the
   * plugin half of the close asked **before the lock** on one snapshot of the scene, then one transaction
   * over the records: the verdict into `path`, the claim laid down, the graph node marked, and the closing
   * insertion seam. No slot is filled, no line is parked, no material lands and no session opens — those
   * are the applier's steps (`applySteps`), and which node they touch is the plan's answer.
   *
   * The seam's target is the node this close **would have opened next** — the head of the slot-filling
   * list the criteria name, read before anything is inserted. An offered node is wired in front of it, so
   * the ordinary ranking picks the inserted node before the work that was going to run: the close decides
   * the ordering by what it puts into the graph, not by claiming anything.
   */
  const settleNode = async (input: ConductorTarget | undefined): Promise<CycleRecord> => {
    const { cycle, cycleId, nodeId, sig } = await settleScene(input);
    // The plugin half of the close — the scan, the dynamic load, every plugin's question — is asked here, before
    // the lock is taken, on one snapshot of the scene (the line and the ticket as read just above). How long a
    // plugin takes to answer is how long it takes and no writer waits on it: no record of this ledger is written
    // in this stretch. What the answered offers want in the graph is landed under the lock by the mechanism below.
    const { folders, ctx, warnings } = await pluginContext({ cycle, nodeId, sig });
    const offers = await collectOffers('close', ctx, folders, warnings);
    return withLedgerLock(paths, async () => {
      // The first thing under the lock: the line and the ticket are read again, and the settle answers to these
      // bytes. What the plugin half was handed above is a snapshot taken before the lock — the plugins judge on
      // that scene, they do not decide the verdict.
      const line = await resolveCycle(cycleId);
      const ticket = await ticketOf(cycleId, nodeId);
      if (ticket === null || ticket.status === 'pending') throw nothingToSettle(cycleId, nodeId);
      // The settling criteria are shared with the plan (settleClose): the verdict word, whether the line carries
      // on, the slot list its freed slots open, and whether it parks. The head of that list is the seam's target.
      const settle = await settleClose(root, line, nodeId, ticket);
      const target = settle.filled[0]?.id ?? null;
      // Transactional: a snapshot is taken before the records move, and a mid-way failure puts them back by the
      // snapshot — no half record is left.
      const before = [
        await snapshotRecord(paths.stateJson),
        await snapshotRecord(paths.ideasJson),
      ];
      try {
        // The mechanical steps of the settle, and only these: the step goes into path (the verdict with it), the
        // graph node is marked (a delivery lands completed, a non-delivery lands shelved), and the record's own
        // status is what it was. What fills the freed slots, parks a stopped line, lands material or opens a
        // session belongs to the applier, and the plan is where it is read.
        await cycles.close(cycleId, { node: nodeId, result: settle.outcome });
        await dag.setStatus(nodeId, settle.delivered ? 'completed' : 'shelved');
        // The closing insertion seam: the offers were asked before the lock, and a broken plugin folds into one
        // WARNING line and does not take part this round, while the main flow goes on as usual.
        for (const offer of offers) {
          try {
            await applyInsertion(root, dag, offer, nodeId, target, warnings);
          } catch (error) {
            warnings.push(warnLine(offer.plugin, 'failed', error));
          }
        }
        const updated = await cycles.show(cycleId);
        warningsByResult.set(updated, warnings);
        return updated;
      } catch (error) {
        for (const snap of before) {
          if (snap !== null) await atomicWriteBytes(snap.path, snap.bytes);
        }
        throw error;
      }
    });
  };

  /**
   * Which model route this dispatch opens with: the call's own name > the line's `model` policy > the
   * machine's `DSH_CONDUCT_MODEL`, and nothing named leaves the executor's own default in force. Carried
   * as one word in the ecosystem's spelling (`provider/model`); this layer never splits it.
   */
  function modelOf(line: CycleRecord, named: string | undefined): string | undefined {
    if (named !== undefined && named !== '') return named;
    const policy = cyclePolicy(line).model;
    if (typeof policy === 'string' && policy !== '') return policy;
    return envModel();
  }

  /**
   * The mechanical steps behind a plan, in one place: claim the nodes the line has free slots for, hand the
   * cells in hand to the executor, and park a line that stopped with nothing left to run.
   *
   * One reading, then the steps in this order: `pinSlots` says who may be claimed (the head of the graph's
   * ordering, as many as the line's `parallel` has room for), the claims are written, the plan is read on
   * that state (a `dispatch` is the cells in hand whose session is not out yet), and the executor is called
   * when this caller opens sessions. A stop with nothing in hand turns the line inactive, which is how a
   * stopped line reads from then on.
   *
   * The executor is handed in as a function by the caller (`advance` passes the namespace's own dispatch),
   * so this one implementation serves `close` (no session) and `advance` (with sessions) alike.
   */
  async function applySteps(
    cycleId: string,
    options: {
      openSessions: boolean;
      model?: string;
      dispatch?: (nodeId: string) => Promise<DispatchReceipt>;
    },
  ): Promise<AdvanceReceipt> {
    const line = await resolveCycle(cycleId);
    const pinned: string[] = [];
    if (line.status === 'active') {
      for (const pick of await pinSlots(root, line)) {
        await cycles.hold(cycleId, pick.id);
        pinned.push(pick.id);
      }
    }
    const plan = await planNext(root, { cycle: cycleId });
    const dispatches: Array<{ node_id: string; receipt: DispatchReceipt }> = [];
    let parked = false;
    if (plan.action === 'dispatch' && options.openSessions && options.dispatch !== undefined) {
      for (const cell of plan.nodes) {
        dispatches.push({ node_id: cell.node_id, receipt: await options.dispatch(cell.node_id) });
      }
    } else if (plan.action === 'stop_pipeline') {
      const current = await resolveCycle(cycleId);
      const inHand = Array.isArray(current.holding) ? current.holding.length : 0;
      if (current.status === 'active' && inHand === 0) {
        await cycles.setStatus(cycleId, 'inactive');
        parked = true;
      }
    }
    const after = await planNext(root, { cycle: cycleId });
    return { cycle: cycleId, pinned, dispatches, parked, plan: after };
  }

  const base: Omit<ConductorNamespace, 'advance'> = {
    next: async (input) => {
      const query = input ?? {};
      return planNext(root, query);
    },

    prepare: async (input) => {
      // The line is resolved the way every verb resolves one — an id that is not on the record is refused
      // here rather than as a plan answer, so the caller reads a line that is really there. The material
      // itself is the same preparation `dispatch` runs; that one call is where "only a dispatch plan has
      // material" is decided, and it writes nothing when it is not one.
      const cycle = await resolveCycle(input?.cycle);
      const cycleId = String(cycle.id ?? '');
      return prepareDispatch(
        root,
        { cycle: cycleId, ...(input?.node === undefined || input.node === '' ? {} : { node: input.node }) },
        { homeDir: options.homeDir, pluginsDir: options.pluginsDir },
      );
    },

    handoff: async (input) => {
      assertLedgerInitialized(paths);
      const cycleId = input?.cycle;
      const nodeId = input?.node;
      if (typeof cycleId !== 'string' || cycleId === '' || typeof nodeId !== 'string' || nodeId === '') {
        throw new TypeError('conductor.handoff needs { cycle, node, status, summary } (outputs optional)');
      }
      const status = input.status;
      if (!HANDOFF_RESULTS.includes(status)) {
        throw new Error(
          `a ticket's status must be one of ${JSON.stringify([...HANDOFF_RESULTS].sort())}; ` +
            'a `pending` ticket is the mark a retry leaves behind (ledger.cycles.retry), ' +
            'not one a session files',
        );
      }
      const summary = input.summary;
      if (typeof summary !== 'string') {
        throw new TypeError('conductor.handoff needs a one-line summary (a string)');
      }
      const outputs = input.outputs ?? {};
      if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
        throw new TypeError('conductor.handoff outputs must be a JSON object');
      }
      // Two gates pass first, and the refusal writes nothing: the line must be on the account and the node must
      // be on its claim list — a ticket vouching for work nobody ran is worse than no ticket (the same gate as
      // handoff, read off the one shape-tolerant reader every reader of a claim goes through).
      const cycle = await resolveCycle(cycleId);
      const held = cycleHoldingIds(cycle);
      const inHand = held.includes(nodeId);
      if (!inHand) {
        const names = held.map((id) => id.slice(0, 8));
        throw new PfError(
          'not_holding',
          paths.stateJson,
          `cycle "${cycleId}" is not holding ${nodeId} (it is holding ` +
            `${names.join(', ') || 'nothing'}); nothing was written. A node this line already ` +
            'closed out is the usual reason: put it back in play and pin the line on it again.',
        );
      }
      // The ticket's six keys land in the fixed shape and key order; the write is atomic, and a second ticket
      // for the same node is legitimate (a session changing its own answer overwrites it just the same).
      const record: HandoffRecord = {
        cycle: cycleId,
        node: nodeId,
        status,
        summary,
        outputs: outputs as Record<string, unknown>,
        timestamp: nowSeconds(),
      };
      await atomicWriteJson(signalPath(paths, cycleId, nodeId), record, jsonOptionsForRecord('signal'));
      return record;
    },

    dispatch: async (input) => {
      const cycle = await resolveCycle(input?.cycle);
      const cycleId = String(cycle.id ?? '');
      const nodeId = heldNodeId(cycle, input?.node);
      const known = await dag.get(nodeId);
      if (known === null) {
        throw new Error(`node ${nodeId} not found`);
      }
      const nodeTitle = String(known.title ?? '');
      // The claim of an earlier dispatch, read first: this cell's session is out already, so there is
      // nothing to open and nothing to write — one executor call here would be a second session.
      if (existsSync(startedMarkerPath(paths, cycleId, nodeId))) {
        return {
          action: 'already_open',
          cycle: cycleId,
          node_id: nodeId,
          node_title: nodeTitle,
          prompt: launchPromptPath(paths, cycleId, nodeId),
          prompt_text: promptTextOf(nodeId),
        };
      }
      const {
        assembly,
        folders,
        ctx,
        warnings,
      } = await pluginContext({ cycle, nodeId });
      const reasons = await collectGates('dispatch', ctx, folders, warnings);
      if (reasons.length > 0) {
        throw new PfError(
          'dispatch_blocked',
          paths.stateJson,
          `dispatch of node "${nodeId}" is blocked by plugin gate(s):\n` +
            reasons.map((reason) => `  - ${reason}`).join('\n'),
        );
      }
      if (executor === undefined) {
        throw new Error('conductor.dispatch needs an injected executor (PfOpenOptions.executor)');
      }
      // The material this dispatch hands over. The prompt is the one line the step that pinned this node
      // lands; when it is **already on disk** there is nothing left to land, and this call writes only
      // the `started` claim below. That pair of disk facts — prompt there, no `started` stamp — is the
      // dispatch gate, so a landed prompt is a dispatch even while the plan is still
      // waiting on the ticket (a prompt an earlier round left behind).
      // A cell with no prompt goes through the preparation, which lands the prompt, sets up the run doc,
      // and says on its own spot when the plan hands back something other than a dispatch.
      const promptPath = launchPromptPath(paths, cycleId, nodeId);
      let material: { readonly prompt: string; readonly prompt_text: string };
      if (existsSync(promptPath)) {
        material = { prompt: promptPath, prompt_text: promptTextOf(nodeId) };
      } else {
        const prepared = await prepareDispatch(
          root,
          { cycle: cycleId, node: nodeId },
          { homeDir: options.homeDir, pluginsDir: options.pluginsDir, assembly },
        );
        const slot = prepared.nodes[0];
        if (slot === undefined || slot.node_id !== nodeId) {
          throw new Error(
            `node ${nodeId} is not on this dispatch's list (not in hand, its session is ` +
              'already out, or it already filed a ticket); nothing was prepared',
          );
        }
        material = slot;
      }
      // The request goes to the executor: the line's and the node's identity are carried as they are, role is
      // carried by the request, and the prompt is the one line the material holds. What comes back is a
      // receipt, not a result: the session is open, and the result will arrive as a ticket from the worker.
      // Which model route this session opens on is one resolution chain (`modelOf`); the drill switch rides
      // along the same seam.
      const model = modelOf(cycle, input?.model);
      const dryRun = envSpawnDryRun();
      const request: DispatchRequest = {
        cycle: cycleId,
        node: nodeId,
        role: 'execute',
        prompt: material.prompt_text,
        ...(model === undefined ? {} : { model }),
        ...(dryRun ? { dryRun: true } : {}),
      };
      const session = await executor.dispatch(request);
      // The claim of this dispatch: the session is out, so the marker lands and the plan stops counting this
      // cell as dispatchable. Success is never handed back without it — a missing claim would let the next
      // dispatch open a second session on a node that already has one, so a claim that cannot be written throws
      // with the session id in the message instead of folding into a warning. A drill opens no session at all,
      // so it claims nothing either: the cell stays dispatchable, and a rehearsal never has to be unwound.
      if (!dryRun) {
        try {
          await writeStartedMarker(cycleId, nodeId);
        } catch (error) {
          throw claimMissingError(nodeId, session, error);
        }
      }
      const receipt: DispatchReceipt = {
        action: 'opened',
        cycle: cycleId,
        node_id: nodeId,
        node_title: nodeTitle,
        prompt: material.prompt,
        prompt_text: material.prompt_text,
        session,
      };
      warningsByResult.set(receipt, warnings);
      return receipt;
    },

    /**
     * The rehearsal of one dispatch: the same gates (a dispatch-time block is reported, not thrown) and the same
     * resolution chains, with the material only *named*. Nothing is claimed, nothing is landed, and the executor is
     * not asked for a session — a rehearsal is a reading of what the real call would hand over.
     */
    dispatchPreview: async (input) => {
      const cycle = await resolveCycle(input?.cycle);
      const cycleId = String(cycle.id ?? '');
      const nodeId = heldNodeId(cycle, input?.node);
      const known = await dag.get(nodeId);
      if (known === null) {
        throw new Error(`node ${nodeId} not found`);
      }
      const { folders, ctx, warnings } = await pluginContext({ cycle, nodeId, preview: true });
      // Refusing is the thing being rehearsed: the reasons come back as data, in the same order the real gate
      // would join them, instead of the refusal's exception.
      const blocked = await collectGates('dispatch', ctx, folders, warnings, true);
      const prompt = launchPromptPath(paths, cycleId, nodeId);
      const model = modelOf(cycle, input?.model);
      return {
        action: 'dispatch' as const,
        dry_run: true as const,
        cycle: cycleId,
        node_id: nodeId,
        node_title: String(known.title ?? ''),
        prompt,
        prompt_text: promptTextOf(nodeId),
        material: (existsSync(prompt) ? 'on_disk' : 'to_land') as 'on_disk' | 'to_land',
        ...(model === undefined ? {} : { model }),
        blocked,
        warnings,
      };
    },

    /** The settle, on its own: record this node's end, mark the graph, run the close-time seam. */
    settle: async (input) => await settleNode(input),

    /**
     * The rehearsal of one settle: the two gates, the shared criteria and the close seam's own previews, answered
     * without one record write — the step that would land in `path`, the graph mark, the slot the line would fill,
     * what would be inserted in front of which node, and the plan the line would read afterwards.
     */
    settlePreview: async (input) => {
      const { cycle, cycleId, nodeId, sig } = await settleScene(input);
      const { folders, ctx, warnings } = await pluginContext({ cycle, nodeId, sig, preview: true });
      const settle = await settleClose(root, cycle, nodeId, sig);
      const target = settle.filled[0]?.id ?? null;
      const offers = await collectOffers('close', ctx, folders, warnings, true);
      const plan = await planNext(root, { cycle: cycleId, after: nodeId });
      return {
        action: 'settle' as const,
        dry_run: true as const,
        cycle: cycleId,
        node_id: nodeId,
        result: settle.outcome,
        delivered: settle.delivered,
        graph: (settle.delivered ? 'completed' : 'shelved') as 'completed' | 'shelved',
        target,
        filled: settle.filled.map((row) => row.id),
        park_line: settle.parkLine,
        seam: offers.map((offer) => ({
          plugin: offer.plugin,
          title: offer.title,
          tags: [...offer.tags],
          note: offer.note,
          why: offer.why,
        })),
        warnings,
        plan,
      };
    },

    /**
     * The settle plus the applier's steps, with no session opened: claim the freed slots, land nothing, park
     * a stopped line. The caller that opens the sessions itself is `advance`.
     */
    close: async (input) => {
      const settled = await settleNode(input);
      const cycleId = String(settled.id ?? '');
      await applySteps(cycleId, { openSessions: false });
      const after = await cycles.show(cycleId);
      // The WARNING lines belong to the record this call hands back: the settle's own reading is carried over.
      warningsByResult.set(after, warningsOf(settled));
      return after;
    },

    pluginCommand: async (input) => {
      const word = String(input?.word ?? '');
      const argv = [word, ...(input?.argv ?? []).map(String)];
      const answer: PluginCommandAnswer = { word, plugin: null, ran: false, text: null, code: null, error: null };
      if (word === '') {
        answer.error = 'a plugin command needs a word';
        return answer;
      }
      const folders = await pluginAssemblyOf(root, options.pluginsDir).folders();
      const entry = routableCommands(folders).find((candidate) => candidate.name === word);
      if (entry === undefined) return answer;
      answer.plugin = entry.plugin;
      const folder = folders.find((candidate) => candidate.name === entry.plugin);
      const impl = folder === undefined ? null : await implOf(folder);
      const main = impl === null ? undefined : (impl as Record<string, unknown>).main;
      if (typeof main !== 'function') {
        answer.error = `plugin ${JSON.stringify(entry.plugin)} declares the command ${JSON.stringify(word)} but has no main() to run it`;
        return answer;
      }
      // The context is the same one a timing's door gets: the knobs' chain, the readings, the tag lookup, the
      // graph snapshot and the node layout. A plugin word run from outside the pipeline stands on no node and no line,
      // so both cells are empty and the whole graph is handed over as the snapshot.
      const warnings: string[] = [];
      const ctx = createContext({
        root,
        folders,
        homeDir: options.homeDir,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      const callArgv = entry.keepName ? argv : argv.slice(1);
      try {
        const answered = await (main as (argv: readonly string[], context: unknown) => unknown)(callArgv, ctx);
        // Ran to its end: whether it answered text is its own business (an effectful command answers none),
        // and a number is the exit code it asks its caller to leave with.
        answer.ran = true;
        answer.text = typeof answered === 'string' ? answered : null;
        answer.code = typeof answered === 'number' ? answered : null;
      } catch (error) {
        answer.error = error instanceof Error ? error.message : String(error);
      }
      return answer;
    },

    pluginCommands: async () => await pluginAssemblyOf(root, options.pluginsDir).folders().then(routableCommands),

    handoffForm: async (input) => {
      const cycle = await resolveCycle(input?.cycle);
      const cycleId = String(cycle.id ?? '');
      const nodeId = input?.node === undefined || input.node === '' ? undefined : String(input.node);
      const folders = await pluginAssemblyOf(root, options.pluginsDir).folders();
      // The reading slots are the ones this line asks for, resolved on the same chain the close judges with:
      // with a node named, that node's own layer counts too.
      const readings = await ticketReadings(root, folders, {
        homeDir: options.homeDir,
        cycle: cycleId,
        ...(nodeId === undefined ? {} : { node: nodeId }),
      });
      return { cycle: cycleId, readings: readings.map((slot) => ({ key: slot.key, ask: slot.ask })) };
    },

    doctor: async (input) => {
      const assembly = pluginAssemblyOf(root, options.pluginsDir);
      const folders: PluginFolder[] = await assembly.folders();
      const problems = [...(await assembly.scanProblems()), ...(await verifyPlugins(folders))];
      const shadows = shadowedKnobs(folders);
      const clashes = commandClashes(folders);
      // The rehearsal gaps are a notice, never a declaration problem: the plugin still serves its timing, and a
      // `--dry-run` skip is where the gap is paid (one WARNING line on the round).
      const gaps = await previewGaps(folders);
      const pluginDetail = folders.length === 0
        ? `0 installed (the scan reads ${pluginsDirOf(root, options.pluginsDir)}; one folder per plugin)`
        : folders.length === 1
          ? '1 installed'
          : `${folders.length} installed`;
      const checks: DoctorCheck[] = [
        {
          name: 'plugins',
          ok: problems.length === 0,
          // The count, then one block per installed plugin (its own summary, its knobs, tags, methods,
          // sources and commands — all read off the declaration), then every bad spot one by one, then the
          // freshness line: what is loaded stays loaded, so whoever changed a plugin can read here why the
          // change is not in force yet.
          detail: [pluginDetail, ...pluginListing(folders), ...problems, ...(gaps.length === 0
            ? []
            : ['', 'rehearsal (a --dry-run skips these, one WARNING line each):', ...gaps]), PLUGIN_LOAD_NOTE].join('\n'),
        },
        {
          name: 'knobs',
          ok: shadows.length === 0,
          detail: shadows.length === 0
            ? 'no declared knob shadows a built-in setting'
            : shadows.join('\n'),
        },
        {
          name: 'commands',
          ok: clashes.length === 0,
          detail: clashes.length === 0
            ? 'no plugin command claims a core word'
            : clashes.join('\n'),
        },
        ...(await recordChecks(paths, dag)),
        await mergeDriverCheck(root, input?.git, options.gitTimeoutMs ?? DOCTOR_GIT_TIMEOUT_MS),
      ];
      return { ok: checks.every((check) => check.ok), checks };
    },
  };

  /**
   * The whole step: fill the line's free slots, hand the cells in hand to the executor, and park a line that
   * stopped with nothing left. This is the one composed word of this namespace, and its name says so — it is
   * `close`'s steps plus the session, called as one thing by a person, the relay and the shell alike.
   *
   * It does not settle anything: a line advances on the state it reads, and the node whose work ended is
   * recorded by `settle` (or by `close`, which settles and then takes these same steps without a session).
   */
  const advance = async (input?: ConductorAdvanceInput): Promise<AdvanceReceipt> => {
    const cycle = await resolveCycle(input?.cycle);
    const cycleId = String(cycle.id ?? '');
    const shared = {
      ...(input?.model === undefined ? {} : { model: input.model }),
    };
    return applySteps(cycleId, {
      openSessions: input?.openSessions !== false,
      ...shared,
      dispatch: (nodeId) => base.dispatch({ cycle: cycleId, node: nodeId, ...shared }),
    });
  };

  return { ...base, advance };
}

/** The four layout files `init` sets up: one short of them and this record directory is incomplete. */
const LEDGER_LAYOUT = ['.gitignore', '.gitattributes', 'AGENTS.md', 'config.json'] as const;

/**
 * The three-cell check-up of the record face: the records are complete, no reference dangles, nothing cycles.
 *
 * A project with no `.pf/` does not count as red — a new project has not set up a record directory yet, and
 * this cell only says it should run `init` once. While the record directory is there, one missing file of
 * `init`'s four layout files is named; the graph goes through the criteria of `ledger.dag.validate` (cycles,
 * dangling dependencies); and the nodes a line holds must still be on the graph, with unrecognised ones named.
 */
async function recordChecks(
  paths: PfPaths,
  dag: DagNamespace,
): Promise<DoctorCheck[]> {
  const gaps: string[] = [];
  const initialized = existsSync(paths.pfDir) && statSync(paths.pfDir).isDirectory();
  if (initialized) {
    for (const name of LEDGER_LAYOUT) {
      const path = join(paths.pfDir, name);
      if (!existsSync(path) || !statSync(path).isFile()) gaps.push(`${PF_DIR_NAME}/${name} is missing`);
    }
  }

  const graph = await dag.validate();
  const snapshot = await readGraphSnapshot(paths);
  const seeing = await readJsonFile(paths.stateJson, 'state.json');
  const data = seeing.kind === 'present' && seeing.value !== null && typeof seeing.value === 'object'
    ? (seeing.value as Record<string, unknown>)
    : {};
  const cycles = Array.isArray(data.cycles) ? (data.cycles as CycleRecord[]) : [];
  const dangling: string[] = [];
  for (const cycle of cycles) {
    if (cycle === null || typeof cycle !== 'object') continue;
    // The claim is read off the one shape-tolerant reader (`cycleHoldingIds`), so a bare id string on an older
    // disc is checked against the graph like any other claim instead of passing for an empty hand.
    for (const id of cycleHoldingIds(cycle)) {
      if (!(id in snapshot.nodes)) {
        dangling.push(`cycle "${cycle.id}" holds ${id}, which is not on the graph`);
      }
    }
  }

  return [
    {
      name: 'records',
      ok: gaps.length === 0,
      detail: !initialized
        ? `there is no ${PF_DIR_NAME} here yet (a new project runs ledger.init)`
        : gaps.length === 0
          ? `the layout (${LEDGER_LAYOUT.join(', ')}) is all in place`
          : gaps.join('\n'),
    },
    {
      name: 'graph',
      ok: graph.ok,
      detail: graph.ok
        ? `${graph.total} node(s), no cycles and no dangling references`
        : graph.problems.join('\n'),
    },
    {
      name: 'cycles',
      ok: dangling.length === 0,
      detail: dangling.length === 0
        ? cycles.length === 0
          ? 'no cycles yet'
          : `${cycles.length} cycle(s), every held node is on the graph`
        : dangling.join('\n'),
    },
  ];
}

/**
 * The bound on one git question the check-up asks (milliseconds).
 *
 * Reading one key of git's own config takes a few milliseconds, so the bound is never reached in
 * ordinary work: it is not a budget for a slow git, it guards against a git that never answers at all,
 * which would otherwise hold the whole check-up open. The merge-driver cell asks at most a few
 * questions, and the first question left unanswered ends the cell (red) instead of waiting again, so
 * the whole cell lands within one bound however many the git would have swallowed.
 */
export const DOCTOR_GIT_TIMEOUT_MS = 10_000;

/**
 * One question put to git with a bound on the wait: the answer, or `null` when nothing came back in time.
 *
 * The bound cancels nothing — a git is left to run to its own end, this call merely stops waiting on it,
 * which is the whole point: the check-up must be able to come back even when a git does not. The
 * milliseconds really waited are handed back so the red cell can say how long it was.
 */
function boundedGitAnswer(
  git: GitRunner,
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly result: GitResult | null; readonly waitedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ result: null, waitedMs: Date.now() - startedAt });
    }, timeoutMs);
    git.run(root, args).then(
      (result) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ result, waitedMs: Date.now() - startedAt });
      },
      (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

/**
 * The red cell of a git question that stayed unanswered within the bound: which question it was and how
 * long was waited, why that reds this cell, and what to do about it. A registration that was never read
 * is not certified as there — certifying it would tell a person to keep a line nothing has confirmed.
 */
function unansweredCell(args: readonly string[], waitedMs: number, timeoutMs: number): DoctorCheck {
  return {
    name: 'merge-driver',
    ok: false,
    detail:
      `git did not answer within ${timeoutMs} ms (waited ${waitedMs} ms) for \`git ${args.join(' ')}\`: ` +
      'the registration of the merge driver cannot be read here, and a registration that was never read ' +
      'is not certified as there, so this cell is red -- two branches that both changed a record may ' +
      'still come back as a plain git conflict; find out what git is waiting on in this project and run ' +
      'ledger.register',
  };
}

/**
 * The merge-driver cell of the check-up: git's `merge.pf.driver` is registered, and the registration
 * is one this machine can actually answer.
 *
 * - not a git checkout, or no git handed in: **not red** — a project outside git has nowhere to
 *   register a driver, and a reading that cannot be taken is never read as zero.
 * - one of the questions put to git unanswered within `timeoutMs`: **red** — the registration is not
 *   certified on a reading that never came back, and the cell names the question and the wait.
 * - `merge.pf.driver` absent: **red**, the same tier as an incomplete layout — merges of records
 *   come back as plain git conflicts until it is registered. The driver is the key git runs.
 * - `merge.pf.driver` there but `merge.pf.name` absent: **not red** — `merge.pf.name` is only the
 *   label git shows for the driver, so a merge is driven all the same; the detail still says the
 *   pair `ledger.register` writes is incomplete.
 * - registered in a command form this tree answers — `pf merge-ledger %O %A %B %P` (this tree's own
 *   router, the form an installed `pf` command writes) or `pf-merge-ledger %O %A %B %P` (this
 *   package's bin) — and that command resolves on `PATH` here: green.
 * - registered in one of those command forms, but its command does not resolve on `PATH`: **red** —
 *   the string was written where the command was installed, and nothing answers it here; every record
 *   merge comes back as a plain git conflict.
 * - registered in the absolute form (the quoted node path plus the quoted built entry), and both
 *   those paths are files here: **not red**, but said out loud — the two paths it names are here,
 *   and a moved checkout or another machine breaks it, so it should be re-registered as the command
 *   form.
 * - registered in that absolute form but pointing at paths that are not here (a moved checkout):
 *   **red**, with the re-register advice rather than "both quoted paths are here".
 * - registered as anything else — neither form: **red**, and the sentence names the value and says
 *   to re-register. Nothing this tree answers such a string, so a merge of records still comes back
 *   as a plain git conflict; certifying it would tell a person to keep a dead line.
 */
async function mergeDriverCheck(
  root: string,
  git: GitRunner | undefined,
  timeoutMs: number,
): Promise<DoctorCheck> {
  if (git === undefined) {
    return {
      name: 'merge-driver',
      ok: true,
      detail: 'not asked: no git was handed in, so where the driver is registered cannot be read',
    };
  }
  try {
    const checkout = await boundedGitAnswer(git, root, ['rev-parse', '--git-common-dir'], timeoutMs);
    if (checkout.result === null) {
      return unansweredCell(['rev-parse', '--git-common-dir'], checkout.waitedMs, timeoutMs);
    }
    if (checkout.result.code !== 0) {
      return {
        name: 'merge-driver',
        ok: true,
        detail: 'not a git checkout: there is nowhere to register a merge driver, so nothing is missing',
      };
    }
    const nameArgs = ['config', '--local', '--get', 'merge.pf.name'] as const;
    const nameRead = await boundedGitAnswer(git, root, nameArgs, timeoutMs);
    if (nameRead.result === null) return unansweredCell(nameArgs, nameRead.waitedMs, timeoutMs);
    const driverArgs = ['config', '--local', '--get', 'merge.pf.driver'] as const;
    const driverRead = await boundedGitAnswer(git, root, driverArgs, timeoutMs);
    if (driverRead.result === null) return unansweredCell(driverArgs, driverRead.waitedMs, timeoutMs);
    /** One read key: a key git does not have is absent, not empty (git says so with its exit code and no text). */
    const readKey = (result: GitResult): string | null => {
      const value = result.stdout.trim();
      return result.code === 0 && value !== '' ? value : null;
    };
    const name = readKey(nameRead.result);
    const driver = readKey(driverRead.result);
    // git runs the driver and shows the name; a driver without its label still drives merges, so
    // only the driver key missing is the red state — the label's absence is said, not redded.
    if (driver === null) {
      const missing = name === null ? 'merge.pf.driver and merge.pf.name' : 'merge.pf.driver';
      return {
        name: 'merge-driver',
        ok: false,
        detail:
          `the merge driver is not registered (${missing} missing): two branches that ` +
          'both changed a record come back as a plain git conflict -- run ledger.register',
      };
    }
    const incompletePair =
      name === null
        ? '. The pair ledger.register writes is incomplete: merge.pf.name (the label git shows for ' +
          'the driver, not what drives a merge) is not set -- run ledger.register to write the pair'
        : '';
    // The shape alone is not the answer: the string was written where its command was on `PATH`, and
    // this machine may not have it. Ask the same reading the writer asked, over the same two command
    // forms — this package's bin, and this tree's own `pf merge-ledger` word.
    const command = namedDriverCommand(driver);
    if (command !== null) {
      const form = driver.startsWith(`${MERGE_DRIVER_PF_FORM} `) ? MERGE_DRIVER_PF_FORM : MERGE_DRIVER_NAME_FORM;
      if (resolvesOnPath(command)) {
        return {
          name: 'merge-driver',
          ok: true,
          detail: `registered in the name form (${form}), which resolves on PATH here${incompletePair}`,
        };
      }
      return {
        name: 'merge-driver',
        ok: false,
        detail:
          `registered in the name form (${form}), but ${command} ` +
          'does not resolve on PATH on this machine: nothing answers it, so a merge of records ' +
          'comes back as a plain git conflict -- put it on PATH and re-register with ledger.register',
      };
    }
    if (driver.startsWith('"')) {
      // The quoted form this package writes names two paths. Certify it only when both are here;
      // a moved checkout leaves them behind, and that is exactly the string a person is about to
      // keep because the paths were there the day the cell last looked.
      const absolute = readAbsoluteForm(driver);
      if (absolute.shaped && absolute.missing.length === 0) {
        return {
          name: 'merge-driver',
          ok: true,
          detail:
            `registered in the absolute form (${driver}): both quoted paths are here, but a moved ` +
            `checkout or another machine breaks it -- re-register as the name form ` +
            `(${MERGE_DRIVER_PF_FORM} or ${MERGE_DRIVER_NAME_FORM} on PATH)${incompletePair}`,
        };
      }
      if (absolute.shaped) {
        return {
          name: 'merge-driver',
          ok: false,
          detail:
            `registered as ${driver}: the absolute form points at ${absolute.missing.join(' and ')}, ` +
            `which ${absolute.missing.length === 1 ? 'is' : 'are'} not on this machine any more (a ` +
            'moved checkout leaves its paths behind), so nothing answers a merge of records -- ' +
            're-register it with ledger.register (the name form, ' +
            `${MERGE_DRIVER_PF_FORM} or ${MERGE_DRIVER_NAME_FORM} on PATH, survives a moved checkout)`,
        };
      }
    }
    return {
      name: 'merge-driver',
      ok: false,
      detail:
        `registered as ${driver}: that is neither the name form (${MERGE_DRIVER_PF_FORM} %O %A %B %P ` +
        `or ${MERGE_DRIVER_NAME_FORM} %O %A %B %P) nor the absolute form (this package's built entry, ` +
        'both paths quoted), so no command answers it and a merge of records comes back as a plain ' +
        'git conflict -- re-register it with ledger.register',
    };
  } catch {
    return {
      name: 'merge-driver',
      ok: true,
      detail: 'not asked: git answered nothing this time, so the registration is not judged',
    };
  }
}
