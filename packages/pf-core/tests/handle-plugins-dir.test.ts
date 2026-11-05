import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { warningsOf } from '../src/conductor';
import { open } from '../src/open';

/**
 * `PfOpenOptions.pluginsDir`: the handle can be told which plugin folder to scan.
 *
 * The shipped set (`plugins/` in this package — the `issue` command surface and the two closing
 * guards) answers through a handle that names that folder, without a copy into the project. A
 * handle that names nothing reads the folder it always read — `<root>/plugins` (then
 * `PF_PLUGINS_DIR`), which these temp projects do not have, so the shipped set stays dead there
 * exactly as before.
 *
 * Engine work happens in a temp project root; home is walled into `_home` inside it. The shipped
 * folder is only ever scanned and its implementation loaded in place — the close-time judgements
 * write into the temp project, never into the folder.
 */

const SHIPPED = fileURLToPath(new URL('../plugins', import.meta.url));

let root: string;
let home: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-handle-plugins-'));
  home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  savedEnv = process.env.PF_PLUGINS_DIR;
  delete process.env.PF_PLUGINS_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.PF_PLUGINS_DIR;
  else process.env.PF_PLUGINS_DIR = savedEnv;
});

/** The handle over the temp project, naming the shipped folder (or not). */
function handle(named: boolean) {
  return open(root, {
    homeDir: home,
    ...(named ? { pluginsDir: SHIPPED } : {}),
  });
}

/** The rows the closing guards insert into the graph (titles starting with `Maintenance:`). */
async function maintenanceRows() {
  return (await handle(true).ledger.dag.list()).filter((row) => row.title.startsWith('Maintenance:'));
}

/** Lay a coding line in service holding one node, with a finished handoff ticket on it. */
async function heldNodeWithTicket(cycleId: string, line: Record<string, unknown>): Promise<string> {
  const pf = handle(true);
  await pf.ledger.init();
  const nodeId = (await pf.ledger.dag.add({ title: 'held node', tags: ['coding'] })).id;
  const record = {
    id: cycleId,
    title: `cycle ${cycleId}`,
    status: 'active',
    tags: ['coding'],
    policies: line,
    holding: [{ id: nodeId, since: '2026-01-01T00:00:02Z' }],
    path: [],
    created_at: '2026-01-01T00:00:02Z',
    updated_at: '2026-01-01T00:00:02Z',
  };
  writeFileSync(join(root, '.pf', 'state.json'), JSON.stringify({ cycles: [record] }, null, 2), 'utf8');
  const path = join(root, '.pf', 'signals', cycleId, `${nodeId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { cycle: cycleId, node: nodeId, status: 'completed', summary: 'done', outputs: {}, timestamp: '2026-01-01T00:00:03Z' },
      null,
      2,
    ),
    'utf8',
  );
  return nodeId;
}

/** Seed the issue pool the shipped plugin's own tool computes the weight from. */
function seedPool(): void {
  const row = (id: string, severity: string) => ({
    id,
    severity,
    module: 'plugins',
    title: id,
    decision: 'autofix',
    source: 'scan',
    status: 'open',
    discovered: '2026-01-01T00:00:00.000001Z',
    updated_at: '2026-01-01T00:00:00.000001Z',
    check_count: 1,
    files: [],
    functions: [],
    description: '',
    suggestion: '',
    reason: null,
    plan_path: null,
  });
  const path = join(root, '.pf', 'issues', 'issues.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, issues: { p1: row('p1', 'P1'), p2: row('p2', 'P2') } }, null, 2), 'utf8');
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

  it('the issue-pool guard is in force through the named handle: a pool over its line inserts one node at the close', async () => {
    const nodeId = await heldNodeWithTicket('c1', { issue_pool_weight_limit: 4 });
    seedPool();

    const returned = await handle(true).conductor.close({ cycle: 'c1', node: nodeId });
    expect(warningsOf(returned as object)).toEqual([]);
    const rows = await maintenanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Maintenance: the issue pool's weighted sum = 6, over the line 4");
    expect(rows[0]!.tags).toEqual(['issue:issue_pool_weight', 'coding']);
  });

  it('the test-audit guard is in force through the named handle: a ticket reading over its line inserts one node', async () => {
    const nodeId = await heldNodeWithTicket('c1', { test_seconds_limit: 300 });
    const path = join(root, '.pf', 'signals', 'c1', `${nodeId}.json`);
    const ticket = JSON.parse(readFileSync(path, 'utf8')) as { outputs: Record<string, unknown> };
    ticket.outputs.reading = { test_seconds: 900 };
    writeFileSync(path, JSON.stringify(ticket, null, 2), 'utf8');

    const returned = await handle(true).conductor.close({ cycle: 'c1', node: nodeId });
    expect(warningsOf(returned as object)).toEqual([]);
    const rows = await maintenanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe(
      "Maintenance: the project test suite's full wall clock (seconds) = 900s, over the line 300s",
    );
  });

  it('without the name the same scenes stay quiet: the guards are dead, the close settles all the same', async () => {
    const issueNode = await heldNodeWithTicket('c1', { issue_pool_weight_limit: 4 });
    seedPool();
    const issueClose = await handle(false).conductor.close({ cycle: 'c1', node: issueNode });
    expect(warningsOf(issueClose as object)).toEqual([]);
    expect(await maintenanceRows()).toEqual([]);

    const auditNode = await heldNodeWithTicket('c2', { test_seconds_limit: 300 });
    const path = join(root, '.pf', 'signals', 'c2', `${auditNode}.json`);
    const ticket = JSON.parse(readFileSync(path, 'utf8')) as { outputs: Record<string, unknown> };
    ticket.outputs.reading = { test_seconds: 900 };
    writeFileSync(path, JSON.stringify(ticket, null, 2), 'utf8');
    const auditClose = await handle(false).conductor.close({ cycle: 'c2', node: auditNode });
    expect(warningsOf(auditClose as object)).toEqual([]);
    expect(await maintenanceRows()).toEqual([]);
  });

  it('the shipped folder itself is not written to by any of this', async () => {
    const before = existsSync(SHIPPED) ? [...readFileSync(join(SHIPPED, 'issue', 'plugin.json'))] : [];
    const nodeId = await heldNodeWithTicket('c1', { issue_pool_weight_limit: 4 });
    seedPool();
    await handle(true).conductor.close({ cycle: 'c1', node: nodeId });
    expect(readFileSync(join(SHIPPED, 'issue', 'plugin.json'))).toEqual(Buffer.from(before));
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
