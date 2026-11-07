import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * The record side of doctor: records complete, references not dangling, nothing in a cycle.
 * Each of the three checks names its own kind of fault; a new project with no record directory is
 * not red, it only says that init should be run once. The plugin side has its own checks (see the
 * plugin-* cases), so only the record half is read here.
 */

let root: string;
let superworker: ReturnType<typeof open>;

function write(path: string, body: unknown): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-doctor-'));
  superworker = open(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  superworker = undefined!;
});

describe('records complete', () => {
  it('a project with no .superworker/ is not red: this check only says to run init once', async () => {
    const report = await superworker.conductor.doctor();
    const records = report.checks.find((check) => check.name === 'records')!;
    expect(records.ok).toBe(true);
    expect(records.detail).toContain('there is no .superworker here yet');
    expect(report.ok).toBe(true);
  });

  it('an init-ed project has the whole four-part layout: this check is green', async () => {
    await superworker.ledger.init();
    const records = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'records')!;
    expect(records.ok).toBe(true);
    expect(records.detail).toContain('.gitignore');
    expect(records.detail).toContain('all in place');
  });

  it('when one part of the layout is missing, that part is named', async () => {
    await superworker.ledger.init();
    rmSync(join(root, '.superworker', 'AGENTS.md'));
    const records = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'records')!;
    expect(records.ok).toBe(false);
    expect(records.detail).toContain('.superworker/AGENTS.md is missing');
  });
});

describe('references do not dangle, nothing forms a cycle', () => {
  it('an empty graph is green: 0 nodes, no cycle and no dangling reference', async () => {
    await superworker.ledger.init();
    const report = await superworker.conductor.doctor();
    expect(report.checks.find((check) => check.name === 'graph')).toMatchObject({ ok: true });
    expect(report.checks.find((check) => check.name === 'cycles')).toMatchObject({
      ok: true,
      detail: 'no cycles yet',
    });
  });

  it('a dangling dependency turns the graph check red and names that node', async () => {
    await superworker.ledger.init();
    const node = await superworker.ledger.dag.add({ title: 'A' });
    const ideas = JSON.parse(
      readFileSync(join(root, '.superworker', 'ideas.json'), 'utf8'),
    ) as { nodes: Record<string, { dependencies: string[]; updated_at: string }> };
    ideas.nodes[node.id]!.dependencies = ['99999999-9999-4999-8999-999999999999'];
    write('.superworker/ideas.json', ideas);
    const graph = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'graph')!;
    expect(graph.ok).toBe(false);
    expect(graph.detail).toContain('99999999-9999-4999-8999-999999999999');
  });

  it('a cycle turns the graph check red and the cycle path is in the detail', async () => {
    await superworker.ledger.init();
    const a = await superworker.ledger.dag.add({ title: 'A' });
    const b = await superworker.ledger.dag.add({ title: 'B' });
    await superworker.ledger.dag.link(b.id, a.id);
    const ideas = JSON.parse(
      readFileSync(join(root, '.superworker', 'ideas.json'), 'utf8'),
    ) as { nodes: Record<string, { dependencies: string[] }> };
    ideas.nodes[a.id]!.dependencies = [b.id];
    write('.superworker/ideas.json', ideas);
    const graph = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'graph')!;
    expect(graph.ok).toBe(false);
    expect(graph.detail.toLowerCase()).toContain('cycle');
  });

  it('a node a cycle holds is not on the graph: the cycles check names that cycle and that id', async () => {
    await superworker.ledger.init();
    write('.superworker/state.json', {
      cycles: [
        {
          id: 'main',
          title: 'one line',
          status: 'active',
          holding: [{ id: '88888888-8888-4888-8888-888888888888', since: '2026-01-01T00:00:00Z' }],
          path: [],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const cycles = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'cycles')!;
    expect(cycles.ok).toBe(false);
    expect(cycles.detail).toContain('cycle "main" holds 88888888-8888-4888-8888-888888888888');
    expect(cycles.detail).toContain('not on the graph');
  });
});
