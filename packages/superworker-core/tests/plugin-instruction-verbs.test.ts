import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as instruction } from '../plugins/instruction/tools/commands.mjs';
import { UsageError } from '../plugins/instruction/tools/storage.mjs';
import { atomicWriteJson, jsonOptionsForRecord } from '../src/jsonio';
import { open } from '../src/open';

/**
 * The `instruction` command surface, this plugin folder's own (`plugins/instruction/`): register,
 * list, archive, revive, take away, plus visibility as a pure deduction.
 *
 * What is pinned is the criterion, not the implementation: the visibility matrix (scope x binding
 * state x position), the add / resolve / revive round trip, tombstones hidden but kept, ids never
 * issued twice, the account's whole-file read-modify-write and the init gate. The record belongs to
 * this folder, so its shape is spelled here rather than taken from the engine's exports.
 */

/** The record's shape as this folder writes and reads it (the plugin owns the type now). */
interface InstructionRecord {
  id: string;
  text: string;
  scope: string;
  target: string;
  state: string;
  cycle: string | null;
  node: string | null;
  said_by: string;
  at: string;
  resolved_at: string | null;
  note: string | null;
  stop_after_nodes?: number;
}

let root: string;
let superworker: ReturnType<typeof open>;

/** The seconds shape: 2026-...T...:...:...Z. That is the only shape an instruction stamp takes. */
const SECONDS_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-ins-cmd-'));
  superworker = open(root);
  await superworker.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  superworker = undefined!;
});

/** One line through the plugin's own command surface: the folder the host loads by path is what runs. */
async function out(argv: string[]): Promise<string> {
  return String(await (instruction as (argv: string[], ctx: { root: string }) => Promise<unknown>)(argv, { root }));
}

async function err(argv: string[]): Promise<string> {
  try {
    await out(argv);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected ${argv.join(' ')} to throw`);
}

/** One refused line as the host sees it: the thrown value itself, with the exit code it carries (if any). */
async function refusalOf(argv: string[]): Promise<Error & { code?: number }> {
  try {
    await out(argv);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error(`expected ${argv.join(' ')} to throw`);
}

/** The account view of a listing, as ids in account order. */
async function idsOf(argv: string[]): Promise<string[]> {
  return (JSON.parse(await out(argv)) as InstructionRecord[]).map((row) => row.id);
}

function readInstructionFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')) as Record<string, unknown>;
}

function entries(): InstructionRecord[] {
  return (readInstructionFile().instructions ?? []) as InstructionRecord[];
}

async function plantInstructions(rows: unknown[]): Promise<void> {
  await atomicWriteJson(
    join(root, '.superworker', 'instructions.json'),
    { instructions: rows },
    jsonOptionsForRecord('instructions'),
  );
}

const add = (text: string, rest: string[] = []): Promise<string> => out(['add', '--scope', 'global', ...rest, '--text', text]);

describe('add: registering one instruction', () => {
  it('default shape: stage / live / said_by user, optional keys not given stay off disk, the stamp is in seconds shape', async () => {
    const answer = await add('read the spec of this node first, then start');
    expect(answer).toBe('INSTRUCTION i-0001: [global/stage] read the spec of this node first, then start');

    const entry = entries()[0]!;
    expect(entry).toMatchObject({
      id: 'i-0001',
      text: 'read the spec of this node first, then start',
      scope: 'global',
      target: 'stage',
      state: 'live',
      cycle: null,
      node: null,
      said_by: 'user',
      resolved_at: null,
      note: null,
    });
    expect(entry.at).toMatch(SECONDS_SHAPE);
    expect('stop_after_nodes' in entry).toBe(false);
    // The key set on disk is the frozen spelling: one key off and the record vocabulary has changed.
    expect(Object.keys(entry).sort()).toEqual([
      'at', 'cycle', 'id', 'node', 'note', 'resolved_at', 'said_by', 'scope',
      'state', 'target', 'text',
    ]);
  });

  it('every optional key given: target / said_by / note / stop_after_nodes, and the binding follows the named cycle', async () => {
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await out([
      'add', '--scope', 'cycle', '--cycle', 'main', '--target', 'boundary', '--said-by', 'owner',
      '--note', 'read it aloud at every wrap-up', '--stop-after-nodes', '2',
      '--text', 'clear the open questions before wrapping up',
    ]);
    const entry = entries()[0]!;
    expect(entry).toMatchObject({
      scope: 'cycle',
      target: 'boundary',
      cycle: 'main',
      said_by: 'owner',
      note: 'read it aloud at every wrap-up',
      stop_after_nodes: 2,
    });
    // stop_after_nodes is an optional key added later; it lands at the end of the record.
    expect(Object.keys(entry)[Object.keys(entry).length - 1]).toBe('stop_after_nodes');
  });

  it('the binding follows the spot: with a single line in service, cycle / node are remembered without being named (the node is the one the line holds)', async () => {
    const node = await superworker.ledger.dag.add({ title: 'A' });
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await superworker.ledger.cycles.hold('main', node.id);
    await out(['add', '--scope', 'cycle', '--text', 'line constraint']);
    await out(['add', '--scope', 'node', '--text', 'node constraint']);
    const [byCycle, byNode] = entries();
    expect(byCycle!.cycle).toBe('main');
    expect(byCycle!.node).toBe(node.id);
    expect(byNode!.cycle).toBe('main');
    expect(byNode!.node).toBe(node.id);
  });

  it('a named cycle that is not in the book, a node that is not on the graph: refused on the spot', async () => {
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    await superworker.ledger.dag.add({ title: 'A' }); // a non-empty graph is what a named node is checked against
    expect(await err(['add', '--scope', 'cycle', '--cycle', 'ghost', '--text', 'x'])).toContain(
      'cycle "ghost" is not in state.json',
    );
    expect(await err(['add', '--scope', 'node', '--node', 'no-such-node', '--text', 'x'])).toContain(
      'node "no-such-node" is not in the DAG',
    );
    // Both refusals happen on the spot: not one byte ever landed in the account.
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });

  it('an empty graph lets a named node through: no validation, the node lands as given', async () => {
    // The graph is not up yet (not one node): there is no graph to check against, so a named node is
    // written as given. The cycle side has no such pass-through branch.
    expect(await err(['add', '--scope', 'cycle', '--cycle', 'ghost', '--text', 'x'])).toContain(
      'cycle "ghost" is not in state.json',
    );
    await out(['add', '--scope', 'node', '--node', 'not-in-dag', '--text', 'registration before the graph exists']);
    expect(entries()[0]!.node).toBe('not-in-dag');
  });

  it('a cycle / node scope with nothing to bind to: refused, and not one byte lands', async () => {
    expect(await err(['add', '--scope', 'cycle', '--text', 'x'])).toContain('needs a line to bind to');
    expect(await err(['add', '--scope', 'node', '--text', 'x'])).toContain('needs a node to bind to');
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });

  it('with two lines side by side the cycle must be named; an empty body and a word outside the vocabulary are refused', async () => {
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    expect(await err(['add', '--scope', 'cycle', '--text', 'x'])).toContain('needs a line to bind to');
    await out(['add', '--scope', 'cycle', '--cycle', 'two', '--text', 'x']);
    expect(entries()[0]!.cycle).toBe('two');

    expect(await err(['add', '--scope', 'global', '--text', '   '])).toContain('text must not be empty');
    expect(await err(['add', '--scope', 'round', '--text', 'x'])).toContain('invalid scope "round"');
    expect(await err(['add', '--scope', 'global', '--target', 'round', '--text', 'x'])).toContain(
      'invalid target "round"',
    );
  });

  it('an id once issued is never issued again: a tombstone left by a removal counts too', async () => {
    await add('first entry');
    await add('second entry');
    await out(['rm', 'i-0002']);
    await add('third entry');
    expect(entries().map((row) => row.id)).toEqual(['i-0001', 'i-0003']);
  });

  it('the record and the printed line are LF on every platform: no CR in either', async () => {
    await add('a sentence that crosses no line');
    const bytes = readFileSync(join(root, '.superworker', 'instructions.json'));
    expect(bytes.includes(0x0d)).toBe(false);
    // No trailing newline, like every other record.
    expect(bytes[bytes.length - 1]).not.toBe(0x0a);
    const text = await out(['list']);
    expect(text.includes('\r')).toBe(false);
  });
});

describe('the visibility matrix: scope x binding state x position', () => {
  /**
   * A fixed scene: the first node is todo and held by the main line, the second is completed and held
   * by that line, the third is todo and held by a line that left service; two globals (stage /
   * boundary), one on the main line, one on the line out of service, three node bindings, one
   * archived, one taken away (a tombstone).
   */
  async function plantScenario(): Promise<{ ids: Record<string, string>; nodeA: string; nodeB: string }> {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    await superworker.ledger.dag.setStatus(nodeB, 'completed');
    const nodeC = (await superworker.ledger.dag.add({ title: 'C' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await superworker.ledger.cycles.hold('one', nodeB);
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await superworker.ledger.cycles.hold('two', nodeC);
    await superworker.ledger.cycles.setStatus('two', 'inactive');

    const ids: Record<string, string> = {};
    await add('global constraint');
    await add('global constraint on the wrap-up edge', ['--target', 'boundary']);
    await out(['add', '--scope', 'cycle', '--cycle', 'one', '--text', 'constraint of this line']);
    await out(['add', '--scope', 'cycle', '--cycle', 'two', '--text', 'constraint of the out-of-service line']);
    await out(['add', '--scope', 'node', '--node', nodeA, '--text', 'constraint on node A']);
    await out(['add', '--scope', 'node', '--node', nodeB, '--text', 'constraint on node B']);
    await out(['add', '--scope', 'node', '--node', nodeC, '--text', 'constraint on node C']);
    const planted = entries();
    ids.g = planted[0]!.id;
    ids.bt = planted[1]!.id;
    ids.k1 = planted[2]!.id;
    ids.k2 = planted[3]!.id;
    ids.na = planted[4]!.id;
    ids.nb = planted[5]!.id;
    ids.nc = planted[6]!.id;
    await add('archived constraint');
    ids.nw = entries()[entries().length - 1]!.id;
    await out(['resolve', ids.nw!, '--state', 'withdrawn']);
    await add('constraint taken away');
    ids.g2 = entries()[entries().length - 1]!.id;
    await out(['rm', ids.g2!]);
    return { ids, nodeA, nodeB };
  }

  type ReadSpot = 'default' | 'on node B' | 'after the line leaves service' | 'full book';

  /** A matrix row: scope x binding state x target x reading spot -> seen / not seen. */
  const ROWS: Array<{ key: string; scope: string; binding: string; target: string; spot: ReadSpot; seen: boolean }> = [
    { key: 'g', scope: 'global', binding: '—', target: 'stage', spot: 'default', seen: true },
    { key: 'g', scope: 'global', binding: '—', target: 'stage', spot: 'on node B', seen: true },
    { key: 'g', scope: 'global', binding: '—', target: 'stage', spot: 'after the line leaves service', seen: true },
    { key: 'bt', scope: 'global', binding: '—', target: 'boundary', spot: 'default', seen: true },
    { key: 'bt', scope: 'global', binding: '—', target: 'boundary', spot: 'after the line leaves service', seen: true },
    { key: 'k1', scope: 'cycle', binding: 'in service', target: 'stage', spot: 'default', seen: true },
    { key: 'k1', scope: 'cycle', binding: 'in service', target: 'stage', spot: 'on node B', seen: true },
    { key: 'k1', scope: 'cycle', binding: 'in service', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'k2', scope: 'cycle', binding: 'out of service', target: 'stage', spot: 'default', seen: false },
    { key: 'k2', scope: 'cycle', binding: 'out of service', target: 'stage', spot: 'on node B', seen: false },
    { key: 'k2', scope: 'cycle', binding: 'out of service', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'na', scope: 'node', binding: 'unfinished (held)', target: 'stage', spot: 'default', seen: true },
    { key: 'na', scope: 'node', binding: 'unfinished', target: 'stage', spot: 'on node B', seen: false },
    { key: 'na', scope: 'node', binding: 'unfinished', target: 'stage', spot: 'after the line leaves service', seen: true },
    { key: 'nb', scope: 'node', binding: 'done', target: 'stage', spot: 'default', seen: false },
    { key: 'nb', scope: 'node', binding: 'done (the node itself)', target: 'stage', spot: 'on node B', seen: true },
    { key: 'nb', scope: 'node', binding: 'done', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'nc', scope: 'node', binding: 'out of service, unfinished', target: 'stage', spot: 'on node B', seen: false },
    { key: 'nc', scope: 'node', binding: 'out of service, unfinished', target: 'stage', spot: 'after the line leaves service', seen: true },
    { key: 'nw', scope: 'global', binding: 'archived', target: 'stage', spot: 'default', seen: false },
    { key: 'nw', scope: 'global', binding: 'archived', target: 'stage', spot: 'on node B', seen: false },
    { key: 'nw', scope: 'global', binding: 'archived', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'default', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'on node B', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'g2', scope: 'global', binding: 'removed (tombstone)', target: 'stage', spot: 'full book', seen: false },
  ];

  it.each(
    ROWS.map((row) => ({
      ...row,
      title: `${row.key} (${row.scope}/${row.binding}/${row.target}) from ${row.spot}: ${row.seen ? 'seen' : 'not seen'}`,
    })),
  )('$title', async ({ key, spot, seen }) => {
    const { ids, nodeB } = await plantScenario();
    let rows: string[];
    if (spot === 'on node B') rows = await idsOf(['list', '--json', '--node', nodeB]);
    else if (spot === 'after the line leaves service') {
      await superworker.ledger.cycles.setStatus('one', 'inactive');
      rows = await idsOf(['list', '--json']);
    } else if (spot === 'full book') rows = await idsOf(['list', '--all', '--json']);
    else rows = await idsOf(['list', '--json']);
    expect(rows.includes(ids[key]!)).toBe(seen);
  });

  it('a tombstone is hidden but kept: the body is gone from disk while removed keeps the id and the stamp', async () => {
    const { ids } = await plantScenario();
    const raw = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(raw).not.toContain('constraint taken away');
    const traces = readInstructionFile().removed as Array<{ id: string; at: string }>;
    expect(traces.map((trace) => trace.id)).toEqual([ids.g2]);
    expect(traces[0]!.at).toMatch(SECONDS_SHAPE);
    // A tombstone has only the id and the stamp: no body and no status word.
    expect(Object.keys(traces[0]!).sort()).toEqual(['at', 'id']);
  });
});

describe('resolve / revive: the archive and revive round trip', () => {
  it('resolve lands the state and the settling stamp: the entry leaves the default view while the full book still has it', async () => {
    await add('run the typecheck before handing it in');
    expect(await out(['resolve', 'i-0001', '--state', 'withdrawn'])).toBe('INSTRUCTION i-0001 → withdrawn');
    expect(entries()[0]).toMatchObject({ state: 'withdrawn', text: 'run the typecheck before handing it in' });
    expect(entries()[0]!.resolved_at).toMatch(SECONDS_SHAPE);

    expect(await idsOf(['list', '--json'])).toEqual([]);
    expect(await idsOf(['list', '--all', '--json'])).toEqual(['i-0001']);
  });

  it('the resolve-then-revive round trip: back to live, the settling stamp cleared, the default view back', async () => {
    await add('the report writes the present value only');
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);
    expect(await out(['revive', 'i-0001'])).toBe('INSTRUCTION i-0001 → live');
    expect(entries()[0]).toMatchObject({ state: 'live', resolved_at: null });
    expect(await idsOf(['list', '--json'])).toEqual(['i-0001']);
    // Reviving touches only the state and stamp cells; every other key stays as it is.
    expect(Object.keys(entries()[0]!).sort()).toEqual([
      'at', 'cycle', 'id', 'node', 'note', 'resolved_at', 'said_by', 'scope',
      'state', 'target', 'text',
    ]);
  });

  it('an entry already in force refuses to revive; on the refusal not one byte on disk moves', async () => {
    await add('still live');
    const before = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(await err(['revive', 'i-0001'])).toContain('already live');
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toBe(before);
  });

  it('a taken-away id refuses to revive and names the stamp of the removal; an id the book never had refuses too', async () => {
    await add('the one to take away');
    await out(['rm', 'i-0001']);
    expect(await err(['revive', 'i-0001'])).toMatch(/was removed at .+; its text went with it/);
    expect(await err(['revive', 'i-9999'])).toContain('no instruction');
  });

  it('resolve with a note: the sentence lands on the record beside the settling stamp, and a later resolve without one leaves it', async () => {
    await add('archived with a note');
    await out(['resolve', 'i-0001', '--state', 'withdrawn', '--note', 'owner said so']);
    expect(entries()[0]!.note).toBe('owner said so');
    // Archiving the same entry again with no note writes the state and the stamp only.
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);
    expect(entries()[0]!.note).toBe('owner said so');
  });

  it('resolve refuses an id the book does not have; archiving an archived entry again still moves its stamp forward', async () => {
    expect(await err(['resolve', 'i-9999', '--state', 'withdrawn'])).toContain('no instruction');
    await add('archived twice');
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);
    const first = entries()[0]!.resolved_at!;
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);
    expect(entries()[0]!.state).toBe('withdrawn');
    expect(entries()[0]!.resolved_at! >= first).toBe(true);
  });

  it('a resolve line without --state is refused as a usage error before anything is read', async () => {
    await add('a sentence');
    const before = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(await err(['resolve', 'i-0001'])).toContain('--state');
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toBe(before);
  });
});

describe('rm: taking away and tombstones', () => {
  it('a taken-away entry disappears from every reading and its body leaves the disk; the tombstone keeps the id and the stamp', async () => {
    await add('the first one to take away');
    await add('the second one left behind');
    // The sentence is printed first, then it goes.
    expect(await out(['rm', 'i-0001'])).toBe(
      'INSTRUCTION i-0001: [global/stage] the first one to take away\nREMOVED i-0001',
    );

    expect(await idsOf(['list', '--json'])).toEqual(['i-0002']);
    expect(await idsOf(['list', '--all', '--json'])).toEqual(['i-0002']);
    const raw = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(raw).not.toContain('the first one to take away');
    const file = readInstructionFile();
    expect(Object.keys(file)).toEqual(['instructions', 'removed']);
    const traces = file.removed as Array<{ id: string; at: string }>;
    expect(traces[0]!.id).toBe('i-0001');
    expect(traces[0]!.at).toMatch(SECONDS_SHAPE);
  });

  it('removing a second time names the tombstone; an id the book never had is refused', async () => {
    await add('take away once');
    await out(['rm', 'i-0001']);
    const before = readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8');
    expect(await err(['rm', 'i-0001'])).toMatch(/was removed at .+; its text is already/);
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toBe(before);
    expect(await err(['rm', 'i-9999'])).toContain('no instruction');
  });
});

describe('list: position, order and the two views', () => {
  it('account order: neither view sorts; the rows come back in the order the file holds them', async () => {
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['coding'] });
    await superworker.ledger.cycles.hold('c1', 'node-a');
    await plantInstructions([
      { id: 'i-0001', text: 'old global', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0002', text: 'on the line', scope: 'cycle', target: 'stage', state: 'live', cycle: 'c1', node: 'node-a', said_by: 'user', at: '2026-01-02T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0003', text: 'on the node', scope: 'node', target: 'stage', state: 'live', cycle: null, node: 'node-b', said_by: 'user', at: '2026-01-03T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0004', text: 'new global', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-04T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0005', text: 'archived global', scope: 'global', target: 'stage', state: 'withdrawn', cycle: null, node: null, said_by: 'user', at: '2026-01-05T00:00:00Z', resolved_at: '2026-01-05T01:00:00Z', note: null },
    ]);
    expect(await idsOf(['list', '--all', '--json'])).toEqual(['i-0001', 'i-0002', 'i-0003', 'i-0004', 'i-0005']);
  });

  it('the machine view is folded to four cells; the delivered channel is a word of the printed view, never a third value', async () => {
    await add('only read at wrap-up', ['--target', 'boundary']);
    expect(JSON.parse(await out(['list', '--json']))).toEqual([
      { id: 'i-0001', text: 'only read at wrap-up', scope: 'global', target: 'boundary' },
    ]);
    // The reader's text says how it is delivered: the stage channel on every node, the boundary one
    // only at the close.
    expect(await out(['list'])).toContain('reach: read only at the close');
    await plantInstructions([
      { id: 'i-0009', text: 'no delivery channel written', scope: 'global', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
    ]);
    expect(await out(['list'])).toContain('reach: every node');
    // A word outside the two-word vocabulary reads the stage default too: reach is never a third word.
    await plantInstructions([
      { id: 'i-0010', text: 'foreign delivery word', scope: 'global', target: 'round', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
    ]);
    expect(await out(['list'])).toContain('reach: every node');
  });

  it("the default view follows the reader's spot: a named node pins it; with two lines side by side and no name it falls back to the wide read", async () => {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await superworker.ledger.cycles.hold('two', nodeB);
    await out(['add', '--scope', 'cycle', '--cycle', 'one', '--text', 'constraint of line one']);
    await out(['add', '--scope', 'cycle', '--cycle', 'two', '--text', 'constraint of line two']);

    // Naming a node pins the line: the first node is in the first line's hand, so only that line is
    // read; the second is in the second's, so only the second is read.
    expect(await idsOf(['list', '--json', '--node', nodeA])).toEqual(['i-0001']);
    expect(await idsOf(['list', '--json', '--node', nodeB])).toEqual(['i-0002']);
    // Nobody is named: the spot cannot be pinned, so the read goes wide — both lines in service count.
    expect(await idsOf(['list', '--json'])).toEqual(expect.arrayContaining(['i-0001', 'i-0002']));
  });

  it('an old record with no binding is visible everywhere; an unrecognized scope word reads as global', async () => {
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['coding'] });
    await superworker.ledger.cycles.hold('c1', 'node-a');
    await plantInstructions([
      { id: 'i-0001', text: 'cycle scope with nothing bound', scope: 'cycle', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0002', text: 'node scope with nothing bound', scope: 'node', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-02T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0003', text: 'old-word scope', scope: 'once', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-03T00:00:00Z', resolved_at: null, note: null },
    ]);
    // node-a is in hand and c1 is in service: all three are readable (an empty binding measures
    // nothing; `once` reads as global), in the order the file holds them.
    expect(await idsOf(['list', '--json'])).toEqual(['i-0001', 'i-0002', 'i-0003']);
    // The scope filter works on the scope as read: `once` falls into the global group.
    expect(await idsOf(['list', '--scope', 'global', '--json'])).toEqual(['i-0003']);
    expect(await idsOf(['list', '--scope', 'cycle', '--json'])).toEqual(['i-0001']);
    // The live account view keeps the raw rows, and drops what is not live.
    const live = JSON.parse(await out(['list', '--live', '--json'])) as Array<Record<string, unknown>>;
    expect(live.map((row) => row.id)).toEqual(['i-0001', 'i-0002', 'i-0003']);
    expect('state' in live[0]!).toBe(true);
  });

  it('an empty project with no cycle book: both views are empty', async () => {
    expect(await idsOf(['list', '--json'])).toEqual([]);
    expect(await idsOf(['list', '--all', '--json'])).toEqual([]);
    // And the text answers say which silence this is: no record at all is not a failure.
    expect(await out(['list'])).toBe(
      'This project has no instruction record at all.\nThat is not an error: work can start as usual.',
    );
  });

  it('the scope is never written down: the account keeps every byte across three kinds of list', async () => {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await add('global constraint');
    await out(['add', '--scope', 'cycle', '--cycle', 'one', '--text', 'line constraint']);
    await out(['add', '--scope', 'node', '--node', nodeA, '--text', 'constraint on A']);
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);

    const file = join(root, '.superworker', 'instructions.json');
    const before = readFileSync(file, 'utf8');
    const defaultView = await idsOf(['list', '--json']);
    const namedNodeB = await idsOf(['list', '--json', '--node', nodeB]);
    const fullBook = await idsOf(['list', '--all', '--json']);
    // Scope is worked out on every read and never written: after three readings the bytes are as they were.
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(defaultView.sort()).toEqual(['i-0002', 'i-0003']);
    // With one line in service, naming the second node gives the spot (one, that node), so the entry
    // bound to the first node is not read.
    expect(namedNodeB).toEqual(['i-0002']);
    expect(fullBook).toEqual(['i-0001', 'i-0002', 'i-0003']);
  });

  it('a foreign state word reads as archived: absent from the default view, still in the full book, never written back', async () => {
    await plantInstructions([
      { id: 'i-0001', text: 'foreign state word', scope: 'global', target: 'stage', state: 'some other word', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
    ]);
    expect(await idsOf(['list', '--json'])).toEqual([]);
    expect(await idsOf(['list', '--all', '--json'])).toEqual(['i-0001']);
    expect(readFileSync(join(root, '.superworker', 'instructions.json'), 'utf8')).toContain('some other word');
  });

  it('naming a node nobody holds: the spot cannot be pinned, so the read goes wide', async () => {
    const nodeA = (await superworker.ledger.dag.add({ title: 'A' })).id;
    const nodeB = (await superworker.ledger.dag.add({ title: 'B' })).id;
    const nodeC = (await superworker.ledger.dag.add({ title: 'C' })).id;
    await superworker.ledger.cycles.create({ id: 'one', tags: ['coding'] });
    await superworker.ledger.cycles.hold('one', nodeA);
    await superworker.ledger.cycles.create({ id: 'two', tags: ['writing'], force: true });
    await superworker.ledger.cycles.hold('two', nodeB);
    await out(['add', '--scope', 'cycle', '--cycle', 'one', '--text', 'constraint of line one']);
    await out(['add', '--scope', 'cycle', '--cycle', 'two', '--text', 'constraint of line two']);

    // The third node is on the graph but nobody holds it: the only way to pin a spot fails, so no
    // spot is given and the read goes wide.
    expect((await idsOf(['list', '--json', '--node', nodeC])).sort()).toEqual(['i-0001', 'i-0002']);
  });

  it('--project names another project root; a root with no record directory reads as an empty account', async () => {
    const other = mkdtempSync(join(tmpdir(), 'superworker-ins-other-'));
    try {
      expect(await out(['list', '--json', '--project', other])).toBe('[]');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('--project at a linked worktree root acts on the main tree; a submodule or a main tree with no record is taken as it is', async () => {
    const main = mkdtempSync(join(tmpdir(), 'superworker-ins-main-'));
    const linked = mkdtempSync(join(tmpdir(), 'superworker-ins-linked-'));
    const submodule = mkdtempSync(join(tmpdir(), 'superworker-ins-sub-'));
    const plain = mkdtempSync(join(tmpdir(), 'superworker-ins-plain-'));
    const orphan = mkdtempSync(join(tmpdir(), 'superworker-ins-orphan-'));
    /** One line run against a named root instead of this case's own project (`add` takes no `--project`). */
    const runIn = async (dir: string, argv: string[]): Promise<unknown> =>
      (instruction as (argv: string[], ctx: { root: string }) => Promise<unknown>)(argv, { root: dir });
    try {
      await open(main).ledger.init();
      await runIn(main, ['add', '--scope', 'global', '--text', 'kept in the main tree']);
      const mainFile = join(main, '.superworker', 'instructions.json');

      // A linked worktree's checkout root: `.git` is a *file* naming the main tree's worktree record
      // directory. That pointer is what an explicit root is resolved through — the worktree holds the
      // record as of the fork, so acting on it would settle on a stale snapshot.
      mkdirSync(join(main, '.git', 'worktrees', 'node-checkout'), { recursive: true });
      writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'node-checkout')}\n`);
      expect(await idsOf(['list', '--json', '--project', linked])).toEqual(['i-0001']);
      // A write through the same explicit root lands on the main tree's account; the worktree keeps no
      // record of its own.
      expect(await out(['resolve', 'i-0001', '--state', 'withdrawn', '--project', linked])).toBe(
        'INSTRUCTION i-0001 → withdrawn',
      );
      expect(readFileSync(mainFile, 'utf8')).toContain('"state": "withdrawn"');
      expect(existsSync(join(linked, '.superworker', 'instructions.json'))).toBe(false);

      // A submodule's `gitdir:` points at `.git/modules/…`, not at a worktree: the directory is the project.
      writeFileSync(join(submodule, '.git'), `gitdir: ${join(main, '.git', 'modules', 'sub')}\n`);
      expect(await idsOf(['list', '--json', '--project', submodule])).toEqual([]);
      // A worktree-shaped pointer whose main tree carries no record of its own: the directory is the project too.
      mkdirSync(join(plain, '.git', 'worktrees', 'x'), { recursive: true });
      writeFileSync(join(orphan, '.git'), `gitdir: ${join(plain, '.git', 'worktrees', 'x')}\n`);
      expect(await idsOf(['list', '--json', '--project', orphan])).toEqual([]);
    } finally {
      for (const dir of [main, linked, submodule, plain, orphan]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the surface itself', () => {
  it('help lists the five verbs and their flags; an unknown verb and an unknown flag are refused', async () => {
    const page = await out(['help']);
    for (const verb of ['add', 'list', 'resolve', 'rm', 'revive']) expect(page).toContain(`${verb}`);
    expect(page).toContain('--stop-after-nodes');
    expect(await err(['frobnicate'])).toContain('unrecognized command "frobnicate"');
    expect(await err(['list', '--wat'])).toContain('unrecognized argument: --wat');
    expect(await err(['rm', 'i-1', 'i-2'])).toContain('positional argument(s)');
  });

  it('a trailing help flag asks the same page without running the verb', async () => {
    const page = await out(['help']);
    expect(await out(['rm', '--help'])).toBe(page);
    expect(await out(['list', '-h'])).toBe(page);
  });

  it('the bare word is a usage refusal (code 2, the page); an empty sentence is a plain failure (code 1, no code on it)', async () => {
    // No verb named: the page itself is the refusal, and the usage code is what it asks for. The plugin
    // seam carries exactly this one code, and the caller puts the sentence on its stderr stream.
    const bare = await refusalOf([]);
    expect(bare).toBeInstanceOf(UsageError);
    expect(bare.code).toBe(2);
    expect(bare.message).toBe((await out(['help'])).replace(/\n+$/u, ''));
    expect((await refusalOf(['frobnicate'])).code).toBe(2);

    // An empty sentence is not a malformed line: it is a failure of the run, thrown plain, so the host
    // answers it with code 1 (`main failed`) as it did before this folder owned the verb.
    const blank = await refusalOf(['add', '--scope', 'global', '--text', '   ']);
    expect(blank).not.toBeInstanceOf(UsageError);
    expect(blank.code).toBeUndefined();
    expect(blank.message).toBe('text must not be empty');
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });
});

describe('the init gate: a `.superworker` that was never init-ed keeps every byte', () => {
  it('add refuses and the `.superworker` dir was never even raised', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'superworker-ins-gate-'));
    try {
      const line = ['add', '--scope', 'global', '--text', 'the one that cannot get in'];
      expect(
        String(await (instruction as (argv: string[], ctx: { root: string }) => Promise<unknown>)(line, { root: bare }).catch(
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )),
      ).toMatch(/was never init-ed .*Ask `init` first/);
      expect(existsSync(join(bare, '.superworker'))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('whole-file read-modify-write: every other top-level key is kept as it is', () => {
  it('a foreign top-level key is still there after add / resolve / rm write back', async () => {
    await add('witness to a foreign key');
    const file = join(root, '.superworker', 'instructions.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    data.hand_merged = { keep: 'me', nested: { v: 1 } };
    await atomicWriteJson(file, data, jsonOptionsForRecord('instructions'));

    await out(['resolve', 'i-0001', '--state', 'withdrawn']);
    expect(readInstructionFile().hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });
    await out(['rm', 'i-0001']);
    const after = readInstructionFile();
    expect(after.hand_merged).toEqual({ keep: 'me', nested: { v: 1 } });
    expect(Object.keys(after)).toEqual(['instructions', 'hand_merged', 'removed']);
    expect((after.instructions as unknown[]).length).toBe(0);
  });
});