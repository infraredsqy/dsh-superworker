# 池子（issue 库）

> 池子这一支的扫描、裁定与修复三个技能共用这一份：命令细节以 `--help` 为准，这里只写口径。

池子住在项目的 `.pf/issues/`，是统一的 to-do list。`source` 只说这条是怎么来的：`scan`（扫描入池）、`manual`（用户随手记的）、`conduct`（干活会话撞见的）。

## 只走工具

动池子之前先问这个词自己：`issue --help` 给出它那一页；门是 `pathfinder` 工具——给它 `word`、该词的 `args` 跑一条，`help` 取它那一页。

- 与池子的**一切**读写只走 `issue` 这个词。**禁止直接 read `.pf/issues/issues.json`**：巨型 JSON，烧上下文，还绕过工具自己的统计口径。

## 批量

同一种动作套在 N 条上时，用词自己的批量形状，别一条一条发：

- 建池：`add --from-file <行文件>`——每行一个条目，`--auto-id` 可以省掉 id。
- 改池：`update --from-file <行文件>`——每行 `id` 加要改的字段；每条 reason 不同的裁定走这条。
- 结池：`resolve <id…> --reason "<同一句验证读数>"`；`reject` / `acknowledge` / `remove` 同理，`mark <id…>` 早就是批量的。

行文件放 `.pf/meta/batch/`，跑完删掉。坏行（不认得的字段、缺 id、坏值）拒整批，一个字节不写；
`update` / `resolve` / `reject` / `acknowledge` / `remove` 里有一个 id 不在，也拒整批；
`add` 的重复 id 与 `mark` 的未知 id 是已知事实，逐行点名，不算坏行。N=1 与单条完全一样。

## 口径

- 状态：`open` / `acknowledged` / `resolving` 三档算 actionable，`resolved` / `rejected` 不算。
- `decision`：`autofix`（能自己修）／`external`（取舍还开在用户手里）／`unknown`（还没判，入库时的默认）。**已经拍过板、解法写在条目里的条目一律 `autofix`**——落在别的节点或别的线上也算。
- **加权和** ＝ P3/P2/P1/P0 = 1/2/4/8，只算 actionable 且 `decision` 不为 `external` 的条目。`unknown` 与 `autofix` 一样压着这条线；判成 `external` 就掉出计数。
- 严重度（写每条时照它判）：**P0** 重复且带 bug 风险，或踩在业务关键路径上；**P1** 职责越界阻碍迭代（UI 里写业务逻辑、逻辑层碰 DOM、跨层依赖）；**P2** 结构改善提升效率（可提取的重复模式、散落的配置、加一个功能要改 3+ 文件）；**P3** 整洁（命名、过时注释、死代码、格式）。
- **大改动单独立条**：≥3 文件、且要改模块间依赖的重构信号，单独立一条，建议转 `/pf-route` 把重构当一个节点进图。池子里只留那条债与它的判据，重构方案不在这里展开。
- **入库前先搜同一条**：新发现进池子之前，先拿同类词搜一遍池子；写库时去重合并——同一条债两份记录，读的人要自己认亲。
