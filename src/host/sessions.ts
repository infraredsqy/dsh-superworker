/**
 * The host half's session-note fetch: which sessions each node in this
 * workspace has opened, in the directory layer where the notes live.
 *
 * The notes live inside the record store's own directory layer, as small
 * per-node note files. Fetching goes
 * through the same gateway as the four records, read-only; this only moves
 * each file back verbatim — which files count as notes, which node they
 * belong to, and which to show are reading judgments, the model layer's pure
 * functions. When the directory layer cannot be fetched, an empty reading is
 * returned as usual.
 */
import { RECORD_LAUNCH, RECORD_SESSIONS, RECORD_SIGNALS } from './contract.ts'
import { isAbsent, readWholeFile, type SuperworkerScope, type WorkspaceDirectoryEntry, type WorkspaceFilesPort } from './records.ts'

/** What the panel gets when it fetches session notes. */
export interface SuperworkerSessionsReading {
  /** The absolute workspace root read this time, same name as the four-records reading. */
  readonly workspaceRoot: string
  /** The directory layer where the notes live, workspace-relative. */
  readonly recordPath: string
  /**
   * The outcome for this layer of notes: `read` means fetched, `missing`
   * means this workspace never had the layer at all; both draw as "no
   * sessions".
   */
  readonly state: 'read' | 'missing'
  /** Each file in the layer, verbatim: keyed by file name, valued by the file's text; which count as notes is decided by the reading. */
  readonly notes: Readonly<Record<string, string>>
  /**
   * The dispatch claims on disk: which node's launch cell carries a `started`
   * marker, valued by the line the cell sits on. A claim is written by the
   * dispatch itself, so its presence answers "this round is out" — what is
   * stranded (claim present, session gone) is the model layer's call.
   */
  readonly claims: Readonly<Record<string, string>>
  /**
   * The sessions that have a live agent in this host right now, ids only;
   * `null` when this host cannot say (no agent registry, or reading it
   * failed) — an unknown is never read as "gone".
   */
  readonly alive: readonly string[] | null
  /**
   * The handoff tickets on disk: which node handed a verdict in, valued by the
   * verdict word the ticket states. A cell absent here has not handed anything
   * in — its ticket is missing, still `pending` (the mark a re-run leaves), or
   * unreadable — and that absence is the fact the overview reads a stopped
   * conversation against: a turn that closed itself with no ticket behind it
   * stopped **before** handing its work in, which the log alone cannot say (its
   * last `turn/end` is `completed` either way).
   */
  readonly tickets: Readonly<Record<string, string>>
}

/**
 * Bring back one workspace's layer of session notes, verbatim.
 *
 * When one file cannot be fetched (page refused, listed but unreadable), skip
 * that file: whether a node has sessions is judged by the reading against the
 * fetched portion, and the rest are moved as usual.
 */
export async function readSessionNotes(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
): Promise<Omit<SuperworkerSessionsReading, 'claims' | 'alive' | 'tickets'>> {
  const reading = { workspaceRoot: scope.workspaceRoot, recordPath: RECORD_SESSIONS }
  let entries: readonly WorkspaceDirectoryEntry[]
  try {
    entries = (await port.list(scope, RECORD_SESSIONS, signal)).entries
  } catch (error) {
    if (!isAbsent(error)) throw error
    return { ...reading, state: 'missing', notes: {} }
  }
  const notes: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    try {
      notes[entry.name] = await readWholeFile(port, scope, `${RECORD_SESSIONS}/${entry.name}`, signal)
    } catch {
      /* This file could not be fetched: one fewer note moved, and the reading side treats it as absent. */
    }
  }
  return { ...reading, state: 'read', notes }
}

/**
 * One walk down a line→cell directory, the shape both session-side readers share: list the lines,
 * list the cells each line holds, and carry what the cell's own reader hands back. The refusal
 * discipline lives here, once: the layer itself absent answers empty (the ordinary "never
 * dispatched here"), the layer itself refusing rethrows — an endpoint-level failure is not "no
 * claims", and a reading that failed is not a reading that came back empty — and a subtree that
 * cannot be listed is skipped quietly, the way an unreadable note is: one fewer cell moved, and the
 * reading side draws off exactly that absence. A cell whose own read fails answers `undefined` and
 * moves nothing; that skip is the cell reader's own judgment, not the walk's.
 */
async function collectLineCells(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
  layer: string,
  cellOf: (line: string, cell: WorkspaceDirectoryEntry) => Promise<readonly [string, string] | undefined>,
): Promise<Record<string, string>> {
  const collected: Record<string, string> = {}
  let lines: readonly WorkspaceDirectoryEntry[]
  try {
    lines = (await port.list(scope, layer, signal)).entries
  } catch (error) {
    if (!isAbsent(error)) throw error
    return collected
  }
  for (const line of lines) {
    if (line.type !== 'directory') continue
    let cells: readonly WorkspaceDirectoryEntry[]
    try {
      cells = (await port.list(scope, `${layer}/${line.name}`, signal)).entries
    } catch {
      continue
    }
    for (const cell of cells) {
      const carried = await cellOf(line.name, cell)
      if (carried !== undefined) collected[carried[0]] = carried[1]
    }
  }
  return collected
}

/**
 * Bring back the dispatch claims on disk: which node's launch cell carries a
 * `started` marker, valued by the line the cell sits under.
 *
 * The walk is the launch layer's own shape ({@link collectLineCells}); the
 * cell's own reading is this one: a cell that holds no `started` file carries
 * nothing, and the claim's own content is nobody's reading here — presence is
 * the whole fact.
 */
export async function readClaims(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  return collectLineCells(port, scope, signal, RECORD_LAUNCH, async (line, cell) => {
    if (cell.type !== 'directory') return undefined
    let entries: readonly WorkspaceDirectoryEntry[]
    try {
      entries = (await port.list(scope, `${RECORD_LAUNCH}/${line}/${cell.name}`, signal)).entries
    } catch {
      return undefined
    }
    return entries.some((entry) => entry.type === 'file' && entry.name === 'started') ? [cell.name, line] : undefined
  })
}

/**
 * Bring back the handoff tickets on disk: which node handed a verdict in, and
 * which word it stated.
 *
 * The walk is the signals layer's own shape ({@link collectLineCells}); the
 * value is the ticket's own `status`, the one field every other reader of a
 * ticket goes through (`settleGate` in the engine, and the planner before it).
 *
 * A ticket still stating `pending` is **not** a handed-in verdict: it is the
 * mark a re-run leaves, and the engine's own gate refuses to settle one. So
 * `pending` is dropped rather than carried, and a cell present in this map is a
 * cell whose work was actually handed in. An unreadable or ill-shaped file is
 * dropped the same way — the absence of a venue is never read as a verdict, and
 * the reader on the other side draws a debt off exactly that absence.
 */
export async function readTickets(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  return collectLineCells(port, scope, signal, RECORD_SIGNALS, async (line, cell) => {
    if (cell.type !== 'file' || !cell.name.endsWith('.json')) return undefined
    let raw: string
    try {
      raw = await readWholeFile(port, scope, `${RECORD_SIGNALS}/${line}/${cell.name}`, signal)
    } catch {
      return undefined
    }
    const status = verdictOf(raw)
    return status === undefined ? undefined : [cell.name.slice(0, -'.json'.length), status]
  })
}

/**
 * The session side of one root, assembled once: the notes, the dispatch claims
 * and the handoff tickets fetched together, and the live-agents half spread on
 * at the end — one {@link SuperworkerSessionsReading}. Both doors that carry
 * the session side (the watch frame and the session-notes endpoint) assemble
 * through here, so a session-side reading added later lands in this one place.
 * @param alive - The live-agents half, asked after the three reads land: the
 *   roster as of the moment the reading goes out, not as of the moment it
 *   started. It comes in as a reader because it is the host's own registry's
 *   answer, not a files-port read this module could make itself.
 */
export async function readSessionSide(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
  alive: () => readonly string[] | null,
): Promise<SuperworkerSessionsReading> {
  const [notes, claims, tickets] = await Promise.all([
    readSessionNotes(port, scope, signal),
    readClaims(port, scope, signal),
    readTickets(port, scope, signal),
  ])
  return { ...notes, claims, tickets, alive: alive() }
}

/**
 * The verdict word one ticket states: its `status`, when it is a word that
 * actually hands work in.
 *
 * `pending` is the re-run's own mark and hands nothing in, and a shape that is
 * not a JSON object with a string `status` says nothing this reader may use.
 * Both answer `undefined`, which the caller reads as "no verdict here".
 */
function verdictOf(raw: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const status = (parsed as { status?: unknown }).status
  if (typeof status !== 'string' || status.length === 0 || status === 'pending') return undefined
  return status
}
