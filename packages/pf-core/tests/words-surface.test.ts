import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/words/table';
import {
  INSTRUCTION_SCOPES,
  instructionAddLine,
  instructionArchiveLine,
  instructionRemoveLine,
  instructionReviveLine,
} from '../src/words/lines';

/**
 * The command face's law (docs/rules.md): one verb is one operation, and an option only shapes how
 * that operation runs -- where it stands, which line it reads, how it answers, whether the effect is
 * left out. The flow verbs carry exactly the shaping options their one operation needs; a second
 * operation behind the same word (a claim, a session, a stop, a rehearsal on a reading word) is what
 * this pins out.
 */

const FLAGS = (word: string): string[] =>
  ((COMMANDS as unknown as Record<string, { options?: Array<{ flags?: string[] }> }>)[word]?.options ?? [])
    .flatMap((option) => option.flags ?? [])
    .sort();

describe('one verb, one operation: the flow verbs carry shaping options only', () => {
  it('plan reads: where to read, and the closing rehearsal', () => {
    expect(FLAGS('plan')).toEqual(['--after', '--cycle', '--help', '--json', '--project', '-h']);
  });

  it('hold claims: which line, and nothing else', () => {
    expect(FLAGS('hold')).toEqual(['--cycle', '--help', '--project', '-h']);
  });

  it('settle records one end: the line next decision is a word, and the only flag past it is the rehearsal', () => {
    expect(FLAGS('settle')).toEqual(['--cycle', '--dry-run', '--help', '--json', '--project', '-h']);
  });

  it('advance composes claim, material and session: it is shaped by where and how only', () => {
    expect(FLAGS('advance')).toEqual(['--cycle', '--help', '--json', '--model', '--project', '-h']);
  });

  it('dispatch opens sessions: it claims nothing, and it can be rehearsed', () => {
    expect(FLAGS('dispatch')).toEqual(['--dry-run', '--help', '--json', '--model', '--project', '-h']);
  });

  it('handoff writes the ticket: the shape, the summary and the readings, nothing else', () => {
    expect(FLAGS('handoff')).toEqual(['--form', '--help', '--outputs', '--project', '--summary', '-h', '-o', '-s']);
  });

  it('the retired op-selecting flags are on no verb at all', () => {
    const retired = ['--plan', '--spawn', '--no-spawn', '--continue', '--stop'];
    const words = Object.keys(COMMANDS as unknown as Record<string, unknown>);
    const carrying = words.filter((word) => FLAGS(word).some((flag) => retired.includes(flag)));
    expect(carrying).toEqual([]);
  });

  it('the rehearsal flag sits on the words whose effect is not a record read back', () => {
    const words = Object.keys(COMMANDS as unknown as Record<string, unknown>);
    const carrying = words.filter((word) => FLAGS(word).includes('--dry-run')).sort();
    // settle and dispatch (the two effects worth rehearsing), and the merge driver's process hand-off, which
    // answers git with a verdict and writes nothing when it is rehearsed.
    expect(carrying).toEqual(['dispatch', 'merge-ledger', 'settle']);
  });

  it('claiming lives on a verb of its own, not in the line group', () => {
    const commands = COMMANDS as unknown as Record<string, { commands?: Array<{ word: string }> }>;
    const cycle = commands.cycle?.commands?.map((command) => command.word) ?? [];
    expect(cycle).not.toContain('hold');
    expect(Object.keys(commands)).toContain('hold');
  });
});
/**
 * The panel words that name an engine call. The vocabulary lives on this side because the command
 * table states it; a caller that keeps its own copy refuses what this table would have accepted the
 * day a fourth scope lands. These cases pin the two facts the boundary forwards:
 *
 * - the scopes the table offers are the exported `INSTRUCTION_SCOPES` list, every cell of it;
 * - a line built here is the line the words layer answers, and a refused scope / an empty sentence is
 *   this side's answer, not the boundary's guess.
 */
describe('the instruction scopes and the panel words: one home, on the engine side', () => {
  /** Every `--scope` cell's choices in the table, wherever it sits (leaves and group listings both carry the row). */
  const scopeChoiceLists = (): unknown[] => {
    const found: unknown[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const held = value as Record<string, unknown>;
      const flags = held.flags;
      if (Array.isArray(flags) && flags.includes('--scope') && Array.isArray(held.choices)) {
        found.push(held.choices);
      }
      for (const item of Object.values(held)) walk(item);
    };
    walk(COMMANDS);
    return found;
  };

  it('every --scope cell offers exactly the engine list', () => {
    const lists = scopeChoiceLists();
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect(list).toEqual([...INSTRUCTION_SCOPES]);
  });

  it('an instruction add line puts the scope first and the verbatim sentence last, as the parser reads it', () => {
    expect(instructionAddLine({ text: 'do the thing', scope: 'node', node: 'n-1' })).toEqual({
      ok: true,
      argv: ['instruction', 'add', '--scope', 'node', '--node', 'n-1', '--text', 'do the thing'],
    });
    expect(instructionAddLine({ text: 'global note', scope: 'global', node: 'ignored' })).toEqual({
      ok: true,
      argv: ['instruction', 'add', '--scope', 'global', '--text', 'global note'],
    });
  });

  it('a scope outside the list and an empty sentence are refused here', () => {
    expect(instructionAddLine({ text: 'x', scope: 'everywhere' })).toEqual({
      ok: false,
      code: 'scope-unknown',
      detail: 'everywhere',
    });
    expect(instructionAddLine({ text: '   ', scope: 'global' })).toEqual({ ok: false, code: 'empty-text', detail: '' });
  });

  it('the panel word "archive" is the engine call resolve --state withdrawn', () => {
    expect(instructionArchiveLine('i-1')).toEqual(['instruction', 'resolve', 'i-1', '--state', 'withdrawn']);
    expect(instructionReviveLine('i-1')).toEqual(['instruction', 'revive', 'i-1']);
    expect(instructionRemoveLine('i-1')).toEqual(['instruction', 'rm', 'i-1']);
  });
});
