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
 * Bring back the dispatch claims on disk: which node's launch cell carries a
 * `started` marker, valued by the line the cell sits under.
 *
 * The walk goes down the launch directory's own shape — lines, then the nodes
 * each line holds cells for, then the cell's entries — and a subtree that
 * cannot be listed (absent, refused) is skipped quietly: one fewer claim
 * moved, the way an unreadable note is. The claim's own content is nobody's
 * reading here; presence is the whole fact.
 */
export async function readClaims(
  port: WorkspaceFilesPort,
  scope: SuperworkerScope,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const claims: Record<string, string> = {}
  let lines: readonly WorkspaceDirectoryEntry[]
  try {
    lines = (await port.list(scope, RECORD_LAUNCH, signal)).entries
  } catch (error) {
    /* The launch layer itself refusing (not merely absent) is an endpoint-level failure, and it
     * keeps the same discipline as the notes half above: rethrow, so the whole reading fails
     * instead of quietly claiming "no claims" — a claim that was never read is not a claim that
     * is not there. Absent stays the normal "never dispatched here" shape. The subtree walk
     * below still skips what it cannot list: that is claim-level absence, not the endpoint's. */
    if (!isAbsent(error)) throw error
    return claims
  }
  for (const line of lines) {
    if (line.type !== 'directory') continue
    let cells: readonly WorkspaceDirectoryEntry[]
    try {
      cells = (await port.list(scope, `${RECORD_LAUNCH}/${line.name}`, signal)).entries
    } catch {
      continue
    }
    for (const cell of cells) {
      if (cell.type !== 'directory') continue
      let entries: readonly WorkspaceDirectoryEntry[]
      try {
        entries = (await port.list(scope, `${RECORD_LAUNCH}/${line.name}/${cell.name}`, signal)).entries
      } catch {
        continue
      }
      if (entries.some((entry) => entry.type === 'file' && entry.name === 'started')) {
        claims[cell.name] = line.name
      }
    }
  }
  return claims
}

/**
 * Bring back the handoff tickets on disk: which node handed a verdict in, and
 * which word it stated.
 *
 * The walk is the same shape the claims walk takes — line directories, then the
 * `<node>.json` ticket files under each — and the value is the ticket's own
 * `status`, the one field every other reader of a ticket goes through
 * (`settleGate` in the engine, and the planner before it).
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
  const tickets: Record<string, string> = {}
  let lines: readonly WorkspaceDirectoryEntry[]
  try {
    lines = (await port.list(scope, RECORD_SIGNALS, signal)).entries
  } catch (error) {
    /* Same discipline as the claims half: the layer itself refusing is an endpoint-level failure
     * and rethrows, while its absence is the ordinary "no line was ever worked here". */
    if (!isAbsent(error)) throw error
    return tickets
  }
  for (const line of lines) {
    if (line.type !== 'directory') continue
    let cells: readonly WorkspaceDirectoryEntry[]
    try {
      cells = (await port.list(scope, `${RECORD_SIGNALS}/${line.name}`, signal)).entries
    } catch {
      continue
    }
    for (const cell of cells) {
      if (cell.type !== 'file' || !cell.name.endsWith('.json')) continue
      let raw: string
      try {
        raw = await readWholeFile(port, scope, `${RECORD_SIGNALS}/${line.name}/${cell.name}`, signal)
      } catch {
        continue
      }
      const status = verdictOf(raw)
      if (status === undefined) continue
      tickets[cell.name.slice(0, -'.json'.length)] = status
    }
  }
  return tickets
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
