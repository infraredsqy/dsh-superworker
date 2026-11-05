/**
 * The host half's write surface: every record-touching action on the panel is
 * answered by the engine's own words layer, in this process.
 *
 * No JSON is assembled here and nothing under `.pf` is touched; the words layer
 * does the writing and prints its own reasons for refusal. There is no command
 * between the panel and the engine — no entry file, no child process, no PATH
 * lookup, no shell — so nothing on the way can re-interpret a value; the
 * agent-facing tool answers through this same layer. The user's verbatim
 * sentence may be any sentence, with spaces, quotes and `&`: it rides as one
 * argv cell, the way the tool hands its own line over. `PF_PLUGINS_DIR` is the
 * `pf` command's deployment switch, not this side's: the host half names the
 * folder it ships (`shippedPluginsDir()`) rather than reading that switch, so
 * moving it moves the command's view and not the panel's.
 */
import { answer } from 'pf-core'
import type { PfOutcome } from './failure.ts'
import { shippedPluginsDir } from './skills.ts'

/**
 * Run one word line and collect its answer.
 * @param workspaceRoot - The project root the words answer at.
 * @param args - The word line, as the words layer spells it.
 * @param said - The user's verbatim sentence, appended to the line as one last cell, as-is.
 */
export async function runPf(workspaceRoot: string, args: readonly string[], said?: string): Promise<PfOutcome> {
  const settled = await answer(said === undefined ? args : [...args, said], {
    root: workspaceRoot,
    pluginsDir: shippedPluginsDir(),
  })
  if (settled.code === 0) return { ok: true, text: settled.stdout.trim() }
  /* A non-zero answer is not this plugin's sentence to write: the words layer said its own
   * reason on one of the two streams, and that reason travels as `detail`, verbatim. */
  const detail = [settled.stderr, settled.stdout].join('\n').trim()
  return { ok: false, code: 'tool-refused', ...(detail.length > 0 ? { detail } : {}) }
}