import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfigNamespace, type KnobSpec } from '../src/config';
import { createCyclesNamespace } from '../src/cycles';
import { isRecordError } from '../src/errors';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { readNodeTable } from '../src/graph';
import { recordPaths } from '../src/paths';
import { answer } from '../src/words/router';
import { createSessionsNamespace } from '../src/sessions';

/**
 * The `nodes` table of `ideas.json` has one reading in the engine (`graph.readNodeTable`), and every
 * verb that needs the graph asks it: the dag verbs, the planner, the settings chain's node layer, the
 * session book and the line verbs. Two invariants of that reading are pinned here, and neither pins
 * how it is done:
 *
 * - **one rejection**: a document whose top level is not a JSON object (an array, a bare word, a
 *   number, `null`) is refused with the same decidable answer wherever it is met. Reading it as an
 *   empty graph would let every verb answer "there is no node on this graph" from a record that says
 *   nothing of the kind — so a bad document is one refusal, not six guesses.
 * - **the table owns its keys**: a name every object inherits (`toString`, `constructor`, `__proto__`)
 *   is not a node anywhere, while an own key of that same spelling is a node everywhere — the question
 *   is ownership, not the spelling.
 *
 * What a *missing* key reads as is pinned alongside: an absent `nodes` table is an empty graph to every
 * verb (never a crash), and a cell inside the table that cannot be a node record is dropped by the one
 * reading, so every verb sees the same table.
 *
 * Ownership holds on the **write** side too: landing a record rewrites the whole document (the issue
 * pool and the graph sort their keys deeply), so a rebuild of a table that lost an own key would drop a
 * node from disk while the verb reported success — the row that was just written being the one to go.
 */

/** A plugin-style knob taking the whole chain, so a `{ node }` read reaches the node layer's gate. */
const DECLARED: Record<string, KnobSpec> = {
  proj_depth: { kind: 'number', default: 6, summary: 'a knob walking the whole chain' },
};

let root: string;
let home: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-node-table-'));
  home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  await open(root).ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ideasPath(): string {
  return join(root, '.superworker', 'ideas.json');
}

/** Plant the whole ideas.json document as raw text: a hand merge, or a hand edit, is how a bad shape gets here. */
function plantDocument(body: string): void {
  writeFileSync(ideasPath(), body, 'utf8');
}

/** The code of a refusal, or `null` when the call answered instead of refusing. */
async function refusalCodeOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (error) {
    return isRecordError(error) ? error.code : `(not a RecordError: ${String(error)})`;
  }
}

/**
 * Every verb that needs the graph, each one asking it once: the six readers the one reading replaced,
 * the three remaining read verbs on the graph (`info` / `context` / `specPath`), the nine verbs that
 * change the graph (they read the table under the lock, so a bad document stops them at the same
 * gate), the planner, the settings chain's node layer, the session book, the line verbs and the
 * check-up's record face.
 *
 * The exception is not a list of names but a criterion: **a verb that meets an earlier gate first — the
 * layer gate, the line gate — answers that gate's code, and this matrix does not collect it**, because
 * its answer says nothing about the node table's reading. The line-gated ones this file leaves out are
 * `conductor.prepare` / `conductor.dispatchPreview` / `conductor.settlePreview`: with no active line to
 * work on, the line gate answers `cycle_not_found` before the graph is ever asked. The settings verbs
 * below meet no such gate here, and that is the declaration this file makes — `DECLARED` takes the whole
 * chain including the node layer, so `{ node }` reaches the reading; hence the read and both writes are
 * all collected.
 */
function graphVerbs(): Array<[string, () => Promise<unknown>]> {
  const superworker = open(root);
  const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
  const sessions = createSessionsNamespace(root);
  const cycles = createCyclesNamespace(root);
  const dag = superworker.ledger.dag;
  return [
    ['dag.get', () => dag.get('a')],
    ['dag.info', () => dag.info('a')],
    ['dag.context', () => dag.context('a')],
    ['dag.specPath', () => dag.specPath('a')],
    ['dag.list', () => dag.list()],
    ['dag.validate', () => dag.validate()],
    ['dag.search', () => dag.search('a')],
    ['dag.add', () => dag.add({ title: 'a new node' })],
    ['dag.addMany', () => dag.addMany([{ title: 'a new node' }])],
    ['dag.update', () => dag.update('a', { title: 'renamed' })],
    ['dag.remove', () => dag.remove('a', { force: true })],
    ['dag.link', () => dag.link('a', 'b')],
    ['dag.unlink', () => dag.unlink('a', 'b')],
    ['dag.setStatus', () => dag.setStatus('a', 'todo')],
    ['dag.approve', () => dag.approve('a')],
    ['dag.revive', () => dag.revive('a')],
    ['conductor.next', () => superworker.conductor.next()],
    ['conductor.doctor', () => superworker.conductor.doctor()],
    ['config.get { node }', () => config.get('proj_depth', { node: 'a' })],
    ['config.set { node }', () => config.set('proj_depth', 1, { node: 'a' })],
    ['config.unset { node }', () => config.unset('proj_depth', { node: 'a' })],
    ['sessions.list', () => sessions.list()],
    ['sessions.show', () => sessions.show('a')],
    ['cycles.start', () => cycles.start({ id: 'c1', tags: ['coding'] })],
  ];
}

describe('a bad document is one refusal, wherever the graph is read', () => {
  it.each(['[]', '"x"', '123', 'null'])(
    'ideas.json is valid JSON but not an object (%s): every verb refuses with the same code',
    async (body) => {
      // One session note on the book, so the listing gets past "there is no note to title" and really
      // reaches the graph — a listing with nothing to read is no test of the table's reading. The note is
      // required, not decoration: with no note planted, the listing reads the notes directory first and
      // answers `[]` without ever reaching the table.
      mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
      writeFileSync(
        join(root, '.superworker', 'meta', 'sessions', 'a.json'),
        JSON.stringify({ v: 1, discussion: [{ session: 's', host: 'dsh', at: null }], run: [] }),
        'utf8',
      );
      plantDocument(body);
      // The six writers in the matrix refuse *before* they touch the document: a bad shape is not
      // repaired into an empty graph and written back, so the bytes are the ones that were planted.
      const planted = readFileSync(ideasPath(), 'utf8');
      const codes = new Map<string, string | null>();
      for (const [verb, call] of graphVerbs()) codes.set(verb, await refusalCodeOf(call));

      // One answer for every reader: the reading's own code, not six different guesses.
      for (const [verb, code] of codes) expect(code, verb).toBe('parse_failure');
      // Not one byte written: a refused write leaves the document exactly as it was planted.
      expect(readFileSync(ideasPath(), 'utf8')).toBe(planted);
    },
  );

  it('an unparsable document is refused the same way by that same one reading', async () => {
    plantDocument('{ this document does not parse');
    expect(await refusalCodeOf(() => readNodeTable(recordPaths(root)))).toBe('parse_failure');
    expect(await refusalCodeOf(() => open(root).ledger.dag.list())).toBe('parse_failure');
  });
});

describe('what a missing key reads as: one table, so every verb sees the same graph', () => {
  it('an absent nodes table is an empty graph to every verb, never a crash', async () => {
    plantDocument('{"some_other_section": {"kept": true}}');

    // The reading fills the table in and carries the rest of the document back as it was.
    const read = await readNodeTable(recordPaths(root));
    expect(read.nodes).toEqual({});
    expect(read.data.some_other_section).toEqual({ kept: true });

    expect(await open(root).ledger.dag.list()).toEqual([]);
    expect(await open(root).ledger.dag.validate()).toMatchObject({ ok: true, total: 0 });
    expect(await createSessionsNamespace(root).list()).toEqual([]);
    // A node nobody owns the id of is not on the graph (this is the node layer's own word for it).
    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    expect(await refusalCodeOf(() => config.get('proj_depth', { node: 'a' }))).toBe('node_not_found');
    // And a line cannot be started on an empty graph: the graph answered "nothing ready", not "no record".
    await expect(createCyclesNamespace(root).start({ id: 'c1', tags: ['coding'] }))
      .rejects.toThrow('no ready node');
  });

  it('cells that cannot be a node record are dropped by the one reading, so no verb reads a phantom node', async () => {
    plantDocument(JSON.stringify({
      nodes: {
        real: { title: 'the real one', status: 'todo', mode: 'auto', dependencies: [] },
        nulled: null,
        worded: 'not a node',
        listed: ['not', 'a', 'node'],
      },
    }));
    const read = await readNodeTable(recordPaths(root));
    expect(Object.keys(read.nodes)).toEqual(['real']);

    const rows = await open(root).ledger.dag.list();
    expect(rows.map((row) => row.id)).toEqual(['real']);
    expect(await open(root).ledger.dag.validate()).toMatchObject({ total: 1 });
  });

  it('a nodes cell that is not a table at all reads as an empty graph (never as index-keyed nodes)', async () => {
    // An array is the shape a hand merge is most likely to leave here: reading it as a table would mint
    // nodes named "0", "1", … off cells that were never node records.
    plantDocument('{"nodes": [{"title": "a"}, {"title": "b"}]}');
    expect((await readNodeTable(recordPaths(root))).nodes).toEqual({});
    expect(await open(root).ledger.dag.list()).toEqual([]);
  });
});

describe('the table owns its keys: an inherited name is no node', () => {
  it.each(['toString', 'constructor', '__proto__'])(
    'a spelling that only names an inherited key (%s) is no node on any verb',
    async (name) => {
      plantDocument('{"nodes": {"real": {"title": "the real one", "status": "todo", "mode": "auto", "dependencies": []}}}');
      const superworker = open(root);
      const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
      const sessions = createSessionsNamespace(root);

      // A read answers "no such node", never a borrowed function or a phantom record.
      expect(await superworker.ledger.dag.get(name)).toBeNull();
      await expect(superworker.ledger.dag.info(name)).rejects.toThrow('not found');
      expect(await refusalCodeOf(() => config.get('proj_depth', { node: name }))).toBe('node_not_found');
      expect(await refusalCodeOf(() => config.set('proj_depth', 1, { node: name }))).toBe('node_not_found');
      // The book of session notes resolves ids against the same table.
      await expect(sessions.show(name)).rejects.toThrow('not found');
      // The reading itself says so: the table is an own-key table, not a wider layer.
      expect(Object.hasOwn((await readNodeTable(recordPaths(root))).nodes, name)).toBe(false);
    },
  );

  it('an own key of that same spelling is a node everywhere: ownership is the question, not the word', async () => {
    // A blacklist of suspicious names would refuse these; the table owns them, so they are nodes.
    plantDocument('{"nodes": {"constructor": {"title": "owned", "status": "todo", "mode": "auto", "dependencies": []}}}');
    const superworker = open(root);
    expect(await superworker.ledger.dag.get('constructor')).toMatchObject({ title: 'owned' });
    expect((await superworker.ledger.dag.list()).map((row) => row.id)).toEqual(['constructor']);
    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    expect(await config.get('proj_depth', { node: 'constructor' })).toEqual({ value: 6, source: 'builtin' });
  });

  it('an own `__proto__` key is a node on every verb: the one spelling whose assignment is special', async () => {
    // `__proto__` is the one own key whose *assignment* on a plain object sets the prototype instead
    // of creating a key. The reading owns it; every derivative below it (the graph layer's adjacency,
    // reverse adjacency, the score tables, the cycle colouring) rebuilds a keyed table, and any one of
    // those that accumulated into a plain `{}` would lose this node while its neighbours kept it.
    plantDocument(JSON.stringify({
      nodes: {
        ['__proto__']: { title: 'owned proto', status: 'todo', mode: 'auto', dependencies: [] },
        real: { title: 'the real one', status: 'todo', mode: 'auto', dependencies: [] },
      },
    }));
    const superworker = open(root);
    const dag = superworker.ledger.dag;
    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    const sessions = createSessionsNamespace(root);
    const cycles = createCyclesNamespace(root);

    // The read itself owns it, and every read verb answers from it.
    expect(Object.hasOwn((await readNodeTable(recordPaths(root))).nodes, '__proto__')).toBe(true);
    expect(await dag.get('__proto__')).toMatchObject({ title: 'owned proto' });
    const info = await dag.info('__proto__');
    expect(info).toMatchObject({ id: '__proto__', title: 'owned proto' });
    // The two readings are numbers, per the record contract: a score table that dropped this node
    // would hand back the empty object it inherited instead.
    expect(typeof info.urgency_level).toBe('number');
    expect(typeof info.importance_score).toBe('number');
    // `context` walks the graph layer's reverse adjacency, and it must answer, not throw.
    const context = await dag.context('__proto__');
    expect(context.id).toBe('__proto__');
    expect(context.upstream).toEqual([]);
    expect(context.downstream).toEqual([]);
    expect((await dag.specPath('__proto__')).replaceAll('\\', '/')).toBe(
      join(root, '.superworker', 'nodes', '__proto__', 'spec.md').replaceAll('\\', '/'),
    );
    expect((await dag.search('owned proto')).map((hit) => hit.id)).toEqual(['__proto__']);
    const listed = (await dag.list()).find((row) => row.id === '__proto__');
    expect(listed).toBeDefined();
    expect(typeof listed?.urgency_level).toBe('number');
    expect(typeof listed?.importance_score).toBe('number');
    expect(await dag.validate()).toMatchObject({ ok: true, total: 2, status_counts: { todo: 2 } });
    expect(await sessions.show('__proto__')).toMatchObject({ node: '__proto__', title: 'owned proto' });
    expect(await config.get('proj_depth', { node: '__proto__' })).toEqual({ value: 6, source: 'builtin' });
    // A line claims it like any other node: the ranking it picks through is the same score tables.
    const line = await cycles.start({ id: 'c1', tags: ['coding'] });
    expect(line.holding.map((cell) => cell.id)).toContain('__proto__');
  });

  it('the machine view keyed by node id carries an own `__proto__` key too', async () => {
    // `session list --json` builds its own table keyed by node id: the same spelling would set a
    // prototype there and drop the row from the output a machine reads.
    plantDocument(JSON.stringify({
      nodes: {
        ['__proto__']: { title: 'owned proto', status: 'todo', mode: 'auto', dependencies: [] },
        real: { title: 'the real one', status: 'todo', mode: 'auto', dependencies: [] },
      },
    }));
    mkdirSync(join(root, '.superworker', 'meta', 'sessions'), { recursive: true });
    for (const node of ['__proto__', 'real']) {
      writeFileSync(
        join(root, '.superworker', 'meta', 'sessions', `${node}.json`),
        JSON.stringify({ v: 1, discussion: [{ session: 's', host: 'dsh', at: null }], run: [] }),
        'utf8',
      );
    }
    const out = await answer(['session', 'list', '--json'], {
      root,
      homeDir: home,
      executor: new SimulatedExecutor(),
      openerAvailable: true,
    });
    const viewed = JSON.parse((out as { stdout: string }).stdout) as Record<string, unknown>;
    expect(Object.keys(viewed).sort()).toEqual(['__proto__', 'real']);
    expect((out as { stdout: string }).stdout).toContain('"__proto__"');
  });

  it('a cycle running through an own `__proto__` key is caught, like the same cycle spelled with any other id', async () => {
    // Coloring a DFS in a plain `{}` never marks this node, so a real cycle through it read `ok: true`:
    // the check-up certified a graph it had not walked.
    plantDocument('{"nodes": {' +
      '"__proto__": {"title": "p", "status": "todo", "mode": "auto", "dependencies": ["real"]},' +
      '"real": {"title": "r", "status": "todo", "mode": "auto", "dependencies": ["__proto__"]}}}');
    const report = await open(root).ledger.dag.validate();
    expect(report.ok).toBe(false);
    expect(report.total).toBe(2);
    expect(report.problems.some((line) => line.includes('no_cycles'))).toBe(true);

    // The control is the same graph under an ordinary spelling: the verdict has to agree.
    plantDocument('{"nodes": {' +
      '"p": {"title": "p", "status": "todo", "mode": "auto", "dependencies": ["real"]},' +
      '"real": {"title": "r", "status": "todo", "mode": "auto", "dependencies": ["p"]}}}');
    expect((await open(root).ledger.dag.validate()).ok).toBe(false);
  });

  it('a write over a document carrying an own `__proto__` key keeps that cell on disk', async () => {
    // Landing a record sorts its keys deeply, rebuilding every table: a rebuild into a plain `{}`
    // assigns this key onto the prototype, so the node vanished from disk while the verb reported
    // success — the claim `cycles.start` had just written pointed at a node that was gone.
    plantDocument(JSON.stringify({
      nodes: {
        ['__proto__']: { title: 'owned proto', status: 'todo', mode: 'auto', dependencies: [] },
        real: { title: 'the real one', status: 'todo', mode: 'auto', dependencies: [] },
      },
      note_top: { kept: true },
    }));
    const dag = open(root).ledger.dag;
    expect(await dag.setStatus('__proto__', 'completed')).toMatchObject({ title: 'owned proto' });

    // On disk: the cell is still a key of the table, and its bytes carry the spelling.
    const landed = JSON.parse(readFileSync(ideasPath(), 'utf8')) as { nodes: Record<string, unknown>; note_top: unknown };
    expect(Object.keys(landed.nodes)).toContain('__proto__');
    expect(readFileSync(ideasPath(), 'utf8')).toContain('"__proto__"');
    // And it is still readable as a node, with the status the verb just wrote.
    expect(await dag.get('__proto__')).toMatchObject({ title: 'owned proto', status: 'completed' });
    expect(await dag.validate()).toMatchObject({ ok: true, total: 2 });
    // The rest of the document is carried back as it was.
    expect(landed.note_top).toEqual({ kept: true });

    // The same for a creating write: the new node lands beside it, it does not replace it.
    await dag.add({ title: 'delta' });
    const afterAdd = JSON.parse(readFileSync(ideasPath(), 'utf8')) as { nodes: Record<string, unknown> };
    expect(Object.keys(afterAdd.nodes)).toContain('__proto__');
    expect(await dag.get('__proto__')).toMatchObject({ title: 'owned proto' });
  });
});
