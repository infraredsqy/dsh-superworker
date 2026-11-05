import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeLab } from './helpers/plugin-lab';
import { open } from '../src/open';
import { SimulatedExecutor } from '../src/executor';

/**
 * The handle's additive surface: the actions the transport layer reads through.
 *
 * Each action is pinned by the invariant it carries, not by its wording:
 *
 * - `ledger.cleanTemp` sweeps one cell and one cell only, and a listing run writes nothing;
 * - `ledger.cycles.policies` hands back the effective set (the defaults, then what the line states);
 * - `ledger.cycles.standing` tells held-now / walked-before / nothing, plus the ticket on disk;
 * - `conductor.prepare` lands one dispatch's material and opens no session;
 * - `conductor.closeWith` lands the same settle `close` lands, with the caller's own closing answer;
 * - `conductor.pluginCommand` routes a declared word into the plugin that declares it, in this
 *   process, and answers "nobody claims this word" for anything else;
 * - `conductor.handoffForm` names the reading slots this line asks for, and writes nothing.
 *
 * Adding an action is an addition to the frozen surface: no existing name or signature changes here.
 */

const NODE_TITLE = 'Node A -- the one this line holds';

/** One plugin whose single command answers text, and whose declaration carries one knob. */
const TALKER_DECL = {
  name: 'talker',
  summary: 'answers one word',
  timing: 'close',
  action: 'insert',
  commands: { talker: { summary: 'the talker word', keep_name: false } },
  knobs: { talker_knob: { kind: 'switch', default: 'on', summary: 'a knob' } },
  readings: {
    measured: {
      source: 'ticket',
      when_knob: 'talker_knob',
      ask: 'the measured number of the run',
    },
  },
};
const TALKER_IMPL = [
  'export function offer() { return null; }',
  'export function main(argv) {',
  '  if (argv[0] === "code") return 7;',
  '  return "talked:" + argv.join("|");',
  '}',
].join('\n');

describe('ledger.cleanTemp: one cell, and a listing run writes nothing', () => {
  it('lists the nodes\' temp dirs without touching them, then removes only those it listed', async () => {
    const lab = makeLab('pf-add-clean-');
    try {
      await lab.pf.ledger.init();
      const node = await lab.pf.ledger.dag.add({ title: NODE_TITLE });
      const tempDir = join(lab.root, '.pf', 'nodes', node.id, 'temp');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'raw.txt'), 'raw output\n', 'utf8');

      const listed = await lab.pf.ledger.cleanTemp();
      expect(listed.targets.map((entry) => entry.node)).toEqual([node.id]);
      expect(listed.removed).toEqual([]);
      expect(existsSync(join(tempDir, 'raw.txt'))).toBe(true);

      const swept = await lab.pf.ledger.cleanTemp({ remove: true });
      expect(swept.removed.map((entry) => entry.node)).toEqual([node.id]);
      expect(existsSync(tempDir)).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a node a line holds right now is skipped, and force is what clears it', async () => {
    const lab = makeLab('pf-add-clean-held-');
    try {
      await lab.pf.ledger.init();
      const node = await lab.pf.ledger.dag.add({ title: NODE_TITLE });
      lab.cycle('c1', [node.id]);
      const tempDir = join(lab.root, '.pf', 'nodes', node.id, 'temp');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'raw.txt'), 'raw output\n', 'utf8');

      const held = await lab.pf.ledger.cleanTemp({ remove: true });
      expect(held.running.map((entry) => entry.node)).toEqual([node.id]);
      expect(held.removed).toEqual([]);
      expect(existsSync(join(tempDir, 'raw.txt'))).toBe(true);

      const forced = await lab.pf.ledger.cleanTemp({ remove: true, force: true });
      expect(forced.removed.map((entry) => entry.node)).toEqual([node.id]);
    } finally {
      lab.cleanup();
    }
  });
});

describe('ledger.cycles: the two readings the words print', () => {
  it('policies answers the effective set: the defaults, then what the line states', async () => {
    const lab = makeLab('pf-add-policies-');
    try {
      await lab.pf.ledger.init();
      await lab.pf.ledger.cycles.create({ id: 'c1', title: 'One', tags: ['coding'] });
      const defaults = await lab.pf.ledger.cycles.policies('c1');
      expect(defaults).toMatchObject({ when_shelved: 'stop', parallel: 1 });

      await lab.pf.ledger.cycles.setPolicy('c1', 'parallel', 2);
      expect((await lab.pf.ledger.cycles.policies('c1')).parallel).toBe(2);
      // A line that is not on the account is refused, exactly as the write verbs refuse one.
      await expect(lab.pf.ledger.cycles.policies('nope')).rejects.toThrow(/not found/u);
    } finally {
      lab.cleanup();
    }
  });

  it('standing tells held-now, walked-before and nothing apart, and reads the ticket beside it', async () => {
    const lab = makeLab('pf-add-standing-');
    try {
      await lab.pf.ledger.init();
      const node = await lab.pf.ledger.dag.add({ title: NODE_TITLE });
      const other = await lab.pf.ledger.dag.add({ title: 'Node B' });
      await lab.pf.ledger.cycles.create({ id: 'c1', title: 'One', tags: ['coding'] });
      await lab.pf.ledger.cycles.hold('c1', node.id);
      await lab.pf.conductor.handoff({
        cycle: 'c1',
        node: node.id,
        status: 'completed',
        summary: 'delivered it',
        outputs: { deliverable: 'the thing' },
      });

      const held = await lab.pf.ledger.cycles.standing('c1', node.id);
      expect(held.standing).toBe('holding');
      expect(held.since).not.toBeNull();
      expect(held.signal).toMatchObject({ status: 'completed', summary: 'delivered it' });
      expect(held.signal?.outputs).toEqual({ deliverable: 'the thing' });

      const unknown = await lab.pf.ledger.cycles.standing('c1', other.id);
      expect(unknown.standing).toBe('nothing');
      expect(unknown.signal).toBeNull();

      await lab.pf.ledger.cycles.close('c1', { node: node.id, result: 'completed' });
      const walked = await lab.pf.ledger.cycles.standing('c1', node.id);
      expect(walked.standing).toBe('walked');
      expect(walked.step).toMatchObject({ result: 'completed' });
      expect(walked.step?.started_at).not.toBeNull();
      expect(walked.step?.ended_at).not.toBeNull();
    } finally {
      lab.cleanup();
    }
  });
});

describe('conductor: the closing answers, the plugin words and the ticket shape', () => {
  it('closeWith lands the settle close lands, and a decided stop parks the line', async () => {
    const lab = makeLab('pf-add-closewith-');
    try {
      await lab.pf.ledger.init();
      const node = await lab.pf.ledger.dag.add({ title: NODE_TITLE });
      await lab.pf.ledger.cycles.create({ id: 'c1', title: 'One', tags: ['coding'] });
      await lab.pf.ledger.cycles.hold('c1', node.id);
      await lab.pf.conductor.handoff({
        cycle: 'c1',
        node: node.id,
        status: 'completed',
        summary: 'delivered it',
      });

      const settled = await lab.pf.conductor.closeWith({
        cycle: 'c1',
        node: node.id,
        decision: 'stop',
        note: 'the human said stop here',
      });
      expect(settled.status).toBe('inactive');
      expect((settled.path ?? []).map((step) => step.result)).toEqual(['completed']);
      expect((await lab.pf.ledger.dag.get(node.id))?.status).toBe('completed');
      // The plain `close` keeps its own signature and still answers the criteria's decision.
      expect(typeof lab.pf.conductor.close).toBe('function');
    } finally {
      lab.cleanup();
    }
  });

  it('pluginCommand runs a declared word in this process and refuses a word nobody claims', async () => {
    const lab = makeLab('pf-add-plugin-');
    try {
      await lab.pf.ledger.init();
      const missing = await lab.pf.conductor.pluginCommand({ word: 'talker', argv: ['x'] });
      expect(missing).toMatchObject({ word: 'talker', plugin: null, ran: false, text: null });

      lab.plugin('talker', TALKER_DECL, { 'impl.mjs': TALKER_IMPL });
      const table = await lab.pf.conductor.pluginCommands();
      expect(table.map((entry) => entry.name)).toEqual(['talker']);

      const answer = await lab.pf.conductor.pluginCommand({ word: 'talker', argv: ['one', 'two'] });
      expect(answer).toEqual({ word: 'talker', plugin: 'talker', ran: true, text: 'talked:one|two', code: null, error: null });

      // `main` may hand back a number: that number is the exit code the run asks for, so it is carried out.
      const coded = await lab.pf.conductor.pluginCommand({ word: 'talker', argv: ['code'] });
      expect(coded).toMatchObject({ plugin: 'talker', ran: true, text: null, code: 7, error: null });

      const failed = await lab.pf.conductor.pluginCommand({ word: 'no-such-word', argv: [] });
      expect(failed.ran).toBe(false);
      expect(failed.plugin).toBeNull();
    } finally {
      lab.cleanup();
    }
  });

  it('handoffForm names the reading slots in force, and writes nothing', async () => {
    const lab = makeLab('pf-add-form-');
    try {
      await lab.pf.ledger.init();
      await lab.pf.ledger.cycles.create({ id: 'c1', title: 'One', tags: ['coding'] });
      await lab.pf.config.set('talker_knob', 'on', { project: true }).catch(() => undefined);
      lab.plugin('talker', TALKER_DECL, { 'impl.mjs': TALKER_IMPL });

      const form = await lab.pf.conductor.handoffForm({ cycle: 'c1' });
      expect(form.cycle).toBe('c1');
      // The reading is asked for only while its switch is in force; its question travels with the slot.
      expect(form.readings.map((slot) => slot.key)).toEqual(['measured']);
      expect(form.readings[0]?.ask).toBe('the measured number of the run');

      // A line that is not on the account is refused instead of answering an empty shape.
      await expect(lab.pf.conductor.handoffForm({ cycle: 'nope' })).rejects.toThrow(/no cycle/u);
    } finally {
      lab.cleanup();
    }
  });
});

describe('conductor.prepare: one dispatch material landed, and no session opened', () => {
  it('lands the prompt and the run doc for the node in hand, and no `started` claim', async () => {
    const lab = makeLab('pf-add-prepare-');
    try {
      await lab.pf.ledger.init();
      const node = await lab.pf.ledger.dag.add({ title: NODE_TITLE });
      lab.cycle('c1', [node.id]);

      const prepared = await open(lab.root).conductor.prepare({ cycle: 'c1' });
      expect(prepared.cycle).toBe('c1');
      expect(prepared.nodes.map((entry) => entry.node_id)).toEqual([node.id]);

      const prompt = join(lab.root, '.pf', 'meta', 'launch', 'c1', node.id, 'prompt.txt');
      expect(readFileSync(prompt, 'utf8').replace(/\r\n/gu, '\n')).toBe(`/pf-conduct ${node.id} [pipeline]\n`);
      expect(existsSync(join(lab.root, '.pf', 'nodes', node.id, 'run.md'))).toBe(true);
      // Preparing is not dispatching: nothing was handed to a session, so no claim was laid either.
      expect(existsSync(join(lab.root, '.pf', 'meta', 'launch', 'c1', node.id, 'started'))).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('only a dispatch plan has material: a line holding nothing is refused with nothing written', async () => {
    const lab = makeLab('pf-add-prepare-refused-');
    try {
      await lab.pf.ledger.init();
      await lab.pf.ledger.cycles.create({ id: 'c1', title: 'One', tags: ['coding'] });
      await expect(lab.pf.conductor.prepare({ cycle: 'c1' })).rejects.toThrow(
        /only accepts a dispatch plan/u,
      );
      expect(existsSync(join(lab.root, '.pf', 'meta', 'launch'))).toBe(false);
    } finally {
      lab.cleanup();
    }
  });

  it('a dispatch over a prompt the pinning step landed opens the session and leaves that prompt alone', async () => {
    const lab = makeLab('pf-add-prepare-dispatch-');
    try {
      await lab.pf.ledger.init();
      const node = await lab.pf.ledger.dag.add({ title: NODE_TITLE });
      lab.cycle('c1', [node.id]);
      // The pinning step lands the material first; the ticket an earlier run left behind is not this
      // call's business. The gate is the pair of disk facts: the prompt is there, `started` is not.
      await lab.pf.conductor.prepare({ cycle: 'c1' });
      await lab.pf.conductor.handoff({
        cycle: 'c1',
        node: node.id,
        status: 'completed',
        summary: 'from an earlier run',
      });
      const prompt = join(lab.root, '.pf', 'meta', 'launch', 'c1', node.id, 'prompt.txt');
      const promptBytes = readFileSync(prompt);

      const sim = new SimulatedExecutor();
      const opened = await open(lab.root, { executor: sim }).conductor.dispatch({ cycle: 'c1' });
      expect(opened.action).toBe('opened');
      expect(opened.session).toEqual({ sessionId: 'sess-1' });
      // One session, and the landed prompt is not rewritten: there was nothing left to prepare.
      expect(sim.dispatched).toHaveLength(1);
      expect(readFileSync(prompt)).toEqual(promptBytes);
      expect(existsSync(join(lab.root, '.pf', 'meta', 'launch', 'c1', node.id, 'started'))).toBe(true);
    } finally {
      lab.cleanup();
    }
  });
});