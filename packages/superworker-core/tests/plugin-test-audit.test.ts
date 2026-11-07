import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createConductorNamespace, warningsOf } from '../src/conductor';
import { makeLab, type PluginLab } from './helpers/plugin-lab';

/**
 * End to end for the test-audit plugin (the first real plugin in this repo): what gets installed
 * into the plugin dir is the very copy under `plugins/test-audit/` (declaration, implementation,
 * skills and design notes travel with it), and the plugin works out its verdict itself before
 * offer -- all four situations (over the line, switch off, no reading, already deduped) are walked
 * here through the public handle. The byte-for-byte half lives in
 * `tests/fixtures/plugin-test-audit-close-insert/` (the expected bytes are produced by the
 * generating side and replayed by `tests/corpus.test.ts`); here only the invariants a reader can
 * see are pinned.
 *
 * Engine operations all land in a temp project root; home is walled into `_home` inside that root,
 * so machine-wide settings never touch the real machine.
 */

const SHIPPED = fileURLToPath(new URL('../plugins/test-audit', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/plugin-test-audit-close-insert', import.meta.url));

/** The dedupe tag this metric hangs on a node, spelled the same as `metrics.test_seconds.tag` in the declaration. */
const DEDUPE_TAG = 'test-audit:test_seconds';

/** The mark that identifies this plugin. */
const TITLE_HEAD = 'Maintenance:';

/** Install this repo's copy into the temp project root: one plugin folder is its whole identity. */
function installShipped(lab: PluginLab): string {
  const folder = join(lab.root, 'plugins', 'test-audit');
  cpSync(SHIPPED, folder, { recursive: true });
  return folder;
}

/** Lay a cycle down in state.json: tags and the cycle-layer knob take the given values (`line: 'unset'` means nothing configured). */
function holdingCycle(
  root: string,
  id: string,
  nodes: readonly string[],
  options: { readonly tags?: readonly string[]; readonly line?: number | 'unset' } = {},
): void {
  const record: Record<string, unknown> = {
    id,
    title: `cycle ${id}`,
    status: 'active',
    holding: nodes.map((node) => ({ id: node, since: '2020-01-01T00:00:02Z' })),
    path: [],
    tags: options.tags ?? ['coding'],
    created_at: '2020-01-01T00:00:02Z',
    updated_at: '2020-01-01T00:00:02Z',
  };
  if (options.line !== 'unset') record.policies = { test_seconds_limit: options.line ?? 300 };
  writeFileSync(join(root, '.superworker', 'state.json'), JSON.stringify({ cycles: [record] }, null, 2), 'utf8');
}

/** Drop a finished handoff; when `reading` is not given the whole cell stays out (this round had no such number). */
function putSignal(
  root: string,
  cycle: string,
  node: string,
  reading?: Record<string, unknown>,
): void {
  const outputs: Record<string, unknown> = { deliverable: `.superworker/nodes/${node}/sw-conduct.md`, touched: [] };
  if (reading !== undefined) outputs.reading = reading;
  const path = join(root, '.superworker', 'signals', cycle, `${node}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { cycle, node, status: 'completed', summary: 'delivered', outputs, timestamp: '2020-01-01T00:00:03Z' },
      null,
      2,
    ),
    'utf8',
  );
}

/** A handle for closing out: home walled into the temp project root, the plugin dir at the default `<root>/plugins`. */
function closer(lab: PluginLab) {
  return createConductorNamespace(lab.root, undefined, { homeDir: lab.home });
}

/** Lay out a scene: an init-ed root, a node this cycle holds, and a handoff that stated a result. */
async function seeded(
  prefix: string,
  options: {
    readonly reading?: Record<string, unknown>;
    readonly line?: number | 'unset';
    readonly tags?: readonly string[];
  } = {},
) {
  const lab = makeLab(prefix);
  await lab.superworker.ledger.init();
  const nodeId = (await lab.superworker.ledger.dag.add({ title: 'held node' })).id;
  holdingCycle(lab.root, 'c1', [nodeId], { line: options.line, tags: options.tags });
  putSignal(lab.root, 'c1', nodeId, options.reading);
  installShipped(lab);
  return { lab, nodeId };
}

/** The rows this plugin inserted into the graph (titles starting with `Maintenance:`). */
async function insertedRows(lab: PluginLab) {
  return (await lab.superworker.ledger.dag.list()).filter((row) => row.title.startsWith(TITLE_HEAD));
}

describe('insertion at close: only over the line, one live node per cycle', () => {
  it('over the line: one node inserted, the dedupe tag and the cycle tags on it, the body written into spec.md', async () => {
    const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: 900 } });
    try {
      await closer(lab).close({ cycle: 'c1', node: nodeId });
      const rows = await insertedRows(lab);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe(
        "Maintenance: the project test suite's full wall clock (seconds) = 900s, over the line 300s",
      );
      expect(rows[0]!.tags).toEqual([DEDUPE_TAG, 'coding']);
      const record = await lab.superworker.ledger.dag.get(rows[0]!.id);
      expect(record!.status).toBe('todo');
      expect(record!.mode).toBe('auto');
      expect(record!.dependencies).toEqual([nodeId]);
      // The description cell holds the body as a JSON literal; in the body the self-reference is a
      // placeholder while spec.md carries the real id.
      const text = JSON.parse(String(record!.description)) as string;
      expect(text.startsWith('# Maintenance node (generated by the tool)')).toBe(true);
      expect(text).toContain('`method: sw-test-audit`');
      expect(text).toContain("must be **below** 300s");
      const specFile = join(lab.root, '.superworker', 'nodes', rows[0]!.id, 'spec.md');
      expect(readFileSync(specFile, 'utf8')).toBe(text.replaceAll('%DUID%', rows[0]!.id));
    } finally {
      lab.cleanup();
    }
  });

  it('reading exactly the line: the `>=` rule -- the line is still the last acceptable number, so it inserts', async () => {
    const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: 300 } });
    try {
      await closer(lab).close({ cycle: 'c1', node: nodeId });
      expect(await insertedRows(lab)).toHaveLength(1);
    } finally {
      lab.cleanup();
    }
  });

  it('below the line: nothing inserted, and the close still settles', async () => {
    const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: 299 } });
    try {
      const returned = await closer(lab).close({ cycle: 'c1', node: nodeId });
      expect(await insertedRows(lab)).toEqual([]);
      expect(returned.id).toBe('c1');
      expect(returned.holding).toEqual([]);
      expect(returned.path[0]).toMatchObject({ node: nodeId, result: 'completed' });
      expect(warningsOf(returned as object)).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it('no duplicate on the same cycle: a todo node already carrying the dedupe tag means no insert, wait for it', async () => {
    const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: 900 } });
    try {
      await lab.superworker.ledger.dag.add({ title: 'already open audit debt', tags: [DEDUPE_TAG] });
      await closer(lab).close({ cycle: 'c1', node: nodeId });
      expect(await insertedRows(lab)).toEqual([]);
      // That debt stays on the graph by itself, waiting to be closed.
      const open = (await lab.superworker.ledger.dag.list()).find((row) => row.title === 'already open audit debt');
      expect(open!.status).toBe('todo');
    } finally {
      lab.cleanup();
    }
  });

  it('the cycle knob was never configured: nothing judged and nothing asked, the close goes on (a project that never configured the line is not touched by this plugin)', async () => {
    const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: 900 }, line: 'unset' });
    try {
      await closer(lab).close({ cycle: 'c1', node: nodeId });
      expect(await insertedRows(lab)).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });
});

describe('switch and missing reading: the whole thing steps aside, and a missing number means "this round does not know"', () => {
  it('switch turned off: over the line still inserts nothing (project-level off overrides the declared on)', async () => {
    const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: 900 } });
    try {
      writeFileSync(join(lab.root, '.superworker', 'config.json'), JSON.stringify({ test_audit: 'off' }), 'utf8');
      await closer(lab).close({ cycle: 'c1', node: nodeId });
      expect(await insertedRows(lab)).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it('no reading cell on the handoff: nothing inserted, and a line of 0 still does not turn the missing number into 0', async () => {
    // A line written as 0 (the ordinary write path never takes 0; here the record is laid down
    // directly) is the only scene that separates "fill a missing reading with 0" from the rest:
    // were it read as 0, 0 >= 0 would insert.
    const { lab, nodeId } = await seeded('sw-test-audit-', { line: 0 });
    try {
      const returned = await closer(lab).close({ cycle: 'c1', node: nodeId });
      expect(await insertedRows(lab)).toEqual([]);
      expect(warningsOf(returned as object)).toEqual([]);
    } finally {
      lab.cleanup();
    }
  });

  it('the reading cell is there but is not a number (string / boolean): treated as no number, nothing inserted', async () => {
    for (const value of ['900', true]) {
      const { lab, nodeId } = await seeded('sw-test-audit-', { reading: { test_seconds: value } });
      try {
        await closer(lab).close({ cycle: 'c1', node: nodeId });
        expect(await insertedRows(lab), `reading=${JSON.stringify(value)}`).toEqual([]);
      } finally {
        lab.cleanup();
      }
    }
  });

  it('the reading is an empty table, or carries another key: this round does not know, nothing inserted', async () => {
    for (const reading of [{}, { test_seconds_other: 900 }]) {
      const { lab, nodeId } = await seeded('sw-test-audit-', { reading });
      try {
        await closer(lab).close({ cycle: 'c1', node: nodeId });
        expect(await insertedRows(lab), `reading=${JSON.stringify(reading)}`).toEqual([]);
      } finally {
        lab.cleanup();
      }
    }
  });
});

describe('doctor: this copy is healthy, and a broken declaration is reported', () => {
  it('a healthy plugin: ok, and it says how many are installed (both skill sets are there, and the method name has a skill of its own)', async () => {
    const lab = makeLab('sw-test-audit-doctor-');
    try {
      await lab.superworker.ledger.init();
      installShipped(lab);
      const report = await lab.superworker.conductor.doctor();
      const plugins = report.checks.find((check) => check.name === 'plugins')!;
      expect(plugins.ok, plugins.detail).toBe(true);
      expect(plugins.detail).toContain('1 installed');
      expect(report.ok).toBe(true);
    } finally {
      lab.cleanup();
    }
  });

  it('an unknown key in the declaration: doctor reports that sentence, and the plugin does nothing this round', async () => {
    const lab = makeLab('sw-test-audit-doctor-');
    try {
      await lab.superworker.ledger.init();
      const folder = installShipped(lab);
      const decl = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>;
      decl.wat = 1;
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify(decl, null, 2), 'utf8');
      const report = await lab.superworker.conductor.doctor();
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('unknown key "wat"');
      expect(report.ok).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a metric judged against a line nobody declared: doctor reports that sentence', async () => {
    const lab = makeLab('sw-test-audit-doctor-');
    try {
      await lab.superworker.ledger.init();
      const folder = installShipped(lab);
      const decl = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as {
        metrics: { test_seconds: { line: string } };
      };
      decl.metrics.test_seconds.line = 'nope';
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify(decl, null, 2), 'utf8');
      const report = await lab.superworker.conductor.doctor();
      const detail = report.checks.find((check) => check.name === 'plugins')!.detail ?? '';
      expect(detail).toContain('is judged against "nope"');
      expect(report.ok).toBe(false);
    } finally {
      lab.cleanup();
    }
  });
});

describe('the deliverable itself: fixture and skills travel with the plugin', () => {
  it('the declaration and implementation in the fixture input are byte for byte the copy in this repo', () => {
    for (const name of ['plugin.json', 'impl.mjs']) {
      const shipped = readFileSync(join(SHIPPED, name), 'utf8');
      const inFixture = readFileSync(join(FIXTURE, 'input', 'plugins', 'test-audit', name), 'utf8');
      expect(inFixture, name).toBe(shipped);
    }
  });

  it('skills travel with the plugin: all four files are there in both the zh and the en set', () => {
    for (const lang of ['zh', 'en']) {
      for (const name of ['SKILL.md', 'anti-patterns.md', 'compression-criteria.md', 'garbage-patterns.md']) {
        expect(existsSync(join(SHIPPED, 'skills', lang, 'sw-test-audit', name)), `${lang}/${name}`).toBe(true);
      }
    }
    expect(existsSync(join(SHIPPED, 'docs', 'design.md'))).toBe(true);
  });
});