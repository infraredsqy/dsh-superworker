import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigNamespace, type KnobSpec } from '../src/config.ts';
import { createCyclesNamespace } from '../src/cycles.ts';
import { open } from '../src/open.ts';

/**
 * The lines table (`state.json`) has one reading in the engine, and both the cycles namespace and the
 * settings chain ask it: the whole document with the `cycles` table normalized, one line by exact id,
 * and the lines holding one node. The two visible readings of that:
 *
 * - **one read per reading**: a node's settings read is placed on the line holding it, so it needs the
 *   table once — it reads the file once, not once for the holder and again for the line record.
 * - **the table is normalized once**: entries that are not line records cannot be read as lines and
 *   are skipped on the read side (the same silence the read side keeps about every other malformed
 *   cell) instead of crashing one reader while the other looks past them.
 *
 * `readFile` is counted for this file only, and only for `state.json`; every other entry point passes
 * straight through.
 */

const stateReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = actual.readFile as unknown as (path: string) => Promise<Uint8Array>;
  return {
    ...actual,
    readFile: async (path: string): Promise<Uint8Array> => {
      if (String(path).endsWith('state.json')) stateReads.count += 1;
      return readFile(path);
    },
  };
});

/** A plugin-style knob taking the whole chain, so the line and node layers are read at all. */
const DECLARED: Record<string, KnobSpec> = {
  proj_depth: { kind: 'number', default: 6, summary: 'a knob walking the whole chain' },
};

let root: string;
let home: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pf-state-reader-'));
  home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  await open(root).ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function stateText(): string {
  return readFileSync(join(root, '.pf', 'state.json'), 'utf8');
}

describe('one reading of the lines table', () => {
  it("a node's settings read asks state.json once: the holder and the line record come from the same reading", async () => {
    const pf = open(root);
    const node = (await pf.ledger.dag.add({ title: 'A' })).id;
    await pf.ledger.cycles.create({ id: 'c1', tags: ['coding'] });
    await pf.ledger.cycles.hold('c1', node);
    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    await config.set('proj_depth', 4, { cycle: 'c1' });

    stateReads.count = 0;
    // The reading is placed on the line holding the node, and that one reading answers both questions.
    expect(await config.get('proj_depth', { node })).toEqual({ value: 4, source: 'cycle' });
    expect(stateReads.count).toBe(1);
  });

  it('entries that are not line records are skipped by both readers, not crashed on by one of them', async () => {
    const node = (await open(root).ledger.dag.add({ title: 'B' })).id;
    // A hand-edited table: a null, a bare string and an array around the one real line. None of the
    // three can be a line record, and the read side already keeps that kind of silence.
    writeFileSync(
      join(root, '.pf', 'state.json'),
      JSON.stringify({
        cycles: [
          null,
          'junk',
          [],
          {
            id: 'c9',
            title: 'c9',
            status: 'active',
            holding: [{ id: node, since: '2020-01-01T00:00:00Z' }],
            path: [],
            policies: { proj_depth: 2 },
            created_at: '2020-01-01T00:00:00Z',
            updated_at: '2020-01-01T00:00:00Z',
          },
        ],
      }, null, 2),
      'utf8',
    );

    const cycles = createCyclesNamespace(root);
    expect((await cycles.list()).map((record) => record.id)).toEqual(['c9']);

    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    expect(await config.get('proj_depth', { cycle: 'c9' })).toEqual({ value: 2, source: 'cycle' });
    // The same line answers a node read: one node, one holder, one reading.
    expect(await config.get('proj_depth', { node })).toEqual({ value: 2, source: 'cycle' });
  });

  it('a line record read back with the old bare-id claim list is still one line holding its node', async () => {
    const node = (await open(root).ledger.dag.add({ title: 'C' })).id;
    writeFileSync(
      join(root, '.pf', 'state.json'),
      JSON.stringify({
        cycles: [{
          id: 'c3',
          title: 'c3',
          status: 'active',
          holding: [node],
          path: [],
          policies: { proj_depth: 3 },
        }],
      }, null, 2),
      'utf8',
    );
    const before = stateText();
    const config = createConfigNamespace(root, { homeDir: home, declaredKnobs: DECLARED });
    expect(await config.get('proj_depth', { node })).toEqual({ value: 3, source: 'cycle' });
    // The reading does not rewrite the record: the on-disk shape is the writer's business.
    expect(stateText()).toBe(before);
  });
});
