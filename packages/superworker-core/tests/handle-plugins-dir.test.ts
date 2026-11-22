import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * `RecordOpenOptions.pluginsDir`: the handle can be told which plugin folder to scan.
 *
 * The shipped set (`plugins/` in this package) answers through a handle that names that folder,
 * without a copy into the project. A handle that names nothing reads the folder it always read —
 * `<root>/plugins` (then `SUPERWORKER_PLUGINS_DIR`), which these temp projects do not have, so the
 * shipped set stays dead there exactly as before.
 *
 * Engine work happens in a temp project root; home is walled into `_home` inside it. The shipped
 * folder is only ever scanned and its implementation loaded in place.
 */

const SHIPPED = fileURLToPath(new URL('../plugins', import.meta.url));

let root: string;
let home: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-handle-plugins-'));
  home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  savedEnv = process.env.SUPERWORKER_PLUGINS_DIR;
  delete process.env.SUPERWORKER_PLUGINS_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.SUPERWORKER_PLUGINS_DIR;
  else process.env.SUPERWORKER_PLUGINS_DIR = savedEnv;
});

/** The handle over the temp project, naming the shipped folder (or not). */
function handle(named: boolean) {
  return open(root, {
    homeDir: home,
    ...(named ? { pluginsDir: SHIPPED } : {}),
  });
}

describe('the handle names the shipped plugin folder', () => {
  it('pluginCommands answers the shipped `issue` word; a handle naming nothing stays without it', async () => {
    const named = await handle(true).conductor.pluginCommands();
    expect(named.map((entry) => entry.name)).toContain('issue');

    const unnamed = await handle(false).conductor.pluginCommands();
    expect(unnamed.map((entry) => entry.name)).not.toContain('issue');
    expect(unnamed).toEqual([]);
  });

  it('the knobs the shipped set declares ride the same handle: on the list when named, off it when not', async () => {
    await handle(false).ledger.init();
    const named = await handle(true).config.keys();
    expect(named).toContain('issue_pool_weight_limit');
    expect(named).toContain('test_seconds_limit');

    const unnamed = await handle(false).config.keys();
    expect(unnamed).not.toContain('issue_pool_weight_limit');
    expect(unnamed).not.toContain('test_seconds_limit');
  });

  it('a knob narrowed to the machine layer is still a name the settings verbs take: it sets, it reads back, and the project layer still refuses it', async () => {
    await handle(false).ledger.init();
    const superworker = handle(true);
    // `answer` takes the machine layer alone. A list narrowed to the project layer would leave a knob
    // doctor prints and `list` shows with no word able to name it, so it has to be here.
    expect(await superworker.config.keys()).toContain('answer');
    expect(await superworker.config.get('answer')).toEqual({ value: 'plain', source: 'builtin' });

    await superworker.config.set('answer', 'technical', { global: true });
    expect(await superworker.config.get('answer')).toEqual({ value: 'technical', source: 'global' });

    // The name is taken now; the layer it does not reach stays refused, and the refusal names the one it does.
    await expect(superworker.config.set('answer', 'plain', { project: true })).rejects.toThrow(
      'answer does not take the project layer (it takes: global); nothing was written',
    );
    expect(await superworker.config.get('answer')).toEqual({ value: 'technical', source: 'global' });

    await superworker.config.unset('answer', { global: true });
    expect(await superworker.config.get('answer')).toEqual({ value: 'plain', source: 'builtin' });
  });
});

describe('the copy-the-plugins shape keeps working beside the option', () => {
  it('a project that carries its own `plugins/` folder reads it, as always', async () => {
    await handle(false).ledger.init();
    cpSync(join(SHIPPED, 'test-audit'), join(root, 'plugins', 'test-audit'), { recursive: true });
    const keys = await handle(false).config.keys();
    expect(keys).toContain('test_seconds_limit');
    expect(keys).not.toContain('issue_pool_weight_limit');
  });
});
