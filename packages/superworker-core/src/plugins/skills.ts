import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { byName } from './cells';
import { methodsOf } from './tables';
import type { PluginFolder, PluginSkillFolder } from './types';

/**
 * A plugin's own skills: text that goes into the plugin folder, installed and removed with the plugin,
 * changing no core. Two ways a skill and a declaration disagree are this module's: a method a metric
 * names with no skill of its own, and one skill name shipped by two plugins.
 */

/** The directory convention of a plugin's own skills: `<plugin>/skills/<lang>/<method>/SKILL.md`, installed and removed with the plugin. */
export const PLUGIN_SKILLS_DIR = 'skills';
export const PLUGIN_SKILL_FILE = 'SKILL.md';

/** A skill folder a plugin ships: `skills/<lang>/<method>/`, ordered by name; a directory starting with a dot or with `__` does not count. */
export function skillFolders(folder: PluginFolder): PluginSkillFolder[] {
  const root = join(folder.folder, PLUGIN_SKILLS_DIR);
  const out: PluginSkillFolder[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return out;
  const langs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__'))
    .map((e) => e.name)
    .sort(byName);
  for (const lang of langs) {
    const langDir = join(root, lang);
    const methods = readdirSync(langDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__'))
      .map((e) => e.name)
      .sort(byName);
    for (const method of methods) {
      out.push({ lang, method, folder: join(langDir, method) });
    }
  }
  return out;
}

/** The two ways skills and declarations disagree: a method a metric names has no skill in its own folder; or one skill name is shipped by two plugins. */
export function skillProblems(folders: readonly PluginFolder[]): string[] {
  const out: string[] = [];
  const owner = new Map<string, { plugin: string; lang: string }>();
  for (const folder of folders) {
    const backed = new Set<string>();
    for (const skill of skillFolders(folder)) {
      if (existsSync(join(skill.folder, PLUGIN_SKILL_FILE))) backed.add(skill.method);
      const first = owner.get(skill.method);
      if (first === undefined) owner.set(skill.method, { plugin: folder.name, lang: skill.lang });
      else if (first.plugin !== folder.name) {
        out.push(`skill ${JSON.stringify(skill.method)}: ${JSON.stringify(first.plugin)} ships it under ` +
          `${PLUGIN_SKILLS_DIR}/${first.lang} and ${JSON.stringify(folder.name)} under ` +
          `${PLUGIN_SKILLS_DIR}/${skill.lang} -- a skill belongs to one plugin`);
      }
    }
    for (const method of methodsOf(folder)) {
      if (!backed.has(method)) {
        out.push(`plugin ${JSON.stringify(folder.name)}: method ${JSON.stringify(method)} has no skill of its ` +
          `own (no ${PLUGIN_SKILLS_DIR}/<lang>/${method}/${PLUGIN_SKILL_FILE} in its folder)`);
      }
    }
  }
  return out;
}
