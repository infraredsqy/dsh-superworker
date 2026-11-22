import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as impl from '../plugins/instruction/impl.mjs';
import { open } from '../src/open';
import { answer } from '../src/index';

/**
 * The `instruction` plugin from the outside: what the word surface does with the shipped folder
 * in place and with the folder taken away.
 *
 * The declaration is the one authority on which word a plugin claims and which files it brings;
 * the skills are its folder's own reading (`skills/<lang>/<method>/SKILL.md`). Criterion: with the
 * folder gone, `instruction` answers "no such word" and everything else goes on.
 */

const SHIPPED = fileURLToPath(new URL('../plugins/', import.meta.url));

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

describe('the shipped set', () => {
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

describe('a commands-only declaration occupies no cell', () => {
  it('the declaration states neither timing nor action, and the impl carries no close-time door', () => {
    const decl = JSON.parse(
      readFileSync(fileURLToPath(new URL('../plugins/instruction/plugin.json', import.meta.url)), 'utf8'),
    ) as { timing?: string; action?: string };
    expect(decl.timing).toBeUndefined();
    expect(decl.action).toBeUndefined();
    expect((impl as Record<string, unknown>).offer).toBeUndefined();
    expect((impl as Record<string, unknown>).offer_preview).toBeUndefined();
  });
});