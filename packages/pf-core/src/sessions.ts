import { readdirSync } from 'node:fs';
import { nowSeconds } from './clock';
import { SESSION_HOST_OVERRIDE, resolveConfig } from './config';
import { PfError, isPfError } from './errors';
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

/** The own options of the namespace: where the machine layer's home is (the host override is a global-layer setting). */
export interface SessionsOptions {
  /** The home of the machine layer (`<home>/.pf/config.json`); this machine's user home directory by default, which tests shut into a temporary directory. */
  readonly homeDir?: string;
}

/** The version of the session file: a version other than this makes the record count as never written. */
const NOTE_VERSION = 1;

/** The host assumed when a session entry states none: the record says which session and which host opened it, and a missing host is the DSH host. */
const ASSUMED_HOST: SessionHost = 'dsh';

/** The names of the two lists, which are also how `reading` reads them. */
const ROLES = ['discussion', 'run'] as const;

/** The role a note is written under; a caller naming a third one is a bug and is refused loudly. */
export type SessionNoteRole = (typeof ROLES)[number];

/** The id prefix of the ZCode host's own sessions; used by the writer's fallback when an entry states no host. */
const ZCODE_ID_PREFIX = 'sess_';

function emptyNote(): SessionNoteRecord {
  return { v: 1, discussion: [], run: [] };
}

/**
 * What host opened a session: the writer's word is trusted as it is written.
 *
 * - With the override setting on, the written host is not read at all — every entry reads as the DSH
 *   host. The setting rides on the machine layer (it is a decision about this machine, not about one
 *   project), and it is off by default.
 * - With it off, a missing host means the DSH host, and the two recognised words are `dsh` and `zcode`.
 *   Any other word stops the reading and names the word: nothing is guessed from the shape of the
 *   session id, because that shape belongs to whoever minted it and a guess would look exactly like a
 *   true value.
 */
function hostOf(stated: unknown, override: boolean, session: string, where: string): SessionHost {
  if (override) return ASSUMED_HOST;
  if (stated === undefined || stated === null) return ASSUMED_HOST;
  if (stated === 'dsh' || stated === 'zcode') return stated;
  throw new PfError(
    'unknown_session_host',
    where,
    `the session file names the host ${JSON.stringify(stated)} for the session ${JSON.stringify(session)}; ` +
      'the two hosts it knows are dsh and zcode',
  );
}

/**
 * The shape an entry is recognised by under this reading: entries without a session id are dropped; the
 * written host is trusted (see `hostOf`); an unrecognisable timestamp is null (none is made up).
 */
function cleanEntry(
  raw: unknown,
  override: boolean,
  where: string,
): SessionNoteEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const session = entry.session;
  if (typeof session !== 'string' || session === '') return null;
  const clean: SessionNoteEntry = {
    session,
    host: hostOf(entry.host, override, session, where),
    at: typeof entry.at === 'string' ? (entry.at as SecondsTimestamp) : null,
  };
  if (typeof entry.source === 'string') clean.source = entry.source;
  return clean;
}

/**
 * One raw session file in the reading shape: two lists, entries outside the closed set dropped.
 *
 * An entry naming a host outside the closed set is the one thing that does stop the reading, and it
 * says which word it read (see `hostOf`).
 */
function cleanNote(
  record: Record<string, unknown>,
  override: boolean,
  where: string,
): SessionNoteRecord {
  const note = emptyNote();
  for (const role of ROLES) {
    const entries = record[role];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const clean = cleanEntry(entry, override, where);
      if (clean !== null) note[role].push(clean);
    }
  }
  return note;
}

/**
 * The host a session id belongs to, by the id's shape alone — the writer's fallback for an entry that
 * states none. Nothing on the reading side ever guesses from the shape: this is what lands on disk
 * when a note is written, so a reader afterwards sees a stated host either way.
 */
function hostOfSession(session: string): SessionHost {
  return session.startsWith(ZCODE_ID_PREFIX) ? 'zcode' : ASSUMED_HOST;
}

/**
 * One note in the shape a rewrite can carry forward: entries without a session id are dropped, a
 * stated host is kept as written, a missing one takes the id's own answer, and an unreadable
 * timestamp becomes null. This is the writer's own cleaning (a rewrite normalises the file it
 * carries) and it deliberately does not refuse a host word the reader would refuse: reading is
 * where an unknown word stops a page, and a rewrite must not be the reason a note dies.
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
        host: typeof entry.host === 'string' ? (entry.host as SessionHost) : hostOfSession(session),
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
 * Whether every session entry reads as the DSH host whatever the file says.
 *
 * Nothing stated anywhere is the ordinary state and reads as off through the declaration's default: a
 * missing settings file, or a file without this key, is silent. A layer that cannot be read or parsed
 * is handed out as the error it is, exactly as the plain read of this setting does — an unreadable
 * machine layer is not the same thing as an absent value, so "off" is not made up for it. (The session
 * file itself stays tolerant: it is local corroboration, and "cannot be read" reads as never written.)
 */
async function hostOverrideAt(root: string, options: SessionsOptions): Promise<boolean> {
  const readings = await resolveConfig(root, options);
  return readings[SESSION_HOST_OVERRIDE]?.value === 'on';
}

/**
 * One node's session file, always in the reading shape: two lists, empty when nothing was written.
 *
 * This is the one reading `show` and the node detail both use: the file first, and the machine layer
 * only when there is something to read (an unreadable file is a page that says nothing, never a
 * refusal).
 */
export async function readSessionNote(
  root: string,
  nodeId: string,
  options: SessionsOptions = {},
): Promise<SessionNoteRecord> {
  const paths = pfPaths(root);
  const record = await readRawNote(paths, nodeId);
  if (record === null) return emptyNote();
  return cleanNote(record, await hostOverrideAt(root, options), sessionNotePath(paths, nodeId));
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
    note[role].push({ session, host: hostOfSession(session), at: nowSeconds() });
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

/** Assemble the sessions namespace: one per project root; home is shut in only through its own options. */
export function createSessionsNamespace(
  root: string,
  options: SessionsOptions = {},
): SessionsNamespace {
  const paths = pfPaths(root);

  /**
   * The whole chain is resolved once for one listing, so a caller reads the settings once for all the
   * pages it needs: the listing reads it once, not once per session file, and a page that turns out
   * to have nothing in it never reaches this at all.
   */
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
      // The files that can say something are read first, so the settings chain behind the host column
      // is resolved once for the whole listing instead of once per file (and not at all when every
      // file is a page that says nothing). Its refusal is the listing's own refusal, the way `show`
      // hands it out: that layer is a setting, not local corroboration.
      const readable: { node: string; record: Record<string, unknown> }[] = [];
      for (const name of names) {
        const node = name.slice(0, -'.json'.length);
        const record = await readRawNote(paths, node);
        if (record !== null) readable.push({ node, record });
      }
      if (readable.length === 0) return [];
      const override = await hostOverrideAt(root, options);
      const nodes = await graphNodes(paths);
      const out: SessionNoteSummary[] = [];
      for (const { node, record } of readable) {
        let note: SessionNoteRecord;
        try {
          note = cleanNote(record, override, sessionNotePath(paths, node));
        } catch (error) {
          // One bad page takes only itself out of the book: an entry naming a host nobody recognises is
          // the one refusal `cleanNote` is expected to hand out, and that file drops alone with nothing
          // invented for it — the other pages answer as usual, and `show` on that node still names the
          // word. Any other error is not that refusal and goes up as it is: a page dropped for a reason
          // nobody has named would read exactly like a page that was never written.
          if (isPfError(error) && error.code === 'unknown_session_host') continue;
          throw error;
        }
        // A session file that can say nothing does not enter the listing: an empty file is not a session.
        if (note.discussion.length === 0 && note.run.length === 0) continue;
        out.push({ node, title: titleOn(nodes, node), note });
      }
      return out;
    },

    async show(node: string): Promise<SessionShow> {
      const nodes = await graphNodes(paths);
      const uid = resolveNodeId(node, nodes as Record<string, never>);
      const note = await readSessionNote(root, uid, options);
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
