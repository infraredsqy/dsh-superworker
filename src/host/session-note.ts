/**
 * The session-note writer: the note saying which session a node's work runs in is written by the
 * side that opened the session — this host half, when it opens one natively (see `executor.ts`).
 *
 * The write itself belongs to the engine: a note lives in the record store's own directory layer,
 * one small file per node named by the node id, and the engine owns its shape, the carry-forward of
 * whatever is already written and the de-duplication by session id. This side only names the entry,
 * through the package's `sessions.note`; a second writer beside that one is a way to lose the
 * other's entries. The reading of notes is elsewhere (`sessions.ts`); nothing here judges which
 * session a node should show.
 */
import { open } from 'pf-core'

/**
 * Note the session just opened for this node as this round's `run` entry. The engine answers
 * whether the file changed; an open takes no verdict from that, so the answer does not travel.
 */
export async function noteOpenedSession(root: string, node: string, session: string): Promise<void> {
  await open(root).sessions.note(node, 'run', session)
}
