import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { warningsOf } from '../src/conductor';
import { open, type Pf } from '../src/open';
import { recordPaths } from '../src/paths';
import { offer } from '../plugins/issue/impl.mjs';

/**
 * The issue-pool plugin's close-time insert: it inserts only past the line, and right on the line
 * too (the comparison is >=); one live node per metric; with no line configured, below the line,
 * or on a line that is not about code it stays quiet for the round (it does not even ask the
 * pool's command); with the switch off the whole round gives way; a pool that cannot be read is
 * never read as 0 (one WARNING, and the main path carries on). Engine work always happens in a
 * temp dir; the repo's plugin is copied into the temp project as it is, and the repo copy does
 * not change by a byte.
 */

const REPO_PLUGIN = new URL('../plugins/issue', import.meta.url);
const REPO_PLUGIN_DIR = fileURLToPath(REPO_PLUGIN);
/** The case that replays this plugin's close-time insert over the golden corpus. */
const CORPUS_CASE = fileURLToPath(new URL('./fixtures/plugin-issue-close-insert', import.meta.url));

interface Lab {
  root: string;
  superworker: Pf;
}

let root: string;
let superworker: Pf;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-issue-close-'));
  superworker = open(root);
  await superworker.ledger.init();
  cpSync(REPO_PLUGIN, join(root, 'plugins', 'issue'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function poolPath(): string {
  return join(root, '.superworker', 'issues', 'issues.json');
}

function seedPool(entries: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(root, '.superworker', 'issues'), { recursive: true });
  writeFileSync(poolPath(), JSON.stringify({ version: 1, issues: entries }, null, 2), 'utf8');
}

function breakPool(): void {
  mkdirSync(join(root, '.superworker', 'issues'), { recursive: true });
  writeFileSync(poolPath(), '{ this is not json', 'utf8');
}

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    severity: 'P3',
    module: 'plugins',
    title: id,
    decision: 'autofix',
    source: 'scan',
    status: 'open',
    discovered: '2026-01-01T00:00:00.000001Z',
    updated_at: '2026-01-01T00:00:00.000001Z',
    check_count: 1,
    files: [],
    functions: [],
    description: '',
    suggestion: '',
    reason: null,
    plan_path: null,
    ...overrides,
  };
}

function setConfig(values: Record<string, unknown>): void {
  writeFileSync(join(root, '.superworker', 'config.json'), JSON.stringify(values, null, 2), 'utf8');
}

async function addHeldNode(title: string): Promise<string> {
  return (await superworker.ledger.dag.add({ title, tags: ['coding'] })).id;
}

/** A tagged line in service, holding the nodes given to it (the plugin's isCoding reads exactly these three tags). */
function stageCycle(id: string, holding: string[], tags: string[]): void {
  const record = {
    id,
    title: `cycle ${id}`,
    status: 'active',
    tags,
    holding: holding.map((node) => ({ id: node, since: '2026-01-01T00:00:02Z' })),
    path: [],
    created_at: '2026-01-01T00:00:02Z',
    updated_at: '2026-01-01T00:00:02Z',
  };
  const path = join(root, '.superworker', 'state.json');
  const data = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { cycles: unknown[] })
    : { cycles: [] };
  data.cycles.push(record);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function putSignal(cycle: string, node: string): void {
  const path = join(root, '.superworker', 'signals', cycle, `${node}.json`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { cycle, node, status: 'completed', summary: 'done', outputs: {}, timestamp: '2026-01-01T00:00:03Z' },
      null,
      2,
    ),
    'utf8',
  );
}

async function graph(): Promise<Array<Record<string, unknown>>> {
  return (await superworker.ledger.dag.list()) as unknown as Array<Record<string, unknown>>;
}

const MAINTENANCE_TITLE = "Maintenance: the issue pool's weighted sum = 6, over the line 4";

describe("the issue pool's close-time insert", () => {
  it('weight past the line: close inserts one maintenance node, hung after the node that was closed, and its spec lands on disk', async () => {
    const closed = await addHeldNode('the closed node');
    stageCycle('c1', [closed], ['coding']);
    putSignal('c1', closed);
    seedPool({ p1: row('p1', { severity: 'P1' }), p2: row('p2', { severity: 'P2' }) });
    setConfig({ issue_pool_weight_limit: 4 });

    const returned = await superworker.conductor.close({ cycle: 'c1', node: closed });
    expect(warningsOf(returned as object)).toEqual([]);

    const inserted = (await graph()).find((rowNode) => rowNode.title === MAINTENANCE_TITLE);
    expect(inserted).toBeDefined();
    expect(inserted!.tags).toEqual(['issue:issue_pool_weight', 'coding']);
    expect(inserted!.status).toBe('todo');
    expect(inserted!.mode).toBe('auto');
    const record = await superworker.ledger.dag.get(String(inserted!.id));
    expect(record!.dependencies).toEqual([closed]);
    const specPath = join(recordPaths(root).nodesDir, String(inserted!.id), 'spec.md');
    expect(existsSync(specPath)).toBe(true);
    const spec = readFileSync(specPath, 'utf8');
    expect(spec).toContain('# Maintenance node (generated by the tool)');
    expect(spec).toContain('`issue weight`');
    expect(spec).toContain(`(this spec lands at: ${specPath.split('\\').join('/')})`);
    // The pool itself is not rewritten by the close.
    expect(JSON.parse(readFileSync(poolPath(), 'utf8')).issues.p1.severity).toBe('P1');
  });

  it('exactly on the line still inserts: the comparison is >=, so the line is the last number still accepted', async () => {
    const closed = await addHeldNode('the closed node');
    stageCycle('c1', [closed], ['coding']);
    putSignal('c1', closed);
    seedPool({ a: row('a', { severity: 'P2' }), b: row('b', { severity: 'P2' }) });
    setConfig({ issue_pool_weight_limit: 4 });

    await superworker.conductor.close({ cycle: 'c1', node: closed });
    expect((await graph()).some((rowNode) => rowNode.title === "Maintenance: the issue pool's weighted sum = 4, over the line 4")).toBe(true);
  });

  it('below the line nothing is inserted; with no line configured nothing is inserted and the pool is never asked; a line not about code stays just as quiet', async () => {
    // Below the line: weight 2 < 4.
    const below = await addHeldNode('below the line');
    stageCycle('c1', [below], ['coding']);
    putSignal('c1', below);
    seedPool({ p2: row('p2', { severity: 'P2' }) });
    setConfig({ issue_pool_weight_limit: 4 });
    const returnedBelow = await superworker.conductor.close({ cycle: 'c1', node: below });
    expect((await graph()).some((rowNode) => String(rowNode.title).startsWith('Maintenance:'))).toBe(false);
    expect(warningsOf(returnedBelow as object)).toEqual([]);

    // No line configured: not even one pool command starts — and with the pool left as unreadable bytes it says nothing either.
    const unlined = await addHeldNode('no line configured');
    stageCycle('c2', [unlined], ['coding']);
    putSignal('c2', unlined);
    breakPool();
    setConfig({});
    const returnedUnlined = await superworker.conductor.close({ cycle: 'c2', node: unlined });
    expect(warningsOf(returnedUnlined as object)).toEqual([]);
    expect((await graph()).some((rowNode) => String(rowNode.title).startsWith('Maintenance:'))).toBe(false);

    // The line is not about code: just as quiet, and the pool is never asked.
    const docs = await addHeldNode('docs line');
    stageCycle('c3', [docs], ['docs']);
    putSignal('c3', docs);
    const returnedDocs = await superworker.conductor.close({ cycle: 'c3', node: docs });
    expect(warningsOf(returnedDocs as object)).toEqual([]);
    expect((await graph()).some((rowNode) => String(rowNode.title).startsWith('Maintenance:'))).toBe(false);
  });

  it('one live node per metric: with the tagged todo still there, the next crossing waits', async () => {
    const first = await addHeldNode('first');
    const second = await addHeldNode('second');
    stageCycle('c1', [first], ['coding']);
    stageCycle('c2', [second], ['coding']);
    putSignal('c1', first);
    putSignal('c2', second);
    seedPool({ p1: row('p1', { severity: 'P1' }), p2: row('p2', { severity: 'P2' }) });
    setConfig({ issue_pool_weight_limit: 4 });

    await superworker.conductor.close({ cycle: 'c1', node: first });
    await superworker.conductor.close({ cycle: 'c2', node: second });
    const maintenance = (await graph()).filter((rowNode) => String(rowNode.title).startsWith('Maintenance:'));
    expect(maintenance).toHaveLength(1);
    expect(maintenance[0]!.tags).toContain('issue:issue_pool_weight');
  });

  it("with the switch turned off the whole round gives way and the pool's tool never starts; an unreadable pool leaves no warning either", async () => {
    const closed = await addHeldNode('the closed node');
    stageCycle('c1', [closed], ['coding']);
    putSignal('c1', closed);
    breakPool();
    setConfig({ issue_pool: 'off', issue_pool_weight_limit: 4 });

    const returned = await superworker.conductor.close({ cycle: 'c1', node: closed });
    expect(warningsOf(returned as object)).toEqual([]);
    expect((await graph()).some((rowNode) => String(rowNode.title).startsWith('Maintenance:'))).toBe(false);
    // The main path carries on: settling lands and the line goes out of service.
    expect(returned.status).toBe('inactive');
    expect(returned.holding).toEqual([]);
  });

  it('an unreadable pool: this round does not know and never reads it as 0 — one WARNING, no insert, and close returns as usual', async () => {
    const closed = await addHeldNode('the closed node');
    stageCycle('c1', [closed], ['coding']);
    putSignal('c1', closed);
    breakPool();
    setConfig({ issue_pool_weight_limit: 4 });

    const returned = await superworker.conductor.close({ cycle: 'c1', node: closed });
    const warnings = warningsOf(returned as object);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('plugin issue');
    // The reading is a function of the pool's own tools now, not the output of a command run through
    // `ctx.capture`: the pool reader's refusal is what the host records, and the number stays unknown.
    expect(warnings[0]).toContain('failed to compute "issue_pool_weight"');
    expect((await graph()).some((rowNode) => String(rowNode.title).startsWith('Maintenance:'))).toBe(false);
    // Settling and inserting do not hold each other up: the verdict enters path, the hold is released and the line packs up.
    expect(returned.status).toBe('inactive');
    expect(returned.holding).toEqual([]);
    expect(returned.path[0]).toMatchObject({ node: closed, result: 'completed' });
  });

  it('an absent pool reads as an empty pool: weight 0 sits below the line, so nothing is inserted and no warning comes', async () => {
    const closed = await addHeldNode('the closed node');
    stageCycle('c1', [closed], ['coding']);
    putSignal('c1', closed);
    setConfig({ issue_pool_weight_limit: 4 });

    const returned = await superworker.conductor.close({ cycle: 'c1', node: closed });
    expect(warningsOf(returned as object)).toEqual([]);
    expect((await graph()).some((rowNode) => String(rowNode.title).startsWith('Maintenance:'))).toBe(false);
  });

  it('the repo plugin original is not touched by the tests: however the temp-project copy runs, the original keeps its hash', async () => {
    const originals = readdirSync(REPO_PLUGIN, { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
      .map((entry) => ({
        name: entry,
        bytes: readFileSync(new URL(`../plugins/issue/${entry}`, import.meta.url)),
      }));
    const closed = await addHeldNode('the closed node');
    stageCycle('c1', [closed], ['coding']);
    putSignal('c1', closed);
    seedPool({ p1: row('p1', { severity: 'P1' }), p2: row('p2', { severity: 'P2' }) });
    setConfig({ issue_pool_weight_limit: 4 });
    await superworker.conductor.close({ cycle: 'c1', node: closed });
    for (const file of originals) {
      expect(readFileSync(new URL(`../plugins/issue/${file.name}`, import.meta.url))).toEqual(file.bytes);
    }
  });

  it("the switch is the host's gate alone: this door hands its offer back even when the switch reads off, and asks no knob for the switch at all", async () => {
    const asked: string[] = [];
    const shown = await (offer as (ctx: unknown) => Promise<Record<string, unknown> | null>)({
      cycle: { id: 'c1', tags: ['coding'] },
      nodeId: 'n-1',
      target: { id: 't-1', title: 'the target' },
      dag: { nodes: {} },
      async knob(name: string) {
        asked.push(name);
        return name === 'issue_pool_weight_limit' ? 4 : 'off';
      },
      async reading() {
        return 6;
      },
      nodesWithTag: () => [],
      specPath: (id: string) => `/tmp/${id}/spec.md`,
    });
    // The gate lives in `enabled()` (`src/plugins/host.ts`, walked by this file's switch test above):
    // a plugin asking again would be a second implementation of one rule, with its own tolerance.
    expect(shown).not.toBeNull();
    expect(asked).toEqual(['issue_pool_weight_limit']);
  });

  it("the plugin copy the corpus case replays is this repo's copy, byte for byte: a changed plugin means a re-copy and a regenerated expectation", () => {
    // The case's `input/` used to carry a snapshot from before the pool's bytes were pinned, so the
    // case replayed an implementation that no longer existed and no plugin edit could turn it red.
    // With the copy equal to the repo's own, any plugin change is this test (re-copy) or the corpus
    // case's own green/red (behaviour change, regenerate `expected/`).
    for (const name of ['plugin.json', 'impl.mjs', 'tools/commands.mjs', 'tools/storage.mjs']) {
      // The bytes, not the decoded text: a difference the decoder would have smoothed over (a BOM, a
      // stray CR) is exactly what a copy stops being a copy over.
      const shipped = readFileSync(join(REPO_PLUGIN_DIR, ...name.split('/')));
      const inFixture = readFileSync(join(CORPUS_CASE, 'input', 'plugins', 'issue', ...name.split('/')));
      expect(inFixture.equals(shipped), `${name}: the replayed copy is the shipped one, byte for byte`).toBe(true);
    }
  });
});
