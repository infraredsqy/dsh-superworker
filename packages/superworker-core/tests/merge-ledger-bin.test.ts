import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'tsdown';
import type { MergeDriverIo, MergeDriverRequest } from '../src/ledgermerge/driver';

/**
 * The package's only process entry (`src/merge-ledger-bin.ts`, product `dist/merge-ledger.mjs`).
 *
 * The file is a shell in the strict sense: it maps git's four arguments, takes `--dry-run` out
 * wherever it sits, hands the driver's exit code back out through `process.exitCode`, and carries
 * the shebang the build injects as its first bytes. Not one merge rule lives there, and nothing
 * else in the suite executes or asserts this mapping — a `line.slice(1)` slip or a lost build
 * banner would otherwise leave the whole suite green.
 *
 * The ending is the one behaviour with a failure mode of its own: `process.exit` stops the process
 * on the spot and can cut off verdict bytes still queued in the stdout / stderr pipes, so the shell
 * sets `process.exitCode` and lets the event loop drain instead. The in-process runs below pin the
 * mapping (argv in, exit code out, `process.exit` never called); the last describe drives the real
 * built product as a real process on real pipes — no mock on the writes — and holds the verdict to
 * arrive complete.
 *
 * The test drives the real module: `process.argv` is set as git would, the driver itself is mocked
 * so the assertion is about the shell, not about a merge.
 */

vi.mock('../src/ledgermerge/driver', () => ({ runMergeDriver: vi.fn() }));

/** Thrown by the intercepted `process.exit`: the shell must never reach it any more. */
class ExitCalled extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

interface ShellOutcome {
  /** The codes handed to `process.exit`, in order — always empty now: the shell ends by falling off the end. */
  readonly exits: number[];
  /** The exit code the shell left on `process.exitCode` (undefined when the run crashed). */
  readonly exitCode: number | null | undefined;
  /** The request handed to the driver; undefined when the shell refused before calling it. */
  readonly request: MergeDriverRequest | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

/** Run the real shell once with these process arguments, and a driver that answers `verdict`. */
async function runShell(args: readonly string[], verdict = 0): Promise<ShellOutcome> {
  vi.restoreAllMocks();
  vi.resetModules();
  const exits: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process, 'exit').mockImplementation((code?: number): never => {
    exits.push(code ?? 0);
    throw new ExitCalled(code ?? 0);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string): boolean => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string): boolean => {
    stderr.push(String(chunk));
    return true;
  });
  const driver = await import('../src/ledgermerge/driver');
  let request: MergeDriverRequest | undefined;
  (driver.runMergeDriver as unknown as { mockImplementation(fn: unknown): void }).mockImplementation(
    async (received: MergeDriverRequest, io: MergeDriverIo) => {
      request = received;
      io.stdout('driver answered\n');
      return verdict;
    },
  );
  process.argv = ['node', 'merge-ledger.mjs', ...args];
  const previousExitCode = process.exitCode;
  let exitCode: number | null | undefined;
  let failed: unknown;
  try {
    process.exitCode = undefined;
    await import('../src/merge-ledger-bin.ts');
    exitCode = process.exitCode;
  } catch (error) {
    // The intercepted exit is not how the shell ends any more; anything thrown inside is a real
    // failure of the shell.
    if (!(error instanceof ExitCalled)) failed = error;
  } finally {
    process.exitCode = previousExitCode;
  }
  if (failed !== undefined) throw failed;
  return { exits, exitCode, request, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('the process entry: argv in, exit code out', () => {
  it("git's four arguments land as base / ours / theirs / path, in that order, and the verdict is carried out", async () => {
    const run = await runShell(['/sides/O', '/sides/A', '/sides/B', '.superworker/ideas.json']);
    expect(run.request).toEqual({
      base: '/sides/O',
      ours: '/sides/A',
      theirs: '/sides/B',
      path: '.superworker/ideas.json',
    });
    expect(run.exitCode).toBe(0);
    // The ending is a fall off the end: process.exit is the call that can cut queued pipe writes.
    expect(run.exits).toEqual([]);
    // The io the shell hands over really points at this process's streams.
    expect(run.stdout).toContain('driver answered');
  });

  it('--dry-run is taken out wherever it sits, and the fourth argument is still the path', async () => {
    const first = await runShell(['--dry-run', '/sides/O', '/sides/A', '/sides/B', '.superworker/ideas.json']);
    expect(first.request).toEqual({
      base: '/sides/O',
      ours: '/sides/A',
      theirs: '/sides/B',
      path: '.superworker/ideas.json',
      dryRun: true,
    });
    const middle = await runShell(['/sides/O', '--dry-run', '/sides/A', '/sides/B', '.superworker/state.json']);
    expect(middle.request).toEqual({
      base: '/sides/O',
      ours: '/sides/A',
      theirs: '/sides/B',
      path: '.superworker/state.json',
      dryRun: true,
    });
  });

  it('an empty %P is left out, so the record tree is located by the walk up rather than from an empty path', async () => {
    const run = await runShell(['/sides/O', '/sides/A', '/sides/B', '']);
    expect(run.request).toEqual({ base: '/sides/O', ours: '/sides/A', theirs: '/sides/B' });
    expect(run.exitCode).toBe(0);
  });

  it('fewer than three arguments is a usage error: exit code 2, the usage line, the driver never called', async () => {
    for (const argv of [[], ['/sides/O'], ['/sides/O', '/sides/A']]) {
      const run = await runShell(argv);
      expect(run.exitCode, `argv ${JSON.stringify(argv)}`).toBe(2);
      expect(run.exits, `argv ${JSON.stringify(argv)}`).toEqual([]);
      expect(run.request).toBeUndefined();
      expect(run.stderr).toContain('git hands a merge driver four arguments (%O %A %B %P');
    }
  });

  it("the driver's exit code is carried out unchanged: 1 and 2 are not flattened to 0", async () => {
    const conflict = await runShell(['/sides/O', '/sides/A', '/sides/B', '.superworker/ideas.json'], 1);
    expect(conflict.exitCode).toBe(1);
    const usage = await runShell(['/sides/O', '/sides/A', '/sides/B', '.superworker/ideas.json'], 2);
    expect(usage.exitCode).toBe(2);
  });
});

/**
 * The verdict reaches stderr whole: the real built product, run as a real process, on real pipes.
 * The writes are not mocked here — that is the point. A conflict of a few hundred fields produces
 * far more stderr than a pipe accepts at once, so the bytes queue in the stream and only an ending
 * that lets the event loop drain delivers them all; the old `process.exit` ending truncated the
 * tail. The product is built fresh into a temporary directory, so the case never depends on a
 * checkout having run `pnpm build`, and never reads a stale `dist/`.
 */

const CONFLICT_NODES = 2000;

const entrySource = fileURLToPath(new URL('../src/merge-ledger-bin.ts', import.meta.url));

let productDir: string | undefined;
let product: string;

/** One ideas.json side: `CONFLICT_NODES` nodes, each node's title changed the same way on ours and theirs. */
function conflictSide(title: (index: number) => string): string {
  const nodes: Record<string, unknown> = {};
  for (let index = 0; index < CONFLICT_NODES; index += 1) {
    nodes[`${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`] = {
      created_at: '2026-02-01T00:00:00.000000Z',
      dependencies: [],
      description: 'the same description on every side',
      mode: 'auto',
      status: 'todo',
      title: title(index),
      updated_at: '2026-02-01T01:00:00.000000Z',
    };
  }
  return JSON.stringify({ nodes }, null, 2);
}

interface RealRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the built product as a real process with pipes, and collect the streams until it is gone. */
function runProduct(args: readonly string[], cwd: string): Promise<RealRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [product, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  productDir = mkdtempSync(join(tmpdir(), 'superworker-bin-product-'));
  await build({
    config: false,
    entry: { 'merge-ledger': entrySource },
    outDir: productDir,
    banner: '#!/usr/bin/env node\n',
    dts: false,
    clean: true,
  });
  product = join(productDir, 'merge-ledger.mjs');
});

afterAll(() => {
  if (productDir !== undefined) rmSync(productDir, { recursive: true, force: true });
});

describe('the verdict reaches stderr whole: the real product on real pipes', () => {
  it('a conflict verdict arrives complete: every conflict line and the closing line, exit 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'superworker-bin-conflict-'));
    try {
      const base = join(root, 'base.json');
      const ours = join(root, 'ours.json');
      const theirs = join(root, 'theirs.json');
      writeFileSync(base, conflictSide((index) => `original title ${index}`), 'utf8');
      writeFileSync(ours, conflictSide((index) => `A-side title ${index}`), 'utf8');
      writeFileSync(theirs, conflictSide((index) => `B-side title ${index}`), 'utf8');
      // The child runs in the temporary root: even a scene that turned out clean has no record
      // tree to find there, so nothing outside the temp dir can be locked or written.
      const run = await runProduct([base, ours, theirs, '.superworker/ideas.json'], root);
      expect(run.code).toBe(1);
      const lines = run.stderr.split('\n');
      // The verdict ends with its newline: nothing was cut mid-line.
      expect(lines[lines.length - 1]).toBe('');
      const verdict = lines.slice(0, -1);
      // One line per conflicted field, plus the closing line — nothing dropped from the middle.
      expect(verdict).toHaveLength(CONFLICT_NODES + 1);
      for (const line of verdict.slice(0, -1)) {
        expect(line).toMatch(
          /^merge-ledger: conflict \[\.superworker\/ideas\.json\] Node \d{8} field title: ours="A-side title \d+" theirs="B-side title \d+"( \([^)]+\))?$/,
        );
      }
      const closing = verdict[verdict.length - 1]!;
      expect(closing.startsWith(`merge-ledger: ${CONFLICT_NODES} places need a human decision; `)).toBe(true);
      expect(closing.endsWith('carry on.')).toBe(true);
      // A conflict writes nothing and says nothing on stdout: the verdict is stderr's alone.
      expect(run.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a usage error from a real process: the usage line arrives whole, exit 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'superworker-bin-usage-'));
    try {
      const run = await runProduct([], root);
      expect(run.code).toBe(2);
      expect(run.stderr.startsWith('sw-merge-ledger: git hands a merge driver four arguments')).toBe(true);
      expect(run.stderr.endsWith('in the repository)\n')).toBe(true);
      expect(run.stderr.split('\n').filter((line) => line !== '')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the product the build emits', () => {
  it('the build injects the node shebang as the product\'s first bytes, and the bin entry names it', async () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const config = (await import('../tsdown.config')).default;
    const entries = Array.isArray(config) ? config : [config];
    const product = entries.find((entry: Record<string, unknown>) => {
      const spellings = Array.isArray(entry.entry) ? entry.entry : [entry.entry];
      return spellings.some(
        (spelling) =>
          spelling !== null &&
          typeof spelling === 'object' &&
          Object.keys(spelling as Record<string, unknown>).includes('merge-ledger'),
      );
    });
    expect(product, 'the tsdown config has no merge-ledger entry').toBeDefined();
    expect(String((product as Record<string, unknown>).banner)).toBe('#!/usr/bin/env node\n');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    const target = pkg.bin['sw-merge-ledger']!;
    expect(target).toBe('./dist/merge-ledger.mjs');
    // When a build has run, the injected line really is the product's first bytes: '#' first, no
    // byte order mark. (A clone that has never built has no product; the banner above is still
    // pinned, so a change to the injection cannot pass unnoticed.)
    const productPath = join(repoRoot, target.replace(/^\.\//, ''));
    if (existsSync(productPath)) {
      const bytes = readFileSync(productPath);
      expect(bytes.subarray(0, 20).toString('utf8')).toBe('#!/usr/bin/env node\n');
      expect(bytes[0]).toBe(0x23);
    }
  });
});
