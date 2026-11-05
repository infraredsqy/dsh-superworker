# src/ — 引擎本体：记录动作、推线、设置、记录 IO 底座与插件框架

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

**硬边界由 `tests/guard.test.ts` 钉着**；口径见 [../docs/rules.md](../docs/rules.md)。

- `open.ts` `index.ts` `ledger.ts` — 句柄的装配、四个命名空间与包的出口
- `dag.ts` `graph.ts` `cycles.ts` `instruct.ts` — 记录动作面：图、线、指令
- `planner.ts` `conductor.ts` `prepare.ts` — 推线：只读规划、派发准备、收尾结算，以及交接单形状与插件命令词的路由
- `config.ts` `sessions.ts` `env.ts` `clock.ts` `tempclean.ts` — 设置解析链、会话档、运行期开关、时刻、临时清理
- `paths.ts` `jsonio.ts` `ledgerlock.ts` `errors.ts` `fs-helpers.ts` — 记录 IO 底座：落点、读写、锁、错误码
- `initledger.ts` `git.ts` `executor.ts` — 立起 `.pf` 并接上 git、git 接缝、执行者接缝
- `types.ts` `node-runtime.d.ts` — 冻结的记录类型与 Node 内置面声明
- `merge-ledger-bin.ts` `ledgermerge/` — 唯一的进程入口与它背后的合并驱动
- `words/` — 词面：一张词表与它的解析、打印、读法与路由（`answer` / `describe`），命令面与 agent 面共用的那一层；接缝全部经 `WordsIO` 注入
- `plugins/` — 插件框架：声明校验、装载、时机门