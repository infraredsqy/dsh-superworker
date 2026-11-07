/**
 * Read the workspace's records into a reading: locate, page through, parse,
 * and collect verbatim into the boundary shapes.
 *
 * Reads only go through the host's existing workspace file gateway (paged
 * reads by line, directory listings), always read-only. The gateway caps a
 * page by bytes and rejects pages over the cap, so the strategy here is
 * "fetch page by page until `eof`", halving the line count and retrying
 * whenever a page is refused.
 */
import { RECORD_DIR, RECORD_SOURCES } from './contract.ts'
import type {
  SuperworkerCycle,
  SuperworkerInstruction,
  SuperworkerIssue,
  SuperworkerNode,
  SuperworkerReading,
  SuperworkerSourceState,
} from './contract.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Where to read from during a fetch. */
export interface SuperworkerScope {
  /** Session identity; the workspace file gateway resolves paths by it. */
  readonly sessionId: SessionId
  /** The workspace root to read, absolute; records are looked up below it. */
  readonly workspaceRoot: string
}

export interface WorkspaceDirectoryEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

export interface WorkspaceDirectoryListing {
  readonly path: string
  readonly entries: readonly WorkspaceDirectoryEntry[]
  readonly truncated: boolean
}

export interface WorkspaceFilePage {
  /** This page's lines, joined with `\n`. */
  readonly text: string
  /** How many lines this page holds; `0` means the offset is past the end of the file. */
  readonly lines: number
  /** Whether this page includes the last line. */
  readonly eof: boolean
}

/**
 * The two actions this step needs from the host's workspace file gateway.
 * Both are declared as methods: the real gateway resolves paths from the
 * session identity, and small differences in the parameters are absorbed by
 * the lenient matching at the method position.
 */
export interface WorkspaceFilesPort {
  list(scope: SuperworkerScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
  read(
    scope: SuperworkerScope,
    path: string,
    range: { readonly offset?: number; readonly limit?: number },
    signal: AbortSignal,
  ): Promise<WorkspaceFilePage>
}

/** The top-level key holding the collection in each source, matching the records' own spelling. */
const COLLECTION_KEY = {
  nodes: 'nodes',
  cycles: 'cycles',
  instructions: 'instructions',
  issues: 'issues',
} as const

/**
 * The code the gateway gives when the target does not exist; only it counts
 * as "this piece is absent from the workspace".
 *
 * This is the workspace file gateway's error contract, written in exactly one
 * place in the repo: sessions.ts uses it too, when judging whether that
 * directory layer exists.
 */
export const NOT_FOUND = 'workspace-file/not-found'

/** The gateway also caps a page by bytes: it refuses an over-cap page rather than truncating it for us. */
const PAGE_TOO_LARGE = 'workspace-file/too-large'

/** The code it gives when the requested page line count exceeds its own tier. */
const PAGE_LIMIT_REFUSED = 'gateway/bad-request'

/** The halving start point when the default tier is refused and the gateway's tier has not been learned from any page yet. */
const SHRINK_FROM_LINES = 256

/** Whether this error counts as "this piece is absent from the workspace"; the criterion is exactly the {@link NOT_FOUND} code. */
export function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === NOT_FOUND
}

/**
 * The two ways the gateway refuses a page: the page's byte size is over the
 * cap, or the requested line count exceeds its tier. Both only mean "this
 * page size does not pass here" — shrink a tier and retry.
 */
function isPageRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === PAGE_TOO_LARGE || error.code === PAGE_LIMIT_REFUSED
}

/** The records store nodes and the issue pool as id-keyed maps; cycles and instructions as lists. */
function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One collected piece, ready to land in its slot: the slot name travels with
 * the value, so the fill site in {@link readReading} is judged against the
 * matching accumulator's own field types instead of a bare `unknown`.
 */
type Collected =
  | { readonly slot: 'nodes'; readonly value: Record<string, SuperworkerNode> }
  | { readonly slot: 'cycles'; readonly value: readonly SuperworkerCycle[] }
  | { readonly slot: 'instructions'; readonly value: readonly SuperworkerInstruction[] }
  | { readonly slot: 'issues'; readonly value: Record<string, SuperworkerIssue> }

/**
 * Collect one collection: key names as in the records, entries copied
 * field-for-field; fields present in the records but not listed here come
 * along too — no trimming, no default-filling.
 * @returns The piece with the slot it belongs to when the shape matches,
 * `undefined` otherwise (the piece counts as unreadable).
 */
function collect(key: keyof typeof COLLECTION_KEY, parsed: unknown): Collected | undefined {
  if (!isMapLike(parsed)) return undefined
  const value = parsed[COLLECTION_KEY[key]]
  if (key === 'cycles' || key === 'instructions') {
    if (!Array.isArray(value)) return undefined
    // One pass: validate and copy per item; an ill-shaped item marks the whole piece unreadable on the spot.
    const items: Record<string, unknown>[] = []
    for (const item of value) {
      if (!isMapLike(item)) return undefined
      items.push({ ...item })
    }
    return key === 'cycles' ? { slot: 'cycles', value: items } : { slot: 'instructions', value: items }
  }
  if (!isMapLike(value)) return undefined
  // The map slots walk separately so each builds its own entry type: the item copy lands through a judged write, not a claim.
  if (key === 'nodes') {
    const entries: Record<string, SuperworkerNode> = {}
    for (const [id, item] of Object.entries(value)) {
      if (!isMapLike(item)) return undefined
      entries[id] = { ...item }
    }
    return { slot: 'nodes', value: entries }
  }
  const entries: Record<string, SuperworkerIssue> = {}
  for (const [id, item] of Object.entries(value)) {
    if (!isMapLike(item)) return undefined
    entries[id] = { ...item }
  }
  return { slot: 'issues', value: entries }
}

/**
 * Fetch a whole file page by page, joining the pieces back with `\n`.
 *
 * The page size starts at the gateway's own tier: omitting `limit` from the
 * request gets its default tier. When it refuses a page (bytes over its
 * per-page cap, or requested lines over its tier), halve the page's line
 * count and retry until the whole file is read; only a single line exceeding
 * the cap (unpassable even at one line) is a genuinely unreadable file, and
 * that is rethrown for the caller to judge.
 */
export async function readWholeFile(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const pages: string[] = []
  let offset = 1
  // Lines per page for this page: `undefined` = the gateway's default tier; after a refusal it settles on a smaller tier, only ever shrinking.
  let limit: number | undefined
  // Lines per page the gateway's default tier gives: learned when a `limit`-less page succeeds, then halved after refusals — closer to its tier than picking one out of thin air.
  let defaultLines: number | undefined
  for (;;) {
    try {
      let page: WorkspaceFilePage
      if (limit === undefined) {
        page = await port.read(scope, path, { offset }, signal)
      } else {
        const range = { offset, limit }
        page = await port.read(scope, path, range, signal)
      }
      pages.push(page.text)
      if (limit === undefined && defaultLines === undefined) defaultLines = page.lines
      // Empty page but not at the end: the gateway answered with something it does not intend to advance past; stop here so the loop cannot spin.
      if (page.eof || page.lines === 0) return pages.join('\n')
      offset += page.lines
    } catch (error) {
      if (!isPageRefused(error)) throw error
      const shrunk = Math.floor((limit ?? defaultLines ?? SHRINK_FROM_LINES) / 2)
      // Not even one line passes: this piece is truly unreadable (e.g. the whole record compressed onto one line that alone exceeds the cap) — rethrow.
      if (shrunk < 1) throw error
      limit = shrunk
    }
  }
}

/**
 * Read one workspace's records.
 *
 * The four sources that cannot be fetched yield empty collections and the
 * reading still returns: a workspace without records is a normal reading,
 * and the panel draws "nothing happened" from it. Real errors (refused
 * directory listing, caller cancellation) are rethrown, not swallowed here.
 */
export async function readReading(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
): Promise<SuperworkerReading> {
  const recording = new Map<string, readonly WorkspaceDirectoryEntry[] | undefined>()
  const listDir = async (dir: string): Promise<readonly WorkspaceDirectoryEntry[] | undefined> => {
    const known = recording.get(dir)
    if (known !== undefined || recording.has(dir)) return known
    let entries: readonly WorkspaceDirectoryEntry[] | undefined
    try {
      entries = (await port.list(scope, dir, signal)).entries
    } catch (error) {
      if (!isAbsent(error)) throw error
      entries = undefined
    }
    recording.set(dir, entries)
    return entries
  }

  const sources: Record<keyof typeof RECORD_SOURCES, SuperworkerSourceState> = {
    nodes: 'missing',
    cycles: 'missing',
    instructions: 'missing',
    issues: 'missing',
  }
  /* The accumulators wear the reading's own field types: every fill below is judged against them. The reading itself is assembled once, by the contextually typed literal in `finish`, both at the no-records early exit and at the end. */
  const nodes: Record<string, SuperworkerNode> = {}
  const cycles: SuperworkerCycle[] = []
  const instructions: SuperworkerInstruction[] = []
  const issues: Record<string, SuperworkerIssue> = {}
  const finish = (): SuperworkerReading => ({
    workspaceRoot: scope.workspaceRoot,
    recordPath: RECORD_DIR,
    sources,
    nodes,
    cycles,
    instructions,
    issues,
  })

  // List the records' directory layer once first: a listing means the workspace has records; no listing means "no such records".
  if ((await listDir(RECORD_DIR)) === undefined) return finish()

  for (const key of Object.keys(RECORD_SOURCES) as (keyof typeof RECORD_SOURCES)[]) {
    const segments = RECORD_SOURCES[key].split('/')
    let found = true
    for (let depth = 0; depth < segments.length - 1 && found; depth++) {
      const dir = segments.slice(0, depth + 1).join('/')
      const entries = await listDir(dir)
      const child = segments[depth + 1]
      const last = depth + 1 === segments.length - 1
      found = entries?.some((entry) => entry.name === child && entry.type === (last ? 'file' : 'directory')) ?? false
    }
    if (!found) continue
    try {
      const text = await readWholeFile(port, scope, RECORD_SOURCES[key], signal)
      const collection = collect(key, JSON.parse(text))
      if (collection === undefined) {
        sources[key] = 'unusable'
        continue
      }
      /* Fill the accumulator the piece names: the map slots merge by key, the array slots append in order — the slot's own field types judge every write, so a mistyped or misplaced fill fails to compile. */
      if (collection.slot === 'nodes') for (const [id, node] of Object.entries(collection.value)) nodes[id] = node
      else if (collection.slot === 'issues') for (const [id, issue] of Object.entries(collection.value)) issues[id] = issue
      else if (collection.slot === 'cycles') for (const cycle of collection.value) cycles.push(cycle)
      else for (const instruction of collection.value) instructions.push(instruction)
      sources[key] = 'read'
    } catch (error) {
      // Cancellation is rethrown: the caller did not ask for a half-read reading.
      if (signal.aborted) throw error
      sources[key] = 'unusable'
    }
  }
  return finish()
}