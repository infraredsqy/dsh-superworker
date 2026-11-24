# issue 池（共享口径）

> 供 `sw-issue-scan`、`sw-issue-discuss`、`sw-issue-repair` 共用。命令参数以 `--help` 为准，本页只定义口径。

issue 池存放在项目的 `.superworker/issues/`，是统一的质量债清单。`source` 仅标识来源：`scan`（扫描入池）、`manual`（用户手工记录）、`conduct`（执行会话中发现）。

## 只通过工具访问

操作前先通过 `superworker` 工具查看 `issue --help`（传 `word` 与 `args` 执行，加 `help` 看用法）。

- **所有读写必须走 `issue` 命令**。**严禁直接读取 `.superworker/issues/issues.json`**：文件体量大、浪费上下文，且会绕过工具自身的统计口径。
- **问什么用对动词**：要数量用 `issue status`（出计数、不出行）；要看按模块的分布用 `issue by-module`（每个模块几条、各带多少权重）；挑下一个动手用 `issue top`。`issue list` 是逐行读——默认只列未结的条目，已结的留在池里当去重记忆，`--all` 才把已结的也一起打出来。

## 批量操作

对多条记录执行同一动作时，使用命令自带的批量形式，不要逐条调用：

- **批量入池**：`add --from-file <行文件>`（每行一条，`--auto-id` 可省略 ID）
- **批量更新**：`update --from-file <行文件>`（每行含 `id` 及待改字段；每条 `reason` 不同时使用）
- **批量结单**：`resolve <id…> --reason "<统一验证读数>"`；`reject` / `acknowledge` / `remove` 同理，`mark <id…>` 原生支持批量

批量行文件放在 `.superworker/meta/batch/`，用完即删。任一坏行（未知字段、缺 `id`、非法值）会拒绝整批且不写入任何字节；`update` / `resolve` / `reject` / `acknowledge` / `remove` 中包含不存在的 ID 时同样拒绝整批。`add` 的重复 ID 与 `mark` 的未知 ID 属于正常报告项，逐行提示而不算坏行。`N=1` 时行为与单条完全一致。

## 字段与统计口径

- **状态**：`open` / `acknowledged` / `resolving` 属于 **actionable**；`resolved` / `rejected` 不计入。
- **`decision`**：
  - `autofix`：可自主修复。**凡已拍板且条目内写明解法的一律为 `autofix`**——即使落在其他节点或 cycle 中亦同。
  - `external`：存在需用户拍板的取舍。
  - `unknown`：尚未裁定（入池默认值）。
- **加权和**：由 `issue weight` 计算，仅统计 actionable 且 `decision != external` 的条目，按严重度权值累加。**权值以插件代码 `tools/storage.mjs` 中的 `SEVERITY_WEIGHTS` 为唯一准绳**，不在此处重复抄写。`unknown` 与 `autofix` 同样计入权重；改判 `external` 后移出计数。
- **严重度**：
  - **P0**：存在重复且带 bug 风险，或位于核心业务路径。
  - **P1**：职责越界阻碍迭代（如 UI 含业务逻辑、逻辑层碰 DOM、跨层依赖）。
  - **P2**：结构改进可提升迭代效率（可提取的重复模式、散落配置、单功能需改 3+ 文件）。
  - **P3**：代码整洁度问题（命名、过时注释、死代码、格式）。
- **大规模重构单独立条**：涉及 ≥3 个文件且需改动模块间依赖的重构信号，单独立一条并建议转 `/sw-route` 建节点进图。池中只记债与判据，不展开重构方案。
- **入池前去重**：新条目入池前先用关键词检索池子，相同问题去重合并，避免同一笔债出现多份记录。
