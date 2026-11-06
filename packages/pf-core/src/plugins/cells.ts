import { CHAIN_LAYERS, parseConfigValue, type ConfigKind, type ConfigLayerName } from '../config';
import type { PluginAction, PluginDeclaration, PluginFolder, PluginTiming } from './types';
import { CORE_READING_SOURCES } from './types';

/**
 * The small pieces every reader of a declaration shares: the folder ordering, the cell readers (one name
 * group, one cell, one word, one closed kind set), and the kind gates a cell's default goes through.
 *
 * These live apart from the readers that use them so that a second reader — the doctor's stand-in, for
 * one — reads a declared cell the same way the registry does, instead of spelling a second reading of
 * "what a knob cell is".
 */

/** The one ordering every folder scan keeps: by name, byte order, so two readers list a directory the same way. */
export function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The declaration of one folder (null when it could not be read). */
export function declOf(folder: PluginFolder): PluginDeclaration | null {
  return folder.decl;
}

/** One name group of a declaration, tidied into a mapping (an absent or malformed one counts as an empty table). */
export function group(decl: PluginDeclaration, key: string): Record<string, unknown> {
  const value = (decl as Record<string, unknown>)[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** One cell of a declaration group, or null when the entry is not an object at all. */
export function cellOf(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** Whether a declared value counts as one word: non-empty, no whitespace, not opening with a dash (a leading dash is how an option is spelled, and neither table talks about options). */
export function isOneWord(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value) && !value.startsWith('-');
}

/** The usable source claims of one declaration: the name is one word, it is not one the core already occupies, and `by` is one word. */
export function sourceCells(decl: PluginDeclaration): Record<string, { by: string }> {
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
export function servedSources(decl: PluginDeclaration): string[] {
  return [...CORE_READING_SOURCES, ...Object.keys(sourceCells(decl))];
}

/** Whether one knob cell's kind is among the four the core knows. */
export function isKnownKind(kind: unknown): kind is ConfigKind {
  return kind === 'number' || kind === 'integer' || kind === 'word' || kind === 'switch';
}

/** The two timings the seam serves, in the order the vocabulary states them. */
export const PLUGIN_TIMINGS: readonly PluginTiming[] = ['close', 'dispatch'];

/** The two actions the seam serves, in the order the vocabulary states them. */
export const PLUGIN_ACTIONS: readonly PluginAction[] = ['insert', 'block'];

/** The membership check of the closed timing set (absent does not count as a member; whether an absent one is named is up to the caller). */
export function isKnownTiming(timing: unknown): timing is PluginTiming {
  return typeof timing === 'string' && PLUGIN_TIMINGS.includes(timing as PluginTiming);
}

/** The membership check of the closed action set (the same as above). */
export function isKnownAction(action: unknown): action is PluginAction {
  return typeof action === 'string' && PLUGIN_ACTIONS.includes(action as PluginAction);
}

/** A declaration's layers cell folded by chain order; a non-empty table naming something outside the chain does not fold, and null comes back (the cell falls back to the whole chain). */
export function layerCell(value: unknown): ConfigLayerName[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    return null;
  }
  if (value.some((v) => !(CHAIN_LAYERS as readonly string[]).includes(v as string))) return null;
  return CHAIN_LAYERS.filter((layer) => (value as string[]).includes(layer));
}

/** The entries of a declared files list that point inside its own folder (an absolute path, one with a root or a drive letter, and one with `..` do not count). */
export function usableFiles(files: unknown): string[] {
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
export function unknownKeyProblems(
  label: string,
  cell: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const offenders = Object.keys(cell).filter((key) => !keys.includes(key));
  if (offenders.length === 0) return [];
  return [`${label}: unknown key(s) ${offenders.map((k) => JSON.stringify(k)).join(', ')} ` +
    `(known: ${keys.join(', ')})`];
}

/** The words of a knob's `values` cell, when it is a non-empty list of words (the shape `declarationProblems` reports on). */
export function wordsCell(value: unknown): string[] | undefined {
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
export function defaultFits(kind: ConfigKind, stated: unknown, values: readonly string[] | undefined): boolean {
  if (stated === null) return true;
  if (stated === undefined) return false;
  return parseConfigValue(kind, stated, values) !== null;
}
