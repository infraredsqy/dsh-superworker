import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../src/plugins/context';
import { implOf, loadPlugins } from '../src/plugins/registry';
import { makeLab, type PluginLab } from './helpers/plugin-lab';
import type { PluginContext } from '../src/plugins/types';

/**
 * The issue plugin's own judgement (`offer`), asked through the engine's real context: the
 * installed copy is the very folder under `plugins/issue/`, with one declaration cell taken out
 * for the scene at hand, and the round's scene (the knob chain, the ticket) laid down in the lab.
 * What is pinned here is the rule the command surface cannot see: a metric whose declared reading
 * names no source is not judged — the plugin does not invent a source to pick the ticket's number
 * up through, so a crossed line with a stating ticket still stays silent.
 *
 * (Such a declaration is also a declaration problem, so the runtime gate never asks this plugin on
 * a real close; the question is put here directly, the way doctor's stand-in does.)
 */

const SHIPPED = fileURLToPath(new URL('../plugins/issue', import.meta.url));

/** Lay a cycle down in state.json: a coding cycle with the pool line drawn at 5. */
function holdingCycle(root: string, id: string): void {
  const record = {
    id,
    title: `cycle ${id}`,
    status: 'active',
    holding: [],
    path: [],
    tags: ['coding'],
    policies: { issue_pool_weight_limit: 5 },
    created_at: '2020-01-01T00:00:02Z',
    updated_at: '2020-01-01T00:00:02Z',
  };
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({ cycles: [record] }, null, 2), 'utf8');
}

/** Install this repo's copy and take `source` out of the reading's declaration cell. */
function installWithoutSource(lab: PluginLab): string {
  const folder = join(lab.root, 'plugins', 'issue');
  cpSync(SHIPPED, folder, { recursive: true });
  const path = join(folder, 'plugin.json');
  const decl = JSON.parse(readFileSync(path, 'utf8')) as {
    readings: { issue_pool_weight: { source?: string } };
  };
  delete decl.readings.issue_pool_weight.source;
  writeFileSync(path, JSON.stringify(decl, null, 2), 'utf8');
  return folder;
}

describe('the issue plugin at the close: a metric with no declared source is not judged', () => {
  let lab: PluginLab;
  let warnings: string[];

  beforeEach(async () => {
    lab = makeLab('superworker-issue-offer-');
    await lab.superworker.ledger.init();
    holdingCycle(lab.root, 'c1');
    installWithoutSource(lab);
    warnings = [];
  });

  afterEach(() => {
    lab.cleanup();
  });

  it('a declaration whose reading names no source stays silent even with the line crossed and the ticket stating a number: no invented source picks the ticket number up', async () => {
    const { folders } = await loadPlugins(join(lab.root, 'plugins'));
    const ctx = createContext({
      root: lab.root,
      folders,
      homeDir: lab.home,
      warnings,
      cycle: { id: 'c1', tags: ['coding'] },
      // The round's handoff ticket, stating the pool's number (the cell a `ticket` source reads).
      sig: { outputs: { reading: { issue_pool_weight: 900 } } },
    });
    const impl = (await implOf(folders.find((entry) => entry.name === 'issue')!)) as {
      offer(ctx: PluginContext): Promise<unknown>;
    };
    const offer = await impl.offer(ctx);
    expect(offer).toBeNull();
    expect(warnings).toEqual([]);
  });
});
