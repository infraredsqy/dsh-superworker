import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index';
import { open } from '../src/index';

/**
 * docs/api.md agrees with the package: every runtime export name is crossed with the actual exports, and
 * every verb the handle carries is one the document's tables name.
 *
 * The verb names are **read out of the document**, not copied into this file a second time: a hand-written
 * list here could go stale against the table (it did, by nine verbs once) and the assertion "every frozen
 * verb is documented" would keep passing over the gap. The one source is the tables' first column
 * (`` `ledger.dag.add` ``), and the comparison is the whole set — documented verbs = the verbs on the
 * handle, no name missing on either side.
 */

const docs = readFileSync(fileURLToPath(new URL('../docs/api.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** The verb rows of the document's tables: a first-column cell spelled `<namespace>.<verb>` (`ledger.init`, `conductor.next`, `config.get` …). */
function documentedVerbs(): string[] {
  const found = new Set<string>();
  const row = /^\|\s*`((?:ledger(?:\.(?:dag|cycles))?|config|sessions|conductor)\.[A-Za-z]\w*)`\s*\|/gm;
  for (const match of docs.matchAll(row)) found.add(match[1]!);
  return [...found].sort();
}

/** The verbs the handle really carries, in the same `<namespace>.<verb>` spelling. */
function handleVerbs(): string[] {
  const superworker = open('\\\\tmp\\superworker-api-docs-probe');
  const verbs: string[] = [];
  for (const [name, value] of Object.entries(superworker.ledger as unknown as Record<string, unknown>)) {
    if (typeof value === 'function') verbs.push(`ledger.${name}`);
  }
  const groups: ReadonlyArray<readonly [string, object]> = [
    ['ledger.dag', superworker.ledger.dag],
    ['ledger.cycles', superworker.ledger.cycles],
    ['config', superworker.config],
    ['sessions', superworker.sessions],
    ['conductor', superworker.conductor],
  ];
  for (const [prefix, namespace] of groups) {
    for (const name of Object.keys(namespace)) verbs.push(`${prefix}.${name}`);
  }
  return verbs.sort();
}

describe('docs/api.md agrees with the export surface', () => {
  it('the "runtime exports" block equals the actual package exports one by one', () => {
    const block = docs.match(/## 运行时导出\s*\n+```text\n([\s\S]*?)```/);
    expect(block, 'docs/api.md needs a "## 运行时导出" section and a text code block').not.toBeNull();
    const documented = block![1]!.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    expect(documented).toEqual(Object.keys(core).sort());
  });

  it('the verbs the document tables name are exactly the verbs the handle carries', () => {
    const documented = documentedVerbs();
    // A row the pattern does not recognise would silently shrink this set, so it has to have found the
    // frozen surface's own size rather than an empty or half-read table.
    expect(documented.length).toBeGreaterThan(50);
    expect(documented).toEqual(handleVerbs());
  });
});
