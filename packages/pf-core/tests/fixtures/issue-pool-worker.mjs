// A worker for the issue pool cross-process lock case (plain JS, node runs it directly; the plugin
// itself is .mjs, so no TS loading flag is needed).
//
//   node issue-pool-worker.mjs add  <projectRoot> <issueId>
//     run a real `issue add`: read → change → write, the whole stretch under the plugin's lock.
//
//   node issue-pool-worker.mjs slow <projectRoot> <issueId> <holdMs>
//     go under the plugin's lock but pull the read → write apart on purpose: take the snapshot
//     first, print HELD (telling the caller the lock is in hand), hold it for holdMs milliseconds,
//     then write the snapshot back with one more entry. The snapshot was taken before the other
//     process wrote — with no cross-process lock this write would cover that entry; with the lock
//     the other side waits, and both entries stay.
//
// Every landing place only touches the temporary record tree the caller hands in.

import { setTimeout as sleepMs } from 'node:timers/promises';
import { main } from '../../plugins/issue/tools/commands.mjs';
import { readPool, withPoolLock, writePool } from '../../plugins/issue/tools/storage.mjs';

const [, , mode, root, id, holdMs] = process.argv;
const ctx = { root };

if (mode === 'add') {
  await main(['add', '--id', id, '--title', id], ctx);
  process.exit(0);
}

if (mode === 'slow') {
  await withPoolLock(root, async () => {
    const data = readPool(root);
    process.stdout.write('HELD\n');
    await sleepMs(Number(holdMs));
    data.issues[id] = { id, severity: 'P3', status: 'open', title: id };
    await writePool(root, data);
  });
  process.exit(0);
}

console.log(`UNKNOWN-MODE:${mode}`);
process.exit(64);
