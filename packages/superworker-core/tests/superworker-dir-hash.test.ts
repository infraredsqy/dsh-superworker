import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashDirectory } from './helpers/hash-dir.ts';

/**
 * The repo-root guard's exclusion face: `tests/global-setup.ts` hashes the record tree with
 * `skipLiveFaces` on, so the faces a running line writes in ordinary work stay out of the hash and a
 * parallel cycle cannot trip the sentinel during a suite window, while anything the suite itself
 * lands — a new entry at the record root, a touched seed file — still goes red. The tree here is a
 * fake record laid out the way `src/paths.ts` spells it; nothing of the repo's own record is read.
 * The default face is pinned beside it: without the switch the same bytes still count, which is what
 * the idempotence pins (a `plan` re-read, a dispatch prepared twice) stand on.
 */
function makeRecordTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'superworker-hash-guard-'));
  mkdirSync(join(root, 'nodes', 'n1', 'temp'), { recursive: true });
  mkdirSync(join(root, 'signals', 'c1'), { recursive: true });
  mkdirSync(join(root, 'issues'), { recursive: true });
  mkdirSync(join(root, 'meta', 'sessions'), { recursive: true });
  mkdirSync(join(root, 'worktrees', 'w1'), { recursive: true });
  mkdirSync(join(root, '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'meta/\nworktrees/\ntemp/\n');
  writeFileSync(join(root, '.gitattributes'), '** -text\n');
  writeFileSync(join(root, 'AGENTS.md'), '# records\n');
  writeFileSync(join(root, 'config.json'), '{}\n');
  writeFileSync(join(root, 'ideas.json'), '{"nodes":{}}\n');
  writeFileSync(join(root, 'state.json'), '{"cycles":[]}\n');
  writeFileSync(join(root, 'instructions.json'), '[]\n');
  writeFileSync(join(root, 'issues', 'issues.json'), '{"issues":{}}\n');
  writeFileSync(join(root, 'nodes', 'n1', 'spec.md'), '# spec\n');
  writeFileSync(join(root, 'nodes', 'n1', 'temp', 'probe.txt'), 'raw');
  writeFileSync(join(root, 'signals', 'c1', 'n1.json'), '{"state":"completed"}\n');
  writeFileSync(join(root, 'meta', 'sessions', 'n1.json'), '{"note":1}\n');
  writeFileSync(join(root, 'worktrees', 'w1', 'cache.bin'), 'c');
  writeFileSync(join(root, '.git', 'objects', 'ab'), 'c');
  return root;
}

describe('the repo-root guard face', () => {
  it('a parallel line writing its ordinary faces during the window leaves the hash as it was', () => {
    const root = makeRecordTree();
    try {
      const before = hashDirectory(root, { skipLiveFaces: true });
      /* The record moves: statuses flip, a node lands, a ticket is written, the pool grows, the
       * settings change, the record repo commits. */
      writeFileSync(join(root, 'ideas.json'), '{"nodes":{"n1":{}}}\n');
      writeFileSync(join(root, 'state.json'), '{"cycles":[{"id":"c1"}]}\n');
      writeFileSync(join(root, 'instructions.json'), '[{"id":"i1"}]\n');
      writeFileSync(join(root, 'config.json'), '{"fork":true}\n');
      mkdirSync(join(root, 'nodes', 'n2'), { recursive: true });
      writeFileSync(join(root, 'nodes', 'n2', 'run.md'), '# run\n');
      writeFileSync(join(root, 'signals', 'c1', 'n2.json'), '{"state":"completed"}\n');
      writeFileSync(join(root, 'issues', 'issues.json'), '{"issues":{"k":{}}}\n');
      writeFileSync(join(root, 'meta', 'sessions', 'n1.json'), '{"note":2}\n');
      writeFileSync(join(root, 'worktrees', 'w1', 'cache.bin'), 'dirty');
      writeFileSync(join(root, '.git', 'objects', 'cd'), 'c');
      expect(hashDirectory(root, { skipLiveFaces: true })).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('what the suite lands still goes red: a new entry at the record root, a touched seed file', () => {
    const root = makeRecordTree();
    try {
      const before = hashDirectory(root, { skipLiveFaces: true });
      writeFileSync(join(root, 'rogue.json'), '{}\n');
      expect(hashDirectory(root, { skipLiveFaces: true })).not.toBe(before);
      rmSync(join(root, 'rogue.json'));
      expect(hashDirectory(root, { skipLiveFaces: true })).toBe(before);
      writeFileSync(join(root, 'AGENTS.md'), '# rewritten\n');
      expect(hashDirectory(root, { skipLiveFaces: true })).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the default face keeps reading every byte of a record: a record file moving still flips it', () => {
    const root = makeRecordTree();
    try {
      const before = hashDirectory(root);
      writeFileSync(join(root, 'ideas.json'), '{"nodes":{"n1":{}}}\n');
      expect(hashDirectory(root)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
