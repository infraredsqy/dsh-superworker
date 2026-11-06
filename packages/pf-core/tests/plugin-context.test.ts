import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createContext } from '../src/plugins/context';
import { readGraphSnapshot } from '../src/graph';
import { loadPlugins } from '../src/plugins/registry';
import { pfPaths } from '../src/paths';
import { open } from '../src/open';
import { makeLab } from './helpers/plugin-lab';

/**
 * The capability surface of the host context: the whole knob chain
 * (node -> cycle -> project -> global -> factory default, the narrower layer winning), the two
 * reading paths (ticket and claimed source; booleans and strings are not read as a number, and a
 * source is computed once per round), open nodes by tag, this process's routing for capture/run
 * (the keep_name rule, and what run answers about whether a command ran), specPath's spelling of
 * the layout, and the identity of the spot.
 */

/** A test plugin with the full set of capabilities: two knobs, a claimed source, a ticket reading, two commands. */
function labPlugin(lab: ReturnType<typeof makeLab>, name: string): void {
  lab.plugin(name, {
    summary: 'capability probe',
    enable_knob: `${name}_on`,
    timing: 'close',
    action: 'insert',
    knobs: {
      [`${name}_on`]: { kind: 'switch', default: 'off', summary: 'whether the probe acts' },
      probe_limit: { kind: 'number', default: null, summary: 'a number the probe reads' },
    },
    sources: { pool: { by: 'pool_weight' } },
    readings: {
      pool_size: { source: 'pool' },
      measured: { source: 'ticket', ask: 'the measured number' },
    },
    commands: { hello: { summary: 'says hello' }, plain: { summary: 'wordless', keep_name: false } },
  }, {
    'impl.mjs': [
      'let poolCount = 0;',
      'export function offer() { return null; }',
      'export function pool_weight(ctx) { poolCount += 1; return 3.5; }',
      'export function readPoolCalls() { return poolCount; }',
      'export function main(argv, ctx) {',
      "  if (argv.includes('boom')) throw new Error('command boom');",
      "  if (argv.includes('quiet')) return undefined;",
      "  return 'hi ' + argv.join(' ');",
      '}',
    ].join('\n'),
  });
}

function scratch(): { dir(): string; sweep(): void } {
  const roots: string[] = [];
  return {
    dir() {
      const dir = mkdtempSync(join(tmpdir(), 'pf-ctx-scratch-'));
      roots.push(dir);
      return dir;
    },
    sweep() {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    },
  };
}

function stateText(root: string): string {
  return readFileSync(join(root, '.pf', 'state.json'), 'utf8');
}

describe('knobs: the whole chain read at once, the narrower layer winning', () => {
  it('node > cycle > project > global > factory default; null when nobody on the chain says and there is no default', async () => {
    const lab = makeLab('pf-plugin-ctx-');
    const scratchDirs = scratch();
    try {
      await lab.pf.ledger.init();
      labPlugin(lab, 'probe');
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const paths = pfPaths(lab.root);

      // The global layer (walled into <root>/_home) and the project layer.
      mkdirSync(join(lab.home, '.pf'), { recursive: true });
      writeFileSync(join(lab.home, '.pf', 'config.json'), JSON.stringify({ probe_limit: 1 }), 'utf8');
      writeFileSync(paths.configJson, JSON.stringify({ probe_limit: 2, probe_on: 'on' }), 'utf8');

      // The cycle layer (the policies slot in state.json) and the node layer.
      const nodeA = (await lab.pf.ledger.dag.add({ title: 'held' })).id;
      lab.cycle('c1', [nodeA]);
      const state = JSON.parse(stateText(lab.root)) as { cycles: Array<Record<string, unknown>> };
      state.cycles[0]!.policies = { probe_limit: 3 };
      writeFileSync(join(lab.root, '.pf', 'state.json'), JSON.stringify(state, null, 2), 'utf8');
      mkdirSync(join(paths.nodesDir, nodeA), { recursive: true });
      writeFileSync(join(paths.nodesDir, nodeA, 'config.json'), JSON.stringify({ probe_limit: 4 }), 'utf8');

      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        cycle: state.cycles[0]!,
        nodeId: nodeA,
        dag: await readGraphSnapshot(paths),
      });
      expect(await ctx.knob('probe_limit')).toBe(4); // the node layer is the narrowest
      expect(await ctx.knob('probe_on')).toBe('on'); // the project layer; nothing up the chain overrides it

      const nodeB = (await lab.pf.ledger.dag.add({ title: 'plain' })).id;
      const ctxB = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        cycle: state.cycles[0]!,
        nodeId: nodeB,
        dag: await readGraphSnapshot(paths),
      });
      expect(await ctxB.knob('probe_limit')).toBe(3); // no node layer: falls back to the cycle layer

      const ctxWide = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      expect(await ctxWide.knob('probe_limit')).toBe(2); // no cycle or node named: only project and global are left

      const emptyHome = scratchDirs.dir();
      const ctxHomeless = createContext({
        root: lab.root,
        folders,
        homeDir: emptyHome,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      expect(await ctxHomeless.knob('probe_limit')).toBe(2); // the machine-wide layer is absent: only project is left

      // A brand-new project (factory defaults only): a knob without a value reads null, a switch
      // reads its factory word.
      const bare = scratchDirs.dir();
      await open(bare).ledger.init();
      const ctxBare = createContext({
        root: bare,
        folders,
        homeDir: emptyHome,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctxBare.knob('probe_limit')).toBeNull();
      expect(await ctxBare.knob('probe_on')).toBe('off');
      expect(await ctxBare.knob('')).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
      scratchDirs.sweep();
    }
  });
});

describe('readings: one path through the ticket, one through the claimed source', () => {
  it('a ticket number comes from outputs.reading of the handoff; booleans and strings are not guessed into a number', async () => {
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      labPlugin(lab, 'probe');
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        sig: { outputs: { reading: { measured: 12.5, flag: true, words: 'n/a' } } },
        dag: { nodes: {} },
      });
      expect(await ctx.reading('measured')).toBe(12.5);
      expect(await ctx.reading('flag')).toBeNull();
      expect(await ctx.reading('words')).toBeNull();
      expect(await ctx.reading('absent')).toBeNull();
      expect(await ctx.reading('')).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it('a claimed source is computed on the spot by the named function; once per round (a second ask hits the cache)', async () => {
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      labPlugin(lab, 'probe');
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctx.reading('pool_size')).toBe(3.5);
      expect(await ctx.reading('pool_size')).toBe(3.5);
      const implPath = join(lab.root, 'plugins', 'probe', 'impl.mjs');
      const impl = (await import(pathToFileURL(implPath).href)) as { readPoolCalls(): number };
      expect(impl.readPoolCalls()).toBe(1);
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it('the source function name is missing from the implementation: a warning instead, and the number reads as absent', async () => {
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      lab.plugin('probe', {
        summary: 'missing by',
        knobs: {},
        sources: { pool: { by: 'no_such_function' } },
        readings: { pool_size: { source: 'pool' } },
      }, { 'impl.mjs': 'export function offer() { return null; }\n' });
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctx.reading('pool_size')).toBeNull();
      expect(warnings.join('\n')).toContain('has no no_such_function()');
    } finally {
      lab.cleanup();
    }
  });
});

describe('nodes by tag, command routing, the spec path and identity', () => {
  it('nodesWithTag returns only the nodes still open (todo) that carry the tag, sorted', async () => {
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      const a = (await lab.pf.ledger.dag.add({ title: 'a', tags: ['debt'] })).id;
      const b = (await lab.pf.ledger.dag.add({ title: 'b', tags: ['debt', 'x'] })).id;
      const c = (await lab.pf.ledger.dag.add({ title: 'c', tags: ['other'] })).id;
      await lab.pf.ledger.dag.setStatus(b, 'completed');
      const ctx = createContext({
        root: lab.root,
        folders: [],
        homeDir: lab.home,
        warnings: [],
        dag: await readGraphSnapshot(pfPaths(lab.root)),
      });
      expect(ctx.nodesWithTag('debt')).toEqual([a]); // b is completed, c does not carry the tag
      expect(ctx.nodesWithTag('other')).toEqual([c]);
      expect(ctx.nodesWithTag('nothing')).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it("capture/run route only the plugin's own words; keep_name decides whether the word comes along; a throw becomes a warning", async () => {
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      labPlugin(lab, 'probe');
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctx.capture(['hello', 'arg'])).toBe('hi hello arg');
      expect(await ctx.capture(['plain', 'arg'])).toBe('hi arg'); // keep_name=false: the word does not travel
      expect(await ctx.capture(['nobody', 'arg'])).toBeNull(); // a word nobody claims
      expect(await ctx.capture(['list', 'x'])).toBeNull(); // a word the core keeps never routes to a plugin
      expect(await ctx.capture([])).toBeNull();
      await expect(ctx.run(['hello', 'effect'])).resolves.toBe(true);
      expect(await ctx.capture(['hello', 'boom'])).toBeNull();
      expect(warnings.join('\n')).toContain('failed to run "hello"');
      expect(warnings.join('\n')).toContain('command boom');
    } finally {
      lab.cleanup();
    }
  });

  it('run tells a command that ran from one that did not: a throw, a word nobody routes and a core word all read false, no text reads true', async () => {
    // The effect may be the whole point of a command, so "answered no text" and "did not run" must not
    // be the same reading: a plugin that acts on the answer needs the failure, the effect alone does not.
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      labPlugin(lab, 'probe');
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctx.run(['hello', 'effect'])).toBe(true);
      expect(await ctx.run(['hello', 'quiet'])).toBe(true); // it ran, it just answered no text at all
      expect(await ctx.capture(['hello', 'quiet'])).toBeNull(); // the text is still absent where text is what is asked for
      expect(await ctx.run(['hello', 'boom'])).toBe(false); // it threw
      expect(await ctx.run(['nobody', 'arg'])).toBe(false); // a word nobody claims
      expect(await ctx.run(['list', 'x'])).toBe(false); // a word the core keeps never routes to a plugin
      expect(await ctx.run([])).toBe(false);
      expect(warnings.join('\n')).toContain('failed to run "hello"');
    } finally {
      lab.cleanup();
    }
  });

  it("specPath speaks this tree's layout; the three identity fields come along as they are", async () => {    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      const node = (await lab.pf.ledger.dag.add({ title: 'held' })).id;
      lab.cycle('c1', [node]);
      const paths = pfPaths(lab.root);
      const cycle = (JSON.parse(stateText(lab.root)) as { cycles: Array<Record<string, unknown>> }).cycles[0]!;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders: [],
        homeDir: lab.home,
        warnings,
        cycle,
        nodeId: node,
        dag: await readGraphSnapshot(paths),
      });
      expect(ctx.specPath(node)).toBe(join(paths.nodesDir, node, 'spec.md').split('\\').join('/'));
      // The location is handed out before the file exists: add sets up the directory, and spec.md is left for
      // whoever writes the requirements.
      expect(existsSync(join(paths.nodesDir, node))).toBe(true);
      expect(existsSync(join(paths.nodesDir, node, 'spec.md'))).toBe(false);
      expect(ctx.root).toBe(lab.root);
      expect(ctx.cycle).toEqual(cycle);
      expect(ctx.nodeId).toBe(node);
      expect(ctx.sig).toBeNull();
      expect(ctx.target).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });
});

describe('one routing, two readers: capture / run and conductor.pluginCommand read the same answer', () => {
  it('a word whose implementation has no main() reads as "it did not run" on both paths, naming the same cause', async () => {
    // The routing used to exist twice — once for capture / run, once for the conductor's plugin word — and
    // the two explained "it did not run" differently. It is one function now, answering ran / text / code /
    // error, so both readers see the same four cells and neither invents its own wording for a failure.
    const lab = makeLab('pf-plugin-ctx-');
    try {
      await lab.pf.ledger.init();
      const folder = join(lab.root, 'plugins', 'doorless');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify({
        summary: 'declares a word and ships no main()',
        commands: { talk: { summary: 'the word nobody can run' } },
      }), 'utf8');
      writeFileSync(join(folder, 'impl.mjs'), 'export function offer() { return null; }\n', 'utf8');
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctx.capture(['talk'])).toBeNull();
      expect(await ctx.run(['talk'])).toBe(false);
      const routed = await lab.pf.conductor.pluginCommand({ word: 'talk', argv: [] });
      // The same four cells on both paths: the word belongs to the one plugin, it did not run, it answered
      // no text and no exit code, and the failure sentence says the one thing that is wrong with it.
      expect(routed.plugin).toBe('doorless');
      expect(routed.ran).toBe(false);
      expect(routed.text).toBeNull();
      expect(routed.code).toBeNull();
      expect(routed.error).toContain('has no main()');
      expect(warnings.join('\n')).toContain('has no main()');
      expect(warnings.join('\n')).toContain('"talk"');
    } finally {
      lab.cleanup();
    }
  });
});
