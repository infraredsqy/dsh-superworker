import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '../src/open';
import { SimulatedExecutor } from '../src/executor';
import { answer } from '../src/words/router';
import type { WordsIO } from '../src/words/types';

/**
 * The two search tiers. The default tier is the read a title search has always been — the record's
 * cells matched in memory, and no file under the node directories is opened, however well a body
 * would match; `--verbose` turns the deep tier on: each candidate's spec.md is read (through the one
 * spelling paths holds), a hit says which cell matched, and a body hit carries a short excerpt, not
 * the whole spec. A candidate whose spec.md is not written yet is skipped, not an error. Both tiers
 * answer in the graph's own order under the same limit.
 *
 * `readFile` is counted for this file only, and only for `spec.md`; every other read passes straight
 * through. The default tier's zero is the "no disk" reading the tier promises.
 */

const specReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = actual.readFile as unknown as (path: string) => Promise<Uint8Array>;
  return {
    ...actual,
    readFile: async (path: string): Promise<Uint8Array> => {
      if (String(path).endsWith('spec.md')) specReads.count += 1;
      return readFile(path);
    },
  };
});

let root: string;
let superworker: ReturnType<typeof open>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-dag-search-'));
  superworker = open(root);
  specReads.count = 0;
  return superworker.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  superworker = undefined!;
});

/** Write one node's spec.md (the requirements). */
function writeSpec(nodeId: string, text: string): void {
  writeFileSync(join(root, '.superworker', 'nodes', nodeId, 'spec.md'), text, 'utf8');
}

describe('the default tier: titles only, no node file opened', () => {
  it('matches the title and carries no deep-tier cell, however well the body would match', async () => {
    const hit = await superworker.ledger.dag.add({ title: 'login page rebuild' });
    const miss = await superworker.ledger.dag.add({ title: 'nav bar' });
    writeSpec(miss.id, 'The loading spinner must wait for the login flow.\n');

    const hits = await superworker.ledger.dag.search('login');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(hit.id);
    expect(Object.keys(hits[0]!).sort()).toEqual(['id', 'ready', 'status', 'title']);
    // The tier's promise: not one spec.md was opened, though the body held the query.
    expect(specReads.count).toBe(0);
  });
});

describe('the deep tier: spec bodies read and marked', () => {
  it('a body-only hit says so, and the excerpt is a short window, not the spec', async () => {
    const miss = await superworker.ledger.dag.add({ title: 'nav bar' });
    const body = 'The loading spinner must wait for the login flow.\n'.repeat(4);
    writeSpec(miss.id, body);

    const hits = await superworker.ledger.dag.search('login', { verbose: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: miss.id, title: 'nav bar', status: 'todo', ready: true });
    expect(hits[0]!.match).toBe('spec');
    expect(hits[0]!.snippet).toContain('login');
    expect(hits[0]!.snippet!.length).toBeLessThan(body.length);
  });

  it('a title hit stays a title hit: no spec is opened for it and no snippet rides along', async () => {
    const hit = await superworker.ledger.dag.add({ title: 'login page rebuild' });
    writeSpec(hit.id, 'The login flow is described here too.\n');

    const hits = await superworker.ledger.dag.search('login', { verbose: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.match).toBe('title');
    expect(hits[0]!.snippet).toBeUndefined();
    expect(specReads.count).toBe(0);
  });

  it('a candidate with no spec.md is skipped, not an error; a body without the pattern is skipped too', async () => {
    await superworker.ledger.dag.add({ title: 'no requirements yet' });
    const other = await superworker.ledger.dag.add({ title: 'specs written elsewhere' });
    writeSpec(other.id, 'Nothing to find here.\n');

    const hits = await superworker.ledger.dag.search('needle', { verbose: true });
    expect(hits).toEqual([]);
  });

  it('both tiers answer in the record\'s own order, and the limit caps the same list', async () => {
    const a = await superworker.ledger.dag.add({ title: 'plain one' });
    const b = await superworker.ledger.dag.add({ title: 'the title carries the needle' });
    const c = await superworker.ledger.dag.add({ title: 'another plain one' });
    writeSpec(a.id, 'the needle hides here.\n');
    writeSpec(c.id, 'the needle hides here too.\n');

    // The record's own order: the order the ideas.json table holds the three in — the one order both tiers walk.
    const ids = [a.id, b.id, c.id];
    const tableOrder = Object.keys(
      JSON.parse(readFileSync(join(root, '.superworker', 'ideas.json'), 'utf8')).nodes,
    ).filter((id) => ids.includes(id));

    const all = await superworker.ledger.dag.search('needle', { verbose: true, limit: 0 });
    expect(all.map((hit) => hit.id)).toEqual(tableOrder);
    const matchOf = new Map([
      [a.id, 'spec'],
      [b.id, 'title'],
      [c.id, 'spec'],
    ]);
    expect(all.map((hit) => matchOf.get(hit.id))).toEqual(tableOrder.map((id) => matchOf.get(id)));
    // An explicit cap cuts the same list the same way.
    expect(
      (await superworker.ledger.dag.search('needle', { verbose: true, limit: 2 })).map((hit) => hit.id),
    ).toEqual(tableOrder.slice(0, 2));
  });

  it('activeOnly keeps completed nodes out of the deep tier too', async () => {
    const done = await superworker.ledger.dag.add({ title: 'delivered work' });
    await superworker.ledger.dag.setStatus(done.id, 'completed');
    const open = await superworker.ledger.dag.add({ title: 'open work' });
    writeSpec(done.id, 'the needle in a delivered spec.\n');
    writeSpec(open.id, 'the needle in an open spec.\n');

    const hits = await superworker.ledger.dag.search('needle', { activeOnly: true, verbose: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(open.id);
  });
});

describe('the word: dag search', () => {
  function io(): WordsIO {
    return { root, homeDir: join(root, '_home'), executor: new SimulatedExecutor(), openerAvailable: true };
  }

  it('without the flag the word answers the default tier; --verbose turns the deep tier on', async () => {
    const miss = await superworker.ledger.dag.add({ title: 'nav bar' });
    writeSpec(miss.id, 'wait for the login flow.\n');

    const plain = await answer(['dag', 'search', 'login'], io());
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.stdout)).toEqual([]);

    const deep = await answer(['dag', 'search', 'login', '--verbose'], io());
    expect(deep.code).toBe(0);
    const hits = JSON.parse(deep.stdout) as Array<{ id: string; match: string; snippet: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(miss.id);
    expect(hits[0]!.match).toBe('spec');
    expect(hits[0]!.snippet).toContain('login');
  });

  it('`--help` reads both tiers out: the deep flag and the default tier\'s no-node-file promise', async () => {
    const page = await answer(['dag', 'search', '--help'], io());
    expect(page.code).toBe(0);
    expect(page.stdout).toContain('--verbose');
    expect(page.stdout).toContain('spec.md');
    expect(page.stdout).toContain('opens no file');
  });
});
