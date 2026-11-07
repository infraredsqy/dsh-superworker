import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `conduct-state.md` ships twice: once per language under `sw-conduct/docs/`. The route skill's own
 * copies are gone — its pages point back to the conduct skill's page (`../sw-conduct/docs/conduct-state.md`),
 * so the doctrine has one source per language and every other skill reads it there.
 *
 * What still needs a hold: the page must exist where every pointer says it is. Deduplicating the copies
 * turned a drifting-pair problem into a dangling-pointer problem — a move or a rename that forgets one
 * of the pointers used to stay green; this test walks the pointers, so a link left pointing at a page
 * that is not there is red here rather than a dead reference somebody has to notice by reading.
 */

const PLUGINS = fileURLToPath(new URL('../plugins', import.meta.url));
const SKILLS = join(PLUGINS, 'pipeline', 'skills');

/** Every markdown file under a directory, deepest first is not needed — the order only feeds the failure messages. */
function markdownFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdownFilesUnder(path, out);
    else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

/** The markdown-link targets of one file that name the conduct-state page (relative pointers, no scheme, no bare anchor). */
function conductStateLinksOf(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1]!.trim();
    if (!target.includes('conduct-state.md')) continue;
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) continue;
    targets.push(target);
  }
  return targets;
}

describe('the conduct-state page is one page per language, and every pointer to it lands on it', () => {
  for (const lang of ['zh', 'en']) {
    it(`${lang}: sw-conduct/docs carries the page, non-empty`, () => {
      const page = join(SKILLS, lang, 'sw-conduct', 'docs', 'conduct-state.md');
      expect(existsSync(page), `${lang}: the page exists at sw-conduct/docs/`).toBe(true);
      expect(readFileSync(page).length, `${lang}: the page is not empty`).toBeGreaterThan(0);
    });
  }

  it('every relative markdown link naming conduct-state.md resolves to the page on disk', () => {
    const dangling: string[] = [];
    for (const file of markdownFilesUnder(PLUGINS)) {
      const text = readFileSync(file, 'utf8');
      for (const target of conductStateLinksOf(text)) {
        const resolved = resolve(dirname(file), target.split('#')[0]!);
        if (!existsSync(resolved)) dangling.push(`${file} -> ${target}`);
      }
    }
    expect(
      dangling,
      'each pointer names a page that is there: sw-conduct/docs/conduct-state.md per language is the one source',
    ).toEqual([]);
  });

  it('the pointers really cross skills: the route skill reads the conduct page, not a copy of its own', () => {
    for (const lang of ['zh', 'en']) {
      const route = readFileSync(join(SKILLS, lang, 'sw-route', 'SKILL.md'), 'utf8');
      expect(route, `${lang}: sw-route points back to the conduct page`).toContain('../sw-conduct/docs/conduct-state.md');
      expect(existsSync(join(SKILLS, lang, 'sw-route', 'docs', 'conduct-state.md')), `${lang}: no local copy anymore`).toBe(false);
    }
  });
});
