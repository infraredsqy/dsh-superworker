# pf-core — 纯 TypeScript 的 pf 引擎：记录、线、设置与推线；暂作 pipeline 的暂存区，终将并入寻路中心的 host 半端

> 本文件是路牌，上限 15 行：一行一条——只说这一层有什么、什么时候看。

**动手之前先读 [docs/rules.md](docs/rules.md)** — 这个仓的法：硬边界、记录的落盘口径、语料与测试的规矩。

- `docs/` — 接口面、合并驱动与法（见 [docs/AGENTS.md](docs/AGENTS.md)）。改接口、动合并、拿不准边界时看
- `src/` — 引擎源码：记录动作、推线、设置、记录 IO 底座与插件框架（见 [src/AGENTS.md](src/AGENTS.md)）
- `tests/` — 单测、守卫与黄金语料（见 [tests/AGENTS.md](tests/AGENTS.md)）。改逻辑或加用例时看
- `plugins/` — 仓库自带的三份插件：问题池、测试耗时度量，与随发布件装进技能目录的三份管线指令（见 [plugins/AGENTS.md](plugins/AGENTS.md)）
- `package.json` `tsconfig.json` `tsdown.config.ts` `vitest.config.ts` — 包的形状（私有、唯一进程入口）与构建、测试口径。改发布面或构建时看
- `.pf/` — 这个包自己不立记录目录：引擎操作一律在临时目录做，管线的记录在仓根那一份（见仓根的 `.pf/AGENTS.md`）
- `.tmp/` — 临时产物，随时可删，不进版本库

来源说明：本库由参考实现（Python 工具树）向 TypeScript 移植而来，仅此一句，别处不再提。