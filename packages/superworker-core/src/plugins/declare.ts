import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  cellOf,
  declOf,
  defaultFits,
  group,
  isKnownAction,
  isKnownKind,
  isKnownTiming,
  isOneWord,
  layerCell,
  servedSources,
  sourceCells,
  unknownKeyProblems,
  usableFiles,
  wordsCell,
  PLUGIN_ACTIONS,
  PLUGIN_TIMINGS,
} from './cells';
import { PLUGIN_DECLARATION_NAME, PLUGIN_IMPL_NAME } from './scan';
import type { PluginAction, PluginDeclaration, PluginFolder, PluginTiming } from './types';
import {
  COMMAND_CELL_KEYS,
  CORE_READING_SOURCES,
  DECLARATION_KEYS,
  KNOB_CELL_KEYS,
  MERGE_CELL_KEYS,
  METRIC_CELL_KEYS,
  READING_CELL_KEYS,
  SOURCE_CELL_KEYS,
  TIMING_ACTION_CELLS,
} from './types';
import { MERGE_STRATEGIES } from '../ledgermerge/generic';
import { CHAIN_LAYERS } from '../config';

/**
 * The closed-set validation of one declaration, and the names across plugins: what a declaration may
 * say (every cell's keys go through their own closed set, an unknown key is one declaration problem),
 * which folders may act at all (`folderProblems` / `usable`), and which names two plugins may not
 * share (`conflicts`).
 *
 * A declaration is a pure data file: this reader asks no disk except in `folderProblems`, which asks
 * whether the implementation entry and the listed files are really there.
 */

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

  // The merge cell: which rule the driver applies to this plugin's own record. Only the rules the driver really
  // implements are nameable -- a strategy written here is the driver's promise, and the driver cannot be handed
  // plugin code at merge time (a merge is one process call). So a name outside the list is a declaration problem
  // that says the rule is not there yet, and the plugin takes no part until the cell is right.
  const merge = record.merge;
  if (merge !== undefined && merge !== null) {
    const cell = cellOf(merge);
    if (cell === null) {
      out.push(`plugin ${JSON.stringify(name)}: merge must be an object ` +
        `(${MERGE_CELL_KEYS.join(', ')}) naming a strategy, one of [${MERGE_STRATEGIES.join(', ')}]`);
    } else {
      out.push(...unknownKeyProblems(`plugin ${JSON.stringify(name)}: merge`, cell, MERGE_CELL_KEYS));
      const strategy = cell.strategy;
      if (strategy === undefined || strategy === null || strategy === '') {
        out.push(`plugin ${JSON.stringify(name)}: merge names no strategy -- this core implements ` +
          `[${MERGE_STRATEGIES.join(', ')}]`);
      } else if (typeof strategy !== 'string' || !MERGE_STRATEGIES.includes(strategy)) {
        // The one sentence a person who wrote a strategy the driver does not have needs: the rule is not spelled
        // wrong, the driver simply has no rule by that name yet, and here is what it does have.
        out.push(`plugin ${JSON.stringify(name)}: merge strategy ${JSON.stringify(strategy)}: the driver does not ` +
          `implement that rule yet -- it implements [${MERGE_STRATEGIES.join(', ')}], and a merge is one process ` +
          'call with no plugin loaded, so no declaration can add one');
      }
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
