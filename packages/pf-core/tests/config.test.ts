import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptedLayers,
  assertDefault,
  BUILTIN_KNOBS,
  createConfigNamespace,
  knobSpecs,
  resolveConfig,
  worktreeModeOf,
  type ConfigLayer,
  type ConfigNamespace,
  type KnobSpec,
} from '../src/config';
import { isPfError, type PfError } from '../src/errors';
import { open } from '../src/open';
import { nodeConfigPath, pfPaths } from '../src/paths';
import { declarationProblems, declaredKnobSpecs, loadPlugins } from '../src/plugins/registry';

/**
 * A hook that runs just before the ledger lock's body, so one test can land another writer in the
 * window a locked write is meant to close. It is null in every other test, and the wrapper only
 * passes through to the real lock.
 */
let beforeLockBody: (() => Promise<void>) | null = null;

vi.mock('../src/ledgerlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ledgerlock')>();
  return {
    ...actual,
    withLedgerLock: async (
      paths: Parameters<typeof actual.withLedgerLock>[0],
      body: () => Promise<unknown>,
      options?: Parameters<typeof actual.withLedgerLock>[2],
    ) => {
      const hook = beforeLockBody;
      beforeLockBody = null;
      if (hook !== null) await hook();
      return actual.withLedgerLock(paths, body, options);
    },
  };
});

/**
 * The invariants of the settings chain: five-layer resolution (the narrower wins, every layer
 * traceable to its source), the kinds of value and their refusals, the layer a write names (there is
 * no default layer), where each layer's file lands and what a write keeps, the directory a verb
 * works in, which layers each knob accepts, the declaration gate on defaults, and how tight the read
 * side is (only a layer the caller names wrongly and a file that cannot be parsed stop a reading).
 * Everything happens in a temp dir, with home always walled into a temp project root (`<root>/_home`),
 * so the real machine's `~/.pf` keeps every byte.
 *
 * Plugin knobs come in through the merging point of the settings list: either the table a caller read for
 * itself (`declaredKnobs`, the seam the whole-file cases below use) or the reader the handle carries, which
 * goes to the project's own plugin folder when the verb asks (`declaredKnobsOf`). That second seam pins the
 * rules "the list of a handle opened by `open` carries the declared knobs, and the project layer and the line
 * layer written under them are read back", alongside "built-ins take the two wide layers, declared knobs take
 * the whole chain, a declaration may narrow its own, the engine's own declarations carry a non-null default
 * (a plugin cell may state none)".
 */

/** A stand-in for a plugin declaration: one number on the whole chain, one narrowed to the project layer, one switch, one with no factory value at all. */
const DECLARED: Record<string, KnobSpec> = {
  proj_depth: { kind: 'number', default: 6, summary: 'declared knob that walks the whole chain' },
  narrow_limit: { kind: 'number', layers: ['project'], default: 1, summary: 'declared knob narrowed to the project layer' },
  sandbox_on: { kind: 'switch', default: 'on', summary: 'declared switch knob' },
  sandbox_number: { kind: 'number', default: null, summary: 'declared number with no factory value (the plugin door)' },
};

interface Project {
  root: string;
  home: string;
  config: ConfigNamespace;
}

/** Temp project root + init gate + home walled inside that root; declared knobs merged in as needed. */
async function makeProject(declared?: Record<string, KnobSpec>): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), 'pf-config-'));
  const home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  await open(root).ledger.init();
  const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: declared });
  return { root, home, config };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Lay a minimal cycle down in state.json (the target for cycle-layer writes and reads). */
function seedCycle(root: string, cycleId: string): void {
  const record = {
    id: cycleId,
    title: `cycle ${cycleId}`,
    status: 'active',
    holding: [],
    path: [],
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  };
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({ cycles: [record] }, null, 2), 'utf8');
}

/** Lay lines down in state.json with their claim lists (`holding`): a node read takes its line layer from here. */
function seedHoldingCycles(root: string, cycles: Array<{ id: string; holding: string[] }>): void {
  const records = cycles.map((cycle) => ({
    id: cycle.id,
    title: `cycle ${cycle.id}`,
    status: 'active',
    holding: cycle.holding.map((id) => ({ id, since: '2020-01-01T00:00:00Z' })),
    path: [],
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  }));
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({ cycles: records }, null, 2), 'utf8');
}

/** A node's own settings layer, written by hand: the internal whole-chain entry (`resolveConfig`) reads the file as it is, without consulting the graph. */
function seedNodeLayer(root: string, nodeId: string, values: Record<string, unknown>): void {
  const dir = join(root, '.pf', 'nodes', nodeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(values, null, 2), 'utf8');
}

/** The same lines, with `holding` written in the old bare-id-string shape: both on-disk shapes read as a claim list. */
function seedBareHoldingCycles(root: string, cycles: Array<{ id: string; holding: string[] }>): void {
  const records = cycles.map((cycle) => ({
    id: cycle.id,
    title: `cycle ${cycle.id}`,
    status: 'active',
    holding: [...cycle.holding],
    path: [],
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  }));
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({ cycles: records }, null, 2), 'utf8');
}

/** The project layer file verbatim (LF folded), used to pin the write shape. */
function projectConfigText(root: string): string {
  return readFileSync(join(root, '.pf', 'config.json'), 'utf8').replace(/\r\n/g, '\n');
}

/** The machine-wide layer file verbatim (LF folded). */
function homeConfigText(home: string): string {
  return readFileSync(join(home, '.pf', 'config.json'), 'utf8').replace(/\r\n/g, '\n');
}

function seedProjectConfig(root: string, text: string): void {
  writeFileSync(join(root, '.pf', 'config.json'), text, 'utf8');
}

/** Take the refusal of one operation (a PfError); letting it through means this test fails on its own. */
async function refusalOf(run: () => Promise<unknown>): Promise<PfError> {
  try {
    await run();
  } catch (error) {
    if (isPfError(error)) return error;
    throw error;
  }
  throw new Error('an operation expected to be refused went through');
}

/** The same, for one synchronous call (the id-to-path guard). */
function thrownBy(run: () => unknown): PfError {
  try {
    run();
  } catch (error) {
    if (isPfError(error)) return error;
    throw error;
  }
  throw new Error('a call expected to be refused went through');
}

/** The missing layer, in the shape the type wants: the refusal is a runtime rule, not only a type rule. */
const NO_LAYER = undefined as unknown as ConfigLayer;

describe('the knob list and its layers', () => {
  it('three built-in knobs, all of them taking the two wide layers', () => {
    expect(Object.keys(BUILTIN_KNOBS).sort()).toEqual([
      'max_agents',
      'test_tier',
      'worktree_mode',
    ]);
    expect(acceptedLayers(BUILTIN_KNOBS['max_agents']!)).toEqual(['project', 'global']);
    expect(acceptedLayers(BUILTIN_KNOBS['test_tier']!)).toEqual(['project', 'global']);
    expect(acceptedLayers(BUILTIN_KNOBS['worktree_mode']!)).toEqual(['project', 'global']);
  });

  it('every built-in declaration carries a factory value: a literal, or a function of the project root', () => {
    expect(BUILTIN_KNOBS['max_agents']!.default).toBe(3);
    expect(BUILTIN_KNOBS['test_tier']!.default).toBe('full');
    // Every cell carries one and none of them is null: both are the engine's own declaration rule. How
    // the worktree mode's per-project default is spelled is not pinned here — the two behavioural tests
    // further down pin what it answers (fork with a `.git`, off without one).
    for (const [name, cell] of Object.entries(BUILTIN_KNOBS)) {
      expect('default' in cell, name).toBe(true);
      expect(cell.default, name).not.toBeUndefined();
      expect(cell.default, name).not.toBeNull();
    }
  });

  it('the merging point: a declared knob joins all four layers, a narrowed one follows its declaration, a built-in name keeps its own cell', () => {
    const specs = knobSpecs(DECLARED);
    expect(acceptedLayers(specs['proj_depth']!)).toEqual(['node', 'cycle', 'project', 'global']);
    expect(acceptedLayers(specs['narrow_limit']!)).toEqual(['project']);
    // A built-in name ignores a declaration: bring in a declaration of the same name and the cell
    // stays the core's own.
    const hijack = knobSpecs({ max_agents: { kind: 'word', default: 'x', summary: 'a declaration that tried' } });
    expect(hijack['max_agents']!.kind).toBe('integer');
    expect(acceptedLayers(hijack['max_agents']!)).toEqual(['project', 'global']);
  });

  it('a declaration that leaves the default out is refused when the list is merged, and the refusal names the setting', () => {
    const noDefault = { kind: 'number', summary: 'nothing in force' } as unknown as KnobSpec;
    expect(() => knobSpecs({ no_default: noDefault })).toThrow(TypeError);
    expect(() => knobSpecs({ no_default: noDefault })).toThrow(/no_default/);
    expect(() => knobSpecs({ no_default: noDefault })).toThrow(/default/);
  });

  it('a default of the wrong kind: the engine gate refuses it, while a declared cell is left out of the list instead of stopping every read', () => {
    const wrong: KnobSpec = { kind: 'integer', default: 'three', summary: 'a word in an integer cell' };
    // The engine's own declarations are gated strictly, and the refusal names the setting.
    expect(() => assertDefault('wrong_default', wrong)).toThrow(TypeError);
    expect(() => assertDefault('wrong_default', wrong)).toThrow(/wrong_default/);
    expect(() => assertDefault('wrong_default', wrong)).toThrow(/has a default that is not a integer/);
    // A declared cell is not put through that gate: a default that cannot be honoured keeps the cell
    // out of the merged list (it is not coerced into a value, and it does not stop the other knobs), so
    // the knob reads as unknown rather than breaking the settings surface.
    const merged = knobSpecs({ wrong_default: wrong });
    expect(() => knobSpecs({ wrong_default: wrong })).not.toThrow();
    expect(Object.hasOwn(merged, 'wrong_default')).toBe(false);
    expect(Object.keys(merged)).toContain('max_agents');
  });

  it('a plugin.json knob whose default is not of its kind is dropped with a doctor line: no settings verb stops over it', async () => {
    const { root, home } = await makeProject();
    try {
      // A real plugin folder: the plausible hand-written mistake is a switch written as a boolean, and
      // a number cell in the same shape, with one sound knob beside them.
      const folder = join(root, 'plugins', 'weird');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify({
        name: 'weird',
        summary: 'a declaration with two broken defaults',
        timing: 'close',
        action: 'insert',
        enable_knob: 'weird_switch',
        knobs: {
          weird_switch: { kind: 'switch', default: true, summary: 'a switch written as a boolean' },
          weird_number: { kind: 'number', default: false, summary: 'a number written as a boolean' },
          sound_knob: { kind: 'number', default: 2, summary: 'a sound knob' },
        },
      }, null, 2), 'utf8');
      writeFileSync(join(folder, 'impl.mjs'), 'export function offer() { return null; }\n', 'utf8');

      const { folders } = await loadPlugins(join(root, 'plugins'));
      const declared = declaredKnobSpecs(folders);
      // The broken cells stay out of the spec list; the sound one enters as it is.
      expect(Object.hasOwn(declared, 'weird_switch')).toBe(false);
      expect(Object.hasOwn(declared, 'weird_number')).toBe(false);
      expect(declared['sound_knob']?.default).toBe(2);
      // Doctor is where the plugin is told about it, naming the plugin and the knob.
      const problems = declarationProblems(folders[0]!);
      expect(problems).toContainEqual(expect.stringContaining('plugin "weird"'));
      expect(problems).toContainEqual(expect.stringContaining('knob "weird_switch"'));
      expect(problems).toContainEqual(expect.stringContaining('has a default that is not a switch'));
      expect(problems).toContainEqual(expect.stringContaining('knob "weird_number"'));

      // The whole settings surface answers: a broken plugin declaration does not stop a read, and the
      // dropped names are the ordinary unknown-key refusal (never a value read off the prototype).
      const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: declared });
      const listed = await config.list();
      expect(listed['sound_knob']).toEqual({ value: 2, source: 'builtin' });
      expect(Object.hasOwn(listed, 'weird_switch')).toBe(false);
      expect(listed['max_agents']).toEqual({ value: 3, source: 'builtin' });
      expect((await refusalOf(() => config.get('weird_switch'))).code).toBe('unknown_key');
      // The same cell reaching the merge point directly is dropped as well: no throw on that path either.
      const viaMerge = createConfigNamespace(root, {
        homeDir: home,
        declaredKnobs: { weird_switch: { kind: 'switch', default: true, summary: 'broken' } },
      });
      expect(Object.hasOwn(await viaMerge.list(), 'weird_switch')).toBe(false);
      expect((await refusalOf(() => viaMerge.get('weird_switch'))).code).toBe('unknown_key');
    } finally {
      cleanup(root);
    }
  });

  it('a null default is refused for the engine and says a default is required and may not be null; the plugin door keeps its meaning', () => {
    const nulled: KnobSpec = { kind: 'number', default: null, summary: 'no factory value' };
    expect(() => assertDefault('nulled', nulled)).toThrow(TypeError);
    expect(() => assertDefault('nulled', nulled)).toThrow(/nulled/);
    expect(() => assertDefault('nulled', nulled)).toThrow(/a default is required and may not be null/);
    // A plugin declaration is not put through that gate: a cell without a factory value keeps its own
    // "this line was never set up" meaning, so the merged list still reads it as no value.
    expect(() => assertDefault('nulled', nulled, 'plugin')).not.toThrow();
    expect(knobSpecs(DECLARED)['sandbox_number']!.default).toBeNull();
  });
});

describe('the resolution chain: the narrower wins, layer by layer', () => {
  it('four layers all state one name, the narrowest takes effect and its source travels with it; unset them one by one and the next layer shows', async () => {
    const { root, home, config } = await makeProject(DECLARED);
    try {
      seedCycle(root, 'c1');
      await config.set('proj_depth', 5, { global: true });
      await config.set('proj_depth', 4, { project: true });
      await config.set('proj_depth', 2, { cycle: 'c1' });
      seedNodeLayer(root, 'node-x', { proj_depth: 7 });

      const full = await resolveConfig(root, { cycle: 'c1', node: 'node-x', homeDir: home, declaredKnobs: DECLARED });
      expect(full['proj_depth']).toEqual({ value: 7, source: 'node' });

      const line = await resolveConfig(root, { cycle: 'c1', homeDir: home, declaredKnobs: DECLARED });
      expect(line['proj_depth']).toEqual({ value: 2, source: 'cycle' });

      await config.unset('proj_depth', { cycle: 'c1' });
      const project = await resolveConfig(root, { homeDir: home, declaredKnobs: DECLARED });
      expect(project['proj_depth']).toEqual({ value: 4, source: 'project' });

      await config.unset('proj_depth', { project: true });
      const machine = await resolveConfig(root, { homeDir: home, declaredKnobs: DECLARED });
      expect(machine['proj_depth']).toEqual({ value: 5, source: 'global' });

      await config.unset('proj_depth', { global: true });
      const factory = await resolveConfig(root, { homeDir: home, declaredKnobs: DECLARED });
      // Nobody on the chain says anything, so the declaration's default is in force and its source
      // says exactly that.
      expect(factory['proj_depth']).toEqual({ value: 6, source: 'builtin' });
    } finally {
      cleanup(root);
    }
  });

  it('get hands back the value with the layer it came from; a layer named reads the chain up to that layer only', async () => {
    const { root, config } = await makeProject();
    try {
      await config.set('max_agents', 4, { project: true });
      await config.set('max_agents', 5, { global: true });
      expect(await config.get('max_agents')).toEqual({ value: 4, source: 'project' });
      // Up to the machine layer: the machine's own value, which the project layer would otherwise hide.
      expect(await config.get('max_agents', { global: true })).toEqual({ value: 5, source: 'global' });
      expect(await config.get('max_agents', { project: true })).toEqual({ value: 4, source: 'project' });
      await config.unset('max_agents', { project: true });
      expect(await config.get('max_agents')).toEqual({ value: 5, source: 'global' });
      await config.unset('max_agents', { global: true });
      expect(await config.get('max_agents')).toEqual({ value: 3, source: 'builtin' });
    } finally {
      cleanup(root);
    }
  });

  it('a node read takes the line holding the node as its line layer: no holder skips it, one holder is read through, two holders are refused', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const node = (await open(root).ledger.dag.add({ title: '丙' })).id;
      await config.set('proj_depth', 4, { project: true });
      // No line holds the node: there is no line-layer value for it, so the project layer answers.
      expect(await config.get('proj_depth', { node })).toEqual({ value: 4, source: 'project' });
      // One line holds it: the reading passes through that line's own layer.
      seedHoldingCycles(root, [{ id: 'c1', holding: [node] }]);
      await config.set('proj_depth', 2, { cycle: 'c1' });
      expect(await config.get('proj_depth', { node })).toEqual({ value: 2, source: 'cycle' });
      // The node's own layer still sits on top of the line that holds it.
      seedNodeLayer(root, node, { proj_depth: 7 });
      expect(await config.get('proj_depth', { node })).toEqual({ value: 7, source: 'node' });
      // Two lines claiming one node is a record inconsistency: refuse and name both, never guess.
      seedHoldingCycles(root, [
        { id: 'c1', holding: [node] },
        { id: 'c2', holding: [node] },
      ]);
      const refusal = await refusalOf(() => config.get('proj_depth', { node }));
      expect(refusal.code).toBe('ambiguous_holder');
      expect(refusal.message).toContain('c1');
      expect(refusal.message).toContain('c2');
      expect((await refusalOf(() => config.list({ node }))).code).toBe('ambiguous_holder');
    } finally {
      cleanup(root);
    }
  });

  it('a line holding the node as a bare id string is a holder too: the old on-disk shape reaches the line layer', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const node = (await open(root).ledger.dag.add({ title: '戊' })).id;
      await config.set('proj_depth', 4, { project: true });
      // `holding: ["<node id>"]` is the old spelling of the claim list; it counts as a claim, so the
      // line layer is read instead of being silently skipped.
      seedBareHoldingCycles(root, [{ id: 'c1', holding: [node] }]);
      await config.set('proj_depth', 2, { cycle: 'c1' });
      expect(await config.get('proj_depth', { node })).toEqual({ value: 2, source: 'cycle' });
      // Two lines holding it in that shape are just as inconsistent as two canonical ones.
      seedBareHoldingCycles(root, [
        { id: 'c1', holding: [node] },
        { id: 'c2', holding: [node] },
      ]);
      const refusal = await refusalOf(() => config.list({ node }));
      expect(refusal.code).toBe('ambiguous_holder');
      expect(refusal.message).toContain('c1');
      expect(refusal.message).toContain('c2');
    } finally {
      cleanup(root);
    }
  });

  it('the two narrow layers enter a reading only when they are named: the wide reading does not see them', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const node = (await open(root).ledger.dag.add({ title: '丁' })).id;
      seedCycle(root, 'c1');
      seedNodeLayer(root, node, { proj_depth: 7 });
      await config.set('proj_depth', 2, { cycle: 'c1' });
      // No layer named: the two wide layers are read, and neither narrow one shows.
      expect(await config.get('proj_depth')).toEqual({ value: 6, source: 'builtin' });
      expect(await config.get('proj_depth', { cycle: 'c1' })).toEqual({ value: 2, source: 'cycle' });
      // The node layer shows once it is named: a node on the graph with a file of its own.
      expect(await config.get('proj_depth', { node })).toEqual({ value: 7, source: 'node' });
    } finally {
      cleanup(root);
    }
  });
});

describe('kinds and refusals', () => {
  it('integer bounds: 0, negatives, decimals, booleans and words are all refused; the string "4" passes the same gate and lands as 4', async () => {
    const { root, config } = await makeProject();
    try {
      for (const bad of [0, -2, 4.5, true, 'three', '']) {
        const refusal = await refusalOf(() => config.set('max_agents', bad as number, { project: true }));
        expect(refusal.code).toBe('invalid_value');
        expect(refusal.message).toContain('max_agents');
      }
      await config.set('max_agents', '4', { project: true });
      expect(projectConfigText(root)).toBe('{\n  "max_agents": 4\n}');
    } finally {
      cleanup(root);
    }
  });

  it('number spellings: a 1_000 written for an integer comes in as 1000, while 0x10 is refused for a number knob', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      await config.set('max_agents', '1_000', { project: true });
      expect(await config.get('max_agents')).toEqual({ value: 1000, source: 'project' });
      expect(projectConfigText(root)).toBe('{\n  "max_agents": 1000\n}');
      const hexRefusal = await refusalOf(() => config.set('proj_depth', '0x10', { project: true }));
      expect(hexRefusal.code).toBe('invalid_value');
      expect(hexRefusal.message).toContain('wants a positive number');
    } finally {
      cleanup(root);
    }
  });

  it('word bounds: a word outside the vocabulary is refused, and the refusal names the vocabulary', async () => {
    const { root, config } = await makeProject();
    try {
      const refusal = await refusalOf(() => config.set('test_tier', 'ful', { project: true }));
      expect(refusal.code).toBe('invalid_value');
      expect(refusal.message).toContain('full');
      expect(refusal.message).toContain('minimal');
      const offRefusal = await refusalOf(() => config.set('test_tier', 'off', { project: true }));
      expect(offRefusal.code).toBe('invalid_value');
      await config.set('test_tier', 'minimal', { project: true });
      expect(projectConfigText(root)).toBe('{\n  "test_tier": "minimal"\n}');
    } finally {
      cleanup(root);
    }
  });

  it('switch: off counts as a value and gets written, a word outside the vocabulary is refused', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      await config.set('sandbox_on', 'off', { project: true });
      expect(projectConfigText(root)).toBe('{\n  "sandbox_on": "off"\n}');
      expect((await refusalOf(() => config.set('sandbox_on', 'maybe', { project: true }))).code).toBe('invalid_value');
    } finally {
      cleanup(root);
    }
  });

  it('a declared number takes decimals and decimal strings, while negatives and booleans are refused', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      await config.set('proj_depth', '12.5', { project: true });
      expect(projectConfigText(root)).toBe('{\n  "proj_depth": 12.5\n}');
      expect((await refusalOf(() => config.set('proj_depth', -2, { project: true }))).code).toBe('invalid_value');
      expect((await refusalOf(() => config.set('proj_depth', true, { project: true }))).code).toBe('invalid_value');
    } finally {
      cleanup(root);
    }
  });

  it('the positivity of a numeric knob is one gate on both sides: a hand-written 0 or -1 on disk is skipped, not read as a value in force', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      // The read side stays silent about a value that does not move: that layer states nothing and the
      // next one (here the declaration's default) shows through — exactly what `set` refusing it means.
      // Before this gate was one, the reading took -1 and 0 as values in force while `set` refused them.
      seedProjectConfig(root, '{\n  "proj_depth": -1,\n  "narrow_limit": 0\n}');
      expect(await config.get('proj_depth')).toEqual({ value: 6, source: 'builtin' });
      expect(await config.get('narrow_limit')).toEqual({ value: 1, source: 'builtin' });
      // A positive value in the very same file is read as before: the skip is the kind's boundary, not
      // the whole layer file being given up on.
      seedProjectConfig(root, '{\n  "proj_depth": 4,\n  "narrow_limit": 0\n}');
      expect(await config.get('proj_depth')).toEqual({ value: 4, source: 'project' });
    } finally {
      cleanup(root);
    }
  });

  it('a refused write lands not one byte: the file stays as it was', async () => {
    const { root, config } = await makeProject();
    try {
      const before = projectConfigText(root);
      await refusalOf(() => config.set('max_agents', 0, { project: true }));
      expect(projectConfigText(root)).toBe(before);
    } finally {
      cleanup(root);
    }
  });
});

describe('the layer a write names: one, and never defaulted', () => {
  it('set and unset with no layer named are refused, and nothing is written', async () => {
    const { root, config } = await makeProject();
    try {
      const before = projectConfigText(root);
      const setRefusal = await config.set('test_tier', 'minimal', NO_LAYER).then(
        () => {
          throw new Error('a write with no layer named went through');
        },
        (error: unknown) => error as Error,
      );
      expect(setRefusal).toBeInstanceOf(TypeError);
      expect(setRefusal.message).toContain('needs the layer it writes: project / global / cycle / node');
      const unsetRefusal = await config.unset('test_tier', NO_LAYER).then(
        () => {
          throw new Error('an unset with no layer named went through');
        },
        (error: unknown) => error as Error,
      );
      expect(unsetRefusal).toBeInstanceOf(TypeError);
      expect(projectConfigText(root)).toBe(before);
    } finally {
      cleanup(root);
    }
  });

  it('a layer spelling that names two layers has no answer for where to land, so it refuses on the spot', async () => {
    const { root, config } = await makeProject();
    try {
      await expect(config.set('max_agents', 4, { global: true, project: true })).rejects.toThrow(TypeError);
      await expect(config.set('max_agents', 4, { global: true, cycle: 'c1' })).rejects.toThrow(TypeError);
    } finally {
      cleanup(root);
    }
  });

  it('a built-in setting takes the wide two layers only: the cycle and node layers are refused, and the refusal names the layers it takes', async () => {
    const { root, config } = await makeProject();
    try {
      seedCycle(root, 'c1');
      const cycleRefusal = await refusalOf(() => config.set('max_agents', 4, { cycle: 'c1' }));
      expect(cycleRefusal.code).toBe('layer_not_allowed');
      expect(cycleRefusal.message).toContain('project, global');
      const nodeRefusal = await refusalOf(() => config.set('max_agents', 4, { node: 'node-x' }));
      expect(nodeRefusal.code).toBe('layer_not_allowed');
      expect(nodeRefusal.message).toContain('project, global');
      // The read side meets the same wall and says it in its own half of the one sentence: the code, the
      // layer list and the key are the same text on both sides, and only the "nothing was …" cell differs.
      const readRefusal = await refusalOf(() => config.get('max_agents', { cycle: 'c1' }));
      expect(readRefusal.code).toBe('layer_not_allowed');
      expect(readRefusal.message).toContain('it takes: project, global');
      expect(readRefusal.message).toContain('nothing was read');
      expect(cycleRefusal.message).toContain('nothing was written');
    } finally {
      cleanup(root);
    }
  });

  it('a knob a declaration narrowed: a write beyond its layers is refused, a declared layer is let through', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const refusal = await refusalOf(() => config.set('narrow_limit', 5, { global: true }));
      expect(refusal.code).toBe('layer_not_allowed');
      expect(refusal.message).toContain('it takes: project');
      await config.set('narrow_limit', 5, { project: true });
      expect(projectConfigText(root)).toContain('"narrow_limit": 5');
    } finally {
      cleanup(root);
    }
  });

  it('a name not on the list: get / set / unset all refuse, and the refusal names the keys that can be configured', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      for (const run of [
        () => config.set('nope', 1, { project: true }),
        () => config.get('nope'),
        () => config.unset('nope', { project: true }),
      ]) {
        const refusal = await refusalOf(run);
        expect(refusal.code).toBe('unknown_key');
        expect(refusal.message).toContain('max_agents');
      }
      // The names every object inherits are not on the list either: the merged table owns the knobs, so
      // `constructor` is an unknown name like any other — never a function handed back as a value.
      for (const inherited of ['constructor', '__proto__', 'toString']) {
        const refusal = await refusalOf(() => config.get(inherited));
        expect(refusal.code, inherited).toBe('unknown_key');
        expect(refusal.message, inherited).toContain('max_agents');
        expect((await refusalOf(() => config.set(inherited, 1, { project: true }))).code, inherited)
          .toBe('unknown_key');
        expect((await refusalOf(() => config.unset(inherited, { project: true }))).code, inherited)
          .toBe('unknown_key');
      }
    } finally {
      cleanup(root);
    }
  });
});

describe('where a write lands: one layer at a time', () => {
  it('writing the machine layer leaves the project alone; each layer keeps its own value and source', async () => {
    const { root, home, config } = await makeProject();
    try {
      await config.set('max_agents', 4, { project: true });
      await config.set('max_agents', 5, { global: true });
      expect(homeConfigText(home)).toBe('{\n  "max_agents": 5\n}');
      expect(projectConfigText(root)).toBe('{\n  "max_agents": 4\n}');
      expect(await config.get('max_agents')).toEqual({ value: 4, source: 'project' });
    } finally {
      cleanup(root);
    }
  });

  it('the line layer rides on the line record: the value lands in the policies slot, updated_at takes the seconds shape, the rest stays as it is', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      seedCycle(root, 'c1');
      await config.set('proj_depth', 3, { cycle: 'c1' });
      const state = JSON.parse(readFileSync(join(root, '.pf', 'state.json'), 'utf8')) as {
        cycles: Array<{ id: string; title: string; policies?: Record<string, unknown>; updated_at: string }>;
      };
      expect(state.cycles[0]!.policies).toEqual({ proj_depth: 3 });
      expect(state.cycles[0]!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(state.cycles[0]!.updated_at).not.toBe('2020-01-01T00:00:00Z');
      expect(state.cycles[0]!.id).toBe('c1');
      expect(state.cycles[0]!.title).toBe('cycle c1');
      await config.unset('proj_depth', { cycle: 'c1' });
      const after = JSON.parse(readFileSync(join(root, '.pf', 'state.json'), 'utf8')) as {
        cycles: Array<{ policies?: Record<string, unknown> }>;
      };
      // Unset means unset: the emptied policies slot stays on the record, and the default is not
      // written down.
      expect(after.cycles[0]!.policies).toEqual({});
    } finally {
      cleanup(root);
    }
  });

  it('the node layer lands in nodes/<id>/config.json; a read resolves its id exactly like a write, while a known id with no file falls through', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const node = (await open(root).ledger.dag.add({ title: '甲' })).id;
      await config.set('proj_depth', 8, { node });
      const written = readFileSync(join(root, '.pf', 'nodes', node, 'config.json'), 'utf8');
      expect(written).toContain('"proj_depth": 8');
      expect(await config.get('proj_depth', { node })).toEqual({ value: 8, source: 'node' });

      // A node on the graph without a file of its own is the ordinary no-file state: that layer states
      // nothing, it is not an error, and the reading goes on to the layer below.
      const bare = (await open(root).ledger.dag.add({ title: '乙' })).id;
      await config.set('proj_depth', 4, { project: true });
      expect(await config.get('proj_depth', { node: bare })).toEqual({ value: 4, source: 'project' });

      // An id that is not on the graph is refused by both sides: the read path resolves its target the
      // way the write path does, so a mistyped id never answers with a wider layer's value.
      const unknownNode = '00000000-0000-4000-8000-000000000000';
      expect((await refusalOf(() => config.set('proj_depth', 1, { node: unknownNode }))).code).toBe('node_not_found');
      expect((await refusalOf(() => config.get('proj_depth', { node: unknownNode }))).code).toBe('node_not_found');
      expect((await refusalOf(() => config.list({ node: unknownNode }))).code).toBe('node_not_found');
    } finally {
      cleanup(root);
    }
  });

  it('unset at the node layer takes the value off that file alone: the reading falls to the layer below, and no wider layer changes', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const node = (await open(root).ledger.dag.add({ title: '甲' })).id;
      await config.set('proj_depth', 4, { project: true });
      await config.set('proj_depth', 8, { node });
      expect(await config.get('proj_depth', { node })).toEqual({ value: 8, source: 'node' });

      await config.unset('proj_depth', { node });
      // Unset means unset on that one file: the layer is emptied and not rewritten with a value, and the
      // emptied table stays (the shape the line layer keeps as well).
      expect(JSON.parse(readFileSync(join(root, '.pf', 'nodes', node, 'config.json'), 'utf8'))).toEqual({});
      // The narrow layer states nothing any more, so the value that counts is the layer below it.
      expect(await config.get('proj_depth', { node })).toEqual({ value: 4, source: 'project' });
      expect((await config.list({ node }))['proj_depth']).toEqual({ value: 4, source: 'project' });
      // An unset at { node } is not an unset at the wide layers: the project file keeps its value.
      expect(projectConfigText(root)).toContain('"proj_depth": 4');
    } finally {
      cleanup(root);
    }
  });

  it('an id that is not one directory name is refused before it becomes a path, and an id the graph does not own is no node whatever its name', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      await config.set('proj_depth', 4, { project: true });
      // `..` joins one directory above `nodes/<id>/`, where the project layer's own file sits: reading
      // it as a node layer answered with project data stamped `source: 'node'`.
      for (const bad of ['..', '.', '../..', 'a/b', 'a\\b']) {
        expect((await refusalOf(() => config.get('proj_depth', { node: bad }))).code, bad).toBe('node_not_found');
        expect((await refusalOf(() => config.list({ node: bad }))).code, bad).toBe('node_not_found');
        expect((await refusalOf(() => config.set('proj_depth', 1, { node: bad }))).code, bad).toBe('node_not_found');
      }
      // Nothing was written to the project layer on the way.
      expect(projectConfigText(root)).toContain('"proj_depth": 4');
      // The guard sits at the id-to-path boundary, so the boundary itself refuses those spellings and an
      // empty id, which joins to the `nodes/` directory rather than to one node's directory.
      for (const bad of ['..', '.', 'a/b', 'a\\b', '']) {
        expect(thrownBy(() => nodeConfigPath(pfPaths(root), bad)).code, bad).toBe('node_not_found');
      }
      // An ordinary id still lands where the layout says.
      expect(nodeConfigPath(pfPaths(root), 'df5129ce')).toBe(join(root, '.pf', 'nodes', 'df5129ce', 'config.json'));
      // The names every object inherits are not nodes: the graph owns an id or it does not, and none of
      // these three is on it. A membership test that walked the prototype counted them, so a write
      // minted `.pf/nodes/<name>/` for a node the graph had never heard of and a read answered from a
      // wider layer. Refused now on both sides, and the graph record is not touched on the way.
      const ideasPath = join(root, '.pf', 'ideas.json');
      const ideasBefore = existsSync(ideasPath) ? readFileSync(ideasPath, 'utf8') : null;
      for (const inherited of ['constructor', '__proto__', 'toString']) {
        expect((await refusalOf(() => config.get('proj_depth', { node: inherited }))).code, inherited)
          .toBe('node_not_found');
        expect((await refusalOf(() => config.list({ node: inherited }))).code, inherited)
          .toBe('node_not_found');
        expect((await refusalOf(() => config.set('proj_depth', 1, { node: inherited }))).code, inherited)
          .toBe('node_not_found');
        expect(existsSync(join(root, '.pf', 'nodes', inherited)), inherited).toBe(false);
      }
      expect(existsSync(ideasPath), 'the graph record is not minted by a refused pointer').toBe(ideasBefore !== null);
      expect(existsSync(ideasPath) ? readFileSync(ideasPath, 'utf8') : null).toBe(ideasBefore);
    } finally {
      cleanup(root);
    }
  });

  it('a graph that really carries one of those names is a node like any other: the gate asks what the table owns', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      await config.set('proj_depth', 4, { project: true });
      // A hand-written graph holding an own `constructor` node: a blacklist of suspicious names would
      // refuse it, while the table does own it — the question is ownership, not the spelling.
      writeFileSync(
        join(root, '.pf', 'ideas.json'),
        '{"nodes": {"constructor": {"title": "x", "dependencies": []}}}',
        'utf8',
      );
      expect(await config.get('proj_depth', { node: 'constructor' })).toEqual({ value: 4, source: 'project' });
    } finally {
      cleanup(root);
    }
  });

  it('a write to a name the graph owns lands on the node layer even though every object inherits that name', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      // The same hand-written graph, now on the write side: refusing a node by the spelling of its id
      // would make a genuine node unwritable, so the write asks the table the one ownership question.
      writeFileSync(
        join(root, '.pf', 'ideas.json'),
        '{"nodes": {"constructor": {"title": "x", "dependencies": []}}}',
        'utf8',
      );
      const graph = readFileSync(join(root, '.pf', 'ideas.json'), 'utf8');
      await config.set('proj_depth', 9, { node: 'constructor' });
      // The write is the node layer's ordinary landing: one file under nodes/<id>/, and no wider layer.
      expect(readFileSync(join(root, '.pf', 'nodes', 'constructor', 'config.json'), 'utf8'))
        .toContain('"proj_depth": 9');
      expect(await config.get('proj_depth', { node: 'constructor' })).toEqual({ value: 9, source: 'node' });
      // No wider layer was made on the way: the project file init lays down carries nothing of this key.
      const projectFile = join(root, '.pf', 'config.json');
      expect(existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : '').not.toContain('proj_depth');
      // The graph record is read, not rewritten on the way.
      expect(readFileSync(join(root, '.pf', 'ideas.json'), 'utf8')).toBe(graph);
      // The names the graph does not own are still refused on the write side: ownership is the question,
      // not the spelling.
      for (const name of ['__proto__', 'toString']) {
        expect((await refusalOf(() => config.set('proj_depth', 1, { node: name }))).code, name)
          .toBe('node_not_found');
      }
    } finally {
      cleanup(root);
    }
  });

  it('a node layer write holds the record lock and looks the node up inside it: a removal landing in the window does not get its directory back', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const pf = open(root);
      const node = (await pf.ledger.dag.add({ title: '乙' })).id;
      const dir = join(root, '.pf', 'nodes', node);
      // The racing writer: it runs after the write's existence check and before its write lands.
      beforeLockBody = async () => {
        await pf.ledger.dag.remove(node);
      };
      const refusal = await refusalOf(() => config.set('proj_depth', 4, { node }));
      expect(refusal.code).toBe('node_not_found');
      // The deletion stands: no settings file, and no node directory, was put back for it.
      expect(existsSync(join(dir, 'config.json'))).toBe(false);
      expect(existsSync(dir)).toBe(false);
      expect(beforeLockBody).toBeNull();
    } finally {
      beforeLockBody = null;
      cleanup(root);
    }
  });

  it('a cycle id that is not on the record: both writes and reads refuse', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      seedCycle(root, 'c1');
      expect((await refusalOf(() => config.set('proj_depth', 1, { cycle: 'nope' }))).code).toBe('cycle_not_found');
      expect((await refusalOf(() => config.unset('proj_depth', { cycle: 'nope' }))).code).toBe('cycle_not_found');
      expect((await refusalOf(() => config.list({ cycle: 'nope' }))).code).toBe('cycle_not_found');
      expect((await refusalOf(() => config.get('proj_depth', { cycle: 'nope' }))).code).toBe('cycle_not_found');
    } finally {
      cleanup(root);
    }
  });

  it('unset down to an already empty layer: the file is rewritten as an empty object', async () => {
    const { root, config } = await makeProject();
    try {
      await config.unset('max_agents', { project: true });
      // The same bytes init lands for its empty object: `jsonBytes` formatting, no trailing newline.
      expect(projectConfigText(root)).toBe('{}');
    } finally {
      cleanup(root);
    }
  });
});

describe('list: every setting with its value and source', () => {
  it('an untouched chain lists every declared setting with the factory value and the builtin source', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      const listed = await config.list();
      expect(listed['max_agents']).toEqual({ value: 3, source: 'builtin' });
      expect(listed['test_tier']).toEqual({ value: 'full', source: 'builtin' });
      expect(listed['worktree_mode']).toEqual({ value: 'off', source: 'builtin' });
      expect(listed['sandbox_number']).toEqual({ value: null, source: 'builtin' });
      // One entry per key of the merged list, no more and no fewer.
      expect(Object.keys(listed).sort()).toEqual(Object.keys(knobSpecs(DECLARED)).sort());
    } finally {
      cleanup(root);
    }
  });

  it('list and get speak with the same mouth: each entry of the list is exactly what get answers', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      await config.set('test_tier', 'minimal', { project: true });
      const listed = await config.list();
      expect(listed['test_tier']).toEqual(await config.get('test_tier'));
    } finally {
      cleanup(root);
    }
  });

  it('a machine-layer value shows through the project-level list, and naming a layer stops the list there', async () => {
    const { root, home, config } = await makeProject();
    try {
      await config.set('max_agents', 9, { global: true });
      await config.set('max_agents', 4, { project: true });
      expect((await config.list())['max_agents']).toEqual({ value: 4, source: 'project' });
      expect((await config.list({ global: true }))['max_agents']).toEqual({ value: 9, source: 'global' });
      expect((await config.list({ project: true }))['max_agents']).toEqual({ value: 4, source: 'project' });
      expect(homeConfigText(home)).toContain('"max_agents": 9');
    } finally {
      cleanup(root);
    }
  });

  it('the cycle layer puts the line own values on top; a name the file does not know stays out of the reading', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      seedCycle(root, 'c1');
      await config.set('proj_depth', 2, { cycle: 'c1' });
      expect((await config.list({ cycle: 'c1' }))['proj_depth']).toEqual({ value: 2, source: 'cycle' });
      seedProjectConfig(root, '{"someone_elses": 1, "max_agents": 2}');
      const listed = await config.list();
      expect(listed['max_agents']).toEqual({ value: 2, source: 'project' });
      expect('someone_elses' in listed).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

describe('the source stamp and factory defaults', () => {
  it('an empty chain reports factory defaults throughout; write one layer and the source changes with it', async () => {
    const { root, home, config } = await makeProject(DECLARED);
    try {
      const fresh = await resolveConfig(root, { homeDir: home, declaredKnobs: DECLARED });
      expect(fresh['max_agents']).toEqual({ value: 3, source: 'builtin' });
      expect(fresh['test_tier']).toEqual({ value: 'full', source: 'builtin' });
      // There is no .git under the temp root: the conditional default of worktree_mode lands on off.
      expect(fresh['worktree_mode']).toEqual({ value: 'off', source: 'builtin' });
      expect(fresh['sandbox_on']).toEqual({ value: 'on', source: 'builtin' });
      expect(fresh['sandbox_number']).toEqual({ value: null, source: 'builtin' });

      await config.set('max_agents', 4, { project: true });
      const stated = await resolveConfig(root, { homeDir: home, declaredKnobs: DECLARED });
      expect(stated['max_agents']).toEqual({ value: 4, source: 'project' });
      expect(stated['test_tier']).toEqual({ value: 'full', source: 'builtin' });
    } finally {
      cleanup(root);
    }
  });

  it('the default of worktree_mode follows the project: fork with a .git, off without one', async () => {
    const { root, config } = await makeProject();
    try {
      expect(await config.get('worktree_mode')).toEqual({ value: 'off', source: 'builtin' });
      mkdirSync(join(root, '.git'));
      expect(await config.get('worktree_mode')).toEqual({ value: 'fork', source: 'builtin' });
      rmSync(join(root, '.git'), { recursive: true });
      expect(await config.get('worktree_mode')).toEqual({ value: 'off', source: 'builtin' });
    } finally {
      cleanup(root);
    }
  });

  it('the mode read off the chain: off / fork come back as they are, a mode this engine does not have is refused', async () => {
    const { root, home } = await makeProject();
    try {
      expect(await worktreeModeOf(root, { homeDir: home })).toBe('off');
      // The factory default is worked out per project, so a `.git` flips the mode by itself.
      mkdirSync(join(root, '.git'));
      expect(await worktreeModeOf(root, { homeDir: home })).toBe('fork');
      // A mode stated on the chain wins over the factory value and is handed back as it is.
      seedProjectConfig(root, '{"worktree_mode": "off"}');
      expect(await worktreeModeOf(root, { homeDir: home })).toBe('off');

      seedProjectConfig(root, '{"worktree_mode": "reuse"}');
      const refusal = await refusalOf(() => worktreeModeOf(root, { homeDir: home }));
      expect(refusal.code).toBe('worktree_mode_unsupported');
      expect(refusal.message).toContain('off');
      expect(refusal.message).toContain('fork');
    } finally {
      cleanup(root);
    }
  });
});

describe('how tight the read is: only a wrong layer and an unreadable file stop it', () => {
  it('a value on disk that is not of its kind is silent: the next layer, or the declaration default, is what counts', async () => {
    const { root, config } = await makeProject();
    try {
      seedProjectConfig(root, '{"max_agents": "three"}');
      expect(await config.get('max_agents')).toEqual({ value: 3, source: 'builtin' });
      seedProjectConfig(root, '{"max_agents": 4.0}');
      expect(await config.get('max_agents')).toEqual({ value: 3, source: 'builtin' });
      seedProjectConfig(root, '{"test_tier": "nonsense", "max_agents": 4}');
      expect(await config.get('test_tier')).toEqual({ value: 'full', source: 'builtin' });
      expect((await config.list())['max_agents']).toEqual({ value: 4, source: 'project' });
      // A number written as a string still reads: the gate is the same on both sides.
      seedProjectConfig(root, '{"max_agents": "3"}');
      expect(await config.get('max_agents')).toEqual({ value: 3, source: 'project' });
    } finally {
      cleanup(root);
    }
  });

  it('a known name sitting in a layer the knob does not take is silent as well: the narrower layer does not apply', async () => {
    const { root, home, config } = await makeProject(DECLARED);
    try {
      // A declaration narrowed to the project layer is not a global-layer setting: written into the
      // machine's file it simply does not apply.
      mkdirSync(join(home, '.pf'), { recursive: true });
      writeFileSync(join(home, '.pf', 'config.json'), JSON.stringify({ narrow_limit: 7 }, null, 2));
      expect(await config.get('narrow_limit')).toEqual({ value: 1, source: 'builtin' });
      expect((await config.list())['narrow_limit']).toEqual({ value: 1, source: 'builtin' });
    } finally {
      cleanup(root);
    }
  });

  it('a file that is not an object: the reading refuses, because the file cannot be parsed as settings', async () => {
    const { root, config } = await makeProject();
    try {
      seedProjectConfig(root, '[1, 2]');
      expect((await refusalOf(() => config.list())).code).toBe('invalid_config_file');
      expect((await refusalOf(() => config.get('max_agents'))).code).toBe('invalid_config_file');
    } finally {
      cleanup(root);
    }
  });

  it('a name the file does not know: it stays out of the reading and is kept as it is when writing', async () => {
    const { root, config } = await makeProject();
    try {
      seedProjectConfig(root, '{"someone_elses": 1, "max_agents": 2}');
      expect((await config.list())['max_agents']).toEqual({ value: 2, source: 'project' });
      await config.set('test_tier', 'minimal', { project: true });
      const kept = JSON.parse(projectConfigText(root)) as Record<string, unknown>;
      expect(kept['someone_elses']).toBe(1);
      expect(kept['max_agents']).toBe(2);
      expect(kept['test_tier']).toBe('minimal');
    } finally {
      cleanup(root);
    }
  });

  it('a reading refuses a layer the knob does not accept, and the refusal names the layers it accepts', async () => {
    const { root, config } = await makeProject(DECLARED);
    try {
      seedCycle(root, 'c1');
      const refusal = await refusalOf(() => config.get('max_agents', { cycle: 'c1' }));
      expect(refusal.code).toBe('layer_not_allowed');
      expect(refusal.message).toContain('it takes: project, global');
    } finally {
      cleanup(root);
    }
  });
});

describe('the directory a verb works in', () => {
  it('a named directory is read and written instead of the handle own project root', async () => {
    const here = await makeProject(DECLARED);
    const other = await makeProject(DECLARED);
    try {
      await here.config.set('max_agents', 4, { project: true });
      // The named directory's own project layer is read…
      expect(await other.config.get('max_agents', undefined, here.root)).toEqual({ value: 4, source: 'project' });
      // …while the machine layer stays this machine's: naming a project does not move home.
      await other.config.set('test_tier', 'minimal', { global: true });
      expect((await other.config.list(undefined, here.root))['test_tier']).toEqual({ value: 'minimal', source: 'global' });
      // A write through the other handle lands in the named project, not in the handle's own.
      const before = projectConfigText(other.root);
      await other.config.set('test_tier', 'minimal', { project: true }, here.root);
      expect(projectConfigText(here.root)).toContain('"test_tier": "minimal"');
      expect(projectConfigText(other.root)).toBe(before);
      await other.config.unset('max_agents', { project: true }, here.root);
      expect(await here.config.get('max_agents')).toEqual({ value: 3, source: 'builtin' });
    } finally {
      cleanup(here.root);
      cleanup(other.root);
    }
  });

  it('the pointed-at directory carries the narrow layers too: the line and the node are resolved and written in that project', async () => {
    const here = await makeProject(DECLARED);
    const other = await makeProject(DECLARED);
    try {
      const node = (await open(here.root).ledger.dag.add({ title: '甲' })).id;
      // The line holds the node, so a node read has a line layer underneath it.
      seedHoldingCycles(here.root, [{ id: 'c1', holding: [node] }]);

      // Both narrow layers are written through the other handle, into the named project.
      await other.config.set('proj_depth', 2, { cycle: 'c1' }, here.root);
      await other.config.set('proj_depth', 8, { node }, here.root);
      const hereState = JSON.parse(readFileSync(join(here.root, '.pf', 'state.json'), 'utf8')) as {
        cycles: Array<{ id: string; policies?: Record<string, unknown> }>;
      };
      expect(hereState.cycles[0]!.policies).toEqual({ proj_depth: 2 });
      expect(readFileSync(join(here.root, '.pf', 'nodes', node, 'config.json'), 'utf8'))
        .toContain('"proj_depth": 8');

      // Nothing was written into the handle's own project, which is where the verb was not pointed.
      expect(existsSync(join(other.root, '.pf', 'nodes', node))).toBe(false);
      const otherState = join(other.root, '.pf', 'state.json');
      expect(existsSync(otherState) ? readFileSync(otherState, 'utf8') : '').not.toContain('proj_depth');

      // The same two layers are read back through the named project, in chain order.
      expect(await other.config.get('proj_depth', { cycle: 'c1' }, here.root))
        .toEqual({ value: 2, source: 'cycle' });
      expect(await other.config.get('proj_depth', { node }, here.root)).toEqual({ value: 8, source: 'node' });
      expect((await other.config.list({ node }, here.root))['proj_depth']).toEqual({ value: 8, source: 'node' });

      // An unset through the named project takes off the node layer alone; the line layer below shows.
      await other.config.unset('proj_depth', { node }, here.root);
      expect(JSON.parse(readFileSync(join(here.root, '.pf', 'nodes', node, 'config.json'), 'utf8'))).toEqual({});
      expect(await other.config.get('proj_depth', { node }, here.root)).toEqual({ value: 2, source: 'cycle' });

      // The narrow pointers are resolved against the named project's own records, not the handle's.
      const elsewhere = (await open(other.root).ledger.dag.add({ title: '乙' })).id;
      expect((await refusalOf(() => other.config.get('proj_depth', { node: elsewhere }, here.root))).code)
        .toBe('node_not_found');
      expect((await refusalOf(() => other.config.set('proj_depth', 1, { cycle: 'c9' }, here.root))).code)
        .toBe('cycle_not_found');
    } finally {
      cleanup(here.root);
      cleanup(other.root);
    }
  });

  it('a relative directory is taken against the process current directory', async () => {
    const lab = await makeProject(DECLARED);
    try {
      await lab.config.set('max_agents', 7, { project: true });
      const spelling = relative(process.cwd(), lab.root);
      expect(await lab.config.get('max_agents', undefined, spelling)).toEqual({ value: 7, source: 'project' });
    } finally {
      cleanup(lab.root);
    }
  });

  it('the unknown-key refusal points at the settings file of the directory the verb was pointed at', async () => {
    const here = await makeProject(DECLARED);
    const other = await makeProject(DECLARED);
    try {
      const refusal = await refusalOf(() => other.config.get('nope', undefined, here.root));
      expect(refusal.code).toBe('unknown_key');
      expect(refusal.path).toBe(join(here.root, '.pf', 'config.json'));
      // Not the handle's own project layer, which is where the verb was not pointed.
      expect(refusal.path).not.toBe(join(other.root, '.pf', 'config.json'));
    } finally {
      cleanup(here.root);
      cleanup(other.root);
    }
  });

  it('a directory with no .pf of its own is refused outright, and no wider directory is tried instead', async () => {
    const lab = await makeProject(DECLARED);
    const nowhere = mkdtempSync(join(tmpdir(), 'pf-no-project-'));
    const inside = join(lab.root, 'inside');
    mkdirSync(inside, { recursive: true });
    try {
      const alone = await refusalOf(() => lab.config.get('max_agents', undefined, nowhere));
      expect(alone.code).toBe('not_a_project');
      expect(alone.message).toContain('.pf');
      // A directory inside a pf project still has no .pf of its own: it is refused, not guessed upward.
      expect((await refusalOf(() => lab.config.list(undefined, inside))).code).toBe('not_a_project');
      expect((await refusalOf(() => lab.config.set('max_agents', 4, { project: true }, nowhere))).code)
        .toBe('not_a_project');
      expect((await refusalOf(() => lab.config.unset('max_agents', { project: true }, nowhere))).code)
        .toBe('not_a_project');
    } finally {
      cleanup(lab.root);
      cleanup(nowhere);
    }
  });

  it('a handle opened where there is no .pf refuses too, instead of answering from the builtin layer', async () => {
    // The fork-worktree case: a node works in a worktree of its own, the worktree carries no .pf, and the
    // agent there has to learn that the directory is not a pf project — not be handed the main tree's
    // settings. The handle's own root is a directory like any other the verbs are pointed at.
    const alone = mkdtempSync(join(tmpdir(), 'pf-no-project-'));
    const config = createConfigNamespace(alone, { homeDir: join(alone, '_home') });
    try {
      const refusal = await refusalOf(() => config.get('max_agents'));
      expect(refusal.code).toBe('not_a_project');
      expect(refusal.message).toContain('.pf');
      for (const run of [
        () => config.list(),
        () => config.set('max_agents', 4, { project: true }),
        () => config.unset('max_agents', { project: true }),
      ]) {
        expect((await refusalOf(run)).code).toBe('not_a_project');
      }
      // init on that same fresh directory still works: it does not go through the settings verbs, and
      // once .pf is there the handle answers from it.
      const pf = open(alone);
      await pf.ledger.init();
      expect(await config.get('max_agents')).toEqual({ value: 3, source: 'builtin' });
    } finally {
      cleanup(alone);
    }
  });
});

describe('the gate and its edges', () => {
  it('a project never init-ed: the project and cycle layers refuse while the machine layer writes as usual', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-config-raw-'));
    const home = join(root, '_home');
    mkdirSync(join(root, '.pf'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    try {
      await expect(config.set('max_agents', 4, { project: true })).rejects.toThrow(/init/);
      expect(existsSync(join(root, '.pf', 'config.json'))).toBe(false);
      seedCycle(root, 'c1');
      // The cycle-layer gate: a declared knob (a built-in hits layer validation first and never
      // reaches the gate).
      await expect(config.set('proj_depth', 1, { cycle: 'c1' })).rejects.toThrow(/init/);
      expect(existsSync(join(root, '.pf', 'config.json'))).toBe(false);
      await config.set('max_agents', 6, { global: true });
      expect(homeConfigText(home)).toContain('"max_agents": 6');
    } finally {
      cleanup(root);
    }
  });
});

describe('the declared knobs of the project own plugin folder', () => {
  it('a handle from open() lists the knobs its plugins declare, and the project and line layers written under them are read back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-config-declared-'));
    try {
      // The handle carries a `homeDir` seam: `open(root, { homeDir })` hands one home to every namespace
      // that reads the machine layer (`config`, `conductor`), so `open` can wall the machine layer in. The
      // declaration table has no option of its own: it is read from the
      // project's plugin folder on each call. This test names no home, so that layer is this machine's own
      // file; the knob names below belong to the declaration, so no wider layer can hold a value under
      // them, and every reading asserted here is the project's or the line's.
      const pf = open(root);
      await pf.ledger.init();
      const folder = join(root, 'plugins', 'pool');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify({
        name: 'pool',
        summary: 'a stand-in declaration',
        timing: 'close',
        action: 'insert',
        knobs: {
          pool_limit: { kind: 'number', default: 5, summary: 'the pool sum the next close reads below' },
          pool_on: { kind: 'switch', default: 'on', summary: 'whether the pool acts' },
        },
      }, null, 2), 'utf8');

      // The list: the three built-ins plus the two declared knobs, each with its own factory default.
      const listed = await pf.config.list();
      expect(Object.keys(listed).sort())
        .toEqual([...Object.keys(BUILTIN_KNOBS), 'pool_limit', 'pool_on'].sort());
      expect(listed['pool_limit']).toEqual({ value: 5, source: 'builtin' });
      expect(listed['pool_on']).toEqual({ value: 'on', source: 'builtin' });

      // The project layer, written into `.pf/config.json` by hand: the reading names that layer.
      seedProjectConfig(root, '{"pool_limit": 9}');
      expect(await pf.config.get('pool_limit')).toEqual({ value: 9, source: 'project' });

      // The line layer, in the `policies` slot of the line record: a declared knob takes the whole chain,
      // which is what lets a line state it (no built-in can sit there).
      seedCycle(root, 'c1');
      writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({
        cycles: [{
          id: 'c1',
          title: 'line c1',
          status: 'active',
          holding: [],
          path: [],
          policies: { pool_limit: 2 },
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-01-01T00:00:00Z',
        }],
      }, null, 2), 'utf8');
      expect(await pf.config.get('pool_limit', { cycle: 'c1' })).toEqual({ value: 2, source: 'cycle' });

      // And the write side takes one there too: the value lands in that same slot under its own name, while
      // the project layer stays where it was.
      await pf.config.set('pool_on', 'off', { cycle: 'c1' });
      expect(await pf.config.get('pool_on', { cycle: 'c1' })).toEqual({ value: 'off', source: 'cycle' });
      expect(await pf.config.get('pool_on')).toEqual({ value: 'on', source: 'builtin' });
      const state = JSON.parse(readFileSync(join(root, '.pf', 'state.json'), 'utf8')) as {
        cycles: Array<{ policies?: Record<string, unknown> }>;
      };
      expect(state.cycles[0]!.policies).toEqual({ pool_limit: 2, pool_on: 'off' });
    } finally {
      cleanup(root);
    }
  });
});
