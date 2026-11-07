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
import { recordPaths } from '../src/paths';

/**
 * init without git: the bottom line, and the degraded attachments.
 *
 * Whatever the environment — no git, not a checkout, a `.git` nobody can ask about — `init` lays the
 * four layout files down and the directory is a superworker workspace when it returns. The four layout files
 * are LF on every platform (machine-read bytes must match across machines), the engine creates no
 * repository of `.superworker`'s own, and every attachment that did not happen is one sentence of `warnings`
 * instead of an exception.
 */

/** The expected bytes of `.superworker/.gitignore` (the init constant verbatim, LF). */
const GITIGNORE = [
  "# This tool's own machinery: where dispatch lands, worktrees, the temp files a node produces.",
  'meta/',
  'worktrees/',
  'temp/',
  '',
].join('\n');

/** The expected bytes of `.superworker/.gitattributes`: the line endings are ours, and records merge by record. */
const GITATTRIBUTES = [
  "# The line endings of these files are ours: every record is written with LF, and no machine's",
  '# core.autocrlf has any business rewriting that.',
  '** -text',
  '',
  '# Records merge entry-wise, not line by line; the driver is sw-merge-ledger, and that command is',
  "# registered in each machine's git config (ledger.register).",
  'ideas.json merge=superworker',
  'state.json merge=superworker',
  'instructions.json merge=superworker',
  'signals/** merge=superworker',
  '',
].join('\n');

const LAYOUT_FILES = ['.gitignore', '.gitattributes', 'AGENTS.md', 'config.json'];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superworker-init-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = undefined!;
});

describe('ledger.init: the bottom line holds in an environment without git', () => {
  it('the four layout files land, LF on every platform, and no repository of .superworker is created', async () => {
    const superworker = open(root);
    const report = await superworker.ledger.init();
    expect(report.layout).toBe('own-repo');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(readFileSync(join(root, '.superworker', '.gitignore'), 'utf8')).toBe(GITIGNORE);
    expect(readFileSync(join(root, '.superworker', '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES);
    // The one byte rule of a record (`src/jsonio.ts`): no trailing newline, so what init lands here and
    // what `config.set` rewrites later are the same bytes for the same document.
    expect(readFileSync(join(root, '.superworker', 'config.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(root, '.superworker', 'AGENTS.md'), 'utf8')).toContain('# .superworker usage note');
    for (const name of LAYOUT_FILES) {
      expect(readFileSync(join(root, '.superworker', name), 'utf8'), name).not.toContain('\r\n');
    }
    expect(existsSync(join(root, '.superworker', '.git'))).toBe(false);
    expect(existsSync(join(root, '.superworker', 'nodes'))).toBe(false);
  });

  it('the directory is a superworker workspace afterwards: the engine recognises it and doctor has no complaint', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    expect(isLedgerInitialized(recordPaths(root))).toBe(true);
    const records = (await superworker.conductor.doctor()).checks.find((check) => check.name === 'records')!;
    expect(records.ok).toBe(true);
    expect(records.detail).toContain('all in place');
  });

  it('each attachment it could not do is one sentence of warnings, and init still resolves', async () => {
    const superworker = open(root);
    const report = await superworker.ledger.init();
    expect(report.ownRepo).toBe('skipped-no-git');
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.warnings).toHaveLength(3);
    for (const line of report.warnings) {
      expect(line.endsWith('.')).toBe(true);
      expect(line.length).toBeGreaterThan(20);
    }
    const said = report.warnings.join('\n');
    expect(said).toContain('git init .superworker');
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

    const superworker = open(root);
    const report = await superworker.ledger.init();
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(report.mergeDriver).toBe('skipped-no-config');
    expect(report.ownRepo).toBe('skipped-no-git');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(readFileSync(join(gitDir, 'HEAD'), 'utf8')).toBe(headBefore);
    // No runner means no `git init .superworker` can be run either: the asked-for repository stays a reading and
    // an advice, and no `.superworker/.git` appears.
    expect(existsSync(join(root, '.superworker', '.git'))).toBe(false);
    expect(readFileSync(join(root, '.superworker', '.gitignore'), 'utf8')).toBe(GITIGNORE);
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
    expect(existsSync(join(root, '.superworker', '.git'))).toBe(false);
  });

  it('idempotent: a second run writes nothing at all and changes no byte', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    const before = hashTree(join(root, '.superworker'));
    const second = await superworker.ledger.init();
    expect(second.written).toEqual([]);
    expect(hashTree(join(root, '.superworker'))).toBe(before);
  });

  it('nothing to land: a run with config.json in place takes no lock and answers at once', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    const recordDir = join(root, '.superworker');
    // A lock file nobody holds: taking the lock would mean waiting out the whole ten-second limit.
    const lock = join(recordDir, 'meta', 'ledger.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '', 'utf8');

    const started = Date.now();
    const second = await superworker.ledger.init();
    const elapsedMs = Date.now() - started;

    expect(second.written).toEqual([]);
    expect(elapsedMs).toBeLessThan(2_000);
    // The lock was never taken: the stale file is still exactly where the dead holder left it.
    expect(existsSync(lock)).toBe(true);
  });

  it('only what is broken is rewritten: a hand-broken layout file is repaired by the next run', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    const recordDir = join(root, '.superworker');
    writeFileSync(join(recordDir, '.gitignore'), 'someone broke it\n', 'utf8');
    writeFileSync(join(recordDir, 'AGENTS.md'), 'someone broke it\n', 'utf8');
    const repaired = await superworker.ledger.init();
    expect(repaired.written.sort()).toEqual(['.gitignore', 'AGENTS.md'].sort());
    expect(readFileSync(join(recordDir, '.gitignore'), 'utf8')).toBe(GITIGNORE);
    expect(readFileSync(join(recordDir, 'AGENTS.md'), 'utf8')).toContain('# .superworker usage note');
  });

  it('a layout file deleted by hand comes back; the rest is left alone', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    const recordDir = join(root, '.superworker');
    rmSync(join(recordDir, '.gitattributes'));
    const repaired = await superworker.ledger.init();
    expect(repaired.written).toEqual(['.gitattributes']);
    expect(readFileSync(join(recordDir, '.gitattributes'), 'utf8')).toBe(GITATTRIBUTES);
  });

  it('config.json written by hand is never cleared by default; only force resets it, and both modes are idempotent', async () => {
    const superworker = open(root);
    await superworker.ledger.init();
    const recordDir = join(root, '.superworker');
    writeFileSync(join(recordDir, 'config.json'), '{"my_knob": 42}\n', 'utf8');
    const untouched = await superworker.ledger.init();
    expect(readFileSync(join(recordDir, 'config.json'), 'utf8')).toBe('{"my_knob": 42}\n');
    expect(untouched.written).toEqual([]);

    const forced = await superworker.ledger.init({ force: true });
    expect(readFileSync(join(recordDir, 'config.json'), 'utf8')).toBe('{}');
    expect(forced.written).toEqual(['config.json']);
    const before = hashTree(recordDir);
    await superworker.ledger.init({ force: true });
    expect(hashTree(recordDir)).toBe(before);
  });

  it('the in-repo layout is the same bottom line without git: layout written, exclude skipped', async () => {
    const superworker = open(root);
    const report = await superworker.ledger.init({ layout: 'in-repo' });
    expect(report.layout).toBe('in-repo');
    expect(report.written).toEqual(LAYOUT_FILES);
    expect(report.exclude).toBe('skipped-not-a-checkout');
    expect(existsSync(join(root, '.superworker', '.git'))).toBe(false);
    expect(readFileSync(join(root, '.superworker', '.gitignore'), 'utf8')).toBe(GITIGNORE);
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
