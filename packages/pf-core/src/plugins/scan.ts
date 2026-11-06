import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envPluginsDir } from '../env';
import { readJsonFile } from '../jsonio';
import { byName } from './cells';
import type { PluginDeclaration, PluginFolder, PluginImplModule } from './types';

/**
 * The load scan: reading the plugin directory, and loading an implementation entry into this process.
 *
 * - the directory is one folder per plugin; a folder starting with a dot or with `__` does not count
 *   (build output and odds and ends), and one bad folder does not affect its neighbours;
 * - the implementation is loaded into this process by dynamic import, one module object per file
 *   (register + reuse), and a load failure is recorded in the runtime problem table for doctor to
 *   report, never thrown into the main flow.
 *
 * **The scan is not cached**: the folder on disk is the only answer, so a plugin installed or removed
 * is visible on the next call. What one call shares is the assembly's business (`assembly.ts`), not
 * this module's.
 */

/** The file names of the implementation entry: a declaration and an implementation entry are the two things that must be in a plugin folder. */
export const PLUGIN_DECLARATION_NAME = 'plugin.json';
export const PLUGIN_IMPL_NAME = 'impl.mjs';

/**
 * The location of the plugin directory: the option the call hands in, then `PF_PLUGINS_DIR`, then
 * `<root>/plugins` — one folder per plugin. The option wins over the switch, so a caller that names
 * a folder reads that folder whatever the environment says.
 */
export function pluginsDirOf(root: string, pluginsDir?: string): string {
  return pluginsDir ?? envPluginsDir() ?? join(root, 'plugins');
}

/** The reading of the load scan: folders ordered by name, plus the problems of the plugin directory itself (an absent directory is a normal state). */
export interface PluginScan {
  readonly folders: PluginFolder[];
  /** The problems of the plugin directory itself: the path exists but cannot be read as a directory, or cannot be listed. */
  readonly problems: readonly string[];
}

function sortedNames(dir: string): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('__'))
    .map((entry) => entry.name);
  names.sort(byName);
  return names;
}

/**
 * Load one plugin directory: one cell per folder (the name, the path, the declaration, the problems of reading the
 * declaration). One bad folder does not affect its neighbours; a directory starting with a dot or with `__` does
 * not count as a plugin (build output and odds and ends).
 */
export async function loadPlugins(dir: string): Promise<PluginScan> {
  if (!existsSync(dir)) return { folders: [], problems: [] };
  let stat: Awaited<ReturnType<typeof statSync>>;
  try {
    stat = statSync(dir);
  } catch (error) {
    return { folders: [], problems: [scanSentence(dir, error)] };
  }
  if (!stat.isDirectory()) {
    return {
      folders: [],
      problems: [`${dir} is not a directory (the plugins directory holds one folder per plugin)`],
    };
  }
  let names: string[];
  try {
    names = sortedNames(dir);
  } catch (error) {
    return { folders: [], problems: [scanSentence(dir, error)] };
  }
  const folders: PluginFolder[] = [];
  for (const name of names) {
    const folder = join(dir, name);
    const declarationPath = join(folder, PLUGIN_DECLARATION_NAME);
    let decl: PluginDeclaration | null = null;
    const problems: string[] = [];
    try {
      const read = await readJsonFile(declarationPath, `${name}/${PLUGIN_DECLARATION_NAME}`);
      if (read.kind === 'missing') {
        problems.push(`plugin ${JSON.stringify(name)}: no ${PLUGIN_DECLARATION_NAME} ` +
          '(a plugin is a folder with a declaration in it)');
      } else if (read.value === null || typeof read.value !== 'object' || Array.isArray(read.value)) {
        problems.push(`plugin ${JSON.stringify(name)}: ${PLUGIN_DECLARATION_NAME} must be a JSON object ` +
          '(one declaration per plugin)');
      } else {
        decl = read.value as PluginDeclaration;
      }
    } catch (error) {
      problems.push(`plugin ${JSON.stringify(name)}: ${PLUGIN_DECLARATION_NAME} could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`);
    }
    folders.push({ name, folder, decl, problems });
  }
  return { folders, problems: [] };
}

function scanSentence(dir: string, error: unknown): string {
  return `${dir} cannot be scanned: ${error instanceof Error ? error.message : String(error)}`;
}

/** The sentence of a runtime load failure, recorded by the implementation entry's absolute path; cleared once loading succeeds. */
const runtimeProblems = new Map<string, string>();

/** The implementation modules already loaded, one per entry path. */
const implCache = new Map<string, Promise<PluginImplModule>>();

/** The implementation entry path of one plugin. */
export function implPathOf(folder: PluginFolder): string {
  return join(folder.folder, PLUGIN_IMPL_NAME);
}

/**
 * The implementation module of one plugin, or null when it cannot be loaded: the failure is written into the
 * runtime problem table (reported by doctor) and never thrown into the main flow. A module already loaded is
 * reused by path; a failed load leaves no cache behind — the next call really tries the file again.
 */
export async function implOf(folder: PluginFolder): Promise<PluginImplModule | null> {
  const path = implPathOf(folder);
  const cached = implCache.get(path);
  if (cached !== undefined) {
    try {
      return await cached;
    } catch {
      return null; // the failure was recorded in the problem table on the first load; this answers null just the same.
    }
  }
  const loading = import(pathToFileURL(path).href).then((module) => module as unknown as PluginImplModule);
  implCache.set(path, loading);
  try {
    const module = await loading;
    runtimeProblems.delete(path);
    return module;
  } catch (error) {
    implCache.delete(path);
    runtimeProblems.set(
      path,
      `plugin ${JSON.stringify(folder.name)}: ${PLUGIN_IMPL_NAME} failed to load: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** The sentence for a failed load of this folder's implementation entry; undefined once loading succeeds. */
export function runtimeProblemOf(folder: PluginFolder): string | undefined {
  return runtimeProblems.get(implPathOf(folder));
}

/** The load failures recorded so far, keyed by implementation entry path: what doctor reads, narrowed to its own batch. */
export function runtimeProblemsSeen(): ReadonlyMap<string, string> {
  return runtimeProblems;
}
