import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The surface under test is this plugin folder's own implementation (the very files the host
// loads by path).
import { main as issue } from '../plugins/issue/tools/commands.mjs';
import { EOL } from '../plugins/issue/tools/storage.mjs';

/**
 * The command surface of the issue pool: a sample of verb behaviour, pinning invariants (the
 * status vocabulary, the weight formula, which issues are pickable, defaults, and that error
 * sentences are decidable) and not formatting details. Engine operations always land in a temp
 * dir.
 */

interface Ctx {
  root: string;
}

let root: string;
let ctx: Ctx;

const POOL = () => join(root, '.pf', 'issues', 'issues.json');

function poolData(): { issues: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(POOL(), 'utf8'));
}

function seed(entries: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(root, '.pf', 'issues'), { recursive: true });
  writeFileSync(POOL(), JSON.stringify({ version: 1, issues: entries }, null, 2), 'utf8');
}

/** Merge a few rows into the pool already on disk (seed overwrites the whole file; a read-side test uses this to stack rows). */
function seedMore(entries: Record<string, Record<string, unknown>>): void {
  const data = poolData();
  seed({ ...data.issues, ...entries });
}

/** One hand-laid record: only the cells this verb surface really reads. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'x',
    severity: 'P3',
    module: '',
    title: 'x',
    decision: 'unknown',
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
    ...overrides,
  };
}

async function out(argv: string[]): Promise<string> {
  return String(await (issue as (argv: string[], ctx: Ctx) => Promise<unknown>)(argv, ctx));
}

async function err(argv: string[]): Promise<string> {
  try {
    await out(argv);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected ${argv.join(' ')} to throw`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-issue-cmd-'));
  ctx = { root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('add: identity and defaults', () => {
  it('without --id it refuses; with one it lays down a default P3/open record whose discovered and updated stamps match', async () => {
    expect(await err(['add'])).toContain('--id is required');
    const text = await out(['add', '--id', 'a', '--title', 'Alpha']);
    expect(text).toContain('Issue created: a');
    const stored = poolData().issues.a;
    expect(stored.severity).toBe('P3');
    expect(stored.status).toBe('open');
    expect(stored.decision).toBe('unknown');
    expect(stored.discovered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(stored.discovered).toBe(stored.updated_at);
    expect(stored.check_count).toBe(1);
    expect(stored.title).toBe('Alpha');
  });

  it('a duplicate id is refused; severity / decision / source take closed sets only; a malformed files list arriving through the batch door is named as it is', async () => {
    await out(['add', '--id', 'a']);
    expect(await err(['add', '--id', 'a'])).toContain('issue "a" already exists');
    expect(await err(['add', '--id', 'b', '--severity', 'P9'])).toContain('valid: P0, P1, P2, P3');
    expect(await err(['add', '--id', 'b', '--decision', 'maybe'])).toContain('valid: autofix, external, unknown');
    expect(await err(['add', '--id', 'b', '--source', 'rumor'])).toContain('valid: conduct, manual, scan');
    const bad = join(root, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ id: 'c', files: 'not-a-list' }]), 'utf8');
    expect(await err(['add', '--from-file', 'bad.json'])).toContain('"files" must be a list');
  });

  it('add --from-file: batch creation, duplicates skipped, --auto-id fills a missing id, and a -2 suffix disambiguates a clash', async () => {
    const batch = join(root, 'batch.json');
    await out(['add', '--id', 'dupe']);
    writeFileSync(batch, JSON.stringify([
      { id: 'dupe', severity: 'P2' },
      { module: 'm', title: 'Fresh One' },
      { module: 'm', title: 'fresh one' },
    ]), 'utf8');
    const text = await out(['add', '--from-file', 'batch.json', '--auto-id']);
    expect(text).toContain('Warning: issue "dupe" already exists, skipping');
    expect(text).toContain('Auto-id disambiguated');
    expect(text).toContain('2 created, 1 skipped');
    const issues = poolData().issues;
    expect(issues['m-fresh-one']).toBeDefined();
    expect(issues['m-fresh-one-2']).toBeDefined();
    expect(await err(['add', '--from-file', 'batch.json'])).toContain('missing "id" field');
    writeFileSync(batch, '{"not": "an array"}', 'utf8');
    expect(await err(['add', '--from-file', 'batch.json'])).toContain('JSON array');
  });
});

describe('status moves: update / resolve / reject / acknowledge / remove / open-plan', () => {
  it('update reports only the cells that really changed and pushes updated_at along; changing no cell answers No changes specified', async () => {
    seed({ a: row({ id: 'a', severity: 'P3', status: 'open', files: ['f.py'] }) });
    const text = await out(['update', 'a', '--severity', 'P1', '--files', 'f.py']);
    expect(text).toContain('Issue updated: a');
    expect(text).toContain('~ severity');
    expect(text).not.toContain('~ files');
    const stored = poolData().issues.a;
    expect(stored.severity).toBe('P1');
    expect(stored.updated_at).not.toBe(stored.discovered);
    expect(await out(['update', 'a', '--severity', 'P1'])).toContain('No changes specified');
  });

  it('resolve / acknowledge keep the existing reason when --reason is absent; reject insists on one; remove takes the record out', async () => {
    seed({ a: row({ id: 'a', reason: 'why-not' }) });
    expect((await out(['resolve', 'a'])).trim()).toBe('Issue resolved: a');
    expect(poolData().issues.a.status).toBe('resolved');
    expect(poolData().issues.a.reason).toBe('why-not');
    expect(await err(['reject', 'a'])).toContain('--reason is required for reject');
    expect((await out(['reject', 'a', '--reason', 'wontfix'])).trim()).toBe('Issue rejected: a');
    expect(poolData().issues.a.status).toBe('rejected');
    expect((await out(['acknowledge', 'a', '--reason', 'seen'])).trim()).toBe('Issue acknowledged: a');
    expect(poolData().issues.a.status).toBe('acknowledged');
    expect((await out(['remove', 'a'])).trim()).toBe('Issue removed: a');
    expect(poolData().issues.a).toBeUndefined();
    expect(await err(['remove', 'a'])).toContain('issue "a" not found');
  });

  it('open-plan prints the absolute path of the record plan_path; with none configured it stops', async () => {
    seed({ a: row({ id: 'a', plan_path: 'plan/a.md' }) });
    expect(await out(['open-plan', 'a'])).toBe(join(root, 'plan', 'a.md') + EOL);
    seed({ b: row({ id: 'b', plan_path: null }) });
    expect(await err(['open-plan', 'b'])).toContain('has no plan_path set');
  });
});

describe('the batch shapes: many ids on one line, and update --from-file', () => {
  it('resolve takes many ids: one line per id in argument order, both resolved under one stamp', async () => {
    seed({ a: row({ id: 'a' }), b: row({ id: 'b' }) });
    const text = await out(['resolve', 'b', 'a']);
    expect(text.trim().split(/\r?\n/)).toEqual(['Issue resolved: b', 'Issue resolved: a']);
    const stored = poolData().issues;
    expect(stored.a.status).toBe('resolved');
    expect(stored.b.status).toBe('resolved');
    expect(stored.a.updated_at).toBe(stored.b.updated_at);
    expect(stored.a.updated_at).not.toBe(stored.a.discovered);
  });

  it('a repeated id names one record: the line answers it once, the way hold treats a repeated id', async () => {
    seed({ a: row({ id: 'a' }) });
    expect((await out(['resolve', 'a', 'a'])).trim()).toBe('Issue resolved: a');
    expect((await out(['update', 'a', 'a', '--severity', 'P1'])).trim().split(/\r?\n/))
      .toEqual(['Issue updated: a', '  ~ severity']);
  });

  it('reject / acknowledge / remove share one reason and one line per id, while a ghost id stops the whole batch unwritten', async () => {
    seed({ a: row({ id: 'a' }), b: row({ id: 'b' }) });
    expect((await out(['reject', 'a', 'b', '--reason', 'wontfix'])).trim().split(/\r?\n/))
      .toEqual(['Issue rejected: a', 'Issue rejected: b']);
    expect(poolData().issues.a.reason).toBe('wontfix');
    expect(poolData().issues.b.reason).toBe('wontfix');
    expect((await out(['acknowledge', 'a', 'b'])).trim().split(/\r?\n/))
      .toEqual(['Issue acknowledged: a', 'Issue acknowledged: b']);
    expect((await out(['remove', 'a', 'b'])).trim().split(/\r?\n/))
      .toEqual(['Issue removed: a', 'Issue removed: b']);
    expect(poolData().issues).toEqual({});

    seed({ a: row({ id: 'a' }) });
    const before = readFileSync(POOL(), 'utf8');
    expect(await err(['resolve', 'a', 'ghost'])).toContain('issue "ghost" not found');
    expect(readFileSync(POOL(), 'utf8')).toBe(before);
    expect(poolData().issues.a.status).toBe('open');
  });

  it('update applies one shared patch to every id, stamps the batch once, and names an unchanged id', async () => {
    seed({
      a: row({ id: 'a' }),
      b: row({ id: 'b', decision: 'autofix' }),
      c: row({ id: 'c', decision: 'external', reason: 'x' }),
    });
    const lines = (await out(['update', 'a', 'b', 'c', '--decision', 'external', '--reason', 'x']))
      .trim().split(/\r?\n/);
    expect(lines).toContain('Issue updated: a');
    expect(lines).toContain('Issue updated: b');
    expect(lines).toContain('No changes: c');
    const stored = poolData().issues;
    expect(stored.a.decision).toBe('external');
    expect(stored.b.decision).toBe('external');
    expect(stored.a.reason).toBe('x');
    expect(stored.a.updated_at).toBe(stored.b.updated_at);
    expect(stored.c.updated_at).toBe(stored.c.discovered);
  });

  it('a batch update where nothing changed still answers No changes specified', async () => {
    seed({ a: row({ id: 'a', decision: 'external' }), b: row({ id: 'b', decision: 'external' }) });
    expect((await out(['update', 'a', 'b', '--decision', 'external'])).trim()).toBe('No changes specified');
  });

  it('update --from-file gives each row its own patch and appends one summary line', async () => {
    seed({ a: row({ id: 'a' }), b: row({ id: 'b' }) });
    const rows = join(root, 'rows.json');
    writeFileSync(rows, JSON.stringify([
      { id: 'a', severity: 'P1', reason: 'first' },
      { id: 'b', reason: 'second' },
    ]), 'utf8');
    const text = await out(['update', '--from-file', 'rows.json']);
    expect(text).toContain('Issue updated: a');
    expect(text).toContain('Issue updated: b');
    expect(text).toContain('Batch update: 2 updated, 0 unchanged');
    const stored = poolData().issues;
    expect(stored.a.reason).toBe('first');
    expect(stored.b.reason).toBe('second');
    expect(stored.a.severity).toBe('P1');
    expect(stored.a.updated_at).toBe(stored.b.updated_at);

    writeFileSync(rows, JSON.stringify([{ id: 'a', reason: 'first' }, { id: 'b', reason: 'second' }]), 'utf8');
    expect(await out(['update', '--from-file', 'rows.json'])).toContain('Batch update: 0 updated, 2 unchanged');
  });

  it('a rows file naming an id outside the pool, an unknown field, or an invalid value refuses the whole file', async () => {
    seed({ a: row({ id: 'a' }) });
    const rows = join(root, 'rows.json');
    const before = readFileSync(POOL(), 'utf8');

    writeFileSync(rows, JSON.stringify([{ id: 'a', reason: 'first' }, { id: 'ghost', severity: 'P1' }]), 'utf8');
    expect(await err(['update', '--from-file', 'rows.json'])).toContain('issue "ghost" not found');
    writeFileSync(rows, JSON.stringify([{ id: 'a', wat: 1 }]), 'utf8');
    expect(await err(['update', '--from-file', 'rows.json'])).toContain('row 1: unknown field "wat"');
    writeFileSync(rows, JSON.stringify([{ id: 'a', severity: 'P9' }]), 'utf8');
    expect(await err(['update', '--from-file', 'rows.json'])).toContain('row 1: invalid severity "P9"');

    expect(readFileSync(POOL(), 'utf8')).toBe(before);
    expect(poolData().issues.a.reason).toBeNull();
  });

  it('help prints <id…> for the verbs that take many ids', async () => {
    const usage = await out(['help']);
    expect(usage).toContain('<id…>');
    for (const verb of ['update', 'resolve', 'reject', 'acknowledge', 'remove']) {
      expect(usage).toContain(`${verb} <id…>`);
    }
  });
});

describe('weight: the formula for how heavy the pool is', () => {
  it('counts only open/acknowledged/resolving, never external or settled issues; the bare run prints the number, -v breaks it down', async () => {
    seed({
      p0: row({ id: 'p0', severity: 'P0' }),
      p1: row({ id: 'p1', severity: 'P1', status: 'acknowledged' }),
      p2: row({ id: 'p2', severity: 'P2', status: 'resolving' }),
      ext: row({ id: 'ext', severity: 'P0', decision: 'external' }),
      done: row({ id: 'done', severity: 'P0', status: 'resolved' }),
      gone: row({ id: 'gone', severity: 'P0', status: 'rejected' }),
    });
    // P0(8) + P1(4) + P2(2) = 14; external and settled issues contribute nothing.
    expect(await out(['weight'])).toBe(`14${EOL}`);
    const verbose = JSON.parse(await out(['weight', '-v']));
    expect(verbose.weight).toBe(14);
    expect(verbose.counted).toBe(3);
    expect(verbose.not_counted_external).toBe(1);
    expect(verbose.not_counted_external_weight).toBe(8);
    expect(verbose.by_severity).toEqual({ P0: 1, P1: 1, P2: 1 });
  });

  it('an empty pool reads as 0', async () => {
    expect(await out(['weight'])).toBe(`0${EOL}`);
  });
});

describe('list / status / top / by_module / stale: the invariants of the read side', () => {
  beforeEach(() => {
    seed({
      freshP0: row({ id: 'freshP0', severity: 'P0', discovered: '2026-01-02T00:00:00.000000Z' }),
      oldP0: row({ id: 'oldP0', severity: 'P0', discovered: '2026-01-01T00:00:00.000000Z' }),
      ackP1: row({ id: 'ackP1', severity: 'P1', status: 'acknowledged' }),
      doneP0: row({ id: 'doneP0', severity: 'P0', status: 'resolved', discovered: '2025-12-31T00:00:00.000000Z' }),
      other: row({ id: 'other', severity: 'P2', module: 'ops' }),
    });
  });

  it('list: severity first (closed-set order), then discovery stamp newest first; filters, --limit and --brief', async () => {
    const listed = JSON.parse(await out(['list']));
    expect(listed.map((r: { id: string }) => r.id)).toEqual(['freshP0', 'oldP0', 'doneP0', 'ackP1', 'other']);
    expect((await out(['list', '--status', 'acknowledged'])).match(/ackP1/)).toBeTruthy();
    expect(await out(['list', '--status', 'resolved'])).not.toContain('ackP1');
    expect(JSON.parse(await out(['list', '--severity', 'P0'])).map((r: { id: string }) => r.id))
      .toEqual(['freshP0', 'oldP0', 'doneP0']);
    expect(JSON.parse(await out(['list', '--module', 'ops'])).map((r: { id: string }) => r.id))
      .toEqual(['other']);
    expect(JSON.parse(await out(['list', '-n', '2']))).toHaveLength(2);
    const brief = JSON.parse(await out(['list', '--brief']));
    expect(Object.keys(brief[0]).sort()).toEqual(['id', 'severity', 'status', 'title']);
  });

  it('status counts only unsettled issues by default (resolved/rejected stay out of the buckets) and -v adds total; stale counts pickable issues whose check_count reached 3', async () => {
    seedMore({ stale1: row({ id: 'stale1', check_count: 3 }), stale2: row({ id: 'stale2', check_count: 4 }) });
    const plain = JSON.parse(await out(['status']));
    expect(plain.by_status).toEqual({ acknowledged: 1, open: 5 });
    expect(plain.total).toBeUndefined();
    expect(plain.stale).toBe(2);
    const verbose = JSON.parse(await out(['status', '-v']));
    expect(verbose.total).toBe(7);
    expect(verbose.by_status).toHaveProperty('resolved');
  });

  it('top picks only open/acknowledged, open first within a severity, five by default and -n narrows it', async () => {
    const top = JSON.parse(await out(['top']));
    expect(top.map((r: { id: string }) => r.id)).toEqual(['freshP0', 'oldP0', 'ackP1', 'other']);
    expect(top.some((r: { id: string }) => r.id === 'doneP0')).toBe(false);
    expect(JSON.parse(await out(['top', '-n', '1'])).map((r: { id: string }) => r.id)).toEqual(['freshP0']);
  });

  it('by_module lists pickable issues only, bucketed by the raw module value; only a record with no module key lands in unknown', async () => {
    seedMore({
      noModuleKey: { ...row({ id: 'noModuleKey' }), module: undefined },
      emptyModule: row({ id: 'emptyModule', module: '' }),
    });
    const grouped = JSON.parse(await out(['by_module']));
    expect(grouped.ops.map((r: { id: string }) => r.id)).toEqual(['other']);
    expect(grouped.unknown.map((r: { id: string }) => r.id)).toEqual(['noModuleKey']);
    expect(grouped[''].map((r: { id: string }) => r.id)).toContain('emptyModule');
  });

  it('stale defaults to check_count>=3, -t overrides it, sorted by check_count descending', async () => {
    seedMore({
      a: row({ id: 'a', check_count: 5 }),
      b: row({ id: 'b', check_count: 3 }),
      c: row({ id: 'c', check_count: 2 }),
    });
    expect(JSON.parse(await out(['stale'])).map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(JSON.parse(await out(['stale', '-t', '4'])).map((r: { id: string }) => r.id)).toEqual(['a']);
  });

  it('a short flag carrying a value accepts four spellings (-n5 / -n=5 / -n 5 / --limit=5) for one reading; attaching to -v is still unrecognized', async () => {
    // The attached forms (-nVALUE and -n=VALUE), the separated form and the long flag all land on
    // the same limit.
    for (const argv of [['list', '-n2'], ['list', '-n=2'], ['list', '-n', '2'], ['list', '--limit=2']]) {
      expect(JSON.parse(await out(argv))).toHaveLength(2);
    }
    // Another short flag carrying a value gets the same treatment; attaching letters to -v, which
    // carries no value, still counts as an argument nobody recognizes.
    seedMore({ s1: row({ id: 's1', check_count: 3 }), s2: row({ id: 's2', check_count: 4 }) });
    expect(JSON.parse(await out(['stale', '-t2']))).toHaveLength(2);
    expect(JSON.parse(await out(['stale', '-t=2']))).toHaveLength(2);
    expect(await err(['list', '-v2'])).toContain('unrecognized argument: -v2');
  });
});

describe('mark / search / export_plan: the three helpers for closing out', () => {
  it('mark adds 1 to check_count of known issues, names unknown ids as they are, and candidates are the unmarked open issues sorted by id', async () => {
    seed({
      b: row({ id: 'b' }),
      a: row({ id: 'a', status: 'acknowledged' }),
      zz: row({ id: 'zz', status: 'resolved' }),
    });
    const result = JSON.parse(await out(['mark', 'b', 'ghost']));
    expect(result.marked).toEqual(['b']);
    expect(result.unknown_ids).toEqual(['ghost']);
    expect(poolData().issues.b.check_count).toBe(2);
    expect(poolData().issues.b.updated_at).not.toBe(poolData().issues.b.discovered);
    // candidates are only the unmarked open ones (acknowledged a and settled zz both stay out).
    expect(result.candidates).toEqual([]);
    const note = result.note;
    expect(note).toContain('advisory only');
  });

  it('search: an id/title hit is the first tier (match says which), a description hit comes with a snippet, a module hit carries the value, and filters apply', async () => {
    seed({
      snarfId: row({ id: 'snarf-id', title: 'unrelated' }),
      hitTitle: row({ id: 'other', title: ' discusses the Snarf boundary ' }),
      hitDesc: row({ id: 'quiet', title: 'quiet', description: 'a very long description mentioning snarf in the middle of it all' }),
      hitModule: row({ id: 'mod', title: 'mod', module: 'snarf' }),
      closed: row({ id: 'closed-snarf', title: 'snarf', status: 'resolved' }),
    });
    const found = JSON.parse(await out(['search', 'snarf']));
    const byId = new Map(found.map((r: { id: string }) => [r.id, r]));
    expect(byId.get('snarf-id').match).toBe('id');
    expect(byId.get('other').match).toBe('title');
    expect(byId.get('quiet').match).toBe('description');
    expect(String(byId.get('quiet').snippet)).toContain('snarf');
    expect(byId.get('mod').match).toBe('module');
    expect(byId.get('mod').value).toBe('snarf');
    // Settled issues are not held back by search (search does not apply the pickable rule), but
    // the --status filter still applies.
    expect(byId.get('closed-snarf')).toBeDefined();
    const onlyOpen = JSON.parse(await out(['search', 'snarf', '--status', 'open']));
    expect(onlyOpen.some((r: { id: string }) => r.id === 'closed-snarf')).toBe(false);
    expect(JSON.parse(await out(['search', 'snarf', '-n', '2']))).toHaveLength(2);
  });

  it('export_plan: lays the plan out by severity and pulls the content in when plan_path is on disk', async () => {
    const planFile = join(root, 'plans', 'a.md');
    mkdirSync(join(root, 'plans'), { recursive: true });
    writeFileSync(planFile, '# Plan A\nstep one\n', 'utf8');
    seed({
      loP1: row({ id: 'loP1', severity: 'P1', module: 'ops' }),
      hiP0: row({ id: 'hiP0', severity: 'P0', functions: ['f'], files: ['g.py'], plan_path: 'plans/a.md' }),
    });
    const text = await out(['export_plan', 'loP1', 'hiP0']);
    expect(text.indexOf('hiP0')).toBeLessThan(text.indexOf('loP1'));
    expect(text).toContain('Module: ops');
    expect(text).toContain('Functions: f');
    expect(text).toContain('Files: g.py');
    expect(text).toContain('# Plan A');
    expect(text).toContain(`Plan: ${planFile}`);
    expect(text).toContain('Total: 2 issue(s)');
    expect(await err(['export_plan'])).toContain('positional argument(s)');
  });
});

describe('the pool record on disk', () => {
  it('is written with LF on every platform: one pool write carries no CR', async () => {
    await out(['add', '--id', 'a', '--title', 'Alpha']);
    const bytes = readFileSync(POOL());
    // The six record kinds share one byte rule, and this is the plugin's own writer for the issue
    // record. The golden corpus cannot pin it: a record product is re-serialized through the
    // engine's `jsonBytes` and folded to LF before the comparison, so it stayed green while this
    // writer emitted the platform's ending. Reading the file the plugin really wrote is the one
    // place the pool's own bytes show.
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.includes(0x0a)).toBe(true);
    // No trailing newline, like every other record.
    expect(bytes[bytes.length - 1]).not.toBe(0x0a);
  });
});

describe('the gates of the command surface', () => {
  it('help lists all 16 verbs; an unknown verb and an unknown flag each stop on their own', async () => {
    const usage = await out(['help']);
    for (const verb of ['add', 'list', 'update', 'resolve', 'reject', 'acknowledge', 'remove',
      'open-plan', 'status', 'weight', 'top', 'by_module', 'stale', 'mark', 'search', 'export_plan']) {
      expect(usage).toContain(verb);
    }
    expect(await err(['frobnicate'])).toContain('unrecognized command "frobnicate"');
    expect(await err(['list', '--wat'])).toContain('unrecognized argument: --wat');
    expect(await err(['weight', 'extra'])).toContain('positional argument(s)');
  });

  it('a trailing help flag after a verb asks the same page `issue help` does, without running the verb; the bare verb still runs', async () => {
    const page = await out(['help']);
    // `--help` and `-h` are the help flag's two spellings, the pair the words table's rows carry.
    expect(await out(['status', '--help'])).toBe(page);
    expect(await out(['status', '-h'])).toBe(page);
    // A page, not a run: `update` would refuse a ghost id if it ran.
    expect(await out(['update', 'ghost', '--help'])).toBe(page);
    // Without the flag the verb runs as before and answers its own reading.
    expect(JSON.parse(await out(['status']))).toHaveProperty('by_status');
  });

  it('a help flag anywhere else in the line is not one: it reaches the verb\'s parser, and a value spelled `--help` rides attached', async () => {
    const page = await out(['help']);
    // Mid-line with a real token after it: the parser sees the token it does not know and refuses.
    expect(await err(['status', '--help', '--verbose'])).toContain('unrecognized argument: --help');
    seed({ a: row({ id: 'a' }) });
    // The trailing rule's accepted edge: a value-taking flag followed by `--help` in the last cell
    // reads as help, so the verb did not run. The spelling that carries such a value attaches it,
    // and the attached cell is not the help flag.
    expect(await out(['update', 'a', '--reason', '--help'])).toBe(page);
    expect(poolData().issues.a.reason).toBeNull();
    expect(await out(['update', 'a', '--reason=--help'])).toContain('Issue updated: a');
    expect(poolData().issues.a.reason).toBe('--help');
  });

  it('an absent pool is an empty pool rather than an error: read verbs all answer empty and a write verb raises the dir', async () => {
    expect(await out(['weight'])).toBe(`0${EOL}`);
    expect(JSON.parse(await out(['list']))).toEqual([]);
    expect(await out(['add', '--id', 'a'])).toContain('Issue created: a');
    expect(existsSync(POOL())).toBe(true);
  });
});
