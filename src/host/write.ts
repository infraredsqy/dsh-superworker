/**
 * The host half's write surface: every record-touching action on the panel is
 * answered by the engine's own words layer, in this process.
 *
 * No JSON is assembled here and nothing under `.superworker` is touched; the words layer
 * does the writing and prints its own reasons for refusal. There is no command
 * between the panel and the engine — no entry file, no child process, no PATH
 * lookup, no shell — so nothing on the way can re-interpret a value; the
 * agent-facing tool answers through this same layer. The user's verbatim
 * sentence may be any sentence, with spaces, quotes and `&`: it rides as one
 * argv cell, the way the tool hands its own line over. `SUPERWORKER_PLUGINS_DIR` is the
 * engine's deployment switch, not this side's: the host half names the
 * folder it ships (`shippedPluginsDir()`) rather than reading that switch, so
 * moving it moves the engine's view and not the panel's.
 */
import { answer, type Executor, type WordsIO } from 'superworker-core'
import type { RecordOutcome } from './failure.ts'
import { hostGitRunner } from './git.ts'
import { shippedPackageRoot, shippedPluginsDir } from './skill-paths.ts'

/**
 * The seams one word line answers through, assembled in one place: the project
 * root it answers at, the plugin folder this package ships, the git capability,
 * and — when the caller can really open a session — the opener seam together
 * with the flag that says so.
 *
 * The flag follows the seam rather than being set per call site: a call handed an
 * opener may really open a session, and one without it answers every read word
 * honestly and no more. That is the whole difference between the panel's write
 * path and the agent-facing tool, and it is stated here once.
 */
export function answerHandleOf(root: string, opener?: { readonly executor: Executor }): WordsIO {
  return {
    root,
    pluginsDir: shippedPluginsDir(),
    // Where this line is deployed: the words about the checkout print this, they do not guess it.
    packageRoot: shippedPackageRoot(),
    git: hostGitRunner(),
    ...(opener === undefined ? {} : { executor: opener.executor, openerAvailable: true }),
  }
}

/**
 * Run one word line and collect its answer.
 * @param workspaceRoot - The project root the words answer at.
 * @param args - The word line, as the words layer spells it.
 * @param said - The user's verbatim sentence, appended to the line as one last cell, as-is.
 */
export async function runWords(workspaceRoot: string, args: readonly string[], said?: string): Promise<RecordOutcome> {
  const settled = await answer(said === undefined ? args : [...args, said], answerHandleOf(workspaceRoot))
  if (settled.code === 0) return { ok: true, text: settled.stdout.trim() }
  /* A non-zero answer is not this plugin's sentence to write: the words layer said its own
   * reason on one of the two streams, and that reason travels as `detail`, verbatim. */
  const detail = [settled.stderr, settled.stdout].join('\n').trim()
  return { ok: false, code: 'tool-refused', ...(detail.length > 0 ? { detail } : {}) }
}
