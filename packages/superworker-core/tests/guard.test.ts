import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source guard: the engine's purity boundary.
 *
 * - src carries no wording about a host or about the network; execution can only come in through
 *   the injected executor seam.
 * - the source tree holds no .py file: there is only TypeScript here.
 * - the shape of the package: private, zero runtime dependencies, build and test depending only on
 *   typescript / tsdown / vitest, and **exactly one process entry** — `sw-merge-ledger`, the command
 *   git calls as a merge driver. A command surface (subcommands, a route table, install-time
 *   scripts) stays forbidden; a `bin/` directory stays forbidden too (checked below, directly on the
 *   tree).
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
const srcAndTestFiles = [...srcFiles, ...listFiles(join(repoRoot, 'tests')).filter((f) => f.endsWith('.ts'))];

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

describe('source tree guard', () => {
  it('there is no .py file under src or tests', () => {
    const py = srcAndTestFiles.filter((f) => f.toLowerCase().endsWith('.py'));
    expect(py).toEqual([]);
  });

  it('the repo root has no bin dir', () => {
    expect(existsSync(join(repoRoot, 'bin'))).toBe(false);
  });
});

describe('one spelling per fact', () => {
  it('the plugins layer does not spell the spec file name itself (the layout belongs to paths.ts)', () => {
    // `paths.nodeSpecPath` is the one home of that spelling; a reader or writer of the node's requirements
    // takes the location from it, so the path an offer is told about and the file the text lands on cannot
    // drift apart.
    const offenders = srcFiles
      .filter((file) => /[\\/]plugins[\\/]/.test(file))
      .filter((file) => /['"]spec\.md['"]/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the plugin registry is a barrel: the readers of a declaration live in their own modules', () => {
    // Five jobs used to share one file (the scan and the loader, the closed-set validation, the merged
    // tables, the command words, doctor's strict face), so changing one meant walking through the other
    // four. The names stay re-exported from `registry.ts`, and no reader is implemented here.
    const text = readFileSync(join(repoRoot, 'src', 'plugins', 'registry.ts'), 'utf8');
    expect(text).not.toMatch(/^(?:export )?(?:async )?function /mu);
    expect(text).not.toMatch(/^export (?:const|let|class|interface) /mu);
    expect(text).not.toMatch(/^export type [A-Za-z_$]/mu);
  });
});

describe('package shape guard (package.json)', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    private?: boolean;
    bin?: unknown;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('a private package with exactly one process entry: never published', () => {
    expect(pkg.private).toBe(true);
    // One entry, and only one: `sw-merge-ledger`, answered by the built product of
    // `src/merge-ledger-bin.ts`. A second key would be a command surface.
    const entries = pkg.bin as Record<string, unknown> | undefined;
    expect(Object.keys(entries ?? {})).toEqual(['sw-merge-ledger']);
    expect(String(entries?.['sw-merge-ledger'])).toBe('./dist/merge-ledger.mjs');
  });

  it('zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('build and test depend on typescript / tsdown / vitest only', () => {
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(['tsdown', 'typescript', 'vitest']);
  });

  it('no install-time lifecycle scripts (postinstall and the like)', () => {
    const scripts = Object.keys(pkg.scripts ?? {});
    const lifecycle = scripts.filter((s) =>
      ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'prepack', 'postpack'].includes(s),
    );
    expect(lifecycle).toEqual([]);
  });
});
