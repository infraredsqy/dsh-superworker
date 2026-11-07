import { homedir } from 'node:os';
import { join } from 'node:path';
import { envHomeDir } from './env.ts';
import { RecordError } from './errors.ts';

/**
 * The `.superworker` directory layout: the record directory, the four records, the signals directory, node
 * directories, metadata and session files.
 *
 * Every write location is given by the constants and functions here; no arbitrarily spelled path
 * string is accepted as a location. Item by item (the record directory, the four records, and the
 * separate locations of session files and the issue pool):
 *
 *   <root>/.superworker/                        record directory
 *     state.json                         lines (the `cycles` table)
 *     ideas.json                         nodes (the `nodes` table)
 *     instructions.json                  instructions
 *     issues/issues.json                 issue pool (the `issues` table; kept in the issues/ subdirectory)
 *     config.json                        project-layer settings (init lays down an empty object; the machine layer is `<home>/.superworker/config.json`)
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
export const RECORD_DIR_NAME = '.superworker';

/**
 * The three record file names and the handoff tickets' directory name: `recordPaths` builds every location from
 * these, and the merge driver recognises a record by the same names (a second spelling of them is a second
 * landing table, which is exactly what the driver must not have).
 */
export const STATE_FILE_NAME = 'state.json';
export const IDEAS_FILE_NAME = 'ideas.json';
export const INSTRUCTIONS_FILE_NAME = 'instructions.json';
export const SIGNALS_DIR_NAME = 'signals';

/** Every location of one record tree. `root` is the project root open received, kept as it is. */
export interface RecordPaths {
  readonly root: string;
  readonly recordDir: string;
  readonly stateJson: string;
  readonly ideasJson: string;
  readonly instructionsJson: string;
  readonly issuesJson: string;
  /** Project-layer settings: `<record>/config.json` (init lays down an empty object). */
  readonly configJson: string;
  readonly signalsDir: string;
  readonly nodesDir: string;
  /**
   * Every worktree of the parallel mode hangs here: `<record>/worktrees/<short id>/`, where the short id
   * is the node uuid's first eight characters and the exit branch is `sw/<short id>`. Creating the
   * checkout and its branch, and removing both, is git's own job, driven by hand.
   */
  readonly worktreesDir: string;
  readonly metaDir: string;
  readonly sessionsDir: string;
}

/** Give every location of the record tree from the project root. */
export function recordPaths(projectRoot: string): RecordPaths {
  const recordDir = join(projectRoot, RECORD_DIR_NAME);
  return {
    root: projectRoot,
    recordDir,
    stateJson: join(recordDir, STATE_FILE_NAME),
    ideasJson: join(recordDir, IDEAS_FILE_NAME),
    instructionsJson: join(recordDir, INSTRUCTIONS_FILE_NAME),
    issuesJson: join(recordDir, 'issues', 'issues.json'),
    configJson: join(recordDir, 'config.json'),
    signalsDir: join(recordDir, SIGNALS_DIR_NAME),
    nodesDir: join(recordDir, 'nodes'),
    worktreesDir: join(recordDir, 'worktrees'),
    metaDir: join(recordDir, 'meta'),
    sessionsDir: join(recordDir, 'meta', 'sessions'),
  };
}

/**
 * One node id is one directory or file name inside a record directory. An id carrying a path separator,
 * a `.` / `..` segment or nothing at all would join to a location outside that node's own place — the
 * empty string joins to the directory itself, `..` to the superworker directory, a separator to anywhere at all —
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
function assertOneNodeId(paths: RecordPaths, nodeId: string): void {
  if (nodeId === '' || nodeId === '.' || nodeId === '..' || nodeId.includes('/') || nodeId.includes('\\')) {
    throw new RecordError(
      'node_not_found',
      paths.ideasJson,
      `the node id ${JSON.stringify(nodeId)} is not one name a record directory can hold: an empty id, a ` +
        'self or parent segment, or one carrying a path separator would address a file outside that ' +
        'node\'s own place; nothing was read or written.',
    );
  }
}

/** The directory of one node: `<record>/nodes/<node>/`. */
export function nodeDir(paths: RecordPaths, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(paths.nodesDir, nodeId);
}

/** The file name of spec.md. add lays down the node directory only; the file appears once the requirements are written. */
export const SPEC_FILE_NAME = 'spec.md';

/**
 * The spec.md location of one node: `<record>/nodes/<node>/spec.md`, with forward slashes as a human
 * reads it. The graph side (`ledger.dag.specPath`) and dispatch preparation (which cites it in the
 * run doc) both take the spelling from here.
 */
export function nodeSpecPath(paths: RecordPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), SPEC_FILE_NAME).split('\\').join('/');
}

/**
 * The run doc location of one node: `<record>/nodes/<node>/run.md`. Dispatch preparation sets it up on
 * the first preparation (once written it is not touched again — that round's session keeps writing
 * into it), and a repeated preparation does not produce a second one.
 */
export function nodeRunDocPath(paths: RecordPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'run.md');
}

/** The settings layer of one node's own: `<record>/nodes/<node>/config.json`. */
export function nodeConfigPath(paths: RecordPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'config.json');
}

/**
 * The home directory the machine layer lives in: `<home>/.superworker/`. home is resolved in this order: the
 * option the call hands in (tests shut it into a temporary directory), then `SUPERWORKER_HOME_DIR`, then this
 * machine's user home directory. The option wins over the switch on purpose: a sandbox stays closed
 * even when the environment names a home.
 *
 * That directory is a record directory of its own — the machine layer's settings file hangs in it —
 * so its writers hold that directory's ledger lock (`<home>/.superworker/meta/ledger.lock`): the same protocol
 * as a project tree's record lock, its own file, never the project tree's.
 */
export function globalHomeDir(homeDir?: string): string {
  return homeDir ?? envHomeDir() ?? homedir();
}

/** The location of the machine-layer settings file: `<home>/.superworker/config.json` — the same spelling as the project layer. */
export function globalConfigPath(homeDir?: string): string {
  return join(globalHomeDir(homeDir), RECORD_DIR_NAME, 'config.json');
}

/** The process-artifact directory of one node: `<record>/nodes/<node>/temp/` (temporary, not in the repository). */
export function nodeTempDir(paths: RecordPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'temp');
}

/** The location of one handoff ticket: `<record>/signals/<line>/<node>.json`. */
export function signalPath(paths: RecordPaths, cycleId: string, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(paths.signalsDir, cycleId, `${nodeId}.json`);
}

/** The session file of one node: `<record>/meta/sessions/<node>.json`. */
export function sessionNotePath(paths: RecordPaths, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(paths.sessionsDir, `${nodeId}.json`);
}

/**
 * The dispatch-piece directory of one line: `<record>/meta/launch/<line>/` — one subdirectory per node.
 * One node's prompt and its dispatch marker both hang here, so the path is spelled in this one place.
 */
export function launchDir(paths: RecordPaths, cycleId: string): string {
  return join(paths.metaDir, 'launch', cycleId);
}

/** The prompt location handed to the session when one node is dispatched: `<record>/meta/launch/<line>/<node>/prompt.txt`. */
export function launchPromptPath(paths: RecordPaths, cycleId: string, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(launchDir(paths, cycleId), nodeId, 'prompt.txt');
}

/**
 * The marker of a successful dispatch: `<record>/meta/launch/<line>/<node>/started`.
 * The plan no longer counts this node in the dispatch list (a second session could never be taken
 * back), and the two paths that hand out the next step skip it on the same reading.
 */
export function startedMarkerPath(paths: RecordPaths, cycleId: string, nodeId: string): string {
  assertOneNodeId(paths, nodeId);
  return join(launchDir(paths, cycleId), nodeId, 'started');
}

/** The location of the cross-process lock: `<record>/meta/ledger.lock`. */
export function ledgerLockPath(paths: RecordPaths): string {
  return join(paths.metaDir, 'ledger.lock');
}

/**
 * The record tree's own locations as one read: the directory spellings, plus the two file builders a
 * caller prints (a refusal naming the ticket it expected, a dispatch naming the prompt it wrote). A
 * caller that has to print a location asks here instead of spelling `.superworker` itself — the layout stays in
 * this file.
 */
export interface RecordLocations {
  readonly paths: RecordPaths;
  /** One handoff ticket: `<record>/signals/<line>/<node>.json`. */
  signal(cycleId: string, nodeId: string): string;
  /** One dispatch's prompt: `<record>/meta/launch/<line>/<node>/prompt.txt`. */
  launchPrompt(cycleId: string, nodeId: string): string;
}

/** The record tree's locations of one project root, as one read. */
export function recordLocations(projectRoot: string): RecordLocations {
  const paths = recordPaths(projectRoot);
  return {
    paths,
    signal: (cycleId, nodeId) => signalPath(paths, cycleId, nodeId),
    launchPrompt: (cycleId, nodeId) => launchPromptPath(paths, cycleId, nodeId),
  };
}
