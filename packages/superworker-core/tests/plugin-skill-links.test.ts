import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Markdown links inside the bundled plugins' skills. A skill's pages may only point at files the
 * skill tree itself carries: a plugin installs and removes by folder, so when only one plugin is
 * installed its skills sit alone on a bare skills root and nothing outside the tree is there to
 * read. Both shapes are pinned here — the repo tree, and the same tree copied to a bare root.
 */

const pluginsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins');

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g;

function* markdownFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield path;
  }
}

/** Every relative link target in the tree's .md files that does not resolve to an existing file. */
function brokenRelativeLinks(skillsRoot: string): string[] {
  const broken: string[] = [];
  for (const file of markdownFiles(skillsRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = match[1] ?? '';
      const path = target.split('#')[0] ?? '';
      // Pure anchors, other schemes (https:, mailto:, …) and absolute paths are outside this invariant.
      if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) continue;
      if (!existsSync(join(dirname(file), path))) {
        broken.push(`${relative(skillsRoot, file).replaceAll('\\', '/')} -> ${target}`);
      }
    }
  }
  return broken;
}

describe('bundled plugins carry every file their skills link to', () => {
  it('every relative link in a plugin skills tree resolves to a file in the repo tree', () => {
    expect(brokenRelativeLinks(pluginsRoot)).toEqual([]);
  });

  it('the skills trees keep resolving when moved to a bare skills root, the shape they install as', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sw-skill-links-'));
    try {
      for (const plugin of readdirSync(pluginsRoot)) {
        const skills = join(pluginsRoot, plugin, 'skills');
        if (!statSync(skills, { throwIfNoEntry: false })?.isDirectory()) continue;
        cpSync(skills, join(bare, plugin, 'skills'), { recursive: true });
      }
      expect(brokenRelativeLinks(bare)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
