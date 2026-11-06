import { homedir } from 'node:os';
import { join } from 'node:path';
import { envHomeDir } from './env.ts';
import { PfError } from './errors.ts';

/**
 * The `.pf` directory layout: the record directory, the four records, the signals directory, node
 * directories, metadata and session files.
 *
 * Every write location is given by the constants and functions here; no arbitrarily spelled path
 * string is accepted as a location. Item by item (the record directory, the four records, and the
 * separate locations of session files and the issue pool):
 *
 *   <root>/.pf/                        record directory
 *     state.json                         lines (the `cycles` table)
 *     ideas.json                         nodes (the `nodes` table)
 *     instructions.json                  instructions
 *     issues/issues.json                 issue pool (the `issues` table; kept in the issues/ subdirectory)
 *     config.json                        project-layer settings (init lays down an empty object; the machine layer is `<home>/.pf/config.json`)
 *     signals/<line>/<node>.json         handoff tickets
 *     nodes/<node>/                      node directory (spec, run.md run doc, report group, temp/; `config.json` is a settings layer of one node's own)
 *     worktrees/<short id>/              the worktree of one node under the parallel mode (one checkout per node, removed after the merge back at closing)
 *     meta/                              where the pipeline pieces live (cross-process lock, session files, dispatch pieces)
 *       ledger.lock                      cross-process lock (present while held, an empty file)
 *       sessions/<node>.json             session file
 *       launch/<line>/<node>/prompt.txt  the prompt handed to the session at dispatch (written by dispatch later)
 *       launch/<line>/<node>/started     the marker of a successful dispatch: this node's session is already running
 */

/** The name of the record directory, hung under the project root. */
export const PF_DIR_NAME = '.pf';

/** Every location of one record tree. `root` is the project root open received, kept as it is. */
export interface PfPaths {
  readonly root: string;
  readonly pfDir: string;
  readonly stateJson: string;
  readonly ideasJson: string;
  readonly instructionsJson: string;
  readonly issuesJson: string;
  /** Project-layer settings: `<pf>/config.json` (init lays down an empty object). */
  readonly configJson: string;
  readonly signalsDir: string;
  readonly nodesDir: string;
  /**
   * Every worktree of the parallel mode hangs here: `<pf>/worktrees/<short id>/`, where the short id
   * is the node uuid's first eight characters and the exit branch is `pf/<short id>`. Creating the
   * checkout and its branch, and removing both, is git's own job, driven by hand.
   */
  readonly worktreesDir: string;
  readonly metaDir: string;
  readonly sessionsDir: string;
}

/** Give every location of the record tree from the project root. */
export function pfPaths(projectRoot: string): PfPaths {
  const pfDir = join(projectRoot, PF_DIR_NAME);
  return {
    root: projectRoot,
    pfDir,
    stateJson: join(pfDir, 'state.json'),
    ideasJson: join(pfDir, 'ideas.json'),
    instructionsJson: join(pfDir, 'instructions.json'),
    issuesJson: join(pfDir, 'issues', 'issues.json'),
    configJson: join(pfDir, 'config.json'),
    signalsDir: join(pfDir, 'signals'),
    nodesDir: join(pfDir, 'nodes'),
    worktreesDir: join(pfDir, 'worktrees'),
    metaDir: join(pfDir, 'meta'),
    sessionsDir: join(pfDir, 'meta', 'sessions'),
  };
}

/**
 * One node id is one directory or file name inside a record directory. An id carrying a path separator,
 * a `.` / `..` segment or nothing at all would join to a location outside that node's own place — the
 * empty string joins to the directory itself, `..` to the pf directory, a separator to anywhere at all —
 * so it is refused here, at the one place an id becomes a path. Every builder below that takes a node id
 * runs it through this guard: the settings layer, spec, run doc and temp paths through `nodeDir`, and the
 * signal, session-file and launch paths on their own. A raw caller string is never handed to `join`.
 * Line ids are not guarded here: each caller of `signalPath` / `launchDir` takes its cycle id out of a
 * record the state reader has already resolved (`findCycle`, `resolveCycle`), so a line id that reaches
 * these builders is one the record holds.
 *
 * Through the setting verbs an empty id never gets this far: the layer pointer (`layerPointOf`) drops an
 * empty `node` / `cycle` string, finds no layer named, and refuses the call as a `TypeError`. What those
 * verbs hand to `node_not_found` is the other spellings — a separator, or a `.` / `..` segment — and this
 * guard's empty-id arm answers a caller that reaches a path builder directly.
 */
function assertOneNodeId(paths: PfPaths, nodeId: string): void {
  if (nodeId === '' || nodeId === '.' || nodeId === '..' || nodeId.includes('/') || nodeId.includes('\\')) {
    throw new PfError(
      'node_not_found',
      paths.ideasJson,
      `the node id ${JSON.stringify(nodeId)} is not one name a record directory can hold: an empty id, a ` +
        'self or parent segment, or one carrying a path separator would address a file outside that ' +
        'node\'s own place; nothing was read or written.',
    );
  }
}

/** The directory of one node: `<pf>/nodes/<node>/`. */
export function nodeDir(paths: PfPaths, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(paths.nodesDir, nodeId);
}

/** The file name of spec.md. add lays down the node directory only; the file appears once the requirements are written. */
export const SPEC_FILE_NAME = 'spec.md';

/**
 * The spec.md location of one node: `<pf>/nodes/<node>/spec.md`, with forward slashes as a human
 * reads it. The graph side (`ledger.dag.specPath`) and dispatch preparation (which cites it in the
 * run doc) both take the spelling from here.
 */
export function nodeSpecPath(paths: PfPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), SPEC_FILE_NAME).split('\\').join('/');
}

/**
 * The run doc location of one node: `<pf>/nodes/<node>/run.md`. Dispatch preparation sets it up on
 * the first preparation (once written it is not touched again — that round's session keeps writing
 * into it), and a repeated preparation does not produce a second one.
 */
export function nodeRunDocPath(paths: PfPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'run.md');
}

/** The settings layer of one node's own: `<pf>/nodes/<node>/config.json`. */
export function nodeConfigPath(paths: PfPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'config.json');
}

/**
 * The home directory the machine layer lives in: `<home>/.pf/`. home is resolved in this order: the
 * option the call hands in (tests shut it into a temporary directory), then `PF_HOME_DIR`, then this
 * machine's user home directory. The option wins over the switch on purpose: a sandbox stays closed
 * even when the environment names a home.
 *
 * That directory is a record directory of its own — the machine layer's settings file hangs in it —
 * so its writers hold that directory's ledger lock (`<home>/.pf/meta/ledger.lock`): the same protocol
 * as a project tree's record lock, its own file, never the project tree's.
 */
export function globalHomeDir(homeDir?: string): string {
  return homeDir ?? envHomeDir() ?? homedir();
}

/** The location of the machine-layer settings file: `<home>/.pf/config.json` — the same spelling as the project layer. */
export function globalConfigPath(homeDir?: string): string {
  return join(globalHomeDir(homeDir), PF_DIR_NAME, 'config.json');
}

/** The process-artifact directory of one node: `<pf>/nodes/<node>/temp/` (temporary, not in the repository). */
export function nodeTempDir(paths: PfPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'temp');
}

/** The location of one handoff ticket: `<pf>/signals/<line>/<node>.json`. */
export function signalPath(paths: PfPaths, cycleId: string, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(paths.signalsDir, cycleId, `${nodeId}.json`);
}

/** The session file of one node: `<pf>/meta/sessions/<node>.json`. */
export function sessionNotePath(paths: PfPaths, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(paths.sessionsDir, `${nodeId}.json`);
}

/**
 * The dispatch-piece directory of one line: `<pf>/meta/launch/<line>/` — one subdirectory per node.
 * One node's prompt and its dispatch marker both hang here, so the path is spelled in this one place.
 */
export function launchDir(paths: PfPaths, cycleId: string): string {
  return join(paths.metaDir, 'launch', cycleId);
}

/** The prompt location handed to the session when one node is dispatched: `<pf>/meta/launch/<line>/<node>/prompt.txt`. */
export function launchPromptPath(paths: PfPaths, cycleId: string, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(launchDir(paths, cycleId), nodeId, 'prompt.txt');
}

/**
 * The marker of a successful dispatch: `<pf>/meta/launch/<line>/<node>/started`.
 * The plan no longer counts this node in the dispatch list (a second session could never be taken
 * back), and the two paths that hand out the next step skip it on the same reading.
 */
export function startedMarkerPath(paths: PfPaths, cycleId: string, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(launchDir(paths, cycleId), nodeId, 'started');
}

/** The location of the cross-process lock: `<pf>/meta/ledger.lock`. */
export function ledgerLockPath(paths: PfPaths): string {
  return join(paths.metaDir, 'ledger.lock');
}
