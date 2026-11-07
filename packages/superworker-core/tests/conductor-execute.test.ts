import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { warningsOf } from '../src/conductor';
import type { DispatchReceipt } from '../src/conductor';
import { isRecordError } from '../src/errors';
import { SimulatedExecutor } from '../src/executor';
import { open } from '../src/open';
import { makeLab, type PluginLab } from './helpers/plugin-lab';

/**
 * The dispatch-and-close loop the way the engine really runs it: dispatch opens a session and comes
 * back with a receipt (prepare → hand the node to the executor → the claim `started` lands) — the
 * node's result is not in it. The result arrives later, from the worker, as a ticket this test files
 * through `conductor.handoff`; `close` settles that ticket (the result enters path, the hold is
 * released, the node takes one of its three states, the line stops or refills a slot).
 *
 * The cells here: all three verdict words end to end (completed / failed / stopped; `pending` is the
 * blocker a rerun leaves behind), the traces of a retry and of a resume from a breakpoint,
 * transactionality (records agree after an injected failure), the claim rule (`already_open` is not
 * an executor call, a claim that cannot be written throws instead of passing for success), and
 * warnings read back out (warningsOf). The whole stage sits in a temp project root; the engine
 * starts no process and touches no network.
 */

const roots: string[] = [];

function freshLab(prefix: string): PluginLab {
  const lab = makeLab(prefix);
  roots.push(lab.root);
  return lab;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A line with a successor: A is depended on by B — once A is delivered B becomes ready and close refills the slot. */
async function stageTwoNodeLine(lab: PluginLab): Promise<{ a: string; b: string }> {
  await lab.superworker.ledger.init();
  const a = (await lab.superworker.ledger.dag.add({ title: 'first slot' })).id;
  const b = (await lab.superworker.ledger.dag.add({ title: 'second slot', depends_on: [a] })).id;
  lab.cycle('c1', [a]);
  return { a, b };
}

/** One server-side line with a single node in hand. */
async function stageOneNodeLine(lab: PluginLab, title = 'the only slot'): Promise<string> {
  await lab.superworker.ledger.init();
  const id = (await lab.superworker.ledger.dag.add({ title })).id;
  lab.cycle('c1', [id]);
  return id;
}

/**
 * Every file under `.superworker`, keyed by relative path, with its bytes and its modification time: a call
 * that writes nothing has to leave this exactly as it was. The dispatch papers live under
 * `.superworker/meta/`, which is why a plain hash of the records would not be enough here.
 */
function treeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, 'dir');
        walk(full, rel);
      } else {
        out.set(rel, `${statSync(full).mtimeMs}|${readFileSync(full, 'utf8')}`);
      }
    }
  };
  walk(join(root, '.superworker'), '');
  return out;
}

/** The claim marker of one cell: `<record>/meta/launch/<line>/<node>/started`. */
function markerOf(root: string, cycle: string, node: string): string {
  return join(root, '.superworker', 'meta', 'launch', cycle, node, 'started');
}

/** The prompt of one cell: `<record>/meta/launch/<line>/<node>/prompt.txt`. */
function promptOf(root: string, cycle: string, node: string): string {
  return join(root, '.superworker', 'meta', 'launch', cycle, node, 'prompt.txt');
}

describe('the loop: a completed ticket end to end (the slot is refilled and the line keeps going)', () => {
  it('dispatch → the test files the ticket → close: the result enters path, the hold passes to the successor, the line stays in service', async () => {
    const lab = freshLab('superworker-execute-');
    const { a, b } = await stageTwoNodeLine(lab);
    const sim = new SimulatedExecutor();
    const superworker = open(lab.root, { executor: sim });

    // The dispatch: the receipt says a session is open, not how the work went.
    const receipt = await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(receipt).toEqual({
      action: 'opened',
      cycle: 'c1',
      node_id: a,
      node_title: 'first slot',
      prompt: promptOf(lab.root, 'c1', a),
      prompt_text: `/sw-conduct ${a} [pipeline]\n`,
      session: { sessionId: 'sess-1' },
    });
    // The request carries the real prompt and the role; the prepared material and the claim are on disk,
    // while state.json and ideas.json are not touched by a byte.
    expect(sim.dispatched).toEqual([
      { cycle: 'c1', node: a, role: 'execute', prompt: `/sw-conduct ${a} [pipeline]\n` },
    ]);
    expect(readFileSync(promptOf(lab.root, 'c1', a), 'utf8').replace(/\r\n/g, '\n'))
      .toBe(`/sw-conduct ${a} [pipeline]\n`);
    expect(existsSync(join(lab.root, '.superworker', 'nodes', a, 'run.md'))).toBe(true);
    expect(existsSync(markerOf(lab.root, 'c1', a))).toBe(true);
    // The result is not in the receipt and not on disk either: nothing is settled, no ticket exists.
    expect(existsSync(join(lab.root, '.superworker', 'signals', 'c1', `${a}.json`))).toBe(false);
    expect((await superworker.ledger.dag.get(a))!.status).toBe('todo');

    // The worker's result arrives as a ticket: six keys, a fixed shape; a second ticket for the same cell replaces the whole file.
    const ticket = await superworker.conductor.handoff({
      cycle: 'c1',
      node: a,
      status: 'completed',
      summary: 'the slot is done',
      outputs: { deliverable: '.superworker/nodes/x/sw-conduct.md' },
    });
    expect(Object.keys(ticket)).toEqual(['cycle', 'node', 'status', 'summary', 'outputs', 'timestamp']);
    expect(readFileSync(join(lab.root, '.superworker', 'signals', 'c1', `${a}.json`), 'utf8')).toContain('the slot is done');

    // Settling the line: path records completed, the hold is released, the node lands on completed, and the freed slot is refilled with B.
    const settled = await superworker.conductor.close({ cycle: 'c1', node: a });
    expect(settled.holding.map((item) => item.id)).toEqual([b]);
    expect(settled.path).toHaveLength(1);
    expect(settled.path[0]).toMatchObject({ node: a, result: 'completed' });
    expect(settled.status).toBe('active');
    const nodeA = await superworker.ledger.dag.get(a);
    expect(nodeA!.status).toBe('completed');
    expect(typeof nodeA!.completed_at).toBe('string');
    // The loop closes: the next slot is in hand and no session has opened, so the plan answers that it should be dispatched.
    const plan = await superworker.conductor.next({ cycle: 'c1' });
    expect(plan.action).toBe('dispatch');
    if (plan.action === 'dispatch') expect(plan.node_id).toBe(b);
  });
});

describe('the loop: failed / stopped tickets end to end (shelved, and the line stops until a person comes)', () => {
  it.each(['failed', 'stopped'] as const)('%s: path records the result, the node lands on shelved, and the line turns inactive', async (status) => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'slips');
    const superworker = open(lab.root, { executor: new SimulatedExecutor() });

    expect((await superworker.conductor.dispatch({ cycle: 'c1' })).action).toBe('opened');
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status, summary: 'handed over nothing', outputs: {} });
    const settled = await superworker.conductor.close({ cycle: 'c1' });
    expect(settled.path[0]).toMatchObject({ node: a, result: status });
    expect(settled.holding).toEqual([]);
    expect(settled.status).toBe('inactive');
    expect((await superworker.ledger.dag.get(a))!.status).toBe('shelved');
    expect((await superworker.ledger.dag.get(a))!.completed_at).toBeUndefined();
  });

  it('when_shelved=continue: the slot is refilled even with nothing delivered, and the line keeps going (the node stays shelved)', async () => {
    const lab = freshLab('superworker-execute-');
    await lab.superworker.ledger.init();
    // The successor does not depend on the failed slot: a not being delivered does not keep b from being ready, so the line's continue policy can refill it.
    const a = (await lab.superworker.ledger.dag.add({ title: 'slips' })).id;
    const b = (await lab.superworker.ledger.dag.add({ title: 'independent next' })).id;
    lab.cycle('c1', [a]);
    await lab.superworker.ledger.cycles.setPolicy('c1', 'when_shelved', 'continue');
    const superworker = open(lab.root, { executor: new SimulatedExecutor() });
    await superworker.conductor.dispatch({ cycle: 'c1' });
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'failed', summary: 'nothing', outputs: {} });
    const settled = await superworker.conductor.close({ cycle: 'c1' });
    expect(settled.status).toBe('active');
    expect(settled.holding.map((item) => item.id)).toEqual([b]);
    expect((await superworker.ledger.dag.get(a))!.status).toBe('shelved');
    expect((await superworker.ledger.dag.get(b))!.status).toBe('todo');
  });
});

describe('blockers and reruns: pending counts as a blocker, and the traces a rerun leaves', () => {
  it('a pending left by a rerun: close refuses it (nothing_to_settle) and not a byte moves; the plan answers wait', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'retry me');
    const superworker = open(lab.root, { executor: new SimulatedExecutor() });
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'failed', summary: 'first run', outputs: {} });
    const stateBefore = readFileSync(join(lab.root, '.superworker', 'state.json'));

    // Rerun: the old ticket is taken away and pending is written over it (the line book is untouched); pending is a blocker.
    await superworker.ledger.cycles.retry('c1', a);
    expect(readFileSync(join(lab.root, '.superworker', 'state.json'))).toEqual(stateBefore);
    const signal = JSON.parse(readFileSync(join(lab.root, '.superworker', 'signals', 'c1', `${a}.json`), 'utf8')) as { status: string };
    expect(signal.status).toBe('pending');

    let caught: unknown;
    try {
      await superworker.conductor.close({ cycle: 'c1' });
    } catch (error) {
      caught = error;
    }
    expect(isRecordError(caught, 'nothing_to_settle')).toBe(true);
    expect(readFileSync(join(lab.root, '.superworker', 'state.json'))).toEqual(stateBefore);

    const plan = await superworker.conductor.next({ cycle: 'c1' });
    expect(plan.action).toBe('wait');
    // A dispatch does not pass a blocker either: the plan does not answer dispatch, and preparation refuses on the spot.
    await expect(superworker.conductor.dispatch({ cycle: 'c1' })).rejects.toThrow(/wait/);
  });

  it('no ticket yet (a breakpoint): close refuses; with the ticket down but the line unsettled (the trace of a resume) the plan points at the settle command', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'in flight');
    const superworker = open(lab.root, { executor: new SimulatedExecutor() });

    await superworker.conductor.dispatch({ cycle: 'c1' });
    // The session is out and no ticket is in: the plan waits for a ticket (sessionsWait), and close has nothing to settle.
    const planWhileFlying = await superworker.conductor.next({ cycle: 'c1' });
    expect(planWhileFlying.action).toBe('wait');
    await expect(superworker.conductor.close({ cycle: 'c1' })).rejects.toThrow(/nothing to settle/i);

    // The ticket is down and the line is not settled: the plan spells that steady state out, with close_with pointing at the settle command.
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'completed', summary: 'done', outputs: {} });
    const planTicketed = await superworker.conductor.next({ cycle: 'c1' });
    expect(planTicketed.action).toBe('wait');
    if (planTicketed.action === 'wait') {
      expect(planTicketed.close_with).toBe(`settle ${a}`);
    }
    const settled = await superworker.conductor.close({ cycle: 'c1' });
    expect(settled.path[0]).toMatchObject({ node: a, result: 'completed' });
  });

  it('the whole chain of a retry: revive → retry (a pending mark) → hold → blocker → a second ticket → path keeps two steps', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'redone slot');
    const superworker = open(lab.root, { executor: new SimulatedExecutor() });

    await superworker.conductor.dispatch({ cycle: 'c1' });
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'failed', summary: 'first run produced nothing', outputs: {} });
    await superworker.conductor.close({ cycle: 'c1' });
    expect((await superworker.ledger.dag.get(a))!.status).toBe('shelved');

    // Rerun: the node goes back to todo, the ticket becomes the pending rerun mark, and the hold is taken up again.
    await superworker.ledger.dag.revive(a);
    await superworker.ledger.cycles.retry('c1', a);
    await superworker.ledger.cycles.hold('c1', a);

    // pending is a blocker: the line cannot be settled; the second ticket is legal (it replaces the whole file) and settling records the second step.
    await expect(superworker.conductor.close({ cycle: 'c1' })).rejects.toThrow(/nothing to settle/i);
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'completed', summary: 'the redo delivered', outputs: {} });
    const settled = await superworker.conductor.close({ cycle: 'c1' });
    // A rerun on a stopped line only records: path keeps two results, and the line's state does not move unless a person moves it.
    expect(settled.path.map((step) => step.result)).toEqual(['failed', 'completed']);
    expect(settled.status).toBe('inactive');
    expect((await superworker.ledger.dag.get(a))!.status).toBe('completed');
  });
});

describe('the claim: one session per cell, and a claim that cannot be written never passes for success', () => {
  it('already_open: the second dispatch of the same cell calls no executor and writes not a byte', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'first slot');
    const sim = new SimulatedExecutor();
    const superworker = open(lab.root, { executor: sim });

    const first = await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(first.action).toBe('opened');
    expect(first.session).toEqual({ sessionId: 'sess-1' });
    const before = treeSnapshot(lab.root);

    // The claim is on disk, so this cell is in flight already: the answer says so, and nothing else happens.
    const second = await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(second).toEqual({
      action: 'already_open',
      cycle: 'c1',
      node_id: a,
      node_title: 'first slot',
      prompt: promptOf(lab.root, 'c1', a),
      prompt_text: `/sw-conduct ${a} [pipeline]\n`,
    });
    expect(second.session).toBeUndefined();
    // No second session was opened, and the papers (prompt, claim) are where they were.
    expect(sim.dispatched).toHaveLength(1);
    expect(treeSnapshot(lab.root)).toEqual(before);
  });

  it('a claim that cannot be written throws, names the session id, and says a redispatch would open a second session', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'stamp blocked');
    const sim = new SimulatedExecutor(() => {
      // The injection lands exactly in the real timing seam: dispatch preparation has passed (it lets
      // the call through only with the claim absent), the request has gone to the executor, and the
      // claim is not written yet. At the instant the executor answers, the claim's landing spot is
      // occupied by a directory, so the atomic write cannot land on it (rename must blow up).
      mkdirSync(markerOf(lab.root, 'c1', a), { recursive: true });
      return 'open';
    });
    const superworker = open(lab.root, { executor: sim });

    let caught: unknown;
    try {
      await superworker.conductor.dispatch({ cycle: 'c1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The session really opened: the message carries its id, says the claim is missing, and says plainly what a redispatch would do.
    expect(message).toContain('sess-1');
    expect(message).toContain('started');
    expect(message).toContain('claim');
    expect(message).toContain('second session');
    // The success path was not taken: the receipt never came back.
    expect(sim.dispatched).toEqual([
      { cycle: 'c1', node: a, role: 'execute', prompt: `/sw-conduct ${a} [pipeline]\n` },
    ]);
  });

  it('a never-settling executor cannot block already_open: the second call returns without waiting', async () => {
    const lab = freshLab('superworker-execute-');
    await stageOneNodeLine(lab, 'still running');
    // The session of an earlier dispatch is out: its claim is on disk, and the executor that opened it
    // is gone (a process that went away, a promise that never settles — the engine cannot tell).
    const opener = open(lab.root, { executor: new SimulatedExecutor() });
    expect((await opener.conductor.dispatch({ cycle: 'c1' })).action).toBe('opened');

    const hanging = new SimulatedExecutor('hang');
    const superworker = open(lab.root, { executor: hanging });
    // The bound is a failure sentinel, not a poll: the expected answer is a resolved promise, so there
    // is no event to hang on — if the hanging executor were consulted, this call would never settle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<'blocked'>((resolve) => {
      timer = setTimeout(() => resolve('blocked'), 500);
    });
    try {
      const answer = await Promise.race([superworker.conductor.dispatch({ cycle: 'c1' }), guard]);
      expect(answer).not.toBe('blocked');
      expect((answer as DispatchReceipt).action).toBe('already_open');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // The hanging executor was never consulted: an open session is read off the claim, not off the executor.
    expect(hanging.dispatched).toEqual([]);
  });
});

describe('the two gates and naming', () => {
  it('close naming a node the line does not hold: not_holding, and nothing moved', async () => {
    const lab = freshLab('superworker-execute-');
    await lab.superworker.ledger.init();
    const a = (await lab.superworker.ledger.dag.add({ title: 'held' })).id;
    const stranger = (await lab.superworker.ledger.dag.add({ title: 'not held' })).id;
    lab.cycle('c1', [a]);
    const superworker = open(lab.root);
    const stateBefore = readFileSync(join(lab.root, '.superworker', 'state.json'));
    let caught: unknown;
    try {
      await superworker.conductor.close({ cycle: 'c1', node: stranger });
    } catch (error) {
      caught = error;
    }
    expect(isRecordError(caught, 'not_holding')).toBe(true);
    expect(readFileSync(join(lab.root, '.superworker', 'state.json'))).toEqual(stateBefore);
  });

  it('handoff naming a node the line does not hold: not_holding, and no ticket is written', async () => {
    const lab = freshLab('superworker-execute-');
    await lab.superworker.ledger.init();
    const a = (await lab.superworker.ledger.dag.add({ title: 'held' })).id;
    const stranger = (await lab.superworker.ledger.dag.add({ title: 'elsewhere' })).id;
    lab.cycle('c1', [a]);
    const superworker = open(lab.root);
    let caught: unknown;
    try {
      await superworker.conductor.handoff({ cycle: 'c1', node: stranger, status: 'completed', summary: 'x', outputs: {} });
    } catch (error) {
      caught = error;
    }
    expect(isRecordError(caught, 'not_holding')).toBe(true);
    expect(existsSync(join(lab.root, '.superworker', 'signals', 'c1', `${stranger}.json`))).toBe(false);
  });

  it('handoff does not take pending: the verdict vocabulary has three words, and pending is the mark a rerun verb leaves', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'held');
    const superworker = open(lab.root);
    await expect(
      superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'pending' as never, summary: 'x', outputs: {} }),
    ).rejects.toThrow(/status must be one of/);
  });

  it('a line not in service: close only records (path and the graph settle, and the line state does not move unless a person moves it)', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'on a parked line');
    const superworker = open(lab.root);
    await superworker.ledger.cycles.setStatus('c1', 'inactive');
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'completed', summary: 'done', outputs: {} });
    const settled = await superworker.conductor.close({ cycle: 'c1', node: a });
    expect(settled.status).toBe('inactive');
    expect(settled.holding).toEqual([]);
    expect((await superworker.ledger.dag.get(a))!.status).toBe('completed');
  });
});

describe('transactionality: records agree after an injected failure', () => {
  it('the executor throws: no session opens, no claim lands and no record moves (the prepared material is still there, so the same cell can be dispatched again)', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'doomed slot');
    const sim = new SimulatedExecutor('throw');
    const superworker = open(lab.root, { executor: sim });
    const stateBefore = readFileSync(join(lab.root, '.superworker', 'state.json'));
    const ideasBefore = readFileSync(join(lab.root, '.superworker', 'ideas.json'));
    await expect(superworker.conductor.dispatch({ cycle: 'c1' })).rejects.toThrow('opened no session');
    expect(readFileSync(join(lab.root, '.superworker', 'state.json'))).toEqual(stateBefore);
    expect(readFileSync(join(lab.root, '.superworker', 'ideas.json'))).toEqual(ideasBefore);
    expect(existsSync(markerOf(lab.root, 'c1', a))).toBe(false);
    // The prepared material (the prompt) is already down: exactly what a person needs to dispatch the same cell again.
    expect(existsSync(promptOf(lab.root, 'c1', a))).toBe(true);
  });

  // The injection leans on the Windows read-only attribute: there a read-only target stops the atomic
  // write (it lands by rename). On a POSIX host rename only asks the directory for permission, so a
  // read-only ideas.json does not stop the write, and a read-only directory stops the state write
  // first — the failure this case needs cannot be placed between the two writes. The transaction it
  // pins is platform-neutral; the lever is not.
  it.skipIf(process.platform !== 'win32')('a failure in the middle of settling: the snapshot is put back and state.json keeps no half record', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'half-settle');
    const superworker = open(lab.root);
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'completed', summary: 'done', outputs: {} });
    const stateBefore = readFileSync(join(lab.root, '.superworker', 'state.json'));
    const ideasBefore = readFileSync(join(lab.root, '.superworker', 'ideas.json'));
    // The graph-marking step cannot write (ideas.json is read-only): the step is recorded and marking blows up — close rolls back as a whole.
    const ideasPath = join(lab.root, '.superworker', 'ideas.json');
    chmodSync(ideasPath, 0o444);
    try {
      await expect(superworker.conductor.close({ cycle: 'c1' })).rejects.toThrow();
      expect(readFileSync(join(lab.root, '.superworker', 'state.json'))).toEqual(stateBefore);
      expect(readFileSync(ideasPath)).toEqual(ideasBefore);
    } finally {
      chmodSync(ideasPath, 0o666);
    }
    // Settle it as usual once the permission is back: the transaction put the records where they were, so this slot settles as before.
    const settled = await superworker.conductor.close({ cycle: 'c1' });
    expect(settled.path[0]).toMatchObject({ node: a, result: 'completed' });
  });
});

describe('reading warnings out: warningsOf reads the WARNING attached to the returned value', () => {
  it('settling: a broken plugin folds into a warning and the main path carries on (settling and the good plugins still do their work)', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'held');
    lab.plugin('thrower', {
      name: 'thrower',
      summary: 'a close plugin that always fails',
      timing: 'close',
      action: 'insert',
    }, {
      'impl.mjs': 'export function offer() { throw new Error("boom"); }\n',
    });
    const superworker = open(lab.root);
    await superworker.conductor.handoff({ cycle: 'c1', node: a, status: 'completed', summary: 'done', outputs: {} });
    const settled = await superworker.conductor.close({ cycle: 'c1' });
    expect(settled.path[0]).toMatchObject({ node: a, result: 'completed' });
    const warnings = warningsOf(settled);
    expect(warnings.join('\n')).toContain('WARNING: plugin thrower failed');
    expect(warnings.join('\n')).toContain('boom');
  });

  it('dispatch: a broken gate on a green path folds into a warning and the receipt comes back as usual', async () => {
    const lab = freshLab('superworker-execute-');
    const a = await stageOneNodeLine(lab, 'held');
    lab.plugin('doorless', {
      name: 'doorless',
      summary: 'declares a dispatch gate but ships no check()',
      timing: 'dispatch',
      action: 'block',
    }, { 'impl.mjs': 'export const nothing = 1;\n' });
    const sim = new SimulatedExecutor();
    const superworker = open(lab.root, { executor: sim });
    const receipt = await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(receipt.action).toBe('opened');
    expect(receipt.node_id).toBe(a);
    expect(warningsOf(receipt).join('\n')).toContain('WARNING: plugin doorless has no check()');
  });
});

describe('retry and the claim: the ticket a rerun leaves, and what a dead session needs', () => {
  it('the default retry keeps the claim; `drop` clears the ticket and the claim so the cell opens again', async () => {
    const lab = freshLab('superworker-retry-claim-');
    const a = await stageOneNodeLine(lab);
    const sim = new SimulatedExecutor();
    const superworker = open(lab.root, { executor: sim });

    await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(existsSync(markerOf(lab.root, 'c1', a))).toBe(true);

    // The default rerun rewrites the ticket as pending and leaves the claim: the session that took this
    // cell on is still out, so a second dispatch answers `already_open` without calling the executor.
    await superworker.ledger.cycles.retry('c1');
    expect(readFileSync(join(lab.root, '.superworker', 'signals', 'c1', `${a}.json`), 'utf8')).toContain('"pending"');
    const again = await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(again.action).toBe('already_open');
    expect(sim.dispatched).toHaveLength(1);

    // `drop` is the rerun a dead session needs: the pending ticket and the claim both go, so the cell can
    // be handed to a fresh session instead of being stranded between "waiting" and "already open".
    await superworker.ledger.cycles.retry('c1', a, { drop: true });
    expect(existsSync(join(lab.root, '.superworker', 'signals', 'c1', `${a}.json`))).toBe(false);
    expect(existsSync(markerOf(lab.root, 'c1', a))).toBe(false);
    const opened = await superworker.conductor.dispatch({ cycle: 'c1' });
    expect(opened.action).toBe('opened');
    expect(sim.dispatched).toHaveLength(2);
  });
});
