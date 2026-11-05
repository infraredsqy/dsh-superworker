import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigNamespace, SESSION_HOST_OVERRIDE } from '../src/config';
import { isPfError, type PfError } from '../src/errors';
import { open } from '../src/open';
import { sessionNotePath, pfPaths } from '../src/paths';
import { createSessionsNamespace, type SessionShow, type SessionsNamespace } from '../src/sessions';
import type { SessionNoteRecord } from '../src/types';

/**
 * The read-only face of session notes: list gives the whole book, show gives one node's page.
 * Notes on disk are written by the host (this machine's session ids never enter the record), so
 * the stage here follows the on-disk shape: only the reading is pinned — what can be read, what
 * comes back when it cannot, and what the host column says.
 *
 * The host rule is a closed set of two words and nothing is guessed: the written host is trusted, a
 * missing one means the DSH host, and any other word stops the reading of that page and names the
 * word (in the listing, only that page is left out). The one
 * way to overrule the written host is the machine-layer switch `session_host_override`; home is
 * walled into a temporary directory here (`<root>/_home`), so the real machine's `~/.pf` keeps every
 * byte.
 */

let root: string;
let home: string;
let sessions: SessionsNamespace;

/**
 * The one seam that reads the machine-layer settings file, counted: `readJsonFile` reads through
 * `node:fs/promises`' `readFile`, so the case below counts the calls that name that one file.
 * Nothing is stood in for — every other read stays the real implementation, and this file's own
 * reads go through `node:fs`, untouched.
 */
const settingsProbe = vi.hoisted(() => ({ path: '', reads: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => {
      if (String(args[0]) === settingsProbe.path) settingsProbe.reads += 1;
      return (actual.readFile as (...rest: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

function notePath(node: string): string {
  return sessionNotePath(pfPaths(root), node);
}

/** Write one session note in the on-disk shape (the host side's job). */
function writeNote(node: string, body: unknown): void {
  mkdirSync(join(root, '.pf', 'meta', 'sessions'), { recursive: true });
  writeFileSync(notePath(node), JSON.stringify(body, null, 2));
}

/** Write the machine-layer settings file: the layer the host override rides on. */
function writeHomeConfig(values: Record<string, unknown>): void {
  mkdirSync(join(home, '.pf'), { recursive: true });
  writeFileSync(join(home, '.pf', 'config.json'), JSON.stringify(values, null, 2));
}

/** Write the project-layer settings file. */
function writeProjectConfig(values: Record<string, unknown>): void {
  writeFileSync(join(root, '.pf', 'config.json'), JSON.stringify(values, null, 2));
}

/** Take the failure of one operation (a PfError); letting it through fails the test on its own. */
async function failureOf(run: () => Promise<unknown>): Promise<PfError> {
  try {
    await run();
  } catch (error) {
    if (isPfError(error)) return error;
    throw error;
  }
  throw new Error('an operation expected to fail went through');
}

/** Write a graph in the on-disk shape: only the ids matter here, the node field values are irrelevant to this test. */
function writeGraph(ids: string[]): void {
  const nodes: Record<string, unknown> = {};
  for (const id of ids) nodes[id] = { title: id, dependencies: [] };
  mkdirSync(join(root, '.pf'), { recursive: true });
  writeFileSync(join(root, '.pf', 'ideas.json'), JSON.stringify({ nodes }, null, 2));
}

const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-sessions-'));
  home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  sessions = createSessionsNamespace(root, { homeDir: home });
  settingsProbe.path = join(home, '.pf', 'config.json');
  settingsProbe.reads = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  home = undefined!;
  sessions = undefined!;
});

describe('show: one page for one node', () => {
  let node: string;

  beforeEach(async () => {
    const pf = open(root);
    await pf.ledger.init();
    node = (await pf.ledger.dag.add({ title: '甲' })).id;
  });

  /** One page as `show` hands it back: the node and its title in front of the note body. */
  const page = (nodeId: string, note: SessionNoteRecord, title = '甲'): SessionShow => ({
    node: nodeId,
    title,
    ...note,
  });

  it('with nothing written, both lists are empty and nothing throws', async () => {
    expect(await sessions.show(node)).toEqual(page(node, { v: 1, discussion: [], run: [] }));
  });

  it('both lists read back separately, with session, host, timestamp and source on each entry exactly as written', async () => {
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'dsh-1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'sess_z', host: 'zcode', at: null, source: 'ledger' }],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [{ session: 'dsh-1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'sess_z', host: 'zcode', at: null, source: 'ledger' }],
    }));
  });

  it('the written host is trusted whatever the id looks like: an id shaped one way says nothing about the host', async () => {
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'sess_looks_like_zcode', host: 'dsh', at: null }],
      run: [{ session: 'plain-id', host: 'zcode', at: null }],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [{ session: 'sess_looks_like_zcode', host: 'dsh', at: null }],
      run: [{ session: 'plain-id', host: 'zcode', at: null }],
    }));
  });

  it('a note with an unknown version reads as never written', async () => {
    writeNote(node, { v: 2, discussion: [{ session: 'x', host: 'dsh', at: null }], run: [] });
    expect(await sessions.show(node)).toEqual(page(node, { v: 1, discussion: [], run: [] }));
  });

  it('an unreadable note reads as never written, without throwing', async () => {
    mkdirSync(join(root, '.pf', 'meta', 'sessions'), { recursive: true });
    writeFileSync(notePath(node), '{ 这不是 JSON');
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

  it('a host outside the closed set stops the reading and names the word it did not recognise', async () => {
    writeNote(node, {
      v: 1,
      discussion: [
        { session: 's1', host: 'dsh', at: null },
        { session: 's2', host: 'codex', at: null },
      ],
      run: [],
    });
    const failure = await sessions.show(node).then(
      () => {
        throw new Error('a session entry naming an unknown host went through');
      },
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain('codex');
    expect(failure.message).toContain('dsh');
    expect(failure.message).toContain('zcode');
  });

  it('the override switch, on the machine layer, makes every entry read as dsh whatever the file says', async () => {
    writeHomeConfig({ session_host_override: 'on' });
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'sess_z', host: 'zcode', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'plain', host: 'anything-goes-away', at: null }],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [{ session: 'sess_z', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
      run: [{ session: 'plain', host: 'dsh', at: null }],
    }));
  });

  it('the override switch is a machine-layer setting only: a project-layer value is not in force, and the written host is trusted again', async () => {
    writeProjectConfig({ session_host_override: 'on' });
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'sess_z', host: 'zcode', at: null }],
      run: [],
    });
    expect(await sessions.show(node)).toEqual(page(node, {
      v: 1,
      discussion: [{ session: 'sess_z', host: 'zcode', at: null }],
      run: [],
    }));
  });

  it('an unparsable machine layer is an error, not a silent "off": the same read of the setting refuses', async () => {
    mkdirSync(join(home, '.pf'), { recursive: true });
    writeFileSync(join(home, '.pf', 'config.json'), '{ not json');
    writeNote(node, {
      v: 1,
      discussion: [{ session: 'sess_z', host: 'zcode', at: null }],
      run: [],
    });
    const throughSessions = await failureOf(() => sessions.show(node));
    const throughConfig = await failureOf(() =>
      createConfigNamespace(root, { homeDir: home }).get(SESSION_HOST_OVERRIDE),
    );
    // One reading answers both: the same code, the same file, the same refusal.
    expect(throughSessions.code).toBe('parse_failure');
    expect(throughConfig.code).toBe('parse_failure');
    expect(throughSessions.path).toBe(throughConfig.path);
    expect(throughSessions.path).toBe(join(home, '.pf', 'config.json'));
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
    mkdirSync(join(root, '.pf', 'meta', 'sessions'), { recursive: true });
    writeFileSync(notePath('44444444-4444-4444-8444-444444444444'), '{');
    const rows = await sessions.list();
    expect(rows.map((row) => row.node)).toEqual([NODE_A, NODE_B]);
    expect(rows[0]!.note.discussion).toEqual([{ session: 'd-a', host: 'dsh', at: null }]);
    expect(rows[1]!.note.run).toEqual([{ session: 'r-b', host: 'dsh', at: null }]);
  });

  it('one file naming an unknown host takes only itself out of the book: the other pages answer as usual', async () => {
    writeNote(NODE_A, { v: 1, discussion: [{ session: 's', host: 'codex', at: null }], run: [] });
    writeNote(NODE_B, { v: 1, discussion: [{ session: 'd', host: 'dsh', at: null }], run: [] });
    const rows = await sessions.list();
    expect(rows.map((row) => row.node)).toEqual([NODE_B]);
    expect(rows[0]!.note.discussion).toEqual([{ session: 'd', host: 'dsh', at: null }]);
    // Asked for on its own, that same page still refuses and names the word it read.
    writeGraph([NODE_A, NODE_B]);
    await expect(sessions.show(NODE_A)).rejects.toThrow(/codex/);
  });

  it('the settings chain behind the host column is read once for the whole listing, not once per file', async () => {
    writeHomeConfig({ session_host_override: 'off' });
    writeNote(NODE_A, { v: 1, discussion: [{ session: 'a', host: 'dsh', at: null }], run: [] });
    writeNote(NODE_B, { v: 1, discussion: [{ session: 'b', host: 'dsh', at: null }], run: [] });
    writeNote('33333333-3333-4333-8333-333333333333', {
      v: 1,
      discussion: [{ session: 'c', host: 'dsh', at: null }],
      run: [],
    });
    settingsProbe.reads = 0;
    const rows = await sessions.list();
    expect(rows).toHaveLength(3);
    expect(settingsProbe.reads).toBe(1);
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

  it('an entry this writer did not write is carried forward field for field', async () => {
    const talked = { session: 'sess_talk', host: 'zcode', at: '2026-01-01T00:00:00Z', source: 'ledger' };
    writeNote(NODE_A, { v: 1, discussion: [talked], run: [] });
    expect(await sessions.note(NODE_A, 'run', 'session-run-1')).toBe(true);
    const note = JSON.parse(readFileSync(notePath(NODE_A), 'utf8'));
    expect(note.discussion).toEqual([talked]);
    expect(note.run).toEqual([
      { session: 'session-run-1', host: 'dsh', at: expect.any(String) },
    ]);
  });
});

describe('session notes travel with their node', () => {
  it('remove takes the session note away with it', async () => {
    const pf = open(root);
    await pf.ledger.init();
    const node = (await pf.ledger.dag.add({ title: '丙' })).id;
    writeNote(node, { v: 1, discussion: [{ session: 's', host: 'dsh', at: null }], run: [] });
    expect(existsSync(notePath(node))).toBe(true);
    await pf.ledger.dag.remove(node);
    expect(existsSync(notePath(node))).toBe(false);
    expect(await sessions.list()).toEqual([]);
  });
});
