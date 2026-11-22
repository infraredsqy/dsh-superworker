import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source guard: the engine's purity boundary.
 *
 * - src carries no wording about a host or about the network; execution can only come in through
 *   the injected executor seam.
 *
 * Note: `\bspawn\b` matches whole words only -- an older record may still carry a `spawner` field,
 * written there by a different implementation of this pipeline; that field is data read tolerantly
 * and is not a policy key of this engine's. The bare verb spawn may not appear even once in the
 * code or the comments of the source.
 * **String literals do not count as source**: the plan the planning step hands back carries copied
 * call text (things like `dispatch <cycle>`), which is deliverable body, a sentence
 * for a reader, and has nothing to do with whether the engine launches processes; the shape that
 * really must be blocked -- a `spawn(` call -- is checked separately, before literals are stripped.
 * Writing the function name into a string key (`(process as any)['spawn'](...)`) is the same thing
 * in another shape: after stripping literals that key is gone, so the shape `['spawn']` /
 * `["spawn"]` is checked against the raw text as well.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const srcFiles = listFiles(join(repoRoot, 'src')).filter((f) => f.endsWith('.ts'));

const FORBIDDEN_LITERALS = ['@deepseek-ai/', 'session/create', 'session/prompt', '3080', '.py'];
const FORBIDDEN_WORDS = [/\bspawn\b/i];
/** The **code** shape of the path that launches a process: command text copied into a string does not count, a call does. */
const FORBIDDEN_CALLS = [/\bspawn\s*\(/, /\bchild_process\b/];
/**
 * The shape that reaches a function through a string key: `(process as any)['spawn'](...)`,
 * `process["spawn"]`. The key name sits inside a literal, so stripping literals makes it
 * invisible; that is why this is checked against the raw text together with `FORBIDDEN_CALLS`.
 */
const FORBIDDEN_KEYED_CALLS = [/\[\s*['"]spawn['"]\s*\]/i];

/** What the text looks like with string literals stripped: single quotes, double quotes and template strings (with `${}`) all fold into empty strings. */
function withoutStringLiterals(text: string): string {
  return text
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

describe('src content guard', () => {
  it('src carries no wording about a host or the network', () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      const lower = text.toLowerCase();
      for (const literal of FORBIDDEN_LITERALS) {
        if (lower.includes(literal)) offenders.push(`${file}: contains "${literal}"`);
      }
      for (const pattern of [...FORBIDDEN_CALLS, ...FORBIDDEN_KEYED_CALLS]) {
        if (pattern.test(text)) offenders.push(`${file}: contains call shape ${pattern}`);
      }
      const code = withoutStringLiterals(text);
      for (const pattern of FORBIDDEN_WORDS) {
        if (pattern.test(code)) offenders.push(`${file}: contains forbidden word ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src imports only relative paths and node: built-ins: zero outside dependencies', () => {
    // The base layer (shared record IO) needs disk IO to read and write records: node: built-ins
    // are part of the Node 26+ platform surface and fall under "zero runtime dependencies"; what is
    // blocked here is outside packages -- anything without a ./ ../ or node: prefix counts.
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.') && !spec.startsWith('node:')) offenders.push(`${file}: import '${spec}'`);
      }
      for (const m of text.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.') && !spec.startsWith('node:')) offenders.push(`${file}: import '${spec}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
