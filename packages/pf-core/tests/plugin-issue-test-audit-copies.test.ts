import { describe, expect, it } from 'vitest';
import { offer as issueOffer } from '../plugins/issue/impl.mjs';
import { offer as auditOffer } from '../plugins/test-audit/impl.mjs';

/**
 * The pair of copies: the issue pool's plugin and the test-audit plugin each carry the same machinery
 * (declaration reading, prose merge, the `>=` comparison, the offer assembly, the six-significant-digit
 * formatter, the generated spec template), because a plugin folder is installed and removed on its own
 * and nothing is shared between two of them. Neither plugin may import the other's file, and the engine
 * has no seam that would hand a spec template or a number spelling over — so the two copies are held
 * together here instead: the same batch of numbers goes through both doors and the strings they print
 * are compared cell by cell, and the two generated specs are read for the contract they share.
 *
 * This is the piece both sides were missing: without it a change to one copy's spelling or template is
 * a difference somebody has to notice by reading two files side by side.
 *
 * The convergence point, when these two are not allowed to drift any more, is an engine seam (a spec
 * template and a number formatter handed over through `ctx`) — not one plugin reaching into the other.
 */

/** The node id the generated specs are rendered for (the uuid the offer's `spec_of` is called with). */
const NODE = 'node-id';

/** The path both `specPath` stand-ins answer, so the landing line can be compared. */
const SPEC_PATH = '/specs/node-id/spec.md';

interface Crossing {
  /** The title the offer asked the node to carry. */
  title: string;
  /** The number the offer printed as the reading, as a person reads it. */
  value: string;
  /** The number it printed as the line, as a person reads it. */
  line: string;
  /** The generated spec's text. */
  spec: string;
}

/** A context stand-in that answers the two doors' questions without an engine: only what `offer` reads. */
function contextFor(lineKnob: string, value: number, line: number) {
  return {
    root: '/nowhere',
    cycle: { id: 'c1', tags: ['coding'] },
    nodeId: 'closed-node',
    target: { id: 'target-id', title: 'the node it had picked' },
    dag: { nodes: {} },
    async knob(name: string) {
      return name === lineKnob ? line : null;
    },
    async reading() {
      return value;
    },
    nodesWithTag: () => [] as string[],
    specPath: (id: string) => `/specs/${id}/spec.md`,
  };
}

/** The two numbers out of one offer's title (`Maintenance: <subject> = <value><unit>, over the line <line><unit>`). */
function numbersOf(title: string): { value: string; line: string } {
  const found = / = (.+?), over the line (.+)$/u.exec(title);
  if (found === null) throw new Error(`no numbers in this title: ${JSON.stringify(title)}`);
  return { value: found[1]!, line: found[2]! };
}

/** The unit the test-audit plugin prints after its numbers (its prose says `s`); the number is the part compared. */
function withoutUnit(spelled: string): string {
  return spelled.replace(/s$/u, '');
}

async function crossing(
  door: (ctx: unknown) => Promise<{ title: string; spec_of: (id: string) => string } | null>,
  lineKnob: string,
  value: number,
  line: number,
  unit = '',
): Promise<Crossing> {
  const offered = await door(contextFor(lineKnob, value, line));
  if (offered === null) throw new Error(`${value} over ${line} did not cross`);
  const numbers = numbersOf(offered.title);
  return {
    title: offered.title,
    value: withoutUnit(numbers.value).replace(unit, ''),
    line: withoutUnit(numbers.line).replace(unit, ''),
    spec: offered.spec_of(NODE),
  };
}

/** One crossing through the pool's door. */
function issue(value: number, line: number): Promise<Crossing> {
  return crossing(issueOffer as never, 'issue_pool_weight_limit', value, line);
}

/** The same crossing through the test-audit door (its numbers carry the unit `s`). */
function audit(value: number, line: number): Promise<Crossing> {
  return crossing(auditOffer as never, 'test_seconds_limit', value, line, 's');
}

describe('the two copied formatters spell one number the same way', () => {
  it('a batch of readings and lines comes out of both doors identically', async () => {
    // Integers, a fraction, four decimals, the six-significant-digit ceiling, the exponent branch on
    // both sides of zero, a negative line, and a carry that rounds the mantissa up a decade.
    const batch: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [3, 2],
      [12, 4],
      [1.5, 0.5],
      [0.0001, 0],
      [123456, 12345],
      [1234567, 0],
      [1e9, 0],
      [2.5, -120],
    ];
    for (const [value, line] of batch) {
      const one = await issue(value, line);
      const two = await audit(value, line);
      expect(two.value, `value ${value} / line ${line}`).toBe(one.value);
      expect(two.line, `line ${line} of value ${value}`).toBe(one.line);
    }
  });

  it('one cell is a recorded divergence, not a promise: a rounding carry past six digits takes the exponent form on the pool side', async () => {
    // 999999.7 has seven significant digits; six of them round up to 1000000. The pool's copy notices
    // that the carry pushed the exponent up a decade and spells `1e+06`; the test-audit copy keeps the
    // fixed spelling of the carried number. Both spellings are recorded as they stand today — this is
    // a debt, not a contract: the pool side's carry branch is what has to change once one spelling is
    // chosen (see `plugins/issue/impl.mjs` header and review-1 m2), and then this cell is an equality
    // like every other cell in the batch above.
    const one = await issue(999999.7, 0);
    const two = await audit(999999.7, 0);
    expect([one.value, two.value], 'the two spellings today; a debt, not a contract').toEqual(['1e+06', '1000000']);
  });
});

describe('the two copied spec templates carry the same contract', () => {
  it('the header, the read and the line, the method line, the completion rule and the landing path are in both', async () => {
    const one = await issue(6, 4);
    const two = await audit(6, 4);
    for (const [name, crossingOne] of [['issue', one], ['test-audit', two]] as const) {
      const spec = crossingOne.spec;
      expect(spec.split('\n')[0], `${name}: header`).toBe('# Maintenance node (generated by the tool)');
      expect(spec, `${name}: why it was inserted`).toContain('## Why this node was inserted');
      expect(spec, `${name}: the number read`).toContain('read at the close: **6');
      expect(spec, `${name}: the line in force`).toContain('the line in force for this close: **4');
      expect(spec, `${name}: the method line`).toContain('- `method: ');
      expect(spec, `${name}: the completion rule`).toContain('## Completion rule (mechanically judgeable)');
      expect(spec, `${name}: where the spec lands`).toContain(`(this spec lands at: ${SPEC_PATH})`);
    }
  });

  it('both offers title the crossing the same way: the metric, the reading, the line, in that order', async () => {
    const one = await issue(6, 4);
    const two = await audit(6, 4);
    const shape = /^Maintenance: .+ = .+, over the line .+$/u;
    expect(one.title, 'issue').toMatch(shape);
    expect(two.title, 'test-audit').toMatch(shape);
    // The metric's own words differ (one pool, one test suite); the shape around them does not, and
    // the one number of each title is the reading this batch asked for.
    expect(numbersOf(one.title).value).toBe('6');
    expect(withoutUnit(numbersOf(two.title).value)).toBe('6');
  });
});
