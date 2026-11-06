// 问题池跨进程锁的用例工作进程（普通 JS，node 直接跑；插件本身就是 .mjs，不用 TS 加载旗标）。
//
//   node issue-pool-worker.mjs add  <projectRoot> <issueId>
//     跑一遍真的 `issue add`：读 → 改 → 写整段走插件的锁。
//
//   node issue-pool-worker.mjs slow <projectRoot> <issueId> <holdMs>
//     走插件的锁，但故意把「读 → 写」拉开：先取快照、打印 HELD（告诉调用方锁已在手上），
//     握着 holdMs 毫秒，再把快照加一条写回去。快照是在另一进程写之前取的——没有跨进程锁时，
//     这次写会把那一条盖掉；有锁时对方会等，两条都在。
//
// 全部落点只碰调用方给的那棵临时记录树。

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
