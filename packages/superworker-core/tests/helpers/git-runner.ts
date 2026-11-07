import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitResult, GitRunner } from '../../src/git.ts';

/**
 * The real git `GitRunner`: `execFile('git', args, { cwd, encoding: 'utf8' })`.
 *
 * The conventions (the same set every git call follows):
 * - `cwd` is always given (a question about one tree is asked in that tree);
 * - text is read as UTF-8 and bytes that cannot be decoded fold into the replacement character —
 *   that is the equivalent of decoding leniently rather than failing; do not turn it into a fatal
 *   error (the Windows console code page can turn a path into an exception);
 * - a non-zero exit **answers the call** (the `GitResult` carries the code), it does not throw.
 *
 * The commit identity travels in environment variables (a fixed identity) and is not written into
 * the repository config: a fixture repo is temporary, and an identity written into `.git/config`
 * only pollutes repos once they meet.
 */

/** A fixed commit identity: git accepts the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` set directly, no user.name needed. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'superworker test',
  GIT_AUTHOR_EMAIL: 'superworker-test@example.invalid',
  GIT_COMMITTER_NAME: 'superworker test',
  GIT_COMMITTER_EMAIL: 'superworker-test@example.invalid',
};

export const gitRunner: GitRunner = {
  run(cwd: string, args: readonly string[]): Promise<GitResult> {
    return new Promise((resolveRun) => {
      execFile(
        'git',
        [...args],
        {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : 127;
          resolveRun({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  },
};

/**
 * The git used for staging: one failed command throws on the spot (an unbuildable fixture makes the
 * later assertions meaningless).
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRunner.run(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (${result.code}): ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Lay down a temporary repo that can fork: `git init -b <branch>` plus one seed commit, and the
 * HEAD comes back.
 *
 * Two config cells are written into the repo only to pin the fixture down: `core.autocrlf=false`
 * (line-ending conversion would make the byte comparison drift from machine to machine) and
 * `commit.gpgsign=false` (if the machine signs commits, the fixture commit would stall on the
 * signature). The commit itself still carries `--no-gpg-sign`, the same convention as above.
 */
export async function makeRepo(root: string, branch = 'master'): Promise<string> {
  mkdirSync(root, { recursive: true });
  await git(root, 'init', '-b', branch);
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'seed.md'), '# seed\n', 'utf8');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'seed', '--no-gpg-sign');
  return (await git(root, 'rev-parse', 'HEAD')).trim();
}
