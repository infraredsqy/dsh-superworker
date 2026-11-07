import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * The graph command face: add, update, link, the three states, approval, revival, single-node
 * reads and the gates. Only invariants are pinned — a rejection has to give its reason
 * (dependents listed, the cycle spelt out), timestamps move where they should, keys that should
 * go are dropped; internal details (the read/write order inside) are not pinned.
 */

let root: string;
let pf: ReturnType<typeof open>;

const MICRO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-dag-cmd-'));
  pf = open(root);
  return pf.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  pf = undefined!;
});

describe('add: registering a node', () => {
  it('the default shape: todo, auto, no dependencies, and tags and weight only get a key when really given', async () => {
    const plain = await pf.ledger.dag.add({ title: 'plain node' });
    expect(plain).toMatchObject({
      title: 'plain node',
      description: '',
      status: 'todo',
      mode: 'auto',
      dependencies: [],
    });
    expect(plain.tags).toBeUndefined();
    expect(plain.weight).toBeUndefined();
    expect(plain.created_at).toBe(plain.updated_at);
    expect(plain.created_at).toMatch(MICRO_SHAPE);

    const dressed = await pf.ledger.dag.add({
      title: 'dressed up',
      description: 'has a note',
      tags: ['coding'],
      weight: 'light',
      mode: 'checkpoint',
    });
    expect(dressed.tags).toEqual(['coding']);
    expect(dressed.weight).toBe('light');
    expect(dressed.mode).toBe('checkpoint');
  });

  it('an empty title is rejected', async () => {
    await expect(pf.ledger.dag.add({ title: '' })).rejects.toThrow('title cannot be empty');
  });

  it('the node directory is created and holds nothing yet; specPath hands out the location before the file exists', async () => {
    const node = await pf.ledger.dag.add({ title: 'the one with a directory' });
    const dir = join(root, '.pf', 'nodes', node.id);
    expect(existsSync(dir)).toBe(true);
    // The absence of the file is how "no requirements written yet" is expressed: add pre-creates no spec.md.
    expect(existsSync(join(dir, 'spec.md'))).toBe(false);
    // The location is known before the file exists: specPath asks the layout, not the disk.
    const specPath = await pf.ledger.dag.specPath(node.id);
    expect(specPath).toBe(join(dir, 'spec.md').split('\\').join('/'));
  });

  it('depends_on pointing at a node that does not exist: the node is taken back, the graph keeps no trace, the directory is cleared away', async () => {
    await expect(
      pf.ledger.dag.add({ title: 'dangling', depends_on: ['not-a-node'] }),
    ).rejects.toThrow('dependency not-a-node not found');
    const graph = await pf.ledger.dag.list();
    expect(graph).toEqual([]);
    expect(existsSync(join(root, '.pf', 'nodes', 'not-a-node'))).toBe(false);
  });

  it('tags are trimmed, deduplicated and kept in order', async () => {
    const node = await pf.ledger.dag.add({ title: 'with tags', tags: [' coding ', 'art', 'coding'] });
    expect(node.tags).toEqual(['coding', 'art']);
  });
});

describe('update: changing a node', () => {
  it('changing title, description or mode all touch updated_at', async () => {
    const node = await pf.ledger.dag.add({ title: 'old title' });
    const updated = await pf.ledger.dag.update(node.id, { title: 'new title', description: 'new note', mode: 'manual' });
    expect(updated.title).toBe('new title');
    expect(updated.description).toBe('new note');
    expect(updated.mode).toBe('manual');
    expect(updated.updated_at > node.updated_at).toBe(true);
  });

  it('tags swap groups, null removes them all, and an empty array changes nothing', async () => {
    const node = await pf.ledger.dag.add({ title: 'the tagged one', tags: ['coding'] });
    const swapped = await pf.ledger.dag.update(node.id, { tags: ['art', 'writing'] });
    expect(swapped.tags).toEqual(['art', 'writing']);
    const cleared = await pf.ledger.dag.update(node.id, { tags: null });
    expect(cleared.tags).toBeUndefined();
    const stale = cleared.updated_at;
    const untouched = await pf.ledger.dag.update(node.id, { tags: [] });
    expect(untouched.tags).toBeUndefined();
    expect(untouched.updated_at).toBe(stale);
  });

  it('writing weight back to standard drops the key', async () => {
    const node = await pf.ledger.dag.add({ title: 'light and heavy', weight: 'light' });
    expect(node.weight).toBe('light');
    const standard = await pf.ledger.dag.update(node.id, { weight: 'standard' });
    expect(standard.weight).toBeUndefined();
  });

  it('nothing changed means no record is written: updated_at does not move', async () => {
    const node = await pf.ledger.dag.add({ title: 'the one that does not move' });
    const same = await pf.ledger.dag.update(node.id, {});
    expect(same.updated_at).toBe(node.updated_at);
  });
});

describe('link / unlink: dependency edges', () => {
  it('a self edge is rejected', async () => {
    const node = await pf.ledger.dag.add({ title: 'itself' });
    await expect(pf.ledger.dag.link(node.id, node.id)).rejects.toThrow('self-dependency');
  });

  it('a cycle is rejected: the edge is not added and no timestamp is touched', async () => {
    const a = await pf.ledger.dag.add({ title: 'A' });
    const b = await pf.ledger.dag.add({ title: 'B', depends_on: [a.id] });
    await expect(pf.ledger.dag.link(a.id, b.id)).rejects.toThrow(/cycle detected: .* → .*/);
    const after = await pf.ledger.dag.get(a.id);
    expect(after!.dependencies).toEqual([]);
    expect(after!.updated_at).toBe(a.updated_at);
  });

  it('adding a duplicate edge is a no-op, but the timestamp still moves and the record is still written', async () => {
    const a = await pf.ledger.dag.add({ title: 'A' });
    const b = await pf.ledger.dag.add({ title: 'B', depends_on: [a.id] });
    await pf.ledger.dag.link(b.id, a.id);
    const after = await pf.ledger.dag.get(b.id);
    expect(after!.dependencies).toEqual([a.id]);
    expect(after!.updated_at > b.updated_at).toBe(true);
  });

  it('link takes a list as one batch: every edge lands, and one missing dependency refuses all of them', async () => {
    const first = await pf.ledger.dag.add({ title: 'first' });
    const second = await pf.ledger.dag.add({ title: 'second' });
    const node = await pf.ledger.dag.add({ title: 'batch dependent' });

    await pf.ledger.dag.link(node.id, [first.id, second.id]);
    const wired = await pf.ledger.dag.get(node.id);
    expect(wired!.dependencies).toEqual([first.id, second.id]);

    const stale = wired!.updated_at;
    await expect(
      pf.ledger.dag.link(node.id, [first.id, 'missing']),
    ).rejects.toThrow('node missing not found');
    const afterRefusal = await pf.ledger.dag.get(node.id);
    // Nothing of the refused batch is written: not the timestamp, and not the edge that did resolve.
    expect(afterRefusal!.dependencies).toEqual([first.id, second.id]);
    expect(afterRefusal!.updated_at).toBe(stale);
  });

  it('a dependency that does not exist is rejected', async () => {
    const node = await pf.ledger.dag.add({ title: 'A' });
    await expect(pf.ledger.dag.link(node.id, 'missing')).rejects.toThrow('node missing not found');
  });

  it('removing an edge touches the timestamp; an edge already gone, with the node still on the graph, is nothing to do and writes nothing', async () => {
    const a = await pf.ledger.dag.add({ title: 'A' });
    const b = await pf.ledger.dag.add({ title: 'B', depends_on: [a.id] });
    await pf.ledger.dag.unlink(b.id, a.id);
    const after = await pf.ledger.dag.get(b.id);
    expect(after!.dependencies).toEqual([]);
    expect(after!.updated_at > b.updated_at).toBe(true);

    const stale = after!.updated_at;
    await pf.ledger.dag.unlink(b.id, a.id); // the edge is already gone and the node is still there: a no-op
    const final = await pf.ledger.dag.get(b.id);
    expect(final!.updated_at).toBe(stale);
  });

  it('a mistyped dependency (no such node on the graph) stops on the spot', async () => {
    const a = await pf.ledger.dag.add({ title: 'A' });
    await expect(pf.ledger.dag.unlink(a.id, 'typo')).rejects.toThrow('node typo not found');
  });

  it('removing an edge takes a unique prefix', async () => {
    const a = await pf.ledger.dag.add({ title: 'A' });
    const b = await pf.ledger.dag.add({ title: 'B', depends_on: [a.id] });
    await pf.ledger.dag.unlink(b.id, a.id.slice(0, 8));
    const after = await pf.ledger.dag.get(b.id);
    expect(after!.dependencies).toEqual([]);
  });
});

describe('setStatus / approve / revive: the three states and delivery', () => {
  it('landing on completed writes the completion timestamp; leaving drops it', async () => {
    const node = await pf.ledger.dag.add({ title: 'the delivered one' });
    const done = await pf.ledger.dag.setStatus(node.id, 'completed');
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBe(done.updated_at);
    expect(done.completed_at).toMatch(MICRO_SHAPE);

    const back = await pf.ledger.dag.setStatus(node.id, 'todo');
    expect(back.status).toBe('todo');
    expect(back.completed_at).toBeUndefined();
    // A key that was approved is not dropped by leaving completed: whether the approval still counts is for the criterion to say, not for the writing side.
    expect(back.approved_at).toBeUndefined();
  });

  it('a status outside the vocabulary is rejected', async () => {
    const node = await pf.ledger.dag.add({ title: 'well behaved' });
    await expect(pf.ledger.dag.setStatus(node.id, 'done' as never)).rejects.toThrow('invalid status');
  });

  it('an undelivered node is refused approval, and the refusal names which node it is', async () => {
    const node = await pf.ledger.dag.add({ title: 'not done yet' });
    await expect(pf.ledger.dag.approve(node.id)).rejects.toThrow(
      new RegExp(`^node ${node.id}.*has not been delivered yet`),
    );
  });

  it('approval writes the timestamp it is given and moves updated_at with it', async () => {
    const node = await pf.ledger.dag.add({ title: 'the delivered one' });
    await pf.ledger.dag.setStatus(node.id, 'completed');
    const at = '2026-01-02T03:04:05.000006Z';
    const approved = await pf.ledger.dag.approve(node.id, at);
    expect(approved.approved_at).toBe(at);
    expect(approved.updated_at).toBe(at);
  });

  it('a default approval timestamp takes now (microsecond shape)', async () => {
    const node = await pf.ledger.dag.add({ title: 'the delivered one' });
    await pf.ledger.dag.setStatus(node.id, 'completed');
    const approved = await pf.ledger.dag.approve(node.id);
    expect(approved.approved_at).toMatch(MICRO_SHAPE);
  });

  it('revive works only on shelved; any other state points at status', async () => {
    const node = await pf.ledger.dag.add({ title: 'the shelved one' });
    await expect(pf.ledger.dag.revive(node.id)).rejects.toThrow('node is not shelved');
    await pf.ledger.dag.setStatus(node.id, 'shelved');
    const revived = await pf.ledger.dag.revive(node.id);
    expect(revived.status).toBe('todo');
    expect(revived.updated_at > node.updated_at).toBe(true);
    await pf.ledger.dag.setStatus(node.id, 'completed');
    await expect(pf.ledger.dag.revive(node.id)).rejects.toThrow(/status="completed"/);
  });
});

describe('remove: taking a node away', () => {
  it('with dependents it is refused and they are listed; only force removes it and tears the edges apart', async () => {
    const a = await pf.ledger.dag.add({ title: 'the depended-on one' });
    const b = await pf.ledger.dag.add({ title: 'dependent', depends_on: [a.id] });
    await expect(pf.ledger.dag.remove(a.id)).rejects.toThrow(
      new RegExp(`the following nodes depend on this node:\\s*${b.id}\\s+dependent`),
    );
    // The graph as it was: both nodes are there, and so is the edge.
    expect(await pf.ledger.dag.get(a.id)).not.toBeNull();

    await pf.ledger.dag.remove(a.id, { force: true });
    expect(await pf.ledger.dag.get(a.id)).toBeNull();
    const survivor = await pf.ledger.dag.get(b.id);
    expect(survivor!.dependencies).toEqual([]);
    expect(existsSync(join(root, '.pf', 'nodes', a.id))).toBe(false);
  });

  it('a node with no dependents is removed straight away and its directory goes with it', async () => {
    const node = await pf.ledger.dag.add({ title: 'alone' });
    await pf.ledger.dag.remove(node.id);
    expect(await pf.ledger.dag.get(node.id)).toBeNull();
    expect(existsSync(join(root, '.pf', 'nodes', node.id))).toBe(false);
  });

  it('a node that does not exist is rejected', async () => {
    await expect(pf.ledger.dag.remove('ghost')).rejects.toThrow('node ghost not found');
  });
});

describe('get / specPath: single-node reads', () => {
  it('a node not on the graph comes back as null', async () => {
    expect(await pf.ledger.dag.get('nobody')).toBeNull();
  });

  it('a unique prefix matches, and an ambiguous prefix is rejected', async () => {
    const node = await pf.ledger.dag.add({ title: 'findable' });
    expect((await pf.ledger.dag.get(node.id.slice(0, 8)))!.title).toBe('findable');
    const other = await pf.ledger.dag.add({ title: 'another' });
    // Two ids sharing a prefix is very unlikely; if it really happens this case turns red by itself, and then the case gets another node.
    const prefix = commonPrefix(node.id, other.id);
    if (prefix.length > 0) {
      await expect(pf.ledger.dag.get(prefix)).rejects.toThrow('matches multiple nodes');
    }
    expect((await pf.ledger.dag.get(node.id))!.title).toBe('findable');
  });

  it('specPath is the forward-slash path of spec.md under the node directory; a node that does not exist is rejected', async () => {
    const node = await pf.ledger.dag.add({ title: 'the one with a spec' });
    const specPath = await pf.ledger.dag.specPath(node.id);
    expect(specPath).toContain(`/nodes/${node.id}/spec.md`);
    expect(specPath).not.toContain('\\');
    await expect(pf.ledger.dag.specPath('ghost')).rejects.toThrow('node ghost not found');
  });
});

describe('the init gate: a `.pf` that was never init-ed gets not one byte', () => {
  it('add is rejected and the `.pf` directory is never even created', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'pf-dag-gate-'));
    try {
      const naked = open(bare);
      await expect(naked.ledger.dag.add({ title: 'the one that cannot get in' })).rejects.toThrow(
        /was never init-ed .*Ask `init` first/,
      );
      expect(existsSync(join(bare, '.pf'))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('whole-file read-modify-write of ideas.json: other top-level keys stay as they are', () => {
  /** Fold an outside top-level key into ideas.json by hand (the shape a hand merge or a stray section lands in). */
  async function plantForeignKey(): Promise<void> {
    const ideasJson = join(root, '.pf', 'ideas.json');
    const data = JSON.parse(readFileSync(ideasJson, 'utf8')) as Record<string, unknown>;
    data.hand_merged = { keep: 'me', nested: { v: 1 } };
    const { atomicWriteJson, jsonOptionsForRecord } = await import('../src/jsonio');
    await atomicWriteJson(ideasJson, data, jsonOptionsForRecord('ideas'));
  }

  function readIdeasFile(): { nodes: Record<string, { title: string }>; hand_merged?: unknown } {
    return JSON.parse(readFileSync(join(root, '.pf', 'ideas.json'), 'utf8'));
  }

  it('after update writes back the outside top-level key is still there and the nodes table changes as usual', async () => {
    const node = await pf.ledger.dag.add({ title: 'A' });
    await plantForeignKey();
    await pf.ledger.dag.update(node.id, { title: 'A changed' });
    const data = readIdeasFile();
    expect(data.hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });
    expect(data.nodes[node.id]!.title).toBe('A changed');
  });

  it('after remove writes back the outside key is still there; when the nodes table was taken away whole, the write puts it back', async () => {
    const node = await pf.ledger.dag.add({ title: 'B' });
    await plantForeignKey();
    await pf.ledger.dag.remove(node.id);
    expect(readIdeasFile().hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });

    // The nodes table is taken away whole (the shape a hand edit breaks it into): the next write puts it back and outside keys stay as they were.
    const ideasJson = join(root, '.pf', 'ideas.json');
    const data = JSON.parse(readFileSync(ideasJson, 'utf8')) as Record<string, unknown>;
    delete data.nodes;
    const { atomicWriteJson, jsonOptionsForRecord } = await import('../src/jsonio');
    await atomicWriteJson(ideasJson, data, jsonOptionsForRecord('ideas'));
    await pf.ledger.dag.add({ title: 'C' });
    const after = readIdeasFile();
    expect(after.hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });
    expect(Object.keys(after.nodes)).toHaveLength(1);
  });
});

function commonPrefix(a: string, b: string): string {
  let end = 0;
  while (end < a.length && end < b.length && a[end] === b[end]) end += 1;
  return a.slice(0, end);
}
