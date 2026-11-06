// 机器层设置跨进程并发用例的工作进程（普通 JS，node 直接跑；src 是纯类型标注的 TS：
// Node 24+ 原生加载，22.6–23.x 由测试补 --experimental-strip-types，22.0–22.5 不跑这条用例）。
//
//   node config-global-worker.mjs slow <home>
//     走机器层那把锁（`<home>/.pf/meta/ledger.lock`，即 `<home>/.pf` 这棵记录目录的 ledger 锁）：
//     先把整份 `<home>/.pf/config.json` 读成快照、打印 HELD（锁已在手上、快照已取），然后**等**调用方
//     在 stdin 上发一行 `WROTE`（那意味着调用方那条写命令已经发出去、正被这把锁挡在门外，或者早在
//     拿锁之前就已经落盘——两者的区别由调用方自己判），收到后把快照加上 max_agents 写回去、放锁，
//     最后打印 RELEASED。放锁不靠等够久：没有 WROTE 就一直握着。
//
// 只碰调用方给的临时 home，不读真机的 `~/.pf`。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLedgerLock } from '../../src/ledgerlock.ts';
import { pfPaths } from '../../src/paths.ts';

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
  const configPath = join(home, '.pf', 'config.json');
  await withLedgerLock(pfPaths(home), async () => {
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
