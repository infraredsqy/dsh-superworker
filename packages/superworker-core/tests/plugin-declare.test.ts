import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderProblems, declarationProblems, declaredKnobSpecs, loadPlugins, usable } from '../src/plugins/registry';
import { closeInsertDecl, makeLab, type PluginLab } from './helpers/plugin-lab';

/**
 * Closed-set validation of declarations: a legal declaration passes the gate, illegal ones turn
 * red class by class — unknown key (top level and per cell), missing implementation, bad timing,
 * bad action, bad kind, a knob cell with no default, plus the cell table, name agreement, the files
 * shape, and a few cells for readings and commands. Validation is a pure data question (a list of
 * problem sentences, nothing thrown anywhere); the runtime skips on it and doctor reports it.
 */

interface Case {
  readonly name: string;
  /** The declaration (object or raw text); the valid cases give a legal one. */
  readonly decl: unknown;
  /** Extra accompanying files (a legal impl.mjs is included by default; an explicit files wins). */
  readonly files?: Record<string, string>;
  /** Leave the implementation entry out (for the missing-implementation case). */
  readonly omitImpl?: boolean;
  /** A fragment the problem line must contain; an empty string means legal, zero problems. */
  readonly expect: string;
}

const IMPL = 'export function offer() { return null; }\n';

const CASES: readonly Case[] = [
  { name: 'a legal declaration has no problems', decl: closeInsertDecl(), expect: '' },
  {
    name: 'unknown key (top level)',
    decl: closeInsertDecl({ wat: 1 }),
    expect: 'unknown key "wat"',
  },
  {
    name: 'unknown key (inside a knob cell)',
    decl: closeInsertDecl({
      knobs: { plugin_on: { kind: 'switch', kinds: 'switch', default: 'on', summary: 's' } },
    }),
    expect: 'unknown key(s) "kinds"',
  },
  {
    name: 'unknown key (inside a command cell)',
    decl: closeInsertDecl({
      timing: undefined,
      action: undefined,
      enable_knob: undefined,
      knobs: undefined,
      commands: { word: { summary: 's', aliases: [] } },
    }),
    expect: 'unknown key(s) "aliases"',
  },
  {
    name: 'missing implementation (impl.mjs is absent)',
    decl: closeInsertDecl(),
    omitImpl: true,
    expect: 'no impl.mjs',
  },  {
    name: 'bad timing',
    decl: closeInsertDecl({ timing: 'weekly' }),
    expect: 'timing "weekly" is not one of',
  },
  {
    name: 'bad action',
    decl: closeInsertDecl({ action: 'notify' }),
    expect: 'action "notify" is not one of',
  },
  {
    name: 'a knob cell that states no default (the key is required, null is how "no factory value" is said)',
    decl: closeInsertDecl({
      knobs: { plugin_on: { kind: 'switch', summary: 's' } },
    }),
    expect: 'states no default',
  },
  {
    name: 'bad kind',
    decl: closeInsertDecl({
      knobs: { plugin_on: { kind: 'boolean', default: 'on', summary: 's' } },
    }),
    expect: 'which is not one of [number, integer, word, switch]',
  },
  {
    name: 'a combination outside the cell table (stopped at the close)',
    decl: closeInsertDecl({ action: 'block' }),
    expect: 'is not a cell this core serves',
  },
  {
    name: 'only half of timing and action given (a declaration with commands needs both)',
    decl: closeInsertDecl({
      action: undefined,
      enable_knob: undefined,
      knobs: undefined,
      commands: { word: { summary: 's' } },
    }),
    expect: 'timing and action travel together',
  },
  {
    name: 'timing without action (no command exemption, and the absent action is named as it is)',
    decl: closeInsertDecl({ action: undefined }),
    expect: 'action null is not one of',
  },
  {
    name: 'enable_knob names an undeclared knob',
    decl: closeInsertDecl({ enable_knob: 'missing_switch' }),
    expect: 'does not declare as a knob',
  },
  {
    name: 'enable_knob is not a switch',
    decl: closeInsertDecl({
      enable_knob: 'plugin_word',
      knobs: {
        plugin_word: { kind: 'word', values: ['a', 'b'], default: 'a', summary: 's' },
      },
    }),
    expect: 'only a switch names on/off',
  },
  {
    name: 'the declared name does not match the folder',
    decl: closeInsertDecl({ name: 'other' }),
    expect: 'declares the name "other"',
  },
  {
    name: 'files point outside the folder',
    decl: closeInsertDecl({ files: ['../escape.mjs'] }),
    expect: 'not inside its own folder',
  },
  {
    name: 'files is not a list',
    decl: closeInsertDecl({ files: 'tools.mjs' }),
    expect: 'files must be a list',
  },
  {
    name: 'a reading source that is neither the core nor a claim of its own',
    decl: closeInsertDecl({
      readings: { test_seconds: { source: 'nowhere', ask: 'how long' } },
    }),
    expect: 'which is neither one of',
  },
  {
    name: 'a metric names a reading the plugin does not declare',
    decl: closeInsertDecl({
      metrics: { test_seconds: { line: 'plugin_on', tag: 't:t', method: 'm' } },
    }),
    expect: 'names a reading the plugin does not declare',
  },
  {
    name: 'a metric is judged against an undeclared line',
    decl: closeInsertDecl({
      readings: { test_seconds: { source: 'ticket', ask: 'how long' } },
      metrics: { test_seconds: { line: 'nope', tag: 't:t', method: 'm' } },
    }),
    expect: 'does not declare as a knob',
  },
  {
    name: 'claiming a source the core ships with',
    decl: closeInsertDecl({ sources: { ticket: { by: 'compute' } } }),
    expect: 'cannot be claimed',
  },
  {
    name: 'a claimed source with no function name for the arithmetic',
    decl: closeInsertDecl({ sources: { pool: {} } }),
    expect: 'needs a by',
  },
  {
    name: 'the command word is not one word',
    decl: closeInsertDecl({
      timing: undefined,
      action: undefined,
      enable_knob: undefined,
      knobs: undefined,
      commands: { 'two words': { summary: 's' } },
    }),
    expect: 'is not a word',
  },
  {
    name: 'the command has no one-line summary',
    decl: closeInsertDecl({
      timing: undefined,
      action: undefined,
      enable_knob: undefined,
      knobs: undefined,
      commands: { word: {} },
    }),
    expect: 'needs a summary',
  },
  {
    name: 'keep_name is not a boolean',
    decl: closeInsertDecl({
      timing: undefined,
      action: undefined,
      enable_knob: undefined,
      knobs: undefined,
      commands: { word: { summary: 's', keep_name: 'yes' } },
    }),
    expect: 'takes keep_name as true or false',
  },
];

async function folderOf(lab: PluginLab, name: string, decl: unknown, files: Record<string, string>, omitImpl: boolean) {
  const all: Record<string, string> = omitImpl ? {} : { 'impl.mjs': IMPL };
  for (const [rel, content] of Object.entries(files)) all[rel] = content;
  lab.plugin(name, decl, all);
  const scan = await loadPlugins(join(lab.root, 'plugins'));
  return scan.folders.find((folder) => folder.name === name)!;
}

describe('closed-set declaration checks: each class turns red', () => {
  it.each(CASES.filter((c) => c.expect !== ''))('%s', async (c) => {
    const lab = makeLab('superworker-plugin-declare-');
    try {
      const folder = await folderOf(lab, 'probe', c.decl, c.files ?? {}, c.omitImpl === true);
      // doctor's full reading of one folder (declaration problems plus whether the implementation and the listed files are there).
      const problems = folderProblems(folder);
      expect(problems.join('\n')).toContain(c.expect);
      expect(usable(folder)).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a legal declaration has no problems and is usable', async () => {
    const lab = makeLab('superworker-plugin-declare-');
    try {
      const folder = await folderOf(lab, 'probe', closeInsertDecl(), {}, false);
      expect(folderProblems(folder)).toEqual([]);
      expect(declarationProblems(folder)).toEqual([]);
      expect(usable(folder)).toBe(true);
    } finally {
      lab.cleanup();
    }
  });

  it('a declaration with commands and no timing is legal (a command is not a timing and takes no cell)', async () => {
    const lab = makeLab('superworker-plugin-declare-');
    try {
      const decl = {
        summary: 'commands only',
        commands: { word: { summary: 'the word' } },
      };
      const folder = await folderOf(lab, 'probe', decl, {}, false);
      expect(declarationProblems(folder)).toEqual([]);
      expect(usable(folder)).toBe(true);
    } finally {
      lab.cleanup();
    }
  });

  it('a knob stating `default: null` is legal, and the merged spec keeps "no factory value" exactly as before', async () => {
    const lab = makeLab('superworker-plugin-declare-');
    try {
      const decl = closeInsertDecl({
        knobs: { plugin_on: { kind: 'switch', default: null, summary: 'no factory value at all' } },
      });
      const folder = await folderOf(lab, 'probe', decl, {}, false);
      expect(declarationProblems(folder)).toEqual([]);
      expect(usable(folder)).toBe(true);
      const specs = declaredKnobSpecs([folder]);
      expect(specs['plugin_on']?.default).toBeNull();
    } finally {
      lab.cleanup();
    }
  });

  it('a knob cell that states no default: the whole plugin is unusable, and the cell enters no spec list', async () => {
    const lab = makeLab('superworker-plugin-declare-');
    try {
      const decl = closeInsertDecl({
        knobs: { plugin_on: { kind: 'switch', summary: 's' } },
      });
      const folder = await folderOf(lab, 'probe', decl, {}, false);
      const sentence = declarationProblems(folder).join('\n');
      // The line names the plugin, the knob, and what follows from the missing key.
      expect(sentence).toContain('plugin "probe"');
      expect(sentence).toContain('knob "plugin_on"');
      expect(sentence).toContain('no default');
      expect(usable(folder)).toBe(false);
      expect(Object.hasOwn(declaredKnobSpecs([folder]), 'plugin_on')).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('an unreadable declaration (not an object) is one problem line too, and nothing throws', async () => {
    const lab = makeLab('superworker-plugin-declare-');
    try {
      lab.plugin('broken', 'not json at all', { 'impl.mjs': IMPL });
      const scan = await loadPlugins(join(lab.root, 'plugins'));
      const folder = scan.folders.find((f) => f.name === 'broken')!;
      expect(folder.decl).toBeNull();
      expect(folder.problems.join('\n')).toContain('could not be read');
      expect(scan.problems).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });
});
