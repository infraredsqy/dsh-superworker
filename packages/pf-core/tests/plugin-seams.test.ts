import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPfError } from '../src/errors';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { pfPaths } from '../src/paths';
import { declarationProblems, loadPlugins, usable } from '../src/plugins/registry';
import { closeInsertDecl, dispatchBlockDecl, makeLab } from './helpers/plugin-lab';

/**
 * End to end on two actions: close — the settlement (the verdict goes into path, the hold is
 * dropped, the three node states) and the close insertion seam (the inserted content becomes part
 * of the graph: node, spec.md, edges, tags) each land their own part in the same close; dispatch —
 * the preparation (prompt landing spot, run doc) and the gate seam (all reasons listed, nothing
 * touched), so only a green light hands a request carrying the real prompt to the injected executor.
 * Plugin directories, knob layer files and graph operations all land in a temporary project root.
 */

const SPEC_A = '# Greeter spec\n\nInserted by the greeter plugin at the close.\n';
const SPEC_B = '# Second spec\n';

function greeterFiles(spec: string): Record<string, string> {
  return {
    'impl.mjs': [
      'const SPEC = ' + JSON.stringify(spec) + ';',
      'export function offer() {',
      "  return { title: 'Greeter: say hello', tags: ['demo'], spec_of: () => SPEC,",
      "          why: 'greeter fires at every close', note: 'fixed offer' };",
      '}',
    ].join('\n'),
  };
}

/**
 * Lay down a terminal handoff signal (the on-disk shape of the write-side handoff verb; this scene
 * is staged without the public verb).
 */
function putSignal(root: string, cycle: string, node: string, status = 'completed'): void {
  const path = join(root, '.pf', 'signals', cycle, `${node}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { cycle, node, status, summary: 'done', outputs: {}, timestamp: '2026-01-01T00:00:03Z' },
      null,
      2,
    ),
    'utf8',
  );
}

async function seededLab(prefix: string, options: { readonly ticket?: boolean } = {}) {
  const lab = makeLab(prefix);
  await lab.pf.ledger.init();
  const nodeId = (await lab.pf.ledger.dag.add({ title: 'held node' })).id;
  lab.cycle('c1', [nodeId]);
  // Closing settles against a ticket that has said its result; the dispatch faces (blocked, green)
  // want a node that has not reported yet.
  if (options.ticket !== false) putSignal(lab.root, 'c1', nodeId);
  return { lab, nodeId };
}

describe('close: settlement and the insertion seam each land their own part', () => {
  it('close lands the node, writes the spec and links the edge; the verdict enters path and the hold drops; the cycle record comes back', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      lab.plugin('greeter', closeInsertDecl({ name: undefined }), greeterFiles(SPEC_A));
      const returned = await lab.pf.conductor.close({ cycle: 'c1', node: nodeId });
      expect(returned.id).toBe('c1');

      const graph = await lab.pf.ledger.dag.list();
      const inserted = graph.find((row) => row.title === 'Greeter: say hello');
      expect(inserted).toBeDefined();
      expect(inserted!.tags).toEqual(['demo']);
      const record = await lab.pf.ledger.dag.get(inserted!.id);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('todo');
      expect(record!.mode).toBe('auto');
      // The description cell holds the spec text as a JSON literal (the on-disk byte convention for one argv encoding step).
      expect(record!.description).toBe(JSON.stringify(SPEC_A));
      expect(record!.dependencies).toEqual([nodeId]);
      expect(readFileSync(join(pfPaths(lab.root).nodesDir, inserted!.id, 'spec.md'), 'utf8')).toBe(SPEC_A);
      // Settlement and insertion in one close: the verdict enters path, the closed node lands completed, and the
      // freed slot is claimed for the inserted node — it precedes the next pick in the ranking, so the open hand
      // fills with it rather than with the work that was going to run.
      expect(returned.holding.map((item) => item.id)).toEqual([inserted!.id]);
      expect(returned.path).toHaveLength(1);
      expect(returned.path[0]).toMatchObject({ node: nodeId, result: 'completed' });
      expect((await lab.pf.ledger.dag.get(nodeId))!.status).toBe('completed');
    } finally {
      lab.cleanup();
    }
  });

  it('two sources are siblings, not a chain: both hang behind the closed node and neither depends on the other', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      lab.plugin('greeter', closeInsertDecl(), greeterFiles(SPEC_A));
      lab.plugin('second', closeInsertDecl(), {
        'impl.mjs': [
          'const SPEC = ' + JSON.stringify(SPEC_B) + ';',
          'export function offer() {',
          "  return { title: 'Second node', tags: [], spec_of: () => SPEC };",
          '}',
        ].join('\n'),
      });
      await lab.pf.conductor.close({ cycle: 'c1', node: nodeId });
      const graph = await lab.pf.ledger.dag.list();
      const firstRow = graph.find((row) => row.title === 'Greeter: say hello')!;
      const secondRow = graph.find((row) => row.title === 'Second node')!;
      // list rows do not carry edges: the full record comes from get.
      const first = await lab.pf.ledger.dag.get(firstRow.id);
      const second = await lab.pf.ledger.dag.get(secondRow.id);
      expect(first!.dependencies).toEqual([nodeId]);
      expect(second!.dependencies).toEqual([nodeId]);
      expect(first!.dependencies.includes(secondRow.id)).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('one source blowing up only costs itself: the other enters the graph as usual and close still returns', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      lab.plugin('thrower', closeInsertDecl(), {
        'impl.mjs': 'export function offer() { return { title: "x", spec_of: () => { throw new Error("no text"); } }; }\n',
      });
      lab.plugin('greeter', closeInsertDecl(), greeterFiles(SPEC_A));
      const returned = await lab.pf.conductor.close({ cycle: 'c1', node: nodeId });
      expect(returned.id).toBe('c1');
      const graph = await lab.pf.ledger.dag.list();
      expect(graph.find((row) => row.title === 'Greeter: say hello')).toBeDefined();
      expect(graph.find((row) => row.title === 'x')).toBeUndefined();
    } finally {
      lab.cleanup();
    }
  });

  it('an illegal cell is rejected: a timing outside the closed set is a declaration problem, so the close never asks it', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      // A cell the runtime has no gate for is not in the vocabulary: the declaration is red, not silently idle.
      lab.plugin('picker', closeInsertDecl({ timing: 'pick' }), greeterFiles(SPEC_A));
      const scan = await loadPlugins(join(lab.root, 'plugins'));
      const folder = scan.folders.find((row) => row.name === 'picker')!;
      expect(declarationProblems(folder).join('\n')).toContain('timing "pick" is not one of');
      expect(usable(folder)).toBe(false);
      // A rejected declaration takes no part in the close, and the close settles as usual.
      const returned = await lab.pf.conductor.close({ cycle: 'c1', node: nodeId });
      expect(returned.id).toBe('c1');
      const graph = await lab.pf.ledger.dag.list();
      expect(graph.find((row) => row.title === 'Greeter: say hello')).toBeUndefined();
      expect((await lab.pf.ledger.dag.get(nodeId))!.status).toBe('completed');
    } finally {
      lab.cleanup();
    }
  });

  it('the switch turned off: the plugin takes no part this round (a project-layer off beats the declaration\'s on)', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      lab.plugin('greeter', closeInsertDecl(), greeterFiles(SPEC_A));
      // closeInsertDecl's switch is called plugin_on: a project-layer off beats the declaration's on.
      writeFileSync(join(lab.root, '.pf', 'config.json'), JSON.stringify({ plugin_on: 'off' }), 'utf8');
      await lab.pf.conductor.close({ cycle: 'c1', node: nodeId });
      const graph = await lab.pf.ledger.dag.list();
      expect(graph.find((row) => row.title === 'Greeter: say hello')).toBeUndefined();
    } finally {
      lab.cleanup();
    }
  });

  it('no plugin directory: close settles as usual (verdict into path, hold dropped) and inserts nothing', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      const graphBefore = await lab.pf.ledger.dag.list();
      const returned = await lab.pf.conductor.close({ cycle: 'c1', node: nodeId });
      expect(returned.id).toBe('c1');
      expect((await lab.pf.ledger.dag.list()).length).toBe(graphBefore.length);
      expect(returned.holding).toEqual([]);
      expect(returned.path[0]).toMatchObject({ node: nodeId, result: 'completed' });
    } finally {
      lab.cleanup();
    }
  });
});

describe('blocked before dispatch: a block carries its reason, and only a green light reaches the executor', () => {
  it('one gate saying no means no: PfError(dispatch_blocked) with the reason carried as is', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      lab.plugin('gate', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { return "tests are red, fix them first"; }\n',
      });
      let caught: unknown;
      try {
        await lab.pf.conductor.dispatch({ cycle: 'c1', node: nodeId });
      } catch (error) {
        caught = error;
      }
      expect(isPfError(caught, 'dispatch_blocked')).toBe(true);
      expect((caught as Error).message).toContain('tests are red, fix them first');
    } finally {
      lab.cleanup();
    }
  });

  it('two gates each say their line: every reason is listed, none dropped', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      lab.plugin('gateA', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { return "reason alpha"; }\n',
      });
      lab.plugin('gateB', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { return "reason beta"; }\n',
      });
      let caught: unknown;
      try {
        await lab.pf.conductor.dispatch({ cycle: 'c1', node: nodeId });
      } catch (error) {
        caught = error;
      }
      const message = (caught as Error).message;
      expect(isPfError(caught, 'dispatch_blocked')).toBe(true);
      expect(message).toContain('reason alpha');
      expect(message).toContain('reason beta');
    } finally {
      lab.cleanup();
    }
  });

  it('the gate turned off: green light, the preparation lands, the request goes to the injected executor and the receipt comes back as is', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-', { ticket: false });
    try {
      lab.plugin('gate', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { return "never with the gate off"; }\n',
      });
      writeFileSync(join(lab.root, '.pf', 'config.json'), JSON.stringify({ gate_on: 'off' }), 'utf8');
      const sim = new SimulatedExecutor();
      const pf = open(lab.root, { executor: sim });
      const receipt = await pf.conductor.dispatch({ cycle: 'c1', node: nodeId });
      expect(receipt.action).toBe('opened');
      expect(receipt.session).toEqual({ sessionId: 'sess-1' });
      // The request carries the cycle and node identity, the role and that one line of the prompt;
      // once the session is open its marker is on disk.
      expect(sim.dispatched).toEqual([
        { cycle: 'c1', node: nodeId, role: 'execute', prompt: `/pf-conduct ${nodeId} [pipeline]\n` },
      ]);
      expect(readFileSync(
        join(lab.root, '.pf', 'meta', 'launch', 'c1', nodeId, 'started'),
        'utf8',
      )).toContain('started');
    } finally {
      lab.cleanup();
    }
  });

  it('green light but no injected executor: it stops on the spot and names the single injection point', async () => {
    const { lab, nodeId } = await seededLab('pf-plugin-seam-');
    try {
      let caught: unknown;
      try {
        await lab.pf.conductor.dispatch({ cycle: 'c1', node: nodeId });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toContain('needs an injected executor');
    } finally {
      lab.cleanup();
    }
  });
});
