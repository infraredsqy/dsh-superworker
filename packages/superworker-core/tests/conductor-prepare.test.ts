import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareDispatch } from '../src/prepare';
import { open } from '../src/open';
import { main as instruction } from '../plugins/instruction/tools/commands.mjs';
import { pluginBase } from '../src/plugins/base';
import { hashDirectory } from './helpers/hash-dir.ts';

/**
 * Dispatch preparation (the first half of `conductor.dispatch`): the run doc, the prompt and the
 * handoff template.
 *
 * What stays here are the faces a byte comparison cannot reach: the landing spots (only two
 * products, one in the dispatch folder, one in the node directory), idempotence (a third pass
 * moves not a byte; a run doc the session wrote is not overwritten), the "only plans that
 * dispatch" gate, and the spot-name refusals.
 */

/** How many times each path was read through `fs/promises.readFile` (the mock only counts; it delegates). */
const readFileProbe = vi.hoisted(() => ({ counts: new Map<string, number>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const realReadFile = actual.readFile as (path: string, options?: unknown) => Promise<Uint8Array>;
  return {
    ...actual,
    readFile: async (path: string, options?: unknown) => {
      const key = String(path);
      readFileProbe.counts.set(key, (readFileProbe.counts.get(key) ?? 0) + 1);
      return realReadFile(path, options);
    },
  };
});

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'superworker-prepare-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Stage a scene that can be dispatched: init → one active cycle → one pinned node. */
async function stageDispatchable(root: string): Promise<{ superworker: ReturnType<typeof open>; node: { id: string } }> {
  const superworker = open(root);
  await superworker.ledger.init();
  const node = await superworker.ledger.dag.add({ title: 'prepare the round' });
  await superworker.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
  await superworker.ledger.cycles.hold('c1', node.id);
  return { superworker, node };
}

/** The file list relative to the project root (forward slashes, sorted). */
function walkRel(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (statSync(join(current, entry.name)).isDirectory()) walk(join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('dispatch preparation: landing spots and idempotence', () => {
  it('there are only two products: the prompt lands in the dispatch folder, the run doc in the node directory', async () => {
    const root = freshRoot();
    const { node } = await stageDispatchable(root);
    const before = new Set(walkRel(root));
    const prepared = await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    const added = walkRel(root).filter((rel) => !before.has(rel));
    expect(added.sort()).toEqual([
      `.superworker/meta/launch/c1/${node.id}/prompt.txt`,
      `.superworker/nodes/${node.id}/run.md`,
    ]);
    expect(prepared.nodes[0]!.run_doc).toBe(join(root, '.superworker', 'nodes', node.id, 'run.md'));
  });

  it('repeated preparation is idempotent: after a third pass the record tree has not moved a byte', async () => {
    const root = freshRoot();
    await stageDispatchable(root);
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    const afterFirst = hashDirectory(join(root, '.superworker'));
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    expect(hashDirectory(join(root, '.superworker'))).toBe(afterFirst);
  });

  it('a written run doc is left alone: what the session wrote into it is not overwritten by the next preparation', async () => {
    const root = freshRoot();
    const { node } = await stageDispatchable(root);
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    const runDoc = join(root, '.superworker', 'nodes', node.id, 'run.md');
    writeFileSync(runDoc, '## What I did\n\nwrote something.\n', 'utf8');
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    expect(readFileSync(runDoc, 'utf8')).toContain('wrote something.');
    // The prompt is different: it is the "waiting to be picked up" marker, and every preparation
    // replaces the whole file with the same bytes.
    const prompt = join(root, '.superworker', 'meta', 'launch', 'c1', node.id, 'prompt.txt');
    expect(existsSync(prompt)).toBe(true);
  });

  it('two preparations, one run doc: the bytes on disk are the first preparation\'s, and the second lands nothing of its own', async () => {
    const root = freshRoot();
    const { superworker, node } = await stageDispatchable(root);
    const runDoc = join(root, '.superworker', 'nodes', node.id, 'run.md');
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    const first = readFileSync(runDoc, 'utf8');
    expect(first).toContain('# run.md — node');
    // The record moves on between the two preparations, so the second build really differs: if
    // the second preparation wrote, its bytes would show the new title.
    await superworker.ledger.dag.update(node.id, { title: 'renamed while the session works' });
    await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    expect(readFileSync(runDoc, 'utf8')).toBe(first);
    expect(readFileSync(runDoc, 'utf8')).not.toContain('renamed while the session works');
    // Exactly one run doc: the second preparation produced no second copy anywhere.
    const nodeDir = join(root, '.superworker', 'nodes', node.id);
    expect(readdirSync(nodeDir).filter((name) => name.startsWith('run'))).toEqual(['run.md']);
  });

  it('the checked facts in the run doc come from record readings: mode, weight, cycle policy and settings', async () => {
    const root = freshRoot();
    const { superworker, node } = await stageDispatchable(root);
    await superworker.ledger.dag.update(node.id, { mode: 'checkpoint' });
    await superworker.ledger.cycles.setPolicy('c1', 'parallel', 2);
    const prepared = await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    const doc = readFileSync(prepared.nodes[0]!.run_doc, 'utf8');
    expect(doc).toContain('# run.md — node');
    expect(doc).toContain(`mode=checkpoint`);
    expect(doc).toContain('Policy: when_shelved=stop, parallel=2');
    expect(doc).toContain('- test_tier=full');
    expect(doc).toContain('- spec: ');
  });

  it('the run doc carries no user-instruction cell: the account is on disk elsewhere and the material does not list it', async () => {
    const root = freshRoot();
    await stageDispatchable(root);
    // The account is the instruction plugin's own record; it is there, and the run doc still does not gain a cell for it.
    await instruction(['add', '--text', 'changes land only in the assigned files', '--scope', 'global'], { root, base: pluginBase() });
    const prepared = await prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') });
    const doc = readFileSync(prepared.nodes[0]!.run_doc, 'utf8');
    expect(doc).not.toContain('User instructions in effect');
    // The verified facts end with the settings readings: nothing was appended after them.
    expect(doc.trimEnd().split('\n').at(-1)).toBe('- max_agents=3');
  });
});

describe('dispatch preparation: the settings chain is read once for the whole preparation', () => {
  it('preparing three slots reads the machine and project layer files one time each, not once per slot', async () => {
    const root = freshRoot();
    const superworker = open(root);
    await superworker.ledger.init();
    const ids: string[] = [];
    for (const title of ['slot a', 'slot b', 'slot c']) {
      ids.push((await superworker.ledger.dag.add({ title })).id);
    }
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await superworker.ledger.cycles.setPolicy('c1', 'parallel', 3);
    for (const id of ids) await superworker.ledger.cycles.hold('c1', id);

    const home = join(root, '_home');
    const projectConfig = join(root, '.superworker', 'config.json');
    const globalConfig = join(home, '.superworker', 'config.json');
    readFileProbe.counts.clear();
    const prepared = await prepareDispatch(root, { cycle: 'c1' }, { homeDir: home });
    expect(prepared.nodes.map((entry) => entry.node_id)).toEqual(ids);
    // One resolution of the whole chain at the preparation's start: the layers every slot shares
    // (machine, project, the line's own) are read one time each however many slots the line holds —
    // each slot's own settings reading used to re-read both files, and the run doc's three settings
    // readings alone made that 3×N reads of the same layers.
    expect(readFileProbe.counts.get(projectConfig)).toBe(1);
    expect(readFileProbe.counts.get(globalConfig)).toBe(1);
  });
});

describe('dispatch preparation: only plans that dispatch', () => {
  it('the cycle holds no node (planning answers open_node): there is no material to prepare, said on the spot', async () => {
    const root = freshRoot();
    const superworker = open(root);
    await superworker.ledger.init();
    await superworker.ledger.dag.add({ title: 'not pinned yet' });
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await expect(
      prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') }),
    ).rejects.toThrow(/open_node/);
  });

  it('the session is already open (planning answers wait): no second set of material is prepared', async () => {
    const root = freshRoot();
    const { node } = await stageDispatchable(root);
    const marker = join(root, '.superworker', 'meta', 'launch', 'c1', node.id, 'started');
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(marker, '4242 started 2026-01-01T00:00:00Z\n', 'utf8');
    await expect(
      prepareDispatch(root, { cycle: 'c1' }, { homeDir: join(root, '_home') }),
    ).rejects.toThrow(/wait/);
  });

  it('a named node that is not on the dispatch list: it says so on the spot instead of quietly dispatching another', async () => {
    const root = freshRoot();
    const superworker = open(root);
    await superworker.ledger.init();
    const a = await superworker.ledger.dag.add({ title: 'slot a' });
    const b = await superworker.ledger.dag.add({ title: 'slot b' });
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['writing'] });
    await superworker.ledger.cycles.setPolicy('c1', 'parallel', 2);
    await superworker.ledger.cycles.hold('c1', a.id);
    await superworker.ledger.cycles.hold('c1', b.id);
    const marker = join(root, '.superworker', 'meta', 'launch', 'c1', b.id, 'started');
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(marker, '4242 started 2026-01-01T00:00:00Z\n', 'utf8');
    await expect(
      prepareDispatch(root, { cycle: 'c1', node: b.id }, { homeDir: join(root, '_home') }),
    ).rejects.toThrow(/not on the list/);
    // Name the one that is on the list: only that one gets prepared.
    const prepared = await prepareDispatch(
      root,
      { cycle: 'c1', node: a.id },
      { homeDir: join(root, '_home') },
    );
    expect(prepared.nodes.map((entry) => entry.node_id)).toEqual([a.id]);
  });
});
