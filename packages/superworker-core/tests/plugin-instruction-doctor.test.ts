import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { offer, offer_preview } from '../plugins/instruction/impl.mjs';
import { open } from '../src/open';
import { answer } from '../src/index';

/**
 * The `instruction` plugin from the outside: the four shipped plugins in one folder, what doctor says
 * about each of them, and what the word surface does when the folder is taken away.
 *
 * The declaration is the one authority on which word a plugin claims and which files it brings; the
 * skills are its folder's own reading (`skills/<lang>/<method>/SKILL.md`). Criterion: doctor lists
 * four plugins, the instruction line names its word and its skill, and no plugin command claims a
 * core word — with the folder gone, `instruction` answers "no such word" and everything else goes on.
 */

const SHIPPED = fileURLToPath(new URL('../plugins/', import.meta.url));
const REPO_PLUGIN = fileURLToPath(new URL('../plugins/instruction', import.meta.url));

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-instruction-doctor-'));
  await open(root).ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** The doctor's `plugins` check of one handle. */
async function pluginCheck(pluginsDir?: string) {
  const superworker = open(root, pluginsDir === undefined ? {} : { pluginsDir });
  const report = await superworker.conductor.doctor();
  return report.checks.find((check) => check.name === 'plugins')!;
}

describe('doctor on the shipped set', () => {
  it('lists four plugins, and the instruction line names the word it claims and the skill it carries', async () => {
    const plugins = await pluginCheck(SHIPPED);
    expect(plugins.ok, plugins.detail).toBe(true);
    expect(plugins.detail).toContain('4 installed');
    expect(plugins.detail).toContain('  · instruction — ');
    expect(plugins.detail).toContain('      commands: instruction');
    expect(plugins.detail).toContain('      skills: sw-instruct (en, zh)');
    // The word really is the plugin's claim, not a core word the core keeps.
    expect(plugins.detail).not.toContain('command "instruction" is a word this core already answers');

    const superworker = open(root, { pluginsDir: SHIPPED });
    const commands = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'commands')!;
    expect(commands.detail).toBe('no plugin command claims a core word');
    expect(commands.ok).toBe(true);
    expect((await superworker.conductor.pluginCommands()).map((entry) => entry.name)).toEqual(['instruction', 'issue']);
  });

  it('the instruction word answers through the plugin: the account reads and writes on a project with the plugin installed', async () => {
    const io = { root, pluginsDir: SHIPPED };
    expect((await answer(['instruction', 'list'], io)).stdout).toContain('no instruction record at all');
    const added = await answer(['instruction', 'add', '--scope', 'global', '--text', 'from the word surface'], io);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('INSTRUCTION i-0001: [global/stage] from the word surface');
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(true);
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toContain('from the word surface');
  });
});

describe('the folder taken away', () => {
  it('a project without the plugin: the word answers "no such word", doctor lists no plugin, and the rest of the surface goes on', async () => {
    const io = { root };
    const missing = await answer(['instruction', 'list'], io);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('no word `instruction` in this table');

    const plugins = await pluginCheck();
    expect(plugins.ok, plugins.detail).toBe(true);
    expect(plugins.detail).toContain('0 installed');
    expect(plugins.detail).not.toContain('  · instruction');

    // The other words are untouched: a record word still answers, and a write of the account is gone
    // rather than landing somewhere else.
    const nodes = await answer(['dag', 'list'], io);
    expect(nodes.code).toBe(0);
    expect(nodes.stdout.trim()).toBe('[]');
    expect((await answer(['instruction', 'add', '--text', 'x', '--scope', 'global'], io)).code).toBe(2);
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });
});

describe('the close-time cell this plugin occupies', () => {
  it('both doors answer "none this round": no node is inserted and no record is read', () => {
    expect(offer()).toBeNull();
    expect(offer_preview()).toBeNull();
  });

  it('a verbatim copy of the repo folder is installed by a project that wants it, and the repo copy keeps its bytes', async () => {
    const bytes = ['plugin.json', 'impl.mjs', 'tools/commands.mjs', 'tools/storage.mjs'].map((rel) =>
      readFileSync(join(REPO_PLUGIN, ...rel.split('/'))),
    );
    cpSync(REPO_PLUGIN, join(root, 'plugins', 'instruction'), { recursive: true });
    const plugins = await pluginCheck();
    expect(plugins.ok, plugins.detail).toBe(true);
    expect(plugins.detail).toContain('1 installed');
    expect(plugins.detail).toContain('      skills: sw-instruct (en, zh)');
    ['plugin.json', 'impl.mjs', 'tools/commands.mjs', 'tools/storage.mjs'].forEach((rel, index) => {
      expect(readFileSync(join(REPO_PLUGIN, ...rel.split('/'))).equals(bytes[index]!)).toBe(true);
    });
  });
});