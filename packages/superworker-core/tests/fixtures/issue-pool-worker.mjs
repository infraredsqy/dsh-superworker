// A worker for the issue pool cross-process contract cases (plain JS at the top level, Node 24+
// loads the engine's type-annotated TS it imports natively, 22.6–23.x with --experimental-strip-types
// passed in by the test, 22.0–22.5 does not run it without the flag).
//
//   node issue-pool-worker.mjs add   <projectRoot> <issueId>
//     run a real `issue add`: read → change → write, the whole stretch under the pool's lock.
//
//   node issue-pool-worker.mjs slow  <projectRoot> <issueId> <holdMs>
//     go under the pool's lock but pull the read → write apart on purpose: take the snapshot first,
//     print HELD (telling the caller the lock is in hand), hold it for holdMs milliseconds, then
//     write the snapshot back with one more entry. The snapshot was taken before the other process
//     wrote — with no cross-process lock this write would cover that entry; with the lock the other
//     side waits, and both entries stay.
//
//   node issue-pool-worker.mjs crash <projectRoot> <issueId>
//     a holder that dies mid-write: it takes the pool's lock, reads the pool, and leaves a
//     temporary file of the writer's own naming shape (`.issues.json.<entropy>.tmp`) in the pool's
//     directory — then hard-exits without releasing the lock and without renaming anything. What
//     it leaves behind is exactly the residue a crash mid-write leaves: a temp file and a lock
//     file. The pool itself is untouched (the temp was never renamed onto it), and the next
//     process must be able to write normally once the lock file — the one thing a holder that died
//     leaves behind, per the error's own sentence — has been cleared.
//
// Every landing place only touches the temporary record tree the caller hands in.

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { pluginBase } from '../../src/plugins/base.ts';
import { main } from '../../plugins/issue/tools/commands.mjs';
import { poolPath, readPool, withPoolLock, writePool } from '../../plugins/issue/tools/storage.mjs';

const [, , mode, root, id, holdMs] = process.argv;
const base = pluginBase();
const ctx = { root, base };

if (mode === 'add') {
  await main(['add', '--id', id, '--title', id], ctx);
  process.exit(0);
}

if (mode === 'slow') {
  await withPoolLock(root, async () => {
    const data = await readPool(root, base);
    process.stdout.write('HELD\n');
    await sleepMs(Number(holdMs));
    data.issues[id] = { id, severity: 'P3', status: 'open', title: id };
    await writePool(root, data, base);
  }, base);
  process.exit(0);
}

if (mode === 'crash') {
  await withPoolLock(root, async () => {
    await readPool(root, base);
    // The writer's temp naming shape, in the target's own directory: the residue a crash leaves
    // between the temp's fsync and the rename onto the pool.
    const tmp = join(dirname(poolPath(root)), `.issues.json.crash-${process.pid}.tmp`);
    mkdirSync(dirname(tmp), { recursive: true });
    const handle = openSync(tmp, 'wx');
    try {
      writeSync(handle, Buffer.from(JSON.stringify({ version: 1, issues: {} }, null, 2), 'utf8'));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    // Die exactly here: the temp is on disk, nothing was renamed, the lock file stays behind.
    process.exit(1);
  }, base);
  process.exit(0);
}

console.log(`UNKNOWN-MODE:${mode}`);
process.exit(64);
