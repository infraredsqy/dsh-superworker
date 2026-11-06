import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLedgerInitialized } from '../src/initledger';
import { open } from '../src/open';
import { pfPaths } from '../src/paths';

/**
 * init without git: the bottom line, and the degraded attachments.
 *
 * Whatever the environment — no git, not a checkout, a `.git` nobody can ask about — `init` lays the
 * four layout files down and the directory is a pf workspace when it returns. The four layout files
 * are LF on every platform (machine-read bytes must match across machines), the engine creates no
 * repository of `.pf`'s own, and every attachment that did not happen is one sentence of `warnings`
 * instead of an exception.
 */

/** The expected bytes of `.pf/.gitignore` (the init constant verbatim, LF). */
const GITIGNORE = [
  "# This tool's own machinery: where dispatch lands, worktrees, the temp files a node produces.",
  'meta/',
  'worktrees/',
  'temp/',
  '',
].join('\n');

/** The expected bytes of `.pf/.gitattributes`: the line endings are ours, and records merge by record. */
const GITATTRIBUTES = [
  "# The line endings of these files are ours: every record is written with LF, and no machine's",
  '# core.autocrlf has any business rewriting that.',
  '** -text',
  '',
  '# Records merge entry-wise, not line by line; the driver is pf-merge-ledger, and that command is',
  "# registered in each machine's git config (ledger.register).",
  'ideas.json merge=pf',
  'state.json merge=pf',
  'instructions.json merge=pf',
  'signals/** merge=pf',
  '',
].join('\n');

const LAYOUT_FILES = ['.gitignore', '.gitattributes', 'AGENTS.md', 'config.json'];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-init-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

describe('ledger.init: the bottom line holds in an environment without git', () => {
  it('the four layout files land, LF on every platform, and no repository of .pf is created', async () => {
    const pf = open(root);
    const report = await pf.ledger.init();
    expect(report.layout).toBe('own-repo');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(readFileSync(join(root, '.pf', '.gitignore'), 'utf8')).toBe(GITIGNORE);
    expect(readFileSync(join(root, '.pf', '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES);
    // The one byte rule of a record (`src/jsonio.ts`): no trailing newline, so what init lands here and
    // what `config.set` rewrites later are the same bytes for the same document.
    expect(readFileSync(join(root, '.pf', 'config.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(root, '.pf', 'AGENTS.md'), 'utf8')).toContain('# .pf usage note');
    for (const name of LAYOUT_FILES) {
      expect(readFileSync(join(root, '.pf', name), 'utf8'), name).not.toContain('\r\n');
    }
    expect(existsSync(join(root, '.pf', '.git'))).toBe(false);
    expect(existsSync(join(root, '.pf', 'nodes'))).toBe(false);
  });

  it('the directory is a pf workspace afterwards: the engine recognises it and doctor has no complaint', async () => {
    const pf = open(root);
    await pf.ledger.init();
    expect(isLedgerInitialized(pfPaths(root))).toBe(true);
    const records = (await pf.conductor.doctor()).checks.find((check) => check.name === 'records')!;
    expect(records.ok).toBe(true);
    expect(records.detail).toContain('all in place');
  });

  it('each attachment it could not do is one sentence of warnings, and init still resolves', async () => {
    const pf = open(root);
    const report = await pf.ledger.init();
    expect(report.ownRepo).toBe('skipped-no-git');
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.warnings).toHaveLength(3);
    for (const line of report.warnings) {
      expect(line.endsWith('.')).toBe(true);
      expect(line.length).toBeGreaterThan(20);
    }
    const said = report.warnings.join('\n');
    expect(said).toContain('git init .pf');
    expect(said).toContain('info/exclude');
    expect(said).toContain('merge driver');
  });

  it('a `.git` directory on disk that nobody can ask about: "not a checkout", never guessed from the shape', async () => {
    // The cell "the project is a checkout on disk, and git cannot answer": a real `.git` directory
    // is there, no runner was handed in, so nothing may be inferred from the directory's shape —
    // and nothing of that directory is touched.
    const gitDir = join(root, '.git');
    mkdirSync(join(gitDir, 'objects'), { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const headBefore = readFileSync(join(gitDir, 'HEAD'), 'utf8');

    const pf = open(root);
    const report = await pf.ledger.init();
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.ownRepo).toBe('skipped-no-git');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(readFileSync(join(gitDir, 'HEAD'), 'utf8')).toBe(headBefore);
    // No runner means no `git init .pf` can be run either: the asked-for repository stays a reading and
    // an advice, and no `.pf/.git` appears.
    expect(existsSync(join(root, '.pf', '.git'))).toBe(false);
    expect(readFileSync(join(root, '.pf', '.gitignore'), 'utf8')).toBe(GITIGNORE);
  });

  it('a `.git` pointer file (a linked worktree) with no runner: the same reading, and the pointer is not followed', async () => {
    // The other shape a checkout takes on disk: a `.git` file naming the real directory. Without a
    // runner the engine still does not read that line — git knows where the checkout is, not this
    // engine — so the reading is the same, and the pointer file keeps its bytes.
    const pointer = 'gitdir: /somewhere/else/.git/worktrees/w\n';
    writeFileSync(join(root, '.git'), pointer, 'utf8');

    const report = await open(root).ledger.init();
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.ownRepo).toBe('skipped-no-git');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(readFileSync(join(root, '.git'), 'utf8')).toBe(pointer);
    expect(existsSync(join(root, '.pf', '.git'))).toBe(false);
  });

  it('idempotent: a second run writes nothing at all and changes no byte', async () => {
    const pf = open(root);
    await pf.ledger.init();
    const before = hashTree(join(root, '.pf'));
    const second = await pf.ledger.init();
    expect(second.written).toEqual([]);
    expect(hashTree(join(root, '.pf'))).toBe(before);
  });

  it('nothing to land: a run with config.json in place takes no lock and answers at once', async () => {
    const pf = open(root);
    await pf.ledger.init();
    const pfDir = join(root, '.pf');
    // A lock file nobody holds: taking the lock would mean waiting out the whole ten-second limit.
    const lock = join(pfDir, 'meta', 'ledger.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '', 'utf8');

    const started = Date.now();
    const second = await pf.ledger.init();
    const elapsedMs = Date.now() - started;

    expect(second.written).toEqual([]);
    expect(elapsedMs).toBeLessThan(2_000);
    // The lock was never taken: the stale file is still exactly where the dead holder left it.
    expect(existsSync(lock)).toBe(true);
  });

  it('only what is broken is rewritten: a hand-broken layout file is repaired by the next run', async () => {
    const pf = open(root);
    await pf.ledger.init();
    const pfDir = join(root, '.pf');
    writeFileSync(join(pfDir, '.gitignore'), '被人改坏了\n', 'utf8');
    writeFileSync(join(pfDir, 'AGENTS.md'), '被人改坏了\n', 'utf8');
    const repaired = await pf.ledger.init();
    expect(repaired.written.sort()).toEqual(['.gitignore', 'AGENTS.md'].sort());
    expect(readFileSync(join(pfDir, '.gitignore'), 'utf8')).toBe(GITIGNORE);
    expect(readFileSync(join(pfDir, 'AGENTS.md'), 'utf8')).toContain('# .pf usage note');
  });

  it('a layout file deleted by hand comes back; the rest is left alone', async () => {
    const pf = open(root);
    await pf.ledger.init();
    const pfDir = join(root, '.pf');
    rmSync(join(pfDir, '.gitattributes'));
    const repaired = await pf.ledger.init();
    expect(repaired.written).toEqual(['.gitattributes']);
    expect(readFileSync(join(pfDir, '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES);
  });

  it('config.json written by hand is never cleared by default; only force resets it, and both modes are idempotent', async () => {
    const pf = open(root);
    await pf.ledger.init();
    const pfDir = join(root, '.pf');
    writeFileSync(join(pfDir, 'config.json'), '{"my_knob": 42}\n', 'utf8');
    const untouched = await pf.ledger.init();
    expect(readFileSync(join(pfDir, 'config.json'), 'utf8')).toBe('{"my_knob": 42}\n');
    expect(untouched.written).toEqual([]);

    const forced = await pf.ledger.init({ force: true });
    expect(readFileSync(join(pfDir, 'config.json'), 'utf8')).toBe('{}');
    expect(forced.written).toEqual(['config.json']);
    const before = hashTree(pfDir);
    await pf.ledger.init({ force: true });
    expect(hashTree(pfDir)).toBe(before);
  });

  it('the in-repo layout is the same bottom line without git: layout written, exclude skipped', async () => {
    const pf = open(root);
    const report = await pf.ledger.init({ layout: 'in-repo' });
    expect(report.layout).toBe('in-repo');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(existsSync(join(root, '.pf', '.git'))).toBe(false);
    expect(readFileSync(join(root, '.pf', '.gitignore'), 'utf8')).toBe(GITIGNORE);
  });
});

/** Hash of the whole tree (relative path + content fed to sha256 one after another); the measure of byte-level idempotency. */
function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else {
        hash.update(`${prefix}${name}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}
