import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/words/table';

/**
 * The command face's law (docs/rules.md): one verb is one operation, and an option only shapes how
 * that operation runs -- where it stands, which line it reads, how it answers. The flow verbs carry
 * exactly the shaping options their one operation needs; a second operation behind the same word
 * (a claim, a session, a stop, a rehearsal on the reading word) is what this pins out.
 */

const FLAGS = (word: string): string[] =>
  ((COMMANDS as unknown as Record<string, { options?: Array<{ flags?: string[] }> }>)[word]?.options ?? [])
    .flatMap((option) => option.flags ?? [])
    .sort();

describe('one verb, one operation: the flow verbs carry shaping options only', () => {
  it('plan reads: where to read, and the closing rehearsal', () => {
    expect(FLAGS('plan')).toEqual(['--after', '--cycle', '--help', '--json', '--project', '-h']);
  });

  it('settle records one end: the line next decision is a word, not a flag', () => {
    expect(FLAGS('settle')).toEqual(['--cycle', '--help', '--json', '--project', '-h']);
  });

  it('advance composes claim, material and session: it is shaped by where and how only', () => {
    expect(FLAGS('advance')).toEqual(['--cycle', '--help', '--json', '--model', '--project', '--spawner', '-h']);
  });

  it('dispatch opens sessions: it claims nothing, so it carries no claim flag', () => {
    expect(FLAGS('dispatch')).toEqual(['--help', '--json', '--model', '--project', '--spawner', '-h']);
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
});