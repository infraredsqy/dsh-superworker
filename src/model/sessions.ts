/**
 * The session notes' reading: which session each node should send the reader
 * to.
 *
 * What comes in is the layer of notes the host half moved back verbatim —
 * file names as-is, contents as-is. Which files count as notes, which node
 * they belong to (the file name itself is the node id), and which one to show
 * when a node has several sessions are all judged here; a file that cannot be
 * parsed skips its node and the rest are read as usual — that node simply has
 * no session to go to on this machine, and the panel draws "none".
 *
 * A note carries two lists answering two different questions, and they are
 * never interchangeable: `run` names the session that **works** the node,
 * `discussion` names the conversation it was **born in**. Only the first is a
 * session this node owns; the second is somebody else's conversation.
 */

import { asRecord } from './fields.ts'

/** The file-name suffix of a note: the file name itself is the node id. */
const NOTE_SUFFIX = '.json'

/** The two lists a note carries, which are two different questions: `run` works the node, `discussion` was where it was born. */
type NoteKind = 'discussion' | 'run'

function refsOf(note: Record<string, unknown>, kind: NoteKind): readonly unknown[] {
  const list = note[kind]
  return Array.isArray(list) ? list : []
}

/**
 * The most recently opened session of **one** kind.
 *
 * The moment is the record's own moment text, spelled the same way on both
 * sides, so it compares directly as text. The kinds are never ranked against
 * one another here: each answers its own question, and a caller asking for one
 * kind must not be handed the other simply because it came later.
 */
function latestOfKind(note: unknown, kind: NoteKind): string | undefined {
  const held = asRecord(note)
  if (held === undefined) return undefined
  let best: { readonly session: string; readonly at: string } | undefined
  for (const entry of refsOf(held, kind)) {
    const ref = asRecord(entry)
    if (ref === undefined) continue
    const session = ref.session
    if (typeof session !== 'string' || session.length === 0) continue
    const at = typeof ref.at === 'string' ? ref.at : ''
    if (best === undefined || at >= best.at) best = { session, at }
  }
  return best?.session
}

/**
 * The session that **works** this node: its latest `run` entry, or nothing.
 *
 * A node with no `run` entry has no working session — it was prepared, maybe,
 * but nobody was ever dispatched to it, and that node is still `todo`. This is
 * the only session the overview may draw a window for.
 *
 * `discussion` is deliberately not a fallback. It names the conversation this
 * node was *created in*, which is somebody else's work: borrowing it would put
 * an unrelated conversation's rows and ending on a cell that never started, and
 * a cell that was never started must not wear another conversation's verdict.
 */
export function runSessionOf(note: unknown): string | undefined {
  return latestOfKind(note, 'run')
}

/**
 * The conversation this node was **born in**: its latest `discussion` entry, or
 * nothing. It answers where a node came from — the press that takes a reader
 * back to the conversation that created it — and nothing about the work.
 */
export function bornInSessionOf(note: unknown): string | undefined {
  return latestOfKind(note, 'discussion')
}

/** One reading of a layer of notes: keys are node ids, values the one session the kind asked for. */
function readKind(
  notes: Readonly<Record<string, string>>,
  pick: (note: unknown) => string | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(notes)) {
    if (!name.endsWith(NOTE_SUFFIX)) continue
    const nodeId = name.slice(0, -NOTE_SUFFIX.length)
    if (nodeId.length === 0) continue
    let held: unknown
    try {
      held = JSON.parse(raw)
    } catch {
      continue
    }
    const session = pick(held)
    if (session !== undefined) out[nodeId] = session
  }
  return out
}

/**
 * Read a layer of notes into a reading: keys are node ids, values the session
 * that works each node. A node with no working session is simply absent — the
 * caller reads that absence as "no window", never as "use the other list".
 */
export function readSessions(notes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return readKind(notes, runSessionOf)
}

/**
 * Read the same layer for the other question: keys are node ids, values the
 * conversation each node was created in. Kept apart from {@link readSessions}
 * so a birthplace can never stand in for a working session.
 */
export function readBirthplaces(notes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return readKind(notes, bornInSessionOf)
}

/**
 * The stranded dispatch: which line this cell's claim belongs to when the
 * claim is on disk and the session it opened is gone, `null` when it is not.
 *
 * The dispatch writes a claim when a session is really out; the session's
 * identity is this machine's own note. Both on disk and the session absent
 * from the host's live agents — a worker that died mid-round, or a host
 * restarted under the cell — the cell can never settle by itself: nothing is
 * left to end a turn, and the plan holds it in `wait`. That is the reading
 * here; the line id comes back so the reader's sentence can name the two
 * record words the remedy names.
 *
 * Three guards, in order: the cell must still be held by a line (a settled
 * cell keeps its claim and its note forever, and is not stranded); the host
 * must be able to say which sessions are alive (an unknown is never read as
 * gone); and the note must name the session at all (no note, no identity to
 * miss). What the reader is told to do about it is the client's sentence.
 */
export function strandedCycleOf(
  node: { readonly id: string; readonly running: boolean },
  claims: Readonly<Record<string, string>>,
  sessions: Readonly<Record<string, string>>,
  alive: ReadonlySet<string> | null,
): string | null {
  if (!node.running) return null
  if (alive === null) return null
  const claim = claims[node.id]
  if (claim === undefined || claim.length === 0) return null
  const session = sessions[node.id]
  if (session === undefined || session.length === 0) return null
  return alive.has(session) ? null : claim
}
