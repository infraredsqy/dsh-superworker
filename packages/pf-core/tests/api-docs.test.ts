import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as pfCore from '../src/index';

/** docs/api.md agrees with the export surface: every export name is cross-checked, and each frozen method name is named. */

const docs = readFileSync(fileURLToPath(new URL('../docs/api.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const FROZEN_METHODS = [
  'ledger.init', 'ledger.register',
  'ledger.dag.add', 'ledger.dag.remove', 'ledger.dag.update', 'ledger.dag.link',
  'ledger.dag.unlink', 'ledger.dag.setStatus', 'ledger.dag.approve', 'ledger.dag.revive',
  'ledger.dag.get', 'ledger.dag.info', 'ledger.dag.context', 'ledger.dag.search', 'ledger.dag.list',
  'ledger.dag.specPath', 'ledger.dag.validate',
  'ledger.cycles.create', 'ledger.cycles.start', 'ledger.cycles.rename',
  'ledger.cycles.setStatus', 'ledger.cycles.setPolicy', 'ledger.cycles.list',
  'ledger.cycles.current', 'ledger.cycles.show', 'ledger.cycles.hold',
  'ledger.cycles.close', 'ledger.cycles.retry',
  'ledger.instructions.add', 'ledger.instructions.list', 'ledger.instructions.resolve',
  'ledger.instructions.revive', 'ledger.instructions.remove',
  'config.get', 'config.set', 'config.unset', 'config.list',
  'sessions.list', 'sessions.show', 'sessions.note',
  'conductor.next', 'conductor.prepare', 'conductor.settle', 'conductor.dispatch', 'conductor.handoff',
  'conductor.close', 'conductor.advance',
  'conductor.doctor',
];

describe('docs/api.md agrees with the export surface', () => {
  it('the "runtime exports" block equals the actual package exports one by one', () => {
    const block = docs.match(/## 运行时导出\s*\n+```text\n([\s\S]*?)```/);
    expect(block, 'docs/api.md needs a "## 运行时导出" section and a text code block').not.toBeNull();
    const documented = block![1]!.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    expect(documented).toEqual(Object.keys(pfCore).sort());
  });

  it('every frozen method name appears in the docs', () => {
    const missing = FROZEN_METHODS.filter((name) => !docs.includes(name));
    expect(missing).toEqual([]);
  });
});
