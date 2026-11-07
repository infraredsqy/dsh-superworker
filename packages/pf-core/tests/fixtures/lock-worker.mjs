// A worker for the lock cross-process case (plain JS, node runs it directly; src is type-annotated
// TS only: Node 22.6–23.x loads it with --experimental-strip-types passed in by the test, 24+ loads
// it natively, 22.0–22.5 does not run it without the flag).
//
//   node lock-worker.mjs hold    <projectRoot> <recordAbsPath> <holdMs>
//     take the lock → write one record (payload=holder) → hold it for the given time → let go → exit 0.
//
//   node lock-worker.mjs contend <projectRoot> <recordAbsPath> <payload> <timeoutMs>
//     take the lock with a timeout, then write the same record (payload=the second argument):
//     print ACQUIRED and exit 0 on success; print TIMEOUT:lock_timeout and exit 3 on timeout.
//
// Every landing place comes from pfPaths; the engine operations only touch the temporary record
// tree the caller hands in.

import { setTimeout as sleepMs } from 'node:timers/promises';
import { atomicWriteJson } from '../../src/jsonio.ts';
import { withLedgerLock } from '../../src/ledgerlock.ts';
import { pfPaths } from '../../src/paths.ts';

const [, , mode, projectRoot, recordPath, value, timeoutMs] = process.argv;
const paths = pfPaths(projectRoot);

if (mode === 'hold') {
  await withLedgerLock(paths, async () => {
    await atomicWriteJson(recordPath, { payload: 'holder' });
    await sleepMs(Number(value));
  });
  process.exit(0);
}

if (mode === 'contend') {
  try {
    await withLedgerLock(
      paths,
      async () => {
        await atomicWriteJson(recordPath, { payload: value });
      },
      { timeoutMs: Number(timeoutMs) },
    );
    console.log('ACQUIRED');
    process.exit(0);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'lock_timeout') {
      console.log('TIMEOUT:lock_timeout');
      process.exit(3);
    }
    console.log(`UNEXPECTED:${error && error.message}`);
    process.exit(2);
  }
}

console.log(`UNKNOWN-MODE:${mode}`);
process.exit(64);
