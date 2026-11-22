/**
 * The issue pool's weight table, as the host half reads it: the one home is the issue plugin's own
 * storage layer, and this file is the only place that goes and gets it.
 *
 * The table was never really in the records. It belongs to whoever owns the pool and its formula —
 * the issue plugin — and it is the same constant its `issue weight` command adds up by. So the host
 * reads that plugin's own file instead of a sentence somebody happened to write in a node's text, and
 * the panel draws from what comes back. One table, one home; every other reader derives from it.
 *
 * **Which folder to read is a seam, not a guess.** The plugin folder this package ships answers on a
 * normal deployment ({@link shippedPluginsDir}); a caller may name another, and a caller that passes
 * `null` means "do not look at all". The read goes through a dynamic `import` of the file's own path,
 * so nothing here is statically bundled into the host artifact and the plugin folder stays the thing
 * that ships.
 *
 * **A table that cannot be read is no table.** A missing folder, an unloadable file, an export of the
 * wrong shape: every one of them answers `null`, and the reading then carries no weights rather than
 * a set of zeros. That is what makes the panel's gauge stand down instead of drawing a number nobody
 * wrote. The bound is the module loader's load scope, not a watch: a constant cannot change under a
 * running process.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { PoolWeights } from '../model/records.ts'
import { shippedPluginsDir } from './skill-paths.ts'

/**
 * Where the table comes from: the folder this package ships (the default), another folder a caller
 * names, or nothing at all (`null` — the reading carries no weights, and no file is opened).
 */
export type PoolWeightsFolder = string | null | undefined

/** The directory name the issue plugin sits under, inside the plugins folder. */
const ISSUE_PLUGIN_DIR = 'issue'

/** The file inside that plugin which holds the tier-to-weight constant. */
const STORAGE_FILE = join('tools', 'storage.mjs')

/** The constant's own name, as that storage layer exports it. */
const WEIGHTS_EXPORT = 'SEVERITY_WEIGHTS'

/**
 * Whether a value is a usable weight table: a plain object whose every entry is a finite number, with
 * at least one entry. An empty table is refused on purpose — it would weigh every tier as 0, which is
 * the one reading this whole path exists to avoid.
 */
function isWeights(value: unknown): value is PoolWeights {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value as Record<string, unknown>)
  return entries.length > 0 && entries.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

/**
 * Read the weight table out of the issue plugin's own storage layer.
 *
 * The answer is cached per folder for the life of this process. That is sound because the cached
 * thing is a module's exported constant: a running process cannot see a changed constant without a
 * reload of the module itself, which is the loader's business and not this seam's. A cache is what
 * keeps the panel's channel cheap — every frame asks for the table, and only the first really opens
 * the file.
 *
 * @param folder - Where to look: absent means the shipped plugin folder, `null` means do not look.
 * @returns The table, or `null` when no table could be obtained. A `null` is cached too: a folder
 *   with no issue plugin in it will not grow one mid-process, and re-opening it every frame would be
 *   a file miss on every redraw.
 */
export async function readPoolWeights(folder?: PoolWeightsFolder): Promise<PoolWeights | null> {
  const where = resolveFolder(folder)
  if (where === null) return null
  const known = cache.get(where)
  if (known !== undefined) return known
  const reading = readFolder(where)
  cache.set(where, reading)
  return reading
}

/** The per-folder answers already obtained, keyed by the resolved folder. The promise is cached, not the value, so two frames asking at once open the file once. */
const cache = new Map<string, Promise<PoolWeights | null>>()

/** Which folder a call really reads: the named one, the shipped one, or none at all. */
function resolveFolder(folder: PoolWeightsFolder): string | null {
  return folder === null ? null : (folder ?? shippedPluginsDir())
}

/** The read itself: one dynamic import of the plugin's storage file, and the constant's shape judged. */
async function readFolder(where: string): Promise<PoolWeights | null> {
  let loaded: unknown
  try {
    loaded = await import(pathToFileURL(join(where, ISSUE_PLUGIN_DIR, STORAGE_FILE)).href)
  } catch {
    /* No issue plugin in that folder, or a file that will not load: neither is a table. The engine's
     * doctor names such a plugin; this half only has to answer "not obtained" and draw nothing. */
    return null
  }
  const table = (loaded as Record<string, unknown> | null)?.[WEIGHTS_EXPORT]
  return isWeights(table) ? { ...table } : null
}

/** The file the table is read from, for a caller that has to name it (a diagnostic, a refusal). */
export function poolWeightsPath(folder?: PoolWeightsFolder): string | null {
  const where = resolveFolder(folder)
  return where === null ? null : join(where, ISSUE_PLUGIN_DIR, STORAGE_FILE)
}
