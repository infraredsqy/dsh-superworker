import { declarationProblems } from '../plugins/declare';
import { commandsOf } from '../plugins/tables';
import type { PluginCommandEntry, PluginFolder } from '../plugins/types';
import { CORE_COMMAND_WORDS } from './core-words';

/**
 * The routing table of plugin command words, kept beside the word table it yields to: a declared word
 * that collides with a core word never routes (the core wins), and when two plugins claim one word the
 * first folder keeps it.
 *
 * The clash is judged against `CORE_COMMAND_WORDS`, which is worked out from the word table itself — so
 * the router's precedence and doctor's report read the same set, and a word the table answers can never
 * quietly belong to a plugin.
 */

/**
 * The commands every plugin declares with a sound declaration surface, in folder order (the first to claim one
 * keeps it). Words belong to the declaration: whether code exists does not shake this cell (listing is never
 * executing).
 */
export function commandTable(folders: readonly PluginFolder[]): PluginCommandEntry[] {
  const out: PluginCommandEntry[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const decl = folder.decl;
    if (decl === null || declarationProblems(folder).length > 0) continue;
    const commands = (decl as Record<string, unknown>).commands;
    const cells = commands !== null && typeof commands === 'object' && !Array.isArray(commands)
      ? (commands as Record<string, unknown>)
      : {};
    for (const key of commandsOf(folder)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = cells[key] as Record<string, unknown>;
      const keep = cell.keep_name;
      out.push({
        name: key,
        plugin: folder.name,
        keepName: keep === undefined || keep === null ? true : keep === true,
        summary: typeof cell.summary === 'string' ? cell.summary.trim() : '',
      });
    }
  }
  return out;
}

/** The commands that collide with a core word: the core wins, the plugin's word does not route, and doctor says one line. */
export function commandClashes(folders: readonly PluginFolder[]): string[] {
  return commandTable(folders)
    .filter((entry) => CORE_COMMAND_WORDS.has(entry.name))
    .map((entry) =>
      `plugin ${JSON.stringify(entry.plugin)}: command ${JSON.stringify(entry.name)} is a word this core ` +
      'already answers, so the core keeps it and this one never routes');
}

/** The routing table: commands colliding with a core word are taken off (the core wins), and when two plugins collide the first one keeps the word. */
export function routableCommands(folders: readonly PluginFolder[]): PluginCommandEntry[] {
  return commandTable(folders).filter((entry) => !CORE_COMMAND_WORDS.has(entry.name));
}
