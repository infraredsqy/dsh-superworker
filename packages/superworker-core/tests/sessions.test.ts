import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { sessionNotePath, recordPaths } from '../src/paths';
import { createSessionsNamespace, type SessionShow, type SessionsNamespace } from '../src/sessions';
import type { SessionNoteRecord } from '../src/types';

/**
 * The read-only face of session notes: list gives the whole book, show gives one node's page.
 * Notes on disk are written by the host (this machine's session ids never enter the record), so
 * the stage here follows the on-disk shape: only the reading is pinned — what can be read, what
 * comes back when it cannot, and what the host column says.
 *
 * The host column is this engine's one host: every entry reads and shows as `dsh`, whatever word
 * the file carries. An older or unknown word is data another implementation left there, never an
 * error; the writer carries it forward byte for byte and writes its own entries as `dsh`.
 */

let root: string;
let sessions: SessionsNamespace;

function notePath(node: string): string {
  return sessionNotePath(recordPaths(root), node);
}

/** Write one session note in the on-disk shape (the host side's job). */
function writeNote(node: string, body: unknown): void {
  mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
  writeFileSync(notePath(node), JSON.stringify(body, null, 2));
}

/** Write a graph in the on-disk shape: only the ids matter here, the node field values are irrelevant to this test. */
function writeGraph(ids: string[]): void {
  const nodes: Record<string, unknown> = {};
  for (const id of ids) nodes[id] = { title: id, dependencies: [] };
  mkdirSync(join(root, '.superworker'), { recursive: true });
  writeFileSync(join(root, '.superworker', 'ideas.json'), JSON.stringify({ nodes }, null, 2));
}

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-sessions-'));
  sessions = createSessionsNamespace(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  sessions = undefined!;
});

describe('show: one page for one node', () => {
  let node: string;

  beforeEach(async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    node = (await superworker.ledger.dag.add({ title: 'A' })).id;
  });

  /** One page as `show` hands it back: the node and its title in front of the note body. */
  const page = (nodeId: string, note: SessionNoteRecord, title = 'A'): SessionShow => ({
    node: nodeId,
    title,
    ...note,
  });

  it('with nothing written, both lists are empty and nothing throws', async () => {
    expect(await sessions.show(node)).toEqual(page(node, { v: 1, discussion: [], run: [] }));
  });

  it('both lists read back separately, with session, host, timestamp and source; an old host word reads as dsh', async () => {
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'dsh-1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'sess_z', host: 'zcode', at: null, source: 'ledger' }],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [{ session: 'dsh-1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'sess_z', host: 'dsh', at: null, source: 'ledger' }],
    }));
  });

  it('the written host is data, not a reading: every entry shows the one host this engine opens, whatever the word or the id shape', async () => {
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'sess_looks_like_zcode', host: 'dsh', at: null }],
      run: [{ session: 'plain-id', host: 'zcode', at: null }],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [{ session: 'sess_looks_like_zcode', host: 'dsh', at: null }],
      run: [{ session: 'plain-id', host: 'dsh', at: null }],
    }));
  });

  it('a note with an unknown version reads as never written', async () => {
    writeNote(node, { v: 2, discussion: [{ session: 'x', host: 'dsh', at: null }], run: [] });
    expect(await sessions.show(node)).toEqual(page(node, { v: 1, discussion: [], run: [] }));
  });

  it('an unreadable note reads as never written, without throwing', async () => {
    mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
    writeFileSync(notePath(node), '{ this is not JSON');
    expect(await sessions.show(node)).toEqual(page(node, { v: 1, discussion: [], run: [] }));
  });

  it('entries that make no sense are dropped; a missing host means dsh; an unreadable timestamp becomes null', async () => {
    writeNote(node, {
      v: 1,
      discussion: [
        { host: 'dsh', at: '2026-01-01T00:00:00Z' },
        'not an object',
        { session: 'sess_abc', at: 5 },
        { session: 'plain-id', at: '2026-01-01T00:00:00Z', source: 7 },
      ],
      run: 'not a list',
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [
        { session: 'sess_abc', host: 'dsh', at: null },
        { session: 'plain-id', host: 'dsh', at: '2026-01-01T00:00:00Z' },
      ],
      run: [],
    }));
  });

  it('a word outside any vocabulary does not stop the reading: the page reads, and that entry shows the one host', async () => {
    writeNote(node, {
      v: 1,
      discussion: [
        { session: 's1', host: 'dsh', at: null },
        { session: 's2', host: 'codex', at: null },
      ],
      run: [],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [
        { session: 's1', host: 'dsh', at: null },
        { session: 's2', host: 'dsh', at: null },
      ],
      run: [],
    }));
  });

  it('ids accept the full form and a unique prefix; ambiguous and unrecognised ones are rejected', async () => {
    writeGraph(['aaaa1111-1111-4111-8111-111111111111', 'aaaa2222-2222-4222-8222-222222222222', NODE_B]);
    expect(await sessions.show(NODE_B.slice(0, 4)))
      .toEqual(page(NODE_B, { v: 1, discussion: [], run: [] }, NODE_B));
    await expect(sessions.show('aaaa')).rejects.toThrow('matches multiple nodes');
    await expect(sessions.show('cccc')).rejects.toThrow('not found');
  });
});

describe('list: the whole book of session notes', () => {
  it('no session notes gives an empty list', async () => {
    expect(await sessions.list()).toEqual([]);
  });

  it('sorted by node id, and a note with nothing readable never enters the list', async () => {
    writeNote(NODE_B, { v: 1, discussion: [], run: [{ session: 'r-b', host: 'dsh', at: null }] });
    writeNote(NODE_A, { v: 1, discussion: [{ session: 'd-a', host: 'dsh', at: null }], run: [] });
    writeNote('33333333-3333-4333-8333-333333333333', { v: 1, discussion: [], run: [] });
    mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
    writeFileSync(notePath('44444444-4444-4444-8444-444444444444'), '{');
    const rows = await sessions.list();
    expect(rows.map((row) => row.node)).toEqual([NODE_A, NODE_B]);
    expect(rows[0]!.note.discussion).toEqual([{ session: 'd-a', host: 'dsh', at: null }]);
    expect(rows[1]!.note.run).toEqual([{ session: 'r-b', host: 'dsh', at: null }]);
  });

  it('one file naming an older host word is in the book like any other, its entry read as dsh', async () => {
    writeNote(NODE_A, { v: 1, discussion: [{ session: 's', host: 'codex', at: null }], run: [] });
    writeNote(NODE_B, { v: 1, discussion: [{ session: 'd', host: 'dsh', at: null }], run: [] });
    const rows = await sessions.list();
    expect(rows.map((row) => row.node)).toEqual([NODE_A, NODE_B]);
    // Asked for on its own, that same page reads the word as data too.
    writeGraph([NODE_A, NODE_B]);
    expect((await sessions.show(NODE_A)).discussion).toEqual([{ session: 's', host: 'dsh', at: null }]);
  });
});

describe('note: the one writer on the session book', () => {
  it('appends one entry under the role it is told, and answers true when the file changed', async () => {
    expect(await sessions.note(NODE_A, 'run', 'session-run-1')).toBe(true);
    const note = JSON.parse(readFileSync(notePath(NODE_A), 'utf8'));
    expect(note.v).toBe(1);
    expect(note.discussion).toEqual([]);
    expect(note.run).toHaveLength(1);
    expect(note.run[0]).toMatchObject({ session: 'session-run-1', host: 'dsh' });
    expect(note.run[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('the same session noted twice lands once: the second call answers false and writes nothing', async () => {
    expect(await sessions.note(NODE_A, 'run', 'session-run-1')).toBe(true);
    const before = readFileSync(notePath(NODE_A), 'utf8');
    expect(await sessions.note(NODE_A, 'run', 'session-run-1')).toBe(false);
    expect(readFileSync(notePath(NODE_A), 'utf8')).toBe(before);
  });

  it('an old record still reads and is written back as it was: host: zcode shows dsh, and the written word stays on disk', async () => {
    const talked = { session: 'sess_talk', host: 'zcode', at: '2026-01-01T00:00:00Z', source: 'ledger' };
    writeGraph([NODE_A]);
    writeNote(NODE_A, { v: 1, discussion: [talked], run: [] });
    // The reading side: the old word is data, the entry shows the host this engine opens.
    expect((await sessions.show(NODE_A)).discussion).toEqual([{ ...talked, host: 'dsh' }]);

    expect(await sessions.note(NODE_A, 'run', 'session-run-1')).toBe(true);
    const text = readFileSync(notePath(NODE_A), 'utf8');
    const note = JSON.parse(text);
    expect(note.discussion).toEqual([talked]);
    // Byte for byte: the rewrite carries the word another implementation wrote.
    expect(text).toContain('"host": "zcode"');
    expect(note.run).toEqual([
      { session: 'session-run-1', host: 'dsh', at: expect.any(String) },
    ]);
    // And the page read after the rewrite shows that entry as the DSH host as well.
    expect((await sessions.show(NODE_A)).run[0]!.host).toBe('dsh');
  });
});

describe('session notes travel with their node', () => {
  it('remove takes the session note away with it', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    const node = (await superworker.ledger.dag.add({ title: 'C' })).id;
    writeNote(node, { v: 1, discussion: [{ session: 's', host: 'dsh', at: null }], run: [] });
    expect(existsSync(notePath(node))).toBe(true);
    await superworker.ledger.dag.remove(node);
    expect(existsSync(notePath(node))).toBe(false);
    expect(await sessions.list()).toEqual([]);
  });
});
