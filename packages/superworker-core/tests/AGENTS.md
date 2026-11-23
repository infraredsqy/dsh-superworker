# tests/ — 单测与守卫：什么锁得住、什么只能手过

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

**动手写测试之前先读 [../docs/rules.md](../docs/rules.md)。**

- `fixtures/` — 输入材料与跨进程 worker 脚本：`plan-tie-stable-order` 供 `conductor-plan` 的重放器自检，三个 `*-worker.mjs` 供跨进程用例
- `helpers/` — 共享替身与重放器：铺台在 `plugin-lab`，重放器在 `corpus`，慢档门禁在 `slow`
- `guard.test.ts` — 源码树的运行期边界守卫（无 spawn / 无外部依赖 / 不出现 @deepseek-ai / 不开会话 / 不联网）
- `dag-*` `cycles-commands` `record-io` `state-reader` `node-table-reader` — 记录与它的动作面；`state-reader` / `node-table-reader` 各锁一张表的唯一读者（`state.json` 的 `cycles` 表 / `ideas.json` 的 `nodes` 表）；指令清单那组在 `plugin-instruction-*`（归属与动词都在插件里）
- `ledger-*` `layout` `atomic-write` — 立起记录目录、布局与写入底座；`ledger-merge` 锁合并规则，`merge-ledger-bin` 锁进程入口的 argv 与退出码映射
- `conductor-*` `config` `sessions` `env-switches` `clock` `tempclean` `handle-additions` `doctor-*` — 推线、设置、会话、运行期开关、时刻、清理与体检
- `executor` `fs-helpers` `handle-home` `global-setup` — 几条接缝（含句柄的机器层）与全库的前后哈希守卫
- `plugin-*` — 插件框架，外加自带的四份插件
