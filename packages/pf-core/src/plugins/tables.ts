import { BUILTIN_KNOBS, type KnobSpec, type ConfigLayerName } from '../config';
import { cellOf, declOf, defaultFits, group, isKnownKind, isOneWord, layerCell, servedSources, sourceCells, wordsCell } from './cells';
import type { PluginDeclaration, PluginFolder, PluginReadingEntry } from './types';

/**
 * The merged tables: what the declarations say, read the same way by every reader — the command words,
 * the method names, the dedupe tags, the knobs folded into one settings table, the reading table, and
 * the listing printed one item per line.
 *
 * One table per reader, and one reader per table: the merged settings list and the listing walk the
 * same `knobSpecOf` gate, so the two never disagree about which cells are really knobs.
 */

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
    default: cell.default as KnobSpec['default'],    summary: typeof cell.summary === 'string' ? cell.summary : '',
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
