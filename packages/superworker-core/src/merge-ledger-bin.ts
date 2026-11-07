/**
 * The one process entry of this package: `sw-merge-ledger`, the command that answers the merge
 * driver registered in a project's git config.
 *
 * git reaches a merge rule through a process and nothing else, so this file is the single exception
 * to "the engine starts no process" — and it is a shell in the strict sense: it maps git's four
 * arguments (`%O` `%A` `%B` `%P`), carries the exit code back out, and contains not one merge rule
 * (every rule lives in `src/ledgermerge/`).
 *
 * - The record tree is located from `%P` and this process's working directory (git starts a driver
 *   at the top of the working tree), so a project in a subdirectory of the repository is found the
 *   same way as one at the repository root.
 * - `--dry-run` anywhere in the arguments only prints the verdict, writing not one byte.
 * - stdout and stderr are written as UTF-8 text: Node encodes a string written to a stream as UTF-8
 *   bytes whatever the console code page is, so a path or a record title does not come out garbled.
 * - The ending never calls `process.exit`: `process.exit` stops the process on the spot and can cut
 *   off writes still queued in stdout / stderr (git hands the driver pipes, and a verdict lost to a
 *   cut pipe is a conflict the human never sees). The shell sets `process.exitCode` instead and
 *   falls off the end: the event loop drains, the queued writes reach their pipes whole, and the
 *   process leaves with the same exit code it always carried (0 / 1 / 2: merged, needs a human,
 *   usage or read error).
 *
 * The product built from this file is the package's single executable entry (see `package.json`);
 * the build banner puts the node shebang line on its first line, which is the shape npm's shims
 * execute.
 */

import { runMergeDriver } from './ledgermerge/driver';

/**
 * The soft exit: the self-contained Node declarations (`src/node-runtime.d.ts`) carry `exit` but
 * not the `exitCode` field this shell now ends with, so the widened view stays local to this file
 * instead of widening the shared declarations under a parallel node's feet.
 */
const procWithExitCode = process as typeof process & { exitCode?: number };

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const sides = argv.filter((arg) => arg !== '--dry-run');
const [base, ours, theirs, path] = sides;

const io = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

if (base === undefined || ours === undefined || theirs === undefined) {
  io.stderr(
    "sw-merge-ledger: git hands a merge driver four arguments (%O %A %B %P: the common side, " +
      'this side, the other side, and the path in the repository)\n',
  );
  procWithExitCode.exitCode = 2;
} else {
  procWithExitCode.exitCode = await runMergeDriver(
    {
      base,
      ours,
      theirs,
      ...(path === undefined || path === '' ? {} : { path }),
      ...(dryRun ? { dryRun: true } : {}),
    },
    io,
  );
}
