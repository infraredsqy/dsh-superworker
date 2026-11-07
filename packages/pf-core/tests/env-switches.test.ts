import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfigNamespace } from '../src/config';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { globalConfigPath } from '../src/paths';
import { pluginAssemblyOf } from '../src/plugins/assembly';
import { pluginsDirOf } from '../src/plugins/registry';

/**
 * The five runtime switches: each one is read on the call that needs it, and an explicit option on
 * that call always wins over the environment. One case per switch pins the reading; the cases
 * together also pin the rule that matters when nothing is set — the behaviour is the one it had
 * before these switches existed (no word on the dispatch request, the default home and plugin
 * folder, no session note).
 *
 * Every case clears all five names first and puts the machine's own values back afterwards, so the
 * suite never depends on what the machine happened to export.
 */

const NAMES = [
  'PF_HOME_DIR',
  'PF_PLUGINS_DIR',
  'DSH_CONDUCT_SPAWN_DRY_RUN',
  'DSH_CONDUCT_MODEL',
  'DSH_SESSION_ID',
] as const;

let saved: Record<string, string | undefined> = {};
let root: string;
const extraRoots: string[] = [];

beforeEach(() => {
  saved = {};
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  root = mkdtempSync(join(tmpdir(), 'pf-env-'));
});

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const dir of extraRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** One fresh project with a single todo node held by the only active line: the cell a dispatch acts on. */
async function station(): Promise<{ root: string; node: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'pf-env-dispatch-'));
  extraRoots.push(dir);
  const pf = open(dir);
  await pf.ledger.init();
  const node = (await pf.ledger.dag.add({ title: 'one node' })).id;
  await pf.ledger.cycles.create({ id: 'main', tags: ['coding'] });
  await pf.ledger.cycles.hold('main', node);
  return { root: dir, node };
}

/** Write one settings layer file (`<home>/.pf/config.json`). */
function writeHome(home: string, values: Record<string, unknown>): void {
  mkdirSync(join(home, '.pf'), { recursive: true });
  writeFileSync(join(home, '.pf', 'config.json'), JSON.stringify(values, null, 2));
}

/** Write one plugin folder holding a valid close-time insert declaration (the knob it declares is what the settings list gains). */
function writePlugin(pluginsDir: string, name: string, knob: string): void {
  const folder = join(pluginsDir, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({
    summary: 'a probe plugin',
    enable_knob: knob,
    timing: 'close',
    action: 'insert',
    knobs: { [knob]: { kind: 'switch', default: 'on', summary: 'the probe switch' } },
  }, null, 2));
  writeFileSync(join(folder, 'impl.mjs'), 'export function register() {}\n');
}

describe('PF_HOME_DIR: the machine layer home', () => {
  it('moves the global layer; read on every call, and an explicit homeDir still wins', async () => {
    const homeA = join(root, '_home-a');
    const homeB = join(root, '_home-b');
    const homeC = join(root, '_home-c');
    writeHome(homeA, { max_agents: 7 });
    writeHome(homeB, { max_agents: 9 });
    writeHome(homeC, { max_agents: 11 });
    await open(root).ledger.init();

    process.env.PF_HOME_DIR = homeA;
    expect(await open(root).config.get('max_agents')).toEqual(
      expect.objectContaining({ value: 7, source: 'global' }),
    );
    // The same project is asked again after the switch moved: nothing was cached at the first read.
    process.env.PF_HOME_DIR = homeB;
    expect(await open(root).config.get('max_agents')).toEqual(
      expect.objectContaining({ value: 9, source: 'global' }),
    );
    // The option the call names wins over the switch.
    expect(await createConfigNamespace(root, { homeDir: homeC }).get('max_agents')).toEqual(
      expect.objectContaining({ value: 11, source: 'global' }),
    );
    // Nothing named and nothing exported: the machine's own home directory, as before.
    delete process.env.PF_HOME_DIR;
    expect(globalConfigPath()).toBe(join(homedir(), '.pf', 'config.json'));
  });
});

describe('PF_PLUGINS_DIR: the plugin folder', () => {
  it('moves the folder; blank reads the default, and an explicit pluginsDir still wins', async () => {
    const moved = join(root, '_plugins-env');
    const named = join(root, '_plugins-option');
    writePlugin(moved, 'probe', 'probe_on');
    mkdirSync(named, { recursive: true });
    await open(root).ledger.init();

    process.env.PF_PLUGINS_DIR = moved;
    // The declaration is read from the folder the switch names: its knob is on the settings list.
    expect((await open(root).config.get('probe_on')).value).toBe('on');
    // The folder the call names wins over the switch: it holds no plugin, so no declaration is read.
    expect(await (await pluginAssemblyOf(root, named).folders())).toEqual([]);

    // A blank value reads the default `<root>/plugins`, which this project does not have.
    process.env.PF_PLUGINS_DIR = '   ';
    expect(pluginsDirOf(root)).toBe(join(root, 'plugins'));
    expect(await (await pluginAssemblyOf(root).folders())).toEqual([]);
  });

  it('a value opening with ~ is expanded to the machine home, after its edges are trimmed', async () => {
    const machineHome = join(root, '_machine-home');
    writePlugin(join(machineHome, '_plugins'), 'probe', 'probe_on');
    await open(root).ledger.init();
    const savedUser = process.env.USERPROFILE;
    const savedHome = process.env.HOME;
    process.env.USERPROFILE = machineHome;
    process.env.HOME = machineHome;
    try {
      // The edges go first, so the tilde still opens the value that is left.
      process.env.PF_PLUGINS_DIR = '  ~/_plugins  ';
      expect(pluginsDirOf(root)).toBe(join(machineHome, '_plugins'));
      // The scan follows the same expanded path: the declaration in that folder is on the list.
      expect((await open(root).config.get('probe_on')).value).toBe('on');

      // A bare tilde is the machine home itself.
      process.env.PF_PLUGINS_DIR = '~';
      expect(pluginsDirOf(root)).toBe(machineHome);
    } finally {
      if (savedUser === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUser;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

describe('DSH_CONDUCT_MODEL: the model route the next session opens with', () => {
  it('rides on the dispatch request as one word; the call and the line policy both beat it', async () => {
    process.env.DSH_CONDUCT_MODEL = 'deepseek/deepseek-v4.1-flash';

    // The switch alone: the whole route is carried to the opener as one word.
    const first = await station();
    const sim = new SimulatedExecutor();
    await open(first.root, { executor: sim }).conductor.dispatch({ cycle: 'main' });
    expect(sim.dispatched[0]).toEqual(expect.objectContaining({ model: 'deepseek/deepseek-v4.1-flash' }));

    // The call's own route is the most specific answer for this one dispatch.
    const second = await station();
    const simCall = new SimulatedExecutor();
    await open(second.root, { executor: simCall })
      .conductor.dispatch({ cycle: 'main', model: 'qianfan/ernie' });
    expect(simCall.dispatched[0]!.model).toBe('qianfan/ernie');

    // The line's own policy beats the machine's switch.
    const third = await station();
    await open(third.root).ledger.cycles.setPolicy('main', 'model', 'deepseek/deepseek-v4.1');
    const simLine = new SimulatedExecutor();
    await open(third.root, { executor: simLine }).conductor.dispatch({ cycle: 'main' });
    expect(simLine.dispatched[0]!.model).toBe('deepseek/deepseek-v4.1');
  });

  it('a route is one word: a value with a blank in it is refused when the line policy is written', async () => {
    const { root: dir } = await station();
    await expect(open(dir).ledger.cycles.setPolicy('main', 'model', 'deepseek flash')).rejects.toThrow();
    await expect(open(dir).ledger.cycles.setPolicy('main', 'model', 'not a route')).rejects.toThrow();
  });

  it('with nothing said the request carries no model word at all', async () => {
    const { root: dir } = await station();
    const sim = new SimulatedExecutor();
    await open(dir, { executor: sim }).conductor.dispatch({ cycle: 'main' });
    expect('model' in sim.dispatched[0]!).toBe(false);
  });
});

describe('DSH_CONDUCT_SPAWN_DRY_RUN: the drill switch', () => {
  it('is on for anything but the four off words, and the request carries dryRun only when it is on', async () => {
    for (const off of ['', '0', 'false', 'False']) {
      process.env.DSH_CONDUCT_SPAWN_DRY_RUN = off;
      const { root: dir } = await station();
      const sim = new SimulatedExecutor();
      await open(dir, { executor: sim }).conductor.dispatch({ cycle: 'main' });
      expect('dryRun' in sim.dispatched[0]!).toBe(false);
    }

    process.env.DSH_CONDUCT_SPAWN_DRY_RUN = '1';
    const { root: dir } = await station();
    const sim = new SimulatedExecutor();
    await open(dir, { executor: sim }).conductor.dispatch({ cycle: 'main' });
    expect(sim.dispatched[0]).toEqual(expect.objectContaining({ dryRun: true }));
  });

  it('a rehearsal never strands the cell: no `started` claim lands, and the plan still says dispatch', async () => {
    process.env.DSH_CONDUCT_SPAWN_DRY_RUN = '1';
    const { root: dir, node } = await station();
    const pf = open(dir, { executor: new SimulatedExecutor() });
    const receipt = await pf.conductor.dispatch({ cycle: 'main' });
    expect(receipt.action).toBe('opened');
    const claim = join(dir, '.pf', 'meta', 'launch', 'main', node, 'started');
    expect(existsSync(claim)).toBe(false);
    expect((await pf.conductor.next({ cycle: 'main' })).action).toBe('dispatch');
  });
});

describe('DSH_SESSION_ID: the session this process runs in', () => {
  it('registers the node with its discussion note; with nothing exported no note is written', async () => {
    const pf = open(root);
    await pf.ledger.init();

    process.env.DSH_SESSION_ID = 'session-of-this-process';
    const noted = (await pf.ledger.dag.add({ title: 'the one with a session' })).id;
    const page = await pf.sessions.show(noted);
    expect(page.discussion).toEqual([
      expect.objectContaining({ session: 'session-of-this-process', host: 'dsh' }),
    ]);
    expect(page.discussion[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    delete process.env.DSH_SESSION_ID;
    const bare = (await pf.ledger.dag.add({ title: 'the one without a session' })).id;
    expect((await pf.sessions.show(bare)).discussion).toEqual([]);
  });
});
