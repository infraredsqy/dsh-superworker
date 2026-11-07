import { describe, expect, it } from 'vitest';
import { jsonBytes, jsonOptionsForRecord } from '../src/jsonio.ts';

/**
 * The bytes of one record on disk: two-space indent, key order, CJK passed through untouched,
 * escapes, **LF on every platform** (machine-read bytes must be the same whichever machine wrote
 * them), no trailing newline. Every expected string is written out by hand and pinned character by
 * character; the EOL is LF even on Windows, which pins the rule "the line endings of a record are
 * not the platform's".
 */

const eol = '\n';

function asText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

describe('the bytes of one record on disk', () => {
  it('six-key handoff: construction order, CJK unescaped, LF on every platform, no trailing newline', () => {
    const signal = {
      cycle: 'superworker-core',
      node: '607bf501-71c9-495d-a3f7-052911bb01f8',
      status: 'completed',
      summary: '收线：底座全绿，格式逐字节对上期望',
      outputs: {
        deliverable: 'src/jsonio.ts',
        notes: ['键序照构造次序落盘', '中文原样，读得懂'],
      },
      timestamp: '2026-11-02T06:53:24Z',
    };
    const lines = [
      '{',
      '  "cycle": "superworker-core",',
      '  "node": "607bf501-71c9-495d-a3f7-052911bb01f8",',
      '  "status": "completed",',
      '  "summary": "收线：底座全绿，格式逐字节对上期望",',
      '  "outputs": {',
      '    "deliverable": "src/jsonio.ts",',
      '    "notes": [',
      '      "键序照构造次序落盘",',
      '      "中文原样，读得懂"',
      '    ]',
      '  },',
      '  "timestamp": "2026-11-02T06:53:24Z"',
      '}',
    ];
    const actual = asText(jsonBytes(signal));
    expect(actual).toBe(lines.join(eol));
    expect(actual.endsWith(eol)).toBe(false);
  });

  it('deep key sorting (the writer rule for ideas / issues): outer records, inner records and keys all reordered by code point', () => {
    const ideas = {
      nodes: {
        'bbbbbbbb-0002': {
          title: 'line',
          updated_at: '2026-11-02T05:13:15.136229Z',
          status: 'todo',
          mode: 'auto',
          created_at: '2026-11-02T05:05:43.523342Z',
          dependencies: ['cccccccc-0003'],
          description: 'one line',
        },
        'aaaaaaaa-0001': {
          weight: 'light',
          title: 'parity corpus',
          status: 'todo',
          mode: 'auto',
          created_at: '2026-11-02T05:05:37.109922Z',
          dependencies: [],
          description: 'one corpus',
        },
      },
    };
    const lines = [
      '{',
      '  "nodes": {',
      '    "aaaaaaaa-0001": {',
      '      "created_at": "2026-11-02T05:05:37.109922Z",',
      '      "dependencies": [],',
      '      "description": "one corpus",',
      '      "mode": "auto",',
      '      "status": "todo",',
      '      "title": "parity corpus",',
      '      "weight": "light"',
      '    },',
      '    "bbbbbbbb-0002": {',
      '      "created_at": "2026-11-02T05:05:43.523342Z",',
      '      "dependencies": [',
      '        "cccccccc-0003"',
      '      ],',
      '      "description": "one line",',
      '      "mode": "auto",',
      '      "status": "todo",',
      '      "title": "line",',
      '      "updated_at": "2026-11-02T05:13:15.136229Z"',
      '    }',
      '  }',
      '}',
    ];
    expect(asText(jsonBytes(ideas, { sortKeys: true }))).toBe(lines.join(eol));
  });

  it('sorted by code point: U+FFFD before a supplementary-plane character, where UTF-16 code-unit order gets this pair backwards', () => {
    const value = { '\u{10000}': 1, '\uFFFD': 2 };
    const lines = ['{', '  "\uFFFD": 2,', '  "\u{10000}": 1', '}'];
    expect(asText(jsonBytes(value, { sortKeys: true }))).toBe(lines.join(eol));
  });

  it('empty arrays and objects collapse onto one line; a newline inside an escape stays as it is, not rewritten to the platform EOL', () => {
    const value = { empty_list: [], empty_map: {}, nested: [[]], text: 'first line\nsecond line\tindent' };
    const lines = [
      '{',
      '  "empty_list": [],',
      '  "empty_map": {},',
      '  "nested": [',
      '    []',
      '  ],',
      `  "text": "first line\\nsecond line\\tindent"`,
      '}',
    ];
    expect(asText(jsonBytes(value))).toBe(lines.join(eol));
  });

  it('key order across the six record kinds: the pool and the graph sort their keys, the rest keep construction order', () => {
    expect(jsonOptionsForRecord('ideas')).toEqual({ sortKeys: true });
    expect(jsonOptionsForRecord('issues')).toEqual({ sortKeys: true });
    for (const record of ['state', 'instructions', 'signal', 'session-note'] as const) {
      expect(jsonOptionsForRecord(record)).toEqual({});
    }
  });
});
