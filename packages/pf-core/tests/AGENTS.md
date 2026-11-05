# tests/ — 单测、守卫与黄金语料：什么锁得住、什么只能手过

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

**动手写测试之前先读 [../docs/rules.md](../docs/rules.md)。**

- `corpus.test.ts` `fixtures/` — 黄金语料：逐字节对拍的用例，一个用例一个目录
- `helpers/` — 共享替身与语料重放器：铺台、token 规则与比对尺子都在 `corpus.ts`
- `guard.test.ts` — 硬边界与包的形状守卫
- `api-docs.test.ts` `surface.test.ts` — `docs/api.md` 与包出口、冻结面对拍
- `dag-*` `cycles-commands` `instructions-commands` `records` `record-io` `format` — 记录与它的动作面
- `ledger-*` `layout` `atomic-write` `pf-dir-hash` `merge-ledger-bin` — 立起记录目录、布局、写入底座与合并驱动的进程入口
- `conductor-*` `config` `sessions` `env-switches` `clock` `tempclean` `handle-additions` `doctor-*` — 推线、设置、会话、运行期开关、时刻、清理与体检
- `executor` `git-seam` `fs-helpers` `handle-home` `stubs` `global-setup` — 几条接缝（含句柄的机器层）、替身与全库的前后哈希守卫
- `plugin-*` — 插件框架，外加自带的三个插件
