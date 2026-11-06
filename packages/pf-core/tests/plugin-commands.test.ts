import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../src/plugins/context';
import { commandClashes, commandTable, conflicts, loadPlugins, routableCommands } from '../src/plugins/registry';
import { makeLab } from './helpers/plugin-lab';

/**
 * Words of plugin commands: a word is declared (a sound declaration gets it into the table), but
 * routing is the core's call -- clash with a word the core already answers and the core wins, the
 * plugin's word never routes, and doctor reports exactly that; when two plugins clash, the first
 * claim stays and doctor reports that too. Commands run inside this process: capture/run only walk
 * the routing table.
 */

function commandsOnlyDecl(words: Record<string, string>): Record<string, unknown> {
  const commands: Record<string, { summary: string; keep_name?: boolean }> = {};
  for (const [word, summary] of Object.entries(words)) {
    commands[word] = { summary };
  }
  return {
    summary: 'commands only',
    commands,
  };
}

const TALKER_IMPL = [
  'export function offer() { return null; }',
  'export function main(argv, ctx) { return "said:" + argv.join("|"); }',
].join('\n');

describe('a command clash: the core wins and the clash is reported', () => {
  it('the word table keeps the clashing word (the word is declared), the routing table drops it (the core wins)', async () => {
    const lab = makeLab('pf-plugin-cmd-');
    try {
      await lab.pf.ledger.init();
      lab.plugin('talker', commandsOnlyDecl({
        plan: 'shadows a core verb',
        issuelist: 'the plugin own word',
        list: 'a method inside `dag`, not a word the core answers',
      }), {
        'impl.mjs': TALKER_IMPL,
      });
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const table = commandTable(folders);
      expect(table.map((entry) => entry.name).sort()).toEqual(['issuelist', 'list', 'plan']);
      const routable = routableCommands(folders);
      // `plan` is a word the word table answers, so the core keeps it. `list` is a verb inside the `dag`
      // group, not a word of its own: it is not a core word and it routes to the plugin that declares it.
      expect(routable.map((entry) => entry.name)).toEqual(['issuelist', 'list']);
      expect(commandClashes(folders).join('\n')).toContain(
        'command "plan" is a word this core already answers',
      );
      expect(commandClashes(folders).join('\n')).not.toContain('"list"');
      // Routing inside this process follows the routing table: a word the core keeps answers
      // nothing, while a word the core only has inside a group runs the plugin's own command.
      const warnings: string[] = [];
      const ctx = createContext({
        root: lab.root,
        folders,
        homeDir: lab.home,
        warnings,
        dag: { nodes: {} },
      });
      expect(await ctx.capture(['plan'])).toBeNull();
      expect(await ctx.capture(['list'])).toBe('said:list');
      expect(await ctx.capture(['issuelist', 'a', 'b'])).toBe('said:issuelist|a|b');
    } finally {
      lab.cleanup();
    }
  });

  it('two plugins claim one word: the first claim stays routable, doctor reports the conflict', async () => {
    const lab = makeLab('pf-plugin-cmd-');
    try {
      await lab.pf.ledger.init();
      lab.plugin('first', commandsOnlyDecl({ samecmd: 'first claim' }), { 'impl.mjs': TALKER_IMPL });
      lab.plugin('second', commandsOnlyDecl({ samecmd: 'second claim' }), { 'impl.mjs': TALKER_IMPL });
      const folders = (await loadPlugins(join(lab.root, 'plugins'))).folders;
      const routable = routableCommands(folders).filter((entry) => entry.name === 'samecmd');
      expect(routable.length).toBe(1);
      expect(routable[0]!.plugin).toBe('first');
      expect(conflicts(folders).join('\n')).toContain(
        'command "samecmd" is claimed by both "first" and "second"',
      );
    } finally {
      lab.cleanup();
    }
  });

  it('the clash surfaces through conductor.doctor: ok turns red, the sentence sits in the plugins check detail', async () => {
    const lab = makeLab('pf-plugin-cmd-');
    try {
      await lab.pf.ledger.init();
      lab.plugin('talker', commandsOnlyDecl({ plan: 'shadows a core verb' }), { 'impl.mjs': TALKER_IMPL });
      const report = await lab.pf.conductor.doctor();
      expect(report.ok).toBe(false);
      const commands = report.checks.find((check) => check.name === 'commands')!;
      expect(commands.ok).toBe(false);
      expect(commands.detail).toContain('the core keeps it and this one never routes');
    } finally {
      lab.cleanup();
    }
  });

  it('a command without a clash keeps doctor green, and the commands check says routing is clean', async () => {
    const lab = makeLab('pf-plugin-cmd-');
    try {
      await lab.pf.ledger.init();
      lab.plugin('talker', commandsOnlyDecl({ issuelist: 'own word' }), { 'impl.mjs': TALKER_IMPL });
      const report = await lab.pf.conductor.doctor();
      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.name === 'commands')!.detail)
        .toContain('no plugin command claims a core word');
    } finally {
      lab.cleanup();
    }
  });
});
