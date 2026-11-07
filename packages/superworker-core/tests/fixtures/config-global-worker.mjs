// A worker for the machine-layer settings cross-process case (plain JS, node runs it directly; src
// is type-annotated TS only: Node 24+ loads it natively, 22.6–23.x is given
// --experimental-strip-types by the test, 22.0–22.5 does not run this case).
//
//   node config-global-worker.mjs slow <home>
//     take the machine-layer lock (`<home>/.superworker/meta/ledger.lock`, the ledger lock of the record
//     directory `<home>/.superworker`): read the whole `<home>/.superworker/config.json` into a snapshot, print HELD
//     (the lock is in hand, the snapshot taken), then **wait** for the caller's line `WROTE` on
//     stdin (which means the caller's write command is already out and this lock is holding it
//     outside, or it landed before the lock was taken — the caller tells those two apart), then
//     write the snapshot back with max_agents added and let go, printing RELEASED last. Letting go
//     does not wait long enough: without WROTE it keeps holding.
//
// It only touches the temporary home the caller hands in, never the real machine's `~/.superworker`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLedgerLock } from '../../src/ledgerlock.ts';
import { recordPaths } from '../../src/paths.ts';

const [, , mode, home] = process.argv;

/** Wait for the caller's line on stdin; the loop must not stay alive on stdin after it arrives. */
function waitForLine(needle) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes(needle)) return;
      process.stdin.removeAllListeners('data');
      process.stdin.destroy();
      resolveLine();
    });
    process.stdin.on('end', () => rejectLine(new Error(`stdin closed before ${needle}`)));
    process.stdin.on('error', rejectLine);
  });
}

if (mode === 'slow') {
  const configPath = join(home, '.superworker', 'config.json');
  await withLedgerLock(recordPaths(home), async () => {
    const doc = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    process.stdout.write('HELD\n');
    await waitForLine('WROTE');
    doc.max_agents = 4;
    writeFileSync(configPath, JSON.stringify(doc, null, 2), 'utf8');
  });
  process.stdout.write('RELEASED\n');
  process.exitCode = 0;
} else {
  console.log(`UNKNOWN-MODE:${mode}`);
  process.exitCode = 64;
}
