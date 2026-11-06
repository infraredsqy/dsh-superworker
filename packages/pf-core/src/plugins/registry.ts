/**
 * The plugin registry's export surface. The five jobs that used to live in this one file are now read
 * where they belong, and this module keeps the names their readers already import:
 *
 * - `scan.ts` — the load scan: the plugin directory, the folder entries, the implementation loader;
 * - `declare.ts` — the closed-set validation of one declaration, and the names across plugins;
 * - `tables.ts` — the merged tables: knobs, readings, tags, methods, the listing;
 * - `skills.ts` — a plugin's own skills, and the two ways they disagree with a declaration;
 * - `doctor.ts` — doctor's strict face: declarations, implementations, sources, a real question put to
 *   each implementation on a stand-in project;
 * - `doors.ts` — the timing door's contract: the door names, "none this round", the failure sentences;
 * - `words/plugin-commands.ts` — the command words a plugin claims, judged against the word table.
 *
 * `cells.ts` holds the small pieces those readers share (the folder ordering and the cell readers).
 */

export { PLUGIN_DECLARATION_NAME, PLUGIN_IMPL_NAME, loadPlugins, pluginsDirOf, implPathOf, implOf, runtimeProblemOf } from './scan';
export type { PluginScan } from './scan';

export { isOneWord } from './cells';

export { conflicts, declarationProblems, folderProblems, usable } from './declare';

export {
  commandsOf,
  declaredKnobSpecs,
  methodsOf,
  pluginListing,
  readingsOf,
  shadowedKnobs,
  sourcesOf,
  tagsOf,
} from './tables';

export { PLUGIN_SKILL_FILE, PLUGIN_SKILLS_DIR, skillFolders, skillProblems } from './skills';

export { previewGaps, verifyPlugins } from './doctor';

export { noneThisRound, previewDoorOf } from './doors';

export { CORE_COMMAND_WORDS } from '../words/core-words';
export { commandClashes, commandTable, routableCommands } from '../words/plugin-commands';
