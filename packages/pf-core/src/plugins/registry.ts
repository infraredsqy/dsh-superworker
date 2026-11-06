import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUILTIN_KNOBS,
  CHAIN_LAYERS,
  parseConfigValue,
  type ConfigKind,
  type ConfigLayerName,
  type ConfigValue,
  type KnobSpec,
} from '../config';
import { readJsonFile } from '../jsonio';
import { envPluginsDir } from '../env';
import { standInContext } from './standin';
import type {
  PluginAction,
  PluginCommandEntry,
  PluginContext,
  PluginDeclaration,
  PluginFolder,
  PluginImplModule,
  PluginReadingEntry,
  PluginSkillFolder,
  PluginTiming,
} from './types';
import {
  COMMAND_CELL_KEYS,
  CORE_READING_SOURCES,
  DECLARATION_KEYS,
  KNOB_CELL_KEYS,
  METRIC_CELL_KEYS,
  READING_CELL_KEYS,
  SOURCE_CELL_KEYS,
  TIMING_ACTION_CELLS,
} from './types';

/**
 * The plugin registry: loading the directory, the closed-set validation of declarations, the merging of names
 * across plugins, and loading implementation entries. The reading of the registry and of the host, with two
 * rules of its own:
 *
 * - the spellings of the declaration file and of the implementation entry are fixed on the TS side as
 *   `plugin.json` and `impl.mjs` (.mjs guarantees ESM regardless of whether the host project has a
 *   package.json); the implementation is loaded into this process by dynamic import, one module object per file
 *   (register + reuse), and a load failure is recorded in the runtime problem table for doctor to report,
 *   never thrown into the main flow.
 * - the refusal of unknown keys is spelled out in the spec, and the reading errs strict: the top level of a
 *   declaration and every cell's keys go through their own closed set, and a key outside the set is one
 *   declaration problem.
 *
 * **Tolerant at runtime, strict in doctor.** Declaration problems and load failures all come back as sentences
 * and nobody throws along the way: the pipeline must not be cut in half by a broken plugin mid-way. The scan is
 * not cached — the folder on disk is the only answer, so a plugin installed or removed is visible on the next
 * call; with nothing in the plugin directory every gate answers an empty table.
 */

/** The file names of the implementation entry: a declaration and an implementation entry are the two things that must be in a plugin folder. */
export const PLUGIN_DECLARATION_NAME = 'plugin.json';
export const PLUGIN_IMPL_NAME = 'impl.mjs';

/** The directory convention of a plugin's own skills: `<plugin>/skills/<lang>/<method>/SKILL.md`, installed and removed with the plugin. */
export const PLUGIN_SKILLS_DIR = 'skills';
export const PLUGIN_SKILL_FILE = 'SKILL.md';

/**
 * The location of the plugin directory: the option the call hands in, then `PF_PLUGINS_DIR`, then
 * `<root>/plugins` — one folder per plugin. The option wins over the switch, so a caller that names
 * a folder reads that folder whatever the environment says.
 */
export function pluginsDirOf(root: string, pluginsDir?: string): string {
  return pluginsDir ?? envPluginsDir() ?? join(root, 'plugins');
}

// ── words the core already occupies: the core wins when a plugin command collides ──

/**
 * The words the core answers itself: every verb name and namespace name on the pf handle. A declared command
 * colliding with any of them means the core keeps that word and the plugin's command does not enter the routing
 * table, with doctor adding one line of explanation — static precedence is applied once, at the routing door, and
 * both readers (routing and doctor) look at the same table.
 */
export const CORE_COMMAND_WORDS: ReadonlySet<string> = new Set([
  'ledger', 'conductor', 'config', 'sessions', 'dag', 'cycles', 'instructions',
  'init', 'register',
  'add', 'remove', 'update', 'link', 'unlink', 'setStatus', 'approve', 'revive',
  'get', 'context', 'search', 'list', 'specPath', 'validate',
  'create', 'start', 'rename', 'setPolicy', 'current', 'show', 'hold', 'close', 'retry',
  'resolve',
  'set', 'unset',
  'next', 'dispatch', 'handoff', 'doctor',
]);

// ── loading the directory ───────────────────────────────────────────────────

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
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

// ── small pieces for reading declaration cells ──────────────────────────────

function declOf(folder: PluginFolder): PluginDeclaration | null {
  return folder.decl;
}

/** One name group of a declaration, tidied into a mapping (an absent or malformed one counts as an empty table). */
function group(decl: PluginDeclaration, key: string): Record<string, unknown> {
  const value = (decl as Record<string, unknown>)[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cellOf(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** Whether a declared value counts as one word: non-empty, no whitespace, not opening with a dash (a leading dash is how an option is spelled, and neither table talks about options). */
export function isOneWord(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value) && !value.startsWith('-');
}

/** The usable source claims of one declaration: the name is one word, it is not one the core already occupies, and `by` is one word. */
function sourceCells(decl: PluginDeclaration): Record<string, { by: string }> {
  const out: Record<string, { by: string }> = {};
  for (const [key, raw] of Object.entries(group(decl, 'sources'))) {
    const cell = cellOf(raw);
    if (cell === null) continue;
    if (!isOneWord(key) || (CORE_READING_SOURCES as readonly string[]).includes(key)) continue;
    const by = cell.by;
    if (!isOneWord(by)) continue;
    out[key] = { by };
  }
  return out;
}

/** The sources a reading of one declaration may use: the core's own, plus the ones it claims itself. */
function servedSources(decl: PluginDeclaration): string[] {
  return [...CORE_READING_SOURCES, ...Object.keys(sourceCells(decl))];
}

/** Whether one knob cell's kind is among the four the core knows. */
function isKnownKind(kind: unknown): kind is ConfigKind {
  return kind === 'number' || kind === 'integer' || kind === 'word' || kind === 'switch';
}

/** The membership check of the closed timing set (absent does not count as a member; whether an absent one is named is up to the caller). */
function isKnownTiming(timing: unknown): timing is PluginTiming {
  return typeof timing === 'string' && PLUGIN_TIMINGS.includes(timing as PluginTiming);
}

/** The membership check of the closed action set (the same as above). */
function isKnownAction(action: unknown): action is PluginAction {
  return typeof action === 'string' && PLUGIN_ACTIONS.includes(action as PluginAction);
}

/** A declaration's layers cell folded by chain order; a non-empty table naming something outside the chain does not fold, and null comes back (the cell falls back to the whole chain). */
function layerCell(value: unknown): ConfigLayerName[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    return null;
  }
  if (value.some((v) => !(CHAIN_LAYERS as readonly string[]).includes(v as string))) return null;
  return CHAIN_LAYERS.filter((layer) => (value as string[]).includes(layer));
}

/** The entries of a declared files list that point inside its own folder (an absolute path, one with a root or a drive letter, and one with `..` do not count). */
function usableFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    if (/^[a-zA-Z]:/.test(entry) || entry.startsWith('/') || entry.startsWith('\\')) continue;
    if (entry.split(/[\\/]/).includes('..')) continue;
    out.push(entry);
  }
  return out;
}

/** The sentences for a cell that left its closed key set: name the unknown keys and report the keys this cell knows. */
function unknownKeyProblems(
  label: string,
  cell: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const offenders = Object.keys(cell).filter((key) => !keys.includes(key));
  if (offenders.length === 0) return [];
  return [`${label}: unknown key(s) ${offenders.map((k) => JSON.stringify(k)).join(', ')} ` +
    `(known: ${keys.join(', ')})`];
}

const PLUGIN_TIMINGS: readonly PluginTiming[] = ['close', 'dispatch'];
const PLUGIN_ACTIONS: readonly PluginAction[] = ['insert', 'block'];

// ── the problems of one declaration itself (only the declaration is asked, no disk is touched) ──

/**
 * The problems of one declaration itself: the shape of each cell and the references between cells. Whether the
 * implementation entry is there is not asked here — words belong to the declaration, so a folder with no code
 * still lists and still routes the words it claims; a missing file belongs to `folderProblems` (both doctor and
 * runtime usability look there).
 */
export function declarationProblems(folder: PluginFolder): string[] {
  const name = folder.name;
  const out = [...folder.problems];
  const decl = declOf(folder);
  if (decl === null) return out;
  const record = decl as Record<string, unknown>;

  // Unknown keys are refused: the top level of a declaration and every cell's keys go through their own closed set (what the spec spells out).
  for (const key of Object.keys(record)) {
    if (!DECLARATION_KEYS.includes(key)) {
      out.push(`plugin ${JSON.stringify(name)}: unknown key ${JSON.stringify(key)} in ${PLUGIN_DECLARATION_NAME} ` +
        `(known: ${DECLARATION_KEYS.join(', ')})`);
    }
  }

  const declaredName = record.name;
  if (declaredName !== undefined && declaredName !== name) {
    out.push(`plugin ${JSON.stringify(name)} declares the name ${JSON.stringify(declaredName)}: ` +
      'the folder is its identity, so the two have to agree');
  }

  // Timing and action make one cell: state them as a pair, or state neither (the only ones stating neither are plugins with only commands — they occupy no cell).
  const timing = record.timing;
  const action = record.action;
  const hasCommands = Object.keys(group(decl, 'commands')).length > 0;
  const spared = hasCommands;
  if (spared && (timing === undefined) !== (action === undefined)) {
    out.push(`plugin ${JSON.stringify(name)}: timing and action travel together -- ` +
      `${JSON.stringify(timing ?? null)} and ${JSON.stringify(action ?? null)} state only one of the two ` +
      '(state both, or neither)');
  }
  // An absent half is named as it is (null): a declaration with commands may leave both halves out, and every other declaration has to mention each half.
  if (!isKnownTiming(timing) && !(spared && timing === undefined)) {
    out.push(`plugin ${JSON.stringify(name)}: timing ${JSON.stringify(timing ?? null)} is not one of ` +
      `[${PLUGIN_TIMINGS.join(', ')}]`);
  }
  if (!isKnownAction(action) && !(spared && action === undefined)) {
    out.push(`plugin ${JSON.stringify(name)}: action ${JSON.stringify(action ?? null)} is not one of ` +
      `[${PLUGIN_ACTIONS.join(', ')}]`);
  }
  if (
    typeof timing === 'string' && typeof action === 'string' &&
    PLUGIN_TIMINGS.includes(timing as PluginTiming) && PLUGIN_ACTIONS.includes(action as PluginAction) &&
    !TIMING_ACTION_CELLS.some(([t, a]) => t === timing && a === action)
  ) {
    const served = TIMING_ACTION_CELLS.map(([t, a]) => `${a} at ${t}`).join(', ');
    out.push(`plugin ${JSON.stringify(name)}: ${JSON.stringify(action)} at ${JSON.stringify(timing)} ` +
      `is not a cell this core serves (${served})`);
  }

  // files: only the shape is the declaration's business; whether they are on disk belongs to folderProblems.
  const files = record.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      out.push(`plugin ${JSON.stringify(name)}: files must be a list of paths relative to its own folder, ` +
        `got ${typeof files}`);
    } else {
      for (const entry of files) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          out.push(`plugin ${JSON.stringify(name)}: files holds ${JSON.stringify(entry ?? null)}, which is not a path`);
        } else if (!usableFiles([entry]).includes(entry)) {
          out.push(`plugin ${JSON.stringify(name)}: files holds ${JSON.stringify(entry)}, which is not inside ` +
            'its own folder');
        }
      }
    }
  }

  const knobs = group(decl, 'knobs');
  const readings = group(decl, 'readings');
  const metrics = group(decl, 'metrics');
  const commands = group(decl, 'commands');
  const sources = group(decl, 'sources');
  const served = servedSources(decl);

  for (const [key, raw] of Object.entries(knobs)) {
    const cell = cellOf(raw);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)} must be an object ` +
        `(${KNOB_CELL_KEYS.join(', ')})`);
      continue;
    }
    out.push(...unknownKeyProblems(
      `plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)}`,
      cell,
      KNOB_CELL_KEYS,
    ));
    const kind = cell.kind;
    // The default is required: a knob cell states one, and `null` is its spelling for "no factory value".
    // Whether the key is there cannot be read off the value the way other cells are read, so it is asked
    // here once; a cell that leaves it out is a declaration problem like a bad `kind`, and the plugin it
    // belongs to takes no part at all (see `folderProblems` / `usable`).
    if (cell.default === undefined) {
      out.push(`plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)} states no default: every knob ` +
        'cell carries one -- write the factory value, or null for "no factory value at all"; until the ' +
        'cell states one the whole plugin takes no part (its close-time work is skipped)');
    }
    if (!isKnownKind(kind)) {
      out.push(`plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)} has kind ` +
        `${JSON.stringify(kind ?? null)}, which is not one of [number, integer, word, switch]`);
    } else if (cell.default !== undefined && !defaultFits(kind, cell.default, wordsCell(cell.values))) {
      // The cell cannot be honoured. It is a declaration problem like a bad `kind` / `values` cell, so it
      // is not only the knob that falls away: `folderProblems` carries it into `usable`, and a plugin that
      // is not usable takes no part at all — no door is asked, none of its commands routes, and its
      // close-time work is skipped. This line is the one place the plugin is told which knob and which
      // default it is, so it states the whole consequence.
      out.push(`plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)} has a default that is not a ` +
        `${kind}: ${JSON.stringify(cell.default)} -- the knob stays out of the settings list and the whole ` +
        'plugin takes no part (its close-time work is skipped) until the cell is fixed, so state a default ' +
        'of its own kind, or null for "no factory value at all"');
    }
    if (kind === 'word' && cell.values !== undefined && cell.values !== null) {
      const values = cell.values;
      const words = Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string');
      if (!words) {
        out.push(`plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)} takes \`values\` as a ` +
          'non-empty list of words');
      }
    }
    const layers = cell.layers;
    if (layers !== undefined && layers !== null && layerCell(layers) === null) {
      out.push(`plugin ${JSON.stringify(name)}: knob ${JSON.stringify(key)} takes \`layers\` as a non-empty ` +
        `list of layer names (${CHAIN_LAYERS.join(', ')})`);
    }
  }

  for (const [key, raw] of Object.entries(readings)) {
    const cell = cellOf(raw);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: reading ${JSON.stringify(key)} must be an object ` +
        `(${READING_CELL_KEYS.join(', ')})`);
      continue;
    }
    out.push(...unknownKeyProblems(
      `plugin ${JSON.stringify(name)}: reading ${JSON.stringify(key)}`,
      cell,
      READING_CELL_KEYS,
    ));
    const source = cell.source;
    if (typeof source !== 'string' || !served.includes(source)) {
      out.push(`plugin ${JSON.stringify(name)}: reading ${JSON.stringify(key)} has source ` +
        `${JSON.stringify(source ?? null)}, which is neither one of the core's ` +
        `([${CORE_READING_SOURCES.join(', ')}]) nor a source this plugin claims ` +
        `(its sources: [${Object.keys(sourceCells(decl)).join(', ')}])`);
    }
    const when = cell.when_knob;
    if (typeof when === 'string' && when !== '' && !(when in knobs)) {
      out.push(`plugin ${JSON.stringify(name)}: reading ${JSON.stringify(key)} is narrowed by ` +
        `${JSON.stringify(when)}, which the plugin does not declare as a knob`);
    }
  }

  for (const [key, raw] of Object.entries(metrics)) {
    const cell = cellOf(raw);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: metric ${JSON.stringify(key)} must be an object ` +
        `(${METRIC_CELL_KEYS.join(', ')})`);
      continue;
    }
    out.push(...unknownKeyProblems(
      `plugin ${JSON.stringify(name)}: metric ${JSON.stringify(key)}`,
      cell,
      METRIC_CELL_KEYS,
    ));
    if (!(key in readings)) {
      out.push(`plugin ${JSON.stringify(name)}: metric ${JSON.stringify(key)} names a reading the plugin ` +
        'does not declare');
    }
    const line = cell.line;
    if (!(typeof line === 'string' && line in knobs)) {
      out.push(`plugin ${JSON.stringify(name)}: metric ${JSON.stringify(key)} is judged against ` +
        `${JSON.stringify(line ?? null)}, which the plugin does not declare as a knob`);
    }
    for (const field of ['tag', 'method'] as const) {
      const value = cell[field];
      if (typeof value !== 'string' || value.trim() === '') {
        out.push(`plugin ${JSON.stringify(name)}: metric ${JSON.stringify(key)} needs a ${field} ` +
          '(the string the outside writes down to name this debt)');
      }
    }
  }

  for (const [key, raw] of Object.entries(sources)) {
    const cell = cellOf(raw);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: source ${JSON.stringify(key)} must be an object ` +
        `(${SOURCE_CELL_KEYS.join(', ')})`);
      continue;
    }
    out.push(...unknownKeyProblems(
      `plugin ${JSON.stringify(name)}: source ${JSON.stringify(key)}`,
      cell,
      SOURCE_CELL_KEYS,
    ));
    if (!isOneWord(key)) {
      out.push(`plugin ${JSON.stringify(name)}: source ${JSON.stringify(key)} is not a name (one word, ` +
        'no blanks, not opening with a dash)');
    }
    if ((CORE_READING_SOURCES as readonly string[]).includes(key)) {
      out.push(`plugin ${JSON.stringify(name)}: source ${JSON.stringify(key)} is one of the core's own ` +
        `([${CORE_READING_SOURCES.join(', ')}]) and cannot be claimed: a second home for that meaning ` +
        'is what this cell exists to avoid');
    }
    const by = cell.by;
    if (!isOneWord(by)) {
      out.push(`plugin ${JSON.stringify(name)}: source ${JSON.stringify(key)} needs a by (the implementation ` +
        `function that computes the number, named in ${PLUGIN_IMPL_NAME})`);
    }
  }

  for (const [key, raw] of Object.entries(commands)) {
    const cell = cellOf(raw);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: command ${JSON.stringify(key)} must be an object ` +
        `(${COMMAND_CELL_KEYS.join(', ')})`);
      continue;
    }
    out.push(...unknownKeyProblems(
      `plugin ${JSON.stringify(name)}: command ${JSON.stringify(key)}`,
      cell,
      COMMAND_CELL_KEYS,
    ));
    if (!isOneWord(key)) {
      out.push(`plugin ${JSON.stringify(name)}: command ${JSON.stringify(key)} is not a word the core could ` +
        'be given (one word, no blanks, not opening with a dash)');
    }
    const summary = cell.summary;
    if (typeof summary !== 'string' || summary.trim() === '') {
      out.push(`plugin ${JSON.stringify(name)}: command ${JSON.stringify(key)} needs a summary (the one line ` +
        'printed beside the word)');
    }
    const keep = cell.keep_name;
    if (keep !== undefined && keep !== null && typeof keep !== 'boolean') {
      out.push(`plugin ${JSON.stringify(name)}: command ${JSON.stringify(key)} takes keep_name as true or ` +
        'false (whether the word goes along in the argv)');
    }
  }

  const enable = record.enable_knob;
  if (enable !== undefined && enable !== null && enable !== '') {
    const cell = cellOf(knobs[enable as string]);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: switches on ${JSON.stringify(enable)}, which the plugin ` +
        'does not declare as a knob');
    } else if (cell.kind !== 'switch') {
      out.push(`plugin ${JSON.stringify(name)}: switches on ${JSON.stringify(enable)}, whose kind is ` +
        `${JSON.stringify(cell.kind ?? null)}; only a switch names on/off`);
    }
  }

  return out;
}

/** The complete problems of one folder: the declaration's problems, plus whether the implementation entry and the files the declaration lists are there (this one asks the disk). */
export function folderProblems(folder: PluginFolder): string[] {
  const out = declarationProblems(folder);
  if (declOf(folder) === null) return out;
  const implPath = join(folder.folder, PLUGIN_IMPL_NAME);
  if (!existsSync(implPath) || !statSync(implPath).isFile()) {
    out.push(`plugin ${JSON.stringify(folder.name)}: no ${PLUGIN_IMPL_NAME} in ${folder.folder}`);
  }
  for (const entry of usableFiles((declOf(folder) as PluginDeclaration).files)) {
    const path = join(folder.folder, ...entry.split(/[\\/]/));
    if (!existsSync(path) || !statSync(path).isFile()) {
      out.push(`plugin ${JSON.stringify(folder.name)}: ${entry} is not in its folder, and its declaration ` +
        `lists it under "files"`);
    }
  }
  return out;
}

/** Whether this plugin may act: the declaration reads and it has no problems of its own. A broken one is skipped at runtime and reported by doctor. */
export function usable(folder: PluginFolder): boolean {
  return declOf(folder) !== null && folderProblems(folder).length === 0;
}

// ── names across plugins: two plugins may not share one ─────────────────────

function claimedNames(
  folders: readonly PluginFolder[],
  groupKey: string,
  field?: string,
): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const folder of folders) {
    const decl = declOf(folder);
    if (decl === null) continue;
    for (const [key, raw] of Object.entries(group(decl, groupKey))) {
      const cell = cellOf(raw);
      const value = field === undefined ? key : cell === null ? undefined : cell[field];
      if (typeof value === 'string' && value.trim() !== '') out.push([value, folder.name] as const);
    }
  }
  return out;
}

function firstClaims(label: string, values: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const [value, owner] of values) {
    const first = seen.get(value);
    if (first !== undefined && first !== owner) {
      out.push(`${label} ${JSON.stringify(value)} is claimed by both ${JSON.stringify(first)} and ` +
        `${JSON.stringify(owner)}: two plugins may not share it`);
    } else if (first === undefined) {
      seen.set(value, owner);
    }
  }
  return out;
}

/** Name conflicts: plugin names (the folder scan already guarantees uniqueness), knobs, readings, sources, dedupe tags, commands. */
export function conflicts(folders: readonly PluginFolder[]): string[] {
  return [
    ...firstClaims('plugin name', folders.map((f) => [f.name, f.name] as const)),
    ...firstClaims('knob', claimedNames(folders, 'knobs')),
    ...firstClaims('reading', claimedNames(folders, 'readings')),
    ...firstClaims('source', claimedNames(folders, 'sources')),
    ...firstClaims('dedupe tag', claimedNames(folders, 'metrics', 'tag')),
    ...firstClaims('command', claimedNames(folders, 'commands')),
  ];
}

// ── merged tables: what the declarations say, read the same way by every reader ──

/** The command words one plugin declares, with both shape and description in place, in declaration order. */
export function commandsOf(folder: PluginFolder): string[] {
  const decl = declOf(folder);
  if (decl === null) return [];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(group(decl, 'commands'))) {
    const cell = cellOf(raw);
    if (cell === null) continue;
    const summary = cell.summary;
    if (isOneWord(key) && typeof summary === 'string' && summary.trim() !== '' && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

/** The skill method names the metrics of a declaration name, in declaration order. */
export function methodsOf(folder: PluginFolder): string[] {
  const decl = declOf(folder);
  if (decl === null) return [];
  const out: string[] = [];
  for (const raw of Object.values(group(decl, 'metrics'))) {
    const method = cellOf(raw)?.method;
    if (typeof method === 'string' && method.trim() !== '' && !out.includes(method)) out.push(method);
  }
  return out;
}

/** The dedupe tags of one plugin, in declaration order (deduped). */
export function tagsOf(folder: PluginFolder): string[] {
  const decl = declOf(folder);
  if (decl === null) return [];
  const out: string[] = [];
  for (const raw of Object.values(group(decl, 'metrics'))) {
    const tag = cellOf(raw)?.tag;
    if (typeof tag === 'string' && tag.trim() !== '' && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * The commands every plugin declares with a sound declaration surface, in folder order (the first to claim one
 * keeps it). Words belong to the declaration: whether code exists does not shake this cell (listing is never
 * executing).
 */
export function commandTable(folders: readonly PluginFolder[]): PluginCommandEntry[] {
  const out: PluginCommandEntry[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const decl = declOf(folder);
    if (decl === null || declarationProblems(folder).length > 0) continue;
    const commands = group(decl, 'commands');
    for (const key of commandsOf(folder)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = commands[key] as Record<string, unknown>;
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

/** The words of a knob's `values` cell, when it is a non-empty list of words (the shape `declarationProblems` reports on). */
function wordsCell(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
}

/**
 * Whether a declared default can be honoured: `null` keeps the plugin door's "no factory value at
 * all"; a cell that states nothing does not fit (a knob cell always carries one, and the absence is
 * its own declaration problem); any other default has to pass the same kind gate a value on the
 * chain passes. A default that cannot be honoured is a broken cell — it does not enter the spec
 * list, and doctor says which plugin and which knob (see `declarationProblems`).
 */
function defaultFits(kind: ConfigKind, stated: unknown, values: readonly string[] | undefined): boolean {
  if (stated === null) return true;
  if (stated === undefined) return false;
  return parseConfigValue(kind, stated, values) !== null;
}

/**
 * One declared knob cell folded into a settings cell, or null when it cannot be honoured: the kind is
 * outside the four, or the stated default is not of its own kind. The one gate both the merged table and
 * the listing go through, so the two never disagree about which cells are really knobs.
 */
function knobSpecOf(raw: unknown): KnobSpec | null {
  const cell = cellOf(raw);
  if (cell === null) return null;
  const kind = cell.kind;
  if (!isKnownKind(kind)) return null;
  const values = wordsCell(cell.values);
  // A default that is not of its own kind cannot be honoured: the cell stays out of the list, so no
  // settings verb and no dispatch ever runs into it (doctor reports it in `declarationProblems`).
  if (!defaultFits(kind, cell.default, values)) return null;
  const spec: KnobSpec & { values?: readonly string[]; layers?: readonly ConfigLayerName[] } = {
    kind,
    // Every cell states its default (an absent one is a declaration problem, so such a cell never
    // gets here); `null` is the plugin door's "no factory value at all": the setting is only in
    // force once some layer states it (see the defaults rule of `src/config.ts`).
    default: cell.default as ConfigValue | null,
    summary: typeof cell.summary === 'string' ? cell.summary : '',
  };
  if (values !== undefined) spec.values = values;
  const layers = layerCell(cell.layers);
  if (layers !== null) spec.layers = layers;
  return spec;
}

/**
 * The declared knobs, merged into one table in folder order: on a name collision the first one is kept,
 * and a broken cell does not enter. A broken cell is a declaration problem, so the plugin it belongs to
 * is not usable and takes no part at all; doctor says which cell and why.
 */
export function declaredKnobSpecs(folders: readonly PluginFolder[]): Record<string, KnobSpec> {
  const out: Record<string, KnobSpec> = {};
  for (const folder of folders) {
    const decl = declOf(folder);
    if (decl === null) continue;
    for (const [key, raw] of Object.entries(group(decl, 'knobs'))) {
      if (Object.hasOwn(out, key)) continue;
      const spec = knobSpecOf(raw);
      if (spec === null) continue;
      out[key] = spec;
    }
  }
  return out;
}

function knobOwnerOf(folders: readonly PluginFolder[], knob: string): string {
  for (const folder of folders) {
    if (Object.hasOwn(group(declOf(folder) ?? ({} as PluginDeclaration), 'knobs'), knob)) {
      return folder.name;
    }
  }
  return '?';
}

/** A declared knob colliding with a built-in setting name: the built-in cell stays in place and the declared one can never be read — doctor says this out loud. */
export function shadowedKnobs(folders: readonly PluginFolder[]): string[] {
  const out: string[] = [];
  for (const name of Object.keys(declaredKnobSpecs(folders))) {
    if (Object.hasOwn(BUILTIN_KNOBS, name)) {
      const owner = knobOwnerOf(folders, name);
      out.push(`plugin ${JSON.stringify(owner)} declares the knob ${JSON.stringify(name)}, which is already ` +
        'a built-in setting: the built-in cell stays in force, so the declared one can never be read -- ' +
        'give it a name of its own');
    }
  }
  return out;
}

// ── the listing: what a declaration says about itself, printed one item per line ──

/**
 * The reading sources one declaration claims, as the name plus the implementation function that computes
 * it, in declaration order. The usable claims only (the same table `readingsOf` draws on): the doctor names
 * the rest, and a claim it names is not a source here either.
 */
export function sourcesOf(folder: PluginFolder): Array<{ name: string; by: string }> {
  const decl = declOf(folder);
  if (decl === null) return [];
  return Object.entries(sourceCells(decl)).map(([name, cell]) => ({ name, by: cell.by }));
}

/** One declared knob as the listing writes it: the name, the kind with its vocabulary and factory default, and the cell's own one-line summary. */
function knobLine(name: string, spec: KnobSpec): string {
  const details: string[] = [];
  if (spec.values !== undefined && spec.values.length > 0) details.push(`one of ${spec.values.join(' / ')}`);
  const stated = spec.default;
  if (stated !== null && stated !== undefined && stated !== '' && typeof stated !== 'function') {
    details.push(`default ${String(stated)}`);
  }
  const cell = `${spec.kind}${details.length > 0 ? `: ${details.join(', ')}` : ''}`;
  return `${name} (${cell})${spec.summary === '' ? '' : ` — ${spec.summary}`}`;
}

/**
 * The listing of the installed plugins, one block per folder in folder order: the folder's name and its
 * own summary, then the knobs it declares, its dedupe tags, its method names, the reading sources it
 * computes and the command words it claims. Everything here is data the declaration owns, which is why a
 * listing answers "how does this plugin work" without running any of it.
 *
 * The two readers walk one table: a knob whose cell cannot be honoured never enters the merged settings
 * list, so it is not printed here either, and a name an earlier folder already holds is not printed twice
 * (the first folder keeps it, exactly as the merged table and the routing table do).
 */
export function pluginListing(folders: readonly PluginFolder[]): string[] {
  const out: string[] = [];
  const held = new Set<string>();
  for (const folder of folders) {
    const decl = declOf(folder);
    const summary = typeof decl?.summary === 'string' ? decl.summary.trim() : '';
    out.push(`  · ${folder.name}${summary === '' ? '' : ` — ${summary}`}`);
    if (decl !== null) {
      let lead = '      knobs: ';
      for (const [key, raw] of Object.entries(group(decl, 'knobs'))) {
        if (held.has(key)) continue;
        const spec = knobSpecOf(raw);
        if (spec === null) continue;
        held.add(key);
        out.push(lead + knobLine(key, spec));
        lead = '             ';
      }
    }
    const tags = tagsOf(folder);
    if (tags.length > 0) out.push(`      tags: ${tags.join(', ')}`);
    const methods = methodsOf(folder);
    if (methods.length > 0) out.push(`      methods: ${methods.join(', ')}`);
    const sources = sourcesOf(folder);
    if (sources.length > 0) {
      out.push(`      sources: ${sources.map((cell) => `${cell.name} (computed by ${cell.by}())`).join(', ')}`);
    }
    const commands = commandsOf(folder);
    if (commands.length > 0) out.push(`      commands: ${commands.join(', ')}`);
  }
  return out;
}

/** The merged reading table: declaration order, folder order; a reading whose source is neither the core's nor one it claims is taken off (doctor reports it). */
export function readingsOf(folders: readonly PluginFolder[]): PluginReadingEntry[] {
  const out: PluginReadingEntry[] = [];
  for (const folder of folders) {
    const decl = declOf(folder);
    if (decl === null) continue;
    const claims = sourceCells(decl);
    const served = servedSources(decl);
    for (const [key, raw] of Object.entries(group(decl, 'readings'))) {
      const cell = cellOf(raw);
      if (cell === null) continue;
      const source = cell.source;
      if (typeof source !== 'string' || !served.includes(source)) continue;
      out.push({
        plugin: folder.name,
        key,
        source,
        by: claims[source]?.by ?? '',
        ask: typeof cell.ask === 'string' ? cell.ask : '',
        whenKnob: typeof cell.when_knob === 'string' ? cell.when_knob : '',
      });
    }
  }
  return out;
}

// ── skills: text goes into the plugin folder, changing it changes no core; installed and removed with the plugin ──

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

// ── loading implementation entries: one module object per file; a failure becomes a sentence, never a throw ──

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

// ── doctor's strict face: declarations, implementations, skills, sources, and a real question put to a stand-in ──

/**
 * Every bad spot of the plugins: the shape and the references of each declaration, name conflicts, a missing
 * implementation entry and load failures, the two ways skills disagree, a claimed source with no computing
 * function, and one real question put to every implementation against a stand-in project. It hands back a list of
 * sentences and throws nowhere along the way — a broken plugin comes back as a few lines of explanation.
 */
export async function verifyPlugins(folders: readonly PluginFolder[]): Promise<string[]> {
  const problems: string[] = [];
  for (const folder of folders) problems.push(...folderProblems(folder));
  problems.push(...conflicts(folders));
  // Loading comes first: the runtime problem table has to be filled before the checks below can read it.
  for (const folder of folders) {
    if (existsSync(implPathOf(folder))) await implOf(folder);
  }
  // The runtime problem table is keyed by implementation entry path, so only this batch's own folders are reported (a broken plugin of another project does not mix in).
  const ownPaths = new Set(folders.map((f) => implPathOf(f)));
  for (const [path, sentence] of runtimeProblems) {
    if (ownPaths.has(path)) problems.push(sentence);
  }
  problems.push(...skillProblems(folders));
  for (const folder of folders) {
    const decl = declOf(folder);
    if (decl === null) continue;
    // The computing function of a claimed source: only whether the name is there is checked, it is never called — a number is taken when a runtime timing asks for it.
    const impl = existsSync(implPathOf(folder)) ? await implOf(folder) : null;
    if (impl === null) continue;
    for (const [source, cell] of Object.entries(sourceCells(decl))) {
      const by = (impl as Record<string, unknown>)[cell.by];
      if (typeof by !== 'function') {
        problems.push(`plugin ${JSON.stringify(folder.name)}: source ${JSON.stringify(source)} says its number ` +
          `is computed by ${cell.by}() in ${PLUGIN_IMPL_NAME}, and there is no such function`);
      }
    }
    problems.push(...(await liveCallProblems(folder, decl, impl)));
  }
  return problems;
}

/** The door follows the action: insert asks offer, block asks check; a declaration of any other action has no door to ask (validation has reported it). */
function doorOf(action: unknown): 'offer' | 'check' | null {
  if (action === 'insert') return 'offer';
  if (action === 'block') return 'check';
  return null;
}

/** The rehearsal a timing owes beside its door: the same name with `_preview` (see PluginImplModule). */
export function previewDoorOf(door: string): string {
  return `${door}_preview`;
}

/**
 * The rehearsal gaps doctor reports as a notice, never as a declaration problem: every plugin that declares a
 * timing and ships no preview for it. The plugin still runs at the real timing; a rehearsal skips it and puts one
 * WARNING line on the round, which is where the cost of the gap is paid.
 */
export async function previewGaps(folders: readonly PluginFolder[]): Promise<string[]> {
  const gaps: string[] = [];
  for (const folder of folders) {
    const decl = folder.decl;
    if (decl === null || !usable(folder)) continue;
    const record = decl as Record<string, unknown>;
    const door = doorOf(record.action);
    if (door === null) continue;
    const impl = existsSync(implPathOf(folder)) ? await implOf(folder) : null;
    if (impl === null) continue; // a load failure is the `plugins` check's own line
    const cells = impl as Record<string, unknown>;
    if (typeof cells[door] !== 'function') continue; // "no door at all" is a problem, not a gap
    if (typeof cells[previewDoorOf(door)] === 'function') continue;
    gaps.push(
      `plugin ${JSON.stringify(folder.name)}: the ${String(record.timing ?? '?')}/${String(record.action ?? '?')} ` +
        `timing ships no ${previewDoorOf(door)}() -- a rehearsal skips it (one WARNING line)`,
    );
  }
  return gaps;
}

/**
 * One real question put against a stand-in project: the implementation has to answer (an offer / a reason
 * sentence) or answer "none this round", and it must not throw along the way. The stand-in does no disk write and
 * runs no command — validation may not prove an implementation lied by one graph edit or one session.
 *
 * The door contract allows asynchronous implementations (a door's signature in PluginImplModule is
 * `unknown | Promise<unknown>`, and the runtime doors await it too), so the real question here waits the Promise
 * inside the same try — a rejection falls into the raised branch and reports "raised", and a return value settles
 * first and is judged for shape after. Without the wait, an asynchronous implementation would be wrong in all
 * three directions for doctor: a rejected offer would look green (missed), a check returning a string would be
 * taken as an object (false red), and a rejected Promise would be unhandled (an unhandled rejection, which inside
 * the host process is ERR_UNHANDLED_REJECTION).
 */
/**
 * An empty object with no own keys: a plugin answering `{}` ("I have nothing to say this round") gets the same
 * treatment as null / false. The three readers of "none this round" — doctor's real question, collectOffers and
 * collectGates — agree: an empty object, like null / false, counts as "none this round".
 */
export function isEmptyObject(answer: unknown): boolean {
  return typeof answer === 'object' && answer !== null && !Array.isArray(answer) &&
    Object.keys(answer as Record<string, unknown>).length === 0;
}

async function liveCallProblems(
  folder: PluginFolder,
  decl: PluginDeclaration,
  impl: PluginImplModule,
): Promise<string[]> {
  const name = folder.name;
  const door = doorOf((decl as Record<string, unknown>).action);
  if (door === null) return [];
  const cells = impl as Record<string, unknown>;
  const call = cells[door];
  if (typeof call !== 'function') {
    return [`plugin ${JSON.stringify(name)}: ${PLUGIN_IMPL_NAME} has no ${door}(), so the ` +
      `${JSON.stringify((decl as Record<string, unknown>).action ?? null)} timing it declares can never be served`];
  }
  const standIn = mkdtempSync(join(tmpdir(), 'pf-plugin-check-'));
  try {
    const problems = await doorProblems(name, door, call as (ctx: PluginContext) => unknown, decl, standIn);
    // The rehearsal the timing owes is asked the same way when it is there: a preview that raises or answers a
    // shape its timing cannot read is a plugin defect like any other, and it would only show up on a drill.
    const preview = cells[previewDoorOf(door)];
    if (typeof preview === 'function') {
      problems.push(...await doorProblems(name, previewDoorOf(door), preview as (ctx: PluginContext) => unknown, decl, standIn));
    }
    return problems;
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}

/** One door asked on a stand-in project: the sentence it leaves when it raises, or when its answer is a shape its timing cannot read. */
async function doorProblems(
  name: string,
  door: string,
  call: (ctx: PluginContext) => unknown,
  decl: PluginDeclaration,
  standIn: string,
): Promise<string[]> {
  let answer: unknown;
  try {
    answer = await call(standInContext(decl, standIn));
  } catch (error) {
    return [`plugin ${JSON.stringify(name)}: ${door}() raised on a stand-in project: ` +
      `${error instanceof Error ? error.message : String(error)}`];
  }
  // "None this round" is always a legitimate answer, and the whole falsy family counts (the same rule as
  // collectOffers / collectGates): null / undefined / false / '' / 0, plus an object with no own keys and an empty
  // array — so a healthy plugin answering an empty table for "none this round" is not blamed.
  if (!answer || isEmptyObject(answer) || (Array.isArray(answer) && answer.length === 0)) return [];
  if (door.startsWith('check') && typeof answer !== 'string') {
    return [`plugin ${JSON.stringify(name)}: ${door}() answered ${typeof answer}, and that timing reads a ` +
      'reason string or nothing'];
  }
  if (door.startsWith('offer') && (typeof answer !== 'object' || Array.isArray(answer))) {
    return [`plugin ${JSON.stringify(name)}: ${door}() answered ${typeof answer}, and that timing reads an ` +
      'offer object or nothing'];
  }
  return [];
}
