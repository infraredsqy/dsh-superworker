import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfigNamespace, type KnobSpec } from '../src/config.ts';
import { createCyclesNamespace } from '../src/cycles.ts';
import { open } from '../src/open.ts';

/**
 * The lines table (`state.json`) has one reading in the engine, and both the cycles namespace and the
 * settings chain ask it: the whole document with the `cycles` table normalized, one line by exact id,
 * and the lines holding one node. The one visible reading of that: the table is normalized once —
 * entries that are not line records cannot be read as lines and are skipped on the read side (the
 * same silence the read side keeps about every other malformed cell) instead of crashing one reader
 * while the other looks past them.
 */

/** A plugin-style knob taking the whole chain, so the line and node layers are read at all. */
const DECLARED: Record<string, KnobSpec> = {
  proj_depth: { kind: 'number', default: 6, summary: 'a knob walking the whole chain' },
};

let root: string;
let home: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superworker-state-reader-'));
  home = join(root, '_home');
  mkdirSync(home, { recursive: true });
  await open(root).ledger.init();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('one reading of the lines table', () => {
  it('entries that are not line records are skipped by both readers, not crashed on by one of them', async () => {
    const node = (await open(root).ledger.dag.add({ title: 'B' })).id;
    // A hand-edited table: a null, a bare string and an array around the one real line. None of the
    // three can be a line record, and the read side already keeps that kind of silence.
    writeFileSync(
      join(root, '.superworker', 'state.json'),
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
});
