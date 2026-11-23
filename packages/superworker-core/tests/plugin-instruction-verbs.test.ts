import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as instruction } from '../plugins/instruction/tools/commands.mjs';
import { UsageError } from '../src/plugins/verb-surface';
import { pluginBase, type PluginBase } from '../src/plugins/base';
import { atomicWriteJson, jsonBytes, jsonOptionsForRecord } from '../src/jsonio';
import { open } from '../src/open';
import { projectRootOf } from '../src/words/out';
import { git, makeRepo } from './helpers/git-runner';
import { SLOW } from './helpers/slow';

/**
 * The `instruction` command surface, this plugin folder's own (`plugins/instruction/`): register,
 * list, archive, revive, take away, plus visibility as a pure deduction.
 *
 * What is pinned is the criterion, not the implementation: the visibility matrix (scope x binding
 * state x position), the add / resolve / revive round trip, tombstones hidden but kept, ids never
 * issued twice, the account's whole-file read-modify-write, and that the write verbs carry no init
 * gate of their own (that reading is `src/initledger.ts`'s alone). The record belongs to
 * this folder, so its shape is spelled here rather than taken from the engine's exports. The
 * context carries the record base the way the host hands it in, so the plugin's own layer is
 * exercised exactly as the runtime exercises it.
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

interface Ctx {
  root: string;
  base: PluginBase;
  projectRootOf: typeof projectRootOf;
}

let root: string;
let ctx: Ctx;
let superworker: ReturnType<typeof open>;

/** The seconds shape: 2026-...T...:...:...Z. That is the only shape an instruction stamp takes. */
const SECONDS_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-ins-cmd-'));
  ctx = { root, base: pluginBase(), projectRootOf };
  superworker = open(root);
  await superworker.ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
  ctx = undefined!;
  superworker = undefined!;
});

/**
 * One line through the plugin's own command surface: the folder the host loads by path is what runs.
 * The context is the case's own root with the record base the host hands in.
 */
async function out(argv: string[]): Promise<string> {
  return String(await runIn(root, argv));
}

/**
 * One line run against a context of this case's own, with the cells the host hands in replaced: the
 * record base, the root a line acts on, or the resolution a named `--project` is answered with.
 */
async function outIn(cells: Partial<Ctx>, argv: string[]): Promise<string> {
  return String(await (instruction as (argv: string[], ctx: Ctx) => Promise<unknown>)(argv, { ...ctx, ...cells }));
}

/** One line run against a named root instead of this case's own project. */
async function runIn(dir: string, argv: string[]): Promise<unknown> {
  return outIn({ root: dir }, argv);
}

/** The texts one listing carries, in account order: the cell that tells two accounts apart. */
async function textsOf(cells: Partial<Ctx>, argv: string[]): Promise<string[]> {
  return (JSON.parse(await outIn(cells, argv)) as InstructionRecord[]).map((row) => row.text);
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

async function plantInstructions(rows: unknown[], at: string = root): Promise<void> {
  await atomicWriteJson(
    join(at, '.superworker', 'instructions.json'),
    { instructions: rows },
    jsonOptionsForRecord('instructions'),
  );
}

/** Plant the whole ideas.json document as raw text: a hand edit or a hand merge is how a bad shape gets here. */
function plantGraph(body: string): void {
  writeFileSync(join(root, '.superworker', 'ideas.json'), body, 'utf8');
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
    await out(['add', '--scope', 'global', '--text', 'global constraint']);
    const [byCycle, byGlobal] = entries();
    expect(byCycle!.cycle).toBe('main');
    expect(byCycle!.node).toBe(node.id);
    expect(byGlobal!.cycle).toBe('main');
    expect(byGlobal!.node).toBe(node.id);
  });

  it('a named cycle that is not in the book is refused on the spot; add no longer takes --node', async () => {
    await superworker.ledger.cycles.create({ id: 'main', tags: ['coding'] });
    expect(await err(['add', '--scope', 'cycle', '--cycle', 'ghost', '--text', 'x'])).toContain(
      'cycle "ghost" is not in state.json',
    );
    // The node level is retired, so `add` carries no `--node` at all: the line is refused as a
    // usage error before anything is read. `list` keeps its own `--node` (the reader's position).
    expect(await err(['add', '--node', 'some-node', '--text', 'x'])).toContain('unrecognized argument: --node');
    // Both refusals happen on the spot: not one byte ever landed in the account.
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
  });

  it('a cycle scope with nothing to bind to is refused, and not one byte lands; the retired scope word is a closed-set refusal', async () => {
    expect(await err(['add', '--scope', 'cycle', '--text', 'x'])).toContain('needs a line to bind to');
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
    // `node` is a retired word, and the refusal is the closed set's own: code 2, nothing read.
    expect(await err(['add', '--scope', 'node', '--text', 'x'])).toContain('invalid scope "node"');
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
});

/**
 * The node level is retired, and this folder no longer reads the graph at all: `add` binds a line
 * (state.json) and `list` pins a position by the line's own hand. A broken `ideas.json` therefore
 * stops neither the read nor the write — the account's answers rest on its own record and the line
 * account alone.
 */
describe('the account no longer reads the graph', () => {
  it('a broken ideas.json stops neither the listing nor a write', async () => {
    plantGraph('123');
    expect(await out(['list', '--json'])).toBe('[]');
    await add('written beside a broken graph');
    expect(entries()[0]!.text).toBe('written beside a broken graph');
  });
});

describe('the visibility matrix: scope x binding state x position', () => {
  /**
   * A fixed scene: the first node is todo and held by the main line, the second is completed and held
   * by that line, the third is todo and held by a line that left service; two globals (stage /
   * boundary), one on the main line, one on the line out of service, two rows an older account wrote
   * with the retired node scope, one archived, one taken away (a tombstone). The retired rows are
   * planted by hand — the verb no longer issues that scope word, so an old record is the only way
   * they exist — and they sit first, so every id the verb issues after them proves a retired row
   * still counts as an issued number.
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

    const retired = (id: string, node: string, text: string): Record<string, unknown> => ({
      id, text, scope: 'node', target: 'stage', state: 'live', cycle: null, node,
      said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null,
    });
    await plantInstructions([
      retired('i-0001', nodeA, 'retired constraint on node A'),
      retired('i-0002', nodeB, 'retired constraint on node B'),
    ]);

    const ids: Record<string, string> = {};
    await add('global constraint');
    await add('global constraint on the wrap-up edge', ['--target', 'boundary']);
    await out(['add', '--scope', 'cycle', '--cycle', 'one', '--text', 'constraint of this line']);
    await out(['add', '--scope', 'cycle', '--cycle', 'two', '--text', 'constraint of the out-of-service line']);
    const planted = entries();
    ids.na = planted[0]!.id;
    ids.nb = planted[1]!.id;
    ids.g = planted[2]!.id;
    ids.bt = planted[3]!.id;
    ids.k1 = planted[4]!.id;
    ids.k2 = planted[5]!.id;
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
    // The retired rows: read by no view, from no spot — not even the full book.
    { key: 'na', scope: 'node (retired)', binding: 'unfinished (held)', target: 'stage', spot: 'default', seen: false },
    { key: 'na', scope: 'node (retired)', binding: 'unfinished (held)', target: 'stage', spot: 'on node B', seen: false },
    { key: 'na', scope: 'node (retired)', binding: 'unfinished (held)', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'na', scope: 'node (retired)', binding: 'unfinished (held)', target: 'stage', spot: 'full book', seen: false },
    { key: 'nb', scope: 'node (retired)', binding: 'done', target: 'stage', spot: 'default', seen: false },
    { key: 'nb', scope: 'node (retired)', binding: 'done (the node itself)', target: 'stage', spot: 'on node B', seen: false },
    { key: 'nb', scope: 'node (retired)', binding: 'done', target: 'stage', spot: 'after the line leaves service', seen: false },
    { key: 'nb', scope: 'node (retired)', binding: 'done', target: 'stage', spot: 'full book', seen: false },
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

  it('a retired row still counts as an issued number: the first add after it takes the next id', async () => {
    await plantScenario();
    // The two planted rows are i-0001 / i-0002; the first verb-issued entry after them is i-0003.
    expect(entries().map((row) => row.id).slice(0, 3)).toEqual(['i-0001', 'i-0002', 'i-0003']);
  });

  it('the account views say the retired rows out loud; the reader view and the machine view say nothing', async () => {
    await plantScenario();
    // The reader's view (what the host injects, byte for byte) carries no mention.
    const reader = await out(['list']);
    expect(reader).not.toContain('retired');
    // The machine's view is a plain array of the readable rows.
    expect(await idsOf(['list', '--json', '--all'])).not.toContain('i-0001');
    // The account view closes with the one line that says they are there.
    const account = await out(['list', '--all']);
    expect(account).toContain('(2 more entries on this account carry a retired scope word');
    // And the account verbs still reach them by id: rm takes a retired row off.
    expect(await out(['rm', 'i-0001'])).toContain('REMOVED i-0001');
    expect((await out(['list', '--all']))).not.toContain('(2 more entries');
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
      { id: 'i-0003', text: 'on the line, said later', scope: 'cycle', target: 'stage', state: 'live', cycle: 'c1', node: null, said_by: 'user', at: '2026-01-03T00:00:00Z', resolved_at: null, note: null },
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

  it('an old record with no binding is visible everywhere; an unrecognized scope word reads as global; a retired word reads nowhere', async () => {
    await superworker.ledger.cycles.create({ id: 'c1', tags: ['coding'] });
    await superworker.ledger.cycles.hold('c1', 'node-a');
    await plantInstructions([
      { id: 'i-0001', text: 'cycle scope with nothing bound', scope: 'cycle', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-01T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0002', text: 'the retired level, written by an older account', scope: 'node', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-02T00:00:00Z', resolved_at: null, note: null },
      { id: 'i-0003', text: 'old-word scope', scope: 'once', target: 'stage', state: 'live', cycle: null, node: null, said_by: 'user', at: '2026-01-03T00:00:00Z', resolved_at: null, note: null },
    ]);
    // node-a is in hand and c1 is in service: the unbound cycle row and the foreign word are
    // readable (an empty binding measures nothing; `once` reads as global), in the order the file
    // holds them. The retired row is read by nobody, binding or not.
    expect(await idsOf(['list', '--json'])).toEqual(['i-0001', 'i-0003']);
    // The scope filter works on the scope as read: `once` falls into the global group.
    expect(await idsOf(['list', '--scope', 'global', '--json'])).toEqual(['i-0003']);
    expect(await idsOf(['list', '--scope', 'cycle', '--json'])).toEqual(['i-0001']);
    // The live account view keeps the raw rows, and drops what is not live.
    const live = JSON.parse(await out(['list', '--live', '--json'])) as Array<Record<string, unknown>>;
    expect(live.map((row) => row.id)).toEqual(['i-0001', 'i-0003']);
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
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);

    const file = join(root, '.superworker', 'instructions.json');
    const before = readFileSync(file, 'utf8');
    const defaultView = await idsOf(['list', '--json']);
    const namedNodeB = await idsOf(['list', '--json', '--node', nodeB]);
    const fullBook = await idsOf(['list', '--all', '--json']);
    // Scope is worked out on every read and never written: after three readings the bytes are as they were.
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(defaultView).toEqual(['i-0002']);
    // Naming the second node still pins the same line (one, that node), so the line constraint reads.
    expect(namedNodeB).toEqual(['i-0002']);
    expect(fullBook).toEqual(['i-0001', 'i-0002']);
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

  it('a named --project is answered by the engine\'s resolution, never by a rule of this folder', async () => {
    // The invariant is sameness, not the shape of the rule: whatever `projectRootOf` answers for a
    // directory, the command surface acts on exactly that root. A second copy of the worktree reading
    // in this folder would drift from the engine's the day one side changes; nothing here pins how the
    // rule is written, only that both sides are one answer.
    const main = mkdtempSync(join(tmpdir(), 'superworker-ins-seam-main-'));
    const linked = mkdtempSync(join(tmpdir(), 'superworker-ins-seam-linked-'));
    const submodule = mkdtempSync(join(tmpdir(), 'superworker-ins-seam-sub-'));
    try {
      await open(main).ledger.init();
      await runIn(main, ['add', '--scope', 'global', '--text', 'the main tree answers']);
      mkdirSync(join(main, '.git', 'worktrees', 'node-checkout'), { recursive: true });
      writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'node-checkout')}\n`);
      writeFileSync(join(submodule, '.git'), `gitdir: ${join(main, '.git', 'modules', 'sub')}\n`);

      const engineAnswer = projectRootOf(linked, root);
      expect(engineAnswer).toBe(main);
      expect(await idsOf(['list', '--json', '--project', linked])).toEqual(['i-0001']);
      // The same read through the engine's own answer: one root, one account.
      expect(await idsOf(['list', '--json', '--project', engineAnswer])).toEqual(['i-0001']);
      // A submodule pointer is not a worktree pointer: the engine answers the directory itself, and the
      // word acts on that same directory.
      expect(projectRootOf(submodule, root)).toBe(submodule);
      expect(await idsOf(['list', '--json', '--project', submodule])).toEqual([]);
    } finally {
      for (const dir of [main, linked, submodule]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the root a --project line acts on is the seam\'s answer, even when that answer is not this folder\'s own', async () => {
    // The decisive one: a decoy resolution answers a third directory whatever it is asked, and that
    // directory's account carries different text. A folder that asked the seam reads the decoy's
    // account; a folder that still carried the worktree rule of its own would answer `main` and read
    // `main`'s text, because the real rule for `linked` is `main`. This is the only case here that can
    // tell the two implementations apart — every other assertion is satisfied by both.
    const main = mkdtempSync(join(tmpdir(), 'superworker-ins-decoy-main-'));
    const decoy = mkdtempSync(join(tmpdir(), 'superworker-ins-decoy-third-'));
    const linked = mkdtempSync(join(tmpdir(), 'superworker-ins-decoy-linked-'));
    try {
      await open(main).ledger.init();
      await open(decoy).ledger.init();
      await runIn(main, ['add', '--scope', 'global', '--text', 'ACCOUNT=main']);
      await runIn(decoy, ['add', '--scope', 'global', '--text', 'ACCOUNT=decoy']);
      // A real worktree-shaped pointer, whose *own* answer the engine states as `main`.
      mkdirSync(join(main, '.git', 'worktrees', 'node-checkout'), { recursive: true });
      writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'node-checkout')}\n`);
      expect(projectRootOf(linked, linked)).toBe(main);

      // Handed a resolution that answers `decoy`: the line acts on `decoy`, not on `main`.
      const decoySeam = (): string => decoy;
      expect(await textsOf({ projectRootOf: decoySeam }, ['list', '--json', '--all', '--project', linked])).toEqual([
        'ACCOUNT=decoy',
      ]);
      // And with the engine's own resolution in that same cell, the same line reads `main`: the answer
      // is the cell's, which is what "the folder owns no rule" means.
      expect(await textsOf({}, ['list', '--json', '--all', '--project', linked])).toEqual(['ACCOUNT=main']);
    } finally {
      for (const dir of [main, decoy, linked]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a context with no resolution on it is refused with a sentence, not a bare `is not a function`', async () => {
    // The seam is a cell the host must hand in; an engine too old to know it should hear so. The
    // refusal names the cell and what to do about it, the way the record base's own guard does.
    const other = mkdtempSync(join(tmpdir(), 'superworker-ins-noseam-'));
    try {
      const { projectRootOf: _dropped, ...withoutSeam } = ctx;
      await expect(
        (instruction as (argv: string[], ctx: Partial<Ctx>) => Promise<unknown>)(
          ['list', '--json', '--project', other],
          withoutSeam,
        ),
      ).rejects.toThrow(
        /ctx\.projectRootOf\)?, and this engine hands none in: update the engine, or install the build of this plugin/,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('the plugin folder carries no copy of the worktree reading: the second home cannot come back unseen', () => {
    // Criterion 2 of the node's spec, as a standing guard: "the plugin's storage no longer carries its
    // own recognition". Nothing else in the suite would go red if somebody copied `mainTreeOf` back
    // into `plugins/instruction/tools/storage.mjs` — `guard.test.ts` guards `src/`, not `plugins/` —
    // so the regression this node exists to prevent would pass silently.
    //
    // What is guarded is the *implementation*, not a vocabulary, and no broader claim: a second copy
    // of the rule cannot be written without reading the `.git` pointer under the directory it was
    // handed. So the assertion is "this folder reads `.git` nowhere", and a plugin that reads the
    // resolution from `ctx.projectRootOf` (the shape `types.ts` documents, `ctx.projectRootOf(named,
    // ctx.root)`) is a legitimate reader and stays green. The shapes below are the ones that prove a
    // read is *about `.git`* — the pointer's own file name, the `gitdir:` line inside it, and the
    // `worktrees` segment of a linked worktree's record path. Generic calls such as `readFileSync(`
    // and `statSync(` are deliberately not in the list: this folder may read files for its own
    // reasons (a sibling plugin reads a `--from-file` argument the same way), and those calls say
    // nothing about where a project root comes from. Scanning is recursive over the whole folder:
    // `impl.mjs` is the entry point and the most likely place for a copied rule, and the two tools
    // files are reached from it.
    const pluginFolder = fileURLToPath(new URL('../plugins/instruction/', import.meta.url));
    const files = readdirSync(pluginFolder, { recursive: true })
      .map((name) => String(name))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => join(pluginFolder, name));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('impl.mjs'))).toBe(true);
    // The shapes a `.git` read takes: the pointer's own file name, the `gitdir:` line inside it, and
    // the worktree record directory that line names.
    const readShapes = ['.git', 'gitdir:', 'worktrees'];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const shape of readShapes) {
        expect(
          text,
          `${file} carries "${shape}": this folder reads .git — the resolution has one home, src/words/out.ts`,
        ).not.toContain(shape);
      }
    }
  });

  it('--project at a linked worktree root acts on the main tree; a submodule or a main tree with no record is taken as it is', async () => {
    const main = mkdtempSync(join(tmpdir(), 'superworker-ins-main-'));
    const linked = mkdtempSync(join(tmpdir(), 'superworker-ins-linked-'));
    const submodule = mkdtempSync(join(tmpdir(), 'superworker-ins-sub-'));
    const plain = mkdtempSync(join(tmpdir(), 'superworker-ins-plain-'));
    const orphan = mkdtempSync(join(tmpdir(), 'superworker-ins-orphan-'));
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

  it('a writing verb named another project takes that project\u2019s lock, not the caller\u2019s', async () => {
    // The lock is what makes the read → change → write exclusive, so it has to land on the record the
    // line acts on. A stand-in base records the lock path it is handed: `resolve … --project <other>`
    // must ask for `<other>/.superworker/meta/instructions.lock` and never for this case's own root.
    // Without this reading, deleting the context rewrite would leave every assertion above green —
    // they check where the write landed, not where the lock was taken.
    const other = mkdtempSync(join(tmpdir(), 'superworker-ins-lock-other-'));
    try {
      await open(other).ledger.init();
      await (instruction as (argv: string[], ctx: Ctx) => Promise<unknown>)(
        ['add', '--scope', 'global', '--text', 'an entry in the other project'],
        { root: other, base: pluginBase(), projectRootOf },
      );
      const locksTaken: string[] = [];
      const real = pluginBase();
      const watching: PluginBase = {
        ...real,
        withLock: (lockPath, body, options) => {
          locksTaken.push(lockPath);
          return real.withLock(lockPath, body, options);
        },
      };
      expect(
        String(
          await (instruction as (argv: string[], ctx: Ctx) => Promise<unknown>)(
            ['resolve', 'i-0001', '--state', 'withdrawn', '--project', other],
            { root, base: watching, projectRootOf },
          ),
        ),
      ).toBe('INSTRUCTION i-0001 → withdrawn');
      expect(locksTaken).toEqual([join(other, '.superworker', 'meta', 'instructions.lock')]);
      // A line naming no project takes this case's own lock: the default is not the rewrite.
      await add('a sentence on this project');
      locksTaken.length = 0;
      await (instruction as (argv: string[], ctx: Ctx) => Promise<unknown>)(
        ['resolve', 'i-0001', '--state', 'withdrawn'],
        { root, base: watching, projectRootOf },
      );
      expect(locksTaken).toEqual([join(root, '.superworker', 'meta', 'instructions.lock')]);
    } finally {
      rmSync(other, { recursive: true, force: true });
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

  it('a later call whose context carries no record base answers the guard sentence, not a failure deep in the record read', async () => {
    // The base is read on **every** call, not only on the one that assembles the surface: once the
    // surface exists, a second caller in the same process that hands in no base must still hear the
    // sentence that names the missing cell. Reading the base only while assembling would let that
    // caller through to the record read with `undefined` and fail there — the property error below,
    // which says nothing about the engine the caller is talking to.
    const GUARD =
      'the instruction tool reads its command surface and record base from the context the host hands '
      + 'in (ctx.base), and this engine hands none in: update the engine, or install the build of this '
      + 'plugin that still carries its own record base';
    // A line with the base first: whatever call assembled the surface, the two calls below are
    // second and later ones in this process.
    expect(await out(['list', '--json'])).toBe('[]');
    const bare = { root } as unknown as Ctx; // the project is named; the record base the host adds is not
    const failures: string[] = [];
    // Both lines really need the base — one reads the account, one writes it through its lock — so
    // the sentence that comes back cannot be a runner's own answer either.
    for (const argv of [['list', '--json'], ['add', '--scope', 'global', '--text', 'x']]) {
      const failure = (await (instruction as (argv: string[], ctx: Ctx) => Promise<unknown>)(argv, bare)
        .catch((error: unknown) => error)) as Error;
      expect(failure).toBeInstanceOf(Error);
      failures.push(failure.message);
    }
    expect(failures).toEqual([GUARD, GUARD]);
    // And it really is the guard answering rather than the record read failing one frame deeper, and
    // the refused `add` never reached the lock: not one byte of the account landed.
    expect(failures.join(' ')).not.toContain('readJson');
    expect(failures.join(' ')).not.toContain('withLock');
    expect(existsSync(join(root, '.superworker', 'instructions.json'))).toBe(false);
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

describe('a refused line leaves no byte on disk, the record directory included', () => {
  /** One line run against a directory that has never been init-ed: nothing is there before the line. */
  const refusalIn = async (dir: string, argv: string[]): Promise<unknown> =>
    (instruction as (argv: string[], ctx: Ctx) => Promise<unknown>)(argv, { root: dir, base: pluginBase() });

  it('an empty sentence (code 1) leaves no `.superworker/` at all \u2014 the lock\u2019s directory must not be created on the way', async () => {
    // The writing verbs run under the account's lock, and taking that lock creates
    // `<root>/.superworker/meta/`. A line the account refuses on its own content is settled before the
    // lock is taken, so the refusal reads exactly as it did when the verb held the lock itself: zero
    // bytes, and not even the directory. That directory is what the engine's migration reading sees as
    // a record directory, so leaving it behind would turn a legacy workspace's `migrate` from `ready`
    // into `both-present` — a state only a person can settle.
    const bare = mkdtempSync(join(tmpdir(), 'superworker-ins-refusal-'));
    try {
      const blank = (await refusalIn(bare, ['add', '--scope', 'global', '--text', '   ']).catch(
        (error: unknown) => error,
      )) as Error & { code?: number };
      expect(blank.message).toBe('text must not be empty');
      expect(blank.code).toBeUndefined();
      expect(existsSync(join(bare, '.superworker', 'instructions.json'))).toBe(false);
      expect(existsSync(join(bare, '.superworker'))).toBe(false);
      expect(readdirSync(bare)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a line refused on its closed set leaves nothing either: the refusal happens before the lock, not inside it', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'superworker-ins-refusal-'));
    try {
      const refusal: unknown = await refusalIn(bare, ['add', '--scope', 'round', '--text', 'x']).catch(
        (error: unknown) => error,
      );
      expect((refusal as { code: number }).code).toBe(2);
      expect((refusal as Error).message).toContain('invalid scope "round"');
      expect(existsSync(join(bare, '.superworker'))).toBe(false);
      expect(readdirSync(bare)).toEqual([]);
      // A line the account does accept is the contrast: it takes the lock, so the directory appears
      // with the entry. Without this reading, the assertion above would pass on a plugin that simply
      // never wrote anything.
      await refusalIn(bare, ['add', '--scope', 'global', '--text', 'a sentence the account takes']);
      expect(existsSync(join(bare, '.superworker', 'instructions.json'))).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('the write verbs carry no init gate of their own', () => {
  it('add lands the account on a project whose `.superworker` was never init-ed (whether it counts as init-ed is `src/initledger.ts`\'s reading alone)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'superworker-ins-gate-'));
    try {
      const line = ['add', '--scope', 'global', '--text', 'lands without a plugin-level gate'];
      expect(String(await runIn(bare, line))).toContain('INSTRUCTION i-0001');
      expect(readFileSync(join(bare, '.superworker', 'instructions.json'), 'utf8')).toContain(
        'lands without a plugin-level gate',
      );
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

describe('the bytes a write lands: the record base\u2019s one writer, this record\u2019s construction order', () => {
  /**
   * A record base whose clock hands out these moments in order: the expected documents below carry
   * literal stamps, so the moment each write lands has to be the one the case chose.
   */
  function useFixedClock(moments: readonly string[]): void {
    const queue = [...moments];
    ctx = {
      ...ctx,
      base: {
        ...pluginBase(),
        nowSeconds: () => {
          const moment = queue.shift();
          if (moment === undefined) throw new Error('the fixed clock ran out of moments');
          return moment;
        },
      },
    };
  }

  /** The keys one `add` builds an entry with, in construction order — a sorting writer reorders them. */
  const ENTRY_KEYS = [
    'id', 'text', 'scope', 'target', 'state', 'cycle', 'node', 'said_by', 'at', 'resolved_at', 'note',
  ];

  /**
   * The two `add`s of the first case as the document they must leave: written out here in full, in
   * construction order, so the expectation is a fixed literal and not a re-parsing of the record the
   * case is about. A writer that sorted keys, changed the indent, wrote a trailing newline or spelled
   * the text's non-ASCII differently would not produce these bytes.
   */
  const TWO_ADDS = [
    '{',
    '  "instructions": [',
    '    {',
    '      "id": "i-0001",',
    '      "text": "先读这个节点的 spec，再动手",',
    '      "scope": "global",',
    '      "target": "stage",',
    '      "state": "live",',
    '      "cycle": null,',
    '      "node": null,',
    '      "said_by": "user",',
    '      "at": "2026-01-01T00:00:00Z",',
    '      "resolved_at": null,',
    '      "note": null',
    '    },',
    '    {',
    '      "id": "i-0002",',
    '      "text": "close only",',
    '      "scope": "global",',
    '      "target": "boundary",',
    '      "state": "live",',
    '      "cycle": null,',
    '      "node": null,',
    '      "said_by": "user",',
    '      "at": "2026-01-01T00:00:01Z",',
    '      "resolved_at": null,',
    '      "note": null',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  /**
   * The same document as a value, in construction order, for the comparison against the base's own
   * writer: `jsonBytes` of **this** object (never of the file the case is about) is what the byte
   * rule says the record must be, so a writer that sorts keys or re-spells the bytes goes red.
   */
  const TWO_ADDS_VALUE = {
    instructions: [
      {
        id: 'i-0001',
        text: '先读这个节点的 spec，再动手',
        scope: 'global',
        target: 'stage',
        state: 'live',
        cycle: null,
        node: null,
        said_by: 'user',
        at: '2026-01-01T00:00:00Z',
        resolved_at: null,
        note: null,
      },
      {
        id: 'i-0002',
        text: 'close only',
        scope: 'global',
        target: 'boundary',
        state: 'live',
        cycle: null,
        node: null,
        said_by: 'user',
        at: '2026-01-01T00:00:01Z',
        resolved_at: null,
        note: null,
      },
    ],
  };

  it('the account on disk is exactly the base\u2019s `jsonBytes` \u2014 two-space indent, non-ASCII as it is, keys in construction order, no trailing newline', async () => {
    // Two entries in the order that would scramble a sorting writer, with non-ASCII and multi-byte
    // cells in the middle of a sentence: whatever an entry's key set is, the bytes on disk are the
    // base's one spelling of this record, in the order the entry was built. `sortKeys` is left off
    // on purpose — the account is the one record whose writer keeps construction order.
    useFixedClock(['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z']);
    await add('先读这个节点的 spec，再动手');
    await out(['add', '--scope', 'global', '--target', 'boundary', '--text', 'close only']);

    const raw = readFileSync(join(root, '.superworker', 'instructions.json'));
    // Byte equality covers every cell of the rule at once: indentation, key order (construction, not
    // sorted), non-ASCII as it is, LF, and no trailing newline. The expectation is a fixed document:
    // it is not read back out of the file under test, so a sorting writer cannot satisfy it.
    expect(raw.toString('utf8')).toBe(TWO_ADDS);
    // And the same rule read the way `spec.md`'s criterion 1 spells it: the bytes are what the base's
    // own writer — with no key sort — spells for a hand-built construction-order value.
    expect(raw.equals(Buffer.from(jsonBytes(TWO_ADDS_VALUE)))).toBe(true);
    // The entry's own key sequence, spelled out: this is the cell a sorting writer scrambles, and the
    // assertion above would keep passing if the expectation had been parsed from the file itself.
    expect(Object.keys(entries()[0]!)).toEqual(ENTRY_KEYS);
    expect(Object.keys(entries()[1]!)).toEqual(ENTRY_KEYS);
    // And the top-level order is the file's own: the account table, then the tombstone table once a
    // removal has left one — never sorted into `instructions` / `removed` by a writer.
    expect(Object.keys(JSON.parse(raw.toString('utf8')) as Record<string, unknown>)).toEqual(['instructions']);
  });

  it('a read-modify-write lands through the same writer: the file keeps the base\u2019s bytes after a resolve and a removal', async () => {
    useFixedClock([
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:01Z',
      '2026-01-01T00:00:02Z',
    ]);
    await add('one sentence to keep');
    await out(['resolve', 'i-0001', '--state', 'withdrawn']);
    const file = join(root, '.superworker', 'instructions.json');
    // Both halves of the same fixed document: the expections below are literals, not a re-parse.
    const resolvedDocument = [
      '{',
      '  "instructions": [',
      '    {',
      '      "id": "i-0001",',
      '      "text": "one sentence to keep",',
      '      "scope": "global",',
      '      "target": "stage",',
      '      "state": "withdrawn",',
      '      "cycle": null,',
      '      "node": null,',
      '      "said_by": "user",',
      '      "at": "2026-01-01T00:00:00Z",',
      '      "resolved_at": "2026-01-01T00:00:01Z",',
      '      "note": null',
      '    }',
      '  ]',
      '}',
    ].join('\n');
    expect(readFileSync(file, 'utf8')).toBe(resolvedDocument);
    expect(readFileSync(file).equals(Buffer.from(jsonBytes({
      instructions: [
        {
          id: 'i-0001',
          text: 'one sentence to keep',
          scope: 'global',
          target: 'stage',
          state: 'withdrawn',
          cycle: null,
          node: null,
          said_by: 'user',
          at: '2026-01-01T00:00:00Z',
          resolved_at: '2026-01-01T00:00:01Z',
          note: null,
        },
      ],
    })))).toBe(true);

    await out(['rm', 'i-0001']);
    const removedDocument = [
      '{',
      '  "instructions": [],',
      '  "removed": [',
      '    {',
      '      "id": "i-0001",',
      '      "at": "2026-01-01T00:00:02Z"',
      '    }',
      '  ]',
      '}',
    ].join('\n');
    expect(readFileSync(file, 'utf8')).toBe(removedDocument);
    expect(readFileSync(file).equals(Buffer.from(jsonBytes({
      instructions: [],
      removed: [{ id: 'i-0001', at: '2026-01-01T00:00:02Z' }],
    })))).toBe(true);
    expect(Object.keys(readInstructionFile())).toEqual(['instructions', 'removed']);
  });
});

describe('a real linked worktree: one answer, one account', () => {
  it.skipIf(!SLOW)(
    'the worktree root as --project writes to the main tree, and the engine answers the same root',
    async () => {
      // The fixture is a real worktree, not a hand-written pointer: `git worktree add` lays down the
      // checkout this pipeline's parallel mode really produces — a `.git` *file* pointing into the main
      // tree's `.git/worktrees/<name>`, and no `.superworker/` of its own.
      const main = mkdtempSync(join(tmpdir(), 'superworker-ins-wt-main-'));
      const side = mkdtempSync(join(tmpdir(), 'superworker-ins-wt-side-'));
      const worktree = join(side, 'tree');
      try {
        await makeRepo(main);
        await git(main, 'worktree', 'add', worktree, '-b', 'side');
        expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
        expect(existsSync(join(worktree, '.superworker'))).toBe(false);

        await open(main).ledger.init();
        await runIn(main, ['add', '--scope', 'global', '--text', 'the main tree keeps the account']);

        // The rule the engine states, asked of the very root this case is about.
        expect(projectRootOf(worktree, worktree)).toBe(main);

        // A writing verb pointed at the worktree root lands on the main tree's account, and the worktree
        // keeps no record of its own — the accident this seam exists to prevent is the write that goes
        // into the worktree snapshot where nobody sees it.
        const throughWorktree = ['resolve', 'i-0001', '--state', 'withdrawn', '--project', worktree];
        expect(String(await runIn(root, throughWorktree))).toBe('INSTRUCTION i-0001 → withdrawn');
        expect(readFileSync(join(main, '.superworker', 'instructions.json'), 'utf8')).toContain('"state": "withdrawn"');
        expect(existsSync(join(worktree, '.superworker', 'instructions.json'))).toBe(false);

        // Both spellings of the same root read the same account: the word's own read and the engine's answer.
        expect(await idsOf(['list', '--json', '--all', '--project', worktree])).toEqual(['i-0001']);
        expect(await idsOf(['list', '--json', '--all', '--project', projectRootOf(worktree, worktree)]))
          .toEqual(['i-0001']);
      } finally {
        rmSync(main, { recursive: true, force: true });
        rmSync(side, { recursive: true, force: true });
      }
    },
    20000,
  );

  it.skipIf(!SLOW)(
    'the production assembly carries that answer: conductor.pluginCommand writes to the main tree when --project names the worktree',
    async () => {
      // The case above hands the plugin a context the case built itself, so its `projectRootOf` cell is
      // the case's own reading of the rule. This one goes the way a person does: the shipped plugin
      // folder is installed into a project, and the line is routed through `conductor.pluginCommand` —
      // i.e. through the real assembly (`createContext`) that fills that cell in. What it pins is the
      // cell's *wiring*, which no hand-built context can observe: a local rule spelled into the assembly
      // answers a linked worktree root as itself and every hand-built-context assertion above still
      // passes, while `--project <worktree>` goes back to writing into the worktree snapshot.
      const main = mkdtempSync(join(tmpdir(), 'superworker-ins-prod-main-'));
      const side = mkdtempSync(join(tmpdir(), 'superworker-ins-prod-side-'));
      const worktree = join(side, 'tree');
      try {
        await makeRepo(main);
        await git(main, 'worktree', 'add', worktree, '-b', 'side');
        expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
        expect(existsSync(join(worktree, '.superworker'))).toBe(false);

        // The shipped folder as a project would have it: `open(root)` scans `<root>/plugins`.
        mkdirSync(join(main, 'plugins'), { recursive: true });
        cpSync(fileURLToPath(new URL('../plugins/instruction', import.meta.url)), join(main, 'plugins', 'instruction'), {
          recursive: true,
        });

        const superworker = open(main);
        await superworker.ledger.init();
        const added = await superworker.conductor.pluginCommand({
          word: 'instruction',
          argv: ['add', '--scope', 'global', '--text', 'the main tree keeps the account'],
        });
        expect(added.error).toBeNull();
        expect(added.ran).toBe(true);

        const written = await superworker.conductor.pluginCommand({
          word: 'instruction',
          argv: ['resolve', 'i-0001', '--state', 'withdrawn', '--project', worktree],
        });
        expect(written.error).toBeNull();
        expect(written.ran).toBe(true);
        // The write landed on the main tree's account, and the worktree kept no account of its own.
        expect(readFileSync(join(main, '.superworker', 'instructions.json'), 'utf8')).toContain('"state": "withdrawn"');
        expect(existsSync(join(worktree, '.superworker', 'instructions.json'))).toBe(false);

        const listed = await superworker.conductor.pluginCommand({
          word: 'instruction',
          argv: ['list', '--json', '--all', '--project', worktree],
        });
        expect((JSON.parse(String(listed.text)) as InstructionRecord[]).map((row) => row.id)).toEqual(['i-0001']);
      } finally {
        rmSync(main, { recursive: true, force: true });
        rmSync(side, { recursive: true, force: true });
      }
    },
    30000,
  );
});