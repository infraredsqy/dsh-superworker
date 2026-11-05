import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDagNamespace } from './dag';
import { nowSeconds } from './clock';
import { pluginAssemblyOf } from './plugins/assembly';
import { createContext, readGraphSnapshot, warnLine } from './plugins/context';
import { collectGates, collectOffers } from './plugins/host';
import { applyInsertion } from './plugins/insertion';
import {
  commandClashes,
  implOf,
  pluginListing,
  pluginsDirOf,
  routableCommands,
  shadowedKnobs,
  verifyPlugins,
} from './plugins/registry';
import type { DispatchRequest, Executor, OpenedSession } from './executor';
import { envSpawnDryRun, envSpawner, zcodeDataDir } from './env';
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
import { planNext, promptTextOf, settleClose, settleCloseWithAnswers } from './planner';
import { prepareDispatch, ticketReadings } from './prepare';
import type { PreparedDispatch } from './prepare';
import { launchPromptPath, PF_DIR_NAME, pfPaths, signalPath, startedMarkerPath, type PfPaths } from './paths';
import type { DagNamespace } from './ledger';
import type { CycleRecord, HandoffRecord, NodeMode, NodeResult } from './types';
import type { PluginFolder } from './plugins/types';
import type { PluginCommandEntry } from './plugins/types';
import { withLedgerLock } from './ledgerlock';
import { createCyclesNamespace, cyclePolicy } from './cycles';

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
 * What one dispatch names on the call itself: the line, the node, and the spawner. The spawner is the
 * most specific answer for this one dispatch — it beats the line's `spawner` policy, and that beats the
 * machine's own `DSH_CONDUCT_SPAWNER`. A bare word (`dsh` / `zcode`) or a path both count; left out,
 * the executor's own default opens the session.
 */
export interface ConductorDispatchInput extends ConductorTarget {
  spawner?: string;
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
 * One query of `next`: the read-only mode, plus one closing rehearsal.
 *
 * - `plan` — the explicit spelling of the "read-only, do not execute" mode: in the words layer it is
 *   `next --plan`. This one word takes only `true` here (read-only is the default); writing `false`
 *   is refused on the spot, because the action that carries the next step out is called
 *   `conductor.dispatch`, the two actions each go through their own gate, and there is no "execute it on
 *   the way" fork on the `next` path.
 * - `after` — the closing rehearsal: name the node whose work is already handed back (the ticket is on
 *   disk) and ask "settling on it, where would this line go". Taking the node and landing the prompt
 *   are write-side matters, and `next` only computes the verdict.
 * - `decision` / `note` / `node` — the answers of the closing step (continue / stop, one line of reason,
 *   which node to name instead). They only have something to answer when `after` is present; given on
 *   their own they are accepted all the same and have no effect.
 */
export interface NextQuery extends ConductorTarget {
  plan?: boolean;
  after?: string;
  decision?: 'continue' | 'stop';
  note?: string;
}

/**
 * The next step: a plan that can be read and explained and is not executed.
 *
 * The literals of the action bag and their key order are fixed (the output of `next --plan --json`), and
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

/**
 * The closing answers a settle can carry: which way the closing call decided, one line of reason, and the
 * node to run instead of the ranking's pick. The same answers the closing rehearsal of `next` takes.
 */
export interface ConductorCloseAnswers extends ConductorTarget {
  readonly decision?: 'continue' | 'stop';
  readonly note?: string;
  /** Run this node instead of the ranking's pick (a full id or a prefix). */
  readonly named?: string;
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

/** The pipeline namespace: the group of actions that pushes a line along, these ten verbs. */
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
  /** Write one handoff ticket, landing at "line id / node id" under signals. */
  handoff(input: ConductorHandoffInput): Promise<HandoffRecord>;
  /** Close out the line and settle. */
  close(input?: ConductorTarget): Promise<CycleRecord>;
  /**
   * Close out the line and settle, with the closing answers the caller carries: continue / stop, one line of
   * reason, or a node named instead of the ranking's pick. Everything else is the same settle `close` lands.
   */
  closeWith(input?: ConductorCloseAnswers): Promise<CycleRecord>;
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
    const holding = Array.isArray(cycle.holding) ? cycle.holding : [];
    const first = holding.find((item) => item !== null && typeof item === 'object' && typeof item.id === 'string');
    if (first !== undefined) return first.id as string;
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
   * The settle both closing verbs land: the gates, the plugin half asked before the lock, one
   * transaction over the records, and the closing insertion seam. `answers` is what a closing call
   * may carry (continue / stop, one line of reason, a named node); without them the criteria decide
   * on their own.
   */
  const settleNode = async (
    input: (ConductorCloseAnswers | ConductorTarget) | undefined,
    answers?: ConductorCloseAnswers,
  ): Promise<CycleRecord> => {
    assertLedgerInitialized(paths);
    const cycle = await resolveCycle(input?.cycle);
    const cycleId = String(cycle.id ?? '');
    const nodeId = heldNodeId(cycle, input?.node);
    const known = await dag.get(nodeId);
    if (known === null) {
      throw new Error(`node ${nodeId} not found`);
    }
    // Gate one of the closing: the node must be on this line's claim list (the same gate as the closing itself).
    const inHand = (Array.isArray(cycle.holding) ? cycle.holding : []).some(
      (item) => item !== null && typeof item === 'object' && (item as { id?: unknown }).id === nodeId,
    );
    if (!inHand) {
      const names = (Array.isArray(cycle.holding) ? cycle.holding : [])
        .map((item) => String((item as { id?: unknown }).id ?? '').slice(0, 8))
        .filter((name) => name !== '');
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
    // The plugin half of the close — the scan, the dynamic load, every plugin's question — is asked here, before
    // the lock is taken, on one snapshot of the scene (the line and the ticket as read just above). How long a
    // plugin takes to answer is how long it takes and no writer waits on it: no record of this ledger is written
    // in this stretch. What the answered offers want in the graph is landed under the lock by the mechanism below.
    const warnings: string[] = [];
    const folders = await pluginAssemblyOf(root, options.pluginsDir).folders();
    const snapshot = await readGraphSnapshot(paths);
    const ctx = createContext({
      root,
      folders,
      homeDir: options.homeDir,
      warnings,
      cycle: cycle as unknown as Record<string, unknown>,
      nodeId,
      sig,
      dag: snapshot,
      target: null,
    });
    const offers = await collectOffers('close', ctx, folders, warnings);
    return withLedgerLock(paths, async () => {
      // The first thing under the lock: the line and the ticket are read again, and the settle answers to these
      // bytes. What the plugin half was handed above is a snapshot taken before the lock — the plugins judge on
      // that scene, they do not decide the verdict.
      const line = await resolveCycle(cycleId);
      const ticket = await ticketOf(cycleId, nodeId);
      if (ticket === null || ticket.status === 'pending') throw nothingToSettle(cycleId, nodeId);
      // The settling criteria are shared with the plan (settleClose): the verdict word, walk or stop, the slot
      // list, and whether the line parks.
      const settle = answers === undefined
        ? await settleClose(root, line, nodeId, ticket)
        : await settleCloseWithAnswers(root, line, nodeId, ticket, answers);
      // Transactional: a snapshot is taken before the records move, and a mid-way failure puts them back by the
      // snapshot — no half record is left.
      const before = [
        await snapshotRecord(paths.stateJson),
        await snapshotRecord(paths.ideasJson),
      ];
      try {
        // The mechanical steps of the settle, in the order of the closing command list: first record the step (the
        // verdict goes into path, the claim is laid down), then mark the graph (a delivery lands completed, a
        // non-delivery lands shelved), then pin the filled slots one by one or turn the line out of service. When
        // the line is not in service, only the recording happens (settle.parkLine=false, no slot is filled).
        await cycles.close(cycleId, { node: nodeId, result: settle.outcome });
        await dag.setStatus(nodeId, settle.delivered ? 'completed' : 'shelved');
        if (settle.decision === 'continue' && settle.filled.length > 0) {
          for (const slot of settle.filled) {
            await cycles.hold(cycleId, slot.id);
          }
        } else if (settle.parkLine) {
          await cycles.setStatus(cycleId, 'inactive');
        }
        // The closing insertion seam (zero semantic change): once the settle is fixed, an offer of the close timing
        // lands in the graph through the core mechanism as before; the offers were asked before the lock, and a
        // broken plugin folds into one WARNING line and does not take part this round, while the main flow goes on
        // as usual.
        for (const offer of offers) {
          try {
            // The closing seam has no picking step yet: the insertion hangs behind the node being closed, with no before.
            await applyInsertion(root, dag, offer, nodeId, null, warnings);
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

  return {
    next: async (input) => {
      const query = input ?? {};
      if (query.plan === false) {
        throw new Error(
          'conductor.next is a read-only plan (the `next --plan` mode): it reads the records and hands ' +
            'back what the next step is, writing not one byte. The action that carries the next step out is ' +
            'conductor.dispatch.',
        );
      }
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
      // handoff).
      const cycle = await resolveCycle(cycleId);
      const holding = Array.isArray(cycle.holding) ? cycle.holding : [];
      const inHand = holding.some(
        (item) => item !== null && typeof item === 'object' && (item as { id?: unknown }).id === nodeId,
      );
      if (!inHand) {
        const names = holding
          .map((item) => String((item as { id?: unknown }).id ?? '').slice(0, 8))
          .filter((name) => name !== '');
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
      const warnings: string[] = [];
      // One assembly for this dispatch: the gate reads the folder once, and the preparation below is handed
      // the same copy instead of reading it a second time.
      const assembly = pluginAssemblyOf(root, options.pluginsDir);
      const folders = await assembly.folders();
      const snapshot = await readGraphSnapshot(paths);
      const ctx = createContext({
        root,
        folders,
        homeDir: options.homeDir,
        warnings,
        cycle: cycle as unknown as Record<string, unknown>,
        nodeId,
        sig: null,
        dag: snapshot,
        target: null,
      });
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
      // Which spawner opens this session is the most specific answer: what this call named, then the line's
      // own `spawner` policy, then the machine's switch; with nothing said the cell is absent and the
      // executor's default speaks. The drill switch and the ZCode host's data root ride along the same seam,
      // both read at this call (never cached).
      const policySpawner = cyclePolicy(cycle).spawner;
      const namedSpawner = input?.spawner
        ?? (typeof policySpawner === 'string' ? policySpawner : undefined)
        ?? envSpawner();
      const request: DispatchRequest = {
        cycle: cycleId,
        node: nodeId,
        role: 'execute',
        prompt: material.prompt_text,
        ...(namedSpawner === undefined ? {} : { spawner: namedSpawner }),
        ...(namedSpawner === 'zcode' ? { zcodeDataDir: zcodeDataDir() } : {}),
        ...(envSpawnDryRun() ? { dryRun: true } : {}),
      };
      const session = await executor.dispatch(request);
      // The claim of this dispatch: the session is out, so the marker lands and the plan stops counting this
      // cell as dispatchable. Success is never handed back without it — a missing claim would let the next
      // dispatch open a second session on a node that already has one, so a claim that cannot be written throws
      // with the session id in the message instead of folding into a warning.
      try {
        await writeStartedMarker(cycleId, nodeId);
      } catch (error) {
        throw claimMissingError(nodeId, session, error);
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

    close: async (input) => await settleNode(input),

    closeWith: async (input) => await settleNode(input, input),

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
          detail: [pluginDetail, ...pluginListing(folders), ...problems, PLUGIN_LOAD_NOTE].join('\n'),
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
    for (const held of cycle.holding ?? []) {
      const id = held !== null && typeof held === 'object' ? (held as { id?: unknown }).id : undefined;
      if (typeof id === 'string' && !(id in snapshot.nodes)) {
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
