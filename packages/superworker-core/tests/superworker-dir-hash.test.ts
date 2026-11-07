import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashDirectory } from './helpers/hash-dir.ts';

/**
 * How the `.superworker` hash invariant works: the directory hash is stable for "the same tree" and
 * sensitive to a change of any single byte in a record. The repo-root .superworker must be untouched before
 * and after the whole suite — vitest's globalSetup enforces that invariant at the end
 * (tests/global-setup.ts); what is locked here is the hashing function underneath it.
 * It skips the three kinds of directory superworker manages itself (top-level worktrees/meta, temp at
 * any depth): parallel cycles writing caches, locks and probes there is normal work and must not go
 * red, while a record file that changes must.
 */

const repoRecordDir = fileURLToPath(new URL('../../../.superworker', import.meta.url));

function makeTempTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'superworker-hash-'));
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'a', 'one.json'), '{"x":1}\n');
  writeFileSync(join(root, 'a', 'b', 'two.json'), '{"y":2}\n');
  writeFileSync(join(root, 'top.md'), '# t\n');
  return root;
}

/** Lay out a small tree the way `.superworker` is laid out: record files plus the three self-managed directories. */
function makeRecordTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'superworker-hash-ledger-'));
  mkdirSync(join(root, 'nodes', 'n1', 'temp'), { recursive: true });
  mkdirSync(join(root, 'meta', 'sessions'), { recursive: true });
  mkdirSync(join(root, 'worktrees', 'w1'), { recursive: true });
  mkdirSync(join(root, 'misc', 'temp'), { recursive: true });
  writeFileSync(join(root, 'ideas.json'), '{"nodes":{}}\n');
  writeFileSync(join(root, 'state.json'), '{"cycles":[]}\n');
  writeFileSync(join(root, 'nodes', 'n1', 'spec.md'), '# spec\n');
  writeFileSync(join(root, 'nodes', 'n1', 'temp', 'probe.txt'), 'raw');
  writeFileSync(join(root, 'meta', 'sessions', 'n1.json'), '{"note":1}\n');
  writeFileSync(join(root, 'worktrees', 'w1', 'cache.bin'), 'c');
  writeFileSync(join(root, 'misc', 'temp', 'scratch.txt'), 's');
  return root;
}

describe('directory hash', () => {
  it('the same tree hashes the same twice in a row', () => {
    const root = makeTempTree();
    try {
      expect(hashDirectory(root)).toBe(hashDirectory(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('change one byte and the hash changes', () => {
    const root = makeTempTree();
    try {
      const before = hashDirectory(root);
      writeFileSync(join(root, 'a', 'one.json'), '{"x":2}\n');
      expect(hashDirectory(root)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adding or removing a file changes the hash', () => {
    const root = makeTempTree();
    try {
      const before = hashDirectory(root);
      writeFileSync(join(root, 'new.txt'), 'n');
      expect(hashDirectory(root)).not.toBe(before);
      rmSync(join(root, 'new.txt'));
      expect(hashDirectory(root)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('every engine operation lands in a temporary directory: the repo-root .superworker is not touched', () => {
    const before = hashDirectory(repoRecordDir);
    const workdir = mkdtempSync(join(tmpdir(), 'superworker-engine-'));
    try {
      mkdirSync(join(workdir, '.superworker', 'nodes'), { recursive: true });
      writeFileSync(join(workdir, '.superworker', 'state.json'), '{"cycles":[]}\n');
      writeFileSync(join(workdir, '.superworker', 'nodes', 'x.md'), 'probe');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
    expect(hashDirectory(repoRecordDir)).toBe(before);
  });

  it('changes in the self-managed areas do not change the hash: top-level worktrees/meta and temp at any depth', () => {
    const root = makeRecordTree();
    try {
      const before = hashDirectory(root);
      writeFileSync(join(root, 'worktrees', 'w1', 'cache.bin'), 'dirty');
      mkdirSync(join(root, 'worktrees', 'w2'), { recursive: true });
      writeFileSync(join(root, 'worktrees', 'w2', 'new.bin'), 'n');
      writeFileSync(join(root, 'meta', 'ledger.lock'), '');
      writeFileSync(join(root, 'meta', 'sessions', 'n1.json'), '{"note":2}\n');
      writeFileSync(join(root, 'nodes', 'n1', 'temp', 'probe.txt'), 'raw2');
      rmSync(join(root, 'nodes', 'n1', 'temp', 'probe.txt'));
      // temp is skipped at any depth (in the src/paths.ts layout it only appears as nodes/<id>/temp).
      writeFileSync(join(root, 'misc', 'temp', 'scratch.txt'), 's2');
      expect(hashDirectory(root)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a byte changed in a record file still goes red: nodes/<id>/spec.md and ideas.json', () => {
    const root = makeRecordTree();
    try {
      const before = hashDirectory(root);
      writeFileSync(join(root, 'nodes', 'n1', 'spec.md'), '# spec v2\n');
      const afterSpec = hashDirectory(root);
      expect(afterSpec).not.toBe(before);
      writeFileSync(join(root, 'ideas.json'), '{"nodes":{"n1":{}}}\n');
      expect(hashDirectory(root)).not.toBe(afterSpec);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
