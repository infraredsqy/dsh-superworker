/**
 * The git capability: the shape lives here, the implementation lives outside.
 *
 * The engine itself starts no process (a hard boundary, pinned by `tests/guard.test.ts`),
 * so git can only be handed in by the caller. Only types are given here, no default
 * implementation — a default implementation would amount to the engine starting a process
 * itself; a fake built in here would amount to letting the caller skip checks without knowing it.
 *
 * Engine entries drive git only through this injected runner: `ledger.init` and `ledger.register` ask it
 * for facts and let it write the two `merge.superworker.*` keys, and `conductor.doctor` reads those keys back. The
 * parallel mode's worktree and branch are still made and removed by hand, and no engine entry performs a
 * repository action; the shape stays as the seam a caller injects git through.
 *
 * The reading:
 *
 * - `cwd` is required and is always the tree the caller named (a question about one tree cannot
 *   be asked inside another);
 * - `stdout` / `stderr` are both strings, decoded as UTF-8 (undecodable bytes fold into the
 *   replacement character; the Windows console code page must not turn into an exception);
 * - **a non-zero exit is not an exception**: "not a repository" and "no such branch" are both
 *   answers, the caller branches on `code` itself;
 * - no timeout, no shell: one call is one `git <args>`.
 */

/** The answer of one git call: the exit code plus the two output streams; it carries nothing else. */
export interface GitResult {
  /** The exit code; 0 is success, non-zero is an answer just the same, not thrown. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one `git <args>` in the given directory. The implementation is injected from outside (real git in tests). */
export interface GitRunner {
  run(cwd: string, args: readonly string[]): Promise<GitResult>;
}

/** The dependency bag an engine entry may take; git is the only slot so far. */
export interface GitDeps {
  readonly git: GitRunner;
}
