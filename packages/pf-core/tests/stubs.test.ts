import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * No stub left on the surface: all fifty-seven verbs across the seven namespaces are methods, and
 * the source tree has no "not implemented yet" path either.
 * The probe handle's root is a made-up address; the assertions here touch only methods and source
 * text, and nothing lands on disk.
 */

const pf = open('\\\\tmp\\pf-surface-probe');

const SURFACE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['ledger', pf.ledger as unknown as Record<string, unknown>],
  ['ledger.dag', pf.ledger.dag as unknown as Record<string, unknown>],
  ['ledger.cycles', pf.ledger.cycles as unknown as Record<string, unknown>],
  ['ledger.instructions', pf.ledger.instructions as unknown as Record<string, unknown>],
  ['config', pf.config as unknown as Record<string, unknown>],
  ['sessions', pf.sessions as unknown as Record<string, unknown>],
  ['conductor', pf.conductor as unknown as Record<string, unknown>],
];

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (name.endsWith('.ts')) acc.push(path);
  }
  return acc;
}

describe('verbs on the handle', () => {
  it('seven namespaces, fifty-seven verbs, none missing', () => {
    let count = 0;
    for (const [, ns] of SURFACE) {
      for (const value of Object.values(ns)) {
        if (typeof value === 'function') count += 1;
      }
    }
    expect(count).toBe(3 + 16 + 13 + 5 + 5 + 3 + 13);
  });

  it("each level's verb names match the frozen surface", () => {
    const names = Object.fromEntries(
      SURFACE.map(([label, ns]) => [
        label,
        Object.entries(ns)
          .filter(([, value]) => typeof value === 'function')
          .map(([name]) => name)
          .sort(),
      ]),
    );
    expect(names).toEqual({
      ledger: ['cleanTemp', 'init', 'register'],
      'ledger.dag': [
        'add', 'addMany', 'approve', 'context', 'get', 'info', 'link', 'list', 'remove', 'revive',
        'search', 'setStatus', 'specPath', 'unlink', 'update', 'validate',
      ].sort(),
      'ledger.cycles': [
        'close', 'create', 'current', 'hold', 'list', 'policies', 'rename', 'retry',
        'setPolicy', 'setStatus', 'show', 'standing', 'start',
      ].sort(),
      'ledger.instructions': ['add', 'list', 'remove', 'resolve', 'revive'].sort(),
      config: ['get', 'keys', 'list', 'set', 'unset'].sort(),
      sessions: ['list', 'note', 'show'],
      conductor: [
        'advance', 'close', 'dispatch', 'dispatchPreview', 'doctor', 'handoff', 'handoffForm',
        'next', 'pluginCommand', 'pluginCommands', 'prepare', 'settle', 'settlePreview',
      ],
    });
  });
});

describe('no stubs left in the sources', () => {
  it('the single stub exit is gone: there is no stub.ts', () => {
    const names = sourceFiles(srcDir).map((path) => path.split(/[\\/]/).pop()!);
    expect(names).not.toContain('stub.ts');
  });

  it('the source tree has no "not implemented" path', () => {
    // The markers of an unimplemented path in the language the source is written in, plus the old Chinese
    // phrase so a stub written the old way cannot sneak back.
    const stubMarker = /not[\s_-]?implemented|unimplemented|尚未实现/i;
    const hits = sourceFiles(srcDir).filter((path) => stubMarker.test(readFileSync(path, 'utf8')));
    expect(hits).toEqual([]);
  });
});
