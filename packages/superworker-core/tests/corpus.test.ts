import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayCase } from './helpers/corpus';

/**
 * Golden corpus: every case (tests/fixtures/<case name>/, input + one operation + expected
 * products) is replayed once, and the products must match expected/ byte for byte. A case
 * directory carries all three parts; a missing input/ means empty input (the init cases).
 *
 * The self-check is its own case: with one expectation deliberately corrupted, the replayer must go
 * red and point at the first difference — proof that it does not always pass.
 */

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Every case directory under fixtures (the older flat fixtures are files and do not mix in). */
const caseDirs = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * `conductor.dispatch` is already wired to behaviour: the `dispatch-*` preparation cases are
 * replayed from the public handle like any other case (the replayer's conductor namespace carries a
 * simulated executor that answers from a script).
 */
const cases = caseDirs.filter((name) =>
  existsSync(join(fixturesDir, name, 'op.json')) && existsSync(join(fixturesDir, name, 'expected')),
);

describe('golden corpus: input + operation → expected products byte for byte', () => {
  it('every case directory has all three parts: op.json and expected/ must be there, so a half-written directory cannot slip out of coverage', () => {
    expect(caseDirs.length).toBeGreaterThan(0);
    for (const name of caseDirs) {
      expect(existsSync(join(fixturesDir, name, 'op.json')), `${name}: missing op.json`).toBe(true);
      expect(existsSync(join(fixturesDir, name, 'expected')), `${name}: missing expected/`).toBe(true);
    }
  });

  it.each(cases)('%s', async (name) => {
    const result = await replayCase(join(fixturesDir, name));
    expect(result.ok, `case ${name} failed the comparison:\n${result.problems.join('\n')}`).toBe(true);
  });
});

describe('replayer self-check: a corrupted expectation must go red', () => {
  it('with three characters of the title in the expectation changed, the replayer points at the first difference', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'superworker-corpus-selfcheck-'));
    try {
      cpSync(join(fixturesDir, 'dag-add-basic'), join(copy, 'dag-add-basic'), { recursive: true });
      const expectedPath = join(copy, 'dag-add-basic', 'expected', '.superworker', 'ideas.json');
      const original = readFileSync(expectedPath, 'utf8');
      const marker = '"title": "';
      const at = original.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      // Swap the first three characters of the title value for another three of equal length, to
      // produce exactly one real difference.
      const corrupted = original.slice(0, at + marker.length) + 'zzz' + original.slice(at + marker.length + 3);
      writeFileSync(expectedPath, corrupted, 'utf8');
      const result = await replayCase(join(copy, 'dag-add-basic'));
      expect(result.ok).toBe(false);
      expect(result.problems.join('\n')).toContain('the first difference');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
