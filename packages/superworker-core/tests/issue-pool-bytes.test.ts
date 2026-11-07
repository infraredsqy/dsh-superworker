import { describe, expect, it } from 'vitest';
// The two sides of the contract: the engine's record foundation and the issue pool plugin's own
// record layer. They are deliberately separate code — neither reaches into the other.
import { microTimestampOf as engineMicroTimestampOf } from '../src/clock.ts';
import { jsonBytes as engineJsonBytes, jsonOptionsForRecord } from '../src/jsonio.ts';
import {
  jsonBytes as poolJsonBytes,
  microTimestampOf as poolMicroTimestampOf,
  now as poolNow,
} from '../plugins/issue/tools/storage.mjs';

/**
 * The byte contract between the issue pool and the engine's record foundation.
 *
 * The pool is written by its own plugin (`plugins/issue/tools/storage.mjs`) and the core records by
 * `src/jsonio.ts`; both land files under `<root>/.superworker/`, and the owners do not share code. What the
 * two sides promise each other is exactly one thing: the same value encodes to the same bytes. One
 * batch of values — nested objects and arrays, Chinese, key order, integer and decimal spellings,
 * the empty table — goes through both implementations and the UTF-8 bytes are compared cell by
 * cell. A change to either side's indent, key ordering, line ending or number spelling turns this
 * red at once instead of silently forking the two spellings of one record.
 */

const encoder = new TextEncoder();

/** The engine's encoding of this record: the issue pool is one of the records whose keys sort deeply. */
function engineBytes(value: unknown): Uint8Array {
  return engineJsonBytes(value, jsonOptionsForRecord('issues'));
}

/** The pool plugin's encoding of the same value, taken to bytes. */
function poolBytes(value: unknown): Uint8Array {
  return encoder.encode((poolJsonBytes as (value: unknown) => string)(value));
}

/** The two readings of one value, as the byte arrays a person can diff. */
function both(value: unknown): { engine: number[]; pool: number[] } {
  return { engine: [...engineBytes(value)], pool: [...poolBytes(value)] };
}

describe('the pool and the engine encode one value to the same bytes', () => {
  it('nested objects and arrays: indentation, nesting and array layout are the same on both sides', () => {
    const value = {
      version: 1,
      issues: {
        'a-1': {
          id: 'a-1',
          title: 'nested',
          files: ['src/a.ts', 'src/b.ts'],
          metadata: { owner: { team: 'core', people: ['ann', 'bo'] }, labels: [] },
        },
      },
    };
    const { engine, pool } = both(value);
    expect(pool).toEqual(engine);
    // The reading is pinned once in the open as well, so a shared drift (both sides changing the
    // indent together) still shows here: two spaces, no tab, LF and no trailing newline.
    expect(Buffer.from(engine).toString('utf8')).toBe(
      [
        '{',
        '  "issues": {',
        '    "a-1": {',
        '      "files": [',
        '        "src/a.ts",',
        '        "src/b.ts"',
        '      ],',
        '      "id": "a-1",',
        '      "metadata": {',
        '        "labels": [],',
        '        "owner": {',
        '          "people": [',
        '            "ann",',
        '            "bo"',
        '          ],',
        '          "team": "core"',
        '        }',
        '      },',
        '      "title": "nested"',
        '    }',
        '  },',
        '  "version": 1',
        '}',
      ].join('\n'),
    );
  });

  it('Chinese text stays as it is on both sides: no escapes, no byte order mark', () => {
    const value = {
      issues: {
        'zh-1': {
          title: '问题池与引擎的记录口径',
          description: '中文原样落盘，不做转义。',
          mixed: 'ASCII 与中文「引号」混排 — 破折号',
        },
      },
    };
    const { engine, pool } = both(value);
    expect(pool).toEqual(engine);
    const text = Buffer.from(engine).toString('utf8');
    expect(text).toContain('问题池与引擎的记录口径');
    expect(text).not.toContain('\\u');
    expect(engine[0]).not.toBe(0xef); // no BOM at the front
  });

  it('key order: keys sort deeply on both sides by code point, whatever order they were built in', () => {
    // The astral keys are the ones that tell code-point order from UTF-16 code-unit order: a
    // surrogate pair sorts before U+E000 by code point and after it by code unit.
    const built = {
      z: 1,
      '\uE000': 2,
      '𝄞': 3,
      a: { 中: 'zh', Z: 'upper', a: 'lower' },
      B: [3, 1, 2],
    };
    const reordered = { B: [3, 1, 2], a: { a: 'lower', Z: 'upper', 中: 'zh' }, '𝄞': 3, '\uE000': 2, z: 1 };
    const { engine, pool } = both(built);
    expect(pool).toEqual(engine);
    // Building the same table in another order lands the same bytes.
    expect([...engineBytes(reordered)]).toEqual(engine);
    expect(Buffer.from(engine).toString('utf8').indexOf('"B"')).toBeLessThan(
      Buffer.from(engine).toString('utf8').indexOf('"a"'),
    );
  });

  it('integers and decimals: both sides spell numbers the way JSON does, the same way', () => {
    const value = {
      table: [
        { whole: 0, negative: -12, large: 1234567890123, fraction: 1.5, tiny: 0.0001, exact: 2.0 },
      ],
    };
    const { engine, pool } = both(value);
    expect(pool).toEqual(engine);
    const text = Buffer.from(engine).toString('utf8');
    // 2.0 is one JS number: both sides write `2`, never `2.0`.
    expect(text).toContain('"exact": 2,');
    expect(text).toContain('"fraction": 1.5');
  });

  it('the empty table: an empty pool encodes to the same bytes, with no trailing newline', () => {
    const emptyPool = { version: 1, issues: {} };
    const { engine, pool } = both(emptyPool);
    expect(pool).toEqual(engine);
    expect(Buffer.from(engine).toString('utf8')).toBe('{\n  "issues": {},\n  "version": 1\n}');

    // The bare empty table, and an empty value nested inside an array: nothing is added around them.
    const bare = both({});
    expect(bare.pool).toEqual(bare.engine);
    expect(Buffer.from(bare.engine).toString('utf8')).toBe('{}');
    const nested = both({ rows: [{}, []] });
    expect(nested.pool).toEqual(nested.engine);
  });
});

describe('the moment: the pool and the engine spell one epoch reading the same way', () => {
  it('one batch of epoch-microsecond readings comes out to the same string on both sides', () => {
    // A spread of readings: the epoch itself, the first microsecond, the millisecond rollovers, a
    // real wall-clock stamp, and one whose tail is not zero in all six digits.
    const batch = [0, 1, 999, 1000, 1001, 1234567, 1767225600000000, 1767225600123456, 2000000000123456];
    for (const epochUs of batch) {
      expect(String((poolMicroTimestampOf as (us: number) => string)(epochUs)), String(epochUs))
        .toBe(String(engineMicroTimestampOf(epochUs)));
    }
  });

  it('the pool writes that shape: six fractional digits, a literal Z, and both stamps of one record are it', () => {
    // The shape `discovered` / `updated_at` take on disk (the command surface's own test pins the two
    // stamps of one write; this pins the spelling the two implementations agree on).
    expect(poolNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });
});