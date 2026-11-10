import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../src/plugins/context';
import { DOORS, doorForAction } from '../src/plugins/doors';
import { collectGates, collectOffers } from '../src/plugins/host';
import { pluginAssemblyOf } from '../src/plugins/assembly';
import { applyInsertion } from '../src/plugins/insertion';
import { readGraphSnapshot } from '../src/graph';
import { loadPlugins } from '../src/plugins/registry';
import { recordPaths } from '../src/paths';
import { closeInsertDecl, dispatchBlockDecl, makeLab } from './helpers/plugin-lab';

/**
 * Runtime tolerance for bad plugins, and the strict side of doctor: at runtime a bad plugin degrades
 * to one WARNING line (data) and takes no part this round, while the good plugins and the main flow
 * carry on; doctor lists every fault one by one — a declaration problem, a failed implementation
 * load, a missing gate, a real question that blows up or answers in the wrong shape, a skill that
 * disagrees in either of two ways, a claim source missing its function.
 */

const GOOD_IMPL = [
  'const SPEC = "# good spec\\n";',
  'export function offer() {',
  "  return { title: 'good node', tags: ['good'], spec_of: () => SPEC, why: 'good reason' };",
  '}',
].join('\n');

describe('runtime tolerance: a bad plugin degrades, the main flow is not burdened', () => {
  it('a plugin whose offer throws only costs itself: one warning, zero offers, and the good one still offers', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('broken', closeInsertDecl(), { 'impl.mjs': 'export function offer() { throw new Error("boom"); }\n' });
      lab.plugin('good', closeInsertDecl(), { 'impl.mjs': GOOD_IMPL });
      const paths = recordPaths(lab.root);
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      const offers = await collectOffers('close', ctx, folders, warnings);
      expect(offers.map((offer) => offer.plugin)).toEqual(['good']);
      expect(warnings.join('\n')).toContain('WARNING: plugin broken failed');
      expect(warnings.join('\n')).toContain('boom');
    } finally {
      lab.cleanup();
    }
  });

  it('an offer of the wrong shape (no title) is stopped before the graph is edited: one warning names the cell', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('shapeless', closeInsertDecl(), {
        'impl.mjs': 'export function offer() { return { spec_of: () => "x" }; }\n',
      });
      const paths = recordPaths(lab.root);
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      const offers = await collectOffers('close', ctx, folders, warnings);
      expect(offers).toEqual([]);
      expect(warnings.join('\n')).toContain('`title` must be a non-empty string');
    } finally {
      lab.cleanup();
    }
  });

  it('an offer answering {} (an empty object with no own keys) is skipped silently as "none this round", with no false warning', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('empty', closeInsertDecl(), { 'impl.mjs': 'export function offer() { return {}; }\n' });
      lab.plugin('good', closeInsertDecl(), { 'impl.mjs': GOOD_IMPL });
      const paths = recordPaths(lab.root);
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      const offers = await collectOffers('close', ctx, folders, warnings);
      expect(offers.map((offer) => offer.plugin)).toEqual(['good']);
      expect(warnings.join('\n')).not.toContain('unusable offer');
      expect(warnings.join('\n')).not.toContain('empty');
    } finally {
      lab.cleanup();
    }
  });

  it('a check answering {} (an empty object with no own keys) is skipped silently as "none this round": no reasons, no warnings', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('emptygate', dispatchBlockDecl(), { 'impl.mjs': 'export function check() { return {}; }\n' });
      lab.plugin('speaking', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { return "not while tests are red"; }\n',
      });
      const paths = recordPaths(lab.root);
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      const reasons = await collectGates('dispatch', ctx, folders, warnings);
      expect(reasons).toEqual(['not while tests are red']);
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it('a plugin with a broken declaration takes no part this round (no gate is asked), while an implementation without offer only earns a warning', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('baddecl', closeInsertDecl({ wat: 1 }), { 'impl.mjs': 'export function offer() { return null; }\n' });
      lab.plugin('doorless', closeInsertDecl(), { 'impl.mjs': 'export const nothing = 1;\n' });
      const paths = recordPaths(lab.root);
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(paths),
      });
      const offers = await collectOffers('close', ctx, folders, warnings);
      expect(offers).toEqual([]);
      expect(warnings.join('\n')).toContain('WARNING: plugin doorless has no offer()');
      // baddecl's problem is on the declaration side: doctor reports it, and the runtime gate never asks it at all.
      expect(warnings.join('\n')).not.toContain('baddecl');
    } finally {
      lab.cleanup();
    }
  });
});

describe('the strict side of doctor: every fault is listed one by one', () => {
  it('zero plugins is a legal state: ok, and it names the scanned directory', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      const report = await lab.superworker.conductor.doctor();
      expect(report.ok).toBe(true);
      const plugins = report.checks.find((check) => check.name === 'plugins')!;
      expect(plugins.ok).toBe(true);
      expect(plugins.detail).toContain('0 installed');
    } finally {
      lab.cleanup();
    }
  });

  it('healthy plugins: ok, and it says how many are installed', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('healthy', closeInsertDecl(), { 'impl.mjs': 'export function offer() { return null; }\n' });
      const report = await lab.superworker.conductor.doctor();
      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.name === 'plugins')!.detail).toContain('1 installed');
    } finally {
      lab.cleanup();
    }
  });

  it('the plugin face spells out the two halves: an implementation entry needs a restart, a declaration change is in force on the next call', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('healthy', closeInsertDecl(), { 'impl.mjs': 'export function offer() { return null; }\n' });
      const plugins = (await lab.superworker.conductor.doctor()).checks.find((check) => check.name === 'plugins')!;
      expect(plugins.detail).toContain('an edit on disk takes effect after a restart');
      expect(plugins.detail).toContain('is in force on the next call without a restart');
    } finally {
      lab.cleanup();
    }
  });

  it('faults are listed one by one: a declaration problem, a load failure, a missing gate, a real question blowing up, a source missing its function', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('baddecl', closeInsertDecl({ wat: 1 }), { 'impl.mjs': 'export function offer() { return null; }\n' });
      lab.plugin('unloadable', closeInsertDecl(), { 'impl.mjs': 'export function({ (broken syntax\n' });
      lab.plugin('doorless', dispatchBlockDecl(), { 'impl.mjs': 'export const nothing = 1;\n' });
      lab.plugin('thrower', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { throw new Error("gate boom"); }\n',
      });
      lab.plugin('claimant', closeInsertDecl({
        sources: { pool: { by: 'pool_weight' } },
        readings: { pool_size: { source: 'pool' } },
      }), { 'impl.mjs': 'export function offer() { return null; }\n' });
      const report = await lab.superworker.conductor.doctor();
      expect(report.ok).toBe(false);
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('unknown key "wat"');
      expect(detail).toContain('impl.mjs failed to load');
      expect(detail).toContain('has no check(), so the "block" timing');
      expect(detail).toContain('check() raised on a stand-in project');
      expect(detail).toContain('gate boom');
      expect(detail).toContain('computed by pool_weight()');
    } finally {
      lab.cleanup();
    }
  });

  it('a real question answered in the wrong shape (check returning a number) is listed as well', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('numeric', dispatchBlockDecl(), { 'impl.mjs': 'export function check() { return 7; }\n' });
      const report = await lab.superworker.conductor.doctor();
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('check() answered number');
      expect(report.ok).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('check answering {} or [] means "none this round" (every falsy answer treated the same way): doctor goes green, no false red', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('emptygate', dispatchBlockDecl(), { 'impl.mjs': 'export function check() { return {}; }\n' });
      // The second plugin brings its own knob name: two knobs colliding is another fault (the
      // conflicts check reports it), so it is kept out of this case.
      lab.plugin('listgate', dispatchBlockDecl({
        enable_knob: 'list_on',
        knobs: { list_on: { kind: 'switch', default: 'on', summary: 'armed' } },
      }), { 'impl.mjs': 'export function check() { return []; }\n' });
      const report = await lab.superworker.conductor.doctor();
      const plugins = report.checks.find((check) => check.name === 'plugins')!;
      expect(plugins.ok).toBe(true);
      expect(plugins.detail).toContain('2 installed');
      expect(plugins.detail ?? '').not.toContain('answered');
      expect(report.ok).toBe(true);
    } finally {
      lab.cleanup();
    }
  });

  it('asynchronous implementations are asked for real too: a plugin whose offer always rejects makes doctor go red, with no under-reporting', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('asyncrejector', closeInsertDecl(), {
        'impl.mjs': 'export function offer() { return Promise.reject(new Error("async boom")); }\n',
      });
      const report = await lab.superworker.conductor.doctor();
      expect(report.ok).toBe(false);
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('offer() raised on a stand-in project');
      expect(detail).toContain('async boom');
    } finally {
      lab.cleanup();
    }
  });

  it('an asynchronous check answering with a reason sentence: a runtime-legal answer, so doctor goes green, no false red', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('asyncgate', dispatchBlockDecl(), {
        'impl.mjs': 'export async function check() { return "tests are red, fix them first"; }\n',
      });
      const report = await lab.superworker.conductor.doctor();
      const plugins = report.checks.find((check) => check.name === 'plugins')!;
      expect(plugins.ok).toBe(true);
      expect(plugins.detail).toContain('1 installed');
      expect(report.ok).toBe(true);
    } finally {
      lab.cleanup();
    }
  });

  it('a rejected async check reports "raised" rather than a false shape error, and the rejected Promise is caught', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('asyncgateboom', dispatchBlockDecl(), {
        'impl.mjs': 'export function check() { return Promise.reject(new Error("gate async boom")); }\n',
      });
      const report = await lab.superworker.conductor.doctor();
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('check() raised on a stand-in project');
      expect(detail).toContain('gate async boom');
      expect(detail).not.toContain('answered object');
      expect(report.ok).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a skill disagreeing in two ways: a named method has no skill of its own, and one skill name is carried by two plugins', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      const decl = closeInsertDecl({
        metrics: { pool_size: { line: 'plugin_on', tag: 'p:pool', method: 'superworker-repair' } },
      });
      lab.plugin('skilled', decl, {
        'impl.mjs': 'export function offer() { return null; }\n',
        'skills/zh/superworker-repair/SKILL.md': '# repair\n',
      });
      lab.plugin('freerider', decl, {
        'impl.mjs': 'export function offer() { return null; }\n',
        // Its own method has no skill (it names superworker-repair but does not bring it), and it grabs the same name anyway.
        'skills/zh/superworker-repair/SKILL.md': '# another\n',
      });
      lab.plugin('naked', decl, { 'impl.mjs': 'export function offer() { return null; }\n' });
      const report = await lab.superworker.conductor.doctor();
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('a skill belongs to one plugin');
      expect(detail).toContain('method "superworker-repair" has no skill of its own');
      expect(report.ok).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a knob colliding with a built-in setting name: the built-in cell stays in place, and doctor reports that line', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('shadow', closeInsertDecl({
        knobs: {
          max_agents: { kind: 'integer', default: 2, summary: 'shadowing builtin' },
        },
      }), { 'impl.mjs': 'export function offer() { return null; }\n' });
      const report = await lab.superworker.conductor.doctor();
      const knobs = report.checks.find((check) => check.name === 'knobs')!;
      expect(knobs.ok).toBe(false);
      expect(knobs.detail).toContain('already a built-in setting');
      expect(report.ok).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a bad plugin cannot make doctor itself throw: the report still comes back', async () => {
    const lab = makeLab('superworker-plugin-doctor-');
    try {
      lab.plugin('nastier', 'not json', { 'impl.mjs': 'syntax error ((' });
      const report = await lab.superworker.conductor.doctor();
      expect(report.ok).toBe(false);
      // Three plugin-side checks plus four record-side checks (the merge-driver cell is among them, not asked here): a bad plugin gets neither fewer nor more checks than any other.
      expect(report.checks.map((check) => check.name)).toEqual([
        'plugins', 'knobs', 'commands', 'records', 'graph', 'cycles', 'merge-driver',
      ]);
    } finally {
      lab.cleanup();
    }
  });
});

describe('the listing side of doctor: one block per installed plugin, all of it read off the declaration', () => {
  it('the summary, every knob with its kind, vocabulary, default and summary, the tags, methods, sources and commands are all there', async () => {
    const lab = makeLab('superworker-plugin-listing-');
    try {
      await lab.superworker.ledger.init();
      // One plugin carrying every item a declaration can hold, and one carrying nothing but its name: the
      // listing answers "how does this plugin work" without running any of it, so an empty block stays empty.
      lab.plugin('lister', {
        summary: 'one of everything a declaration can carry',
        timing: 'close',
        action: 'insert',
        commands: { poll: { summary: 'the poll', keep_name: false } },
        sources: { poll_pool: { by: 'pool_weight' } },
        knobs: {
          poll_limit: { kind: 'integer', default: 4, summary: 'the poll sum the next close reads below' },
          poll_mode: { kind: 'word', values: ['fast', 'slow'], default: 'fast', summary: 'which way the poll reads' },
          poll_line: { kind: 'number', default: null, summary: 'no factory value at all' },
        },
        readings: { poll_weight: { source: 'poll_pool' } },
        metrics: { poll_weight: { line: 'poll_limit', tag: 'poll:poll_weight', method: 'superworker-poll-repair' } },
      }, {
        'impl.mjs': 'export function offer() { return null; }\nexport function pool_weight() { return 1; }\n',
        'skills/en/superworker-poll-repair/SKILL.md': '# superworker-poll-repair\n',
      });
      lab.plugin('bare', { summary: 'nothing but a name', timing: 'close', action: 'insert' }, {
        'impl.mjs': 'export function offer() { return null; }\n',
      });

      const report = await lab.superworker.conductor.doctor();
      const plugins = report.checks.find((check) => check.name === 'plugins')!;
      expect(plugins.ok, plugins.detail).toBe(true);
      expect(plugins.detail).toContain('2 installed');

      const detail = plugins.detail ?? '';
      // One block per installed plugin, in folder order, each opened by its own name and summary.
      expect(detail).toContain('  · lister — one of everything a declaration can carry');
      expect(detail).toContain('  · bare — nothing but a name');
      // The knobs: name, kind, vocabulary, factory default, the cell's own one-line summary. The first is
      // led by `knobs:` and the rest are aligned under it; a cell with no factory value says its kind alone.
      expect(detail).toContain(
        '      knobs: poll_limit (integer: default 4) — the poll sum the next close reads below');
      expect(detail).toContain(
        '             poll_mode (word: one of fast / slow, default fast) — which way the poll reads');
      expect(detail).toContain('             poll_line (number) — no factory value at all');
      // The rest of the block, each item on its own line.
      expect(detail).toContain('      tags: poll:poll_weight');
      expect(detail).toContain('      methods: superworker-poll-repair');
      expect(detail).toContain('      sources: poll_pool (computed by pool_weight())');
      expect(detail).toContain('      commands: poll');
      // The skills the folder ships are its own reading (a folder convention, not a declaration cell):
      // one item per method, with the languages it comes in.
      expect(detail).toContain('      skills: superworker-poll-repair (en)');
      // The plugin that declares none of those prints nothing under its name: no empty `knobs:` / `tags:`
      // line, and no item borrowed from the neighbour's block.
      const block = detail.slice(detail.indexOf('  · bare'), detail.indexOf('  · lister'));
      expect(block).not.toContain('knobs:');
      expect(block).not.toContain('tags:');
      expect(block).not.toContain('commands:');
      expect(block).not.toContain('skills:');
      expect(report.ok).toBe(true);
    } finally {
      lab.cleanup();
    }
  });
});

describe('the offer contract is the shape the core uses: nothing beside it is carried or interpreted', () => {
  it('an offer carrying extra cells lands unchanged: no stripping, no warning, and the landed insertion has no such cell', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('talker', closeInsertDecl(), {
        'impl.mjs': [
          'const SPEC = "# talker spec\\n";',
          'export function offer() {',
          "  return { title: 't', tags: ['x'], spec_of: () => SPEC, note: 'n', why: 'w',",
          "    fields: { cycle: 'c2', mine: 1 } };",
          '}',
        ].join('\n'),
      });
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(recordPaths(lab.root)),
      });
      const offers = await collectOffers('close', ctx, folders, warnings);
      expect(offers).toHaveLength(1);
      const closed = (await lab.superworker.ledger.dag.add({ title: 'the node being closed' })).id;
      const applied = await applyInsertion(lab.root, lab.superworker.ledger.dag, offers[0]!, closed, null);
      // The four cells the mechanism reads, and nothing else: a cell the offer's shape does not name is
      // neither carried along nor stripped with a warning — the core never interprets it.
      expect(Object.keys(applied).sort()).toEqual(
        ['nodeId', 'note', 'plugin', 'specPath', 'tags', 'title', 'why'],
      );
      expect(readFileSync(applied.specPath, 'utf8')).toBe('# talker spec\n');
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });
});

describe('one tolerance for "none this round": the timing reads what doctor reads', () => {
  it('an offer answering an empty table is silent at the real timing (doctor already reads it as "none")', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      lab.plugin('listy', closeInsertDecl(), { 'impl.mjs': 'export function offer() { return []; }\n' });
      const warnings: string[] = [];
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(recordPaths(lab.root)),
      });
      const offers = await collectOffers('close', ctx, folders, warnings);
      expect(offers).toEqual([]);
      // The same answer doctor's stand-in question accepts: an empty table is "I have nothing to say",
      // not a half offer that spends the round with a WARNING.
      expect(warnings).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });
});

describe('the door a declaration names is read off the one DOORS table', () => {
  it('an action the DOORS table gains gets its door at once; a word outside the table names no door', () => {
    const doors = DOORS as Record<string, { door: string; preview: string }>;
    doors.probe = { door: 'probe_door', preview: 'probe_door_preview' };
    try {
      expect(doorForAction('probe')).toBe('probe_door');
    } finally {
      delete doors.probe;
    }
    expect(doorForAction('probe')).toBeNull();
    expect(doorForAction('notify')).toBeNull();
    expect(doorForAction(null)).toBeNull();
  });
});

describe('one assembly is one picture of the round', () => {
  it('the usable set is worked out once: a round does not re-validate every folder at every door', async () => {
    const lab = makeLab('superworker-plugin-runtime-');
    try {
      await lab.superworker.ledger.init();
      const folder = lab.plugin('healthy', closeInsertDecl({
        files: ['tools/extra.mjs'],
      }), {
        'impl.mjs': 'export function offer() { return { title: "from the assembly", spec_of: () => "s" }; }\n',
        'tools/extra.mjs': 'export const extra = 1;\n',
      });
      const assembly = pluginAssemblyOf(lab.root);
      const folders = await assembly.folders();
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        assembly,
        homeDir: lab.home,
        warnings,
        dag: await readGraphSnapshot(recordPaths(lab.root)),
      });
      // The picture this round starts on: the folder is whole, so the plugin may act.
      expect(await assembly.available()).toHaveLength(1);

      // The file the declaration lists disappears after the round started. The round's own assembly answers
      // for the picture it took (one disk ask per folder, not one per door) and the door is still asked…
      rmSync(join(folder, 'tools', 'extra.mjs'));
      const fromAssembly = await collectOffers('close', ctx, folders, warnings, false, assembly);
      expect(fromAssembly).toHaveLength(1);

      // …while a reader that re-validates each folder at each door drops it, which is the per-door work the
      // assembly exists to do once.
      const revalidated = await collectOffers('close', ctx, folders, warnings);
      expect(revalidated).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });
});
