import { describe, expect, it } from 'vitest';
import { COMMANDS, COMMAND_ROWS, GROUPS } from '../src/words/table';

/**
 * The command face's law (docs/rules.md): one verb is one operation, and an option only shapes how
 * that operation runs -- where it stands, which line it reads, how it answers, whether the effect is
 * left out. The flow verbs carry exactly the shaping options their one operation needs; a second
 * operation behind the same word (a claim, a session, a stop, a rehearsal on a reading word) is what
 * this pins out.
 *
 * The rows are read off the one table: `COMMAND_ROWS` is the flat view the router walks (a top-level
 * verb by its word, a group's verb as `"<group> <verb>"`), and `GROUPS` is where a group's verbs are
 * stored — the two are not two copies, the flat one is derived from the other.
 */

const FLAGS = (word: string): string[] =>
  (COMMAND_ROWS[word]?.options ?? []).flatMap((option) => option.flags ?? []).sort();

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
    const words = Object.keys(COMMAND_ROWS);
    const carrying = words.filter((word) => FLAGS(word).some((flag) => retired.includes(flag)));
    expect(carrying).toEqual([]);
  });

  it('the rehearsal flag sits on the words whose effect is not a record read back', () => {
    const words = Object.keys(COMMAND_ROWS);
    const carrying = words.filter((word) => FLAGS(word).includes('--dry-run')).sort();
    // settle and dispatch (the two effects worth rehearsing), and the merge driver's process hand-off, which
    // answers git with a verdict and writes nothing when it is rehearsed.
    expect(carrying).toEqual(['dispatch', 'merge-ledger', 'settle']);
  });

  it('claiming lives on a verb of its own, not in the line group', () => {
    const cycle = GROUPS.cycle?.commands?.map((command) => command.word) ?? [];
    expect(cycle).not.toContain('hold');
    expect(Object.keys(COMMAND_ROWS)).toContain('hold');
  });
});

/**
 * The instruction word surface is the instruction plugin's, not this table's. The five verbs and
 * their group left the core's table with the record they act on, so the core can never answer a word
 * the plugin owns (a declaration that claims a core word never routes, and doctor says so). The
 * plugin side of this pair is plugin-instruction-doctor.test.ts; the four panel lines those words
 * were spelled with moved to the host half with the word (src/host/instruction-lines.ts).
 */
describe('the instruction word surface is the plugin', () => {
  it('no instruction row is left in the table: not a group, not a verb', () => {
    expect(Object.keys(GROUPS)).not.toContain('instruction');
    const carrying = Object.keys(COMMAND_ROWS).filter((word) => word.split(' ')[0] === 'instruction');
    expect(carrying).toEqual([]);
  });

  it('no --scope cell is left either: the scope vocabulary went with the verbs that bound it', () => {
    const found: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (value === null || typeof value !== 'object') return;
      const held = value as Record<string, unknown>;
      const flags = held.flags;
      if (Array.isArray(flags) && flags.includes('--scope')) found.push(JSON.stringify(flags));
      for (const item of Object.values(held)) walk(item);
    };
    walk({ top: COMMANDS, groups: GROUPS });
    expect(found).toEqual([]);
  });
});