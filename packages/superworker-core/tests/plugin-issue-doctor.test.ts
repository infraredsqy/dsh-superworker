import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLab, type PluginLab } from './helpers/plugin-lab';

/**
 * doctor reports broken declarations: the repo's issue plugin is copied **as-is** into a temp
 * project, then the copy's declaration and implementation are deliberately broken, so doctor
 * can name each broken spot one by one; the repo copy must not change by a single byte (its
 * bytes are pinned before and after).
 */

const REPO_PLUGIN = new URL('../plugins/issue', import.meta.url);

const FILES = ['plugin.json', 'impl.mjs', 'tools/commands.mjs', 'tools/storage.mjs'];

function repoFile(rel: string): string {
  return readFileSync(new URL(`../plugins/issue/${rel}`, import.meta.url), 'utf8');
}

let lab: PluginLab;
let originalBytes: Map<string, string>;

beforeEach(() => {
  lab = makeLab('superworker-issue-doctor-');
  originalBytes = new Map(FILES.map((rel) => [rel, repoFile(rel)]));
});

afterEach(() => {
  lab.cleanup();
});

/** Copy it in as-is, then break the copy the given way; the repo original is left alone. */
function installCorruptedCopy(mutate: (decl: Record<string, unknown>) => void, breakImpl: boolean): void {
  const folder = join(lab.root, 'plugins', 'issue');
  cpSync(REPO_PLUGIN, folder, { recursive: true });
  const decl = JSON.parse(repoFile('plugin.json')) as Record<string, unknown>;
  mutate(decl);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify(decl, null, 2), 'utf8');
  if (breakImpl) writeFileSync(join(folder, 'impl.mjs'), 'export function offer( { broken syntax\n', 'utf8');
}

describe('doctor is strict about a copy of the issue plugin', () => {
  it('a verbatim copy is healthy: 1 installed, no complaint, and its knobs and commands clash with no built-in', async () => {
    cpSync(REPO_PLUGIN, join(lab.root, 'plugins', 'issue'), { recursive: true });
    await lab.superworker.ledger.init();
    const report = await lab.superworker.conductor.doctor();
    const plugins = report.checks.find((check) => check.name === 'plugins')!;
    expect(plugins.ok).toBe(true);
    expect(plugins.detail).toContain('1 installed');
    expect(plugins.detail).not.toContain('plugin "issue"');
    expect(report.ok).toBe(true);
  });

  it('a deliberately broken copy: doctor names each spot — unknown key, line not declared, missing dedup tag, implementation that will not load', async () => {
    await lab.superworker.ledger.init();
    installCorruptedCopy((decl) => {
      decl.wat = 1;
      const metrics = (decl.metrics as Record<string, Record<string, unknown>>).issue_pool_weight;
      metrics.line = 'not_declared';
      delete metrics.tag;
    }, true);
    const report = await lab.superworker.conductor.doctor();
    expect(report.ok).toBe(false);
    const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
    expect(detail).toContain('plugin "issue"');
    expect(detail).toContain('unknown key "wat"');
    expect(detail).toContain('metric "issue_pool_weight" is judged against "not_declared", which the plugin does not declare as a knob');
    expect(detail).toContain('metric "issue_pool_weight" needs a tag');
    expect(detail).toContain('impl.mjs failed to load');
  });

  it('the repo original stays untouched: however the copy is broken, the original keeps its bytes and stays on disk', async () => {
    await lab.superworker.ledger.init();
    installCorruptedCopy((decl) => {
      decl.wat = 1;
    }, true);
    await lab.superworker.conductor.doctor();
    for (const [rel, bytes] of originalBytes) {
      expect(existsSync(new URL(`../plugins/issue/${rel}`, import.meta.url))).toBe(true);
      expect(repoFile(rel)).toBe(bytes);
    }
  });
});
