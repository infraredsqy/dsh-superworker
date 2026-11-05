import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonBytes, jsonOptionsForRecord } from '../src/jsonio';
import { open } from '../src/open';

/**
 * Byte-for-byte comparison: the same sequence (add ×4 / depend / status ×2 / revive / rm) is run in
 * a project root of its own (such as `%TEMP%`), and the bytes of `ideas.json` at each step are fixed
 * into tests/fixtures/ (node ids and timestamps become @node-a@…@node-d@ and @t1@…@t8@, the stamps
 * allocated in ascending value order, exactly the k-th write); the test runs the same sequence and
 * compares byte for byte after generalising.
 *
 * The on-disk order of node keys follows the real uuids and differs on every run — so the
 * generalisation has two steps: first parse and swap node keys and dependency members for tokens of
 * the creation order, then re-emit the bytes the same way the record writer does (jsonBytes:
 * deep-sorted keys, platform line endings, no trailing newline), and finally swap the stamps. Both
 * sides run the same serialisation, so the only differences left are real ones.
 *
 * After an add the node directory is set up and holds nothing yet (add pre-creates no spec.md, so a missing
 * file is how "no requirements written yet" is expressed); the shape of that directory tree is locked here too.
 */

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

const STEPS = [
  '01-add-a', '02-add-b', '03-add-c', '04-add-d',
  '05-depend', '06-status-a', '07-status-c', '08-revive-c', '09-rm-d',
] as const;

function fixtureOf(step: string): string {
  return readFileSync(join(fixturesDir, `ideas-${step}.txt`), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Records are written with LF on every platform — format.test locks that rule byte for byte; the
 * comparison here folds any stray CRLF to LF (so a checkout that converted line endings still
 * reads) and so locks every other byte: key order, shape, values, indentation, and the missing
 * trailing newline.
 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

const decoder = new TextDecoder('utf-8');

const STAMP_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z/g;

/**
 * Generalise one captured ideas.json byte set into something comparable: ids become @node-a@… in
 * creation order, node keys fall back into token order through the record writer's sort, and stamps
 * become @t1@… in the global order of the whole run (the k-th write). Stamp tokens have to look
 * globally: a single-step capture cannot see writes that have not happened yet, so the numbering
 * would slip.
 */
function tokenize(text: string, ids: string[], stampTokens: Map<string, string>): string {
  const rename = new Map(ids.map((id, index) => [id, `@node-${'abcd'[index]}@`]));
  const data = JSON.parse(text) as { nodes: Record<string, Record<string, unknown>> };
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(data.nodes)) {
    const node = { ...value };
    if (Array.isArray(node.dependencies)) {
      node.dependencies = node.dependencies.map((dep) =>
        typeof dep === 'string' ? rename.get(dep) ?? dep : dep,
      );
    }
    nodes[rename.get(key) ?? key] = node;
  }
  let out = decoder.decode(jsonBytes({ nodes }, jsonOptionsForRecord('ideas')));
  out = toLf(out);
  for (const [value, token] of stampTokens) out = out.split(value).join(token);
  return out;
}

function stampTokensOf(all: string[]): Map<string, string> {
  const stamps = new Set<string>();
  for (const text of all) {
    for (const m of text.matchAll(STAMP_REGEX)) stamps.add(m[0]);
  }
  return new Map([...stamps].sort().map((value, index) => [value, `@t${index + 1}@`]));
}

function nodeDirTree(root: string, nodeId: string): string[] {
  const dir = join(root, '.pf', 'nodes', nodeId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

let root: string;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined!;
  }
});

describe('byte-for-byte comparison: one operation sequence produces one byte set', () => {
  it('ideas.json matches byte for byte at every step of add / depend / status / revive / rm', async () => {
    root = mkdtempSync(join(tmpdir(), 'pf-bytes-'));
    const pf = open(root);
    await pf.ledger.init();
    const ideasJson = join(root, '.pf', 'ideas.json');

    const captures: string[] = [];
    const ids: string[] = [];
    const a = await pf.ledger.dag.add({ title: '写作底稿', description: '第一个节点的说明', tags: ['coding'] });
    ids.push(a.id);
    captures.push(readFileSync(ideasJson, 'utf8'));
    const b = await pf.ledger.dag.add({ title: '复核校样', mode: 'checkpoint' });
    ids.push(b.id);
    captures.push(readFileSync(ideasJson, 'utf8'));
    const c = await pf.ledger.dag.add({ title: '轻量小件', weight: 'light', tags: ['art', 'writing'] });
    ids.push(c.id);
    captures.push(readFileSync(ideasJson, 'utf8'));
    const d = await pf.ledger.dag.add({ title: '汇总交付', mode: 'manual' });
    ids.push(d.id);
    captures.push(readFileSync(ideasJson, 'utf8'));

    // The node directory is there and holds nothing yet: add pre-creates no spec.md, so a missing file means
    // "no requirements written yet". The shape of that tree is locked here — the directory is asserted present
    // first, so an empty tree below means "present and empty", not "never created".
    expect(existsSync(join(root, '.pf', 'nodes', a.id))).toBe(true);
    expect(nodeDirTree(root, a.id)).toEqual([]);
    expect(existsSync(join(root, '.pf', 'nodes', a.id, 'spec.md'))).toBe(false);

    await pf.ledger.dag.link(d.id, b.id);
    captures.push(readFileSync(ideasJson, 'utf8'));
    await pf.ledger.dag.setStatus(a.id, 'completed');
    captures.push(readFileSync(ideasJson, 'utf8'));
    await pf.ledger.dag.setStatus(c.id, 'shelved');
    captures.push(readFileSync(ideasJson, 'utf8'));
    await pf.ledger.dag.revive(c.id);
    captures.push(readFileSync(ideasJson, 'utf8'));
    await pf.ledger.dag.remove(d.id);
    captures.push(readFileSync(ideasJson, 'utf8'));

    // rm takes the whole node directory with it; the other three node directories stay as they were (empty).
    expect(existsSync(join(root, '.pf', 'nodes', d.id))).toBe(false);
    expect(existsSync(join(root, '.pf', 'nodes', b.id))).toBe(true);
    expect(nodeDirTree(root, b.id)).toEqual([]);

    expect(captures.length).toBe(STEPS.length);
    const stampTokens = stampTokensOf(captures);
    expect(stampTokens.size).toBe(8);
    for (let index = 0; index < STEPS.length; index++) {
      const step = STEPS[index]!;
      expect(tokenize(captures[index]!, ids, stampTokens), `step ${step}`).toBe(fixtureOf(step));
    }
  });

  it('in an empty project that was never init-ed the graph reads as empty, and not a byte lands', async () => {
    root = mkdtempSync(join(tmpdir(), 'pf-bytes-empty-'));
    const pf = open(root);
    await expect(pf.ledger.dag.list()).resolves.toEqual([]);
    const report = await pf.ledger.dag.validate();
    expect(report.ok).toBe(true);
    expect(report.total).toBe(0);
    expect(existsSync(join(root, '.pf'))).toBe(false);
  });
});
