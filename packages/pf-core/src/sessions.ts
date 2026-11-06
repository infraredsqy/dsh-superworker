import { readdirSync } from 'node:fs';
import { nowSeconds } from './clock';
import { resolveNodeId } from './graph';
import { atomicWriteJson, jsonOptionsForRecord, readJsonFile } from './jsonio';
import { withLedgerLock } from './ledgerlock';
import { pfPaths, sessionNotePath, type PfPaths } from './paths';
import type {
  SessionHost,
  SessionNoteEntry,
  SessionNoteRecord,
  SecondsTimestamp,
} from './types';

/** One row of the session file listing: the node, its title on the graph, and the note this machine holds. */
export interface SessionNoteSummary {
  node: string;
  /** The node's title as the graph has it; an empty string when the node is no longer on the graph. */
  title: string;
  note: SessionNoteRecord;
}

/** One node's note as `show` hands it back: which node, its title, and the two lists of the note itself. */
export interface SessionShow extends SessionNoteRecord {
  node: string;
  /** The node's title as the graph has it; an empty string when the node is no longer on the graph. */
  title: string;
}

/** The sessions namespace: reading session files and noting one, these three verbs. */
export interface SessionsNamespace {
  /**
   * Every session file that can say something, by node, sorted by node id. A page that cannot be read
   * is left out on its own: one bad file never takes the other pages of the book with it.
   */
  list(): Promise<SessionNoteSummary[]>;
  /** Read one node's session file; when nothing was ever written, both lists are empty. */
  show(node: string): Promise<SessionShow>;
  /**
   * Note one session under one role: `true` when the file changed, `false` when that same session was
   * already in that list. The read and the write are one act under the project's ledger lock, so the
   * two writers a node can have — the host that opens its session and an engine path noting a
   * discussion entry — never lose one another's entries.
   */
  note(node: string, role: SessionNoteRole, session: string): Promise<boolean>;
}

/** The version of the session file: a version other than this makes the record count as never written. */
const NOTE_VERSION = 1;

/** The one host this engine opens sessions with: every entry reads as it, whatever word the file carries. */
const ASSUMED_HOST: SessionHost = 'dsh';

/** The names of the two lists, which are also how `reading` reads them. */
const ROLES = ['discussion', 'run'] as const;

/** The role a note is written under; a caller naming a third one is a bug and is refused loudly. */
export type SessionNoteRole = (typeof ROLES)[number];

function emptyNote(): SessionNoteRecord {
  return { v: 1, discussion: [], run: [] };
}

/**
 * The shape an entry is recognised by under this reading: entries without a session id are dropped;
 * the host always reads as the DSH host, whatever word the entry states (an old record carrying
 * another implementation's word is data, not an error); an unrecognisable timestamp is null (none
 * is made up).
 */
function cleanEntry(raw: unknown): SessionNoteEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const session = entry.session;
  if (typeof session !== 'string' || session === '') return null;
  const clean: SessionNoteEntry = {
    session,
    host: ASSUMED_HOST,
    at: typeof entry.at === 'string' ? (entry.at as SecondsTimestamp) : null,
  };
  if (typeof entry.source === 'string') clean.source = entry.source;
  return clean;
}

/**
 * One raw session file in the reading shape: two lists, entries outside the closed set dropped, and
 * every entry's host read as the DSH host (see `cleanEntry`). Nothing in the file can stop the read.
 */
function cleanNote(record: Record<string, unknown>): SessionNoteRecord {
  const note = emptyNote();
  for (const role of ROLES) {
    const entries = record[role];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const clean = cleanEntry(entry);
      if (clean !== null) note[role].push(clean);
    }
  }
  return note;
}

/**
 * One note in the shape a rewrite can carry forward: entries without a session id are dropped, a
 * stated host is kept **byte for byte as written** (another implementation writes these records too,
 * and a rewrite is not the place that edits its words), a missing one takes the DSH host, and an
 * unreadable timestamp becomes null. The stated word is asserted into `SessionHost` here: the type is
 * the one host this engine opens sessions with, while the file may still carry an older word as data.
 */
function cleanNoteForRewrite(record: Record<string, unknown>): SessionNoteRecord {
  const note = emptyNote();
  for (const role of ROLES) {
    const entries = record[role];
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const session = entry.session;
      if (typeof session !== 'string' || session === '') continue;
      const clean: SessionNoteEntry = {
        session,
        host: typeof entry.host === 'string' ? (entry.host as SessionHost) : ASSUMED_HOST,
        at: typeof entry.at === 'string' ? (entry.at as SecondsTimestamp) : null,
      };
      if (typeof entry.source === 'string') clean.source = entry.source;
      note[role].push(clean);
    }
  }
  return note;
}

/**
 * One node's session file, raw: `null` when it can say nothing at all.
 *
 * A missing file, an unreadable one (bad JSON / bad bytes) and an unrecognised version all read as
 * `null` — a session file is local corroboration that any reader can rebuild from the session itself,
 * and it must not be a reason for the engine to die.
 */
async function readRawNote(paths: PfPaths, nodeId: string): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    const read = await readJsonFile(sessionNotePath(paths, nodeId), 'session note');
    if (read.kind !== 'present') return null;
    raw = read.value;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.v !== NOTE_VERSION) return null;
  return record;
}

/**
 * One node's session file, always in the reading shape: two lists, empty when nothing was written.
 *
 * This is the one reading `show` and the node detail both use: the file first, and nothing else to
 * read (an unreadable file is a page that says nothing, never a refusal). The host column always
 * answers the one host this engine opens sessions with.
 */
export async function readSessionNote(root: string, nodeId: string): Promise<SessionNoteRecord> {
  const paths = pfPaths(root);
  const record = await readRawNote(paths, nodeId);
  if (record === null) return emptyNote();
  return cleanNote(record);
}

/**
 * Note one session under one role: `true` when the file changed, `false` when the id was already there
 * (a retry after a partial failure must not leave the same run in the note twice).
 *
 * The read and the write are one act and the project's ledger lock is held for it, so two writers
 * noting two sessions on one node cannot lose one another. A caller already holding the lock (the
 * node registration writes its discussion note inside its own read-change-write) may call this: the
 * lock is re-entrant for the process. The file is rewritten in the canonical shape — two lists,
 * `{v, discussion, run}` — and everything the old file carried forward comes back through the
 * writer's own cleaning (see `cleanNoteForRewrite`); nothing else is touched.
 */
export async function appendSessionNote(
  root: string,
  nodeId: string,
  role: SessionNoteRole,
  session: string,
): Promise<boolean> {
  if (role !== 'discussion' && role !== 'run') {
    throw new Error(`session note role must be one of ${JSON.stringify([...ROLES])}, got ${JSON.stringify(role)}`);
  }
  if (typeof session !== 'string' || session === '') {
    throw new Error('a session note entry needs a session id');
  }
  const paths = pfPaths(root);
  return withLedgerLock(paths, async () => {
    const raw = await readRawNote(paths, nodeId);
    const note = raw === null ? emptyNote() : cleanNoteForRewrite(raw);
    if (note[role].some((entry) => entry.session === session)) return false;
    note[role].push({ session, host: ASSUMED_HOST, at: nowSeconds() });
    await atomicWriteJson(sessionNotePath(paths, nodeId), note, jsonOptionsForRecord('session-note'));
    return true;
  });
}

/** The node table on the graph: an unreadable graph counts as an empty graph (only borrowed for ids and titles here, the records are not judged). */
async function graphNodes(paths: PfPaths): Promise<Record<string, unknown>> {
  try {
    const read = await readJsonFile(paths.ideasJson, 'ideas.json');
    if (read.kind !== 'present') return {};
    const data = read.value;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
    const nodes = (data as Record<string, unknown>).nodes;
    if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) return {};
    return nodes as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One node's title off the table `graphNodes` read; a node that is gone (or says nothing) gives an empty string. */
function titleOn(nodes: Record<string, unknown>, nodeId: string): string {
  const node = nodes[nodeId];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return '';
  const title = (node as Record<string, unknown>).title;
  return typeof title === 'string' ? title : '';
}

/** Assemble the sessions namespace: one per project root. */
export function createSessionsNamespace(root: string): SessionsNamespace {
  const paths = pfPaths(root);

  return {
    async list(): Promise<SessionNoteSummary[]> {
      let names: string[];
      try {
        names = readdirSync(paths.sessionsDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
      const nodes = await graphNodes(paths);
      const out: SessionNoteSummary[] = [];
      for (const name of names) {
        const node = name.slice(0, -'.json'.length);
        const record = await readRawNote(paths, node);
        if (record === null) continue;
        const note = cleanNote(record);
        // A session file that can say nothing does not enter the listing: an empty file is not a session.
        if (note.discussion.length === 0 && note.run.length === 0) continue;
        out.push({ node, title: titleOn(nodes, node), note });
      }
      return out;
    },

    async show(node: string): Promise<SessionShow> {
      const nodes = await graphNodes(paths);
      const uid = resolveNodeId(node, nodes as Record<string, never>);
      const note = await readSessionNote(root, uid);
      // The title is read off the same table the id was resolved against: a node that is gone gives
      // an empty title, and the note it left behind is still worth reading.
      return { node: uid, title: titleOn(nodes, uid), ...note };
    },

    /*
     * The one writer on the namespace. It takes the full node id as given: a prefix is an id a reader
     * can say, and a note names the directory a node already has. Everything else — the lock, the
     * carry-forward cleaning, the de-duplication by session id — belongs to `appendSessionNote`.
     */
    async note(node: string, role: SessionNoteRole, session: string): Promise<boolean> {
      return appendSessionNote(root, node, role, session);
    },
  };
}
