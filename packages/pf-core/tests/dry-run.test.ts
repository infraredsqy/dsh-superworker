import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConductorNamespace } from '../src/conductor';
import { SimulatedExecutor } from '../src/executor';
import { answer } from '../src/words/router';
import type { WordsIO } from '../src/words/types';
import { closeInsertDecl, dispatchBlockDecl, makeLab } from './helpers/plugin-lab';

/**
 * The rehearsal: `--dry-run` on the two words whose effect leaves the records (`settle`, `dispatch`), the
 * engine reads behind them (`settlePreview` / `dispatchPreview`), and the obligation a plugin's timing owes
 * (`offer_preview` / `check_preview`).
 *
 * The lock here is the invariant, not the wording: a rehearsal writes not one record byte, claims nothing and
 * opens nothing; a plugin that ships no preview is named in a WARNING and skipped; and a rehearsal of a call
 * that would be refused says so with the same non-zero code.
 */

const dirs: string[] = [];
const labs: Array<{ cleanup(): void }> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const lab of labs.splice(0)) lab.cleanup();
});

function project(): { root: string; io: WordsIO; executor: SimulatedExecutor } {
  const root = mkdtempSync(join(tmpdir(), 'pf-dry-run-'));
  dirs.push(root);
  const executor = new SimulatedExecutor();
  const io: WordsIO = { root, homeDir: join(root, '_home'), executor, openerAvailable: true };
  return { root, io, executor };
}

async function call(io: WordsIO, argv: readonly string[]): Promise<string> {
  const result = await answer(argv, io);
  expect(result.code, `${argv.join(' ')} answered ${result.code}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

/** A line holding one of two ready nodes, with the layout in place; the held node's id comes back. */
async function station(io: WordsIO): Promise<string> {
  await call(io, ['init']);
  await call(io, ['dag', 'add', 'the first node']);
  await call(io, ['dag', 'add', 'the second node']);
  await call(io, ['cycle', 'start', 'c1', '--force', '--tags', 'coding']);
  return JSON.parse(readFileSync(join(io.root, '.pf', 'state.json'), 'utf8'))
    .cycles.find((cycle: { id: string }) => cycle.id === 'c1').holding[0].id as string;
}

function record(root: string, name: string): Buffer {
  return readFileSync(join(root, '.pf', name));
}

/** The ids on the graph, in on-disk order. */
function graphIds(root: string): string[] {
  return Object.keys(JSON.parse(readFileSync(join(root, '.pf', 'ideas.json'), 'utf8')).nodes);
}

describe('settle --dry-run: the same gates and criteria, not one byte written', () => {
  it('reports the step, the graph mark and the slot it would fill, and the real settle still works afterwards', async () => {
    const { root, io } = project();
    const node = await station(io);
    await call(io, ['handoff', 'c1', node, 'completed', '-s', 'done']);
    const state = record(root, 'state.json');
    const ideas = record(root, 'ideas.json');

    const preview = JSON.parse(await call(io, ['settle', node, '--cycle', 'c1', '--dry-run', '--json']));
    expect(preview.action).toBe('settle');
    expect(preview.dry_run).toBe(true);
    expect(preview.result).toBe('completed');
    expect(preview.graph).toBe('completed');
    // The close would open one slot, and the head of that list is the seam's target.
    expect(preview.target).toBe(graphIds(root).find((id) => id !== node));
    expect(record(root, 'state.json').equals(state)).toBe(true);
    expect(record(root, 'ideas.json').equals(ideas)).toBe(true);
    expect(existsSync(join(root, '.pf', 'meta', 'launch', 'c1'))).toBe(false);

    // The rehearsal claimed nothing and parked nothing: the real settle lands exactly one step.
    const settled = JSON.parse(await call(io, ['settle', node, '--cycle', 'c1', '--json']));
    expect(settled.result).toBe('completed');
    const line = JSON.parse(readFileSync(join(root, '.pf', 'state.json'), 'utf8')).cycles[0];
    expect(line.path.map((step: { node: string }) => step.node)).toEqual([node]);
  });

  it('refuses what the write would refuse: a ticket still pending is nothing to rehearse either', async () => {
    const { root, io } = project();
    const node = await station(io);
    await call(io, ['cycle', 'retry', 'c1', node]); // a pending ticket, no verdict
    const state = record(root, 'state.json');
    const refused = await answer(['settle', node, '--cycle', 'c1', '--dry-run'], io);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('has not handed in a verdict yet');
    expect(record(root, 'state.json').equals(state)).toBe(true);
  });
});

describe('dispatch --dry-run: the same gates, no session and no claim', () => {
  it('names the cell, its material and its route in a process without an opener', async () => {
    const { root, io } = project();
    const node = await station(io);
    const closed: WordsIO = { ...io, openerAvailable: false };
    const state = record(root, 'state.json');

    const text = await call(closed, ['dispatch', 'c1', '--dry-run']);
    expect(text).toContain('dry run: nothing was opened, nothing was written');
    expect(text).toContain('would open');
    expect(text).toContain('prompt.txt');
    expect(text).toContain('not on disk yet');

    const preview = JSON.parse(await call(closed, ['dispatch', 'c1', '--dry-run', '--json']));
    expect(preview.dry_run).toBe(true);
    expect(preview.nodes).toEqual([node]);
    expect(preview.cells[0].material).toBe('to_land');
    expect(record(root, 'state.json').equals(state)).toBe(true);
    // Not one byte of the material landed, and no claim either: the cell is still dispatchable.
    expect(existsSync(join(root, '.pf', 'meta', 'launch', 'c1', node, 'prompt.txt'))).toBe(false);
    expect(existsSync(join(root, '.pf', 'meta', 'launch', 'c1', node, 'started'))).toBe(false);
    expect(JSON.parse((await call(closed, ['plan', '--cycle', 'c1', '--json']))).action).toBe('dispatch');

    // And the real dispatch over the same cell opens it (the rehearsal changed nothing for it).
    await call(io, ['dispatch', 'c1']);
    expect(existsSync(join(root, '.pf', 'meta', 'launch', 'c1', node, 'started'))).toBe(true);
  });
});

describe('the plugin obligation: a timing owes its rehearsal', () => {
  /** A lab plus one line holding a node that has already handed in a ticket. */
  async function settledScene() {
    const lab = makeLab('pf-dry-run-plugin-');
    labs.push(lab);
    await lab.pf.ledger.init();
    const node = await lab.pf.ledger.dag.add({ title: 'the node in hand' });
    lab.cycle('c1', [node.id]);
    const conductor = createConductorNamespace(lab.root, new SimulatedExecutor(), { homeDir: lab.home });
    await conductor.handoff({ cycle: 'c1', node: node.id, status: 'completed', summary: 'done' });
    return { lab, node, conductor };
  }

  it('a close-time plugin without offer_preview() is skipped with one WARNING, and the rehearsal touches nothing', async () => {
    const { lab, node, conductor } = await settledScene();
    lab.plugin('plain', closeInsertDecl(), {
      'impl.mjs': 'export function offer() { return { title: "x", spec_of: () => "s" }; }\n',
    });
    const state = readFileSync(join(lab.root, '.pf', 'state.json'));
    const ideas = readFileSync(join(lab.root, '.pf', 'ideas.json'));
    const preview = await conductor.settlePreview({ cycle: 'c1', node: node.id });
    expect(preview.seam).toEqual([]);
    expect(preview.warnings.join('\n')).toContain('has no offer_preview()');
    expect(readFileSync(join(lab.root, '.pf', 'state.json')).equals(state)).toBe(true);
    expect(readFileSync(join(lab.root, '.pf', 'ideas.json')).equals(ideas)).toBe(true);
  });

  it('the preview is what the seam reports; the real door is not asked during a rehearsal', async () => {
    const { lab, node, conductor } = await settledScene();
    lab.plugin('both', closeInsertDecl(), {
      'impl.mjs': [
        'export function offer() { return { title: "the real one", spec_of: () => "s" }; }',
        'export function offer_preview() { return { title: "the previewed one", spec_of: () => "s", why: "because" }; }',
      ].join('\n'),
    });
    const preview = await conductor.settlePreview({ cycle: 'c1', node: node.id });
    expect(preview.seam.map((offer) => offer.title)).toEqual(['the previewed one']);
    expect(preview.warnings).toEqual([]);
    // Nothing was inserted: the graph is still the one node the scene started with.
    expect(graphIds(lab.root).length).toBe(1);
  });

  it('a dispatch-time gate is rehearsed the same way: the block is reported, not thrown', async () => {
    const lab = makeLab('pf-dry-run-gate-');
    labs.push(lab);
    await lab.pf.ledger.init();
    const node = await lab.pf.ledger.dag.add({ title: 'the cell' });
    lab.cycle('c1', [node.id]);
    const conductor = createConductorNamespace(lab.root, new SimulatedExecutor(), { homeDir: lab.home });
    lab.plugin('gate', dispatchBlockDecl(), {
      'impl.mjs': 'export function check() { return "blocked for real"; }\n',
    });
    const withoutPreview = await conductor.dispatchPreview({ cycle: 'c1', node: node.id });
    expect(withoutPreview.blocked).toEqual([]);
    expect(withoutPreview.warnings.join('\n')).toContain('has no check_preview()');

    lab.plugin('gate-preview', dispatchBlockDecl(), {
      'impl.mjs': [
        'export function check() { return "blocked for real"; }',
        'export function check_preview() { return "would be blocked: the gate is armed"; }',
      ].join('\n'),
    });
    const previewed = await conductor.dispatchPreview({ cycle: 'c1', node: node.id });
    expect(previewed.blocked).toEqual(['would be blocked: the gate is armed']);
  });

  it('doctor lists the gap as a notice and keeps the plugin check green', async () => {
    const { lab, conductor } = await settledScene();
    lab.plugin('plain', closeInsertDecl(), {
      'impl.mjs': 'export function offer() { return null; }\n',
    });
    const report = await conductor.doctor();
    const plugins = report.checks.find((check) => check.name === 'plugins')!;
    expect(plugins.ok).toBe(true);
    expect(plugins.detail).toContain('rehearsal (a --dry-run skips these');
    expect(plugins.detail).toContain('no offer_preview()');
  });
});