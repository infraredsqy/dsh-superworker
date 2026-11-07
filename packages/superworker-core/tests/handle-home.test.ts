import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/open';
import { recordPaths, sessionNotePath } from '../src/paths';

/**
 * One handle, one machine layer: `RecordOpenOptions.homeDir` names the home the namespaces that read
 * that layer go through — `config`'s global layer, and `conductor`'s dispatch preparation and plugin
 * context. The switch stays underneath the option, so a handle that names no home answers from
 * `SUPERWORKER_HOME_DIR`; either way those faces agree on the same reading.
 *
 * The session note is not one of them any more: the host column is this engine's own host, read off
 * the record and never off a setting, so the same note reads the same under either home.
 */

let root: string;
let homeA: string;
let homeB: string;
let savedHome: string | undefined;

/** Write one machine-layer settings file (`<home>/.superworker/config.json`). */
function writeHome(home: string, values: Record<string, unknown>): void {
  mkdirSync(join(home, '.superworker'), { recursive: true });
  writeFileSync(join(home, '.superworker', 'config.json'), JSON.stringify(values, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-handle-home-'));
  homeA = join(root, '_home-a');
  homeB = join(root, '_home-b');
  // Two machine layers that answer the knob differently.
  writeHome(homeA, { max_agents: 5 });
  writeHome(homeB, { max_agents: 9 });
  savedHome = process.env.SUPERWORKER_HOME_DIR;
  process.env.SUPERWORKER_HOME_DIR = homeB;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.SUPERWORKER_HOME_DIR;
  else process.env.SUPERWORKER_HOME_DIR = savedHome;
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

/** One node with a session note naming another implementation's host word: the page's host column must not follow a setting. */
async function plant(): Promise<string> {
  const superworker = open(root);
  await superworker.ledger.init();
  const node = (await superworker.ledger.dag.add({ title: 'A' })).id;
  mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
  writeFileSync(sessionNotePath(recordPaths(root), node), JSON.stringify({
    v: 1,
    discussion: [],
    run: [{ session: 'sess_r1', host: 'zcode', at: '2026-01-01T00:00:00Z' }],
  }, null, 2));
  return node;
}

describe('the handle homeDir: one machine layer for the settings faces', () => {
  it('config answers from the home the handle names, not from the switch', async () => {
    const node = await plant();
    const superworker = open(root, { homeDir: homeA });

    expect(await superworker.config.get('max_agents')).toEqual({ value: 5, source: 'global' });
    // The session lists read off the record: the written word is data, and the host is this engine's own.
    expect((await superworker.sessions.show(node)).run[0]!.host).toBe('dsh');
    expect((await superworker.sessions.list())[0]!.note.run[0]!.host).toBe('dsh');
    expect((await superworker.ledger.dag.info(node)).sessions!.run[0]!.host).toBe('dsh');
  });

  it('with no home named the switch speaks, and the session faces answer the same way', async () => {
    const node = await plant();
    const superworker = open(root);

    expect(await superworker.config.get('max_agents')).toEqual({ value: 9, source: 'global' });
    expect((await superworker.sessions.show(node)).run[0]!.host).toBe('dsh');
    expect((await superworker.sessions.list())[0]!.note.run[0]!.host).toBe('dsh');
    expect((await superworker.ledger.dag.info(node)).sessions!.run[0]!.host).toBe('dsh');
  });
});
