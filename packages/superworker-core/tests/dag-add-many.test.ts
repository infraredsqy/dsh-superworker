import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { answer } from '../src/words/router';
import type { DagAddManyRow } from '../src/ledger';
import type { WordsIO } from '../src/words/types';

/**
 * The two batch entries: `dag.addMany` (one graph write for a whole batch, wired by `ref` or by ids
 * already on the graph) and `dag.link` given a list. Only invariants are pinned — a refusal writes
 * nothing at all (not one byte of ideas.json, not one node directory), refs come back on the rows
 * that carried them, and the edges are the ones the rows declared.
 */

let root: string;
let superworker: ReturnType<typeof open>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-dag-add-many-'));
  superworker = open(root);
  await superworker.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  superworker = undefined!;
});

/** The whole document as bytes: a refusal must not rewrite it. */
function ideasBytes(): Buffer {
  return readFileSync(join(root, '.superworker', 'ideas.json'));
}

/** The node directories on disk, sorted: a refusal must not create one. */
function nodeDirs(): string[] {
  const dir = join(root, '.superworker', 'nodes');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('addMany: one batch, one graph write', () => {
  it('a row may name a batch ref and a node already on the graph: three nodes, the declared edges, the refs handed back', async () => {
    const existing = await superworker.ledger.dag.add({ title: 'already on the graph' });
    const added = await superworker.ledger.dag.addMany([
      { ref: 'base', title: 'first batch', tags: ['coding'], weight: 'light' },
      { ref: 'top', title: 'second batch', depends_on: ['base', existing.id] },
    ]);

    expect(added).toHaveLength(2);
    const [base, top] = added;
    expect(base!.ref).toBe('base');
    expect(top!.ref).toBe('top');
    // The registry shape is add's own: todo / auto, an empty dependency list, tags and weight only when given.
    expect(base).toMatchObject({ title: 'first batch', description: '', status: 'todo', mode: 'auto', dependencies: [] });
    expect(base!.tags).toEqual(['coding']);
    expect(base!.weight).toBe('light');
    expect(top!.weight).toBeUndefined();
    // One moment covers the whole batch.
    expect(base!.created_at).toBe(top!.created_at);
    expect(base!.created_at).toBe(base!.updated_at);

    expect((await superworker.ledger.dag.get(top!.id))!.dependencies).toEqual([base!.id, existing.id]);
    expect((await superworker.ledger.dag.get(base!.id))!.dependencies).toEqual([]);
    const ids = (await superworker.ledger.dag.list()).map((row) => row.id).sort();
    expect(ids).toEqual([existing.id, base!.id, top!.id].sort());
    expect(nodeDirs()).toEqual([existing.id, base!.id, top!.id].sort());
  });

  it('one row with a dependency the graph does not hold refuses the whole batch: the document and the node directories stay as they were', async () => {
    const existing = await superworker.ledger.dag.add({ title: 'already there' });
    const before = ideasBytes();
    const dirsBefore = nodeDirs();

    await expect(
      superworker.ledger.dag.addMany([
        { ref: 'good', title: 'good row' },
        { title: 'bad row', depends_on: ['no-such-node'] },
      ]),
    ).rejects.toThrow('node no-such-node not found');

    expect(ideasBytes().equals(before)).toBe(true);
    expect(nodeDirs()).toEqual(dirsBefore);
    expect(dirsBefore).toEqual([existing.id]);
  });

  it('a batch cycle (a depends on b, b depends on a) is refused and the graph keeps no trace of it', async () => {
    await superworker.ledger.dag.add({ title: 'outside the ring' });
    const before = ideasBytes();
    const dirsBefore = nodeDirs();

    await expect(
      superworker.ledger.dag.addMany([
        { ref: 'a', title: 'A', depends_on: ['b'] },
        { ref: 'b', title: 'B', depends_on: ['a'] },
      ]),
    ).rejects.toThrow(/cycle detected: .* → .*/);

    expect(ideasBytes().equals(before)).toBe(true);
    expect(nodeDirs()).toEqual(dirsBefore);
  });

  it('a duplicate ref and an unknown row field are both refused with the row named', async () => {
    await superworker.ledger.dag.add({ title: 'already there' });
    const before = ideasBytes();
    const dirsBefore = nodeDirs();

    await expect(
      superworker.ledger.dag.addMany([
        { ref: 'same', title: 'one' },
        { ref: 'same', title: 'two' },
      ]),
    ).rejects.toThrow(/row 2: ref "same"/);

    const withUnknown = { title: 'one', priority: 'high' } as unknown as DagAddManyRow;
    await expect(superworker.ledger.dag.addMany([withUnknown])).rejects.toThrow(
      /row 1: unknown field "priority"/,
    );

    expect(ideasBytes().equals(before)).toBe(true);
    expect(nodeDirs()).toEqual(dirsBefore);
  });

  it('a bad title, mode, weight, tags or dependency cell refuses the batch too', async () => {
    await expect(superworker.ledger.dag.addMany([{ title: '' }])).rejects.toThrow('row 1: title cannot be empty');
    await expect(
      superworker.ledger.dag.addMany([{ title: 'mode', mode: 'always' } as unknown as DagAddManyRow]),
    ).rejects.toThrow(/row 1: mode must be one of/);
    await expect(
      superworker.ledger.dag.addMany([{ title: 'weight', weight: 'heavy' } as unknown as DagAddManyRow]),
    ).rejects.toThrow(/row 1: weight must be one of/);
    await expect(
      superworker.ledger.dag.addMany([{ title: 'tags', tags: 'coding' } as unknown as DagAddManyRow]),
    ).rejects.toThrow('row 1: tags must be an array of strings');
    await expect(superworker.ledger.dag.addMany([])).rejects.toThrow('non-empty array of rows');
  });
});

describe('addMany / link at the words layer', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(): { root: string; io: WordsIO } {
    const dir = mkdtempSync(join(tmpdir(), 'superworker-dag-add-many-words-'));
    dirs.push(dir);
    return { root: dir, io: { root: dir, homeDir: join(dir, '_home') } };
  }

  async function call(io: WordsIO, argv: readonly string[]): Promise<string> {
    const result = await answer(argv, io);
    expect(result.code, `${argv.join(' ')} answered ${result.code}: ${result.stderr}`).toBe(0);
    return result.stdout;
  }

  function idOn(line: string): string {
    return /^Node created: (\S+)/u.exec(line)![1]!;
  }

  it('--from-file prints two lines per node, and one --on list wires both edges in one call', async () => {
    const { root: projectRoot, io } = project();
    await call(io, ['init']);
    const existingId = idOn(await call(io, ['dag', 'add', 'already on the graph']));

    const file = join(projectRoot, 'batch.json');
    writeFileSync(
      file,
      JSON.stringify([
        { ref: 'a', title: 'first of the batch' },
        { ref: 'b', title: 'second of the batch', depends_on: ['a'] },
      ]),
    );

    const lines = (await call(io, ['dag', 'add', '--from-file', file])).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Node created: \S+ {2}\(ref a\)$/u);
    expect(lines[1]).toMatch(/^Spec path \(nonexistent\): .*\/nodes\/[^/]+\/spec\.md$/u);
    expect(lines[2]).toMatch(/^Node created: \S+ {2}\(ref b\)$/u);
    expect(lines[3]).toMatch(/^Spec path \(nonexistent\): .*\/nodes\/[^/]+\/spec\.md$/u);
    const a = idOn(lines[0]!);
    const b = idOn(lines[2]!);
    expect(a).not.toBe(b);

    // One comma-separated --on is one batch and one write: both edges land in this call, and the
    // receipt says so — one edge stays silent, a list answers what the whole write covered.
    const receipt = await call(io, ['dag', 'depend', existingId, '--on', `${a},${b}`]);
    expect(receipt.trim()).toBe(`Linked ${existingId.slice(0, 8)} → 2 dependencies: ${a.slice(0, 8)}, ${b.slice(0, 8)}`);
    // A single edge keeps the word's old silence; re-declaring an edge already there is a no-op.
    expect((await call(io, ['dag', 'depend', b, '--on', a])).trim()).toBe('');
    const nodes = JSON.parse(readFileSync(join(projectRoot, '.superworker', 'ideas.json'), 'utf8')).nodes;
    expect(nodes[existingId].dependencies).toEqual([a, b]);
    expect(nodes[a].dependencies).toEqual([]);
    expect(nodes[b].dependencies).toEqual([a]);
  });

  it('a title, or a per-node option, alongside --from-file is refused and writes nothing', async () => {
    const { root: projectRoot, io } = project();
    await call(io, ['init']);
    const file = join(projectRoot, 'batch.json');
    writeFileSync(file, JSON.stringify([{ title: 'only row' }]));

    const withTitle = await answer(['dag', 'add', 'a title', '--from-file', file], io);
    expect(withTitle.code).toBe(2);
    expect(withTitle.stderr).toContain('give either a title or --from-file');

    const withDesc = await answer(['dag', 'add', '--from-file', file, '--desc', 'a description'], io);
    expect(withDesc.code).toBe(2);
    expect(withDesc.stderr).toContain('--from-file takes the rows');

    // A refused call writes nothing: the graph document was never even created here.
    expect(existsSync(join(projectRoot, '.superworker', 'ideas.json'))).toBe(false);
  });
});