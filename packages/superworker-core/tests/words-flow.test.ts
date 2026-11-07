import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { answer } from '../src/words/router';
import type { WordsIO } from '../src/words/types';

/**
 * The flow's words, at the words layer: one operation each, and the standard order spelled out.
 *
 * `plan` reads a byte and writes none; `settle` records one node's end and nothing else; `hold`
 * claims; `dispatch` lands the cell's material (when the claim left none) and opens the session. The
 * composed `advance` is those three moves in one word, and it lands the same marks on disk.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { root: string; io: WordsIO; executor: SimulatedExecutor } {
  const root = mkdtempSync(join(tmpdir(), 'superworker-words-flow-'));
  dirs.push(root);
  const executor = new SimulatedExecutor();
  const io: WordsIO = { root, homeDir: join(root, '_home'), executor, openerAvailable: true };
  return { root, io, executor };
}

async function call(io: WordsIO, argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  const result = await answer(argv, io);
  expect(result.code, `${argv.join(' ')} answered ${result.code}: ${result.stderr}`).toBe(0);
  return { code: result.code, stdout: result.stdout };
}

/** A line holding one of two ready nodes, with the layout in place; the held node's id comes back. */
async function station(io: WordsIO): Promise<string> {
  await call(io, ['init']);
  await call(io, ['dag', 'add', 'the first node']);
  await call(io, ['dag', 'add', 'the second node']);
  await call(io, ['cycle', 'start', 'c1', '--force', '--tags', 'coding']);
  return JSON.parse(readFileSync(join(io.root, '.superworker', 'state.json'), 'utf8'))
    .cycles.find((cycle: { id: string }) => cycle.id === 'c1').holding[0].id as string;
}

function state(io: WordsIO) {
  return JSON.parse(readFileSync(join(io.root, '.superworker', 'state.json'), 'utf8'))
    .cycles.find((cycle: { id: string }) => cycle.id === 'c1');
}

/** The ids on the graph, in on-disk order. */
function graphIds(io: WordsIO): string[] {
  return Object.keys(JSON.parse(readFileSync(join(io.root, '.superworker', 'ideas.json'), 'utf8')).nodes);
}

describe('hold: the claim step, a verb of its own', () => {
  it('claims a batch in one write, keeps the hand in order, and repeats an id without writing it twice', async () => {
    const { io } = project();
    await call(io, ['init']);
    for (const title of ['a', 'b', 'c']) await call(io, ['dag', 'add', title]);
    const [a, b, c] = graphIds(io);
    await call(io, ['cycle', 'create', 'c1', '--force', '--tags', 'coding']);
    const batch = await call(io, ['hold', a!, b!, '--cycle', 'c1']);
    expect(batch.stdout).toContain(`CURRENT_NODE: c1 → ${a}`);
    expect(batch.stdout).toContain(`HOLDING   : c1 → ${b}`);
    expect(state(io).holding.map((item: { id: string }) => item.id)).toEqual([a, b]);
    await call(io, ['hold', a!, '--cycle', 'c1']);
    expect(state(io).holding.map((item: { id: string }) => item.id)).toEqual([a, b]);
  });

  it('refuses the whole batch when another line holds one of its nodes, writing nothing', async () => {
    const { io } = project();
    await call(io, ['init']);
    for (const title of ['a', 'b']) await call(io, ['dag', 'add', title]);
    const [a, b] = graphIds(io);
    await call(io, ['cycle', 'create', 'c1', '--force', '--tags', 'coding']);
    await call(io, ['cycle', 'create', 'c2', '--force', '--tags', 'coding']);
    await call(io, ['hold', a!, '--cycle', 'c1']);
    const refused = await answer(['hold', a!, b!, '--cycle', 'c2'], io);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('already held by cycle "c1"');
    const c2 = JSON.parse(readFileSync(join(io.root, '.superworker', 'state.json'), 'utf8'))
      .cycles.find((cycle: { id: string }) => cycle.id === 'c2');
    expect(c2.holding).toEqual([]);
  });

  it('takes the single active line without --cycle, and names the missing line when there is none', async () => {
    const { io } = project();
    await call(io, ['init']);
    await call(io, ['dag', 'add', 'solo']);
    const [only] = graphIds(io);
    const noLine = await answer(['hold', only!], io);
    expect(noLine.code).toBe(2);
    expect(noLine.stderr).toContain('no cycle is active');
    await call(io, ['cycle', 'start', 'c1', '--force', '--tags', 'coding']);
    await call(io, ['hold', only!]);
    expect(state(io).holding.map((item: { id: string }) => item.id)).toEqual([only]);
  });
});

describe('plan: the reading word', () => {
  it('answers where the line goes and writes not one byte', async () => {
    const { root, io } = project();
    const node = await station(io);
    const before = readFileSync(join(root, '.superworker', 'state.json'));
    const plan = await call(io, ['plan', '--cycle', 'c1', '--json']);
    expect(JSON.parse(plan.stdout).action).toBe('dispatch');
    expect(JSON.parse(plan.stdout).node_id).toBe(node);
    expect(readFileSync(join(root, '.superworker', 'state.json')).equals(before)).toBe(true);
  });
});

describe('settle: the closing word, and nothing past it', () => {
  it('records the end, claims nothing and opens nothing; the plan asks for the next claim', async () => {
    const { root, io } = project();
    const node = await station(io);
    await call(io, ['handoff', 'c1', node, 'completed', '-s', 'done']);
    const receipt = JSON.parse((await call(io, ['settle', node, '--cycle', 'c1', '--json'])).stdout);
    expect(receipt.action).toBe('settle');
    expect(receipt.plan.action).toBe('open_node');
    const line = state(io);
    expect(line.path.map((step: { node: string }) => step.node)).toEqual([node]);
    expect(line.holding).toEqual([]);
    expect(existsSync(join(root, '.superworker', 'meta', 'launch', 'c1'))).toBe(false);
  });
});

describe('the standard flow: plan, hold, dispatch', () => {
  it('claims the pick, lands its material and opens its session', async () => {
    const { root, io, executor } = project();
    const node = await station(io);
    await call(io, ['handoff', 'c1', node, 'completed', '-s', 'done']);
    await call(io, ['settle', node, '--cycle', 'c1']);
    const plan = JSON.parse((await call(io, ['plan', '--cycle', 'c1', '--json'])).stdout);
    expect(plan.action).toBe('open_node');
    await call(io, ['hold', plan.node_id, '--cycle', 'c1']);
    expect(state(io).holding.map((item: { id: string }) => item.id)).toEqual([plan.node_id]);
    // The claim wrote the hand only: the material has not landed yet.
    expect(existsSync(join(root, '.superworker', 'meta', 'launch', 'c1', plan.node_id, 'prompt.txt'))).toBe(false);
    await call(io, ['dispatch', 'c1']);
    const launch = join(root, '.superworker', 'meta', 'launch', 'c1', plan.node_id);
    expect(existsSync(join(launch, 'prompt.txt'))).toBe(true);
    expect(existsSync(join(launch, 'started'))).toBe(true);
    expect(executor.dispatched.map((request) => request.node)).toEqual([plan.node_id]);
  });
});

describe('advance: the composed word', () => {
  it('claims the free slot, lands the material and opens the session, with the same marks as the three words', async () => {
    const { root, io, executor } = project();
    const node = await station(io);
    await call(io, ['handoff', 'c1', node, 'completed', '-s', 'done']);
    await call(io, ['settle', node, '--cycle', 'c1']);
    const receipt = JSON.parse((await call(io, ['advance', '--cycle', 'c1', '--json'])).stdout);
    expect(receipt.action).toBe('advance');
    expect(receipt.pinned).toHaveLength(1);
    const claimed = receipt.pinned[0];
    expect(executor.dispatched.map((request) => request.node)).toEqual([claimed]);
    const launch = join(root, '.superworker', 'meta', 'launch', 'c1', claimed);
    expect(existsSync(join(launch, 'prompt.txt'))).toBe(true);
    expect(existsSync(join(launch, 'started'))).toBe(true);
    expect(state(io).holding.map((item: { id: string }) => item.id)).toEqual([claimed]);
  });
});

describe('a process without an opener', () => {
  it('dispatch writes nothing and names the panel; advance pins but claims no session', async () => {
    const { root, io } = project();
    const node = await station(io);
    const closed: WordsIO = { ...io, openerAvailable: false };
    const refused = await answer(['dispatch', 'c1'], closed);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('Superworker Center');
    expect(existsSync(join(root, '.superworker', 'meta', 'launch', 'c1', node, 'prompt.txt'))).toBe(false);

    await call(closed, ['handoff', 'c1', node, 'completed', '-s', 'done']);
    await call(closed, ['settle', node, '--cycle', 'c1']);
    const advanced = await call(closed, ['advance', '--cycle', 'c1', '--json']);
    const receipt = JSON.parse(advanced.stdout);
    expect(receipt.spawn_error).toBeTruthy();
    expect(receipt.spawned).toEqual([]);
    expect(receipt.pinned).toHaveLength(1);
    expect(existsSync(join(root, '.superworker', 'meta', 'launch', 'c1', receipt.pinned[0], 'started'))).toBe(false);
  });
});

describe('a record that cannot be read: every word answers its own tier', () => {
  it('plan, settle and advance refuse with 2 and dispatch with 3, writing not one byte', async () => {
    const { root, io } = project();
    await call(io, ['init']);
    const broken = '{ this record does not parse';
    writeFileSync(join(root, '.superworker', 'state.json'), broken);
    const plan = await answer(['plan', '--cycle', 'c1'], io);
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('parse failure');
    const settle = await answer(['settle', 'nosuch', '--cycle', 'c1'], io);
    expect(settle.code).toBe(2);
    const advance = await answer(['advance', '--cycle', 'c1'], io);
    expect(advance.code).toBe(2);
    const dispatch = await answer(['dispatch', 'c1'], io);
    expect(dispatch.code).toBe(3);
    // One corrupted record, four answers, and not one byte of it rewritten by any of the words.
    expect(readFileSync(join(root, '.superworker', 'state.json'), 'utf8')).toBe(broken);
  });
});

describe('dag update: the word that names no change', () => {
  it('answers the refusal code with its own sentence on stderr, and writes not one byte', async () => {
    const { root, io } = project();
    await call(io, ['init']);
    await call(io, ['dag', 'add', 'the first node']);
    const [id] = graphIds(io);
    const before = readFileSync(join(root, '.superworker', 'ideas.json'), 'utf8');
    // No flag at all: a line this word cannot take. It is a refusal, never a success code carrying
    // an error sentence (the shape this word used to answer with).
    const refused = await answer(['dag', 'update', id!], io);
    expect(refused.stdout).toBe('');
    expect(refused.code).toBe(2);
    expect(refused.stderr.startsWith('Error: No changes:')).toBe(true);
    expect(readFileSync(join(root, '.superworker', 'ideas.json'), 'utf8')).toBe(before);
  });
});

describe('the engine and the words agree', () => {
  it('the claim the words write is the claim the engine reads', async () => {
    const { root, io } = project();
    const node = await station(io);
    await call(io, ['handoff', 'c1', node, 'completed', '-s', 'done']);
    await call(io, ['settle', node, '--cycle', 'c1']);
    const plan = JSON.parse((await call(io, ['plan', '--cycle', 'c1', '--json'])).stdout);
    await call(io, ['hold', plan.node_id, '--cycle', 'c1']);
    await call(io, ['dispatch', 'c1']);
    const line = await open(root).ledger.cycles.show('c1');
    expect(line.holding.map((item) => item.id)).toEqual([plan.node_id]);
    expect((await open(root).conductor.next({ cycle: 'c1' })).action).not.toBe('open_node');
  });
});