import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answer } from '../src/words/router';
import type { WordsIO } from '../src/words/types';

/**
 * Where `-o -` takes its bytes: the caller's input source on `WordsIO`, never this process's
 * stdin.
 *
 * The words layer is answered in-process by callers that are not a shell — the host half's agent
 * tool calls `answer()` inside a long-lived process, where this process's stdin has no `end` coming.
 * Reading it there does not read anything: it waits, and the call never comes back. The seam is the
 * same shape as the rest of `WordsIO`: a capability handed in by the caller. A call that hands in
 * no source refuses `-` by name (`@path` is the way out) instead of waiting; a call that hands one
 * in gets exactly those bytes.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): { io: WordsIO } {
  const root = mkdtempSync(join(tmpdir(), 'pf-words-input-'));
  dirs.push(root);
  return { io: { root, homeDir: join(root, '_home'), openerAvailable: true } };
}

async function call(io: WordsIO, argv: readonly string[]): Promise<string> {
  const result = await answer(argv, io);
  expect(result.code, `${argv.join(' ')} answered ${result.code}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

/** The words the whole word-line is staged with: a layout, one node, and a line holding it. */
async function stage(io: WordsIO): Promise<string> {
  await call(io, ['init']);
  await call(io, ['dag', 'add', 'a node one line holds']);
  await call(io, ['cycle', 'start', 'c1', '--force', '--tags', 'coding']);
  return (JSON.parse(readFileSync(join(io.root, '.pf', 'state.json'), 'utf8')) as {
    cycles: Array<{ id: string; holding: Array<{ id: string }> }>;
  }).cycles.find((cycle) => cycle.id === 'c1')!.holding[0]!.id;
}

function ticketOf(io: WordsIO, node: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(io.root, '.pf', 'signals', 'c1', `${node}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('`-o -`: the caller hands the input in, the words layer does not read this process', () => {
  it('refuses `-` at once, by name, when the call gave no input source', async () => {
    const { io } = project();
    const node = await stage(io);
    const refused = await answer(['handoff', 'c1', node, 'completed', '-s', 'done', '-o', '-'], io);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('no input source');
    expect(refused.stderr).toContain('@path');
    // Refusing is not writing: no ticket landed.
    expect(() => ticketOf(io, node)).toThrow();
  });

  it('takes the bytes of the source the call hands in', async () => {
    const { io } = project();
    const node = await stage(io);
    const seam: WordsIO = {
      ...io,
      readInput: async () => '{"deliverable":".pf/nodes/a/pf-conduct.md","touched":["src/a.ts"]}',
    };
    await call(seam, ['handoff', 'c1', node, 'completed', '-s', 'done', '-o', '-']);
    expect(ticketOf(io, node).outputs).toEqual({
      deliverable: '.pf/nodes/a/pf-conduct.md',
      touched: ['src/a.ts'],
    });
  });

  it('refuses at once, with the source\'s own reason, when the source cannot answer', async () => {
    const { io } = project();
    const node = await stage(io);
    // How the host half answers: an agent tool call owns no stream, and the seam says so by name.
    const refusing: WordsIO = {
      ...io,
      readInput: () => Promise.reject(new Error('an agent tool call has no input stream')),
    };
    const refused = await answer(['handoff', 'c1', node, 'completed', '-s', 'done', '-o', '-'], refusing);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('an agent tool call has no input stream');
    expect(refused.stderr).toContain('@path');
    expect(() => ticketOf(io, node)).toThrow();
  });
});
