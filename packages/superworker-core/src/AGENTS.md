# src/ — 引擎本体：记录动作、推线、设置、记录 IO 底座与插件框架

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

**硬边界由 `tests/guard.test.ts` 钉着**；口径见 [../docs/rules.md](../docs/rules.md)。

- `open.ts` `index.ts` `ledger.ts` `types.ts` `node-runtime.d.ts` — 句柄的装配、四个命名空间、包的出口与冻结的记录类型（含 Node 内置面声明）
- `dag.ts` `graph.ts` `cycles.ts` `instruct.ts` `planner.ts` `conductor.ts` `prepare.ts` — 记录动作面与推线：图、线、指令，只读规划、派发准备、收尾结算，以及交接单形状与插件命令词的路由
- `config.ts` `sessions.ts` `env.ts` `clock.ts` `tempclean.ts` — 设置解析链、会话档、运行期开关、时刻、临时清理
- `paths.ts` `jsonio.ts` `ledgerlock.ts` `errors.ts` `fs-helpers.ts` — 记录 IO 底座：落点、读写、锁、错误码
- `legacy.ts` `migrate.ts` — 旧记录目录唯一的事实来源（在不在、认不认得出、迁不迁得动）与把一份工作区的记录搬进 `.superworker` 的那个词；doctor 与 migrate 共用同一份前置判断
- `initledger.ts` `git.ts` `executor.ts` `doctor.ts` — 立起 `.superworker` 并接上 git、记录与 git 那半体检、git 接缝、执行者接缝
- `merge-ledger-bin.ts` `ledgermerge/` — 唯一的进程入口与它背后的合并驱动
- `words/` — 词面：一张词表与它的解析、打印、读法与路由（`answer` / `describe`），命令面与 agent 面共用的那一层；接缝全部经 `WordsIO` 注入
- `plugins/` — 插件框架：声明校验、装载、时机门
