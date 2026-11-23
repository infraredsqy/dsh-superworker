/**
 * The instruction account's scope vocabulary, as the host half reads it: the one home is the
 * instruction plugin's own storage layer, and this file is the only place that goes and gets it.
 *
 * The vocabulary decides what a retired scope word is, and a retired word decides which rows the
 * panel never sees: the node level was taken out of the account, so a row an older account carries
 * with that word is skipped at the one place records enter the reading (`readReading` in
 * `records.ts`) — the model layer never learns the word, and the plugin's own reads carry the same
 * judgement because both sides read this one constant. One table, one home; every reader derives
 * from it.
 *
 * **Which folder to read is a seam, not a guess.** The plugin folder this package ships answers on a
 * normal deployment ({@link shippedPluginsDir}); a caller may name another, and a caller that passes
 * `null` means "do not look at all". The read goes through a dynamic `import` of the file's own path,
 * so nothing here is statically bundled into the host artifact and the plugin folder stays the thing
 * that ships.
 *
 * **A vocabulary that cannot be read is no vocabulary.** A missing folder, an unloadable file, an
 * export of the wrong shape: every one of them answers `null`, and the caller then filters nothing —
 * the reading carries the rows as they sit on disk. That is a degraded installation's answer, chosen
 * over hiding real rows: a `null` hands the old behaviour back (every word reads as its own scope),
 * while an invented table would silently decide visibility nobody declared. The plugin's own word
 * surface keeps working either way; only the panel's filter stands down.
 *
 * The bound is the module loader's load scope, not a watch: a frozen constant cannot change under a
 * running process.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { shippedPluginsDir } from './skill-paths.ts'

/**
 * Where the vocabulary comes from: the folder this package ships (the default), another folder a
 * caller names, or nothing at all (`null` — nothing is filtered, and no file is opened).
 */
export type InstructionScopesFolder = string | null | undefined

/** The vocabulary as the plugin's storage layer declares it: the words the account issues, and the ones it no longer does. */
export interface InstructionScopes {
  readonly valid: readonly string[]
  readonly retired: readonly string[]
}

/** The directory name the instruction plugin sits under, inside the plugins folder. */
const INSTRUCTION_PLUGIN_DIR = 'instruction'

/** The file inside that plugin which holds the scope constants. */
const STORAGE_FILE = join('tools', 'storage.mjs')

/** The two constants' own names, as that storage layer exports them. */
const VALID_EXPORT = 'VALID_SCOPES'
const RETIRED_EXPORT = 'RETIRED_SCOPES'

/** Whether a value is a list of scope words: an array of strings. */
function isScopeList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Whether one scope word is retired, per the vocabulary handed in.
 *
 * `null` (the vocabulary could not be obtained) answers `false` for everything: the judgement an
 * installation cannot spell is not made, and the rows flow on as they sit on disk.
 */
export function isRetiredScope(scopes: InstructionScopes | null, scope: unknown): boolean {
  return scopes !== null && typeof scope === 'string' && scopes.retired.includes(scope)
}

/**
 * Read the scope vocabulary out of the instruction plugin's own storage layer.
 *
 * The answer is cached per folder for the life of this process, on the same terms as the weight
 * table's seam ({@link readPoolWeights}): the cached things are a module's exported constants, and a
 * running process cannot see a changed constant without a reload of the module itself.
 *
 * @param folder - Where to look: absent means the shipped plugin folder, `null` means do not look.
 * @returns The vocabulary, or `null` when none could be obtained. A `null` is cached too: a folder
 *   with no instruction plugin in it will not grow one mid-process.
 */
export async function readInstructionScopes(folder?: InstructionScopesFolder): Promise<InstructionScopes | null> {
  const where = resolveFolder(folder)
  if (where === null) return null
  const known = cache.get(where)
  if (known !== undefined) return known
  const reading = readFolder(where)
  cache.set(where, reading)
  return reading
}

/** The per-folder answers already obtained, keyed by the resolved folder. The promise is cached, not the value, so two frames asking at once open the file once. */
const cache = new Map<string, Promise<InstructionScopes | null>>()

/** Which folder a call really reads: the named one, the shipped one, or none. */
function resolveFolder(folder: InstructionScopesFolder): string | null {
  return folder === null ? null : (folder ?? shippedPluginsDir())
}

/** The read itself: one dynamic import of the plugin's storage file, and the two constants judged for shape. */
async function readFolder(where: string): Promise<InstructionScopes | null> {
  let loaded: unknown
  try {
    loaded = await import(pathToFileURL(join(where, INSTRUCTION_PLUGIN_DIR, STORAGE_FILE)).href)
  } catch {
    /* No instruction plugin in that folder, or a file that will not load: neither is a vocabulary.
     * The engine's doctor names such a plugin; this half only answers "not obtained". */
    return null
  }
  const cells = (loaded as Record<string, unknown> | null)
  const valid = cells?.[VALID_EXPORT]
  const retired = cells?.[RETIRED_EXPORT]
  // The issued list has to name at least one word to be a vocabulary; the retired list may be empty
  // (a vocabulary that retired nothing), but it has to be there and be a list.
  if (!isScopeList(valid) || valid.length === 0 || !isScopeList(retired)) return null
  return { valid: [...valid], retired: [...retired] }
}

/** The file the vocabulary is read from, for a caller that has to name it (a diagnostic, a refusal). */
export function instructionScopesPath(folder?: InstructionScopesFolder): string | null {
  const where = resolveFolder(folder)
  return where === null ? null : join(where, INSTRUCTION_PLUGIN_DIR, STORAGE_FILE)
}
