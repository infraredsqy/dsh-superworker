import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The material a plugin's skill hands to readers that lives outside that plugin's folder.
 *
 * A plugin is installed and removed by folder, so a skill that points into the `sw-conduct` skill
 * directory points into a folder that may not be there (only `issue`, or only `test-audit`, can be
 * installed). The two repairs this test pins:
 *
 * - `sw-issue-repair` hands every batch's Fix / Review a role card. Both cards now sit in the skill's
 *   own `subagent-prompts/` as copies, with a `README.md` beside them naming the originals, and this
 *   test keeps a copy byte for byte equal to the original in `sw-conduct` — an edit on either side is
 *   red here rather than two files quietly disagreeing.
 * - `sw-test-audit` borrows one section of `sw-conduct`'s `SKILL.md` (the test tier and the verification
 *   command). A section cannot be copied the way a card can, so the skill says where the original is
 *   and what to read instead when `sw-conduct` is not installed.
 */

const SHIPPED_ISSUE = fileURLToPath(new URL('../plugins/issue', import.meta.url));
const SHIPPED_AUDIT = fileURLToPath(new URL('../plugins/test-audit', import.meta.url));
const CONDUCT_SKILLS = fileURLToPath(new URL('../plugins/pipeline/skills', import.meta.url));

describe('the repair skill carries the cards it hands out, and says where they come from', () => {
  for (const lang of ['zh', 'en']) {
    it(`${lang}: fix.md and review.md sit in the skill's own folder, byte for byte the sw-conduct originals`, () => {
      for (const name of ['fix.md', 'review.md']) {
        const copy = join(SHIPPED_ISSUE, 'skills', lang, 'sw-issue-repair', 'subagent-prompts', name);
        const original = join(CONDUCT_SKILLS, lang, 'sw-conduct', 'subagent-prompts', name);
        expect(existsSync(copy), `${lang}/${name} is in the plugin folder`).toBe(true);
        expect(readFileSync(copy, 'utf8'), `${lang}/${name} is a copy of the original`).toBe(
          readFileSync(original, 'utf8'),
        );
      }
    });

    it(`${lang}: the note beside the copies and the skill's own sentence both name the originals`, () => {
      const folder = join(SHIPPED_ISSUE, 'skills', lang, 'sw-issue-repair');
      expect(existsSync(join(folder, 'subagent-prompts', 'README.md'))).toBe(true);
      const note = readFileSync(join(folder, 'subagent-prompts', 'README.md'), 'utf8');
      expect(note).toContain('sw-conduct');
      // The skill points at its own folder, not at a path under another plugin's directory.
      const skill = readFileSync(join(folder, 'SKILL.md'), 'utf8');
      expect(skill).toContain('subagent-prompts/fix.md');
      expect(skill).toContain('subagent-prompts/review.md');
      expect(skill).not.toContain('~/.dsh/skills/sw-conduct/');
    });
  }
});

describe('the test-audit skill names the sw-conduct section it borrows, and its stand-in', () => {
  for (const lang of ['zh', 'en']) {
    it(`${lang}: the borrowed section's home and the tier it falls back to are both written down`, () => {
      const skill = readFileSync(join(SHIPPED_AUDIT, 'skills', lang, 'sw-test-audit', 'SKILL.md'), 'utf8');
      // The original is named ...
      expect(skill).toContain('sw-conduct');
      // ... and so is the reading that does not need it.
      expect(skill).toContain('config get test_tier');
    });
  }
});

/** Every markdown file under one folder, as absolute paths. */
function markdownUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.md'))
    .map((entry) => join(folder, entry));
}

describe('the skills send the reader only to words this deployment ships', () => {
  it('no skill of these two plugins names a slash word nothing installs (`/engineering` was one)', () => {
    const files = [...markdownUnder(join(SHIPPED_ISSUE, 'skills')), ...markdownUnder(join(SHIPPED_AUDIT, 'skills'))];
    // Sanity: the scan really looks at something.
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('/engineering');
    }
  });
});
