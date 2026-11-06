import type { KnobSpec } from '../config';
import { declaredKnobSpecs } from './tables';
import { usable } from './declare';
import { loadPlugins, pluginsDirOf, type PluginScan } from './scan';
import type { PluginCommandEntry, PluginFolder, PluginReadingEntry } from './types';
import { routableCommands } from '../words/plugin-commands';
import { readingsOf } from './tables';

/**
 * One assembly of the plugin directory, for one use: the folder scan and every table read off it are worked
 * out once and handed to every point of that use, so a step that asks for the declarations and then for the
 * folders does not read the directory twice — and the doors of one round do not validate the same folder again
 * for every plugin at every timing.
 *
 * The memo lives exactly as long as the assembly does, and every use makes its own. The folder on disk is the
 * only answer: a plugin installed or removed, a knob added, a command word changed, all have to be visible on
 * the next use, which is the freshness the check-up states out loud. Sharing one assembly among the points of
 * a single call is the whole of the sharing here; keeping one on a handle across calls would make the folder
 * on disk stop being the answer, so nothing does that.
 */
export interface PluginAssembly {
  /** The loaded plugin folders, in folder order. */
  folders(): Promise<PluginFolder[]>;
  /** The problems of the plugin directory itself (an absent directory is a normal state, not a problem). */
  scanProblems(): Promise<readonly string[]>;
  /** The knobs the installed plugins declare, merged into one settings table. */
  knobs(): Promise<Record<string, KnobSpec>>;
  /** The merged reading table of this round (a declared reading whose source nobody serves is taken off). */
  readings(): Promise<PluginReadingEntry[]>;
  /** The routing table of this round: the words the plugins claim that no core word keeps. */
  routable(): Promise<PluginCommandEntry[]>;
  /** The plugins that may act this round: the usable set, worked out once (one disk ask per folder, not per door). */
  available(): Promise<PluginFolder[]>;
}

/** Assemble the plugin directory of one project (or of one named plugin directory) for one use. */
export function pluginAssemblyOf(root: string, pluginsDir?: string): PluginAssembly {
  let scan: Promise<PluginScan> | null = null;
  const scanned = (): Promise<PluginScan> => {
    if (scan === null) scan = loadPlugins(pluginsDirOf(root, pluginsDir));
    return scan;
  };
  const memo = <T>(read: (folders: PluginFolder[]) => T): (() => Promise<T>) => {
    let held: Promise<T> | null = null;
    return () => {
      if (held === null) held = scanned().then((loaded) => read(loaded.folders));
      return held;
    };
  };
  return {
    async folders() {
      return (await scanned()).folders;
    },
    async scanProblems() {
      return (await scanned()).problems;
    },
    knobs: memo((folders) => declaredKnobSpecs(folders)),
    readings: memo((folders) => readingsOf(folders)),
    routable: memo((folders) => routableCommands(folders)),
    available: memo((folders) => folders.filter((folder) => usable(folder))),
  };
}
